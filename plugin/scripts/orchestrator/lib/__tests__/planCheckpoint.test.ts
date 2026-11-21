// =============================================================
// planCheckpoint.test.ts: PG-4 and PG-8 of the plan gate (plans/plan-gate-vurdering-2026-11-21.md, owner decision
// 2026-11-21 "as recommended").
//
// What the tests prove:
//   PG-4  staged queueing with a checkpoint question (lib/checkpoint.js, the `after` field in lib/logic/questions.js):
//     - the setting plans.checkpoint (off / offer / always, default offer) with a fallback for a bad value,
//     - the offer: a gated plan (L, XL or a zone) is offered staging, "smallest first" is staged without a second
//       question, a small plan and `off` get none,
//     - the question CP-<plan>: type condition, Continue recommended, `after` = the stage-1 tasks; setQuestion takes it
//       and refuses a bad `after`,
//     - the question is hidden (not in the owner's list, not on the board's Waiting on you) until every stage-1 task is
//       done, and resolve refuses it early unless asked to,
//     - Continue lets the rest start, Adjust parks them for a rewrite, Stop parks them (cancelling stays the owner's),
//     - the forecast counts every task, the staged rest included,
//     - the board card of a task that waits on it carries `checkpoint` (the "Waiting on checkpoint" badge).
//   PG-8  the large unplanned batch line at add (lib/planGate.js largeBatchLine): 5 unplanned warn, 5 with a plan or
//     4 do not, 0 is off, shaped tasks were already asked, and the estimate over a week at the measured pace warns.
// =============================================================
import { describe, it, expect } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const CP = require('../checkpoint.js') as any;
const G = require('../planGate.js') as any;
const L = require('../queueLogic.js') as any;
const T = require('../queueBoard.js') as any;
const F = require('../queueForecast.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const NOW = Date.parse('2026-11-21T12:00:00.000Z');
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

const task = (id: string, status: string, own: object = {}) => ({
  id,
  title: `Task ${id}`,
  domain: 'ui',
  class: 'K',
  value: 5,
  content_min: 90,
  status,
  depends_on: [],
  waiting_on: [],
  owned_files: [`file/${id}.ts`],
  owner_db: [],
  shared_patch: [],
  mission: `do ${id}`,
  added_by: 'owner',
  added_at: ago(600),
  ...(status === 'done' ? { done: ago(30) } : {}),
  ...own,
});

function makeQueue(tasks: object[], question: object = {}) {
  return {
    created: ago(1000),
    limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
    tasks,
    projects: {},
    areas: {},
    question,
    resolved: [] as string[],
    resolutions: {},
    changelog: [],
  };
}

/** A staged plan: EX-1 and EX-2 are stage 1, EX-3..EX-5 wait on CP-PL-EX-1. */
function staged(stageStatus = 'waiting') {
  const cp = CP.checkpointQuestion({ plan: 'PL-EX-1', stage: ['EX-1', 'EX-2'], success: 'exports open in a spreadsheet' });
  const queue = makeQueue([
    task('EX-1', stageStatus),
    task('EX-2', stageStatus),
    ...['EX-3', 'EX-4', 'EX-5'].map((id) => task(id, 'waiting', { waiting_on: [cp.id] })),
  ]);
  const s = L.setQuestion(queue, { [cp.id]: cp.question }, ago(500));
  if (s.error.length) throw new Error(s.error.join('; '));
  return { queue, sp: cp.id };
}

describe('PG-4 the setting', () => {
  it('offer by default, each value read on its own, a bad one falls back', () => {
    expect(CP.checkpointSetup({}).mode).toBe('offer');
    expect(CP.checkpointSetup({ plans: { checkpoint: 'always' } }).mode).toBe('always');
    expect(CP.checkpointSetup({ plans: { checkpoint: 'off' } }).mode).toBe('off');
    expect(CP.checkpointSetup({ plans: { checkpoint: 'sometimes' } }).mode).toBe('offer');
    expect(CP.checkpointSetup({ plans: 'x' }).mode).toBe('offer');
  });
});

describe('PG-4 the offer', () => {
  it('a gated plan is offered staging; offer asks, always stages without asking', () => {
    const o = CP.stagingOffer({ mode: 'offer', entry: { id: 'PL-EX-1', size: 'L' } });
    expect(o.offer).toBe(true);
    expect(o.ask).toBe(true);
    expect(o.why).toMatch(/size L/);
    expect(o.choices.map((c: any) => c.key)).toEqual(['stage', 'all']);
    expect(o.choices[0].recommended).toBe(true);
    const a = CP.stagingOffer({ mode: 'always', entry: { id: 'PL-EX-1', size: 'XL' } });
    expect(a.offer).toBe(true);
    expect(a.ask).toBe(false);
  });

  it('a zone makes a small plan gated too', () => {
    expect(CP.stagingOffer({ mode: 'offer', entry: { id: 'PL-EX-1', size: 'S' }, zones: ['D-0001'] }).offer).toBe(true);
  });

  it('"smallest version first" is staged without a second question', () => {
    const o = CP.stagingOffer({ mode: 'offer', smallest: true });
    expect(o.offer).toBe(true);
    expect(o.ask).toBe(false);
  });

  it('a small plan, no plan, and off get no offer', () => {
    expect(CP.stagingOffer({ mode: 'offer', entry: { id: 'PL-EX-1', size: 'M' } }).offer).toBe(false);
    expect(CP.stagingOffer({ mode: 'offer' }).offer).toBe(false);
    expect(CP.stagingOffer({ mode: 'off', entry: { id: 'PL-EX-1', size: 'XL' } }).offer).toBe(false);
    expect(CP.stagingOffer({ mode: 'off', smallest: true }).offer).toBe(false);
  });
});

describe('PG-4 the checkpoint question', () => {
  it('CP-<plan>, a condition with Continue recommended and the stage-1 tasks in after', () => {
    const cp = CP.checkpointQuestion({ plan: 'PL-EX-1', stage: ['EX-1', 'EX-2'], success: 'exports open in a spreadsheet' });
    expect(cp.error).toEqual([]);
    expect(cp.id).toBe('CP-PL-EX-1');
    expect(cp.question.type).toBe('condition');
    expect(cp.question.text).toMatch(/^The first part is done\. Success measure: exports open in a spreadsheet\. Continue, adjust or stop\?$/);
    // The board says step for a focus step and never stage (queueFocusB17.test.ts), so the question's texts say neither.
    expect(` `).not.toMatch(/\bstages?\b/i);
    expect(cp.question.recommendation).toBe('Continue');
    expect(cp.question.choices).toEqual(['Continue', 'Adjust', 'Stop']);
    expect(cp.question.after).toEqual(['EX-1', 'EX-2']);
    // Every choice fits a button (setQuestion's limits).
    expect(L.choicesError(cp.question.choices)).toEqual([]);
  });

  it('without a plan the id follows the first stage task; without a measure the text says where to look', () => {
    const cp = CP.checkpointQuestion({ stage: ['AB-7'] });
    expect(cp.id).toBe('CP-AB-7');
    expect(cp.question.text).toMatch(/Success measure: the first part's acceptance criteria/);
  });

  it('refuses an empty stage and an id over the question id limit', () => {
    expect(CP.checkpointQuestion({ plan: 'PL-EX-1', stage: [] }).error.join(' ')).toMatch(/stage/);
    expect(CP.checkpointQuestion({ plan: `PL-${'X'.repeat(40)}`, stage: ['EX-1'] }).error.join(' ')).toMatch(/40/);
  });

  it('setQuestion stores after, and refuses one that is not a short list of task ids', () => {
    const q = makeQueue([]);
    expect(L.setQuestion(q, { 'CP-A': { type: 'condition', text: 't', after: ['EX-1'] } }).error).toEqual([]);
    expect((q.question as any)['CP-A'].after).toEqual(['EX-1']);
    for (const bad of [[], 'EX-1', [''], ['a b'], Array.from({ length: 21 }, (_, i) => `EX-${i}`)])
      expect(L.setQuestion(makeQueue([]), { 'CP-B': { type: 'condition', text: 't', after: bad } }).error.join(' ')).toMatch(/after/);
    // null removes it.
    expect(L.setQuestion(q, { 'CP-A': { after: null } }).error).toEqual([]);
    expect((q.question as any)['CP-A'].after).toBeUndefined();
  });
});

describe('PG-4 hidden until stage 1 is done', () => {
  it('not in the owner list or on Waiting on you while a stage task is open', () => {
    const { queue, sp } = staged('waiting');
    expect(L.questionHidden(queue, sp)).toBe(true);
    expect(L.questionPending(queue, sp)).toEqual(['EX-1', 'EX-2']);
    const row = L.questionOverview(queue).find((r: any) => r.sp === sp);
    expect(row.hidden).toBe(true);
    expect(row.opens_after).toEqual(['EX-1', 'EX-2']);
    expect(T.board(queue, { now: NOW }).inbox.question.map((q: any) => q.sp)).not.toContain(sp);
  });

  it('opens when every stage task is done (a cancelled or archived one counts as finished)', () => {
    const { queue, sp } = staged('done');
    expect(L.questionHidden(queue, sp)).toBe(false);
    expect(T.board(queue, { now: NOW }).inbox.question.map((q: any) => q.sp)).toContain(sp);
    const mixed = staged('done');
    mixed.queue.tasks[0].status = 'cancelled';
    mixed.queue.tasks.splice(1, 1); // EX-2 archived: no longer in the task list
    expect(L.questionHidden(mixed.queue, mixed.sp)).toBe(false);
    // One stage task still running keeps it hidden.
    const half = staged('done');
    half.queue.tasks[1].status = 'running';
    expect(L.questionHidden(half.queue, half.sp)).toBe(true);
  });

  it('a question without after is never hidden', () => {
    const q = makeQueue([task('EX-1', 'waiting', { waiting_on: ['Q-1'] })], { 'Q-1': { type: 'question', text: 'Which?' } });
    expect(L.questionHidden(q, 'Q-1')).toBe(false);
    expect(T.board(q, { now: NOW }).inbox.question.map((x: any) => x.sp)).toContain('Q-1');
  });

  it('resolve refuses it early, and early: true lets it through', () => {
    const { queue, sp } = staged('waiting');
    const r = L.resolve(queue, [sp], { choice: 'Continue' });
    expect(r.error.join(' ')).toMatch(/opens when EX-1, EX-2 are done/);
    expect(queue.resolved).toEqual([]);
    expect(L.resolve(queue, [sp], { choice: 'Continue', early: true }).error).toEqual([]);
  });
});

describe('PG-4 the answer', () => {
  const answer = (pick: string) => {
    const { queue, sp } = staged('done');
    const s = L.resolve(queue, [sp], { choice: pick, by: 'owner', now: ago(1) });
    if (s.error.length) throw new Error(s.error.join('; '));
    L.ownerAnswerBonus(queue, [sp], s.answer, ago(1));
    const r = CP.ownerChoice(queue, sp, s.answer, { by: 'owner', now: ago(1) });
    return { queue, sp, r };
  };
  const rest = (queue: any) => queue.tasks.filter((o: any) => ['EX-3', 'EX-4', 'EX-5'].includes(o.id));

  it('Continue starts the rest, with the answer in their missions', () => {
    const { queue, r } = answer('Continue');
    expect(r.action).toBe('continue');
    expect(rest(queue).every((o: any) => !o.parked)).toBe(true);
    expect(rest(queue).every((o: any) => o.bonus.some((b: any) => /OWNER_ANSWER CP-PL-EX-1 .*: Continue$/.test(b.text)))).toBe(true);
    const next = L.selectNext(queue, NOW).map((x: any) => x.id);
    expect(next).toEqual(expect.arrayContaining(['EX-3', 'EX-4', 'EX-5']));
  });

  it('Adjust parks the rest for a rewrite', () => {
    const { queue, r } = answer('Adjust');
    expect(r.action).toBe('adjust');
    expect(r.ids).toEqual(['EX-3', 'EX-4', 'EX-5']);
    for (const o of rest(queue)) {
      expect(o.parked.reason).toMatch(/rewrite the mission after checkpoint CP-PL-EX-1/);
      expect(o.status).toBe('waiting');
    }
    expect(L.selectNext(queue, NOW).map((x: any) => x.id)).not.toContain('EX-3');
  });

  it('Stop parks the rest and never cancels them', () => {
    const { queue, r } = answer('Stop');
    expect(r.action).toBe('stop');
    for (const o of rest(queue)) {
      expect(o.status).toBe('waiting');
      expect(o.parked.reason).toMatch(/stop at checkpoint CP-PL-EX-1: cancel/);
    }
  });

  it('another question is not a checkpoint (null)', () => {
    const q = makeQueue([task('EX-1', 'waiting', { waiting_on: ['Q-1'] })], { 'Q-1': { type: 'question', text: 'Which?' } });
    expect(CP.ownerChoice(q, 'Q-1', 'Stop')).toBeNull();
  });
});

describe('PG-4 the forecast and the card', () => {
  it('the forecast counts the staged rest too', () => {
    const { queue } = staged('waiting');
    expect(F.remainingTasks(queue, { now: NOW }).tasks.map((o: any) => o.id).sort()).toEqual(['EX-1', 'EX-2', 'EX-3', 'EX-4', 'EX-5']);
  });

  it('a card that waits on a hidden checkpoint carries it, closed; after stage 1 it is open', () => {
    const { queue, sp } = staged('waiting');
    const card = T.board(queue, { now: NOW }).columns.queue.find((k: any) => k.id === 'EX-3');
    expect(card.checkpoint).toEqual({ sp, open: false, pending: ['EX-1', 'EX-2'] });
    expect(T.board(queue, { now: NOW }).columns.queue.find((k: any) => k.id === 'EX-1').checkpoint).toBeUndefined();
    const done = staged('done');
    const open = T.board(done.queue, { now: NOW }).columns.queue.find((k: any) => k.id === 'EX-3');
    expect(open.checkpoint).toEqual({ sp: done.sp, open: true, pending: [] });
  });
});

describe('PG-8 the large unplanned batch line', () => {
  const batch = (n: number, own: object = {}) => Array.from({ length: n }, (_, i) => task(`NB-${i + 1}`, 'waiting', own));
  const est = (o: any) => L.estimate(o);

  it('the setting: 5 by default, 0 is off, a bad value falls back', () => {
    expect(G.largeBatchSetup({}).min).toBe(5);
    expect(G.largeBatchSetup({ add: { largeBatchWarn: 0 } }).min).toBe(0);
    expect(G.largeBatchSetup({ add: { largeBatchWarn: 8 } }).min).toBe(8);
    expect(G.largeBatchSetup({ add: { largeBatchWarn: -1 } }).min).toBe(5);
    expect(G.largeBatchSetup({ add: { largeBatchWarn: 'x' } }).min).toBe(5);
  });

  it('5 unplanned warn; 5 with a plan, 4, and 0 (off) do not', () => {
    expect(G.largeBatchLine(batch(5), { min: 5, estimate: est })).toMatch(
      /^WARNING: large batch without a plan entry \(5 tasks.*\); consider \/plans first/,
    );
    expect(G.largeBatchLine(batch(5, { plan: 'PL-EX-1' }), { min: 5, estimate: est })).toBeNull();
    expect(G.largeBatchLine(batch(4), { min: 5, estimate: est })).toBeNull();
    expect(G.largeBatchLine(batch(9), { min: 0, estimate: est })).toBeNull();
  });

  it('tasks that already answered the shape question do not count', () => {
    expect(G.largeBatchLine(batch(6, { shaped: 'skipped' }), { min: 5, estimate: est })).toBeNull();
  });

  it('fewer tasks, but over a week at the measured pace, warn too', () => {
    // 3 tasks of 90 min (plus overhead) against a pace of 120 min a week.
    const line = G.largeBatchLine(batch(3), { min: 5, pace: 120, estimate: est });
    expect(line).toMatch(/over a week at the current pace/);
    expect(G.largeBatchLine(batch(3), { min: 5, pace: 100_000, estimate: est })).toBeNull();
    expect(G.largeBatchLine(batch(1), { min: 5, pace: 10, estimate: est })).toBeNull();
  });

  it('weekPace: the estimate done per week over 28 days, null with fewer than 5 done', () => {
    const done = Array.from({ length: 8 }, (_, i) => task(`D-${i}`, 'done', { done: ago(60 * 24 * (i + 1)) }));
    const pace = G.weekPace(done, { now: NOW, estimate: est });
    expect(pace).toBeCloseTo((8 * est(done[0])) / 4, 5);
    expect(G.weekPace(done.slice(0, 4), { now: NOW, estimate: est })).toBeNull();
    const old = done.map((o) => ({ ...o, done: ago(60 * 24 * 40) }));
    expect(G.weekPace(old, { now: NOW, estimate: est })).toBeNull();
  });
});
