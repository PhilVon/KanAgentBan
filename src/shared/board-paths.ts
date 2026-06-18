import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { BoardMeta } from './types';

// Per-project board layout (storage is locked to one DB per project —
// see docs/02-data-model.md, docs/10-security-lifecycle.md).
export const KANBAN_DIR = '.kanban';

export interface BoardPaths {
  root: string;
  dir: string;
  db: string;
  token: string;
  port: string;
  pid: string;
  meta: string;
}

export function boardPaths(root: string): BoardPaths {
  const dir = path.join(root, KANBAN_DIR);
  return {
    root,
    dir,
    db: path.join(dir, 'board.db'),
    token: path.join(dir, 'token'),
    port: path.join(dir, 'port'),
    pid: path.join(dir, 'pid'),
    meta: path.join(dir, 'board.json'),
  };
}

/** Walk up from `start` to the nearest dir containing `.kanban/`. */
export function findBoardRoot(start: string): string | null {
  let cur = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(cur, KANBAN_DIR))) return cur;
    const parent = path.dirname(cur);
    if (parent === cur) return null;
    cur = parent;
  }
}

export function ensureBoard(root: string, name?: string): BoardPaths {
  const p = boardPaths(root);
  fs.mkdirSync(p.dir, { recursive: true });
  if (!fs.existsSync(p.token)) {
    fs.writeFileSync(p.token, crypto.randomBytes(24).toString('hex'), { mode: 0o600 });
  }
  if (!fs.existsSync(p.meta)) {
    writeBoardMeta(p, { name: name ?? path.basename(root), created_at: new Date().toISOString() });
  }
  return p;
}

/** Read `.kanban/board.json`; returns `{}` if missing or malformed. */
export function readBoardMeta(p: BoardPaths): BoardMeta {
  try {
    return JSON.parse(fs.readFileSync(p.meta, 'utf8')) as BoardMeta;
  } catch {
    return {};
  }
}

export function writeBoardMeta(p: BoardPaths, meta: BoardMeta): void {
  fs.writeFileSync(p.meta, JSON.stringify(meta, null, 2));
}

export const readToken = (p: BoardPaths): string => fs.readFileSync(p.token, 'utf8').trim();

export function readPort(p: BoardPaths): number | null {
  try {
    return Number(fs.readFileSync(p.port, 'utf8').trim()) || null;
  } catch {
    return null;
  }
}
