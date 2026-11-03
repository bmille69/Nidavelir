import { spawn, execFile } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import type { Clock } from "../clock.ts";
import type { Db } from "../db/database.ts";
import { PreviewService } from "../executor/preview.ts";
import type { Journal } from "../journal/journal.ts";
import type { ProjectRegistry } from "../projects/project-registry.ts";
import { GodotGame, godotImport, godotReplay, godotTests } from "../godot/run.ts";
import { runSavedReplays } from "./replays.ts";
import { hasBridge, hasStudioTests, isGodot, type GodotInstall } from "../godot/toolchain.ts";
import type { VerificationOutput } from "@studio/contracts";
import type { PosePhoto } from "../executor/prompts.ts";

/** Résultat d'une vérification faite par le hub lui-même ; « none » = rien à vérifier ou impossible ici. */
export type CheckOutcome = {
  status: "pass" | "fail" | "none";
  detail: string;
  /** Capture de l'écran du jeu (lancement), si prise. */
  screenshot?: string | null;
  /** Les ressources (images, modèles, sons) que le jeu a chargées, par leur chemin sur son serveur (bilan, ADR-71). */
  loaded?: string[];
  /** Les performances mesurées par le relais (jeu Godot, ADR-83). */
  perf?: PerfSample | null;
  /** Les poses de contrôle que le jeu déclare (ADR-122). */
  poses?: PoseDeclared[];
};

/** Une pose de contrôle déclarée par le jeu (`poses()` du nœud « studio_test », ADR-122). */
export type PoseDeclared = { nom: string; description: string };

/** Ligne « §POSE§ T-0001 <date> <nom> » : l'interface y affiche la photo de cette pose (ADR-122). */
export const POSE_MARK = "§POSE§ ";
/** Poses photographiées au plus par vérification, et images dans un compte rendu. */
export const MAX_POSES = 8;
const MAX_POSES_SHOWN = 3;

/** Les photos à montrer dans le compte rendu : celles que le testeur cite d'abord (dans ses preuves, ses résumés). */
export function relevantPoses(report: Pick<CheckReport, "poses">, verdict: VerificationOutput | null): PosePhoto[] {
  const said = verdict ? JSON.stringify(verdict) : "";
  const taken = (report.poses ?? []).filter((p) => p.file);
  return [...taken.filter((p) => said.includes(p.nom)), ...taken.filter((p) => !said.includes(p.nom))].slice(0, MAX_POSES_SHOWN);
}

/** Ce que le relais Godot mesure en quelques secondes, synchronisation verticale coupée (ADR-83). */
export type PerfSample = {
  fps: number;
  frame_ms_avg: number;
  frame_ms_p95: number;
  frame_ms_max: number;
  draw_calls: number;
  primitives: number;
  objects: number;
  video_mem_mb: number;
  static_mem_mb: number;
  nodes: number;
  scene: string;
  seconds: number;
  frames: number;
};

/**
 * Le budget de performance d'un chantier (ADR-83). `baseline` : la dernière mesure d'un chantier fusionné ; `before` : le
 * jeu actuel remesuré à l'instant, seulement si le chantier paraît plus lent (la machine peut être occupée ailleurs).
 */
export type PerfCheck = {
  status: "pass" | "fail";
  detail: string;
  sample: PerfSample;
  baseline: PerfSample | null;
  before: PerfSample | null;
  regression: boolean;
};

export type PerfBudget = { minFps: number; maxDrop: number };
export const DEFAULT_PERF_BUDGET: PerfBudget = {
  minFps: Number(process.env.STUDIO_PERF_MIN_FPS) > 0 ? Number(process.env.STUDIO_PERF_MIN_FPS) : 60,
  maxDrop: 0.25,
};

const n = (v: number) => Math.round(v).toLocaleString("fr-FR");
const ms = (v: number) => v.toFixed(1).replace(".", ",");

/** Une mesure en clair. */
export function describePerf(p: PerfSample): string {
  return `${n(p.fps)} images/s sans synchro (${ms(p.frame_ms_avg)} ms par image, 95 % sous ${ms(p.frame_ms_p95)} ms, pire ${ms(p.frame_ms_max)} ms), ${n(p.draw_calls)} appels de dessin, ${n(p.primitives)} triangles, ${n(p.video_mem_mb)} Mo de mémoire vidéo, ${n(p.nodes)} nœuds`;
}

/** Ce qui dépasse le budget, en clair ; vide si tout va bien. `ref` : la mesure de comparaison. */
export function perfProblems(p: PerfSample, ref: PerfSample | null, budget: PerfBudget = DEFAULT_PERF_BUDGET): string[] {
  const out: string[] = [];
  if (p.fps < budget.minFps) out.push(`${n(p.fps)} images/s, sous le plancher de ${budget.minFps}`);
  if (ref && p.fps < ref.fps * (1 - budget.maxDrop)) {
    const why: string[] = [];
    if (p.draw_calls > ref.draw_calls * 1.3) why.push(`appels de dessin ${n(ref.draw_calls)} → ${n(p.draw_calls)}`);
    if (p.primitives > ref.primitives * 1.3) why.push(`triangles ${n(ref.primitives)} → ${n(p.primitives)}`);
    if (p.nodes > ref.nodes * 1.3) why.push(`nœuds ${n(ref.nodes)} → ${n(p.nodes)}`);
    out.push(`${n(ref.fps)} → ${n(p.fps)} images/s (−${Math.round((1 - p.fps / ref.fps) * 100)} %)${why.length ? ` ; ${why.join(", ")}` : ""}`);
  }
  return out;
}

