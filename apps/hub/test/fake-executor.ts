import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { RunMode } from "../src/executor/policy-engine.ts";
import type { ExecRequest, ExecResult, ExecutorPort } from "../src/executor/port.ts";

/** Ce qu'un agent scripté peut tenter ; chaque action passe par les mêmes contrôles que Claude Code. */
export class FakeAgentTools {
  readonly log: string[] = [];
  readonly req: ExecRequest;
  constructor(req: ExecRequest) {
    this.req = req;
  }

  /** Comme Claude Code : hook d'abord ; « ask » renvoie vers le gardien. */
  async #authorize(tool: string, input: Record<string, unknown>): Promise<boolean> {
    const d = await this.req.bridge.preTool(tool, input);
    if (d.decision === "allow") return true;
    if (d.decision === "deny") return false;
    return (await this.req.bridge.permission(tool, input)).behavior === "allow";
  }

  async write(rel: string, content: string): Promise<"ok" | "refused"> {
    const file_path = isAbsolute(rel) ? rel : join(this.req.cwd, rel);
    const ok = await this.#authorize("Write", { file_path, content });
    this.log.push(`Write ${rel} → ${ok ? "ok" : "refused"}`);
    if (ok) {
      mkdirSync(dirname(file_path), { recursive: true });
      writeFileSync(file_path, content);
    }
    return ok ? "ok" : "refused";
  }

  async bash(command: string): Promise<"ok" | "refused"> {
    const ok = await this.#authorize("Bash", { command });
    this.log.push(`Bash ${command} → ${ok ? "ok" : "refused"}`);
    const del = /^rm (.+)$/.exec(command);
    if (ok && del) rmSync(join(this.req.cwd, del[1]!), { force: true });
    return ok ? "ok" : "refused";
  }
}

type Script = (tools: FakeAgentTools, req: ExecRequest) => Promise<unknown> | unknown;

/** Exécuteur factice (ADR-08) : un script par phase, rejoué dans l'ordre. */
export class FakeExecutor implements ExecutorPort {
  readonly name = "fake";
  readonly scripts: Record<RunMode, Script[]> = { plan: [], execute: [], verify: [] };
  readonly requests: ExecRequest[] = [];
  readonly tools: FakeAgentTools[] = [];

  async run(req: ExecRequest): Promise<ExecResult> {
    this.requests.push(req);
    const script = this.scripts[req.kind].shift();
    if (!script) throw new Error(`Aucun script pour la phase ${req.kind}`);
    const tools = new FakeAgentTools(req);
    this.tools.push(tools);
    const abort = new Promise<never>((_, reject) => req.signal.addEventListener("abort", () => reject(new Error("arrêté")), { once: true }));
    const structured = await Promise.race([Promise.resolve(script(tools, req)), abort]);
    return { structured, text: "", costUsd: 0.01 };
  }
}

export function planOutput(partial: Record<string, unknown> = {}) {
  return {
    summary: "Ajouter le fichier de configuration des boss.",
    summary_simple: "On crée un petit fichier qui décrit quand les boss apparaissent.",
    acceptance_criteria: ["Le fichier src/boss.ts existe et exporte la règle d'apparition"],
    steps: [{ description: "Créer src/boss.ts", files: ["src/boss.ts"] }],
    files_to_create: ["src/boss.ts"],
    files_to_modify: [],
    files_to_delete: [],
    commands: [{ cmd: "npm test", purpose: "vérifier" }],
    new_dependencies: [],
    risks: [],
    assumptions: [],
    questions: [],
    ...partial,
  };
}

export const REPORT = {
  outcome: "completed",
  summary: "Fichier créé.",
  summary_simple: "Les boss ont maintenant leur règle d'apparition dans le code.",
  deviations: [],
  open_issues: [],
};

export const VERIFIED = {
  verdict: "pass",
  summary_simple: "Le travail respecte la décision.",
  checks: [{ criterion: "Le fichier existe", result: "pass", evidence: "src/boss.ts présent" }],
  decision_compliance: [{ decision: "D-0001", respected: true, note: "ok" }],
  hidden_assumptions: [],
  regressions: [],
  recommendation: "merge",
};
