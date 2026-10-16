import type { FastifyInstance } from "fastify";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ClaudeCli } from "../src/llm/claude-cli.ts";
import { DirectClaudeOrchestrator } from "../src/orchestrator/direct-claude.ts";
import { buildServer, SESSION_COOKIE } from "../src/server/http.ts";
import type { StudioSnapshot } from "../src/studio/activity.ts";
import { extracted, FakeOrchestrator } from "./fake-orchestrator.ts";
import { cleanupSandboxes, sandbox, type Sandbox } from "./helpers.ts";

const HOST = "127.0.0.1:4317";
const ORIGIN = `http://${HOST}`;
let sb: Sandbox;
let fake: FakeOrchestrator;
let app: FastifyInstance;
let picked: string | null;
let gamesRoot: string;

beforeEach(async () => {
  fake = new FakeOrchestrator();
  sb = sandbox(fake);
  gamesRoot = join(sb.dir, "games");
  mkdirSync(gamesRoot);
  picked = null;
  app = await buildServer(sb.hub, {
    port: 4317,
    gamesRoot,
    allowedHosts: [HOST],
    folderPicker: { pick: async () => picked },
  });
});
afterEach(async () => {
  await app.close();
  cleanupSandboxes();
});

async function login() {
  const res = await app.inject({ method: "GET", url: `/login?token=${sb.hub.sessions.createLoginToken()}`, headers: { host: HOST } });
  expect(res.statusCode).toBe(302);
  const raw = res.cookies.find((c) => c.name === SESSION_COOKIE)!;
  expect(raw).toMatchObject({ httpOnly: true, sameSite: "Strict" });
  const cookie = `${SESSION_COOKIE}=${raw.value}`;
  const session = await app.inject({ method: "GET", url: "/api/human/session", headers: { host: HOST, cookie } });
  const { csrf } = session.json() as { csrf: string };
  const get = (url: string) => app.inject({ method: "GET", url, headers: { host: HOST, cookie } });
  const post = (url: string, body: unknown = {}) =>
    app.inject({ method: "POST", url, payload: body as object, headers: { host: HOST, cookie, origin: ORIGIN, "x-csrf-token": csrf } });
  return { cookie, csrf, get, post };
}

describe("sécurité HTTP", () => {
  it("refuse un en-tête Host étranger (DNS rebinding)", async () => {
    const res = await app.inject({ method: "GET", url: "/api/human/projects", headers: { host: "evil.example:4317" } });
    expect(res.statusCode).toBe(403);
  });

  it("exige une session pour lire", async () => {
    const res = await app.inject({ method: "GET", url: "/api/human/projects", headers: { host: HOST } });
    expect(res.statusCode).toBe(401);
  });

  it("le lien de connexion ne sert qu'une fois", async () => {
    const token = sb.hub.sessions.createLoginToken();
    await app.inject({ method: "GET", url: `/login?token=${token}`, headers: { host: HOST } });
    const again = await app.inject({ method: "GET", url: `/login?token=${token}`, headers: { host: HOST } });
    expect(again.statusCode).toBe(401);
  });

  it("exige le jeton CSRF et une origine locale pour modifier", async () => {
    const { cookie, csrf } = await login();
    const url = "/api/human/import/analyze";
    const payload = { path: gamesRoot };
    const noCsrf = await app.inject({ method: "POST", url, payload, headers: { host: HOST, cookie, origin: ORIGIN } });
    expect(noCsrf.statusCode).toBe(403);
    const badOrigin = await app.inject({ method: "POST", url, payload, headers: { host: HOST, cookie, origin: "http://evil.example", "x-csrf-token": csrf } });
    expect(badOrigin.statusCode).toBe(403);
    const noOrigin = await app.inject({ method: "POST", url, payload, headers: { host: HOST, cookie, "x-csrf-token": csrf } });
    expect(noOrigin.statusCode).toBe(403);
  });
});

