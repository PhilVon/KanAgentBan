import type { Repo } from './repo';
import { childProgress } from './derive';
import type { Task } from '../shared/types';

// Hygiene thresholds. Deliberately fixed (not flags): doctor is a report, not a
// policy engine — a finding is a prompt to look, and stable thresholds keep its
// exit semantics predictable for the session-start skill hook.
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;
/** An untouched claim (no lease) older than this smells abandoned. */
const STALE_CLAIM_MS = 24 * HOUR_MS;
/** Active-column tasks untouched this long are aging WIP. */
const AGING_WIP_MS = 7 * DAY_MS;
/** An open question this old has probably been missed by the human. */
const ANCIENT_ASK_MS = 48 * HOUR_MS;

export interface DoctorFinding {
  /** Stable check key — see CHECKS. */
  check: string;
  /** The task (T-n) or request (Q-n) the finding is about. */
  id: string;
  detail: string;
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
  'stale-summary',
  'done-eligible-parent',
] as const;

const age = (iso: string, nowMs: number): number => nowMs - new Date(iso).getTime();
const days = (ms: number): string => `${Math.floor(ms / DAY_MS)}d`;
const hours = (ms: number): string => (ms >= DAY_MS ? days(ms) : `${Math.floor(ms / HOUR_MS)}h`);

/**
 * One read-only hygiene sweep over the live board. Exit-code contract (CLI):
 * `0` healthy, `2` findings — so a session-start hook can branch on it the same
 * way `await` signals pending. Never mutates; every finding names its fix.
 */
export function runDoctor(repo: Repo, nowMs: number = Date.now()): DoctorReport {
  const findings: DoctorFinding[] = [];
  const tasks = repo.listTasks({});
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
        });
      } else if (!t.claim_expires_at && age(t.updated_at, nowMs) > STALE_CLAIM_MS) {
        findings.push({
          check: 'stale-claim',
          id: t.id,
          detail: `claimed by ${t.assignee}, untouched ${hours(age(t.updated_at, nowMs))} — release --force if abandoned`,
        });
      }
    }

    // 2. In Progress without acceptance criteria — no definition of done.
    if (t.status === 'In Progress' && repo.getCriteria(t.id).length === 0) {
      findings.push({
        check: 'wip-no-criteria',
        id: t.id,
        detail: `In Progress with no acceptance criteria — kanban criterion add ${t.id} "…"`,
      });
    }

    // 3. aging WIP: active-column tasks nobody has touched in a week.
    if (active(t) && age(t.updated_at, nowMs) > AGING_WIP_MS) {
      findings.push({
        check: 'aging-wip',
        id: t.id,
        detail: `${t.status}, untouched ${days(age(t.updated_at, nowMs))} — still real? move it or archive it`,
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
        detail: `description changed after the summary — kanban summarize ${t.id} "…"`,
      });
    }

    // 6. Done-eligible parent: every child Done but the parent still open.
    if (t.status !== 'Done') {
      const kids = childProgress(repo.db, t.id);
      if (kids.total > 0 && kids.done === kids.total) {
        findings.push({
          check: 'done-eligible-parent',
          id: t.id,
          detail: `all ${kids.total} subtask(s) Done — close it: kanban done ${t.id}`,
        });
      }
    }
  }

  // 4. ancient open questions — the human likely never saw them.
  for (const q of repo.getOpenRequests()) {
    if (age(q.created_at, nowMs) > ANCIENT_ASK_MS) {
      findings.push({
        check: 'ancient-ask',
        id: q.id,
        detail: `open ${days(age(q.created_at, nowMs))} on ${q.task_id}: "${q.question}" — nudge the human, re-ask, or cancel`,
      });
    }
  }

  return { healthy: findings.length === 0, findings, checks: [...CHECKS] };
}
