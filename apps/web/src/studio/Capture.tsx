import { useState } from "react";
import { api } from "../api.ts";

/** Capture du jeu prise par le hub au lancement de la version d'un chantier (ADR-33). Rien si elle n'existe pas. */
export function Capture({ slug, task, version }: { slug: string; task: string; version?: string }) {
  const [missing, setMissing] = useState(false);
  if (missing) return null;
  const src = api.screenshotUrl(slug, task, version);
  return (
    <figure className="capture">
      <a href={src} target="_blank" rel="noreferrer">
        <img src={src} alt={`Le jeu au lancement, avec le chantier ${task}`} loading="lazy" onError={() => setMissing(true)} />
      </a>
      <figcaption>Le jeu au lancement, avec ce chantier (capture du hub, quelques secondes après le démarrage).</figcaption>
    </figure>
  );
}
