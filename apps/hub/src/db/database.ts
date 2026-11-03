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
  `
  -- ADR-44 : le Jeu express, de l'idée à un jeu jouable en quelques minutes (dossier prototypes/ des jeux).
  CREATE TABLE express_games (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    idea TEXT NOT NULL,
    mode TEXT NOT NULL,
    status TEXT NOT NULL,
    phase TEXT NOT NULL,
    root TEXT NOT NULL,
    concept_json TEXT,
    summary TEXT,
    how_to_play TEXT,
    error TEXT,
    project TEXT,
    version INTEGER NOT NULL DEFAULT 0,
    shot INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    events_json TEXT NOT NULL DEFAULT '[]'
  );
  `,
  `
  -- ADR-61 : les travaux longs du Directeur artistique en cours, repris après un redémarrage du hub.
  CREATE TABLE art_jobs (
    key TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    started_at TEXT NOT NULL
  );
  `,
  `
  -- ADR-65 : le studio de modding, des mods pour les jeux du commerce que vous possédez.
  CREATE TABLE mods (
    id TEXT PRIMARY KEY,
    recipe TEXT NOT NULL,
    appid TEXT NOT NULL,
    game TEXT NOT NULL,
    game_dir TEXT NOT NULL,
    name TEXT NOT NULL,
    title TEXT NOT NULL,
    idea TEXT NOT NULL,
    status TEXT NOT NULL,
    phase TEXT NOT NULL,
    root TEXT NOT NULL,
    plan_json TEXT,
    report_json TEXT,
    game_build TEXT,
    installed_json TEXT,
    played_json TEXT,
    error TEXT,
    version INTEGER NOT NULL DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    events_json TEXT NOT NULL DEFAULT '[]'
  );
  `,
  `
  -- ADR-82 : ce que chaque visuel a coûté (modèles et crédits Tripo), et le plafond que vous avez relevé.
  CREATE TABLE art_spend (
    project TEXT NOT NULL,
    asset TEXT NOT NULL,
    usd REAL NOT NULL DEFAULT 0,
    credits INTEGER NOT NULL DEFAULT 0,
    raises INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (project, asset)
  );
  `,
  `
  -- ADR-86 : les passages de l'équilibreur, des centaines de parties simulées sans écran.
  CREATE TABLE sim_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    at TEXT NOT NULL,
    commit_sha TEXT,
    runs INTEGER NOT NULL,
    status TEXT NOT NULL,
    data_json TEXT NOT NULL DEFAULT '[]',
    error TEXT
  );
  CREATE INDEX sim_runs_project ON sim_runs (project, id);
  `,
  `
  -- ADR-87 : le banc d'essai des agents, des chantiers de référence rejoués à chaque changement de modèle ou de consignes.
  CREATE TABLE bench_cases (
    project TEXT NOT NULL,
    id TEXT NOT NULL,
    source_task TEXT NOT NULL,
    title TEXT NOT NULL,
    goal TEXT NOT NULL,
    base_commit TEXT NOT NULL,
    original_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    PRIMARY KEY (project, id)
  );
  CREATE TABLE bench_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT NOT NULL,
    at TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    status TEXT NOT NULL,
    results_json TEXT NOT NULL DEFAULT '[]'
  );
  CREATE INDEX bench_runs_project ON bench_runs (project, id);
  `,
  `
  -- ADR-89 : le journal de bord, la semaine racontée par le directeur (sur votre demande).
  CREATE TABLE logbook_weeks (
    project TEXT NOT NULL,
    week TEXT NOT NULL,
    text TEXT NOT NULL,
    at TEXT NOT NULL,
    PRIMARY KEY (project, week)
  );
  `,
  `
  -- ADR-92 : chaque passage d'un agent garde ses jetons réels et son chemin (direct ou relais Caveman), pour comparer.
  ALTER TABLE runs ADD COLUMN route TEXT;
  ALTER TABLE runs ADD COLUMN tokens_json TEXT;
  `,
  `
  -- ADR-95 : une fiche de l'Archéologue peut être un « dossier de feature » (règles, données, scénarios chiffrés).
  ALTER TABLE dissection_notes ADD COLUMN kind TEXT NOT NULL DEFAULT 'note';
  ALTER TABLE dissection_notes ADD COLUMN pack_json TEXT;
  `,
  `
  -- ADR-97 : compétences tenues toutes seules (apprises des chantiers, importées d'Hermes), annexes et usage.
  ALTER TABLE skills ADD COLUMN origin TEXT;
  ALTER TABLE skills ADD COLUMN previous_json TEXT;
  CREATE TABLE skill_files (
    skill_id TEXT NOT NULL,
    path TEXT NOT NULL,
    content TEXT NOT NULL,
    PRIMARY KEY (skill_id, path)
  );
  CREATE TABLE skill_stats (
    skill_id TEXT PRIMARY KEY,
    offered INTEGER NOT NULL DEFAULT 0,
    used INTEGER NOT NULL DEFAULT 0,
    offered_since_use INTEGER NOT NULL DEFAULT 0,
    last_offered_at TEXT,
    last_used_at TEXT
  );
  CREATE TABLE skill_imports (
    origin TEXT PRIMARY KEY,
    hash TEXT NOT NULL,
    decision TEXT NOT NULL,
    skill_id TEXT,
    reason TEXT,
    evaluated_at TEXT NOT NULL
  );
  `,
  `
  -- ADR-98 : les agents se consultent ; chaque échange est gardé et montré.
  CREATE TABLE consultations (
    id TEXT PRIMARY KEY,
    project TEXT,
    from_agent TEXT NOT NULL,
    to_agent TEXT NOT NULL,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    status TEXT NOT NULL,
    cost_usd REAL,
    at TEXT NOT NULL
  );
  CREATE INDEX consultations_project ON consultations (project, at);
  -- ADR-99 : la mémoire du studio, proposée par les agents, gardée par vous seul.
  CREATE TABLE studio_memory (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    status TEXT NOT NULL,
    by_agent TEXT NOT NULL,
    project TEXT,
    reason TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT
  );
  -- ADR-100 : l'Atelier d'idées, avant les projets.
  CREATE TABLE ideas (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    inspirations_json TEXT NOT NULL DEFAULT '[]',
    insight_json TEXT,
    conception TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  `
  -- ADR-102 : quarantaine et essais automatiques des compétences, mesure continue, besoins, catalogue public.
  ALTER TABLE skills ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
  ALTER TABLE skills ADD COLUMN trial_json TEXT;
  CREATE TABLE skill_trials (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    skill_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    verdict TEXT,
    detail_json TEXT,
    created_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE TABLE skill_tasks (
    skill_id TEXT NOT NULL,
    project TEXT NOT NULL,
    task TEXT NOT NULL,
    used INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (skill_id, project, task)
  );
  CREATE TABLE skill_needs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project TEXT,
    topic TEXT NOT NULL,
    origin TEXT NOT NULL,
    status TEXT NOT NULL,
    result TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE skill_catalog (
    source TEXT NOT NULL,
    path TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    license TEXT,
    status TEXT,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (source, path)
  );
  CREATE TABLE skill_lab (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // Les plans de production (ADR-107) : un objectif, tous les métiers enchaînés.
  `
  CREATE TABLE productions (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    thread TEXT NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL,
    auto INTEGER NOT NULL DEFAULT 0,
    brief TEXT NOT NULL,
    plan_json TEXT,
    refs_json TEXT NOT NULL,
    note TEXT,
    cost_usd REAL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX productions_project ON productions (project, status);
  `,
  // Qui a ouvert une discussion (ADR-113) : vous, ou le hub pour un travail automatique (intégration, retouche, sons…).
  `
  ALTER TABLE threads ADD COLUMN origin TEXT;
  `,
  // Le projet démonté se recompile-t-il et démarre-t-il ? Mesuré, avec les fichiers recréés (ADR-120).
  `
  ALTER TABLE dissections ADD COLUMN launch_json TEXT;
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
