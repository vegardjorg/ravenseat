// =============================================================
// queueSchedule.test.ts: the schedule simulation (lib/queueSchedule.js, roadmap TIDSLINJE A0) and `ravenseat schedule`.
//
// The rules are enforced in queueSchedule.schedule (pure: a fixed clock, a fixed time zone, fixtures in memory), so they
// are asserted there: the order comes from the queue's own selectNext/ranking, the duration is estimateWall x the
// measured ratio (never the raw minute estimate), the slots are min(maxConcurrent, quota, load) plus maxDPlus, maxDb
// and owned-file conflicts, depends_on, owner questions with the median answer time ("waits on you"), the night pause,
// running tasks with the remaining time, and the per focus step P50 end. The CLI is run against a temporary queue.
// =============================================================
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type Band = { low_min: number; high_min: number; label: string };
type Row = {
  id: string;
  start: string;
  end: string;
  minutes: number;
  remaining_min?: number;
  basis: string;
  n: number;
  rough: true;
  band: Band;
  waits_on_you: boolean;
  answer_at: string | null;
  over_estimate: boolean;
  running: boolean;
  step: number | null;
};
type Step = {
  step: number | null;
  stage: string | null;
  title: string;
  tasks: number;
  scheduled: number;
  unscheduled: number;
  p50_end: string | null;
};
type Schedule = {
  now: string;
  rough: true;
  slots: { slots: number; maxConcurrent: number; quota: number | null; load: number | null };
  answer: { minutes: number; basis: string; n: number };
  tasks: Row[];
  unscheduled: { id: string; reason: string }[];
  steps: Step[];
  end: string | null;
  precision: string;
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const S = require('../queueSchedule.js') as {
  schedule: (queue: unknown, option?: Record<string, unknown>) => Schedule;
  ratioModel: (queue: unknown, option?: Record<string, unknown>) => unknown;
  durationFor: (o: unknown, model: unknown) => { minutes: number; basis: string; n: number; band: Band };
  quotaSlotsFrom: (p: unknown, running: number) => number | null;
  scheduleLines: (s: Schedule, option?: Record<string, unknown>) => string[];
  DEFAULT_ANSWER_MIN: number;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const L = require('../queueLogic.js') as { estimateWall: (o: unknown) => number; estimate: (o: unknown) => number };

const NOW = Date.parse('2026-11-02T10:00:00.000Z');
const MIN = 60_000;
const at = (min: number) => new Date(NOW + min * MIN).toISOString();
const ago = (min: number) => new Date(NOW - min * MIN).toISOString();
const run = (queue: unknown, option: Record<string, unknown> = {}) =>
  S.schedule(queue, { now: NOW, tz: 'UTC', ...option });
const row = (s: Schedule, id: string) => {
  const r = s.tasks.find((x) => x.id === id);
  if (!r) throw new Error(`${id} not scheduled: ${JSON.stringify(s.unscheduled)}`);
  return r;
};
const task = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: id,
  class: 'K',
  status: 'waiting',
  content_min: 30,
  value: 5,
  added_at: ago(60),
  ...extra,
});
const queueOf = (tasks: unknown[], extra: Record<string, unknown> = {}) => ({
  limits: { maxConcurrent: 5 },
  resolved: [],
  projects: {},
  tasks,
  ...extra,
});
// A done K task (content 30, so estimateWall 16) that took `cycle` minutes, finished `daysAgo` days back.
const doneK = (id: string, cycle: number, extra: Record<string, unknown> = {}) => ({
  id,
  title: id,
  class: 'K',
  status: 'done',
  content_min: 30,
  started: ago(24 * 60 + cycle),
  done: ago(24 * 60),
  ...extra,
});

