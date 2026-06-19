// Realtime board UI. See docs/08-web-ui.md.
// Writes go through REST; the WebSocket event stream is the source of truth and
// is event-routed to targeted DOM updates (one card / inbox row / the open
// drawer per frame) — full re-fetch is reserved for first load and `reset`.
'use strict';

const params = new URLSearchParams(location.search);
const token = params.get('token') || localStorage.getItem('kanban_token') || '';
if (params.get('token')) {
  localStorage.setItem('kanban_token', token);
  // Don't leave the token in the address bar / history (docs/08 §8).
  history.replaceState(null, '', location.pathname + location.hash);
}

const headers = { authorization: `Bearer ${token}` };
// Human-originated writes are attributed to the user (x-actor); claim/release
// also need an agent identity (x-agent).
const userJson = { 'content-type': 'application/json', 'x-actor': 'user' };
const api = (p, opts = {}) =>
  fetch(p, { ...opts, headers: { ...headers, ...(opts.headers || {}) } }).then(async (r) => {
    if (!r.ok) {
      let msg = `${r.status}`;
      try {
        const body = await r.json();
        if (body?.error?.message) msg = body.error.message;
      } catch {}
      const err = new Error(msg);
      err.status = r.status;
      throw err;
    }
    return r.status === 204 ? {} : r.json();
  });

// The real workflow statuses are the only valid drop targets; "Blocked" is a
// derived projection (see docs/02-data-model §4-5, docs/08-web-ui §2/§6).
const WORKFLOW_STATUSES = ['Backlog', 'Ready', 'In Progress', 'Review', 'Done'];

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const idNum = (id) => Number(String(id).replace(/\D/g, '')) || 0;
const byPosition = (a, b) => (a.position ?? Infinity) - (b.position ?? Infinity) || idNum(a.id) - idNum(b.id);

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 4000);
}

// --- client state -----------------------------------------------------------
const state = {
  columns: [],
  tasksById: new Map(),
  inboxByTask: new Map(), // task_id -> open InputRequest[]
  openDrawerId: null,
  filter: '',
};
let colListEls = new Map(); // column name -> its .col-list element

// Unread-comment tracking: remember the comment count last seen per task.
let seenComments = {};
try {
  seenComments = JSON.parse(localStorage.getItem('kanban_seen') || '{}');
} catch {}
function markSeen(id, count) {
  seenComments[id] = count;
  try {
    localStorage.setItem('kanban_seen', JSON.stringify(seenComments));
  } catch {}
}

function matchesFilter(t) {
  const q = state.filter;
  if (!q) return true;
  const hay =
    `${t.id} ${t.title} ${t.assignee ? '@' + t.assignee : ''} ${(t.labels || []).join(' ')} ${t.priority}`.toLowerCase();
  return hay.includes(q);
}

// --- full reseed (first load, reset, create, conflict reconcile) ------------
async function refresh() {
  const data = await api('/api/ui/board');
  state.columns = data.columns;
  state.tasksById = new Map(data.tasks.map((t) => [t.id, t]));
  state.inboxByTask = new Map();
  for (const q of data.inbox) {
    const arr = state.inboxByTask.get(q.task_id) || [];
    arr.push(q);
    state.inboxByTask.set(q.task_id, arr);
  }
  renderBoard();
  renderInbox();
  if (!$('#metrics-panel').classList.contains('hidden')) loadStats();
}

function renderBoard() {
  const board = $('#board');
  board.innerHTML = '';
  colListEls = new Map();
  for (const col of state.columns) {
    const column = el('div', 'column');
    const droppable = WORKFLOW_STATUSES.includes(col);
    if (!droppable) column.classList.add('no-drop');
    column.append(el('h3', 'col-title', col));
    const list = el('div', 'col-list');
    colListEls.set(col, list);
    column.append(list);
    if (droppable) {
      column.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        column.classList.add('drag-over');
      });
      column.addEventListener('dragleave', () => column.classList.remove('drag-over'));
      column.addEventListener('drop', (e) => {
        e.preventDefault();
        column.classList.remove('drag-over');
        const id = e.dataTransfer.getData('text/plain') || dragId;
        if (id) moveTask(id, col);
      });
    } else {
      // Blocked is derived, not a drop target — show it rejects drops.
      column.addEventListener('dragover', (e) => (e.dataTransfer.dropEffect = 'none'));
    }
    board.append(column);
  }
  for (const col of state.columns) renderColumn(col);
}

// Rebuild a single column's card list from state (filtered + position-ordered).
// Other columns keep their scroll position — only the touched column re-renders.
function renderColumn(name) {
  const list = colListEls.get(name);
  if (!list) return;
  list.innerHTML = '';
  const items = [...state.tasksById.values()]
    .filter((t) => t.column === name && matchesFilter(t))
    .sort(byPosition);
  if (!items.length) {
    list.append(el('div', 'col-empty', state.filter ? 'no matches' : '—'));
    return;
  }
  for (const t of items) list.append(card(t));
}

