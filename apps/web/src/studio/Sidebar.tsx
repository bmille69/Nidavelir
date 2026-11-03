import type { Route } from "../App.tsx";
import { useEffect, useRef, useState, type ReactNode } from "react";
import logoMark from "../assets/logo-mark.png";
import { api, type Conception, type SessionInfo } from "../api.ts";
import { useStudio } from "./context.tsx";
import { Icon, type IconName } from "./Icon.tsx";
import { useGlider, useMotion } from "./motion.tsx";
import { UsageMeter } from "./UsageMeter.tsx";

const ORCHESTRATOR: Record<string, string> = { "direct-claude": "Claude (direct)", hermes: "Hermes", none: "aucun" };

/**
 * Menu principal, dans l'ordre de l'usage : ce qui vous attend, vos jeux, créer ;
 * puis, plus bas, la Forge et les réglages.
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
  const [motion, setMotion] = useMotion();
  // Un seul repère glisse d'une entrée active à l'autre (ADR-94).
  const aside = useRef<HTMLElement>(null);
  useGlider(aside, ".side-nav a.active, .side-projects a.active", [route, snap?.projects.length, conceptions.length]);

  const item = (to: string, icon: IconName, label: string, on: boolean, extra?: ReactNode) => (
    <a href={to} className={on ? "active" : ""}>
      <Icon name={icon} className="nav-icon" />
      <span className="nav-label">{label}</span>
      {extra}
    </a>
  );

  return (
    <aside className="sidebar" ref={aside}>
      <span className="glider" aria-hidden="true" />
      <div className="brand-row">
        <a href="#/" className="brand" aria-label="Nidavellir — le hub de création de jeux vidéo">
          <Logo size={30} />
          <span className="brand-text">
            <b>Nidavellir</b>
            <small>Studio de jeux</small>
          </span>
        </a>
        {onClose && (
          <button className="icon-btn drawer-close" aria-label="Fermer le menu" onClick={onClose}>
            <Icon name="close" />
          </button>
        )}
      </div>

      <button className="side-search" onClick={() => window.dispatchEvent(new Event("studio:palette"))}>
        <Icon name="search" size={15} />
        <span>Rechercher…</span>
        <kbd>Ctrl K</kbd>
      </button>

      <nav className="side-nav">
        {item("#/", "home", "Accueil", route.page === "dashboard", forYou > 0 ? <span className="count warn">{forYou}</span> : null)}
        {item("#/pilotage", "chart", "Pilotage", route.page === "pilot")}
        {item(
          "#/forge",
          "cube",
          "La Forge",
          route.page === "forge",
          working > 0 ? (
            <span className="live-chip">
              <span className="live-dot" /> {working}
            </span>
          ) : null,
        )}
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
      <nav className="side-nav side-create">
        {item("#/idees", "book", "Atelier d'idées", route.page === "ideas" || route.page === "idea")}
        {item("#/express", "bolt", "Jeu express", route.page === "express" || route.page === "expressGame")}
        {item("#/concevoir", "sparkle", "Nouveau projet", route.page === "conceive" && !route.project)}
        {item("#/import", "download", "Importer un jeu", route.page === "import")}
        {item("#/demontage", "hammer", "Démonter un jeu", route.page === "dissections" || route.page === "dissection")}
        {item("#/mods", "puzzle", "Modder un jeu", route.page === "mods" || route.page === "mod")}
      </nav>

      <div className="side-spacer" />

      <p className="side-title">Studio</p>
      <nav className="side-nav">
        {item("#/qualite", "chart", "Qualité", route.page === "quality")}
        {item("#/memoire", "chat", "Mémoire et équipe", route.page === "memory")}
        {item("#/competences", "puzzle", "Compétences", route.page === "skills")}
        {item("#/telephone", "phone", "Téléphone", route.page === "phone")}
      </nav>

      <UsageMeter />
      <div className="side-foot">
        <label className="motion-switch" title="Coupe les animations et les effets de survol, sur ce poste">
          <span>Animations</span>
          <input type="checkbox" role="switch" checked={motion === "full"} onChange={(e) => setMotion(e.target.checked ? "full" : "reduced")} />
          <i aria-hidden="true" />
        </label>
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
  // Le N de Nidavellir (DA du 15/10), moitié glace, moitié braise.
  return <img className="logo" src={logoMark} alt="" aria-hidden="true" width={Math.round((size * 104) / 122)} height={size} />;
}