describe('queueSchedule: order and duration', () => {
  it('takes the order from the queue ranking and runs one after another on one slot', () => {
    const q = queueOf([task('LOW', { value: 2 }), task('HIGH', { value: 9 })], { limits: { maxConcurrent: 1 } });
    const s = run(q);
    const wall = L.estimateWall(q.tasks[0]);
    expect(row(s, 'HIGH').start).toBe(at(0));
    expect(row(s, 'HIGH').end).toBe(at(wall));
    expect(row(s, 'LOW').start).toBe(at(wall));
    expect(s.tasks.map((r) => r.id)).toEqual(['HIGH', 'LOW']);
  });

  it('uses the calibrated wall time, never the raw minute estimate', () => {
    const o = task('DP', { class: 'D+', content_min: 30 });
    const s = run(queueOf([o]));
    expect(L.estimate(o)).not.toBe(L.estimateWall(o));
    expect(row(s, 'DP').minutes).toBe(L.estimateWall(o));
    expect(row(s, 'DP').basis).toBe('model');
  });

  it('scales by the median actual/calibrated ratio: class + size with 5 or more, else class, else the model', () => {
    const five = [1, 2, 3, 4, 5].map((i) => doneK(`D${i}`, 32)); // ratio 32/16 = 2
    const bySize = run(queueOf([...five, task('N')]));
    expect(row(bySize, 'N').minutes).toBe(32);
    expect(row(bySize, 'N').basis).toBe('class+size');
    expect(row(bySize, 'N').n).toBe(5);
    // Four in the size bucket S and one in M: the class has 5, the bucket does not.
    const mixed = [1, 2, 3, 4].map((i) => doneK(`D${i}`, 32));
    const m = doneK('DM', 45, { content_min: 60 }); // estimateWall 21, ratio about 2.14
    const byClass = run(queueOf([...mixed, m, task('N')]));
    expect(row(byClass, 'N').basis).toBe('class');
    expect(row(byClass, 'N').minutes).toBe(32);
    const few = run(queueOf([...mixed, task('N')]));
    expect(row(few, 'N').basis).toBe('model');
    expect(row(few, 'N').minutes).toBe(16);
  });

  it('marks every task bar as rough with a band around the expected time and no date in the label', () => {
    const s = run(queueOf([task('A'), task('B', { class: 'D' })]));
    for (const r of s.tasks) {
      expect(r.rough).toBe(true);
      expect(r.band.low_min).toBeLessThan(r.minutes);
      expect(r.band.high_min).toBeGreaterThan(r.minutes);
      expect(r.band.high_min / r.band.low_min).toBeGreaterThanOrEqual(2.5);
      expect(r.band.label).toMatch(/rough/);
      expect(r.band.label).not.toMatch(/\d{4}-\d\d-\d\d|\d\d:\d\d/);
    }
    expect(s.rough).toBe(true);
  });
});

describe('queueSchedule: slots and limits', () => {
  const three = () => [task('A'), task('B'), task('C')];

  it('uses min(maxConcurrent, quota, load) slots', () => {
    const q = queueOf(three(), { limits: { maxConcurrent: 3 } });
    expect(run(q).tasks.filter((r) => r.start === at(0))).toHaveLength(3);
    const quota = run(q, { quotaSlots: 2 });
    expect(quota.tasks.filter((r) => r.start === at(0))).toHaveLength(2);
    expect(quota.slots).toMatchObject({ slots: 2, maxConcurrent: 3, quota: 2, load: null });
    const load = run(q, { quotaSlots: 2, loadSlots: 1 });
    expect(load.tasks.filter((r) => r.start === at(0))).toHaveLength(1);
    expect(load.slots.slots).toBe(1);
  });

  it('holds maxDPlus and maxDb', () => {
    const dp = queueOf([task('P1', { class: 'D+' }), task('P2', { class: 'D+' })], {
      limits: { maxConcurrent: 5, maxDPlus: 1 },
    });
    const s = run(dp);
    expect(row(s, 'P2').start).toBe(row(s, 'P1').end);
    const db = queueOf([task('M1', { migr_tens: 1 }), task('M2', { migr_tens: 1 })], {
      limits: { maxConcurrent: 5, maxDb: 1 },
    });
    const t = run(db);
    const [first, second] = [row(t, 'M1'), row(t, 'M2')].sort((x, y) => x.start.localeCompare(y.start));
    expect(second.start).toBe(first.end);
  });

  it('runs two tasks that own the same file one after the other', () => {
    const q = queueOf([task('F1', { owned_files: ['src/a.js'] }), task('F2', { owned_files: ['src/a.js'] })]);
    const s = run(q);
    const [first, second] = [row(s, 'F1'), row(s, 'F2')].sort((x, y) => x.start.localeCompare(y.start));
    expect(first.start).toBe(at(0));
    expect(second.start).toBe(first.end);
  });

  it('starts a dependent task when its dependency is done', () => {
    const q = queueOf([task('A'), task('B', { depends_on: ['A'], value: 10 })]);
    const s = run(q);
    expect(row(s, 'B').start).toBe(row(s, 'A').end);
  });
});

