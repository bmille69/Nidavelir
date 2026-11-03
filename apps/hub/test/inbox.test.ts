import type { FastifyInstance } from "fastify";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeManifest, type Asset } from "../src/art/manifest.ts";
import { buildServer, SESSION_COOKIE } from "../src/server/http.ts";
import { studioSnapshot } from "../src/studio/activity.ts";
import type { InboxItem } from "../src/studio/inbox.ts";
import { FakeOrchestrator } from "./fake-orchestrator.ts";
import { cleanupSandboxes, DIRECTOR, msg, sandbox, type Sandbox } from "./helpers.ts";

/** La boîte « À vous » d'un projet (ADR-113) : la route, chaque type, le tri, et l'accord avec « À vous de jouer ». */
const HOST = "127.0.0.1:4317";
const P = "destiny";
let sb: Sandbox;
let app: FastifyInstance;
let root: string;

beforeEach(async () => {
  sb = sandbox(new FakeOrchestrator());
  root = sb.makeGameRepo("games/destiny");
  await sb.hub.projects.register(sb.human(), { path: root, slug: P, name: "Destiny" });
  sb.hub.projects.setAutonomy(sb.human(), P, "workshop");
  app = await buildServer(sb.hub, { port: 4317, gamesRoot: sb.dir, allowedHosts: [HOST], folderPicker: { pick: async () => null } });
});
afterEach(async () => {
  await app.close();
  vi.restoreAllMocks();
  cleanupSandboxes();
});

async function get(url: string) {
  const res = await app.inject({ method: "GET", url: `/login?token=${sb.hub.sessions.createLoginToken()}`, headers: { host: HOST } });
  const cookie = `${SESSION_COOKIE}=${res.cookies.find((c) => c.name === SESSION_COOKIE)!.value}`;
  return app.inject({ method: "GET", url, headers: { host: HOST, cookie } });
}

/** Un chantier écrit tel que le hub le stocke, dans l'état voulu. */
function seedTask(id: string, status: string, extra: Record<string, unknown> = {}) {
  const now = sb.hub.clock.now();
  const task = { id, project: P, title: `Chantier ${id}`, goal: `Objectif de ${id}`, authorized_by: [], origin: null, direct: true, queued_at: null, reworks: [], scope: null, status, feedback: [], base_commit: null, branch: null, worktree: null, plan: null, created_at: now, updated_at: now, ...extra };
  sb.hub.db.prepare("INSERT INTO tasks (id, project, status, data_json, updated_at) VALUES (?, ?, ?, ?, ?)").run(id, P, status, JSON.stringify(task), now);
}

function seedRun(id: string, task: string, kind: "execute" | "verify", result: unknown, error: string | null = null) {
  sb.hub.db
    .prepare("INSERT INTO runs (id, project, task, kind, status, token_hash, started_at, finished_at, error, result_json) VALUES (?, ?, ?, ?, ?, 'x', ?, ?, ?, ?)")
    .run(id, P, task, kind, error ? "failed" : "done", sb.hub.clock.now(), sb.hub.clock.now(), error, JSON.stringify(result));
}

const asset = (id: string, patch: Partial<Asset>): Asset => ({ id, name: `Visuel ${id}`, type: "sprite", usage: "dans le menu", specs: "", status: "propose", prompts: [], refs: [], renders: [], verdict: null, created_at: "2026-10-13T12:00:00.000Z", updated_at: "2026-10-13T12:00:00.000Z", ...patch });

