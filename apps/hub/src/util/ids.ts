import type { Db } from "../db/database.ts";

/** Attribue le prochain identifiant d'un préfixe pour un projet (ex. D-0007). */
export function nextId(db: Db, project: string, prefix: string): string {
  db.prepare(
    `INSERT INTO counters (project, prefix, value) VALUES (?, ?, 1)
     ON CONFLICT (project, prefix) DO UPDATE SET value = value + 1`,
  ).run(project, prefix);
  const row = db.prepare("SELECT value FROM counters WHERE project = ? AND prefix = ?").get(project, prefix) as {
    value: number;
  };
  return `${prefix}-${String(row.value).padStart(4, "0")}`;
}

/**
 * Identifiant unique pour tout le hub, quel que soit le projet (ex. RUN-0465) : toujours au-dessus de tous ceux déjà
 * donnés sous ce préfixe. Les passages des agents en ont besoin : le hub les retrouve par leur seul numéro (audit du 28/10,
 * 129 numéros « RUN-xxxx » existaient dans deux jeux à la fois, avec le même dossier de travail).
 */
export function nextGlobalId(db: Db, prefix: string): string {
  db.prepare(
    `INSERT INTO counters (project, prefix, value) VALUES ('*', ?, (SELECT COALESCE(MAX(value), 0) + 1 FROM counters WHERE prefix = ?))
     ON CONFLICT (project, prefix) DO UPDATE SET value = excluded.value`,
  ).run(prefix, prefix);
  const row = db.prepare("SELECT value FROM counters WHERE project = '*' AND prefix = ?").get(prefix) as { value: number };
  return `${prefix}-${String(row.value).padStart(4, "0")}`;
}

/** Garantit que le compteur ne redescend jamais sous un identifiant existant. */
export function bumpCounterTo(db: Db, project: string, id: string): void {
  const match = /^([A-Z]+)-(\d+)$/.exec(id);
  if (!match) return;
  const [, prefix, num] = match;
  db.prepare(
    `INSERT INTO counters (project, prefix, value) VALUES (?, ?, ?)
     ON CONFLICT (project, prefix) DO UPDATE SET value = MAX(value, excluded.value)`,
  ).run(project, prefix!, Number(num));
}
