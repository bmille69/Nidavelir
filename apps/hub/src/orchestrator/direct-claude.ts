import type { ClaudeCli } from "../llm/claude-cli.ts";
import { OrchestratorError, type CallMeta, type OrchestratorPort } from "./port.ts";

type Models = { chat: string; structured: string; concept?: string };

/** Directeur porté par Claude Code CLI, sans outils (ADR-10). */
export class DirectClaudeOrchestrator implements OrchestratorPort {
  readonly name = "direct-claude";
  readonly #cli: ClaudeCli;
  readonly #pick: () => Models;

  /** Modèles fixes, ou lus à chaque appel (choisis depuis le studio, ADR-37). */
  constructor(cli: ClaudeCli, models: Models | (() => Models)) {
    this.#cli = cli;
    this.#pick = typeof models === "function" ? models : () => models;
  }

  async reply(input: { systemPrompt: string; prompt: string; meta?: CallMeta }) {
    const r = await this.#cli.call({ systemPrompt: input.systemPrompt, prompt: input.prompt, model: this.#pick().chat, tag: input.meta });
    if (!r.text.trim()) throw new OrchestratorError("Réponse vide du directeur");
    return { text: r.text.trim(), costUsd: r.costUsd };
  }

  async structured(input: { systemPrompt: string; prompt: string; jsonSchema: object; meta?: CallMeta; tools?: string[]; tier?: "concept" }) {
    const r = await this.#cli.call({
      systemPrompt: input.systemPrompt,
      prompt: input.prompt,
      jsonSchema: input.jsonSchema,
      model: input.tier === "concept" ? (this.#pick().concept ?? this.#pick().structured) : this.#pick().structured,
      timeoutMs: input.tools?.length ? 480_000 : 240_000,
      tag: input.meta,
      tools: input.tools,
    });
    if (r.structured == null) throw new OrchestratorError("Aucune sortie structurée reçue");
    return { data: r.structured, costUsd: r.costUsd };
  }
}
