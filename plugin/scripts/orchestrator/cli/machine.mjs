// =============================================================
// cli/machine.mjs: `ravenseat machine [--measure]`: what this machine is, and how many parallel tracks probably fit.
//
//   ravenseat machine            cores, memory, free memory now and the suggestion (lib/machineAdvice.js, an estimate).
//                                With no track running, the suggestion starts from the free memory now, which counts
//                                what the system and open apps hold; otherwise from memory and cores.
//   ravenseat machine --measure  runs `gates.mjs --quick` once (when quick gates are set) and then `gates.mjs --full` once,
//                                and shows the times, the lowest free memory and a suggestion for this project: the full
//                                check counts once (the gate queue), the quick check plus the agent is the cost of a
//                                track. Started by the user only, and refused while a track runs: a machine that is busy
//                                gives a figure that means nothing, and the run would slow the tracks down. A red quick
//                                check stops before the full one.
//
// It changes no setting. The measuring runs are ordinary gate runs: each appends a `gate` row to the time log, records
// gate evidence as a run in the main checkout does, and takes a slot in the gate queue when it is heavy.
//
// Used by: queue.mjs (dispatch). Tested in: lib/__tests__/machineAdvice.test.ts (the rule), __tests__/gateQueueFlow.test.ts.
// =============================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { a, CONFIG, CLI, die, FILE, HERE, MAIN_TREE, read, require, TIME_LOG } from './context.mjs';

const M = require('./lib/machineAdvice.js');
const LS = require('./lib/loadSlots.js');
const BH = require('./lib/baseHealth.js');
const GQ = require('./lib/gateQueue.js');

/** Free memory now as a phrase. macOS counts the page cache as used, so the figure says little there. */
function freeNow(free) {
  if (free == null) return 'unknown';
  return `${free} %${process.platform === 'darwin' ? ' (macOS counts the page cache as used, so this looks lower than it is)' : ''}`;
}

/** The newest gate row of this kind in the time log that was written after `since`, or null. */
function rowSince(kind, since) {
  let text = '';
  try {
    text = require('./lib/timeLogArchive.js').readText(TIME_LOG, { from: since });
  } catch {
    return null;
  }
  const row = BH.gateRows(text).filter((r) => r.kind === kind).at(-1);
  return row && Date.parse(row.time) >= since - 1000 ? row : null;
}

/** The tracks running now. No queue yet means none. */
function runningTracks() {
  if (!fs.existsSync(FILE)) return [];
  return read().tasks.filter((o) => o.status === 'running').map((o) => o.id);
}

/** The gate commands of one kind in queue.config.json. */
const gatesOf = (kind) => (Array.isArray(CONFIG.gates?.[kind]) ? CONFIG.gates[kind].filter((g) => typeof g === 'string' && g.trim()) : []);

/** Runs `gates.mjs --<kind>` once in the main checkout. Returns the exit code, the free memory before and the gate row. */
function runOnce(kind) {
  const before = LS.measure().freeMemoryPct;
  const since = Date.now();
  const r = spawnSync(process.execPath, [path.join(HERE, 'gates.mjs'), `--${kind}`, '--cwd', MAIN_TREE], { stdio: 'inherit', env: process.env });
  return { status: r.status ?? 1, before, row: rowSince(kind, since) };
}

/** One line per measured run: time, wait, red, and free memory before and at the lowest. */
function report(label, run) {
  const { row, before } = run;
  const min = row.min_free_memory_pct ?? null;
  console.log(`${label}: ${row.duration_s} s${row.wait_sec ? ` (and ${row.wait_sec} s waiting for the gate queue)` : ''}${row.ok ? '' : ', and the check was RED, so the time may not be typical'}`);
  console.log(`  Free memory: ${before ?? 'unknown'} % before, ${min ?? 'not measured'}${min == null ? '' : ' %'} at the lowest`);
}

