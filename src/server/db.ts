import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const SCHEMA_VERSION = 2;

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
  parent_id TEXT REFERENCES task(id),
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

  // A brand-new DB already has the latest shape from SCHEMA_SQL above; only an
  // existing board at an older version needs its tables altered. `current === 0`
  // covers both a fresh DB and a pre-`meta` board — the column guard below keeps
  // the ALTER idempotent either way.
  if (current > 0 && current < 2) {
    addColumnIfMissing(db, 'task', 'parent_id', 'TEXT REFERENCES task(id)');
  }

  // Safe once the column is guaranteed present (fresh DBs get it from CREATE TABLE,
  // older boards from the ALTER above). Kept out of SCHEMA_SQL because that runs
  // before this migration, when an old board's `parent_id` does not yet exist.
  db.exec('CREATE INDEX IF NOT EXISTS idx_task_parent ON task(parent_id)');

  if (current < SCHEMA_VERSION) {
    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)').run(
      'schema_version',
      String(SCHEMA_VERSION),
    );
  }
}

/** Add a column only if absent — keeps repeated migrations idempotent. */
function addColumnIfMissing(db: DB, table: string, column: string, decl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  }
}
