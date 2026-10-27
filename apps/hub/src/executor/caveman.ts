import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExecRequest, ExecResult, ExecutorPort } from "./port.ts";

/**
 * Essai de Caveman (ADR-90) : un relais local (caveman-proxy) qui compresse ce que relit le Développeur
 * (journaux, sorties de tests, diffs). Éteint par défaut. Allumé, une part des chantiers seulement y passe,
 * pour comparer avec ceux restés en direct, et tout passage repart en direct si le relais ne répond pas.
 *
 * Le relais reçoit seulement une adresse de base (ANTHROPIC_BASE_URL), jamais d'identifiant : Claude Code
 * garde votre connexion d'abonnement, ses limites et sa facturation (doc Anthropic « gateways »).
 */
export type CavemanMode = "off" | "record" | "compress";
export type Route = "direct" | "caveman";

export type CavemanSettings = {
  mode: CavemanMode;
  /** Part des chantiers routés vers le relais (0 à 1). */
  share: number;
  url: string;
  port: number;
  /** caveman-proxy, ou null s'il n'est pas installé (`caveman setup --install`). */
  binary: string | null;
  /**
   * caveman-mcp : l'outil de relecture des passages compressés. Avec un abonnement Claude, le relais ne compresse
   * que si l'agent l'a (sinon il transmet tel quel, constaté le 27/10/2026).
   */
  mcpBinary: string | null;
};

export type CavemanStatus = {
  mode: CavemanMode;
  share: number;
  url: string;
  installed: boolean;
  running: boolean;
  lastError: string | null;
};

/** Lit STUDIO_CAVEMAN (off | record | compress), STUDIO_CAVEMAN_SHARE, STUDIO_CAVEMAN_PORT et STUDIO_CAVEMAN_BIN. */
export function cavemanSettings(env: NodeJS.ProcessEnv = process.env): CavemanSettings {
  const raw = (env.STUDIO_CAVEMAN ?? "").trim().toLowerCase();
  const mode: CavemanMode = raw === "record" || raw === "compress" ? raw : "off";
  const s = Number(env.STUDIO_CAVEMAN_SHARE);
  const share = env.STUDIO_CAVEMAN_SHARE !== undefined && Number.isFinite(s) ? Math.min(1, Math.max(0, s)) : 0.5;
  // Pas le 8787 de `caveman claude` : un relais lancé à la main, peut-être dans un autre mode, ne doit pas servir au hub.
  const p = Number(env.STUDIO_CAVEMAN_PORT);
  const port = Number.isInteger(p) && p > 0 && p < 65536 ? p : 8797;
  const exe = (name: string) => join(homedir(), ".caveman", "bin", process.platform === "win32" ? `${name}.exe` : name);
  const proxy = env.STUDIO_CAVEMAN_BIN ?? exe("caveman-proxy");
  const mcp = exe("caveman-mcp");
  return { mode, share, url: `http://127.0.0.1:${port}`, port, binary: existsSync(proxy) ? proxy : null, mcpBinary: existsSync(mcp) ? mcp : null };
}

/** Le même chantier prend toujours le même chemin : la comparaison se fait chantier par chantier. */
export function routeOf(taskId: string, share: number): Route {
  if (share <= 0) return "direct";
  if (share >= 1) return "caveman";
  const h = createHash("sha1").update(taskId).digest().readUInt32BE(0) / 0x1_0000_0000;
  return h < share ? "caveman" : "direct";
}

/** Consigne ajoutée au Développeur routé en mode « compress » : les passages abrégés se relisent, ils ne mentent pas. */
export const RELAY_NOTE =
  "Le relais Caveman peut abréger ce que tu lis : un passage remplacé par « caveman: body elided » ou une marque <<ccr:…>> n'est pas le vrai contenu du fichier. Avant de citer ou de modifier ce passage, appelle l'outil mcp__caveman__caveman_retrieve avec cette marque pour obtenir l'original exact.";

/** Une coupure du relais, pas une erreur du travail : le passage est refait en direct. */
export function isRelayFailure(err: unknown): boolean {
  return /connection error|ECONNREFUSED|ECONNRESET|socket hang up|fetch failed|unable to connect|cave_gateway_error|cave_route/i.test(String((err as Error)?.message ?? err));
}

export class CavemanRouter {
  readonly settings: CavemanSettings;
  readonly #home: string;
  readonly #fetch: typeof fetch;
  readonly #spawnProxy: boolean;
  #child: ChildProcess | null = null;
  #running = false;
  #lastError: string | null = null;
  #starting: Promise<boolean> | null = null;

  constructor(settings: CavemanSettings, opts: { home: string; fetch?: typeof fetch; spawnProxy?: boolean }) {
    this.settings = settings;
    this.#home = opts.home;
    this.#fetch = opts.fetch ?? fetch;
    this.#spawnProxy = opts.spawnProxy ?? true;
  }

  get enabled(): boolean {
    return this.settings.mode !== "off";
  }

  route(taskId: string): Route {
    return this.enabled ? routeOf(taskId, this.settings.share) : "direct";
  }

