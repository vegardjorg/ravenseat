// =============================================================
// gateHealth.js: the gate health view (`ravenseat gates --health`): per gate command how many runs, how many red, how
// many flaky, the p50/p95 seconds, the slowest, and the commands that were never red over many runs.
//
// WHY: a gate costs time on every run, and a gate that never goes red may not catch anything (a test that asserts on a
// test double, a check whose pattern matches nothing). Both are invisible run by run. Read from the time log's `gate`
// rows (lib/timeLogRows.js gateRow) and `flakyGate` rows (lib/eventRows.js), across the monthly archives, so the
// history is long enough to say "never red in 50 runs".
//
// Why its own view under `gates` and not in `ravenseat cost` or `doctor`: cost is about money and doctor about the
// setup; this is about the gates themselves (time and whether they catch anything), it is read-only and it needs no
// gate slot, so it lives with the command that runs them.
//
// Counting:
//   - a run of a command: the command is in the row's `gates`; red: it is in `failed`;
//   - flaky: in the row's `flaky` (a track's red-then-green rerun), or in a flakyGate row from the base gate. A track's
//     flakyGate row is skipped: its gate row already carries `flaky`, so it would count twice;
//   - seconds: the row's `durations[command]` (newer rows); a single-command row without it uses the run's
//     `duration_s`; otherwise the run is not timed for that command (`timed` < `runs`);
//   - p50/p95: nearest rank over the timed runs;
//   - never red: at least `minRuns` runs, none red and none flaky.
// Pure functions without I/O. Tested in lib/__tests__/gateHealth.test.ts.
// =============================================================
'use strict';

/** Runs before "never red" says anything. */
const MIN_RUNS = 50;

/** Nearest-rank percentile of sorted numbers (null for an empty list). */
function percentile(sorted, p) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length))) - 1];
}

/** The gate and flakyGate rows from the time log text; other rows and broken lines are skipped. */
function rowsFromText(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.includes('"gate"') && !line.includes('"flakyGate"')) continue; // cheap skip before JSON.parse
    try {
      const r = JSON.parse(line);
      if (r?.event === 'gate' || r?.event === 'flakyGate') out.push(r);
    } catch {
      // error-ignored: a half-written line; the rest of the log still counts
    }
  }
  return out;
}

/**
 * @param {object[]} rows gate and flakyGate rows
 * @returns {{ runs: number, minRuns: number, commands: { command: string, runs: number, red: number, flaky: number,
 *   timed: number, p50: number|null, p95: number|null, max: number|null }[], neverRed: object[] }}
 */
function gateHealth(rows, { minRuns = MIN_RUNS } = {}) {
  const per = new Map();
  const of = (c) => {
    if (!per.has(c)) per.set(c, { command: c, runs: 0, red: 0, flaky: 0, secs: [] });
    return per.get(c);
  };
  let runs = 0;
  for (const r of rows ?? []) {
    if (r?.event === 'flakyGate') {
      if (String(r.source ?? '').startsWith('track gate')) continue;
      for (const c of r.commands ?? []) of(c).flaky++;
      continue;
    }
    if (r?.event !== 'gate') continue;
    const gates = Array.isArray(r.gates) ? r.gates : [];
    if (!gates.length) continue;
    runs++;
    const failed = new Set(Array.isArray(r.failed) ? r.failed : []);
    for (const c of gates) {
      const x = of(c);
      x.runs++;
      if (failed.has(c)) x.red++;
      const d = r.durations?.[c];
      if (Number.isFinite(d)) x.secs.push(d);
      else if (!r.durations && gates.length === 1 && Number.isFinite(r.duration_s)) x.secs.push(r.duration_s);
    }
    for (const c of Array.isArray(r.flaky) ? r.flaky : []) of(c).flaky++;
  }
  const commands = [...per.values()]
    .map(({ secs, ...x }) => {
      const s = secs.sort((a, b) => a - b);
      return { ...x, timed: s.length, p50: percentile(s, 0.5), p95: percentile(s, 0.95), max: s.length ? s[s.length - 1] : null };
    })
    .sort((a, b) => (b.p95 ?? -1) - (a.p95 ?? -1) || b.runs - a.runs || a.command.localeCompare(b.command));
  const neverRed = commands.filter((c) => c.runs >= minRuns && c.red === 0 && c.flaky === 0);
  return { runs, minRuns, commands, neverRed };
}

/** The lines for `ravenseat gates --health`. */
function healthLines(h) {
  if (!h.runs) return ['Gate health: No gate runs in the time log yet (every ravenseat gates run adds one).'];
  const s = (x) => (x == null ? '?' : `${x} s`);
  const out = [`Gate health (${h.runs} run(s) in the time log and its archives; slowest by p95 first):`];
  for (const c of h.commands)
    out.push(
      `  ${c.command}: ${c.runs} run(s), ${c.red} red, ${c.flaky} flaky, p50 ${s(c.p50)}, p95 ${s(c.p95)}, slowest ${s(c.max)}` +
        (c.timed < c.runs ? ` (timed in ${c.timed} of ${c.runs})` : ''),
    );
  const flaky = h.commands.filter((c) => c.flaky > 0).sort((a, b) => b.flaky - a.flaky);
  if (flaky.length) out.push(`Flaky (red, then green on a rerun): ${flaky.map((c) => `${c.command} (${c.flaky})`).join(', ')}`);
  for (const c of h.neverRed)
    out.push(
      `HINT: ${c.command} was never red in ${c.runs} run(s) and may not catch anything: try breaking the code it guards ` +
        'and see that it goes red.',
    );
  if (!h.neverRed.length) out.push(`No command has gone ${h.minRuns} or more runs without a red one.`);
  return out;
}

module.exports = { MIN_RUNS, percentile, rowsFromText, gateHealth, healthLines };
