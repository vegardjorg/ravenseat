// =============================================================
// costEstimate.test.ts: calibrated cost estimates per class (and class + size) and USD per merged change
// (scripts/orchestrator/lib/costEstimate.js).
//
// Why: minute estimates are poor predictors of cost, while the median measured cost per class predicts it well. The
// rule order (class + size bucket, then class x the model correction, then the static model) and the honest cost figure
// (all measured cost / merged tasks, including cancelled work and agents without a task) are enforced in the pure
// functions, so they are tested there; the CLI (calibrate, cost, next, show, info, state) is tested against a
// temporary queue folder, never the real queue.
// =============================================================
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Task = Record<string, unknown> & { id: string; status: string };
type Estimate = { usd: number; source: 'measured' | 'model'; basis: string; n: number };
type Model = {
  windowDays: number;
  minSample: number;
  classes: Record<string, { n: number; median_usd: number | null; factor: number | null; measured: boolean }>;
  buckets: Record<string, { n: number; median_usd: number; measured: boolean }>;
};
type Merged = {
  merged: number;
  total_usd: number;
  usd_per_merged: number | null;
  source: string;
  parts: { merged: number; cancelled: number; open: number; unattributed: number };
  task_cost_usd: number;
  content_min: number;
  usd_per_content_min: number | null;
};

const CE = require('../costEstimate') as {
  WINDOW_DAYS: number;
  MIN_SAMPLE: number;
  sizeBucket: (o: object) => string;
  costModel: (queue: { tasks: Task[] }, option?: { now?: number; windowDays?: number; minSample?: number }) => Model;
  calibratedCost: (o: object, model: Model | null) => Estimate;
  costText: (c: Estimate) => string;
  calibration: (
    queue: { tasks: Task[] },
    option?: { now?: number; windowDays?: number; minSample?: number },
  ) => { rows: Record<string, unknown>[]; buckets: Record<string, unknown>[]; windowDays: number; minSample: number };
  calibrationLines: (c: object) => string[];
  perMergedChange: (input: { queue: { tasks: Task[] }; events: object[]; from: number; to: number }) => Merged;
  perMergedLines: (p: Merged, label: string) => string[];
  budgetOutlook: (b: object, usd: number) => { left: number; next_usd: number; over: boolean; message: string } | null;
};
const L = require('../queueLogic') as { estimateCost: (o: object) => number; WEIGHT: Record<string, number> };

const NOW = Date.parse('2026-11-01T12:00:00.000Z');
const ago = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
/** A done task with measured cost, done `h` hours ago, cycle `min` minutes. */
const done = (id: string, cls: string, usd: number | null, extra: Partial<Task> = {}): Task => ({
  id,
  class: cls,
  status: 'done',
  content_min: 30,
  started: ago(26),
  done: ago(24),
  ...(usd == null ? {} : { cost: { usd } }),
  ...extra,
});

