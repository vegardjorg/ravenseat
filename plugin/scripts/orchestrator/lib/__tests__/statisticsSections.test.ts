// =============================================================
// statisticsSections.test.ts: the figures for the reworked Statistics tab (lib/statisticsSections.js, steps S2 to S5 of
// plans/stats-vurdering-2026-11-18.md).
//
// What the tests prove:
//   - the context cap is the compaction window from the first Claude Code settings file that sets it, 300k without one,
//   - "waiting on you" counts the open owner questions now and the oldest wait, and warns over 4 h median or 1 day,
//   - the quota is the 7-day percentage against the share of the quota week gone, warn when the pace passes 100 %,
//     and nothing for a reading whose week has reset,
//   - the token mix prices each event's tokens at ITS model (a Haiku agent is not priced as Opus),
//   - the cost per phase per class sums the done tasks' cost.phases, and the fix share is of the whole,
//   - one context point per build agent, "near the cap" over 80 % of the cap,
//   - the machine section counts limited and stopped fills per day, the gate queue wait, and buckets the gate time by
//     the tracks running when the gate started,
//   - the quality section has the gate health and the findings per source and severity, deferred and fixed.
// =============================================================
import { describe, it, expect } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const X = require('../statisticsSections.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const S = require('../queueStatistics.js');

const now = Date.parse('2026-11-18T12:00:00Z');
const iso = (min: number) => new Date(now - min * 60_000).toISOString();
const H = 60;

const task = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  project: 'a',
  title: id,
  class: 'K',
  status: 'done',
  content_min: 60,
  added_at: iso(30 * H),
  started: iso(20 * H),
  delivered: iso(10 * H),
  done: iso(9 * H),
  ...extra,
});

describe('compactWindow', () => {
  it('takes the first settings file with a window, else 300k', () => {
    expect(
      X.compactWindow([
        { name: 'settings.local.json', settings: {} },
        { name: 'settings.json', settings: { autoCompactWindow: 400000 } },
        { name: 'user', settings: { autoCompactWindow: 200000 } },
      ]),
    ).toEqual({ cap: 400000, source: 'settings.json' });
    expect(X.compactWindow([{ name: 'x', settings: null }])).toEqual({ cap: 300000, source: 'default' });
  });
});

describe('top figures', () => {
  const queue = {
    tasks: [
      task('A', { status: 'waiting', waiting_on: ['Q1'], added_at: iso(30 * H), done: undefined }),
      task('B', { status: 'waiting', waiting_on: ['Q2'], added_at: iso(2 * H), done: undefined }),
      task('C', { status: 'waiting', waiting_on: ['Q3'], done: undefined }),
    ],
    resolved: ['Q3'],
    resolutions: {},
    question: {},
  };

  it('counts the open questions and the oldest wait, and warns past a day', () => {
    const out = X.sections({ queue, rows: [], statistics: S.statistics(queue, [], { now }), now });
    expect(out.top.waiting.open).toBe(2);
    expect(out.top.waiting.oldest_min).toBe(30 * H);
    expect(out.top.waiting.warn).toBe(true);
  });

  it('the week quota: used against the week gone, warn when the pace passes 100 %', () => {
    // 3.5 days of 7 gone (reset in 3.5 days), 60 % used: pace 120 %.
    const resets = (now + 3.5 * 86_400_000) / 1000;
    const q = X.weekQuota({ time: iso(5), seven_day: { used_percentage: 60, resets_at: resets } }, now);
    expect(q.elapsed_pct).toBe(50);
    expect(q.pace_pct).toBe(120);
    expect(q.warn).toBe(true);
    expect(X.weekQuota({ seven_day: { used_percentage: 60, resets_at: (now - 1000) / 1000 } }, now)).toBeNull();
  });
});

