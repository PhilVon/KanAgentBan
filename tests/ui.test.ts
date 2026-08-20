/**
 * @vitest-environment jsdom
 *
 * UI verification: load the real web/app.js into a jsdom DOM wired to a real
 * test server, drive the actual user interactions (create / drag-drop / edit),
 * and assert the server received the mutation. This exercises the same client
 * code the browser runs — it is what reproduces the manual smoke checks.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { startTestServer, stopTestServer, sleep, type TestServer } from './helpers';

const WEB = path.resolve(__dirname, '../web');
const APP_JS = fs.readFileSync(path.join(WEB, 'app.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
// Body markup minus the <script> tag (we run app.js ourselves, once).
const BODY = INDEX_HTML.replace(/^[\s\S]*<body>/i, '')
  .replace(/<\/body>[\s\S]*$/i, '')
  .replace(/<script[\s\S]*?<\/script>/gi, '');

let h: TestServer;
let realFetch: typeof globalThis.fetch;
/** Every non-GET request this test made, with its status — the context a bare
 *  "until: timed out" is missing (T-107). */
let mutations: string[];
let realWS: any;
let tornDown: { v: boolean };

/**
 * Poll until `fn` returns a truthy value (or time out).
 *
 * 10s rather than 4s only for headroom — a healthy run of this file finishes in
 * ~2.4s. It was raised on the theory that the windows-latest drawer-edit failures
 * were slow-runner latency; the next run then timed out at 10169ms, consuming the
 * whole raised budget, which rules slowness out. Do not raise it again expecting
 * that to fix anything: the failing case never completes (T-107).
 */
async function until<T>(fn: () => T | Promise<T>, ms = 10000): Promise<NonNullable<T>> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() - start > ms)
      // Name the condition and the writes so far. A bare "until: timed out" cost
      // this repo four batches of guessing which step had actually stalled — and
      // "no write was ever sent" vs "the write came back 409" are different bugs
      // that look identical from a poll. The condition labels itself from source,
      // so no call site has to remember to pass one (T-107).
      throw new Error(
        `until: timed out waiting for ${String(fn).replace(/\s+/g, ' ').slice(0, 120)}` +
          ` | writes: ${mutations.length ? mutations.join('; ') : '(none sent)'}`,
      );
    await sleep(20);
  }
}

/** Run the real app.js in this jsdom global scope (attaches handlers, renders). */
function loadApp() {
  // eslint-disable-next-line no-new-func
  new Function(APP_JS)();
}

/** Dispatch an HTML5 drag event with a minimal dataTransfer stub. */
function fireDrag(elm: Element, type: string, dataTransfer: any) {
  const ev = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: dataTransfer, configurable: true });
  elm.dispatchEvent(ev);
}
const makeDataTransfer = () => ({
  store: {} as Record<string, string>,
  dropEffect: '',
  effectAllowed: '',
  setData(k: string, v: string) {
    this.store[k] = v;
  },
  getData(k: string) {
    return this.store[k] || '';
  },
});

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;
const column = (name: string) =>
  [...document.querySelectorAll('.column')].find(
    // Match the name-only span: .col-title also holds the count badge (and, for
    // Done, the "Archive all" button), so its textContent isn't the bare name.
    (c) => c.querySelector('.col-name')?.textContent === name,
  ) as HTMLElement | undefined;

beforeEach(async () => {
  h = await startTestServer();
  document.body.innerHTML = BODY;
  localStorage.clear();
  localStorage.setItem('kanban_token', h.token); // app.js reads this as the token

  // app.js fetches relative URLs ('/api/...'); resolve them to the test server.
  //
  // A fetch left in flight when the test's server stops must not reach app.js
  // AT ALL after teardown — neither outcome. The rejection path was guarded from
  // the start (an ECONNRESET would surface as an unhandled rejection); the
  // SUCCESS path was not, and that was the bug behind four batches of red
  // windows-latest runs (T-107).
  //
  // Every test calls loadApp(), which starts a *new* app.js instance in this one
  // jsdom global, and nothing stops the old ones. When test N's request resolved
  // during test N+1, test N's continuation ran — and because renderDrawer() and
  // openEdit() look up `#drawer-body` at call time, it rendered into the LIVE
  // drawer, wiping the edit form mid-flow. Reproduced 4 times in 12 runs; 120/120
  // green with the guard below, which is the whole of the fix.
  //
  // The flag is per-test (closure-captured): a stray result from test N must not
  // escape just because test N+1 has already started.
  const torn = (tornDown = { v: false });
  realFetch = globalThis.fetch;
  mutations = [];
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    const method = (init?.method ?? 'GET').toUpperCase();
    try {
      const res = await realFetch(url.startsWith('/') ? h.url + url : (input as any), init);
      if (torn.v) return new Promise(() => {}); // see above: a late success renders too
      // Record every write and its status. A test that polls for a mutation and
      // times out otherwise reports only "until: timed out", which says nothing
      // about WHY — and a silently-rejected write (409, 4xx) looks identical to
      // one that was never sent. See T-107.
      if (method !== 'GET') mutations.push(`${method} ${url} -> ${res.status}`);
      return res;
    } catch (e) {
      if (torn.v) return new Promise(() => {});
      if (method !== 'GET') mutations.push(`${method} ${url} -> threw ${(e as Error).message}`);
      throw e;
    }
  }) as any;

  // Stub the WebSocket so app.js doesn't open a live socket (the flows under
  // test reconcile via an explicit refresh()).
  realWS = (globalThis as any).WebSocket;
  (globalThis as any).WebSocket = class {
    onopen: any;
    onclose: any;
    onmessage: any;
    constructor() {}
    close() {}
  };
});

