import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { makeRepo, tempDir } from './helpers';
import { Repo, ValidationError, NotFoundError } from '../src/server/repo';
import { blockedByChildren, childProgress, deriveState } from '../src/server/derive';
import { recommend } from '../src/server/recommend';
import { renderContext, renderList, renderShow } from '../src/server/render';
import { openDb } from '../src/server/db';

describe('subtasks: repo parent/child', () => {
  it('creates a child with parent_id and records it on the event', () => {
    const repo = makeRepo();
    const p = repo.createTask({ title: 'parent' });
    const c = repo.createTask({ title: 'child', parent: p.id });
    expect(c.parent_id).toBe(p.id);
    expect(repo.getChildren(p.id).map((t) => t.id)).toEqual([c.id]);
    expect(repo.getParent(c.id)?.id).toBe(p.id);
    const created = repo.changes(0).find((e) => e.task_id === c.id && e.type === 'task.created');
    expect((created!.payload as any).parent_id).toBe(p.id);
  });

  it('rejects creating a child under a missing or archived parent', () => {
    const repo = makeRepo();
    expect(() => repo.createTask({ title: 'x', parent: 'T-99' })).toThrow(NotFoundError);
    const p = repo.createTask({ title: 'p' });
    repo.archiveTask(p.id);
    expect(() => repo.createTask({ title: 'x', parent: p.id })).toThrow(ValidationError);
  });

  it('setParent sets, clears, and moves; clearing is a no-op when already top-level', () => {
    const repo = makeRepo();
    const p1 = repo.createTask({ title: 'p1' });
    const p2 = repo.createTask({ title: 'p2' });
    const c = repo.createTask({ title: 'c' });
    expect(repo.setParent(c.id, p1.id).parent_id).toBe(p1.id);
    expect(repo.setParent(c.id, p2.id).parent_id).toBe(p2.id); // move
    expect(repo.setParent(c.id, null).parent_id).toBeNull(); // clear
    const before = repo.maxSeq();
    repo.setParent(c.id, null); // no-op, no event
    expect(repo.maxSeq()).toBe(before);
    const reparented = repo.changes(0).filter((e) => e.type === 'task.reparented');
    expect(reparented.length).toBe(3);
  });

  it('rejects self-parenting and cycles (descendant as parent)', () => {
    const repo = makeRepo();
    const a = repo.createTask({ title: 'a' });
    const b = repo.createTask({ title: 'b', parent: a.id });
    const c = repo.createTask({ title: 'c', parent: b.id });
    expect(() => repo.setParent(a.id, a.id)).toThrow(/its own parent/);
    // a is an ancestor of c, so making a a child of c would create a cycle.
    expect(() => repo.setParent(a.id, c.id)).toThrow(/cycle/);
    expect(() => repo.setParent(a.id, b.id)).toThrow(/cycle/);
  });
});

describe('subtasks: rollup gating', () => {
  it('cannot move a parent to Done while children are open; allowed once all Done', () => {
    const repo = makeRepo();
    const p = repo.createTask({ title: 'p', status: 'In Progress' });
    const c1 = repo.createTask({ title: 'c1', status: 'In Progress', parent: p.id });
    const c2 = repo.createTask({ title: 'c2', status: 'Ready', parent: p.id });
    expect(() => repo.moveTask(p.id, 'Done')).toThrow(/2 open subtask/);
    repo.moveTask(c1.id, 'Done');
    expect(() => repo.moveTask(p.id, 'Done')).toThrow(/1 open subtask/);
    repo.moveTask(c2.id, 'Done');
    expect(repo.moveTask(p.id, 'Done').status).toBe('Done');
  });

  it('refuses to archive a parent that still has non-archived children', () => {
    const repo = makeRepo();
    const p = repo.createTask({ title: 'p' });
    const c = repo.createTask({ title: 'c', parent: p.id });
    expect(() => repo.archiveTask(p.id)).toThrow(/subtask/);
    repo.archiveTask(c.id);
    expect(() => repo.archiveTask(p.id)).not.toThrow();
  });
});

describe('subtasks: derived state', () => {
  it('blocked_by_children reflects open, non-archived, non-Done children', () => {
    const repo = makeRepo();
    const p = repo.createTask({ title: 'p', status: 'In Progress' });
    expect(blockedByChildren(repo.db, p.id)).toBe(false);
    const c = repo.createTask({ title: 'c', status: 'Ready', parent: p.id });
    expect(blockedByChildren(repo.db, p.id)).toBe(true);
    expect(deriveState(repo.db, repo.getTask(p.id)!).ready).toBe(false);
    repo.moveTask(c.id, 'Done');
    expect(blockedByChildren(repo.db, p.id)).toBe(false);
    expect(deriveState(repo.db, repo.getTask(p.id)!).ready).toBe(true);
  });

  it('childProgress counts done vs total (non-archived)', () => {
    const repo = makeRepo();
    const p = repo.createTask({ title: 'p' });
    repo.createTask({ title: 'c1', status: 'Done', parent: p.id });
    const c2 = repo.createTask({ title: 'c2', parent: p.id });
    expect(childProgress(repo.db, p.id)).toEqual({ done: 1, total: 2 });
    repo.archiveTask(c2.id);
    expect(childProgress(repo.db, p.id)).toEqual({ done: 1, total: 1 });
  });
});