function upsertCard(model) {
  const prev = state.tasksById.get(model.id);
  state.tasksById.set(model.id, model);
  renderColumn(model.column);
  if (prev && prev.column !== model.column) renderColumn(prev.column);
}

function removeCard(id) {
  const prev = state.tasksById.get(id);
  state.tasksById.delete(id);
  if (state.inboxByTask.delete(id)) renderInbox();
  if (prev) renderColumn(prev.column);
  if (state.openDrawerId === id) $('#drawer-close').onclick();
}

function card(t) {
  const c = el('div', `card prio-${t.priority}`);
  c.dataset.id = t.id;
  c.draggable = true;
  c.addEventListener('dragstart', (e) => {
    dragId = t.id;
    e.dataTransfer.setData('text/plain', t.id);
    e.dataTransfer.effectAllowed = 'move';
    c.classList.add('dragging');
  });
  c.addEventListener('dragend', () => {
    dragId = null;
    c.classList.remove('dragging');
  });
  c.append(el('span', 'tid', t.id));
  c.append(el('span', `pri pri-${t.priority}`, t.priority));
  c.append(el('div', 'title', t.title));
  const flags = el('div', 'flags');
  if (t.blocked_by_deps) flags.append(el('span', 'flag dep', '🔒'));
  if (t.needs_input) flags.append(el('span', 'flag input', '❓'));
  if (t.child_total) flags.append(el('span', 'flag subtasks', `⊞${t.child_done}/${t.child_total}`));
  if (t.parent_id) flags.append(el('span', 'flag parent', `⤷${t.parent_id}`));
  if (t.comments) {
    const unread = Math.max(0, t.comments - (seenComments[t.id] || 0));
    const cf = el('span', unread ? 'flag comments unread' : 'flag comments', `💬${t.comments}`);
    if (unread) cf.title = `${unread} new since you last looked`;
    flags.append(cf);
  }
  if (t.criteria_total) flags.append(el('span', 'flag', `✓${t.criteria_done}/${t.criteria_total}`));
  if (t.assignee) flags.append(el('span', 'flag assignee', `👤${t.assignee}`));
  for (const l of t.labels || []) flags.append(el('span', 'label', l));
  c.append(flags);
  c.onclick = () => openDrawer(t.id);
  return c;
}

// --- inbox ------------------------------------------------------------------
function renderInbox() {
  const box = $('#inbox');
  const items = $('#inbox-items');
  items.innerHTML = '';
  const all = [...state.inboxByTask.values()].flat().sort((a, b) => idNum(a.id) - idNum(b.id));
  if (!all.length) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  for (const q of all) items.append(inboxItem(q));
}

function inboxItem(q) {
  const wrap = el('div', 'inbox-item');
  wrap.append(el('div', 'q-task', `${q.task_id} · ${q.id}`));
  wrap.append(el('div', 'q-text', q.question));
  const form = el('div', 'q-form');
  if (q.options && q.options.length) {
    for (const opt of q.options) {
      const b = el('button', 'opt', opt);
      b.onclick = () => answer(q.id, opt);
      form.append(b);
    }
  }
  if (!q.options || q.answer_freeform) {
    const input = el('input', 'q-input');
    input.placeholder = 'type an answer…';
    input.addEventListener('keydown', (e) => e.key === 'Enter' && input.value && answer(q.id, input.value));
    const send = el('button', 'send', 'Answer');
    send.onclick = () => input.value && answer(q.id, input.value);
    form.append(input, send);
  }
  const cancel = el('button', 'ghost q-cancel', 'Cancel');
  cancel.onclick = () => cancelInput(q.id);
  form.append(cancel);
  wrap.append(form);
  return wrap;
}

const answer = (qid, text) =>
  api(`/api/input-requests/${qid}/answer`, {
    method: 'POST',
    headers: userJson,
    body: JSON.stringify({ answer: text, answered_by: 'user' }),
  }).catch((err) => toast(`answer failed: ${err.message}`));

const cancelInput = (qid) =>
  api(`/api/input-requests/${qid}/cancel`, { method: 'POST', headers: { 'x-actor': 'user' } }).catch((err) =>
    toast(`cancel failed: ${err.message}`),
  );

function moveTask(id, status) {
  api(`/api/tasks/${id}/move`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status }),
  }).catch((e) => {
    toast(e.status === 409 ? `${id}: changed elsewhere — reloaded` : `move failed: ${e.message}`);
    refresh();
  });
  // The task.moved event drives the visible relocation (event-routed below).
}

// Stash the dragged task id (dataTransfer.getData is empty during dragover on
// some browsers, so we also keep it module-scoped).
let dragId = null;

// --- card detail drawer -----------------------------------------------------
async function openDrawer(id) {
  let d;
  try {
    d = await api(`/api/ui/tasks/${id}`);
  } catch (e) {
    return toast(`open failed: ${e.message}`);
  }
  state.openDrawerId = id;
  renderDrawer(d);
  $('#drawer').classList.remove('hidden');
  // Mark the thread read and clear the unread badge on the card.
  markSeen(id, d.comments.length);
  const m = state.tasksById.get(id);
  if (m) renderColumn(m.column);
}

