import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { basename, extname, join, normalize, relative } from "node:path";
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
import { ART_DIR, artRoot, nextAssetId, PENDING_VISUALS, readManifest, writeAtomic, writeManifest, type Asset, type AssetStatus, type Verdict } from "./manifest.ts";
import type { GenState, ImageGenPort } from "./imagegen.ts";
import { directionContext, nextId, readDirection, recordChoice, writeDirection, type Direction, type Verdict as Taste } from "./direction.ts";
import { RealWebRefs, type WebRefsPort } from "./web-refs.ts";
import { rigAnimations, type Model3DPort, type Model3DSpec, type Model3DState, type ViewEdit, type ViewImage } from "./model3d.ts";
import {
  ART_SYSTEM,
  BOARD_MARK,
  CHOICE_MARK,
  VISUAL_SEP,
  DONE_MARK,
  IMAGE_MARK,
  INGAME_SCHEMA,
  INGAME_SYSTEM,
  ANIM_SCHEMA,
  ANIM_VALIDATOR_SYSTEM,
  MODEL_SCHEMA,
  MODEL_VALIDATOR_SYSTEM,
  parseArtDirectives,
  PICK_SCHEMA,
  REFERENCE_VALIDATOR_SYSTEM,
  VALIDATOR_SYSTEM,
  VERDICT_SCHEMA,
  VIEWS_SCHEMA,
  VIEWS_SYSTEM,
  WORKSHOP_STEP_SCHEMA,
  WORKSHOP_SYSTEM,
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
  /** La direction visuelle : choix tranchés, références et avis, duels, style retenu (ADR-58). */
  direction: Direction;
  /**
   * Le Directeur artistique est en train de répondre, le validateur de juger, le générateur de fabriquer ;
   * `exploring` : planches, duels et vignettes en cours, en clair (ADR-58).
   */
  busy: { replying: boolean; validating: string[]; generating: Generating[]; exploring: string[] };
  /** Le générateur d'images local (ADR-46). */
  generator: GenState;
  /** L'atelier 3D : Blender et Tripo (ADR-47). */
  workshop3d: Model3DState;
};
/**
 * Où en est la fabrication d'un asset (ADR-52), pour l'onglet Visuels : l'étape du circuit, ce qui se passe en clair, ce
 * que l'artisan 3D dit faire, et la dernière image produite (`studio/art` ou une photo de l'atelier Blender).
 */
export type Generating = {
  asset: string;
  round: number;
  rounds: number;
  step: string;
  stage?: Stage;
  note?: string | null;
  preview?: { kind: "art" | "atelier"; file: string } | null;
};
export type Stage = "croquis" | "image" | "planche" | "tripo" | "atelier" | "controle";

/** Essais par tour et tours au plus : le générateur réessaie seul avec le prompt corrigé du validateur (deux tours, ADR-49). */
const VARIANTS = 3;
const ROUNDS = 2;
/** Passes de l'artisan 3D au plus : Tripo ne travaille qu'une fois, la seconde passe reprend la même scène dans Blender. */
const MODEL_ROUNDS = 2;
/**
 * Pas de l'artisan 3D dans Blender, par passe. Un modèle de Tripo arrive fini (forme et texture) : l'artisan le range
 * seulement (orientation, matière, lueurs), en peu de pas (ADR-54). Un objet simple, il le modélise de zéro.
 */
const WORKSHOP_STEPS = 12;
const TRIPO_STEPS = 4;

