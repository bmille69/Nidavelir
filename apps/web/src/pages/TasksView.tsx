import { useCallback, useEffect, useRef, useState } from "react";
import { navigate } from "../App.tsx";
import { api, type Escalation, type Review, type RunEvent, type TaskDetail, type TaskRow } from "../api.ts";
import { formatDate } from "./labels.ts";
import { TryButton } from "../studio/Preview.tsx";

export const TASK_STATUS: Record<string, { label: string; tone: "muted" | "accent" | "warn" | "ok" | "error" }> = {
  draft: { label: "Brouillon", tone: "muted" },
  planning: { label: "Plan en préparation", tone: "accent" },
  plan_review: { label: "Plan à valider", tone: "warn" },
  approved: { label: "Plan validé", tone: "accent" },
  running: { label: "En cours", tone: "accent" },
  review: { label: "À relire", tone: "warn" },
  merged: { label: "Fusionnée", tone: "ok" },
  changes_requested: { label: "Corrections demandées", tone: "accent" },
  rejected: { label: "Plan refusé", tone: "muted" },
  cancelled: { label: "Arrêtée", tone: "muted" },
  abandoned: { label: "Abandonnée", tone: "muted" },
  failed: { label: "Échec", tone: "error" },
};

const LIVE = new Set(["planning", "running", "approved"]);

export function StatusBadge({ status }: { status: string }) {
  const s = TASK_STATUS[status] ?? { label: status, tone: "muted" };
  return <span className={`badge status-${s.tone}`}>{s.label}</span>;
}

export function TasksView({ slug, taskId }: { slug: string; taskId?: string }) {
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => api.tasks(slug).then(setTasks, (e: Error) => setError(e.message)), [slug]);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 4000);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <main className="tasks-layout">
      <aside className="threads">
        <h2>Chantiers</h2>
        <p className="muted small">Pour en lancer un : dites « go » au directeur dans la discussion, ou « Faire réaliser » sur un point de « Le jeu ».</p>
        {error && <p className="error small">{error}</p>}
        <ul>
          {tasks.map((t) => (
            <li key={t.id}>
              <a className={t.id === taskId ? "active" : ""} href={`#/p/${slug}/tasks/${t.id}`}>
                <span className="small muted">{t.id}</span> {t.title}
                <div className="row">
                  <StatusBadge status={t.status} />
                  {t.pending_escalations > 0 && <span className="badge warn pulse">{t.pending_escalations} demande(s)</span>}
                </div>
              </a>
            </li>
          ))}
        </ul>
        {tasks.length === 0 && <p className="muted small">Aucune tâche pour l'instant.</p>}
      </aside>
      <section className="page wide">
        {taskId ? (
          <TaskPage key={taskId} slug={slug} id={taskId} onChange={refresh} />
        ) : (
          <div className="card empty">
            <h1>Faire travailler le développeur</h1>
            <ol className="steps-explained">
              <li>Vous choisissez une décision validée à implémenter.</li>
              <li>Le développeur (Claude Code) lit le code et propose un <strong>plan</strong> : quels fichiers, quelles commandes. Il ne modifie rien.</li>
              <li>Vous <strong>validez le plan</strong>. Il travaille alors dans une copie séparée de votre jeu, limitée à ce plan.</li>
              <li>S'il veut faire autre chose, il <strong>vous demande</strong>. Sans réponse, c'est non.</li>
              <li>Le QA vérifie. Vous relisez, puis vous <strong>fusionnez</strong> dans votre jeu ou vous abandonnez.</li>
            </ol>
          </div>
        )}
      </section>
    </main>
  );
}

