import { assertHumanSession, type HumanSession } from "../auth/human-session.ts";
import type { Clock } from "../clock.ts";
import type { Db } from "../db/database.ts";
import type { Journal } from "../journal/journal.ts";
import { generateVapidKeys, sendPush, type PushSubscription, type VapidKeys } from "./web-push.ts";

export type Notice = { title: string; body: string; url: string; tag?: string };

/**
 * Notifications sur le téléphone (ADR-30) : abonnements Web Push et envoi des événements
 * qui vous concernent (chantier prêt, échec, demande d'autorisation, Concepteur qui attend).
 */
export class NotificationService {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #journal: Journal;
  readonly #subject: string;
  readonly #fetch: typeof fetch;
  readonly #background = new Set<Promise<void>>();

  constructor(deps: { db: Db; clock: Clock; journal: Journal; subject?: string; fetch?: typeof fetch }) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#journal = deps.journal;
    this.#subject = deps.subject ?? "mailto:game-studio-hub@example.com";
    this.#fetch = deps.fetch ?? fetch;
  }

  /** Clé publique VAPID (créée une fois, conservée). */
  publicKey(): string {
    return this.#keys().publicKey;
  }

  subscribe(session: HumanSession, sub: PushSubscription, device: string | null): void {
    assertHumanSession(session);
    this.#db
      .prepare("INSERT INTO push_subscriptions (endpoint, device, data_json, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (endpoint) DO UPDATE SET device = excluded.device, data_json = excluded.data_json")
      .run(sub.endpoint, device, JSON.stringify(sub), this.#clock.now());
  }

  unsubscribe(session: HumanSession, endpoint: string): void {
    assertHumanSession(session);
    this.#db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint);
  }

  /** Abonnements d'un appareil supprimé. */
  forgetDevice(device: string): void {
    this.#db.prepare("DELETE FROM push_subscriptions WHERE device = ?").run(device);
  }

  list(): { endpoint: string; device: string | null; created_at: string }[] {
    return this.#db.prepare("SELECT endpoint, device, created_at FROM push_subscriptions ORDER BY created_at").all() as never;
  }

  /** Envoie à tous vos appareils abonnés, en arrière-plan. Un abonnement expiré est oublié. */
  notify(notice: Notice): void {
    const subs = this.#db.prepare("SELECT endpoint, data_json FROM push_subscriptions").all() as { endpoint: string; data_json: string }[];
    if (!subs.length) return;
    const keys = this.#keys();
    const job = (async () => {
      for (const s of subs) {
        try {
          const status = await sendPush(JSON.parse(s.data_json) as PushSubscription, notice, keys, this.#subject, this.#fetch);
          if (status === 404 || status === 410) this.#db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(s.endpoint);
          else if (status >= 400) this.#journal.append({ project: null, actor: { kind: "system" }, type: "push.failed", payload: { status } });
        } catch (err) {
          this.#journal.append({ project: null, actor: { kind: "system" }, type: "push.failed", payload: { error: (err as Error).message.slice(0, 200) } });
        }
      }
    })();
    this.#background.add(job);
    void job.finally(() => this.#background.delete(job));
  }

  async idle(): Promise<void> {
    while (this.#background.size) await Promise.allSettled([...this.#background]);
  }

  #keys(): VapidKeys {
    const row = this.#db.prepare("SELECT value FROM settings WHERE key = 'vapid'").get() as { value: string } | undefined;
    if (row) return JSON.parse(row.value) as VapidKeys;
    const keys = generateVapidKeys();
    this.#db.prepare("INSERT INTO settings (key, value) VALUES ('vapid', ?)").run(JSON.stringify(keys));
    return keys;
  }
}
