import { useState, type ReactNode } from "react";
import { api } from "../../api.ts";
import { Annotator } from "../Annotator.tsx";
import { Icon } from "../Icon.tsx";
import { Linkify } from "../Linkify.tsx";
import { PlanCard, splitProduction } from "../Plans.tsx";
import { TryButton } from "../Preview.tsx";
import { splitTeam, TeamCards } from "../TeamCards.tsx";

/**
 * Les messages de la discussion, lisibles (ADR-113). Le texte reste celui du hub (le directeur relit le même
 * historique) ; seul l'affichage change : le compte rendu de fin de chantier devient une carte (ce qui change en clair,
 * capture, avis du Testeur, « ▶ Lancer le jeu », le technique replié), la consigne envoyée au Développeur une carte
 * « Proposition de chantier », et les lignes « chantier lancé / en attente » une ligne discrète.
 */

const BRIEF_MARK = "§CONSIGNE§ ";
const CAPTURE = /^§CAPTURE§ (T-\d+) (\S+)$/m;
/** Les captures annotées jointes (ADR-72), une par ligne. */
export const IMAGES = /^§IMAGE§ (studio\/captures\/\S+)$/gm;
/** Les poses de contrôle photographiées par le hub (ADR-122), une par ligne. */
const POSES = /^§POSE§ (T-\d+) (\S+) (\S+)$/gm;

/** Tête du compte rendu (autopilot.ts, `#reviewReport`) : « ✓ Chantier T-0001 « titre » terminé… ». */
const REPORT_HEAD = /^(✓|⚠) Chantier (T-\d+) « (.+) » terminé(.*)$/;
/** Lignes d'avancement que le hub ajoute à la discussion (lancé, en file, en parallèle, corrigé, fusionné). */
const EVENT = /^(?:(→|⏳|⇉|↻) Chantier T-\d+ «|(✓|↻) T-\d+ )/;

type Annotate = (text: string, image: Blob) => Promise<void>;

/** Un message du hub fait seulement de lignes d'avancement (« Chantier … lancé ») : affiché sans avatar ni nom. */
export function isEventOnly(text: string): boolean {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.length > 0 && lines.every((l) => EVENT.test(l));
}

/** Texte d'un message : texte libre, captures jointes, cartes du compte rendu et des propositions, encarts de l'équipe. */
export function MessageText({ text: raw, slug, annotate }: { text: string; slug: string; annotate: Annotate }) {
  // Les encarts de l'équipe (ADR-98) : consultations et souvenirs proposés, à part du texte.
  const team = splitTeam(raw);
  const { consults, memories } = team;
  // Le plan de production annoncé (ADR-107) : sa carte, à valider d'un clic, à la place de la ligne du hub.
  const { text, ids: plans } = splitProduction(team.text);
  const shot = CAPTURE.exec(text);
  const images = [...text.matchAll(IMAGES)].map((m) => m[1]!);
  const poses = [...text.matchAll(POSES)].map((m) => ({ task: m[1]!, version: m[2]!, nom: m[3]! }));
  const [intro, ...briefs] = text.replace(CAPTURE, "").replace(IMAGES, "").replace(POSES, "").split(BRIEF_MARK);
  const head = REPORT_HEAD.exec(intro!.trim().split("\n")[0] ?? "");
  const lines = intro!.trim().split("\n");
  const events = head ? [] : lines.filter((l) => EVENT.test(l.trim()));
  const body = head ? "" : lines.filter((l) => !EVENT.test(l.trim())).join("\n").trim();
  return (
    <>
      {head ? (
        <ReportCard slug={slug} head={head} text={intro!.trim()} shot={shot ? { task: shot[1]!, version: shot[2]! } : null} annotate={annotate} />
      ) : (
        body && (
          <div className="text">
            <Linkify text={body} />
          </div>
        )
      )}
      {events.map((l, k) => (
        <EventLine key={k} slug={slug} line={l.trim()} />
      ))}
      {images.map((f) => (
        <a key={f} className="msg-image" href={api.captureUrl(slug, f)} target="_blank" rel="noreferrer">
          <img src={api.captureUrl(slug, f)} alt="Capture annotée" loading="lazy" />
        </a>
      ))}
      {!head && shot && <Shot slug={slug} task={shot[1]!} version={shot[2]!} annotate={annotate} />}
      {poses.map((p) => (
        <a key={p.nom} className="msg-image" href={api.poseUrl(slug, p.task, p.nom, p.version)} target="_blank" rel="noreferrer" title={decodeURIComponent(p.nom)}>
          <img src={api.poseUrl(slug, p.task, p.nom, p.version)} alt={`Pose de contrôle ${decodeURIComponent(p.nom)}`} loading="lazy" />
        </a>
      ))}
      {briefs.map((b, k) => (
        <Proposal key={k} brief={b} />
      ))}
      {plans.map((id) => (
        <PlanCard key={id} slug={slug} id={id} compact />
      ))}
      <TeamCards consults={consults} memories={memories} />
    </>
  );
}

