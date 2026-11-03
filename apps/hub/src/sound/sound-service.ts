import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";
import type { Task } from "@studio/contracts";
import { assertHumanSession, type HumanSession } from "../auth/human-session.ts";
import type { Clock } from "../clock.ts";
import type { ConversationService } from "../conversation/conversation-service.ts";
import type { TaskService } from "../executor/task-service.ts";
import { isGodot } from "../godot/toolchain.ts";
import type { Journal } from "../journal/journal.ts";
import type { OrchestratorPort } from "../orchestrator/port.ts";
import type { ProjectRegistry } from "../projects/project-registry.ts";
import type { VcsPort } from "../vcs/git.ts";
import { looksLikeMp3, type SoundCredits, type SoundGenPort } from "./elevenlabs.ts";

/**
 * Le directeur sonore (ADR-91). Comme pour les visuels : il propose une liste de sons à partir de votre demande et du
 * jeu ; vous écoutez des essais (ElevenLabs) et choisissez ; les sons choisis entrent dans le jeu par un chantier qui
 * les branche ; après la fusion, le hub vérifie que chaque son est vraiment joué quelque part (pas seulement copié).
 * Aucune génération sans votre clic : chaque essai coûte des crédits ElevenLabs.
 */

export class SoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SoundError";
  }
}

export const SOUND_KINDS = ["effet", "musique", "ambiance", "interface"] as const;
export type SoundKind = (typeof SOUND_KINDS)[number];
export type SoundStatus = "propose" | "a_choisir" | "choisi" | "en_integration" | "integre" | "non_branche";
export type SoundTake = { file: string; at: string; bytes: number; credits: number | null };
export type Sound = {
  id: string;
  name: string;
  kind: SoundKind;
  usage: string;
  prompt: string;
  seconds: number | null;
  loop: boolean;
  status: SoundStatus;
  takes: SoundTake[];
  chosen: string | null;
  /** Où le son a été copié dans le jeu, et par quel chantier il est branché. */
  path: string | null;
  task: string | null;
  note: string | null;
};
export type SoundState = { configured: boolean; credits: SoundCredits | null; sounds: Sound[]; busy: { proposing: boolean; generating: string[] }; error: string | null };

const MANIFEST = "studio/sound/sounds.json";
/** Les sons sont branchés par un chantier dont le titre commence par leurs numéros. */
export const SOUND_TASK = /^S-\d{4}/;

const Proposal = z.object({
  sounds: z
    .array(
      z.object({
        name: z.string().min(1).max(60),
        kind: z.enum(SOUND_KINDS),
        usage: z.string().min(1).max(300),
        prompt: z.string().min(5).max(450),
        seconds: z.number().min(0.5).max(180).nullable(),
        loop: z.boolean(),
      }),
    )
    .min(1)
    .max(12),
  note: z.string().max(600).default(""),
});
const PROPOSAL_SCHEMA = z.toJSONSchema(Proposal, { target: "draft-7" });

export const SOUND_DIRECTOR = `Tu es le directeur sonore d'un studio de jeux vidéo. Le directeur créatif te demande des sons ; tu proposes une liste courte et utile, adaptée au jeu décrit.
Pour chaque son :
- name : un nom court en français (« Tir de tourelle », « Thème du saloon ») ;
- kind : effet (une action, un impact), interface (menus, boutons), ambiance (fond sonore en boucle), musique ;
- usage : quand le joueur l'entend, précisément, en français (« à chaque tir d'une tourelle Gatling ») ;
- prompt : la description pour le générateur ElevenLabs, EN ANGLAIS, concrète et sonore (matière, attaque, durée, espace, style), sans nom de marque ni d'artiste ; pour une musique, genre, tempo, instruments, ambiance, « instrumental, seamless loop » si elle boucle ;
- seconds : durée (effets 0,5 à 3 s, interface 0,5 à 1 s, ambiance 10 à 30 s, musique 30 à 120 s), ou null si le générateur doit choisir ;
- loop : vrai pour une ambiance ou une musique qui tourne en fond.
Ne propose pas un son qui existe déjà dans la liste fournie. Une famille de sons cohérente vaut mieux qu'une collection disparate. note : une phrase sur la direction sonore choisie.`;

