import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { AgentAvatar } from "../studio/AgentAvatar.tsx";
import { AGENTS } from "../studio/agents.ts";
import { AutonomyPicker } from "../studio/Autonomy.tsx";
import { useStudio } from "../studio/context.tsx";
import { DecisionsView } from "./DecisionsView.tsx";
import { ProjectView } from "./ProjectView.tsx";
import { TasksView } from "./TasksView.tsx";
import { VisionView } from "./VisionView.tsx";

type View = "discussion" | "decisions" | "vision" | "tasks";

/** Trois onglets ; « Décisions » n'existe qu'en mode « Je valide tout » (ADR-23). */
const TABS: { view: View; label: string; supervisedOnly?: boolean }[] = [
  { view: "discussion", label: "Discussion" },
  { view: "decisions", label: "Décisions", supervisedOnly: true },
  { view: "vision", label: "Le jeu" },
  { view: "tasks", label: "Chantiers" },
];

export function ProjectShell({ slug, view, threadId, taskId }: { slug: string; view: View; threadId?: string; taskId?: string }) {
  // Les demandes d'autorisation doivent se voir depuis n'importe quel onglet.
  const [pending, setPending] = useState(0);
  useEffect(() => {
    let alive = true;
    const tick = () => api.pendingEscalations(slug).then((e) => alive && setPending(e.length), () => {});
    tick();
    const t = setInterval(tick, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [slug]);

  const snap = useStudio();
  const project = snap?.projects.find((p) => p.slug === slug);
  const team = (snap?.agents ?? [])
    .filter((a) => a.id !== "you")
    .map((a) => {
      const acts = a.activities.filter((x) => x.project === slug);
      return { ...a, acts, state: acts.length ? a.state : ("idle" as const) };
    })
    .filter((a) => a.state !== "idle");

  return (
    <div className="shell">
      <header className="project-head">
        <div className="project-title">
          <a href="#/" className="crumb">
            Studio
          </a>
          <span className="crumb-sep">/</span>
          <h1>{project?.name ?? slug}</h1>
          {project && <AutonomyPicker slug={slug} level={project.autonomy} />}
          <a className="concevoir-btn" href={`#/p/${slug}/concevoir`} title="Une grosse fonctionnalité ? Le Concepteur pose les bonnes questions et prépare les chantiers.">
            ✦ Concevoir
          </a>
        </div>
        <div className="team-strip" aria-label="Agents au travail sur ce projet">
          {team.length === 0 ? (
            <span className="muted small">Équipe au repos</span>
          ) : (
            team.map((a) => (
              <a key={a.id} href={a.acts[0]?.href ?? "#/"} className="team-mini" title={`${AGENTS[a.id].name} : ${a.acts[0]?.text ?? ""}`}>
                <AgentAvatar agent={a.id} state={a.state} size={38} />
                <span>
                  <b>{AGENTS[a.id].name}</b>
                  <small>{a.acts[0]?.text}</small>
                </span>
              </a>
            ))
          )}
        </div>
      </header>
      <nav className="project-tabs">
        {TABS.filter((t) => !t.supervisedOnly || project?.autonomy === "supervised" || view === t.view).map((t) => (
          <a key={t.view} className={t.view === view ? "active" : ""} href={t.view === "discussion" ? `#/p/${slug}` : `#/p/${slug}/${t.view}`}>
            {t.label}
            {t.view === "discussion" && project && project.autonomy !== "supervised" && project.proposals > 0 && (
              <span className="badge warn">{project.proposals} question(s)</span>
            )}
            {t.view === "tasks" && pending > 0 && <span className="badge warn pulse"> {pending} demande(s)</span>}
          </a>
        ))}
      </nav>
      {view === "discussion" && <ProjectView slug={slug} threadId={threadId} />}
      {view === "decisions" && <DecisionsView slug={slug} />}
      {view === "vision" && <VisionView slug={slug} />}
      {view === "tasks" && <TasksView slug={slug} taskId={taskId} />}
    </div>
  );
}
