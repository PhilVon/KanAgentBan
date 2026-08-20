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
// Font Awesome <i> factory. `name` is the icon sans `fa-` prefix; `style` is the
// family ('solid' default, or 'regular'). Icons color via currentColor, so they
// inherit the theme. Decorative by default (aria-hidden); pass `label` for an
// accessible name on a standalone/meaningful icon.
function icon(name, style = 'solid', label) {
  const i = el('i', `fa-${style} fa-${name}`);
  if (label) i.setAttribute('aria-label', label);
  else i.setAttribute('aria-hidden', 'true');
  return i;
}
// A card flag pill: a leading icon plus optional adjacent text (count/id/name).
// When there's no text the icon carries the accessible `label`.
function flag(cls, iconName, text, label) {
  const s = el('span', cls);
  const hasText = text != null && text !== '';
  s.append(icon(iconName, 'solid', hasText ? undefined : label));
  if (hasText) s.append(el('span', 'flag-text', String(text)));
  return s;
}
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
  filter: '', // raw filter text (for empty-state copy)
  query: [], // parsed predicates — see parseQuery
};
let colListEls = new Map(); // column name -> its .col-list element
let colCountEls = new Map(); // column name -> its .col-count badge element
let doneArchiveBtn = null; // the Done column's "Archive all" button (null until rendered)

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

// --- filter query grammar -----------------------------------------------------
// Space-separated tokens, ALL must match (AND):
//   status:<prefix> / col:<prefix> — display column, incl. derived Blocked
//   p0..p3                         — priority equals
//   label:<x>                      — label substring
//   @name                          — assignee substring
//   is:blocked|input|claimed|subtask
//   anything else                  — substring over id/title/description/summary/labels/assignee
// Unknown is:/status: values match nothing (predictable, not silently text).
function parseQuery(raw) {
  return raw
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => {
      const m = /^(status|col|label|is):(.*)$/.exec(tok);
      if (m) return { kind: m[1] === 'col' ? 'status' : m[1], value: m[2] };
      if (/^p[0-3]$/.test(tok)) return { kind: 'prio', value: tok };
      if (tok.startsWith('@')) return { kind: 'assignee', value: tok.slice(1) };
      return { kind: 'text', value: tok };
    });
}

function matchesFilter(t) {
  if (!state.query.length) return true;
  const labels = (t.labels || []).map((l) => String(l).toLowerCase());
  const assignee = (t.assignee || '').toLowerCase();
  return state.query.every((p) => {
    switch (p.kind) {
      case 'status':
        return p.value !== '' && String(t.column || t.status).toLowerCase().startsWith(p.value);
      case 'prio':
        return String(t.priority).toLowerCase() === p.value;
      case 'label':
        return labels.some((l) => l.includes(p.value));
      case 'assignee':
        return assignee.includes(p.value);
      case 'is':
        if (p.value === 'blocked') return !!(t.blocked_by_deps || t.blocked_by_children);
        if (p.value === 'input') return !!t.needs_input;
        if (p.value === 'claimed') return t.assignee != null;
        if (p.value === 'subtask') return t.parent_id != null;
        return false;
      default:
        return `${t.id} ${t.title} ${t.description || ''} ${t.summary || ''} ${labels.join(' ')} ${assignee}`
          .toLowerCase()
          .includes(p.value);
    }
  });
}