describe('queueSchedule: owner questions, night, running tasks', () => {
  it('gives an open owner question the median answer time and marks the task as waiting on you', () => {
    const q = queueOf([task('Q', { waiting_on: ['q1'] }), task('FREE')]);
    const s = run(q);
    expect(s.answer).toEqual({ minutes: S.DEFAULT_ANSWER_MIN, basis: 'default', n: 0 });
    expect(row(s, 'Q').start).toBe(at(S.DEFAULT_ANSWER_MIN));
    expect(row(s, 'Q').waits_on_you).toBe(true);
    expect(row(s, 'Q').answer_at).toBe(at(S.DEFAULT_ANSWER_MIN));
    expect(row(s, 'FREE').waits_on_you).toBe(false);
    // Five measured answers of 90 minutes each: the median is used.
    const answered = [1, 2, 3, 4, 5].map((i) => task(`R${i}`, { status: 'done', waiting_on: [`old${i}`], added_at: ago(600) }));
    const resolutions = Object.fromEntries([1, 2, 3, 4, 5].map((i) => [`old${i}`, { time: ago(510) }]));
    const m = run(
      queueOf([...answered, task('Q', { waiting_on: ['q1'] })], {
        resolved: ['old1', 'old2', 'old3', 'old4', 'old5'],
        resolutions,
      }),
    );
    expect(m.answer).toEqual({ minutes: 90, basis: 'measured', n: 5 });
    expect(row(m, 'Q').start).toBe(at(90));
  });

  it('starts nothing in the night window when nightRun is off', () => {
    const now = Date.parse('2026-11-02T22:50:00.000Z');
    const q = queueOf([task('A'), task('B')], {
      limits: { maxConcurrent: 1, nightRun: false, nightWindow: '23-06' },
    });
    const s = S.schedule(q, { now, tz: 'UTC' });
    const [first, second] = [...s.tasks].sort((x, y) => x.start.localeCompare(y.start));
    expect(first.start).toBe(new Date(now).toISOString());
    expect(second.start).toBe('2026-11-03T06:00:00.000Z');
    // With nightRun on (the default) the second starts right after the first.
    const on = S.schedule(queueOf([task('A'), task('B')], { limits: { maxConcurrent: 1 } }), { now, tz: 'UTC' });
    const sorted = [...on.tasks].sort((x, y) => x.start.localeCompare(y.start));
    expect(sorted[1].start).toBe(sorted[0].end);
  });

  it('gives a running task the remaining time, never below zero, and marks one past its estimate', () => {
    const q = queueOf(
      [
        task('R', { status: 'running', started: ago(10) }),
        task('OVER', { status: 'running', started: ago(30) }),
        task('REV', { status: 'review', started: ago(4) }),
      ],
      {},
    );
    const s = run(q);
    expect(row(s, 'R')).toMatchObject({ running: true, remaining_min: 6, end: at(6), over_estimate: false });
    expect(row(s, 'OVER')).toMatchObject({ running: true, remaining_min: 0, end: at(0), over_estimate: true });
    expect(row(s, 'REV')).toMatchObject({ running: true, remaining_min: 12, end: at(12) });
  });

  it('counts a running task toward the slots', () => {
    const q = queueOf([task('R', { status: 'running', started: ago(10) }), task('W')], {
      limits: { maxConcurrent: 1 },
    });
    expect(row(run(q), 'W').start).toBe(at(6));
  });
});

