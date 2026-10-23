import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHub, type Hub } from "../src/hub.ts";
import { PolicyEngine } from "../src/executor/policy-engine.ts";
import { gameUrl, PlayRequest, PlaytestService, type PlayDriver, type PlaySession, type PlaySnapshot, type PlayStep, type Screen } from "../src/quality/playtest.ts";
import { FakeExecutor, REPORT, VERIFIED } from "./fake-executor.ts";
import { FakeOrchestrator } from "./fake-orchestrator.ts";
import { cleanupSandboxes, fakeClock, sandbox, type Sandbox } from "./helpers.ts";

vi.setConfig({ testTimeout: 30_000 });
afterEach(() => cleanupSandboxes());

const P = "destiny";

/** Manette scriptée : note ce que le testeur a joué, comme le ferait le navigateur. */
class FakeDriver implements PlayDriver {
  readonly opened: { key: string; cwd: string; screen: Screen; path: string }[] = [];
  readonly played: PlayStep[][] = [];
  closed = 0;
  failOpen: string | null = null;
  async open(key: string, cwd: string, screen: Screen, path: string): Promise<PlaySession> {
    if (this.failOpen) throw new Error(this.failOpen);
    this.opened.push({ key, cwd, screen, path });
    const driver = this;
    let x = 0;
    return {
      screen,
      async act(steps) {
        driver.played.push(steps);
        x += steps.filter((s) => s.do === "press" && s.key === "ArrowRight").length;
        return steps.some((s) => s.do === "click" && !s.text && s.x === undefined) ? ["étape 1 : clic sans cible (x, y, text ou selector)"] : [];
      },
      async snapshot(): Promise<PlaySnapshot> {
        return { url: "/?studioTest=1", title: "Destiny", text: "Score 0", controls: [{ label: "Jouer", kind: "button", x: 640, y: 400 }], canvases: [{ width: 800, height: 600, x: 0, y: 0, visible: true }], errors: [], failedRequests: [], state: JSON.stringify({ x }), bridge: ["snapshot"] };
      },
      async capture(file) {
        writeFileSync(file, "JPEG");
      },
      async close() {
        driver.closed++;
      },
    };
  }
}

