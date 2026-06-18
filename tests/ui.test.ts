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
    (c) => c.querySelector('.col-title')?.textContent === name,
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
});
