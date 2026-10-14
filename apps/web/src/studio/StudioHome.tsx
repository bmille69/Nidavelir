import { useState } from "react";
import { navigate } from "../App.tsx";
import { api, slugify } from "../api.ts";
import { ago, describeEvent } from "./agents.ts";
import { useNow, useStudio } from "./context.tsx";
import { OrgChart } from "./OrgChart.tsx";

const ENGINE = { godot: "Godot", web: "Web · TypeScript", unknown: "Moteur inconnu" } as const;

/** Page d'accueil : l'équipe en direct, vos projets et le fil du studio. */
export function StudioHome() {
  const snap = useStudio();
  const now = useNow(15_000);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string | undefined>(undefined);

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
  const working = snap.agents.filter((a) => a.id !== "you" && a.state !== "idle").length;
  const forYou = snap.agents.find((a) => a.id === "you")?.activities.length ?? 0;
  const events = snap.events.map((e) => ({ e, d: describeEvent(e) })).filter((x) => x.d);

  return (
    <main className="studio-page">
      <header className="studio-hero">
        <div>
          <p className="eyebrow">
            <span className="live-dot" /> En direct
          </p>
          <h1>Le studio</h1>
          <p className="hero-sub">
            {working === 0 && forYou === 0 && "Toute l'équipe est au repos. Lancez une discussion pour la mettre au travail."}
            {working > 0 && `${working} agent${working > 1 ? "s" : ""} au travail. `}
            {forYou > 0 && `${forYou} chose${forYou > 1 ? "s" : ""} vous attend${forYou > 1 ? "ent" : ""}.`}
          </p>
        </div>
        <div className="hero-stats">
          <Stat value={snap.projects.length} label="projet(s)" />
          <Stat value={snap.projects.reduce((n, p) => n + p.decisions, 0)} label="décision(s) validée(s)" />
          <Stat value={working} label="agent(s) actif(s)" accent={working > 0} />
          <Stat value={forYou} label="pour vous" warn={forYou > 0} />
        </div>
      </header>

      <section className="panel-card team">
        <div className="section-head">
          <div>
            <h2>L'équipe</h2>
            <p className="muted small">Qui fait quoi, en ce moment. Cliquez sur une activité pour l'ouvrir.</p>
          </div>
          {snap.projects.length > 1 && (
            <div className="chips">
              <button className={`chip ${!filter ? "on" : ""}`} onClick={() => setFilter(undefined)}>
                Tous les projets
              </button>
              {snap.projects.map((p) => (
                <button key={p.slug} className={`chip ${filter === p.slug ? "on" : ""}`} onClick={() => setFilter(p.slug)}>
                  {p.name}
                </button>
              ))}
            </div>
          )}
        </div>
        <OrgChart snap={snap} projectNames={names} filter={filter} />
      </section>

      <div className="studio-columns">
        <section className="panel-card">
          <div className="section-head">
            <h2>Vos projets</h2>
            <div className="actions">
              <button onClick={() => navigate({ page: "import" })}>Importer un projet existant</button>
              <button className="secondary" onClick={() => setCreating((c) => !c)}>
                Nouveau projet
              </button>
            </div>
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
          {snap.projects.length === 0 && (
            <div className="empty-state">
              <p>Aucun projet pour l'instant.</p>
              <p className="muted">Importez un jeu existant (par exemple Destiny Survivor) ou créez-en un nouveau.</p>
            </div>
          )}
          <div className="project-grid">
            {snap.projects.map((p) => (
              <a key={p.slug} className={`project-tile ${p.busy ? "busy" : ""}`} href={`#/p/${p.slug}`}>
                <div className="tile-cover" data-engine={p.engine}>
                  <span className="tile-initial">{p.name.slice(0, 1).toUpperCase()}</span>
                  {p.busy && <span className="tile-live">au travail</span>}
                  {p.waiting > 0 && <span className="tile-wait">{p.waiting} pour vous</span>}
                </div>
                <div className="tile-body">
                  <h3>{p.name}</h3>
                  <p className="muted small">{ENGINE[p.engine]}</p>
                  <div className="tile-stats">
                    <span>
                      <b>{p.decisions}</b> décisions
                    </span>
                    <span>
                      <b>{p.proposals}</b> propositions
                    </span>
                    <span>
                      <b>{p.tasks}</b> tâches
                    </span>
                  </div>
                </div>
              </a>
            ))}
          </div>
        </section>

        <section className="panel-card feed">
          <h2>Journal du studio</h2>
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
      </div>
    </main>
  );
}

function Stat({ value, label, accent, warn }: { value: number; label: string; accent?: boolean; warn?: boolean }) {
  return (
    <div className={`stat ${accent ? "accent" : ""} ${warn ? "warn" : ""}`}>
      <b>{value}</b>
      <span>{label}</span>
    </div>
  );
}
