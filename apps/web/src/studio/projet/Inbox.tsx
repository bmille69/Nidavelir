import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { api, type InboxItem, type TaskRow } from "../../api.ts";
import { ago } from "../agents.ts";
import { ChoiceCard } from "../Choices.tsx";
import { Answers } from "../Conception.tsx";
import { useNow, useStudio, useStudioRefresh } from "../context.tsx";
import { Icon } from "../Icon.tsx";
import { TryButton } from "../Preview.tsx";
import { money } from "../Workshop.tsx";

/**
 * La boîte « À vous » (ADR-113) : la colonne droite de la Discussion, la même dans tous les modes d'autonomie. Tout ce qui
 * attend votre décision pour ce jeu, le plus urgent en haut (le Gardien d'abord), tranché sur place avec les routes
 * humaines habituelles. Dessous : « En cours » et « Récemment fusionné ». `children` : les replis (fiches notées, bible…).
 */

type Who = "guardian" | "qa" | "developer" | "director" | "art" | "sound" | "concepteur";
const WHO: Record<Who, string> = { guardian: "Gardien", qa: "Testeur", developer: "Développeur", director: "Directeur", art: "Directeur artistique", sound: "Directeur sonore", concepteur: "Concepteur" };

function heading(i: InboxItem): [Who, string] {
  switch (i.kind) {
    case "escalation":
      return ["guardian", "Action hors plan"];
    case "review":
      return ["qa", "Chantier à relire"];
    case "task_plan":
      return ["developer", "Plan à valider"];
    case "proposal":
      return ["director", i.data.proposal.proposal?.options.length ? "Un choix à faire" : i.data.supersedes.length ? "Ça change une décision" : "Une question"];
    case "art":
      return ["art", { question: "Une question", sketch: "Croquis à choisir", model: "3D à décider", image: "Image à décider", render: "Rendu à valider" }[i.data.what]];
    case "production":
      return ["director", i.data.status === "proposed" ? "Plan de production" : "Plan en pause"];
    case "sound":
      return ["sound", "Son à choisir"];
    case "conception":
      return ["concepteur", "Questions"];
    case "failed":
      return ["developer", "Chantier en échec"];
  }
}

const keyOf = (i: InboxItem) => `${i.kind}:${i.id}`;
/** Une décision prise reste masquée le temps que le hub la range (le DA lit votre choix de croquis, par exemple). */
const HIDE_MS = 120_000;
const LEAVE_MS = 380;
const UNDO_MS = 6000;

type Act = (item: InboxItem, run: () => Promise<unknown>, done: string, undo?: () => Promise<unknown>) => Promise<void>;
type Toast = { id: number; text: string; undo?: () => void };