function TaskPage({ slug, id, onChange }: { slug: string; id: string; onChange: () => void }) {
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const [review, setReview] = useState<Review | null>(null);
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const eventsRun = useRef<string | null>(null);

  const load = useCallback(async () => {
    const d = await api.task(slug, id);
    setDetail(d);
    const last = d.runs.at(-1);
    if (last) {
      if (eventsRun.current !== last.id) {
        eventsRun.current = last.id;
        setEvents([]);
      }
      const after = 0;
      setEvents(await api.runEvents(slug, id, last.id, after));
    }
    if (["review", "merged"].includes(d.task.status) || (d.task.branch && ["failed", "cancelled"].includes(d.task.status))) {
      setReview(await api.review(slug, id).catch(() => null));
    } else setReview(null);
  }, [slug, id]);

  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
  }, [load]);

  const live = !!detail && (LIVE.has(detail.task.status) || detail.escalations.some((e) => e.status === "pending"));
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => load().catch(() => {}), 2000);
    return () => clearInterval(t);
  }, [live, load]);

  async function act(fn: () => Promise<unknown>, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
      onChange();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!detail) return <p className="muted">{error ?? "Chargement…"}</p>;
  const { task, plan, escalations, decisions } = detail;
  const pending = escalations.filter((e) => e.status === "pending");
  const lastRun = detail.runs.at(-1);

  return (
    <div className="task-page">
      <div className="card">
        <div className="proposal-head">
          <h1 className="grow">{task.title}</h1>
          <StatusBadge status={task.status} />
        </div>
        <p className="muted small">
          {task.id} · créée le {formatDate(task.created_at)}
          {task.origin && (
            <>
              {" "}· lancée depuis{" "}
              <a href={`#/p/${slug}/t/${task.origin.thread}`}>la discussion</a>
            </>
          )}
          {decisions.length > 0 && " · autorisée par "}
          {decisions.map((d) => (
            <span key={d.id} className="badge" title={d.statement}>
              {d.id} {d.title}
            </span>
          ))}
        </p>
        <p className="statement">{task.goal}</p>
        {task.feedback.length > 0 && (
          <div className="notice small">
            <strong>Vos remarques transmises au développeur :</strong>
            <ul>
              {task.feedback.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          </div>
        )}
        {["draft", "rejected", "failed", "cancelled"].includes(task.status) && (
          <div className="row">
            <button disabled={busy} onClick={() => act(() => api.startPlan(slug, id))}>
              {task.status === "draft" ? "Demander un plan au développeur" : "Demander un nouveau plan"}
            </button>
            {task.status !== "draft" && (
              <button className="secondary danger" disabled={busy} onClick={() => act(() => api.abandonTask(slug, id), "Abandonner cette tâche ? Sa copie de travail sera supprimée.")}>
                Abandonner
              </button>
            )}
          </div>
        )}
        {task.status === "failed" && lastRun?.error && <p className="error small">Dernière erreur : {lastRun.error}</p>}
      </div>

      {error && <p className="error">{error}</p>}

      {pending.map((e) => (
        <EscalationCard key={e.id} esc={e} busy={busy} onDecide={(allowed) => act(() => api.decideEscalation(slug, e.id, allowed))} />
      ))}

      {task.status === "plan_review" && plan && (
        <PlanCard
          plan={plan}
          busy={busy}
          onApprove={() =>
            act(async () => {
              await api.approvePlan(slug, id, plan.hash);
              await api.execute(slug, id);
            })
          }
          onReject={(n) => act(() => api.rejectPlan(slug, id, n || undefined))}
        />
      )}

      {lastRun && (LIVE.has(task.status) || events.length > 0) && (
        <div className="card">
          <div className="proposal-head">
            <h2 className="grow">
              {{ plan: "Préparation du plan", execute: "Travail du développeur", verify: "Vérification par le QA" }[lastRun.kind]}
              {lastRun.status === "running" ? " — en direct" : ""}
            </h2>
            {LIVE.has(task.status) && task.status !== "approved" && (
              <button className="secondary danger small" disabled={busy} onClick={() => act(() => api.cancelTask(slug, id), "Arrêter immédiatement le travail en cours ?")}>
                Arrêter
              </button>
            )}
          </div>
          <ul className="events">
            {events.map((ev) => (
              <li key={ev.seq} className={`ev-${ev.type}`}>
                {ev.text}
              </li>
            ))}
            {lastRun.status === "running" && <li className="muted">…</li>}
          </ul>
        </div>
      )}

      {review && <ReviewCard review={review} busy={busy} slug={slug} id={id} act={act} note={note} setNote={setNote} />}

      {plan && task.status !== "plan_review" && (
        <details className="card">
          <summary>Plan validé ({plan.id})</summary>
          <PlanBody plan={plan} />
        </details>
      )}
    </div>
  );
}

function EscalationCard({ esc, busy, onDecide }: { esc: Escalation; busy: boolean; onDecide: (allowed: boolean) => void }) {
  const content = typeof esc.input.content === "string" ? esc.input.content : typeof esc.input.new_string === "string" ? esc.input.new_string : null;
  return (
    <div className="card escalation">
      <strong>✋ Le développeur vous demande l'autorisation</strong>
      <p className="statement">{esc.summary}</p>
      <p className="muted small">Pourquoi on vous demande : {esc.reason}.</p>
      {content && (
        <details>
          <summary className="small">Voir le contenu proposé</summary>
          <pre className="code">{content.slice(0, 4000)}</pre>
        </details>
      )}
      <div className="row">
        <button disabled={busy} onClick={() => onDecide(true)}>
          Autoriser cette fois
        </button>
        <button className="secondary danger" disabled={busy} onClick={() => onDecide(false)}>
          Refuser
        </button>
        <span className="muted small">Sans réponse dans 15 minutes, c'est refusé.</span>
      </div>
    </div>
  );
}

