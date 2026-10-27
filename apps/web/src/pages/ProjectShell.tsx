import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { AgentAvatar } from "../studio/AgentAvatar.tsx";
import { ArtDirection } from "../studio/ArtDirection.tsx";
import { AGENTS } from "../studio/agents.ts";
import { AutonomyPicker } from "../studio/Autonomy.tsx";
import { useStudio } from "../studio/context.tsx";
import { Icon, type IconName } from "../studio/Icon.tsx";
import { KeyImage, useKeyImages } from "../studio/KeyImage.tsx";
import { MonitorBar, MonitorPill } from "../studio/Monitor.tsx";
import { DecisionsView } from "./DecisionsView.tsx";
import { ProjectView } from "./ProjectView.tsx";
import { TasksView } from "./TasksView.tsx";
import { VisionView } from "./VisionView.tsx";

type View = "discussion" | "decisions" | "vision" | "tasks" | "art";

/** Trois onglets ; « Décisions » n'existe qu'en mode « Je valide tout » (ADR-23). */
const TABS: { view: View; label: string; icon: IconName; supervisedOnly?: boolean }[] = [
  { view: "discussion", label: "Discussion", icon: "chat" },
  { view: "decisions", label: "Décisions", icon: "scale", supervisedOnly: true },
  { view: "vision", label: "Le jeu", icon: "book" },
  { view: "tasks", label: "Chantiers", icon: "hammer" },
  { view: "art", label: "Direction artistique", icon: "palette" },
];

export function ProjectShell({ slug, view, threadId, taskId, fresh }: { slug: string; view: View; threadId?: string; taskId?: string; fresh?: boolean }) {
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
  const keyImages = useKeyImages(slug, view);

  return (
    <div className="shell">
      <header className={`project-head ${keyImages.length ? "has-key" : ""}`}>
        {/* L'image clé du jeu, en fond fondu et en vignette (ADR-86). */}
        <KeyImage urls={keyImages} className="project-backdrop" />
        <div className="project-title">
          <KeyImage
            urls={keyImages}
            className="proj-emblem"
            fallback={
              <span className="proj-initial lg" data-engine={project?.engine ?? "unknown"} aria-hidden="true">
                {(project?.name ?? slug).slice(0, 1).toUpperCase()}
              </span>
            }
          />
          <div className="project-name">
            <a href="#/" className="crumb">
              Studio
            </a>
            <h1>{project?.name ?? slug}</h1>
          </div>
          <div className="project-actions">
            <MonitorPill slug={slug} />
            {project && <AutonomyPicker slug={slug} level={project.autonomy} />}
            <a className="concevoir-btn" href={`#/p/${slug}/concevoir${view === "discussion" && threadId ? `/${threadId}` : ""}`} title="Une grosse fonctionnalité ? Le Concepteur pose les bonnes questions et prépare les chantiers.">
              <Icon name="sparkle" size={15} /> Concevoir
            </a>
          </div>
        </div>
        <div className="team-strip" aria-label="Agents au travail sur ce projet">
          {team.length === 0 ? (
            <span className="muted small">Équipe au repos</span>
          ) : (
            team.map((a) => (
              <a key={a.id} href={a.acts[0]?.href ?? "#/"} className={`team-mini state-${a.state}`} title={`${AGENTS[a.id].name} : ${a.acts[0]?.text ?? ""}`}>
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
      <div className="project-monitor">
        <MonitorBar slug={slug} />
      </div>
      <nav className="project-tabs">
        {TABS.filter((t) => !t.supervisedOnly || project?.autonomy === "supervised" || view === t.view).map((t) => (
          <a key={t.view} className={t.view === view ? "active" : ""} href={t.view === "discussion" ? `#/p/${slug}` : `#/p/${slug}/${t.view}`}>
            <Icon name={t.icon} size={17} />
            {t.label}
            {t.view === "discussion" && project && project.autonomy !== "supervised" && project.proposals > 0 && (
              <span className="badge warn">{project.proposals} question(s)</span>
            )}
            {t.view === "tasks" && pending > 0 && <span className="badge warn pulse"> {pending} demande(s)</span>}
          </a>
        ))}
      </nav>
      {view === "discussion" && <ProjectView slug={slug} threadId={threadId} fresh={fresh} />}
      {view === "decisions" && <DecisionsView slug={slug} />}
      {view === "vision" && <VisionView slug={slug} />}
      {view === "tasks" && <TasksView slug={slug} taskId={taskId} />}
      {view === "art" && <ArtDirection slug={slug} />}
    </div>
  );
}
