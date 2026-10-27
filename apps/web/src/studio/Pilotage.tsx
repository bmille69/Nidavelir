import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type ArtAsset, type ArtState, type Monitor, type TaskRow } from "../api.ts";
import { STATUS } from "./ArtDirection.tsx";
import { useNow, useStudio } from "./context.tsx";
import { Balance } from "./Balance.tsx";
import { Bench } from "./Bench.tsx";
import { Bilan } from "./Bilan.tsx";
import { Gallery } from "./Gallery.tsx";

const LAST_PROJECT = "studio:last-project";
type View = "production" | "galerie" | "bilan" | "equilibrage" | "banc";
const STAGE: Record<string, string> = { croquis: "Croquis", image: "Image", planche: "Planche 4 vues", tripo: "Tripo (3D)", atelier: "Atelier Blender", controle: "Contrôle" };
const hm = (iso: string) => new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
const usd = (n: number) => `${n.toFixed(2).replace(".", ",")} $`;
const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace(".", ",")} M` : n >= 1000 ? `${Math.round(n / 1000)} k` : String(n));

/** Interroge `load` toutes les `ms`, en pause quand l'onglet est caché (même règle que l'instantané du studio). */
function usePoll<T>(load: () => Promise<T>, ms: number, key: string): T | null {
  const [value, setValue] = useState<T | null>(null);
  useEffect(() => {
    let alive = true;
    setValue(null);
    const run = () => {
      if (document.visibilityState === "hidden") return;
      load().then((v) => alive && setValue(v), () => {});
    };
    run();
    const t = setInterval(run, ms);
    document.addEventListener("visibilitychange", run);
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener("visibilitychange", run);
    };
  }, [key, ms]);
  return value;
}

/**
 * Le poste de pilotage : d'un coup d'œil, ce que fait le studio sur un projet. Les chantiers (celui en cours avec sa barre
 * de progression, la file), les visuels du Directeur artistique (en fabrication, en file, en attente d'un chantier), les
 * liens entre les deux, la galerie des assets et le bilan des visuels dans le jeu (ADR-71). Rien ici n'appelle un modèle : des lectures de l'état du hub.
 */
export function Pilotage() {
  const snap = useStudio();
  const projects = snap?.projects ?? [];
  const [slug, setSlug] = useState<string | null>(() => {
    try {
      return localStorage.getItem(LAST_PROJECT);
    } catch {
      return null;
    }
  });
  const current = projects.find((p) => p.slug === slug) ?? projects[0] ?? null;
  const [view, setView] = useState<View>("production");
  if (!snap) return <div className="centered muted">Chargement…</div>;
  if (!current) return <div className="page pilot"><p className="muted">Aucun projet pour l'instant.</p></div>;
  return (
    <div className="page pilot">
      <header className="pilot-head">
        <div>
          <p className="eyebrow">Pilotage</p>
          <h1>{current.name}</h1>
        </div>
        <div className="pilot-head-tools">
          {projects.length > 1 && (
            <select className="pilot-select" value={current.slug} onChange={(e) => setSlug(e.target.value)} aria-label="Projet">
              {projects.map((p) => (
                <option key={p.slug} value={p.slug}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <div className="segmented" role="tablist">
            <button role="tab" aria-selected={view === "production"} className={view === "production" ? "on" : ""} onClick={() => setView("production")}>
              Production
            </button>
            <button role="tab" aria-selected={view === "galerie"} className={view === "galerie" ? "on" : ""} onClick={() => setView("galerie")}>
              Galerie
            </button>
            <button role="tab" aria-selected={view === "bilan"} className={view === "bilan" ? "on" : ""} onClick={() => setView("bilan")}>
              Bilan
            </button>
            <button role="tab" aria-selected={view === "equilibrage"} className={view === "equilibrage" ? "on" : ""} onClick={() => setView("equilibrage")}>
              Équilibrage
            </button>
            <button role="tab" aria-selected={view === "banc"} className={view === "banc" ? "on" : ""} onClick={() => setView("banc")}>
              Banc d'essai
            </button>
          </div>
        </div>
      </header>
      <ProjectPilot key={current.slug} slug={current.slug} view={view} />
    </div>
  );
}

function ProjectPilot({ slug, view }: { slug: string; view: View }) {
  const snap = useStudio();
  const tasks = usePoll(() => api.tasks(slug), 4000, `t-${slug}`);
  const art = usePoll(() => api.art(slug), 4000, `a-${slug}`);
  const monitor = usePoll(() => api.monitor(), 5000, "m");
  const forYou = (snap?.agents.find((a) => a.id === "you")?.activities ?? []).filter((a) => a.project === slug);
  return (
    <>
      <StatusStrip slug={slug} monitor={monitor} />
      {forYou.length > 0 && (
        <section className="pilot-foryou" aria-label="À vous de jouer">
          {forYou.map((a, k) => (
            <a key={k} className="pilot-foryou-card" href={a.href}>
              <span className="dot warn" /> {a.text}
            </a>
          ))}
        </section>
      )}
      {view === "banc" ? (
        <Bench slug={slug} />
      ) : view === "equilibrage" ? (
        <Balance slug={slug} />
      ) : view === "bilan" ? (
        <Bilan slug={slug} />
      ) : view === "galerie" ? (
        art && tasks ? <Gallery slug={slug} art={art} tasks={tasks} /> : <p className="muted">Chargement…</p>
      ) : (
        <Production slug={slug} tasks={tasks} art={art} />
      )}
    </>
  );
}

/** Une ligne : la file (en cours, en pause jusqu'à quand), la jauge des 5 h et la consommation du quart d'heure. */
function StatusStrip({ slug, monitor }: { slug: string; monitor: Monitor | null }) {
  const snap = useStudio();
  const five = snap?.usage.limits?.windows.five_hour;
  const q = monitor?.queues.find((x) => x.project === slug);
  const pct = five ? Math.round(five.utilization * 100) : null;
  return (
    <div className={`pilot-strip ${q?.paused ? "paused" : ""}`}>
      <span className="pilot-strip-main">
        {q?.paused ? (
          <>
            <span className="dot warn" /> File en pause, reprise seule à {hm(q.paused.until)}
          </>
        ) : q?.running ? (
          <>
            <span className="dot live" /> Au travail
          </>
        ) : (
          <>
            <span className="dot" /> Au repos
          </>
        )}
        {q && q.queued > 0 && <span className="muted"> · {q.queued} en file</span>}
      </span>
      {pct !== null && (
        <span className="pilot-gauge" title={`Jauge des 5 h : ${pct} %${five ? `, remise à zéro à ${hm(five.resetsAt)}` : ""}`}>
          5 h <span className="bar"><span className={pct >= 85 ? "hot" : pct >= 60 ? "warm" : ""} style={{ width: `${pct}%` }} /></span> {pct} %
        </span>
      )}
      {monitor && (
        <span className="muted">
          15 min : {fmtTokens(monitor.tokens.last15.tokens)} jetons · {usd(monitor.tokens.last15.costUsd)}
        </span>
      )}
    </div>
  );
}

/** La passe « game feel » à la demande (ADR-88) : un chantier qui ne touche qu'à la sensation, jamais aux règles. */
function FeelPass({ slug }: { slug: string }) {
  const [open, setOpen] = useState(false);
  const [moments, setMoments] = useState("");
  const [intensity, setIntensity] = useState<"discret" | "marque" | "genereux">("marque");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; href?: string } | null>(null);
  if (!open)
    return (
      <button className="small secondary pilot-feel-open" onClick={() => setOpen(true)}>
        ✦ Passe game feel…
      </button>
    );
  const go = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const r = await api.feel(slug, moments, intensity);
      setMsg({ ok: true, text: r.after ? `${r.task.id} attend son tour (après ${r.after}).` : `${r.task.id} lancé.`, href: `#/p/${slug}/t/${r.thread}` });
      setMoments("");
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="pilot-feel">
      <p className="pilot-sub">Passe game feel</p>
      <p className="muted small">Ce que le joueur voit et ressent quand il agit : tremblements, arrêts sur image, éclats, flashs. Les règles ne bougent pas : tests, parties gardées et simulations le vérifient.</p>
      <input value={moments} onChange={(e) => setMoments(e.target.value)} placeholder="Quels moments ? (vide : les actions principales du joueur)" aria-label="Moments visés" />
      <span className="bilan-actions">
        <select value={intensity} onChange={(e) => setIntensity(e.target.value as typeof intensity)} aria-label="Intensité">
          <option value="discret">Discrète</option>
          <option value="marque">Marquée</option>
          <option value="genereux">Généreuse (arcade)</option>
        </select>
        <button className="small" disabled={busy} onClick={go}>
          {busy ? "…" : "Lancer la passe"}
        </button>
        <button className="small link" onClick={() => setOpen(false)}>
          Fermer
        </button>
      </span>
      {msg && (
        <p className={`small ${msg.ok ? "muted" : "error"}`}>
          {msg.text} {msg.href && <a href={msg.href}>Suivre dans sa discussion</a>}
        </p>
      )}
    </div>
  );
}

