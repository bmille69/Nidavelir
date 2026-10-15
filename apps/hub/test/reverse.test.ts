import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHub } from "../src/hub.ts";
import { buildChatArgs } from "../src/llm/claude-cli.ts";
import { detectGame } from "../src/reverse/detect.ts";
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
    writeFileSync(join(input.out, "src", "Cards", "Strike.cs"), "class Strike { int damage = 6; }");
  }
}

/** L'Archéologue factice : retient le dossier qu'on lui donne à lire. */
class Archeologue extends FakeOrchestrator {
  readDirs: (string | undefined)[] = [];
  override async reply(input: { systemPrompt: string; prompt: string; readDir?: string }) {
    this.readDirs.push(input.readDir);
    this.calls.push({ kind: "reply", systemPrompt: input.systemPrompt, prompt: input.prompt });
    if (!input.readDir) return super.reply(input);
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

    // L'Archéologue a fait la fiche d'ensemble en lisant le dossier démonté, et seulement lui.
    expect(done.notes).toMatchObject([{ title: "Vue d'ensemble", status: "done" }]);
    expect(fake.readDirs).toEqual([done.out]);
    expect(existsSync(join(sb.dir, "hub/.data/dissections", d.id, "fiches", "001.md"))).toBe(true);

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
    expect(sent.text).toMatch(/On ne copie pas le code d'origine[\s\S]*Strike inflige 6 dégâts/);
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
