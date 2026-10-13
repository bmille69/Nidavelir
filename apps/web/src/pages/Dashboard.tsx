import { useEffect, useState } from "react";
import { navigate } from "../App.tsx";
import { api, slugify, type Project } from "../api.ts";

const ENGINE: Record<Project["engine"], string> = { godot: "Godot", web: "Web / TypeScript", unknown: "Moteur inconnu" };

export function Dashboard() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.projects().then(setProjects, (e: Error) => setError(e.message));
  }, []);

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

  return (
    <main className="page">
      <div className="page-head">
        <h1>Vos projets</h1>
        <div className="actions">
          <button onClick={() => navigate({ page: "import" })}>Importer un projet existant</button>
          <button className="secondary" onClick={() => setCreating((c) => !c)}>
            Nouveau projet
          </button>
        </div>
      </div>

      {creating && (
        <div className="card">
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
      {projects === null && !error && <p className="muted">Chargement…</p>}
      {projects?.length === 0 && (
        <div className="card empty">
          <p>Aucun projet pour l'instant.</p>
          <p className="muted">Importez un jeu existant (par exemple Destiny Survivor) ou créez-en un nouveau.</p>
        </div>
      )}
      <div className="grid">
        {projects?.map((p) => (
          <a key={p.slug} className="card project-card" href={`#/p/${p.slug}`}>
            <h2>{p.name}</h2>
            <p className="muted small">{ENGINE[p.engine]}</p>
            <p className="path">{p.root}</p>
          </a>
        ))}
      </div>
    </main>
  );
}