export function InboxRail({ slug, children }: { slug: string; children?: ReactNode }) {
  const snap = useStudio();
  const refreshStudio = useStudioRefresh();
  const project = snap?.projects.find((p) => p.slug === slug);
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [tasks, setTasks] = useState<TaskRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState<Map<string, number>>(new Map());
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<Toast | null>(null);
  const [bump, setBump] = useState(0);
  const now = useNow(30_000);

  const load = useCallback(async () => {
    const [box, ts] = await Promise.all([api.inbox(slug), api.tasks(slug)]);
    setItems(box);
    setTasks(ts);
    setError(null);
  }, [slug]);
  useEffect(() => {
    setItems(null);
    load().catch((e: Error) => setError(e.message));
    const t = setInterval(() => load().catch(() => {}), 4000);
    return () => clearInterval(t);
  }, [load]);
  // Les événements du studio (nouvelle attente, décision prise ailleurs) : on relit tout de suite.
  const signal = `${project?.waiting ?? 0}:${snap?.events[0]?.seq ?? 0}`;
  useEffect(() => {
    load().catch(() => {});
  }, [signal, load]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), UNDO_MS);
    return () => clearTimeout(t);
  }, [toast]);

  const act: Act = async (item, run, done, undo) => {
    const key = keyOf(item);
    await run();
    setLeaving((s) => new Set(s).add(key));
    setTimeout(() => {
      setGone((g) => new Map(g).set(key, Date.now()));
      setLeaving((s) => {
        const n = new Set(s);
        n.delete(key);
        return n;
      });
      setBump((b) => b + 1);
    }, LEAVE_MS);
    setToast({
      id: Date.now(),
      text: done,
      undo: undo
        ? () => {
            setToast(null);
            void undo()
              .then(() => {
                setGone((g) => {
                  const n = new Map(g);
                  n.delete(key);
                  return n;
                });
                return load();
              })
              .catch((e: Error) => setError(e.message));
          }
        : undefined,
    });
    refreshStudio();
    void load().catch(() => {});
  };

  const visible = (items ?? []).filter((i) => Date.now() - (gone.get(keyOf(i)) ?? 0) > HIDE_MS);
  const rows = new Map(tasks.map((t) => [t.id, t]));

  return (
    <aside className="panel inbox-rail" aria-label="À vous">
      <div className="rail-h">
        <h2>
          À vous {visible.length > 0 && <span key={bump} className={`count-badge${bump ? " bump" : ""}`}>{visible.length}</span>}
        </h2>
        <span className="sp" />
        {visible.length > 1 && <small>le plus urgent en haut</small>}
      </div>
      {error && <p className="error small">{error}</p>}
      {items === null ? (
        <div className="dcard dcard-skeleton" aria-busy="true" />
      ) : visible.length === 0 ? (
        <div className="inbox-empty">
          <span className="em-ico">
            <Icon name="check" size={22} />
          </span>
          <h3>Rien ne vous attend</h3>
          <p>L'équipe avance seule. Dès qu'une décision vous revient, elle apparaît ici.</p>
        </div>
      ) : (
        <div className="decks cascade">
          {visible.map((i, k) => (
            <InboxCard key={keyOf(i)} slug={slug} item={i} index={k} leaving={leaving.has(keyOf(i))} now={now} act={act} row={i.kind === "review" ? rows.get(i.data.task) : undefined} />
          ))}
        </div>
      )}
      <Running slug={slug} tasks={tasks} now={now} onChange={() => void load().catch(() => {})} />
      <Merged slug={slug} tasks={tasks} now={now} />
      {children}
      {toast && (
        <div className="inbox-toast" role="status" key={toast.id}>
          <Icon name="check" size={15} />
          <span>{toast.text}</span>
          {toast.undo && (
            <button className="inbox-undo" onClick={toast.undo}>
              Annuler
            </button>
          )}
          <i className="inbox-toast-bar" style={{ animationDuration: `${UNDO_MS}ms` }} />
        </div>
      )}
    </aside>
  );
}

