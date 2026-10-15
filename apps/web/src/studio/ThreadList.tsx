import { useEffect, useRef, useState } from "react";
import { api, type Thread } from "../api.ts";
import { ago } from "./agents.ts";
import { useNow } from "./context.tsx";
import { Icon } from "./Icon.tsx";

/**
 * Ce que vous avez déjà lu, discussion par discussion (dans ce navigateur) : le numéro du dernier
 * message vu. Sert aux pastilles « nouveau ». Stockage local seulement, sans rien au hub.
 */
export function useSeen(slug: string, threads: Thread[], loaded: boolean) {
  const key = `studio:seen:${slug}`;
  const [seen, setSeen] = useState<Record<string, number> | null>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as Record<string, number>) : null;
    } catch {
      return null;
    }
  });
  const save = (next: Record<string, number>) => {
    setSeen(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* stockage indisponible : les pastilles valent pour cette visite seulement */
    }
  };
  // Première visite : tout ce qui existe déjà compte comme lu (pas de pastilles partout).
  useEffect(() => {
    if (loaded && seen === null) save(Object.fromEntries(threads.map((t) => [t.id, t.last_seq ?? 0])));
  }, [loaded, seen === null]);
  const markSeen = (thread: string, seq: number) => {
    if ((seen?.[thread] ?? 0) >= seq) return;
    save({ ...(seen ?? {}), [thread]: seq });
  };
  /** Messages du studio arrivés depuis votre dernier passage dans cette discussion. */
  const unread = (t: Thread) => (seen && t.last_role === "director" ? Math.max(0, (t.last_seq ?? 0) - (seen[t.id] ?? 0)) : 0);
  return { markSeen, unread };
}

/**
 * Discussions du projet, la plus récemment active en haut, avec une pastille quand le studio
 * y a écrit depuis votre dernier passage. Les discussions vides n'apparaissent pas.
 */
export function ThreadList(props: {
  slug: string;
  threads: Thread[];
  current?: string;
  fresh?: boolean;
  unread: (t: Thread) => number;
  onNew: () => void;
  onRenamed: () => void;
}) {
  const { slug, threads, current } = props;
  const now = useNow(30_000);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);

  async function save(id: string) {
    const title = draft.trim();
    setEditing(null);
    if (!title || title === threads.find((t) => t.id === id)?.title) return;
    try {
      await api.renameThread(slug, id, title);
      setError(null);
      props.onRenamed();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const shown = threads.filter((t) => (t.messages ?? 0) > 0 || t.id === current);
  return (
    <aside className="threads">
      <h2>Discussions</h2>
      <button className={`new-thread ${props.fresh ? "on" : ""}`} onClick={props.onNew} title="Une page blanche : la discussion n'est créée qu'à votre premier message">
        <Icon name="plus" size={16} /> Nouvelle discussion
      </button>
      {error && <p className="error small">{error}</p>}
      <ul>
        {shown.map((t) => {
          const n = props.unread(t);
          const active = t.id === current;
          return (
            <li key={t.id} className={n ? "has-news" : ""}>
              {editing === t.id ? (
                <input
                  ref={input}
                  className="thread-rename"
                  value={draft}
                  maxLength={120}
                  aria-label="Nouveau titre de la discussion"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void save(t.id);
                    if (e.key === "Escape") setEditing(null);
                  }}
                  onBlur={() => void save(t.id)}
                />
              ) : (
                <a
                  className={active ? "active" : ""}
                  href={`#/p/${slug}/t/${t.id}`}
                  title={t.title}
                  onDoubleClick={(e) => {
                    e.preventDefault();
                    setDraft(t.title);
                    setEditing(t.id);
                  }}
                >
                  <span className="thread-title">{t.title}</span>
                  <span className="thread-meta">{t.last_at ? ago(t.last_at, now) : ""}</span>
                  {n > 0 && (
                    <span className="count warn" title={`${n} nouveau(x) message(s)`}>
                      {n}
                    </span>
                  )}
                </a>
              )}
              {active && editing !== t.id && (
                <button
                  className="icon-btn thread-edit"
                  aria-label="Renommer cette discussion"
                  title="Renommer"
                  onClick={() => {
                    setDraft(t.title);
                    setEditing(t.id);
                  }}
                >
                  ✎
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
