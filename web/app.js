// Minimal realtime board UI. See docs/08-web-ui.md.
'use strict';

const params = new URLSearchParams(location.search);
const token = params.get('token') || localStorage.getItem('kanban_token') || '';
if (params.get('token')) localStorage.setItem('kanban_token', token);

const headers = { authorization: `Bearer ${token}` };
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

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 4000);
}

async function refresh() {
  const data = await api('/api/ui/board');
  renderBoard(data);
  renderInbox(data.inbox);
}

function renderBoard({ columns, tasks }) {
  const board = $('#board');
  board.innerHTML = '';
  for (const col of columns) {
    const column = el('div', 'column');
    const droppable = WORKFLOW_STATUSES.includes(col);
    if (!droppable) column.classList.add('no-drop');
    column.append(el('h3', 'col-title', col));
    const list = el('div', 'col-list');
    for (const t of tasks.filter((t) => t.column === col)) list.append(card(t));
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
}

// Stash the dragged task id (dataTransfer.getData is empty during dragover on
// some browsers, so we also keep it module-scoped).
let dragId = null;

function moveTask(id, status) {
  api(`/api/tasks/${id}/move`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status }),
  }).catch((e) => {
    toast(e.status === 409 ? `${id}: changed elsewhere — reloaded` : `move failed: ${e.message}`);
    refresh();
  });
  // The task.moved event drives the visible relocation (refresh on WS frame).
}

function card(t) {
  const c = el('div', `card prio-${t.priority}`);
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
  if (t.comments) flags.append(el('span', 'flag', `💬${t.comments}`));
  if (t.criteria_total) flags.append(el('span', 'flag', `✓${t.criteria_done}/${t.criteria_total}`));
  for (const l of t.labels || []) flags.append(el('span', 'label', l));
  c.append(flags);
  c.onclick = () => openDrawer(t.id);
  return c;
}

function renderInbox(inbox) {
  const box = $('#inbox');
  const items = $('#inbox-items');
  items.innerHTML = '';
  if (!inbox.length) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  for (const q of inbox) items.append(inboxItem(q));
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
    const send = el('button', 'send', 'Answer');
    send.onclick = () => input.value && answer(q.id, input.value);
    form.append(input, send);
  }
  wrap.append(form);
  return wrap;
}

const answer = (qid, text) =>
  api(`/api/input-requests/${qid}/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ answer: text, answered_by: 'user' }),
  }).catch((err) => toast(`answer failed: ${err.message}`));

async function openDrawer(id) {
  const d = await api(`/api/ui/tasks/${id}`);
  const body = $('#drawer-body');
  body.innerHTML = '';
  const head = el('div', 'drawer-head');
  head.append(el('h2', '', `${d.task.id} ${d.task.title}`));
  const edit = el('button', 'ghost edit-btn', 'Edit');
  edit.onclick = () => openEdit(d);
  head.append(edit);
  body.append(head);
  body.append(el('div', 'meta', `${d.task.priority} · ${d.task.status}`));
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

  if (d.criteria.length) {
    body.append(el('h4', '', 'Acceptance criteria'));
    for (const c of d.criteria) {
      const row = el('label', 'crit');
      const cb = el('input');
      cb.type = 'checkbox';
      cb.checked = !!c.checked;
      cb.onchange = () =>
        api(`/api/criteria/${c.id}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ checked: cb.checked }),
        }).catch((err) => {
          toast(`update failed: ${err.message}`);
          cb.checked = !cb.checked;
        });
      row.append(cb, el('span', '', ` ${c.text}`));
      body.append(row);
    }
  }

  if (d.blockers.length) body.append(el('div', 'deps', `Blocked by: ${d.blockers.map((b) => `${b.id} (${b.status})`).join(', ')}`));
  if (d.blocked_by.length) body.append(el('div', 'deps', `Blocks: ${d.blocked_by.map((b) => b.id).join(', ')}`));

  if (d.open_input.length) {
    body.append(el('h4', '', 'Open questions'));
    for (const q of d.open_input) body.append(inboxItem(q));
  }

  body.append(el('h4', '', 'Comments'));
  for (const c of d.comments) {
    const row = el('div', 'comment');
    row.append(el('span', 'author', `${c.author_type}/${c.author_name}`));
    row.append(el('span', 'body', ` ${c.body}`));
    body.append(row);
  }
  const ci = el('input', 'comment-input');
  ci.placeholder = 'add a comment…';
  const cb = el('button', 'send', 'Comment');
  cb.onclick = () =>
    ci.value &&
    api(`/api/tasks/${id}/comments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-actor': 'user' },
      body: JSON.stringify({ body: ci.value, author_name: 'user' }),
    })
      .then(() => openDrawer(id))
      .catch((err) => toast(`comment failed: ${err.message}`));
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

  $('#drawer').classList.remove('hidden');
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
      headers: { 'content-type': 'application/json', 'if-match': String(d.task.version) },
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

$('#drawer-close').onclick = () => $('#drawer').classList.add('hidden');

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

// --- realtime: reconnecting WebSocket; re-fetch board on any event ---------
let lastSeq = 0;
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws?since=${lastSeq}&token=${token}`);
  ws.onopen = () => ($('#conn').textContent = '● live');
  ws.onclose = () => {
    $('#conn').textContent = '○ reconnecting…';
    setTimeout(connectWs, 1000);
  };
  ws.onmessage = (m) => {
    const ev = JSON.parse(m.data);
    if (ev.seq) lastSeq = Math.max(lastSeq, ev.seq);
    if (ev.type === 'input.requested' && 'Notification' in window && Notification.permission === 'granted') {
      new Notification('KanAgentBan: agent needs your input', { body: ev.payload.question || ev.task_id });
    }
    refresh();
  };
}

if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
refresh().then(connectWs).catch((e) => ($('#conn').textContent = `error: ${e.message} (token?)`));
