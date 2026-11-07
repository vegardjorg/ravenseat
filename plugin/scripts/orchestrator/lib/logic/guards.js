// =============================================================
// logic/guards.js: the guards that decide whether the queue may start more now, and the limits.
//
// spaceUse (the slots in use), budgetGuard, nightGuard (night window), startGuard, loadGuard and loadSlotsFor (the
// load-aware slots from lib/loadSlots.js), windDownGuard, and the limit texts and parsing (limitText, parseLimit).
//
// Part of the queueLogic.js split: lib/queueLogic.js re-exports every name, so callers keep requiring queueLogic.js.
// Used by queueLogic.js (the facade) and by logic/select.js, agents.js.
// Tested in lib/__tests__/queueNight.test.ts, queueLoadLimit.test.ts, queueSaverMode.test.ts and contextGuard.test.ts
// (through queueLogic.js).
// =============================================================

const { cfg, DEFAULT_LIMITS, NIGHT_TZ, ACTIVE, hasMigr, isExternalRow } = require('./base.js');
const { counterAsAgent } = require('./projects.js');
const { orchestratorStatus } = require('./commits.js');
/** Load-aware slots (pure rule + measurement; no dependency back on this file). */
const LS = require('../loadSlots.js');
/** The pause at the subscription's usage limit (the file the StopFailure hook writes). */
const UL = require('../usageLimit.js');
const { dataFolder } = require('../queueConfig.js');

/**
 * The slots in use now, with the same rules as selectNext: agents (running and review without picked_by) toward maxConcurrent and
 * maxDPlus; all that own something (active ones, not records outside the queue) toward maxDb and maxPerDomain.
 * @returns {{ limits: object, agents: number, available: number, dPlus: number, db: number, perDomain: Map<string, number> }}
 */
function spaceUse(queue) {
  const tasks = queue.tasks ?? [];
  const g = { ...DEFAULT_LIMITS, ...(queue.limits ?? {}) };
  // Records outside the queue own files (blockers), but take no slot within the limits.
  const owners = tasks.filter((o) => ACTIVE.has(o.status) && !isExternalRow(o));
  const agents = tasks.filter(counterAsAgent);
  const perDomain = new Map();
  for (const a of owners) perDomain.set(a.domain, (perDomain.get(a.domain) ?? 0) + 1);
  return {
    limits: g,
    agents: agents.length,
    available: g.maxConcurrent - agents.length,
    dPlus: agents.filter((o) => o.class === 'D+').length,
    db: owners.filter(hasMigr).length,
    perDomain,
  };
}

// ---- Budget guard -----------------------------------------------------------------------------------------

/**
 * Is today's usage over the daily budget? `limits.dailyBudget` in the queue file is USD API equivalent per local day; not
 * set, null, 0 or negative = off. The usage is measured by the caller (queue.mjs reads the time log via timeCost.js).
 * The usage of agents that are still running is counted only when they stop (hook-time writes the row then), so the guard
 * kicks in a little after the limit has actually been passed: set the limit with a margin.
 * @param {object} queue the queue
 * @param {number|undefined} dailyUsage USD used today
 * @returns {{ active: boolean, stop: boolean, limit?: number, usage?: number, message?: string }}
 */
function budgetGuard(queue, dailyUsage) {
  const limit = Number(queue?.limits?.dailyBudget);
  if (queue?.limits?.dailyBudget == null || !Number.isFinite(limit) || limit <= 0) {
    return { active: false, stop: false };
  }
  const usage = Math.round(Number(dailyUsage ?? 0) * 100) / 100;
  const stop = usage >= limit;
  const counts = `${usage.toFixed(2)} of ${limit.toFixed(2)} USD (API equivalent, local day)`;
  return {
    active: true,
    stop,
    limit,
    usage,
    message: stop
      ? `DAILY BUDGET USED UP: ${counts}. No new tasks are started today. Running tasks finish ` +
        'as usual. The owner can raise the limit (ravenseat limit dailyBudget <usd>) or start one task with start <id> --force.'
      : `Daily budget: ${counts} used.`,
  };
}

// ---- Night guard ---------------------------------------------------------------------------------------

/** "23-06" → { from: 23, to: 6 }. Two digits on each side (00–23), and from and to cannot be equal. Otherwise null. */
function parseNightWindow(s) {
  const m = /^([01]\d|2[0-3])-([01]\d|2[0-3])$/.exec(String(s ?? '').trim());
  if (!m || m[1] === m[2]) return null;
  return { from: Number(m[1]), to: Number(m[2]) };
}

/** The hour (0–23) a point in time has in the time zone `tz` (local time by default, daylight saving time accounted for). */
function hourIn(now, tz = NIGHT_TZ) {
  const t = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' })
    .format(new Date(now))
    .replace(/\D/g, '');
  return Number(t) % 24;
}

