import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { navigate } from "../App.tsx";
import { api, type Idea } from "../api.ts";
import { AgentAvatar } from "./AgentAvatar.tsx";
import { ago } from "./agents.ts";
import { useNow } from "./context.tsx";
import { Icon } from "./Icon.tsx";
import { Linkify } from "./Linkify.tsx";
import { splitTeam, TeamCards } from "./TeamCards.tsx";

const stagger = (i: number) => ({ "--i": i }) as CSSProperties;
const STATUS: Record<Idea["status"], string> = { idee: "Idée", projet: "Devenue un projet", archivee: "De côté" };

/**
 * L'Atelier d'idées (ADR-100) : vos idées de jeux et vos inspirations, avant les projets. Le Concepteur les enrichit et
 * les relie ; quand une idée est mûre, « En faire un projet » la lui confie pour concevoir le jeu.
 */
export function IdeasHome() {
  const now = useNow(30_000);
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [draft, setDraft] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.ideas().then(setIdeas, (e: Error) => setError(e.message)), []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!ideas.some((i) => i.thinking)) return;
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [ideas, load]);

  async function create() {
    if (!draft.trim()) return;
    setError(null);
    try {
      const idea = await api.createIdea(draft.trim());
      setDraft("");
      navigate({ page: "idea", id: idea.id });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const shown = ideas.filter((i) => showArchived || i.status !== "archivee");
  const archived = ideas.filter((i) => i.status === "archivee").length;

  return (
    <main className="studio-page ideas-page">
      <header className="studio-hero">
        <div>
          <h1>Atelier d'idées</h1>
          <p className="hero-sub">
            Vos idées de jeux et ce qui vous inspire, avant qu'elles deviennent des projets. Notez-les en vrac ; le Concepteur les enrichit, cherche des références et relie celles qui se ressemblent. Quand l'une est mûre, il en fait la conception du jeu.
          </p>
        </div>
      </header>
      {error && <p className="error">{error}</p>}

      <section className="panel-card idea-new">
        <textarea
          value={draft}
          rows={3}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) void create();
          }}
          placeholder="Une idée, une envie, une ambiance… même en une phrase. (Ctrl + Entrée)"
        />
        <div className="row">
          <button onClick={() => void create()} disabled={!draft.trim()}>
            <Icon name="plus" size={16} /> Noter l'idée
          </button>
        </div>
      </section>

      {shown.length === 0 && <p className="muted">Aucune idée pour l'instant. La première commence ci-dessus.</p>}
      <div className="idea-grid">
        {shown.map((i, k) => (
          <a key={i.id} href={`#/idees/${i.id}`} className={`idea-card status-${i.status}`} style={stagger(k)}>
            <span className="idea-card-head">
              <b>{i.title}</b>
              {i.thinking ? <span className="live-dot" title="Le Concepteur y travaille" /> : <span className={`badge ${i.status === "projet" ? "ok" : ""}`}>{STATUS[i.status]}</span>}
            </span>
            <span className="idea-card-pitch">{(i.insight?.pitch || (i.body.trim() === i.title ? "" : i.body)).slice(0, 220) || (i.inspirations.length ? "(seulement des inspirations)" : "À enrichir avec le Concepteur")}</span>
            <span className="muted small">
              {i.inspirations.length} inspiration(s){i.insight ? " · enrichie" : ""} · {ago(i.updated_at, now)}
            </span>
          </a>
        ))}
      </div>
      {archived > 0 && (
        <button className="secondary small" onClick={() => setShowArchived((s) => !s)}>
          {showArchived ? "Masquer les idées mises de côté" : `Voir les idées mises de côté (${archived})`}
        </button>
      )}
    </main>
  );
}

