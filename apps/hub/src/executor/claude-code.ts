import { execFile, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSafeArgs } from "../llm/claude-cli.ts";
import { parseRateLimit, parseUsage, type RateLimits } from "../usage/usage-service.ts";
import { ExecutorError, type ExecRequest, type ExecResult, type ExecutorPort } from "./port.ts";

const BRIDGE = fileURLToPath(new URL("./bridge/", import.meta.url));

/** Arguments d'un run Claude Code contrôlé par le hub (ADR-04, ADR-15). Exporté pour les tests. */
export function buildExecArgs(req: Pick<ExecRequest, "tools" | "maxTurns" | "jsonSchema" | "pluginDir">, files: { settings: string; mcp: string; system: string }, model: string): string[] {
  const args = [
    "-p",
    "--permission-mode",
    "default",
    "--tools",
    req.tools.join(","),
    "--permission-prompt-tool",
    "mcp__studio__permission_gate",
    "--mcp-config",
    files.mcp,
    "--strict-mcp-config",
    "--setting-sources",
    "",
    "--settings",
    files.settings,
    "--append-system-prompt-file",
    files.system,
    "--output-format",
    "stream-json",
    "--verbose",
    "--json-schema",
    JSON.stringify(req.jsonSchema),
    "--max-turns",
    String(req.maxTurns),
    "--model",
    model,
  ];
  if (req.pluginDir) args.push("--plugin-dir", req.pluginDir);
  assertSafeArgs(args);
  if (args.includes("Bash(*)") || req.tools.some((t) => /\(\*\)|\*\*/.test(t))) throw new ExecutorError("Motif d'outil trop large");
  return args;
}

/** `big` : modèle du développeur pour un chantier marqué « (gros) » (ADR-41). */
type PhaseModels = Partial<Record<ExecRequest["kind"], string>> & { default: string; big?: string };

export class ClaudeCodeExecutor implements ExecutorPort {
  readonly name = "claude-code";
  readonly #models: () => PhaseModels;
  readonly #binary: string;

  /** Un modèle par phase : le testeur peut être plus léger que le développeur (ADR-26), lu à chaque run (ADR-37). */
  constructor(model: string | PhaseModels | (() => PhaseModels) = "sonnet", binary = "claude") {
    this.#models = typeof model === "function" ? model : typeof model === "string" ? () => ({ default: model }) : () => model;
    this.#binary = binary;
  }

  run(req: ExecRequest): Promise<ExecResult> {
    mkdirSync(req.runDir, { recursive: true });
    const node = process.execPath;
    const q = (s: string) => `"${s.replace(/"/g, '\\"')}"`;
    const settings = join(req.runDir, "settings.json");
    const mcp = join(req.runDir, "mcp.json");
    const system = join(req.runDir, "system.md");
    const stream = join(req.runDir, "stream.jsonl");
    writeFileSync(
      settings,
      JSON.stringify(
        {
          permissions: { allow: [], deny: [], defaultMode: "default" },
          hooks: { PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: `${q(node)} ${q(join(BRIDGE, "hook.mjs"))} ${q(req.bridgeUrl)}` }] }] },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      mcp,
      JSON.stringify(
        {
          mcpServers: {
            ...Object.fromEntries(Object.entries(req.extraMcp ?? {}).map(([name, s]) => [name, { type: "stdio", ...s }])),
            studio: { type: "stdio", command: node, args: [join(BRIDGE, "gate.mjs"), req.bridgeUrl], env: { STUDIO_RUN_TOKEN: req.token, ...(req.play ? { STUDIO_PLAY: "1" } : {}) } },
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(system, req.systemPrompt, "utf8");
    const models = this.#models();
    const model = req.model ?? (req.big && req.kind !== "verify" ? models.big : undefined) ?? models[req.kind] ?? models.default;
    const args = buildExecArgs(req, { settings, mcp, system }, model);

    return new Promise((resolve, reject) => {
      const child = spawn(this.#binary, args, {
        cwd: req.cwd,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        // Relais Caveman (ADR-92) : seulement l'adresse, aucun identifiant, l'abonnement reste celui de Claude Code.
        env: { ...process.env, STUDIO_RUN_TOKEN: req.token, ...(req.baseUrl ? { ANTHROPIC_BASE_URL: req.baseUrl } : {}) },
      });
      let buffer = "";
      let stderr = "";
      let final: Record<string, unknown> | null = null;
      let limits: RateLimits | null = null;
      const onAbort = () => killTree(child.pid);
      req.signal.addEventListener("abort", onAbort, { once: true });
      // Le résultat est rendu mais Claude Code ne se ferme pas : un serveur lancé en arrière-plan (« npx vite ») le
      // retient. Après un délai de grâce, le hub ferme tout l'arbre et garde le résultat (constat T-0057 : 1 h 15 d'attente).
      let linger: NodeJS.Timeout | null = null;

      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        buffer += chunk;
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          appendFileSync(stream, line + "\n");
          try {
            const msg = JSON.parse(line) as Record<string, unknown>;
            if (msg.type === "result") {
              final = msg;
              linger ??= setTimeout(() => killTree(child.pid), RESULT_GRACE_MS);
            }
            else if (msg.type === "rate_limit_event") limits = parseRateLimit(msg) ?? limits;
            else relay(msg, req.onEvent);
          } catch {
            /* ligne non JSON : conservée dans le journal brut */
          }
        }
      });
      child.stderr.setEncoding("utf8").on("data", (c: string) => (stderr += c));
      child.on("error", (e) => reject(new ExecutorError(`Impossible de lancer Claude Code : ${e.message}`)));
      child.on("close", (code) => {
        req.signal.removeEventListener("abort", onAbort);
        if (linger) clearTimeout(linger);
        // Les serveurs que le développeur a lancés et laissés tourner dans sa copie du jeu (T-0055, T-0056) : éteints.
        killStragglers(req.cwd);
        if (req.signal.aborted) return reject(new ExecutorError("Exécution arrêtée"));
        const result = final as Record<string, unknown> | null;
        if (!result) return reject(new ExecutorError(`Claude Code s'est arrêté sans résultat (code ${code}) : ${stderr.slice(0, 300)}`));
        if (result.is_error) return reject(new ExecutorError(`Claude Code a échoué (${String(result.subtype)}) : ${String(result.result ?? "").slice(0, 300)}`));
        resolve({
          structured: result.structured_output ?? null,
          text: String(result.result ?? ""),
          costUsd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : null,
          tokens: parseUsage(result),
          limits,
          model,
        });
      });
      child.stdin.end(req.prompt, "utf8");
    });
  }
}

