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
  /**
   * Lecture d'un dossier (l'Archéologue, ADR-40) : Read, Grep et Glob seulement, le dossier comme
   * dossier de travail. Claude Code refuse de lui-même toute lecture en dehors (vérifié le 15/10/2026).
   * Avec `tools` (WEB_TOOLS seulement) : la lecture du dossier plus la recherche web (Directeur artistique, ADR-43).
   */
  readDir?: string;
  /**
   * Bibliothèque de compétences à lire à la demande (ADR-97) : ce dossier devient lisible (Read seulement),
   * l'agent y ouvre les SKILL.md qui concernent la demande.
   */
  skillsDir?: string;
  /**
   * Outils de l'équipe servis par le hub lui-même (ADR-98) : consulter un collègue, proposer un souvenir,
   * lire le jeu. Un serveur MCP local, joignable seulement avec le jeton de cet appel.
   */
  team?: TeamGrant;
  /** « team » : la réponse d'un collègue consulté a sa propre file, pour ne jamais attendre celui qui la demande. */
  lane?: "team";
};

/** Accès d'un appel aux outils de l'équipe (ADR-98) : adresse du hub, jeton à usage unique, outils ouverts. */
export type TeamGrant = { url: string; token: string; tools: string[] };

/** Nom d'un outil de l'équipe vu par Claude Code. */
export const teamToolName = (tool: string) => `mcp__studio__${tool}`;

