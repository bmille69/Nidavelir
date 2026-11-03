import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { godotInstalls, type GodotInstall } from "../godot/toolchain.ts";

/** Un outil de démontage du catalogue (ADR-40). Rien n'est installé sans votre clic. */
export type ToolInfo = {
  id: string;
  name: string;
  repo: string;
  /** Ce que l'outil apporte, en clair. */
  purpose: string;
  /** Taille approximative du téléchargement. */
  size: string;
  installed: boolean;
  version: string | null;
};

export type RecoverInput = {
  /** L'outil du catalogue choisi par la détection. */
  tool: string;
  /** Le dossier du jeu installé (lu, jamais écrit). */
  game: string;
  pck: string;
  assembly: string | null;
  out: string;
  scriptsOnly: boolean;
  log: (line: string) => void;
  signal: AbortSignal;
};

export interface ReverseToolsPort {
  list(): ToolInfo[];
  install(id: string): Promise<ToolInfo>;
  /** Démonte un jeu (Godot ou Unity) dans `out`, sans jamais écrire dans le dossier du jeu. */
  recover(input: RecoverInput): Promise<void>;
  /** Décompile un assemblage C# (ILSpy) dans `out`, en fichiers .cs (ADR-95). */
  decompile(input: DecompileInput): Promise<void>;
  /**
   * Jeu Unity IL2CPP (ADR-96) : Cpp2IL relit le code machine. `out/isil` reçoit le code de chaque fonction (ISIL),
   * `out/cs` la structure avec les décalages des champs (diffable-cs), qui servent à nommer les champs dans le code.
   */
  dumpIl2cpp(input: { game: string; out: string; log: (line: string) => void; signal: AbortSignal }): Promise<void>;
  /**
   * Les Godot disponibles pour rouvrir un projet démonté (ADR-120) : ceux que le hub a installés, plus celui du PC.
   * Un projet Godot C# exige la version .NET (Mono), et souvent la version exacte du jeu.
   */
  godotEditors(): GodotInstall[];
  /** Installe le Godot qu'un projet réclame (version exacte du jeu), en .NET s'il contient du C#. */
  installGodot(input: { version: string; mono: boolean }): Promise<GodotInstall>;
}

export type DecompileInput = { assembly: string; out: string; log: (line: string) => void; signal: AbortSignal };

/**
 * ilspycmd est un outil .NET (NuGet) : la version 9.1 tourne sur le runtime .NET 8, présent avec le SDK 8 ou 9.
 * Les versions 10+ exigent un SDK plus récent, d'où la version fixée.
 */
const ILSPY_VERSION = "9.1.0.7988";

/** Ghidra 12 refuse de démarrer sous un JDK plus ancien que celui-là. */
const GHIDRA_JAVA = 25;

const CATALOG = [
  {
    id: "gdre",
    name: "GDRE Tools",
    repo: "GDRETools/gdsdecomp",
    purpose: "Démonte les jeux Godot : scènes, ressources, scripts, et le code C# décompilé.",
    size: "≈ 100 Mo",
    asset: /windows\.zip$/i,
    exe: /^gdre_tools\.exe$/i,
  },
  {
    id: "assetripper",
    name: "AssetRipper",
    repo: "AssetRipper/AssetRipper",
    purpose: "Démonte les jeux Unity : le code C# (lisible pour Mono, la structure seulement pour IL2CPP), les scènes, images et sons.",
    size: "≈ 45 Mo",
    asset: /win_x64\.zip$/i,
    exe: /^AssetRipper[\w.]*\.exe$/i,
  },
  {
    id: "ilspy",
    name: "ILSpy",
    repo: "icsharpcode/ILSpy",
    purpose: "Décompile le code C# des jeux Godot C# et Unity Mono en fichiers lisibles. S'installe par .NET (le SDK .NET 8 ou plus doit être présent).",
    size: "≈ 30 Mo",
    asset: /^$/,
    exe: /^ilspycmd\.exe$/i,
  },
  {
    id: "cpp2il",
    name: "Cpp2IL",
    repo: "SamboyCoding/Cpp2IL",
    purpose: "Relit le code machine des jeux Unity IL2CPP : le code de chaque fonction (en pseudo-assembleur, annoté par le hub), là où AssetRipper ne rend que des méthodes vides.",
    size: "≈ 15 Mo",
    // Cpp2IL ne publie que des préversions (2022.1.0-pre-release.N), qui seules lisent les Unity récents : un seul programme, sans archive.
    asset: /^Cpp2IL-.*-Windows\.exe$/i,
    exe: /^Cpp2IL-.*-Windows\.exe$/i,
  },
  {
    id: "godot",
    name: "Godot",
    repo: "godotengine/godot",
    purpose:
      "Rouvre un projet Godot démonté pour vérifier qu'il se recompile et démarre (ADR-120). La version .NET (Mono) est nécessaire dès que le jeu a du C# ; le hub installe celle que le projet annonce.",
    size: "≈ 120 Mo",
    asset: /_mono_win64\.zip$/i,
    exe: /^Godot_v.*_mono_win64(?:_console)?\.exe$/i,
  },
  {
    id: "ghidra",
    name: "Ghidra",
    repo: "NationalSecurityAgency/ghidra",
    purpose:
      "Désassemble un binaire quand il n'y a pas de projet à récupérer : Unreal, moteur maison, bibliothèques natives d'un jeu Unity IL2CPP. Il donne du code machine en pseudo-C, jamais les sources ni les scènes. Il lui faut un JDK 25, que le hub installe avec lui.",
    size: "≈ 400 Mo (+ Java 25, ≈ 200 Mo)",
    asset: /^ghidra_.*_PUBLIC_\d{8}\.zip$/i,
    exe: /^analyzeHeadless\.bat$/i,
  },
] as const;

