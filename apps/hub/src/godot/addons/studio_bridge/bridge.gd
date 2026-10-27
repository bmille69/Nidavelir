extends Node
## Relais du studio (ADR-73), posé par le hub dans chaque jeu Godot.
##
## Il ne fait RIEN dans une partie normale : il ne s'active que si le hub lance le jeu avec
## « -- --studio-bridge=<port> ». Il écoute alors en local (127.0.0.1) et laisse le testeur jouer :
## touches, actions, clics, toucher, texte, photos de l'écran, état du jeu (nœud du groupe « studio_test »),
## et mesure des performances (« perf », ADR-83).
## « --vitrine=A-0001 » ouvre la scène vitrine res://vitrines/a-0001.tscn, si elle existe.
##
## Ce fichier appartient au hub : ne le modifiez pas, il est remplacé à chaque mise à jour.

const VERSION := 2

var _server: TCPServer
var _peer: StreamPeerTCP
var _buffer := ""
var _busy := false


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	var port := 0
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--studio-bridge="):
			port = int(arg.get_slice("=", 1))
		elif arg.begins_with("--vitrine="):
			_open_vitrine(arg.get_slice("=", 1))
	if port <= 0:
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
