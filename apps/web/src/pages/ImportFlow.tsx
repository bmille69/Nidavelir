import { useEffect, useState } from "react";
import { navigate } from "../App.tsx";
import { api, slugify, type Analysis, type Suggestion } from "../api.ts";

const ENGINE = { godot: "Godot", web: "Web / TypeScript", unknown: "Inconnu" } as const;

export function ImportFlow({ gamesRoot }: { gamesRoot: string }) {
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [path, setPath] = useState("");
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [docs, setDocs] = useState<Set<string>>(new Set());
  const [initGit, setInitGit] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.suggestions().then(setSuggestions, () => setSuggestions([]));
  }, []);

  async function analyze(p: string) {
    setBusy("Analyse du dossier (lecture seule)…");
    setError(null);
    setAnalysis(null);
    try {
      const a = await api.analyze(p);
      setPath(a.root);
      setAnalysis(a);
      setName(a.suggestedName);
      setSlug(a.suggestedSlug);
      setDocs(new Set(a.documents));
      setInitGit(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function browse() {
    setBusy("Choisissez le dossier dans la fenêtre Windows (elle peut s'ouvrir derrière le navigateur)…");
    setError(null);
    try {
      const { path: chosen } = await api.browse();
      setBusy(null);
      if (chosen) await analyze(chosen);
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }

  async function confirm() {
    if (!analysis) return;
    setBusy("Import…");
    setError(null);
    try {
      const { project } = await api.importProject({ path: analysis.root, slug, name, initGit, documents: [...docs] });
      navigate({ page: "project", slug: project.slug });
    } catch (e) {
      setError((e as Error).message);
      setBusy(null);
    }
  }

  const toggleDoc = (d: string) =>
    setDocs((s) => {
      const n = new Set(s);
      if (n.has(d)) n.delete(d);
      else n.add(d);
      return n;
    });

  const blocked = !analysis || analysis.problems.length > 0 || (!analysis.isGitRepo && !initGit) || !name.trim() || !slug;

  return (
    <main className="page">
      <div className="page-head">
        <h1>Importer un projet existant</h1>
        <a href="#/" className="muted">
          ← Retour
        </a>
      </div>

      <section className="card">
        <h2>1. Choisir le dossier</h2>
        <div className="row">
          <button onClick={browse} disabled={!!busy}>
            Parcourir…
          </button>
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder={`${gamesRoot}\\mon-jeu`} className="grow" />
          <button className="secondary" onClick={() => analyze(path)} disabled={!path.trim() || !!busy}>
            Analyser
          </button>
        </div>
        {suggestions.length > 0 && (
          <>
            <p className="muted small">Dépôts Git trouvés dans {gamesRoot} :</p>
            <ul className="suggestions">
              {suggestions.map((s) => (
                <li key={s.path}>
                  <button
                    className="link"
                    disabled={!!s.registered || s.problems.length > 0 || !!busy}
                    onClick={() => analyze(s.path)}
                    title={s.problems.join(" ; ")}
                  >
                    {s.name}
                  </button>
                  {s.registered && <span className="badge">déjà importé</span>}
                  {!s.registered && s.problems.length > 0 && <span className="badge muted">protégé</span>}
                </li>
              ))}
            </ul>
          </>
        )}
      </section>

      {busy && <p className="muted">{busy}</p>}
      {error && <p className="error">{error}</p>}

      {analysis && (
        <section className="card">
          <h2>2. Vérifier et confirmer</h2>
          <dl className="facts">
            <dt>Dossier</dt>
            <dd className="path">{analysis.root}</dd>
            <dt>Moteur détecté</dt>
            <dd>{ENGINE[analysis.engine]}</dd>
            <dt>Git</dt>
            <dd>{analysis.isGitRepo ? "dépôt Git ✓" : "pas de dépôt Git"}</dd>
          </dl>

          {analysis.problems.length > 0 ? (
            <div className="error">
              Import impossible :
              <ul>
                {analysis.problems.map((p) => (
                  <li key={p}>{p}</li>
                ))}
              </ul>
            </div>
          ) : (
            <>
              <div className="row">
                <label className="grow">
                  Nom du projet
                  <input value={name} onChange={(e) => setName(e.target.value)} />
                </label>
                <label>
                  Identifiant
                  <input value={slug} onChange={(e) => setSlug(slugify(e.target.value))} />
                </label>
              </div>

              {!analysis.isGitRepo && (
                <label className="check">
                  <input type="checkbox" checked={initGit} onChange={(e) => setInitGit(e.target.checked)} />
                  Initialiser un dépôt Git dans ce dossier (nécessaire pour versionner la vision)
                </label>
              )}

              <h3>Amorcer la vision à partir des documents</h3>
              {analysis.documents.length === 0 ? (
                <p className="muted">Aucun document Markdown trouvé.</p>
              ) : (
                <>
                  <p className="muted small">
                    Le directeur lira les documents cochés et proposera des éléments <strong>à trier</strong>. Rien ne sera validé sans vous,
                    et les documents ne seront pas modifiés.
                  </p>
                  <ul className="checklist">
                    {analysis.documents.map((d) => (
                      <li key={d}>
                        <label className="check">
                          <input type="checkbox" checked={docs.has(d)} onChange={() => toggleDoc(d)} />
                          <code>{d}</code>
                        </label>
                      </li>
                    ))}
                  </ul>
                </>
              )}

              <div className="notice">
                <strong>Ce qui sera écrit dans votre projet :</strong> uniquement un dossier <code>studio/</code> (
                <code>project.yaml</code>, <code>items/</code>), puis un commit restreint à <code>studio/</code>. Vos autres modifications en
                cours ne sont pas touchées.
                {docs.size > 0 && <> L'analyse des {docs.size} document(s) utilise Claude Code (votre abonnement).</>}
              </div>
              <button onClick={confirm} disabled={blocked || !!busy}>
                Importer {name || "le projet"}
              </button>
            </>
          )}
        </section>
      )}
    </main>
  );
}
