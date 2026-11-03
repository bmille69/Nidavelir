import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SheetPort } from "./google-images.ts";
import { download, killTree } from "./imagegen.ts";
import { orderFingerprint, TripoJournal } from "./tripo-journal.ts";

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
/** `facettes` (ADR-114) : style low-poly à facettes, chaque face plate et son arête franche (au lieu du lissage de Tripo). */
export type Model3DSpec = { size: number; tris: number; rig: boolean; animations: string[]; simple?: boolean; facettes?: boolean };

/** `extras` : une animation de plus par fichier (même squelette), que Blender fusionne dans le modèle. */
/** `rigType` : la forme que Tripo a reconnue (biped, quadruped, octopod…), quand un squelette est posé. */
/** `rigTask` : la tâche Tripo du squelette, pour lui poser d'autres animations plus tard sans refaire le modèle (ADR-56). */
export type TripoResult = { glb: Buffer; credits: number; extras?: Buffer[]; animations?: string[]; rigType?: string; rigTask?: string; rigModel?: string; views?: ViewImage[] };
/** Les quatre vues de la planche (ADR-50), dans l'ordre que Tripo attend. */
export const VIEWS = ["front", "left", "back", "right"] as const;
export type View = (typeof VIEWS)[number];
export type ViewImage = { view: View; image: Buffer };
/**
 * L'angle sous lequel l'image de référence montre le sujet (ADR-115), dit par le validateur qui la retient. Le sens d'un
 * profil est le côté de l'IMAGE vers lequel regarde le sujet.
 */
export type Orientation = "face" | "profil_droite" | "profil_gauche" | "trois_quarts" | "dos";
export const ORIENTATIONS: Orientation[] = ["face", "profil_droite", "profil_gauche", "trois_quarts", "dos"];
/**
 * La case de la planche que l'image de référence montre déjà. Convention des cases de Tripo : l'ordre [front, left, back,
 * right] vient du SDK officiel (tripo3d `multiview_to_model` : « images: [front, left, back, right] ») ; le sens de left
 * et right n'y est pas écrit. Celui du studio, tenu depuis l'ADR-50 et confirmé par les planches de Tripo et de Google
 * acceptées en essai réel (le Héron, ADR-110) : la gauche et la droite DU SUJET. Un sujet tourné vers la droite de
 * l'image montre au spectateur son flanc DROIT (de face, sa main droite est à gauche de l'image ; tourné d'un quart vers
 * la droite de l'image, son flanc droit vient vers la caméra) : case « right ». Vers la gauche de l'image : « left ».
 * Trois-quarts : la face reste la meilleure case (comportement d'avant).
 */
export function referenceView(o: Orientation | undefined): View {
  return o === "profil_droite" ? "right" : o === "profil_gauche" ? "left" : o === "dos" ? "back" : "front";
}
/** Une retouche d'une vue de la planche, en anglais (« move the big pauldron to the left shoulder »). */
export type ViewEdit = { view: View; prompt: string };
/**
 * Le jugement de la planche : les retouches à faire (aucune si elle est cohérente). `round` 2 : après retouche, pour
 * information. `by` : qui l'a dessinée, et donc qui la retouche (ADR-110).
 */
