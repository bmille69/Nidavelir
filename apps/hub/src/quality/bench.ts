import { assertHumanSession, type HumanSession } from "../auth/human-session.ts";
import type { Clock } from "../clock.ts";
import type { Db } from "../db/database.ts";
import type { TaskService } from "../executor/task-service.ts";
import type { SkillOverride } from "../skills/skill-service.ts";
import type { Journal } from "../journal/journal.ts";
import type { ProjectRegistry } from "../projects/project-registry.ts";
import type { CheckerPort, CheckOutcome } from "./checks.ts";

/**
 * Le banc d'essai des agents (ADR-87) : des chantiers déjà fusionnés, choisis par vous, servent de référence. À chaque
 * changement de modèle ou de consignes, le hub rejoue leur consigne depuis le commit d'où ils étaient partis, dans une
 * copie jetable, avec le développeur actuel ; puis les vérifications du hub (tests, lancement, parties rejouées). On
 * compare : réussite, coût, durée, ampleur. Rien n'est jamais fusionné.
 */

export class BenchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BenchError";
  }
}

export type BenchCase = { id: string; source: string; title: string; goal: string; base: string; original: { costUsd: number | null; seconds: number | null; files: number | null }; created_at: string };
export type BenchResult = {
  case: string;
  ok: boolean;
  outcome: string;
  summary: string;
  error: string | null;
  tests: CheckOutcome["status"] | null;
  launch: CheckOutcome["status"] | null;
  replays: CheckOutcome["status"] | null;
  costUsd: number | null;
  tokens: number | null;
  model: string | null;
  seconds: number;
  files: number;
};
export type BenchRun = { id: number; at: string; fingerprint: string; status: "running" | "done"; results: BenchResult[] };
export type BenchState = { cases: BenchCase[]; runs: BenchRun[]; fingerprint: string; executor: string; stale: boolean; running: boolean; candidates: { id: string; title: string }[] };

const MAX_CASES = 8;

export class BenchService {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #journal: Journal;
  readonly #projects: ProjectRegistry;
  readonly #tasks: TaskService;
  readonly #checker: CheckerPort | null;
  readonly #background = new Set<Promise<unknown>>();

