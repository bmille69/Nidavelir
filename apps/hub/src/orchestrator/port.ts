/**
 * Port d'orchestration (docs/ARCHITECTURE.md §3.4).
 *
 * Étape 2 de la phase 1 : sous-ensemble sans état côté orchestrateur. Le hub
 * fournit à chaque appel tout le contexte (vision + historique), ce qui le
 * rend indépendant de la mémoire de session de Claude Code comme d'Hermes.
 * La délégation et l'annulation viendront avec les spécialistes et Hermes.
 */
export interface OrchestratorPort {
  readonly name: string;
  /** Un tour de conversation du directeur. */
  reply(input: {
    systemPrompt: string;
    prompt: string;
    meta?: CallMeta;
    /** Dossier à lire (Archéologue, ADR-40) : lecture seule, rien en dehors. */
    readDir?: string;
    timeoutMs?: number;
  }): Promise<{ text: string; costUsd: number | null }>;
  /** Une sortie structurée validée par JSON Schema (extraction, propositions…). */
  structured(input: {
    systemPrompt: string;
    prompt: string;
    jsonSchema: object;
    meta?: CallMeta;
    /** Outils web en lecture seule (Concepteur, ADR-28). */
    tools?: string[];
    /** « concept » : modèle dédié à la conception (plus puissant, appels rares). */
    tier?: "concept";
  }): Promise<{
    data: unknown;
    costUsd: number | null;
  }>;
}

/** Origine d'un appel, pour le compteur d'utilisation. */
export type CallMeta = { project?: string | null; agent: string };

export class OrchestratorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrchestratorError";
  }
}
