// =============================================================
// lib/mergeLock.js: the merge lock, the merge state file and the check for an unfinished git operation, for `ravenseat merge`.
//
// WHY: `ravenseat merge` runs several steps in a row (merge-track, the migration push, the gates, the base gate, set done,
// fill). Three things went wrong before (review 2026-11-02, M6, M7, M8):
//   * A merge left in place (MERGE_HEAD from an earlier conflict) made the next `ravenseat merge B` commit A's merge and mark
//     B done. Now the merge refuses to start while git has a merge, rebase, cherry-pick or revert in progress
//     (gitInProgress), and the tip of the track must be in the base before `done` (cli/merge.mjs).
//   * Ctrl-C or a crash after the merge but before `done` left the task in review with nothing to continue from. Now
//     every step is written to a small state file (merge-state-<id>.json in the data folder) as it starts and ends,
//     so `ravenseat merge <id> --resume` knows which steps are left.
//   * Two `ravenseat merge` at the same time could merge on top of each other. Now one merge runs at a time per data folder
//     (the lock <dataFolder>/.mergeLock, with pid, host, start time, task and command).
//
// THE LOCK (LAGRING step 6: one lock implementation): a lib/queueLock.js folder, so the merge lock has the queue lock's
// generation rule and takeover. A holder on this host is taken over the moment its pid is gone and never while it runs,
// whatever its age (before, a live merge older than 6 h was taken over too; a stuck one is now released by the owner:
// delete the folder). A holder on another host (a network data folder) is taken over after maxAgeMs (6 h). The task and
// command ride in the token (queueLock meta), so a refusal names the merge that holds it. Only the holder's own token
// (its nonce) is ever released.
// A merge.lock FILE from an older version is still honoured by the old rule (staleReason): a live holder holds, a stale
// one is removed before the new lock is taken.
//
// No I/O beyond the data folder and the lock and state files; git is reached through a `gitPath` callback, so the
// rules can be tested without a repo.
//
// Used by: cli/merge.mjs (cmdMerge). Tested in: lib/__tests__/mergeLock.test.ts, __tests__/queueMergeResume.test.ts.
// =============================================================

const fs = require('node:fs');
const QL = require('./queueLock.js');
const { renameWithRetry } = require('./stateFile.js');
const os = require('node:os');
const path = require('node:path');

/** A merge with slow gates and a migration push can run for a long time; a lock older than this is stale anyway. */
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

const LOCK_NAME = '.mergeLock';
/** The lock file of the versions before the lock moved to lib/queueLock.js; still honoured (see acquire). */
const LEGACY_NAME = 'merge.lock';

/** The lock (a lib/queueLock.js folder) in the data folder. */
function lockFile(folder) {
  return path.join(folder, LOCK_NAME);
}

function legacyFile(folder) {
  return path.join(folder, LEGACY_NAME);
}

/**
 * True when the process with this pid runs on this machine. `process.kill(pid, 0)` sends no signal; it only checks.
 * EPERM means it runs but belongs to another user (alive). Anything that is not a positive integer is not alive.
 */
function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

/**
 * Why a lock is stale, or null when it is held. A lock that cannot be read or parsed (a crash in the middle of the
 * write) is stale only when the file is older than a minute, so a lock being written right now is not taken.
 * @param {object|null} holder the parsed lock (null when it could not be parsed)
 * @param {{ now?: number, host?: string, alive?: (pid: number) => boolean, maxAgeMs?: number, mtimeMs?: number }} x
 * @returns {string|null}
 */
function staleReason(holder, { now = Date.now(), host = os.hostname(), alive = pidAlive, maxAgeMs = MAX_AGE_MS, mtimeMs = now } = {}) {
  if (!holder || typeof holder !== 'object') return now - mtimeMs > 60_000 ? 'the lock file cannot be read' : null;
  const started = Date.parse(holder.started ?? '');
  const age = Number.isFinite(started) ? now - started : Infinity;
  if (holder.host === host && !alive(holder.pid)) return `the process ${holder.pid} on ${host} is no longer running`;
  if (age > maxAgeMs)
    return `it is older than ${Math.round(maxAgeMs / 60000)} min${Number.isFinite(age) ? ` (${Math.round(age / 60000)} min)` : ''}`;
  return null;
}