export type ViewsReview = (views: ViewImage[], round: number, by?: "tripo" | "google") => Promise<ViewEdit[]>;
/** `bandes` : une bande d'images par animation (ADR-56), pour juger le mouvement ; `durees` en secondes. */
/** Les défauts invisibles sur une photo, mesurés par Blender (ADR-63). */
export type Geometry = { faces_retournees: number; petits_morceaux: number; faces_nulles: number; aretes_ouvertes: number; objets: { nom: string }[] };
export type FinishResult = { renders: string[]; bandes: string[]; tris: number; dims: number[]; animations: string[]; durees: { nom: string; duree_s: number }[]; controle?: Geometry | null };
/** Un pas de l'artisan dans Blender : ce que son code a affiché, ou son erreur. */
/** `sante` (ADR-116) : la santé de la scène avant et après ce code, mesurée par Blender ; la scène d'avant est gardée. */
export type CodeResult = { ok: boolean; sortie: string; erreur: string | null; sante?: { avant: unknown; apres: unknown } | null };
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
   * puis le modèle est construit à partir des quatre vues ; si la planche échoue, le modèle vient de l'image seule. Avec
   * `sheet` (ADR-110), Google dessine la planche à la place de Tripo ; si Google échoue, c'est la planche de Tripo.
   * `reference` (ADR-115) : la case que l'image montre ; hors face, la planche de Tripo n'est jamais commandée (elle
   * suppose une image de face et échouerait, crédits perdus).
   */
  tripo(req: { image: Buffer; ext: string; spec: Model3DSpec; seed: number; step: (s: string) => void; views?: ViewsReview; sheet?: SheetPort; reference?: View }): Promise<TripoResult>;
  /**
   * Blender prépare la scène de l'atelier dans `dir` : le modèle brut de Tripo (avec ses animations) mis aux mesures,
   * ou une scène vide pour un objet simple que l'artisan modélise lui-même. `palette` : les couleurs de la fiche.
   */
  prepare(req: { dir: string; input: string | null; extras?: string[]; animations?: string[]; spec: Model3DSpec; palette: string[] }): Promise<unknown>;
  /** Le code Python de l'artisan, dans la scène (gardé par une liste blanche) ; la scène est enregistrée s'il réussit. */
  runCode(req: { dir: string; code: string }): Promise<CodeResult>;
  /** Une copie de la scène de l'atelier sous ce nom, dans son dossier (ADR-116) : rien si la scène n'existe pas encore. */
  snapshot(req: { dir: string; name: string }): Promise<void>;
  /**
   * La scène revient à une copie (ADR-116) : `name` est « scene-avant-pas.blend » (gardée par workshop.py avant chaque
   * code de l'artisan) ou une copie faite par `snapshot`.
   */
  restore(req: { dir: string; name: string }): Promise<void>;
  /** Cinq photos de travail (face, trois-quarts, profil, dos, vue de jeu) et les mesures, sans rien changer. */
  photos(req: { dir: string; prefix: string }): Promise<Photos>;
  /** Blender exporte la scène de l'atelier : mesures du jeu, budget, .glb (Y en haut, 1 u = 1 m), cinq photos et les bandes d'animation. */
  export(req: { dir: string; output: string; rendersDir: string; prefix: string; spec: Model3DSpec }): Promise<FinishResult>;
  /** D'autres animations sur un squelette déjà payé (ADR-56) : un fichier par animation, 10 crédits chacune. */
  animate(req: { rigTask: string; names: string[]; step: (s: string) => void }): Promise<{ glbs: Buffer[]; credits: number }>;
  /** Blender ajoute (ou remplace) ces animations dans la scène de l'atelier et retire celles hors de `keep`. */
  addAnimations(req: { dir: string; extras: string[]; animations: string[]; keep: string[] }): Promise<unknown>;
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
/** Les animations de base, les seules que connaît le squelette humanoïde v3.0 (« preset:walk »). */
const BASIC = TRIPO_ANIMATIONS.filter((a) => !a.includes(":"));
/** Le squelette humanoïde d'octobre 2026, meilleur que le v1.0 mais sans sa bibliothèque ; même prix en crédits. */
export const RIG_V3 = "v3.0-20260909";
export const RIG_V1 = "v1.0-20240301";
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
/** Les commandes d'une fabrication : crédits comptés, empreintes utilisées, tâches reprises du carnet (numéro → empreinte). */
type Orders = { credits: number; used: string[]; reused: Map<string, string> };
/** Passer (ou reprendre) une commande : `same` est ce qui l'identifie, `body` ce qui est envoyé à Tripo. */
type Order = (label: string, path: string, same: Record<string, unknown>, body: () => Record<string, unknown> | Promise<Record<string, unknown>>) => Promise<TripoTask>;

