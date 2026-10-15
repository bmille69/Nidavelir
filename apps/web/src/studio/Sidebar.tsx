import type { Route } from "../App.tsx";
import { useEffect, useId, useState, type ReactNode } from "react";
import { api, type Conception, type SessionInfo } from "../api.ts";
import { useStudio } from "./context.tsx";
import { Icon, type IconName } from "./Icon.tsx";
import { UsageMeter } from "./UsageMeter.tsx";

const ORCHESTRATOR: Record<string, string> = { "direct-claude": "Claude (direct)", hermes: "Hermes", none: "aucun" };

/**
 * Menu principal, dans l'ordre de l'usage : ce qui vous attend, vos jeux, créer ;
 * puis, plus bas, le studio en direct et les réglages.
 */
export function Sidebar({ route, session, onClose }: { route: Route; session: SessionInfo; onClose?: () => void }) {
  const snap = useStudio();
  const [conceptions, setConceptions] = useState<Conception[]>([]);
  useEffect(() => {
    api.conceptions().then((cs) => setConceptions(cs.filter((c) => c.status !== "done")), () => {});
    // L'activité du studio change à chaque tour du Concepteur : on suit son rythme.
  }, [snap?.at, route]);
  const active = route.page === "project" ? route.slug : null;
  const working = snap?.agents.filter((a) => a.id !== "you" && a.state !== "idle").length ?? 0;
  const forYou = snap?.agents.find((a) => a.id === "you")?.activities.length ?? 0;

  const item = (to: string, icon: IconName, label: string, on: boolean, extra?: ReactNode) => (
    <a href={to} className={on ? "active" : ""}>
      <Icon name={icon} className="nav-icon" />
      <span className="nav-label">{label}</span>
      {extra}
    </a>
  );

  return (
    <aside className="sidebar">
      <div className="brand-row">
        <a href="#/" className="brand">
          <Logo />
          <span>
            <strong>Game Studio Hub</strong>
            <small>Votre studio IA</small>
          </span>
        </a>
        {onClose && (
          <button className="icon-btn drawer-close" aria-label="Fermer le menu" onClick={onClose}>
            <Icon name="close" />
          </button>
        )}
      </div>

      <nav className="side-nav">
        {item("#/", "home", "Accueil", route.page === "dashboard", forYou > 0 ? <span className="count warn">{forYou}</span> : null)}
      </nav>

      <p className="side-title">
        Vos jeux
        <a href="#/concevoir" className="side-title-action" title="Nouveau projet" aria-label="Nouveau projet">
          <Icon name="plus" size={16} />
        </a>
      </p>
      <nav className="side-projects">
        {snap?.projects.map((p) => (
          <a key={p.slug} href={`#/p/${p.slug}`} className={active === p.slug ? "active" : ""}>
            <span className="proj-initial" data-engine={p.engine}>
              {p.name.slice(0, 1).toUpperCase()}
            </span>
            <span className="proj-name">{p.name}</span>
            {p.busy && <span className="live-dot" title="Au travail" />}
            {p.waiting > 0 && <span className="count warn">{p.waiting}</span>}
          </a>
        ))}
        {snap?.projects.length === 0 && <p className="muted small side-empty">Aucun projet pour l'instant.</p>}
      </nav>

      {conceptions.length > 0 && (
        <>
          <p className="side-title">Conceptions en cours</p>
          <nav className="side-projects">
            {conceptions.map((c) => (
              <a key={c.id} href={`#/c/${c.id}`} className={route.page === "conception" && route.id === c.id ? "active" : ""}>
                <span className="proj-initial concept">✦</span>
                <span className="proj-name">{c.title}</span>
                {c.status === "thinking" ? <span className="live-dot" title="Le Concepteur travaille" /> : c.data.questions.length ? <span className="count warn">?</span> : null}
              </a>
            ))}
          </nav>
        </>
      )}

      <p className="side-title">Créer</p>
      <nav className="side-nav">
        {item("#/concevoir", "sparkle", "Nouveau projet", route.page === "conceive" && !route.project)}
        {item("#/import", "download", "Importer un jeu", route.page === "import")}
      </nav>

      <div className="side-spacer" />

      <p className="side-title">Studio</p>
      <nav className="side-nav">
        {item(
          "#/direct",
          "live",
          "En direct",
          route.page === "live",
          working > 0 ? (
            <span className="live-chip">
              <span className="live-dot" /> {working}
            </span>
          ) : null,
        )}
        {item("#/qualite", "chart", "Qualité", route.page === "quality")}
        {item("#/competences", "puzzle", "Compétences", route.page === "skills")}
        {item("#/telephone", "phone", "Téléphone", route.page === "phone")}
      </nav>

      <UsageMeter />
      <div className="side-foot">
        <span>
          Directeur : <b>{ORCHESTRATOR[session.orchestrator] ?? session.orchestrator}</b>
        </span>
        <span className="path" title={session.gamesRoot}>
          {session.gamesRoot}
        </span>
      </div>
    </aside>
  );
}

export function Logo({ size = 36 }: { size?: number }) {
  // Identifiant unique : deux logos (menu, barre du téléphone) ne doivent pas partager leur dégradé.
  const id = `logo-g${useId().replace(/:/g, "")}`;
  return (
    <svg className="logo" viewBox="0 0 40 40" width={size} height={size} aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#c4b5fd" />
          <stop offset="0.55" stopColor="#7c8cff" />
          <stop offset="1" stopColor="#38bdf8" />
        </linearGradient>
      </defs>
      <path d="M20 2 L36 11 V29 L20 38 L4 29 V11 Z" fill={`url(#${id})`} />
      <path d="M13 17 h14 a4 4 0 0 1 4 4 v1 a5 5 0 0 1 -5 5 h-1 l-2 -2 h-6 l-2 2 h-1 a5 5 0 0 1 -5 -5 v-1 a4 4 0 0 1 4 -4 Z" fill="#0b0d18" />
      <circle cx="25" cy="21.5" r="1.4" fill="#c4b5fd" />
      <circle cx="28" cy="23.5" r="1.4" fill="#38bdf8" />
      <path d="M14 22.5 h4 M16 20.5 v4" stroke="#c4b5fd" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
