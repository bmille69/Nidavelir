import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { godotErrors } from "../godot/run.ts";
import type { GodotInstall } from "../godot/toolchain.ts";
import { applyRepairs, planRepairs, type Repair } from "./rebuild.ts";

/**
 * « Le projet jouable » (ADR-120) : un démontage n'est réussi que si le projet récupéré s'ouvre, se recompile et
 * démarre. On mesure, on recrée ce qui manque (rebuild.ts), on remesure — jusqu'à trois tours.
 */

export type Missing = {
  kind: "script" | "scene" | "resource" | "native";
  /** Chemin relatif au projet (`src/Core/NGame.cs`). */
  path: string;
  /** La ligne de Godot qui l'a signalé. */
  detail: string;
};

export type Requirements = {
  /** Version de Godot annoncée par le projet (« 4.5 »), telle que `config/features`. */
  version: string | null;
  /** Le projet contient du C# : il faut le Godot .NET (Mono). */
  mono: boolean;
  /** Nom de l'assemblage attendu (`project/assembly_name`). */
  assembly: string | null;
  mainScene: string | null;
  csproj: string | null;
};

export type Round = { imported: boolean; built: boolean; ran: boolean; code: number | null; errors: number; note: string };

export type LaunchReport = {
  /** `playable` : démarre sans erreur ; `partiel` : démarre avec des réserves ; `echec` : ne démarre pas ;
   *  `outil` : il manque un outil (le bon Godot, .NET) — rien n'a été mesuré. */
  verdict: "playable" | "partiel" | "echec" | "outil";
  reason: string;
  need: { version: string | null; mono: boolean } | null;
  editor: { exe: string; version: string; mono: boolean } | null;
  rounds: Round[];
  repairs: Repair[];
  missing: Missing[];
  seconds: number;
  at: string;
};

export type Exec = (exe: string, args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<{ code: number | null; log: string; timedOut: boolean }>;

/** Ouvre un programme en fenêtre, détaché du hub : il survit à un redémarrage et le hub n'attend pas qu'il se ferme (ADR-127). */
export type Opener = (exe: string, args: string[], cwd: string) => void;

export const openDetached: Opener = (exe, args, cwd) => {
  const child = spawn(exe, args, { cwd, detached: true, stdio: "ignore", windowsHide: false });
  child.on("error", () => {
    /* l'éditeur introuvable est vérifié avant ; rien d'autre à faire ici */
  });
  child.unref();
};

export const execRun: Exec = (exe, args, opts) =>
  new Promise((resolve) => {
    const child = execFile(exe, args, { cwd: opts.cwd, windowsHide: true, timeout: opts.timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
      resolve({ code: e ? (typeof e.code === "number" ? e.code : null) : 0, log: `${stdout}\n${stderr}`, timedOut: !!e?.killed });
    });
    void child;
  });

const ANSI = /\x1b\[[0-9;]*m/g;

/** Ce que le projet récupéré exige pour s'ouvrir : version de Godot, C# ou non, assemblage, scène principale. */
export function requirements(dir: string): Requirements {
  let text = "";
  try {
    text = readFileSync(join(dir, "project.godot"), "utf8");
  } catch {
    /* projet sans project.godot : tout est inconnu */
  }
  const features = /^config\/features=PackedStringArray\((.*)\)\s*$/m.exec(text)?.[1] ?? "";
  const list = [...features.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
  // `config/features` donne « 4.5 » ; le SDK du .csproj donne « 4.5.1 » : le plus précis des deux gagne, sinon un
  // Godot 4.5.1 installé ne correspondrait jamais au projet et le hub le réinstallerait sans fin.
  const short = list.find((f) => /^\d+\.\d+/.test(f)) ?? null;
  const exact = csprojVersion(dir);
  const version = short && exact && exact.startsWith(`${short}.`) ? exact : (short ?? exact);
  const mono = list.some((f) => /^C#$/.test(f)) || /^\[dotnet\]/m.test(text);
  const assembly = /^project\/assembly_name="([^"]*)"/m.exec(text)?.[1] ?? null;
  const mainScene = /^run\/main_scene="res:\/\/([^"]*)"/m.exec(text)?.[1] ?? null;
  let csproj: string | null = null;
  try {
    const found = readdirSync(dir).find((f) => f.toLowerCase().endsWith(".csproj"));
    if (found) csproj = join(dir, found);
  } catch {
    /* dossier illisible */
  }
  return { version, mono, assembly, mainScene, csproj };
}