function renderDrawer(d) {
  const body = $('#drawer-body');
  body.innerHTML = '';
  const head = el('div', 'drawer-head');
  head.append(el('h2', '', `${d.task.id} ${d.task.title}`));
  const claim = el('button', 'ghost', d.task.assignee ? 'Release' : 'Claim');
  claim.onclick = () => {
    const path = d.task.assignee ? 'release' : 'claim';
    api(`/api/tasks/${d.task.id}/${path}`, {
      method: 'POST',
      headers: { ...userJson, 'x-agent': 'user' },
      body: JSON.stringify({ force: true }),
    })
      .then(() => openDrawer(d.task.id))
      .catch((err) => toast(`${path} failed: ${err.message}`));
  };
  const arch = el('button', 'ghost', 'Archive');
  arch.onclick = () =>
    api(`/api/tasks/${d.task.id}/archive`, { method: 'POST', headers: { 'x-actor': 'user' } })
      .then(() => {
        $('#drawer-close').onclick();
        toast(`${d.task.id} archived`);
      })
      .catch((err) => toast(`archive failed: ${err.message}`));
  const edit = el('button', 'ghost edit-btn', 'Edit');
  edit.onclick = () => openEdit(d);
  head.append(claim, arch, edit);
  body.append(head);
  body.append(
    el('div', 'meta', `${d.task.priority} · ${d.task.status}${d.task.assignee ? ' · 👤 ' + d.task.assignee : ''}`),
  );
  if (d.parent) {
    const p = el('div', 'parent-link', `⤷ parent: ${d.parent.id} ${d.parent.title} (${d.parent.status})`);
    p.onclick = () => openDrawer(d.parent.id);
    body.append(p);
  }
  if (d.task.summary) {
    body.append(el('p', 'summary', d.task.summary));
    if (
      d.task.description_updated_at &&
      (!d.task.summary_updated_at || d.task.description_updated_at > d.task.summary_updated_at)
    ) {
      body.append(el('div', 'stale', '[summary may be stale]'));
    }
  }
  if (d.task.description) body.append(el('p', 'desc', d.task.description));

  body.append(el('h4', '', `Acceptance criteria ${d.criteria.filter((c) => c.checked).length}/${d.criteria.length}`));
  for (const c of d.criteria) {
    const row = el('label', 'crit');
    const cb = el('input');
    cb.type = 'checkbox';
    cb.checked = !!c.checked;
    cb.onchange = () =>
      api(`/api/criteria/${c.id}`, {
        method: 'PATCH',
        headers: userJson,
        body: JSON.stringify({ checked: cb.checked }),
      }).catch((err) => {
        toast(`update failed: ${err.message}`);
        cb.checked = !cb.checked;
      });
    row.append(cb, el('span', '', ` ${c.text}`));
    body.append(row);
  }
  appendAdder(body, 'crit-input', 'new criterion…', '+ Criterion', (text) =>
    api(`/api/tasks/${d.task.id}/criteria`, { method: 'POST', headers: userJson, body: JSON.stringify({ text }) }),
  );

  {
    const done = d.children.filter((c) => c.status === 'Done').length;
    body.append(el('h4', '', `Subtasks ${done}/${d.children.length}`));
    for (const c of d.children) {
      const row = el('div', 'subtask');
      row.append(el('span', 'tid', c.id));
      row.append(el('span', '', ` ${c.title} `));
      row.append(el('span', 'st-status', `[${c.status}]`));
      row.onclick = () => openDrawer(c.id);
      body.append(row);
    }
    const stIn = el('input', 'subtask-input');
    stIn.placeholder = 'new subtask title…';
    const stBtn = el('button', 'send', '+ Subtask');
    stBtn.onclick = () =>
      stIn.value.trim() &&
      api('/api/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: stIn.value.trim(), parent: d.task.id }),
      })
        .then(() => openDrawer(d.task.id))
        .catch((err) => toast(`subtask failed: ${err.message}`));
    body.append(stIn, stBtn);
  }

  // Dependencies — blockers are removable; add by id. "Blocks" is read-only.
  body.append(el('h4', '', 'Dependencies'));
  const depWrap = el('div', 'deps');
  if (!d.blockers.length) depWrap.append(el('span', 'muted', 'no blockers'));
  for (const b of d.blockers) {
    const row = el('div', 'chip-row');
    row.append(el('span', '', `🔒 ${b.id} (${b.status})`));
    const x = el('button', 'chip-x', '×');
    x.title = 'remove dependency';
    x.onclick = () =>
      api(`/api/tasks/${d.task.id}/deps?on=${encodeURIComponent(b.id)}`, { method: 'DELETE', headers: { 'x-actor': 'user' } })
        .then(() => openDrawer(d.task.id))
        .catch((err) => toast(`dep remove failed: ${err.message}`));
    row.append(x);
    depWrap.append(row);
  }
  body.append(depWrap);
  appendAdder(body, 'dep-input', 'add blocker (T-n)…', '+ Blocker', (on) =>
    api(`/api/tasks/${d.task.id}/deps`, { method: 'POST', headers: userJson, body: JSON.stringify({ on }) }),
  );
  if (d.blocked_by.length) body.append(el('div', 'deps', `Blocks: ${d.blocked_by.map((b) => b.id).join(', ')}`));

  // Labels — removable chips + add.
  body.append(el('h4', '', 'Labels'));
  const labelWrap = el('div', 'label-row');
  if (!d.labels.length) labelWrap.append(el('span', 'muted', 'none'));
  for (const l of d.labels) {
    const chip = el('span', 'label', l);
    const x = el('button', 'chip-x', '×');
    x.onclick = () =>
      api(`/api/tasks/${d.task.id}/labels?name=${encodeURIComponent(l)}`, { method: 'DELETE', headers: { 'x-actor': 'user' } })
        .then(() => openDrawer(d.task.id))
        .catch((err) => toast(`label remove failed: ${err.message}`));
    chip.append(x);
    labelWrap.append(chip);
  }
  body.append(labelWrap);
  appendAdder(body, 'label-input', 'add label…', '+ Label', (name) =>
    api(`/api/tasks/${d.task.id}/labels`, { method: 'POST', headers: userJson, body: JSON.stringify({ name }) }),
  );

  if (d.open_input.length) {
    body.append(el('h4', '', 'Open questions'));
    for (const q of d.open_input) body.append(inboxItem(q));
  }

  body.append(el('h4', '', 'Comments'));
  for (const c of d.comments) {
    const row = el('div', `comment author-${c.author_type}`);
    row.append(el('span', 'author', `${c.author_type}/${c.author_name}`));
    row.append(el('span', 'body', ` ${c.body}`));
    body.append(row);
  }
  const ci = el('input', 'comment-input');
  ci.placeholder = 'add a comment…';
  const cb = el('button', 'send', 'Comment');
  const postComment = () =>
    ci.value &&
    api(`/api/tasks/${d.task.id}/comments`, {
      method: 'POST',
      headers: { ...userJson, 'x-actor': 'user' },
      body: JSON.stringify({ body: ci.value, author_name: 'user' }),
    })
      .then(() => openDrawer(d.task.id))
      .catch((err) => toast(`comment failed: ${err.message}`));
  ci.addEventListener('keydown', (e) => e.key === 'Enter' && postComment());
  cb.onclick = postComment;
  body.append(ci, cb);

  if (d.artifacts.length) {
    body.append(el('h4', '', 'Artifacts'));
    for (const a of d.artifacts) {
      const row = el('div', 'artifact');
      row.append(el('span', 'kind', a.kind));
      const link = el('a', '', a.title);
      link.href = a.uri;
      link.target = '_blank';
      row.append(link);
      body.append(row);
    }
  }
}

