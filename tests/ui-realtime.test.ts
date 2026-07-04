/**
 * @vitest-environment jsdom
 *
 * Realtime + write-surface verification for the web UI. Unlike ui.test.ts (which
 * stubs the socket and reconciles via explicit refresh), this captures the
 * WebSocket the app opens and drives the event-routed update path — a single
 * frame should mutate exactly the affected card without a full board re-fetch.
 * It also exercises a Tier-2 drawer write surface (add acceptance criterion).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { startTestServer, stopTestServer, sleep, type TestServer } from './helpers';

const WEB = path.resolve(__dirname, '../web');
const APP_JS = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
const BODY = INDEX_HTML.replace(/^[\s\S]*<body>/i, '')
  .replace(/<\/body>[\s\S]*$/i, '')
  .replace(/<script[\s\S]*?<\/script>/gi, '');

let h: TestServer;
let realFetch: typeof globalThis.fetch;
let realWS: any;
let sockets: any[];

async function until<T>(fn: () => T | Promise<T>, ms = 4000): Promise<NonNullable<T>> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() - start > ms) throw new Error('until: timed out');
    await sleep(20);
  }
}

function loadApp() {
  // eslint-disable-next-line no-new-func
  new Function(APP_JS)();
}

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const column = (name: string) =>
  [...document.querySelectorAll('.column')].find(
    // Match the name-only span: .col-title also holds the count badge (and, for
    // Done, the "Archive all" button), so its textContent isn't the bare name.
    (c) => c.querySelector('.col-name')?.textContent === name,
  ) as HTMLElement | undefined;
const cardIn = (col: string, id: string) =>
  column(col)?.querySelector(`.card[data-id="${id}"]`) as HTMLElement | undefined;

/** Deliver a server event to the app over its captured WebSocket. */
function emit(ev: Record<string, unknown>) {
  for (const s of sockets) s.onmessage?.({ data: JSON.stringify(ev) });
}

beforeEach(async () => {
  h = await startTestServer();
  document.body.innerHTML = BODY;
  localStorage.clear();
  localStorage.setItem('kanban_token', h.token);

  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: any, init?: any) =>
    realFetch(typeof input === 'string' && input.startsWith('/') ? h.url + input : input, init)) as any;

  // Capture every socket the app opens so a test can push frames into onmessage.
  sockets = [];
  realWS = (globalThis as any).WebSocket;
  (globalThis as any).WebSocket = class {
    onopen: any;
    onclose: any;
    onmessage: any;
    constructor() {
      sockets.push(this);
    }
    close() {}
  };
});

afterEach(async () => {
  globalThis.fetch = realFetch;
  (globalThis as any).WebSocket = realWS;
  await stopTestServer(h);
});

describe('web UI realtime + write surfaces', () => {
  it('a task.moved frame relocates exactly that card (event-routed)', async () => {
    const t = h.repo.createTask({ title: 'Routed', status: 'Ready', priority: 'P2' });
    loadApp();
    await until(() => cardIn('Ready', t.id));

    // Mutate the server out-of-band, then deliver the matching event frame.
    h.repo.moveTask(t.id, 'In Progress', 'user');
    emit({ type: 'task.moved', seq: 999, task_id: t.id, payload: { from: 'Ready', to: 'In Progress' } });

    await until(() => cardIn('In Progress', t.id));
    expect(cardIn('Ready', t.id)).toBeFalsy(); // left the old column
  });

  it('a task.archived frame removes the card', async () => {
    const t = h.repo.createTask({ title: 'Goner', status: 'Ready', priority: 'P2' });
    loadApp();
    await until(() => cardIn('Ready', t.id));

    h.repo.archiveTask(t.id, 'user');
    emit({ type: 'task.archived', seq: 1000, task_id: t.id, payload: {} });

    await until(() => !document.querySelector(`.card[data-id="${t.id}"]`));
  });

  it('+ Criterion in the drawer adds an acceptance criterion', async () => {
    const t = h.repo.createTask({ title: 'Needs criteria', status: 'Ready', priority: 'P2' });
    loadApp();
    (await until(() => document.querySelector('.card') as HTMLElement)).click();

    const input = (await until(() => document.querySelector('input.crit-input') as HTMLInputElement)) as HTMLInputElement;
    input.value = 'ships green';
    const btn = [...document.querySelectorAll('button.send')].find((b) => b.textContent?.includes('Criterion')) as HTMLElement;
    btn.click();

    const c = await until(() => h.repo.getCriteria(t.id).find((x) => x.text === 'ships green'));
    expect(c.text).toBe('ships green');
  });

  it('the filter box hides non-matching cards', async () => {
    h.repo.createTask({ title: 'alpha widget', status: 'Ready', priority: 'P2' });
    h.repo.createTask({ title: 'beta gadget', status: 'Ready', priority: 'P2' });
    loadApp();
    await until(() => document.querySelectorAll('.card').length === 2);

    const filter = $('#filter') as HTMLInputElement;
    filter.value = 'alpha';
    filter.dispatchEvent(new Event('input', { bubbles: true }));

    await until(() => document.querySelectorAll('.card').length === 1);
    expect(($('.card .title') as HTMLElement).textContent).toBe('alpha widget');
  });

  it('the filter grammar matches priority, status, label, is:, description, and ANDs tokens', async () => {
    const urgent = h.repo.createTask({
      title: 'urgent fix', status: 'Review', priority: 'P0', labels: ['api'],
      description: 'flux capacitor misfires',
    });
    h.repo.claimTask(urgent.id, 'alice');
    const blocker = h.repo.createTask({ title: 'prereq', status: 'Ready', priority: 'P2' });
    const blocked = h.repo.createTask({ title: 'waits', status: 'Ready', priority: 'P2' });
    h.repo.addDep(blocked.id, blocker.id);
    loadApp();
    await until(() => document.querySelectorAll('.card').length === 3);

    const filter = $('#filter') as HTMLInputElement;
    const setQuery = (q: string) => {
      filter.value = q;
      filter.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const visible = () =>
      [...document.querySelectorAll('.card .title')].map((e) => e.textContent);

    setQuery('p0');
    await until(() => visible().length === 1);
    expect(visible()).toEqual(['urgent fix']);

    setQuery('status:rev'); // prefix match on the display column
    await until(() => visible().length === 1 && visible()[0] === 'urgent fix');

    setQuery('status:blocked'); // derived column matches too
    await until(() => visible().length === 1 && visible()[0] === 'waits');

    setQuery('is:blocked');
    await until(() => visible().length === 1 && visible()[0] === 'waits');

    setQuery('label:ap @ali'); // AND across tokens
    await until(() => visible().length === 1 && visible()[0] === 'urgent fix');

    setQuery('capacitor'); // bare text now reaches the description
    await until(() => visible().length === 1 && visible()[0] === 'urgent fix');

    setQuery('is:frobnicate'); // unknown is: matches nothing, not treated as text
    await until(() => visible().length === 0);

    setQuery('');
    await until(() => visible().length === 3);
  });
});