/** Une carte : qui la pose et quoi, le titre, le contenu propre à son type, les gestes sur place. */
function InboxCard({ slug, item, index, leaving, now, act, row }: { slug: string; item: InboxItem; index: number; leaving: boolean; now: number; act: Act; row?: TaskRow }) {
  const [who, kind] = heading(item);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLElement>(null);
  // Pour que la carte se replie depuis sa vraie hauteur.
  const [height, setHeight] = useState<number | null>(null);
  useEffect(() => {
    if (leaving && box.current) setHeight(box.current.offsetHeight);
  }, [leaving]);

  const run = async (fn: () => Promise<unknown>, done: string, undo?: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await act(item, fn, done, undo);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const style = { "--i": index, ...(height !== null ? { maxHeight: height } : {}) } as CSSProperties;
  return (
    <article ref={box} className={`dcard k-${item.kind}${item.kind === "escalation" ? " urgent" : ""}${leaving ? " leaving" : ""}`} style={style} data-inbox={item.kind}>
      <div className="dk">
        <i className={`who-dot who-${who}`} aria-hidden="true" />
        <span className="dk-l">
          {WHO[who]} · {kind}
        </span>
        <span className="sp" />
        {item.at && <time dateTime={item.at}>{ago(item.at, now)}</time>}
      </div>
      {item.kind !== "proposal" && <h3>{item.title}</h3>}
      <CardBody slug={slug} item={item} busy={busy} run={run} row={row} />
      {error && <p className="error small">{error}</p>}
    </article>
  );
}

type Run = (fn: () => Promise<unknown>, done: string, undo?: () => Promise<unknown>) => Promise<void>;

function CardBody({ slug, item: i, busy, run, row }: { slug: string; item: InboxItem; busy: boolean; run: Run; row?: TaskRow }) {
  switch (i.kind) {
    case "escalation":
      return <EscalationBody slug={slug} item={i} busy={busy} run={run} />;
    case "review":
      return <ReviewBody slug={slug} item={i} busy={busy} run={run} row={row} />;
    case "task_plan":
      return (
        <>
          <p className="d">{i.data.summary}</p>
          {i.data.problems.length > 0 && <p className="error small">Ce plan ne peut pas être validé : {i.data.problems.join(" ; ")}</p>}
          <div className="dacts">
            <button
              className="rail-btn primary"
              disabled={busy || i.data.problems.length > 0}
              onClick={() =>
                run(async () => {
                  await api.approvePlan(slug, i.data.task, i.data.hash);
                  await api.execute(slug, i.data.task);
                }, `Plan validé : ${i.data.task} se met au travail`)
              }
            >
              Valider le plan et lancer
            </button>
            <span className="sp" />
            <a className="rail-link" href={i.url}>
              Voir le plan
            </a>
          </div>
        </>
      );
    case "proposal":
      return (
        <ChoiceCard
          slug={slug}
          card={i.data}
          onDone={() => void run(async () => {}, "Décision envoyée au directeur")}
          onError={(m) => void run(() => Promise.reject(new Error(m)), "")}
        />
      );
    case "art":
      return <ArtBody slug={slug} item={i} busy={busy} run={run} />;
    case "production":
      return (
        <>
          {i.data.objective && <p className="d">{i.data.objective}</p>}
          {i.data.status !== "proposed" && <p className="d">{i.text}</p>}
          {i.data.status === "proposed" && i.data.steps > 0 && <p className="muted small">{i.data.steps} étape(s) : chantiers, visuels et sons enchaînés seuls.</p>}
          <div className="dacts">
            {i.data.status === "proposed" && (
              <button className="rail-btn primary" disabled={busy} onClick={() => run(() => api.productionStart(slug, i.data.plan), "Plan validé : les étapes s'enchaînent")}>
                <Icon name="play" size={13} /> Valider le plan
              </button>
            )}
            <span className="sp" />
            <a className="rail-link" href={i.data.status === "proposed" ? `#/p/${slug}/t/${i.data.thread}` : i.url}>
              {i.data.status === "proposed" ? "Voir le plan" : "Ouvrir le plan"}
            </a>
          </div>
        </>
      );
    case "sound":
      return (
        <>
          <p className="d">{i.data.usage}</p>
          {!i.data.configured ? (
            <p className="muted small">Ajoutez votre clé ElevenLabs pour écouter des essais.</p>
          ) : i.data.takes.length === 0 ? (
            <div className="dacts">
              <button className="rail-btn primary" disabled={busy} onClick={() => run(() => api.soundGenerate(slug, i.data.sound, 3), "Trois essais demandés au directeur sonore")}>
                Fabriquer 3 essais
              </button>
              <span className="muted small">crédits ElevenLabs comptés</span>
            </div>
          ) : (
            <div className="snd-takes">
              {i.data.takes.map((f, k) => (
                <div key={f} className="snd-take">
                  <span className="muted small">Essai {k + 1}</span>
                  <audio controls preload="none" src={api.soundTake(slug, f)} />
                  <button className="rail-btn" disabled={busy} onClick={() => run(() => api.soundChoose(slug, i.data.sound, f), `${i.data.name} : essai ${k + 1} gardé`)}>
                    Garder
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="dacts">
            <span className="sp" />
            <a className="rail-link" href={i.url}>
              Ouvrir le plan
            </a>
          </div>
        </>
      );
    case "conception":
      return (
        <>
          <p className="d">{i.text}</p>
          <Answers questions={i.data.questions} onSend={(text) => run(() => api.replyConception(i.data.conception, text), "Réponses envoyées au Concepteur")} />
          <a className="rail-link" href={i.url}>
            Ouvrir la conception
          </a>
        </>
      );
    case "failed":
      return (
        <>
          <p className="d">{i.text}</p>
          <div className="dacts">
            <button className="rail-btn primary" disabled={busy} onClick={() => run(() => api.startTask(slug, i.data.task), `${i.data.task} relancé de zéro`)}>
              <Icon name="refresh" size={13} /> Relancer
            </button>
            <button
              className="rail-btn ghost"
              disabled={busy}
              onClick={() => window.confirm("Abandonner ce chantier ? Sa copie de travail sera supprimée.") && run(() => api.abandonTask(slug, i.data.task), `${i.data.task} abandonné`)}
            >
              Abandonner
            </button>
            <span className="sp" />
            <a className="rail-link" href={i.url}>
              Détails
            </a>
          </div>
        </>
      );
  }
}

/** Le Gardien : le compte à rebours réel jusqu'au refus automatique. */
function EscalationBody({ slug, item: i, busy, run }: { slug: string; item: Extract<InboxItem, { kind: "escalation" }>; busy: boolean; run: Run }) {
  const now = useNow(1000);
  const [why, setWhy] = useState(false);
  const total = i.deadline && i.at ? Date.parse(i.deadline) - Date.parse(i.at) : 0;
  const left = i.deadline ? Math.max(0, Math.round((Date.parse(i.deadline) - now) / 1000)) : 0;
  const mm = Math.floor(left / 60);
  const ss = String(left % 60).padStart(2, "0");
  const R = 2 * Math.PI * 17;
  return (
    <>
      <p className="d">
        Pendant le chantier <a href={i.url}>{i.data.task} « {i.data.taskTitle} »</a>, le Développeur demande une action qui n'était pas prévue dans le plan.
      </p>
      {i.deadline && (
        <div className="countdown">
          <span className="ring" aria-hidden="true">
            <svg viewBox="0 0 40 40">
              <circle className="bg" cx="20" cy="20" r="17" />
              <circle className="fg" cx="20" cy="20" r="17" strokeDasharray={R} strokeDashoffset={total ? R * (1 - (left * 1000) / total) : 0} />
            </svg>
            <span>
              {mm}:{ss}
            </span>
          </span>
          <small>
            Sans réponse dans{" "}
            <b>
              {mm} min {ss} s
            </b>
            , le Gardien refuse et le chantier continue sans.
          </small>
        </div>
      )}
      {why && (
        <div className="why-box small">
          <p>Pourquoi on vous demande : {i.data.reason}.</p>
          {i.data.content && (
            <details>
              <summary>Voir le contenu proposé</summary>
              <pre className="code">{i.data.content}</pre>
            </details>
          )}
        </div>
      )}
      <div className="dacts">
        <button className="rail-btn primary" disabled={busy} onClick={() => run(() => api.decideEscalation(slug, i.data.escalation, true), "Action autorisée : le Développeur reprend")}>
          Autoriser
        </button>
        <button className="rail-btn" disabled={busy} onClick={() => run(() => api.decideEscalation(slug, i.data.escalation, false), "Action refusée : le chantier continue sans")}>
          Refuser
        </button>
        <span className="sp" />
        <button className="rail-link" aria-expanded={why} onClick={() => setWhy((w) => !w)}>
          Pourquoi ?
        </button>
      </div>
    </>
  );
}

const VERDICT = { pass: "validé", pass_with_notes: "validé avec remarques", fail: "problèmes trouvés" } as const;

/** Un chantier à relire : la capture, le résultat en clair, l'avis du Testeur ; fusionner ou demander une correction. */
function ReviewBody({ slug, item: i, busy, run, row }: { slug: string; item: Extract<InboxItem, { kind: "review" }>; busy: boolean; run: Run; row?: TaskRow }) {
  const [fix, setFix] = useState(false);
  const [note, setNote] = useState("");
  const [shot, setShot] = useState(true);
  const task = i.data.task;
  return (
    <>
      {shot && (
        <a className="dshot" href={api.screenshotUrl(slug, task, i.data.updated_at)} target="_blank" rel="noreferrer">
          <img src={api.screenshotUrl(slug, task, i.data.updated_at)} alt={`Le jeu avec le chantier ${task}`} loading="lazy" onError={() => setShot(false)} />
        </a>
      )}
      <p className="d">{i.text}</p>
      {row?.restarted_from && <p className="muted small">Repris après un redémarrage (ancien {row.restarted_from}).</p>}
      {i.data.verdict && (
        <div className={`tester v-${i.data.verdict}`}>
          <Icon name={i.data.verdict === "fail" ? "close" : "check"} size={14} />
          <div>
            <b>Testeur · {VERDICT[i.data.verdict]}.</b> {i.data.tester}
            {i.data.played && <span className="muted"> Essayé en jouant : {i.data.played}</span>}
          </div>
        </div>
      )}
      {fix && (
        <div className="reveal-box">
          <textarea rows={2} placeholder="Qu'est-ce qui ne va pas ? (ex. « les grues sont trop grosses »)" value={note} onChange={(e) => setNote(e.target.value)} autoFocus />
          <div className="dacts">
            <button className="rail-btn primary" disabled={busy || !note.trim()} onClick={() => run(() => api.requestChanges(slug, task, note.trim()), "Correction demandée au Développeur")}>
              Envoyer la correction
            </button>
            <button className="rail-btn ghost" onClick={() => setFix(false)}>
              Annuler
            </button>
          </div>
        </div>
      )}
      <div className="dacts">
        <button
          className="rail-btn primary"
          disabled={busy}
          onClick={() =>
            run(async () => {
              const r = await api.review(slug, task);
              if (!r.head) throw new Error("Ce chantier n'a pas de modifications à fusionner");
              await api.merge(slug, task, r.head);
            }, `${task} fusionné dans votre jeu`)
          }
        >
          <Icon name="check" size={13} /> Fusionner
        </button>
        {!fix && (
          <button className="rail-btn" disabled={busy} onClick={() => setFix(true)}>
            Demander une correction
          </button>
        )}
      </div>
      <div className="dacts dacts-sub">
        <TryButton slug={slug} task={task} label="▶ Lancer le jeu" small />
        <span className="sp" />
        <a className="rail-link" href={i.url}>
          Détails et changements
        </a>
      </div>
    </>
  );
}

/** Le Directeur artistique : choisir un croquis, valider ou refaire une image ou une 3D, ou la mettre de côté (annulable). */
function ArtBody({ slug, item: i, busy, run }: { slug: string; item: Extract<InboxItem, { kind: "art" }>; busy: boolean; run: Run }) {
  const [pick, setPick] = useState<number | null>(null);
  const { what, asset, name, sketches, image, verdict } = i.data;
  if (what === "question" || !asset)
    return (
      <>
        <p className="d">Il attend votre réponse dans sa discussion pour avancer.</p>
        <div className="dacts">
          {/* « /da » ouvre sa discussion par-dessus la galerie d'Art & son (ADR-113). */}
          <a className="rail-btn primary" href={/\/art$/.test(i.url) ? `${i.url}/da` : i.url}>
            Répondre au Directeur artistique
          </a>
        </div>
      </>
    );
  return (
    <>
      {what === "sketch" ? (
        <div className="sketches" role="radiogroup" aria-label="Croquis">
          {sketches.map((s, k) => (
            <button key={s.file} className={`sketch${pick === k ? " on" : ""}`} role="radio" aria-checked={pick === k} onClick={() => setPick(k)} title={s.label}>
              <em>{k + 1}</em>
              <img src={api.artFile(slug, s.file)} alt={s.label} loading="lazy" />
            </button>
          ))}
        </div>
      ) : (
        image && (
          <a className="dshot art" href={api.artFile(slug, image)} target="_blank" rel="noreferrer">
            <img src={api.artFile(slug, image)} alt={`Rendu de ${name ?? asset}`} loading="lazy" />
          </a>
        )
      )}
      {what === "sketch" && <p className="d">{pick === null ? "Choisissez la direction : la fabrication en tire des variantes." : `${pick + 1}. ${sketches[pick]!.label}`}</p>}
      {verdict && !verdict.ok && (
        <div className="tester v-fail">
          <Icon name="close" size={14} />
          <div>
            <b>Le validateur : à retoucher.</b> {verdict.summary}
          </div>
        </div>
      )}
      <div className="dacts">
        {what === "sketch" ? (
          <button
            className="rail-btn primary"
            disabled={busy || pick === null}
            onClick={() => pick !== null && run(() => api.artSend(slug, `Quel croquis pour ${asset} « ${name} » ? → Croquis ${pick + 1} : ${sketches[pick]!.label}`), `Croquis ${pick + 1} gardé : le Directeur artistique s'y met`)}
          >
            Garder ce croquis
          </button>
        ) : (
          <>
            <button className="rail-btn primary" disabled={busy} onClick={() => run(() => api.artDecide(slug, asset, "valider"), `${asset} validé`)}>
              {what === "render" ? "Valider" : "Valider quand même"}
            </button>
            <button className="rail-btn" disabled={busy} onClick={() => run(() => api.artDecide(slug, asset, "refaire"), `${asset} renvoyé en fabrication`)}>
              Refaire
            </button>
          </>
        )}
        <span className="sp" />
        <button
          className="rail-link"
          disabled={busy}
          title="Personne n'y touche, il sort de la file ; vous pourrez l'y remettre"
          onClick={() => run(() => api.artAside(slug, asset, true), `${asset} mis de côté`, () => api.artAside(slug, asset, false))}
        >
          Plus tard
        </button>
      </div>
    </>
  );
}

const STEPS = ["Consigne", "Codage", "Tests", "Relecture", "Fusion"];
const PHASE = { plan: 0, execute: 1, checks: 2, verify: 3, merge: 4 } as const;
const ACTIVE = new Set(["draft", "planning", "approved", "running", "changes_requested"]);

/** L'état d'un visuel attendu par un chantier, en clair (ADR-64). */
function visualLabel(v: NonNullable<TaskRow["visuals"]>[number]): string {
  if (v.status === "integre") return "dans le jeu";
  if (v.status === "integration") return "en intégration";
  if (v.status === "valide") return "validé";
  if (v.status === "ecarte") return "mis de côté";
  if (v.status === "production" || v.status === "a_valider" || v.launched) return "chez le DA";
  return "provisoire";
}

/** « En cours » : les chantiers en travail puis la file, dans son vrai ordre (ADR-64), avec leur étape. */
function Running({ slug, tasks, now, onChange }: { slug: string; tasks: TaskRow[]; now: number; onChange: () => void }) {
  const rank = (t: TaskRow) => (t.status !== "draft" ? 0 : t.queue_rank ? t.queue_rank : 10_000);
  const list = tasks
    .filter((t) => ACTIVE.has(t.status) && t.pending_escalations === 0)
    .sort((a, b) => rank(a) - rank(b) || (a.status !== "draft" ? (b.updated_at > a.updated_at ? 1 : -1) : a.id > b.id ? 1 : -1));
  return (
    <section className="rail-sec" aria-label="En cours">
      <h4>
        En cours
        <span className="sp" />
        <TryButton slug={slug} label="▶ Lancer le jeu" small />
      </h4>
      {list.length === 0 && <p className="run run-empty">Aucun chantier en cours ni en file. Quand une proposition du directeur vous va, dites « go ».</p>}
      <ul className="rail-runs">
        {list.map((t) => {
          const queued = t.status === "draft";
          const step = t.progress ? PHASE[t.progress.phase] : t.status === "planning" || t.status === "approved" ? 0 : t.status === "running" ? 1 : -1;
          return (
            <li key={t.id} className={`run${queued ? " queued" : ""}`}>
              <a className="run-h" href={`#/p/${slug}/tasks/${t.id}`}>
                <span className="run-id">{t.id}</span>
                <b>{t.title}</b>
                <small>{queued ? (t.queue_rank ? `n° ${t.queue_rank} dans la file` : t.queued_at ? "en file" : "prêt à lancer") : ago(t.updated_at, now)}</small>
              </a>
              {!queued && (
                <span className="steps" aria-label={t.progress?.label ?? STEPS[Math.max(0, step)]}>
                  {STEPS.map((s, k) => (
                    <i key={s} className={k < step ? "done" : k === step ? "cur" : ""} />
                  ))}
                </span>
              )}
              {(t.restarted_from || (t.visuals && t.visuals.length > 0) || !queued) && (
                <span className="run-meta">
                  {!queued && <span>{t.status === "changes_requested" ? "Corrections demandées" : (t.progress?.label ?? `étape ${step + 1}/5 : ${STEPS[Math.max(0, step)]}`)}</span>}
                  {t.restarted_from && <span>repris après un redémarrage (ancien {t.restarted_from})</span>}
                  {t.visuals?.map((v) => (
                    <span key={v.id} className={`visual-chip vs-${v.status}${v.launched ? " launched" : ""}`} title={`${v.id} « ${v.name} » : ${visualLabel(v)}`}>
                      {v.id} · {visualLabel(v)}
                    </span>
                  ))}
                  {t.cost_usd > 0 && <span title="Équivalent API, pris sur votre abonnement">≈ {money(t.cost_usd)}</span>}
                </span>
              )}
              {queued && !t.queued_at && <StartButton slug={slug} task={t.id} onStarted={onChange} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function StartButton({ slug, task, onStarted }: { slug: string; task: string; onStarted: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <span className="dacts">
      <button
        className="rail-btn"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            await api.startTask(slug, task);
            onStarted();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Lancement…" : "▶ Lancer ce chantier"}
      </button>
      {error && <span className="error small">{error}</span>}
    </span>
  );
}

/** « Récemment fusionné » : les trois derniers, la capture en vignette ; le reste dans le Récap. */
function Merged({ slug, tasks, now }: { slug: string; tasks: TaskRow[]; now: number }) {
  const done = tasks
    .filter((t) => t.status === "merged")
    .sort((a, b) => (b.updated_at > a.updated_at ? 1 : -1))
    .slice(0, 3);
  if (!done.length) return null;
  return (
    <section className="rail-sec" aria-label="Récemment fusionné">
      <h4>
        Récemment fusionné
        <span className="sp" />
        <a className="rail-link" href={`#/p/${slug}/recap`}>
          Tout le récap <Icon name="arrow" size={12} />
        </a>
      </h4>
      {done.map((t) => (
        <a key={t.id} className="merged-row" href={`#/p/${slug}/tasks/${t.id}`}>
          <MergedThumb slug={slug} task={t.id} version={t.updated_at} />
          <span>
            <b>{t.title}</b>
            <small>
              {t.id} · {ago(t.updated_at, now)}
              {t.cost_usd > 0 ? ` · ≈ ${money(t.cost_usd)}` : ""}
            </small>
          </span>
        </a>
      ))}
    </section>
  );
}

function MergedThumb({ slug, task, version }: { slug: string; task: string; version: string }) {
  const [ok, setOk] = useState(true);
  return ok ? <img src={api.screenshotUrl(slug, task, version)} alt="" loading="lazy" onError={() => setOk(false)} /> : <span className="merged-ph" aria-hidden="true" />;
}

/** Nombre de cartes de la boîte, pour l'onglet Discussion et le segment du téléphone. */
export function useInboxCount(slug: string): number {
  return useStudio()?.projects.find((p) => p.slug === slug)?.waiting ?? 0;
}

/**
 * Un repli sous la boîte (fiches notées, par exemple). `open` le déplie tant que vous n'y avez pas touché : il s'ouvre
 * quand quelque chose arrive, puis respecte votre geste.
 */
export function RailFold({ summary, open: wanted, className, children }: { summary: ReactNode; open: boolean; className?: string; children: ReactNode }) {
  const [open, setOpen] = useState(wanted);
  const touched = useRef(false);
  useEffect(() => {
    if (!touched.current) setOpen(wanted);
  }, [wanted]);
  return (
    <details
      className={`rail-more ${className ?? ""}`}
      open={open}
      onToggle={(e) => {
        const now = e.currentTarget.open;
        if (now !== open) {
          touched.current = true;
          setOpen(now);
        }
      }}
    >
      <summary>{summary}</summary>
      <div className="rail-more-body">{children}</div>
    </details>
  );
}
