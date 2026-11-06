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
//     (the lock file merge.lock, with pid, host and start time).
//
// THE LOCK: created with the `wx` flag (exclusive create: only one process can create the file). A lock is stale when
// the process that holds it is gone (same host, the pid no longer runs) or when it is older than maxAgeMs (any host:
// a pid can be reused, and a pid on another machine cannot be checked). A stale lock is taken over: it is first
// renamed to a unique name (only one process can rename the same file), the renamed content is compared with what
// was judged stale, and only then is a new lock created. A lock is only removed by the process that holds it.
//
// No I/O beyond the data folder and the lock and state files; git is reached through a `gitPath` callback, so the
// rules can be tested without a repo.
//
// Used by: cli/merge.mjs (cmdMerge). Tested in: lib/__tests__/mergeLock.test.ts, __tests__/queueMergeResume.test.ts.
// =============================================================

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** A merge with slow gates and a migration push can run for a long time; a lock older than this is stale anyway. */
const MAX_AGE_MS = 6 * 60 * 60 * 1000;

const LOCK_NAME = 'merge.lock';

/** The lock file in the data folder. */
function lockFile(folder) {
  return path.join(folder, LOCK_NAME);
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
  const lock = { pid, host, started: new Date(now).toISOString(), task, command };
  let tookOver = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.writeFileSync(file, `${JSON.stringify(lock, null, 2)}\n`, { flag: 'wx' });
      return { ok: true, file, lock, tookOver };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    const seen = readLock(file);
    if (seen.missing) continue; // released between the two calls: try again
    const reason = staleReason(seen.holder, { now, host, alive, maxAgeMs, mtimeMs: seen.mtimeMs });
    if (!reason) return { ok: false, file, holder: seen.holder };
    // Take the stale lock over: rename it away (atomic; a second process taking it over at the same time gets ENOENT),
    // then check that what was renamed is the lock that was judged stale and not a fresh one created in between.
    const aside = `${file}.stale-${pid}-${now}-${attempt}`;
    try {
      fs.renameSync(file, aside);
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
    let moved = null;
    try {
      moved = fs.readFileSync(aside, 'utf8');
    } catch {
      /* read below as different */
    }
    if (moved !== seen.text) {
      // Someone else's fresh lock: put it back (it is theirs) and report it as held.
      try {
        fs.renameSync(aside, file);
      } catch {
        /* they released it in the meantime */
      }
      const back = readLock(file);
      return { ok: false, file, holder: back.holder ?? null };
    }
    fs.rmSync(aside, { force: true });
    tookOver = { holder: seen.holder, reason };
  }
  const last = readLock(file);
  return { ok: false, file, holder: last.holder ?? null };
}

/** Removes the lock, but only when it is still the one this process took (same pid, host and start time). */
function release(folder, lock) {
  if (!lock) return false;
  const file = lockFile(folder);
  const seen = readLock(file);
  if (seen.missing || !seen.holder) return false;
  const h = seen.holder;
  if (h.pid !== lock.pid || h.host !== lock.host || h.started !== lock.started) return false;
  fs.rmSync(file, { force: true });
  return true;
}

/** The message when another merge holds the lock. */
function heldMessage({ file, holder, ravenseat = 'ravenseat', id }) {
  const who = holder
    ? `${holder.command ?? 'merge'} ${holder.task ?? '?'} (pid ${holder.pid ?? '?'} on ${holder.host ?? '?'}, started ${holder.started ?? '?'})`
    : 'another process (the lock file cannot be read)';
  return (
    `Another ${ravenseat} merge is running in this repo: ${who}. One merge at a time; nothing was done.\n` +
    `Wait for it to finish, then run ${ravenseat} merge ${id} again. If you are sure no merge is running (the process is ` +
    `gone and the lock was not taken over automatically, for example a merge on another machine), delete ${file}.`
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
    fs.renameSync(tmp, file);
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
  pidAlive,
  staleReason,
  acquire,
  release,
  heldMessage,
  gitInProgress,
  inProgressMessage,
  stateFile,
  readState,
  writeState,
  clearState,
  remainingSteps,
  markBefore,
};