/** Is the point in time inside the night window? A window across midnight ("23-06") applies from 23:00 to 06:00. */
function inNightWindow(window, now = Date.now(), tz = NIGHT_TZ) {
  if (!window) return false;
  const t = hourIn(now, tz);
  return window.from < window.to ? t >= window.from && t < window.to : t >= window.from || t < window.to;
}

const clockTime = (t) => `${String(t).padStart(2, '0')}:00`;

/**
 * Night pause: with `limits.nightRun` = false no new tasks are started inside the night window (local time). Running
 * tasks finish, and delivered tracks are received and merged as usual; only new starts stop. The default (on) gives
 * unchanged behavior. `queue.mjs next` then gives exit 5 and `start` refuses without --force (startGuard).
 * @returns {{ active: boolean, stop: boolean, to?: string, summary?: string, message?: string }}
 */
function nightGuard(queue, now = Date.now(), tz = NIGHT_TZ) {
  const g = { ...DEFAULT_LIMITS, ...(queue?.limits ?? {}) };
  if (g.nightRun !== false) return { active: false, stop: false };
  const v = parseNightWindow(g.nightWindow) ?? parseNightWindow(DEFAULT_LIMITS.nightWindow);
  const stop = inNightWindow(v, now, tz);
  const from = clockTime(v.from);
  const to = clockTime(v.to);
  const summary = `nightPause until ${to}`;
  return {
    active: true,
    stop,
    to,
    summary,
    message: stop
      ? `Night pause until ${to}: nightRun is off, so no new tasks are started between ${from} and ${to} (local time). ` +
        'Running tasks finish, and delivered tracks are received and merged as usual. The owner can turn nightRun on ' +
        '(ravenseat limit nightRun on) or start one task with start <id> --force.'
      : `Night run is off: no new tasks are started between ${from} and ${to} (local time).`,
  };
}

/**
 * Does a guard stop new starts now? The usage limit first (exit 12; `usageLimit` is the record, read from the data
 * folder when not given), then the budget (exit 4), the night (exit 5), the wind-down (exit 6; requires `cursor`, the
 * orchestrator cursor) and the load (exit 7; requires `load`, the measurement). `force` (owner's word, `start --force`)
 * overrides all of them. Used by `next`, `start`, `fill`, `show` and `state`.
 * @returns {{ code: 4|5|6|7|12, stop: 'usageLimit'|'dailyBudget'|'nightPause'|'windDown'|'load', summary?: string, message: string } | null}
 */
function startGuard(
  queue,
  dailyUsage,
  { now = Date.now(), force = false, cursor = null, load = null, usageLimit } = {},
) {
  if (force) return null;
  const ul = usageLimitGuard(now, usageLimit);
  if (ul) return ul;
  const b = budgetGuard(queue, dailyUsage);
  if (b.stop) return { code: 4, stop: 'dailyBudget', message: b.message };
  const n = nightGuard(queue, now);
  if (n.stop) return { code: 5, stop: 'nightPause', summary: n.summary, message: n.message };
  const by = windDownGuard(cursor, now);
  if (by.stop) return { code: 6, stop: 'windDown', summary: by.summary, message: by.message };
  // The machine is full (exit 7). Only with a measurement (`load`); without it the guard is off.
  const lg = loadGuard(queue, load);
  if (lg.stop) return { code: 7, stop: 'load', summary: lg.summary, message: lg.message };
  return null;
}

/**
 * The stop while the usage limit pause is on (lib/usageLimit.js), or null. Without a project config, or with
 * usageLimit.pause false in it, it is off.
 * @param {number} [now]
 * @param {object|null} [given] the record; read from the data folder when left out
 */
function usageLimitGuard(now = Date.now(), given) {
  if (given !== undefined) return UL.guard(given, now);
  try {
    if (cfg().usageLimit?.pause === false) return null;
    return UL.guard(UL.read(dataFolder()), now);
  } catch {
    return null; // no config: off
  }
}

// ---- Load guard ---------------------------------------------------------------------------------------------------

/**
 * The load limit in effect: `limits.minFreeMemoryPct` in the queue file when it is set there (also "off", which is
 * stored as null), otherwise `loadGuard.minFreeMemoryPct` in queue.config.json. null or 0 = off (default).
 */
function minFreeMemoryFor(queue) {
  if (queue?.limits && Object.hasOwn(queue.limits, 'minFreeMemoryPct'))
    return queue.limits.minFreeMemoryPct;
  try {
    return cfg().loadGuard?.minFreeMemoryPct ?? null;
  } catch {
    return null; // no config: off
  }
}

