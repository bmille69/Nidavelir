extends SceneTree
## Lanceur des tests d'un jeu Godot du studio (ADR-73) :
##   godot --headless --path . -s res://addons/studio_tests/run.gd [-- --only=nom]
## Trouve res://tests/**/test_*.gd, lance chaque « func test_…() », affiche le détail, puis une ligne
## « STUDIO_TESTS: <réussis> réussis, <échoués> échoués » ; sort avec le code 1 au moindre échec.
##
## Ce fichier appartient au hub : ne le modifiez pas, il est remplacé à chaque mise à jour.

const ROOT := "res://tests"


func _initialize() -> void:
	_run.call_deferred()


func _run() -> void:
	var only := ""
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--only="):
			only = arg.get_slice("=", 1)
	var files := _find(ROOT)
	files.sort()
	var passed := 0
	var failed := 0
	if files.is_empty():
		print("Aucun test : ajoutez des fichiers %s/test_*.gd qui « extends StudioTest »." % ROOT)
	for path in files:
		if only != "" and not path.contains(only):
			continue
		var script := load(path) as GDScript
		if script == null or not script.can_instantiate():
			print("✗ %s : le script ne se charge pas (erreur de syntaxe ?)" % path)
			failed += 1
			continue
		var test = script.new()
		if not test is StudioTest:
			print("✗ %s : doit commencer par « extends StudioTest »" % path)
			failed += 1
			if test is Node:
				test.free()
			continue
		root.add_child(test)
		print("%s" % path)
		if test.has_method("before_all"):
			await test.call("before_all")
		for m in test.get_method_list():
			var name: String = m["name"]
			if not name.begins_with("test_"):
				continue
			test._failures.clear()
			test._asserts = 0
			if test.has_method("before_each"):
				await test.call("before_each")
			await test.call(name)
			if test.has_method("after_each"):
				await test.call("after_each")
			# Les scènes ajoutées par le test partent avec lui.
			for child in test.get_children():
				child.queue_free()
			await process_frame
			if test._failures.is_empty():
				passed += 1
				print("  ✓ %s%s" % [name, "" if test._asserts > 0 else " (aucune vérification)"])
			else:
				failed += 1
				print("  ✗ %s : %s" % [name, " | ".join(test._failures)])
		if test.has_method("after_all"):
			await test.call("after_all")
		test.queue_free()
		await process_frame
	print("STUDIO_TESTS: %d réussis, %d échoués" % [passed, failed])
	quit(1 if failed > 0 else 0)


func _find(dir: String) -> Array[String]:
	var out: Array[String] = []
	var d := DirAccess.open(dir)
	if d == null:
		return out
	for f in d.get_files():
		if f.begins_with("test_") and f.ends_with(".gd"):
			out.append("%s/%s" % [dir, f])
	for sub in d.get_directories():
		out.append_array(_find("%s/%s" % [dir, sub]))
	return out
