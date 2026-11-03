import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { directExecutionSystemPrompt, E2E_RULE, E2E_TESTER_RULE, executionSystemPrompt, POSE_RULE, SELF_CHECK_RULE, verificationSystemPrompt, WEB_POSE_RULE } from "../src/executor/prompts.ts";
import { createHub } from "../src/hub.ts";
import { checksForTester, describeChecks, RealChecker, regressionFeedback, type CheckerPort, type CheckOutcome } from "../src/quality/checks.ts";
import { cleanupSandboxes, fakeClock, sandbox } from "./helpers.ts";

vi.setConfig({ testTimeout: 60_000 });
afterEach(() => cleanupSandboxes());
const P = "jeu";
const ok: CheckOutcome = { status: "pass", detail: "ok" };

/** Un faux vérificateur ; `e2e` : réponses de la suite de bout en bout, la copie puis le jeu actuel (ADR-128). */
function fakeChecker(root: () => string, e2e?: { chantier: CheckOutcome; jeu?: CheckOutcome }): CheckerPort & { calls: string[] } {
  const calls: string[] = [];
  const where = (cwd: string) => (cwd === root() ? "jeu" : "chantier");
  const checker: CheckerPort & { calls: string[] } = {
    calls,
    async tests(cwd) {
      calls.push(`tests:${where(cwd)}`);
      return ok;
    },
    async launch(_key, cwd) {
      calls.push(`launch:${where(cwd)}`);
      return ok;
    },
  };
  if (e2e) {
    checker.e2e = async (cwd) => {
      calls.push(`e2e:${where(cwd)}`);
      return where(cwd) === "jeu" ? (e2e.jeu ?? ok) : e2e.chantier;
    };
  }
  return checker;
}

async function setup(make: (root: () => string) => CheckerPort & { calls: string[] }) {
  const sb = sandbox();
  let repo = "";
  const checker = make(() => repo);
  sb.hub.close();
  const hub = createHub({
    databasePath: join(sb.dir, "hub/.data/courts.db"),
    registry: { forbiddenTrees: [join(sb.dir, "hub")], forbiddenExact: [sb.dir] },
    clock: fakeClock(),
    checker,
    dataDir: join(sb.dir, "hub/.data"),
  });
  sb.hub = hub;
  repo = sb.makeGameRepo("jeu", { "README.md": "# Jeu\n" });
  await hub.projects.register(sb.human(), { path: repo, slug: P, name: "Jeu" });
  const worktree = join(sb.dir, "copie");
  mkdirSync(worktree, { recursive: true });
  const run = async () => {
    const report = await hub.checks!.run(P, "T-0001", worktree);
    const done = hub.journal.list({ project: P }).filter((e) => e.type === "check.done").at(-1)!;
    return { report, payload: done.payload as Record<string, unknown> };
  };
  return { hub, checker, run };
}

