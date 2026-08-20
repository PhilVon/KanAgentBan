import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { collectList } from '../src/cli/args';

describe('collectList', () => {
  it('splits a single comma-separated value', () => {
    expect(collectList('a,b')).toEqual(['a', 'b']);
  });

  it('appends across repeated flags', () => {
    expect(collectList('c', ['a', 'b'])).toEqual(['a', 'b', 'c']);
  });

  it('trims whitespace and drops empty segments', () => {
    expect(collectList(' a , ,b ')).toEqual(['a', 'b']);
  });
});

describe('commander integration', () => {
  function parse(args: string[]): Record<string, unknown> {
    const cmd = new Command()
      .option('--label <l>', 'repeatable or comma-separated', collectList)
      .option('--depends <id>', 'repeatable or comma-separated', collectList);
    cmd.parse(args, { from: 'user' });
    return cmd.opts();
  }

  it('accumulates repeated flags instead of last-wins', () => {
    expect(parse(['--label', 'a,b', '--label', 'c']).label).toEqual(['a', 'b', 'c']);
  });

  it('handles a single comma-separated occurrence', () => {
    expect(parse(['--depends', 'T-1,T-2']).depends).toEqual(['T-1', 'T-2']);
  });

  it('leaves an omitted flag undefined (not [])', () => {
    expect(parse([]).label).toBeUndefined();
  });
});

describe('--desc / --description alias', () => {
  // `add` and `update` both declare '--desc, --description <t>'. The description
  // is the field worth rewriting once a symptom's cause is known, and typing the
  // obvious long spelling used to be `error: unknown option`.
  function parse(args: string[]): Record<string, unknown> {
    const cmd = new Command().option('--desc, --description <t>', 'task description');
    cmd.parse(args, { from: 'user' });
    return cmd.opts();
  }

  it('accepts --description', () => {
    expect(parse(['--description', 'the cause, once known']).description).toBe('the cause, once known');
  });

  it('still accepts --desc, landing on the same property', () => {
    expect(parse(['--desc', 'short form']).description).toBe('short form');
  });

  it('leaves it undefined when neither is given', () => {
    expect(parse([]).description).toBeUndefined();
  });
});
