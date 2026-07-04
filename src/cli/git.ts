// Git/gh execution for `kanban git …` — ALL of it lives CLI-side, in the user's
// working directory; the server never shells out (ADR 0008). execSync with a
// shell (not execFileSync) so the Windows `git`/`gh` shims resolve.
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** Matches task-id mentions (T-12) in commit subjects and branch names. */
export const TASK_ID_RE = /\bT-\d+\b/g;

export interface CommitMention {
  sha: string;
  subject: string;
  ids: string[];
}

export interface BranchMention {
  name: string;
  ids: string[];
  current: boolean;
}

function run(cmd: string, cwd?: string): string {
  return execSync(cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export function inGitRepo(cwd?: string): boolean {
  try {
    return run('git rev-parse --is-inside-work-tree', cwd) === 'true';
  } catch {
    return false;
  }
}

/** Extract unique task-id mentions from a string (pure — unit-testable). */
export function taskIdsIn(text: string): string[] {
  return [...new Set(text.match(TASK_ID_RE) ?? [])];
}

/** Parse `git log --pretty=format:%H%x09%s` output into commit mentions. */
export function parseLogMentions(log: string): CommitMention[] {
  const out: CommitMention[] = [];
  for (const line of log.split('\n')) {
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    const sha = line.slice(0, tab);
    const subject = line.slice(tab + 1);
    const ids = taskIdsIn(subject);
    if (ids.length) out.push({ sha, subject, ids });
  }
  return out;
}

/** Commits (recent `depth`) whose subject mentions a task id. */
export function scanCommits(cwd?: string, depth = 500): CommitMention[] {
  const log = run(`git log --pretty=format:%H%x09%s -n ${depth | 0}`, cwd);
  return parseLogMentions(log);
}

/** Local branches whose name mentions a task id. */
export function scanBranches(cwd?: string): BranchMention[] {
  const current = currentBranch(cwd);
  const names = run('git branch --list --format=%(refname:short)', cwd)
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  return names
    .map((name) => ({ name, ids: taskIdsIn(name), current: name === current }))
    .filter((b) => b.ids.length > 0);
}

export function currentBranch(cwd?: string): string | null {
  try {
    const b = run('git rev-parse --abbrev-ref HEAD', cwd);
    return b === 'HEAD' ? null : b; // detached
  } catch {
    return null;
  }
}

/** `T-12` + "Wire up OAuth callback" -> `T-12-wire-up-oauth-callback`. */
export function branchNameFor(taskId: string, title: string, maxSlug = 40): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxSlug)
    .replace(/-+$/, '');
  return slug ? `${taskId}-${slug}` : taskId;
}

/** PR state via `gh` for a branch; null when gh is absent or there is no PR. */
export function prStatus(
  branch: string,
  cwd?: string,
): { state: string; url: string; checks: string } | null {
  try {
    const raw = run(`gh pr view ${branch} --json state,url,statusCheckRollup`, cwd);
    const p = JSON.parse(raw);
    const rollup: any[] = p.statusCheckRollup ?? [];
    const bad = rollup.filter((c) => ['FAILURE', 'ERROR'].includes(c.conclusion)).length;
    const pending = rollup.filter((c) => !c.conclusion || c.conclusion === '').length;
    const checks = !rollup.length
      ? 'no checks'
      : bad
        ? `${bad} failing`
        : pending
          ? `${pending} pending`
          : 'checks green';
    return { state: p.state, url: p.url, checks };
  } catch {
    return null; // no gh, no PR, or not a GitHub remote — degrade silently
  }
}

// ---- hooks ----------------------------------------------------------------

/** sh source for .git/hooks/prepare-commit-msg: append `[T-n]` from the branch
 *  name when the message doesn't already mention it. */
export function prepareCommitMsgHook(): string {
  return `#!/bin/sh
# kanban: append the branch's task id ([T-n]) to the commit message.
MSG_FILE="$1"
BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
ID=$(printf '%s' "$BRANCH" | grep -oE 'T-[0-9]+' | head -1)
[ -z "$ID" ] && exit 0
grep -qE "\\b$ID\\b" "$MSG_FILE" || printf '\\n[%s]\\n' "$ID" >> "$MSG_FILE"
exit 0
`;
}

/** sh source for .git/hooks/post-commit: fire-and-forget `kanban git link` so a
 *  down server (or missing CLI) never blocks a commit. */
export function postCommitHook(): string {
  return `#!/bin/sh
# kanban: record this commit on any task it mentions (fire-and-forget).
(kanban git link >/dev/null 2>&1 &) 2>/dev/null || true
exit 0
`;
}

/** Write both hooks; refuses to clobber a non-kanban hook unless `force`. */
export function installHooks(cwd: string, force = false): string[] {
  const gitDir = run('git rev-parse --git-dir', cwd);
  const hooksDir = path.resolve(cwd, gitDir, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  const hooks: Array<[string, string]> = [
    ['prepare-commit-msg', prepareCommitMsgHook()],
    ['post-commit', postCommitHook()],
  ];
  const written: string[] = [];
  for (const [name, body] of hooks) {
    const file = path.join(hooksDir, name);
    if (fs.existsSync(file) && !force) {
      const existing = fs.readFileSync(file, 'utf8');
      if (!existing.includes('kanban:')) {
        throw new Error(`${name} already exists and isn't kanban's — re-run with --force to overwrite`);
      }
    }
    fs.writeFileSync(file, body, { mode: 0o755 });
    written.push(name);
  }
  return written;
}

export function createBranch(name: string, checkout: boolean, cwd?: string): void {
  run(checkout ? `git checkout -b ${name}` : `git branch ${name}`, cwd);
}
