import { describe, it, expect } from 'vitest';
import { makeRepo } from './helpers';
import {
  branchNameFor,
  langsForPaths,
  parseLogMentions,
  postCommitHook,
  prepareCommitMsgHook,
  straddleNote,
  taskIdsIn,
} from '../src/cli/git';

// String-level fixtures only — no live repo mutation (git execution is
// CLI-side and exercised manually; the pure parsing/formatting is what breaks).

describe('task-id scanning', () => {
  it('extracts unique T-n mentions with word boundaries', () => {
    expect(taskIdsIn('fix T-12 and T-12 plus T-345')).toEqual(['T-12', 'T-345']);
    expect(taskIdsIn('NOT-12, AT-12x, T-, T12')).toEqual([]);
    expect(taskIdsIn('T-7-slugged-branch-name')).toEqual(['T-7']);
    expect(taskIdsIn('')).toEqual([]);
  });

  it('parses git log fixture output into commit mentions', () => {
    const log = [
      'aaa111\tfeat: wire callback [T-12]',
      'bbb222\tchore: bump deps',
      'ccc333\tfix T-12 and T-9 races',
      'malformed-line-no-tab',
    ].join('\n');
    const m = parseLogMentions(log);
    expect(m).toHaveLength(2);
    expect(m[0]).toEqual({
      sha: 'aaa111',
      subject: 'feat: wire callback [T-12]',
      ids: ['T-12'],
      langs: [],
    });
    expect(m[1].ids).toEqual(['T-12', 'T-9']);
  });

  it('attributes --name-only paths to the commit above them, as languages', () => {
    const log = [
      'aaa111	feat: wire callback [T-12]',
      'src/auth.ts',
      'src/token.ts',
      'web/app.js',
      'package-lock.json',
      'README',
      '',
      'bbb222	chore: bump deps',
      'package.json',
    ].join(String.fromCharCode(10));
    const m = parseLogMentions(log);
    expect(m).toHaveLength(1);
    // Commonest first; json/md/extensionless contribute nothing — nobody works
    // *in* JSON, and a cue on every commit discriminates nothing.
    expect(m[0].langs).toEqual(['ts', 'js']);
  });

  it('maps only extensions in the closed table, and caps a sweep', () => {
    expect(langsForPaths(['a.rs', 'b.rs', 'c.go'])).toEqual(['rust', 'go']);
    expect(langsForPaths(['notes.md', 'data.json', 'x.yml', 'Makefile'])).toEqual([]);
    expect(langsForPaths(['a.ts', 'b.go', 'c.rs', 'd.py', 'e.rb'], 2)).toHaveLength(2);
  });
});

describe('branch naming', () => {
  it('slugs titles into T-n-<slug> with cleanup and length cap', () => {
    expect(branchNameFor('T-12', 'Wire up OAuth callback')).toBe('T-12-wire-up-oauth-callback');
    expect(branchNameFor('T-3', '  Fix: (weird)  chars!! ')).toBe('T-3-fix-weird-chars');
    expect(branchNameFor('T-4', '™©®')).toBe('T-4'); // nothing sluggable
    const long = branchNameFor('T-5', 'x'.repeat(100));
    expect(long.length).toBeLessThanOrEqual('T-5-'.length + 40);
    expect(long.endsWith('-')).toBe(false);
  });
});

describe('hook scripts', () => {
  it('prepare-commit-msg appends [T-n] from the branch, once', () => {
    const h = prepareCommitMsgHook();
    expect(h.startsWith('#!/bin/sh')).toBe(true);
    expect(h).toContain('kanban:'); // marker install-hooks uses to recognize its own hook
    expect(h).toContain("grep -oE 'T-[0-9]+'");
    expect(h).toContain('grep -qE'); // dedupe guard before appending
  });

  it('post-commit is fire-and-forget and never fails the commit', () => {
    const h = postCommitHook();
    expect(h.startsWith('#!/bin/sh')).toBe(true);
    expect(h).toContain('kanban:');
    expect(h).toContain('kanban git link');
    expect(h).toContain('&'); // backgrounded
    expect(h.trim().endsWith('exit 0')).toBe(true);
  });
});

describe('repo.addArtifact idempotency (git link re-scans)', () => {
  it('same (task, kind, uri) returns the existing artifact with no new event', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't' });
    const first = repo.addArtifact(t.id, 'commit', 'feat: x [T-1]', 'git:aaa111');
    const seq = repo.maxSeq();
    const again = repo.addArtifact(t.id, 'commit', 'retitled subject', 'git:aaa111');
    expect(again.id).toBe(first.id); // title is not part of the identity
    expect(repo.maxSeq()).toBe(seq); // no duplicate event
    expect(repo.getArtifacts(t.id)).toHaveLength(1);
    // Different uri or kind is a new artifact.
    repo.addArtifact(t.id, 'commit', 'y', 'git:bbb222');
    repo.addArtifact(t.id, 'branch', 'T-1-y', 'branch:T-1-y');
    expect(repo.getArtifacts(t.id)).toHaveLength(3);
  });
});

describe('commits that straddle two tasks', () => {
  // `git link` could already see a commit naming two tasks; it just said nothing,
  // so a bundled commit had to be spotted by hand and split with `reset --soft`.
  const mentions = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      sha: String(i).repeat(40),
      subject: 'feat: two things at once',
      ids: [`T-${i * 2 + 1}`, `T-${i * 2 + 2}`],
    }));

  it('says nothing when every commit names one task', () => {
    expect(straddleNote([{ sha: 'a'.repeat(40), subject: 'feat: x [T-1]', ids: ['T-1'] }])).toEqual([]);
    expect(straddleNote([])).toEqual([]);
  });

  it('names each straddling commit, and never refuses', () => {
    const lines = straddleNote(mentions(2));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('2 commit(s) name more than one task');
    expect(lines[1]).toContain('0000000'); // short sha
    expect(lines[1]).toContain('T-1, T-2');
    expect(lines.join(' ')).not.toMatch(/error|refus|cannot|must/i);
  });

  it('caps the listing so a long history cannot bury the link summary', () => {
    const lines = straddleNote(mentions(9));
    expect(lines).toHaveLength(1 + 5 + 1);
    expect(lines[lines.length - 1]).toBe('  …and 4 more');
  });
});
