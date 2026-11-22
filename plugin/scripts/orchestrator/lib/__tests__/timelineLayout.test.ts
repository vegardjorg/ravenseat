// =============================================================
// timelineLayout.test.ts: the pure layout of the board's Timeline tab (roadmap TIDSLINJE T-A;
// plans/gantt-utredning-2026-11-18.md, sections 4 and 6).
//
// Locks: (1) roughDuration is the same text as queueSchedule's, so the tab never says something the CLI would not;
// (2) the window runs from the ran part (at most a day back) to now + the horizon, and the scale maps it linearly with
// clamping; (3) the ticks keep a minimum distance and mark midnight; (4) lanes pack overlapping bars; (5) rows: the ran
// and running part first, then one row per focus step in the schedule's order (rest last) or per project, a task
// that starts after the horizon is counted, not drawn; (6) a planned bar carries its rough band and never a clock time
// in its label, a wait on the owner is its own segment; (7) the table has the same tasks, the ones that cannot start
// with their reason, and only relative times.
// =============================================================
import { describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const TL = require('../timelineLayout.js') as any;
const SC = require('../queueSchedule.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports */

const H = 3_600_000;
const NOW = Date.UTC(2026, 10, 22, 12, 0);
const iso = (ms: number) => new Date(ms).toISOString();

/** A schedule in the shape queueSchedule.schedule returns (only the fields the layout reads). */
function sched(over: any = {}) {
  const band = (lo: number, hi: number) => ({ low_min: lo, high_min: hi, label: `rough: ${SC.roughDuration(lo)} to ${SC.roughDuration(hi)}` });
  return {
    now: iso(NOW),
    rough: true,
    tasks: [
      { id: 'EX-1', title: 'Running one', class: 'K', status: 'running', step: 0, start: iso(NOW - 2 * H), end: iso(NOW + H), minutes: 180, remaining_min: 60, band: band(120, 320), waits_on_you: false, answer_at: null, over_estimate: false, running: true },
      { id: 'EX-2', title: 'Step one task', class: 'D', status: 'waiting', step: 0, start: iso(NOW), end: iso(NOW + 2 * H), minutes: 120, band: band(80, 216), waits_on_you: false, answer_at: null, over_estimate: false, running: false },
      { id: 'EX-3', title: 'Step two task', class: 'K', status: 'waiting', step: 1, start: iso(NOW + H), end: iso(NOW + 3 * H), minutes: 120, band: band(80, 216), waits_on_you: true, answer_at: iso(NOW + H), over_estimate: false, running: false },
      { id: 'EX-4', title: 'Rest task', class: 'U', status: 'waiting', step: null, start: iso(NOW + 2 * H), end: iso(NOW + 4 * H), minutes: 120, band: band(80, 216), waits_on_you: false, answer_at: null, over_estimate: false, running: false },
      { id: 'EX-5', title: 'Far away', class: 'K', status: 'waiting', step: 1, start: iso(NOW + 100 * H), end: iso(NOW + 101 * H), minutes: 60, band: band(40, 108), waits_on_you: false, answer_at: null, over_estimate: false, running: false },
    ],
    unscheduled: [{ id: 'EX-6', reason: 'waits on EX-9 (not in the queue)' }],
    steps: [
      { step: 0, stage: 'area:a', title: 'Area A', tasks: 2, scheduled: 2, unscheduled: 0, p50_end: iso(NOW + 2 * H) },
      { step: 1, stage: 'area:b', title: 'Area B', tasks: 3, scheduled: 2, unscheduled: 1, p50_end: iso(NOW + 101 * H) },
      { step: null, stage: null, title: 'rest', tasks: 1, scheduled: 1, unscheduled: 0, p50_end: iso(NOW + 4 * H) },
    ],
    precision: 'Rough.',
    ...over,
  };
}
const ran = [
  { id: 'EX-0', title: 'Done earlier', class: 'K', start: iso(NOW - 6 * H), delivered: iso(NOW - 4 * H), end: iso(NOW - 3 * H) },
];
const projects = { 'EX-0': 'ex', 'EX-1': 'ex', 'EX-2': 'ex', 'EX-3': 'other', 'EX-4': 'ex', 'EX-5': 'other', 'EX-6': 'ex' };
const projectTitles = { ex: 'Example', other: 'Other' };
const data = (over: any = {}) => ({ schedule: sched(), ran, projects, projectTitles, ...over });

describe('rough text', () => {
  it('roughDuration is the same text as queueSchedule.roughDuration', () => {
    for (const m of [0, 3, 14, 29, 59, 60, 61, 95, 150, 600, 2879, 2880, 5000, 20000]) expect(TL.roughDuration(m), String(m)).toBe(SC.roughDuration(m));
  });
  it('relative text: now, in about, ago; never a clock time', () => {
    expect(TL.relativeText(NOW + 2 * 60_000, NOW)).toBe('now');
    expect(TL.relativeText(NOW + 2 * H, NOW)).toBe('in about 2 h');
    expect(TL.relativeText(NOW - 3 * H, NOW)).toBe('about 3 h ago');
  });
});

describe('the window and the scale', () => {
  it('the horizon is a whole number 1 to 14 days, 3 otherwise', () => {
    expect(TL.horizonDays(3)).toBe(3);
    expect(TL.horizonDays(0)).toBe(1);
    expect(TL.horizonDays(40)).toBe(14);
    expect(TL.horizonDays('x')).toBe(3);
    expect(TL.horizonDays(undefined)).toBe(3);
  });
  it('from the earliest ran or running start (at most a day back) to an hour after the plan, the horizon at most', () => {
    const w = TL.windowOf(data(), { horizonDays: 3 });
    expect(w.now).toBe(NOW);
    expect(w.from).toBe(NOW - 6 * H);
    expect(w.horizonEnd).toBe(NOW + 72 * H);
    // The farthest drawn reach is EX-4's band (start + 2 h + 216 min = 5.6 h); EX-5 starts after the horizon and does
    // not count. + 1 h, up to the whole hour: 7 h. A short plan does not squeeze into a corner of a 3-day axis.
    expect(w.to).toBe(NOW + 7 * H);
    // A plan that reaches past the horizon: the axis is the whole horizon.
    const long = TL.windowOf(data(), { horizonDays: 1 });
    expect(TL.windowOf(data({ schedule: sched({ tasks: [...sched().tasks, { ...sched().tasks[1], id: 'EX-7', start: iso(NOW + 20 * H), end: iso(NOW + 30 * H) }] }) }), { horizonDays: 1 }).to).toBe(NOW + 24 * H);
    expect(long.horizonEnd).toBe(NOW + 24 * H);
    // An empty plan still shows 6 h ahead.
    expect(TL.windowOf(data({ ran: [], schedule: sched({ tasks: [], steps: [] }) }), { horizonDays: 3 }).to).toBe(NOW + 6 * H);
    const old = TL.windowOf(data({ ran: [{ ...ran[0], start: iso(NOW - 50 * H) }] }), { horizonDays: 1 });
    expect(old.from).toBe(NOW - 24 * H);
    const none = TL.windowOf(data({ ran: [], schedule: sched({ tasks: [] }) }), { horizonDays: 1 });
    expect(none.from).toBe(NOW - H);
  });
  it('the scale is linear and clamps outside the window', () => {
    const s = TL.scale({ from: 0, to: 100, now: 50 }, 1000);
    expect(s.x(50)).toBe(500);
    expect(s.x(-10)).toBe(0);
    expect(s.x(200)).toBe(1000);
    expect(s.width).toBe(1000);
  });
  it('the ticks keep at least the minimum distance and mark midnight as major', () => {
    const w = { from: Date.UTC(2026, 10, 22, 6), to: Date.UTC(2026, 10, 25, 6), now: NOW };
    const ticks = TL.ticks(w, 900, { tz: 'UTC' });
    const s = TL.scale(w, 900);
    for (let i = 1; i < ticks.length; i += 1) expect(s.x(ticks[i].ms) - s.x(ticks[i - 1].ms)).toBeGreaterThanOrEqual(TL.MIN_TICK_PX);
    const majors = ticks.filter((k: any) => k.major);
    expect(majors.length).toBeGreaterThan(0);
    for (const k of majors) expect(new Date(k.ms).getUTCHours()).toBe(0);
    expect(majors[0].label).toMatch(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun) \d+$/);
    expect(ticks.find((k: any) => !k.major).label).toMatch(/^\d\d:00$/);
  });
});

describe('lanes', () => {
  it('overlapping bars go to separate lanes, a later one reuses a free lane', () => {
    const out = TL.packLanes([
      { id: 'a', s: 0, e: 10 },
      { id: 'b', s: 5, e: 15 },
      { id: 'c', s: 10, e: 20 },
      { id: 'd', s: 12, e: 14 },
    ]);
    expect(Object.fromEntries(out.items.map((x: any) => [x.id, x.lane]))).toEqual({ a: 0, b: 1, c: 0, d: 2 });
    expect(out.lanes).toBe(3);
    expect(TL.packLanes([]).lanes).toBe(0);
  });
});

describe('rows', () => {
  it('by step: the ran and running part first, then the steps in order, rest last', () => {
    const rows = TL.buildRows(data(), { by: 'step', horizonDays: 3 });
    expect(rows.map((r: any) => r.title)).toEqual(['Ran and running', '1 Area A', '2 Area B', 'Rest']);
    expect(rows[0].kind).toBe('ran');
    expect(rows[0].items.map((x: any) => [x.id, x.kind])).toEqual([['EX-0', 'ran'], ['EX-1', 'running']]);
    expect(rows[1].items.map((x: any) => x.id)).toEqual(['EX-2']);
    expect(rows[2].items.map((x: any) => x.id)).toEqual(['EX-3']);
    expect(rows[3].items.map((x: any) => x.id)).toEqual(['EX-4']);
  });
  it('a task that starts after the horizon is counted, not drawn; a step end inside the horizon is kept', () => {
    const rows = TL.buildRows(data(), { by: 'step', horizonDays: 3 });
    expect(rows[2].later).toBe(1);
    expect(rows[2].unscheduled).toBe(1);
    expect(rows[1].end).toBe(NOW + 2 * H);
    expect(rows[2].end).toBe(null);
    const wide = TL.buildRows(data(), { by: 'step', horizonDays: 5 });
    expect(wide[2].items.map((x: any) => x.id)).toEqual(['EX-3', 'EX-5']);
    expect(wide[2].end).toBe(NOW + 101 * H);
  });
  it('by project: one row per project after the ran part, by first start, named by the register', () => {
    const rows = TL.buildRows(data(), { by: 'project', horizonDays: 3 });
    expect(rows.map((r: any) => r.title)).toEqual(['Ran and running', 'Example', 'Other']);
    expect(rows[1].items.map((x: any) => x.id)).toEqual(['EX-2', 'EX-4']);
    expect(rows[2].items.map((x: any) => x.id)).toEqual(['EX-3']);
    expect(rows[1].end).toBe(null);
  });
  it('without a focus: the one group is called Planned', () => {
    const s = sched({ steps: [{ step: null, stage: null, title: 'the whole queue', tasks: 4, scheduled: 4, unscheduled: 0, p50_end: iso(NOW + 4 * H) }] });
    s.tasks = s.tasks.map((r: any) => ({ ...r, step: null }));
    const rows = TL.buildRows(data({ schedule: s }), { by: 'step', horizonDays: 3 });
    expect(rows.map((r: any) => r.title)).toEqual(['Ran and running', 'Planned']);
  });
  it('an empty plan with nothing ran gives no rows', () => {
    expect(TL.buildRows(data({ ran: [], schedule: sched({ tasks: [], steps: [] }) }), { by: 'step' })).toEqual([]);
  });
});

describe('bars', () => {
  const geo = () => {
    const d = data();
    const w = TL.windowOf(d, { horizonDays: 3 });
    const rows = TL.buildRows(d, { by: 'step', horizonDays: 3 });
    return { w, s: TL.scale(w, 1000), lay: TL.layout(rows, TL.scale(w, 1000)) };
  };
  it('a planned bar has its band from start + low to start + high, and the label says rough without a clock time', () => {
    const { s, lay } = geo();
    const b = lay.bars.find((x: any) => x.id === 'EX-2');
    expect(b.kind).toBe('planned');
    expect(b.x0).toBe(s.x(NOW));
    expect(b.x1).toBe(s.x(NOW + 2 * H));
    expect(b.bandX0).toBe(s.x(NOW + 80 * 60_000));
    expect(b.bandX1).toBe(s.x(NOW + 216 * 60_000));
    expect(b.label).toContain('rough: ');
    expect(b.label).not.toMatch(/\d\d:\d\d/);
  });
  it('the ran bar has a track and a review phase; a running bar crosses now with its remaining part rough', () => {
    const { s, lay } = geo();
    const r = lay.bars.find((x: any) => x.id === 'EX-0');
    expect(r.phases.map((p: any) => p.phase)).toEqual(['track', 'review']);
    expect(r.phases[0].x1).toBe(s.x(NOW - 4 * H));
    const run = lay.bars.find((x: any) => x.id === 'EX-1');
    expect(run.kind).toBe('running');
    expect(run.x0).toBeLessThan(s.x(NOW));
    expect(run.nowX).toBe(s.x(NOW));
    expect(run.label).toContain('running');
  });
  it('a wait on the owner is its own segment from now to the start, and said in words', () => {
    const { s, lay } = geo();
    const b = lay.bars.find((x: any) => x.id === 'EX-3');
    expect(b.wait).toEqual({ x0: s.x(NOW), x1: s.x(NOW + H) });
    expect(b.label).toContain('waits on you');
  });
  it('rows stack: each group has a header and its lanes, and the height adds up', () => {
    const { lay } = geo();
    expect(lay.groups.length).toBe(4);
    for (let i = 1; i < lay.groups.length; i += 1) expect(lay.groups[i].y).toBe(lay.groups[i - 1].y + lay.groups[i - 1].h);
    const last = lay.groups[lay.groups.length - 1];
    expect(lay.height).toBe(last.y + last.h);
    expect(lay.groups[0].lanes).toBe(1);
  });
  it('a label that does not fit in its bar goes after the bar and its band, and lanes are packed with the label', () => {
    const s = TL.scale({ from: NOW, to: NOW + 10 * H, now: NOW }, 1000);
    const item = (id: string, from: number, to: number) => ({ id, title: '', class: 'K', kind: 'ran', s: from, e: to, delivered: null, lane: 0 });
    // Two short ran bars 20 min apart: in time they do not overlap, but the first one's label reaches into the second.
    const rows = [{ key: 'ran', kind: 'ran', title: 'Ran', items: [item('AUTH-12', NOW, NOW + 10 * 60_000), item('BILL-2', NOW + 30 * 60_000, NOW + 40 * 60_000)], laterItems: [], later: 0, unscheduled: 0, end: null, lanes: 1 }];
    const lay = TL.layout(rows, s);
    const [a, b] = lay.bars;
    expect(a.text.inside).toBe(false);
    expect(a.text.x).toBeGreaterThanOrEqual(a.x1);
    expect(b.y).toBeGreaterThan(a.y);
    expect(lay.groups[0].lanes).toBe(2);
    // A wide bar keeps its label inside, at its start.
    const wide = TL.layout([{ ...rows[0], items: [item('UI-4', NOW, NOW + 3 * H)] }], s);
    expect(wide.bars[0].text).toEqual({ x: wide.bars[0].x0 + 4, inside: true });
    // A label never runs past the right edge: it goes before the bar instead.
    const edge = TL.layout([{ ...rows[0], items: [item('SYNC-4', NOW + 9.9 * H, NOW + 10 * H)] }], s);
    expect(edge.bars[0].text.x + TL.textWidth('SYNC-4')).toBeLessThanOrEqual(1000);
  });
  it('a running bar puts its label on one part only: the ran part when it fits, else the rest part (its own color)', () => {
    const s = TL.scale({ from: NOW - 5 * H, to: NOW + 5 * H, now: NOW }, 1000);
    const run = (id: string, from: number, to: number) => ({ id, title: '', class: 'K', kind: 'running', s: from, e: to, remaining: 60, over: false, band: { low: to, high: to, label: 'rough' }, lane: 0 });
    const row = (it: any) => [{ key: 'ran', kind: 'ran', title: 'Ran', items: [it], laterItems: [], later: 0, unscheduled: 0, end: null, lanes: 1 }];
    const fresh = TL.layout(row(run('AUTH-5', NOW - 5 * 60_000, NOW + 2 * H)), s).bars[0];
    expect(fresh.text).toEqual({ x: fresh.nowX + 4, inside: true, on: 'rest' });
    const long = TL.layout(row(run('BILL-2', NOW - 4 * H, NOW + H)), s).bars[0];
    expect(long.text).toEqual({ x: long.x0 + 4, inside: true, on: 'ran' });
  });
});

describe('the table', () => {
  it('the same tasks, with relative times only, and the ones that cannot start with their reason', () => {
    const rows = TL.buildRows(data(), { by: 'step', horizonDays: 3 });
    const tb = TL.tableRows(rows, data(), { now: NOW });
    expect(tb.columns).toEqual(['Task', 'Row', 'State', 'Starts', 'Takes', 'Note']);
    expect(tb.rows.map((r: any) => r.id)).toEqual(['EX-0', 'EX-1', 'EX-2', 'EX-3', 'EX-5', 'EX-4', 'EX-6']);
    const by = Object.fromEntries(tb.rows.map((r: any) => [r.id, r]));
    expect(by['EX-0'].state).toBe('Ran');
    expect(by['EX-0'].starts).toBe('about 6 h ago');
    expect(by['EX-0'].takes).toBe('took about 3 h');
    expect(by['EX-1'].state).toBe('Running');
    expect(by['EX-3'].state).toBe('Waits on you');
    expect(by['EX-2'].takes).toMatch(/^rough: /);
    expect(by['EX-5'].note).toContain('after the horizon');
    expect(by['EX-6'].state).toBe('Cannot start');
    expect(by['EX-6'].note).toBe('waits on EX-9 (not in the queue)');
    for (const r of tb.rows) for (const v of [r.starts, r.takes, r.note]) expect(String(v ?? '')).not.toMatch(/\d\d:\d\d/);
  });
});
