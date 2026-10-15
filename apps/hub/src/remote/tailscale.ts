import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { assertHumanSession, type HumanSession } from "../auth/human-session.ts";

export type Runner = (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;

export type RemoteStatus = {
  /** absent : Tailscale n'est pas installé ; stopped : installé mais pas connecté ; ready : connecté. */
  tailscale: "absent" | "stopped" | "ready";
  /** Nom de ce PC dans votre réseau Tailscale (ex. « mon-pc.tail1234.ts.net »). */
  dnsName: string | null;
  /** Le hub est-il publié dans votre réseau Tailscale (en HTTPS) ? */
  serving: boolean;
  url: string | null;
  /** Explication ou lien à suivre quand une étape vous revient. */
  message?: string;
  link?: string;
};

const WINDOWS_PATH = "C:\\Program Files\\Tailscale\\tailscale.exe";

/** Lance la commande `tailscale` officielle (lecture de l'état, publication du hub). */
export function tailscaleRunner(): Runner {
  return (args) =>
    new Promise((resolve) => {
      // Cherché à chaque appel : Tailscale peut être installé pendant que le hub tourne (constaté le 15/10).
      const bin = process.platform === "win32" && existsSync(WINDOWS_PATH) ? WINDOWS_PATH : "tailscale";
      execFile(bin, args, { windowsHide: true, timeout: 30_000 }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 127) : 0;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? (err ? err.message : "")) });
      });
    });
}

/**
 * Accès depuis le téléphone (ADR-30) : le hub reste sur 127.0.0.1 ; « tailscale serve »
 * le publie en HTTPS dans VOTRE réseau Tailscale seulement (jamais sur Internet : pas de
 * « funnel »). HTTPS est indispensable aux notifications et à l'installation sur l'écran d'accueil.
 */
export class RemoteService {
  readonly #run: Runner;
  readonly #port: number;
  readonly #onHost: (host: string) => void;

  constructor(options: { port: number; run?: Runner; onHost: (host: string) => void }) {
    this.#port = options.port;
    this.#run = options.run ?? tailscaleRunner();
    this.#onHost = options.onHost;
  }

  async status(): Promise<RemoteStatus> {
    const st = await this.#run(["status", "--json"]);
    if (st.code === 127 || /not found|n'est pas reconnu|ENOENT/i.test(st.stderr)) {
      return { tailscale: "absent", dnsName: null, serving: false, url: null, message: "Tailscale n'est pas installé sur ce PC." };
    }
    let json: { BackendState?: string; Self?: { DNSName?: string } } = {};
    try {
      json = JSON.parse(st.stdout);
    } catch {
      return { tailscale: "stopped", dnsName: null, serving: false, url: null, message: "Tailscale ne répond pas : ouvrez l'application Tailscale et connectez-vous." };
    }
    if (json.BackendState !== "Running") {
      return { tailscale: "stopped", dnsName: null, serving: false, url: null, message: "Tailscale est installé mais pas connecté : ouvrez l'application Tailscale et connectez-vous." };
    }
    const dnsName = (json.Self?.DNSName ?? "").replace(/\.$/, "") || null;
    const serving = dnsName ? await this.#isServing(dnsName) : false;
    if (serving && dnsName) this.#onHost(dnsName);
    return { tailscale: "ready", dnsName, serving, url: serving && dnsName ? `https://${dnsName}` : null };
  }

  /** Publie le hub dans votre réseau Tailscale (HTTPS, port 443 → 127.0.0.1:port). */
  async enable(session: HumanSession): Promise<RemoteStatus> {
    assertHumanSession(session);
    const before = await this.status();
    if (before.tailscale !== "ready") return before;
    const r = await this.#run(["serve", "--bg", "--https=443", `http://127.0.0.1:${this.#port}`]);
    const out = `${r.stdout}\n${r.stderr}`;
    const after = await this.status();
    if (!after.serving) {
      // Cas habituel la première fois : HTTPS n'est pas encore activé sur votre réseau Tailscale.
      const link = /(https:\/\/login\.tailscale\.com\/\S+)/.exec(out)?.[1];
      return {
        ...after,
        message: link
          ? "Une étape vous revient : autorisez HTTPS pour votre réseau Tailscale (un clic sur la page qui s'ouvre), puis réessayez."
          : `Tailscale a refusé la publication : ${out.trim().slice(0, 300)}`,
        link,
      };
    }
    return after;
  }

  async disable(session: HumanSession): Promise<RemoteStatus> {
    assertHumanSession(session);
    await this.#run(["serve", "--https=443", "off"]);
    return this.status();
  }

  async #isServing(dnsName: string): Promise<boolean> {
    const r = await this.#run(["serve", "status", "--json"]);
    try {
      const json = JSON.parse(r.stdout || "{}") as { Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }> };
      const web = json.Web?.[`${dnsName}:443`];
      return Object.values(web?.Handlers ?? {}).some((h) => (h.Proxy ?? "").includes(`:${this.#port}`));
    } catch {
      return false;
    }
  }
}
