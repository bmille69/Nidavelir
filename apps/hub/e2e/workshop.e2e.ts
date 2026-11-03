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
import { cleanupSandboxes, DIRECTOR, msg, sandbox, type Sandbox } from "../test/helpers.ts";

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
    // La consigne devient une carte « Proposition de chantier » (ADR-113) : titre et objectif en clair, la consigne complète repliée.
    const proposal = page.locator(".proposal-card", { hasText: "Balles lumineuses du fusil auto" });
    await proposal.waitFor({ timeout: 10_000 });
    await proposal.locator(".proposal-lbl", { hasText: "Proposition de chantier" }).waitFor();
    // Le lancement : une ligne discrète, qui mène au chantier.
    await page.locator(".msg .event", { hasText: "Chantier T-0001 « Balles lumineuses du fusil auto » lancé" }).waitFor({ timeout: 10_000 });
    await expect(page.locator(".msg .event a", { hasText: "T-0001" }).getAttribute("href")).resolves.toBe(`#/p/${P}/tasks/T-0001`);
    // Le chantier se suit à droite, dans « En cours » sous la boîte « À vous » (ADR-113).
    await page.locator(".inbox-rail .rail-runs .run", { hasText: "Balles lumineuses du fusil auto" }).waitFor();
    await proposal.locator("summary", { hasText: "Consigne complète pour le Développeur" }).click();
    await proposal.getByText(/Hors périmètre : armes énergétiques/).waitFor();
    await page.screenshot({ path: join(shots, "atelier-1-go.png") });
    // Le directeur connaissait le code : consignes du projet et fichiers dans son contexte.
    expect(fake.calls[0]!.systemPrompt).toMatch(/Le rendu ne modifie jamais la simulation[\s\S]*src\/render3d\/projectileView.ts/);

    finish();
    // Le testeur valide : le hub fusionne tout seul (ADR-31), sans clic de votre part.
    // Le compte rendu devient une carte (ADR-113) : fusionné, avis du Testeur en pastille, « ▶ Lancer le jeu », le technique replié.
    const report = page.locator(".report", { hasText: "Balles lumineuses du fusil auto" });
    await report.waitFor({ timeout: 15_000 });
    await report.locator(".report-st.ok", { hasText: "Fusionné dans le jeu" }).waitFor();
    await report.locator(".rc-pill", { hasText: /^Validé/ }).waitFor();
    await report.getByRole("button", { name: /Lancer le jeu/ }).waitFor();
    // Le texte complet reste accessible : sous « Détails techniques ».
    await report.locator(".report-tech summary").click();
    await report.locator(".report-tech", { hasText: "terminé, vérifié par le testeur et fusionné dans votre jeu" }).waitFor();
    await page.locator(".inbox-rail .merged-row", { hasText: "Balles lumineuses du fusil auto" }).waitFor({ timeout: 10_000 });
    await page.screenshot({ path: join(shots, "atelier-2-termine.png") });

    await page.goto(`${BASE}/#/p/${P}/tasks/T-0001`);
    await page.getByText(/Fusionné dans votre jeu/).waitFor({ timeout: 10_000 });
    expect(readFileSync(join(repo, "src/render3d/projectileView.ts"), "utf8")).toMatch(/0.12/);

    // « Le jeu » (ADR-113) : la bible en clair, l'état du jeu en rubriques repliables (le jargon atténué), et « Réalisé
    // récemment » d'après le compte rendu en clair du chantier. Le carnet est posé tel que le directeur l'écrit.
    const carnet = [
      "## Ce qui existe",
      "",
      "**Personnages** : Gardien Titan 3D (`guardian_titan.glb`, 56 px ; idle, run, jump, hurt). Chasseur, Arcaniste inchangés.",
      "**Armes, visée** : fusil auto Kinetic ; balles à noyau blanc-chaud, sillage de 0,12 s (`projectileView.ts`).",
      "**Carte « La Ligne Brisée »**",
      "- 134×134 cellules de 40 px, départ (87,87).",
      "- Quartiers : Barrage, Carrière, Forêt des Pins, Village.",
      "",
      "## Choix déjà faits",
      "",
      "- Le rendu ne modifie jamais la simulation.",
      "",
      "## Limites connues et reste à faire",
      "",
      "- Les tirs ennemis n'ont pas encore de sillage.",
    ].join("\n");
    hub.db.prepare("INSERT INTO game_state (project, text, updated_at, task) VALUES (?, ?, ?, ?) ON CONFLICT (project) DO UPDATE SET text = excluded.text, updated_at = excluded.updated_at, task = excluded.task").run(P, carnet, new Date().toISOString(), "T-0001");
    await page.goto(`${BASE}/#/p/${P}/vision`);
    await page.locator(".jeu-hero", { hasText: "La bible, en clair" }).waitFor();
    await page.locator(".gs-block h4", { hasText: "Ce qui existe dans le jeu" }).waitFor();
    // Le premier sujet est ouvert ; les noms de fichiers sont là, atténués, jusqu'à « Termes techniques : visibles ».
    await page.locator("details.gs[open]", { hasText: "Personnages" }).locator("code.j", { hasText: "guardian_titan.glb" }).waitFor();
    await page.locator("details.gs", { hasText: "Carte « La Ligne Brisée »" }).locator("summary").click();
    await page.locator(".gs-body li", { hasText: "Quartiers : Barrage" }).waitFor();
    await page.getByRole("button", { name: /Termes techniques : atténués/ }).click();
    await page.locator(".game-state.jargon-on").waitFor();
    const done = page.locator(".jeu-recent .tl li", { hasText: "Balles lumineuses du fusil auto" });
    await done.waitFor({ timeout: 10_000 });
    await expect(done.locator("a").getAttribute("href")).resolves.toBe(`#/p/${P}/tasks/T-0001`);
    await page.locator(".jeu-bible-h a", { hasText: "Toutes les décisions" }).waitFor();
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(shots, "jeu.png"), fullPage: true });
    await page.goto(`${BASE}/#/p/${P}/tasks/T-0001`);
    await page.getByText(/Fusionné dans votre jeu/).waitFor({ timeout: 10_000 });
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

  it("discussions : la bonne s'ouvre, un clic de trop ne crée rien, renommer, pastille quand le studio écrit ailleurs", async () => {
    const [first] = hub.conversations.listThreads(P);
    // Ouvrir le projet vous place sur la discussion la plus récemment active.
    await page.goto(`${BASE}/#/p/${P}`);
    await expect.poll(() => page.url()).toContain(`/t/${first!.id}`);
    await page.locator(".threads a.active", { hasText: "Les balles du perso" }).waitFor();

    // « Nouvelle discussion » : une page blanche, aucune discussion créée tant qu'on n'écrit pas.
    const before = hub.conversations.listThreads(P).length;
    await page.locator(".new-thread").click();
    await expect.poll(() => page.url()).toContain(`/p/${P}/nouvelle`);
    await page.locator(".new-thread.on").waitFor();
    expect(hub.conversations.listThreads(P).length).toBe(before);

    // Renommer la discussion en cours.
    await page.locator(".threads a", { hasText: "Les balles du perso" }).click();
    await page.getByRole("button", { name: "Renommer cette discussion" }).click();
    await page.locator(".thread-rename").fill("Tirs premium");
    await page.locator(".thread-rename").press("Enter");
    await page.locator(".threads a.active", { hasText: "Tirs premium" }).waitFor();
    expect(hub.conversations.getThread(P, first!.id).title).toBe("Tirs premium");

    // Un fil que le hub ouvre seul (intégrer un visuel) : rangé sous « Automatiques », replié (ADR-113).
    const integration = hub.conversations.createThread(P, "Intégrer A-0001 : Grouillot", "art");
    hub.conversations.notify(P, integration.id, "Je lance l'intégration du Grouillot.");
    const group = page.locator(".threads .t-toggle", { hasText: "Automatiques" });
    await group.waitFor({ timeout: 10_000 });
    await expect(group.getAttribute("aria-expanded")).resolves.toBe("false");
    await page.locator(".threads .t-group", { hasText: "Vos discussions" }).waitFor();
    expect(await page.locator(".threads a", { hasText: "Intégrer A-0001" }).count()).toBe(0);
    // La recherche cherche aussi dans les fils automatiques.
    await page.locator(".t-search input").fill("grouillot");
    await page.locator(".threads a", { hasText: "Intégrer A-0001 : Grouillot" }).waitFor();
    expect(await page.locator(".threads a", { hasText: "Tirs premium" }).count()).toBe(0);
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(shots, "discussions-recherche.png") });
    await page.locator(".t-search input").fill("");
    await group.click();
    await page.locator(".threads a", { hasText: "Intégrer A-0001 : Grouillot" }).waitFor();
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(shots, "discussions-automatiques.png") });
    await group.click();
    await expect(group.getAttribute("aria-expanded")).resolves.toBe("false");
    // Replié, le groupe dit qu'il y a du nouveau dedans.
    await group.locator(".count", { hasText: "1" }).waitFor();
    // Rouvrir le jeu : on arrive sur votre fil, pas sur le fil automatique, plus récent.
    await page.goto(`${BASE}/#/p/${P}`);
    await expect.poll(() => page.url()).toContain(`/t/${first!.id}`);
    await page.locator(".threads a.active", { hasText: "Tirs premium" }).waitFor();

    // Le studio écrit dans une autre discussion (ex. le Concepteur transmet) : pastille et bandeau.
    const other = hub.conversations.createThread(P, "Conception : Résolution en 3D");
    hub.conversations.notify(P, other.id, "Conception transmise : 6 chantiers.");
    await page.locator(".threads li.has-news", { hasText: "Conception : Résolution en 3D" }).locator(".count").getByText("1").waitFor({ timeout: 10_000 });
    await page.locator(".thread-news", { hasText: "Du nouveau dans « Conception : Résolution en 3D » (1)" }).waitFor();
    await page.screenshot({ path: join(shots, "discussions-pastille.png") });
    await page.locator(".thread-news a").click();
    await page.locator(".threads a.active", { hasText: "Conception : Résolution en 3D" }).waitFor();
    await expect.poll(() => page.locator(".threads li.has-news").count()).toBe(0);
    expect(pageErrors).toEqual([]);
  });

  it("« À vous » : le Gardien, un chantier à relire et un choix du directeur, tranchés sur place (ADR-113)", async () => {
    // Un chantier que le testeur refuse trois fois : il attend votre mot.
    const thread = hub.conversations.createThread(P, "Le HUD").id;
    fake.replies.push(["Je refais le viseur.", "[[CHANTIER: Viseur plus lisible]]", "Objectif : un viseur lisible.", "Où : src/render3d/projectileView.ts.", "[[/CHANTIER]]"].join("\n"));
    for (let k = 0; k < 3; k++)
      exec.scripts.execute.push(async (t) => {
        await t.write("src/render3d/projectileView.ts", `export const crosshair = ${2 + k};\n`);
        return REPORT;
      });
    const FAIL = { ...VERIFIED, verdict: "fail", summary_simple: "Le viseur déborde à droite de l'écran.", checks: [{ criterion: "Viseur centré", result: "fail", evidence: "décalé de 12 px" }], recommendation: "request_changes" };
    for (let k = 0; k < 3; k++) exec.scripts.verify.push(() => FAIL);
    await hub.conversations.send(P, thread, "Le viseur est illisible. go");
    await page.goto(`${BASE}/#/p/${P}/t/${thread}`);
    const rail = page.locator(".inbox-rail");
    const review = rail.locator('.dcard[data-inbox="review"]', { hasText: "Viseur plus lisible" });
    await review.waitFor({ timeout: 30_000 });
    const task = hub.tasks.list(P).find((t) => t.title === "Viseur plus lisible")!;

    // Le Gardien d'abord, en braise, avec le vrai compte à rebours. (En atelier il autorise seul ce qui est sans danger ;
    // il demande après une compétence externe, ADR-105 : la demande est posée telle que le hub l'enregistre.)
    const at = new Date().toISOString();
    hub.db
      .prepare("INSERT INTO escalations (id, project, task, run, status, data_json, created_at) VALUES ('E-0001', ?, ?, 'RUN-0099', 'pending', ?, ?)")
      .run(P, task.id, JSON.stringify({ id: "E-0001", project: P, task: task.id, run: "RUN-0099", tool: "Bash", summary: "Installer la bibliothèque three-mesh-bvh", input: { command: "npm i three-mesh-bvh" }, reason: "commande non prévue dans le plan, après la compétence externe perf-3d", status: "pending", created_at: at, decided_at: null }), at);
    const esc = rail.locator('.dcard.urgent[data-inbox="escalation"]');
    await esc.waitFor({ timeout: 15_000 });
    await expect(esc.locator(".countdown").textContent()).resolves.toMatch(/Sans réponse dans 1[45] min/);
    await expect(rail.locator(".dcard").first().getAttribute("data-inbox")).resolves.toBe("escalation");
    await page.locator(".project-tabs a", { hasText: "Discussion" }).locator(".tab-count.pulse").waitFor();
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(shots, "projet-gardien.png") });
    await esc.getByRole("button", { name: "Refuser" }).click();
    await esc.waitFor({ state: "detached" });
    expect(hub.tasks.escalations(P).map((e) => e.status)).toEqual(["denied"]);

    // Une vraie question du directeur, à options, et le chantier qui attend votre mot.
    hub.vision.capture(P, DIRECTOR, { type: "mechanic", title: "Fin de mission", statement: "Montrer la fin de mission", source: msg("m", "fin") });
    hub.vision.submitProposal(P, DIRECTOR, {
      title: "Fin de mission : comment la montrer ?",
      statement: "Un bandeau en haut et un ralenti d'une seconde.",
      nature: "creative",
      source: { kind: "message", ref: "m" },
      details: {
        based_on: [hub.vision.list(P, { type: "mechanic" }).at(-1)!.id],
        summary: "Le directeur hésite entre deux versions.",
        options: [
          { key: "A", label: "Écran de victoire plein écran", statement: "Score, butin et bouton « Continuer ».", tradeoffs: "Coupe l'action." },
          { key: "B", label: "Bandeau et ralenti", statement: "Un bandeau en haut et un ralenti d'une seconde.", tradeoffs: "Moins de place pour le butin." },
        ],
        recommended_option: "B",
      },
    });
    await review.locator(".tester", { hasText: "Le viseur déborde" }).waitFor();
    const choice = rail.locator('.dcard[data-inbox="proposal"]', { hasText: "Fin de mission" });
    await choice.getByText("★ conseillé").waitFor();
    // Le plus urgent en haut : le chantier à relire avant la question.
    await expect(rail.locator(".dcard").evaluateAll((cards) => cards.map((c) => c.getAttribute("data-inbox")))).resolves.toEqual(["review", "proposal"]);
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(shots, "projet-discussion.png") });

    // Au téléphone : « À vous » d'abord, sans faire défiler la conversation.
    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: "fr-FR", isMobile: true, hasTouch: true });
    phone.on("pageerror", (e) => pageErrors.push(e.message));
    await phone.goto(`${BASE}/login?token=${hub.sessions.createLoginToken()}`);
    await phone.goto(`${BASE}/#/p/${P}/t/${thread}`);
    await phone.locator(".pane-switch button.on", { hasText: /À vous/ }).waitFor();
    await phone.locator('.inbox-rail .dcard[data-inbox="review"]').waitFor();
    expect(await phone.locator(".conversation").isVisible()).toBe(false);
    expect(await phone.locator(".project-tabbar .tab-item", { hasText: "Récap" }).isVisible()).toBe(true);
    expect(await phone.evaluate("document.documentElement.scrollWidth <= window.innerWidth + 1")).toBe(true);
    await phone.waitForTimeout(350);
    await phone.screenshot({ path: join(shots, "projet-telephone.png") });
    await phone.locator(".pane-switch button", { hasText: "Conversation" }).click();
    await phone.locator(".project.pane-chat .composer").waitFor();
    await phone.close();

    // Trancher la question : la carte s'efface.
    await choice.getByRole("button", { name: /Bandeau et ralenti/ }).click();
    await choice.waitFor({ state: "detached" });
    expect(hub.vision.list(P, { type: "decision", status: "validated" }).find((d) => d.title.startsWith("Fin de mission"))?.validated_by?.kind).toBe("human");

    // Fusionner depuis la boîte : le chantier passe dans « Récemment fusionné ».
    await review.getByRole("button", { name: "Fusionner" }).click();
    await page.locator(".inbox-toast", { hasText: "fusionné dans votre jeu" }).waitFor();
    await review.waitFor({ state: "detached" });
    await expect.poll(() => hub.tasks.list(P).find((t) => t.title === "Viseur plus lisible")?.status).toBe("merged");
    expect(readFileSync(join(repo, "src/render3d/projectileView.ts"), "utf8")).toMatch(/crosshair = 4/);
    await rail.locator(".merged-row", { hasText: "Viseur plus lisible" }).waitFor();
    await rail.locator(".inbox-empty", { hasText: "Rien ne vous attend" }).waitFor();
    await page.waitForTimeout(350);
    await page.screenshot({ path: join(shots, "projet-vide.png") });
    expect(pageErrors).toEqual([]);
  }, 90_000);
});