describe("ADR-130 : un seul gros contrôle à la fois pour tout le studio", () => {
  it("deux chantiers qui finissent en même temps : le second attend que le premier ait fini ses contrôles", async () => {
    let active = 0;
    let peak = 0;
    const order: string[] = [];
    const { hub } = await setup((root) => {
      const c = fakeChecker(root);
      c.tests = async (cwd) => {
        active++;
        peak = Math.max(peak, active);
        order.push(`début:${cwd.slice(-1)}`);
        await new Promise((r) => setTimeout(r, 50));
        order.push(`fin:${cwd.slice(-1)}`);
        active--;
        return ok;
      };
      return c;
    });
    const base = mkdtempSync(join(tmpdir(), "lourd-"));
    for (const k of ["1", "2", "3"]) mkdirSync(join(base, `copie${k}`));
    try {
      const runs = ["1", "2", "3"].map((k) => hub.checks!.run(P, `T-000${k}`, join(base, `copie${k}`)));
      await Promise.resolve();
      expect(hub.checks!.waiting).toBe(2);
      await Promise.all(runs);
      expect(peak).toBe(1);
      expect(order).toEqual(["début:1", "fin:1", "début:2", "fin:2", "début:3", "fin:3"]);
      expect(hub.checks!.waiting).toBe(0);
      // Le tour est rendu : un contrôle suivant part sans attendre.
      await hub.checks!.run(P, "T-0004", join(base, "copie1"));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("un contrôle qui plante rend quand même son tour", async () => {
    let first = true;
    const { hub } = await setup((root) => {
      const c = fakeChecker(root);
      c.launch = async () => {
        if (first) {
          first = false;
          throw new Error("boum");
        }
        return ok;
      };
      return c;
    });
    const base = mkdtempSync(join(tmpdir(), "lourd-"));
    try {
      const r = await hub.checks!.run(P, "T-0001", base);
      expect(r.launch.status).toBe("none");
      const r2 = await hub.checks!.run(P, "T-0002", base);
      expect(r2.launch.status).toBe("pass");
      expect(hub.checks!.waiting).toBe(0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("ADR-128 : le hub lance lui-même les tests de bout en bout", () => {
  it("sans méthode e2e : ni le rapport ni le journal n'ont de clé e2e", async () => {
    const { run, checker } = await setup((root) => fakeChecker(root));
    const { report, payload } = await run();
    expect("e2e" in report).toBe(false);
    expect("e2e" in report.before).toBe(false);
    expect("e2e" in payload).toBe(false);
    expect(checker.calls).toEqual(["tests:chantier", "launch:chantier"]);
    expect(checksForTester(report)).not.toContain("bout en bout");
  });

  it("une suite qui passe : notée, montrée au Testeur, pas relancée sur le jeu actuel", async () => {
    const { run, checker } = await setup((root) => fakeChecker(root, { chantier: ok }));
    const { report, payload } = await run();
    expect(report.e2e?.status).toBe("pass");
    expect(report.regression).toBe(false);
    expect(payload.e2e).toBe("pass");
    expect(checker.calls).toEqual(["tests:chantier", "launch:chantier", "e2e:chantier"]);
    expect(checksForTester(report)).toContain("- Tests de bout en bout (npm run test:e2e) : OK");
    expect(describeChecks(report)).toContain("tests de bout en bout ✓");
  });

  it("une suite qui n'a rien à lancer (« none ») reste invisible", async () => {
    const { run } = await setup((root) => fakeChecker(root, { chantier: { status: "none", detail: "pas de script « test:e2e »" } }));
    const { report, payload } = await run();
    expect("e2e" in report).toBe(false);
    expect("e2e" in report.before).toBe(false);
    expect("e2e" in payload).toBe(false);
  });

  it("échec dans la copie, succès sur le jeu actuel : régression, citée au Développeur", async () => {
    const fail: CheckOutcome = { status: "fail", detail: "1 failed: e2e/hydrophone.spec.ts" };
    const { run, checker } = await setup((root) => fakeChecker(root, { chantier: fail, jeu: ok }));
    const { report } = await run();
    expect(checker.calls).toEqual(["tests:chantier", "launch:chantier", "e2e:chantier", "e2e:jeu"]);
    expect(report.regression).toBe(true);
    expect(report.before.e2e?.status).toBe("pass");
    expect(regressionFeedback(report)).toContain("Les tests de bout en bout (npm run test:e2e) ne passent plus");
    expect(regressionFeedback(report)).toContain("hydrophone.spec.ts");
    expect(checksForTester(report)).toContain("RÉGRESSION");
  });

  it("échec des deux côtés : déjà cassé, pas une régression", async () => {
    const fail: CheckOutcome = { status: "fail", detail: "1 failed" };
    const { run } = await setup((root) => fakeChecker(root, { chantier: fail, jeu: fail }));
    const { report } = await run();
    expect(report.regression).toBe(false);
    expect(regressionFeedback(report)).not.toContain("bout en bout");
    expect(checksForTester(report)).toContain("déjà le cas avant ce chantier");
  });

  it("le jeu actuel n'est relancé qu'une fois par commit, même si plusieurs passes échouent", async () => {
    const fail: CheckOutcome = { status: "fail", detail: "1 failed" };
    const { run, checker } = await setup((root) => fakeChecker(root, { chantier: fail, jeu: fail }));
    await run();
    const { report } = await run();
    expect(checker.calls.filter((c) => c === "e2e:jeu")).toHaveLength(1);
    expect(checker.calls.filter((c) => c === "e2e:chantier")).toHaveLength(2);
    expect(report.before.e2e?.status).toBe("fail");
  });
});

describe("ADR-128 : RealChecker.e2e", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });
  const game = (scripts: Record<string, string> | null, modules = true) => {
    const dir = mkdtempSync(join(tmpdir(), "e2e-"));
    dirs.push(dir);
    if (scripts) writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "jeu", private: true, scripts }));
    if (modules) mkdirSync(join(dir, "node_modules"));
    return dir;
  };
  const checker = () => new RealChecker({ workDir: join(tmpdir(), "e2e-hub") });

  it("rien à lancer sans script test:e2e, ni sans node_modules", async () => {
    expect((await checker().e2e(game({ test: "vitest" }))).status).toBe("none");
    expect((await checker().e2e(game(null))).status).toBe("none");
    expect((await checker().e2e(game({ "test:e2e": 'node -e "process.exit(0)"' }, false))).status).toBe("none");
  });

  it("le code de sortie fait le verdict", async () => {
    expect((await checker().e2e(game({ "test:e2e": 'node -e "process.exit(0)"' }))).status).toBe("pass");
    expect((await checker().e2e(game({ "test:e2e": 'node -e "process.exit(1)"' }))).status).toBe("fail");
  });

  it("transmet un port libre dans E2E_PORT", async () => {
    const dir = game({ "test:e2e": `node -e "const p=process.env.E2E_PORT;if(!p)process.exit(1);require('fs').writeFileSync('port.txt',p)"` });
    expect((await checker().e2e(dir)).status).toBe("pass");
    const port = Number(readFileSync(join(dir, "port.txt"), "utf8"));
    expect(port).toBeGreaterThan(0);
    expect(port).toBeLessThan(65536);
  });
});

describe("ADR-128 et ADR-129 : les prompts", () => {
  const base = { brief: null, claudeMd: null };
  const prompts = [executionSystemPrompt, directExecutionSystemPrompt];

  it("E2E_RULE seulement pour un jeu avec sa suite de bout en bout", () => {
    for (const p of prompts) {
      expect(p({ ...base, e2e: true })).toContain(E2E_RULE);
      expect(p(base)).not.toContain(E2E_RULE);
    }
    expect(verificationSystemPrompt({ ...base, e2e: true })).toContain(E2E_TESTER_RULE);
    expect(verificationSystemPrompt(base)).not.toContain(E2E_TESTER_RULE);
  });

  it("SELF_CHECK_RULE toujours ; les poses web pour un jeu web, celles de Godot pour Godot", () => {
    for (const p of prompts) {
      for (const godot of [true, false, undefined]) expect(p({ ...base, godot })).toContain(SELF_CHECK_RULE);
      expect(p(base)).toContain(WEB_POSE_RULE);
      expect(p(base)).not.toContain(POSE_RULE);
      expect(p({ ...base, godot: true })).toContain(POSE_RULE);
      expect(p({ ...base, godot: true })).not.toContain(WEB_POSE_RULE);
    }
  });
});
