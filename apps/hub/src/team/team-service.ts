import { randomBytes, randomUUID } from "node:crypto";
import type { Clock } from "../clock.ts";
import type { Db } from "../db/database.ts";
import type { Journal } from "../journal/journal.ts";
import type { TeamGrant } from "../llm/claude-cli.ts";
import type { OrchestratorPort } from "../orchestrator/port.ts";
import { GameReader } from "./game-reader.ts";
import type { Memory, StudioMemory } from "./studio-memory.ts";

/**
 * L'équipe (ADR-98) : les agents du studio se consultent entre eux, proposent des souvenirs pour la mémoire du studio
 * (ADR-99) et lisent le jeu avant d'affirmer (ADR-101). Le hub sert ces outils lui-même, par un petit serveur MCP local
 * joignable seulement avec le jeton d'un appel en cours ; tout ce qui s'y passe vous est montré dans la discussion.
 */

export const TEAM_AGENTS = ["directeur", "concepteur", "da", "son", "testeur"] as const;
export type TeamAgent = (typeof TEAM_AGENTS)[number];

export const TEAM_LABELS: Record<TeamAgent, string> = {
  directeur: "le Directeur",
  concepteur: "le Concepteur",
  da: "le Directeur artistique",
  son: "le directeur sonore",
  testeur: "le Testeur",
};

/** Agent compté par le compteur d'utilisation pour chaque membre de l'équipe. */
const USAGE_AGENT: Record<TeamAgent, string> = { directeur: "director", concepteur: "concepteur", da: "art_director", son: "sound_director", testeur: "qa" };

/** Ligne ajoutée au message d'un agent : un encart « X a consulté Y », replié, que l'interface affiche. */
export const CONSULT_MARK = "§CONSULTATION§ ";
/** Ligne ajoutée au message d'un agent : un souvenir proposé pour la mémoire du studio, à garder ou non d'un clic. */
export const MEMORY_MARK = "§SOUVENIR§ ";

export type Consultation = {
  id: string;
  project: string | null;
  from: TeamAgent;
  to: TeamAgent;
  question: string;
  answer: string;
  status: "ok" | "failed";
  cost_usd: number | null;
  at: string;
};

export type TeamTool = "consulter" | "retenir" | "lire_fichier" | "lister" | "chercher";
const READ_TOOLS: TeamTool[] = ["lire_fichier", "lister", "chercher"];

/** Un tour d'agent avec ses outils d'équipe : l'accès à passer à l'appel, les consignes, puis les encarts à montrer. */
export type TeamTurn = {
  grant: TeamGrant;
  /** À ajouter aux consignes de l'agent : ce qu'il peut faire, et quand. */
  prompt: string;
  consultations(): Consultation[];
  memories(): Memory[];
  /** Les lignes d'encarts (consultations, souvenirs proposés) à ajouter à la fin de son message. */
  marks(): string;
  close(): void;
};

type Session = {
  project: string | null;
  agent: TeamAgent;
  tools: TeamTool[];
  reader: GameReader | null;
  consults: Consultation[];
  memories: Memory[];
  expires: number;
};

/** Consultations au plus par réponse d'un agent. */
const MAX_CONSULTS = 3;
/** Une session oubliée (appel coupé) n'est plus valable au-delà. */
const SESSION_TTL = 45 * 60_000;

const PERSONAS: Record<TeamAgent, string> = {
  directeur:
    "Tu es le DIRECTEUR, chef d'équipe IA du studio : tu conduis la discussion avec le directeur créatif, tu connais l'état du jeu, les chantiers en cours et faits, et les décisions validées.",
  concepteur:
    "Tu es le CONCEPTEUR du studio (game design, conception) : tu tiens le dossier de conception du jeu (piliers, boucle de jeu, progression, choix techniques) et tu veilles à la cohérence ludique.",
  da: "Tu es le DIRECTEUR ARTISTIQUE du studio : tu tiens la bible visuelle du jeu et la liste de ses visuels (images, textures, modèles 3D), tu veilles à la cohérence du style.",
  son: "Tu es le DIRECTEUR SONORE du studio : tu proposes et fabriques les effets sonores et la musique du jeu, cohérents avec sa direction.",
  testeur:
    "Tu es le TESTEUR du studio : tu joues au jeu après chaque chantier et tu vérifies ce qui a été fait ; tu sais ce qui marche, ce qui casse et ce qui reste fragile.",
};

