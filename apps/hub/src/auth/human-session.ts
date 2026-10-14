import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/**
 * Preuve qu'une action vient de vous, via le navigateur (docs/SECURITY.md §4).
 *
 * Une HumanSession n'est créée que par HumanSessions.verify(), à partir du cookie
 * de session et du jeton CSRF reçus sur une route /api/human/*. Les agents n'ont
 * accès ni à l'un ni à l'autre : ils ne peuvent donc pas en obtenir.
 */
export class HumanSession {
  readonly id: string;

  constructor(key: symbol, id: string) {
    if (key !== MINT_KEY) throw new HumanSessionRequiredError();
    this.id = id;
    issued.add(this);
  }
}

/** Non exporté : seul ce module peut créer une HumanSession. */
const MINT_KEY = Symbol("human-session");
const issued = new WeakSet<HumanSession>();

/** Vérifie à l'exécution qu'un objet est une vraie session émise par ce processus. */
export function assertHumanSession(value: unknown): asserts value is HumanSession {
  if (!(value instanceof HumanSession) || !issued.has(value)) {
    throw new HumanSessionRequiredError();
  }
}

export class HumanSessionRequiredError extends Error {
  constructor() {
    super("Action réservée à l'humain : session navigateur requise");
    this.name = "HumanSessionRequiredError";
  }
}

export class PairingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PairingError";
  }
}

/** Un appareil connecté durablement (téléphone), ADR-30. Le cookie n'est jamais stocké en clair. */
export type DeviceRecord = { id: string; name: string; cookie_hash: string; csrf: string; created_at: string; last_seen: string };

/** Où les appareils sont conservés entre deux lancements du hub. */
export type DeviceStore = {
  load(): DeviceRecord[];
  save(record: DeviceRecord): void;
  remove(id: string): void;
  touch(id: string, at: string): void;
};

type SessionRecord = { cookieHash: string; csrf: string; device: boolean };

const PAIRING_TTL_MS = 5 * 60_000;
const PAIRING_MAX_ATTEMPTS = 5;

export class HumanSessions {
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #pendingLogins = new Map<string, true>();
  readonly #store: DeviceStore | null;
  #pairing: { code: string; expires: number; attempts: number } | null = null;
  readonly #lastTouch = new Map<string, number>();

  constructor(store: DeviceStore | null = null) {
    this.#store = store;
    for (const d of store?.load() ?? []) this.#sessions.set(d.id, { cookieHash: d.cookie_hash, csrf: d.csrf, device: true });
  }

  /** Lien à usage unique affiché au lancement du hub. */
  createLoginToken(): string {
    const token = randomBytes(24).toString("base64url");
    this.#pendingLogins.set(token, true);
    return token;
  }

  /** Échange le jeton à usage unique contre un cookie et un jeton CSRF (session de ce PC, en mémoire). */
  login(loginToken: string): { sessionId: string; cookie: string; csrf: string } {
    if (!this.#pendingLogins.delete(loginToken)) throw new HumanSessionRequiredError();
    return this.#open(false);
  }

  /**
   * Code à 6 chiffres pour connecter un téléphone (valable 5 minutes, un seul à la fois,
   * 5 essais au plus). Créé seulement depuis une session déjà ouverte : il faut être vous.
   */
  createPairingCode(session: HumanSession, now = Date.now()): { code: string; expires_at: string } {
    assertHumanSession(session);
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    this.#pairing = { code, expires: now + PAIRING_TTL_MS, attempts: 0 };
    return { code, expires_at: new Date(this.#pairing.expires).toISOString() };
  }

  /** Le téléphone saisit le code : il reçoit une session durable, révocable. */
  loginWithCode(code: string, name: string, now = Date.now()): { sessionId: string; cookie: string; csrf: string } {
    const p = this.#pairing;
    if (!p || now > p.expires) {
      this.#pairing = null;
      throw new PairingError("Code expiré : demandez-en un nouveau sur le PC");
    }
    if (++p.attempts > PAIRING_MAX_ATTEMPTS) {
      this.#pairing = null;
      throw new PairingError("Trop d'essais : demandez un nouveau code sur le PC");
    }
    if (!safeEqual(p.code, code.trim())) throw new PairingError("Code incorrect");
    this.#pairing = null;
    const opened = this.#open(true);
    const at = new Date(now).toISOString();
    this.#store?.save({
      id: opened.sessionId,
      name: name.trim().slice(0, 60) || "Téléphone",
      cookie_hash: hash(opened.cookie),
      csrf: opened.csrf,
      created_at: at,
      last_seen: at,
    });
    return opened;
  }

  /** Déconnecte un appareil (perte, vol, ou simplement plus utilisé). */
  revoke(session: HumanSession, id: string): void {
    assertHumanSession(session);
    this.#sessions.delete(id);
    this.#store?.remove(id);
  }

  /** Lecture seule : le cookie suffit (aucune HumanSession n'est émise). */
  check(sessionId: string, cookie: string): boolean {
    const record = this.#sessions.get(sessionId);
    const ok = !!record && safeEqual(record.cookieHash, hash(cookie));
    if (ok && record.device) this.#touch(sessionId);
    return ok;
  }

  /** Jeton CSRF d'une session, à fournir au frontend après vérification du cookie. */
  csrfFor(sessionId: string, cookie: string): string {
    const record = this.#sessions.get(sessionId);
    if (!record || !safeEqual(record.cookieHash, hash(cookie))) throw new HumanSessionRequiredError();
    return record.csrf;
  }

  verify(sessionId: string, cookie: string, csrf: string): HumanSession {
    const record = this.#sessions.get(sessionId);
    if (!record || !safeEqual(record.cookieHash, hash(cookie)) || !safeEqual(record.csrf, csrf)) {
      throw new HumanSessionRequiredError();
    }
    return new HumanSession(MINT_KEY, sessionId);
  }

  isDevice(sessionId: string): boolean {
    return this.#sessions.get(sessionId)?.device ?? false;
  }

  #open(device: boolean): { sessionId: string; cookie: string; csrf: string } {
    const sessionId = randomBytes(9).toString("base64url");
    const cookie = randomBytes(32).toString("base64url");
    const csrf = randomBytes(32).toString("base64url");
    this.#sessions.set(sessionId, { cookieHash: hash(cookie), csrf, device });
    return { sessionId, cookie, csrf };
  }

  /** « Vu pour la dernière fois », enregistré au plus une fois par minute. */
  #touch(id: string): void {
    const now = Date.now();
    if (now - (this.#lastTouch.get(id) ?? 0) < 60_000) return;
    this.#lastTouch.set(id, now);
    this.#store?.touch(id, new Date(now).toISOString());
  }
}

const hash = (s: string) => createHash("sha256").update(s).digest("base64url");

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
