// =============================================================
// scheduleUncertainty.test.ts: the uncertainty band per focus step and the backtest (lib/scheduleUncertainty.js,
// roadmap TIDSLINJE T-C; plans: gantt investigation 2026-11-18, bolk C and owner question 6).
//
// The band is a Monte Carlo over the measured actual/estimate ratios, played through the real schedule simulation
// (queueSchedule.schedule with a drawn length per task), so the rules are asserted here with a seeded generator and a
// fixed clock: the same seed gives the same band, P50 and P85 come from the drawn ends with the nearest rank, a constant
// ratio gives a band of zero width at the plan's own end, too few measured tasks give no band and one line why, and the
// end of the whole focus agrees with queueForecast.js on a steady history. The backtest replays past days from what
// queue.json records (added, started, done) and counts how often the real finish was inside the band or earlier.
// =============================================================
import { describe, it, expect } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const U = require('../scheduleUncertainty.js') as any;
const SC = require('../queueSchedule.js') as any;
const F = require('../queueForecast.js') as any;
const S = require('../queueStatistics.js') as any;
const TK = require('../timeCost.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports */

const NOW = Date.parse('2026-11-02T10:00:00.000Z');
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const iso = (ms: number) => new Date(ms).toISOString();
const at = (min: number) => iso(NOW + min * MIN);
const ago = (min: number) => iso(NOW - min * MIN);
const task = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: id,
  class: 'K',
  status: 'waiting',
  content_min: 30, // estimateWall 16
  value: 5,
  added_at: ago(60),
  ...extra,
});
// A done K task (estimateWall 16) that took `cycle` minutes and finished `daysAgo` days back.
const doneK = (id: string, cycle: number, daysAgo = 1) => ({
  id,
  title: id,
  class: 'K',
  status: 'done',
  content_min: 30,
  added_at: ago(daysAgo * 24 * 60 + cycle + 5),
  started: ago(daysAgo * 24 * 60 + cycle),
  done: ago(daysAgo * 24 * 60),
});
const queueOf = (tasks: unknown[], extra: Record<string, unknown> = {}) => ({
  limits: { maxConcurrent: 1 },
  resolved: [],
  projects: {},
  tasks,
  ...extra,
});
const band = (queue: unknown, option: Record<string, unknown> = {}) => U.uncertainty(queue, { now: NOW, tz: 'UTC', ...option });

describe('scheduleUncertainty: the band per step', () => {
  it('a constant measured ratio gives a band of zero width at the plan end', () => {
    const history = [1, 2, 3, 4, 5].map((i) => doneK(`D${i}`, 32)); // ratio 2
    const q = queueOf([...history, task('A'), task('B')]);
    const u = band(q);
    const plan = SC.schedule(q, { now: NOW, tz: 'UTC' });
    expect(u.enough).toBe(true);
    expect(u.reason).toBeNull();
    expect(u.steps).toHaveLength(1);
    expect(u.steps[0]).toMatchObject({ step: null, title: 'the whole queue', p50_end: plan.steps[0].p50_end, p85_end: plan.steps[0].p50_end });
    expect(u.steps[0].p50_end).toBe(at(64));
  });

  it('draws each length from the measured ratios with a seeded generator: P50 and P85 by the nearest rank', () => {
    // Ratios 1, 1, 1, 2, 3 for K/S: one task of wall 16 takes 16 (3 in 5), 32 or 48 minutes.
    const history = [16, 16, 16, 32, 48].map((c, i) => doneK(`D${i}`, c));
    const q = queueOf([...history, task('A')]);
    const u = band(q, { runs: 200 });
    expect(u.runs).toBe(200);
    expect(u.steps[0].p50_end).toBe(at(16));
    expect(u.steps[0].p85_end).toBe(at(48));
    // The same seed gives the same band; another seed may differ but stays inside the measured lengths.
    expect(band(q, { runs: 200 })).toEqual(u);
    const other = band(q, { runs: 200, seed: 7 });
    expect([at(16), at(32), at(48)]).toContain(other.steps[0].p85_end);
  });

  it('gives one band per focus step (no band per task) and the end of the whole focus', () => {
    const history = [16, 16, 16, 32, 48].map((c, i) => doneK(`D${i}`, c));
    const q = queueOf([...history, task('A1', { project: 'a' }), task('B1', { project: 'b' })], {
      projects: { a: { title: 'Alpha' }, b: { title: 'Beta' } },
      focus: { order: ['project:a', 'project:b'], rest: 'fill' },
    });
    const u = band(q);
    expect(u.steps.map((s: any) => [s.step, s.title])).toEqual([
      [0, 'Alpha'],
      [1, 'Beta'],
    ]);
    for (const s of u.steps) expect(Date.parse(s.p85_end)).toBeGreaterThanOrEqual(Date.parse(s.p50_end));
    expect(Date.parse(u.steps[1].p50_end)).toBeGreaterThan(Date.parse(u.steps[0].p50_end));
    expect(u.whole.p85_end).toBe(u.steps[1].p85_end);
    expect(u).not.toHaveProperty('tasks');
  });

  it('too few measured tasks: no band, and one line that says why', () => {
    const q = queueOf([...[1, 2, 3, 4].map((i) => doneK(`D${i}`, 32)), task('A')]);
    const u = band(q);
    expect(u.enough).toBe(false);
    expect(u.steps).toEqual([]);
    expect(u.reason).toBe('No band yet: 4 finished tasks with a measured time in the last 28 days, needs at least 5.');
  });

  it('caps the runs by the work (runs x open tasks) and never goes below the floor', () => {
    expect(U.runsFor(10)).toBe(U.RUNS);
    expect(U.runsFor(10_000)).toBe(U.MIN_RUNS);
    expect(U.runsFor(100)).toBe(Math.max(U.MIN_RUNS, Math.min(U.RUNS, Math.floor(U.WORK_CAP / 100))));
  });

  it('shares the window, the sample floor, the generator and the percentile with queueForecast and costEstimate', () => {
    expect(U.WINDOW_DAYS).toBe(F.WINDOW_DAYS);
    expect(U.MIN_SAMPLE).toBe(F.MIN_DONE);
    expect(U.SEED).toBe(F.BOARD_SEED);
    expect(U.percentile).toBe(S.percentile);
  });

  it('agrees with queueForecast on a steady history (the end of the whole queue, by the day)', () => {
    // 27 days with 8 done a day, each a K task that took 32 minutes (ratio 2). 8 left on one slot: 8 x 32 min = 4.3 h
    // played forward (today), and one day's throughput for the forecast (tomorrow's date): within a day.
    const history: unknown[] = [];
    for (let d = 1; d <= 27; d++) for (let i = 0; i < 8; i++) history.push(doneK(`H${d}-${i}`, 32, d));
    const left = Array.from({ length: 8 }, (_, i) => task(`T${i}`));
    const q = queueOf([...history, ...left]);
    const u = band(q);
    const f = F.queueForecast(q, { rng: F.seededRandom(F.BOARD_SEED), now: NOW, tz: 'UTC' });
    expect(u.forecast).toMatchObject({ enough: true, p85: f.p85.date });
    const bandDay = TK.dayFor(u.whole.p85_end, 'UTC');
    const diff = (Date.parse(`${f.p85.date}T00:00:00Z`) - Date.parse(`${bandDay}T00:00:00Z`)) / DAY;
    expect(Math.abs(diff)).toBeLessThanOrEqual(1);
    expect(u.agree).toMatchObject({ ok: true, text: null });
  });

  it('says both, with why, when the forecast and the band are more than a day apart', () => {
    // One done task a day for the throughput (slow), but each took only 16 minutes: the band says hours, the
    // throughput says days.
    const history: unknown[] = [];
    for (let d = 1; d <= 6; d++) history.push(doneK(`H${d}`, 16, d));
    const q = queueOf([...history, ...Array.from({ length: 6 }, (_, i) => task(`T${i}`))]);
    const u = band(q);
    expect(u.agree.ok).toBe(false);
    expect(u.agree.text).toMatch(/^The Focus forecast \(finished tasks per day\) says 85 %: by /);
    expect(u.agree.text).toMatch(/quiet days and new work/);
  });
});

