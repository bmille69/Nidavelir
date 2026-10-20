import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import { createHash } from "node:crypto";
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
  /** Flux Kontext (ADR-51) : retouche d'une image par consigne et air de famille, installé à part sur votre clic. */
  kontext: { installed: boolean; installing: { step: string; progress: number } | null; error: string | null; size: string };
};

/**
 * `init` : une variation d'une image existante (le croquis choisi, ADR-49) au lieu d'une image partie de zéro.
 * `denoise` va de 0 (l'image telle quelle) à 1 (rien n'en reste).
 */
export type GenRequest = { prompt: string; width: number; height: number; seed: number; init?: { image: Buffer; denoise: number }; edit?: { images: Buffer[] } };
/*
 * `edit` (Flux Kontext, ADR-51) : le prompt est une consigne appliquée à la première image (« move the big pauldron to the
 * other shoulder »), ou, avec une image de style, un nouveau sujet dessiné dans ce style. La taille vient de la première image.
 */

export interface ImageGenPort {
  state(): GenState;
  /** Lance l'installation en arrière-plan ; l'avancement se lit dans state(). */
  install(): void;
  /** Installe Flux Kontext (le générateur doit être là) ; l'avancement se lit dans state().kontext. */
  installKontext(): void;
  /** Une image PNG. Les demandes passent une par une : la carte graphique ne fait qu'une image à la fois. */
  generate(req: GenRequest): Promise<Buffer>;
  close(): void;
}

const RELEASES = "https://api.github.com/repos/Comfy-Org/ComfyUI/releases/latest";
const ARCHIVE = /^ComfyUI_windows_portable_nvidia\.7z$/i;
const MODEL = { name: "flux1-dev-fp8.safetensors", url: "https://huggingface.co/Comfy-Org/flux1-dev/resolve/main/flux1-dev-fp8.safetensors" };
/**
 * Flux Kontext (ADR-51), en fichiers séparés depuis les dépôts publics de ComfyUI (sans compte) : le modèle, ses deux
 * encodeurs de texte et son décodeur d'image. Charger Kontext à côté du Flux tout-en-un saturerait les 32 Go de mémoire.
 */
