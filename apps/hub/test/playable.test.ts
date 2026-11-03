import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyRepairs, planNatives, planRepairs, scriptBases } from "../src/reverse/rebuild.ts";
import { launchMarkdown, missingFromLog, pickEditor, requirements, verifyProject, type Exec } from "../src/reverse/playable.ts";
import { cleanupSandboxes, sandbox } from "./helpers.ts";

afterEach(() => cleanupSandboxes());

const GODOT = { exe: "C:/Godot/Godot_v4.5.1-stable_mono_win64.exe", version: "4.5.1", mono: true };

/** Un projet Godot démonté : `project.godot`, une scène et le script qu'elle utilise. */
function project(dir: string, opts: { mainScene?: string; csharp?: boolean } = {}): string {
  writeFileSync(
    join(dir, "project.godot"),
    `config_version=5\n\n[application]\n\nconfig/name="Slay the Spire 2"\nrun/main_scene="${opts.mainScene ?? "res://scenes/Game.tscn"}"\n${opts.csharp === false ? "" : `\n[dotnet]\n\nproject/assembly_name="sts2"\n`}`,
  );
  writeFileSync(join(dir, "sts2.csproj"), `<Project Sdk="Godot.NET.Sdk/4.5.1"></Project>`);
  mkdirSync(join(dir, "scenes"), { recursive: true });
  writeFileSync(join(dir, "scenes", "Game.tscn"), `[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://src/NSaveAndQuitButton.cs" id="1_ab"]\n\n[node name="Game" type="Control"]\n\nscript = ExtResource("1_ab")\n`);
  return dir;
}

/** Le log d'un lancement Godot : une scène, puis un script C# vide dont la classe est introuvable. */
const LOG_MISSING_CS = [
  "Godot Engine v4.5.1.stable.mono.official",
  "ERROR: Cannot instantiate C# script because the associated class could not be found. Script: 'res://src/NSaveAndQuitButton.cs'",
  "   at: (modules/mono/csharp_script.cpp:2187)",
].join("\n");

describe("requirements", () => {
  it("lit la version, le C#, la scène principale et l'assemblage", () => {
    const dir = project(sandbox().dir);
    const req = requirements(dir);
    expect(req.version).toBe("4.5.1");
    expect(req.mono).toBe(true);
    expect(req.assembly).toBe("sts2");
    expect(req.mainScene).toBe("scenes/Game.tscn");
    expect(req.csproj).toContain("sts2.csproj");
  });

  it("ne réclame pas Mono pour un projet GDScript", () => {
    const dir = project(sandbox().dir, { csharp: false });
    expect(requirements(dir).mono).toBe(false);
  });

  it("supporte un projet sans project.godot (tout est inconnu)", () => {
    const dir = sandbox().dir;
    expect(requirements(dir)).toEqual({ version: null, mono: false, assembly: null, mainScene: null, csproj: null });
  });
});

describe("pickEditor", () => {
  it("choisit la version exacte, en .NET si le jeu est en C#", () => {
    const pick = pickEditor({ version: "4.5.1", mono: true, assembly: null, mainScene: null, csproj: null }, [
      { exe: "a", version: "4.5.1", mono: false },
      GODOT,
    ]);
    expect(pick.editor).toBe(GODOT);
  });

  it("refuse la version standard quand le jeu a du C#", () => {
    const pick = pickEditor({ version: "4.5.1", mono: true, assembly: null, mainScene: null, csproj: null }, [{ exe: "a", version: "4.5.1", mono: false }]);
    expect(pick.editor).toBeNull();
    expect(pick.reason).toContain("Mono");
  });

  it("dit ce qui manque quand aucune version n'est installée", () => {
    const pick = pickEditor({ version: "4.5.1", mono: false, assembly: null, mainScene: null, csproj: null }, []);
    expect(pick.editor).toBeNull();
    expect(pick.reason).toBe("Il manque Godot 4.5.1.");
  });
});

