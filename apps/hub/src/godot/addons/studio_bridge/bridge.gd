extends Node
## Relais du studio (ADR-73), posé par le hub dans chaque jeu Godot.
##
## Il ne fait RIEN dans une partie normale : il ne s'active que si le hub lance le jeu avec
## « -- --studio-bridge=<port> ». Il écoute alors en local (127.0.0.1) et laisse le testeur jouer :
## touches, actions, clics, toucher, texte, photos de l'écran, état du jeu (nœud du groupe « studio_test »),
## et mesure des performances (« perf », ADR-83).
## « --vitrine=A-0001 » ouvre la scène vitrine res://vitrines/a-0001.tscn, si elle existe.
## « --studio-record=<fichier> » enregistre la partie que vous jouez (vos entrées, image par image, et l'état du jeu) ;
## « --studio-replay=<fichier> » la rejoue à l'identique et compare l'état du jeu (ADR-85). « --studio-seed=<n> » fixe
## le hasard du jeu (seed() et set_seed() du nœud « studio_test »).
##
## Ce fichier appartient au hub : ne le modifiez pas, il est remplacé à chaque mise à jour.

const VERSION := 3

var _server: TCPServer
var _peer: StreamPeerTCP
var _buffer := ""
var _busy := false

# Parties enregistrées et rejouées (ADR-85).
var _seed := -1
var _seed_pending := false
var _record: FileAccess
var _record_start := 0
var _record_events := 0
var _replay_events: Array = []
var _replay_snaps: Array = []
var _replay_end := 0
var _replay_start := 0
var _replay_ei := 0
var _replay_si := 0
var _replay_mismatches: Array = []
var _replay_done := false


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	var port := 0
	var record := ""
	var replay := ""
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--studio-bridge="):
			port = int(arg.get_slice("=", 1))
		elif arg.begins_with("--vitrine="):
			_open_vitrine(arg.get_slice("=", 1))
		elif arg.begins_with("--studio-record="):
			record = arg.substr("--studio-record=".length())
		elif arg.begins_with("--studio-replay="):
			replay = arg.substr("--studio-replay=".length())
		elif arg.begins_with("--studio-seed="):
			_seed = int(arg.get_slice("=", 1))
	if replay != "":
		_start_replay(replay)
	elif record != "":
		_start_record(record)
	if _seed >= 0:
		seed(_seed)
		_seed_pending = true
	set_process_input(_record != null)
	if port <= 0:
		if _record == null and _replay_events.is_empty() and _replay_snaps.is_empty() and not _replay_done:
			set_process(false)
		return
	_server = TCPServer.new()
	if _server.listen(port, "127.0.0.1") != OK:
		push_error("studio_bridge : impossible d'écouter le port %d" % port)
		set_process(false)
		return
	print("STUDIO_BRIDGE_READY %d" % port)


func _open_vitrine(id: String) -> void:
	var path := "res://vitrines/%s.tscn" % id.to_lower()
	if ResourceLoader.exists(path):
		get_tree().call_deferred("change_scene_to_file", path)
	else:
		push_warning("studio_bridge : pas de scène vitrine %s" % path)


func _process(_delta: float) -> void:
	if _seed_pending:
		var node := get_tree().get_first_node_in_group("studio_test")
		if node != null:
			_seed_pending = false
			if node.has_method("set_seed"):
				node.call("set_seed", _seed)
	if _record != null:
		_record_tick()
	if not _replay_done and (_replay_end > 0):
		_replay_tick()
	if _server == null:
		return
	if _peer == null:
		if _server.is_connection_available():
			_peer = _server.take_connection()
		return
	_peer.poll()
	if _peer.get_status() != StreamPeerTCP.STATUS_CONNECTED:
		_peer = null
		_buffer = ""
		return
	var available := _peer.get_available_bytes()
	if available > 0:
		_buffer += _peer.get_utf8_string(available)
	if _busy:
		return
	var end := _buffer.find("\n")
	if end < 0:
		return
	var line := _buffer.substr(0, end)
	_buffer = _buffer.substr(end + 1)
	_busy = true
	var request = JSON.parse_string(line)
	var response: Dictionary
	if typeof(request) != TYPE_DICTIONARY:
		response = {"ok": false, "error": "requête illisible"}
	else:
		response = await _handle(request)
		response["id"] = request.get("id", 0)
	if _peer != null:
		_peer.put_data((JSON.stringify(response) + "\n").to_utf8_buffer())
	_busy = false


