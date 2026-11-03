import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { useStudio } from "../studio/context.tsx";
import { AUTONOMY } from "../studio/Autonomy.tsx";
import { InboxRail, RailFold, useInboxCount } from "../studio/projet/Inbox.tsx";
import { RecentBible } from "../studio/Choices.tsx";
import { Replays } from "../studio/Replays.tsx";
import { Annotator, withImage } from "../studio/Annotator.tsx";
import { href, navigate } from "../App.tsx";
import { ThreadList, useSeen } from "../studio/ThreadList.tsx";
import { Icon } from "../studio/Icon.tsx";
import { IMAGES, isEventOnly, MessageText } from "../studio/projet/Messages.tsx";
import { api, type Item, type Job, type Message, type Thread } from "../api.ts";

/** Même seuil que l'affichage téléphone de studio.css. */
const PHONE = typeof window !== "undefined" && !!window.matchMedia?.("(max-width: 860px)").matches;

const TYPE_LABEL: Record<string, string> = {
  vision: "Vision",
  goal: "Objectif",
  mechanic: "Mécanique",
  constraint: "Contrainte",
  reference: "Référence",
  idea: "Idée",
  hypothesis: "Hypothèse",
  question: "Question",
  decision: "Décision",
  spec: "Spécification",
};
const STATUS_LABEL: Record<string, string> = { captured: "à trier", triaged: "retenu", open: "ouvert", validated: "validé" };

type Panel = "noted" | "inbox" | "canon";
const PAGE = 50;
const sourceOf = (i: Item) => (i.source.kind === "file" ? i.source.ref.split("#")[0]! : "conversations");

