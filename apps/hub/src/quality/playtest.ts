import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { PreviewService, type Preview } from "../executor/preview.ts";
import type { Journal } from "../journal/journal.ts";
import { GodotGame, godotImport } from "../godot/run.ts";
import { hasBridge, isGodot, type GodotInstall } from "../godot/toolchain.ts";
import { vitrineOf } from "./checks.ts";

/**
 * La manette du testeur (ADR-69) : le hub ouvre le jeu de la copie du chantier dans un navigateur invisible
 * et le testeur y joue par l'outil « jouer » (relais MCP du studio) : clics, touches, attente, taille d'écran,
 * puis il reçoit ce que voit le joueur (texte, boutons, erreurs, état du jeu) et des photos.
 * Inspiré du `game_use` d'OhMyGame : actions par paquets, puis un état de la page rendu tout seul.
 */

export const PlayStep = z.discriminatedUnion("do", [
  z.object({ do: z.literal("click"), x: z.number().min(0).max(4096).optional(), y: z.number().min(0).max(4096).optional(), text: z.string().max(200).optional(), selector: z.string().max(200).optional() }),
  z.object({ do: z.literal("press"), key: z.string().min(1).max(40), hold_ms: z.number().int().min(0).max(5000).optional() }),
  z.object({ do: z.literal("type"), text: z.string().max(500) }),
  z.object({ do: z.literal("wait"), ms: z.number().int().min(0).max(5000) }),
  z.object({ do: z.literal("bridge"), method: z.enum(["reset", "setSeed", "step"]), value: z.number().optional() }),
]);
export type PlayStep = z.infer<typeof PlayStep>;

