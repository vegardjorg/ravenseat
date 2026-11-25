// =============================================================
// gitShow.js: read one file at a commit (`git show <rev>:<path>`) and tell "not there" from "git failed".
//
// Why: receive read files at a commit with a git helper that turned every failure into null. A bad object, a time-out
// or any other git error then read exactly like "this file does not exist at that commit": a test file emptied of its
// assertions, a changed manifest or a file for the review package could vanish from the checks without a word.
// So a failed `git show` is asked once more, in a way that does not depend on git's (translated) error text:
// `git ls-tree --full-tree --name-only <rev> -- <path>` succeeds with no output when the commit is fine and the path is
// not in it. Only that answer is "missing" (null). Anything else (ls-tree fails too, or lists the path, or the show
// timed out) is a GitReadError with a short reason, which the caller shows as an error, never as missing.
// The second git call runs only after a failure, so a normal receive makes no extra git calls.
//
// No setting: telling the two apart is a bug fix with no friction.
// Pure except defaultRun. Tested in lib/__tests__/gitShow.test.ts.
// =============================================================
'use strict';

const { spawnSync } = require('node:child_process');

/** A read at a commit that failed for another reason than a missing path. */
class GitReadError extends Error {
  constructor(rev, filePath, reason) {
    super(`git could not read ${filePath} at ${String(rev).slice(0, 12)}: ${reason}`);
    this.name = 'GitReadError';
    this.rev = rev;
    this.path = filePath;
    this.reason = reason;
  }
}

/** The time limit of one git call here: a stalled git is an error, never a hang (ARK-1 time limits). */
const TIMEOUT_MS = 60000;

/**
 * Runs git and returns { status, stdout, stderr, timedOut }. Never throws.
 * @param {string[]} args
 * @param {{ cwd?: string, buffer?: boolean }} [o]
 */
function defaultRun(args, { cwd, buffer = false } = {}) {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd,
    encoding: buffer ? 'buffer' : 'utf8',
    maxBuffer: 1 << 28,
    timeout: TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr == null ? '' : String(r.stderr),
    timedOut: r.error?.code === 'ETIMEDOUT',
    spawnError: r.error && r.error.code !== 'ETIMEDOUT' ? String(r.error.code ?? r.error.message) : null,
  };
}

/** The first line of git's stderr, short. */
const firstLine = (s) => String(s ?? '').split(/\r?\n/).find((l) => l.trim())?.trim().slice(0, 200) ?? '';

/**
 * The file's content at `rev` (a string, or a Buffer with buffer), null when the commit is readable and the path is not
 * in it, and a thrown GitReadError for every other failure.
 * @param {string} rev a commit, branch or tree-ish
 * @param {string} filePath a repository-relative path with forward slashes
 * @param {{ cwd?: string, buffer?: boolean, run?: typeof defaultRun }} [o] run is for the tests
 */
function showAt(rev, filePath, { cwd, buffer = false, run = defaultRun } = {}) {
  if (!rev) throw new GitReadError(rev ?? '', filePath, 'no commit given');
  const shown = run(['show', `${rev}:${filePath}`], { cwd, buffer });
  if (shown.status === 0 && !shown.timedOut) return shown.stdout;
  if (shown.timedOut) throw new GitReadError(rev, filePath, `timed out after ${TIMEOUT_MS / 1000} s`);
  if (shown.spawnError) throw new GitReadError(rev, filePath, `git did not run (${shown.spawnError})`);
  // Is the commit fine and the path simply not in it? Asked without reading git's error text.
  const listed = run(['ls-tree', '--full-tree', '--name-only', String(rev), '--', filePath], { cwd });
  if (listed.status === 0 && !listed.timedOut && String(listed.stdout ?? '').trim() === '') return null;
  const why = firstLine(shown.stderr) || `git show exited with ${shown.status}`;
  throw new GitReadError(rev, filePath, why);
}

module.exports = { GitReadError, showAt, defaultRun, TIMEOUT_MS };
