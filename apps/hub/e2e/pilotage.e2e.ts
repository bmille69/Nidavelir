/**
 * Le poste de pilotage (refonte du 23/10/2026), dans un vrai navigateur (Edge) : le chantier en cours et sa barre de
 * progression, la file, les visuels liés, la galerie et son visualiseur ; sur téléphone, la discussion sans le bandeau.
 */
import type { FastifyInstance } from "fastify";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PENDING_VISUALS, readManifest, writeManifest } from "../src/art/manifest.ts";
import { createHub, type Hub } from "../src/hub.ts";
import { summarize } from "../src/godot/sim.ts";
import { buildServer } from "../src/server/http.ts";
import { FakeOrchestrator } from "../test/fake-orchestrator.ts";
import { FakeExecutor } from "../test/fake-executor.ts";
import { cleanupSandboxes, sandbox, type Sandbox } from "../test/helpers.ts";

const PORT = 4403;
const BASE = `http://127.0.0.1:${PORT}`;
const webDist = process.env.STUDIO_WEB_DIST ?? resolve(fileURLToPath(new URL("../../web/dist", import.meta.url)));
const shots = process.env.STUDIO_SCREENSHOTS ?? join(process.cwd(), ".data", "screenshots");
const P = "destiny";

/** Une vraie image PNG en dégradé, pour que la galerie ait quelque chose à montrer. */
function png(w: number, h: number, [r, g, b]: [number, number, number]): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const x of buf) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const k = y * (w * 3 + 1) + 1 + x * 3;
      const t = 0.55 + 0.45 * (1 - y / h);
      raw.set([r * t, g * t, b * t].map(Math.round), k);
    }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

let sb: Sandbox;
let hub: Hub;
let app: FastifyInstance;
let browser: Browser;
let page: Page;
const errors: string[] = [];
const fake = new FakeOrchestrator();

