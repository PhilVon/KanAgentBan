// CLI-side plaintext formatters. Kept out of kanban.ts (which runs the command
// parser on import) so they stay pure and unit-testable.
import type { InputRequest } from '../shared/types';

export interface InboxView {
  open?: InputRequest[];
  answered?: InputRequest[];
  cursor: number;
  /** Set when the `--since` cursor predated the compaction floor (docs/11 §2). */
  reset?: boolean;
  floor?: number;
}

/**
 * Terse, one-line-per-request rendering for `kanban inbox` — the resume entry
 * point. Answered requests come first (the actual resume signal), then the
 * still-open ones. Matches the plaintext-default contract every other read
 * command honours; `--json` opts back into the raw payload.
 * See docs/04-human-in-the-loop.md (canonical flow) and docs/05-cli-reference.md.
 */
export function renderInbox(v: InboxView): string {
  // Never-silent reset: the cursor predated the compaction floor, so the answered
  // delta can't be computed gap-free. Reseed from current state (docs/11 §2, 03).
  if (v.reset) {
    return `# log compacted below seq ${v.floor}; cursor too old — reseed: kanban inbox (no --since) / kanban next`;
  }
  const lines: string[] = [];
  for (const q of v.answered ?? []) {
    lines.push(`${q.id}  answered: ${q.answer ?? ''}   (task ${q.task_id})`);
  }
  for (const q of v.open ?? []) {
    lines.push(`${q.id}  open: ${q.question}   (task ${q.task_id})`);
  }
  return lines.length ? lines.join('\n') : 'inbox empty — no open or answered requests';
}
