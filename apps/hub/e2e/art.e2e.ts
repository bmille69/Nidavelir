/**
 * Le Directeur artistique dans un vrai navigateur (Edge), avec un orchestrateur factice (ADR-43) :
 * construire la direction, répondre à une question de goût, déposer une inspiration, lire la bible,
 * copier un prompt Midjourney, déposer un rendu, voir le verdict, faire intégrer ; puis sur téléphone.
 */
import type { FastifyInstance } from "fastify";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Hub } from "../src/hub.ts";
import { buildServer } from "../src/server/http.ts";
import { FakeOrchestrator } from "../test/fake-orchestrator.ts";
import { cleanupSandboxes, sandbox, type Sandbox } from "../test/helpers.ts";

const PORT = 4395;
const BASE = `http://127.0.0.1:${PORT}`;
const webDist = process.env.STUDIO_WEB_DIST ?? resolve(fileURLToPath(new URL("../../web/dist", import.meta.url)));
const shots = process.env.STUDIO_SCREENSHOTS ?? join(process.cwd(), ".data", "screenshots");

/** Une petite image PNG valide (1×1 pixel). */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");

class Artist extends FakeOrchestrator {
  override async reply(input: { systemPrompt: string; prompt: string; readDir?: string }) {
    if (!input.readDir) return super.reply(input);
    const last = input.prompt.slice(input.prompt.lastIndexOf('<message de="directeur créatif">'));
    if (/cuirassé en 3D/.test(last))
      return {
        text: '[[ASSET]] {"name": "Cuirassé", "type": "modèle 3D", "usage": "navire du joueur"} [[/ASSET]]\n[[MODELE3D: A-0002 | taille 12 | triangles 6000]]',
        costUsd: 0,
      };
    if (/Construisons ensemble/.test(last))
      return {
        text: "Partons de votre bataille navale. Une première question de goût :\n\n[[CHOIX: Quelle ambiance générale ?]] Affiche d'époque | Maquette de musée | Carte d'état-major [[/CHOIX]]",
        costUsd: 0,
      };
    return {
      text: [
        "Excellent choix. Voici la bible et un premier visuel à produire.",
        "[[BIBLE]]\n# Bible visuelle\n\n## Palette\n- #1B2A3A : mer de nuit\n- #E8D9B5 : papier\n[[/BIBLE]]",
        '[[ASSET]] {"name": "Icône de poudre", "type": "icône", "usage": "pastilles de poudre du HUD", "specs": "PNG 64×64"} [[/ASSET]]',
        "[[MIDJOURNEY: A-0001]] gunpowder barrel icon, 1910s naval poster, flat colors --ar 1:1 [[/MIDJOURNEY]]",
      ].join("\n\n"),
      costUsd: 0,
    };
  }
}

let sb: Sandbox;
let hub: Hub;
let app: FastifyInstance;
let browser: Browser;
let page: Page;
const errors: string[] = [];

beforeAll(async () => {
  mkdirSync(shots, { recursive: true });
  const fake = new Artist();
  fake.extractions.push({ ok: true, summary: "Lisible à 64 px, dans la palette.", points: ["Silhouette claire"], prompt: null } as never);
  sb = sandbox(fake);
  hub = sb.hub;
  const repo = sb.makeGameRepo("games/bordee", { "CLAUDE.md": "# Bordée\nBataille navale 1900-1945.\n" });
  await hub.projects.register(sb.human(), { path: repo, slug: "bordee", name: "Bordée" });
  writeFileSync(join(sb.dir, "inspiration.png"), PNG);
  writeFileSync(join(sb.dir, "rendu.png"), PNG);
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
  cleanupSandboxes();
});

