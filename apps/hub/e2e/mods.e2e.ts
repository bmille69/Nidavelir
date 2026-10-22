/**
 * Le studio de modding (ADR-65) dans un vrai navigateur (Edge) : vos jeux, l'outillage en étapes, une idée, le plan à
 * valider, la fabrication, l'installation. Faux Steam, faux outillage, faux développeur.
 */
import type { FastifyInstance } from "fastify";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHub, type Hub } from "../src/hub.ts";
import type { GameRecipe } from "../src/mods/recipes.ts";
import type { RunResult, ToolchainPort, ToolchainState } from "../src/mods/toolchain.ts";
import { buildServer } from "../src/server/http.ts";
import { FakeExecutor } from "../test/fake-executor.ts";
import { FakeOrchestrator } from "../test/fake-orchestrator.ts";
import { cleanupSandboxes, sandbox, type Sandbox } from "../test/helpers.ts";
import { deflateSync } from "node:zlib";
import type { GenRequest, GenState, ImageGenPort } from "../src/art/imagegen.ts";

/** Un petit sprite de test : une croix rouge sombre sur fond magenta, à la taille demandée. */
function sprite(size: number): Buffer {
  const crc = (buf: Buffer) => {
    let c = ~0;
    for (const x of buf) {
      c ^= x;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const rows = Array.from({ length: size }, (_, y) =>
    Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: size }, (_, x) => (Math.abs(x - y) < 3 || Math.abs(x + y - size) < 3 ? [150, 20, 30] : [255, 0, 255])).flat())]),
  );
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(rows))), chunk("IEND", Buffer.alloc(0))]);
}

class Gen implements ImageGenPort {
  state(): GenState {
    return { installed: true, installing: null, error: null, size: "≈ 19 Go", kontext: { installed: false, installing: null, error: null, size: "" } };
  }
  install() {}
  installKontext() {}
  async generate(req: GenRequest) {
    return sprite(req.scale?.width ?? 32);
  }
  close() {}
}

const PORT = 4403;
const BASE = `http://127.0.0.1:${PORT}`;
const webDist = process.env.STUDIO_WEB_DIST ?? resolve(fileURLToPath(new URL("../../web/dist", import.meta.url)));
const shots = process.env.STUDIO_SCREENSHOTS ?? join(process.cwd(), ".data", "screenshots");

let sb: Sandbox;
let hub: Hub;
let app: FastifyInstance;
let browser: Browser;
let page: Page;
const errors: string[] = [];
const fake = new FakeOrchestrator();
const exec = new FakeExecutor();
let gameDir = "";

class Tools implements ToolchainPort {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }
  state(r: GameRecipe, g: string): ToolchainState {
    return {
      dotnet: { installed: true, version: "9.0.300" },
      loader: { installed: existsSync(join(g, r.loader.installedMark)), version: r.loader.version, generated: existsSync(join(g, r.loader.generatedMark)), installing: false, error: null },
      typemap: { ready: existsSync(join(this.typemapDir(r), "carte-types.txt")), types: 1842, building: false, error: null },
    };
  }
  async installLoader(r: GameRecipe, g: string) {
    mkdirSync(join(g, "MelonLoader", "net6"), { recursive: true });
    writeFileSync(join(g, r.loader.installedMark), "ml");
    // Le « premier lancement » est simulé tout de suite.
    mkdirSync(join(g, "MelonLoader", "Il2CppAssemblies"), { recursive: true });
    writeFileSync(join(g, r.loader.generatedMark), "asm");
  }
  async removeLoader() {}
  typemapDir(r: GameRecipe) {
    return join(this.dir, r.id, "carte");
  }
  async buildTypemap(r: GameRecipe) {
    mkdirSync(this.typemapDir(r), { recursive: true });
    writeFileSync(join(this.typemapDir(r), "carte-types.txt"), "Whip\n");
  }
  async build(r: GameRecipe, modDir: string): Promise<RunResult> {
    const proj = readdirSync(modDir).find((f) => f.endsWith(".csproj"))!;
    const name = /AssemblyName>(\w+)</.exec(readFileSync(join(modDir, proj), "utf8"))![1]!;
    mkdirSync(join(modDir, "bin", "Release"), { recursive: true });
    writeFileSync(join(modDir, r.output(name)), "dll");
    return { code: 0, out: "ok" };
  }
}

