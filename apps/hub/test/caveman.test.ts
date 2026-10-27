import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CavemanExecutor, CavemanRouter, cavemanSettings, isRelayFailure, RELAY_NOTE, routeOf, type CavemanSettings } from "../src/executor/caveman.ts";
import { CAVEMAN_RETRIEVE_TOOL, PolicyEngine } from "../src/executor/policy-engine.ts";
import type { ExecRequest, ExecResult, ExecutorPort } from "../src/executor/port.ts";
import { createHub } from "../src/hub.ts";
import { routeReport } from "../src/quality/route-report.ts";
import { FakeExecutor, planOutput } from "./fake-executor.ts";
import { DIRECTOR, cleanupSandboxes, fakeClock, msg, sandbox } from "./helpers.ts";

afterEach(() => cleanupSandboxes());

const settings = (over: Partial<CavemanSettings> = {}): CavemanSettings => ({
  mode: "compress",
  share: 1,
  url: "http://127.0.0.1:8797",
  port: 8797,
  binary: "caveman-proxy.exe",
  mcpBinary: "caveman-mcp.exe",
  ...over,
});
/** Un relais qui répond comme le vrai : son erreur à lui sur /health. */
const relayUp = (async () => new Response('{"error":{"type":"cave_gateway_error"}}', { status: 404 })) as unknown as typeof fetch;
const relayDown = (async () => {
  throw new Error("ECONNREFUSED");
}) as unknown as typeof fetch;
const router = (over: Partial<CavemanSettings> = {}, f = relayUp) => new CavemanRouter(settings(over), { home: "C:/nulle-part", fetch: f, spawnProxy: false });

class Recorder implements ExecutorPort {
  readonly name = "rec";
  readonly seen: ExecRequest[] = [];
  failures: Error[] = [];
  async run(req: ExecRequest): Promise<ExecResult> {
    this.seen.push(req);
    const f = this.failures.shift();
    if (f) throw f;
    return { structured: null, text: "", costUsd: 0.02, tokens: { input: 10, output: 5, cacheRead: 100, cacheWrite: 20 } };
  }
}
const request = (over: Partial<ExecRequest> = {}): ExecRequest & { events: string[] } => {
  const events: string[] = [];
  return {
    kind: "execute",
    runId: "R-1",
    cwd: ".",
    runDir: ".",
    systemPrompt: "Tu es le développeur.",
    prompt: "go",
    jsonSchema: {},
    tools: ["Read"],
    maxTurns: 5,
    bridge: {} as never,
    bridgeUrl: "",
    token: "",
    onEvent: (_t, text) => events.push(text),
    signal: new AbortController().signal,
    taskId: "T-0001",
    events,
    ...over,
  };
};

describe("réglages", () => {
  it("éteint par défaut, sur un port à lui, un chantier sur deux une fois allumé", () => {
    const s = cavemanSettings({});
    expect(s).toMatchObject({ mode: "off", share: 0.5, url: "http://127.0.0.1:8797" });
    expect(cavemanSettings({ STUDIO_CAVEMAN: "COMPRESS", STUDIO_CAVEMAN_SHARE: "2", STUDIO_CAVEMAN_PORT: "9001" })).toMatchObject({ mode: "compress", share: 1, port: 9001 });
    expect(cavemanSettings({ STUDIO_CAVEMAN: "oui" }).mode).toBe("off");
  });

  it("le même chantier prend toujours le même chemin", () => {
    expect(routeOf("T-0042", 0.5)).toBe(routeOf("T-0042", 0.5));
    expect(routeOf("T-0042", 0)).toBe("direct");
    expect(routeOf("T-0042", 1)).toBe("caveman");
    const ids = Array.from({ length: 400 }, (_, i) => `T-${i}`);
    const share = ids.filter((id) => routeOf(id, 0.5) === "caveman").length / ids.length;
    expect(share).toBeGreaterThan(0.4);
    expect(share).toBeLessThan(0.6);
  });

  it("reconnaît une coupure du relais, pas une erreur du travail", () => {
    expect(isRelayFailure(new Error("Claude Code a échoué : API Error: Connection error."))).toBe(true);
    expect(isRelayFailure(new Error('API Error: 502 {"error":{"type":"cave_gateway_error"}}'))).toBe(true);
    expect(isRelayFailure(new Error("Le plan ne respecte pas le schéma"))).toBe(false);
  });
});

