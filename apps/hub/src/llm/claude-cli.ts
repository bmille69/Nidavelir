import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

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
};

export type ClaudeResult = { text: string; structured: unknown; costUsd: number | null };

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
    "",
    "--no-session-persistence",
    "--output-format",
    "json",
    "--model",
    call.model,
    "--system-prompt-file",
    systemPromptFile,
  ];
  if (call.jsonSchema) args.push("--json-schema", JSON.stringify(call.jsonSchema));
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
      let json: Record<string, unknown>;
      try {
        json = JSON.parse(stdout);
      } catch {
        throw new ClaudeCliError(`Réponse illisible de Claude Code : ${stdout.slice(0, 300)}`);
      }
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
        if (code === 0 || out.trim().startsWith("{")) resolve(out);
        else reject(new ClaudeCliError(`Claude Code s'est arrêté (code ${code}) : ${(err || out).slice(0, 300)}`));
      });
      child.stdin.end(stdin, "utf8");
    });
  }
}