func _handle(req: Dictionary) -> Dictionary:
	match str(req.get("cmd", "")):
		"ping":
			return {"ok": true, "version": VERSION, "scene": _scene_path()}
		"act":
			var notes := []
			var steps: Array = req.get("steps", [])
			for i in steps.size():
				var note := await _step(steps[i], req.get("touch", false))
				if note != "":
					notes.append("étape %d : %s" % [i + 1, note])
				await get_tree().process_frame
			return {"ok": true, "notes": notes}
		"snapshot":
			return {"ok": true, "snapshot": _snapshot()}
		"capture":
			await RenderingServer.frame_post_draw
			var image := get_viewport().get_texture().get_image()
			var size := DisplayServer.window_get_size()
			if image.get_size() != size and size.x > 0 and size.y > 0:
				image.resize(size.x, size.y)
			var path := str(req.get("path", ""))
			var err := image.save_png(path) if path.to_lower().ends_with(".png") else image.save_jpg(path, 0.7)
			return {"ok": err == OK, "error": "" if err == OK else "photo impossible (%d)" % err}
		"perf":
			return await _perf(clampf(float(req.get("seconds", 3.0)), 0.5, 10.0), str(req.get("scene", "")))
		"quit":
			get_tree().call_deferred("quit")
			return {"ok": true}
	return {"ok": false, "error": "commande inconnue"}


func _scene_path() -> String:
	var scene := get_tree().current_scene
	return scene.scene_file_path if scene else ""


# ── Parties enregistrées, puis rejouées (ADR-85) ─────────────────────────

func _frame() -> int:
	return Engine.get_process_frames()


func _state() -> String:
	var node := get_tree().get_first_node_in_group("studio_test")
	if node == null or not node.has_method("snapshot"):
		return ""
	return JSON.stringify(node.call("snapshot"))


func _start_record(path: String) -> void:
	_record = FileAccess.open(path, FileAccess.WRITE)
	if _record == null:
		push_error("studio_bridge : impossible d'enregistrer dans %s" % path)
		return
	if _seed < 0:
		_seed = randi() % 1000000
	_record_start = _frame()
	var size := DisplayServer.window_get_size()
	_record.store_line(JSON.stringify({"studio_replay": 1, "seed": _seed, "window": [size.x, size.y], "fps": Engine.physics_ticks_per_second, "godot": Engine.get_version_info().string, "at": Time.get_datetime_string_from_system()}))
	_record.flush()


func _input(event: InputEvent) -> void:
	if _record == null:
		return
	var e := _encode(event)
	if e.is_empty():
		return
	_record_events += 1
	_record.store_line(JSON.stringify({"f": _frame() - _record_start, "e": e}))


## L'état du jeu toutes les demi-secondes : c'est ce que la partie rejouée devra retrouver.
func _record_tick() -> void:
	var f := _frame() - _record_start
	if f % 30 == 0:
		var s := _state()
		if s != "":
			_record.store_line(JSON.stringify({"f": f, "s": s}))
		_record.flush()


## Fin de la partie : l'état final, pendant que la scène existe encore (fermeture de la fenêtre), sinon à la sortie.
func _notification(what: int) -> void:
	if what == NOTIFICATION_WM_CLOSE_REQUEST:
		_finish_record()


func _exit_tree() -> void:
	_finish_record()


func _finish_record() -> void:
	if _record == null:
		return
	_record.store_line(JSON.stringify({"f": _frame() - _record_start, "end": true, "s": _state(), "events": _record_events}))
	_record.flush()
	_record.close()
	_record = null


