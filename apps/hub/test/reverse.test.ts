import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHub } from "../src/hub.ts";
import { buildChatArgs } from "../src/llm/claude-cli.ts";
import { detectGame } from "../src/reverse/detect.ts";
import type { GodotInstall } from "../src/godot/toolchain.ts";
import { buildMap, typesIn } from "../src/reverse/map.ts";
import type { PublicDataPort } from "../src/reverse/public-data.ts";
import type { Exec } from "../src/reverse/playable.ts";
import { extractPack } from "../src/reverse/reverse-service.ts";
import type { DecompileInput, RecoverInput, ReverseToolsPort, ToolInfo } from "../src/reverse/tools.ts";
import { PolicyEngine } from "../src/executor/policy-engine.ts";
import { FakeOrchestrator } from "./fake-orchestrator.ts";
import { cleanupSandboxes, fakeClock, sandbox } from "./helpers.ts";

afterEach(() => cleanupSandboxes());

/** Un faux jeu installé : seulement les fichiers qui servent d'indices. */
function game(dir: string, files: string[]): string {
  for (const f of files) {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    if (!f.endsWith("/")) writeFileSync(join(dir, f), "x");
    else mkdirSync(join(dir, f), { recursive: true });
  }
  return dir;
}

class FakeTools implements ReverseToolsPort {
  installed = false;
  recovered: RecoverInput[] = [];
  decompiled: DecompileInput[] = [];
  /** La version du jeu démontée : la 2 change les dégâts de Strike et ajoute une carte. */
  version = 1;
  list(): ToolInfo[] {
    return [
      { id: "gdre", name: "GDRE Tools", repo: "GDRETools/gdsdecomp", purpose: "…", size: "≈ 100 Mo", installed: this.installed, version: this.installed ? "v2.7.4" : null },
      { id: "assetripper", name: "AssetRipper", repo: "AssetRipper/AssetRipper", purpose: "…", size: "≈ 45 Mo", installed: this.installed, version: this.installed ? "2.0.0" : null },
      { id: "ilspy", name: "ILSpy", repo: "icsharpcode/ILSpy", purpose: "…", size: "≈ 30 Mo", installed: this.installed, version: this.installed ? "9.1.0.7988" : null },
      { id: "cpp2il", name: "Cpp2IL", repo: "SamboyCoding/Cpp2IL", purpose: "…", size: "≈ 15 Mo", installed: this.installed, version: this.installed ? "2022.1.0-pre-release.21" : null },
    ];
  }
  dumped: string[] = [];
  /** Cpp2IL factice : les deux sorties au vrai format (ISIL en CRLF, diffable-cs avec les décalages), plus un assemblage du moteur. */
  async dumpIl2cpp(input: { game: string; out: string }): Promise<void> {
    this.dumped.push(input.game);
    const isil = join(input.out, "isil", "IsilDump");
    const cs = join(input.out, "cs", "DiffableCs");
    for (const d of [join(isil, "Assembly-CSharp"), join(isil, "UnityEngine.CoreModule"), join(cs, "Assembly-CSharp")]) mkdirSync(d, { recursive: true });
    writeFileSync(join(isil, "Assembly-CSharp", "PlayerMovement.txt"), ISIL.replace(/\n/g, "\r\n"));
    writeFileSync(join(isil, "UnityEngine.CoreModule", "Rigidbody.txt"), "Type: UnityEngine.Rigidbody\r\n");
    writeFileSync(join(cs, "Assembly-CSharp", "PlayerMovement.cs"), DIFFABLE_MOVEMENT);
    writeFileSync(join(cs, "Assembly-CSharp", "PlayerStats.cs"), DIFFABLE_STATS);
  }
  async install(): Promise<ToolInfo> {
    this.installed = true;
    return this.list()[0]!;
  }
  /** Les Godot disponibles pour rouvrir un projet démonté (ADR-120) : aucun par défaut, un test en pose un. */
  editors: GodotInstall[] = [];
  installedEditors: { version: string; mono: boolean }[] = [];
  godotEditors(): GodotInstall[] {
    return this.editors;
  }
  async installGodot(input: { version: string; mono: boolean }): Promise<GodotInstall> {
    this.installedEditors.push(input);
    const editor = { exe: `C:/godot/Godot_v${input.version}-stable${input.mono ? "_mono" : ""}_win64.exe`, version: input.version, mono: input.mono };
    this.editors = [editor];
    return editor;
  }
  async decompile(input: DecompileInput): Promise<void> {
    this.decompiled.push(input);
    mkdirSync(join(input.out, "Cards"), { recursive: true });
    writeFileSync(join(input.out, "Cards", "Strike.cs"), "class Strike : Card { int damage = 6; }");
  }
  async recover(input: RecoverInput): Promise<void> {
    this.recovered.push(input);
    input.log("Recovering project…");
    mkdirSync(join(input.out, "src", "Cards"), { recursive: true });
    writeFileSync(join(input.out, "project.godot"), "[application]");
    writeFileSync(join(input.out, "src", "Cards", "Strike.cs"), `class Strike { int damage = ${this.version === 1 ? 6 : 9}; }`);
    if (this.version > 1) writeFileSync(join(input.out, "src", "Cards", "Bash.cs"), "class Bash : Card { }");
  }
}

/** Extraits réels (Megabonk, raccourcis) des deux sorties de Cpp2IL. */
const ISIL = `Type: PlayerMovement

Method: System.Void Jump()

Disassembly:
\tmov [rsp+10h],rbx

ISIL:
\t001 Move rbx, rcx
\t002 Move rcx, [rbx+72]
\t003 Add [rbx+636], [rbx+636], 1
\t004 Move rcx, [0x183000000]
\t005 Move rdx, 26
\t006 Call PlayerStats.GetStat, rcx, rdx
\t007 Move rcx, [rbx+72]
\t008 Return

Method: System.Single Speed(PlayerMovement p)

Disassembly:
\tret

ISIL:
\t001 Move rax, [rcx+72]
\t002 Return rax
`;
const DIFFABLE_MOVEMENT = `//Type is in global namespace

[Token(Token = "0x2000019")]
public class PlayerMovement : MonoBehaviour
{
\t[Token(Token = "0x200001A")]
\tinternal enum CrouchState
\t{
\t\tNone = 0,
\t\tCrouching = 1,
\t}

\t[Token(Token = "0x4000071")]
\t[FieldOffset(Offset = "0x48")]
\tprivate Rigidbody rb; //Field offset: 0x48
\tpublic int usedJumps; //Field offset: 0x27C
\tpublic static float gravity; //Field offset: 0x0

\t[Token(Token = "0x6000082")]
\tpublic void Jump() { }

\tpublic static float Speed(PlayerMovement p) { }
}
`;
const DIFFABLE_STATS = `namespace Assets.Scripts.Stats;

public class PlayerStats
{
\tpublic float GetStat(EStat stat) { }
}

public enum EStat
{
\tMaxHealth = 0,
\tJumpHeight = 26,
}
`;

