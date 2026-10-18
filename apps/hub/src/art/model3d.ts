import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { download, killTree } from "./imagegen.ts";

/**
 * L'atelier 3D du Directeur artistique (ADR-47) : Tripo fabrique le modèle à partir de l'image validée (et, si besoin,
 * le squelette et les animations) ; Blender, sans fenêtre, le met aux mesures du jeu et le photographie sous tous les
 * angles pour le validateur. Blender s'installe sur votre clic ; Tripo demande votre clé et respecte un plafond mensuel.
 */

export type Model3DState = {
  blender: { installed: boolean; installing: { step: string; progress: number } | null; error: string | null; size: string };
  tripo: { configured: boolean; month: string; credits: number; cap: number };
};

/** Ce que la fiche demande pour la 3D. */
export type Model3DSpec = { size: number; tris: number; rig: boolean; animations: string[] };

/** `extras` : une animation de plus par fichier (même squelette), que Blender fusionne dans le modèle. */
export type TripoResult = { glb: Buffer; credits: number; extras?: Buffer[]; animations?: string[] };
export type FinishResult = { renders: string[]; tris: number; dims: number[]; animations: string[] };

export interface Model3DPort {
  state(): Model3DState;
  installBlender(): void;
  /** Vérifie la clé auprès de Tripo, puis la garde dans les données du hub (jamais dans un dépôt). */
  setTripoKey(key: string): Promise<void>;
  /** Image → modèle .glb, avec squelette et animations si demandé. `step` raconte où on en est. */
  tripo(req: { image: Buffer; ext: string; spec: Model3DSpec; seed: number; step: (s: string) => void }): Promise<TripoResult>;
  /** Blender : mesures du jeu, budget de triangles, textures, export .glb et photos sous quatre angles. */
  finish(req: { input: string; output: string; rendersDir: string; prefix: string; spec: Model3DSpec; extras?: string[]; animations?: string[] }): Promise<FinishResult>;
}

/** Les animations toutes prêtes de Tripo (noms courts, sans « preset: »). */
export const TRIPO_ANIMATIONS = ["idle", "walk", "run", "dive", "climb", "jump", "slash", "shoot", "hurt", "fall", "turn", "quadruped:walk", "hexapod:walk", "octopod:walk", "serpentine:march", "aquatic:march"];

