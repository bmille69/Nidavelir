/**
 * Vue « Studio » dans un vrai navigateur (Edge) : plusieurs agents travaillent en même
 * temps (directeur, archiviste, développeur), une proposition vous attend.
 * Les agents factices restent bloqués tant que le test ne les libère pas.
 */
import type { FastifyInstance } from "fastify";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHub, type Hub } from "../src/hub.ts";
import { buildServer } from "../src/server/http.ts";
import { extracted, FakeOrchestrator } from "../test/fake-orchestrator.ts";
import { FakeExecutor, planOutput } from "../test/fake-executor.ts";
import { cleanupSandboxes, DIRECTOR, msg, sandbox, type Sandbox } from "../test/helpers.ts";

const PORT = 4396;
const BASE = `http://127.0.0.1:${PORT}`;
const webDist = process.env.STUDIO_WEB_DIST ?? resolve(fileURLToPath(new URL("../../web/dist", import.meta.url)));
const shots = process.env.STUDIO_SCREENSHOTS ?? join(process.cwd(), ".data", "screenshots");
const P = "destiny";

/** Barrière : les agents attendent `open()` avant de répondre. */
function gate() {
  let open!: () => void;
  const wait = new Promise<void>((r) => (open = r));
  return { wait, open };
}
const release = gate();

class SlowOrchestrator extends FakeOrchestrator {
  override async reply(input: { systemPrompt: string; prompt: string }) {
    await release.wait;
    return super.reply(input);
  }
  override async structured(input: { systemPrompt: string; prompt: string; jsonSchema: object }) {
    await release.wait;
    return super.structured(input);
  }
}

let sb: Sandbox;
let hub: Hub;
let app: FastifyInstance;
let browser: Browser;
let page: Page;
const pageErrors: string[] = [];
const fake = new SlowOrchestrator();
const exec = new FakeExecutor();

beforeAll(async () => {
  mkdirSync(shots, { recursive: true });
  sb = sandbox();
  sb.hub.close();
  hub = createHub({
    databasePath: join(sb.dir, "hub/.data/studio.db"),
    registry: { forbiddenTrees: [join(sb.dir, "hub")], forbiddenExact: [sb.dir] },
    orchestrator: fake,
    executor: exec,
    dataDir: join(sb.dir, "hub/.data"),
  });
  sb.hub = hub;
  const repo = sb.makeGameRepo("games/destiny", { "README.md": "# Destiny Survivor\n", "src/main.ts": "export {};\n", "package.json": "{}" });
  await hub.projects.register(sb.human(), { path: repo, slug: P, name: "Destiny Survivor" });
  // Les premiers parcours montrent l'archiviste au travail : mode « équilibré » (l'atelier ne note pas de fiches).
  hub.projects.setAutonomy(sb.human(), P, "balanced");
  const other = sb.makeGameRepo("games/ombres", { "project.godot": "" });
  await hub.projects.register(sb.human(), { path: other, slug: "ombres", name: "Ombres du Nord" });

  hub.vision.capture(P, DIRECTOR, { type: "mechanic", title: "Boss à l'arène", statement: "Le boss surgit à l'entrée de son arène.", source: msg("m", "x") });
  const { proposal, hash } = hub.vision.submitProposal(P, DIRECTOR, {
    title: "Apparition des boss",
    statement: "Le boss surgit quand le joueur entre dans son arène.",
    source: { kind: "message", ref: "m" },
    details: { based_on: ["M-0001"] },
  });
  await hub.vision.decideProposal(P, hub.approvals.record(sb.human(), { project: P, subject: { kind: "proposal", id: proposal.id, hash }, verdict: "approved" }).id);
  hub.vision.capture(P, DIRECTOR, { type: "mechanic", title: "Trois vagues", statement: "Trois vagues par niveau.", source: msg("m", "y") });
  hub.vision.submitProposal(P, DIRECTOR, { title: "Rythme des vagues", statement: "Trois vagues par niveau.", source: { kind: "message", ref: "m" }, details: { based_on: ["M-0002"] } });

  app = await buildServer(hub, { port: PORT, gamesRoot: join(sb.dir, "games"), allowedHosts: [`127.0.0.1:${PORT}`], folderPicker: { pick: async () => null }, webDist });
  await app.listen({ host: "127.0.0.1", port: PORT });
  browser = await chromium.launch({ channel: "msedge", headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 }, locale: "fr-FR" });
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("response", async (r) => {
    if (r.status() >= 500) pageErrors.push(`${r.status()} ${r.url()} ${await r.text().catch(() => "")}`);
  });
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(m.text());
  });
  await page.goto(`${BASE}/login?token=${hub.sessions.createLoginToken()}`);
});

