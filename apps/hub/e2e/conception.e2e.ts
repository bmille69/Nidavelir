/**
 * Le Concepteur dans un vrai navigateur (Edge) : idée en vrac → questions en boutons →
 * « Choisis pour moi » → dossier → « Créer le projet » → chantiers prêts à lancer.
 */
import type { FastifyInstance } from "fastify";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/server/http.ts";
import { FakeOrchestrator } from "../test/fake-orchestrator.ts";
import { cleanupSandboxes, sandbox, type Sandbox } from "../test/helpers.ts";

const PORT = 4399;
const BASE = `http://127.0.0.1:${PORT}`;
const webDist = resolve(fileURLToPath(new URL("../../web/dist", import.meta.url)));
const shots = process.env.STUDIO_SCREENSHOTS ?? join(process.cwd(), ".data", "screenshots");

let sb: Sandbox;
let app: FastifyInstance;
let browser: Browser;
let page: Page;
const pageErrors: string[] = [];
const fake = new FakeOrchestrator();

const DOSSIER = `# Chats du Néant
## En une phrase
Un roguelike de 15 minutes où l'on incarne un chat qui traverse le Néant.
## Piliers
- **Parties courtes** : 15 minutes au plus
- **Builds surprenants** : les pouvoirs se combinent
## Boucle de jeu
1. Entrer dans une salle
2. Vaincre les ennemis
3. Choisir une récompense
## Estimation
Environ 12 chantiers pour la première version jouable (ordre de grandeur).`;

const turn = (over: Record<string, unknown>) => ({
  reply: "Si je comprends bien : un roguelike court, nerveux, avec des chats. Deux questions pour cadrer, le reste je le propose dans le dossier.",
  questions: [
    {
      question: "Sur quoi voulez-vous y jouer ?",
      why: "Ça décide du moteur et de la façon de tester.",
      options: [
        { label: "Navigateur", detail: "Web + TypeScript, le plus simple à partager" },
        { label: "PC (Godot)", detail: "Exécutable, plus de puissance" },
      ],
      recommended: "Navigateur",
    },
    {
      question: "Quel style visuel ?",
      why: "Le temps de production des graphismes en dépend.",
      options: [
        { label: "Pixel art", detail: "Rapide à produire" },
        { label: "3D simple", detail: "Plus long" },
      ],
      recommended: "Pixel art",
    },
  ],
  title: "Chats du Néant",
  engine: "web",
  dossier: DOSSIER,
  chantiers: [
    { title: "Base technique : Vite + TypeScript + tests", goal: "Objectif : un écran qui se lance et un test qui passe." },
    { title: "Déplacement du chat", goal: "Objectif : le chat se déplace au clavier." },
  ],
  ready: false,
  claude_md: "",
  sources: [{ title: "Hades — progression", url: "https://example.invalid/hades" }],
  ...over,
});

beforeAll(async () => {
  mkdirSync(shots, { recursive: true });
  sb = sandbox(fake);
  mkdirSync(join(sb.dir, "games"), { recursive: true });
  app = await buildServer(sb.hub, { port: PORT, gamesRoot: join(sb.dir, "games"), allowedHosts: [`127.0.0.1:${PORT}`], folderPicker: { pick: async () => null }, webDist });
  await app.listen({ host: "127.0.0.1", port: PORT });
  browser = await chromium.launch({ channel: "msedge", headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 950 }, locale: "fr-FR" });
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("response", async (r) => {
    if (r.status() >= 500) pageErrors.push(`${r.status()} ${r.url()} ${await r.text().catch(() => "")}`);
  });
  await page.goto(`${BASE}/login?token=${sb.hub.sessions.createLoginToken()}`);
});

afterAll(async () => {
  await browser?.close();
  await app?.close();
  await sb?.hub.conceptions.idle();
  cleanupSandboxes();
});

describe("Concepteur", () => {
  it("idée en vrac → questions → choisis pour moi → créer le projet", async () => {
    fake.extractions.push(() => turn({}) as never, () => turn({ ready: true, questions: [], claude_md: "# Chats du Néant\nTextes en français ; tests avec Vitest." }) as never);

    await page.locator(".side-nav a", { hasText: "Nouveau projet" }).click();
    await page.getByRole("heading", { name: "Nouveau projet" }).waitFor();
    await page.locator("textarea.idea").fill("un roguelike avec des chats un peu comme hades");
    await page.screenshot({ path: join(shots, "concept-1-idee.png") });
    await page.getByRole("button", { name: /Commencer la conception/ }).click();

    await page.locator(".answer-card", { hasText: "Sur quoi voulez-vous y jouer ?" }).waitFor({ timeout: 10_000 });
    await page.locator(".md h3", { hasText: "Piliers" }).waitFor();
    await page.screenshot({ path: join(shots, "concept-2-questions.png") });

    await page.getByRole("button", { name: /Choisis pour moi/ }).click();
    await page.locator(".answer-opt.on", { hasText: "Navigateur" }).waitFor();
    await page.getByRole("button", { name: "Envoyer mes réponses" }).click();
    await page.locator(".ready.on").waitFor({ timeout: 10_000 });
    expect(fake.calls[1]!.prompt).toMatch(/Sur quoi voulez-vous y jouer \? → Navigateur[\s\S]*Quel style visuel \? → Pixel art/);
    await page.getByRole("button", { name: /Chantiers \(2\)/ }).click();
    await page.screenshot({ path: join(shots, "concept-3-pret.png") });

    await page.getByRole("button", { name: /Créer le projet/ }).click();
    await page.locator(".project-title h1", { hasText: "Chats du Néant" }).waitFor({ timeout: 10_000 });
    expect(existsSync(join(sb.dir, "games", "chats-du-neant", "CLAUDE.md"))).toBe(true);
    // La discussion « Conception » et les chantiers prêts à lancer.
    await page.locator(".threads a", { hasText: "Conception : Chats du Néant" }).click();
    await page.locator(".workshop-list", { hasText: "Base technique" }).getByRole("button", { name: /Lancer ce chantier/ }).first().waitFor();
    await page.locator(".msg", { hasText: "Premiers chantiers, prêts à lancer" }).waitFor();
    await page.screenshot({ path: join(shots, "concept-4-projet.png") });
    expect(pageErrors).toEqual([]);
  });
});
