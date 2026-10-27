import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { assertHumanSession, type HumanSession } from "../auth/human-session.ts";
import type { Clock } from "../clock.ts";
import type { Db } from "../db/database.ts";
import type { TaskService } from "../executor/task-service.ts";
import type { OrchestratorPort } from "../orchestrator/port.ts";
import type { ProjectRegistry } from "../projects/project-registry.ts";
import { decodePng, type Pixels } from "../art/visual-diff.ts";
import type { CheckService } from "../quality/checks.ts";
import { describeChecks } from "../quality/checks.ts";
import { encodeGif, fit } from "./gif.ts";
import type { Journal } from "./journal.ts";

/**
 * Le journal de bord (ADR-89) : semaine par semaine, chaque fusion avec sa capture du jeu, ses vérifications et son coût ;
 * les visuels intégrés ; les chiffres de la semaine ; un GIF du jeu qui change, une image par fusion. Tout cela sans
 * modèle. Sur votre demande seulement, le directeur raconte la semaine en quelques lignes.
 */

export type LogEntry = { task: string; title: string; at: string; summary: string; costUsd: number; checks: string; shot: boolean };
export type LogVisual = { id: string; name: string; image: string | null; task: string | null; at: string };
export type LogWeek = {
  week: string;
  from: string;
  to: string;
  previous: string | null;
  next: string | null;
  entries: LogEntry[];
  visuals: LogVisual[];
  facts: { merged: number; failed: number; costUsd: number; visuals: number; balanceRuns: number; benchRuns: number; replaysSaved: number };
  gif: boolean;
  story: { text: string; at: string } | null;
};

const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");
/** Le lundi (heure locale) de la semaine d'une date, « AAAA-MM-JJ ». */
export function weekOf(iso: string): string {
  const d = new Date(iso);
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7));
  return `${monday.getFullYear()}-${pad(monday.getMonth() + 1)}-${pad(monday.getDate())}`;
}
function bounds(week: string): { from: string; to: string } {
  const [y, m, d] = week.split("-").map(Number) as [number, number, number];
  const from = new Date(y, m - 1, d);
  const to = new Date(y, m - 1, d + 7);
  return { from: from.toISOString(), to: to.toISOString() };
}

type Event = { at: string; type: string; subject: string | null; payload_json: string };

export class LogbookService {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #journal: Journal;
  readonly #projects: ProjectRegistry;
  readonly #tasks: TaskService;
  readonly #checks: CheckService | null;
  readonly #orchestrator: OrchestratorPort;
  readonly #dir: string;
  /** Nom et image d'un visuel du DA (branché par le hub). */
  asset: ((project: string, id: string) => { name: string; image: string | null } | null) | null = null;

