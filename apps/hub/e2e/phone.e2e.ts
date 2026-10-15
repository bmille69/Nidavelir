/**
 * Le hub sur un téléphone (Edge en mode mobile) : code de connexion affiché sur le PC,
 * saisi sur le téléphone ; affichage mobile ; appareil déconnecté depuis le PC.
 */
import type { FastifyInstance } from "fastify";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHub, type Hub } from "../src/hub.ts";
import { buildServer } from "../src/server/http.ts";
import { FakeOrchestrator } from "../test/fake-orchestrator.ts";
import { cleanupSandboxes, sandbox, type Sandbox } from "../test/helpers.ts";

const PORT = 4401;
const BASE = `http://127.0.0.1:${PORT}`;
const webDist = process.env.STUDIO_WEB_DIST ?? resolve(fileURLToPath(new URL("../../web/dist", import.meta.url)));
const shots = process.env.STUDIO_SCREENSHOTS ?? join(process.cwd(), ".data", "screenshots");

let sb: Sandbox;
let hub: Hub;
let app: FastifyInstance;
let browser: Browser;
let pc: Page;
let phoneCtx: BrowserContext;
let phone: Page;
const errors: string[] = [];

const served = JSON.stringify({ Web: { "mon-pc.tail1234.ts.net:443": { Handlers: { "/": { Proxy: `http://127.0.0.1:${PORT}` } } } } });

beforeAll(async () => {
  mkdirSync(shots, { recursive: true });
  sb = sandbox();
  sb.hub.close();
  hub = createHub({
    databasePath: join(sb.dir, "hub/.data/phone.db"),
    registry: { forbiddenTrees: [join(sb.dir, "hub")], forbiddenExact: [sb.dir] },
    orchestrator: new FakeOrchestrator(),
    dataDir: join(sb.dir, "hub/.data"),
    remotePort: PORT,
    // Tailscale simulé : connecté, hub déjà publié.
    tailscaleRunner: async (args) => {
      const key = args.join(" ");
      if (key === "status --json") return { code: 0, stdout: JSON.stringify({ BackendState: "Running", Self: { DNSName: "mon-pc.tail1234.ts.net." } }), stderr: "" };
      if (key === "serve status --json") return { code: 0, stdout: served, stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  sb.hub = hub;
  const repo = sb.makeGameRepo("games/destiny", { "README.md": "# D\n" });
  await hub.projects.register(sb.human(), { path: repo, slug: "destiny", name: "Destiny Survivor" });
  app = await buildServer(hub, { port: PORT, gamesRoot: join(sb.dir, "games"), allowedHosts: [`127.0.0.1:${PORT}`], folderPicker: { pick: async () => null }, webDist });
  await app.listen({ host: "127.0.0.1", port: PORT });
  browser = await chromium.launch({ channel: "msedge", headless: true });
  pc = await browser.newPage({ viewport: { width: 1400, height: 900 }, locale: "fr-FR" });
  pc.on("dialog", (d) => void d.accept());
  phoneCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "fr-FR" });
  phone = await phoneCtx.newPage();
  for (const p of [pc, phone]) {
    p.on("pageerror", (e) => errors.push(e.message));
    p.on("response", async (r) => {
      if (r.status() >= 500) errors.push(`${r.status()} ${r.url()}`);
    });
  }
  await pc.goto(`${BASE}/login?token=${hub.sessions.createLoginToken()}`);
});

afterEach(async (ctx) => {
  if (ctx.task.result?.state === "fail") {
    if (errors.length) console.error(errors.join("\n"));
    await phone.screenshot({ path: join(shots, "ECHEC-telephone.png") });
    await pc.screenshot({ path: join(shots, "ECHEC-telephone-pc.png") });
  }
});

afterAll(async () => {
  await browser?.close();
  await app?.close();
  cleanupSandboxes();
});

describe("téléphone", () => {
  it("le PC affiche l'adresse Tailscale et un code ; le téléphone se connecte avec", async () => {
    await pc.locator(".side-nav a", { hasText: "Téléphone" }).click();
    await pc.locator(".remote-url", { hasText: "https://mon-pc.tail1234.ts.net" }).waitFor();
    await pc.getByRole("button", { name: "Afficher un code" }).click();
    const shown = (await pc.locator(".pair-code b").textContent())!.replace(/\s/g, "");
    expect(shown).toMatch(/^\d{6}$/);
    await pc.locator(".step", { hasText: "Connecter un téléphone" }).getByText("https://mon-pc.tail1234.ts.net/login").waitFor();
    await pc.screenshot({ path: join(shots, "telephone-1-pc.png") });

    await phone.goto(`${BASE}/login`);
    await phone.locator("#code").fill(shown);
    await phone.locator("#name").fill("Pixel de test");
    await phone.screenshot({ path: join(shots, "telephone-2-code.png") });
    await phone.getByRole("button", { name: "Se connecter" }).click();
    await phone.getByRole("heading", { name: "Vos projets" }).waitFor({ timeout: 10_000 });
    await phone.locator(".tabbar .tab-item", { hasText: "Accueil" }).waitFor();
    await phone.screenshot({ path: join(shots, "telephone-3-studio.png") });
  });

  it("affichage mobile : menu repliable, projet en un seul panneau", async () => {
    await phone.locator(".mobile-bar .menu-btn").click();
    await phone.locator(".menu-open .sidebar").waitFor();
    await phone.waitForTimeout(400);
    await phone.screenshot({ path: join(shots, "telephone-4-menu.png") });
    await phone.locator(".side-projects a", { hasText: "Destiny Survivor" }).click();
    await phone.locator(".project-title h1", { hasText: "Destiny Survivor" }).waitFor();
    expect(await phone.locator(".menu-open").count()).toBe(0);
    await phone.waitForTimeout(400);
    // Pas de défilement horizontal de la page.
    expect(await phone.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")).toBe(true);
    await phone.screenshot({ path: join(shots, "telephone-5-projet.png") });
    // Un seul panneau à la fois : la discussion, ou le panneau de droite d'un geste.
    await phone.locator(".pane-switch button").nth(1).click();
    await phone.locator(".project.pane-side").waitFor();
    expect(await phone.locator(".conversation").isVisible()).toBe(false);
    await phone.screenshot({ path: join(shots, "telephone-5b-panneau.png") });
    await phone.locator(".pane-switch button").nth(0).click();
    await phone.locator(".project.pane-chat .composer").waitFor();
    await phone.goto(`${BASE}/#/telephone`);
    await phone.locator(".step", { hasText: "Notifications sur cet appareil" }).waitFor();
    // Le téléphone ne voit pas les réglages réservés au PC (Tailscale, codes).
    expect(await phone.locator(".step", { hasText: "Accès depuis partout" }).count()).toBe(0);
    await phone.screenshot({ path: join(shots, "telephone-6-reglages.png"), fullPage: true });
  });

  it("déconnecté depuis le PC, le téléphone perd l'accès", async () => {
    await pc.reload();
    const row = pc.locator(".device-list li", { hasText: "Pixel de test" });
    await row.waitFor();
    await row.getByRole("button", { name: "Déconnecter" }).click();
    await expect.poll(() => pc.locator(".device-list li", { hasText: "Pixel de test" }).count()).toBe(0);
    const res = await phone.request.get(`${BASE}/api/human/session`);
    expect(res.status()).toBe(401);
    expect(errors).toEqual([]);
  });
});
