import { useState } from "react";
import { api, type ArtAsset, type ArtDirectionData, type ArtReference, type ArtTaste } from "../api.ts";
import { Markdown } from "./Conception.tsx";
import { Icon } from "./Icon.tsx";

/**
 * La conception visuelle (ADR-58) : questions illustrées, planches de références à juger, duels de styles, et la
 * direction visuelle en images (style retenu, palette, choix faits, références aimées et évitées, visuels validés).
 */

export const VISUAL_SEP = " @@ ";
type Act = (fn: () => Promise<unknown>) => Promise<void>;

/** Les questions de goût d'un message : boutons, ou vignettes quand les options sont illustrées. */
export function Choices({
  slug,
  questions,
  enabled,
  onChoose,
  answers = {},
}: {
  slug: string;
  questions: string[][];
  enabled: boolean;
  onChoose: (answer: string) => void;
  /** Vos réponses déjà envoyées (question → réponse) : l'option choisie reste marquée dans l'historique. */
  answers?: Record<string, string>;
}) {
  // Plusieurs questions : chaque clic choisit, un seul envoi pour toutes ; une seule question : le clic envoie.
  const [local, setPicked] = useState<Record<number, string>>({});
  const picked: Record<number, string> = enabled ? local : Object.fromEntries(questions.flatMap(([q], k) => (answers[q!] ? [[k, answers[q!]!]] : [])));
  const pick = (k: number, label: string) => {
    if (questions.length === 1) return onChoose(`${questions[0]![0]} → ${label}`);
    setPicked((p) => (p[k] === label ? Object.fromEntries(Object.entries(p).filter(([i]) => Number(i) !== k)) : { ...p, [k]: label }));
  };
  const sendAll = () => onChoose(questions.map(([q], k) => `${q} → ${picked[k] ?? "je te laisse choisir"}`).join("\n"));
  const answered = Object.keys(picked).length;
  return (
    <>
      {questions.map(([q, ...raw], k) => {
        const options = raw.map((o) => {
          const [label, file] = o.split(VISUAL_SEP);
          return { label: label!.trim(), file: file?.trim() || null };
        });
        const visual = options.some((o) => o.file);
        return (
          <div key={k} className="art-choice">
            <p className="small">
              <b>{q}</b>
            </p>
            <div className={visual ? "art-choice-visual" : "art-choice-options"}>
              {options.map((o) =>
                visual ? (
                  <button
                    key={o.label}
                    className={`art-vignette${picked[k] === o.label ? " on" : ""}`}
                    aria-pressed={picked[k] === o.label}
                    disabled={!enabled}
                    onClick={() => pick(k, o.label)}
                  >
                    {o.file && <img src={api.artFile(slug, o.file)} alt="" loading="lazy" />}
                    <span className="small">{o.label}</span>
                  </button>
                ) : (
                  <button key={o.label} className={picked[k] === o.label ? "small" : "secondary small"} aria-pressed={picked[k] === o.label} disabled={!enabled} onClick={() => pick(k, o.label)}>
                    {o.label}
                  </button>
                ),
              )}
            </div>
            {visual && (
              <div className="art-vignette-zoom muted small">
                Voir en grand :
                {options.map((o, n) =>
                  o.file ? (
                    <a key={o.label} href={api.artFile(slug, o.file)} target="_blank" rel="noreferrer" title={o.label}>
                      {n + 1}
                    </a>
                  ) : null,
                )}
              </div>
            )}
          </div>
        );
      })}
      {questions.length > 1 && enabled && (
        <div className="art-choice-send">
          <button className="small" disabled={!answered} onClick={sendAll}>
            Envoyer mes choix ({answered}/{questions.length})
          </button>
          {answered > 0 && answered < questions.length && <span className="muted small">Les questions sans réponse : il choisira pour vous.</span>}
        </div>
      )}
    </>
  );
}

