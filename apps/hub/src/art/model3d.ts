import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { download, killTree } from "./imagegen.ts";

/**
 * L'atelier 3D du Directeur artistique (ADR-47, ADR-49) : Tripo fabrique le modèle à partir de l'image de référence (et,
 * si besoin, le squelette et les animations) ; un objet simple n'en a pas besoin. Blender, sans fenêtre, prépare une
 * scène que l'artisan 3D retouche pas à pas : à chaque pas, le hub exécute son code et lui rend photos et mesures. Le hub
 * exporte enfin le .glb aux mesures du jeu et le photographie pour le validateur. Blender s'installe sur votre clic ;
 * Tripo demande votre clé et respecte un plafond mensuel.
 */

export type Model3DState = {
  blender: { installed: boolean; installing: { step: string; progress: number } | null; error: string | null; size: string };
  tripo: { configured: boolean; month: string; credits: number; cap: number };
};

/**
 * Ce que la fiche demande pour la 3D. `simple` : formes simples, modélisées directement dans Blender, sans image ni
 * Tripo. (La figurine de l'ADR-53 est abandonnée, ADR-54 : une ancienne fiche qui la porte est traitée comme les autres.)
 */
export type Model3DSpec = { size: number; tris: number; rig: boolean; animations: string[]; simple?: boolean };

/** `extras` : une animation de plus par fichier (même squelette), que Blender fusionne dans le modèle. */
/** `rigType` : la forme que Tripo a reconnue (biped, quadruped, octopod…), quand un squelette est posé. */
export type TripoResult = { glb: Buffer; credits: number; extras?: Buffer[]; animations?: string[]; rigType?: string; views?: ViewImage[] };
/** Les quatre vues de la planche (ADR-50), dans l'ordre que Tripo attend. */
export const VIEWS = ["front", "left", "back", "right"] as const;
export type View = (typeof VIEWS)[number];
export type ViewImage = { view: View; image: Buffer };
/** Une retouche d'une vue de la planche, en anglais (« move the big pauldron to the left shoulder »). */
export type ViewEdit = { view: View; prompt: string };
/** Le jugement de la planche : les retouches à faire (aucune si elle est cohérente). `round` 2 : après retouche, pour information. */
export type ViewsReview = (views: ViewImage[], round: number) => Promise<ViewEdit[]>;
export type FinishResult = { renders: string[]; tris: number; dims: number[]; animations: string[] };
/** Un pas de l'artisan dans Blender : ce que son code a affiché, ou son erreur. */
export type CodeResult = { ok: boolean; sortie: string; erreur: string | null };
/** Les photos de travail (chemins absolus, dans le dossier de l'atelier) et les mesures de la scène. */
export type Photos = { photos: string[]; mesures: unknown };

export interface Model3DPort {
  state(): Model3DState;
  installBlender(): void;
  /** Le dossier de l'atelier pour un asset (hors du dépôt du jeu) : scène Blender, photos de travail, journaux. */
  atelier(key: string): string;
  /** Vérifie la clé auprès de Tripo, puis la garde dans les données du hub (jamais dans un dépôt). */
  setTripoKey(key: string): Promise<void>;
  /**
   * Image → modèle .glb, avec squelette et animations si demandé. `step` raconte où on en est. Avec `views` (ADR-50),
   * Tripo dessine d'abord la planche (face, gauche, dos, droite), `views` la juge et peut la faire retoucher une fois,
   * puis le modèle est construit à partir des quatre vues ; si la planche échoue, le modèle vient de l'image seule.
   */
  tripo(req: { image: Buffer; ext: string; spec: Model3DSpec; seed: number; step: (s: string) => void; views?: ViewsReview }): Promise<TripoResult>;
  /**
   * Blender prépare la scène de l'atelier dans `dir` : le modèle brut de Tripo (avec ses animations) mis aux mesures,
   * ou une scène vide pour un objet simple que l'artisan modélise lui-même. `palette` : les couleurs de la fiche.
   */
  prepare(req: { dir: string; input: string | null; extras?: string[]; animations?: string[]; spec: Model3DSpec; palette: string[] }): Promise<unknown>;
  /** Le code Python de l'artisan, dans la scène (gardé par une liste blanche) ; la scène est enregistrée s'il réussit. */
  runCode(req: { dir: string; code: string }): Promise<CodeResult>;
  /** Cinq photos de travail (face, trois-quarts, profil, dos, vue de jeu) et les mesures, sans rien changer. */
  photos(req: { dir: string; prefix: string }): Promise<Photos>;
  /** Blender exporte la scène de l'atelier : mesures du jeu, budget, .glb (Y en haut, 1 u = 1 m) et cinq photos. */
  export(req: { dir: string; output: string; rendersDir: string; prefix: string; spec: Model3DSpec }): Promise<FinishResult>;
}

