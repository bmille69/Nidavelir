import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildExecArgs } from "../src/executor/claude-code.ts";
import { createHub, type Hub } from "../src/hub.ts";
import { buildServer } from "../src/server/http.ts";
import { FakeExecutor, planOutput, REPORT, VERIFIED } from "./fake-executor.ts";
import { DIRECTOR, fakeClock, git, msg, sandbox, cleanupSandboxes, type Sandbox } from "./helpers.ts";

const P = "jeu";
let sb: Sandbox;
let hub: Hub;
let fake: FakeExecutor;
let repo: string;

beforeEach(async () => {
  sb = sandbox();
  fake = new FakeExecutor();
  // Hub dédié avec l'exécuteur factice et un délai d'escalade court.
  sb.hub.close();
  hub = createHub({
    databasePath: join(sb.dir, "hub/.data/tasks.db"),
    registry: { forbiddenTrees: [join(sb.dir, "hub")], forbiddenExact: [sb.dir] },
    clock: fakeClock(),
    executor: fake,
    dataDir: join(sb.dir, "hub/.data"),
    escalationTimeoutMs: 1500,
  });
  sb.hub = hub;
  repo = sb.makeGameRepo("jeu", { "README.md": "# Jeu\n", "src/main.ts": "export {};\n" });
  await hub.projects.register(sb.human(), { path: repo, slug: P, name: "Jeu" });
  // Une décision validée pour autoriser les tâches.
  hub.vision.capture(P, DIRECTOR, { type: "mechanic", title: "Boss à l'arène", statement: "Le boss surgit à l'entrée de son arène.", source: msg("m", "x") });
  const { proposal, hash } = hub.vision.submitProposal(P, DIRECTOR, {
    title: "Apparition des boss",
    statement: "Le boss surgit quand le joueur entre dans son arène.",
    source: { kind: "message", ref: "m" },
    details: { based_on: ["M-0001"] },
  });
  const a = hub.approvals.record(sb.human(), { project: P, subject: { kind: "proposal", id: proposal.id, hash }, verdict: "approved" });
  await hub.vision.decideProposal(P, a.id);
});
afterEach(async () => {
  await hub.tasks.idle();
  cleanupSandboxes();
});

/** Attend qu'une condition soit vraie (runs en arrière-plan). */
async function until(fn: () => boolean, ms = 5000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error("délai dépassé");
    await new Promise((r) => setTimeout(r, 20));
  }
}
const status = (id = "T-0001") => hub.tasks.get(P, id).status;

async function planned(plan = planOutput()) {
  const task = hub.tasks.create(sb.human(), P, { decisions: ["D-0001"] });
  fake.scripts.plan.push(() => plan);
  await hub.tasks.startPlanning(P, task.id);
  await until(() => status() !== "planning");
  return hub.tasks.get(P, task.id);
}

async function approved() {
  const task = await planned();
  const plan = hub.tasks.plan(P, task.plan!);
  return hub.tasks.approvePlan(sb.human(), P, task.id, plan.hash);
}

