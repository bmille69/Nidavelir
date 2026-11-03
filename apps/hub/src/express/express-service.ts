import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { assertHumanSession, type HumanSession } from "../auth/human-session.ts";
import type { Clock } from "../clock.ts";
import type { ConversationService } from "../conversation/conversation-service.ts";
import type { Db } from "../db/database.ts";
import { describeTool } from "../executor/claude-code.ts";
import { PolicyEngine, TOOLS_BY_MODE, type Decision } from "../executor/policy-engine.ts";
import type { ExecResult, ExecutorPort } from "../executor/port.ts";
import type { Journal } from "../journal/journal.ts";
import type { OrchestratorPort } from "../orchestrator/port.ts";
import type { ProjectRegistry } from "../projects/project-registry.ts";
import type { UsageService } from "../usage/usage-service.ts";
import type { VcsPort } from "../vcs/git.ts";
import type { ExpressChecker } from "./checker.ts";
import { buildPrompt, CONCEPT_SCHEMA, CONCEPT_SYSTEM, devSystem, fixPrompt, improvePrompt, POLISH_PROMPT, RESULT_SCHEMA, type ExpressConcept } from "./prompts.ts";
import { writeTemplate } from "./template.ts";

export class ExpressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpressError";
  }
}

export type ExpressMode = "eclair" | "soigne";
export type ExpressPhase = "idee" | "code" | "test" | "correction" | "finition" | "amelioration" | "pret";
export type ExpressStatus = "running" | "ready" | "failed" | "cancelled";
export type ExpressEvent = { seq: number; at: string; kind: "phase" | "tool" | "text" | "info" | "error"; text: string };
export type ExpressGame = {
  id: string;
  slug: string;
  title: string;
  idea: string;
  mode: ExpressMode;
  status: ExpressStatus;
  phase: ExpressPhase;
  root: string;
  concept: ExpressConcept | null;
  summary: string | null;
  how_to_play: string | null;
  error: string | null;
  /** Projet du studio créé à partir de ce prototype (« En faire un vrai projet »). */
  project: string | null;
  /** Nombre d'améliorations demandées après la première version. */
  version: number;
  shot: boolean;
  hidden: boolean;
  started_at: string;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
  events: ExpressEvent[];
};

/** Modèle et durée de chaque vitesse : Éclair (Sonnet, environ 5 min), Soigné (Opus, environ 10 min, avec finition). */
const MODES: Record<ExpressMode, { model: string; codeTurns: number; codeMs: number; polish: boolean }> = {
  eclair: { model: "sonnet", codeTurns: 50, codeMs: 7 * 60_000, polish: false },
  soigne: { model: "opus", codeTurns: 70, codeMs: 9 * 60_000, polish: true },
};
const FIX = { turns: 25, ms: 3 * 60_000 };
const POLISH = { turns: 40, ms: 4 * 60_000 };
const IMPROVE = { turns: 40, ms: 6 * 60_000 };
const LIMIT = { five_hour: 0.9, seven_day: 0.97 } as const;
const MAX_EVENTS = 400;

type Active = { gameId: string; runId: string; tokenHash: string; policy: PolicyEngine; cwd: string };
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Le Jeu express (ADR-44) : une idée devient en quelques minutes un petit jeu jouable dans le navigateur, sans plan à
 * valider ni installation. Un dossier neuf dans vos jeux (prototypes/), une fiche de jeu, un passage du développeur, un
 * test dans un navigateur invisible (et une correction si besoin), une finition en mode Soigné. Puis on joue, on
 * l'améliore, ou on en fait un vrai projet du studio.
 */
export class ExpressService {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #journal: Journal;
  readonly #orchestrator: OrchestratorPort;
  readonly #executor: ExecutorPort;
  readonly #vcs: VcsPort;
  readonly #projects: ProjectRegistry;
  readonly #conversations: ConversationService;
  readonly #checker: ExpressChecker;
  readonly #dataDir: string;
  readonly #agentBaseUrl: () => string;
  readonly #events = new Map<string, ExpressEvent[]>();
  readonly #background = new Set<Promise<unknown>>();
  readonly #aborts = new Map<string, AbortController>();
  #active: Active | null = null;
  /** Racine des jeux, donnée par le serveur (comme pour le Concepteur). */
  gamesRoot: string | null = null;
  usage: UsageService | null = null;
  /** Prévenu quand un jeu est prêt ou a échoué (notification sur le téléphone). */
  onFinished: ((g: ExpressGame) => void) | null = null;

