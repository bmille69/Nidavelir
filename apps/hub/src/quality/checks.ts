import { spawn, execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Clock } from "../clock.ts";
import type { Db } from "../db/database.ts";
import { PreviewService } from "../executor/preview.ts";
import type { Journal } from "../journal/journal.ts";
import type { ProjectRegistry } from "../projects/project-registry.ts";

/** Résultat d'une vérification faite par le hub lui-même ; « none » = rien à vérifier ou impossible ici. */
export type CheckOutcome = { status: "pass" | "fail" | "none"; detail: string; /** Capture de l'écran du jeu (lancement), si prise. */ screenshot?: string | null };

/** Vérifications objectives d'un chantier, avant sa fusion (ADR-32). */
export type CheckReport = {
  /** Tests du jeu (`npm test`) dans la copie du chantier. */
  tests: CheckOutcome;
  /** Le jeu se lance (`npm run dev` + navigateur invisible, sans erreur). */
  launch: CheckOutcome;
  /** Mêmes vérifications sur le jeu actuel, faites seulement si le chantier échoue : l'échec était-il déjà là ? */
  before: { tests: CheckOutcome | null; launch: CheckOutcome | null };
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

  constructor(deps: { db: Db; clock: Clock; journal: Journal; projects: ProjectRegistry; checker: CheckerPort; shotsDir: string }) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#journal = deps.journal;
    this.#projects = deps.projects;
    this.#checker = deps.checker;
    this.#shotsDir = deps.shotsDir;
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
    const regression = (tests.status === "fail" && before.tests?.status !== "fail") || (launch.status === "fail" && before.launch?.status !== "fail");
    const report: CheckReport = { tests, launch, before, regression, at: this.#clock.now() };
    this.#db
      .prepare("INSERT INTO checks (project, task, data_json, at) VALUES (?, ?, ?, ?) ON CONFLICT (project, task) DO UPDATE SET data_json = excluded.data_json, at = excluded.at")
      .run(project, task, JSON.stringify(report), report.at);
    this.#journal.append({
      project,
      actor: { kind: "system" },
      type: "check.done",
      subject: task,
      payload: { tests: tests.status, launch: launch.status, regression },
    });
    return report;
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
  const parts = [part("tests du jeu", c.tests, c.before.tests), part("le jeu se lance", c.launch, c.before.launch)].filter(Boolean);
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
  return [line("Tests du jeu (npm test)", c.tests, c.before.tests), line("Le jeu se lance dans le navigateur", c.launch, c.before.launch)].join("\n");
}

/** Ce qu'il faut dire au développeur quand le hub trouve une régression. */
export function regressionFeedback(c: CheckReport): string {
  const lines = ["Le hub a vérifié ton travail lui-même et il a cassé quelque chose qui marchait avant :"];
  if (c.tests.status === "fail" && c.before.tests?.status !== "fail") lines.push(`- Les tests du jeu (npm test) ne passent plus. Fin de la sortie :\n${c.tests.detail}`);
  if (c.launch.status === "fail" && c.before.launch?.status !== "fail") lines.push(`- Le jeu ne se lance plus correctement dans le navigateur : ${c.launch.detail}`);
  return lines.join("\n");
}

/** Vérifications réelles : `npm test`, puis le jeu dans Edge (ou Chrome) invisible. */
export class RealChecker implements CheckerPort {
  readonly #previews: PreviewService;
  readonly #testTimeoutMs: number;
  readonly #watchMs: number;

  constructor(options: { workDir: string; testTimeoutMs?: number; watchMs?: number }) {
    // Instance à part : ne coupe jamais le jeu que vous êtes en train d'essayer.
    this.#previews = new PreviewService({ workDir: options.workDir });
    this.#testTimeoutMs = options.testTimeoutMs ?? 5 * 60_000;
    this.#watchMs = options.watchMs ?? 6000;
  }

  async tests(cwd: string): Promise<CheckOutcome> {
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
      await page.goto(path ? `${preview.url.replace(/\/$/, "")}/${path.replace(/^\//, "")}` : preview.url, { waitUntil: "load", timeout: 60_000 });
      await page.waitForTimeout(this.#watchMs);
      const empty = (await page.evaluate("!document.body || document.body.children.length === 0")) as boolean;
      // La capture est prise même en cas d'erreur : elle montre ce qui ne va pas (ADR-33).
      const shot = screenshot ? await page.screenshot({ path: screenshot, fullPage: true }).then(() => screenshot, () => null) : null;
      if (errors.length) return { status: "fail", detail: `erreurs dans la page : ${[...new Set(errors)].slice(0, 4).join(" | ").slice(0, 600)}`, screenshot: shot };
      if (empty) return { status: "fail", detail: "la page reste vide", screenshot: shot };
      return { status: "pass", detail: `lancé sans erreur (${Math.round(this.#watchMs / 1000)} s d'observation)`, screenshot: shot };
    } catch (err) {
      return { status: "fail", detail: (err as Error).message.slice(0, 600) };
    } finally {
      await browser?.close().catch(() => {});
      await this.#previews.stop(preview.key);
    }
  }
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