// A labelled "[input] [+ button]" row that submits `value` via `submit(value)`,
// then re-opens the drawer to reflect the change.
function appendAdder(body, cls, placeholder, btnText, submit) {
  const wrap = el('div', 'adder');
  const input = el('input', cls);
  input.placeholder = placeholder;
  const go = () => {
    const v = input.value.trim();
    if (!v) return;
    submit(v)
      .then(() => openDrawer(state.openDrawerId))
      .catch((err) => toast(`${btnText} failed: ${err.message}`));
  };
  input.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  const btn = el('button', 'send', btnText);
  btn.onclick = go;
  wrap.append(input, btn);
  body.append(wrap);
}

// Inline edit form for the task's core fields (title/summary/desc/priority).
function openEdit(d) {
  const body = $('#drawer-body');
  body.innerHTML = '';
  body.append(el('h2', '', `Edit ${d.task.id}`));

  const titleIn = el('input', 'edit-field');
  titleIn.value = d.task.title || '';
  const prioSel = el('select', 'edit-field');
  for (const p of ['P0', 'P1', 'P2', 'P3']) {
    const o = el('option', '', p);
    o.value = p;
    if (p === d.task.priority) o.selected = true;
    prioSel.append(o);
  }
  const sumIn = el('textarea', 'edit-field');
  sumIn.rows = 2;
  sumIn.value = d.task.summary || '';
  const descIn = el('textarea', 'edit-field');
  descIn.rows = 4;
  descIn.value = d.task.description || '';

  body.append(el('label', 'edit-label', 'Title'), titleIn);
  body.append(el('label', 'edit-label', 'Priority'), prioSel);
  body.append(el('label', 'edit-label', 'Summary'), sumIn);
  body.append(el('label', 'edit-label', 'Description'), descIn);

  const save = el('button', 'send', 'Save');
  const cancel = el('button', 'ghost', 'Cancel');
  cancel.onclick = () => openDrawer(d.task.id);
  save.onclick = () => {
    const fields = {};
    const title = titleIn.value.trim();
    if (title && title !== d.task.title) fields.title = title;
    if (prioSel.value !== d.task.priority) fields.priority = prioSel.value;
    if (sumIn.value !== (d.task.summary || '')) fields.summary = sumIn.value;
    if (descIn.value !== (d.task.description || '')) fields.description = descIn.value;
    if (!Object.keys(fields).length) return openDrawer(d.task.id);
    api(`/api/tasks/${d.task.id}`, {
      method: 'PATCH',
      headers: { ...userJson, 'if-match': String(d.task.version) },
      body: JSON.stringify(fields),
    })
      .then(() => openDrawer(d.task.id)) // task.updated event also refreshes the board
      .catch((err) => {
        toast(err.status === 409 ? `${d.task.id}: changed elsewhere — reloaded` : `save failed: ${err.message}`);
        openDrawer(d.task.id);
      });
  };
  const actions = el('div', 'edit-actions');
  actions.append(cancel, save);
  body.append(actions);
}

