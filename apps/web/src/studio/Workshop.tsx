import { useCallback, useEffect, useState } from "react";
import { api, type RunEvent, type TaskRow } from "../api.ts";
import { TryButton } from "./Preview.tsx";
import { StatusBadge } from "../pages/TasksView.tsx";
import { ago } from "./agents.ts";
import { useNow } from "./context.tsx";

const ACTIVE = new Set(["draft", "planning", "plan_review", "approved", "running", "review", "changes_requested"]);

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

  const active = tasks.filter((t) => ACTIVE.has(t.status)).sort((a, b) => (b.updated_at > a.updated_at ? 1 : -1));
  const done = tasks.filter((t) => t.status === "merged").sort((a, b) => (b.updated_at > a.updated_at ? 1 : -1)).slice(0, 5);
  const action = (t: TaskRow) =>
    t.pending_escalations > 0
      ? "Une autorisation vous attend"
      : t.status === "review"
        ? "À relire et fusionner"
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
                <span className="row">
                  <StatusBadge status={t.status} />
                  <span className="muted small">{ago(t.updated_at, now)}</span>
                </span>
                {todo && <span className="todo-label">→ {todo}</span>}
              </a>
              {["planning", "approved", "running"].includes(t.status) && <LiveLog slug={slug} task={t.id} />}
              {t.status === "review" && (
                <div className="row review-actions">
                  <TryButton slug={slug} task={t.id} small />
                  <a className="small" href={`#/p/${slug}/tasks/${t.id}`}>
                    Voir les changements et fusionner →
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
                <a href={`#/p/${slug}/tasks/${t.id}`}>{t.title}</a>
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