describe("direction artistique", () => {
  it("de la première question au visuel intégré", async () => {
    try {
      await steps();
    } catch (e) {
      await page.screenshot({ path: join(shots, "art-echec.png"), fullPage: true });
      throw e;
    }
  }, 60_000);

  async function steps() {
    await page.goto(`${BASE}/#/p/bordee`);
    // La direction artistique est l'onglet « Art & son » (ADR-113) : rien n'est posé, la page invite à commencer.
    await page.locator(".project-tabs a", { hasText: "Art & son" }).click();
    await page.locator(".art-start").waitFor();
    await page.locator(".art-sound").waitFor();
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(shots, "art-0-vide.png") });
    // Le DA se parle dans son panneau, par-dessus la galerie.
    await page.locator(".art-start").getByRole("button", { name: /Construire la direction artistique/ }).click();
    const da = page.locator(".da-drawer");
    await da.waitFor();

    // Une question de goût, tranchée d'un clic.
    await da.getByRole("button", { name: "Affiche d'époque" }).click({ timeout: 15_000 });

    // Une image d'inspiration jointe au message suivant.
    await da.locator(".composer input[type=file]").setInputFiles(join(sb.dir, "inspiration.png"));
    await da.locator(".art-chip img").waitFor();
    await da.locator(".art-done", { hasText: "bible mise à jour · A-0001 proposé" }).waitFor({ timeout: 15_000 });
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(shots, "art-1-discussion.png") });

    // La direction en images : la palette en pastilles, le texte de la bible à déplier (ADR-58), dans le panneau du DA.
    await da.locator(".art-panel .tab", { hasText: "Direction" }).click();
    await da.locator(".art-swatch", { hasText: "#1B2A3A" }).waitFor();
    await da.locator(".art-vision summary", { hasText: "Lire le texte" }).click();
    await da.locator(".art-bible", { hasText: "#1B2A3A : mer de nuit" }).waitFor();
    await da.locator(".art-panel .tab", { hasText: "Moodboard" }).click();
    await da.locator(".art-mood-grid img").waitFor();
    await da.getByRole("button", { name: "Fermer" }).click();

    // La galerie : le visuel proposé ; son détail complet s'ouvre au clic (prompts, dépôt du rendu, actions).
    const tile = page.locator(".acard", { hasText: "Icône de poudre" });
    await tile.waitFor({ timeout: 15_000 });
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(shots, "art-galerie.png") });
    await tile.click();
    const detail = page.locator(".art-detail");
    await detail.locator(".art-asset", { hasText: "Icône de poudre" }).waitFor();
    await expect(detail.locator(".art-prompt code").first().textContent()).resolves.toMatch(/gunpowder barrel icon/);

    // Le rendu fait dans Midjourney : le validateur le juge, puis on le fait intégrer.
    await detail.locator(".art-asset input[type=file]").setInputFiles(join(sb.dir, "rendu.png"));
    await detail.locator(".art-verdict.ok", { hasText: "Conforme" }).waitFor({ timeout: 15_000 });
    await detail.locator(".art-render img").waitFor();
    await page.waitForTimeout(450);
    await page.screenshot({ path: join(shots, "art-2-verdict.png") });
    await page.keyboard.press("Escape");
    // Validé : il part tout seul au directeur du projet (ADR-48) ; le DA le dit dans sa discussion.
    await page.locator(".da-open").click();
    await da.locator(".msg.art", { hasText: "part dans le jeu" }).waitFor({ timeout: 15_000 });
    expect(hub.art.state("bordee").assets[0]!.status).toBe("integration");
    expect(hub.conversations.listThreads("bordee").find((t) => t.title === "Intégrer A-0001 : Icône de poudre")).toMatchObject({ automatic: true });

    // Un modèle 3D : la fiche le dit, et l'atelier 3D se présente dans les Réglages (Blender à installer, clé Tripo à coller).
    await da.locator(".composer textarea").fill("Il nous faut le cuirassé en 3D");
    await da.locator(".composer textarea").press("Enter");
    await expect.poll(() => hub.art.state("bordee").assets.some((a) => /Cuirassé/.test(a.name)), { timeout: 15_000 }).toBe(true);
    await page.keyboard.press("Escape");
    await page.locator(".acard", { hasText: "Cuirassé" }).waitFor({ timeout: 15_000 });
    await page.getByRole("button", { name: "Réglages techniques" }).click();
    const settings = page.locator(".art-settings");
    await settings.locator(".art-gen", { hasText: "Atelier 3D" }).waitFor();
    await settings.getByRole("button", { name: /Installer Blender/ }).waitFor();
    await settings.locator(".set-group", { hasText: "Générateur d'images local" }).waitFor();
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(shots, "art-reglages.png") });
    await page.keyboard.press("Escape");
    await page.locator(".acard", { hasText: "Cuirassé" }).click();
    await page.locator(".art-detail .art-asset", { hasText: "Modèle 3D : 12 m, 6000 triangles" }).waitFor();
    await page.waitForTimeout(450);
    await page.screenshot({ path: join(shots, "art-5-atelier-3d.png") });
    await page.keyboard.press("Escape");
    expect(errors).toEqual([]);
  }

  it("sur téléphone : les visuels, puis la discussion du DA en plein écran", async () => {
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: "fr-FR", isMobile: true, hasTouch: true });
    phone.on("pageerror", (e) => errors.push(e.message));
    await phone.goto(`${BASE}/login?token=${hub.sessions.createLoginToken()}`);
    await phone.goto(`${BASE}/#/p/bordee/art`);
    await phone.locator(".acard", { hasText: "Icône de poudre" }).first().waitFor();
    expect(await phone.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")).toBe(true);
    await phone.waitForTimeout(350);
    await phone.screenshot({ path: join(shots, "art-4-telephone-visuels.png") });
    // « Répondre au Directeur artistique » (« À vous ») mène à /art/da : sa discussion s'ouvre directement.
    await phone.goto(`${BASE}/#/p/bordee/art/da`);
    await phone.locator(".da-drawer .msg.art").first().waitFor();
    expect(await phone.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")).toBe(true);
    await phone.waitForTimeout(350);
    await phone.screenshot({ path: join(shots, "art-3-telephone.png") });
    await phone.locator(".da-drawer").getByRole("button", { name: "Fermer" }).click();
    await expect.poll(() => phone.evaluate("location.hash")).toBe("#/p/bordee/art");
    // La file des visuels sur une fiche proposée (ADR-62), dans son détail.
    await phone.locator(".acard.st-propose").first().click();
    await phone.locator(".art-detail .art-asset.st-propose").waitFor();
    await phone.waitForTimeout(350);
    await phone.screenshot({ path: join(shots, "art-6-telephone-file.png") });
    await phone.close();
    expect(errors).toEqual([]);
  });
});