$('#drawer-close').onclick = () => {
  $('#drawer').classList.add('hidden');
  state.openDrawerId = null;
};
// Esc closes the drawer (focus returns to the board).
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#drawer').classList.contains('hidden')) $('#drawer-close').onclick();
});

// --- filter -----------------------------------------------------------------
$('#filter').addEventListener('input', (e) => {
  state.filter = e.target.value.trim().toLowerCase();
  renderBoard();
});

// --- metrics / burndown panel ----------------------------------------------
const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}) {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  return n;
}

function fmtDur(ms) {
  if (ms === null || ms === undefined) return '—';
  if (ms < 60000) return '0m';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h' + (m % 60 ? ` ${m % 60}m` : '');
  const d = Math.floor(h / 24);
  return d + 'd' + (h % 24 ? ` ${h % 24}h` : '');
}

function tile(label, value, sub) {
  const t = el('div', 'tile');
  t.append(el('div', 'tile-val', value));
  t.append(el('div', 'tile-label', label));
  if (sub) t.append(el('div', 'tile-sub', sub));
  return t;
}

// Palette mirrors style.css vars (SVG presentation attrs don't resolve CSS var()).
const C = { line: '#2e3a48', accent: '#4c9aff', warn: '#ffb454', muted: '#8a97a6' };
const SERIES = [
  ['created_cum', C.line, 'created'],
  ['done', C.accent, 'done'],
  ['remaining', C.warn, 'remaining'],
];
// Three-line burndown: remaining (warn) vs done (accent) vs created (line).
function burndownChart(burndown) {
  const W = 560, H = 160, padL = 28, padB = 18, padT = 8, padR = 8;
  // Default preserveAspectRatio (xMidYMid meet) scales uniformly — non-uniform
  // ('none') stretches the axis text horizontally on a wide panel.
  const svg = svgEl('svg', { class: 'burndown', viewBox: `0 0 ${W} ${H}` });
  if (burndown.length < 2) {
    const t = svgEl('text', { x: padL, y: H / 2, fill: C.muted, 'font-size': '11' });
    t.textContent = 'not enough data yet';
    svg.append(t);
    return svg;
  }
  const max = Math.max(1, ...burndown.map((p) => p.created_cum));
  const n = burndown.length;
  const x = (i) => padL + (i / (n - 1)) * (W - padL - padR);
  const y = (v) => padT + (1 - v / max) * (H - padT - padB);
  // axis baseline
  svg.append(svgEl('line', { x1: padL, y1: H - padB, x2: W - padR, y2: H - padB, stroke: C.line }));
  for (const [key, color] of SERIES)
    svg.append(
      svgEl('polyline', {
        points: burndown.map((p, i) => `${x(i)},${y(p[key])}`).join(' '),
        fill: 'none',
        stroke: color,
        'stroke-width': '2',
      }),
    );
  // y-axis max label + date ends
  const tx = (s, ax, ay, anchor) => {
    const t = svgEl('text', { x: ax, y: ay, fill: C.muted, 'font-size': '10', 'text-anchor': anchor || 'start' });
    t.textContent = s;
    return t;
  };
  svg.append(tx(String(max), 2, y(max) + 4));
  svg.append(tx('0', 2, H - padB + 4));
  svg.append(tx(burndown[0].date.slice(5), padL, H - 4));
  svg.append(tx(burndown[n - 1].date.slice(5), W - padR, H - 4, 'end'));
  return svg;
}

function burndownLegend() {
  const wrap = el('div', 'legend');
  for (const [, color, label] of SERIES) {
    const item = el('span', 'legend-item');
    const sw = el('span', 'legend-swatch');
    sw.style.background = color;
    item.append(sw, el('span', '', label));
    wrap.append(item);
  }
  return wrap;
}

