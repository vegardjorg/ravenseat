// =============================================================
// gateQueue.js: one shared queue for the heavy gate runs on this machine, across worktrees and projects.
//
// Why: the limit on tracks only counts tracks when they start. It does not stop several full test runs from landing at the
// same moment, and a second project on the machine is not counted at all. Those runs go red from timeouts and lack of
// memory, not from the code. So a heavy `gates.mjs --quick` or `--full` waits for a free slot.
//
// The rules (simple on purpose):
//   - A run is heavy when the LAST known duration of the same kind (quick or full) in the project's time log was at least
//     heavyAfterSec (default 120). No history counts as light, so a small project never notices the queue.
//   - One slot is one folder, <root>/slot-<n>. `mkdir` is atomic: only one process can create it. holder.json inside says
//     who holds it (pid, start time, project, kind, track).
//   - A slot is stale when its process is gone or it is older than 3 hours. A stale slot is renamed away (only one process
//     can rename the same folder), the renamed holder is compared with what was judged stale, and only then removed.
//   - A waiter polls every 3 seconds and prints one line saying who it waits for.
//   - The root is under os.tmpdir(), with one name per OS user, so every project of that user shares it. A process
//     started with another TEMP or TMPDIR gets another queue; that fails towards no waiting, never towards a stuck run.
//   - Fail open: a queue that cannot be used (no write access, a full disk) runs the gate without it. This is load
//     shaping, not a safety check, so it must never be what stops a gate.
//
// The settings: `gateQueue` in queue.config.json. QUEUE_GATE_QUEUE=off|on overrides `enabled`, QUEUE_GATE_QUEUE_DIR the
// root. gates.mjs sets QUEUE_GATE_QUEUE=off for its gate commands: a gate command that runs gates.mjs again must not wait
// for the slot its own parent holds (that would be a deadlock). vitest.config.mjs sets it too, for the same reason as
// QUEUE_LOAD there: the test files must not queue behind each other or behind the machine's real runs.
//
// No lock is taken while another one is awaited here, and a slot holder never asks for the merge lock or the queue
// lock, so no wait cycle can form. The whole argument is in plugin/docs/queue.md, "The queue for heavy gates".
//
// Pure except readSlot, takeOver, tryAcquire, release and acquireWait, which do the small file I/O.
// Used by gates.mjs. Tested in lib/__tests__/gateQueue.test.ts and __tests__/gateQueueFlow.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pidAlive } = require('./mergeLock.js');

/** The defaults for config().gateQueue (queueConfig STANDARD holds the same values; these are the fallback). */
const DEFAULTS = Object.freeze({ enabled: true, slots: 1, heavyAfterSec: 120 });
/** How often a waiter looks for a free slot. */
const POLL_MS = 3000;
/** A slot older than this is stale even when its pid runs (a pid can be reused). */
const MAX_AGE_MS = 3 * 60 * 60 * 1000;
/** A slot without a readable holder file is being created, unless it is older than this. */
const CREATING_MS = 60_000;
/** A waiter gives up on the queue (fail open) after this many rounds in a row where only file errors came back. */
const MAX_FAILED_ROUNDS = 3;
const HOLDER_FILE = 'holder.json';

/** Interprets on/off words (QUEUE_GATE_QUEUE). undefined when the word is not one of them. */
function onOff(s) {
  const v = String(s ?? '').trim().toLowerCase();
  if (['1', 'on', 'true', 'yes'].includes(v)) return true;
  if (['0', 'off', 'false', 'no'].includes(v)) return false;
  return undefined;
}

/** The OS user as a safe folder name part, so two users on one machine do not fight over one folder's rights. */
function userPart() {
  try {
    return os.userInfo().username.replace(/[^A-Za-z0-9._-]/g, '_') || 'user';
  } catch {
    return 'user';
  }
}

/** The folder that holds the slots: QUEUE_GATE_QUEUE_DIR, or a fixed name under the system's temp folder. */
function defaultRoot(env = process.env) {
  return env?.QUEUE_GATE_QUEUE_DIR || path.join(os.tmpdir(), `ravenseat-gate-queue-${userPart()}`);
}

/**
 * The settings in effect. Missing or invalid values give the defaults.
 * @param {object} [cfg] config()
 * @param {object} [env] process.env
 * @returns {{ enabled: boolean, slots: number, heavyAfterSec: number, root: string }}
 */
