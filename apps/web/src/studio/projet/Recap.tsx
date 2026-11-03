import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { navigate } from "../../App.tsx";
import { api, type Recap as RecapData, type RecapCard, type RecapGroup, type RecapPeriod } from "../../api.ts";
import { HowTasksWork, TASK_STATUS } from "../../pages/TasksView.tsx";
import { Icon } from "../Icon.tsx";
import { useGlider } from "../motion.tsx";
import { TryButton } from "../Preview.tsx";
import { money } from "../Workshop.tsx";

/**
 * Le Récap des chantiers (ADR-113) : ce que l'équipe a fait, semaine par semaine, en clair. Six chiffres sur la période
 * choisie, « Raconter la semaine » (le journal de bord, ADR-89 : son GIF et le récit du directeur), quatre filtres, puis
 * les chantiers en cartes : la photo « en jeu » du Testeur, ce qui change dans le jeu, son avis, le coût et la durée.
 * Une carte ouvre le panneau de détail ; « Tout le détail » mène à la page complète du chantier.
 */

type Filter = "all" | RecapGroup;
const FILTERS: [Filter, string][] = [
  ["all", "Tous"],
  ["merged", "Fusionnés"],
  ["failed", "Échecs et abandons"],
  ["running", "En cours"],
];
const PERIODS: [RecapPeriod, string][] = [
  ["week", "Cette semaine"],
  ["lastweek", "Semaine dernière"],
  ["30d", "30 jours"],
];
const VERDICT: Record<NonNullable<RecapCard["verdict"]>, [string, string]> = {
  pass: ["ok", "Validé"],
  pass_with_notes: ["notes", "Validé, remarques"],
  fail: ["fail", "Refusé par le testeur"],
};

const DAY = 86_400_000;
const day = (iso: string) => new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
/** 7 min, 1 h 31, 15 h 21. */
export function duration(minutes: number): string {
  if (minutes <= 0) return "0 min";
  if (minutes < 1) return "< 1 min";
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  return `${h} h ${String(Math.round(minutes - h * 60)).padStart(2, "0")}`;
}
/** Le lundi (heure locale) d'une date, « AAAA-MM-JJ », comme le journal de bord du hub. */
function weekOf(d: Date): string {
  const m = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  return `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}-${String(m.getDate()).padStart(2, "0")}`;
}
/** « 19 – 25 oct. » : du lundi au dimanche. */
function range(from: string, to: string): string {
  const a = new Date(from);
  const b = new Date(Date.parse(to) - DAY / 2);
  return `${a.getDate()} – ${day(b.toISOString())}`;
}
function weekName(week: string, from: string): string {
  const now = new Date();
  if (week === weekOf(now)) return "Cette semaine";
  if (week === weekOf(new Date(now.getTime() - 7 * DAY))) return "La semaine dernière";
  return `Semaine du ${day(from)}`;
}

/** Un chiffre qui défile jusqu'à sa valeur (coupé avec les animations réduites). */
function useCount(value: number, ms = 700): number {
  const [shown, setShown] = useState(value);
  const from = useRef(0);
  useEffect(() => {
    if (document.documentElement.dataset.motion === "reduced") {
      from.current = value;
      setShown(value);
      return;
    }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / ms);
      setShown(a + (value - a) * (1 - (1 - k) ** 3));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      from.current = value;
    };
  }, [value, ms]);
  return shown;
}

function Kpi({ label, value, format, sub, tone }: { label: string; value: number; format: (n: number) => string; sub: string; tone?: "ok" | "bad" }) {
  const shown = useCount(value);
  return (
    <div className={`recap-kpi${tone ? ` ${tone}` : ""}`}>
      <span className="recap-kpi-l">{label}</span>
      <b>{format(shown)}</b>
      <small>{sub}</small>
    </div>
  );
}