  constructor(deps: { db: Db; clock: Clock; journal: Journal; projects: ProjectRegistry; tasks: TaskService; checks: CheckService | null; orchestrator: OrchestratorPort; dataDir: string }) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#journal = deps.journal;
    this.#projects = deps.projects;
    this.#tasks = deps.tasks;
    this.#checks = deps.checks;
    this.#orchestrator = deps.orchestrator;
    this.#dir = join(deps.dataDir, "logbook");
  }

  #events(project: string, from: string, to: string, types: string[]): Event[] {
    return this.#db
      .prepare(`SELECT at, type, subject, payload_json FROM events WHERE project = ? AND at >= ? AND at < ? AND type IN (${types.map(() => "?").join(", ")}) ORDER BY seq`)
      .all(project, from, to, ...types) as Event[];
  }

  /** Les semaines où le jeu a bougé, la plus récente d'abord. */
  weeks(project: string): string[] {
    const rows = this.#db.prepare("SELECT at FROM events WHERE project = ? AND type IN ('task.merged', 'art.asset_integrated') ORDER BY seq").all(project) as { at: string }[];
    return [...new Set(rows.map((r) => weekOf(r.at)))].reverse();
  }

  week(project: string, week?: string): LogWeek {
    this.#projects.get(project);
    const all = this.weeks(project);
    const w = week ?? all[0] ?? weekOf(this.#clock.now());
    const { from, to } = bounds(w);
    const merged = this.#events(project, from, to, ["task.merged"]);
    const entries: LogEntry[] = merged.flatMap((e) => {
      try {
        const t = this.#tasks.get(project, e.subject!);
        const runs = this.#tasks.runs(project, t.id);
        const report = runs.filter((r) => r.kind === "execute").at(-1)?.result?.report ?? null;
        const check = this.#checks?.get(project, t.id) ?? null;
        const shot = this.#checks ? existsSync(this.#checks.screenshotPath(project, t.id)) : false;
        return [{ task: t.id, title: t.title, at: e.at, summary: report?.summary_simple ?? "", costUsd: Math.round(runs.reduce((a, r) => a + (r.cost_usd ?? 0), 0) * 100) / 100, checks: check ? describeChecks(check) : "", shot }];
      } catch {
        return [];
      }
    });
    const visuals: LogVisual[] = this.#events(project, from, to, ["art.asset_integrated"]).map((e) => {
      const a = this.asset?.(project, e.subject!) ?? null;
      return { id: e.subject!, name: a?.name ?? e.subject!, image: a?.image ?? null, task: (JSON.parse(e.payload_json) as { task?: string }).task ?? null, at: e.at };
    });
    const failed = (this.#db.prepare("SELECT COUNT(DISTINCT subject) AS n FROM events WHERE project = ? AND at >= ? AND at < ? AND type = 'run.failed'").get(project, from, to) as { n: number }).n;
    const count = (type: string) => (this.#db.prepare("SELECT COUNT(*) AS n FROM events WHERE project = ? AND at >= ? AND at < ? AND type = ?").get(project, from, to, type) as { n: number }).n;
    const idx = all.indexOf(w);
    const story = this.#db.prepare("SELECT text, at FROM logbook_weeks WHERE project = ? AND week = ?").get(project, w) as { text: string; at: string } | undefined;
    return {
      week: w,
      from,
      to,
      previous: idx >= 0 ? (all[idx + 1] ?? null) : (all.find((x) => x < w) ?? null),
      next: idx > 0 ? all[idx - 1]! : null,
      entries,
      visuals,
      facts: {
        merged: entries.length,
        failed,
        costUsd: Math.round(entries.reduce((a, e) => a + e.costUsd, 0) * 100) / 100,
        visuals: visuals.length,
        balanceRuns: count("balance.ran"),
        benchRuns: count("bench.ran"),
        replaysSaved: count("replay.saved"),
      },
      gif: entries.filter((e) => e.shot).length >= 2,
      story: story ?? null,
    };
  }

  /** Le GIF de la semaine : les captures des fusions dans l'ordre, la dernière tenue plus longtemps. Gardé en cache. */
  gif(project: string, week: string): Buffer | null {
    if (!this.#checks) return null;
    const w = this.week(project, week);
    const shots = w.entries.filter((e) => e.shot).map((e) => this.#checks!.screenshotPath(project, e.task));
    if (shots.length < 2) return null;
    const dir = join(this.#dir, project.replace(/[^\w-]/g, "_"));
    const file = join(dir, `${w.week}-${shots.length}.gif`);
    if (existsSync(file)) return readFileSync(file);
    const frames: Pixels[] = [];
    for (const s of shots) {
      try {
        frames.push(fit(decodePng(readFileSync(s)), 640, 360));
      } catch {
        /* capture illisible : passée */
      }
    }
    if (frames.length < 2) return null;
    const gif = encodeGif(frames, frames.map((_, k) => (k === frames.length - 1 ? 300 : 120)));
    mkdirSync(dir, { recursive: true });
    for (const old of readdirSync(dir).filter((f) => f.startsWith(`${w.week}-`))) rmSync(join(dir, old), { force: true });
    writeFileSync(file, gif);
    return gif;
  }

  /** « Raconter la semaine » : le directeur en fait quelques lignes, à partir des faits seulement. */
  async tell(session: HumanSession, project: string, week: string): Promise<LogWeek> {
    assertHumanSession(session);
    const w = this.week(project, week);
    if (!w.entries.length && !w.visuals.length) throw new Error("Rien n'a été fusionné cette semaine-là");
    const facts = [
      `Semaine du ${w.week} — ${this.#projects.get(project).name}`,
      `${w.facts.merged} chantier(s) fusionné(s), ${w.facts.failed} run(s) en échec, ${w.facts.visuals} visuel(s) intégré(s), ${w.facts.costUsd.toFixed(2)} $ de chantiers.`,
      ...w.entries.map((e) => `- ${e.task} « ${e.title} » : ${e.summary || "(sans compte rendu)"} ${e.checks}`),
      ...w.visuals.map((v) => `- visuel ${v.id} « ${v.name} » intégré${v.task ? ` par ${v.task}` : ""}`),
      w.facts.balanceRuns ? `L'équilibreur a tourné ${w.facts.balanceRuns} fois.` : "",
      w.facts.benchRuns ? `Le banc d'essai a tourné ${w.facts.benchRuns} fois.` : "",
      w.facts.replaysSaved ? `${w.facts.replaysSaved} partie(s) gardée(s) comme test.` : "",
    ].filter(Boolean);
    const { text } = await this.#orchestrator.reply({
      systemPrompt:
        "Tu es le directeur du studio. Tu écris le journal de bord d'un jeu vidéo pour son directeur créatif : en français, 5 à 8 lignes, concret, sans jargon, sans flatterie. Ce qui a changé pour le joueur d'abord, puis ce qui a coûté ou résisté, puis une seule suggestion pour la semaine suivante. N'invente rien : tu n'as que les faits fournis.",
      prompt: facts.join("\n"),
      meta: { project, agent: "director" },
    });
    const at = this.#clock.now();
    this.#db.prepare("INSERT INTO logbook_weeks (project, week, text, at) VALUES (?, ?, ?, ?) ON CONFLICT (project, week) DO UPDATE SET text = excluded.text, at = excluded.at").run(project, w.week, text.trim(), at);
    this.#journal.append({ project, actor: { kind: "human" }, type: "logbook.told", subject: w.week, payload: {} });
    return this.week(project, w.week);
  }
}
