import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Godot dans le studio (ADR-73) : le hub trouve le Godot installé sur le PC, le donne aux agents sous le nom « godot »,
 * et pose dans chaque jeu Godot deux outils qui lui appartiennent : le relais du testeur (addons/studio_bridge) et le
 * lanceur de tests (addons/studio_tests).
 */

/** Les commandes que les agents connaissent (CLAUDE.md, plan, consignes). */
export const GODOT_IMPORT = "godot --headless --path . --import";
export const GODOT_TESTS = "godot --headless --path . -s res://addons/studio_tests/run.gd";
export const STUDIO_ADDONS = ["studio_bridge", "studio_tests"] as const;
export const BRIDGE_AUTOLOAD = 'StudioBridge="*res://addons/studio_bridge/bridge.gd"';

const ADDONS_SRC = fileURLToPath(new URL("./addons", import.meta.url));

export const isGodot = (root: string): boolean => existsSync(join(root, "project.godot"));

/** Le jeu a les outils du studio : tests et relais. */
export const hasStudioTests = (root: string): boolean => existsSync(join(root, "addons", "studio_tests", "run.gd"));
export const hasBridge = (root: string): boolean => existsSync(join(root, "addons", "studio_bridge", "bridge.gd")) && /StudioBridge=/.test(readProject(root));

function readProject(root: string): string {
  try {
    return readFileSync(join(root, "project.godot"), "utf8");
  } catch {
    return "";
  }
}

export type GodotInstall = { exe: string; version: string; mono: boolean };

/** « Godot_v4.6.2-stable_win64.exe » → 4.6.2 ; « …_mono_win64.exe » : version C#. */
function parseName(file: string): { version: string; mono: boolean } | null {
  const m = /^Godot_v(\d+\.\d+(?:\.\d+)?)-stable(_mono)?_win64(?:_console)?\.exe$/i.exec(file);
  return m ? { version: m[1]!, mono: !!m[2] } : null;
}

const newer = (a: string, b: string) => {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
};

/**
 * Cherche Godot : la variable STUDIO_GODOT, sinon le bureau, les téléchargements et les dossiers d'installation
 * habituels (deux niveaux). La version la plus récente l'emporte ; la version console n'est prise qu'à défaut.
 */
export function findGodot(extraDirs: string[] = []): GodotInstall | null {
  return godotInstalls(extraDirs)[0] ?? null;
}

/**
 * Tous les Godot trouvés (ADR-120 : un projet démonté exige souvent une version précise, Mono de préférence),
 * la version la plus récente d'abord ; à version égale, l'exécutable normal avant la console.
 */
export function godotInstalls(extraDirs: string[] = []): GodotInstall[] {
  const forced = process.env.STUDIO_GODOT;
  if (forced && existsSync(forced)) {
    const n = parseName(forced.split(/[\\/]/).pop()!);
    return [{ exe: forced, version: n?.version ?? "?", mono: n?.mono ?? false }];
  }
  const home = homedir();
  const dirs = [
    ...extraDirs,
    join(home, "Desktop"),
    join(home, "OneDrive", "Desktop"),
    join(home, "OneDrive", "Bureau"),
    join(home, "Downloads"),
    join(home, "AppData", "Local", "Programs"),
    "C:\\Program Files",
    "C:\\Godot",
    "C:\\Games",
  ];
  const found: (GodotInstall & { console: boolean })[] = [];
  const consider = (dir: string, depth: number, anyDir = false) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isFile()) {
        const n = parseName(e.name);
        if (!n) continue;
        found.push({ exe: join(dir, e.name), ...n, console: /_console\.exe$/i.test(e.name) });
      } else if (e.isDirectory() && depth > 0 && (anyDir || /godot/i.test(e.name))) consider(join(dir, e.name), depth - 1, anyDir);
    }
  };
  // Les dossiers du hub (ADR-120) ont une forme connue (`editors/4.5.1-mono/Godot_v…/Godot_v….exe`) : on y descend
  // sans filtrer sur le nom. Ailleurs (Bureau, Program Files), seuls les dossiers « godot » sont ouverts.
  for (const d of extraDirs) consider(d, 3, true);
  for (const d of dirs.slice(extraDirs.length)) consider(d, 2);
  // Dédoublonne par exécutable, la version la plus récente d'abord, l'exécutable normal avant la console.
  const seen = new Set<string>();
  const unique = found.filter((i) => (seen.has(i.exe) ? false : (seen.add(i.exe), true)));
  unique.sort((a, b) => (a.version === b.version ? Number(a.console) - Number(b.console) : newer(a.version, b.version) ? -1 : 1));
  return unique.map(({ console: _, ...i }) => i);
}

