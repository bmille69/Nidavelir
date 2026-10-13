import type { ExtractedItem } from "@studio/contracts";
import type { OrchestratorPort } from "../src/orchestrator/port.ts";

type Call = { kind: "reply" | "structured"; systemPrompt: string; prompt: string };

/** Orchestrateur scripté et enregistreur, pour des tests déterministes et gratuits (ADR-08). */
export class FakeOrchestrator implements OrchestratorPort {
  readonly name = "fake";
  readonly calls: Call[] = [];
  replies: string[] = [];
  /** File de réponses d'extraction ; une fonction reçoit le prompt. */
  extractions: (ExtractedItem[] | ((prompt: string) => ExtractedItem[]) | Error)[] = [];

  async reply(input: { systemPrompt: string; prompt: string }) {
    this.calls.push({ kind: "reply", ...input });
    return { text: this.replies.shift() ?? "Je note. Qu'est-ce qui compte le plus pour toi ici ?", costUsd: 0.001 };
  }

  async structured(input: { systemPrompt: string; prompt: string; jsonSchema: object }) {
    this.calls.push({ kind: "structured", systemPrompt: input.systemPrompt, prompt: input.prompt });
    const next = this.extractions.shift() ?? [];
    if (next instanceof Error) throw next;
    const items = typeof next === "function" ? next(input.prompt) : next;
    return { data: { items }, costUsd: 0.002 };
  }
}

export function extracted(partial: Partial<ExtractedItem> & Pick<ExtractedItem, "title" | "quote">): ExtractedItem {
  return {
    type: "idea",
    statement: partial.title,
    confidence: 0.8,
    domain: ["gameplay"],
    duplicate_of: null,
    refines: null,
    looks_like_decision: false,
    ...partial,
  };
}