/** Comment GDRE est lancé (un passage) : rend le code de sortie et la fin de son journal. */
export type GdreRun = (exe: string, args: string[], input: RecoverInput) => Promise<{ code: number | null; tail: string }>;

/** Les outils réels : téléchargés depuis leur page GitHub officielle dans les données du hub. */
export class RealReverseTools implements ReverseToolsPort {
  readonly #dir: string;
  /** Remplaçable, pour éprouver le second essai (sommes de contrôle) sans vrai jeu. */
  readonly #gdreRun: GdreRun;

  constructor(dataDir: string, deps: { runGdre?: GdreRun } = {}) {
    this.#dir = join(dataDir, "tools");
    this.#gdreRun = deps.runGdre ?? ((exe, args, input) => this.#runGdre(exe, args, input));
  }

  #meta(id: string): { version: string; exe: string } | null {
    const file = join(this.#dir, id, "installed.json");
    if (!existsSync(file)) return null;
    const meta = JSON.parse(readFileSync(file, "utf8")) as { version: string; exe: string };
    return existsSync(meta.exe) ? meta : null;
  }

  list(): ToolInfo[] {
    return CATALOG.map((t) => {
      const meta = this.#meta(t.id);
      return { id: t.id, name: t.name, repo: t.repo, purpose: t.purpose, size: t.size, installed: meta !== null, version: meta?.version ?? null };
    });
  }