describe("création et planification", () => {
  it("une tâche doit reposer sur une décision validée", () => {
    expect(() => hub.tasks.create(sb.human(), P, { decisions: [] })).toThrow(/au moins une décision/);
    expect(() => hub.tasks.create(sb.human(), P, { decisions: ["M-0001"] })).toThrow(/n'est pas une décision validée/);
    expect(() => hub.tasks.create({ id: "x" } as never, P, { decisions: ["D-0001"] })).toThrow();
    expect(hub.tasks.create(sb.human(), P, { decisions: ["D-0001"] })).toMatchObject({ id: "T-0001", status: "draft", title: "Apparition des boss" });
  });

  it("le plan se fait dans une copie isolée, en lecture seule, et attend votre validation", async () => {
    const task = await planned();
    expect(task).toMatchObject({ status: "plan_review", branch: "studio/T-0001" });
    expect(task.worktree).toMatch(/worktrees[\\/]jeu[\\/]T-0001$/);
    expect(existsSync(join(task.worktree!, "src/main.ts"))).toBe(true);
    const req = fake.requests[0]!;
    expect(req.tools).toEqual(["Read", "Grep", "Glob", "Bash"]);
    expect(req.prompt).toMatch(/D-0001.*arène/);
    expect(req.systemPrompt).toMatch(/PLANIFICATION/);
    // Le dépôt du jeu n'a pas bougé.
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("pendant le plan, aucune écriture n'est possible", async () => {
    const task = hub.tasks.create(sb.human(), P, { decisions: ["D-0001"] });
    fake.scripts.plan.push(async (t) => {
      await t.write("src/boss.ts", "piraté");
      return planOutput();
    });
    await hub.tasks.startPlanning(P, task.id);
    await until(() => status() === "plan_review");
    expect(fake.tools[0]!.log).toEqual(["Write src/boss.ts → refused"]);
    expect(existsSync(join(hub.tasks.get(P, task.id).worktree!, "src/boss.ts"))).toBe(false);
  });

  it("un plan qui vise des zones interdites ne peut pas être validé", async () => {
    const task = await planned(planOutput({ files_to_modify: ["studio/BRIEF.md"], commands: [{ cmd: "npm test && git push", purpose: "x" }] }));
    const plan = hub.tasks.plan(P, task.plan!);
    expect(plan.problems).toHaveLength(2);
    expect(() => hub.tasks.approvePlan(sb.human(), P, task.id, plan.hash)).toThrow(/problèmes bloquants/);
  });

  it("valider avec un hash qui ne correspond pas au plan affiché échoue", async () => {
    const task = await planned();
    expect(() => hub.tasks.approvePlan(sb.human(), P, task.id, "a".repeat(64))).toThrow(/changé depuis/);
    expect(status()).toBe("plan_review");
  });

  it("refuser le plan, puis replanifier avec vos remarques", async () => {
    const task = await planned();
    hub.tasks.rejectPlan(sb.human(), P, task.id, "Utilise plutôt un fichier JSON");
    expect(status()).toBe("rejected");
    fake.scripts.plan.push(() => planOutput());
    await hub.tasks.startPlanning(P, task.id);
    await until(() => status() === "plan_review");
    expect(fake.requests[1]!.prompt).toMatch(/Utilise plutôt un fichier JSON/);
  });
});

describe("exécution sous contrôle", () => {
  it("parcours complet : prévu = fait, imprévu = vous êtes consulté, interdit = refusé ; puis QA et revue", async () => {
    const task = await approved();
    fake.scripts.execute.push(async (t) => {
      await t.write("src/boss.ts", "export const rule = 'arène';\n");
      await t.write("studio/items/D-0001.md", "piraté");
      await t.bash("curl https://exemple.invalid");
      await t.bash("npm test");
      await t.write("src/extra.ts", "hors plan"); // escalade : refusée ci-dessous
      return REPORT;
    });
    fake.scripts.verify.push(() => VERIFIED);
    await hub.tasks.startExecution(sb.human(), P, task.id);

    await until(() => hub.tasks.escalations(P, { status: "pending" }).length === 1);
    const [esc] = hub.tasks.escalations(P, { status: "pending" });
    // Chemin affiché relatif au jeu, sans le dossier technique de la copie de travail.
    expect(esc).toMatchObject({ tool: "Write", summary: "Écrit src/extra.ts" });
    hub.tasks.decideEscalation(sb.human(), P, esc!.id, false);
    await until(() => status() === "review");

    expect(fake.tools.find((t) => t.req.kind === "execute")!.log).toEqual([
      "Write src/boss.ts → ok",
      "Write studio/items/D-0001.md → refused",
      "Bash curl https://exemple.invalid → refused",
      "Bash npm test → ok",
      "Write src/extra.ts → refused",
    ]);
    const review = await hub.tasks.review(P, task.id);
    expect(review.files).toEqual([{ status: "A", path: "src/boss.ts", planned: true }]);
    expect(review.report).toMatchObject({ outcome: "completed" });
    expect(review.verification).toMatchObject({ verdict: "pass" });
    expect(review.escalations.map((e) => e.status)).toEqual(["denied"]);
    // Rien n'a encore touché votre projet.
    expect(existsSync(join(repo, "src/boss.ts"))).toBe(false);
    expect(readFileSync(join(repo, "studio/items/D-0001.md"), "utf8")).not.toMatch(/piraté/);
    // Le journal trace les refus.
    expect(hub.journal.list({ project: P }).filter((e) => e.type === "policy.denied")).toHaveLength(2);
  });

  it("une action hors plan que vous autorisez est réalisée, et votre accord est enregistré", async () => {
    const task = await approved();
    fake.scripts.execute.push(async (t) => {
      await t.write("src/boss.ts", "x");
      await t.write("src/extra.ts", "autorisé");
      return REPORT;
    });
    fake.scripts.verify.push(() => VERIFIED);
    await hub.tasks.startExecution(sb.human(), P, task.id);
    await until(() => hub.tasks.escalations(P, { status: "pending" }).length === 1);
    hub.tasks.decideEscalation(sb.human(), P, hub.tasks.escalations(P, { status: "pending" })[0]!.id, true);
    await until(() => status() === "review");
    const review = await hub.tasks.review(P, task.id);
    expect(review.files.map((f) => [f.path, f.planned])).toEqual([
      ["src/boss.ts", true],
      ["src/extra.ts", false],
    ]);
    expect(hub.journal.list({ project: P }).some((e) => e.type === "escalation.allowed")).toBe(true);
  });

  it("sans réponse de votre part, la demande expire et l'action est refusée", async () => {
    const task = await approved();
    fake.scripts.execute.push(async (t) => {
      await t.write("src/extra.ts", "x");
      return REPORT;
    });
    fake.scripts.verify.push(() => VERIFIED);
    await hub.tasks.startExecution(sb.human(), P, task.id);
    await until(() => status() === "review", 8000);
    expect(hub.tasks.escalations(P).map((e) => e.status)).toEqual(["expired"]);
    expect(fake.tools.at(-2)!.log).toEqual(["Write src/extra.ts → refused"]);
  });

  it("arrêter une exécution en cours", async () => {
    const task = await approved();
    fake.scripts.execute.push(async (t) => {
      await t.write("src/extra.ts", "x"); // reste bloqué en attente de votre accord
      return REPORT;
    });
    await hub.tasks.startExecution(sb.human(), P, task.id);
    await until(() => hub.tasks.escalations(P, { status: "pending" }).length === 1);
    hub.tasks.cancel(sb.human(), P, task.id);
    await hub.tasks.idle();
    expect(status()).toBe("cancelled");
    expect(hub.tasks.runs(P, task.id).at(-1)).toMatchObject({ kind: "execute", status: "cancelled" });
  });

  it("on ne peut pas exécuter sans plan validé", async () => {
    const task = await planned();
    await expect(hub.tasks.startExecution(sb.human(), P, task.id)).rejects.toThrow(/validé/);
  });

  it("le pont agent refuse un jeton invalide ou un run terminé", async () => {
    const task = await approved();
    let captured!: { runId: string; token: string };
    fake.scripts.execute.push((_t, req) => {
      captured = { runId: req.runId, token: req.token };
      expect(() => hub.tasks.agentPreTool(req.runId, "faux", "Read", { file_path: "README.md" })).toThrow(/jeton invalide/);
      return REPORT;
    });
    fake.scripts.verify.push(() => VERIFIED);
    await hub.tasks.startExecution(sb.human(), P, task.id);
    await until(() => status() === "review");
    expect(() => hub.tasks.agentPreTool(captured.runId, captured.token, "Read", { file_path: "README.md" })).toThrow(/terminé/);
  });
});

describe("revue, fusion, corrections, abandon", () => {
  async function reviewed() {
    const task = await approved();
    fake.scripts.execute.push(async (t) => {
      await t.write("src/boss.ts", "export const rule = 'arène';\n");
      return REPORT;
    });
    fake.scripts.verify.push(() => VERIFIED);
    await hub.tasks.startExecution(sb.human(), P, task.id);
    await until(() => status() === "review");
    return hub.tasks.review(P, task.id);
  }

  it("fusionner : votre accord porte sur le commit exact ; la fusion est annulable par git revert", async () => {
    const review = await reviewed();
    await expect(hub.tasks.merge(sb.human(), P, "T-0001", "0".repeat(40))).rejects.toThrow(/changé depuis/);
    const { sha } = await hub.tasks.merge(sb.human(), P, "T-0001", review.head!);
    expect(status()).toBe("merged");
    expect(readFileSync(join(repo, "src/boss.ts"), "utf8")).toMatch(/arène/);
    expect(git(repo, "log", "-1", "--format=%s %P")).toMatch(/fusion de T-0001 .*\(A-\d+\) \w+ \w+/);
    expect(existsSync(review.task.worktree!)).toBe(false);
    git(repo, "revert", "-m", "1", "--no-edit", sha);
    expect(existsSync(join(repo, "src/boss.ts"))).toBe(false);
  });

  it("refuse de fusionner si vous avez des modifications non commitées", async () => {
    const review = await reviewed();
    writeFileSync(join(repo, "src/main.ts"), "// travail en cours\n");
    await expect(hub.tasks.merge(sb.human(), P, "T-0001", review.head!)).rejects.toThrow(/non commitées/);
    expect(readFileSync(join(repo, "src/main.ts"), "utf8")).toMatch(/travail en cours/);
    expect(status()).toBe("review");
  });

  it("demander des corrections relance un plan avec vos remarques", async () => {
    await reviewed();
    fake.scripts.plan.push(() => planOutput({ files_to_modify: ["src/boss.ts"], files_to_create: [] }));
    await hub.tasks.requestChanges(sb.human(), P, "T-0001", "Ajoute un commentaire sur l'Ogre");
    await until(() => status() === "plan_review");
    const prompt = fake.requests.at(-1)!.prompt;
    expect(prompt).toMatch(/Ajoute un commentaire sur l'Ogre/);
    expect(prompt).toMatch(/déjà modifié[\s\S]*src\/boss\.ts/);
  });

  it("abandonner supprime la copie et la branche, sans toucher au projet", async () => {
    const review = await reviewed();
    await hub.tasks.abandon(sb.human(), P, "T-0001");
    expect(status()).toBe("abandoned");
    expect(existsSync(review.task.worktree!)).toBe(false);
    expect(git(repo, "branch", "--list", "studio/*").trim()).toBe("");
    expect(existsSync(join(repo, "src/boss.ts"))).toBe(false);
  });
});

describe("relais réels (hook et gardien) contre le serveur HTTP", () => {
  const bridge = fileURLToPath(new URL("../src/executor/bridge/", import.meta.url));
  const runHook = (url: string, token: string, input: object) =>
    new Promise<string>((resolve) => {
      const child = execFile(process.execPath, [join(bridge, "hook.mjs"), url], { env: { ...process.env, STUDIO_RUN_TOKEN: token } }, (_e, out) => resolve(out));
      child.stdin!.end(JSON.stringify(input));
    });
  let app: FastifyInstance;
  afterEach(async () => app?.close());

  it("le hook transmet la décision du hub, et refuse si le hub est injoignable ou le jeton faux", async () => {
    const task = await approved();
    app = await buildServer(hub, { port: 4393, gamesRoot: sb.dir, allowedHosts: ["127.0.0.1:4393"], folderPicker: { pick: async () => null } });
    await app.listen({ host: "127.0.0.1", port: 4393 });
    let outputs: string[] = [];
    fake.scripts.execute.push(async (_t, req) => {
      const url = `http://127.0.0.1:4393/api/agent/runs/${req.runId}`;
      outputs = await Promise.all([
        runHook(url, req.token, { tool_name: "Write", tool_input: { file_path: join(req.cwd, "src/boss.ts") } }),
        runHook(url, req.token, { tool_name: "Write", tool_input: { file_path: join(req.cwd, "studio/BRIEF.md") } }),
        runHook(url, "faux-jeton", { tool_name: "Read", tool_input: { file_path: join(req.cwd, "README.md") } }),
        runHook("http://127.0.0.1:1/api/agent/runs/X", req.token, { tool_name: "Read", tool_input: { file_path: "README.md" } }),
      ]);
      return REPORT;
    });
    fake.scripts.verify.push(() => VERIFIED);
    await hub.tasks.startExecution(sb.human(), P, task.id);
    await until(() => status() === "review", 15_000);
    const decisions = outputs.map((o) => JSON.parse(o).hookSpecificOutput.permissionDecision);
    expect(decisions).toEqual(["allow", "deny", "deny", "deny"]);
  }, 30_000);
});

describe("ligne de commande Claude Code", () => {
  it("jamais de contournement, réglages du dépôt ignorés, hook et gardien branchés", () => {
    const args = buildExecArgs({ tools: ["Read", "Edit", "Bash"], maxTurns: 50, jsonSchema: { type: "object" } }, { settings: "s.json", mcp: "m.json", system: "sys.md" }, "sonnet");
    const line = args.join(" ");
    expect(line).not.toMatch(/dangerously|bypassPermissions|acceptEdits|--permission-mode auto/);
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("default");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).toEqual(expect.arrayContaining(["--strict-mcp-config", "--permission-prompt-tool", "mcp__studio__permission_gate"]));
    expect(() => buildExecArgs({ tools: ["Bash(*)"], maxTurns: 1, jsonSchema: {} }, { settings: "", mcp: "", system: "" }, "sonnet")).toThrow();
  });
});
