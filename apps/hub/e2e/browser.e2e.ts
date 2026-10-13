/**
 * Parcours complet dans un vrai navigateur (Edge installé), avec l'orchestrateur
 * factice : discussion → regroupement → validation modifiée → vision → « Pourquoi ? ».
 * Lancer : npm run build && npm run test:e2e   (captures dans STUDIO_SCREENSHOTS)
 */
import type { FastifyInstance } from "fastify";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { buildServer } from "../src/server/http.ts";
import { extracted, FakeOrchestrator } from "../test/fake-orchestrator.ts";
import { cleanupSandboxes, DIRECTOR, git, msg, sandbox, type Sandbox } from "../test/helpers.ts";

const PORT = 4391;
const BASE = `http://127.0.0.1:${PORT}`;
const webDist = resolve(fileURLToPath(new URL("../../web/dist", import.meta.url)));
const shots = process.env.STUDIO_SCREENSHOTS ?? join(process.cwd(), ".data", "screenshots");

let sb: Sandbox;
let fake: FakeOrchestrator;
let app: FastifyInstance;
let browser: Browser;
let page: Page;
let root: string;
const pageErrors: string[] = [];

beforeAll(async () => {
  mkdirSync(shots, { recursive: true });
  fake = new FakeOrchestrator();
  sb = sandbox(fake);
  root = sb.makeGameRepo("games/destiny", { "README.md": "# Destiny Survivor\n", "package.json": "{}" });
  await sb.hub.projects.register(sb.human(), { path: root, slug: "destiny", name: "Destiny Survivor" });
  const notes = [
    ["Le boss surgit à l'approche de son arène", "boss"],
    ["Pas de boss au minuteur", "boss"],
    ["L'Ogre attend en fin de zone", "boss"],
    ["Trois vagues par niveau", "rythme"],
  ];
  for (const [t, d] of notes) {
    sb.hub.vision.capture("destiny", DIRECTOR, { type: "mechanic", title: t!, statement: t!, source: { kind: "file", ref: "docs/balance-decisions.md#L12", quote: t! }, domain: [d!] });
  }
  app = await buildServer(sb.hub, {
    port: PORT,
    gamesRoot: join(sb.dir, "games"),
    allowedHosts: [`127.0.0.1:${PORT}`],
    folderPicker: { pick: async () => null },
    webDist,
  });
  await app.listen({ host: "127.0.0.1", port: PORT });
  browser = await chromium.launch({ channel: "msedge", headless: true });
  page = await browser.newPage({ viewport: { width: 1400, height: 900 }, locale: "fr-FR" });
  page.on("dialog", (d) => void d.accept());
  page.on("pageerror", (e) => pageErrors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") pageErrors.push(m.text());
  });
});

afterEach(async (ctx) => {
  if (ctx.task.result?.state === "fail" && page) {
    if (pageErrors.length) console.error(`Erreurs du navigateur :\n${pageErrors.join("\n")}`);
    await page.screenshot({ path: join(shots, `ECHEC-${ctx.task.name.slice(0, 30).replace(/[^\w]+/g, "_")}.png`) });
  }
});

afterAll(async () => {
  await browser?.close();
  await app?.close();
  cleanupSandboxes();
});

const shot = (name: string) => page.screenshot({ path: join(shots, `${name}.png`), fullPage: false });

