/**
 * Godot dans le studio (ADR-73), avec le vrai Godot du PC : le socle d'un nouveau jeu, les tests du jeu (réussis, puis
 * un échec et un script qui plante), le lancement hors de l'écran (photo, scène vitrine, fichiers chargés) et une partie
 * jouée par la manette du testeur. Sauté si Godot n'est pas sur ce PC.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { scaffoldGodot } from "../src/godot/scaffold.ts";
import { findGodot } from "../src/godot/toolchain.ts";
import { RealChecker } from "../src/quality/checks.ts";
import { RealPlayDriver } from "../src/quality/playtest.ts";

const godot = findGodot();
const dir = mkdtempSync(join(tmpdir(), "godot-e2e-"));
const shots = process.env.STUDIO_SCREENSHOTS ?? join(process.cwd(), ".data", "screenshots");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Le jeu du test : un bouton qui compte, un carré qui avance avec « avancer », l'état pour le testeur. */
const MAIN = `extends Node2D
var score := 0
var px := 100.0

func _ready() -> void:
	add_to_group("studio_test")
	var b := Button.new()
	b.text = "Compter"
	b.position = Vector2(40, 80)
	b.pressed.connect(func(): score += 1)
	$Interface.add_child(b)

func _process(delta: float) -> void:
	if Input.is_action_pressed("ui_right"):
		px += 300.0 * delta
	queue_redraw()

func _draw() -> void:
	draw_rect(Rect2(px, 300, 60, 60), Color.ORANGE)

func snapshot() -> Dictionary:
	return {"scene": "main", "score": score, "x": roundi(px)}

func reset() -> void:
	score = 0
	px = 100.0
`;

describe.skipIf(!godot)("Godot dans le studio", () => {
  it("socle, tests, lancement, vitrine et partie jouée", async () => {
    const root = join(dir, "jeu");
    mkdirSync(root);
    scaffoldGodot(root, "Essai du studio", godot!.version, { rendu: "gl_compatibility", dimension: "2d", largeur: 1280, hauteur: 720, langage: "gdscript" });
    writeFileSync(join(root, "scripts", "main.gd"), MAIN);
    writeFileSync(
      join(root, "tests", "test_regles.gd"),
      `extends StudioTest\n\nfunc test_le_carre_avance() -> void:\n\tvar main := add_scene("res://scenes/main.tscn")\n\tawait hold_action("ui_right", 0.3)\n\tassert_gt(main.snapshot().x, 100)\n`,
    );
    const checker = new RealChecker({ workDir: join(dir, "data"), godot: () => godot, watchMs: 2500 });

    // Les tests du jeu : le socle et la règle passent.
    const ok = await checker.tests(root);
    expect(ok.status, ok.detail).toBe("pass");
    expect(ok.detail).toMatch(/✓ test_la_scene_principale_demarre[\s\S]*✓ test_le_carre_avance[\s\S]*STUDIO_TESTS: 2 réussis, 0 échoués/);

    // Le jeu se lance hors de l'écran : pas d'erreur, une photo, la scène et ses fichiers.
    mkdirSync(shots, { recursive: true });
    const shot = join(shots, "godot-1-lancement.png");
    const launch = await checker.launch("essai/check", root, shot);
    expect(launch.status, launch.detail).toBe("pass");
    expect(launch.screenshot).toBe(shot);
    expect(launch.loaded).toContain("/scenes/main.tscn");

    // La scène vitrine d'un asset s'ouvre par le relais (--vitrine=A-0001).
    writeFileSync(
      join(root, "vitrines", "a-0001.tscn"),
      `[gd_scene format=3]\n\n[node name="Vitrine" type="Node2D"]\n\n[node name="Nom" type="Label" parent="."]\noffset_left = 500.0\noffset_top = 340.0\ntext = "Vitrine A-0001"\n`,
    );
    const vitrine = await checker.launch("essai/vitrine", root, join(shots, "godot-2-vitrine.png"), "?vitrine=A-0001");
    expect(vitrine.status, vitrine.detail).toBe("pass");
    expect(vitrine.detail).toMatch(/scène res:\/\/vitrines\/a-0001\.tscn/);
    expect(vitrine.loaded).toContain("/vitrines/a-0001.tscn");

    // Le testeur joue : un clic sur le bouton par son texte, l'action maintenue, l'état lu, une photo.
    const driver = new RealPlayDriver({ workDir: join(dir, "data"), godot: () => godot });
    const session = await driver.open("essai/play", root, "pc", "");
    try {
      expect(await session.act([{ do: "click", text: "Compter" }, { do: "click", text: "Compter" }, { do: "press", key: "ui_right", hold_ms: 400 }, { do: "press", key: "Truc" }])).toEqual([
        expect.stringMatching(/étape 4 : touche inconnue « Truc »/),
      ]);
      const snap = await session.snapshot();
      expect(snap.url).toBe("res://scenes/main.tscn");
      expect(snap.text).toMatch(/Essai du studio/);
      expect(snap.controls).toEqual([expect.objectContaining({ label: "Compter", kind: "Button" })]);
      const state = JSON.parse(snap.state!) as { score: number; x: number };
      expect(state.score).toBe(2);
      expect(state.x).toBeGreaterThan(150);
      expect(snap.bridge).toEqual(["snapshot", "reset"]);
      expect(snap.errors).toEqual([]);
      expect(await session.act([{ do: "bridge", method: "reset" }])).toEqual([]);
      expect(JSON.parse((await session.snapshot()).state!)).toMatchObject({ score: 0, x: 100 });
      await session.capture(join(shots, "godot-3-partie.jpg"));
    } finally {
      await session.close();
    }

    // Un test qui échoue et un script qui plante : les vérifications du hub le voient.
    writeFileSync(join(root, "tests", "test_faux.gd"), `extends StudioTest\n\nfunc test_faux() -> void:\n\tassert_eq(1 + 1, 3, "arithmétique")\n`);
    const failed = await checker.tests(root);
    expect(failed.status).toBe("fail");
    expect(failed.detail).toMatch(/✗ test_faux : arithmétique : obtenu 2, attendu 3/);
    rmSync(join(root, "tests", "test_faux.gd"));
    writeFileSync(join(root, "tests", "test_plante.gd"), `extends StudioTest\n\nfunc test_plante() -> void:\n\tvar rien = null\n\trien.appeler()\n\tassert_true(true)\n`);
    const crashed = await checker.tests(root);
    expect(crashed.status).toBe("fail");
    expect(crashed.detail).toMatch(/scripts ont planté|SCRIPT ERROR/);
    rmSync(join(root, "tests", "test_plante.gd"));

    // Un jeu qui écrit une erreur au démarrage : le lancement échoue, avec l'erreur.
    writeFileSync(join(root, "scripts", "main.gd"), MAIN.replace(`add_to_group("studio_test")`, `add_to_group("studio_test")\n\tpush_error("le niveau 1 est introuvable")`));
    const broken = await checker.launch("essai/casse", root);
    expect(broken.status).toBe("fail");
    expect(broken.detail).toMatch(/le niveau 1 est introuvable/);
  }, 240_000);
});
