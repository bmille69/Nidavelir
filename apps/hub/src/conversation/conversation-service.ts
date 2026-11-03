import { AUTOMATIC_THREAD_ORIGINS, TASK_REQUEST_WORDS_MAX, type Author, type Message, type Thread, type ThreadOrigin } from "@studio/contracts";
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
import { manifestSummary } from "../art/manifest.ts";
import { join } from "node:path";
import { CAPTURES_DIR, imagesOf, withImages } from "./captures.ts";
import { compactMarks, withMarks, type TeamService } from "../team/team-service.ts";
import { directorSystemPrompt, renderCodeContext, directorTurnPrompt, hubTurnPrompt, renderContextPack, renderHistory } from "./prompts.ts";

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
  readonly #pendingImplement = new Map<string, Directives>();
  /** Compétences ajoutées aux consignes du directeur (ADR-29). */
  skills: { promptFor(agent: "director", project: string): { text: string; dir: string | null } } | null = null;
  /** Chantiers du projet et séance en cours, montrés au directeur en atelier (ADR-31). */
  workshopState: ((project: string) => string) | null = null;
  /** L'équipe (ADR-98) : consulter un collègue, proposer un souvenir, lire le jeu. Absente : le directeur répond seul. */
  team: TeamService | null = null;
  /**
   * Pilote automatique (ADR-20) : prévenu après chaque échange, une fois les idées notées.
   * Absent = comportement « je valide tout », sans extraction des réponses du directeur.
   */
  autopilot: {
    afterExchange(project: string, thread: string, settled: Promise<unknown>): void;
    implement(project: string, thread: string, request: ImplementRequest, settled: Promise<unknown>): Promise<void>;
    workshop(project: string, thread: string, directives: Directives): Promise<void>;
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

  /** `origin` (ADR-113) : qui l'ouvre ; les services du hub donnent le leur, pour ranger leurs fils sous « Automatiques ». */
  createThread(project: string, title: string, origin: ThreadOrigin = "human"): Thread {
    this.#projects.get(project);
    const thread: Thread = {
      id: randomUUID(),
      project,
      title: title.trim().slice(0, 120) || "Nouvelle discussion",
      mode: "exploration",
      created_at: this.#clock.now(),
    };
    this.#db
      .prepare("INSERT INTO threads (id, project, title, mode, created_at, origin) VALUES (?, ?, ?, ?, ?, ?)")
      .run(thread.id, thread.project, thread.title, thread.mode, thread.created_at, origin);
    return thread;
  }

  /**
   * Discussions du projet, la plus récemment active d'abord, avec leur activité
   * (l'interface s'en sert pour vous placer sur la bonne et signaler les nouveautés).
   */
  listThreads(project: string): Thread[] {
    const rows = this.#db
      .prepare(
        `SELECT t.*, COUNT(m.id) AS n, MAX(m.seq) AS last_seq, MAX(m.at) AS last_at,
                (SELECT role FROM messages WHERE thread = t.id ORDER BY seq DESC LIMIT 1) AS last_role
         FROM threads t LEFT JOIN messages m ON m.thread = t.id
         WHERE t.project = ? GROUP BY t.id ORDER BY COALESCE(MAX(m.at), t.created_at) DESC`,
      )
      .all(project) as Row[];
    return rows.map((r) => ({
      ...toThread(r),
      messages: Number(r.n),
      last_seq: Number(r.last_seq ?? 0),
      last_at: (r.last_at as string | null) ?? null,
      last_role: (r.last_role as Thread["last_role"]) ?? null,
      origin: (r.origin as string | null) ?? null,
      automatic: isAutomaticThread((r.origin as string | null) ?? null, String(r.title)),
    }));
  }

  /** Renommer une discussion (son titre est d'abord le début du premier message). */
  renameThread(project: string, id: string, title: string): Thread {
    this.getThread(project, id);
    const clean = title.trim().replace(/\s+/g, " ").slice(0, 120);
    if (!clean) throw new ConversationError("Titre vide");
    this.#db.prepare("UPDATE threads SET title = ? WHERE id = ? AND project = ?").run(clean, id, project);
    return this.getThread(project, id);
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
    const history = this.#history(project, threadId);
    // Atelier (ADR-24) : aucune fiche n'est notée ; la discussion et les chantiers suffisent.
    const workshop = this.#projects.get(project).autonomy === "workshop";
    const human = this.#insert(thread.id, "human", body, workshop ? "none" : "pending", null);
    this.#journal.append({ project, actor: { kind: "human" }, type: "message.sent", subject: thread.id, payload: { message: human.id } });

    const extractions = workshop ? [] : [this.#track(this.#extractFrom(project, human, history))];

    this.#replying.set(human.id, { project, thread: thread.id, title: thread.title, since: human.at });
    let exchange: { human: Message; director: Message };
    try {
      // Une capture annotée jointe (ADR-72) : le directeur la regarde, dans studio/captures seulement, pour ce tour.
      const images = imagesOf(this.#projects.get(project).root, body);
      const turn = images.length ? withImages(body) : body;
      exchange = { human, director: await this.#reply(project, thread, directorTurnPrompt(history, turn), images.length > 0) };
    } finally {
      this.#replying.delete(human.id);
    }
    // Vos mots, tels quels, partent avec chaque chantier de cette réponse (ADR-121).
    const words = humanRequest(this.messages(project, thread.id));
    if (words) for (const r of this.#pendingImplement.get(exchange.director.id)?.requests ?? []) r.request = words;
    if (this.autopilot && workshop) {
      this.#dispatchWorkshop(project, thread.id, exchange.director);
      return exchange;
    }
    // En autonomie, ce que le directeur propose compte aussi : ses propositions sont notées comme les vôtres.
    if (this.autopilot && this.#projects.get(project).autonomy !== "supervised") {
      this.#setExtraction(exchange.director.id, "pending");
      extractions.push(this.#track(this.#extractFrom(project, exchange.director, [...history, human])));
      const settled = Promise.allSettled(extractions);
      const request = this.#pendingImplement.get(exchange.director.id)?.requests[0];
      this.#pendingImplement.delete(exchange.director.id);
      if (request) this.#track(this.autopilot.implement(project, thread.id, request, settled));
      else this.autopilot.afterExchange(project, thread.id, settled);
    }
    return exchange;
  }

  activity() {
    return { replying: [...this.#replying.values()], extracting: [...this.#extracting.values()] };
  }

  /**
   * Tour du directeur demandé par le hub, sans message de votre part (séance autonome, ADR-31) :
   * point d'étape, suite du plan de la séance. Atelier seulement.
   */
  async hubTurn(project: string, threadId: string, note: string): Promise<{ director: Message; directives: Directives }> {
    const thread = this.getThread(project, threadId);
    if (this.#projects.get(project).autonomy !== "workshop") throw new ConversationError("Réservé au mode atelier");
    const history = this.#history(project, threadId);
    const key = `hub:${threadId}:${this.#clock.now()}`;
    this.#replying.set(key, { project, thread: thread.id, title: thread.title, since: this.#clock.now() });
    let director: Message;
    try {
      director = await this.#reply(project, thread, hubTurnPrompt(history, note));
    } finally {
      this.#replying.delete(key);
    }
    // C'est le pilote qui a demandé ce tour : il applique lui-même les consignes rendues.
    const directives = this.#pendingImplement.get(director.id) ?? parseDirectives("").directives;
    this.#pendingImplement.delete(director.id);
    return { director, directives };
  }

  /** Les derniers messages, encarts de l'équipe résumés en une ligne (ADR-98). */
  #history(project: string, threadId: string): Message[] {
    return this.messages(project, threadId)
      .slice(-HISTORY_MESSAGES)
      .map((m) => ({ ...m, text: compactMarks(m.text) }));
  }

  #dispatchWorkshop(project: string, thread: string, director: Message): void {
    const directives = this.#pendingImplement.get(director.id);
    this.#pendingImplement.delete(director.id);
    if (directives && this.autopilot) this.#track(this.autopilot.workshop(project, thread, directives));
  }

  async #reply(project: string, thread: Thread, prompt: string, images = false): Promise<Message> {
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
    const state = code ? (this.workshopState?.(project) ?? "") : "";
    // Compétences (ADR-97) : leçons en entier, le reste en index à ouvrir avec Read.
    const skills = this.skills?.promptFor("director", project) ?? { text: "", dir: null };
    // L'équipe (ADR-98) : il peut consulter un collègue, proposer un souvenir et lire le jeu avant d'affirmer.
    const team = this.team?.open(project, "directeur", { consult: true, remember: true, read: true }) ?? null;
    let reply: { text: string; costUsd: number | null };
    try {
      reply = await this.#orchestrator.reply({
        systemPrompt: [
          directorSystemPrompt([pack, code ? renderCodeContext(code) : "", manifestSummary(p.root) ?? "", state].filter(Boolean).join("\n\n"), p.autonomy),
          skills.text,
          team?.prompt ?? "",
        ]
          .filter(Boolean)
          .join("\n\n"),
        prompt,
        meta: { project, agent: "director" },
        ...(images ? { readDir: join(p.root, CAPTURES_DIR), images: true } : {}),
        ...(skills.dir ? { skillsDir: skills.dir } : {}),
        ...(team ? { team: team.grant } : {}),
      });
    } finally {
      team?.close();
    }
    const { text: raw, costUsd } = reply;
    // Le directeur ne code pas : quand vous dites « go », il confie le travail au développeur (ADR-22).
    const { text: answer, directives } = parseDirectives(raw);
    const request = directives.requests[0];
    const workshop = p.autonomy === "workshop";
    const delegate = this.autopilot && p.autonomy !== "supervised" && (workshop ? hasDirectives(directives) : !!request);
    const shown = !delegate
      ? answer
      : workshop
        ? [answer, ...directives.requests.map((r) => `${BRIEF_MARK}${r.title}\n${r.goal}`)].filter(Boolean).join("\n\n")
        : `${answer}

→ Je confie ce travail au développeur. Il va préparer un plan ; je vous dis ici dès que c'est lancé.`;
    const director = this.#insert(thread.id, "director", withMarks(shown, team), "none", costUsd);
    if (delegate) this.#pendingImplement.set(director.id, directives);
    this.#journal.append({
      project,
      actor: { kind: "agent", role: "director", run: this.#orchestrator.name },
      type: "message.replied",
      subject: thread.id,
      payload: { message: director.id, cost_usd: costUsd },
    });
    return director;
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
        text: compactMarks(message.text),
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

/** `reworks` : chantiers déjà fusionnés que celui-ci reprend (« reprend T-0012 » dans l'en-tête, ADR-32). */
/** `request` : les mots du directeur créatif, tels quels (ADR-121) ; absent pour un tour demandé par le hub. */
export type ImplementRequest = { title: string; goal: string; decisions: string[]; reworks: string[]; request?: string };

/** Ce que le directeur demande au hub dans une réponse d'atelier (ADR-31). */
export type Directives = {
  /** Chantiers à lancer, dans l'ordre : le premier part, les suivants attendent leur tour. */
  requests: ImplementRequest[];
  /** Séance autonome : durée et objectif. */
  session: { minutes: number; goal: string } | null;
  endSession: boolean;
  /** Chantiers que vous avez dit de fusionner, d'abandonner, ou de lancer (brouillons existants). */
  merge: string[];
  abandon: string[];
  launch: string[];
  /** Corrections que vous demandez sur un chantier à relire. */
  fixes: { task: string; note: string }[];
  /** Grosse demande confiée au Concepteur (ADR-34) : le sujet, avec le contexte utile de la discussion. */
  concevoir: string | null;
  /** Plan de production demandé (ADR-107) : ce qu'il faut produire, avec le contexte. Absent si aucun. */
  production?: string | null;
};

export const hasDirectives = (d: Directives) =>
  d.requests.length + d.merge.length + d.abandon.length + d.launch.length + d.fixes.length > 0 || d.session !== null || d.endSession || d.concevoir !== null || !!d.production;

/** Séparateur entre la réponse du directeur et la consigne envoyée au développeur (affichée repliée). */
export const BRIEF_MARK = "§CONSIGNE§ ";
const HANDED_OVER = "→ Je confie ce travail au développeur.";

/**
 * Ce que le directeur créatif a écrit pour ce chantier (ADR-121) : ses messages depuis la dernière consigne partie avant
 * son dernier message (ce dernier message au moins), tels quels. Faute de place, les plus récents sont gardés.
 */
export function humanRequest(messages: Message[]): string | null {
  const last = messages.findLastIndex((m) => m.role === "human");
  if (last < 0) return null;
  const brief = messages.slice(0, last).findLastIndex((m) => m.role === "director" && (m.text.includes(BRIEF_MARK) || m.text.includes(HANDED_OVER)));
  const words = messages
    .slice(brief + 1, last + 1)
    .filter((m) => m.role === "human")
    .map((m) => m.text)
    .join("\n\n");
  return words.slice(-TASK_REQUEST_WORDS_MAX).trim() || null;
}
/**
 * Les titres des fils que le hub ouvrait seul avant le marqueur d'origine (ADR-113) : « Intégrer A-0001 : … »,
 * « Retoucher A-0001 dans le jeu », « Sons : … », « Game feel : … », « Équilibrage ». Repli pour les anciens seulement.
 */
const LEGACY_AUTOMATIC = /^(Intégrer A-\d+ :|Retoucher A-\d+ dans le jeu|Sons : |Game feel : |Équilibrage$)/;

/** Fil ouvert par le hub pour un travail automatique : d'après son origine, ou son titre s'il date d'avant le marqueur. */
export function isAutomaticThread(origin: string | null, title: string): boolean {
  if (origin) return (AUTOMATIC_THREAD_ORIGINS as readonly string[]).includes(origin);
  return LEGACY_AUTOMATIC.test(title);
}

/** Ligne « §CAPTURE§ T-0001 <date> » : l'interface y affiche la capture du jeu prise par le hub (ADR-33). */
export const CAPTURE_MARK = "§CAPTURE§ ";

const TASK_IDS = /T-\d{4,}/g;

/** « 2h », « 1h30 », « 90 min », « 45min » → minutes (entre 10 min et 8 h). */
export function parseDuration(s: string): number | null {
  const m = /(\d+(?:[.,]\d+)?)\s*h(?:eures?)?\s*(\d+)?/i.exec(s);
  const minutes = m ? Math.round(Number(m[1]!.replace(",", ".")) * 60 + Number(m[2] ?? 0)) : Number(/(\d+)\s*m/i.exec(s)?.[1] ?? NaN);
  return Number.isFinite(minutes) && minutes > 0 ? Math.min(Math.max(minutes, 10), 480) : null;
}

/**
 * Repère les balises que le directeur place dans sa réponse et les retire du texte affiché :
 * - [[CHANTIER: titre]] consigne [[/CHANTIER]] (atelier ; plusieurs blocs = plusieurs chantiers à la suite) ;
 * - [[SEANCE: 2h | objectif]], [[FIN_SEANCE]] ;
 * - [[FUSIONNER: T-0001]], [[ABANDONNER: T-0001]], [[LANCER: T-0002, T-0003]] ;
 * - [[CORRIGER: T-0001]] remarques [[/CORRIGER]] ;
 * - [[IMPLEMENTER: titre | objectif | D-0001, D-0002]] (hors atelier, la liste de décisions est facultative).
 */
export function parseDirectives(text: string): { text: string; directives: Directives } {
  const d: Directives = { requests: [], session: null, endSession: false, merge: [], abandon: [], launch: [], fixes: [], concevoir: null };
  let out = text;
  const take = (re: RegExp, fn: (m: RegExpExecArray) => void) => {
    out = out.replace(re, (...args) => {
      fn(args.slice(0, -2) as unknown as RegExpExecArray);
      return "";
    });
  };
  take(/\[\[\s*CHANTIER\s*:([^\]]*)\]\]([\s\S]*?)\[\[\s*\/\s*CHANTIER\s*\]\]/gi, (m) => {
    const [title = "", ...rest] = m[1]!.split("|").map((s) => s.trim());
    const ids = rest.join(" ");
    const goal = m[2]!.trim();
    if (title && goal) d.requests.push({ title: title.slice(0, 160), goal: goal.slice(0, 4000), decisions: ids.match(/D-\d{4,}/g) ?? [], reworks: ids.match(TASK_IDS) ?? [] });
  });
  take(/\[\[\s*CORRIGER\s*:([^\]]*)\]\]([\s\S]*?)\[\[\s*\/\s*CORRIGER\s*\]\]/gi, (m) => {
    const task = m[1]!.match(TASK_IDS)?.[0];
    if (task && m[2]!.trim()) d.fixes.push({ task, note: m[2]!.trim().slice(0, 2000) });
  });
  take(/\[\[\s*CONCEVOIR\s*\]\]([\s\S]*?)\[\[\s*\/\s*CONCEVOIR\s*\]\]/gi, (m) => {
    if (m[1]!.trim()) d.concevoir = m[1]!.trim().slice(0, 4000);
  });
  take(/\[\[\s*PRODUCTION\s*\]\]([\s\S]*?)\[\[\s*\/\s*PRODUCTION\s*\]\]/gi, (m) => {
    if (m[1]!.trim()) d.production = m[1]!.trim().slice(0, 6000);
  });
  take(/\[\[\s*S[EÉ]ANCE\s*:([^\]]*)\]\]/gi, (m) => {
    const [duration = "", goal = ""] = m[1]!.split("|").map((s) => s.trim());
    const minutes = parseDuration(duration);
    if (minutes) d.session = { minutes, goal: goal.slice(0, 1000) };
  });
  take(/\[\[\s*FIN[_ ]S[EÉ]ANCE\s*\]\]/gi, () => (d.endSession = true));
  take(/\[\[\s*FUSIONNER\s*:([^\]]*)\]\]/gi, (m) => d.merge.push(...(m[1]!.match(TASK_IDS) ?? [])));
  take(/\[\[\s*ABANDONNER\s*:([^\]]*)\]\]/gi, (m) => d.abandon.push(...(m[1]!.match(TASK_IDS) ?? [])));
  take(/\[\[\s*LANCER\s*:([^\]]*)\]\]/gi, (m) => d.launch.push(...(m[1]!.match(TASK_IDS) ?? [])));
  const legacy = parseImplementTag(out);
  if (legacy.request && !d.requests.length) d.requests.push(legacy.request);
  return { text: legacy.text.replace(/\n{3,}/g, "\n\n").trim(), directives: d };
}

/** Première demande de mise en œuvre de la réponse (compatibilité). */
export function parseImplement(text: string): { text: string; request: ImplementRequest | null } {
  const { text: cleaned, directives } = parseDirectives(text);
  return { text: cleaned, request: directives.requests[0] ?? null };
}

function parseImplementTag(text: string): { text: string; request: ImplementRequest | null } {
  const re = /\[\[\s*IMPL[EÉ]MENTER\s*:([^\]]*)\]\]/i;
  const m = re.exec(text);
  if (!m) return { text, request: null };
  const [title = "", goal = "", ids = ""] = m[1]!.split("|").map((s) => s.trim());
  const cleaned = text.replace(re, "").trim();
  if (!title) return { text: cleaned, request: null };
  return { text: cleaned, request: { title: title.slice(0, 160), goal: (goal || title).slice(0, 4000), decisions: ids.match(/D-\d{4,}/g) ?? [], reworks: [] } };
}
