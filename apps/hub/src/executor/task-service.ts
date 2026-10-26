import type { PlayRequest, PlayResult, PlaytestService } from "../quality/playtest.ts";
import { GODOT_IMPORT, GODOT_TESTS, hasBridge, hasStudioTests, isGodot } from "../godot/toolchain.ts";
import type { SkillService } from "../skills/skill-service.ts";
import type { UsageService } from "../usage/usage-service.ts";
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
  directExecutionPrompt,
  directExecutionSystemPrompt,
  executionPrompt,
  executionSystemPrompt,
  planningPrompt,
  planningSystemPrompt,
  verificationPrompt,
  verificationSystemPrompt,
  type ProjectContext,
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
/** Un chantier dans l'un de ces états occupe le projet : les suivants attendent leur tour (ADR-31). */
const ACTIVE: readonly TaskStatus[] = ["planning", "plan_review", "approved", "running", "review", "changes_requested"];

/** Chantier marqué « (gros) » par le Concepteur ou le directeur : le développeur prend son modèle des gros chantiers (ADR-41). */
export const isBigTask = (task: Pick<Task, "title">): boolean => /\(gros\)/i.test(task.title);

/** Jauges d'abonnement au-delà desquelles la file attend la remise à zéro au lieu de lancer un chantier voué à l'échec (ADR-41). */
const LIMIT_PAUSE = { five_hour: 0.85, seven_day: 0.95 } as const;
/** Modifications qui ne doivent jamais sortir d'un run, quoi qu'il arrive. */
const FORBIDDEN_CHANGE = /^(studio|\.git|\.claude)(\/|$)/i;

type ActiveRun = {
  id: string;
  root: string;
  project: string;
  task: string;
  kind: RunMode;
  startedAt: string;
  tokenHash: string;
  policy: PolicyEngine;
  /** Dernier dossier courant du terminal de l'agent, rapporté par le hook (ADR-38). */
  cwd?: string;
  abort: AbortController;
  events: RunEvent[];
  waiting: Map<string, (allowed: boolean) => void>;
};

/** Ce que le hub a vérifié lui-même, transmis au testeur. */
export type HubChecks = { summary: string; screenshot: string | null };

