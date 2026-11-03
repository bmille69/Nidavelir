import { useRef } from "react";
import type { ProjectView as View } from "../App.tsx";
import { ArtDirection } from "../studio/ArtDirection.tsx";
import { AutonomyPicker } from "../studio/Autonomy.tsx";
import { useStudio } from "../studio/context.tsx";
import { Icon, type IconName } from "../studio/Icon.tsx";
import { KeyImage, useKeyImages } from "../studio/KeyImage.tsx";
import { useGlider } from "../studio/motion.tsx";
import { PlansView } from "../studio/Plans.tsx";
import { TryButton } from "../studio/Preview.tsx";
import { ActivityPill } from "../studio/projet/Activity.tsx";
import { Recap } from "../studio/projet/Recap.tsx";
import { DecisionsView } from "./DecisionsView.tsx";
import { ProjectView } from "./ProjectView.tsx";
import { TaskDetailView } from "./TasksView.tsx";
import { VisionView } from "./VisionView.tsx";

type Tab = "discussion" | "recap" | "vision" | "art";

/**
 * Quatre onglets (ADR-113) : Discussion · Récap · Le jeu · Art & son. Les anciennes adresses restent valides et
 * s'ouvrent sous l'onglet qui les contient : les chantiers et les plans de production sous Récap, toutes les décisions
 * sous Le jeu, la direction artistique sous Art & son.
 */
const TABS: { tab: Tab; label: string; icon: IconName; href: (slug: string) => string }[] = [
  { tab: "discussion", label: "Discussion", icon: "chat", href: (s) => `#/p/${s}` },
  { tab: "recap", label: "Récap", icon: "chart", href: (s) => `#/p/${s}/recap` },
  { tab: "vision", label: "Le jeu", icon: "book", href: (s) => `#/p/${s}/vision` },
  { tab: "art", label: "Art & son", icon: "palette", href: (s) => `#/p/${s}/art` },
];
const TAB_OF: Record<View, Tab> = { discussion: "discussion", recap: "recap", tasks: "recap", plans: "recap", vision: "vision", decisions: "vision", art: "art" };

/** Les pages d'un onglet qui en a plusieurs : une petite barre de liens sous les onglets. */
const SUBS: Partial<Record<Tab, { views: View[]; label: string; href: (slug: string) => string }[]>> = {
  recap: [
    { views: ["recap", "tasks"], label: "Chantiers", href: (s) => `#/p/${s}/recap` },
    { views: ["plans"], label: "Plans de production", href: (s) => `#/p/${s}/plans` },
  ],
  vision: [
    { views: ["vision"], label: "La bible du jeu", href: (s) => `#/p/${s}/vision` },
    { views: ["decisions"], label: "Toutes les décisions", href: (s) => `#/p/${s}/decisions` },
  ],
};

export function ProjectShell({ slug, view, threadId, taskId, fresh }: { slug: string; view: View; threadId?: string; taskId?: string; fresh?: boolean }) {
  const snap = useStudio();
  const project = snap?.projects.find((p) => p.slug === slug);
  const tab = TAB_OF[view];
  // Ce qui vous attend sur ce jeu : la boîte « À vous » de la Discussion (même compte que « À vous de jouer »).
  const waiting = project?.waiting ?? 0;
  const guardian = !!snap?.agents.find((a) => a.id === "guardian")?.activities.some((a) => a.project === slug && a.detail === "En attente de votre autorisation");
  const keyImages = useKeyImages(slug, view);
  // Le soulignement de l'onglet actif glisse d'un onglet à l'autre (ADR-94).
  const tabs = useRef<HTMLElement>(null);
  useGlider(tabs, "a.active", [tab, waiting > 0]);
  const subs = SUBS[tab];

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
              Vos jeux
            </a>
            <h1>{project?.name ?? slug}</h1>
          </div>
        </div>
        {/* Une seule pastille : l'équipe et la machine, dans un panneau qui s'ouvre au clic (ADR-113). */}
        <ActivityPill slug={slug} />
        <span className="head-space" />
        {/* À droite de l'en-tête (ADR-94) : les réglages du projet, toujours au même endroit. */}
        <div className="project-actions">
          <button className="cmdk-hint" onClick={() => window.dispatchEvent(new Event("studio:palette"))} title="Chercher un chantier, un fil, un visuel, ou aller à…">
            <Icon name="search" size={14} />
            <span className="cmdk-label">Chercher, aller à…</span>
            <kbd>Ctrl</kbd>
            <kbd>K</kbd>
          </button>
          {project && <AutonomyPicker slug={slug} level={project.autonomy} />}
          <span className="head-launch">
            <TryButton slug={slug} label="▶ Lancer le jeu" />
          </span>
          <a className="concevoir-btn" href={`#/p/${slug}/concevoir${view === "discussion" && threadId ? `/${threadId}` : ""}`} title="Une grosse fonctionnalité ? Le Concepteur pose les bonnes questions et prépare les chantiers.">
            <Icon name="sparkle" size={15} /> <span className="concevoir-label">Concevoir</span>
          </a>
        </div>
      </header>
      <nav className="project-tabs" ref={tabs}>
        <span className="glider" aria-hidden="true" />
        {TABS.map((t) => (
          <a key={t.tab} className={t.tab === tab ? "active" : ""} href={t.href(slug)} aria-current={t.tab === tab ? "page" : undefined}>
            <Icon name={t.icon} size={17} />
            <span className="tab-label">{t.label}</span>
            {t.tab === "discussion" && waiting > 0 && (
              <span className={`tab-count${guardian ? " pulse" : ""}`} title={`${waiting} décision(s) vous attendent dans « À vous »`}>
                {waiting}
              </span>
            )}
          </a>
        ))}
      </nav>
      {subs && (
        <nav className="project-subtabs" aria-label="Pages de l'onglet">
          {subs.map((s) => (
            <a key={s.label} className={s.views.includes(view) ? "on" : ""} href={s.href(slug)}>
              {s.label}
            </a>
          ))}
        </nav>
      )}
      {view === "discussion" && <ProjectView slug={slug} threadId={threadId} fresh={fresh} />}
      {view === "decisions" && <DecisionsView slug={slug} />}
      {view === "vision" && <VisionView slug={slug} />}
      {/* Le Récap des chantiers (ADR-113). L'ancienne liste (#/p/<jeu>/tasks) y mène, filtrée sur « En cours » ;
          la page détail d'un chantier garde son adresse. */}
      {view === "recap" && <Recap key="recap" slug={slug} />}
      {view === "tasks" && !taskId && <Recap key="tasks" slug={slug} initialFilter="running" />}
      {view === "tasks" && taskId && <TaskDetailView slug={slug} taskId={taskId} />}
      {view === "art" && <ArtDirection slug={slug} />}
      {view === "plans" && <PlansView slug={slug} />}
    </div>
  );
}
