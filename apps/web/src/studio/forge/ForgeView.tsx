import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { api, type AgentId, type ForgeSnapshot, type RunEvent, type StudioSnapshot } from "../../api.ts";
import { AgentModel } from "../AgentModel.tsx";
import { AGENTS, since } from "../agents.ts";
import { useNow, useStudio } from "../context.tsx";
import { Icon } from "../Icon.tsx";
import { ACTOR_INFO, dayLight, deriveForge, demoData, hourOf, PHASE_LABEL, type Actor, type ForgeState } from "./model.ts";
import type { ForgeScene } from "./scene.ts";

const reducedMotion = () => document.documentElement.dataset.motion === "reduced";
/** Le cycle accéléré : une journée entière en 36 secondes. */
const FAST_DAY_MS = 36_000;
const MODE_LABEL = { work: "Au travail", wait: "Vous attend", idle: "Au repos" } as const;
const fmtHour = (h: number) => `${String(Math.floor(h)).padStart(2, "0")}:${String(Math.floor((h % 1) * 60)).padStart(2, "0")}`;

/** Interroge la Forge d'un jeu toutes les `ms` (en pause quand l'onglet est caché). */
export function useForge(slug: string | null, ms = 2500): ForgeSnapshot | null {
  const [forge, setForge] = useState<ForgeSnapshot | null>(null);
  useEffect(() => {
    if (!slug) return;
    let alive = true;
    setForge(null);
    const tick = () => {
      if (document.visibilityState === "hidden") return;
      api.forge(slug).then((f) => alive && setForge(f), () => {});
    };
    tick();
    const t = setInterval(tick, ms);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [slug, ms]);
  return forge;
}

/**
 * Le jeu à montrer par défaut : celui qui tourne (le plus d'activité de l'équipe), sinon le premier jeu.
 * Le choix suit l'activité sans sauter d'un jeu à l'autre à chaque rafraîchissement.
 */
export function useBusiestProject(snap: StudioSnapshot | null): string | null {
  const projects = snap?.projects ?? [];
  return useMemo(() => {
    const score = (slug: string) => (snap?.agents ?? []).reduce((n, a) => n + (a.id === "you" ? 0 : a.activities.filter((x) => x.project === slug).length), 0);
    return [...projects].sort((a, b) => score(b.slug) - score(a.slug) || Number(b.busy) - Number(a.busy) || b.waiting - a.waiting)[0]?.slug ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projects.map((p) => `${p.slug}:${p.busy}`).join(","), (snap?.agents ?? []).map((a) => `${a.id}:${a.activities.map((x) => x.project).join("+")}`).join(",")]);
}

/** Un jeu tourne-t-il ? (un agent y travaille, ou le hub le dit occupé) */
export function projectRunning(snap: StudioSnapshot | null, slug: string): boolean {
  if (snap?.projects.find((p) => p.slug === slug)?.busy) return true;
  return (snap?.agents ?? []).some((a) => a.id !== "you" && a.state !== "idle" && a.activities.some((x) => x.project === slug));
}

/** Monte la scène three.js (chargée à la demande) sur un canvas, et lui passe chaque nouvel état. */
export function useForgeScene(opts: { canvas: RefObject<HTMLCanvasElement | null>; overlay?: RefObject<HTMLDivElement | null>; mini?: boolean; state: ForgeState; hour: () => number; onPick?: (id: string | null) => void }) {
  const scene = useRef<ForgeScene | null>(null);
  const stateRef = useRef(opts.state);
  stateRef.current = opts.state;
  const pick = useRef(opts.onPick);
  pick.current = opts.onPick;
  const hour = useRef(opts.hour);
  hour.current = opts.hour;
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    import("./scene.ts")
      .then(({ createForgeScene }) => {
        if (!alive || !opts.canvas.current) return;
        try {
          scene.current = createForgeScene({
            canvas: opts.canvas.current,
            overlay: opts.overlay?.current ?? null,
            mini: opts.mini,
            hour: () => hour.current(),
            reduced: reducedMotion,
            onPick: (id) => pick.current?.(id),
          });
          scene.current.update(stateRef.current);
        } catch (err) {
          setError((err as Error).message || "WebGL indisponible");
        }
      })
      .catch((err: Error) => alive && setError(err.message));
    return () => {
      alive = false;
      scene.current?.dispose();
      scene.current = null;
    };
    // La scène vit autant que le composant ; l'état passe par update().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    scene.current?.update(opts.state);
  }, [opts.state]);
  return { scene, error };
}

