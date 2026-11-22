// =============================================================
// taskHistory.test.ts: the history of one task in lib/taskHistory.js (roadmap 0ø J5).
//
// Locks: the steps come only from data that already exists (the task's own fields, its blocks and fix rounds, the
// queue's questions, answers and changelog, the time log rows for the task and the review findings), oldest first,
// with the time since the step before; failures are marked; only ids, codes, counts, field names and times are shown,
// never a question's text, an answer, a note, a remark or a changed value (status values excepted, they are fixed
// words); another task's rows are never mixed in; a broken input gives a shorter list, never a throw; the CLI lines.
// =============================================================
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const TH = require('../taskHistory.js');

const H = 3_600_000;
const NOW = Date.parse('2026-11-22T07:00:00.000Z');
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * H).toISOString();

/** One task's whole life: added, approved, started, a red gate, delivered, review with findings, a fix round, a block, merged. */
function life() {
  const task = {
    id: 'EX-7',
    status: 'done',
    added_at: at(30),
    added_by: 'owner',
    approved: at(29),
    picked_at: at(20),
    started: at(19.5),
    delivered: at(15),
    t_receive: at(14.5),
    done: at(10),
    merge_commit: 'abcdef1234567890',
    qa_ok: at(9),
    qa_ok_by: 'owner',
    remarks: ['secret remark text'],
    resumed: [{ round: 1, reason: 'fix', time: at(14), from: ['security'] }],
    blocks: [{ code: 'merge-conflict', from: at(12), to: at(11), note: 'private note' }],
    waiting_on: ['Q1'],
  };
  const other = { id: 'EX-8', status: 'waiting', added_at: at(5), waiting_on: ['Q2'] };
  const queue = {
    tasks: [task, other],
    question: {
      Q1: { type: 'question', text: 'Secret question text', added_at: at(13) },
      Q2: { type: 'question', text: 'Other question', added_at: at(4) },
    },
    resolutions: { Q1: { time: at(12.5), answer: 'private answer', by: 'owner' } },
    changelog: [
      { nr: 1, at: at(25), by: 'owner', action: 'edit', changes: [{ id: 'EX-7', field: 'title', before: 'old secret', after: 'new secret' }] },
      { nr: 2, at: at(24), by: 'theBoard', action: 'edit', changes: [{ id: 'EX-8', field: 'priority', before: 1, after: 2 }] },
    ],
  };
  const rows = [
    { time: at(18), event: 'gate', track: 'EX-7', kind: 'track', ok: false, failed: ['npm test'] },
    { time: at(16), event: 'gate', track: 'EX-7', kind: 'track', ok: true, failed: [] },
    { time: at(17), event: 'gate', track: 'EX-8', kind: 'track', ok: false, failed: ['tsc'] },
    { time: at(14), event: 'fixRound', task: 'EX-7', reason: 'fix', round: 1 },
    { time: at(12), event: 'mergeConflict', task: 'EX-7', files: 2 },
    { time: at(8), event: 'ciWatch', task: 'EX-7', verdict: 'red', sha: 'fedcba9876543210' },
  ];
  const findings = [
    { time: at(14.2), task: 'EX-7', caught_by: 'review:security', severity: 'M', round: 1, excerpt: 'secret finding text' },
    { time: at(14.2), task: 'EX-7', caught_by: 'review:code', severity: 'L', round: 1, excerpt: 'x' },
    { time: at(14.2), task: 'EX-7', caught_by: 'review:code', severity: 'H', round: 1, excerpt: 'y' },
    { time: at(13.8), task: 'EX-7', caught_by: 'gate', severity: 'H', excerpt: 'not review' },
    { time: at(3), task: 'EX-8', caught_by: 'review:code', severity: 'H', round: 1, excerpt: 'other task' },
  ];
  return { task, queue, rows, findings };
}