  async install(id: string): Promise<ToolInfo> {
    const tool = CATALOG.find((t) => t.id === id);
    if (!tool) throw new Error(`Outil inconnu : ${id}`);
    if (tool.id === "ilspy") return this.#installIlspy();
    if (tool.id === "ghidra") return this.#installGhidra();
    // Godot : la dernière version .NET publiée (un projet démonté, lui, réclame souvent une version précise).
    if (tool.id === "godot") {
      await this.installGodot({ version: await this.#latestGodot(), mono: true });
      return this.list().find((t) => t.id === id)!;
    }
    const headers = { accept: "application/vnd.github+json", "user-agent": "nidavellir-hub" };
    // Cpp2IL ne publie que des préversions : on prend la plus récente qui a un programme Windows.
    const res = await fetch(`https://api.github.com/repos/${tool.repo}/releases${tool.id === "cpp2il" ? "?per_page=10" : "/latest"}`, { headers });
    if (!res.ok) throw new Error(`GitHub ne répond pas (${res.status})`);
    type Release = { tag_name: string; assets: { name: string; browser_download_url: string }[] };
    const body = (await res.json()) as Release | Release[];
    const release = Array.isArray(body) ? body.find((r) => r.assets.some((a) => tool.asset.test(a.name))) : body;
    if (!release) throw new Error(`Aucune version Windows de ${tool.name} sur GitHub`);
    const asset = release.assets.find((a) => tool.asset.test(a.name));
    if (!asset) throw new Error(`Aucune version Windows de ${tool.name} dans la dernière publication (${release.tag_name})`);
    const root = join(this.#dir, id);
    const dest = join(root, release.tag_name);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    const direct = /\.exe$/i.test(asset.name);
    const zip = direct ? join(dest, asset.name) : join(root, asset.name);
    const download = await fetch(asset.browser_download_url, { headers: { "user-agent": "nidavellir-hub" } });
    if (!download.ok || !download.body) throw new Error(`Téléchargement impossible (${download.status})`);
    await pipeline(Readable.fromWeb(download.body as import("node:stream/web").ReadableStream), createWriteStream(zip));
    if (!direct) await this.#unzip(zip, dest);
    const exe = findFile(dest, tool.exe);
    if (!exe) throw new Error(`Le programme de ${tool.name} est introuvable dans l'archive`);
    writeFileSync(join(root, "installed.json"), JSON.stringify({ version: release.tag_name, exe }, null, 2));
    return this.list().find((t) => t.id === id)!;
  }

  /** ILSpy en ligne de commande : `dotnet tool install` dans les données du hub, jamais pour tout le PC. */
  async #installIlspy(): Promise<ToolInfo> {
    const root = join(this.#dir, "ilspy");
    const dest = join(root, ILSPY_VERSION);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    await new Promise<void>((resolve, reject) =>
      execFile("dotnet", ["tool", "install", "ilspycmd", "--version", ILSPY_VERSION, "--tool-path", dest], { windowsHide: true, timeout: 10 * 60_000 }, (err, _out, stderr) => {
        if (!err) return resolve();
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return reject(new Error("ILSpy s'installe avec .NET : installez d'abord le SDK .NET 8 ou plus (dotnet.microsoft.com), puis réessayez."));
        reject(new Error(`Installation d'ILSpy impossible : ${(stderr || err.message).trim().slice(-400)}`));
      }),
    );
    const exe = findFile(dest, /^ilspycmd(\.exe)?$/i);
    if (!exe) throw new Error("ilspycmd est introuvable après l'installation");
    writeFileSync(join(root, "installed.json"), JSON.stringify({ version: ILSPY_VERSION, exe }, null, 2));
    return this.list().find((t) => t.id === "ilspy")!;
  }

  /**
   * Ghidra : l'archive officielle de la NSA, plus le Java 21 qu'il réclame (le PC n'a que la 8). Ghidra sans Java
   * récent ne démarre pas du tout, d'où l'installation des deux ensemble.
   */
  async #installGhidra(): Promise<ToolInfo> {
    const javaHome = await this.#ensureJava(GHIDRA_JAVA);
    const root = join(this.#dir, "ghidra");
    const res = await fetch("https://api.github.com/repos/NationalSecurityAgency/ghidra/releases/latest", {
      headers: { accept: "application/vnd.github+json", "user-agent": "nidavellir-hub" },
    });
    if (!res.ok) throw new Error(`GitHub ne répond pas (${res.status})`);
    const release = (await res.json()) as { tag_name: string; assets: { name: string; browser_download_url: string }[] };
    const asset = release.assets.find((a) => /^ghidra_.*_PUBLIC_\d{8}\.zip$/i.test(a.name));
    if (!asset) throw new Error(`Aucune archive de Ghidra dans la dernière publication (${release.tag_name})`);
    const dest = join(root, release.tag_name);
    mkdirSync(dest, { recursive: true });
    // Déjà décompressé (une première installation a échoué après l'extraction) : on ne retélécharge pas 400 Mo.
    if (!findFile(dest, /^analyzeHeadless\.bat$/i)) {
      const zip = join(root, asset.name);
      const download = await fetch(asset.browser_download_url, { headers: { "user-agent": "nidavellir-hub" } });
      if (!download.ok || !download.body) throw new Error(`Téléchargement de Ghidra impossible (${download.status})`);
      await pipeline(Readable.fromWeb(download.body as import("node:stream/web").ReadableStream), createWriteStream(zip));
      await this.#unzip(zip, dest);
    }
    const exe = findFile(dest, /^analyzeHeadless\.bat$/i);
    if (!exe) throw new Error("analyzeHeadless est introuvable dans l'archive de Ghidra");
    writeFileSync(join(root, "installed.json"), JSON.stringify({ version: release.tag_name, exe, java: javaHome }, null, 2));
    return this.list().find((t) => t.id === "ghidra")!;
  }

  /**
   * Un Java assez récent pour l'outil : celui du hub s'il existe, sinon celui du PC, sinon Temurin (≈ 190 Mo).
   * Ghidra 12 réclame un JDK 25 ; le PC n'a que la 8, d'où le téléchargement.
   */
  async #ensureJava(min: number): Promise<string> {
    const root = join(this.#dir, "java");
    const meta = join(root, "installed.json");
    if (existsSync(meta)) {
      const { home, version } = JSON.parse(readFileSync(meta, "utf8")) as { home: string; version?: string };
      if (Number(version ?? 0) >= min && existsSync(join(home, "bin", "java.exe"))) return home;
    }
    const system = await this.#systemJava(min);
    if (system) return system;
    const dest = join(root, `temurin-${min}`);
    mkdirSync(dest, { recursive: true });
    if (!findFile(dest, /^java\.exe$/i)) {
      const zip = join(root, `temurin-${min}.zip`);
      const url = `https://api.adoptium.net/v3/binary/latest/${min}/ga/windows/x64/jdk/hotspot/normal/eclipse?project=jdk`;
      const download = await fetch(url, { headers: { "user-agent": "nidavellir-hub" } });
      if (!download.ok || !download.body) throw new Error(`Téléchargement de Java 21 impossible (${download.status})`);
      await pipeline(Readable.fromWeb(download.body as import("node:stream/web").ReadableStream), createWriteStream(zip));
      await this.#unzip(zip, dest);
    }
    const java = findFile(dest, /^java\.exe$/i);
    if (!java) throw new Error("java.exe est introuvable dans l'archive de Temurin");
    const home = dirname(dirname(java));
    writeFileSync(meta, JSON.stringify({ version: String(min), home }, null, 2));
    return home;
  }

  /** Le Java du PC s'il est assez récent (« 1.8.0_51 » → 8, « 21.0.1 » → 21) ; sinon null. */
  async #systemJava(min: number): Promise<string | null> {
    const own = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, "bin", "java.exe") : "java";
    const out = await new Promise<string>((resolve) =>
      execFile(own, ["-version"], { windowsHide: true }, (_err, stdout, stderr) => resolve(`${stdout}${stderr}`)),
    );
    const m = /version "(\d+)(?:\.(\d+))?/.exec(out);
    const first = Number(m?.[1] ?? 0);
    const version = first === 1 ? Number(m?.[2] ?? 0) : first;
    if (version < min) return null;
    if (process.env.JAVA_HOME && existsSync(own)) return process.env.JAVA_HOME;
    // Trouvé dans le PATH : le JAVA_HOME est deux dossiers au-dessus de `…/bin/java.exe`.
    const where = await new Promise<string>((resolve) =>
      execFile("where", ["java"], { windowsHide: true }, (_e, stdout) => resolve(stdout.split(/\r?\n/)[0] ?? "")),
    );
    return where.trim() ? dirname(dirname(where.trim())) : null;
  }

  /** Archive .zip → dossier, avec le `tar` de Windows (bsdtar) : celui de Git Bash prend `C:` pour un hôte distant. */
  async #unzip(zip: string, dest: string): Promise<void> {
    const bsdtar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    const tar = existsSync(bsdtar) ? bsdtar : "tar";
    await new Promise<void>((resolve, reject) =>
      execFile(tar, ["-xf", zip, "-C", dest], { windowsHide: true }, (err) =>
        err ? reject(new Error(`Archive illisible : ${err.message}`)) : resolve(),
      ),
    );
    rmSync(zip, { force: true });
  }

