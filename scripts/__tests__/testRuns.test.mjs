// =============================================================
// testRuns.test.mjs: the local test run log (scripts/test-runs.mjs) and the counting reporter's helpers
// (scripts/test-run-reporter.mjs). Every file is in a temp folder; the real log is never touched.
// =============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { countTests, fileFilters } from '../test-run-reporter.mjs';
import { appendRun, enabled, logPath, readRuns, runStats, statsLines } from '../test-runs.mjs';

let root;
const NO_ENV = {};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-test-runs-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('where and whether', () => {
  it('the log is <dataFolder>/test-runs.jsonl, scripts/.queue by default', () => {
    expect(logPath(root, NO_ENV)).toBe(path.join(root, 'scripts/.queue', 'test-runs.jsonl'));
    fs.writeFileSync(path.join(root, 'queue.config.json'), JSON.stringify({ dataFolder: 'data/q' }));
    expect(logPath(root, NO_ENV)).toBe(path.join(root, 'data/q', 'test-runs.jsonl'));
    expect(logPath(root, { RAVENSEAT_TEST_RUNS_LOG: '/x/y.jsonl' })).toBe('/x/y.jsonl');
  });

  it('on by default; testRuns.log false and RAVENSEAT_TEST_RUNS=off turn it off; a broken config keeps it on', () => {
    expect(enabled(root, NO_ENV)).toBe(true);
    expect(enabled(root, { RAVENSEAT_TEST_RUNS: 'OFF' })).toBe(false);
    fs.writeFileSync(path.join(root, 'queue.config.json'), '{ not json');
    expect(enabled(root, NO_ENV)).toBe(true);
    fs.writeFileSync(path.join(root, 'queue.config.json'), JSON.stringify({ testRuns: { log: false } }));
    expect(enabled(root, NO_ENV)).toBe(false);
    expect(appendRun({ time: 'x' }, { root, env: NO_ENV })).toBe(false);
    expect(fs.existsSync(logPath(root, NO_ENV))).toBe(false);
  });
});

describe('appendRun', () => {
  it('one JSON line per row, without undefined or null fields', () => {
    expect(appendRun({ time: 't1', mode: 'some', list: undefined, tests: null }, { root, env: NO_ENV })).toBe(true);
    appendRun({ time: 't2', mode: 'full' }, { root, env: NO_ENV });
    const file = logPath(root, NO_ENV);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"time":"t1","mode":"some"}\n{"time":"t2","mode":"full"}\n');
    expect(readRuns(file).map((r) => r.time)).toEqual(['t1', 't2']);
  });

  it('past the size cap the file keeps only its newest rows', () => {
    const file = path.join(root, 'cap.jsonl');
    for (let i = 0; i < 30; i++) appendRun({ i, pad: 'x'.repeat(40) }, { root, env: NO_ENV, file, maxBytes: 600, keepLines: 5 });
    const rows = readRuns(file);
    expect(fs.statSync(file).size).toBeLessThanOrEqual(600 + 60);
    expect(rows.length).toBeLessThanOrEqual(12);
    expect(rows.at(-1).i).toBe(29);
  });

  it('a failure to write gives false and never throws', () => {
    // the target's folder is a file, so mkdir fails
    const blocker = path.join(root, 'blocker');
    fs.writeFileSync(blocker, '');
    expect(appendRun({ time: 't' }, { root, env: NO_ENV, file: path.join(blocker, 'log.jsonl') })).toBe(false);
  });

  it('readRuns skips a torn line and gives [] for a missing file', () => {
    const file = path.join(root, 'torn.jsonl');
    fs.writeFileSync(file, '{"a":1}\n{"a":\n\n{"a":3}\n');
    expect(readRuns(file)).toEqual([{ a: 1 }, { a: 3 }]);
    expect(readRuns(path.join(root, 'none.jsonl'))).toEqual([]);
  });
});

describe('runStats and statsLines', () => {
  const now = Date.parse('2026-11-19T12:00:00Z');
  const at = (h) => new Date(now - h * 3_600_000).toISOString();
  const rows = [
    { time: at(1), via: 'test:changed', mode: 'some', picked: 10, total: 400, pick_s: 2, run_s: 60, exit: 0 },
    { time: at(2), via: 'test:changed', mode: 'some', picked: 40, total: 400, pick_s: 3, run_s: 100, exit: 1 },
    { time: at(3), via: 'test:changed', mode: 'full', picked: 400, total: 400, pick_s: 4, run_s: 2400, exit: 0 },
    { time: at(4), via: 'test:changed', mode: 'none', picked: 0, total: 400, pick_s: 2, run_s: 0, exit: 0 },
    { time: at(5), via: 'test:changed', mode: 'some', picked: 5, total: 400, pick_s: 2, list: true },
    { time: at(6), via: 'vitest', mode: 'full', picked: 400, run_s: 2300, exit: 0 },
    { time: at(24 * 20), via: 'vitest', mode: 'full', run_s: 9999, exit: 1 },
    { time: 'not a time', mode: 'full' },
  ];

  it('counts the runs in the window, leaves --list out, and takes medians', () => {
    const s = runStats(rows, { days: 14, now });
    expect(s.runs).toBe(5);
    expect(s.lists).toBe(1);
    expect(s.split).toEqual({ full: 2, some: 2, none: 1 });
    expect(s.via).toEqual({ 'test:changed': 4, vitest: 1 });
    // shares 0.025, 0.1, 1 (full), 0 (none): median (0.025 + 0.1) / 2
    expect(s.medianShare).toBeCloseTo(0.0625);
    expect(s.medianRunSByMode).toEqual({ full: 2350, some: 80 });
    expect(s.medianRunS).toBe(100);
    expect(s.failedRuns).toBe(1);
  });

  it('the read view names the file and the numbers; an empty log says so', () => {
    const lines = statsLines(runStats(rows, { days: 14, now }), '/f.jsonl');
    expect(lines[0]).toBe('Test runs, last 14 days (/f.jsonl):');
    expect(lines.join('\n')).toContain('runs 5: full 2, some 2, none 1 (4 test:changed, 1 vitest); 1 --list picks not counted');
    expect(lines.join('\n')).toContain('median picked share (test:changed, FULL as 100 %): 6 %');
    expect(lines.join('\n')).toContain('full 39.2 min, some 80 s');
    expect(lines.join('\n')).toContain('failed runs: 1');
    expect(statsLines(runStats([], { now }), '/f.jsonl')[1]).toBe('  no runs logged');
  });
});

describe('the reporter helpers', () => {
  it('fileFilters: the non-flag arguments after run', () => {
    expect(fileFilters(['node', 'vitest.mjs', 'run'])).toEqual([]);
    expect(fileFilters(['node', 'vitest.mjs', 'run', 'a.test.ts', '--reporter', 'dot', 'b'])).toEqual(['a.test.ts', 'b']);
    expect(fileFilters(['node', 'vitest.mjs', 'run', '--bail=1', 'x.test.mjs'])).toEqual(['x.test.mjs']);
    expect(fileFilters(['node', 'vitest.mjs'])).toEqual([]);
  });

  it('countTests: every test case and the failed ones', () => {
    const mod = (states) => ({ children: { allTests: () => states.map((s) => ({ result: () => ({ state: s }) })) } });
    expect(countTests([mod(['passed', 'failed']), mod(['passed', 'skipped'])])).toEqual({ tests: 4, failed: 1, modules: 2 });
    expect(countTests(undefined)).toEqual({ tests: 0, failed: 0, modules: 0 });
  });
});