const CONSULT_RULES = `Un collègue du studio te consulte pendant qu'il prépare sa réponse au directeur créatif.
- Réponds-lui directement, en français, en 15 lignes au plus : ce que tu sais, ce que tu recommandes et pourquoi, et ce qui reste à trancher par le directeur créatif.
- Appuie-toi sur ton contexte ci-dessus. Ce que tu ne sais pas, dis-le : n'invente ni décision, ni fichier, ni visuel.
- Tu ne décides rien à la place du directeur créatif et tu ne lances rien : tu donnes ton avis d'expert.
- Tu ne peux consulter personne d'autre.`;

export class TeamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TeamError";
  }
}

export class TeamService {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #journal: Journal;
  readonly #orchestrator: OrchestratorPort;
  readonly #memory: StudioMemory;
  readonly #sessions = new Map<string, Session>();
  readonly #running = new Map<string, { project: string | null; from: TeamAgent; to: TeamAgent; question: string; since: string }>();
  /** Adresse du serveur MCP du hub, connue une fois le serveur démarré. Absente : aucun outil d'équipe (tests, hub sans serveur). */
  baseUrl: (() => string) | null = null;
  /** Ce que chaque agent sait, quand on le consulte : posé à l'assemblage du hub. */
  briefings: Partial<Record<TeamAgent, (project: string | null) => string>> = {};
  /** Dossier du jeu, pour sa lecture par les agents (ADR-101). */
  gameRoot: ((project: string) => string | null) | null = null;
  /** Éteindre l'équipe (STUDIO_TEAM=0) : les agents retrouvent leur fonctionnement d'avant, sans outils. */
  enabled = true;

