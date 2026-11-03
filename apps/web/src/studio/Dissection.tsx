import { useEffect, useState } from "react";
import { navigate } from "../App.tsx";
import { api, type Dissection, type DissectionDetail, type FeaturePack, type PublicSource, type ReverseTool } from "../api.ts";
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

/** Le verdict du lancement vérifié (ADR-120) : le jeu démarre, démarre à moitié, ne démarre pas, ou il manque l'outil. */
const LAUNCH: Record<NonNullable<Dissection["launch"]>["verdict"], string> = {
  playable: "Se lance",
  partiel: "Se lance, à moitié",
  echec: "Ne se lance pas",
  outil: "Éditeur manquant",
};

/**
 * L'Atelier de démontage (ADR-40) : un jeu que vous possédez, démonté pour l'étudier (l'Archéologue
 * vous l'explique), vous en inspirer (le studio réécrit à sa façon) ou le modifier (projet de mod).
 */
export function DissectionHome() {
  const [list, setList] = useState<Dissection[] | null>(null);
  const [sources, setSources] = useState<PublicSource[]>([]);
  const [patches, setPatches] = useState<Record<string, string>>({});
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.reverse().then(
      (r) => {
        setList(r.dissections);
        setSources(r.sources);
      },
      (e: Error) => setError(e.message),
    );
  }, []);

  async function addPublic(s: PublicSource) {
    setBusy(true);
    setError(null);
    try {
      const d = await api.reversePublic(s.id, patches[s.id] ?? s.defaultPatch);
      navigate({ page: "dissection", id: d.id });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

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

      {sources.length > 0 && (
        <section className="panel-card dissect-public">
          <h2>Données publiques</h2>
          <p className="muted small">
            Certains jeux sont protégés, mais leurs règles chiffrées sont publiques : la communauté (CommunityDragon) convertit leurs fichiers de données en JSON et les
            archive version par version. Rien n'est lu sur votre PC, et le jeu installé comme son anti-triche ne sont jamais touchés.
          </p>
          {sources.map((s) => (
            <div key={s.id} className="dissect-source">
              <div>
                <strong>{s.label}</strong>
                <p className="small">{s.description}</p>
              </div>
              <label className="small dissect-patch">
                Version du jeu
                <input
                  value={patches[s.id] ?? s.defaultPatch}
                  onChange={(e) => setPatches({ ...patches, [s.id]: e.target.value })}
                  aria-label={`Version de ${s.label}`}
                  size={6}
                />
              </label>
              <button disabled={busy} onClick={() => void addPublic(s)}>
                <Icon name="download" size={16} /> Importer
              </button>
              <p className="muted small">{s.patchHint}</p>
            </div>
          ))}
        </section>
      )}

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
  const [askMode, setAskMode] = useState<"note" | "feature">("note");
  const [open, setOpen] = useState<number | null>(null);
  const [target, setTarget] = useState("");
  const [sources, setSources] = useState<PublicSource[]>([]);
  const [opened, setOpened] = useState<string | null>(null);

  const load = () =>
    Promise.all([api.reverseGet(id), api.reverse()]).then(
      ([detail, all]) => {
        setD(detail);
        setTools(all.tools);
        setSources(all.sources);
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
  const needed = d.needs.map((n) => tools.find((t) => t.id === n)).filter((t): t is ReverseTool => !!t);
  const missing = needed.filter((t) => !t.installed);
  // Le choix d'outil de la pipeline (ADR-126) : quel outil pour ce moteur, dans quel rôle, et pourquoi.
  const plan = d.scan.plan ?? [];
  const pub = d.scan.public ?? null;
  // Un jeu protégé dont les données sont publiques (League of Legends → Swarm) : on propose cette voie.
  const alternative = d.scan.protection ? sources.find((s) => d.name.toLowerCase().includes(s.game.toLowerCase())) : undefined;
  const projects = snap?.projects ?? [];
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
      {d.updated && d.status === "extracted" && (
        <p className="dissect-updated">
          <Icon name="bolt" size={16} /> Le jeu a été mis à jour depuis le démontage. Redémontez-le : l'Archéologue vous dira ce qui a changé
          {d.mod_project ? ", et ce qui pourrait casser votre mod" : ""}.
        </p>
      )}

      <section className="dissect-grid">
        <div className="panel-card">
          <h2>Ce que le hub a trouvé</h2>
          {d.scan.protection ? (
            <>
              <p className="dissect-blocked">
                <Icon name="close" size={16} /> Protection détectée : <b>{d.scan.protection}</b>. L'Atelier ne démonte pas ce jeu : c'est interdit, et un anti-triche peut
                bannir votre compte.
              </p>
              {alternative && (
                <div className="dissect-alt">
                  <p className="small">
                    Ses règles chiffrées sont publiques : <b>{alternative.label}</b>, sans rien toucher sur votre PC.
                  </p>
                  <button
                    className="small"
                    disabled={busy !== null}
                    onClick={() =>
                      void act("public", async () => {
                        const created = await api.reversePublic(alternative.id, alternative.defaultPatch);
                        navigate({ page: "dissection", id: created.id });
                      })
                    }
                  >
                    <Icon name="download" size={14} /> Importer les données publiques ({alternative.defaultPatch})
                  </button>
                </div>
              )}
            </>
          ) : (
            <p>{d.scan.recoverable}</p>
          )}
          {d.scan.incomplete && (
            <p className="dissect-blocked small">
              <Icon name="close" size={14} /> {d.scan.incomplete}
            </p>
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

        {plan.length > 0 && (
          <div className="panel-card dissect-plan">
            <h2>Quel outil, et pourquoi</h2>
            <ul>
              {plan.map((step) => {
                const t = tools.find((x) => x.id === step.id);
                return (
                  <li key={step.id}>
                    <span className={`pill plan-${step.role === "obligatoire" ? "must" : step.role === "conseillé" ? "advice" : "last"}`}>
                      {step.role}
                    </span>{" "}
                    <b>{t?.name ?? step.id}</b>
                    {t?.installed ? <span className="muted small"> — installé{t.version ? ` ${t.version}` : ""}</span> : null}
                    <p className="muted small">{step.why}</p>
                    {t && !t.installed && (
                      <button
                        className="secondary"
                        disabled={busy !== null}
                        onClick={() => void act(`install-${t.id}`, () => api.reverseInstall(t.id).then(refreshStudio))}
                      >
                        {busy === `install-${t.id}` ? "Installation…" : `Installer ${t.name}`}
                      </button>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        <div className="panel-card">
          <h2>{pub ? "Importer" : "Démonter"}</h2>
          {!d.scan.tool && !d.scan.protection && <p className="muted">Le démontage des jeux {d.scan.engineLabel} n'est pas encore pris en charge. Demandez-le au studio.</p>}
          {missing.map((t) => (
            <div key={t.id} className="dissect-tool">
              <p>
                Outil nécessaire : <b>{t.name}</b> ({t.size}), depuis sa page officielle{" "}
                <a href={`https://github.com/${t.repo}`} target="_blank" rel="noreferrer">
                  github.com/{t.repo}
                </a>
                . {t.purpose}
              </p>
              <button disabled={busy !== null} onClick={() => void act(`install-${t.id}`, () => api.reverseInstall(t.id).then(refreshStudio))}>
                {busy === `install-${t.id}` ? "Installation…" : `Installer ${t.name}`}
              </button>
            </div>
          ))}
          {(pub || (tool && missing.length === 0)) && d.status !== "blocked" && (
            <>
              <p className="muted small">
                {pub
                  ? `Archive publique de la version ${pub.patch}, téléchargée sur votre clic (quelques Mo), puis rangée en tables par le hub.`
                  : `${needed.map((t) => `${t.name} ${t.version ?? ""}`.trim()).join(" et ")} ${needed.length > 1 ? "sont installés" : "est installé"}.`}
              </p>
              {d.status === "running" ? (
                <>
                  <p className="live-text">
                    <span className="live-dot" />{" "}
                    {pub ? "Import en cours…" : d.mode === "fonctions" ? "Récupération du code des fonctions (Cpp2IL)…" : `Démontage en cours (${d.mode === "code" ? "code seulement" : "projet complet"})…`}
                  </p>
                  <pre className="dissect-log">{d.log.slice(-8).join("\n") || "…"}</pre>
                  <button className="secondary" onClick={() => void act("cancel", () => api.reverseCancel(d.id))}>
                    Arrêter
                  </button>
                </>
              ) : (
                <div className="dissect-modes">
                  {pub ? (
                    <button disabled={busy !== null} onClick={() => void act("run", () => api.reverseRun(d.id, "complet"))}>
                      <Icon name="download" size={16} /> {d.status === "extracted" ? "Réimporter" : "Importer les données"}
                    </button>
                  ) : tool?.id === "assetripper" ? (
                    <>
                      <button disabled={busy !== null || !!d.scan.incomplete} onClick={() => void act("run", () => api.reverseRun(d.id, "complet"))}>
                        <Icon name="bolt" size={16} /> {d.status === "extracted" ? "Redémonter" : "Démonter"}
                      </button>
                      {d.scan.engine === "unity-il2cpp" && d.status === "extracted" && !d.functions && (
                        <button className="secondary" disabled={busy !== null} onClick={() => void act("run", () => api.reverseRun(d.id, "fonctions"))}>
                          <Icon name="search" size={16} /> Récupérer le code des fonctions
                        </button>
                      )}
                      <p className="muted small">
                        AssetRipper récupère tout d'un coup : le code, les scènes, les images et les sons. Comptez de quelques minutes à une demi-heure, et parfois plusieurs Go.
                        {d.scan.engine === "unity-il2cpp" &&
                          (d.functions
                            ? " Le code de chaque fonction est récupéré (Cpp2IL) : l'Archéologue lit les vraies règles, pas seulement les noms."
                            : " Ce jeu est en IL2CPP : AssetRipper n'en rend que la structure (méthodes vides). Cpp2IL récupère ensuite le code de chaque fonction, que le hub annote (noms des champs, constantes, énumérations) ; « Récupérer le code des fonctions » le fait sans tout redémonter, en quelques minutes.")}
                      </p>
                    </>
                  ) : (
                    <>
                      <button disabled={busy !== null} onClick={() => void act("run", () => api.reverseRun(d.id, "code"))}>
                        <Icon name="bolt" size={16} /> Code seulement
                      </button>
                      <button className="secondary" disabled={busy !== null} onClick={() => void act("run", () => api.reverseRun(d.id, "complet"))}>
                        Projet complet (images, sons…)
                      </button>
                      <p className="muted small">
                        « Code seulement » prend quelques minutes. « Projet complet » récupère aussi les ressources : bien plus long, et plusieurs Go.
                        {d.scan.engine === "godot" || d.scan.engine === "godot-dotnet"
                          ? " Il vérifie ensuite que le projet se recompile et démarre, et recrée les fichiers manquants."
                          : ""}
                        {d.needs.includes("ilspy") && " Le code C# est décompilé par ILSpy s'il ne sort pas avec le reste."}
                      </p>
                    </>
                  )}
                  {d.status === "extracted" && (
                    <p className="muted small">
                      {pub ? "Réimporter" : "Redémonter (après une mise à jour du jeu)"} garde la version actuelle de côté pour la comparer à la nouvelle
                      {d.previous ? " ; elle remplace l'ancienne comparaison" : ""}.
                    </p>
                  )}
                </div>
              )}
              {d.error && (d.status === "failed" || d.status === "extracted") && <p className="error small">{d.error}</p>}
            </>
          )}
        </div>
      </section>

      {d.status === "extracted" && (d.scan.engine === "godot" || d.scan.engine === "godot-dotnet") && (
        <section className="panel-card dissect-launch">
          <div className="section-head">
            <div>
              <h2>Le projet se lance-t-il ?</h2>
              <p className="muted small">
                Le hub ouvre le projet récupéré avec Godot, le recompile, le lance sans fenêtre et recrée les fichiers que le paquet du jeu n'a pas
                rendus. Ce n'est pas une supposition : c'est mesuré dans votre dossier de démontage, sans toucher au jeu installé.
              </p>
            </div>
            {d.launch && <span className={`pill launch-${d.launch.verdict}`}>{LAUNCH[d.launch.verdict]}</span>}
          </div>

          {!d.launch && <p className="muted small">Pas encore vérifié.</p>}
          {d.launch && (
            <>
              <p className={d.launch.verdict === "playable" ? "small" : "small muted"}>{d.launch.reason}</p>
              {d.launch.editor && (
                <p className="muted small">
                  Godot {d.launch.editor.version}
                  {d.launch.editor.mono ? " (Mono)" : ""} · {d.launch.rounds.length} essai{d.launch.rounds.length > 1 ? "s" : ""} · {d.launch.seconds} s
                </p>
              )}
              {d.launch.rounds
                .map((r) => r.note)
                .filter(Boolean)
                .slice(0, 1)
                .map((note) => (
                  <p key={note} className="muted small">
                    {note} — l'import tourne dans l'éditeur ; seul le lancement décide.
                  </p>
                ))}
              {d.launch.repairs.length > 0 && (
                <details className="dissect-repairs">
                  <summary>
                    {d.launch.repairs.length} fichier{d.launch.repairs.length > 1 ? "s" : ""} recréé{d.launch.repairs.length > 1 ? "s" : ""} pour que le
                    projet démarre
                  </summary>
                  <ul className="small">
                    {d.launch.repairs.map((r) => (
                      <li key={r.file}>
                        <code>{r.file}</code> — {r.note}
                      </li>
                    ))}
                  </ul>
                  <p className="muted small">
                    Ce ne sont pas les fichiers d'origine : des classes vides avec le bon parent, des scènes minimales, des images d'un pixel. À compléter si
                    vous voulez vous en servir.
                  </p>
                </details>
              )}
              {d.launch.missing.length > 0 && (
                <p className="error small">
                  {d.launch.missing.length} fichier{d.launch.missing.length > 1 ? "s" : ""} encore réclamé{d.launch.missing.length > 1 ? "s" : ""} par le jeu,
                  et impossible{d.launch.missing.length > 1 ? "s" : ""} à recréer : {d.launch.missing.slice(0, 3).map((m) => m.path).join(", ")}
                  {d.launch.missing.length > 3 ? "…" : ""}
                </p>
              )}
            </>
          )}

          <div className="dissect-modes">
            {d.launch?.verdict === "outil" && d.launch.need?.version && (
              <button disabled={busy !== null} onClick={() => void act("editor", () => api.reverseEditor(d.id).then(refreshStudio))}>
                {busy === "editor" ? "Installation…" : `Installer Godot ${d.launch.need.version}${d.launch.need.mono ? " (Mono)" : ""}`}
              </button>
            )}
            {d.launch?.verdict === "playable" && (
              <>
                <button
                  disabled={busy !== null}
                  onClick={() =>
                    void act("play", () => api.reverseOpen(d.id, "play").then((r) => setOpened(`${r.editor} lance le jeu dans une fenêtre sur le PC.`)))
                  }
                >
                  <Icon name="play" size={16} /> {busy === "play" ? "Ouverture…" : "Jouer"}
                </button>
                <button
                  className="secondary"
                  disabled={busy !== null}
                  onClick={() =>
                    void act("open-editor", () =>
                      api
                        .reverseOpen(d.id, "editor")
                        .then((r) => setOpened(`${r.editor} s'ouvre sur le projet. Le premier chargement peut prendre plusieurs minutes.`)),
                    )
                  }
                >
                  <Icon name="folder" size={16} /> {busy === "open-editor" ? "Ouverture…" : "Ouvrir dans Godot"}
                </button>
              </>
            )}
            <button
              className={d.launch?.verdict === "outil" || d.launch?.verdict === "playable" ? "secondary" : undefined}
              disabled={busy !== null}
              onClick={() => {
                setOpened(null);
                void act("relaunch", () => api.reverseRelaunch(d.id).then(refreshStudio));
              }}
            >
              <Icon name="play" size={16} /> {d.launch ? "Revérifier le lancement" : "Vérifier le lancement"}
            </button>
            {opened && <p className="small">{opened}</p>}
            <p className="muted small">
              Chaque revérification repart du projet tel qu'il est et ne refait jamais la récupération. « Jouer » et « Ouvrir dans Godot » travaillent
              sur la copie démontée, jamais sur le jeu installé.
            </p>
          </div>
        </section>
      )}

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
                  {note.kind === "feature" && <FeaturePackView pack={note.pack} />}
                  <div className="dissect-send">
                    <span className="small muted">{note.kind === "feature" && note.pack ? "Réécrire dans :" : "S'en inspirer dans :"}</span>
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
                      {note.kind === "feature" && note.pack ? "Envoyer le dossier au projet" : "Envoyer au directeur"}
                    </button>
                  </div>
                  <p className="muted small">
                    {note.kind === "feature" && note.pack
                      ? "Le dossier (fiche, scénarios, données) est rangé dans studio/references/ du projet, puis le directeur découpe les chantiers ; le testeur vérifie les scénarios. Jamais de code d'origine."
                      : "Seule la fiche part : le directeur réécrit le mécanisme à votre façon, sans copier le code d'origine."}
                  </p>
                </>
              )}
            </article>
          </div>

          <div className="dissect-ask">
            <div className="dissect-ask-mode" role="group" aria-label="Sorte de demande">
              <button className={askMode === "note" ? "on" : "secondary"} onClick={() => setAskMode("note")}>
                Question
              </button>
              <button className={askMode === "feature" ? "on" : "secondary"} onClick={() => setAskMode("feature")}>
                Dossier de feature
              </button>
            </div>
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              rows={2}
              placeholder={
                askMode === "feature"
                  ? "La feature à extraire : « Les vagues d'ennemis de la carte A, du début au premier boss », « L'arme de Jinx et ses évolutions »…"
                  : "Posez une question : « Comment sont calculés les dégâts ? », « Comment le jeu génère-t-il la carte ? »…"
              }
            />
            <button
              disabled={question.trim().length < 3 || busy !== null}
              onClick={() =>
                void act("ask", async () => {
                  const n = askMode === "feature" ? await api.reverseFeature(d.id, question.trim()) : await api.reverseAsk(d.id, question.trim());
                  setQuestion("");
                  setOpen(n.id);
                })
              }
            >
              {askMode === "feature" ? "Préparer le dossier" : "Demander"}
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

/** Ce qu'emporte un dossier de feature (ADR-95) : les données, les scénarios que le testeur vérifiera, les dépendances. */
function FeaturePackView({ pack }: { pack: FeaturePack | null }) {
  if (!pack)
    return (
      <p className="dissect-blocked small">
        <Icon name="close" size={14} /> L'Archéologue n'a pas rendu la liste des données et des scénarios : la fiche peut partir comme une simple inspiration. Redemandez le
        dossier pour avoir les vérifications chiffrées.
      </p>
    );
  return (
    <div className="dissect-pack">
      <h3>
        <Icon name="check" size={16} /> Ce que le dossier emporte
      </h3>
      <div className="dissect-pack-grid">
        <div>
          <p className="eyebrow">Données ({pack.donnees.length})</p>
          <ul className="dissect-evidence">
            {pack.donnees.map((f) => (
              <li key={f}>
                <code>{f}</code>
              </li>
            ))}
          </ul>
          {pack.dependances.length > 0 && (
            <>
              <p className="eyebrow">Dépendances</p>
              <p className="small">{pack.dependances.join(" · ")}</p>
            </>
          )}
          {pack.refuses.length > 0 && <p className="muted small">Écartés : {pack.refuses.join(" ; ")}</p>}
        </div>
        <div>
          <p className="eyebrow">Scénarios vérifiés par le testeur ({pack.scenarios.length})</p>
          <ol className="dissect-scenarios">
            {pack.scenarios.map((s, i) => (
              <li key={i}>
                <span>{s.situation}</span> → <b>{s.attendu}</b>
                {s.source && <span className="muted small"> ({s.source})</span>}
              </li>
            ))}
          </ol>
        </div>
      </div>
    </div>
  );
}
