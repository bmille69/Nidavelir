import { useCallback, useEffect, useState } from "react";
import { api, type Production, type ProductionStep } from "../api.ts";
import { Icon, type IconName } from "./Icon.tsx";
import { SoundDirection } from "./SoundDirection.tsx";

/** Ligne ajoutée par le hub sous le plan dans la discussion : la carte du plan s'affiche à sa place (ADR-107). */
const MARK = "§PRODUCTION§ ";

/** Sépare le texte d'un message des cartes de plan qu'il annonce. */
export function splitProduction(text: string): { text: string; ids: string[] } {
  if (!text.includes(MARK)) return { text, ids: [] };
  const ids: string[] = [];
  const kept = text.split("\n").filter((line) => {
    if (!line.startsWith(MARK)) return true;
    try {
      const id = (JSON.parse(line.slice(MARK.length)) as { id?: unknown }).id;
      if (typeof id === "string") ids.push(id);
    } catch {
      /* ligne abîmée : rien à afficher */
    }
    return false;
  });
  return { text: kept.join("\n").trimEnd(), ids };
}

const STATUS: Record<Production["status"], { label: string; tone: string }> = {
  preparing: { label: "En préparation", tone: "active" },
  proposed: { label: "À valider", tone: "you" },
  running: { label: "En cours", tone: "active" },
  paused: { label: "En pause", tone: "failed" },
  done: { label: "Terminé", tone: "done" },
  cancelled: { label: "Abandonné", tone: "skipped" },
};

const LANES: { kind: ProductionStep["kind"][]; label: string; icon: IconName }[] = [
  { kind: ["chantier"], label: "Code", icon: "hammer" },
  { kind: ["visuel"], label: "Visuels", icon: "palette" },
  { kind: ["son", "sons"], label: "Sons", icon: "bell" },
  { kind: ["verification"], label: "Vérification", icon: "check" },
];

const live = (p: Production) => p.status === "preparing" || p.status === "proposed" || p.status === "running" || p.status === "paused";

