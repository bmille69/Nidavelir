import type { HubEvent } from "@studio/contracts";
import type { Hub } from "../hub.ts";
import type { UsageSnapshot } from "../usage/usage-service.ts";
import { MODEL_CHOICES, type ModelSetting } from "../usage/model-service.ts";

export type AgentId = "you" | "concepteur" | "director" | "art_director" | "archivist" | "developer" | "qa" | "guardian";
export type AgentState = "idle" | "working" | "waiting";
export type Activity = { project: string; text: string; detail?: string; href: string; since?: string };
export type AgentSnapshot = { id: AgentId; state: AgentState; activities: Activity[] };
export type StudioSnapshot = {
  at: string;
  usage: UsageSnapshot;
  /** Modèle de chaque agent et modèles proposés (ADR-37). */
  models: { roles: ModelSetting[]; choices: typeof MODEL_CHOICES };
  agents: AgentSnapshot[];
  projects: { slug: string; name: string; engine: string; autonomy: string; delegated: number; busy: boolean; waiting: number; decisions: number; proposals: number; tasks: number }[];
  events: HubEvent[];
};

/** Événements trop nombreux pour le fil du studio (une ligne par fiche notée). */
const NOISY = new Set(["item.captured", "item.triaged", "session.opened", "server.error", "worktree.created", "approval.delegated", "proposal.submitted"]);
const STUDIO_WIDE = new Set(["model.changed", "tool.installed", "dissection.extracted", "dissection.failed"]);
const RUN_TEXT = { plan: "Prépare un plan", execute: "Travaille", verify: "Vérifie le travail" } as const;

/**
 * Photographie de ce que fait chaque agent, tous projets confondus (vue « Studio »).
 * Lecture seule : ne déclenche rien, ne modifie rien.
 */