describe('scheduleUncertainty: the backtest', () => {
  // Day k back (cut at 12:00 UTC): three K tasks added just before, run one after the other from the cut, 32 minutes
  // each (ratio 2). On the late days the queue stood still for 3 hours first, so the real finish is after the band.
  const cut = (k: number) => Math.floor(NOW / DAY) * DAY + 12 * 60 * MIN - k * DAY;
  const history = (late: number[]) => {
    const out: unknown[] = [];
    for (let k = 1; k <= 10; k++) {
      const t = cut(k);
      const delay = late.includes(k) ? 180 : 0;
      for (let i = 0; i < 3; i++)
        out.push({
          id: `B${k}-${i}`,
          title: 'x',
          class: 'K',
          status: 'done',
          content_min: 30,
          value: 5,
          added_at: iso(t - 10 * MIN),
          started: iso(t + (delay + i * 32) * MIN),
          done: iso(t + (delay + (i + 1) * 32) * MIN),
        });
    }
    return out;
  };

  it('replays past days and counts how often the real finish was inside the band or earlier', () => {
    const q = queueOf(history([2, 4, 6]));
    const b = U.backtest(q, { now: NOW, tz: 'UTC', days: 10 });
    // Days 10 and 9 have fewer than 5 measured tasks before them: skipped. Days 8 to 1 are checked; 2, 4 and 6 are late.
    expect(b).toMatchObject({ enough: true, checked: 8, byEnd: 5, late: 3, skipped: 2, days: 10 });
    expect(b.tenths).toBe(6);
    expect(b.text).toBe('Backtest: about 6 of 10 steps were done by the end of their band (8 past days checked).');
  });

  it('is pure reading: the queue is not changed', () => {
    const q = queueOf(history([]));
    const before = JSON.stringify(q);
    const b = U.backtest(q, { now: NOW, tz: 'UTC', days: 10 });
    expect(b).toMatchObject({ checked: 8, byEnd: 8, late: 0 });
    expect(JSON.stringify(q)).toBe(before);
  });

  it('too few past days to check: no precision number, one line why', () => {
    const q = queueOf(history([]).slice(0, 9)); // days 1 to 3 only
    const b = U.backtest(q, { now: NOW, tz: 'UTC', days: 10 });
    expect(b.enough).toBe(false);
    expect(b.tenths).toBeNull();
    expect(b.text).toBe(`No backtest yet: ${b.checked} past days could be checked, needs at least ${U.BACKTEST.minDays}.`);
  });
});
