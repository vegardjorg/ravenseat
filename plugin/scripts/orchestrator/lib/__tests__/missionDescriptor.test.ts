// =============================================================
// missionDescriptor.test.ts: the client-neutral mission descriptor (lib/logic/missionDescriptor.js).
//
// The descriptor carries what every client needs (task, track label, role, client, branch, base sha, prompt file,
// what the queue expects back, effort) and leaves the optional fields out when they are not known. fillRecord is
// the neutral part of a queue-fill.json entry.
// =============================================================
import { describe, it, expect } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const MD = require('../logic/missionDescriptor.js');

const task = { id: 'K3', class: 'K', branch: 'queue/K3', migr_block: 120, title: 'not in the descriptor' };

describe('missionDescriptor', () => {
  it('builds the neutral fields from the task and the call', () => {
    const d = MD.missionDescriptor(task, { client: 'claude', promptFile: '/s/prompt-K3.md', baseSha: 'abc' });
    expect(d).toEqual({
      task_id: 'K3',
      track_id: 'K3',
      role: 'track',
      client: 'claude',
      class: 'K',
      branch: 'queue/K3',
      base_sha: 'abc',
      prompt_file: '/s/prompt-K3.md',
      expects: ['report', 'handover', 'result'],
      effort: 'medium',
      migr_block: 120,
      new: true,
      warning: false,
    });
  });

  it('a resume round has its own track id and branch; the optional fields appear only when given', () => {
    const d = MD.missionDescriptor(
      { id: 'D2', class: 'D+' },
      {
        client: 'claude',
        trackId: 'D2-r2',
        branch: 'queue/D2',
        worktree: '/wt/queue-D2',
        model: 'opus',
        sandbox: 'workspace-write',
        attemptId: 'a1',
        isNew: false,
        warning: true,
      },
    );
    expect(d).toMatchObject({
      task_id: 'D2',
      track_id: 'D2-r2',
      branch: 'queue/D2',
      worktree: '/wt/queue-D2',
      model: 'opus',
      sandbox: 'workspace-write',
      attempt_id: 'a1',
      effort: 'high',
      migr_block: null,
      new: false,
      warning: true,
    });
    const plain = MD.missionDescriptor({ id: 'U1', class: 'U' }, { client: 'claude' });
    for (const k of ['worktree', 'model', 'sandbox', 'attempt_id']) expect(plain).not.toHaveProperty(k);
  });

  it('effortFor: D and D+ high, K and U medium', () => {
    expect(['K', 'U', 'D', 'D+'].map(MD.effortFor)).toEqual(['medium', 'medium', 'high', 'high']);
  });

  it('every descriptor gets its own expects list (the shared one is frozen)', () => {
    const d = MD.missionDescriptor(task, { client: 'claude' });
    expect(d.expects).not.toBe(MD.EXPECTS);
    expect(Object.isFrozen(MD.EXPECTS)).toBe(true);
  });

  it('fillRecord: the neutral queue-fill.json fields', () => {
    const d = MD.missionDescriptor(task, { client: 'claude', promptFile: '/s/prompt-K3.md', warning: true });
    expect(MD.fillRecord(d)).toEqual({
      id: 'K3',
      class: 'K',
      prompt: '/s/prompt-K3.md',
      branch: 'queue/K3',
      migr_block: 120,
      new: true,
      warning: true,
    });
  });
});