const MAX_IMAGE = 15 * 1024 * 1024;
const HISTORY = 30;
/** Chantiers qui ne bougeront plus : fusionnés ou abandonnés d'une façon ou d'une autre. */
const OVER: Task["status"][] = ["merged", "cancelled", "abandoned", "rejected", "failed"];
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
  /** Les modèles déjà branchés dans le jeu dont une version retouchée part en intégration (ADR-55) : « project/id ». */
  readonly #replacing = new Set<string>();
  readonly #vitrine: (project: string, id: string, file: string) => Promise<string | null>;
  readonly #webRefs: WebRefsPort;
  /** Planches, duels et vignettes en cours, par projet : clé → ce qui se passe, en clair (ADR-58). */
  readonly #exploring = new Map<string, Map<string, string>>();
  /** Les chantiers du projet, pour savoir quand un visuel validé a sa place dans le jeu (ADR-60). */
  tasks: { list(project: string): Task[] } | null = null;

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
    /** Une capture de la scène vitrine du jeu (« ?vitrine=A-0001 ») dans `file`, ou null si elle n'a pas pu être prise (ADR-49). */
    vitrine?: (project: string, id: string, file: string) => Promise<string | null>;
    /** Téléchargement des références trouvées sur le web (ADR-58). */
    webRefs?: WebRefsPort;
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
    this.#vitrine = deps.vitrine ?? (async () => null);
    this.#webRefs = deps.webRefs ?? new RealWebRefs();
  }

  #root(project: string): string {
    return artRoot(this.#projects.get(project).root);
  }

  state(project: string): ArtState {
    this.#backfill(project);
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
      direction: readDirection(this.#projects.get(project).root),
      busy: {
        replying: this.#replying.has(project),
        validating: [...(this.#validating.get(project) ?? [])],
        generating: [...(this.#generating.get(project)?.values() ?? [])],
        exploring: [...(this.#exploring.get(project)?.values() ?? [])],
      },
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
      ...[...this.#exploring].filter(([project, jobs]) => jobs.size && !this.#replying.has(project)).map(([project]) => ({ project, kind: "reply" as const })),
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

  /** Installer Flux Kontext (≈ 17 Go), sur votre clic : retouches par consigne et air de famille (ADR-51). */
  installKontext(session: HumanSession): GenState {
    assertHumanSession(session);
    if (!this.#imagegen.state().installed) throw new ArtError("Installez d'abord le générateur d'images");
    this.#imagegen.installKontext();
    this.#journal.append({ project: null, actor: { kind: "human" }, type: "tool.install_started", subject: "flux-kontext", payload: {} });
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
    if (!asset.model3d.simple && !asset.verdict?.ok) throw new ArtError("Il faut d'abord une image validée");
    const missing = this.#missing3d(!!asset.model3d.simple);
    if (missing) throw new ArtError(missing);
    if (asset.status === "integration" || asset.status === "integre") throw new ArtError("Cet asset est déjà parti dans le jeu");
    this.#startModel(project, id);
    return asset;
  }

  /**
   * Reprendre la finition d'un modèle déjà fabriqué dans sa scène d'atelier (ADR-55) : l'artisan corrige les remarques du
   * validateur (teintes, lueurs, matière), sans repayer Tripo ; le modèle repart ensuite au jeu s'il est jugé bon.
   */
  retouchModel(session: HumanSession, project: string, id: string): Asset {
    assertHumanSession(session);
    const asset = readManifest(this.#projects.get(project).root).assets.find((a) => a.id === id);
    if (!asset) throw new ArtError(`Asset introuvable : ${id}`);
    if (!asset.model3d || !asset.model) throw new ArtError("Cet asset n'a pas encore de modèle 3D");
    if (!this.#model3d.state().blender.installed) throw new ArtError("Installez d'abord Blender");
    if (!existsSync(join(this.#model3d.atelier(`${project}-${id}`), "scene.blend"))) throw new ArtError("La scène de l'atelier n'existe plus : « Refaire la 3D »");
    this.#startModel(project, id, true);
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
    // Les réponses aux questions de goût sont gardées dans la direction, avec l'image de l'option (ADR-58).
    this.#backfill(project);
    const choices = this.#answers(project, body);
    const human = this.#insert(project, "human", body, null);
    this.#journal.append({ project, actor: { kind: "human" }, type: "art.message", subject: human.id, payload: {} });
    // Un croquis choisi d'un clic : la fabrication part tout de suite, sans tour du Directeur artistique (ADR-49).
    const pick = SKETCH_ANSWER.exec(body);
    const style = STYLE_ANSWER.exec(body);
    if (pick) this.#track(this.#chooseSketch(project, pick[1]!, Number(pick[2]), choices));
    // Un style choisi au duel : il devient le style du jeu, puis le Directeur artistique met la bible à jour.
    else if (style) this.#track(this.#chooseStyle(project, style[1]!, Number(style[2]), choices).then(() => this.#turn(project)));
    else {
      if (choices) this.#track(choices);
      this.#turn(project);
    }
    return human;
  }

  /**
   * Les choix faits avant la direction visuelle (ADR-58) : la première fois, direction.json est rempli depuis l'historique
   * de la discussion (questions posées, réponses données), pour que rien de ce qui a été tranché ne soit perdu.
   */
  #backfill(project: string): void {
    const gameRoot = this.#projects.get(project).root;
    if (existsSync(join(artRoot(gameRoot), "direction.json"))) return;
    const history = this.messages(project);
    if (!history.length) return;
    const d = readDirection(gameRoot);
    const asked = new Map<string, string[]>();
    for (const m of history) {
      for (const line of m.text.split("\n")) {
        if (m.role === "art" && line.startsWith(CHOICE_MARK)) {
          const [q, ...options] = line.slice(CHOICE_MARK.length).split(" || ");
          asked.set(q!.trim(), options);
          continue;
        }
        const a = m.role === "human" ? /^(.+?\?)\s*→\s*(.+)$/.exec(line.trim()) : null;
        if (!a || !asked.has(a[1]!.trim()) || /^je te laisse choisir$/i.test(a[2]!.trim())) continue;
        const answer = a[2]!.replace(/§[A-Z]+§/g, "").trim();
        const image = asked.get(a[1]!.trim())!.find((o) => o.split(VISUAL_SEP)[0]!.trim() === answer)?.split(VISUAL_SEP)[1]?.trim() ?? null;
        recordChoice(d, { question: a[1]!.trim(), answer, image: image && safeRel(image) ? image : null, at: m.at });
      }
    }
    writeDirection(gameRoot, d);
  }

  /**
   * « question → réponse » des lignes de votre message, reconnues dans les dernières questions du Directeur
   * artistique : enregistrées dans direction.json (l'image de l'option avec). « Je te laisse choisir » n'est pas un choix.
   */
  #answers(project: string, body: string): Promise<void> | null {
    const asked = new Map<string, string[]>();
    for (const m of this.messages(project).filter((x) => x.role === "art").slice(-6))
      for (const line of m.text.split("\n").filter((l) => l.startsWith(CHOICE_MARK))) {
        const [q, ...options] = line.slice(CHOICE_MARK.length).split(" || ");
        asked.set(q!.trim(), options);
      }
    const found = body
      .split("\n")
      .map((l) => /^(.+?\?)\s*→\s*(.+)$/.exec(l.trim()))
      .filter((m): m is RegExpExecArray => !!m && asked.has(m[1]!.trim()) && !/^je te laisse choisir$/i.test(m[2]!.trim()));
    if (!found.length) return null;
    const gameRoot = this.#projects.get(project).root;
    const d = readDirection(gameRoot);
    const now = this.#clock.now();
    for (const m of found) {
      const answer = m[2]!.trim();
      const option = asked.get(m[1]!.trim())!.find((o) => o.split(VISUAL_SEP)[0]!.trim() === answer);
      const image = option?.split(VISUAL_SEP)[1]?.trim() ?? null;
      recordChoice(d, { question: m[1]!.trim(), answer, image: image && safeRel(image) ? image : null, at: now });
    }
    writeDirection(gameRoot, d);
    return this.#commit(gameRoot, `art: ${found.length} choix de goût gardé(s)`);
  }

  /**
   * Le Concepteur confie les visuels d'une conception (ADR-59) : une fiche « proposé » par visuel (numéro A-xxxx rendu au
   * Concepteur pour les consignes des chantiers), puis un tour du Directeur artistique, qui lit le dossier, relie les
   * fiches à la bible et cadre le style avec vous (questions illustrées, croquis) avant toute fabrication.
   */
  async brief(project: string, input: { conception: string; dossier: string; visuels: { cle: string; nom: string; type: string; usage: string; specs: string }[] }): Promise<Record<string, string>> {
    const gameRoot = this.#projects.get(project).root;
    const m = readManifest(gameRoot);
    const now = this.#clock.now();
    const ids: Record<string, string> = {};
    for (const v of input.visuels.slice(0, 25)) {
      const a: Asset = {
        id: nextAssetId(m),
        name: v.nom.slice(0, 120),
        type: v.type || "visuel",
        usage: v.usage.slice(0, 2000),
        specs: v.specs.slice(0, 2000),
        status: "propose",
        prompts: [],
        refs: [],
        renders: [],
        verdict: null,
        created_at: now,
        updated_at: now,
      };
      m.assets.push(a);
      ids[v.cle] = a.id;
    }
    writeManifest(gameRoot, m);
    // Le DA ne lit que studio/art : le dossier de conception y est copié (incident du 22/10, ADR-61).
    const source = join(gameRoot, input.dossier);
    const dossier = existsSync(source) ? `conceptions/${basename(source)}` : null;
    if (dossier) {
      mkdirSync(join(artRoot(gameRoot), "conceptions"), { recursive: true });
      copyFileSync(source, join(artRoot(gameRoot), dossier));
    }
    await this.#commit(gameRoot, `art: ${Object.keys(ids).length} visuel(s) demandés par la conception « ${input.conception} »`.slice(0, 200));
    const list = input.visuels.map((v) => `- ${ids[v.cle]} « ${v.nom} » (${v.type}) : ${v.usage}${v.specs ? ` — ${v.specs}` : ""}`).join("\n");
    const text = [
      `(Demande transmise par le Concepteur, conception « ${input.conception} »)`,
      dossier
        ? `Le dossier de conception est copié dans ton dossier : ${dossier} (lis-le : piliers, périmètre, étapes). Les chantiers`
        : `Pas de dossier de conception lisible. Les chantiers de développement partent de leur côté avec des visuels provisoires ; chacun de ces visuels entrera dans le jeu par son propre chantier d'intégration une fois validé.`,
      `Fiches créées pour toi (modifie-les avec [[ASSET]] et leur id, regroupe ou écarte ce qui n'a pas lieu d'être) :\n${list}`,
      "Commence par cadrer avec moi ce qui doit l'être (direction, questions illustrées), dans l'ordre où le jeu en a besoin.",
    ].join("\n\n");
    const human = this.#insert(project, "human", text, null);
    this.#journal.append({ project, actor: { kind: "system" }, type: "art.briefed", subject: human.id, payload: { assets: Object.values(ids) } });
    this.#turn(project);
    return ids;
  }

  /**
   * Votre avis sur les références (ADR-58) : « aime », « evite », ou null pour le retirer. `tell` : le Directeur
   * artistique le reçoit en message et en tient compte tout de suite ; sinon il le lira à son prochain tour.
   */
  async react(session: HumanSession, project: string, input: { verdicts: Record<string, Taste | null>; comment?: string; tell?: boolean }): Promise<Direction> {
    assertHumanSession(session);
    const gameRoot = this.#projects.get(project).root;
    const d = readDirection(gameRoot);
    const changed: { title: string; verdict: Taste | null }[] = [];
    for (const [file, verdict] of Object.entries(input.verdicts)) {
      const r = d.references.find((x) => x.file === file);
      if (!r || (verdict !== null && verdict !== "aime" && verdict !== "evite")) continue;
      r.verdict = verdict;
      changed.push({ title: r.title || r.file, verdict });
    }
    const comment = input.comment?.trim().slice(0, 4000) ?? "";
    if (!changed.length && !comment) throw new ArtError("Donnez votre avis sur au moins une image");
    writeDirection(gameRoot, d);
    await this.#commit(gameRoot, `art: avis sur ${changed.length} référence(s)`);
    this.#journal.append({ project, actor: { kind: "human" }, type: "art.references_judged", subject: null, payload: { count: changed.length } });
    if (input.tell === false) return d;
    const list = (v: Taste) => changed.filter((c) => c.verdict === v).map((c) => `« ${c.title} »`);
    const text = [
      "Mon avis sur les références :",
      list("aime").length ? `- J'aime : ${list("aime").join(", ")}` : "",
      list("evite").length ? `- À éviter : ${list("evite").join(", ")}` : "",
      comment,
    ]
      .filter(Boolean)
      .join("\n");
    const human = this.#insert(project, "human", text, null);
    this.#journal.append({ project, actor: { kind: "human" }, type: "art.message", subject: human.id, payload: {} });
    this.#turn(project);
    return d;
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
      if (await this.#holdForPlaceholder(project, id)) return;
      await this.#requestIntegration(project, id, by);
    } catch (err) {
      this.#insert(project, "art", `Je n'ai pas pu envoyer ${id} au directeur pour l'intégrer : ${(err as Error).message.slice(0, 300)}. Utilisez « Faire intégrer » sur sa fiche.`, null);
    }
  }

  /** Les chantiers d'une conception qui posent un provisoire pour cet asset (ADR-59), le premier à passer d'abord. */
  #dependents(project: string, id: string): Task[] {
    const cited = new RegExp(`\\n- ${id} «`);
    const rank = (t: Task) => (t.status === "draft" ? (t.queued_at ? 1 : 2) : 0);
    return (this.tasks?.list(project) ?? [])
      .filter((t) => t.goal.includes(PENDING_VISUALS) && cited.test(t.goal))
      .sort((a, b) => rank(a) - rank(b) || (a.queued_at ?? "").localeCompare(b.queued_at ?? "") || a.id.localeCompare(b.id));
  }

  /**
   * Un visuel validé avant que le jeu ait sa place (ADR-60) : l'intégration attend la fusion du premier chantier qui en
   * pose le provisoire, sinon le développeur le brancherait dans un jeu qui n'a pas encore l'endroit prévu.
   */
  async #holdForPlaceholder(project: string, id: string): Promise<boolean> {
    const deps = this.#dependents(project, id);
    if (deps.some((t) => t.status === "merged")) return false;
    const first = deps.find((t) => !OVER.includes(t.status));
    if (!first) return false;
    const gameRoot = this.#projects.get(project).root;
    const m = readManifest(gameRoot);
    const asset = m.assets.find((a) => a.id === id);
    if (!asset || asset.status !== "valide") return false;
    if (asset.waitsFor === first.id) return true;
    asset.waitsFor = first.id;
    writeManifest(gameRoot, m);
    await this.#commit(gameRoot, `art: ${id} validé, intégré après ${first.id}`);
    this.#journal.append({ project, actor: { kind: "system" }, type: "art.integration_deferred", subject: id, payload: { task: first.id } });
    this.#insert(project, "art", `${id} « ${asset.name} » est validé. Il partira dans le jeu dès que le chantier ${first.id} « ${first.title} » aura posé sa place (un provisoire) ; son intégration passera alors avant les chantiers suivants.`, null);
    return true;
  }

  /** Un chantier terminé : les visuels qui attendaient leur place partent, ou attendent le chantier suivant qui la pose. */
  async #release(project: string): Promise<void> {
    let waiting: Asset[];
    try {
      waiting = readManifest(this.#projects.get(project).root).assets.filter((a) => a.status === "valide" && a.waitsFor);
    } catch {
      return;
    }
    for (const a of waiting) await this.#autoIntegrate(project, a.id, "system");
  }

  /** La demande au directeur. Un visuel validé (par le validateur ou par vous) y part tout seul (ADR-48). */
  async #requestIntegration(project: string, id: string, by: "human" | "system"): Promise<{ thread: string }> {
    const gameRoot = this.#projects.get(project).root;
    const m = readManifest(gameRoot);
    const asset = m.assets.find((a) => a.id === id);
    if (!asset) throw new ArtError(`Asset introuvable : ${id}`);
    if (asset.status !== "valide" && asset.status !== "integration") throw new ArtError("Seul un asset validé peut être intégré");
    const file = asset.model?.file ?? asset.verdict?.file ?? asset.renders.at(-1);
    asset.waitsFor = null;
    this.#setStatus(asset, "integration");
    writeManifest(gameRoot, m);
    await this.#commit(gameRoot, `art: intégration demandée pour ${id}`);
    const thread = this.#conversations.createThread(project, `Intégrer ${id} : ${asset.name}`.slice(0, 80));
    const model = asset.model;
    const placed = this.#dependents(project, id).filter((t) => t.status === "merged");
    const text = [
      `Le Directeur artistique a fait valider un visuel : ${id} « ${asset.name} » (${asset.type}). Fais-le brancher dans le jeu.`,
      `- Fichier validé : studio/art/${file}`,
      this.#replacing.delete(`${project}/${id}`)
        ? "- C'est une version retouchée d'un modèle déjà branché : remplace l'ancien fichier par celui-ci (mêmes mesures, même squelette, mêmes animations), sans rien changer d'autre au branchement."
        : "",
      model
        ? `- Modèle 3D glTF binaire (.glb) : axe Y vers le haut, 1 unité = 1 mètre, posé au sol (y = 0) et centré, le devant tourné vers +Z, ${model.dims.map((d) => `${d} m`).join(" × ")}, ${model.tris} triangles${model.animations.length ? `, animations : ${model.animations.join(", ")}` : ", sans animation"}. Couleurs, matière mate et lueurs (émissif) sont déjà dans le fichier : garde ses matériaux tels quels. Photos : ${model.renders.map((r) => `studio/art/${r}`).join(", ")}.`
        : "",
      `- Usage : ${asset.usage}`,
      asset.specs ? `- Spécifications : ${asset.specs}` : "",
      placed.length
        ? `- Sa place existe déjà : ${placed.map((t) => `${t.id} « ${t.title} »`).join(", ")} y a posé un provisoire. Remplace ce provisoire par le vrai visuel à son point de chargement, sans refaire le reste.`
        : "",
      "- La bible visuelle (studio/art/bible.md) et le manifeste (studio/art/assets.json) disent le reste.",
      `Lance un chantier dont le titre commence par « ${id} » : le développeur copie le fichier depuis studio/art/ vers les ressources du jeu (sans rien télécharger), le branche à l'endroit prévu, et l'ajoute aux crédits.`,
      `Scène vitrine : si le jeu ne l'a pas encore, le même chantier l'ajoute, une fois pour toutes (vérifie-la avant de finir). ${vitrineScene(id)}`,
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
    if (OVER.includes(task.status)) this.#track(this.#release(task.project));
    if (task.status !== "merged") return;
    // Un chantier qui pose un provisoire cite les visuels attendus sans les brancher (ADR-60) : seul son titre compte.
    const ids = new Set(`${task.title} ${task.goal.includes(PENDING_VISUALS) ? "" : task.goal}`.match(/A-\d{4,}/g) ?? []);
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

  /**
   * Après la fusion : le hub photographie la scène vitrine du jeu (à défaut, la capture de lancement du chantier) ; le
   * validateur la regarde ; si le visuel rend mal, une retouche part au directeur (une fois).
   */
  async #checkInGame(project: string, id: string, task: string): Promise<void> {
    const gameRoot = this.#projects.get(project).root;
    const root = artRoot(gameRoot);
    mkdirSync(join(root, "production"), { recursive: true });
    const vitrine = this.#free(root, "production", `${id.toLowerCase()}-vitrine-${task.toLowerCase()}`, ".png");
    const shotVitrine = await this.#vitrine(project, id, join(root, vitrine)).catch(() => null);
    const shot = shotVitrine && existsSync(shotVitrine) ? null : this.#screenshot(project, task);
    if (!shotVitrine && (!shot || !existsSync(shot))) {
      this.#insert(project, "art", `${id} est dans le jeu (${task}). Pas de capture du jeu pour vérifier le rendu : regardez-le en jouant.`, null);
      return;
    }
    let file = vitrine;
    if (!shotVitrine) {
      rmSync(join(root, vitrine), { force: true });
      file = this.#free(root, "production", `${id.toLowerCase()}-en-jeu-${task.toLowerCase()}`, ".png");
      copyFileSync(shot!, join(root, file));
    }
    const busy = this.#validating.get(project) ?? new Set<string>();
    busy.add(id);
    this.#validating.set(project, busy);
    try {
      const asset = readManifest(gameRoot).assets.find((a) => a.id === id)!;
      const validated = asset.model ? asset.model.renders.join(", ") : (asset.verdict?.file ?? "?");
      const { data } = await this.#orchestrator.structured({
        systemPrompt: INGAME_SYSTEM,
        prompt: `Asset ${id} « ${asset.name} » (${asset.type}), usage : ${asset.usage}.\nFichier validé : ${validated}\n${shotVitrine ? `Capture de la scène vitrine du jeu (?vitrine=${id}), après le chantier ${task}` : `Capture de lancement du jeu après le chantier ${task} (pas de scène vitrine)`} : ${file}`,
        jsonSchema: INGAME_SCHEMA,
        readDir: root,
        role: "art",
        meta: { project, agent: "art_director" },
      });
      const v = data as { visible: boolean; ok: boolean; summary: string; points: string[] };
      const m = readManifest(gameRoot);
      const a = m.assets.find((x) => x.id === id);
      if (!a) return;
      // Invisible dans la vitrine : la scène manque ou ne montre pas l'asset ; une retouche la fait ajouter (une fois).
      const missing = !v.visible && shotVitrine;
      const retry = (missing || (!!v.visible && !v.ok)) && !a.ingame?.retried;
      a.ingame = { task, file, visible: !!v.visible, ok: !!v.visible && !!v.ok, summary: String(v.summary ?? "").slice(0, 400), points: (v.points ?? []).slice(0, 6), retried: retry || !!a.ingame?.retried, at: this.#clock.now() };
      writeManifest(gameRoot, m);
      await this.#commit(gameRoot, `art: ${id} vérifié dans le jeu (${task})`);
      this.#insert(
        project,
        "art",
        [
          `${IMAGE_MARK}${file}`,
          !v.visible
            ? `**${id} dans le jeu : pas visible sur la capture${shotVitrine ? " de la scène vitrine" : " de lancement"}.** ${a.ingame.summary} Regardez-le en jouant.`
            : v.ok
              ? `**${id} dans le jeu : rend bien.** ${a.ingame.summary}`
              : `**${id} dans le jeu : à retoucher.** ${a.ingame.summary}`,
          ...a.ingame.points.map((p) => `- ${p}`),
          retry ? (missing ? "J'ai demandé au directeur du projet de faire marcher la scène vitrine." : "J'ai demandé une retouche au directeur du projet.") : (v.visible && !v.ok) || missing ? "La retouche automatique a déjà été tentée une fois : dites-moi comment vous voulez la reprendre." : "",
        ]
          .filter(Boolean)
          .join("\n"),
        null,
      );
      if (retry) {
        const thread = this.#conversations.createThread(project, `Retoucher ${id} dans le jeu`.slice(0, 80));
        const text = [
          `Le validateur artistique a regardé ${id} « ${a.name} » dans le jeu (capture : studio/art/${file}) : ${missing ? "la scène vitrine ne le montre pas" : "à retoucher"}.`,
          a.ingame.summary,
          ...a.ingame.points.map((p) => `- ${p}`),
          missing
            ? `Lance un chantier dont le titre commence par « ${id} » pour faire marcher la scène vitrine, sans changer le fichier validé. ${vitrineScene(id)} Vérifie-la (test de bout en bout qui ouvre « ?vitrine=${id} » et y trouve l'asset) avant de finir.`
            : `Lance un chantier dont le titre commence par « ${id} » pour corriger l'intégration (taille, orientation, éclairage, fond…), sans changer le fichier validé.`,
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

  // ── Redémarrage du hub (ADR-61) ──

  /** Un travail long noté en base le temps qu'il dure : s'il est encore là au démarrage, le hub s'est arrêté pendant. */
  #jobStart(project: string, kind: "sketch" | "produce" | "model" | "board" | "duel", payload: object, key = `${project}/${kind}/${randomUUID()}`): string {
    this.#db.prepare("INSERT OR REPLACE INTO art_jobs (key, project, kind, payload_json, started_at) VALUES (?, ?, ?, ?, ?)").run(key, project, kind, JSON.stringify(payload), this.#clock.now());
    return key;
  }

  #jobEnd(key: string): void {
    this.#db.prepare("DELETE FROM art_jobs WHERE key = ?").run(key);
  }

  /**
   * Au démarrage : ce que le Directeur artistique faisait quand le hub s'est arrêté repart (croquis, fabrication, planches,
   * duels), et un message resté sans réponse en reçoit une. La 3D ne repart pas seule : Tripo se paie, vous la relancez.
   */
  resume(): void {
    const jobs = this.#db.prepare("SELECT * FROM art_jobs ORDER BY started_at").all() as { key: string; project: string; kind: string; payload_json: string }[];
    this.#db.prepare("DELETE FROM art_jobs").run();
    const models: { project: string; id: string }[] = [];
    for (const j of jobs) {
      const p = JSON.parse(j.payload_json);
      try {
        this.#projects.get(j.project);
        if (j.kind === "sketch") this.#startSketches(j.project, p.id);
        else if (j.kind === "produce") this.#startProduce(j.project, p.id);
        else if (j.kind === "board") this.#startBoard(j.project, p);
        else if (j.kind === "duel") this.#startDuel(j.project, p);
        else if (j.kind === "model") models.push({ project: j.project, id: p.id });
      } catch {
        /* projet retiré entre-temps */
      }
    }
    for (const project of this.#projects.list()) this.#turn(project.slug);
    // Après la réponse en attente, sinon ce mot passerait pour elle.
    for (const m of models) {
      const after = (this.#queue.get(m.project) ?? Promise.resolve()).catch(() => {});
      this.#track(after.then(() => void this.#insert(m.project, "art", `La 3D de ${m.id} a été interrompue par le redémarrage du hub. Je ne la relance pas seule, car Tripo se paie : « Fabriquer la 3D » sur sa fiche la reprend.`, null)));
    }
  }

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
      const parsed = parseArtDirectives(raw);
      const { directives } = parsed;
      // Les options illustrées sont dessinées avant que la question s'affiche (ADR-58).
      const text = await this.#illustrate(project, parsed.text);
      const applied = this.#apply(project, directives);
      // Le cadrage d'abord (ADR-49) : une réponse qui pose une question ne lance aucune fabrication.
      const asking = text.includes(CHOICE_MARK);
      const launches = directives.sketches.length + directives.generate.length + directives.model3d.length;
      if (asking && launches) applied.push("fabrication en attente de vos réponses");
      const summary = applied.length ? `\n${DONE_MARK}${applied.join(" · ")}` : "";
      this.#insert(project, "art", `${text || "C'est noté."}${summary}`, costUsd);
      await this.#commit(p.root, `art: ${applied.join(", ") || "réponse du Directeur artistique"}`);
      // Planches et duels ne fabriquent aucun visuel du jeu : ils partent même avec des questions (ADR-58).
      for (const b of directives.references) this.#startBoard(project, b);
      for (const s of directives.styles) this.#startDuel(project, s);
      if (asking) return;
      // Le générateur part de la fiche à jour, une fois le tour écrit et commité.
      if (this.#imagegen.state().installed) {
        for (const c of directives.sketches) this.#startSketches(project, c.asset);
        for (const g of directives.generate) if (!directives.sketches.some((c) => c.asset === g.asset)) this.#startProduce(project, g.asset);
      }
      // Une 3D sans image à attendre part tout de suite : objet simple, ou image déjà validée (sinon elle suivra l'image).
      const assets = readManifest(p.root).assets;
      for (const t of directives.model3d) {
        const a = assets.find((x) => x.id === t.asset);
        // Des animations changées sur un modèle déjà fait : Tripo les pose sur le squelette gardé, sans refaire le modèle (ADR-56).
        if (a?.model3d && a.model?.rigTask && !sameAnimations(a.model.animations, a.model3d.animations) && a.status !== "propose") {
          this.#startModel(project, a.id);
          continue;
        }
        if (!a?.model3d || a.model || a.status !== "production" && a.status !== "propose") continue;
        const pending = directives.generate.some((g) => g.asset === a.id) || directives.sketches.some((c) => c.asset === a.id);
        if (a.model3d.simple || (a.verdict?.ok && !pending)) this.#startModel(project, a.id);
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
      this.#kontext()
        ? "Flux Kontext est prêt : « | ref A-xxxx » sur [[CROQUIS]] ou [[GENERER]] dessine dans le style d'un asset validé, et le validateur fait retoucher les essais presque bons au lieu de les refaire."
        : this.#imagegen.state().installed
          ? "Flux Kontext n'est pas installé : « | ref » est ignoré (l'utilisateur peut l'installer depuis l'onglet Visuels)."
          : "",
      this.#missing3d()
        ? `L'atelier 3D n'est pas encore prêt (${this.#missing3d()}) : tu peux déjà marquer les modèles 3D avec [[MODELE3D]], leur 3D attendra.${this.#missing3d(true) ? "" : " Les objets simples (« simple ») peuvent déjà se faire : Blender est là."}`
        : "L'atelier 3D est prêt (Tripo + Blender) : marque chaque modèle 3D avec [[MODELE3D]] ; sa 3D se fabrique dès que son image est retenue, ou tout de suite pour un objet simple.",
      existsSync(join(artRoot(p.root), "bible.md"))
        ? "La bible existe (bible.md) : relis-la avant de proposer."
        : "Il n'y a pas encore de bible : si l'utilisateur n'a rien demandé d'autre, propose de poser la direction ensemble (conception visuelle, étapes 1 à 4).",
      directionContext(readDirection(p.root), { bible: existsSync(join(artRoot(p.root), "bible.md")), generator: this.#imagegen.state().installed }),
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
    const style = readDirection(gameRoot).style?.file ?? null;
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
      if (g.ref) a.styleRef = resolveRef(m.assets, root, g.ref, a.id, style);
      if (a.status === "propose") this.#setStatus(a, "production");
      a.updated_at = now;
      produce.push(a.id);
    }
    const sketched: string[] = [];
    for (const c of d.sketches) {
      const a = m.assets.find((x) => x.id === c.asset);
      if (!a || a.status === "integration" || a.status === "integre") continue;
      // De nouveaux croquis remplacent la direction choisie : on repart du cadrage.
      a.sketches = c.options.map((o) => ({ file: "", label: o.label, prompt: o.prompt }));
      a.direction = null;
      if (c.format) a.format = c.format;
      a.styleRef = c.ref ? resolveRef(m.assets, root, c.ref, a.id, style) : null;
      a.updated_at = now;
      sketched.push(a.id);
    }
    for (const t of d.model3d) {
      const a = m.assets.find((x) => x.id === t.asset);
      if (!a || a.status === "integration" || a.status === "integre") continue;
      a.model3d = t.spec;
      if (t.spec.simple && a.status === "propose") this.#setStatus(a, "production");
      a.updated_at = now;
      done.push(`3D prévue pour ${a.id} (${t.spec.simple ? "objet simple, " : ""}${t.spec.size} m, ${t.spec.tris} triangles${t.spec.animations.length ? `, ${t.spec.animations.join(", ")}` : ""})`);
    }
    if (sketched.length) done.push(this.#imagegen.state().installed ? `croquis demandés pour ${sketched.join(", ")}` : `croquis prêts pour ${sketched.join(", ")} (générateur pas encore installé)`);
    if (produce.length) done.push(this.#imagegen.state().installed ? `génération lancée pour ${produce.join(", ")}` : `prompts prêts pour ${produce.join(", ")} (générateur pas encore installé)`);
    if (d.assets.length || d.midjourney.length || d.generate.length || d.sketches.length || d.model3d.length) writeManifest(gameRoot, m);
    if (d.notes.length) {
      const notes = this.#notes(root);
      for (const n of d.notes) if (safeRel(n.file) && existsSync(join(root, n.file))) notes[n.file] = n.note;
      writeAtomic(join(root, "moodboard", "notes.json"), `${JSON.stringify(notes, null, 2)}\n`);
      done.push(`${d.notes.length} image(s) commentée(s)`);
    }
    return done;
  }

  // ── Croquis du cadrage (ADR-49) ──

  /** Une image par direction proposée, sans validateur : c'est vous qui choisissez. */
  #startSketches(project: string, id: string): void {
    const gens = this.#generating.get(project) ?? new Map<string, Generating>();
    if (gens.has(id)) return;
    gens.set(id, { asset: id, round: 1, rounds: 1, step: "Croquis en attente de la carte graphique" });
    this.#generating.set(project, gens);
    const job = this.#jobStart(project, "sketch", { id }, `${project}/sketch/${id}`);
    this.#track(this.#sketch(project, id).finally(() => (gens.delete(id), this.#jobEnd(job))));
  }

  async #sketch(project: string, id: string): Promise<void> {
    const gameRoot = this.#projects.get(project).root;
    const root = artRoot(gameRoot);
    const progress = this.#generating.get(project)!.get(id)!;
    try {
      let asset = readManifest(gameRoot).assets.find((a) => a.id === id);
      const options = asset?.sketches ?? [];
      if (!asset || !options.length) return;
      const [width, height] = (asset.format ?? "1024x1024").split("x").map(Number) as [number, number];
      const style = this.#styleOf(root, asset);
      const files: string[] = [];
      for (const [k, o] of options.entries()) {
        progress.stage = "croquis";
        progress.step = `Croquis ${k + 1} sur ${options.length}${style ? " (dans le style de la référence)" : ""}`;
        const png = await this.#imagegen.generate({ prompt: style ? styled(o.prompt) : o.prompt, width, height, seed: randomInt(2 ** 31), ...(style ? { edit: { images: [style] } } : {}) });
        const file = this.#free(root, "production", `${id.toLowerCase()}-croquis-${k + 1}`, ".png");
        writeAtomic(join(root, file), png);
        files.push(file);
        progress.preview = { kind: "art", file };
      }
      const m = readManifest(gameRoot);
      asset = m.assets.find((a) => a.id === id);
      if (!asset?.sketches) return;
      asset.sketches = asset.sketches.map((s, k) => ({ ...s, file: files[k] ?? s.file }));
      asset.updated_at = this.#clock.now();
      writeManifest(gameRoot, m);
      await this.#commit(gameRoot, `art: ${files.length} croquis pour ${id}`);
      this.#insert(
        project,
        "art",
        [
          `Voici ${asset.sketches.length} directions pour ${id} « ${asset.name} ». Choisissez celle qui vous parle : je la fabrique et la mène jusqu'au jeu sans vous redemander.`,
          `${CHOICE_MARK}${sketchQuestion(id, asset.name)} || ${[...asset.sketches.map((s, k) => `Croquis ${k + 1} : ${s.label}${s.file ? `${VISUAL_SEP}${s.file}` : ""}`), "Aucun, on en reparle"].join(" || ")}`,
        ].join("\n"),
        null,
      );
    } catch (err) {
      this.#insert(project, "art", `Le générateur n'a pas pu dessiner les croquis de ${id} : ${(err as Error).message.slice(0, 300)}. Redemandez-les-moi.`, null);
    }
  }

  /** Votre croquis : il devient la direction, et la fabrication part sans autre question. */
  async #chooseSketch(project: string, id: string, k: number, recorded: Promise<void> | null = null): Promise<void> {
    await recorded;
    const gameRoot = this.#projects.get(project).root;
    const m = readManifest(gameRoot);
    const asset = m.assets.find((a) => a.id === id);
    const sketch = asset?.sketches?.[k - 1];
    if (!asset || !sketch?.file) return this.#turn(project);
    asset.direction = sketch;
    asset.prompts = [sketch.prompt, ...asset.prompts.filter((p) => p !== sketch.prompt)].slice(0, 6);
    this.#setStatus(asset, "production");
    writeManifest(gameRoot, m);
    await this.#commit(gameRoot, `art: croquis ${k} retenu pour ${id}`);
    this.#journal.append({ project, actor: { kind: "human" }, type: "art.sketch_chosen", subject: id, payload: { sketch: sketch.file } });
    this.#insert(
      project,
      "art",
      `Croquis ${k} « ${sketch.label} » retenu pour ${id}. Je le décline en variantes et le validateur garde la meilleure${asset.model3d ? ", puis la 3D se fait dans l'atelier Blender" : ""}. Vous le reverrez dans le jeu.`,
      null,
    );
    if (this.#imagegen.state().installed) this.#startProduce(project, id);
  }

  // ── Conception visuelle (ADR-58) : questions illustrées, planches de références, duels de styles ──

  /** Une tâche d'exploration en cours, affichée en clair dans la discussion ; retirée à la fin, quoi qu'il arrive. */
  async #explore<T>(project: string, key: string, step: string, fn: (say: (s: string) => void) => Promise<T>): Promise<T> {
    const jobs = this.#exploring.get(project) ?? new Map<string, string>();
    this.#exploring.set(project, jobs);
    jobs.set(key, step);
    try {
      return await fn((s) => jobs.set(key, s));
    } finally {
      jobs.delete(key);
    }
  }

  /**
   * Les options « libellé @@ visuel » : une image de studio/art est gardée telle quelle, un prompt est dessiné en vignette
   * (générateur local) dans choix/ ; sans générateur, ou si le dessin échoue, l'option reste en mots.
   */
  async #illustrate(project: string, text: string): Promise<string> {
    if (!text.includes(VISUAL_SEP)) return text;
    const root = this.#root(project);
    const lines = text.split("\n");
    const todo: { line: number; option: number; prompt: string }[] = [];
    const parsed = lines.map((l, i) => {
      if (!l.startsWith(CHOICE_MARK)) return null;
      const [q, ...options] = l.slice(CHOICE_MARK.length).split(" || ");
      const opts = options.map((o, k) => {
        const [label, visual = ""] = o.split(VISUAL_SEP);
        const v = visual.trim();
        if (!v) return { label: label!, file: null as string | null };
        if (safeRel(v) && IMAGE_MIME[extname(v).toLowerCase()]) return { label: label!, file: existsSync(join(root, v)) ? v : null };
        todo.push({ line: i, option: k, prompt: v });
        return { label: label!, file: null };
      });
      return { q: q!, opts };
    });
    const draw = this.#imagegen.state().installed ? todo.slice(0, MAX_VIGNETTES) : [];
    if (draw.length)
      await this.#explore(project, "vignettes", "Le Directeur artistique dessine les vignettes de ses questions", async (say) => {
        const seq = (this.#db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM art_messages WHERE project = ?").get(project) as { next: number }).next;
        for (const [n, t] of draw.entries()) {
          say(`Vignettes des questions : ${n + 1} sur ${draw.length}`);
          try {
            const png = await this.#imagegen.generate({ prompt: t.prompt, width: 512, height: 512, seed: randomInt(2 ** 31) });
            const file = this.#free(root, "choix", `m${seq}-${n + 1}`, ".png");
            writeAtomic(join(root, file), png);
            parsed[t.line]!.opts[t.option]!.file = file;
          } catch {
            /* vignette manquée : l'option reste en mots */
          }
        }
      });
    return lines
      .map((l, i) => {
        const p = parsed[i];
        return p ? `${CHOICE_MARK}${p.q} || ${p.opts.map((o) => (o.file ? `${o.label}${VISUAL_SEP}${o.file}` : o.label)).join(" || ")}` : l;
      })
      .join("\n");
  }

  #startBoard(project: string, b: ArtDirectives["references"][number]): void {
    const job = this.#jobStart(project, "board", b);
    this.#track(this.#explore(project, `planche-${randomUUID()}`, `Planche « ${b.theme} » : recherche des images`, (say) => this.#board(project, b, say)).finally(() => this.#jobEnd(job)));
  }

  /**
   * Une planche de références (ADR-58) : chaque adresse donnée par le Directeur artistique est téléchargée (image, ou
   * image d'aperçu de la page) dans moodboard/, avec sa source et ce qu'il veut en prendre ; vous dites ensuite, image
   * par image, ce que vous aimez ou voulez éviter.
   */
  async #board(project: string, b: ArtDirectives["references"][number], say: (s: string) => void): Promise<void> {
    const gameRoot = this.#projects.get(project).root;
    const root = artRoot(gameRoot);
    const got: { file: string; url: string; title: string; why: string }[] = [];
    const failed: { url: string; reason: string }[] = [];
    const known = new Set(readDirection(gameRoot).references.map((r) => r.source));
    for (const [k, item] of b.items.entries()) {
      say(`Planche « ${b.theme} » : image ${k + 1} sur ${b.items.length}`);
      if (known.has(item.url)) {
        failed.push({ url: item.url, reason: "déjà dans le moodboard" });
        continue;
      }
      try {
        const img = await this.#webRefs.fetchImage(item.url);
        const kind = IMAGE_TYPES[img.mime];
        if (!kind?.magic(img.data)) throw new Error("ce n'est pas une image PNG, JPEG ou WebP");
        const base = `web-${slugName(item.title || new URL(item.url).hostname)}`;
        const file = this.#free(root, "moodboard", base, kind.ext);
        writeAtomic(join(root, file), img.data);
        got.push({ file, url: item.url, title: item.title, why: item.why });
      } catch (err) {
        failed.push({ url: item.url, reason: (err as Error).message.slice(0, 160) });
      }
    }
    const d = readDirection(gameRoot);
    const id = nextId("P", d.boards);
    const now = this.#clock.now();
    d.boards.push({ id, theme: b.theme, at: now, failed });
    d.references.push(...got.map((g) => ({ file: g.file, board: id, theme: b.theme, source: g.url, title: g.title, why: g.why, verdict: null, at: now })));
    writeDirection(gameRoot, d);
    await this.#commit(gameRoot, `art: planche ${id} « ${b.theme} » (${got.length} références)`);
    this.#journal.append({ project, actor: { kind: "agent", role: "art_director", run: this.#orchestrator.name }, type: "art.board_added", subject: id, payload: { images: got.length, failed: failed.length } });
    this.#insert(
      project,
      "art",
      got.length
        ? [
            `**Planche ${id} « ${b.theme} »** : ${got.length} référence(s). Pour chacune, dites si vous aimez ou si vous voulez l'éviter, puis « Envoyer mon avis ». Ce sont des inspirations, pas des images pour le jeu.`,
            `${BOARD_MARK}${id}`,
            failed.length ? `(${failed.length} adresse(s) non récupérée(s) : ${failed.map((f) => f.reason).join(" ; ")})` : "",
          ]
            .filter(Boolean)
            .join("\n")
        : `Je n'ai pu récupérer aucune image pour la planche « ${b.theme} » (${failed.map((f) => f.reason).join(" ; ")}). Demandez-moi d'autres références.`,
      null,
    );
  }

  #startDuel(project: string, s: ArtDirectives["styles"][number]): void {
    if (!this.#imagegen.state().installed) {
      this.#insert(project, "art", `Le duel de styles « ${s.subject} » attend le générateur d'images local (onglet Visuels, « Installer le générateur »). En attendant, je peux vous montrer des références.`, null);
      return;
    }
    const job = this.#jobStart(project, "duel", s);
    this.#track(this.#explore(project, `duel-${randomUUID()}`, `Duel de styles « ${s.subject} » : en attente de la carte graphique`, (say) => this.#duel(project, s, say)).finally(() => this.#jobEnd(job)));
  }

  /** Un duel de styles (ADR-58) : un même sujet dessiné dans chaque style, que vous départagez d'un clic. */
  async #duel(project: string, s: ArtDirectives["styles"][number], say: (s: string) => void): Promise<void> {
    const gameRoot = this.#projects.get(project).root;
    const root = artRoot(gameRoot);
    const id = nextId("S", readDirection(gameRoot).duels);
    const [width, height] = (s.format ?? "1024x1024").split("x").map(Number) as [number, number];
    // Une même graine pour tous les styles : la composition se ressemble, seul le style change.
    const seed = randomInt(2 ** 31);
    const options: { label: string; prompt: string; file: string }[] = [];
    try {
      for (const [k, o] of s.options.entries()) {
        say(`Duel de styles « ${s.subject} » : style ${k + 1} sur ${s.options.length}`);
        const png = await this.#imagegen.generate({ prompt: o.prompt, width, height, seed });
        const file = this.#free(root, "styles", `${id.toLowerCase()}-${k + 1}`, ".png");
        writeAtomic(join(root, file), png);
        options.push({ ...o, file });
      }
    } catch (err) {
      this.#insert(project, "art", `Le générateur n'a pas pu dessiner le duel de styles « ${s.subject} » : ${(err as Error).message.slice(0, 300)}. Redemandez-le-moi.`, null);
      return;
    }
    const d = readDirection(gameRoot);
    d.duels.push({ id, subject: s.subject, options, chosen: null, at: this.#clock.now() });
    writeDirection(gameRoot, d);
    await this.#commit(gameRoot, `art: duel de styles ${id} « ${s.subject} »`);
    this.#journal.append({ project, actor: { kind: "agent", role: "art_director", run: this.#orchestrator.name }, type: "art.duel_added", subject: id, payload: { styles: options.length } });
    this.#insert(
      project,
      "art",
      [
        `**Duel de styles ${id}** : le même sujet, « ${s.subject} », dans ${options.length} styles. Choisissez celui qui ressemble à votre jeu : il deviendra la référence de style de tous les visuels.`,
        `${CHOICE_MARK}${styleQuestion(id, s.subject)} || ${[...options.map((o, k) => `Style ${k + 1} : ${o.label}${VISUAL_SEP}${o.file}`), "Aucun, d'autres pistes"].join(" || ")}`,
      ].join("\n"),
      null,
    );
  }

  /** Le style choisi au duel devient le style du jeu (référence « | ref style ») ; le choix est gardé. */
  async #chooseStyle(project: string, id: string, k: number, recorded: Promise<void> | null): Promise<void> {
    await recorded;
    const gameRoot = this.#projects.get(project).root;
    const d = readDirection(gameRoot);
    const duel = d.duels.find((x) => x.id === id);
    const o = duel?.options[k - 1];
    if (!duel || !o) return;
    duel.chosen = k;
    d.style = { duel: id, label: o.label, prompt: o.prompt, file: o.file, at: this.#clock.now() };
    writeDirection(gameRoot, d);
    await this.#commit(gameRoot, `art: style « ${o.label} » retenu (duel ${id})`);
    this.#journal.append({ project, actor: { kind: "human" }, type: "art.style_chosen", subject: id, payload: { style: o.file } });
  }

  // ── Générateur local (ADR-46, ADR-49) ──

  #startProduce(project: string, id: string): void {
    const gens = this.#generating.get(project) ?? new Map<string, Generating>();
    if (gens.has(id)) return;
    gens.set(id, { asset: id, round: 1, rounds: ROUNDS, step: "En attente de la carte graphique" });
    this.#generating.set(project, gens);
    const job = this.#jobStart(project, "produce", { id }, `${project}/produce/${id}`);
    this.#track(
      this.#produce(project, id)
        .finally(() => (gens.delete(id), this.#jobEnd(job)))
        .then((next) => {
          if (next === "model") this.#startModel(project, id);
          if (next === "integrate") return this.#autoIntegrate(project, id, "system");
        }),
    );
  }

  /**
   * Deux tours au plus : trois essais (le croquis choisi et ses variantes, ou trois images neuves sans croquis), le
   * validateur choisit le meilleur ; s'il refuse, nouveau tour avec son prompt corrigé. Au dernier tour, un essai
   * « utilisable » est gardé : ses défauts se corrigent ensuite (dans Blender pour la 3D).
   */
  async #produce(project: string, id: string): Promise<"model" | "integrate" | null> {
    const gameRoot = this.#projects.get(project).root;
    const root = artRoot(gameRoot);
    const progress = this.#generating.get(project)!.get(id)!;
    // Le meilleur essai du tour précédent et la retouche que le validateur propose (Flux Kontext, ADR-51).
    let retouch: { file: string; edit: string } | null = null;
    try {
      for (let round = 1; round <= ROUNDS; round++) {
        progress.round = round;
        let asset = readManifest(gameRoot).assets.find((a) => a.id === id);
        if (!asset?.prompts[0]) return null;
        const prompt = asset.prompts[0];
        const [width, height] = (asset.format ?? "1024x1024").split("x").map(Number) as [number, number];
        const direction = asset.direction?.file && existsSync(join(root, asset.direction.file)) ? asset.direction : null;
        const init = direction ? readFileSync(join(root, direction.file)) : null;
        const style = this.#styleOf(root, asset);
        const fix = retouch && this.#kontext() && existsSync(join(root, retouch.file)) ? { image: readFileSync(join(root, retouch.file)), edit: retouch.edit } : null;
        const files: string[] = [];
        // Au premier tour, le croquis choisi est lui-même un candidat.
        if (direction && round === 1) files.push(direction.file);
        for (let v = files.length + 1; v <= VARIANTS; v++) {
          // Retouche du meilleur essai, variante du croquis choisi, dessin dans le style de la référence, ou essai neuf.
          const req = fix
            ? { prompt: fix.edit, edit: { images: [fix.image] } }
            : init
              ? { prompt, init: { image: init, denoise: round === 1 ? 0.5 : 0.75 } }
              : style
                ? { prompt: styled(prompt), edit: { images: [style] } }
                : { prompt };
          progress.stage = "image";
          progress.step = fix ? `Retouche ${v} sur ${VARIANTS} du meilleur essai` : direction ? `Variante ${v} sur ${VARIANTS} du croquis choisi` : `Essai ${v} sur ${VARIANTS}`;
          const png = await this.#imagegen.generate({ width, height, seed: randomInt(2 ** 31), ...req });
          const file = this.#free(root, "production", `${id.toLowerCase()}-t${round}-e${v}`, ".png");
          writeAtomic(join(root, file), png);
          files.push(file);
          progress.preview = { kind: "art", file };
        }
        let m = readManifest(gameRoot);
        asset = m.assets.find((a) => a.id === id);
        if (!asset) return null;
        const known = new Set(asset.renders);
        asset.renders.push(...files.filter((f) => !known.has(f)));
        this.#setStatus(asset, "a_valider");
        writeManifest(gameRoot, m);
        await this.#commit(gameRoot, `art: ${files.length} essais pour ${id} (tour ${round})`);

        progress.step = "Le validateur compare les essais";
        const v = await this.#pick(project, asset, files, prompt);
        m = readManifest(gameRoot);
        asset = m.assets.find((a) => a.id === id);
        if (!asset) return null;
        const to3d = !!asset.model3d;
        const best = files[Math.min(files.length, Math.max(1, v.best)) - 1]!;
        // Dernier tour : un essai utilisable est gardé plutôt que de vous laisser trancher sur des détails.
        const kept = !v.ok && v.usable && round === ROUNDS;
        const ok = v.ok || kept;
        // Le meilleur essai passe en dernier : c'est lui que la fiche montre.
        asset.renders = [...asset.renders.filter((r) => r !== best), best];
        asset.verdict = { ok, summary: v.summary, points: v.points, prompt: v.prompt, file: best, by: "validator", at: this.#clock.now() };
        this.#setStatus(asset, ok && !to3d ? "valide" : "production");
        if (!ok && v.prompt) asset.prompts = [v.prompt, ...asset.prompts.filter((p) => p !== v.prompt)].slice(0, 6);
        retouch = !ok && v.edit && this.#kontext() ? { file: best, edit: v.edit } : null;
        writeManifest(gameRoot, m);
        await this.#commit(gameRoot, `art: ${id} ${ok ? (to3d ? "image de référence retenue" : "validé") : "à retoucher"} (validateur, tour ${round})`);
        this.#journal.append({ project, actor: { kind: "agent", role: "art_director", run: this.#orchestrator.name }, type: ok ? "art.asset_validated" : "art.asset_rejected", subject: id, payload: { by: "validator", round, kept } });
        this.#insert(
          project,
          "art",
          [
            ...files.map((f) => `${IMAGE_MARK}${f}`),
            v.ok
              ? `**${id} « ${asset.name} » : conforme** (essai ${files.indexOf(best) + 1}, tour ${round}). ${v.summary}`
              : kept
                ? `**${id} « ${asset.name} » : essai ${files.indexOf(best) + 1} retenu** (tour ${round} sur ${ROUNDS}), avec des défauts ${to3d ? "que l'atelier Blender corrigera" : "mineurs"}. ${v.summary}`
                : `**${id} « ${asset.name} » : pas encore** (tour ${round} sur ${ROUNDS}). ${v.summary}`,
            ...v.points.map((p) => `- ${p}`),
            ok
              ? to3d
                ? "Il part à l'atelier 3D."
                : "Je le fais intégrer dans le jeu."
              : round === ROUNDS
                ? "Aucun essai utilisable : le meilleur est sur la fiche. « Valider quand même », « Refaire », ou dites-moi ce qui cloche et je repars de nouveaux croquis."
                : retouch
                  ? `Je fais retoucher l'essai ${files.indexOf(best) + 1} par Kontext : « ${retouch.edit} »`
                  : "Je relance un tour avec un prompt corrigé.",
          ].join("\n"),
          null,
        );
        if (ok) return to3d ? "model" : "integrate";
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

  /** Flux Kontext est installé (ADR-51). */
  #kontext(): boolean {
    const s = this.#imagegen.state();
    return s.installed && !!s.kontext?.installed;
  }

  /** L'image de la référence de style de l'asset, si Kontext peut s'en servir. */
  #styleOf(root: string, asset: Asset): Buffer | null {
    return asset.styleRef && this.#kontext() && existsSync(join(root, asset.styleRef)) ? readFileSync(join(root, asset.styleRef)) : null;
  }

  // ── Atelier 3D (ADR-47, ADR-49) ──

  /** Ce qui manque à l'atelier 3D, en clair, ou null s'il est prêt. Un objet simple n'a pas besoin de Tripo. */
  #missing3d(simple = false): string | null {
    const s = this.#model3d.state();
    const missing = [s.blender.installed ? "" : "installez Blender", s.tripo.configured || simple ? "" : "ajoutez votre clé Tripo"].filter(Boolean);
    return missing.length ? missing.join(" et ").replace(/^./, (c) => c.toUpperCase()) : null;
  }

  #startModel(project: string, id: string, retouch = false): void {
    const simple = !!readManifest(this.#projects.get(project).root).assets.find((a) => a.id === id)?.model3d?.simple;
    const missing = this.#missing3d(simple || retouch);
    if (missing) {
      this.#insert(project, "art", `La 3D de ${id} attend l'atelier 3D : ${missing.toLowerCase()} (onglet Visuels). Elle partira d'un clic sur « Fabriquer la 3D ».`, null);
      return;
    }
    const gens = this.#generating.get(project) ?? new Map<string, Generating>();
    if (gens.has(id)) return;
    gens.set(id, { asset: id, round: 1, rounds: MODEL_ROUNDS, step: retouch ? "Reprise de la scène de l'atelier" : "Préparation de la 3D" });
    this.#generating.set(project, gens);
    const job = this.#jobStart(project, "model", { id }, `${project}/model/${id}`);
    this.#track(
      this.#produceModel(project, id, retouch)
        .finally(() => (gens.delete(id), this.#jobEnd(job)))
        .then((ok) => (ok ? this.#autoIntegrate(project, id, "system") : undefined)),
    );
  }

  /**
   * Tripo fabrique le modèle une seule fois (rien pour un objet simple) ; Blender prépare la scène ; l'artisan 3D la
   * retouche pas à pas en regardant ses photos ; le hub exporte, le validateur juge. Si la forme est bonne mais pas la
   * finition, l'artisan reprend la même scène avec les remarques du validateur, sans repayer Tripo. `retouch` (ADR-55) :
   * un modèle déjà fabriqué reprend sa scène d'atelier telle qu'elle est, avec les dernières remarques du validateur.
   */
  async #produceModel(project: string, id: string, retouch = false): Promise<boolean> {
    const gameRoot = this.#projects.get(project).root;
    const root = artRoot(gameRoot);
    const progress = this.#generating.get(project)!.get(id)!;
    const dir = this.#model3d.atelier(`${project}-${id}`);
    const raws: string[] = [];
    try {
      const asset = readManifest(gameRoot).assets.find((a) => a.id === id);
      if (!asset?.model3d) return false;
      const spec = asset.model3d;
      const source = spec.simple ? null : asset.verdict?.ok ? asset.verdict.file : null;
      if (!spec.simple && !source) return false;
      let credits = 0;
      let animations: string[] = [];
      let rigType: string | null = null;
      let rigTask: string | null = null;
      // La planche jugée (ADR-50) : ses fichiers dans production/, la dernière version gardée.
      const planche: string[] = [];
      const previous = retouch ? asset.model : null;
      if (previous) {
        animations = previous.animations;
        rigType = previous.rigType ?? null;
        rigTask = previous.rigTask ?? null;
        planche.push(...(previous.views ?? []).filter((f) => existsSync(join(root, f))));
        // Le modèle déjà branché dans le jeu sera remplacé par la version retouchée.
        if (asset.status === "integration" || asset.status === "integre") this.#replacing.add(`${project}/${id}`);
      }
      // Des animations changées (ADR-56) : Tripo pose les nouvelles sur le squelette gardé (10 crédits chacune), Blender les
      // range dans la scène gardée. Si Tripo a oublié le squelette (ses tâches expirent), le modèle est refait en entier.
      const kept = !retouch && source && asset.model?.rigTask && asset.model.source === source && existsSync(join(dir, "scene.blend")) ? asset.model : null;
      let onlyAnimations = false;
      if (kept) {
        try {
          const want = rigAnimations(kept.rigType ?? "biped", spec.animations);
          const keep = want.map(shortName);
          const add = want.filter((w) => !kept.animations.includes(shortName(w)));
          progress.stage = "tripo";
          const extra = add.length ? await this.#model3d.animate({ rigTask: kept.rigTask!, names: add, step: (s) => (progress.step = s) }) : { glbs: [], credits: 0 };
          credits = extra.credits;
          mkdirSync(join(dir, ".."), { recursive: true });
          const files = extra.glbs.map((b, i) => {
            const f = `${dir}-anim-${i + 1}.glb`;
            writeAtomic(f, b);
            raws.push(f);
            return f;
          });
          progress.stage = "atelier";
          progress.step = "Blender range les animations dans la scène gardée";
          await this.#model3d.addAnimations({ dir, extras: files, animations: add.map(shortName), keep });
          animations = keep;
          rigType = kept.rigType ?? null;
          rigTask = kept.rigTask ?? null;
          planche.push(...(kept.views ?? []).filter((f) => existsSync(join(root, f))));
          onlyAnimations = true;
          if (asset.status === "integration" || asset.status === "integre") this.#replacing.add(`${project}/${id}`);
        } catch (err) {
          progress.step = `Le squelette Tripo n'est plus disponible (${(err as Error).message.slice(0, 120)}) : le modèle est refait`;
          planche.length = 0;
        }
      }
      if (source && !previous && !onlyAnimations) {
        const t = await this.#model3d.tripo({
          image: readFileSync(join(root, source)),
          ext: extname(source).slice(1).toLowerCase().replace("jpeg", "jpg"),
          spec,
          seed: randomInt(2 ** 31),
          step: (s) => {
            progress.stage = /planche/i.test(s) ? "planche" : "tripo";
            progress.step = s;
          },
          views: (views, round) => {
            progress.stage = "planche";
            progress.step = round === 1 ? "Le validateur regarde la planche" : "Le validateur regarde la planche retouchée";
            return this.#reviewViews(project, asset, source, views, round, planche);
          },
        });
        if (!t.views) planche.length = 0;
        credits = t.credits;
        animations = t.animations ?? [];
        rigType = t.rigType ?? null;
        rigTask = t.rigTask ?? null;
        mkdirSync(join(dir, ".."), { recursive: true });
        for (const [i, b] of [t.glb, ...(t.extras ?? [])].entries()) {
          const f = `${dir}-brut${i ? `-${i + 1}` : ""}.glb`;
          writeAtomic(f, b);
          raws.push(f);
        }
      }
      const move = (a: string) => a.split(":").pop();
      const missingAnimations = spec.animations.filter((w) => !animations.some((a) => move(a) === move(w) || (move(w) === "walk" && move(a) === "march")));
      progress.stage = "atelier";
      if (!previous && !onlyAnimations) {
        progress.step = "Blender prépare la scène de l'atelier";
        await this.#model3d.prepare({ dir, input: raws[0] ?? null, extras: raws.slice(1), animations, spec, palette: paletteOf(asset) });
      }
      // Ce que l'artisan lit : la fiche, la bible et l'image de référence, copiées dans son dossier.
      writeAtomic(join(dir, "fiche.json"), JSON.stringify({ id: asset.id, name: asset.name, type: asset.type, usage: asset.usage, specs: asset.specs, model3d: spec }, null, 2));
      if (existsSync(join(root, "bible.md"))) copyFileSync(join(root, "bible.md"), join(dir, "bible.md"));
      const reference = source ? `reference${extname(source).toLowerCase()}` : null;
      if (source && reference) copyFileSync(join(root, source), join(dir, reference));
      const sheet = planche.map((f, k) => {
        const name = `vue-${VIEW_FR[k]}${extname(f)}`;
        copyFileSync(join(root, f), join(dir, name));
        return name;
      });

      // Les dernières remarques du validateur suivent la scène gardée (finition reprise, ou animations changées).
      const base = previous ?? (onlyAnimations ? kept : null);
      let remarks: string[] = base?.verdict ? (base.verdict.points.length ? base.verdict.points : [base.verdict.summary]) : [];
      for (let pass = 1; pass <= MODEL_ROUNDS; pass++) {
        progress.round = pass;
        const workshop = await this.#artisan(project, asset, dir, reference, sheet, remarks, progress);
        progress.stage = "controle";
        progress.note = null;
        progress.step = "Blender exporte le modèle aux mesures du jeu";
        const file = this.#free(root, "models", `${id.toLowerCase()}-3d`, ".glb");
        const prefix = file.slice("models/".length, -".glb".length);
        mkdirSync(join(root, "production"), { recursive: true });
        const done = await this.#model3d.export({ dir, output: join(root, file), rendersDir: join(root, "production"), prefix, spec });
        const renders = done.renders.map((r) => relative(root, r).replace(/\\/g, "/"));
        let m = readManifest(gameRoot);
        let a = m.assets.find((x) => x.id === id);
        if (!a) return false;
        const bandes = done.bandes.map((r) => relative(root, r).replace(/\\/g, "/"));
        a.model = { file, source, ...(planche.length ? { views: [...planche] } : {}), renders, bandes, tris: done.tris, dims: done.dims, animations: done.animations, workshop, rigType, rigTask, missingAnimations, verdict: null };
        this.#setStatus(a, "a_valider");
        writeManifest(gameRoot, m);
        await this.#commit(gameRoot, `art: modèle 3D de ${id} (atelier, passe ${pass}${credits && pass === 1 ? `, ${credits} crédits Tripo` : ""})`);

        progress.step = "Le validateur regarde le modèle sous tous les angles";
        progress.preview = { kind: "art", file: renders[1] ?? renders[0]! };
        const look = await this.#judgeModel(project, a, source, planche, renders, done, spec);
        // Les mouvements, jugés à part sur leurs bandes (ADR-56) : sens, durée, allure.
        const motion = bandes.length ? await this.#judgeAnimations(project, a, bandes, done) : null;
        const v = {
          ok: look.ok && (motion?.ok ?? true),
          forme_ok: look.forme_ok,
          mineur: !(look.ok && (motion?.ok ?? true)) && (look.ok || look.mineur) && (!motion || motion.ok || motion.mineur),
          summary: motion && !motion.ok ? `${look.summary} ${motion.summary}`.slice(0, 600) : look.summary,
          points: [...look.points, ...(motion?.points ?? [])],
        };
        m = readManifest(gameRoot);
        a = m.assets.find((x) => x.id === id);
        if (!a?.model) return false;
        // De petites retouches qui résistent à la dernière passe n'empêchent pas un modèle jouable d'entrer dans le jeu (ADR-55).
        const ok = v.ok || (v.mineur && pass === MODEL_ROUNDS);
        a.model.verdict = { ok, summary: v.summary, points: v.points, prompt: null, file, by: "validator", at: this.#clock.now() };
        this.#setStatus(a, ok ? "valide" : "production");
        writeManifest(gameRoot, m);
        await this.#commit(gameRoot, `art: modèle 3D de ${id} ${ok ? "validé" : "à retoucher"} (validateur, passe ${pass})`);
        this.#journal.append({ project, actor: { kind: "agent", role: "art_director", run: this.#orchestrator.name }, type: ok ? "art.model_validated" : "art.model_rejected", subject: id, payload: { pass, credits } });
        // Une animation au sens faux ne se corrige pas dans Blender : on s'arrête et on dit laquelle remplacer.
        const swap = !!motion?.remplacements.length;
        const retry = !ok && v.forme_ok && !swap && pass < MODEL_ROUNDS;
        this.#insert(
          project,
          "art",
          [
            ...renders.map((r) => `${IMAGE_MARK}${r}`),
            ...bandes.map((r) => `${IMAGE_MARK}${r}`),
            v.ok
              ? `**${id} « ${a.name} » en 3D : conforme** (passe ${pass}). ${v.summary}`
              : ok
                ? `**${id} « ${a.name} » en 3D : jouable** (passe ${pass}), quelques retouches mineures restent. ${v.summary}`
                : `**${id} « ${a.name} » en 3D : pas encore** (passe ${pass} sur ${MODEL_ROUNDS}). ${v.summary}`,
            ...v.points.map((p) => `- ${p}`),
            workshop ? `Dans Blender : ${workshop}` : "",
            `${done.dims.map((d) => `${d} m`).join(" × ")}, ${done.tris} triangles${done.animations.length ? `, animations : ${done.animations.join(", ")}` : ""}${credits && pass === 1 ? ` · ${credits} crédits Tripo` : ""}.`,
            pass === 1 && missingAnimations.length
              ? `Tripo a reconnu ce modèle comme « ${rigType ?? "inconnu"} » : ${missingAnimations.join(", ")} n'existe pas pour cette forme, donc absente du modèle.`
              : "",
            ...(motion?.remplacements ?? []).map(
              (r) => `Animation « ${r.animation} » : ${r.pourquoi} Pour la remplacer, dites au Directeur artistique « remplace ${r.animation} par ${r.par} » : 10 crédits Tripo, sans refaire le modèle.`,
            ),
            ok
              ? "Je le fais intégrer dans le jeu."
              : retry
                ? "La forme est bonne : l'artisan reprend la finition avec ces remarques, sans repayer Tripo."
                : swap
                  ? "Le reste attend la bonne animation : dites-le au Directeur artistique (ci-dessus), et le modèle sera refait pour 10 crédits Tripo par animation."
                  : v.forme_ok
                    ? "La finition résiste : « Valider quand même », ou dites-moi ce qui cloche."
                  : "La forme elle-même ne va pas (elle vient de l'image ou de Tripo) : « Refaire la 3D » relance Tripo, ou dites-moi ce qui cloche et je repars de nouveaux croquis.",
          ]
            .filter(Boolean)
            .join("\n"),
          null,
        );
        if (ok) return true;
        if (!retry) return false;
        remarks = v.points.length ? v.points : [v.summary];
      }
    } catch (err) {
      this.#insert(project, "art", `L'atelier 3D n'a pas pu fabriquer ${id} : ${(err as Error).message.slice(0, 300)}. Vous pouvez relancer depuis sa fiche (« Fabriquer la 3D »).`, null);
      const m = readManifest(gameRoot);
      const a = m.assets.find((x) => x.id === id);
      if (a?.status === "a_valider") {
        this.#setStatus(a, "production");
        writeManifest(gameRoot, m);
      }
    } finally {
      for (const f of raws) rmSync(f, { force: true });
    }
    return false;
  }

  /**
   * La planche de Tripo (ADR-50) : rangée dans production/, jugée par le validateur, montrée dans la discussion. Au premier
   * passage, les retouches demandées repartent chez Tripo ; au second (planche retouchée), le jugement est seulement dit.
   */
  async #reviewViews(project: string, asset: Asset, source: string, views: ViewImage[], round: number, saved: string[]): Promise<ViewEdit[]> {
    const gameRoot = this.#projects.get(project).root;
    const root = artRoot(gameRoot);
    const files = views.map((v, k) => {
      const file = this.#free(root, "production", `${asset.id.toLowerCase()}-planche-${VIEW_FR[k]}`, imageExt(v.image));
      writeAtomic(join(root, file), v.image);
      return file;
    });
    saved.splice(0, saved.length, ...files);
    const progress = this.#generating.get(project)?.get(asset.id);
    if (progress) progress.preview = { kind: "art", file: files[0]! };
    await this.#commit(gameRoot, `art: planche de ${asset.id}${round > 1 ? " retouchée" : ""}`);
    const busy = this.#validating.get(project) ?? new Set<string>();
    busy.add(asset.id);
    this.#validating.set(project, busy);
    try {
      const { data } = await this.#orchestrator.structured({
        systemPrompt: VIEWS_SYSTEM,
        prompt: [
          `Planche de l'asset ${asset.id} « ${asset.name} » (${asset.type}). Usage : ${asset.usage}. Spécifications : ${asset.specs || "aucune"}.`,
          `Image de référence : ${source}`,
          ...views.map((v, k) => `Vue ${VIEW_FR[k]} (${v.view}) : ${files[k]}`),
          round > 1 ? "C'est la planche déjà retouchée : juge-la, sans nouvelle retouche." : "",
        ]
          .filter(Boolean)
          .join("\n"),
        jsonSchema: VIEWS_SCHEMA,
        readDir: root,
        role: "art",
        meta: { project, agent: "art_director" },
      });
      const v = data as { ok: boolean; summary: string; points: string[]; edits: ViewEdit[] };
      const edits = round === 1 && !v.ok ? (v.edits ?? []).filter((e) => VIEW_EN.includes(e.view) && e.prompt?.trim()).slice(0, 4) : [];
      this.#insert(
        project,
        "art",
        [
          ...files.map((f) => `${IMAGE_MARK}${f}`),
          `**Planche de ${asset.id} « ${asset.name} »${round > 1 ? " retouchée" : ""} : ${v.ok ? "cohérente" : edits.length ? "à retoucher" : "imparfaite"}.** ${String(v.summary ?? "").slice(0, 400)}`,
          ...(v.points ?? []).slice(0, 6).map((p) => `- ${p}`),
          edits.length
            ? `Je fais retoucher par Tripo : ${edits.map((e) => `vue ${VIEW_FR[VIEW_EN.indexOf(e.view)]}`).join(", ")}.`
            : "La 3D est construite à partir de ces quatre vues ; l'atelier Blender corrigera le reste.",
        ].join("\n"),
        null,
      );
      return edits;
    } finally {
      busy.delete(asset.id);
    }
  }

  /** L'artisan 3D, pas à pas : il regarde, écrit un peu de Python, le hub l'exécute et lui rend sortie, mesures et photos. */
  async #artisan(project: string, asset: Asset, dir: string, reference: string | null, sheet: string[], remarks: string[], progress: Generating): Promise<string> {
    const journal: string[] = [];
    const spec = asset.model3d!;
    const steps = spec.simple ? WORKSHOP_STEPS : TRIPO_STEPS;
    progress.stage = "atelier";
    progress.step = "L'artisan 3D regarde le modèle";
    let shots = await this.#model3d.photos({ dir, prefix: "photo-0" });
    // La capture montrée dans l'onglet Visuels : la photo de trois-quarts la plus récente.
    const show = () => {
      const p = shots.photos.find((f) => /trois-quarts/.test(f)) ?? shots.photos[0];
      if (p) progress.preview = { kind: "atelier", file: basename(p) };
    };
    show();
    let lost = 0;
    for (let step = 1; step <= steps; step++) {
      progress.step = `L'artisan 3D ${spec.simple ? "modélise" : "range le modèle"} dans Blender (pas ${step} sur ${steps})`;
      let data: unknown;
      try {
        ({ data } = await this.#orchestrator.structured({
          systemPrompt: WORKSHOP_SYSTEM,
          prompt: [
            `Asset ${asset.id} « ${asset.name} » (${asset.type}). Usage : ${asset.usage}`,
            `Spécifications : ${asset.specs || "aucune"}`,
            `Palette de la fiche (variable palette) : ${paletteOf(asset).join(", ") || "aucune : lis la bible"}`,
            `3D demandée : ${spec.size} m (plus grande dimension), ${spec.tris} triangles au plus${spec.simple ? ", objet SIMPLE : la scène est vide, modélise-le" : ", modèle de TRIPO : garde sa forme et sa texture, range-le seulement"}.`,
            reference ? `Image de référence : ${reference}` : "Pas d'image de référence : suis la fiche et la bible.",
            sheet.length ? `Planche (ce que le modèle doit montrer sous chaque angle) : ${sheet.join(", ")}` : "",
            remarks.length ? `Le validateur demande ces corrections :\n${remarks.map((r) => `- ${r}`).join("\n")}` : "",
            journal.length ? `Tes pas précédents :\n${journal.slice(-6).join("\n\n")}` : "",
            lost ? "Ton pas précédent n'a pas abouti (trop long) : fais un pas plus petit et ne relis que les photos utiles." : "",
            `Photos actuelles (à regarder avec Read) : ${shots.photos.map((p) => basename(p)).join(", ")}`,
            `Mesures actuelles : ${JSON.stringify(shots.mesures).slice(0, 3000)}`,
            `Pas ${step} sur ${steps}.`,
          ]
            .filter(Boolean)
            .join("\n\n"),
          jsonSchema: WORKSHOP_STEP_SCHEMA,
          readDir: dir,
          // Son propre modèle, réglable à part (ADR-52) : Fable par défaut.
          role: "artisan",
          meta: { project, agent: "art_director" },
        }));
      } catch (err) {
        // Un pas perdu ne perd pas la scène, enregistrée après chaque code. Au second échec de suite, on exporte ce qui est
        // fait et le validateur juge.
        const why = (err as Error).message.slice(0, 120);
        if (++lost >= 2) return `Interrompu au pas ${step} (${why}) ; la scène est exportée telle quelle.`;
        journal.push(`Pas ${step} : sans réponse (${why}).`);
        continue;
      }
      lost = 0;
      const s = data as { note: string; code: string | null; photos: boolean; fini: boolean; summary: string };
      progress.note = String(s.note ?? "").slice(0, 400) || null;
      let line = `Pas ${step} : ${String(s.note ?? "").slice(0, 400)}`;
      if (s.code?.trim()) {
        const r = await this.#model3d.runCode({ dir, code: s.code });
        line += `\nCode :\n${s.code.slice(0, 3000)}\n→ ${r.ok ? "réussi" : "ERREUR"}${r.sortie ? `\nSortie :\n${r.sortie.slice(-1500)}` : ""}${r.erreur ? `\nErreur :\n${r.erreur.slice(-1500)}` : ""}`;
      }
      journal.push(line);
      if (s.fini) return String(s.summary || s.note || "").slice(0, 400);
      if (s.code?.trim() || s.photos) {
        shots = await this.#model3d.photos({ dir, prefix: `photo-${step}` });
        show();
      }
    }
    return `Arrêté au bout de ${steps} pas.`;
  }

  /** Le validateur devant les bandes d'animation (ADR-56) : le sens du mouvement, sa durée, son allure. */
  async #judgeAnimations(
    project: string,
    a: Asset,
    bandes: string[],
    done: { animations: string[]; durees: { nom: string; duree_s: number }[] },
  ): Promise<{ ok: boolean; mineur: boolean; summary: string; points: string[]; remplacements: { animation: string; par: string; pourquoi: string }[] }> {
    const busy = this.#validating.get(project) ?? new Set<string>();
    busy.add(a.id);
    this.#validating.set(project, busy);
    try {
      const duration = (n: string) => done.durees.find((d) => d.nom === n)?.duree_s;
      const { data } = await this.#orchestrator.structured({
        systemPrompt: ANIM_VALIDATOR_SYSTEM,
        prompt: [
          `Animations du modèle 3D de l'asset ${a.id} « ${a.name} » (${a.type}). Usage : ${a.usage}. Spécifications : ${a.specs || "aucune"}.`,
          ...done.animations.map((n) => `- « ${n} »${duration(n) !== undefined ? ` (${duration(n)} s)` : ""} : bande ${bandes.find((b) => new RegExp(`-anim-${n.toLowerCase().replace(/[^a-z0-9_]+/g, "-")}\\.png$`).test(b)) ?? "?"}`),
          `Animations demandées par la fiche : ${a.model3d?.animations.join(", ") || "aucune"}.`,
        ].join("\n"),
        jsonSchema: ANIM_SCHEMA,
        readDir: artRoot(this.#projects.get(project).root),
        role: "art",
        meta: { project, agent: "art_director" },
      });
      const d = data as { ok: boolean; mineur?: boolean; summary: string; points: string[]; remplacements?: { animation: string; par: string; pourquoi: string }[] };
      return {
        ok: !!d.ok,
        mineur: !d.ok && !!d.mineur,
        summary: String(d.summary ?? "").slice(0, 400),
        points: (d.points ?? []).slice(0, 8).map((p) => `Animation : ${p}`),
        remplacements: (d.remplacements ?? []).filter((r) => r.animation && r.par && done.animations.includes(r.animation)).slice(0, 4),
      };
    } finally {
      busy.delete(a.id);
    }
  }

  /** Le validateur devant les photos du modèle exporté. */
  async #judgeModel(
    project: string,
    a: Asset,
    source: string | null,
    planche: string[],
    renders: string[],
    done: { dims: number[]; tris: number; animations: string[] },
    spec: Model3DSpec,
  ): Promise<{ ok: boolean; forme_ok: boolean; mineur: boolean; summary: string; points: string[] }> {
    const busy = this.#validating.get(project) ?? new Set<string>();
    busy.add(a.id);
    this.#validating.set(project, busy);
    try {
      const { data } = await this.#orchestrator.structured({
        systemPrompt: MODEL_VALIDATOR_SYSTEM,
        prompt: [
          `Modèle 3D de l'asset ${a.id} « ${a.name} » (${a.type}). Usage : ${a.usage}. Spécifications : ${a.specs || "aucune"}.`,
          source ? `Image validée qui a servi de modèle : ${source}` : "Objet simple, modélisé directement dans Blender d'après la fiche (pas d'image de départ).",
          planche.length ? `Planche dont la 3D est tirée (face, gauche, dos, droite) : ${planche.join(", ")}` : "",
          `Photos (face, trois-quarts, profil, dos, poses d'animation, vue de jeu) : ${renders.join(", ")}`,
          `Mesures : ${done.dims.map((d) => `${d} m`).join(" × ")} (demandé : ${spec.size} m pour la plus grande dimension), ${done.tris} triangles (budget ${spec.tris})${done.animations.length ? `, animations : ${done.animations.join(", ")}` : ""}.`,
        ].join("\n"),
        jsonSchema: MODEL_SCHEMA,
        readDir: artRoot(this.#projects.get(project).root),
        role: "art",
        meta: { project, agent: "art_director" },
      });
      const d = data as { ok: boolean; forme_ok?: boolean; mineur?: boolean; summary: string; points: string[] };
      return { ok: !!d.ok, forme_ok: d.forme_ok !== false, mineur: !d.ok && d.forme_ok !== false && !!d.mineur, summary: String(d.summary ?? "").slice(0, 400), points: (d.points ?? []).slice(0, 8) };
    } finally {
      busy.delete(a.id);
    }
  }

  /** Le validateur regarde tous les essais d'un tour, choisit le meilleur et le juge (la forme seulement pour la 3D). */
  async #pick(
    project: string,
    asset: Asset,
    files: string[],
    prompt: string,
  ): Promise<{ best: number; ok: boolean; usable: boolean; summary: string; points: string[]; prompt: string | null; edit: string | null }> {
    const busy = this.#validating.get(project) ?? new Set<string>();
    busy.add(asset.id);
    this.#validating.set(project, busy);
    try {
      const { data } = await this.#orchestrator.structured({
        systemPrompt: asset.model3d ? REFERENCE_VALIDATOR_SYSTEM : VALIDATOR_SYSTEM,
        prompt: [
          `Le générateur local (Flux) a fait ${files.length} essais pour l'asset ${asset.id} « ${asset.name} » (${asset.type}). Regarde-les tous :`,
          ...files.map((f, k) => `${k + 1}. ${f}`),
          asset.direction ? `Croquis choisi par le directeur créatif (la direction à suivre) : ${asset.direction.file}` : "",
          asset.styleRef ? `Référence de style (l'asset doit en avoir l'air de famille) : ${asset.styleRef}` : "",
          this.#kontext() ? "Flux Kontext est prêt : tu peux proposer une retouche (edit)." : "",
          asset.model3d ? "Choisis le meilleur (best) comme modèle pour la 3D, puis juge sa forme seule." : "Choisis le meilleur (best), puis juge-le seul : « ok » s'il peut entrer dans le jeu.",
          `Usage : ${asset.usage}`,
          `Spécifications : ${asset.specs || "aucune"}`,
          `Prompt utilisé (Flux) : ${prompt}`,
        ]
          .filter(Boolean)
          .join("\n"),
        jsonSchema: PICK_SCHEMA,
        readDir: artRoot(this.#projects.get(project).root),
        role: "art",
        meta: { project, agent: "art_director" },
      });
      const v = data as { best: number; ok: boolean; usable?: boolean; summary: string; points: string[]; prompt: string | null; edit?: string | null };
      return {
        best: Number(v.best) || 1,
        ok: !!v.ok,
        usable: !!v.ok || !!v.usable,
        summary: String(v.summary ?? "").slice(0, 400),
        points: (v.points ?? []).slice(0, 8),
        prompt: v.prompt ?? null,
        edit: v.edit?.trim() ? v.edit.trim().slice(0, 1000) : null,
      };
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

  /** Une photo de travail de l'atelier Blender (hors du dépôt), pour suivre l'artisan depuis l'onglet Visuels. */
  atelierFile(project: string, id: string, name: string): { path: string; mime: string } {
    this.#projects.get(project);
    if (!/^A-\d{4,}$/.test(id) || !/^photo-\d+-(face|trois-quarts|profil|dos|vue-jeu|pose-[a-z0-9_-]{1,30})\.png$/.test(name)) throw new ArtError("Photo refusée");
    const path = join(this.#model3d.atelier(`${project}-${id}`), name);
    if (!existsSync(path)) throw new ArtError("Photo introuvable");
    return { path, mime: "image/png" };
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

/** La question des croquis, et la réponse que l'interface renvoie quand vous cliquez un croquis (« question → option »). */
export const sketchQuestion = (id: string, name: string) => `Quel croquis pour ${id} « ${name} » ?`;
const SKETCH_ANSWER = /^Quel croquis pour (A-\d{4,})\b[^\n]*\?\s*→\s*Croquis (\d+)\b/;
/** La question d'un duel de styles, et la réponse de l'interface (ADR-58). */
export const styleQuestion = (id: string, subject: string) => `Quel style pour le jeu (duel ${id}, « ${subject} ») ?`;
const STYLE_ANSWER = /^Quel style pour le jeu \(duel (S-\d+)\b[^\n]*\?\s*→\s*Style (\d+)\b/m;
/** Vignettes dessinées au plus pour les questions d'un message (quelques secondes chacune). */
const MAX_VIGNETTES = 8;

/** « Concept art de Hades » → « concept-art-de-hades » (nom de fichier court). */
function slugName(s: string): string {
  return (s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "reference").slice(0, 40);
}

/** Un nouveau sujet dans le style de l'image de référence (Flux Kontext). */
const styled = (prompt: string) => `Using exactly the same art style, rendering, palette and level of detail as this image, draw a new, different subject: ${prompt}`;

/**
 * « A-0002 » → l'image retenue de cet asset (verdict, sinon croquis choisi) ; « moodboard/x.png » → ce fichier s'il existe ;
 * « style » → l'image du style retenu au duel (ADR-58). Un asset ne se prend pas lui-même pour référence.
 */
function resolveRef(assets: Asset[], root: string, ref: string, self: string, style: string | null = null): string | null {
  if (/^style$/i.test(ref)) return style && existsSync(join(root, style)) ? style : null;
  const id = /^A-\d{4,}$/i.exec(ref)?.[0]?.toUpperCase();
  if (id) {
    const a = id === self ? null : assets.find((x) => x.id === id);
    const file = a?.verdict?.ok ? a.verdict.file : (a?.direction?.file ?? null);
    return file && existsSync(join(root, file)) ? file : null;
  }
  return safeRel(ref) && IMAGE_MIME[extname(ref).toLowerCase()] && existsSync(join(root, ref)) ? ref : null;
}

/** Les vues de la planche, dans l'ordre de Tripo, et leur nom en clair. */
const VIEW_EN: string[] = ["front", "left", "back", "right"];
const VIEW_FR = ["face", "gauche", "dos", "droite"];

/** L'extension d'une image d'après son contenu (les vues de Tripo arrivent sans nom de fichier). */
function imageExt(b: Buffer): string {
  return Object.values(IMAGE_TYPES).find((t) => t.magic(b))?.ext ?? ".png";
}

/** « biped:walk » → « walk » : le nom que le modèle et le jeu connaissent. */
function shortName(a: string): string {
  return a.replace(/^biped:/, "");
}

/** Les animations du modèle sont-elles celles que la fiche demande (noms courts, sans préfixe de bibliothèque) ? */
function sameAnimations(have: string[], want: string[]): boolean {
  const h = new Set(have.map(shortName));
  const w = new Set(want.map(shortName));
  return h.size === w.size && [...w].every((a) => h.has(a));
}

/** La scène vitrine que le hub photographie (ADR-49), telle que le développeur doit la faire. */
function vitrineScene(id: string): string {
  return `Quand l'adresse du jeu contient « ?vitrine=${id} » (n'importe quel identifiant d'asset intégré), le jeu affiche seulement cet asset, dès le chargement, sans menu ni écran d'accueil : caméra, lumière et sol du jeu, à sa taille réelle à côté du joueur pour l'échelle, son animation de marche ou d'attente en boucle. Le hub s'en sert pour photographier chaque visuel intégré.`;
}

/** Les couleurs de la fiche (codes hexadécimaux), que l'artisan 3D utilise pour repeindre. */
export function paletteOf(asset: Pick<Asset, "specs" | "usage">): string[] {
  return [...new Set(`${asset.specs} ${asset.usage}`.match(/#[0-9a-f]{6}\b/gi) ?? [])].map((c) => c.toUpperCase()).slice(0, 12);
}

function renderArtHistory(history: ArtMessage[]): string {
  const lines = history.map((m) => `<message de="${m.role === "human" ? "directeur créatif" : "toi (Directeur artistique)"}">\n${m.text.replaceAll(IMAGE_MARK, "Image : ")}\n</message>`);
  return `Discussion jusqu'ici (la dernière est celle à laquelle tu réponds) :\n\n${lines.join("\n\n")}\n\nRéponds au dernier message du directeur créatif. Si des images y sont citées, regarde-les d'abord (Read).`;
}