  constructor(deps: { db: Db; clock: Clock; journal: Journal; projects: ProjectRegistry; tasks: TaskService; checker: CheckerPort | null }) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#journal = deps.journal;
    this.#projects = deps.projects;
    this.#tasks = deps.tasks;
    this.#checker = deps.checker;
  }

  cases(project: string): BenchCase[] {
    const rows = this.#db.prepare("SELECT * FROM bench_cases WHERE project = ? ORDER BY id").all(project) as {
      id: string;
      source_task: string;
      title: string;
      goal: string;
      base_commit: string;
      original_json: string;
      created_at: string;
    }[];
    return rows.map((r) => ({ id: r.id, source: r.source_task, title: r.title, goal: r.goal, base: r.base_commit, original: JSON.parse(r.original_json) as BenchCase["original"], created_at: r.created_at }));
  }

  runs(project: string, limit = 10): BenchRun[] {
    const rows = this.#db.prepare("SELECT * FROM bench_runs WHERE project = ? ORDER BY id DESC LIMIT ?").all(project, limit) as { id: number; at: string; fingerprint: string; status: BenchRun["status"]; results_json: string }[];
    return rows.map((r) => ({ id: r.id, at: r.at, fingerprint: r.fingerprint, status: r.status, results: JSON.parse(r.results_json) as BenchResult[] }));
  }

  state(project: string): BenchState {
    const { hash, executor } = this.#tasks.benchFingerprint(project);
    const runs = this.runs(project);
    const cases = this.cases(project);
    const taken = new Set(cases.map((c) => c.source));
    const lastDone = runs.find((r) => r.status === "done");
    return {
      cases,
      runs,
      fingerprint: hash,
      executor,
      // Le développeur a changé (modèle, consignes) depuis le dernier passage : le banc n'est plus à jour.
      stale: cases.length > 0 && (!lastDone || lastDone.fingerprint !== hash),
      running: runs[0]?.status === "running",
      candidates: this.#tasks
        .list(project)
        .filter((t) => t.status === "merged" && t.base_commit && !taken.has(t.id) && !/^A-\d{4,}/.test(t.title))
        .slice(-30)
        .reverse()
        .map((t) => ({ id: t.id, title: t.title })),
    };
  }

  /** « Ajouter au banc » : un chantier fusionné devient une référence (sa consigne, son point de départ, ses chiffres). */
  addCase(session: HumanSession, project: string, taskId: string): BenchCase {
    assertHumanSession(session);
    const task = this.#tasks.get(project, taskId);
    if (task.status !== "merged" || !task.base_commit) throw new BenchError("Seul un chantier fusionné peut servir de référence");
    if (this.cases(project).some((c) => c.source === taskId)) throw new BenchError(`${taskId} est déjà au banc`);
    if (this.cases(project).length >= MAX_CASES) throw new BenchError(`Le banc tient ${MAX_CASES} chantiers : chaque passage les refait tous, et cela coûte`);
    const exec = this.#tasks.runs(project, taskId).filter((r) => r.kind === "execute" && r.status === "done").at(-1);
    const seconds = exec?.finished_at ? Math.round((Date.parse(exec.finished_at) - Date.parse(exec.started_at)) / 1000) : null;
    const original = { costUsd: exec?.cost_usd ?? null, seconds, files: null };
    const id = `BC-${String(this.cases(project).length + 1).padStart(2, "0")}-${taskId}`;
    const now = this.#clock.now();
    this.#db
      .prepare("INSERT INTO bench_cases (project, id, source_task, title, goal, base_commit, original_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(project, id, taskId, task.title, task.goal, task.base_commit, JSON.stringify(original), now);
    this.#journal.append({ project, actor: { kind: "human" }, type: "bench.case_added", subject: id, payload: { task: taskId } });
    return this.cases(project).find((c) => c.id === id)!;
  }

  removeCase(session: HumanSession, project: string, id: string): void {
    assertHumanSession(session);
    this.#db.prepare("DELETE FROM bench_cases WHERE project = ? AND id = ?").run(project, id);
  }

  /** « Passer le banc » : chaque référence refaite l'une après l'autre, en arrière-plan. Coûte autant que ces chantiers. */
  start(session: HumanSession, project: string): BenchState {
    assertHumanSession(session);
    const cases = this.cases(project);
    if (!cases.length) throw new BenchError("Le banc est vide : ajoutez d'abord un ou plusieurs chantiers fusionnés de référence");
    if (this.state(project).running) return this.state(project);
    const fingerprint = this.#tasks.benchFingerprint(project).hash;
    const id = Number(this.#db.prepare("INSERT INTO bench_runs (project, at, fingerprint, status) VALUES (?, ?, ?, 'running')").run(project, this.#clock.now(), fingerprint).lastInsertRowid);
    const job = (async () => {
      const results: BenchResult[] = [];
      for (const c of cases) {
        results.push(await this.#one(project, c));
        this.#db.prepare("UPDATE bench_runs SET results_json = ? WHERE id = ?").run(JSON.stringify(results), id);
      }
      this.#db.prepare("UPDATE bench_runs SET status = 'done' WHERE id = ?").run(id);
      this.#journal.append({ project, actor: { kind: "human" }, type: "bench.ran", subject: String(id), payload: { fingerprint, ok: results.filter((r) => r.ok).length, total: results.length } });
    })().catch(() => this.#db.prepare("UPDATE bench_runs SET status = 'done' WHERE id = ?").run(id));
    this.#background.add(job);
    void job.finally(() => this.#background.delete(job));
    return this.state(project);
  }

  /**
   * Un passage isolé pour l'essai d'une compétence (ADR-102) : la consigne d'un chantier fusionné, refaite depuis son
   * point de départ avec une compétence forcée ou retirée. Rien n'est fusionné ni gardé au banc.
   */
  async trial(project: string, ref: { id: string; title: string; goal: string; base: string }, skills: SkillOverride): Promise<BenchResult> {
    return this.#one(project, { id: `essai-${ref.id}`, source: ref.id, title: ref.title, goal: ref.goal, base: ref.base, original: { costUsd: null, seconds: null, files: null }, created_at: this.#clock.now() }, skills);
  }

  async #one(project: string, c: BenchCase, skills?: SkillOverride): Promise<BenchResult> {
    const checker = this.#checker;
    try {
      const r = await this.#tasks.benchRun(project, { title: c.title, goal: c.goal, base: c.base, ...(skills ? { skills } : {}) }, async (cwd) => {
        if (!checker) return null;
        const tests = await checker.tests(cwd).catch((): CheckOutcome => ({ status: "none", detail: "" }));
        const launch = await checker.launch(`${project}/banc-${c.id}`, cwd).catch((): CheckOutcome => ({ status: "none", detail: "" }));
        const replays = checker.replays ? await checker.replays(cwd).catch((): CheckOutcome => ({ status: "none", detail: "" })) : null;
        return { tests, launch, replays };
      });
      const outcome = r.report?.outcome ?? (r.error ? "failed" : "sans rapport");
      const tests = r.checks?.tests.status ?? null;
      const launch = r.checks?.launch.status ?? null;
      const replays = r.checks?.replays?.status ?? null;
      const ok = !r.error && outcome !== "failed" && r.files.length > 0 && tests !== "fail" && launch !== "fail" && replays !== "fail";
      const why = [r.checks?.tests.status === "fail" ? `tests : ${r.checks.tests.detail.slice(-300)}` : "", r.checks?.launch.status === "fail" ? `lancement : ${r.checks.launch.detail.slice(0, 300)}` : ""].filter(Boolean).join(" ; ");
      return { case: c.id, ok, outcome, summary: (r.report?.summary_simple ?? "").slice(0, 400) + (why ? ` — ${why}` : r.files.length ? "" : " — aucun fichier modifié"), error: r.error, tests, launch, replays, costUsd: r.costUsd, tokens: r.tokens, model: r.model, seconds: r.seconds, files: r.files.length };
    } catch (err) {
      return { case: c.id, ok: false, outcome: "failed", summary: "", error: (err as Error).message.slice(0, 400), tests: null, launch: null, replays: null, costUsd: null, tokens: null, model: null, seconds: 0, files: 0 };
    }
  }

  async idle(): Promise<void> {
    while (this.#background.size) await Promise.allSettled([...this.#background]);
  }
}
