extends SceneTree
## Lanceur des simulations d'équilibrage d'un jeu Godot du studio (ADR-86) :
##   godot --headless --fixed-fps 60 --path . -s res://addons/studio_tests/sim.gd -- --runs=200 [--only=nom] [--seed=1]
## Trouve res://tests/sims/**/sim_*.gd, joue --runs parties par simulation (graines --seed, --seed+1…), et affiche
## pour chacune une ligne « STUDIO_SIM: {…} » avec ce que chaque partie a mesuré.
##
## Ce fichier appartient au hub : ne le modifiez pas, il est remplacé à chaque mise à jour.

const ROOT := "res://tests/sims"


func _initialize() -> void:
	_run.call_deferred()


func _run() -> void:
	var only := ""
	var runs := 100
	var base := 1
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--only="):
			only = arg.get_slice("=", 1)
		elif arg.begins_with("--runs="):
			runs = clampi(int(arg.get_slice("=", 1)), 1, 2000)
		elif arg.begins_with("--seed="):
			base = int(arg.get_slice("=", 1))
	var files := _find(ROOT)
	files.sort()
	if files.is_empty():
		print("Aucune simulation : ajoutez des fichiers %s/sim_*.gd qui « extends StudioSim »." % ROOT)
	for path in files:
		if only != "" and not path.contains(only):
			continue
		var script := load(path) as GDScript
		if script == null or not script.can_instantiate():
			print("STUDIO_SIM: " + JSON.stringify({"name": path, "error": "le script ne se charge pas (erreur de syntaxe ?)"}))
			continue
		var sim = script.new()
		if not sim is StudioSim:
			print("STUDIO_SIM: " + JSON.stringify({"name": path, "error": "doit commencer par « extends StudioSim »"}))
			if sim is Node:
				sim.free()
			continue
		root.add_child(sim)
		var results := []
		var started := Time.get_ticks_msec()
		for i in runs:
			var graine := base + i
			seed(graine)
			sim.rng.seed = graine
			var out = await sim.call("simulate", graine)
			results.append(_clean(out))
			for child in sim.get_children():
				child.queue_free()
			await process_frame
		sim.queue_free()
		await process_frame
		print("STUDIO_SIM: " + JSON.stringify({"name": path, "seed": base, "seconds": (Time.get_ticks_msec() - started) / 1000.0, "runs": results}))
	quit(0)


## Ce qu'une partie rend : nombres, vrai/faux et textes courts seulement.
func _clean(out) -> Dictionary:
	var d := {}
	if typeof(out) != TYPE_DICTIONARY:
		return d
	for k in out:
		var v = out[k]
		match typeof(v):
			TYPE_INT, TYPE_FLOAT, TYPE_BOOL:
				d[str(k)] = v
			_:
				d[str(k)] = str(v).left(60)
	return d


func _find(dir: String) -> Array[String]:
	var out: Array[String] = []
	var d := DirAccess.open(dir)
	if d == null:
		return out
	for f in d.get_files():
		if f.begins_with("sim_") and f.ends_with(".gd"):
			out.append("%s/%s" % [dir, f])
	for sub in d.get_directories():
		out.append_array(_find("%s/%s" % [dir, sub]))
	return out
