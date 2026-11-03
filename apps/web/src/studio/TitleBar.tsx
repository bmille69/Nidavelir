import type { Route } from "../App.tsx";
import { useStudio } from "./context.tsx";
import { Icon } from "./Icon.tsx";

const PAGES: Partial<Record<Route["page"], string>> = {
  dashboard: "Accueil",
  forge: "La Forge",
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
  memory: "Mémoire et équipe",
  ideas: "Atelier d'idées",
  idea: "Idée",
};
/** Les onglets du projet (ADR-113) et les pages qu'ils contiennent. */
const VIEWS = { discussion: "Discussion", recap: "Récap", tasks: "Récap", plans: "Plans de production", decisions: "Toutes les décisions", vision: "Le jeu", art: "Art & son" } as const;

/**
 * Barre de titre de l'application de bureau (apps/desktop) : la fenêtre n'a plus de cadre Windows,
 * cette barre la déplace, dit où l'on est, ouvre la palette et montre l'état du studio.
 * Les boutons réduire / agrandir / fermer sont ceux de Windows, posés par-dessus à droite.
 */
/**
 * « Redémarrer et mettre à jour » (application de bureau) : le hub s'arrête proprement, puis Nidavellir se relance,
 * reprend la dernière version et recompile l'interface si elle a changé. Confirmation si l'équipe travaille.
 */
export function restartApp(working: number) {
  if (!window.nidavellir?.restart) return;
  const ask = working
    ? `${working} agent${working > 1 ? "s travaillent" : " travaille"} en ce moment : le redémarrage interrompt leur travail en cours. Redémarrer quand même ?`
    : "Redémarrer Nidavellir pour prendre la dernière version ? La fenêtre se ferme puis revient d'elle-même.";
  if (window.confirm(ask)) window.nidavellir.restart();
}

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
        <a href="#/forge" className={`titlebar-live ${working ? "on" : ""}`} title="La Forge : l'équipe à ses postes">
          <span className="titlebar-dot" />
          {working ? `${working} au travail` : "Au repos"}
        </a>
        {window.nidavellir?.restart && (
          <button className="titlebar-restart" onClick={() => restartApp(working)} title="Redémarrer et mettre à jour : prend la dernière version de Nidavellir">
            <Icon name="refresh" size={14} />
            <span>Mettre à jour</span>
          </button>
        )}
      </div>
    </header>
  );
}
