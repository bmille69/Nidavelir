import { useCallback, useEffect, useRef, useState, type CSSProperties, type DragEvent } from "react";
import { createPortal } from "react-dom";
import { navigate } from "../App.tsx";
import { api, type Art3D, type ArtAsset, type ArtGoogle, type ArtGenerating, type ArtGenerator, type ArtStage, type ArtSpend, type ArtState, type AssetStatus } from "../api.ts";
import { Markdown } from "./Conception.tsx";
import { Choices, DirectionView, Moodboard, ReferenceBoard } from "./ArtVision.tsx";
import { Icon } from "./Icon.tsx";
import { SoundDirection } from "./SoundDirection.tsx";
import { splitTeam, TeamCards } from "./TeamCards.tsx";

const PHONE = typeof window !== "undefined" && !!window.matchMedia?.("(max-width: 860px)").matches;
const IMAGE_MARK = "§IMAGE§ ";
const CHOICE_MARK = "§CHOIX§ ";
const DONE_MARK = "§FAIT§ ";
const BOARD_MARK = "§PLANCHE§ ";
const ACCEPT = "image/png,image/jpeg,image/webp";

export const STATUS: Record<AssetStatus, string> = {
  a_valider: "À valider",
  production: "En production",
  propose: "Proposé",
  valide: "Validé",
  integration: "Intégration demandée",
  integre: "Dans le jeu",
  ecarte: "Mis de côté",
};
const ORDER: AssetStatus[] = ["a_valider", "production", "propose", "valide", "integration", "integre", "ecarte"];

type Filter = "all" | "integre" | "todo" | "running" | "ecarte";
const FILTERS: [Filter, string][] = [
  ["all", "Tous"],
  ["integre", "Intégrés"],
  ["todo", "À valider"],
  ["running", "En cours"],
  ["ecarte", "Écartés"],
];
type DaTab = "chat" | "direction" | "moodboard";

/** Un visuel qui attend votre décision : un rendu à valider, un croquis à choisir, une image ou une 3D refusée. */
function waitsForYou(a: ArtAsset): boolean {
  if (a.status === "a_valider" || a.status === "valide") return true;
  if (a.sketches?.length && !a.direction && a.sketches.every((s) => s.file)) return true;
  return a.status === "production" && !!(a.model ? a.model.verdict && !a.model.verdict.ok : a.verdict && !a.verdict.ok);
}

/** Le groupe d'un visuel pour les filtres de la galerie. */
function groupOf(a: ArtAsset): Exclude<Filter, "all"> {
  if (a.status === "integre") return "integre";
  if (a.status === "ecarte") return "ecarte";
  return waitsForYou(a) ? "todo" : "running";
}

/** L'image d'une vignette : la 3D photographiée, le rendu validé, le dernier rendu, ou le premier croquis. */
function thumbOf(a: ArtAsset): string | null {
  return a.model?.renders[0] ?? a.verdict?.file ?? a.renders.at(-1) ?? a.sketches?.find((s) => s.file)?.file ?? null;
}

/**
 * Art & son (ADR-113), d'après la maquette : la galerie des visuels d'abord (filtres par statut), puis le son. Le
 * Directeur artistique (ADR-43) se parle dans un panneau latéral qui garde aussi sa direction et le moodboard ; les
 * réglages techniques (générateur local, clé Google, Blender, Tripo, installations) sont derrière la roue crantée.
 * Le détail complet d'un visuel (étapes, rendus, 3D, verdicts, prompts, toutes ses actions) s'ouvre au clic.
 */
