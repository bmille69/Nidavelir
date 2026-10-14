import type { Task } from "@studio/contracts";
import { assertHumanSession, type HumanSession } from "../auth/human-session.ts";
import type { Clock } from "../clock.ts";
import type { Db } from "../db/database.ts";
import type { TaskService } from "../executor/task-service.ts";
import type { Journal } from "../journal/journal.ts";
import type { ProjectRegistry } from "../projects/project-registry.ts";

export class QualityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QualityError";
  }
}

export type Rating = { rating: "up" | "down"; note: string | null; at: string };

/** Une ligne par chantier : ce qui permet de juger le workflow (ADR-27). */
export type ChantierRow = {
  project: string;
  id: string;
  title: string;
  status: string;
  created_at: string;
  merged_at: string | null;
  /** Fusionné sans correction demandée. */
  first_try: boolean;
  corrections: number;
  /** Fois où vous avez dû intervenir pendant le chantier (plan validé à la main, autorisations, corrections). */
  interventions: number;
  cost_usd: number;
  /** Temps de travail cumulé des agents (minutes). */
  agent_minutes: number;
  qa: "pass" | "pass_with_notes" | "fail" | null;
  rating: Rating | null;
};

export type Stats = {
  launched: number;
  merged: number;
  first_try: number;
  abandoned: number;
  in_progress: number;
  /** Fusionnés / chantiers terminés (fusionnés + abandonnés). */
  success_rate: number | null;
  first_try_rate: number | null;
  cost_usd: number;
  cost_per_merged: number | null;
  median_agent_minutes: number | null;
  interventions_per_chantier: number | null;
  qa_fail_rate: number | null;
  up: number;
  down: number;
};

export type QualityReport = { overall: Stats; weeks: (Stats & { week: string; label: string })[]; chantiers: ChantierRow[] };

const DONE = new Set(["merged", "abandoned"]);
const OPEN = new Set(["draft", "planning", "plan_review", "approved", "running", "review", "changes_requested", "failed", "cancelled", "rejected"]);

/** Tableau de bord « Qualité » : chiffres par chantier et par semaine, et votre avis. */
export class QualityService {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #journal: Journal;
  readonly #projects: ProjectRegistry;
  readonly #tasks: TaskService;

  constructor(deps: { db: Db; clock: Clock; journal: Journal; projects: ProjectRegistry; tasks: TaskService }) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#journal = deps.journal;
    this.#projects = deps.projects;
    this.#tasks = deps.tasks;
  }

  /** Votre avis sur un chantier terminé ou à relire (un seul par chantier, modifiable). */
  rate(session: HumanSession, project: string, task: string, rating: "up" | "down", note?: string): Rating {
    assertHumanSession(session);
    const t = this.#tasks.get(project, task);
    if (!["review", "merged", "abandoned", "failed"].includes(t.status)) throw new QualityError("Donnez votre avis quand le chantier est terminé");
    const r: Rating = { rating, note: note?.trim().slice(0, 500) || null, at: this.#clock.now() };
    this.#db
      .prepare(
        "INSERT INTO task_ratings (project, task, rating, note, at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (project, task) DO UPDATE SET rating = excluded.rating, note = excluded.note, at = excluded.at",
      )
      .run(project, task, r.rating, r.note, r.at);
    this.#journal.append({ project, actor: { kind: "human" }, type: "task.rated", subject: task, payload: { rating, note: r.note } });
    return r;
  }

  rating(project: string, task: string): Rating | null {
    const row = this.#db.prepare("SELECT rating, note, at FROM task_ratings WHERE project = ? AND task = ?").get(project, task) as Rating | undefined;
    return row ?? null;
  }

  report(project?: string): QualityReport {
    const slugs = project ? [this.#projects.get(project).slug] : this.#projects.list().map((p) => p.slug);
    const chantiers = slugs.flatMap((slug) => this.#tasks.list(slug).map((t) => this.#row(t)));
    chantiers.sort((a, b) => (b.created_at > a.created_at ? 1 : -1));
    const byWeek = new Map<string, ChantierRow[]>();
    for (const c of chantiers) {
      const w = weekStart(c.created_at);
      byWeek.set(w, [...(byWeek.get(w) ?? []), c]);
    }
    const weeks = [...byWeek.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([week, rows]) => ({ week, label: `sem. du ${new Date(week).toLocaleDateString("fr-FR", { day: "numeric", month: "short" })}`, ...stats(rows) }));
    return { overall: stats(chantiers), weeks, chantiers };
  }

  #row(t: Task): ChantierRow {
    const events = this.#db.prepare("SELECT type, at, payload_json FROM events WHERE project = ? AND subject = ? ORDER BY seq").all(t.project, t.id) as {
      type: string;
      at: string;
      payload_json: string;
    }[];
    const corrections = events.filter((e) => e.type === "task.changes_requested").length;
    const humanPlans = events.filter((e) => e.type === "plan.approved" && !JSON.parse(e.payload_json).delegated).length;
    const escalations = this.#tasks.escalations(t.project, { task: t.id }).filter((e) => e.status === "allowed" || e.status === "denied").length;
    const runs = this.#tasks.runs(t.project, t.id);
    const minutes = runs.reduce((n, r) => n + (r.finished_at ? (Date.parse(r.finished_at) - Date.parse(r.started_at)) / 60_000 : 0), 0);
    const verdict = runs.findLast((r) => r.result?.verification)?.result?.verification?.verdict ?? null;
    return {
      project: t.project,
      id: t.id,
      title: t.title,
      status: t.status,
      created_at: t.created_at,
      merged_at: events.find((e) => e.type === "task.merged")?.at ?? null,
      first_try: t.status === "merged" && corrections === 0,
      corrections,
      interventions: corrections + humanPlans + escalations,
      cost_usd: runs.reduce((n, r) => n + (r.cost_usd ?? 0), 0),
      agent_minutes: Math.round(minutes * 10) / 10,
      qa: verdict,
      rating: this.rating(t.project, t.id),
    };
  }
}

function stats(rows: ChantierRow[]): Stats {
  const merged = rows.filter((r) => r.status === "merged");
  const finished = rows.filter((r) => DONE.has(r.status));
  const firstTry = merged.filter((r) => r.first_try).length;
  const withQa = rows.filter((r) => r.qa);
  const cost = rows.reduce((n, r) => n + r.cost_usd, 0);
  const minutes = rows.filter((r) => r.agent_minutes > 0).map((r) => r.agent_minutes).sort((a, b) => a - b);
  const ratio = (a: number, b: number) => (b ? a / b : null);
  return {
    launched: rows.length,
    merged: merged.length,
    first_try: firstTry,
    abandoned: rows.filter((r) => r.status === "abandoned").length,
    in_progress: rows.filter((r) => OPEN.has(r.status)).length,
    success_rate: ratio(merged.length, finished.length),
    first_try_rate: ratio(firstTry, finished.length),
    cost_usd: cost,
    cost_per_merged: ratio(cost, merged.length),
    median_agent_minutes: minutes.length ? minutes[Math.floor((minutes.length - 1) / 2)]! : null,
    interventions_per_chantier: ratio(
      rows.reduce((n, r) => n + r.interventions, 0),
      rows.length,
    ),
    qa_fail_rate: ratio(withQa.filter((r) => r.qa === "fail").length, withQa.length),
    up: rows.filter((r) => r.rating?.rating === "up").length,
    down: rows.filter((r) => r.rating?.rating === "down").length,
  };
}

/** Lundi (ISO) de la semaine d'une date, au format AAAA-MM-JJ. */
function weekStart(iso: string): string {
  const d = new Date(iso);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