describe('queueSchedule: focus steps and what cannot be scheduled', () => {
  const focusQueue = () =>
    queueOf(
      [
        task('A1', { project: 'a' }),
        task('A2', { project: 'a' }),
        task('B1', { project: 'b', value: 10 }),
        task('C1', { project: 'c', value: 10 }),
      ],
      {
        limits: { maxConcurrent: 1 },
        projects: { a: { title: 'Alpha' }, b: { title: 'Beta' }, c: { title: 'Gamma' } },
        focus: { order: ['project:a', 'project:b'], rest: 'fill' },
      },
    );

  it('runs step 1 before step 2 and gives each step a P50 end', () => {
    const q = focusQueue();
    (q as { focus: Record<string, unknown> }).focus.continue_when_empty = true;
    const s = run(q);
    expect(s.tasks.map((r) => r.id)).toEqual(['A1', 'A2', 'B1', 'C1']);
    const [one, two, rest] = s.steps;
    expect(one).toMatchObject({ step: 0, stage: 'project:a', title: 'Alpha', tasks: 2, scheduled: 2 });
    expect(one.p50_end).toBe(row(s, 'A2').end);
    expect(two).toMatchObject({ step: 1, title: 'Beta', tasks: 1, p50_end: row(s, 'B1').end });
    expect(rest).toMatchObject({ step: null, title: 'rest', tasks: 1, p50_end: row(s, 'C1').end });
    expect(s.end).toBe(row(s, 'C1').end);
  });

  it('shows the pause when the focus runs empty and the queue does not continue (the default)', () => {
    const s = run(focusQueue());
    expect(s.tasks.map((r) => r.id)).toEqual(['A1', 'A2', 'B1']);
    expect(s.unscheduled).toEqual([{ id: 'C1', reason: expect.stringMatching(/queue paused/) }]);
    expect(s.steps[2]).toMatchObject({ step: null, tasks: 1, scheduled: 0, unscheduled: 1, p50_end: null });
  });

  it('one group for the whole queue without a focus', () => {
    const s = run(queueOf([task('A'), task('B')]));
    expect(s.steps).toHaveLength(1);
    expect(s.steps[0]).toMatchObject({ step: null, stage: null, tasks: 2, scheduled: 2 });
  });

  it('lists what never starts in the simulation, with the reason', () => {
    const q = queueOf([
      task('P', { status: 'proposed' }),
      task('U', { depends_on: ['NOPE'] }),
      task('OK'),
    ]);
    const s = run(q);
    expect(s.tasks.map((r) => r.id)).toEqual(['OK']);
    expect(s.unscheduled.map((x) => x.id).sort()).toEqual(['U']);
    expect(s.unscheduled[0].reason).toMatch(/NOPE/);
  });

  it('never changes the queue it is given', () => {
    const q = focusQueue();
    const before = JSON.stringify(q);
    run(q);
    expect(JSON.stringify(q)).toBe(before);
  });

  it('says how rough it is in one honest line, and the text has no date per task', () => {
    const q = focusQueue();
    (q as { focus: Record<string, unknown> }).focus.continue_when_empty = true;
    const s = run(q);
    expect(s.precision).toMatch(/rough/i);
    const lines = S.scheduleLines(s, { tz: 'UTC', next: 5 });
    const taskLines = lines.filter((l) => /^\s+(A1|A2|B1|C1)\b/.test(l));
    expect(taskLines).toHaveLength(4);
    for (const l of taskLines) expect(l).not.toMatch(/\d{4}-\d\d-\d\d|\d\d:\d\d/);
    expect(lines.join('\n')).toContain(s.precision);
  });
});

describe('queueSchedule: rough lengths', () => {
  it('rounds to 5 min below an hour, half hours below two days, then days', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { roughDuration } = require('../queueSchedule.js') as { roughDuration: (m: number) => string };
    expect(roughDuration(2)).toBe('5 min');
    expect(roughDuration(23)).toBe('25 min');
    expect(roughDuration(58)).toBe('1 h');
    expect(roughDuration(100)).toBe('1.5 h');
    expect(roughDuration(3 * 1440)).toBe('3 d');
  });
});

