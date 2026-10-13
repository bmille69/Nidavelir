import {
  ExecutionReportOutput,
  Plan,
  PlanOutput,
  Task,
  VerificationOutput,
  type Escalation,
  type ItemFrontmatter,
  type Run,
  type TaskStatus,
} from "@studio/contracts";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { ApprovalService } from "../approvals/approval-service.ts";
import { assertHumanSession, type HumanSession } from "../auth/human-session.ts";
import type { Clock } from "../clock.ts";
import { transaction, type Db } from "../db/database.ts";
import type { Journal } from "../journal/journal.ts";
import type { ProjectRegistry } from "../projects/project-registry.ts";
import { canonicalJson, sha256 } from "../util/hash.ts";
import { nextId } from "../util/ids.ts";
import type { VcsPort } from "../vcs/git.ts";
import type { VisionService } from "../vision/vision-service.ts";
import { describeTool } from "./claude-code.ts";
import { PolicyEngine, TOOLS_BY_MODE, type Decision, type RunMode } from "./policy-engine.ts";
import { linkSharedDirs, unlinkAllLinks } from "./shared-dirs.ts";
import type { AgentBridge, ExecResult, ExecutorPort, RunEvent } from "./port.ts";
import {
  executionPrompt,
  executionSystemPrompt,
  planningPrompt,
  planningSystemPrompt,
  verificationPrompt,
  verificationSystemPrompt,
} from "./prompts.ts";

export class TaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskError";
  }
}

const PLAN_SCHEMA = z.toJSONSchema(PlanOutput, { target: "draft-7" });
const REPORT_SCHEMA = z.toJSONSchema(ExecutionReportOutput, { target: "draft-7" });
const VERIFY_SCHEMA = z.toJSONSchema(VerificationOutput, { target: "draft-7" });
const MAX_EVENTS = 500;
/** Modifications qui ne doivent jamais sortir d'un run, quoi qu'il arrive. */
const FORBIDDEN_CHANGE = /^(studio|\.git|\.claude)(\/|$)/i;

type ActiveRun = {
  id: string;
  root: string;
  project: string;
  task: string;
  kind: RunMode;
  tokenHash: string;
  policy: PolicyEngine;
  abort: AbortController;
  events: RunEvent[];
  waiting: Map<string, (allowed: boolean) => void>;
};

export type RunOutcome = { report?: ExecutionReportOutput; verification?: VerificationOutput; text?: string };

export type TaskServiceOptions = {
  dataDir: string;
  /** URL de base des routes agents, ex. http://127.0.0.1:4317/api/agent/runs */
  agentBaseUrl: () => string;
  escalationTimeoutMs?: number;
  maxTurns?: Partial<Record<RunMode, number>>;
};

/**
 * Tâches de développement sous contrôle (docs/SECURITY.md §3 à §5, ADR-15) :
 * plan en lecture seule → votre validation (liée au hash du plan) → exécution dans
 * un worktree isolé, chaque action filtrée → vérification QA → fusion ou abandon par vous.
 */
export class TaskService {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #journal: Journal;
  readonly #projects: ProjectRegistry;
  readonly #vision: VisionService;
  readonly #approvals: ApprovalService;
  readonly #vcs: VcsPort;
  readonly #executor: ExecutorPort;
  readonly #opts: TaskServiceOptions;
  readonly #active = new Map<string, ActiveRun>();
  readonly #finished = new Map<string, RunEvent[]>();
  readonly #background = new Set<Promise<void>>();

