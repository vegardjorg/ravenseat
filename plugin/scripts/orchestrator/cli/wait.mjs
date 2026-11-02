// =============================================================
// cli/wait.mjs: `cq wait`, a background waiter that exits when the owner acts.
//
//   cq wait [--debounce <s>] [--timeout <h>] [--since <log-nr>]
//        blocks until an owner action (lib/ownerWait.js: resolve, approve, qa ok/fail, add, and the logged edits by
//        owner or theBoard) appears after the start point, waits --debounce seconds (default 30) for more, then prints
//        one line "OWNER ACTED: resolve Q12, Q14; approve T-40" (ids only, never the answer text) and the hint
//        "run: cq resolutions --unlogged", exit 0. After --timeout hours (default 8) without an action: TIMEOUT, exit 10.
//        The start point is the end of the changelog when it starts, so old actions never fire; --since <log-nr> sets it.
//
// Why: the orchestrator only runs when an agent finishes or the owner types in the session, so an answer given on the
// board sits unseen while everything waits on the owner. Claude Code starts a new turn when a run_in_background Bash
// command exits; this command is that exit. It only works while the Claude Code session is open (also via Remote
// Control), and costs no tokens while it waits.
//
// One waiter at a time: <dataFolder>/wait.lock holds { pid, startedAt }. A second `cq wait` while a live one runs prints
// "ALREADY WAITING (pid n)" and exits 0; a lock whose pid is dead is taken over. The lock and the heartbeat are removed
// on exit, SIGINT and SIGTERM. The heartbeat <dataFolder>/wait-heartbeat.json ({ pid, startedAt, beatAt }) is
// rewritten every 30 s; the board shows "Orchestrator listening" while it is fresh.
//
// Watching: fs.watch on the data folder (queue.json is replaced by a rename, so the folder is watched, not the file)
// plus a stat every 2 s, because fs.watch is unreliable on Windows and network drives.
//
// Used by: queue.mjs (dispatch).
// Tested in: lib/__tests__/ownerWait.test.ts.
// =============================================================

import fs from 'node:fs';
import path from 'node:path';

import { a, CQ, die, FILE, FOLDER, require, val } from './context.mjs';

const W = require('./lib/ownerWait.js');

/** The exit code for TIMEOUT (0, 1 and 3-7 are taken; see the bottom of the usage in queue.mjs). */
export const EXIT_TIMEOUT = 10;
const LOCK_FILE = path.join(FOLDER, 'wait.lock');
const HEARTBEAT = path.join(FOLDER, W.HEARTBEAT_FILE);
const BEAT_MS = 30_000;
const POLL_MS = 2_000;

/** A non-negative number from a flag, or the default; anything else stops with exit 1. */
function number(flag, fallback) {
  if (!a.includes(flag)) return fallback;
  const n = Number(val(flag));
  if (!Number.isFinite(n) || n < 0) die(`${flag} needs a number of 0 or more (got ${val(flag) ?? 'nothing'})`);
  return n;
}

/** Reads the queue, or null while it is missing or half written (the next check tries again). */
function readQueue() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return null;
  }
}

/** Takes the lock, or returns the live holder's { pid, startedAt }. A dead holder's lock is taken over. */
function takeLock(startedAt) {
  for (let i = 0; i < 3; i += 1) {
    try {
      fs.writeFileSync(LOCK_FILE, JSON.stringify({ pid: process.pid, startedAt }) + '\n', { flag: 'wx' });
      return null;
    } catch (e) {
      if (e?.code !== 'EEXIST') die(`Could not write ${LOCK_FILE}: ${e?.message ?? e}`);
    }
    let held = null;
    try {
      held = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8'));
    } catch {
      /* half written or gone: treated as stale */
    }
    if (held && held.pid !== process.pid && W.pidAlive(held.pid)) return held;
    fs.rmSync(LOCK_FILE, { force: true });
  }
  die(`Could not take ${LOCK_FILE} (another waiter keeps replacing it).`);
}

