/**
 * Phase 2 dans un vrai navigateur (Edge), avec l'exécuteur factice :
 * faire implémenter → plan → validation → escalade refusée → revue → fusion.
 */
import type { FastifyInstance } from "fastify";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHub, type Hub } from "../src/hub.ts";
import { buildServer } from "../src/server/http.ts";
import { FakeExecutor, planOutput, REPORT, VERIFIED } from "../test/fake-executor.ts";
import { cleanupSandboxes, DIRECTOR, fakeClock, git, msg, sandbox, type Sandbox } from "../test/helpers.ts";

const PORT = 4394;
const BASE = `http://127.0.0.1:${PORT}`;
const webDist = process.env.STUDIO_WEB_DIST ?? resolve(fileURLToPath(new URL("../../web/dist", import.meta.url)));
const shots = process.env.STUDIO_SCREENSHOTS ?? join(process.cwd(), ".data", "screenshots");
const P = "destiny";

let sb: Sandbox;
let hub: Hub;
let fake: FakeExecutor;
let app: FastifyInstance;
let browser: Browser;
let page: Page;
let repo: string;
const pageErrors: string[] = [];

beforeAll(async () => {
  mkdirSync(shots, { recursive: true });
  sb = sandbox();
  sb.hub.close();
  fake = new FakeExecutor();
  hub = createHub({
    databasePath: join(sb.dir, "hub/.data/e2e.db"),
    registry: { forbiddenTrees: [join(sb.dir, "hub")], forbiddenExact: [sb.dir] },
    clock: fakeClock(),
    executor: fake,
    dataDir: join(sb.dir, "hub/.data"),
  });
  sb.hub = hub;
  repo = sb.makeGameRepo("games/destiny", { "README.md": "# Destiny Survivor\n", "src/main.ts": "export {};\n" });
  await hub.projects.register(sb.human(), { path: repo, slug: P, name: "Destiny Survivor" });
  hub.projects.setAutonomy(sb.human(), P, "supervised");
  hub.vision.capture(P, DIRECTOR, { type: "mechanic", title: "Boss à l'arène", statement: "Le boss surgit à l'entrée de son arène.", source: msg("m", "x") });
  const { proposal, hash } = hub.vision.submitProposal(P, DIRECTOR, {
    title: "Apparition des boss",
    statement: "Le boss surgit quand le joueur entre dans son arène, jamais sur un minuteur.",
    source: { kind: "message", ref: "m" },
    details: { based_on: ["M-0001"] },
  });
  await hub.vision.decideProposal(P, hub.approvals.record(sb.human(), { project: P, subject: { kind: "proposal", id: proposal.id, hash }, verdict: "approved" }).id);

  app = await buildServer(hub, { port: PORT, gamesRoot: join(sb.dir, "games"), allowedHosts: [`127.0.0.1:${PORT}`], folderPicker: { pick: async () => null }, webDist });
  await app.listen({ host: "127.0.0.1", port: PORT });
  browser = await chromium.launch({ channel: "msedge", headless: true });
  page = await browser.newPage({ viewport: { width: 1400, height: 950 }, locale: "fr-FR" });
  page.on("dialog", (d) => void d.accept());
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(`${BASE}/login?token=${hub.sessions.createLoginToken()}`);
});

afterEach(async (ctx) => {
  if (ctx.task.result?.state === "fail" && page) {
    if (pageErrors.length) console.error(`Erreurs du navigateur :\n${pageErrors.join("\n")}`);
    await page.screenshot({ path: join(shots, `ECHEC-taches-${ctx.task.name.slice(0, 25).replace(/[^\w]+/g, "_")}.png`) });
  }
});

afterAll(async () => {
  await browser?.close();
  await app?.close();
  await hub?.tasks.idle();
  cleanupSandboxes();
});

const shot = (name: string) => page.screenshot({ path: join(shots, `${name}.png`) });

describe("phase 2 dans le navigateur", () => {
  it("faire implémenter une décision, puis demander un plan", async () => {
    fake.scripts.plan.push(() =>
      planOutput({
        summary_simple: "Je crée un fichier qui décrit la règle d'apparition des boss : ils surgissent à l'entrée de leur arène.",
        questions: ["Faut-il garder une sécurité si le joueur n'entre jamais dans l'arène ?"],
      }),
    );
    await page.goto(`${BASE}/#/p/${P}/vision`);
    await page.getByRole("button", { name: "Faire réaliser" }).click();
    await page.getByRole("heading", { name: "Apparition des boss" }).waitFor();
    await page.getByRole("button", { name: "Demander un plan au développeur" }).click();
    await page.getByRole("heading", { name: "Le plan proposé" }).waitFor({ timeout: 10_000 });
    await shot("p2-1-plan");
  });

  it("valider le plan : le développeur travaille et demande une autorisation", async () => {
    fake.scripts.execute.push(async (t) => {
      await t.write("src/boss.ts", "export const bossRule = 'arène';\n");
      await t.write("studio/BRIEF.md", "piraté");
      await t.write("src/debug.ts", "console.log('debug');\n");
      return { ...REPORT, deviations: [{ what: "src/debug.ts non créé", why: "refusé par le directeur créatif" }] };
    });
    fake.scripts.verify.push(() => VERIFIED);
    await page.getByRole("button", { name: "Valider le plan et lancer le travail" }).click();
    await page.getByText("Le développeur vous demande l'autorisation").waitFor({ timeout: 10_000 });
    // La demande se voit depuis tous les onglets : le compteur braise de la Discussion, où « À vous » la montre (ADR-113).
    await expect.poll(() => page.locator(".project-tabs a", { hasText: "Discussion" }).locator(".tab-count.pulse").isVisible(), { timeout: 8000 }).toBe(true);
    await expect(page.locator(".project-tabs a.active").textContent()).resolves.toBe("Récap");
    await shot("p2-2-autorisation");
    await page.getByRole("button", { name: "Refuser" }).first().click();
    await page.getByRole("heading", { name: "Le résultat, à relire" }).waitFor({ timeout: 10_000 });
    await shot("p2-3-relecture");
    expect(existsSync(join(repo, "src/boss.ts"))).toBe(false);
  });

  it("fusionner dans le jeu", async () => {
    await page.getByRole("button", { name: "Fusionner dans mon jeu" }).click();
    await page.getByText(/Fusionné dans votre jeu/).waitFor({ timeout: 10_000 });
    await shot("p2-4-fusion");
    expect(readFileSync(join(repo, "src/boss.ts"), "utf8")).toMatch(/arène/);
    expect(existsSync(join(repo, "src/debug.ts"))).toBe(false);
    expect(readFileSync(join(repo, "studio/BRIEF.md"), "utf8")).not.toMatch(/piraté/);
    expect(git(repo, "log", "-1", "--format=%s")).toMatch(/fusion de T-0001/);
    expect(pageErrors).toEqual([]);
  });
});
