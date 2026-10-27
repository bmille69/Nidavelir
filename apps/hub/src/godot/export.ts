import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { godotErrors, godotImport } from "./run.ts";

/**
 * L'export local d'un jeu Godot (ADR-90) : un exécutable Windows autonome (le jeu embarqué dedans) dans `build/` du jeu,
 * jamais commité, jamais envoyé nulle part. Puis un essai de l'exécutable lui-même, sans fenêtre.
 */

export const PRESET = "Windows Desktop";
export const BUILD_DIR = "build";
const KEEP = 5;

/** Le réglage d'export « Windows Desktop » du studio, ajouté s'il manque (les autres réglages du jeu sont gardés). */
export function ensurePreset(root: string): boolean {
  const file = join(root, "export_presets.cfg");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (new RegExp(`^name="${PRESET}"`, "m").test(text)) return false;
  const used = [...text.matchAll(/^\[preset\.(\d+)\]/gm)].map((m) => Number(m[1]));
  const n = used.length ? Math.max(...used) + 1 : 0;
  const block = `[preset.${n}]

name="${PRESET}"
platform="Windows Desktop"
runnable=true
dedicated_server=false
custom_features=""
export_filter="all_resources"
include_filter=""
exclude_filter="studio/*, tests/*, build/*"
export_path=""
encryption_include_filters=""
encryption_exclude_filters=""
encrypt_pck=false
encrypt_directory=false

[preset.${n}.options]

custom_template/debug=""
custom_template/release=""
debug/export_console_wrapper=1
binary_format/embed_pck=true
texture_format/s3tc_bptc=true
texture_format/etc2_astc=false
binary_format/architecture="x86_64"
application/modify_resources=false
`;
  writeFileSync(file, `${text.trimEnd()}${text.trim() ? "\n\n" : ""}${block}`, "utf8");
  return true;
}

/** `build/` n'est jamais commité. */
export function ensureIgnored(root: string): boolean {
  const file = join(root, ".gitignore");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (/^\/?build\/?$/m.test(text)) return false;
  writeFileSync(file, `${text.trimEnd()}${text.trim() ? "\n" : ""}# Exports locaux du studio (ADR-90).\n/${BUILD_DIR}/\n`, "utf8");
  return true;
}

function run(exe: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; log: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = execFile(exe, args, { cwd, windowsHide: true, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: child.exitCode, log: `${stdout}\n${stderr}`, timedOut: !!err && (err as NodeJS.ErrnoException & { killed?: boolean }).killed === true });
    });
  });
}

export type Build = { id: string; exe: string; bytes: number; at: string; commit: string | null; seconds: number; smoke: { ok: boolean; detail: string } };

/** Exporte, puis lance l'exécutable obtenu sans fenêtre quelques secondes : il doit démarrer et finir sans erreur. */
export async function godotExport(godot: string, root: string, input: { name: string; id: string; commit: string | null; at: string }): Promise<Build> {
  const started = Date.now();
  const imported = await godotImport(godot, root);
  if (imported.status === "fail") throw new Error(`Le projet ne s'importe pas : ${imported.detail.slice(0, 400)}`);
  const dir = join(root, BUILD_DIR, input.id);
  mkdirSync(dir, { recursive: true });
  const safe = input.name.replace(/[^\p{L}\p{N} _-]/gu, "").trim().replace(/\s+/g, "_") || "jeu";
  const exe = join(dir, `${safe}.exe`);
  const r = await run(godot, ["--headless", "--path", root, "--export-release", PRESET, exe], root, 10 * 60_000);
  const errors = godotErrors(r.log).filter((e) => !/rcedit|modify_resources/i.test(e));
  if (!existsSync(exe)) {
    rmSync(dir, { recursive: true, force: true });
    const why = /No export template found|template.*not found/i.test(r.log) ? "modèles d'export absents" : errors.slice(0, 4).join(" | ") || r.log.trim().split(/\r?\n/).slice(-4).join(" | ");
    throw new Error(`L'export a échoué : ${why.slice(0, 600)}`);
  }
  const smoke = await smokeTest(exe, dir);
  const build: Build = { id: input.id, exe: `${BUILD_DIR}/${input.id}/${safe}.exe`, bytes: statSync(exe).size, at: input.at, commit: input.commit, seconds: Math.round((Date.now() - started) / 1000), smoke };
  writeFileSync(join(dir, "build.json"), JSON.stringify(build, null, 2), "utf8");
  return build;
}

/** L'exécutable exporté, sans fenêtre, 240 images : il démarre, charge sa scène et finit sans erreur. */
export async function smokeTest(exe: string, cwd: string): Promise<{ ok: boolean; detail: string }> {
  const r = await run(exe, ["--headless", "--quit-after", "240"], cwd, 90_000);
  const errors = godotErrors(r.log);
  if (r.timedOut) return { ok: false, detail: "l'exécutable ne s'est pas arrêté en 90 s" };
  if (errors.length) return { ok: false, detail: `erreurs au lancement : ${errors.slice(0, 4).join(" | ")}` };
  if (r.code !== 0) return { ok: false, detail: `l'exécutable s'est arrêté avec le code ${r.code}` };
  return { ok: true, detail: "l'exécutable démarre et tourne 4 s sans erreur" };
}

/** Les exports du jeu, le plus récent d'abord. */
export function listBuilds(root: string): Build[] {
  const dir = join(root, BUILD_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((d) => existsSync(join(dir, d, "build.json")))
    .map((d) => JSON.parse(readFileSync(join(dir, d, "build.json"), "utf8")) as Build)
    .sort((a, b) => b.id.localeCompare(a.id));
}

/** Garde les `KEEP` derniers exports. */
export function pruneBuilds(root: string): void {
  for (const b of listBuilds(root).slice(KEEP)) rmSync(join(root, BUILD_DIR, b.id), { recursive: true, force: true });
}
