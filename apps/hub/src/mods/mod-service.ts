import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { assertHumanSession, type HumanSession } from "../auth/human-session.ts";
import type { Clock } from "../clock.ts";
import type { Db } from "../db/database.ts";
import { describeTool } from "../executor/claude-code.ts";
import { PolicyEngine, TOOLS_BY_MODE, type Decision } from "../executor/policy-engine.ts";
import type { ExecResult, ExecutorPort } from "../executor/port.ts";
import type { Journal } from "../journal/journal.ts";
import type { OrchestratorPort } from "../orchestrator/port.ts";
import { detectGame } from "../reverse/detect.ts";
import type { UsageService } from "../usage/usage-service.ts";
import type { VcsPort } from "../vcs/git.ts";
import { backupSaves, install, readLog, uninstall, type Installed, type LogReport } from "./installer.ts";
import { buildPrompt, devSystem, fixBuildPrompt, fixLogPrompt, improvePrompt, PLAN_SCHEMA, PLAN_SYSTEM, rebuildPrompt, RESULT_SCHEMA, type ModPlan } from "./prompts.ts";
import { matches, modName, recipe, recipeFor, type GameRecipe } from "./recipes.ts";
import { gameBuild, installedGames, type SteamGame } from "./steam.ts";
import type { ToolchainPort, ToolchainState } from "./toolchain.ts";

export class ModError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModError";
  }
}

export type ModStatus = "planning" | "waiting" | "running" | "ready" | "failed" | "cancelled";
export type ModEvent = { seq: number; at: string; kind: "phase" | "tool" | "text" | "info" | "error"; text: string };
export type ModReport = { summary: string; how_to_test: string; settings: string[]; known_issues: string[] };
export type Mod = {
  id: string;
  recipe: string;
  appid: string;
  game: string;
  game_dir: string;
  name: string;
  title: string;
  idea: string;
  status: ModStatus;
  phase: string;
  root: string;
  plan: ModPlan | null;
  report: ModReport | null;
  /** Version du jeu (buildid Steam) au moment de la construction. */
  game_build: string | null;
  /** Le jeu a été mis à jour depuis la construction : le mod peut casser. */
  outdated: boolean;
  installed: Installed | null;
  played: (LogReport & { at: string }) | null;
  error: string | null;
  version: number;
  created_at: string;
  updated_at: string;
  events: ModEvent[];
};

/** Un jeu installé, vu par le studio de modding : pris en charge (recette) ou pas, protégé ou pas, et son outillage. */
export type ModGame = {
  appid: string;
  name: string;
  dir: string;
  buildid: string;
  recipe: { id: string; name: string; warnings: string[]; loader: { name: string; version: string; size: string; firstRun: string } } | null;
  protection: string | null;
  toolchain: ToolchainState | null;
};

const CODE = { turns: 60, ms: 12 * 60_000 };
const FIX = { turns: 30, ms: 6 * 60_000 };
const LIMIT = { five_hour: 0.9, seven_day: 0.97 } as const;
const MAX_EVENTS = 400;

type Active = { modId: string; runId: string; tokenHash: string; policy: PolicyEngine; cwd: string; root: string; recipe: GameRecipe };
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Le studio de modding (ADR-65) : un mod pour un jeu du commerce que vous possédez, décrit en français. Le Concepteur de
 * mods en fait un plan clair ; le développeur l'écrit dans un dossier à lui (jamais dans le jeu) et le construit ; le hub
 * le vérifie, l'installe sur votre clic, lit le journal du jeu après vos parties et le corrige. Une recette par jeu.
 */
export class ModService {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #journal: Journal;
  readonly #orchestrator: OrchestratorPort;
  readonly #executor: ExecutorPort;
  readonly #vcs: VcsPort;
  readonly #toolchain: ToolchainPort;
  readonly #dataDir: string;
  readonly #agentBaseUrl: () => string;
  readonly #steam: () => SteamGame[];
  readonly #events = new Map<string, ModEvent[]>();
  readonly #background = new Set<Promise<unknown>>();
  readonly #aborts = new Map<string, AbortController>();
  #active: Active | null = null;
  gamesRoot: string | null = null;
  usage: UsageService | null = null;
  /** Prévenu quand un mod est prêt ou a échoué (notification sur le téléphone). */
  onFinished: ((m: Mod) => void) | null = null;

