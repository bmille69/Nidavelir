/**
 * Port d'orchestration (docs/ARCHITECTURE.md §3.4).
 *
 * Étape 2 de la phase 1 : sous-ensemble sans état côté orchestrateur. Le hub
 * fournit à chaque appel tout le contexte (vision + historique), ce qui le
 * rend indépendant de la mémoire de session de Claude Code comme d'Hermes.
 * La délégation et l'annulation viendront avec les spécialistes et Hermes.
 */
import type { TeamGrant } from "../llm/claude-cli.ts";

export interface OrchestratorPort {
  readonly name: string;
  /** Un tour de conversation du directeur. */
  reply(input: {
    systemPrompt: string;
    prompt: string;
    meta?: CallMeta;
    /** Dossier à lire (Archéologue, ADR-40) : lecture seule, rien en dehors. */
    readDir?: string;
    /** Avec readDir : recherche web en plus (Directeur artistique, ADR-43). */
    tools?: string[];
    /** « art » : modèle du Directeur artistique. */
    role?: "art";
    /** readDir ne sert qu'à regarder des images jointes (ADR-72) : le modèle du directeur est gardé. */
    images?: boolean;
    timeoutMs?: number;
    /** Compétences à lire à la demande (ADR-97) : dossier rendu lisible, Read seulement. */
    skillsDir?: string;
    /** Outils de l'équipe (ADR-98) : consulter un collègue, retenir, lire le jeu. */
    team?: TeamGrant;
    /** « team » : réponse d'un collègue consulté, dans sa propre file (ADR-98). */
    lane?: "team";
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
    /** Dossier à lire, et « art » pour le modèle du Directeur artistique (validateur, ADR-43), « artisan » pour l'artisan 3D (ADR-52). */
    readDir?: string;
    role?: "art" | "artisan" | "artisan_renfort";
    /** Compétences à lire à la demande (ADR-97). */
    skillsDir?: string;
    /** Outils de l'équipe (ADR-98). */
    team?: TeamGrant;
    /** « team » : hors des autres files, pour un appel qui ne doit ni attendre le directeur ni le bloquer (ADR-125). */
    lane?: "team";
    /** Délai propre, à la place de celui de son genre d'appel. */
    timeoutMs?: number;
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
