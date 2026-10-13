import { randomBytes, timingSafeEqual } from "node:crypto";

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

type SessionRecord = { cookie: string; csrf: string };

export class HumanSessions {
  readonly #sessions = new Map<string, SessionRecord>();
  readonly #pendingLogins = new Map<string, true>();

  /** Lien à usage unique affiché au lancement du hub. */
  createLoginToken(): string {
    const token = randomBytes(24).toString("base64url");
    this.#pendingLogins.set(token, true);
    return token;
  }

  /** Échange le jeton à usage unique contre un cookie et un jeton CSRF. */
  login(loginToken: string): { sessionId: string; cookie: string; csrf: string } {
    if (!this.#pendingLogins.delete(loginToken)) throw new HumanSessionRequiredError();
    const sessionId = randomBytes(9).toString("base64url");
    const record = {
      cookie: randomBytes(32).toString("base64url"),
      csrf: randomBytes(32).toString("base64url"),
    };
    this.#sessions.set(sessionId, record);
    return { sessionId, ...record };
  }

  verify(sessionId: string, cookie: string, csrf: string): HumanSession {
    const record = this.#sessions.get(sessionId);
    if (!record || !safeEqual(record.cookie, cookie) || !safeEqual(record.csrf, csrf)) {
      throw new HumanSessionRequiredError();
    }
    return new HumanSession(MINT_KEY, sessionId);
  }
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
