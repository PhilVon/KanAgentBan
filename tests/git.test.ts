import { describe, it, expect } from 'vitest';
import { makeRepo } from './helpers';
import {
  branchNameFor,
  parseLogMentions,
  postCommitHook,
  prepareCommitMsgHook,
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
    expect(m[0]).toEqual({ sha: 'aaa111', subject: 'feat: wire callback [T-12]', ids: ['T-12'] });
    expect(m[1].ids).toEqual(['T-12', 'T-9']);
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