describe("parcours : import, conversation, tri", () => {
  it("parcourir → analyser → importer avec amorçage → discuter → trier", async () => {
    const { get, post } = await login();
    const root = sb.makeGameRepo("games/destiny", { "README.md": "# Destiny\n\nUn jeu de survie par vagues.\n", "package.json": "{}" });

    expect((await get("/api/human/import/suggestions")).json()).toEqual([
      expect.objectContaining({ name: "destiny", registered: null, problems: [] }),
    ]);

    picked = root;
    expect((await post("/api/human/import/browse")).json()).toEqual({ path: root });
    const analysis = (await post("/api/human/import/analyze", { path: root })).json();
    expect(analysis).toMatchObject({ engine: "web", isGitRepo: true, documents: ["README.md"], problems: [] });
    expect(existsSync(join(root, "studio"))).toBe(false);

    fake.extractions.push([extracted({ type: "vision", title: "Survie par vagues", quote: "Un jeu de survie par vagues." })]);
    const imported = await post("/api/human/projects/import", { path: root, slug: "destiny", name: "Destiny", documents: ["README.md"] });
    expect(imported.statusCode).toBe(200);
    // Ce parcours vérifie le tri des fiches, propre aux modes hors atelier.
    sb.hub.projects.setAutonomy(sb.human(), "destiny", "balanced");
    await sb.hub.bootstrap.idle();
    expect((await get("/api/human/projects/destiny/jobs")).json()[0]).toMatchObject({ status: "done", created: 1 });

    const thread = (await post("/api/human/projects/destiny/threads", { title: "Boss" })).json();
    fake.extractions.push([extracted({ title: "Boss toutes les 5 vagues", quote: "un boss toutes les 5 vagues" })]);
    const sent = await post(`/api/human/projects/destiny/threads/${thread.id}/messages`, { text: "Je verrais bien un boss toutes les 5 vagues" });
    expect(sent.statusCode).toBe(200);
    await sb.hub.conversations.idle();

    const noted = (await get(`/api/human/projects/destiny/items?view=inbox&thread=${thread.id}`)).json();
    expect(noted.items.map((i: { title: string }) => i.title)).toEqual(["Boss toutes les 5 vagues"]);
    const inbox = (await get("/api/human/projects/destiny/items?view=inbox")).json();
    expect(inbox.items).toHaveLength(2);

    const kept = await post("/api/human/projects/destiny/items/I-0001/triage", { action: "keep" });
    expect(kept.json()).toMatchObject({ status: "triaged" });
    expect((await get("/api/human/projects/destiny/items?view=canon")).json().items).toEqual([]);
  });

  it("tri par lot : traite ce qui peut l'être et signale le reste", async () => {
    const { post } = await login();
    const root = sb.makeGameRepo("games/lot");
    await post("/api/human/projects/import", { path: root, slug: "lot", name: "Lot" });
    for (const t of ["A", "B", "C"]) {
      sb.hub.vision.capture("lot", { kind: "human" }, { type: "idea", title: t, statement: t, source: { kind: "human", ref: "test" } });
    }
    sb.hub.vision.triage("lot", { kind: "human" }, "I-0003", "discard");
    const res = (await post("/api/human/projects/lot/items/triage-batch", { ids: ["I-0001", "I-0002", "I-0003"], action: "keep" })).json();
    expect(res.done).toBe(2);
    expect(res.errors).toEqual([{ id: "I-0003", error: expect.stringMatching(/discarded/) }]);
    expect(sb.hub.vision.list("lot", { tier: "canon" })).toEqual([]);
  });

  it("créer un nouveau projet dans la racine des jeux", async () => {
    const { post } = await login();
    const res = await post("/api/human/projects/create", { slug: "nouveau-jeu", name: "Nouveau jeu" });
    expect(res.statusCode).toBe(200);
    expect(existsSync(join(gamesRoot, "nouveau-jeu", ".git"))).toBe(true);
    expect(existsSync(join(gamesRoot, "nouveau-jeu", "studio", "project.yaml"))).toBe(true);
  });

  it("une erreur métier renvoie un message lisible", async () => {
    const { post } = await login();
    const res = await post("/api/human/projects/import", { path: join(sb.dir, "hub"), slug: "hub", name: "Hub" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/protégé/);
  });
});

describe("modèles des agents (ADR-37)", () => {
  it("le studio montre le modèle de chaque agent, sa consommation, et le change au prochain appel", async () => {
    const { get, post } = await login();
    let snap = (await get("/api/human/studio")).json() as StudioSnapshot;
    expect(snap.models.roles.map((r) => [r.role, r.model, r.recommended])).toEqual([
      ["concepteur", "fable", "fable"],
      ["director", "sonnet", "sonnet"],
      ["archivist", "sonnet", "sonnet"],
      ["developer", "sonnet", "sonnet"],
      ["developer_big", "fable", "fable"],
      ["qa", "haiku", "haiku"],
      ["archeologue", "sonnet", "sonnet"],
      ["art_director", "sonnet", "sonnet"],
    ]);
    expect(snap.models.choices.map((c) => c.id)).toEqual(["fable", "opus", "sonnet", "haiku"]);

    sb.hub.usage.record({ project: null, agent: "developer", model: "fable", tokens: { input: 100, output: 50, cacheRead: 800, cacheWrite: 50 }, costUsd: 0.4 });
    sb.hub.usage.record({ project: null, agent: "lecons", model: "sonnet", tokens: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 }, costUsd: 0.01 });
    sb.hub.usage.record({ project: null, agent: "compteur", model: "haiku", tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, costUsd: 0 });
    const res = await post("/api/human/studio/models", { role: "developer", model: "opus" });
    expect(res.statusCode).toBe(200);
    expect((await post("/api/human/studio/models", { role: "guardian", model: "sonnet" })).statusCode).toBe(400);
    expect((await post("/api/human/studio/models", { role: "qa", model: "gpt" })).statusCode).toBe(400);

    snap = (await get("/api/human/studio")).json() as StudioSnapshot;
    expect(snap.models.roles.find((r) => r.role === "developer")).toMatchObject({ model: "opus", recommended: "sonnet" });
    expect(snap.usage.agents.developer).toMatchObject({ today: { tokens: 1000, calls: 1 }, week: { tokens: 1000, calls: 1 }, models: { fable: 1000 } });
    // Les leçons passent par le modèle de l'archiviste ; l'appel « compteur » n'est pas un agent.
    expect(snap.usage.agents.archivist?.week.tokens).toBe(20);
    expect(snap.usage.agents.compteur).toBeUndefined();
    expect(sb.hub.journal.list({ subject: "developer", latest: true }).find((e) => e.type === "model.changed")).toMatchObject({ subject: "developer", payload: { from: "sonnet", to: "opus" } });

    // Lu à chaque appel par le directeur et le développeur.
    const seen: string[] = [];
    const cli = { call: async (c: { model: string }) => (seen.push(c.model), { text: "ok", costUsd: 0, structured: {} }) } as unknown as ClaudeCli;
    const director = new DirectClaudeOrchestrator(cli, () => ({ chat: sb.hub.models.get("director"), structured: sb.hub.models.get("archivist"), concept: sb.hub.models.get("concepteur") }));
    await director.reply({ systemPrompt: "s", prompt: "p" });
    await post("/api/human/studio/models", { role: "director", model: "fable" });
    await director.reply({ systemPrompt: "s", prompt: "p" });
    await director.structured({ systemPrompt: "s", prompt: "p", jsonSchema: {}, tier: "concept" });
    expect(seen).toEqual(["sonnet", "fable", "fable"]);
  });
});
