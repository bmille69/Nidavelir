import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fluxWorkflow, type GenRequest, type GenState, type ImageGenPort } from "../src/art/imagegen.ts";
import { createHub } from "../src/hub.ts";
import { readLog } from "../src/mods/installer.ts";
import { modName, VAMPIRE_SURVIVORS, type GameRecipe } from "../src/mods/recipes.ts";
import { gameBuild, installedGames, steamLibraries } from "../src/mods/steam.ts";
import type { RunResult, ToolchainPort, ToolchainState } from "../src/mods/toolchain.ts";
import { FakeExecutor } from "./fake-executor.ts";
import { FakeOrchestrator } from "./fake-orchestrator.ts";
import { cleanupSandboxes, fakeClock, sandbox } from "./helpers.ts";

afterEach(() => cleanupSandboxes());

const PLAN = {
  title: "Fouet plus fort",
  summary: "Le Fouet fait plus de dégâts.",
  kind: "regles",
  changes: ["Fouet : +30 % de dégâts"],
  settings: [{ name: "Bonus", default: "30", description: "Bonus de dégâts du Fouet, en %" }],
  questions: [],
  risks: ["Une mise à jour du jeu peut casser le mod"],
};
const REPORT = { summary: "Le Fouet frappe 30 % plus fort.", how_to_test: "Prenez Antonio et regardez les dégâts.", settings: ["Bonus (30)"], known_issues: [] };

/** Une bibliothèque Steam factice : libraryfolders.vdf, le manifeste du jeu, le dossier du jeu avec ses marques. */
function fakeSteam(dir: string, opts: { protected?: boolean } = {}) {
  const steam = join(dir, "Steam");
  const lib = join(dir, "Lib");
  mkdirSync(join(steam, "steamapps"), { recursive: true });
  mkdirSync(join(lib, "steamapps", "common", "Vampire Survivors"), { recursive: true });
  writeFileSync(join(steam, "steamapps", "libraryfolders.vdf"), `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${steam.replace(/\\/g, "\\\\")}"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"${lib.replace(/\\/g, "\\\\")}"\n\t}\n}\n`);
  const manifest = (build: string) => `"AppState"\n{\n\t"appid"\t\t"1794680"\n\t"name"\t\t"Vampire Survivors"\n\t"installdir"\t\t"Vampire Survivors"\n\t"buildid"\t\t"${build}"\n}\n`;
  writeFileSync(join(lib, "steamapps", "appmanifest_1794680.acf"), manifest("100"));
  const game = join(lib, "steamapps", "common", "Vampire Survivors");
  for (const f of ["VampireSurvivors.exe", "GameAssembly.dll"]) writeFileSync(join(game, f), "x");
  if (opts.protected) {
    mkdirSync(join(game, "EasyAntiCheat"), { recursive: true });
    writeFileSync(join(game, "EasyAntiCheat", "EasyAntiCheat_EOS.dll"), "x");
  }
  return { steam, lib, game, update: (build: string) => writeFileSync(join(lib, "steamapps", "appmanifest_1794680.acf"), manifest(build)) };
}

