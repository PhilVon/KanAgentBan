import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const SCHEMA_VERSION = 1;

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS counters (
  name TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS task (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  summary TEXT,
  summary_source TEXT,
  summary_updated_at TEXT,
  description_updated_at TEXT,
  status TEXT NOT NULL DEFAULT 'Backlog',
  priority TEXT NOT NULL DEFAULT 'P2',
  position REAL,
  assignee TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS dependency (
  from_task TEXT NOT NULL,
  to_task TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'blocks',
  PRIMARY KEY (from_task, to_task, type)
);

CREATE TABLE IF NOT EXISTS comment (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  body TEXT NOT NULL,
  author_type TEXT NOT NULL,
  author_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS input_request (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  question TEXT NOT NULL,
  options TEXT,
  answer_freeform INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  answer TEXT,
  answered_by TEXT,
  created_at TEXT NOT NULL,
  answered_at TEXT,
  expires_at TEXT
);

CREATE TABLE IF NOT EXISTS acceptance_criterion (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  text TEXT NOT NULL,
  checked INTEGER NOT NULL DEFAULT 0,
  checked_at TEXT,
  position REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS artifact (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  uri TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS label (
  name TEXT PRIMARY KEY,
  color TEXT
);

CREATE TABLE IF NOT EXISTS task_label (
  task_id TEXT NOT NULL,
  label_name TEXT NOT NULL,
  PRIMARY KEY (task_id, label_name)
);

CREATE TABLE IF NOT EXISTS event (
  seq INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  task_id TEXT,
  actor_type TEXT NOT NULL,
  payload TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_event_seq ON event(seq);
CREATE INDEX IF NOT EXISTS idx_ir_status ON input_request(status);
CREATE INDEX IF NOT EXISTS idx_ir_task ON input_request(task_id);
CREATE INDEX IF NOT EXISTS idx_dep_from ON dependency(from_task);
CREATE INDEX IF NOT EXISTS idx_dep_to ON dependency(to_task);
CREATE INDEX IF NOT EXISTS idx_comment_task ON comment(task_id);
CREATE INDEX IF NOT EXISTS idx_task_status ON task(status);
`;

export type DB = Database.Database;

/**
 * Open (and migrate) the board database. One DB file per project — the storage
 * decision is locked (see docs/02-data-model.md, docs/10-security-lifecycle.md).
 */
export function openDb(dbPath: string): DB {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL'); // concurrent UI reads while the server writes
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA_SQL);
  migrate(db);
  return db;
}

function migrate(db: DB): void {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version') as
    | { value: string }
    | undefined;
  const current = row ? Number(row.value) : 0;
  if (current === 0) {
    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)').run(
      'schema_version',
      String(SCHEMA_VERSION),
    );
  }
  // Future migrations: if (current < N) { ...; bump } — see docs/10 §migrations.
}
