import { describe, it, expect } from 'vitest';
import { renderInbox } from '../src/cli/format';
import type { InputRequest } from '../src/shared/types';

const req = (over: Partial<InputRequest>): InputRequest => ({
  id: 'Q-1',
  task_id: 'T-1',
  question: 'Which auth provider?',
  options: ['Auth0', 'Cognito'],
  answer_freeform: false,
  status: 'open',
  answer: null,
  answered_by: null,
  created_at: '2026-01-01T00:00:00.000Z',
  answered_at: null,
  expires_at: null,
  ...over,
});

describe('cli: renderInbox', () => {
  it('renders answered requests first (the resume signal), then open ones', () => {
    const out = renderInbox({
      answered: [req({ id: 'Q-7', task_id: 'T-12', status: 'answered', answer: 'Auth0' })],
      open: [req({ id: 'Q-9', task_id: 'T-3', question: 'Region?' })],
      cursor: 5,
    });
    const lines = out.split('\n');
    expect(lines[0]).toBe('Q-7  answered: Auth0   (task T-12)');
    expect(lines[1]).toBe('Q-9  open: Region?   (task T-3)');
  });

  it('reports an empty inbox explicitly (never blank output)', () => {
    expect(renderInbox({ answered: [], open: [], cursor: 0 })).toMatch(/inbox empty/);
  });
});
