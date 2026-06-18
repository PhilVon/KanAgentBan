import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

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
  const metaPath = path.join(p.dir, 'board.json');
  if (!fs.existsSync(metaPath)) {
    fs.writeFileSync(
      metaPath,
      JSON.stringify({ name: name ?? path.basename(root), created_at: new Date().toISOString() }, null, 2),
    );
  }
  return p;
}

export const readToken = (p: BoardPaths): string => fs.readFileSync(p.token, 'utf8').trim();

export function readPort(p: BoardPaths): number | null {
  try {
    return Number(fs.readFileSync(p.port, 'utf8').trim()) || null;
  } catch {
    return null;
  }
}
