import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHub } from "../src/hub.ts";
import { buildChatArgs } from "../src/llm/claude-cli.ts";
import { detectGame } from "../src/reverse/detect.ts";
import { buildMap, typesIn } from "../src/reverse/map.ts";
import type { RecoverInput, ReverseToolsPort, ToolInfo } from "../src/reverse/tools.ts";
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
  /** La version du jeu démontée : la 2 change les dégâts de Strike et ajoute une carte. */
  version = 1;
  list(): ToolInfo[] {
    return [{ id: "gdre", name: "GDRE Tools", repo: "GDRETools/gdsdecomp", purpose: "…", size: "≈ 100 Mo", installed: this.installed, version: this.installed ? "v2.7.4" : null }];
  }
  async install(): Promise<ToolInfo> {
    this.installed = true;
    return this.list()[0]!;
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
    expect(detectGame(game(join(sb.dir, "mono"), ["UnityPlayer.dll", "Jeu_Data/Managed/Assembly-CSharp.dll"]))).toMatchObject({ engine: "unity-mono", tool: null });
    expect(detectGame(game(join(sb.dir, "il2cpp"), ["UnityPlayer.dll", "GameAssembly.dll", "Jeu_Data/"]))).toMatchObject({ engine: "unity-il2cpp" });
    expect(detectGame(game(join(sb.dir, "ue"), ["Jeu.exe", "Jeu/Content/Paks/Jeu.pak"]))).toMatchObject({ engine: "unreal" });
    // Anti-triche : jamais démonté, même si le moteur est pris en charge.
    expect(detectGame(game(join(sb.dir, "protege"), ["Jeu.pck", "EasyAntiCheat/EasyAntiCheat_EOS_Setup.exe"]))).toMatchObject({ engine: "godot", protection: "Easy Anti-Cheat", tool: null });
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

describe("Atelier de démontage (ADR-40)", () => {
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
  });

  it("un jeu protégé reste bloqué, et un moteur non pris en charge le dit", async () => {
    const sb = sandbox();
    const protege = sb.hub.reverse.create(sb.human(), game(join(sb.dir, "p"), ["Jeu.pck", "BattlEye/BEService.exe"]));
    expect(protege.status).toBe("blocked");
    expect(() => sb.hub.reverse.run(sb.human(), protege.id, "code")).toThrow(/protégé \(BattlEye\)/);
    const unity = sb.hub.reverse.create(sb.human(), game(join(sb.dir, "u"), ["UnityPlayer.dll", "J_Data/Managed/Assembly-CSharp.dll"]));
    expect(() => sb.hub.reverse.run(sb.human(), unity.id, "code")).toThrow(/pas encore pris en charge/);
  });

  it("l'Archéologue ne reçoit que lire, chercher, lister, dans le dossier démonté", () => {
    const args = buildChatArgs({ systemPrompt: "s", prompt: "p", model: "sonnet", readDir: "C:/x" }, "sys.txt");
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Grep,Glob");
    expect(args).not.toContain("--allowedTools");
    expect(() => buildChatArgs({ systemPrompt: "s", prompt: "p", model: "sonnet", readDir: "C:/x", tools: ["WebFetch"] }, "sys.txt")).toThrow();
  });
});