  constructor(deps: { db: Db; clock: Clock; journal: Journal; orchestrator: OrchestratorPort; memory: StudioMemory }) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#journal = deps.journal;
    this.#orchestrator = deps.orchestrator;
    this.#memory = deps.memory;
  }

  /**
   * Ouvre un tour d'agent avec ses outils d'équipe. `consult` : il peut consulter ses collègues ; `remember` : proposer
   * un souvenir ; `read` : lire le jeu du projet. Null si l'équipe est éteinte ou que le hub n'a pas de serveur.
   */
  open(project: string | null, agent: TeamAgent, opts: { consult?: boolean; remember?: boolean; read?: boolean } = {}): TeamTurn | null {
    if (!this.enabled || !this.baseUrl) return null;
    this.#sweep();
    const root = opts.read && project ? (this.gameRoot?.(project) ?? null) : null;
    const tools: TeamTool[] = [...(opts.consult ? (["consulter"] as const) : []), ...(opts.remember ? (["retenir"] as const) : []), ...(root ? READ_TOOLS : [])];
    if (!tools.length) return null;
    const token = randomBytes(24).toString("hex");
    const session: Session = { project, agent, tools, reader: root ? new GameReader(root) : null, consults: [], memories: [], expires: Date.now() + SESSION_TTL };
    this.#sessions.set(token, session);
    return {
      grant: { url: this.baseUrl(), token, tools },
      prompt: teamPrompt(agent, tools),
      consultations: () => [...session.consults],
      memories: () => [...session.memories],
      marks: () => renderMarks(session.consults, session.memories),
      close: () => void this.#sessions.delete(token),
    };
  }

  /** Les consultations d'un projet, du studio (null) ou de partout (« * »), les plus récentes d'abord. */
  list(project: string | null, limit = 50): Consultation[] {
    if (project === "*") return (this.#db.prepare("SELECT * FROM consultations ORDER BY at DESC LIMIT ?").all(limit) as Row[]).map(toConsultation);
    const rows = (project === null
      ? this.#db.prepare("SELECT * FROM consultations WHERE project IS NULL ORDER BY at DESC LIMIT ?").all(limit)
      : this.#db.prepare("SELECT * FROM consultations WHERE project = ? ORDER BY at DESC LIMIT ?").all(project, limit)) as Row[];
    return rows.map(toConsultation);
  }

  /** Consultations en cours, pour la vue « Studio ». */
  activity(): { project: string | null; from: TeamAgent; to: TeamAgent; question: string; since: string }[] {
    return [...this.#running.values()];
  }

  // ── Serveur MCP (JSON-RPC sur HTTP, réponses JSON simples) ──

  /** Traite un message MCP. `null` : notification, rien à répondre (202). Lève TeamError pour un jeton inconnu (401). */
  async handle(token: string, message: unknown): Promise<object | null> {
    const session = this.#sessions.get(token);
    if (!session || session.expires < Date.now()) throw new TeamError("Jeton d'équipe inconnu ou expiré");
    const msg = (message ?? {}) as { id?: string | number; method?: string; params?: Record<string, unknown> };
    if (msg.id === undefined || msg.id === null) return null;
    const ok = (result: object) => ({ jsonrpc: "2.0", id: msg.id, result });
    switch (msg.method) {
      case "initialize":
        return ok({ protocolVersion: typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "studio", version: "1.0.0" } });
      case "ping":
        return ok({});
      case "tools/list":
        return ok({ tools: session.tools.map((t) => TOOL_SPECS[t]) });
      case "tools/call": {
        const name = String(msg.params?.name ?? "") as TeamTool;
        const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
        if (!session.tools.includes(name)) return ok({ content: [{ type: "text", text: `Outil non disponible : ${name}` }], isError: true });
        try {
          return ok({ content: [{ type: "text", text: await this.#call(session, name, args) }] });
        } catch (err) {
          return ok({ content: [{ type: "text", text: (err as Error).message.slice(0, 500) }], isError: true });
        }
      }
      default:
        return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Méthode inconnue : ${String(msg.method)}` } };
    }
  }

  async #call(session: Session, tool: TeamTool, args: Record<string, unknown>): Promise<string> {
    const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : "");
    const num = (k: string) => (typeof args[k] === "number" ? (args[k] as number) : Number(args[k]) || undefined);
    switch (tool) {
      case "consulter":
        return this.#consult(session, str("agent"), str("question"), str("contexte"));
      case "retenir": {
        const r = this.#memory.propose({ text: str("souvenir"), reason: str("pourquoi") || null, by: session.agent, project: session.project });
        if (r.memory) session.memories.push(r.memory);
        return r.note;
      }
      case "lire_fichier":
        return session.reader!.read(str("chemin"), num("debut") ?? 1, num("lignes") ?? 400);
      case "lister":
        return session.reader!.list(str("dossier") || ".");
      case "chercher":
        return session.reader!.search(str("motif"), str("dossier") || ".");
    }
  }

  /** Un collègue répond, avec son propre contexte et la mémoire du studio ; une seule réponse, sans consulter à son tour. */
  async #consult(session: Session, rawTo: string, rawQuestion: string, rawContext: string): Promise<string> {
    const to = normalizeAgent(rawTo);
    if (!to) throw new TeamError(`Collègue inconnu : « ${rawTo} ». Possibles : ${TEAM_AGENTS.filter((a) => a !== session.agent).join(", ")}`);
    if (to === session.agent) throw new TeamError("Tu ne peux pas te consulter toi-même");
    if (session.consults.length >= MAX_CONSULTS) throw new TeamError(`Déjà ${MAX_CONSULTS} consultations pour cette réponse : réponds avec ce que tu sais`);
    const question = rawQuestion.trim().slice(0, 2000);
    if (question.length < 5) throw new TeamError("Pose une vraie question");
    const context = rawContext.trim().slice(0, 3000);
    const id = randomUUID();
    const at = this.#clock.now();
    this.#running.set(id, { project: session.project, from: session.agent, to, question, since: at });
    let answer = "";
    let status: Consultation["status"] = "ok";
    let cost: number | null = null;
    try {
      let briefing = "";
      try {
        briefing = this.briefings[to]?.(session.project) ?? "";
      } catch {
        /* contexte indisponible : il répond avec ce qu'il sait */
      }
      const r = await this.#orchestrator.reply({
        systemPrompt: [PERSONAS[to], briefing || (session.project ? "" : "Aucun projet n'est encore créé : réponds en expert, d'après la question et le contexte donné."), this.#memory.block(), CONSULT_RULES]
          .filter(Boolean)
          .join("\n\n"),
        prompt: [
          `<question de="${TEAM_LABELS[session.agent]}">\n${esc(question)}\n</question>`,
          context ? `<contexte_donne_par_ton_collegue>\n${esc(context)}\n</contexte_donne_par_ton_collegue>` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
        meta: { project: session.project, agent: USAGE_AGENT[to] },
        ...(to === "da" ? { role: "art" as const } : {}),
        lane: "team",
        timeoutMs: 300_000,
      });
      answer = r.text.trim().slice(0, 6000);
      cost = r.costUsd;
    } catch (err) {
      status = "failed";
      answer = `${TEAM_LABELS[to]} n'a pas pu répondre : ${(err as Error).message.slice(0, 300)}`;
    } finally {
      this.#running.delete(id);
    }
    const c: Consultation = { id, project: session.project, from: session.agent, to, question, answer, status, cost_usd: cost, at };
    session.consults.push(c);
    this.#db
      .prepare("INSERT INTO consultations (id, project, from_agent, to_agent, question, answer, status, cost_usd, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(c.id, c.project, c.from, c.to, c.question, c.answer, c.status, c.cost_usd, c.at);
    this.#journal.append({ project: session.project, actor: { kind: "system" }, type: "team.consulted", subject: id, payload: { from: c.from, to: c.to, status, cost_usd: cost } });
    if (status === "failed") throw new TeamError(answer);
    return `${cap(TEAM_LABELS[to])} répond :\n${answer}`;
  }

  #sweep(): void {
    const now = Date.now();
    for (const [k, s] of this.#sessions) if (s.expires < now) this.#sessions.delete(k);
  }
}

/** « DA », « Directeur artistique », « art_director »… → l'identifiant de l'équipe. */
export function normalizeAgent(raw: string): TeamAgent | null {
  const s = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/^(le|la|l')\s*/, "")
    .trim();
  if (!s) return null;
  if ((TEAM_AGENTS as readonly string[]).includes(s)) return s as TeamAgent;
  if (/artisti|^da$|art_director|graphi|visuel/.test(s)) return "da";
  if (/son|audio|musi/.test(s)) return "son";
  if (/concep|design/.test(s)) return "concepteur";
  if (/test|qa|qualit/.test(s)) return "testeur";
  if (/direct|chef/.test(s)) return "directeur";
  return null;
}

const TOOL_SPECS: Record<TeamTool, object> = {
  consulter: {
    name: "consulter",
    description:
      "Demande l'avis d'un collègue du studio pendant que tu prépares ta réponse. Il répond avec son propre contexte (état du jeu, dossier de conception, bible visuelle, sons, tests). Le directeur créatif voit l'échange.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", enum: [...TEAM_AGENTS], description: "directeur (état du jeu, chantiers, décisions) · concepteur (game design) · da (direction artistique) · son (sons, musique) · testeur (ce qui a été joué et vérifié)" },
        question: { type: "string", description: "La question précise, autonome : ce que tu veux savoir et pourquoi." },
        contexte: { type: "string", description: "Ce qu'il doit savoir de ta discussion pour répondre (facultatif, court)." },
      },
      required: ["agent", "question"],
    },
  },
  retenir: {
    name: "retenir",
    description:
      "Propose au directeur créatif d'ajouter un souvenir à la mémoire du studio : une préférence, un refus ou une règle durable qu'il vient d'exprimer, valable pour tous ses jeux. Il valide d'un clic ; rien n'entre sans lui.",
    inputSchema: {
      type: "object",
      properties: {
        souvenir: { type: "string", description: "Une phrase claire et générale, à la 3e personne (« Il veut… », « Jamais de… »), 400 caractères au plus." },
        pourquoi: { type: "string", description: "Ce qu'il a dit qui le montre." },
      },
      required: ["souvenir"],
    },
  },
  lire_fichier: {
    name: "lire_fichier",
    description: "Lit un fichier texte du jeu (lecture seule), 400 lignes au plus à la fois, numérotées.",
    inputSchema: { type: "object", properties: { chemin: { type: "string", description: "Chemin relatif à la racine du jeu, ex. scripts/player.gd" }, debut: { type: "number" }, lignes: { type: "number" } }, required: ["chemin"] },
  },
  lister: {
    name: "lister",
    description: "Liste un dossier du jeu (un niveau).",
    inputSchema: { type: "object", properties: { dossier: { type: "string", description: "Relatif à la racine du jeu ; vide = racine" } } },
  },
  chercher: {
    name: "chercher",
    description: "Cherche un mot ou une expression régulière (sans casse) dans les fichiers texte du jeu ; renvoie fichier:ligne.",
    inputSchema: { type: "object", properties: { motif: { type: "string" }, dossier: { type: "string" } }, required: ["motif"] },
  },
};

/** Les consignes ajoutées à l'agent : seulement les outils qu'il a. */
export function teamPrompt(agent: TeamAgent, tools: TeamTool[]): string {
  const lines: string[] = [];
  if (tools.includes("consulter")) {
    const others = TEAM_AGENTS.filter((a) => a !== agent)
      .map((a) => `${a} (${TEAM_LABELS[a]})`)
      .join(", ");
    lines.push(
      `- consulter : demande l'avis d'un collègue — ${others}. Fais-le quand sa réponse change vraiment la tienne et qu'elle n'est pas déjà dans ton contexte (ex. le DA sur la faisabilité d'un style, le Concepteur sur l'intention d'une mécanique, le Testeur sur ce qui casse). Pas pour la forme : ${MAX_CONSULTS} au plus par réponse. Dans ta réponse, dis en une phrase ce que tu en retiens ; le directeur créatif voit l'échange complet.`,
    );
  }
  if (tools.includes("retenir")) {
    lines.push(
      "- retenir : quand le directeur créatif exprime une préférence, un refus ou une règle DURABLE, valable pour tous ses jeux (goût, exigence de qualité, façon de travailler), propose-la pour la mémoire du studio. Pas un détail de ce jeu, pas ce qui est déjà dans <memoire_du_studio>. Il valide d'un clic.",
    );
  }
  if (tools.some((t) => READ_TOOLS.includes(t))) {
    lines.push("- lire_fichier, lister, chercher : lis le jeu (lecture seule) pour vérifier avant d'affirmer quelque chose sur le code ou les fichiers. Cherche d'abord, puis lis seulement les passages utiles.");
  }
  return `<outils_de_l_equipe>\nTu fais partie d'une équipe d'agents. Outils du hub :\n${lines.join("\n")}\n</outils_de_l_equipe>`;
}

/** Les encarts ajoutés à la fin d'un message : une ligne JSON par consultation et par souvenir proposé. */
export function renderMarks(consults: Consultation[], memories: Memory[]): string {
  return [
    ...consults.map((c) => `${CONSULT_MARK}${JSON.stringify({ from: c.from, to: c.to, question: c.question, answer: c.answer, ok: c.status === "ok" })}`),
    ...memories.map((m) => `${MEMORY_MARK}${JSON.stringify({ id: m.id, text: m.text })}`),
  ].join("\n");
}

/** Ajoute les encarts d'un tour à un texte (rien si aucun). */
export function withMarks(text: string, turn: TeamTurn | null): string {
  const marks = turn?.marks() ?? "";
  return marks ? `${text}\n\n${marks}` : text;
}

/**
 * Pour relire une discussion (historique d'un agent, extraction) : chaque encart devient une ligne courte et lisible,
 * l'agent se souvient de ce qu'un collègue lui a dit sans relire le JSON complet.
 */
export function compactMarks(text: string): string {
  if (!text.includes(CONSULT_MARK) && !text.includes(MEMORY_MARK)) return text;
  return text
    .split("\n")
    .map((line) => {
      try {
        if (line.startsWith(CONSULT_MARK)) {
          const c = JSON.parse(line.slice(CONSULT_MARK.length)) as { to: TeamAgent; question: string; answer: string };
          return `[Consultation — ${TEAM_LABELS[c.to] ?? c.to} a été consulté. Question : ${c.question.slice(0, 200)} — Réponse : ${c.answer.replace(/\s+/g, " ").slice(0, 600)}]`;
        }
        if (line.startsWith(MEMORY_MARK)) {
          const m = JSON.parse(line.slice(MEMORY_MARK.length)) as { text: string };
          return `[Souvenir proposé pour la mémoire du studio : ${m.text}]`;
        }
      } catch {
        return "";
      }
      return line;
    })
    .join("\n");
}

type Row = Record<string, unknown>;
const toConsultation = (r: Row): Consultation => ({
  id: String(r.id),
  project: (r.project as string | null) ?? null,
  from: r.from_agent as TeamAgent,
  to: r.to_agent as TeamAgent,
  question: String(r.question),
  answer: String(r.answer),
  status: r.status as Consultation["status"],
  cost_usd: r.cost_usd == null ? null : Number(r.cost_usd),
  at: String(r.at),
});

const esc = (s: string) => s.replace(/</g, "‹").replace(/>/g, "›");
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