export type RunOutcome ={ report?: ExecutionReportOutput; verification?: VerificationOutput; text?: string };

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
  readonly #starting = new Set<string>();
  /** Prévenu quand un plan attend une validation (pilote automatique, ADR-20). */
  onPlanSubmitted: ((project: string, id: string) => Promise<unknown> | void) | null = null;
  /** Prévenu à chaque changement de statut d'une tâche (nouvelles dans la discussion d'origine, ADR-24). */
  onStatus: ((task: Task) => void) | null = null;
  /** Prévenu quand une action attend votre autorisation (notification, ADR-30). */
  onEscalation: ((esc: Escalation) => void) | null = null;
  /** Prévenu quand un run est terminé et enregistré (son résultat est alors lisible). Une promesse rendue est attendue par idle(). */
  onRunFinished: ((task: Task, kind: RunMode) => unknown) | null = null;
  /** Carnet « État du jeu » donné aux agents (ADR-33). */
  gameState: ((project: string) => string | null) | null = null;
  /** Vérifications du hub entre le développeur et le testeur : tests, lancement et capture du jeu (ADR-32, ADR-33). */
  beforeVerify: ((task: Task) => Promise<HubChecks | null>) | null = null;
  /** La manette du testeur (ADR-69) : absente, le testeur ne joue pas. */
  playtest: PlaytestService | null = null;
  /** Prévenu quand le projet est libre et qu'aucun chantier n'attend son tour (séance autonome, ADR-31). */
  onQueueEmpty: ((project: string) => unknown) | null = null;
  /** Bibliothèque de compétences (ADR-29). */
  skills: SkillService | null = null;
  /** Compteur d'utilisation (jetons et limites rapportés par Claude Code). */
  usage: UsageService | null = null;
  /** File en pause jusqu'à la remise à zéro de l'abonnement, par projet. */
  readonly #paused = new Map<string, NodeJS.Timeout>();
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

  /** Runs en cours, tous projets confondus, avec leur dernier événement (vue « Studio »). */
  activeRuns(): { id: string; project: string; task: string; kind: RunMode; started_at: string; last: RunEvent | null }[] {
    return [...this.#active.values()].map((r) => ({
      id: r.id,
      project: r.project,
      task: r.task,
      kind: r.kind,
      started_at: r.startedAt,
      last: r.events.findLast((e) => e.type !== "info") ?? r.events.at(-1) ?? null,
    }));
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
    return this.#create(project, input, {});
  }

  /**
   * Le directeur confie un travail au développeur, dans le cadre de l'autonomie que vous
   * lui avez donnée (ADR-22). Toujours appuyé sur des décisions validées ; le plan suit
   * ensuite les règles habituelles (votre accord, ou validation déléguée s'il est sans risque).
   */
  createDelegated(project: string, input: { decisions: string[]; title?: string; goal?: string }, autonomy: string): Task {
    if (this.#projects.get(project).autonomy === "supervised") throw new TaskError("Autonomie « Je valide tout » : c'est vous qui lancez les tâches");
    return this.#create(project, input, { delegated: true, autonomy });
  }

  /**
   * Mode atelier (ADR-24) : chantier lancé depuis une discussion quand vous dites « go ».
   * La consigne rédigée par le directeur tient lieu de cahier des charges ; la discussion est sa trace.
   */
  createFromConversation(project: string, input: { title: string; goal: string; decisions?: string[]; reworks?: string[] }, thread: string): Task {
    if (this.#projects.get(project).autonomy === "supervised") throw new TaskError("Autonomie « Je valide tout » : c'est vous qui lancez les tâches");
    // Seul un chantier déjà fusionné peut être « repris » (ADR-32).
    const reworks = (input.reworks ?? []).filter((id) => this.list(project).some((t) => t.id === id && t.status === "merged"));
    return this.#create(project, { decisions: input.decisions ?? [], title: input.title, goal: input.goal, reworks }, { delegated: true, thread, ...(reworks.length ? { reworks } : {}) }, { thread });
  }

  #create(
    project: string,
    input: { decisions: string[]; title?: string; goal?: string; reworks?: string[] },
    extra: Record<string, unknown>,
    origin: { thread: string } | null = null,
  ): Task {
    this.#projects.get(project);
    if (!input.decisions.length && !origin) throw new TaskError("Une tâche doit s'appuyer sur au moins une décision validée");
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
      origin,
      reworks: input.reworks ?? [],
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
    this.#log(project, "task.created", task.id, { authorized_by: task.authorized_by, ...extra });
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

    this.#spawn(task, "plan", new PolicyEngine({ mode: "plan", root: task.worktree!, readable: this.#readable(task) }), {
      systemPrompt: planningSystemPrompt(ctx),
      prompt: planningPrompt(task, decisions, changed),
      jsonSchema: PLAN_SCHEMA,
      onResult: (r) => {
        const out = PlanOutput.parse(r.structured);
        const plan = this.#storePlan(task, out);
        this.#update(this.get(project, id), { status: "plan_review", plan: plan.id });
        if (this.onPlanSubmitted) {
          const hook = Promise.resolve(this.onPlanSubmitted(project, id)).then(
            () => {},
            () => {},
          );
          this.#background.add(hook);
          void hook.finally(() => this.#background.delete(hook));
        }
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
    return this.#execute(project, id);
  }

  /**
   * Autonomie « autonome » (ADR-20) : le directeur valide lui-même un plan sans risque
   * (aucun problème, aucune suppression, aucune nouvelle dépendance, aucune question),
   * puis lance le travail. La fusion dans votre jeu reste toujours à vous.
   */
  async autoApprovePlan(project: string, id: string, autonomy: string): Promise<boolean> {
    const task = this.get(project, id);
    if (task.status !== "plan_review" || !task.plan) return false;
    const plan = this.plan(project, task.plan);
    if (this.planNeedsYou(plan, autonomy).length) return false;
    const approval = this.#approvals.recordDelegated({
      project,
      subject: { kind: "plan", id: plan.id, hash: plan.hash },
      verdict: "approved",
      autonomy,
      run: "autopilot",
      note: "Plan sans risque, validé par le directeur",
    });
    transaction(this.#db, () => {
      this.#approvals.consume(project, approval.id, { kind: "plan", id: plan.id, hash: plan.hash });
      this.#db.prepare("UPDATE plans SET status = 'approved' WHERE project = ? AND id = ?").run(project, plan.id);
    });
    this.#log(project, "plan.approved", task.id, { plan: plan.id, approval: approval.id, delegated: true });
    this.#update(task, { status: "approved" });
    await this.#execute(project, id);
    return true;
  }

  /**
   * Ce qui, dans un plan, demande votre accord même en autonomie : problèmes bloquants,
   * suppressions, nouvelles bibliothèques. En atelier, les questions du développeur ne bloquent
   * pas (il part de ses hypothèses, que vous verrez au résultat).
   */
  planNeedsYou(plan: Plan, autonomy: string): string[] {
    const why: string[] = [];
    if (plan.problems.length) why.push(...plan.problems);
    if (plan.files_to_delete.length) why.push(`il supprime ${plan.files_to_delete.join(", ")}`);
    if (plan.new_dependencies.length) why.push(`il ajoute ${plan.new_dependencies.map((d) => d.name).join(", ")} (bibliothèque téléchargée)`);
    if (plan.questions.length && autonomy !== "workshop") why.push("le développeur pose des questions");
    return why;
  }

  /**
   * Atelier (ADR-26) : pas de phase de plan séparée (elle relisait le code une deuxième fois pour
   * un plan validé de toute façon automatiquement). La consigne du directeur tient lieu de plan ;
   * le gardien refuse ce qui est dangereux et accorde le reste, journalisé ; vous relisez avant fusion.
   */
  async startDirect(project: string, id: string, autonomy: string): Promise<Task> {
    if (autonomy !== "workshop") throw new TaskError("Exécution directe réservée au mode atelier");
    let task = this.get(project, id);
    if (task.status !== "draft") throw new TaskError(`Impossible de lancer depuis le statut « ${task.status} »`);
    // Le projet est occupé dès maintenant, pendant la création de la copie du jeu (file d'attente, ADR-31).
    const key = `${project}/${id}`;
    this.#starting.add(key);
    try {
      task = await this.#ensureWorktree(task);
    } finally {
      this.#starting.delete(key);
    }
    const plan = this.#storePlan(task, {
      summary: `Consigne du directeur, réalisée directement (atelier) : ${task.title}`,
      summary_simple: task.goal.split("\n")[0]!.slice(0, 800),
      acceptance_criteria: ["La consigne est réalisée", "Les tests du projet passent"],
      steps: [{ description: "Réaliser la consigne du directeur", files: [] }],
      files_to_create: [],
      files_to_modify: [],
      files_to_delete: [],
      // Sans plan, les vérifications autorisées sont les scripts de test du projet (le testeur peut les lancer).
      commands: verificationScripts(task.worktree!),
      new_dependencies: [],
      risks: [],
      assumptions: [],
      questions: [],
    });
    const approval = this.#approvals.recordDelegated({
      project,
      subject: { kind: "plan", id: plan.id, hash: plan.hash },
      verdict: "approved",
      autonomy,
      run: "autopilot",
      note: "Atelier : consigne réalisée directement",
    });
    transaction(this.#db, () => {
      this.#approvals.consume(project, approval.id, { kind: "plan", id: plan.id, hash: plan.hash });
      this.#db.prepare("UPDATE plans SET status = 'approved' WHERE project = ? AND id = ?").run(project, plan.id);
    });
    this.#update(task, { status: "approved", plan: plan.id, direct: true, queued_at: null });
    return this.#execute(project, id);
  }

  /** « ▶ Lancer » un chantier en attente (préparé par le Concepteur), en atelier. */
  async startDirectByHuman(session: HumanSession, project: string, id: string): Promise<Task> {
    assertHumanSession(session);
    const level = this.#projects.get(project).autonomy;
    if (level !== "workshop") return this.startPlanning(project, id);
    return (await this.launch(project, id)).task;
  }

  // ── File d'attente (ADR-31) ──────────────────────────────────────────────

  /** Chantier qui occupe le projet (en cours, à relire…), s'il y en a un. */
  busy(project: string, except?: string): Task | null {
    return this.list(project).find((t) => t.id !== except && (ACTIVE.includes(t.status) || this.#starting.has(`${project}/${t.id}`))) ?? null;
  }

  /** La file, dans l'ordre. Un chantier d'intégration de visuel (« A-0012 … ») passe devant : sa place est déjà prête (ADR-60). */
  queued(project: string): Task[] {
    const art = (t: Task) => (/^A-\d{4,}/.test(t.title) ? 0 : 1);
    return this.list(project)
      .filter((t) => t.status === "draft" && t.queued_at)
      .sort((a, b) => art(a) - art(b) || a.queued_at!.localeCompare(b.queued_at!) || a.id.localeCompare(b.id));
  }

  /**
   * Atelier : un seul chantier à la fois par projet. Chacun part de la version du jeu qui contient
   * les précédents, donc deux chantiers ne se marchent jamais dessus (incident du 14/10, T-0013).
   * Si le projet est occupé, le chantier attend son tour et partira tout seul.
   */
  async launch(project: string, id: string): Promise<{ task: Task; after: Task | null }> {
    const task = this.get(project, id);
    if (task.status !== "draft") throw new TaskError(`Impossible de lancer depuis le statut « ${task.status} »`);
    const after = this.busy(project, id) ?? this.queued(project).find((t) => t.id !== id) ?? null;
    if (after) return { task: task.queued_at ? task : this.#update(task, { queued_at: this.#clock.now() }), after };
    return { task: await this.startDirect(project, id, "workshop"), after: null };
  }

  /** Retire un chantier de la file : il redevient un brouillon à lancer vous-même. */
  unqueue(project: string, id: string): Task {
    const task = this.get(project, id);
    return task.queued_at ? this.#update(task, { queued_at: null }) : task;
  }

  /** Projet libéré : le chantier suivant de la file démarre. */
  async #pump(project: string): Promise<void> {
    if (this.busy(project)) return;
    const next = this.queued(project)[0];
    if (!next) {
      await this.onQueueEmpty?.(project);
      return;
    }
    if (this.#projects.get(project).autonomy !== "workshop") {
      this.unqueue(project, next.id);
      return;
    }
    if (this.#paused.has(project)) return;
    const wait = this.#limitWait();
    if (wait) {
      // Incident du 15/10 : T-0052 a tourné 40 min avant de buter sur la limite de session, puis deux chantiers ont échoué d'emblée.
      this.#log(project, "queue.paused", next.id, { until: wait.until, window: wait.window });
      this.#paused.set(
        project,
        setTimeout(() => {
          this.#paused.delete(project);
          this.#track(this.#pump(project));
        }, wait.ms).unref(),
      );
      return;
    }
    try {
      await this.startDirect(project, next.id, "workshop");
    } catch (err) {
      this.#log(project, "queue.failed", next.id, { error: (err as Error).message.slice(0, 300) });
      this.#update(this.get(project, next.id), { status: "failed", queued_at: null });
    }
  }

  /** La jauge d'abonnement est presque pleine : rien de nouveau ne démarre (chantiers, file des visuels). */
  limitPaused(): boolean {
    return !!this.#limitWait();
  }

  /** La jauge qui arrête la file, et jusqu'à quand (moniteur, ADR-64). */
  limitInfo(): { until: string; window: string } | null {
    const w = this.#limitWait();
    return w ? { until: w.until, window: w.window } : null;
  }

  /** Une jauge d'abonnement presque pleine : délai jusqu'à sa remise à zéro (plus une minute), sinon null. */
  #limitWait(): { ms: number; until: string; window: string } | null {
    const limits = this.usage?.snapshot().limits;
    if (!limits) return null;
    const now = Date.parse(this.#clock.now());
    for (const window of ["five_hour", "seven_day"] as const) {
      const w = limits.windows[window];
      const reset = w ? Date.parse(w.resetsAt) : NaN;
      if (w && w.utilization >= LIMIT_PAUSE[window] && reset > now) return { ms: reset - now + 60_000, until: w.resetsAt, window };
    }
    return null;
  }

  async #execute(project: string, id: string): Promise<Task> {
    const task = this.get(project, id);
    if (task.status !== "approved" || !task.plan) throw new TaskError("Le plan doit être validé avant l'exécution");
    const plan = this.plan(project, task.plan);
    if (plan.status !== "approved") throw new TaskError("Le plan n'est pas approuvé");
    const running = this.#update(task, { status: "running" });
    const decisions = this.#decisions(task);
    const ctx = this.#context(task);

    this.#spawn(running, "execute", new PolicyEngine({ mode: "execute", root: task.worktree!, plan, readable: this.#readable(task) }), {
      systemPrompt: task.direct ? directExecutionSystemPrompt(ctx) : executionSystemPrompt(ctx),
      prompt: task.direct ? directExecutionPrompt(task, decisions) : executionPrompt(task, plan, decisions),
      jsonSchema: REPORT_SCHEMA,
      onResult: async (r) => {
        const parsed = ExecutionReportOutput.safeParse(r.structured);
        const report: ExecutionReportOutput = parsed.success
          ? parsed.data
          : { outcome: "partial", summary: r.text.slice(0, 2000), summary_simple: "Le développeur n'a pas rendu de rapport structuré.", deviations: [], open_issues: [], how_to_test: [] };
        await this.#vcs.commitAll(task.worktree!, `studio: ${task.id} — ${task.title} (plan ${plan.id})`);
        const repo = this.#projects.get(project).root;
        const { files, patch } = await this.#vcs.diff(repo, task.base_commit!, task.branch!);
        const violations = files.filter((f) => FORBIDDEN_CHANGE.test(f.path));
        if (violations.length) {
          throw new TaskError(`Modifications interdites détectées : ${violations.map((v) => v.path).join(", ")}`);
        }
        // Vérifications du hub d'abord (tests, lancement, capture) : le testeur en reçoit les résultats et l'image (ADR-33).
        const hubChecks = await Promise.resolve(this.beforeVerify?.(this.get(project, id)) ?? null).catch(() => null);
        // Vérification QA automatique, en lecture seule.
        this.#spawn(this.get(project, id), "verify", new PolicyEngine({ mode: "verify", root: task.worktree!, plan, readable: this.#readable(task) }), {
          systemPrompt: verificationSystemPrompt(ctx, this.playtest !== null && canPlay(task.worktree!)),
          prompt: verificationPrompt(task, plan, decisions, patch, report, hubChecks),
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
    return this.#merge(task, approval.id);
  }

  /**
   * Fusion déléguée (ADR-31) : en atelier ou en autonomie, quand le testeur a validé le chantier,
   * ou quand vous avez dit « fusionne » dans la discussion. Annulable avec un « git revert ».
   */
  async autoMerge(project: string, id: string, autonomy: string, note: string): Promise<{ task: Task; sha: string }> {
    if (!["workshop", "autonomous"].includes(autonomy)) throw new TaskError("Fusion automatique réservée à l'atelier et à l'autonomie");
    const task = this.get(project, id);
    if (task.status !== "review" || !task.branch) throw new TaskError("Seule une tâche en revue peut être fusionnée");
    const head = await this.#vcs.branchHead(this.#projects.get(project).root, task.branch);
    if (!head) throw new TaskError("Ce chantier n'a pas de modifications");
    const subject = { kind: "merge" as const, id: task.id, hash: sha256(head) };
    const approval = this.#approvals.recordDelegated({ project, subject, verdict: "approved", autonomy, run: "autopilot", note });
    this.#approvals.consume(project, approval.id, subject);
    return this.#merge(task, approval.id);
  }

  async #merge(task: Task, approval: string): Promise<{ task: Task; sha: string }> {
    const { project, id } = task;
    const repo = this.#projects.get(project).root;
    const dirty = await this.#vcs.trackedChanges(repo);
    if (dirty.length) {
      throw new TaskError(
        `Votre projet a des modifications non commitées (${dirty.slice(0, 3).join(", ")}${dirty.length > 3 ? "…" : ""}). Commitez-les ou mettez-les de côté avant de fusionner.`,
      );
    }
    if (!(await this.#vcs.currentBranch(repo))) throw new TaskError("Votre projet n'est sur aucune branche (HEAD détachée)");
    const res = await this.#vcs.merge(repo, task.branch!, `studio: fusion de ${task.id} — ${task.title} (${approval})`);
    if (!res.ok) throw new TaskError(`Conflit de fusion sur : ${res.conflicts.join(", ") || "?"}. Rien n'a été modifié dans votre projet.`);
    await this.#cleanup(task);
    this.#log(project, "task.merged", id, { approval, commit: res.sha });
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

  /**
   * Atelier (ADR-31) : nouvelle passe du développeur dans la même copie du jeu, avec les remarques
   * du testeur ou les vôtres (dites dans la discussion), puis nouvelle vérification.
   */
  async correct(project: string, id: string, feedback: string, by: "tester" | "you"): Promise<Task> {
    const task = this.get(project, id);
    if (task.status !== "review" || !task.direct || !task.plan) throw new TaskError("Seul un chantier d'atelier en revue peut être corrigé ainsi");
    this.#update(task, { status: "approved", feedback: [...task.feedback, feedback.trim()].filter(Boolean) });
    this.#log(project, "task.changes_requested", id, { feedback, direct: true, by });
    return this.#execute(project, id);
  }

  async abandon(session: HumanSession, project: string, id: string): Promise<Task> {
    assertHumanSession(session);
    return this.abandonDelegated(project, id);
  }

  /** Abandon demandé dans la discussion (« laisse tomber ») : votre jeu reste intact. */
  async abandonDelegated(project: string, id: string): Promise<Task> {
    const task = this.get(project, id);
    if (["merged", "abandoned"].includes(task.status)) throw new TaskError(`Tâche déjà ${task.status}`);
    if ([...this.#active.values()].some((r) => r.task === id && r.project === project)) throw new TaskError("Arrêtez d'abord l'exécution en cours");
    await this.#cleanup(task);
    this.#log(project, "task.abandoned", id, {});
    return this.#update(task, { status: "abandoned", worktree: null });
  }

  /** Au démarrage : les runs interrompus par un arrêt du hub sont marqués en échec. */
  /**
   * Au démarrage, après un arrêt du hub (ADR-61) : la file d'attente est gardée. Un chantier d'atelier coupé en plein
   * travail est annulé et repart de zéro sous un nouveau numéro, en tête de file ; les autres coupés sont en échec.
   */
  recoverInterrupted(): { project: string; id: string; again: string; thread: string | null }[] {
    const now = this.#clock.now();
    this.#db.prepare("UPDATE runs SET status = 'failed', finished_at = ?, error = 'interrompu par l''arrêt du hub' WHERE status = 'running'").run(now);
    this.#db.prepare("UPDATE escalations SET status = 'expired', decided_at = ? WHERE status = 'pending'").run(now);
    const restarted: { project: string; id: string; again: string; thread: string | null }[] = [];
    for (const row of this.#db.prepare("SELECT project, id FROM tasks WHERE status IN ('planning', 'running')").all() as { project: string; id: string }[]) {
      const t = this.get(row.project, row.id);
      const workshop = t.direct && t.origin && this.#projects.get(t.project).autonomy === "workshop";
      this.#update(t, { status: workshop ? "cancelled" : "failed" });
      if (!workshop) continue;
      const again = this.#create(t.project, { decisions: t.authorized_by, title: t.title, goal: t.goal, reworks: t.reworks }, { restarted: t.id }, t.origin);
      // Avant tout le reste de la file (seule une intégration de visuel passe devant).
      this.#update(again, { queued_at: "0000-00-00T00:00:00.000Z" });
      this.#log(t.project, "task.restarted", again.id, { interrupted: t.id });
      restarted.push({ project: t.project, id: t.id, again: again.id, thread: t.origin?.thread ?? null });
    }
    return restarted;
  }

  /** Au démarrage, une fois le hub prêt : chaque projet qui a une file reprend son chantier suivant. */
  resumeQueues(): void {
    const projects = this.#db.prepare("SELECT DISTINCT project FROM tasks WHERE status = 'draft'").all() as { project: string }[];
    for (const { project } of projects) if (this.queued(project).length) this.#track(this.#pump(project));
  }

  async idle(): Promise<void> {
    while (this.#background.size) await Promise.allSettled([...this.#background]);
  }

  // ── Pont agent (hook PreToolUse et gardien MCP) ──────────────────────────

  agentPreTool(runId: string, token: string, tool: string, input: Record<string, unknown>, cwd?: string): Decision {
    const run = this.#authRun(runId, token);
    if (cwd) run.cwd = cwd;
    const d = run.policy.evaluate(tool, input, run.cwd);
    if (d.decision !== "allow") this.#event(run, "info", `${d.decision === "deny" ? "Refusé" : "Demande d'autorisation"} : ${this.#describe(run, tool, input)} (${d.reason})`);
    if (d.decision === "deny") this.#log(run.project, "policy.denied", run.task, { run: run.id, tool, reason: d.reason, input: summarizeInput(input) });
    return d;
  }

  /** L'outil « jouer » du testeur (ADR-69) : seulement pendant sa vérification, dans la copie du chantier. */
  async agentPlay(runId: string, token: string, req: PlayRequest): Promise<PlayResult> {
    const run = this.#authRun(runId, token);
    if (run.kind !== "verify" || !this.playtest) throw new TaskError("Seul le testeur peut jouer au jeu");
    return this.playtest.handle({ id: run.id, project: run.project, task: run.task, cwd: run.root }, req);
  }

  /** Appelé par le gardien pour une action hors plan : attend votre décision (refus si délai dépassé). */
  async agentPermission(runId: string, token: string, tool: string, input: Record<string, unknown>): Promise<{ behavior: "allow" | "deny"; message?: string }> {
    const run = this.#authRun(runId, token);
    const d = run.policy.evaluate(tool, input, run.cwd);
    if (d.decision === "allow") return { behavior: "allow" };
    if (d.decision === "deny") return { behavior: "deny", message: `Refusé par le hub : ${d.reason}` };
    // Atelier (ADR-25) : hors plan mais sans danger (le gardien a déjà refusé ce qui l'est), dans une copie
    // du jeu que vous relirez avant fusion. On laisse travailler, et on le note.
    if (this.#projects.get(run.project).autonomy === "workshop") {
      const summary = this.#describe(run, tool, input);
      this.#log(run.project, "escalation.auto_allowed", run.task, { summary, reason: d.reason });
      // En exécution directe il n'y a pas de plan : rien d'« hors plan » à signaler à chaque action.
      if (!this.get(run.project, run.task).direct) this.#event(run, "info", `Hors plan, autorisé automatiquement (atelier) : ${summary}`);
      return { behavior: "allow" };
    }

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
    try {
      this.onEscalation?.(esc);
    } catch {
      /* un observateur ne doit jamais casser le chantier */
    }
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
      startedAt: this.#clock.now(),
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
        const runDir = join(this.#opts.dataDir, "runs", id);
        const play = kind === "verify" && this.playtest !== null && canPlay(task.worktree!);
        // Compétences du studio (ADR-29) : un plugin propre au run, seules ces skills sont permises.
        const plugin = this.skills?.pluginFor(kind === "verify" ? "qa" : "developer", task.project, runDir) ?? null;
        if (plugin) this.#event(run, "info", `Compétences disponibles : ${plugin.names.map((n) => n.split(":")[1]).join(", ")}`);
        const result = await this.#executor.run({
          kind,
          runId: id,
          cwd: task.worktree!,
          runDir,
          systemPrompt: plugin
            ? `${spec.systemPrompt}

Compétences du studio disponibles (outil Skill) : ${plugin.names.join(", ")}. Consulte celles qui concernent ta tâche avant de commencer, en particulier les leçons du projet si elles existent.`
            : spec.systemPrompt,
          prompt: spec.prompt,
          jsonSchema: spec.jsonSchema,
          tools: plugin ? [...TOOLS_BY_MODE[kind], "Skill"] : TOOLS_BY_MODE[kind],
          pluginDir: plugin?.dir,
          play,
          // Jouer prend des tours : un paquet d'actions, puis une photo, puis un autre paquet (ADR-69).
          maxTurns: this.#opts.maxTurns?.[kind] ?? { plan: 40, execute: 120, verify: play ? 60 : 30 }[kind],
          big: isBigTask(task),
          bridge,
          bridgeUrl: `${this.#opts.agentBaseUrl()}/${id}`,
          token,
          onEvent: (type, text) => this.#event(run, type, text),
          signal: run.abort.signal,
        });
        cost = result.costUsd;
        this.usage?.record({ project: task.project, agent: kind === "verify" ? "qa" : "developer", model: result.model ?? null, tokens: result.tokens ?? null, costUsd: cost, limits: result.limits });
        outcome = await spec.onResult(result);
        if (outcome.text) this.#event(run, "result", outcome.text);
      } catch (err) {
        status = run.abort.signal.aborted ? "cancelled" : "failed";
        error = (err as Error).message.slice(0, 500);
        this.#event(run, "error", error);
        if (status === "failed") spec.onFailure();
      } finally {
        for (const resolve of run.waiting.values()) resolve(false);
        // Partie laissée ouverte par le testeur : navigateur et serveur du jeu fermés.
        await this.playtest?.closeRun(id).catch(() => {});
        this.#db
          .prepare("UPDATE runs SET status = ?, finished_at = ?, cost_usd = ?, error = ?, result_json = ? WHERE project = ? AND id = ?")
          .run(status, this.#clock.now(), cost, error, outcome ? JSON.stringify(outcome) : null, task.project, id);
        this.#active.delete(id);
        this.#finished.set(id, run.events);
        this.#log(task.project, `run.${status}`, task.id, { run: id, kind, cost_usd: cost, error });
        try {
          const after = this.onRunFinished?.(this.get(task.project, task.id), kind);
          if (after instanceof Promise) this.#track(after);
        } catch {
          /* un observateur ne doit jamais casser le chantier */
        }
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

  #storePlan(task: Task, proposed: PlanOutput): Plan {
    const policy = new PolicyEngine({ mode: "plan", root: task.worktree! });
    // Une commande interdite ne bloque pas tout le plan : elle est retirée, et c'est dit clairement.
    const refused = policy.refusedCommands(proposed);
    const out: PlanOutput = refused.length
      ? {
          ...proposed,
          commands: proposed.commands.filter((c) => !refused.some((r) => r.cmd === c.cmd)),
          assumptions: [...proposed.assumptions, ...refused.map((r) => `Commande retirée par le gardien : « ${r.cmd} » (${r.why}). Le développeur ne la lancera pas.`)],
        }
      : proposed;
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

  /** Lisibles en plus de la copie : le jeu (modules partagés) et les captures du hub pour ce projet. */
  #readable(task: Task): string[] {
    return [this.#projects.get(task.project).root, join(this.#opts.dataDir, "shots", task.project)];
  }

  #decisions(task: Task): ItemFrontmatter[] {
    return task.authorized_by.map((id) => this.#vision.get(task.project, id));
  }

  #context(task: Task): ProjectContext {
    const read = (p: string) => (existsSync(p) ? readFileSync(p, "utf8") : null);
    return { brief: read(join(task.worktree!, "studio", "BRIEF.md")), claudeMd: read(join(task.worktree!, "CLAUDE.md")), state: this.gameState?.(task.project) ?? null, godot: isGodot(task.worktree!) };
  }

  #update(task: Task, patch: Partial<Task> & { status?: TaskStatus }): Task {
    const next = Task.parse({ ...task, ...patch, updated_at: this.#clock.now() });
    this.#db.prepare("UPDATE tasks SET status = ?, data_json = ?, updated_at = ? WHERE project = ? AND id = ?").run(next.status, JSON.stringify(next), next.updated_at, next.project, next.id);
    if (next.status !== task.status) {
      try {
        this.onStatus?.(next);
      } catch {
        /* un observateur ne doit jamais casser le chantier */
      }
      // Projet libéré : le chantier suivant de la file peut partir (après la fin de l'opération en cours).
      if (ACTIVE.includes(task.status) && !ACTIVE.includes(next.status)) this.#track(Promise.resolve().then(() => this.#pump(next.project)));
    }
    return next;
  }

  #track(p: Promise<unknown>): void {
    const safe = p.then(
      () => {},
      () => {},
    );
    this.#background.add(safe);
    void safe.finally(() => this.#background.delete(safe));
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

/** Jeu que la manette du testeur sait lancer : un jeu web (script « dev », comme « ▶ Essayer ») ou un jeu Godot avec le relais du studio (ADR-73). */
function canPlay(root: string): boolean {
  if (isGodot(root)) return hasBridge(root);
  try {
    return Boolean((JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> }).scripts?.dev);
  } catch {
    return false;
  }
}

/** Scripts de vérification du projet (package.json), dans l'ordre du plus rapide au plus complet. */
export function verificationScripts(root: string): { cmd: string; purpose: string }[] {
  // Jeu Godot (ADR-73) : import du projet, puis ses tests par le lanceur du studio.
  if (isGodot(root))
    return [
      { cmd: GODOT_IMPORT, purpose: "importer le projet Godot (erreurs de scènes ou de ressources)" },
      ...(hasStudioTests(root) ? [{ cmd: GODOT_TESTS, purpose: "tests du jeu (lanceur du studio)" }] : []),
    ];
  const pkg = join(root, "package.json");
  if (!existsSync(pkg)) return [];
  let scripts: Record<string, string> = {};
  try {
    scripts = (JSON.parse(readFileSync(pkg, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    return [];
  }
  const out: { cmd: string; purpose: string }[] = [];
  if (scripts.typecheck) out.push({ cmd: "npm run typecheck", purpose: "vérifier les types" });
  if (scripts.lint) out.push({ cmd: "npm run lint", purpose: "vérifier le style du code" });
  if (scripts.test) out.push({ cmd: "npm test", purpose: "tests du projet" });
  if (scripts.build) out.push({ cmd: "npm run build", purpose: "construire le jeu" });
  if (scripts.validate) out.push({ cmd: "npm run validate", purpose: "validation complète du projet" });
  return out.slice(0, 10);
}
