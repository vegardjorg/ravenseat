// =============================================================
// lib/queueLock.js: the owner of the queue lock (<dataFolder>/.lockState), the takeover rule and the atomic takeover.
//
// WHY: the lock was a bare folder, and a folder older than 60 s was deleted by the next caller. A slow or paused holder
// lost the lock without knowing, kept going, published queue.json, and at the end removed the lock a new holder had
// taken. Atomic rename and queue.json.prev protect the file, not the right to write it.
//
// THE LOCK: a folder (mkdir is exclusive) holding a token file, owner-<generation>.json, with pid, a random nonce,
// hostname and start time. Every step below rests on two operations that are atomic on Windows and Linux alike:
// creating a file that must not exist (the `wx` flag) and rmdir, which only removes an empty folder.
//   * Holding = the file with my generation holds my nonce. A holder asks with isHeld before it publishes and before it
//     releases.
//   * Taking over generation g = creating owner-<g+1>.json with `wx`. Of any number of waiters on the same stale lock
//     exactly one creates that name. The lock folder never moves, so a live lock is never out of place, not even for a
//     moment, and a waiter that is wrong about what it saw touches nothing of anyone else's.
//     NOT by renaming the stale token or folder: on Windows two processes renaming the same file to different names can
//     BOTH succeed (seen in this file's race test, 8 rounds of 30), so a rename decides no winner there.
//   * After creating its token a process lists the folder. Everything else in it must be what it saw when it judged the
//     lock (same file, same bytes). Then it removes those and goes on. Anything new means its view was old (the lock was
//     released and taken again since): it takes its own token out, tries rmdir, and starts over. Write first, list after:
//     of two processes that meet like this at most one sees nothing new, and the other's token is never touched.
//   * Releasing = removing my own token, then rmdir. A holder that lost the lock between its check and its release still
//     cannot remove the new holder's lock: its token check fails, and even past that rmdir refuses a folder with a token.
// A folder without a token is a holder between mkdir and its token, or a lock from before tokens. Both fall under the
// age rule, so a waiter leaves a fresh one alone. A holder that was paused there past the age finds its name taken.
//
// THE RULE (assessLock, pure):
//   same host, pid dead       take over at once
//   same host, pid alive      never take over, whatever the age; after the wait the error names pid, age and ravenseat unlock
//   other host, no owner      the age rule (older than 60 s, by the folder's mtime)
//
// WHAT REMAINS (no lock file can settle these):
//   * Pid reuse: a dead holder's pid taken by another process reads as alive. That errs on the safe side: the lock is not
//     taken over, and the owner releases it with ravenseat unlock.
//   * Same hostname but separate pid spaces (WSL next to Windows on one folder, containers with one hostname): a live
//     holder's pid reads as dead there and the lock is taken over. Do not share a data folder across those.
//   * Another host: its pid cannot be asked, so a slow holder there can lose the lock by age. See stopIfLockLost in
//     cli/context.mjs on what that means.
//   * A process that dies between mkdir and its token leaves a folder without an owner: the others wait for the age rule.
//
// Used by: cli/context.mjs (withLock, write, die), cli/unlock.mjs. Tested in: lib/__tests__/queueLock.test.ts.
// =============================================================

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** A lock whose holder cannot be asked (other host, no readable owner) is stale after this long. */
const STALE_AGE_MS = 60_000;
/** How long a caller waits for the lock before it gives up with an error. */
const WAIT_MS = 15_000;
const POLL_MS = 100;

const TOKEN_RE = /^owner-([1-9][0-9]*)\.json$/;
const tokenName = (generation) => `owner-${generation}.json`;

/** A blocking sleep (the CLI is synchronous). */
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * True when the pid runs on this machine, on Windows and Linux alike. `process.kill(pid, 0)` sends no signal. ESRCH =
 * dead; EPERM = alive (another user's process). Any other error also counts as alive: not taking over is the safe side.
 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code !== 'ESRCH';
  }
}

/** Has the parsed token what the same-host rule needs? */
const usableOwner = (owner) =>
  !!owner && Number.isInteger(owner.pid) && owner.pid > 0 && typeof owner.hostname === 'string' && owner.hostname !== '';

/**
 * The takeover rule. `holderAlive` tells the error message which of the waits this is.
 * @param {{ owner: object|null, ageMs: number, hostname: string, isAlive: (pid: number) => boolean }} x
 * @returns {{ action: 'wait'|'take_over', reason: string, holderAlive: boolean }}
 */
function assessLock({ owner, ageMs, hostname, isAlive }) {
  if (usableOwner(owner) && owner.hostname === hostname) {
    if (isAlive(owner.pid))
      return { action: 'wait', reason: `process ${owner.pid} on this host is alive`, holderAlive: true };
    return { action: 'take_over', reason: `process ${owner.pid} on this host is gone`, holderAlive: false };
  }
  const who = usableOwner(owner) ? `the holder on ${owner.hostname}` : 'a lock without a readable owner';
  if (ageMs > STALE_AGE_MS)
    return { action: 'take_over', reason: `${who} is older than ${STALE_AGE_MS / 1000} s`, holderAlive: false };
  return { action: 'wait', reason: `${who} is not older than ${STALE_AGE_MS / 1000} s`, holderAlive: false };
}