const pathOf = (res: string) => res.replace(/^res:\/\//, "").replace(/^\//, "");

/**
 * La version que le projet cible, quand `config/features` ne la dit pas : le SDK du `.csproj`
 * (`<Project Sdk="Godot.NET.Sdk/4.5.1">`). C'est souvent la seule trace qui reste d'un projet reconstruit.
 */
function csprojVersion(dir: string): string | null {
  try {
    const file = readdirSync(dir).find((f) => f.toLowerCase().endsWith(".csproj"));
    if (!file) return null;
    const text = readFileSync(join(dir, file), "utf8");
    return /Godot\.NET\.Sdk\/(\d+\.\d+(?:\.\d+)?)/.exec(text)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Les fichiers que Godot réclame et qui ne sont pas là (ou vides). Deux formes observées sur un vrai jeu Godot C# :
 *   ERROR: No loader found for resource: res://src/Core/NGame.cs (expected type: Script)
 *   ERROR: res://scenes/game.tscn - Parse Error: [ext_resource] referenced non-existent resource at: res://src/Core/NGame.cs
 */
export function missingFromLog(log: string, dir: string): Missing[] {
  const out: Missing[] = [];
  const seen = new Set<string>();
  const add = (m: Missing) => {
    const key = `${m.kind}:${m.path.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(m);
  };
  const size = (p: string) => {
    try {
      return statSync(join(dir, p)).size;
    } catch {
      return -1;
    }
  };
  /** Un fichier présent et non vide n'est pas « manquant », même si Godot n'arrive pas à le charger. */
  const trulyMissing = (p: string) => size(p) < 32 || size(p) < 0;
  for (const raw of log.replace(ANSI, "").split(/\r?\n/)) {
    const line = raw.trim();
    let m = /^ERROR: No loader found for resource: res:\/\/(.+?) \(expected type: ([^)]+)\)$/.exec(line);
    if (m) {
      const p = m[1]!;
      if (trulyMissing(p)) add({ kind: kindOf(p, m[2]!), path: p, detail: line });
      continue;
    }
    m = /referenced non-existent resource at: res:\/\/(.+)$/.exec(line);
    if (m) {
      const p = m[1]!.trim();
      if (trulyMissing(p)) add({ kind: kindOf(p, ""), path: p, detail: line });
      continue;
    }
    m = /^ERROR: Cannot instantiate C# script because the associated class could not be found\. Script: 'res:\/\/(.+?)'/.exec(line);
    if (m) {
      const p = m[1]!.trim();
      if (trulyMissing(p)) add({ kind: "script", path: p, detail: line });
      continue;
    }
    m = /^ERROR: (?:Cannot open file|Failed loading resource|Error opening file)[: ]+["']?res:\/\/([^"']+?)["']?\.?$/i.exec(line);
    if (m) {
      const p = m[1]!.trim();
      if (trulyMissing(p)) add({ kind: kindOf(p, ""), path: p, detail: line });
    }
  }
  return out.slice(0, 400);
}

function kindOf(path: string, expected: string): Missing["kind"] {
  const ext = extname(path).toLowerCase();
  if (ext === ".cs" || ext === ".gd" || /script/i.test(expected)) return "script";
  if (ext === ".tscn" || ext === ".scn") return "scene";
  if (ext === ".dll" || ext === ".so" || ext === ".dylib") return "native";
  return "resource";
}

/** Le Godot qui correspond au projet, parmi ceux installés sur le PC et ceux du hub. Sinon, ce qu'il faut installer. */
export function pickEditor(req: Requirements, installs: GodotInstall[]): { editor: GodotInstall | null; reason: string } {
  const same = (v: string) => installs.filter((i) => i.version === v || i.version.startsWith(`${v}.`));
  if (req.version) {
    const exact = same(req.version).filter((i) => !req.mono || i.mono);
    if (exact.length) return { editor: exact[0]!, reason: "" };
    const other = same(req.version)[0];
    if (other && req.mono) return { editor: null, reason: `Ce projet contient du C# : il faut Godot ${req.version} en version .NET (Mono), pas la version standard.` };
    const near = installs.filter((i) => !req.mono || i.mono).sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
    if (near) return { editor: near, reason: `Le projet annonce Godot ${req.version} ; Godot ${near.version} est installé. Il peut convertir le projet (format plus récent), ce qui s'éloigne de l'original.` };
    return { editor: null, reason: `Il manque Godot ${req.version}${req.mono ? " (Mono)" : ""}.` };
  }
  const any = installs.filter((i) => !req.mono || i.mono).sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
  return any ? { editor: any, reason: "" } : { editor: null, reason: `Il manque un Godot${req.mono ? " .NET (Mono)" : ""}.` };
}

const CS_ERROR = /error CS(\d+)/;

/**
 * Importe, recompile et lance le projet récupéré, en recréant au passage ce qui manque (au plus `rounds` fois).
 * Ne touche jamais au jeu installé : tout se passe dans la copie du démontage.
 */
export async function verifyProject(input: {
  dir: string;
  editor: GodotInstall;
  /** Le dossier du jeu installé, d'où l'on recopie les bibliothèques natives que le paquet ne contient pas. */
  game?: string;
  rounds?: number;
  dotnet?: string;
  exec?: Exec;
  log?: (line: string) => void;
  now?: () => Date;
  frames?: number;
}): Promise<LaunchReport> {
  const started = Date.now();
  const exec = input.exec ?? execRun;
  const log = input.log ?? (() => {});
  const dotnet = input.dotnet ?? "dotnet";
  const frames = input.frames ?? 240;
  const max = input.rounds ?? 3;
  const req = requirements(input.dir);
  const rounds: Round[] = [];
  const repairs: Repair[] = [];
  let missing: Missing[] = [];
  let lastLog = "";
  let ran = false;
  let code: number | null = null;

  const report = (verdict: LaunchReport["verdict"], reason: string): LaunchReport => {
    // Sans scène principale, Godot s'ouvre et sort proprement sans rien afficher : ce n'est pas « jouable ».
    if (verdict === "playable" && !req.mainScene) {
      verdict = "partiel";
      reason = "Godot compile et se lance, mais le projet ne déclare aucune scène principale : rien ne s'afficherait. La scène de départ manque.";
    }
    return {
      verdict,
      reason,
      need: { version: req.version, mono: req.mono },
      editor: input.editor,
      rounds,
      repairs,
      missing,
      seconds: Math.round((Date.now() - started) / 1000),
      at: (input.now ?? (() => new Date()))().toISOString(),
    };
  };

  // Les bibliothèques natives (FMOD, Sentry…) ne sont pas dans le paquet : on les recopie depuis le jeu installé
  // avant le premier import, sinon Godot échoue sur les `.gdextension` du projet.
  const natives = planRepairs(input.dir, [], input.game);
  if (natives.length) {
    const written = applyRepairs(input.dir, natives);
    repairs.push(...written);
    if (written.length) log(`Bibliothèques natives recopiées : ${written.map((r) => r.file).join(", ")}.`);
  }

  for (let round = 1; round <= max; round++) {
    // 1. Importer (le cache .godot : sans lui, rien ne se charge).
    const imported = await exec(input.editor.exe, ["--headless", "--path", input.dir, "--import"], { cwd: input.dir, timeoutMs: 10 * 60_000 });
    // 2. Recompiler le C# s'il y en a.
    let built = true;
    let buildLog = "";
    if (req.csproj) {
      const b = await exec(dotnet, ["build", req.csproj, "-v", "q", "-nologo"], { cwd: input.dir, timeoutMs: 10 * 60_000 });
      built = b.code === 0;
      buildLog = b.log;
      log(`Compilation C# : ${built ? "réussie" : "échec"}${built ? "" : ` (${csErrors(b.log).length} erreurs)`}`);
    }
    // 3. Lancer sans fenêtre : le jeu doit charger sa scène principale et tourner quelques images.
    const run = await exec(input.editor.exe, ["--headless", "--path", input.dir, "--quit-after", String(frames)], { cwd: input.dir, timeoutMs: 5 * 60_000 });
    // Les erreurs de l'import viennent du contexte éditeur (extensions, plugins d'export) : elles ne disent rien du
    // jeu qui tourne. Seul le lancement décide du verdict ; l'import ne sert qu'à repérer des fichiers réclamés.
    lastLog = `${run.log}\n${buildLog}`;
    const runErrs = realErrors(run.log);
    const importErrs = realErrors(imported.log);
    const missingRun = missingFromLog(run.log, input.dir);
    missing = missingRun.length ? missingRun : missingFromLog(imported.log, input.dir);
    ran = !run.timedOut;
    code = run.code;
    const cs = csErrors(buildLog);
    const errors = runErrs.length + cs.length;
    rounds.push({
      imported: importErrs.length === 0,
      built,
      ran,
      code,
      errors,
      note: missing.length ? `${missing.length} fichier(s) réclamé(s) par le jeu` : importErrs.length ? `l'import a signalé ${importErrs.length} erreur(s) d'éditeur` : "",
    });
    log(`Tour ${round} : import ${rounds.at(-1)!.imported ? "ok" : "avec erreurs"}, compilation ${built ? "ok" : "échec"}, lancement ${ran ? `code ${code}` : "interrompu"}, ${errors} erreur(s).`);
    if (!missing.length && built && ran && code === 0 && errors === 0) return report("playable", "Le jeu démarre et tourne sans erreur.");
    if (missing.length) {
      const planned = planRepairs(input.dir, missing, input.game);
      if (planned.length) {
        const written = applyRepairs(input.dir, planned);
        repairs.push(...written);
        log(`Reconstruction : ${written.length} fichier(s) recréé(s) — ${written.map((r) => r.file).slice(0, 6).join(", ")}${written.length > 6 ? "…" : ""}.`);
        continue;
      }
    }
    break;
  }

  // Plus rien à recréer : on dit précisément où ça bloque. Godot sort parfois avec le code 0 en n'ayant rien
  // affiché (scène illisible) : ce n'est pas un démarrage, d'où le tri des erreurs fatales.
  const errs = realErrors(lastLog);
  const cs = csErrors(lastLog);
  const fatals = [...errs, ...cs].filter(isFatal);
  if (fatals.length) return report("echec", `Le jeu ne démarre pas : ${fatals.slice(0, 4).join(" | ")}`);
  if (ran && code === 0 && errs.length === 0 && cs.length === 0) return report("partiel", "Le jeu démarre ; les fichiers recréés restent des approximations à vérifier en jouant.");
  if (ran && code === 0) return report("partiel", `Le jeu démarre, mais ${errs.length + cs.length} erreur(s) subsistent : ${[...cs, ...errs].slice(0, 3).join(" | ")}`);
  return report("echec", ran ? `Le jeu s'est arrêté avec le code ${code}.` : "Le lancement ne s'est pas terminé à temps.");
}

/**
 * Godot gémit en quittant sur les ressources qu'il libère (« RID allocations of type … were leaked at exit »).
 * Ce bruit de sortie n'est pas une erreur du jeu : le compter ferait passer tout lancement réussi pour un échec.
 */
const BENIGN = /leaked at exit|ObjectDB instances leaked|RID allocations|resources still in use at exit/i;
const realErrors = (log: string) => godotErrors(log).filter((l) => !BENIGN.test(l));

/** Les erreurs qui empêchent vraiment de jouer, même quand Godot sort avec le code 0. */
const FATAL = /Failed to load scene|Cannot open file|No loader found|Parse Error|referenced non-existent|Cannot instantiate|Failed to load resource|SCRIPT ERROR|error CS/i;
const isFatal = (line: string) => FATAL.test(line);

export function csErrors(log: string): string[] {
  return log
    .split(/\r?\n/)
    .filter((l) => CS_ERROR.test(l))
    .map((l) => l.trim().replace(/^.*?(error CS\d+:)/, "$1").slice(0, 300))
    .slice(0, 20);
}

/** Le rapport en clair, à côté du jeu démonté (`lancement.md`), et sa forme machine (`lancement.json`). */
export function launchMarkdown(name: string, r: LaunchReport): string {
  const verdict = r.verdict === "playable" ? "Démarre" : r.verdict === "partiel" ? "Démarre, avec des réserves" : r.verdict === "outil" ? "Bloqué : outil manquant" : "Ne démarre pas";
  const lines = [`# Lancer ${name}`, "", `**${verdict}.** ${r.reason}`, ""];
  if (r.editor) lines.push(`Godot utilisé : ${r.editor.version}${r.editor.mono ? " (Mono)" : ""} — \`${r.editor.exe}\``, "");
  else if (r.need) lines.push(`Godot nécessaire : ${r.need.version ?? "?"}${r.need.mono ? " (Mono)" : ""}`, "");
  if (r.rounds.length) {
    lines.push("## Les essais", "", "| Tour | Import (éditeur) | Compilation C# | Lancement | Erreurs du jeu |", "|---|---|---|---|---|");
    r.rounds.forEach((x, i) => lines.push(`| ${i + 1} | ${x.imported ? "ok" : "erreurs"} | ${x.built ? "ok" : "échec"} | ${x.ran ? `code ${x.code}` : "interrompu"} | ${x.errors} |`));
    lines.push("");
    // L'import tourne dans l'éditeur : ses erreurs (plugins d'export, extensions) ne disent rien du jeu.
    const notes = r.rounds.map((x) => x.note).filter(Boolean);
    if (notes.length) lines.push(`Les erreurs d'import viennent de l'éditeur, pas du jeu : ${notes.join(" ; ")}.`, "");
  }
  if (r.repairs.length) {
    lines.push(`## Fichiers recréés (${r.repairs.length})`, "", "Ce que le paquet du jeu ne rendait pas, reconstitué pour que le projet démarre. Ce ne sont pas les fichiers d'origine.", "");
    for (const x of r.repairs) lines.push(`- \`${x.file}\` — ${x.note}`);
    lines.push("");
  }
  if (r.missing.length) {
    lines.push(`## Toujours réclamés par le jeu (${r.missing.length})`, "");
    for (const x of r.missing.slice(0, 40)) lines.push(`- \`${x.path}\` (${x.kind})`);
    lines.push("");
  }
  lines.push("## Ce que cela veut dire", "", "Le jeu tourne dans son dossier démonté, sur votre PC, avec votre copie payée du jeu : aucun fichier n'est modifié dans l'installation d'origine, et rien n'est republié.", "");
  return lines.join("\n");
}

/** Le nom de projet tel qu'il apparaît dans les rapports (nom du dossier). */
export const projectName = (dir: string) => basename(dir) || relative(dir, dir) || "projet";
