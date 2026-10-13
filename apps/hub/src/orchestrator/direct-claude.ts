import type { ClaudeCli } from "../llm/claude-cli.ts";
import { OrchestratorError, type OrchestratorPort } from "./port.ts";

/** Directeur porté par Claude Code CLI, sans outils (ADR-10). */
export class DirectClaudeOrchestrator implements OrchestratorPort {
  readonly name = "direct-claude";
  readonly #cli: ClaudeCli;
  readonly #models: { chat: string; structured: string };

  constructor(cli: ClaudeCli, models: { chat: string; structured: string }) {
    this.#cli = cli;
    this.#models = models;
  }

  async reply(input: { systemPrompt: string; prompt: string }) {
    const r = await this.#cli.call({ ...input, model: this.#models.chat });
    if (!r.text.trim()) throw new OrchestratorError("Réponse vide du directeur");
    return { text: r.text.trim(), costUsd: r.costUsd };
  }

  async structured(input: { systemPrompt: string; prompt: string; jsonSchema: object }) {
    const r = await this.#cli.call({ ...input, model: this.#models.structured, timeoutMs: 240_000 });
    if (r.structured == null) throw new OrchestratorError("Aucune sortie structurée reçue");
    return { data: r.structured, costUsd: r.costUsd };
  }
}
