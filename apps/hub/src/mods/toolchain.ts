import { execFile } from "node:child_process";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, normalize, relative, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import type { GameRecipe } from "./recipes.ts";

/** Où en est l'outillage d'un jeu (ADR-65), en clair pour la page du studio de modding. */
export type ToolchainState = {
  dotnet: { installed: boolean; version: string | null };
  loader: { installed: boolean; version: string | null; generated: boolean; installing: boolean; error: string | null };
  typemap: { ready: boolean; types: number | null; building: boolean; error: string | null };
};

/** Le résultat d'une commande lancée par le hub : sortie et code. */
export type RunResult = { code: number; out: string };

/** Tout ce qui touche à la machine : remplacé par un faux dans les tests. */
export interface ToolchainPort {
  state(r: GameRecipe, gameDir: string): ToolchainState;
  /** Installe le chargeur de mods dans le dossier du jeu, sur votre clic ; la liste des fichiers posés est gardée. */
  installLoader(r: GameRecipe, gameDir: string): Promise<void>;
  /** Retire exactement les fichiers posés par installLoader. */
  removeLoader(r: GameRecipe, gameDir: string): Promise<void>;
  /** La carte des types : où la lire (lecture seule pour l'agent). */
  typemapDir(r: GameRecipe): string;
  buildTypemap(r: GameRecipe, gameDir: string): Promise<void>;
  /** La construction du mod, lancée par le hub (commande fixe de la recette, sans shell). */
  build(r: GameRecipe, modDir: string): Promise<RunResult>;
}

const run = (cmd: string, args: string[], cwd: string, timeoutMs = 10 * 60_000): Promise<RunResult> =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd, windowsHide: true, timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code as number) : 1) : 0;
      resolve({ code, out: `${stdout}${stderr}`.slice(-20_000) });
    });
  });

/** Le vrai outillage : .NET de votre PC, MelonLoader depuis sa page GitHub officielle, la carte des types construite ici. */
export class RealToolchain implements ToolchainPort {
  readonly #dir: string;
  readonly #busy = new Map<string, "loader" | "typemap">();
  readonly #errors = new Map<string, string>();
  #dotnet: { installed: boolean; version: string | null } | null = null;

  constructor(dataDir: string) {
    this.#dir = join(dataDir, "mods");
  }

  #recipeDir(r: GameRecipe): string {
    return join(this.#dir, r.id);
  }

  typemapDir(r: GameRecipe): string {
    return join(this.#recipeDir(r), "carte");
  }

  #checkDotnet(): { installed: boolean; version: string | null } {
    if (this.#dotnet) return this.#dotnet;
    this.#dotnet = { installed: false, version: null };
    execFile("dotnet", ["--list-sdks"], { windowsHide: true, timeout: 15_000 }, (err, out) => {
      const v = !err ? /^(\d+\.\d+\.\d+)/m.exec(out)?.[1] : undefined;
      this.#dotnet = { installed: !!v, version: v ?? null };
    });
    return this.#dotnet;
  }

  state(r: GameRecipe, gameDir: string): ToolchainState {
    const meta = this.#loaderMeta(r);
    const carte = join(this.typemapDir(r), "carte-types.txt");
    const info = join(this.typemapDir(r), "info.json");
    return {
      dotnet: this.#checkDotnet(),
      loader: {
        installed: existsSync(join(gameDir, r.loader.installedMark)),
        version: meta?.version ?? null,
        generated: existsSync(join(gameDir, r.loader.generatedMark)),
        installing: this.#busy.get(r.id) === "loader",
        error: this.#errors.get(`${r.id}:loader`) ?? null,
      },
      typemap: {
        ready: existsSync(carte),
        types: existsSync(info) ? (JSON.parse(readFileSync(info, "utf8")) as { types: number }).types : null,
        building: this.#busy.get(r.id) === "typemap",
        error: this.#errors.get(`${r.id}:typemap`) ?? null,
      },
    };
  }

  #loaderMeta(r: GameRecipe): { version: string; files: string[] } | null {
    const f = join(this.#recipeDir(r), "loader.json");
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as { version: string; files: string[] }) : null;
  }

