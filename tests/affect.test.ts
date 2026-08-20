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
  checkAffect,
  cuesFor,
  cuesForLabels,
  MAX_CONSULT_OPTIONS,
} from '../src/server/affect';
import { renderAffectCheck, renderContext, renderNext } from '../src/server/render';
import { recommend } from '../src/server/recommend';
import { runDoctor } from '../src/server/doctor';
import { renderDoctor } from '../src/server/render';
import { boardPaths, readBoardMeta, writeBoardMeta } from '../src/shared/board-paths';

// ADR 0009: the board emits `eb consult …` TEXT at moments it knows are decisions.
// It never runs eb, never reads the brain, never stores a stance. The value is the
// half eb cannot supply for itself — the moment, and the vocabulary.

const ON = { enabled: true, map: {} };

describe('cues: the vocabulary half', () => {
  it('emits only mapped labels — an unmapped label emits no cue at all', () => {
    // The board emits less, not the agent allowed less. eb cue keys are immutable
    // (no rename, no merge), so a bad cue costs evidence permanently while silence
    // costs one prompt.
    expect(cuesForLabels(['port', 'cli'])).toEqual([]);
    expect(cuesForLabels(['port', 'cli'], { port: 'activity:port' })).toEqual(['activity:port']);
  });

  it('names the labels it emitted nothing for, so the silence can be explained', () => {
    expect(cuesFor(['port', 'docs'], { port: 'activity:port' })).toEqual({
      cues: ['activity:port'],
      unmapped: ['docs'],
    });
  });

  it('honours an explicit map, and dedupes', () => {
    expect(
      cuesForLabels(['port', 'ts', 'cli'], { port: 'activity:port', ts: 'lang:ts', cli: 'activity:port' }),
    ).toEqual(['activity:port', 'lang:ts']);
  });

  it('a task with no labels emits no cues, and has nothing to report unmapped', () => {
    // Guessing is exactly the invented vocabulary this exists to stop.
    expect(cuesFor([])).toEqual({ cues: [], unmapped: [] });
  });

  it('never emits proj:, however it is configured — and counts that label unmapped', () => {
    // eb derives proj: from the cwd basename; a board emitting one would be
    // inventing a fact about a project rather than passing on a cue (EB ADR 0008).
    // A cue eb would reject is no better than no mapping, and takes the same fix.
    expect(cueError('proj:privateeye')).toMatch(/derived by eb/);
    expect(cuesFor(['x'], { x: 'proj:privateeye' })).toEqual({ cues: [], unmapped: ['x'] });
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
    const repo = twoReady();
    const line = renderNext(repo, { affect: ON, full: true })
      .split('\n')
      .find((l) => l.startsWith('affect:'))!;

    // The candidate order is `next`'s own rank order — the order to consult in —
    // so it is DERIVED here rather than typed. Two equally-ready tasks tie-break
    // on timestamps, which differ by machine: pinning the literal made this pass
    // locally and fail on CI.
    const ranked = recommend(repo, MAX_CONSULT_OPTIONS) as { task: { title: string } }[];
    expect(line).toBe(`affect: eb consult --options "${ranked.map((r) => r.task.title).join(',')}"`);
    expect(line).toContain('port the exporter');
    expect(line).toContain('fix the drawer');
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
    const mapped = { enabled: true, map: { port: 'activity:port', cli: 'activity:cli' } };
    const on = renderContext(repo, t.id, { full: true, affect: mapped });
    expect(on).toContain('cues: activity:cli, activity:port');
    expect(on).toContain('inherited, not invented');
    expect(renderContext(repo, t.id, { full: true })).not.toContain('cues:');
  });

  it('a partly-mapped task emits what it has and names the rest', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't', status: 'In Progress', labels: ['docs', 'port'] });
    const text = renderContext(repo, t.id, {
      full: true,
      affect: { enabled: true, map: { port: 'activity:port' } },
    });
    expect(text).toContain('cues: activity:port');
    expect(text).toContain('unmapped: docs');
    expect(text).toContain('kanban board affect --map <label>=<cue>');
    // Never a slug suggestion: activity:docs is precisely the near-duplicate that
    // eb's own starter vocabulary warns about, so the board must not propose it.
    expect(text).not.toContain('activity:docs');
  });

  it('with nothing mapped it says none and names the fix — never an empty cues line', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 't', status: 'In Progress', labels: ['docs', 'feature'] });
    const text = renderContext(repo, t.id, { full: true, affect: ON });
    expect(text).toContain('cues: none — unmapped: docs, feature');
    expect(text).toContain('kanban board affect --map <label>=<cue>');
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

