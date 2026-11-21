// =============================================================
// gitFacts.js: a small per-process memo for git answers that cannot change while one command runs.
//
// Why: every git call is a new process. On Windows that costs about 35 ms each, and one `ravenseat merge` made about 66
// of them, many of them the same path question asked again (`rev-parse --git-dir --git-common-dir` three times in one
// gates.mjs run, the main checkout from `git worktree list` four times in one merge). Asking once per process makes
// every command faster for Windows users and the test suite shorter, with the same answers.
//
// What is kept: only path facts, the questions "where is this repository": `rev-parse` with --show-toplevel, --git-dir,
// --git-common-dir, --absolute-git-dir, --show-cdup, --show-prefix, --is-inside-work-tree, --is-inside-git-dir,
// --is-bare-repository, --path-format=..., and --git-path <name> (never --git-path hooks: core.hooksPath moves it, and a
// gate run can change config). Plus facts a caller derives from those (remember(), e.g. the main checkout's folder).
// What is NEVER kept: refs, HEAD, status, diff, merge-base, branch lists, config, the hooks folder, or anything else a
// command or a gate run can change. Those always run git.
//
// Lifetime: one process (a module-level Map, gone when the process ends; nothing on disk). The key is the resolved cwd,
// the git variables that move a repository (GIT_DIR and friends) and the exact arguments. Only a successful answer is
// kept, so a failure is asked again. A hit also needs the cwd to exist still (a worktree removed by a child process).
// invalidate() empties it all: run() does that after a git command that can change where things are (init, clone,
// worktree, checkout, switch, submodule, a config write), and code that changes the layout another way calls it itself.
//
// No setting: the answers are the same as without the memo, so there is nothing to turn off (a stale answer would be a
// bug to fix, not a choice).
//
// Pure except the memo itself and the existence check. Tested in lib/__tests__/gitFacts.test.ts; the git-call budget of
// one merge in __tests__/gitCallBudget.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** rev-parse options that only ask where the repository and its folders are. */
const PATH_FLAGS = new Set([
  '--show-toplevel', '--git-dir', '--git-common-dir', '--absolute-git-dir', '--show-cdup', '--show-prefix',
  '--is-inside-work-tree', '--is-inside-git-dir', '--is-bare-repository', '--path-format=absolute', '--path-format=relative',
]);

/** The environment variables that change which repository git finds, or where its files are. Part of the key. */
const GIT_ENV = ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM',
  'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY'];

/** git subcommands after which a kept answer may be wrong (a new or removed repository or worktree). */
const LAYOUT_COMMANDS = new Set(['init', 'clone', 'worktree', 'checkout', 'switch', 'submodule']);

/** git's global options that take the next argument as their value. */
const GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);

/** `git config` options and subcommands that only read. Anything else counts as a write. */
const CONFIG_READS = new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatch', '--get-color', '--get-colorbool',
  '--list', '-l', 'get', 'list']);

const cache = new Map();

/**
 * Is this a pure path question (arguments after `git`, without global options)? Pure.
 * @param {string[]} args e.g. ['rev-parse', '--git-dir', '--git-common-dir']
 */
function isFactQuery(args) {
  if (!Array.isArray(args) || args[0] !== 'rev-parse' || args.length < 2) return false;
  for (let i = 1; i < args.length; i++) {
    const a = String(args[i]);
    if (PATH_FLAGS.has(a)) continue;
    if (a === '--git-path') {
      const name = String(args[i + 1] ?? '');
      // hooks follows core.hooksPath (config a gate run can change); an empty or missing name is git's error to give.
      if (!name || /^hooks(\/|\\|$)/i.test(name)) return false;
      i++;
      continue;
    }
    return false;
  }
  return true;
}

/** The subcommand of a git argument list, after the global options; null when there is none. Pure. */
function subcommandOf(args) {
  const list = Array.isArray(args) ? args.map(String) : [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (GLOBAL_WITH_VALUE.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith('-')) continue;
    return { sub: a, rest: list.slice(i + 1) };
  }
  return null;
}

/** Can this git command change a kept answer (a layout command, or a config write)? Pure. */
function changesFacts(args) {
  const s = subcommandOf(args);
  if (!s) return false;
  if (LAYOUT_COMMANDS.has(s.sub)) return true;
  if (s.sub === 'config') return !s.rest.some((a) => CONFIG_READS.has(a));
  return false;
}

/** The memo key: the resolved cwd, the git variables in this process's environment and the parts. */
function keyOf(cwd, parts) {
  const env = GIT_ENV.map((k) => process.env[k] ?? null);
  return JSON.stringify([path.resolve(String(cwd ?? '.')), env, parts]);
}

/**
 * The kept answer for (cwd, parts), or compute() once and keep it when it is not null/undefined. A hit needs cwd to
 * exist still; otherwise the entry goes and compute() runs.
 * @template T
 * @param {string} cwd
 * @param {unknown[]} parts what identifies the question (the git arguments, or a name for a derived fact)
 * @param {() => T} compute
 * @returns {T}
 */
function remember(cwd, parts, compute) {
  const key = keyOf(cwd, parts);
  if (cache.has(key)) {
    if (fs.existsSync(path.resolve(String(cwd ?? '.')))) return cache.get(key);
    cache.delete(key);
  }
  const value = compute();
  if (value !== null && value !== undefined) cache.set(key, value);
  return value;
}

/**
 * Runs one git command through `exec(args)`: a path question comes from the memo when it was asked before in this
 * process; a command that can change the layout empties the memo after it ran. Everything else just runs.
 * @param {string} cwd the folder git runs in (part of the key)
 * @param {string[]} args the arguments after `git` and the caller's own global options
 * @param {(args: string[]) => any} exec the caller's runner (its return value is what is kept)
 */
function run(cwd, args, exec) {
  if (isFactQuery(args)) return remember(cwd, ['git', ...args], () => exec(args));
  try {
    return exec(args);
  } finally {
    if (changesFacts(args)) invalidate();
  }
}

/** Forgets every kept answer (after a worktree add or remove, a git init, a checkout or a config write). */
function invalidate() {
  cache.clear();
}

/** How many answers are kept (for the tests). */
const size = () => cache.size;

module.exports = { isFactQuery, subcommandOf, changesFacts, remember, run, invalidate, size };
