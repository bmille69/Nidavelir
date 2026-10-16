import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = DatabaseSync;

/**
 * Migrations appliquées dans l'ordre. Ne jamais modifier une migration publiée :
 * en ajouter une nouvelle.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE projects (
    slug TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    root TEXT NOT NULL UNIQUE,
    engine TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE counters (
    project TEXT NOT NULL,
    prefix TEXT NOT NULL,
    value INTEGER NOT NULL,
    PRIMARY KEY (project, prefix)
  );

  CREATE TABLE vision_revs (
    project TEXT PRIMARY KEY,
    rev INTEGER NOT NULL
  );

  -- Index reconstructible à partir des fichiers studio/items/*.md.
  CREATE TABLE items (
    project TEXT NOT NULL,
    id TEXT NOT NULL,
    type TEXT NOT NULL,
    status TEXT NOT NULL,
    tier TEXT NOT NULL,
    title TEXT NOT NULL,
    domain_json TEXT NOT NULL,
    vision_rev INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (project, id)
  );
  CREATE TABLE links (
    project TEXT NOT NULL,
    from_id TEXT NOT NULL,
    rel TEXT NOT NULL,
    to_id TEXT NOT NULL,
    PRIMARY KEY (project, from_id, rel, to_id)
  );
  CREATE INDEX links_to ON links (project, to_id);
  CREATE VIRTUAL TABLE items_fts USING fts5(
    project UNINDEXED, id UNINDEXED, title, statement,
    tokenize = 'unicode61 remove_diacritics 2'
  );

  CREATE TABLE approvals (
    id TEXT NOT NULL,
    project TEXT NOT NULL,
    subject_kind TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    subject_hash TEXT NOT NULL,
    verdict TEXT NOT NULL,
    note TEXT,
    edits_json TEXT,
    at TEXT NOT NULL,
    session TEXT NOT NULL,
    consumed_at TEXT,
    PRIMARY KEY (project, id)
  );
  -- Une approbation n'est modifiable qu'une fois : pour la marquer consommée.
  CREATE TRIGGER approvals_immutable BEFORE UPDATE ON approvals
  WHEN OLD.consumed_at IS NOT NULL
    OR NEW.id IS NOT OLD.id OR NEW.project IS NOT OLD.project
    OR NEW.subject_kind IS NOT OLD.subject_kind OR NEW.subject_id IS NOT OLD.subject_id
    OR NEW.subject_hash IS NOT OLD.subject_hash OR NEW.verdict IS NOT OLD.verdict
    OR NEW.note IS NOT OLD.note OR NEW.edits_json IS NOT OLD.edits_json
    OR NEW.at IS NOT OLD.at OR NEW.session IS NOT OLD.session
  BEGIN SELECT RAISE(ABORT, 'approvals are immutable'); END;
  CREATE TRIGGER approvals_no_delete BEFORE DELETE ON approvals
  BEGIN SELECT RAISE(ABORT, 'approvals are immutable'); END;

  -- Journal append-only.
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    project TEXT,
    actor_json TEXT NOT NULL,
    type TEXT NOT NULL,
    subject TEXT,
    payload_json TEXT NOT NULL
  );
  CREATE TRIGGER events_no_update BEFORE UPDATE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
  CREATE TRIGGER events_no_delete BEFORE DELETE ON events
  BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
  `,
  `
  CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL REFERENCES projects (slug),
    title TEXT NOT NULL,
    mode TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX threads_project ON threads (project, created_at);

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    thread TEXT NOT NULL REFERENCES threads (id),
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    at TEXT NOT NULL,
    extraction TEXT NOT NULL,
    cost_usd REAL,
    UNIQUE (thread, seq)
  );
  -- Ce qui a été dit ne se réécrit pas : seul le statut d'extraction évolue.
  CREATE TRIGGER messages_immutable BEFORE UPDATE ON messages
  WHEN NEW.id IS NOT OLD.id OR NEW.thread IS NOT OLD.thread OR NEW.seq IS NOT OLD.seq
    OR NEW.role IS NOT OLD.role OR NEW.text IS NOT OLD.text OR NEW.at IS NOT OLD.at
  BEGIN SELECT RAISE(ABORT, 'messages are immutable'); END;
  CREATE TRIGGER messages_no_delete BEFORE DELETE ON messages
  BEGIN SELECT RAISE(ABORT, 'messages are immutable'); END;
  `,
  `
  CREATE TABLE tasks (
    id TEXT NOT NULL,
    project TEXT NOT NULL REFERENCES projects (slug),
    status TEXT NOT NULL,
    data_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (project, id)
  );
  CREATE TABLE plans (
    id TEXT NOT NULL,
    project TEXT NOT NULL,
    task TEXT NOT NULL,
    status TEXT NOT NULL,
    data_json TEXT NOT NULL,
    PRIMARY KEY (project, id)
  );
  -- Le contenu d'un plan est figé : seul son statut peut changer.
  CREATE TRIGGER plans_immutable BEFORE UPDATE ON plans
  WHEN NEW.data_json IS NOT OLD.data_json OR NEW.id IS NOT OLD.id OR NEW.task IS NOT OLD.task
  BEGIN SELECT RAISE(ABORT, 'plans are immutable'); END;
  CREATE TABLE runs (
    id TEXT NOT NULL,
    project TEXT NOT NULL,
    task TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    cost_usd REAL,
    error TEXT,
    result_json TEXT,
    PRIMARY KEY (project, id)
  );
  CREATE TABLE escalations (
    id TEXT NOT NULL,
    project TEXT NOT NULL,
    task TEXT NOT NULL,
    run TEXT NOT NULL,
    status TEXT NOT NULL,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    decided_at TEXT,
    PRIMARY KEY (project, id)
  );
  `,
  `
  ALTER TABLE projects ADD COLUMN autonomy TEXT NOT NULL DEFAULT 'balanced';
  CREATE TABLE usage_log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    at TEXT NOT NULL,
    project TEXT,
    agent TEXT NOT NULL,
    model TEXT,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL,
    cache_write_tokens INTEGER NOT NULL,
    cost_usd REAL
  );
  CREATE INDEX usage_log_at ON usage_log (at);
  CREATE TABLE usage_limits (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    at TEXT NOT NULL,
    data_json TEXT NOT NULL
  );
  `,
  `
  -- Mode atelier par défaut (ADR-24) : plus de fiches ni de décisions à gérer.
  UPDATE projects SET autonomy = 'workshop' WHERE autonomy IN ('balanced', 'autonomous');
  `,
  `
  -- Votre avis sur chaque chantier (ADR-27).
  CREATE TABLE task_ratings (
    project TEXT NOT NULL,
    task TEXT NOT NULL,
    rating TEXT NOT NULL CHECK (rating IN ('up', 'down')),
    note TEXT,
    at TEXT NOT NULL,
    PRIMARY KEY (project, task)
  );
  `,
  `
  -- Conceptions : nouveau projet ou grosse fonctionnalité (ADR-28).
  CREATE TABLE conceptions (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('project', 'feature')),
    project TEXT,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE conception_messages (
    id TEXT PRIMARY KEY,
    conception TEXT NOT NULL REFERENCES conceptions (id),
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    data_json TEXT,
    cost_usd REAL,
    at TEXT NOT NULL
  );
  CREATE INDEX conception_messages_c ON conception_messages (conception, seq);
  `,
  `
  -- Compétences des agents (ADR-29).
  CREATE TABLE skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    body TEXT NOT NULL,
    agents_json TEXT NOT NULL,
    enabled INTEGER NOT NULL,
    source TEXT NOT NULL,
    project TEXT,
    updated_at TEXT NOT NULL
  );
  CREATE UNIQUE INDEX skills_name ON skills (name);
  `,
  `
  -- Téléphone : appareils connectés, réglages, abonnements aux notifications (ADR-30).
  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    cookie_hash TEXT NOT NULL,
    csrf TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen TEXT NOT NULL
  );
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE push_subscriptions (
    endpoint TEXT PRIMARY KEY,
    device TEXT,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  `
  -- Vérifications faites par le hub avant fusion : tests du jeu, le jeu se lance (ADR-32).
  CREATE TABLE checks (
    project TEXT NOT NULL,
    task TEXT NOT NULL,
    data_json TEXT NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (project, task)
  );
  `,
  `
  -- Carnet « État du jeu », réécrit après chaque chantier fusionné (ADR-33).
  CREATE TABLE game_state (
    project TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    task TEXT
  );
  `,
  `
  -- Atelier de démontage (ADR-40) : jeux que vous possédez, démontés pour les étudier ou les modifier.
  CREATE TABLE dissections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    status TEXT NOT NULL,
    scan_json TEXT NOT NULL,
    mode TEXT,
    error TEXT,
    files INTEGER,
    mod_project TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE dissection_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    dissection TEXT NOT NULL REFERENCES dissections(id),
    title TEXT NOT NULL,
    question TEXT NOT NULL,
    body TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  `
  -- ADR-41 : Fable seulement pour les chantiers « (gros) » ; les autres reviennent au modèle recommandé (Sonnet).
  UPDATE settings SET value = json_set(value, '$.developer_big', 'fable', '$.developer', 'sonnet')
  WHERE key = 'models' AND json_extract(value, '$.developer') = 'fable';
  `,
  `
  -- ADR-42 : empreinte du jeu installé au moment du démontage, pour repérer ses mises à jour.
  ALTER TABLE dissections ADD COLUMN fingerprint TEXT;
  `,
  `
  -- ADR-43 : la discussion avec le Directeur artistique, une par projet. Bible, moodboard et assets vivent dans studio/art du jeu.
  CREATE TABLE art_messages (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL REFERENCES projects (slug),
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,
    text TEXT NOT NULL,
    at TEXT NOT NULL,
    cost_usd REAL,
    UNIQUE (project, seq)
  );
  `,
];

export function openDatabase(path: string): Db {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)");
  const row = db.prepare("SELECT version FROM schema_version").get() as { version: number } | undefined;
  let version = row?.version ?? 0;
  if (!row) db.prepare("INSERT INTO schema_version (version) VALUES (0)").run();
  while (version < MIGRATIONS.length) {
    const sql = MIGRATIONS[version]!;
    transaction(db, () => {
      db.exec(sql);
      db.prepare("UPDATE schema_version SET version = ?").run(version + 1);
    });
    version++;
  }
}

/** Exécute fn dans une transaction ; annule si fn lève une exception. */
export function transaction<T>(db: Db, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
