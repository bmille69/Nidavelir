import { spawn, execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Clock } from "../clock.ts";
import type { Db } from "../db/database.ts";
import { PreviewService } from "../executor/preview.ts";
import type { Journal } from "../journal/journal.ts";
import type { ProjectRegistry } from "../projects/project-registry.ts";
import { GodotGame, godotImport, godotTests } from "../godot/run.ts";
import { hasBridge, hasStudioTests, isGodot, type GodotInstall } from "../godot/toolchain.ts";

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
};

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
  /** Mêmes vérifications sur le jeu actuel, faites seulement si le chantier échoue : l'échec était-il déjà là ? */
  before: { tests: CheckOutcome | null; launch: CheckOutcome | null };
  /** Performances du jeu Godot face à son budget (ADR-83) ; absent pour un jeu web ou un relais trop ancien. */
  perf?: PerfCheck | null;
  /** Le chantier casse quelque chose qui marchait. */
  regression: boolean;
  at: string;
};

/** Ce qui sait lancer les tests et le jeu (remplacé par un faux dans les tests du hub). */
export interface CheckerPort {
  tests(cwd: string): Promise<CheckOutcome>;
  /** `screenshot` : où enregistrer la capture de l'écran (aucune si absent) ; `path` : ajouté à l'adresse du jeu (« ?vitrine=A-0001 »). */
  launch(key: string, cwd: string, screenshot?: string, path?: string): Promise<CheckOutcome>;
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

  constructor(deps: { db: Db; clock: Clock; journal: Journal; projects: ProjectRegistry; checker: CheckerPort; shotsDir: string; perfBudget?: PerfBudget }) {
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

  async run(project: string, task: string, worktree: string): Promise<CheckReport> {
    const root = this.#projects.get(project).root;
    const safe = (p: Promise<CheckOutcome>) => p.catch((err: Error): CheckOutcome => ({ status: "none", detail: `vérification impossible : ${err.message.slice(0, 300)}` }));
    const tests = await safe(this.#checker.tests(worktree));
    const shot = this.screenshotPath(project, task);
    mkdirSync(dirname(shot), { recursive: true });
    const launch = await safe(this.#checker.launch(`${project}/check-${task}`, worktree, shot));
    const before = {
      tests: tests.status === "fail" ? await safe(this.#checker.tests(root)) : null,
      launch: launch.status === "fail" ? await safe(this.#checker.launch(`${project}/check-jeu`, root)) : null,
    };
    const perf = launch.perf ? await this.#perf(project, root, launch.perf, safe) : null;
    const regression = (tests.status === "fail" && before.tests?.status !== "fail") || (launch.status === "fail" && before.launch?.status !== "fail") || !!perf?.regression;
    const report: CheckReport = { tests, launch, before, perf, regression, at: this.#clock.now() };
    this.#db
      .prepare("INSERT INTO checks (project, task, data_json, at) VALUES (?, ?, ?, ?) ON CONFLICT (project, task) DO UPDATE SET data_json = excluded.data_json, at = excluded.at")
      .run(project, task, JSON.stringify(report), report.at);
    this.#journal.append({
      project,
      actor: { kind: "system" },
      type: "check.done",
      subject: task,
      payload: { tests: tests.status, launch: launch.status, regression, ...(perf ? { perf: perf.status, fps: perf.sample.fps } : {}) },
    });
    return report;
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
  const parts = [part("tests du jeu", c.tests, c.before.tests), part("le jeu se lance", c.launch, c.before.launch), perf].filter(Boolean);
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
  return [line("Tests du jeu (npm test)", c.tests, c.before.tests), line("Le jeu se lance dans le navigateur", c.launch, c.before.launch), perf].filter(Boolean).join("\n");
}

/** Ce qu'il faut dire au développeur quand le hub trouve une régression. */
export function regressionFeedback(c: CheckReport): string {
  const lines = ["Le hub a vérifié ton travail lui-même et il a cassé quelque chose qui marchait avant :"];
  if (c.tests.status === "fail" && c.before.tests?.status !== "fail") lines.push(`- Les tests du jeu (npm test) ne passent plus. Fin de la sortie :\n${c.tests.detail}`);
  if (c.launch.status === "fail" && c.before.launch?.status !== "fail") lines.push(`- Le jeu ne se lance plus correctement dans le navigateur : ${c.launch.detail}`);
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
  readonly #watchMs: number;

  readonly #godot: () => GodotInstall | null;

  constructor(options: { workDir: string; testTimeoutMs?: number; watchMs?: number; godot?: () => GodotInstall | null }) {
    // Instance à part : ne coupe jamais le jeu que vous êtes en train d'essayer.
    this.#previews = new PreviewService({ workDir: options.workDir });
    this.#testTimeoutMs = options.testTimeoutMs ?? 5 * 60_000;
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
    return new Promise((resolve) => {
      // Commande fixe, sans argument venu de l'extérieur.
      const child = spawn("npm test", {
        cwd,
        shell: true,
        windowsHide: true,
        env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
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
        resolve({ status: "fail", detail: `les tests ne se sont pas terminés en ${Math.round(this.#testTimeoutMs / 60_000)} min` });
      }, this.#testTimeoutMs);
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
      const snap = (await game.call("snapshot")).snapshot as { resources?: unknown; scene?: string } | undefined;
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
      return { status: "pass", detail: `lancé sans erreur (${Math.round(this.#watchMs / 1000)} s d'observation${snap?.scene ? `, scène ${snap.scene}` : ""})`, screenshot: shot, loaded, perf };
    } finally {
      await game.close();
    }
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

function readScripts(cwd: string): Record<string, string> | null {
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
