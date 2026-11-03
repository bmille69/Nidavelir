import type { Task } from "@studio/contracts";
import { readManifest } from "../art/manifest.ts";
import type { Hub } from "../hub.ts";
import { weekOf } from "../journal/logbook.ts";
import { effectiveVerdict } from "../quality/verdict.ts";
import type { ChantierRow } from "../quality/quality-service.ts";

/**
 * Le Récap des chantiers (ADR-113) : ce que l'équipe a fait, semaine par semaine, en clair. Tiré des données déjà
 * tenues par le hub (chantiers, runs, rapport du développeur, avis du Testeur, lignes de « Qualité », journal des
 * visuels intégrés) : aucune table à part, aucun appel à un modèle. « Raconter la semaine » passe par le journal de bord
 * (ADR-89), qui garde le récit et le GIF de la semaine.
 */

export type RecapPeriod = "week" | "lastweek" | "30d";
export const RECAP_PERIODS: RecapPeriod[] = ["week", "lastweek", "30d"];

/** Les trois familles des filtres : fusionné, échec ou abandon, encore en cours (brouillon et file compris). */
export type RecapGroup = "merged" | "failed" | "running";
const FAILED = new Set(["failed", "cancelled", "abandoned", "rejected"]);
export const recapGroup = (status: string): RecapGroup => (status === "merged" ? "merged" : FAILED.has(status) ? "failed" : "running");

export type RecapCard = {
  id: string;
  title: string;
  status: Task["status"];
  group: RecapGroup;
  created_at: string;
  /** La date qui range le chantier dans une semaine : sa fusion, sinon sa dernière activité. */
  at: string;
  merged_at: string | null;
  /** « Ce qui change dans le jeu » : le résumé simple du développeur. */
  summary: string | null;
  /** Le résumé technique du développeur (replié dans le détail). */
  tech: string | null;
  how_to_test: string[];
  verdict: "pass" | "pass_with_notes" | "fail" | null;
  /** L'avis complet du Testeur, en clair. */
  tester: string | null;
  played: string | null;
  unverified: string[];
  cost_usd: number;
  minutes: number;
  corrections: number;
  /** Les chantiers que celui-ci corrige, et ceux qui l'ont corrigé ensuite. */
  reworks: string[];
  reworked_by: string[];
  first_try: boolean;
  /** La capture montrée : la photo « en jeu » du Testeur, sinon celle du lancement, sinon une photo de partie. */
  shot: "in_game" | "launch" | "play" | null;
  thread: { id: string; title: string } | null;
  error: string | null;
  queue_rank: number | null;
  queued: boolean;
  pending_escalations: number;
};

export type RecapStats = {
  /** Chantiers de la période (lancés au moins une fois, ou fusionnés). */
  total: number;
  merged: number;
  failed: number;
  running: number;
  cost_usd: number;
  minutes: number;
  /** Fusionnés sans correction et jamais repris ensuite. */
  first_try: number;
  first_try_pct: number | null;
  /** Visuels du Directeur artistique entrés dans le jeu pendant la période. */
  visuals: number;
};

export type RecapWeek = { week: string; from: string; to: string; merged: number; failed: number; cost_usd: number; minutes: number; tasks: RecapCard[] };

export type Recap = {
  period: RecapPeriod;
  from: string;
  to: string;
  stats: RecapStats;
  counts: Record<"all" | RecapGroup, number>;
  weeks: RecapWeek[];
  /** La semaine du journal de bord que « Raconter la semaine » raconte, et son récit s'il existe déjà. */
  story: { week: string; text: string | null; at: string | null; gif: boolean };
};

const DAY = 86_400_000;
const round2 = (n: number) => Math.round(n * 100) / 100;
/** Le lundi (heure locale) d'une semaine du journal de bord, « AAAA-MM-JJ », en date. */
const monday = (week: string) => {
  const [y, m, d] = week.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
};
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** Les bornes d'une période, en heure locale comme le journal de bord. */
export function periodBounds(period: RecapPeriod, nowIso: string): { from: string; to: string } {
  const now = new Date(nowIso);
  const thisMonday = monday(weekOf(nowIso));
  if (period === "week") return { from: thisMonday.toISOString(), to: addDays(thisMonday, 7).toISOString() };
  if (period === "lastweek") return { from: addDays(thisMonday, -7).toISOString(), to: thisMonday.toISOString() };
  return { from: new Date(now.getTime() - 30 * DAY).toISOString(), to: new Date(now.getTime() + 1).toISOString() };
}

export function computeStats(cards: RecapCard[], visuals: number): RecapStats {
  const merged = cards.filter((c) => c.group === "merged");
  const first = merged.filter((c) => c.first_try).length;
  return {
    total: cards.length,
    merged: merged.length,
    failed: cards.filter((c) => c.group === "failed").length,
    running: cards.filter((c) => c.group === "running").length,
    cost_usd: round2(cards.reduce((n, c) => n + c.cost_usd, 0)),
    minutes: Math.round(cards.reduce((n, c) => n + c.minutes, 0) * 10) / 10,
    first_try: first,
    first_try_pct: merged.length ? Math.round((first / merged.length) * 100) : null,
    visuals,
  };
}

