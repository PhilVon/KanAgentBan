import { describe, expect, it } from 'vitest';
import { Command } from 'commander';
import { normalizeShell, renderCompletion, specFromCommand } from '../src/cli/completion';

/** A miniature of the real CLI shape: globals, flat commands, nested groups. */
function makeProgram(): Command {
  const p = new Command().name('kanban').option('--board <path>').option('--as <id>');
  p.command('next').option('--context').option('--json');
  p.command('add <title>').option('--desc <t>').option('--label <l>');
  const dep = p.command('dep');
  dep.command('add <id>').requiredOption('--on <id>');
  dep.command('rm <id>').requiredOption('--on <id>');
  return p;
}

describe('specFromCommand', () => {
  it('extracts names, long flags, and nested subcommands', () => {
    const spec = specFromCommand(makeProgram());
    expect(spec.name).toBe('kanban');
    expect(spec.options).toEqual(['--board', '--as']);
    expect(spec.subs.map((s) => s.name)).toEqual(['next', 'add', 'dep']);
    const dep = spec.subs.find((s) => s.name === 'dep')!;
    expect(dep.subs.map((s) => s.name)).toEqual(['add', 'rm']);
    expect(dep.subs[0].options).toEqual(['--on']);
  });
});

describe('renderCompletion', () => {
  const spec = specFromCommand(makeProgram());

  it.each(['bash', 'zsh', 'pwsh'] as const)('%s script covers every command and flag', (shell) => {
    const script = renderCompletion(spec, shell);
    for (const name of ['next', 'add', 'dep']) expect(script).toContain(name);
    expect(script).toContain('--board');
    expect(script).toContain('--context');
    expect(script).toContain('--on');
    expect(script).toContain('dep add'); // two-level path key
  });

  it('pwsh registers a native argument completer', () => {
    expect(renderCompletion(spec, 'pwsh')).toContain('Register-ArgumentCompleter -Native -CommandName kanban');
  });

  it('bash defines and binds the completion function', () => {
    const s = renderCompletion(spec, 'bash');
    expect(s).toContain('_kanban()');
    expect(s).toContain('complete -F _kanban kanban');
  });

  it('zsh carries the compdef header', () => {
    expect(renderCompletion(spec, 'zsh')).toContain('#compdef kanban');
  });
});

describe('normalizeShell', () => {
  it('accepts powershell as a pwsh alias and rejects unknowns', () => {
    expect(normalizeShell('powershell')).toBe('pwsh');
    expect(normalizeShell('PWSH')).toBe('pwsh');
    expect(normalizeShell('fish')).toBeNull();
  });
});
