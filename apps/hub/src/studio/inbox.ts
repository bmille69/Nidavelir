import type { ItemFrontmatter, Task } from "@studio/contracts";
import type { Asset } from "../art/manifest.ts";
import type { ConceptTurn } from "../conception/prompts.ts";
import type { Hub } from "../hub.ts";
import { effectiveVerdict } from "../quality/verdict.ts";
import type { Sound } from "../sound/sound-service.ts";

/**
 * La boîte « À vous » d'un projet (ADR-113) : tout ce qui attend votre décision, typé et trié par urgence, avec ce qu'il
 * faut pour trancher sur place. La même liste nourrit « À vous de jouer » (studioSnapshot) : les deux ne divergent pas.
 * Lecture seule : les décisions passent par les routes humaines habituelles.
 */

/** Plus le chiffre est petit, plus c'est urgent. Le Gardien d'abord : sans réponse, il refuse seul. */
const URGENCY = { escalation: 0, review: 1, task_plan: 1, proposal: 2, production: 3, art: 4, sound: 4, conception: 5, failed: 6 } as const;
/** Un chantier en échec reste à relancer pendant une semaine ; au-delà, il est dans le Récap. */
const FAILED_WINDOW_MS = 7 * 86_400_000;

type Base = {
  /** Clé unique dans la boîte (E-0001, T-0003, A-0002…). */
  id: string;
  title: string;
  text: string;
  urgency: number;
  /** Depuis quand ça attend. */
  at: string | null;
  /** Échéance : passé ce moment, le hub décide seul (le Gardien refuse). */
  deadline: string | null;
  /** La page de détail. */
  url: string;
  /** Où la décision se voit et se prend (la discussion du projet, ou le fil concerné) : le lien de « À vous de jouer ». */
  href: string;
  /** La ligne de « À vous de jouer ». */
  line: string;
};

export type InboxItem = Base &
  (
    | { kind: "escalation"; data: { escalation: string; task: string; taskTitle: string; summary: string; reason: string; tool: string; content: string | null } }
    | { kind: "review"; data: { task: string; summary: string | null; verdict: "pass" | "pass_with_notes" | "fail" | null; tester: string | null; played: string | null; thread: string | null; updated_at: string } }
    | { kind: "task_plan"; data: { task: string; plan: string; hash: string; summary: string; problems: string[] } }
    | { kind: "proposal"; data: { proposal: ItemFrontmatter; hash: string; sources: ItemFrontmatter[]; supersedes: ItemFrontmatter[] } }
    | { kind: "art"; data: { what: "question" | "sketch" | "model" | "image" | "render"; asset: string | null; name: string | null; sketches: { file: string; label: string }[]; image: string | null; verdict: { ok: boolean; summary: string; points: string[] } | null } }
    | { kind: "production"; data: { plan: string; status: string; thread: string; objective: string | null; steps: number } }
    | { kind: "sound"; data: { plan: string; sound: string; name: string; usage: string; status: Sound["status"]; takes: string[]; configured: boolean } }
    | { kind: "conception"; data: { conception: string; questions: ConceptTurn["questions"] } }
    | { kind: "failed"; data: { task: string; error: string | null; updated_at: string } }
  );