/** Les chantiers en échec : un clic les remet à zéro ; le premier part, les suivants attendent leur tour dans la file. */
function Relaunch({ slug, failed }: { slug: string; failed: TaskRow[] }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const relaunch = async (ids: string[]) => {
    setBusy(true);
    setError(null);
    try {
      for (const id of ids) await api.startTask(slug, id);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <p className="pilot-sub">En échec</p>
      {failed.map((t) => (
        <article key={t.id} id={`pil-${t.id}`} className="pilot-row">
          <span className="dot ko" />
          <a href={`#/p/${slug}/tasks/${t.id}`} className="pilot-row-title">
            {t.title}
          </a>
          <button className="small secondary" disabled={busy} onClick={() => relaunch([t.id])}>
            ↻ Relancer
          </button>
        </article>
      ))}
      {failed.length > 1 && (
        <button className="small" disabled={busy} onClick={() => relaunch(failed.map((t) => t.id))}>
          {busy ? "Relance…" : `↻ Relancer les ${failed.length} dans l'ordre`}
        </button>
      )}
      {error && <p className="error small">{error}</p>}
    </>
  );
}

function Production({ slug, tasks, art }: { slug: string; tasks: TaskRow[] | null; art: ArtState | null }) {
  const now = useNow(5000);
  // Le lien survolé : un chantier et ses visuels, ou un visuel et ses chantiers, s'allument ensemble.
  const [hl, setHl] = useState<Set<string>>(new Set());
  const links = useMemo(() => {
    const m = new Map<string, Set<string>>();
    const add = (a: string, b: string) => {
      (m.get(a) ?? m.set(a, new Set()).get(a)!).add(b);
      (m.get(b) ?? m.set(b, new Set()).get(b)!).add(a);
    };
    for (const t of tasks ?? []) for (const v of t.visuals ?? []) add(t.id, v.id);
    for (const q of art?.queue ?? []) if (q.need) add(q.id, q.need.id);
    for (const a of art?.assets ?? []) if (a.waitsFor) add(a.id, a.waitsFor);
    return m;
  }, [tasks, art]);
  const hover = (id: string | null) => setHl(id ? new Set([id, ...(links.get(id) ?? [])]) : new Set());
  const jump = (id: string) => {
    document.getElementById(`pil-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    hover(id);
  };
  const lit = (id: string) => (hl.size ? (hl.has(id) ? "lit" : "dim") : "");

  const active = (tasks ?? []).filter((t) => t.progress);
  const queue = (tasks ?? []).filter((t) => t.queue_rank).sort((a, b) => a.queue_rank! - b.queue_rank!);
  const recent = (tasks ?? [])
    .filter((t) => t.status === "merged")
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, 4);
  // En échec : chacun se relance de zéro, dans l'ordre des numéros (ADR-77).
  const failed = (tasks ?? []).filter((t) => t.status === "failed").sort((a, b) => a.id.localeCompare(b.id));
  const assets = new Map((art?.assets ?? []).map((a) => [a.id, a]));
  const generating = art?.busy.generating ?? [];
  const artQueue = (art?.queue ?? []).filter((q) => !generating.some((g) => g.asset === q.id));
  const waiting = (art?.assets ?? []).filter((a) => a.waitsFor);
  const toDecide = (art?.assets ?? []).filter((a) => a.status === "a_valider" || (a.sketches?.length && !a.direction));
  const chip = (id: string, label?: string) => (
    <button key={id} className={`link-chip ${lit(id)}`} onMouseEnter={() => hover(id)} onMouseLeave={() => hover(null)} onClick={() => jump(id)}>
      {id}
      {label ? ` ${label}` : ""}
    </button>
  );

  return (
    <div className="pilot-cols">
      <section className="pilot-col" aria-label="Chantiers">
        <h2>
          Chantiers <span className="muted">{queue.length ? `· ${queue.length} en file` : ""}</span>
        </h2>
        {!tasks && <p className="muted">Chargement…</p>}
        {tasks && active.length === 0 && <p className="pilot-empty">Aucun chantier en cours.</p>}
        {active.map((t) => (
          <article key={t.id} id={`pil-${t.id}`} className={`pilot-card big ${lit(t.id)}`} onMouseEnter={() => hover(t.id)} onMouseLeave={() => hover(null)}>
            <div className="pilot-card-top">
              <a className="pilot-id" href={`#/p/${slug}/tasks/${t.id}`}>
                {t.id}
              </a>
              <span className="muted small">{usd(t.cost_usd)}</span>
            </div>
            <h3>{t.title}</h3>
            <div className="progress" role="progressbar" aria-valuenow={t.progress!.pct} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${t.progress!.pct}%` }} />
            </div>
            <div className="pilot-card-foot">
              <span>{t.progress!.label}</span>
              <span className="muted">≈ {t.progress!.pct} %</span>
            </div>
            {(t.visuals?.length ?? 0) > 0 && <div className="chips">{t.visuals!.map((v) => chip(v.id, `« ${v.name} »`))}</div>}
          </article>
        ))}
        {queue.length > 0 && <p className="pilot-sub">À suivre</p>}
        {queue.map((t) => (
          <article key={t.id} id={`pil-${t.id}`} className={`pilot-row ${lit(t.id)}`} onMouseEnter={() => hover(t.id)} onMouseLeave={() => hover(null)}>
            <span className="pilot-rank">{t.queue_rank}</span>
            <div className="pilot-row-body">
              <a href={`#/p/${slug}/tasks/${t.id}`} className="pilot-row-title">
                {t.title}
              </a>
              {(t.visuals?.length ?? 0) > 0 && <div className="chips">{t.visuals!.map((v) => chip(v.id))}</div>}
            </div>
            <span className="muted small">{t.id}</span>
          </article>
        ))}
        {failed.length > 0 && <Relaunch slug={slug} failed={failed} />}
        <FeelPass slug={slug} />
        {recent.length > 0 && <p className="pilot-sub">Fusionnés récemment</p>}
        {recent.map((t) => (
          <article key={t.id} className="pilot-row done">
            <span className="dot ok" />
            <a href={`#/p/${slug}/tasks/${t.id}`} className="pilot-row-title">
              {t.title}
            </a>
            <span className="muted small">{usd(t.cost_usd)}</span>
          </article>
        ))}
      </section>

      <section className="pilot-col" aria-label="Visuels">
        <h2>
          Visuels <span className="muted">{artQueue.length ? `· ${artQueue.length} en file` : ""}</span>
        </h2>
        {!art && <p className="muted">Chargement…</p>}
        {art && generating.length === 0 && <p className="pilot-empty">Aucun visuel en fabrication.</p>}
        {generating.map((g) => {
          const a = assets.get(g.asset);
          const img = g.preview ? (g.preview.kind === "atelier" ? api.artAtelierFile(slug, g.asset, g.preview.file) : api.artFile(slug, g.preview.file)) : null;
          const need = art?.queue?.find((q) => q.id === g.asset)?.need;
          return (
            <article key={g.asset} id={`pil-${g.asset}`} className={`pilot-card big ${lit(g.asset)}`} onMouseEnter={() => hover(g.asset)} onMouseLeave={() => hover(null)}>
              <div className="pilot-visual">
                {img ? <img src={img} alt="" /> : <div className="pilot-thumb-empty" />}
                <div>
                  <div className="pilot-card-top">
                    <span className="pilot-id">{g.asset}</span>
                    <span className="muted small">{g.stage ? STAGE[g.stage] : ""}</span>
                  </div>
                  <h3>{a?.name ?? g.asset}</h3>
                  <div className="progress">
                    <span style={{ width: `${Math.round(((g.round - 1 + 0.5) / Math.max(1, g.rounds)) * 100)}%` }} />
                  </div>
                  <div className="pilot-card-foot">
                    <span className="small">{g.step}</span>
                    <span className="muted">
                      passe {g.round}/{g.rounds}
                    </span>
                  </div>
                  {need && <div className="chips">pour {chip(need.id)}</div>}
                </div>
              </div>
            </article>
          );
        })}
        {toDecide.length > 0 && <p className="pilot-sub">À trancher</p>}
        {toDecide.map((a) => (
          <VisualRow key={a.id} slug={slug} a={a} lit={lit(a.id)} hover={hover} extra={<a href={`#/p/${slug}/art`}>Ouvrir</a>} />
        ))}
        {artQueue.length > 0 && <p className="pilot-sub">À suivre</p>}
        {artQueue.map((q, k) => {
          const a = assets.get(q.id);
          return a ? <VisualRow key={q.id} slug={slug} a={a} rank={k + 1} lit={lit(q.id)} hover={hover} extra={q.need ? <span className="chips">pour {chip(q.need.id)}</span> : null} /> : null;
        })}
        {waiting.length > 0 && <p className="pilot-sub">Prêts, en attente d'un chantier</p>}
        {waiting.map((a) => (
          <VisualRow key={a.id} slug={slug} a={a} lit={lit(a.id)} hover={hover} extra={<span className="chips">après {chip(a.waitsFor!)}</span>} />
        ))}
        <p className="muted small pilot-note">Mis à jour {new Date(now).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</p>
      </section>
    </div>
  );
}

/** Une ligne de visuel : vignette, nom, statut, et le lien vers ce qui l'attend. */
function VisualRow({ slug, a, rank, lit, hover, extra }: { slug: string; a: ArtAsset; rank?: number; lit: string; hover: (id: string | null) => void; extra?: ReactNode }) {
  const thumb = a.model?.renders[0] ?? a.renders.at(-1) ?? a.sketches?.find((s) => s.file)?.file ?? null;
  return (
    <article id={`pil-${a.id}`} className={`pilot-row ${lit}`} onMouseEnter={() => hover(a.id)} onMouseLeave={() => hover(null)}>
      {rank ? <span className="pilot-rank">{rank}</span> : null}
      {thumb ? <img className="pilot-mini" src={api.artFile(slug, thumb)} alt="" loading="lazy" /> : <span className="pilot-mini empty" />}
      <div className="pilot-row-body">
        <span className="pilot-row-title">{a.name}</span>
        <span className="muted small">
          {a.id} · {STATUS[a.status]}
        </span>
      </div>
      {extra}
    </article>
  );
}
