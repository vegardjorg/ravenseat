// =============================================================
// planPostCheck.test.ts: the follow-up after a plan is built (PG-6, lib/planPostCheck.js;
// plans/plan-gate-vurdering-2026-11-21.md, PG-6).
//
// What the tests prove:
//   - plans.postCheck is on by default and off only for false,
//   - a built plan gets the row (size estimate against tasks plus fix rounds, estimate against measured time, cost),
//     a plan with an open task gets none, and an unsized plan has no estimate,
//   - the success measure is read from the decision section (label on the line, or the line under the heading),
//   - the question comes only with a decision section that names a measure, once, and never before the plan is built,
//   - the answers fill the accuracy record per size.
// =============================================================
import { describe, it, expect } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const PC = require('../planPostCheck.js') as any;
const KK = require('../queueConfig.js') as any;
const L = require('../queueLogic.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const at = (h: number) => new Date(Date.UTC(2026, 10, 10, h)).toISOString();
const task = (id: string, plan: string, own: object = {}) => ({
  id,
  plan,
  title: `Task ${id}`,
  class: 'K',
  content_min: 60,
  status: 'done',
  started: at(0),
  done: at(2),
  ...own,
});
const plan = (id: string, own: object = {}) => ({ id, title: `Plan ${id}`, size: 'M', sources: [], ...own });

const SECTION = [
  '# The plan',
  'Investigation that the follow-up does not need.',
  '## Decision',
  '**Need and evidence:** people asked.',
  '**Success measure:** exports open in a spreadsheet.',
  '**Cost:** two tracks.',
  '## Later',
  '**Success measure:** not this one.',
].join('\n');
const HEADED = ['## Decision', '### Success measure', '', '- Nine of ten exports open first time.', '### Cost', 'Two tracks.'].join('\n');

describe('the plans.postCheck switch', () => {
  it('is on by default and off only for false', () => {
    expect(KK.STANDARD.plans.postCheck).toBe(true);
    expect(PC.postCheckSetup({}).on).toBe(true);
    expect(PC.postCheckSetup({ plans: { postCheck: false } }).on).toBe(false);
    expect(PC.postCheckSetup({ plans: 'odd' }).on).toBe(true);
  });
});

describe('the success measure', () => {
  it('is the text after the label in the decision section, not one from another section', () => {
    expect(PC.successMeasure(SECTION, '#decision')).toBe('exports open in a spreadsheet');
  });

  it('is the first plain line under a heading, without the list mark', () => {
    expect(PC.successMeasure(HEADED, '#decision')).toBe('Nine of ten exports open first time');
  });

  it('is null without a measure, an unknown anchor, or no text', () => {
    expect(PC.successMeasure('## Decision\n**Cost:** x', '#decision')).toBeNull();
    expect(PC.successMeasure(SECTION, '#nowhere')).toBeNull();
    expect(PC.successMeasure(null)).toBeNull();
  });

  it('decisionMeasure reads the source with role decision only', () => {
    const read = (p: string) => (p === 'plans/a.md' ? SECTION : null);
    const e = plan('PL-A', { sources: [{ path: 'plans/a.md', anchor: '#decision', role: 'decision' }] });
    expect(PC.decisionMeasure(e, read)).toBe('exports open in a spreadsheet');
    const other = plan('PL-B', { sources: [{ path: 'plans/a.md', anchor: '#decision', role: 'investigation' }] });
    expect(PC.decisionMeasure(other, read)).toBeNull();
  });
});

describe('the row for a built plan', () => {
  const queue = {
    tasks: [
      task('A-1', 'PL-A', { cost: { phases: { fix_rounds: 2 } } }),
      task('A-2', 'PL-A', { resumed: [{}] }),
      task('A-3', 'PL-A', { status: 'cancelled', done: null }),
      task('B-1', 'PL-B'),
      task('B-2', 'PL-B', { status: 'waiting', done: null, started: null }),
      task('C-1', 'PL-C'),
    ],
  };
  const usd = new Map([['A-1', 1.25], ['A-2', 0.5]]);

  it('compares the size estimate with tasks plus fix rounds, the estimate with the measured time, and has the cost', () => {
    const r = PC.planRow(plan('PL-A'), queue, { estimate: (o: any) => o.content_min, usd });
    expect(r).toMatchObject({
      id: 'PL-A',
      size: 'M',
      maturity: 'built',
      estimate_tasks: 2,
      tasks: 2,
      fix_rounds: 3,
      actual: 5,
      estimate_min: 120,
      measured_min: 240,
      usd: 1.75,
      question: null,
      success: null,
    });
  });

  it('a plan with an open task has no row; an unsized plan shows no estimate', () => {
    expect(PC.planRow(plan('PL-B'), queue)).toBeNull();
    const r = PC.planRow(plan('PL-C', { size: undefined }), queue, { estimate: L.estimate });
    expect(r.size).toBeNull();
    expect(r.estimate_tasks).toBeNull();
    expect(r.usd).toBeNull();
    // The queue's own estimate is used by the callers; it gives a number for a task.
    expect(r.estimate_min).toBeGreaterThan(0);
  });

  it('rows lists only built plans, the last finished first', () => {
    const q = { tasks: [...queue.tasks, task('D-1', 'PL-D', { done: at(5) })] };
    const ids = PC.rows([plan('PL-A'), plan('PL-B'), plan('PL-C'), plan('PL-D')], q).map((r: any) => r.id);
    expect(ids).toEqual(['PL-D', 'PL-A', 'PL-C']);
  });
});

describe('the success question', () => {
  const entry = plan('PL-A', { size: 'L' });

  it('comes only with a measure, with three choices, and holds no task', () => {
    expect(PC.postCheckQuestion(entry, null)).toBeNull();
    const q = PC.postCheckQuestion(entry, 'exports open in a spreadsheet.');
    expect(q.id).toBe('PC-PL-A');
    expect(q.question.text).toBe('PL-A is built. Success measure: exports open in a spreadsheet. Met, partly, not met?');
    expect(q.question.choices).toEqual(['Met', 'Partly', 'Not met']);
    // The queue accepts it as a question.
    const queue: any = { tasks: [], question: {} };
    expect(L.setQuestion(queue, { [q.id]: q.question }).error).toEqual([]);
  });

  it('is due once the plan is built, and never twice', () => {
    const queue: any = { tasks: [task('A-1', 'PL-A'), task('A-2', 'PL-A', { status: 'review', done: null })], question: {} };
    expect(PC.due(queue, entry)).toBe(false);
    queue.tasks[1].status = 'done';
    expect(PC.due(queue, entry)).toBe(true);
    queue.question['PC-PL-A'] = { type: 'question', text: 'x' };
    expect(PC.due(queue, entry)).toBe(false);
    expect(PC.due({ ...queue, question: {}, resolved: ['PC-PL-A'] }, entry)).toBe(false);
  });

  it('the answers fill the accuracy record per size', () => {
    const queue: any = {
      tasks: [task('A-1', 'PL-A'), task('E-1', 'PL-E'), task('E-2', 'PL-E'), task('F-1', 'PL-F')],
      resolutions: { 'PC-PL-A': { answer: 'Met' }, 'PC-PL-E': { answer: 'Not met: only half open' } },
    };
    const measureFor = (e: any) => (e.id === 'PL-F' ? null : 'it works');
    const list = PC.rows([plan('PL-A'), plan('PL-E'), plan('PL-F', { size: 'XL' })], queue, { estimate: () => 60, measureFor });
    expect(list.find((r: any) => r.id === 'PL-A').success).toBe('Met');
    expect(list.find((r: any) => r.id === 'PL-E').success).toBe('Not met');
    expect(list.find((r: any) => r.id === 'PL-F').question).toBeNull();
    const acc = PC.accuracy(list);
    expect(acc.map((g: any) => g.size)).toEqual(['M', 'XL']);
    expect(acc[0]).toMatchObject({ plans: 2, estimate_tasks: 2, actual_avg: 1.5, ratio: 0.75, met: 1, not_met: 1, asked: 2 });
    expect(acc[1]).toMatchObject({ plans: 1, estimate_tasks: 15, ratio: 0.07, asked: 0 });
  });
});
