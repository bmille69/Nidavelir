import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { api, type Consultation, type StudioMemoryEntry } from "../api.ts";
import { ago } from "./agents.ts";
import { useNow, useStudio } from "./context.tsx";
import { TEAM_LABELS } from "./TeamCards.tsx";
import { Markdown } from "./Conception.tsx";

const stagger = (i: number) => ({ "--i": i }) as CSSProperties;
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const BY: Record<string, string> = { human: "Vous", ...TEAM_LABELS };

/**
 * La mémoire du studio et l'équipe (ADR-98, ADR-99) : ce que vous avez appris à vos agents, valable pour tous vos jeux,
 * et les derniers échanges entre eux. Les agents proposent ; rien n'entre sans votre clic.
 */
export function MemoryView() {
  const snap = useStudio();
  const now = useNow(30_000);
  const [memory, setMemory] = useState<StudioMemoryEntry[]>([]);
  const [consults, setConsults] = useState<Consultation[]>([]);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const names = new Map((snap?.projects ?? []).map((p) => [p.slug, p.name]));

  const load = useCallback(async () => {
    const [m, c] = await Promise.all([api.memory(), api.consultations("*")]);
    setMemory(m);
    setConsults(c);
  }, []);
  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
  }, [load, snap?.at]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const proposed = memory.filter((m) => m.status === "proposed");
  const active = memory.filter((m) => m.status === "active");

  return (
    <main className="studio-page memory-page">
      <header className="studio-hero">
        <div>
          <h1>Mémoire et équipe</h1>
          <p className="hero-sub">
            Ce que vous avez appris à vos agents : vos goûts, vos refus, vos règles. Chaque agent le lit avant de travailler, sur tous vos jeux. Quand vous exprimez une préférence durable, un agent vous propose de la retenir ; vous gardez ou non, d'un clic.
          </p>
        </div>
      </header>
      {error && <p className="error">{error}</p>}

      <section className="kpis">
        <div className="stat kpi">
          <span>Souvenirs gardés</span>
          <b>{active.length}</b>
          <span className="kpi-hint">lus par toute l'équipe</span>
        </div>
        <div className="stat kpi">
          <span>À décider</span>
          <b>{proposed.length}</b>
          <span className="kpi-hint">proposés par les agents</span>
        </div>
        <div className="stat kpi" title="Un agent demande l'avis d'un collègue pendant qu'il vous répond.">
          <span>Consultations entre agents</span>
          <b>{consults.length}</b>
          <span className="kpi-hint">{consults[0] ? `dernière ${ago(consults[0].at, now)}` : "aucune pour l'instant"}</span>
        </div>
      </section>

      {proposed.length > 0 && (
        <section className="panel-card memory-proposed">
          <h2>Proposés par l'équipe</h2>
          <ul className="memory-list">
            {proposed.map((m, k) => (
              <li key={m.id} style={stagger(k)}>
                <div className="grow">
                  <p>« {m.text} »</p>
                  <span className="muted small">
                    {cap(BY[m.by] ?? m.by)}
                    {m.project ? ` · ${names.get(m.project) ?? m.project}` : ""} · {ago(m.created_at, now)}
                    {m.reason ? ` · ${m.reason}` : ""}
                  </span>
                </div>
                <div className="row">
                  <button className="small" onClick={() => void act(() => api.decideMemory(m.id, true))}>
                    Garder
                  </button>
                  <button className="small secondary" onClick={() => void act(() => api.decideMemory(m.id, false))}>
                    Non
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="panel-card">
        <h2>La mémoire du studio</h2>
        <form
          className="memory-add"
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.trim()) return;
            void act(async () => {
              await api.addMemory(draft.trim());
              setDraft("");
            });
          }}
        >
          <input value={draft} maxLength={400} onChange={(e) => setDraft(e.target.value)} placeholder="Ex. : Jamais de rendu photoréaliste ; toujours un style marqué et lisible." />
          <button type="submit" disabled={!draft.trim()}>
            Ajouter
          </button>
        </form>
        {active.length === 0 && <p className="muted small">Rien encore. Écrivez une règle ci-dessus, ou laissez vos agents vous en proposer au fil des discussions.</p>}
        <ul className="memory-list">
          {active.map((m, k) => (
            <MemoryRow key={m.id} memory={m} index={k} act={act} by={cap(BY[m.by] ?? m.by)} when={ago(m.decided_at ?? m.created_at, now)} />
          ))}
        </ul>
      </section>

      <section className="panel-card">
        <h2>Les échanges de l'équipe</h2>
        <p className="muted small">Quand un agent a besoin de l'avis d'un collègue (le DA du Concepteur, le directeur du Testeur…), il le consulte pendant sa réponse. Chaque échange est aussi montré, replié, dans la discussion où il a eu lieu.</p>
        {consults.length === 0 && <p className="muted small">Aucune consultation pour l'instant.</p>}
        <div className="team-cards">
          {consults.map((c) => (
            <details key={c.id} className={`team-consult ${c.status === "ok" ? "" : "failed"}`}>
              <summary>
                <span className="team-pair" aria-hidden="true">
                  <i className={`team-dot agent-${c.from}`} />
                  <i className="team-link" />
                  <i className={`team-dot agent-${c.to}`} />
                </span>
                <span className="team-who">
                  {cap(TEAM_LABELS[c.from])} a consulté <b>{TEAM_LABELS[c.to]}</b>
                </span>
                <span className="team-question">{c.question}</span>
                <span className="muted small team-when">
                  {c.project ? `${names.get(c.project) ?? c.project} · ` : ""}
                  {ago(c.at, now)}
                </span>
              </summary>
              <div className="team-answer">
                <div className="team-a">
                  <span className="muted small">{c.status === "ok" ? `${cap(TEAM_LABELS[c.to])} répond` : "Pas de réponse"}</span>
                  <div className="text small md">
                    <Markdown text={c.answer} />
                  </div>
                </div>
              </div>
            </details>
          ))}
        </div>
      </section>
    </main>
  );
}

function MemoryRow({ memory: m, index, act, by, when }: { memory: StudioMemoryEntry; index: number; act: (fn: () => Promise<unknown>) => Promise<void>; by: string; when: string }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(m.text);
  return (
    <li style={stagger(index)}>
      <div className="grow">
        {editing ? (
          <input value={text} maxLength={400} onChange={(e) => setText(e.target.value)} autoFocus />
        ) : (
          <p>{m.text}</p>
        )}
        <span className="muted small">
          {by} · {when}
        </span>
      </div>
      <div className="row">
        {editing ? (
          <>
            <button
              className="small"
              onClick={() =>
                void act(async () => {
                  await api.editMemory(m.id, text);
                  setEditing(false);
                })
              }
            >
              Enregistrer
            </button>
            <button className="small secondary" onClick={() => (setEditing(false), setText(m.text))}>
              Annuler
            </button>
          </>
        ) : (
          <>
            <button className="small secondary" onClick={() => setEditing(true)}>
              Modifier
            </button>
            <button className="small secondary" onClick={() => void act(() => api.deleteMemory(m.id))}>
              Oublier
            </button>
          </>
        )}
      </div>
    </li>
  );
}
