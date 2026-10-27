import { useEffect, useState } from "react";
import { navigate } from "../App.tsx";
import { api, type Bilan as BilanData, type BilanLevel, type BilanRow } from "../api.ts";

/** Les niveaux du bilan, du plus sûr au plus grave : un libellé court et la couleur de sa pastille. */
const LEVEL: Record<BilanLevel, { label: string; tone: "ok" | "warn" | "bad" | "idle" }> = {
  verifie: { label: "Vérifié", tone: "ok" },
  charge: { label: "Chargé par le jeu", tone: "ok" },
  a_retoucher: { label: "Chargé, à retoucher", tone: "warn" },
  non_prouve: { label: "Pas vérifié", tone: "idle" },
  en_cours: { label: "Intégration en cours", tone: "idle" },
  source_absente: { label: "Fichier validé perdu", tone: "warn" },
  pas_charge: { label: "Pas chargé par le jeu", tone: "bad" },
  ancienne_version: { label: "Ancienne version dans le jeu", tone: "bad" },
  absent: { label: "Absent du jeu", tone: "bad" },
  aspect_change: { label: "Aspect changé", tone: "bad" },
};
const ORDER: BilanLevel[] = ["absent", "ancienne_version", "pas_charge", "aspect_change", "source_absente", "a_retoucher", "non_prouve", "en_cours", "charge", "verifie"];

/**
 * Le bilan des visuels (ADR-71), d'après OhMyGame : chaque visuel donné pour intégré, face aux fichiers du jeu et à ce que
 * le jeu charge vraiment. « Vérifier en lançant le jeu » apporte la preuve ; un problème se répare d'un clic.
 */
export function Bilan({ slug }: { slug: string }) {
  const [data, setData] = useState<BilanData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const checking = data?.checking ?? data?.looking ?? null;
  useEffect(() => {
    let alive = true;
    const load = () => api.artBilan(slug).then((d) => alive && setData(d), (e: Error) => alive && setError(e.message));
    void load();
    // Pendant une vérification, le bilan se met à jour seul ; sinon il ne bouge qu'à la fusion d'un chantier.
    const t = setInterval(load, checking ? 2500 : 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [slug, !!checking]);

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!data) return error ? <p className="error">{error}</p> : <p className="muted">Chargement…</p>;
  const rows = [...data.rows].sort((a, b) => ORDER.indexOf(a.level) - ORDER.indexOf(b.level) || a.id.localeCompare(b.id));
  const count = (tone: string) => rows.filter((r) => LEVEL[r.level].tone === tone).length;
  const canVerify = rows.some((r) => r.copies.length);
  const looking = data.looking ?? null;
  return (
    <section className="bilan" aria-label="Bilan des visuels">
      <div className="bilan-head">
        <p className="bilan-counts">
          {rows.length === 0 ? (
            <span className="muted">Aucun visuel n'est encore dans le jeu.</span>
          ) : (
            <>
              <span>
                <span className="dot ok" /> {count("ok")} chargé(s) par le jeu
              </span>
              <span>
                <span className="dot" /> {count("idle")} pas vérifié(s)
              </span>
              <span>
                <span className="dot warn" /> {count("warn") + count("bad")} à reprendre
              </span>
            </>
          )}
        </p>
        {canVerify && (
          <span className="bilan-actions">
            <button disabled={busy || !!checking} onClick={() => act(async () => setData(await api.artBilanVerify(slug)))}>
              {data.checking ? `Vérification… ${data.checking.done}/${data.checking.total}` : "Vérifier en lançant le jeu"}
            </button>
            <button
              className="secondary"
              disabled={busy || !!checking}
              title="Rephotographie la scène vitrine de chaque visuel et la compare à sa photo validée (fait aussi tout seul après les fusions)"
              onClick={() => act(async () => setData(await api.artLooksCheck(slug)))}
            >
              {looking ? `Comparaison… ${looking.done}/${looking.total}` : "Comparer aux photos validées"}
            </button>
          </span>
        )}
      </div>
      <p className="muted small bilan-help">
        Pour chaque visuel donné pour intégré, le hub cherche sa copie exacte dans les fichiers du jeu, puis lance le jeu sur sa scène vitrine
        et note ce qu'il charge vraiment. Après les fusions, il rephotographie aussi chaque scène vitrine et la compare à sa photo validée.
        « Pas vérifié » veut dire : pas encore prouvé, pas forcément cassé.
      </p>
      {error && <p className="error">{error}</p>}
      <div className="bilan-list">
        {rows.map((r) => (
          <BilanLine
            key={r.id}
            slug={slug}
            r={r}
            busy={busy}
            onRepair={() => act(async () => navigate({ page: "project", slug, thread: (await api.artReintegrate(slug, r.id)).thread, view: "discussion" }))}
            onAccept={() => act(async () => (await api.artLookAccept(slug, r.id), setData(await api.artBilan(slug))))}
          />
        ))}
      </div>
    </section>
  );
}

function BilanLine({ slug, r, busy, onRepair, onAccept }: { slug: string; r: BilanRow; busy: boolean; onRepair: () => void; onAccept: () => void }) {
  const lv = LEVEL[r.level];
  return (
    <article className={`bilan-row tone-${lv.tone}`}>
      {r.thumb ? <img className="pilot-mini" src={api.artFile(slug, r.thumb)} alt="" loading="lazy" /> : <span className="pilot-mini empty" />}
      <div className="pilot-row-body">
        <span className="bilan-title">
          <b>{r.name}</b> <span className="muted small">{r.id}</span>
        </span>
        <span className="small bilan-text">{r.text}</span>
        {r.look && (
          <span className="bilan-look">
            <a href={api.artFile(slug, r.look.ref)} target="_blank" rel="noreferrer" title="Photo validée">
              <img src={api.artFile(slug, r.look.ref)} alt="Avant" loading="lazy" />
            </a>
            <span aria-hidden>→</span>
            <a href={api.artFile(slug, r.look.file)} target="_blank" rel="noreferrer" title="Maintenant">
              <img src={api.artFile(slug, r.look.file)} alt="Maintenant" loading="lazy" />
            </a>
          </span>
        )}
      </div>
      <span className={`bilan-badge tone-${lv.tone}`}>{lv.label}</span>
      {r.problem && (
        <button className="secondary" disabled={busy} onClick={onRepair} title="Le directeur du projet relance un chantier pour remettre le bon fichier dans le jeu">
          Faire réintégrer
        </button>
      )}
      {r.look && (
        <button className="secondary" disabled={busy} onClick={onAccept} title="Le changement est voulu : la nouvelle photo devient la référence">
          Accepter le nouvel aspect
        </button>
      )}
    </article>
  );
}
