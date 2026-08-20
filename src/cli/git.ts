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
  /** Languages this commit's files belong to, commonest first. Empty when the
   *  commit touched nothing in LANG_BY_EXT (or is a merge, which lists no files). */
  langs: string[];
}

/**
 * Extension -> language name. A **fixed, closed table**, and deliberately not a
 * slug of the extension.
 *
 * T-109 withdrew the board's licence to mint cue vocabulary out of its own free
 * text. This stays on the right side of that line for one reason: an extension
 * maps to a single canonical language name that already exists in the world, so
 * the board is *applying* a convention rather than inventing one — the same thing
 * `eb`'s own static alias map does. An extension absent from this table
 * contributes nothing, which is exactly the rule an unmapped label gets.
 *
 * Only languages you **author code in**. `json`, `yaml`, `toml` and `md` are
 * excluded on purpose: nobody works *in* JSON, it rides along with whatever the
 * real work was, and a cue on 90% of commits discriminates nothing. Writing docs
 * genuinely does feel different from writing code — but that is an `activity:`,
 * not a `lang:`, and putting it here would file it under the wrong question.
 */
export const LANG_BY_EXT: Readonly<Record<string, string>> = {
  ts: 'ts', tsx: 'ts', mts: 'ts',
  js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
  kt: 'kotlin', swift: 'swift', dart: 'dart', scala: 'scala',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp',
  php: 'php', sh: 'shell', bash: 'shell', ps1: 'powershell', sql: 'sql',
  css: 'css', scss: 'css', html: 'html', vue: 'vue', svelte: 'svelte',
  gd: 'gdscript', lua: 'lua', ex: 'elixir', exs: 'elixir', r: 'r', m: 'objc',
};

/** How many languages one commit may contribute. A commit spanning more than a
 *  few is a sweep, and a sweep is not evidence about any one language. */
export const MAX_COMMIT_LANGS = 4;

/**
 * The languages a set of changed paths belongs to, commonest first then
 * alphabetical, capped. Pure — the parsing half, so it is unit-testable without
 * a repository.
 */
export function langsForPaths(paths: string[], cap = MAX_COMMIT_LANGS): string[] {
  const counts = new Map<string, number>();
  for (const p of paths) {
    const dot = p.lastIndexOf('.');
    if (dot < 0) continue;
    const lang = LANG_BY_EXT[p.slice(dot + 1).toLowerCase()];
    if (!lang) continue;
    counts.set(lang, (counts.get(lang) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, cap)
    .map(([lang]) => lang);
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

/**
 * Parse `git log --name-only --pretty=format:%H%x09%s` into commit mentions.
 *
 * The format interleaves a `sha<TAB>subject` header with the paths that commit
 * touched, so paths are attributed to the header above them. Tolerant of the
 * plain (no `--name-only`) form, where every commit simply reports no languages.
 */
export function parseLogMentions(log: string): CommitMention[] {
  const out: CommitMention[] = [];
  let paths: string[] = [];
  const flush = () => {
    if (out.length) out[out.length - 1].langs = langsForPaths(paths);
    paths = [];
  };
  for (const raw of log.split("\n")) {
    const line = raw.trimEnd();
    const tab = line.indexOf("\t");
    // A header is `<sha><TAB><subject>`; anything else with content is a path.
    // Two things separate them: a path never contains a tab (git quotes the ones
    // that would), and the part before the tab is bare hex. Testing the sha shape
    // rather than a fixed width keeps abbreviated shas working.
    if (tab > 0 && /^[0-9a-f]{6,40}$/.test(line.slice(0, tab))) {
      flush();
      const subject = line.slice(tab + 1);
      // Every commit is pushed so paths attach to the right one; the ones that
      // mention no task are dropped at the end.
      out.push({ sha: line.slice(0, tab), subject, ids: taskIdsIn(subject), langs: [] });
      continue;
    }
    if (line) paths.push(line);
  }
  flush();
  return out.filter((c) => c.ids.length > 0);
}
/**
 * The report lines for commits that name more than one task — empty when there
 * are none. Task boundaries and commit boundaries drift and nothing says so, so
 * `git link` mentions it; it never refuses. Whether two tasks in one commit is
 * sloppy or just how the editing flowed is the author's call, not the tool's.
 * Caps the listing at `show` so a long history can't bury the link summary.
 */
export function straddleNote(commits: CommitMention[], show = 5): string[] {
  const straddling = commits.filter((c) => c.ids.length > 1);
  if (!straddling.length) return [];
  const lines = [
    `note: ${straddling.length} commit(s) name more than one task — a commit per task keeps the trail readable:`,
    ...straddling.slice(0, show).map((c) => `  ${c.sha.slice(0, 7)}  ${c.ids.join(', ')}  ${c.subject}`),
  ];
  if (straddling.length > show) lines.push(`  …and ${straddling.length - show} more`);
  return lines;
}

/** Commits (recent `depth`) whose subject mentions a task id. */
export function scanCommits(cwd?: string, depth = 500): CommitMention[] {
  // `--name-only` so a commit's languages come from the same walk that finds it:
  // a second `git show` per commit would be one process per commit, and this runs
  // over 500 of them by default.
  const log = run(`git log --name-only --pretty=format:%H%x09%s -n ${depth | 0}`, cwd);
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