/**
 * Is the machine too full to start another track? When many tracks run at once, gates can go red from timeouts and
 * lack of memory, not from code errors. With a limit set (minFreeMemoryFor: percent free memory, os.freemem /
 * os.totalmem), no new start happens while free memory is below the limit. A measurement that is null (unknown)
 * never stops. Running tracks finish; only new starts wait. `start --force` and `fill --over-load` override.
 * @param {object} queue the queue
 * @param {{ freeMemoryPct: number|null } | null} load the measurement (queue.mjs measureLoad)
 * @returns {{ active: boolean, stop: boolean, reasons?: string[], summary?: string, message?: string }}
 */
function loadGuard(queue, load) {
  const raw = minFreeMemoryFor(queue);
  const min = Number(raw);
  const on = raw != null && Number.isFinite(min) && min > 0;
  if (!load || !on) return { active: on, stop: false };
  const free = load.freeMemoryPct == null ? NaN : Number(load.freeMemoryPct);
  if (!(Number.isFinite(free) && free < min)) return { active: true, stop: false };
  const reasons = [`free memory ${Math.round(free * 10) / 10} % (below ${min} %)`];
  return {
    active: true,
    stop: true,
    reasons,
    summary: `the machine is full: ${reasons.join(', ')}`,
    message:
      `THE MACHINE IS FULL: ${reasons.join(' and ')}. No new tracks are started until the load goes down; running ` +
      'tracks finish, and delivered tracks are received and merged as usual. The owner can change the limit ' +
      '(ravenseat limit minFreeMemoryPct <number|off>) or start one task with start <id> --force.',
  };
}

/**
 * The load-aware slot count for the queue (lib/loadSlots.js): maxConcurrent from the queue's limits, the agents that
 * already hold a slot, the hard limit (minFreeMemoryFor) as the bottom of the memory ramp, and the settings from
 * queue.config.json (loadGuard) and QUEUE_LOAD_ADAPTIVE.
 * @param {object} queue
 * @param {{ freeMemoryPct?: number|null, cpuPct?: number|null } | null} load
 */
function loadSlotsFor(queue, load) {
  const use = spaceUse(queue);
  let lg = {};
  try {
    lg = cfg().loadGuard ?? {};
  } catch {
    lg = {}; // no config: the defaults
  }
  return LS.loadSlots({
    maxSlots: use.limits.maxConcurrent,
    running: use.agents,
    load,
    hardMinFreeMemoryPct: minFreeMemoryFor(queue),
    settings: LS.settingsFrom(lg),
  });
}

/** Interprets the load limit: integer 1-100 (percent free memory), "off"/0 = null. */
function parseLoadLimit(name, s) {
  if (['off', 'no', 'null', 'none', '0'].includes(s.toLowerCase())) return { val: null };
  if (!/^\d+$/.test(s)) return { error: `${name} must be an integer or "off"` };
  const v = Number(s);
  if (v > 100) return { error: `${name} must be between 1 and 100 (percent) or "off"` };
  return { val: v };
}

// ---- Wind-down guard -----------------------------------------------------------------------------

/** The running handover note in the data folder (same path as contextGuard.HANDOVER_NOTE). */
function handoverNote() {
  let folder = 'scripts/.queue';
  try {
    folder = String(cfg().dataFolder || folder);
  } catch {
    // no config: the default folder
  }
  return `${folder.replace(/\\/g, '/').replace(/\/+$/, '')}/handover-ongoing.md`;
}

/**
 * Is the orchestrator in wind-down? hook-context.mjs sets `windDown` in the orchestrator cursor when the active
 * orchestrator session passes approx. 350k context (contextGuard.js). Then no new tasks are started
 * (`next`, `start` and `fill` give exit 6), while receiving, review, fix rounds, merge and `set` go on as before.
 * Applies only as long as the cursor is active (not expired). The normal way out is compaction:
 * hook-after-compact.mjs lifts the wind-down. Also reset when a new session takes the cursor (emergency rotation:
 * `orchestrator pulse --session "<new name>"`, or the hook binds the cursor to another session) and with `orchestrator stop`.
 * @returns {{ active: boolean, stop: boolean, summary?: string, message?: string }}
 */
function windDownGuard(cursor, now = Date.now()) {
  if (!cursor?.windDown || !orchestratorStatus(cursor, now).active)
    return { active: false, stop: false };
  const from = cursor.windDown.from ?? '?';
  const context = cursor.windDown.context
    ? ` at approx. ${Math.round(cursor.windDown.context / 1000)}k tokens`
    : '';
  return {
    active: true,
    stop: true,
    summary: 'windDown (compact the session)',
    message:
      `WIND_DOWN: the orchestrator session "${cursor.session ?? '?'}" went into wind-down ${from}${context}. No new tasks ` +
      'are started from this session. Finish receiving, review, fix rounds and merge of started tasks, update ' +
      `the handover note (${handoverNote()}) and ask the owner to compact now (the hook message has ` +
      'a ready /compact line); the wind-down is lifted by itself after the compaction. A new session only as ' +
      'a last resort (the session has hung): `ravenseat orchestrator pulse --session "<new name>"` resets the wind-down. ' +
      "Owner's word: start <id> --force.",
  };
}