  constructor(deps: {
    db: Db;
    clock: Clock;
    journal: Journal;
    orchestrator: OrchestratorPort;
    executor: ExecutorPort;
    vcs: VcsPort;
    projects: ProjectRegistry;
    conversations: ConversationService;
    checker: ExpressChecker;
    dataDir: string;
    agentBaseUrl: () => string;
  }) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#journal = deps.journal;
    this.#orchestrator = deps.orchestrator;
    this.#executor = deps.executor;
    this.#vcs = deps.vcs;
    this.#projects = deps.projects;
    this.#conversations = deps.conversations;
    this.#checker = deps.checker;
    this.#dataDir = deps.dataDir;
    this.#agentBaseUrl = deps.agentBaseUrl;
    // Un jeu interrompu par un redémarrage du hub n'est plus en cours.
    this.#db.prepare("UPDATE express_games SET status = 'failed', error = 'Interrompu par un redémarrage du hub', finished_at = updated_at WHERE status = 'running'").run();
  }

  list(): ExpressGame[] {
    return (this.#db.prepare("SELECT * FROM express_games WHERE hidden = 0 ORDER BY created_at DESC").all() as Row[]).map((r) => this.#row(r));
  }

  get(id: string): ExpressGame {
    const r = this.#db.prepare("SELECT * FROM express_games WHERE id = ?").get(id) as Row | undefined;
    if (!r) throw new ExpressError("Jeu express introuvable");
    return this.#row(r);
  }

  running(): ExpressGame | null {
    const r = this.#db.prepare("SELECT * FROM express_games WHERE status = 'running' LIMIT 1").get() as Row | undefined;
    return r ? this.#row(r) : null;
  }

  shotPath(id: string): string {
    return join(this.#dataDir, "express", `${id}.png`);
  }

  /** Lance un jeu express. Refusé si un autre tourne, ou si l'abonnement est presque épuisé (mieux qu'un échec en pleine démonstration). */
  create(session: HumanSession, idea: string, mode: ExpressMode): ExpressGame {
    assertHumanSession(session);
    const text = idea.trim();
    if (text.length < 3) throw new ExpressError("Décrivez votre idée en quelques mots");
    if (!this.gamesRoot) throw new ExpressError("Dossier des jeux inconnu");
    if (this.running()) throw new ExpressError("Un jeu express est déjà en cours : attendez qu'il soit prêt");
    this.#assertQuota();
    const id = randomUUID().slice(0, 8);
    const now = this.#clock.now();
    this.#db
      .prepare(
        "INSERT INTO express_games (id, slug, title, idea, mode, status, phase, root, concept_json, summary, how_to_play, error, project, version, shot, hidden, started_at, finished_at, created_at, updated_at, events_json) VALUES (?, '', ?, ?, ?, 'running', 'idee', '', NULL, NULL, NULL, NULL, NULL, 0, 0, 0, ?, NULL, ?, ?, '[]')",
      )
      .run(id, "Nouveau jeu", text.slice(0, 4000), mode, now, now, now);
    this.#journal.append({ project: null, actor: { kind: "human" }, type: "express.started", subject: id, payload: { mode } });
    this.#event(id, "phase", "Idée : le Concepteur express imagine le jeu…");
    this.#track(this.#build(id));
    return this.get(id);
  }

  /** « Améliorer » : une demande en une phrase, une nouvelle version en quelques minutes. */
  improve(session: HumanSession, id: string, request: string): ExpressGame {
    assertHumanSession(session);
    const g = this.get(id);
    if (g.status === "running") throw new ExpressError("Ce jeu est déjà en cours de fabrication");
    if (!g.concept || !existsSync(g.root)) throw new ExpressError("Ce jeu n'a pas de première version à améliorer");
    if (this.running()) throw new ExpressError("Un jeu express est déjà en cours : attendez qu'il soit prêt");
    const ask = request.trim();
    if (ask.length < 3) throw new ExpressError("Dites ce que vous voulez changer");
    this.#assertQuota();
    this.#update(id, { status: "running", phase: "amelioration", error: null, started_at: this.#clock.now(), finished_at: null });
    this.#event(id, "phase", `Amélioration : « ${ask.slice(0, 200)} »`);
    this.#track(this.#improve(id, ask));
    return this.get(id);
  }

  cancel(id: string): void {
    this.#aborts.get(id)?.abort();
  }

  hide(session: HumanSession, id: string): void {
    assertHumanSession(session);
    if (this.get(id).status === "running") throw new ExpressError("Arrêtez d'abord la fabrication");
    this.#db.prepare("UPDATE express_games SET hidden = 1 WHERE id = ?").run(id);
  }

  /** « En faire un vrai projet » : le prototype entre dans le studio (mode Atelier), et le directeur propose la suite. */
  async promote(session: HumanSession, id: string): Promise<{ project: string; thread: string }> {
    assertHumanSession(session);
    const g = this.get(id);
    if (g.status !== "ready") throw new ExpressError("Le jeu doit être prêt");
    if (g.project) throw new ExpressError(`C'est déjà un projet du studio : ${g.project}`);
    const taken = new Set(this.#projects.list().map((p) => p.slug));
    let slug = g.slug;
    for (let i = 2; taken.has(slug); i++) slug = `${g.slug}-${i}`;
    const project = await this.#projects.register(session, { path: g.root, slug, name: g.title, initGit: true });
    this.#update(id, { project: project.slug });
    const thread = this.#conversations.createThread(project.slug, "Suite du jeu express", "express");
    const text = [
      `Ce jeu vient du Jeu express : une première version faite en quelques minutes (JavaScript pur, sans outils de construction).`,
      g.concept ? `Le principe : ${g.concept.pitch}` : "",
      "Je veux en faire un vrai projet. Propose les premiers chantiers : d'abord le passer sur Vite avec des tests (pour que le studio puisse le lancer et le vérifier), puis ce qui rendrait le jeu meilleur.",
    ]
      .filter(Boolean)
      .join("\n\n");
    void this.#conversations.send(project.slug, thread.id, text).catch(() => {});
    this.#journal.append({ project: project.slug, actor: { kind: "human" }, type: "express.promoted", subject: id, payload: {} });
    return { project: project.slug, thread: thread.id };
  }

  async idle(): Promise<void> {
    while (this.#background.size) await Promise.allSettled([...this.#background]);
  }

  // ── Pont de l'agent (mêmes règles que les chantiers ; le gardien refuse ce qui est interdit) ──

  owns(runId: string): boolean {
    return runId.startsWith("XRUN-");
  }

  agentPreTool(runId: string, token: string, tool: string, input: Record<string, unknown>, cwd?: string): Decision {
    const a = this.#auth(runId, token);
    if (cwd) a.cwd = cwd;
    const d = a.policy.evaluate(tool, input, a.cwd);
    if (d.decision === "deny") this.#event(a.gameId, "info", `Refusé par le gardien : ${describeTool(tool, input)} (${d.reason})`);
    return d;
  }

  /** Hors plan mais sans danger, dans le dossier du prototype : on laisse travailler (il n'y a pas de plan en express). */
  async agentPermission(runId: string, token: string, tool: string, input: Record<string, unknown>): Promise<{ behavior: "allow" | "deny"; message?: string }> {
    const a = this.#auth(runId, token);
    const d = a.policy.evaluate(tool, input, a.cwd);
    return d.decision === "deny" ? { behavior: "deny", message: `Refusé par le hub : ${d.reason}` } : { behavior: "allow" };
  }

  // ── Fabrication ──

  async #build(id: string): Promise<void> {
    const abort = new AbortController();
    this.#aborts.set(id, abort);
    try {
      const g = this.get(id);
      const { data } = await this.#orchestrator.structured({
        systemPrompt: CONCEPT_SYSTEM,
        prompt: `Idée du directeur créatif :\n${g.idea}`,
        jsonSchema: CONCEPT_SCHEMA,
        meta: { project: null, agent: "express" },
      });
      const concept = normalizeConcept(data);
      if (abort.signal.aborted) throw new ExpressError("Arrêté");
      const slug = this.#freeSlug(slugify(concept.title));
      const root = join(this.gamesRoot!, "prototypes", slug);
      mkdirSync(root, { recursive: true });
      writeTemplate(root, concept);
      await this.#vcs.init(root);
      await this.#vcs.commitPaths(root, ["."], `express: modèle de départ de « ${concept.title} »`);
      this.#update(id, { slug, title: concept.title, root, concept_json: JSON.stringify(concept), phase: "code" });
      this.#event(id, "info", `${concept.title} : ${concept.pitch}`);
      this.#event(id, "phase", `Code : le développeur écrit le jeu (${concept.dimension === "3d" ? "3D" : "2D"})…`);

      const mode = MODES[g.mode];
      const first = await this.#run(id, root, devSystem(concept.dimension), buildPrompt(concept), mode.model, mode.codeTurns, mode.codeMs, abort.signal);
      await this.#vcs.commitPaths(root, ["."], `express: première version de « ${concept.title} »`);
      let report = first;
      report = await this.#testAndFix(id, root, concept, mode.model, abort.signal, report);
      if (mode.polish) {
        this.#update(id, { phase: "finition" });
        this.#event(id, "phase", "Finition : sensations de jeu, équilibrage, écrans…");
        report = (await this.#run(id, root, devSystem(concept.dimension), POLISH_PROMPT, mode.model, POLISH.turns, POLISH.ms, abort.signal).catch((err: Error) => {
          // La finition est un bonus : si elle échoue, la première version reste jouable.
          this.#event(id, "error", `Finition interrompue : ${err.message.slice(0, 200)}`);
          return null;
        })) ?? report;
        await this.#vcs.commitPaths(root, ["."], `express: finition de « ${concept.title} »`);
        report = await this.#testAndFix(id, root, concept, mode.model, abort.signal, report);
      }
      this.#finish(id, report);
    } catch (err) {
      this.#fail(id, err as Error, abort.signal.aborted);
    } finally {
      this.#aborts.delete(id);
    }
  }

  async #improve(id: string, request: string): Promise<void> {
    const abort = new AbortController();
    this.#aborts.set(id, abort);
    try {
      const g = this.get(id);
      const concept = g.concept!;
      let report = await this.#run(id, g.root, devSystem(concept.dimension), improvePrompt(request), "sonnet", IMPROVE.turns, IMPROVE.ms, abort.signal);
      await this.#vcs.commitPaths(g.root, ["."], `express: amélioration — ${request.slice(0, 120)}`);
      report = await this.#testAndFix(id, g.root, concept, "sonnet", abort.signal, report);
      this.#update(id, { version: g.version + 1 });
      this.#finish(id, report);
    } catch (err) {
      this.#fail(id, err as Error, abort.signal.aborted);
    } finally {
      this.#aborts.delete(id);
    }
  }

  /** Test dans un navigateur invisible ; en cas d'erreur, une seule correction, puis un nouveau test. */
  async #testAndFix(id: string, root: string, concept: ExpressConcept, model: string, signal: AbortSignal, report: Report | null): Promise<Report | null> {
    this.#update(id, { phase: "test" });
    this.#event(id, "phase", "Test : le hub ouvre le jeu dans un navigateur et appuie sur quelques touches…");
    let check = await this.#check(id, root);
    if (check.ok) return report;
    this.#event(id, "error", `Problèmes relevés : ${check.errors.join(" | ").slice(0, 600)}`);
    this.#update(id, { phase: "correction" });
    this.#event(id, "phase", "Correction : le développeur corrige les erreurs relevées…");
    const fixed = await this.#run(id, root, devSystem(concept.dimension), fixPrompt(check.errors), model, FIX.turns, FIX.ms, signal);
    await this.#vcs.commitPaths(root, ["."], `express: correction de « ${concept.title} »`);
    this.#update(id, { phase: "test" });
    this.#event(id, "phase", "Test : nouvel essai…");
    check = await this.#check(id, root);
    if (!check.ok) this.#event(id, "error", `Il reste des erreurs : ${check.errors.join(" | ").slice(0, 600)}. Le jeu est jouable en l'état ; « Améliorer » peut les corriger.`);
    return fixed ?? report;
  }

  async #check(id: string, root: string) {
    mkdirSync(join(this.#dataDir, "express"), { recursive: true });
    const r = await this.#checker.check(root, this.shotPath(id));
    if (r.screenshot) this.#update(id, { shot: 1 });
    this.#event(id, r.ok ? "info" : "error", r.ok ? "Le jeu se charge et réagit, sans erreur." : `${r.errors.length} problème(s) relevé(s).`);
    return r;
  }

  async #run(id: string, root: string, systemPrompt: string, prompt: string, model: string, maxTurns: number, ms: number, signal: AbortSignal): Promise<Report | null> {
    const runId = `XRUN-${randomUUID().slice(0, 8)}`;
    const token = randomBytes(32).toString("base64url");
    const policy = new PolicyEngine({ mode: "execute", root });
    this.#active = { gameId: id, runId, tokenHash: sha256(token), policy, cwd: root };
    // Chaque passage a son chrono : au-delà, on garde ce qui est écrit et on passe au test.
    const local = new AbortController();
    const timer = setTimeout(() => local.abort(), ms);
    const relay = () => local.abort();
    signal.addEventListener("abort", relay, { once: true });
    const strip = (s: string) => s.split(root).join("").split(root.replace(/\\/g, "/")).join("").replace(/^[\\/]/, "");
    let result: ExecResult | null = null;
    try {
      result = await this.#executor.run({
        kind: "execute",
        runId,
        cwd: root,
        runDir: join(this.#dataDir, "runs", runId),
        systemPrompt,
        prompt,
        jsonSchema: RESULT_SCHEMA,
        tools: TOOLS_BY_MODE.execute,
        maxTurns,
        model,
        bridge: { preTool: async (tool, input) => this.agentPreTool(runId, token, tool, input), permission: (tool, input) => this.agentPermission(runId, token, tool, input) },
        bridgeUrl: `${this.#agentBaseUrl()}/${runId}`,
        token,
        onEvent: (type, text) => {
          if (type === "tool") this.#event(id, "tool", strip(text));
          else if (type === "text") this.#event(id, "text", text.slice(0, 400));
          else if (type === "error") this.#event(id, "error", text.slice(0, 300));
        },
        signal: local.signal,
      });
      this.usage?.record({ project: null, agent: "express", model: result.model ?? model, tokens: result.tokens ?? null, costUsd: result.costUsd, limits: result.limits });
      return toReport(result.structured);
    } catch (err) {
      if (signal.aborted) throw new ExpressError("Arrêté par vous");
      if (local.signal.aborted) {
        this.#event(id, "info", `Temps écoulé (${Math.round(ms / 60_000)} min) : on garde ce qui est écrit.`);
        return null;
      }
      throw err;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", relay);
      this.#active = null;
    }
  }

  #finish(id: string, report: Report | null): void {
    const g = this.get(id);
    const now = this.#clock.now();
    this.#update(id, {
      status: "ready",
      phase: "pret",
      summary: report?.summary ?? g.summary,
      how_to_play: report?.how_to_play ?? g.how_to_play ?? g.concept?.controls.join(" ; ") ?? null,
      finished_at: now,
    });
    const seconds = Math.round((Date.parse(now) - Date.parse(g.started_at)) / 1000);
    this.#event(id, "phase", `Jouable ! (${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, "0")} s)`);
    this.#journal.append({ project: null, actor: { kind: "system" }, type: "express.ready", subject: id, payload: { title: g.title, seconds } });
    this.#persistEvents(id);
    this.#notify(id);
  }

  #fail(id: string, err: Error, cancelled: boolean): void {
    this.#update(id, { status: cancelled ? "cancelled" : "failed", error: err.message.slice(0, 600), finished_at: this.#clock.now() });
    this.#event(id, "error", cancelled ? "Arrêté." : `Échec : ${err.message.slice(0, 300)}`);
    this.#journal.append({ project: null, actor: { kind: "system" }, type: cancelled ? "express.cancelled" : "express.failed", subject: id, payload: { error: err.message.slice(0, 300) } });
    this.#persistEvents(id);
    if (!cancelled) this.#notify(id);
  }

  #notify(id: string): void {
    try {
      this.onFinished?.(this.get(id));
    } catch {
      /* un observateur ne doit jamais casser la fabrication */
    }
  }

  #assertQuota(): void {
    const limits = this.usage?.snapshot().limits;
    for (const w of ["five_hour", "seven_day"] as const) {
      const win = limits?.windows[w];
      if (win && win.utilization >= LIMIT[w] && Date.parse(win.resetsAt) > Date.parse(this.#clock.now())) {
        const at = new Date(win.resetsAt).toLocaleString("fr-FR", { weekday: w === "seven_day" ? "long" : undefined, hour: "2-digit", minute: "2-digit" });
        throw new ExpressError(`Abonnement presque épuisé (${Math.round(win.utilization * 100)} %) : le jeu express risquerait de s'arrêter en route. Réessayez après ${at}.`);
      }
    }
  }

  #auth(runId: string, token: string): Active {
    const a = this.#active;
    if (!a || a.runId !== runId || sha256(token) !== a.tokenHash) throw new ExpressError("Run inconnu, terminé ou jeton invalide");
    return a;
  }

  #freeSlug(base: string): string {
    const used = new Set([...(this.#db.prepare("SELECT slug FROM express_games").all() as { slug: string }[]).map((r) => r.slug), ...this.#projects.list().map((p) => p.slug)]);
    for (let i = 1; ; i++) {
      const slug = i === 1 ? base : `${base}-${i}`;
      if (!used.has(slug) && !existsSync(join(this.gamesRoot!, "prototypes", slug))) return slug;
    }
  }

  #event(id: string, kind: ExpressEvent["kind"], text: string): void {
    const list = this.#events.get(id) ?? this.#stored(id);
    list.push({ seq: (list.at(-1)?.seq ?? 0) + 1, at: this.#clock.now(), kind, text });
    if (list.length > MAX_EVENTS) list.splice(0, list.length - MAX_EVENTS);
    this.#events.set(id, list);
  }

  #stored(id: string): ExpressEvent[] {
    const r = this.#db.prepare("SELECT events_json FROM express_games WHERE id = ?").get(id) as { events_json: string } | undefined;
    try {
      return r ? (JSON.parse(r.events_json) as ExpressEvent[]) : [];
    } catch {
      return [];
    }
  }

  #persistEvents(id: string): void {
    this.#db.prepare("UPDATE express_games SET events_json = ? WHERE id = ?").run(JSON.stringify(this.#events.get(id) ?? []), id);
  }

  #update(id: string, fields: Record<string, string | number | null>): void {
    const keys = Object.keys(fields);
    this.#db.prepare(`UPDATE express_games SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => fields[k]!), this.#clock.now(), id);
  }

  #track(p: Promise<unknown>): void {
    this.#background.add(p);
    void p.finally(() => this.#background.delete(p));
  }

  #row(r: Row): ExpressGame {
    return {
      id: r.id,
      slug: r.slug,
      title: r.title,
      idea: r.idea,
      mode: r.mode as ExpressMode,
      status: r.status as ExpressStatus,
      phase: r.phase as ExpressPhase,
      root: r.root,
      concept: r.concept_json ? (JSON.parse(r.concept_json) as ExpressConcept) : null,
      summary: r.summary,
      how_to_play: r.how_to_play,
      error: r.error,
      project: r.project,
      version: r.version,
      shot: !!r.shot,
      hidden: !!r.hidden,
      started_at: r.started_at,
      finished_at: r.finished_at,
      created_at: r.created_at,
      updated_at: r.updated_at,
      events: this.#events.get(r.id) ?? this.#stored(r.id),
    };
  }
}

