import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { GODOT_IMPORT, GODOT_TESTS, installStudioAddons } from "./toolchain.ts";

/**
 * Le socle d'un nouveau jeu Godot (ADR-73), posé par « Créer le projet » avant le premier chantier : un projet qui
 * s'ouvre, se lance et se teste, avec les outils du studio. Le premier chantier construit le jeu dessus, au lieu de
 * passer son temps à installer.
 */

export type GodotSetup = {
  /** Forward+ (PC, 3D soignée), Mobile, ou Compatibility (machines modestes, 2D simple, web). */
  rendu: "forward_plus" | "mobile" | "gl_compatibility";
  dimension: "2d" | "3d";
  largeur: number;
  hauteur: number;
  langage: "gdscript" | "csharp";
};

export const DEFAULT_SETUP: GodotSetup = { rendu: "forward_plus", dimension: "3d", largeur: 1280, hauteur: 720, langage: "gdscript" };

const FEATURE: Record<GodotSetup["rendu"], string> = { forward_plus: "Forward Plus", mobile: "Mobile", gl_compatibility: "GL Compatibility" };

/** « 4.6.2 » → « 4.6 » : la version que project.godot déclare. */
const minor = (version: string) => /^\d+\.\d+/.exec(version)?.[0] ?? "4.6";

export function projectGodot(name: string, version: string, s: GodotSetup): string {
  return `; Fichier de configuration du moteur, posé par le hub du studio (ADR-73).
; Modifiez-le depuis l'éditeur Godot (Projet > Paramètres du projet) plutôt qu'à la main.

config_version=5

[application]

config/name=${JSON.stringify(name)}
run/main_scene="res://scenes/main.tscn"
config/features=PackedStringArray("${minor(version)}", "${FEATURE[s.rendu]}")

[autoload]

StudioBridge="*res://addons/studio_bridge/bridge.gd"

[display]

window/size/viewport_width=${s.largeur}
window/size/viewport_height=${s.hauteur}
window/stretch/mode="canvas_items"
window/stretch/aspect="expand"

[rendering]

renderer/rendering_method="${s.rendu}"
renderer/rendering_method.mobile="${s.rendu === "forward_plus" ? "mobile" : s.rendu}"
`;
}

const MAIN_2D = `extends Node2D
## Scène de départ, posée par le hub : le premier chantier la remplace par le vrai jeu.

func _ready() -> void:
	# Le testeur du studio lit l'état du jeu par ce nœud (snapshot) : gardez ce groupe sur la scène principale.
	add_to_group("studio_test")


func snapshot() -> Dictionary:
	return {"scene": "main"}
`;

const MAIN_3D = `extends Node3D
## Scène de départ, posée par le hub : le premier chantier la remplace par le vrai jeu.

func _ready() -> void:
	# Le testeur du studio lit l'état du jeu par ce nœud (snapshot) : gardez ce groupe sur la scène principale.
	add_to_group("studio_test")


func snapshot() -> Dictionary:
	return {"scene": "main"}
`;

function mainScene(name: string, s: GodotSetup): string {
  const root = s.dimension === "2d" ? "Node2D" : "Node3D";
  const world =
    s.dimension === "3d"
      ? `
[node name="Camera3D" type="Camera3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 0.939693, 0.34202, 0, -0.34202, 0.939693, 0, 3, 6)

[node name="Soleil" type="DirectionalLight3D" parent="."]
transform = Transform3D(1, 0, 0, 0, 0.5, 0.866025, 0, -0.866025, 0.5, 0, 6, 0)
shadow_enabled = true

[node name="Sol" type="CSGBox3D" parent="."]
size = Vector3(20, 0.2, 20)
`
      : "";
  return `[gd_scene load_steps=2 format=3]

[ext_resource type="Script" path="res://scripts/main.gd" id="1_main"]

[node name="Main" type="${root}"]
script = ExtResource("1_main")
${world}
[node name="Interface" type="CanvasLayer" parent="."]

[node name="Titre" type="Label" parent="Interface"]
offset_left = 24.0
offset_top = 20.0
offset_right = 600.0
offset_bottom = 60.0
text = ${JSON.stringify(name)}
`;
}

const FIRST_TEST = `extends StudioTest
## Premier test, posé par le hub : la scène principale se charge et répond au testeur.

func test_la_scene_principale_demarre() -> void:
	var main := add_scene("res://scenes/main.tscn")
	await wait_frames(2)
	assert_not_null(main, "la scène principale se charge")
	assert_eq(main.snapshot().get("scene"), "main")
`;

const GITIGNORE = `# Cache d'import de Godot : propre à chaque copie, jamais commité (le hub le recopie dans chaque chantier).
.godot/
# Exports et fichiers temporaires.
/export/
*.tmp
# C# (si le projet en utilise).
.mono/
/bin/
/obj/
`;

