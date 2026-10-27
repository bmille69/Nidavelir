import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { assertHumanSession, type HumanSession } from "../auth/human-session.ts";
import type { Clock } from "../clock.ts";
import type { Journal } from "../journal/journal.ts";
import type { ProjectRegistry } from "../projects/project-registry.ts";
import type { VcsPort } from "../vcs/git.ts";
import { godotImport, godotReplay, type ReplayResult } from "../godot/run.ts";
import { hasBridge, isGodot, type GodotInstall } from "../godot/toolchain.ts";
import type { CheckOutcome } from "./checks.ts";

/**
 * Vos parties enregistrées, puis rejouées comme tests (ADR-85). « ▶ Essayer » un jeu Godot enregistre la partie (vos
 * entrées image par image, le hasard du jeu, son état toutes les demi-secondes) dans les données du hub. Celle que vous
 * gardez devient un test du jeu (studio/replays/), rejoué à chaque chantier : le jeu doit retrouver le même état.
 */

export class ReplayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayError";
  }
}

export type ReplayHeader = { studio_replay: 1; seed: number; window: [number, number]; godot?: string; at?: string; name?: string; note?: string; saved_at?: string; from?: string };

/** Ce qu'une partie contient, lu dans son fichier. */
export type RecordingInfo = { id: string; task: string | null; at: string; seconds: number; inputs: number; checkpoints: number; finalState: string | null };
export type SavedReplay = { file: string; name: string; note: string; seconds: number; inputs: number; saved_at: string | null };

export const REPLAY_DIR = "studio/replays";

export function readReplay(file: string): { header: ReplayHeader; seconds: number; inputs: number; checkpoints: number; finalState: string | null } | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  let header: ReplayHeader;
  try {
    header = JSON.parse(lines[0] ?? "") as ReplayHeader;
  } catch {
    return null;
  }
  if (header?.studio_replay !== 1) return null;
  let frames = 0;
  let inputs = 0;
  let checkpoints = 0;
  let finalState: string | null = null;
  for (const l of lines.slice(1)) {
    try {
      const d = JSON.parse(l) as { f?: number; e?: { t?: string }; s?: string };
      frames = Math.max(frames, d.f ?? 0);
      // Les mouvements de souris ne comptent pas comme des actions du joueur.
      if (d.e && d.e.t !== "mm") inputs++;
      if (typeof d.s === "string" && d.s) {
        checkpoints++;
        finalState = d.s;
      }
    } catch {
      /* ligne coupée (jeu arrêté net) : ignorée */
    }
  }
  return { header, seconds: Math.round((frames / 60) * 10) / 10, inputs, checkpoints, finalState };
}

/** Rejoue une partie et dit ce qui a divergé, en clair. */
export function describeReplay(name: string, r: { result: ReplayResult | null; errors: string[] }): { ok: boolean; text: string } {
  if (r.errors.length) return { ok: false, text: `« ${name} » : le jeu a écrit des erreurs pendant la partie : ${r.errors.slice(0, 3).join(" | ")}` };
  if (!r.result) return { ok: false, text: `« ${name} » : la partie n'a pas pu être rejouée (relais du studio absent ou trop ancien, ou le jeu s'est fermé)` };
  if (r.result.error) return { ok: false, text: `« ${name} » : ${r.result.error}` };
  if (!r.result.ok) {
    const m = r.result.mismatches[0];
    return { ok: false, text: `« ${name} » : à ${m?.seconde ?? "?"} s, l'état du jeu était ${m?.attendu ?? "?"} quand vous avez joué, et ${m?.obtenu ?? "?"} en rejouant la même partie` };
  }
  return { ok: true, text: `« ${name} » : rejouée à l'identique (${r.result.checked} points de contrôle)` };
}

