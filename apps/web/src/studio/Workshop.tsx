import { useCallback, useEffect, useState } from "react";
import { api, type RunEvent, type TaskRow } from "../api.ts";
import { TryButton } from "./Preview.tsx";
import { RatingBox } from "./Rating.tsx";
import { StatusBadge } from "../pages/TasksView.tsx";
import { ago } from "./agents.ts";
import { useNow } from "./context.tsx";

const ACTIVE = new Set(["draft", "planning", "plan_review", "approved", "running", "review", "changes_requested"]);

/** L'état d'un visuel attendu par un chantier, en clair (ADR-64). */
function visualLabel(v: NonNullable<TaskRow["visuals"]>[number]): string {
  if (v.status === "integre") return "dans le jeu";
  if (v.status === "integration") return "en intégration";
  if (v.status === "valide") return "validé";
  if (v.status === "ecarte") return "mis de côté";
  if (v.status === "production" || v.status === "a_valider" || v.launched) return "chez le DA";
  return "provisoire";
}

/** Panneau de droite en mode atelier : les chantiers en cours et ce qu'il reste à faire de votre côté. */
export function WorkshopPanel({ slug }: { slug: string }) {
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const now = useNow(30_000);
  const load = useCallback(() => api.tasks(slug).then(setTasks), [slug]);
  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
    const t = setInterval(() => load().catch(() => {}), 3000);
    return () => clearInterval(t);
  }, [load]);

  // En cours d'abord (le plus récent en haut), puis les chantiers prêts à lancer, dans l'ordre prévu.
  // La file dans son vrai ordre (ADR-64) : une intégration de visuel passe devant, les brouillons à la fin.
  const rank = (t: TaskRow) => (t.status !== "draft" ? 0 : t.queue_rank ? t.queue_rank : 10_000);
  const active = tasks
    .filter((t) => ACTIVE.has(t.status))
    .sort((a, b) => rank(a) - rank(b) || (a.status !== "draft" ? (b.updated_at > a.updated_at ? 1 : -1) : a.id > b.id ? 1 : -1));
  const done = tasks.filter((t) => t.status === "merged").sort((a, b) => (b.updated_at > a.updated_at ? 1 : -1)).slice(0, 5);
  const action = (t: TaskRow) =>
    t.pending_escalations > 0
      ? "Une autorisation vous attend"
      : t.status === "draft"
        ? t.queued_at
          ? null
          : "Prêt à lancer"
        : t.status === "review"
        ? "Votre avis : dites « fusionne » ou ce qu'il faut corriger"
        : t.status === "plan_review"
          ? "Plan à valider"
          : null;

  return (
    <aside className="panel workshop-panel">
      <div className="proposal-head">
        <h2 className="grow">Chantiers</h2>
        <TryButton slug={slug} label="▶ Lancer le jeu" small />
      </div>
      {error && <p className="error small">{error}</p>}
      {active.length === 0 && <p className="muted small">Aucun chantier en cours. Quand une proposition du directeur vous va, dites « go ».</p>}
      <ul className="workshop-list">
        {active.map((t) => {
          const todo = action(t);
          return (
            <li key={t.id} className={todo ? "todo" : ""}>
              <a href={`#/p/${slug}/tasks/${t.id}`}>
                <span className="muted small">{t.id}</span>
                <strong>{t.title}</strong>
                {(t.queue_rank || t.restarted_from) && (
                  <span className="muted small">
                    {t.queue_rank ? `n° ${t.queue_rank} dans la file` : ""}
                    {t.queue_rank && t.restarted_from ? " · " : ""}
                    {t.restarted_from ? `repris après un redémarrage (ancien ${t.restarted_from})` : ""}
                  </span>
                )}
                {t.visuals && t.visuals.length > 0 && (
                  <span className="task-visuals">
                    {t.visuals.map((v) => (
                      <span key={v.id} className={`visual-chip vs-${v.status}${v.launched ? " launched" : ""}`} title={`${v.id} « ${v.name} » : ${visualLabel(v)}`}>
                        {v.id} · {visualLabel(v)}
                      </span>
                    ))}
                  </span>
                )}
                <span className="row">
                  <StatusBadge status={t.status} queued={!!t.queued_at} />
                  <span className="muted small">{ago(t.updated_at, now)}</span>
                  {t.cost_usd > 0 && <span className="muted small" title="Équivalent API, pris sur votre abonnement">≈ {money(t.cost_usd)}</span>}
                </span>
                {todo && <span className="todo-label">→ {todo}</span>}
              </a>
              {["planning", "approved", "running"].includes(t.status) && <LiveLog slug={slug} task={t.id} />}
              {t.status === "draft" && !t.queued_at && <StartButton slug={slug} task={t.id} onStarted={load} />}
              {t.status === "review" && (
                <div className="row review-actions">
                  <TryButton slug={slug} task={t.id} small />
                  <a className="small" href={`#/p/${slug}/tasks/${t.id}`}>
                    Voir les changements →
                  </a>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {done.length > 0 && (
        <section className="recent-bible">
          <h3>Fusionnés récemment</h3>
          <ul>
            {done.map((t) => (
              <li key={t.id}>
                <span className="row">
                  <a className="grow" href={`#/p/${slug}/tasks/${t.id}`}>{t.title}</a>
                  <RatingBox slug={slug} task={t.id} initial={t.rating} compact />
                </span>
                <span className="muted small">{ago(t.updated_at, now)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}

/** Ce que fait le développeur en ce moment, comme dans une fenêtre Claude Code. */
function LiveLog({ slug, task }: { slug: string; task: string }) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const d = await api.task(slug, task);
      const run = d.runs.at(-1);
      if (run && alive) setEvents((await api.runEvents(slug, task, run.id, 0)).slice(-6));
    };
    tick().catch(() => {});
    const t = setInterval(() => tick().catch(() => {}), 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [slug, task]);
  if (!events.length) return null;
  return (
    <ul className="live-log">
      {events.map((e) => (
        <li key={e.seq} className={`ev-${e.type}`}>
          {e.text.split("\n")[0]!.slice(0, 160)}
        </li>
      ))}
    </ul>
  );
}

export const money = (usd: number) => `${usd.toFixed(2).replace(".", ",")} $`;

function StartButton({ slug, task, onStarted }: { slug: string; task: string; onStarted: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="row review-actions">
      <button
        className="small"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await api.startTask(slug, task);
            await onStarted();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Lancement…" : "▶ Lancer ce chantier"}
      </button>
      {error && <span className="error small">{error}</span>}
    </div>
  );
}