function setupFrom(cfg = {}, env = process.env) {
  const own = cfg?.gateQueue ?? {};
  const slots = Number.isInteger(own.slots) && own.slots >= 1 ? own.slots : DEFAULTS.slots;
  const heavy = Number(own.heavyAfterSec);
  return {
    enabled: onOff(env?.QUEUE_GATE_QUEUE) ?? own.enabled !== false,
    slots,
    heavyAfterSec: own.heavyAfterSec != null && Number.isFinite(heavy) && heavy >= 0 ? heavy : DEFAULTS.heavyAfterSec,
    root: defaultRoot(env),
  };
}

/**
 * The duration of the newest gate row of this kind in the time log's text, or null when there is none.
 * The row is measurement only (any agent can append to the file): at worst a forged row makes a run wait or not wait.
 */
function lastDurationSec(text, kind) {
  const lines = String(text ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    // Cheap filter first: the time log is mostly agent rows.
    if (!lines[i].includes('"gate"')) continue;
    let row;
    try {
      row = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (row?.event === 'gate' && row.kind === kind && Number.isFinite(row.duration_s)) return row.duration_s;
  }
  return null;
}

/** Does this run need a slot? On, a queued kind, and known to be heavy. No history counts as light. */
function needsSlot({ setup, kind, lastSec }) {
  if (!setup?.enabled || (kind !== 'quick' && kind !== 'full')) return false;
  return lastSec != null && lastSec >= setup.heavyAfterSec;
}

/**
 * When the time budget of a run ends, counted from when the gate commands start (after any wait), or null without one.
 * @param {number} startMs the time the first command starts
 * @param {number} budgetSec --timeout-sec (0, NaN or negative: no budget)
 */
function budgetDeadline(startMs, budgetSec) {
  return budgetSec > 0 ? startMs + budgetSec * 1000 : null;
}

/** Why a slot is stale, or null when it is held. A slot without a holder is one being created, for a minute. */
function staleReason(holder, { now = Date.now(), alive = pidAlive, maxAgeMs = MAX_AGE_MS, mtimeMs = now } = {}) {
  if (!holder || typeof holder !== 'object') return now - mtimeMs > CREATING_MS ? 'it has no readable holder' : null;
  if (!alive(holder.pid)) return `the process ${holder.pid} is gone`;
  const started = Date.parse(holder.started ?? '');
  if (!Number.isFinite(started) || now - started > maxAgeMs) return `it is older than ${Math.round(maxAgeMs / 3_600_000)} hours`;
  return null;
}

/** What a slot folder holds: { missing: true }, or { text, holder, mtimeMs } (holder null when it cannot be read). */
function readSlot(dir) {
  try {
    const file = path.join(dir, HOLDER_FILE);
    const text = fs.readFileSync(file, 'utf8');
    const mtimeMs = fs.statSync(file).mtimeMs;
    try {
      return { text, holder: JSON.parse(text), mtimeMs };
    } catch {
      return { text, holder: null, mtimeMs };
    }
  } catch {
    try {
      return { text: null, holder: null, mtimeMs: fs.statSync(dir).mtimeMs };
    } catch {
      return { missing: true };
    }
  }
}

/**
 * Takes a stale slot away: renames it (atomic; a second process doing the same gets an error), checks that what was
 * renamed is the slot that was judged stale and not a fresh one created in between, and removes it. A fresh one is put
 * back. Returns true when the slot name is free again as far as this process knows.
 */
function takeOver(dir, seen, { pid = process.pid, now = Date.now() } = {}) {
  const aside = `${dir}.stale-${pid}-${now}`;
  try {
    fs.renameSync(dir, aside);
  } catch {
    return false; // someone else took it, or Windows still holds a handle: looked at again next round
  }
  const moved = readSlot(aside);
  if ((moved.text ?? null) !== (seen.text ?? null)) {
    try {
      fs.renameSync(aside, dir);
    } catch {
      /* its owner gave it up in the meantime, or a new slot took the name */
    }
    return false;
  }
  try {
    fs.rmSync(aside, { recursive: true, force: true });
  } catch {
    /* a leftover name in the temp folder hurts nothing */
  }
  return true;
}

/**
 * One try at every slot. Never waits and never throws on a file error.
 * @param {{ root: string, slots: number, who?: object, now?: number, pid?: number, alive?: Function }} x
 * @returns {{ ok: true, slot: { dir: string, holder: object } } | { ok: false, holders: object[], failed: boolean }}
 *   failed: a file error other than "already there" kept a slot from being looked at.
 */
function tryAcquire({ root, slots, who = {}, now = Date.now(), pid = process.pid, alive = pidAlive }) {
  const holder = { ...who, pid, started: new Date(now).toISOString() };
  // This process holds no slot when it asks, so a holder with its own pid is a leftover from a reused pid.
  const elseAlive = (p) => p !== pid && alive(p);
  const holders = [];
  let failed = false;
  try {
    fs.mkdirSync(root, { recursive: true });
  } catch {
    return { ok: false, holders, failed: true };
  }
  for (let i = 0; i < slots; i++) {
    const dir = path.join(root, `slot-${i}`);
    // Two passes: the second one after a stale slot was taken away or the slot was released between two calls.
    for (let pass = 0; pass < 2; pass++) {
      try {
        fs.mkdirSync(dir);
      } catch (e) {
        if (e?.code !== 'EEXIST') {
          failed = true;
          break;
        }
        const seen = readSlot(dir);
        if (seen.missing) continue;
        if (staleReason(seen.holder, { now, alive: elseAlive, mtimeMs: seen.mtimeMs })) {
          if (takeOver(dir, seen, { pid, now })) continue;
          break;
        }
        if (seen.holder) holders.push(seen.holder);
        break;
      }
      try {
        fs.writeFileSync(path.join(dir, HOLDER_FILE), `${JSON.stringify(holder)}\n`);
        return { ok: true, slot: { dir, holder } };
      } catch {
        // Cannot record the holder (a full disk): do not leave a slot nobody can name.
        try {
          fs.rmSync(dir, { recursive: true, force: true });
        } catch {
          /* becomes stale after a minute */
        }
        failed = true;
        break;
      }
    }
  }
  return { ok: false, holders, failed };
}

/** Gives a slot back, but only when it is still the one this process took. Never throws. Returns true when removed. */
function release(slot) {
  if (!slot) return false;
  try {
    const seen = readSlot(slot.dir);
    if (seen.holder?.pid !== slot.holder.pid || seen.holder?.started !== slot.holder.started) return false;
    fs.rmSync(slot.dir, { recursive: true, force: true });
    return true;
  } catch {
    return false; // the pid check is the safety net: the next waiter takes it over once this process is gone
  }
}

/** The one line for a run that has to wait. */
function waitLine(holders, { slots = 1, now = Date.now() } = {}) {
  const one = (h) => {
    const min = Math.max(0, Math.round((now - Date.parse(h.started ?? '')) / 60_000));
    const what = `${h.kind ?? '?'} gates of ${h.project ?? '?'}${h.track ? ` (${h.track})` : ''}`;
    return `${what}, pid ${h.pid ?? '?'}, ${Number.isFinite(min) ? `running for ${min} min` : 'just started'}`;
  };
  return (
    `GATE QUEUE: waiting for a free slot (${slots} at a time on this machine), held by ${holders.map(one).join('; ')}. ` +
    'The time budget starts when this check starts.'
  );
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits for a slot.
 * @param {{ root: string, slots: number, who?: object, onWait?: (holders: object[]) => void, pollMs?: number,
 *   sleep?: (ms: number) => Promise<void>, now?: () => number, pid?: number, alive?: Function }} x
 * @returns {Promise<{ slot: object|null, waitSec: number, failedOpen: boolean }>}
 *   slot null with failedOpen: the queue could not be used; the caller runs without it.
 */
async function acquireWait({ root, slots, who = {}, onWait = () => {}, pollMs = POLL_MS, sleep = pause, now = Date.now, pid = process.pid, alive = pidAlive }) {
  const t0 = now();
  const waited = () => Math.round((now() - t0) / 100) / 10;
  let announced = false;
  let failedRounds = 0;
  for (;;) {
    const r = tryAcquire({ root, slots, who, now: now(), pid, alive });
    if (r.ok) return { slot: r.slot, waitSec: waited(), failedOpen: false };
    failedRounds = r.failed && !r.holders.length ? failedRounds + 1 : 0;
    if (failedRounds >= MAX_FAILED_ROUNDS) return { slot: null, waitSec: waited(), failedOpen: true };
    if (!announced && r.holders.length) {
      onWait(r.holders);
      announced = true;
    }
    await sleep(pollMs);
  }
}

module.exports = {
  DEFAULTS,
  POLL_MS,
  MAX_AGE_MS,
  defaultRoot,
  setupFrom,
  lastDurationSec,
  needsSlot,
  budgetDeadline,
  staleReason,
  readSlot,
  takeOver,
  tryAcquire,
  release,
  waitLine,
  acquireWait,
};
