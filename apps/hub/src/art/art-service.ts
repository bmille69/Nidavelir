import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { randomUUID } from "node:crypto";
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
import { ART_SYSTEM, DONE_MARK, IMAGE_MARK, parseArtDirectives, VALIDATOR_SYSTEM, VERDICT_SCHEMA, type ArtDirectives } from "./prompts.ts";

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
  /** Le Directeur artistique est en train de répondre, ou le validateur de juger. */
  busy: { replying: boolean; validating: string[] };
};

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

  constructor(deps: { db: Db; clock: Clock; journal: Journal; projects: ProjectRegistry; orchestrator: OrchestratorPort; vcs: VcsPort; conversations: ConversationService }) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#journal = deps.journal;
    this.#projects = deps.projects;
    this.#orchestrator = deps.orchestrator;
    this.#vcs = deps.vcs;
    this.#conversations = deps.conversations;
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
      busy: { replying: this.#replying.has(project), validating: [...(this.#validating.get(project) ?? [])] },
    };
  }

  messages(project: string): ArtMessage[] {
    return this.#db.prepare("SELECT * FROM art_messages WHERE project = ? ORDER BY seq").all(project) as ArtMessage[];
  }

  /** Activité en cours, pour « Le studio en direct ». */
  activity(): { project: string; kind: "reply" | "validate"; asset?: string }[] {
    return [
      ...[...this.#replying].map((project) => ({ project, kind: "reply" as const })),
      ...[...this.#validating].flatMap(([project, ids]) => [...ids].map((asset) => ({ project, kind: "validate" as const, asset }))),
    ];
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
    const file = asset.renders.at(-1);
    if (decision === "valider") {
      if (!file) throw new ArtError("Aucun rendu à valider : déposez d'abord une image");
      asset.verdict = { ok: true, summary: "Validé par le directeur créatif.", points: asset.verdict?.points ?? [], prompt: null, file, by: "human", at: this.#clock.now() };
      this.#setStatus(asset, "valide");
    } else this.#setStatus(asset, "production");
    writeManifest(gameRoot, m);
    await this.#commit(gameRoot, `art: ${id} ${decision === "valider" ? "validé" : "à refaire"} (directeur créatif)`);
    this.#journal.append({ project, actor: { kind: "human" }, type: decision === "valider" ? "art.asset_validated" : "art.asset_rejected", subject: id, payload: { by: "human" } });
    return asset;
  }

  /**
   * Faire brancher un asset validé dans le jeu : une demande au directeur du projet, dans une nouvelle discussion.
   * Il lance le chantier ; quand un chantier qui porte l'identifiant de l'asset est fusionné, l'asset passe « intégré ».
   */
  async integrate(session: HumanSession, project: string, id: string): Promise<{ thread: string }> {
    assertHumanSession(session);
    const gameRoot = this.#projects.get(project).root;
    const m = readManifest(gameRoot);
    const asset = m.assets.find((a) => a.id === id);
    if (!asset) throw new ArtError(`Asset introuvable : ${id}`);
    if (asset.status !== "valide" && asset.status !== "integration") throw new ArtError("Seul un asset validé peut être intégré");
    const file = asset.verdict?.file ?? asset.renders.at(-1);
    this.#setStatus(asset, "integration");
    writeManifest(gameRoot, m);
    await this.#commit(gameRoot, `art: intégration demandée pour ${id}`);
    const thread = this.#conversations.createThread(project, `Intégrer ${id} : ${asset.name}`.slice(0, 80));
    const text = [
      `Le Directeur artistique a fait valider un visuel : ${id} « ${asset.name} » (${asset.type}). Fais-le brancher dans le jeu.`,
      `- Fichier validé : studio/art/${file}`,
      `- Usage : ${asset.usage}`,
      asset.specs ? `- Spécifications : ${asset.specs}` : "",
      "- La bible visuelle (studio/art/bible.md) et le manifeste (studio/art/assets.json) disent le reste.",
      `Lance un chantier dont le titre commence par « ${id} » : le développeur copie le fichier depuis studio/art/ vers les ressources du jeu (sans rien télécharger), le branche à l'endroit prévu, et l'ajoute aux crédits.`,
    ]
      .filter(Boolean)
      .join("\n");
    void this.#conversations.send(project, thread.id, text).catch(() => {});
    this.#journal.append({ project, actor: { kind: "human" }, type: "art.integration_requested", subject: id, payload: { thread: thread.id } });
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
    if (d.assets.length || d.midjourney.length) writeManifest(gameRoot, m);
    if (d.notes.length) {
      const notes = this.#notes(root);
      for (const n of d.notes) if (safeRel(n.file) && existsSync(join(root, n.file))) notes[n.file] = n.note;
      writeAtomic(join(root, "moodboard", "notes.json"), `${JSON.stringify(notes, null, 2)}\n`);
      done.push(`${d.notes.length} image(s) commentée(s)`);
    }
    return done;
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
      this.#setStatus(a, verdict.ok ? "valide" : "production");
      if (!verdict.ok && verdict.prompt) a.prompts = [verdict.prompt, ...a.prompts.filter((p) => p !== verdict.prompt)].slice(0, 6);
      writeManifest(gameRoot, m);
      await this.#commit(gameRoot, `art: ${id} ${verdict.ok ? "validé" : "à retoucher"} (validateur)`);
      this.#journal.append({ project, actor: { kind: "agent", role: "art_director", run: this.#orchestrator.name }, type: verdict.ok ? "art.asset_validated" : "art.asset_rejected", subject: id, payload: { by: "validator" } });
      this.#insert(
        project,
        "art",
        [
          `${IMAGE_MARK}${file}`,
          verdict.ok ? `**${id} « ${a.name} » : conforme.** ${verdict.summary}` : `**${id} « ${a.name} » : à retoucher.** ${verdict.summary}`,
          ...verdict.points.map((p) => `- ${p}`),
          verdict.ok ? "Vous pouvez le faire intégrer dans le jeu depuis sa fiche." : verdict.prompt ? "Le prompt corrigé est en tête de sa fiche." : "",
        ]
          .filter(Boolean)
          .join("\n"),
        null,
      );
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

