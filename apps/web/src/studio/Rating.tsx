import { useState } from "react";
import { api, type Rating } from "../api.ts";

/** Votre avis sur un chantier, en un clic (le signal le plus important du tableau « Qualité »). */
export function RatingBox({ slug, task, initial, compact }: { slug: string; task: string; initial: Rating | null; compact?: boolean }) {
  const [rating, setRating] = useState<Rating | null>(initial);
  const [note, setNote] = useState(initial?.note ?? "");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function rate(value: "up" | "down", withNote?: string) {
    setError(null);
    try {
      setRating(await api.rateTask(slug, task, value, withNote));
      if (value === "down" && withNote === undefined) setOpen(true);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <div className={`rating ${compact ? "compact" : ""}`}>
      {!compact && <span className="rating-q">{rating ? "Votre avis :" : "Ce chantier correspond-il à ce que vous vouliez ?"}</span>}
      <button className={`rate up ${rating?.rating === "up" ? "on" : ""}`} onClick={() => rate("up")} title="Oui, c'est ce que je voulais" aria-label="Avis positif">
        👍
      </button>
      <button className={`rate down ${rating?.rating === "down" ? "on" : ""}`} onClick={() => rate("down")} title="Non, pas comme ça" aria-label="Avis négatif">
        👎
      </button>
      {!compact && rating && !open && (
        <button className="link small" onClick={() => setOpen(true)}>
          {rating.note ? `« ${rating.note} »` : "ajouter un mot"}
        </button>
      )}
      {open && (
        <span className="rating-note">
          <input placeholder="En un mot, pourquoi ? (facultatif)" value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
          <button
            className="small"
            onClick={async () => {
              await rate(rating?.rating ?? "down", note);
              setOpen(false);
            }}
          >
            OK
          </button>
        </span>
      )}
      {error && <span className="error small">{error}</span>}
    </div>
  );
}