func _start_replay(path: String) -> void:
	var file := FileAccess.open(path, FileAccess.READ)
	if file == null:
		_replay_finish("impossible de lire %s" % path)
		return
	var first = JSON.parse_string(file.get_line())
	if typeof(first) != TYPE_DICTIONARY or not first.has("studio_replay"):
		_replay_finish("ce fichier n'est pas une partie enregistrée")
		return
	if _seed < 0:
		_seed = int(first.get("seed", -1))
	while not file.eof_reached():
		var line := file.get_line()
		if line.strip_edges() == "":
			continue
		var d = JSON.parse_string(line)
		if typeof(d) != TYPE_DICTIONARY:
			continue
		_replay_end = maxi(_replay_end, int(d.get("f", 0)) + 1)
		if d.has("e"):
			_replay_events.append(d)
		elif d.has("s") and str(d["s"]) != "":
			_replay_snaps.append(d)
	_replay_start = _frame()
	_replay_end = maxi(_replay_end, 1)


## Les entrées d'une image sont injectées la frame d'avant : Godot les livre au début de l'image suivante, comme pendant
## l'enregistrement. L'état est comparé au même moment de l'image qu'à l'enregistrement.
func _replay_tick() -> void:
	var f := _frame() - _replay_start
	while _replay_si < _replay_snaps.size() and int(_replay_snaps[_replay_si]["f"]) <= f:
		var want: Dictionary = _replay_snaps[_replay_si]
		_replay_si += 1
		if int(want["f"]) < f:
			continue
		var got := _state()
		if got != str(want["s"]) and _replay_mismatches.size() < 5:
			_replay_mismatches.append({"image": f, "seconde": snappedf(f / 60.0, 0.1), "attendu": str(want["s"]).left(400), "obtenu": got.left(400)})
	while _replay_ei < _replay_events.size() and int(_replay_events[_replay_ei]["f"]) <= f + 1:
		var ev := _decode(_replay_events[_replay_ei]["e"])
		_replay_ei += 1
		if ev != null:
			Input.parse_input_event(ev)
	if f >= _replay_end:
		_replay_finish("")


func _replay_finish(error: String) -> void:
	_replay_done = true
	var out := {"ok": error == "" and _replay_mismatches.is_empty(), "frames": _frame() - _replay_start, "events": _replay_events.size(), "checked": _replay_si, "mismatches": _replay_mismatches}
	if error != "":
		out["error"] = error
	print("STUDIO_REPLAY: " + JSON.stringify(out))
	get_tree().call_deferred("quit")


func _mods(e: InputEventWithModifiers) -> int:
	return int(e.shift_pressed) | int(e.ctrl_pressed) << 1 | int(e.alt_pressed) << 2 | int(e.meta_pressed) << 3


func _set_mods(e: InputEventWithModifiers, m: int) -> void:
	e.shift_pressed = m & 1 != 0
	e.ctrl_pressed = m & 2 != 0
	e.alt_pressed = m & 4 != 0
	e.meta_pressed = m & 8 != 0


func _encode(e: InputEvent) -> Dictionary:
	if e is InputEventKey:
		return {"t": "key", "k": e.keycode, "p": e.physical_keycode, "u": e.unicode, "d": e.pressed, "r": e.echo, "m": _mods(e)}
	if e is InputEventMouseButton:
		return {"t": "mb", "b": e.button_index, "d": e.pressed, "x": e.position.x, "y": e.position.y, "bm": e.button_mask, "dc": e.double_click, "m": _mods(e)}
	if e is InputEventMouseMotion:
		return {"t": "mm", "x": e.position.x, "y": e.position.y, "rx": e.relative.x, "ry": e.relative.y, "bm": e.button_mask, "m": _mods(e)}
	if e is InputEventScreenTouch:
		return {"t": "st", "i": e.index, "d": e.pressed, "x": e.position.x, "y": e.position.y}
	if e is InputEventScreenDrag:
		return {"t": "sd", "i": e.index, "x": e.position.x, "y": e.position.y, "rx": e.relative.x, "ry": e.relative.y}
	if e is InputEventJoypadButton:
		return {"t": "jb", "b": e.button_index, "d": e.pressed, "dv": e.device}
	if e is InputEventJoypadMotion:
		return {"t": "jm", "a": e.axis, "v": e.axis_value, "dv": e.device}
	if e is InputEventAction:
		return {"t": "ac", "a": str(e.action), "d": e.pressed, "v": e.strength}
	return {}