  constructor(deps: {
    db: Db;
    clock: Clock;
    journal: Journal;
    orchestrator: OrchestratorPort;
    executor: ExecutorPort;
    vcs: VcsPort;
    toolchain: ToolchainPort;
    dataDir: string;
    agentBaseUrl: () => string;
    steam?: () => SteamGame[];
  }) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#journal = deps.journal;
    this.#orchestrator = deps.orchestrator;
    this.#executor = deps.executor;
    this.#vcs = deps.vcs;
    this.#toolchain = deps.toolchain;
    this.#dataDir = deps.dataDir;
    this.#agentBaseUrl = deps.agentBaseUrl;
    this.#steam = deps.steam ?? (() => installedGames());
    // Un travail interrompu par un redémarrage du hub ne tourne plus.
    this.#db.prepare("UPDATE mods SET status = 'failed', error = 'Interrompu par un redémarrage du hub' WHERE status IN ('running', 'planning')").run();
  }

  // ── Les jeux ──

  games(): ModGame[] {
    return this.#steam()
      .map((g) => {
        const r = recipeFor(g.appid);
        const ok = r && matches(r, g.dir) ? r : null;
        let protection: string | null = null;
        try {
          protection = detectGame(g.dir).protection;
        } catch {
          /* lecture impossible : pas de protection connue */
        }
        return {
          appid: g.appid,
          name: g.name,
          dir: g.dir,
          buildid: g.buildid,
          recipe: ok ? { id: ok.id, name: ok.name, warnings: ok.warnings, loader: { name: ok.loader.name, version: ok.loader.version, size: ok.loader.size, firstRun: ok.loader.firstRun } } : null,
          protection,
          toolchain: ok && !protection ? this.#toolchain.state(ok, g.dir) : null,
        };
      })
      .sort((a, b) => Number(!!b.recipe) - Number(!!a.recipe) || a.name.localeCompare(b.name));
  }

  #game(appid: string): { game: SteamGame; recipe: GameRecipe } {
    const game = this.#steam().find((g) => g.appid === appid);
    if (!game) throw new ModError("Jeu introuvable dans vos bibliothèques Steam");
    const r = recipeFor(appid);
    if (!r || !matches(r, game.dir)) throw new ModError(`Le studio ne sait pas encore modder ${game.name}`);
    let protection: string | null = null;
    try {
      protection = detectGame(game.dir).protection;
    } catch {
      /* rien */
    }
    if (protection) throw new ModError(`${game.name} est protégé (${protection}) : le studio ne le modde pas, un bannissement est possible`);
    return { game, recipe: r };
  }

  /** Installer le chargeur de mods dans le jeu : sur votre clic, depuis sa page officielle. */
  installLoader(session: HumanSession, appid: string): void {
    assertHumanSession(session);
    const { game, recipe: r } = this.#game(appid);
    this.#journal.append({ project: null, actor: { kind: "human" }, type: "mods.loader_install", subject: appid, payload: { loader: r.loader.name, version: r.loader.version } });
    this.#track(this.#toolchain.installLoader(r, game.dir).catch(() => {}));
  }

  /** Retirer le chargeur : le jeu redevient exactement comme avant (vos mods posés par le studio sont retirés d'abord). */
  async removeLoader(session: HumanSession, appid: string): Promise<void> {
    assertHumanSession(session);
    const { game, recipe: r } = this.#game(appid);
    for (const m of this.list().filter((x) => x.appid === appid && x.installed)) {
      uninstall(game.dir, m.installed!);
      this.#update(m.id, { installed_json: null });
    }
    await this.#toolchain.removeLoader(r, game.dir);
    this.#journal.append({ project: null, actor: { kind: "human" }, type: "mods.loader_removed", subject: appid, payload: {} });
  }

  /** La carte des types du jeu (après le premier lancement avec le chargeur). */
  buildTypemap(session: HumanSession, appid: string): void {
    assertHumanSession(session);
    const { game, recipe: r } = this.#game(appid);
    this.#track(this.#toolchain.buildTypemap(r, game.dir).catch(() => {}));
  }

  // ── Les mods ──

  list(): Mod[] {
    return (this.#db.prepare("SELECT * FROM mods WHERE hidden = 0 ORDER BY created_at DESC").all() as Row[]).map((r) => this.#row(r));
  }

  get(id: string): Mod {
    const r = this.#db.prepare("SELECT * FROM mods WHERE id = ?").get(id) as Row | undefined;
    if (!r) throw new ModError("Mod introuvable");
    return this.#row(r);
  }

  running(): Mod | null {
    const r = this.#db.prepare("SELECT * FROM mods WHERE status IN ('running', 'planning') LIMIT 1").get() as Row | undefined;
    return r ? this.#row(r) : null;
  }

  /** Une idée de mod : le Concepteur de mods en fait un plan, que vous validez avant toute écriture. */
  create(session: HumanSession, appid: string, idea: string): Mod {
    assertHumanSession(session);
    const text = idea.trim();
    if (text.length < 3) throw new ModError("Décrivez votre mod en quelques mots");
    if (!this.gamesRoot) throw new ModError("Dossier des jeux inconnu");
    const { game, recipe: r } = this.#game(appid);
    this.#assertFree();
    this.#assertQuota();
    const id = randomUUID().slice(0, 8);
    const now = this.#clock.now();
    this.#db
      .prepare(
        "INSERT INTO mods (id, recipe, appid, game, game_dir, name, title, idea, status, phase, root, plan_json, report_json, game_build, installed_json, played_json, error, version, hidden, created_at, updated_at, events_json) VALUES (?, ?, ?, ?, ?, '', 'Nouveau mod', ?, 'planning', 'plan', '', NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, ?, ?, '[]')",
      )
      .run(id, r.id, appid, game.name, game.dir, text.slice(0, 4000), now, now);
    this.#journal.append({ project: null, actor: { kind: "human" }, type: "mods.created", subject: id, payload: { game: game.name } });
    this.#event(id, "phase", "Plan : le Concepteur de mods traduit votre idée en changements concrets…");
    this.#track(this.#plan(id, null));
    return this.get(id);
  }

  /** Vos précisions sur le plan : il est refait. */
  reply(session: HumanSession, id: string, text: string): Mod {
    assertHumanSession(session);
    const m = this.get(id);
    if (m.status !== "waiting") throw new ModError("Le plan n'attend pas de réponse");
    const t = text.trim();
    if (t.length < 2) throw new ModError("Message vide");
    this.#assertFree();
    this.#update(id, { status: "planning", phase: "plan" });
    this.#event(id, "info", `Vous : ${t.slice(0, 400)}`);
    this.#event(id, "phase", "Plan : le Concepteur de mods reprend le plan…");
    this.#track(this.#plan(id, t));
    return this.get(id);
  }

  /** « Fabriquer » : le plan vous va, le développeur écrit et construit le mod. */
  go(session: HumanSession, id: string): Mod {
    assertHumanSession(session);
    const m = this.get(id);
    if (m.status !== "waiting" || !m.plan) throw new ModError("Le plan n'est pas prêt");
    const { game, recipe: r } = this.#game(m.appid);
    this.#assertReady(r, game.dir);
    this.#assertFree();
    this.#assertQuota();
    this.#update(id, { status: "running", phase: "code", error: null });
    this.#event(id, "phase", "Code : le développeur écrit le mod…");
    this.#track(this.#make(id));
    return this.get(id);
  }

  improve(session: HumanSession, id: string, request: string): Mod {
    assertHumanSession(session);
    const m = this.get(id);
    if (m.status !== "ready" && m.status !== "failed") throw new ModError("Le mod n'est pas prêt");
    const ask = request.trim();
    if (ask.length < 3) throw new ModError("Dites ce que vous voulez changer");
    const { game, recipe: r } = this.#game(m.appid);
    this.#assertReady(r, game.dir);
    this.#assertFree();
    this.#assertQuota();
    this.#update(id, { status: "running", phase: "amelioration", error: null });
    this.#event(id, "phase", `Amélioration : « ${ask.slice(0, 200)} »`);
    this.#track(this.#rework(id, improvePrompt(ask), `amélioration — ${ask.slice(0, 100)}`, true));
    return this.get(id);
  }

  /** Après une mise à jour du jeu : reconstruire, et adapter le mod si la construction échoue. */
  rebuild(session: HumanSession, id: string): Mod {
    assertHumanSession(session);
    const m = this.get(id);
    if (m.status === "running" || m.status === "planning") throw new ModError("Le mod est déjà en travail");
    const { game, recipe: r } = this.#game(m.appid);
    this.#assertReady(r, game.dir);
    this.#assertFree();
    this.#update(id, { status: "running", phase: "construction", error: null });
    this.#event(id, "phase", "Reconstruction pour la version actuelle du jeu…");
    this.#track(this.#rebuild(id));
    return this.get(id);
  }

  /** Installer : la DLL (et ses images) dans le dossier des mods du jeu. Vos sauvegardes sont copiées à l'abri la première fois. */
  installMod(session: HumanSession, id: string): Mod {
    assertHumanSession(session);
    const m = this.get(id);
    if (m.status !== "ready") throw new ModError("Le mod n'est pas prêt");
    const { game, recipe: r } = this.#game(m.appid);
    if (m.outdated) throw new ModError("Le jeu a été mis à jour depuis la construction : « Reconstruire » d'abord");
    if (!this.#toolchain.state(r, game.dir).loader.installed) throw new ModError(`${r.loader.name} n'est plus installé dans le jeu`);
    this.#place(m, r, game);
    return this.get(id);
  }

  uninstallMod(session: HumanSession, id: string): Mod {
    assertHumanSession(session);
    const m = this.get(id);
    if (!m.installed) throw new ModError("Ce mod n'est pas installé");
    const { kept } = uninstall(m.game_dir, m.installed);
    this.#update(id, { installed_json: null });
    this.#event(id, "info", kept.length ? `Désinstallé ; laissé car modifié depuis : ${kept.join(", ")}` : "Désinstallé : le dossier des mods du jeu est revenu comme avant.");
    this.#journal.append({ project: null, actor: { kind: "human" }, type: "mods.uninstalled", subject: id, payload: { kept } });
    return this.get(id);
  }

  /** « J'ai joué » : le hub lit le journal du chargeur ; une erreur du mod lance une correction, puis le réinstalle. */
  played(session: HumanSession, id: string, note: string): Mod {
    assertHumanSession(session);
    const m = this.get(id);
    if (!m.installed) throw new ModError("Installez d'abord le mod");
    const { game, recipe: r } = this.#game(m.appid);
    const log = readLog(join(game.dir, r.log), m.name);
    this.#update(id, { played_json: JSON.stringify({ ...log, at: this.#clock.now() }) });
    if (!log.found) {
      this.#event(id, "error", "Pas de journal du chargeur : le jeu a-t-il été lancé depuis l'installation ?");
      return this.get(id);
    }
    if (!log.loaded) this.#event(id, "error", "Le journal ne montre pas le mod : il n'a pas été chargé.");
    else this.#event(id, "info", `Chargé par le jeu. ${log.lines.length} message(s) du mod dans le journal.`);
    const wish = note.trim();
    if (!log.errors.length && log.loaded && !wish) {
      this.#event(id, "phase", "Ça marche : aucune erreur du mod dans le journal.");
      this.#journal.append({ project: null, actor: { kind: "human" }, type: "mods.works", subject: id, payload: {} });
      return this.get(id);
    }
    this.#assertReady(r, game.dir);
    this.#assertFree();
    this.#assertQuota();
    this.#update(id, { status: "running", phase: "correction", error: null });
    if (log.errors.length) this.#event(id, "error", `${log.errors.length} erreur(s) du mod dans le journal : correction…`);
    const prompt = [log.errors.length || !log.loaded ? fixLogPrompt(log.errors.length ? log.errors : ["Le mod n'apparaît pas dans le journal : il n'a pas été chargé."], log.lines) : "", wish ? `Ce que l'utilisateur a remarqué en jouant : ${wish}` : ""].filter(Boolean).join("\n\n");
    this.#track(this.#rework(id, prompt, "correction après une partie", true));
    return this.get(id);
  }

  cancel(id: string): void {
    this.#aborts.get(id)?.abort();
  }

  hide(session: HumanSession, id: string): void {
    assertHumanSession(session);
    const m = this.get(id);
    if (m.status === "running" || m.status === "planning") throw new ModError("Arrêtez d'abord le travail en cours");
    if (m.installed) throw new ModError("Désinstallez d'abord le mod");
    this.#db.prepare("UPDATE mods SET hidden = 1 WHERE id = ?").run(id);
  }

  async idle(): Promise<void> {
    while (this.#background.size) await Promise.allSettled([...this.#background]);
  }

  // ── Pont de l'agent : le gardien juge chaque action ; en plus, le .csproj est intouchable et seule la construction est permise ──

  owns(runId: string): boolean {
    return runId.startsWith("MRUN-");
  }

  #judge(a: Active, tool: string, input: Record<string, unknown>): Decision {
    const d = a.policy.evaluate(tool, input, a.cwd);
    if (d.decision === "deny") return d;
    if (tool === "Write" || tool === "Edit" || tool === "NotebookEdit") {
      const raw = String(input.file_path ?? input.notebook_path ?? "");
      const rel = relative(a.root, raw).replace(/\\/g, "/");
      if (a.recipe.locked.test(rel)) return { decision: "deny", reason: `« ${rel} » est fourni par le hub (la construction l'exécuterait) : modifie seulement le code` };
      return d;
    }
    if (tool === "Bash" && d.decision === "ask") {
      const cmd = String(input.command ?? "").trim();
      return a.recipe.build.some((re) => re.test(cmd)) ? { decision: "allow", reason: "construction du mod" } : { decision: "deny", reason: "seule la construction « dotnet build -c Release » est permise dans un mod" };
    }
    return d;
  }

  agentPreTool(runId: string, token: string, tool: string, input: Record<string, unknown>, cwd?: string): Decision {
    const a = this.#auth(runId, token);
    if (cwd) a.cwd = cwd;
    const d = this.#judge(a, tool, input);
    if (d.decision === "deny") this.#event(a.modId, "info", `Refusé par le gardien : ${describeTool(tool, input)} (${d.reason})`);
    return d;
  }

  async agentPermission(runId: string, token: string, tool: string, input: Record<string, unknown>): Promise<{ behavior: "allow" | "deny"; message?: string }> {
    const a = this.#auth(runId, token);
    const d = this.#judge(a, tool, input);
    return d.decision === "deny" ? { behavior: "deny", message: `Refusé par le hub : ${d.reason}` } : { behavior: "allow" };
  }

  // ── Fabrication ──

  async #plan(id: string, feedback: string | null): Promise<void> {
    try {
      const m = this.get(id);
      const r = recipe(m.recipe);
      const { data } = await this.#orchestrator.structured({
        systemPrompt: PLAN_SYSTEM,
        prompt: [
          `Jeu : ${m.game}`,
          `Ce que le studio sait faire pour ce jeu :\n${r.agent}`,
          `Idée du directeur créatif :\n${m.idea}`,
          m.plan ? `Plan actuel :\n${JSON.stringify(m.plan, null, 2)}` : "",
          feedback ? `Ses précisions sur ce plan :\n${feedback}` : "",
        ]
          .filter(Boolean)
          .join("\n\n"),
        jsonSchema: PLAN_SCHEMA,
        meta: { project: null, agent: "mods" },
      });
      const plan = normalizePlan(data);
      this.#update(id, { status: "waiting", phase: "plan", title: plan.title, plan_json: JSON.stringify(plan) });
      this.#event(id, "phase", plan.questions.length ? "Plan prêt, avec une question pour vous." : "Plan prêt : « Fabriquer » si ça vous va, ou dites ce qu'il faut changer.");
    } catch (err) {
      this.#fail(id, err as Error, false);
    }
  }

  async #make(id: string): Promise<void> {
    const abort = new AbortController();
    this.#aborts.set(id, abort);
    try {
      const m = this.get(id);
      const r = recipe(m.recipe);
      const name = this.#freeName(modName(m.plan!.title));
      const root = join(this.gamesRoot!, "mods", r.id, name);
      mkdirSync(root, { recursive: true });
      for (const [file, content] of Object.entries(r.template({ name, gameDir: m.game_dir }))) writeFileSync(join(root, file), content);
      writeFileSync(join(root, ".gitignore"), "bin/\nobj/\n");
      writeFileSync(join(root, "PLAN.md"), planMarkdown(m.plan!, m.idea, m.game));
      await this.#vcs.init(root);
      await this.#vcs.commitPaths(root, ["."], `mod: gabarit de « ${m.plan!.title} »`);
      this.#update(id, { name, root });
      const report = await this.#run(id, r, root, buildPrompt(m.plan!, m.idea), CODE, abort.signal);
      await this.#vcs.commitPaths(root, ["."], `mod: première version de « ${m.plan!.title} »`);
      await this.#verify(id, r, root, abort.signal, report, fixBuildPrompt);
    } catch (err) {
      this.#fail(id, err as Error, abort.signal.aborted);
    } finally {
      this.#aborts.delete(id);
    }
  }

  /** Une passe sur un mod existant (amélioration, correction), puis construction ; réinstallé s'il l'était. */
  async #rework(id: string, prompt: string, what: string, reinstall: boolean): Promise<void> {
    const abort = new AbortController();
    this.#aborts.set(id, abort);
    try {
      const m = this.get(id);
      const r = recipe(m.recipe);
      const report = await this.#run(id, r, m.root, prompt, FIX, abort.signal);
      await this.#vcs.commitPaths(m.root, ["."], `mod: ${what}`);
      this.#update(id, { version: m.version + 1 });
      await this.#verify(id, r, m.root, abort.signal, report ?? m.report, fixBuildPrompt);
      if (reinstall && this.get(id).status === "ready" && this.get(id).installed) {
        const { game } = this.#game(m.appid);
        this.#place(this.get(id), r, game);
      }
    } catch (err) {
      this.#fail(id, err as Error, abort.signal.aborted);
    } finally {
      this.#aborts.delete(id);
    }
  }

  async #rebuild(id: string): Promise<void> {
    const abort = new AbortController();
    this.#aborts.set(id, abort);
    try {
      const m = this.get(id);
      const r = recipe(m.recipe);
      await this.#verify(id, r, m.root, abort.signal, m.report, rebuildPrompt);
      const after = this.get(id);
      if (after.status === "ready" && after.installed) this.#place(after, r, this.#game(m.appid).game);
    } catch (err) {
      this.#fail(id, err as Error, abort.signal.aborted);
    } finally {
      this.#aborts.delete(id);
    }
  }

  /** Le hub construit lui-même ; en cas d'échec, jusqu'à deux corrections du développeur. */
  async #verify(id: string, r: GameRecipe, root: string, signal: AbortSignal, report: ModReport | null, fix: (out: string) => string): Promise<void> {
    const name = this.get(id).name;
    for (let attempt = 0; ; attempt++) {
      this.#update(id, { phase: "construction" });
      this.#event(id, "phase", "Construction : le hub compile le mod…");
      const b = await this.#toolchain.build(r, root);
      const dll = join(root, r.output(name));
      if (b.code === 0 && existsSync(dll)) break;
      const tail = b.out.split(/\r?\n/).filter((l) => /error|erreur/i.test(l)).slice(0, 8).join("\n") || b.out.slice(-800);
      this.#event(id, "error", `La construction échoue :\n${tail.slice(0, 1200)}`);
      if (attempt >= 2) throw new ModError("Le mod ne se construit toujours pas après deux corrections");
      this.#update(id, { phase: "correction" });
      this.#event(id, "phase", "Correction : le développeur corrige la construction…");
      report = (await this.#run(id, r, root, fix(b.out), FIX, signal)) ?? report;
      await this.#vcs.commitPaths(root, ["."], "mod: correction de la construction");
    }
    const m = this.get(id);
    const build = gameBuild({ appid: m.appid, library: this.#steam().find((g) => g.appid === m.appid)?.library ?? "" });
    this.#update(id, { status: "ready", phase: "pret", report_json: report ? JSON.stringify(report) : m.report ? JSON.stringify(m.report) : null, game_build: build || null });
    this.#event(id, "phase", m.installed ? "Prêt : nouvelle version construite." : "Prêt : « Installer » pour l'essayer en jeu.");
    this.#journal.append({ project: null, actor: { kind: "system" }, type: "mods.ready", subject: id, payload: { title: m.title } });
    this.#persistEvents(id);
    this.#notify(id);
  }

  #place(m: Mod, r: GameRecipe, game: SteamGame): void {
    const marker = join(this.#dataDir, "mods", r.id, "sauvegardes.json");
    if (!existsSync(marker)) {
      const dest = join(this.#dataDir, "mods", r.id, "sauvegardes", this.#clock.now().replace(/[:.]/g, "-"));
      const saved = backupSaves(r, dest);
      mkdirSync(join(this.#dataDir, "mods", r.id), { recursive: true });
      writeFileSync(marker, JSON.stringify({ at: this.#clock.now(), dest: saved }, null, 2));
      this.#event(m.id, "info", saved ? `Vos sauvegardes du jeu sont copiées à l'abri (${saved}).` : "Aucune sauvegarde du jeu trouvée à copier.");
    }
    const files = [{ from: join(m.root, r.output(m.name)), to: `${m.name}.dll` }];
    const assets = join(m.root, "assets");
    if (existsSync(assets)) files.push({ from: assets, to: m.name });
    const installed = install(r, game.dir, files, gameBuild(game) || m.game_build || "", m.installed);
    this.#update(m.id, { installed_json: JSON.stringify(installed) });
    this.#event(m.id, "phase", "Installé dans le jeu : lancez une partie, puis « J'ai joué ».");
    this.#journal.append({ project: null, actor: { kind: "human" }, type: "mods.installed", subject: m.id, payload: { files: installed.files.map((f) => f.path) } });
  }

  async #run(id: string, r: GameRecipe, root: string, prompt: string, budget: { turns: number; ms: number }, signal: AbortSignal): Promise<ModReport | null> {
    const runId = `MRUN-${randomUUID().slice(0, 8)}`;
    const token = randomBytes(32).toString("base64url");
    const carte = this.#toolchain.typemapDir(r);
    const policy = new PolicyEngine({ mode: "execute", root, readable: [carte] });
    this.#active = { modId: id, runId, tokenHash: sha256(token), policy, cwd: root, root, recipe: r };
    const local = new AbortController();
    const timer = setTimeout(() => local.abort(), budget.ms);
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
        systemPrompt: devSystem(r.agent, join(carte, "carte-types.txt")),
        prompt,
        jsonSchema: RESULT_SCHEMA,
        tools: TOOLS_BY_MODE.execute,
        maxTurns: budget.turns,
        model: "sonnet",
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
      this.usage?.record({ project: null, agent: "mods", model: result.model ?? "sonnet", tokens: result.tokens ?? null, costUsd: result.costUsd, limits: result.limits });
      return toReport(result.structured);
    } catch (err) {
      if (signal.aborted) throw new ModError("Arrêté par vous");
      if (local.signal.aborted) {
        this.#event(id, "info", `Temps écoulé (${Math.round(budget.ms / 60_000)} min) : on garde ce qui est écrit.`);
        return null;
      }
      throw err;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", relay);
      this.#active = null;
    }
  }

  #assertReady(r: GameRecipe, gameDir: string): void {
    const t = this.#toolchain.state(r, gameDir);
    if (!t.dotnet.installed) throw new ModError("Le SDK .NET n'est pas installé sur ce PC");
    if (!t.loader.installed) throw new ModError(`Installez d'abord ${r.loader.name} (bouton sur la page du jeu)`);
    if (!t.loader.generated) throw new ModError(r.loader.firstRun);
    if (!t.typemap.ready) throw new ModError("Préparez d'abord la carte des types du jeu (bouton sur la page du jeu)");
  }

  #assertFree(): void {
    if (this.running()) throw new ModError("Un mod est déjà en travail : attendez qu'il soit prêt");
  }

  #assertQuota(): void {
    const limits = this.usage?.snapshot().limits;
    for (const w of ["five_hour", "seven_day"] as const) {
      const win = limits?.windows[w];
      if (win && win.utilization >= LIMIT[w] && Date.parse(win.resetsAt) > Date.parse(this.#clock.now())) {
        const at = new Date(win.resetsAt).toLocaleString("fr-FR", { weekday: w === "seven_day" ? "long" : undefined, hour: "2-digit", minute: "2-digit" });
        throw new ModError(`Abonnement presque épuisé (${Math.round(win.utilization * 100)} %) : réessayez après ${at}.`);
      }
    }
  }

  #fail(id: string, err: Error, cancelled: boolean): void {
    this.#update(id, { status: cancelled ? "cancelled" : "failed", error: err.message.slice(0, 600) });
    this.#event(id, "error", cancelled ? "Arrêté." : `Échec : ${err.message.slice(0, 300)}`);
    this.#journal.append({ project: null, actor: { kind: "system" }, type: cancelled ? "mods.cancelled" : "mods.failed", subject: id, payload: { error: err.message.slice(0, 300) } });
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

  #auth(runId: string, token: string): Active {
    const a = this.#active;
    if (!a || a.runId !== runId || sha256(token) !== a.tokenHash) throw new ModError("Run inconnu, terminé ou jeton invalide");
    return a;
  }

  #freeName(base: string): string {
    const used = new Set((this.#db.prepare("SELECT name FROM mods").all() as { name: string }[]).map((r) => r.name));
    for (let i = 1; ; i++) {
      const name = i === 1 ? base : `${base}${i}`;
      if (!used.has(name)) return name;
    }
  }

  #event(id: string, kind: ModEvent["kind"], text: string): void {
    const list = this.#events.get(id) ?? this.#stored(id);
    list.push({ seq: (list.at(-1)?.seq ?? 0) + 1, at: this.#clock.now(), kind, text });
    if (list.length > MAX_EVENTS) list.splice(0, list.length - MAX_EVENTS);
    this.#events.set(id, list);
    if (kind === "phase" || kind === "error") this.#persistEvents(id);
  }

  #stored(id: string): ModEvent[] {
    const r = this.#db.prepare("SELECT events_json FROM mods WHERE id = ?").get(id) as { events_json: string } | undefined;
    try {
      return r ? (JSON.parse(r.events_json) as ModEvent[]) : [];
    } catch {
      return [];
    }
  }

  #persistEvents(id: string): void {
    this.#db.prepare("UPDATE mods SET events_json = ? WHERE id = ?").run(JSON.stringify(this.#events.get(id) ?? []), id);
  }

  #update(id: string, fields: Record<string, string | number | null>): void {
    const keys = Object.keys(fields);
    this.#db.prepare(`UPDATE mods SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => fields[k]!), this.#clock.now(), id);
  }

  #track(p: Promise<unknown>): void {
    this.#background.add(p);
    void p.finally(() => this.#background.delete(p));
  }

  #row(r: Row): Mod {
    const lib = this.#steam().find((g) => g.appid === r.appid)?.library ?? "";
    const now = lib ? gameBuild({ appid: r.appid, library: lib }) : "";
    return {
      id: r.id,
      recipe: r.recipe,
      appid: r.appid,
      game: r.game,
      game_dir: r.game_dir,
      name: r.name,
      title: r.title,
      idea: r.idea,
      status: r.status as ModStatus,
      phase: r.phase,
      root: r.root,
      plan: r.plan_json ? (JSON.parse(r.plan_json) as ModPlan) : null,
      report: r.report_json ? (JSON.parse(r.report_json) as ModReport) : null,
      game_build: r.game_build,
      outdated: !!(r.game_build && now && now !== r.game_build),
      installed: r.installed_json ? (JSON.parse(r.installed_json) as Installed) : null,
      played: r.played_json ? (JSON.parse(r.played_json) as Mod["played"]) : null,
      error: r.error,
      version: r.version,
      created_at: r.created_at,
      updated_at: r.updated_at,
      events: this.#events.get(r.id) ?? this.#stored(r.id),
    };
  }
}

