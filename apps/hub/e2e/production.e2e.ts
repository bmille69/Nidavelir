/**
 * La chaîne de production, « À vous de jouer » et le moniteur (ADR-64), dans un vrai navigateur (Edge) : un chantier attend
 * votre mot, la file attend des visuels, une intégration passe devant, le DA attend votre réponse.
 */
import type { FastifyInstance } from "fastify";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PENDING_VISUALS } from "../src/art/manifest.ts";
import { createHub, type Hub } from "../src/hub.ts";
import { buildServer } from "../src/server/http.ts";
import { FakeOrchestrator } from "../test/fake-orchestrator.ts";
import { FakeExecutor } from "../test/fake-executor.ts";
import { cleanupSandboxes, sandbox, type Sandbox } from "../test/helpers.ts";

const PORT = 4402;
const BASE = `http://127.0.0.1:${PORT}`;
const webDist = process.env.STUDIO_WEB_DIST ?? resolve(fileURLToPath(new URL("../../web/dist", import.meta.url)));
const shots = process.env.STUDIO_SCREENSHOTS ?? join(process.cwd(), ".data", "screenshots");
const P = "destiny";

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
    databasePath: join(sb.dir, "hub/.data/prod.db"),
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
  // Le DA : deux fiches, une question en suspens.
  fake.replies.push(
    '[[ASSET]] {"name": "Kit village", "type": "décor", "usage": "îlots", "specs": ""} [[/ASSET]]\n[[ASSET]] {"name": "Horizon peint", "type": "texture", "usage": "ciel", "specs": ""} [[/ASSET]]\n[[CHOIX: Quelle lumière ?]] Dorée | Nuit [[/CHOIX]]',
  );
  hub.art.send(sb.human(), P, "La carte");
  await hub.art.idle();
  // Les chantiers : un qui attend votre mot (repris après un redémarrage), une intégration, deux en file avec visuels.
  const thread = hub.conversations.createThread(P, "Refonte de la carte").id;
  const make = (title: string, goal: string) => hub.tasks.createFromConversation(P, { title, goal }, thread);
  const set = (id: string, patch: Record<string, string | boolean>, status?: string) => {
    for (const [k, v] of Object.entries(patch)) hub.db.prepare(`UPDATE tasks SET data_json = json_set(data_json, '$.${k}', json(?)) WHERE id = ?`).run(JSON.stringify(v), id);
    if (status) hub.db.prepare("UPDATE tasks SET status = ?, data_json = json_set(data_json, '$.status', ?) WHERE id = ?").run(status, status, id);
  };
  const old = make("Marqueurs du Village", "Objectif : les marqueurs.");
  set(old.id, {}, "cancelled");
  const review = make("Marqueurs du Village", "Objectif : les marqueurs.");
  set(review.id, { direct: true }, "review");
  hub.journal.append({ project: P, actor: { kind: "system" }, type: "task.restarted", subject: review.id, payload: { interrupted: old.id } });
  const village = make("Habillage du Village", `Objectif : le village.\n\n${PENDING_VISUALS} :\n- A-0001 « Kit village » (décor) : îlots`);
  const sky = make("Ciel : dôme et horizon", `Objectif : le ciel.\n\n${PENDING_VISUALS} :\n- A-0002 « Horizon peint » (texture) : ciel`);
  const integ = make("A-0006 Kit béton", "Objectif : brancher A-0006.");
  set(village.id, { queued_at: "2026-10-22T10:00:00.000Z" });
  set(sky.id, { queued_at: "2026-10-22T10:00:01.000Z" });
  set(integ.id, { queued_at: "2026-10-22T11:00:00.000Z" });
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
  await hub?.art.idle();
  await hub?.conversations.idle();
  await hub?.tasks.idle();
  cleanupSandboxes();
});

describe("chaîne de production (ADR-64)", () => {
  it("la file dans son vrai ordre, les visuels attendus, « à vous de jouer » et le moniteur", async () => {
    await page.goto(`${BASE}/#/p/${P}`);
    const panel = page.locator(".workshop-panel");
    await panel.locator(".monitor .mon-tiles").waitFor({ timeout: 15_000 });
    const titles = await panel.locator(".workshop-list li strong").allTextContents();
    expect(titles).toEqual(["Marqueurs du Village", "A-0006 Kit béton", "Habillage du Village", "Ciel : dôme et horizon"]);
    await expect(panel.locator(".workshop-list li").first().textContent()).resolves.toMatch(/repris après un redémarrage \(ancien T-0001\)/);
    await expect(panel.locator(".workshop-list li").nth(2).textContent()).resolves.toMatch(/n° 2 dans la file[\s\S]*A-0001 · provisoire/);
    await page.screenshot({ path: join(shots, "prod-1-chantiers.png") });

    // « À vous de jouer » : le chantier qui attend votre mot et la question du DA.
    await page.locator(".for-you.floating .for-you-btn").click();
    const pop = page.locator(".for-you-pop");
    await expect(pop.textContent()).resolves.toMatch(/attend votre mot[\s\S]*Le Directeur artistique attend votre réponse/);
    await page.screenshot({ path: join(shots, "prod-2-a-vous.png") });
    await pop.locator("a", { hasText: "Directeur artistique" }).click();
    await page.waitForURL(/#\/p\/destiny\/art/);

    // Le moniteur du studio en direct.
    await page.goto(`${BASE}/#/direct`);
    await page.locator(".monitor .mon-tiles").waitFor();
    await page.screenshot({ path: join(shots, "prod-3-direct.png") });

    // Téléphone : la cloche dans la barre du haut.
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: "fr-FR", isMobile: true, hasTouch: true });
    phone.on("pageerror", (e) => errors.push(e.message));
    await phone.goto(`${BASE}/login?token=${hub.sessions.createLoginToken()}`);
    await phone.goto(`${BASE}/#/p/${P}/tasks`);
    await phone.locator(".mobile-bar .for-you-btn").click();
    await phone.locator(".for-you-pop").waitFor();
    expect(await phone.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")).toBe(true);
    await phone.screenshot({ path: join(shots, "prod-4-telephone.png") });
    await phone.close();
    expect(errors).toEqual([]);
  }, 60_000);
});
