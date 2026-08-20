import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import { startTestServer, stopTestServer, client, makeRepo, type TestServer } from './helpers';
import {
  AFFECT_OFF,
  affectLine,
  consultAboutCommand,
  consultOptionsCommand,
  cueError,
  cuesForLabels,
  MAX_CONSULT_OPTIONS,
} from '../src/server/affect';
import { renderContext, renderNext } from '../src/server/render';
import { runDoctor } from '../src/server/doctor';
import { renderDoctor } from '../src/server/render';
import { boardPaths, readBoardMeta, writeBoardMeta } from '../src/shared/board-paths';

// ADR 0009: the board emits `eb consult …` TEXT at moments it knows are decisions.
// It never runs eb, never reads the brain, never stores a stance. The value is the
// half eb cannot supply for itself — the moment, and the vocabulary.

const ON = { enabled: true, map: {} };

describe('cues: the vocabulary half', () => {
  it('turns labels into cue keys, defaulting to activity:', () => {
    expect(cuesForLabels(['port', 'cli'])).toEqual(['activity:port', 'activity:cli']);
  });

  it('honours an explicit map, and dedupes', () => {
    expect(cuesForLabels(['port', 'ts', 'cli'], { ts: 'lang:ts', cli: 'activity:port' })).toEqual([
      'activity:port',
      'lang:ts',
    ]);
  });

  it('a task with no labels emits no cues — never a guess from the title', () => {
    // Guessing is exactly the invented vocabulary this exists to stop.
    expect(cuesForLabels([])).toEqual([]);
  });

  it('slugs a label into the cue value charset', () => {
    expect(cuesForLabels(['Web UI'])).toEqual(['activity:web-ui']);
  });

  it('never emits proj:, however it is configured', () => {
    // eb derives proj: from the cwd basename; a board emitting one would be
    // inventing a fact about a project rather than passing on a cue (EB ADR 0008).
    expect(cueError('proj:privateeye')).toMatch(/derived by eb/);
    expect(cuesForLabels(['x'], { x: 'proj:privateeye' })).toEqual([]);
  });

  it('rejects an unknown namespace and a malformed value at config time', () => {
    expect(cueError('mood:happy')).toMatch(/unknown cue namespace/);
    expect(cueError('activity')).toMatch(/no namespace/);
    expect(cueError('activity:Not Valid')).toMatch(/not a cue value/);
    expect(cueError('activity:port')).toBeNull();
    expect(cueError('collab:human')).toBeNull();
  });
});

describe('the commands the board prints', () => {
  it('--options is capped at four — past that eb refuses', () => {
    const cmd = consultOptionsCommand(['a', 'b', 'c', 'd', 'e', 'f'])!;
    expect(cmd.match(/,/g)!.length).toBe(MAX_CONSULT_OPTIONS - 1);
    expect(cmd).toBe('eb consult --options "a,b,c,d"');
  });

  it('--options is never combined with --about or a query', () => {
    // eb rejects the combination: a candidate set and a prospective action are
    // different questions.
    const cmd = consultOptionsCommand(['pick a', 'pick b'])!;
    expect(cmd).not.toContain('--about');
    expect(cmd).toBe('eb consult --options "pick a,pick b"');
  });

  it('one candidate is not a choice', () => {
    expect(consultOptionsCommand(['only one'])).toBeNull();
    expect(consultOptionsCommand([])).toBeNull();
  });

  it('strips what would break the command it is emitting', () => {
    const cmd = consultOptionsCommand(['a "quoted", comma title', 'plain'])!;
    expect(cmd).toBe('eb consult --options "a quoted  comma title,plain"');
    expect(consultAboutCommand('say "hi"\nthere', [])).toBe('eb consult "say hi there"');
  });

  it('the prospective-action form seeds cues, or omits --about when there are none', () => {
    expect(consultAboutCommand('picking up T-1: port the thing', ['activity:port'])).toBe(
      'eb consult "picking up T-1: port the thing" --about activity:port',
    );
    expect(consultAboutCommand('picking up T-1', [])).toBe('eb consult "picking up T-1"');
  });

  it('every hint is its own labelled line', () => {
    expect(affectLine('eb consult "x"')).toBe('affect: eb consult "x"');
    expect(affectLine(null)).toBeNull();
  });
});

