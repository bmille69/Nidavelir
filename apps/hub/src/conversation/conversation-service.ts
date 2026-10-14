import type { Author, Message, Thread } from "@studio/contracts";
import { randomUUID } from "node:crypto";
import type { Clock } from "../clock.ts";
import type { Db } from "../db/database.ts";
import type { Journal } from "../journal/journal.ts";
import type { OrchestratorPort } from "../orchestrator/port.ts";
import type { ProjectRegistry } from "../projects/project-registry.ts";
import { nextId } from "../util/ids.ts";
import type { ExtractionService } from "../vision/extraction.ts";
import type { VisionService } from "../vision/vision-service.ts";
import { codeContext } from "../projects/code-context.ts";
import { directorSystemPrompt, renderCodeContext, directorTurnPrompt, renderContextPack, renderHistory } from "./prompts.ts";

export class ConversationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversationError";
  }
}

const MAX_MESSAGE_CHARS = 20_000;
const HISTORY_MESSAGES = 30;

type Row = Record<string, unknown>;
const toThread = (r: Row): Thread => ({
  id: String(r.id),
  project: String(r.project),
  title: String(r.title),
  mode: r.mode as Thread["mode"],
  created_at: String(r.created_at),
});
const toMessage = (r: Row): Message => ({
  id: String(r.id),
  thread: String(r.thread),
  seq: Number(r.seq),
  role: r.role as Message["role"],
  text: String(r.text),
  at: String(r.at),
  extraction: r.extraction as Message["extraction"],
  cost_usd: r.cost_usd == null ? null : Number(r.cost_usd),
});

/** Fils de conversation par projet, mode exploration (docs/VISION_ENGINE.md §2.1). */
export class ConversationService {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #journal: Journal;
  readonly #projects: ProjectRegistry;
  readonly #vision: VisionService;
  readonly #extraction: ExtractionService;
  readonly #orchestrator: OrchestratorPort;
  readonly #background = new Set<Promise<void>>();
  /** Travail en cours, pour la vue « Studio » (réponses du directeur, extractions). */
  readonly #replying = new Map<string, { project: string; thread: string; title: string; since: string }>();
  readonly #extracting = new Map<string, { project: string; since: string }>();
  readonly #pendingImplement = new Map<string, ImplementRequest>();
  /** Compétences ajoutées aux consignes du directeur (ADR-29). */
  skills: { promptBlock(agent: "director", project: string): string } | null = null;
  /**
   * Pilote automatique (ADR-20) : prévenu après chaque échange, une fois les idées notées.
   * Absent = comportement « je valide tout », sans extraction des réponses du directeur.
   */
  autopilot: {
    afterExchange(project: string, thread: string, settled: Promise<unknown>): void;
    implement(project: string, thread: string, request: ImplementRequest, settled: Promise<unknown>): Promise<void>;
  } | null = null;

