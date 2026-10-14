import type { PlanOutput } from "@studio/contracts";
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type Decision = { decision: "allow" | "deny" | "ask"; reason: string };
export type RunMode = "plan" | "execute" | "verify";

export type PolicyInput = {
  mode: RunMode;
  /** Racine du worktree de la tâche (seul endroit où l'agent travaille). */
  root: string;
  plan?: Pick<PlanOutput, "files_to_create" | "files_to_modify" | "files_to_delete" | "commands">;
};

/** Outils intégrés que l'agent peut recevoir (vérifié : ADR-15). */
export const TOOLS_BY_MODE: Record<RunMode, string[]> = {
  plan: ["Read", "Grep", "Glob", "Bash"],
  execute: ["Read", "Grep", "Glob", "Edit", "Write", "Bash"],
  verify: ["Read", "Grep", "Glob", "Bash"],
};

const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);
const WRITE_TOOLS = new Set(["Edit", "Write", "NotebookEdit"]);

/** Jamais lisibles ni modifiables par un agent. */
const SECRET = [/^\.env(\..*)?$/i, /\.pem$/i, /\.key$/i, /^id_(rsa|ed25519|ecdsa)/i, /^\.npmrc$/i, /^\.netrc$/i, /credentials/i];
/** Lisibles, jamais modifiables (même si le plan les cite). */
const READ_ONLY_DIRS = ["studio", ".git", ".claude"];