  status(): CavemanStatus {
    const s = this.settings;
    return { mode: s.mode, share: s.share, url: s.url, installed: s.binary !== null, running: this.#running, lastError: this.#lastError };
  }

  /** Le relais répond-il, et dans le mode demandé ? Lance-le s'il le faut. */
  ensure(): Promise<boolean> {
    if (!this.enabled) return Promise.resolve(false);
    this.#starting ??= this.#ensure().finally(() => (this.#starting = null));
    return this.#starting;
  }

  async #ensure(): Promise<boolean> {
    if (await this.#alive()) return this.#checkMode();
    if (!this.settings.binary) return this.#fail("caveman-proxy introuvable : lancez « caveman setup --install »");
    if (!this.#spawnProxy) return this.#fail("relais Caveman injoignable");
    if (!this.#child || this.#child.exitCode !== null) {
      mkdirSync(this.#home, { recursive: true });
      const child = spawn(this.settings.binary, [], {
        cwd: this.#home,
        windowsHide: true,
        stdio: "ignore",
        env: {
          ...process.env,
          CAVEMAN_MODE: this.settings.mode,
          CAVEMAN_LISTEN: `127.0.0.1:${this.settings.port}`,
          // Le relais ne cache un passage derrière une marque que si le Développeur a l'outil pour le relire.
          CAVEMAN_RECOVERY: this.settings.mcpBinary ? "mcp" : "",
          CAVEMAN_HOME: this.#home,
        },
      });
      child.on("error", (e) => (this.#lastError = `caveman-proxy n'a pas démarré : ${e.message}`));
      child.on("exit", () => {
        this.#running = false;
        if (this.#child === child) this.#child = null;
      });
      this.#child = child;
    }
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 250));
      if (await this.#alive()) return this.#checkMode();
    }
    return this.#fail(this.#lastError ?? "relais Caveman lancé mais muet après 5 s");
  }

  async #alive(): Promise<boolean> {
    try {
      const res = await this.#fetch(`${this.settings.url}/health`, { signal: AbortSignal.timeout(1500) });
      // Le relais n'a pas de route /health : il répond par son erreur à lui, ce qui suffit à le reconnaître.
      const body = await res.text();
      this.#running = res.ok || body.includes("cave_");
    } catch {
      this.#running = false;
    }
    return this.#running;
  }

  /** Un relais déjà là (hub précédent, autre outil) mais dans un autre mode ne sert pas. */
  #checkMode(): boolean {
    try {
      const run = JSON.parse(readFileSync(join(this.#home, "run", `${this.settings.port}.json`), "utf8")) as { mode?: string };
      if (run.mode && run.mode !== this.settings.mode) return this.#fail(`un relais Caveman tourne déjà en mode « ${run.mode} » sur le port ${this.settings.port}`);
    } catch {
      /* état illisible : le relais répond, on s'en tient là */
    }
    this.#lastError = null;
    return true;
  }

  #fail(message: string): false {
    this.#lastError = message;
    return false;
  }

  /** L'outil de relecture donné au Développeur, branché sur le magasin du relais du hub. */
  retrieveServer(): Record<string, { command: string; args: string[]; env: Record<string, string> }> {
    const bin = this.settings.mcpBinary;
    return bin ? { caveman: { command: bin, args: [], env: { CAVEMAN_HOME: this.#home } } } : {};
  }

  stop(): void {
    this.#child?.kill();
    this.#child = null;
    this.#running = false;
  }
}

/**
 * L'exécuteur des chantiers, avec le détour par Caveman pour le Développeur (plan et exécution) des chantiers tirés
 * au sort. Le Testeur et tout ce qui n'est pas un chantier (Jeu express, mods…) restent en direct.
 */
export class CavemanExecutor implements ExecutorPort {
  readonly name: string;
  readonly #inner: ExecutorPort;
  readonly #router: CavemanRouter;

  constructor(inner: ExecutorPort, router: CavemanRouter) {
    this.#inner = inner;
    this.#router = router;
    this.name = inner.name;
  }

  async run(req: ExecRequest): Promise<ExecResult> {
    const direct = async (): Promise<ExecResult> => ({ ...(await this.#inner.run(req)), route: "direct" });
    if (!req.taskId || (req.kind !== "plan" && req.kind !== "execute") || this.#router.route(req.taskId) !== "caveman") return direct();
    if (!(await this.#router.ensure())) {
      req.onEvent("info", `Caveman indisponible (${this.#router.status().lastError ?? "sans réponse"}) : ce passage part en direct.`);
      return direct();
    }
    req.onEvent("info", `Ce chantier passe par Caveman (mode ${this.#router.settings.mode}), pour l'essai de mesure.`);
    try {
      const retrieve = this.#router.retrieveServer();
      const routed: ExecRequest = {
        ...req,
        baseUrl: this.#router.settings.url,
        // Comme l'outil « jouer » du testeur : servi par la configuration MCP, permis outil par outil par le Gardien.
        extraMcp: { ...req.extraMcp, ...retrieve },
        // Sans cette consigne, un modèle qui lit un passage abrégé croit le fichier altéré (essai du 27/10/2026).
        systemPrompt: this.#router.settings.mode === "compress" && retrieve.caveman ? `${req.systemPrompt}\n\n${RELAY_NOTE}` : req.systemPrompt,
      };
      return { ...(await this.#inner.run(routed)), route: "caveman" };
    } catch (err) {
      if (req.signal.aborted || !isRelayFailure(err)) {
        // Un échec passé par le relais compte pour le relais dans la comparaison.
        if (err && typeof err === "object") (err as { route?: string }).route = "caveman";
        throw err;
      }
      req.onEvent("info", "Le relais Caveman a lâché : le passage est refait en direct.");
      return direct();
    }
  }
}
