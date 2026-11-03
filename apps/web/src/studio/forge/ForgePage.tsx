import { useStudio } from "../context.tsx";
import { Icon } from "../Icon.tsx";
import { ForgeView, projectRunning, useBusiestProject } from "./ForgeView.tsx";

/**
 * La Forge, page du studio (remplace « En direct ») : l'équipe en voxels, en grand. Par défaut le jeu qui tourne,
 * sinon un jeu à l'arrêt ; les puces changent de jeu (#/forge/<jeu>). Le bouton « Démo » reste toujours là.
 */
export function ForgePage({ slug: wanted }: { slug?: string }) {
  const snap = useStudio();
  const busiest = useBusiestProject(snap);
  const projects = snap?.projects ?? [];
  const slug = wanted && projects.some((p) => p.slug === wanted) ? wanted : busiest;
  const running = projects.filter((p) => projectRunning(snap, p.slug)).length;

  return (
    <main className="forge-global">
      <header className="forge-global-head">
        <h1>
          <Icon name="cube" size={20} /> La Forge
        </h1>
        <span className="muted small forge-global-sub">
          {!snap ? "Chargement du studio…" : running ? `${running} jeu${running > 1 ? "x" : ""} en cours` : projects.length ? "Tout le studio est à l'arrêt" : "Aucun jeu pour l'instant"}
        </span>
        {projects.length > 1 && (
          <nav className="forge-projects" aria-label="Jeu affiché dans la Forge">
            {projects.map((p) => (
              <a key={p.slug} href={`#/forge/${encodeURIComponent(p.slug)}`} className={p.slug === slug ? "on" : ""} aria-current={p.slug === slug ? "page" : undefined}>
                <i className={`dot ${projectRunning(snap, p.slug) ? "work" : ""}`} />
                {p.name}
              </a>
            ))}
          </nav>
        )}
      </header>
      {snap && (
        // Un jeu, une scène : changer de jeu repart d'une Forge propre (sélection, démo).
        <ForgeView key={slug ?? ""} slug={slug ?? ""} />
      )}
      {snap && !projects.length && (
        <p className="muted small forge-global-empty">
          Pas encore de jeu : la Forge est vide. Essayez « Démo » pour la voir s'animer, ou <a href="#/concevoir">créez un jeu</a>.
        </p>
      )}
    </main>
  );
}