const KONTEXT = [
  { dir: "diffusion_models", name: "flux1-dev-kontext_fp8_scaled.safetensors", size: 11_904_640_136, url: "https://huggingface.co/Comfy-Org/flux1-kontext-dev_ComfyUI/resolve/main/split_files/diffusion_models/flux1-dev-kontext_fp8_scaled.safetensors" },
  { dir: "text_encoders", name: "t5xxl_fp8_e4m3fn.safetensors", size: 4_893_934_904, url: "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/t5xxl_fp8_e4m3fn.safetensors" },
  { dir: "text_encoders", name: "clip_l.safetensors", size: 246_144_152, url: "https://huggingface.co/comfyanonymous/flux_text_encoders/resolve/main/clip_l.safetensors" },
  { dir: "vae", name: "ae.safetensors", size: 335_304_388, url: "https://huggingface.co/Comfy-Org/Lumina_Image_2.0_Repackaged/resolve/main/split_files/vae/ae.safetensors" },
];
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
  #kontextInstalling: GenState["kontext"]["installing"] = null;
  #kontextError: string | null = null;

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
    const meta = this.#meta();
    return {
      installed: meta !== null,
      installing: this.#installing,
      error: this.#error,
      size: "≈ 19 Go",
      kontext: { installed: !!meta && KONTEXT.every((f) => existsSync(this.#kontextFile(meta, f))), installing: this.#kontextInstalling, error: this.#kontextError, size: "≈ 17 Go" },
    };
  }

  #kontextFile(meta: Installed, f: (typeof KONTEXT)[number]): string {
    return join(meta.main, "..", "models", f.dir, f.name);
  }

  installKontext(): void {
    const meta = this.#meta();
    if (this.#kontextInstalling || !meta || this.state().kontext.installed) return;
    this.#kontextError = null;
    this.#kontextInstalling = { step: "Préparation", progress: 0 };
    void (async () => {
      const total = KONTEXT.reduce((n, f) => n + f.size, 0);
      let before = 0;
      for (const f of KONTEXT) {
        const file = this.#kontextFile(meta, f);
        mkdirSync(join(file, ".."), { recursive: true });
        if (!existsSync(file)) await download(f.url, file, (done) => (this.#kontextInstalling = { step: `Téléchargement de ${f.name}`, progress: (before + done) / total }));
        before += f.size;
      }
    })().then(
      () => (this.#kontextInstalling = null),
      (err: Error) => {
        this.#kontextInstalling = null;
        this.#kontextError = err.message.slice(0, 400);
      },
    );
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
      // Les images de départ vont dans le dossier d'entrée de ComfyUI, sous un nom tiré de leur contenu.
      const input = join(this.#meta()!.main, "..", "input");
      const place = (image: Buffer) => {
        const name = `nidavellir-${createHash("sha256").update(image).digest("hex").slice(0, 16)}.png`;
        mkdirSync(input, { recursive: true });
        if (!existsSync(join(input, name))) writeFileSync(join(input, name), image);
        return name;
      };
      if (req.edit && !this.state().kontext.installed) throw new Error("Flux Kontext n'est pas installé");
      const graph = req.edit ? kontextWorkflow(req, req.edit.images.map(place)) : fluxWorkflow(req, req.init ? place(req.init.image) : undefined);
      const sent = JSON.parse(await http(`${base}/prompt`, "POST", JSON.stringify({ prompt: graph, client_id: "nidavellir" }))) as { prompt_id?: string; error?: { message?: string }; node_errors?: unknown };
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

/**
 * Le graphe ComfyUI de Flux dev (checkpoint fp8 tout-en-un), au format de son API. Avec `init` (nom d'un fichier du
 * dossier d'entrée de ComfyUI), l'image de départ remplace la toile vide et `denoise` dit combien on s'en écarte.
 */
export function fluxWorkflow(req: GenRequest, init?: string): Record<string, unknown> {
  const graph: Record<string, unknown> = {
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
  if (init && req.init) {
    graph["9"] = { class_type: "LoadImage", inputs: { image: init } };
    graph["10"] = { class_type: "VAEEncode", inputs: { pixels: ["9", 0], vae: ["1", 2] } };
    const sampler = graph["6"] as { inputs: Record<string, unknown> };
    sampler.inputs.latent_image = ["10", 0];
    sampler.inputs.denoise = Math.min(1, Math.max(0.1, req.init.denoise));
    delete graph["5"];
  }
  return graph;
}

/**
 * Le graphe de Flux Kontext (ADR-51), d'après le modèle de ComfyUI : chaque image (fichiers du dossier d'entrée) est mise à
 * une taille que Kontext aime, encodée, et donnée en référence ; la première sert aussi de toile. Guidance 2,5.
 */
export function kontextWorkflow(req: GenRequest, images: string[]): Record<string, unknown> {
  const graph: Record<string, unknown> = {
    "1": { class_type: "UNETLoader", inputs: { unet_name: KONTEXT[0]!.name, weight_dtype: "default" } },
    "2": { class_type: "DualCLIPLoader", inputs: { clip_name1: KONTEXT[2]!.name, clip_name2: KONTEXT[1]!.name, type: "flux" } },
    "3": { class_type: "VAELoader", inputs: { vae_name: KONTEXT[3]!.name } },
    "4": { class_type: "CLIPTextEncode", inputs: { text: req.prompt, clip: ["2", 0] } },
  };
  let conditioning: [string, number] = ["4", 0];
  images.forEach((name, k) => {
    const n = 10 + k * 4;
    graph[String(n)] = { class_type: "LoadImage", inputs: { image: name } };
    graph[String(n + 1)] = { class_type: "FluxKontextImageScale", inputs: { image: [String(n), 0] } };
    graph[String(n + 2)] = { class_type: "VAEEncode", inputs: { pixels: [String(n + 1), 0], vae: ["3", 0] } };
    graph[String(n + 3)] = { class_type: "ReferenceLatent", inputs: { conditioning, latent: [String(n + 2), 0] } };
    conditioning = [String(n + 3), 0];
  });
  graph["5"] = { class_type: "FluxGuidance", inputs: { guidance: 2.5, conditioning } };
  graph["6"] = { class_type: "ConditioningZeroOut", inputs: { conditioning: ["4", 0] } };
  graph["7"] = {
    class_type: "KSampler",
    inputs: { model: ["1", 0], seed: req.seed, steps: 20, cfg: 1, sampler_name: "euler", scheduler: "simple", denoise: 1, positive: ["5", 0], negative: ["6", 0], latent_image: ["12", 0] },
  };
  graph["8"] = { class_type: "VAEDecode", inputs: { samples: ["7", 0], vae: ["3", 0] } };
  graph["9"] = { class_type: "SaveImage", inputs: { filename_prefix: "nidavellir", images: ["8", 0] } };
  return graph;
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