describe('subtasks: recommend', () => {
  it('does not recommend a parent with open children; explains why when blocked', () => {
    const repo = makeRepo();
    const p = repo.createTask({ title: 'parent', status: 'In Progress' });
    const c = repo.createTask({ title: 'child', status: 'Ready', parent: p.id });
    const r = recommend(repo, 5);
    // child is ready; parent is not.
    const ids = 'none' in r ? [] : r.map((x) => x.task.id);
    expect(ids).toContain(c.id);
    expect(ids).not.toContain(p.id);
    // Once the child is Done the parent unblocks and becomes recommendable.
    repo.moveTask(c.id, 'Done');
    const r2 = recommend(repo, 5);
    expect('none' in r2 ? [] : r2.map((x) => x.task.id)).toContain(p.id);
  });

  it('blocked summary names the open-subtask reason', () => {
    const repo = makeRepo();
    const p = repo.createTask({ title: 'parent', status: 'In Progress' });
    repo.createTask({ title: 'child', status: 'Backlog', parent: p.id });
    const r = recommend(repo, 5);
    expect('none' in r).toBe(true);
    if ('none' in r) {
      expect(r.blocked.find((b) => b.id === p.id)?.reason).toMatch(/open subtask/);
    }
  });
});

describe('subtasks: render', () => {
  it('list shows the parent badge on a child and the S-flag on a blocked parent', () => {
    const repo = makeRepo();
    const p = repo.createTask({ title: 'parent', status: 'In Progress' });
    repo.createTask({ title: 'child', status: 'Ready', parent: p.id });
    const out = renderList(repo, {});
    expect(out).toMatch(/⤷T-1/); // child carries the parent badge
    expect(out).toMatch(/S0\/1/); // parent flagged blocked-by-children
  });

  it('show includes a subtasks count', () => {
    const repo = makeRepo();
    const p = repo.createTask({ title: 'parent', status: 'In Progress' });
    repo.createTask({ title: 'child', status: 'Done', parent: p.id });
    expect(renderShow(repo, p.id)).toMatch(/subtasks 1\/1/);
  });

  it('context lists children and collapses them under a tight budget with a footer', () => {
    const repo = makeRepo();
    const p = repo.createTask({ title: 'parent', status: 'In Progress', summary: 's' });
    for (let i = 0; i < 8; i++)
      repo.createTask({ title: `child number ${i}`, status: 'Ready', parent: p.id });
    const full = renderContext(repo, p.id, { full: true });
    expect(full).toMatch(/subtasks 0\/8:/);
    expect(full).toContain('child number 0');
    // A budget between the collapsed-count size and the full-list size lands on
    // the collapse rung — never silent, but not a whole-section drop.
    const tight = renderContext(repo, p.id, { maxTokens: 40 });
    expect(tight).toMatch(/subtasks collapsed/);
    expect(tight).not.toContain('child number 0');
  });
});

describe('subtasks: schema migration v1 -> v2', () => {
  it('adds parent_id + index to a pre-existing v1 board without losing rows', () => {
    const dir = tempDir();
    const dbPath = path.join(dir, 'board.db');
    // Hand-build a minimal v1 board: task table WITHOUT parent_id, stamped v1.
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
      CREATE TABLE task (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, summary TEXT,
        summary_source TEXT, summary_updated_at TEXT, description_updated_at TEXT,
        status TEXT NOT NULL DEFAULT 'Backlog', priority TEXT NOT NULL DEFAULT 'P2',
        position REAL, assignee TEXT, version INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, archived_at TEXT
      );
    `);
    raw.prepare('INSERT INTO meta(key,value) VALUES(?,?)').run('schema_version', '1');
    raw.prepare('INSERT INTO counters(name,value) VALUES(?,?)').run('task', 1); // T-1 already issued
    raw.prepare(
      'INSERT INTO task(id,title,status,version,created_at,updated_at) VALUES(?,?,?,?,?,?)',
    ).run('T-1', 'legacy', 'Backlog', 1, '2020-01-01', '2020-01-01');
    const cols0 = (raw.prepare('PRAGMA table_info(task)').all() as { name: string }[]).map((c) => c.name);
    expect(cols0).not.toContain('parent_id');
    raw.close();

    // Reopen through the real loader, which must migrate it.
    const db = openDb(dbPath);
    const cols = (db.prepare('PRAGMA table_info(task)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toContain('parent_id');
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_task_parent'`).get();
    expect(idx).toBeTruthy();
    expect(db.prepare('SELECT value FROM meta WHERE key=?').get('schema_version')).toEqual({ value: '2' });
    // Existing row intact, new column defaults to NULL, and the repo can use it.
    const repo = new Repo(db);
    expect(repo.getTask('T-1')!.parent_id).toBeNull();
    const c = repo.createTask({ title: 'new child', parent: 'T-1' });
    expect(repo.getChildren('T-1').map((t) => t.id)).toEqual([c.id]);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