export function ProjectView({ slug, threadId, fresh }: { slug: string; threadId?: string; fresh?: boolean }) {
  const autonomy = useStudio()?.projects.find((p) => p.slug === slug)?.autonomy ?? "supervised";
  const auto = autonomy !== "supervised";
  const workshop = autonomy === "workshop";
  const [threads, setThreads] = useState<Thread[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [panel, setPanel] = useState<Panel>(threadId ? "noted" : "inbox");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const [source, setSource] = useState("all");
  const [type, setType] = useState("all");
  const [onlyHint, setOnlyHint] = useState(false);
  const [onlyNewChoice, setOnlyNew] = useState(true);
  const [shown, setShown] = useState(PAGE);
  // Sur téléphone, un seul panneau à la fois (ADR-113) : « À vous » d'abord quand une décision attend, la conversation, ou les fils.
  const waiting = useInboxCount(slug);
  const studioReady = useStudio() !== null;
  const [pane, setPane] = useState<"chat" | "side" | "threads">(() => (waiting > 0 && !fresh ? "side" : "chat"));
  // L'état du studio arrive après le premier affichage : « À vous » s'ouvre alors, sauf si vous avez déjà choisi.
  const paneChosen = useRef(false);
  const choosePane = (p: "chat" | "side" | "threads") => {
    paneChosen.current = true;
    setPane(p);
  };
  useEffect(() => {
    if (studioReady && !paneChosen.current && !fresh && waiting > 0) setPane("side");
    if (studioReady) paneChosen.current = true;
  }, [studioReady]);
  // Un fil choisi dans « Fils » s'ouvre dans la conversation.
  useEffect(() => {
    setPane((p) => (p === "threads" ? "chat" : p));
  }, [threadId, fresh]);
  // En autonomie, rien n'est « à trier » : on montre tout ce qui est noté.
  const onlyNew = onlyNewChoice && !auto;

  // Les discussions bougent toutes seules (le Concepteur ou le hub y écrivent) : on les suit.
  const [threadsLoaded, setThreadsLoaded] = useState(false);
  const loadThreads = useCallback(
    () =>
      api.threads(slug).then((ts) => {
        setThreads(ts);
        setThreadsLoaded(true);
      }),
    [slug],
  );
  useEffect(() => {
    setThreadsLoaded(false);
    void loadThreads().catch(() => {});
    const t = setInterval(() => void loadThreads().catch(() => {}), 4000);
    return () => clearInterval(t);
  }, [loadThreads]);
  const { markSeen, unread } = useSeen(slug, threads, threadsLoaded);

  // En ouvrant le projet, on vous place sur la discussion en vigueur : la vôtre la plus récemment active (ADR-113),
  // pas un fil que le hub a ouvert seul pour intégrer un visuel ; à défaut, la plus récente tout court.
  useEffect(() => {
    if (threadId || fresh || !threadsLoaded) return;
    const latest = threads.find((t) => (t.messages ?? 0) > 0 && !t.automatic) ?? threads.find((t) => (t.messages ?? 0) > 0);
    if (latest) window.location.replace(href({ page: "project", slug, thread: latest.id }));
  }, [threadId, fresh, threadsLoaded, threads, slug]);

  // La discussion courante est lue via une référence : un rafraîchissement lancé juste avant
  // la création d'une discussion ne doit pas effacer les messages de la nouvelle.
  const threadRef = useRef(threadId);
  threadRef.current = threadId;
  const refresh = useCallback(async () => {
    const current = threadRef.current;
    const [msgs, its, js] = await Promise.all([
      current ? api.messages(slug, current) : Promise.resolve([] as Message[]),
      api.items(slug, panel === "canon" ? "canon" : "inbox", panel === "noted" ? current : undefined),
      api.jobs(slug),
    ]);
    if (current === threadRef.current) setMessages(msgs);
    setItems(its.items);
    setJobs(js);
  }, [slug, threadId, panel]);

  useEffect(() => {
    refresh().catch((e: Error) => setError(e.message));
  }, [refresh]);

  // Rafraîchit tant qu'une extraction ou un amorçage est en cours.
  // En autonomie, le directeur peut écrire après coup (ex. « tâche confiée au développeur ») : on suit la discussion.
  const busy = (auto && !!threadId) || messages.some((m) => m.extraction === "pending") || jobs.some((j) => j.status === "running");
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => refresh().catch(() => {}), 2500);
    return () => clearInterval(t);
  }, [busy, refresh]);

  // Accolades obligatoires : les navigateurs récents renvoient une promesse, que React prendrait pour une fonction de nettoyage.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, sending]);

  // Ce que vous voyez est lu : la pastille de cette discussion disparaît.
  useEffect(() => {
    const last = messages.at(-1);
    if (threadId && last && last.thread === threadId && last.id !== "pending") markSeen(threadId, last.seq);
  }, [messages, threadId]);

  /** Une page blanche : rien n'est créé avant votre premier message (un clic de trop ne laisse aucune trace). */
  function newThread() {
    setMessages([]);
    navigate({ page: "project", slug, fresh: true });
  }

  // Le bandeau « Du nouveau » ne parle que de vos fils : un fil automatique le dit sur son groupe replié (ADR-113).
  const news = threads.filter((t) => t.id !== threadId && !t.automatic && unread(t) > 0);
  const current = threads.find((t) => t.id === threadId);

  /** `override` : un message tout prêt (capture annotée, ADR-72), envoyé sans toucher au brouillon. */
  async function send(override?: string) {
    const text = (override ?? draft).trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    let thread = threadId;
    try {
      if (!thread) {
        const t = await api.createThread(slug, text.replace(IMAGES, "").trim().slice(0, 60) || "Capture annotée");
        setThreads((ts) => [t, ...ts]);
        thread = t.id;
        threadRef.current = thread;
        navigate({ page: "project", slug, thread });
      }
      setMessages((m) => [...m, { id: "pending", thread: thread!, seq: m.length + 1, role: "human", text, at: "", extraction: "pending", cost_usd: null }]);
      if (override === undefined) setDraft("");
      await api.send(slug, thread, text);
      setMessages(await api.messages(slug, thread));
      await refresh();
    } catch (e) {
      setError((e as Error).message);
      if (override === undefined) setDraft(text);
      if (thread) setMessages(await api.messages(slug, thread).catch(() => []));
    } finally {
      setSending(false);
    }
  }

  // Une capture annotée (ADR-72) : l'image part d'abord, puis le message qui la cite ; la fenêtre se ferme sans attendre la réponse.
  const [toAnnotate, setToAnnotate] = useState<Blob | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const annotate = async (text: string, image: Blob) => {
    if (sending) throw new Error("Attendez la réponse du directeur, puis renvoyez.");
    const { line } = await api.captureUpload(slug, image);
    const words = text || draft.trim();
    if (!text) setDraft("");
    void send(withImage(words, line));
  };

  const sources = [...new Set(items.map(sourceOf))].sort();
  const types = [...new Set(items.map((i) => i.type))].sort();
  const filtering = panel === "inbox";
  const visible = filtering
    ? items.filter(
        (i) =>
          (source === "all" || sourceOf(i) === source) &&
          (type === "all" || i.type === type) &&
          (!onlyHint || i.hint === "existing_decision") &&
          (!onlyNew || i.status === "captured" || i.status === "open"),
      )
    : items;
  const batchable = visible.filter((i) => i.status === "captured" || i.status === "triaged").map((i) => i.id);

  async function triageAll(action: "keep" | "discard") {
    const ids = action === "keep" ? visible.filter((i) => i.status === "captured").map((i) => i.id) : batchable;
    if (!ids.length) return;
    const verb = action === "keep" ? "Retenir" : "Écarter";
    if (!window.confirm(`${verb} les ${ids.length} élément(s) affichés ? (réversible : rien n'est validé)`)) return;
    try {
      const r = await api.triageBatch(slug, ids, action);
      if (r.errors.length) setError(`${r.errors.length} élément(s) non traités : ${r.errors[0]!.error}`);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function triage(id: string, action: "keep" | "discard") {
    try {
      await api.triage(slug, id, action);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const runningJob = jobs.find((j) => j.status === "running");
  const toTriage = items.filter((i) => i.status === "captured").length;

  return (
    <main className={`project pane-${pane}`}>
      <div className="pane-switch segmented" role="tablist">
        <button role="tab" aria-selected={pane === "side"} className={pane === "side" ? "on" : ""} onClick={() => choosePane("side")}>
          À vous{waiting > 0 && <span className="count warn">{waiting}</span>}
        </button>
        <button role="tab" aria-selected={pane === "chat"} className={pane === "chat" ? "on" : ""} onClick={() => choosePane("chat")}>
          Conversation
        </button>
        <button role="tab" aria-selected={pane === "threads"} className={pane === "threads" ? "on" : ""} onClick={() => choosePane("threads")}>
          Fils
        </button>
      </div>
      <ThreadList slug={slug} threads={threads} current={threadId} fresh={fresh && !threadId} unread={unread} onNew={newThread} onRenamed={() => void loadThreads()} />

      <section className="conversation">
        {/* L'en-tête du fil (ADR-113) : son titre, son origine, sa date ; le mode de travail se lit dans l'en-tête du projet. */}
        <div className="convo-h">
          {current?.automatic && <span className="rc-pill grey nodot">Automatique</span>}
          <h2 title={current?.title}>{current ? current.title : threadId ? "…" : "Nouvelle discussion"}</h2>
          <span className="sp" />
          {current && <small>commencée le {dayOf(current.created_at)}</small>}
          {!auto && (
            <a className="rail-link" href={`#/p/${slug}/decisions`} title="Le directeur propose, vous décidez : les propositions à trancher sont aussi dans « À vous »">
              Toutes les décisions <Icon name="arrow" size={13} />
            </a>
          )}
        </div>
        {news.length > 0 && (
          <div className="thread-news" role="status">
            {news.slice(0, 2).map((t) => (
              <a key={t.id} href={`#/p/${slug}/t/${t.id}`}>
                <span className="live-dot" /> Du nouveau dans « {t.title} » ({unread(t)}) <Icon name="arrow" size={14} />
              </a>
            ))}
          </div>
        )}
        <div className="messages">
          {!threadId && messages.length === 0 && (
            <div className="empty">
              <p>
                {workshop
                  ? "Dites ce que vous voulez pour votre jeu, comme à un chef de projet : « les balles du perso font cheap », « je veux un boss au niveau 3 »… Le directeur connaît votre code et vous propose une solution concrète."
                  : auto
                  ? "Dites ce que vous voulez pour votre jeu. Le directeur vous propose une solution concrète et avance ; il ne vous demande que les vrais choix."
                  : "Parlez de votre jeu librement : intentions, envies, doutes, références. Le directeur reformule, relève les tensions et pose quelques questions."}
              </p>
              <p className="muted small">
                {workshop ? "Quand la proposition vous va, dites « go » : il rédige la consigne et le Développeur se met au travail. Vous suivez l'avancement à droite, dans « En cours »." : auto ? "Ce qu'il retient entre dans la bible du jeu (onglet « Le jeu ») ; s'il a besoin de vous, il vous le demande à droite, dans « À vous »." : "Ce qu'il retient apparaît à droite, sous « Ce que le directeur a noté », à trier quand vous voulez."}
              </p>
              <p className="muted small mode-hint">
                <span className="badge mode">{auto ? AUTONOMY[autonomy].label : "Exploration"}</span>{" "}
                {workshop
                  ? "Dites ce que vous voulez ; le directeur propose, puis « go » lance le chantier."
                  : auto
                    ? "Le directeur propose et décide ce qui ne fait pas débat. Il vous consulte en cas de conflit ou de vrai choix."
                    : "Pensez à voix haute : rien n'est validé sans vous."}
              </p>
            </div>
          )}
          {messages.map((m, k) => {
            const sep = m.at && (k === 0 || dayOf(messages[k - 1]!.at || m.at) !== dayOf(m.at)) ? dayOf(m.at) : null;
            const quiet = m.role === "director" && isEventOnly(m.text);
            return (
              <Fragment key={m.id}>
                {sep && <div className="day-sep">{sep}</div>}
                <div className={`msg ${m.role}${quiet ? " event-only" : ""}`}>
                  {m.role === "director" && !quiet && (
                    <span className="msg-av" aria-hidden="true">
                      D
                    </span>
                  )}
                  <div className="msg-main">
                    {m.role === "director" && !quiet && (
                      <div className="msg-h">
                        <b className="who">Directeur</b>
                        {m.at && <time>{hm(m.at)}</time>}
                      </div>
                    )}
                    <MessageText text={m.text} slug={slug} annotate={annotate} />
                    {m.role === "human" && m.extraction === "pending" && <div className="muted small">analyse en cours…</div>}
                    {m.role === "human" && m.extraction === "failed" && <div className="error small">l'analyse de ce message a échoué</div>}
                  </div>
                  {m.role === "human" && m.at && <time className="msg-time">{hm(m.at)}</time>}
                </div>
              </Fragment>
            );
          })}
          {sending && (
            <div className="msg director thinking">
              <span className="msg-av" aria-hidden="true">
                D
              </span>
              <div className="msg-main">
                <div className="msg-h">
                  <b className="who">Directeur</b>
                </div>
                <div className="typing">Le directeur réfléchit…</div>
              </div>
            </div>
          )}
          <div ref={endRef} />
        </div>
        {error && <p className="error">{error}</p>}
        <div className="composer">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPaste={(e) => {
              const f = [...e.clipboardData.files].find((x) => x.type.startsWith("image/"));
              if (f) {
                e.preventDefault();
                setToAnnotate(f);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={PHONE ? "Écrivez au directeur…" : workshop ? "Écrivez librement au directeur… (« go » lance sa proposition ; Maj+Entrée pour aller à la ligne)" :"Écrivez librement… (Entrée pour envoyer, Maj+Entrée pour aller à la ligne)"}
            rows={PHONE ? 1 : 2}
            enterKeyHint="send"
            disabled={sending}
          />
          <div className="composer-row">
            <button className="secondary attach" onClick={() => fileRef.current?.click()} disabled={sending} aria-label="Joindre une capture à annoter" title="Joindre une capture (ou collez-la) pour y entourer ce qui ne va pas">
              <Icon name="image" size={16} />
              <span className="attach-label">Joindre une capture</span>
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) setToAnnotate(f);
                e.target.value = "";
              }}
            />
            <span className="sp" />
            {/* Les mots qui reviennent le plus en Atelier (ADR-113), posés dans le brouillon : rien ne part sans « Envoyer ». */}
            {workshop &&
              threadId &&
              QUICK.map(([label, words]) => (
                <button key={label} className="qr" disabled={sending} onClick={() => setDraft((d) => (d.trim() ? `${d.trim()} ${words}` : words))}>
                  {label}
                </button>
              ))}
            <button className="send" onClick={() => void send()} disabled={!draft.trim() || sending} aria-label="Envoyer">
              <Icon name="arrow" size={16} className="send-icon" />
              <span className="send-label">Envoyer</span>
            </button>
          </div>
        </div>
        {toAnnotate && <Annotator source={toAnnotate} title="Votre capture" onClose={() => setToAnnotate(null)} onSend={annotate} />}
      </section>

      {/* La boîte « À vous » (ADR-113), la même dans tous les modes ; ce que montraient les anciens panneaux, en replis. */}
      <InboxRail slug={slug}>
        {runningJob && (
          <div className="notice small">
            Lecture des documents :{" "}
            {runningJob.documents.filter((d) => d.status === "done" || d.status === "failed" || d.status === "skipped").length}/
            {runningJob.documents.length} · {runningJob.created} élément(s) noté(s)
          </div>
        )}
        <Replays slug={slug} />
        {auto && <RecentBible slug={slug} />}
        <RailFold
          className="notes-more"
          open={!auto && toTriage > 0}
          summary={
            <>
              Ce que le directeur a noté
              {!auto && toTriage > 0 && <span className="count warn">{toTriage} à trier</span>}
            </>
          }
        >
          <div className="tabs">
            {threadId && (
              <button className={panel === "noted" ? "tab active" : "tab"} onClick={() => setPanel("noted")}>
                Ce que j'ai noté
              </button>
            )}
            <button className={panel === "inbox" ? "tab active" : "tab"} onClick={() => setPanel("inbox")}>
              {auto ? "Noté" : "À trier"}
            </button>
            <button className={panel === "canon" ? "tab active" : "tab"} onClick={() => setPanel("canon")}>
              Validé
            </button>
          </div>

          {jobs
            .filter((j) => j.status !== "running")
            .flatMap((j) => j.documents.filter((d) => d.note))
            .map((d) => (
              <p key={d.path} className="muted small">
                {d.path} : {d.note}
              </p>
            ))}

          {filtering && items.length > 0 && (
            <div className="filters">
              <select value={source} onChange={(e) => { setSource(e.target.value); setShown(PAGE); }}>
                <option value="all">Toutes les sources</option>
                {sources.map((s) => (
                  <option key={s} value={s}>
                    {s === "conversations" ? "Conversations" : s}
                  </option>
                ))}
              </select>
              <select value={type} onChange={(e) => { setType(e.target.value); setShown(PAGE); }}>
                <option value="all">Tous les types</option>
                {types.map((t) => (
                  <option key={t} value={t}>
                    {TYPE_LABEL[t] ?? t}
                  </option>
                ))}
              </select>
              {!auto && (
                <label className="check small">
                  <input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} />
                  Non triés seulement
                </label>
              )}
              <label className="check small">
                <input type="checkbox" checked={onlyHint} onChange={(e) => setOnlyHint(e.target.checked)} />
                « Décision existante ? » seulement
              </label>
              <div className="row">
                <span className="muted small grow">{visible.length} affiché(s) sur {items.length}</span>
                {!auto && (
                  <>
                    <button className="small" disabled={!visible.some((i) => i.status === "captured")} onClick={() => triageAll("keep")}>
                      Retenir tout
                    </button>
                    <button className="small secondary" disabled={!batchable.length} onClick={() => triageAll("discard")}>
                      Écarter tout
                    </button>
                  </>
                )}
              </div>
            </div>
          )}

          {items.length === 0 && (
            <p className="muted small">
              {panel === "canon" ? "Rien n'est encore validé : voir l'onglet « Décisions »." : "Rien à trier pour l'instant."}
            </p>
          )}
          <ul className="items">
            {visible.slice(0, shown).map((i) => (
              <li key={i.id} className={`item ${i.status}`}>
                <div className="item-head">
                  <span className={`badge type-${i.type}`}>{TYPE_LABEL[i.type] ?? i.type}</span>
                  <span className="muted small">
                    {i.id} · {STATUS_LABEL[i.status] ?? i.status}
                  </span>
                  {i.hint === "existing_decision" && <span className="badge warn">décision existante ?</span>}
                </div>
                <strong>{i.title}</strong>
                <p>{i.statement}</p>
                {i.source.quote && (
                  <blockquote>
                    « {i.source.quote} »<cite>{i.source.kind === "file" ? i.source.ref : "vous"}</cite>
                  </blockquote>
                )}
                {panel !== "canon" && i.status === "captured" && auto && (
                  <div className="row">
                    <button className="link small" onClick={() => triage(i.id, "discard")} title="Le directeur ne s'en servira pas">
                      Écarter cette idée
                    </button>
                  </div>
                )}
                {panel !== "canon" && i.status === "captured" && !auto && (
                  <div className="row">
                    <button className="small" onClick={() => triage(i.id, "keep")}>
                      Retenir
                    </button>
                    <button className="small secondary" onClick={() => triage(i.id, "discard")}>
                      Écarter
                    </button>
                  </div>
                )}
                {panel !== "canon" && i.status === "triaged" && (
                  <div className="row">
                    <button className="small secondary" onClick={() => triage(i.id, "discard")}>
                      Écarter
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {visible.length > shown && (
            <button className="secondary small" onClick={() => setShown((n) => n + PAGE)}>
              Afficher {Math.min(PAGE, visible.length - shown)} de plus ({visible.length - shown} restants)
            </button>
          )}
        </RailFold>
      </InboxRail>
    </main>
  );
}

const QUICK: [string, string][] = [
  ["go", "go"],
  ["fusionne", "fusionne"],
  ["plus simple ?", "Explique-le plus simplement ?"],
];
const dayOf = (iso: string) => new Date(iso).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
const hm = (iso: string) => new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