async function loadStats() {
  let s;
  try {
    s = await api('/api/stats?json&cfd=1');
  } catch (e) {
    $('#metrics-body').innerHTML = '';
    $('#metrics-body').append(el('div', 'metrics-banner', `stats failed: ${e.message}`));
    return;
  }
  const body = $('#metrics-body');
  body.innerHTML = '';

  if (s.partial_history) {
    body.append(
      el(
        'div',
        'metrics-banner',
        `History bounded — ${s.excluded_partial.length} task(s) excluded from timing (older events compacted).`,
      ),
    );
  }

  const tiles = el('div', 'tiles');
  tiles.append(tile('done / window', String(s.throughput.total), `${s.throughput.rolling_avg_per_day}/day · ${s.throughput.per_week}/wk`));
  tiles.append(tile('lead p50', fmtDur(s.timing_summary.lead_ms.p50), `p90 ${fmtDur(s.timing_summary.lead_ms.p90)} · n=${s.timing_summary.lead_ms.n}`));
  tiles.append(tile('cycle p50', fmtDur(s.timing_summary.cycle_ms.p50), `p90 ${fmtDur(s.timing_summary.cycle_ms.p90)} · n=${s.timing_summary.cycle_ms.n}`));
  tiles.append(tile('flow efficiency', pctVal(s.timing_summary.flow_efficiency.p50), `avg ${pctVal(s.timing_summary.flow_efficiency.avg)} · n=${s.timing_summary.flow_efficiency.n}`));
  // Net flow: arrival vs departure, coloured by whether the board is growing.
  const f = s.flow;
  const netTile = tile('net flow / day', `${f.net_per_day > 0 ? '+' : ''}${f.net_per_day}`, `${f.arrival_per_day} in · ${f.departure_per_day} out · ${f.trend}`);
  if (f.trend === 'growing') netTile.classList.add('tile-warn');
  else if (f.trend === 'shrinking') netTile.classList.add('tile-good');
  tiles.append(netTile);
  // Forecast: days to drain the backlog at current velocity.
  const fc = s.forecast;
  const drainTile = tile('drain forecast', fc.days_to_drain !== null ? `${fc.days_to_drain}d` : '∞', fc.days_to_drain !== null ? `${fc.remaining} open · eta ${fc.eta}` : `${fc.remaining} open · velocity 0`);
  if (fc.diverging) drainTile.classList.add('tile-warn');
  tiles.append(drainTile);
  // Input-wait: human response latency.
  const iw = s.input_wait;
  tiles.append(tile('input wait', iw.resolved.n ? fmtDur(iw.resolved.p50) : '—', `${iw.open} open${iw.oldest_open_ms !== null ? ` · oldest ${fmtDur(iw.oldest_open_ms)}` : ''} · ${iw.answered}a/${iw.expired}x/${iw.cancelled}c`));
  // Rework: reopen + kickback rates.
  const q = s.quality;
  const reworkTile = tile('rework', `${pctVal(q.kickback_rate)}`, `reopened ${q.reopened} · kickbacks ${q.kickbacks}`);
  if (q.kickbacks || q.reopened) reworkTile.classList.add('tile-warn');
  tiles.append(reworkTile);
  // WIP tiles fold in the aging breakdown (fresh / aging / stale).
  for (const c of s.wip) {
    const a = c.aging;
    const sub = `${a.fresh}f · ${a.aging}a · ${a.stale}s${c.oldest ? ` · oldest ${fmtDur(c.oldest.age_ms)}` : ''}`;
    const t = tile(`WIP ${c.status}`, String(c.count), sub);
    if (a.stale) t.classList.add('tile-warn');
    tiles.append(t);
  }
  body.append(tiles);

  // --- breakdown tables — a responsive grid of cards so they flow across the
  //     panel width instead of stacking in one narrow left column. ---
  const grid = el('div', 'metric-grid');

  // Aging flags — non-Done tasks past the stale threshold.
  if (s.aging_flags.length) {
    const rows = s.aging_flags.slice(0, 12).map((a) => [a.id, a.status, fmtDur(a.age_ms)]);
    grid.append(metricCard(`Aging > 7d (${s.aging_flags.length})`, metricTable(['task', 'status', 'age'], rows)));
  }

  // Per-priority cycle/lead.
  const prioRows = s.by_priority.filter((p) => p.n || p.wip)
    .map((p) => [p.priority, String(p.n), fmtDur(p.lead.p50), fmtDur(p.cycle.p50), String(p.wip)]);
  if (prioRows.length)
    grid.append(metricCard('By priority', metricTable(['prio', 'done', 'lead p50', 'cycle p50', 'wip'], prioRows)));

  // Per-label throughput.
  if (s.by_label.length) {
    const rows = s.by_label.map((l) => [l.name, String(l.n), fmtDur(l.cycle.p50), String(l.wip)]);
    grid.append(metricCard('By label', metricTable(['label', 'done', 'cycle p50', 'wip'], rows)));
  }

  // Per-agent throughput.
  if (s.by_agent.length) {
    const rows = s.by_agent.map((a) => [a.agent_id, String(a.completed), fmtDur(a.cycle.p50), String(a.active_wip)]);
    grid.append(metricCard('By agent', metricTable(['agent', 'done', 'cycle p50', 'wip'], rows)));
  }

  if (grid.children.length) body.append(grid);

  // --- charts — wider grid tracks so the two time-series sit side by side on a
  //     wide panel and the SVGs fill their cards (no fixed max-width gap). ---
  const charts = el('div', 'metric-charts');
  charts.append(metricCard(`Burndown · window ${s.window.days}d`, burndownLegend(), burndownChart(s.burndown)));
  if (s.cfd && s.cfd.length)
    charts.append(metricCard('Cumulative flow', cfdLegend(), cfdChart(s.cfd)));
  body.append(charts);
}

