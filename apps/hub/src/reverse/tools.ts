import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

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
}

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
] as const;

/** Les outils réels : téléchargés depuis leur page GitHub officielle dans les données du hub. */
export class RealReverseTools implements ReverseToolsPort {
  readonly #dir: string;

  constructor(dataDir: string) {
    this.#dir = join(dataDir, "tools");
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
    const res = await fetch(`https://api.github.com/repos/${tool.repo}/releases/latest`, { headers: { accept: "application/vnd.github+json", "user-agent": "nidavellir-hub" } });
    if (!res.ok) throw new Error(`GitHub ne répond pas (${res.status})`);
    const release = (await res.json()) as { tag_name: string; assets: { name: string; browser_download_url: string }[] };
    const asset = release.assets.find((a) => tool.asset.test(a.name));
    if (!asset) throw new Error(`Aucune version Windows de ${tool.name} dans la dernière publication (${release.tag_name})`);
    const root = join(this.#dir, id);
    const dest = join(root, release.tag_name);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    const zip = join(root, asset.name);
    const download = await fetch(asset.browser_download_url, { headers: { "user-agent": "nidavellir-hub" } });
    if (!download.ok || !download.body) throw new Error(`Téléchargement impossible (${download.status})`);
    await pipeline(Readable.fromWeb(download.body as import("node:stream/web").ReadableStream), createWriteStream(zip));
    // tar de Windows (bsdtar) sait ouvrir les .zip ; arguments fixes, aucun shell.
    await new Promise<void>((resolve, reject) => execFile("tar", ["-xf", zip, "-C", dest], { windowsHide: true }, (err) => (err ? reject(new Error(`Archive illisible : ${err.message}`)) : resolve())));
    rmSync(zip, { force: true });
    const exe = findFile(dest, tool.exe);
    if (!exe) throw new Error(`Le programme de ${tool.name} est introuvable dans l'archive`);
    writeFileSync(join(root, "installed.json"), JSON.stringify({ version: release.tag_name, exe }, null, 2));
    return this.list().find((t) => t.id === id)!;
  }

  recover(input: RecoverInput): Promise<void> {
    if (input.tool === "assetripper") return this.#assetRipper(input);
    const meta = this.#meta("gdre");
    if (!meta) return Promise.reject(new Error("GDRE Tools n'est pas installé"));
    mkdirSync(input.out, { recursive: true });
    const args = ["--headless", `--recover=${input.pck}`, `--output=${input.out}`];
    if (input.assembly) args.push(`--csharp-assembly=${input.assembly}`);
    if (input.scriptsOnly) args.push("--scripts-only");
    return new Promise((resolve, reject) => {
      const child = spawn(meta.exe, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
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
        if (code === 0) resolve();
        else reject(new Error(`GDRE Tools s'est arrêté (code ${code}) : ${tail.slice(-400)}`));
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
