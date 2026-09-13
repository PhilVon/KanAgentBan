import { describe, it, expect } from 'vitest';
import { makeRepo } from './helpers';
import { ValidationError } from '../src/server/repo';

describe('repo: ask refuses an options list that collapsed into one option', () => {
  it('refuses a single option containing whitespace', () => {
    // What `--options "a b c"` produces: one choice naming three, which without
    // --freeform leaves the whole string as the only valid answer.
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a' });
    expect(() => repo.ask(t.id, 'which?', { options: ['keep-it drop-it defer-it'] })).toThrow(ValidationError);
    expect(() => repo.ask(t.id, 'which?', { options: ['keep-it\tdrop-it'], freeform: true })).toThrow(/commas/);
  });

  it('still accepts a closed set of one, and options that are separate', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a' });
    expect(repo.ask(t.id, 'confirm?', { options: ['confirm'] }).options).toEqual(['confirm']);
    expect(repo.ask(t.id, 'which?', { options: ['keep-it', 'drop-it', 'defer-it'] }).options).toHaveLength(3);
    expect(repo.ask(t.id, 'which?', { options: ['looks right', 'too heavy'] }).options).toHaveLength(2);
  });
});
