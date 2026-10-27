import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createServer, connect, type Socket } from "node:net";

/**
 * Lancer Godot pour le hub (ADR-73) : importer le projet, lancer ses tests, ou ouvrir le jeu avec le relais du studio
 * (fenêtre hors de l'écran, pilotée en local par addons/studio_bridge). Les erreurs que Godot écrit sont recueillies.
 */

export type GodotOutcome = { status: "pass" | "fail" | "none"; detail: string };

const ANSI = /\x1b\[[0-9;]*m/g;
/** Lignes d'erreur de Godot (le moteur ou les scripts du jeu). */
const ERROR_LINE = /^(SCRIPT ERROR|USER SCRIPT ERROR|USER ERROR|ERROR|Parse Error)\b/;

export function godotErrors(log: string): string[] {
  const out: string[] = [];
  const lines = log.replace(ANSI, "").split(/\r?\n/);
  lines.forEach((l, i) => {
    if (!ERROR_LINE.test(l.trim())) return;
    const where = lines[i + 1]?.trim().startsWith("at:") ? ` (${lines[i + 1]!.trim().slice(3).trim()})` : "";
    const text = `${l.trim()}${where}`.slice(0, 300);
    if (!out.includes(text)) out.push(text);
  });
  return out.slice(0, 20);
}

function run(exe: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; log: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    execFile(exe, args, { cwd, windowsHide: true, timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
      resolve({ code: e ? (typeof e.code === "number" ? e.code : null) : 0, log: `${stdout}\n${stderr}`, timedOut: !!e?.killed });
    });
  });
}

/** Importe les ressources du projet (cache .godot) : à faire avant de lancer le jeu ou ses tests dans une copie. */
export async function godotImport(exe: string, cwd: string, timeoutMs = 5 * 60_000): Promise<GodotOutcome> {
  const r = await run(exe, ["--headless", "--path", cwd, "--import"], cwd, timeoutMs);
  if (r.timedOut) return { status: "fail", detail: `l'import du projet ne s'est pas terminé en ${Math.round(timeoutMs / 60_000)} min` };
  const errors = godotErrors(r.log);
  return errors.length ? { status: "fail", detail: `erreurs à l'import : ${errors.slice(0, 6).join(" | ")}` } : { status: "pass", detail: "projet importé sans erreur" };
}

/**
 * Les tests du jeu (addons/studio_tests) : import, puis lanceur. Échec si un test échoue, si le lanceur ne finit pas,
 * ou si un script plante pendant les tests (une erreur de script n'arrête pas Godot : on la lit dans sa sortie).
 */