beforeAll(async () => {
  mkdirSync(shots, { recursive: true });
  sb = sandbox();
  sb.hub.close();
  const lib = join(sb.dir, "Lib");
  gameDir = join(lib, "steamapps", "common", "Vampire Survivors");
  mkdirSync(gameDir, { recursive: true });
  for (const f of ["VampireSurvivors.exe", "GameAssembly.dll"]) writeFileSync(join(gameDir, f), "x");
  hub = createHub({
    databasePath: join(sb.dir, "hub/.data/mods.db"),
    registry: { forbiddenTrees: [join(sb.dir, "hub")], forbiddenExact: [sb.dir] },
    orchestrator: fake,
    executor: exec,
    dataDir: join(sb.dir, "hub/.data"),
    modToolchain: new Tools(join(sb.dir, "hub/.data/mods")),
    imagegen: new Gen(),
    steamGames: () => [
      { appid: "1794680", name: "Vampire Survivors", dir: gameDir, buildid: "100", library: lib },
      { appid: "1172470", name: "Apex Legends", dir: join(sb.dir, "apex"), buildid: "1", library: lib },
    ],
  });
  sb.hub = hub;
  hub.mods.saveEnv = {};
  app = await buildServer(hub, { port: PORT, gamesRoot: join(sb.dir, "games"), allowedHosts: [`127.0.0.1:${PORT}`], folderPicker: { pick: async () => null }, webDist });
  await app.listen({ host: "127.0.0.1", port: PORT });
  browser = await chromium.launch({ channel: "msedge", headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 950 }, locale: "fr-FR" });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/login?token=${hub.sessions.createLoginToken()}`);
});

afterAll(async () => {
  await browser?.close();
  await app?.close();
  await hub?.mods.idle();
  cleanupSandboxes();
});

describe("studio de modding (ADR-65)", () => {
  it("vos jeux, l'outillage en étapes, le plan, la fabrication et l'installation", async () => {
    await page.goto(`${BASE}/#/mods`);
    await page.locator(".mod-game-card h2", { hasText: "Vampire Survivors" }).waitFor({ timeout: 15_000 });
    await page.screenshot({ path: join(shots, "mods-1-outillage.png") });
    await page.getByRole("button", { name: /Installer MelonLoader/ }).click();
    await page.getByRole("button", { name: /Préparer la carte/ }).click();
    await page.locator(".mod-steps li.done").nth(3).waitFor();

    fake.extractions.push({
      title: "Fouet plus fort",
      summary: "Le Fouet frappe plus fort, réglable.",
      kind: "regles",
      changes: ["Fouet : +30 % de dégâts", "Fouet évolué (Bloody Tear) : +30 % aussi"],
      settings: [{ name: "Bonus", default: "30", description: "Bonus de dégâts en %" }],
      visuals: [{ file: "fouet-sang.png", description: "a blood red whip", size: 32 }, { file: "icone-fouet.png", description: "whip icon", size: 16 }],
      questions: [],
      risks: ["Une mise à jour du jeu peut casser le mod."],
    } as never);
    await page.getByLabel("Idée de mod").fill("le fouet fait 30% de dégâts en plus");
    await page.getByRole("button", { name: /Faire le plan du mod/ }).click();
    await page.waitForURL(/#\/mods\/\w+/);
    await page.getByRole("button", { name: "Fabriquer" }).waitFor();
    await page.screenshot({ path: join(shots, "mods-2-plan.png") });

    exec.scripts.execute.push(async (t) => {
      await t.write("Mod.cs", "// le Fouet\n");
      return { summary: "Le Fouet frappe 30 % plus fort.", how_to_test: "Prenez Antonio : ses coups de fouet affichent des dégâts plus élevés.", settings: ["Bonus (30)"], known_issues: [] };
    });
    await page.getByRole("button", { name: "Fabriquer" }).click();
    await page.getByRole("button", { name: /Installer dans le jeu/ }).waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: /Installer dans le jeu/ }).click();
    await page.getByRole("button", { name: /J'ai joué/ }).waitFor();
    expect(existsSync(join(gameDir, "Mods", "FouetPlusFort.dll"))).toBe(true);
    await page.screenshot({ path: join(shots, "mods-3-installe.png") });

    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: "fr-FR", isMobile: true, hasTouch: true });
    phone.on("pageerror", (e) => errors.push(e.message));
    await phone.goto(`${BASE}/login?token=${hub.sessions.createLoginToken()}`);
    await phone.goto(`${BASE}/#/mods`);
    await phone.locator(".mod-tile").first().waitFor();
    expect(await phone.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")).toBe(true);
    await phone.screenshot({ path: join(shots, "mods-4-telephone.png"), fullPage: true });
    await phone.close();
    expect(errors).toEqual([]);
  }, 60_000);
});