describe('costModel and calibratedCost', () => {
  it('without measured data every estimate is the static model (source "model")', () => {
    const model = CE.costModel({ tasks: [] }, { now: NOW });
    const o = { class: 'D', content_min: 40 };
    expect(CE.calibratedCost(o, model)).toEqual({ usd: L.estimateCost(o), source: 'model', basis: 'model', n: 0 });
    // An unknown class and no model fall back the same way.
    expect(CE.calibratedCost({ class: 'X' }, model).source).toBe('model');
    expect(CE.calibratedCost(o, null).source).toBe('model');
  });

  it('a class + size bucket with at least MIN_SAMPLE measured tasks gives the bucket median', () => {
    const tasks = [1, 2, 3, 4, 10].map((usd, i) => done(`K-${i}`, 'K', usd));
    const model = CE.costModel({ tasks }, { now: NOW });
    expect(model.buckets['K/S']).toEqual({ n: 5, median_usd: 3, measured: true });
    expect(CE.calibratedCost({ class: 'K', content_min: 20 }, model)).toEqual({
      usd: 3,
      source: 'measured',
      basis: 'class+size',
      n: 5,
    });
  });

  it('a bucket with too little data uses the class: the model for the task x the median measured/model ratio', () => {
    // Five K tasks of size S, each measured at twice the model: factor 2.
    const tasks = [1, 2, 3, 4, 5].map((i) => done(`K-${i}`, 'K', L.estimateCost({ class: 'K', content_min: 30 }) * 2));
    const model = CE.costModel({ tasks }, { now: NOW });
    expect(model.classes.K.factor).toBe(2);
    const large = { class: 'K', content_min: 120 };
    expect(CE.calibratedCost(large, model)).toEqual({
      usd: Math.round(L.estimateCost(large) * 2 * 10) / 10,
      source: 'measured',
      basis: 'class',
      n: 5,
    });
  });

  it('only done tasks in the window with a measured cost count; external rows, unmeasured and old ones do not', () => {
    const tasks = [
      ...[1, 2, 3, 4].map((i) => done(`K-${i}`, 'K', 2)),
      done('OLD', 'K', 2, { done: ago(24 * 40) }),
      done('NOCOST', 'K', null),
      done('EXT', 'K', 2, { external: true }),
      { id: 'RUN', class: 'K', status: 'running', cost: { usd: 2 } },
    ];
    const model = CE.costModel({ tasks }, { now: NOW });
    expect(model.classes.K.n).toBe(4);
    expect(model.classes.K.measured).toBe(false);
    expect(CE.calibratedCost({ class: 'K' }, model).source).toBe('model');
    // A longer window takes the old one in, and the sample reaches MIN_SAMPLE.
    expect(CE.costModel({ tasks }, { now: NOW, windowDays: 60 }).classes.K.measured).toBe(true);
  });

  it('sizeBucket: S up to 30 content minutes (also the default), M up to 60, L above', () => {
    expect(CE.sizeBucket({})).toBe('S');
    expect(CE.sizeBucket({ content_min: 30 })).toBe('S');
    expect(CE.sizeBucket({ content_min: 31 })).toBe('M');
    expect(CE.sizeBucket({ content_min: 61 })).toBe('L');
  });

  it('costText: one decimal below $10, whole dollars above, empty without a number', () => {
    expect(CE.costText({ usd: 2.44, source: 'model', basis: 'model', n: 0 })).toBe('~$2.4');
    expect(CE.costText({ usd: 12.6, source: 'model', basis: 'model', n: 0 })).toBe('~$13');
    expect(CE.costText(null as unknown as Estimate)).toBe('');
  });
});

describe('calibration', () => {
  it('per class: n, median actual/estimate minutes, suggested weight, median USD, model USD and cost factor', () => {
    // K: estimate 30 min (content 30 x 1.0), cycle 120 min: ratio 4. D: 3 tasks, below MIN_SAMPLE.
    const tasks = [
      ...[1, 2, 3, 4, 5].map((i) => done(`K-${i}`, 'K', 3, { started: ago(26), done: ago(24) })),
      ...[1, 2, 3].map((i) => done(`D-${i}`, 'D', 6, { started: undefined })),
    ];
    const c = CE.calibration({ tasks }, { now: NOW });
    const k = c.rows.find((r) => r.class === 'K')!;
    expect(k).toMatchObject({
      n: 5,
      n_time: 5,
      minutes_ratio: 4,
      weight: 1,
      suggested_weight: 4,
      n_cost: 5,
      median_usd: 3,
      model_median_usd: L.estimateCost({ class: 'K', content_min: 30 }),
      basis: 'measured',
    });
    const d = c.rows.find((r) => r.class === 'D')!;
    expect(d).toMatchObject({ n: 3, n_time: 0, minutes_ratio: null, suggested_weight: null, basis: 'model' });
    // Classes without done tasks in the window are left out.
    expect(c.rows.map((r) => r.class)).toEqual(['K', 'D']);
    const lines = CE.calibrationLines(c);
    expect(lines[0]).toMatch(/last 28 days .*n >= 5/);
    expect(lines.some((l) => /^ {2}K\s+5\s+4\.00 \(n=5\)\s+1\.0 -> 4\.00\s+\$3\.00/.test(l))).toBe(true);
    expect(lines.some((l) => /^ {2}D .*model \(n=3 < 5\)/.test(l))).toBe(true);
    expect(lines.join('\n')).toMatch(/not changed automatically/);
  });

  it('without done tasks it says there is nothing to calibrate', () => {
    expect(CE.calibrationLines(CE.calibration({ tasks: [] }, { now: NOW }))[0]).toMatch(/nothing to calibrate/);
  });
});