/** Les animations toutes prêtes de Tripo (noms courts, sans « preset: »). */
export const TRIPO_ANIMATIONS = ["idle", "walk", "run", "dive", "climb", "jump", "slash", "shoot", "hurt", "fall", "turn", "quadruped:walk", "hexapod:walk", "octopod:walk", "serpentine:march", "aquatic:march"];
/**
 * La bibliothèque des bipèdes (ADR-52) : plus de 90 animations faites pour le squelette humanoïde v1.0, mieux ajustées
 * que les animations génériques ; « preset:biped:<nom> ». D'après le nœud ComfyUI officiel de Tripo (v0.41.0).
 */
export const TRIPO_BIPED = [
  "afraid", "agree", "angry_01", "angry_02", "angry_03", "basketball_shot", "bow", "box_01", "box_02", "box_03",
  "cast_a_spell", "cheer", "chop", "clap", "climb", "complain_01", "complain_02", "cross_body_crunch", "crossover_dribble", "cry",
  "dance_01", "dance_02", "dance_03", "dance_04", "dance_05", "dance_06", "defeat_02", "defeat_03", "depressed", "dig",
  "dive", "dribble", "fall", "fire", "flee_01", "flee_02", "flip", "fold_arms", "football_catch", "football_save",
  "football_pass", "freaky", "frightened", "front_kick_01", "front_kick_02", "frustrated_01", "frustrated_02", "golf", "greet_01", "greet_02",
  "greet_03", "greet_04", "heart_pose", "hit_to_body_01", "hit_to_body_02", "hit_to_head", "hit_to_side", "hit_to_stomach", "hug", "hurt",
  "idle", "jump_down", "jump", "jump_rope_01", "jump_rope_02", "laugh_01", "laugh_02", "lift_heavy", "look_around", "make_a_call_01",
  "make_a_call_02", "pitch_baseball", "play_mobile_game", "play_video_game", "run_upstairs", "run", "scared_01", "scared_02", "scratch", "shoot",
  "shovel", "sing_01", "sing_02", "sing_03", "sing_04", "sit", "slash", "sob", "standing_relax", "surf",
  "swagger", "swim", "turn", "victory_celebration", "volleyball", "wait", "walk", "warm_up", "wave_goodbye_01", "wave_goodbye_02",
];
/** Animations au plus par modèle (une tâche Tripo chacune). */
export const MAX_ANIMATIONS = 8;
/** Une animation que Tripo sait poser : générique, à forme (« quadruped:walk ») ou de la bibliothèque des bipèdes. */
export const knownAnimation = (a: string) => TRIPO_ANIMATIONS.includes(a) || TRIPO_BIPED.includes(a.replace(/^biped:/, ""));

const TRIPO = "https://openapi.tripo3d.ai";
const TRIPO_MODEL = process.env.STUDIO_TRIPO_MODEL ?? "v3.1-20260211";
/** Le modèle à partir de plusieurs vues : la version que le nœud ComfyUI de Tripo utilise par défaut. */
const TRIPO_MULTIVIEW_MODEL = process.env.STUDIO_TRIPO_MULTIVIEW_MODEL ?? "v3.1-20260211";
const BLENDER_SERIES = "https://download.blender.org/release/Blender4.5/";
const UA = { "user-agent": "nidavellir-hub" };

type TripoTask = { task_id: string; status: string; progress?: number; output?: Record<string, unknown>; error_msg?: string; error_message?: string; credits_consumed?: number };

export class RealModel3D implements Model3DPort {
  readonly #dir: string;
  readonly #cap: number;
  #installing: Model3DState["blender"]["installing"] = null;
  #error: string | null = null;

