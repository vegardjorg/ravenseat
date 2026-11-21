// =============================================================
// planReview.test.ts: the narrow review before a risky task starts (DR-1, plans/drift-vurdering-2026-11-21.md section
// 5; lib/planReview.js, its part of lib/queueTriage.js).
//
// Locks: (1) a risky task (class D+ by default, or any task in an accepted zone) needs a plan review before it starts;
// a K task does not; mode off turns it off; a review newer than the last edit holds; (2) the triage and the plan review
// of one task are ONE step (one candidate, one prompt with both answers); (3) advisory: notes go into the mission (the
// bonus) and the task can start; ask is also a note; (4) block: ask becomes an owner question and the task does not
// start until the owner answers; (5) a note without file:line is dropped; (6) the prompt carries the fixed checklist,
// and for a zone task the reversibility points; (7) the defaults: advisory for D+.
// Pure.
// =============================================================
import { describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const PR = require('../planReview.js') as any;
const T = require('../queueTriage.js') as any;
const K = require('../queueConfig.js') as any;
const L = require('../queueLogic.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();
const conf = (own: Record<string, unknown> = {}) => K.merge(K.STANDARD, own);
const task = (id: string, extra: Record<string, unknown> = {}): any => ({
  id,
  title: `Task ${id}`,
  domain: `dom-${id}`,
  class: 'K',
  status: 'waiting',
  mission: `The mission for ${id}.`,
  value: 5,
  content_min: 30,
  added_at: ago(0),
  ...extra,
});
// The D+ fixture: the mission adds a column, but the task owns no migration file.
const risky = () =>
  task('DB1', { class: 'D+', owned_files: ['src/api/users.ts'], mission: 'Add a column last_seen to users and show it in the API.' });
const planSetup = (own: Record<string, unknown> = {}) => PR.setupOf(conf(own));
const zone = { id: 'D-0001', title: 'Sign-in', reason: 'Sessions are hard to migrate.', why: 'files', detail: 'src/auth/a.ts' };

describe('the defaults', () => {
  it('advisory for D+, block exists but is off', () => {
    expect(K.STANDARD.planReview).toEqual({ mode: 'advisory', classes: ['D+'] });
    expect(PR.MODES).toEqual(['off', 'advisory', 'block']);
    expect(planSetup()).toEqual({ mode: 'advisory', classes: ['D+'], on: true });
    expect(planSetup({ planReview: { mode: 'nonsense' } }).mode).toBe('advisory');
  });
});

describe('which tasks need a plan review (needsPlanReview)', () => {
  it('a D+ task does, a K task does not, a K task in a zone does', () => {
    const q = { tasks: [risky(), task('K1')] };
    expect(PR.needsPlanReview(q.tasks[0], q, { setup: planSetup() })).toEqual({ need: true, reason: 'plan review: class D+' });
    expect(PR.needsPlanReview(q.tasks[1], q, { setup: planSetup() }).need).toBe(false);
    const z = PR.needsPlanReview(q.tasks[1], q, { setup: planSetup(), zones: [zone] });
    expect(z.need).toBe(true);
    expect(z.reason).toBe('plan review: zone D-0001 Sign-in (files: src/auth/a.ts)');
  });

  it('mode off, other classes, continuations and a fresh review', () => {
    const o = risky();
    const q = { tasks: [o] };
    expect(PR.needsPlanReview(o, q, { setup: planSetup({ planReview: { mode: 'off' } }) }).need).toBe(false);
    expect(PR.needsPlanReview(task('D1', { class: 'D' }), q, { setup: planSetup({ planReview: { classes: ['D', 'D+'] } }) }).need).toBe(true);
    expect(PR.needsPlanReview({ ...o, branch: 'queue/DB1' }, q, { setup: planSetup() }).need).toBe(false);
    expect(PR.needsPlanReview({ ...o, plan_review: { result: 'ok', at: ago(0) } }, q, { setup: planSetup() }).need).toBe(false);
    // An edit after the review asks again.
    const edited = { ...o, added_at: ago(5), plan_review: { result: 'ok', at: ago(3) } };
    const log = { tasks: [edited], changelog: [{ nr: 1, at: ago(1), by: 'x', action: 'edit', changes: [{ id: 'DB1', field: 'mission' }] }] };
    expect(PR.needsPlanReview(edited, log, { setup: planSetup() }).need).toBe(true);
  });
});

describe('one step with the triage', () => {
  it('a task that needs both is one candidate with both reasons', () => {
    const o = { ...risky(), added_at: ago(4) };
    const q = { tasks: [o, task('K1')] };
    const list = T.triageCandidates(q, { now: NOW, setup: T.triageSetup(conf(), q), planSetup: planSetup() });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: 'DB1', plan: true, reason: 'added or last edited 4 days ago; plan review: class D+' });
  });

  it('a plan review alone is a candidate too, also with the triage switched off', () => {
    const q = { tasks: [risky()] };
    const off = T.triageSetup(conf({ helpers: { triage: { enabled: false } } }), q);
    const list = T.triageCandidates(q, { now: NOW, setup: off, planSetup: planSetup() });
    expect(list.map((x: any) => [x.id, x.plan, x.triage])).toEqual([['DB1', true, false]]);
    // Without a plan setup the triage behaves exactly as before.
    expect(T.triageCandidates(q, { now: NOW, setup: off })).toEqual([]);
  });

  it('the prompt carries the fixed checklist and the PLANREVIEW answer', () => {
    const p = T.triagePrompt(risky(), { reason: 'plan review: class D+', base: 'main', planReview: { zones: [] } });
    expect(p).toMatch(/## Plan review/);
    for (const point of [/data model and migrations/i, /public interfaces and file formats/i, /irreversible steps/i, /file boundaries/i, /contradicts/i])
      expect(p).toMatch(point);
    expect(p).toMatch(/PLANREVIEW ok/);
    expect(p).toMatch(/file:line/);
    expect(p).not.toMatch(/reversed/);
    const z = T.triagePrompt(risky(), { reason: 'x', base: 'main', planReview: { zones: [zone] } });
    expect(z).toMatch(/D-0001 Sign-in/);
    expect(z).toMatch(/can it be reversed/i);
    // A plain triage prompt has no plan review part.
    expect(T.triagePrompt(risky(), { reason: 'x', base: 'main' })).not.toMatch(/PLANREVIEW/);
  });
});

describe('recording the answer (recordPlanReview)', () => {
  const NOTE = 'src/api/users.ts:40 reads users directly; the column needs a migration in db/migrations/, which is not in owned_files.';

  it('advisory: notes go into the mission and the task can start', () => {
    const q: any = { tasks: [risky()] };
    const r = PR.recordPlanReview(q, 'DB1', { result: 'notes', note: NOTE, setup: planSetup(), now: ago(0) });
    expect(r.error).toBe(null);
    const o = q.tasks[0];
    expect(o.plan_review).toMatchObject({ result: 'notes', note: NOTE });
    expect(o.bonus.at(-1).text).toMatch(/^PLAN REVIEW notes \(2026-11-01\): src\/api\/users\.ts:40/);
    expect(L.bonusBlock(o)).toMatch(/PLAN REVIEW notes/);
    expect(L.blockers(o, q.tasks, []).length).toBe(0);
    expect(PR.needsPlanReview(o, q, { setup: planSetup(), now: NOW }).need).toBe(false);
  });

  it('advisory: ask is a note too, no owner question', () => {
    const q: any = { tasks: [risky()] };
    const r = PR.recordPlanReview(q, 'DB1', { result: 'ask', note: NOTE, setup: planSetup(), now: ago(0) });
    expect(r.question).toBe(null);
    expect(q.tasks[0].waiting_on ?? []).toEqual([]);
    expect(q.tasks[0].bonus.at(-1).text).toMatch(/^PLAN REVIEW ask \(2026-11-01\)/);
  });

  it('block: ask becomes an owner question and the task does not start until the answer', () => {
    const q: any = { tasks: [risky()] };
    const r = PR.recordPlanReview(q, 'DB1', { result: 'ask', note: NOTE, setup: planSetup({ planReview: { mode: 'block' } }), now: ago(0) });
    expect(r.question).toBe('planreview-DB1');
    const o = q.tasks[0];
    expect(o.waiting_on).toEqual(['planreview-DB1']);
    expect(q.question['planreview-DB1'].choices).toEqual(['Keep and start anyway', 'Rewrite']);
    expect(L.blockers(o, q.tasks, q.resolved ?? []).length).toBeGreaterThan(0);
    // The owner keeps it: it can start.
    q.resolved = ['planreview-DB1'];
    delete q.question['planreview-DB1'];
    const c = T.ownerChoice(q, 'planreview-DB1', 'Keep and start anyway', { now: ago(0) });
    expect(c).toMatchObject({ id: 'DB1', action: 'keep' });
    expect(o.plan_review.kept_at).toBe(ago(0));
  });

  it('a note without file:line is dropped (recorded as ok, with a remark)', () => {
    const q: any = { tasks: [risky()] };
    const r = PR.recordPlanReview(q, 'DB1', { result: 'notes', note: 'The plan looks a bit thin.', setup: planSetup(), now: ago(0) });
    expect(r.error).toBe(null);
    expect(r.dropped).toBe(true);
    expect(q.tasks[0].plan_review).toMatchObject({ result: 'ok', dropped: 'notes' });
    expect(q.tasks[0].bonus ?? []).toEqual([]);
    expect(q.tasks[0].remarks.at(-1)).toMatch(/dropped: no file:line/);
  });

  it('refuses an unknown result, a missing note, an unknown or started task', () => {
    const q: any = { tasks: [risky(), task('R', { status: 'running' })] };
    expect(PR.recordPlanReview(q, 'DB1', { result: 'maybe', setup: planSetup() }).error).toMatch(/ok, notes, ask/);
    expect(PR.recordPlanReview(q, 'DB1', { result: 'notes', setup: planSetup() }).error).toMatch(/needs --plan-note/);
    expect(PR.recordPlanReview(q, 'NOPE', { result: 'ok', setup: planSetup() }).error).toMatch(/unknown task/);
    expect(PR.recordPlanReview(q, 'R', { result: 'ok', setup: planSetup() }).error).toMatch(/waiting/);
  });
});
