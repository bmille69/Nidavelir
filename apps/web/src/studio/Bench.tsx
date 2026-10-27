import { useCallback, useEffect, useState } from "react";
import { api, type BenchCase, type BenchResult, type BenchRun, type BenchState } from "../api.ts";

const usd = (v: number | null) => (v === null ? "—" : `${v.toFixed(2).replace(".", ",")} $`);
const dur = (s: number | null) => (s === null ? "—" : s < 90 ? `${s} s` : `${Math.round(s / 60)} min`);
const mark = (s: string | null) => (s === "pass" ? "✓" : s === "fail" ? "✗" : "·");

/**
 * Le banc d'essai des agents (ADR-87) : des chantiers fusionnés de référence, refaits par le développeur actuel depuis
 * leur point de départ, dans une copie jetable. Rejoué quand le modèle ou les consignes changent.
 */
export function Bench({ slug }: { slug: string }) {
  const [state, setState] = useState<BenchState | null>(null);
  const [pick, setPick] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.bench(slug).then(setState, (e: Error) => setError(e.message)), [slug]);
  useEffect(() => {
    void load();
    const t = setInterval(load, state?.running ? 3000 : 15_000);
    return () => clearInterval(t);
  }, [load, state?.running]);
  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await run();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!state) return error ? <p className="error">{error}</p> : <p className="muted">Chargement…</p>;
  const [latest, ...older] = state.runs;
  const previous = older.find((r) => r.status === "done") ?? null;
  return (
    <section className="balance" aria-label="Banc d'essai">
      <div className="bilan-head">
        <p className="muted small">
          Des chantiers déjà fusionnés servent de référence. Le hub refait leur consigne depuis leur point de départ, dans une copie jetable, avec le
          développeur actuel, puis lance tests et jeu. Rien n'est fusionné ; chaque passage coûte autant que ces chantiers.
        </p>
        <span className="bilan-actions">
          <button disabled={busy || state.running || !state.cases.length} onClick={() => act(() => api.benchRun(slug))}>
            {state.running ? "Le banc tourne…" : "Passer le banc"}
          </button>
        </span>
      </div>
      <p className={`small ${state.stale ? "warn" : "muted"}`}>
        Développeur : {state.executor} · empreinte {state.fingerprint}
        {state.stale ? " — modèle ou consignes changés depuis le dernier passage : le banc n'est plus à jour." : ""}
      </p>
      {error && <p className="error">{error}</p>}
      <table className="bench-table">
        <thead>
          <tr>
            <th>Chantier de référence</th>
            <th>À l'origine</th>
            {latest && <th>Passage du {latest.at.slice(0, 16).replace("T", " ")}{latest.status === "running" ? " (en cours)" : ""}</th>}
            {previous && <th>Passage précédent</th>}
            <th />
          </tr>
        </thead>
        <tbody>
          {state.cases.map((c) => (
            <CaseRow key={c.id} c={c} latest={latest} previous={previous} onRemove={() => act(() => api.benchRemove(slug, c.id))} busy={busy || state.running} />
          ))}
          {latest && (
            <tr className="bench-total">
              <td>Total</td>
              <td>{usd(sum(state.cases.map((c) => c.original.costUsd)))}</td>
              <td>{total(latest)}</td>
              {previous && <td>{total(previous)}</td>}
              <td />
            </tr>
          )}
        </tbody>
      </table>
      {state.cases.length < 8 && state.candidates.length > 0 && (
        <span className="bilan-actions">
          <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Chantier à ajouter">
            <option value="">Ajouter un chantier fusionné…</option>
            {state.candidates.map((t) => (
              <option key={t.id} value={t.id}>
                {t.id} — {t.title}
              </option>
            ))}
          </select>
          <button className="secondary" disabled={busy || !pick} onClick={() => act(async () => (await api.benchAdd(slug, pick), setPick("")))}>
            Ajouter au banc
          </button>
        </span>
      )}
    </section>
  );
}

const sum = (xs: (number | null)[]) => (xs.some((x) => x !== null) ? xs.reduce<number>((a, b) => a + (b ?? 0), 0) : null);
const total = (r: BenchRun) => `${r.results.filter((x) => x.ok).length}/${r.results.length} réussis · ${usd(sum(r.results.map((x) => x.costUsd)))} · ${dur(r.results.reduce((a, x) => a + x.seconds, 0))}`;

function CaseRow({ c, latest, previous, onRemove, busy }: { c: BenchCase; latest?: BenchRun; previous: BenchRun | null; onRemove: () => void; busy: boolean }) {
  return (
    <tr>
      <td title={c.goal}>
        <b>{c.source}</b> {c.title}
      </td>
      <td className="small">
        {usd(c.original.costUsd)} · {dur(c.original.seconds)}
      </td>
      {latest && <Cell r={latest.results.find((x) => x.case === c.id)} running={latest.status === "running"} />}
      {previous && <Cell r={previous.results.find((x) => x.case === c.id)} running={false} />}
      <td>
        <button className="link small" disabled={busy} onClick={onRemove}>
          Retirer
        </button>
      </td>
    </tr>
  );
}

function Cell({ r, running }: { r?: BenchResult; running: boolean }) {
  if (!r) return <td className="muted small">{running ? "en attente…" : "—"}</td>;
  return (
    <td className="small" title={[r.summary, r.error].filter(Boolean).join("\n")}>
      <span className={r.ok ? "ok" : "warn"}>{r.ok ? "✓ réussi" : "✗ raté"}</span> · tests {mark(r.tests)} jeu {mark(r.launch)}
      {r.replays && r.replays !== "none" ? ` parties ${mark(r.replays)}` : ""} · {usd(r.costUsd)} · {dur(r.seconds)} · {r.files} fichier(s)
      {r.error && <div className="error">{r.error}</div>}
    </td>
  );
}
