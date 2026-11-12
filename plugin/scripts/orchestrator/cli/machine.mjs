// =============================================================
// cli/machine.mjs: `ravenseat machine [--measure]`: what this machine is, and how many parallel tracks probably fit.
//
//   ravenseat machine            cores, memory, free memory now and the suggestion (lib/machineAdvice.js, an estimate).
//   ravenseat machine --measure  runs `gates.mjs --full` once and shows the time, the lowest free memory and a suggestion
//                                for this project. Started by the user only, and refused while a track runs: a machine
//                                that is busy gives a figure that means nothing, and the run would slow the tracks down.
//
// It changes no setting. The measuring run is an ordinary full gate run: it appends a `gate` row to the time log, records
// gate evidence as a full run in the main checkout does, and takes a slot in the gate queue when it is heavy.
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

/** Free memory now as a phrase. macOS counts the page cache as used, so the figure says little there. */
function freeNow() {
  const free = LS.measure().freeMemoryPct;
  if (free == null) return 'unknown';
  return `${free} %${process.platform === 'darwin' ? ' (macOS counts the page cache as used, so this looks lower than it is)' : ''}`;
}

/** The newest `full` gate row in the time log that was written after `since`, or null. */
function fullRowSince(since) {
  let text = '';
  try {
    text = require('./lib/timeLogArchive.js').readText(TIME_LOG, { from: since });
  } catch {
    return null;
  }
  const row = BH.gateRows(text).filter((r) => r.kind === 'full').at(-1);
  return row && Date.parse(row.time) >= since - 1000 ? row : null;
}

/** The tracks running now. No queue yet means none. */
function runningTracks() {
  if (!fs.existsSync(FILE)) return [];
  return read().tasks.filter((o) => o.status === 'running').map((o) => o.id);
}

/** `ravenseat machine --measure`. Exit code: that of the gate run, so a red check is not reported as a clean run. */
function measureRun(machine) {
  const running = runningTracks();
  if (running.length)
    die(
      `Not measured: ${running.length} track(s) are running (${running.join(', ')}). A busy machine gives a figure that ` +
        'means nothing, and the full check would slow those tracks down. Run this when the queue is idle.',
    );
  const gates = Array.isArray(CONFIG.gates?.full) ? CONFIG.gates.full.filter((g) => typeof g === 'string' && g.trim()) : [];
  if (!gates.length) die(`Not measured: gates.full is empty in queue.config.json, so there is nothing to time.`);
  const before = LS.measure().freeMemoryPct;
  console.log(`Running the full check once (${gates.length} command(s)). Close what you do not need first; this can take a while.`);
  const since = Date.now();
  const r = spawnSync(process.execPath, [path.join(HERE, 'gates.mjs'), '--full', '--cwd', MAIN_TREE], { stdio: 'inherit', env: process.env });
  const row = fullRowSince(since);
  console.log('');
  if (!row) {
    console.log('No gate row was written, so there is nothing to report. The output above says what happened.');
    process.exit(r.status ?? 1);
  }
  const min = row.min_free_memory_pct ?? null;
  console.log(`Time: ${row.duration_s} s${row.wait_sec ? ` (and ${row.wait_sec} s waiting for the gate queue)` : ''}${row.ok ? '' : ', and the check was RED, so the time may not be typical'}`);
  console.log(`Free memory: ${before ?? 'unknown'} % before, ${min ?? 'not measured'}${min == null ? '' : ' %'} at the lowest`);
  const advice = M.measuredAdvice({ ...machine, freeBeforePct: before, minFreePct: min });
  if (advice) {
    console.log(`Suggested maxConcurrent for this project on this machine: ${advice.suggested}`);
    console.log(
      `Estimate: ${advice.freeBeforeGb} GB was free, one full check took about ${advice.usedGb} GB, plus a 4 GB margin and about 2.5 GB per track, ` +
        'at most one track per 1.5 cores. One run is one sample: measure again after large changes.',
    );
  } else console.log(`No memory figure from this run, so the general estimate stands: ${M.suggestedTracks(machine)}. ${M.WHY}`);
  console.log(`Nothing was changed. ${CLI} limit maxConcurrent <n> sets it.`);
  process.exit(r.status ?? 1);
}

/** `ravenseat machine [--measure]` (the usage is at the top of queue.mjs). */
export function cmdMachine() {
  const machine = M.readMachine();
  console.log(`Cores:       ${machine.cores}`);
  console.log(`Memory:      ${machine.memGb} GB`);
  console.log(`Free memory: ${freeNow()}`);
  if (a.includes('--measure')) return measureRun(machine);
  console.log(`Suggested maxConcurrent: ${M.suggestedTracks(machine)}. ${M.WHY}`);
  console.log(`Nothing was changed. ${CLI} limit maxConcurrent <n> sets it; ${CLI} machine --measure times one full check of this project.`);
}