type Row = {
  id: string;
  slug: string;
  title: string;
  idea: string;
  mode: string;
  status: string;
  phase: string;
  root: string;
  concept_json: string | null;
  summary: string | null;
  how_to_play: string | null;
  error: string | null;
  project: string | null;
  version: number;
  shot: number;
  hidden: number;
  started_at: string;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
  events_json: string;
};

type Report = { summary: string; how_to_play: string; known_issues: string[] };

function toReport(v: unknown): Report | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  return { summary: String(o.summary ?? "").slice(0, 600), how_to_play: String(o.how_to_play ?? "").slice(0, 300), known_issues: Array.isArray(o.known_issues) ? o.known_issues.map(String).slice(0, 5) : [] };
}

function normalizeConcept(v: unknown): ExpressConcept {
  const o = (v ?? {}) as Record<string, unknown>;
  const str = (k: string, max: number, fallback = "") => (typeof o[k] === "string" && (o[k] as string).trim() ? (o[k] as string).trim().slice(0, max) : fallback);
  const arr = (k: string, max: number) => (Array.isArray(o[k]) ? (o[k] as unknown[]).map(String).filter(Boolean).slice(0, max) : []);
  const title = str("title", 40);
  if (!title) throw new ExpressError("Le Concepteur express n'a pas rendu de fiche exploitable");
  return {
    title,
    pitch: str("pitch", 220),
    dimension: o.dimension === "3d" ? "3d" : "2d",
    genre: str("genre", 60, "arcade"),
    controls: arr("controls", 6),
    loop: str("loop", 500),
    goal: str("goal", 220),
    style: str("style", 320),
    features: arr("features", 6),
    juice: arr("juice", 4),
  };
}

export function slugify(title: string): string {
  return (
    title
      .replace(/œ/gi, "oe")
      .replace(/æ/gi, "ae")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40)
      .replace(/-$/, "") || "jeu-express"
  );
}