export function ArtDirection({ slug }: { slug: string }) {
  const [state, setState] = useState<ArtState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [attached, setAttached] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  // `#/p/<jeu>/art/da` ouvre directement la discussion avec le DA (lien « Répondre au Directeur artistique » d'« À vous »).
  const [da, setDa] = useState<DaTab | null>(() => (/\/art\/da\b/.test(window.location.hash) ? "chat" : null));
  const [settings, setSettings] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = useCallback(() => api.art(slug).then(setState, (e: Error) => setError(e.message)), [slug]);
  useEffect(() => {
    setState(null);
    void load();
  }, [load]);
  // Pendant qu'il répond ou que le validateur juge : on suit de près ; sinon, de temps en temps.
  const exploring = state?.busy.exploring ?? [];
  const busy =
    !!state &&
    (state.busy.replying || exploring.length > 0 || state.busy.validating.length > 0 || state.busy.generating.length > 0 || !!state.generator.installing || !!state.workshop3d.blender.installing);
  useEffect(() => {
    const t = setInterval(() => void load(), busy ? 2500 : 10_000);
    return () => clearInterval(t);
  }, [busy, load]);
  const count = state?.messages.length ?? 0;
  useEffect(() => {
    if (da === "chat") endRef.current?.scrollIntoView({ block: "end" });
  }, [count, state?.busy.replying, da]);
  useEffect(() => {
    const onHash = () => {
      if (/\/art\/da\b/.test(window.location.hash)) setDa("chat");
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  // Le panneau refermé, l'adresse redevient celle de la galerie (un rechargement ne le rouvre pas).
  useEffect(() => {
    if (!da && /\/art\/da\b/.test(window.location.hash)) window.history.replaceState(null, "", `#/p/${slug}/art`);
  }, [da, slug]);
  // Échap ferme le panneau ouvert.
  useEffect(() => {
    if (!da && !settings && !open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setDa(null);
      setSettings(false);
      setOpen(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [da, settings, open]);

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

  if (!state) return <main className="art-page muted">{error ?? "Chargement…"}</main>;
  const lastArt = [...state.messages].reverse().find((m) => m.role === "art");
  const lastIsArt = state.messages.at(-1)?.role === "art";
  // Sa dernière question attend votre réponse : seul cas où le bouton du DA passe en braise (il vous attend).
  const asking = !!lastArt && lastIsArt && lastArt.text.includes(CHOICE_MARK) && !state.busy.replying;
  // Vos réponses, message par message : l'option choisie reste marquée sous chaque question.
  const answers = new Map<string, Record<string, string>>();
  state.messages.forEach((m, i) => {
    if (m.role !== "art" || !m.text.includes(CHOICE_MARK)) return;
    const next = state.messages.slice(i + 1).find((x) => x.role === "human");
    const pairs = (next?.text ?? "").split("\n").map((l) => /^(.+?\?)\s*→\s*(.+)$/.exec(l.trim())).filter((x): x is RegExpExecArray => !!x);
    answers.set(m.id, Object.fromEntries(pairs.map((p) => [p[1]!.trim(), p[2]!.trim()])));
  });
  const ordered = ORDER.flatMap((s) => state.assets.filter((a) => a.status === s).sort((x, y) => queueRank(state.queue, x) - queueRank(state.queue, y)));
  // Ce qui vous attend en tête de la galerie, comme dans « À vous ».
  const sorted = [...ordered.filter(waitsForYou), ...ordered.filter((a) => !waitsForYou(a))];
  const n = (f: Filter) => (f === "all" ? sorted.length : sorted.filter((a) => groupOf(a) === f).length);
  const shown = filter === "all" ? sorted : sorted.filter((a) => groupOf(a) === filter);
  const current = open ? (state.assets.find((a) => a.id === open) ?? null) : null;
  const posed = !!state.bible || state.assets.length > 0;
  // Ce qui manque à l'outillage : dit en une ligne, réglé dans « Réglages ».
  const missing = [!state.generator.installed && "le générateur d'images local", state.assets.some((a) => a.model3d) && !state.workshop3d.blender.installed && "Blender", state.assets.some((a) => a.model3d) && !state.workshop3d.tripo.configured && "la clé Tripo"].filter(Boolean) as string[];
  const start = () => {
    setDa("chat");
    void send("Construisons ensemble la direction artistique du jeu. Je n'ai pas d'idée précise : guide-moi.");
  };

  return (
    <main className="art-page">
      <div className="art-inner">
        <header className="page-h">
          <div>
            <h2>Art &amp; son</h2>
            <p>Les visuels et les sons du jeu, tels qu'on les voit en jeu.</p>
          </div>
          <span className="sp" />
          <button className={`da-open${asking ? " asking" : ""}`} onClick={() => setDa("chat")} title={asking ? "Il attend votre réponse à sa question" : "Sa discussion, la direction visuelle et le moodboard"}>
            <span className="da-av" aria-hidden="true">
              DA
            </span>
            Parler au Directeur artistique
            {asking && <span className="count warn">1</span>}
            {state.busy.replying && <span className="live-dot" />}
          </button>
          <button className="rc-icon art-gear" onClick={() => setSettings(true)} aria-label="Réglages techniques" title="Réglages techniques : générateur local, clé Google, Blender, Tripo">
            <Icon name="gear" size={17} />
          </button>
        </header>
        {error && !da && !settings && !open && <p className="error small">{error}</p>}
        {missing.length > 0 && (
          <p className="art-missing small">
            Il manque {missing.join(", ")} : le Directeur artistique fait sans (prompts Midjourney, visuels à déposer).{" "}
            <button className="rail-link accent" onClick={() => setSettings(true)}>
              Réglages
            </button>
          </p>
        )}

        {posed ? (
          <>
            <div className="recap-filters" role="group" aria-label="Filtrer les visuels">
              {FILTERS.filter(([f]) => f === "all" || n(f) > 0 || f === "integre" || f === "todo").map(([f, label]) => (
                <button key={f} className={`recap-chip${filter === f ? " on" : ""}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                  {label}
                  <span className="n">{n(f)}</span>
                </button>
              ))}
              <span className="sp" />
              <small className="recap-hint">Cliquez un visuel pour tout son détail</small>
            </div>
            <div className="agrid">
              {shown.map((a, i) => (
                <AssetTile
                  key={a.id}
                  slug={slug}
                  asset={a}
                  index={i}
                  generating={state.busy.generating.find((g) => g.asset === a.id) ?? null}
                  validating={state.busy.validating.includes(a.id)}
                  queued={state.queue?.findIndex((q) => q.id === a.id) ?? -1}
                  onOpen={() => setOpen(a.id)}
                  act={act}
                />
              ))}
              {shown.length === 0 && (
                <p className="recap-none">{state.assets.length ? "Aucun visuel ici." : "Aucun visuel pour l'instant. Le Directeur artistique en propose dès que la direction est posée."}</p>
              )}
            </div>
          </>
        ) : (
          <div className="art-start">
            <p>
              Le Directeur artistique s'occupe de l'apparence de votre jeu. Pas besoin d'avoir des idées précises : il part de votre jeu, vous pose quelques questions de
              goût sous forme de choix, cherche des références et rédige la <b>bible visuelle</b>, le guide que suivront tous les visuels.
            </p>
            <p className="muted small">Vous pourrez aussi lui confier des images qui vous plaisent (captures, affiches, jeux, films…) : il les regarde et en tire une direction.</p>
            <button className="rail-btn primary" onClick={start}>
              <Icon name="sparkle" size={15} /> Construire la direction artistique
            </button>
          </div>
        )}

        {/* Le son (ADR-91), ici avec les visuels ; il reste aussi dans Pilotage → Son. */}
        <section className="art-sound" aria-label="Son">
          <div className="sec-h">
            <h3>
              <Icon name="note" size={16} /> Son
            </h3>
            <span className="sp" />
            <small>Le directeur sonore propose, vous écoutez et choisissez ; un chantier les branche.</small>
          </div>
          <SoundDirection slug={slug} />
        </section>
      </div>

      {(da || settings || current) &&
        createPortal(
          <>
            <div className="rc-backdrop" onClick={() => (setDa(null), setSettings(false), setOpen(null))} />
            {da && (
              <aside className="rc-drawer da-drawer" role="dialog" aria-label="Directeur artistique">
                <header className="rc-d-h">
                  <span className="da-av" aria-hidden="true">
                    DA
                  </span>
                  <div className="da-h">
                    <b>Directeur artistique</b>
                    <small>
                      {state.messages.length} message{state.messages.length > 1 ? "s" : ""} · la bible visuelle et le moodboard
                    </small>
                  </div>
                  <span className="sp" />
                  <button className="rc-icon" onClick={() => setDa(null)} aria-label="Fermer">
                    <Icon name="close" size={16} />
                  </button>
                </header>
                <div className="art-panel">
                  <div className="tabs">
                    {(["chat", "direction", "moodboard"] as DaTab[]).map((t) => (
                      <button key={t} className={da === t ? "tab active" : "tab"} onClick={() => setDa(t)}>
                        {t === "chat" ? "Discussion" : t === "moodboard" ? `Moodboard (${state.moodboard.length})` : "Direction"}
                      </button>
                    ))}
                  </div>
                </div>
                {da === "chat" && (
                  <section
                    className={`conversation da-chat ${dragging ? "dropping" : ""}`}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragging(true);
                    }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(e) => drop(e, "moodboard")}
                  >
                    <div className="messages">
                      {state.messages.length === 0 && (
                        <div className="empty art-empty">
                          <p>Confiez-lui vos idées et vos images : il propose une direction cohérente, cherche des références et prépare chaque visuel.</p>
                          <p className="muted small">Glissez ici des images qui vous plaisent : il les regarde et en tire une direction.</p>
                          <button onClick={() => void send("Construisons ensemble la direction artistique du jeu. Je n'ai pas d'idée précise : guide-moi.")}>
                            <Icon name="sparkle" size={16} /> Construire la direction artistique
                          </button>
                        </div>
                      )}
                      {state.messages.map((m) => (
                        <div key={m.id} className={`msg ${m.role === "human" ? "human" : "director art"}`}>
                          {m.role !== "human" && (
                            <span className="msg-av da-av" aria-hidden="true">
                              DA
                            </span>
                          )}
                          <div className="msg-main">
                            {m.role !== "human" && (
                              <div className="msg-h">
                                <b className="who">Directeur artistique</b>
                                <time>{hm(m.at)}</time>
                              </div>
                            )}
                            <ArtText
                              text={m.text}
                              slug={slug}
                              choices={m.id === lastArt?.id && lastIsArt && !state.busy.replying}
                              onChoose={(answer) => void send(answer)}
                              answers={answers.get(m.id)}
                              direction={state.direction}
                              act={act}
                            />
                          </div>
                        </div>
                      ))}
                      {state.busy.replying && (
                        <p className="event wait">
                          <span className="live-dot" /> {exploring[0] ?? "Le Directeur artistique regarde vos images et cherche des références"}… (une à quelques minutes)
                        </p>
                      )}
                      {!state.busy.replying &&
                        exploring.map((e) => (
                          <p key={e} className="event wait">
                            <span className="live-dot" /> {e}…
                          </p>
                        ))}
                      <div ref={endRef} />
                    </div>
                    {error && <p className="error small">{error}</p>}
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
                      <textarea
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && !e.shiftKey) {
                            e.preventDefault();
                            void send();
                          }
                        }}
                        placeholder={PHONE ? "Écrivez au Directeur artistique…" : "Écrire au Directeur artistique… une idée, une envie, une référence (Entrée pour envoyer). Glissez des images ici."}
                        rows={PHONE ? 1 : 2}
                        enterKeyHint="send"
                      />
                      <div className="composer-row">
                        <button className="secondary attach" onClick={() => fileInput.current?.click()} disabled={uploading} aria-label="Joindre des images" title="Joindre des images d'inspiration">
                          <Icon name="image" size={16} />
                          <span className="attach-label">Joindre une image</span>
                        </button>
                        <input ref={fileInput} type="file" accept={ACCEPT} multiple hidden onChange={(e) => e.target.files && void upload(e.target.files, "moodboard")} />
                        <span className="sp" />
                        <button className="send" onClick={() => void send()} disabled={(!draft.trim() && !attached.length) || uploading} aria-label="Envoyer">
                          <Icon name="arrow" size={16} className="send-icon" />
                          <span className="send-label">{uploading ? "Envoi…" : "Envoyer"}</span>
                        </button>
                      </div>
                    </div>
                  </section>
                )}
                {da === "direction" && (
                  <div className="rc-d-b art-panel-body">
                    {error && <p className="error small">{error}</p>}
                    <DirectionView slug={slug} bible={state.bible} direction={state.direction} assets={state.assets} act={act} />
                  </div>
                )}
                {da === "moodboard" && (
                  <div className="rc-d-b art-panel-body art-mood" onDragOver={(e) => e.preventDefault()} onDrop={(e) => drop(e, "moodboard")}>
                    {error && <p className="error small">{error}</p>}
                    <button className="rail-btn" onClick={() => fileInput.current?.click()} disabled={uploading}>
                      <Icon name="upload" size={15} /> Ajouter des images
                    </button>
                    {state.moodboard.length === 0 && (
                      <p className="muted small">
                        Glissez ici des images qui vous inspirent, ou demandez au Directeur artistique d'en chercher sur le web à partir de vos mots : il les regarde et note ce
                        qu'il en retient.
                      </p>
                    )}
                    <Moodboard slug={slug} images={state.moodboard} direction={state.direction} act={act} />
                    <input ref={fileInput} type="file" accept={ACCEPT} multiple hidden onChange={(e) => e.target.files && void upload(e.target.files, "moodboard")} />
                  </div>
                )}
              </aside>
            )}
            {settings && (
              <aside className="rc-drawer art-settings" role="dialog" aria-label="Réglages techniques">
                <header className="rc-d-h">
                  <Icon name="gear" size={16} />
                  <b>Réglages techniques · Art &amp; son</b>
                  <span className="sp" />
                  <button className="rc-icon" onClick={() => setSettings(false)} aria-label="Fermer">
                    <Icon name="close" size={16} />
                  </button>
                </header>
                <div className="rc-d-b">
                  <p className="set-intro">Ces réglages ne servent qu'à l'outillage du Directeur artistique. Ils ne sont plus affichés par défaut.</p>
                  {error && <p className="error small">{error}</p>}
                  <section className="set-group">
                    <h4>
                      <Icon name="image" size={15} /> Générateur d'images local{" "}
                      <span className={`rc-pill ${state.generator.installed ? "ok" : "grey"}`}>{state.generator.installed ? "prêt" : state.generator.installing ? "installation…" : "à installer"}</span>
                    </h4>
                    <p>Utilisé pour les croquis, les essais et les planches. Tourne sur votre carte graphique.</p>
                    <GeneratorCard generator={state.generator} act={act} />
                  </section>
                  {state.google && (
                    <section className="set-group">
                      <h4>
                        <Icon name="sparkle" size={15} /> Clé Google (Gemini) <span className={`rc-pill ${state.google.configured ? "ok" : "grey"}`}>{state.google.configured ? "enregistrée" : "facultative"}</span>
                      </h4>
                      <p>Pour les rendus détaillés quand le générateur local ne suffit pas.</p>
                      <GoogleCard google={state.google} act={act} />
                    </section>
                  )}
                  <section className="set-group">
                    <h4>
                      <Icon name="cube" size={15} /> Blender et Tripo{" "}
                      <span className={`rc-pill ${state.workshop3d.blender.installed && state.workshop3d.tripo.configured ? "ok" : "grey"}`}>
                        {state.workshop3d.blender.installed && state.workshop3d.tripo.configured ? "prêts" : `${[!state.workshop3d.blender.installed, !state.workshop3d.tripo.configured].filter(Boolean).length} étape(s)`}
                      </span>
                    </h4>
                    <p>Tripo transforme une image validée en modèle 3D ; Blender le nettoie et le contrôle avant intégration.</p>
                    <Workshop3DCard workshop={state.workshop3d} act={act} />
                  </section>
                </div>
              </aside>
            )}
            {current && (
              <aside className="rc-drawer art-detail" role="dialog" aria-label={`Visuel ${current.id}`}>
                <header className="rc-d-h">
                  <span className="k">
                    {current.id} · {current.type}
                  </span>
                  <span className="sp" />
                  <button className="rc-icon" onClick={() => setOpen(null)} aria-label="Fermer">
                    <Icon name="close" size={16} />
                  </button>
                </header>
                <div className="rc-d-b">
                  {error && <p className="error small">{error}</p>}
                  <AssetCard
                    slug={slug}
                    asset={current}
                    queued={state.queue?.findIndex((q) => q.id === current.id) ?? -1}
                    need={state.queue?.find((q) => q.id === current.id)?.need ?? null}
                    validating={state.busy.validating.includes(current.id)}
                    generating={state.busy.generating.find((g) => g.asset === current.id) ?? null}
                    local={state.generator.installed}
                    ready3d={state.workshop3d.blender.installed && (state.workshop3d.tripo.configured || !!current.model3d?.simple)}
                    spend={state.spend?.[current.id] ?? null}
                    onUpload={(f) => void upload(f, current.id)}
                    act={act}
                  />
                </div>
              </aside>
            )}
          </>,
          document.body,
        )}
    </main>
  );
}

const hm = (iso: string) => new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });

/** La pastille d'un visuel : vert = dans le jeu, braise = vous attend, glace = en route, gris = de côté ou proposé. */
function tilePill(a: ArtAsset, generating: ArtGenerating | null, validating: boolean, queued: number): [string, string] {
  if (generating) return ["cyan", `Fabrication ${generating.round}/${generating.rounds}`];
  if (validating) return ["cyan", "Le validateur regarde"];
  if (a.sketches?.length && !a.direction && a.sketches.every((s) => s.file)) return ["ember", "Croquis à choisir"];
  if (a.status === "integre") return ["ok", "Intégré"];
  if (a.status === "ecarte") return ["grey", "Écarté"];
  if (a.status === "a_valider") return ["ember", "À valider"];
  if (a.status === "valide") return ["ember", "Validé, à intégrer"];
  if (a.status === "integration") return ["cyan", "Intégration"];
  if (waitsForYou(a)) return ["ember", "Votre décision"];
  if (a.status === "production") return ["cyan", "En production"];
  if (a.launchedAt) return ["cyan", "Confié"];
  return ["grey", queued >= 0 ? `En file · n° ${queued + 1}` : "Proposé"];
}

/** Une vignette de la galerie : l'image, le statut, le nom ; le geste attendu sur place, tout le détail au clic. */
function AssetTile({
  slug,
  asset: a,
  index,
  generating,
  validating,
  queued,
  onOpen,
  act,
}: {
  slug: string;
  asset: ArtAsset;
  index: number;
  generating: ArtGenerating | null;
  validating: boolean;
  queued: number;
  onOpen: () => void;
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const thumb = thumbOf(a);
  const [tone, label] = tilePill(a, generating, validating, queued);
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  return (
    <div
      className={`acard st-${a.status}${tone === "ember" ? " todo" : ""}`}
      style={{ "--i": Math.min(index, 14) } as CSSProperties}
      role="button"
      tabIndex={0}
      aria-label={`${a.id} ${a.name} : ${label}`}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
    >
      <div className={`ashot${thumb ? "" : " ph"}`}>
        {thumb ? (
          <img src={api.artFile(slug, thumb)} alt="" loading="lazy" />
        ) : (
          <span className="rc-ph">
            <Icon name={a.model3d ? "cube" : "image"} size={18} />
            Pas encore d'aperçu
          </span>
        )}
        <span className="ast">
          <span className={`rc-pill ${tone}`}>{label}</span>
        </span>
        {a.model3d && <span className="rc-tag">3D</span>}
      </div>
      <div className="acard-b">
        <small>
          {a.id} · {a.type}
        </small>
        <b>{a.name}</b>
        {a.status === "a_valider" && !validating && !generating && (
          <div className="dacts" onClick={stop}>
            <button className="rail-btn primary" onClick={() => void act(() => api.artDecide(slug, a.id, "valider"))}>
              Valider
            </button>
            <button className="rail-btn" onClick={() => void act(() => api.artDecide(slug, a.id, "refaire"))}>
              Refaire
            </button>
          </div>
        )}
        {a.status === "valide" && (
          <div className="dacts" onClick={stop}>
            <button
              className="rail-btn primary"
              onClick={() =>
                void act(async () => {
                  const { thread } = await api.artIntegrate(slug, a.id);
                  navigate({ page: "project", slug, thread, view: "discussion" });
                })
              }
            >
              Faire intégrer
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Message du Directeur artistique : texte, images citées, et ses questions de goût en boutons. */
function ArtText({
  text,
  slug,
  choices,
  onChoose,
  answers,
  direction,
  act,
}: {
  text: string;
  slug: string;
  choices: boolean;
  onChoose: (answer: string) => void;
  answers?: Record<string, string>;
  direction: ArtState["direction"];
  act: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  // Les encarts de l'équipe (ADR-98) : consultations et souvenirs proposés, à part du texte.
  const team = splitTeam(text);
  const lines = team.text.split("\n");
  const images = lines.filter((l) => l.startsWith(IMAGE_MARK)).map((l) => l.slice(IMAGE_MARK.length).trim());
  const questions = lines.filter((l) => l.startsWith(CHOICE_MARK)).map((l) => l.slice(CHOICE_MARK.length).split(" || "));
  const boards = lines.filter((l) => l.startsWith(BOARD_MARK)).map((l) => l.slice(BOARD_MARK.length).trim());
  const done = lines.filter((l) => l.startsWith(DONE_MARK)).map((l) => l.slice(DONE_MARK.length));
  const body = lines.filter((l) => ![IMAGE_MARK, CHOICE_MARK, DONE_MARK, BOARD_MARK].some((mark) => l.startsWith(mark))).join("\n").trim();
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
      {boards.map((b) => (
        <ReferenceBoard key={b} slug={slug} board={b} direction={direction} act={act} />
      ))}
      {questions.length > 0 && <Choices slug={slug} questions={questions} enabled={choices} onChoose={onChoose} answers={answers} />}
      <TeamCards consults={team.consults} memories={team.memories} />
    </>
  );
}

/** Le générateur d'images local : à installer d'un clic, puis il fabrique et fait juger les visuels tout seul. */
function GeneratorCard({ generator: g, act }: { generator: ArtGenerator; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  if (g.installed && g.kontext?.installed)
    return (
      <p className="muted small art-gen-ready">
        <Icon name="check" size={14} /> Générateur d'images local prêt (Flux et Flux Kontext, sur votre carte graphique).
      </p>
    );
  if (g.installed) return <KontextCard kontext={g.kontext} act={act} />;
  return (
    <div className="art-gen panel-card">
      <header className="art-gen-head">
        <Icon name="image" size={18} />
        <b>Générateur d'images local</b>
        <span className="badge warn">À installer</span>
      </header>
      <p className="small">Le Directeur artistique fabrique et fait juger les visuels lui-même, sur votre carte graphique.</p>
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
          <details className="art-gen-more">
            <summary>En savoir plus</summary>
            <p className="muted small">
              Il fait juger plusieurs essais et recommence seul jusqu'à un visuel conforme. Sans lui, vous passez par Midjourney à la main. ComfyUI (2 Go) et le
              modèle Flux (17 Go), depuis leurs pages officielles (GitHub, Hugging Face). Gratuit ; ensuite, tout se fait sur votre PC.
            </p>
          </details>
        </>
      )}
    </div>
  );
}

/** Les étapes du circuit visuel (ADR-49, ADR-50, ADR-52), dans l'ordre, selon le genre d'asset. */
type Step = { id: ArtStage | "jeu"; label: string };
function stepsOf(a: ArtAsset): Step[] {
  const jeu: Step = { id: "jeu", label: "Dans le jeu" };
  if (a.model3d?.simple) return [{ id: "atelier", label: "Atelier Blender" }, { id: "controle", label: "Contrôle 3D" }, jeu];
  const image: Step[] = [
    ...(a.sketches?.length ? [{ id: "croquis" as const, label: "Croquis" }] : []),
    { id: "image", label: a.model3d ? "Image de référence" : "Image" },
  ];
  if (!a.model3d) return [...image, jeu];
  return [...image, { id: "planche", label: "Planche" }, { id: "tripo", label: "Modèle Tripo" }, { id: "atelier", label: "Atelier Blender" }, { id: "controle", label: "Contrôle 3D" }, jeu];
}

/** Où en est l'asset quand rien ne tourne : d'après sa fiche. */
function restingStage(a: ArtAsset): Step["id"] | null {
  if (a.status === "integration" || a.status === "integre") return "jeu";
  if (a.model) return "controle";
  if (a.sketches?.length && !a.direction) return "croquis";
  if (a.verdict?.ok && a.model3d) return "tripo";
  if (a.renders.length) return "image";
  return null;
}

/**
 * L'avancement de la fabrication (ADR-52) : les étapes du circuit, celle en cours, ce qui se passe en clair, ce que
 * l'artisan 3D dit faire, et la dernière image produite. Rafraîchi toutes les quelques secondes pendant la fabrication.
 */
function ArtProgress({ slug, asset: a, generating: g, validating }: { slug: string; asset: ArtAsset; generating: ArtGenerating | null; validating: boolean }) {
  const steps = stepsOf(a);
  const current = g?.stage ?? restingStage(a);
  const at = steps.findIndex((s) => s.id === current);
  const done = a.status === "integre";
  if (!g && (at < 0 || a.status === "propose")) return null;
  const preview = g?.preview ? (g.preview.kind === "atelier" ? api.artAtelierFile(slug, a.id, g.preview.file) : api.artFile(slug, g.preview.file)) : null;
  return (
    <div className={`art-progress${g ? " live" : ""}`}>
      <ol className="art-steps">
        {steps.map((s, k) => (
          <li key={s.id} className={done || k < at ? "done" : k === at ? (g ? "now" : "here") : ""}>
            {s.label}
          </li>
        ))}
      </ol>
      {g && (
        <div className="art-progress-body">
          {preview && (
            <a href={preview} target="_blank" rel="noreferrer" className="art-progress-shot">
              <img src={preview} alt="Dernière image produite" />
            </a>
          )}
          <div>
            <p className="live-text small">
              <span className="live-dot" /> {g.step}…
            </p>
            {g.rounds > 1 && <p className="muted small">Tour {g.round} sur {g.rounds}</p>}
            {g.note && <p className="small art-progress-note">« {g.note} »</p>}
          </div>
        </div>
      )}
      {!g && validating && <p className="live-text small"><span className="live-dot" /> Le validateur regarde…</p>}
      {!g && !validating && current === "croquis" && <p className="muted small">En attente de votre choix de croquis.</p>}
    </div>
  );
}

/** Flux Kontext (ADR-51) : retouches par consigne et air de famille, installé sur votre clic. */
function KontextCard({ kontext: k, act }: { kontext: ArtGenerator["kontext"] | undefined; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  return (
    <div className="art-gen panel-card">
      <p className="muted small art-gen-ready">
        <Icon name="check" size={14} /> Générateur d'images local prêt (Flux, sur votre carte graphique).
      </p>
      <header className="art-gen-head">
        <Icon name="sparkle" size={18} />
        <b>Flux Kontext</b>
        <span className="badge">Facultatif</span>
      </header>
      <p className="small">Retouche une image par consigne au lieu de tout redessiner, et garde l'air de famille entre les visuels.</p>
      {k?.installing ? (
        <div className="meter">
          <div className="meter-head">
            <span>{k.installing.step}</span>
            <b>{Math.round(k.installing.progress * 100)} %</b>
          </div>
          <div className="meter-track">
            <div className="meter-fill" style={{ width: `${Math.round(k.installing.progress * 100)}%` }} />
          </div>
          <span className="muted small">Vous pouvez fermer cette page : le téléchargement continue, et reprend là où il en était si le hub redémarre.</span>
        </div>
      ) : (
        <>
          {k?.error && <p className="error small">L'installation s'est arrêtée : {k.error}</p>}
          <button className="small" onClick={() => void act(() => api.artInstallKontext())}>
            <Icon name="upload" size={14} /> {k?.error ? "Reprendre l'installation" : "Installer Flux Kontext"} ({k?.size ?? "≈ 17 Go"})
          </button>
          <details className="art-gen-more">
            <summary>En savoir plus</summary>
            <p className="muted small">
              Par exemple « mets l'épaulière sur l'autre épaule » ; un nouveau personnage se dessine dans le style d'un visuel déjà validé. Le modèle Kontext (12 Go) et
              ses encodeurs (5,5 Go), depuis les pages publiques de ComfyUI sur Hugging Face, sans compte. Gratuit.
            </p>
          </details>
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
      <header className="art-gen-head">
        <Icon name="cube" size={18} />
        <b>Atelier 3D</b>
        <span className="badge warn">{!b.installed && !w.tripo.configured ? "2 étapes" : "1 étape"}</span>
      </header>
      <p className="small">L'image validée devient un modèle 3D aux mesures du jeu.</p>
      <details className="art-gen-more">
        <summary>En savoir plus</summary>
        <p className="muted small">
          Tripo fabrique le modèle (avec squelette et animations pour les personnages), Blender le met aux mesures du jeu et le photographie sous tous les angles pour
          le validateur.
        </p>
      </details>
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
            Votre clé Tripo (service payant,{" "}
            <a href="https://platform.tripo3d.ai" target="_blank" rel="noreferrer">
              platform.tripo3d.ai
            </a>
            ) : elle commence par tsk_. Plafond : {w.tripo.cap} crédits par mois.
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

/**
 * Google Gemini (ADR-110) : votre clé, comme celle de Tripo (masquée, jamais renvoyée), le plafond du mois et sa dépense.
 * Sans clé, rien ne change : le générateur local dessine tout.
 */
function GoogleCard({ google: g, act }: { google: ArtGoogle; act: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [key, setKey] = useState("");
  const [cap, setCap] = useState(String(g.cap));
  const usd = (n: number) => `${n.toFixed(2).replace(".", ",")} $`;
  const capRow = (
    <div className="art-key-row">
      <input type="number" min={0} max={1000} step={1} value={cap} onChange={(e) => setCap(e.target.value)} aria-label="Plafond mensuel Google, en dollars" />
      <button className="small secondary" disabled={!(Number(cap) >= 0) || Number(cap) === g.cap || cap.trim() === ""} onClick={() => void act(() => api.artGoogleCap(Number(cap)))}>
        Changer le plafond
      </button>
    </div>
  );
  if (g.configured)
    return (
      <div className="art-gen panel-card">
        <p className="muted small art-gen-ready">
          <Icon name="check" size={14} /> Clé Google (Gemini) enregistrée · {usd(g.usd)} dépensés ce mois-ci, plafond {usd(g.cap)}. Croquis, essais et vues de la planche par
          Nano Banana 2.1, retouches finales par Nano Banana Pro ; le générateur local prend le relais si Google ne répond pas.
        </p>
        {capRow}
      </div>
    );
  return (
    <div className="art-gen panel-card">
      <header className="art-gen-head">
        <Icon name="sparkle" size={18} />
        <b>Clé Google (Gemini)</b>
        <span className="badge">Facultatif</span>
      </header>
      <div className="art-key">
        <p className="muted small">
          Google dessine alors les visuels (Nano Banana, service payant :{" "}
          <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">
            aistudio.google.com/apikey
          </a>
          ), environ 0,03 à 0,13 $ par image, dans le style des visuels déjà validés. Plafond : {usd(g.cap)} par mois ; au-delà, le générateur local reprend.
        </p>
        <div className="art-key-row">
          <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="AIza…" autoComplete="off" />
          <button className="small" disabled={key.trim().length < 8} onClick={() => void act(() => api.artGoogleKey(key.trim()).then(() => setKey("")))}>
            Enregistrer
          </button>
        </div>
        {capRow}
      </div>
    </div>
  );
}

/** Les visuels proposés dans l'ordre de la file (ADR-62) ; ceux déjà confiés au Directeur artistique d'abord. */
function queueRank(queue: ArtState["queue"], a: ArtAsset): number {
  const k = queue?.findIndex((q) => q.id === a.id) ?? -1;
  return k < 0 ? (a.launchedAt ? -1 : 1000) : k;
}

function AssetCard({
  slug,
  asset: a,
  queued,
  need,
  validating,
  generating,
  local,
  ready3d,
  spend,
  onUpload,
  act,
}: {
  slug: string;
  asset: ArtAsset;
  queued: number;
  need: { id: string; title: string } | null;
  validating: boolean;
  generating: ArtGenerating | null;
  local: boolean;
  ready3d: boolean;
  spend: ArtSpend | null;
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
          {generating ? `Fabrication, tour ${generating.round}/${generating.rounds}` : validating && a.status === "a_valider" ? "Le validateur regarde…" : sketches ? "Croquis à choisir" : a.status === "propose" && a.launchedAt ? "Confié" : STATUS[a.status]}
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
      <ArtProgress slug={slug} asset={a} generating={generating} validating={validating} />

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
          {!!a.model.views?.length && (
            <>
              <span className="muted small">Planche (face, gauche, dos, droite) :</span>
              <div className="art-model-shots art-sheet">
                {a.model.views.map((v) => (
                  <a key={v} href={api.artFile(slug, v)} target="_blank" rel="noreferrer">
                    <img src={api.artFile(slug, v)} alt={v} loading="lazy" />
                  </a>
                ))}
              </div>
            </>
          )}
          <div className="art-model-shots">
            {a.model.renders.map((r) => (
              <a key={r} href={api.artFile(slug, r)} target="_blank" rel="noreferrer">
                <img src={api.artFile(slug, r)} alt={r} loading="lazy" />
              </a>
            ))}
          </div>
          {!!a.model.bandes?.length && (
            <div className="art-model-strips">
              {a.model.bandes.map((r) => (
                <a key={r} href={api.artFile(slug, r)} target="_blank" rel="noreferrer" title={r}>
                  <img src={api.artFile(slug, r)} alt={r} loading="lazy" />
                </a>
              ))}
            </div>
          )}
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
      {a.status === "valide" && a.waitsFor && <p className="small muted">Il attend que le chantier {a.waitsFor} ait posé sa place dans le jeu, puis part en intégration, avant les chantiers suivants.</p>}
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

      {a.status === "propose" && a.launchedAt && !generating && <p className="small muted">Confié au Directeur artistique : il y travaille (suivez la discussion).</p>}
      {a.status === "propose" && queued >= 0 && (
        <p className="small muted">
          Dans la file des visuels : {queued === 0 ? "le prochain" : `n° ${queued + 1}`}
          {need ? ` · attendu par le chantier ${need.id} « ${need.title} »` : ""}. Il partira tout seul à son tour.
        </p>
      )}
      {spend && (spend.usd > 0 || spend.credits > 0) && (
        <p className={`small ${spend.over ? "warn" : "muted"}`} title="Modèles en équivalent API (indicatif) et crédits Tripo, toutes fabrications de ce visuel comprises (ADR-82)">
          Dépensé : {money(spend.usd)} sur {money(spend.capUsd)} · {spend.credits} crédits Tripo sur {spend.capCredits}
          {spend.over ? " — plafond atteint, le Directeur artistique s'est arrêté" : ""}
        </p>
      )}
      {a.status === "ecarte" && <p className="small muted">Mis de côté : personne n'y touche tant que vous ne le remettez pas dans la file.</p>}

      <div className="art-actions">
        {spend?.over && (
          <button className="secondary small" title="Un plafond de plus pour ce visuel : le Directeur artistique pourra recommencer" onClick={() => void act(() => api.artRaiseBudget(slug, a.id))}>
            Relever le plafond
          </button>
        )}
        {a.status === "propose" && !a.launchedAt && (
          <button className="small" onClick={() => void act(() => api.artLaunch(slug, a.id))}>
            <Icon name="play" size={14} /> Lancer maintenant
          </button>
        )}
        {["propose", "production", "a_valider"].includes(a.status) && !generating && !validating && (
          <button className="secondary small" title="Personne n'y touche, il sort de la file ; vous pourrez l'y remettre" onClick={() => void act(() => api.artAside(slug, a.id, true))}>
            Mettre de côté
          </button>
        )}
        {a.status === "ecarte" && (
          <button className="secondary small" onClick={() => void act(() => api.artAside(slug, a.id, false))}>
            Remettre dans la file
          </button>
        )}
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
        {a.model3d && (a.verdict?.ok || a.model3d.simple) && ready3d && !generating && ["propose", "production", "a_valider", "valide", "integre"].includes(a.status) && (
          <button
            className={a.status === "integre" ? "secondary small" : "small"}
            disabled={validating}
            title={a.status === "integre" ? "Tripo refait le modèle de zéro ; s'il est validé, il remplace celui du jeu (crédits Tripo et images Google)" : undefined}
            onClick={() => {
              if (a.status === "integre" && !window.confirm(`Refaire la 3D de ${a.id} « ${a.name} » ? Le nouveau modèle remplacera celui du jeu une fois validé. Cela coûte des crédits Tripo et quelques images Google.`)) return;
              void act(() => api.artModel(slug, a.id));
            }}
          >
            <Icon name="cube" size={14} /> {a.model ? "Refaire la 3D" : "Fabriquer la 3D"}
          </button>
        )}
        {a.model && a.model.verdict && ready3d && !generating && a.status !== "propose" && (
          <button className="secondary small" disabled={validating} title="L'artisan reprend la scène Blender avec les remarques du validateur, sans repayer Tripo" onClick={() => void act(() => api.artRetouch(slug, a.id))}>
            <Icon name="cube" size={14} /> Reprendre la finition
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

const money = (usd: number) => `${usd.toFixed(2).replace(".", ",")} $`;