export class ReplayService {
  readonly #dir: string;
  readonly #projects: ProjectRegistry;
  readonly #vcs: VcsPort;
  readonly #journal: Journal;
  readonly #clock: Clock;
  readonly #godot: () => GodotInstall | null;
  /** Remplaçable dans les tests : rejouer une partie dans le jeu de `cwd`. */
  replay: (cwd: string, file: string, window: [number, number] | null) => Promise<{ result: ReplayResult | null; errors: string[] }>;

  constructor(deps: { dataDir: string; projects: ProjectRegistry; vcs: VcsPort; journal: Journal; clock: Clock; godot: () => GodotInstall | null }) {
    this.#dir = join(deps.dataDir, "recordings");
    this.#projects = deps.projects;
    this.#vcs = deps.vcs;
    this.#journal = deps.journal;
    this.#clock = deps.clock;
    this.#godot = deps.godot;
    this.replay = async (cwd, file, window) => {
      const godot = this.#godot();
      if (!godot) return { result: { ok: false, frames: 0, events: 0, checked: 0, mismatches: [], error: "Godot introuvable sur ce PC" }, errors: [] };
      const imported = await godotImport(godot.exe, cwd);
      if (imported.status === "fail") return { result: { ok: false, frames: 0, events: 0, checked: 0, mismatches: [], error: imported.detail }, errors: [] };
      return godotReplay(godot.exe, cwd, file, window);
    };
  }

  #projectDir(project: string): string {
    return join(this.#dir, project.replace(/[^\w-]/g, "_"));
  }

  /** Où « ▶ Essayer » enregistre la prochaine partie d'un jeu Godot qui a le relais ; null sinon. */
  recordPath(project: string, task: string | null, cwd: string): string | null {
    if (!isGodot(cwd) || !hasBridge(cwd)) return null;
    const dir = this.#projectDir(project);
    mkdirSync(dir, { recursive: true });
    const stamp = this.#clock.now().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");
    return join(dir, `${stamp}-${(task ?? "jeu").toLowerCase()}.jsonl`);
  }