export function projectInbox(hub: Hub, project: string): InboxItem[] {
  hub.projects.get(project);
  const base = `#/p/${project}`;
  const out: InboxItem[] = [];
  const tasks = hub.tasks.list(project);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const threadOf = (t: Task | undefined) => (t?.origin ? `${base}/t/${t.origin.thread}` : base);
  const lastRun = (task: string, kind: "execute" | "verify") => hub.tasks.runs(project, task).filter((r) => r.kind === kind).at(-1) ?? null;

  // (a) Le Gardien : une action hors plan bloquée, refusée seule à l'échéance.
  for (const e of hub.tasks.escalations(project, { status: "pending" })) {
    const t = byId.get(e.task);
    const content = typeof e.input.content === "string" ? e.input.content : typeof e.input.new_string === "string" ? e.input.new_string : null;
    out.push({
      kind: "escalation",
      id: e.id,
      title: e.summary,
      text: e.reason,
      urgency: URGENCY.escalation,
      at: e.created_at,
      deadline: new Date(Date.parse(e.created_at) + hub.tasks.escalationTimeoutMs).toISOString(),
      url: `${base}/tasks/${e.task}`,
      href: threadOf(t),
      line: `Autoriser ou refuser : ${e.summary}`,
      data: { escalation: e.id, task: e.task, taskTitle: t?.title ?? e.task, summary: e.summary, reason: e.reason, tool: e.tool, content: content?.slice(0, 4000) ?? null },
    });
  }

  for (const t of tasks) {
    // (b) Un plan de chantier à valider (« Je valide tout ») et un résultat à relire.
    if (t.status === "plan_review" && t.plan) {
      let plan: ReturnType<Hub["tasks"]["plan"]> | null = null;
      try {
        plan = hub.tasks.plan(project, t.plan);
      } catch {
        /* plan illisible : la carte renvoie au détail */
      }
      if (plan)
        out.push({
          kind: "task_plan",
          id: t.id,
          title: `${t.id} · ${t.title}`,
          text: plan.summary_simple,
          urgency: URGENCY.task_plan,
          at: t.updated_at,
          deadline: null,
          url: `${base}/tasks/${t.id}`,
          href: base,
          line: `Valider le plan : ${t.title}`,
          data: { task: t.id, plan: plan.id, hash: plan.hash, summary: plan.summary_simple, problems: plan.problems },
        });
    }
    if (t.status === "review") {
      const report = lastRun(t.id, "execute")?.result?.report ?? null;
      const v = lastRun(t.id, "verify")?.result?.verification ?? null;
      out.push({
        kind: "review",
        id: t.id,
        title: `${t.id} · ${t.title}`,
        text: report?.summary_simple || t.goal.split("\n")[0]!.slice(0, 300),
        urgency: URGENCY.review,
        at: t.updated_at,
        deadline: null,
        url: `${base}/tasks/${t.id}`,
        href: threadOf(t),
        line: t.origin ? `${t.id} « ${t.title} » attend votre mot (« fusionne », à corriger…)` : `Relire le résultat : ${t.title}`,
        data: {
          task: t.id,
          summary: report?.summary_simple || null,
          verdict: v ? effectiveVerdict(v) : null,
          tester: v?.summary_simple || null,
          played: v?.playtest?.played ? v.playtest.summary : null,
          thread: t.origin?.thread ?? null,
          updated_at: t.updated_at,
        },
      });
    }
  }

  // (c) Les propositions du directeur : des choix à options, la ★ conseillée.
  for (const prop of hub.vision.list(project, { type: "proposal", status: "submitted" })) {
    const d = prop.proposal;
    if (!d) continue;
    out.push({
      kind: "proposal",
      id: prop.id,
      title: prop.title,
      text: d.summary ?? prop.statement,
      urgency: URGENCY.proposal,
      at: prop.created_at,
      deadline: null,
      url: `${base}/decisions`,
      href: base,
      line: prop.title,
      data: {
        proposal: prop,
        hash: hub.vision.proposalHash(project, prop.id),
        sources: d.based_on.map((id) => hub.vision.get(project, id)),
        supersedes: d.supersedes.map((id) => hub.vision.get(project, id)),
      },
    });
  }

  // (e) Les plans de production : plan à valider, plan en pause, sons à écouter.
  const plans = hub.productions?.yours(project) ?? [];
  const sounds = plans.some((w) => w.sound) ? hub.sound.sounds(project) : [];
  for (const [k, w] of plans.entries()) {
    const s = w.sound ? sounds.find((x) => x.id === w.sound) : undefined;
    const common = { at: w.plan.updated_at, deadline: null, url: `${base}/plans`, href: w.plan.status === "proposed" ? `${base}/t/${w.plan.thread}` : base, line: w.text };
    if (s)
      out.push({
        kind: "sound",
        id: `${w.plan.id}-${s.id}`,
        title: `${s.id} · ${s.name}`,
        text: s.usage,
        urgency: URGENCY.sound,
        ...common,
        data: { plan: w.plan.id, sound: s.id, name: s.name, usage: s.usage, status: s.status, takes: s.takes.map((x) => x.file), configured: hub.sound.configured() },
      });
    else
      out.push({
        kind: "production",
        id: `${w.plan.id}-${k}`,
        title: w.plan.title,
        text: w.text.replace(/^Plan « [^»]+ » : /, ""),
        urgency: URGENCY.production,
        ...common,
        data: { plan: w.plan.id, status: w.plan.status, thread: w.plan.thread, objective: w.plan.plan?.objectif ?? null, steps: (w.plan.plan?.chantiers.length ?? 0) + (w.plan.plan?.visuels.length ?? 0) + (w.plan.plan?.sons.length ?? 0) },
      });
  }

  // (d) Le Directeur artistique : sa question, un croquis à choisir, une image ou une 3D à valider.
  for (const w of hub.art.yours(project)) {
    const a: Asset | null = w.asset;
    const verdict = w.kind === "model" ? (a?.model?.verdict ?? null) : (a?.verdict ?? null);
    const image = w.kind === "model" ? (a?.model?.renders[0] ?? null) : w.kind === "render" ? (a?.renders.at(-1) ?? null) : (a?.verdict?.file ?? a?.renders.at(-1) ?? null);
    out.push({
      kind: "art",
      id: a ? `${a.id}-${w.kind}` : "art-question",
      title: a ? `${a.id} · ${a.name}` : "Le Directeur artistique vous pose une question",
      text: w.text,
      urgency: URGENCY.art,
      at: a?.updated_at ?? null,
      deadline: null,
      url: w.href,
      href: w.kind === "question" ? w.href : base,
      line: w.text,
      data: {
        what: w.kind,
        asset: a?.id ?? null,
        name: a?.name ?? null,
        sketches: w.kind === "sketch" ? (a?.sketches ?? []).map((s) => ({ file: s.file, label: s.label })) : [],
        image: w.kind === "sketch" ? null : image,
        verdict: verdict ? { ok: verdict.ok, summary: verdict.summary, points: verdict.points } : null,
      },
    });
  }

  // (f) Le Concepteur attend vos réponses sur une conception de ce jeu.
  for (const c of hub.conceptions.list().filter((x) => x.project === project && x.status === "open" && x.data.questions.length)) {
    out.push({
      kind: "conception",
      id: c.id,
      title: c.title,
      text: `${c.data.questions.length} question(s) avant d'écrire les chantiers`,
      urgency: URGENCY.conception,
      at: c.updated_at,
      deadline: null,
      url: `#/c/${c.id}`,
      href: `#/c/${c.id}`,
      line: `Le Concepteur attend vos réponses : ${c.title}`,
      data: { conception: c.id, questions: c.data.questions },
    });
  }

  // (g) Les chantiers en échec de la semaine, à relancer (sauf ceux qu'un plan en pause signale déjà).
  const now = Date.parse(hub.clock.now());
  for (const t of tasks) {
    if (t.status !== "failed" || now - Date.parse(t.updated_at) > FAILED_WINDOW_MS) continue;
    if (plans.some((w) => w.text.includes(`${t.id} «`))) continue;
    const run = hub.tasks.runs(project, t.id).at(-1);
    out.push({
      kind: "failed",
      id: t.id,
      title: `${t.id} · ${t.title}`,
      text: run?.error ? `Arrêté sur une erreur : ${run.error.slice(0, 240)}` : "Le chantier s'est arrêté sans résultat utilisable.",
      urgency: URGENCY.failed,
      at: t.updated_at,
      deadline: null,
      url: `${base}/tasks/${t.id}`,
      href: base,
      line: `${t.id} « ${t.title} » a échoué : à relancer ou abandonner`,
      data: { task: t.id, error: run?.error?.slice(0, 600) ?? null, updated_at: t.updated_at },
    });
  }

  // Le plus urgent en haut ; à urgence égale, ce qui attend depuis le plus longtemps.
  return out.sort((x, y) => x.urgency - y.urgency || (x.deadline ?? "").localeCompare(y.deadline ?? "") || (x.at ?? "").localeCompare(y.at ?? ""));
}