describe('board affect --check', () => {
  // Commonest first: the count IS the advice, because mapping the label on 13
  // tasks buys 13x the evidence of mapping the one on a single task.
  const usage = [
    { label: 'docs', tasks: 13 },
    { label: 'cli', tasks: 7 },
    { label: 'bug', tasks: 2 },
  ];

  it('splits the map into what emits, what does not, and what is broken', () => {
    const c = checkAffect(
      { enabled: true, map: { cli: 'activity:cli', bug: 'mood:sad', gone: 'activity:gone' } },
      usage,
    );
    expect(c.mapped).toEqual([{ label: 'cli', cue: 'activity:cli', tasks: 7 }]);
    expect(c.unmapped).toEqual([{ label: 'docs', tasks: 13 }]);
    expect(c.invalid.map((i) => i.label)).toEqual(['bug']);
    expect(c.invalid[0].reason).toMatch(/unknown cue namespace/);
    // Mapped, but nothing on the board carries it — usually a renamed label.
    expect(c.stale).toEqual([{ label: 'gone', cue: 'activity:gone' }]);
  });

  it('an unmapped label is never a fault — only a map eb would reject is', () => {
    // The CLI exits non-zero on `invalid` alone. Exiting on `unmapped` would
    // pressure a board into mapping every label mechanically, which is exactly
    // the minting this strand removed (ADR 0009 amendment).
    const c = checkAffect({ enabled: true, map: {} }, usage);
    expect(c.unmapped.map((u) => u.label)).toEqual(['docs', 'cli', 'bug']);
    expect(c.invalid).toEqual([]);
  });

  it('reports the map even when hints are off, so it can be seen before enabling', () => {
    const c = checkAffect({ enabled: false, map: { cli: 'activity:cli' } }, usage);
    expect(c.mapped).toHaveLength(1);
    expect(renderAffectCheck(c)).toContain('affect hints off');
  });

  it('renders the counts and the fix, and never proposes a slug of the label', () => {
    const text = renderAffectCheck(checkAffect({ enabled: true, map: {} }, usage));
    expect(text).toContain('0 of 3 labels mapped');
    expect(text).toContain('13  docs');
    expect(text).toContain('fix: kanban board affect --map <label>=<cue>');
    expect(text).not.toContain('activity:docs');
  });

  it('says so when every label in use is mapped', () => {
    const map = { docs: 'activity:writing-docs', cli: 'activity:cli', bug: 'activity:bug' };
    expect(renderAffectCheck(checkAffect({ enabled: true, map }, usage))).toContain(
      'every label in use is mapped.',
    );
  });

  it('counts live tasks only — an archived one is not evidence you can still act on', () => {
    const repo = makeRepo();
    repo.createTask({ title: 'a', labels: ['docs'] });
    const gone = repo.createTask({ title: 'b', labels: ['docs'] });
    expect(repo.labelUsage()).toEqual([{ label: 'docs', tasks: 2 }]);
    repo.archiveTask(gone.id);
    expect(repo.labelUsage()).toEqual([{ label: 'docs', tasks: 1 }]);
  });

  it('doctor stays clean and affect-free with every label unmapped', () => {
    // Affect adjusts preference, never permission: an unmapped label must never
    // reach a correctness-shaped surface.
    const repo = makeRepo();
    repo.createTask({ title: 'x', status: 'In Progress', labels: ['docs'] });
    repo.createTask({ title: 'y', status: 'Ready', labels: ['cli'] });
    const text = renderDoctor(runDoctor(repo));
    expect(text).not.toContain('affect');
    expect(text).not.toContain('unmapped');
    expect(text).not.toContain('cue');
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

  it('serves the check, and reflects the map with hints still off', async () => {
    h = await startTestServer();
    const c = client(h);
    await c('POST', '/api/tasks', { title: 'a', labels: ['docs', 'cli'] });
    await c('POST', '/api/tasks', { title: 'b', labels: ['docs'] });

    const off = (await c('GET', '/api/board/affect')).body;
    expect(off.enabled).toBe(false);
    expect(off.unmapped).toEqual([
      { label: 'docs', tasks: 2 },
      { label: 'cli', tasks: 1 },
    ]);

    enable({ docs: 'activity:writing-docs' });
    const on = (await c('GET', '/api/board/affect')).body;
    expect(on.enabled).toBe(true);
    expect(on.mapped).toEqual([{ label: 'docs', cue: 'activity:writing-docs', tasks: 2 }]);
    expect(on.unmapped).toEqual([{ label: 'cli', tasks: 1 }]);
    expect(on.text).toContain('1 of 2 labels mapped');
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