export async function godotTests(exe: string, cwd: string, timeoutMs = 5 * 60_000): Promise<GodotOutcome> {
  const imported = await godotImport(exe, cwd, timeoutMs);
  if (imported.status === "fail") return imported;
  const r = await run(exe, ["--headless", "--path", cwd, "-s", "res://addons/studio_tests/run.gd"], cwd, timeoutMs);
  const log = r.log.replace(ANSI, "");
  const tail = log
    .split(/\r?\n/)
    .filter((l) => l.trim() && !/^Godot Engine v/.test(l))
    .slice(-40)
    .join("\n")
    .slice(-1500);
  if (r.timedOut) return { status: "fail", detail: `les tests ne se sont pas terminés en ${Math.round(timeoutMs / 60_000)} min\n${tail}` };
  const summary = /STUDIO_TESTS: (\d+) réussis, (\d+) échoués/.exec(log);
  if (!summary) return { status: "fail", detail: `le lanceur de tests n'a pas rendu de bilan\n${tail}` };
  const errors = godotErrors(log);
  if (Number(summary[2]) > 0 || r.code !== 0) return { status: "fail", detail: tail };
  if (errors.length) return { status: "fail", detail: `tests réussis, mais des scripts ont planté pendant les tests : ${errors.slice(0, 6).join(" | ")}\n${tail}` };
  if (Number(summary[1]) === 0) return { status: "none", detail: "aucun test dans res://tests" };
  return { status: "pass", detail: tail };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

export type GameScreen = "pc" | "phone";
const SIZES: Record<GameScreen, string> = { pc: "1280x720", phone: "390x844" };

/**
 * Une partie de Godot pilotée par le relais. La fenêtre est placée hors de l'écran : elle s'affiche (donc les photos
 * marchent) sans gêner celui qui travaille sur le PC.
 */
export class GodotGame {
  readonly screen: GameScreen;
  readonly #child: ChildProcess;
  readonly #socket: Socket;
  #log = "";
  #seen = 0;
  #buffer = "";
  #waiters: ((v: Record<string, unknown>) => void)[] = [];
  #id = 0;

  private constructor(child: ChildProcess, socket: Socket, screen: GameScreen, log: () => string) {
    this.#child = child;
    this.#socket = socket;
    this.screen = screen;
    this.#readLog = log;
    socket.setEncoding("utf8");
    socket.on("data", (d: string) => {
      this.#buffer += d;
      let i;
      while ((i = this.#buffer.indexOf("\n")) >= 0) {
        const line = this.#buffer.slice(0, i);
        this.#buffer = this.#buffer.slice(i + 1);
        try {
          this.#waiters.shift()?.(JSON.parse(line) as Record<string, unknown>);
        } catch {
          this.#waiters.shift()?.({ ok: false, error: "réponse illisible du relais" });
        }
      }
    });
    socket.on("close", () => {
      for (const w of this.#waiters.splice(0)) w({ ok: false, error: "le jeu s'est fermé" });
    });
  }

  readonly #readLog: () => string;

  /**
   * Lance le jeu de `cwd` et attend que le relais réponde. `vitrine` : la scène vitrine d'un asset (« A-0001 »).
   * Le projet doit avoir été importé (godotImport).
   */
  static async start(
    exe: string,
    cwd: string,
    options: { screen?: GameScreen; vitrine?: string | null; visible?: boolean; timeoutMs?: number; record?: string | null; seed?: number | null } = {},
  ): Promise<GodotGame> {
    const screen = options.screen ?? "pc";
    const port = await freePort();
    const args = ["--path", cwd, "--resolution", SIZES[screen]];
    if (!options.visible) args.push("--position", "-20000,-20000");
    // Une partie enregistrée (ADR-85) : 60 images par seconde fixes, pour qu'elle se rejoue à l'identique.
    if (options.record) args.push(...RECORD_ENGINE_ARGS);
    args.push("--", `--studio-bridge=${port}`);
    if (options.vitrine) args.push(`--vitrine=${options.vitrine}`);
    if (options.record) args.push(`--studio-record=${options.record}`);
    if (options.seed != null) args.push(`--studio-seed=${options.seed}`);
    const child = spawn(exe, args, { cwd, windowsHide: !options.visible, stdio: ["ignore", "pipe", "pipe"] });
    let log = "";
    const keep = (b: Buffer) => {
      log = (log + b.toString("utf8")).slice(-200_000);
    };
    child.stdout!.on("data", keep);
    child.stderr!.on("data", keep);
    const deadline = Date.now() + (options.timeoutMs ?? 60_000);
    let exited = false;
    child.once("exit", () => (exited = true));
    while (Date.now() < deadline && !exited) {
      await new Promise((r) => setTimeout(r, 400));
      if (!/STUDIO_BRIDGE_READY/.test(log)) continue;
      const socket = await new Promise<Socket | null>((resolve) => {
        const s = connect(port, "127.0.0.1", () => resolve(s));
        s.once("error", () => resolve(null));
      });
      if (socket) return new GodotGame(child, socket, screen, () => log);
    }
    killTree(child.pid);
    const errors = godotErrors(log);
    if (exited) throw new Error(`le jeu s'est fermé au démarrage${errors.length ? ` : ${errors.slice(0, 4).join(" | ")}` : ""}`);
    if (!/StudioBridge|studio_bridge/.test(log) && !errors.length) throw new Error("le relais du studio ne répond pas (addons/studio_bridge absent, ou autoload StudioBridge manquant dans project.godot)");
    throw new Error(`le jeu n'a pas démarré à temps${errors.length ? ` : ${errors.slice(0, 4).join(" | ")}` : ""}`);
  }

  call(cmd: string, extra: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = this.#waiters.indexOf(done);
        if (i >= 0) this.#waiters.splice(i, 1);
        resolve({ ok: false, error: "le relais n'a pas répondu à temps" });
      }, timeoutMs);
      const done = (v: Record<string, unknown>) => {
        clearTimeout(timer);
        resolve(v);
      };
      this.#waiters.push(done);
      this.#socket.write(`${JSON.stringify({ id: ++this.#id, cmd, ...extra })}\n`);
    });
  }

  /** Les erreurs écrites par Godot depuis le dernier appel. */
  newErrors(): string[] {
    const log = this.#readLog();
    const fresh = log.slice(this.#seen);
    this.#seen = log.length;
    return godotErrors(fresh);
  }

  get alive(): boolean {
    return this.#child.exitCode === null;
  }

  async close(): Promise<void> {
    if (this.alive) {
      await this.call("quit", {}, 3000).catch(() => null);
      await new Promise((r) => setTimeout(r, 800));
    }
    this.#socket.destroy();
    if (this.alive) killTree(this.#child.pid);
  }
}

/** Le temps du jeu avance d'1/60 s par image, et pas plus de 60 images par seconde : vos parties se rejouent à l'identique. */
export const RECORD_ENGINE_ARGS = ["--fixed-fps", "60", "--max-fps", "60"];

export type ReplayResult = {
  ok: boolean;
  frames: number;
  events: number;
  checked: number;
  mismatches: { image: number; seconde: number; attendu: string; obtenu: string }[];
  error?: string;
};

/**
 * Rejoue une partie enregistrée (ADR-85) : le jeu, hors de l'écran à la taille de l'enregistrement, reçoit les mêmes
 * entrées aux mêmes images, avec le même hasard, aussi vite que possible ; le relais compare l'état du jeu.
 */
export async function godotReplay(exe: string, cwd: string, file: string, window: [number, number] | null, timeoutMs = 3 * 60_000): Promise<{ result: ReplayResult | null; errors: string[]; log: string }> {
  const args = ["--path", cwd, "--position", "-20000,-20000", "--fixed-fps", "60"];
  if (window && window[0] > 0 && window[1] > 0) args.push("--resolution", `${window[0]}x${window[1]}`);
  args.push("--", `--studio-replay=${file}`);
  const r = await run(exe, args, cwd, timeoutMs);
  const log = r.log.replace(ANSI, "");
  const line = /STUDIO_REPLAY: (\{.*\})/.exec(log)?.[1];
  let result: ReplayResult | null = null;
  try {
    result = line ? (JSON.parse(line) as ReplayResult) : null;
  } catch {
    result = null;
  }
  if (!result && r.timedOut) result = { ok: false, frames: 0, events: 0, checked: 0, mismatches: [], error: `la partie rejouée ne s'est pas terminée en ${Math.round(timeoutMs / 1000)} s` };
  return { result, errors: godotErrors(log), log };
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