  constructor(dataDir: string, monthlyCredits = Number(process.env.STUDIO_TRIPO_MONTHLY_CREDITS ?? 2000)) {
    this.#dir = join(dataDir, "tools");
    this.#cap = monthlyCredits;
  }

  // ── Blender ──

  #blender(): string | null {
    const file = join(this.#dir, "blender", "installed.json");
    if (!existsSync(file)) return null;
    try {
      const { exe } = JSON.parse(readFileSync(file, "utf8")) as { exe: string };
      return existsSync(exe) ? exe : null;
    } catch {
      return null;
    }
  }

  installBlender(): void {
    if (this.#installing || this.#blender()) return;
    this.#error = null;
    this.#installing = { step: "Préparation", progress: 0 };
    void this.#installBlender().then(
      () => (this.#installing = null),
      (err: Error) => {
        this.#installing = null;
        this.#error = err.message.slice(0, 400);
      },
    );
  }

  async #installBlender(): Promise<void> {
    const res = await fetch(BLENDER_SERIES, { headers: UA });
    if (!res.ok) throw new Error(`download.blender.org ne répond pas (${res.status})`);
    const names = [...(await res.text()).matchAll(/blender-4\.5\.(\d+)-windows-x64\.zip/g)];
    const patch = Math.max(...names.map((m) => Number(m[1])));
    if (!Number.isFinite(patch)) throw new Error("Aucune version Windows de Blender 4.5 trouvée");
    const name = `blender-4.5.${patch}-windows-x64.zip`;
    const root = join(this.#dir, "blender");
    mkdirSync(root, { recursive: true });
    const zip = join(root, name);
    const total = 400_000_000;
    await download(`${BLENDER_SERIES}${name}`, zip, (done) => (this.#installing = { step: "Téléchargement de Blender", progress: Math.min(0.95, done / total) }));
    this.#installing = { step: "Décompression de Blender", progress: 0.96 };
    const dest = join(root, `4.5.${patch}`);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    await new Promise<void>((resolve, reject) => execFile("tar", ["-xf", zip, "-C", dest], { windowsHide: true }, (err) => (err ? reject(new Error(`Archive illisible : ${err.message.slice(0, 200)}`)) : resolve())));
    rmSync(zip, { force: true });
    const exe = findExe(dest, "blender.exe");
    if (!exe) throw new Error("blender.exe introuvable dans l'archive");
    writeFileSync(join(root, "installed.json"), JSON.stringify({ version: `4.5.${patch}`, exe }, null, 2));
  }

  atelier(key: string): string {
    return join(this.#dir, "blender", "atelier", key.replace(/[^\w-]/g, "_"));
  }

  async prepare(req: { dir: string; input: string | null; extras?: string[]; animations?: string[]; spec: Model3DSpec; palette: string[] }): Promise<unknown> {
    rmSync(req.dir, { recursive: true, force: true });
    mkdirSync(req.dir, { recursive: true });
    writeFileSync(join(req.dir, "atelier.json"), JSON.stringify({ palette: req.palette }), "utf8");
    return this.#run(null, req.dir, "preparation", {
      mode: "prepare",
      blend: join(req.dir, "scene.blend"),
      input: req.input,
      extras: req.extras ?? [],
      animations: req.animations ?? [],
      size: req.spec.size,
      max_tris: req.spec.tris,
      max_texture: maxTexture(req.spec),
    });
  }

  async runCode(req: { dir: string; code: string }): Promise<CodeResult> {
    const { palette } = JSON.parse(readFileSync(join(req.dir, "atelier.json"), "utf8")) as { palette: string[] };
    const r = (await this.#run(join(req.dir, "scene.blend"), req.dir, "pas", { mode: "python", blend: join(req.dir, "scene.blend"), code: req.code, palette }).catch((err: Error) => ({ ok: false, sortie: "", erreur: err.message }))) as CodeResult;
    return { ok: !!r.ok, sortie: String(r.sortie ?? ""), erreur: r.erreur ?? null };
  }

  async photos(req: { dir: string; prefix: string }): Promise<Photos> {
    return (await this.#run(join(req.dir, "scene.blend"), req.dir, "photos", { mode: "photos", out_dir: req.dir, prefix: req.prefix })) as Photos;
  }

  async export(req: { dir: string; output: string; rendersDir: string; prefix: string; spec: Model3DSpec }): Promise<FinishResult> {
    mkdirSync(req.rendersDir, { recursive: true });
    const s = (await this.#run(join(req.dir, "scene.blend"), req.dir, req.prefix, {
      mode: "export",
      output: req.output,
      out_dir: req.rendersDir,
      prefix: req.prefix,
      size: req.spec.size,
      max_tris: req.spec.tris,
      max_texture: maxTexture(req.spec),
    })) as { renders: string[]; tris_after: number; dims: number[]; animations: string[] };
    return { renders: s.renders, tris: s.tris_after, dims: s.dims.map((d) => Math.round(d * 100) / 100), animations: s.animations };
  }

  /** Blender sans fenêtre sur le script de l'atelier ; son journal reste dans le dossier de l'atelier. */
  async #run(blend: string | null, dir: string, name: string, job: Record<string, unknown>): Promise<unknown> {
    const exe = this.#blender();
    if (!exe) throw new Error("Blender n'est pas installé");
    const jobFile = join(dir, `${name}.json`);
    const result = join(dir, `${name}-resultat.json`);
    rmSync(result, { force: true });
    writeFileSync(jobFile, JSON.stringify({ ...job, result }), "utf8");
    const log: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(exe, ["--factory-startup", "-b", ...(blend ? [blend] : []), "--python", WORKSHOP_PY, "--", jobFile], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const timer = setTimeout(() => killTree(child.pid), 15 * 60_000);
      const keep = (b: Buffer) => log.push(...b.toString("utf8").split(/\r?\n/).filter(Boolean).slice(-50));
      child.stdout?.on("data", keep);
      child.stderr?.on("data", keep);
      child.on("error", (e) => reject(new Error(`Blender ne se lance pas : ${e.message}`)));
      child.on("close", (code) => {
        clearTimeout(timer);
        writeFileSync(join(dir, `${name}.log`), log.slice(-400).join("\n"), "utf8");
        if (code === 0 && existsSync(result)) resolve();
        else reject(new Error(`Blender s'est arrêté (code ${code}) : ${log.filter((l) => /error|erreur|traceback|aucun maillage/i.test(l)).slice(-3).join(" | ").slice(0, 300) || "voir le journal"}`));
      });
    });
    return JSON.parse(readFileSync(result, "utf8"));
  }