/** Fins de ligne uniformes : Godot et Git sous Windows ne se battent plus sur les .tscn et les .gd. */
const GITATTRIBUTES = `* text=auto eol=lf
*.png binary
*.jpg binary
*.webp binary
*.glb binary
*.ogg binary
*.wav binary
*.mp3 binary
*.ttf binary
*.otf binary
`;

const VITRINES = `# Scènes vitrines

Une scène par visuel intégré : \`a-0001.tscn\` pour l'asset A-0001 du Directeur artistique.
Elle montre seulement cet asset, sans menu : caméra, lumière et sol du jeu, à taille réelle à côté du joueur.
Le hub l'ouvre en lançant le jeu avec \`--vitrine=A-0001\` (relais du studio) pour photographier chaque visuel.
`;

/** La section du CLAUDE.md que le hub ajoute : ce que tout agent doit savoir du jeu Godot dans le studio. */
export function claudeMdGodot(version: string, s: GodotSetup): string {
  return `
## Godot dans le studio (section posée par le hub)

- Moteur : **Godot ${version}** exactement (celui du PC). Rendu : ${FEATURE[s.rendu]}. Jeu ${s.dimension === "2d" ? "2D" : "3D"}, fenêtre de base ${s.largeur}×${s.hauteur}.
- Langage : ${s.langage === "csharp" ? "C# (.NET)" : "GDScript typé (\`var vie: int = 3\`, fonctions avec types de retour)"}.
- Dossiers : \`scenes/\` (scènes .tscn), \`scripts/\`, \`assets/\` (modèles, images, sons), \`data/\` (réglages du jeu en Resources .tres), \`tests/\`, \`vitrines/\`.
- Commandes (toujours sans fenêtre) :
  - \`${GODOT_IMPORT}\` : importe le projet, montre les erreurs de scènes et de scripts ;
  - \`${GODOT_TESTS}\` : lance les tests ; \`-- --only=<nom>\` pour un seul fichier.
- Tests : \`tests/**/test_*.gd\`, qui commencent par \`extends StudioTest\`, avec des fonctions \`func test_…()\`. Outils : assert_eq, assert_true, assert_almost_eq, add_scene("res://…tscn"), \`await wait_frames(n)\`, \`await hold_action("sauter", 0.3)\`. Toute règle du jeu a son test.
- Commandes du joueur : toujours des actions de l'Input Map (Projet > Paramètres > Contrôles : « sauter », « tirer »…), jamais une touche en dur ; clavier et manette.
- Le testeur du studio joue au vrai jeu par le relais \`addons/studio_bridge\` : il lit l'état par le nœud du groupe \`studio_test\` (méthode \`snapshot()\` qui rend un dictionnaire : score, vies, niveau…). Gardez ce nœud à jour quand le jeu grandit.
- Scènes vitrines : \`vitrines/a-0001.tscn\` pour chaque visuel intégré (voir vitrines/README.md).
- Équilibrage : \`tests/sims/sim_*.gd\` (« extends StudioSim », \`func simulate(graine: int) -> Dictionary\`) joue une partie entière sans écran et rend ce qu'elle mesure ; l'équilibreur du hub en joue des centaines. À écrire dès que le jeu a des règles chiffrées (vagues, économie, dégâts).
- Budget de performance : le hub mesure le jeu avant chaque fusion et refuse un chantier qui le ralentit nettement. \`vitrines/perf.tscn\` est la scène qu'il mesure : la scène de jeu la plus chargée, qui se lance seule. À créer dès qu'il y a une partie jouable, et à garder à jour.
- \`addons/studio_bridge\` et \`addons/studio_tests\` appartiennent au hub : ne les modifiez jamais. \`.godot/\` n'est jamais commité.
`;
}

/**
 * Pose le socle dans `root` (déjà un dépôt Git, CLAUDE.md éventuellement écrit). Ne remplace aucun fichier existant,
 * sauf les outils du studio. Rend les chemins à commiter.
 */
export function scaffoldGodot(root: string, name: string, version: string, setup: GodotSetup = DEFAULT_SETUP): string[] {
  const files: Record<string, string> = {
    "project.godot": projectGodot(name, version, setup),
    "scenes/main.tscn": mainScene(name, setup),
    "scripts/main.gd": setup.dimension === "2d" ? MAIN_2D : MAIN_3D,
    "tests/test_demarrage.gd": FIRST_TEST,
    "vitrines/README.md": VITRINES,
    ".gitignore": GITIGNORE,
    ".gitattributes": GITATTRIBUTES,
  };
  const written: string[] = [];
  for (const [rel, text] of Object.entries(files)) {
    const file = join(root, rel);
    if (existsSync(file)) continue;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text, "utf8");
    written.push(rel);
  }
  for (const dir of ["assets", "data"]) {
    mkdirSync(join(root, dir), { recursive: true });
    if (!existsSync(join(root, dir, ".gitkeep"))) {
      writeFileSync(join(root, dir, ".gitkeep"), "");
      written.push(`${dir}/.gitkeep`);
    }
  }
  installStudioAddons(root);
  return [...written, "addons"];
}
