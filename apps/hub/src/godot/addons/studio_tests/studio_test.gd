class_name StudioTest
extends Node
## Base des tests d'un jeu Godot du studio (ADR-73). Un test : un fichier res://tests/**/test_*.gd qui
## « extends StudioTest », et des fonctions « func test_…() ». Lancés par le hub :
##   godot --headless --path . -s res://addons/studio_tests/run.gd
## Le test est ajouté à l'arbre : add_scene() instancie une vraie scène, wait_frames() laisse le jeu tourner.
##
## Ce fichier appartient au hub : ne le modifiez pas, il est remplacé à chaque mise à jour.

var _failures: Array[String] = []
var _asserts := 0


## Appelées par le lanceur, si le test les définit : before_all(), before_each(), after_each(), after_all().


func assert_true(value: bool, message := "") -> void:
	_check(value, message, "attendu vrai")


func assert_false(value: bool, message := "") -> void:
	_check(not value, message, "attendu faux")


func assert_eq(got, expected, message := "") -> void:
	_check(typeof(got) == typeof(expected) and got == expected or (_numeric(got) and _numeric(expected) and got == expected), message, "obtenu %s, attendu %s" % [_show(got), _show(expected)])


func assert_ne(got, unexpected, message := "") -> void:
	_check(got != unexpected, message, "obtenu %s, qui ne devait pas l'être" % _show(got))


func assert_almost_eq(got: float, expected: float, tolerance := 0.001, message := "") -> void:
	_check(absf(got - expected) <= tolerance, message, "obtenu %s, attendu %s ± %s" % [got, expected, tolerance])


func assert_gt(got, than, message := "") -> void:
	_check(got > than, message, "obtenu %s, attendu plus que %s" % [_show(got), _show(than)])


func assert_lt(got, than, message := "") -> void:
	_check(got < than, message, "obtenu %s, attendu moins que %s" % [_show(got), _show(than)])


func assert_null(value, message := "") -> void:
	_check(value == null, message, "obtenu %s, attendu null" % _show(value))


func assert_not_null(value, message := "") -> void:
	_check(value != null, message, "attendu non null")


func assert_has(container, value, message := "") -> void:
	_check(container.has(value), message, "%s ne contient pas %s" % [_show(container), _show(value)])


func fail(message: String) -> void:
	_check(false, message, "échec")


## Instancie une scène et l'ajoute à l'arbre (retirée à la fin du test).
func add_scene(path: String) -> Node:
	var packed := load(path) as PackedScene
	if packed == null:
		fail("scène introuvable : %s" % path)
		return null
	var node := packed.instantiate()
	add_child(node)
	return node


## Laisse tourner le jeu : quelques images, ou quelques secondes.
func wait_frames(count := 1) -> void:
	for i in count:
		await get_tree().process_frame


func wait_seconds(seconds: float) -> void:
	await get_tree().create_timer(seconds).timeout


## Maintient une action du projet (« ui_right », « sauter ») pendant quelques secondes.
func hold_action(action: String, seconds := 0.2) -> void:
	Input.action_press(action)
	await wait_seconds(seconds)
	Input.action_release(action)


func _check(ok: bool, message: String, detail: String) -> void:
	_asserts += 1
	if not ok:
		_failures.append("%s%s" % ["%s : " % message if message != "" else "", detail])


func _numeric(v) -> bool:
	return typeof(v) == TYPE_INT or typeof(v) == TYPE_FLOAT


func _show(v) -> String:
	return ('"%s"' % v) if typeof(v) == TYPE_STRING else str(v)