/** Un plan : ses étapes par métier, où en est chacune, et vos gestes (valider, continuer sans, abandonner). */
export function PlanCard({ slug, id, initial, compact = false }: { slug: string; id: string; initial?: Production; compact?: boolean }) {
  const [plan, setPlan] = useState<Production | null>(initial ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.production(slug, id).then(setPlan, (e: Error) => setError(e.message)), [slug, id]);
  useEffect(() => {
    if (initial) setPlan(initial);
  }, [initial]);
  useEffect(() => {
    if (!initial) void load();
  }, [load, initial]);
  const polling = !initial && (!plan || live(plan));
  useEffect(() => {
    if (!polling) return;
    const t = setInterval(load, plan?.status === "preparing" ? 2000 : 4000);
    return () => clearInterval(t);
  }, [polling, load, plan?.status]);

  const act = async (fn: () => Promise<Production>) => {
    setBusy(true);
    setError(null);
    try {
      setPlan(await fn());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!plan) return error ? <p className="error small">{error}</p> : <div className="plan-card plan-skeleton" aria-busy="true" />;
  const st = STATUS[plan.status];
  const steps = plan.steps;
  const finished = steps.filter((s) => s.state === "done" || s.state === "skipped").length;
  const pct = steps.length ? Math.round((finished / steps.length) * 100) : 0;
  // « À valider » : le bouton est juste en dessous, pas besoin de le redire.
  const yours = plan.waiting.filter((w) => plan.status !== "proposed" || !w.own);
  const needsSound = !compact && live(plan) && steps.some((s) => (s.kind === "son" || s.kind === "sons") && s.state === "you");
  const replaced = plan.status === "cancelled" && plan.refs.replacedBy;

  return (
    <article className={`plan-card tone-${st.tone} ${compact ? "compact" : ""}`} aria-label={`Plan de production ${plan.id}`}>
      <header className="plan-head">
        <span className={`plan-pill tone-${st.tone}`}>
          <i aria-hidden="true" />
          {st.label}
        </span>
        <h3>{plan.title}</h3>
        <span className="plan-id">
          {plan.id}
          {plan.auto ? " · séance autonome" : ""}
        </span>
      </header>
      {plan.status === "preparing" ? (
        <p className="plan-preparing">
          <span className="plan-spinner" aria-hidden="true" /> Le directeur découpe l'objectif par métier et écrit les critères d'acceptation…
        </p>
      ) : (
        <>
          {plan.plan && <p className="plan-goal">{plan.plan.objectif}</p>}
          {replaced && <p className="muted small">Remplacé par {plan.refs.replacedBy}.</p>}
          {plan.note && <p className="muted small">{plan.note}</p>}
          {steps.length > 0 && !replaced && (
            <>
              <div className="plan-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Avancement du plan">
                <span style={{ width: `${pct}%` }} />
              </div>
              <div className="plan-lanes">
                {LANES.map((lane) => {
                  const mine = steps.filter((s) => lane.kind.includes(s.kind));
                  if (!mine.length) return null;
                  return (
                    <div className="plan-lane" key={lane.label}>
                      <span className="plan-lane-label">
                        <Icon name={lane.icon} size={14} /> {lane.label}
                        {lane.label === "Sons" && live(plan) && !plan.refs.soundTask && mine.some((s) => s.state !== "done" && s.state !== "skipped") && (
                          <button className="small link plan-skip-all" disabled={busy} onClick={() => act(() => api.productionSkip(slug, plan.id, "sons"))} title="Le plan avance sans aucun son">
                            Continuer sans les sons
                          </button>
                        )}
                      </span>
                      <ol className="plan-steps">
                        {mine.map((s, k) => (
                          <li key={s.key} className={`plan-step state-${s.state}`} style={{ animationDelay: `${k * 50}ms` }}>
                            <a href={s.href ?? undefined} className="plan-step-body" title={s.detail}>
                              <i className="plan-dot" aria-hidden="true" />
                              <span className="plan-step-text">
                                <b>
                                  {s.ref && s.ref !== "sons" ? <span className="plan-ref">{s.ref}</span> : null}
                                  {s.label}
                                </b>
                                <small>{s.detail}</small>
                              </span>
                            </a>
                            {s.skippable && (
                              <button className="small secondary plan-skip" disabled={busy} onClick={() => act(() => api.productionSkip(slug, plan.id, s.ref ?? s.key))} title="Le plan avance sans cette étape">
                                Continuer sans
                              </button>
                            )}
                          </li>
                        ))}
                      </ol>
                    </div>
                  );
                })}
              </div>
            </>
          )}
          {plan.plan && !replaced && (
            <details className="plan-criteria" open={!compact && plan.status === "proposed"}>
              <summary>Critères d'acceptation ({plan.plan.criteres.length})</summary>
              <ol>
                {plan.plan.criteres.map((c, k) => (
                  <li key={k}>{c}</li>
                ))}
              </ol>
            </details>
          )}
          {live(plan) && yours.length > 0 && (
            <div className="plan-yours" aria-label="À vous">
              {yours.map((w, k) => (
                <a key={k} href={w.href}>
                  <span className="dot warn" /> {w.text.replace(/^Plan « [^»]+ » : /, "")}
                </a>
              ))}
            </div>
          )}
        </>
      )}
      {error && <p className="error small">{error}</p>}
      {(plan.status === "proposed" || plan.status === "running" || plan.status === "paused") && (
        <footer className="plan-actions">
          {plan.status === "proposed" && (
            <button className="plan-go" disabled={busy} onClick={() => act(() => api.productionStart(slug, plan.id))}>
              <Icon name="play" size={15} /> Valider le plan
            </button>
          )}
          {compact && (
            <a className="plan-follow" href={`#/p/${slug}/plans`}>
              Suivre dans « Plans »
            </a>
          )}
          <button className="secondary danger" disabled={busy} onClick={() => confirm(`Abandonner le plan « ${plan.title} » ? Les chantiers déjà lancés continuent.`) && act(() => api.productionCancel(slug, plan.id))}>
            Abandonner
          </button>
          {plan.spent > 0 && <span className="muted small plan-cost">≈ {plan.spent.toFixed(2).replace(".", ",")} $</span>}
        </footer>
      )}
      {needsSound && (
        <section className="plan-sound">
          <h4>Les sons du plan : écoutez et choisissez</h4>
          <SoundDirection slug={slug} />
        </section>
      )}
    </article>
  );
}

/** L'onglet « Plans » du projet : les plans en cours d'abord, puis l'historique. */
export function PlansView({ slug }: { slug: string }) {
  const [plans, setPlans] = useState<Production[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.productions(slug).then(setPlans, (e: Error) => setError(e.message)), [slug]);
  useEffect(() => {
    void load();
    const t = setInterval(load, 4000);
    return () => clearInterval(t);
  }, [load]);
  if (!plans) return <main className="plans-view">{error ? <p className="error">{error}</p> : <p className="muted">Chargement…</p>}</main>;
  const current = plans.filter(live);
  const past = plans.filter((p) => !live(p) && !(p.status === "cancelled" && p.refs.replacedBy));
  return (
    <main className="plans-view">
      <header className="plans-intro">
        <h2>Plans de production</h2>
        <p className="muted">
          Un objectif qui touche plusieurs métiers, découpé en étapes : les chantiers, les visuels du Directeur artistique et les sons du directeur sonore s'enchaînent seuls,
          puis une vérification d'ensemble contrôle chaque critère dans le jeu. Vous validez le plan et faites vos choix ; le reste avance sans vous.
        </p>
      </header>
      {current.length === 0 && (
        <div className="plans-empty">
          <Icon name="sparkle" size={22} />
          <p>
            Aucun plan en cours. Dans une discussion, demandez au Directeur une fonctionnalité qui demande du code <b>et</b> des visuels ou des sons (« un boss avec son look et son
            rugissement ») : il vous propose un plan à valider.
          </p>
        </div>
      )}
      <div className="plans-list">
        {current.map((p) => (
          <PlanCard key={p.id} slug={slug} id={p.id} initial={p} />
        ))}
      </div>
      {past.length > 0 && (
        <details className="plans-past">
          <summary>Historique ({past.length})</summary>
          <div className="plans-list">
            {past.map((p) => (
              <PlanCard key={p.id} slug={slug} id={p.id} initial={p} compact />
            ))}
          </div>
        </details>
      )}
    </main>
  );
}
