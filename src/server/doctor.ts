import type { Repo } from './repo';
import { childProgress, countCriteria } from './derive';
import { boardPace } from './stats';
import { fmtDur } from './render';
import type { Task } from '../shared/types';

// Hygiene thresholds. Not flags: doctor is a report, not a policy engine — a
// finding is a prompt to look. The claim/question thresholds are fixed because
// they measure *human* latency (a lease left dead, a question the human missed),
// which board tempo doesn't change. The aging-WIP threshold, in contrast, is
// derived from the board's own completion pace (boardPace) so a fast agent board
// doesn't wait a human week to flag stuck work — still deterministic from board
// state, and every finding prints the threshold it used (never-silent).
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;
/** An untouched claim (no lease) older than this smells abandoned. */
const STALE_CLAIM_MS = 24 * HOUR_MS;
/** An open question this old has probably been missed by the human. */
const ANCIENT_ASK_MS = 48 * HOUR_MS;
/**
 * A watch is *supposed* to sit open — it is waiting for an event, not for the
 * human — so it is aged against a far longer threshold than a question, and
 * never by `ancient-ask`. Two weeks says "is this trigger still a thing?", not
 * "someone has failed to answer you".
 */
const STALE_WATCH_MS = 14 * DAY_MS;

export interface DoctorFinding {
  /** Stable check key — see CHECKS. */
  check: string;
  /** The task (T-n) or request (Q-n) the finding is about. */
  id: string;
  detail: string;
  /**
   * What this check *cannot* see — required, not optional.
   *
   * Every finding pre-writes a command, and a reader handed a pre-written
   * command is inclined to run it. `done-eligible-parent` counts subtasks and is
   * blind to the parent's own criteria; phrased as a bare imperative it nearly
   * talked a session into closing a task whose playtest had not happened. A
   * check that can be locally right and globally wrong has to say which, so the
   * reader knows what to verify before complying — and the command in `detail`
   * is phrased conditionally to match.
   */
  blind_spot: string;
}

export interface DoctorReport {
  healthy: boolean;
  findings: DoctorFinding[];
  /** Every check that ran (fixed set), for the "n checks clean" line. */
  checks: string[];
}

export const CHECKS = [
  'stale-claim',
  'wip-no-criteria',
  'aging-wip',
  'ancient-ask',
  'stale-watch',
  'answered-elsewhere',
  'stale-summary',
  'done-eligible-parent',
] as const;

const age = (iso: string, nowMs: number): number => nowMs - new Date(iso).getTime();
const days = (ms: number): string => `${Math.floor(ms / DAY_MS)}d`;
const hours = (ms: number): string => (ms >= DAY_MS ? days(ms) : `${Math.floor(ms / HOUR_MS)}h`);

/**
 * One read-only hygiene sweep over the live board. Exit-code contract (CLI):
 * `0` healthy, `2` findings — so a session-start hook can branch on it the same
 * way `await` signals pending. Never mutates; every finding names its fix *and*
 * what its own check cannot see (see DoctorFinding.blind_spot).
 */