/** Commandes toujours permises : lecture seule, sans effet. */
const SAFE_COMMANDS = [/^git (status|diff|log|show)( [\w\-./=:@^~]+)*$/, /^ls( -[a-zA-Z]+)*( [\w\-./]+)*$/, /^pwd$/];
/** Jamais permises, même via le plan ou une escalade : réseau, interpréteurs, Git en écriture. */
const FORBIDDEN_COMMANDS = [
  /^(curl|wget|ssh|scp|sftp|ftp|nc|ncat|telnet|iwr|irm|invoke-webrequest|invoke-restmethod|start-process)\b/i,
  /^(node|python3?|py|pwsh|powershell|bash|sh|zsh|cmd|deno|bun|ruby|perl|php)(\.exe)?\b/i,
  /^git (push|pull|fetch|remote|config|reset|clean|checkout|switch|rebase|merge|commit|tag|worktree|stash|submodule|update-ref|filter-branch|gc)\b/i,
  /^(rm|del|rmdir|rd) .*(-r|-rf|-fr|\/s)\b/i,
  /^(sudo|runas|chmod|chown|icacls|takeown|reg|setx|format|diskpart|shutdown)\b/i,
  /^npx -y\b/i,
  // Liens : ils permettraient de sortir de la copie de travail.
  /^(ln|mklink|new-item|cp -s)\b/i,
  // Dépendances : node_modules est partagé avec votre projet (jonction) ; installer le modifierait.
  /^(npm|pnpm|yarn|bun) (i|install|ci|add|remove|rm|uninstall|un|update|up|upgrade|link|unlink|rebuild|prune|dedupe)\b/i,
];
const SHELL_META = /[;&|`$<>(){}\r\n\\]/;

/**
 * Politique d'exécution (docs/SECURITY.md §3) : décide pour CHAQUE action de l'agent.
 * allow = couvert par le plan ; deny = interdit ; ask = hors plan, on vous demande.
 * Pure et déterministe : testée unitairement, appelée par le hook et le gardien.
 */
export class PolicyEngine {
  readonly #mode: RunMode;
  readonly #root: string;
  readonly #writable: Set<string>;
  readonly #deletable: Set<string>;
  readonly #commands: Set<string>;

  constructor(input: PolicyInput) {
    this.#mode = input.mode;
    this.#root = realRoot(input.root);
    const plan = input.plan ?? { files_to_create: [], files_to_modify: [], files_to_delete: [], commands: [] };
    this.#writable = new Set([...plan.files_to_create, ...plan.files_to_modify].map(normRel));
    this.#deletable = new Set(plan.files_to_delete.map(normRel));
    this.#commands = new Set(plan.commands.map((c) => c.cmd.trim()));
  }

  evaluate(tool: string, input: Record<string, unknown>): Decision {
    // Outil interne de Claude Code pour rendre la réponse au format --json-schema : aucun effet (constaté le 14/10/2026).
    if (tool === "StructuredOutput") return allow("rendu du résultat final");
    if (READ_TOOLS.has(tool)) return this.#read(tool, input);
    if (WRITE_TOOLS.has(tool)) return this.#write(tool, input);
    if (tool === "Bash") return this.#bash(String(input.command ?? ""));
    return deny(`outil « ${tool} » non autorisé pour l'agent`);
  }

  /** Problèmes bloquants d'un plan avant toute validation humaine. */
  validatePlan(plan: PlanOutput): string[] {
    const problems: string[] = [];
    for (const f of [...plan.files_to_create, ...plan.files_to_modify, ...plan.files_to_delete]) {
      const rel = this.#relInside(f);
      if (rel === null) problems.push(`Chemin hors du projet : ${f}`);
      else if (isSecret(rel)) problems.push(`Fichier sensible interdit : ${f}`);
      else if (isReadOnly(rel)) problems.push(`Zone protégée (vision, Git ou réglages Claude) : ${f}`);
    }
    for (const c of plan.commands) {
      const why = commandProblem(c.cmd.trim());
      if (why) problems.push(`Commande refusée « ${c.cmd} » : ${why}`);
    }
    return problems;
  }

  /** Commandes du plan que le gardien refuse : elles sont retirées du plan au lieu de le bloquer. */
  refusedCommands(plan: PlanOutput): { cmd: string; why: string }[] {
    return plan.commands.flatMap((c) => {
      const why = commandProblem(c.cmd.trim());
      return why ? [{ cmd: c.cmd, why }] : [];
    });
  }

  #read(tool: string, input: Record<string, unknown>): Decision {
    const raw = (input.file_path ?? input.path ?? input.notebook_path) as string | undefined;
    if (!raw) return tool === "Read" ? deny("chemin manquant") : allow("recherche dans le projet");
    const rel = this.#relInside(raw);
    if (rel === null) return deny(`lecture hors du projet : ${raw}`);
    if (isSecret(rel)) return deny(`fichier sensible : ${rel}`);
    if (rel.split("/")[0] === ".git") return deny("lecture du dossier .git interdite");
    return allow("lecture dans le projet");
  }

  #write(tool: string, input: Record<string, unknown>): Decision {
    if (this.#mode !== "execute") return deny(`écriture impossible pendant la phase « ${this.#mode} »`);
    const raw = (input.file_path ?? input.notebook_path) as string | undefined;
    if (!raw) return deny("chemin manquant");
    const rel = this.#relInside(raw);
    if (rel === null) return deny(`écriture hors du projet : ${raw}`);
    if (isSecret(rel)) return deny(`fichier sensible : ${rel}`);
    if (isReadOnly(rel)) return deny(`zone protégée : ${rel} (la vision ne change que par vos décisions)`);
    if (this.#writable.has(rel)) return allow(`prévu dans le plan : ${rel}`);
    return ask(`${tool} sur ${rel}, qui n'est pas prévu dans le plan validé`);
  }

  #bash(command: string): Decision {
    const cmd = command.trim();
    if (!cmd) return deny("commande vide");
    if (SAFE_COMMANDS.some((re) => re.test(cmd)) && !SHELL_META.test(cmd)) return allow("commande en lecture seule");
    const problem = commandProblem(cmd);
    if (problem) return deny(problem);
    if (this.#mode !== "plan" && this.#commands.has(cmd)) return allow("commande prévue dans le plan");
    const del = /^(?:git )?rm ([\w\-./]+)$/.exec(cmd);
    if (del && this.#mode === "execute") {
      const rel = this.#relInside(del[1]!);
      if (rel !== null && this.#deletable.has(rel) && !isReadOnly(rel) && !isSecret(rel)) return allow(`suppression prévue : ${rel}`);
    }
    if (this.#mode === "execute") return ask(`commande non prévue dans le plan : ${cmd}`);
    return deny(`commande non prévue pendant la phase « ${this.#mode} » : ${cmd}`);
  }

  /** Chemin relatif normalisé (séparateur /), ou null s'il sort du worktree (liens compris). */
  #relInside(p: string): string | null {
    const abs = resolveReal(isAbsolute(p) ? p : join(this.#root, p));
    const rel = relative(this.#root, abs);
    if (rel === "") return "";
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    return normRel(rel);
  }
}

function commandProblem(cmd: string): string | null {
  if (SHELL_META.test(cmd)) return "enchaînements, redirections et substitutions interdits";
  if (FORBIDDEN_COMMANDS.some((re) => re.test(cmd))) return "commande interdite (réseau, interpréteur, Git en écriture ou système)";
  return null;
}

const allow = (reason: string): Decision => ({ decision: "allow", reason });
const deny = (reason: string): Decision => ({ decision: "deny", reason });
const ask = (reason: string): Decision => ({ decision: "ask", reason });

function normRel(p: string): string {
  const s = p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  return process.platform === "win32" ? s.toLowerCase() : s;
}

function isSecret(rel: string): boolean {
  const name = basename(rel);
  return SECRET.some((re) => re.test(name));
}

function isReadOnly(rel: string): boolean {
  const first = rel.split("/")[0]!;
  return READ_ONLY_DIRS.includes(first.toLowerCase());
}

function realRoot(root: string): string {
  return existsSync(root) ? realpathSync.native(root) : resolve(root);
}

/** Résout les liens symboliques/jonctions du plus proche parent existant. */
function resolveReal(abs: string): string {
  let current = resolve(abs);
  const rest: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return resolve(abs);
    rest.unshift(basename(current));
    current = parent;
  }
  return [realpathSync.native(current), ...rest].join(sep);
}