  constructor(deps: {
    db: Db;
    clock: Clock;
    journal: Journal;
    projects: ProjectRegistry;
    vision: VisionService;
    approvals: ApprovalService;
    vcs: VcsPort;
    executor: ExecutorPort;
    options: TaskServiceOptions;
  }) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#journal = deps.journal;
    this.#projects = deps.projects;
    this.#vision = deps.vision;
    this.#approvals = deps.approvals;
    this.#vcs = deps.vcs;
    this.#executor = deps.executor;
    this.#opts = deps.options;
  }

  get executorName(): string {
    return this.#executor.name;
  }

  // ── Lecture ──────────────────────────────────────────────────────────────

  list(project: string): Task[] {
    return (this.#db.prepare("SELECT data_json FROM tasks WHERE project = ? ORDER BY id DESC").all(project) as { data_json: string }[]).map((r) =>
      Task.parse(JSON.parse(r.data_json)),
    );
  }

  get(project: string, id: string): Task {
    const row = this.#db.prepare("SELECT data_json FROM tasks WHERE project = ? AND id = ?").get(project, id) as { data_json: string } | undefined;
    if (!row) throw new TaskError(`Tâche introuvable : ${id}`);
    return Task.parse(JSON.parse(row.data_json));
  }

  plan(project: string, id: string): Plan {
    const row = this.#db.prepare("SELECT data_json, status FROM plans WHERE project = ? AND id = ?").get(project, id) as
      | { data_json: string; status: string }
      | undefined;
    if (!row) throw new TaskError(`Plan introuvable : ${id}`);
    return Plan.parse({ ...JSON.parse(row.data_json), status: row.status });
  }

  runs(project: string, task: string): (Run & { result: RunOutcome | null })[] {
    const rows = this.#db.prepare("SELECT * FROM runs WHERE project = ? AND task = ? ORDER BY started_at").all(project, task) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: String(r.id),
      project: String(r.project),
      task: String(r.task),
      kind: r.kind as Run["kind"],
      status: r.status as Run["status"],
      started_at: String(r.started_at),
      finished_at: (r.finished_at as string | null) ?? null,
      cost_usd: (r.cost_usd as number | null) ?? null,
      error: (r.error as string | null) ?? null,
      result: r.result_json ? (JSON.parse(String(r.result_json)) as RunOutcome) : null,
    }));
  }

  events(runId: string, after = 0): RunEvent[] {
    const list = this.#active.get(runId)?.events ?? this.#finished.get(runId) ?? [];
    return list.filter((e) => e.seq > after);
  }

  escalations(project: string, filter: { task?: string; status?: Escalation["status"] } = {}): Escalation[] {
    const rows = this.#db.prepare("SELECT data_json, status, decided_at FROM escalations WHERE project = ? ORDER BY created_at").all(project) as {
      data_json: string;
      status: string;
      decided_at: string | null;
    }[];
    return rows
      .map((r) => ({ ...(JSON.parse(r.data_json) as Escalation), status: r.status as Escalation["status"], decided_at: r.decided_at }))
      .filter((e) => (!filter.task || e.task === filter.task) && (!filter.status || e.status === filter.status));
  }

  // ── Création et planification ────────────────────────────────────────────

  /** Crée une tâche à partir de décisions validées (une tâche orpheline est refusée). */
  create(session: HumanSession, project: string, input: { decisions: string[]; title?: string; goal?: string }): Task {
    assertHumanSession(session);
    this.#projects.get(project);
    if (!input.decisions.length) throw new TaskError("Une tâche doit s'appuyer sur au moins une décision validée");
    const decisions = input.decisions.map((id) => this.#vision.get(project, id));
    for (const d of decisions) {
      if (d.type !== "decision" || d.status !== "validated") throw new TaskError(`${d.id} n'est pas une décision validée`);
    }
    const now = this.#clock.now();
    const task = Task.parse({
      id: nextId(this.#db, project, "T"),
      project,
      title: input.title?.trim() || decisions[0]!.title,
      goal: input.goal?.trim() || decisions.map((d) => d.statement).join("\n\n"),
      authorized_by: decisions.map((d) => d.id),
      status: "draft",
      feedback: [],
      base_commit: null,
      branch: null,
      worktree: null,
      plan: null,
      created_at: now,
      updated_at: now,
    });
    this.#db.prepare("INSERT INTO tasks (id, project, status, data_json, updated_at) VALUES (?, ?, ?, ?, ?)").run(task.id, project, task.status, JSON.stringify(task), now);
    this.#log(project, "task.created", task.id, { authorized_by: task.authorized_by });
    return task;
  }

  /** Lance la planification (lecture seule) dans le worktree de la tâche. */
  async startPlanning(project: string, id: string): Promise<Task> {
    let task = this.get(project, id);
    if (!["draft", "changes_requested", "failed", "rejected", "cancelled"].includes(task.status)) {
      throw new TaskError(`Impossible de planifier depuis le statut « ${task.status} »`);
    }
    task = await this.#ensureWorktree(task);
    task = this.#update(task, { status: "planning" });
    const repo = this.#projects.get(project).root;
    const changed = (await this.#vcs.diff(repo, task.base_commit!, task.branch!)).files.map((f) => f.path);
    const decisions = this.#decisions(task);
    const ctx = this.#context(task);

    this.#spawn(task, "plan", new PolicyEngine({ mode: "plan", root: task.worktree! }), {
      systemPrompt: planningSystemPrompt(ctx),
      prompt: planningPrompt(task, decisions, changed),
      jsonSchema: PLAN_SCHEMA,
      onResult: (r) => {
        const out = PlanOutput.parse(r.structured);
        const plan = this.#storePlan(task, out);
        this.#update(this.get(project, id), { status: "plan_review", plan: plan.id });
        return { text: out.summary_simple };
      },
      onFailure: () => this.#update(this.get(project, id), { status: "failed" }),
    });
    return task;
  }

  /** Votre accord sur le plan, lié à son hash exact. */
  approvePlan(session: HumanSession, project: string, id: string, hash: string): Task {
    const task = this.get(project, id);
    if (task.status !== "plan_review" || !task.plan) throw new TaskError("Aucun plan en attente de validation");
    const plan = this.plan(project, task.plan);
    if (plan.problems.length) throw new TaskError(`Ce plan contient des problèmes bloquants : ${plan.problems.join(" ; ")}`);
    const approval = this.#approvals.record(session, { project, subject: { kind: "plan", id: plan.id, hash }, verdict: "approved" });
    transaction(this.#db, () => {
      this.#approvals.consume(project, approval.id, { kind: "plan", id: plan.id, hash: plan.hash });
      this.#db.prepare("UPDATE plans SET status = 'approved' WHERE project = ? AND id = ?").run(project, plan.id);
    });
    this.#log(project, "plan.approved", task.id, { plan: plan.id, approval: approval.id });
    return this.#update(task, { status: "approved" });
  }

  rejectPlan(session: HumanSession, project: string, id: string, note?: string): Task {
    assertHumanSession(session);
    const task = this.get(project, id);
    if (task.status !== "plan_review" || !task.plan) throw new TaskError("Aucun plan en attente de validation");
    this.#db.prepare("UPDATE plans SET status = 'rejected' WHERE project = ? AND id = ?").run(project, task.plan);
    this.#log(project, "plan.rejected", task.id, { plan: task.plan, note });
    return this.#update(task, { status: "rejected", feedback: note ? [...task.feedback, note] : task.feedback });
  }

  // ── Exécution ────────────────────────────────────────────────────────────

  async startExecution(session: HumanSession, project: string, id: string): Promise<Task> {
    assertHumanSession(session);
    const task = this.get(project, id);
    if (task.status !== "approved" || !task.plan) throw new TaskError("Le plan doit être validé avant l'exécution");
    const plan = this.plan(project, task.plan);
    if (plan.status !== "approved") throw new TaskError("Le plan n'est pas approuvé");
    const running = this.#update(task, { status: "running" });
    const decisions = this.#decisions(task);
    const ctx = this.#context(task);

    this.#spawn(running, "execute", new PolicyEngine({ mode: "execute", root: task.worktree!, plan }), {
      systemPrompt: executionSystemPrompt(ctx),
      prompt: executionPrompt(task, plan, decisions),
      jsonSchema: REPORT_SCHEMA,
      onResult: async (r) => {
        const parsed = ExecutionReportOutput.safeParse(r.structured);
        const report: ExecutionReportOutput = parsed.success
          ? parsed.data
          : { outcome: "partial", summary: r.text.slice(0, 2000), summary_simple: "Le développeur n'a pas rendu de rapport structuré.", deviations: [], open_issues: [] };
        await this.#vcs.commitAll(task.worktree!, `studio: ${task.id} — ${task.title} (plan ${plan.id})`);
        const repo = this.#projects.get(project).root;
        const { files, patch } = await this.#vcs.diff(repo, task.base_commit!, task.branch!);
        const violations = files.filter((f) => FORBIDDEN_CHANGE.test(f.path));
        if (violations.length) {
          throw new TaskError(`Modifications interdites détectées : ${violations.map((v) => v.path).join(", ")}`);
        }
        // Vérification QA automatique, en lecture seule.
        this.#spawn(this.get(project, id), "verify", new PolicyEngine({ mode: "verify", root: task.worktree!, plan }), {
          systemPrompt: verificationSystemPrompt(ctx),
          prompt: verificationPrompt(task, plan, decisions, patch, report),
          jsonSchema: VERIFY_SCHEMA,
          onResult: (v) => {
            const verification = VerificationOutput.parse(v.structured);
            this.#update(this.get(project, id), { status: "review" });
            return { verification };
          },
          onFailure: () => this.#update(this.get(project, id), { status: "review" }),
        });
        return { report };
      },
      onFailure: () => this.#update(this.get(project, id), { status: "failed" }),
    });
    return running;
  }

  /** Arrête immédiatement le run en cours. Le worktree est conservé pour inspection. */
  cancel(session: HumanSession, project: string, id: string): Task {
    assertHumanSession(session);
    const task = this.get(project, id);
    const runs = [...this.#active.values()].filter((r) => r.project === project && r.task === id);
    if (!runs.length) throw new TaskError("Aucune exécution en cours pour cette tâche");
    for (const r of runs) {
      for (const resolve of r.waiting.values()) resolve(false);
      r.abort.abort();
    }
    this.#log(project, "task.cancelled", id, { runs: runs.map((r) => r.id) });
    return this.#update(task, { status: "cancelled" });
  }

  decideEscalation(session: HumanSession, project: string, escalationId: string, allowed: boolean): Escalation {
    const esc = this.escalations(project).find((e) => e.id === escalationId);
    if (!esc) throw new TaskError(`Demande introuvable : ${escalationId}`);
    if (esc.status !== "pending") throw new TaskError(`Demande déjà traitée (${esc.status})`);
    const hash = sha256(canonicalJson({ tool: esc.tool, input: esc.input }));
    const approval = this.#approvals.record(session, {
      project,
      subject: { kind: "escalation", id: esc.id, hash },
      verdict: allowed ? "approved" : "rejected",
    });
    this.#approvals.consume(project, approval.id, { kind: "escalation", id: esc.id, hash });
    const at = this.#clock.now();
    this.#db.prepare("UPDATE escalations SET status = ?, decided_at = ? WHERE project = ? AND id = ?").run(allowed ? "allowed" : "denied", at, project, esc.id);
    this.#active.get(esc.run)?.waiting.get(esc.id)?.(allowed);
    this.#log(project, allowed ? "escalation.allowed" : "escalation.denied", esc.task, { escalation: esc.id, approval: approval.id, summary: esc.summary });
    return { ...esc, status: allowed ? "allowed" : "denied", decided_at: at };
  }

  // ── Revue, fusion, abandon ───────────────────────────────────────────────

  async review(project: string, id: string) {
    const task = this.get(project, id);
    if (!task.branch || !task.base_commit) throw new TaskError("Cette tâche n'a pas encore de modifications");
    const repo = this.#projects.get(project).root;
    const head = await this.#vcs.branchHead(repo, task.branch);
    const { files, patch } = head ? await this.#vcs.diff(repo, task.base_commit, task.branch) : { files: [], patch: "" };
    const plan = task.plan ? this.plan(project, task.plan) : null;
    const planned = new Set([...(plan?.files_to_create ?? []), ...(plan?.files_to_modify ?? []), ...(plan?.files_to_delete ?? [])].map((f) => f.toLowerCase()));
    const runs = this.runs(project, id);
    return {
      task,
      plan,
      head,
      files: files.map((f) => ({ ...f, planned: planned.has(f.path.toLowerCase()) })),
      patch: patch.length > 400_000 ? `${patch.slice(0, 400_000)}\n[… diff tronqué]` : patch,
      report: runs.filter((r) => r.kind === "execute").at(-1)?.result?.report ?? null,
      verification: runs.filter((r) => r.kind === "verify").at(-1)?.result?.verification ?? null,
      escalations: this.escalations(project, { task: id }),
    };
  }

  /** Fusion dans votre branche courante, après votre accord lié au commit exact présenté. */
  async merge(session: HumanSession, project: string, id: string, headSha: string): Promise<{ task: Task; sha: string }> {
    const task = this.get(project, id);
    if (task.status !== "review" || !task.branch) throw new TaskError("Seule une tâche en revue peut être fusionnée");
    const repo = this.#projects.get(project).root;
    const head = await this.#vcs.branchHead(repo, task.branch);
    const approval = this.#approvals.record(session, { project, subject: { kind: "merge", id: task.id, hash: sha256(headSha) }, verdict: "approved" });
    this.#approvals.consume(project, approval.id, { kind: "merge", id: task.id, hash: sha256(head ?? "") });
    const dirty = await this.#vcs.trackedChanges(repo);
    if (dirty.length) {
      throw new TaskError(
        `Votre projet a des modifications non commitées (${dirty.slice(0, 3).join(", ")}${dirty.length > 3 ? "…" : ""}). Commitez-les ou mettez-les de côté avant de fusionner.`,
      );
    }
    if (!(await this.#vcs.currentBranch(repo))) throw new TaskError("Votre projet n'est sur aucune branche (HEAD détachée)");
    const res = await this.#vcs.merge(repo, task.branch, `studio: fusion de ${task.id} — ${task.title} (${approval.id})`);
    if (!res.ok) throw new TaskError(`Conflit de fusion sur : ${res.conflicts.join(", ") || "?"}. Rien n'a été modifié dans votre projet.`);
    await this.#cleanup(task);
    this.#log(project, "task.merged", id, { approval: approval.id, commit: res.sha });
    return { task: this.#update(this.get(project, id), { status: "merged", worktree: null }), sha: res.sha };
  }

  /** Demande de corrections : vos remarques partent dans un nouveau plan. */
  async requestChanges(session: HumanSession, project: string, id: string, feedback: string): Promise<Task> {
    assertHumanSession(session);
    const task = this.get(project, id);
    if (task.status !== "review") throw new TaskError("Seule une tâche en revue peut recevoir des corrections");
    if (task.plan) this.#db.prepare("UPDATE plans SET status = 'superseded' WHERE project = ? AND id = ?").run(project, task.plan);
    this.#update(task, { status: "changes_requested", feedback: [...task.feedback, feedback.trim()].filter(Boolean), plan: null });
    this.#log(project, "task.changes_requested", id, { feedback });
    return this.startPlanning(project, id);
  }

  async abandon(session: HumanSession, project: string, id: string): Promise<Task> {
    assertHumanSession(session);
    const task = this.get(project, id);
    if (["merged", "abandoned"].includes(task.status)) throw new TaskError(`Tâche déjà ${task.status}`);
    if ([...this.#active.values()].some((r) => r.task === id && r.project === project)) throw new TaskError("Arrêtez d'abord l'exécution en cours");
    await this.#cleanup(task);
    this.#log(project, "task.abandoned", id, {});
    return this.#update(task, { status: "abandoned", worktree: null });
  }

  /** Au démarrage : les runs interrompus par un arrêt du hub sont marqués en échec. */
  recoverInterrupted(): void {
    const now = this.#clock.now();
    this.#db.prepare("UPDATE runs SET status = 'failed', finished_at = ?, error = 'interrompu par l''arrêt du hub' WHERE status = 'running'").run(now);
    this.#db.prepare("UPDATE escalations SET status = 'expired', decided_at = ? WHERE status = 'pending'").run(now);
    for (const row of this.#db.prepare("SELECT project, id FROM tasks WHERE status IN ('planning', 'running')").all() as { project: string; id: string }[]) {
      this.#update(this.get(row.project, row.id), { status: "failed" });
    }
  }

  async idle(): Promise<void> {
    while (this.#background.size) await Promise.allSettled([...this.#background]);
  }

  // ── Pont agent (hook PreToolUse et gardien MCP) ──────────────────────────

  agentPreTool(runId: string, token: string, tool: string, input: Record<string, unknown>): Decision {
    const run = this.#authRun(runId, token);
    const d = run.policy.evaluate(tool, input);
    if (d.decision !== "allow") this.#event(run, "info", `${d.decision === "deny" ? "Refusé" : "Demande d'autorisation"} : ${this.#describe(run, tool, input)} (${d.reason})`);
    if (d.decision === "deny") this.#log(run.project, "policy.denied", run.task, { run: run.id, tool, reason: d.reason, input: summarizeInput(input) });
    return d;
  }

  /** Appelé par le gardien pour une action hors plan : attend votre décision (refus si délai dépassé). */
  async agentPermission(runId: string, token: string, tool: string, input: Record<string, unknown>): Promise<{ behavior: "allow" | "deny"; message?: string }> {
    const run = this.#authRun(runId, token);
    const d = run.policy.evaluate(tool, input);
    if (d.decision === "allow") return { behavior: "allow" };
    if (d.decision === "deny") return { behavior: "deny", message: `Refusé par le hub : ${d.reason}` };

    const esc: Escalation = {
      id: nextId(this.#db, run.project, "E"),
      project: run.project,
      task: run.task,
      run: run.id,
      tool,
      summary: this.#describe(run, tool, input),
      input: summarizeInput(input),
      reason: d.reason,
      status: "pending",
      created_at: this.#clock.now(),
      decided_at: null,
    };
    this.#db
      .prepare("INSERT INTO escalations (id, project, task, run, status, data_json, created_at) VALUES (?, ?, ?, ?, 'pending', ?, ?)")
      .run(esc.id, esc.project, esc.task, esc.run, JSON.stringify(esc), esc.created_at);
    this.#log(run.project, "escalation.requested", run.task, { escalation: esc.id, summary: esc.summary, reason: d.reason });
    this.#event(run, "info", `En attente de votre accord : ${esc.summary}`);

    const allowed = await new Promise<boolean>((resolve) => {
      run.waiting.set(esc.id, resolve);
      setTimeout(() => resolve(false), this.#opts.escalationTimeoutMs ?? 15 * 60_000).unref?.();
    });
    run.waiting.delete(esc.id);
    const current = this.escalations(run.project).find((e) => e.id === esc.id);
    if (current?.status === "pending") {
      this.#db.prepare("UPDATE escalations SET status = 'expired', decided_at = ? WHERE project = ? AND id = ?").run(this.#clock.now(), run.project, esc.id);
    }
    this.#event(run, "info", `${allowed ? "Autorisé" : "Refusé"} par vous : ${esc.summary}`);
    return allowed ? { behavior: "allow" } : { behavior: "deny", message: "Refusé par le directeur créatif. Ne contourne pas : signale-le dans ton rapport." };
  }

  // ── Interne ──────────────────────────────────────────────────────────────

  #spawn(
    task: Task,
    kind: RunMode,
    policy: PolicyEngine,
    spec: {
      systemPrompt: string;
      prompt: string;
      jsonSchema: object;
      onResult: (r: ExecResult) => RunOutcome | Promise<RunOutcome>;
      onFailure: () => void;
    },
  ): string {
    const id = nextId(this.#db, task.project, "RUN");
    const token = randomBytes(32).toString("base64url");
    const run: ActiveRun = {
      id,
      root: task.worktree!,
      project: task.project,
      task: task.id,
      kind,
      tokenHash: sha256(token),
      policy,
      abort: new AbortController(),
      events: [],
      waiting: new Map(),
    };
    this.#active.set(id, run);
    this.#db
      .prepare("INSERT INTO runs (id, project, task, kind, status, token_hash, started_at) VALUES (?, ?, ?, ?, 'running', ?, ?)")
      .run(id, task.project, task.id, kind, run.tokenHash, this.#clock.now());
    this.#log(task.project, "run.started", task.id, { run: id, kind });
    this.#event(run, "info", { plan: "Le développeur étudie le code (lecture seule)…", execute: "Le développeur applique le plan validé…", verify: "Le QA vérifie le travail…" }[kind]);

    const bridge: AgentBridge = {
      preTool: async (tool, input) => this.agentPreTool(id, token, tool, input),
      permission: (tool, input) => this.agentPermission(id, token, tool, input),
    };
    const job = (async () => {
      let status: "done" | "failed" | "cancelled" = "done";
      let error: string | null = null;
      let cost: number | null = null;
      let outcome: RunOutcome | null = null;
      try {
        const result = await this.#executor.run({
          kind,
          runId: id,
          cwd: task.worktree!,
          runDir: join(this.#opts.dataDir, "runs", id),
          systemPrompt: spec.systemPrompt,
          prompt: spec.prompt,
          jsonSchema: spec.jsonSchema,
          tools: TOOLS_BY_MODE[kind],
          maxTurns: this.#opts.maxTurns?.[kind] ?? { plan: 40, execute: 120, verify: 40 }[kind],
          bridge,
          bridgeUrl: `${this.#opts.agentBaseUrl()}/${id}`,
          token,
          onEvent: (type, text) => this.#event(run, type, text),
          signal: run.abort.signal,
        });
        cost = result.costUsd;
        outcome = await spec.onResult(result);
        if (outcome.text) this.#event(run, "result", outcome.text);
      } catch (err) {
        status = run.abort.signal.aborted ? "cancelled" : "failed";
        error = (err as Error).message.slice(0, 500);
        this.#event(run, "error", error);
        if (status === "failed") spec.onFailure();
      } finally {
        for (const resolve of run.waiting.values()) resolve(false);
        this.#db
          .prepare("UPDATE runs SET status = ?, finished_at = ?, cost_usd = ?, error = ?, result_json = ? WHERE project = ? AND id = ?")
          .run(status, this.#clock.now(), cost, error, outcome ? JSON.stringify(outcome) : null, task.project, id);
        this.#active.delete(id);
        this.#finished.set(id, run.events);
        this.#log(task.project, `run.${status}`, task.id, { run: id, kind, cost_usd: cost, error });
      }
    })();
    this.#background.add(job);
    void job.finally(() => this.#background.delete(job));
    return id;
  }

  /** Description lisible, chemins relatifs au jeu (sans le dossier technique du worktree). */
  #describe(run: ActiveRun, tool: string, input: Record<string, unknown>): string {
    const slash = (s: string) => s.replace(/\\/g, "/");
    const text = slash(describeTool(tool, input));
    const root = slash(run.root).replace(/\/+$/, "") + "/";
    // Retire le préfixe du worktree où qu'il apparaisse, sans tenir compte de la casse (Windows).
    let out = "";
    let i = 0;
    const lower = text.toLowerCase();
    const needle = root.toLowerCase();
    for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, i)) {
      out += text.slice(i, at);
      i = at + needle.length;
    }
    return out + text.slice(i);
  }

  #authRun(runId: string, token: string): ActiveRun {
    const run = this.#active.get(runId);
    if (!run || sha256(token) !== run.tokenHash) throw new TaskError("Run inconnu, terminé ou jeton invalide");
    return run;
  }

  #event(run: ActiveRun, type: RunEvent["type"], text: string): void {
    const seq = (run.events.at(-1)?.seq ?? 0) + 1;
    run.events.push({ seq, at: this.#clock.now(), type, text });
    if (run.events.length > MAX_EVENTS) run.events.splice(0, run.events.length - MAX_EVENTS);
  }

  #storePlan(task: Task, out: PlanOutput): Plan {
    const policy = new PolicyEngine({ mode: "plan", root: task.worktree! });
    const base = {
      ...out,
      id: nextId(this.#db, task.project, "PL"),
      project: task.project,
      task: task.id,
      problems: policy.validatePlan(out),
      vision_rev: this.#vision.visionRev(task.project),
      created_at: this.#clock.now(),
    };
    const plan = Plan.parse({ ...base, status: "submitted", hash: sha256(canonicalJson(base)) });
    if (task.plan) this.#db.prepare("UPDATE plans SET status = 'superseded' WHERE project = ? AND id = ? AND status = 'submitted'").run(task.project, task.plan);
    const { status: _s, ...data } = plan;
    this.#db.prepare("INSERT INTO plans (id, project, task, status, data_json) VALUES (?, ?, ?, 'submitted', ?)").run(plan.id, plan.project, plan.task, JSON.stringify(data));
    this.#log(task.project, "plan.submitted", task.id, { plan: plan.id, problems: plan.problems });
    return plan;
  }

  async #ensureWorktree(task: Task): Promise<Task> {
    if (task.worktree && existsSync(task.worktree)) return task;
    const repo = this.#projects.get(task.project).root;
    const base = await this.#vcs.head(repo);
    const branch = `studio/${task.id}`;
    const path = join(this.#opts.dataDir, "worktrees", task.project, task.id);
    mkdirSync(join(path, ".."), { recursive: true });
    if (await this.#vcs.branchHead(repo, branch)) throw new TaskError(`La branche ${branch} existe déjà dans votre projet`);
    await this.#vcs.addWorktree(repo, path, branch, base);
    const linked = await linkSharedDirs(repo, path, this.#vcs);
    this.#log(task.project, "worktree.created", task.id, { path, branch, base, linked });
    return this.#update(task, { base_commit: base, branch, worktree: path });
  }

  async #cleanup(task: Task): Promise<void> {
    const repo = this.#projects.get(task.project).root;
    if (task.worktree && existsSync(task.worktree)) {
      // Jonctions d'abord : git worktree remove --force effacerait leur cible.
      unlinkAllLinks(task.worktree);
      await this.#vcs.removeWorktree(repo, task.worktree).catch(() => {});
    }
    if (task.branch && (await this.#vcs.branchHead(repo, task.branch))) await this.#vcs.deleteBranch(repo, task.branch).catch(() => {});
  }

  #decisions(task: Task): ItemFrontmatter[] {
    return task.authorized_by.map((id) => this.#vision.get(task.project, id));
  }

  #context(task: Task): { brief: string | null; claudeMd: string | null } {
    const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : null);
    return { brief: read(join(task.worktree!, "studio", "BRIEF.md")), claudeMd: read(join(task.worktree!, "CLAUDE.md")) };
  }

  #update(task: Task, patch: Partial<Task> & { status?: TaskStatus }): Task {
    const next = Task.parse({ ...task, ...patch, updated_at: this.#clock.now() });
    this.#db.prepare("UPDATE tasks SET status = ?, data_json = ?, updated_at = ? WHERE project = ? AND id = ?").run(next.status, JSON.stringify(next), next.updated_at, next.project, next.id);
    return next;
  }

  #log(project: string, type: string, subject: string, payload: Record<string, unknown>): void {
    this.#journal.append({ project, actor: { kind: "system" }, type, subject, payload });
  }
}

/** Version courte et sûre de l'entrée d'un outil pour l'affichage et le journal. */
function summarizeInput(input: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = typeof v === "string" && v.length > 2000 ? `${v.slice(0, 2000)}…` : v;
  }
  return out;
}