/** Une planche de références : votre avis image par image (j'aime, à éviter), puis un envoi au Directeur artistique. */
export function ReferenceBoard({ slug, board, direction, act }: { slug: string; board: string; direction: ArtDirectionData; act: Act }) {
  const refs = direction.references.filter((r) => r.board === board);
  const [verdicts, setVerdicts] = useState<Record<string, ArtTaste | null>>(() => Object.fromEntries(refs.map((r) => [r.file, r.verdict])));
  const [comment, setComment] = useState("");
  const [sent, setSent] = useState(false);
  if (!refs.length) return <p className="muted small">Planche {board} introuvable.</p>;
  const toggle = (file: string, v: ArtTaste) => {
    setSent(false);
    setVerdicts((p) => ({ ...p, [file]: p[file] === v ? null : v }));
  };
  const changed = refs.filter((r) => (verdicts[r.file] ?? null) !== r.verdict);
  const judged = refs.filter((r) => verdicts[r.file]).length;
  return (
    <div className="art-board">
      <div className="art-board-grid">
        {refs.map((r) => (
          <RefCard key={r.file} slug={slug} r={r} verdict={verdicts[r.file] ?? null} onToggle={(v) => toggle(r.file, v)} />
        ))}
      </div>
      <textarea className="art-board-comment" rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Un mot sur ce qui vous plaît ou vous gêne (facultatif)" />
      <div className="art-choice-send">
        <button
          className="small"
          disabled={!changed.length && !comment.trim()}
          onClick={() =>
            void act(async () => {
              await api.artReact(slug, { verdicts: Object.fromEntries(changed.map((r) => [r.file, verdicts[r.file] ?? null])), comment: comment.trim() || undefined });
              setComment("");
              setSent(true);
            })
          }
        >
          Envoyer mon avis ({judged}/{refs.length})
        </button>
        {sent && (
          <span className="muted small">
            <Icon name="check" size={12} /> Envoyé : gardé dans la direction visuelle.
          </span>
        )}
      </div>
    </div>
  );
}

function RefCard({ slug, r, verdict, onToggle }: { slug: string; r: ArtReference; verdict: ArtTaste | null; onToggle: (v: ArtTaste) => void }) {
  let host = "";
  try {
    host = new URL(r.source).hostname.replace(/^www\./, "");
  } catch {
    host = r.source;
  }
  return (
    <figure className={`art-ref${verdict ? ` ${verdict}` : ""}`}>
      <a href={api.artFile(slug, r.file)} target="_blank" rel="noreferrer">
        <img src={api.artFile(slug, r.file)} alt={r.title} loading="lazy" />
      </a>
      <figcaption className="small">
        <b>{r.title || r.file}</b>
        {r.why && <span>{r.why}</span>}
        <a className="muted" href={r.source} target="_blank" rel="noreferrer">
          Source : {host}
        </a>
      </figcaption>
      <div className="art-ref-actions">
        <button className={`small secondary${verdict === "aime" ? " art-aime" : ""}`} aria-pressed={verdict === "aime"} onClick={() => onToggle("aime")}>
          {verdict === "aime" && <Icon name="check" size={12} />} J'aime
        </button>
        <button className={`small${verdict === "evite" ? " danger" : " secondary"}`} aria-pressed={verdict === "evite"} onClick={() => onToggle("evite")}>
          {verdict === "evite" && <Icon name="close" size={12} />} À éviter
        </button>
      </div>
    </figure>
  );
}

/** Les étapes de la conception visuelle, comme le hub les déduit de la direction (ADR-58). */
function stageOf(d: ArtDirectionData, bible: boolean): number {
  if (bible && (d.style || !d.duels.length)) return 4;
  if (!d.choices.length && !d.references.length) return 0;
  if (!d.references.some((r) => r.verdict)) return 1;
  if (!d.style) return 2;
  if (!bible) return 3;
  return 4;
}
const STAGES = ["Intentions", "Références", "Duel de styles", "Bible", "Visuels"];