export function IdeaView({ id }: { id: string }) {
  const now = useNow(30_000);
  const [idea, setIdea] = useState<Idea | null>(null);
  const [all, setAll] = useState<Idea[]>([]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [url, setUrl] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [i, list] = await Promise.all([api.idea(id), api.ideas()]);
    setIdea(i);
    setAll(list);
    return i;
  }, [id]);
  useEffect(() => {
    load().then(
      (i) => {
        setTitle(i.title);
        setBody(i.body);
      },
      (e: Error) => setError(e.message),
    );
  }, [load]);
  useEffect(() => {
    if (!idea?.thinking) return;
    const t = setInterval(() => void load().catch(() => {}), 3000);
    return () => clearInterval(t);
  }, [idea?.thinking, load]);

  const act = async (fn: () => Promise<Idea | unknown>) => {
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!idea) return <main className="studio-page">{error ? <p className="error">{error}</p> : <p className="muted">Chargement…</p>}</main>;
  const dirty = title !== idea.title || body !== idea.body;
  const save = () => (dirty ? act(() => api.updateIdea(id, { title, body })) : Promise.resolve());
  const insight = idea.insight;
  const team = insight?.team ? splitTeam(insight.team) : null;
  const byId = new Map(all.map((i) => [i.id, i]));

  return (
    <main className="studio-page idea-page">
      <a href="#/idees" className="back-link">
        ← Atelier d'idées
      </a>
      {error && <p className="error">{error}</p>}
      <div className="idea-layout">
        <section className="idea-main">
          <input className="idea-title" value={title} maxLength={80} onChange={(e) => setTitle(e.target.value)} onBlur={() => void save()} aria-label="Titre de l'idée" />
          <p className="muted small">
            {STATUS[idea.status]} · notée {ago(idea.created_at, now)}
          </p>
          <textarea className="idea-body" value={body} rows={8} onChange={(e) => setBody(e.target.value)} onBlur={() => void save()} placeholder="Ce que vous imaginez : l'envie, l'ambiance, ce qu'on y ferait…" />
          {dirty && (
            <button className="small" onClick={() => void save()}>
              Enregistrer
            </button>
          )}

          <h2>Inspirations</h2>
          <ul className="idea-inspirations">
            {idea.inspirations.map((x) => (
              <li key={x.id}>
                <div className="grow">
                  {x.url && (
                    <a href={x.url} target="_blank" rel="noreferrer" className="idea-link">
                      {x.url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 80)}
                    </a>
                  )}
                  {x.note && <p className="small">{x.note}</p>}
                </div>
                <button className="icon-btn" aria-label="Retirer" title="Retirer" onClick={() => void act(() => api.removeInspiration(id, x.id))}>
                  <Icon name="close" size={14} />
                </button>
              </li>
            ))}
            {idea.inspirations.length === 0 && <li className="muted small">Un jeu, un film, une image, une vidéo, une musique… ce qui vous a donné envie.</li>}
          </ul>
          <form
            className="idea-add"
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                await api.addInspiration(id, { url: url.trim() || null, note: note.trim() });
                setUrl("");
                setNote("");
              });
            }}
          >
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Lien (https://…)" />
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ce qui vous plaît dedans" />
            <button type="submit" className="secondary" disabled={!url.trim() && !note.trim()}>
              Ajouter
            </button>
          </form>

          <div className="row idea-actions">
            {idea.status !== "projet" && (
              <button className="secondary small" onClick={() => void act(() => api.updateIdea(id, { status: idea.status === "archivee" ? "idee" : "archivee" }))}>
                {idea.status === "archivee" ? "Remettre dans l'atelier" : "Mettre de côté"}
              </button>
            )}
            <button
              className="secondary small"
              onClick={() => {
                if (!window.confirm("Supprimer cette idée et ses inspirations ?")) return;
                void api.deleteIdea(id).then(() => navigate({ page: "ideas" }), (e: Error) => setError(e.message));
              }}
            >
              Supprimer
            </button>
          </div>
        </section>

        <aside className="idea-side panel-card">
          <header className="idea-side-head">
            <AgentAvatar agent="concepteur" state={idea.thinking ? "working" : "idle"} size={44} />
            <div className="grow">
              <p className="eyebrow">Le Concepteur</p>
              <b>{idea.thinking ? "Je lis vos inspirations et je cherche…" : insight ? `Enrichie ${ago(insight.at, now)}` : "Pas encore enrichie"}</b>
            </div>
          </header>
          {idea.error && !idea.thinking && <p className="error small">{idea.error}</p>}
          <div className="row">
            <button onClick={() => void act(async () => (dirty && (await api.updateIdea(id, { title, body })), api.enrichIdea(id)))} disabled={idea.thinking}>
              <Icon name="sparkle" size={16} /> {insight ? "Enrichir à nouveau" : "Enrichir avec le Concepteur"}
            </button>
            {idea.status === "projet" && idea.conception ? (
              <button className="secondary" onClick={() => navigate({ page: "conception", id: idea.conception! })}>
                Voir la conception →
              </button>
            ) : (
              <button
                className="secondary"
                disabled={idea.thinking}
                onClick={() =>
                  void act(async () => {
                    if (dirty) await api.updateIdea(id, { title, body });
                    const r = await api.ideaToProject(id);
                    navigate({ page: "conception", id: r.conception });
                  })
                }
              >
                En faire un projet
              </button>
            )}
          </div>
          {insight && (
            <div className="idea-insight">
              <p className="idea-pitch">{insight.pitch}</p>
              {insight.synthese && (
                <div className="text small">
                  <Linkify text={insight.synthese} />
                </div>
              )}
              {insight.pistes.length > 0 && (
                <>
                  <h3>Pistes</h3>
                  <ul>
                    {insight.pistes.map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </>
              )}
              {insight.questions.length > 0 && (
                <>
                  <h3>Ce qui décidera de la forme du jeu</h3>
                  <ul>
                    {insight.questions.map((q) => (
                      <li key={q}>{q}</li>
                    ))}
                  </ul>
                </>
              )}
              {insight.references.length > 0 && (
                <>
                  <h3>Références</h3>
                  <ul className="idea-refs">
                    {insight.references.map((r) => (
                      <li key={r.titre}>
                        {r.url ? (
                          <a href={r.url} target="_blank" rel="noreferrer">
                            {r.titre}
                          </a>
                        ) : (
                          <b>{r.titre}</b>
                        )}{" "}
                        <span className="muted small">— {r.pourquoi}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {insight.liees.length > 0 && (
                <>
                  <h3>Idées proches</h3>
                  <ul>
                    {insight.liees.map((l) => (
                      <li key={l.id}>
                        <a href={`#/idees/${l.id}`}>{byId.get(l.id)?.title ?? "Idée"}</a> <span className="muted small">— {l.pourquoi}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {team && <TeamCards consults={team.consults} memories={team.memories} />}
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}
