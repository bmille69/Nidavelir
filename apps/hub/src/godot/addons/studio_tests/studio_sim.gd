class_name StudioSim
extends Node
## Base des simulations d'équilibrage d'un jeu Godot du studio (ADR-86). Une simulation : un fichier
## res://tests/sims/**/sim_*.gd qui « extends StudioSim » et définit « func simulate(graine: int) -> Dictionary ».
## Elle joue une partie entière sans écran, avec une stratégie simple, et rend ce qu'elle mesure :
##   return {"vague_atteinte": 7, "victoire": false, "or_final": 340, "cause": "boss vague 7"}
## Nombres, vrai/faux et textes courts. Le hub la lance des centaines de fois, une graine par partie :
##   godot --headless --fixed-fps 60 --path . -s res://addons/studio_tests/sim.gd -- --runs=200
## et montre les distributions (moyenne, 10e et 90e centiles, taux), comparées au passage précédent.
##
## Le hasard du jeu suit la graine (seed() global et « rng » ci-dessous). add_scene() instancie une vraie scène ;
## wait_frames() la laisse tourner (avec --fixed-fps, une image = 1/60 s de jeu, aussi vite que possible).
## Préférez appeler directement la logique du jeu (vagues, économie, dégâts) : 1 000 parties en quelques secondes.
##
## Ce fichier appartient au hub : ne le modifiez pas, il est remplacé à chaque mise à jour.

## Le hasard de la partie en cours, déjà semé avec sa graine.
var rng := RandomNumberGenerator.new()


## À redéfinir : une partie complète, et ce qu'elle mesure.
func simulate(_graine: int) -> Dictionary:
	return {}


func add_scene(path: String) -> Node:
	var scene := load(path) as PackedScene
	if scene == null:
		push_error("StudioSim : scène introuvable %s" % path)
		return null
	var node := scene.instantiate()
	add_child(node)
	return node


func wait_frames(n: int) -> void:
	for i in n:
		await get_tree().process_frame
