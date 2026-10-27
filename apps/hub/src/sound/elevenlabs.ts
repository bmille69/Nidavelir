import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Le générateur de sons du directeur sonore (ADR-91) : ElevenLabs, effets (« text to sound effects ») et musique
 * (« compose »). La clé reste dans les données du hub (ou STUDIO_ELEVENLABS_KEY), jamais dans un jeu ni un journal.
 */

export type SoundCredits = { used: number; limit: number; tier: string; resetsAt: string | null };
export type EffectRequest = { prompt: string; seconds: number | null; loop: boolean };
export type MusicRequest = { prompt: string; seconds: number };

export interface SoundGenPort {
  readonly name: string;
  configured(): boolean;
  setKey(key: string): Promise<void>;
  credits(): Promise<SoundCredits | null>;
  effect(req: EffectRequest): Promise<Buffer>;
  music(req: MusicRequest): Promise<Buffer>;
}

const API = "https://api.elevenlabs.io";

export class ElevenLabs implements SoundGenPort {
  readonly name = "elevenlabs";
  readonly #dir: string;
  readonly #fetch: typeof fetch;

  constructor(dataDir: string, fetchImpl: typeof fetch = fetch) {
    this.#dir = join(dataDir, "elevenlabs");
    this.#fetch = fetchImpl;
  }

  #key(): string | null {
    const env = process.env.STUDIO_ELEVENLABS_KEY?.trim();
    if (env) return env;
    const file = join(this.#dir, "key.json");
    if (!existsSync(file)) return null;
    try {
      return (JSON.parse(readFileSync(file, "utf8")) as { key: string }).key || null;
    } catch {
      return null;
    }
  }

  configured(): boolean {
    return this.#key() !== null;
  }

  async #call(key: string, method: "GET" | "POST", path: string, body?: unknown): Promise<Response> {
    const res = await this.#fetch(`${API}${path}`, {
      method,
      headers: { "xi-api-key": key, ...(body ? { "content-type": "application/json" } : {}), accept: body ? "audio/mpeg" : "application/json" },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5 * 60_000),
    });
    if (!res.ok) {
      const text = (await res.text().catch(() => "")).slice(0, 400);
      let detail = text;
      try {
        const j = JSON.parse(text) as { detail?: { message?: string; status?: string } | string };
        detail = typeof j.detail === "string" ? j.detail : (j.detail?.message ?? j.detail?.status ?? text);
      } catch {
        /* texte brut */
      }
      if (res.status === 401) throw new Error(`ElevenLabs refuse la clé : ${detail}`);
      if (/quota|credits|limit/i.test(detail) || res.status === 429) throw new Error(`ElevenLabs : crédits épuisés ou limite atteinte (${detail})`);
      throw new Error(`ElevenLabs a répondu ${res.status} : ${detail}`);
    }
    return res;
  }

  async setKey(key: string): Promise<void> {
    const k = key.trim();
    if (!/^sk_[\w-]{20,}$/.test(k)) throw new Error("Une clé ElevenLabs commence par « sk_ » (page « API Keys » de votre compte ElevenLabs)");
    await this.#call(k, "GET", "/v1/user/subscription");
    mkdirSync(this.#dir, { recursive: true });
    writeFileSync(join(this.#dir, "key.json"), JSON.stringify({ key: k }), "utf8");
  }

  async credits(): Promise<SoundCredits | null> {
    const key = this.#key();
    if (!key) return null;
    const s = (await (await this.#call(key, "GET", "/v1/user/subscription")).json()) as { character_count: number; character_limit: number; tier: string; next_character_count_reset_unix?: number };
    return { used: s.character_count, limit: s.character_limit, tier: s.tier, resetsAt: s.next_character_count_reset_unix ? new Date(s.next_character_count_reset_unix * 1000).toISOString() : null };
  }

  async effect(req: EffectRequest): Promise<Buffer> {
    const key = this.#key();
    if (!key) throw new Error("Ajoutez d'abord votre clé ElevenLabs");
    const body: Record<string, unknown> = { text: req.prompt.slice(0, 450), prompt_influence: 0.5, loop: req.loop };
    if (req.seconds) body.duration_seconds = Math.max(0.5, Math.min(30, req.seconds));
    const res = await this.#call(key, "POST", "/v1/sound-generation?output_format=mp3_44100_128", body);
    return Buffer.from(await res.arrayBuffer());
  }

  async music(req: MusicRequest): Promise<Buffer> {
    const key = this.#key();
    if (!key) throw new Error("Ajoutez d'abord votre clé ElevenLabs");
    const ms = Math.round(Math.max(10, Math.min(300, req.seconds)) * 1000);
    const res = await this.#call(key, "POST", "/v1/music?output_format=mp3_44100_128", { prompt: req.prompt.slice(0, 2000), music_length_ms: ms, force_instrumental: true });
    return Buffer.from(await res.arrayBuffer());
  }
}

/** Un fichier MP3 plausible : en-tête ID3 ou synchro de trame. */
export function looksLikeMp3(b: Buffer): boolean {
  return b.length > 512 && (b.subarray(0, 3).toString("latin1") === "ID3" || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0));
}
