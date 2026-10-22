import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { GameRecipe } from "./recipes.ts";

/** Ce que le hub a posé dans le jeu pour un mod : chemins relatifs au dossier du jeu, et leur empreinte. */
export type Installed = { files: { path: string; sha256: string }[]; at: string; build: string };

const sha = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** Le dossier des mods du jeu, vérifié : réel, à l'intérieur du jeu, jamais ailleurs. */
export function modsDir(r: GameRecipe, gameDir: string): string {
  const game = realpathSync(gameDir);
  const dir = resolve(game, r.modsDir);
  if (dir !== game && !dir.startsWith(game + sep)) throw new Error("Dossier des mods hors du jeu : refusé");
  mkdirSync(dir, { recursive: true });
  const real = realpathSync(dir);
  if (!real.startsWith(game + sep)) throw new Error("Le dossier des mods pointe hors du jeu : refusé");
  return real;
}

/**
 * Pose les fichiers du mod (la DLL, et son dossier d'images s'il en a) dans le dossier des mods du jeu, sur votre clic.
 * Rien d'autre n'est touché ; un fichier d'un autre mod au même nom n'est jamais écrasé.
 */
export function install(r: GameRecipe, gameDir: string, files: { from: string; to: string }[], build: string, previous: Installed | null): Installed {
  const target = modsDir(r, gameDir);
  const game = realpathSync(gameDir);
  const ours = new Set(previous?.files.map((f) => f.path) ?? []);
  const placed: Installed["files"] = [];
  for (const f of files) {
    if (!existsSync(f.from)) throw new Error(`Fichier du mod introuvable : ${basename(f.from)}`);
    const dest = resolve(target, f.to);
    if (!dest.startsWith(target + sep)) throw new Error(`Chemin refusé : ${f.to}`);
    const rel = relative(game, dest).replace(/\\/g, "/");
    if (existsSync(dest) && !ours.has(rel)) throw new Error(`« ${f.to} » existe déjà dans le dossier des mods (un autre mod ?) : rien n'est écrasé`);
    mkdirSync(dirname(dest), { recursive: true });
    cpSync(f.from, dest);
    placed.push({ path: rel, sha256: sha(dest) });
  }
  // Ce que l'ancienne version avait posé et que la nouvelle ne pose plus.
  for (const old of previous?.files ?? []) if (!placed.some((p) => p.path === old.path)) rmSync(join(game, old.path), { force: true });
  return { files: placed, at: new Date().toISOString(), build };
}

/** Retire exactement ce que le hub a posé ; un fichier modifié depuis (par vous) est laissé et signalé. */
export function uninstall(gameDir: string, installed: Installed): { removed: string[]; kept: string[] } {
  const game = realpathSync(gameDir);
  const removed: string[] = [];
  const kept: string[] = [];
  for (const f of installed.files) {
    const p = resolve(game, f.path);
    if (!p.startsWith(game + sep)) continue;
    if (!existsSync(p)) continue;
    if (sha(p) !== f.sha256) {
      kept.push(f.path);
      continue;
    }
    rmSync(p, { force: true });
    removed.push(f.path);
    // Les dossiers devenus vides que le mod avait créés.
    let d = dirname(p);
    while (d.startsWith(game + sep) && existsSync(d) && readdirSync(d).length === 0 && basename(d) !== "Mods") {
      rmSync(d, { recursive: true, force: true });
      d = dirname(d);
    }
  }
  return { removed, kept };
}

/** Les dossiers de sauvegarde d'une recette, motifs résolus (%APPDATA%, %USERPROFILE%, et « * » en fin de nom). */
export function saveDirs(r: GameRecipe, env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  for (const raw of r.saves) {
    const p = raw.replace(/%(\w+)%/g, (_, k: string) => env[k] ?? env[k.toUpperCase()] ?? "").replace(/\//g, sep);
    if (!p || p.startsWith("%")) continue;
    if (p.endsWith("*")) {
      const parent = dirname(p);
      const prefix = basename(p).slice(0, -1);
      if (existsSync(parent)) for (const e of readdirSync(parent)) if (e.startsWith(prefix) && statSync(join(parent, e)).isDirectory()) out.push(join(parent, e));
    } else if (existsSync(p)) out.push(p);
  }
  return out;
}

/** Copie les sauvegardes à l'abri (sans les journaux) ; renvoie le dossier de la copie, ou null s'il n'y avait rien. */
export function backupSaves(r: GameRecipe, dest: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const dirs = saveDirs(r, env);
  if (!dirs.length) return null;
  mkdirSync(dest, { recursive: true });
  for (const d of dirs) cpSync(d, join(dest, basename(d)), { recursive: true, filter: (src) => !/\.log$/i.test(src) });
  return dest;
}

/** Ce que le journal du chargeur dit d'un mod après une partie. */
export type LogReport = { found: boolean; loaded: boolean; lines: string[]; errors: string[]; gameVersion: string | null };

/**
 * Lit le journal de MelonLoader : le mod a-t-il été chargé, ses messages, et les erreurs qui le concernent (exception
 * avec une ligne de pile dans le mod, ou message d'erreur à son nom).
 */
export function readLog(file: string, mod: string): LogReport {
  if (!existsSync(file)) return { found: false, loaded: false, lines: [], errors: [], gameVersion: null };
  const text = readFileSync(file, "utf8");
  const all = text.split(/\r?\n/);
  const tag = new RegExp(`\\[${mod}\\]`, "i");
  const lines = all.filter((l) => tag.test(l)).map((l) => l.trim()).slice(-60);
  const loaded = new RegExp(`${mod}\\s+v?[\\d.]+`, "i").test(text) || lines.length > 0;
  const errors: string[] = [];
  for (let i = 0; i < all.length; i++) {
    const l = all[i]!;
    if (!/(error|exception|failed)/i.test(l)) continue;
    // Le bloc de l'erreur : sa ligne, puis la pile (lignes en retrait ou noms d'exception), jamais l'entrée suivante.
    let end = i + 1;
    while (end < all.length && end < i + 20 && (/^\s+\S/.test(all[end]!) || /^[\w.]+(Exception|Error)\b/.test(all[end]!))) end++;
    const block = all.slice(i, end).join("\n");
    if (new RegExp(`\\b${mod}\\b`).test(block)) errors.push(block.trim().slice(0, 1500));
    if (errors.length >= 6) break;
  }
  const gameVersion = /Game Version:\s*([^\r\n]+)/i.exec(text)?.[1]?.trim() ?? null;
  return { found: true, loaded, lines, errors: [...new Set(errors)], gameVersion };
}
