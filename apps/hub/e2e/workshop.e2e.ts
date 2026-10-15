/**
 * Mode atelier dans un vrai navigateur (Edge) : vous dites « go », le directeur rédige la consigne,
 * le développeur travaille, le testeur vérifie, le hub fusionne. Aucune fiche à gérer.
 */
import type { FastifyInstance } from "fastify";
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHub, type Hub } from "../src/hub.ts";
import { buildServer } from "../src/server/http.ts";
import { FakeOrchestrator } from "../test/fake-orchestrator.ts";
import { FakeExecutor, planOutput, REPORT, VERIFIED } from "../test/fake-executor.ts";
import { cleanupSandboxes, sandbox, type Sandbox } from "../test/helpers.ts";

const PORT = 4398;
const BASE = `http://127.0.0.1:${PORT}`;
const webDist = process.env.STUDIO_WEB_DIST ?? resolve(fileURLToPath(new URL("../../web/dist", import.meta.url)));
const shots = process.env.STUDIO_SCREENSHOTS ?? join(process.cwd(), ".data", "screenshots");
const P = "destiny";

let sb: Sandbox;
let hub: Hub;
let app: FastifyInstance;
let browser: Browser;
let page: Page;
let repo: string;
const pageErrors: string[] = [];
const fake = new FakeOrchestrator();
const exec = new FakeExecutor();

beforeAll(async () => {
  mkdirSync(shots, { recursive: true });
  sb = sandbox();
  sb.hub.close();
  hub = createHub({
    databasePath: join(sb.dir, "hub/.data/atelier.db"),
    registry: { forbiddenTrees: [join(sb.dir, "hub")], forbiddenExact: [sb.dir] },
    orchestrator: fake,
    executor: exec,
    dataDir: join(sb.dir, "hub/.data"),
    autopilot: { synthesisDelayMs: 600_000 },
  });
  sb.hub = hub;
  repo = sb.makeGameRepo("games/destiny", {
    "README.md": "# Destiny Survivor\n",
    "CLAUDE.md": "Le rendu ne modifie jamais la simulation.\n",
    "src/render3d/projectileView.ts": "export {};\n",
  });
  await hub.projects.register(sb.human(), { path: repo, slug: P, name: "Destiny Survivor" });
  app = await buildServer(hub, { port: PORT, gamesRoot: join(sb.dir, "games"), allowedHosts: [`127.0.0.1:${PORT}`], folderPicker: { pick: async () => null }, webDist });
  await app.listen({ host: "127.0.0.1", port: PORT });
  browser = await chromium.launch({ channel: "msedge", headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 950 }, locale: "fr-FR" });
  page.on("dialog", (d) => void d.accept());
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("response", async (r) => {
    if (r.status() >= 500) pageErrors.push(`${r.status()} ${r.url()} ${await r.text().catch(() => "")}`);
  });
  await page.goto(`${BASE}/login?token=${hub.sessions.createLoginToken()}`);
});

afterEach(async (ctx) => {
  if (ctx.task.result?.state === "fail" && page) {
    if (pageErrors.length) console.error(`Erreurs du navigateur :\n${pageErrors.join("\n")}`);
    await page.screenshot({ path: join(shots, `ECHEC-atelier-${ctx.task.name.slice(0, 25).replace(/[^\w]+/g, "_")}.png`) });
  }
});

afterAll(async () => {
  await browser?.close();
  await app?.close();
  await hub?.conversations.idle();
  await hub?.tasks.idle();
  cleanupSandboxes();
});

