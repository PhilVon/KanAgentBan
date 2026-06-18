import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import {
  boardPaths,
  ensureBoard,
  findBoardRoot,
  readPort,
  readToken,
  type BoardPaths,
} from '../shared/board-paths';

export interface Conn {
  base: string;
  token: string;
  paths: BoardPaths;
  agent: string;
}

export class CliError extends Error {
  constructor(message: string, public code: number) {
    super(message);
  }
}

/** Resolve the board for the current dir, auto-starting the server if needed. */
export async function connect(opts: { board?: string; agent?: string } = {}): Promise<Conn> {
  const root = opts.board ?? findBoardRoot(process.cwd());
  if (!root) throw new CliError('no board here — run `kanban board init` first', 3);
  const paths = boardPaths(root);
  const token = readToken(paths);
  // Agent identity for multi-agent claim/`next` (docs/09 §9). Stable across CLI
  // invocations, so it cannot derive from PID — set KANBAN_AGENT per agent.
  const agent = opts.agent ?? process.env.KANBAN_AGENT ?? 'agent';

  let port = readPort(paths);
  if (!port || !(await healthy(port, token))) {
    port = await autostart(root, paths, token);
  }
  return { base: `http://127.0.0.1:${port}`, token, paths, agent };
}

async function healthy(port: number, _token: string): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/healthz`);
    return r.ok;
  } catch {
    return false;
  }
}

/** Spawn the server detached and wait for it to come up. */
async function autostart(root: string, paths: BoardPaths, token: string): Promise<number> {
  const dev = __filename.endsWith('.ts');
  const distEntry = path.resolve(__dirname, '../server/server.js');
  const srcEntry = path.resolve(__dirname, '../server/server.ts');

  const [cmd, args] =
    dev || !fs.existsSync(distEntry)
      ? ['npx', ['tsx', srcEntry]]
      : [process.execPath, [distEntry]];

  const child = spawn(cmd, args, {
    cwd: root,
    env: { ...process.env, BOARD_ROOT: root },
    detached: true,
    stdio: 'ignore',
    shell: cmd === 'npx', // npx needs a shell on Windows
  });
  child.unref();

  for (let i = 0; i < 100; i++) {
    const port = readPort(paths);
    if (port && (await healthy(port, token))) return port;
    await sleep(100);
  }
  throw new CliError('server did not start in time (try `kanban serve`)', 5);
}

export function initBoard(root: string, name?: string): BoardPaths {
  return ensureBoard(root, name);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Thin HTTP helper that attaches the token + actor and maps errors to exit codes. */
export async function api(
  conn: Conn,
  method: string,
  pathname: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<any> {
  const res = await fetch(conn.base + pathname, {
    method,
    headers: {
      authorization: `Bearer ${conn.token}`,
      'x-actor': 'agent',
      'x-agent': conn.agent,
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return { __status: 204 };
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const msg = data?.error?.message ?? res.statusText;
    const code = res.status === 404 ? 3 : res.status === 409 ? 4 : res.status === 401 ? 5 : 1;
    throw new CliError(msg, code);
  }
  return data;
}