func _decode(d: Dictionary) -> InputEvent:
	match str(d.get("t", "")):
		"key":
			var e := InputEventKey.new()
			e.keycode = int(d["k"])
			e.physical_keycode = int(d["p"])
			e.unicode = int(d["u"])
			e.pressed = bool(d["d"])
			e.echo = bool(d["r"])
			_set_mods(e, int(d.get("m", 0)))
			return e
		"mb":
			var e := InputEventMouseButton.new()
			e.button_index = int(d["b"])
			e.pressed = bool(d["d"])
			e.position = Vector2(float(d["x"]), float(d["y"]))
			e.global_position = e.position
			e.button_mask = int(d["bm"])
			e.double_click = bool(d["dc"])
			_set_mods(e, int(d.get("m", 0)))
			return e
		"mm":
			var e := InputEventMouseMotion.new()
			e.position = Vector2(float(d["x"]), float(d["y"]))
			e.global_position = e.position
			e.relative = Vector2(float(d["rx"]), float(d["ry"]))
			e.button_mask = int(d["bm"])
			_set_mods(e, int(d.get("m", 0)))
			return e
		"st":
			var e := InputEventScreenTouch.new()
			e.index = int(d["i"])
			e.pressed = bool(d["d"])
			e.position = Vector2(float(d["x"]), float(d["y"]))
			return e
		"sd":
			var e := InputEventScreenDrag.new()
			e.index = int(d["i"])
			e.position = Vector2(float(d["x"]), float(d["y"]))
			e.relative = Vector2(float(d["rx"]), float(d["ry"]))
			return e
		"jb":
			var e := InputEventJoypadButton.new()
			e.button_index = int(d["b"])
			e.pressed = bool(d["d"])
			e.device = int(d["dv"])
			return e
		"jm":
			var e := InputEventJoypadMotion.new()
			e.axis = int(d["a"])
			e.axis_value = float(d["v"])
			e.device = int(d["dv"])
			return e
		"ac":
			var e := InputEventAction.new()
			e.action = StringName(str(d["a"]))
			e.pressed = bool(d["d"])
			e.strength = float(d["v"])
			return e
	return null


# ── Performances (ADR-83) ───────────────────────────────────────────────

## Mesure sur quelques secondes (sur `scene` si donnée), synchronisation verticale coupée : la marge réelle du jeu, pas les 60 images de
## l'écran. Rendu tel que le joueur le voit (la fenêtre est hors de l'écran, mais affichée).
func _perf(seconds: float, scene: String) -> Dictionary:
	# La scène de référence du jeu (res://vitrines/perf.tscn), si le hub la demande : la plus chargée.
	if scene != "":
		if not ResourceLoader.exists(scene):
			return {"ok": false, "error": "pas de scène %s" % scene}
		get_tree().change_scene_to_file(scene)
		await get_tree().create_timer(1.0, true, false, true).timeout
	var vsync := DisplayServer.window_get_vsync_mode()
	var max_fps := Engine.max_fps
	DisplayServer.window_set_vsync_mode(DisplayServer.VSYNC_DISABLED)
	Engine.max_fps = 0
	for i in 15:
		await get_tree().process_frame
	var deltas: Array[float] = []
	var draw := 0.0
	var primitives := 0.0
	var objects := 0.0
	var start := Time.get_ticks_usec()
	var last := start
	while Time.get_ticks_usec() - start < int(seconds * 1000000.0):
		await get_tree().process_frame
		var now := Time.get_ticks_usec()
		deltas.append((now - last) / 1000.0)
		last = now
		draw += Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME)
		primitives += Performance.get_monitor(Performance.RENDER_TOTAL_PRIMITIVES_IN_FRAME)
		objects += Performance.get_monitor(Performance.RENDER_TOTAL_OBJECTS_IN_FRAME)
	DisplayServer.window_set_vsync_mode(vsync)
	Engine.max_fps = max_fps
	var n := deltas.size()
	if n == 0:
		return {"ok": false, "error": "aucune image rendue pendant la mesure"}
	var elapsed := (last - start) / 1000000.0
	deltas.sort()
	return {
		"ok": true,
		"perf": {
			"seconds": snappedf(elapsed, 0.01),
			"frames": n,
			"fps": snappedf(n / elapsed, 0.1),
			"frame_ms_avg": snappedf(elapsed * 1000.0 / n, 0.01),
			"frame_ms_p95": snappedf(deltas[int(0.95 * (n - 1))], 0.01),
			"frame_ms_max": snappedf(deltas[n - 1], 0.01),
			"draw_calls": roundi(draw / n),
			"primitives": roundi(primitives / n),
			"objects": roundi(objects / n),
			"video_mem_mb": snappedf(Performance.get_monitor(Performance.RENDER_VIDEO_MEM_USED) / 1048576.0, 0.1),
			"static_mem_mb": snappedf(Performance.get_monitor(Performance.MEMORY_STATIC) / 1048576.0, 0.1),
			"nodes": int(Performance.get_monitor(Performance.OBJECT_NODE_COUNT)),
			"scene": _scene_path(),
		},
	}