const TRIPO = "https://openapi.tripo3d.ai";
const TRIPO_MODEL = process.env.STUDIO_TRIPO_MODEL ?? "v2.5-20250123";
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

  async finish(req: { input: string; output: string; rendersDir: string; prefix: string; spec: Model3DSpec; extras?: string[]; animations?: string[] }): Promise<FinishResult> {
    const exe = this.#blender();
    if (!exe) throw new Error("Blender n'est pas installé");
    const work = join(this.#dir, "blender", "work");
    mkdirSync(work, { recursive: true });
    mkdirSync(req.rendersDir, { recursive: true });
    const script = join(work, "finish.py");
    writeFileSync(script, FINISH_PY, "utf8");
    const cfgFile = join(work, `${req.prefix}.json`);
    const stats = join(work, `${req.prefix}-stats.json`);
    rmSync(stats, { force: true });
    writeFileSync(
      cfgFile,
      JSON.stringify({ input: req.input, output: req.output, renders_dir: req.rendersDir, prefix: req.prefix, size: req.spec.size, max_tris: req.spec.tris, max_texture: 1024, stats, extras: req.extras ?? [], animations: req.animations ?? [] }),
      "utf8",
    );
    const log: string[] = [];
    await new Promise<void>((resolve, reject) => {
      const child = spawn(exe, ["-b", "--factory-startup", "--python", script, "--", cfgFile], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const timer = setTimeout(() => killTree(child.pid), 15 * 60_000);
      const keep = (b: Buffer) => log.push(...b.toString("utf8").split(/\r?\n/).filter(Boolean).slice(-50));
      child.stdout?.on("data", keep);
      child.stderr?.on("data", keep);
      child.on("error", (e) => reject(new Error(`Blender ne se lance pas : ${e.message}`)));
      child.on("close", (code) => {
        clearTimeout(timer);
        writeFileSync(join(work, `${req.prefix}.log`), log.slice(-400).join("\n"), "utf8");
        if (code === 0 && existsSync(stats)) resolve();
        else reject(new Error(`Blender s'est arrêté (code ${code}) : ${log.filter((l) => /error|erreur|traceback/i.test(l)).slice(-3).join(" | ").slice(0, 300) || "voir le journal"}`));
      });
    });
    const s = JSON.parse(readFileSync(stats, "utf8")) as { renders: string[]; tris_after: number; dims: number[]; animations: string[] };
    return { renders: s.renders, tris: s.tris_after, dims: s.dims.map((d) => Math.round(d * 100) / 100), animations: s.animations };
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

  async tripo(req: { image: Buffer; ext: string; spec: Model3DSpec; seed: number; step: (s: string) => void }): Promise<TripoResult> {
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
      if (pending && pending.image === reuse.image && pending.tris === reuse.tris) {
        req.step("Tripo reprend le modèle déjà fabriqué");
        model = { task_id: pending.task, status: "success" };
        reused = true;
      } else {
        const token = await this.#upload(key, req.image, req.ext);
        model = await run("Tripo fabrique le modèle", "/v3/generation/image-to-model", {
          input: token,
          model: TRIPO_MODEL,
          face_limit: Math.max(1000, req.spec.tris),
          model_seed: req.seed,
          texture_seed: req.seed,
        });
        if (req.spec.rig) this.#setPending({ ...reuse, task: model.task_id });
      }
      let last = model;
      const extras: Buffer[] = [];
      let names: string[] = [];
      if (req.spec.rig) {
        const check = await run("Tripo vérifie qu'on peut poser un squelette", "/v3/animations/rig-check", { input: model.task_id });
        if (check.output?.riggable === false) throw new Error("Tripo ne sait pas poser de squelette sur ce modèle (forme non reconnue)");
        const type = String(check.output?.rig_type ?? "biped").toLowerCase();
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
      return { glb, credits, extras, animations: names };
    } catch (err) {
      // Le modèle repris a peut-être expiré chez Tripo : la prochaine fois, on le refait.
      if (reused) this.#setPending(null);
      throw err;
    } finally {
      if (credits) this.#spend(credits);
    }
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

/**
 * Les animations demandées que ce squelette sait jouer : « walk » sur quatre pattes devient « quadruped:walk » ;
 * un bipède ne prend que les animations sans préfixe. Cinq au plus.
 */
export function rigAnimations(type: string, wanted: string[]): string[] {
  const out = new Set<string>();
  for (const w of wanted) {
    const [kind, move] = w.includes(":") ? w.split(":") : [null, w];
    const name = type === "biped" ? (kind ? null : move) : kind ? (kind === type ? w : null) : `${type}:${move}`;
    if (name && TRIPO_ANIMATIONS.includes(name)) out.add(name);
  }
  return [...out].slice(0, 5);
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

/**
 * Le script Blender (lancé sans fenêtre, usine vierge) : importe le .glb, l'allège au budget de triangles, le met à la
 * taille voulue (plus grande dimension, en mètres) posé au sol et centré, réduit les textures, exporte le .glb (avec ses
 * animations) puis fait quatre photos (face, trois-quarts, profil, dos) pour le validateur.
 */
export const FINISH_PY = String.raw`
import bpy, sys, json, math
from mathutils import Vector

cfg = json.load(open(sys.argv[sys.argv.index("--") + 1], encoding="utf-8"))
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=cfg["input"])
scene = bpy.context.scene
names = cfg.get("animations") or []

def name_new(actions, name):
    for a in actions:
        a.name = name if len(actions) == 1 else "%s_%s" % (name, a.name)
        a.use_fake_user = True

if names:
    name_new(list(bpy.data.actions), names[0])
# Animations suivantes (meme squelette) : on garde l'action, on jette le reste du fichier.
for i, extra in enumerate(cfg.get("extras") or []):
    objs, acts = set(bpy.data.objects), set(bpy.data.actions)
    bpy.ops.import_scene.gltf(filepath=extra)
    name_new([a for a in bpy.data.actions if a not in acts], names[i + 1] if i + 1 < len(names) else "anim_%d" % (i + 2))
    for o in [o for o in bpy.data.objects if o not in objs]:
        bpy.data.objects.remove(o, do_unlink=True)
for arm in [o for o in scene.objects if o.type == "ARMATURE"]:
    arm.animation_data_create()
    arm.animation_data.action = None
    for a in bpy.data.actions:
        track = arm.animation_data.nla_tracks.new()
        track.name = a.name
        track.strips.new(a.name, 0, a)
# Les formes d'os que l'import range a part (glTF_not_exported) ne font pas partie du modele.
meshes = [o for o in scene.objects if o.type == "MESH" and not any(c.name.startswith("glTF_not_exported") for c in o.users_collection)]
if not meshes:
    raise SystemExit("aucun maillage dans le modele")

def triangles():
    deps = bpy.context.evaluated_depsgraph_get()
    n = 0
    for o in meshes:
        e = o.evaluated_get(deps)
        m = e.to_mesh()
        m.calc_loop_triangles()
        n += len(m.loop_triangles)
        e.to_mesh_clear()
    return n

def bounds():
    bpy.context.view_layer.update()
    pts = [o.matrix_world @ Vector(c) for o in meshes for c in o.bound_box]
    lo = Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts)))
    hi = Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
    return lo, hi

before = triangles()
budget = int(cfg.get("max_tris") or 0)
if budget and before > budget:
    ratio = max(0.02, budget / before)
    for o in meshes:
        mod = o.modifiers.new("Budget", "DECIMATE")
        mod.ratio = ratio
        with bpy.context.temp_override(object=o, active_object=o, selected_objects=[o], selected_editable_objects=[o]):
            bpy.ops.object.modifier_apply(modifier=mod.name)

roots = [o for o in scene.objects if o.parent is None]
size = float(cfg.get("size") or 0)
lo, hi = bounds()
if size > 0:
    f = size / max(hi - lo)
    for o in roots:
        o.scale = o.scale * f
        o.location = o.location * f
    lo, hi = bounds()
shift = Vector(((lo.x + hi.x) / 2, (lo.y + hi.y) / 2, lo.z))
for o in roots:
    o.location = o.location - shift
lo, hi = bounds()

limit = int(cfg.get("max_texture") or 0)
for img in bpy.data.images:
    w, h = img.size
    if limit and max(w, h) > limit:
        k = limit / max(w, h)
        img.scale(max(1, int(w * k)), max(1, int(h * k)))

bpy.ops.export_scene.gltf(filepath=cfg["output"], export_format="GLB", export_yup=True, export_animations=True, export_animation_mode="NLA_TRACKS" if names else "ACTIONS", export_apply=False)

# Photos : fond gris neutre, soleil et lumiere d'ambiance, camera qui tourne autour.
world = bpy.data.worlds.new("Fond")
world.use_nodes = True
world.node_tree.nodes["Background"].inputs[0].default_value = (0.32, 0.33, 0.35, 1)
world.node_tree.nodes["Background"].inputs[1].default_value = 0.8
scene.world = world
sun = bpy.data.objects.new("Soleil", bpy.data.lights.new("Soleil", "SUN"))
sun.data.energy = 3.5
sun.rotation_euler = (math.radians(50), 0, math.radians(35))
scene.collection.objects.link(sun)
center = (lo + hi) / 2
radius = (hi - lo).length * 1.6  # la diagonale entiere tient dans le cadre
target = bpy.data.objects.new("Cible", None)
target.location = center
scene.collection.objects.link(target)
cam = bpy.data.objects.new("Camera", bpy.data.cameras.new("Camera"))
cam.data.lens = 50
scene.collection.objects.link(cam)
track = cam.constraints.new("TRACK_TO")
track.target = target
track.track_axis = "TRACK_NEGATIVE_Z"
track.up_axis = "UP_Y"
scene.camera = cam
scene.render.resolution_x = 640
scene.render.resolution_y = 640
scene.render.image_settings.file_format = "PNG"
try:
    scene.render.engine = "BLENDER_EEVEE_NEXT"
except TypeError:
    scene.render.engine = "BLENDER_EEVEE"

renders = []
angles = [("face", -90), ("trois-quarts", -45), ("profil", 0), ("dos", 90)]
for name, deg in angles:
    a = math.radians(deg)
    cam.location = center + Vector((math.cos(a) * radius, math.sin(a) * radius, radius * 0.45))
    path = "%s/%s-%s.png" % (cfg["renders_dir"], cfg["prefix"], name)
    scene.render.filepath = path
    try:
        bpy.ops.render.render(write_still=True)
    except Exception:
        scene.render.engine = "BLENDER_WORKBENCH"
        scene.display.shading.color_type = "TEXTURE"
        bpy.ops.render.render(write_still=True)
    renders.append(path)

json.dump({
    "renders": renders,
    "tris_before": before,
    "tris_after": triangles(),
    "dims": list(hi - lo),
    "animations": [a.name for a in bpy.data.actions],
}, open(cfg["stats"], "w", encoding="utf-8"))
`;
