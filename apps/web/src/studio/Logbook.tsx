import { useCallback, useEffect, useState } from "react";
import { api, type LogWeek } from "../api.ts";

const day = (iso: string) => new Date(iso).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });
const usd = (n: number) => `${n.toFixed(2).replace(".", ",")} $`;
const label = (week: string) => `semaine du ${new Date(`${week}T12:00:00`).toLocaleDateString("fr-FR", { day: "numeric", month: "long" })}`;

/**
 * Le journal de bord (ADR-89) : semaine par semaine, le jeu qui change en images (un GIF, une capture par fusion), les
 * chantiers fusionnés et les visuels intégrés, les chiffres ; et, sur votre demande, la semaine racontée par le directeur.
 */
export function Logbook({ slug }: { slug: string }) {
  const [data, setData] = useState<{ weeks: string[]; current: LogWeek } | null>(null);
  const [week, setWeek] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.logbook(slug, week).then(setData, (e: Error) => setError(e.message)), [slug, week]);
  useEffect(() => {
    void load();
  }, [load]);
  if (!data) return error ? <p className="error">{error}</p> : <p className="muted">Chargement…</p>;
  const w = data.current;
  const f = w.facts;
  const tell = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await api.logbookTell(slug, w.week);
      setData({ ...data, current: next });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="logbook" aria-label="Journal de bord">
      <div className="bilan-head">
        <span className="bilan-actions">
          <button className="small secondary" disabled={!w.previous} onClick={() => setWeek(w.previous!)}>
            ← Précédente
          </button>
          <b>{label(w.week)}</b>
          <button className="small secondary" disabled={!w.next} onClick={() => setWeek(w.next!)}>
            Suivante →
          </button>
        </span>
        <span className="muted small">
          {f.merged} fusion(s) · {f.visuals} visuel(s) intégré(s) · {f.failed} échec(s) · {usd(f.costUsd)}
          {f.balanceRuns ? ` · équilibreur ×${f.balanceRuns}` : ""}
          {f.benchRuns ? ` · banc d'essai ×${f.benchRuns}` : ""}
          {f.replaysSaved ? ` · ${f.replaysSaved} partie(s) gardée(s)` : ""}
        </span>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="logbook-top">
        {w.gif ? (
          <figure className="logbook-gif">
            <img src={api.logbookGif(slug, w.week, w.entries.filter((e) => e.shot).length)} alt={`Le jeu au fil de la ${label(w.week)}`} />
            <figcaption className="muted small">Le jeu au fil de la semaine, une image par fusion.</figcaption>
          </figure>
        ) : null}
        <div className="logbook-story">
          {w.story ? (
            <>
              <p className="logbook-text">{w.story.text}</p>
              <p className="muted small">Raconté par le directeur le {day(w.story.at)}</p>
            </>
          ) : (
            <p className="muted small">Les faits ci-dessous sont tenus par le hub, sans modèle. Le directeur peut en faire le récit de la semaine.</p>
          )}
          {(w.entries.length > 0 || w.visuals.length > 0) && (
            <button className="small secondary" disabled={busy} onClick={tell}>
              {busy ? "Le directeur écrit…" : w.story ? "Raconter à nouveau" : "Raconter la semaine"}
            </button>
          )}
        </div>
      </div>
      {!w.entries.length && !w.visuals.length && <p className="pilot-empty">Rien n'a été fusionné cette semaine-là.</p>}
      <ol className="logbook-list">
        {w.entries.map((e) => (
          <li key={e.task} className="logbook-entry">
            {e.shot ? <img src={api.screenshotUrl(slug, e.task, e.at)} alt="" loading="lazy" /> : <span className="logbook-noshot" />}
            <div>
              <div className="pilot-card-top">
                <a className="pilot-id" href={`#/p/${slug}/tasks/${e.task}`}>
                  {e.task}
                </a>
                <span className="muted small">
                  {day(e.at)} · {usd(e.costUsd)}
                </span>
              </div>
              <h3>{e.title}</h3>
              {e.summary && <p className="small">{e.summary}</p>}
              {e.checks && <p className="muted small">{e.checks}</p>}
            </div>
          </li>
        ))}
        {w.visuals.map((v) => (
          <li key={v.id} className="logbook-entry">
            {v.image ? <img src={api.artFile(slug, v.image)} alt="" loading="lazy" /> : <span className="logbook-noshot" />}
            <div>
              <div className="pilot-card-top">
                <span className="pilot-id">{v.id}</span>
                <span className="muted small">{day(v.at)}</span>
              </div>
              <h3>Visuel « {v.name} » intégré</h3>
              {v.task && <p className="muted small">par {v.task}</p>}
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