/** A [0,1] ratio rendered as a whole percent. */
function pctVal(r) {
  return r === null || r === undefined ? '—' : `${Math.round(r * 100)}%`;
}

/** A titled card wrapping one breakdown/chart, for the responsive metrics grid. */
function metricCard(title, ...children) {
  const card = el('div', 'metric-card');
  card.append(el('h3', 'metrics-sub', title));
  for (const c of children) if (c) card.append(c);
  return card;
}

/** A simple metrics table from a header row + string cells. */
function metricTable(headers, rows) {
  const t = el('table', 'metric-table');
  const thead = el('tr');
  for (const h of headers) thead.append(el('th', '', h));
  t.append(thead);
  for (const r of rows) {
    const tr = el('tr');
    for (const cell of r) tr.append(el('td', '', cell));
    t.append(tr);
  }
  return t;
}

// CFD stacked-area: one column per status, oldest→newest left→right. Stacked in
// workflow order so the band heights read as the board's WIP composition over time.
const CFD_COLORS = { Backlog: '#5a6573', Ready: '#4c9aff', 'In Progress': '#ffb454', Review: '#b083ff', Done: '#3fb950' };
function cfdChart(cfd) {
  const W = 560, H = 160, padL = 28, padB = 18, padT = 8, padR = 8;
  const svg = svgEl('svg', { class: 'burndown', viewBox: `0 0 ${W} ${H}` });
  if (cfd.length < 2) {
    const t = svgEl('text', { x: padL, y: H / 2, fill: C.muted, 'font-size': '11' });
    t.textContent = 'not enough data yet';
    svg.append(t);
    return svg;
  }
  const totals = cfd.map((p) => WORKFLOW_STATUSES.reduce((a, st) => a + (p.counts[st] || 0), 0));
  const max = Math.max(1, ...totals);
  const n = cfd.length;
  const x = (i) => padL + (i / (n - 1)) * (W - padL - padR);
  const y = (v) => padT + (1 - v / max) * (H - padT - padB);
  // Build each band as a filled polygon between the running cumulative baselines.
  const below = cfd.map(() => 0);
  for (const st of WORKFLOW_STATUSES) {
    const top = cfd.map((p, i) => below[i] + (p.counts[st] || 0));
    const pts = [];
    for (let i = 0; i < n; i++) pts.push(`${x(i)},${y(top[i])}`);
    for (let i = n - 1; i >= 0; i--) pts.push(`${x(i)},${y(below[i])}`);
    svg.append(svgEl('polygon', { points: pts.join(' '), fill: CFD_COLORS[st] || C.line, 'fill-opacity': '0.85' }));
    for (let i = 0; i < n; i++) below[i] = top[i];
  }
  const tx = (str, ax, ay, anchor) => {
    const t = svgEl('text', { x: ax, y: ay, fill: C.muted, 'font-size': '10', 'text-anchor': anchor || 'start' });
    t.textContent = str;
    return t;
  };
  svg.append(tx(String(max), 2, y(max) + 4));
  svg.append(tx('0', 2, H - padB + 4));
  svg.append(tx(cfd[0].date.slice(5), padL, H - 4));
  svg.append(tx(cfd[n - 1].date.slice(5), W - padR, H - 4, 'end'));
  return svg;
}

function cfdLegend() {
  const wrap = el('div', 'legend');
  for (const st of WORKFLOW_STATUSES) {
    const item = el('span', 'legend-item');
    const sw = el('span', 'legend-swatch');
    sw.style.background = CFD_COLORS[st] || C.line;
    item.append(sw, el('span', '', st));
    wrap.append(item);
  }
  return wrap;
}

let statsTimer = null;
function scheduleStats() {
  if (statsTimer || $('#metrics-panel').classList.contains('hidden')) return;
  statsTimer = setTimeout(() => {
    statsTimer = null;
    loadStats();
  }, 300);
}

function toggleMetrics() {
  const p = $('#metrics-panel');
  p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) loadStats();
}
$('#metrics-btn').addEventListener('click', toggleMetrics);
$('#metrics-close').addEventListener('click', () => $('#metrics-panel').classList.add('hidden'));

// --- create task modal ------------------------------------------------------
(() => {
  const statusSel = $('#ct-status');
  for (const s of WORKFLOW_STATUSES) {
    const o = el('option', '', s);
    o.value = s;
    if (s === 'Backlog') o.selected = true;
    statusSel.append(o);
  }
})();

