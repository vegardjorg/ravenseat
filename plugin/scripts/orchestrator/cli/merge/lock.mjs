// =============================================================
// cli/merge/lock.mjs: the merge lock, the in-progress refusal and the resume helpers (lib/mergeLock.js): one
// ravenseat merge at a time per data folder, released however the process ends, the git markers of an unfinished merge,
// rebase, cherry-pick or revert, and the merge commit that brought a tip into the base.
//
// Why a module: the merge flow in steps (SPLIT-1, see cli/merge.mjs); the checks, the steps and the after-merge part all
// read these. Moved as it was: same output, exit codes and files.
//
// Used by: cli/merge/mergeChecks.mjs, cli/merge/mergeSteps.mjs, cli/merge/afterMerge.mjs.
// Tested in: lib/__tests__/mergeLock.test.ts, __tests__/queueMergeResume.test.ts, __tests__/redteam/rt07-interrupted.test.ts,
//   __tests__/redteam/mergeTipLock.test.ts.
// =============================================================

import path from 'node:path';

import { CLI, die, FOLDER, git, GIT_ROOT, require } from '../context.mjs';

// ---- The merge lock, the in-progress refusal and the resume (lib/mergeLock.js) -------------------------------------

export const ML = require('./lib/mergeLock.js');

/** True when `ancestor` is in the history of `ref` (git merge-base --is-ancestor). */
export const containsCommit = (ancestor, ref) =>
  !!ancestor && !!ref && git(['merge-base', '--is-ancestor', ancestor, ref]) !== null;

/**
 * The absolute paths of files in the main checkout's git directory, from ONE `git rev-parse --git-path a --git-path b ...`
 * (one line per name, in order). A path, not whether the file exists, so the answer is kept for the process
 * (lib/gitFacts.js) and gitInProgress asks git once, not once per marker. A name maps to null when git failed.
 */
const gitPaths = (names) => {
  const out = git(['rev-parse', ...names.flatMap((n) => ['--git-path', n])]);
  const found = out == null ? [] : out.split(/\r?\n/).map((l) => l.trim());
  return new Map(names.map((n, i) => [n, found[i] ? path.resolve(GIT_ROOT, found[i]) : null]));
};
const MARKERS = ML.IN_PROGRESS.map((x) => x.marker);
/** The absolute path of a file in the main checkout's git directory (MERGE_HEAD, rebase-merge, ...). */
export const gitPathOf = (name) => gitPaths(MARKERS.includes(name) ? MARKERS : [name]).get(name) ?? null;

/**
 * The merge commit that brought `tip` into `base`: the first commit on base's first-parent line that descends from
 * the tip (a merge done by ravenseat merge, by hand or a fast-forward). null when the tip is not in base.
 */
export function mergeCommitFor(tip, base) {
  if (!containsCommit(tip, `refs/heads/${base}`)) return null;
  const list = git(['rev-list', '--first-parent', '--ancestry-path', '--reverse', `${tip}..refs/heads/${base}`]);
  const first = (list ?? '').split(/\r?\n/).filter(Boolean)[0];
  // Nothing on the line after the tip: base IS the tip (a fast-forward, or the branch was reset onto base).
  return first ?? tip;
}

/**
 * Takes the merge lock (one ravenseat merge at a time per data folder) and makes sure it is released however the process ends:
 * a normal end, die()/process.exit (the 'exit' handler), an uncaught error (also 'exit') and Ctrl-C or a kill
 * (the signal handlers, which also record the interruption in the merge state). A hard crash (power, kill -9) leaves
 * the lock behind; the next merge sees that its pid is gone and takes it over.
 */
export function takeMergeLock(id, { resume }) {
  const got = ML.acquire(FOLDER, { task: id, command: resume ? 'merge --resume' : 'merge' });
  if (!got.ok) die(ML.heldMessage({ file: got.file, holder: got.holder, ravenseat: CLI, id }));
  if (got.tookOver) {
    const h = got.tookOver.holder;
    console.log(
      `NB: took over a stale merge lock (${h?.command ?? 'merge'} ${h?.task ?? '?'}: ${got.tookOver.reason}).` +
        `${h?.task ? ` If that merge was cut off, ${CLI} merge ${h.task} --resume finishes it.` : ''}`,
    );
  }
  const ctl = { lock: got.lock, released: false, onSignal: null };
  ctl.release = () => {
    if (ctl.released) return;
    ctl.released = true;
    try {
      ML.release(FOLDER, ctl.lock);
    } catch {
      /* a lock that cannot be removed is taken over as stale by the next merge (the pid is gone) */
    }
  };
  process.on('exit', ctl.release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    try {
      process.on(sig, () => {
        if (ctl.onSignal) ctl.onSignal(sig);
        ctl.release();
        process.exit(130);
      });
    } catch {
      /* a signal this platform does not have */
    }
  }
  return ctl;
}

/** Ctrl-C reached the child of a step: a signal on POSIX, STATUS_CONTROL_C_EXIT (0xC000013A) on Windows. */
export const interruptedBy = (s) =>
  s.signal && ['SIGINT', 'SIGTERM', 'SIGHUP'].includes(s.signal) ? s.signal : s.status === 3221225786 ? 'Ctrl-C' : null;
