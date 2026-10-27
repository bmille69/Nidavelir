import { useCallback, useEffect, useState } from "react";
import { navigate } from "../App.tsx";
import { api, type BalanceState, type MetricStats, type SimSummary } from "../api.ts";

const num = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(Math.abs(v) < 10 ? 2 : 1)).replace(".", ",");

/**
 * L'équilibreur (ADR-86) : le hub joue des centaines de parties sans écran avec les simulations du jeu, montre les
 * distributions et ce qui a bougé depuis le passage précédent, puis les confie au directeur sur votre demande.
 */
export function Balance({ slug }: { slug: string }) {
  const [state, setState] = useState<BalanceState | null>(null);
  const [runs, setRuns] = useState(200);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.balance(slug).then(setState, (e: Error) => setError(e.message)), [slug]);
  useEffect(() => {
    void load();
    const t = setInterval(load, state?.running ? 1500 : 10_000);
    return () => clearInterval(t);
  }, [load, state?.running]);

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

  if (!state) return error ? <p className="error">{error}</p> : <p className="muted">Chargement…</p>;
  if (!state.available) return <p className="muted">L'équilibreur joue les jeux Godot : leurs simulations (tests/sims/sim_*.gd) jouent des parties entières sans écran.</p>;
  const latest = state.latest;
  const before = (s: SimSummary) => state.previous?.sims.find((p) => p.name === s.name) ?? null;
  return (
    <section className="balance" aria-label="Équilibrage">
      <div className="bilan-head">
        <p className="muted small">
          Le hub joue des centaines de parties, une graine de hasard par partie, avec la stratégie de chaque simulation du jeu. Aucun modèle ne joue : ce
          sont des chiffres, comparés au passage précédent.
        </p>
        <span className="bilan-actions">
          <select value={runs} onChange={(e) => setRuns(Number(e.target.value))} aria-label="Nombre de parties">
            {[50, 200, 500, 1000].map((n) => (
              <option key={n} value={n}>
                {n} parties
              </option>
            ))}
          </select>
          <button disabled={busy || state.running} onClick={() => act(async () => setState(await api.balanceRun(slug, runs)))}>
            {state.running ? "Les parties se jouent…" : "Jouer les parties"}
          </button>
        </span>
      </div>
      {!state.hasSims && (
        <p className="small warn">
          Ce jeu n'a pas encore de simulation. Demandez au directeur : « écris une simulation d'équilibrage (tests/sims) qui joue une partie entière et mesure
          la vague atteinte, la victoire et l'or ».
        </p>
      )}
      {error && <p className="error">{error}</p>}
      {latest?.error && <p className="error small">{latest.error}</p>}
      {latest?.status === "done" && (
        <>
          <p className="muted small">
            {latest.runs} parties par simulation · version {latest.commit?.slice(0, 7) ?? "?"} · {latest.at.replace("T", " ").slice(0, 16)}
            {state.previous ? ` · comparé au passage du ${state.previous.at.replace("T", " ").slice(0, 16)}` : ""}
          </p>
          {latest.sims.map((s) => (
            <SimCard key={s.name} sim={s} before={before(s)} />
          ))}
          <div className="balance-send">
            <textarea
              className="small"
              rows={2}
              placeholder="Votre question au directeur (facultatif) : « la vague 7 est un mur, je veux qu'on atteigne la 10 une partie sur deux »"
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
            />
            <button
              className="secondary"
              disabled={busy}
              onClick={() => act(async () => navigate({ page: "project", slug, thread: (await api.balanceSend(slug, latest.id, question)).thread, view: "discussion" }))}
            >
              Demander des réglages au directeur
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function SimCard({ sim, before }: { sim: SimSummary; before: SimSummary | null }) {
  if (sim.error)
    return (
      <article className="sim-card">
        <b>{sim.name}</b> <span className="error small">{sim.error}</span>
      </article>
    );
  return (
    <article className="sim-card">
      <header>
        <b>{sim.name.replace(/^res:\/\/tests\/sims\//, "")}</b>
        <span className="muted small">
          {sim.runs} parties en {num(sim.seconds)} s
        </span>
      </header>
      <div className="sim-metrics">
        {Object.entries(sim.metrics).map(([k, m]) => (
          <Metric key={k} name={k} m={m} was={before?.metrics[k] ?? null} />
        ))}
      </div>
    </article>
  );
}

function Metric({ name, m, was }: { name: string; m: MetricStats; was: MetricStats | null }) {
  if (m.kind === "bool") {
    const delta = was?.kind === "bool" ? Math.round((m.rate - was.rate) * 100) : null;
    return (
      <div className="sim-metric">
        <span className="small">{name}</span>
        <span className="sim-big">{Math.round(m.rate * 100)} %</span>
        <span className="sim-bar">
          <span style={{ width: `${m.rate * 100}%` }} />
        </span>
        {delta !== null && Math.abs(delta) >= 5 && <span className={`small ${delta > 0 ? "up" : "down"}`}>{delta > 0 ? "+" : ""}{delta} points</span>}
      </div>
    );
  }
  if (m.kind === "text") {
    return (
      <div className="sim-metric">
        <span className="small">{name}</span>
        <span className="small">{m.top.map((t) => `${t.value} ${Math.round((t.count / Math.max(1, m.n)) * 100)} %`).join(" · ")}</span>
      </div>
    );
  }
  const top = Math.max(1, ...m.histogram.map((h) => h.count));
  const delta = was?.kind === "number" && was.mean ? Math.round(((m.mean - was.mean) / Math.abs(was.mean)) * 100) : null;
  return (
    <div className="sim-metric">
      <span className="small">{name}</span>
      <span className="sim-big">{num(m.mean)}</span>
      <span className="sim-hist" title={`De ${num(m.min)} à ${num(m.max)} ; 9 parties sur 10 entre ${num(m.p10)} et ${num(m.p90)}`}>
        {m.histogram.map((h, i) => (
          <span key={i} style={{ height: `${Math.max(4, (h.count / top) * 100)}%` }} title={`${num(h.from)} – ${num(h.to)} : ${h.count} partie(s)`} />
        ))}
      </span>
      <span className="muted small">
        {num(m.p10)} – {num(m.p90)}
      </span>
      {delta !== null && Math.abs(delta) >= 10 && <span className={`small ${delta > 0 ? "up" : "down"}`}>{delta > 0 ? "+" : ""}{delta} %</span>}
    </div>
  );
}
