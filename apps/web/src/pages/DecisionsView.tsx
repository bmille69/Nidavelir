import { useCallback, useEffect, useState } from "react";
import { api, type DecideEdits, type Item, type ProposalCard, type SynthesisJob } from "../api.ts";
import { TYPE_LABEL } from "./labels.ts";

export function DecisionsView({ slug }: { slug: string }) {
  const [cards, setCards] = useState<ProposalCard[]>([]);
  const [pending, setPending] = useState(0);
  const [jobs, setJobs] = useState<SynthesisJob[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [c, n, j] = await Promise.all([api.proposals(slug), api.candidates(slug), api.synthesisJobs(slug)]);
    setCards(c);
    setPending(n.count);
    setJobs(j);
    setSelected((s) => new Set([...s].filter((id) => c.some((x) => x.proposal.id === id))));
  }, [slug]);

  useEffect(() => {
    refresh().catch((e: Error) => setError(e.message));
  }, [refresh]);

  const running = jobs.find((j) => j.status === "running");
  const last = [...jobs].reverse().find((j) => j.status !== "running");
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => refresh().catch(() => {}), 3000);
    return () => clearInterval(t);
  }, [running, refresh]);

  async function prepare() {
    setError(null);
    setFlash(null);
    try {
      await api.synthesize(slug);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Créatif = vos décisions ; technique = règles du code, rangées à part (l'architecte s'en chargera).
  const creative = cards.filter((c) => c.proposal.nature !== "technical");
  const technical = cards.filter((c) => c.proposal.nature === "technical");
  const unsorted = cards.filter((c) => !c.proposal.nature).length;

  async function redo() {
    if (!window.confirm("Refaire le regroupement ? Les propositions en attente reviendront au tri et seront regroupées à nouveau, en séparant créatif et technique. Rien de validé ne change.")) return;
    setError(null);
    setFlash(null);
    try {
      await api.redoSynthesis(slug);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function takeNote() {
    if (!window.confirm(`En prendre acte : les ${technical.length} règle(s) technique(s) seront enregistrées comme « l'état actuel du code ». Les assistants les respecteront et ne les changeront pas sans raison. Continuer ?`)) return;
    try {
      const { results } = await api.decideBatch(slug, technical.map((c) => ({ id: c.proposal.id, hash: c.hash })));
      const ok = results.filter((r) => r.decision).length;
      setFlash(`${ok} règle(s) technique(s) enregistrée(s).`);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function validateSelected() {
    const list = creative.filter((c) => selected.has(c.proposal.id));
    if (!list.length) return;
    if (!window.confirm(`Valider telles quelles les ${list.length} proposition(s) cochées ? Elles deviendront la vision officielle du jeu.`)) return;
    try {
      const { results } = await api.decideBatch(slug, list.map((c) => ({ id: c.proposal.id, hash: c.hash })));
      const ok = results.filter((r) => r.decision).length;
      const ko = results.filter((r) => r.error);
      setFlash(`${ok} décision(s) validée(s).${ko.length ? ` ${ko.length} non traitée(s) : ${ko[0]!.error}` : ""}`);
      setSelected(new Set());
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <main className="page wide">
      <section className="card hero">
        <div>
          <h1>Décisions à prendre</h1>
          <p className="muted">
            Le directeur regroupe les fiches notées par sujet et vous propose un résumé par groupe. Vous validez, modifiez ou refusez.
            Rien ne devient officiel sans votre clic.
          </p>
        </div>
        <div className="hero-side">
          <div className="big">{pending}</div>
          <div className="muted small">fiche(s) pas encore regroupée(s)</div>
          <button onClick={prepare} disabled={!pending || !!running}>
            {running ? "Regroupement en cours…" : "Préparer des propositions"}
          </button>
          {cards.length > 0 && !running && (
            <button className="link small" onClick={redo}>
              Refaire le regroupement
            </button>
          )}
        </div>
      </section>

      {running && (
        <p className="notice">
          Le directeur lit {running.candidates} fiche(s) et les regroupe ({running.chunks.done}/{running.chunks.total} lot(s))… Cela peut prendre
          quelques minutes.
        </p>
      )}
      {last && last.status === "failed" && <p className="error">Le regroupement a échoué : {last.error}</p>}
      {last && last.status === "done" && !running && (
        <details className="notice small">
          <summary>
            Dernier regroupement : {last.candidates} fiche(s) → {last.proposals.length} proposition(s)
            {last.left_out.length ? `, ${last.left_out.length} laissée(s) de côté` : ""}.
          </summary>
          {last.left_out.length > 0 && (
            <>
              <p>Laissées de côté (toujours dans « À trier ») :</p>
              <ul>
                {last.left_out.map((l) => (
                  <li key={l.id}>
                    {l.id} : {l.reason}
                  </li>
                ))}
              </ul>
            </>
          )}
          {last.corrections.length > 0 && (
            <>
              <p>Corrections faites par le hub sur la réponse du directeur :</p>
              <ul>
                {last.corrections.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
            </>
          )}
        </details>
      )}
      {error && <p className="error">{error}</p>}
      {flash && <p className="notice">{flash}</p>}
      {unsorted > 0 && !running && (
        <div className="notice">
          Ces propositions ont été préparées <strong>avant</strong> la séparation entre décisions de créateur et règles techniques.{" "}
          <button className="link" onClick={redo}>
            Refaire le regroupement
          </button>{" "}
          pour les trier et les réécrire en langage clair (environ 30 centimes, valeur indicative).
        </div>
      )}

      {creative.length > 0 && <h2 className="section-title">Vos décisions de créateur ({creative.length})</h2>}
      {creative.length > 0 && (
        <div className="batch-bar">
          <label className="check">
            <input
              type="checkbox"
              checked={selected.size > 0 && selected.size === creative.length}
              onChange={(e) => setSelected(e.target.checked ? new Set(creative.map((c) => c.proposal.id)) : new Set())}
            />
            Tout cocher
          </label>
          <span className="muted small grow">
            {creative.length} proposition(s) en attente · {selected.size} cochée(s)
          </span>
          <button disabled={!selected.size} onClick={validateSelected}>
            Valider les {selected.size || ""} cochée(s)
          </button>
        </div>
      )}

      {cards.length === 0 && !running && (
        <p className="muted">{pending ? "Aucune proposition pour l'instant : cliquez sur « Préparer des propositions »." : "Rien à décider pour l'instant."}</p>
      )}

      <div className="proposals">
        {creative.map((c) => (
          <Proposal
            key={c.proposal.id}
            slug={slug}
            card={c}
            selected={selected.has(c.proposal.id)}
            onToggle={() => toggle(c.proposal.id)}
            onDone={(msg) => {
              setFlash(msg);
              void refresh();
            }}
            onError={setError}
          />
        ))}
      </div>

      {technical.length > 0 && (
        <details className="card technical-section">
          <summary>
            <strong>Règles techniques existantes ({technical.length})</strong>
            <span className="muted small"> — comment le code est construit aujourd'hui. Pas besoin de les lire en détail.</span>
          </summary>
          <p className="small">
            Elles viennent des documents écrits pour le code (par exemple CLAUDE.md). « En prendre acte » veut dire : c'est l'état actuel, les
            assistants le respectent et ne le changent pas sans raison. Plus tard, c'est l'architecte qui s'en occupera.
          </p>
          <div className="row">
            <button onClick={takeNote}>En prendre acte ({technical.length})</button>
          </div>
          <div className="proposals">
            {technical.map((c) => (
              <Proposal
                key={c.proposal.id}
                slug={slug}
                card={c}
                selected={false}
                onToggle={() => {}}
                onDone={(msg) => {
                  setFlash(msg);
                  void refresh();
                }}
                onError={setError}
              />
            ))}
          </div>
        </details>
      )}
    </main>
  );
}

function Proposal(props: {
  slug: string;
  card: ProposalCard;
  selected: boolean;
  onToggle: () => void;
  onDone: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const { proposal: p, sources, supersedes, hash } = props.card;
  const details = p.proposal!;
  const [editing, setEditing] = useState(false);
  const [statement, setStatement] = useState(p.statement);
  const [title, setTitle] = useState(p.title);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const edited = statement !== p.statement || title !== p.title || excluded.size > 0;
  const fromDocs = sources.filter((s) => s.hint === "existing_decision").length;

  async function act(kind: "approve" | "reject" | "return") {
    setBusy(true);
    try {
      if (kind === "return") {
        await api.returnProposal(props.slug, p.id);
        props.onDone(`« ${p.title} » renvoyée en discussion : ses fiches sont de nouveau à trier.`);
        return;
      }
      if (kind === "reject" && !window.confirm(`Refuser « ${p.title} » ? Ses fiches reviendront au tri.`)) return;
      const edits: DecideEdits = {};
      if (title !== p.title) edits.title = title;
      if (statement !== p.statement) edits.statement = statement;
      if (excluded.size) edits.exclude = [...excluded];
      const res = await api.decide(props.slug, p.id, { hash, verdict: kind === "approve" ? "approved" : "rejected", edits: kind === "approve" ? edits : undefined });
      props.onDone(kind === "approve" ? `Validé : ${res.decision?.id} « ${res.decision?.title} ».` : `« ${p.title} » refusée.`);
    } catch (e) {
      props.onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <article className={`card proposal ${supersedes.length ? "conflict" : ""}`}>
      <div className="proposal-head">
        <label className="check" title={edited ? "Proposition modifiée : validez-la avec son propre bouton" : "Cocher pour une validation groupée"}>
          <input type="checkbox" checked={props.selected} disabled={edited} onChange={props.onToggle} />
        </label>
        {editing ? <input className="grow" value={title} onChange={(e) => setTitle(e.target.value)} /> : <h2 className="grow">{title}</h2>}
        <span className="muted small">{p.id}</span>
      </div>

      {supersedes.length > 0 && (
        <div className="replace">
          <strong>⚠ Contredit une décision déjà validée</strong>
          {supersedes.map((d) => (
            <p key={d.id}>
              Remplacerait <strong>{d.id}</strong> : « {d.statement} »
            </p>
          ))}
          {details.conflict_notes.map((n) => (
            <p key={n} className="small">
              {n}
            </p>
          ))}
        </div>
      )}

      {details.summary && !editing && <p className="summary">{details.summary}</p>}
      {editing ? (
        <textarea rows={Math.min(14, Math.max(4, statement.split("\n").length + 1))} value={statement} onChange={(e) => setStatement(e.target.value)} />
      ) : details.summary ? (
        <details>
          <summary className="small">Voir le détail (règles précises et chiffres)</summary>
          <p className="statement">{statement}</p>
        </details>
      ) : (
        <p className="statement">{statement}</p>
      )}
      {details.rationale && <p className="muted small">{details.rationale}</p>}

      {details.questions.length > 0 && (
        <div className="questions">
          <strong className="small">Questions laissées ouvertes</strong>
          <ul>
            {details.questions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </div>
      )}

      <button className="link small" onClick={() => setOpen((o) => !o)}>
        {open ? "▾" : "▸"} {sources.length} fiche(s) regroupée(s){fromDocs ? ` · dont ${fromDocs} présentée(s) comme déjà décidée(s) dans vos documents` : ""}
        {excluded.size ? ` · ${excluded.size} retirée(s)` : ""}
      </button>
      {open && (
        <ul className="sources">
          {sources.map((s) => (
            <SourceRow
              key={s.id}
              item={s}
              included={!excluded.has(s.id)}
              onToggle={() =>
                setExcluded((x) => {
                  const n = new Set(x);
                  if (n.has(s.id)) n.delete(s.id);
                  else n.add(s.id);
                  return n;
                })
              }
            />
          ))}
        </ul>
      )}

      <div className="row">
        <button onClick={() => act("approve")} disabled={busy || (!!excluded.size && excluded.size === sources.length && statement === p.statement)}>
          {edited ? "Valider ma version" : "Valider"}
        </button>
        <button className="secondary" onClick={() => setEditing((e) => !e)} disabled={busy}>
          {editing ? "Terminer la modification" : "Modifier"}
        </button>
        <button className="secondary" onClick={() => act("return")} disabled={busy}>
          Renvoyer en discussion
        </button>
        <button className="secondary danger" onClick={() => act("reject")} disabled={busy}>
          Refuser
        </button>
        {edited && (
          <button
            className="link small"
            onClick={() => {
              setStatement(p.statement);
              setTitle(p.title);
              setExcluded(new Set());
            }}
          >
            annuler mes modifications
          </button>
        )}
      </div>
    </article>
  );
}

function SourceRow({ item, included, onToggle }: { item: Item; included: boolean; onToggle: () => void }) {
  return (
    <li className={included ? "" : "excluded"}>
      <label className="check" title={included ? "Décocher pour retirer cette fiche du groupe" : "Recocher pour la remettre"}>
        <input type="checkbox" checked={included} onChange={onToggle} />
        <span className={`badge type-${item.type}`}>{TYPE_LABEL[item.type] ?? item.type}</span>
        <span>{item.title}</span>
      </label>
      {item.source.quote && (
        <blockquote>
          « {item.source.quote} »<cite>{item.source.kind === "file" ? item.source.ref : "vous, en discussion"}</cite>
        </blockquote>
      )}
    </li>
  );
}
