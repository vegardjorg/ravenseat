// =============================================================
// queueTimelinePlan.test.ts: what a Timeline drop does to the plan, in words (roadmap TIDSLINJE T-B; plans/
// gantt-utredning-2026-11-18.md section 3, "Én ny ting trengs").
//
// Locks: applyChanges puts a dry run's changes on a copy (the queue itself is never touched); planChange compares two
// schedules and says which step ends how much earlier or later and which task starts first, never a clock time and
// never a step that moved less than the threshold; planEffect plays both queues with the same model and caps, so a rank
// and a focus reorder give a real sentence.
// =============================================================
import { describe, it, expect } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const QT = require('../queueTimeline.js') as any;
const L = require('../queueLogic.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports */

const NOW = Date.parse('2026-11-20T09:00:00Z');
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();

describe('applyChanges', () => {
  it('puts task and project changes on a copy; null removes the field; the queue is untouched', () => {
    const queue = { tasks: [{ id: 'A-1', priority_bonus: 2 }, { id: 'A-2' }], projects: { a: { title: 'A', pause: true } } };
    const before = JSON.stringify(queue);
    const copy = QT.applyChanges(queue, [
      { id: 'A-1', field: 'priority_bonus', before: 2, after: null },
      { id: 'A-2', field: 'priority_bonus', before: null, after: 1.5 },
      { pid: 'a', field: 'pause', before: true, after: null },
    ]);
    expect(JSON.stringify(queue)).toBe(before);
    expect(copy.tasks[0]).not.toHaveProperty('priority_bonus');
    expect(copy.tasks[1].priority_bonus).toBe(1.5);
    expect(copy.projects.a).not.toHaveProperty('pause');
  });
});

describe('planChange: two schedules in words', () => {
  const s = (tasks: object[], steps: object[]) => ({ now: iso(NOW), tasks, steps });
  const row = (id: string, step: number | null, startH: number, endH: number, extra = {}) => ({
    id,
    step,
    start: iso(NOW + startH * H),
    end: iso(NOW + endH * H),
    running: false,
    ...extra,
  });
  const step = (i: number | null, stage: string | null, title: string, endH: number | null) => ({
    step: i,
    stage,
    title,
    p50_end: endH == null ? null : iso(NOW + endH * H),
  });

  it('a step that ends later and the task that now starts first', () => {
    const before = s(
      [row('A-1', 0, 0, 1), row('A-2', 0, 1, 2), row('B-1', 1, 2, 4)],
      [step(0, 'project:a', 'Alpha', 2), step(1, 'project:b', 'Beta', 4)],
    );
    const after = s(
      [row('A-2', 0, 0, 1), row('A-1', 0, 1, 2), row('B-1', 1, 5, 7)],
      [step(0, 'project:a', 'Alpha', 2), step(1, 'project:b', 'Beta', 7)],
    );
    const r = QT.planChange(before, after, { moved: ['A-2'] });
    expect(r.sentence).toBe('Step 2 (Beta) done about 3 h later; A-2 starts first in step 1 (Alpha).');
    expect(r.sentence).not.toMatch(/\d\d:\d\d/);
  });

  it('a focus reorder: steps matched by their key, numbered as after the change', () => {
    const before = s(
      [row('A-1', 0, 0, 2), row('B-1', 1, 2, 3)],
      [step(0, 'project:a', 'Alpha', 2), step(1, 'project:b', 'Beta', 3)],
    );
    const after = s(
      [row('B-1', 0, 0, 1), row('A-1', 1, 1, 3)],
      [step(0, 'project:b', 'Beta', 1), step(1, 'project:a', 'Alpha', 3)],
    );
    const r = QT.planChange(before, after, {});
    expect(r.sentence).toBe('Step 1 (Beta) done about 2 h earlier; step 2 (Alpha) done about 1 h later; B-1 starts first.');
  });

  it('a moved task that is not first says how its own start moves', () => {
    const before = s([row('A-1', 0, 0, 1), row('A-2', 0, 1, 2), row('A-3', 0, 3, 4)], [step(0, 'project:a', 'Alpha', 4)]);
    const after = s([row('A-1', 0, 0, 1), row('A-3', 0, 1, 2), row('A-2', 0, 2, 4)], [step(0, 'project:a', 'Alpha', 4)]);
    expect(QT.planChange(before, after, { moved: ['A-3'] }).sentence).toBe('A-3 starts about 2 h earlier.');
  });

  it('under the threshold: the plan stays about the same', () => {
    const before = s([row('A-1', 0, 0, 1), row('A-2', 0, 1, 2)], [step(0, 'project:a', 'Alpha', 2)]);
    const after = s([row('A-1', 0, 0, 1), row('A-2', 0, 1.05, 2.05)], [step(0, 'project:a', 'Alpha', 2.05)]);
    const r = QT.planChange(before, after, { moved: ['A-2'] });
    expect(r.sentence).toBe(QT.PLAN_SAME);
    expect(r.parts).toEqual([]);
  });

  it('the rest is named "the rest", and at most three steps are listed', () => {
    const steps = (k: number) => [0, 1, 2, 3].map((i) => step(i, `project:p${i}`, `P${i}`, 1 + i + k));
    const before = s([row('X-1', 0, 0, 1)], [...steps(0), step(null, null, 'rest', 6)]);
    const after = s([row('X-1', 0, 0, 1)], [...steps(2), step(null, null, 'rest', 9)]);
    const r = QT.planChange(before, after, {});
    expect(r.sentence).toBe(
      'Step 1 (P0) done about 2 h later; step 2 (P1) done about 2 h later; step 3 (P2) done about 2 h later; ' +
        '2 more steps move too.',
    );
    const one = QT.planChange(s([], [step(null, null, 'rest', 2)]), s([], [step(null, null, 'rest', 3)]), {});
    expect(one.sentence).toBe('The rest done about 1 h later.');
  });
});

describe('planEffect: the real schedule on both', () => {
  const task = (id: string, extra: object = {}) => ({
    id,
    title: `Task ${id}`,
    domain: id.toLowerCase(),
    class: 'K',
    value: 5,
    content_min: 60,
    status: 'waiting',
    depends_on: [],
    waiting_on: [],
    owned_files: [`f/${id}.ts`],
    added_by: 'test',
    added_at: iso(NOW - 48 * H),
    ...extra,
  });
  const queue = () => ({
    created: iso(NOW - 72 * H),
    limits: { maxConcurrent: 1, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
    projects: { a: { title: 'Alpha', prefixes: ['A-'] }, b: { title: 'Beta', prefixes: ['B-'] } },
    areas: {},
    changelog: [],
    focus: { order: ['project:a', 'project:b'], rest: 'wait', from: iso(NOW - 24 * H) },
    tasks: [task('A-1', { value: 8 }), task('A-2', { value: 3 }), task('B-1')],
  });

  it('a rank: the moved task starts first in its step', () => {
    const q = queue();
    const rb = L.rankBlock(q, ['A-2'], { over: 'A-1' }, NOW);
    expect(rb.error).toEqual([]);
    const changes = Object.entries(rb.changes).map(([id, after]) => ({ id, field: 'priority_bonus', before: null, after }));
    const copy = QT.applyChanges(q, changes);
    const r = QT.planEffect(q, copy, { now: NOW, moved: ['A-2'] });
    expect(r.sentence).toContain('A-2 starts first in step 1 (Alpha)');
    expect(JSON.stringify(q)).toBe(JSON.stringify(queue()));
  });

  it('a focus reorder: Beta moves to step 1 and ends earlier', () => {
    const q = queue();
    const copy = JSON.parse(JSON.stringify(q));
    copy.focus.order = ['project:b', 'project:a'];
    const r = QT.planEffect(q, copy, { now: NOW });
    expect(r.sentence).toMatch(/^Step 1 \(Beta\) done about [\d.]+ (h|min) earlier/);
    expect(r.sentence).toContain('B-1 starts first');
  });
});
