import { useCallback, useEffect, useRef, useState } from "react";
import { navigate } from "../App.tsx";
import { api, type Item, type Job, type Message, type Project, type Thread } from "../api.ts";

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

export function ProjectView({ slug, threadId }: { slug: string; threadId?: string }) {
  const [project, setProject] = useState<Project | null>(null);
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
  const [onlyNew, setOnlyNew] = useState(true);
  const [shown, setShown] = useState(PAGE);

  useEffect(() => {
    api.projects().then((ps) => setProject(ps.find((p) => p.slug === slug) ?? null));
    api.threads(slug).then(setThreads);
  }, [slug]);

  const refresh = useCallback(async () => {
    const [msgs, its, js] = await Promise.all([
      threadId ? api.messages(slug, threadId) : Promise.resolve([] as Message[]),
      api.items(slug, panel === "canon" ? "canon" : "inbox", panel === "noted" ? threadId : undefined),
      api.jobs(slug),
    ]);
    setMessages(msgs);
    setItems(its.items);
    setJobs(js);
  }, [slug, threadId, panel]);

  useEffect(() => {
    refresh().catch((e: Error) => setError(e.message));
  }, [refresh]);

  // Rafraîchit tant qu'une extraction ou un amorçage est en cours.
  const busy = messages.some((m) => m.extraction === "pending") || jobs.some((j) => j.status === "running");
  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => refresh().catch(() => {}), 2500);
    return () => clearInterval(t);
  }, [busy, refresh]);

  useEffect(() => endRef.current?.scrollIntoView({ behavior: "smooth" }), [messages.length, sending]);

  async function newThread() {
    const t = await api.createThread(slug, "");
    setThreads((ts) => [t, ...ts]);
    setPanel("noted");
    navigate({ page: "project", slug, thread: t.id });
  }

  async function send() {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setError(null);
    let thread = threadId;
    try {
      if (!thread) {
        const t = await api.createThread(slug, text.slice(0, 60));
        setThreads((ts) => [t, ...ts]);
        thread = t.id;
        navigate({ page: "project", slug, thread });
      }
      setMessages((m) => [...m, { id: "pending", thread: thread!, seq: m.length + 1, role: "human", text, at: "", extraction: "pending", cost_usd: null }]);
      setDraft("");
      await api.send(slug, thread, text);
      setMessages(await api.messages(slug, thread));
      await refresh();
    } catch (e) {
      setError((e as Error).message);
      setDraft(text);
      if (thread) setMessages(await api.messages(slug, thread).catch(() => []));
    } finally {
      setSending(false);
    }
  }

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

  return (
    <main className="project">
      <aside className="threads">
        <a href="#/" className="muted small">
          ← Projets
        </a>
        <h2>{project?.name ?? slug}</h2>
        <button onClick={newThread}>Nouvelle discussion</button>
        <ul>
          {threads.map((t) => (
            <li key={t.id}>
              <a className={t.id === threadId ? "active" : ""} href={`#/p/${slug}/t/${t.id}`}>
                {t.title}
              </a>
            </li>
          ))}
        </ul>
        {visible.length > shown && (
          <button className="secondary small" onClick={() => setShown((n) => n + PAGE)}>
            Afficher {Math.min(PAGE, visible.length - shown)} de plus ({visible.length - shown} restants)
          </button>
        )}
      </aside>

      <section className="conversation">
        <div className="mode-bar">
          <span className="badge mode">Exploration</span>
          <span className="muted small">Pensez à voix haute : rien n'est validé sans vous.</span>
          <span className="badge muted" title="Disponible à l'étape 3">
            Décision — bientôt
          </span>
        </div>
        <div className="messages">
          {!threadId && messages.length === 0 && (
            <div className="empty">
              <p>
                Parlez de votre jeu librement : intentions, envies, doutes, références. Le directeur reformule, relève les tensions et pose
                quelques questions.
              </p>
              <p className="muted small">Ce qu'il retient apparaît à droite, à trier quand vous voulez.</p>
            </div>
          )}
          {messages.map((m) => (
            <div key={m.id} className={`msg ${m.role}`}>
              <div className="who">{m.role === "human" ? "Vous" : "Directeur (IA)"}</div>
              <div className="text">{m.text}</div>
              {m.role === "human" && m.extraction === "pending" && <div className="muted small">analyse en cours…</div>}
              {m.role === "human" && m.extraction === "failed" && <div className="error small">l'analyse de ce message a échoué</div>}
            </div>
          ))}
          {sending && <div className="msg director muted">Le directeur réfléchit…</div>}
          <div ref={endRef} />
        </div>
        {error && <p className="error">{error}</p>}
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
            placeholder="Écrivez librement… (Entrée pour envoyer, Maj+Entrée pour aller à la ligne)"
            rows={3}
            disabled={sending}
          />
          <button onClick={send} disabled={!draft.trim() || sending}>
            Envoyer
          </button>
        </div>
      </section>

      <aside className="panel">
        <div className="tabs">
          {threadId && (
            <button className={panel === "noted" ? "tab active" : "tab"} onClick={() => setPanel("noted")}>
              Ce que j'ai noté
            </button>
          )}
          <button className={panel === "inbox" ? "tab active" : "tab"} onClick={() => setPanel("inbox")}>
            À trier
          </button>
          <button className={panel === "canon" ? "tab active" : "tab"} onClick={() => setPanel("canon")}>
            Validé
          </button>
        </div>

        {runningJob && (
          <div className="notice small">
            Lecture des documents :{" "}
            {runningJob.documents.filter((d) => d.status === "done" || d.status === "failed" || d.status === "skipped").length}/
            {runningJob.documents.length} · {runningJob.created} élément(s) noté(s)
          </div>
        )}
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
            <label className="check small">
              <input type="checkbox" checked={onlyNew} onChange={(e) => setOnlyNew(e.target.checked)} />
              Non triés seulement
            </label>
            <label className="check small">
              <input type="checkbox" checked={onlyHint} onChange={(e) => setOnlyHint(e.target.checked)} />
              « Décision existante ? » seulement
            </label>
            <div className="row">
              <span className="muted small grow">{visible.length} affiché(s) sur {items.length}</span>
              <button className="small" disabled={!visible.some((i) => i.status === "captured")} onClick={() => triageAll("keep")}>
                Retenir tout
              </button>
              <button className="small secondary" disabled={!batchable.length} onClick={() => triageAll("discard")}>
                Écarter tout
              </button>
            </div>
          </div>
        )}

        {items.length === 0 && (
          <p className="muted small">
            {panel === "canon" ? "Rien n'est encore validé. Le mode décision arrive à l'étape 3." : "Rien à trier pour l'instant."}
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
              {panel !== "canon" && i.status === "captured" && (
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
      </aside>
    </main>
  );
}
