import type { Actor, HubEvent } from "@studio/contracts";
import type { Clock } from "../clock.ts";
import type { Db } from "../db/database.ts";
import { redactSecrets } from "./redact.ts";

export type NewEvent = {
  project: string | null;
  actor: Actor;
  type: string;
  subject?: string | null;
  payload?: Record<string, unknown>;
};

/**
 * Journal append-only. Il n'expose volontairement aucune méthode de modification
 * ni de suppression ; la base le garantit aussi par triggers.
 */
export class Journal {
  readonly #db: Db;
  readonly #clock: Clock;

  constructor(db: Db, clock: Clock) {
    this.#db = db;
    this.#clock = clock;
  }

  append(event: NewEvent): number {
    const payload = redactSecrets(event.payload ?? {});
    const result = this.#db
      .prepare(
        "INSERT INTO events (at, project, actor_json, type, subject, payload_json) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        this.#clock.now(),
        event.project,
        JSON.stringify(event.actor),
        event.type,
        event.subject ?? null,
        JSON.stringify(payload),
      );
    return Number(result.lastInsertRowid);
  }

  list(filter: { project?: string; subject?: string; limit?: number } = {}): HubEvent[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.project) {
      where.push("project = ?");
      params.push(filter.project);
    }
    if (filter.subject) {
      where.push("subject = ?");
      params.push(filter.subject);
    }
    const sql = `SELECT * FROM events ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY seq LIMIT ?`;
    params.push(filter.limit ?? 1000);
    const rows = this.#db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((r) => ({
      seq: Number(r.seq),
      at: String(r.at),
      project: (r.project as string | null) ?? null,
      actor: JSON.parse(String(r.actor_json)),
      type: String(r.type),
      subject: (r.subject as string | null) ?? null,
      payload: JSON.parse(String(r.payload_json)),
    }));
  }
}
