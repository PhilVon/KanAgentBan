import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';

export const SCHEMA_VERSION = 11;

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
  claim_expires_at TEXT,
  parent_id TEXT REFERENCES task(id),
  checkpoint TEXT,
  checkpoint_at TEXT,
  checkpoint_by TEXT,
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
  kind TEXT NOT NULL DEFAULT 'question',
  options TEXT,
  answer_freeform INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open',
  answer TEXT,
  answered_by TEXT,
  created_at TEXT NOT NULL,
  answered_at TEXT,
  expires_at TEXT,
  default_answer TEXT
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

CREATE TABLE IF NOT EXISTS doc (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  summary TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  superseded_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);

CREATE TABLE IF NOT EXISTS doc_link (
  doc_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  PRIMARY KEY (doc_id, task_id)
);

CREATE TABLE IF NOT EXISTS brainstorm_session (
  id TEXT PRIMARY KEY,
  topic TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  task_id TEXT,
  created_at TEXT NOT NULL,
  closed_at TEXT
);

CREATE TABLE IF NOT EXISTS idea (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  text TEXT NOT NULL,
  cluster TEXT,
  score INTEGER,
  status TEXT NOT NULL DEFAULT 'open',
  promoted_task_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS template (
  name TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
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
CREATE INDEX IF NOT EXISTS idx_doc_kind ON doc(kind);
CREATE INDEX IF NOT EXISTS idx_doclink_task ON doc_link(task_id);
CREATE INDEX IF NOT EXISTS idx_doclink_doc ON doc_link(doc_id);
CREATE INDEX IF NOT EXISTS idx_idea_session ON idea(session_id);
`;

// Search index (v5): one self-contained FTS5 table spanning tasks, docs, and
// comments. `type`/`ref_id` are UNINDEXED metadata; `title`/`body` are the
// searchable text. Task and doc triggers delete-then-conditionally-reinsert so an
// archived row drops out of the index; comments are insert/delete only (no comment
// edit path exists) and a comment on an archived task is filtered at query time
// (repo.search liveness check).
const FTS_SQL = `
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  type UNINDEXED, ref_id UNINDEXED, title, body
);

CREATE TRIGGER IF NOT EXISTS trg_fts_task_ai AFTER INSERT ON task BEGIN
  INSERT INTO search_index(type, ref_id, title, body)
  VALUES('task', new.id, new.title, COALESCE(new.description,'') || ' ' || COALESCE(new.summary,''));
END;
CREATE TRIGGER IF NOT EXISTS trg_fts_task_au AFTER UPDATE ON task BEGIN
  DELETE FROM search_index WHERE type = 'task' AND ref_id = old.id;
  INSERT INTO search_index(type, ref_id, title, body)
  SELECT 'task', new.id, new.title, COALESCE(new.description,'') || ' ' || COALESCE(new.summary,'')
  WHERE new.archived_at IS NULL;
END;
CREATE TRIGGER IF NOT EXISTS trg_fts_task_ad AFTER DELETE ON task BEGIN
  DELETE FROM search_index WHERE type = 'task' AND ref_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_fts_doc_ai AFTER INSERT ON doc BEGIN
  INSERT INTO search_index(type, ref_id, title, body)
  VALUES('doc', new.id, new.title, COALESCE(new.summary,'') || ' ' || COALESCE(new.body,''));
END;
CREATE TRIGGER IF NOT EXISTS trg_fts_doc_au AFTER UPDATE ON doc BEGIN
  DELETE FROM search_index WHERE type = 'doc' AND ref_id = old.id;
  INSERT INTO search_index(type, ref_id, title, body)
  SELECT 'doc', new.id, new.title, COALESCE(new.summary,'') || ' ' || COALESCE(new.body,'')
  WHERE new.archived_at IS NULL;
END;
CREATE TRIGGER IF NOT EXISTS trg_fts_doc_ad AFTER DELETE ON doc BEGIN
  DELETE FROM search_index WHERE type = 'doc' AND ref_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_fts_comment_ai AFTER INSERT ON comment BEGIN
  INSERT INTO search_index(type, ref_id, title, body) VALUES('comment', new.id, '', new.body);
END;
CREATE TRIGGER IF NOT EXISTS trg_fts_comment_ad AFTER DELETE ON comment BEGIN
  DELETE FROM search_index WHERE type = 'comment' AND ref_id = old.id;
END;
`;

// Idea search triggers (v6). Split from FTS_SQL because a board that upgraded to
// v5 already has `fts_enabled` set and skips FTS_SQL — these idempotent CREATEs
// run on every open while FTS is on. Ideas of any status stay searchable (a
// discarded idea is still prior art); text edits reinsert via the update trigger.
const IDEA_FTS_SQL = `
CREATE TRIGGER IF NOT EXISTS trg_fts_idea_ai AFTER INSERT ON idea BEGIN
  INSERT INTO search_index(type, ref_id, title, body) VALUES('idea', new.id, '', new.text);
END;
CREATE TRIGGER IF NOT EXISTS trg_fts_idea_au AFTER UPDATE ON idea BEGIN
  DELETE FROM search_index WHERE type = 'idea' AND ref_id = old.id;
  INSERT INTO search_index(type, ref_id, title, body) VALUES('idea', new.id, '', new.text);
END;
CREATE TRIGGER IF NOT EXISTS trg_fts_idea_ad AFTER DELETE ON idea BEGIN
  DELETE FROM search_index WHERE type = 'idea' AND ref_id = old.id;
END;
`;

/** One-time index seed for a board that predates v5 (or a fresh board — its
 *  tables are empty, so this is a no-op there). */
function backfillSearchIndex(db: Database.Database): void {
  db.exec(`
    DELETE FROM search_index;
    INSERT INTO search_index(type, ref_id, title, body)
      SELECT 'task', id, title, COALESCE(description,'') || ' ' || COALESCE(summary,'')
        FROM task WHERE archived_at IS NULL;
    INSERT INTO search_index(type, ref_id, title, body)
      SELECT 'doc', id, title, COALESCE(summary,'') || ' ' || COALESCE(body,'')
        FROM doc WHERE archived_at IS NULL;
    INSERT INTO search_index(type, ref_id, title, body)
      SELECT 'comment', id, '', body FROM comment;
    INSERT INTO search_index(type, ref_id, title, body)
      SELECT 'idea', id, '', text FROM idea;
  `);
}

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

  // v2 -> v3: event-log compaction floor. The highest `seq` that has been deleted
  // by compaction; `0` means nothing has been compacted. Seeded for both fresh and
  // existing boards (idempotent — only inserts when absent). No table change needed
  // since `meta` already exists. See docs/02-data-model.md and repo.compact().
  if (!db.prepare('SELECT 1 FROM meta WHERE key = ?').get('compaction_floor')) {
    db.prepare('INSERT INTO meta(key, value) VALUES(?, ?)').run('compaction_floor', '0');
  }

  // v3 -> v4: docs (`doc` + `doc_link` + indexes). Purely additive new tables, so
  // both fresh and existing boards get them from the idempotent CREATEs in
  // SCHEMA_SQL above — no ALTER needed here, only the version stamp below.

  // v4 -> v5: board-wide search. An FTS5 index over tasks/docs/comments, kept in
  // sync by SQL triggers (they can't be forgotten by a future write path). Guarded:
  // if this SQLite build lacks FTS5 the board still opens — `meta.fts_enabled=0`
  // and repo.search() falls back to LIKE. Runs once per board (keyed on the flag).
  if (!db.prepare('SELECT 1 FROM meta WHERE key = ?').get('fts_enabled')) {
    let enabled = '1';
    try {
      db.exec(FTS_SQL);
      backfillSearchIndex(db);
    } catch {
      enabled = '0';
    }
    db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)').run('fts_enabled', enabled);
  }

  // v5 -> v6: brainstorm sessions + ideas (additive tables from SCHEMA_SQL). The
  // idea search triggers run separately here because a v5 board skips FTS_SQL
  // (flag already set); idempotent, and the new `idea` table is empty on upgrade
  // so no backfill is needed.
  const fts = db.prepare("SELECT value FROM meta WHERE key = 'fts_enabled'").get() as
    | { value: string }
    | undefined;
  if (fts?.value === '1') {
    try {
      db.exec(IDEA_FTS_SQL);
    } catch {
      /* FTS vanished from the build — search simply won't cover ideas */
    }
  }

  // v6 -> v7: checkpoint resume pointer — three nullable task columns. Fresh DBs
  // get them from CREATE TABLE; older boards via the idempotent ALTERs.
  if (current > 0 && current < 7) {
    addColumnIfMissing(db, 'task', 'checkpoint', 'TEXT');
    addColumnIfMissing(db, 'task', 'checkpoint_at', 'TEXT');
    addColumnIfMissing(db, 'task', 'checkpoint_by', 'TEXT');
  }

  // v7 -> v8: claim leases — one nullable expiry column beside `assignee`.
  if (current > 0 && current < 8) {
    addColumnIfMissing(db, 'task', 'claim_expires_at', 'TEXT');
  }

  // v8 -> v9: default-on-expiry answers — one nullable column on input_request.
  if (current > 0 && current < 9) {
    addColumnIfMissing(db, 'input_request', 'default_answer', 'TEXT');
  }

  // v9 -> v10: task templates — purely additive `template` table; both fresh and
  // existing boards get it from the idempotent CREATE in SCHEMA_SQL above.

  // v10 -> v11: request kind (question | watch). One column with a DEFAULT, so
  // every pre-existing row becomes a `question` — which is exactly what it was:
  // before `expect` existed, a watch had to be written as an ask. No data moves.
  if (current > 0 && current < 11) {
    addColumnIfMissing(db, 'input_request', 'kind', "TEXT NOT NULL DEFAULT 'question'");
  }

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