/** Une ligne d'avancement : discrète, l'icône dit lancé, en file ou corrigé ; le chantier mène à sa page. */
function EventLine({ slug, line }: { slug: string; line: string }) {
  const mark = line.slice(0, 1);
  const rest = line.replace(/^\S+\s+/, "");
  const icon = mark === "⏳" ? "clock" : mark === "✓" ? "check" : mark === "↻" ? "refresh" : "arrow";
  const id = /T-\d+/.exec(rest)?.[0];
  const at = id ? rest.indexOf(id) : -1;
  // Le titre « … » qui suit le numéro, en gras ; la fin de phrase (« suivi en direct à droite… ») reste discrète.
  const end = at >= 0 ? rest.indexOf("»", at) : -1;
  const strong = at >= 0 ? rest.slice(at, end >= 0 ? end + 1 : at + id!.length) : "";
  return (
    <p className={`event${mark === "⏳" ? " wait" : mark === "✓" ? " done" : ""}`}>
      <Icon name={icon} size={14} />
      <span>
        {at >= 0 ? (
          <>
            {rest.slice(0, at)}
            <a href={`#/p/${slug}/tasks/${id}`}>
              <b>{strong}</b>
            </a>
            {rest.slice(at + strong.length)}
          </>
        ) : (
          rest
        )}
      </span>
    </p>
  );
}

/** La consigne envoyée au Développeur : son titre et son objectif en clair, la consigne complète repliée. */
function Proposal({ brief }: { brief: string }) {
  const [title, ...rest] = brief.split("\n");
  const full = rest.join("\n").trim();
  const goal = /^Objectif\s*:\s*(.+)$/m.exec(full)?.[1];
  return (
    <div className="brief proposal-card">
      <span className="proposal-lbl">
        <Icon name="pen" size={13} /> Proposition de chantier
      </span>
      <h4>{title}</h4>
      {goal && <p>{goal}</p>}
      {full && (
        <details className="rc-tech">
          <summary>Consigne complète pour le Développeur</summary>
          <div className="text small">{full}</div>
        </details>
      )}
    </div>
  );
}

