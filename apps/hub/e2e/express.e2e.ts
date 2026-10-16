/**
 * Le Jeu express dans un vrai navigateur (Edge), avec une IA factice mais le VRAI testeur du hub (ADR-44) :
 * lancer une idée, suivre l'écran en direct, jouer dans le studio, améliorer, en faire un projet ; sur téléphone aussi.
 * Le modèle de départ 3D (Three.js fourni par le hub) se charge sans erreur.
 */
import type { FastifyInstance } from "fastify";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RealExpressChecker } from "../src/express/checker.ts";
import { writeTemplate } from "../src/express/template.ts";
import { createHub, type Hub } from "../src/hub.ts";
import { buildServer } from "../src/server/http.ts";
import { FakeExecutor } from "../test/fake-executor.ts";
import { FakeOrchestrator } from "../test/fake-orchestrator.ts";
import { cleanupSandboxes, fakeClock, sandbox, type Sandbox } from "../test/helpers.ts";

const PORT = 4396;
const BASE = `http://127.0.0.1:${PORT}`;
const webDist = process.env.STUDIO_WEB_DIST ?? resolve(fileURLToPath(new URL("../../web/dist", import.meta.url)));
const shots = process.env.STUDIO_SCREENSHOTS ?? join(process.cwd(), ".data", "screenshots");

const CONCEPT = {
  title: "Serpent Stellaire",
  pitch: "Un serpent de lumière avale des étoiles sans se mordre la queue.",
  dimension: "2d",
  genre: "arcade",
  controls: ["Flèches : tourner", "Entrée : commencer"],
  loop: "Avaler des étoiles, grandir.",
  goal: "Score, vitesse croissante.",
  style: "Néon : #05060a, #7df0ff, #ff4fd8, #ffe066",
  features: ["Déplacement", "Étoiles"],
  juice: [],
};

/** Un petit « jeu » réel : un canvas animé, sans erreur. */
const GAME = (label: string) => `const c = document.getElementById("game"); const x = c.getContext("2d");
let t = 0;
function frame() { c.width = innerWidth; c.height = innerHeight; t += 0.03;
  x.fillStyle = "#05060a"; x.fillRect(0, 0, c.width, c.height);
  x.fillStyle = "#7df0ff"; x.beginPath(); x.arc(c.width / 2 + Math.cos(t) * 120, c.height / 2 + Math.sin(t) * 80, 24, 0, 7); x.fill();
  x.fillStyle = "#ffe066"; x.font = "bold 28px system-ui"; x.textAlign = "center"; x.fillText(${JSON.stringify(label)}, c.width / 2, 60);
  requestAnimationFrame(frame); }
frame();
`;

let sb: Sandbox;
let hub: Hub;
let app: FastifyInstance;
let browser: Browser;
let page: Page;
const errors: string[] = [];

beforeAll(async () => {
  mkdirSync(shots, { recursive: true });
  sb = sandbox();
  sb.hub.close();
  const orchestrator = new FakeOrchestrator();
  orchestrator.extractions.push(CONCEPT as never);
  const executor = new FakeExecutor();
  executor.scripts.execute.push(
    async (t) => {
      await new Promise((r) => setTimeout(r, 1500)); // le temps de voir l'écran en direct
      await t.write("src/main.js", GAME("SERPENT STELLAIRE"));
      return { summary: "Le serpent tourne et brille.", how_to_play: "Flèches pour tourner.", known_issues: [] };
    },
    async (t) => (await t.write("src/main.js", GAME("BOSS EN APPROCHE")), { summary: "Un boss arrive.", how_to_play: "Flèches pour tourner.", known_issues: [] }),
  );
  hub = createHub({
    databasePath: join(sb.dir, "hub/.data/express.db"),
    registry: { forbiddenTrees: [join(sb.dir, "hub")], forbiddenExact: [sb.dir] },
    clock: fakeClock(),
    orchestrator,
    executor,
    dataDir: join(sb.dir, "hub/.data"),
    expressChecker: new RealExpressChecker(),
  });
  sb.hub = hub;
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
  await hub?.express.idle();
  await hub?.conversations.idle();
  cleanupSandboxes();
});

