import { describe, it, expect } from 'vitest';
import { makeRepo, startTestServer, stopTestServer, client } from './helpers';
import { NotFoundError, ValidationError } from '../src/server/repo';

describe('repo: task templates', () => {
  const seed = (repo: ReturnType<typeof makeRepo>) => {
    const t = repo.createTask({
      title: 'PR work',
      priority: 'P1',
      labels: ['pr', 'checklist'],
      criteria: ['tests pass', 'docs updated'],
    });
    const c1 = repo.createTask({ title: 'write tests', parent: t.id });
    repo.addCriterion(c1.id, 'unit + integration');
    repo.createTask({ title: 'update changelog', parent: t.id });
    return t;
  };

  it('save --from snapshots priority, labels, criteria, and the subtask skeleton', () => {
    const repo = makeRepo();
    const t = seed(repo);
    const tpl = repo.saveTemplateFromTask('pr-checklist', t.id);
    expect(tpl.name).toBe('pr-checklist');
    expect(tpl.blueprint.priority).toBe('P1');
    expect(tpl.blueprint.labels).toEqual(['checklist', 'pr']); // getLabels returns name-sorted
    expect(tpl.blueprint.criteria).toEqual(['tests pass', 'docs updated']);
    expect(tpl.blueprint.subtasks).toEqual([
      { title: 'write tests', criteria: ['unit + integration'] },
      { title: 'update changelog', criteria: [] },
    ]);
    // Saving again upserts (same name, fresh snapshot).
    repo.moveTask(t.id, 'Ready');
    const again = repo.saveTemplateFromTask('pr-checklist', t.id);
    expect(again.name).toBe('pr-checklist');
    expect(repo.listTemplates()).toHaveLength(1);
  });

  it('apply creates the task tree atomically with overrides winning', () => {
    const repo = makeRepo();
    seed(repo);
    repo.saveTemplateFromTask('pr-checklist', 'T-1');
    const r = repo.applyTemplate('pr-checklist', { title: 'Ship feature X', status: 'Ready', priority: 'P0' });
    expect(r.task.title).toBe('Ship feature X');
    expect(r.task.priority).toBe('P0'); // override beats the blueprint's P1
    expect(r.task.status).toBe('Ready');
    expect(repo.getLabels(r.task.id)).toEqual(expect.arrayContaining(['pr', 'checklist']));
    expect(repo.getCriteria(r.task.id).map((c) => c.text)).toEqual(['tests pass', 'docs updated']);
    const kids = repo.getChildren(r.task.id);
    expect(kids.map((k) => k.title)).toEqual(['write tests', 'update changelog']);
    expect(repo.getCriteria(kids[0].id).map((c) => c.text)).toEqual(['unit + integration']);
    expect(r.children).toEqual(kids.map((k) => k.id));
    // Provenance event.
    const ev = repo.changes(0).filter((e) => e.type === 'template.applied');
    expect(ev).toHaveLength(1);
    expect(ev[0].payload).toMatchObject({ name: 'pr-checklist', task_id: r.task.id });
  });

  it('validates names and rejects unknown templates', () => {
    const repo = makeRepo();
    const t = repo.createTask({ title: 'a' });
    expect(() => repo.saveTemplateFromTask('bad name!', t.id)).toThrow(ValidationError);
    expect(() => repo.applyTemplate('nope', { title: 'x' })).toThrow(NotFoundError);
    repo.saveTemplateFromTask('ok-name', t.id);
    repo.deleteTemplate('ok-name');
    expect(repo.listTemplates()).toEqual([]);
    expect(() => repo.deleteTemplate('ok-name')).toThrow(NotFoundError);
  });
});

describe('server: template routes', () => {
  it('save / list / show / apply / delete roundtrip', async () => {
    const h = await startTestServer();
    try {
      const c = client(h);
      const t = (await c('POST', '/api/tasks', { title: 'seed', criteria: ['done when x'], labels: ['spike'] })).body;
      const save = await c('PUT', '/api/templates/spike', { from: t.id });
      expect(save.status).toBe(200);
      const list = await c('GET', '/api/templates');
      expect(list.body.templates.map((x: any) => x.name)).toEqual(['spike']);
      const show = await c('GET', '/api/templates/spike');
      expect(show.body.blueprint.criteria).toEqual(['done when x']);
      const applied = await c('POST', '/api/templates/spike/apply', { title: 'Investigate Y' });
      expect(applied.status).toBe(200);
      expect(applied.body.task.title).toBe('Investigate Y');
      const del = await c('DELETE', '/api/templates/spike');
      expect(del.status).toBe(200);
      expect((await c('GET', '/api/templates/spike')).status).toBe(404);
    } finally {
      await stopTestServer(h);
    }
  });
});
