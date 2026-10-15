import type { PlanOutput } from "@studio/contracts";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type Decision = { decision: "allow" | "deny" | "ask"; reason: string };
export type RunMode = "plan" | "execute" | "verify";

export type PolicyInput = {
  mode: RunMode;
  /** Racine du worktree de la tâche (seul endroit où l'agent travaille). */
  root: string;
  plan?: Pick<PlanOutput, "files_to_create" | "files_to_modify" | "files_to_delete" | "commands">;
  /**
   * Dossiers lisibles en plus de la copie (jamais modifiables) : le jeu lui-même, vers lequel pointent
   * les modules partagés (node_modules), et les captures du hub (ADR-33).
   */
  readable?: string[];
};

/** Nom du plugin qui porte les compétences fournies par le hub à un run. */
export const STUDIO_PLUGIN = "studio-skills";

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

/** Jamais permises, même via le plan ou une escalade : réseau, interpréteurs, Git en écriture. */
const FORBIDDEN_COMMANDS = [
  /^(curl|wget|ssh|scp|sftp|ftp|nc|ncat|telnet|iwr|irm|invoke-webrequest|invoke-restmethod|start-process)\b/i,
  /^(node|python3?|py|pwsh|powershell|bash|sh|zsh|cmd|deno|bun|ruby|perl|php)(\.exe)?\b/i,
  /^git (push|pull|fetch|remote|config|reset|clean|checkout|switch|rebase|merge|commit|tag|worktree|stash|submodule|update-ref|filter-branch|gc|add|rm|mv|restore|apply|am|cherry-pick|revert|branch -[dDmM])\b/i,
  /^(rm|del|rmdir|rd) .*(-r|-rf|-fr|\/s)\b/i,
  /^(sudo|runas|chmod|chown|icacls|takeown|reg|setx|format|diskpart|shutdown)\b/i,
  /^npx -y\b/i,
  // Liens : ils permettraient de sortir de la copie de travail.
  /^(ln|mklink|new-item|cp -s)\b/i,
  // Dépendances : node_modules est partagé avec votre projet (jonction) ; installer le modifierait.
  /^(npm|pnpm|yarn|bun) (i|install|ci|add|remove|rm|uninstall|un|update|up|upgrade|link|unlink|rebuild|prune|dedupe|publish|exec)\b/i,
];

/** Lecture seule, sans effet : toujours permis, seuls ou enchaînés (ADR-33). */
const READ_ONLY = /^(ls|dir|cat|head|tail|wc|grep|egrep|fgrep|rg|find|tree|pwd|echo|stat|file|du|sort|uniq|diff|cmp|which|where|type|basename|dirname|realpath|nl|cut|tr|column|true)$/i;
const GIT_READ = /^git (status|diff|log|show|grep|ls-files|ls-tree|blame|rev-parse|describe|shortlog|cat-file -p)\b/i;
/** Après un « | » : seulement des filtres sur le texte. */
const FILTERS = /^(grep|egrep|fgrep|findstr|head|tail|sort|uniq|wc|cut|tr|cat|nl|column|sed)$/i;
/** Options de find qui écrivent ou exécutent. */
const FIND_ACTIONS = /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/;
/** Scripts du projet qu'on ne lance jamais d'office, même s'ils existent. */
const RISKY_SCRIPT = /deploy|publish|release|push|upload|install|clean|reset/i;

const HEREDOC = "« <<EOF » interdit : pour écrire un fichier, utilise l'outil Write ou Edit";
const REDIRECT = "redirection vers un fichier interdite : pour écrire un fichier, utilise l'outil Write ou Edit (seules 2>&1 et >/dev/null sont permises)";
const SUBST = "substitutions et variables ($, `…`, parenthèses, accolades) interdites : écris la commande en clair";

type Segment = { words: string[]; text: string; piped: boolean };

/**
 * Découpe une commande en morceaux simples (séparés par ;, &&, || ou |), sans rien interpréter :
 * ce qui n'est pas analysable sûrement (substitutions, redirections vers un fichier) est refusé.
 */
