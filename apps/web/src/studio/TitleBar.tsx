import type { Route } from "../App.tsx";
import { useStudio } from "./context.tsx";
import { Icon } from "./Icon.tsx";

const PAGES: Partial<Record<Route["page"], string>> = {
  dashboard: "Accueil",
  live: "En direct",
  pilot: "Pilotage",
  import: "Importer un jeu",
  quality: "Qualité",
  skills: "Compétences",
  phone: "Téléphone",
  dissections: "Démonter un jeu",
  dissection: "Démontage",
  express: "Jeu express",
  expressGame: "Jeu express",
  mods: "Modder un jeu",
  mod: "Mod",
  conceive: "Concevoir",
  conception: "Conception",
};
const VIEWS = { discussion: "Discussion", decisions: "Décisions", vision: "Le jeu", tasks: "Chantiers", art: "Direction artistique" } as const;

/**
 * Barre de titre de l'application de bureau (apps/desktop) : la fenêtre n'a plus de cadre Windows,
 * cette barre la déplace, dit où l'on est, ouvre la palette et montre l'état du studio.
 * Les boutons réduire / agrandir / fermer sont ceux de Windows, posés par-dessus à droite.
 */
export function TitleBar({ route }: { route: Route }) {
  const snap = useStudio();
  const working = snap?.agents.filter((a) => a.id !== "you" && a.state !== "idle").length ?? 0;
  const crumbs: { label: string; href?: string }[] = [];
  if (route.page === "project") {
    const project = snap?.projects.find((p) => p.slug === route.slug);
    crumbs.push({ label: project?.name ?? route.slug, href: `#/p/${encodeURIComponent(route.slug)}` });
    if (route.view && route.view !== "discussion") crumbs.push({ label: VIEWS[route.view] });
  } else {
    if (route.page === "dissection") crumbs.push({ label: PAGES.dissections!, href: "#/demontage" });
    if (route.page === "mod") crumbs.push({ label: PAGES.mods!, href: "#/mods" });
    if (route.page === "expressGame") crumbs.push({ label: PAGES.express!, href: "#/express" });
    crumbs.push({ label: PAGES[route.page] ?? "Nidavellir" });
  }

  return (
    <header className="titlebar">
      <nav className="titlebar-crumbs" aria-label="Où vous êtes">
        {crumbs.map((c, i) => (
          <span key={i} className="titlebar-crumb">
            {i > 0 && <span className="titlebar-sep">/</span>}
            {c.href && i < crumbs.length - 1 ? <a href={c.href}>{c.label}</a> : <b>{c.label}</b>}
          </span>
        ))}
      </nav>
      <button className="titlebar-search" onClick={() => window.dispatchEvent(new Event("studio:palette"))}>
        <Icon name="search" size={14} />
        <span>Rechercher, ouvrir, lancer…</span>
        <kbd>Ctrl K</kbd>
      </button>
      <div className="titlebar-status">
        <a href="#/direct" className={`titlebar-live ${working ? "on" : ""}`} title="Le studio en direct">
          <span className="titlebar-dot" />
          {working ? `${working} au travail` : "Au repos"}
        </a>
      </div>
    </header>
  );
}
