import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { navigate } from "../App.tsx";
import { api, type Art3D, type ArtAsset, type ArtGenerating, type ArtGenerator, type ArtState, type AssetStatus } from "../api.ts";
import { Markdown } from "./Conception.tsx";
import { Icon } from "./Icon.tsx";

const PHONE = typeof window !== "undefined" && !!window.matchMedia?.("(max-width: 860px)").matches;
const IMAGE_MARK = "§IMAGE§ ";
const CHOICE_MARK = "§CHOIX§ ";
const DONE_MARK = "§FAIT§ ";
const ACCEPT = "image/png,image/jpeg,image/webp";

const STATUS: Record<AssetStatus, string> = {
  a_valider: "À valider",
  production: "En production",
  propose: "Proposé",
  valide: "Validé",
  integration: "Intégration demandée",
  integre: "Dans le jeu",
};
const ORDER: AssetStatus[] = ["a_valider", "production", "propose", "valide", "integration", "integre"];

type Tab = "assets" | "moodboard" | "bible";

/**
 * L'espace du Directeur artistique (ADR-43) : vous lui parlez et lui confiez vos images d'inspiration ; il tient la
 * bible visuelle, propose les visuels à produire, les fait fabriquer par le générateur local (ADR-46) ou vous donne des
 * prompts Midjourney, et son validateur juge les rendus.
 */