export function splitCommand(cmd: string): { segments: Segment[] } | { error: string } {
  const segments: Segment[] = [];
  let words: string[] = [];
  let word = "";
  let inWord = false;
  let piped = false;
  let quote: '"' | "'" | null = null;
  const endWord = () => {
    if (inWord) words.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = (nextPiped: boolean): string | null => {
    endWord();
    if (words.length) segments.push({ words, text: words.join(" "), piped });
    else if (piped || nextPiped) return "tube « | » sans commande";
    words = [];
    piped = nextPiped;
    return null;
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "$" || c === "`") return { error: SUBST };
      else if (c === "\\" && /["\\$`]/.test(cmd[i + 1] ?? "")) word += cmd[++i];
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
      continue;
    }
    if (c === " " || c === "\t") {
      endWord();
      continue;
    }
    if (c === ";" || c === "\n" || c === "\r") {
      const err = endSegment(false);
      if (err) return { error: err };
      continue;
    }
    if (c === "&" || c === "|") {
      const double = cmd[i + 1] === c;
      if (c === "&" && !double) {
        const m = /^&>\s*(\/dev\/null|nul)(?![\w.])/i.exec(cmd.slice(i));
        if (!m) return { error: "commande en arrière-plan (&) interdite" };
        endWord();
        i += m[0].length - 1;
        continue;
      }
      if (double) i++;
      const err = endSegment(c === "|" && !double);
      if (err) return { error: err };
      continue;
    }
    if (c === "<" || c === ">" || (!inWord && /[12]/.test(c) && cmd[i + 1] === ">")) {
      if (cmd.startsWith("<<", i)) return { error: HEREDOC };
      // Vers nulle part ou fusion des sorties : sans effet sur les fichiers.
      const m = /^(?:[12]?>&[12]|[12]?>\s*(?:\/dev\/null|nul)(?![\w.]))/i.exec(cmd.slice(i));
      if (!m) return { error: REDIRECT };
      endWord();
      i += m[0].length - 1;
      continue;
    }
    if ("$`(){}".includes(c)) return { error: SUBST };
    word += c;
    inWord = true;
  }
  if (quote) return { error: "guillemet non fermé" };
  const err = endSegment(false);
  if (err) return { error: err };
  if (!segments.length) return { error: "commande vide" };
  return { segments };
}

/**
 * Politique d'exécution (docs/SECURITY.md §3) : décide pour CHAQUE action de l'agent.
 * allow = couvert par le plan ; deny = interdit ; ask = hors plan, on vous demande.
 * Pure et déterministe : testée unitairement, appelée par le hook et le gardien.
 */
export class PolicyEngine {
  readonly #mode: RunMode;
  readonly #root: string;
  readonly #readable: string[];
  readonly #writable: Set<string>;
  readonly #deletable: Set<string>;
  readonly #commands: Set<string>;

  constructor(input: PolicyInput) {
    this.#mode = input.mode;
    this.#root = realRoot(input.root);
    this.#readable = (input.readable ?? []).filter((p) => existsSync(p)).map(realRoot);
    const plan = input.plan ?? { files_to_create: [], files_to_modify: [], files_to_delete: [], commands: [] };
    this.#writable = new Set([...plan.files_to_create, ...plan.files_to_modify].map(normRel));
    this.#deletable = new Set(plan.files_to_delete.map(normRel));
    this.#commands = new Set(plan.commands.map((c) => c.cmd.trim()));
  }

  /** `cwd` : dossier courant du terminal de l'agent ; il persiste d'une commande à l'autre (ADR-38). */
  evaluate(tool: string, input: Record<string, unknown>, cwd?: string): Decision {
    // Compétences (ADR-29) : seulement celles que le hub a fournies, jamais les skills intégrées de Claude Code.
    if (tool === "Skill") {
      return String(input.skill ?? "").startsWith(`${STUDIO_PLUGIN}:`) ? allow("compétence du studio") : deny("seules les compétences du studio sont permises");
    }
    // Outil interne de Claude Code pour rendre la réponse au format --json-schema : aucun effet (constaté le 14/10/2026).
    if (tool === "StructuredOutput") return allow("rendu du résultat final");
    if (READ_TOOLS.has(tool)) return this.#read(tool, input);
    if (WRITE_TOOLS.has(tool)) return this.#write(tool, input);
    if (tool === "Bash") return this.#bash(String(input.command ?? ""), cwd);
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
    if (rel === null) {
      const shared = this.#relReadable(raw);
      if (shared === null) return deny(`lecture hors du projet : ${raw}`);
      if (isSecret(shared) || shared.split("/")[0] === ".git") return deny(`fichier sensible : ${raw}`);
      return allow("lecture dans le jeu (dossier partagé)");
    }
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

  /**
   * Une commande peut enchaîner plusieurs morceaux (;, &&, ||, |) : chacun est jugé seul (ADR-33).
   * Un refus l'emporte, puis une demande ; sinon la commande passe.
   */
  #bash(command: string, from?: string): Decision {
    const cmd = command.trim();
    if (!cmd) return deny("commande vide");
    // Commande prévue telle quelle dans le plan.
    if (this.#mode !== "plan" && this.#commands.has(cmd) && !commandProblem(cmd)) return allow("commande prévue dans le plan");
    const parsed = splitCommand(cmd);
    if ("error" in parsed) return deny(parsed.error);
    // Hors de la copie, Claude Code ramène le terminal à sa racine : on part alors de la racine.
    const start = from ? this.#relInside(unixDrive(from)) : null;
    let cwd = start ? join(this.#root, start) : this.#root;
    let moved = Boolean(start);
    const decisions: Decision[] = [];
    for (const s of parsed.segments) {
      if (/^cd$/i.test(s.words[0]!)) {
        const target = s.words[1];
        const rel = target && s.words.length === 2 ? this.#relInside(unixDrive(target), cwd) : null;
        if (rel === null) return deny(`« cd » hors du projet : ${s.text}`);
        cwd = join(this.#root, rel);
        moved = true;
        continue;
      }
      const d = this.#segment(s, cwd, moved);
      if (d.decision === "deny") return parsed.segments.length > 1 ? deny(`${d.reason} (dans « ${s.text} »)`) : d;
      decisions.push(d);
    }
    const asked = decisions.find((d) => d.decision === "ask");
    if (asked) return asked;
    return decisions.length === 1 ? decisions[0]! : allow(`commande composée de morceaux permis (${decisions.length})`);
  }

  #segment(s: Segment, cwd: string, moved: boolean): Decision {
    const [head, ...args] = s.words as [string, ...string[]];
    if (FORBIDDEN_COMMANDS.some((re) => re.test(s.text))) {
      if (/^(node|npm|npx|python3?|py)(\.exe)? (-v|--version)$/i.test(s.text)) return allow("version d'un outil");
      return deny("commande interdite (réseau, interpréteur, Git en écriture ou système)");
    }
    const sedReadOnly = /^sed$/i.test(head) && args.includes("-n") && !args.some((a) => /^(-i|--in-place)/.test(a));
    const pathProblem = this.#pathProblem(args, cwd);
    if (s.piped) {
      if (!FILTERS.test(head) || (/^sed$/i.test(head) && !sedReadOnly)) return deny(`après « | », seuls les filtres sont permis (grep, head, tail, sort, wc…), pas « ${head} »`);
      return pathProblem ? deny(pathProblem) : allow("filtre");
    }
    if (READ_ONLY.test(head) || sedReadOnly || GIT_READ.test(s.text) || /^git branch( (-a|-r|--list|--show-current))*$/i.test(s.text)) {
      if (/^find$/i.test(head) && args.some((a) => FIND_ACTIONS.test(a))) return deny("find ne peut ni exécuter ni supprimer (-exec, -delete…)");
      return pathProblem ? deny(pathProblem) : allow("lecture seule");
    }
    if (pathProblem) return deny(pathProblem);
    if (this.#mode !== "plan" && this.#commands.has(s.text)) return allow("commande prévue dans le plan");
    const script = this.#projectScript(s.words, cwd);
    if (script && this.#mode !== "plan") return allow(script);
    const del = /^(?:git )?rm ([\w\-./]+)$/.exec(s.text);
    if (del && this.#mode === "execute" && !moved) {
      const rel = this.#relInside(del[1]!);
      if (rel !== null && this.#deletable.has(rel) && !isReadOnly(rel) && !isSecret(rel)) return allow(`suppression prévue : ${rel}`);
    }
    if (this.#mode === "execute") return ask(`commande non prévue dans le plan : ${s.text}`);
    return deny(`commande non prévue pendant la phase « ${this.#mode} » : ${s.text}`);
  }

  /**
   * Scripts du projet (package.json) et outils installés dans node_modules/.bin : ce sont les
   * vérifications du jeu lui-même (tests, typecheck, simulation…), sans réseau ni installation.
   */
  #projectScript(words: string[], cwd: string): string | null {
    const [tool, a, b] = words;
    if (/^npm$/i.test(tool ?? "")) {
      const name = a === "test" || a === "t" ? "test" : a === "run" || a === "run-script" ? b : null;
      if (!name || RISKY_SCRIPT.test(name)) return null;
      const extra = words.slice(a === "test" || a === "t" ? 2 : 3);
      if (extra.length && extra[0] !== "--") return null;
      for (const dir of [cwd, this.#root]) {
        const scripts = readScripts(join(dir, "package.json"));
        if (scripts?.[name]) return `script du projet : npm ${name === "test" ? "test" : `run ${name}`}`;
      }
      return null;
    }
    if (/^npx$/i.test(tool ?? "") && a && /^[\w@][\w\-./@]*$/.test(a) && !a.startsWith("-")) {
      const bin = a.split("/").at(-1)!;
      for (const dir of [cwd, this.#root]) {
        if (["", ".cmd"].some((ext) => existsSync(join(dir, "node_modules", ".bin", bin + ext)))) return `outil du projet : npx ${bin}`;
      }
    }
    return null;
  }

  /** Un argument qui désigne un chemin hors de la copie (ou un secret) rend la commande dangereuse. */
  #pathProblem(args: string[], cwd: string): string | null {
    for (const raw of args) {
      const value = raw.startsWith("-") ? (raw.includes("=") ? raw.slice(raw.indexOf("=") + 1) : "") : raw;
      if (!value || !/[./\\]/.test(value)) continue;
      if (/^(\/dev\/null|nul)$/i.test(value)) continue;
      const path = unixDrive(value);
      if (isSecret(path.replace(/\\/g, "/"))) return `fichier sensible : ${value}`;
      const outsidey = isAbsolute(path) || /^~/.test(path) || /(^|[\\/])\.\.([\\/]|$)/.test(path);
      if (!outsidey) {
        if (normRel(path).split("/")[0] === ".git") return "dossier .git interdit";
        continue;
      }
      // Les motifs (*, ?) ne sont pas résolus : on juge le dossier qui les précède.
      const fixed = path.split(/[*?[]/)[0]!;
      const rel = this.#relInside(fixed, cwd);
      if (rel === null && this.#relReadable(fixed) === null) return `chemin hors du projet : ${value}`;
      if (rel !== null && rel.split("/")[0] === ".git") return "dossier .git interdit";
    }
    return null;
  }

  /** Chemin relatif normalisé (séparateur /), ou null s'il sort du worktree (liens compris). */
  #relInside(p: string, from = this.#root): string | null {
    const abs = resolveReal(isAbsolute(p) ? p : join(from, p));
    const rel = relative(this.#root, abs);
    if (rel === "") return "";
    if (rel.startsWith("..") || isAbsolute(rel)) return null;
    return normRel(rel);
  }

  /** Chemin relatif à un dossier lisible en plus de la copie, ou null. */
  #relReadable(p: string): string | null {
    if (!isAbsolute(p)) return null;
    const abs = resolveReal(p);
    for (const root of this.#readable) {
      const rel = relative(root, abs);
      if (rel === "" || !(rel.startsWith("..") || isAbsolute(rel))) return normRel(rel);
    }
    return null;
  }
}

/** Ce qui rend une commande irrecevable dans un plan, quelle que soit la phase. */
function commandProblem(cmd: string): string | null {
  const parsed = splitCommand(cmd);
  if ("error" in parsed) return parsed.error;
  for (const s of parsed.segments) {
    if (FORBIDDEN_COMMANDS.some((re) => re.test(s.text))) return "commande interdite (réseau, interpréteur, Git en écriture ou système)";
  }
  return null;
}

/** Chemin à la manière de Git Bash (/c/Games/…) → C:/Games/… */
function unixDrive(p: string): string {
  return p.replace(/^\/([a-zA-Z])(\/|$)/, "$1:/");
}

function readScripts(pkg: string): Record<string, string> | null {
  if (!existsSync(pkg)) return null;
  try {
    return (JSON.parse(readFileSync(pkg, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    return null;
  }
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