  // ── Tripo ──

  #key(): string | null {
    const file = join(this.#dir, "tripo", "key.json");
    if (!existsSync(file)) return null;
    try {
      return (JSON.parse(readFileSync(file, "utf8")) as { key: string }).key || null;
    } catch {
      return null;
    }
  }

  #usage(): { month: string; credits: number } {
    const month = new Date().toISOString().slice(0, 7);
    const file = join(this.#dir, "tripo", "usage.json");
    try {
      const u = JSON.parse(readFileSync(file, "utf8")) as { month: string; credits: number };
      return u.month === month ? u : { month, credits: 0 };
    } catch {
      return { month, credits: 0 };
    }
  }

  #spend(credits: number): void {
    const u = this.#usage();
    mkdirSync(join(this.#dir, "tripo"), { recursive: true });
    writeFileSync(join(this.#dir, "tripo", "usage.json"), JSON.stringify({ month: u.month, credits: u.credits + credits }), "utf8");
  }

  state(): Model3DState {
    const u = this.#usage();
    return {
      blender: { installed: this.#blender() !== null, installing: this.#installing, error: this.#error, size: "≈ 400 Mo" },
      tripo: { configured: this.#key() !== null, month: u.month, credits: u.credits, cap: this.#cap },
    };
  }

  async setTripoKey(key: string): Promise<void> {
    const k = key.trim();
    if (!/^tsk_[\w-]{10,}$/.test(k)) throw new Error("Une clé Tripo commence par « tsk_ » (page « API Keys » de platform.tripo3d.ai)");
    await this.#api(k, "GET", "/v3/account/balance");
    mkdirSync(join(this.#dir, "tripo"), { recursive: true });
    writeFileSync(join(this.#dir, "tripo", "key.json"), JSON.stringify({ key: k }), "utf8");
  }

  async tripo(req: { image: Buffer; ext: string; spec: Model3DSpec; seed: number; step: (s: string) => void; views?: ViewsReview }): Promise<TripoResult> {
    const key = this.#key();
    if (!key) throw new Error("Ajoutez d'abord votre clé Tripo");
    const u = this.#usage();
    if (u.credits >= this.#cap) throw new Error(`Plafond mensuel Tripo atteint (${u.credits} crédits sur ${this.#cap}) : il repart le mois prochain`);
    let credits = 0;
    let reused = false;
    const run = async (label: string, path: string, body: Record<string, unknown>): Promise<TripoTask> => {
      req.step(label);
      const { task_id } = (await this.#api(key, "POST", path, body)) as { task_id: string };
      const deadline = Date.now() + 20 * 60_000;
      for (let wait = 2000; ; wait = Math.min(wait * 2, 15_000)) {
        await new Promise((r) => setTimeout(r, wait));
        const t = (await this.#api(key, "GET", `/v3/tasks/${task_id}`)) as TripoTask;
        const status = String(t.status).toLowerCase();
        if (status === "success") {
          credits += Number(t.credits_consumed ?? 0);
          return t;
        }
        if (["failed", "cancelled", "banned", "expired", "unknown"].includes(status)) throw new Error(`Tripo : ${label} a échoué (${t.error_msg ?? t.error_message ?? status})`);
        if (Date.now() > deadline) throw new Error(`Tripo : ${label} a pris plus de 20 minutes`);
        if (typeof t.progress === "number") req.step(`${label} (${t.progress} %)`);
      }
    };
    // Un modèle déjà payé dont la suite (squelette, animations) a échoué : on repart de lui au lieu de le refaire.
    const reuse = { image: createHash("sha256").update(req.image).digest("hex"), tris: req.spec.tris };
    const pending = this.#pending();
    try {
      let model: TripoTask;
      let views: ViewImage[] | undefined;
      if (pending && pending.image === reuse.image && pending.tris === reuse.tris) {
        req.step("Tripo reprend le modèle déjà fabriqué");
        model = { task_id: pending.task, status: "success" };
        reused = true;
      } else {
        const token = await this.#upload(key, req.image, req.ext);
        // La texture de Tripo porte les détails du modèle, Blender ne la repeint plus (ADR-54) : toujours détaillée. Un modèle
        // à squelette se déforme en bougeant : géométrie détaillée aussi (ADR-52).
        const shape = {
          face_limit: Math.max(1000, req.spec.tris),
          model_seed: req.seed,
          texture_seed: req.seed,
          texture_quality: "detailed",
          ...(req.spec.rig ? { geometry_quality: "detailed" } : {}),
        };
        // La planche d'abord : le dos et les côtés viennent de vues dessinées, pas devinés par Tripo.
        let made: TripoTask | null = null;
        if (req.views) {
          try {
            const planche = await this.#planche(key, run, token, req.views, req.step);
            made = await run("Tripo fabrique le modèle à partir des quatre vues", "/v3/generation/multiview-to-model", {
              inputs: VIEWS.map((v) => ({ [v]: planche.urls[v] })),
              model: TRIPO_MULTIVIEW_MODEL,
              ...shape,
            });
            views = planche.images;
          } catch (err) {
            req.step(`Planche impossible (${(err as Error).message.slice(0, 160)}) : modèle tiré de l'image seule`);
          }
        }
        // Depuis une seule image : la texture v3.5 retire l'éclairage peint dans l'image (des couleurs propres, sans ombres
        // cuites), et le modèle regarde comme l'image, de face.
        model =
          made ??
          (await run("Tripo fabrique le modèle", "/v3/generation/image-to-model", {
            input: token,
            model: TRIPO_MODEL,
            ...shape,
            texture_version: "v3.5-20260815",
            delight: true,
            orientation: "align_image",
          }));
        if (req.spec.rig) this.#setPending({ ...reuse, task: model.task_id });
      }
      let last = model;
      const extras: Buffer[] = [];
      let names: string[] = [];
      let rigType: string | undefined;
      if (req.spec.rig) {
        const check = await run("Tripo vérifie qu'on peut poser un squelette", "/v3/animations/rig-check", { input: model.task_id });
        if (check.output?.riggable === false) throw new Error("Tripo ne sait pas poser de squelette sur ce modèle (forme non reconnue)");
        const type = String(check.output?.rig_type ?? "biped").toLowerCase();
        rigType = type;
        // L'ancien squelette (v1.0) ne connaît que les bipèdes : quatre pattes, ailes, serpents… passent par le v2.5.
        const rig = await run("Tripo pose le squelette", "/v3/animations/rig", { input: model.task_id, model: type === "biped" ? "v1.0-20240301" : "v2.5-20260210", rig_type: type });
        last = rig;
        names = rigAnimations(type, req.spec.animations);
        // Une animation par tâche : la première porte le modèle, les suivantes sont fusionnées par Blender.
        for (const [i, name] of names.entries()) {
          const anim = await run(`Tripo applique l'animation « ${name} » (${i + 1}/${names.length})`, "/v3/animations/retarget", {
            input: rig.task_id,
            animation: `preset:${name}`,
            out_format: "glb",
            export_with_geometry: true,
            animate_in_place: true,
          });
          if (i === 0) last = anim;
          else extras.push(await this.#fetchModel(anim, req.step));
        }
      }
      const glb = await this.#fetchModel(last, req.step);
      this.#setPending(null);
      // Les noms montrés au jeu, sans le préfixe de la bibliothèque : « walk », pas « biped:walk ».
      return { glb, credits, extras, animations: names.map((n) => n.replace(/^biped:/, "")), rigType, views };
    } catch (err) {
      // Le modèle repris a peut-être expiré chez Tripo : la prochaine fois, on le refait.
      if (reused) this.#setPending(null);
      throw err;
    } finally {
      if (credits) this.#spend(credits);
    }
  }

  /** La planche : Tripo dessine les quatre vues ; elles sont jugées, retouchées une fois si besoin, puis rejugées. */
  async #planche(
    key: string,
    run: (label: string, path: string, body: Record<string, unknown>) => Promise<TripoTask>,
    token: string,
    review: ViewsReview,
    step: (s: string) => void,
  ): Promise<{ urls: Record<View, string>; images: ViewImage[] }> {
    const task = await run("Tripo dessine la planche (face, gauche, dos, droite)", "/v3/generation/image-to-multiview", { input: token });
    let urls = viewUrls(task, null);
    let images = await this.#viewImages(urls, step);
    const edits = await review(images, 1);
    if (edits.length) {
      const edited = await run(`Tripo retouche la planche (${edits.map((e) => e.view).join(", ")})`, "/v3/generation/edit-multiview", {
        input: task.task_id,
        prompts: edits.map((e) => ({ view: e.view, prompt: e.prompt.slice(0, 1024) })),
      });
      // Les vues non retouchées peuvent manquer dans la réponse : on garde alors celles d'avant.
      urls = viewUrls(edited, urls);
      images = await this.#viewImages(urls, step);
      await review(images, 2);
    }
    return { urls, images };
  }

  async #viewImages(urls: Record<View, string>, step: (s: string) => void): Promise<ViewImage[]> {
    step("Téléchargement de la planche");
    return Promise.all(
      VIEWS.map(async (view) => {
        const res = await fetch(urls[view], { headers: UA });
        if (!res.ok) throw new Error(`vue « ${view} » introuvable (${res.status})`);
        return { view, image: Buffer.from(await res.arrayBuffer()) };
      }),
    );
  }

  async #fetchModel(task: TripoTask, step: (s: string) => void): Promise<Buffer> {
    const o = task.output ?? {};
    const url = [o.model_url, o.pbr_model_url, o.model, o.pbr_model].find((v): v is string => typeof v === "string" && v.startsWith("http"));
    if (!url) throw new Error("Tripo n'a pas rendu de modèle");
    step("Téléchargement du modèle");
    const res = await fetch(url, { headers: UA });
    if (!res.ok) throw new Error(`Téléchargement du modèle impossible (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }

  #pending(): { image: string; tris: number; task: string } | null {
    try {
      return JSON.parse(readFileSync(join(this.#dir, "tripo", "pending.json"), "utf8")) as { image: string; tris: number; task: string };
    } catch {
      return null;
    }
  }

  #setPending(p: { image: string; tris: number; task: string } | null): void {
    const file = join(this.#dir, "tripo", "pending.json");
    if (!p) return rmSync(file, { force: true });
    mkdirSync(join(this.#dir, "tripo"), { recursive: true });
    writeFileSync(file, JSON.stringify(p), "utf8");
  }

  async #upload(key: string, image: Buffer, ext: string): Promise<string> {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(image)], { type: ext === "jpg" ? "image/jpeg" : `image/${ext}` }), `image.${ext}`);
    const data = (await this.#api(key, "POST", "/v3/files", form)) as { file_token?: string };
    if (!data.file_token) throw new Error("Tripo n'a pas accepté l'image");
    return data.file_token;
  }

  async #api(key: string, method: "GET" | "POST", path: string, body?: Record<string, unknown> | FormData): Promise<unknown> {
    const json = body && !(body instanceof FormData);
    const res = await fetch(`${TRIPO}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, ...UA, ...(json ? { "content-type": "application/json" } : {}) },
      body: body ? (json ? JSON.stringify(body) : (body as FormData)) : undefined,
    });
    const text = await res.text();
    let payload: { code?: number; message?: string; data?: unknown; status?: string } = {};
    try {
      payload = text ? (JSON.parse(text) as typeof payload) : {};
    } catch {
      /* réponse non JSON : traitée par le code HTTP */
    }
    if (res.status === 401 || res.status === 403) throw new Error("Tripo refuse la clé");
    if (!res.ok || (payload.code !== undefined && payload.code !== 0)) throw new Error(`Tripo répond ${res.status}${payload.message ? ` : ${payload.message}` : ""}`);
    return payload.data ?? payload;
  }
}

/** Les textures gardées dans le .glb : un personnage animé, vu de près, garde plus de détail qu'un décor. */
function maxTexture(spec: Model3DSpec): number {
  return spec.rig ? 2048 : 1024;
}

/**
 * Les animations demandées que ce squelette sait jouer (noms des préréglages Tripo, sans « preset: »). Le type de
 * squelette est celui que Tripo reconnaît sur le modèle, pas celui que la fiche espérait : une marche « à quatre pattes »
 * demandée pour un modèle que Tripo voit à huit pattes devient la marche à huit pattes, au lieu de disparaître. Un bipède
 * prend la version de la bibliothèque des bipèdes quand elle existe (« biped:walk »), sinon l'animation générique.
 */
export function rigAnimations(type: string, wanted: string[]): string[] {
  const out = new Set<string>();
  // La seule façon de se déplacer que Tripo connaît pour chaque squelette non bipède.
  const gait = TRIPO_ANIMATIONS.find((a) => a.startsWith(`${type}:`));
  for (const w of wanted) {
    const move = w.includes(":") ? w.split(":")[1]! : w;
    let name: string | null;
    if (type === "biped") name = TRIPO_BIPED.includes(move) ? `biped:${move}` : TRIPO_ANIMATIONS.includes(move) ? move : null;
    else if (TRIPO_ANIMATIONS.includes(`${type}:${move}`)) name = `${type}:${move}`;
    else name = ["walk", "run", "march"].includes(move) ? (gait ?? null) : null;
    if (name && knownAnimation(name)) out.add(name);
  }
  return [...out].slice(0, MAX_ANIMATIONS);
}

/** Les adresses des quatre vues d'une tâche de planche (`front_view_url`…), complétées par `before` s'il en manque. */
function viewUrls(task: TripoTask, before: Record<View, string> | null): Record<View, string> {
  const out = (task.output?.generate_multiview_image ?? {}) as Record<string, unknown>;
  const urls = {} as Record<View, string>;
  for (const v of VIEWS) {
    const u = out[`${v}_view_url`] ?? out[v];
    if (typeof u === "string" && u.startsWith("http")) urls[v] = u;
    else if (before) urls[v] = before[v];
    else throw new Error("Tripo n'a pas rendu les quatre vues");
  }
  return urls;
}

function findExe(dir: string, name: string): string | null {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isFile() && e.name.toLowerCase() === name) return p;
    if (e.isDirectory()) {
      const found = findExe(p, name);
      if (found) return found;
    }
  }
  return null;
}

/** Le script Blender de l'atelier, à côté de ce fichier. */
const WORKSHOP_PY = fileURLToPath(new URL("./blender/workshop.py", import.meta.url));
