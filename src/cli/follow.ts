// Streaming follow for `kanban changes --follow` / `kanban watch <id> --follow`.
// A thin WebSocket client of the server's /ws stream (the same subscribe-then-
// replay contract the web UI uses): no server changes, no polling. Kept out of
// kanban.ts, which parses argv at import time and therefore can't be imported
// from tests.
import WebSocket from 'ws';
import { api, type Conn } from './board';

export interface FollowHandle {
  close(): void;
}

export interface FollowOpts {
  /** Called before each reconnect attempt (the CLI prints a stderr note). */
  onRetry?: () => void;
  /** Reconnect delay in ms (default 1000; tests shrink it). */
  retryMs?: number;
}

/**
 * Stream every board event since `since`. Frames are forwarded verbatim —
 * including `reset` frames (never silent: a compacted-away cursor surfaces as
 * `{type:'reset', floor, cursor}` and the stream continues past the floor).
 * Reconnects from the last-seen seq on socket close, so a server restart
 * resumes with no gap; replayed duplicates are dropped by seq.
 */
export function followChanges(
  conn: Conn,
  since: number,
  onEvent: (ev: any) => void,
  opts: FollowOpts = {},
): FollowHandle {
  let cursor = since;
  let closed = false;
  let ws: WebSocket | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;

  const scheduleReopen = () => {
    if (closed || retry) return;
    retry = setTimeout(() => {
      retry = null;
      opts.onRetry?.();
      open();
    }, opts.retryMs ?? 1000);
  };

  const open = () => {
    if (closed) return;
    ws = new WebSocket(`${conn.base.replace(/^http/, 'ws')}/ws?since=${cursor}&token=${conn.token}`);
    ws.on('message', (data) => {
      let ev: any;
      try {
        ev = JSON.parse(String(data));
      } catch {
        return;
      }
      if (ev.type === 'reset') {
        cursor = Math.max(cursor, ev.cursor ?? ev.floor ?? 0);
      } else if (typeof ev.seq === 'number') {
        if (ev.seq <= cursor) return; // reconnect-replay dedupe
        cursor = ev.seq;
      }
      onEvent(ev);
    });
    ws.on('close', scheduleReopen);
    ws.on('error', () => {
      /* the close event follows and drives the retry */
    });
  };

  open();
  return {
    close() {
      closed = true;
      if (retry) clearTimeout(retry);
      try {
        ws?.close();
      } catch {
        /* already gone */
      }
    },
  };
}

/**
 * Stream events scoped like `repo.watch`: the task plus its direct blockers and
 * dependents. The related set is seeded from the task detail and refreshed when
 * a dep edge touching the task changes; `reset` frames always pass through.
 */
export function followTask(
  conn: Conn,
  id: string,
  since: number,
  onEvent: (ev: any) => void,
  opts: FollowOpts = {},
): FollowHandle {
  let related = new Set<string>([id]);
  const refreshRelated = async () => {
    try {
      const d = await api(conn, 'GET', `/api/ui/tasks/${id}`);
      const next = new Set<string>([id]);
      for (const b of d.blockers ?? []) next.add(b.id);
      for (const b of d.blocked_by ?? []) next.add(b.id);
      related = next;
    } catch {
      /* keep the previous set; a later dep event will retry */
    }
  };
  void refreshRelated();

  return followChanges(
    conn,
    since,
    (ev) => {
      if (ev.type === 'reset') {
        onEvent(ev);
        void refreshRelated();
        return;
      }
      const depEdge = ev.type === 'dep.added' || ev.type === 'dep.removed';
      const touchesId = ev.task_id === id || (depEdge && ev.payload?.to === id);
      if (depEdge && touchesId) void refreshRelated();
      if (touchesId || (ev.task_id && related.has(ev.task_id))) onEvent(ev);
    },
    opts,
  );
}
