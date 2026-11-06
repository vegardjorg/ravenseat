// =============================================================
// metrics.test.ts: USD per merged change, usage by session type, overhead allocation, defects after merge, gates,
// load analysis and the paired comparison (bench/lib/metrics.js), on the synthetic experiment in fixtures.ts.
// Hand-computed expectations: one fixture turn costs $0.22.
//   ravenseat arm:     orchestrator 10 turns, X-1 track 5, X-2 track 10 + reviewer 2 + fix 3  -> 30 turns = $6.60, 2 merged
//   manual arm: Y-1 chat 8 turns (merged), Y-2 chat 4 turns (cancelled)                -> 12 turns = $2.64, 1 merged
// =============================================================
import { describe, it, expect } from 'vitest';
import * as FX from './fixtures';

const C = require('../lib/collect.js') as Record<string, any>;
const M = require('../lib/metrics.js') as Record<string, any>;

const records = () =>
  C.build(FX.manifest(), {
    queue: FX.queue(),
    timeRows: C.readJsonl(FX.timeRows().map((r) => JSON.stringify(r)).join('\n')),
    transcripts: FX.transcriptFiles().map((t) => ({ ...t, analysis: C.analyzeSession(t.text) })),
    load: FX.loadRows(),
    human: [
      { time: FX.at(2100), task: 'Y-1', minutes: 12 },
      { time: FX.at(2101), arm: 'manual', minutes: 6 },
    ],
    reverts: [{ sha: 'r1', time: FX.at(400), subject: 'Revert "X-1: change"' }],
  });

describe('armSummary', () => {
  it('USD per merged change includes the orchestrator, review, fix rounds and cancelled work', () => {
    const [ravenseat, manual] = M.armSummary(records());
    expect(ravenseat).toMatchObject({ arm: 'ravenseat', tasks: 2, merged: 2, usd_total: 6.6, usd_per_merged: 3.3 });
    expect(ravenseat.usd_by_type).toMatchObject({ orchestrator: 2.2, track: 3.3, reviewer: 0.44, fix: 0.66, cancelled: 0 });
    expect(ravenseat.overhead_share).toBeCloseTo(2.2 / 6.6, 3);
    expect(ravenseat.compactions).toBe(1);
    expect(ravenseat.fix_rounds).toBe(1);
    expect(ravenseat.review_high_medium).toBe(1);
    expect(manual).toMatchObject({ tasks: 2, merged: 1, usd_total: 2.64, usd_per_merged: 2.64, merge_rate: 0.5 });
    expect(manual.usd_by_type).toMatchObject({ track: 1.76, cancelled: 0.88 });
    expect(manual.human_min).toBe(18);
    expect(manual.human_min_per_merged).toBe(18);
  });

  it('tokens by session type and the cache read share', () => {
    const [ravenseat] = M.armSummary(records());
    expect(ravenseat.tokens_by_type.orchestrator).toEqual({ sessions: 1, input: 0, output: 10_000, cache_read: 10_000_000, cache_written: 0 });
    expect(ravenseat.cache_read_share).toBe(1);
    expect(ravenseat.per_class.D).toMatchObject({ tasks: 1, merged: 1 });
  });

  it('gate statistics: runs, reruns, rerun seconds and timeouts', () => {
    const [ravenseat, manual] = M.armSummary(records());
    expect(ravenseat.gates).toMatchObject({ runs: 3, reruns: 1, red: 1, rerun_seconds: 120, gate_seconds: 820, timeouts: 1, median_quick_s: 120 });
    expect(ravenseat.gates.rerun_share).toBeCloseTo(1 / 3, 3);
    expect(manual.gates.runs).toBe(0);
  });
});

describe('taskCosts and defects', () => {
  it('spreads the arm overhead equally over its tasks', () => {
    const c = M.taskCosts(records());
    const x1 = c.find((x: any) => x.id === 'X-1');
    const x2 = c.find((x: any) => x.id === 'X-2');
    expect(x1).toMatchObject({ own_usd: 1.1, usd: 2.2, fix_rounds: 0 });
    expect(x2).toMatchObject({ own_usd: 3.3, usd: 4.4, fix_rounds: 1 });
    expect(c.find((x: any) => x.id === 'Y-1')).toMatchObject({ usd: 1.76, human_min: 15 });
  });

  it('finds later fix tasks by id or by bug label on the same files, and reverts naming the task', () => {
    const d = M.defects(records());
    expect(d.get('X-2|ravenseat')).toEqual({ fixTasks: ['X-2-F1'], reverts: [], count: 1 });
    expect(d.get('X-1|ravenseat')).toEqual({ fixTasks: ['OTHER'], reverts: ['r1'], count: 2 });
    // OTHER was added before Y-1 was merged, so it is not a defect of Y-1. Y-2 was never merged.
    expect(d.get('Y-1|manual').count).toBe(0);
    expect(d.has('Y-2|manual')).toBe(false);
  });

  it('a defect outside the window does not count', () => {
    const r = records();
    r.settings.defectWindowDays = 0.001;
    expect(M.defects(r).get('X-2|ravenseat').count).toBe(0);
  });
});

describe('loadAnalysis', () => {
  it('buckets gate runs by running tracks and correlates parallelism with duration', () => {
    const l = M.loadAnalysis(records());
    expect(l.buckets.map((b: any) => [b.level, b.runs])).toEqual([['1-2', 2], ['9-12', 1]]);
    expect(l.buckets[1]).toMatchObject({ median_s: 600, timeout_share: 1 });
    expect(l.corr_parallel_duration).toBeGreaterThan(0.5);
    expect(l.min_free_memory).toBe(7);
    expect(l.max_running).toBe(10);
    const x2 = l.tasks.find((t: any) => t.id === 'X-2');
    expect(x2.mean_running).toBe(6);
    expect(x2.slowdown).toBe(1.5);
  });
});

describe('paired', () => {
  it('compares the arms pair by pair with the overhead included', () => {
    const p = M.paired(records(), 'ravenseat', 'manual', 'usd');
    expect(p.complete).toBe(2);
    expect(p.rows.map((r: any) => [r.pair, r.a, r.b])).toEqual([['p1', 2.2, 1.76], ['p2', 4.4, 0.88]]);
    expect(p.mean_diff).toBeCloseTo(-1.98, 3);
    expect(p.ratio).toBeCloseTo(2.64 / 6.6, 3);
    expect(p.ci[0]).toBeLessThanOrEqual(p.mean_diff);
    expect(p.ci[1]).toBeGreaterThanOrEqual(p.mean_diff);
  });

  it('skips a pair whose metric is missing and refuses an unknown metric', () => {
    const p = M.paired(records(), 'ravenseat', 'manual', 'wall_min');
    expect(p.complete).toBe(1); // Y-2 was cancelled and has no wall time
    expect(() => M.paired(records(), 'ravenseat', 'manual', 'vibes')).toThrow(/unknown metric/);
  });
});