/** `ravenseat machine --measure`. Exit code: that of the gate runs, so a red check is not reported as a clean run. */
function measureRun(machine, gateQueue) {
  const running = runningTracks();
  if (running.length)
    die(
      `Not measured: ${running.length} track(s) are running (${running.join(', ')}). A busy machine gives a figure that ` +
        'means nothing, and the full check would slow those tracks down. Run this when the queue is idle.',
    );
  const full = gatesOf('full');
  if (!full.length) die(`Not measured: gates.full is empty in queue.config.json, so there is nothing to time.`);
  const quick = gatesOf('quick');
  console.log(
    `Running ${quick.length ? `the quick check (${quick.length} command(s)) and then ` : ''}the full check (${full.length} command(s)) once. ` +
      'Close what you do not need first; this can take a while.',
  );
  let q = null;
  if (quick.length) {
    q = runOnce('quick');
    if (q.status !== 0) {
      console.log('');
      if (q.row) report('Quick check', q);
      console.log('The quick check was RED, so the full check was not run. Fix it, then measure again.');
      process.exit(q.status);
    }
  }
  const f = runOnce('full');
  console.log('');
  if (!f.row) {
    console.log('No gate row was written, so there is nothing to report. The output above says what happened.');
    process.exit(f.status);
  }
  if (q?.row) report('Quick check', q);
  else console.log('No quick check is set (gates.quick), so a track is counted with the general figure.');
  report('Full check', f);
  const advice = M.measuredAdvice({
    ...machine,
    gateQueue,
    freeBeforePct: f.before,
    minFreePct: f.row.min_free_memory_pct ?? null,
    quickBeforePct: q?.before ?? null,
    quickMinFreePct: q?.row?.min_free_memory_pct ?? null,
  });
  if (advice) {
    console.log(`Suggested maxConcurrent for this project on this machine: ${advice.suggested}`);
    console.log(
      `Estimate: ${advice.freeBeforeGb} GB was free, the full check took about ${advice.usedGb} GB and counts once (one heavy check at a time), ` +
        `one track about 0.1 GB for the agent plus ${advice.quickGb == null ? 'about 0.6 GB for a light quick check (not measured)' : `${advice.quickGb} GB for its quick check`}, ` +
        `${advice.trackGb} GB in all, a 3 GB margin and at most one track per ${gateQueue ? 'core' : '1.5 cores (the gate queue is off)'}. ` +
        'One run is one sample: measure again after large changes.',
    );
  } else console.log(`No memory figure from this run, so the general estimate stands: ${M.suggestedTracks({ ...machine, gateQueue })}. ${M.WHY}`);
  console.log(`Nothing was changed. ${CLI} limit maxConcurrent <n> sets it.`);
  process.exit(f.status);
}

/** `ravenseat machine [--measure]` (the usage is at the top of queue.mjs). */
export function cmdMachine() {
  const machine = M.readMachine();
  const gateQueue = GQ.setupFrom(CONFIG).enabled;
  const free = LS.measure().freeMemoryPct;
  console.log(`Cores:       ${machine.cores}`);
  console.log(`Memory:      ${machine.memGb} GB`);
  console.log(`Free memory: ${freeNow(free)}`);
  if (a.includes('--measure')) return measureRun(machine, gateQueue);
  // Free memory counts the system and open apps, but only while no track runs; macOS counts the page cache as used.
  const freeGb = free != null && process.platform !== 'darwin' && !runningTracks().length ? Math.round(machine.memGb * free) / 100 : null;
  const from = freeGb == null ? '' : ` (from the ${Math.round(freeGb * 10) / 10} GB free now)`;
  console.log(`Suggested maxConcurrent: ${M.suggestedTracks({ ...machine, freeGb, gateQueue })}${from}. ${M.WHY}`);
  console.log(`Nothing was changed. ${CLI} limit maxConcurrent <n> sets it; ${CLI} machine --measure times one quick and one full check of this project.`);
}