export const PlayRequest = z.object({
  action: z.enum(["open", "act", "capture", "close"]),
  /** Écran simulé ; en changer relance le jeu. */
  screen: z.enum(["pc", "phone"]).optional(),
  /** Ajouté à l'adresse du jeu à l'ouverture (« ?niveau=2 », « #fin ») : jamais une autre adresse. */
  path: z.string().max(200).regex(/^(?!\/\/)[?#/][^:\\]*$/, "seulement un chemin, « ?… » ou « #… » du jeu").optional(),
  steps: z.array(PlayStep).max(20).optional(),
  /** Pour « act » : prendre une photo après les actions. */
  capture: z.boolean().optional(),
});
export type PlayRequest = z.infer<typeof PlayRequest>;

export type Screen = "pc" | "phone";

/** Ce que voit le joueur à un instant donné. */
export type PlaySnapshot = {
  url: string;
  title: string;
  text: string;
  controls: { label: string; kind: string; x: number; y: number }[];
  canvases: { width: number; height: number; x: number; y: number; visible: boolean }[];
  /** Nouvelles depuis le dernier état rendu. */
  errors: string[];
  failedRequests: string[];
  /** `window.__STUDIO_TEST__.snapshot()` si le jeu l'expose. */
  state: string | null;
  bridge: string[];
  /** Jeu Godot : les actions du projet, utilisables comme touches (« ui_accept », « sauter »). */
  actions?: string[];
};

/** Une partie ouverte dans le navigateur invisible. */
export interface PlaySession {
  readonly screen: Screen;
  /** Joue les étapes une à une ; rend une note par étape qui n'a pas pu se faire. */
  act(steps: PlayStep[]): Promise<string[]>;
  snapshot(): Promise<PlaySnapshot>;
  /** Photo de l'écran (JPEG) dans `file`. */
  capture(file: string): Promise<void>;
  close(): Promise<void>;
}

/** Ce qui sait lancer le jeu et ouvrir une partie (un faux dans les tests du hub). */
export interface PlayDriver {
  open(key: string, cwd: string, screen: Screen, path: string): Promise<PlaySession>;
}

export type PlayResult = { text: string; image?: { data: string; mimeType: "image/jpeg"; file: string } };

type Open = { session: PlaySession; project: string; task: string; captures: number; actions: number; timer: NodeJS.Timeout | null };

const MAX_CAPTURES = 15;

export class PlaytestService {
  readonly #driver: PlayDriver;
  readonly #shotsDir: string;
  readonly #journal: Journal | null;
  readonly #idleMs: number;
  readonly #open = new Map<string, Open>();
  /** Une seule demande à la fois par run : le testeur attend la réponse avant d'agir de nouveau. */
  readonly #queue = new Map<string, Promise<unknown>>();

  constructor(deps: { driver: PlayDriver; shotsDir: string; journal?: Journal; idleMs?: number }) {
    this.#driver = deps.driver;
    this.#shotsDir = deps.shotsDir;
    this.#journal = deps.journal ?? null;
    this.#idleMs = deps.idleMs ?? 10 * 60_000;
  }

  handle(run: { id: string; project: string; task: string; cwd: string }, req: PlayRequest): Promise<PlayResult> {
    const previous = this.#queue.get(run.id) ?? Promise.resolve();
    const next = previous.then(
      () => this.#handle(run, req),
      () => this.#handle(run, req),
    );
    this.#queue.set(run.id, next);
    return next;
  }

  async #handle(run: { id: string; project: string; task: string; cwd: string }, req: PlayRequest): Promise<PlayResult> {
    if (req.action === "close") {
      const had = this.#open.has(run.id);
      await this.closeRun(run.id);
      return { text: had ? "Partie fermée." : "Aucune partie ouverte." };
    }
    let open = this.#open.get(run.id);
    const screen = req.screen ?? open?.session.screen ?? "pc";
    const notes: string[] = [];
    if (req.action === "open" || !open || open.session.screen !== screen) {
      if (open && req.action !== "open") notes.push(open.session.screen !== screen ? "Écran changé : le jeu a été relancé depuis le début." : "");
      if (!open && req.action !== "open") notes.push("Aucune partie ouverte : le jeu vient d'être lancé.");
      if (open) await this.#closeSession(run.id);
      try {
        const session = await this.#driver.open(`${run.project}/play-${run.task}`, run.cwd, screen, req.path ?? "");
        open = { session, project: run.project, task: run.task, captures: open?.captures ?? 0, actions: open?.actions ?? 0, timer: null };
        this.#open.set(run.id, open);
      } catch (err) {
        return { text: `Impossible d'ouvrir le jeu : ${(err as Error).message.slice(0, 600)}\nNe réessaie pas en boucle : vérifie par la lecture du code et dis dans ton rapport que le jeu n'a pas pu être essayé.` };
      }
    }
    this.#touch(run.id, open);
    if (req.action === "act" && req.steps?.length) {
      notes.push(...(await open.session.act(req.steps)));
      open.actions += req.steps.length;
    }
    const snap = await open.session.snapshot();
    const head = req.action === "open" ? `Jeu ouvert (écran ${screen === "pc" ? "PC 1280×720" : "téléphone 390×844, tactile"}).` : req.action === "act" ? `${req.steps?.length ?? 0} action(s) jouée(s).` : "État actuel.";
    const text = [head, ...notes.filter(Boolean).map((n) => `⚠ ${n}`), describeSnapshot(snap)].join("\n");
    if (req.action === "capture" || (req.action === "act" && req.capture) || req.action === "open") {
      if (open.captures >= MAX_CAPTURES) return { text: `${text}\n(Plus de photo : ${MAX_CAPTURES} déjà prises pour ce chantier.)` };
      open.captures++;
      const file = join(this.#shotsDir, safe(run.project), `play-${safe(run.task)}-${safe(run.id)}-${open.captures}.jpg`);
      mkdirSync(dirname(file), { recursive: true });
      try {
        await open.session.capture(file);
        return { text: `${text}\nPhoto : ${file}`, image: { data: readFileSync(file).toString("base64"), mimeType: "image/jpeg", file } };
      } catch (err) {
        return { text: `${text}\nPhoto impossible : ${(err as Error).message.slice(0, 200)}` };
      }
    }
    return { text };
  }

  /** Fin du run (ou partie fermée par le testeur) : le navigateur et le serveur du jeu s'arrêtent. */
  async closeRun(runId: string): Promise<void> {
    const open = this.#open.get(runId);
    if (!open) return;
    await this.#closeSession(runId);
    this.#queue.delete(runId);
    this.#journal?.append({ project: open.project, actor: { kind: "system" }, type: "playtest.done", subject: open.task, payload: { run: runId, actions: open.actions, captures: open.captures } });
  }

  async #closeSession(runId: string): Promise<void> {
    const open = this.#open.get(runId);
    if (!open) return;
    this.#open.delete(runId);
    if (open.timer) clearTimeout(open.timer);
    await open.session.close().catch(() => {});
  }

  #touch(runId: string, open: Open): void {
    if (open.timer) clearTimeout(open.timer);
    // Partie oubliée : fermée après un moment sans action.
    open.timer = setTimeout(() => void this.closeRun(runId), this.#idleMs);
    open.timer.unref?.();
  }

  /** Arrêt du hub. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.#open.keys()].map((id) => this.closeRun(id)));
  }
}

/** Ce que reçoit le testeur, en texte court. */
export function describeSnapshot(s: PlaySnapshot): string {
  const lines = [s.url.startsWith("res://") ? `Scène Godot : ${s.url}` : `Page : ${s.title ? `« ${s.title} » ` : ""}${s.url}`];
  if (s.canvases.length) lines.push(`Zones de jeu (canvas) : ${s.canvases.map((c) => `${c.width}×${c.height} à (${c.x}, ${c.y})${c.visible ? "" : " invisible"}`).join(" ; ")}`);
  if (s.controls.length) lines.push(`Boutons et champs visibles (centre x, y) : ${s.controls.map((c) => `${c.kind} « ${c.label} » (${c.x}, ${c.y})`).join(" ; ")}`);
  lines.push(`Texte visible : ${s.text ? s.text : "(aucun)"}`);
  if (s.actions?.length) lines.push(`Actions du projet (utilisables comme « key ») : ${s.actions.join(", ")}`);
  if (s.state) lines.push(`État du jeu (${s.url.startsWith("res://") ? "nœud studio_test" : "__STUDIO_TEST__"}.snapshot) : ${s.state}`);
  if (s.bridge.length) lines.push(`Pont de test disponible : ${s.bridge.join(", ")}`);
  lines.push(s.errors.length ? `Erreurs dans la page : ${s.errors.join(" | ")}` : "Aucune nouvelle erreur dans la page.");
  if (s.failedRequests.length) lines.push(`Fichiers non chargés : ${s.failedRequests.join(" | ")}`);
  return lines.join("\n");
}

const safe = (s: string) => s.replace(/[^\w-]/g, "_");

const VIEWPORTS: Record<Screen, { viewport: { width: number; height: number }; isMobile: boolean; hasTouch: boolean }> = {
  pc: { viewport: { width: 1280, height: 720 }, isMobile: false, hasTouch: false },
  phone: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
};

/** Lu dans la page : ce que voit le joueur (sans les types du navigateur côté hub). */
const SNAPSHOT_SCRIPT = `(() => {
  const d = document;
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth; };
  const controls = [...d.querySelectorAll("button, a[href], input, select, textarea, [role=button], [onclick], [data-testid]")]
    .filter(vis).slice(0, 30).map((el) => { const r = el.getBoundingClientRect();
      return { label: (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("data-testid") || "").trim().replace(/\\s+/g, " ").slice(0, 40), kind: el.getAttribute("role") || el.tagName.toLowerCase(), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; });
  const canvases = [...d.querySelectorAll("canvas")].slice(0, 4).map((c) => { const r = c.getBoundingClientRect(); return { width: Math.round(r.width), height: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top), visible: vis(c) }; });
  const b = globalThis.__STUDIO_TEST__;
  let state = null;
  try { if (b && typeof b.snapshot === "function") state = JSON.stringify(b.snapshot()).slice(0, 4000); } catch (e) { state = "erreur : " + String(e).slice(0, 200); }
  const bridge = b ? ["snapshot", "reset", "setSeed", "step"].filter((m) => typeof b[m] === "function") : [];
  return { url: location.pathname + location.search + location.hash, title: d.title, text: (d.body ? d.body.innerText : "").replace(/\\s+/g, " ").trim().slice(0, 1500), controls, canvases, state, bridge };
})()`;

/**
 * La vraie manette : `npm run dev` de la copie, puis Edge (ou Chrome) invisible piloté par playwright-core ; pour un jeu
 * Godot (ADR-73), le jeu lui-même hors de l'écran, piloté par le relais du studio.
 */
export class RealPlayDriver implements PlayDriver {
  // Instance à part : ne coupe ni le jeu que vous essayez, ni les vérifications du hub.
  readonly #previews: PreviewService;
  readonly #godot: () => GodotInstall | null;

  constructor(options: { workDir: string; godot?: () => GodotInstall | null }) {
    this.#previews = new PreviewService({ workDir: options.workDir });
    this.#godot = options.godot ?? (() => null);
  }

  async open(key: string, cwd: string, screen: Screen, path: string): Promise<PlaySession> {
    if (isGodot(cwd)) return GodotPlaySession.open(this.#godot(), cwd, screen, path);
    let chromium: typeof import("playwright-core").chromium;
    try {
      ({ chromium } = await import("playwright-core"));
    } catch {
      throw new Error("outil de navigateur absent (playwright-core)");
    }
    const [project, task] = key.split("/") as [string, string];
    const preview = await this.#previews.start(project, task, cwd);
    const browser = await chromium.launch({ channel: "msedge", headless: true }).catch(() => chromium.launch({ channel: "chrome", headless: true }).catch(() => null));
    if (!browser) {
      await this.#previews.stop(preview.key);
      throw new Error("ni Edge ni Chrome trouvés");
    }
    try {
      return await BrowserPlaySession.start(browser, gameUrl(preview, path), screen, async () => {
        await browser.close().catch(() => {});
        await this.#previews.stop(preview.key);
      });
    } catch (err) {
      await browser.close().catch(() => {});
      await this.#previews.stop(preview.key);
      throw err;
    }
  }
}

/** Adresse du jeu avec le drapeau de test : le pont `__STUDIO_TEST__` ne doit exister qu'avec lui. */
export function gameUrl(preview: Pick<Preview, "url">, path: string): string {
  const u = new URL(path || "/", preview.url);
  if (u.origin !== new URL(preview.url).origin) throw new Error("adresse hors du jeu");
  u.searchParams.set("studioTest", "1");
  return u.toString();
}

type Browser = import("playwright-core").Browser;
type Page = import("playwright-core").Page;

/** Une partie dans un navigateur déjà lancé. Exportée pour les tests (page servie localement). */
export class BrowserPlaySession implements PlaySession {
  readonly screen: Screen;
  readonly #page: Page;
  readonly #origin: string;
  readonly #url: string;
  readonly #onClose: () => Promise<void>;
  #errors: string[] = [];
  #failed: string[] = [];

  private constructor(page: Page, url: string, screen: Screen, onClose: () => Promise<void>) {
    this.#page = page;
    this.#url = url;
    this.#origin = new URL(url).origin;
    this.screen = screen;
    this.#onClose = onClose;
    page.on("pageerror", (e) => this.#push(this.#errors, e.message));
    page.on("console", (m) => {
      // Une icône d'onglet absente n'est pas un problème du jeu (comme pour le lancement, ADR-32).
      if (m.type() === "error" && !/favicon/i.test(m.text() + (m.location().url ?? ""))) this.#push(this.#errors, m.text());
    });
    page.on("requestfailed", (r) => {
      if (!/favicon/i.test(r.url())) this.#push(this.#failed, `${shortUrl(r.url())} (${r.failure()?.errorText ?? "échec"})`);
    });
    page.on("response", (r) => {
      if (r.status() >= 400 && !/favicon/i.test(r.url())) this.#push(this.#failed, `${shortUrl(r.url())} (${r.status()})`);
    });
  }

  static async start(browser: Browser, url: string, screen: Screen, onClose: () => Promise<void>): Promise<BrowserPlaySession> {
    const context = await browser.newContext({ ...VIEWPORTS[screen], acceptDownloads: false });
    const page = await context.newPage();
    // Pas de nouvelle fenêtre : le testeur reste dans le jeu.
    page.on("popup", (p) => void p.close().catch(() => {}));
    const session = new BrowserPlaySession(page, url, screen, onClose);
    await page.goto(url, { waitUntil: "load", timeout: 60_000 });
    // Le temps que le jeu démarre (chargements, premier dessin).
    await page.waitForTimeout(1500);
    return session;
  }

  #push(list: string[], text: string): void {
    if (list.length < 30 && !list.includes(text)) list.push(text.slice(0, 300));
  }

  async act(steps: PlayStep[]): Promise<string[]> {
    const page = this.#page;
    const notes: string[] = [];
    for (const [i, step] of steps.entries()) {
      const n = `étape ${i + 1}`;
      try {
        switch (step.do) {
          case "click": {
            if (step.selector || step.text) {
              const target = step.selector
                ? page.locator(step.selector).first()
                : page.getByRole("button", { name: step.text }).or(page.getByText(step.text!, { exact: false })).first();
              if (this.screen === "phone") await target.tap({ timeout: 3000 });
              else await target.click({ timeout: 3000 });
            } else if (step.x !== undefined && step.y !== undefined) {
              if (this.screen === "phone") await page.touchscreen.tap(step.x, step.y);
              else await page.mouse.click(step.x, step.y);
            } else notes.push(`${n} : clic sans cible (x, y, text ou selector)`);
            break;
          }
          case "press":
            if (step.hold_ms) {
              await page.keyboard.down(step.key);
              await page.waitForTimeout(step.hold_ms);
              await page.keyboard.up(step.key);
            } else await page.keyboard.press(step.key);
            break;
          case "type":
            await page.keyboard.insertText(step.text);
            break;
          case "wait":
            await page.waitForTimeout(step.ms);
            break;
          case "bridge": {
            const done = (await page.evaluate(
              ({ m, v }) => {
                const b = (globalThis as { __STUDIO_TEST__?: Record<string, unknown> }).__STUDIO_TEST__;
                const f = b?.[m];
                if (typeof f !== "function") return false;
                (f as (x?: number) => unknown).call(b, v);
                return true;
              },
              { m: step.method, v: step.value },
            )) as boolean;
            if (!done) notes.push(`${n} : le jeu n'expose pas __STUDIO_TEST__.${step.method}`);
            break;
          }
        }
      } catch (err) {
        notes.push(`${n} (${step.do}) impossible : ${(err as Error).message.split("\n")[0]!.slice(0, 200)}`);
      }
      await page.waitForTimeout(100);
      // Le jeu a quitté son adresse (lien externe) : on y revient.
      if (new URL(page.url()).origin !== this.#origin) {
        notes.push(`${n} : la page est partie vers ${shortUrl(page.url())} ; retour au jeu`);
        await page.goto(this.#url, { waitUntil: "load", timeout: 60_000 }).catch(() => {});
      }
    }
    return notes;
  }

  async snapshot(): Promise<PlaySnapshot> {
    const s = (await this.#page.evaluate(SNAPSHOT_SCRIPT)) as Omit<PlaySnapshot, "errors" | "failedRequests">;
    const out = { ...s, errors: this.#errors, failedRequests: this.#failed };
    this.#errors = [];
    this.#failed = [];
    return out;
  }

  async capture(file: string): Promise<void> {
    await this.#page.screenshot({ path: file, type: "jpeg", quality: 70 });
  }

  async close(): Promise<void> {
    await this.#page.context().close().catch(() => {});
    await this.#onClose();
  }
}

/** Une partie de Godot, par le relais du studio (addons/studio_bridge). */
export class GodotPlaySession implements PlaySession {
  readonly screen: Screen;
  readonly #game: GodotGame;

  private constructor(game: GodotGame, screen: Screen) {
    this.#game = game;
    this.screen = screen;
  }

  static async open(godot: GodotInstall | null, cwd: string, screen: Screen, path: string): Promise<GodotPlaySession> {
    if (!godot) throw new Error("Godot introuvable sur ce PC");
    if (!hasBridge(cwd)) throw new Error("ce jeu n'a pas le relais du studio (addons/studio_bridge et l'autoload StudioBridge)");
    const imported = await godotImport(godot.exe, cwd);
    if (imported.status === "fail") throw new Error(imported.detail);
    const game = await GodotGame.start(godot.exe, cwd, { screen, vitrine: vitrineOf(path) });
    // Le temps que la première scène se mette en place.
    await new Promise((r) => setTimeout(r, 1500));
    return new GodotPlaySession(game, screen);
  }

  async act(steps: PlayStep[]): Promise<string[]> {
    // Le pont du jeu web (reset, setSeed, step) devient les méthodes du nœud « studio_test » (reset, set_seed, step).
    const mapped = steps.map((s) =>
      s.do === "bridge" ? { ...s, method: s.method === "setSeed" ? "set_seed" : s.method } : s.do === "click" && s.selector && !s.text ? { do: "click", text: s.selector } : s,
    );
    const r = await this.#game.call("act", { steps: mapped, touch: this.screen === "phone" }, 120_000);
    if (!r.ok) return [String(r.error ?? "le relais n'a pas pu jouer")];
    return (r.notes as string[] | undefined) ?? [];
  }

  async snapshot(): Promise<PlaySnapshot> {
    const r = await this.#game.call("snapshot");
    const s = (r.snapshot ?? {}) as { scene?: string; window?: number[]; text?: string; controls?: PlaySnapshot["controls"]; state?: string; bridge?: string[]; actions?: string[] };
    const [w = 0, h = 0] = s.window ?? [];
    return {
      url: s.scene || "res://",
      title: "",
      text: s.text ?? "",
      controls: s.controls ?? [],
      canvases: w ? [{ width: w, height: h, x: 0, y: 0, visible: true }] : [],
      errors: [...(r.ok ? [] : [String(r.error)]), ...this.#game.newErrors()],
      failedRequests: [],
      state: s.state || null,
      bridge: s.bridge ?? [],
      actions: s.actions ?? [],
    };
  }

  async capture(file: string): Promise<void> {
    const r = await this.#game.call("capture", { path: file });
    if (!r.ok) throw new Error(String(r.error || "photo impossible"));
  }

  close(): Promise<void> {
    return this.#game.close();
  }
}

function shortUrl(u: string): string {
  try {
    const x = new URL(u);
    return (x.origin.startsWith("http://127.0.0.1") || x.origin.startsWith("http://localhost") ? "" : x.origin) + x.pathname;
  } catch {
    return u.slice(0, 120);
  }
}
