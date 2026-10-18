import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { extname, join, normalize, relative } from "node:path";
import { randomInt, randomUUID } from "node:crypto";
import type { Task } from "@studio/contracts";
import { assertHumanSession, type HumanSession } from "../auth/human-session.ts";
import type { Clock } from "../clock.ts";
import type { ConversationService } from "../conversation/conversation-service.ts";
import type { Db } from "../db/database.ts";
import type { Journal } from "../journal/journal.ts";
import type { OrchestratorPort } from "../orchestrator/port.ts";
import type { ProjectRegistry } from "../projects/project-registry.ts";
import type { VcsPort } from "../vcs/git.ts";
import { ART_DIR, artRoot, nextAssetId, readManifest, writeAtomic, writeManifest, type Asset, type AssetStatus, type Verdict } from "./manifest.ts";
import type { GenState, ImageGenPort } from "./imagegen.ts";
import type { Model3DPort, Model3DState } from "./model3d.ts";
import {
  ART_SYSTEM,
  DONE_MARK,
  IMAGE_MARK,
  INGAME_SCHEMA,
  INGAME_SYSTEM,
  MODEL_VALIDATOR_SYSTEM,
  parseArtDirectives,
  PICK_SCHEMA,
  VALIDATOR_SYSTEM,
  VERDICT_SCHEMA,
  type ArtDirectives,
} from "./prompts.ts";

export class ArtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtError";
  }
}

export type ArtMessage = { id: string; project: string; seq: number; role: "human" | "art"; text: string; at: string; cost_usd: number | null };
export type MoodImage = { file: string; note: string | null };
export type ArtState = {
  bible: string | null;
  assets: Asset[];
  moodboard: MoodImage[];
  messages: ArtMessage[];
  /** Le Directeur artistique est en train de répondre, le validateur de juger, le générateur de fabriquer. */
  busy: { replying: boolean; validating: string[]; generating: Generating[] };
  /** Le générateur d'images local (ADR-46). */
  generator: GenState;
  /** L'atelier 3D : Blender et Tripo (ADR-47). */
  workshop3d: Model3DState;
};
export type Generating = { asset: string; round: number; rounds: number; step: string };

/** Essais par tour et tours au plus : le générateur réessaie seul avec le prompt corrigé du validateur. */
const VARIANTS = 3;
const ROUNDS = 3;
/** Tours de 3D au plus (chaque tour coûte des crédits Tripo). */
const MODEL_ROUNDS = 2;