const OUTCOMES: [RegExp, string, "ok" | "ember", boolean][] = [
  [/^C'est dans votre jeu/, "Fusionné dans le jeu", "ok", false],
  [/^Cliquez sur « ▶ Essayer »/, "Prêt à essayer", "ember", true],
  [/^Il attend votre avis/, "Attend votre avis", "ember", true],
  [/^Je n'ai pas pu le fusionner/, "Fusion bloquée", "ember", true],
];

/**
 * Le compte rendu de fin de chantier (ADR-113) : deux ou trois lignes en clair (« Ce qui a changé »), la capture du jeu
 * (la photo « en jeu » du Testeur quand il l'a prise), l'avis du Testeur en pastille, « ▶ Lancer le jeu » ou « Essayer
 * cette version », la consigne de fin en ligne discrète, et tout le reste du texte sous « Détails techniques ».
 */
function ReportCard({ slug, head, text, shot, annotate }: { slug: string; head: RegExpExecArray; text: string; shot: { task: string; version: string } | null; annotate: Annotate }) {
  const [, mark, id, title, tail] = head;
  const lines = text.split("\n");
  const changed = lines.find((l) => l.startsWith("Ce qui a changé : "))?.slice("Ce qui a changé : ".length) ?? "";
  const tester = lines.find((l) => l.startsWith("Avis du testeur : "))?.slice("Avis du testeur : ".length) ?? null;
  const closing = [...lines].reverse().find((l) => OUTCOMES.some(([re]) => re.test(l))) ?? null;
  const outcome = closing ? OUTCOMES.find(([re]) => re.test(closing))! : null;
  // « fusionné » dit dans la tête vaut aussi pour un compte rendu sans phrase de fin reconnue.
  const merged = outcome ? outcome[1] === "Fusionné dans le jeu" : /fusionné dans votre jeu/.test(tail ?? "");
  const notes = lines.some((l) => /^ {2}(⚠|✗|Pas vérifié en jeu)/.test(l));
  const verdict = tester === null ? null : mark === "⚠" ? (["fail", "Problèmes relevés"] as const) : notes ? (["notes", "Validé, remarques"] as const) : (["ok", "Validé"] as const);
  const tech = lines.filter((l) => l !== closing && !l.startsWith("Ce qui a changé : ")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return (
    <div className="report">
      <div className={`report-top${shot ? " with-shot" : ""}`}>
        <div className="report-text">
          <span className="report-k">
            {merged ? (
              <span className="report-st ok">
                <Icon name="check" size={13} /> Fusionné dans le jeu
              </span>
            ) : outcome ? (
              <span className={`rc-pill ${outcome[2]}`}>{outcome[1]}</span>
            ) : (
              <span className="report-st">Terminé</span>
            )}
            <span className="tid">· {id}</span>
            {verdict && (
              <span className={`rc-pill ${verdict[0]}`} title={tester ? `Avis du Testeur : ${tester}` : undefined}>
                {verdict[1]}
              </span>
            )}
          </span>
          <h4>{title}</h4>
          {changed && <p className="plain">{changed}</p>}
          <div className="report-acts">
            {merged ? <TryButton slug={slug} label="▶ Lancer le jeu" /> : <TryButton slug={slug} task={id} label="▶ Essayer cette version" />}
            <a className="rail-link" href={`#/p/${slug}/tasks/${id}`}>
              Voir le chantier <Icon name="arrow" size={13} />
            </a>
          </div>
          {closing && !merged && <p className="report-next">{closing}</p>}
        </div>
        {shot && <Shot slug={slug} task={shot.task} version={shot.version} annotate={annotate} inCard />}
      </div>
      {tech && (
        <details className="rc-tech report-tech">
          <summary>Détails techniques</summary>
          <div>{tech}</div>
        </details>
      )}
    </div>
  );
}

/**
 * La capture d'un chantier (ADR-33, ADR-113) : la photo « en jeu » du Testeur si elle est de la dernière vérification,
 * sinon le jeu au lancement (le hub choisit). « Montrer un défaut » l'ouvre pour l'annoter (ADR-72).
 */
function Shot({ slug, task, version, annotate, inCard }: { slug: string; task: string; version: string; annotate: Annotate; inCard?: boolean }) {
  const [missing, setMissing] = useState(false);
  const [drawing, setDrawing] = useState(false);
  if (missing) return null;
  const src = api.screenshotUrl(slug, task, version);
  const caption: ReactNode = (
    <button className="rail-link capture-annotate" onClick={() => setDrawing(true)}>
      <Icon name="pen" size={12} /> Montrer un défaut
    </button>
  );
  return (
    <figure className={inCard ? "report-shot" : "capture"}>
      <a href={src} target="_blank" rel="noreferrer">
        <img src={src} alt={`Le jeu avec le chantier ${task}`} loading="lazy" onError={() => setMissing(true)} />
      </a>
      <figcaption>{caption}</figcaption>
      {drawing && <Annotator source={src} title={`Capture de ${task}`} onClose={() => setDrawing(false)} onSend={annotate} />}
    </figure>
  );
}
