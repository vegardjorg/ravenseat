// =============================================================
// timelineUncertainty.test.ts: the setting and the payload of the Timeline's uncertainty band (roadmap TIDSLINJE T-C;
// plans/gantt-utredning-2026-11-18.md, bolk C and section 6).
//
// Locks: board.timelineUncertainty is on by default (read only, stops no work, costs no tokens), boardTimeline reads it
// (a wrong value falls back to on), its Board registry row weakens nothing, needs board.timeline and is full-only, it
// is in queue.md's settings table and board.md; GET /api/schedule's payload (queueTimeline.timelineData) carries the
// band per step and the backtest when it is on, nothing when off; the step rows of the layout take the band (P50 as
// the step's end, P85 as "likely by"), and the step table has the same numbers.
// =============================================================
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const KK = require('../queueConfig.js') as any;
const R = require('../settingsRegistry.js') as any;
const QT = require('../queueTimeline.js') as any;
const U = require('../scheduleUncertainty.js') as any;
const TL = require('../timelineLayout.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports */

const resolved = (own: object) => KK.resolveOwn(KK.merge(KK.STANDARD, own), own);
const DOCS = join(__dirname, '..', '..', '..', '..', 'docs');
const NOW = Date.parse('2026-11-02T10:00:00.000Z');
const MIN = 60_000;
const ago = (min: number) => new Date(NOW - min * MIN).toISOString();
const doneK = (id: string, cycle: number) => ({
  id,
  title: id,
  class: 'K',
  status: 'done',
  content_min: 30,
  added_at: ago(24 * 60 + cycle + 5),
  started: ago(24 * 60 + cycle),
  done: ago(24 * 60),
});
const task = (id: string, extra: object = {}) => ({ id, title: id, class: 'K', status: 'waiting', content_min: 30, value: 5, added_at: ago(60), ...extra });
const queue = {
  limits: { maxConcurrent: 1 },
  resolved: [],
  projects: { a: { title: 'Alpha' }, b: { title: 'Beta' } },
  focus: { order: ['project:a', 'project:b'], rest: 'fill' },
  tasks: [...[16, 16, 16, 32, 48].map((c, i) => doneK(`D${i}`, c)), task('A1', { project: 'a' }), task('A2', { project: 'a' }), task('B1', { project: 'b' })],
};

describe('board.timelineUncertainty', () => {
  it('STANDARD on; boardTimeline reads it, a wrong value falls back to on', () => {
    expect(KK.STANDARD.board.timelineUncertainty).toBe(true);
    expect(KK.boardTimeline(resolved({})).uncertainty).toBe(true);
    expect(KK.boardTimeline(resolved({ board: { timelineUncertainty: false } })).uncertainty).toBe(false);
    expect(KK.boardTimeline(resolved({ board: { timelineUncertainty: 'x' } })).uncertainty).toBe(true);
  });

  it('has a Board row that weakens nothing, needs the tab and is full-only', () => {
    const r = R.rowFor('board.timelineUncertainty');
    expect(r).toBeTruthy();
    expect(r.category).toBe('board');
    expect(r.type).toBe('onoff');
    expect(r.weakens).toBeNull();
    expect(r.modes).toEqual(['full']);
    expect(r.fullWhy).toMatch(/lite/);
    expect(R.REQUIRES['board.timelineUncertainty']).toContain('board.timeline');
  });

  it('is in the settings table of queue.md and in board.md', () => {
    expect(readFileSync(join(DOCS, 'queue.md'), 'utf8')).toMatch(/\| `board\.timelineUncertainty`/);
    expect(readFileSync(join(DOCS, 'board.md'), 'utf8')).toContain('board.timelineUncertainty');
  });
});

describe('the payload and the layout', () => {
  it('timelineData carries the band per step and the backtest when asked, nothing otherwise', () => {
    const on = QT.timelineData(queue, { now: NOW, tz: 'UTC', uncertainty: true });
    expect(on.uncertainty).toEqual(U.uncertainty(queue, { now: NOW, tz: 'UTC' }));
    expect(on.backtest).toEqual(U.backtest(queue, { now: NOW, tz: 'UTC' }));
    const off = QT.timelineData(queue, { now: NOW, tz: 'UTC' });
    expect(off.uncertainty).toBeNull();
    expect(off.backtest).toBeNull();
    // A backtest the caller has (the server caches it per day) is passed through as it is.
    expect(QT.timelineData(queue, { now: NOW, tz: 'UTC', uncertainty: true, backtest: { text: 'cached' } }).backtest).toEqual({ text: 'cached' });
  });

  it('a step row takes the band: the end is P50 and likelyBy is P85; no band on a task', () => {
    const d = QT.timelineData(queue, { now: NOW, tz: 'UTC', uncertainty: true });
    const rows = TL.buildRows(d, { by: 'step', horizonDays: 3 });
    const one = rows.find((r: any) => r.key === 'step:0');
    const band = d.uncertainty.steps.find((s: any) => s.step === 0);
    expect(one.end).toBe(Date.parse(band.p50_end));
    expect(one.likelyBy).toBe(Date.parse(band.p85_end));
    for (const it of one.items) expect(it).not.toHaveProperty('likelyBy');
    // Without the band the row keeps the plan's own end and has no likelyBy.
    const plain = TL.buildRows({ ...d, uncertainty: null }, { by: 'step', horizonDays: 3 }).find((r: any) => r.key === 'step:0');
    expect(plain.end).toBe(Date.parse(d.schedule.steps[0].p50_end));
    expect(plain.likelyBy).toBeNull();
    // The geometry: the band from P50 to P85 in pixels on the row.
    const w = TL.windowOf(d, { horizonDays: 3 });
    const sc = TL.scale(w, 1000);
    const g = TL.layout(rows, sc).groups.find((x: any) => x.key === 'step:0');
    expect(g.band).toEqual({ x0: sc.x(one.end), x1: sc.x(one.likelyBy), clipped: false });
  });

  // T-C follow-up: a step's band replaces the per-task "Likely range" whisker of its planned bars (two marks for the
  // same doubt read as noise); a step without a band keeps the whisker. bandAfterBars says the band starts after the
  // step's last bar (the board then explains why in one line).
  it('a planned bar in a step with a band has no whisker; without a band it keeps one', () => {
    const d = QT.timelineData(queue, { now: NOW, tz: 'UTC', uncertainty: true });
    const w = TL.windowOf(d, { horizonDays: 3 });
    const sc = TL.scale(w, 1000);
    const banded = TL.layout(TL.buildRows(d, { by: 'step', horizonDays: 3 }), sc);
    const g0 = banded.groups.find((x: any) => x.key === 'step:0');
    const mine = banded.bars.filter((b: any) => b.row === 'step:0' && b.kind === 'planned');
    expect(mine.length).toBe(2);
    for (const b of mine) expect(b.bandX0 ?? null).toBeNull();
    const last = Math.max(...mine.map((b: any) => b.x1));
    expect(g0.bandAfterBars).toBe(g0.band.x0 > last);
    const plain = TL.layout(TL.buildRows({ ...d, uncertainty: null }, { by: 'step', horizonDays: 3 }), sc);
    const bare = plain.bars.filter((b: any) => b.row === 'step:0' && b.kind === 'planned');
    for (const b of bare) expect(b.bandX1).toBeGreaterThan(b.bandX0);
    expect(plain.groups.find((x: any) => x.key === 'step:0').bandAfterBars).toBe(false);
  });

  it('the step table has the same numbers as the chart', () => {
    const d = QT.timelineData(queue, { now: NOW, tz: 'UTC', uncertainty: true });
    const rows = TL.buildRows(d, { by: 'step', horizonDays: 3 });
    const t = TL.stepTable(rows);
    expect(t.columns).toEqual(['Step', 'Tasks', 'Done around', 'Likely by']);
    expect(t.rows.map((r: any) => r.key)).toEqual(['step:0', 'step:1']);
    const one = rows.find((r: any) => r.key === 'step:0');
    expect(t.rows[0]).toMatchObject({ title: '1 Alpha', tasks: 2, end: one.end, likelyBy: one.likelyBy });
  });
});
