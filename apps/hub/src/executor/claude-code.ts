import { execFile, spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSafeArgs } from "../llm/claude-cli.ts";
import { ExecutorError, type ExecRequest, type ExecResult, type ExecutorPort } from "./port.ts";

const BRIDGE = fileURLToPath(new URL("./bridge/", import.meta.url));

/** Arguments d'un run Claude Code contrôlé par le hub (ADR-04, ADR-15). Exporté pour les tests. */
export function buildExecArgs(req: Pick<ExecRequest, "tools" | "maxTurns" | "jsonSchema">, files: { settings: string; mcp: string; system: string }, model: string): string[] {
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
  assertSafeArgs(args);
  if (args.includes("Bash(*)") || req.tools.some((t) => /\(\*\)|\*\*/.test(t))) throw new ExecutorError("Motif d'outil trop large");
  return args;
}

export class ClaudeCodeExecutor implements ExecutorPort {
  readonly name = "claude-code";
  readonly #model: string;
  readonly #binary: string;

  constructor(model = "sonnet", binary = "claude") {
    this.#model = model;
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
      JSON.stringify({ mcpServers: { studio: { type: "stdio", command: node, args: [join(BRIDGE, "gate.mjs"), req.bridgeUrl], env: { STUDIO_RUN_TOKEN: req.token } } } }, null, 2),
    );
    writeFileSync(system, req.systemPrompt, "utf8");
    const args = buildExecArgs(req, { settings, mcp, system }, this.#model);

    return new Promise((resolve, reject) => {
      const child = spawn(this.#binary, args, {
        cwd: req.cwd,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, STUDIO_RUN_TOKEN: req.token },
      });
      let buffer = "";
      let stderr = "";
      let final: Record<string, unknown> | null = null;
      const onAbort = () => killTree(child.pid);
      req.signal.addEventListener("abort", onAbort, { once: true });

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
            if (msg.type === "result") final = msg;
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
        if (req.signal.aborted) return reject(new ExecutorError("Exécution arrêtée"));
        const result = final as Record<string, unknown> | null;
        if (!result) return reject(new ExecutorError(`Claude Code s'est arrêté sans résultat (code ${code}) : ${stderr.slice(0, 300)}`));
        if (result.is_error) return reject(new ExecutorError(`Claude Code a échoué (${String(result.subtype)}) : ${String(result.result ?? "").slice(0, 300)}`));
        resolve({
          structured: result.structured_output ?? null,
          text: String(result.result ?? ""),
          costUsd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : null,
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
    default:
      return `${name}`;
  }
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
  else process.kill(-pid, "SIGKILL");
}
