import { useState } from "react";
import { Icon } from "./Icon.tsx";
import { useStudio } from "./context.tsx";

/**
 * « À vous de jouer » (ADR-64) : tout ce qui attend votre action, tous projets confondus (un chantier qui attend votre mot,
 * une question ou une décision du Directeur artistique, un plan, une autorisation, une conception). Un clic mène au bon endroit.
 * `floating` : le bouton du PC, en haut à droite, affiché seulement quand quelque chose vous attend.
 * `exclude` : le projet ouvert, dont la boîte « À vous » montre déjà tout (ADR-113) ; le bouton ne parle que des autres.
 */
export function ForYou({ floating = false, exclude }: { floating?: boolean; exclude?: string }) {
  const snap = useStudio();
  const [open, setOpen] = useState(false);
  const items = (snap?.agents.find((a) => a.id === "you")?.activities ?? []).filter((a) => !exclude || a.project !== exclude);
  if (floating && items.length === 0) return null;
  const names = new Map(snap?.projects.map((p) => [p.slug, p.name]) ?? []);
  return (
    <div className={`for-you ${floating ? "floating" : ""}`}>
      <button className={`live-badge warn for-you-btn`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Icon name="bell" size={16} /> {items.length} {exclude ? "dans vos autres jeux" : "à vous"}
      </button>
      {open && (
        <>
          <div className="for-you-backdrop" onClick={() => setOpen(false)} />
          <div className="for-you-pop" role="dialog" aria-label="À vous de jouer">
            <h3>{exclude ? "À vous de jouer, ailleurs" : "À vous de jouer"}</h3>
            {items.length === 0 && <p className="muted small">Rien ne vous attend.</p>}
            <ul>
              {items.map((a, k) => (
                <li key={k}>
                  <a href={a.href} onClick={() => setOpen(false)}>
                    {a.project && <span className="muted small">{names.get(a.project) ?? a.project}</span>}
                    <span>{a.text}</span>
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </div>
  );
}