/** The limits that can be set with `queue.mjs limit <name> <val>`. */
const LIMIT_NAME = [
  'maxConcurrent',
  'maxDPlus',
  'maxPerDomain',
  'maxDb',
  'dailyBudget',
  'nightRun',
  'nightWindow',
  'autocompact',
];

/**
 * Limits that `queue.mjs limit` also sets, but that are not slot limits (not in LIMIT_NAME, so
 * the settings panel on the board, queueBoard.SETTINGS, is unchanged). parallelThreshold: the share of maxConcurrent below
 * which fill, receive and pulse write a quick queue diagnosis (queueDiagnose.js); default 0.7, 0 = off. silentMin: the
 * minutes without a sign of life before a running track is SILENT (silentTracks); default 20, 0 = off.
 */
const LIMIT_EXTRA = ['parallelThreshold', 'minFreeMemoryPct', 'silentMin'];

/** A limit value as text: null = "off", true/false = "on"/"off". */
function limitText(name, v) {
  if (v == null) return 'off';
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  return String(v);
}

/**
 * Interprets a new limit value. max*: integer ≥ 0 (maxConcurrent 0 stops the queue). dailyBudget: number > 0 (USD), or
 * "off" for no limit. nightRun: "on" or "off". nightWindow: "HH-HH" in local time, e.g. 23-06. autocompact:
 * "on"/"auto" or "off"/"manual".
 * With `current` (the limits as they are now) maxDPlus cannot become larger than maxConcurrent. maxDb can:
 * picked tasks count in maxDb, but not in maxConcurrent, so 6 tracks with migrations and 5 agents makes sense.
 * @returns {{ val: number|boolean|string|null } | { error: string }}
 */
function parseLimit(name, raw, current) {
  if (!LIMIT_NAME.includes(name) && !LIMIT_EXTRA.includes(name))
    return { error: `unknown limit ${name} (${[...LIMIT_NAME, ...LIMIT_EXTRA].join(', ')})` };
  // Interpreted in queueDiagnose (loaded here, not at the top, because queueDiagnose itself uses this file).
  if (name === 'parallelThreshold') return require('../queueDiagnose.js').parseThreshold(raw);
  const s = String(raw ?? '').trim();
  if (name === 'minFreeMemoryPct') return parseLoadLimit(name, s);
  if (name === 'dailyBudget') {
    if (['off', 'none', 'null'].includes(s.toLowerCase())) return { val: null };
    const v = Number(s.replace(',', '.'));
    if (!s || !Number.isFinite(v) || v <= 0)
      return { error: 'dailyBudget must be a number > 0 (USD) or "off"' };
    return { val: Math.round(v * 100) / 100 };
  }
  if (name === 'nightRun') {
    const x = s.toLowerCase();
    if (['on', 'yes'].includes(x)) return { val: true };
    if (['off', 'no'].includes(x)) return { val: false };
    return { error: 'nightRun must be "on" or "off"' };
  }
  if (name === 'autocompact') {
    const x = s.toLowerCase();
    if (['on', 'yes', 'auto'].includes(x)) return { val: true };
    if (['off', 'no', 'manual'].includes(x)) return { val: false };
    return { error: 'autocompact must be "on" (auto) or "off" (manual)' };
  }
  if (name === 'nightWindow') {
    const v = parseNightWindow(s);
    if (!v)
      return {
        error: 'nightWindow must have the form HH-HH in local time (two digits, 00–23), e.g. 23-06, and from and to cannot be equal',
      };
    return { val: `${String(v.from).padStart(2, '0')}-${String(v.to).padStart(2, '0')}` };
  }
  if (!/^\d+$/.test(s)) return { error: `${name} must be an integer ≥ 0` };
  const v = Number(s);
  if (name === 'maxDPlus' && current) {
    const max = Number(current.maxConcurrent);
    if (Number.isFinite(max) && v > max)
      return { error: `${name} cannot be larger than maxConcurrent (${max})` };
  }
  return { val: v };
}

module.exports = {
  spaceUse,
  budgetGuard,
  parseNightWindow,
  inNightWindow,
  nightGuard,
  startGuard,
  minFreeMemoryFor,
  loadGuard,
  loadSlotsFor,
  windDownGuard,
  usageLimitGuard,
  LIMIT_NAME,
  LIMIT_EXTRA,
  limitText,
  parseLimit,
};