describe("le détour par le relais", () => {
  it("éteint, rien ne change : la requête passe telle quelle", async () => {
    const inner = new Recorder();
    const req = request();
    const out = await new CavemanExecutor(inner, router({ mode: "off" })).run(req);
    expect(inner.seen[0]).toBe(req);
    expect(out.route).toBe("direct");
  });

  it("le Développeur d'un chantier tiré au sort passe par le relais, avec l'outil de relecture et sa consigne", async () => {
    const inner = new Recorder();
    const req = request();
    const out = await new CavemanExecutor(inner, router()).run(req);
    const seen = inner.seen[0]!;
    expect(seen.baseUrl).toBe("http://127.0.0.1:8797");
    expect(seen.extraMcp?.caveman).toMatchObject({ command: "caveman-mcp.exe", env: { CAVEMAN_HOME: "C:/nulle-part" } });
    expect(seen.systemPrompt).toContain(RELAY_NOTE);
    expect(seen.tools).toEqual(["Read"]);
    expect(out.route).toBe("caveman");
    expect(req.events.join(" ")).toMatch(/passe par Caveman/);
  });

  it("en mode « record », pas de consigne : rien n'est abrégé", async () => {
    const inner = new Recorder();
    await new CavemanExecutor(inner, router({ mode: "record" })).run(request());
    expect(inner.seen[0]!.systemPrompt).toBe("Tu es le développeur.");
  });

  it("le Testeur, et tout ce qui n'est pas un chantier, restent en direct", async () => {
    const inner = new Recorder();
    const ex = new CavemanExecutor(inner, router());
    await ex.run(request({ kind: "verify" }));
    await ex.run(request({ taskId: undefined }));
    expect(inner.seen.every((r) => r.baseUrl === undefined && r.extraMcp === undefined)).toBe(true);
  });

  it("relais injoignable : le passage part en direct et le dit", async () => {
    const inner = new Recorder();
    const req = request();
    const out = await new CavemanExecutor(inner, router({}, relayDown)).run(req);
    expect(inner.seen[0]!.baseUrl).toBeUndefined();
    expect(out.route).toBe("direct");
    expect(req.events.join(" ")).toMatch(/Caveman indisponible.*en direct/);
  });

  it("relais tombé en cours de route : refait en direct ; une vraie erreur remonte, comptée pour le relais", async () => {
    const inner = new Recorder();
    inner.failures = [new Error("API Error: Connection error.")];
    const out = await new CavemanExecutor(inner, router()).run(request());
    expect(inner.seen.map((r) => r.baseUrl)).toEqual(["http://127.0.0.1:8797", undefined]);
    expect(out.route).toBe("direct");

    inner.failures = [new Error("schéma invalide")];
    const err = await new CavemanExecutor(inner, router()).run(request()).catch((e: Error & { route?: string }) => e);
    expect(err).toMatchObject({ message: "schéma invalide", route: "caveman" });
  });

  it("relais absent : il faut l'installer, et c'est dit", async () => {
    const r = new CavemanRouter(settings({ binary: null }), { home: "C:/nulle-part", fetch: relayDown, spawnProxy: false });
    expect(await r.ensure()).toBe(false);
    expect(r.status().lastError).toMatch(/caveman setup --install/);
  });

  it("un relais déjà là dans un autre mode ne sert pas", async () => {
    const home = mkdtempSync(join(tmpdir(), "caveman-"));
    mkdirSync(join(home, "run"));
    writeFileSync(join(home, "run", "8797.json"), JSON.stringify({ mode: "record", port: 8797 }));
    const r = new CavemanRouter(settings(), { home, fetch: relayUp, spawnProxy: false });
    expect(await r.ensure()).toBe(false);
    expect(r.status().lastError).toMatch(/mode « record »/);
    rmSync(home, { recursive: true, force: true });
  });
});