const MAX_IMAGE = 15 * 1024 * 1024;
const HISTORY = 30;
const IMAGE_TYPES: Record<string, { ext: string; magic: (b: Buffer) => boolean }> = {
  "image/png": { ext: ".png", magic: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  "image/jpeg": { ext: ".jpg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  "image/webp": { ext: ".webp", magic: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
};
export const IMAGE_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

/**
 * Le Directeur artistique (ADR-43) : une discussion par projet, la bible visuelle, le moodboard, le manifeste des
 * assets et le validateur. Tout vit dans `studio/art/` du dépôt du jeu, commité par le hub ; le développeur le lit.
 */
export class ArtService {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #journal: Journal;
  readonly #projects: ProjectRegistry;
  readonly #orchestrator: OrchestratorPort;
  readonly #vcs: VcsPort;
  readonly #conversations: ConversationService;
  readonly #background = new Set<Promise<unknown>>();
  readonly #replying = new Set<string>();
  readonly #validating = new Map<string, Set<string>>();
  /** Un seul tour de DA à la fois par projet : les messages arrivés entre-temps partent au tour suivant. */
  readonly #queue = new Map<string, Promise<unknown>>();
  readonly #imagegen: ImageGenPort;
  readonly #model3d: Model3DPort;
  readonly #screenshot: (project: string, task: string) => string | null;
  readonly #generating = new Map<string, Map<string, Generating>>();

  constructor(deps: {
    db: Db;
    clock: Clock;
    journal: Journal;
    projects: ProjectRegistry;
    orchestrator: OrchestratorPort;
    vcs: VcsPort;
    conversations: ConversationService;
    imagegen: ImageGenPort;
    model3d: Model3DPort;
    /** La capture du jeu prise par le hub avant la fusion d'un chantier (ADR-32), si elle existe. */
    screenshot?: (project: string, task: string) => string | null;
  }) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#journal = deps.journal;
    this.#projects = deps.projects;
    this.#orchestrator = deps.orchestrator;
    this.#vcs = deps.vcs;
    this.#conversations = deps.conversations;
    this.#imagegen = deps.imagegen;
    this.#model3d = deps.model3d;
    this.#screenshot = deps.screenshot ?? (() => null);
  }

  #root(project: string): string {
    return artRoot(this.#projects.get(project).root);
  }

  state(project: string): ArtState {
    const root = this.#root(project);
    const bibleFile = join(root, "bible.md");
    const notes = this.#notes(root);
    const mood = join(root, "moodboard");
    const moodboard = existsSync(mood)
      ? readdirSync(mood)
          .filter((f) => IMAGE_MIME[extname(f).toLowerCase()])
          .sort()
          .map((f) => ({ file: `moodboard/${f}`, note: notes[`moodboard/${f}`] ?? null }))
      : [];
    return {
      bible: existsSync(bibleFile) ? readFileSync(bibleFile, "utf8") : null,
      assets: readManifest(this.#projects.get(project).root).assets,
      moodboard,
      messages: this.messages(project),
      busy: { replying: this.#replying.has(project), validating: [...(this.#validating.get(project) ?? [])], generating: [...(this.#generating.get(project)?.values() ?? [])] },
      generator: this.#imagegen.state(),
      workshop3d: this.#model3d.state(),
    };
  }

  messages(project: string): ArtMessage[] {
    return this.#db.prepare("SELECT * FROM art_messages WHERE project = ? ORDER BY seq").all(project) as ArtMessage[];
  }

  /** Activité en cours, pour « Le studio en direct ». */
  activity(): { project: string; kind: "reply" | "validate" | "generate"; asset?: string }[] {
    return [
      ...[...this.#replying].map((project) => ({ project, kind: "reply" as const })),
      ...[...this.#validating].flatMap(([project, ids]) => [...ids].map((asset) => ({ project, kind: "validate" as const, asset }))),
      ...[...this.#generating].flatMap(([project, gens]) => [...gens.keys()].map((asset) => ({ project, kind: "generate" as const, asset }))),
    ];
  }

  /** Installer le générateur d'images local, sur votre clic (environ 19 Go). L'avancement se lit dans l'état. */
  installGenerator(session: HumanSession): GenState {
    assertHumanSession(session);
    this.#imagegen.install();
    this.#journal.append({ project: null, actor: { kind: "human" }, type: "tool.install_started", subject: "comfyui", payload: {} });
    return this.#imagegen.state();
  }

  /** Installer Blender (≈ 400 Mo), sur votre clic. */
  installBlender(session: HumanSession): Model3DState {
    assertHumanSession(session);
    this.#model3d.installBlender();
    this.#journal.append({ project: null, actor: { kind: "human" }, type: "tool.install_started", subject: "blender", payload: {} });
    return this.#model3d.state();
  }

  /** Votre clé Tripo : vérifiée auprès de Tripo, gardée dans les données du hub. */
  async setTripoKey(session: HumanSession, key: string): Promise<Model3DState> {
    assertHumanSession(session);
    await this.#model3d.setTripoKey(key).catch((err: Error) => {
      throw new ArtError(err.message);
    });
    this.#journal.append({ project: null, actor: { kind: "human" }, type: "tool.configured", subject: "tripo", payload: {} });
    return this.#model3d.state();
  }

  /** Fabriquer (ou refaire) la 3D d'un asset dont l'image est validée. */
  generateModel(session: HumanSession, project: string, id: string): Asset {
    assertHumanSession(session);
    const asset = readManifest(this.#projects.get(project).root).assets.find((a) => a.id === id);
    if (!asset) throw new ArtError(`Asset introuvable : ${id}`);
    if (!asset.model3d) throw new ArtError("Cet asset n'est pas un modèle 3D");
    if (!asset.verdict?.ok) throw new ArtError("Il faut d'abord une image validée");
    const missing = this.#missing3d();
    if (missing) throw new ArtError(missing);
    if (asset.status === "integration" || asset.status === "integre") throw new ArtError("Cet asset est déjà parti dans le jeu");
    this.#startModel(project, id);
    return asset;
  }

  /** Fabriquer un asset avec le générateur local : essais, validateur, nouvelles tentatives, sans vous. */
  generate(session: HumanSession, project: string, id: string): Asset {
    assertHumanSession(session);
    const asset = readManifest(this.#projects.get(project).root).assets.find((a) => a.id === id);
    if (!asset) throw new ArtError(`Asset introuvable : ${id}`);
    if (!this.#imagegen.state().installed) throw new ArtError("Installez d'abord le générateur d'images");
    if (!asset.prompts.length) throw new ArtError("Pas encore de prompt : demandez-le au Directeur artistique");
    if (asset.status === "integration" || asset.status === "integre") throw new ArtError("Cet asset est déjà parti dans le jeu");
    this.#startProduce(project, id);
    return asset;
  }

  /** Votre message au Directeur artistique ; sa réponse arrive en arrière-plan (il peut chercher sur internet). */
  send(session: HumanSession, project: string, text: string): ArtMessage {
    assertHumanSession(session);
    const body = text.trim();
    if (!body) throw new ArtError("Message vide");
    if (body.length > 20_000) throw new ArtError("Message trop long");
    this.#projects.get(project);
    const human = this.#insert(project, "human", body, null);
    this.#journal.append({ project, actor: { kind: "human" }, type: "art.message", subject: human.id, payload: {} });
    this.#turn(project);
    return human;
  }

  /**
   * Une image déposée : au moodboard (inspiration) ou comme rendu d'un asset (« A-0001 »), qui part alors au validateur.
   * Le fichier est vérifié (type réel, taille) et rangé dans studio/art ; le nom d'origine ne sert qu'à le reconnaître.
   */
  async upload(session: HumanSession, project: string, target: string, data: Buffer, mime: string, name = "image"): Promise<{ file: string }> {
    assertHumanSession(session);
    const kind = IMAGE_TYPES[mime];
    if (!kind) throw new ArtError("Seules les images PNG, JPEG et WebP sont acceptées");
    if (data.length > MAX_IMAGE) throw new ArtError("Image trop lourde (15 Mo au plus)");
    if (!kind.magic(data)) throw new ArtError("Ce fichier n'est pas une image valide");
    const gameRoot = this.#projects.get(project).root;
    const root = artRoot(gameRoot);
    const base = (name.replace(/\.[^.]*$/, "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "image").slice(0, 40);
    if (target === "moodboard") {
      const file = this.#free(root, "moodboard", base, kind.ext);
      writeAtomic(join(root, file), data);
      await this.#commit(gameRoot, `art: image d'inspiration ${file}`);
      this.#journal.append({ project, actor: { kind: "human" }, type: "art.image_added", subject: file, payload: {} });
      return { file };
    }
    const m = readManifest(gameRoot);
    const asset = m.assets.find((a) => a.id === target);
    if (!asset) throw new ArtError(`Asset introuvable : ${target}`);
    const file = this.#free(root, "production", `${asset.id.toLowerCase()}-${base}`, kind.ext);
    writeAtomic(join(root, file), data);
    asset.renders.push(file);
    this.#setStatus(asset, "a_valider");
    writeManifest(gameRoot, m);
    await this.#commit(gameRoot, `art: rendu ${file} pour ${asset.id}`);
    this.#journal.append({ project, actor: { kind: "human" }, type: "art.render_added", subject: asset.id, payload: { file } });
    this.#track(this.#validate(project, asset.id, file));
    return { file };
  }

  /** Vous tranchez vous-même : valider le dernier rendu malgré le validateur, ou le renvoyer en production. */
  async decide(session: HumanSession, project: string, id: string, decision: "valider" | "refaire"): Promise<Asset> {
    assertHumanSession(session);
    const gameRoot = this.#projects.get(project).root;
    const m = readManifest(gameRoot);
    const asset = m.assets.find((a) => a.id === id);
    if (!asset) throw new ArtError(`Asset introuvable : ${id}`);
    const file = asset.verdict?.file ?? asset.renders.at(-1);
    let next: "model" | "integrate" | null = null;
    if (decision === "valider") {
      if (asset.model3d && asset.model) {
        // Le modèle 3D, malgré le validateur.
        asset.model.verdict = { ok: true, summary: "Validé par le directeur créatif.", points: asset.model.verdict?.points ?? [], prompt: null, file: asset.model.file, by: "human", at: this.#clock.now() };
        this.#setStatus(asset, "valide");
        next = "integrate";
      } else {
        if (!file) throw new ArtError("Aucun rendu à valider : déposez d'abord une image");
        asset.verdict = { ok: true, summary: "Validé par le directeur créatif.", points: asset.verdict?.points ?? [], prompt: null, file, by: "human", at: this.#clock.now() };
        // Un modèle 3D : l'image validée part à l'atelier 3D ; sinon, direction le jeu.
        this.#setStatus(asset, asset.model3d ? "production" : "valide");
        next = asset.model3d ? "model" : "integrate";
      }
    } else this.#setStatus(asset, "production");
    writeManifest(gameRoot, m);
    await this.#commit(gameRoot, `art: ${id} ${decision === "valider" ? "validé" : "à refaire"} (directeur créatif)`);
    this.#journal.append({ project, actor: { kind: "human" }, type: decision === "valider" ? "art.asset_validated" : "art.asset_rejected", subject: id, payload: { by: "human" } });
    // « Refaire » avec le générateur local : il repart tout seul.
    if (decision === "refaire" && asset.prompts.length && this.#imagegen.state().installed) this.#startProduce(project, id);
    if (next === "model") this.#startModel(project, id);
    if (next === "integrate") this.#track(this.#autoIntegrate(project, id, "human"));
    return asset;
  }

  /**
   * Faire brancher un asset validé dans le jeu : une demande au directeur du projet, dans une nouvelle discussion.
   * Il lance le chantier ; quand un chantier qui porte l'identifiant de l'asset est fusionné, l'asset passe « intégré ».
   */
  async integrate(session: HumanSession, project: string, id: string): Promise<{ thread: string }> {
    assertHumanSession(session);
    return this.#requestIntegration(project, id, "human");
  }

  /** L'intégration lancée en arrière-plan : un échec s'affiche dans la discussion au lieu de se perdre. */
  async #autoIntegrate(project: string, id: string, by: "human" | "system"): Promise<void> {
    try {
      await this.#requestIntegration(project, id, by);
    } catch (err) {
      this.#insert(project, "art", `Je n'ai pas pu envoyer ${id} au directeur pour l'intégrer : ${(err as Error).message.slice(0, 300)}. Utilisez « Faire intégrer » sur sa fiche.`, null);
    }
  }

  /** La demande au directeur. Un visuel validé (par le validateur ou par vous) y part tout seul (ADR-48). */
  async #requestIntegration(project: string, id: string, by: "human" | "system"): Promise<{ thread: string }> {
    const gameRoot = this.#projects.get(project).root;
    const m = readManifest(gameRoot);
    const asset = m.assets.find((a) => a.id === id);
    if (!asset) throw new ArtError(`Asset introuvable : ${id}`);
    if (asset.status !== "valide" && asset.status !== "integration") throw new ArtError("Seul un asset validé peut être intégré");
    const file = asset.model?.file ?? asset.verdict?.file ?? asset.renders.at(-1);
    this.#setStatus(asset, "integration");
    writeManifest(gameRoot, m);
    await this.#commit(gameRoot, `art: intégration demandée pour ${id}`);
    const thread = this.#conversations.createThread(project, `Intégrer ${id} : ${asset.name}`.slice(0, 80));
    const model = asset.model;
    const text = [
      `Le Directeur artistique a fait valider un visuel : ${id} « ${asset.name} » (${asset.type}). Fais-le brancher dans le jeu.`,
      `- Fichier validé : studio/art/${file}`,
      model
        ? `- Modèle 3D glTF binaire (.glb) : axe Y vers le haut, 1 unité = 1 mètre, posé au sol (y = 0) et centré, ${model.dims.map((d) => `${d} m`).join(" × ")}, ${model.tris} triangles${model.animations.length ? `, animations : ${model.animations.join(", ")}` : ", sans animation"}. Photos sous quatre angles : ${model.renders.map((r) => `studio/art/${r}`).join(", ")}.`
        : "",
      `- Usage : ${asset.usage}`,
      asset.specs ? `- Spécifications : ${asset.specs}` : "",
      "- La bible visuelle (studio/art/bible.md) et le manifeste (studio/art/assets.json) disent le reste.",
      `Lance un chantier dont le titre commence par « ${id} » : le développeur copie le fichier depuis studio/art/ vers les ressources du jeu (sans rien télécharger), le branche à l'endroit prévu, et l'ajoute aux crédits.`,
      "Pour que le hub puisse vérifier le rendu sur sa capture de lancement, fais en sorte que le visuel soit visible au démarrage si c'est raisonnable (sinon, dis-le).",
    ]
      .filter(Boolean)
      .join("\n");
    void this.#conversations.send(project, thread.id, text).catch(() => {});
    this.#journal.append({ project, actor: by === "human" ? { kind: "human" } : { kind: "system" }, type: "art.integration_requested", subject: id, payload: { thread: thread.id } });
    if (by === "system") this.#insert(project, "art", `${id} « ${asset.name} » part dans le jeu : demande envoyée au directeur du projet (discussion « Intégrer ${id} »).`, null);
    return { thread: thread.id };
  }

  /** Un chantier fusionné dont le titre ou la consigne cite un asset en cours d'intégration : il est intégré. */
  onTaskStatus(task: Task): void {
    if (task.status !== "merged") return;
    const ids = new Set(`${task.title} ${task.goal}`.match(/A-\d{4,}/g) ?? []);
    if (!ids.size) return;
    let gameRoot: string;
    try {
      gameRoot = this.#projects.get(task.project).root;
    } catch {
      return;
    }
    const m = readManifest(gameRoot);
    const done = m.assets.filter((a) => ids.has(a.id) && a.status === "integration");
    if (!done.length) return;
    for (const a of done) this.#setStatus(a, "integre");
    writeManifest(gameRoot, m);
    this.#track(this.#commit(gameRoot, `art: ${done.map((a) => a.id).join(", ")} intégré(s) par ${task.id}`));
    for (const a of done) this.#journal.append({ project: task.project, actor: { kind: "system" }, type: "art.asset_integrated", subject: a.id, payload: { task: task.id } });
    for (const a of done) this.#track(this.#checkInGame(task.project, a.id, task.id));
  }

  /** Après la fusion : le validateur regarde la capture du jeu ; si le visuel rend mal, une retouche part au directeur (une fois). */
  async #checkInGame(project: string, id: string, task: string): Promise<void> {
    const gameRoot = this.#projects.get(project).root;
    const root = artRoot(gameRoot);
    const shot = this.#screenshot(project, task);
    if (!shot || !existsSync(shot)) {
      this.#insert(project, "art", `${id} est dans le jeu (${task}). Pas de capture du jeu pour vérifier le rendu : regardez-le en jouant.`, null);
      return;
    }
    const file = this.#free(root, "production", `${id.toLowerCase()}-en-jeu-${task.toLowerCase()}`, ".png");
    mkdirSync(join(root, "production"), { recursive: true });
    copyFileSync(shot, join(root, file));
    const busy = this.#validating.get(project) ?? new Set<string>();
    busy.add(id);
    this.#validating.set(project, busy);
    try {
      const asset = readManifest(gameRoot).assets.find((a) => a.id === id)!;
      const validated = asset.model ? asset.model.renders.join(", ") : (asset.verdict?.file ?? "?");
      const { data } = await this.#orchestrator.structured({
        systemPrompt: INGAME_SYSTEM,
        prompt: `Asset ${id} « ${asset.name} » (${asset.type}), usage : ${asset.usage}.\nFichier validé : ${validated}\nCapture du jeu après le chantier ${task} : ${file}`,
        jsonSchema: INGAME_SCHEMA,
        readDir: root,
        role: "art",
        meta: { project, agent: "art_director" },
      });
      const v = data as { visible: boolean; ok: boolean; summary: string; points: string[] };
      const m = readManifest(gameRoot);
      const a = m.assets.find((x) => x.id === id);
      if (!a) return;
      const retry = !!v.visible && !v.ok && !a.ingame?.retried;
      a.ingame = { task, file, visible: !!v.visible, ok: !!v.visible && !!v.ok, summary: String(v.summary ?? "").slice(0, 400), points: (v.points ?? []).slice(0, 6), retried: retry || !!a.ingame?.retried, at: this.#clock.now() };
      writeManifest(gameRoot, m);
      await this.#commit(gameRoot, `art: ${id} vérifié dans le jeu (${task})`);
      this.#insert(
        project,
        "art",
        [
          `${IMAGE_MARK}${file}`,
          !v.visible
            ? `**${id} dans le jeu : pas visible sur la capture de lancement.** ${a.ingame.summary} Regardez-le en jouant.`
            : v.ok
              ? `**${id} dans le jeu : rend bien.** ${a.ingame.summary}`
              : `**${id} dans le jeu : à retoucher.** ${a.ingame.summary}`,
          ...a.ingame.points.map((p) => `- ${p}`),
          retry ? "J'ai demandé une retouche au directeur du projet." : v.visible && !v.ok ? "La retouche automatique a déjà été tentée une fois : dites-moi comment vous voulez la reprendre." : "",
        ]
          .filter(Boolean)
          .join("\n"),
        null,
      );
      if (retry) {
        const thread = this.#conversations.createThread(project, `Retoucher ${id} dans le jeu`.slice(0, 80));
        const text = [
          `Le validateur artistique a regardé ${id} « ${a.name} » dans le jeu (capture : studio/art/${file}) : à retoucher.`,
          a.ingame.summary,
          ...a.ingame.points.map((p) => `- ${p}`),
          `Lance un chantier dont le titre commence par « ${id} » pour corriger l'intégration (taille, orientation, éclairage, fond…), sans changer le fichier validé.`,
        ].join("\n");
        void this.#conversations.send(project, thread.id, text).catch(() => {});
        // Le chantier de retouche porte l'identifiant : à sa fusion, l'asset doit repasser par « intégration ».
        a.status = "integration";
        writeManifest(gameRoot, m);
      }
    } catch (err) {
      this.#insert(project, "art", `Le validateur n'a pas pu regarder ${id} dans le jeu : ${(err as Error).message.slice(0, 300)}.`, null);
    } finally {
      busy.delete(id);
    }
  }

  async idle(): Promise<void> {
    while (this.#background.size) await Promise.allSettled([...this.#background]);
  }

  // ── Tours du Directeur artistique ──

  #turn(project: string): void {
    const previous = this.#queue.get(project) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => this.#reply(project));
    this.#queue.set(project, next);
    this.#track(next);
  }

  async #reply(project: string): Promise<void> {
    const history = this.messages(project).slice(-HISTORY);
    if (history.at(-1)?.role !== "human") return; // déjà répondu dans un tour précédent
    const p = this.#projects.get(project);
    const root = artRoot(p.root);
    mkdirSync(join(root, "moodboard"), { recursive: true });
    this.#replying.add(project);
    try {
      const { text: raw, costUsd } = await this.#orchestrator.reply({
        systemPrompt: [ART_SYSTEM, this.#gameContext(project)].join("\n\n"),
        prompt: renderArtHistory(history),
        readDir: root,
        tools: ["WebSearch", "WebFetch"],
        role: "art",
        timeoutMs: 15 * 60_000,
        meta: { project, agent: "art_director" },
      });
      const { text, directives } = parseArtDirectives(raw);
      const applied = this.#apply(project, directives);
      const summary = applied.length ? `\n${DONE_MARK}${applied.join(" · ")}` : "";
      this.#insert(project, "art", `${text || "C'est noté."}${summary}`, costUsd);
      await this.#commit(p.root, `art: ${applied.join(", ") || "réponse du Directeur artistique"}`);
      // Le générateur part de la fiche à jour, une fois le tour écrit et commité.
      if (this.#imagegen.state().installed) for (const g of directives.generate) this.#startProduce(project, g.asset);
      // Une 3D demandée sur une image déjà validée : l'atelier 3D part tout de suite (sinon elle suivra l'image).
      const assets = readManifest(p.root).assets;
      for (const t of directives.model3d) {
        const a = assets.find((x) => x.id === t.asset);
        if (a?.model3d && a.verdict?.ok && !a.model && a.status === "production" && !directives.generate.some((g) => g.asset === a.id)) this.#startModel(project, a.id);
      }
    } catch (err) {
      this.#insert(project, "art", `Je n'ai pas pu répondre : ${(err as Error).message.slice(0, 300)}. Renvoyez votre message pour réessayer.`, null);
    } finally {
      this.#replying.delete(project);
    }
  }

  /** Ce que la DA sait du jeu : les consignes du projet (CLAUDE.md) et la vision (studio/BRIEF.md). */
  #gameContext(project: string): string {
    const p = this.#projects.get(project);
    const read = (rel: string, max: number) => {
      const f = join(p.root, rel);
      return existsSync(f) ? readFileSync(f, "utf8").slice(0, max) : null;
    };
    const claude = read("CLAUDE.md", 8000);
    const brief = read(join("studio", "BRIEF.md"), 6000);
    return [
      `<projet nom="${p.name}">Le jeu dont tu es le Directeur artistique.</projet>`,
      claude ? `<consignes_du_projet source="CLAUDE.md">\n${claude}\n</consignes_du_projet>` : "",
      brief ? `<vision_du_jeu source="studio/BRIEF.md">\n${brief}\n</vision_du_jeu>` : "",
      this.#imagegen.state().installed
        ? "Le générateur d'images local est prêt : pour fabriquer un asset, utilise [[GENERER]] (Flux), pas Midjourney."
        : "Le générateur d'images local n'est pas encore installé : pour fabriquer un asset, donne des prompts [[MIDJOURNEY]].",
      this.#missing3d()
        ? `L'atelier 3D n'est pas encore prêt (${this.#missing3d()}) : tu peux déjà marquer les modèles 3D avec [[MODELE3D]], leur 3D attendra.`
        : "L'atelier 3D est prêt (Tripo + Blender) : marque chaque modèle 3D avec [[MODELE3D]] ; sa 3D se fabrique dès que son image est validée.",
      existsSync(join(artRoot(p.root), "bible.md"))
        ? "La bible existe (bible.md) : relis-la avant de proposer."
        : "Il n'y a pas encore de bible : si l'utilisateur n'a rien demandé d'autre, propose de la construire ensemble (deux ou trois questions de goût, puis une première version).",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  /** Applique les balises de la DA (bible, assets, prompts, notes) ; renvoie ce qui a changé, en clair. */
  #apply(project: string, d: ArtDirectives): string[] {
    const gameRoot = this.#projects.get(project).root;
    const root = artRoot(gameRoot);
    const done: string[] = [];
    if (d.bible) {
      writeAtomic(join(root, "bible.md"), `${d.bible}\n`);
      done.push("bible mise à jour");
      this.#journal.append({ project, actor: { kind: "agent", role: "art_director", run: this.#orchestrator.name }, type: "art.bible_updated", subject: null, payload: {} });
    }
    const m = readManifest(gameRoot);
    const now = this.#clock.now();
    for (const raw of d.assets) {
      const str = (k: string) => (typeof raw[k] === "string" ? (raw[k] as string).trim().slice(0, 2000) : "");
      const existing = m.assets.find((a) => a.id === str("id"));
      if (existing) {
        for (const k of ["name", "type", "usage", "specs"] as const) if (str(k)) existing[k] = str(k);
        const status = str("status") as AssetStatus;
        if (status === "production" || status === "propose") this.#setStatus(existing, status);
        existing.updated_at = now;
        done.push(`${existing.id} modifié`);
      } else if (str("name")) {
        const a: Asset = {
          id: nextAssetId(m),
          name: str("name").slice(0, 120),
          type: str("type") || "visuel",
          usage: str("usage"),
          specs: str("specs"),
          status: str("status") === "production" ? "production" : "propose",
          prompts: [],
          refs: [],
          renders: [],
          verdict: null,
          created_at: now,
          updated_at: now,
        };
        m.assets.push(a);
        done.push(`${a.id} proposé`);
      }
    }
    for (const mj of d.midjourney) {
      const a = m.assets.find((x) => x.id === mj.asset);
      if (!a) continue;
      a.prompts = mj.prompts.map((p) => p.slice(0, 2000));
      a.refs = mj.refs.filter((r) => safeRel(r) && existsSync(join(root, r)));
      if (a.status === "propose") this.#setStatus(a, "production");
      a.updated_at = now;
      done.push(`prompts Midjourney pour ${a.id}`);
    }
    const produce: string[] = [];
    for (const g of d.generate) {
      const a = m.assets.find((x) => x.id === g.asset);
      if (!a || a.status === "integration" || a.status === "integre") continue;
      a.prompts = g.prompts.map((p) => p.slice(0, 2000));
      if (g.format) a.format = g.format;
      if (a.status === "propose") this.#setStatus(a, "production");
      a.updated_at = now;
      produce.push(a.id);
    }
    for (const t of d.model3d) {
      const a = m.assets.find((x) => x.id === t.asset);
      if (!a || a.status === "integration" || a.status === "integre") continue;
      a.model3d = t.spec;
      a.updated_at = now;
      done.push(`3D prévue pour ${a.id} (${t.spec.size} m, ${t.spec.tris} triangles${t.spec.animations.length ? `, ${t.spec.animations.join(", ")}` : ""})`);
    }
    if (produce.length) done.push(this.#imagegen.state().installed ? `génération lancée pour ${produce.join(", ")}` : `prompts prêts pour ${produce.join(", ")} (générateur pas encore installé)`);
    if (d.assets.length || d.midjourney.length || d.generate.length || d.model3d.length) writeManifest(gameRoot, m);
    if (d.notes.length) {
      const notes = this.#notes(root);
      for (const n of d.notes) if (safeRel(n.file) && existsSync(join(root, n.file))) notes[n.file] = n.note;
      writeAtomic(join(root, "moodboard", "notes.json"), `${JSON.stringify(notes, null, 2)}\n`);
      done.push(`${d.notes.length} image(s) commentée(s)`);
    }
    return done;
  }

  // ── Générateur local (ADR-46) ──

  #startProduce(project: string, id: string): void {
    const gens = this.#generating.get(project) ?? new Map<string, Generating>();
    if (gens.has(id)) return;
    gens.set(id, { asset: id, round: 1, rounds: ROUNDS, step: "En attente de la carte graphique" });
    this.#generating.set(project, gens);
    this.#track(
      this.#produce(project, id)
        .finally(() => gens.delete(id))
        .then((next) => {
          if (next === "model") this.#startModel(project, id);
          if (next === "integrate") return this.#autoIntegrate(project, id, "system");
        }),
    );
  }

  /** Jusqu'à trois tours : trois essais, le validateur choisit le meilleur ; s'il refuse, nouveau tour avec son prompt corrigé. */
  async #produce(project: string, id: string): Promise<"model" | "integrate" | null> {
    const gameRoot = this.#projects.get(project).root;
    const root = artRoot(gameRoot);
    const progress = this.#generating.get(project)!.get(id)!;
    try {
      for (let round = 1; round <= ROUNDS; round++) {
        progress.round = round;
        let asset = readManifest(gameRoot).assets.find((a) => a.id === id);
        if (!asset?.prompts[0]) return null;
        const prompt = asset.prompts[0];
        const [width, height] = (asset.format ?? "1024x1024").split("x").map(Number) as [number, number];
        const files: string[] = [];
        for (let v = 1; v <= VARIANTS; v++) {
          progress.step = `Essai ${v} sur ${VARIANTS}`;
          const png = await this.#imagegen.generate({ prompt, width, height, seed: randomInt(2 ** 31) });
          const file = this.#free(root, "production", `${id.toLowerCase()}-t${round}-e${v}`, ".png");
          writeAtomic(join(root, file), png);
          files.push(file);
        }
        let m = readManifest(gameRoot);
        asset = m.assets.find((a) => a.id === id);
        if (!asset) return null;
        asset.renders.push(...files);
        this.#setStatus(asset, "a_valider");
        writeManifest(gameRoot, m);
        await this.#commit(gameRoot, `art: ${files.length} essais générés pour ${id} (tour ${round})`);

        progress.step = "Le validateur compare les essais";
        const v = await this.#pick(project, asset, files, prompt);
        m = readManifest(gameRoot);
        asset = m.assets.find((a) => a.id === id);
        if (!asset) return null;
        const to3d = !!asset.model3d;
        const best = files[Math.min(files.length, Math.max(1, v.best)) - 1]!;
        // Le meilleur essai passe en dernier : c'est lui que la fiche montre.
        asset.renders = [...asset.renders.filter((r) => r !== best), best];
        asset.verdict = { ok: v.ok, summary: v.summary, points: v.points, prompt: v.prompt, file: best, by: "validator", at: this.#clock.now() };
        this.#setStatus(asset, v.ok && !to3d ? "valide" : "production");
        if (!v.ok && v.prompt) asset.prompts = [v.prompt, ...asset.prompts.filter((p) => p !== v.prompt)].slice(0, 6);
        writeManifest(gameRoot, m);
        await this.#commit(gameRoot, `art: ${id} ${v.ok ? (to3d ? "image validée" : "validé") : "à retoucher"} (validateur, tour ${round})`);
        this.#journal.append({ project, actor: { kind: "agent", role: "art_director", run: this.#orchestrator.name }, type: v.ok ? "art.asset_validated" : "art.asset_rejected", subject: id, payload: { by: "validator", round } });
        this.#insert(
          project,
          "art",
          [
            ...files.map((f) => `${IMAGE_MARK}${f}`),
            v.ok
              ? `**${id} « ${asset.name} » : conforme** (essai ${files.indexOf(best) + 1}, tour ${round}). ${v.summary}`
              : `**${id} « ${asset.name} » : pas encore** (tour ${round} sur ${ROUNDS}). ${v.summary}`,
            ...v.points.map((p) => `- ${p}`),
            v.ok
              ? to3d
                ? "Image validée : elle part à l'atelier 3D."
                : "Je le fais intégrer dans le jeu."
              : round === ROUNDS
                ? "Trois tours sans essai conforme : le meilleur est sur la fiche. À vous de trancher (« Valider quand même » ou « Refaire »), ou dites-moi ce qui cloche."
                : "Je relance un tour avec un prompt corrigé.",
          ].join("\n"),
          null,
        );
        if (v.ok) return to3d ? "model" : "integrate";
      }
    } catch (err) {
      this.#insert(project, "art", `Le générateur n'a pas pu fabriquer ${id} : ${(err as Error).message.slice(0, 300)}. Vous pouvez relancer depuis sa fiche.`, null);
      const m = readManifest(gameRoot);
      const a = m.assets.find((x) => x.id === id);
      if (a?.status === "a_valider") {
        this.#setStatus(a, "production");
        writeManifest(gameRoot, m);
      }
    }
    return null;
  }

  // ── Atelier 3D (ADR-47) ──

  /** Ce qui manque à l'atelier 3D, en clair, ou null s'il est prêt. */
  #missing3d(): string | null {
    const s = this.#model3d.state();
    const missing = [s.blender.installed ? "" : "installez Blender", s.tripo.configured ? "" : "ajoutez votre clé Tripo"].filter(Boolean);
    return missing.length ? missing.join(" et ").replace(/^./, (c) => c.toUpperCase()) : null;
  }

  #startModel(project: string, id: string): void {
    const missing = this.#missing3d();
    if (missing) {
      this.#insert(project, "art", `La 3D de ${id} attend l'atelier 3D : ${missing.toLowerCase()} (onglet Visuels). Elle partira d'un clic sur « Fabriquer la 3D ».`, null);
      return;
    }
    const gens = this.#generating.get(project) ?? new Map<string, Generating>();
    if (gens.has(id)) return;
    gens.set(id, { asset: id, round: 1, rounds: MODEL_ROUNDS, step: "Préparation de la 3D" });
    this.#generating.set(project, gens);
    this.#track(
      this.#produceModel(project, id)
        .finally(() => gens.delete(id))
        .then((ok) => (ok ? this.#autoIntegrate(project, id, "system") : undefined)),
    );
  }

  /** Jusqu'à deux tours : Tripo (modèle, squelette, animations), Blender (mesures, photos), validateur. */
  async #produceModel(project: string, id: string): Promise<boolean> {
    const gameRoot = this.#projects.get(project).root;
    const root = artRoot(gameRoot);
    const progress = this.#generating.get(project)!.get(id)!;
    try {
      for (let round = 1; round <= MODEL_ROUNDS; round++) {
        progress.round = round;
        const asset = readManifest(gameRoot).assets.find((a) => a.id === id);
        const source = asset?.verdict?.ok ? asset.verdict.file : null;
        if (!asset?.model3d || !source) return false;
        const spec = asset.model3d;
        mkdirSync(join(root, "models"), { recursive: true });
        const raw = join(root, "models", `.${id.toLowerCase()}-brut.glb`);
        const { glb, credits, extras = [], animations } = await this.#model3d.tripo({
          image: readFileSync(join(root, source)),
          ext: extname(source).slice(1).toLowerCase().replace("jpeg", "jpg"),
          spec,
          seed: randomInt(2 ** 31),
          step: (s) => (progress.step = s),
        });
        writeAtomic(raw, glb);
        const extraFiles = extras.map((b, i) => {
          const f = join(root, "models", `.${id.toLowerCase()}-brut-${i + 2}.glb`);
          writeAtomic(f, b);
          return f;
        });
        progress.step = "Blender met le modèle aux mesures du jeu";
        const file = `models/${id.toLowerCase()}-t${round}.glb`;
        const done = await this.#model3d
          .finish({ input: raw, output: join(root, file), rendersDir: join(root, "production"), prefix: `${id.toLowerCase()}-3d-t${round}`, spec, extras: extraFiles, animations })
          .finally(() => [raw, ...extraFiles].forEach((f) => rmSync(f, { force: true })));
        const renders = done.renders.map((r) => relative(root, r).replace(/\\/g, "/"));
        let m = readManifest(gameRoot);
        let a = m.assets.find((x) => x.id === id);
        if (!a) return false;
        a.model = { file, source, renders, tris: done.tris, dims: done.dims, animations: done.animations, verdict: null };
        this.#setStatus(a, "a_valider");
        writeManifest(gameRoot, m);
        await this.#commit(gameRoot, `art: modèle 3D de ${id} (tour ${round}, ${credits} crédits Tripo)`);

        progress.step = "Le validateur regarde le modèle sous tous les angles";
        const busy = this.#validating.get(project) ?? new Set<string>();
        busy.add(id);
        this.#validating.set(project, busy);
        let v: { ok: boolean; summary: string; points: string[] };
        try {
          const { data } = await this.#orchestrator.structured({
            systemPrompt: MODEL_VALIDATOR_SYSTEM,
            prompt: [
              `Modèle 3D de l'asset ${id} « ${a.name} » (${a.type}). Usage : ${a.usage}. Spécifications : ${a.specs || "aucune"}.`,
              `Image validée qui a servi de modèle : ${source}`,
              `Photos (face, trois-quarts, profil, dos) : ${renders.join(", ")}`,
              `Mesures : ${done.dims.map((d) => `${d} m`).join(" × ")} (demandé : ${spec.size} m pour la plus grande dimension), ${done.tris} triangles (budget ${spec.tris})${done.animations.length ? `, animations : ${done.animations.join(", ")}` : ""}.`,
            ].join("\n"),
            jsonSchema: VERDICT_SCHEMA,
            readDir: root,
            role: "art",
            meta: { project, agent: "art_director" },
          });
          const d = data as { ok: boolean; summary: string; points: string[] };
          v = { ok: !!d.ok, summary: String(d.summary ?? "").slice(0, 400), points: (d.points ?? []).slice(0, 8) };
        } finally {
          busy.delete(id);
        }
        m = readManifest(gameRoot);
        a = m.assets.find((x) => x.id === id);
        if (!a?.model) return false;
        a.model.verdict = { ok: v.ok, summary: v.summary, points: v.points, prompt: null, file, by: "validator", at: this.#clock.now() };
        this.#setStatus(a, v.ok ? "valide" : "production");
        writeManifest(gameRoot, m);
        await this.#commit(gameRoot, `art: modèle 3D de ${id} ${v.ok ? "validé" : "à retoucher"} (validateur, tour ${round})`);
        this.#journal.append({ project, actor: { kind: "agent", role: "art_director", run: this.#orchestrator.name }, type: v.ok ? "art.model_validated" : "art.model_rejected", subject: id, payload: { round, credits } });
        this.#insert(
          project,
          "art",
          [
            ...renders.map((r) => `${IMAGE_MARK}${r}`),
            v.ok ? `**${id} « ${a.name} » en 3D : conforme** (tour ${round}). ${v.summary}` : `**${id} « ${a.name} » en 3D : pas encore** (tour ${round} sur ${MODEL_ROUNDS}). ${v.summary}`,
            ...v.points.map((p) => `- ${p}`),
            `${done.dims.map((d) => `${d} m`).join(" × ")}, ${done.tris} triangles${done.animations.length ? `, animations : ${done.animations.join(", ")}` : ""} · ${credits} crédits Tripo.`,
            v.ok
              ? "Je le fais intégrer dans le jeu."
              : round === MODEL_ROUNDS
                ? "Deux tours sans modèle conforme : à vous de trancher (« Valider quand même », « Refaire la 3D »), ou demandez-moi une nouvelle image de départ."
                : "Je relance un tour.",
          ].join("\n"),
          null,
        );
        if (v.ok) return true;
      }
    } catch (err) {
      this.#insert(project, "art", `L'atelier 3D n'a pas pu fabriquer ${id} : ${(err as Error).message.slice(0, 300)}. Vous pouvez relancer depuis sa fiche (« Fabriquer la 3D »).`, null);
      const m = readManifest(gameRoot);
      const a = m.assets.find((x) => x.id === id);
      if (a?.status === "a_valider") {
        this.#setStatus(a, "production");
        writeManifest(gameRoot, m);
      }
    }
    return false;
  }

  /** Le validateur regarde tous les essais d'un tour, choisit le meilleur et le juge. */
  async #pick(project: string, asset: Asset, files: string[], prompt: string): Promise<{ best: number; ok: boolean; summary: string; points: string[]; prompt: string | null }> {
    const busy = this.#validating.get(project) ?? new Set<string>();
    busy.add(asset.id);
    this.#validating.set(project, busy);
    try {
      const { data } = await this.#orchestrator.structured({
        systemPrompt: VALIDATOR_SYSTEM,
        prompt: [
          `Le générateur local (Flux) a fait ${files.length} essais pour l'asset ${asset.id} « ${asset.name} » (${asset.type}). Regarde-les tous :`,
          ...files.map((f, k) => `${k + 1}. ${f}`),
          "Choisis le meilleur (best), puis juge-le seul : « ok » s'il peut entrer tel quel dans le jeu.",
          `Usage : ${asset.usage}`,
          `Spécifications : ${asset.specs || "aucune"}`,
          `Prompt utilisé (Flux) : ${prompt}`,
        ].join("\n"),
        jsonSchema: PICK_SCHEMA,
        readDir: artRoot(this.#projects.get(project).root),
        role: "art",
        meta: { project, agent: "art_director" },
      });
      const v = data as { best: number; ok: boolean; summary: string; points: string[]; prompt: string | null };
      return { best: Number(v.best) || 1, ok: !!v.ok, summary: String(v.summary ?? "").slice(0, 400), points: (v.points ?? []).slice(0, 8), prompt: v.prompt ?? null };
    } finally {
      busy.delete(asset.id);
    }
  }

  // ── Validateur ──

  async #validate(project: string, id: string, file: string): Promise<void> {
    const busy = this.#validating.get(project) ?? new Set<string>();
    busy.add(id);
    this.#validating.set(project, busy);
    const gameRoot = this.#projects.get(project).root;
    try {
      const asset = readManifest(gameRoot).assets.find((a) => a.id === id)!;
      const { data } = await this.#orchestrator.structured({
        systemPrompt: VALIDATOR_SYSTEM,
        prompt: `Juge le rendu « ${file} » pour l'asset ${id} « ${asset.name} » (${asset.type}).\nUsage : ${asset.usage}\nSpécifications : ${asset.specs || "aucune"}\nPrompt utilisé : ${asset.prompts[0] ?? "inconnu"}`,
        jsonSchema: VERDICT_SCHEMA,
        readDir: artRoot(gameRoot),
        role: "art",
        meta: { project, agent: "art_director" },
      });
      const v = data as { ok: boolean; summary: string; points: string[]; prompt: string | null };
      // Le manifeste a pu bouger pendant le jugement : on relit avant d'écrire.
      const m = readManifest(gameRoot);
      const a = m.assets.find((x) => x.id === id);
      if (!a || a.renders.at(-1) !== file) return; // un rendu plus récent a été déposé : c'est lui qui compte
      const verdict: Verdict = { ok: !!v.ok, summary: String(v.summary ?? "").slice(0, 400), points: (v.points ?? []).slice(0, 8), prompt: v.prompt ?? null, file, by: "validator", at: this.#clock.now() };
      a.verdict = verdict;
      const to3d = !!a.model3d;
      this.#setStatus(a, verdict.ok && !to3d ? "valide" : "production");
      if (!verdict.ok && verdict.prompt) a.prompts = [verdict.prompt, ...a.prompts.filter((p) => p !== verdict.prompt)].slice(0, 6);
      writeManifest(gameRoot, m);
      await this.#commit(gameRoot, `art: ${id} ${verdict.ok ? (to3d ? "image validée" : "validé") : "à retoucher"} (validateur)`);
      this.#journal.append({ project, actor: { kind: "agent", role: "art_director", run: this.#orchestrator.name }, type: verdict.ok ? "art.asset_validated" : "art.asset_rejected", subject: id, payload: { by: "validator" } });
      this.#insert(
        project,
        "art",
        [
          `${IMAGE_MARK}${file}`,
          verdict.ok ? `**${id} « ${a.name} » : conforme.** ${verdict.summary}` : `**${id} « ${a.name} » : à retoucher.** ${verdict.summary}`,
          ...verdict.points.map((p) => `- ${p}`),
          verdict.ok ? (to3d ? "Image validée : elle part à l'atelier 3D." : "Je le fais intégrer dans le jeu.") : verdict.prompt ? "Le prompt corrigé est en tête de sa fiche." : "",
        ]
          .filter(Boolean)
          .join("\n"),
        null,
      );
      if (verdict.ok && to3d) this.#startModel(project, id);
      else if (verdict.ok) await this.#autoIntegrate(project, id, "system");
    } catch (err) {
      this.#insert(project, "art", `Le validateur n'a pas pu juger ${file} : ${(err as Error).message.slice(0, 300)}. Vous pouvez trancher vous-même depuis la fiche.`, null);
    } finally {
      busy.delete(id);
    }
  }

  // ── Outils ──

  #setStatus(a: Asset, status: AssetStatus): void {
    a.status = status;
    a.updated_at = this.#clock.now();
  }

  #notes(root: string): Record<string, string> {
    const f = join(root, "moodboard", "notes.json");
    if (!existsSync(f)) return {};
    try {
      return JSON.parse(readFileSync(f, "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  }

  #free(root: string, dir: string, base: string, ext: string): string {
    mkdirSync(join(root, dir), { recursive: true });
    for (let i = 1; ; i++) {
      const file = `${dir}/${base}${i === 1 ? "" : `-${i}`}${ext}`;
      if (!existsSync(join(root, file))) return file;
    }
  }

  async #commit(gameRoot: string, message: string): Promise<void> {
    try {
      await this.#vcs.commitPaths(gameRoot, [ART_DIR.replace(/\\/g, "/")], message.slice(0, 200));
    } catch {
      /* dépôt indisponible un instant : le prochain commit emportera les fichiers */
    }
  }

  #insert(project: string, role: ArtMessage["role"], text: string, cost: number | null): ArtMessage {
    const row = this.#db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM art_messages WHERE project = ?").get(project) as { next: number };
    const m: ArtMessage = { id: randomUUID(), project, seq: row.next, role, text, at: this.#clock.now(), cost_usd: cost };
    this.#db.prepare("INSERT INTO art_messages (id, project, seq, role, text, at, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?)").run(m.id, project, m.seq, role, text, m.at, cost);
    return m;
  }

  #track(p: Promise<unknown>): void {
    this.#background.add(p);
    void p.finally(() => this.#background.delete(p));
  }

  /** Un fichier de studio/art à servir (images seulement, jamais en dehors du dossier). */
  file(project: string, rel: string): { path: string; mime: string } {
    if (!safeRel(rel)) throw new ArtError("Chemin refusé");
    const mime = IMAGE_MIME[extname(rel).toLowerCase()];
    if (!mime) throw new ArtError("Seules les images sont servies");
    const path = join(this.#root(project), normalize(rel));
    if (!existsSync(path)) throw new ArtError("Image introuvable");
    return { path, mime };
  }
}

/** Chemin relatif sûr, à l'intérieur de studio/art : ni absolu, ni « .. ». */
export function safeRel(rel: string): boolean {
  if (!rel || rel.length > 300 || /^[a-z]:|^[\\/]/i.test(rel)) return false;
  return rel.split(/[\\/]/).every((part) => part !== "" && part !== "." && part !== "..");
}

function renderArtHistory(history: ArtMessage[]): string {
  const lines = history.map((m) => `<message de="${m.role === "human" ? "directeur créatif" : "toi (Directeur artistique)"}">\n${m.text.replaceAll(IMAGE_MARK, "Image : ")}\n</message>`);
  return `Discussion jusqu'ici (la dernière est celle à laquelle tu réponds) :\n\n${lines.join("\n\n")}\n\nRéponds au dernier message du directeur créatif. Si des images y sont citées, regarde-les d'abord (Read).`;
}

