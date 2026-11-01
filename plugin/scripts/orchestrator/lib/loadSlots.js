// =============================================================
// loadSlots.js: how many parallel track slots the machine can take right now (load-aware parallelism).
//
// Why: with many parallel tracks the machine, not the token quota, becomes the limit. Gates slow down and go red from
// timeouts and lack of memory, and the reruns cost more than the extra tracks gain. A heavy user's data showed the
// median gate time more than tripling from 1-2 running tracks to 3-4, and most gate runs at high parallelism being
// reruns. So instead of a fixed `maxConcurrent`, `fill`, `next`, `start` and `state` use an effective slot count that
// follows the load.
//
// The rule (simple on purpose, so it can be explained in one line):
//   - Memory: at or above `allSlotsFreeMemoryPct` free memory, all `maxConcurrent` slots are open. At or below the
//     hard limit (`minFreeMemoryPct`, the load guard), only `minSlots` (default 1). In between, linear, rounded down.
//   - CPU (optional, off by default): at or below `allSlotsCpuPct` busy, all slots; at or above `minSlotsCpuPct`,
//     only `minSlots`; linear in between.
//   - The effective count is the lower of the two, never below `minSlots` and never above `maxConcurrent`.
//   - A measurement that is unknown (null) never limits.
// New starts = effective slots minus the agents already running (they are part of the load that was measured).
//
// The floor (`minSlots` >= 1) means this rule alone never stops the queue while nothing runs. The hard load guard
// (queueLogic.loadGuard, exit 7, "THE MACHINE IS FULL") stays as the last line below `minFreeMemoryPct`: it is a
// separate, documented stop with its own exit code that loops depend on, so it is kept apart from this soft cap.
//
// Settings: `loadGuard` in queue.config.json (adaptive, minSlots, allSlotsFreeMemoryPct, allSlotsCpuPct,
// minSlotsCpuPct). QUEUE_LOAD_ADAPTIVE=off|on overrides `adaptive`. `fill --over-load` and `start --force` skip it.
// QUEUE_LOAD="free=<pct>,cpu=<pct>" replaces the measurement (tests; vitest.config.mjs sets free=100).
//
// loadSlots() is pure. measure() is the only I/O (os.freemem/os.totalmem, and os.cpus() twice for CPU).
// Tested in lib/__tests__/loadSlots.test.ts.
// =============================================================
'use strict';

const os = require('node:os');

/** Default settings (queueConfig STANDARD.loadGuard holds the same values; these are the fallback). */
const DEFAULTS = Object.freeze({
  adaptive: true,
  minSlots: 1,
  allSlotsFreeMemoryPct: 40,
  allSlotsCpuPct: null,
  minSlotsCpuPct: null,
});

/** A finite number, or null. */
const num = (x) => (x == null || x === '' || !Number.isFinite(Number(x)) ? null : Number(x));
const round1 = (x) => Math.round(x * 10) / 10;

/** Interprets on/off words (QUEUE_LOAD_ADAPTIVE). undefined when the word is not one of them. */
function onOff(s) {
  const v = String(s ?? '').trim().toLowerCase();
  if (['1', 'on', 'true', 'yes'].includes(v)) return true;
  if (['0', 'off', 'false', 'no'].includes(v)) return false;
  return undefined;
}

/**
 * The settings in effect, from `loadGuard` in the config (missing or invalid values give the defaults) and the
 * environment (QUEUE_LOAD_ADAPTIVE=off|on wins over `adaptive`).
 * @param {object} [lg] config().loadGuard
 * @param {object} [env] process.env
 */
function settingsFrom(lg = {}, env = process.env) {
  const g = lg ?? {};
  const envAdaptive = onOff(env?.QUEUE_LOAD_ADAPTIVE);
  const adaptive = envAdaptive ?? (g.adaptive === undefined ? DEFAULTS.adaptive : g.adaptive !== false);
  const min = num(g.minSlots);
  const pick = (k) => (Object.hasOwn(g, k) ? num(g[k]) : DEFAULTS[k]);
  return {
    adaptive,
    minSlots: min != null && min >= 1 ? Math.floor(min) : DEFAULTS.minSlots,
    allSlotsFreeMemoryPct: pick('allSlotsFreeMemoryPct'),
    allSlotsCpuPct: pick('allSlotsCpuPct'),
    minSlotsCpuPct: pick('minSlotsCpuPct'),
  };
}

/** Does the CPU part apply (both thresholds set, low below high)? Then measure() must sample the CPU. */
const cpuOn = (s) =>
  s.allSlotsCpuPct != null && s.minSlotsCpuPct != null && s.allSlotsCpuPct < s.minSlotsCpuPct;

/**
 * Linear ramp from `floor` slots at `bad` to `max` slots at `good`, rounded down (conservative). Works both ways:
 * memory (higher is better, bad < good) and CPU (lower is better, bad > good).
 */
function ramp(value, bad, good, floor, max) {
  const share = (value - bad) / (good - bad);
  if (share >= 1) return max;
  if (share <= 0) return floor;
  return Math.max(floor, Math.min(max, floor + Math.floor((max - floor) * share)));
}

