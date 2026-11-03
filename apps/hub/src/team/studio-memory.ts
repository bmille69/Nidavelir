import { randomUUID } from "node:crypto";
import { assertHumanSession, type HumanSession } from "../auth/human-session.ts";
import type { Clock } from "../clock.ts";
import type { Db } from "../db/database.ts";
import type { Journal } from "../journal/journal.ts";

export class MemoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryError";
  }
}

export type MemoryStatus = "active" | "proposed" | "rejected";
/** Un souvenir du studio (ADR-99) : une préférence, un refus ou une règle du directeur créatif, valable pour tous ses jeux. */
export type Memory = {
  id: string;
  text: string;
  status: MemoryStatus;
  /** « human » si vous l'avez écrit ; sinon l'agent qui l'a proposé. */
  by: string;
  project: string | null;
  reason: string | null;
  created_at: string;
  decided_at: string | null;
};

const MAX_TEXT = 400;
const MAX_PENDING = 30;
/** Ce qui entre dans les consignes de chaque agent, au plus. */
const MAX_BLOCK = 5000;

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * La mémoire du studio (ADR-99) : ce que le directeur créatif a appris à son équipe, donné à tous les agents, sur tous
 * les projets. Les agents proposent, vous seul validez : rien n'entre sans votre clic.
 */
export class StudioMemory {
  readonly #db: Db;
  readonly #clock: Clock;
  readonly #journal: Journal;
  /** Prévenu quand un agent propose un souvenir (notification). */
  onProposed: ((m: Memory) => void) | null = null;

  constructor(deps: { db: Db; clock: Clock; journal: Journal }) {
    this.#db = deps.db;
    this.#clock = deps.clock;
    this.#journal = deps.journal;
  }

  list(): Memory[] {
    return (this.#db.prepare("SELECT * FROM studio_memory WHERE status != 'rejected' ORDER BY status = 'proposed' DESC, created_at DESC").all() as Row[]).map(toMemory);
  }

  active(): Memory[] {
    return (this.#db.prepare("SELECT * FROM studio_memory WHERE status = 'active' ORDER BY created_at").all() as Row[]).map(toMemory);
  }

  /** Le bloc ajouté aux consignes de chaque agent ; vide tant que la mémoire est vide. */
  block(): string {
    const lines: string[] = [];
    let size = 0;
    for (const m of this.active()) {
      const line = `- ${m.text}`;
      if (size + line.length > MAX_BLOCK) break;
      lines.push(line);
      size += line.length + 1;
    }
    if (!lines.length) return "";
    return `<memoire_du_studio note="ce que le directeur créatif a appris à son équipe : valable pour tous ses jeux, prime sur tes habitudes ; une décision validée du jeu prime sur elle">\n${lines.join("\n")}\n</memoire_du_studio>`;
  }

  /** Un agent propose un souvenir : il attend votre accord. Un doublon (déjà gardé ou déjà proposé) est ignoré. */
  propose(input: { text: string; by: string; project: string | null; reason?: string | null }): { memory: Memory | null; note: string } {
    const text = clean(input.text);
    if (text.length < 8) throw new MemoryError("Souvenir trop court");
    const key = norm(text);
    const known = (this.#db.prepare("SELECT * FROM studio_memory").all() as Row[]).map(toMemory).find((m) => norm(m.text) === key);
    if (known) {
      return { memory: null, note: known.status === "rejected" ? "Le directeur créatif l'a déjà refusé : ne le propose plus." : known.status === "active" ? "C'est déjà dans la mémoire du studio." : "C'est déjà proposé, en attente de son accord." };
    }
    const pending = (this.#db.prepare("SELECT COUNT(*) AS n FROM studio_memory WHERE status = 'proposed'").get() as { n: number }).n;
    if (pending >= MAX_PENDING) return { memory: null, note: "Trop de souvenirs attendent déjà son accord : n'en propose pas d'autre pour l'instant." };
    const m = this.#insert(text, "proposed", input.by, input.project, input.reason ? clean(input.reason).slice(0, 300) : null);
    this.#journal.append({ project: input.project, actor: { kind: "system" }, type: "memory.proposed", subject: m.id, payload: { by: input.by, text } });
    this.onProposed?.(m);
    return { memory: m, note: "Proposé : le directeur créatif le verra et décidera." };
  }

  /** Vous écrivez un souvenir vous-même : il est gardé tout de suite. */
  add(session: HumanSession, text: string): Memory {
    assertHumanSession(session);
    const t = clean(text);
    if (t.length < 3) throw new MemoryError("Écrivez au moins quelques mots");
    const m = this.#insert(t, "active", "human", null, null);
    this.#journal.append({ project: null, actor: { kind: "human" }, type: "memory.added", subject: m.id, payload: { text: t } });
    return m;
  }

  update(session: HumanSession, id: string, text: string): Memory {
    assertHumanSession(session);
    const m = this.get(id);
    const t = clean(text);
    if (t.length < 3) throw new MemoryError("Écrivez au moins quelques mots");
    this.#db.prepare("UPDATE studio_memory SET text = ? WHERE id = ?").run(t, m.id);
    this.#journal.append({ project: null, actor: { kind: "human" }, type: "memory.edited", subject: m.id, payload: { text: t } });
    return this.get(id);
  }

  /** Garder (actif) ou refuser un souvenir proposé ; refusé, il ne sera plus reproposé. */
  decide(session: HumanSession, id: string, keep: boolean): Memory {
    assertHumanSession(session);
    const m = this.get(id);
    if (m.status !== "proposed") throw new MemoryError("Ce souvenir n'attend pas de décision");
    this.#db.prepare("UPDATE studio_memory SET status = ?, decided_at = ? WHERE id = ?").run(keep ? "active" : "rejected", this.#clock.now(), id);
    this.#journal.append({ project: m.project, actor: { kind: "human" }, type: keep ? "memory.accepted" : "memory.rejected", subject: id, payload: {} });
    return this.get(id);
  }

  /** Oublier un souvenir gardé (il pourra être reproposé). */
  remove(session: HumanSession, id: string): void {
    assertHumanSession(session);
    this.get(id);
    this.#db.prepare("DELETE FROM studio_memory WHERE id = ?").run(id);
    this.#journal.append({ project: null, actor: { kind: "human" }, type: "memory.removed", subject: id, payload: {} });
  }

  get(id: string): Memory {
    const row = this.#db.prepare("SELECT * FROM studio_memory WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new MemoryError("Souvenir introuvable");
    return toMemory(row);
  }

  #insert(text: string, status: MemoryStatus, by: string, project: string | null, reason: string | null): Memory {
    const m: Memory = { id: randomUUID(), text, status, by, project, reason, created_at: this.#clock.now(), decided_at: status === "active" ? this.#clock.now() : null };
    this.#db
      .prepare("INSERT INTO studio_memory (id, text, status, by_agent, project, reason, created_at, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(m.id, m.text, m.status, m.by, m.project, m.reason, m.created_at, m.decided_at);
    return m;
  }
}

type Row = Record<string, unknown>;
const toMemory = (r: Row): Memory => ({
  id: String(r.id),
  text: String(r.text),
  status: r.status as MemoryStatus,
  by: String(r.by_agent),
  project: (r.project as string | null) ?? null,
  reason: (r.reason as string | null) ?? null,
  created_at: String(r.created_at),
  decided_at: (r.decided_at as string | null) ?? null,
});

const clean = (s: string) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