  constructor(deps: {
    db: Db;
    clock: Clock;
    journal: Journal;
    projects: ProjectRegistry;
    vision: VisionService;
    extraction: ExtractionService;
    orchestrator: OrchestratorPort;
  }) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#journal = deps.journal;
    this.#projects = deps.projects;
    this.#vision = deps.vision;
    this.#extraction = deps.extraction;
    this.#orchestrator = deps.orchestrator;
  }

  createThread(project: string, title: string): Thread {
    this.#projects.get(project);
    const thread: Thread = {
      id: randomUUID(),
      project,
      title: title.trim().slice(0, 120) || "Nouvelle discussion",
      mode: "exploration",
      created_at: this.#clock.now(),
    };
    this.#db
      .prepare("INSERT INTO threads (id, project, title, mode, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(thread.id, thread.project, thread.title, thread.mode, thread.created_at);
    return thread;
  }

  listThreads(project: string): Thread[] {
    return (this.#db.prepare("SELECT * FROM threads WHERE project = ? ORDER BY created_at DESC").all(project) as Row[]).map(toThread);
  }

  getThread(project: string, id: string): Thread {
    const row = this.#db.prepare("SELECT * FROM threads WHERE id = ? AND project = ?").get(id, project) as Row | undefined;
    if (!row) throw new ConversationError("Discussion introuvable");
    return toThread(row);
  }

  messages(project: string, threadId: string): Message[] {
    this.getThread(project, threadId);
    return (this.#db.prepare("SELECT * FROM messages WHERE thread = ? ORDER BY seq").all(threadId) as Row[]).map(toMessage);
  }

  /**
   * Enregistre votre message, obtient la réponse du directeur, puis lance
   * l'extraction en arrière-plan. Ne modifie jamais le canon.
   */
  async send(project: string, threadId: string, text: string): Promise<{ human: Message; director: Message }> {
    const body = text.trim();
    if (!body) throw new ConversationError("Message vide");
    if (body.length > MAX_MESSAGE_CHARS) throw new ConversationError(`Message trop long (> ${MAX_MESSAGE_CHARS} caractères)`);
    const thread = this.getThread(project, threadId);
    const history = this.messages(project, threadId).slice(-HISTORY_MESSAGES);
    // Atelier (ADR-24) : aucune fiche n'est notée ; la discussion et les chantiers suffisent.
    const workshop = this.#projects.get(project).autonomy === "workshop";
    const human = this.#insert(thread.id, "human", body, workshop ? "none" : "pending", null);
    this.#journal.append({ project, actor: { kind: "human" }, type: "message.sent", subject: thread.id, payload: { message: human.id } });

    const extractions = workshop ? [] : [this.#track(this.#extractFrom(project, human, history))];

    this.#replying.set(human.id, { project, thread: thread.id, title: thread.title, since: human.at });
    let exchange: { human: Message; director: Message };
    try {
      exchange = await this.#reply(project, thread, history, body, human);
    } finally {
      this.#replying.delete(human.id);
    }
    if (this.autopilot && workshop) {
      const request = this.#pendingImplement.get(exchange.director.id);
      this.#pendingImplement.delete(exchange.director.id);
      if (request) this.#track(this.autopilot.implement(project, thread.id, request, Promise.resolve()));
      return exchange;
    }
    // En autonomie, ce que le directeur propose compte aussi : ses propositions sont notées comme les vôtres.
    if (this.autopilot && this.#projects.get(project).autonomy !== "supervised") {
      this.#setExtraction(exchange.director.id, "pending");
      extractions.push(this.#track(this.#extractFrom(project, exchange.director, [...history, human])));
      const settled = Promise.allSettled(extractions);
      const request = this.#pendingImplement.get(exchange.director.id);
      this.#pendingImplement.delete(exchange.director.id);
      if (request) this.#track(this.autopilot.implement(project, thread.id, request, settled));
      else this.autopilot.afterExchange(project, thread.id, settled);
    }
    return exchange;
  }

  activity() {
    return { replying: [...this.#replying.values()], extracting: [...this.#extracting.values()] };
  }

  async #reply(project: string, thread: Thread, history: Message[], body: string, human: Message): Promise<{ human: Message; director: Message }> {
    const p = this.#projects.get(project);
    const code = p.autonomy === "workshop" ? await codeContext(p.root) : null;
    const pack = renderContextPack({
      projectName: p.name,
      visionRev: this.#vision.visionRev(project),
      mode: thread.mode,
      canon: this.#vision.list(project, { tier: "canon" }).filter((i) => i.status === "validated"),
      working: this.#vision
        .list(project, { tier: "working" })
        .filter((i) => ["captured", "triaged", "open"].includes(i.status))
        .slice(-60),
    });
    const { text: raw, costUsd } = await this.#orchestrator.reply({
      systemPrompt: [directorSystemPrompt(code ? `${pack}\n\n${renderCodeContext(code)}` : pack, p.autonomy), this.skills?.promptBlock("director", project) ?? ""]
        .filter(Boolean)
        .join("\n\n"),
      prompt: directorTurnPrompt(history, body),
      meta: { project, agent: "director" },
    });
    // Le directeur ne code pas : quand vous dites « go », il confie le travail au développeur (ADR-22).
    const { text: answer, request } = parseImplement(raw);
    const delegate = request && this.autopilot && p.autonomy !== "supervised";
    const shown = !delegate
      ? answer
      : p.autonomy === "workshop"
        ? `${answer}

${BRIEF_MARK}${request.title}
${request.goal}`
        : `${answer}

→ Je confie ce travail au développeur. Il va préparer un plan ; je vous dis ici dès que c'est lancé.`;
    const director = this.#insert(thread.id, "director", shown, "none", costUsd);
    if (delegate) this.#pendingImplement.set(director.id, request);
    this.#journal.append({
      project,
      actor: { kind: "agent", role: "director", run: this.#orchestrator.name },
      type: "message.replied",
      subject: thread.id,
      payload: { message: director.id, cost_usd: costUsd },
    });
    return { human, director };
  }

  /** Message du directeur ajouté par le hub (ex. « tâche confiée au développeur »). */
  notify(project: string, threadId: string, text: string): Message {
    const thread = this.getThread(project, threadId);
    return this.#insert(thread.id, "director", text, "none", null);
  }

  /** Attend la fin des extractions en cours (tests, arrêt propre). */
  async idle(): Promise<void> {
    while (this.#background.size) await Promise.allSettled([...this.#background]);
  }

  async #extractFrom(project: string, message: Message, history: Message[]): Promise<void> {
    const run = nextId(this.#db, project, "RUN");
    const author: Author = { kind: "agent", role: "director", run };
    this.#extracting.set(message.id, { project, since: this.#clock.now() });
    try {
      await this.#extraction.extract({
        project,
        author,
        text: message.text,
        context: renderHistory(history.slice(-4)) || undefined,
        kind: "message",
        ref: () => `${message.thread}/${message.id}`,
        untrusted: false,
      });
      this.#setExtraction(message.id, "done");
    } catch (err) {
      this.#setExtraction(message.id, "failed");
      this.#journal.append({
        project,
        actor: author,
        type: "extraction.failed",
        subject: message.id,
        payload: { error: (err as Error).message },
      });
    } finally {
      this.#extracting.delete(message.id);
    }
  }

  #track(p: Promise<void>): Promise<void> {
    this.#background.add(p);
    void p.finally(() => this.#background.delete(p));
    return p;
  }

  #insert(thread: string, role: Message["role"], text: string, extraction: Message["extraction"], cost: number | null): Message {
    const row = this.#db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM messages WHERE thread = ?").get(thread) as { next: number };
    const m: Message = { id: randomUUID(), thread, seq: row.next, role, text, at: this.#clock.now(), extraction, cost_usd: cost };
    this.#db
      .prepare("INSERT INTO messages (id, thread, seq, role, text, at, extraction, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(m.id, m.thread, m.seq, m.role, m.text, m.at, m.extraction, m.cost_usd);
    return m;
  }

  #setExtraction(id: string, status: Message["extraction"]): void {
    this.#db.prepare("UPDATE messages SET extraction = ? WHERE id = ?").run(status, id);
  }
}