describe("jeu express", () => {
  it("de l'idée au jeu jouable, puis amélioré et devenu projet", async () => {
    await page.locator(".side-nav a", { hasText: "Jeu express" }).click();
    await page.getByRole("heading", { name: /Une idée, quelques minutes/ }).waitFor();
    await page.getByRole("button", { name: "Un serpent dans l'espace qui mange des étoiles" }).click();
    await page.screenshot({ path: join(shots, "express-1-idee.png") });
    await page.getByRole("button", { name: /Lancer/ }).click();

    // L'écran en direct : chronomètre et étapes.
    await page.locator(".express-steps li.now").first().waitFor();
    await page.locator(".express-clock.on").waitFor();
    await page.screenshot({ path: join(shots, "express-2-direct.png") });

    // Jouable : le jeu tourne dans le studio, testé par le vrai navigateur du hub, sans erreur.
    await page.locator(".express-screen iframe").waitFor({ timeout: 30_000 });
    await page.getByText("Comment jouer :").waitFor();
    await expect(page.locator(".express-steps li.done").count()).resolves.toBe(4);
    const game = page.frameLocator(".express-screen iframe");
    await game.locator("canvas#game").waitFor();
    const g = hub.express.list()[0]!;
    expect(g).toMatchObject({ status: "ready", shot: true });
    expect(g.events.map((e) => e.text).join("\n")).toMatch(/sans erreur/);
    await page.waitForTimeout(500);
    await page.screenshot({ path: join(shots, "express-3-jouable.png") });

    // Améliorer d'une phrase.
    await page.getByLabel("Amélioration").fill("ajoute un boss toutes les 30 secondes");
    await page.getByRole("button", { name: /Améliorer/ }).click();
    await page.getByText(/version 2/).waitFor({ timeout: 30_000 });
    await page.locator(".express-screen iframe").waitFor({ timeout: 30_000 });

    // La galerie le garde, avec sa capture.
    await page.goto(`${BASE}/#/express`);
    await page.locator(".express-tile", { hasText: "Serpent Stellaire" }).locator("img").waitFor();
    await page.screenshot({ path: join(shots, "express-4-galerie.png") });

    // En faire un vrai projet du studio.
    await page.locator(".express-tile", { hasText: "Serpent Stellaire" }).click();
    await page.getByRole("button", { name: /En faire un vrai projet/ }).click();
    await page.waitForURL(/#\/p\/serpent-stellaire\/t\//);
    await page.getByText(/vient du Jeu express/).first().waitFor();
    expect(errors).toEqual([]);
  }, 90_000);

  it("sur téléphone, l'écran du jeu", async () => {
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: "fr-FR", isMobile: true, hasTouch: true });
    phone.on("pageerror", (e) => errors.push(e.message));
    await phone.goto(`${BASE}/login?token=${hub.sessions.createLoginToken()}`);
    await phone.goto(`${BASE}/#/express/${hub.express.list()[0]!.id}`);
    await phone.locator(".express-screen iframe").waitFor();
    expect(await phone.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")).toBe(true);
    await phone.screenshot({ path: join(shots, "express-5-telephone.png"), fullPage: true });
    await phone.close();
    expect(errors).toEqual([]);
  });

  it("le modèle de départ 3D charge Three.js sans erreur", async () => {
    const root = join(sb.dir, "modele-3d");
    writeTemplate(root, { ...CONCEPT, dimension: "3d" } as never);
    // Un vrai petit usage de Three.js et d'un module additionnel, comme le ferait le développeur.
    const { writeFileSync } = await import("node:fs");
    writeFileSync(
      join(root, "src", "main.js"),
      `import * as THREE from "three";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
const r = new THREE.WebGLRenderer({ canvas: document.getElementById("game") });
const s = new THREE.Scene(); const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 100); cam.position.z = 3;
s.add(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshNormalMaterial()));
console.log(typeof UnrealBloomPass);
r.render(s, cam);
`,
    );
    const check = await new RealExpressChecker().check(root, join(shots, "express-6-modele-3d.png"));
    expect(check).toMatchObject({ ok: true, errors: [] });
  }, 60_000);
});
