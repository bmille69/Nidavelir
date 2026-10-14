import { useCallback, useEffect, useState } from "react";
import { api, type Skill, type SkillAgent } from "../api.ts";
import { formatDate } from "../pages/labels.ts";
import { AgentAvatar } from "./AgentAvatar.tsx";
import { useStudio } from "./context.tsx";
import { Markdown } from "./Conception.tsx";

const AGENT_LABEL: Record<SkillAgent, string> = { director: "Directeur", concepteur: "Concepteur", developer: "Développeur", qa: "Testeur" };
const ALL: SkillAgent[] = ["director", "concepteur", "developer", "qa"];

/**
 * Compétences des agents (ADR-29) : les leçons de chaque projet (apprises de vos avis et
 * corrections) et la bibliothèque, à activer agent par agent.
 */
export function SkillsView() {
  const snap = useStudio();
  const [skills, setSkills] = useState<Skill[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const slugs = (snap?.projects ?? []).map((p) => p.slug).join(",");

  const load = useCallback(async () => {
    // Une requête par projet crée ses leçons si besoin ; on fusionne le tout.
    const lists = await Promise.all([api.skills(), ...slugs.split(",").filter(Boolean).map((s) => api.skills(s))]);
    const byId = new Map(lists.flat().map((s) => [s.id, s]));
    setSkills([...byId.values()]);
  }, [slugs]);
  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
  }, [load]);

  const names = new Map((snap?.projects ?? []).map((p) => [p.slug, p.name]));
  const lessons = skills.filter((s) => s.source === "lessons");
  const library = skills.filter((s) => s.source !== "lessons").sort((a, b) => a.name.localeCompare(b.name));

  return (
    <main className="studio-page skills-page">
      <header className="studio-hero">
        <div>
          <h1>Compétences</h1>
          <p className="hero-sub">
            Des savoir-faire donnés aux agents. Les leçons de chaque projet s'apprennent toutes seules à partir de vos 👎, de vos mots et de vos corrections. Activez les autres une à une, et vérifiez dans « Qualité » qu'elles aident.
          </p>
        </div>
      </header>
      {error && <p className="error">{error}</p>}

      <section className="panel-card">
        <h2>Leçons des projets</h2>
        <p className="muted small">Lues par le directeur, le Concepteur et le Développeur avant de travailler sur le projet. Vous pouvez les corriger à la main.</p>
        {lessons.length === 0 && <p className="muted small">Aucun projet pour l'instant.</p>}
        <div className="skill-list">
          {lessons.map((s) => (
            <SkillCard key={s.id} skill={s} title={`Leçons — ${names.get(s.project ?? "") ?? s.project}`} onSaved={load} empty="Pas encore de leçon : elles viendront de vos avis 👎, de vos mots et de vos corrections." />
          ))}
        </div>
      </section>

      <section className="panel-card">
        <div className="section-head">
          <div>
            <h2>Bibliothèque</h2>
            <p className="muted small">Activez une compétence et choisissez les agents qui la reçoivent.</p>
          </div>
          <button className="secondary" onClick={() => setAdding((a) => !a)}>
            {adding ? "Annuler" : "＋ Ajouter une compétence"}
          </button>
        </div>
        {adding && (
          <NewSkill
            onSaved={async () => {
              setAdding(false);
              await load();
            }}
          />
        )}
        <div className="skill-list">
          {library.map((s) => (
            <SkillCard key={s.id} skill={s} title={s.name} onSaved={load} />
          ))}
        </div>
      </section>
    </main>
  );
}

function SkillCard({ skill, title, onSaved, empty }: { skill: Skill; title: string; onSaved: () => Promise<unknown>; empty?: string }) {
  const [s, setS] = useState(skill);
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setS(skill), [skill]);
  const hasContent = /- \S|\w{3,}/.test(skill.body.replace(/^## .*$/gm, ""));

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

  return (
    <article className={`skill ${s.enabled ? "on" : ""}`}>
      <div className="skill-head">
        <label className="switch" title={s.enabled ? "Active" : "Désactivée"}>
          <input type="checkbox" checked={s.enabled} onChange={(e) => save({ ...s, enabled: e.target.checked })} aria-label={`Activer ${title}`} />
          <span />
        </label>
        <div className="grow">
          <h3>{title}</h3>
          <p className="muted small">{s.description}</p>
        </div>
        <span className="muted small">{s.source === "starter" ? "fournie par le hub" : s.source === "user" ? "ajoutée par vous" : `mise à jour le ${formatDate(s.updated_at)}`}</span>
      </div>
      <div className="skill-agents">
        {ALL.map((a) => (
          <button
            key={a}
            className={`agent-chip agent-${a === "qa" ? "qa" : a} ${s.agents.includes(a) ? "on" : ""}`}
            title={s.agents.includes(a) ? `Retirer au ${AGENT_LABEL[a]}` : `Donner au ${AGENT_LABEL[a]}`}
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
            {s.source === "user" && (
              <button
                className="secondary danger"
                onClick={async () => {
                  if (!window.confirm(`Supprimer la compétence « ${s.name} » ?`)) return;
                  await api.deleteSkill(s.id);
                  await onSaved();
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
            <button className="link small" onClick={() => setOpen((o) => !o)}>
              {open ? "▾ Masquer le contenu" : "▸ Voir le contenu"}
            </button>
          ) : (
            <span className="muted small">{empty ?? "Vide."}</span>
          )}
          <button className="link small" onClick={() => setEditing(true)}>
            Modifier
          </button>
        </div>
      )}
      {open && !editing && (
        <div className="skill-body">
          <Markdown text={s.body} />
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