/** La palette de la bible : chaque ligne qui porte un code hexadécimal devient une pastille, avec son rôle. */
function paletteOf(bible: string): { hex: string; role: string }[] {
  const seen = new Set<string>();
  const out: { hex: string; role: string }[] = [];
  for (const line of bible.split("\n")) {
    for (const m of line.matchAll(/#[0-9a-f]{6}\b/gi)) {
      const hex = m[0].toUpperCase();
      if (seen.has(hex)) continue;
      seen.add(hex);
      out.push({ hex, role: line.replace(/[-*|`]/g, " ").replace(/#[0-9a-f]{6}\b/gi, "").replace(/\s+/g, " ").replace(/^[\s:]+|[\s:]+$/g, "").slice(0, 90) });
    }
  }
  return out.slice(0, 16);
}

/** La direction visuelle en images : on la regarde au lieu de la lire. */
export function DirectionView({ slug, bible, direction: d, assets, act }: { slug: string; bible: string | null; direction: ArtDirectionData; assets: ArtAsset[]; act: Act }) {
  const stage = stageOf(d, !!bible);
  const palette = bible ? paletteOf(bible) : [];
  const liked = d.references.filter((r) => r.verdict === "aime");
  const avoided = d.references.filter((r) => r.verdict === "evite");
  const done = assets
    .filter((a) => a.verdict?.ok || a.status === "integre")
    .map((a) => ({ a, file: a.model?.renders[0] ?? a.verdict?.file ?? a.renders.at(-1) }))
    .filter((x): x is { a: ArtAsset; file: string } => !!x.file);
  const choices = [...d.choices].reverse();
  const otherDuels = d.duels.filter((x) => x.id !== d.style?.duel);
  return (
    <div className="art-vision">
      <ol className="art-steps art-vision-steps">
        {STAGES.map((s, k) => (
          <li key={s} className={k < stage ? "done" : k === stage ? "here" : ""}>
            {s}
          </li>
        ))}
      </ol>

      <section>
        <h4>Style du jeu</h4>
        {d.style ? (
          <div className="art-vision-style">
            <a href={api.artFile(slug, d.style.file)} target="_blank" rel="noreferrer">
              <img src={api.artFile(slug, d.style.file)} alt={d.style.label} />
            </a>
            <div>
              <p>
                <b>{d.style.label}</b> <span className="muted small">(duel {d.style.duel})</span>
              </p>
              <p className="muted small">Tous les visuels peuvent être dessinés dans ce style : c'est l'air de famille du jeu.</p>
            </div>
          </div>
        ) : (
          <p className="muted small">Pas encore choisi : le Directeur artistique vous proposera un duel de styles après les références.</p>
        )}
        {otherDuels.length > 0 && (
          <details className="small">
            <summary>Autres duels ({otherDuels.length})</summary>
            {otherDuels.map((x) => (
              <div key={x.id} className="art-vision-duel">
                <span className="muted">
                  {x.id} « {x.subject} »{x.chosen ? ` · style ${x.chosen} choisi` : " · pas tranché"}
                </span>
                <div className="art-vision-thumbs">
                  {x.options.map((o, k) => (
                    <a key={o.file} href={api.artFile(slug, o.file)} target="_blank" rel="noreferrer" title={o.label} className={x.chosen === k + 1 ? "on" : ""}>
                      <img src={api.artFile(slug, o.file)} alt={o.label} loading="lazy" />
                    </a>
                  ))}
                </div>
              </div>
            ))}
          </details>
        )}
      </section>

      {palette.length > 0 && (
        <section>
          <h4>Palette</h4>
          <div className="art-palette">
            {palette.map((p) => (
              <div key={p.hex} className="art-swatch">
                <span style={{ background: p.hex }} />
                <div className="small">
                  <b>{p.hex}</b>
                  {p.role && <span className="muted"> {p.role}</span>}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h4>Vos choix ({choices.length})</h4>
        {choices.length ? (
          <div className="art-vision-choices">
            {choices.map((c) => (
              <figure key={c.question}>
                {c.image && <img src={api.artFile(slug, c.image)} alt="" loading="lazy" />}
                <figcaption className="small">
                  <span className="muted">{c.question}</span>
                  <b>{c.answer}</b>
                </figcaption>
              </figure>
            ))}
          </div>
        ) : (
          <p className="muted small">Vos réponses aux questions du Directeur artistique s'afficheront ici : il ne les repose plus.</p>
        )}
      </section>

      <RefSection slug={slug} title="On s'en inspire" refs={liked} act={act} empty="Les références que vous aimez s'afficheront ici." />
      <RefSection slug={slug} title="On évite" refs={avoided} act={act} empty="Les références à éviter s'afficheront ici." />

      {done.length > 0 && (
        <section>
          <h4>Visuels validés ({done.length})</h4>
          <div className="art-vision-thumbs large">
            {done.map(({ a, file }) => (
              <a key={a.id} href={api.artFile(slug, file)} target="_blank" rel="noreferrer" title={`${a.id} ${a.name}`}>
                <img src={api.artFile(slug, file)} alt={a.name} loading="lazy" />
              </a>
            ))}
          </div>
        </section>
      )}

      <section>
        <h4>La bible complète</h4>
        {bible ? (
          <details>
            <summary className="small">Lire le texte (celui que suivent les agents)</summary>
            <div className="art-bible md">
              <Markdown text={bible} />
            </div>
          </details>
        ) : (
          <p className="muted small">Pas encore de bible : elle sera rédigée une fois le style choisi.</p>
        )}
      </section>
    </div>
  );
}

function RefSection({ slug, title, refs, act, empty }: { slug: string; title: string; refs: ArtReference[]; act: Act; empty: string }) {
  return (
    <section>
      <h4>
        {title} ({refs.length})
      </h4>
      {refs.length ? (
        <div className="art-vision-refs">
          {refs.map((r) => (
            <figure key={r.file}>
              <a href={api.artFile(slug, r.file)} target="_blank" rel="noreferrer">
                <img src={api.artFile(slug, r.file)} alt={r.title} loading="lazy" />
              </a>
              <figcaption className="small">
                <b>{r.title}</b> {r.why && <span className="muted">{r.why}</span>}
                <button className="link small" onClick={() => void act(() => api.artReact(slug, { verdicts: { [r.file]: null }, tell: false }))}>
                  Retirer
                </button>
              </figcaption>
            </figure>
          ))}
        </div>
      ) : (
        <p className="muted small">{empty}</p>
      )}
    </section>
  );
}

/** Le moodboard : vos images et les références du web (avec leur source et votre avis, modifiable). */
export function Moodboard({ slug, images, direction, act }: { slug: string; images: { file: string; note: string | null }[]; direction: ArtDirectionData; act: Act }) {
  const refs = new Map(direction.references.map((r) => [r.file, r]));
  const [filter, setFilter] = useState<"tout" | "vous" | "web">("tout");
  const shown = images.filter((m) => filter === "tout" || (filter === "web") === refs.has(m.file));
  return (
    <>
      <div className="art-mood-filter">
        {(["tout", "vous", "web"] as const).map((f) => (
          <button key={f} className={`small${filter === f ? "" : " secondary"}`} onClick={() => setFilter(f)}>
            {f === "tout" ? "Tout" : f === "vous" ? "Vos images" : "Trouvées sur le web"}
          </button>
        ))}
      </div>
      <div className="art-mood-grid">
        {shown.map((m) => {
          const r = refs.get(m.file);
          return r ? (
            <RefCard key={m.file} slug={slug} r={r} verdict={r.verdict} onToggle={(v) => void act(() => api.artReact(slug, { verdicts: { [r.file]: r.verdict === v ? null : v }, tell: false }))} />
          ) : (
            <figure key={m.file}>
              <a href={api.artFile(slug, m.file)} target="_blank" rel="noreferrer">
                <img src={api.artFile(slug, m.file)} alt={m.file} loading="lazy" />
              </a>
              <figcaption className="small">{m.note ?? <span className="muted">Pas encore commentée</span>}</figcaption>
            </figure>
          );
        })}
      </div>
    </>
  );
}
