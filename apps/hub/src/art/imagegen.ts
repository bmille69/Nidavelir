import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Le générateur d'images local du Directeur artistique (ADR-46) : ComfyUI et le modèle Flux, sur la carte graphique.
 * Rien ne s'installe sans votre clic ; le serveur ne tourne que pendant les générations, puis libère la carte.
 */

export type GenState = {
  installed: boolean;
  /** Installation en cours : étape en clair et avancement de 0 à 1. */
  installing: { step: string; progress: number } | null;
  error: string | null;
  /** Ce qui sera téléchargé, en clair. */
  size: string;
};

export type GenRequest = { prompt: string; width: number; height: number; seed: number };

export interface ImageGenPort {
  state(): GenState;
  /** Lance l'installation en arrière-plan ; l'avancement se lit dans state(). */
  install(): void;
  /** Une image PNG. Les demandes passent une par une : la carte graphique ne fait qu'une image à la fois. */
  generate(req: GenRequest): Promise<Buffer>;
  close(): void;
}

const RELEASES = "https://api.github.com/repos/Comfy-Org/ComfyUI/releases/latest";
const ARCHIVE = /^ComfyUI_windows_portable_nvidia\.7z$/i;
const MODEL = { name: "flux1-dev-fp8.safetensors", url: "https://huggingface.co/Comfy-Org/flux1-dev/resolve/main/flux1-dev-fp8.safetensors" };
/** Le serveur s'arrête après dix minutes sans demande, pour rendre la carte graphique aux jeux. */
const IDLE_MS = 10 * 60_000;
const UA = { "user-agent": "nidavellir-hub" };

type Installed = { version: string; python: string; main: string };