describe('emission points', () => {
  const twoReady = () => {
    const repo = makeRepo();
    repo.createTask({ title: 'port the exporter', status: 'Ready', labels: ['port'] });
    repo.createTask({ title: 'fix the drawer', status: 'Ready' });
    return repo;
  };

  it('next emits an affect line with two or more ready candidates', () => {
    const text = renderNext(twoReady(), { affect: ON, full: true });
    const line = text.split('\n').find((l) => l.startsWith('affect:'))!;
    // Candidate order is `next`'s own rank order — the order to consult in.
    expect(line).toBe('affect: eb consult --options "fix the drawer,port the exporter"');
  });

  it('next emits nothing with one candidate, and nothing when affect is off', () => {
    const repo = makeRepo();
    repo.createTask({ title: 'only one', status: 'Ready' });
    expect(renderNext(repo, { affect: ON, full: true })).not.toContain('affect:');
    expect(renderNext(twoReady(), { affect: AFFECT_OFF, full: true })).not.toContain('affect:');
    expect(renderNext(twoReady(), { full: true })).not.toContain('affect:');
  });

  it('the hint is never folded into why:', () => {
    const text = renderNext(twoReady(), { affect: ON, full: true });
    const why = text.split('\n').find((l) => l.startsWith('why:'))!;
    expect(why).not.toContain('eb consult');
    expect(why).not.toContain('affect');
  });

  it('it sheds first under a budget, and never silently', () => {
    const tight = renderNext(twoReady(), { affect: ON, maxTokens: 20 });
    expect(tight).not.toContain('eb consult');
    expect(tight).toContain('[affect hint hidden for token budget — kanban next --full]');
  });

  it('context prints a cues line from the task labels, only when on', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't', status: 'In Progress', labels: ['port', 'cli'] });
    const on = renderContext(repo, t.id, { full: true, affect: ON });
    expect(on).toContain('cues: activity:cli, activity:port');
    expect(on).toContain('inherited, not invented');
    expect(renderContext(repo, t.id, { full: true })).not.toContain('cues:');
  });

  it('context prints no cues line for a task with no labels', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't', status: 'In Progress' });
    expect(renderContext(repo, t.id, { full: true, affect: ON })).not.toContain('cues:');
  });

  it('doctor never carries affect — it is correctness-shaped', () => {
    const repo = makeRepo();
    repo.createTask({ title: 'bare', status: 'In Progress' });
    const text = renderDoctor(runDoctor(repo));
    expect(text).not.toContain('affect');
    expect(text).not.toContain('eb consult');
  });
});

describe('over REST, with the board configured', () => {
  let h: TestServer;
  afterEach(async () => {
    if (h) await stopTestServer(h);
  });

  const enable = (map: Record<string, string> = {}) => {
    const p = boardPaths(h.root);
    writeBoardMeta(p, { ...readBoardMeta(p), affect: { enabled: true, map } });
  };

  it('is off by default: nothing emits a hint', async () => {
    h = await startTestServer();
    const c = client(h);
    const t = (await c('POST', '/api/tasks', { title: 'a', status: 'Ready' })).body;
    await c('POST', '/api/tasks', { title: 'b', status: 'Ready' });
    expect((await c('GET', '/api/next')).body.text).not.toContain('affect:');
    expect((await c('POST', `/api/tasks/${t.id}/claim`)).body.affect).toBeUndefined();
    expect((await c('POST', '/api/brainstorms', { topic: 'cache strategy' })).body.affect).toBeUndefined();
  });

  it('claim and brainstorm start return an affect line seeded with the task cues', async () => {
    h = await startTestServer();
    const c = client(h);
    const t = (await c('POST', '/api/tasks', { title: 'port the exporter', labels: ['port'] })).body;
    enable({ port: 'activity:port' });

    const claimed = (await c('POST', `/api/tasks/${t.id}/claim`)).body;
    expect(claimed.affect).toBe(`affect: eb consult "picking up ${t.id}: port the exporter" --about activity:port`);

    const session = (await c('POST', '/api/brainstorms', { topic: 'cache strategy', task: t.id })).body;
    expect(session.affect).toBe('affect: eb consult "cache strategy" --about activity:port');
  });

  it('turning it on needs no server restart', async () => {
    h = await startTestServer();
    const c = client(h);
    await c('POST', '/api/tasks', { title: 'a', status: 'Ready' });
    await c('POST', '/api/tasks', { title: 'b', status: 'Ready' });
    expect((await c('GET', '/api/next')).body.text).not.toContain('affect:');
    enable();
    expect((await c('GET', '/api/next')).body.text).toContain('affect: eb consult --options');
  });

  it('ask never emits a hint — framing the options WAS the decision', async () => {
    h = await startTestServer();
    const c = client(h);
    const t = (await c('POST', '/api/tasks', { title: 'a', labels: ['port'] })).body;
    enable();
    const q = (await c('POST', `/api/tasks/${t.id}/input-requests`, { question: 'which?' })).body;
    expect(JSON.stringify(q)).not.toContain('affect');
    expect((await c('GET', '/api/doctor')).body.text).not.toContain('affect');
  });
});

// The one property no unit test can settle: that eb accepts what the board prints.
// Skipped where eb is not installed (CI), run for real where it is.
const hasEb = (() => {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', ['eb'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasEb)('eb accepts the emitted command verbatim', () => {
  // Through a shell, not execFileSync: on Windows `eb` is a .cmd shim, and the
  // quoting the board emits has to survive the same path a user's terminal takes.
  const run = (cmd: string) => execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  it('runs the --options form at the cap', () => {
    const cmd = consultOptionsCommand(['port the exporter', 'fix the drawer', 'third', 'fourth'])!;
    expect(() => run(cmd)).not.toThrow();
    expect(run(cmd)).not.toMatch(/the cap is 4/);
  });

  it('runs the --about form', () => {
    const cmd = consultAboutCommand('picking up T-1: port the exporter', ['activity:port', 'collab:human']);
    expect(() => run(cmd)).not.toThrow();
    expect(run(cmd)).not.toMatch(/unknown|rejected/i);
  });
});

// Guard: the affect module must never reach for a child process or the network.
// The boundary is meant to be structural, not a promise.
describe('the boundary is structural', () => {
  it('affect.ts spawns nothing and reads nothing', () => {
    const src = fs.readFileSync('src/server/affect.ts', 'utf8');
    for (const forbidden of ['child_process', 'execSync', 'spawn', 'fetch(', 'require(']) {
      expect(src, forbidden).not.toContain(forbidden);
    }
  });
});