# ── Les actions du testeur ──────────────────────────────────────────────

const KEY_NAMES := {
	"ArrowLeft": "Left", "ArrowRight": "Right", "ArrowUp": "Up", "ArrowDown": "Down",
	" ": "Space", "Spacebar": "Space", "Return": "Enter", "Esc": "Escape", "Control": "Ctrl",
}


func _step(step: Dictionary, touch: bool) -> String:
	match str(step.get("do", "")):
		"press":
			return await _press(str(step.get("key", "")), int(step.get("hold_ms", 0)))
		"click":
			var at = _target(step)
			if at is String:
				return at
			await _click(at, touch)
			return ""
		"type":
			for c in str(step.get("text", "")):
				var ev := InputEventKey.new()
				ev.unicode = c.unicode_at(0)
				ev.pressed = true
				Input.parse_input_event(ev)
				var up: InputEventKey = ev.duplicate()
				up.pressed = false
				Input.parse_input_event(up)
				await get_tree().process_frame
			return ""
		"wait":
			await get_tree().create_timer(clampf(float(step.get("ms", 0)) / 1000.0, 0.0, 5.0), true, false, true).timeout
			return ""
		"bridge":
			var node := get_tree().get_first_node_in_group("studio_test")
			var method := str(step.get("method", ""))
			if node == null or not node.has_method(method):
				return "le jeu n'a pas de nœud « studio_test » avec %s()" % method
			if step.has("value"):
				node.call(method, step["value"])
			else:
				node.call(method)
			return ""
	return "action inconnue"


## Une touche du clavier (« ArrowLeft », « Space », « a ») ou une action du projet (« ui_accept », « sauter »).
func _press(key: String, hold_ms: int) -> String:
	var hold := clampf(hold_ms / 1000.0, 0.05, 5.0)
	if InputMap.has_action(key):
		Input.action_press(key)
		var ev := InputEventAction.new()
		ev.action = key
		ev.pressed = true
		Input.parse_input_event(ev)
		await get_tree().create_timer(hold, true, false, true).timeout
		Input.action_release(key)
		var up := InputEventAction.new()
		up.action = key
		up.pressed = false
		Input.parse_input_event(up)
		return ""
	var code := OS.find_keycode_from_string(KEY_NAMES.get(key, key))
	if code == KEY_NONE:
		return "touche inconnue « %s » (essaie une action du projet : %s)" % [key, ", ".join(_actions())]
	var ev := InputEventKey.new()
	ev.keycode = code
	ev.physical_keycode = code
	ev.pressed = true
	if key.length() == 1:
		ev.unicode = key.unicode_at(0)
	Input.parse_input_event(ev)
	await get_tree().create_timer(hold, true, false, true).timeout
	var up: InputEventKey = ev.duplicate()
	up.pressed = false
	Input.parse_input_event(up)
	return ""


func _actions() -> Array:
	return InputMap.get_actions().filter(func(a): return not str(a).begins_with("ui_") or str(a) in ["ui_accept", "ui_cancel"]).slice(0, 20)


