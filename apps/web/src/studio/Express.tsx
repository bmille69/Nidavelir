import { useEffect, useRef, useState } from "react";
import { navigate } from "../App.tsx";
import { api, type ExpressGame, type ExpressMode } from "../api.ts";
import { useNow } from "./context.tsx";
import { Icon } from "./Icon.tsx";

const EXAMPLES = [
  "Un serpent dans l'espace qui mange des étoiles",
  "Un tower defense de chats contre des aspirateurs",
  "Un plateformer où la gravité s'inverse à chaque saut",
  "Une course de vaisseaux en 3D dans un tunnel néon",
];

const MODES: Record<ExpressMode, { label: string; time: string; detail: string }> = {
  eclair: { label: "Éclair", time: "≈ 5 min", detail: "Sonnet : rapide et économe." },
  soigne: { label: "Soigné", time: "≈ 10 min", detail: "Opus, avec une passe de finition." },
};

const STATUS: Record<ExpressGame["status"], string> = { running: "En fabrication", ready: "Jouable", failed: "Échec", cancelled: "Arrêté" };

/** Durée lisible : « 4 min 07 s ». */
function duration(from: string, to: number): string {
  const s = Math.max(0, Math.round((to - Date.parse(from)) / 1000));
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}

/** Le Jeu express (ADR-44) : une idée, quelques minutes, un jeu jouable. Et la galerie des prototypes. */
export function ExpressHome() {
  const [idea, setIdea] = useState("");
  const [mode, setMode] = useState<ExpressMode>("eclair");
  const [games, setGames] = useState<ExpressGame[] | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = () =>
      api.express().then(
        (r) => {
          setGames(r.games);
          setRunning(r.running);
        },
        (e: Error) => setError(e.message),
      );
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => clearInterval(t);
  }, []);

  async function launch() {
    setBusy(true);
    setError(null);
    try {
      const g = await api.expressCreate(idea.trim(), mode);
      navigate({ page: "expressGame", id: g.id });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="studio-page express">
      <header className="studio-hero">
        <div>
          <p className="eyebrow">
            <Icon name="bolt" size={14} /> Jeu express
          </p>
          <h1>Une idée, quelques minutes, un jeu.</h1>
          <p className="hero-sub">Décrivez un jeu en une phrase, ou plus. Le studio l'imagine, le code, le teste, et vous jouez. Ensuite, vous l'améliorez d'un mot ou vous en faites un vrai projet.</p>
        </div>
      </header>

      <section className="panel-card express-form">
        <textarea
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && idea.trim().length >= 3) void launch();
          }}
          rows={3}
          placeholder="Votre idée de jeu…"
          aria-label="Idée de jeu"
        />
        <div className="express-examples">
          {EXAMPLES.map((x) => (
            <button key={x} className="secondary small" onClick={() => setIdea(x)}>
              {x}
            </button>
          ))}
        </div>
        <div className="express-launch">
          <div className="express-modes" role="radiogroup" aria-label="Vitesse">
            {(Object.keys(MODES) as ExpressMode[]).map((m) => (
              <button key={m} role="radio" aria-checked={mode === m} className={`express-mode ${mode === m ? "on" : ""}`} onClick={() => setMode(m)}>
                <strong>
                  {m === "eclair" ? <Icon name="bolt" size={15} /> : <Icon name="sparkle" size={15} />} {MODES[m].label} <span className="muted">{MODES[m].time}</span>
                </strong>
                <span className="small muted">{MODES[m].detail}</span>
              </button>
            ))}
          </div>
          <button className="express-go" disabled={busy || idea.trim().length < 3 || !!running} onClick={() => void launch()}>
            <Icon name="play" size={18} /> {busy ? "Lancement…" : "Lancer"}
          </button>
        </div>
        {running && (
          <p className="small">
            <span className="live-dot" /> Un jeu est en fabrication : <a href={`#/express/${running}`}>le suivre en direct</a>.
          </p>
        )}
        {error && <p className="error small">{error}</p>}
      </section>

      {games && games.length > 0 && (
        <section>
          <div className="section-head">
            <h2>Vos jeux express</h2>
          </div>
          <div className="express-gallery">
            {games.map((g) => (
              <a key={g.id} href={`#/express/${g.id}`} className={`express-tile st-${g.status}`}>
                <div className="express-thumb">{g.shot ? <img src={api.expressShot(g)} alt="" loading="lazy" /> : <Icon name="bolt" size={34} />}</div>
                <strong>{g.title}</strong>
                <span className="muted small">{g.concept?.pitch ?? g.idea}</span>
                <span className={`pill express-status st-${g.status}`}>
                  {STATUS[g.status]}
                  {g.status === "ready" && g.finished_at ? ` · ${duration(g.started_at, Date.parse(g.finished_at))}` : ""}
                  {g.project ? " · projet du studio" : ""}
                </span>
              </a>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}

const STEPS = [
  { key: "idee", label: "Idée" },
  { key: "code", label: "Code" },
  { key: "test", label: "Test" },
  { key: "finition", label: "Finition" },
  { key: "pret", label: "Jouable" },
] as const;
const STEP_OF: Record<ExpressGame["phase"], number> = { idee: 0, code: 1, amelioration: 1, test: 2, correction: 2, finition: 3, pret: 4 };

/** L'écran en direct, pensé pour une démonstration : chronomètre, étapes, fil du développeur, puis le jeu. */
export function ExpressView({ id }: { id: string }) {
  const [g, setG] = useState<ExpressGame | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState("");
  const [busy, setBusy] = useState(false);
  const [playKey, setPlayKey] = useState(0);
  const feed = useRef<HTMLOListElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const now = useNow(g?.status === "running" ? 1000 : 60_000);

  const load = () => api.expressGet(id).then(setG, (e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, [id]);
  const running = g?.status === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => void load(), 1500);
    return () => clearInterval(t);
  }, [running, id]);
  // Une nouvelle version prête : on recharge le jeu.
  useEffect(() => setPlayKey((k) => k + 1), [g?.status === "ready" ? g.finished_at : null]);
  const last = g?.events.at(-1)?.seq ?? 0;
  useEffect(() => {
    const el = feed.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [last]);

  async function act(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!g) return <main className="studio-page muted">{error ?? "Chargement…"}</main>;
  const step = g.status === "ready" ? 4 : STEP_OF[g.phase];
  const steps = STEPS.filter((s) => s.key !== "finition" || g.mode === "soigne");
  const palette = [...new Set(g.concept?.style.match(/#[0-9a-f]{6}\b/gi) ?? [])].slice(0, 6);
  const elapsed = duration(g.started_at, g.finished_at ? Date.parse(g.finished_at) : now);

  return (
    <main className="studio-page express-live">
      <header className="express-head">
        <div className="grow">
          <p className="eyebrow">
            <a href="#/express">Jeu express</a> · {MODES[g.mode].label}
            {g.version > 0 ? ` · version ${g.version + 1}` : ""}
          </p>
          <h1>{g.title}</h1>
          <p className="muted">{g.concept?.pitch ?? g.idea}</p>
        </div>
        <div className={`express-clock ${running ? "on" : ""}`} aria-label="Chronomètre">
          <Icon name="clock" size={18} /> {elapsed}
        </div>
      </header>

      <ol className="express-steps">
        {steps.map((s) => {
          const index = STEP_OF[s.key as ExpressGame["phase"]];
          const state = g.status === "failed" && index === step ? "ko" : index < step || g.status === "ready" ? "done" : index === step && running ? "now" : "";
          return (
            <li key={s.key} className={state}>
              <span className="dot">{state === "done" ? <Icon name="check" size={14} /> : index + 1}</span>
              {s.label}
              {s.key === "test" && g.phase === "correction" && running && <small> (correction)</small>}
              {s.key === "code" && g.phase === "amelioration" && running && <small> (amélioration)</small>}
            </li>
          );
        })}
      </ol>

      <section className="express-stage">
        <div className="express-screen">
          {g.status === "ready" ? (
            <>
              <iframe key={playKey} ref={frame} src={api.expressPlay(g.id)} title={g.title} allow="fullscreen; autoplay; gamepad" />
              <div className="express-screen-actions">
                <button className="small" onClick={() => void frame.current?.requestFullscreen?.()}>
                  <Icon name="play" size={14} /> Plein écran
                </button>
                <a className="small" href={api.expressPlay(g.id)} target="_blank" rel="noreferrer">
                  Ouvrir dans un onglet
                </a>
                <button className="secondary small" onClick={() => setPlayKey((k) => k + 1)}>
                  Recommencer
                </button>
              </div>
            </>
          ) : g.shot ? (
            <img src={api.expressShot(g)} alt="Dernière capture du jeu" />
          ) : (
            <div className="express-forge">
              <Icon name="bolt" size={48} />
              <p>{running ? "Le jeu prend forme…" : "Pas de capture."}</p>
            </div>
          )}
        </div>

        <aside className="express-side">
          {g.concept && (
            <div className="express-card">
              <p className="small">
                <b>{g.concept.dimension === "3d" ? "3D" : "2D"}</b> · {g.concept.genre}
              </p>
              <ul className="small">
                {g.concept.controls.map((c) => (
                  <li key={c}>{c}</li>
                ))}
              </ul>
              {palette.length > 0 && (
                <div className="express-palette" aria-label="Palette du jeu">
                  {palette.map((c) => (
                    <span key={c} style={{ background: c }} title={c} />
                  ))}
                </div>
              )}
            </div>
          )}
          <ol className="express-feed" ref={feed} aria-live="polite">
            {g.events.map((e) => (
              <li key={e.seq} className={`ev-${e.kind}`}>
                {e.kind === "tool" ? <code>{e.text}</code> : e.text}
              </li>
            ))}
          </ol>
        </aside>
      </section>

      {g.status === "ready" && (g.summary || g.how_to_play) && (
        <section className="panel-card">
          {g.how_to_play && (
            <p>
              <b>Comment jouer :</b> {g.how_to_play}
            </p>
          )}
          {g.summary && <p className="muted small">{g.summary}</p>}
        </section>
      )}
      {g.error && g.status !== "running" && <p className="error">{g.error}</p>}
      {error && <p className="error">{error}</p>}

      <section className="express-actions">
        {running ? (
          <button className="secondary" onClick={() => void act(() => api.expressCancel(g.id))}>
            Arrêter
          </button>
        ) : (
          g.concept && (
            <div className="express-improve">
              <textarea
                value={request}
                onChange={(e) => setRequest(e.target.value)}
                rows={2}
                placeholder="Améliorer : « ajoute un boss », « plus rapide », « des couleurs plus chaudes »…"
                aria-label="Amélioration"
              />
              <button
                disabled={busy || request.trim().length < 3}
                onClick={() =>
                  void act(async () => {
                    await api.expressImprove(g.id, request.trim());
                    setRequest("");
                  })
                }
              >
                <Icon name="bolt" size={16} /> Améliorer
              </button>
            </div>
          )
        )}
        {g.status === "ready" &&
          (g.project ? (
            <a className="button-like" href={`#/p/${g.project}`}>
              Ouvrir le projet du studio <Icon name="arrow" size={14} />
            </a>
          ) : (
            <button
              className="secondary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const r = await api.expressPromote(g.id);
                  navigate({ page: "project", slug: r.project, thread: r.thread, view: "discussion" });
                })
              }
            >
              <Icon name="folder" size={16} /> En faire un vrai projet
            </button>
          ))}
        {!running && (
          <button
            className="link small"
            onClick={() =>
              window.confirm("Retirer ce jeu de la galerie ? Son dossier reste dans vos jeux (prototypes/).") &&
              void act(async () => {
                await api.expressHide(g.id);
                navigate({ page: "express" });
              })
            }
          >
            Retirer de la galerie
          </button>
        )}
      </section>
    </main>
  );
}