describe('cost section', () => {
  const rows = [
    // One Haiku track with 1M output tokens: 0.5 USD at the Haiku 5 price, not 20 USD at Opus 5.5.
    { time: iso(60), event: 'done', agent_id: 'h1', agent_type: 'track', track: 'A', model: 'claude-haiku-5-5', tokens: { output: 1_000_000 }, context: { end: 250_000 }, cache_expiry: 2 },
    { time: iso(30), event: 'done', agent_id: 'o1', agent_type: 'track', track: 'B', model: 'claude-opus-5-5', tokens: { cache_written: 1_000_000 }, context: { end: 100_000 } },
  ];
  const queue = {
    tasks: [
      task('A', { cost: { usd: 3, phases: { build: 2, review: 0.5, fix: 0.5, fix_rounds: 1 } } }),
      task('B', { class: 'D', cost: { usd: 1, phases: { build: 1, review: 0, fix: 0, fix_rounds: 0 } } }),
    ],
  };
  const out = X.sections({ queue, rows, cap: 300000, statistics: S.statistics(queue, rows, { now }), now });

  it('prices each event at its own model', () => {
    const today = out.cost.tokenMix[out.cost.tokenMix.length - 1];
    expect(today.output).toBe(0.5);
    // 1M cache write tokens at the Opus 5.5 5-minute price (4 x 1.25).
    expect(today.cache_write).toBe(5);
    expect(out.cost.cacheWriteShare).toBe(91);
  });

  it('PC-1: 1 h writes on two models are priced at the 1 h price per model, and the mix adds up to the measured USD', () => {
    // Agent m1: two cumulative rows, Opus 5.5 and Sonnet 5.5, all writes 1 h. Agent m2: an older row with the split but
    // no byModel. Before PC-1 every write was priced at Opus's 5 min price: (2.5M + 1M) x $5 = $17.50.
    const mt = (cw1h: number, out = 0) => ({ output: out, cache_written: cw1h, cache_written_5m: 0, cache_written_1h: cw1h });
    const r2 = [
      { time: iso(90), event: 'done', agent_id: 'm1', agent_type: 'track', track: 'M', model: 'claude-opus-5-5', tokens: mt(1_500_000, 100_000),
        byModel: { 'claude-opus-5-5': { turns: 1, tokens: mt(1_000_000, 100_000) }, 'claude-sonnet-5-5': { turns: 1, tokens: mt(500_000) } } },
      { time: iso(60), event: 'done', agent_id: 'm1', agent_type: 'track', track: 'M', model: 'claude-opus-5-5', tokens: mt(2_500_000, 100_000),
        byModel: { 'claude-opus-5-5': { turns: 2, tokens: mt(2_000_000, 100_000) }, 'claude-sonnet-5-5': { turns: 1, tokens: mt(500_000) } } },
      { time: iso(30), event: 'done', agent_id: 'm2', agent_type: 'track', track: 'N', model: 'claude-opus-5-5', tokens: mt(1_000_000) },
    ];
    const q2 = { tasks: [] };
    const o2 = X.sections({ queue: q2, rows: r2, cap: 300000, statistics: S.statistics(q2, r2, { now }), now });
    const sum = (k: string) => o2.cost.tokenMix.reduce((s: number, r: Record<string, number>) => s + (r[k] ?? 0), 0);
    // Opus 2M x $8 + Sonnet 0.5M x $4 + the older row 1M x $8 = $26.
    expect(sum('cache_write')).toBeCloseTo(26, 2);
    expect(sum('output')).toBeCloseTo(2, 2);
    // The bars add up to the measured cost (costOf of the last row per agent).
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const TK = require('../timeCost.js');
    const measured = TK.costOf(r2[1]) + TK.costOf(r2[2]);
    expect(sum('input') + sum('output') + sum('cache_read') + sum('cache_write')).toBeCloseTo(measured, 2);
    expect(o2.cost.cacheWriteShare).toBe(93);
  });

  it('sums the phases per class and the fix share', () => {
    expect(out.cost.phases.map((p: { class: string; fix: number }) => [p.class, p.fix])).toEqual([
      ['K', 0.5],
      ['D', 0],
    ]);
    expect(out.cost.fixShare).toBe(13);
  });

  it('cache expiries per day, the most expensive tasks and one context point per track', () => {
    expect(out.cost.cacheExpiry.reduce((s: number, e: { count: number }) => s + e.count, 0)).toBe(2);
    expect(out.cost.expensive[0]).toMatchObject({ id: 'A', usd: 3, fix_rounds: 1, context_max: 250000 });
    expect(out.cost.context.points.map((p: { end: number }) => p.end)).toEqual([100000, 250000]);
    expect(out.cost.context.near).toBe(1);
  });
});

