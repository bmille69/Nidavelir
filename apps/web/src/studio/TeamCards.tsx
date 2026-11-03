import { useState } from "react";
import { api, type TeamAgent } from "../api.ts";
import { Markdown } from "./Conception.tsx";

/** Lignes ajoutées par le hub à la fin d'un message d'agent (ADR-98, ADR-99). */
const CONSULT_MARK = "§CONSULTATION§ ";
const MEMORY_MARK = "§SOUVENIR§ ";

export const TEAM_LABELS: Record<TeamAgent, string> = {
  directeur: "le Directeur",
  concepteur: "le Concepteur",
  da: "le Directeur artistique",
  son: "le directeur sonore",
  testeur: "le Testeur",
};

export type TeamConsult = { from: TeamAgent; to: TeamAgent; question: string; answer: string; ok: boolean };
export type TeamMemory = { id: string; text: string };

/** Sépare le texte d'un message de ses encarts d'équipe (consultations, souvenirs proposés). */
export function splitTeam(text: string): { text: string; consults: TeamConsult[]; memories: TeamMemory[] } {
  if (!text.includes(CONSULT_MARK) && !text.includes(MEMORY_MARK)) return { text, consults: [], memories: [] };
  const consults: TeamConsult[] = [];
  const memories: TeamMemory[] = [];
  const kept: string[] = [];
  for (const line of text.split("\n")) {
    try {
      if (line.startsWith(CONSULT_MARK)) {
        consults.push(JSON.parse(line.slice(CONSULT_MARK.length)) as TeamConsult);
        continue;
      }
      if (line.startsWith(MEMORY_MARK)) {
        memories.push(JSON.parse(line.slice(MEMORY_MARK.length)) as TeamMemory);
        continue;
      }
    } catch {
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join("\n").trimEnd(), consults, memories };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Les encarts d'un message : qui a consulté qui (replié), et les souvenirs proposés, à garder d'un clic. */
export function TeamCards({ consults, memories }: { consults: TeamConsult[]; memories: TeamMemory[] }) {
  if (!consults.length && !memories.length) return null;
  return (
    <div className="team-cards">
      {consults.map((c, k) => (
        <details className={`team-consult ${c.ok ? "" : "failed"}`} key={`c${k}`}>
          <summary>
            <span className={`team-pair agent-${c.from}`} aria-hidden="true">
              <i className={`team-dot agent-${c.from}`} />
              <i className="team-link" />
              <i className={`team-dot agent-${c.to}`} />
            </span>
            <span className="team-who">
              {cap(TEAM_LABELS[c.from] ?? c.from)} a consulté <b>{TEAM_LABELS[c.to] ?? c.to}</b>
            </span>
            <span className="team-question">{c.question}</span>
          </summary>
          <div className="team-answer">
            <p className="team-q">
              <span className="muted small">Question</span>
              {c.question}
            </p>
            <div className="team-a">
              <span className="muted small">{c.ok ? `${cap(TEAM_LABELS[c.to] ?? c.to)} répond` : "Pas de réponse"}</span>
              <div className="text small md">
                <Markdown text={c.answer} />
              </div>
            </div>
          </div>
        </details>
      ))}
      {memories.map((m) => (
        <MemoryCard key={m.id} memory={m} />
      ))}
    </div>
  );
}

function MemoryCard({ memory }: { memory: TeamMemory }) {
  const [state, setState] = useState<"idle" | "busy" | "kept" | "refused">("idle");
  const [error, setError] = useState<string | null>(null);
  async function decide(keep: boolean) {
    setState("busy");
    setError(null);
    try {
      await api.decideMemory(memory.id, keep);
      setState(keep ? "kept" : "refused");
    } catch (e) {
      setState("idle");
      // Déjà traité depuis la page « Mémoire du studio » : on le dit simplement.
      setError((e as Error).message.includes("n'attend pas") ? "Déjà traité dans « Mémoire du studio »." : (e as Error).message);
    }
  }
  return (
    <div className={`team-memory ${state}`}>
      <span className="team-memory-label">Pour la mémoire du studio</span>
      <p>« {memory.text} »</p>
      {state === "kept" ? (
        <span className="team-memory-done">✓ Gardé : toute l'équipe le saura, sur tous vos jeux</span>
      ) : state === "refused" ? (
        <span className="team-memory-done muted">Refusé : il ne sera plus proposé</span>
      ) : (
        <div className="row">
          <button className="small" disabled={state === "busy"} onClick={() => void decide(true)}>
            Garder
          </button>
          <button className="small secondary" disabled={state === "busy"} onClick={() => void decide(false)}>
            Non
          </button>
          <a className="small muted" href="#/memoire">
            Voir la mémoire
          </a>
        </div>
      )}
      {error && <p className="muted small">{error}</p>}
    </div>
  );
}