// --- project identity -------------------------------------------------------
// Stamp the board name into the header + tab title, and derive a stable accent
// colour from the name so several boards open at once are tellable apart at a
// glance (browser tabs, window switcher, the header itself).
let appliedBoardName;
function applyBoardIdentity(name) {
  if (!name || name === appliedBoardName) return;
  appliedBoardName = name;
  document.title = `${name} · KanAgentBan`;
  const h1 = $('header h1');
  if (h1) {
    h1.textContent = name;
    h1.title = `Board: ${name}`;
  }
  // Deterministic hue from the name (djb2 → 0..359); fixed S/L keeps every
  // board's accent legible on the dark theme.
  let hash = 5381;
  for (let i = 0; i < name.length; i++) hash = ((hash << 5) + hash + name.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  document.documentElement.style.setProperty('--board-accent', `hsl(${hue} 65% 60%)`);

  // Color-coded favicon: same hue tile + the project's initial, so the board is
  // identifiable from the browser tab/bookmark even when the title is truncated.
  const link = $('#favicon');
  if (link) {
    const initial = (name.trim()[0] || '?')
      .toUpperCase()
      .replace(/[<>&]/g, (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;'));
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
      `<rect width="32" height="32" rx="7" fill="hsl(${hue} 65% 55%)"/>` +
      `<text x="16" y="23" text-anchor="middle" font-family="system-ui,Segoe UI,sans-serif" ` +
      `font-size="21" font-weight="700" fill="#0f1419">${initial}</text>` +
      `</svg>`;
    link.href = 'data:image/svg+xml,' + encodeURIComponent(svg);
  }
}

// --- full reseed (first load, reset, create, conflict reconcile) ------------
async function refresh() {
  const data = await api('/api/ui/board');
  applyBoardIdentity(data.name);
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
  colCountEls = new Map();
  for (const col of state.columns) {
    const column = el('div', 'column');
    const droppable = WORKFLOW_STATUSES.includes(col);
    if (!droppable) column.classList.add('no-drop');
    // Title row: status-colored dot (mirrors the CFD chart palette) · name · live count.
    const title = el('h3', 'col-title');
    const dot = el('span', 'col-dot');
    dot.style.background = CFD_COLORS[col] || C.line;
    const count = el('span', 'col-count');
    colCountEls.set(col, count);
    title.append(dot, el('span', 'col-name', col), count);
    // Done gets a bulk "Archive all" action; disabled state synced in renderColumn.
    if (col === 'Done') {
      doneArchiveBtn = el('button', 'ghost col-archive');
      doneArchiveBtn.append(icon('box-archive'), ' Archive all');
      doneArchiveBtn.title = 'Archive all Done tasks';
      doneArchiveBtn.onclick = archiveAllDone;
      title.append(doneArchiveBtn);
    }
    column.append(title);
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
  const countEl = colCountEls.get(name);
  if (countEl) countEl.textContent = String(items.length);
  // Archive-all acts on every Done task, so gate it on the unfiltered count.
  if (name === 'Done' && doneArchiveBtn) doneArchiveBtn.disabled = doneCount() === 0;
  if (!items.length) {
    list.append(el('div', 'col-empty', state.filter ? 'no matches' : '—'));
    return;
  }
  for (const t of items) list.append(card(t));
}

function upsertCard(model) {
  // An archived task is off the board — never let one land in state (defense in
  // depth: the server 404s the card route, but guard here too so a stray archived
  // model can't resurrect a card into its old column).
  if (model.archived_at) return removeCard(model.id);
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
  let cls = `card prio-${t.priority}`;
  if (t.blocked_by_deps) cls += ' blocked';
  if (t.needs_input) cls += ' needs-input';
  const c = el('div', cls);
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
  if (t.blocked_by_deps) flags.append(flag('flag dep', 'lock', '', 'blocked by dependencies'));
  if (t.needs_input) flags.append(flag('flag input', 'circle-question', '', 'needs input'));
  if (t.child_total) flags.append(flag('flag subtasks', 'list-check', `${t.child_done}/${t.child_total}`));
  if (t.parent_id) flags.append(flag('flag parent', 'code-branch', t.parent_id));
  if (t.comments) {
    const unread = Math.max(0, t.comments - (seenComments[t.id] || 0));
    const cf = flag(unread ? 'flag comments unread' : 'flag comments', 'comment', t.comments);
    if (unread) cf.title = `${unread} new since you last looked`;
    flags.append(cf);
  }
  if (t.criteria_total) flags.append(flag('flag', 'circle-check', `${t.criteria_done}/${t.criteria_total}`));
  if (t.assignee) flags.append(flag('flag assignee', 'user', t.assignee));
  for (const l of t.labels || []) flags.append(el('span', 'label', l));
  c.append(flags);
  // Review gate: sign-off buttons on cards actually sitting in the Review
  // column (a blocked Review task resolves its blocker first).
  if (t.column === 'Review') {
    const row = el('div', 'review-actions');
    const ok = el('button', 'review-approve', '✓ Approve');
    ok.onclick = (e) => {
      e.stopPropagation();
      review(t.id, 'approve');
    };
    const no = el('button', 'review-reject', '✕ Reject');
    no.onclick = (e) => {
      e.stopPropagation();
      const reason = prompt(`Why does ${t.id} bounce back? (recorded on the task)`);
      if (reason && reason.trim()) review(t.id, 'reject', reason.trim());
    };
    row.append(ok, no);
    c.append(row);
  }
  c.onclick = () => openDrawer(t.id);
  return c;
}

const review = (id, verdict, reason) =>
  api(`/api/tasks/${id}/review`, {
    method: 'POST',
    headers: userJson,
    body: JSON.stringify({ verdict, ...(reason ? { reason } : {}) }),
  }).catch((err) => toast(`review failed: ${err.message}`));

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
  // A watch is not a question: nothing is being asked of the reader, so it says
  // so and offers "It happened" rather than an answer box it has no answer for.
  const isWatch = q.kind === 'watch';
  const wrap = el('div', isWatch ? 'inbox-item watch' : 'inbox-item');
  wrap.append(el('div', 'q-task', `${q.task_id} · ${q.id}${isWatch ? ' · watch' : ''}`));
  wrap.append(el('div', 'q-text', isWatch ? `waiting for: ${q.question}` : q.question));
  const form = el('div', 'q-form');
  if (isWatch) {
    const done = el('button', 'send', 'It happened');
    done.onclick = () => answer(q.id, 'happened');
    form.append(done);
  } else {
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
  }
  const cancel = el('button', 'ghost q-cancel', isWatch ? 'Drop watch' : 'Cancel');
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
  $('#drawer').classList.add('open');
  $('#drawer-backdrop').classList.add('open');
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
  const meta = el('div', 'meta', `${d.task.priority} · ${d.task.status}`);
  if (d.task.assignee) meta.append(' · ', icon('user'), ' ' + d.task.assignee);
  body.append(meta);
  if (d.parent) {
    const p = el('div', 'parent-link');
    p.append(icon('code-branch'), ` parent: ${d.parent.id} ${d.parent.title} (${d.parent.status})`);
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

  {
    // Retired criteria leave BOTH sides of the count — one that turned out to be
    // wrong is not outstanding work — and the tails only appear when non-zero, so
    // an ordinary task still reads "Acceptance criteria 5/6".
    const live = d.criteria.filter((c) => !c.retired_at);
    const retired = d.criteria.length - live.length;
    const humanOpen = live.filter((c) => c.human && !c.checked).length;
    const tail =
      (retired ? ` · ${retired} retired` : '') + (humanOpen ? ` · ${humanOpen} for you` : '');
    body.append(
      el('h4', '', `Acceptance criteria ${live.filter((c) => c.checked).length}/${live.length}${tail}`),
    );
  }
  for (const c of d.criteria) {
    if (c.retired_at) {
      // No checkbox: there is nothing to tick, and offering one invites the false
      // tick retirement exists to avoid. The reason is the record, so it shows.
      const row = el('div', 'crit retired');
      const why = c.retire_reason + (c.successor_task_id ? ` → ${c.successor_task_id}` : '');
      row.append(el('span', 'crit-text', c.text), el('span', 'crit-why', ` retired: ${why}`));
      body.append(row);
      continue;
    }
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
    // A human criterion is the human's to settle — say so, so it stops reading as
    // something the agent is failing to finish (and so they know to look).
    if (c.human) row.append(el('span', 'crit-human', ' for you'));
    body.append(row);
  }
  appendAdder(body, 'crit-input', 'new criterion…', 'Criterion', (text) =>
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
    const stBtn = el('button', 'send');
    stBtn.append(icon('plus'), ' Subtask');
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
    const blbl = el('span', '');
    blbl.append(icon('lock'), ` ${b.id} (${b.status})`);
    row.append(blbl);
    const x = el('button', 'chip-x');
    x.setAttribute('aria-label', 'remove dependency');
    x.append(icon('xmark'));
    x.title = 'remove dependency';
    x.onclick = () =>
      api(`/api/tasks/${d.task.id}/deps?on=${encodeURIComponent(b.id)}`, { method: 'DELETE', headers: { 'x-actor': 'user' } })
        .then(() => openDrawer(d.task.id))
        .catch((err) => toast(`dep remove failed: ${err.message}`));
    row.append(x);
    depWrap.append(row);
  }
  body.append(depWrap);
  appendAdder(body, 'dep-input', 'add blocker (T-n)…', 'Blocker', (on) =>
    api(`/api/tasks/${d.task.id}/deps`, { method: 'POST', headers: userJson, body: JSON.stringify({ on }) }),
  );
  if (d.blocked_by.length) body.append(el('div', 'deps', `Blocks: ${d.blocked_by.map((b) => b.id).join(', ')}`));

  // Labels — removable chips + add.
  body.append(el('h4', '', 'Labels'));
  const labelWrap = el('div', 'label-row');
  if (!d.labels.length) labelWrap.append(el('span', 'muted', 'none'));
  for (const l of d.labels) {
    const chip = el('span', 'label', l);
    const x = el('button', 'chip-x');
    x.setAttribute('aria-label', 'remove label');
    x.append(icon('xmark'));
    x.onclick = () =>
      api(`/api/tasks/${d.task.id}/labels?name=${encodeURIComponent(l)}`, { method: 'DELETE', headers: { 'x-actor': 'user' } })
        .then(() => openDrawer(d.task.id))
        .catch((err) => toast(`label remove failed: ${err.message}`));
    chip.append(x);
    labelWrap.append(chip);
  }
  body.append(labelWrap);
  appendAdder(body, 'label-input', 'add label…', 'Label', (name) =>
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
      // git:<sha> / branch:<name> / file paths aren't navigable — plain text.
      if (/^https?:/.test(a.uri)) {
        const link = el('a', '', a.title);
        link.href = a.uri;
        link.target = '_blank';
        row.append(link);
      } else {
        row.append(el('span', '', a.title));
        row.append(el('span', 'kind', a.uri.length > 30 ? a.uri.slice(0, 27) + '…' : a.uri));
      }
      body.append(row);
    }
  }

  if (d.docs?.length) {
    body.append(el('h4', '', 'Docs'));
    for (const doc of d.docs) {
      const row = el('div', 'artifact');
      row.append(el('span', 'kind', `${doc.kind}/${doc.status}`));
      const link = el('a', '', `${doc.id} ${doc.title}`);
      link.href = '#';
      link.addEventListener('click', (e) => {
        e.preventDefault();
        $('#drawer-close').onclick();
        openDocsPanel(doc.id);
      });
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
  const btn = el('button', 'send');
  btn.append(icon('plus'), ' ' + btnText);
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
  $('#drawer').classList.remove('open');
  $('#drawer-backdrop').classList.remove('open');
  state.openDrawerId = null;
};
// Click the dimmed backdrop to dismiss the drawer.
$('#drawer-backdrop').addEventListener('click', () => $('#drawer-close').onclick());
// Esc closes the drawer (focus returns to the board).
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && $('#drawer').classList.contains('open')) $('#drawer-close').onclick();
});

// --- filter -----------------------------------------------------------------
$('#filter').addEventListener('input', (e) => {
  state.filter = e.target.value.trim().toLowerCase();
  state.query = parseQuery(e.target.value);
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

const DAY_MS = 86_400_000;

/** Per-day rate at its natural unit — mirrors render.ts fmtRate so CLI and web
 *  agree: `2.5/h` when brisk (≥24/day), else `0.3/d`. */
function fmtRate(perDay) {
  return perDay >= 24 ? `${Math.round((perDay / 24) * 10) / 10}/h` : `${Math.round(perDay * 100) / 100}/d`;
}

/** A bucket-start ISO timestamp as an axis label, scaled to the bucket width:
 *  `14:05` (UTC) for sub-day buckets, `07-10` for day-or-coarser. */
function fmtTick(iso, bucketMs) {
  return bucketMs < DAY_MS ? iso.slice(11, 16) : iso.slice(5, 10);
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
function burndownChart(burndown, bucketMs) {
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
  // Time axis: first / middle / last ticks. Variable bucket widths make two
  // labels too few to orient, so add a middle one. Sub-day charts date-stamp the
  // first tick ("07-10 14:05"); the header already names the UTC basis.
  const stamp = (i) =>
    bucketMs < DAY_MS && i === 0 ? `${burndown[i].t.slice(5, 10)} ${burndown[i].t.slice(11, 16)}` : fmtTick(burndown[i].t, bucketMs);
  const mid = Math.floor((n - 1) / 2);
  svg.append(tx(stamp(0), padL, H - 4));
  if (mid > 0 && mid < n - 1) svg.append(tx(fmtTick(burndown[mid].t, bucketMs), x(mid), H - 4, 'middle'));
  svg.append(tx(fmtTick(burndown[n - 1].t, bucketMs), W - padR, H - 4, 'end'));
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
  // Velocity trend: recent half of the window vs the prior half.
  const tr = s.throughput.trend || { direction: 'flat', delta_pct: null };
  const trendTxt =
    tr.direction === 'flat' && tr.delta_pct === null
      ? ''
      : ` · ${tr.direction === 'up' ? '↑' : tr.direction === 'down' ? '↓' : '→'}${tr.delta_pct !== null ? ` ${tr.delta_pct > 0 ? '+' : ''}${tr.delta_pct}%` : ''} vs prior half`;
  const week = s.window.span_ms >= 7 * DAY_MS ? ` · ${s.throughput.per_week}/wk` : '';
  const tpTile = tile('done / window', String(s.throughput.total), `${fmtRate(s.throughput.rolling_avg_per_day)}${week}${trendTxt}`);
  if (tr.direction === 'up') tpTile.classList.add('tile-good');
  else if (tr.direction === 'down') tpTile.classList.add('tile-warn');
  tiles.append(tpTile);
  tiles.append(tile('lead p50', fmtDur(s.timing_summary.lead_ms.p50), `p90 ${fmtDur(s.timing_summary.lead_ms.p90)} · n=${s.timing_summary.lead_ms.n}`));
  tiles.append(tile('cycle p50', fmtDur(s.timing_summary.cycle_ms.p50), `p90 ${fmtDur(s.timing_summary.cycle_ms.p90)} · n=${s.timing_summary.cycle_ms.n}`));
  tiles.append(tile('flow efficiency', pctVal(s.timing_summary.flow_efficiency.p50), `avg ${pctVal(s.timing_summary.flow_efficiency.avg)} · n=${s.timing_summary.flow_efficiency.n}`));
  // Net flow: arrival vs departure, coloured by whether the board is growing.
  const f = s.flow;
  const netTile = tile('net flow', `${f.net_per_day > 0 ? '+' : ''}${fmtRate(f.net_per_day)}`, `${fmtRate(f.arrival_per_day)} in · ${fmtRate(f.departure_per_day)} out · ${f.trend}`);
  if (f.trend === 'growing') netTile.classList.add('tile-warn');
  else if (f.trend === 'shrinking') netTile.classList.add('tile-good');
  tiles.append(netTile);
  // Forecast: time to drain the backlog at current velocity. Hour-precision ETA
  // when the drain is near (< 3 days), else a day figure.
  const fc = s.forecast;
  const etaNear = fc.ms_to_drain !== null && fc.ms_to_drain < 3 * DAY_MS;
  const drainVal = fc.ms_to_drain !== null ? fmtDur(fc.ms_to_drain) : '∞';
  const etaStr = fc.eta ? (etaNear ? `${fc.eta.slice(0, 10)} ${fc.eta.slice(11, 16)} UTC` : fc.eta.slice(0, 10)) : null;
  const drainTile = tile('drain forecast', drainVal, etaStr ? `${fc.remaining} open · eta ${etaStr}` : `${fc.remaining} open · velocity 0`);
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

  // Aging flags — non-Done tasks past the pace-aware stale threshold.
  if (s.aging_flags.length) {
    const rows = s.aging_flags.slice(0, 12).map((a) => [a.id, a.status, fmtDur(a.age_ms)]);
    const paceTag = s.pace && s.pace.basis === 'cycle-time' ? ' (pace)' : '';
    const thresh = s.pace ? fmtDur(s.pace.stale_ms) : '7d';
    grid.append(metricCard(`Aging > ${thresh}${paceTag} (${s.aging_flags.length})`, metricTable(['task', 'status', 'age'], rows)));
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

  // Dwell by status — closed-stint time per column; the slowest active-flow
  // status is flagged as the bottleneck.
  if (s.dwell && s.dwell.some((d) => d.closed.n > 0)) {
    const rows = s.dwell
      .filter((d) => d.closed.n > 0)
      .map((d) => [
        (s.bottleneck && s.bottleneck.status === d.status ? '⚠ ' : '') + d.status,
        fmtDur(d.closed.p50),
        fmtDur(d.closed.p90),
        String(d.closed.n),
      ]);
    const title = s.bottleneck ? `Dwell by status · bottleneck: ${s.bottleneck.status}` : 'Dwell by status';
    grid.append(metricCard(title, metricTable(['status', 'p50', 'p90', 'n'], rows)));
  }

  if (grid.children.length) body.append(grid);

  // --- charts — wider grid tracks so the two time-series sit side by side on a
  //     wide panel and the SVGs fill their cards (no fixed max-width gap). ---
  const charts = el('div', 'metric-charts');
  const bucketMs = s.window.bucket_ms;
  const scale = s.window.clamped && bucketMs < DAY_MS ? `board age ${fmtDur(s.window.span_ms)}` : `window ${s.window.days}d`;
  charts.append(
    metricCard(`Burndown · ${scale} · ${s.window.bucket} buckets`, burndownLegend(), burndownChart(s.burndown, bucketMs)),
  );
  if (s.cfd && s.cfd.length)
    charts.append(metricCard(`Cumulative flow · ${s.window.bucket} buckets`, cfdLegend(), cfdChart(s.cfd, bucketMs)));
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
function cfdChart(cfd, bucketMs) {
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
  const stamp = (i) =>
    bucketMs < DAY_MS && i === 0 ? `${cfd[i].t.slice(5, 10)} ${cfd[i].t.slice(11, 16)}` : fmtTick(cfd[i].t, bucketMs);
  const mid = Math.floor((n - 1) / 2);
  svg.append(tx(stamp(0), padL, H - 4));
  if (mid > 0 && mid < n - 1) svg.append(tx(fmtTick(cfd[mid].t, bucketMs), x(mid), H - 4, 'middle'));
  svg.append(tx(fmtTick(cfd[n - 1].t, bucketMs), W - padR, H - 4, 'end'));
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

// --- dependency graph ---------------------------------------------------------
// Hand-rolled layered DAG layout over /api/ui/graph (no chart library, like the
// burndown/CFD SVGs). Longest-path layering terminates because the server
// rejects dependency cycles; barycenter ordering untangles rows within a layer.

const NODE_W = 130, NODE_H = 34, COL_W = 180, ROW_H = 48, GRAPH_PAD = 12;

function graphLayout(nodes, edges) {
  const shown = new Set();
  for (const e of edges) {
    shown.add(e.from);
    shown.add(e.to);
  }
  const byId = new Map(nodes.filter((n) => shown.has(n.id)).map((n) => [n.id, n]));
  const preds = new Map([...byId.keys()].map((id) => [id, []]));
  for (const e of edges) if (byId.has(e.from) && byId.has(e.to)) preds.get(e.to).push(e.from);

  const layer = new Map();
  const layerOf = (id, seen) => {
    if (layer.has(id)) return layer.get(id);
    if (seen.has(id)) return 0; // cycle guard — belt and braces, server rejects these
    seen.add(id);
    const ps = preds.get(id);
    const l = ps.length ? 1 + Math.max(...ps.map((p) => layerOf(p, seen))) : 0;
    layer.set(id, l);
    return l;
  };
  for (const id of byId.keys()) layerOf(id, new Set());

  const cols = [];
  for (const [id, l] of layer) (cols[l] = cols[l] || []).push(id);
  const row = new Map();
  const bary = (id) => {
    const ps = preds.get(id).filter((p) => row.has(p));
    return ps.length ? ps.reduce((a, p) => a + row.get(p), 0) / ps.length : 0;
  };
  cols.forEach((ids, l) => {
    if (l > 0) ids.sort((a, b) => bary(a) - bary(b));
    ids.forEach((id, i) => row.set(id, i));
  });
  return { byId, layer, row, layers: cols.length };
}

function renderGraph(nodes, edges) {
  const { byId, layer, row, layers } = graphLayout(nodes, edges);
  if (!byId.size) return el('div', 'graph-empty', 'no dependencies on the board');

  const pos = (id) => ({ x: GRAPH_PAD + layer.get(id) * COL_W, y: GRAPH_PAD + row.get(id) * ROW_H });
  const W = GRAPH_PAD * 2 + (layers - 1) * COL_W + NODE_W;
  const H = GRAPH_PAD * 2 + Math.max(...row.values()) * ROW_H + NODE_H;
  const svg = svgEl('svg', { class: 'dep-graph', viewBox: `0 0 ${W} ${H}` });

  const defs = svgEl('defs');
  const marker = svgEl('marker', {
    id: 'dep-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5,
    markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse',
  });
  marker.append(svgEl('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: C.muted }));
  defs.append(marker);
  svg.append(defs);

  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    const a = pos(e.from), b = pos(e.to);
    const x1 = a.x + NODE_W, y1 = a.y + NODE_H / 2, x2 = b.x, y2 = b.y + NODE_H / 2;
    const bend = Math.max(30, (x2 - x1) / 2);
    svg.append(svgEl('path', {
      class: 'graph-edge',
      d: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
      fill: 'none', stroke: C.line, 'stroke-width': 1.5, 'marker-end': 'url(#dep-arrow)',
    }));
  }

  for (const n of byId.values()) {
    const { x, y } = pos(n.id);
    const g = svgEl('g', { class: 'graph-node', transform: `translate(${x},${y})` });
    const color = CFD_COLORS[n.status] || C.line;
    const rect = svgEl('rect', { width: NODE_W, height: NODE_H, rx: 6, fill: color + '22', stroke: color, 'stroke-width': 1.5 });
    if (n.blocked) rect.setAttribute('stroke-dasharray', '4 3');
    const tip = svgEl('title');
    tip.textContent = `${n.id} ${n.title} [${n.status}${n.blocked ? ' · blocked' : ''}]`;
    const idText = svgEl('text', { x: 8, y: 14, 'font-size': 10, fill: color, 'font-weight': 600 });
    idText.textContent = `${n.id} ${n.priority}`;
    const titleText = svgEl('text', { x: 8, y: 27, 'font-size': 10, fill: C.muted });
    titleText.textContent = n.title.length > 20 ? n.title.slice(0, 19) + '…' : n.title;
    g.append(rect, tip, idText, titleText);
    g.addEventListener('click', () => openDrawer(n.id));
    svg.append(g);
  }
  return svg;
}

async function loadGraph() {
  const body = $('#graph-body');
  let g;
  try {
    g = await api('/api/ui/graph');
  } catch (e) {
    body.replaceChildren(el('div', 'metrics-banner', `graph failed: ${e.message}`));
    return;
  }
  body.replaceChildren(renderGraph(g.nodes, g.edges));
}

let graphTimer = null;
const GRAPH_EVENTS = new Set(['dep.added', 'dep.removed', 'task.moved', 'task.created', 'task.archived', 'task.updated', 'reset']);
function scheduleGraph() {
  if (graphTimer || $('#graph-panel').classList.contains('hidden')) return;
  graphTimer = setTimeout(() => {
    graphTimer = null;
    loadGraph();
  }, 300);
}

function toggleGraph() {
  const p = $('#graph-panel');
  p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) loadGraph();
}
$('#graph-btn').addEventListener('click', toggleGraph);
$('#graph-close').addEventListener('click', () => $('#graph-panel').classList.add('hidden'));

// --- activity log -------------------------------------------------------------
// Newest-first page over /api/ui/activity; live events prepend while the panel is
// open (the WS frame IS the event — no refetch). `floor` renders a never-silent
// banner when history is bounded by compaction.
const activity = { oldest: null };

const truncStr = (s, n = 80) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s || '');

/** One human phrase per EventType; falls back to `type + payload` for anything
 *  unmapped so future event types render terse instead of vanishing. */
function fmtEvent(ev) {
  const p = ev.payload || {};
  const M = {
    'task.created': () => `created${p.title ? ` "${truncStr(p.title)}"` : ''}${p.parent_id ? ` (subtask of ${p.parent_id})` : ''}`,
    'task.updated': () => `updated ${(p.fields || []).join(', ')}`,
    'task.moved': () => `moved ${p.from} → ${p.to}`,
    'task.archived': () => 'archived',
    'task.claimed': () => `claimed by ${p.assignee}${p.stolen_from ? ` (stolen from ${p.stolen_from})` : ''}`,
    'task.released': () => `released${p.released_from ? ` (was ${p.released_from})` : ''}`,
    'task.reparented': () => (p.to ? `nested under ${p.to}` : `detached from ${p.from}`),
    'dep.added': () => `now blocked by ${p.to}`,
    'dep.removed': () => `no longer blocked by ${p.to}`,
    'comment.added': () => `comment ${p.id} added`,
    'criterion.added': () => `criterion ${p.id} added`,
    'criterion.checked': () => `criterion ${p.id} checked`,
    'criterion.unchecked': () => `criterion ${p.id} unchecked`,
    'criterion.retired': () => `criterion ${p.id} retired: ${p.reason}`,
    'criterion.amended': () => `criterion ${p.id} amended`,
    'label.added': () => `label +${p.name}`,
    'label.removed': () => `label −${p.name}`,
    'artifact.added': () => `artifact ${p.id} (${p.kind}) attached`,
    'input.requested': () => `asked ${p.request_id}: ${truncStr(p.question)}`,
    'input.answered': () => `${p.request_id} answered: ${truncStr(p.answer)}`,
    'input.cancelled': () => `${p.request_id} cancelled`,
    'input.expired': () => `${p.request_id} expired`,
    'doc.created': () => `doc ${p.doc_id} (${p.kind}) created${p.title ? ` "${truncStr(p.title)}"` : ''}`,
    'doc.updated': () => `doc ${p.doc_id} updated ${(p.fields || []).join(', ')}`,
    'doc.linked': () => `doc ${p.doc_id} linked`,
    'doc.unlinked': () => `doc ${p.doc_id} unlinked`,
    'brainstorm.started': () => `brainstorm ${p.session_id} started: ${truncStr(p.topic)}`,
    'brainstorm.closed': () => `brainstorm ${p.session_id} closed`,
    'idea.added': () => `idea ${p.idea_id} added to ${p.session_id}`,
    'idea.updated': () => `idea ${p.idea_id} ${p.status === 'discarded' ? 'discarded' : `updated ${(p.fields || []).join(', ')}`}`,
    'idea.promoted': () => `idea ${p.idea_id} promoted to a task`,
  };
  const f = M[ev.type];
  return f ? f() : `${ev.type} ${truncStr(JSON.stringify(p))}`;
}

function activityRow(ev) {
  const row = el('div', 'activity-row');
  const t = new Date(ev.ts);
  const hhmm = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  row.append(el('span', 'activity-time', hhmm));
  row.append(el('span', `activity-actor ${ev.actor_type || ''}`, ev.actor_type || ''));
  if (ev.task_id) {
    const link = el('a', 'activity-task', ev.task_id);
    link.href = '#';
    link.addEventListener('click', (e) => {
      e.preventDefault();
      openDrawer(ev.task_id);
    });
    row.append(link);
  }
  row.append(el('span', 'activity-text', fmtEvent(ev)));
  return row;
}

function matchesActivityFilter(ev) {
  const q = $('#activity-filter').value.trim().toLowerCase();
  return !q || (ev.task_id || '').toLowerCase() === q;
}

async function loadActivity({ append = false } = {}) {
  const body = $('#activity-body');
  const params = new URLSearchParams();
  const q = $('#activity-filter').value.trim();
  if (q) params.set('task', q);
  if (append && activity.oldest !== null) params.set('before', String(activity.oldest));
  let r;
  try {
    r = await api(`/api/ui/activity${params.toString() ? `?${params}` : ''}`);
  } catch (e) {
    body.replaceChildren(el('div', 'metrics-banner', `activity failed: ${e.message}`));
    return;
  }
  if (!append) {
    body.replaceChildren();
    activity.oldest = null;
    if (r.floor > 0)
      body.append(el('div', 'metrics-banner', `history starts at seq ${r.floor + 1} — older events compacted`));
    body.append(el('div', 'activity-list'));
    const more = el('button', 'ghost activity-more', 'Load more');
    more.addEventListener('click', () => loadActivity({ append: true }));
    body.append(more);
  }
  const list = body.querySelector('.activity-list');
  for (const ev of r.events) list.append(activityRow(ev));
  if (r.events.length) activity.oldest = r.events[r.events.length - 1].seq;
  else if (!append) list.append(el('div', 'activity-empty', 'no activity yet'));
  // Nothing older to page once we get a short page or reach the floor.
  const more = body.querySelector('.activity-more');
  if (more) more.disabled = !r.events.length || (activity.oldest !== null && activity.oldest <= r.floor + 1);
}

function toggleActivity() {
  const p = $('#activity-panel');
  p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) loadActivity();
}
$('#activity-btn').addEventListener('click', toggleActivity);
$('#activity-close').addEventListener('click', () => $('#activity-panel').classList.add('hidden'));
$('#activity-filter').addEventListener('input', () => {
  if (!$('#activity-panel').classList.contains('hidden')) loadActivity();
});

// --- docs panel ---------------------------------------------------------------
// List over /api/ui/docs (no bodies); clicking a row loads the body from
// GET /api/docs/:id?json and renders it as preformatted markdown text. doc.*
// WS events refresh the list while the panel is open.
async function loadDocs() {
  const body = $('#docs-body');
  let r;
  try {
    r = await api('/api/ui/docs');
  } catch (e) {
    body.replaceChildren(el('div', 'metrics-banner', `docs failed: ${e.message}`));
    return;
  }
  body.replaceChildren();
  const q = $('#docs-filter').value.trim().toLowerCase();
  const docs = q ? r.docs.filter((d) => d.kind === q || d.status === q || d.id.toLowerCase() === q) : r.docs;
  if (!docs.length) {
    body.append(el('div', 'activity-empty', q ? 'no docs match' : 'no docs yet'));
    return;
  }
  const list = el('div', 'activity-list');
  for (const d of docs) list.append(docRow(d));
  body.append(list);
}

function docRow(d) {
  const row = el('div', 'activity-row doc-row');
  row.append(el('span', 'doc-kind', `${d.kind}/${d.status}`));
  const link = el('a', 'activity-task', d.id);
  link.href = '#';
  link.addEventListener('click', (e) => {
    e.preventDefault();
    viewDoc(d.id);
  });
  row.append(link);
  const text = el('span', 'activity-text', d.title + (d.summary ? ` — ${d.summary}` : ''));
  row.append(text);
  for (const t of d.tasks || []) {
    const task = el('a', 'activity-task', t);
    task.href = '#';
    task.addEventListener('click', (e) => {
      e.preventDefault();
      openDrawer(t);
    });
    row.append(task);
  }
  return row;
}

async function viewDoc(id) {
  const body = $('#docs-body');
  let d;
  try {
    d = await api(`/api/docs/${id}?json=1`);
  } catch (e) {
    body.replaceChildren(el('div', 'metrics-banner', `doc failed: ${e.message}`));
    return;
  }
  body.replaceChildren();
  const back = el('button', 'ghost', '← All docs');
  back.addEventListener('click', loadDocs);
  body.append(back);
  const head = el('div', 'doc-head');
  head.append(el('span', 'doc-kind', `${d.kind}/${d.status}`));
  head.append(el('strong', '', ` ${d.id} ${d.title}`));
  body.append(head);
  if (d.summary) body.append(el('p', 'doc-summary', d.summary));
  if (d.tasks?.length) {
    const links = el('div', 'doc-tasks');
    links.append(el('span', '', 'linked: '));
    for (const t of d.tasks) {
      const a = el('a', 'activity-task', t);
      a.href = '#';
      a.addEventListener('click', (e) => {
        e.preventDefault();
        openDrawer(t);
      });
      links.append(a);
    }
    body.append(links);
  }
  body.append(el('pre', 'doc-body', d.body || '(no body)'));
}

function openDocsPanel(docId) {
  $('#docs-panel').classList.remove('hidden');
  if (docId) viewDoc(docId);
  else loadDocs();
}
function toggleDocs() {
  const p = $('#docs-panel');
  p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) loadDocs();
}
$('#docs-btn').addEventListener('click', toggleDocs);
$('#docs-close').addEventListener('click', () => $('#docs-panel').classList.add('hidden'));
$('#docs-filter').addEventListener('input', () => {
  if (!$('#docs-panel').classList.contains('hidden')) loadDocs();
});

// --- brainstorm panel -----------------------------------------------------------
// Session list -> clustered/scored idea view with inline scoring and Promote —
// the human shaping the idea pool is the HITL payoff (like answering inputs).
// brainstorm.*/idea.* WS events refresh whichever view is open.
const brainstormState = { openSession: null };

async function loadBrainstorms() {
  brainstormState.openSession = null;
  const body = $('#brainstorm-body');
  let r;
  try {
    r = await api('/api/brainstorms?json=1');
  } catch (e) {
    body.replaceChildren(el('div', 'metrics-banner', `brainstorms failed: ${e.message}`));
    return;
  }
  body.replaceChildren();
  if (!r.sessions.length) {
    body.append(el('div', 'activity-empty', 'no brainstorms yet — the agent starts one with `kanban brainstorm start`'));
    return;
  }
  const list = el('div', 'activity-list');
  for (const s of r.sessions) {
    const row = el('div', 'activity-row');
    row.append(el('span', 'doc-kind', s.status));
    const link = el('a', 'activity-task', s.id);
    link.href = '#';
    link.addEventListener('click', (e) => {
      e.preventDefault();
      viewBrainstorm(s.id);
    });
    row.append(link);
    row.append(el('span', 'activity-text', s.topic));
    if (s.task_id) {
      const t = el('a', 'activity-task', s.task_id);
      t.href = '#';
      t.addEventListener('click', (e) => {
        e.preventDefault();
        openDrawer(s.task_id);
      });
      row.append(t);
    }
    list.append(row);
  }
  body.append(list);
}

async function viewBrainstorm(id) {
  brainstormState.openSession = id;
  const body = $('#brainstorm-body');
  let s;
  try {
    s = await api(`/api/brainstorms/${id}?json=1`);
  } catch (e) {
    body.replaceChildren(el('div', 'metrics-banner', `brainstorm failed: ${e.message}`));
    return;
  }
  body.replaceChildren();
  const back = el('button', 'ghost', '← All brainstorms');
  back.addEventListener('click', loadBrainstorms);
  body.append(back);
  const head = el('div', 'doc-head');
  head.append(el('span', 'doc-kind', s.status));
  head.append(el('strong', '', ` ${s.id} ${s.topic}`));
  body.append(head);

  const groups = new Map();
  for (const i of s.ideas) {
    const key = i.cluster || '(unclustered)';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(i);
  }
  for (const [cluster, ideas] of groups) {
    body.append(el('h4', '', cluster));
    for (const i of ideas) body.append(ideaRow(i, s));
  }
  if (!s.ideas.length) body.append(el('div', 'activity-empty', 'no ideas yet'));
}

function ideaRow(i, s) {
  const row = el('div', 'idea-row');
  row.append(el('span', 'doc-kind', i.score !== null ? String(i.score) : '–'));
  const text = el('span', 'activity-text', i.text);
  row.append(text);
  if (i.status === 'promoted') {
    const t = el('a', 'activity-task', `→ ${i.promoted_task_id}`);
    t.href = '#';
    t.addEventListener('click', (e) => {
      e.preventDefault();
      openDrawer(i.promoted_task_id);
    });
    row.append(t);
  } else if (i.status === 'discarded') {
    row.append(el('span', 'idea-discarded', '✕ discarded'));
  } else if (s.status === 'open') {
    const score = el('input', 'idea-score');
    score.type = 'number';
    score.min = '0';
    score.max = '10';
    score.value = i.score !== null ? String(i.score) : '';
    score.title = 'score 0–10';
    const submitScore = () => {
      const v = score.value.trim();
      if (v === '') return;
      api(`/api/ideas/${i.id}`, {
        method: 'PATCH',
        headers: userJson,
        body: JSON.stringify({ score: Number(v) }),
      })
        .then(() => viewBrainstorm(s.id))
        .catch((err) => toast(`score failed: ${err.message}`));
    };
    score.addEventListener('change', submitScore);
    score.addEventListener('keydown', (e) => e.key === 'Enter' && submitScore());
    row.append(score);
    const promote = el('button', 'send', 'Promote');
    promote.onclick = () =>
      api(`/api/ideas/${i.id}/promote`, {
        method: 'POST',
        headers: userJson,
        body: JSON.stringify({}),
      })
        .then(() => viewBrainstorm(s.id))
        .catch((err) => toast(`promote failed: ${err.message}`));
    row.append(promote);
    const drop = el('button', 'ghost', '✕');
    drop.title = 'discard idea';
    drop.onclick = () =>
      api(`/api/ideas/${i.id}`, {
        method: 'PATCH',
        headers: userJson,
        body: JSON.stringify({ discard: true }),
      })
        .then(() => viewBrainstorm(s.id))
        .catch((err) => toast(`discard failed: ${err.message}`));
    row.append(drop);
  }
  return row;
}

function toggleBrainstorm() {
  const p = $('#brainstorm-panel');
  p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) loadBrainstorms();
}
$('#brainstorm-btn').addEventListener('click', toggleBrainstorm);
$('#brainstorm-close').addEventListener('click', () => $('#brainstorm-panel').classList.add('hidden'));

// --- search panel -------------------------------------------------------------
// Debounced board-wide search over /api/search?json. Hits link to the drawer
// (tasks/comments) or the docs panel (docs).
let searchTimer = null;

async function runSearch() {
  const body = $('#search-body');
  const q = $('#search-input').value.trim();
  if (!q) {
    body.replaceChildren();
    return;
  }
  let r;
  try {
    r = await api(`/api/search?json=1&q=${encodeURIComponent(q)}`);
  } catch (e) {
    body.replaceChildren(el('div', 'metrics-banner', `search failed: ${e.message}`));
    return;
  }
  body.replaceChildren();
  if (!r.fts) body.append(el('div', 'metrics-banner', 'FTS5 unavailable — plain substring matching'));
  if (!r.results.length) {
    body.append(el('div', 'activity-empty', `no matches for "${q}"`));
    return;
  }
  const list = el('div', 'activity-list');
  for (const hit of r.results) list.append(searchRow(hit));
  body.append(list);
}

function searchRow(hit) {
  const row = el('div', 'activity-row');
  const badge = hit.type === 'doc' ? `doc/${hit.kind}` : hit.type === 'comment' ? 'comment' : `task/${hit.status}`;
  row.append(el('span', 'doc-kind', badge));
  const link = el('a', 'activity-task', hit.id);
  link.href = '#';
  link.addEventListener('click', (e) => {
    e.preventDefault();
    if (hit.type === 'doc') {
      $('#search-panel').classList.add('hidden');
      openDocsPanel(hit.id);
    } else if (hit.task_id) {
      openDrawer(hit.task_id);
    }
  });
  row.append(link);
  row.append(el('span', 'activity-text', `${hit.title ? `"${hit.title}" — ` : ''}${hit.snippet}`));
  return row;
}

function toggleSearch() {
  const p = $('#search-panel');
  p.classList.toggle('hidden');
  if (!p.classList.contains('hidden')) $('#search-input').focus();
}
$('#search-btn').addEventListener('click', toggleSearch);
$('#search-close').addEventListener('click', () => $('#search-panel').classList.add('hidden'));
$('#search-input').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 250);
});
$('#search-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    clearTimeout(searchTimer);
    runSearch();
  }
});

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