describe("la manette du testeur (ADR-69)", () => {
  it("ouvre le jeu, joue des paquets d'actions, prend des photos (15 au plus) et ferme la partie", async () => {
    const dir = mkdtempSync(join(tmpdir(), "play-"));
    try {
      const driver = new FakeDriver();
      const events: unknown[] = [];
      const service = new PlaytestService({ driver, shotsDir: dir, journal: { append: (e: unknown) => events.push(e) } as never });
      const run = { id: "RUN-0001", project: P, task: "T-0001", cwd: "C:/copie" };
      const opened = await service.handle(run, { action: "open" });
      expect(driver.opened).toEqual([{ key: `${P}/play-T-0001`, cwd: "C:/copie", screen: "pc", path: "" }]);
      expect(opened.text).toMatch(/^Jeu ouvert \(écran PC 1280×720\)\./);
      expect(opened.text).toContain("Boutons et champs visibles (centre x, y) : button « Jouer » (640, 400)");
      expect(opened.image).toMatchObject({ mimeType: "image/jpeg", data: Buffer.from("JPEG").toString("base64") });
      expect(existsSync(opened.image!.file)).toBe(true);

      const moved = await service.handle(run, { action: "act", steps: [{ do: "press", key: "ArrowRight", hold_ms: 300 }, { do: "press", key: "ArrowRight" }] });
      expect(moved.text).toMatch(/^2 action\(s\) jouée\(s\)\./);
      expect(moved.text).toContain('État du jeu (__STUDIO_TEST__.snapshot) : {"x":2}');
      expect(moved.image).toBeUndefined();
      const odd = await service.handle(run, { action: "act", steps: [{ do: "click" }], capture: true });
      expect(odd.text).toContain("⚠ étape 1 : clic sans cible");
      expect(odd.image).toBeDefined();

      // Changer d'écran relance le jeu, et le testeur en est prévenu.
      const phone = await service.handle(run, { action: "act", screen: "phone", steps: [{ do: "click", x: 10, y: 10 }] });
      expect(phone.text).toContain("⚠ Écran changé : le jeu a été relancé depuis le début.");
      expect(driver.opened.at(-1)!.screen).toBe("phone");
      expect(driver.closed).toBe(1);

      for (let k = 0; k < 14; k++) await service.handle(run, { action: "capture" });
      const over = await service.handle(run, { action: "capture" });
      expect(over.image).toBeUndefined();
      expect(over.text).toContain("Plus de photo : 15 déjà prises");

      await service.closeRun(run.id);
      expect(driver.closed).toBe(2);
      expect(events).toEqual([expect.objectContaining({ type: "playtest.done", subject: "T-0001", payload: { run: "RUN-0001", actions: 4, captures: 15 } })]);
      expect((await service.handle(run, { action: "close" })).text).toBe("Aucune partie ouverte.");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("un jeu qui ne s'ouvre pas est dit au testeur, sans planter", async () => {
    const driver = new FakeDriver();
    driver.failOpen = "Ce jeu n'a pas de script « dev » dans package.json.";
    const service = new PlaytestService({ driver, shotsDir: tmpdir() });
    const r = await service.handle({ id: "RUN-1", project: P, task: "T-1", cwd: "x" }, { action: "act", steps: [{ do: "wait", ms: 10 }] });
    expect(r.text).toMatch(/^Impossible d'ouvrir le jeu : Ce jeu n'a pas de script « dev »[\s\S]*Ne réessaie pas en boucle/);
  });

  it("n'ouvre que le jeu lui-même, jamais une autre adresse", () => {
    expect(gameUrl({ url: "http://127.0.0.1:5181/" }, "?niveau=2#boss")).toBe("http://127.0.0.1:5181/?niveau=2&studioTest=1#boss");
    expect(gameUrl({ url: "http://127.0.0.1:5181/" }, "")).toBe("http://127.0.0.1:5181/?studioTest=1");
    for (const path of ["//evil.com/x", "https://evil.com", "/\\evil.com"]) expect(PlayRequest.safeParse({ action: "open", path }).success).toBe(false);
    expect(PlayRequest.safeParse({ action: "act", steps: Array.from({ length: 21 }, () => ({ do: "wait", ms: 1 })) }).success).toBe(false);
    expect(PlayRequest.safeParse({ action: "act", steps: [{ do: "wait", ms: 60_000 }] }).success).toBe(false);
  });

  it("seul le testeur a la manette", () => {
    const root = mkdtempSync(join(tmpdir(), "pol-"));
    try {
      expect(new PolicyEngine({ mode: "verify", root }).evaluate("mcp__studio__jouer", { action: "open" }).decision).toBe("allow");
      expect(new PolicyEngine({ mode: "execute", root }).evaluate("mcp__studio__jouer", { action: "open" }).decision).toBe("deny");
      expect(new PolicyEngine({ mode: "plan", root }).evaluate("mcp__studio__jouer", { action: "open" }).decision).toBe("deny");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("le relais MCP du studio (gate.mjs)", () => {
  const GATE = fileURLToPath(new URL("../src/executor/bridge/gate.mjs", import.meta.url));

  /** Lance le relais comme Claude Code le fait, face à un faux hub ; rend les réponses JSON-RPC. */
  async function talk(env: Record<string, string>, messages: object[], hub: (path: string, body: unknown, auth: string) => { status: number; body: unknown }) {
    const server = createServer((req, res) => {
      let data = "";
      req.on("data", (c) => (data += c));
      req.on("end", () => {
        const r = hub(req.url ?? "", JSON.parse(data || "{}"), String(req.headers.authorization ?? ""));
        res.writeHead(r.status, { "content-type": "application/json" }).end(JSON.stringify(r.body));
      });
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const port = (server.address() as { port: number }).port;
    const child = spawn(process.execPath, [GATE, `http://127.0.0.1:${port}/api/agent/runs/RUN-0007`], { env: { ...process.env, STUDIO_RUN_TOKEN: "jeton", ...env }, stdio: ["pipe", "pipe", "inherit"] });
    const replies: Record<string, unknown>[] = [];
    let buffer = "";
    child.stdout.setEncoding("utf8").on("data", (c: string) => {
      buffer += c;
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        replies.push(JSON.parse(buffer.slice(0, nl)));
        buffer = buffer.slice(nl + 1);
      }
    });
    for (const m of messages) child.stdin.write(JSON.stringify(m) + "\n");
    await vi.waitFor(() => expect(replies).toHaveLength(messages.length), { timeout: 10_000 });
    child.kill();
    server.close();
    return replies.sort((a, b) => Number(a.id) - Number(b.id));
  }

  it("le testeur voit l'outil jouer ; ses appels vont au hub avec le jeton du run et la photo revient en image", async () => {
    const calls: unknown[] = [];
    const [list, call] = await talk(
      { STUDIO_PLAY: "1" },
      [
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "jouer", arguments: { action: "open", screen: "phone" } } },
      ],
      (path, body, auth) => {
        calls.push({ path, body, auth });
        return { status: 200, body: { text: "Jeu ouvert.", image: { data: "QUJD", mimeType: "image/jpeg", file: "x.jpg" } } };
      },
    );
    expect(((list!.result as { tools: { name: string }[] }).tools).map((t) => t.name)).toEqual(["permission_gate", "jouer"]);
    expect(calls).toEqual([{ path: "/api/agent/runs/RUN-0007/play", body: { action: "open", screen: "phone" }, auth: "Bearer jeton" }]);
    expect(call!.result).toEqual({ content: [{ type: "text", text: "Jeu ouvert." }, { type: "image", data: "QUJD", mimeType: "image/jpeg" }] });
  });

  it("sans manette (développeur), l'outil n'existe pas ; un refus du hub est une erreur pour l'agent", async () => {
    const [list] = await talk({}, [{ jsonrpc: "2.0", id: 1, method: "tools/list" }], () => ({ status: 500, body: {} }));
    expect(((list!.result as { tools: { name: string }[] }).tools).map((t) => t.name)).toEqual(["permission_gate"]);
    const [, refused] = await talk(
      { STUDIO_PLAY: "1" },
      [
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "jouer", arguments: { action: "open" } } },
      ],
      () => ({ status: 403, body: { error: "Seul le testeur peut jouer au jeu" } }),
    );
    expect(refused!.result).toEqual({ content: [{ type: "text", text: "Refusé (hub 403) : Seul le testeur peut jouer au jeu" }], isError: true });
  });
});

describe("le testeur joue avant de donner son avis (atelier)", () => {
  async function setup(driver: PlayDriver | undefined, scripts: Record<string, string> = { dev: "vite" }) {
    const fake = new FakeOrchestrator();
    const exec = new FakeExecutor();
    const sb: Sandbox = sandbox();
    sb.hub.close();
    const hub: Hub = createHub({
      databasePath: join(sb.dir, "hub/.data/play.db"),
      registry: { forbiddenTrees: [join(sb.dir, "hub")], forbiddenExact: [sb.dir] },
      clock: fakeClock(),
      orchestrator: fake,
      executor: exec,
      dataDir: join(sb.dir, "hub/.data"),
      autopilot: { synthesisDelayMs: 0 },
      playDriver: driver,
    });
    sb.hub = hub;
    const root = sb.makeGameRepo("games/destiny", { "README.md": "# Destiny\n", "package.json": JSON.stringify({ name: "destiny", scripts }), "src/main.ts": "export {};\n" });
    await hub.projects.register(sb.human(), { path: root, slug: P, name: "Destiny Survivor" });
    hub.projects.setAutonomy(sb.human(), P, "workshop");
    return { sb, hub, fake, exec };
  }
  const settle = async (hub: Hub) => {
    for (let k = 0; k < 6; k++) {
      await hub.conversations.idle();
      await hub.tasks.idle();
      await hub.autopilot?.idle();
      await hub.gameState.idle();
    }
  };
  const brief = (title: string) => `Proposition.\n[[CHANTIER: ${title}]]\nObjectif : ${title}.\n[[/CHANTIER]]`;

  it("le testeur reçoit la manette, joue dans la copie du chantier, et le compte rendu dit ce qu'il a essayé", async () => {
    const driver = new FakeDriver();
    const { hub, fake, exec } = await setup(driver);
    exec.scripts.execute.push(async (t) => {
      await t.write("src/dash.ts", "export const dash = 1;\n");
      // Le développeur n'a pas la manette.
      expect(await t.req.bridge.preTool("mcp__studio__jouer", { action: "open" })).toMatchObject({ decision: "deny" });
      await expect(hub.tasks.agentPlay(t.req.runId, t.req.token, { action: "open" })).rejects.toThrow(/Seul le testeur/);
      return REPORT;
    });
    exec.scripts.verify.push(async (t, req) => {
      expect(await t.req.bridge.preTool("mcp__studio__jouer", { action: "open" })).toMatchObject({ decision: "allow" });
      await hub.tasks.agentPlay(req.runId, req.token, { action: "open" });
      const r = await hub.tasks.agentPlay(req.runId, req.token, { action: "act", steps: [{ do: "press", key: "ArrowRight", hold_ms: 200 }], capture: true });
      expect(r.text).toContain('{"x":1}');
      // Un autre jeton ne joue pas.
      await expect(hub.tasks.agentPlay(req.runId, "faux", { action: "capture" })).rejects.toThrow(/jeton invalide/);
      return { ...VERIFIED, playtest: { played: true, summary: "J'ai foncé à droite : le personnage avance et le score reste affiché.", unverified: ["le dash au téléphone"] } };
    });
    fake.replies.push(brief("Dash"));
    const t = hub.conversations.createThread(P, "x");
    await hub.conversations.send(P, t.id, "go");
    await settle(hub);

    expect(exec.requests.map((r) => [r.kind, Boolean(r.play)])).toEqual([["execute", false], ["verify", true]]);
    expect(exec.requests[1]!.maxTurns).toBe(60);
    expect(exec.requests[1]!.systemPrompt).toContain("TU PEUX JOUER AU JEU de cette copie avec l'outil jouer");
    expect(exec.requests[0]!.systemPrompt).toContain("window.__STUDIO_TEST__");
    // Dans la copie du chantier, jamais dans votre jeu.
    expect(driver.opened[0]!.cwd).toMatch(/[\\/]worktrees[\\/]destiny[\\/]T-0001$/);
    expect(driver.opened[0]!.cwd).not.toBe(hub.projects.get(P).root);
    // Fin du run : la partie est fermée même si le testeur l'a oubliée.
    expect(driver.closed).toBe(1);
    expect(hub.journal.list({ project: P, limit: 200 }).some((e) => e.type === "playtest.done")).toBe(true);
    const last = hub.conversations.messages(P, t.id).at(-1)!.text;
    expect(last).toMatch(/fusionné dans votre jeu/);
    expect(last).toContain("▶ Essayé en jouant : J'ai foncé à droite : le personnage avance et le score reste affiché.");
    expect(last).toContain("Pas vérifié en jeu : le dash au téléphone");
  });

  it("sans script « dev » (ou sans manette), le testeur ne la reçoit pas et le compte rendu ne prétend rien", async () => {
    const { hub, fake, exec } = await setup(new FakeDriver(), { test: "vitest" });
    exec.scripts.execute.push(async (t) => {
      await t.write("src/a.ts", "export {};\n");
      return REPORT;
    });
    exec.scripts.verify.push(() => ({ ...VERIFIED, playtest: { played: false, summary: "", unverified: [] } }));
    fake.replies.push(brief("Sans jeu web"));
    const t = hub.conversations.createThread(P, "x");
    await hub.conversations.send(P, t.id, "go");
    await settle(hub);
    expect(exec.requests[1]!.play).toBe(false);
    expect(exec.requests[1]!.maxTurns).toBe(30);
    expect(exec.requests[1]!.systemPrompt).not.toContain("TU PEUX JOUER");
    expect(hub.conversations.messages(P, t.id).at(-1)!.text).toContain("Le testeur n'a pas joué au jeu cette fois : il a vérifié par le code et les tests.");
    expect(readFileSync(join(hub.projects.get(P).root, "package.json"), "utf8")).not.toContain("studioTest");
  });
});
