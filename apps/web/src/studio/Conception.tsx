import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Linkify } from "./Linkify.tsx";
import { navigate } from "../App.tsx";
import { api, type Conception, type ConceptionMessage, type ConceptQuestion } from "../api.ts";
import { AgentAvatar } from "./AgentAvatar.tsx";
import { useStudio, useStudioRefresh } from "./context.tsx";
import { money } from "./Workshop.tsx";

const EXAMPLES = [
  "Un roguelike court avec des chats, un peu comme Hades, jouable dans le navigateur",
  "Un jeu de gestion de ferme cosy, parties de 20 minutes",
  "Un shooter en vue de dessus avec des vagues d'ennemis et des améliorations",
];

/** Point de départ : « Nouveau projet » ou « Concevoir une fonctionnalité ». */
export function ConceptionStart({ project }: { project?: string }) {
  const snap = useStudio();
  const [idea, setIdea] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = project ? (snap?.projects.find((p) => p.slug === project)?.name ?? project) : null;

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const c = await api.startConception({ kind: project ? "feature" : "project", project, idea });
      navigate({ page: "conception", id: c.id });
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <main className="studio-page conception-start">
      <header className="concept-hero">
        <AgentAvatar agent="concepteur" state="idle" size={88} />
        <div>
          <p className="eyebrow">Le Concepteur</p>
          <h1>{project ? `Concevoir une fonctionnalité` : "Nouveau projet"}</h1>
          <p className="hero-sub">
            {project
              ? `Pour ${name} : décrivez la fonctionnalité comme elle vous vient. Le Concepteur connaît votre code ; il pose les bonnes questions, cherche ce qui existe et prépare les chantiers.`
              : "Décrivez votre idée comme elle vous vient, même en vrac. Le Concepteur pose les bonnes questions, étudie la faisabilité, cherche ce qui existe, et prépare un dossier et les premiers chantiers."}
          </p>
        </div>
      </header>
      <section className="panel-card">
        <textarea
          className="idea"
          rows={7}
          autoFocus
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          placeholder={project ? "Ex. : un système de craft avec les matériaux des ennemis…" : "Ex. : un roguelike avec des chats, un peu comme Hades…"}
        />
        {!project && (
          <div className="chips">
            {EXAMPLES.map((x) => (
              <button key={x} className="chip" onClick={() => setIdea(x)}>
                {x}
              </button>
            ))}
          </div>
        )}
        <div className="row start-row">
          <button disabled={!idea.trim() || busy} onClick={start}>
            {busy ? "Démarrage…" : "✦ Commencer la conception"}
          </button>
          <span className="muted small">Rien n'est créé avant votre feu vert. Chaque tour prend 1 à 3 minutes (le Concepteur peut chercher sur Internet).</span>
        </div>
        {error && <p className="error">{error}</p>}
      </section>
    </main>
  );
}