export function studioSnapshot(hub: Hub): StudioSnapshot {
  const acts: Record<AgentId, Activity[]> = { you: [], concepteur: [], director: [], art_director: [], archivist: [], developer: [], qa: [], guardian: [] };
  const waiting: Partial<Record<AgentId, boolean>> = {};
  const projects = hub.projects.list();
  const names = new Map(projects.map((p) => [p.slug, p.name]));
  const busy = new Set<string>();
  const counts = new Map<string, number>();
  const you = (project: string, text: string, href: string, n = 1) => {
    acts.you.push({ project, text, href });
    counts.set(project, (counts.get(project) ?? 0) + n);
  };

  for (const c of hub.conceptions.activity()) {
    acts.concepteur.push({ project: c.project ?? "", text: `Conçoit « ${c.title} »`, href: `#/c/${c.id}`, since: c.since });
    if (c.project) busy.add(c.project);
  }
  for (const c of hub.conceptions.list().filter((x) => x.status === "open" && x.data.questions.length)) {
    acts.you.push({ project: c.project ?? "", text: `Le Concepteur attend vos réponses : ${c.title}`, href: `#/c/${c.id}` });
  }
  const conv = hub.conversations.activity();
  for (const r of conv.replying) {
    acts.director.push({ project: r.project, text: `Vous répond dans « ${r.title} »`, href: `#/p/${r.project}/t/${r.thread}`, since: r.since });
    busy.add(r.project);
  }
  const express = hub.express.running();
  if (express) acts.developer.push({ project: "", text: `Jeu express : ${express.title}`, href: `#/express/${express.id}`, since: express.started_at });
  for (const a of hub.art.activity()) {
    acts.art_director.push({ project: a.project, text: a.kind === "reply" ? "Vous répond (références, bible…)" : a.kind === "generate" ? `Fabrique ${a.asset} (générateur local)` : `Juge le rendu de ${a.asset}`, href: `#/p/${a.project}/art` });
    busy.add(a.project);
  }
  for (const e of conv.extracting) {
    acts.archivist.push({ project: e.project, text: "Note les idées de votre dernier message", href: `#/p/${e.project}`, since: e.since });
    busy.add(e.project);
  }

  for (const h of hub.autopilot?.handing() ?? []) {
    acts.director.push({ project: h.project, text: `Confie au développeur : ${h.title}`, href: `#/p/${h.project}/tasks`, since: h.since });
    busy.add(h.project);
  }
  for (const d of hub.autopilot?.activity() ?? []) {
    acts.director.push({ project: d.project, text: `Décide seul ${d.count} proposition(s) sans débat`, href: `#/p/${d.project}/decisions`, since: d.since });
    busy.add(d.project);
  }

  const runs = hub.tasks.activeRuns();
  for (const p of projects) {
    for (const job of hub.bootstrap.list(p.slug).filter((j) => j.status === "running")) {
      const docs = job.documents.filter((d) => d.status !== "skipped");
      const current = docs.find((d) => d.status === "running");
      acts.archivist.push({
        project: p.slug,
        text: current ? `Lit ${current.path}` : "Lit vos documents",
        detail: `${docs.filter((d) => d.status === "done" || d.status === "failed").length}/${docs.length} documents · ${job.created} fiche(s) notée(s)`,
        href: `#/p/${p.slug}`,
        since: job.started_at,
      });
      busy.add(p.slug);
    }
    for (const job of hub.synthesis.list(p.slug).filter((j) => j.status === "running")) {
      acts.director.push({
        project: p.slug,
        text: `Regroupe ${job.candidates} fiche(s) en propositions`,
        detail: job.chunks.total > 1 ? `paquet ${job.chunks.done + 1}/${job.chunks.total}` : undefined,
        href: `#/p/${p.slug}/decisions`,
        since: job.started_at,
      });
      busy.add(p.slug);
    }

    const tasks = hub.tasks.list(p.slug);
    const title = (id: string) => tasks.find((t) => t.id === id)?.title ?? id;
    for (const r of runs.filter((r) => r.project === p.slug)) {
      acts[r.kind === "verify" ? "qa" : "developer"].push({
        project: p.slug,
        text: `${RUN_TEXT[r.kind]} : ${title(r.task)}`,
        detail: r.last?.text.slice(0, 160),
        href: `#/p/${p.slug}/tasks/${r.task}`,
        since: r.started_at,
      });
      acts.guardian.push({ project: p.slug, text: `Surveille ${r.kind === "verify" ? "le QA" : "le développeur"} (${r.task})`, href: `#/p/${p.slug}/tasks/${r.task}`, since: r.started_at });
      busy.add(p.slug);
    }
    for (const e of hub.tasks.escalations(p.slug, { status: "pending" })) {
      waiting.developer = waiting.guardian = true;
      acts.guardian.unshift({ project: p.slug, text: `Bloque une action hors plan : ${e.summary}`, detail: "En attente de votre autorisation", href: `#/p/${p.slug}/tasks/${e.task}` });
      you(p.slug, `Autoriser ou refuser : ${e.summary}`, `#/p/${p.slug}/tasks/${e.task}`);
    }
    for (const t of tasks) {
      if (t.status === "plan_review") you(p.slug, `Valider le plan : ${t.title}`, `#/p/${p.slug}/tasks/${t.id}`);
      if (t.status === "review") you(p.slug, `Relire le résultat : ${t.title}`, `#/p/${p.slug}/tasks/${t.id}`);
    }
    const proposals = hub.vision.list(p.slug, { type: "proposal", status: "submitted" }).length;
    if (proposals) you(p.slug, `${proposals} proposition(s) à arbitrer`, `#/p/${p.slug}/decisions`, proposals);
  }

  const state = (id: AgentId): AgentState => (id === "you" ? (acts.you.length ? "waiting" : "idle") : waiting[id] ? "waiting" : acts[id].length ? "working" : "idle");
  return {
    at: hub.clock.now(),
    usage: hub.usage.snapshot(),
    models: { roles: hub.models.list(), choices: MODEL_CHOICES },
    agents: (Object.keys(acts) as AgentId[]).map((id) => ({ id, state: state(id), activities: acts[id] })),
    projects: projects.map((p) => ({
      slug: p.slug,
      name: p.name,
      engine: p.engine,
      autonomy: p.autonomy,
      delegated: hub.vision.list(p.slug, { type: "decision", status: "validated" }).filter((d) => d.validated_by?.kind === "delegated").length,
      busy: busy.has(p.slug),
      waiting: counts.get(p.slug) ?? 0,
      decisions: hub.vision.list(p.slug, { type: "decision", status: "validated" }).length,
      proposals: hub.vision.list(p.slug, { type: "proposal", status: "submitted" }).length,
      tasks: hub.tasks.list(p.slug).length,
    })),
    events: hub.journal
      .list({ limit: 500, latest: true })
      // Réglages du studio (modèles, ADR-37) : sans projet, mais utiles dans le fil.
      .filter((e) => (e.project ? names.has(e.project) : STUDIO_WIDE.has(e.type)) && !NOISY.has(e.type))
      .slice(-30)
      .reverse(),
  };
}
