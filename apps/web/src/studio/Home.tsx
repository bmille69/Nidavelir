import { useEffect, useState } from "react";
import { navigate } from "../App.tsx";
import { api, slugify, type TaskRow } from "../api.ts";
import { AgentAvatar } from "./AgentAvatar.tsx";
import { AGENTS, ago, describeEvent } from "./agents.ts";
import { AUTONOMY } from "./Autonomy.tsx";
import { useNow, useStudio } from "./context.tsx";
import { Icon } from "./Icon.tsx";
import { KeyImage, latestShot, useStyleImage } from "./KeyImage.tsx";
import banner from "../assets/banner.jpg";

const ENGINE = { godot: "Godot", web: "Web · TypeScript", unknown: "Moteur inconnu" } as const;

function greeting(now: number): string {
  const h = new Date(now).getHours();
  return h < 5 ? "Bonne nuit" : h < 18 ? "Bonjour" : "Bonsoir";
}

/**
 * Accueil : d'abord ce qui vous attend, puis vos jeux (avec la dernière image de chacun),
 * créer, et ce qui vient de se passer. Le studio en direct a sa propre page.
 */
export function Home() {
  const snap = useStudio();
  const now = useNow(30_000);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<Record<string, TaskRow[]>>({});

  const slugs = snap?.projects.map((p) => p.slug).join(",") ?? "";
  useEffect(() => {
    if (!slugs) return;
    let alive = true;
    const load = () =>
      Promise.all(slugs.split(",").map((s) => api.tasks(s).then((t) => [s, t] as const, () => [s, [] as TaskRow[]] as const))).then(
        (rows) => alive && setTasks(Object.fromEntries(rows)),
      );
    void load();
    const t = setInterval(() => void load(), 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [slugs]);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const { project } = await api.createProject({ name: name.trim(), slug: slugify(name) });
      navigate({ page: "project", slug: project.slug });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!snap) return <main className="studio-page muted">Chargement du studio…</main>;
  const names = new Map(snap.projects.map((p) => [p.slug, p.name]));
  const team = snap.agents.filter((a) => a.id !== "you" && a.state !== "idle");
  const forYou = snap.agents.find((a) => a.id === "you")?.activities ?? [];
  const events = snap.events
    .map((e) => ({ e, d: describeEvent(e) }))
    .filter((x) => x.d)
    .slice(0, 7);

  return (
    <main className="studio-page home">
      <header className="home-hero">
        <img className="home-banner" src={banner} alt="" aria-hidden="true" width={1254} height={588} />
        <div className="home-hero-text">
          <p className="eyebrow">
            {new Date(now).toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" })}
          </p>
          <h1>{greeting(now)}.</h1>
          <p className="hero-sub">
            {forYou.length > 0
              ? `${forYou.length} chose${forYou.length > 1 ? "s" : ""} vous attend${forYou.length > 1 ? "ent" : ""}. `
              : "Rien ne vous attend. "}
            {team.length > 0 ? `${team.length} agent${team.length > 1 ? "s" : ""} au travail.` : "L'équipe est au repos."}
          </p>
          <p className="brand-flow" aria-hidden="true">
            <b>Idées</b> <i>›</i> <b>Outils</b> <i>›</i> <b>Jeux</b>
          </p>
        </div>
        <a className={`team-live ${team.length ? "on" : ""}`} href="#/direct" title="Voir le studio en direct">
          <span className="team-faces">
            {(team.length ? team : snap.agents.filter((a) => a.id !== "you").slice(0, 4)).slice(0, 5).map((a) => (
              <AgentAvatar key={a.id} agent={a.id} state={a.state} size={40} />
            ))}
          </span>
          <span className="team-live-text">
            <b>{team.length ? team.map((a) => AGENTS[a.id].name).join(" · ") : "Studio au repos"}</b>
            <small>
              {team.length ? <span className="live-dot" /> : null} Voir le studio en direct <Icon name="arrow" size={14} />
            </small>
          </span>
        </a>
      </header>

      {forYou.length > 0 && (
        <section className="attention">
          <h2>
            <Icon name="bell" size={18} /> Pour vous
          </h2>
          <div className="attention-list">
            {forYou.map((a, k) => (
              <a key={k} href={a.href} className="attention-card">
                <span className="attention-project">{names.get(a.project) ?? (a.project || "Studio")}</span>
                <strong>{a.text}</strong>
                {a.detail && <span className="muted small">{a.detail}</span>}
                <span className="attention-go">
                  Ouvrir <Icon name="arrow" size={14} />
                </span>
              </a>
            ))}
          </div>
        </section>
      )}

      <section>
        <div className="section-head">
          <h2>Vos projets</h2>
        </div>
        {snap.projects.length === 0 && (
          <div className="empty-state">
            <p>Aucun projet pour l'instant.</p>
            <p className="muted">Concevez un nouveau jeu avec le Concepteur, ou importez un jeu existant.</p>
          </div>
        )}
        <div className="project-grid">
          {snap.projects.map((p) => {
            const list = tasks[p.slug] ?? [];
            const merged = list.filter((t) => t.status === "merged");
            const latest = [...list].filter((t) => t.status === "merged" || t.status === "review").sort((a, b) => (b.updated_at > a.updated_at ? 1 : -1))[0];
            const running = list.find((t) => ["running", "approved", "planning"].includes(t.status));
            return (
              <article key={p.slug} className={`project-tile ${p.busy ? "busy" : ""}`}>
                <a className="tile-cover" data-engine={p.engine} href={`#/p/${p.slug}`} aria-hidden="true" tabIndex={-1}>
                  <span className="tile-initial">{p.name.slice(0, 1).toUpperCase()}</span>
                  <TileImage slug={p.slug} shot={latestShot(p.slug, list)} />
                  {p.busy && (
                    <span className="tile-live">
                      <span className="live-dot" /> au travail
                    </span>
                  )}
                  {p.waiting > 0 && <span className="tile-wait">{p.waiting} pour vous</span>}
                </a>
                <div className="tile-body">
                  <div className="tile-title">
                    <h3>
                      <a href={`#/p/${p.slug}`}>{p.name}</a>
                    </h3>
                    <span className="badge">{AUTONOMY[p.autonomy].label}</span>
                  </div>
                  <p className="muted small">
                    {running ? `En cours : ${running.title}` : latest ? `Dernier chantier : ${latest.title}` : ENGINE[p.engine]}
                  </p>
                  <div className="tile-stats">
                    <span>
                      <b>{merged.length}</b> chantier(s) fusionné(s)
                    </span>
                    {p.decisions > 0 && (
                      <span>
                        <b>{p.decisions}</b> décisions
                      </span>
                    )}
                    {p.proposals > 0 && (
                      <span>
                        <b>{p.proposals}</b> propositions
                      </span>
                    )}
                    <span>
                      <b>{p.tasks}</b> tâches
                    </span>
                  </div>
                  <div className="tile-actions">
                    <a href={`#/p/${p.slug}`}>
                      <Icon name="chat" size={16} /> Discuter
                    </a>
                    <a href={`#/p/${p.slug}/tasks`}>
                      <Icon name="hammer" size={16} /> Chantiers
                    </a>
                    <a href={`#/p/${p.slug}/vision`}>
                      <Icon name="book" size={16} /> Le jeu
                    </a>
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section>
        <div className="section-head">
          <h2>Créer</h2>
        </div>
        <div className="create-grid">
          <a className="create-tile express" href="#/express">
            <Icon name="bolt" size={26} />
            <strong>Jeu express</strong>
            <span className="muted small">Une idée, quelques minutes : un jeu jouable tout de suite. Pour essayer une idée ou faire une démonstration.</span>
          </a>
          <a className="create-tile concept" href="#/concevoir">
            <Icon name="sparkle" size={26} />
            <strong>Concevoir un nouveau jeu</strong>
            <span className="muted small">Le Concepteur part de votre idée, pose les bonnes questions et prépare les premiers chantiers.</span>
          </a>
          <button className="create-tile" onClick={() => navigate({ page: "import" })}>
            <Icon name="download" size={26} />
            <strong>Importer un projet existant</strong>
            <span className="muted small">Un jeu déjà commencé dans un dossier : le studio lit ses documents et son code.</span>
          </button>
          <button className={`create-tile ${creating ? "on" : ""}`} onClick={() => setCreating((c) => !c)}>
            <Icon name="folder" size={26} />
            <strong>Nouveau projet vide</strong>
            <span className="muted small">Un dossier, un dépôt Git et c'est parti, sans conception.</span>
          </button>
        </div>
        {creating && (
          <div className="create-box">
            <label>
              Nom du jeu
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ombres du Nord" autoFocus />
            </label>
            {name.trim() && (
              <p className="muted small">
                Dossier créé : <code>{slugify(name)}</code> dans la racine des jeux, avec un dépôt Git et un dossier <code>studio/</code>.
              </p>
            )}
            <button disabled={!name.trim() || busy} onClick={create}>
              {busy ? "Création…" : "Créer le projet"}
            </button>
          </div>
        )}
        {error && <p className="error">{error}</p>}
      </section>

      <section className="panel-card feed">
        <div className="section-head">
          <h2>Ce qui vient de se passer</h2>
          <a href="#/direct" className="small">
            Tout le journal en direct <Icon name="arrow" size={14} />
          </a>
        </div>
        {events.length === 0 && <p className="muted small">Rien pour l'instant. Les actions de l'équipe apparaîtront ici.</p>}
        <ol className="feed-list">
          {events.map(({ e, d }) => (
            <li key={e.seq} className={d!.tone ? `tone-${d!.tone}` : ""}>
              <span className={`feed-dot agent-${d!.agent}`} />
              <div>
                <p>{d!.text}</p>
                <span className="muted small">
                  {names.get(e.project ?? "") ?? e.project} · {ago(e.at, now)}
                </span>
              </div>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}

/** Couverture d'un projet : la dernière capture du jeu prise par le hub (ADR-33), sinon le dégradé. */
/** La couverture d'une tuile : la dernière capture du jeu, sinon le style retenu par la DA (ADR-86). */
function TileImage({ slug, shot }: { slug: string; shot: string | null }) {
  const style = useStyleImage(slug);
  return <KeyImage urls={[shot, style]} className="tile-shot" />;
}
