import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHub } from "../src/hub.ts";
import type { CheckerPort, CheckOutcome } from "../src/quality/checks.ts";
import { FakeExecutor, planOutput, REPORT, VERIFIED } from "./fake-executor.ts";
import { cleanupSandboxes, DIRECTOR, fakeClock, git, msg, sandbox } from "./helpers.ts";

vi.setConfig({ testTimeout: 30_000 });
afterEach(() => cleanupSandboxes());
const P = "jeu";

class FakeChecker implements CheckerPort {
  readonly tests_: CheckOutcome[] = [];
  readonly seen: string[] = [];
  async tests(cwd: string) {
    this.seen.push(cwd);
    return this.tests_.shift() ?? { status: "pass" as const, detail: "ok" };
  }
  async launch() {
    return { status: "pass" as const, detail: "ok" };
  }
}

async function setup() {
  const sb = sandbox();
  const exec = new FakeExecutor();
  const checker = new FakeChecker();
  sb.hub.close();
  const hub = createHub({
    databasePath: join(sb.dir, "hub/.data/bench.db"),
    registry: { forbiddenTrees: [join(sb.dir, "hub")], forbiddenExact: [sb.dir] },
    clock: fakeClock(),
    executor: exec,
    checker,
    dataDir: join(sb.dir, "hub/.data"),
  });
  sb.hub = hub;
  const repo = sb.makeGameRepo("jeu", { "README.md": "# Jeu\n", "src/main.ts": "export {};\n" });
  await hub.projects.register(sb.human(), { path: repo, slug: P, name: "Jeu" });
  hub.projects.setAutonomy(sb.human(), P, "supervised");
  hub.vision.capture(P, DIRECTOR, { type: "mechanic", title: "Boss", statement: "Le boss surgit.", source: msg("m", "x") });
  const { proposal, hash } = hub.vision.submitProposal(P, DIRECTOR, { title: "Boss", statement: "Le boss surgit.", source: { kind: "message", ref: "m" }, details: { based_on: ["M-0001"] } });
  await hub.vision.decideProposal(P, hub.approvals.record(sb.human(), { project: P, subject: { kind: "proposal", id: proposal.id, hash }, verdict: "approved" }).id);

  // Un chantier mené jusqu'à la fusion : il servira de référence.
  const task = hub.tasks.create(sb.human(), P, { decisions: ["D-0001"] });
  exec.scripts.plan.push(() => planOutput());
  await hub.tasks.startPlanning(P, task.id);
  await hub.tasks.idle();
  const plan = hub.tasks.plan(P, hub.tasks.get(P, task.id).plan!);
  hub.tasks.approvePlan(sb.human(), P, task.id, plan.hash);
  exec.scripts.execute.push(async (t) => (await t.write("src/boss.ts", "export const boss = 1;\n"), REPORT));
  exec.scripts.verify.push(() => VERIFIED);
  await hub.tasks.startExecution(sb.human(), P, task.id);
  await hub.tasks.idle();
  const review = await hub.tasks.review(P, task.id);
  await hub.tasks.merge(sb.human(), P, task.id, review.head!);
  return { sb, hub, exec, checker, repo, task: hub.tasks.get(P, task.id) };
}

describe("le banc d'essai des agents (ADR-87)", () => {
  it("un chantier fusionné devient une référence, refaite depuis son point de départ, sans rien fusionner", async () => {
    const { sb, hub, exec, checker, repo, task } = await setup();
    const head = git(repo, "rev-parse", "HEAD").trim();
    expect(() => hub.bench.start(sb.human(), P)).toThrow(/banc est vide/);
    expect(hub.bench.state(P).candidates).toEqual([{ id: task.id, title: task.title }]);
    const c = hub.bench.addCase(sb.human(), P, task.id);
    expect(c).toMatchObject({ source: task.id, base: task.base_commit, original: { costUsd: 0.01 } });
    expect(() => hub.bench.addCase(sb.human(), P, task.id)).toThrow(/déjà au banc/);
    expect(hub.bench.state(P)).toMatchObject({ stale: true, candidates: [], executor: "fake" });

    // Premier passage : le développeur refait le travail, dans une copie partie du même commit.
    let base = "";
    exec.scripts.execute.push(async (t, req) => {
      base = git(req.cwd, "rev-parse", "HEAD").trim();
      expect(existsSync(join(req.cwd, "src/boss.ts"))).toBe(false);
      await t.write("src/boss.ts", "export const boss = 2;\n");
      return REPORT;
    });
    hub.bench.start(sb.human(), P);
    await hub.bench.idle();
    expect(base).toBe(task.base_commit);
    expect(exec.requests.at(-1)!.prompt).toContain(task.goal);
    let st = hub.bench.state(P);
    expect(st.runs[0]).toMatchObject({ status: "done", results: [{ case: c.id, ok: true, outcome: "completed", tests: "pass", launch: "pass", files: 1, costUsd: 0.01 }] });
    expect(st.stale).toBe(false);
    expect(checker.seen.at(-1)).toContain(join("bench", P));

    // Rien dans le jeu : même commit, pas de branche du banc, copie effacée, aucun chantier ajouté.
    expect(git(repo, "rev-parse", "HEAD").trim()).toBe(head);
    expect(git(repo, "branch", "--list", "studio/banc-*")).toBe("");
    expect(readdirSync(join(sb.dir, "hub/.data/bench", P))).toEqual([]);
    expect(hub.tasks.list(P)).toHaveLength(1);

    // Les consignes changent : le banc n'est plus à jour. Second passage, raté (tests cassés).
    hub.tasks.gameState = () => "ignoré par l'empreinte";
    const before = st.fingerprint;
    process.env.STUDIO_MODEL_DEV = "un-autre-modele";
    try {
      st = hub.bench.state(P);
      expect(st.fingerprint).not.toBe(before);
      expect(st.stale).toBe(true);
      checker.tests_.push({ status: "fail", detail: "1 test failed: boss.test.ts" });
      exec.scripts.execute.push(async (t) => (await t.write("src/boss.ts", "cassé"), REPORT));
      hub.bench.start(sb.human(), P);
      await hub.bench.idle();
    } finally {
      delete process.env.STUDIO_MODEL_DEV;
    }
    st = hub.bench.state(P);
    expect(st.runs.map((r) => r.results[0]!.ok)).toEqual([false, true]);
    expect(st.runs[0]!.results[0]!.summary).toMatch(/tests : 1 test failed/);

    // Un développeur qui s'arrête : dit, et la copie est quand même effacée.
    exec.scripts.execute.push(() => {
      throw new Error("limite atteinte");
    });
    hub.bench.start(sb.human(), P);
    await hub.bench.idle();
    expect(hub.bench.state(P).runs[0]!.results[0]).toMatchObject({ ok: false, error: expect.stringMatching(/limite atteinte/) });
    expect(readdirSync(join(sb.dir, "hub/.data/bench", P))).toEqual([]);

    hub.bench.removeCase(sb.human(), P, c.id);
    expect(hub.bench.state(P).cases).toEqual([]);
  });
});
