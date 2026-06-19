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
let realWS: any;

/** Poll until `fn` returns a truthy value (or time out). */
async function until<T>(fn: () => T | Promise<T>, ms = 4000): Promise<NonNullable<T>> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() - start > ms) throw new Error('until: timed out');
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
  realFetch = globalThis.fetch;
  globalThis.fetch = ((input: any, init?: any) =>
    realFetch(typeof input === 'string' && input.startsWith('/') ? h.url + input : input, init)) as any;

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
  globalThis.fetch = realFetch;
  (globalThis as any).WebSocket = realWS;
  await stopTestServer(h);
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
});
