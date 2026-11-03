import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { api, type Skill, type SkillAgent, type SkillStatus } from "../api.ts";
import { formatDate } from "../pages/labels.ts";
import { AgentAvatar } from "./AgentAvatar.tsx";
import { ago } from "./agents.ts";
import { useNow, useStudio } from "./context.tsx";
import { Markdown } from "./Conception.tsx";

const AGENT_LABEL: Record<SkillAgent, string> = { director: "Directeur", concepteur: "Concepteur", developer: "Développeur", qa: "Testeur", art_director: "DA" };
const ALL: SkillAgent[] = ["director", "concepteur", "developer", "qa", "art_director"];
const SOURCE_LABEL: Record<Skill["source"], string> = { learned: "Apprise", hermes: "Hermes", public: "Catalogue", user: "Vous", starter: "Hub", lessons: "Leçons" };

type Filter = "all" | "learned" | "hermes" | "public" | "user" | "starter" | "trial" | "rejected" | "off";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "Toutes" },
  { id: "learned", label: "Apprises" },
  { id: "hermes", label: "Hermes" },
  { id: "public", label: "Catalogue" },
  { id: "user", label: "Les vôtres" },
  { id: "starter", label: "Du hub" },
  { id: "trial", label: "En essai" },
  { id: "rejected", label: "Écartées" },
  { id: "off", label: "Éteintes" },
];
const NEED_STATUS: Record<string, string> = { open: "à chercher", searched: "rien de convenable", done: "trouvée" };

const stagger = (i: number) => ({ "--i": i }) as CSSProperties;

/**
 * Compétences des agents (ADR-29, ADR-97) : une bibliothèque qui se tient seule. Procédures apprises
 * des chantiers difficiles, skills reprises d'Hermes, mise en sommeil de ce qui ne sert jamais ;
 * les leçons de chaque projet, et tout reste modifiable à la main.
 */