export function runDoctor(repo: Repo, nowMs: number = Date.now()): DoctorReport {
  const findings: DoctorFinding[] = [];
  // Pace-aware aging threshold — the same one stats/standup use (single source).
  const pace = boardPace(repo, nowMs);
  const paceTag = pace.basis === 'cycle-time' ? ', pace-based' : '';
  const tasks = repo.listTasks({});
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const active = (t: Task) => t.status === 'Ready' || t.status === 'In Progress' || t.status === 'Review';

  for (const t of tasks) {
    // 1. stale claims: a dead lease the sweep will clear anyway is still worth
    //    surfacing (the sweep may be down — e.g. reading a board with no server),
    //    and an indefinite claim untouched for a day has no auto-recovery at all.
    if (t.assignee && t.status !== 'Done') {
      if (t.claim_expires_at && new Date(t.claim_expires_at).getTime() <= nowMs) {
        findings.push({
          check: 'stale-claim',
          id: t.id,
          detail: `lease of ${t.assignee} expired ${hours(age(t.claim_expires_at, nowMs))} ago — sweep will release, or take over: kanban claim ${t.id}`,
          blind_spot:
            'an expired lease is a missed renewal, not a stopped agent — the holder may still be mid-task',
        });
      } else if (!t.claim_expires_at && age(t.updated_at, nowMs) > STALE_CLAIM_MS) {
        findings.push({
          check: 'stale-claim',
          id: t.id,
          detail: `claimed by ${t.assignee}, untouched ${hours(age(t.updated_at, nowMs))} — release --force only if it really is abandoned`,
          blind_spot:
            'updated_at moves on board writes only, so work done without touching the board looks identical to abandonment',
        });
      }
    }

    // 2. In Progress without acceptance criteria — no definition of done. A task
    //    whose only criteria are retired has none: retirement means they turned
    //    out to be wrong, not that they were met.
    if (t.status === 'In Progress' && countCriteria(repo.getCriteria(t.id)).total === 0) {
      findings.push({
        check: 'wip-no-criteria',
        id: t.id,
        detail: `In Progress with no acceptance criteria — unless the definition of done is already written down: kanban criterion add ${t.id} "…"`,
        blind_spot:
          'reads the criteria table only — a definition of done living in the description or a linked doc is invisible to it',
      });
    }

    // 3. aging WIP: active-column tasks nobody has touched past the (pace-aware)
    //    stale threshold.
    if (active(t) && age(t.updated_at, nowMs) > pace.stale_ms) {
      findings.push({
        check: 'aging-wip',
        id: t.id,
        detail: `${t.status}, untouched ${fmtDur(age(t.updated_at, nowMs))} (threshold ${fmtDur(pace.stale_ms)}${paceTag}) — still real? move it or archive it`,
        blind_spot:
          'measures time since the last board write, not since the last work — long real work that never writes ages exactly like abandoned work',
      });
    }

    // 5. stale summary: description edited after the summary was written.
    if (
      t.summary_updated_at &&
      t.description_updated_at &&
      t.description_updated_at > t.summary_updated_at
    ) {
      findings.push({
        check: 'stale-summary',
        id: t.id,
        detail: `description changed after the summary — re-summarize if the change touched what the summary claims: kanban summarize ${t.id} "…"`,
        blind_spot:
          'compares two timestamps and has read neither text — a typo fix and a rewrite look the same from here',
      });
    }

    // 6. Done-eligible parent: every child Done but the parent still open. The
    //    rollup says "closable"; the parent's own criteria may flatly disagree,
    //    so count them and state the conflict rather than the half of it this
    //    check happens to measure.
    if (t.status !== 'Done') {
      const kids = childProgress(repo.db, t.id);
      if (kids.total > 0 && kids.done === kids.total) {
        // Retired criteria are excluded from both sides — they are not work.
        const own = repo.getCriteria(t.id);
        const n = countCriteria(own);
        const openOwn = n.total - n.done;
        const whose = n.human_open ? ` (${n.human_open} of them only the human can settle)` : '';
        const conflict =
          openOwn > 0 ? `, but ${openOwn} of its own ${n.total} criteria unchecked${whose}` : '';
        findings.push({
          check: 'done-eligible-parent',
          id: t.id,
          detail: `all ${kids.total} subtask(s) Done${conflict} — close only if those are met or retired: kanban done ${t.id}`,
          blind_spot:
            'rolls up subtask status only — it cannot judge whether a criterion is met, nor whether an unchecked one is outstanding work, wrong (retire it) or waiting on the human',
        });
      }
    }
  }

  for (const q of repo.getOpenRequests()) {
    const watch = q.kind === 'watch';

    // 4. ancient open questions — the human likely never saw them. Questions
    //    only: every remedy on this line is wrong for a watch (he knows; re-asking
    //    resets a clock and changes no fact; cancelling throws the trigger away),
    //    and offering them anyway is what kept a watch looking like a failure.
    if (!watch && age(q.created_at, nowMs) > ANCIENT_ASK_MS) {
      findings.push({
        check: 'ancient-ask',
        id: q.id,
        detail: `open ${days(age(q.created_at, nowMs))} on ${q.task_id}: "${q.question}" — nudge the human, re-ask, or cancel`,
        blind_spot: `cannot see the chat — if the human already answered there, none of those three is the fix: kanban answer ${q.id} "…"`,
      });
    }

    // 8. a watch that has been waiting a very long time. Not "unanswered" — a
    //    watch is meant to be open — just old enough to be worth confirming the
    //    trigger still matters.
    if (watch && age(q.created_at, nowMs) > STALE_WATCH_MS) {
      findings.push({
        check: 'stale-watch',
        id: q.id,
        detail: `watching ${days(age(q.created_at, nowMs))} on ${q.task_id}: "${q.question}" (threshold ${days(STALE_WATCH_MS)}) — still worth waiting for? resolve it or cancel the trigger`,
        blind_spot:
          'cannot see whether the event happened — a watch resolves only when someone tells the board, so a long wait is not evidence of anything being wrong',
      });
    }

    // 7. answered elsewhere: an open request on a task that has moved on. Nearly
    //    always an answer that arrived in conversation and was acted on but never
    //    written back, which leaves finished work reading as still waiting on the
    //    human — and leaves the durable record and the thing acted on as two
    //    different objects.
    //    Questions only: a watch on a finished task is covered by stale-watch,
    //    and "the answer arrived in chat" is not a thing that happens to a watch.
    const owner = byId.get(q.task_id);
    if (!watch && owner && (owner.status === 'Done' || owner.status === 'Review')) {
      findings.push({
        check: 'answered-elsewhere',
        id: q.id,
        detail: `open on ${q.task_id}, which is ${owner.status}: "${q.question}" — if it was answered in chat, write it back: kanban answer ${q.id} "…"`,
        blind_spot:
          owner.status === 'Review'
            ? 'Review plus an open ask is also the documented sign-off gate — this check cannot tell that from a question the board never got the answer to'
            : 'cannot see where the answer went; if the decision was never actually made, cancel it rather than inventing one',
      });
    }
  }

  return { healthy: findings.length === 0, findings, checks: [...CHECKS] };
}