export function ArtDirection({ slug }: { slug: string }) {
  const [state, setState] = useState<ArtState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [attached, setAttached] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [tab, setTab] = useState<Tab>("assets");
  const [pane, setPane] = useState<"chat" | "side">("chat");
  const [dragging, setDragging] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(() => api.art(slug).then(setState, (e: Error) => setError(e.message)), [slug]);
  useEffect(() => {
    setState(null);
    void load();
  }, [load]);
  // Pendant qu'il répond ou que le validateur juge : on suit de près ; sinon, de temps en temps.
  const busy =
    !!state && (state.busy.replying || state.busy.validating.length > 0 || state.busy.generating.length > 0 || !!state.generator.installing || !!state.workshop3d.blender.installing);
  useEffect(() => {
    const t = setInterval(() => void load(), busy ? 2500 : 10_000);
    return () => clearInterval(t);
  }, [busy, load]);
  const count = state?.messages.length ?? 0;
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [count, state?.busy.replying]);

  async function send(text = draft) {
    const lines = [text.trim() || (attached.length ? "Voici des images d'inspiration." : ""), ...attached.map((f) => `${IMAGE_MARK}${f}`)].filter(Boolean);
    if (!lines.length) return;
    setError(null);
    try {
      await api.artSend(slug, lines.join("\n"));
      setDraft("");
      setAttached([]);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function upload(files: FileList | File[], target: string) {
    setUploading(true);
    setError(null);
    try {
      const done: string[] = [];
      for (const f of [...files].filter((x) => ACCEPT.includes(x.type))) done.push((await api.artUpload(slug, target, f)).file);
      if (!done.length) throw new Error("Déposez des images PNG, JPEG ou WebP");
      if (target === "moodboard") setAttached((a) => [...a, ...done]);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const drop = (e: DragEvent, target: string) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files.length) void upload(e.dataTransfer.files, target);
  };

  if (!state) return <main className="project art-project muted">{error ?? "Chargement…"}</main>;
  const lastArt = [...state.messages].reverse().find((m) => m.role === "art");
  const lastIsArt = state.messages.at(-1)?.role === "art";
  const toValidate = state.assets.filter((a) => a.status === "a_valider" || a.status === "valide").length;

  return (
    <main className={`project art-project pane-${pane}`}>
      <div className="pane-switch" role="tablist">
        <button role="tab" aria-selected={pane === "chat"} className={pane === "chat" ? "on" : ""} onClick={() => setPane("chat")}>
          Discussion
        </button>
        <button role="tab" aria-selected={pane === "side"} className={pane === "side" ? "on" : ""} onClick={() => setPane("side")}>
          Visuels
          {toValidate > 0 && <span className="count warn">{toValidate}</span>}
        </button>
      </div>

      <section
        className={`conversation ${dragging ? "dropping" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => drop(e, "moodboard")}
      >
        <div className="mode-bar">
          <span className="badge mode art-badge">
            <Icon name="palette" size={14} /> Direction artistique
          </span>
          <span className="muted small">Confiez vos idées et vos images : il propose une direction cohérente, cherche des références et prépare chaque visuel.</span>
        </div>
        <div className="messages">
          {state.messages.length === 0 && (
            <div className="empty art-empty">
              <p>
                Le Directeur artistique s'occupe de l'apparence de votre jeu. Pas besoin d'avoir des idées précises : il part de votre jeu, vous pose quelques questions
                de goût sous forme de choix, cherche des références et rédige la <b>bible visuelle</b>, le guide que suivront tous les visuels.
              </p>
              <p className="muted small">Glissez ici des images qui vous plaisent (captures, affiches, jeux, films…) : il les regarde et en tire une direction.</p>
              <button onClick={() => void send("Construisons ensemble la direction artistique du jeu. Je n'ai pas d'idée précise : guide-moi.")}>
                <Icon name="sparkle" size={16} /> Construire la direction artistique
              </button>
            </div>
          )}
          {state.messages.map((m) => (
            <div key={m.id} className={`msg ${m.role === "human" ? "human" : "director art"}`}>
              <div className="who">{m.role === "human" ? "Vous" : "Directeur artistique (IA)"}</div>
              <ArtText
                text={m.text}
                slug={slug}
                choices={m.id === lastArt?.id && lastIsArt && !state.busy.replying}
                onChoose={(q, o) => void send(`${q} → ${o}`)}
              />
            </div>
          ))}
          {state.busy.replying && (
            <div className="msg director art muted">
              <span className="live-dot" /> Le Directeur artistique regarde vos images et cherche des références… (une à quelques minutes)
            </div>
          )}
          <div ref={endRef} />
        </div>
        {error && <p className="error">{error}</p>}
        {attached.length > 0 && (
          <div className="art-attached">
            {attached.map((f) => (
              <span key={f} className="art-chip">
                <img src={api.artFile(slug, f)} alt="" />
                <button className="icon-btn" aria-label="Retirer" onClick={() => setAttached((a) => a.filter((x) => x !== f))}>
                  <Icon name="close" size={12} />
                </button>
              </span>
            ))}
            <span className="muted small">Ajoutées au moodboard ; elles partent avec votre message.</span>
          </div>
        )}
        <div className="composer">
          <button className="secondary attach" onClick={() => fileInput.current?.click()} disabled={uploading} aria-label="Joindre des images" title="Joindre des images d'inspiration">
            <Icon name="upload" size={18} />
          </button>
          <input ref={fileInput} type="file" accept={ACCEPT} multiple hidden onChange={(e) => e.target.files && void upload(e.target.files, "moodboard")} />
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={PHONE ? "Écrivez au Directeur artistique…" : "Une idée, une envie, une référence… (Entrée pour envoyer). Glissez des images ici."}
            rows={PHONE ? 1 : 3}
            enterKeyHint="send"
          />
          <button onClick={() => void send()} disabled={(!draft.trim() && !attached.length) || uploading} aria-label="Envoyer">
            <Icon name="arrow" size={18} className="send-icon" />
            <span className="send-label">{uploading ? "Envoi…" : "Envoyer"}</span>
          </button>
        </div>
      </section>

      <aside className="panel art-panel">
        <div className="tabs">
          {(["assets", "moodboard", "bible"] as Tab[]).map((t) => (
            <button key={t} className={tab === t ? "tab active" : "tab"} onClick={() => setTab(t)}>
              {t === "assets" ? `Visuels (${state.assets.length})` : t === "moodboard" ? `Moodboard (${state.moodboard.length})` : "Bible"}
            </button>
          ))}
        </div>

        {tab === "assets" && (
          <div className="art-assets">
            <GeneratorCard generator={state.generator} act={act} />
            {state.assets.some((a) => a.model3d) && <Workshop3DCard workshop={state.workshop3d} act={act} />}
            {state.assets.length === 0 && <p className="muted small">Aucun visuel pour l'instant. Le Directeur artistique en propose dès que la direction est posée.</p>}
            {ORDER.flatMap((s) => state.assets.filter((a) => a.status === s)).map((a) => (
              <AssetCard
                key={a.id}
                slug={slug}
                asset={a}
                validating={state.busy.validating.includes(a.id)}
                generating={state.busy.generating.find((g) => g.asset === a.id) ?? null}
                local={state.generator.installed}
                ready3d={state.workshop3d.blender.installed && (state.workshop3d.tripo.configured || !!a.model3d?.simple)}
                onUpload={(f) => void upload(f, a.id)}
                act={act}
              />
            ))}
          </div>
        )}

        {tab === "moodboard" && (
          <div className="art-mood" onDragOver={(e) => e.preventDefault()} onDrop={(e) => drop(e, "moodboard")}>
            <button className="secondary" onClick={() => fileInput.current?.click()} disabled={uploading}>
              <Icon name="upload" size={16} /> Ajouter des images
            </button>
            {state.moodboard.length === 0 && <p className="muted small">Glissez ici des images qui vous inspirent : le Directeur artistique les regarde et note ce qu'il en retient.</p>}
            <div className="art-mood-grid">
              {state.moodboard.map((m) => (
                <figure key={m.file}>
                  <a href={api.artFile(slug, m.file)} target="_blank" rel="noreferrer">
                    <img src={api.artFile(slug, m.file)} alt={m.file} loading="lazy" />
                  </a>
                  <figcaption className="small">{m.note ?? <span className="muted">Pas encore commentée</span>}</figcaption>
                </figure>
              ))}
            </div>
          </div>
        )}

        {tab === "bible" && (
          <div className="art-bible md">
            {state.bible ? <Markdown text={state.bible} /> : <p className="muted small">Pas encore de bible visuelle. Demandez au Directeur artistique de la construire avec vous.</p>}
          </div>
        )}
      </aside>
    </main>
  );
}

/** Message du Directeur artistique : texte, images citées, et ses questions de goût en boutons. */
function ArtText({ text, slug, choices, onChoose }: { text: string; slug: string; choices: boolean; onChoose: (q: string, o: string) => void }) {
  const lines = text.split("\n");
  const images = lines.filter((l) => l.startsWith(IMAGE_MARK)).map((l) => l.slice(IMAGE_MARK.length).trim());
  const questions = lines.filter((l) => l.startsWith(CHOICE_MARK)).map((l) => l.slice(CHOICE_MARK.length).split(" || "));
  const done = lines.filter((l) => l.startsWith(DONE_MARK)).map((l) => l.slice(DONE_MARK.length));
  const body = lines.filter((l) => !l.startsWith(IMAGE_MARK) && !l.startsWith(CHOICE_MARK) && !l.startsWith(DONE_MARK)).join("\n").trim();
  return (
    <>
      {body && (
        <div className="text md">
          <Markdown text={body} />
        </div>
      )}
      {images.length > 0 && (
        <div className="art-msg-images">
          {images.map((f) => (
            <a key={f} href={api.artFile(slug, f)} target="_blank" rel="noreferrer">
              <img src={api.artFile(slug, f)} alt={f} loading="lazy" />
            </a>
          ))}
        </div>
      )}
      {done.map((d) => (
        <p key={d} className="art-done small">
          <Icon name="check" size={14} /> {d}
        </p>
      ))}
      {questions.map(([q, ...options], k) => (
        <div key={k} className="art-choice">
          <p className="small">
            <b>{q}</b>
          </p>
          <div className="art-choice-options">
            {options.map((o) => (
              <button key={o} className="secondary small" disabled={!choices} onClick={() => onChoose(q!, o)}>
                {o}
              </button>
            ))}
          </div>
        </div>
      ))}
    </>
  );
}

/** Le générateur d'images local : à installer d'un clic, puis il fabrique et fait juger les visuels tout seul. */
function GeneratorCard({ generator: g, act }: { generator: ArtGenerator; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  if (g.installed) return <p className="muted small art-gen-ready"><Icon name="check" size={14} /> Générateur d'images local prêt (Flux, sur votre carte graphique).</p>;
  return (
    <div className="art-gen panel-card">
      <p className="small">
        <b>Générateur d'images local</b> : le Directeur artistique fabrique lui-même les visuels sur votre carte graphique, fait juger plusieurs essais et
        recommence seul jusqu'à un visuel conforme. Sans lui, vous passez par Midjourney à la main.
      </p>
      {g.installing ? (
        <div className="meter">
          <div className="meter-head">
            <span>{g.installing.step}</span>
            <b>{Math.round(g.installing.progress * 100)} %</b>
          </div>
          <div className="meter-track">
            <div className="meter-fill" style={{ width: `${Math.round(g.installing.progress * 100)}%` }} />
          </div>
          <span className="muted small">Vous pouvez fermer cette page : l'installation continue. Si le hub redémarre, elle reprendra là où elle en était.</span>
        </div>
      ) : (
        <>
          {g.error && <p className="error small">L'installation s'est arrêtée : {g.error}</p>}
          <button className="small" onClick={() => void act(() => api.artInstallGenerator())}>
            <Icon name="upload" size={14} /> {g.error ? "Reprendre l'installation" : "Installer le générateur"} ({g.size})
          </button>
          <p className="muted small">ComfyUI (2 Go) et le modèle Flux (17 Go), depuis leurs pages officielles (GitHub, Hugging Face). Gratuit ; ensuite, tout se fait sur votre PC.</p>
        </>
      )}
    </div>
  );
}

/** L'atelier 3D : Blender (sur votre clic) et votre clé Tripo, avec le plafond du mois. */
function Workshop3DCard({ workshop: w, act }: { workshop: Art3D; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [key, setKey] = useState("");
  const b = w.blender;
  if (b.installed && w.tripo.configured)
    return (
      <p className="muted small art-gen-ready">
        <Icon name="check" size={14} /> Atelier 3D prêt (Tripo + Blender) · {w.tripo.credits} crédits Tripo utilisés ce mois-ci, plafond {w.tripo.cap}.
      </p>
    );
  return (
    <div className="art-gen panel-card">
      <p className="small">
        <b>Atelier 3D</b> : Tripo transforme l'image validée en modèle 3D (avec squelette et animations pour les personnages), Blender le met aux mesures du jeu et le
        photographie sous tous les angles pour le validateur.
      </p>
      {!b.installed &&
        (b.installing ? (
          <div className="meter">
            <div className="meter-head">
              <span>{b.installing.step}</span>
              <b>{Math.round(b.installing.progress * 100)} %</b>
            </div>
            <div className="meter-track">
              <div className="meter-fill" style={{ width: `${Math.round(b.installing.progress * 100)}%` }} />
            </div>
          </div>
        ) : (
          <>
            {b.error && <p className="error small">L'installation de Blender s'est arrêtée : {b.error}</p>}
            <button className="small" onClick={() => void act(() => api.artInstallBlender())}>
              <Icon name="upload" size={14} /> Installer Blender ({b.size})
            </button>
          </>
        ))}
      {b.installed && <p className="muted small">Blender est installé.</p>}
      {!w.tripo.configured ? (
        <div className="art-key">
          <p className="muted small">
            Tripo est un service en ligne payant : créez un compte sur{" "}
            <a href="https://platform.tripo3d.ai" target="_blank" rel="noreferrer">
              platform.tripo3d.ai
            </a>
            , prenez des crédits, puis collez ici une clé « API Key » (elle commence par tsk_). Plafond : {w.tripo.cap} crédits par mois.
          </p>
          <div className="art-key-row">
            <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="tsk_…" autoComplete="off" />
            <button className="small" disabled={key.trim().length < 8} onClick={() => void act(() => api.artTripoKey(key.trim()).then(() => setKey("")))}>
              Enregistrer
            </button>
          </div>
        </div>
      ) : (
        <p className="muted small">Clé Tripo enregistrée · {w.tripo.credits} crédits utilisés ce mois-ci, plafond {w.tripo.cap}.</p>
      )}
    </div>
  );
}

function AssetCard({
  slug,
  asset: a,
  validating,
  generating,
  local,
  ready3d,
  onUpload,
  act,
}: {
  slug: string;
  asset: ArtAsset;
  validating: boolean;
  generating: ArtGenerating | null;
  local: boolean;
  ready3d: boolean;
  onUpload: (f: FileList) => void;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState<number | null>(null);
  const last = a.renders.at(-1);
  // Croquis du cadrage à choisir (ADR-49) : la réponse reprend la question posée dans la discussion.
  const sketches = !a.direction && a.sketches?.every((s) => s.file) ? a.sketches : null;
  const choose = (k: number) => api.artSend(slug, `Quel croquis pour ${a.id} « ${a.name} » ? → Croquis ${k + 1} : ${a.sketches![k]!.label}`);
  const copy = (p: string, k: number) =>
    navigator.clipboard?.writeText(p).then(
      () => {
        setCopied(k);
        setTimeout(() => setCopied(null), 1500);
      },
      () => {},
    );
  return (
    <article className={`art-asset st-${a.status}`} onDragOver={(e) => e.preventDefault()} onDrop={(e) => (e.preventDefault(), e.dataTransfer.files.length && onUpload(e.dataTransfer.files))}>
      <header>
        <span className="muted small">{a.id}</span>
        <strong className="grow">{a.name}</strong>
        <span className={`pill art-status st-${a.status}`}>
          {generating ? `Fabrication, tour ${generating.round}/${generating.rounds}` : validating && a.status === "a_valider" ? "Le validateur regarde…" : sketches ? "Croquis à choisir" : STATUS[a.status]}
        </span>
      </header>
      <p className="small">
        <span className="muted">{a.type} · </span>
        {a.usage}
      </p>
      {a.specs && <p className="muted small">{a.specs}</p>}
      {a.model3d && (
        <p className="muted small">
          <Icon name="cube" size={12} /> Modèle 3D{a.model3d.simple ? " (objet simple, fait dans Blender)" : ""} : {a.model3d.size} m, {a.model3d.tris} triangles
          {a.model3d.animations.length ? `, animations ${a.model3d.animations.join(", ")}` : a.model3d.rig ? ", avec squelette" : ""}
        </p>
      )}
      {generating && (
        <p className="live-text small">
          <span className="live-dot" /> {generating.step}…
        </p>
      )}

      {sketches && (
        <div className="art-sketches">
          {sketches.map((sk, k) => (
            <figure key={sk.file}>
              <a href={api.artFile(slug, sk.file)} target="_blank" rel="noreferrer">
                <img src={api.artFile(slug, sk.file)} alt={sk.label} loading="lazy" />
              </a>
              <figcaption className="small">
                {k + 1}. {sk.label}
              </figcaption>
              <button className="small" disabled={!!generating} onClick={() => void act(() => choose(k))}>
                Choisir
              </button>
            </figure>
          ))}
        </div>
      )}
      {last && (
        <a className="art-render" href={api.artFile(slug, last)} target="_blank" rel="noreferrer">
          <img src={api.artFile(slug, last)} alt={`Rendu de ${a.name}`} loading="lazy" />
        </a>
      )}
      {a.model && (
        <div className="art-model">
          <div className="art-model-shots">
            {a.model.renders.map((r) => (
              <a key={r} href={api.artFile(slug, r)} target="_blank" rel="noreferrer">
                <img src={api.artFile(slug, r)} alt={r} loading="lazy" />
              </a>
            ))}
          </div>
          <p className="muted small">
            {a.model.dims.map((d) => `${d} m`).join(" × ")} · {a.model.tris} triangles{a.model.animations.length ? ` · ${a.model.animations.join(", ")}` : ""}
          </p>
          {a.model.workshop && <p className="small">Dans Blender : {a.model.workshop}</p>}
          {!!a.model.missingAnimations?.length && (
            <p className="muted small">
              Absentes : {a.model.missingAnimations.join(", ")} (Tripo a reconnu la forme « {a.model.rigType ?? "?"} »).
            </p>
          )}
          {a.model.verdict && (
            <div className={`art-verdict ${a.model.verdict.ok ? "ok" : "ko"}`}>
              <p className="small">
                <b>3D {a.model.verdict.ok ? "conforme" : "à retoucher"}</b> {a.model.verdict.by === "human" ? "(votre décision)" : "(validateur)"} — {a.model.verdict.summary}
              </p>
              {a.model.verdict.points.length > 0 && (
                <ul className="small">
                  {a.model.verdict.points.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      )}
      {a.ingame && (
        <div className={`art-verdict ${a.ingame.ok ? "ok" : "ko"}`}>
          <p className="small">
            <b>Dans le jeu : {!a.ingame.visible ? "pas visible sur la capture" : a.ingame.ok ? "rend bien" : "à retoucher"}</b> — {a.ingame.summary}
          </p>
          <a className="art-render" href={api.artFile(slug, a.ingame.file)} target="_blank" rel="noreferrer">
            <img src={api.artFile(slug, a.ingame.file)} alt={`${a.name} dans le jeu`} loading="lazy" />
          </a>
        </div>
      )}
      {a.verdict && (
        <div className={`art-verdict ${a.verdict.ok ? "ok" : "ko"}`}>
          <p className="small">
            <b>{a.verdict.ok ? "Conforme" : "À retoucher"}</b> {a.verdict.by === "human" ? "(votre décision)" : "(validateur)"} — {a.verdict.summary}
          </p>
          {a.verdict.points.length > 0 && (
            <ul className="small">
              {a.verdict.points.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {a.prompts.length > 0 && a.status !== "integre" && (
        <details className="art-prompts" open={a.status === "production"}>
          <summary className="small">
            {local ? "Prompts" : "Prompts Midjourney"} ({a.prompts.length})
          </summary>
          {a.prompts.map((p, k) => (
            <div key={k} className="art-prompt">
              <code>{p}</code>
              <button className="secondary small" onClick={() => void copy(p, k)} aria-label="Copier le prompt">
                <Icon name={copied === k ? "check" : "copy"} size={14} /> {copied === k ? "Copié" : "Copier"}
              </button>
            </div>
          ))}
          {a.refs.length > 0 && (
            <div className="art-refs">
              <span className="muted small">À joindre dans Midjourney comme référence de style :</span>
              {a.refs.map((r) => (
                <a key={r} href={api.artFile(slug, r)} target="_blank" rel="noreferrer" download>
                  <img src={api.artFile(slug, r)} alt={r} loading="lazy" />
                </a>
              ))}
            </div>
          )}
        </details>
      )}

      <div className="art-actions">
        {local && a.prompts.length > 0 && !generating && ["propose", "production", "a_valider", "valide"].includes(a.status) && (
          <button className="small" disabled={validating} onClick={() => void act(() => api.artGenerate(slug, a.id))}>
            <Icon name="sparkle" size={14} /> {last ? "Regénérer" : "Générer"}
          </button>
        )}
        {["propose", "production", "a_valider", "valide"].includes(a.status) && (
          <>
            <button className="secondary small" disabled={validating} onClick={() => input.current?.click()}>
              <Icon name="upload" size={14} /> {last ? "Déposer un nouveau rendu" : "Déposer le rendu"}
            </button>
            <input ref={input} type="file" accept={ACCEPT} hidden onChange={(e) => e.target.files?.length && onUpload(e.target.files)} />
          </>
        )}
        {a.model3d && (a.verdict?.ok || a.model3d.simple) && ready3d && !generating && ["propose", "production", "a_valider", "valide"].includes(a.status) && (
          <button className="small" disabled={validating} onClick={() => void act(() => api.artModel(slug, a.id))}>
            <Icon name="cube" size={14} /> {a.model ? "Refaire la 3D" : "Fabriquer la 3D"}
          </button>
        )}
        {a.status === "production" && a.model?.verdict && !a.model.verdict.ok && !generating && (
          <button className="secondary small" onClick={() => void act(() => api.artDecide(slug, a.id, "valider"))}>
            Valider la 3D quand même
          </button>
        )}
        {a.status === "production" && !a.model && a.verdict && !a.verdict.ok && !generating && (
          <button className="secondary small" onClick={() => void act(() => api.artDecide(slug, a.id, "valider"))}>
            Valider quand même
          </button>
        )}
        {a.status === "valide" && (
          <>
            <button
              className="small"
              onClick={() =>
                void act(async () => {
                  const { thread } = await api.artIntegrate(slug, a.id);
                  navigate({ page: "project", slug, thread, view: "discussion" });
                })
              }
            >
              <Icon name="hammer" size={14} /> Faire intégrer
            </button>
            <button className="secondary small" onClick={() => void act(() => api.artDecide(slug, a.id, "refaire"))}>
              Refaire
            </button>
          </>
        )}
      </div>
    </article>
  );
}