/** La pastille de statut d'un chantier ; braise seulement s'il vous attend. */
function StatusPill({ card, long }: { card: RecapCard; long?: boolean }) {
  if (card.status === "merged") return <span className="rc-pill ok">{long && card.merged_at ? `Fusionné le ${day(card.merged_at)}` : "Fusionné"}</span>;
  if (card.status === "failed") return <span className="rc-pill fail">Échec</span>;
  if (card.group === "failed") return <span className="rc-pill grey">{TASK_STATUS[card.status]?.label ?? card.status}</span>;
  if (card.pending_escalations > 0) return <span className="rc-pill ember">Le Gardien attend</span>;
  if (card.status === "review" || card.status === "plan_review") return <span className="rc-pill ember">{TASK_STATUS[card.status]!.label}</span>;
  if (card.status === "draft") return <span className="rc-pill grey">{card.queue_rank ? `En file · n° ${card.queue_rank}` : card.queued ? "En file" : "Prêt à lancer"}</span>;
  return <span className="rc-pill cyan">{TASK_STATUS[card.status]?.label ?? card.status}</span>;
}

function VerdictPill({ card }: { card: RecapCard }) {
  if (!card.verdict) return <span className="rc-pill grey nodot">Pas d'avis</span>;
  const [tone, label] = VERDICT[card.verdict];
  return <span className={`rc-pill ${tone}`}>{label}</span>;
}

function Shot({ slug, card, big }: { slug: string; card: RecapCard; big?: boolean }) {
  const [ok, setOk] = useState(true);
  const live = card.group === "running";
  return (
    <div className={`rc-shot${big ? " big" : ""}${card.shot && ok ? "" : " ph"}`}>
      {card.shot && ok ? (
        <img src={api.screenshotUrl(slug, card.id, card.at)} alt={big ? `Le jeu après ${card.id}` : ""} loading="lazy" onError={() => setOk(false)} />
      ) : (
        <span className="rc-ph">
          <Icon name={live ? "clock" : "close"} size={16} />
          {live ? "Pas encore de capture" : "Pas de capture"}
        </span>
      )}
      {card.shot === "in_game" && ok && <span className="rc-tag">photo en jeu</span>}
      {!big && (
        <span className="rc-st">
          <StatusPill card={card} />
        </span>
      )}
    </div>
  );
}

function TaskCard({ slug, card, index, selected, onOpen }: { slug: string; card: RecapCard; index: number; selected: boolean; onOpen: () => void }) {
  return (
    <button className={`rc-card g-${card.group} s-${card.status}${selected ? " sel" : ""}`} style={{ "--i": Math.min(index, 14) } as CSSProperties} onClick={onOpen} aria-pressed={selected}>
      <Shot slug={slug} card={card} />
      <span className="rc-body">
        <span className="rc-k">
          <span>{card.id}</span>
          <span>{day(card.at)}</span>
        </span>
        <span className="rc-title">{card.title}</span>
        <span className="rc-sum">
          <em>Ce qui change dans le jeu</em>
          {card.summary ?? (card.group === "running" ? "Pas encore : le chantier est en route." : "Aucun changement : le chantier n'est pas allé au bout.")}
        </span>
        <span className="rc-f">
          <VerdictPill card={card} />
          <span className="sp" />
          {card.reworks.length > 0 ? <span className="rw">↻ corrige {card.reworks[0]}</span> : card.reworked_by.length > 0 ? <span className="rw">↻ corrigé par {card.reworked_by[0]}</span> : null}
          <span>{money(card.cost_usd)}</span>
          <span>{duration(card.minutes)}</span>
        </span>
      </span>
    </button>
  );
}

/** Les chiffres d'une liste de cartes (l'en-tête d'une semaine, selon le filtre). */
function weekStats(list: RecapCard[]) {
  return {
    merged: list.filter((c) => c.group === "merged").length,
    failed: list.filter((c) => c.group === "failed").length,
    cost: list.reduce((n, c) => n + c.cost_usd, 0),
    minutes: list.reduce((n, c) => n + c.minutes, 0),
  };
}