/** The wait in ms. QUEUE_LOCK_WAIT_MS exists for the tests and can only shorten it, so it never weakens anything. */
function waitMsFrom(value) {
  const n = Number(value);
  return value != null && value !== '' && Number.isFinite(n) && n >= 0 ? Math.min(n, WAIT_MS) : WAIT_MS;
}

/** A new owner: the content of the token. withLock keeps it to ask whether it still holds the lock. */
function newOwner({ generation = 1, pid = process.pid, hostname = os.hostname(), now = Date.now(), nonce = crypto.randomBytes(12).toString('hex') } = {}) {
  return { generation, pid, nonce, hostname, started: new Date(now).toISOString() };
}

/** The text of a token file, or null when it is gone. */
function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** The JSON in a token's text, or null while it is being written or when it is broken. */
function parseOwner(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * What is in the lock folder now, or null when there is no lock. Listed before the stat, so an mtime is never older than
 * the list it is read with. Tokens are sorted by generation, highest first.
 * @returns {{ ageMs: number, tokens: { name: string, generation: number, text: string|null, owner: object|null }[], other: string[] }|null}
 */
function readState(lockDir, now = Date.now) {
  let names;
  let mtimeMs;
  try {
    names = fs.readdirSync(lockDir);
    mtimeMs = fs.statSync(lockDir).mtimeMs;
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
    throw e;
  }
  const tokens = [];
  const other = [];
  for (const name of names) {
    const m = TOKEN_RE.exec(name);
    if (!m) {
      other.push(name);
      continue;
    }
    const text = readText(path.join(lockDir, name));
    tokens.push({ name, generation: Number(m[1]), text, owner: parseOwner(text) });
  }
  tokens.sort((x, y) => y.generation - x.generation);
  return { ageMs: now() - mtimeMs, tokens, other };
}

/** Does this owner still hold the lock? Anything but my own nonce in my own file is no (and then nothing gets written). */
function isHeld(lockDir, me) {
  return parseOwner(readText(path.join(lockDir, tokenName(me.generation))))?.nonce === me.nonce;
}

/** rmdir, with a few tries for the moment Windows holds the folder. Never removes a folder with something in it. */
function removeFolderIfEmpty(lockDir) {
  for (let i = 0; i < 8; i++) {
    try {
      fs.rmdirSync(lockDir);
      return true;
    } catch (e) {
      if (e.code === 'ENOENT') return false;
      try {
        if (fs.readdirSync(lockDir).length) return false;
      } catch {
        return false;
      }
      sleepMs(25);
    }
  }
  return false;
}

/**
 * Creates my token (only one process can create a name) and checks the folder against what I saw. On a yes, the tokens I
 * saw are removed and the lock is mine. On a no, my token is taken out again and nothing else is touched.
 * @param {{ tokens: { name: string, text: string|null }[], other: string[] }} seen what the decision was based on
 * @returns {boolean}
 */
function placeToken(lockDir, me, seen) {
  const mine = tokenName(me.generation);
  try {
    fs.writeFileSync(path.join(lockDir, mine), `${JSON.stringify(me)}\n`, { flag: 'wx' });
  } catch {
    // Another process has that name, or the folder went away. After a mkdir of my own that failed for another reason,
    // this leaves no empty folder for the others to wait on.
    removeFolderIfEmpty(lockDir);
    return false;
  }
  const saw = new Map(seen.tokens.map((t) => [t.name, t.text]));
  let unchanged = false;
  try {
    unchanged = fs
      .readdirSync(lockDir)
      .filter((n) => TOKEN_RE.test(n) && n !== mine)
      .every((n) => saw.has(n) && saw.get(n) === readText(path.join(lockDir, n)));
  } catch {
    /* the folder went away, and my token with it */
  }
  if (!unchanged) {
    fs.rmSync(path.join(lockDir, mine), { force: true });
    removeFolderIfEmpty(lockDir);
    return false;
  }
  for (const t of seen.tokens) fs.rmSync(path.join(lockDir, t.name), { force: true });
  for (const name of seen.other) fs.rmSync(path.join(lockDir, name), { recursive: true, force: true });
  return true;
}

const NOTHING_SEEN = { tokens: [], other: [] };

/**
 * One attempt to get the lock.
 * @returns {{ ok: true, me: object, tookOver: string|null } | { ok: false, verdict: object|null, state: object|null }}
 */
function tryOnce(lockDir, { hostname, isAlive, now, pid }) {
  const lost = { ok: false, verdict: null, state: null };
  let made = false;
  try {
    fs.mkdirSync(lockDir);
    made = true;
  } catch {
    /* it exists, or (Windows) is being deleted: read below */
  }
  if (made) {
    const me = newOwner({ pid, hostname, now: now() });
    if (placeToken(lockDir, me, NOTHING_SEEN)) return { ok: true, me, tookOver: null };
    return lost;
  }
  const state = readState(lockDir, now);
  if (!state) return lost;
  const judge = (owner) => assessLock({ owner, ageMs: state.ageMs, hostname, isAlive });
  // Any token that says wait decides: a live holder is never taken over, also not next to a leftover older token.
  const verdicts = state.tokens.map((t) => judge(t.owner));
  if (!verdicts.length) verdicts.push(judge(null));
  const waiting = verdicts.find((v) => v.action === 'wait');
  if (waiting) return { ok: false, verdict: waiting, state };
  const me = newOwner({ generation: (state.tokens[0]?.generation ?? 0) + 1, pid, hostname, now: now() });
  return placeToken(lockDir, me, state) ? { ok: true, me, tookOver: verdicts[0].reason } : lost;
}

/**
 * Gets the lock, waiting up to waitMs.
 * @param {string} lockDir
 * @param {{ waitMs?: number, hostname?: string, isAlive?: Function, pid?: number, now?: () => number }} [o]
 * @returns {{ ok: true, me: object, tookOver: string|null } | { ok: false, waitedMs: number, verdict: object|null, state: object|null }}
 */
function acquire(lockDir, { waitMs = WAIT_MS, hostname = os.hostname(), isAlive = pidAlive, pid = process.pid, now = Date.now } = {}) {
  const started = now();
  let last = { verdict: null, state: null };
  for (;;) {
    let r;
    try {
      r = tryOnce(lockDir, { hostname, isAlive, now, pid });
    } catch {
      // A file system error in this round: try until the deadline, which then ends in the error, as an unusable data
      // folder always did.
      r = { ok: false, verdict: null, state: null };
    }
    if (r.ok) return r;
    // A round that lost a race says nothing about the holder: keep the last real answer for the message.
    if (r.state) last = r;
    if (now() - started > waitMs) return { ok: false, waitedMs: now() - started, verdict: last.verdict, state: last.state };
    sleepMs(Math.min(POLL_MS, Math.max(1, waitMs)));
  }
}

/** Gives the lock back. False, with nothing touched, when it is not mine any more. */
function release(lockDir, me) {
  try {
    if (!isHeld(lockDir, me)) return false;
    fs.rmSync(path.join(lockDir, tokenName(me.generation)), { force: true });
  } catch {
    return false; // Could not be removed: left to the rule (this pid is gone soon).
  }
  removeFolderIfEmpty(lockDir);
  return true;
}

/**
 * The owner's release (ravenseat unlock --force): takes out exactly what `state` shows, checked against the bytes, so a holder
 * that arrived after that is left alone. Returns how many tokens it took and whether the folder is gone.
 */
function forceRelease(lockDir, state) {
  let taken = 0;
  for (const t of state.tokens) {
    const file = path.join(lockDir, t.name);
    if (readText(file) !== t.text) continue;
    fs.rmSync(file, { force: true });
    taken++;
  }
  for (const name of state.other) fs.rmSync(path.join(lockDir, name), { recursive: true, force: true });
  return { taken, removed: removeFolderIfEmpty(lockDir) };
}

/** "pid 12 on box, started 2026-..." for one token; `no readable owner` otherwise. */
function holderText(token) {
  const o = token?.owner;
  return usableOwner(o) ? `pid ${o.pid} on ${o.hostname}, started ${o.started ?? '?'}` : 'no readable owner';
}

/** The error when the wait ran out. `folder` is the data folder and `ravenseat` the command to show. */
function heldMessage({ folder, ravenseat = 'ravenseat', verdict, state, waitedMs = WAIT_MS }) {
  const tried = `tried for ${Math.round(waitedMs / 1000)} s`;
  const how = `Look with ${ravenseat} unlock; release it with ${ravenseat} unlock --force --by owner.`;
  if (!state) return `Could not get the lock on ${folder} (${tried}). Try again.`;
  const ageS = Math.round(state.ageMs / 1000);
  const token = state.tokens[0];
  if (verdict?.holderAlive)
    return (
      `Could not get the lock on ${folder} (${tried}): ${holderText(token)} holds it, for ${ageS} s now, and is still ` +
      `running. A live holder is never taken over, whatever the age. Let it finish; if it hangs: ${how}`
    );
  return `Could not get the lock on ${folder} (${tried}): ${holderText(token)}, ${ageS} s old. Try again. ${how}`;
}

module.exports = {
  STALE_AGE_MS,
  WAIT_MS,
  pidAlive,
  assessLock,
  waitMsFrom,
  newOwner,
  tokenName,
  readState,
  isHeld,
  placeToken,
  acquire,
  release,
  forceRelease,
  holderText,
  heldMessage,
};
