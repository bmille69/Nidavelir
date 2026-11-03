import { useMemo, useRef, useState } from "react";
import { useStudio } from "../context.tsx";
import { Icon } from "../Icon.tsx";
import { useBusiestProject, useForge, useForgeScene } from "./ForgeView.tsx";
import { dayLight, deriveForge, hourOf } from "./model.ts";

/**
 * L'aperçu de la Forge sur l'accueil (ADR-106) : le jeu le plus occupé, en petit, sans étiquettes.
 * Un clic ouvre la Forge du jeu. Les puces changent de jeu.
 */
export function ForgeMini() {
  const snap = useStudio();
  const projects = snap?.projects ?? [];
  const busiest = useBusiestProject(snap);
  const [chosen, setChosen] = useState<string | null>(null);
  const slug = chosen && projects.some((p) => p.slug === chosen) ? chosen : busiest;
  const forge = useForge(slug, 5000);
  const state = useMemo(() => deriveForge(slug ?? "", snap, forge), [slug, snap, forge]);
  const canvas = useRef<HTMLCanvasElement>(null);
  const { error } = useForgeScene({ canvas, mini: true, state, hour: () => hourOf(new Date()) });
  // L'accueil ne monte l'aperçu que s'il y a au moins un jeu : le canvas existe dès le premier rendu.
  if (error) return null;
  const working = state.actors.filter((a) => a.mode === "work").length;
  const forYou = state.review.length + state.escalations.length;
  const light = dayLight(hourOf(new Date()));

  return (
    <section className="panel-card forge-mini">
      <div className="section-head">
        <h2>
          <Icon name="cube" size={16} /> La Forge
        </h2>
        <span className="muted small">{light.label}</span>
      </div>
      {projects.length > 1 && (
        <div className="forge-mini-chips">
          {projects.slice(0, 5).map((p) => (
            <button key={p.slug} className={p.slug === slug ? "on" : ""} onClick={() => setChosen(p.slug)}>
              {p.name}
            </button>
          ))}
        </div>
      )}
      <a className="forge-mini-stage" href={slug ? `#/forge/${encodeURIComponent(slug)}` : "#/forge"} title="Ouvrir la Forge">
        <canvas ref={canvas} aria-label={`La Forge de ${state.name}`} />
        <span className="forge-mini-caption">
          <b>{state.name}</b>
          <span>
            {working ? `${working} au travail` : "Équipe au repos"}
            {forYou ? ` · ${forYou} pour vous` : ""}
          </span>
        </span>
        <span className="forge-mini-go">
          Ouvrir <Icon name="arrow" size={13} />
        </span>
      </a>
    </section>
  );
}