function PlanBody({ plan }: { plan: NonNullable<TaskDetail["plan"]> }) {
  const list = (title: string, items: string[], cls = "") =>
    items.length > 0 && (
      <div className={cls}>
        <strong className="small">{title}</strong>
        <ul className="files">
          {items.map((f) => (
            <li key={f}>
              <code>{f}</code>
            </li>
          ))}
        </ul>
      </div>
    );
  return (
    <>
      <p className="statement">{plan.summary_simple}</p>
      <details>
        <summary className="small">Détail technique</summary>
        <p className="small">{plan.summary}</p>
        <ol className="small">
          {plan.steps.map((s, k) => (
            <li key={k}>{s.description}</li>
          ))}
        </ol>
      </details>
      <div className="plan-grid">
        {list("Fichiers créés", plan.files_to_create)}
        {list("Fichiers modifiés", plan.files_to_modify)}
        {list("Fichiers supprimés", plan.files_to_delete, "warn-box")}
        {list("Commandes lancées", plan.commands.map((c) => `${c.cmd} — ${c.purpose}`))}
      </div>
      <div>
        <strong className="small">Ce qui sera vérifié</strong>
        <ul className="small">
          {plan.acceptance_criteria.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </div>
      {plan.new_dependencies.length > 0 && (
        <div className="replace small">
          <strong>Nouvelles dépendances (bibliothèques téléchargées) :</strong>
          <ul>
            {plan.new_dependencies.map((d) => (
              <li key={d.name}>
                {d.name}@{d.version} : {d.why}
              </li>
            ))}
          </ul>
        </div>
      )}
      {[...plan.risks.map((r) => `Risque : ${r}`), ...plan.assumptions.map((a) => `Hypothèse : ${a}`)].length > 0 && (
        <ul className="small muted">
          {plan.risks.map((r) => (
            <li key={r}>Risque : {r}</li>
          ))}
          {plan.assumptions.map((a) => (
            <li key={a}>Hypothèse : {a}</li>
          ))}
        </ul>
      )}
      {plan.questions.length > 0 && (
        <div className="questions">
          <strong className="small">Questions du développeur</strong>
          <ul>
            {plan.questions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

function PlanCard({ plan, busy, onApprove, onReject }: { plan: NonNullable<TaskDetail["plan"]>; busy: boolean; onApprove: () => void; onReject: (note: string) => void }) {
  const [note, setNote] = useState("");
  return (
    <div className="card proposal">
      <h2>Le plan proposé</h2>
      {plan.problems.length > 0 && (
        <div className="error-box">
          <strong>Ce plan ne peut pas être validé :</strong>
          <ul>
            {plan.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </div>
      )}
      <PlanBody plan={plan} />
      <p className="notice small">
        En validant, vous autorisez <strong>uniquement</strong> ces fichiers et ces commandes, dans une copie séparée de votre jeu. Votre projet ne
        sera modifié que si vous fusionnez à la fin.
      </p>
      <div className="row">
        <button disabled={busy || plan.problems.length > 0} onClick={onApprove}>
          Valider le plan et lancer le travail
        </button>
        <input className="grow" placeholder="Remarque pour un nouveau plan (facultatif)" value={note} onChange={(e) => setNote(e.target.value)} />
        <button className="secondary danger" disabled={busy} onClick={() => onReject(note)}>
          Refuser le plan
        </button>
      </div>
    </div>
  );
}

function ReviewCard(props: {
  review: Review;
  busy: boolean;
  slug: string;
  id: string;
  act: (fn: () => Promise<unknown>, confirmText?: string) => Promise<void>;
  note: string;
  setNote: (s: string) => void;
}) {
  const { review, busy, slug, id, act } = props;
  const v = review.verification;
  const isReview = review.task.status === "review";
  const unplanned = review.files.filter((f) => !f.planned);
  return (
    <div className="card">
      <h2>{isReview ? "Le résultat, à relire" : "Résultat"}</h2>
      {review.report && <p className="statement">{review.report.summary_simple}</p>}
      {(isReview || review.task.status === "merged") && (
        <div className="how-to-test">
          <div className="row">
            <strong className="grow">Essayer en jouant</strong>
            <TryButton slug={slug} task={isReview ? id : undefined} label={isReview ? "▶ Essayer cette version" : "▶ Lancer le jeu"} />
          </div>
          {review.report?.how_to_test?.length ? (
            <ol className="small">
              {review.report.how_to_test.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
          ) : (
            <p className="muted small">Le jeu s'ouvre dans un nouvel onglet, avec les modifications de ce chantier, sans toucher à votre jeu.</p>
          )}
        </div>
      )}
      {v && (
        <div className={`verdict verdict-${v.verdict}`}>
          <strong>
            Vérification du QA :{" "}
            {{ pass: "tout est conforme", pass_with_notes: "conforme, avec remarques", fail: "problèmes trouvés" }[v.verdict]}
          </strong>
          <p className="small">{v.summary_simple}</p>
          <ul className="small">
            {v.checks.map((c) => (
              <li key={c.criterion}>
                {c.result === "pass" ? "✓" : c.result === "fail" ? "✗" : "?"} {c.criterion}
                <span className="muted"> — {c.evidence}</span>
              </li>
            ))}
            {v.regressions.map((r) => (
              <li key={r}>⚠ Régression possible : {r}</li>
            ))}
          </ul>
        </div>
      )}
      {review.report?.deviations.length ? (
        <div className="notice small">
          <strong>Écarts déclarés par le développeur :</strong>
          <ul>
            {review.report.deviations.map((d) => (
              <li key={d.what}>
                {d.what} — {d.why}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div>
        <strong className="small">
          {review.files.length} fichier(s) changé(s){unplanned.length ? ` · dont ${unplanned.length} hors plan (autorisé(s) par vous)` : ""}
        </strong>
        <Diff patch={review.patch} files={review.files} />
      </div>
      {isReview && (
        <>
          <div className="row">
            <button
              disabled={busy || !review.head}
              onClick={() => act(() => api.merge(slug, id, review.head!), "Fusionner ces modifications dans votre jeu ? (annulable ensuite avec Git)")}
            >
              Fusionner dans mon jeu
            </button>
            <button className="secondary danger" disabled={busy} onClick={() => act(() => api.abandonTask(slug, id), "Abandonner ? Les modifications seront supprimées, votre jeu reste intact.")}>
              Abandonner
            </button>
          </div>
          <div className="row">
            <input className="grow" placeholder="Ce qu'il faut corriger…" value={props.note} onChange={(e) => props.setNote(e.target.value)} />
            <button
              className="secondary"
              disabled={busy || !props.note.trim()}
              onClick={() =>
                act(async () => {
                  await api.requestChanges(slug, id, props.note);
                  props.setNote("");
                })
              }
            >
              Demander des corrections
            </button>
          </div>
        </>
      )}
      {review.task.status === "merged" && <p className="notice">✓ Fusionné dans votre jeu. Annulable avec un « git revert » du commit de fusion.</p>}
    </div>
  );
}

function Diff({ patch, files }: { patch: string; files: Review["files"] }) {
  const blocks = patch.split(/^(?=diff --git )/m).filter((b) => b.startsWith("diff --git"));
  return (
    <div className="diff">
      {blocks.map((b) => {
        const path = /^diff --git a\/(.+?) b\//.exec(b)?.[1] ?? "?";
        const meta = files.find((f) => f.path === path);
        const lines = b.split("\n").filter((l) => !/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode)/.test(l));
        return (
          <details key={path} open={blocks.length <= 3}>
            <summary>
              <code>{path}</code> {meta?.status === "A" ? <span className="badge">nouveau</span> : meta?.status === "D" ? <span className="badge warn">supprimé</span> : null}
              {meta && !meta.planned && <span className="badge warn">hors plan</span>}
            </summary>
            <pre className="code">
              {lines.map((l, k) => (
                <span key={k} className={l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : l.startsWith("@@") ? "hunk" : ""}>
                  {l}
                  {"\n"}
                </span>
              ))}
            </pre>
          </details>
        );
      })}
      {blocks.length === 0 && <p className="muted small">Aucune modification.</p>}
    </div>
  );
}

/** Bouton « Faire implémenter » sur une décision validée. */
export function ImplementButton({ slug, decision }: { slug: string; decision: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className="secondary small"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          const t = await api.createTask(slug, [decision]);
          navigate({ page: "project", slug, view: "tasks", task: t.id });
        } finally {
          setBusy(false);
        }
      }}
    >
      Faire réaliser
    </button>
  );
}