export class ComfyImageGen implements ImageGenPort {
  readonly #dir: string;
  #installing: GenState["installing"] = null;
  #error: string | null = null;
  #server: { child: ChildProcess; base: string } | null = null;
  #starting: Promise<string> | null = null;
  #idle: NodeJS.Timeout | null = null;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.#dir = join(dataDir, "tools", "comfyui");
  }

  #meta(): Installed | null {
    const file = join(this.#dir, "installed.json");
    if (!existsSync(file)) return null;
    try {
      const meta = JSON.parse(readFileSync(file, "utf8")) as Installed;
      return existsSync(meta.python) && existsSync(meta.main) && existsSync(this.#model(meta)) ? meta : null;
    } catch {
      return null;
    }
  }

  #model(meta: Installed): string {
    return join(meta.main, "..", "models", "checkpoints", MODEL.name);
  }

  state(): GenState {
    return { installed: this.#meta() !== null, installing: this.#installing, error: this.#error, size: "≈ 19 Go" };
  }

  install(): void {
    if (this.#installing || this.#meta()) return;
    this.#error = null;
    this.#installing = { step: "Préparation", progress: 0 };
    void this.#install().then(
      () => (this.#installing = null),
      (err: Error) => {
        this.#installing = null;
        this.#error = err.message.slice(0, 400);
      },
    );
  }

  async #install(): Promise<void> {
    mkdirSync(this.#dir, { recursive: true });
    const res = await fetch(RELEASES, { headers: { accept: "application/vnd.github+json", ...UA } });
    if (!res.ok) throw new Error(`GitHub ne répond pas (${res.status})`);
    const release = (await res.json()) as { tag_name: string; assets: { name: string; size: number; browser_download_url: string }[] };
    const asset = release.assets.find((a) => ARCHIVE.test(a.name));
    if (!asset) throw new Error(`Aucune version Windows NVIDIA de ComfyUI dans la dernière publication (${release.tag_name})`);
    const dest = join(this.#dir, release.tag_name);
    const MODEL_SIZE = 17_250_000_000;
    const total = asset.size + MODEL_SIZE;

    // 1. ComfyUI (version autonome, Python compris), si ce n'est pas déjà fait.
    let found = existsSync(dest) ? locate(dest) : null;
    if (!found) {
      const archive = join(this.#dir, asset.name);
      await download(asset.browser_download_url, archive, (done) => (this.#installing = { step: "Téléchargement de ComfyUI", progress: done / total }));
      this.#installing = { step: "Décompression de ComfyUI (quelques minutes)", progress: asset.size / total };
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(dest, { recursive: true });
      // tar de Windows (bsdtar) sait ouvrir les .7z ; arguments fixes, aucun shell.
      await new Promise<void>((resolve, reject) => execFile("tar", ["-xf", archive, "-C", dest], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, (err) => (err ? reject(new Error(`Archive illisible : ${err.message.slice(0, 200)}`)) : resolve())));
      rmSync(archive, { force: true });
      found = locate(dest);
      if (!found) throw new Error("ComfyUI introuvable dans l'archive");
    }
    const meta: Installed = { version: release.tag_name, ...found };

    // 2. Le modèle Flux (version allégée fp8, tout-en-un), qui reprend là où il s'était arrêté.
    const model = this.#model(meta);
    mkdirSync(join(model, ".."), { recursive: true });
    if (!existsSync(model)) {
      await download(MODEL.url, model, (done) => (this.#installing = { step: "Téléchargement du modèle Flux", progress: (asset.size + done) / total }));
    }
    writeFileSync(join(this.#dir, "installed.json"), JSON.stringify(meta, null, 2));
  }

  generate(req: GenRequest): Promise<Buffer> {
    const next = this.#queue.catch(() => {}).then(() => this.#generate(req));
    this.#queue = next;
    return next;
  }

  async #generate(req: GenRequest): Promise<Buffer> {
    if (this.#idle) clearTimeout(this.#idle);
    try {
      const base = await this.#ensureServer();
      const sent = JSON.parse(await http(`${base}/prompt`, "POST", JSON.stringify({ prompt: fluxWorkflow(req), client_id: "nidavellir" }))) as { prompt_id?: string; error?: { message?: string }; node_errors?: unknown };
      if (!sent.prompt_id) throw new Error(`ComfyUI refuse la demande : ${sent.error?.message ?? JSON.stringify(sent.node_errors ?? sent).slice(0, 300)}`);
      const deadline = Date.now() + 15 * 60_000;
      for (;;) {
        if (Date.now() > deadline) throw new Error("La génération a pris plus de 15 minutes");
        if (!this.#server) throw new Error("ComfyUI s'est arrêté pendant la génération, voir comfyui.log");
        const history = JSON.parse(await http(`${base}/history/${sent.prompt_id}`, "GET")) as Record<string, HistoryEntry>;
        const entry = history[sent.prompt_id];
        if (entry?.status?.status_str === "error") throw new Error(`ComfyUI a échoué : ${errorOf(entry)}`);
        const image = entry && Object.values(entry.outputs ?? {}).flatMap((o) => o.images ?? [])[0];
        if (image) {
          const q = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? "", type: image.type ?? "output" });
          return await httpBuffer(`${base}/view?${q}`);
        }
        await wait(1000);
      }
    } finally {
      this.#idle = setTimeout(() => this.#stop(), IDLE_MS);
      this.#idle.unref?.();
    }
  }

  async #ensureServer(): Promise<string> {
    if (this.#server) return this.#server.base;
    this.#starting ??= this.#start().finally(() => (this.#starting = null));
    return this.#starting;
  }

  async #start(): Promise<string> {
    const meta = this.#meta();
    if (!meta) throw new Error("Le générateur d'images n'est pas installé");
    const port = await freePort();
    const log = createWriteStream(join(this.#dir, "comfyui.log"), { flags: "w" });
    const child = spawn(meta.python, ["-s", meta.main, "--listen", "127.0.0.1", "--port", String(port), "--disable-auto-launch"], {
      cwd: join(meta.main, ".."),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.pipe(log);
    child.stderr?.pipe(log);
    const base = `http://127.0.0.1:${port}`;
    let exited = false;
    child.on("close", () => {
      exited = true;
      if (this.#server?.child === child) this.#server = null;
    });
    child.on("error", () => (exited = true));
    // Le premier démarrage peut être long (préparation de Python et de la carte graphique).
    const deadline = Date.now() + 5 * 60_000;
    for (;;) {
      if (exited) throw new Error("ComfyUI ne démarre pas, voir comfyui.log");
      if (Date.now() > deadline) {
        killTree(child.pid);
        throw new Error("ComfyUI ne répond pas après 5 minutes");
      }
      if (await http(`${base}/system_stats`, "GET").then(() => true, () => false)) break;
      await wait(1000);
    }
    this.#server = { child, base };
    return base;
  }

  #stop(): void {
    const s = this.#server;
    this.#server = null;
    if (s) killTree(s.child.pid);
  }

  close(): void {
    if (this.#idle) clearTimeout(this.#idle);
    this.#stop();
  }
}

type HistoryEntry = {
  status?: { status_str?: string; messages?: [string, { exception_message?: string }][] };
  outputs?: Record<string, { images?: { filename: string; subfolder?: string; type?: string }[] }>;
};

function errorOf(entry: HistoryEntry): string {
  const m = entry.status?.messages?.find(([kind]) => kind === "execution_error");
  return (m?.[1].exception_message ?? "erreur inconnue").slice(0, 300);
}

/** Le graphe ComfyUI de Flux dev (checkpoint fp8 tout-en-un), au format de son API. */
export function fluxWorkflow(req: GenRequest): Record<string, unknown> {
  return {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: MODEL.name } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: req.prompt, clip: ["1", 1] } },
    "3": { class_type: "FluxGuidance", inputs: { guidance: 3.5, conditioning: ["2", 0] } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["1", 1] } },
    "5": { class_type: "EmptySD3LatentImage", inputs: { width: req.width, height: req.height, batch_size: 1 } },
    "6": {
      class_type: "KSampler",
      inputs: { model: ["1", 0], seed: req.seed, steps: 20, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1, positive: ["3", 0], negative: ["4", 0], latent_image: ["5", 0] },
    },
    "7": { class_type: "VAEDecode", inputs: { samples: ["6", 0], vae: ["1", 2] } },
    "8": { class_type: "SaveImage", inputs: { filename_prefix: "nidavellir", images: ["7", 0] } },
  };
}

/** Le Python embarqué et ComfyUI/main.py dans la version autonome décompressée. */
function locate(dir: string): { python: string; main: string } | null {
  const walk = (d: string, depth: number): { python: string; main: string } | null => {
    const python = join(d, "python_embeded", "python.exe");
    const main = join(d, "ComfyUI", "main.py");
    if (existsSync(python) && existsSync(main)) return { python, main };
    if (depth >= 2) return null;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const found = walk(join(d, e.name), depth + 1);
      if (found) return found;
    }
    return null;
  };
  return walk(dir, 0);
}

/** Téléchargement dans un « .part », repris là où il s'était arrêté, puis renommé. */
export async function download(url: string, file: string, progress: (done: number) => void): Promise<void> {
  const part = `${file}.part`;
  const have = existsSync(part) ? statSync(part).size : 0;
  const res = await fetch(url, { headers: { ...UA, ...(have ? { range: `bytes=${have}-` } : {}) } });
  if (!res.ok || !res.body) throw new Error(`Téléchargement impossible (${res.status})`);
  const resumed = res.status === 206;
  let done = resumed ? have : 0;
  const counted = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
  let last = 0;
  counted.on("data", (chunk: Buffer) => {
    done += chunk.length;
    if (Date.now() - last > 500) {
      last = Date.now();
      progress(done);
    }
  });
  await pipeline(counted, createWriteStream(part, { flags: resumed ? "a" : "w" }));
  renameSync(part, file);
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

function httpBuffer(url: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = request(url, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => ((res.statusCode ?? 0) < 400 ? resolve(Buffer.concat(chunks)) : reject(new Error(`ComfyUI répond ${res.statusCode}`))));
    });
    req.on("error", reject);
    req.end();
  });
}

function http(url: string, method: "GET" | "POST", body?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers: body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        // ComfyUI renvoie les erreurs de graphe en 400, avec leur détail en JSON : on les laisse passer.
        if ((res.statusCode ?? 0) >= 500) reject(new Error(`ComfyUI répond ${res.statusCode}`));
        else resolve(text);
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

export function killTree(pid: number | undefined): void {
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