/** Les seuls outils d'un appel qui lit un dossier : lire, chercher, lister. Ni écriture, ni terminal, ni web. */
export const READ_TOOLS = ["Read", "Grep", "Glob"];

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
  // Outils de l'équipe (ADR-98) : --safe-mode coupe aussi les serveurs MCP donnés en ligne de commande (vérifié le
  // 28/10/2026), il cède donc la place à --setting-sources vide ; --restricted, --strict-mcp-config et la liste fermée
  // d'outils (--tools) gardent l'isolement : ni réglages, ni compétences, ni autre serveur que celui du hub.
  const team = call.team?.tools.length ? call.team : null;
  const teamTools = team ? team.tools.map(teamToolName) : [];
  const args = [
    "-p",
    "--restricted",
    ...(team ? [] : ["--safe-mode"]),
    "--strict-mcp-config",
    "--tools",
    (call.readDir ? [...READ_TOOLS, ...(call.tools ?? [])] : [...(call.skillsDir ? ["Read"] : []), ...(call.tools ?? [])]).join(","),
    "--no-session-persistence",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    call.model,
    "--system-prompt-file",
    systemPromptFile,
  ];
  if (team) {
    args.push("--mcp-config", JSON.stringify({ mcpServers: { studio: { type: "http", url: team.url, headers: { Authorization: `Bearer ${team.token}` } } } }));
    if (!call.readDir) args.push("--setting-sources", "");
  }
  // Une réponse qui consulte, lit le jeu ou retient quelque chose a besoin de plus d'étapes (ADR-98).
  const turns = team ? "40" : "16";
  if (call.jsonSchema) args.push("--json-schema", JSON.stringify(call.jsonSchema));
  // Compétences (ADR-97) : leur dossier s'ajoute aux dossiers lisibles ; --restricted y confine la lecture.
  if (call.skillsDir) args.push("--add-dir", call.skillsDir);
  if (call.readDir) {
    const bad = (call.tools ?? []).filter((t) => !WEB_TOOLS.includes(t));
    if (bad.length) throw new ClaudeCliError(`Un appel qui lit un dossier ne reçoit que la recherche web en plus : ${bad.join(", ")}`);
    // Pas de --allowedTools pour la lecture : seules les lectures dans le dossier de travail passent sans demande.
    // La recherche web, si elle est donnée, est autorisée explicitement (ADR-43).
    args.push("--setting-sources", "");
    const allowed = [...(call.tools ?? []), ...teamTools];
    if (allowed.length) args.push("--allowedTools", allowed.join(","));
    args.push("--max-turns", "80");
  } else if (call.tools?.length) {
    const bad = call.tools.filter((t) => !WEB_TOOLS.includes(t));
    if (bad.length) throw new ClaudeCliError(`Outil non autorisé pour un appel conversationnel : ${bad.join(", ")}`);
    // Lecture du web uniquement : aucun accès aux fichiers ni au terminal.
    args.push("--allowedTools", [...(call.skillsDir ? ["Read"] : []), ...call.tools, ...teamTools].join(","), "--max-turns", turns);
  } else if (call.skillsDir) {
    // Seulement lire les compétences : aucun autre outil.
    args.push("--allowedTools", ["Read", ...teamTools].join(","), "--max-turns", turns);
  } else if (team) {
    args.push("--allowedTools", teamTools.join(","), "--max-turns", turns);
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
  /** Les longues lectures de l'Archéologue ne bloquent jamais le directeur. */
  readonly #readers = new Semaphore(1);
  /** Le Directeur artistique (lecture + web) a sa propre file : ni le directeur ni l'Archéologue ne l'attendent. */
  readonly #art = new Semaphore(1);
  /** Un collègue consulté (ADR-98) répond hors des autres files : celui qui l'a consulté y occupe déjà une place. */
  readonly #team = new Semaphore(2);
  /** Reçoit l'usage de chaque appel (jetons, limites d'abonnement). */
  observer: ((e: UsageEvent) => void) | null = null;
  /** Reçoit chaque outil utilisé (lecture d'une compétence, ADR-97). */
  toolObserver: ((e: { tool: string; input: Record<string, unknown>; tag?: ClaudeCall["tag"] }) => void) | null = null;

  /** workDir : dossier vide dédié, pour qu'aucun CLAUDE.md de projet ne soit chargé. */
  constructor(workDir: string, binary = "claude") {
    this.#workDir = workDir;
    this.#binary = binary;
    mkdirSync(workDir, { recursive: true });
  }

  call(call: ClaudeCall): Promise<ClaudeResult> {
    const lane = call.lane === "team" ? this.#team : call.readDir ? (call.tools?.length ? this.#art : this.#readers) : this.#limit;
    return lane.run(() => this.#call(call));
  }

  async #call(call: ClaudeCall): Promise<ClaudeResult> {
    const sysFile = join(this.#workDir, `system-${randomUUID()}.txt`);
    writeFileSync(sysFile, call.systemPrompt, "utf8");
    try {
      const stdout = await this.#spawn(buildChatArgs(call, sysFile), call.prompt, call.timeoutMs ?? 180_000, call.readDir);
      const { result, limits, tools } = parseStream(stdout);
      if (this.toolObserver) {
        for (const t of tools) {
          try {
            this.toolObserver({ ...t, tag: call.tag });
          } catch {
            /* un observateur ne casse jamais l'appel */
          }
        }
      }
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

  #spawn(args: string[], stdin: string, timeoutMs: number, cwd = this.#workDir): Promise<string> {
    return new Promise((resolve, reject) => {
      // MCP_TOOL_TIMEOUT : un collègue consulté peut mettre plusieurs minutes à répondre (ADR-98).
      const child = spawn(this.#binary, args, { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, MCP_TOOL_TIMEOUT: "900000" } });
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

/** Extrait le résultat final, les limites d'abonnement et les outils utilisés d'un flux stream-json. */
export function parseStream(stdout: string): { result: Record<string, unknown> | null; limits: ReturnType<typeof parseRateLimit>; tools: { tool: string; input: Record<string, unknown> }[] } {
  let result: Record<string, unknown> | null = null;
  let limits: ReturnType<typeof parseRateLimit> = null;
  const tools: { tool: string; input: Record<string, unknown> }[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const msg = JSON.parse(line) as Record<string, unknown>;
      if (msg.type === "result") result = msg;
      else if (msg.type === "rate_limit_event") limits = parseRateLimit(msg) ?? limits;
      else if (msg.type === "assistant") {
        const content = (msg.message as { content?: unknown } | undefined)?.content;
        if (Array.isArray(content)) {
          for (const c of content as Record<string, unknown>[]) {
            if (c?.type === "tool_use" && typeof c.name === "string") tools.push({ tool: c.name, input: (c.input as Record<string, unknown>) ?? {} });
          }
        }
      }
    } catch {
      /* ligne non JSON ignorée */
    }
  }
  return { result, limits, tools };
}
