// =============================================================
// costMeasureEffects.test.ts: expected against measured effect for the cost measures (lib/costMeasures.js, roadmap 0y Y3).
//
// Why: the cost measures (a fix round that continues the warm agent, a review that reads only the new commits, the
// outline in a read denial) were design choices whose savings nobody measured. Each now carries its expected effect as
// data, and `ravenseat cost` prints the measured effect beside it: the median of the metric in the days before the
// measure shipped against the days after. With too few runs on either side it says so instead of printing a number.
// =============================================================
import { describe, it, expect } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const C = require('../costMeasures');

const DAY = 86_400_000;
const SINCE = Date.parse('2026-11-13T00:00:00Z');
const iso = (ms: number) => new Date(ms).toISOString();

/** A finished task with a split cost (cost.phases), started `d` days from SINCE (negative = before). */
const task = (id: string, d: number, phases: { build: number; review: number; fix: number; fix_rounds: number }) => ({
  id,
  status: 'done',
  class: 'K',
  started: iso(SINCE + d * DAY),
  cost: { usd: phases.build + phases.review + phases.fix, phases },
});

/** A done row in the time log for a track agent with `turns` model turns, `d` days from SINCE. */
const trackRow = (agent: string, d: number, turns: number) => ({
  event: 'done',
  agent_id: agent,
  agent_type: 'track',
  time: iso(SINCE + d * DAY),
  modelTurns: turns,
  tokens: { input: 1, output: 100, cache_read: 0, cache_write: 0 },
});

const measure = {
  id: 'fix-continue',
  title: 'Fix rounds continue the warm agent',
  since: '2026-11-13',
  setting: 'fixRound.continueWithinMin',
  metric: 'fix_usd_per_round',
  expected: { change_pct: -30, basis: 'a rough target from the design' },
};

describe('the cost measures carry their expected effect as data', () => {
  it('every measure has an id, a title, a ship date, a known metric and an expected change with its basis', () => {
    expect(C.COST_MEASURES.length).toBeGreaterThan(0);
    for (const m of C.COST_MEASURES) {
      expect(m.id).toMatch(/^[a-z][a-z0-9-]+$/);
      expect(m.title.length).toBeGreaterThan(5);
      expect(Number.isFinite(Date.parse(m.since))).toBe(true);
      expect(Object.keys(C.EFFECT_METRICS)).toContain(m.metric);
      expect(Number.isFinite(m.expected.change_pct)).toBe(true);
      expect(m.expected.basis.length).toBeGreaterThan(5);
    }
    expect(new Set(C.COST_MEASURES.map((m: { id: string }) => m.id)).size).toBe(C.COST_MEASURES.length);
  });
});

describe('measureEffects: the median before against after, honest about too few runs', () => {
  const now = SINCE + 20 * DAY;

  it('measures the change of the median when both sides have enough runs', () => {
    const tasks = [
      ...[1, 2, 3, 4, 5].map((i) => task(`b${i}`, -i, { build: 4, review: 1, fix: 2, fix_rounds: 1 })),
      ...[1, 2, 3, 4, 5].map((i) => task(`a${i}`, i, { build: 4, review: 1, fix: 1, fix_rounds: 1 })),
      // No fix round: not a sample of USD per fix round.
      task('n1', 2, { build: 4, review: 1, fix: 0, fix_rounds: 0 }),
      // Outside both windows (before SINCE - 14 days).
      task('old', -30, { build: 4, review: 1, fix: 9, fix_rounds: 1 }),
    ];
    const [e] = C.measureEffects({ measures: [measure], queue: { tasks }, rows: [], now, settingOn: () => true });
    expect(e.status).toBe('measured');
    expect(e.before).toEqual({ n: 5, median: 2 });
    expect(e.after).toEqual({ n: 5, median: 1 });
    expect(e.change_pct).toBe(-50);
    const lines = C.effectLines([e]).join('\n');
    expect(lines).toContain('expected');
    expect(lines).toContain('-30 %');
    expect(lines).toContain('-50 %');
    expect(lines).toMatch(/\$2\.00 \(n 5\) -> \$1\.00 \(n 5\)/);
    // The honest caveat: before and after is no controlled test.
    expect(lines).toMatch(/not a controlled test/);
  });

  it('says "not enough runs yet" with the counts instead of a number', () => {
    const tasks = [task('b1', -1, { build: 1, review: 1, fix: 2, fix_rounds: 1 }), task('a1', 1, { build: 1, review: 1, fix: 1, fix_rounds: 1 })];
    const [e] = C.measureEffects({ measures: [measure], queue: { tasks }, rows: [], now, settingOn: () => true });
    expect(e.status).toBe('too-few');
    expect(e.change_pct).toBeNull();
    const text = C.effectLines([e]).join('\n');
    expect(text).toContain('not enough runs yet');
    expect(text).toMatch(/n 1 before, 1 after; needs 5 on each side/);
    expect(text).not.toMatch(/-50 %/);
  });

  it('a measure shipped today has no after runs yet; one turned off here says so and measures nothing', () => {
    const fresh = { ...measure, since: iso(now - 3_600_000).slice(0, 10) };
    const [e] = C.measureEffects({ measures: [fresh], queue: { tasks: [] }, rows: [], now, settingOn: () => true });
    expect(e.status).toBe('too-few');
    const [off] = C.measureEffects({ measures: [measure], queue: { tasks: [] }, rows: [], now, settingOn: () => false });
    expect(off.status).toBe('off');
    expect(C.effectLines([off]).join('\n')).toMatch(/off here \(fixRound\.continueWithinMin\)/);
  });

  it('a turns metric reads the time log: turns per track agent, the last row per agent', () => {
    const m = { ...measure, setting: null, metric: 'track_turns', expected: { change_pct: -5, basis: 'x estimate' } };
    const rows = [
      ...[1, 2, 3, 4, 5].map((i) => trackRow(`b${i}`, -i, 40)),
      ...[1, 2, 3, 4, 5].map((i) => trackRow(`a${i}`, i, 30)),
      // A reviewer is no track agent.
      { ...trackRow('r1', 1, 500), agent_type: 'reviewer' },
    ];
    const [e] = C.measureEffects({ measures: [m], queue: { tasks: [] }, rows, now, settingOn: () => true });
    expect(e.before).toEqual({ n: 5, median: 40 });
    expect(e.after).toEqual({ n: 5, median: 30 });
    expect(e.change_pct).toBe(-25);
    expect(C.effectLines([e]).join('\n')).toMatch(/40 turns \(n 5\) -> 30 turns \(n 5\)/);
  });

  it('settingOn: a number over 0 or true is on; false, 0 and off are off', () => {
    expect(C.settingIsOn(60)).toBe(true);
    expect(C.settingIsOn(true)).toBe(true);
    expect(C.settingIsOn(0)).toBe(false);
    expect(C.settingIsOn(false)).toBe(false);
    expect(C.settingIsOn('off')).toBe(false);
  });
});