## Où cliquer : coordonnées de la photo, ou un bouton par son texte.
func _target(step: Dictionary):
	if step.has("text"):
		var wanted := str(step["text"]).to_lower()
		for c in _controls():
			if c.label.to_lower().contains(wanted):
				return Vector2(c.x, c.y)
		return "aucun bouton visible ne contient « %s »" % step["text"]
	if step.has("x") and step.has("y"):
		return Vector2(float(step["x"]), float(step["y"]))
	return "clic sans cible (x, y ou text)"


func _click(at: Vector2, touch: bool) -> void:
	if touch:
		var t := InputEventScreenTouch.new()
		t.position = at
		t.pressed = true
		Input.parse_input_event(t)
		await get_tree().create_timer(0.08, true, false, true).timeout
		var tu: InputEventScreenTouch = t.duplicate()
		tu.pressed = false
		Input.parse_input_event(tu)
		return
	var move := InputEventMouseMotion.new()
	move.position = at
	move.global_position = at
	Input.parse_input_event(move)
	await get_tree().process_frame
	var down := InputEventMouseButton.new()
	down.position = at
	down.global_position = at
	down.button_index = MOUSE_BUTTON_LEFT
	down.button_mask = MOUSE_BUTTON_MASK_LEFT
	down.pressed = true
	Input.parse_input_event(down)
	await get_tree().create_timer(0.06, true, false, true).timeout
	var up: InputEventMouseButton = down.duplicate()
	up.pressed = false
	up.button_mask = 0
	Input.parse_input_event(up)


# ── Ce que voit le joueur ───────────────────────────────────────────────

func _snapshot() -> Dictionary:
	var texts := []
	for node in _all(get_tree().root):
		if node is CanvasItem and not node.is_visible_in_tree():
			continue
		if node is Label or node is RichTextLabel or node is Button or node is LineEdit:
			var t := str(node.get_parsed_text() if node is RichTextLabel else node.text).strip_edges()
			if t != "":
				texts.append(t.replace("\n", " "))
	var state := ""
	var test_node := get_tree().get_first_node_in_group("studio_test")
	if test_node and test_node.has_method("snapshot"):
		state = JSON.stringify(test_node.call("snapshot")).left(4000)
	var bridge := []
	if test_node:
		for m in ["snapshot", "reset", "set_seed", "step"]:
			if test_node.has_method(m):
				bridge.append(m)
	var size := DisplayServer.window_get_size()
	return {
		"scene": _scene_path(),
		"window": [size.x, size.y],
		"text": " · ".join(texts).left(1500),
		"controls": _controls(),
		"state": state,
		"bridge": bridge,
		"actions": _actions(),
		"resources": _resources(),
	}


func _controls() -> Array:
	var out := []
	var to_window := get_viewport().get_final_transform()
	for node in _all(get_tree().root):
		if not (node is BaseButton or node is LineEdit) or not node.is_visible_in_tree():
			continue
		var c := node as Control
		var center := to_window * (c.get_global_transform_with_canvas() * (c.size / 2.0))
		var label := ""
		if "text" in c:
			label = str(c.text)
		if label == "":
			label = c.tooltip_text if c.tooltip_text != "" else str(c.name)
		out.append({"label": label.strip_edges().left(40), "kind": c.get_class(), "x": roundi(center.x), "y": roundi(center.y)})
		if out.size() >= 30:
			break
	return out


## Les fichiers que la scène affichée utilise (scènes, modèles, images, sons), pour le bilan des visuels (ADR-71).
func _resources() -> Array:
	var seen := {}
	for node in _all(get_tree().root):
		if node.scene_file_path != "":
			seen[node.scene_file_path] = true
		for prop in ["mesh", "texture", "stream", "sprite_frames", "material_override"]:
			if prop in node:
				var res = node.get(prop)
				if res is Resource and res.resource_path != "":
					seen[res.resource_path.get_slice("::", 0)] = true
	return seen.keys().slice(0, 200)


func _all(root: Node) -> Array:
	var out := [root]
	var i := 0
	while i < out.size() and out.size() < 5000:
		out.append_array(out[i].get_children())
		i += 1
	return out