/** La conception en cours : échanges et questions à gauche, dossier à droite. */
export function ConceptionView({ id }: { id: string }) {
  const [c, setC] = useState<Conception | null>(null);
  const [messages, setMessages] = useState<ConceptionMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"dossier" | "chantiers" | "sources">("dossier");
  const [busy, setBusy] = useState(false);
  const refreshStudio = useStudioRefresh();

  const load = useCallback(async () => {
    const r = await api.conception(id);
    setC(r.conception);
    setMessages(r.messages);
  }, [id]);
  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
  }, [load]);
  useEffect(() => {
    if (c?.status !== "thinking") return;
    const t = setInterval(() => load().catch(() => {}), 2500);
    return () => clearInterval(t);
  }, [c?.status, load]);

  async function send(text: string) {
    setError(null);
    try {
      setC(await api.replyConception(id, text));
      await load();
      refreshStudio();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function finish() {
    if (!c) return;
    setBusy(true);
    setError(null);
    try {
      if (c.kind === "project") {
        const { project } = await api.createFromConception(id);
        refreshStudio();
        navigate({ page: "project", slug: project.slug });
      } else {
        await api.addConceptionToProject(id);
        refreshStudio();
        navigate({ page: "project", slug: c.project! });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!c) return <main className="studio-page muted">{error ?? "Chargement…"}</main>;
  const last = [...messages].reverse().find((m) => m.role === "concepteur" && m.turn);
  const thinking = c.status === "thinking";
  const cost = messages.reduce((n, m) => n + (m.cost_usd ?? 0), 0);

  return (
    <main className="conception">
      <section className="concept-chat">
        <header className="concept-head">
          <AgentAvatar agent="concepteur" state={thinking ? "working" : c.data.questions.length && c.status === "open" ? "waiting" : "idle"} size={52} />
          <div className="grow">
            <p className="eyebrow">{c.kind === "project" ? "Nouveau projet" : "Fonctionnalité"} · Le Concepteur</p>
            <h1>{c.title}</h1>
          </div>
          {cost > 0 && <span className="muted small" title="Équivalent API, pris sur votre abonnement">≈ {money(cost)}</span>}
        </header>
        <div className="concept-messages">
          {messages.map((m) => (
            <div key={m.id} className={`msg ${m.role === "human" ? "human" : "director"}`}>
              <div className="who">{m.role === "human" ? "Vous" : "Concepteur"}</div>
              <div className="text">
                <Linkify text={m.text} />
              </div>
            </div>
          ))}
          {thinking && (
            <div className="msg director thinking">
              <div className="who">Concepteur</div>
              <div className="text muted">Je réfléchis et je fais quelques recherches… (1 à 3 minutes)</div>
            </div>
          )}
        </div>
        {!thinking && c.status === "open" && <Answers key={last?.id ?? "none"} questions={c.data.questions} onSend={send} />}
        {c.status === "done" && (
          <p className="notice">
            ✓ Conception terminée.{" "}
            {c.project && (
              <a href={`#/p/${c.project}`}>Ouvrir le projet →</a>
            )}
          </p>
        )}
        {error && <p className="error">{error}</p>}
      </section>

      <aside className="concept-doc">
        <div className="concept-doc-head">
          <div className="tabs">
            <button className={tab === "dossier" ? "tab active" : "tab"} onClick={() => setTab("dossier")}>
              Dossier
            </button>
            <button className={tab === "chantiers" ? "tab active" : "tab"} onClick={() => setTab("chantiers")}>
              Chantiers ({c.data.chantiers.length})
            </button>
            <button className={tab === "sources" ? "tab active" : "tab"} onClick={() => setTab("sources")}>
              Sources ({c.data.sources.length})
            </button>
          </div>
          <span className={`ready ${c.data.ready ? "on" : ""}`}>{c.data.ready ? "✓ Prêt à démarrer" : "En cours de cadrage"}</span>
        </div>
        <div className="concept-doc-body">
          {tab === "dossier" && (c.data.dossier ? <Markdown text={c.data.dossier} /> : <p className="muted">Le dossier apparaîtra ici après la première réponse.</p>)}
          {tab === "chantiers" && (
            <ol className="concept-chantiers">
              {c.data.chantiers.map((ch) => (
                <li key={ch.title}>
                  <strong>{ch.title}</strong>
                  <details>
                    <summary className="small">Consigne pour le développeur</summary>
                    <div className="text small">{ch.goal}</div>
                  </details>
                </li>
              ))}
              {!c.data.chantiers.length && <p className="muted">Pas encore de chantiers.</p>}
            </ol>
          )}
          {tab === "sources" && (
            <ul className="concept-sources">
              {c.data.sources.map((s) => (
                <li key={s.url}>
                  <a href={s.url} target="_blank" rel="noreferrer">
                    {s.title || s.url}
                  </a>
                </li>
              ))}
              {!c.data.sources.length && <p className="muted">Aucune recherche pour l'instant.</p>}
            </ul>
          )}
        </div>
        {c.status === "open" && (
          <div className="concept-finish">
            <button disabled={!c.data.ready || busy || thinking} onClick={finish}>
              {busy ? "Création…" : c.kind === "project" ? "✦ Créer le projet" : "✦ Ajouter les chantiers au projet"}
            </button>
            <span className="muted small">
              {c.data.ready
                ? c.kind === "project"
                  ? "Crée le dossier du jeu, Git, le CLAUDE.md, le dossier de conception et les premiers chantiers (non lancés)."
                  : "Range le dossier dans le projet et prépare les chantiers (non lancés)."
                : "Disponible quand l'essentiel est tranché."}
            </span>
          </div>
        )}
      </aside>
    </main>
  );
}

/** Les questions du tour, en boutons ; « Choisis pour moi » prend la recommandation. */
function Answers({ questions, onSend }: { questions: ConceptQuestion[]; onSend: (text: string) => Promise<void> }) {
  const [picked, setPicked] = useState<Record<number, string>>({});
  const [free, setFree] = useState("");
  const [sending, setSending] = useState(false);
  const all = () => setPicked(Object.fromEntries(questions.map((q, k) => [k, q.recommended || q.options[0]!.label])));
  const text = [
    ...questions.map((q, k) => (picked[k] ? `- ${q.question} → ${picked[k]}` : "")).filter(Boolean),
    free.trim(),
  ]
    .filter(Boolean)
    .join("\n");

  return (
    <div className="answers">
      {questions.map((q, k) => (
        <div key={q.question} className="answer-card">
          <p className="answer-q">{q.question}</p>
          {q.why && <p className="muted small">{q.why}</p>}
          <div className="answer-options">
            {q.options.map((o) => (
              <button
                key={o.label}
                className={`answer-opt ${picked[k] === o.label ? "on" : ""} ${o.label === q.recommended ? "rec" : ""}`}
                title={o.detail}
                onClick={() => setPicked((p) => ({ ...p, [k]: o.label }))}
              >
                <span>
                  {o.label}
                  {o.label === q.recommended && <span className="star"> ★ conseillé</span>}
                </span>
                {o.detail && <small>{o.detail}</small>}
              </button>
            ))}
          </div>
        </div>
      ))}
      <textarea rows={2} placeholder={questions.length ? "Une précision, une autre idée ? (facultatif)" : "Une précision, une question, un changement ?"} value={free} onChange={(e) => setFree(e.target.value)} />
      <div className="row">
        {questions.length > 0 && (
          <button className="secondary" onClick={all}>
            Choisis pour moi (★)
          </button>
        )}
        <button
          disabled={!text || sending}
          onClick={async () => {
            setSending(true);
            await onSend(text);
            setSending(false);
          }}
        >
          {sending ? "Envoi…" : questions.length ? "Envoyer mes réponses" : "Envoyer"}
        </button>
      </div>
    </div>
  );
}

/** Petit rendu Markdown (titres, listes, gras, code) sans HTML brut. */
export function Markdown({ text }: { text: string }) {
  const out: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const items = list.items.map((x, k) => <li key={k}>{inline(x)}</li>);
    out.push(list.ordered ? <ol key={out.length}>{items}</ol> : <ul key={out.length}>{items}</ul>);
    list = null;
  };
  for (const raw of text.split("\n")) {
    const line = raw.trimEnd();
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (h) {
      flush();
      const level = h[1]!.length;
      out.push(level === 1 ? <h2 key={out.length}>{inline(h[2]!)}</h2> : level === 2 ? <h3 key={out.length}>{inline(h[2]!)}</h3> : <h4 key={out.length}>{inline(h[2]!)}</h4>);
    } else if (li || ol) {
      const ordered = !!ol;
      if (list && list.ordered !== ordered) flush();
      list ??= { ordered, items: [] };
      list.items.push((li ?? ol)![1]!);
    } else if (!line.trim()) {
      flush();
    } else {
      flush();
      out.push(<p key={out.length}>{inline(line)}</p>);
    }
  }
  flush();
  return <div className="md">{out}</div>;
}

function inline(s: string): ReactNode[] {
  return s.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, k) =>
    part.startsWith("**") && part.endsWith("**") ? <strong key={k}>{part.slice(2, -2)}</strong> : part.startsWith("`") && part.endsWith("`") ? <code key={k}>{part.slice(1, -1)}</code> : part,
  );
}
