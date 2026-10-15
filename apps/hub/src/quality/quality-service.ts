import type { Task } from "@studio/contracts";
import { assertHumanSession, type HumanSession } from "../auth/human-session.ts";
import type { Clock } from "../clock.ts";
import type { Db } from "../db/database.ts";
import type { TaskService } from "../executor/task-service.ts";
import type { Journal } from "../journal/journal.ts";
import type { ProjectRegistry } from "../projects/project-registry.ts";
import type { VcsPort } from "../vcs/git.ts";
import type { CheckService } from "./checks.ts";

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
  /** Fusionné sans correction, et tenu ensuite. */
  first_try: boolean;
  /** Fusionné et tenu : ni repris par un autre chantier, ni annulé avec Git (ADR-32). */
  held: boolean;
  /** Chantiers qui ont dû reprendre celui-ci. */
  reworked_by: string[];
  /** Fusion annulée avec un « git revert ». */
  reverted: boolean;
  /** Dernières vérifications du hub avant fusion (ADR-32). */
  checks: { tests: "pass" | "fail" | "none"; launch: "pass" | "fail" | "none"; regression: boolean } | null;
  /** Le testeur avait validé, mais le hub a trouvé une régression. */
  tester_missed: boolean;
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
  /** Fusionnés et tenus / chantiers terminés (fusionnés + abandonnés). */
  success_rate: number | null;
  held: number;
  /** Fusionnés, puis repris par un autre chantier ou annulés. */
  reworked: number;
  tests_checked: number;
  tests_ok: number;
  launch_checked: number;
  launch_ok: number;
  /** Chantiers validés par le testeur dont on connaît la suite ; « right » : ça a tenu. */
  tester_judged: number;
  tester_right: number;
  tester_rate: number | null;
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
  /** Prévenu de chaque avis (la mémoire des leçons en apprend, ADR-29). */
  onRated: ((project: string, task: string, rating: Rating) => void) | null = null;

  readonly #vcs: VcsPort;
  readonly #checks: CheckService | null;

  constructor(deps: { db: Db; clock: Clock; journal: Journal; projects: ProjectRegistry; tasks: TaskService; vcs: VcsPort; checks: CheckService | null }) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#journal = deps.journal;
    this.#projects = deps.projects;
    this.#tasks = deps.tasks;
    this.#vcs = deps.vcs;
    this.#checks = deps.checks;
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
    this.onRated?.(project, task, r);
    return r;
  }

  rating(project: string, task: string): Rating | null {
    const row = this.#db.prepare("SELECT rating, note, at FROM task_ratings WHERE project = ? AND task = ?").get(project, task) as Rating | undefined;
    return row ?? null;
  }

  async report(project?: string): Promise<QualityReport> {
    const slugs = project ? [this.#projects.get(project).slug] : this.#projects.list().map((p) => p.slug);
    const chantiers: ChantierRow[] = [];
    for (const slug of slugs) {
      const tasks = this.#tasks.list(slug);
      // Chantiers repris par un autre (ADR-32), et fusions annulées avec Git.
      const reworkedBy = new Map<string, string[]>();
      for (const t of tasks) for (const r of t.reworks) reworkedBy.set(r, [...(reworkedBy.get(r) ?? []), t.id]);
      const reverted = await this.#vcs.revertedCommits(this.#projects.get(slug).root).catch(() => [] as string[]);
      // Un brouillon jamais lancé n'est pas un chantier : ni réussi ni raté.
      const launched = tasks.filter((t) => this.#tasks.runs(slug, t.id).length > 0);
      chantiers.push(...launched.map((t) => this.#row(t, reworkedBy.get(t.id) ?? [], reverted)));
    }
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

  #row(t: Task, reworkedBy: string[], revertedShas: string[]): ChantierRow {
    const events = this.#db.prepare("SELECT type, at, payload_json FROM events WHERE project = ? AND subject = ? ORDER BY seq").all(t.project, t.id) as {
      type: string;
      at: string;
      payload_json: string;
    }[];
    const corrections = events.filter((e) => e.type === "task.changes_requested").length;
    // Une correction lancée d'office après le testeur (ADR-31) n'est pas une intervention de votre part.
    const byTester = events.filter((e) => e.type === "task.changes_requested" && JSON.parse(e.payload_json).by === "tester").length;
    const humanPlans = events.filter((e) => e.type === "plan.approved" && !JSON.parse(e.payload_json).delegated).length;
    const escalations = this.#tasks.escalations(t.project, { task: t.id }).filter((e) => e.status === "allowed" || e.status === "denied").length;
    const runs = this.#tasks.runs(t.project, t.id);
    const minutes = runs.reduce((n, r) => n + (r.finished_at ? (Date.parse(r.finished_at) - Date.parse(r.started_at)) / 60_000 : 0), 0);
    const verdict = runs.findLast((r) => r.result?.verification)?.result?.verification?.verdict ?? null;
    const mergeCommit = (JSON.parse(events.findLast((e) => e.type === "task.merged")?.payload_json ?? "{}") as { commit?: string }).commit;
    const reverted = !!mergeCommit && revertedShas.some((s) => mergeCommit.startsWith(s) || s.startsWith(mergeCommit));
    const held = t.status === "merged" && !reworkedBy.length && !reverted;
    const check = this.#checks?.get(t.project, t.id) ?? null;
    return {
      project: t.project,
      id: t.id,
      title: t.title,
      status: t.status,
      created_at: t.created_at,
      merged_at: events.find((e) => e.type === "task.merged")?.at ?? null,
      first_try: held && corrections === 0,
      held,
      reworked_by: reworkedBy,
      reverted,
      checks: check ? { tests: check.tests.status, launch: check.launch.status, regression: check.regression } : null,
      // Le testeur a validé alors que le hub avait mesuré une régression.
      tester_missed: events.some((e) => e.type === "tester.missed"),
      corrections,
      interventions: corrections - byTester + humanPlans + escalations,
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
  const held = merged.filter((r) => r.held).length;
  const checked = (k: "tests" | "launch") => rows.filter((r) => r.checks && r.checks[k] !== "none");
  const judged = rows.filter((r) => r.tester_missed || (r.status === "merged" && (r.qa === "pass" || r.qa === "pass_with_notes")));
  const right = judged.filter((r) => !r.tester_missed && r.held).length;
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
    success_rate: ratio(held, finished.length),
    held,
    reworked: merged.length - held,
    tests_checked: checked("tests").length,
    tests_ok: checked("tests").filter((r) => r.checks!.tests === "pass").length,
    launch_checked: checked("launch").length,
    launch_ok: checked("launch").filter((r) => r.checks!.launch === "pass").length,
    tester_judged: judged.length,
    tester_right: right,
    tester_rate: ratio(right, judged.length),
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
