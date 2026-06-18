import { spawn } from 'node:child_process';
import type { BoardEvent, NudgeConfig } from '../shared/types';
import type { Repo } from './repo';

/**
 * External-nudge auto-resume (docs/04-human-in-the-loop §3C, docs/adr/0006).
 *
 * Subscribes to the in-process event bus and, on `input.answered`, fires up to
 * two opt-in transports so a wrapper can re-invoke the agent instead of waiting
 * for the next manual `kanban inbox`:
 *   - a webhook POST of the answered event, and/or
 *   - a local command (event fields exposed as KANBAN_* env vars).
 *
 * Both are fire-and-forget: a failing nudge is logged but never propagated, so it
 * can't break answering or crash the server. Returns a detach function.
 */
const WEBHOOK_TIMEOUT_MS = 5000;

export function attachNudge(repo: Repo, cfg: NudgeConfig, root: string): () => void {
  // Nothing configured → stay completely inert (don't even subscribe).
  if (!cfg.url && !cfg.cmd) return () => {};

  const onEvent = (ev: BoardEvent) => {
    if (ev.type !== 'input.answered') return;
    if (cfg.url) fireWebhook(cfg, root, ev);
    if (cfg.cmd) fireCommand(cfg.cmd, root, ev);
  };
  repo.bus.on('event', onEvent);
  return () => repo.bus.off('event', onEvent);
}

function fireWebhook(cfg: NudgeConfig, root: string, ev: BoardEvent): void {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), WEBHOOK_TIMEOUT_MS);
  // Body reuses the WebSocket frame shape (docs/07) plus board context.
  void fetch(cfg.url!, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(cfg.headers ?? {}) },
    body: JSON.stringify({ board_root: root, ...ev }),
    signal: ac.signal,
  })
    .catch((e) => console.warn(`nudge webhook failed: ${e instanceof Error ? e.message : e}`))
    .finally(() => clearTimeout(timer));
}

function fireCommand(cmd: string, root: string, ev: BoardEvent): void {
  const payload = ev.payload as { request_id?: string; answer?: string };
  try {
    const child = spawn(cmd, {
      shell: true,
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        KANBAN_EVENT_TYPE: ev.type,
        KANBAN_TASK_ID: ev.task_id ?? '',
        KANBAN_REQUEST_ID: payload.request_id ?? '',
        KANBAN_ANSWER: payload.answer ?? '',
        KANBAN_BOARD_ROOT: root,
      },
    });
    child.on('error', (e) => console.warn(`nudge command failed: ${e.message}`));
    child.unref();
  } catch (e) {
    console.warn(`nudge command failed: ${e instanceof Error ? e.message : e}`);
  }
}
