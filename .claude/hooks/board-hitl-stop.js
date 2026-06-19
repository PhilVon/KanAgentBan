#!/usr/bin/env node
// Stop hook: redirect chat-only human-decision questions onto the board.
//
// Fires when Claude finishes a turn. If the agent is working a board task
// (something In Progress) and ended its reply with a question to the human but
// did NOT raise a durable `kanban ask`, this nudges it to use the board so the
// question survives the session boundary. Otherwise it stays silent.
//
// Contract (Claude Code Stop hook):
//   stdin  : { session_id, transcript_path, cwd, stop_hook_active, ... }
//   block  : print {"decision":"block","reason":"..."} to stdout, exit 0
//   allow  : print nothing, exit 0
// Fail-open everywhere: any error → allow the stop (never wedge the user).

'use strict';
const fs = require('fs');
const { execSync } = require('child_process');

function allow() { process.exit(0); }

function readStdin() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); }
  catch { return {}; }
}

// Last assistant text block in the transcript JSONL.
function lastAssistantText(transcriptPath) {
  let lines;
  try { lines = fs.readFileSync(transcriptPath, 'utf8').split('\n'); }
  catch { return ''; }
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i].trim();
    if (!raw) continue;
    let ev;
    try { ev = JSON.parse(raw); } catch { continue; }
    const msg = ev && ev.message;
    if (!msg || msg.role !== 'assistant') continue;
    const content = msg.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const text = content
        .filter((p) => p && p.type === 'text' && typeof p.text === 'string')
        .map((p) => p.text)
        .join('\n')
        .trim();
      if (text) return text;
    }
  }
  return '';
}

// Heuristic: does the reply end by asking the human something?
function endsWithQuestion(text) {
  if (!text) return false;
  // Ignore a trailing fenced code block, then look at the final non-empty line.
  const stripped = text.replace(/```[\s\S]*?```\s*$/g, '').trim();
  const lastLine = stripped.split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';
  return lastLine.endsWith('?');
}

function kanbanJson(cwd, args) {
  // `kanban` is a shim (.cmd on Windows) — invoke through a shell. Quote any arg
  // that isn't a bare token so values like "In Progress" stay one argument.
  const cmd =
    'kanban ' +
    args.map((a) => (/^[\w.\-/]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`)).join(' ');
  const out = execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return JSON.parse(out);
}

function main() {
  const input = readStdin();

  // Never recurse: if we already blocked once this turn, let it stop.
  if (input.stop_hook_active) allow();

  const cwd = input.cwd || process.cwd();

  const text = lastAssistantText(input.transcript_path || '');
  if (!endsWithQuestion(text)) allow();

  // Gate 1 — only nag during active board work.
  let active = [];
  try { active = (kanbanJson(cwd, ['list', '--status', 'In Progress', '--json']) || {}).tasks || []; }
  catch { allow(); } // no board / CLI here → not our business
  if (active.length === 0) allow();

  // Gate 2 — if the agent already raised a question, it did the right thing.
  try {
    const open = (kanbanJson(cwd, ['inbox', '--json']) || {}).open || [];
    if (open.length > 0) allow();
  } catch { /* inbox unavailable → fall through and still nudge */ }

  const ids = active.map((t) => t.id).join(', ');
  const reason =
    'You appear to be asking the human a question in chat while working the board ' +
    `(In Progress: ${ids}). A chat-only question is lost at the session boundary. ` +
    'Raise it durably instead: `kanban ask <task-id> "<question>" [--options a,b]`, ' +
    'then `kanban await --timeout 60` (or yield and resume from `kanban inbox`). ' +
    'If this was not a question for the human, end the turn again and this will pass.';

  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(0);
}

try { main(); } catch { allow(); }