beforeAll(async () => {
  mkdirSync(shots, { recursive: true });
  sb = sandbox();
  sb.hub.close();
  hub = createHub({
    databasePath: join(sb.dir, "hub/.data/pilot.db"),
    registry: { forbiddenTrees: [join(sb.dir, "hub")], forbiddenExact: [sb.dir] },
    orchestrator: fake,
    executor: new FakeExecutor(),
    dataDir: join(sb.dir, "hub/.data"),
    autopilot: { synthesisDelayMs: 600_000 },
  });
  sb.hub = hub;
  const repo = sb.makeGameRepo("games/destiny", { "README.md": "# Destiny Survivor\n" });
  await hub.projects.register(sb.human(), { path: repo, slug: P, name: "Destiny Survivor" });
  hub.projects.setAutonomy(sb.human(), P, "workshop");
  hub.art.paused = () => true;
  fake.replies.push(
    '[[ASSET]] {"name": "Kit village", "type": "décor", "usage": "îlots du Village", "specs": ""} [[/ASSET]]\n[[ASSET]] {"name": "Horizon peint", "type": "texture", "usage": "ciel", "specs": ""} [[/ASSET]]\n[[ASSET]] {"name": "Gardien Titan", "type": "personnage", "usage": "joueur", "specs": ""} [[/ASSET]]',
  );
  hub.art.send(sb.human(), P, "La carte");
  await hub.art.idle();
  // Des images dans la galerie : le Titan a son image et ses photos 3D, il est dans le jeu.
  const art = join(repo, "studio", "art", "production");
  mkdirSync(art, { recursive: true });
  const files = { "titan.png": [120, 140, 190], "titan-3d-face.png": [150, 120, 90], "titan-3d-dos.png": [90, 130, 110], "village.png": [170, 150, 120] } as const;
  for (const [f, c] of Object.entries(files)) writeFileSync(join(art, f), png(320, 320, c as unknown as [number, number, number]));
  const m = readManifest(repo);
  const titan = m.assets.find((a) => a.name === "Gardien Titan")!;
  titan.status = "integre";
  titan.renders = ["production/titan.png"];
  titan.model = { file: "models/titan.glb", source: "production/titan.png", renders: ["production/titan-3d-face.png", "production/titan-3d-dos.png"], tris: 18000, dims: [1, 1, 1.8], animations: ["idle"], verdict: { ok: true, summary: "Fidèle, prêt pour le jeu.", points: [], prompt: null, file: "models/titan.glb", by: "validator", at: "2026-10-22T10:00:00.000Z" } } as never;
  const village = m.assets.find((a) => a.name === "Kit village")!;
  village.status = "valide";
  village.renders = ["production/village.png"];
  // Le bilan (ADR-71) : le modèle du Titan est copié tel quel dans le jeu ; l'horizon, donné pour intégré, n'y est pas.
  mkdirSync(join(art, "..", "models"), { recursive: true });
  writeFileSync(join(art, "..", "models", "titan.glb"), Buffer.from("glTF titan"));
  mkdirSync(join(repo, "assets", "studio"), { recursive: true });
  writeFileSync(join(repo, "assets", "studio", "guardian_titan.glb"), Buffer.from("glTF titan"));
  writeFileSync(join(art, "horizon.png"), png(320, 120, [200, 160, 110]));
  const horizon = m.assets.find((a) => a.name === "Horizon peint")!;
  horizon.status = "integre";
  horizon.renders = ["production/horizon.png"];
  horizon.verdict = { ok: true, summary: "Bien.", points: [], prompt: null, file: "production/horizon.png", by: "validator", at: "2026-10-22T10:00:00.000Z" };
  writeManifest(repo, m);

  const thread = hub.conversations.createThread(P, "Refonte de la carte").id;
  const make = (title: string, goal: string) => hub.tasks.createFromConversation(P, { title, goal }, thread);
  const set = (id: string, patch: Record<string, string | boolean>, status?: string) => {
    for (const [k, v] of Object.entries(patch)) hub.db.prepare(`UPDATE tasks SET data_json = json_set(data_json, '$.${k}', json(?)) WHERE id = ?`).run(JSON.stringify(v), id);
    if (status) hub.db.prepare("UPDATE tasks SET status = ?, data_json = json_set(data_json, '$.status', ?) WHERE id = ?").run(status, status, id);
  };
  const running = make("Occlusion ambiante (gros)", `Objectif : l'occlusion.\n\n${PENDING_VISUALS} :\n- A-0001 « Kit village » (décor) : îlots`);
  set(running.id, { direct: true }, "running");
  const sky = make("Ciel : dôme et horizon", `Objectif : le ciel.\n\n${PENDING_VISUALS} :\n- A-0002 « Horizon peint » (texture) : ciel`);
  set(sky.id, { queued_at: "2026-10-22T10:00:01.000Z" });
  const done = make("Rampes lisibles", "Objectif : les rampes.");
  set(done.id, {}, "merged");
  app = await buildServer(hub, { port: PORT, gamesRoot: join(sb.dir, "games"), allowedHosts: [`127.0.0.1:${PORT}`], folderPicker: { pick: async () => null }, webDist });
  await app.listen({ host: "127.0.0.1", port: PORT });
  browser = await chromium.launch({ channel: "msedge", headless: true });
  page = await browser.newPage({ viewport: { width: 1400, height: 900 }, locale: "fr-FR" });
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${BASE}/login?token=${hub.sessions.createLoginToken()}`);
});

afterAll(async () => {
  await browser?.close();
  await app?.close();
  await hub?.art.idle();
  await hub?.conversations.idle();
  await hub?.tasks.idle();
  cleanupSandboxes();
});

describe("poste de pilotage", () => {
  it("chantier en cours avec sa barre, file, visuels liés, galerie et visualiseur ; discussion du téléphone sans bandeau", async () => {
    await page.goto(`${BASE}/#/pilotage`);
    const big = page.locator(".pilot-card.big").first();
    await big.waitFor({ timeout: 15_000 });
    await expect(big.textContent()).resolves.toMatch(/Occlusion ambiante[\s\S]*≈ \d+ %/);
    expect(await big.locator(".progress span").getAttribute("style")).toMatch(/width: \d+%/);
    await expect(page.locator(".pilot-col").first().textContent()).resolves.toMatch(/À suivre[\s\S]*Ciel : dôme et horizon[\s\S]*Fusionnés récemment[\s\S]*Rampes lisibles/);
    // Le lien : survoler le visuel du chantier en cours allume le chantier, éteint les autres.
    await big.locator(".link-chip", { hasText: "A-0001" }).hover();
    expect(await big.getAttribute("class")).toMatch(/\blit\b/);
    await page.mouse.move(5, 5);
    await page.screenshot({ path: join(shots, "pilot-1-production.png") });

    await page.locator(".pilot-head .segmented button", { hasText: "Galerie" }).click();
    await page.locator(".gallery-card").first().waitFor();
    expect(await page.locator(".gallery-card").count()).toBe(3);
    await page.screenshot({ path: join(shots, "pilot-2-galerie.png") });
    await page.locator(".gallery-card", { hasText: "Gardien Titan" }).click();
    const viewer = page.locator(".viewer");
    await expect(viewer.locator(".viewer-caption").textContent()).resolves.toMatch(/Modèle 3D · 3\/3/);
    await page.keyboard.press("ArrowLeft");
    await expect(viewer.locator(".viewer-caption").textContent()).resolves.toMatch(/Modèle 3D · 2\/3/);
    await page.keyboard.press("ArrowLeft");
    await expect(viewer.locator(".viewer-caption").textContent()).resolves.toMatch(/Image · 1\/3/);
    await expect(viewer.textContent()).resolves.toMatch(/Fidèle, prêt pour le jeu/);
    await page.screenshot({ path: join(shots, "pilot-3-visualiseur.png") });
    await page.keyboard.press("Escape");
    expect(await viewer.count()).toBe(0);

    // Le bilan des visuels (ADR-71) : le problème d'abord, avec sa réparation ; le Titan copié mais pas encore prouvé.
    await page.locator(".pilot-head .segmented button", { hasText: "Bilan" }).click();
    await page.locator(".bilan-row").first().waitFor();
    await expect(page.locator(".bilan-row").first().textContent()).resolves.toMatch(/Horizon peint[\s\S]*Absent du jeu[\s\S]*Faire réintégrer/);
    await expect(page.locator(".bilan-row").nth(1).textContent()).resolves.toMatch(/Gardien Titan[\s\S]*assets\/studio\/guardian_titan\.glb[\s\S]*Pas vérifié/);
    expect(await page.locator(".pilot-head .segmented button.on").textContent()).toBe("Bilan");
    await page.screenshot({ path: join(shots, "pilot-9-bilan.png") });

    // L'équilibreur (ADR-86) : deux passages, le dernier comparé au précédent.
    writeFileSync(join(hub.projects.get(P).root, "project.godot"), "config_version=5\n");
    mkdirSync(join(hub.projects.get(P).root, "tests", "sims"), { recursive: true });
    const runs = (shift: number) =>
      Array.from({ length: 200 }, (_, i) => ({ vague_atteinte: 5 + ((i * 7 + shift) % 6), victoire: (i + shift) % 3 === 0, or_final: 150 + ((i * 13) % 200) + shift * 20, cause: i % 3 ? "fuite" : "boss" }));
    for (const shift of [0, 2]) {
      hub.db
        .prepare("INSERT INTO sim_runs (project, at, commit_sha, runs, status, data_json) VALUES (?, ?, ?, 200, 'done', ?)")
        .run(P, `2026-10-27T1${shift}:00:00.000Z`, `abc123${shift}`.padEnd(40, "0"), JSON.stringify([{ name: "res://tests/sims/sim_vagues.gd", runs: 200, seconds: 0.4, seed: 1, metrics: summarize(runs(shift)) }]));
    }
    await page.locator(".pilot-head .segmented button", { hasText: "Équilibrage" }).click();
    await page.locator(".sim-card").first().waitFor();
    await expect(page.locator(".sim-card").first().textContent()).resolves.toMatch(/sim_vagues\.gd[\s\S]*200 parties[\s\S]*or_final[\s\S]*victoire/);
    expect(await page.locator(".sim-hist span").count()).toBeGreaterThan(3);
    await page.screenshot({ path: join(shots, "pilot-11-equilibrage.png"), fullPage: true });

    // Le banc d'essai (ADR-87) : deux références, deux passages, le dernier avec un raté.
    const res = (c: string, ok: boolean, cost: number) => ({ case: c, ok, outcome: ok ? "completed" : "partial", summary: ok ? "Fait." : "Les tests cassent.", error: null, tests: ok ? "pass" : "fail", launch: "pass", replays: null, costUsd: cost, tokens: 90000, model: "claude", seconds: 420, files: 3 });
    for (const [i, c] of [["BC-01-T-0001", "Boss au minuteur"], ["BC-02-T-0002", "Vagues plus denses"]] as const)
      hub.db.prepare("INSERT INTO bench_cases (project, id, source_task, title, goal, base_commit, original_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(P, i, i.slice(6), c, c, "0".repeat(40), JSON.stringify({ costUsd: 1.2, seconds: 600, files: null }), "2026-10-20T10:00:00.000Z");
    hub.db.prepare("INSERT INTO bench_runs (project, at, fingerprint, status, results_json) VALUES (?, ?, ?, 'done', ?)").run(P, "2026-10-25T09:00:00.000Z", "aaaaaaaaaaaa", JSON.stringify([res("BC-01-T-0001", true, 1.1), res("BC-02-T-0002", true, 1.4)]));
    hub.db.prepare("INSERT INTO bench_runs (project, at, fingerprint, status, results_json) VALUES (?, ?, ?, 'done', ?)").run(P, "2026-10-27T09:00:00.000Z", "bbbbbbbbbbbb", JSON.stringify([res("BC-01-T-0001", true, 0.9), res("BC-02-T-0002", false, 2.1)]));
    await page.locator(".pilot-head .segmented button", { hasText: "Banc d'essai" }).click();
    await page.locator(".bench-table tbody tr").first().waitFor();
    await expect(page.locator(".bench-total").textContent()).resolves.toMatch(/1\/2 réussis[\s\S]*2\/2 réussis/);
    await expect(page.locator(".balance").textContent()).resolves.toMatch(/plus à jour/);
    await page.screenshot({ path: join(shots, "pilot-12-banc.png"), fullPage: true });

    // La passe game feel (ADR-88) : le formulaire, sous les chantiers.
    await page.locator(".pilot-head .segmented button", { hasText: "Production" }).click();
    await page.locator(".pilot-feel-open").click();
    await page.locator(".pilot-feel input").fill("la mort des bandits");
    await page.locator(".pilot-feel").screenshot({ path: join(shots, "pilot-13-game-feel.png") });

    // Le journal de bord (ADR-89) : une fusion et un visuel intégré cette semaine, puis le récit du directeur.
    const merged = hub.tasks.list(P).find((t) => t.status === "merged")!;
    hub.journal.append({ project: P, actor: { kind: "system" }, type: "task.merged", subject: merged.id, payload: {} });
    const titan = hub.art.state(P).assets.find((a) => a.name === "Gardien Titan")!;
    hub.journal.append({ project: P, actor: { kind: "system" }, type: "art.asset_integrated", subject: titan.id, payload: { task: merged.id } });
    await page.locator(".pilot-head .segmented button", { hasText: "Journal" }).click();
    await page.locator(".logbook-entry").first().waitFor();
    expect(await page.locator(".logbook-entry").count()).toBe(2);
    await expect(page.locator(".logbook").textContent()).resolves.toMatch(/Rampes lisibles[\s\S]*Visuel « Gardien Titan » intégré/);
    fake.replies.push("Les rampes se lisent enfin, et le Titan est dans le jeu.\nLa semaine prochaine : le ciel.");
    await page.locator(".logbook-story button").click();
    await page.locator(".logbook-text").waitFor();
    await page.screenshot({ path: join(shots, "pilot-14-journal.png"), fullPage: true });

    // Le directeur sonore (ADR-91) : sans clé, le champ de la clé ; trois sons à des étapes différentes.
    const snd = (id: string, name: string, kind: string, status: string, extra: Record<string, unknown> = {}) => ({ id, name, kind, usage: "à chaque tir d'une tourelle", prompt: "short gatling burst, electric crackle", seconds: kind === "musique" ? 60 : 0.6, loop: kind === "musique", status, takes: [], chosen: null, path: null, task: null, note: null, ...extra });
    const repo = hub.projects.get(P).root;
    mkdirSync(join(repo, "studio", "sound"), { recursive: true });
    writeFileSync(
      join(repo, "studio", "sound", "sounds.json"),
      JSON.stringify({
        sounds: [
          snd("S-0001", "Tir de tourelle", "effet", "a_choisir", { takes: [{ file: "S-0001-1.mp3", at: "2026-10-27T10:00:00.000Z", bytes: 9000, credits: 48 }, { file: "S-0001-2.mp3", at: "2026-10-27T10:00:05.000Z", bytes: 9000, credits: 48 }], chosen: "S-0001-2.mp3" }),
          snd("S-0002", "Thème du saloon", "musique", "integre", { path: "assets/audio/musique/theme_du_saloon.mp3", task: "T-0009" }),
          snd("S-0003", "Clic de menu", "interface", "non_branche", { task: "T-0009", note: "copié dans le jeu, mais aucun script ni scène ne le joue" }),
        ],
      }),
    );
    await page.locator(".pilot-head .segmented button", { hasText: "Son" }).click();
    await page.locator(".sound-card").first().waitFor();
    expect(await page.locator(".sound-card").count()).toBe(3);
    expect(await page.locator(".sound-key input[type=password]").count()).toBe(1);
    await page.screenshot({ path: join(shots, "pilot-15-son.png"), fullPage: true });

    // L'accueil et le projet avec le nouveau style.
    await page.goto(`${BASE}/#/`);
    await page.waitForTimeout(800);
    await page.screenshot({ path: join(shots, "pilot-4-accueil.png") });
    await page.goto(`${BASE}/#/p/${P}`);
    await page.locator(".project-monitor .monitor").waitFor();
    await page.screenshot({ path: join(shots, "pilot-5-projet.png") });

    // Téléphone : la discussion garde l'écran, le moniteur tient dans une pastille qui ouvre une feuille.
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: "fr-FR", isMobile: true, hasTouch: true });
    phone.on("pageerror", (e) => errors.push(e.message));
    await phone.goto(`${BASE}/login?token=${hub.sessions.createLoginToken()}`);
    await phone.goto(`${BASE}/#/p/${P}`);
    const pill = phone.locator(".monitor-pill");
    await pill.waitFor();
    expect(await phone.locator(".project-monitor").isVisible()).toBe(false);
    expect(await phone.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")).toBe(true);
    await phone.screenshot({ path: join(shots, "pilot-6-telephone-discussion.png") });
    await pill.tap();
    await phone.locator(".sheet .monitor").waitFor();
    await phone.screenshot({ path: join(shots, "pilot-7-telephone-moniteur.png") });
    await phone.goto(`${BASE}/#/pilotage`);
    await phone.locator(".pilot-card.big").first().waitFor();
    expect(await phone.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")).toBe(true);
    await phone.screenshot({ path: join(shots, "pilot-8-telephone-pilotage.png"), fullPage: true });
    await phone.locator(".pilot-head .segmented button", { hasText: "Bilan" }).tap();
    await phone.locator(".bilan-row").first().waitFor();
    expect(await phone.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")).toBe(true);
    await phone.screenshot({ path: join(shots, "pilot-10-telephone-bilan.png"), fullPage: true });
    await phone.close();
    expect(errors).toEqual([]);
  }, 90_000);
});
