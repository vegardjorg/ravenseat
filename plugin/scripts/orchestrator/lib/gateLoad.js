// =============================================================
// gateLoad.js: the lowest free memory during a gate run, and the line that says a red run was probably load.
//
// Why: a spot check lies. A machine can look fine at every look and still dip to almost nothing free in between. So
// gates.mjs samples during the run and keeps the LOWEST value: the `min_free_memory_pct` field of the
// `gate` row in the time log. A red run or a timeout below the load guard's limit then says it was probably load and
// not the code, so nobody spends a fix round on a machine that was simply full.
//
// The line never changes the result: a red run stays red, with the same exit code.
//
// The same measure as the load guard (lib/loadSlots.js measure(), free memory / total memory) and the same macOS
// exception: macOS counts the page cache as used, so nothing is sampled there unless the limit was set by hand.
//
// Pure, with the timers and the measure passed in. Tested in lib/__tests__/gateLoad.test.ts.
// =============================================================
'use strict';

/** How often the free memory is sampled during a run. */
const SAMPLE_MS = 30_000;

/**
 * Is free memory worth sampling here? Everywhere but macOS; on macOS only with a limit set by hand or a measurement
 * replaced with QUEUE_LOAD.
 */
function samplingOn({ platform = process.platform, limit = null, overridden = false } = {}) {
  return platform !== 'darwin' || limit != null || overridden;
}

/**
 * Samples at once and then every `intervalMs` until stop(). The timer is unref-ed: it never keeps the process alive.
 * It needs a free event loop, so the gate commands must run with an async spawn (a spawnSync blocks every timer).
 * @param {{ measure: () => { freeMemoryPct: number|null }, intervalMs?: number,
 *   setTimer?: (fn: Function, ms: number) => any, clearTimer?: (t: any) => void }} x
 * @returns {{ sample: () => void, first: () => number|null, stop: () => number|null }} stop() takes a last sample and
 *   returns the lowest value; first() is the first sample (the free memory when the run started), or null.
 */
function startSampler({ measure, intervalMs = SAMPLE_MS, setTimer = setInterval, clearTimer = clearInterval }) {
  let lowest = null;
  let firstPct;
  const sample = () => {
    let v = null;
    try {
      v = measure()?.freeMemoryPct;
      if (Number.isFinite(v) && (lowest == null || v < lowest)) lowest = v;
    } catch {
      /* an unknown measurement never limits */
    }
    if (firstPct === undefined) firstPct = Number.isFinite(v) ? v : null;
  };
  sample();
  const timer = setTimer(sample, intervalMs);
  timer?.unref?.();
  return {
    sample,
    // The `start_free_memory_pct` of the gate row, so the gate health view (lib/gateHealth.js) can tell a run on a calm
    // machine from one on a busy machine. Free: the sampler takes this sample anyway.
    first: () => firstPct ?? null,
    stop: () => {
      clearTimer(timer);
      sample();
      return lowest;
    },
  };
}

/**
 * The line for a red run or a timeout whose lowest free memory was below the load guard's limit, else null.
 * The wording avoids "time budget": cli/merge.mjs reads that phrase in the log as a timed-out run.
 * @param {{ red: boolean, minFreePct: number|null, limitPct: number|null }} x
 */
function loadLine({ red, minFreePct, limitPct }) {
  const limit = Number(limitPct);
  if (!red || minFreePct == null || limitPct == null || !(limit > 0) || !(minFreePct < limit)) return null;
  return (
    `LOAD: free memory fell to ${minFreePct} % during this run, below the load guard's limit of ${limit} %. ` +
    'This red is probably load and not the code. It still counts as red: run it again when the machine is calmer.'
  );
}

module.exports = { SAMPLE_MS, samplingOn, startSampler, loadLine };