const RESOURCE_URL = /\.(png|jpe?g|webp|avif|gif|svg|glb|gltf|bin|ktx2|hdr|mp3|ogg|wav|m4a)$/i;

/** Vérifications objectives d'un chantier, avant sa fusion (ADR-32). */
export type CheckReport = {
  /** Tests du jeu (`npm test`) dans la copie du chantier. */
  tests: CheckOutcome;
  /** Le jeu se lance (`npm run dev` + navigateur invisible, sans erreur). */
  launch: CheckOutcome;
  /** Vos parties gardées comme tests, rejouées dans la copie (jeu Godot, ADR-85). */
  replays?: CheckOutcome | null;
  /** Les tests de bout en bout (`npm run test:e2e`), lancés par le hub dans la copie (jeu web, ADR-128) ; absent si rien à lancer. */
  e2e?: CheckOutcome | null;
  /** Mêmes vérifications sur le jeu actuel, faites seulement si le chantier échoue : l'échec était-il déjà là ? */
  before: { tests: CheckOutcome | null; launch: CheckOutcome | null; replays?: CheckOutcome | null; e2e?: CheckOutcome | null };
  /** Performances du jeu Godot face à son budget (ADR-83) ; absent pour un jeu web ou un relais trop ancien. */
  perf?: PerfCheck | null;
  /** Les poses de contrôle photographiées dans le vrai jeu (ADR-122). Une pose ratée n'est pas une régression. */
  poses?: PosePhoto[];
  /** Le chantier casse quelque chose qui marchait. */
  regression: boolean;
  at: string;
};

/** Ce qui sait lancer les tests et le jeu (remplacé par un faux dans les tests du hub). */
export interface CheckerPort {
  tests(cwd: string): Promise<CheckOutcome>;
  /** `screenshot` : où enregistrer la capture de l'écran (aucune si absent) ; `path` : ajouté à l'adresse du jeu (« ?vitrine=A-0001 »). */
  launch(key: string, cwd: string, screenshot?: string, path?: string): Promise<CheckOutcome>;
  /** Vos parties gardées (studio/replays), rejouées dans `cwd` (ADR-85). */
  replays?(cwd: string): Promise<CheckOutcome>;
  /** Photographie les poses déclarées dans une même instance du jeu de `cwd` ; `file` donne le chemin de chaque photo (ADR-122). */
  poses?(cwd: string, poses: PoseDeclared[], file: (pose: PoseDeclared, index: number) => string): Promise<PosePhoto[]>;
  /** La suite de bout en bout du jeu (`npm run test:e2e`), lancée dans `cwd` (ADR-128). */
  e2e?(cwd: string): Promise<CheckOutcome>;
}