// --- archive all Done -------------------------------------------------------
const doneCount = () => [...state.tasksById.values()].filter((t) => t.column === 'Done').length;

// Minimal promise-based confirm reusing the modal-overlay styling. Built and torn
// down on the fly (no markup in index.html); resolves true on confirm/Enter,
// false on cancel/Escape/backdrop.
function confirmDialog(title, message, confirmText = 'Confirm') {
  return new Promise((resolve) => {
    const overlay = el('div', 'modal-overlay');
    const box = el('div', 'modal');
    box.append(el('h2', null, title), el('p', 'confirm-msg', message));
    const actions = el('div', 'modal-actions');
    const cancel = el('button', 'ghost', 'Cancel');
    const ok = el('button', 'send', confirmText);
    actions.append(cancel, ok);
    box.append(actions);
    overlay.append(box);
    const close = (val) => {
      overlay.remove();
      document.removeEventListener('keydown', onKey);
      resolve(val);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') close(false);
      else if (e.key === 'Enter') close(true);
    };
    cancel.onclick = () => close(false);
    ok.onclick = () => close(true);
    overlay.addEventListener('click', (e) => e.target === overlay && close(false));
    document.addEventListener('keydown', onKey);
    document.body.append(overlay);
    ok.focus();
  });
}

async function archiveAllDone() {
  const n = doneCount();
  if (!n) return; // button is disabled in this state; guard anyway
  const ok = await confirmDialog(
    'Archive all Done?',
    `Archive ${n} done task${n === 1 ? '' : 's'}? They leave the board (still recoverable from the board data file).`,
    'Archive all',
  );
  if (!ok) return;
  api('/api/tasks/archive-done', { method: 'POST', headers: userJson })
    .then((res) => {
      const skipped = res.skipped?.length || 0;
      toast(`archived ${res.archived}${skipped ? `, skipped ${skipped} (have subtasks)` : ''}`);
      // Cards leave the board via the realtime task.archived stream (removeCard).
    })
    .catch((e) => toast(`archive all failed: ${e.message}`));
}

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
    if (!$('#activity-panel').classList.contains('hidden')) loadActivity();
    return void refresh();
  }
  if (ev.seq) lastSeq = Math.max(lastSeq, ev.seq);
  if (ev.type === 'input.requested') notify(ev);

  // Live-prepend into the open activity panel — the WS frame IS the event.
  if (ev.seq && !$('#activity-panel').classList.contains('hidden') && matchesActivityFilter(ev)) {
    const list = document.querySelector('#activity-panel .activity-list');
    if (list) list.prepend(activityRow(ev));
  }

  // Docs panel stays current while open; a doc list is cheap to re-pull.
  if (ev.type.startsWith('doc.') && !$('#docs-panel').classList.contains('hidden')) loadDocs();
  // Brainstorm panel: refresh whichever view is open (list or a session).
  if (
    (ev.type.startsWith('brainstorm.') || ev.type.startsWith('idea.')) &&
    !$('#brainstorm-panel').classList.contains('hidden')
  ) {
    if (brainstormState.openSession) viewBrainstorm(brainstormState.openSession);
    else loadBrainstorms();
  }

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
  ws.onopen = () => setConn('live', 'live', 'circle', 'solid');
  ws.onclose = () => {
    setConn('reconnecting…', 'reconnecting', 'circle', 'regular');
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
    if (GRAPH_EVENTS.has(ev.type)) scheduleGraph(); // and the graph panel
  };
}

// Reflect connection state in both the label text and a color class (live/reconnecting/error).
function setConn(label, state, iconName = 'circle', style = 'solid') {
  const c = $('#conn');
  c.className = `conn ${state}`;
  c.replaceChildren(icon(iconName, style), ' ' + label);
}

refresh()
  .then(connectWs)
  .catch((e) => setConn(`error: ${e.message} (token?)`, 'error', 'triangle-exclamation', 'solid'));