export type ImplementRequest = { title: string; goal: string; decisions: string[] };

/**
 * Repère la demande de mise en œuvre que le directeur place en fin de réponse :
 * [[IMPLEMENTER: titre | objectif | D-0001, D-0002]]  (la liste de décisions est facultative).
 * La balise est retirée du texte affiché.
 */
/** Séparateur entre la réponse du directeur et la consigne envoyée au développeur (affichée repliée). */
export const BRIEF_MARK = "§CONSIGNE§ ";

export function parseImplement(text: string): { text: string; request: ImplementRequest | null } {
  // Atelier : consigne complète sur plusieurs lignes.
  const block = /\[\[\s*CHANTIER\s*:([^\]]*)\]\]([\s\S]*?)\[\[\s*\/\s*CHANTIER\s*\]\]/i.exec(text);
  if (block) {
    const [title = "", ids = ""] = block[1]!.split("|").map((s) => s.trim());
    const goal = block[2]!.trim();
    const cleaned = text.replace(block[0], "").trim();
    if (!title || !goal) return { text: cleaned, request: null };
    return { text: cleaned, request: { title: title.slice(0, 160), goal: goal.slice(0, 4000), decisions: ids.match(/D-\d{4,}/g) ?? [] } };
  }
  const re = /\[\[\s*IMPL[EÉ]MENTER\s*:([^\]]*)\]\]/i;
  const m = re.exec(text);
  if (!m) return { text, request: null };
  const [title = "", goal = "", ids = ""] = m[1]!.split("|").map((s) => s.trim());
  const cleaned = text.replace(re, "").trim();
  if (!title) return { text: cleaned, request: null };
  return { text: cleaned, request: { title: title.slice(0, 160), goal: (goal || title).slice(0, 4000), decisions: ids.match(/D-\d{4,}/g) ?? [] } };
}