  async installLoader(r: GameRecipe, gameDir: string): Promise<void> {
    if (this.#busy.has(r.id)) throw new Error("Une installation est déjà en cours");
    this.#busy.set(r.id, "loader");
    this.#errors.delete(`${r.id}:loader`);
    try {
      const dl = join(this.#recipeDir(r), "telechargements");
      mkdirSync(dl, { recursive: true });
      const zip = join(dl, `${r.loader.name}-${r.loader.version}.zip`);
      if (!existsSync(zip)) {
        const res = await fetch(r.loader.url, { headers: { "user-agent": "nidavellir-hub" } });
        if (!res.ok || !res.body) throw new Error(`Téléchargement impossible (${res.status})`);
        await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(zip));
      }
      // La liste des fichiers d'abord : on sait exactement quoi retirer, et rien ne sort du dossier du jeu.
      const list = await run("tar", ["-tf", zip], dl);
      if (list.code !== 0) throw new Error(`Archive illisible : ${list.out.slice(-300)}`);
      const entries = list.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      for (const e of entries) {
        const n = normalize(e);
        if (n.startsWith("..") || /^[a-z]:/i.test(n) || n.startsWith(sep)) throw new Error(`Archive refusée : chemin suspect « ${e} »`);
      }
      const existing = entries.filter((e) => !e.endsWith("/") && existsSync(join(gameDir, e)));
      if (existing.some((e) => !/^MelonLoader[\\/]/i.test(e) && !/^(version|dobby|winhttp)\.dll$/i.test(e))) throw new Error(`Des fichiers du jeu seraient remplacés (${existing.slice(0, 3).join(", ")}) : installation arrêtée`);
      const x = await run("tar", ["-xf", zip, "-C", gameDir], dl);
      if (x.code !== 0) throw new Error(`Extraction impossible : ${x.out.slice(-300)}`);
      mkdirSync(join(gameDir, r.modsDir), { recursive: true });
      const files = entries.filter((e) => !e.endsWith("/"));
      writeFileSync(join(this.#recipeDir(r), "loader.json"), JSON.stringify({ version: r.loader.version, files, at: new Date().toISOString() }, null, 2));
      if (!existsSync(join(gameDir, r.loader.installedMark))) throw new Error(`${r.loader.name} est extrait mais incomplet`);
    } catch (err) {
      this.#errors.set(`${r.id}:loader`, (err as Error).message.slice(0, 400));
      throw err;
    } finally {
      this.#busy.delete(r.id);
    }
  }

  async removeLoader(r: GameRecipe, gameDir: string): Promise<void> {
    const meta = this.#loaderMeta(r);
    if (!meta) throw new Error(`${r.loader.name} n'a pas été installé par le studio`);
    for (const f of meta.files) rmSync(join(gameDir, f), { force: true });
    // Le dossier du chargeur entier (ce qu'il a généré au premier lancement), jamais rien d'autre.
    rmSync(join(gameDir, "MelonLoader"), { recursive: true, force: true });
    rmSync(join(this.#recipeDir(r), "loader.json"), { force: true });
  }

  async buildTypemap(r: GameRecipe, gameDir: string): Promise<void> {
    if (this.#busy.has(r.id)) throw new Error("Une préparation est déjà en cours");
    const asm = join(gameDir, r.assemblies);
    if (!existsSync(asm)) throw new Error(`Les assemblies du jeu n'existent pas encore : ${r.loader.firstRun}`);
    this.#busy.set(r.id, "typemap");
    this.#errors.delete(`${r.id}:typemap`);
    try {
      const tool = join(this.#dir, "outils", "typemap");
      const exe = join(tool, "bin", "Release", "Typemap.dll");
      if (!existsSync(exe)) {
        mkdirSync(tool, { recursive: true });
        const src = join(dirname(fileURLToPath(import.meta.url)), "typemap");
        for (const f of ["Typemap.csproj", "Program.cs"]) copyFileSync(join(src, f), join(tool, f));
        const b = await run("dotnet", ["build", "-c", "Release", "-nologo", "-v", "q"], tool);
        if (b.code !== 0 || !existsSync(exe)) throw new Error(`La carte des types ne se construit pas : ${b.out.slice(-600)}`);
      }
      const out = this.typemapDir(r);
      mkdirSync(out, { recursive: true });
      const res = await run("dotnet", [exe, asm, join(out, "carte-types.txt")], out);
      if (res.code !== 0) throw new Error(`Carte des types impossible : ${res.out.slice(-600)}`);
      const types = Number(/(\d+) types/.exec(res.out)?.[1] ?? 0);
      writeFileSync(join(out, "info.json"), JSON.stringify({ types, at: new Date().toISOString(), from: asm }, null, 2));
    } catch (err) {
      this.#errors.set(`${r.id}:typemap`, (err as Error).message.slice(0, 600));
      throw err;
    } finally {
      this.#busy.delete(r.id);
    }
  }

  build(r: GameRecipe, modDir: string): Promise<RunResult> {
    return run("dotnet", r.buildArgs, modDir);
  }
}

/** Les fichiers d'un dossier, en chemins relatifs avec « / » (pour les listes de fichiers posés). */
export function filesIn(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d)) {
      const p = join(d, e);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(relative(dir, p).replace(/\\/g, "/"));
    }
  };
  if (existsSync(dir)) walk(dir);
  return out;
}