/**
 * The effective slot count now. Pure.
 * @param {{ maxSlots: number, running?: number, load?: { freeMemoryPct?: number|null, cpuPct?: number|null } | null,
 *   hardMinFreeMemoryPct?: number|null, settings?: object }} input
 *   maxSlots: maxConcurrent. running: agents that already hold a slot. hardMinFreeMemoryPct: the load guard's limit
 *   (null = off; then the memory ramp starts at 0 %). settings: settingsFrom().
 * @returns {{ active: boolean, slots: number, max: number, newSlots: number, limited: boolean,
 *   by: 'memory'|'cpu'|null, reason: string|null, text: string }}
 *   active: the adaptive rule applies (on, and a measurement given). limited: fewer than max. reason: why (only when
 *   limited), e.g. "2 of 5 slots: free memory 18 % (all slots from 40 %)". text: always a short line.
 */
function loadSlots({ maxSlots, running = 0, load = null, hardMinFreeMemoryPct = null, settings } = {}) {
  const s = settings ?? settingsFrom({}, {});
  const max = Math.max(0, Math.floor(num(maxSlots) ?? 0));
  const run = Math.max(0, Math.floor(num(running) ?? 0));
  const all = (active) => ({
    active,
    slots: max,
    max,
    newSlots: Math.max(0, max - run),
    limited: false,
    by: null,
    reason: null,
    text: `${max} of ${max} slots`,
  });
  if (!s.adaptive || !load || max === 0) return all(false);
  // The floor: at least 1 (so this rule alone never stops the queue), never above max.
  const floor = Math.min(max, Math.max(1, Math.floor(num(s.minSlots) ?? DEFAULTS.minSlots)));

  // Memory: from the hard limit (or 0) up to allSlotsFreeMemoryPct.
  let mem = max;
  const free = num(load.freeMemoryPct);
  const hard = num(hardMinFreeMemoryPct);
  const bad = hard != null && hard > 0 ? hard : 0;
  const good = s.allSlotsFreeMemoryPct;
  if (free != null && good != null && good > bad) mem = ramp(free, bad, good, floor, max);

  // CPU (optional): from allSlotsCpuPct (all slots) up to minSlotsCpuPct (floor).
  let cpu = max;
  const busy = num(load.cpuPct);
  if (busy != null && cpuOn(s)) cpu = ramp(busy, s.minSlotsCpuPct, s.allSlotsCpuPct, floor, max);

  const slots = Math.min(mem, cpu);
  if (slots >= max) return all(true);
  const by = mem <= cpu ? 'memory' : 'cpu';
  const why =
    by === 'memory'
      ? `free memory ${round1(free)} % (all slots from ${good} %)`
      : `CPU ${round1(busy)} % busy (all slots at or below ${s.allSlotsCpuPct} %)`;
  const reason = `${slots} of ${max} slots: ${why}`;
  return {
    active: true,
    slots,
    max,
    newSlots: Math.max(0, slots - run),
    limited: true,
    by,
    reason,
    text: reason,
  };
}

/** Sum of the CPU times over all cores: { idle, total } (ms). Same method as bench/lib/loadSampler.js. */
function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/** Blocks the thread for `ms` without a busy loop (Atomics.wait works on the Node main thread). */
function pause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Parses QUEUE_LOAD ("free=<pct>,cpu=<pct>") into a measurement, or null when it is not set. Unknown keys are ignored.
 */
function parseOverride(env) {
  if (!env) return null;
  const out = { freeMemoryPct: null, cpuPct: null };
  for (const part of String(env).split(',')) {
    const [k, v] = part.split('=').map((x) => x.trim());
    if (v === '' || !Number.isFinite(Number(v))) continue;
    if (k === 'free') out.freeMemoryPct = Number(v);
    if (k === 'cpu') out.cpuPct = Number(v);
  }
  return out;
}

/**
 * The load now: free memory in percent and, when `cpu` is true, CPU busy in percent over a short sample (os.cpus()
 * twice, `sampleMs` apart; os.loadavg() is always 0 on Windows, so the delta is the method that works everywhere).
 * An error gives null for that part, and null never limits or stops. QUEUE_LOAD replaces the measurement.
 * @param {{ cpu?: boolean, sampleMs?: number, env?: string }} [opt]
 * @returns {{ freeMemoryPct: number|null, cpuPct: number|null }}
 */
function measure({ cpu = false, sampleMs = 200, env = process.env.QUEUE_LOAD } = {}) {
  const override = parseOverride(env);
  if (override) return override;
  let freeMemoryPct = null;
  let cpuPct = null;
  try {
    const total = os.totalmem();
    freeMemoryPct = total > 0 ? round1((os.freemem() / total) * 100) : null;
  } catch {
    freeMemoryPct = null;
  }
  if (cpu) {
    try {
      const a = cpuTimes();
      pause(sampleMs);
      const b = cpuTimes();
      const dt = b.total - a.total;
      cpuPct = dt > 0 ? round1((1 - (b.idle - a.idle) / dt) * 100) : null;
    } catch {
      cpuPct = null;
    }
  }
  return { freeMemoryPct, cpuPct };
}

module.exports = { DEFAULTS, settingsFrom, cpuOn, ramp, loadSlots, parseOverride, measure, cpuTimes };