function slug(name: string): string {
  return (
    name
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_|_$/g, "")
      .slice(0, 40) || "son"
  );
}

export class SoundService {
  readonly #projects: ProjectRegistry;
  readonly #tasks: TaskService;
  readonly #conversations: ConversationService;
  readonly #orchestrator: OrchestratorPort;
  readonly #vcs: VcsPort;
  readonly #journal: Journal;
  readonly #clock: Clock;
  readonly #gen: SoundGenPort;
  readonly #dir: string;
  readonly #proposing = new Set<string>();
  readonly #generating = new Map<string, Set<string>>();
  readonly #errors = new Map<string, string>();
  readonly #background = new Set<Promise<unknown>>();
  /** La mémoire du studio (ADR-99), ajoutée à ses consignes. */
  memory: (() => string) | null = null;
  /** Un son proposé, choisi, retiré ou vérifié : le plan de production qui l'attend avance (ADR-107). */
  onChange: ((project: string) => void) | null = null;
  #credits: { at: number; value: SoundCredits | null } | null = null;
  #queue: Promise<void> = Promise.resolve();

  constructor(deps: { projects: ProjectRegistry; tasks: TaskService; conversations: ConversationService; orchestrator: OrchestratorPort; vcs: VcsPort; journal: Journal; clock: Clock; gen: SoundGenPort; dataDir: string }) {
    this.#projects = deps.projects;
    this.#tasks = deps.tasks;
    this.#conversations = deps.conversations;
    this.#orchestrator = deps.orchestrator;
    this.#vcs = deps.vcs;
    this.#journal = deps.journal;
    this.#clock = deps.clock;
    this.#gen = deps.gen;
    this.#dir = join(deps.dataDir, "sound");
  }

  // ── Manifeste ──

  sounds(project: string): Sound[] {
    const file = join(this.#projects.get(project).root, MANIFEST);
    if (!existsSync(file)) return [];
    try {
      return (JSON.parse(readFileSync(file, "utf8")) as { sounds: Sound[] }).sounds;
    } catch {
      return [];
    }
  }

  #write(project: string, sounds: Sound[]): void {
    const file = join(this.#projects.get(project).root, MANIFEST);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ sounds }, null, 2)}\n`, "utf8");
  }

  #update(project: string, id: string, patch: Partial<Sound>): Sound {
    const all = this.sounds(project);
    const s = all.find((x) => x.id === id);
    if (!s) throw new SoundError(`Son introuvable : ${id}`);
    Object.assign(s, patch);
    this.#write(project, all);
    return s;
  }

