// =============================================================
// cli/wait.mjs: `ravenseat wait`, a background waiter that exits when the owner acts.
//
//   ravenseat wait [--debounce <s>] [--timeout <h>] [--since <log-nr>] [--check-min <n>]
//        blocks until an owner action (lib/ownerWait.js: resolve, approve, qa ok/fail, add, and the logged edits by
//        owner or theBoard) appears after the start point, waits --debounce seconds (default 30) for more, then prints
//        one line "OWNER ACTED: resolve Q12, Q14; approve T-40" (ids only, never the answer text) and the hint
//        "run: ravenseat resolutions --unlogged", exit 0. After --timeout hours (default 8) without an action: TIMEOUT, exit 10.
//        The start point is the end of the changelog when it starts, so old actions never fire; --since <log-nr> sets it.
//        Every --check-min minutes (default 5, 0 = off) it also runs the checks `ravenseat show` runs: a track no agent took, or
//        a silent one, gives "TRACKS NEED A LOOK: ..." and exit 11. Each finding wakes it once (<dataFolder>/wait-tracks-seen.json),
//        so starting it again does not loop on a track the owner has chosen to leave. An owner answer through ravenseat resume
//        (the board) counts as an action; the waiter then says the round still needs its agent.
//
// Why: the orchestrator only runs when an agent finishes or the owner types in the session, so an answer given on the
// board sits unseen while everything waits on the owner. Claude Code starts a new turn when a run_in_background Bash
// command exits; this command is that exit. It only works while the Claude Code session is open (also via Remote
// Control), and costs no tokens while it waits.
//
// One waiter at a time: <dataFolder>/.waitLock (a lib/queueLock.js lock, token with pid and startedAt). A second
// `ravenseat wait` while a live one runs prints "ALREADY WAITING (pid n)" and exits 0; a lock whose pid is dead is taken
// over (a wait.lock file from an older version is honoured the same way). The lock and the heartbeat are removed on
// exit, SIGINT and SIGTERM. The heartbeat <dataFolder>/wait-heartbeat.json ({ pid, startedAt, beatAt }) is
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

import { a, CLI, die, FILE, FOLDER, require, val } from './context.mjs';
import { findSilent, findWithoutAgent } from './tracks.mjs';

const W = require('./lib/ownerWait.js');

/** The exit code for TIMEOUT (0, 1 and 3-7 are taken; see the bottom of the usage in queue.mjs). */
export const EXIT_TIMEOUT = 10;
/** The exit code when a track needs a look. */
export const EXIT_TRACKS = 11;
const TRACKS_SEEN = path.join(FOLDER, 'wait-tracks-seen.json');
const QL = require('./lib/queueLock.js');
/** The waiter lock, a lib/queueLock.js folder (LAGRING step 6: one lock implementation). */
const LOCK_DIR = path.join(FOLDER, '.waitLock');
/** The lock file of the versions before; a live holder there still counts (takeLock). */
const LEGACY_LOCK = path.join(FOLDER, 'wait.lock');
/** A waiter on another host (a shared data folder) whose pid cannot be checked: taken over after 8 h, the default --timeout. */
const OTHER_HOST_STALE_MS = 8 * 3_600_000;
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

/** The findings that have woken a waiter already. Missing or broken: none. */
function readSeen() {
  try {
    const seen = JSON.parse(fs.readFileSync(TRACKS_SEEN, 'utf8'));
    return Array.isArray(seen) ? seen : [];
  } catch {
    return [];
  }
}

/**
 * Takes the lock: { me } (the token to release), or { held } with the live holder ({ pid, ... }). A dead holder is
 * taken over (lib/queueLock.js: the same rule as the queue lock, one try). A wait.lock file from an older version is
 * still a holder while its pid runs, and removed when it is gone.
 */
function takeLock(startedAt) {
  let old = null;
  try {
    old = JSON.parse(fs.readFileSync(LEGACY_LOCK, 'utf8'));
  } catch {
    /* none, or half written: no holder */
  }
  if (old && old.pid !== process.pid && W.pidAlive(old.pid)) return { held: old };
  fs.rmSync(LEGACY_LOCK, { force: true });
  const got = QL.acquire(LOCK_DIR, { waitMs: 0, staleAgeMs: OTHER_HOST_STALE_MS, meta: { startedAt } });
  if (got.ok) return { me: got.me };
  const holder = got.state?.tokens?.[0]?.owner;
  if (holder) return { held: holder };
  die(`Could not take ${LOCK_DIR} (try again, or look with ${CLI} unlock).`);
}

/** Removes a file only when it is ours (a waiter that took over a stale lock must not lose it to the old one). */
function removeOwn(file) {
  try {
    if (JSON.parse(fs.readFileSync(file, 'utf8'))?.pid === process.pid) fs.rmSync(file, { force: true });
  } catch {
    /* already gone */
  }
}

/** `ravenseat wait` (the usage is at the top of queue.mjs). */
export function cmdWait() {
  const debounceMs = number('--debounce', 30) * 1000;
  const timeoutMs = number('--timeout', 8) * 3_600_000;
  const since = a.includes('--since') ? number('--since', 0) : null;
  const checkMs = number('--check-min', 5) * 60_000;
  if (timeoutMs <= 0) die('--timeout needs a number of hours above 0');
  // setTimeout takes at most about 24 days.
  if (timeoutMs > 2_000_000_000) die('--timeout is at most 500 hours');
  if (!fs.existsSync(FILE)) die(`The queue does not exist. Run: ${CLI} init`);

  const startedAt = new Date().toISOString();
  const { held, me } = takeLock(startedAt);
  if (held) {
    console.log(`ALREADY WAITING (pid ${held.pid})`);
    process.exit(0);
  }
  process.on('exit', () => {
    removeOwn(HEARTBEAT);
    QL.release(LOCK_DIR, me); // only this waiter's own token (a waiter that took over must not lose it to the old one)
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
      require('./lib/stateFile.js').renameWithRetry(tmp, HEARTBEAT);
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
    const all = acts.length ? acts : first;
    console.log(W.actedLine(all));
    console.log(`run: ${CLI} resolutions --unlogged`);
    for (const x of all.filter((y) => y.action === 'answer'))
      console.log(`${x.id}: the owner answered and the round is ready, but no agent runs. Run ${CLI} resume ${x.id} --reason context and start the agent line it prints.`);
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
  // The tracks: a track that never started wakes nobody by itself. Git only runs here, every few minutes, so waiting
  // stays cheap, and no tokens are spent unless something is found.
  const checkTracks = () => {
    if (acting) return;
    const now = readQueue();
    if (!now) return;
    const keys = W.trackKeys(findWithoutAgent(now), findSilent(now));
    const seen = readSeen();
    const fresh = keys.filter((k) => !seen.includes(k));
    // Written also when nothing is new: a finding that went away may wake it again if it comes back.
    if (keys.length !== seen.length || fresh.length) {
      try {
        fs.writeFileSync(TRACKS_SEEN, `${JSON.stringify(keys)}\n`);
      } catch {
        /* then it may wake once more; waiting goes on */
      }
    }
    if (!fresh.length) return;
    console.log(W.tracksLine(fresh));
    console.log(`run: ${CLI} show`);
    process.exit(EXIT_TRACKS);
  };
  if (checkMs > 0) setInterval(checkTracks, checkMs);
  setTimeout(() => {
    if (acting) return;
    console.log('TIMEOUT');
    process.exit(EXIT_TIMEOUT);
  }, timeoutMs);
  // With --since, entries already in the changelog may count: check once now.
  check();
}
