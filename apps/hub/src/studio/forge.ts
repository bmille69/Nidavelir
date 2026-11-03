import type { Task } from "@studio/contracts";
import { conflictBetween } from "../executor/foreman.ts";
import type { Hub } from "../hub.ts";

/** Ce qu'un établi montre : le chantier posé dessus et où il en est. */
export type ForgePhase = "starting" | "plan" | "plan_review" | "execute" | "checks" | "verify" | "review" | "changes";

export type ForgeBench = {
  task: { id: string; title: string; status: Task["status"] };
  phase: ForgePhase;
  /** Le passage d'agent en cours sur ce chantier (développeur ou testeur), s'il y en a un. */
  run: { id: string; kind: "plan" | "execute" | "verify"; started_at: string; last: { at: string; type: string; text: string } | null } | null;
  /** Fiche du chef de chantier (ADR-104) : ce que le chantier touche. */
  note: string | null;
  files: string[];
  since: string;
};

export type ForgeSnapshot = {
  at: string;
  project: { slug: string; name: string; autonomy: string };
  /** Établis de la forge : chantiers simultanés permis sur ce jeu (ADR-104). */
  parallel: number;
  /** Agents du studio au travail, tous jeux confondus, et le plafond. */
  pool: { busy: number; waiting: number; max: number };
  benches: ForgeBench[];
  /** Chantiers en file, dans l'ordre, avec la raison de leur attente. */
  queue: { id: string; title: string; scoped: boolean; waiting: string }[];
  /** Le chef de chantier prépare une fiche. */
  scouting: boolean;
  escalations: { id: string; task: string; summary: string }[];
  merged: { id: string; title: string; at: string }[];
  today: { merged: number; failed: number };
  /** Une pause de quota retient la file. */
  paused: { until: string; window: string } | null;
};

const PHASE_OF: Partial<Record<Task["status"], ForgePhase>> = { planning: "plan", plan_review: "plan_review", review: "review", changes_requested: "changes" };

/**
 * La Forge (ADR-106) : la photographie d'un jeu pour la vue « La Forge » (personnages en voxels au travail).
 * Lecture seule, comme le moniteur : rien n'est lancé ni modifié. L'état des agents vient de la vue Studio, déjà
 * interrogée par l'interface ; ici, seulement ce qui est propre aux chantiers du jeu.
 */
export function forgeSnapshot(hub: Hub, slug: string): ForgeSnapshot {
  const project = hub.projects.get(slug);
  const tasks = hub.tasks.list(slug);
  const runs = hub.tasks.activeRuns().filter((r) => r.project === slug);
  const occupied = hub.tasks.occupying(slug);
  const queued = hub.tasks.queued(slug);
  const parallel = hub.tasks.parallel;
  const paused = queued.length ? hub.tasks.limitInfo() : null;

  const benches: ForgeBench[] = occupied.map((t) => {
    const run = runs.find((r) => r.task === t.id) ?? null;
    const phase: ForgePhase = run ? (run.kind === "verify" ? "verify" : run.kind === "plan" ? "plan" : "execute") : (PHASE_OF[t.status] ?? (t.status === "approved" || t.status === "running" ? (t.branch ? "checks" : "starting") : "starting"));
    return {
      task: { id: t.id, title: t.title, status: t.status },
      phase,
      run: run ? { id: run.id, kind: run.kind, started_at: run.started_at, last: run.last ? { at: run.last.at, type: run.last.type, text: run.last.text.slice(0, 240) } : null } : null,
      note: t.scope?.note || null,
      files: t.scope?.files.slice(0, 12) ?? [],
      since: run?.started_at ?? t.updated_at,
    };
  });

  const before: Task[] = [];
  const queue = queued.map((c) => {
    let waiting: string;
    if (paused) waiting = "pause de quota : la file repart à la réouverture";
    else if (project.autonomy !== "workshop") waiting = "attend la fin du chantier en cours";
    else if (!c.scope) waiting = parallel > 1 ? "le chef de chantier prépare sa fiche" : "attend son tour";
    else {
      let reason: string | null = null;
      for (const o of [...occupied, ...before]) {
        reason = conflictBetween(c, o);
        if (reason) {
          reason = `attend ${o.id} : ${reason}`;
          break;
        }
      }
      waiting = reason ?? (occupied.length >= parallel ? `les ${parallel} établis sont pris` : "part au prochain passage");
    }
    before.push(c);
    return { id: c.id, title: c.title, scoped: !!c.scope, waiting };
  });

  const dayStart = new Date(hub.clock.now());
  dayStart.setHours(0, 0, 0, 0);
  const today = dayStart.toISOString();
  const merged = tasks.filter((t) => t.status === "merged").sort((a, b) => b.updated_at.localeCompare(a.updated_at));

  return {
    at: hub.clock.now(),
    project: { slug: project.slug, name: project.name, autonomy: project.autonomy },
    parallel,
    pool: hub.tasks.agentPool(),
    benches,
    queue,
    scouting: parallel > 1 && [...occupied, ...queued].some((t) => !t.scope),
    escalations: hub.tasks.escalations(slug, { status: "pending" }).map((e) => ({ id: e.id, task: e.task, summary: e.summary.slice(0, 200) })),
    merged: merged.slice(0, 6).map((t) => ({ id: t.id, title: t.title, at: t.updated_at })),
    today: { merged: merged.filter((t) => t.updated_at >= today).length, failed: tasks.filter((t) => t.status === "failed" && t.updated_at >= today).length },
    paused: paused ? { until: paused.until, window: paused.window } : null,
  };
}
