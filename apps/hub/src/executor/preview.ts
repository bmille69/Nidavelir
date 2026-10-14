import { spawn, execFile, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export class PreviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreviewError";
  }
}

export type Preview = { key: string; project: string; task: string | null; url: string; started_at: string };

type Running = Preview & { child: ChildProcess };

/**
 * « ▶ Essayer » (ADR-25) : lance le jeu en mode développement (`npm run dev`) dans la copie
 * de travail d'un chantier, ou dans le jeu lui-même, pour que vous puissiez y jouer avant de
 * fusionner. Action humaine uniquement ; le serveur n'écoute que sur cette machine.
 */
export class PreviewService {
  readonly #running = new Map<string, Running>();
  readonly #startTimeoutMs: number;

  readonly #workDir: string | null;

  constructor(options: { startTimeoutMs?: number; workDir?: string } = {}) {
    this.#startTimeoutMs = options.startTimeoutMs ?? 90_000;
    this.#workDir = options.workDir ?? null;
  }

  list(project?: string): Preview[] {
    return [...this.#running.values()].filter((p) => !project || p.project === project).map(({ child: _c, ...p }) => p);
  }

  async start(project: string, task: string | null, cwd: string): Promise<Preview> {
    const key = `${project}/${task ?? "jeu"}`;
    const existing = this.#running.get(key);
    if (existing && existing.child.exitCode === null) return this.list().find((p) => p.key === key)!;
    // Un seul essai à la fois par projet : deux serveurs de jeu se gêneraient.
    for (const p of this.list(project)) this.stop(p.key);

    const pkg = join(cwd, "package.json");
    if (!existsSync(pkg)) throw new PreviewError("Ce jeu n'a pas de package.json : je ne sais pas encore le lancer (jeux web uniquement pour l'instant).");
    const scripts = (JSON.parse(readFileSync(pkg, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
    if (!scripts.dev) throw new PreviewError("Ce jeu n'a pas de script « dev » dans package.json.");
    if (!existsSync(join(cwd, "node_modules"))) throw new PreviewError("Dépendances absentes dans cette copie (node_modules) : lancez d'abord « npm install » dans le jeu.");

    const port = await freePort(5180);
    const viteBin = join(cwd, "node_modules", "vite", "bin", "vite.js");
    const env = { ...process.env, PORT: String(port), BROWSER: "none" };
    const child =
      /^\s*vite(\s|$)/.test(scripts.dev) && existsSync(viteBin) && this.#workDir
        ? // Vite : lancé avec une configuration d'enrobage qui autorise les bibliothèques partagées (voir #viteWrapper).
          spawn(
            process.execPath,
            [viteBin, "--config", this.#viteWrapper(key, cwd), "--configLoader", "native", "--port", String(port), "--strictPort", "--host", "127.0.0.1"],
            { cwd, windowsHide: true, env, stdio: ["ignore", "pipe", "pipe"] },
          )
        : spawn(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "dev"], {
            cwd,
            shell: process.platform === "win32",
            windowsHide: true,
            env,
            stdio: ["ignore", "pipe", "pipe"],
          });

    const url = await new Promise<string>((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => {
        killTree(child.pid);
        reject(new PreviewError(`Le jeu ne s'est pas lancé en ${Math.round(this.#startTimeoutMs / 1000)} s. Dernières lignes : ${out.slice(-300)}`));
      }, this.#startTimeoutMs);
      const onData = (chunk: Buffer) => {
        out += chunk.toString("utf8");
        // « Local:   http://127.0.0.1:5180/ » (Vite) ou toute URL locale affichée.
        const m = /(https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/?)/.exec(out.replace(/\x1b\[[0-9;]*m/g, ""));
        if (m) {
          clearTimeout(timer);
          resolve(m[1]!);
        }
      };
      child.stdout!.on("data", onData);
      child.stderr!.on("data", onData);
      child.on("exit", (code) => {
        clearTimeout(timer);
        reject(new PreviewError(`Le jeu s'est arrêté au lancement (code ${code}) : ${out.slice(-300)}`));
      });
    });

    const preview: Running = { key, project, task, url, started_at: new Date().toISOString(), child };
    this.#running.set(key, preview);
    child.on("exit", () => this.#running.delete(key));
    return this.list().find((p) => p.key === key)!;
  }

  /**
   * Dans une copie de travail, node_modules est un lien vers celui du jeu (ADR-16) : Vite résout
   * les vrais chemins et refuse (403) les fichiers situés hors de la copie, comme les polices.
   * Cette configuration reprend celle du jeu telle quelle et autorise en plus ce dossier partagé.
   * Elle vit dans les données du hub : rien n'est écrit dans le jeu.
   */
  #viteWrapper(key: string, root: string): string {
    const dir = join(this.#workDir!, "previews");
    mkdirSync(dir, { recursive: true });
    const modules = realpathSync.native(join(root, "node_modules"));
    const vite = pathToFileURL(join(modules, "vite", "dist", "node", "index.js")).href;
    const file = join(dir, `${key.replace(/[^\w-]+/g, "_")}.vite.config.mjs`);
    const code = [
      `import { loadConfigFromFile, mergeConfig } from ${JSON.stringify(vite)};`,
      `const ROOT = ${JSON.stringify(root)};`,
      "export default async (env) => {",
      "  const loaded = await loadConfigFromFile(env, undefined, ROOT);",
      `  return mergeConfig(loaded?.config ?? {}, { root: ROOT, server: { fs: { allow: [ROOT, ${JSON.stringify(modules)}] } } });`,
      "};",
    ];
    writeFileSync(file, code.join("\n"), "utf8");
    return file;
  }

  /** Arrête le jeu ; la promesse se résout quand le processus est bien terminé (3 s au plus). */
  stop(key: string): Promise<void> {
    const p = this.#running.get(key);
    if (!p) return Promise.resolve();
    this.#running.delete(key);
    const done = new Promise<void>((resolve) => {
      if (p.child.exitCode !== null) return resolve();
      p.child.once("exit", () => resolve());
      setTimeout(resolve, 3000).unref?.();
    });
    killTree(p.child.pid);
    return done;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.#running.keys()].map((key) => this.stop(key)));
  }
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

function freePort(from: number): Promise<number> {
  return new Promise((resolve) => {
    const tryPort = (port: number) => {
      const srv = createServer();
      srv.once("error", () => tryPort(port + 1));
      srv.once("listening", () => srv.close(() => resolve(port)));
      srv.listen(port, "127.0.0.1");
    };
    tryPort(from);
  });
}
