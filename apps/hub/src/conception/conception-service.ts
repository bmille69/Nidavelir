import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertHumanSession, type HumanSession } from "../auth/human-session.ts";
import type { Clock } from "../clock.ts";
import type { ConversationService } from "../conversation/conversation-service.ts";
import type { Db } from "../db/database.ts";
import type { TaskService } from "../executor/task-service.ts";
import type { Journal } from "../journal/journal.ts";
import type { OrchestratorPort } from "../orchestrator/port.ts";
import { codeContext } from "../projects/code-context.ts";
import type { Project, ProjectRegistry } from "../projects/project-registry.ts";
import type { VcsPort } from "../vcs/git.ts";
import type { VisionService } from "../vision/vision-service.ts";
import { WEB_TOOLS } from "../llm/claude-cli.ts";
import { CONCEPT_SCHEMA, ConceptTurn, conceptSystemPrompt } from "./prompts.ts";

export class ConceptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConceptionError";
  }
}

export type ConceptionData = Omit<ConceptTurn, "reply" | "questions"> & { questions: ConceptTurn["questions"]; error?: string };
export type Conception = {
  id: string;
  kind: "project" | "feature";
  project: string | null;
  title: string;
  /** thinking : le Concepteur travaille ; open : à vous ; done : projet créé ou chantiers ajoutés. */
  status: "thinking" | "open" | "done";
  data: ConceptionData;
  created_at: string;
  updated_at: string;
};
export type ConceptionMessage = { id: string; seq: number; role: "human" | "concepteur"; text: string; turn: ConceptTurn | null; cost_usd: number | null; at: string };

const EMPTY: ConceptionData = { title: "Nouvelle conception", engine: "", dossier: "", chantiers: [], ready: false, claude_md: "", sources: [], questions: [] };
const HISTORY = 12;

/**
 * Le Concepteur (ADR-28) : transforme une idée floue en dossier de conception et en premiers
 * chantiers, en posant les bonnes questions. Il cherche sur le web (lecture seule) ; il n'écrit
 * rien dans un jeu avant que vous cliquiez « Créer le projet » ou « Ajouter les chantiers ».
 */
export class ConceptionService {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #journal: Journal;
  readonly #projects: ProjectRegistry;
  readonly #tasks: TaskService;
  readonly #conversations: ConversationService;
  readonly #vision: VisionService;
  readonly #vcs: VcsPort;
  readonly #orchestrator: OrchestratorPort;
  readonly #web: boolean;
  readonly #background = new Set<Promise<void>>();
  /** Compétences ajoutées aux consignes du Concepteur (ADR-29). */
  skills: { promptBlock(agent: "concepteur", project: string | null): string } | null = null;