/** Une réponse d'erreur de Tripo, avec son code HTTP. */
class TripoHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Une planche jugée : ses quatre vues, ce qui l'identifie dans le carnet (tâches Tripo ou empreintes des images), et les
 * entrées de `multiview-to-model` (adresses de Tripo, ou jetons des vues téléversées).
 */
type Planche = { images: ViewImage[]; from: string[]; inputs: () => Promise<Record<string, string>[]> };

/** Tripo a fait échouer la tâche ou ne la connaît pas (plus) : rien à reprendre. */
class TripoGone extends Error {}

export class RealModel3D implements Model3DPort {
  readonly #dir: string;
  readonly #cap: number;
  /** Le carnet de commandes (ADR-70) : une commande payée n'est jamais repassée. */
  readonly #journal: TripoJournal;
  #installing: Model3DState["blender"]["installing"] = null;
  #error: string | null = null;

  constructor(dataDir: string, monthlyCredits = Number(process.env.STUDIO_TRIPO_MONTHLY_CREDITS ?? 2000)) {
    this.#dir = join(dataDir, "tools");
    this.#cap = monthlyCredits;
    this.#journal = new TripoJournal(join(this.#dir, "tripo", "journal.json"));
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
      facettes: !!req.spec.facettes,
    });
  }

  async runCode(req: { dir: string; code: string }): Promise<CodeResult> {
    const { palette } = JSON.parse(readFileSync(join(req.dir, "atelier.json"), "utf8")) as { palette: string[] };
    const r = (await this.#run(join(req.dir, "scene.blend"), req.dir, "pas", { mode: "python", blend: join(req.dir, "scene.blend"), code: req.code, palette }).catch((err: Error) => ({ ok: false, sortie: "", erreur: err.message }))) as CodeResult;
    return { ok: !!r.ok, sortie: String(r.sortie ?? ""), erreur: r.erreur ?? null, sante: r.sante ?? null };
  }

  async snapshot(req: { dir: string; name: string }): Promise<void> {
    if (existsSync(join(req.dir, "scene.blend"))) copyFileSync(join(req.dir, "scene.blend"), join(req.dir, basename(req.name)));
  }

  async restore(req: { dir: string; name: string }): Promise<void> {
    await this.#run(null, req.dir, "restaurer", { mode: "restaurer", source: join(req.dir, basename(req.name)), blend: join(req.dir, "scene.blend") });
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
      facettes: !!req.spec.facettes,
    })) as { renders: string[]; bandes?: string[]; tris_after: number; dims: number[]; animations: string[]; durees?: { nom: string; duree_s: number }[]; controle?: Geometry };
    return { renders: s.renders, bandes: s.bandes ?? [], tris: s.tris_after, dims: s.dims.map((d) => Math.round(d * 100) / 100), animations: s.animations, durees: s.durees ?? [], controle: s.controle ?? null };
  }

  async addAnimations(req: { dir: string; extras: string[]; animations: string[]; keep: string[] }): Promise<unknown> {
    return this.#run(join(req.dir, "scene.blend"), req.dir, "animations", { mode: "animations", blend: join(req.dir, "scene.blend"), extras: req.extras, animations: req.animations, garder: req.keep });
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

  async tripo(req: { image: Buffer; ext: string; spec: Model3DSpec; seed: number; step: (s: string) => void; views?: ViewsReview; sheet?: SheetPort; reference?: View }): Promise<TripoResult> {
    const key = this.#key();
    if (!key) throw new Error("Ajoutez d'abord votre clé Tripo");
    const u = this.#usage();
    if (u.credits >= this.#cap) throw new Error(`Plafond mensuel Tripo atteint (${u.credits} crédits sur ${this.#cap}) : il repart le mois prochain`);
    const o: Orders = { credits: 0, used: [], reused: new Map() };
    const order: Order = (label, path, same, body) => this.#order(key, o, req.step, label, path, same, body);
    // L'image n'est envoyée que si une commande en a besoin : une fabrication reprise n'en a pas besoin.
    const image = createHash("sha256").update(req.image).digest("hex");
    let uploaded: Promise<string> | null = null;
    const token = () => (uploaded ??= this.#upload(key, req.image, req.ext));
    // La texture de Tripo porte les détails du modèle, Blender ne la repeint plus (ADR-54) : toujours détaillée. Un modèle
    // à squelette se déforme en bougeant, un objet vu de près remplit l'écran : géométrie détaillée aussi (ADR-52, ADR-80).
    // Les graines ne font pas partie de l'empreinte : une fabrication interrompue reprend sa commande, quelle que soit la
    // graine tirée à la relance.
    const quality = { face_limit: Math.max(1000, req.spec.tris), texture_quality: "detailed", ...(closeUp(req.spec) ? { geometry_quality: "detailed" } : {}) };
    const shape = { ...quality, model_seed: req.seed, texture_seed: req.seed };
    let model: TripoTask | null = null;
    let views: ViewImage[] | undefined;
    // La texture v3.5 retire l'éclairage peint dans les images (des couleurs propres, sans ombres cuites) et colle à leurs
    // couleurs : sur les deux voies, la planche comme l'image seule (ADR-109).
    const texture = { texture_version: "v3.5-20260815", delight: true, texture_alignment: "original_image" };
    // La planche d'abord : le dos et les côtés viennent de vues dessinées, pas devinés par Tripo. Une planche que le
    // validateur juge infidèle à l'image, même retouchée, est abandonnée : l'image seule, fidèle de face, vaut mieux.
    if (req.views) {
      try {
        // Google d'abord s'il est là (ADR-110) ; s'il se dérobe avant le jugement, la planche de Tripo, comme avant.
        // Une référence de profil ou de dos (ADR-115) : seul Google sait placer l'image dans sa case.
        const google = req.sheet ? await this.#googlePlanche(key, req.sheet, req.views, req.step) : null;
        if (!google && (req.reference ?? "front") !== "front") throw new Error("référence hors face, que la planche de Tripo ne sait pas tourner");
        const planche = google ?? (await this.#planche(order, token, image, req.views, req.step));
        model = await order(
          "Tripo fabrique le modèle à partir des quatre vues",
          "/v3/generation/multiview-to-model",
          { from: planche.from, model: TRIPO_MULTIVIEW_MODEL, ...texture, ...quality },
          async () => ({ inputs: await planche.inputs(), model: TRIPO_MULTIVIEW_MODEL, ...texture, ...shape }),
        );
        views = planche.images;
      } catch (err) {
        req.step(`Planche écartée (${(err as Error).message.slice(0, 160)}) : modèle tiré de l'image seule`);
      }
    }
    // Depuis une seule image : le modèle regarde comme l'image (la référence : de face, ou de profil, que l'artisan tourne).
    const single = { model: TRIPO_MODEL, ...texture, orientation: "align_image" };
    model ??= await order("Tripo fabrique le modèle", "/v3/generation/image-to-model", { image, ...single, ...quality }, async () => ({ input: await token(), ...single, ...shape }));
    let last = model;
    const extras: Buffer[] = [];
    let names: string[] = [];
    let rigType: string | undefined;
    let rigTask: string | undefined;
    let rigModel: string | undefined;
    if (req.spec.rig) {
      const input = model.task_id;
      const check = await order("Tripo vérifie qu'on peut poser un squelette", "/v3/animations/rig-check", { input }, () => ({ input }));
      if (check.output?.riggable === false) throw new Error(`Tripo ne sait pas poser de squelette sur ce modèle (forme non reconnue). ${RIG_RECIPE}`);
      const type = String(check.output?.rig_type ?? "biped").toLowerCase();
      rigType = type;
      names = rigAnimations(type, req.spec.animations);
      // Quatre pattes, ailes, serpents… passent par le v2.5 ; un bipède prend le v3.0 si ses animations sont toutes de base,
      // sinon le v1.0, seul à porter la bibliothèque des bipèdes.
      rigModel = type !== "biped" ? "v2.5-20260210" : names.some((n) => n.startsWith("biped:")) ? RIG_V1 : RIG_V3;
      const rig = await this.#rig(order, { input, model: rigModel, rig_type: type }, req.step);
      last = rig;
      rigTask = rig.task_id;
      // Une animation par tâche : la première porte le modèle, les suivantes sont fusionnées par Blender.
      for (const [i, name] of names.entries()) {
        const anim = await this.#retarget(order, rig.task_id, name, `Tripo applique l'animation « ${name} » (${i + 1}/${names.length})`);
        if (i === 0) last = anim;
        else extras.push(await this.#fetchModel(anim, req.step));
      }
    }
    const glb = await this.#fetchModel(last, req.step);
    // Fabrication réussie : ses commandes sont livrées, la prochaine fabrication en passera de nouvelles.
    this.#journal.drop(...o.used);
    // Les noms montrés au jeu, sans le préfixe de la bibliothèque : « walk », pas « biped:walk ».
    return { glb, credits: o.credits, extras, animations: names.map((n) => n.replace(/^biped:/, "")), rigType, rigTask, rigModel, views };
  }

  /** D'autres animations sur le squelette déjà payé : si Tripo ne connaît plus la tâche (elle expire), l'appelant refait tout. */
  async animate(req: { rigTask: string; names: string[]; step: (s: string) => void }): Promise<{ glbs: Buffer[]; credits: number }> {
    const key = this.#key();
    if (!key) throw new Error("Ajoutez d'abord votre clé Tripo");
    const u = this.#usage();
    if (u.credits >= this.#cap) throw new Error(`Plafond mensuel Tripo atteint (${u.credits} crédits sur ${this.#cap}) : il repart le mois prochain`);
    const o: Orders = { credits: 0, used: [], reused: new Map() };
    const order: Order = (label, path, same, body) => this.#order(key, o, req.step, label, path, same, body);
    const glbs: Buffer[] = [];
    for (const [i, name] of req.names.entries()) {
      const t = await this.#retarget(order, req.rigTask, name, `Tripo applique l'animation « ${name} » (${i + 1}/${req.names.length})`);
      glbs.push(await this.#fetchModel(t, req.step));
    }
    this.#journal.drop(...o.used);
    return { glbs, credits: o.credits };
  }

  /**
   * Le squelette, contrôlé avant de payer les animations : Tripo en rend parfois un incomplet (sans jambes, un seul bras),
   * et chaque animation posée dessus en hériterait. Le même modèle donne un bon squelette à l'essai suivant : on en refait
   * jusqu'à deux (un squelette raté chez Tripo ne coûte rien, un squelette rendu ~25 crédits).
   */
  async #rig(order: Order, body: { input: string; model: string; rig_type: string }, step: (s: string) => void): Promise<TripoTask> {
    let problem = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      const label = attempt ? `Tripo repose le squelette (essai ${attempt + 1}/3)` : "Tripo pose le squelette";
      // L'essai fait partie de l'empreinte : un nouvel essai est une nouvelle commande, pas la reprise du squelette raté.
      const same = attempt ? { ...body, attempt } : body;
      let rig: TripoTask;
      try {
        rig = await order(label, "/v3/animations/rig", same, () => body);
      } catch (err) {
        if (!(err instanceof TripoGone) || /introuvable/.test((err as Error).message)) throw err;
        problem = (err as Error).message;
        step(`${problem} : nouvel essai`);
        continue;
      }
      const joints = glbJoints(await this.#fetchModel(rig, step));
      problem = joints ? (rigProblem(joints, body.rig_type) ?? "") : "";
      if (!problem) return rig;
      step(`Squelette incomplet (${problem}) : nouvel essai`);
    }
    throw new Error(`Tripo n'a pas réussi le squelette en 3 essais (${problem}). ${RIG_RECIPE}`);
  }

  #retarget(order: Order, rigTask: string, name: string, label: string): Promise<TripoTask> {
    const body = { input: rigTask, animation: `preset:${name}`, out_format: "glb", export_with_geometry: true, animate_in_place: true };
    return order(label, "/v3/animations/retarget", body, () => body);
  }

  /**
   * Une commande payante, passée une seule fois (ADR-70) : son numéro est noté au carnet dès que Tripo le donne. La même
   * demande (même empreinte `same`) reprend la commande notée : en cours, on attend sa fin ; finie, on la récupère sans
   * repayer. Seule une commande que Tripo a oubliée ou fait échouer est repassée.
   */
  async #order(
    key: string,
    o: Orders,
    step: (s: string) => void,
    label: string,
    path: string,
    same: Record<string, unknown>,
    body: () => Record<string, unknown> | Promise<Record<string, unknown>>,
  ): Promise<TripoTask> {
    const fp = orderFingerprint(path, same);
    o.used.push(fp);
    const known = this.#journal.get(fp);
    if (known) {
      step(`${label} : commande déjà passée, reprise sans repayer`);
      try {
        const t = await this.#poll(key, known.task, label, step);
        if (!known.counted) this.#count(o, fp, t);
        o.reused.set(t.task_id, fp);
        return t;
      } catch (err) {
        if (!(err instanceof TripoGone)) throw err;
        this.#journal.drop(fp);
      }
    }
    step(label);
    const payload = await body();
    let task: string;
    try {
      task = ((await this.#api(key, "POST", path, payload)) as { task_id: string }).task_id;
    } catch (err) {
      // Refusée parce qu'elle part d'une tâche reprise que Tripo a peut-être oubliée : celle-là sera refaite la prochaine fois.
      const text = JSON.stringify(payload);
      for (const [t, f] of o.reused) if (text.includes(t)) this.#journal.drop(f);
      throw err;
    }
    this.#journal.add(fp, { task, label });
    try {
      const t = await this.#poll(key, task, label, step);
      this.#count(o, fp, t);
      return t;
    } catch (err) {
      // Échouée chez Tripo : rien à reprendre. Trop longue ou Tripo injoignable : la commande reste notée et sera reprise.
      if (err instanceof TripoGone) this.#journal.drop(fp);
      throw err;
    }
  }

  #count(o: Orders, fp: string, t: TripoTask): void {
    const credits = Number(t.credits_consumed ?? 0);
    o.credits += credits;
    if (credits) this.#spend(credits);
    this.#journal.counted(fp);
  }

  /** Attend la fin d'une tâche ; `TripoGone` si Tripo l'a fait échouer ou ne la connaît pas (plus). */
  async #poll(key: string, task: string, label: string, step: (s: string) => void): Promise<TripoTask> {
    const deadline = Date.now() + 20 * 60_000;
    for (let wait = 2000; ; wait = Math.min(wait * 2, 15_000)) {
      await new Promise((r) => setTimeout(r, wait));
      let t: TripoTask;
      try {
        t = (await this.#api(key, "GET", `/v3/tasks/${task}`)) as TripoTask;
      } catch (err) {
        if (err instanceof TripoHttpError && err.status >= 400 && err.status < 500 && err.status !== 429) throw new TripoGone(`Tripo : ${label} introuvable (${err.message})`);
        throw err;
      }
      const status = String(t?.status ?? "unknown").toLowerCase();
      if (status === "success") return t;
      if (["failed", "cancelled", "banned", "expired", "unknown"].includes(status)) throw new TripoGone(`Tripo : ${label} a échoué (${t.error_msg ?? t.error_message ?? status})`);
      if (Date.now() > deadline) throw new Error(`Tripo : ${label} a pris plus de 20 minutes`);
      if (typeof t.progress === "number") step(`${label} (${t.progress} %)`);
    }
  }

  /** La planche : Tripo dessine les quatre vues ; elles sont jugées, retouchées une fois si besoin, puis rejugées. */
  async #planche(
    order: Order,
    token: () => Promise<string>,
    image: string,
    review: ViewsReview,
    step: (s: string) => void,
  ): Promise<Planche> {
    const task = await order("Tripo dessine la planche (face, gauche, dos, droite)", "/v3/generation/image-to-multiview", { image }, async () => ({ input: await token() }));
    let urls = viewUrls(task, null);
    let images = await this.#viewImages(urls, step);
    const tasks = [task.task_id];
    const edits = await review(images, 1, "tripo");
    if (edits.length) {
      const body = { input: task.task_id, prompts: edits.map((e) => ({ view: e.view, prompt: e.prompt.slice(0, 1024) })) };
      const edited = await order(`Tripo retouche la planche (${edits.map((e) => e.view).join(", ")})`, "/v3/generation/edit-multiview", body, () => body);
      // Les vues non retouchées peuvent manquer dans la réponse : on garde alors celles d'avant.
      urls = viewUrls(edited, urls);
      images = await this.#viewImages(urls, step);
      tasks.push(edited.task_id);
      await review(images, 2, "tripo");
    }
    const final = urls;
    return { images, from: tasks, inputs: async () => VIEWS.map((v) => ({ [v]: final[v] })) };
  }

  /**
   * La planche de Google (ADR-110) : la face est l'image de référence, Nano Banana dessine les trois autres vues. Elle
   * passe par le même validateur ; une vue à retoucher est refaite par Nano Banana Pro, seule. Les quatre vues sont
   * ensuite téléversées chez Tripo. null si Google n'a pas pu dessiner : la planche de Tripo prend le relais.
   */
  async #googlePlanche(key: string, sheet: SheetPort, review: ViewsReview, step: (s: string) => void): Promise<Planche | null> {
    step("Google dessine la planche (gauche, dos, droite)");
    let images: ViewImage[];
    try {
      images = await sheet.draw();
    } catch (err) {
      step(`Google indisponible (${(err as Error).message.slice(0, 160)}) : planche dessinée par Tripo`);
      return null;
    }
    const edits = await review(images, 1, "google");
    if (edits.length) {
      for (const e of edits) {
        step(`Google retouche la vue ${e.view} (Nano Banana Pro)`);
        // Une retouche manquée garde la vue d'avant : le second jugement dira si la planche tient.
        const image = await sheet.retouch(images, e).catch((err: Error) => (step(`Retouche de la vue ${e.view} impossible (${err.message.slice(0, 120)})`), null));
        if (image) images = images.map((v) => (v.view === e.view ? { view: v.view, image } : v));
      }
      await review(images, 2, "google");
    }
    const final = images;
    return {
      images: final,
      // L'empreinte de la commande : le contenu des quatre vues, pour reprendre sans repayer la même planche.
      from: final.map((v) => createHash("sha256").update(v.image).digest("hex")),
      inputs: async () => {
        step("Envoi de la planche à Tripo");
        const tokens = await Promise.all(final.map((v) => this.#upload(key, v.image, extOf(v.image))));
        return VIEWS.map((v, k) => ({ [v]: tokens[k]! }));
      },
    };
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
    // Plus de crédits chez Tripo (code 2010) : à racheter sur leur site, réessayer n'y changerait rien.
    if (payload.code === 2010) throw new Error("Plus assez de crédits chez Tripo : rechargez le compte sur platform.tripo3d.ai");
    if (res.status === 401 || res.status === 403) throw new Error("Tripo refuse la clé");
    if (!res.ok || (payload.code !== undefined && payload.code !== 0)) throw new TripoHttpError(res.status, `Tripo répond ${res.status}${payload.message ? ` : ${payload.message}` : ""}`);
    return payload.data ?? payload;
  }
}

/** Ce que demande un modèle pour recevoir un squelette, dit à la DA quand Tripo échoue. */
const RIG_RECIPE =
  "Pour le squelette, refaire l'image : corps entier de la tête aux pieds, de face, pose en A ou en T, bras écartés du corps, jambes séparées et visibles, rien qui soude les membres au corps (cape, jupe longue, tabard, arme collée).";

/** Les noms des os d'un .glb (son premier squelette), lus dans l'en-tête JSON du fichier ; null si ce n'est pas un .glb lisible. */
export function glbJoints(glb: Buffer): string[] | null {
  if (glb.length < 20 || glb.readUInt32LE(0) !== 0x46546c67) return null;
  try {
    const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString("utf8")) as { nodes?: { name?: string }[]; skins?: { joints: number[] }[] };
    return (json.skins?.[0]?.joints ?? []).map((i) => json.nodes?.[i]?.name ?? "");
  } catch {
    return null;
  }
}

/**
 * Un squelette inutilisable, ou null s'il convient. Un squelette sain a ses deux côtés presque pareils (« L_Thigh » et
 * « R_Thigh », ou des chaînes « Left »/« Right ») ; un raté n'a qu'un bras, ou pas de jambes. Des noms sans côté (une
 * version inconnue) ne sont pas refusés, sauf un bipède à trop peu d'os.
 */
export function rigProblem(joints: string[], type: string): string | null {
  if (!joints.length) return "aucun os dans le fichier";
  const left = joints.filter((n) => /(^|[_.\s-])(l|left)([_.\s-]|$)|left/i.test(n)).length;
  const right = joints.filter((n) => /(^|[_.\s-])(r|right)([_.\s-]|$)|right/i.test(n)).length;
  if (type === "biped" && joints.length < 12) return `${joints.length} os seulement`;
  if (!left && !right) return null;
  if (Math.min(left, right) < 3) return `${left} os à gauche, ${right} à droite`;
  if (Math.abs(left - right) > 2) return `côtés inégaux : ${left} os à gauche, ${right} à droite`;
  return null;
}

/**
 * Vu de près : un personnage animé, ou un objet à gros budget (l'arme du joueur en vue à la première personne remplit
 * l'écran). Il prend la géométrie détaillée de Tripo et garde des textures plus fines qu'un décor.
 */
function closeUp(spec: Model3DSpec): boolean {
  return spec.rig || spec.tris >= 8000;
}

function maxTexture(spec: Model3DSpec): number {
  return closeUp(spec) ? 2048 : 1024;
}

/**
 * Les animations demandées que ce squelette sait jouer (noms des préréglages Tripo, sans « preset: »). Le type de
 * squelette est celui que Tripo reconnaît sur le modèle, pas celui que la fiche espérait : une marche « à quatre pattes »
 * demandée pour un modèle que Tripo voit à huit pattes devient la marche à huit pattes, au lieu de disparaître. Un bipède
 * prend le squelette v3.0 quand toutes ses animations sont de base (noms nus, « walk »), sinon le v1.0 et sa bibliothèque
 * (« biped:walk ») ; `rig` impose le squelette déjà posé.
 */
export function rigAnimations(type: string, wanted: string[], rig?: string | null): string[] {
  const out = new Set<string>();
  // La seule façon de se déplacer que Tripo connaît pour chaque squelette non bipède.
  const gait = TRIPO_ANIMATIONS.find((a) => a.startsWith(`${type}:`));
  const moves = wanted.map((w) => (w.includes(":") ? w.split(":")[1]! : w));
  const modern = rig ? rig === RIG_V3 : moves.filter((m) => TRIPO_BIPED.includes(m) || BASIC.includes(m)).every((m) => BASIC.includes(m));
  for (const move of moves) {
    let name: string | null;
    if (type === "biped" && modern) name = BASIC.includes(move) ? move : null;
    else if (type === "biped") name = TRIPO_BIPED.includes(move) ? `biped:${move}` : TRIPO_ANIMATIONS.includes(move) ? move : null;
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

/** L'extension d'une image d'après son contenu (les vues de Google arrivent sans nom de fichier). */
function extOf(b: Buffer): string {
  return b[0] === 0xff && b[1] === 0xd8 ? "jpg" : b.subarray(0, 4).toString("latin1") === "RIFF" ? "webp" : "png";
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
