import { assertHumanSession, type HumanSession } from "../auth/human-session.ts";
import type { Clock } from "../clock.ts";
import type { ConversationService } from "../conversation/conversation-service.ts";
import type { Db } from "../db/database.ts";
import type { Journal } from "../journal/journal.ts";
import type { ProjectRegistry } from "../projects/project-registry.ts";
import type { VcsPort } from "../vcs/git.ts";
import { godotImport } from "../godot/run.ts";
import { describeSim, godotSims, type SimSummary } from "../godot/sim.ts";
import { isGodot, type GodotInstall } from "../godot/toolchain.ts";
import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * L'équilibreur (ADR-86) : le hub joue des centaines de parties sans écran avec les simulations du jeu
 * (tests/sims/sim_*.gd), garde les distributions, les compare au passage précédent, et les confie au directeur sur
 * votre demande. Aucun modèle ne joue : ce sont des chiffres.
 */

export class BalanceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BalanceError";
  }
}

export type SimRun = { id: number; at: string; commit: string | null; runs: number; status: "running" | "done" | "failed"; sims: SimSummary[]; error: string | null };
export type BalanceState = { available: boolean; hasSims: boolean; running: boolean; latest: SimRun | null; previous: SimRun | null; history: { id: number; at: string; commit: string | null; status: string }[] };

type Runner = (cwd: string, runs: number) => Promise<{ sims: SimSummary[]; errors: string[] }>;

export class BalanceService {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #journal: Journal;
  readonly #projects: ProjectRegistry;
  readonly #vcs: VcsPort;
  readonly #conversations: ConversationService;
  readonly #background = new Set<Promise<unknown>>();
  /** Remplaçable dans les tests : jouer `runs` parties de chaque simulation du jeu de `cwd`. */
  runner: Runner;

  constructor(deps: { db: Db; clock: Clock; journal: Journal; projects: ProjectRegistry; vcs: VcsPort; conversations: ConversationService; godot: () => GodotInstall | null }) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#journal = deps.journal;
    this.#projects = deps.projects;
    this.#vcs = deps.vcs;
    this.#conversations = deps.conversations;
    this.runner = async (cwd, runs) => {
      const godot = deps.godot();
      if (!godot) throw new BalanceError("Godot introuvable sur ce PC");
      const imported = await godotImport(godot.exe, cwd);
      if (imported.status === "fail") throw new BalanceError(`Le projet ne s'importe pas : ${imported.detail.slice(0, 300)}`);
      return godotSims(godot.exe, cwd, { runs });
    };
  }

  #rows(project: string, limit: number): SimRun[] {
    const rows = this.#db.prepare("SELECT * FROM sim_runs WHERE project = ? ORDER BY id DESC LIMIT ?").all(project, limit) as {
      id: number;
      at: string;
      commit_sha: string | null;
      runs: number;
      status: SimRun["status"];
      data_json: string;
      error: string | null;
    }[];
    return rows.map((r) => ({ id: r.id, at: r.at, commit: r.commit_sha, runs: r.runs, status: r.status, sims: JSON.parse(r.data_json) as SimSummary[], error: r.error }));
  }

  state(project: string): BalanceState {
    const root = this.#projects.get(project).root;
    const rows = this.#rows(project, 10);
    const done = rows.filter((r) => r.status === "done");
    return {
      available: isGodot(root),
      hasSims: existsSync(join(root, "tests", "sims")),
      running: rows[0]?.status === "running",
      latest: rows[0] ?? null,
      previous: done.find((r) => r.id !== rows[0]?.id) ?? null,
      history: rows.map((r) => ({ id: r.id, at: r.at, commit: r.commit, status: r.status })),
    };
  }

  /** « Jouer N parties » : en arrière-plan, sur la version actuelle du jeu. */
  start(session: HumanSession, project: string, runs = 200): BalanceState {
    assertHumanSession(session);
    const root = this.#projects.get(project).root;
    if (!isGodot(root)) throw new BalanceError("L'équilibreur joue les jeux Godot (simulations tests/sims/sim_*.gd)");
    if (this.state(project).running) return this.state(project);
    const n = Math.max(10, Math.min(2000, Math.round(runs)));
    const id = Number(this.#db.prepare("INSERT INTO sim_runs (project, at, runs, status) VALUES (?, ?, ?, 'running')").run(project, this.#clock.now(), n).lastInsertRowid);
    const job = (async () => {
      try {
        const commit = await this.#vcs.head(root).catch(() => null);
        const { sims, errors } = await this.runner(root, n);
        const error = errors.length ? `Le jeu a écrit des erreurs pendant les simulations : ${errors.slice(0, 3).join(" | ")}` : !sims.length ? "Aucune simulation : le développeur doit écrire tests/sims/sim_*.gd (« extends StudioSim »)" : null;
        this.#db.prepare("UPDATE sim_runs SET status = ?, commit_sha = ?, data_json = ?, error = ? WHERE id = ?").run(sims.length ? "done" : "failed", commit, JSON.stringify(sims), error, id);
        this.#journal.append({ project, actor: { kind: "human" }, type: "balance.ran", subject: String(id), payload: { runs: n, sims: sims.length, errors: errors.length } });
      } catch (err) {
        this.#db.prepare("UPDATE sim_runs SET status = 'failed', error = ? WHERE id = ?").run((err as Error).message.slice(0, 500), id);
      }
    })();
    this.#background.add(job);
    void job.finally(() => this.#background.delete(job));
    return this.state(project);
  }

  async idle(): Promise<void> {
    while (this.#background.size) await Promise.allSettled([...this.#background]);
  }

  /** Les chiffres d'un passage, comparés au précédent, en clair. */
  describe(project: string, id?: number): string | null {
    const rows = this.#rows(project, 20).filter((r) => r.status === "done");
    const run = id ? rows.find((r) => r.id === id) : rows[0];
    if (!run) return null;
    const before = rows.find((r) => r.id < run.id) ?? null;
    return run.sims.map((s) => describeSim(s, before?.sims.find((b) => b.name === s.name) ?? null)).join("\n\n");
  }

  /** « Demander au directeur » : les chiffres partent dans une discussion, avec la consigne de proposer des réglages. */
  async send(session: HumanSession, project: string, id: number, question = ""): Promise<{ thread: string }> {
    assertHumanSession(session);
    const text = this.describe(project, id);
    if (!text) throw new BalanceError("Ce passage n'a pas de résultats");
    const run = this.#rows(project, 20).find((r) => r.id === id)!;
    const thread = this.#conversations.createThread(project, "Équilibrage");
    const message = [
      `Le hub a joué ${run.runs} parties de chaque simulation d'équilibrage, sans écran, sur la version ${run.commit?.slice(0, 7) ?? "actuelle"} du jeu (une graine par partie, stratégie de la simulation).`,
      "",
      text,
      "",
      question.trim() || "Lis ces chiffres face à la bible du jeu : qu'est-ce qui est trop facile, trop dur, trop long, trop prévisible ? Propose des réglages précis (quelle valeur, de combien) et ce que tu attends des chiffres après. Si c'est clair, prépare le chantier ; je relancerai l'équilibreur pour vérifier.",
    ].join("\n");
    void this.#conversations.send(project, thread.id, message).catch(() => {});
    this.#journal.append({ project, actor: { kind: "human" }, type: "balance.sent", subject: String(id), payload: { thread: thread.id } });
    return { thread: thread.id };
  }
}
