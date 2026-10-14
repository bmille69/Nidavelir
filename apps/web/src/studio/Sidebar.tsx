import type { Route } from "../App.tsx";
import { useEffect, useState } from "react";
import { api, type Conception, type SessionInfo } from "../api.ts";
import { useStudio } from "./context.tsx";
import { UsageMeter } from "./UsageMeter.tsx";

const ORCHESTRATOR: Record<string, string> = { "direct-claude": "Claude (direct)", hermes: "Hermes", none: "aucun" };

export function Sidebar({ route, session }: { route: Route; session: SessionInfo }) {
  const snap = useStudio();
  const [conceptions, setConceptions] = useState<Conception[]>([]);
  useEffect(() => {
    api.conceptions().then((cs) => setConceptions(cs.filter((c) => c.status !== "done")), () => {});
    // L'activité du studio change à chaque tour du Concepteur : on suit son rythme.
  }, [snap?.at, route]);
  const active = route.page === "project" ? route.slug : null;
  const working = snap?.agents.some((a) => a.id !== "you" && a.state !== "idle") ?? false;
  const forYou = snap?.agents.find((a) => a.id === "you")?.activities.length ?? 0;
  return (
    <aside className="sidebar">
      <a href="#/" className="brand">
        <Logo />
        <span>
          <strong>Game Studio Hub</strong>
          <small>Votre studio IA</small>
        </span>
      </a>
      <nav className="side-nav">
        <a href="#/" className={route.page === "dashboard" ? "active" : ""}>
          <span className="nav-icon">◈</span> Le studio
          {working && <span className="live-dot" title="Des agents travaillent" />}
          {forYou > 0 && <span className="count warn">{forYou}</span>}
        </a>
        <a href="#/concevoir" className={route.page === "conceive" && !route.project ? "active" : ""}>
          <span className="nav-icon">✦</span> Nouveau projet
        </a>
        <a href="#/qualite" className={route.page === "quality" ? "active" : ""}>
          <span className="nav-icon">◔</span> Qualité
        </a>
        <a href="#/competences" className={route.page === "skills" ? "active" : ""}>
          <span className="nav-icon">❖</span> Compétences
        </a>
        <a href="#/import" className={route.page === "import" ? "active" : ""}>
          <span className="nav-icon">＋</span> Importer un jeu
        </a>
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
      <p className="side-title">Projets</p>
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
        {snap?.projects.length === 0 && <p className="muted small side-empty">Aucun projet.</p>}
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

function Logo() {
  return (
    <svg className="logo" viewBox="0 0 40 40" width="36" height="36" aria-hidden="true">
      <defs>
        <linearGradient id="logo-g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#b8a6ff" />
          <stop offset="1" stopColor="#5b8cff" />
        </linearGradient>
      </defs>
      <path d="M20 2 L36 11 V29 L20 38 L4 29 V11 Z" fill="url(#logo-g)" />
      <path d="M13 17 h14 a4 4 0 0 1 4 4 v1 a5 5 0 0 1 -5 5 h-1 l-2 -2 h-6 l-2 2 h-1 a5 5 0 0 1 -5 -5 v-1 a4 4 0 0 1 4 -4 Z" fill="#0d1020" />
      <circle cx="25" cy="21.5" r="1.4" fill="#b8a6ff" />
      <circle cx="28" cy="23.5" r="1.4" fill="#5b8cff" />
      <path d="M14 22.5 h4 M16 20.5 v4" stroke="#b8a6ff" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