/** `period` absent : cette semaine si l'équipe y a déjà travaillé, sinon la semaine dernière. */
export async function projectRecap(hub: Hub, project: string, asked?: RecapPeriod): Promise<Recap> {
  hub.projects.get(project);
  const now = hub.clock.now();
  const tasks = hub.tasks.list(project);
  const rows = new Map<string, ChantierRow>((await hub.quality.report(project)).chantiers.map((r) => [r.id, r]));
  const queue = hub.tasks.queued(project).map((t) => t.id);
  const pending = hub.tasks.escalations(project, { status: "pending" });
  const threads = new Map<string, string>();
  const threadTitle = (id: string) => {
    if (!threads.has(id)) {
      try {
        threads.set(id, hub.conversations.getThread(project, id).title);
      } catch {
        threads.set(id, "");
      }
    }
    return threads.get(id)!;
  };

  const cards: RecapCard[] = tasks.map((t) => {
    const runs = hub.tasks.runs(project, t.id);
    const report = runs.filter((r) => r.kind === "execute" && r.result?.report).at(-1)?.result?.report ?? null;
    const v = runs.filter((r) => r.kind === "verify" && r.result?.verification).at(-1)?.result?.verification ?? null;
    const row = rows.get(t.id);
    const group = recapGroup(t.status);
    const thread = t.origin?.thread ?? null;
    const minutes = row?.agent_minutes ?? 0;
    return {
      id: t.id,
      title: t.title,
      status: t.status,
      group,
      created_at: t.created_at,
      at: row?.merged_at ?? t.updated_at,
      merged_at: row?.merged_at ?? null,
      summary: report?.summary_simple || null,
      tech: report?.summary || null,
      how_to_test: report?.how_to_test ?? [],
      verdict: v ? effectiveVerdict(v) : null,
      tester: v?.summary_simple || null,
      played: v?.playtest?.played ? v.playtest.summary : null,
      unverified: v?.playtest?.unverified ?? [],
      cost_usd: round2(row?.cost_usd ?? runs.reduce((n, r) => n + (r.cost_usd ?? 0), 0)),
      minutes,
      corrections: row?.corrections ?? 0,
      reworks: t.reworks,
      reworked_by: row?.reworked_by ?? [],
      first_try: row?.first_try ?? false,
      shot: hub.checks?.taskShot(project, t.id)?.kind ?? null,
      thread: thread ? { id: thread, title: threadTitle(thread) } : null,
      error: group === "failed" ? (runs.at(-1)?.error?.slice(0, 600) ?? null) : null,
      queue_rank: queue.indexOf(t.id) >= 0 ? queue.indexOf(t.id) + 1 : null,
      queued: !!t.queued_at,
      pending_escalations: pending.filter((e) => e.task === t.id).length,
    };
  });

  const inPeriod = (p: RecapPeriod) => {
    const b = periodBounds(p, now);
    // Un brouillon jamais lancé n'a rien coûté ni rien fait : il ne compte pas dans les chiffres (comme « Qualité »).
    return { ...b, cards: cards.filter((c) => c.at >= b.from && c.at < b.to && (rows.has(c.id) || c.group === "merged")) };
  };
  const period: RecapPeriod = asked ?? (inPeriod("week").cards.length ? "week" : "lastweek");
  const scope = inPeriod(period);

  // Les visuels intégrés : le journal dit quand, le manifeste (assets.json) confirme qu'ils le sont toujours.
  let integrated: Set<string> | null = null;
  try {
    integrated = new Set(readManifest(hub.projects.get(project).root).assets.filter((a) => a.status === "integre").map((a) => a.id));
  } catch {
    /* pas de manifeste : on s'en tient au journal */
  }
  const events = hub.db
    .prepare("SELECT DISTINCT subject FROM events WHERE project = ? AND type = 'art.asset_integrated' AND at >= ? AND at < ?")
    .all(project, scope.from, scope.to) as { subject: string }[];
  const visuals = events.filter((e) => !integrated || integrated.has(e.subject)).length;

  // Par semaine du journal de bord, la plus récente d'abord ; dans une semaine, le plus récent d'abord.
  const byWeek = new Map<string, RecapCard[]>();
  for (const c of [...cards].sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id))) {
    const w = weekOf(c.at);
    byWeek.set(w, [...(byWeek.get(w) ?? []), c]);
  }
  const weeks: RecapWeek[] = [...byWeek.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([week, list]) => {
      const s = computeStats(list, 0);
      return { week, from: monday(week).toISOString(), to: addDays(monday(week), 7).toISOString(), merged: s.merged, failed: s.failed, cost_usd: s.cost_usd, minutes: s.minutes, tasks: list };
    });

  // « Raconter la semaine » : la semaine du journal de bord qui correspond à la période.
  const storyWeek = period === "30d" ? (hub.logbook.weeks(project)[0] ?? weekOf(now)) : weekOf(scope.from);
  const told = hub.db.prepare("SELECT text, at FROM logbook_weeks WHERE project = ? AND week = ?").get(project, storyWeek) as { text: string; at: string } | undefined;

  return {
    period,
    from: scope.from,
    to: scope.to,
    stats: computeStats(scope.cards, visuals),
    counts: { all: cards.length, merged: cards.filter((c) => c.group === "merged").length, failed: cards.filter((c) => c.group === "failed").length, running: cards.filter((c) => c.group === "running").length },
    weeks,
    story: { week: storyWeek, text: told?.text ?? null, at: told?.at ?? null, gif: hub.logbook.week(project, storyWeek).gif },
  };
}
