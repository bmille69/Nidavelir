import { useCallback, useEffect, useState } from "react";
import { api, type Item, type ProposalCard } from "../api.ts";
import { ago } from "./agents.ts";
import { useNow } from "./context.tsx";

/**
 * « Ajouté récemment à la bible » (ADR-23) : ce que le directeur ou vous venez de décider, sous la boîte « À vous » de
 * la discussion en autonomie (ADR-113). Ses questions, elles, sont des cartes de la boîte (ChoiceCard).
 */
export function RecentBible({ slug }: { slug: string }) {
  const [recent, setRecent] = useState<Item[]>([]);
  const now = useNow(30_000);

  const load = useCallback(async () => {
    const canon = await api.items(slug, "canon");
    setRecent(
      canon.items
        .filter((i) => i.type === "decision" && i.nature !== "technical")
        .sort((a, b) => ((b.validated_by?.at ?? "") > (a.validated_by?.at ?? "") ? 1 : -1))
        .slice(0, 5),
    );
  }, [slug]);
  useEffect(() => {
    load().catch(() => {});
    const t = setInterval(() => load().catch(() => {}), 4000);
    return () => clearInterval(t);
  }, [load]);

  if (!recent.length) return null;
  return (
    <section className="recent-bible">
      <h3>Ajouté récemment à la bible</h3>
      <ul>
        {recent.map((d) => (
          <li key={d.id}>
            <a href={`#/p/${slug}/vision`}>{d.title}</a>
            <span className="muted small">
              {d.validated_by?.kind === "delegated" ? "par le directeur" : "par vous"} · {d.validated_by ? ago(d.validated_by.at, now) : ""}
            </span>
          </li>
        ))}
      </ul>
      <a className="small" href={`#/p/${slug}/vision`}>
        Ouvrir « Le jeu » →
      </a>
    </section>
  );
}

export function ChoiceCard({ slug, card, onDone, onError }: { slug: string; card: ProposalCard; onDone: () => void; onError: (m: string) => void }) {
  const { proposal: p, hash, supersedes } = card;
  const d = p.proposal!;
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  async function decide(verdict: "approved" | "rejected", chosen?: string) {
    setBusy(true);
    try {
      await api.decide(slug, p.id, { hash, verdict, edits: chosen ? { chosen_option: chosen } : undefined });
      onDone();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className="choice">
      <p className="choice-kind">{d.options.length ? "Un choix à faire" : supersedes.length ? "Ça change une décision" : "Une question"}</p>
      <h3>{p.title}</h3>
      {d.summary && <p className="small">{d.summary}</p>}

      {d.options.length > 0 ? (
        <div className="options">
          {d.options.map((o) => (
            <div key={o.key} className={`option ${o.key === d.recommended_option ? "recommended" : ""}`}>
              <button disabled={busy} onClick={() => decide("approved", o.key)}>
                {o.label}
                {o.key === d.recommended_option && <span className="star"> ★ conseillé</span>}
              </button>
              <button className="link small" onClick={() => setOpen(open === o.key ? null : o.key)}>
                {open === o.key ? "masquer" : "détail"}
              </button>
              {open === o.key && (
                <div className="small option-detail">
                  <p>{o.statement}</p>
                  {o.tradeoffs && <p className="muted">{o.tradeoffs}</p>}
                </div>
              )}
            </div>
          ))}
        </div>
      ) : supersedes.length > 0 ? (
        <>
          {supersedes.map((s) => (
            <p key={s.id} className="small before-after">
              <span className="muted">Avant :</span> {s.decision?.summary ?? s.statement}
              <br />
              <span className="muted">Maintenant :</span> {d.summary ?? p.statement}
            </p>
          ))}
          <div className="row">
            <button disabled={busy} onClick={() => decide("approved")}>
              Adopter la nouvelle version
            </button>
            <button className="secondary" disabled={busy} onClick={() => decide("rejected")}>
              Garder l'ancienne
            </button>
          </div>
        </>
      ) : (
        <>
          <ul className="small">
            {d.questions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
          <div className="row">
            <button disabled={busy} onClick={() => decide("approved")}>
              D'accord tel quel
            </button>
            <button className="secondary" disabled={busy} onClick={() => decide("rejected")}>
              Écarter
            </button>
          </div>
        </>
      )}
      {d.options.length > 0 && (
        <button className="link small discard" disabled={busy} onClick={() => decide("rejected")}>
          Aucune : écarter
        </button>
      )}
      <p className="muted small hint">Autre idée ? Dites-la simplement au directeur dans la discussion.</p>
    </article>
  );
}
