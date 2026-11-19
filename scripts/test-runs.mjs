// =============================================================
// scripts/test-runs.mjs: the local log of test runs (test:changed and plain vitest runs), and its short read view.
//
// Why: nothing recorded the runs, so neither the pick of test:changed (how much it runs, how often FULL) nor the time a
// run takes could be judged afterwards (TC-1, 2026-11-19). One JSON line per run, in a file that never leaves the machine.
//
// Where: <dataFolder>/test-runs.jsonl, the same folder as the queue's other local logs (dataFolder in queue.config.json,
// default scripts/.queue, gitignored). It is found from the repo root, not through lib/queueConfig.js: vitest.config.mjs
// points QUEUE_ROOT at an empty temp folder, so the queue's own lookup would land there. RAVENSEAT_TEST_RUNS_LOG names
// another file (tests).
//
// A row (fields left out when not known):
//   { time (UTC ISO), via ('test:changed' | 'vitest'), ref, mode ('full' | 'some' | 'none'), reason, picked, total,
//     changed, pick_s, run_s, exit, tests, failed }
//   via test:changed: one row per run, --list included (no run_s and no exit then, list: true). via vitest: a plain
//   `npm test` / `vitest run` (the reporter scripts/test-run-reporter.mjs); mode full without file filters, some with.
//
// Size: over MAX_BYTES the file is cut to its newest KEEP_LINES rows (a run appends about 250 bytes).
// Off: testRuns.log false in queue.config.json, or RAVENSEAT_TEST_RUNS=off. A failure to log never fails a run: every
// write is in a try/catch and gives false.
//
// Read: `node scripts/test-changed.mjs --stats [--days N]` (statsLines). Tested in scripts/__tests__/testRuns.test.mjs.
// =============================================================
import fs from 'node:fs';
import path from 'node:path';

export const MAX_BYTES = 512 * 1024;
export const KEEP_LINES = 1000;
export const DEFAULT_DAYS = 14;

/** queue.config.json at the root, or {} (a missing or broken file is not this module's business). */
function rootConfig(root) {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'queue.config.json'), 'utf8'));
    return cfg && typeof cfg === 'object' ? cfg : {};
  } catch {
    // error-ignored: no config means the defaults
    return {};
  }
}

/** Is logging on? testRuns.log (default true) and RAVENSEAT_TEST_RUNS=off. */
export function enabled(root, env = process.env) {
  if (String(env.RAVENSEAT_TEST_RUNS ?? '').toLowerCase() === 'off') return false;
  return rootConfig(root)?.testRuns?.log !== false;
}

/** The log file: RAVENSEAT_TEST_RUNS_LOG, else <root>/<dataFolder>/test-runs.jsonl. */
export function logPath(root, env = process.env) {
  if (env.RAVENSEAT_TEST_RUNS_LOG) return env.RAVENSEAT_TEST_RUNS_LOG;
  const folder = rootConfig(root).dataFolder;
  return path.join(root, typeof folder === 'string' && folder ? folder : 'scripts/.queue', 'test-runs.jsonl');
}

/**
 * Appends one row (undefined and null fields left out) and cuts the file when it grows past maxBytes. Gives true when
 * the row was written. Never throws.
 */
export function appendRun(row, { root, env = process.env, file = null, maxBytes = MAX_BYTES, keepLines = KEEP_LINES } = {}) {
  try {
    if (!enabled(root, env)) return false;
    const target = file ?? logPath(root, env);
    const clean = Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined && v !== null));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.appendFileSync(target, JSON.stringify(clean) + '\n');
    if (fs.statSync(target).size > maxBytes) {
      const lines = fs.readFileSync(target, 'utf8').split('\n').filter(Boolean);
      fs.writeFileSync(target, lines.slice(-keepLines).join('\n') + '\n');
    }
    return true;
  } catch {
    // error-ignored: the log is a convenience; a run must never fail because of it
    return false;
  }
}

/** The rows of a log file ([] when it is missing); a line that does not parse is skipped. */
export function readRuns(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    // error-ignored: no log yet
    return [];
  }
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // error-ignored: a torn line (two runs writing at once) is skipped
    }
  }
  return rows;
}

const median = (xs) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * The numbers over the last `days` days: runs (not --list), the full/some/none split, the median picked share (picked /
 * total over test:changed runs that ran, FULL counting as 100 %), the median run time per mode and overall, and the runs
 * that failed. Pure.
 */
export function runStats(rows, { days = DEFAULT_DAYS, now = Date.now() } = {}) {
  const from = now - days * 86_400_000;
  const inWindow = rows.filter((r) => {
    const t = Date.parse(r?.time);
    return Number.isFinite(t) && t >= from && t <= now + 60_000;
  });
  const runs = inWindow.filter((r) => !r.list);
  const split = { full: 0, some: 0, none: 0 };
  for (const r of runs) if (r.mode in split) split[r.mode]++;
  const via = {};
  for (const r of runs) via[r.via ?? '?'] = (via[r.via ?? '?'] ?? 0) + 1;
  const tc = runs.filter((r) => r.via === 'test:changed' && Number(r.total) > 0);
  const share = median(tc.map((r) => (r.mode === 'full' ? 1 : Number(r.picked) / Number(r.total))));
  const secs = (m) => median(runs.filter((r) => (!m || r.mode === m) && Number.isFinite(r.run_s)).map((r) => r.run_s));
  return {
    days,
    runs: runs.length,
    lists: inWindow.length - runs.length,
    split,
    via,
    medianShare: share,
    medianRunS: secs(null),
    medianRunSByMode: { full: secs('full'), some: secs('some') },
    medianPickS: median(runs.map((r) => r.pick_s)),
    failedRuns: runs.filter((r) => Number.isFinite(r.exit) && r.exit !== 0).length,
  };
}

const fmtS = (s) => (s === null ? '-' : s >= 120 ? `${(s / 60).toFixed(1)} min` : `${Math.round(s)} s`);

/** The read view as lines. */
export function statsLines(stats, file) {
  const out = [`Test runs, last ${stats.days} days (${file}):`];
  if (!stats.runs) {
    out.push(`  no runs logged${stats.lists ? ` (${stats.lists} --list picks)` : ''}`);
    return out;
  }
  const via = Object.entries(stats.via).map(([k, v]) => `${v} ${k}`).join(', ');
  out.push(`  runs ${stats.runs}: full ${stats.split.full}, some ${stats.split.some}, none ${stats.split.none} (${via})${stats.lists ? `; ${stats.lists} --list picks not counted` : ''}`);
  out.push(`  median picked share (test:changed, FULL as 100 %): ${stats.medianShare === null ? '-' : `${Math.round(stats.medianShare * 100)} %`}`);
  out.push(`  median run time: ${fmtS(stats.medianRunS)} (full ${fmtS(stats.medianRunSByMode.full)}, some ${fmtS(stats.medianRunSByMode.some)}); median pick time ${stats.medianPickS === null ? '-' : `${stats.medianPickS.toFixed(1)} s`}`);
  out.push(`  failed runs: ${stats.failedRuns}`);
  return out;
}