describe('machine section', () => {
  // Two tasks running at the same time from 5 h to 1 h ago; one gate inside that window, one before.
  const queue = {
    tasks: [
      task('A', { started: iso(5 * H), delivered: iso(1 * H) }),
      task('B', { started: iso(5 * H), delivered: iso(1 * H) }),
    ],
  };
  const gateRows = [
    { time: iso(2 * H), event: 'gate', gates: ['test'], failed: [], duration_s: 120, wait_sec: 30, min_free_memory_pct: 22 },
    { time: iso(8 * H), event: 'gate', gates: ['test'], failed: ['test'], duration_s: 60, wait_sec: 0 },
  ];
  const loadRows = [
    { time: iso(3 * H), event: 'load', command: 'fill', limited_by: 'memory', free_memory_pct: 18 },
    { time: iso(2 * H), event: 'load', command: 'start', stopped: true, free_memory_pct: 9 },
    { time: iso(1 * H), event: 'load', command: 'sample', free_memory_pct: 40 },
  ];
  const out = X.sections({ queue, rows: [], gateRows, loadRows, statistics: S.statistics(queue, [], { now }), now });

  it('counts limited and stopped per day and the lowest free memory', () => {
    const today = out.machine.load[out.machine.load.length - 1];
    expect(today).toMatchObject({ rows: 2, limited: 1, stopped: 1, min_free: 9, samples: 1 });
    expect(out.machine.lowestGateFree).toBe(22);
  });

  it('the gate wait and the gate time per number of tracks running', () => {
    expect(out.machine.waitAll).toMatchObject({ p50: 0, p95: 30, n: 2 });
    const by = Object.fromEntries(out.machine.byConcurrency.map((b: { tracks: string; p50: number | null }) => [b.tracks, b.p50]));
    expect(by).toEqual({ 1: 60, 2: 120, 3: null, '4+': null });
  });
});

describe('quality section', () => {
  const findings = [
    { id: 'F-1', time: iso(60), caught_by: 'review:security', severity: 'H', disposition: { kind: 'fixed', ref: 'x' } },
    { id: 'F-2', time: iso(50), caught_by: 'review:security', severity: 'L', disposition: { kind: 'task', ref: 'T-9' }, fixed_by: 'abc1234' },
    { id: 'F-3', time: iso(40), caught_by: 'gate', severity: 'M', disposition: { kind: 'batch', ref: 'T-8' } },
    { id: 'F-4', time: iso(30 * 24 * H), caught_by: 'gate', severity: 'M' },
  ];
  const gateRows = [{ time: iso(60), event: 'gate', gates: ['lint'], failed: [], duration_s: 10, flaky: ['lint'] }];
  const out = X.sections({ queue: { tasks: [] }, rows: [], gateRows, findings, statistics: S.statistics({ tasks: [] }, [], { now }), now });

  it('per source and severity in the window, and the deferred that were fixed', () => {
    expect(out.quality.findings.sources).toEqual([
      { source: 'review:security', H: 1, M: 0, L: 1 },
      { source: 'gate', H: 0, M: 1, L: 0 },
    ]);
    expect(out.quality.findings).toMatchObject({ deferred: 2, deferredFixed: 1 });
  });

  it('has the gate health with the flaky count', () => {
    expect(out.quality.gates.runs).toBe(1);
    expect(out.quality.gates.commands[0]).toMatchObject({ command: 'lint', runs: 1, flaky: 1, p50: 10 });
    expect(out.quality.gates.flaky).toBe(1);
  });
});