describe("missingFromLog", () => {
  it("reconnaît la classe C# introuvable quand le fichier est vide", () => {
    const dir = project(sandbox().dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "NSaveAndQuitButton.cs"), "");
    expect(missingFromLog(LOG_MISSING_CS, dir)).toEqual([{ kind: "script", path: "src/NSaveAndQuitButton.cs", detail: expect.stringContaining("Cannot instantiate") }]);
  });

  it("ne signale pas un fichier qui existe et contient du code", () => {
    const dir = project(sandbox().dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "NSaveAndQuitButton.cs"), "public partial class NSaveAndQuitButton : Button { }");
    expect(missingFromLog(LOG_MISSING_CS, dir)).toEqual([]);
  });

  it("reconnaît « No loader found » et les références mortes des scènes", () => {
    const dir = project(sandbox().dir);
    const log = [
      "ERROR: No loader found for resource: res://src/Core/NGame.cs (expected type: Script)",
      "ERROR: res://scenes/game.tscn - Parse Error: [ext_resource] referenced non-existent resource at: res://art/logo.png",
    ].join("\n");
    expect(missingFromLog(log, dir).map((m) => `${m.kind}:${m.path}`)).toEqual(["script:src/Core/NGame.cs", "resource:art/logo.png"]);
  });
});