type Row = {
  id: string;
  recipe: string;
  appid: string;
  game: string;
  game_dir: string;
  name: string;
  title: string;
  idea: string;
  status: string;
  phase: string;
  root: string;
  plan_json: string | null;
  report_json: string | null;
  game_build: string | null;
  installed_json: string | null;
  played_json: string | null;
  error: string | null;
  version: number;
  hidden: number;
  created_at: string;
  updated_at: string;
  events_json: string;
};

function toReport(v: unknown): ModReport | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const arr = (k: string, n: number) => (Array.isArray(o[k]) ? (o[k] as unknown[]).map(String).slice(0, n) : []);
  return { summary: String(o.summary ?? "").slice(0, 1200), how_to_test: String(o.how_to_test ?? "").slice(0, 600), settings: arr("settings", 10), known_issues: arr("known_issues", 5) };
}

function normalizePlan(v: unknown): ModPlan {
  const o = (v ?? {}) as Record<string, unknown>;
  const str = (k: string, max: number) => (typeof o[k] === "string" ? (o[k] as string).trim().slice(0, max) : "");
  const arr = (k: string, n: number) => (Array.isArray(o[k]) ? (o[k] as unknown[]).map(String).map((s) => s.trim()).filter(Boolean).slice(0, n) : []);
  const title = str("title", 60);
  if (!title) throw new ModError("Le Concepteur de mods n'a pas rendu de plan exploitable");
  const settings = Array.isArray(o.settings)
    ? (o.settings as Record<string, unknown>[]).slice(0, 10).map((s) => ({ name: String(s.name ?? "").slice(0, 60), default: String(s.default ?? "").slice(0, 60), description: String(s.description ?? "").slice(0, 200) })).filter((s) => s.name)
    : [];
  return {
    title,
    summary: str("summary", 800),
    kind: o.kind === "confort" || o.kind === "apparence" ? o.kind : "regles",
    changes: arr("changes", 12),
    settings,
    questions: arr("questions", 3),
    risks: arr("risks", 5),
  };
}

function planMarkdown(p: ModPlan, idea: string, game: string): string {
  return [
    `# ${p.title}`,
    "",
    `Mod pour ${game}, fait avec le studio de modding de Nidavellir (ADR-65).`,
    "",
    "## La demande",
    idea,
    "",
    "## Ce que fait le mod",
    p.summary,
    "",
    ...p.changes.map((c) => `- ${c}`),
    "",
    p.settings.length ? "## Réglages" : "",
    ...p.settings.map((s) => `- **${s.name}** (défaut ${s.default}) : ${s.description}`),
    "",
  ].join("\n");
}