function readLock(file) {
  let text;
  let mtimeMs;
  try {
    text = fs.readFileSync(file, 'utf8');
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch (e) {
    if (e.code === 'ENOENT') return { missing: true };
    throw e;
  }
  try {
    return { text, mtimeMs, holder: JSON.parse(text) };
  } catch {
    return { text, mtimeMs, holder: null };
  }
}

/**
 * Takes the merge lock. Never waits: a held lock is an answer for the caller (a clear message), not a reason to queue.
 * @param {string} folder the data folder
 * @param {{ task: string, command?: string, now?: number, pid?: number, host?: string, alive?: Function,
 *   maxAgeMs?: number }} x
 * @returns {{ ok: true, file: string, lock: object, tookOver: { holder: object|null, reason: string }|null }
 *   | { ok: false, file: string, holder: object|null }}
 */
function acquire(folder, { task, command = 'merge', now = Date.now(), pid = process.pid, host = os.hostname(), alive = pidAlive, maxAgeMs = MAX_AGE_MS } = {}) {
  fs.mkdirSync(folder, { recursive: true });
  const file = lockFile(folder);
  // A merge.lock file from an older version: a live holder still holds (the old rule, staleReason), a stale one is
  // removed, but only while it is the same bytes that were judged (a fresh one written in between is left alone).
  let tookOver = null;
  const legacy = legacyFile(folder);
  const seen = readLock(legacy);
  if (!seen.missing) {
    const reason = staleReason(seen.holder, { now, host, alive, maxAgeMs, mtimeMs: seen.mtimeMs });
    if (!reason) return { ok: false, file: legacy, holder: seen.holder };
    try {
      if (fs.readFileSync(legacy, 'utf8') === seen.text) fs.rmSync(legacy, { force: true });
    } catch {
      /* gone meanwhile */
    }
    if (fs.existsSync(legacy)) return { ok: false, file: legacy, holder: readLock(legacy).holder ?? null };
    tookOver = { holder: seen.holder, reason };
  }
  // One try (a held merge lock is an answer, not a reason to wait). staleAgeMs: another host's holder after 6 h.
  const got = QL.acquire(file, { waitMs: 0, pid, hostname: host, isAlive: alive, now: () => now, staleAgeMs: maxAgeMs, meta: { task, command } });
  if (!got.ok) return { ok: false, file, holder: holderOf(got.state?.tokens?.[0]?.owner) };
  if (got.tookOver) tookOver = { holder: holderOf(got.previous), reason: got.tookOver };
  return { ok: true, file, lock: got.me, tookOver };
}

/** A token as the holder the messages show ({ task, command, pid, host, started }), or null when it cannot be read. */
function holderOf(owner) {
  return owner && typeof owner === 'object' ? { ...owner, host: owner.hostname } : null;
}

/** Gives the lock back, but only when it is still the one this process took (lib/queueLock.js: its own nonce). */
function release(folder, lock) {
  if (!lock) return false;
  return QL.release(lockFile(folder), lock);
}

/** The message when another merge holds the lock. */
function heldMessage({ file, holder, ravenseat = 'ravenseat', id }) {
  const who = holder
    ? `${holder.command ?? 'merge'} ${holder.task ?? '?'} (pid ${holder.pid ?? '?'} on ${holder.host ?? '?'}, started ${holder.started ?? '?'})`
    : 'another process (the lock file cannot be read)';
  return (
    `Another ${ravenseat} merge is running in this repo: ${who}. One merge at a time; nothing was done.\n` +
    `Wait for it to finish, then run ${ravenseat} merge ${id} again. A live merge is never taken over; if it hangs, ` +
    `or it ran on another machine that is gone, stop it and delete ${file}.`
  );
}

// ---- An unfinished git operation in the main checkout --------------------------------------------------------------

/** The markers git leaves while an operation waits for the user, with how to finish or undo each one. */
const IN_PROGRESS = [
  { kind: 'merge', marker: 'MERGE_HEAD', finish: 'resolve the files, git add them and git commit --no-edit', undo: 'git merge --abort' },
  { kind: 'rebase', marker: 'rebase-merge', finish: 'git rebase --continue', undo: 'git rebase --abort' },
  { kind: 'rebase', marker: 'rebase-apply', finish: 'git rebase --continue (or git am --continue)', undo: 'git rebase --abort (or git am --abort)' },
  { kind: 'cherry-pick', marker: 'CHERRY_PICK_HEAD', finish: 'git cherry-pick --continue', undo: 'git cherry-pick --abort' },
  { kind: 'revert', marker: 'REVERT_HEAD', finish: 'git revert --continue', undo: 'git revert --abort' },
];

/**
 * The git operations in progress. `gitPath(name)` gives the absolute path of a file in the git directory
 * (`git rev-parse --git-path <name>`, resolved against the checkout), or null.
 * @returns {{ kind: string, marker: string, path: string, finish: string, undo: string, sha: string|null }[]}
 */
function gitInProgress(gitPath) {
  const found = [];
  for (const x of IN_PROGRESS) {
    const p = gitPath(x.marker);
    if (!p || !fs.existsSync(p)) continue;
    let sha = null;
    try {
      if (fs.statSync(p).isFile()) sha = fs.readFileSync(p, 'utf8').trim().split(/\s+/)[0] || null;
    } catch {
      /* the marker went away: still reported */
    }
    found.push({ ...x, path: p, sha });
  }
  return found;
}

/**
 * The refusal text for an unfinished operation, with a recovery hint. `branchOf(sha)` names the queue branch whose tip
 * is that sha (null when none); `taskOf(branch)` the task id for a branch.
 */
function inProgressMessage(found, { root, id, ravenseat = 'ravenseat', branch = null, branchTip = null, branchOf = () => null, taskOf = () => null }) {
  const lines = [];
  for (const x of found) {
    if (x.kind === 'merge') {
      const own = x.sha && branchTip && x.sha === branchTip;
      const other = own ? branch : branchOf(x.sha);
      const otherTask = own ? id : other ? taskOf(other) : null;
      lines.push(
        `A merge is in progress in ${root} (MERGE_HEAD ${String(x.sha ?? '?').slice(0, 12)}${other ? `, the tip of ${other}` : ''}): ` +
          'an earlier merge stopped on a conflict or was interrupted. Merging on top of it would commit that merge ' +
          'instead (review 2026-11-02, M6).',
      );
      lines.push(
        `  Finish it: ${x.finish}${otherTask ? `; then ${ravenseat} merge ${otherTask} --resume runs the rest of its steps` : ''}.`,
      );
      lines.push(`  Or undo it: ${x.undo}.`);
    } else {
      lines.push(`A ${x.kind} is in progress in ${root} (${x.marker}). Finish it (${x.finish}) or undo it (${x.undo}).`);
    }
  }
  lines.push(`Then run ${ravenseat} merge ${id}${found.some((x) => x.kind === 'merge' && x.sha && x.sha === branchTip) ? ' --resume' : ' again'}. Nothing was done.`);
  return lines.join('\n');
}

// ---- The merge state file: which steps of one merge have run -------------------------------------------------------

/** The state file for one task (the id is made safe for a file name). */
function stateFile(folder, id) {
  return path.join(folder, `merge-state-${String(id).replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
}

function readState(folder, id) {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(folder, id), 'utf8'));
    return s && typeof s === 'object' && s.task === id ? s : null;
  } catch {
    return null;
  }
}

/** Writes the state through a temp file and a rename, so a crash never leaves half a file. Fail open: never throws. */
function writeState(folder, state) {
  const file = stateFile(folder, state.task);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(tmp, `${JSON.stringify({ ...state, updated: new Date().toISOString() }, null, 2)}\n`);
    renameWithRetry(tmp, file);
    return true;
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* nothing more to do */
    }
    return false;
  }
}

function clearState(folder, id) {
  try {
    fs.rmSync(stateFile(folder, id), { force: true });
  } catch {
    /* fail open */
  }
}

/** The steps of `plan` that are still to run: never `merge` (resume continues after it) and never one that is done. */
function remainingSteps(plan, done = []) {
  const ran = new Set(done);
  return plan.filter((s) => s !== 'merge' && !ran.has(s));
}

/**
 * The steps before `step` in `order`, added to `done` (a step that the flow went past has succeeded: executeMerge
 * stops at the first error). `done` keeps its own order first. `step` null marks every step in `order`.
 */
function markBefore(order, done, step) {
  const out = [...done];
  for (const s of order) {
    if (s === step) break;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

module.exports = {
  MAX_AGE_MS,
  lockFile,
  legacyFile,
  pidAlive,
  staleReason,
  acquire,
  release,
  heldMessage,
  IN_PROGRESS,
  gitInProgress,
  inProgressMessage,
  stateFile,
  readState,
  writeState,
  clearState,
  remainingSteps,
  markBefore,
};