describe("atelier", () => {
  it("« go » : consigne, chantier, testeur, fusion automatique", async () => {
    fake.replies.push(
      [
        "Je propose une balle à noyau blanc-chaud et un sillage effilé de 0,12 s teinté de l'élément, rendu seulement : la simulation ne bouge pas.",
        "[[CHANTIER: Balles lumineuses du fusil auto]]",
        "Objectif : des tirs lisibles et premium sur le fusil auto Kinetic.",
        "À faire : noyau blanc-chaud ; sillage de 0,12 s teinté de l'élément ; un traceur sur trois.",
        "Où : src/render3d/projectileView.ts.",
        "Contraintes : le rendu ne modifie jamais la simulation (CLAUDE.md).",
        "Vérification : npm test.",
        "Hors périmètre : armes énergétiques.",
        "[[/CHANTIER]]",
      ].join("\n"),
    );
    let finish!: () => void;
    const working = new Promise<void>((r) => (finish = r));
    exec.scripts.plan.push(() => planOutput({ files_to_create: [], files_to_modify: ["src/render3d/projectileView.ts"], steps: [{ description: "Sillage", files: ["src/render3d/projectileView.ts"] }] }));
    exec.scripts.execute.push(async (t) => {
      await working;
      await t.write("src/render3d/projectileView.ts", "export const trail = 0.12;\n");
      return REPORT;
    });
    exec.scripts.verify.push(() => VERIFIED);

    await page.goto(`${BASE}/#/p/${P}`);
    await page.getByRole("button", { name: /Autonomie : Atelier/ }).waitFor();
    await page.getByPlaceholder(/Écrivez librement/).fill("Les balles du perso font cheap, fais-les plus premium. go");
    await page.getByRole("button", { name: "Envoyer" }).click();
    await page.locator(".brief summary", { hasText: "Balles lumineuses du fusil auto" }).waitFor({ timeout: 10_000 });
    await page.locator(".msg", { hasText: "Chantier T-0001 « Balles lumineuses du fusil auto » lancé" }).waitFor({ timeout: 10_000 });
    await page.locator(".workshop-list", { hasText: "Balles lumineuses du fusil auto" }).waitFor();
    await page.locator(".brief summary").click();
    await page.screenshot({ path: join(shots, "atelier-1-go.png") });
    // Le directeur connaissait le code : consignes du projet et fichiers dans son contexte.
    expect(fake.calls[0]!.systemPrompt).toMatch(/Le rendu ne modifie jamais la simulation[\s\S]*src\/render3d\/projectileView.ts/);

    finish();
    // Le testeur valide : le hub fusionne tout seul (ADR-31), sans clic de votre part.
    await page.locator(".msg", { hasText: "terminé, vérifié par le testeur et fusionné dans votre jeu" }).waitFor({ timeout: 15_000 });
    await page.screenshot({ path: join(shots, "atelier-2-termine.png") });

    await page.goto(`${BASE}/#/p/${P}/tasks/T-0001`);
    await page.getByText(/Fusionné dans votre jeu/).waitFor({ timeout: 10_000 });
    expect(readFileSync(join(repo, "src/render3d/projectileView.ts"), "utf8")).toMatch(/0.12/);
    // Aucune fiche notée ; le seul appel structuré est la mise à jour du carnet « État du jeu » (ADR-33).
    expect(fake.calls.filter((c) => c.kind === "structured" && !/carnet « État du jeu »/.test(c.systemPrompt))).toHaveLength(0);
    expect(pageErrors).toEqual([]);
  });

  it("votre avis après fusion, puis le tableau Qualité", async () => {
    await page.locator(".rating").getByRole("button", { name: "Avis positif" }).click();
    await page.locator(".rating .rate.up.on").waitFor();
    expect(hub.quality.rating(P, "T-0001")).toMatchObject({ rating: "up" });

    await page.locator(".side-nav a", { hasText: "Qualité" }).click();
    await page.getByRole("heading", { name: "Qualité" }).waitFor();
    await page.locator(".kpi", { hasText: "Réussite" }).getByText("100 %").waitFor();
    await page.locator(".kpi", { hasText: "Votre avis" }).getByText(/1 👍/).waitFor();
    await page.locator(".qtable", { hasText: "Balles lumineuses du fusil auto" }).waitFor();
    await page.screenshot({ path: join(shots, "qualite.png") });
    expect(pageErrors).toEqual([]);
  });

  it("compétences : leçons du projet et bibliothèque à activer agent par agent", async () => {
    await page.locator(".side-nav a", { hasText: "Compétences" }).click();
    await page.getByRole("heading", { name: "Compétences" }).waitFor();
    await page.locator(".skill h3", { hasText: "Leçons — Destiny Survivor" }).waitFor();
    const feel = page.locator(".skill", { hasText: "game-feel" });
    await feel.getByRole("checkbox", { name: /Activer game-feel/ }).check();
    await feel.locator(".agent-chip", { hasText: "Testeur" }).click();
    await expect.poll(() => hub.skills.list().find((s) => s.name === "game-feel")).toMatchObject({ enabled: true, agents: ["director", "concepteur", "developer", "qa"] });
    await feel.getByRole("button", { name: /Voir le contenu/ }).click();
    await page.screenshot({ path: join(shots, "competences.png") });
    expect(pageErrors).toEqual([]);
  });
});
