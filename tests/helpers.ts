import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WebSocket } from 'ws';
import { openDb } from '../src/server/db';
import { Repo } from '../src/server/repo';
import { startServer, type ServerHandle } from '../src/server/server';

/** Fresh in-memory repo for fast data-layer tests. */
export function makeRepo(): Repo {
  return new Repo(openDb(':memory:'));
}

export function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-test-'));
}

export interface TestServer extends ServerHandle {
  root: string;
}

export async function startTestServer(): Promise<TestServer> {
  const root = tempDir();
  const h = await startServer({ root, port: 0 });
  return Object.assign(h, { root });
}

export async function stopTestServer(h: TestServer): Promise<void> {
  await h.close();
  fs.rmSync(h.root, { recursive: true, force: true });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Authenticated fetch against a running test server. */
export function client(h: TestServer) {
  return async (method: string, p: string, body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(h.url + p, {
      method,
      headers: {
        authorization: `Bearer ${h.token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
}

/**
 * Open a WebSocket and resolve once connected. Buffers all incoming messages
 * from creation (before `open`) so replay frames are never missed by a late
 * listener attach.
 */
export function openWs(h: TestServer, since = 0, token = h.token): Promise<WebSocket> {
  const wsUrl = h.url.replace('http', 'ws') + `/ws?since=${since}&token=${token}`;
  const ws = new WebSocket(wsUrl);
  const buf: any[] = [];
  (ws as any).__buf = buf;
  ws.on('message', (d) => buf.push(JSON.parse(d.toString())));
  return new Promise((resolve, reject) => {
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/** Wait until the socket's buffer holds at least `n` messages, then return them. */
export function collectMessages(ws: WebSocket, n: number, timeoutMs = 4000): Promise<any[]> {
  const buf = (ws as any).__buf as any[];
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (buf.length >= n) return resolve(buf.slice(0, n));
      if (Date.now() - start > timeoutMs) return reject(new Error(`ws timeout: got ${buf.length}/${n}`));
      setTimeout(tick, 10);
    };
    tick();
  });
}