  async #commit(project: string, paths: string[], message: string): Promise<void> {
    await this.#vcs.commitPaths(this.#projects.get(project).root, paths, message).catch(() => {});
  }

  takesDir(project: string): string {
    return join(this.#dir, project.replace(/[^\w-]/g, "_"), "takes");
  }

  /** Un essai à écouter (fichier des données du hub, jamais en dehors). */
  takeFile(project: string, file: string): string | null {
    if (!/^S-\d{4}-\d+\.mp3$/.test(file)) return null;
    const p = join(this.takesDir(project), file);
    return existsSync(p) ? p : null;
  }

  async state(project: string): Promise<SoundState> {
    const configured = this.#gen.configured();
    if (configured && (!this.#credits || Date.now() - this.#credits.at > 60_000)) {
      this.#credits = { at: Date.now(), value: await this.#gen.credits().catch(() => null) };
    }
    return {
      configured,
      credits: configured ? (this.#credits?.value ?? null) : null,
      sounds: this.sounds(project),
      busy: { proposing: this.#proposing.has(project), generating: [...(this.#generating.get(project) ?? [])] },
      error: this.#errors.get(project) ?? null,
    };
  }

  async setKey(session: HumanSession, key: string): Promise<void> {
    assertHumanSession(session);
    await this.#gen.setKey(key).catch((err: Error) => {
      throw new SoundError(err.message);
    });
    this.#credits = null;
    this.#journal.append({ project: null, actor: { kind: "human" }, type: "tool.configured", subject: "elevenlabs", payload: {} });
  }

  // ── Le directeur sonore propose ──

  /** La clé ElevenLabs est réglée (les essais sont possibles). */
  configured(): boolean {
    return this.#gen.configured();
  }

  /** « Demander des sons » : le directeur sonore propose une liste, que vous écoutez et choisissez ensuite. */
  propose(session: HumanSession, project: string, request: string): void {
    assertHumanSession(session);
    this.#track(this.#propose(project, request).catch(() => {}));
  }

  /**
   * Un plan de production demande ses sons (ADR-107) : même directeur sonore, même liste à écouter et à choisir par vous ;
   * rend les numéros proposés. Aucune génération : les essais restent sur votre clic.
   */
  proposeFor(project: string, request: string): Promise<string[]> {
    const job = this.#propose(project, request);
    this.#track(job.catch(() => {}));
    return job;
  }

  #propose(project: string, request: string): Promise<string[]> {
    const p = this.#projects.get(project);
    if (this.#proposing.has(project)) throw new SoundError("Le directeur sonore prépare déjà une liste");
    this.#proposing.add(project);
    this.#errors.delete(project);
    return (async () => {
      try {
        const read = (rel: string, max: number) => (existsSync(join(p.root, rel)) ? readFileSync(join(p.root, rel), "utf8").slice(0, max) : "");
        const existing = this.sounds(project);
        const prompt = [
          `Jeu : ${p.name} (${isGodot(p.root) ? "Godot" : "web"}).`,
          read("studio/BRIEF.md", 4000) && `Bible du jeu (extrait) :\n${read("studio/BRIEF.md", 4000)}`,
          this.#tasks.gameState?.(project) ? `État du jeu :\n${this.#tasks.gameState(project)!.slice(0, 3000)}` : "",
          existing.length ? `Sons déjà prévus ou dans le jeu :\n${existing.map((s) => `- ${s.id} ${s.name} (${s.kind}) : ${s.usage}`).join("\n")}` : "Aucun son pour l'instant.",
          `Demande du directeur créatif : ${request.trim() || "les sons essentiels du jeu : les actions du joueur, les impacts, l'interface, une ambiance et une musique"}`,
        ]
          .filter(Boolean)
          .join("\n\n");
        const { data } = await this.#orchestrator.structured({ systemPrompt: [SOUND_DIRECTOR, this.memory?.() ?? ""].filter(Boolean).join("\n\n"), prompt, jsonSchema: PROPOSAL_SCHEMA, meta: { project, agent: "sound_director" } });
        const out = Proposal.parse(data);
        const all = this.sounds(project);
        let n = all.reduce((m, s) => Math.max(m, Number(s.id.slice(2))), 0);
        const ids: string[] = [];
        for (const s of out.sounds) {
          n++;
          const id = `S-${String(n).padStart(4, "0")}`;
          ids.push(id);
          all.push({ id, ...s, status: "propose", takes: [], chosen: null, path: null, task: null, note: null });
        }
        this.#write(project, all);
        await this.#commit(project, [MANIFEST], `studio: le directeur sonore propose ${out.sounds.length} son(s)`);
        this.#journal.append({ project, actor: { kind: "system" }, type: "sound.proposed", subject: null, payload: { count: out.sounds.length, note: out.note } });
        this.onChange?.(project);
        return ids;
      } catch (err) {
        this.#errors.set(project, `Directeur sonore : ${(err as Error).message.slice(0, 400)}`);
        throw err;
      } finally {
        this.#proposing.delete(project);
      }
    })();
  }

  /** Vous retouchez un son avant de le générer (description, durée, boucle). */
  edit(session: HumanSession, project: string, id: string, patch: { prompt?: string; seconds?: number | null; loop?: boolean; usage?: string; name?: string }): Sound {
    assertHumanSession(session);
    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<Sound>;
    return this.#update(project, id, clean);
  }

  remove(session: HumanSession, project: string, id: string): void {
    assertHumanSession(session);
    const all = this.sounds(project);
    const s = all.find((x) => x.id === id);
    if (!s) return;
    if (["en_integration", "integre"].includes(s.status)) throw new SoundError("Ce son est déjà dans le jeu : retirez-le par un chantier");
    this.#write(project, all.filter((x) => x.id !== id));
    for (const t of s.takes) rmSync(join(this.takesDir(project), t.file), { force: true });
    void this.#commit(project, [MANIFEST], `studio: son ${id} retiré`);
    this.onChange?.(project);
  }

  // ── Essais ──

  /** « Générer des essais » : `count` versions à écouter (1 à 3), sur votre clic seulement. */
  generate(session: HumanSession, project: string, id: string, count = 2): void {
    assertHumanSession(session);
    if (!this.#gen.configured()) throw new SoundError("Ajoutez d'abord votre clé ElevenLabs");
    const s = this.sounds(project).find((x) => x.id === id);
    if (!s) throw new SoundError(`Son introuvable : ${id}`);
    const busy = this.#generating.get(project) ?? new Set<string>();
    if (busy.has(id)) return;
    busy.add(id);
    this.#generating.set(project, busy);
    this.#errors.delete(project);
    // Une génération à la fois : les crédits de chaque essai se lisent avant et après, sans mélange.
    const job = (this.#queue = this.#queue.then(async () => {
      try {
        mkdirSync(this.takesDir(project), { recursive: true });
        for (let k = 0; k < Math.max(1, Math.min(3, count)); k++) {
          const before = await this.#gen.credits().catch(() => null);
          const audio = s.kind === "musique" ? await this.#gen.music({ prompt: s.prompt, seconds: s.seconds ?? 60 }) : await this.#gen.effect({ prompt: s.prompt, seconds: s.seconds, loop: s.loop });
          if (!looksLikeMp3(audio)) throw new Error("ElevenLabs n'a pas rendu un fichier MP3");
          const after = await this.#gen.credits().catch(() => null);
          const current = this.sounds(project).find((x) => x.id === id)!;
          const file = `${id}-${current.takes.length + 1}.mp3`;
          writeFileSync(join(this.takesDir(project), file), audio);
          const credits = before && after ? Math.max(0, after.used - before.used) : null;
          this.#update(project, id, { takes: [...current.takes, { file, at: this.#clock.now(), bytes: audio.length, credits }], status: current.status === "propose" ? "a_choisir" : current.status });
          this.#journal.append({ project, actor: { kind: "human" }, type: "sound.take", subject: id, payload: { file, bytes: audio.length, credits } });
        }
        this.#credits = null;
        await this.#commit(project, [MANIFEST], `studio: essais pour le son ${id}`);
      } catch (err) {
        this.#errors.set(project, `${id} : ${(err as Error).message.slice(0, 400)}`);
      } finally {
        this.#generating.get(project)?.delete(id);
      }
    }));
    this.#track(job);
  }

  /** « Choisir » cet essai. */
  choose(session: HumanSession, project: string, id: string, file: string): Sound {
    assertHumanSession(session);
    const s = this.sounds(project).find((x) => x.id === id);
    if (!s?.takes.some((t) => t.file === file)) throw new SoundError("Essai introuvable");
    if (["en_integration", "integre"].includes(s.status)) throw new SoundError("Ce son est déjà dans le jeu");
    const out = this.#update(project, id, { chosen: file, status: "choisi" });
    void this.#commit(project, [MANIFEST], `studio: son ${id} choisi`);
    this.onChange?.(project);
    return out;
  }

  // ── Intégration ──

  /** « Intégrer les sons choisis » : copiés dans le jeu, puis un chantier les branche. */
  async integrate(session: HumanSession, project: string): Promise<{ task: Task; after: string | null }> {
    assertHumanSession(session);
    return this.#integrate(project, null, null, "human");
  }

  /** Le plan de production branche ses sons (ADR-107) : seulement ceux-là, choisis par vous, dans la discussion du plan. */
  integrateFor(project: string, ids: string[], thread: string): Promise<{ task: Task; after: string | null }> {
    return this.#integrate(project, new Set(ids), thread, "system");
  }

  async #integrate(project: string, only: Set<string> | null, inThread: string | null, by: "human" | "system"): Promise<{ task: Task; after: string | null }> {
    const p = this.#projects.get(project);
    if (p.autonomy === "supervised") throw new SoundError("En « Je valide tout », demandez l'intégration des sons au directeur dans une discussion");
    // Les sons choisis, et ceux qu'un chantier précédent a copiés sans les brancher.
    const chosen = this.sounds(project).filter((s) => ((s.status === "choisi" && s.chosen) || s.status === "non_branche") && (!only || only.has(s.id)));
    if (!chosen.length) throw new SoundError("Aucun son choisi à intégrer");
    const godot = isGodot(p.root);
    const copied: string[] = [];
    for (const s of chosen) {
      if (s.status === "non_branche" && s.path && existsSync(join(p.root, s.path))) continue;
      const dir = godot ? `assets/audio/${s.kind}` : `public/audio/${s.kind}`;
      const rel = `${dir}/${slug(s.name)}.mp3`;
      mkdirSync(join(p.root, dir), { recursive: true });
      copyFileSync(join(this.takesDir(project), s.chosen!), join(p.root, rel));
      copied.push(rel);
      this.#update(project, s.id, { path: rel });
    }
    if (copied.length) await this.#commit(project, [...copied, MANIFEST], `studio: sons ${chosen.map((s) => s.id).join(", ")} copiés dans le jeu`);
    const list = chosen.map((s) => {
      const s2 = this.sounds(project).find((x) => x.id === s.id)!;
      return `- ${s.id} « ${s.name} » (${s.kind}${s.loop ? ", en boucle" : ""}) : ${godot ? `res://${s2.path}` : `/${s2.path!.replace(/^public\//, "")}`} — ${s.usage}`;
    });
    const goal = [
      `Brancher les sons choisis par le directeur créatif. Les fichiers sont déjà dans le jeu :`,
      ...list,
      "",
      godot
        ? "Un seul point d'entrée : un autoload « Sound » (res://scripts/sound.gd) avec play(nom), des AudioStreamPlayer réutilisés (pas un nœud créé par son joué), deux bus « SFX » et « Musique » (default_bus_layout.tres), et tous les volumes en dB dans ce fichier. Musique et ambiances en boucle (loop sur le flux importé), avec un fondu à l'entrée. Si le jeu a déjà des points d'accroche pour le son (passe game feel : fonctions vides du fichier de réglages Feel), branche-les là."
        : "Un seul point d'entrée : src/sound.ts avec play(nom), les fichiers préchargés, un volume par catégorie (effets, interface, musique) dans ce fichier ; la musique démarre au premier geste du joueur (règle des navigateurs). Si le jeu a déjà des points d'accroche pour le son (passe game feel), branche-les là.",
      "Un même son joué très souvent (tirs, impacts) : légère variation de hauteur (± 5 %) et pas plus de quelques instances à la fois.",
      "Ne change aucune règle du jeu. Les tests et les parties gardées doivent passer à l'identique.",
      "Dans ton compte rendu : pour chaque son, l'endroit exact du code qui le joue.",
    ].join("\n");
    const thread = inThread ? this.#conversations.getThread(project, inThread) : this.#conversations.createThread(project, `Sons : ${chosen.map((s) => s.name).join(", ").slice(0, 60)}`, "sound");
    const title = `${chosen.map((s) => s.id).join(", ")} : brancher ${chosen.length === 1 ? `le son « ${chosen[0]!.name} »` : `${chosen.length} sons`}`.slice(0, 160);
    const task = this.#tasks.createFromConversation(project, { title, goal: goal.slice(0, 4000) }, thread.id);
    for (const s of chosen) this.#update(project, s.id, { status: "en_integration", task: task.id, note: null });
    await this.#commit(project, [MANIFEST], `studio: sons confiés à ${task.id}`);
    const { after } = await this.#tasks.launch(project, task.id);
    this.#conversations.notify(project, thread.id, `♪ ${chosen.length} son(s) copiés dans le jeu ; ${after ? `${task.id} attend son tour après ${after.id}` : `${task.id} lancé`} pour les brancher. Après la fusion, le hub vérifie que chacun est bien joué quelque part.`);
    this.#journal.append({ project, actor: by === "human" ? { kind: "human" } : { kind: "system" }, type: "sound.integration_requested", subject: task.id, payload: { sounds: chosen.map((s) => s.id) } });
    return { task: this.#tasks.get(project, task.id), after: after?.id ?? null };
  }

  /**
   * Après la fusion du chantier qui branche les sons : chaque son doit être appelé par le code du jeu (son chemin, ou
   * son nom de fichier, cité dans un script ou une scène). Sinon il est « copié mais jamais joué », et le dit.
   */
  async afterMerge(task: Task): Promise<void> {
    const sounds = this.sounds(task.project).filter((s) => s.task === task.id && s.status === "en_integration");
    if (!sounds.length) return;
    const root = this.#projects.get(task.project).root;
    const code = codeText(root);
    for (const s of sounds) {
      const file = s.path!.split("/").pop()!;
      const stem = file.replace(/\.mp3$/, "");
      const used = code.includes(s.path!) || code.includes(s.path!.replace(/^public\//, "")) || code.includes(file) || new RegExp(`["'\`]${stem}["'\`]`).test(code);
      this.#update(task.project, s.id, used ? { status: "integre", note: null } : { status: "non_branche", note: "copié dans le jeu, mais aucun script ni scène ne le joue" });
    }
    await this.#commit(task.project, [MANIFEST], `studio: sons de ${task.id} vérifiés`);
    this.#journal.append({ project: task.project, actor: { kind: "system" }, type: "sound.checked", subject: task.id, payload: { sounds: sounds.map((s) => s.id) } });
    this.onChange?.(task.project);
  }

  /** Branché sur les changements de statut des chantiers : un chantier de sons fusionné est vérifié. */
  onTaskStatus(task: Task): void {
    if (task.status === "merged" && SOUND_TASK.test(task.title)) this.#track(this.afterMerge(task).catch(() => {}));
  }

  #track(p: Promise<unknown>): void {
    this.#background.add(p);
    void p.finally(() => this.#background.delete(p));
  }

  async idle(): Promise<void> {
    while (this.#background.size) await Promise.allSettled([...this.#background]);
  }
}

/** Le texte des scripts et scènes du jeu (hors studio/, addons du hub, dépendances, exports). */
function codeText(root: string): string {
  const out: string[] = [];
  const skip = /^(\.git|\.godot|node_modules|studio|build|dist|addons[\\/]studio_)/;
  const walk = (dir: string, depth: number) => {
    if (depth > 8) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      const rel = relative(root, p);
      if (skip.test(rel)) continue;
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.(gd|tscn|tres|cs|ts|tsx|js|jsx|mjs|html|json)$/i.test(e.name) && statSync(p).size < 2_000_000) out.push(readFileSync(p, "utf8"));
    }
  };
  walk(root, 0);
  return out.join("\n");
}