describe("le Gardien", () => {
  it("permet la relecture au Développeur, pas au Testeur", () => {
    expect(new PolicyEngine({ mode: "execute", root: "." }).evaluate(CAVEMAN_RETRIEVE_TOOL, { handle: "x" }).decision).toBe("allow");
    expect(new PolicyEngine({ mode: "plan", root: "." }).evaluate(CAVEMAN_RETRIEVE_TOOL, {}).decision).toBe("allow");
    expect(new PolicyEngine({ mode: "verify", root: "." }).evaluate(CAVEMAN_RETRIEVE_TOOL, {}).decision).toBe("deny");
    expect(new PolicyEngine({ mode: "execute", root: "." }).evaluate("mcp__caveman__caveman_compress", {}).decision).toBe("deny");
  });
});

describe("la mesure de chaque passage", () => {
  it("le hub garde les jetons réels et le chemin de chaque passage, et compare les chemins", async () => {
    const sb = sandbox();
    const fake = new FakeExecutor();
    // L'exécuteur factice ne rapporte pas de jetons : on lui en prête.
    const withTokens: ExecutorPort = {
      name: "fake",
      run: async (req) => ({ ...(await fake.run(req)), tokens: { input: 7, output: 3, cacheRead: 50, cacheWrite: 40 } }),
    };
    sb.hub.close();
    const hub = createHub({
      databasePath: join(sb.dir, "hub/.data/routes.db"),
      registry: { forbiddenTrees: [join(sb.dir, "hub")], forbiddenExact: [sb.dir] },
      clock: fakeClock(),
      executor: new CavemanExecutor(withTokens, router()),
      dataDir: join(sb.dir, "hub/.data"),
    });
    sb.hub = hub;
    const repo = sb.makeGameRepo("jeu", { "README.md": "# Jeu\n", "src/main.ts": "export {};\n" });
    await hub.projects.register(sb.human(), { path: repo, slug: "jeu", name: "Jeu" });
    hub.projects.setAutonomy(sb.human(), "jeu", "supervised");
    hub.vision.capture("jeu", DIRECTOR, { type: "mechanic", title: "Boss", statement: "Le boss surgit.", source: msg("m", "x") });
    const { proposal, hash } = hub.vision.submitProposal("jeu", DIRECTOR, {
      title: "Boss",
      statement: "Le boss surgit à l'entrée.",
      source: { kind: "message", ref: "m" },
      details: { based_on: ["M-0001"] },
    });
    const a = hub.approvals.record(sb.human(), { project: "jeu", subject: { kind: "proposal", id: proposal.id, hash }, verdict: "approved" });
    await hub.vision.decideProposal("jeu", a.id);

    const task = hub.tasks.create(sb.human(), "jeu", { decisions: ["D-0001"] });
    let gate: string | null = null;
    fake.scripts.plan.push(async (_t, req) => {
      gate = (await req.bridge.preTool(CAVEMAN_RETRIEVE_TOOL, { handle: "abc" })).decision;
      return planOutput();
    });
    await hub.tasks.startPlanning("jeu", task.id);
    const t0 = Date.now();
    while (hub.tasks.get("jeu", task.id).status === "planning" && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 20));
    await hub.tasks.idle();

    expect(gate).toBe("allow");
    expect(fake.requests[0]!.baseUrl).toBe("http://127.0.0.1:8797");
    const run = hub.db.prepare("SELECT route, tokens_json FROM runs WHERE project = 'jeu'").get() as { route: string; tokens_json: string };
    expect(run.route).toBe("caveman");
    expect(JSON.parse(run.tokens_json)).toEqual({ input: 7, output: 3, cacheRead: 50, cacheWrite: 40 });

    // Fusionné, le chantier entre dans la comparaison.
    hub.db.prepare("UPDATE tasks SET status = 'merged' WHERE project = 'jeu' AND id = ?").run(task.id);
    const report = routeReport(hub.db);
    expect(report.measuredSince).not.toBeNull();
    expect(report.routes.find((r) => r.route === "caveman")).toMatchObject({ chantiers: 1, tokensMedian: 100, freshMedian: 50, executeRunsMean: 0, runs: 1, failedRuns: 0 });
    expect(report.routes.find((r) => r.route === "direct")).toMatchObject({ chantiers: 0, tokensMedian: null });
    await hub.tasks.idle();
  });
});