  /** Vos parties récentes (7 jours), sans celles où vous n'avez rien fait. */
  recordings(project: string): RecordingInfo[] {
    const dir = this.#projectDir(project);
    if (!existsSync(dir)) return [];
    const out: RecordingInfo[] = [];
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".jsonl"))) {
      const file = join(dir, f);
      const age = Date.now() - statSync(file).mtimeMs;
      const r = readReplay(file);
      if (age > 7 * 86_400_000 || (r && r.inputs === 0 && age > 60_000)) {
        rmSync(file, { force: true });
        continue;
      }
      if (!r || r.inputs === 0) continue;
      const task = /-(t-\d{4,})\.jsonl$/.exec(f)?.[1]?.toUpperCase() ?? null;
      out.push({ id: f.replace(/\.jsonl$/, ""), task, at: r.header.at ?? "", seconds: r.seconds, inputs: r.inputs, checkpoints: r.checkpoints, finalState: r.finalState });
    }
    return out.sort((a, b) => b.id.localeCompare(a.id));
  }

  /** Les parties gardées comme tests du jeu. */
  saved(project: string): SavedReplay[] {
    const dir = join(this.#projects.get(project).root, REPLAY_DIR);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".jsonl"))
      .flatMap((f) => {
        const r = readReplay(join(dir, f));
        return r ? [{ file: f, name: r.header.name ?? f, note: r.header.note ?? "", seconds: r.seconds, inputs: r.inputs, saved_at: r.header.saved_at ?? null }] : [];
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  #file(project: string, id: string): string {
    if (!/^[\w-]{1,80}$/.test(id)) throw new ReplayError("Partie inconnue");
    const file = join(this.#projectDir(project), `${id}.jsonl`);
    if (!existsSync(file)) throw new ReplayError("Cette partie n'existe plus");
    return file;
  }

  remove(session: HumanSession, project: string, id: string): void {
    assertHumanSession(session);
    rmSync(this.#file(project, id), { force: true });
  }

  /**
   * « En faire un test » : la partie est rejouée deux fois sur la version actuelle du jeu. Si elle ne se rejoue pas à
   * l'identique (hasard sans graine, temps réel…), elle serait un test qui échoue au hasard : refusée, en disant pourquoi.
   */
  async save(session: HumanSession, project: string, id: string, input: { name: string; note?: string }): Promise<SavedReplay> {
    assertHumanSession(session);
    const name = input.name.trim().slice(0, 80);
    if (!name) throw new ReplayError("Donnez un nom à cette partie");
    const file = this.#file(project, id);
    const info = readReplay(file);
    if (!info?.checkpoints) throw new ReplayError("Cette partie n'a aucun état du jeu à comparer : le jeu n'a pas de nœud « studio_test » avec snapshot()");
    const root = this.#projects.get(project).root;
    for (let k = 0; k < 2; k++) {
      const r = describeReplay(name, await this.replay(root, file, info.header.window));
      if (!r.ok) throw new ReplayError(`Cette partie ne se rejoue pas à l'identique sur la version actuelle du jeu, elle ferait un test qui échoue au hasard. ${r.text}`);
    }
    const slug = name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50) || "partie";
    const dir = join(root, REPLAY_DIR);
    mkdirSync(dir, { recursive: true });
    let target = `${slug}.jsonl`;
    for (let i = 2; existsSync(join(dir, target)); i++) target = `${slug}-${i}.jsonl`;
    const lines = readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l.trim());
    const header: ReplayHeader = { ...info.header, name, note: (input.note ?? "").trim().slice(0, 500), saved_at: this.#clock.now(), from: basename(file) };
    writeFileSync(join(dir, target), [JSON.stringify(header), ...lines.slice(1)].join("\n") + "\n", "utf8");
    await this.#vcs.commitPaths(root, [`${REPLAY_DIR}/${target}`], `studio: partie « ${name} » gardée comme test (rejouée à chaque chantier)`);
    rmSync(file, { force: true });
    this.#journal.append({ project, actor: { kind: "human" }, type: "replay.saved", subject: target, payload: { name, seconds: info.seconds, inputs: info.inputs } });
    return this.saved(project).find((s) => s.file === target)!;
  }

  async unsave(session: HumanSession, project: string, file: string): Promise<void> {
    assertHumanSession(session);
    if (!/^[\w-]{1,80}\.jsonl$/.test(file)) throw new ReplayError("Test inconnu");
    const root = this.#projects.get(project).root;
    const path = join(root, REPLAY_DIR, file);
    if (!existsSync(path)) throw new ReplayError("Ce test n'existe plus");
    rmSync(path);
    await this.#vcs.commitPaths(root, [REPLAY_DIR], `studio: partie ${file} retirée des tests`);
    this.#journal.append({ project, actor: { kind: "human" }, type: "replay.removed", subject: file, payload: {} });
  }
}

/** Les parties gardées d'une copie de travail (ou du jeu), rejouées une à une : la vérification du hub (ADR-85). */
export async function runSavedReplays(
  cwd: string,
  replay: (cwd: string, file: string, window: [number, number] | null) => Promise<{ result: ReplayResult | null; errors: string[] }>,
): Promise<CheckOutcome> {
  const dir = join(cwd, REPLAY_DIR);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort() : [];
  if (!files.length) return { status: "none", detail: "aucune partie gardée comme test" };
  const lines: string[] = [];
  let failed = 0;
  for (const f of files) {
    const info = readReplay(join(dir, f));
    if (!info) continue;
    const r = describeReplay(info.header.name ?? f, await replay(cwd, join(dir, f), info.header.window));
    if (!r.ok) failed++;
    lines.push(`${r.ok ? "✓" : "✗"} ${r.text}${!r.ok && info.header.note ? ` (ce que vous vérifiiez : ${info.header.note})` : ""}`);
  }
  return { status: failed ? "fail" : "pass", detail: `${files.length - failed}/${files.length} partie(s) rejouée(s) à l'identique\n${lines.join("\n")}` };
}