/** L'Archéologue factice : retient le dossier qu'on lui donne à lire. */
class Archeologue extends FakeOrchestrator {
  readDirs: (string | undefined)[] = [];
  override async reply(input: { systemPrompt: string; prompt: string; readDir?: string }) {
    this.readDirs.push(input.readDir);
    this.calls.push({ kind: "reply", systemPrompt: input.systemPrompt, prompt: input.prompt });
    if (!input.readDir) return super.reply(input);
    if (/Fais la fiche « Mise à jour/.test(input.prompt)) return { text: "# Mise à jour : ce qui a changé\n\nStrike passe de 6 à 9 dégâts.", costUsd: 0 };
    return { text: /Fais la fiche « Vue d'ensemble »/.test(input.prompt) ? "# Vue d'ensemble\n\nUn jeu de cartes. Les mods passent par Harmony." : "# Les cartes d'attaque\n\nStrike inflige 6 dégâts.", costUsd: 0 };
  }
}

describe("détection du moteur (ADR-40)", () => {
  it("reconnaît Godot C#, Unity, Unreal, et refuse les jeux protégés", () => {
    const sb = sandbox();
    const sts = detectGame(
      game(join(sb.dir, "Slay the Spire 2"), ["SlayTheSpire2.exe", "SlayTheSpire2.pck", "data_sts2_windows_x86_64/sts2.dll", "data_sts2_windows_x86_64/GodotSharp.dll", "data_sts2_windows_x86_64/0Harmony.dll"]),
    );
    expect(sts).toMatchObject({ engine: "godot-dotnet", tool: "gdre", protection: null, moddable: "Harmony (outil de mods intégré)" });
    expect(sts.pck).toMatch(/SlayTheSpire2\.pck$/);
    expect(sts.assembly).toMatch(/data_sts2_windows_x86_64[\\/]sts2\.dll$/);

    expect(detectGame(game(join(sb.dir, "gd"), ["Jeu.exe", "Jeu.pck"]))).toMatchObject({ engine: "godot", tool: "gdre" });
    const mono = detectGame(game(join(sb.dir, "mono"), ["UnityPlayer.dll", "Jeu_Data/Managed/Assembly-CSharp.dll"]));
    expect(mono).toMatchObject({ engine: "unity-mono", tool: "assetripper" });
    expect(mono.pck).toMatch(/Jeu_Data$/);
    expect(mono.assembly).toMatch(/Assembly-CSharp\.dll$/);
    expect(detectGame(game(join(sb.dir, "il2cpp"), ["UnityPlayer.dll", "GameAssembly.dll", "Jeu_Data/"]))).toMatchObject({ engine: "unity-il2cpp", tool: "assetripper", assembly: null });
    expect(detectGame(game(join(sb.dir, "ue"), ["Jeu.exe", "Jeu/Content/Paks/Jeu.pak"]))).toMatchObject({ engine: "unreal" });
    // Anti-triche : jamais démonté, même si le moteur est pris en charge.
    expect(detectGame(game(join(sb.dir, "protege"), ["Jeu.pck", "EasyAntiCheat/EasyAntiCheat_EOS_Setup.exe"]))).toMatchObject({ engine: "godot", protection: "Easy Anti-Cheat", tool: null });
  });

  it("reconnaît Riot Vanguard, installé hors du dossier du jeu, et un jeu Unity mal installé (ADR-95)", () => {
    const sb = sandbox();
    // Cas réel : League of Legends n'a aucun fichier d'anti-triche dans son dossier (Vanguard est dans Program Files).
    const lol = detectGame(game(join(sb.dir, "Riot Games", "League of Legends"), ["Game/League of Legends.exe", "Game/DATA/FINAL/Maps/Shipping/Map11.wad.client"]));
    expect(lol).toMatchObject({ protection: "Riot Vanguard", tool: null });
    expect(detectGame(game(join(sb.dir, "Riot Games", "Autre"), ["Jeu.exe"])).protection).toBe("Riot Vanguard");
    // Cas réel : Mycopunk, dont le dossier de données est vide.
    const myco = detectGame(game(join(sb.dir, "Mycopunk"), ["Mycopunk_Data/", "Version.txt"]));
    expect(myco).toMatchObject({ engine: "unity-mono", tool: "assetripper" });
    expect(myco.incomplete).toMatch(/Mycopunk_Data ne contient pas les données du jeu/);
    expect(detectGame(game(join(sb.dir, "ok"), ["UnityPlayer.dll", "Ok_Data/globalgamemanagers", "Ok_Data/Managed/Assembly-CSharp.dll"])).incomplete).toBeNull();
  });
});

describe("carte du jeu (ADR-42)", () => {
  it("repère les types C# et GDScript, les familles et les autoloads", () => {
    expect(typesIn("namespace Jeu.Cartes;\npublic sealed partial class Frappe : CarteBase, IJouable\n{\n}\ninternal record Effet(int Valeur);\nenum Rarete { Commune }", "a.cs")).toEqual([
      { name: "Jeu.Cartes.Frappe", kind: "class", base: "CarteBase", file: "a.cs", line: 2 },
      { name: "Jeu.Cartes.Effet", kind: "record", base: null, file: "a.cs", line: 5 },
      { name: "Jeu.Cartes.Rarete", kind: "enum", base: null, file: "a.cs", line: 6 },
    ]);
    expect(typesIn("extends Node2D\nclass_name Joueur\n", "j.gd")).toEqual([{ name: "Joueur", kind: "class", base: "Node2D", file: "j.gd", line: 2 }]);

    const sb = sandbox();
    const root = join(sb.dir, "demonte");
    mkdirSync(join(root, "src", "Cartes"), { recursive: true });
    writeFileSync(join(root, "project.godot"), '[application]\nrun/main_scene="res://Menu.tscn"\n\n[autoload]\nPartie="*res://src/Partie.cs"\n');
    writeFileSync(join(root, "src", "CarteBase.cs"), "namespace Jeu;\npublic abstract class CarteBase {}");
    for (const c of ["Frappe", "Defense", "Coup"]) writeFileSync(join(root, "src", "Cartes", `${c}.cs`), `namespace Jeu.Cartes;\nclass ${c} : CarteBase {}`);
    const { map, index, types } = buildMap(root, "Mon jeu");
    expect(types).toBe(4);
    expect(map).toMatch(/Scène de départ : `res:\/\/Menu.tscn`/);
    expect(map).toMatch(/Partie : `res:\/\/src\/Partie.cs`/);
    expect(map).toMatch(/`CarteBase` : 3 variantes \(définie dans `src\/CarteBase.cs:2`\)/);
    expect(index).toMatch(/^Jeu\.Cartes\.Coup \| class : CarteBase \| src\/Cartes\/Coup.cs:2$/m);
  });
});

describe("Atelier de démontage (ADR-40)", { timeout: 30_000 }, () => {
  it("démonte un jeu Unity IL2CPP avec AssetRipper : carte des scènes, indice pour l'Archéologue", async () => {
    const sb = sandbox();
    sb.hub.close();
    const tools = new FakeTools();
    tools.installed = true;
    tools.recover = async (input) => {
      tools.recovered.push(input);
      mkdirSync(join(input.out, "ExportedProject", "ProjectSettings"), { recursive: true });
      mkdirSync(join(input.out, "ExportedProject", "Assets", "Scripts"), { recursive: true });
      writeFileSync(join(input.out, "ExportedProject", "ProjectSettings", "EditorBuildSettings.asset"), "m_Scenes:\n  - enabled: 1\n    path: Assets/Scenes/Menu.unity\n  - enabled: 1\n    path: Assets/Scenes/Gameplay.unity\n");
      writeFileSync(join(input.out, "ExportedProject", "Assets", "Scripts", "Weapon.cs"), "public class Weapon : MonoBehaviour { }");
    };
    const fake = new Archeologue();
    const hub = createHub({
      databasePath: join(sb.dir, "hub/.data/unity.db"),
      registry: { forbiddenTrees: [join(sb.dir, "hub")], forbiddenExact: [sb.dir] },
      clock: fakeClock(),
      orchestrator: fake,
      dataDir: join(sb.dir, "hub/.data"),
      reverseTools: tools,
    });
    sb.hub = hub;
    const path = game(join(sb.dir, "steam", "Vampire Survivors"), ["VampireSurvivors.exe", "UnityPlayer.dll", "GameAssembly.dll", "VampireSurvivors_Data/il2cpp_data/Metadata/global-metadata.dat"]);
    const d = hub.reverse.create(sb.human(), path);
    expect(d.scan).toMatchObject({ engine: "unity-il2cpp", tool: "assetripper" });
    hub.reverse.run(sb.human(), d.id, "complet");
    await hub.reverse.idle();
    expect(hub.reverse.get(d.id)).toMatchObject({ status: "extracted", functions: true });
    expect(tools.recovered[0]).toMatchObject({ tool: "assetripper", game: path });
    expect(tools.dumped).toEqual([path]);
    const base = join(sb.dir, "hub/.data/dissections", d.id);
    const carte = readFileSync(join(base, "carte.md"), "utf8");
    expect(carte).toMatch(/## Projet Unity[\s\S]*`Assets\/Scenes\/Menu.unity`[\s\S]*`Assets\/Scenes\/Gameplay.unity`/);
    expect(carte).toMatch(/## Code des fonctions \(IL2CPP\)[\s\S]*2 méthodes dans 1 types/);
    // Le code annoté (ADR-96) : champs de « this » nommés, valeur d'énumération nommée, rien pour un paramètre ni pour le moteur.
    const code = readFileSync(join(base, "jeu", "fonctions", "Assembly-CSharp", "PlayerMovement.txt"), "utf8");
    expect(code).toContain("Type : PlayerMovement (hérite de MonoBehaviour)");
    expect(code).toContain("002 Move rcx, [rbx+72 «rb»]");
    expect(code).toContain("003 Add [rbx+636 «usedJumps»], [rbx+636 «usedJumps»], 1");
    expect(code).toContain("006 Call PlayerStats.GetStat, rcx, rdx   «EStat.JumpHeight»");
    expect(code).toContain("007 Move rcx, [rbx+72 «rb»]");
    expect(code).toMatch(/Méthode : System.Single Speed\(PlayerMovement p\)   \[statique\]\n\t001 Move rax, \[rcx\+72\]\n/);
    expect(code).not.toContain("mov [rsp");
    expect(existsSync(join(base, "jeu", "fonctions", "UnityEngine.CoreModule"))).toBe(false);
    expect(existsSync(join(base, "cpp2il-brut"))).toBe(false);
    expect(fake.calls.at(-1)!.prompt).toMatch(/le vrai code de chaque fonction est dans jeu\/fonctions\//);
  });

  it("IL2CPP sans Cpp2IL : la structure seulement, puis « Récupérer le code des fonctions » sans tout redémonter (ADR-96)", async () => {
    const sb = sandbox();
    sb.hub.close();
    const tools = new FakeTools();
    tools.installed = true;
    const list = tools.list.bind(tools);
    let cpp2il = false;
    tools.list = () => list().map((t) => (t.id === "cpp2il" ? { ...t, installed: cpp2il } : t));
    tools.recover = async (input) => {
      tools.recovered.push(input);
      mkdirSync(join(input.out, "ExportedProject", "Assets", "Scripts"), { recursive: true });
      writeFileSync(join(input.out, "ExportedProject", "Assets", "Scripts", "PlayerMovement.cs"), "public class PlayerMovement : MonoBehaviour { public void Jump() { } }");
    };
    const fake = new Archeologue();
    const hub = createHub({
      databasePath: join(sb.dir, "hub/.data/unity.db"),
      registry: { forbiddenTrees: [join(sb.dir, "hub")], forbiddenExact: [sb.dir] },
      clock: fakeClock(),
      orchestrator: fake,
      dataDir: join(sb.dir, "hub/.data"),
      reverseTools: tools,
    });
    sb.hub = hub;
    const path = game(join(sb.dir, "steam", "Megabonk"), ["Megabonk.exe", "UnityPlayer.dll", "GameAssembly.dll", "Megabonk_Data/il2cpp_data/Metadata/global-metadata.dat"]);
    const d = hub.reverse.create(sb.human(), path);
    expect(d.needs).toEqual(["assetripper", "cpp2il"]);
    expect(() => hub.reverse.run(sb.human(), d.id, "fonctions")).toThrow(/Démontez d'abord/);
    expect(() => hub.reverse.run(sb.human(), d.id, "complet")).toThrow(/Installez d'abord l'outil nécessaire : Cpp2IL/);

    // Cpp2IL échoue pendant un démontage complet : le travail d'AssetRipper (souvent long) n'est pas perdu.
    cpp2il = true;
    const dump = tools.dumpIl2cpp.bind(tools);
    tools.dumpIl2cpp = async () => {
      throw new Error("métadonnées illisibles");
    };
    hub.reverse.run(sb.human(), d.id, "complet");
    await hub.reverse.idle();
    expect(hub.reverse.get(d.id)).toMatchObject({ status: "extracted", functions: false });
    expect(readFileSync(join(sb.dir, "hub/.data/dissections", d.id, "outil.log"), "utf8")).toMatch(/Code des fonctions non récupéré : métadonnées illisibles/);
    expect(fake.calls.at(-1)!.prompt).toMatch(/IL2CPP, le code récupéré n'a que sa structure/);

    // « Récupérer le code des fonctions » : Cpp2IL seul, sans refaire AssetRipper.
    tools.dumpIl2cpp = dump;
    const recovered = tools.recovered.length;
    expect(hub.reverse.run(sb.human(), d.id, "fonctions")).toMatchObject({ status: "running", mode: "fonctions" });
    await hub.reverse.idle();
    expect(hub.reverse.get(d.id)).toMatchObject({ status: "extracted", functions: true, error: null });
    expect(tools.recovered.length).toBe(recovered);
    expect(hub.reverse.get(d.id).notes).toHaveLength(2);
    expect(fake.calls.at(-1)!.prompt).toMatch(/Fais la fiche « Le code des fonctions : les vraies règles »/);
    expect(fake.calls.at(-1)!.prompt).toMatch(/Ta vue d'ensemble \(fiches\/001\.md\) a été écrite sans lui/);
    expect(readFileSync(join(sb.dir, "hub/.data/dissections", d.id, "carte.md"), "utf8")).toMatch(/## Code des fonctions \(IL2CPP\)/);

    // Cpp2IL en échec sur ce bouton : le démontage reste « Démonté », avec l'erreur affichée.
    tools.dumpIl2cpp = async () => {
      throw new Error("métadonnées illisibles");
    };
    rmSync(join(sb.dir, "hub/.data/dissections", d.id, "jeu", "fonctions"), { recursive: true, force: true });
    hub.reverse.run(sb.human(), d.id, "fonctions");
    await hub.reverse.idle();
    expect(hub.reverse.get(d.id)).toMatchObject({ status: "extracted", functions: false, error: "Code des fonctions : métadonnées illisibles" });
    cpp2il = false;
    expect(() => hub.reverse.run(sb.human(), d.id, "fonctions")).toThrow(/Installez d'abord l'outil nécessaire : Cpp2IL/);
  });

  it("installer l'outil sur demande, démonter, fiche d'ensemble, question, envoi au studio, projet de mod", async () => {
    const sb = sandbox();
    sb.hub.close();
    const tools = new FakeTools();
    const fake = new Archeologue();
    const hub = createHub({
      databasePath: join(sb.dir, "hub/.data/atelier.db"),
      registry: { forbiddenTrees: [join(sb.dir, "hub")], forbiddenExact: [sb.dir] },
      clock: fakeClock(),
      orchestrator: fake,
      dataDir: join(sb.dir, "hub/.data"),
      reverseTools: tools,
    });
    sb.hub = hub;
    const path = game(join(sb.dir, "steam", "Slay the Spire 2"), [
      "SlayTheSpire2.exe",
      "SlayTheSpire2.pck",
      "data_sts2_windows_x86_64/sts2.dll",
      "data_sts2_windows_x86_64/0Harmony.dll",
    ]);
    const before = readFileSync(join(path, "SlayTheSpire2.pck"), "utf8");

    const d = hub.reverse.create(sb.human(), path);
    expect(d).toMatchObject({ name: "Slay the Spire 2", status: "detected" });
    expect(hub.reverse.create(sb.human(), path).id).toBe(d.id);
    // Rien ne s'installe tout seul.
    expect(() => hub.reverse.run(sb.human(), d.id, "code")).toThrow(/Installez d'abord/);
    await hub.reverse.installTool(sb.human(), "gdre");

    hub.reverse.run(sb.human(), d.id, "code");
    await hub.reverse.idle();
    const done = hub.reverse.get(d.id);
    expect(done).toMatchObject({ status: "extracted", mode: "code", files: 2 });
    expect(tools.recovered[0]).toMatchObject({ scriptsOnly: true, out: done.out });
    expect(tools.recovered[0]!.assembly).toMatch(/sts2\.dll$/);
    // Le jeu installé n'est jamais touché ; le démontage vit dans les données du hub.
    expect(readFileSync(join(path, "SlayTheSpire2.pck"), "utf8")).toBe(before);
    expect(done.out.startsWith(join(sb.dir, "hub/.data"))).toBe(true);

    // L'Archéologue a fait la fiche d'ensemble en lisant le dossier du démontage, et seulement lui :
    // le jeu démonté, la carte calculée par le hub, l'index du code et ses fiches (ADR-42).
    const base = join(sb.dir, "hub/.data/dissections", d.id);
    expect(done.notes).toMatchObject([{ title: "Vue d'ensemble", status: "done" }]);
    expect(fake.readDirs).toEqual([base]);
    expect(done.out).toBe(join(base, "jeu"));
    expect(existsSync(join(base, "fiches", "001.md"))).toBe(true);
    expect(readFileSync(join(base, "carte.md"), "utf8")).toMatch(/# Carte de « Slay the Spire 2 »[\s\S]*1 types dans 1 fichiers/);
    expect(readFileSync(join(base, "index-code.txt"), "utf8")).toBe("Strike | class | src/Cards/Strike.cs:1\n");
    expect(readFileSync(join(base, "outil.log"), "utf8")).toMatch(/Recovering project/);
    expect(fake.calls.at(-1)!.systemPrompt).toMatch(/Zones d'ombre/);
    expect(done).toMatchObject({ updated: false, previous: false });

    hub.reverse.ask(sb.human(), d.id, "Comment marchent les cartes d'attaque ?");
    await hub.reverse.idle();
    const notes = hub.reverse.get(d.id).notes;
    expect(notes[1]).toMatchObject({ title: "Les cartes d'attaque", status: "done" });

    // Inspiration : la fiche part au directeur d'un projet, jamais le code décompilé.
    const repo = sb.makeGameRepo("games/bordee");
    await hub.projects.register(sb.human(), { path: repo, slug: "bordee", name: "Bordée" });
    const { thread } = await hub.reverse.send(sb.human(), d.id, notes[1]!.id, "bordee");
    await hub.conversations.idle();
    const sent = hub.conversations.messages("bordee", thread)[0]!;
    expect(sent.text).toMatch(/On ne copie pas le code d'origine[\s\S]*critères de recette[\s\S]*Strike inflige 6 dégâts/);
    expect(hub.conversations.getThread("bordee", thread).title).toBe("Inspiration : Les cartes d'attaque");

    // Mod : un projet à part, avec les fiches et le chemin des assemblages ; le directeur pose la base.
    const mod = await hub.reverse.createMod(sb.human(), d.id, join(sb.dir, "games"));
    expect(mod.project).toBe("mod-slay-the-spire-2");
    const root = hub.projects.get(mod.project).root;
    expect(readFileSync(join(root, "README.md"), "utf8")).toMatch(/data_sts2_windows_x86_64[\s\S]*Harmony/);
    expect(existsSync(join(root, "docs", "archeologue", "001.md"))).toBe(true);
    // Le dossier docs/ (nouveau) est bien commité.
    await vi.waitFor(() => expect(execFileSync("git", ["-C", root, "ls-files", "docs"], { encoding: "utf8" })).toMatch(/docs\/archeologue\/001\.md/));
    await hub.conversations.idle();
    expect(hub.conversations.messages(mod.project, mod.thread)[0]!.text).toMatch(/mod pour « Slay the Spire 2 »/);
    await expect(hub.reverse.createMod(sb.human(), d.id, join(sb.dir, "games"))).rejects.toThrow(/existe déjà/);

    // Le jeu est mis à jour : le hub le voit, on redémonte, l'ancienne version est gardée et comparée (ADR-42).
    writeFileSync(join(path, "SlayTheSpire2.pck"), "version 2 du jeu");
    expect(hub.reverse.get(d.id).updated).toBe(true);
    tools.version = 2;
    hub.reverse.run(sb.human(), d.id, "code");
    await hub.reverse.idle();
    const again = hub.reverse.get(d.id);
    expect(again).toMatchObject({ status: "extracted", updated: false, previous: true });
    expect(readFileSync(join(base, "ancien", "src", "Cards", "Strike.cs"), "utf8")).toMatch(/damage = 6/);
    const changes = readFileSync(join(base, "changements.md"), "utf8");
    expect(changes).toMatch(/Fichiers modifiés \(1\)\n- `src\/Cards\/Strike.cs`/);
    expect(changes).toMatch(/Fichiers ajoutés \(1\)\n- `src\/Cards\/Bash.cs`/);
    expect(changes).toMatch(/Types \(classes…\) apparus \(1\)\n- `Bash`/);
    // Pas de nouvelle vue d'ensemble : la fiche des changements, avec le risque pour le mod.
    expect(again.notes.map((n) => n.title)).toEqual(["Vue d'ensemble", "Les cartes d'attaque", "Mise à jour : ce qui a changé"]);
    expect(fake.calls.at(-1)!.prompt).toMatch(/casser un patch Harmony/);
    // Envoyée au projet de mod, la fiche parle du mod, pas d'inspiration.
    const toMod = await hub.reverse.send(sb.human(), d.id, again.notes[2]!.id, mod.project);
    await hub.conversations.idle();
    expect(hub.conversations.getThread(mod.project, toMod.thread).title).toBe("Fiche : Mise à jour : ce qui a changé");
    expect(hub.conversations.messages(mod.project, toMod.thread)[0]!.text).toMatch(/le jeu que modifie ce projet[\s\S]*nos patches/);
    // La réponse du directeur tourne en arrière-plan : on l'attend avant d'effacer le bac à sable (sinon Windows refuse).
    await vi.waitFor(() => expect(hub.conversations.messages(mod.project, toMod.thread)).toHaveLength(2), { timeout: 10_000 });
    await hub.conversations.idle();
  });

  it("un jeu protégé reste bloqué, et un moteur non pris en charge le dit", async () => {
    const sb = sandbox();
    const protege = sb.hub.reverse.create(sb.human(), game(join(sb.dir, "p"), ["Jeu.pck", "BattlEye/BEService.exe"]));
    expect(protege.status).toBe("blocked");
    expect(() => sb.hub.reverse.run(sb.human(), protege.id, "code")).toThrow(/protégé \(BattlEye\)/);
    const unreal = sb.hub.reverse.create(sb.human(), game(join(sb.dir, "u"), ["Jeu.exe", "Jeu/Content/Paks/Jeu.pak"]));
    expect(() => sb.hub.reverse.run(sb.human(), unreal.id, "code")).toThrow(/pas encore pris en charge/);
  });

  it("l'Archéologue ne reçoit que lire, chercher, lister, dans le dossier démonté", () => {
    const args = buildChatArgs({ systemPrompt: "s", prompt: "p", model: "sonnet", readDir: "C:/x" }, "sys.txt");
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
    expect(args).not.toContain("--allowedTools");
    expect(() => buildChatArgs({ systemPrompt: "s", prompt: "p", model: "sonnet", readDir: "C:/x", tools: ["Bash"] }, "sys.txt")).toThrow();
  });
});

/** Une petite archive CommunityDragon : la carte du mode Swarm (map33), un ennemi, un héros, les textes français. */
class FakeCdragon implements PublicDataPort {
  urls: string[] = [];
  files: Record<string, string> = {
    "/14.15/game/data/maps/shipping/map33/map33.bin.json": JSON.stringify({
      "{w1}": {
        name: "MapA_WaveDef1",
        WaveShape: { InnerRadius: 1600, OuterRadius: 2500, __type: "{bcec55fa}" },
        SpawnIntervalSecs: 0.2,
        SpawnCountPerInterval: 2,
        MaxSpawnCount: 1000,
        characters: [{ CharacterRecord: "Characters/Strawberry_Enemy_Swarmer/CharacterRecords/Root", RandomWeight: 1 }],
        behaviors: [{ maxDistance: 2400, __type: "{7af6df8b}" }],
        __type: "{e75aad84}",
      },
      "{w2}": { name: "MapA_WaveDef2", SpawnIntervalSecs: 1, SpawnCountPerInterval: 1, characters: [], __type: "{e75aad84}" },
      "{g1}": { Waves: ["{w1}"], __type: "{51c026b9}" },
      "{g2}": { Waves: ["{w2}"], __type: "{51c026b9}" },
      "{p}": {
        type: 2,
        DisplayNameTra: "Strawberry_PhaseName_Default",
        SubPhases: [
          { type: 2, duration: 42, "{a42117a5}": ["{g1}"] },
          { type: 2, duration: 45, "{a42117a5}": ["{g2}"] },
        ],
        __type: "LoLModesPhaseData",
      },
      "{a}": { AugmentNameId: "Strawberry_Jinx_Evolve", NameTra: "Strawberry_JinxAutoAttack_Evolve_Name", DescriptionTra: "Strawberry_Jinx_Weapon_Evolve_Description", rarity: 2, RootSpell: "Characters/Strawberry_Jinx/Spells/X", __type: "AugmentData" },
      "{x}": { mExperienceRequiredPerLevel: [5, 15, 30], __type: "ExperienceCurveData" },
      // La carte recopie la fiche de l'ennemi : on garde celle du personnage.
      "Characters/Strawberry_Enemy_Swarmer/CharacterRecords/Root": { mCharacterName: "Strawberry_Enemy_Swarmer", baseHP: 1, __type: "CharacterRecord" },
    }),
    "/14.15/game/data/characters/": '<a href="../">..</a><a href="strawberry_enemy_swarmer/">x</a><a href="strawberry_jinx/">x</a><a href="strawberry_absent/">x</a><a href="aatrox/">x</a>',
    "/14.15/game/data/characters/strawberry_enemy_swarmer/strawberry_enemy_swarmer.bin.json": JSON.stringify({
      "Characters/Strawberry_Enemy_Swarmer/CharacterRecords/Root": { mCharacterName: "Strawberry_Enemy_Swarmer", baseHP: 80, baseDamage: 50, baseMoveSpeed: 230, __type: "CharacterRecord" },
    }),
    "/14.15/game/data/characters/strawberry_jinx/strawberry_jinx.bin.json": JSON.stringify({
      "Characters/Strawberry_Jinx/CharacterRecords/Root": { mCharacterName: "Strawberry_Jinx", baseHP: 1000, baseDamage: 60, name: "game_character_displayname_Strawberry_Jinx", __type: "CharacterRecord" },
      "Characters/Strawberry_Jinx/Spells/X": {
        mScriptName: "Strawberry_JinxAutoAttack",
        mSpell: { mDataValues: [{ mName: "MinigunBulletCount", mValues: [3, 3, 4, 5, 6, 7, 7] }], cooldownTime: [2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 1.25] },
        __type: "SpellObject",
      },
    }),
    "/14.15/game/fr_fr/data/menu/en_us/lol.stringtable.json": JSON.stringify({
      entries: {
        game_character_displayname_strawberry_jinx: "Jinx",
        strawberry_jinxautoattack_evolve_name: "Barrage du chat de combat",
        strawberry_jinx_weapon_evolve_description: "Les balles transpercent désormais les ennemis.",
        game_character_displayname_ryze: "Ryze",
      },
    }),
  };
  async get(url: string): Promise<string | null> {
    this.urls.push(url);
    return this.files[new URL(url).pathname] ?? null;
  }
}

/** L'Archéologue factice d'ADR-95 : vue d'ensemble, puis un dossier de feature terminé par son bloc JSON. */
class FeatureArcheologue extends FakeOrchestrator {
  override async reply(input: { systemPrompt: string; prompt: string; readDir?: string }) {
    this.calls.push({ kind: "reply", systemPrompt: input.systemPrompt, prompt: input.prompt });
    if (!input.readDir) return super.reply(input);
    if (/dossier de feature/.test(input.prompt))
      return {
        text: [
          "# Les vagues de la carte A",
          "",
          "## Règles à reproduire",
          "1. La première vague dure 42 s (tables/deroulement.json).",
          "",
          "```json",
          JSON.stringify({
            donnees: ["tables/vagues.json", "tables/deroulement.json", "jeu/data/characters/strawberry_jinx/strawberry_jinx.bin.json", "../../hub.db", "jeu/csharp/Spawner.cs", "tables/absente.json"],
            scenarios: [{ situation: "À 42 s de jeu", attendu: "la vague MapA_WaveDef2 commence", source: "tables/deroulement.json" }],
            dependances: ["déplacement du joueur"],
          }),
          "```",
        ].join("\n"),
        costUsd: 0,
      };
    return { text: "# Vue d'ensemble\n\nUn mode de survie à vagues.", costUsd: 0 };
  }
}

describe("Atelier de démontage, troisième passe (ADR-95)", { timeout: 30_000 }, () => {
  function hubWith(sb: ReturnType<typeof sandbox>, tools: ReverseToolsPort, orchestrator: FakeOrchestrator, publicData?: PublicDataPort) {
    sb.hub.close();
    sb.hub = createHub({
      databasePath: join(sb.dir, "hub/.data/atelier3.db"),
      registry: { forbiddenTrees: [join(sb.dir, "hub")], forbiddenExact: [sb.dir] },
      clock: fakeClock(),
      orchestrator,
      dataDir: join(sb.dir, "hub/.data"),
      reverseTools: tools,
      publicData,
    });
    return sb.hub;
  }

  it("un jeu Godot C# dont le C# ne sort pas : ILSpy le décompile ; sans ILSpy, on demande de l'installer", async () => {
    const sb = sandbox();
    const tools = new FakeTools();
    // Cas réel (Slay the Spire 2) : GDRE Tools en « code seulement » ne rend que les scripts GDScript.
    tools.recover = async (input) => {
      tools.recovered.push(input);
      mkdirSync(join(input.out, "addons"), { recursive: true });
      writeFileSync(join(input.out, "addons", "SentryInit.gd"), "extends Node\nclass_name SentryInit\n");
    };
    const hub = hubWith(sb, tools, new Archeologue());
    const path = game(join(sb.dir, "steam", "Slay the Spire 2"), ["SlayTheSpire2.pck", "data_sts2_windows_x86_64/sts2.dll"]);
    const d = hub.reverse.create(sb.human(), path);
    expect(d.needs).toEqual(["gdre", "ilspy"]);
    expect(() => hub.reverse.run(sb.human(), d.id, "code")).toThrow(/Installez d'abord l'outil nécessaire : GDRE Tools, ILSpy/);
    await hub.reverse.installTool(sb.human(), "gdre");
    hub.reverse.run(sb.human(), d.id, "code");
    await hub.reverse.idle();
    expect(tools.decompiled[0]).toMatchObject({ out: join(d.out, "csharp") });
    expect(tools.decompiled[0]!.assembly).toMatch(/sts2\.dll$/);
    const done = hub.reverse.get(d.id);
    expect(done).toMatchObject({ status: "extracted", files: 2 });
    expect(readFileSync(join(sb.dir, "hub/.data/dissections", d.id, "index-code.txt"), "utf8")).toMatch(/^Strike \| class : Card \| csharp\/Cards\/Strike.cs:1$/m);
  });

  it("un démontage sans code est un échec expliqué, et un jeu mal installé n'est pas démonté", async () => {
    const sb = sandbox();
    const tools = new FakeTools();
    tools.installed = true;
    // Cas réel (Mycopunk) : AssetRipper « réussit » en n'écrivant que trois fichiers génériques.
    tools.recover = async (input) => {
      mkdirSync(join(input.out, "ExportedProject", "ProjectSettings"), { recursive: true });
      writeFileSync(join(input.out, "ExportedProject", "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 0.0.0a0");
    };
    const hub = hubWith(sb, tools, new Archeologue());
    const vide = hub.reverse.create(sb.human(), game(join(sb.dir, "steam", "Vide"), ["UnityPlayer.dll", "Vide_Data/globalgamemanagers"]));
    hub.reverse.run(sb.human(), vide.id, "complet");
    await hub.reverse.idle();
    const failed = hub.reverse.get(vide.id);
    expect(failed.status).toBe("failed");
    expect(failed.error).toMatch(/AssetRipper n'a récupéré aucun code \(1 fichiers en tout\)/);
    expect(failed.notes).toEqual([]);
    const myco = hub.reverse.create(sb.human(), game(join(sb.dir, "steam", "Mycopunk"), ["Mycopunk_Data/", "Version.txt"]));
    expect(() => hub.reverse.run(sb.human(), myco.id, "complet")).toThrow(/semble mal installé/);
  });

  it("League of Legends est bloqué ; Swarm s'importe des données publiques, rangées en tables", async () => {
    const sb = sandbox();
    const cdragon = new FakeCdragon();
    const fake = new FeatureArcheologue();
    const hub = hubWith(sb, new FakeTools(), fake, cdragon);
    const lol = hub.reverse.create(sb.human(), game(join(sb.dir, "Riot Games", "League of Legends"), ["Game/League of Legends.exe"]));
    expect(lol.status).toBe("blocked");
    expect(hub.reverse.sources().map((s) => s.id)).toEqual(["lol-swarm"]);
    expect(() => hub.reverse.createPublic(sb.human(), "lol-swarm", "14,15")).toThrow(/Version invalide/);

    const d = hub.reverse.createPublic(sb.human(), "lol-swarm", "14.15");
    expect(d).toMatchObject({ status: "detected", name: "League of Legends — Swarm (14.15)", needs: [], scan: { engine: "public-data", public: { source: "lol-swarm", patch: "14.15" } } });
    expect(hub.reverse.createPublic(sb.human(), "lol-swarm", "14.15").id).toBe(d.id);
    // Aucun outil à installer, et rien n'est lu sur le PC : seulement l'archive publique.
    hub.reverse.run(sb.human(), d.id, "code");
    await hub.reverse.idle();
    const done = hub.reverse.get(d.id);
    expect(done).toMatchObject({ status: "extracted", mode: "complet", updated: false });
    expect(cdragon.urls.every((u) => u.startsWith("https://raw.communitydragon.org/14.15/game/"))).toBe(true);
    expect(cdragon.urls.some((u) => u.includes("aatrox"))).toBe(false);

    const base = join(sb.dir, "hub/.data/dissections", d.id);
    const table = (f: string) => JSON.parse(readFileSync(join(base, "tables", f), "utf8"));
    expect(table("vagues.json")[0]).toMatchObject({ nom: "MapA_WaveDef1", carte: "A", intervalleSecondes: 0.2, parIntervalle: 2, distanceMin: 1600, ennemis: [{ personnage: "Strawberry_Enemy_Swarmer", poids: 1 }] });
    expect(table("deroulement.json")[0].etapes).toEqual([
      { debutSecondes: 0, dureeSecondes: 42, type: 2, vagues: ["MapA_WaveDef1"] },
      { debutSecondes: 42, dureeSecondes: 45, type: 2, vagues: ["MapA_WaveDef2"] },
    ]);
    const persos = table("personnages.json");
    expect(persos.filter((p: { id: string }) => p.id === "Strawberry_Enemy_Swarmer")).toEqual([expect.objectContaining({ pv: 80, sorte: "ennemi" })]);
    expect(persos.find((p: { id: string }) => p.id === "Strawberry_Jinx")).toMatchObject({ nom: "Jinx", pv: 1000 });
    expect(table("augments.json")[0]).toMatchObject({ nom: "Barrage du chat de combat", description: "Les balles transpercent désormais les ennemis.", rarete: 2 });
    expect(table("sorts.json")[0]).toMatchObject({ id: "Strawberry_JinxAutoAttack", valeurs: { MinigunBulletCount: [3, 3, 4, 5, 6, 7, 7] }, recharge: [2.5, 2.5, 2.5, 2.5, 2.5, 2.5, 1.25] });
    expect(table("experience.json")[0].xpParNiveau).toEqual([5, 15, 30]);
    // Seuls les textes du mode sont gardés.
    expect(Object.keys(JSON.parse(readFileSync(join(done.out, "textes-fr.json"), "utf8")))).not.toContain("game_character_displayname_ryze");
    expect(readFileSync(join(base, "carte.md"), "utf8")).toMatch(/`tables\/vagues.json` : 2 vagues[\s\S]*la principale a 2 étapes/);
    expect(readFileSync(join(base, "outil.log"), "utf8")).toMatch(/Sans fiche : strawberry_absent/);
    // L'Archéologue fait la vue d'ensemble d'un mode de jeu, prévenu qu'il n'y a pas de code.
    expect(done.notes).toMatchObject([{ title: "Vue d'ensemble", kind: "note" }]);
    expect(fake.calls.at(-1)!.prompt).toMatch(/données publiques d'un mode de jeu[\s\S]*tables\/[\s\S]*tables\/deroulement\.json/);
  });

  it("dossier de feature : données et scénarios vérifiés, rangés dans le projet, confiés au directeur", async () => {
    const sb = sandbox();
    const fake = new FeatureArcheologue();
    const hub = hubWith(sb, new FakeTools(), fake, new FakeCdragon());
    const d = hub.reverse.createPublic(sb.human(), "lol-swarm", "14.15");
    expect(() => hub.reverse.feature(sb.human(), d.id, "Les vagues")).toThrow(/Démontez d'abord/);
    hub.reverse.run(sb.human(), d.id, "complet");
    await hub.reverse.idle();

    hub.reverse.feature(sb.human(), d.id, "Les vagues d'ennemis de la carte A");
    await hub.reverse.idle();
    const note = hub.reverse.get(d.id).notes.find((n) => n.kind === "feature")!;
    expect(fake.calls.at(-1)!.prompt).toMatch(/Les vagues d'ennemis de la carte A[\s\S]*```json/);
    expect(note.title).toBe("Feature : Les vagues de la carte A");
    // Le bloc JSON sort de la fiche ; le code, l'extérieur et l'absent sont écartés.
    expect(note.body).not.toMatch(/```json/);
    expect(note.pack).toMatchObject({
      donnees: ["tables/vagues.json", "tables/deroulement.json", "jeu/data/characters/strawberry_jinx/strawberry_jinx.bin.json"],
      scenarios: [{ situation: "À 42 s de jeu", attendu: "la vague MapA_WaveDef2 commence" }],
      dependances: ["déplacement du joueur"],
    });
    expect(note.pack!.refuses).toEqual(["../../hub.db (hors du démontage)", "jeu/csharp/Spawner.cs (pas un fichier de données)", "tables/absente.json (introuvable)"]);

    const repo = sb.makeGameRepo("games/swarm");
    await hub.projects.register(sb.human(), { path: repo, slug: "swarm", name: "Swarm" });
    const { thread } = await hub.reverse.send(sb.human(), d.id, note.id, "swarm");
    const ref = join(repo, "studio", "references", "les-vagues-de-la-carte-a");
    expect(JSON.parse(readFileSync(join(ref, "donnees", "tables", "vagues.json"), "utf8"))[0].nom).toBe("MapA_WaveDef1");
    expect(existsSync(join(ref, "donnees", "jeu", "data", "characters", "strawberry_jinx", "strawberry_jinx.bin.json"))).toBe(true);
    expect(readFileSync(join(ref, "fiche.md"), "utf8")).toMatch(/^# Les vagues de la carte A/);
    expect(JSON.parse(readFileSync(join(ref, "scenarios.json"), "utf8"))).toMatchObject({ scenarios: [{ attendu: "la vague MapA_WaveDef2 commence" }], dependances: ["déplacement du joueur"] });
    expect(execFileSync("git", ["-C", repo, "log", "-1", "--format=%s"], { encoding: "utf8" })).toMatch(/dossier de feature « Feature : Les vagues de la carte A »/);
    await hub.conversations.idle();
    expect(hub.conversations.getThread("swarm", thread).title).toBe("Feature : Les vagues de la carte A");
    expect(hub.conversations.messages("swarm", thread)[0]!.text).toMatch(/studio\/references\/les-vagues-de-la-carte-a\/[\s\S]*critères d'acceptation[\s\S]*1\. À 42 s de jeu → la vague MapA_WaveDef2 commence/);
    await vi.waitFor(() => expect(hub.conversations.messages("swarm", thread)).toHaveLength(2), { timeout: 10_000 });
    await hub.conversations.idle();
  });

  it("le bloc du dossier est facultatif : sans lui, la fiche reste une inspiration", () => {
    expect(extractPack("# Titre\n\nSans bloc.", "C:/x")).toEqual({ body: "# Titre\n\nSans bloc.", pack: null });
    expect(extractPack("# Titre\n\n```json\n{pas du json}\n```", "C:/x").pack).toBeNull();
  });

  it("le développeur peut copier une donnée de studio/references vers le jeu, et seulement ça", () => {
    const sb = sandbox();
    const root = join(sb.dir, "worktree");
    mkdirSync(join(root, "studio", "references", "vagues", "donnees"), { recursive: true });
    writeFileSync(join(root, "studio", "references", "vagues", "donnees", "vagues.json"), "[]");
    const exec = new PolicyEngine({ mode: "execute", root, plan: { files_to_create: [], files_to_modify: [], files_to_delete: [], commands: [] } });
    const d = (cmd: string) => exec.evaluate("Bash", { command: cmd }).decision;
    expect(d("cp studio/references/vagues/donnees/vagues.json data/vagues.json")).toBe("allow");
    expect(d("cp studio/references/vagues/donnees/vagues.json studio/x.json")).toBe("ask");
    expect(d("cp studio/references/vagues/donnees/vagues.json ../dehors.json")).toBe("deny");
  });
});

describe("Le projet jouable (ADR-120)", { timeout: 30_000 }, () => {
  /** Un Godot simulé : le fichier vide est réclamé au premier lancement, plus après sa reconstitution. */
  function fakeExec(project: string, calls: string[]): Exec {
    return async (exe, args) => {
      calls.push([exe, ...args].join(" "));
      if (args.includes("--import")) return { code: 0, log: "Godot Engine v4.5.1.stable.mono.official", timedOut: false };
      if (exe === "dotnet") return { code: 0, log: "Build succeeded.", timedOut: false };
      const empty = join(project, "src", "Empty.cs");
      const log = existsSync(empty) && readFileSync(empty).length < 32 ? "ERROR: Cannot instantiate C# script because the associated class could not be found. Script: 'res://src/Empty.cs'" : "Godot Engine v4.5.1";
      return { code: 0, log, timedOut: false };
    };
  }

  /** Le projet Godot que GDRE rend : la scène, le C#, et un script vide que la scène réclame (cas réel). */
  function recovered(input: RecoverInput): void {
    mkdirSync(join(input.out, "scenes"), { recursive: true });
    mkdirSync(join(input.out, "src"), { recursive: true });
    writeFileSync(
      join(input.out, "project.godot"),
      'config_version=5\n\n[application]\n\nconfig/name="Slay the Spire 2"\nconfig/features=PackedStringArray("4.5", "C#", "Forward Plus")\nrun/main_scene="res://scenes/Game.tscn"\n\n[dotnet]\n\nproject/assembly_name="sts2"\n',
    );
    writeFileSync(join(input.out, "sts2.csproj"), '<Project Sdk="Godot.NET.Sdk/4.5.1"></Project>');
    writeFileSync(join(input.out, "scenes", "Game.tscn"), '[gd_scene load_steps=2 format=3]\n\n[ext_resource type="Script" path="res://src/Empty.cs" id="1_a"]\n\n[node name="Game" type="Control"]\n\nscript = ExtResource("1_a")\n');
    // GDRE laisse six scripts vides sur Slay the Spire 2 (0,17 %) : celui-ci en tient lieu.
    writeFileSync(join(input.out, "src", "Empty.cs"), "");
  }

  it("mesure le lancement, installe l'éditeur réclamé et recrée le script vide", async () => {
    const sb = sandbox();
    const tools = new FakeTools();
    tools.installed = true;
    tools.recover = async (input) => {
      tools.recovered.push(input);
      recovered(input);
    };
    const calls: string[] = [];
    const opened: { exe: string; args: string[]; cwd: string }[] = [];
    let project = "";
    const hub = createHub({
      databasePath: join(sb.dir, "hub/.data/atelier4.db"),
      registry: { forbiddenTrees: [join(sb.dir, "hub")], forbiddenExact: [sb.dir] },
      clock: fakeClock(),
      orchestrator: new Archeologue(),
      dataDir: join(sb.dir, "hub/.data"),
      reverseTools: tools,
      reverseExec: (exe, args, opts) => fakeExec(project, calls)(exe, args, opts),
      reverseOpen: (exe, args, cwd) => opened.push({ exe, args, cwd }),
    });
    sb.hub = hub;
    const d = hub.reverse.create(sb.human(), game(join(sb.dir, "steam", "Slay the Spire 2"), ["SlayTheSpire2.pck", "data_sts2_windows_x86_64/sts2.dll"]));
    project = d.out;
    hub.reverse.run(sb.human(), d.id, "complet");
    await hub.reverse.idle();

    // Sans Godot, rien n'est mesuré : le hub le dit et propose d'installer la version que le projet réclame.
    const afterRun = hub.reverse.get(d.id);
    expect(afterRun.status).toBe("extracted");
    // Tant que le lancement n'est pas vérifié, ni « Jouer » ni « Ouvrir dans Godot » (ADR-127).
    expect(() => hub.reverse.open(sb.human(), d.id, "play")).toThrow(/Vérifiez d'abord/);
    expect(afterRun.launch).toMatchObject({ verdict: "outil", need: { version: "4.5.1", mono: true } });
    expect(afterRun.launch!.reason).toBe("Il manque Godot 4.5.1 (Mono).");
    expect(existsSync(join(sb.dir, "hub/.data/dissections", d.id, "lancement.md"))).toBe(true);

    // « Installer Godot 4.5.1 » puis remesurer : le script vide est recréé, le projet démarre.
    await hub.reverse.installEditor(sb.human(), d.id);
    await hub.reverse.idle();
    expect(tools.installedEditors).toEqual([{ version: "4.5.1", mono: true }]);
    const afterLaunch = hub.reverse.get(d.id);
    expect(afterLaunch.launch).toMatchObject({ verdict: "playable", reason: "Le jeu démarre et tourne sans erreur." });
    expect(afterLaunch.launch!.rounds).toHaveLength(2);
    expect(afterLaunch.launch!.repairs.map((r) => r.file)).toEqual(["src/Empty.cs"]);
    expect(afterLaunch.launch!.editor).toMatchObject({ version: "4.5.1", mono: true });
    expect(readFileSync(join(project, "src", "Empty.cs"), "utf8")).toContain("public partial class Empty : Control");
    expect(calls.filter((c) => c.includes("--quit-after"))).toHaveLength(2);

    // « Se lance » : le hub ouvre l'éditeur sur la copie démontée, ou lance le jeu en fenêtre (ADR-127).
    expect(hub.reverse.open(sb.human(), d.id, "editor")).toEqual({ ok: true, editor: "Godot 4.5.1 (Mono)" });
    hub.reverse.open(sb.human(), d.id, "play");
    expect(opened.map((o) => o.args)).toEqual([
      ["--path", project, "-e"],
      ["--path", project],
    ]);
    expect(opened.every((o) => o.cwd === project && o.exe === afterLaunch.launch!.editor!.exe)).toBe(true);
  });

  it("ne promet rien pour Unity : la vérification du lancement est réservée à Godot", async () => {
    const sb = sandbox();
    const tools = new FakeTools();
    tools.installed = true;
    const hub = createHub({
      databasePath: join(sb.dir, "hub/.data/atelier5.db"),
      registry: { forbiddenTrees: [join(sb.dir, "hub")], forbiddenExact: [sb.dir] },
      clock: fakeClock(),
      orchestrator: new Archeologue(),
      dataDir: join(sb.dir, "hub/.data"),
      reverseTools: tools,
    });
    sb.hub = hub;
    const d = hub.reverse.create(sb.human(), game(join(sb.dir, "steam", "Hades"), ["UnityPlayer.dll", "Hades_Data/globalgamemanagers"]));
    hub.reverse.run(sb.human(), d.id, "complet");
    await hub.reverse.idle();
    expect(hub.reverse.get(d.id).status).toBe("extracted");
    expect(() => hub.reverse.relaunch(sb.human(), d.id)).toThrow(/n'est possible que pour Godot/);
  });
});