/** Removes a file only when it is ours (a waiter that took over a stale lock must not lose it to the old one). */
function removeOwn(file) {
  try {
    if (JSON.parse(fs.readFileSync(file, 'utf8'))?.pid === process.pid) fs.rmSync(file, { force: true });
  } catch {
    /* already gone */
  }
}

/** `cq wait` (the usage is at the top of queue.mjs). */
export function cmdWait() {
  const debounceMs = number('--debounce', 30) * 1000;
  const timeoutMs = number('--timeout', 8) * 3_600_000;
  const since = a.includes('--since') ? number('--since', 0) : null;
  if (timeoutMs <= 0) die('--timeout needs a number of hours above 0');
  // setTimeout takes at most about 24 days.
  if (timeoutMs > 2_000_000_000) die('--timeout is at most 500 hours');
  if (!fs.existsSync(FILE)) die(`The queue does not exist. Run: ${CQ} init`);

  const startedAt = new Date().toISOString();
  const held = takeLock(startedAt);
  if (held) {
    console.log(`ALREADY WAITING (pid ${held.pid})`);
    process.exit(0);
  }
  process.on('exit', () => {
    removeOwn(HEARTBEAT);
    removeOwn(LOCK_FILE);
  });
  // process.exit runs the exit handler above; 128 + the signal number, as a shell reports it.
  process.on('SIGINT', () => process.exit(130));
  process.on('SIGTERM', () => process.exit(143));
  process.on('SIGHUP', () => process.exit(129));

  const queue = readQueue();
  if (!queue) die(`Could not read ${FILE}.`);
  const base = W.snapshot(queue, { since });
  const beat = () => {
    try {
      const tmp = `${HEARTBEAT}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ pid: process.pid, startedAt, beatAt: new Date().toISOString() }) + '\n');
      fs.renameSync(tmp, HEARTBEAT);
    } catch {
      /* the board then says the answers are picked up later; waiting goes on */
    }
  };
  beat();
  setInterval(beat, BEAT_MS);
  console.log(
    `Waiting for the owner (pid ${process.pid}, after changelog no. ${base.nr}, ` +
      `debounce ${debounceMs / 1000} s, timeout ${timeoutMs / 3_600_000} h).`,
  );

  let acting = false;
  let first = [];
  const finish = () => {
    const now = readQueue() ?? queue;
    const acts = W.ownerActions(now, base);
    console.log(W.actedLine(acts.length ? acts : first));
    console.log(`run: ${CQ} resolutions --unlogged`);
    process.exit(0);
  };
  const check = () => {
    if (acting) return;
    const now = readQueue();
    if (!now) return;
    const acts = W.ownerActions(now, base);
    if (!acts.length) return;
    // The first owner action: collect more for the debounce window, then print them all in one line.
    acting = true;
    first = acts;
    setTimeout(finish, debounceMs);
  };

  // fs.watch can fire several times per write; one check per burst is enough.
  let soon = null;
  const checkSoon = () => {
    clearTimeout(soon);
    soon = setTimeout(check, 100);
  };
  try {
    const watcher = fs.watch(FOLDER, (_event, name) => {
      if (!name || String(name) === path.basename(FILE)) checkSoon();
    });
    watcher.on('error', () => watcher.close());
  } catch {
    /* no fs.watch here (some network drives): the stat below is enough */
  }
  let seen = '';
  const stamp = () => {
    try {
      const s = fs.statSync(FILE);
      return `${s.mtimeMs} ${s.size}`;
    } catch {
      return '';
    }
  };
  seen = stamp();
  setInterval(() => {
    const s = stamp();
    if (s !== seen) {
      seen = s;
      check();
    }
  }, POLL_MS);
  setTimeout(() => {
    if (acting) return;
    console.log('TIMEOUT');
    process.exit(EXIT_TIMEOUT);
  }, timeoutMs);
  // With --since, entries already in the changelog may count: check once now.
  check();
}