  /**
   * Les Godot que le hub a installés, plus celui du PC (bureau, téléchargements, dossiers habituels). Sert à choisir
   * l'éditeur qui correspond au projet démonté, version et .NET compris (ADR-120).
   */
  godotEditors(): GodotInstall[] {
    return godotInstalls([join(this.#dir, "godot", "editors")]);
  }

  /** La dernière version stable publiée (« 4.6.2-stable » → « 4.6.2 »). */
  async #latestGodot(): Promise<string> {
    const res = await fetch("https://api.github.com/repos/godotengine/godot/releases/latest", { headers: { accept: "application/vnd.github+json", "user-agent": "nidavellir-hub" } });
    if (!res.ok) throw new Error(`GitHub ne répond pas (${res.status})`);
    const tag = ((await res.json()) as { tag_name?: string }).tag_name ?? "";
    const version = /^(\d+\.\d+(?:\.\d+)?)/.exec(tag)?.[1];
    if (!version) throw new Error(`Version de Godot illisible : « ${tag} »`);
    return version;
  }

  /**
   * Télécharge un Godot précis depuis sa page GitHub officielle (l'adresse des versions est stable) et l'installe dans
   * les données du hub. Mono = la version .NET, indispensable dès que le projet contient du C#.
   */
  async installGodot(input: { version: string; mono: boolean }): Promise<GodotInstall> {
    const { version, mono } = input;
    if (!/^\d+\.\d+(\.\d+)?$/.test(version)) throw new Error(`Version de Godot invalide : ${version}`);
    const root = join(this.#dir, "godot");
    const dest = join(root, "editors", `${version}${mono ? "-mono" : ""}`);
    const folder = `Godot_v${version}-stable${mono ? "_mono" : ""}_win64`;
    const zip = join(root, `${folder}.zip`);
    mkdirSync(root, { recursive: true });
    // Déjà installé : on n'écrase pas 120 Mo (et un dossier en cours d'utilisation fait échouer la suppression).
    if (existsSync(dest)) {
      const present = findFile(dest, /^Godot_v.*\.exe$/i);
      if (present) {
        writeFileSync(join(root, "installed.json"), JSON.stringify({ version, exe: present, mono }, null, 2));
        return { exe: present, version, mono };
      }
      rmSync(dest, { recursive: true, force: true });
    }
    mkdirSync(dest, { recursive: true });
    const url = `https://github.com/godotengine/godot/releases/download/${version}-stable/${folder}.zip`;
    const download = await fetch(url, { headers: { "user-agent": "nidavellir-hub" } });
    if (!download.ok || !download.body)
      throw new Error(
        `Téléchargement de Godot ${version}${mono ? " (Mono)" : ""} impossible (${download.status}) : cette version n'existe peut-être pas en .NET.`,
      );
    await pipeline(Readable.fromWeb(download.body as import("node:stream/web").ReadableStream), createWriteStream(zip));
    await this.#unzip(zip, dest);
    const exe = findFile(dest, /^Godot_v.*\.exe$/i);
    if (!exe) throw new Error(`Le programme de Godot ${version} est introuvable dans l'archive`);
    writeFileSync(join(root, "installed.json"), JSON.stringify({ version, exe, mono }, null, 2));
    return { exe, version, mono };
  }

  /** `ilspycmd -p` : un projet C# complet, un fichier par type, les références cherchées à côté de l'assemblage. */
  decompile(input: DecompileInput): Promise<void> {
    const meta = this.#meta("ilspy");
    if (!meta) return Promise.reject(new Error("ILSpy n'est pas installé"));
    mkdirSync(input.out, { recursive: true });
    const args = ["-p", "-o", input.out, "-r", dirname(input.assembly), input.assembly];
    return new Promise((resolve, reject) => {
      const child = spawn(meta.exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const onAbort = () => killTree(child.pid);
      input.signal.addEventListener("abort", onAbort, { once: true });
      let tail = "";
      child.stdout.on("data", (b: Buffer) => (tail = (tail + b.toString("utf8")).slice(-2000)));
      child.stderr.on("data", (b: Buffer) => (tail = (tail + b.toString("utf8")).slice(-2000)));
      pipeLog(child, input.log);
      child.on("error", (e) => reject(new Error(`ILSpy ne se lance pas : ${e.message}`)));
      child.on("close", (code) => {
        input.signal.removeEventListener("abort", onAbort);
        if (input.signal.aborted) return reject(new Error("Démontage arrêté"));
        if (code === 0) resolve();
        else reject(new Error(`ILSpy s'est arrêté (code ${code}) : ${tail.slice(-400)}`));
      });
    });
  }

  /** Cpp2IL, deux passages : le code de chaque fonction (isil), puis la structure avec les décalages (diffable-cs). */
  async dumpIl2cpp(input: { game: string; out: string; log: (line: string) => void; signal: AbortSignal }): Promise<void> {
    const meta = this.#meta("cpp2il");
    if (!meta) throw new Error("Cpp2IL n'est pas installé");
    mkdirSync(input.out, { recursive: true });
    const pass = (label: string, args: string[]) =>
      new Promise<void>((resolve, reject) => {
        input.log(`Cpp2IL : ${label}…`);
        const child = spawn(meta.exe, ["--game-path", input.game, ...args], { windowsHide: true, cwd: input.out, stdio: ["ignore", "pipe", "pipe"] });
        const onAbort = () => killTree(child.pid);
        input.signal.addEventListener("abort", onAbort, { once: true });
        let tail = "";
        const keep = (b: Buffer) => (tail = (tail + b.toString("utf8")).slice(-2000));
        child.stdout.on("data", keep);
        child.stderr.on("data", keep);
        pipeLog(child, (l) => {
          // Cpp2IL écrit une ligne par assemblage traité : on ne garde que l'essentiel dans le journal.
          if (/version|Error|Exception|Done|Finished/i.test(l)) input.log(l);
        });
        child.on("error", (e) => reject(new Error(`Cpp2IL ne se lance pas : ${e.message}`)));
        child.on("close", (code) => {
          input.signal.removeEventListener("abort", onAbort);
          if (input.signal.aborted) return reject(new Error("Démontage arrêté"));
          if (code === 0) resolve();
          else reject(new Error(`Cpp2IL s'est arrêté (code ${code}) : ${tail.slice(-400)}`));
        });
      });
    await pass("le code de chaque fonction", ["--output-as", "isil", "--output-to", join(input.out, "isil")]);
    await pass("la structure et les décalages des champs", ["--output-as", "diffable-cs", "--use-processor", "attributeinjector", "--output-to", join(input.out, "cs")]);
  }

  recover(input: RecoverInput): Promise<void> {
    if (input.tool === "assetripper") return this.#assetRipper(input);
    return this.#gdre(input);
  }

  /**
   * GDRE lit le pack Godot et rend le projet. Un seul fichier dont la somme de contrôle ne correspond plus (mise à
   * jour Steam, mod, copie abîmée) lui fait refuser d'extraire quoi que ce soit : on reprend alors en ignorant les
   * sommes de contrôle, plutôt que de laisser l'utilisateur sans rien. Le fichier concerné peut être abîmé, on le dit.
   */
  async #gdre(input: RecoverInput): Promise<void> {
    const meta = this.#meta("gdre");
    if (!meta) throw new Error("GDRE Tools n'est pas installé");
    mkdirSync(input.out, { recursive: true });
    const args = ["--headless", `--recover=${input.pck}`, `--output=${input.out}`];
    if (input.assembly) args.push(`--csharp-assembly=${input.assembly}`);
    if (input.scriptsOnly) args.push("--scripts-only");

    const first = await this.#gdreRun(meta.exe, args, input);
    if (first.code === 0) return;
    if (input.signal.aborted) throw new Error("Démontage arrêté");
    if (!/checksum/i.test(first.tail)) throw new Error(`GDRE Tools s'est arrêté (code ${first.code}) : ${first.tail.slice(-400)}`);

    const damaged = [...first.tail.matchAll(/Checksum failed for res:\/\/(\S+)/g)].map((m) => m[1]!);
    input.log(
      `Un fichier du paquet ne correspond plus à sa somme de contrôle${damaged.length ? ` (${[...new Set(damaged)].slice(0, 3).join(", ")})` : ""} : ` +
        "GDRE reprend en l'ignorant. Le jeu a peut-être été mis à jour ou modifié ; ce fichier-là peut être abîmé.",
    );
    const second = await this.#gdreRun(meta.exe, [...args, "--ignore-checksum-errors"], input);
    if (second.code === 0) {
      input.log("Le projet est sorti en ignorant ce fichier : tout le reste du jeu est lisible.");
      return;
    }
    throw new Error(
      `GDRE Tools s'est arrêté (code ${second.code}) même en ignorant les sommes de contrôle : ${second.tail.slice(-300)}. ` +
        "Le paquet du jeu est probablement incomplet : demandez à Steam de vérifier les fichiers.",
    );
  }

  /** Un passage de GDRE ; rend le code de sortie et la fin de son journal (pour décider d'un second essai). */
  #runGdre(exe: string, args: string[], input: RecoverInput): Promise<{ code: number | null; tail: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const onAbort = () => killTree(child.pid);
      input.signal.addEventListener("abort", onAbort, { once: true });
      let tail = "";
      const onData = (b: Buffer) => {
        const text = b.toString("utf8");
        tail = (tail + text).slice(-2000);
        for (const line of text.split(/\r?\n/)) if (line.trim()) input.log(line.trim().slice(0, 400));
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("error", (e) => reject(new Error(`GDRE Tools ne se lance pas : ${e.message}`)));
      child.on("close", (code) => {
        input.signal.removeEventListener("abort", onAbort);
        if (input.signal.aborted) return reject(new Error("Démontage arrêté"));
        resolve({ code, tail });
      });
    });
  }

  /**
   * AssetRipper n'a pas de ligne de commande : c'est un petit serveur web local. On le lance sans fenêtre, on lui fait
   * lire le dossier du jeu, puis exporter le projet Unity dans `out`. Il exporte toujours tout (code et ressources).
   */
  async #assetRipper(input: RecoverInput): Promise<void> {
    const meta = this.#meta("assetripper");
    if (!meta) throw new Error("AssetRipper n'est pas installé");
    const port = await freePort();
    const args = ["--port", String(port), "--headless", "--log-path", join(dirname(input.out), "assetripper.log")];
    const child = spawn(meta.exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let exited: string | null = null;
    child.on("error", (e) => (exited = `AssetRipper ne se lance pas : ${e.message}`));
    child.on("close", (code) => (exited ??= `AssetRipper s'est arrêté (code ${code}), voir assetripper.log`));
    pipeLog(child, input.log);
    const onAbort = () => killTree(child.pid);
    input.signal.addEventListener("abort", onAbort, { once: true });
    const base = `http://127.0.0.1:${port}`;
    const check = () => {
      if (input.signal.aborted) throw new Error("Démontage arrêté");
      if (exited) throw new Error(exited);
    };
    try {
      for (let i = 0; ; i++) {
        check();
        if ((await httpCall(`${base}/IO/Directory/Exists?Path=.`, null, "GET").catch(() => 0)) > 0) break;
        if (i > 120) throw new Error("AssetRipper ne répond pas");
        await wait(500);
      }
      input.log("AssetRipper lit le jeu…");
      // Selon la version, la lecture se fait pendant la requête ou en arrière-plan : on enchaîne de toute façon sur l'export.
      await httpCall(`${base}/LoadFolder`, { Path: input.game });
      input.log("Export du projet Unity (code, scènes, ressources)…");
      // L'export ne fait rien tant que la lecture n'est pas finie : on réessaie jusqu'à ce que des fichiers arrivent.
      const deadline = Date.now() + 3 * 3600_000;
      for (;;) {
        check();
        await httpCall(`${base}/Export/UnityProject`, { Path: input.out });
        check();
        if (existsSync(input.out) && readdirSync(input.out).length) break;
        if (Date.now() > deadline) throw new Error("AssetRipper n'a pas réussi à lire le jeu, voir assetripper.log");
        await wait(5000);
      }
      input.log("Export terminé.");
    } finally {
      input.signal.removeEventListener("abort", onAbort);
      killTree(child.pid);
    }
  }
}

function pipeLog(child: ChildProcess, log: (line: string) => void): void {
  const onData = (b: Buffer) => {
    for (const line of b.toString("utf8").split(/\r?\n/)) if (line.trim()) log(line.trim().slice(0, 400));
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (address && typeof address === "object" ? resolve(address.port) : reject(new Error("Aucun port libre"))));
    });
  });
}

/** Une requête locale sans limite de durée (une lecture ou un export peut prendre de longues minutes), le code HTTP en retour. */
function httpCall(url: string, form: Record<string, string> | null, method = "POST"): Promise<number> {
  const body = form ? new URLSearchParams(form).toString() : "";
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers: form ? { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(body) } : {} }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    req.on("error", reject);
    req.end(body);
  });
}

function findFile(dir: string, name: RegExp): string | null {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isFile() && name.test(entry.name)) return p;
    if (entry.isDirectory()) {
      const found = findFile(p, name);
      if (found) return found;
    }
  }
  return null;
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
  else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* déjà arrêté */
    }
  }
}
