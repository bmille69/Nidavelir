import type { ClaudeCli } from "../llm/claude-cli.ts";
import { OrchestratorError, type CallMeta, type OrchestratorPort } from "./port.ts";

/** Directeur porté par Claude Code CLI, sans outils (ADR-10). */
export class DirectClaudeOrchestrator implements OrchestratorPort {
  readonly name = "direct-claude";
  readonly #cli: ClaudeCli;
  readonly #models: { chat: string; structured: string };

  constructor(cli: ClaudeCli, models: { chat: string; structured: string }) {
    this.#cli = cli;
    this.#models = models;
  }

  async reply(input: { systemPrompt: string; prompt: string; meta?: CallMeta }) {
    const r = await this.#cli.call({ systemPrompt: input.systemPrompt, prompt: input.prompt, model: this.#models.chat, tag: input.meta });
    if (!r.text.trim()) throw new OrchestratorError("Réponse vide du directeur");
    return { text: r.text.trim(), costUsd: r.costUsd };
  }

  async structured(input: { systemPrompt: string; prompt: string; jsonSchema: object; meta?: CallMeta }) {
    const r = await this.#cli.call({
      systemPrompt: input.systemPrompt,
      prompt: input.prompt,
      jsonSchema: input.jsonSchema,
      model: this.#models.structured,
      timeoutMs: 240_000,
      tag: input.meta,
    });
    if (r.structured == null) throw new OrchestratorError("Aucune sortie structurée reçue");
    return { data: r.structured, costUsd: r.costUsd };
  }
}
