import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeManifest, type Asset } from "../src/art/manifest.ts";
import { buildServer, SESSION_COOKIE } from "../src/server/http.ts";
import { periodBounds, recapGroup, type Recap } from "../src/studio/recap.ts";
import { FakeOrchestrator } from "./fake-orchestrator.ts";
import { cleanupSandboxes, sandbox, type Sandbox } from "./helpers.ts";

/** Le Récap des chantiers (ADR-113) : la route, les chiffres d'une période, les semaines, et ce qu'il faut au détail. */
const HOST = "127.0.0.1:4317";
const P = "destiny";
let sb: Sandbox;
let app: FastifyInstance;
let root: string;

beforeEach(async () => {
  sb = sandbox(new FakeOrchestrator());
  root = sb.makeGameRepo("games/destiny");
  await sb.hub.projects.register(sb.human(), { path: root, slug: P, name: "Destiny" });
  app = await buildServer(sb.hub, { port: 4317, gamesRoot: sb.dir, allowedHosts: [HOST], folderPicker: { pick: async () => null } });
});
afterEach(async () => {
  await app.close();
  cleanupSandboxes();
});

async function get(url: string) {
  const res = await app.inject({ method: "GET", url: `/login?token=${sb.hub.sessions.createLoginToken()}`, headers: { host: HOST } });
  const cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)!.value}`;
  return app.inject({ method: "GET", url, headers: { host: HOST, cookie } });
}

function seedTask(id: string, status: string, at: string, extra: Record<string, unknown> = {}) {
  const task = { id, project: P, title: `Chantier ${id}`, goal: `Objectif de ${id}`, authorized_by: [], origin: null, direct: true, queued_at: null, reworks: [], scope: null, status, feedback: [], base_commit: null, branch: null, worktree: null, plan: null, created_at: at, updated_at: at, ...extra };
  sb.hub.db.prepare("INSERT INTO tasks (id, project, status, data_json, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, P, status, JSON.stringify(task), at);
}
let runs = 0;
function seedRun(task: string, kind: "execute" | "verify", start: string, minutes: number, cost: number, result: unknown, error: string | null = null) {
  const end = new Date(Date.parse(start) + minutes * 60_000).toISOString();
  sb.hub.db
    .prepare("INSERT INTO runs (id, project, task, kind, status, token_hash, started_at, finished_at, cost_usd, error, result_json) VALUES (?, ?, ?, ?, ?, 'x', ?, ?, ?, ?, ?)")
    .run(`RUN-${String(++runs).padStart(4, "0")}`, P, task, kind, error ? "failed" : "done", start, end, cost, error, JSON.stringify(result));
}
function event(type: string, subject: string, at: string, payload: Record<string, unknown> = {}) {
  sb.hub.db.prepare("INSERT INTO events (at, project, actor_json, type, subject, payload_json) VALUES (?, ?, '{\"kind\":\"system\"}', ?, ?, ?)").run(at, P, type, subject, JSON.stringify(payload));
}
const report = (simple: string, how: string[] = []) => ({ report: { outcome: "completed", summary: `Technique : ${simple}`, summary_simple: simple, deviations: [], open_issues: [], how_to_test: how } });
const verdict = (v: string, simple: string) => ({ verification: { verdict: v, summary_simple: simple, checks: [], decision_compliance: [], hidden_assumptions: [], regressions: [], recommendation: "merge", playtest: { played: true, summary: "J'ai lancé la mission 1.", unverified: ["le téléphone"] } } });
const asset = (id: string, status: Asset["status"]): Asset => ({ id, name: `Visuel ${id}`, type: "sprite", usage: "x", specs: "", status, prompts: [], refs: [], renders: [], verdict: null, created_at: "2026-10-01T12:00:00.000Z", updated_at: "2026-10-01T12:00:00.000Z" });

// L'horloge des tests démarre le mardi 13 octobre 2026 à midi (UTC).
const THIS_WEEK = "2026-10-12T10:00:00.000Z";
const LAST_WEEK = "2026-10-07T10:00:00.000Z";

function seedProject() {
  const thread = sb.hub.conversations.createThread(P, "La mission 1").id;
  // Fusionné cette semaine, du premier coup, lancé depuis un fil.
  seedTask("T-0001", "merged", THIS_WEEK, { origin: { thread } });
  seedRun("T-0001", "execute", THIS_WEEK, 10, 0.5, report("La mission 1 se joue sur la carte.", ["Lancer le jeu", "Campagne, mission 1"]));
  seedRun("T-0001", "verify", THIS_WEEK, 2, 0.1, verdict("pass_with_notes", "La mission démarre, déplacements non vérifiés."));
  event("task.merged", "T-0001", "2026-10-12T11:00:00.000Z");
  // En échec cette semaine.
  seedTask("T-0002", "failed", "2026-10-13T08:00:00.000Z");
  seedRun("T-0002", "execute", "2026-10-13T08:00:00.000Z", 30, 0.2, null, "le build ne passe pas");
  // Fusionné la semaine dernière après une correction, puis repris par T-0005.
  seedTask("T-0003", "merged", LAST_WEEK);
  seedRun("T-0003", "execute", LAST_WEEK, 20, 1, report("Les falaises ont de la matière."));
  event("task.changes_requested", "T-0003", LAST_WEEK);
  event("task.merged", "T-0003", "2026-10-08T10:00:00.000Z");
  // Un brouillon jamais lancé : dans la liste, pas dans les chiffres.
  seedTask("T-0004", "draft", THIS_WEEK);
  // Corrige T-0003, fusionné cette semaine.
  seedTask("T-0005", "merged", THIS_WEEK, { reworks: ["T-0003"] });
  seedRun("T-0005", "execute", THIS_WEEK, 5, 0.25, report("La roche est moins claire."));
  event("task.merged", "T-0005", "2026-10-12T12:00:00.000Z");
  // Deux visuels intégrés cette semaine ; l'un a été écarté depuis (le manifeste fait foi).
  writeManifest(root, { version: 1, assets: [asset("A-0001", "integre"), asset("A-0002", "ecarte")] });
  event("art.asset_integrated", "A-0001", THIS_WEEK, { task: "T-0001" });
  event("art.asset_integrated", "A-0002", THIS_WEEK, { task: "T-0001" });
  return thread;
}

describe("la route du Récap", () => {
  it("exige une session et refuse une période inconnue", async () => {
    expect((await app.inject({ method: "GET", url: `/api/human/projects/${P}/recap`, headers: { host: HOST } })).statusCode).toBe(401);
    expect((await get(`/api/human/projects/${P}/recap?period=annee`)).statusCode).toBe(400);
  });

  it("un projet sans chantier : des chiffres à zéro, aucune semaine", async () => {
    const r = (await get(`/api/human/projects/${P}/recap`)).json() as Recap;
    expect(r.period).toBe("lastweek");
    expect(r.stats).toEqual({ total: 0, merged: 0, failed: 0, running: 0, cost_usd: 0, minutes: 0, first_try: 0, first_try_pct: null, visuals: 0 });
    expect(r.weeks).toEqual([]);
    expect(r.counts).toEqual({ all: 0, merged: 0, failed: 0, running: 0 });
  });

  it("les chiffres de cette semaine, les chantiers par semaine et le détail de chacun", async () => {
    const thread = seedProject();
    const res = await get(`/api/human/projects/${P}/recap`);
    expect(res.statusCode).toBe(200);
    const r = res.json() as Recap;
    // Sans période demandée : cette semaine, puisque l'équipe y a travaillé.
    expect(r.period).toBe("week");
    expect(r.stats).toEqual({ total: 3, merged: 2, failed: 1, running: 0, cost_usd: 1.05, minutes: 47, first_try: 2, first_try_pct: 100, visuals: 1 });
    expect(r.counts).toEqual({ all: 5, merged: 3, failed: 1, running: 1 });
    expect(r.weeks.map((w) => [w.week, w.tasks.map((t) => t.id)])).toEqual([
      ["2026-10-12", ["T-0002", "T-0005", "T-0001", "T-0004"]],
      ["2026-10-05", ["T-0003"]],
    ]);
    expect(r.weeks[1]).toMatchObject({ merged: 1, failed: 0, cost_usd: 1, minutes: 20 });
    const t1 = r.weeks[0]!.tasks.find((t) => t.id === "T-0001")!;
    expect(t1).toMatchObject({
      group: "merged",
      merged_at: "2026-10-12T11:00:00.000Z",
      summary: "La mission 1 se joue sur la carte.",
      tech: "Technique : La mission 1 se joue sur la carte.",
      how_to_test: ["Lancer le jeu", "Campagne, mission 1"],
      verdict: "pass_with_notes",
      tester: "La mission démarre, déplacements non vérifiés.",
      played: "J'ai lancé la mission 1.",
      unverified: ["le téléphone"],
      cost_usd: 0.6,
      minutes: 12,
      corrections: 0,
      first_try: true,
      shot: null,
      thread: { id: thread, title: "La mission 1" },
    });
    expect(r.weeks[0]!.tasks.find((t) => t.id === "T-0002")).toMatchObject({ group: "failed", error: "le build ne passe pas", verdict: null, summary: null });
    expect(r.weeks[0]!.tasks.find((t) => t.id === "T-0005")).toMatchObject({ reworks: ["T-0003"] });
    // La semaine du journal de bord que « Raconter la semaine » racontera.
    expect(r.story).toMatchObject({ week: "2026-10-12", text: null, gif: false });
  });

  it("la semaine dernière : une correction, donc pas du premier coup ; repris ensuite par un autre chantier", async () => {
    seedProject();
    const r = (await get(`/api/human/projects/${P}/recap?period=lastweek`)).json() as Recap;
    expect(r.period).toBe("lastweek");
    expect(r.stats).toMatchObject({ total: 1, merged: 1, failed: 0, first_try: 0, first_try_pct: 0, visuals: 0, cost_usd: 1 });
    expect(r.weeks[1]!.tasks[0]).toMatchObject({ id: "T-0003", corrections: 1, first_try: false, reworked_by: ["T-0005"] });
    expect(r.story.week).toBe("2026-10-05");
    // Le récit déjà écrit par le directeur revient avec la période.
    sb.hub.db.prepare("INSERT INTO logbook_weeks (project, week, text, at) VALUES (?, '2026-10-05', 'Une semaine de falaises.', ?)").run(P, LAST_WEEK);
    expect(((await get(`/api/human/projects/${P}/recap?period=lastweek`)).json() as Recap).story).toMatchObject({ text: "Une semaine de falaises." });
    // 30 jours : tout ce qui a été lancé.
    expect(((await get(`/api/human/projects/${P}/recap?period=30d`)).json() as Recap).stats).toMatchObject({ total: 4, merged: 3, failed: 1 });
  });
});

describe("les périodes et les familles", () => {
  it("une semaine commence le lundi, la semaine dernière finit là où celle-ci commence", () => {
    const now = "2026-10-14T15:00:00.000Z";
    const week = periodBounds("week", now);
    const last = periodBounds("lastweek", now);
    expect(new Date(week.from).getDay()).toBe(1);
    expect(last.to).toBe(week.from);
    expect(Date.parse(week.to) - Date.parse(week.from)).toBeGreaterThanOrEqual(7 * 86_400_000 - 3_600_000);
    const d30 = periodBounds("30d", now);
    expect(Date.parse(now) - Date.parse(d30.from)).toBe(30 * 86_400_000);
  });
  it("fusionné, échec ou abandon, en cours", () => {
    expect(["merged", "failed", "cancelled", "abandoned", "rejected", "draft", "running", "review"].map(recapGroup)).toEqual(["merged", "failed", "failed", "failed", "failed", "running", "running", "running"]);
  });
});