describe("parcours navigateur", () => {
  it("connexion et liste des projets", async () => {
    await page.goto(`${BASE}/login?token=${sb.hub.sessions.createLoginToken()}`);
    await expect.poll(() => page.getByRole("heading", { name: "Vos projets" }).isVisible()).toBe(true);
    await page.getByRole("link", { name: /Destiny Survivor/ }).waitFor();
    await shot("1-projets");
  });

  it("discussion : le directeur répond et note ce qui compte", async () => {
    fake.replies.push("Si je comprends bien, tu veux un moment de calme avant chaque boss. Il dure combien de temps, à ton avis ?");
    fake.extractions.push([extracted({ title: "Respiration avant les boss", quote: "un moment de calme avant chaque boss" })]);
    await page.getByRole("link", { name: /Destiny Survivor/ }).click();
    await page.getByPlaceholder(/Écrivez librement/).fill("J'aimerais un moment de calme avant chaque boss");
    await page.getByRole("button", { name: "Envoyer" }).click();
    await page.getByText("Il dure combien de temps", { exact: false }).waitFor({ timeout: 8_000 });
    await page.locator(".items strong", { hasText: "Respiration avant les boss" }).waitFor({ timeout: 10_000 });
    // Les deux messages doivent rester affichés (régression : conversation vidée après l'envoi).
    await page.waitForTimeout(3000);
    const state = (await page.evaluate("({ hash: location.hash, msgs: document.querySelectorAll('.msg').length })")) as { hash: string; msgs: number };
    expect(state.hash).toMatch(/^#\/p\/destiny\/t\//);
    expect(state.msgs).toBe(2);
    await shot("2-discussion");
  });

  it("décisions : regrouper, retirer une fiche, modifier, valider", async () => {
    fake.extractions.push(() => ({
      proposals: [
        {
          title: "Apparition des boss",
          statement: "Les boss n'arrivent jamais sur un minuteur : chacun surgit quand le joueur approche de son arène.",
          rationale: "Le joueur choisit le moment de l'affrontement.",
          based_on: ["M-0001", "M-0002", "M-0003"],
          supersedes: [],
          conflict_notes: [],
          questions: ["L'Ogre fait-il exception, ou suit-il la même règle ?"],
          domain: ["boss"],
        },
        {
          title: "Rythme des niveaux",
          statement: "Chaque niveau compte trois vagues, suivies d'un moment de calme avant le boss.",
          rationale: "Respiration avant le pic d'intensité.",
          based_on: ["M-0004", "I-0001"],
          supersedes: [],
          conflict_notes: [],
          questions: [],
          domain: ["rythme"],
        },
      ],
      left_out: [],
    }) as never);
    await page.getByRole("link", { name: "Décisions", exact: true }).click();
    await page.getByRole("button", { name: "Préparer des propositions" }).click();
    await page.getByRole("heading", { name: "Apparition des boss" }).waitFor({ timeout: 15_000 });
    await shot("3-propositions");

    const card = page.locator("article.proposal", { hasText: "P-0001" });
    await card.getByRole("button", { name: /3 fiche\(s\) regroupée\(s\)/ }).click();
    await card.locator("li", { hasText: "L'Ogre attend en fin de zone" }).getByRole("checkbox").uncheck();
    await card.getByRole("button", { name: "Modifier" }).click();
    await card.locator("textarea").fill("Les boss n'arrivent jamais sur un minuteur : chacun surgit quand le joueur entre dans son arène.");
    await shot("4-modification");
    await card.getByRole("button", { name: "Valider ma version" }).click();
    await page.getByText(/Validé : D-0001/).waitFor();

    expect(sb.hub.vision.get("destiny", "D-0001").statement).toMatch(/entre dans son arène/);
    expect(sb.hub.vision.get("destiny", "M-0003").status).toBe("triaged");
    expect(git(root, "log", "-1", "--format=%s")).toMatch(/D-0001 validée — Apparition des boss \(A-0001\)/);
  });

  it("validation groupée de la proposition restante", async () => {
    await page.getByRole("checkbox", { name: "Tout cocher" }).check();
    await page.getByRole("button", { name: /Valider les 1 cochée/ }).click();
    await page.getByText("1 décision(s) validée(s).").waitFor();
    expect(sb.hub.vision.visionRev("destiny")).toBe(2);
  });

  it("vision validée et « Pourquoi ? »", async () => {
    await page.getByRole("link", { name: "Vision validée", exact: true }).click();
    await page.getByRole("heading", { name: "Apparition des boss" }).waitFor();
    await page.locator("article.decision", { hasText: "Apparition des boss" }).getByRole("button", { name: /Pourquoi/ }).click();
    await page.getByRole("heading", { name: "Pourquoi D-0001 ?" }).waitFor();
    await expect.poll(() => page.locator(".why li", { hasText: "L'Ogre attend en fin de zone" }).first().isVisible()).toBe(true);
    await shot("5-vision-pourquoi");
  });
});

// Garde-fou : le canon n'a été écrit que par vos clics.
it("chaque décision porte une approbation humaine distincte", () => {
  const decisions = sb.hub.vision.list("destiny", { type: "decision" });
  expect(decisions.map((d) => d.validated_by?.approval)).toEqual(["A-0001", "A-0002"]);
  void msg;
});
