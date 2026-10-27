import type { RateLimits, TokenUsage } from "../usage/usage-service.ts";
import type { Decision, RunMode } from "./policy-engine.ts";

export type RunEvent = { seq: number; at: string; type: "text" | "tool" | "result" | "info" | "error"; text: string };

/** Accès de l'agent au hub pendant un run : seulement demander, jamais décider. */
export interface AgentBridge {
  preTool(tool: string, input: Record<string, unknown>): Promise<Decision>;
  permission(tool: string, input: Record<string, unknown>): Promise<{ behavior: "allow" | "deny"; message?: string }>;
}

export type ExecRequest = {
  kind: RunMode;
  runId: string;
  /** Worktree de la tâche : seul répertoire de travail de l'agent. */
  cwd: string;
  /** Dossier propre au run (réglages, configuration MCP, journal brut). */
  runDir: string;
  systemPrompt: string;
  prompt: string;
  jsonSchema: object;
  tools: string[];
  maxTurns: number;
  /** Chantier marqué « (gros) » : le développeur prend son modèle des gros chantiers (ADR-41). */
  big?: boolean;
  /** Modèle imposé pour ce run (Jeu express : Éclair sur Sonnet, Soigné sur Opus, ADR-44). */
  model?: string;
  /** Plugin portant les compétences du studio pour ce run (ADR-29), chargé par --plugin-dir. */
  pluginDir?: string;
  /** Le testeur reçoit l'outil « jouer » du relais MCP (ADR-69). */
  play?: boolean;
  /** Pour les exécuteurs en processus (tests). */
  bridge: AgentBridge;
  /** Pour Claude Code : URL de base des routes /api/agent/runs/:id et jeton du run. */
  bridgeUrl: string;
  token: string;
  onEvent(type: RunEvent["type"], text: string): void;
  signal: AbortSignal;
  /** Le chantier du run : l'essai Caveman (ADR-92) choisit son chemin chantier par chantier. */
  taskId?: string;
  /** Adresse de base de l'API pour ce run (relais Caveman, ADR-92). Absente : Anthropic en direct. */
  baseUrl?: string;
  /** Serveurs MCP ajoutés à celui du studio pour ce run (l'outil de relecture de Caveman, ADR-92). */
  extraMcp?: Record<string, { command: string; args: string[]; env?: Record<string, string> }>;
};

export type ExecResult = {
  structured: unknown;
  text: string;
  costUsd: number | null;
  tokens?: TokenUsage | null;
  limits?: RateLimits | null;
  model?: string | null;
  /** Chemin réellement pris par le run (ADR-92). */
  route?: "direct" | "caveman";
};

/** Exécuteur de tâches (docs/ARCHITECTURE.md §3.5). */
export interface ExecutorPort {
  readonly name: string;
  run(req: ExecRequest): Promise<ExecResult>;
}

export class ExecutorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutorError";
  }
}