export function Recap({ slug, initialFilter }: { slug: string; initialFilter?: Filter }) {
  const [period, setPeriod] = useState<RecapPeriod | undefined>(undefined);
  const [data, setData] = useState<RecapData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>(initialFilter ?? "all");
  const [open, setOpen] = useState<string | null>(null);
  const [story, setStory] = useState(false);

  const load = useCallback(
    () =>
      api.recap(slug, period).then(
        (d) => {
          setData(d);
          setError(null);
        },
        (e: Error) => setError(e.message),
      ),
    [slug, period],
  );
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 8000);
    return () => clearInterval(t);
  }, [load]);

  const shownPeriod = period ?? data?.period;
  const seg = useRef<HTMLDivElement>(null);
  useGlider(seg, "button.on", [shownPeriod]);

  const all = useMemo(() => data?.weeks.flatMap((w) => w.tasks) ?? [], [data]);
  const visible = useMemo(() => {
    if (!data) return [];
    const weeks = filter === "running" ? [{ week: "running", from: "", to: "", tasks: all.filter((c) => c.group === "running") }] : data.weeks.map((w) => ({ ...w, tasks: filter === "all" ? w.tasks : w.tasks.filter((c) => c.group === filter) }));
    return weeks.filter((w) => w.tasks.length);
  }, [data, all, filter]);
  const flat = visible.flatMap((w) => w.tasks);
  const current = open ? (all.find((c) => c.id === open) ?? null) : null;

  if (!data) return <main className="recap-page">{error ? <p className="error">{error}</p> : <p className="muted">Chargement…</p>}</main>;
  const s = data.stats;
  const periodLabel = data.period === "30d" ? "sur les 30 derniers jours" : `du ${new Date(data.from).getDate()} au ${day(new Date(Date.parse(data.to) - DAY / 2).toISOString())}`;
  const filterCount = (f: Filter) => (f === "all" ? data.counts.all : data.counts[f]);

  return (
    <main className="recap-page">
      <div className="recap-inner">
        <header className="recap-h">
          <div>
            <h2>Récap des chantiers</h2>
            <p>Ce que l'équipe a fait, semaine par semaine, en clair.</p>
          </div>
          <span className="sp" />
          <div className="recap-seg" ref={seg} role="group" aria-label="Période des chiffres">
            {PERIODS.map(([p, label]) => (
              <button key={p} className={shownPeriod === p ? "on" : ""} aria-pressed={shownPeriod === p} onClick={() => setPeriod(p)}>
                {label}
              </button>
            ))}
          </div>
        </header>
        {error && <p className="error small">{error}</p>}

        <section className="recap-kpis" aria-label="Les chiffres de la période">
          <Kpi label="Fusionnés" value={s.merged} format={(n) => String(Math.round(n))} sub={`sur ${s.total} chantier${s.total > 1 ? "s" : ""}`} tone="ok" />
          <Kpi label="Échecs et abandons" value={s.failed} format={(n) => String(Math.round(n))} sub={s.failed ? "à relancer ou abandonnés" : "aucun"} tone={s.failed ? "bad" : undefined} />
          <Kpi label="Coût total" value={s.cost_usd} format={money} sub={s.merged ? `≈ ${money(s.cost_usd / s.merged)} par chantier fusionné` : "équivalent API, sur votre abonnement"} />
          <Kpi label="Temps d'agents" value={s.minutes} format={duration} sub={periodLabel} />
          <Kpi
            label="Réussis du premier coup"
            value={s.first_try_pct ?? 0}
            format={(n) => (s.first_try_pct === null ? "—" : `${Math.round(n)} %`)}
            sub={`${s.first_try} sans correction ni reprise`}
          />
          <Kpi label="Visuels intégrés" value={s.visuals} format={(n) => String(Math.round(n))} sub="du Directeur artistique" />
          <div className="recap-kpi-act">
            <button className="rail-btn recap-tell" onClick={() => setStory(true)}>
              <Icon name="book" size={14} /> Raconter la semaine
            </button>
          </div>
        </section>

        <div className="recap-filters" role="group" aria-label="Filtrer les chantiers">
          {FILTERS.map(([f, label]) => (
            <button key={f} className={`recap-chip${filter === f ? " on" : ""}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {label}
              <span className="n">{filterCount(f)}</span>
            </button>
          ))}
          <span className="sp" />
          <small className="recap-hint">Cliquez une carte pour le détail</small>
        </div>

        {visible.map((w) => {
          const ws = weekStats(w.tasks);
          return (
            <section key={w.week} className="recap-week" aria-label={w.week === "running" ? "En cours maintenant" : weekName(w.week, w.from)}>
              <div className="recap-week-h">
                <h3>{w.week === "running" ? "En cours maintenant" : weekName(w.week, w.from)}</h3>
                {w.week !== "running" && <span>{range(w.from, w.to)}</span>}
                <span className="ws">
                  <span>
                    <b>{ws.merged}</b> fusionné{ws.merged > 1 ? "s" : ""}
                  </span>
                  <span>
                    <b>{ws.failed}</b> échec{ws.failed > 1 ? "s" : ""}
                  </span>
                  <span>
                    <b>{money(ws.cost)}</b>
                  </span>
                  <span>
                    <b>{duration(ws.minutes)}</b>
                  </span>
                </span>
              </div>
              <div className="recap-grid">
                {w.tasks.map((c, i) => (
                  <TaskCard key={c.id} slug={slug} card={c} index={i} selected={c.id === open} onOpen={() => setOpen(c.id)} />
                ))}
              </div>
            </section>
          );
        })}
        {visible.length === 0 && <p className="recap-none">{data.counts.all ? (filter === "running" ? "Aucun chantier en cours." : "Rien dans ce filtre.") : "Aucun chantier pour l'instant. Dites « go » au directeur dans la discussion quand une proposition vous va."}</p>}

        <details className="recap-howto" open={data.counts.all === 0}>
          <summary>Comment avancent les chantiers</summary>
          <HowTasksWork slug={slug} />
          <p className="muted small">Pour en lancer un : dites « go » au directeur dans la discussion, ou « Faire réaliser » sur un point de « Le jeu ».</p>
        </details>
      </div>

      {/* Le panneau et le récit passent par-dessus toute la page : rendus dans <body>, hors de la page qui s'anime. */}
      {current &&
        createPortal(
          <Drawer
            slug={slug}
            card={current}
            onClose={() => setOpen(null)}
            onMove={(d) => {
              const k = flat.findIndex((c) => c.id === current.id);
              const next = flat[k + d];
              if (next) setOpen(next.id);
            }}
            canMove={(d) => {
              const k = flat.findIndex((c) => c.id === current.id);
              return k >= 0 && !!flat[k + d];
            }}
            onChanged={() => void load()}
          />,
          document.body,
        )}
      {story && createPortal(<Story slug={slug} data={data} onClose={() => setStory(false)} />, document.body)}
    </main>
  );
}

/** Le panneau de détail : le résumé, l'avis complet du Testeur, comment tester, le technique replié, le fil, les actions. */
function Drawer({ slug, card: c, onClose, onMove, canMove, onChanged }: { slug: string; card: RecapCard; onClose: () => void; onMove: (d: number) => void; canMove: (d: number) => boolean; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [note, setNote] = useState<"retouche" | "correction" | null>(null);
  const [text, setText] = useState("");
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    setError(null);
    setDone(null);
    setNote(null);
    setText("");
    panel.current?.querySelector(".rc-d-b")?.scrollTo(0, 0);
  }, [c.id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowDown" && !(e.target instanceof HTMLTextAreaElement)) onMove(1);
      else if (e.key === "ArrowUp" && !(e.target instanceof HTMLTextAreaElement)) onMove(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onMove]);

  async function run(fn: () => Promise<unknown>, message: string, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      setDone(message);
      setNote(null);
      setText("");
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // Une retouche après la fusion : un mot au directeur dans le fil d'origine, qui en fait un chantier.
  const retouche = () =>
    run(async () => {
      const thread = c.thread?.id ?? (await api.createThread(slug, `Retouche de ${c.id}`)).id;
      await api.send(slug, thread, `Retouche sur ${c.id} « ${c.title} » : ${text.trim()}`);
      navigate({ page: "project", slug, thread });
    }, "Retouche envoyée au directeur");

  const steps = c.how_to_test.length;
  return (
    <>
      <div className="rc-backdrop" onClick={onClose} />
      <aside className="rc-drawer" ref={panel} role="dialog" aria-label={`Détail du chantier ${c.id}`}>
        <div className="rc-d-h">
          <span className="k">
            {c.id} · {day(c.created_at)}
          </span>
          <span className="sp" />
          <button className="rc-icon up" disabled={!canMove(-1)} onClick={() => onMove(-1)} title="Chantier précédent (↑)" aria-label="Chantier précédent">
            <Icon name="down" size={15} />
          </button>
          <button className="rc-icon" disabled={!canMove(1)} onClick={() => onMove(1)} title="Chantier suivant (↓)" aria-label="Chantier suivant">
            <Icon name="down" size={15} />
          </button>
          <button className="rc-icon" onClick={onClose} title="Fermer (Échap)" aria-label="Fermer le détail">
            <Icon name="close" size={15} />
          </button>
        </div>
        <div className="rc-d-b">
          <Shot slug={slug} card={c} big />
          <div className="rc-d-title">
            <h2>{c.title}</h2>
            <div className="rc-meta">
              <StatusPill card={c} long />
              {c.verdict && <VerdictPill card={c} />}
              {c.reworks.length > 0 && <span className="rc-pill grey nodot">↻ corrige {c.reworks.join(", ")}</span>}
              {c.reworked_by.length > 0 && <span className="rc-pill grey nodot">↻ corrigé ensuite par {c.reworked_by.join(", ")}</span>}
            </div>
          </div>
          <div className="rc-facts">
            <div>
              <span>Coût</span>
              <b>{money(c.cost_usd)}</b>
            </div>
            <div>
              <span>Durée</span>
              <b>{duration(c.minutes)}</b>
            </div>
            <div>
              <span>Corrections</span>
              <b>{c.corrections + c.reworked_by.length}</b>
            </div>
            <div>
              <span>Étapes de test</span>
              <b>{steps}</b>
            </div>
          </div>
          <div className="rc-sec">
            <h5>
              <Icon name="play" size={13} /> Ce qui change dans le jeu
            </h5>
            <p>{c.summary ?? (c.group === "running" ? "Pas encore : le chantier est en route." : "Rien : le chantier n'a pas abouti.")}</p>
          </div>
          {c.error && (
            <div className="rc-sec">
              <h5>
                <Icon name="close" size={13} /> Pourquoi il s'est arrêté
              </h5>
              <p className="rc-error">{c.error}</p>
            </div>
          )}
          <div className="rc-sec">
            <h5>
              <Icon name="check" size={13} /> Avis du testeur
            </h5>
            <div className={`rc-tester${c.verdict === "fail" || !c.tester ? " bad" : ""}${!c.tester ? " none" : ""}`}>
              <p>{c.tester ?? (c.group === "running" ? "Le testeur n'est pas encore passé." : "Le testeur n'a pas rendu d'avis : le chantier s'est arrêté avant.")}</p>
              {c.played && <p className="muted small">▶ Essayé en jouant : {c.played}</p>}
              {c.unverified.length > 0 && <p className="muted small">Pas vérifié en jeu : {c.unverified.join(" ; ")}</p>}
            </div>
          </div>
          {steps > 0 && (
            <div className="rc-sec">
              <h5>
                <Icon name="play" size={13} /> Comment tester
              </h5>
              <ol>
                {c.how_to_test.map((h) => (
                  <li key={h}>{h}</li>
                ))}
              </ol>
            </div>
          )}
          {c.tech && (
            <details className="rc-tech">
              <summary>Détails techniques</summary>
              <div>{c.tech}</div>
            </details>
          )}
          {c.thread && (
            <a className="rc-origin" href={`#/p/${slug}/t/${c.thread.id}`}>
              <Icon name="chat" size={14} />
              <span className="muted">Fil d'origine</span>
              <b>{c.thread.title || "la discussion"}</b>
              <Icon name="arrow" size={14} />
            </a>
          )}
          {note && (
            <div className="reveal-box">
              <textarea
                rows={2}
                autoFocus
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={note === "retouche" ? "Que faut-il retoucher ?" : "Qu'est-ce qui ne va pas ? (ex. « les grues sont trop grosses »)"}
              />
              <div className="dacts">
                <button
                  className="rail-btn primary"
                  disabled={busy || !text.trim()}
                  onClick={() => (note === "retouche" ? retouche() : run(() => api.requestChanges(slug, c.id, text.trim()), "Correction demandée au Développeur"))}
                >
                  {note === "retouche" ? "Envoyer au directeur" : "Envoyer la correction"}
                </button>
                <button className="rail-btn ghost" onClick={() => setNote(null)}>
                  Annuler
                </button>
              </div>
            </div>
          )}
          {done && (
            <p className="rc-done" role="status">
              <Icon name="check" size={14} /> {done}
            </p>
          )}
          {error && <p className="error small">{error}</p>}
        </div>
        <div className="rc-d-f">
          <Actions slug={slug} card={c} busy={busy} run={run} note={note} setNote={setNote} />
          <span className="sp" />
          <a className="rail-btn ghost" href={`#/p/${slug}/tasks/${c.id}`}>
            Tout le détail <Icon name="arrow" size={13} />
          </a>
        </div>
      </aside>
    </>
  );
}

type Run = (fn: () => Promise<unknown>, message: string, confirmText?: string) => Promise<void>;

/** Les actions selon le statut ; le reste (plan, Gardien, journal, changements, avis) est dans « Tout le détail ». */
function Actions({ slug, card: c, busy, run, note, setNote }: { slug: string; card: RecapCard; busy: boolean; run: Run; note: string | null; setNote: (n: "retouche" | "correction" | null) => void }) {
  if (c.status === "merged")
    return (
      <>
        <TryButton slug={slug} label="▶ Lancer le jeu" />
        {!note && (
          <button className="rail-btn" onClick={() => setNote("retouche")}>
            Demander une retouche
          </button>
        )}
      </>
    );
  if (c.status === "review")
    return (
      <>
        <button
          className="rail-btn primary"
          disabled={busy}
          onClick={() =>
            run(
              async () => {
                const r = await api.review(slug, c.id);
                if (!r.head) throw new Error("Ce chantier n'a pas de modifications à fusionner");
                await api.merge(slug, c.id, r.head);
              },
              `${c.id} fusionné dans votre jeu`,
              "Fusionner ces modifications dans votre jeu ? (annulable ensuite avec Git)",
            )
          }
        >
          <Icon name="check" size={13} /> Fusionner
        </button>
        <TryButton slug={slug} task={c.id} label="▶ Essayer cette version" />
        {!note && (
          <button className="rail-btn" disabled={busy} onClick={() => setNote("correction")}>
            Demander une correction
          </button>
        )}
      </>
    );
  if (c.status === "failed" || c.status === "cancelled")
    return (
      <>
        <button className="rail-btn primary" disabled={busy} onClick={() => run(() => api.startTask(slug, c.id), `${c.id} relancé de zéro : le Développeur reprend`)}>
          <Icon name="refresh" size={13} /> Relancer
        </button>
        <button className="rail-btn ghost" disabled={busy} onClick={() => run(() => api.abandonTask(slug, c.id), `${c.id} classé comme abandonné`, "Abandonner ce chantier ? Sa copie de travail sera supprimée.")}>
          Abandonner
        </button>
      </>
    );
  if (c.status === "rejected")
    return (
      <button className="rail-btn primary" disabled={busy} onClick={() => run(() => api.startPlan(slug, c.id), "Nouveau plan demandé au Développeur")}>
        Demander un nouveau plan
      </button>
    );
  if (c.status === "draft" && !c.queued)
    return (
      <button className="rail-btn primary" disabled={busy} onClick={() => run(() => api.startTask(slug, c.id), `${c.id} lancé`)}>
        ▶ Lancer ce chantier
      </button>
    );
  // Le Gardien ou un plan qui vous attend : ils se tranchent dans « À vous » ou sur la page du chantier.
  if (c.pending_escalations > 0 || c.status === "plan_review")
    return (
      <a className="rail-btn primary" href={`#/p/${slug}/tasks/${c.id}`}>
        {c.pending_escalations > 0 ? "Autoriser ou refuser" : "Voir le plan à valider"}
      </a>
    );
  return null;
}

/** « Raconter la semaine » : le journal de bord de la semaine (ADR-89), son GIF en tête et le récit du directeur. */
function Story({ slug, data, onClose }: { slug: string; data: RecapData; onClose: () => void }) {
  const week = data.story.week;
  const [text, setText] = useState(data.story.text);
  const [at, setAt] = useState(data.story.at);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const frames = data.weeks.find((w) => w.week === week)?.merged ?? 0;

  const tell = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const w = await api.logbookTell(slug, week);
      setText(w.story?.text ?? null);
      setAt(w.story?.at ?? null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [slug, week]);
  // Pas encore de récit : le directeur l'écrit à l'ouverture (vous l'avez demandé en cliquant).
  const asked = useRef(false);
  useEffect(() => {
    if (!data.story.text && !asked.current) {
      asked.current = true;
      void tell();
    }
  }, [data.story.text, tell]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const [y, m, d] = week.split("-").map(Number) as [number, number, number];
  const label = `La semaine du ${day(new Date(y, m - 1, d).toISOString())} au ${day(new Date(y, m - 1, d + 6).toISOString())}`;
  return (
    <>
      <div className="rc-backdrop modal" onClick={onClose} />
      <div className="rc-story" role="dialog" aria-label="Le récit de la semaine">
        <h3>{label}</h3>
        {data.story.gif && (
          <figure className="rc-gif">
            <img src={api.logbookGif(slug, week, frames)} alt="Le jeu au fil de la semaine" />
            <figcaption className="muted small">Le jeu au fil de la semaine, une image par fusion.</figcaption>
          </figure>
        )}
        {busy && !text && <p className="muted">Le directeur écrit…</p>}
        {text && text.split(/\n+/).map((p, k) => <p key={k}>{p}</p>)}
        {error && <p className="error small">{error}</p>}
        <div className="rc-sig">
          <span className="rc-av">D</span>
          <span>{at ? `Raconté par le directeur le ${day(at)}, à partir des comptes rendus` : "Raconté par le directeur, à partir des comptes rendus"}</span>
          <span className="sp" />
          {text && (
            <button className="rail-link" disabled={busy} onClick={() => void tell()}>
              {busy ? "Le directeur écrit…" : "Raconter à nouveau"}
            </button>
          )}
          <button className="rail-link accent" onClick={onClose}>
            Fermer
          </button>
        </div>
      </div>
    </>
  );
}
