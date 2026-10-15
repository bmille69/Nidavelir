import { useEffect, useState } from "react";
import { navigate } from "../App.tsx";
import { api, type Dissection, type DissectionDetail, type ReverseTool } from "../api.ts";
import { Markdown } from "./Conception.tsx";
import { useStudio, useStudioRefresh } from "./context.tsx";
import { Icon } from "./Icon.tsx";

const STATUS: Record<Dissection["status"], string> = {
  detected: "Prêt à démonter",
  blocked: "Protégé : on n'y touche pas",
  running: "Démontage en cours…",
  extracted: "Démonté",
  failed: "Échec",
};

/**
 * L'Atelier de démontage (ADR-40) : un jeu que vous possédez, démonté pour l'étudier (l'Archéologue
 * vous l'explique), vous en inspirer (le studio réécrit à sa façon) ou le modifier (projet de mod).
 */
export function DissectionHome() {
  const [list, setList] = useState<Dissection[] | null>(null);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.reverse().then((r) => setList(r.dissections), (e: Error) => setError(e.message));
  }, []);

  async function browse() {
    setError(null);
    try {
      const { path: chosen } = await api.reverseBrowse();
      if (chosen) setPath(chosen);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function add() {
    setBusy(true);
    setError(null);
    try {
      const d = await api.reverseCreate(path.trim());
      navigate({ page: "dissection", id: d.id });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="studio-page dissect">
      <header className="studio-hero">
        <div>
          <p className="eyebrow">Atelier de démontage</p>
          <h1>Démonter un jeu</h1>
          <p className="hero-sub">
            Un jeu que vous possédez, démonté pour comprendre comment il marche, vous en inspirer dans vos projets, ou le modifier pour vous. Le jeu installé
            n'est jamais touché.
          </p>
        </div>
      </header>

      <section className="panel-card">
        <h2>Choisir un jeu installé</h2>
        <p className="muted small">Le dossier du jeu, par exemple dans Steam : …\steamapps\common\Nom du jeu. Le moteur est reconnu tout seul.</p>
        <div className="dissect-pick">
          <input value={path} onChange={(e) => setPath(e.target.value)} placeholder="E:\games\steamapps\common\…" aria-label="Dossier du jeu" />
          <button className="secondary" onClick={() => void browse()}>
            <Icon name="folder" size={16} /> Parcourir
          </button>
          <button disabled={busy || path.trim().length < 3} onClick={() => void add()}>
            {busy ? "Examen…" : "Examiner"}
          </button>
        </div>
        {error && <p className="error small">{error}</p>}
        <p className="muted small dissect-rules">
          Pour votre usage personnel : on étudie et on s'inspire, on ne republie pas le code ni les ressources d'un autre. Les jeux protégés (anti-triche, anti-copie)
          sont refusés d'office.
        </p>
      </section>

      {list && list.length > 0 && (
        <section>
          <div className="section-head">
            <h2>Vos jeux démontés</h2>
          </div>
          <div className="dissect-list">
            {list.map((d) => (
              <a key={d.id} href={`#/demontage/${d.id}`} className={`dissect-tile st-${d.status}`}>
                <strong>{d.name}</strong>
                <span className="muted small">{d.scan.engineLabel}</span>
                <span className={`pill dissect-status st-${d.status}`}>{STATUS[d.status]}</span>
              </a>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}

export function DissectionView({ id }: { id: string }) {
  const snap = useStudio();
  const refreshStudio = useStudioRefresh();
  const [d, setD] = useState<DissectionDetail | null>(null);
  const [tools, setTools] = useState<ReverseTool[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [question, setQuestion] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [target, setTarget] = useState("");

  const load = () =>
    Promise.all([api.reverseGet(id), api.reverse()]).then(
      ([detail, all]) => {
        setD(detail);
        setTools(all.tools);
      },
      (e: Error) => setError(e.message),
    );
  useEffect(() => {
    void load();
  }, [id]);
  // Pendant le démontage ou une fiche en cours : on suit l'avancement.
  const live = d?.status === "running" || d?.notes.some((n) => n.status === "thinking");
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [live, id]);

  async function act(key: string, fn: () => Promise<unknown>) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  if (!d) return <main className="studio-page muted">{error ?? "Chargement…"}</main>;
  const tool = tools.find((t) => t.id === d.scan.tool);
  const projects = snap?.projects.filter((p) => p.slug !== d.mod_project) ?? [];
  const archeo = snap?.models?.roles.find((r) => r.role === "archeologue");
  const note = d.notes.find((n) => n.id === open) ?? d.notes.find((n) => n.status === "done") ?? null;

  return (
    <main className="studio-page dissect">
      <header className="studio-hero">
        <div>
          <p className="eyebrow">
            <a href="#/demontage">Atelier de démontage</a>
          </p>
          <h1>{d.name}</h1>
          <p className="hero-sub">
            {d.scan.engineLabel} · <span className={`dissect-status st-${d.status}`}>{STATUS[d.status]}</span>
            {d.files != null && ` · ${d.files.toLocaleString("fr-FR")} fichiers récupérés`}
          </p>
        </div>
      </header>
      {error && <p className="error">{error}</p>}

      <section className="dissect-grid">
        <div className="panel-card">
          <h2>Ce que le hub a trouvé</h2>
          {d.scan.protection ? (
            <p className="dissect-blocked">
              <Icon name="close" size={16} /> Protection détectée : <b>{d.scan.protection}</b>. L'Atelier ne démonte pas ce jeu : c'est interdit, et un anti-triche peut
              bannir votre compte.
            </p>
          ) : (
            <p>{d.scan.recoverable}</p>
          )}
          <ul className="dissect-evidence">
            {d.scan.evidence.map((e) => (
              <li key={e}>
                <code>{e}</code>
              </li>
            ))}
          </ul>
          {d.scan.moddable && (
            <p className="small">
              <Icon name="puzzle" size={14} /> Le jeu embarque <b>{d.scan.moddable}</b> : on peut lui faire des mods.
            </p>
          )}
          <p className="muted small path">{d.path}</p>
        </div>

        <div className="panel-card">
          <h2>Démonter</h2>
          {!d.scan.tool && !d.scan.protection && <p className="muted">Le démontage des jeux {d.scan.engineLabel} n'est pas encore pris en charge. Demandez-le au studio.</p>}
          {tool && !tool.installed && (
            <div className="dissect-tool">
              <p>
                Outil nécessaire : <b>{tool.name}</b> ({tool.size}), depuis sa page officielle{" "}
                <a href={`https://github.com/${tool.repo}`} target="_blank" rel="noreferrer">
                  github.com/{tool.repo}
                </a>
                . {tool.purpose}
              </p>
              <button disabled={busy !== null} onClick={() => void act("install", () => api.reverseInstall(tool.id).then(refreshStudio))}>
                {busy === "install" ? "Installation…" : `Installer ${tool.name}`}
              </button>
            </div>
          )}
          {tool?.installed && d.status !== "blocked" && (
            <>
              <p className="muted small">
                {tool.name} {tool.version} est installé.
              </p>
              {d.status === "running" ? (
                <>
                  <p className="live-text">
                    <span className="live-dot" /> Démontage en cours ({d.mode === "code" ? "code seulement" : "projet complet"})…
                  </p>
                  <pre className="dissect-log">{d.log.slice(-8).join("\n") || "…"}</pre>
                  <button className="secondary" onClick={() => void act("cancel", () => api.reverseCancel(d.id))}>
                    Arrêter
                  </button>
                </>
              ) : (
                <div className="dissect-modes">
                  <button disabled={busy !== null} onClick={() => void act("run", () => api.reverseRun(d.id, "code"))}>
                    <Icon name="bolt" size={16} /> Code seulement
                  </button>
                  <button className="secondary" disabled={busy !== null} onClick={() => void act("run", () => api.reverseRun(d.id, "complet"))}>
                    Projet complet (images, sons…)
                  </button>
                  <p className="muted small">« Code seulement » prend quelques minutes. « Projet complet » récupère aussi les ressources : bien plus long, et plusieurs Go.</p>
                </div>
              )}
              {d.status === "failed" && d.error && <p className="error small">{d.error}</p>}
            </>
          )}
        </div>
      </section>

      {d.status === "extracted" && (
        <section className="panel-card dissect-archeo">
          <div className="section-head">
            <div>
              <h2>L'Archéologue</h2>
              <p className="muted small">Il lit le jeu démonté et vous l'explique en clair. Chaque réponse devient une fiche.</p>
            </div>
            {archeo && (
              <label className="model-pick">
                Modèle
                <select
                  value={archeo.model}
                  onChange={(e) => void act("model", () => api.setModel("archeologue", e.target.value).then(refreshStudio))}
                  aria-label="Modèle de l'Archéologue"
                  title={archeo.why}
                >
                  {snap!.models.choices.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.label}
                      {c.id === archeo.recommended ? " ★ recommandé" : ""}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          <div className="dissect-notes">
            <nav>
              {d.notes.map((n) => (
                <button key={n.id} className={`note-tab ${note?.id === n.id ? "on" : ""} st-${n.status}`} onClick={() => setOpen(n.id)}>
                  {n.status === "thinking" && <span className="live-dot" />}
                  {n.title}
                </button>
              ))}
            </nav>
            <article className="dissect-note">
              {!note && <p className="muted">L'Archéologue écrit la fiche d'ensemble…</p>}
              {note?.status === "thinking" && (
                <p className="muted">
                  <span className="live-dot" /> L'Archéologue lit le jeu pour répondre à « {note.question.slice(0, 120)} »…
                </p>
              )}
              {note?.status === "failed" && <p className="error small">{note.body}</p>}
              {note?.status === "done" && (
                <>
                  <Markdown text={note.body} />
                  <div className="dissect-send">
                    <span className="small muted">S'en inspirer dans :</span>
                    <select value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Projet">
                      <option value="">choisir un projet…</option>
                      {projects.map((p) => (
                        <option key={p.slug} value={p.slug}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                    <button
                      className="small"
                      disabled={!target || busy !== null}
                      onClick={() =>
                        void act("send", async () => {
                          const { thread } = await api.reverseSend(d.id, note.id, target);
                          navigate({ page: "project", slug: target, thread, view: "discussion" });
                        })
                      }
                    >
                      Envoyer au directeur
                    </button>
                  </div>
                  <p className="muted small">Seule la fiche part : le directeur réécrit le mécanisme à votre façon, sans copier le code d'origine.</p>
                </>
              )}
            </article>
          </div>

          <div className="dissect-ask">
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              rows={2}
              placeholder="Posez une question : « Comment sont calculés les dégâts ? », « Comment le jeu génère-t-il la carte ? »…"
            />
            <button
              disabled={question.trim().length < 3 || busy !== null}
              onClick={() =>
                void act("ask", async () => {
                  const n = await api.reverseAsk(d.id, question.trim());
                  setQuestion("");
                  setOpen(n.id);
                })
              }
            >
              Demander
            </button>
          </div>

          {d.scan.assembly && (
            <div className="dissect-mod">
              <h3>
                <Icon name="puzzle" size={16} /> Modifier le jeu
              </h3>
              {d.mod_project ? (
                <p>
                  Projet de mod : <a href={`#/p/${d.mod_project}`}>ouvrir la discussion</a>.
                </p>
              ) : (
                <>
                  <p className="muted small">
                    Crée un projet à part (dans vos jeux) avec les fiches de l'Archéologue, puis le directeur en pose la base. Le jeu installé n'est jamais modifié.
                  </p>
                  <button
                    className="secondary"
                    disabled={busy !== null}
                    onClick={() =>
                      void act("mod", async () => {
                        const r = await api.reverseMod(d.id);
                        refreshStudio();
                        navigate({ page: "project", slug: r.project, thread: r.thread, view: "discussion" });
                      })
                    }
                  >
                    Créer un projet de mod
                  </button>
                </>
              )}
            </div>
          )}
        </section>
      )}
    </main>
  );
}
