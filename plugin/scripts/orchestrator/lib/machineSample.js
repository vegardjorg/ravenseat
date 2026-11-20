// =============================================================
// machineSample.js: the periodic machine sample (S9) the board server writes to the time log while it runs.
//
// Why: the load rows at `ravenseat fill` and `start` and the gate rows' memory readings show the machine only at those
// moments. With `metrics.machineSampleMin` above 0, the board writes one `load` row with command "sample" (free
// memory, CPU busy, running tracks) every that many minutes, for the Machine section of Statistics.
//
// Off by default (0): the fill/start rows already answer how many tracks and gate slots fit, the sample exists only
// while the board runs (so the data has gaps that can mislead), and it costs a CPU reading and about 150 bytes per row.
// A measurement only: it never limits or stops work, and every error is swallowed.
//
// The interval is read on every tick (once a minute), so a change in the gear takes effect without a restart. The CPU
// reading is os.cpus() twice with a timer in between (lib/loadSlots.js measure blocks the thread for that time, which
// a server must not do). QUEUE_LOAD replaces the measurement as everywhere else.
// Tested in lib/__tests__/machineSample.test.ts.
// =============================================================
'use strict';

const os = require('node:os');
const ER = require('./eventRows.js');
const LS = require('./loadSlots.js');

/** How often the sampler looks at the setting (ms). */
const TICK_MS = 60_000;
/** The longest interval taken (a day); a larger number is capped. */
const MAX_MIN = 1440;

const round1 = (x) => Math.round(x * 10) / 10;

/** The interval in minutes from a config (metrics.machineSampleMin); 0 = off, also for a missing or broken value. */
function minutesFrom(config) {
  const v = Number(config?.metrics?.machineSampleMin);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return Math.min(MAX_MIN, Math.max(1, Math.round(v)));
}

/** The sample as a time log row: a load row with command "sample" (no slots, never a stop). */
function sampleRow({ time, load, running = null }) {
  return ER.loadRow({ time, command: 'sample', load, slots: null, guard: null, running });
}

/** Free memory and CPU busy in percent, without blocking the thread. Null for a part that could not be read. */
async function measureLoad({ sampleMs = 200, env = process.env.QUEUE_LOAD } = {}) {
  const override = LS.parseOverride(env);
  if (override) return override;
  let freeMemoryPct = null;
  let cpuPct = null;
  try {
    const total = os.totalmem();
    freeMemoryPct = total > 0 ? round1((os.freemem() / total) * 100) : null;
  } catch {
    freeMemoryPct = null; // error-ignored: a part that cannot be read is null, as in loadSlots.measure
  }
  try {
    const a = LS.cpuTimes();
    await new Promise((r) => setTimeout(r, sampleMs));
    const b = LS.cpuTimes();
    const dt = b.total - a.total;
    cpuPct = dt > 0 ? round1((1 - (b.idle - a.idle) / dt) * 100) : null;
  } catch {
    cpuPct = null; // error-ignored: as above
  }
  return { freeMemoryPct, cpuPct };
}

/**
 * Starts the sampler. Every TICK_MS it reads `minutes()`; when that is above 0 and the last sample is at least that
 * old (or there is none), it measures and appends one row. `tick()` is exposed for the tests and returns whether a
 * row was written. Never throws.
 * @param {{ minutes: () => number, append: (row: object) => unknown, measure?: () => Promise<object>,
 *   running?: () => number|null, now?: () => number, schedule?: (fn: () => void, ms: number) => { unref?: () => void } }} o
 */
function startMachineSample({ minutes, append, measure = measureLoad, running = () => null, now = Date.now, schedule = setTimeout }) {
  let last = null;
  let timer = null;
  let stopped = false;
  async function tick() {
    try {
      const m = minutes();
      if (!(m > 0)) {
        last = null; // turned off: the next time it is turned on samples at once
        return false;
      }
      const t = now();
      if (last !== null && t - last < m * 60_000) return false;
      last = t;
      const load = await measure();
      let r = null;
      try {
        r = running();
      } catch {
        r = null; // error-ignored: the running count is a detail of the row
      }
      append(sampleRow({ time: new Date(t).toISOString(), load, running: Number.isInteger(r) ? r : null }));
      return true;
    } catch {
      return false; // error-ignored: measurement only
    }
  }
  function next() {
    if (stopped) return;
    timer = schedule(() => {
      tick().finally(next);
    }, TICK_MS);
    timer?.unref?.();
  }
  next();
  return {
    tick,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

module.exports = { TICK_MS, MAX_MIN, minutesFrom, sampleRow, measureLoad, startMachineSample };