afterEach(async () => {
  tornDown.v = true;
  (globalThis as any).WebSocket = realWS;
  await stopTestServer(h);
  globalThis.fetch = realFetch;
});

describe('web UI (real app.js against a real server)', () => {
  it('renders the board columns on load', async () => {
    loadApp();
    await until(() => document.querySelectorAll('.column').length > 0);
    expect(column('Backlog')).toBeTruthy();
    expect(column('In Progress')).toBeTruthy();
    expect(column('Blocked')).toBeTruthy();
  });

  it('clicking "+ Add task" → Create posts a new task to the server', async () => {
    loadApp();
    await until(() => document.querySelectorAll('.column').length > 0);

    $('#add-task').click();
    expect($('#create-modal').classList.contains('hidden')).toBe(false);

    ($('#ct-title') as HTMLInputElement).value = 'UI created task';
    ($('#ct-status') as HTMLSelectElement).value = 'Ready';
    $('#ct-create').click();

    const t = await until(() => h.repo.listTasks({}).find((x) => x.title === 'UI created task'));
    expect(t.status).toBe('Ready');
    // modal closes on success
    await until(() => $('#create-modal').classList.contains('hidden'));
  });

  it('Create with an empty title shows a toast and posts nothing', async () => {
    loadApp();
    await until(() => document.querySelectorAll('.column').length > 0);

    $('#add-task').click();
    $('#ct-create').click();
    await sleep(100);

    expect(h.repo.listTasks({}).length).toBe(0);
    expect($('#toast').classList.contains('hidden')).toBe(false);
  });

  it('dragging a card to another column moves it on the server', async () => {
    const created = h.repo.createTask({ title: 'Drag me', status: 'Ready', priority: 'P2' });
    loadApp();
    const cardEl = await until(() => document.querySelector('.card') as HTMLElement);

    const dt = makeDataTransfer();
    fireDrag(cardEl, 'dragstart', dt);
    fireDrag(column('In Progress')!, 'drop', dt);

    const t = await until(() => {
      const x = h.repo.getTask(created.id);
      return x && x.status === 'In Progress' ? x : null;
    });
    expect(t.status).toBe('In Progress');
  });

  it('the derived Blocked column is not a drop target', async () => {
    const created = h.repo.createTask({ title: 'No drop', status: 'Ready', priority: 'P2' });
    loadApp();
    const cardEl = await until(() => document.querySelector('.card') as HTMLElement);

    const blocked = column('Blocked')!;
    expect(blocked.classList.contains('no-drop')).toBe(true);

    const dt = makeDataTransfer();
    fireDrag(cardEl, 'dragstart', dt);
    fireDrag(blocked, 'drop', dt);
    await sleep(100);

    expect(h.repo.getTask(created.id)!.status).toBe('Ready'); // unchanged
  });

  it('a child card shows the parent badge; the parent drawer lists subtasks', async () => {
    const parent = h.repo.createTask({ title: 'Parent task', status: 'In Progress', priority: 'P2' });
    h.repo.createTask({ title: 'Child task', status: 'Ready', parent: parent.id });
    loadApp();

    // The child card carries a parent badge: a code-branch icon + the parent id.
    await until(() => {
      const badges = [...document.querySelectorAll('.flag.parent')];
      return badges.some((b) => b.querySelector('i.fa-code-branch') && b.textContent === parent.id);
    });

    // Open the parent's drawer and confirm the Subtasks section renders the child.
    const parentCard = await until(() =>
      [...document.querySelectorAll('.card')].find(
        (c) => c.querySelector('.title')?.textContent === 'Parent task',
      ) as HTMLElement | undefined,
    );
    parentCard.click();
    const sub = await until(() =>
      [...document.querySelectorAll('.subtask')].find((s) => s.textContent?.includes('Child task')),
    );
    expect(sub).toBeTruthy();
  });

  it('the "+ Subtask" button in the drawer creates a child under the open task', async () => {
    const parent = h.repo.createTask({ title: 'Has subtasks', status: 'In Progress', priority: 'P2' });
    loadApp();

    (await until(() => document.querySelector('.card') as HTMLElement)).click(); // openDrawer
    const stInput = await until(() => document.querySelector('input.subtask-input') as HTMLInputElement);
    stInput.value = 'Drawer-made child';
    const btn = [...document.querySelectorAll('button.send')].find(
      (b) => b.textContent?.includes('Subtask'),
    ) as HTMLElement;
    btn.click();

    const child = await until(() => h.repo.getChildren(parent.id).find((c) => c.title === 'Drawer-made child'));
    expect(child.parent_id).toBe(parent.id);
  });

  it('editing a task in the drawer patches it (with version bump)', async () => {
    const created = h.repo.createTask({ title: 'Edit me', priority: 'P2' });
    loadApp();

    (await until(() => document.querySelector('.card') as HTMLElement)).click(); // openDrawer
    (await until(() => document.querySelector('.edit-btn') as HTMLElement)).click(); // openEdit

    const titleInput = await until(() => document.querySelector('input.edit-field') as HTMLInputElement);
    titleInput.value = 'Edited title';
    const save = [...document.querySelectorAll('button.send')].find(
      (b) => b.textContent === 'Save',
    ) as HTMLElement;
    save.click();

    const t = await until(() => {
      const x = h.repo.getTask(created.id);
      return x && x.title === 'Edited title' ? x : null;
    });
    expect(t.title).toBe('Edited title');
    expect(t.version).toBeGreaterThan(created.version);
  });

  it('opening the Metrics panel renders the expanded analytics surfaces (FORMAT_VERSION 7)', async () => {
    // Seed a board with completions, a claim, a label, and an aging task so every
    // expansion surface has data to render.
    const done = h.repo.createTask({ title: 'shipped', priority: 'P1', labels: ['api'] });
    h.repo.claimTask(done.id, 'alice');
    h.repo.moveTask(done.id, 'In Progress');
    h.repo.moveTask(done.id, 'Done');
    const aging = h.repo.createTask({ title: 'old', status: 'In Progress', priority: 'P2' });
    h.repo.db
      .prepare('UPDATE task SET created_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 10 * 86400000).toISOString(), aging.id);

    loadApp();
    await until(() => document.querySelectorAll('.column').length > 0);

    $('#metrics-btn').click();
    expect($('#metrics-panel').classList.contains('hidden')).toBe(false);

    // Tiles (incl. the new flow-efficiency / net-flow / forecast / input / rework),
    // the per-priority/label/agent tables, the burndown and the CFD chart all
    // render without throwing.
    await until(() => document.querySelector('#metrics-body .tiles'));
    const subs = [...document.querySelectorAll('#metrics-body .metrics-sub')].map((e) => e.textContent);
    expect(subs.some((s) => s?.startsWith('By priority'))).toBe(true);
    expect(subs.some((s) => s?.startsWith('By label'))).toBe(true);
    expect(subs.some((s) => s?.startsWith('By agent'))).toBe(true);
    expect(subs.some((s) => s?.startsWith('Dwell by status'))).toBe(true);
    expect(subs.some((s) => s?.startsWith('Aging'))).toBe(true);
    expect(subs.some((s) => s?.startsWith('Cumulative flow'))).toBe(true);
    expect(document.querySelectorAll('#metrics-body .metric-table').length).toBeGreaterThanOrEqual(3);
    // Two SVG charts: burndown + CFD.
    expect(document.querySelectorAll('#metrics-body svg.burndown').length).toBe(2);
  });

  it('renders the Metrics panel when net flow is flat (no empty classList token)', async () => {
    // A balanced/idle board yields trend "flat" — the net-flow tile must not call
    // classList.add('') (a DOMException that would blank the whole panel).
    loadApp();
    await until(() => document.querySelectorAll('.column').length > 0);
    $('#metrics-btn').click();
    const tiles = await until(() => document.querySelector('#metrics-body .tiles'));
    expect(tiles.querySelectorAll('.tile').length).toBeGreaterThan(0);
  });

  it('Review cards carry approve/reject buttons; approve moves to Done, reject records the reason', async () => {
    const a = h.repo.createTask({ title: 'Sign me off', status: 'Review', priority: 'P2' });
    const b = h.repo.createTask({ title: 'Bounce me', status: 'Review', priority: 'P2' });
    h.repo.createTask({ title: 'No buttons here', status: 'Ready', priority: 'P2' });
    (globalThis as any).prompt = () => 'missing error handling';
    loadApp();

    const approveBtn = await until(() =>
      [...document.querySelectorAll('.card')]
        .find((c) => c.querySelector('.title')?.textContent === 'Sign me off')
        ?.querySelector('.review-approve') as HTMLElement | undefined,
    );
    // Only Review-column cards get the gate.
    const readyCard = [...document.querySelectorAll('.card')].find(
      (c) => c.querySelector('.title')?.textContent === 'No buttons here',
    );
    expect(readyCard?.querySelector('.review-actions')).toBeFalsy();

    approveBtn.click();
    await until(() => h.repo.getTask(a.id)!.status === 'Done');

    const rejectBtn = await until(() =>
      [...document.querySelectorAll('.card')]
        .find((c) => c.querySelector('.title')?.textContent === 'Bounce me')
        ?.querySelector('.review-reject') as HTMLElement | undefined,
    );
    rejectBtn.click();
    await until(() => h.repo.getTask(b.id)!.status === 'In Progress');
    const comments = h.repo.getComments(b.id);
    expect(comments.some((c) => c.body.includes('review rejected: missing error handling'))).toBe(true);
  });
});