/**
 * La Forge (ADR-106) : l'équipe du jeu en voxels, à ses postes. Les états viennent du hub (vue Studio + /forge) ;
 * la mise en scène suit ces états. Un clic sur un nain, un établi, la file, votre table ou le trésor ouvre sa fiche.
 */
export function ForgeView({ slug }: { slug: string }) {
  const snap = useStudio();
  const real = useForge(slug || null);
  const now = useNow(1000);
  const [demo, setDemo] = useState(false);
  const [fast, setFast] = useState<number | null>(null);
  const [selected, setSelectedRaw] = useState<string | null>(null);
  // Le panneau glisse par-dessus la scène, à droite : la Forge garde toute la largeur tant qu'on ne l'ouvre pas.
  const [panel, setPanel] = useState(false);
  const setSelected = (id: string | null) => {
    setSelectedRaw(id);
    if (id) setPanel(true);
  };
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLDivElement>(null);

  const name = snap?.projects.find((p) => p.slug === slug)?.name ?? real?.project.name ?? slug;
  const fake = demo ? demoData(slug, name, now) : null;
  const state = useMemo(() => (fake ? deriveForge(slug, fake.snap, fake.forge, true) : deriveForge(slug, snap, real)), [slug, snap, real, demo, demo ? now : 0]);

  const fastRef = useRef(fast);
  fastRef.current = fast;
  const hour = () => {
    const f = fastRef.current;
    if (f === null) return hourOf(new Date());
    return (hourOf(new Date(f)) + ((Date.now() - f) / FAST_DAY_MS) * 24) % 24;
  };
  const { scene, error } = useForgeScene({ canvas, overlay, state, hour, onPick: setSelected });
  useEffect(() => scene.current?.select(selected), [selected, scene]);
  const light = dayLight(hour());

  const working = state.actors.filter((a) => a.mode === "work").length;
  const waiting = state.actors.filter((a) => a.mode === "wait").length;
  const forYou = state.review.length + state.escalations.length;

  return (
    <div className={`forge-page ${panel ? "panel-open" : ""}`}>
      <div className="forge-stage">
        <canvas ref={canvas} className="forge-canvas" aria-label="La Forge : l'équipe du jeu en voxels" />
        <div ref={overlay} className="forge-overlay" aria-hidden="true" />
        <div className="forge-toolbar">
          <span className={`forge-clock ${light.night ? "night" : ""}`} title="L'éclairage suit l'heure">
            <Icon name="clock" size={14} /> {fmtHour(light.hour)} · {light.label}
          </span>
          <span className="forge-count">
            <i className="dot work" /> {working} au travail
          </span>
          {waiting > 0 && (
            <span className="forge-count">
              <i className="dot wait" /> {waiting} vous attend{waiting > 1 ? "ent" : ""}
            </span>
          )}
          {forYou > 0 && (
            <button className="forge-count forge-for-you" onClick={() => setSelected("table")}>
              <i className="dot wait" /> {forYou} pour vous
            </button>
          )}
          <span className="forge-spacer" />
          <button className={`forge-btn ${fast !== null ? "on" : ""}`} onClick={() => setFast(fast === null ? Date.now() : null)} disabled={reducedMotion()} title="Une journée en 36 secondes">
            {fast !== null ? "Revenir à l'heure réelle" : "Cycle jour / nuit accéléré"}
          </button>
          <button className={`forge-btn ${demo ? "on" : ""}`} onClick={() => (setDemo(!demo), setSelected(null))} title="Une minute de studio imaginaire, pour voir la Forge s'animer">
            {demo ? "Quitter la démo" : "Démo"}
          </button>
          <button className="forge-btn" onClick={() => scene.current?.resetView()} title="Revenir à la vue de départ">
            Recentrer
          </button>
          <button className={`forge-btn ${panel ? "on" : ""}`} onClick={() => (panel ? (setPanel(false), setSelectedRaw(null)) : setPanel(true))} aria-expanded={panel} title="L'équipe, les établis, la file et le trésor">
            <Icon name="users" size={14} /> {panel ? "Fermer le panneau" : "L'équipe"}
          </button>
        </div>
        {demo && <div className="forge-demo">Démonstration : données imaginaires, rien ne tourne vraiment.</div>}
        {error && (
          <div className="forge-error">
            <p>La Forge ne peut pas s'afficher ici ({error}).</p>
            <p className="muted small">Elle a besoin de WebGL (la carte graphique). Les chantiers restent visibles dans l'onglet Chantiers.</p>
          </div>
        )}
        <p className="forge-hint muted small">Glisser pour tourner · molette pour zoomer · survol pour les noms · clic pour la fiche</p>
        {/* Sans WebGL, le panneau reste ouvert : c'est alors la seule vue de l'équipe. */}
        {(panel || error) && (
          <div className="forge-drawer">
            <button className="forge-close" onClick={() => (setPanel(false), setSelectedRaw(null))} aria-label="Fermer le panneau" title="Fermer">
              <Icon name="close" size={15} />
            </button>
            <ForgePanel slug={slug} state={state} selected={selected} onSelect={setSelected} now={now} snap={snap} />
          </div>
        )}
      </div>
    </div>
  );
}