/**
 * Le dossier à mettre en tête du PATH des agents : « godot » y lance le Godot trouvé (script pour le terminal Git Bash
 * de Claude Code, .cmd pour Windows). Réécrit si Godot a changé de place.
 */
export function godotShim(dataDir: string, exe: string): string {
  const bin = join(dataDir, "tools", "godot", "bin");
  mkdirSync(bin, { recursive: true });
  const unix = exe.replace(/^([A-Za-z]):/, (_, d: string) => `/${d.toLowerCase()}`).replace(/\\/g, "/");
  const sh = `#!/bin/sh\n# Posé par le hub (ADR-73) : le Godot du PC.\nexec "${unix}" "$@"\n`;
  const cmd = `@echo off\r\nrem Posé par le hub (ADR-73) : le Godot du PC.\r\n"${exe}" %*\r\n`;
  const write = (file: string, text: string) => {
    if (!existsSync(file) || readFileSync(file, "utf8") !== text) writeFileSync(file, text, { mode: 0o755 });
  };
  write(join(bin, "godot"), sh);
  write(join(bin, "godot.cmd"), cmd);
  return bin;
}

/** Version rapportée par l'exécutable lui-même (« 4.6.2.stable.official… » → « 4.6.2 »). */
export function godotVersion(exe: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(exe, ["--version"], { windowsHide: true, timeout: 30_000 }, (err, out) => resolve(err ? null : (/^(\d+\.\d+(?:\.\d+)?)/.exec(out.trim())?.[1] ?? null)));
  });
}

/**
 * Pose (ou remet à jour) les outils du studio dans un jeu Godot : addons/studio_bridge, addons/studio_tests, et
 * l'autoload du relais dans project.godot. Rend les fichiers changés (vide : déjà à jour).
 */
export function installStudioAddons(root: string): string[] {
  const changed: string[] = [];
  for (const name of STUDIO_ADDONS) {
    const src = join(ADDONS_SRC, name);
    for (const f of readdirSync(src)) {
      const to = join(root, "addons", name, f);
      const body = readFileSync(join(src, f));
      if (existsSync(to) && readFileSync(to).equals(body)) continue;
      mkdirSync(join(root, "addons", name), { recursive: true });
      cpSync(join(src, f), to);
      changed.push(`addons/${name}/${f}`);
    }
  }
  const project = readProject(root);
  if (project && !/StudioBridge=/.test(project)) {
    const next = /^\[autoload\]\s*$/m.test(project)
      ? project.replace(/^\[autoload\]\s*$/m, `[autoload]\n\n${BRIDGE_AUTOLOAD}`)
      : `${project.trimEnd()}\n\n[autoload]\n\n${BRIDGE_AUTOLOAD}\n`;
    writeFileSync(join(root, "project.godot"), next, "utf8");
    changed.push("project.godot");
  }
  return changed;
}

/**
 * Le Godot du PC, cherché au plus une fois par minute. Quand il est trouvé (ou a changé de place), « godot » est reposé
 * pour les agents et mis en tête du PATH du hub : les agents l'héritent.
 */
export function godotLocator(dataDir: string, ttlMs = 60_000): () => GodotInstall | null {
  let cached: GodotInstall | null = null;
  let at = 0;
  return () => {
    if (Date.now() - at < ttlMs && (!cached || existsSync(cached.exe))) return cached;
    at = Date.now();
    cached = findGodot();
    if (cached) {
      const bin = godotShim(dataDir, cached.exe);
      const path = process.env.PATH ?? "";
      if (!path.split(";").includes(bin)) process.env.PATH = `${bin};${path}`;
    }
    return cached;
  };
}

/** Âge du fichier, pour savoir si le cache d'import d'une copie est plus vieux que le projet. */
export function mtime(file: string): number {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}
