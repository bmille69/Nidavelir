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
import { directorSystemPrompt, directorTurnPrompt, renderContextPack, renderHistory } from "./prompts.ts";

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
    const human = this.#insert(thread.id, "human", body, "pending", null);
    this.#journal.append({ project, actor: { kind: "human" }, type: "message.sent", subject: thread.id, payload: { message: human.id } });

    this.#track(this.#extractFrom(project, human, history));

    const p = this.#projects.get(project);
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
    const { text: answer, costUsd } = await this.#orchestrator.reply({
      systemPrompt: directorSystemPrompt(pack),
      prompt: directorTurnPrompt(history, body),
    });
    const director = this.#insert(thread.id, "director", answer, "none", costUsd);
    this.#journal.append({
      project,
      actor: { kind: "agent", role: "director", run: this.#orchestrator.name },
      type: "message.replied",
      subject: thread.id,
      payload: { message: director.id, cost_usd: costUsd },
    });
    return { human, director };
  }

  /** Attend la fin des extractions en cours (tests, arrêt propre). */
  async idle(): Promise<void> {
    while (this.#background.size) await Promise.allSettled([...this.#background]);
  }

  async #extractFrom(project: string, message: Message, history: Message[]): Promise<void> {
    const run = nextId(this.#db, project, "RUN");
    const author: Author = { kind: "agent", role: "director", run };
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
    }
  }

  #track(p: Promise<void>): void {
    this.#background.add(p);
    void p.finally(() => this.#background.delete(p));
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