describe("la route de la boîte « À vous »", () => {
  it("exige une session", async () => {
    const res = await app.inject({ method: "GET", url: `/api/human/projects/${P}/inbox`, headers: { host: HOST } });
    expect(res.statusCode).toBe(401);
  });

  it("un projet sans rien en attente : une boîte vide", async () => {
    const res = await get(`/api/human/projects/${P}/inbox`);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("chaque type, trié par urgence, avec ce qu'il faut pour trancher sur place", async () => {
    const hub = sb.hub;
    const thread = hub.conversations.createThread(P, "Le boss").id;
    // (g) Un chantier en échec cette semaine.
    seedTask("T-0001", "failed");
    seedRun("RUN-0001", "T-0001", "execute", null, "le build ne passe pas");
    // (b) Un chantier à relire, avec le rapport du développeur et l'avis du Testeur.
    seedTask("T-0002", "review", { origin: { thread } });
    seedRun("RUN-0002", "T-0002", "execute", { report: { outcome: "completed", summary: "x", summary_simple: "La Carrière se remplit de rochers.", deviations: [], open_issues: [], how_to_test: [] } });
    seedRun("RUN-0003", "T-0002", "verify", { verification: { verdict: "pass_with_notes", summary_simple: "Tout passe, peu de marge.", checks: [], decision_compliance: [], hidden_assumptions: [], regressions: [], recommendation: "merge" } });
    // (a) Le Gardien bloque une action hors plan du chantier en cours.
    seedTask("T-0003", "running");
    const created = hub.clock.now();
    hub.db
      .prepare("INSERT INTO escalations (id, project, task, run, status, data_json, created_at) VALUES ('E-0001', ?, 'T-0003', 'RUN-0009', 'pending', ?, ?)")
      .run(P, JSON.stringify({ id: "E-0001", project: P, task: "T-0003", run: "RUN-0009", tool: "Bash", summary: "Installer three-mesh-bvh", input: { command: "npm i three-mesh-bvh" }, reason: "commande hors plan", status: "pending", created_at: created, decided_at: null }), created);
    // (c) Une proposition du directeur.
    hub.vision.capture(P, DIRECTOR, { type: "idea", title: "Calme", statement: "Calme avant le boss", source: msg("m", "x") });
    hub.vision.submitProposal(P, DIRECTOR, { title: "Un moment de calme", statement: "Calme avant le boss.", source: { kind: "message", ref: "m" }, details: { based_on: ["I-0001"] } });
    // (d) Le Directeur artistique : un croquis à choisir, un rendu à valider.
    writeManifest(root, {
      version: 1,
      assets: [
        asset("A-0001", { sketches: [{ file: "atelier/a1.png", label: "Toit effondré", prompt: "p" }, { file: "atelier/a2.png", label: "Toit intact", prompt: "p" }] }),
        asset("A-0002", { status: "a_valider", renders: ["production/a-0002-1.png"] }),
      ],
    });
    // (e) Un plan de production à valider.
    const now = hub.clock.now();
    hub.db
      .prepare("INSERT INTO productions (id, project, thread, title, status, auto, brief, plan_json, refs_json, note, cost_usd, created_at, updated_at) VALUES ('P-0001', ?, ?, 'Le boss Gardien', 'proposed', 0, 'un boss', ?, '{}', NULL, NULL, ?, ?)")
      .run(P, thread, JSON.stringify({ titre: "Le boss Gardien", objectif: "Un boss à la vague 10.", criteres: ["a", "b"], visuels: [], sons: [], chantiers: [{ cle: "c1", titre: "Le boss", consigne: "x", visuels: [], sons: [] }], note: "" }), now, now);
    // (f) Le Concepteur attend des réponses sur une conception de ce jeu.
    hub.db
      .prepare("INSERT INTO conceptions (id, kind, project, title, status, data_json, created_at, updated_at) VALUES ('C-0001', 'feature', ?, 'Mission 2', 'open', ?, ?, ?)")
      .run(P, JSON.stringify({ title: "Mission 2", engine: "", godot: null, dossier: "", chantiers: [], visuels: [], ready: false, claude_md: "", sources: [], questions: [{ question: "Le convoi peut-il être détruit ?", why: "", options: [{ label: "Oui", detail: "" }, { label: "Non", detail: "" }], recommended: "Non" }] }), now, now);
    // Un son à écouter dans un plan en cours (le directeur sonore et ses essais).
    mkdirSync(join(root, "studio/sound"), { recursive: true });
    writeFileSync(join(root, "studio/sound/sounds.json"), JSON.stringify({ version: 1, sounds: [{ id: "S-0001", name: "Rugissement", kind: "effet", usage: "quand le boss arrive", prompt: "roar", seconds: 2, loop: false, status: "a_choisir", takes: [{ file: "s-0001-1.mp3", at: now, bytes: 10, credits: 1 }], chosen: null, path: null, task: null, note: null }] }));
    const plan = hub.productions!.get(P, "P-0001");
    const real = hub.productions!.yours.bind(hub.productions!);
    vi.spyOn(hub.productions!, "yours").mockImplementation((project) => [...real(project), { text: "Plan « Le boss Gardien » : S-0001 « Rugissement » — écoutez les essais et choisissez", href: `#/p/${P}/plans`, plan, sound: "S-0001" }]);

    const res = await get(`/api/human/projects/${P}/inbox`);
    expect(res.statusCode).toBe(200);
    const items = res.json() as InboxItem[];
    expect(items.map((i) => [i.kind, i.id])).toEqual([
      ["escalation", "E-0001"],
      ["review", "T-0002"],
      ["proposal", "P-0001"],
      ["production", "P-0001-0"],
      ["art", "A-0001-sketch"],
      ["art", "A-0002-render"],
      ["sound", "P-0001-S-0001"],
      ["conception", "C-0001"],
      ["failed", "T-0001"],
    ]);
    const by = new Map(items.map((i) => [i.id, i]));
    // Le Gardien : l'échéance réelle du refus automatique (15 minutes après la demande).
    expect(by.get("E-0001")).toMatchObject({ urgency: 0, deadline: new Date(Date.parse(created) + 15 * 60_000).toISOString(), url: `#/p/${P}/tasks/T-0003`, data: { task: "T-0003", summary: "Installer three-mesh-bvh", reason: "commande hors plan" } });
    expect(by.get("T-0002")).toMatchObject({ text: "La Carrière se remplit de rochers.", href: `#/p/${P}/t/${thread}`, data: { verdict: "pass_with_notes", tester: "Tout passe, peu de marge.", thread } });
    const prop = by.get("P-0001")!;
    expect(prop.kind === "proposal" && prop.data.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(by.get("P-0001-0")).toMatchObject({ title: "Le boss Gardien", text: "à valider", data: { plan: "P-0001", status: "proposed", objective: "Un boss à la vague 10." } });
    expect(by.get("P-0001-S-0001")).toMatchObject({ data: { sound: "S-0001", name: "Rugissement", takes: ["s-0001-1.mp3"] } });
    expect(by.get("A-0001-sketch")).toMatchObject({ data: { what: "sketch", asset: "A-0001", sketches: [{ file: "atelier/a1.png", label: "Toit effondré" }, { file: "atelier/a2.png", label: "Toit intact" }] } });
    expect(by.get("A-0002-render")).toMatchObject({ data: { what: "render", image: "production/a-0002-1.png" } });
    expect(by.get("C-0001")).toMatchObject({ url: "#/c/C-0001", data: { questions: [{ question: "Le convoi peut-il être détruit ?" }] } });
    expect(by.get("T-0001")).toMatchObject({ text: "Arrêté sur une erreur : le build ne passe pas", data: { task: "T-0001" } });

    // « À vous de jouer » dit la même chose : une ligne par attente, les propositions regroupées.
    const you = studioSnapshot(hub).agents.find((a) => a.id === "you")!.activities.filter((a) => a.project === P);
    expect(you.map((a) => a.text)).toEqual([...items.filter((i) => i.kind !== "proposal").map((i) => i.line), "1 proposition(s) à arbitrer"]);
    expect(you.find((a) => a.text.startsWith("T-0002"))!.href).toBe(`#/p/${P}/t/${thread}`);
    expect(studioSnapshot(hub).projects.find((p) => p.slug === P)!.waiting).toBe(items.length);
  });

  it("un chantier en échec depuis plus d'une semaine n'y est plus", async () => {
    seedTask("T-0001", "failed", { updated_at: "2026-09-01T12:00:00.000Z" });
    expect((await get(`/api/human/projects/${P}/inbox`)).json()).toEqual([]);
  });
});
