import { useCallback, useEffect, useState } from "react";
import { api, type Item, type Lineage } from "../api.ts";
import { formatDate, STATUS_LABEL, TYPE_LABEL } from "./labels.ts";

export function VisionView({ slug }: { slug: string }) {
  const [canon, setCanon] = useState<Item[]>([]);
  const [past, setPast] = useState<Item[]>([]);
  const [rev, setRev] = useState(0);
  const [why, setWhy] = useState<Lineage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [c, all] = await Promise.all([api.items(slug, "canon"), api.items(slug, "all")]);
    setCanon(c.items);
    setRev(c.vision_rev);
    setPast(all.items.filter((i) => i.type === "decision" && (i.status === "superseded" || i.status === "abandoned")));
  }, [slug]);

  useEffect(() => {
    refresh().catch((e: Error) => setError(e.message));
  }, [refresh]);

  async function showWhy(id: string) {
    try {
      setWhy(await api.why(slug, id));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function abandon(l: Lineage) {
    if (!window.confirm(`Abandonner la décision ${l.item.id} « ${l.item.title} » ? Elle restera dans l'historique, mais ne fera plus partie de la vision.`)) return;
    try {
      await api.abandon(slug, l.item.id, l.hash);
      setWhy(null);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const decisions = canon.filter((i) => i.type === "decision");

  return (
    <main className="vision-layout">
      <section className="page wide">
        <div className="page-head">
          <div>
            <h1>Vision validée</h1>
            <p className="muted small">
              Ce que vous avez décidé. C'est la seule référence que les agents considèrent comme officielle. Version {rev}.
            </p>
          </div>
        </div>
        {error && <p className="error">{error}</p>}
        {decisions.length === 0 && <p className="muted">Aucune décision validée pour l'instant. Rendez-vous dans l'onglet « Décisions ».</p>}
        <div className="decisions">
          {decisions.map((d) => (
            <article key={d.id} className={`card decision ${why?.item.id === d.id ? "focus" : ""}`}>
              <div className="proposal-head">
                <h2 className="grow">{d.title}</h2>
                <span className="muted small">
                  {d.id} · validée le {formatDate(d.validated_by?.at)}
                </span>
              </div>
              <p className="statement">{d.statement}</p>
              <div className="row">
                <button className="link small" onClick={() => showWhy(d.id)}>
                  Pourquoi ? D'où vient cette décision
                </button>
                {d.decision?.human_edits && <span className="badge">modifiée par vous</span>}
                {d.decision?.supersedes.length ? <span className="badge">remplace {d.decision.supersedes.join(", ")}</span> : null}
              </div>
            </article>
          ))}
        </div>

        {past.length > 0 && (
          <details className="card">
            <summary>Historique : {past.length} décision(s) remplacée(s) ou abandonnée(s)</summary>
            <ul className="history">
              {past.map((d) => (
                <li key={d.id}>
                  <button className="link" onClick={() => showWhy(d.id)}>
                    {d.id} — {d.title}
                  </button>{" "}
                  <span className="muted small">
                    {STATUS_LABEL[d.status]}
                    {d.decision?.superseded_by ? ` par ${d.decision.superseded_by}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>

      {why && (
        <aside className="panel why">
          <div className="row">
            <h2 className="grow">Pourquoi {why.item.id} ?</h2>
            <button className="link" onClick={() => setWhy(null)}>
              Fermer
            </button>
          </div>
          <p>
            <strong>{why.item.title}</strong>
            <span className="muted small"> · {STATUS_LABEL[why.item.status] ?? why.item.status}</span>
          </p>
          <p className="small">{why.item.statement}</p>
          {why.item.validated_by && (
            <p className="muted small">
              Validée par vous le {formatDate(why.item.validated_by.at)} (accord {why.item.validated_by.approval}).
            </p>
          )}
          {why.supersededBy && (
            <p className="notice small">
              Remplacée depuis par {why.supersededBy.id} « {why.supersededBy.title} ».
            </p>
          )}
          {why.ancestors.length > 0 && (
            <>
              <h3>D'où elle vient</h3>
              <ul className="sources">
                {why.ancestors.map((a) => (
                  <li key={a.id}>
                    <div>
                      <span className={`badge type-${a.type}`}>{TYPE_LABEL[a.type] ?? a.type}</span> {a.id} · {a.title}
                      <span className="muted small"> ({STATUS_LABEL[a.status] ?? a.status})</span>
                    </div>
                    {a.source.quote && (
                      <blockquote>
                        « {a.source.quote} »<cite>{a.source.kind === "file" ? a.source.ref : "vous, en discussion"}</cite>
                      </blockquote>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          {why.item.type === "decision" && why.item.status === "validated" && (
            <button className="secondary danger small" onClick={() => abandon(why)}>
              Abandonner cette décision
            </button>
          )}
        </aside>
      )}
    </main>
  );
}
