import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Runs the BUILT CLI: kanban.ts parses argv at import time, and argument
// validation is commander's, so it can only be observed in a real process.
// CI builds before it tests.
const CLI = path.resolve(__dirname, '..', 'dist', 'cli', 'kanban.js');

describe.skipIf(!fs.existsSync(CLI))('cli: a positional argument the shell split fails loudly', () => {
  // What Windows PowerShell 5.1 hands node for a long argument with an embedded
  // double quote: the text up to the quote, then the rest as stray positionals.
  // Commander used to ignore the strays, so the command stored the truncated
  // text and reported success. It must refuse before it ever reaches a board.
  const run = (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });

  it.each([
    ['comment', 'T-1', 'the text up to the ', 'quote', 'and the rest'],
    ['ask', 'T-1', 'a question cut at a ', 'quote'],
    ['checkpoint', 'T-1', 'did X, next ', 'Y'],
    ['criterion', 'add', 'T-1', 'a criterion cut at a ', 'quote'],
    ['expect', 'T-1', 'the event cut ', 'short'],
  ])('%s refuses stray positional arguments', (...args) => {
    const r = run(...args);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/too many arguments/);
  });
});