afterEach(async (ctx) => {
  if (ctx.task.result?.state === "fail" && page) {
    if (pageErrors.length) console.error(`Erreurs du navigateur :\n${pageErrors.join("\n")}`);
    await page.screenshot({ path: join(shots, `ECHEC-studio-${ctx.task.name.slice(0, 25).replace(/[^\w]+/g, "_")}.png`) });
  }
});

afterAll(async () => {
  release.open();
  await browser?.close();
  await app?.close();
  await hub?.conversations.idle();
  await hub?.tasks.idle();
  cleanupSandboxes();
});

describe("vue Studio", () => {
  it("au repos : l'accueil montre ce qui vous attend, « En direct » l'organigramme", async () => {
    // Accueil : ce qui vous attend en premier, puis vos projets.
    await page.getByRole("heading", { name: "Vos projets" }).waitFor();
    await page.locator(".attention-card", { hasText: "1 proposition(s) à arbitrer" }).waitFor();
    await page.screenshot({ path: join(shots, "accueil.png") });
    // Le studio en direct, plus bas dans le menu.
    await page.locator(".side-nav a", { hasText: "En direct" }).click();
    await page.getByRole("heading", { name: "Le studio en direct" }).waitFor();
    for (const name of ["Vous", "Le Directeur", "L'Archiviste", "Le Développeur", "Le Testeur", "Le Gardien"]) {
      await page.locator(".agent-card h3", { hasText: name }).first().waitFor();
    }
    // Une proposition attend votre arbitrage.
    await page.locator(".agent-card.agent-you.state-waiting").getByText("1 proposition(s) à arbitrer").waitFor();
    expect(await page.locator(".org-links path.link-base").count()).toBe(6);
    // Sous chaque agent : son modèle, celui que nous recommandons, et ce qu'il consomme (ADR-37).
    const dev = page.locator(".agent-card.agent-developer");
    await expect.poll(() => dev.locator(".model-pick select").inputValue()).toBe("fable");
    await dev.locator(".model-reco.on", { hasText: "Recommandé" }).waitFor();
    await page.locator(".agent-card.agent-guardian").getByText(/Aucun modèle/).waitFor();
    await dev.locator(".model-pick select").selectOption("sonnet");
    await dev.locator("button.model-reco", { hasText: "Conseillé : Fable 5" }).waitFor();
    expect(hub.models.get("developer")).toBe("sonnet");
    await page.locator(".feed-list", { hasText: "Le Développeur passe de Fable 5 à Sonnet" }).waitFor();
    await page.screenshot({ path: join(shots, "studio-modeles.png") });
    await dev.locator("button.model-reco").click();
    await dev.locator(".model-reco.on").waitFor();
    expect(hub.models.get("developer")).toBe("fable");
    await page.screenshot({ path: join(shots, "studio-1-repos.png") });
  });

  it("au travail : chaque agent montre ce qu'il fait", async () => {
    exec.scripts.plan.push(async (_t, req) => {
      req.onEvent("tool", "Lit src/main.ts");
      await release.wait;
      return planOutput({});
    });
    const thread = hub.conversations.createThread(P, "Les boss");
    void hub.conversations.send(P, thread.id, "J'aimerais un moment de calme avant chaque boss").catch(() => {});
    fake.extractions.push([extracted({ title: "Calme avant les boss", quote: "un moment de calme" })]);
    const task = hub.tasks.create(sb.human(), P, { decisions: ["D-0001"] });
    await hub.tasks.startPlanning(P, task.id);

    for (const id of ["director", "archivist", "developer", "guardian"]) {
      await page.locator(`.agent-card.agent-${id}.state-working`).waitFor({ timeout: 8000 });
    }
    await page.locator(".agent-card.agent-developer").getByText("Lit src/main.ts").waitFor();
    await page.locator(".agent-card.agent-director").getByText("Vous répond dans « Les boss »").waitFor();
    await expect.poll(() => page.locator(".link-working").count()).toBeGreaterThanOrEqual(3);
    await page.waitForTimeout(700);
    await page.screenshot({ path: join(shots, "studio-2-au-travail.png") });
    await page.locator(".org").screenshot({ path: join(shots, "studio-3-organigramme.png") });

    // Filtre par projet : l'autre projet n'a personne au travail.
    await page.getByRole("button", { name: "Ombres du Nord" }).click();
    await expect.poll(() => page.locator(".agent-card.state-working").count()).toBe(0);
    await page.getByRole("button", { name: "Tous les projets" }).click();

    // En-tête du projet : l'équipe en action.
    await page.locator(".side-projects a", { hasText: "Destiny Survivor" }).click();
    await page.locator(".team-mini").first().waitFor();
    await page.screenshot({ path: join(shots, "studio-4-projet.png") });
  });

  it("quand tout est fini, l'équipe retourne au repos", async () => {
    release.open();
    await hub.conversations.idle();
    await page.goto(`${BASE}/#/direct`);
    await expect.poll(() => page.locator(".agent-card.agent-director.state-idle").count(), { timeout: 10_000 }).toBe(1);
    await expect.poll(() => page.locator(".agent-card.agent-archivist.state-idle").count(), { timeout: 10_000 }).toBe(1);
    // Le plan terminé attend votre validation.
    await page.locator(".agent-card.agent-you").getByText(/Valider le plan/).waitFor({ timeout: 10_000 });
    await page.locator(".feed-list").getByText(/Le directeur vous a répondu/).waitFor();
    await page.screenshot({ path: join(shots, "studio-5-fin.png") });
    expect(pageErrors).toEqual([]);
  });

  it("compteur d'utilisation, autonomie et décisions prises par le directeur", async () => {
    const reset = (h: number) => new Date(Date.now() + h * 3_600_000).toISOString();
    hub.usage.record({
      project: P,
      agent: "director",
      tokens: { input: 1200, output: 800, cacheRead: 40_000, cacheWrite: 3000 },
      costUsd: 0.02,
      limits: { status: "allowed_warning", windows: { five_hour: { utilization: 0.16, resetsAt: reset(3) }, seven_day: { utilization: 0.74, resetsAt: reset(60) } } },
    });
    // Une décision prise seul par le directeur (autonomie « équilibré »).
    hub.vision.capture(P, DIRECTOR, { type: "idea", title: "Calme", statement: "Calme avant le boss", source: msg("m", "z") });
    const { proposal } = hub.vision.submitProposal(P, DIRECTOR, {
      title: "Calme avant les boss",
      statement: "30 secondes de calme avant chaque boss.",
      source: { kind: "message", ref: "m" },
      details: { based_on: [hub.vision.list(P, { type: "idea" }).at(-1)!.id], summary: "Le joueur souffle 30 secondes avant chaque boss." },
    });
    const a = hub.approvals.recordDelegated({ project: P, subject: { kind: "proposal", id: proposal.id, hash: hub.vision.proposalHash(P, proposal.id) }, verdict: "approved", autonomy: "balanced", run: "test" });
    await hub.vision.decideProposal(P, a.id);

    await page.goto(`${BASE}/#/p/${P}/decisions`);
    await page.locator(".usage").getByText("74 %").waitFor();
    await page.locator(".delegated").getByText("Calme avant les boss").waitFor();
    await page.screenshot({ path: join(shots, "studio-6-decide-seul.png") });

    await page.getByRole("button", { name: /Autonomie : Équilibré/ }).click();
    await page.locator(".autonomy-menu").waitFor();
    await page.screenshot({ path: join(shots, "studio-7-autonomie.png") });
    await page.locator(".autonomy-option", { hasText: "Atelier" }).click();
    await page.getByRole("button", { name: /Autonomie : Atelier/ }).waitFor();
    expect(hub.projects.get(P).autonomy).toBe("workshop");

    // Revenir sur une décision du directeur.
    page.once("dialog", (d) => void d.accept());
    await page.locator(".delegated").getByRole("button", { name: "Revenir dessus" }).click();
    await expect.poll(() => hub.vision.list(P, { type: "decision", status: "abandoned" }).length).toBe(1);
    expect(pageErrors).toEqual([]);
  });

  it("discussion : le directeur vous pose un vrai choix en boutons ; la bible se lit par thème", async () => {
    hub.projects.setAutonomy(sb.human(), P, "balanced");
    // La proposition « Rythme des vagues » attend encore : on la retire pour ne garder que le choix.
    hub.vision.returnProposal(P, DIRECTOR, "P-0002");
    hub.vision.capture(P, DIRECTOR, { type: "mechanic", title: "Ennemis tirent aussi", statement: "Tirs ennemis", source: msg("m", "w") });
    const ennemis = hub.vision.list(P, { type: "mechanic" }).at(-1)!.id;
    hub.vision.submitProposal(P, DIRECTOR, {
      title: "Tirs des ennemis",
      statement: "Les ennemis tirent des orbes rouge-orangé à halo.",
      domain: ["ennemis"],
      nature: "creative",
      source: { kind: "message", ref: "m" },
      details: {
        based_on: [ennemis],
        summary: "Comment on reconnaît un tir ennemi d'un coup d'œil.",
        options: [
          { key: "A", label: "Orbes rouges à halo", statement: "Les ennemis tirent des orbes rouge-orangé à halo, bien distincts des balles du joueur.", tradeoffs: "Lisible, mais moins réaliste." },
          { key: "B", label: "Mêmes balles que le joueur", statement: "Les ennemis tirent les mêmes balles lumineuses que le joueur.", tradeoffs: "Cohérent, mais on confond les tirs." },
        ],
        recommended_option: "A",
      },
    });
    const thread = hub.conversations.createThread(P, "Tirs");
    await page.goto(`${BASE}/#/p/${P}/t/${thread.id}`);
    await page.getByRole("link", { name: /Discussion/ }).getByText("1 question(s)").waitFor();
    const choice = page.locator(".choice", { hasText: "Tirs des ennemis" });
    await choice.getByText("★ conseillé").waitFor();
    await page.screenshot({ path: join(shots, "studio-8-choix.png") });
    await choice.getByRole("button", { name: /Orbes rouges à halo/ }).click();
    await page.locator(".director-panel h2", { hasText: "Rien à trancher" }).waitFor();
    const decided = hub.vision.list(P, { type: "decision", status: "validated" }).find((d) => d.title === "Tirs des ennemis")!;
    expect(decided.statement).toMatch(/orbes rouge-orangé/);
    expect(decided.validated_by?.kind).toBe("human");

    await page.getByRole("link", { name: "Le jeu", exact: true }).click();
    await page.locator(".theme-title", { hasText: "Ennemis" }).waitFor();
    await page.screenshot({ path: join(shots, "studio-9-bible.png") });
    // Pas d'onglet « Décisions » en autonomie.
    expect(await page.locator(".project-tabs a", { hasText: "Décisions" }).count()).toBe(0);
    expect(pageErrors).toEqual([]);
  });
});
