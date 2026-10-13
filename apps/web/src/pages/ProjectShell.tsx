import { DecisionsView } from "./DecisionsView.tsx";
import { ProjectView } from "./ProjectView.tsx";
import { VisionView } from "./VisionView.tsx";

const TABS = [
  { view: "discussion", label: "Discussion" },
  { view: "decisions", label: "Décisions" },
  { view: "vision", label: "Vision validée" },
] as const;

export function ProjectShell({ slug, view, threadId }: { slug: string; view: "discussion" | "decisions" | "vision"; threadId?: string }) {
  return (
    <div className="shell">
      <nav className="project-tabs">
        {TABS.map((t) => (
          <a key={t.view} className={t.view === view ? "active" : ""} href={t.view === "discussion" ? `#/p/${slug}` : `#/p/${slug}/${t.view}`}>
            {t.label}
          </a>
        ))}
      </nav>
      {view === "discussion" && <ProjectView slug={slug} threadId={threadId} />}
      {view === "decisions" && <DecisionsView slug={slug} />}
      {view === "vision" && <VisionView slug={slug} />}
    </div>
  );
}
