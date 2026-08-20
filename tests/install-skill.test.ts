import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tempDir } from './helpers';

// scripts/install-skill.cjs syncs skill/ + docs/ into <CLAUDE_CONFIG_DIR>/skills/kanban.
// The property that matters is --check: the installed copy is editable in place, so
// drift must be detectable (exit 2) instead of discovered by an install destroying it.

const SCRIPT = path.resolve(__dirname, '..', 'scripts', 'install-skill.cjs');

let cfg: string;
let dest: string;

/** Run the installer; returns exit code + merged output instead of throwing. */
function run(...args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: cfg },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out };
  } catch (e) {
    const err = e as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

beforeEach(() => {
  cfg = tempDir();
  dest = path.join(cfg, 'skills', 'kanban');
});
afterEach(() => fs.rmSync(cfg, { recursive: true, force: true }));

describe('install-skill', () => {
  it('installs SKILL.md and the docs tree under CLAUDE_CONFIG_DIR', () => {
    expect(run().code).toBe(0);
    expect(fs.existsSync(path.join(dest, 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'docs', '05-cli-reference.md'))).toBe(true);
    expect(fs.existsSync(path.join(dest, 'docs', 'adr', '0007-docs-store-content.md'))).toBe(true);

    const src = fs.readFileSync(path.resolve(__dirname, '..', 'skill', 'SKILL.md'));
    expect(fs.readFileSync(path.join(dest, 'SKILL.md')).equals(src)).toBe(true);
  });

  it('--check exits 2 when nothing is installed and 0 once it matches', () => {
    expect(run('--check').code).toBe(2);
    run();
    const clean = run('--check');
    expect(clean.code).toBe(0);
    expect(clean.out).toContain('clean');
  });

  it('--check reports an in-place edit as drift and warns before it is overwritten', () => {
    run();
    fs.appendFileSync(path.join(dest, 'SKILL.md'), '\nedited only in the installed copy\n');
    const res = run('--check');
    expect(res.code).toBe(2);
    expect(res.out).toContain('differs   SKILL.md');
    expect(res.out).toMatch(/backport|ONLY in the installed copy/);
  });

  it('--check reports an extra file, and a sync removes it out loud', () => {
    run();
    fs.writeFileSync(path.join(dest, 'docs', 'stray.md'), 'not from source');
    expect(run('--check').out).toContain('extra     docs/stray.md');

    const sync = run();
    expect(sync.out).toContain('removed docs/stray.md');
    expect(fs.existsSync(path.join(dest, 'docs', 'stray.md'))).toBe(false);
    expect(run('--check').code).toBe(0);
  });

  it('--check does not create or modify anything', () => {
    expect(run('--check').code).toBe(2);
    expect(fs.existsSync(dest)).toBe(false);
  });
});