  constructor(deps: {
    db: Db;
    clock: Clock;
    journal: Journal;
    projects: ProjectRegistry;
    tasks: TaskService;
    conversations: ConversationService;
    vision: VisionService;
    vcs: VcsPort;
    orchestrator: OrchestratorPort;
    web?: boolean;
  }) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#journal = deps.journal;
    this.#projects = deps.projects;
    this.#tasks = deps.tasks;
    this.#conversations = deps.conversations;
    this.#vision = deps.vision;
    this.#vcs = deps.vcs;
    this.#orchestrator = deps.orchestrator;
    this.#web = deps.web ?? true;
  }

  list(): Conception[] {
    return (this.#db.prepare("SELECT * FROM conceptions ORDER BY updated_at DESC").all() as Row[]).map(toConception);
  }

  get(id: string): Conception {
    const row = this.#db.prepare("SELECT * FROM conceptions WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new ConceptionError("Conception introuvable");
    return toConception(row);
  }

  messages(id: string): ConceptionMessage[] {
    return (this.#db.prepare("SELECT * FROM conception_messages WHERE conception = ? ORDER BY seq").all(id) as Record<string, unknown>[]).map((r) => ({
      id: String(r.id),
      seq: Number(r.seq),
      role: r.role as ConceptionMessage["role"],
      text: String(r.text),
      turn: r.data_json ? (JSON.parse(String(r.data_json)) as ConceptTurn) : null,
      cost_usd: (r.cost_usd as number | null) ?? null,
      at: String(r.at),
    }));
  }

  /** Ce que le Concepteur est en train de faire (vue « Studio »). */
  activity(): { id: string; title: string; project: string | null; since: string }[] {
    return this.list()
      .filter((c) => c.status === "thinking")
      .map((c) => ({ id: c.id, title: c.title, project: c.project, since: c.updated_at }));
  }

  /** Démarre une conception à partir de votre idée, même en vrac. Le premier tour part en arrière-plan. */
  start(session: HumanSession, input: { kind: "project" | "feature"; project?: string; idea: string }): Conception {
    assertHumanSession(session);
    const idea = input.idea.trim();
    if (!idea) throw new ConceptionError("Décrivez votre idée, même en quelques mots");
    if (input.kind === "feature") this.#projects.get(input.project ?? "");
    const now = this.#clock.now();
    const c: Conception = {
      id: randomUUID(),
      kind: input.kind,
      project: input.kind === "feature" ? input.project! : null,
      title: idea.slice(0, 60),
      status: "thinking",
      data: EMPTY,
      created_at: now,
      updated_at: now,
    };
    this.#db
      .prepare("INSERT INTO conceptions (id, kind, project, title, status, data_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(c.id, c.kind, c.project, c.title, c.status, JSON.stringify(c.data), now, now);
    this.#journal.append({ project: c.project, actor: { kind: "human" }, type: "conception.started", subject: c.id, payload: { kind: c.kind } });
    this.#insert(c.id, "human", idea, null, null);
    this.#track(this.#turn(c.id));
    return c;
  }

  /** Vos réponses ou précisions : le Concepteur reprend en arrière-plan. */
  reply(session: HumanSession, id: string, text: string): Conception {
    assertHumanSession(session);
    const c = this.get(id);
    if (c.status === "thinking") throw new ConceptionError("Le Concepteur travaille encore : attendez sa réponse");
    if (c.status === "done") throw new ConceptionError("Cette conception est terminée");
    if (!text.trim()) throw new ConceptionError("Message vide");
    this.#insert(id, "human", text.trim(), null, null);
    this.#update(id, { status: "thinking" });
    this.#track(this.#turn(id));
    return this.get(id);
  }

  /**
   * « Créer le projet » : dossier du jeu, Git, CLAUDE.md, dossier de conception, discussion
   * « Conception » et premiers chantiers en attente (mode atelier). Rien n'est lancé.
   */
  async createProject(session: HumanSession, id: string, gamesRoot: string): Promise<{ project: Project; tasks: string[] }> {
    assertHumanSession(session);
    const c = this.get(id);
    if (c.kind !== "project" || c.status !== "open") throw new ConceptionError("Cette conception ne peut pas créer de projet");
    if (!c.data.ready) throw new ConceptionError("La conception n'est pas encore prête : répondez d'abord aux questions bloquantes");
    const slug = slugify(c.data.title);
    const root = join(gamesRoot, slug);
    if (existsSync(root) && readdirSync(root).length) throw new ConceptionError(`Le dossier ${root} existe déjà et n'est pas vide`);
    mkdirSync(root, { recursive: true });
    const project = await this.#projects.register(session, { path: root, slug, name: c.data.title, initGit: true });
    if (c.data.claude_md.trim()) writeFileSync(join(root, "CLAUDE.md"), c.data.claude_md.trim() + "\n", "utf8");
    writeFileSync(join(root, "studio", "conception.md"), c.data.dossier.trim() + "\n", "utf8");
    await this.#vcs.commitPaths(root, ["CLAUDE.md", "studio"].filter((p) => existsSync(join(root, p))), `conception: dossier initial de ${c.data.title}`);
    const tasks = this.#seed(project.slug, c, `Conception : ${c.data.title}`);
    this.#finish(id, project.slug, { tasks });
    return { project, tasks };
  }

  /** « Ajouter les chantiers » : dossier dans studio/conceptions/, discussion et chantiers en attente dans le projet. */
  async addToProject(session: HumanSession, id: string): Promise<{ tasks: string[] }> {
    assertHumanSession(session);
    const c = this.get(id);
    if (c.kind !== "feature" || c.status !== "open" || !c.project) throw new ConceptionError("Cette conception ne peut pas être ajoutée à un projet");
    const p = this.#projects.get(c.project);
    const dir = join(p.root, "studio", "conceptions");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${slugify(c.data.title)}.md`), c.data.dossier.trim() + "\n", "utf8");
    await this.#vcs.commitPaths(p.root, ["studio"], `conception: ${c.data.title}`);
    const tasks = this.#seed(p.slug, c, `Conception : ${c.data.title}`);
    this.#finish(id, p.slug, { tasks });
    return { tasks };
  }

  async idle(): Promise<void> {
    while (this.#background.size) await Promise.allSettled([...this.#background]);
  }

  /** Crée la discussion de suivi et les chantiers en attente (lancés un à un par vous ou par « go »). */
  #seed(project: string, c: Conception, threadTitle: string): string[] {
    if (this.#projects.get(project).autonomy === "supervised") return [];
    const thread = this.#conversations.createThread(project, threadTitle);
    const list = c.data.chantiers.map((ch, k) => `${k + 1}. ${ch.title}`).join("\n");
    this.#conversations.notify(
      project,
      thread.id,
      `Conception « ${c.data.title} » terminée. Le dossier est dans studio/${c.kind === "project" ? "conception.md" : "conceptions/"}.\n\nPremiers chantiers, prêts à lancer dans l'ordre (bouton « ▶ Lancer » à droite) :\n${list || "(aucun)"}\n\nVous pouvez aussi me parler ici pour ajuster quoi que ce soit avant de lancer.`,
    );
    return c.data.chantiers.map((ch) => this.#tasks.createFromConversation(project, { title: ch.title, goal: ch.goal }, thread.id).id);
  }

  #finish(id: string, project: string, payload: Record<string, unknown>): void {
    this.#db.prepare("UPDATE conceptions SET status = 'done', project = ?, updated_at = ? WHERE id = ?").run(project, this.#clock.now(), id);
    this.#journal.append({ project, actor: { kind: "human" }, type: "conception.done", subject: id, payload });
  }

  async #turn(id: string): Promise<void> {
    const c = this.get(id);
    try {
      const context = c.kind === "feature" && c.project ? await this.#featureContext(c.project) : "";
      const history = this.messages(id).slice(-HISTORY);
      const prompt = [
        c.data.dossier ? `<dossier_actuel>\n${esc(c.data.dossier)}\n</dossier_actuel>` : "<dossier_actuel>(vide : premier tour)</dossier_actuel>",
        `<echanges>\n${history.map((m) => (m.role === "human" ? `<directeur_creatif>${esc(m.text)}</directeur_creatif>` : `<toi>${esc(m.text)}</toi>`)).join("\n")}\n</echanges>`,
        "Réponds au dernier message du directeur créatif, mets le dossier à jour, puis pose les questions les plus utiles (ou aucune).",
      ].join("\n\n");
      const { data, costUsd } = await this.#orchestrator.structured({
        systemPrompt: [conceptSystemPrompt(c.kind, context), this.skills?.promptBlock("concepteur", c.project) ?? ""].filter(Boolean).join("\n\n"),
        prompt,
        jsonSchema: CONCEPT_SCHEMA,
        meta: { project: c.project, agent: "concepteur" },
        tools: this.#web ? WEB_TOOLS : undefined,
        tier: "concept",
      });
      const parsed = ConceptTurn.parse(data);
      // Le hub numérote lui-même les chantiers : on retire « 1. » ou « 1) » en tête de titre.
      const turn = { ...parsed, chantiers: parsed.chantiers.map((ch) => ({ ...ch, title: ch.title.replace(/^\s*\d+\s*[.)-]\s*/, "") })) };
      this.#insert(id, "concepteur", turn.reply, turn, costUsd);
      const { reply: _r, ...rest } = turn;
      this.#update(id, { status: "open", title: turn.title, data: { ...rest, claude_md: c.kind === "project" ? turn.claude_md : "" } });
    } catch (err) {
      this.#insert(id, "concepteur", `Je n'ai pas pu terminer ma réponse : ${(err as Error).message.slice(0, 300)}. Renvoyez votre message pour réessayer.`, null, null);
      this.#update(id, { status: "open", data: { ...c.data, error: (err as Error).message.slice(0, 300) } });
    }
  }

  async #featureContext(project: string): Promise<string> {
    const p = this.#projects.get(project);
    const code = await codeContext(p.root);
    const bible = this.#vision
      .list(project, { type: "decision", status: "validated" })
      .map((d) => `- ${d.title} : ${(d.decision?.summary ?? d.statement).replace(/\s+/g, " ").slice(0, 240)}`)
      .join("\n");
    return [
      `<projet nom="${esc(p.name)}" />`,
      code.claudeMd ? `<consignes_du_projet source="CLAUDE.md">\n${esc(code.claudeMd)}\n</consignes_du_projet>` : "",
      code.files.length ? `<fichiers_du_jeu total="${code.totalFiles}">\n${code.files.join("\n")}\n</fichiers_du_jeu>` : "",
      bible ? `<bible_du_jeu>\n${esc(bible)}\n</bible_du_jeu>` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  #insert(id: string, role: ConceptionMessage["role"], text: string, turn: ConceptTurn | null, cost: number | null): void {
    const row = this.#db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM conception_messages WHERE conception = ?").get(id) as { next: number };
    this.#db
      .prepare("INSERT INTO conception_messages (id, conception, seq, role, text, data_json, cost_usd, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), id, row.next, role, text, turn ? JSON.stringify(turn) : null, cost, this.#clock.now());
  }

  #update(id: string, patch: Partial<Pick<Conception, "status" | "title" | "data">>): void {
    const c = this.get(id);
    const next = { ...c, ...patch };
    this.#db
      .prepare("UPDATE conceptions SET status = ?, title = ?, data_json = ?, updated_at = ? WHERE id = ?")
      .run(next.status, next.title, JSON.stringify(next.data), this.#clock.now(), id);
  }

  #track(p: Promise<void>): void {
    this.#background.add(p);
    void p.finally(() => this.#background.delete(p));
  }
}

type Row = Record<string, unknown>;
function toConception(r: Row): Conception {
  return {
    id: String(r.id),
    kind: r.kind as Conception["kind"],
    project: (r.project as string | null) ?? null,
    title: String(r.title),
    status: r.status as Conception["status"],
    data: { ...EMPTY, ...(JSON.parse(String(r.data_json)) as Partial<ConceptionData>) },
    created_at: String(r.created_at),
    updated_at: String(r.updated_at),
  };
}

const esc = (s: string) => s.replace(/</g, "‹").replace(/>/g, "›");

export function slugify(name: string): string {
  return (
    name
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 63) || "projet"
  );
}