describe('perMergedChange', () => {
  const ev = (track: string, usd: number, h: number) => ({ track, usd, time: ago(h) });
  const tasks: Task[] = [
    done('A', 'K', 4, { content_min: 60 }),
    done('B', 'D', 6, { content_min: 40 }),
    { id: 'C', class: 'K', status: 'cancelled' },
    { id: 'R', class: 'K', status: 'running' },
    done('OLD', 'K', 9, { done: ago(24 * 40) }),
    done('X', 'K', 1, { external: true }),
  ];
  const window = { from: NOW - 28 * 86_400_000, to: NOW + 1 };

  it('all measured cost in the window / the tasks merged in it, attributed by track label (fix rounds count)', () => {
    const events = [
      ev('A', 3, 30),
      ev('A-r2', 1, 25), // a fix round of A
      ev('B', 6, 30),
      ev('C', 2, 40), // cancelled work is cost too
      ev('R', 1, 2), // work in progress
      ev('general-purpose', 0.5, 5), // an agent without a task
      ev('A', 100, 24 * 40), // outside the window
    ];
    const p = CE.perMergedChange({ queue: { tasks }, events, ...window });
    expect(p).toMatchObject({
      merged: 2,
      total_usd: 13.5,
      usd_per_merged: 6.75,
      source: 'time-log',
      parts: { merged: 10, cancelled: 2, open: 1, unattributed: 0.5 },
      task_cost_usd: 10,
      content_min: 100,
      usd_per_content_min: 0.14,
    });
    const lines = CE.perMergedLines(p, 'last 28 days');
    expect(lines[0]).toBe('USD per merged change (last 28 days): $6.75 = $13.50 all measured cost / 2 merged');
    expect(lines[1]).toMatch(/cancelled \$2\.00, still open \$1\.00, no task \$0\.50/);
    expect(lines[2]).toMatch(/secondary, estimate-based: \$0\.14 per content minute/);
  });

  it('raising the estimate does not change the headline, only the secondary per content minute figure', () => {
    const events = [ev('A', 4, 30), ev('B', 6, 30)];
    const a = CE.perMergedChange({ queue: { tasks }, events, ...window });
    const bigger = tasks.map((o) => (o.status === 'done' ? { ...o, content_min: Number(o.content_min) * 3 } : o));
    const b = CE.perMergedChange({ queue: { tasks: bigger }, events, ...window });
    expect(b.usd_per_merged).toBe(a.usd_per_merged);
    expect(b.usd_per_content_min!).toBeLessThan(a.usd_per_content_min!);
  });

  it('without a time log the measured task cost of the merged tasks is the total (source task-cost)', () => {
    const p = CE.perMergedChange({ queue: { tasks }, events: [], ...window });
    expect(p).toMatchObject({ merged: 2, total_usd: 10, usd_per_merged: 5, source: 'task-cost' });
    expect(CE.perMergedLines(p, 'x')[1]).toMatch(/task cost of the merged tasks only/);
  });

  it('nothing merged in the window gives null and a line that says so', () => {
    const p = CE.perMergedChange({ queue: { tasks: [] }, events: [ev('Z', 2, 1)], ...window });
    expect(p.usd_per_merged).toBeNull();
    expect(CE.perMergedLines(p, 'last 28 days')[0]).toMatch(/no task reached done in the window \(\$2\.00 measured\)/);
  });
});

describe('budgetOutlook', () => {
  it('compares the estimate of what would start with what is left; null without a budget', () => {
    expect(CE.budgetOutlook({ active: false }, 5)).toBeNull();
    const ok = CE.budgetOutlook({ active: true, limit: 20, usage: 12 }, 5)!;
    expect(ok).toMatchObject({ left: 8, next_usd: 5, over: false });
    const over = CE.budgetOutlook({ active: true, limit: 20, usage: 18 }, 5)!;
    expect(over.over).toBe(true);
    expect(over.message).toMatch(/probably pass the daily budget/);
  });
});

// ---- The CLI against a temporary queue folder ----
const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});

