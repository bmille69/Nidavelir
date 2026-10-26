import { useState } from "react";
import { api } from "../api.ts";
import { Annotator } from "./Annotator.tsx";

/**
 * Capture du jeu prise par le hub au lancement de la version d'un chantier (ADR-33). Rien si elle n'existe pas.
 * Avec `annotate`, « Montrer un défaut » ouvre la capture pour y dessiner, puis l'envoie au directeur (ADR-72).
 */
export function Capture({ slug, task, version, annotate }: { slug: string; task: string; version?: string; annotate?: (text: string, image: Blob) => Promise<void> }) {
  const [missing, setMissing] = useState(false);
  const [drawing, setDrawing] = useState(false);
  if (missing) return null;
  const src = api.screenshotUrl(slug, task, version);
  return (
    <figure className="capture">
      <a href={src} target="_blank" rel="noreferrer">
        <img src={src} alt={`Le jeu au lancement, avec le chantier ${task}`} loading="lazy" onError={() => setMissing(true)} />
      </a>
      <figcaption>
        Le jeu au lancement, avec ce chantier (capture du hub, quelques secondes après le démarrage).
        {annotate && (
          <button className="link small capture-annotate" onClick={() => setDrawing(true)}>
            Montrer un défaut
          </button>
        )}
      </figcaption>
      {drawing && annotate && <Annotator source={src} title={`Capture de ${task}`} onClose={() => setDrawing(false)} onSend={annotate} />}
    </figure>
  );
}