describe("planRepairs", () => {
  it("donne au script recréé le parent du nœud qui l'utilise", () => {
    const dir = project(sandbox().dir);
    const planned = planRepairs(dir, [{ kind: "script", path: "src/NSaveAndQuitButton.cs", detail: "" }]);
    expect(planned).toHaveLength(1);
    const body = String(planned[0]!.body);
    expect(body).toContain("public partial class NSaveAndQuitButton : Control");
    expect(body).toContain("using Godot;");
    expect(planned[0]!.note).toContain("scenes/Game.tscn");
  });

  it("recrée une scène vide, une image d'un pixel et un son silencieux", () => {
    const dir = sandbox().dir;
    const planned = planRepairs(dir, [
      { kind: "scene", path: "scenes/Game.tscn", detail: "" },
      { kind: "resource", path: "art/logo.png", detail: "" },
      { kind: "resource", path: "sfx/hit.ogg", detail: "" },
      { kind: "resource", path: "data/cards.tres", detail: "" },
    ]);
    const at = (p: string) => planned.find((x) => x.file === p)!;
    expect(String(at("scenes/Game.tscn").body)).toContain('[node name="Game" type="Node"]');
    expect(Buffer.isBuffer(at("art/logo.png").body)).toBe(true);
    expect((at("art/logo.png").body as Buffer).subarray(1, 4).toString()).toBe("PNG");
    expect((at("sfx/hit.ogg").body as Buffer).subarray(0, 4).toString()).toBe("RIFF");
    expect(String(at("data/cards.tres").body)).toContain('[gd_resource type="Resource"');
  });

  it("ignore ce qu'on ne sait pas inventer (police, shader compilé)", () => {
    const dir = sandbox().dir;
    expect(planRepairs(dir, [{ kind: "resource", path: "fonts/x.ttf", detail: "" }])).toEqual([]);
  });

  it("recopie une bibliothèque native depuis le jeu installé au lieu de l'inventer", () => {
    const root = sandbox().dir;
    const dir = join(root, "jeu");
    const game = join(root, "install");
    mkdirSync(join(dir, "addons", "fmod"), { recursive: true });
    mkdirSync(join(game, "data_sts2_windows_x86_64"), { recursive: true });
    writeFileSync(join(dir, "addons", "fmod", "fmod.gdextension"), `[libraries]\nwindows.x86_64 = "res://addons/fmod/libGodotFmod.windows.x86_64.dll"\n`);
    writeFileSync(join(game, "data_sts2_windows_x86_64", "libGodotFmod.windows.x86_64.dll"), "MANIFESTE");
    const planned = planNatives(dir, game);
    expect(planned.map((p) => p.file)).toEqual(["addons/fmod/libGodotFmod.windows.x86_64.dll"]);
    applyRepairs(dir, planned);
    expect(readFileSync(join(dir, "addons", "fmod", "libGodotFmod.windows.x86_64.dll"), "utf8")).toBe("MANIFESTE");
  });

  it("n'écrase jamais un fichier déjà présent et non vide", () => {
    const dir = project(sandbox().dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    const real = "public partial class NSaveAndQuitButton : Button { void Stub() { /* vrai code */ } }";
    writeFileSync(join(dir, "src", "NSaveAndQuitButton.cs"), real);
    const written = applyRepairs(dir, planRepairs(dir, [{ kind: "script", path: "src/NSaveAndQuitButton.cs", detail: "" }]));
    expect(written).toEqual([]);
    expect(readFileSync(join(dir, "src", "NSaveAndQuitButton.cs"), "utf8")).toBe(real);
  });

  it("lit le type du nœud qui porte chaque script", () => {
    const dir = project(sandbox().dir);
    expect(scriptBases(dir).get("src/nsaveandquitbutton.cs")).toEqual({ type: "Control", node: "Game", scene: "scenes/Game.tscn" });
  });
});

/** Un Godot simulé : le premier lancement réclame le script vide, le deuxième tourne proprement. */
function fakeGodot(dir: string, opts: { importErrors?: boolean } = {}) {
  const calls: string[] = [];
  let runs = 0;
  const exec: Exec = async (exe, args) => {
    calls.push([exe, ...args].join(" "));
    if (args.includes("--import")) return { code: 0, log: opts.importErrors ? "ERROR: import raté" : "", timedOut: false };
    if (exe === "dotnet") return { code: 0, log: "Build succeeded.", timedOut: false };
    runs++;
    if (!existsSync(join(dir, "src", "NSaveAndQuitButton.cs"))) return { code: 0, log: LOG_MISSING_CS, timedOut: false };
    return { code: 0, log: "Godot Engine v4.5.1\n", timedOut: false };
  };
  return { exec, calls, runs: () => runs };
}

describe("verifyProject", () => {
  it("recrée le script manquant puis déclare le jeu jouable", async () => {
    const dir = project(sandbox().dir);
    const { exec, runs } = fakeGodot(dir);
    const report = await verifyProject({ dir, editor: GODOT, exec, now: () => new Date("2026-10-30T10:00:00Z") });

    expect(report.verdict).toBe("playable");
    expect(report.rounds).toHaveLength(2);
    expect(report.repairs.map((r) => r.file)).toEqual(["src/NSaveAndQuitButton.cs"]);
    expect(report.editor?.version).toBe("4.5.1");
    expect(report.at).toBe("2026-10-30T10:00:00.000Z");
    expect(runs()).toBe(2);
    // Le script recréé est bien sur le disque, avec le parent de la scène.
    expect(readFileSync(join(dir, "src", "NSaveAndQuitButton.cs"), "utf8")).toContain("public partial class NSaveAndQuitButton : Control");
  });

  it("compile le C# avant de lancer", async () => {
    const dir = project(sandbox().dir);
    const { exec, calls } = fakeGodot(dir);
    await verifyProject({ dir, editor: GODOT, exec });
    expect(calls.some((c) => c.startsWith("dotnet build") && c.includes("sts2.csproj"))).toBe(true);
  });

  it("ne ment pas quand il n'y a aucune scène principale : « partiel »", async () => {
    const root = sandbox().dir;
    const dir = join(root, "jeu");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "project.godot"), `config_version=5\n\n[application]\n\nconfig/name="Vide"\n`);
    const { exec } = fakeGodot(dir);
    const report = await verifyProject({ dir, editor: { exe: "C:/godot.exe", version: "4.5.1", mono: false }, exec });
    expect(report.verdict).toBe("partiel");
    expect(report.reason).toContain("scène principale");
  });

  it("s'arrête après trois tours et dit ce qui bloque encore", async () => {
    const dir = project(sandbox().dir);
    const exec: Exec = async (_exe, args) => {
      if (args.includes("--import")) return { code: 0, log: "", timedOut: false };
      if (args.includes("--quit-after")) return { code: 0, log: "ERROR: Failed to load scene res://scenes/Game.tscn", timedOut: false };
      return { code: 0, log: "", timedOut: false };
    };
    const report = await verifyProject({ dir, editor: GODOT, exec });
    expect(report.verdict).toBe("echec");
    expect(report.rounds).toHaveLength(1);
    expect(report.reason).toContain("ne démarre pas");
  });

  it("écrit un rapport lisible à côté du jeu démonté", async () => {
    const dir = project(sandbox().dir);
    const { exec } = fakeGodot(dir);
    const report = await verifyProject({ dir, editor: GODOT, exec });
    const md = launchMarkdown("Slay the Spire 2", report);
    expect(md).toContain("# Lancer Slay the Spire 2");
    expect(md).toContain("**Démarre.**");
    expect(md).toContain("Fichiers recréés (1)");
    expect(md).toContain("aucun fichier n'est modifié dans l'installation d'origine");
  });
});
