import type { ClaudeCli } from "../llm/claude-cli.ts";
import { OrchestratorError, type CallMeta, type OrchestratorPort } from "./port.ts";

type Models = { chat: string; structured: string; concept?: string; archeologue?: string; art?: string; artisan?: string };

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

  async reply(input: { systemPrompt: string; prompt: string; meta?: CallMeta; readDir?: string; tools?: string[]; role?: "art"; images?: boolean; timeoutMs?: number }) {
    const models = this.#pick();
    const r = await this.#cli.call({
      systemPrompt: input.systemPrompt,
      prompt: input.prompt,
      model: input.role === "art" ? (models.art ?? models.chat) : input.readDir && !input.images ? (models.archeologue ?? models.chat) : models.chat,
      tag: input.meta,
      readDir: input.readDir,
      tools: input.tools,
      timeoutMs: input.timeoutMs,
    });
    if (!r.text.trim()) throw new OrchestratorError("Réponse vide du directeur");
    return { text: r.text.trim(), costUsd: r.costUsd };
  }

  async structured(input: { systemPrompt: string; prompt: string; jsonSchema: object; meta?: CallMeta; tools?: string[]; tier?: "concept"; readDir?: string; role?: "art" | "artisan" | "artisan_renfort" }) {
    const models = this.#pick();
    const r = await this.#cli.call({
      systemPrompt: input.systemPrompt,
      prompt: input.prompt,
      jsonSchema: input.jsonSchema,
      model:
        input.role === "artisan_renfort"
          ? "fable"
          : input.role === "artisan"
            ? (models.artisan ?? models.art ?? models.chat)
          : input.role === "art"
            ? (models.art ?? models.chat)
            : input.tier === "concept"
              ? (models.concept ?? models.structured)
              : models.structured,
      // L'artisan 3D regarde des photos et écrit du Python à chaque pas : plus lent qu'un validateur. Le Concepteur
      // réécrit à chaque tour le dossier et toutes les consignes (34 chantiers : plus de 7 minutes, ADR-75).
      timeoutMs: input.role === "artisan" || input.role === "artisan_renfort" || input.tier === "concept" ? 900_000 : input.tools?.length || input.readDir ? 480_000 : 240_000,
      tag: input.meta,
      tools: input.tools,
      readDir: input.readDir,
    });
    if (r.structured == null) throw new OrchestratorError("Aucune sortie structurée reçue");
    return { data: r.structured, costUsd: r.costUsd };
  }
}
