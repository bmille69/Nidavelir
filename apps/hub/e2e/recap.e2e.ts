/**
 * Le Récap des chantiers dans un vrai navigateur (ADR-113) : les chiffres de la période, les filtres, le panneau de détail,
 * « Tout le détail », l'ancienne adresse de la liste, « Raconter la semaine », la photo « en jeu » du Testeur, le téléphone.
 */
import type { FastifyInstance } from "fastify";
import { mkdirSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { writeManifest, type Asset } from "../src/art/manifest.ts";
import { createHub, type Hub } from "../src/hub.ts";
import { inGameShotPath } from "../src/quality/checks.ts";
import { buildServer } from "../src/server/http.ts";
import { FakeOrchestrator } from "../test/fake-orchestrator.ts";
import { cleanupSandboxes, fakeClock, sandbox, type Sandbox } from "../test/helpers.ts";

const PORT = 4405;
const BASE = `http://127.0.0.1:${PORT}`;
const webDist = process.env.STUDIO_WEB_DIST ?? resolve(fileURLToPath(new URL("../../web/dist", import.meta.url)));
const shots = process.env.STUDIO_SCREENSHOTS ?? join(process.cwd(), ".data", "screenshots");
const P = "destiny";

let sb: Sandbox;
let hub: Hub;
let app: FastifyInstance;
let browser: Browser;
let page: Page;
let thread: string;
const fake = new FakeOrchestrator();
const pageErrors: string[] = [];

// Les dates suivent la vraie horloge : le navigateur dit « Cette semaine » d'après elle.
const NOW = Date.now();
const today = new Date(NOW);
const MONDAY = new Date(today.getFullYear(), today.getMonth(), today.getDate() - ((today.getDay() + 6) % 7)).getTime();
const iso = (t: number) => new Date(t).toISOString();
const thisWeek = (minutesAgo: number) => iso(Math.max(MONDAY + 60_000, NOW - minutesAgo * 60_000));
const lastWeek = (hours: number) => iso(MONDAY - 3 * 86_400_000 + hours * 3_600_000);

function seedTask(id: string, title: string, status: string, at: string, extra: Record<string, unknown> = {}) {
  const task = { id, project: P, title, goal: `Objectif : ${title}`, authorized_by: [], origin: null, direct: true, queued_at: null, reworks: [], scope: null, status, feedback: [], base_commit: null, branch: null, worktree: null, plan: null, created_at: at, updated_at: at, ...extra };
  hub.db.prepare("INSERT INTO tasks (id, project, status, data_json, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, P, status, JSON.stringify(task), at);
}
let runs = 0;
function seedRun(task: string, kind: "execute" | "verify", start: string, minutes: number, cost: number, result: unknown, error: string | null = null) {
  hub.db
    .prepare("INSERT INTO runs (id, project, task, kind, status, token_hash, started_at, finished_at, cost_usd, error, result_json) VALUES (?, ?, ?, ?, ?, 'x', ?, ?, ?, ?, ?)")
    .run(`RUN-${String(++runs).padStart(4, "0")}`, P, task, kind, error ? "failed" : "done", start, iso(Date.parse(start) + minutes * 60_000), cost, error, JSON.stringify(result));
}
function event(type: string, subject: string, at: string, payload: Record<string, unknown> = {}) {
  hub.db.prepare("INSERT INTO events (at, project, actor_json, type, subject, payload_json) VALUES (?, ?, '{\"kind\":\"system\"}', ?, ?, ?)").run(at, P, type, subject, JSON.stringify(payload));
}
const report = (simple: string, how: string[] = []) => ({ report: { outcome: "completed", summary: `Détail technique : ${simple} Fichiers src/mission.ts et src/map.ts.`, summary_simple: simple, deviations: [], open_issues: [], how_to_test: how } });
const verified = (verdict: string, simple: string, played?: string) => ({
  verification: { verdict, summary_simple: simple, checks: [], decision_compliance: [], hidden_assumptions: [], regressions: [], recommendation: "merge", ...(played ? { playtest: { played: true, summary: played, unverified: ["le téléphone"] } } : {}) },
});
const asset = (id: string): Asset => ({ id, name: `Visuel ${id}`, type: "sprite", usage: "x", specs: "", status: "integre", prompts: [], refs: [], renders: [], verdict: null, created_at: thisWeek(60), updated_at: thisWeek(60) });

/** Une image du « jeu », dessinée par le navigateur : le menu d'accueil (lancement) ou une scène de mission (en jeu). */
async function paint(file: string, kind: "menu" | "scene", label: string, at: number) {
  const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const body =
    kind === "menu"
      ? `<div style="position:absolute;left:80px;top:120px;font:800 72px sans-serif;color:#e8eef8;letter-spacing:4px">DESTINY<br>SURVIVOR</div><div style="position:absolute;left:84px;top:330px;padding:14px 28px;background:#d9b56b;color:#111;font:700 24px sans-serif">LANCER LA MISSION</div>`
      : `<div style="position:absolute;inset:0;background:radial-gradient(60% 60% at 60% 55%,#2f6b5a,#0c1a22)"></div><div style="position:absolute;left:640px;top:330px;width:46px;height:46px;border-radius:50%;background:#7fe3ff;box-shadow:0 0 40px #7fe3ff"></div>${[...Array(9)].map((_, k) => `<div style="position:absolute;left:${200 + k * 110}px;top:${180 + ((k * 97) % 300)}px;width:26px;height:26px;background:#c44;border-radius:6px"></div>`).join("")}`;
  await p.setContent(`<body style="margin:0;background:#0b0f17;overflow:hidden">${body}<div style="position:absolute;left:24px;bottom:20px;font:600 22px sans-serif;color:#fff;background:rgba(0,0,0,.5);padding:6px 12px">${label}</div></body>`);
  await p.screenshot({ path: file, type: file.endsWith(".png") ? "png" : "jpeg" });
  await p.close();
  utimesSync(file, at / 1000, at / 1000);
}

beforeAll(async () => {
  mkdirSync(shots, { recursive: true });
  sb = sandbox();
  sb.hub.close();
  const dataDir = join(sb.dir, "hub/.data");
  hub = createHub({
    databasePath: join(dataDir, "e2e.db"),
    registry: { forbiddenTrees: [join(sb.dir, "hub")], forbiddenExact: [sb.dir] },
    clock: fakeClock(NOW),
    orchestrator: fake,
    dataDir,
    // Les vérifications du hub ne tournent pas ici ; elles donnent seulement l'endroit des captures.
    checker: { tests: async () => ({ status: "none", detail: "" }), launch: async () => ({ status: "none", detail: "" }) },
  });
  sb.hub = hub;
  const repo = sb.makeGameRepo("games/destiny", { "README.md": "# Destiny Survivor\n" });
  await hub.projects.register(sb.human(), { path: repo, slug: P, name: "Destiny Survivor" });
  hub.projects.setAutonomy(sb.human(), P, "workshop");
  thread = hub.conversations.createThread(P, "Les missions de la Campagne").id;

  // Cette semaine : deux fusions (dont une correction), un échec, un chantier à relire, un brouillon.
  seedTask("T-0001", "Missions jouables sur leur carte, sans adresse spéciale", "merged", thisWeek(90), { origin: { thread } });
  seedRun("T-0001", "execute", thisWeek(90), 7, 0.62, report("La première mission de la Campagne se joue maintenant sur la carte de la Ligne Brisée.", ["Lancer le jeu", "Campagne, « Premiers pas », puis Lancer", "Purger la place, escorter le convoi"]));
  seedRun("T-0001", "verify", thisWeek(80), 2, 0.1, verified("pass_with_notes", "La mission se lance depuis la Campagne. Les tests passent ; je n'ai pas vérifié les déplacements au téléphone.", "J'ai lancé la mission 1 et vu la mini-carte."));
  event("task.merged", "T-0001", thisWeek(70));
  seedTask("T-0002", "Mesure de performance et LOD si nécessaire", "failed", thisWeek(50));
  seedRun("T-0002", "execute", thisWeek(50), 37, 0.4, null, "le build ne passe pas après 3 essais");
  seedTask("T-0005", "Roche contre béton : falaises moins claires", "merged", thisWeek(40), { reworks: ["T-0003"] });
  seedRun("T-0005", "execute", thisWeek(40), 12, 0.31, report("La roche des falaises est plus sombre, le béton se distingue mieux."));
  seedRun("T-0005", "verify", thisWeek(35), 2, 0.05, verified("pass", "La roche est plus sombre, les tests passent."));
  event("task.merged", "T-0005", thisWeek(30));
  seedTask("T-0006", "Écran de victoire avec le score", "review", thisWeek(20));
  seedRun("T-0006", "execute", thisWeek(20), 9, 0.2, report("Une victoire affiche le score et « Rejouer »."));
  seedTask("T-0007", "Sons des tirs", "draft", thisWeek(10));
  // La semaine dernière : une fusion après une correction, reprise ensuite par T-0005.
  seedTask("T-0003", "Faces de falaise en strates", "merged", lastWeek(10));
  seedRun("T-0003", "execute", lastWeek(10), 49, 0.84, report("Sur la Ligne Brisée, les parois du relief ont maintenant de la matière."));
  event("task.changes_requested", "T-0003", lastWeek(11));
  event("task.merged", "T-0003", lastWeek(12));
  writeManifest(repo, { version: 1, assets: [asset("A-0001"), asset("A-0002")] });
  event("art.asset_integrated", "A-0001", thisWeek(60), { task: "T-0001" });
  event("art.asset_integrated", "A-0002", thisWeek(60), { task: "T-0001" });

  app = await buildServer(hub, { port: PORT, gamesRoot: join(sb.dir, "games"), allowedHosts: [`127.0.0.1:${PORT}`], folderPicker: { pick: async () => null }, webDist });
  await app.listen({ host: "127.0.0.1", port: PORT });
  browser = await chromium.launch({ channel: "msedge", headless: true });

  // Les captures : le menu pris au lancement par le hub, puis la photo « en jeu » du Testeur, plus récente (T-0001).
  const dir = join(dataDir, "shots", P);
  mkdirSync(dir, { recursive: true });
  await paint(join(dir, "T-0001.png"), "menu", "Capture du lancement", NOW - 85 * 60_000);
  await paint(inGameShotPath(join(dataDir, "shots"), P, "T-0001"), "scene", "Mission 1 · la Ligne Brisée (photo en jeu)", NOW - 80 * 60_000);
  await paint(join(dir, "T-0005.png"), "menu", "Capture du lancement", NOW - 36 * 60_000);
  await paint(join(dir, "T-0003.png"), "menu", "Capture du lancement", NOW - 4 * 86_400_000);

  page = await browser.newPage({ viewport: { width: 1400, height: 950 }, locale: "fr-FR" });
  page.on("dialog", (d) => void d.accept());
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(`${BASE}/login?token=${hub.sessions.createLoginToken()}`);
});

afterEach(async (ctx) => {
  if (ctx.task.result?.state === "fail" && page) {
    if (pageErrors.length) console.error(`Erreurs du navigateur :\n${pageErrors.join("\n")}`);
    await page.screenshot({ path: join(shots, `ECHEC-recap-${ctx.task.name.slice(0, 25).replace(/[^\w]+/g, "_")}.png`) });
  }
});

afterAll(async () => {
  await browser?.close();
  await app?.close();
  cleanupSandboxes();
});

const shot = async (name: string, p: Page = page) => {
  await p.waitForTimeout(350);
  await p.screenshot({ path: join(shots, `${name}.png`) });
};
const kpi = (label: string, p: Page = page) => p.locator(".recap-kpi", { hasText: label }).locator("b");
const card = (id: string, p: Page = page) => p.locator(".rc-card").filter({ has: p.locator(".rc-k > span:first-child", { hasText: new RegExp(`^${id}$`) }) });

describe("le Récap des chantiers", () => {
  it("les chiffres de cette semaine et les chantiers par semaine, la photo « en jeu » en priorité", async () => {
    await page.goto(`${BASE}/#/p/${P}/recap`);
    await page.getByRole("heading", { name: "Récap des chantiers" }).waitFor();
    await expect(page.locator(".project-tabs a.active").textContent()).resolves.toBe("Récap");
    await expect.poll(() => kpi("Fusionnés").textContent()).toBe("2");
    await expect.poll(() => kpi("Échecs et abandons").textContent()).toBe("1");
    await expect.poll(() => kpi("Coût total").textContent()).toBe("1,68 $");
    await expect.poll(() => kpi("Réussis du premier coup").textContent()).toBe("100 %");
    await expect.poll(() => kpi("Visuels intégrés").textContent()).toBe("2");
    expect(await page.locator(".recap-seg button.on").textContent()).toBe("Cette semaine");
    // Deux semaines, la plus récente d'abord.
    await expect(page.locator(".recap-week-h h3").allTextContents()).resolves.toEqual(["Cette semaine", "La semaine dernière"]);
    expect(await page.locator(".recap-chip", { hasText: "Tous" }).locator(".n").textContent()).toBe("6");
    // T-0001 montre la photo prise en jeu par le Testeur ; T-0005 la capture du lancement.
    await expect.poll(() => card("T-0001").locator(".rc-tag").textContent()).toBe("photo en jeu");
    expect(await card("T-0005").locator(".rc-tag").count()).toBe(0);
    const inGame = await page.request.get(`${BASE}/api/human/projects/${P}/tasks/T-0001/screenshot`);
    expect(inGame.headers()["content-type"]).toBe("image/jpeg");
    expect((await page.request.get(`${BASE}/api/human/projects/${P}/tasks/T-0005/screenshot`)).headers()["content-type"]).toBe("image/png");
    // Ce qui vous attend est en braise (à relire), le reste non.
    expect(await card("T-0006").locator(".rc-pill.ember").textContent()).toBe("À relire");
    expect(await card("T-0007").locator(".rc-pill.ember").count()).toBe(0);
    await page.evaluate("document.querySelectorAll('img').forEach((i) => (i.loading = 'eager'))");
    await expect.poll(() => page.evaluate("[...document.querySelectorAll('.rc-shot img')].every((i) => i.complete)")).toBe(true);
    await shot("recap-1-bureau");
  });

  it("les filtres, la période et l'ancienne adresse de la liste", async () => {
    await page.locator(".recap-chip", { hasText: "Échecs et abandons" }).click();
    await expect.poll(() => page.locator(".rc-card").count()).toBe(1);
    expect(await card("T-0002").locator(".rc-pill.fail").textContent()).toBe("Échec");
    expect(await card("T-0002").textContent()).toContain("Aucun changement : le chantier n'est pas allé au bout.");
    await shot("recap-2-echecs");
    await page.locator(".recap-chip", { hasText: "Fusionnés" }).click();
    await expect.poll(() => page.locator(".rc-card").count()).toBe(3);
    await page.locator(".recap-chip", { hasText: "Tous" }).click();
    // La semaine dernière : une fusion, après une correction.
    await page.locator(".recap-seg button", { hasText: "Semaine dernière" }).click();
    await expect.poll(() => kpi("Fusionnés").textContent()).toBe("1");
    await expect.poll(() => kpi("Réussis du premier coup").textContent()).toBe("0 %");
    expect(await card("T-0003").textContent()).toContain("corrigé par T-0005");
    await page.locator(".recap-seg button", { hasText: "Cette semaine" }).click();
    // L'ancienne liste des chantiers ouvre le Récap sur « En cours ».
    await page.goto(`${BASE}/#/p/${P}/tasks`);
    await page.getByRole("heading", { name: "En cours maintenant" }).waitFor();
    expect(await page.locator(".recap-chip.on").textContent()).toMatch(/^En cours/);
    await expect.poll(() => page.locator(".rc-card").count()).toBe(2);
    expect(await card("T-0007").textContent()).toContain("Prêt à lancer");
    // Les plans de production restent à un clic.
    expect(await page.locator(".project-subtabs a", { hasText: "Plans de production" }).isVisible()).toBe(true);
  });

  it("une carte ouvre le détail ; « Tout le détail » mène à la page complète du chantier", async () => {
    await page.goto(`${BASE}/#/p/${P}/recap`);
    await card("T-0001").click();
    const drawer = page.locator(".rc-drawer");
    await drawer.getByRole("heading", { name: "Missions jouables sur leur carte, sans adresse spéciale" }).waitFor();
    expect(await drawer.textContent()).toContain("La mission se lance depuis la Campagne.");
    expect(await drawer.textContent()).toContain("▶ Essayé en jouant : J'ai lancé la mission 1 et vu la mini-carte.");
    expect(await drawer.locator(".rc-sec ol li").count()).toBe(3);
    expect(await drawer.locator(".rc-pill.ok").first().textContent()).toMatch(/^Fusionné le /);
    expect(await drawer.locator(".rc-origin").getAttribute("href")).toBe(`#/p/${P}/t/${thread}`);
    expect(await drawer.locator(".rc-origin b").textContent()).toBe("Les missions de la Campagne");
    // Les détails techniques sont repliés.
    expect(await drawer.locator(".rc-tech > div").isVisible()).toBe(false);
    await expect(drawer.getByRole("button", { name: "Demander une retouche" }).isVisible()).resolves.toBe(true);
    await shot("recap-3-detail");
    // Suivant : le chantier d'après dans la liste.
    await drawer.getByRole("button", { name: "Chantier suivant" }).click();
    await expect.poll(() => drawer.locator(".rc-d-h .k").textContent()).toMatch(/^T-0003/);
    await page.keyboard.press("Escape");
    await expect.poll(() => drawer.count()).toBe(0);

    // Un échec : relancer ou abandonner depuis le panneau.
    await card("T-0002").click();
    await drawer.getByRole("button", { name: "Relancer" }).waitFor();
    expect(await drawer.textContent()).toContain("le build ne passe pas après 3 essais");
    await page.keyboard.press("Escape");

    await card("T-0001").click();
    await drawer.getByRole("link", { name: /Tout le détail/ }).click();
    await page.waitForURL(`${BASE}/#/p/${P}/tasks/T-0001`);
    // Le panneau disparaît, la page détail prend sa place.
    await page.locator(".task-detail-nav a", { hasText: "Récap des chantiers" }).waitFor();
    await expect.poll(() => page.locator(".rc-drawer").count()).toBe(0);
    await page.locator(".task-detail").getByRole("heading", { name: "Missions jouables sur leur carte, sans adresse spéciale" }).waitFor();
    await expect(page.locator(".project-tabs a.active").textContent()).resolves.toBe("Récap");
    await shot("recap-4-tout-le-detail");
    await page.locator(".task-detail-nav a", { hasText: "Récap des chantiers" }).click();
    await page.getByRole("heading", { name: "Récap des chantiers" }).waitFor();
  });

  it("« Raconter la semaine » : le journal de bord, raconté par le directeur", async () => {
    await page.getByRole("button", { name: "Raconter la semaine" }).click();
    const story = page.locator(".rc-story");
    // Le directeur (factice ici) écrit le récit à l'ouverture ; le journal de bord le garde.
    await story.getByText(/^Raconté par le directeur le /).waitFor({ timeout: 10_000 });
    const told = await story.locator("p").first().textContent();
    expect(told).toBeTruthy();
    await shot("recap-5-recit");
    await story.getByRole("button", { name: "Fermer" }).click();
    await expect.poll(() => story.count()).toBe(0);
    // Le récit est gardé par le journal de bord : il revient sans rappeler le directeur.
    await page.getByRole("button", { name: "Raconter la semaine" }).click();
    await story.getByText(told!).waitFor();
    expect(await story.getByText("Le directeur écrit…").count()).toBe(0);
    await page.keyboard.press("Escape");
    expect(pageErrors).toEqual([]);
  });

  it("le compte rendu dans la discussion : une carte en clair, la photo en jeu, le technique replié (ADR-113)", async () => {
    // Le texte tel que le directeur l'écrit à la fin d'un chantier (autopilot.ts), puis un lancement.
    const report = [
      "✓ Chantier T-0001 « Missions jouables sur leur carte, sans adresse spéciale » terminé, vérifié par le testeur et fusionné dans votre jeu.",
      "",
      "Ce qui a changé : La première mission de la Campagne se joue maintenant sur la carte de la Ligne Brisée.",
      "",
      "Avis du testeur : Tout passe ; la mission se lance depuis la Campagne.",
      "  ▶ Essayé en jouant : purgé la place, escorté le convoi.",
      "  Pas vérifié en jeu : le combat contre l'Ogre",
      "",
      "§CAPTURE§ T-0001 v1",
      "",
      "Pour essayer :",
      "  1. Campagne, « Premiers pas », puis Lancer",
      "",
      "Coût de ce chantier : environ 0,62 $ (équivalent API, pris sur votre abonnement).",
      "",
      "C'est dans votre jeu (annulable avec Git). « ▶ Lancer le jeu » à droite pour essayer ; un 👍 ou 👎 aide à juger le studio.",
    ].join("\n");
    hub.conversations.notify(P, thread, report);
    hub.conversations.notify(P, thread, "→ Chantier T-0006 « Écran de victoire » lancé : le développeur est au travail (suivi en direct à droite). Je vous préviens ici quand c'est prêt.");
    await page.goto(`${BASE}/#/p/${P}/t/${thread}`);
    const card = page.locator(".report", { hasText: "Missions jouables sur leur carte" });
    await card.waitFor({ timeout: 10_000 });
    await card.locator(".report-st.ok", { hasText: "Fusionné dans le jeu" }).waitFor();
    await card.locator(".rc-pill", { hasText: "Validé, remarques" }).waitFor();
    await card.locator(".plain", { hasText: "La première mission de la Campagne" }).waitFor();
    // La photo « en jeu » du Testeur (partie 2), servie par la route de capture du chantier.
    await expect.poll(() => page.evaluate("[...document.querySelectorAll('.report-shot img')].every((i) => i.complete && i.naturalWidth > 0)")).toBe(true);
    await expect(card.locator("a", { hasText: "Voir le chantier" }).getAttribute("href")).resolves.toBe(`#/p/${P}/tasks/T-0001`);
    expect(await card.getByText(/Essayé en jouant/).isVisible()).toBe(false);
    await card.locator(".report-tech summary").click();
    await card.locator(".report-tech", { hasText: "Essayé en jouant : purgé la place" }).waitFor();
    await card.locator(".report-tech summary").click();
    // Le lancement : une ligne discrète, sans avatar.
    await page.locator(".msg.event-only .event", { hasText: "T-0006 « Écran de victoire »" }).waitFor();
    await shot("discussion-compte-rendu");

    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "fr-FR" });
    try {
      await phone.goto(`${BASE}/login?token=${hub.sessions.createLoginToken()}`);
      await phone.goto(`${BASE}/#/p/${P}/t/${thread}`);
      await phone.locator(".pane-switch button", { hasText: "Conversation" }).click();
      await phone.locator(".report .report-shot img").scrollIntoViewIfNeeded();
      expect(await phone.evaluate("document.documentElement.scrollWidth")).toBeLessThanOrEqual(390);
      await shot("telephone-compte-rendu", phone);
    } finally {
      await phone.close();
    }
    expect(pageErrors).toEqual([]);
  });

  it("au téléphone : les chiffres en deux colonnes, le détail en plein écran", async () => {
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "fr-FR" });
    try {
      await phone.goto(`${BASE}/login?token=${hub.sessions.createLoginToken()}`);
      await phone.goto(`${BASE}/#/p/${P}/recap`);
      await phone.getByRole("heading", { name: "Récap des chantiers" }).waitFor();
      expect(await phone.locator(".project-tabbar .tab-item.active").textContent()).toContain("Récap");
      await expect.poll(() => kpi("Fusionnés", phone).textContent()).toBe("2");
      // Rien ne déborde de l'écran.
      expect(await phone.evaluate("document.documentElement.scrollWidth")).toBeLessThanOrEqual(390);
      await shot("recap-6-telephone", phone);
      await card("T-0001", phone).tap();
      const drawer = phone.locator(".rc-drawer");
      await drawer.getByRole("heading", { name: "Missions jouables sur leur carte, sans adresse spéciale" }).waitFor();
      // Plein écran, une fois arrivé (il glisse depuis la droite).
      await expect.poll(async () => Math.round((await drawer.boundingBox())!.x)).toBe(0);
      expect(Math.round((await drawer.boundingBox())!.width)).toBe(390);
      await shot("recap-7-telephone-detail", phone);
    } finally {
      await phone.close();
    }
  });
});