const modal = $('#create-modal');
function openCreate() {
  modal.classList.remove('hidden');
  $('#ct-title').focus();
}
function closeCreate() {
  modal.classList.add('hidden');
  $('#create-form').reset();
}
function submitCreate() {
  const title = $('#ct-title').value.trim();
  if (!title) {
    toast('Enter a title');
    $('#ct-title').focus();
    return;
  }
  const body = {
    title,
    priority: $('#ct-priority').value,
    status: $('#ct-status').value,
  };
  const desc = $('#ct-desc').value.trim();
  if (desc) body.description = desc;
  api('/api/tasks', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
    .then(() => {
      closeCreate();
      refresh(); // also reconcile immediately, not only off the WS event
    })
    .catch((err) => toast(`create failed: ${err.message}`));
}
// Bind via addEventListener + a plain button (no implicit form submit).
$('#add-task').addEventListener('click', openCreate);
$('#ct-cancel').addEventListener('click', closeCreate);
$('#ct-create').addEventListener('click', submitCreate);
modal.addEventListener('click', (e) => e.target === modal && closeCreate());
$('#create-form').addEventListener('submit', (e) => {
  e.preventDefault(); // Enter key in a field still creates
  submitCreate();
});

// --- notifications ----------------------------------------------------------
function reflectNotifyBtn() {
  const b = $('#notify-btn');
  if (!('Notification' in window)) {
    b.classList.add('hidden');
    return;
  }
  b.classList.toggle('on', Notification.permission === 'granted');
}
$('#notify-btn').addEventListener('click', () => {
  if (!('Notification' in window)) return toast('notifications unsupported');
  Notification.requestPermission().then((p) => {
    reflectNotifyBtn();
    toast(p === 'granted' ? 'notifications on' : 'notifications blocked');
  });
});
reflectNotifyBtn();

function notify(ev) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const n = new Notification('KanAgentBan: agent needs your input', {
    body: (ev.payload && ev.payload.question) || ev.task_id || '',
  });
  n.onclick = () => {
    window.focus();
    if (ev.task_id) openDrawer(ev.task_id);
  };
}

// --- realtime: event-routed targeted updates --------------------------------
let lastSeq = 0;
let pending = new Map(); // id -> { drawer, inbox }
let flushTimer = null;
const drawerFor = (id) => state.openDrawerId === id;

// Coalesce a burst of frames into one fetch per affected task.
function queueSync(id, opts = {}) {
  if (!id) return;
  const cur = pending.get(id) || {};
  if (opts.drawer) cur.drawer = true;
  if (opts.inbox) cur.inbox = true;
  pending.set(id, cur);
  if (!flushTimer) flushTimer = setTimeout(flushSync, 40);
}

async function flushSync() {
  flushTimer = null;
  const batch = pending;
  pending = new Map();
  for (const [id, opts] of batch) await syncTask(id, opts);
}

async function syncTask(id, opts) {
  try {
    const c = await api(`/api/ui/tasks/${id}/card`);
    upsertCard(c);
    // A child's change can shift the parent's subtask rollup — refresh it too.
    if (c.parent_id) {
      try {
        upsertCard(await api(`/api/ui/tasks/${c.parent_id}/card`));
      } catch {}
    }
  } catch (e) {
    if (e.status === 404) {
      removeCard(id); // archived / gone
      return;
    }
  }
  if (opts.inbox || opts.drawer) {
    try {
      const d = await api(`/api/ui/tasks/${id}`);
      if (opts.inbox) {
        if (d.open_input.length) state.inboxByTask.set(id, d.open_input);
        else state.inboxByTask.delete(id);
        renderInbox();
      }
      if (opts.drawer && state.openDrawerId === id) {
        renderDrawer(d);
        markSeen(id, d.comments.length);
      }
    } catch {}
  }
}

function applyEvent(ev) {
  // Log compacted below our cursor: jump past the floor so reconnects don't
  // reset-loop, then reseed from full state.
  if (ev.type === 'reset') {
    lastSeq = Math.max(lastSeq, ev.cursor || ev.floor || 0);
    return void refresh();
  }
  if (ev.seq) lastSeq = Math.max(lastSeq, ev.seq);
  if (ev.type === 'input.requested') notify(ev);

  const id = ev.task_id;
  if (ev.type === 'task.archived') return removeCard(id);

  const isInput = ev.type.startsWith('input.');
  queueSync(id, { inbox: isInput, drawer: drawerFor(id) });
  // Structural events touch a second task's derived state.
  if ((ev.type === 'dep.added' || ev.type === 'dep.removed') && ev.payload?.to)
    queueSync(ev.payload.to, { drawer: drawerFor(ev.payload.to) });
  if (ev.type === 'task.reparented') {
    if (ev.payload?.from) queueSync(ev.payload.from, { drawer: drawerFor(ev.payload.from) });
    if (ev.payload?.to) queueSync(ev.payload.to, { drawer: drawerFor(ev.payload.to) });
  }
}

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?since=${lastSeq}&token=${token}`);
  ws.onopen = () => ($('#conn').textContent = '● live');
  ws.onclose = () => {
    $('#conn').textContent = '○ reconnecting…';
    setTimeout(connectWs, 1000);
  };
  ws.onmessage = (m) => {
    let ev;
    try {
      ev = JSON.parse(m.data);
    } catch {
      return;
    }
    applyEvent(ev);
    scheduleStats(); // keep the metrics panel current while it's open
  };
}

refresh().then(connectWs).catch((e) => ($('#conn').textContent = `error: ${e.message} (token?)`));