describe('queueSchedule: the quota cap', () => {
  it('is the cap fill uses: off in notice mode, the suggestion (at least 1) in cap mode', () => {
    // The fields queueCapacity.quotaCap reads from a forecast (it also builds its message from them).
    const p = (extra: Record<string, unknown>) => ({
      pct: 50,
      emptyAverage: NOW + 3_600_000,
      to: NOW + 86_400_000,
      reset: { tz: 'UTC' },
      holds: false,
      ...extra,
    });
    expect(S.quotaSlotsFrom(p({ mode: 'notice', suggestionTrack: 2 }), 0)).toBeNull();
    expect(S.quotaSlotsFrom(p({ mode: 'cap', suggestionTrack: null }), 0)).toBeNull();
    expect(S.quotaSlotsFrom(p({ mode: 'cap', suggestionTrack: 2 }), 1)).toBe(2);
    expect(S.quotaSlotsFrom(p({ mode: 'cap', suggestionTrack: 0 }), 0)).toBe(1);
    expect(S.quotaSlotsFrom(p({ mode: 'cap', suggestionTrack: 3, holds: true, pct: 10 }), 1)).toBeNull();
  });
});

describe('scheduleLines with the band (T-C)', () => {
  it('adds "likely by" to a step that has a band, and the backtest line', () => {
    const s = run(queueOf([task('A'), task('B')]));
    const end = s.steps[0].p50_end as string;
    const p85 = new Date(Date.parse(end) + 90 * MIN).toISOString();
    const band = { enough: true, steps: [{ step: null, stage: null, title: 'the whole queue', p50_end: end, p85_end: p85 }] };
    const lines = S.scheduleLines(s, { tz: 'UTC', band, backtest: { text: 'Backtest: about 7 of 10 steps were done by the end of their band (9 past days checked).' } });
    expect(lines[1]).toMatch(/expected done in about .* \(around Mon 10:30\), likely by around Mon 12:00 \(P85\)$/);
    expect(lines).toContain('Backtest: about 7 of 10 steps were done by the end of their band (9 past days checked).');
    const none = S.scheduleLines(s, { tz: 'UTC', band: { enough: false, reason: 'No band yet: 2 finished tasks.' } });
    expect(none).toContain('No band yet: 2 finished tasks.');
  });
});

describe('ravenseat schedule (CLI)', () => {
  const folders: string[] = [];
  afterAll(() => {
    for (const f of folders) fs.rmSync(f, { recursive: true, force: true });
  });

  it('prints the steps, the next tasks and the precision line; --json; exit 2 on a usage error', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-schedule-'));
    folders.push(folder);
    const tasks = [task('A'), task('B', { depends_on: ['A'] }), task('C', { class: 'D' })];
    fs.writeFileSync(path.join(folder, 'queue.json'), JSON.stringify(queueOf(tasks)));
    const configFile = path.join(folder, 'queue.config.json');
    fs.writeFileSync(configFile, '{}');
    const env = {
      ...process.env,
      QUEUE_FOLDER: folder,
      QUEUE_CONFIG: configFile,
      QUEUE_ROOT: folder,
      QUEUE_GIT: folder,
      QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
      QUEUE_LOAD: 'free=90',
    };
    const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
    const cli = (...args: string[]) => {
      const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'orchestrator', 'queue.mjs'), ...args], {
        encoding: 'utf8',
        env,
      });
      return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '' };
    };
    const text = cli('schedule');
    expect(text.code).toBe(0);
    expect(text.out).toMatch(/The whole queue: 3 tasks, expected done in about/);
    expect(text.out).toMatch(/^\s+A\b/m);
    expect(text.out).toMatch(/rough/i);
    const json = JSON.parse(cli('schedule', '--json').out) as Schedule;
    expect(json.tasks.map((r) => r.id).sort()).toEqual(['A', 'B', 'C']);
    expect(json.tasks.every((r) => r.rough)).toBe(true);
    // T-C: the band and the backtest ride along (too little history here: no band, and the line why).
    const extra = json as unknown as { uncertainty: { enough: boolean; reason: string }; backtest: { text: string } };
    expect(extra.uncertainty.enough).toBe(false);
    expect(extra.uncertainty.reason).toMatch(/^No band yet/);
    expect(extra.backtest.text).toMatch(/^No backtest yet/);
    expect(text.out).toMatch(/No band yet/);
    expect(cli('schedule', '--bogus').code).toBe(2);
    expect(cli('schedule', 'extra').code).toBe(2);
    expect(cli('schedule', '--next', '0').code).toBe(2);
    expect(JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8'))).toEqual(queueOf(tasks));
  });
});
