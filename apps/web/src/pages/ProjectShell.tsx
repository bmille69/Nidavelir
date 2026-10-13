import { useEffect, useState } from "react";
import { api } from "../api.ts";
import { DecisionsView } from "./DecisionsView.tsx";
import { ProjectView } from "./ProjectView.tsx";
import { TasksView } from "./TasksView.tsx";
import { VisionView } from "./VisionView.tsx";

type View = "discussion" | "decisions" | "vision" | "tasks";

const TABS: { view: View; label: string }[] = [
  { view: "discussion", label: "Discussion" },
  { view: "decisions", label: "Décisions" },
  { view: "vision", label: "Vision validée" },
  { view: "tasks", label: "Tâches" },
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

  return (
    <div className="shell">
      <nav className="project-tabs">
        {TABS.map((t) => (
          <a key={t.view} className={t.view === view ? "active" : ""} href={t.view === "discussion" ? `#/p/${slug}` : `#/p/${slug}/${t.view}`}>
            {t.label}
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