/** Traduit le flux stream-json en événements lisibles pour l'interface. */
function relay(msg: Record<string, unknown>, onEvent: ExecRequest["onEvent"]): void {
  const content = ((msg.message as { content?: unknown[] } | undefined)?.content ?? []) as Record<string, unknown>[];
  if (msg.type === "assistant") {
    for (const c of content) {
      if (c.type === "text" && String(c.text).trim()) onEvent("text", String(c.text).trim().slice(0, 2000));
      if (c.type === "tool_use") onEvent("tool", describeTool(String(c.name), (c.input ?? {}) as Record<string, unknown>));
    }
  } else if (msg.type === "user") {
    for (const c of content) {
      if (c.type === "tool_result" && c.is_error) {
        const text = Array.isArray(c.content) ? (c.content as { text?: string }[]).map((x) => x.text ?? "").join(" ") : String(c.content ?? "");
        onEvent("error", text.slice(0, 500));
      }
    }
  }
}

export function describeTool(name: string, input: Record<string, unknown>): string {
  const path = String(input.file_path ?? input.path ?? "");
  switch (name) {
    case "Read":
      return `Lit ${path}`;
    case "Edit":
      return `Modifie ${path}`;
    case "Write":
      return `Écrit ${path}`;
    case "Grep":
      return `Cherche « ${String(input.pattern ?? "")} »${path ? ` dans ${path}` : ""}`;
    case "Glob":
      return `Liste ${String(input.pattern ?? "")}`;
    case "Bash":
      return `Commande : ${String(input.command ?? "")}`;
    case "mcp__studio__jouer":
      return describePlay(input);
    default:
      return `${name}`;
  }
}

/** La manette du testeur en une ligne, pour « En direct » (ADR-69). */
function describePlay(input: Record<string, unknown>): string {
  const screen = input.screen === "phone" ? " (téléphone)" : "";
  if (input.action === "open") return `Lance le jeu pour y jouer${screen}`;
  if (input.action === "capture") return "Prend une photo du jeu";
  if (input.action === "close") return "Ferme la partie";
  const steps = Array.isArray(input.steps) ? (input.steps as Record<string, unknown>[]) : [];
  const keys = steps.flatMap((s) => (s.do === "press" ? [String(s.key)] : s.do === "click" ? [s.text ? `clic « ${String(s.text)} »` : "clic"] : []));
  return `Joue au jeu${screen} : ${steps.length} action(s)${keys.length ? ` (${[...new Set(keys)].slice(0, 6).join(", ")})` : ""}`;
}

/** Délai entre le résultat de Claude Code et la fermeture forcée de ce qu'il a laissé tourner. */
const RESULT_GRACE_MS = 60_000;

/**
 * Les processus dont la ligne de commande désigne la copie de travail du chantier (dossier propre au hub, sous
 * .data/worktrees), avec leurs descendants : une fois Claude Code fermé, ils gardent des ports et des fichiers ouverts
 * (souvent lancés par un « cmd » intermédiaire encore vivant, T-0059). Seuls sont épargnés ceux qui descendent du hub
 * lui-même : ses aperçus (« Essayer »).
 */
export function killStragglers(cwd: string, hubPid = process.pid): void {
  if (process.platform !== "win32" || !/[\\/](worktrees|mods)[\\/]/i.test(cwd)) return;
  const path = cwd.replace(/'/g, "''");
  const script = [
    "$all = Get-CimInstance Win32_Process",
    "$parent = @{}; foreach ($p in $all) { $parent[[int]$p.ProcessId] = [int]$p.ParentProcessId }",
    `function FromHub($id) { for ($n = 0; $n -lt 40 -and $parent.ContainsKey($id); $n++) { $id = $parent[$id]; if ($id -eq ${hubPid}) { return $true } }; return $false }`,
    `$all | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains('${path}') -and -not (FromHub ([int]$_.ProcessId)) } | ForEach-Object { taskkill /PID $_.ProcessId /T /F 2>&1 | Out-Null }`,
  ].join("\n");
  execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true }, () => {});
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
  else process.kill(-pid, "SIGKILL");
}