/** L'outillage factice : le chargeur posé en vrai dans le faux jeu, une carte des types, une construction simulée. */
class FakeToolchain implements ToolchainPort {
  readonly dir: string;
  builds: string[] = [];
  constructor(dir: string) {
    this.dir = dir;
  }
  state(r: GameRecipe, gameDir: string): ToolchainState {
    return {
      dotnet: { installed: true, version: "9.0.300" },
      loader: { installed: existsSync(join(gameDir, r.loader.installedMark)), version: r.loader.version, generated: existsSync(join(gameDir, r.loader.generatedMark)), installing: false, error: null },
      typemap: { ready: existsSync(join(this.typemapDir(r), "carte-types.txt")), types: 3, building: false, error: null },
    };
  }
  async installLoader(r: GameRecipe, gameDir: string) {
    mkdirSync(join(gameDir, "MelonLoader", "net6"), { recursive: true });
    writeFileSync(join(gameDir, r.loader.installedMark), "ml");
    mkdirSync(join(gameDir, "Mods"), { recursive: true });
  }
  async removeLoader() {}
  typemapDir(r: GameRecipe) {
    return join(this.dir, r.id, "carte");
  }
  async buildTypemap(r: GameRecipe) {
    mkdirSync(this.typemapDir(r), { recursive: true });
    writeFileSync(join(this.typemapDir(r), "carte-types.txt"), "Il2CppVampireSurvivors.Objects.Weapons.Whip\n  méthodes : Fire, Awake\n");
  }
  async build(r: GameRecipe, modDir: string): Promise<RunResult> {
    const code = readFileSync(join(modDir, "Mod.cs"), "utf8");
    this.builds.push(code);
    if (code.includes("ERREUR")) return { code: 1, out: "Mod.cs(12,5): error CS0103: Le nom 'Whipp' n'existe pas" };
    const proj = readdirSync(modDir).find((f) => f.endsWith(".csproj"))!;
    const name = /AssemblyName>(\w+)</.exec(readFileSync(join(modDir, proj), "utf8"))?.[1] ?? "Mod";
    mkdirSync(join(modDir, "bin", "Release"), { recursive: true });
    writeFileSync(join(modDir, r.output(name)), `dll ${code.length}`);
    return { code: 0, out: "0 erreur(s)" };
  }
}

/** Le générateur d'images factice : il retient les demandes et rend un petit PNG. */
class FakeGen implements ImageGenPort {
  requests: GenRequest[] = [];
  readonly installed: boolean;
  constructor(installed: boolean) {
    this.installed = installed;
  }
  state(): GenState {
    return { installed: this.installed, installing: null, error: null, size: "≈ 19 Go", kontext: { installed: false, installing: null, error: null, size: "≈ 17 Go" } };
  }
  install() {}
  installKontext() {}
  async generate(req: GenRequest) {
    this.requests.push(req);
    return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, this.requests.length)]);
  }
  close() {}
}

function setup(opts: { protected?: boolean; generator?: boolean } = {}) {
  const sb = sandbox();
  sb.hub.close();
  const orchestrator = new FakeOrchestrator();
  const executor = new FakeExecutor();
  const steam = fakeSteam(sb.dir, opts);
  const toolchain = new FakeToolchain(join(sb.dir, "hub/.data/mods"));
  const gen = new FakeGen(!!opts.generator);
  const hub = createHub({
    databasePath: join(sb.dir, "hub/.data/mods.db"),
    registry: { forbiddenTrees: [join(sb.dir, "hub")], forbiddenExact: [sb.dir] },
    clock: fakeClock(),
    orchestrator,
    executor,
    dataDir: join(sb.dir, "hub/.data"),
    modToolchain: toolchain,
    imagegen: gen,
    steamGames: () => installedGames(steamLibraries([steam.steam])),
  });
  sb.hub = hub;
  hub.mods.gamesRoot = join(sb.dir, "games");
  hub.mods.saveEnv = { APPDATA: join(sb.dir, "AppData") };
  return { sb, hub, orchestrator, executor, steam, toolchain, gen };
}

const log = (repo: string) => execFileSync("git", ["-C", repo, "log", "--format=%s"], { encoding: "utf8" });