function Mode({ actor }: { actor: Actor }) {
  return <span className={`forge-mode ${actor.mode}`}>{MODE_LABEL[actor.mode]}</span>;
}

function BenchDetail({ slug, state, index, now }: { slug: string; state: ForgeState; index: number; now: number }) {
  const b = state.benches[index]?.data ?? null;
  const [events, setEvents] = useState<RunEvent[]>([]);
  const runId = b?.run?.id;
  const taskId = b?.task.id;
  useEffect(() => {
    setEvents([]);
    if (!runId || !taskId || state.demo) return;
    let alive = true;
    const tick = () =>
      api.runEvents(slug, taskId, runId, 0).then(
        (e) => alive && setEvents(e.filter((x) => x.type !== "info").slice(-6)),
        () => {},
      );
    tick();
    const t = setInterval(tick, 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [slug, runId, taskId, state.demo]);
  if (!b) return <p className="muted">Établi {index + 1} libre : aucun chantier posé dessus.</p>;
  return (
    <div className="forge-bench">
      <a className="forge-task" href={`#/p/${slug}/tasks/${b.task.id}`}>
        <b>{b.task.id}</b> {b.task.title}
      </a>
      <p>
        <span className={`forge-mode ${b.phase === "review" || b.phase === "plan_review" ? "wait" : "work"}`}>{PHASE_LABEL[b.phase]}</span> <span className="muted small">{since(b.since, now)}</span>
      </p>
      {state.escalations
        .filter((e) => e.task === b.task.id)
        .map((e) => (
          <p key={e.id} className="forge-alert">
            Le Gardien bloque : {e.summary}. <a href={`#/p/${slug}/tasks/${b.task.id}`}>Autoriser ou refuser</a>
          </p>
        ))}
      {b.note && (
        <p className="small">
          <span className="muted">Chef de chantier : </span>
          {b.note}
        </p>
      )}
      {b.files.length > 0 && (
        <details>
          <summary className="small">Fichiers prévus ({b.files.length})</summary>
          <ul className="forge-files">
            {b.files.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </details>
      )}
      {(events.length > 0 || b.run?.last) && (
        <div className="forge-log">
          <span className="muted small">Dernières actions</span>
          {(events.length ? events : b.run?.last ? [{ seq: 0, at: b.run.last.at, type: b.run.last.type, text: b.run.last.text }] : []).map((e) => (
            <code key={`${e.seq}-${e.at}`}>{e.text.slice(0, 160)}</code>
          ))}
        </div>
      )}
    </div>
  );
}

/** Les agents qui ont un modèle réglable (ADR-37) ; le chef de chantier n'en a pas à lui. */
const MODEL_AGENTS = new Set<string>(["director", "concepteur", "art_director", "archivist", "developer", "qa", "guardian"]);

function ForgePanel({ slug, state, selected, onSelect, now, snap }: { slug: string; state: ForgeState; selected: string | null; onSelect: (id: string | null) => void; now: number; snap: StudioSnapshot | null }) {
  const back = (
    <button className="forge-back" onClick={() => onSelect(null)}>
      ← Toute la Forge
    </button>
  );
  if (selected?.startsWith("actor:")) {
    const a = state.actors.find((x) => x.id === selected.slice(6));
    if (a) {
      const agentId = a.kind === "foreman" ? null : a.kind;
      return (
        <aside className="forge-panel">
          {back}
          <header className="forge-who">
            <i className="forge-swatch" style={{ background: ACTOR_INFO[a.kind].color }} />
            <div>
              <h3>{a.name}</h3>
              <span className="muted small">{a.kind === "developer" ? ACTOR_INFO.developer.role : agentId ? AGENTS[agentId].role : ACTOR_INFO.foreman.role}</span>
            </div>
            <Mode actor={a} />
          </header>
          {a.line && <p>{a.line}</p>}
          {a.kind === "developer" && a.bench !== undefined && <BenchDetail slug={slug} state={state} index={a.bench} now={now} />}
          {a.kind === "foreman" && (
            <p className="muted small">
              Il lit chaque chantier en file et devine les fichiers qu'il touchera : deux chantiers sans fichier commun partent en même temps sur deux établis ({state.parallel} sur ce jeu).
            </p>
          )}
          {a.kind === "guardian" && state.escalations.length > 0 && (
            <ul className="forge-list">
              {state.escalations.map((e) => (
                <li key={e.id}>
                  <a href={`#/p/${slug}/tasks/${e.task}`}>
                    {e.task} : {e.summary}
                  </a>
                </li>
              ))}
            </ul>
          )}
          {a.kind !== "developer" && a.acts.length > 0 && (
            <ul className="forge-list">
              {a.acts.map((x, k) => (
                <li key={k}>
                  <a href={x.href}>{x.text}</a>
                  {x.detail && <span className="muted small"> {x.detail}</span>}
                  {x.since && <span className="muted small"> · {since(x.since, now)}</span>}
                </li>
              ))}
            </ul>
          )}
          {a.mode === "idle" && <p className="muted small">{agentId ? AGENTS[agentId].idle : "Rien à répartir pour l'instant."} Il se repose au foyer.</p>}
          {/* Son modèle et sa consommation (ADR-37), réglables ici depuis que « En direct » a laissé place à la Forge. */}
          {snap && MODEL_AGENTS.has(a.kind) && (
            <div className="forge-model">
              <AgentModel agent={a.kind as AgentId} snap={snap} />
            </div>
          )}
        </aside>
      );
    }
  }
  if (selected?.startsWith("bench:")) {
    const i = Number(selected.slice(6));
    return (
      <aside className="forge-panel">
        {back}
        <h3>Établi {i + 1}</h3>
        <BenchDetail slug={slug} state={state} index={i} now={now} />
      </aside>
    );
  }
  if (selected === "queue")
    return (
      <aside className="forge-panel">
        {back}
        <h3>La file · {state.queue.length}</h3>
        {state.queue.length === 0 ? (
          <p className="muted">Aucun chantier n'attend.</p>
        ) : (
          <ol className="forge-list">
            {state.queue.map((q) => (
              <li key={q.id}>
                <a href={`#/p/${slug}/tasks/${q.id}`}>
                  <b>{q.id}</b> {q.title}
                </a>
                <span className="muted small"> {q.waiting}</span>
              </li>
            ))}
          </ol>
        )}
      </aside>
    );
  if (selected === "table")
    return (
      <aside className="forge-panel">
        {back}
        <h3>Votre table</h3>
        {state.review.length + state.escalations.length === 0 ? <p className="muted">Rien ne vous attend ici.</p> : null}
        <ul className="forge-list">
          {state.review.map((r) => (
            <li key={r.id}>
              <a href={`#/p/${slug}/tasks/${r.id}`}>
                <b>{r.id}</b> {r.title}
              </a>
              <span className="muted small"> {r.kind === "plan" ? "le plan attend votre accord" : "attend votre mot (« fusionne », à corriger…)"}</span>
            </li>
          ))}
          {state.escalations.map((e) => (
            <li key={e.id}>
              <a href={`#/p/${slug}/tasks/${e.task}`}>
                <b>{e.task}</b> autoriser ou refuser : {e.summary}
              </a>
            </li>
          ))}
        </ul>
      </aside>
    );
  if (selected === "vault")
    return (
      <aside className="forge-panel">
        {back}
        <h3>Le trésor</h3>
        <p className="muted small">La version du jeu. Chaque chantier fusionné y arrive en wagonnet.</p>
        <p>
          <b>{state.today.merged}</b> fusion{state.today.merged > 1 ? "s" : ""} aujourd'hui{state.today.failed ? ` · ${state.today.failed} en échec` : ""}
        </p>
        <ul className="forge-list">
          {state.merged.map((m) => (
            <li key={m.id}>
              <a href={`#/p/${slug}/tasks/${m.id}`}>
                <b>{m.id}</b> {m.title}
              </a>
              <span className="muted small"> · {since(m.at, now).replace("depuis", "il y a")}</span>
            </li>
          ))}
        </ul>
      </aside>
    );

  // Vue d'ensemble.
  const busy = state.benches.filter((b) => b.data).length;
  return (
    <aside className="forge-panel">
      <h3>L'équipe</h3>
      <ul className="forge-team">
        {state.actors.map((a) => (
          <li key={a.id}>
            <button onClick={() => onSelect(`actor:${a.id}`)} data-actor={a.kind} data-mode={a.mode}>
              <i className="forge-swatch" style={{ background: ACTOR_INFO[a.kind].color }} />
              <span>
                <b>{a.name}</b>
                <small className="muted">{a.line ?? MODE_LABEL[a.mode]}</small>
              </span>
              <i className={`dot ${a.mode}`} />
            </button>
          </li>
        ))}
      </ul>
      <h3>
        Les forges · {busy}/{state.benches.length}
      </h3>
      <ul className="forge-list">
        {state.benches.map((b) => (
          <li key={b.index}>
            <button className="forge-link" onClick={() => onSelect(`bench:${b.index}`)}>
              Établi {b.index + 1} : {b.data ? `${b.data.task.id} « ${b.data.task.title} » · ${PHASE_LABEL[b.data.phase]}` : "libre"}
            </button>
          </li>
        ))}
      </ul>
      <p className="small">
        <button className="forge-link" onClick={() => onSelect("queue")}>
          File : {state.queue.length ? `${state.queue.length} chantier(s) · ${state.queue[0]!.waiting}` : "vide"}
        </button>
      </p>
      <p className="small">
        <button className="forge-link" onClick={() => onSelect("table")}>
          Pour vous : {state.review.length + state.escalations.length}
        </button>
        {" · "}
        <button className="forge-link" onClick={() => onSelect("vault")}>
          Trésor : {state.today.merged} fusion(s) aujourd'hui
        </button>
      </p>
      {state.pool.max > 0 && (
        <p className="muted small">
          Agents du studio, tous jeux confondus : {state.pool.busy}/{state.pool.max}
          {state.pool.waiting ? ` · ${state.pool.waiting} attendent une place` : ""}
        </p>
      )}
    </aside>
  );
}
