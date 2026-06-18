import type { Repo } from './repo';
import { deriveState, remainingBlockerCount } from './derive';
import type { Task } from '../shared/types';

export interface Recommendation {
  task: Task;
  why: string;
}

export interface BlockedSummary {
  none: true;
  blocked: { id: string; reason: string }[];
}

/**
 * The `next` engine. Considers only `ready` tasks, ranks by
 * priority desc -> created_at asc -> fewest remaining blocker deps, with a
 * sticky bias toward the most-recently-touched ready task so focus doesn't
 * thrash between equal-rank tasks. See docs/03-token-efficiency.md §6.
 */
export function recommend(repo: Repo, n = 1): Recommendation[] | BlockedSummary {
  const all = repo.listTasks({});
  const ready = all.filter((t) => deriveState(repo.db, t).ready);

  if (ready.length === 0) {
    const blocked = all
      .filter((t) => t.status === 'Ready' || t.status === 'In Progress')
      .map((t) => {
        const d = deriveState(repo.db, t);
        const reason = d.needs_input
          ? 'needs input'
          : d.blocked_by_deps
            ? `waits on ${repo.getBlockers(t.id).filter((b) => b.status !== 'Done').map((b) => b.id).join(', ')}`
            : 'not actionable';
        return { id: t.id, reason };
      });
    return { none: true, blocked };
  }

  const mostRecent = [...ready].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];

  const ranked = [...ready].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority.localeCompare(b.priority); // P0 < P1 ...
    if (a.created_at !== b.created_at) return a.created_at.localeCompare(b.created_at);
    return (
      remainingBlockerCount(repo.db, a.id) -
      remainingBlockerCount(repo.db, b.id)
    );
  });

  // Sticky bias: float the recently-touched ready task to the front.
  ranked.sort((a, b) => (a.id === mostRecent.id ? -1 : b.id === mostRecent.id ? 1 : 0));

  return ranked.slice(0, n).map((task, i) => ({
    task,
    why:
      task.id === mostRecent.id && i === 0
        ? 'highest-ranked ready task; you touched it last'
        : 'highest-ranked ready task',
  }));
}