describe("Studio de modding (ADR-65)", { timeout: 30_000 }, () => {
  it("trouve vos jeux Steam et leur version, dans toutes les bibliothèques", () => {
    const { sb, steam } = setup();
    const games = installedGames(steamLibraries([steam.steam]));
    expect(games).toEqual([{ appid: "1794680", name: "Vampire Survivors", dir: steam.game, buildid: "100", library: steam.lib }]);
    expect(gameBuild({ appid: "1794680", library: steam.lib })).toBe("100");
    expect(modName("Fouet plus fort !")).toBe("FouetPlusFort");
    expect(modName("3 coffres")).toBe("Mod3Coffres");
    void sb;
  });

  it("de l'idée au mod installé : plan validé, code confiné, construction, installation, journal, désinstallation", async () => {
    const { sb, hub, orchestrator, executor, steam, toolchain } = setup();
    // Le jeu : pris en charge, l'outillage se prépare sur vos clics.
    let game = hub.mods.games()[0]!;
    expect(game).toMatchObject({ name: "Vampire Survivors", recipe: { id: "vampire-survivors" }, protection: null, toolchain: { loader: { installed: false } } });
    // Pas d'outillage : le plan se fait, mais « Fabriquer » attend le chargeur.
    orchestrator.extractions.push(PLAN as never);
    const early = hub.mods.create(sb.human(), "1794680", "le fouet plus fort");
    await hub.mods.idle();
    expect(() => hub.mods.go(sb.human(), early.id)).toThrow(/Installez d'abord MelonLoader/);
    hub.mods.hide(sb.human(), early.id);
    hub.mods.installLoader(sb.human(), "1794680");
    await hub.mods.idle();
    expect(existsSync(join(steam.game, "MelonLoader", "net6", "MelonLoader.dll"))).toBe(true);
    game = hub.mods.games()[0]!;
    expect(game.toolchain).toMatchObject({ loader: { installed: true, generated: false } });
    // Le premier lancement du jeu génère les assemblies ; puis la carte des types.
    mkdirSync(join(steam.game, "MelonLoader", "Il2CppAssemblies"), { recursive: true });
    writeFileSync(join(steam.game, VAMPIRE_SURVIVORS.loader.generatedMark), "asm");
    hub.mods.buildTypemap(sb.human(), "1794680");
    await hub.mods.idle();

    // L'idée → le plan, que vous validez.
    orchestrator.extractions.push(PLAN as never);
    const m0 = hub.mods.create(sb.human(), "1794680", "le fouet fait 30% de dégâts en plus");
    expect(m0.status).toBe("planning");
    expect(() => hub.mods.create(sb.human(), "1794680", "un autre")).toThrow(/déjà en travail/);
    await hub.mods.idle();
    let m = hub.mods.get(m0.id);
    expect(m).toMatchObject({ status: "waiting", title: "Fouet plus fort", plan: { changes: ["Fouet : +30 % de dégâts"] } });

    // « Fabriquer » : le développeur écrit dans le dossier du mod, jamais dans le jeu ; le .csproj est intouchable.
    executor.scripts.execute.push(async (t, req) => {
      expect(req.systemPrompt).toMatch(/Vampire Survivors[\s\S]*carte-types\.txt/);
      expect(await t.write("Mod.cs", "// patch du Fouet\nclass Mod {}\n")).toBe("ok");
      expect(await t.write("FouetPlusFort.csproj", "<Project><Target Name=\"x\"><Exec Command=\"calc\" /></Target></Project>")).toBe("refused");
      expect(await t.write("Directory.Build.props", "<Project/>")).toBe("refused");
      expect(await t.write(join(steam.game, "Mods", "x.dll"), "x")).toBe("refused");
      expect(await t.bash("dotnet build -c Release")).toBe("ok");
      expect(await t.bash("dotnet run")).toBe("refused");
      expect(await t.bash("curl https://example.com")).toBe("refused");
      return REPORT;
    });
    hub.mods.go(sb.human(), m0.id);
    await hub.mods.idle();
    m = hub.mods.get(m0.id);
    expect(m).toMatchObject({ status: "ready", name: "FouetPlusFort", game_build: "100", outdated: false, report: { how_to_test: "Prenez Antonio et regardez les dégâts." } });
    expect(m.root).toBe(join(sb.dir, "games", "mods", "vampire-survivors", "FouetPlusFort"));
    expect(readFileSync(join(m.root, "FouetPlusFort.csproj"), "utf8")).toMatch(/<GameDir>.*Vampire Survivors<\/GameDir>/);
    expect(log(m.root)).toMatch(/mod: première version de « Fouet plus fort »[\s\S]*mod: gabarit/);
    expect(toolchain.builds).toHaveLength(1);

    // Installer : la DLL dans Mods/, rien d'autre.
    hub.mods.installMod(sb.human(), m0.id);
    m = hub.mods.get(m0.id);
    expect(existsSync(join(steam.game, "Mods", "FouetPlusFort.dll"))).toBe(true);
    expect(m.installed!.files.map((f) => f.path)).toEqual(["Mods/FouetPlusFort.dll"]);

    // Après une partie : une exception du mod dans le journal → correction, reconstruction, réinstallation.
    writeFileSync(
      join(steam.game, VAMPIRE_SURVIVORS.log),
      "[12:00:01.000] Game Version: 1.14\n[12:00:02.000] FouetPlusFort v1.0.0\n[12:00:02.100] [FouetPlusFort] FouetPlusFort chargé.\n[12:00:30.000] [ERROR] Exception in Harmony patch\nSystem.NullReferenceException\n  at FouetPlusFort.WhipPatch.Postfix()\n",
    );
    executor.scripts.execute.push(async (t, req) => {
      expect(req.prompt).toMatch(/NullReferenceException[\s\S]*WhipPatch/);
      await t.write("Mod.cs", "// patch du Fouet, corrigé\nclass Mod {}\n");
      return REPORT;
    });
    hub.mods.played(sb.human(), m0.id, "");
    await hub.mods.idle();
    m = hub.mods.get(m0.id);
    expect(m).toMatchObject({ status: "ready", version: 1, played: { loaded: true, gameVersion: "1.14" } });
    expect(readFileSync(join(steam.game, "Mods", "FouetPlusFort.dll"), "utf8")).toMatch(/dll \d+/);
    expect(m.installed!.files[0]!.sha256).not.toBe("");

    // Une partie sans erreur : « ça marche ».
    writeFileSync(join(steam.game, VAMPIRE_SURVIVORS.log), "FouetPlusFort v1.0.0\n[FouetPlusFort] FouetPlusFort chargé.\n");
    hub.mods.played(sb.human(), m0.id, "");
    expect(hub.mods.get(m0.id).events.at(-1)!.text).toMatch(/Ça marche/);

    // Une mise à jour du jeu : le mod est signalé, l'installation refusée tant qu'il n'est pas reconstruit.
    steam.update("101");
    m = hub.mods.get(m0.id);
    expect(m.outdated).toBe(true);
    hub.mods.rebuild(sb.human(), m0.id);
    await hub.mods.idle();
    expect(hub.mods.get(m0.id)).toMatchObject({ outdated: false, game_build: "101" });

    // Désinstaller : le dossier des mods revient comme avant.
    hub.mods.uninstallMod(sb.human(), m0.id);
    expect(existsSync(join(steam.game, "Mods", "FouetPlusFort.dll"))).toBe(false);
    expect(hub.mods.get(m0.id).installed).toBeNull();
  });

  it("une construction qui échoue est corrigée par le développeur (deux fois au plus)", async () => {
    const { sb, hub, orchestrator, executor, steam } = setup();
    hub.mods.installLoader(sb.human(), "1794680");
    await hub.mods.idle();
    mkdirSync(join(steam.game, "MelonLoader", "Il2CppAssemblies"), { recursive: true });
    writeFileSync(join(steam.game, VAMPIRE_SURVIVORS.loader.generatedMark), "asm");
    hub.mods.buildTypemap(sb.human(), "1794680");
    await hub.mods.idle();
    orchestrator.extractions.push(PLAN as never);
    const m0 = hub.mods.create(sb.human(), "1794680", "le fouet plus fort");
    await hub.mods.idle();
    executor.scripts.execute.push(async (t) => (await t.write("Mod.cs", "ERREUR"), REPORT));
    executor.scripts.execute.push(async (t, req) => {
      expect(req.prompt).toMatch(/CS0103/);
      await t.write("Mod.cs", "class Mod {}");
      return REPORT;
    });
    hub.mods.go(sb.human(), m0.id);
    await hub.mods.idle();
    expect(hub.mods.get(m0.id).status).toBe("ready");
    expect(hub.mods.get(m0.id).events.some((e) => /La construction échoue[\s\S]*CS0103/.test(e.text))).toBe(true);
  });

  it("les sprites : le générateur les dessine dans le style du jeu avant le code, ils s'installent avec le mod, « Redessiner » les refait", async () => {
    const { sb, hub, orchestrator, executor, steam, gen } = setup({ generator: true });
    hub.mods.installLoader(sb.human(), "1794680");
    await hub.mods.idle();
    mkdirSync(join(steam.game, "MelonLoader", "Il2CppAssemblies"), { recursive: true });
    writeFileSync(join(steam.game, VAMPIRE_SURVIVORS.loader.generatedMark), "asm");
    hub.mods.buildTypemap(sb.human(), "1794680");
    await hub.mods.idle();
    orchestrator.extractions.push({ ...PLAN, title: "Fouet rouge", kind: "apparence", visuals: [{ file: "Fouet Rouge!", description: "a crimson leather whip", size: 30 }] } as never);
    const m0 = hub.mods.create(sb.human(), "1794680", "un fouet rouge sang");
    await hub.mods.idle();
    expect(hub.mods.get(m0.id).plan!.visuals).toEqual([{ file: "fouet-rouge.png", description: "a crimson leather whip", size: 32 }]);
    executor.scripts.execute.push(async (t, req) => {
      expect(req.prompt).toMatch(/fouet-rouge\.png \(32×32 px, fond magenta[\s\S]*ModsDirectory, "FouetRouge", "fichier\.png"/);
      await t.write("Mod.cs", "// charge le sprite\n");
      return REPORT;
    });
    hub.mods.go(sb.human(), m0.id);
    await hub.mods.idle();
    let m = hub.mods.get(m0.id);
    expect(m.status).toBe("ready");
    expect(gen.requests[0]).toMatchObject({ width: 1024, height: 1024, scale: { width: 32, height: 32 } });
    expect(gen.requests[0]!.prompt).toMatch(/Vampire Survivors[\s\S]*magenta[\s\S]*Subject: a crimson leather whip/);
    expect(m.assets).toEqual(["fouet-rouge.png"]);
    expect(hub.mods.assetPath(m0.id, "fouet-rouge.png")).toMatch(/assets[\\/]fouet-rouge\.png$/);
    expect(() => hub.mods.assetPath(m0.id, "../FouetRouge.csproj")).toThrow(/refusé/);

    hub.mods.installMod(sb.human(), m0.id);
    expect(hub.mods.get(m0.id).installed!.files.map((f) => f.path).sort()).toEqual(["Mods/FouetRouge.dll", "Mods/FouetRouge/fouet-rouge.png"]);
    await hub.mods.redraw(sb.human(), m0.id, "fouet-rouge.png", "plus sombre");
    expect(gen.requests.at(-1)!.prompt).toMatch(/a crimson leather whip\. plus sombre/);
    m = hub.mods.get(m0.id);
    expect(readFileSync(join(steam.game, "Mods", "FouetRouge", "fouet-rouge.png")).length).toBeGreaterThan(0);
    hub.mods.uninstallMod(sb.human(), m0.id);
    expect(existsSync(join(steam.game, "Mods", "FouetRouge"))).toBe(false);
    expect(existsSync(join(steam.game, "Mods"))).toBe(true);
  });

  it("le générateur réduit l'image au plus proche voisin, à la taille du sprite", () => {
    const g = fluxWorkflow({ prompt: "whip", width: 1024, height: 1024, seed: 1, scale: { width: 32, height: 32 } }) as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
    expect(g["11"]).toMatchObject({ class_type: "ImageScale", inputs: { upscale_method: "nearest-exact", width: 32, height: 32, image: ["7", 0] } });
    expect(g["8"]!.inputs.images).toEqual(["11", 0]);
    expect((fluxWorkflow({ prompt: "x", width: 512, height: 512, seed: 1 }) as Record<string, unknown>)["11"]).toBeUndefined();
  });

  it("refuse un jeu protégé par un anti-triche", async () => {
    const { sb, hub } = setup({ protected: true });
    expect(hub.mods.games()[0]).toMatchObject({ protection: expect.any(String), toolchain: null });
    expect(() => hub.mods.create(sb.human(), "1794680", "un mod")).toThrow(/protégé/);
  });

  it("le journal : chargé ou pas, et seulement les erreurs du mod", () => {
    const { sb } = setup();
    const f = join(sb.dir, "Latest.log");
    writeFileSync(f, "Game Version: 1.14\nAutreMod v2.0\n[ERROR] Exception\n  at AutreMod.Patch()\nFouetPlusFort v1.0.0\n[FouetPlusFort] prêt\n");
    expect(readLog(f, "FouetPlusFort")).toMatchObject({ found: true, loaded: true, errors: [], lines: ["[FouetPlusFort] prêt"], gameVersion: "1.14" });
    expect(readLog(join(sb.dir, "absent.log"), "X").found).toBe(false);
  });
});
