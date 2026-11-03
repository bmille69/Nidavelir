import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative } from "node:path";

/**
 * Lecture de la bibliothèque de skills d'Hermes (ADR-97) : des dossiers `<catégorie>/<nom>/SKILL.md`,
 * avec leurs annexes (references/, templates/, scripts/…). Lecture seule : le hub n'y écrit jamais.
 */
export type HermesSkill = {
  /** Chemin relatif du dossier de la skill, ex. « software-development/systematic-debugging ». */
  origin: string;
  name: string;
  description: string;
  body: string;
  files: SkillFile[];
  /** Empreinte du SKILL.md et des annexes : une skill qui change est relue. */
  hash: string;
};

export type SkillFile = { path: string; content: string };

/** Annexes acceptées : texte seulement, rangées dans un sous-dossier connu, sans remontée. */
export const FILE_PATH = /^(references|templates|scripts|assets|examples)\/[A-Za-z0-9._/-]{1,120}$/;
const TEXT_EXT = /\.(md|txt|json|ya?ml|toml|py|gd|gdshader|glsl|ts|tsx|js|mjs|cjs|css|html|csv|sh|ps1)$/i;
export const MAX_FILE = 40_000;
export const MAX_FILES = 12;
export const MAX_FILES_TOTAL = 150_000;
const SKIP_DIRS = new Set(["node_modules", ".git", "__pycache__", ".venv", "dist"]);

/** Dossier des skills d'Hermes sur ce PC (STUDIO_HERMES_SKILLS le remplace ; vide le désactive). */
export function defaultHermesSkillsDir(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.STUDIO_HERMES_SKILLS !== undefined) return env.STUDIO_HERMES_SKILLS.trim() || null;
  const candidates = [env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "hermes", "skills") : null, join(homedir(), ".hermes", "skills")].filter(Boolean) as string[];
  return candidates.find((d) => existsSync(d)) ?? null;
}

export function safeFilePath(p: string): boolean {
  return FILE_PATH.test(p) && !p.split("/").some((part) => part === ".." || part === ".");
}

/** Toutes les skills trouvées sous `root` (trois niveaux au plus). */
export function scanHermesLibrary(root: string): HermesSkill[] {
  if (!existsSync(root)) return [];
  const out: HermesSkill[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    if (entries.includes("SKILL.md")) {
      const skill = readSkill(root, dir);
      if (skill) out.push(skill);
      return;
    }
    if (depth >= 3) return;
    for (const e of entries) {
      if (SKIP_DIRS.has(e) || e.startsWith(".")) continue;
      const p = join(dir, e);
      if (isDir(p)) walk(p, depth + 1);
    }
  };
  walk(root, 0);
  return out.sort((a, b) => a.origin.localeCompare(b.origin));
}

function readSkill(root: string, dir: string): HermesSkill | null {
  const raw = readFileSync(join(dir, "SKILL.md"), "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const { front, body } = splitFrontmatter(raw);
  const origin = relative(root, dir).replace(/\\/g, "/");
  const name = (front.name ?? origin.split("/").at(-1) ?? "").trim();
  if (!name || !body.trim()) return null;
  const files: SkillFile[] = [];
  let total = 0;
  const walk = (d: string) => {
    for (const e of safeList(d)) {
      if (SKIP_DIRS.has(e) || e.startsWith(".")) continue;
      const p = join(d, e);
      if (isDir(p)) {
        walk(p);
        continue;
      }
      const rel = relative(dir, p).replace(/\\/g, "/");
      if (rel === "SKILL.md" || !safeFilePath(rel) || !TEXT_EXT.test(rel)) continue;
      if (files.length >= MAX_FILES) return;
      const size = statSync(p).size;
      if (size > MAX_FILE || total + size > MAX_FILES_TOTAL) continue;
      files.push({ path: rel, content: readFileSync(p, "utf8") });
      total += size;
    }
  };
  walk(dir);
  files.sort((a, b) => a.path.localeCompare(b.path));
  const hash = createHash("sha256").update(raw);
  for (const f of files) hash.update(`\0${f.path}\0${f.content}`);
  return { origin, name, description: (front.description ?? "").trim(), body: body.trim(), files, hash: hash.digest("hex").slice(0, 32) };
}

/** En-tête YAML simple : `clé: valeur`, valeur entre guillemets ou non, `>`/`|` sur plusieurs lignes. */
export function splitFrontmatter(raw: string): { front: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (!m) return { front: {}, body: raw };
  const front: Record<string, string> = {};
  const lines = m[1]!.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    let value = kv[2]!.trim();
    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1]!)) parts.push(lines[++i]!.trim());
      value = parts.join(" ");
    } else if (/^["'].*["']$/.test(value)) {
      value = value.startsWith('"') ? safeJson(value) : value.slice(1, -1).replace(/''/g, "'");
    }
    front[kv[1]!] = value;
  }
  return { front, body: raw.slice(m[0].length) };
}

function safeJson(v: string): string {
  try {
    return String(JSON.parse(v));
  } catch {
    return v.slice(1, -1);
  }
}

function safeList(d: string): string[] {
  try {
    return readdirSync(d);
  } catch {
    return [];
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}