export function SkillsView() {
  const snap = useStudio();
  const now = useNow(30_000);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [status, setStatus] = useState<SkillStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const slugs = (snap?.projects ?? []).map((p) => p.slug).join(",");

  const load = useCallback(async () => {
    // Une requête par projet crée ses leçons si besoin ; on fusionne le tout.
    const [st, ...lists] = await Promise.all([api.skillStatus(), api.skills(), ...slugs.split(",").filter(Boolean).map((s) => api.skills(s))]);
    const byId = new Map(lists.flat().map((s) => [s.id, s]));
    setSkills([...byId.values()]);
    setStatus(st);
  }, [slugs]);
  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
  }, [load]);
  // Pendant une lecture d'Hermes, la page suit l'avancement.
  useEffect(() => {
    if (!status?.hermes.syncing) return;
    const t = setInterval(() => void load().catch(() => {}), 3000);
    return () => clearInterval(t);
  }, [status?.hermes.syncing, load]);

  const names = new Map((snap?.projects ?? []).map((p) => [p.slug, p.name]));
  const lessons = skills.filter((s) => s.source === "lessons");
  const library = useMemo(() => skills.filter((s) => s.source !== "lessons").sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name)), [skills]);
  const matches = (s: Skill, f: Filter) =>
    f === "all" ? s.status !== "rejected" : f === "trial" ? s.status === "quarantine" : f === "rejected" ? s.status === "rejected" : f === "off" ? !s.enabled && s.status === "active" : s.source === f && s.status !== "rejected";
  const shown = library.filter((s) => matches(s, filter));
  const learned = library.filter((s) => s.source === "learned");
  const hermes = library.filter((s) => s.source === "hermes");
  const used = library.reduce((n, s) => n + s.stats.used, 0);
  const offered = library.reduce((n, s) => n + s.stats.offered, 0);
  const lessonsFilled = lessons.filter((s) => /- \S/.test(s.body)).length;

  async function syncNow() {
    setError(null);
    try {
      setStatus(await api.syncHermes());
    } catch (e) {
      setError((e as Error).message);
    }
  }

  return (
    <main className="studio-page skills-page">
      <header className="studio-hero">
        <div>
          <h1>Compétences</h1>
          <p className="hero-sub">
            Une bibliothèque qui se nourrit et se vérifie seule. L'équipe tire des procédures de ses chantiers, repère ce qui lui manque, le cherche dans des dépôts publics reconnus ou l'écrit, puis l'essaie avant de s'en servir. Ce qui n'aide pas est écarté. Vous n'avez rien à faire, et tout reste modifiable.
          </p>
        </div>
      </header>
      {error && <p className="error">{error}</p>}

      <section className="kpis skills-kpis">
        <div className="stat kpi" title="Procédures écrites par le curateur après un chantier fusionné difficile (corrections, refus du testeur, écarts au plan). Actives tout de suite.">
          <span>Apprises des chantiers</span>
          <b>{learned.length}</b>
          <span className="kpi-hint">{learned.filter((s) => s.enabled).length} active(s)</span>
        </div>
        <div className="stat kpi" title="Skills de votre bibliothèque Hermes jugées utiles aux jeux, adaptées aux agents du studio. Relue toutes les 6 h ; seules les nouveautés coûtent un appel.">
          <span>Reprises d'Hermes</span>
          <b>{hermes.length}</b>
          <span className="kpi-hint">
            {!status?.hermes.dir ? "Hermes introuvable sur ce PC" : status.hermes.syncing ? "lecture en cours…" : status.hermes.last_sync ? `relue ${ago(status.hermes.last_sync, now)}` : "relue toutes les 6 h"}
          </span>
        </div>
        <div className="stat kpi" title="Chaque fois qu'un agent ouvre une compétence (outil Skill, ou lecture de son fichier).">
          <span>Ouvertures par les agents</span>
          <b>{used}</b>
          <span className="kpi-hint">sur {offered} proposition(s)</span>
        </div>
        <div className="stat kpi" title="Compétences venues de l'extérieur ou écrites pour un besoin : aucun agent ne les reçoit avant leur essai automatique (sur le banc, ou en aveugle). Essais de banc seulement quand l'abonnement est peu utilisé.">
          <span>En essai</span>
          <b>{status?.lab.quarantine ?? 0}</b>
          <span className="kpi-hint">
            {status ? `banc ${status.lab.trials.bench}/${status.lab.trials.benchMax} · aveugle ${status.lab.trials.blind}/${status.lab.trials.blindMax} cette semaine` : "…"}
          </span>
        </div>
        <div className="stat kpi" title="Leçons propres à chaque projet, apprises de vos 👎, de vos mots et de vos corrections.">
          <span>Projets avec des leçons</span>
          <b>{lessonsFilled}</b>
          <span className="kpi-hint">sur {lessons.length} projet(s)</span>
        </div>
      </section>

      <section className="panel-card skills-auto">
        <div className="section-head">
          <div>
            <h2>Ce que le hub a fait tout seul</h2>
            <p className="muted small">
              {status?.learn ? "Apprentissage après chaque chantier difficile : actif." : "Apprentissage après les chantiers : éteint."}{" "}
              {status?.hermes.dir ? `Bibliothèque d'Hermes : ${status.hermes.dir}${status.hermes.ignored ? ` · ${status.hermes.ignored} skill(s) écartée(s), hors sujet` : ""}.` : ""}{" "}
              {status?.lab.catalog.sources.length ? `Catalogue public : ${status.lab.catalog.entries} skill(s) dans ${status.lab.catalog.sources.join(", ")}.` : ""}
            </p>
          </div>
          {status?.hermes.dir && (
            <button className="secondary" onClick={syncNow} disabled={status.hermes.syncing}>
              {status.hermes.syncing ? "Lecture d'Hermes…" : "Relire Hermes maintenant"}
            </button>
          )}
        </div>
        {!status?.recent.length && <p className="muted small">Rien encore. Les premières compétences arriveront à la prochaine lecture d'Hermes et après le prochain chantier difficile.</p>}
        <ol className="feed-list">
          {(status?.recent ?? []).map((e, k) => {
            const d = describe(e, names);
            return (
              <li key={`${e.at}-${k}`} className={d.tone ? `tone-${d.tone}` : ""} style={stagger(k)}>
                <span className={`feed-dot agent-${d.agent}`} />
                <div>
                  <p>{d.text}</p>
                  <span className="muted small">
                    {ago(e.at, now)}
                    {d.detail ? ` · ${d.detail}` : ""}
                  </span>
                </div>
              </li>
            );
          })}
        </ol>
        {!!status?.lab.needs.length && (
          <div className="skill-needs">
            <h3>Besoins repérés</h3>
            <ul>
              {status.lab.needs.map((n) => (
                <li key={n.id} className={`need-${n.status}`}>
                  <span className="need-topic">{n.topic}</span>
                  <span className="muted small">
                    {n.project ? `${names.get(n.project) ?? n.project} · ` : ""}
                    {n.origin} · {n.result ?? NEED_STATUS[n.status] ?? n.status}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <section className="panel-card">
        <h2>Leçons des projets</h2>
        <p className="muted small">Lues en entier par le directeur, le Concepteur et le Développeur avant de travailler sur le projet. Vous pouvez les corriger à la main.</p>
        {lessons.length === 0 && <p className="muted small">Aucun projet pour l'instant.</p>}
        <div className="skill-list">
          {lessons.map((s) => (
            <SkillCard key={s.id} skill={s} title={`Leçons — ${names.get(s.project ?? "") ?? s.project}`} onSaved={load} now={now} empty="Pas encore de leçon : elles viendront de vos avis 👎, de vos mots et de vos corrections." />
          ))}
        </div>
      </section>

      <section className="panel-card">
        <div className="section-head">
          <div>
            <h2>Bibliothèque</h2>
            <p className="muted small">Les agents voient le nom et la phrase « quand l'utiliser », et n'ouvrent que celles qui concernent leur travail.</p>
          </div>
          <button className="secondary" onClick={() => setAdding((a) => !a)}>
            {adding ? "Annuler" : "＋ Ajouter une compétence"}
          </button>
        </div>
        <div className="chips skill-filters">
          {FILTERS.map((f) => (
            <button key={f.id} className={`chip ${filter === f.id ? "on" : ""}`} onClick={() => setFilter(f.id)}>
              {f.label} <span className="chip-count">{library.filter((s) => matches(s, f.id)).length}</span>
            </button>
          ))}
        </div>
        {adding && (
          <NewSkill
            onSaved={async () => {
              setAdding(false);
              await load();
            }}
          />
        )}
        {shown.length === 0 && <p className="muted small">Aucune compétence dans ce filtre.</p>}
        <div className="skill-list">
          {shown.map((s) => (
            <SkillCard key={s.id} skill={s} title={s.name} onSaved={load} now={now} />
          ))}
        </div>
      </section>
    </main>
  );
}

function describe(e: SkillStatus["recent"][number], names: Map<string, string>): { agent: string; text: string; detail?: string; tone?: "ok" | "warn" | "error" } {
  const p = e.payload;
  const change = typeof p.change === "string" && p.change ? p.change : undefined;
  switch (e.type) {
    case "skill.learned":
      return p.action === "update"
        ? { agent: "archivist", text: `Procédure « ${e.subject} » améliorée après ${String(p.task ?? "un chantier")}`, detail: change, tone: "ok" }
        : { agent: "archivist", text: `Nouvelle procédure « ${e.subject} » apprise de ${String(p.task ?? "un chantier")}${p.scope === "studio" ? " (pour tous les jeux)" : ""}`, detail: change, tone: "ok" };
    case "skill.hermes_imported":
      return { agent: "archivist", text: `« ${e.subject} » reprise d'Hermes`, detail: Array.isArray(p.agents) ? `pour ${(p.agents as SkillAgent[]).map((a) => AGENT_LABEL[a] ?? a).join(", ")}` : undefined, tone: "ok" };
    case "skill.hermes_updated":
      return { agent: "archivist", text: `« ${e.subject} » mise à jour depuis Hermes` };
    case "skill.hermes_failed":
      return { agent: "guardian", text: e.subject === "tri" ? "Lecture d'Hermes interrompue : elle reprendra seule" : `« ${e.subject} » pas encore reprise d'Hermes`, detail: typeof p.error === "string" ? p.error.slice(0, 120) : undefined, tone: "warn" };
    case "skill.dormant":
      return { agent: "archivist", text: `« ${e.subject} » mise en sommeil : proposée ${String(p.offered ?? "")} fois, jamais ouverte` };
    case "skill.reverted":
      return { agent: "you", text: `« ${e.subject} » remise à sa version précédente` };
    case "lessons.updated":
      return { agent: "archivist", text: `Leçons de ${names.get(e.project ?? "") ?? e.project} mises à jour`, detail: change };
    case "skill.trial_passed":
      return { agent: "qa", text: p.status === "quarantine" ? `Essai de « ${e.subject} » sans vainqueur : un autre essai suivra` : `« ${e.subject} » a réussi son essai : elle est active`, detail: typeof p.summary === "string" ? p.summary : undefined, tone: p.status === "quarantine" ? undefined : "ok" };
    case "skill.trial_failed":
      return { agent: "qa", text: `« ${e.subject} » écartée après son essai`, detail: typeof p.summary === "string" ? p.summary : undefined, tone: "warn" };
    case "skill.public_imported":
      return { agent: "archivist", text: `« ${e.subject} » trouvée dans le catalogue public (${String(p.source ?? "")}, ${String(p.license ?? "")}) : en essai`, tone: "ok" };
    case "skill.public_refused":
      return { agent: "guardian", text: `« ${e.subject} » refusée à la relecture de sécurité`, detail: Array.isArray(p.why) ? (p.why as string[]).join(", ").slice(0, 160) : undefined, tone: "warn" };
    case "skill.retired":
      return { agent: "archivist", text: `« ${e.subject} » retirée`, detail: typeof p.why === "string" ? p.why : undefined, tone: "warn" };
    case "skill.merged":
      return { agent: "archivist", text: `« ${e.subject} » fusionnée dans « ${String(p.into ?? "")} »` };
    case "skill.need":
      return { agent: "archivist", text: `Besoin repéré : ${e.subject}`, detail: typeof p.origin === "string" ? p.origin : undefined };
    default:
      return { agent: "archivist", text: e.type };
  }
}

function SkillCard({ skill, title, onSaved, now, empty }: { skill: Skill; title: string; onSaved: () => Promise<unknown>; now: number; empty?: string }) {
  const [s, setS] = useState(skill);
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const [files, setFiles] = useState<{ path: string; content: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setS(skill), [skill]);
  useEffect(() => setFiles(null), [skill.updated_at]);
  const hasContent = /- \S|\w{3,}/.test(skill.body.replace(/^## .*$/gm, ""));
  const removable = s.source === "user" || s.source === "learned" || s.source === "hermes" || s.source === "public";

  async function save(next: Skill) {
    setError(null);
    // Affiché tout de suite ; le serveur confirme (ou on revient en arrière en cas d'erreur).
    const before = s;
    setS(next);
    try {
      setS(await api.saveSkill(next));
      setEditing(false);
      await onSaved();
    } catch (e) {
      setS(before);
      setError((e as Error).message);
    }
  }

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await onSaved();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function toggleOpen() {
    const next = !open;
    setOpen(next);
    if (next && s.files.length && !files) {
      try {
        setFiles((await api.skillDetail(s.id)).file_contents);
      } catch (e) {
        setError((e as Error).message);
      }
    }
  }

  const origin = s.origin?.startsWith("hermes:")
    ? `reprise d'Hermes (${s.origin.slice(7)})`
    : s.origin?.startsWith("github:")
      ? `catalogue public (${s.origin.slice(7)})`
      : s.origin
        ? `apprise de ${s.origin.split("/").pop()}`
        : null;
  const meta = [
    s.source === "starter" ? "fournie par le hub" : s.source === "user" ? "ajoutée par vous" : origin,
    s.source !== "lessons" && s.stats.offered ? `ouverte ${s.stats.used} fois sur ${s.stats.offered} proposition(s)` : s.source !== "lessons" && s.stats.used ? `ouverte ${s.stats.used} fois` : null,
    s.stats.last_used_at ? `dernière fois ${ago(s.stats.last_used_at, now)}` : null,
    s.source === "lessons" || s.source === "learned" || s.source === "hermes" || s.source === "public" ? `mise à jour le ${formatDate(s.updated_at)}` : null,
  ].filter(Boolean);

  return (
    <article className={`skill ${s.enabled ? "on" : ""} src-${s.source}`}>
      <div className="skill-head">
        <label className="switch" title={s.enabled ? "Active" : "Désactivée"}>
          <input type="checkbox" checked={s.enabled} onChange={(e) => save({ ...s, enabled: e.target.checked })} aria-label={`Activer ${title}`} />
          <span />
        </label>
        <div className="grow">
          <h3>
            {title}
            {s.source !== "lessons" && <span className={`skill-src skill-src-${s.source}`}>{SOURCE_LABEL[s.source]}</span>}
            {s.project && s.source !== "lessons" && <span className="skill-src skill-src-project">{s.project}</span>}
            {s.status === "quarantine" && <span className="skill-src skill-src-trial">En essai</span>}
            {s.status === "rejected" && <span className="skill-src skill-src-rejected">Écartée</span>}
          </h3>
          <p className="muted small">{s.description}</p>
          {meta.length > 0 && <p className="skill-meta">{meta.join(" · ")}</p>}
          {s.trial && (
            <p className={`skill-trial verdict-${s.trial.verdict}`}>
              {s.trial.kind === "bench" ? "Essai sur le banc" : s.trial.kind === "blind" ? "Essai en aveugle" : "Mesure"} · {s.trial.verdict === "pass" ? "réussi" : s.trial.verdict === "fail" ? "raté" : "sans vainqueur"} — {s.trial.summary}
            </p>
          )}
          {!s.trial && s.status === "quarantine" && <p className="skill-trial">Aucun agent ne la reçoit avant son essai automatique.</p>}
        </div>
      </div>
      <div className="skill-agents">
        {ALL.map((a) => (
          <button
            key={a}
            className={`agent-chip agent-${a === "qa" ? "qa" : a} ${s.agents.includes(a) ? "on" : ""}`}
            disabled={s.source === "public" && a !== "developer" && a !== "qa"}
            title={
              s.source === "public" && a !== "developer" && a !== "qa"
                ? "Compétence externe : réservée au Développeur et au Testeur (ils travaillent sans réseau, sous le gardien)"
                : s.agents.includes(a)
                  ? `Retirer au ${AGENT_LABEL[a]}`
                  : `Donner au ${AGENT_LABEL[a]}`
            }
            onClick={() => save({ ...s, agents: s.agents.includes(a) ? s.agents.filter((x) => x !== a) : [...s.agents, a] })}
          >
            <AgentAvatar agent={a} state="idle" size={20} /> {AGENT_LABEL[a]}
          </button>
        ))}
      </div>
      {editing ? (
        <div className="skill-edit">
          <textarea rows={12} value={s.body} onChange={(e) => setS({ ...s, body: e.target.value })} />
          <div className="row">
            <button onClick={() => save(s)}>Enregistrer</button>
            <button
              className="secondary"
              onClick={() => {
                setS(skill);
                setEditing(false);
              }}
            >
              Annuler
            </button>
            {removable && (
              <button
                className="secondary danger"
                onClick={() => {
                  if (!window.confirm(`Supprimer la compétence « ${s.name} » ?${s.source === "hermes" ? " Elle ne sera plus reprise d'Hermes." : ""}`)) return;
                  void act(() => api.deleteSkill(s.id));
                }}
              >
                Supprimer
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="row">
          {hasContent ? (
            <button className="link small" onClick={toggleOpen}>
              {open ? "▾ Masquer le contenu" : `▸ Voir le contenu${s.files.length ? ` et ${s.files.length} annexe(s)` : ""}`}
            </button>
          ) : (
            <span className="muted small">{empty ?? "Vide."}</span>
          )}
          <button className="link small" onClick={() => setEditing(true)}>
            Modifier
          </button>
          {s.has_previous && (
            <button className="link small" title="Revenir au texte d'avant la dernière modification (on peut refaire)" onClick={() => void act(() => api.revertSkill(s.id))}>
              ↶ Version précédente
            </button>
          )}
        </div>
      )}
      {open && !editing && (
        <div className="skill-body">
          <Markdown text={s.body} />
          {s.files.length > 0 && (
            <div className="skill-files">
              {s.files.map((f) => (
                <details key={f.path}>
                  <summary>
                    {f.path} <span className="muted small">{Math.max(1, Math.round(f.size / 1024))} Ko</span>
                  </summary>
                  <pre>{files?.find((x) => x.path === f.path)?.content ?? "Chargement…"}</pre>
                </details>
              ))}
            </div>
          )}
        </div>
      )}
      {error && <p className="error small">{error}</p>}
    </article>
  );
}

function NewSkill({ onSaved }: { onSaved: () => Promise<unknown> }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [agents, setAgents] = useState<SkillAgent[]>(["developer"]);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="create-box">
      <p className="notice small">
        ⚠ Une compétence trouvée sur Internet est un texte écrit par quelqu'un d'autre, que vos agents suivront. Relisez-la (ou demandez-moi de la relire) avant de l'activer. Le hub ne télécharge jamais rien seul.
      </p>
      <label>
        Nom (minuscules et tirets)
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="godot-gdscript" />
      </label>
      <label>
        Quand l'utiliser ? (l'agent lit cette phrase pour décider)
        <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Bonnes pratiques GDScript pour Godot 4. À utiliser pour tout code GDScript." />
      </label>
      <label>
        Contenu (Markdown, ou collez le contenu d'un SKILL.md)
        <textarea rows={10} value={body} onChange={(e) => setBody(e.target.value)} />
      </label>
      <div className="skill-agents">
        {ALL.map((a) => (
          <button key={a} className={`agent-chip ${agents.includes(a) ? "on" : ""}`} onClick={() => setAgents((x) => (x.includes(a) ? x.filter((y) => y !== a) : [...x, a]))}>
            {AGENT_LABEL[a]}
          </button>
        ))}
      </div>
      <div className="row">
        <button
          disabled={!name.trim() || !description.trim() || !body.trim()}
          onClick={async () => {
            setError(null);
            try {
              // Un SKILL.md collé tel quel : on retire son en-tête (nom et description sont saisis ci-dessus).
              await api.saveSkill({ name, description, body: body.replace(/^---[\s\S]*?---\s*/, ""), agents, enabled: false });
              await onSaved();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Ajouter (désactivée)
        </button>
        {error && <span className="error small">{error}</span>}
      </div>
    </div>
  );
}
