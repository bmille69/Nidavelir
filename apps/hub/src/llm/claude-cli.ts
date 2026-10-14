import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseRateLimit, parseUsage, type UsageEvent } from "../usage/usage-service.ts";

export class ClaudeCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeCliError";
  }
}

export type ClaudeCall = {
  systemPrompt: string;
  prompt: string;
  model: string;
  /** JSON Schema de la sortie structurée, si attendue. */
  jsonSchema?: object;
  timeoutMs?: number;
  /**
   * Outils en lecture seule autorisés pour cet appel (ex. recherche web du Concepteur, ADR-28).
   * Seuls ceux de WEB_TOOLS sont acceptés ; par défaut, aucun outil.
   */
  tools?: string[];
  /** Pour le compteur d'utilisation : projet et agent à l'origine de l'appel. */
  tag?: { project?: string | null; agent: string };
};

export type ClaudeResult = { text: string; structured: unknown; costUsd: number | null };

/** Les seuls outils qu'un appel conversationnel peut recevoir : chercher et lire des pages web. */
export const WEB_TOOLS = ["WebSearch", "WebFetch"];

/** Options interdites en toutes circonstances (docs/SECURITY.md §7). */
const FORBIDDEN_ARGS = [/^--dangerously-skip-permissions$/, /^--allow-dangerously-skip-permissions$/, /^bypassPermissions$/, /^acceptEdits$/, /^auto$/];

/**
 * Arguments d'un appel « conversationnel » : aucun outil, aucun réglage
 * utilisateur ou projet, aucun serveur MCP, aucune persistance de session.
 * Le hub fournit lui-même tout le contexte à chaque appel.
 */
export function buildChatArgs(call: ClaudeCall, systemPromptFile: string): string[] {
  const args = [
    "-p",
    "--restricted",
    "--safe-mode",
    "--strict-mcp-config",
    "--tools",
    (call.tools ?? []).join(","),
    "--no-session-persistence",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    call.model,
    "--system-prompt-file",
    systemPromptFile,
  ];
  if (call.jsonSchema) args.push("--json-schema", JSON.stringify(call.jsonSchema));
  if (call.tools?.length) {
    const bad = call.tools.filter((t) => !WEB_TOOLS.includes(t));
    if (bad.length) throw new ClaudeCliError(`Outil non autorisé pour un appel conversationnel : ${bad.join(", ")}`);
    // Lecture du web uniquement : aucun accès aux fichiers ni au terminal.
    args.push("--allowedTools", call.tools.join(","), "--max-turns", "16");
  }
  assertSafeArgs(args);
  return args;
}

export function assertSafeArgs(args: string[]): void {
  for (const a of args) {
    if (FORBIDDEN_ARGS.some((re) => re.test(a))) throw new ClaudeCliError(`Option interdite : ${a}`);
  }
}

/** Limite le nombre d'appels Claude simultanés. */
class Semaphore {
  #free: number;
  readonly #queue: (() => void)[] = [];
  constructor(n: number) {
    this.#free = n;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#free > 0) this.#free--;
    else await new Promise<void>((r) => this.#queue.push(r));
    try {
      return await fn();
    } finally {
      const next = this.#queue.shift();
      if (next) next();
      else this.#free++;
    }
  }
}

/** Lance le binaire Claude Code officiel, non modifié, avec votre connexion (ADR-04, ADR-11). */
export class ClaudeCli {
  readonly #workDir: string;
  readonly #binary: string;
  readonly #limit = new Semaphore(2);
  /** Reçoit l'usage de chaque appel (jetons, limites d'abonnement). */
  observer: ((e: UsageEvent) => void) | null = null;

  /** workDir : dossier vide dédié, pour qu'aucun CLAUDE.md de projet ne soit chargé. */
  constructor(workDir: string, binary = "claude") {
    this.#workDir = workDir;
    this.#binary = binary;
    mkdirSync(workDir, { recursive: true });
  }

  call(call: ClaudeCall): Promise<ClaudeResult> {
    return this.#limit.run(() => this.#call(call));
  }

  async #call(call: ClaudeCall): Promise<ClaudeResult> {
    const sysFile = join(this.#workDir, `system-${randomUUID()}.txt`);
    writeFileSync(sysFile, call.systemPrompt, "utf8");
    try {
      const stdout = await this.#spawn(buildChatArgs(call, sysFile), call.prompt, call.timeoutMs ?? 180_000);
      const { result, limits } = parseStream(stdout);
      if (!result) throw new ClaudeCliError(`Réponse illisible de Claude Code : ${stdout.slice(0, 300)}`);
      const json = result;
      this.observer?.({
        project: call.tag?.project,
        agent: call.tag?.agent ?? "autre",
        model: call.model,
        tokens: parseUsage(json),
        costUsd: typeof json.total_cost_usd === "number" ? json.total_cost_usd : null,
        limits,
      });
      if (json.is_error || json.subtype !== "success") {
        throw new ClaudeCliError(`Claude Code a échoué (${String(json.subtype)}) : ${String(json.result ?? "").slice(0, 300)}`);
      }
      return {
        text: String(json.result ?? ""),
        structured: json.structured_output ?? null,
        costUsd: typeof json.total_cost_usd === "number" ? json.total_cost_usd : null,
      };
    } finally {
      rmSync(sysFile, { force: true });
    }
  }

  #spawn(args: string[], stdin: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#binary, args, { cwd: this.#workDir, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new ClaudeCliError(`Claude Code n'a pas répondu en ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      child.stdout.setEncoding("utf8").on("data", (c: string) => (out += c));
      child.stderr.setEncoding("utf8").on("data", (c: string) => (err += c));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(new ClaudeCliError(`Impossible de lancer Claude Code : ${e.message}`));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0 || out.includes('"type":"result"')) resolve(out);
        else reject(new ClaudeCliError(`Claude Code s'est arrêté (code ${code}) : ${(err || out).slice(0, 300)}`));
      });
      child.stdin.end(stdin, "utf8");
    });
  }
}

/** Extrait le résultat final et les limites d'abonnement d'un flux stream-json. */
export function parseStream(stdout: string): { result: Record<string, unknown> | null; limits: ReturnType<typeof parseRateLimit> } {
  let result: Record<string, unknown> | null = null;
  let limits: ReturnType<typeof parseRateLimit> = null;
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const msg = JSON.parse(line) as Record<string, unknown>;
      if (msg.type === "result") result = msg;
      else if (msg.type === "rate_limit_event") limits = parseRateLimit(msg) ?? limits;
    } catch {
      /* ligne non JSON ignorée */
    }
  }
  return { result, limits };
}