describe('taskHistory', () => {
  it('builds the steps oldest first from the existing data, with the time since the step before', () => {
    const h = TH.taskHistory({ ...life(), now: NOW });
    const kinds = h.steps.map((s: any) => s.kind);
    expect(kinds).toEqual([
      'added',
      'approved',
      'edited',
      'picked',
      'started',
      'gate-red',
      'gate-green',
      'delivered',
      'received',
      'review',
      'fix-round',
      'question',
      'answered',
      'conflict',
      'blocked',
      'unblocked',
      'merged',
      'qa-ok',
      'ci-red',
    ]);
    const times = h.steps.map((s: any) => Date.parse(s.time));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(h.steps[0].gap_ms).toBeNull();
    expect(h.steps[1].gap_ms).toBe(1 * H);
    expect(h.span_ms).toBe(22 * H);
  });

  it('marks failures and says what happened with ids, codes, counts and field names only', () => {
    const h = TH.taskHistory({ ...life(), now: NOW });
    const by = (k: string) => h.steps.find((s: any) => s.kind === k);
    expect(by('gate-red').fail).toBe(true);
    expect(by('gate-red').text).toContain('npm test');
    expect(by('gate-green').fail).toBe(false);
    expect(by('blocked').fail).toBe(true);
    expect(by('blocked').text).toContain('merge-conflict');
    expect(by('review').text).toBe('Review round 1: H 1, M 1, L 1');
    expect(by('review').fail).toBe(true);
    expect(by('fix-round').text).toContain('round 1');
    expect(by('merged').text).toContain('abcdef1');
    expect(by('question').text).toContain('Q1');
    expect(by('answered').text).toContain('by you');
    expect(by('edited').text).toContain('title');
    expect(by('ci-red').fail).toBe(true);
    const all = JSON.stringify(h);
    for (const secret of ['Secret question text', 'private answer', 'private note', 'secret remark text', 'old secret', 'new secret', 'secret finding text'])
      expect(all).not.toContain(secret);
  });

  it('keeps another task out and counts a fix round once when the queue and the time log both have it', () => {
    const h = TH.taskHistory({ ...life(), now: NOW });
    expect(h.steps.filter((s: any) => s.kind === 'fix-round')).toHaveLength(1);
    expect(JSON.stringify(h)).not.toContain('tsc');
    expect(JSON.stringify(h)).not.toContain('Q2');
    expect(h.steps.filter((s: any) => s.kind === 'review')).toHaveLength(1);
  });

  it('takes a fix round from the time log when the task has no resumed list', () => {
    const { task, queue, rows, findings } = life();
    const t2 = { ...task, resumed: undefined };
    const h = TH.taskHistory({ task: t2, queue, rows, findings, now: NOW });
    expect(h.steps.filter((s: any) => s.kind === 'fix-round')).toHaveLength(1);
  });

  it('shows a status change from the changelog with its before and after, and a cancel', () => {
    const task = { id: 'EX-9', status: 'cancelled', added_at: at(5) };
    const queue = {
      tasks: [task],
      changelog: [{ nr: 3, at: at(2), by: 'owner', action: 'cancel', changes: [{ id: 'EX-9', field: 'status', before: 'waiting', after: 'cancelled' }] }],
    };
    const h = TH.taskHistory({ task, queue, rows: [], findings: [], now: NOW });
    const last = h.steps[h.steps.length - 1];
    expect(last.kind).toBe('status');
    expect(last.text).toBe('Status waiting -> cancelled by you');
  });

  it('marks an open block as still open and counts its time up to now', () => {
    const task = { id: 'EX-10', status: 'waiting', added_at: at(5), blocks: [{ code: 'gate-red', from: at(3) }] };
    const h = TH.taskHistory({ task, queue: { tasks: [task] }, rows: [], findings: [], now: NOW });
    const b = h.steps.find((s: any) => s.kind === 'blocked');
    expect(b.text).toContain('still open');
    expect(b.text).toContain('3 h');
    expect(h.open).toBe(true);
  });

  it('never throws on broken input and gives an empty list without a task', () => {
    expect(TH.taskHistory({ task: null } as any).steps).toEqual([]);
    const h = TH.taskHistory({
      task: { id: 'EX-11', added_at: 'not a date', blocks: 'x', resumed: [null, 5], started: at(1) },
      queue: { tasks: 'x', question: null, changelog: [null, { changes: 'x' }] },
      rows: [null, 'x', { event: 'gate' }],
      findings: 'x',
      now: NOW,
    } as any);
    expect(h.steps.map((s: any) => s.kind)).toEqual(['started']);
  });
});

describe('historyLines', () => {
  it('prints one line per step with the local time, the gap and an x for a failure', () => {
    const h = TH.taskHistory({ ...life(), now: NOW });
    const lines = TH.historyLines(h, { now: NOW });
    expect(lines[0]).toMatch(/^History of EX-7: 19 steps over 22 h/);
    expect(lines.some((l: string) => /^\s+\S.* x Track gate red: npm test/.test(l))).toBe(true);
    expect(lines.some((l: string) => l.includes('(+1 h)'))).toBe(true);
  });

  it('says so when there is nothing to show', () => {
    expect(TH.historyLines(TH.taskHistory({ task: { id: 'EX-12' }, now: NOW }), { now: NOW })).toEqual(['History of EX-12: nothing recorded yet.']);
  });
});