const ANSI = /\x1b\[[0-9;]*m/g;

/**
 * Vérifications du hub (ADR-32) : le testeur est un agent, il peut se tromper ; ici, ce sont
 * des faits. Si le chantier échoue, on refait la même vérification sur le jeu actuel pour
 * savoir si c'est lui qui a cassé quelque chose (régression) ou si c'était déjà cassé.
 */
export class CheckService {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #journal: Journal;
  readonly #projects: ProjectRegistry;
  readonly #checker: CheckerPort;
  readonly #shotsDir: string;
  readonly #budget: PerfBudget;

  /**
   * Un seul gros contrôle à la fois pour tout le studio (ADR-130) : tests, lancement, parties rejouées, suite de bout en bout
   * et photos de contrôle d'un chantier passent d'un bloc. Jusqu'à trois chantiers (réservoir d'agents, ADR-103) lançaient
   * chacun leur navigateur caché, leur serveur de dev ou Godot en même temps sur un processeur de 6 cœurs. Les autres attendent leur tour.
   */
  readonly #heavyLimit: number;
  #heavyRunning = 0;
  readonly #heavyWaiting: (() => void)[] = [];

  constructor(deps: { db: Db; clock: Clock; journal: Journal; projects: ProjectRegistry; checker: CheckerPort; shotsDir: string; perfBudget?: PerfBudget; heavyLimit?: number }) {
    this.#heavyLimit = Math.max(1, Math.floor(deps.heavyLimit ?? 1));
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#journal = deps.journal;
    this.#projects = deps.projects;
    this.#checker = deps.checker;
    this.#shotsDir = deps.shotsDir;
    this.#budget = deps.perfBudget ?? DEFAULT_PERF_BUDGET;
  }

  /** Capture du jeu pour un chantier (la dernière prise), dans les données du hub, jamais dans le jeu. */
  screenshotPath(project: string, task: string): string {
    return join(this.#shotsDir, project.replace(/[^\w-]/g, "_"), `${task.replace(/[^\w-]/g, "_")}.png`);
  }

  /** La capture à montrer pour un chantier (Récap, comptes rendus) : la photo « en jeu » du Testeur d'abord (ADR-113). */
  taskShot(project: string, task: string): TaskShot | null {
    return pickTaskShot(this.#shotsDir, project, task);
  }

  /**
   * La suite de bout en bout sur le jeu actuel, une seule fois par commit (ADR-128) : mesurée sur Bordée, elle prend 9 min
   * sous charge et un test déjà cassé dans le jeu la ferait relancer après CHAQUE passe de chaque chantier. Deux chantiers
   * qui la demandent en même temps partagent le même lancement. Sans Git lisible, pas de mémoire : on relance.
   */
  readonly #rootE2eRuns = new Map<string, Promise<CheckOutcome>>();
  async #rootE2e(root: string, safe: (p: Promise<CheckOutcome>) => Promise<CheckOutcome>): Promise<CheckOutcome | null> {
    if (!this.#checker.e2e) return null;
    const head = await new Promise<string | null>((resolve) =>
      execFile("git", ["rev-parse", "HEAD"], { cwd: root, windowsHide: true }, (err, out) => resolve(err ? null : String(out).trim() || null)),
    );
    if (!head) return safe(this.#checker.e2e(root));
    const key = `${root}@${head}`;
    let run = this.#rootE2eRuns.get(key);
    if (!run) {
      run = safe(this.#checker.e2e(root));
      this.#rootE2eRuns.set(key, run);
      // Une expiration ou une panne n'est pas un fait sur ce commit : on ne la garde pas.
      void run.then((o) => {
        if (o.status === "none" || /ne se sont pas terminés/.test(o.detail)) this.#rootE2eRuns.delete(key);
      });
      while (this.#rootE2eRuns.size > 20) this.#rootE2eRuns.delete(this.#rootE2eRuns.keys().next().value!);
    }
    return run;
  }

  /** Combien de contrôles attendent leur tour (ADR-130). */
  get waiting(): number {
    return this.#heavyWaiting.length;
  }

  async run(project: string, task: string, worktree: string): Promise<CheckReport> {
    if (this.#heavyRunning >= this.#heavyLimit) await new Promise<void>((resolve) => this.#heavyWaiting.push(resolve));
    else this.#heavyRunning++;
    try {
      return await this.#run(project, task, worktree);
    } finally {
      // Le tour passe directement au suivant : le compteur ne redescend que si personne n'attend.
      const next = this.#heavyWaiting.shift();
      if (next) next();
      else this.#heavyRunning--;
    }
  }

  async #run(project: string, task: string, worktree: string): Promise<CheckReport> {
    const root = this.#projects.get(project).root;
    const safe = (p: Promise<CheckOutcome>) => p.catch((err: Error): CheckOutcome => ({ status: "none", detail: `vérification impossible : ${err.message.slice(0, 300)}` }));
    const tests = await safe(this.#checker.tests(worktree));
    const shot = this.screenshotPath(project, task);
    mkdirSync(dirname(shot), { recursive: true });
    const launch = await safe(this.#checker.launch(`${project}/check-${task}`, worktree, shot));
    const replays = this.#checker.replays ? await safe(this.#checker.replays(worktree)) : null;
    // ADR-128 : la suite de bout en bout, lancée par le hub plutôt que relancée sans fin par le Développeur.
    const e2eRun = this.#checker.e2e ? await safe(this.#checker.e2e(worktree)) : null;
    const e2e = e2eRun && e2eRun.status !== "none" ? e2eRun : null;
    const before = {
      tests: tests.status === "fail" ? await safe(this.#checker.tests(root)) : null,
      launch: launch.status === "fail" ? await safe(this.#checker.launch(`${project}/check-jeu`, root)) : null,
      replays: replays?.status === "fail" && this.#checker.replays ? await safe(this.#checker.replays(root)) : null,
      // Rapports sans e2e inchangés : la clé n'apparaît que si la suite a tourné.
      ...(e2e ? { e2e: e2e.status === "fail" ? await this.#rootE2e(root, safe) : null } : {}),
    };
    const perf = launch.perf ? await this.#perf(project, root, launch.perf, safe) : null;
    const poses = launch.status !== "fail" && launch.poses?.length ? await this.#poses(project, task, worktree, launch.poses) : [];
    const regression =
      (tests.status === "fail" && before.tests?.status !== "fail") ||
      (launch.status === "fail" && before.launch?.status !== "fail") ||
      (replays?.status === "fail" && before.replays?.status !== "fail") ||
      (e2e?.status === "fail" && before.e2e?.status !== "fail") ||
      !!perf?.regression;
    const report: CheckReport = { tests, launch, replays, ...(e2e ? { e2e } : {}), before, perf, ...(poses.length ? { poses } : {}), regression, at: this.#clock.now() };
    this.#db
      .prepare("INSERT INTO checks (project, task, data_json, at) VALUES (?, ?, ?, ?) ON CONFLICT (project, task) DO UPDATE SET data_json = excluded.data_json, at = excluded.at")
      .run(project, task, JSON.stringify(report), report.at);
    this.#journal.append({
      project,
      actor: { kind: "system" },
      type: "check.done",
      subject: task,
      payload: { tests: tests.status, launch: launch.status, regression, ...(perf ? { perf: perf.status, fps: perf.sample.fps } : {}), ...(replays && replays.status !== "none" ? { replays: replays.status } : {}), ...(e2e ? { e2e: e2e.status } : {}), ...(poses.length ? { poses: poses.length, poses_failed: poses.filter((p) => !p.file).length } : {}) },
    });
    return report;
  }

  /** Les photos de contrôle (ADR-122), rangées avec la capture du chantier. Un échec ici est noté, jamais une régression. */
  async #poses(project: string, task: string, worktree: string, declared: PoseDeclared[]): Promise<PosePhoto[]> {
    if (!this.#checker.poses) return [];
    const poses = declared.slice(0, MAX_POSES);
    try {
      return await this.#checker.poses(worktree, poses, (p, k) => join(dirname(this.screenshotPath(project, task)), `${safeName(task)}-pose-${k}-${safeName(p.nom)}.jpg`));
    } catch (err) {
      return poses.map((p) => ({ ...p, file: null, error: (err as Error).message.slice(0, 200) }));
    }
  }

  /** La photo d'une pose de la dernière vérification (seuls les noms du rapport donnent un fichier). */
  poseShot(project: string, task: string, nom: string): string | null {
    const file = this.get(project, task)?.poses?.find((p) => p.nom === nom)?.file ?? null;
    return file && existsSync(file) ? file : null;
  }

  /**
   * Le budget de performance (ADR-83). Face à la dernière mesure d'un chantier fusionné, un chantier qui paraît plus lent
   * fait remesurer le jeu actuel à l'instant, sur la même machine : seule une vraie différence est une régression.
   */
  async #perf(project: string, root: string, sample: PerfSample, safe: (p: Promise<CheckOutcome>) => Promise<CheckOutcome>): Promise<PerfCheck> {
    const baseline = this.#baseline(project);
    if (!perfProblems(sample, baseline, this.#budget).length) {
      return { status: "pass", detail: `${describePerf(sample)}${baseline ? ` (dernier chantier fusionné : ${n(baseline.fps)} images/s)` : ""}`, sample, baseline, before: null, regression: false };
    }
    const before = (await safe(this.#checker.launch(`${project}/perf-jeu`, root))).perf ?? null;
    const ref = before ?? baseline;
    const problems = perfProblems(sample, ref, this.#budget);
    // Sous le plancher, mais le jeu actuel aussi : ce n'est pas ce chantier.
    const already = !!before && before.fps < this.#budget.minFps && !perfProblems(sample, before, { ...this.#budget, minFps: 0 }).length;
    if (!problems.length) {
      return { status: "pass", detail: `${describePerf(sample)} (le jeu actuel, remesuré à l'instant : ${before ? n(before.fps) : "?"} images/s ; l'écart venait de la machine)`, sample, baseline, before, regression: false };
    }
    return {
      status: "fail",
      detail: `${problems.join(" ; ")}. ${describePerf(sample)}${already ? " (déjà le cas avant ce chantier)" : ""}`,
      sample,
      baseline,
      before,
      regression: !already,
    };
  }

  /** La dernière mesure d'un chantier fusionné de ce projet. */
  #baseline(project: string): PerfSample | null {
    const rows = this.#db
      .prepare("SELECT c.data_json FROM checks c JOIN tasks t ON t.project = c.project AND t.id = c.task WHERE c.project = ? AND t.status = 'merged' ORDER BY c.at DESC LIMIT 20")
      .all(project) as { data_json: string }[];
    for (const r of rows) {
      const perf = (JSON.parse(r.data_json) as CheckReport).perf;
      if (perf?.sample) return perf.sample;
    }
    return null;
  }

  get(project: string, task: string): CheckReport | null {
    const row = this.#db.prepare("SELECT data_json FROM checks WHERE project = ? AND task = ?").get(project, task) as { data_json: string } | undefined;
    return row ? (JSON.parse(row.data_json) as CheckReport) : null;
  }
}

/** En une ligne, pour la discussion. */
export function describeChecks(c: CheckReport): string {
  const part = (label: string, o: CheckOutcome, before: CheckOutcome | null) =>
    o.status === "none" ? null : o.status === "pass" ? `${label} ✓` : `${label} ✗${before?.status === "fail" ? " (déjà le cas avant ce chantier)" : ""}`;
  const perf = c.perf ? (c.perf.status === "pass" ? `performances ✓ (${n(c.perf.sample.fps)} images/s)` : `performances ✗${c.perf.regression ? "" : " (déjà le cas avant ce chantier)"}`) : null;
  const parts = [part("tests du jeu", c.tests, c.before.tests), part("le jeu se lance", c.launch, c.before.launch), c.replays ? part("vos parties rejouées", c.replays, c.before.replays ?? null) : null, c.e2e ? part("tests de bout en bout", c.e2e, c.before.e2e ?? null) : null, perf].filter(Boolean);
  return parts.length ? `Vérifié par le hub : ${parts.join(", ")}.` : "";
}

/** Pour le testeur : les faits mesurés, avec le détail des échecs. */
export function checksForTester(c: CheckReport): string {
  const line = (label: string, o: CheckOutcome, before: CheckOutcome | null) =>
    o.status === "none"
      ? `- ${label} : non vérifié (${o.detail})`
      : o.status === "pass"
        ? `- ${label} : OK`
        : `- ${label} : ÉCHEC${before?.status === "fail" ? " (déjà le cas avant ce chantier : pas une régression)" : " (ça marchait avant ce chantier : RÉGRESSION)"}\n${o.detail}`;
  const perf = c.perf
    ? c.perf.status === "pass"
      ? `- Performances (budget du studio) : OK. ${c.perf.detail}`
      : `- Performances (budget du studio) : ÉCHEC${c.perf.regression ? " (le jeu était plus rapide avant ce chantier : RÉGRESSION)" : ""}\n${c.perf.detail}`
    : null;
  const replays = c.replays && c.replays.status !== "none" ? line("Les parties du directeur créatif, rejouées à l'identique", c.replays, c.before.replays ?? null) : null;
  const e2e = c.e2e && c.e2e.status !== "none" ? line("Tests de bout en bout (npm run test:e2e)", c.e2e, c.before.e2e ?? null) : null;
  return [line("Tests du jeu (npm test)", c.tests, c.before.tests), e2e, line("Le jeu se lance dans le navigateur", c.launch, c.before.launch), replays, perf].filter(Boolean).join("\n");
}

/** Ce qu'il faut dire au développeur quand le hub trouve une régression. */
export function regressionFeedback(c: CheckReport): string {
  const lines = ["Le hub a vérifié ton travail lui-même et il a cassé quelque chose qui marchait avant :"];
  if (c.tests.status === "fail" && c.before.tests?.status !== "fail") lines.push(`- Les tests du jeu (npm test) ne passent plus. Fin de la sortie :\n${c.tests.detail}`);
  if (c.e2e?.status === "fail" && c.before.e2e?.status !== "fail") lines.push(`- Les tests de bout en bout (npm run test:e2e) ne passent plus. Fin de la sortie :\n${c.e2e.detail}`);
  if (c.launch.status === "fail" && c.before.launch?.status !== "fail") lines.push(`- Le jeu ne se lance plus correctement dans le navigateur : ${c.launch.detail}`);
  if (c.replays?.status === "fail" && c.before.replays?.status !== "fail") {
    lines.push(
      `- Une partie que le directeur créatif a jouée puis gardée comme test ne se rejoue plus à l'identique (mêmes entrées, même hasard ; l'état du jeu diverge) :\n${c.replays.detail}`,
      "  Si ton changement est voulu et change ce que le joueur obtient, dis-le dans ton rapport (la partie sera à rejouer) ; sinon, corrige.",
    );
  }
  if (c.perf?.regression) {
    lines.push(
      `- Le jeu est devenu trop lent (budget de performance du studio) : ${c.perf.detail}`,
      "  Cherche ce que ton travail ajoute à chaque image : trop d'objets ou de lumières, des modèles trop détaillés pour leur taille à l'écran, des matériaux non partagés, un calcul lourd dans _process. Mesure à nouveau avant de finir.",
    );
  }
  return lines.join("\n");
}

/** Vérifications réelles : `npm test`, puis le jeu dans Edge (ou Chrome) invisible. */
export class RealChecker implements CheckerPort {
  readonly #previews: PreviewService;
  readonly #testTimeoutMs: number;
  readonly #e2eTimeoutMs: number;
  readonly #watchMs: number;

  readonly #godot: () => GodotInstall | null;

  constructor(options: { workDir: string; testTimeoutMs?: number; e2eTimeoutMs?: number; watchMs?: number; godot?: () => GodotInstall | null }) {
    // Instance à part : ne coupe jamais le jeu que vous êtes en train d'essayer.
    this.#previews = new PreviewService({ workDir: options.workDir });
    this.#testTimeoutMs = options.testTimeoutMs ?? 5 * 60_000;
    this.#e2eTimeoutMs = options.e2eTimeoutMs ?? 15 * 60_000;
    this.#watchMs = options.watchMs ?? 6000;
    this.#godot = options.godot ?? (() => null);
  }

  async tests(cwd: string): Promise<CheckOutcome> {
    // Jeu Godot (ADR-73) : le lanceur de tests du studio, dans Godot sans fenêtre.
    if (isGodot(cwd)) {
      if (!hasStudioTests(cwd)) return { status: "none", detail: "pas d'outil de tests du studio (addons/studio_tests)" };
      const godot = this.#godot();
      if (!godot) return { status: "none", detail: "Godot introuvable sur ce PC" };
      return godotTests(godot.exe, cwd, this.#testTimeoutMs);
    }
    const scripts = readScripts(cwd);
    if (!scripts?.test) return { status: "none", detail: "pas de script « test »" };
    if (!existsSync(join(cwd, "node_modules"))) return { status: "none", detail: "dépendances absentes (node_modules)" };
    const first = await this.#npmTest(cwd);
    // Incident T-0086 (22/10) : node_modules est partagé entre les copies ; deux lancements de tests en même temps se
    // disputent le cache de vitest (ENOTEMPTY). Ce n'est pas un défaut du jeu : on relance une fois.
    if (first.status === "fail" && /ENOTEMPTY|EBUSY/.test(first.detail)) return this.#npmTest(cwd);
    return first;
  }

  #npmTest(cwd: string): Promise<CheckOutcome> {
    return this.#npm(cwd, "npm test", {}, this.#testTimeoutMs, "les tests");
  }

  /**
   * La suite de bout en bout du jeu web (ADR-128), sur un port libre choisi ici : deux chantiers en parallèle ne se
   * disputent pas le serveur de dev. Avec Playwright, un test instable est rejoué une fois avant de compter comme échec.
   */
  async e2e(cwd: string): Promise<CheckOutcome> {
    if (isGodot(cwd)) return { status: "none", detail: "tests de bout en bout : jeux web seulement" };
    const script = readScripts(cwd)?.["test:e2e"];
    if (!script) return { status: "none", detail: "pas de script « test:e2e »" };
    if (!existsSync(join(cwd, "node_modules"))) return { status: "none", detail: "dépendances absentes (node_modules)" };
    const port = await freePort();
    // Commande fixe, sans argument venu de l'extérieur.
    const command = /playwright/.test(script) ? "npm run test:e2e -- --retries=1" : "npm run test:e2e";
    return this.#npm(cwd, command, { E2E_PORT: String(port) }, this.#e2eTimeoutMs, "les tests de bout en bout");
  }

  #npm(cwd: string, command: string, env: Record<string, string>, timeoutMs: number, label: string): Promise<CheckOutcome> {
    return new Promise((resolve) => {
      // Commande fixe, sans argument venu de l'extérieur.
      const child = spawn(command, {
        cwd,
        shell: true,
        windowsHide: true,
        env: { ...process.env, CI: "1", FORCE_COLOR: "0", ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      const onData = (b: Buffer) => {
        out = (out + b.toString("utf8")).slice(-20_000);
      };
      child.stdout!.on("data", onData);
      child.stderr!.on("data", onData);
      const timer = setTimeout(() => {
        killTree(child.pid);
        resolve({ status: "fail", detail: `${label} ne se sont pas terminés en ${Math.round(timeoutMs / 60_000)} min` });
      }, timeoutMs);
      child.on("exit", (code) => {
        clearTimeout(timer);
        resolve({ status: code === 0 ? "pass" : "fail", detail: out.replace(ANSI, "").trim().slice(-1500) });
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ status: "none", detail: `npm introuvable : ${err.message}` });
      });
    });
  }

  async launch(key: string, cwd: string, screenshot?: string, path = ""): Promise<CheckOutcome> {
    if (isGodot(cwd)) return this.#launchGodot(cwd, screenshot, path);
    const scripts = readScripts(cwd);
    if (!scripts?.dev) return { status: "none", detail: "pas de script « dev » (jeux web uniquement)" };
    let chromium: typeof import("playwright-core").chromium;
    try {
      ({ chromium } = await import("playwright-core"));
    } catch {
      return { status: "none", detail: "outil de navigateur absent (playwright-core)" };
    }
    const [project, task] = key.split("/") as [string, string];
    let preview;
    try {
      preview = await this.#previews.start(project, task, cwd);
    } catch (err) {
      return { status: "fail", detail: (err as Error).message.slice(0, 600) };
    }
    const browser = await chromium.launch({ channel: "msedge", headless: true }).catch(() => chromium.launch({ channel: "chrome", headless: true }).catch(() => null));
    try {
      if (!browser) return { status: "none", detail: "ni Edge ni Chrome trouvés" };
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      page.on("console", (m) => {
        // Une icône d'onglet absente n'est pas un problème du jeu.
        if (m.type() === "error" && !/favicon/i.test(m.text() + (m.location().url ?? ""))) errors.push(m.text());
      });
      const loaded = new Set<string>();
      page.on("response", (r) => {
        try {
          const path = new URL(r.url()).pathname;
          if (r.status() < 400 && RESOURCE_URL.test(path)) loaded.add(path);
        } catch {
          /* adresse illisible : ignorée */
        }
      });
      await page.goto(path ? `${preview.url.replace(/\/$/, "")}/${path.replace(/^\//, "")}` : preview.url, { waitUntil: "load", timeout: 60_000 });
      await page.waitForTimeout(this.#watchMs);
      const empty = (await page.evaluate("!document.body || document.body.children.length === 0")) as boolean;
      // La capture est prise même en cas d'erreur : elle montre ce qui ne va pas (ADR-33).
      const shot = screenshot ? await page.screenshot({ path: screenshot, fullPage: true }).then(() => screenshot, () => null) : null;
      const files = [...loaded].sort();
      if (errors.length) return { status: "fail", detail: `erreurs dans la page : ${[...new Set(errors)].slice(0, 4).join(" | ").slice(0, 600)}`, screenshot: shot, loaded: files };
      if (empty) return { status: "fail", detail: "la page reste vide", screenshot: shot, loaded: files };
      return { status: "pass", detail: `lancé sans erreur (${Math.round(this.#watchMs / 1000)} s d'observation)`, screenshot: shot, loaded: files };
    } catch (err) {
      return { status: "fail", detail: (err as Error).message.slice(0, 600) };
    } finally {
      await browser?.close().catch(() => {});
      await this.#previews.stop(preview.key);
    }
  }

  /** Vos parties gardées comme tests (ADR-85), rejouées dans le jeu de `cwd`, une à une, hors de l'écran. */
  async replays(cwd: string): Promise<CheckOutcome> {
    if (!isGodot(cwd)) return { status: "none", detail: "parties rejouées : jeux Godot seulement" };
    if (!existsSync(join(cwd, "studio", "replays"))) return { status: "none", detail: "aucune partie gardée comme test" };
    const godot = this.#godot();
    if (!godot) return { status: "none", detail: "Godot introuvable sur ce PC" };
    const imported = await godotImport(godot.exe, cwd, this.#testTimeoutMs);
    if (imported.status === "fail") return imported;
    return runSavedReplays(cwd, (c, f, w) => godotReplay(godot.exe, c, f, w));
  }

  /**
   * Les poses de contrôle (ADR-122) : une nouvelle instance du jeu, hors de l'écran, à côté de celle du lancement que la
   * mesure de performance a pu changer de scène. Pose, photo, pose suivante, dans un temps borné.
   */
  async poses(cwd: string, poses: PoseDeclared[], file: (pose: PoseDeclared, index: number) => string): Promise<PosePhoto[]> {
    const godot = this.#godot();
    if (!godot || !isGodot(cwd)) return poses.map((p) => ({ ...p, file: null, error: "Godot introuvable sur ce PC" }));
    const deadline = Date.now() + POSES_BUDGET_MS;
    const game = await GodotGame.start(godot.exe, cwd, {});
    try {
      await new Promise((r) => setTimeout(r, Math.min(this.#watchMs, 3000)));
      const out: PosePhoto[] = [];
      for (const [k, p] of poses.entries()) {
        const left = deadline - Date.now();
        if (left <= 0 || !game.alive) {
          out.push({ ...p, file: null, error: game.alive ? "temps dépassé pour les poses" : "le jeu s'est fermé" });
          continue;
        }
        const wait = Math.min(left, POSE_TIMEOUT_MS);
        const moved = await game.call("act", { steps: [{ do: "pose", name: p.nom }] }, wait);
        const note = !moved.ok ? String(moved.error ?? "le relais n'a pas répondu") : ((moved.notes as string[] | undefined)?.[0] ?? "");
        if (note) {
          out.push({ ...p, file: null, error: note.slice(0, 300) });
          continue;
        }
        const target = file(p, k);
        mkdirSync(dirname(target), { recursive: true });
        const shot = await game.call("capture", { path: target }, wait);
        out.push(shot.ok ? { ...p, file: target } : { ...p, file: null, error: String(shot.error || "photo impossible").slice(0, 300) });
      }
      return out;
    } finally {
      await game.close();
    }
  }

  /** Jeu Godot (ADR-73) : import, puis le jeu hors de l'écran avec le relais ; ses erreurs, une photo, les fichiers chargés. */
  async #launchGodot(cwd: string, screenshot: string | undefined, path: string): Promise<CheckOutcome> {
    const godot = this.#godot();
    if (!godot) return { status: "none", detail: "Godot introuvable sur ce PC" };
    if (!hasBridge(cwd)) return { status: "none", detail: "pas de relais du studio dans ce jeu (addons/studio_bridge)" };
    const imported = await godotImport(godot.exe, cwd, this.#testTimeoutMs);
    if (imported.status === "fail") return imported;
    let game: GodotGame;
    try {
      game = await GodotGame.start(godot.exe, cwd, { vitrine: vitrineOf(path) });
    } catch (err) {
      return { status: "fail", detail: (err as Error).message.slice(0, 600) };
    }
    try {
      await new Promise((r) => setTimeout(r, this.#watchMs));
      const snap = (await game.call("snapshot")).snapshot as { resources?: unknown; scene?: string; poses?: unknown } | undefined;
      const poses = declaredPoses(snap?.poses);
      const shot = screenshot ? ((await game.call("capture", { path: screenshot })).ok ? screenshot : null) : null;
      // Les performances, après la photo : sur vitrines/perf.tscn si le jeu l'a (la scène la plus chargée), sinon sur la
      // scène affichée. Un relais trop ancien ne sait pas mesurer (ADR-83).
      const perfScene = !vitrineOf(path) && existsSync(join(cwd, "vitrines", "perf.tscn")) ? "res://vitrines/perf.tscn" : "";
      const measured = await game.call("perf", { seconds: 3, scene: perfScene }, 30_000);
      const perf = measured.ok ? ((measured.perf as PerfSample | undefined) ?? null) : null;
      const errors = game.newErrors();
      const loaded = godotLoaded(snap?.resources);
      if (!game.alive) return { status: "fail", detail: `le jeu s'est fermé tout seul${errors.length ? ` : ${errors.slice(0, 4).join(" | ")}` : ""}`, screenshot: shot, loaded, perf };
      if (errors.length) return { status: "fail", detail: `erreurs dans le jeu : ${errors.slice(0, 4).join(" | ").slice(0, 600)}`, screenshot: shot, loaded, perf };
      return { status: "pass", detail: `lancé sans erreur (${Math.round(this.#watchMs / 1000)} s d'observation${snap?.scene ? `, scène ${snap.scene}` : ""})`, screenshot: shot, loaded, perf, ...(poses.length ? { poses } : {}) };
    } finally {
      await game.close();
    }
  }
}

const safeName = (s: string) => s.replace(/[^\w-]/g, "_");

/** Le temps des photos de contrôle, tout compris, et d'un seul aller-retour avec le relais (ADR-122). */
const POSES_BUDGET_MS = 120_000;
const POSE_TIMEOUT_MS = 30_000;

/** Ce que le relais rend pour `poses()`, nettoyé : jamais plus de 8, sans doublon ni nom vide. */
export function declaredPoses(raw: unknown): PoseDeclared[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: PoseDeclared[] = [];
  for (const p of raw as { nom?: unknown; description?: unknown }[]) {
    const nom = typeof p?.nom === "string" ? p.nom.trim().slice(0, 80) : "";
    if (!nom || seen.has(nom)) continue;
    seen.add(nom);
    out.push({ nom, description: typeof p.description === "string" ? p.description.slice(0, 300) : "" });
  }
  return out.slice(0, MAX_POSES);
}

/** La photo « en jeu » d'un chantier : prise par le Testeur là où le changement se voit (outil jouer, change=true, ADR-113). */
export function inGameShotPath(shotsDir: string, project: string, task: string): string {
  return join(shotsDir, safeName(project), `${safeName(task)}-en-jeu.jpg`);
}

export type TaskShot = { file: string; type: "image/png" | "image/jpeg"; kind: "in_game" | "launch" | "play" };

/**
 * Quelle capture montrer pour un chantier (ADR-113) :
 * 1. la photo « en jeu » du Testeur, si elle date de la dernière vérification (le hub reprend la capture du lancement
 *    juste avant chaque passage du Testeur : une photo en jeu plus ancienne montre une version d'avant la correction) ;
 * 2. sinon la capture du lancement prise par le hub (souvent le menu d'accueil) ;
 * 3. sinon la dernière photo prise par le Testeur en jouant (jeux Godot sans capture de lancement).
 */
export function pickTaskShot(shotsDir: string, project: string, task: string): TaskShot | null {
  const dir = join(shotsDir, safeName(project));
  const mtime = (f: string) => {
    try {
      return statSync(f).mtimeMs;
    } catch {
      return null;
    }
  };
  const launch = join(dir, `${safeName(task)}.png`);
  const inGame = inGameShotPath(shotsDir, project, task);
  const [l, g] = [mtime(launch), mtime(inGame)];
  const typeOf = (f: string): TaskShot["type"] => (sniffPng(f) ? "image/png" : "image/jpeg");
  if (g !== null && (l === null || g >= l)) return { file: inGame, type: typeOf(inGame), kind: "in_game" };
  if (l !== null) return { file: launch, type: "image/png", kind: "launch" };
  let play: { file: string; at: number } | null = null;
  try {
    for (const f of readdirSync(dir)) {
      if (!f.startsWith(`play-${safeName(task)}-`)) continue;
      const at = mtime(join(dir, f));
      if (at !== null && (!play || at > play.at)) play = { file: join(dir, f), at };
    }
  } catch {
    /* pas encore de dossier de captures */
  }
  return play ? { file: play.file, type: typeOf(play.file), kind: "play" } : null;
}

/** Le relais Godot écrit en PNG ou en JPEG selon l'extension demandée : on lit la signature plutôt que le nom. */
function sniffPng(file: string): boolean {
  try {
    const fd = openSync(file, "r");
    try {
      const head = Buffer.alloc(4);
      readSync(fd, head, 0, 4, 0);
      return head.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

/** « ?vitrine=A-0001 » (l'adresse d'un jeu web) devient l'argument du relais pour un jeu Godot. */
export function vitrineOf(path: string): string | null {
  return /[?&]vitrine=(A-\d{4,})/.exec(path)?.[1] ?? null;
}

/** Les chemins res:// que la scène utilise, à la façon d'un serveur web (« /assets/x.glb »), pour le bilan (ADR-71). */
export function godotLoaded(resources: unknown): string[] {
  return Array.isArray(resources) ? resources.filter((r): r is string => typeof r === "string" && r.startsWith("res://")).map((r) => `/${r.slice(6)}`).sort() : [];
}

/** Un port TCP libre à l'instant, choisi par le système (ADR-128). */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

/** Les scripts du package.json de `cwd` ; null s'il n'y en a pas ou s'il est illisible. */
export function readScripts(cwd: string): Record<string, string> | null {
  const pkg = join(cwd, "package.json");
  if (!existsSync(pkg)) return null;
  try {
    return (JSON.parse(readFileSync(pkg, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {};
  } catch {
    return null;
  }
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === "win32") execFile("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }, () => {});
  else {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* déjà arrêté */
    }
  }
}