describe('queue.mjs calibrate, cost, next, show, info and state (against a temporary queue)', () => {
  it('shows ~$ next to the minute estimate, the calibration per class and USD per merged change first in cost', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-cost-'));
    temporary.push(folder);
    const now = Date.now();
    const iso = (h: number) => new Date(now - h * 3_600_000).toISOString();
    const tasks = [
      ...[2, 2, 3, 3, 4].map((usd, i) => ({
        id: `K-${i}`,
        title: 'k',
        domain: 'x',
        class: 'K',
        status: 'done',
        content_min: 30,
        started: iso(30),
        done: iso(29),
        cost: { usd, agents: [], turns: 1, tokens: { sum: 1 } },
      })),
      { id: 'C-1', title: 'c', domain: 'z', class: 'K', status: 'cancelled', mission: 'm' },
      { id: 'W-1', title: 'waiting k', domain: 'a', class: 'K', status: 'waiting', content_min: 30, mission: 'm' },
      { id: 'W-2', title: 'waiting d', domain: 'b', class: 'D', status: 'waiting', content_min: 40, mission: 'm' },
    ];
    fs.writeFileSync(
      path.join(folder, 'queue.json'),
      JSON.stringify({ limits: { dailyBudget: 50 }, resolved: [], projects: {}, tasks }),
    );
    const configFile = path.join(folder, 'queue.config.json');
    fs.writeFileSync(configFile, '{}');
    // The time log: one done row per agent (cumulative rows; output tokens only, $20 per MTok).
    const row = (agent: string, track: string, usd: number, h: number) =>
      JSON.stringify({
        time: iso(h),
        event: 'done',
        agent_id: agent,
        agent_type: 'track',
        track,
        model: 'claude-opus-5-5',
        tokens: { input: 0, output: (usd * 1e6) / 20, cache_read: 0, cache_written: 0 },
      });
    fs.writeFileSync(
      path.join(folder, 'times.jsonl'),
      // All more than 24 h ago, so today's usage (the daily budget) is 0 and $50 is left.
      [row('a0', 'K-0', 2, 29), row('a1', 'K-1', 2, 29), row('a2', 'C-1', 4, 27), row('a3', 'other', 2, 26)].join('\n'),
    );
    const env = {
      ...process.env,
      QUEUE_FOLDER: folder,
      QUEUE_CONFIG: configFile,
      QUEUE_ROOT: folder,
      QUEUE_GIT: folder,
      QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
    };
    const run = (...args: string[]) => {
      const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'orchestrator', 'queue.mjs'), ...args], {
        encoding: 'utf8',
        env,
      });
      return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '' };
    };

    // K has 5 measured tasks of size S: median $3. D has none: the static model.
    const dModel = L.estimateCost({ class: 'D', content_min: 40 });
    const next = run('next');
    expect(next.code).toBe(0);
    expect(next.out).toMatch(/^W-1\s+K\s+a\s+30 min ~\$3\.0 {2}priority/m);
    expect(next.out).toMatch(new RegExp(`^W-2\\s+D\\s+b\\s+52 min ~\\$${dModel.toFixed(1)} {2}priority`, 'm'));
    expect(next.out).toMatch(/Budget outlook: what can start now is estimated at ~\$\d+\.\d\d; \$50\.00 is left today\./);

    const show = run('show');
    expect(show.out).toMatch(/^ {2}W-1\s+K\s+a\s+30 min\s+~\$3\.0\s+prio/m);
    expect(run('show', '--full').out).toMatch(/^W-1\s+waiting\s+K\s+a\s+30 min\s+~\$3\.0\s/m);

    expect(run('info', 'W-1').out).toMatch(/^estimate: 30 min · ~\$3 \(measured, class\+size, n=5\)$/m);
    expect(run('info', 'W-2').out).toMatch(/^estimate: 52 min · ~\$[\d.]+ \(model, too little measured data\)$/m);

    const state = JSON.parse(run('state').out);
    expect(state.costEstimate.perClass.K).toEqual({ n: 5, median_usd: 3, factor: expect.any(Number), measured: true });
    expect(state.costEstimate.next).toEqual([
      { id: 'W-1', class: 'K', estimate_min: 30, usd: 3, source: 'measured', basis: 'class+size' },
      { id: 'W-2', class: 'D', estimate_min: 52, usd: dModel, source: 'model', basis: 'model' },
    ]);
    expect(state.costEstimate.budget).toMatchObject({ left: 50, over: false });

    const cal = run('calibrate');
    expect(cal.code).toBe(0);
    expect(cal.out).toMatch(/^ {2}K\s+5\s+/m);
    expect(JSON.parse(run('calibrate', '--json', '--days', '7').out).rows[0]).toMatchObject({ class: 'K', n: 5 });
    expect(run('calibrate', '--days', '0').code).toBe(1);

    // $10 in the time log (K-0, K-1, the cancelled C-1 and an agent without a task) / 5 merged = $2.
    const cost = run('cost');
    expect(cost.out.split('\n')[0]).toBe(
      'USD per merged change (last 28 days): $2.00 = $10.00 all measured cost / 5 merged',
    );
    expect(cost.out).toMatch(/cancelled \$4\.00/);
    expect(cost.out).toMatch(/Cost per task \(5 finished/);
    expect(JSON.parse(run('cost', '--json').out).perMerged).toMatchObject({ merged: 5, usd_per_merged: 2 });
  }, 120_000);
});
