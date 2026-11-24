// =============================================================
// cli/undo.mjs: `ravenseat undo <id>` (GS-3): take a merged task back out of the base branch with one new revert commit.
//
// The rules (which merge, what is shown, when it is refused, the texts, the task back to waiting) are pure functions in
// lib/undoMerge.js; here is the I/O, in this order:
//   1. refused outside the main session (a track's queue branch, a linked worktree), before anything else;
//   2. the git hooks and config against the accepted baseline (lib/gitSurfaceBaseline.js), as merge does: git commit
//      runs the hooks;
//   3. the merge lock (lib/mergeLock.js): one merge or undo at a time, and never while a merge (with its gates and base
//      gate) runs;
//   4. the facts (branch, dirty tree, a git operation in progress, a merge cut off, the merge commit, the later work) and
//      the refusal; the plan; --dry stops here;
//   5. y/N (--yes for scripts; no terminal and no --yes: nothing is done);
//   6. `git revert -m 1 --no-commit` and `git commit -F -` in the main checkout (a conflict or a failing hook:
//      `git revert --abort`, nothing changed); the task back to waiting; one time log row;
//   7. the base gate on the new tip, as after a merge (cli/baseHealth.mjs): red records red, adds the base fix task and
//      exits 9, so the base freezes like any other red.
// Never force, never reset, never push. A queue agent never gets here: the push guard denies it every queue command
// outside its short list (lib/pushGuard.js AGENT_QUEUE_COMMANDS).
//
// Used by: queue.mjs (dispatch: `undo` with a task id; bare `undo` stays the changelog undo in cli/taskEdit.mjs).
// Tested in: __tests__/queueUndoMerge.test.ts (temporary repos), lib/__tests__/undoMerge.test.ts.
// =============================================================

import path from 'node:path';
import readline from 'node:readline/promises';
import { spawnSync } from 'node:child_process';

import {
  a, BASE, byName, CLI, die, edit, FOLDER, git, GIT_ROOT, MAIN_TREE, positional, PREFIX, queueBranchId, read, require, ROOT,
} from './context.mjs';
import { logTime } from './tracks.mjs';
import { BASE_SETUP, BH, readHealth, recordVerdict, redLines, runCheckNow } from './baseHealth.mjs';

const UM = require('./lib/undoMerge.js');
const ML = require('./lib/mergeLock.js');
const GB = require('./lib/gitSurfaceBaseline.js');

const short = (sha) => String(sha ?? '').slice(0, 12);
const norm = (p) => {
  const r = path.resolve(String(p)).replace(/\\/g, '/');
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

/** git in the main checkout with the exit code and both outputs (git() in context.mjs only gives stdout or null). */
function gitRun(args, input = undefined) {
  const r = spawnSync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd: GIT_ROOT,
    encoding: 'utf8',
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
  return { code: r.status ?? 1, out: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
}

/** The absolute path of a marker file in the main checkout's git directory (MERGE_HEAD, REVERT_HEAD, ...), or null. */
function gitPathOf(name) {
  const p = git(['rev-parse', '--git-path', name]);
  return p ? path.resolve(GIT_ROOT, p) : null;
}

/**
 * The files each commit on the base's first-parent line after `sha` changed against its first parent, in ONE git call
 * (a task merged long ago would otherwise cost one call per later commit).
 * @returns {Map<string, string[]>}
 */
function laterFiles(sha) {
  const out = git(['log', '--first-parent', '--diff-merges=first-parent', '--name-only', '--format=%x1e%H', `${sha}..refs/heads/${BASE}`]);
  const map = new Map();
  for (const block of String(out ?? '').split('\x1e')) {
    const [head, ...rest] = block.split(/\r?\n/);
    if (head?.trim()) map.set(head.trim(), rest.map((l) => l.trim()).filter(Boolean));
  }
  return map;
}

/** Holds the merge lock for this process; it goes on any exit (die, process.exit, Ctrl-C). */
function takeLock(id) {
  const got = ML.acquire(FOLDER, { task: id, command: 'undo' });
  if (!got.ok) {
    const h = got.holder;
    die(
      `${CLI} undo ${id}: ${h ? `${h.command ?? 'merge'} ${h.task ?? '?'} is running (pid ${h.pid ?? '?'} on ${h.host ?? '?'}, started ${h.started ?? '?'})` : 'another merge is running (the lock file cannot be read)'}. ` +
        `One merge or undo at a time: wait for it, then run ${CLI} undo ${id} again. If no merge runs, delete ${got.file}. Nothing was done.`,
    );
  }
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      ML.release(FOLDER, got.lock);
    } catch {
      /* a lock that cannot be removed is taken over as stale by the next merge (the pid is gone) */
    }
  };
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    try {
      process.on(sig, () => {
        release();
        process.exit(130);
      });
    } catch {
      /* a signal this platform does not have */
    }
  }
}

/** y/N on a terminal. True only for y or yes. */
async function askYes(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^(y|yes)$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

/**
 * Bare `ravenseat undo` (the changelog undo, cli/taskEdit.mjs cmdUndo). One word does two things, so the text form
 * first says which undo this is and points to `undo <id>` (lib/cliHelp.js undoHint); --json (the board) stays one
 * JSON object.
 */
export async function cmdUndoLast() {
  if (!a.includes('--json')) console.log(require('./lib/cliHelp.js').undoHint(CLI));
  (await import('./taskEdit.mjs')).cmdUndo();
}

/** `ravenseat undo <id> [--dry] [--yes]` (the usage is at the top of queue.mjs). */
export async function cmdUndoMerge() {
  const id = positional(1)[0];
  const dry = a.includes('--dry');
  const yes = a.includes('--yes');
  const o0 = read().tasks.find((x) => x.id === id);
  if (!o0) die(`Unknown task ${id}`);

  // 1. Only the main session, in the main checkout.
  const where = UM.whereRefusal({ id, inTrack: queueBranchId(), inWorktree: norm(ROOT) !== norm(MAIN_TREE), ravenseat: CLI });
  if (where) die(where);

  // 2. git commit runs the hooks: the same stop as merge on hooks or config that are not the accepted ones.
  if (!GB.ensure(FOLDER, GIT_ROOT)) {
    const detail = GB.stopDetail(FOLDER, GIT_ROOT, { ravenseat: CLI });
    if (detail) die(GB.driftMessage({ ...detail, ravenseat: CLI, again: `${CLI} undo ${id}` }));
  }

  // 3. One merge or undo at a time.
  takeLock(id);

  // 4. The facts, the refusal and the plan.
  const o = read().tasks.find((x) => x.id === id) ?? o0;
  const head = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const dirty = String(git(['status', '--porcelain', '--untracked-files=no']) ?? '')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => l.slice(3));
  // A log git could not give is said as such, never read as an empty history ("merge not found"; ARK-1 T2).
  const log = git(['log', '--first-parent', `--format=${UM.LOG_FORMAT}`, `refs/heads/${BASE}`]);
  if (log == null)
    die(
      `${CLI} undo ${id}: could not read the history of ${BASE} (git log failed or printed more than 256 MB), so the merge ` +
        `cannot be looked up. Nothing was done. Check it with git log --first-parent ${BASE}, then run ${CLI} undo ${id} again.`,
    );
  const rows = UM.parseLog(log);
  const found = UM.findMerge({ id, recorded: o.merge_commit ?? null, rows, prefix: PREFIX });
  const inBase = !!found && git(['merge-base', '--is-ancestor', found.sha, `refs/heads/${BASE}`]) !== null;
  const parents = found?.index >= 0 ? rows[found.index].parents.length : 0;
  const refused = UM.refusal({
    id, base: BASE, root: GIT_ROOT, ravenseat: CLI, head, dirty,
    inProgress: ML.gitInProgress(gitPathOf),
    cutOff: !!ML.readState(FOLDER, id),
    status: o.status, found, inBase, parents,
    alreadyUndone: found ? UM.alreadyUndone(o, found.sha) : null,
  });
  if (refused) die(refused);

  const sha = found.sha;
  const row = rows[found.index];
  const files = String(git(['diff', '--name-only', row.parents[0], sha]) ?? '').split(/\r?\n/).filter(Boolean);
  const byFile = laterFiles(sha);
  const tasks = read().tasks;
  const later = UM.laterWork({ rows, index: found.index, id, prefix: PREFIX, filesOf: (r) => byFile.get(r.sha) ?? [], ownFiles: files, tasks });
  const waiting = UM.waitingOn(tasks, id);
  for (const l of UM.planLines({ id, sha, subject: row.subject, source: found.source, base: BASE, files, later, waiting, baseGate: BASE_SETUP.enabled }))
    console.log(l);
  if (dry) {
    console.log('--dry: nothing was done.');
    return;
  }

  // 5. The question.
  if (!yes) {
    if (!process.stdin.isTTY) die(`There is no terminal to ask in: add --yes to undo ${id}. Nothing was done.`);
    if (!(await askYes(`Undo ${id}?`))) {
      console.log('Nothing was done.');
      return;
    }
  }

  // 6. The revert, as one new commit.
  const oldTip = git(['rev-parse', `refs/heads/${BASE}`]);
  const rv = gitRun(['revert', '-m', '1', '--no-commit', sha]);
  if (rv.code !== 0) {
    const conflicted = String(git(['diff', '--name-only', '--diff-filter=U']) ?? '').split(/\r?\n/).filter(Boolean);
    const aborted = gitRun(['revert', '--abort']).code === 0;
    die(UM.conflictLines({ id, sha, files: conflicted, root: GIT_ROOT, aborted }).join('\n'));
  }
  if (gitRun(['diff', '--cached', '--quiet']).code === 0) {
    gitRun(['revert', '--abort']);
    die(
      `${CLI} undo ${id}: reverting ${short(sha)} changes nothing: its changes are already gone from ${BASE} (undone by hand?). ` +
        `Set the task back yourself if that is right: ${CLI} set ${id} waiting --remark "undone by hand". Nothing was done.`,
    );
  }
  const commit = gitRun(['commit', '-q', '-F', '-'], UM.commitMessage({ id, sha, subject: row.subject }));
  if (commit.code !== 0) {
    const aborted = gitRun(['revert', '--abort']).code === 0;
    die(
      `${CLI} undo ${id}: git commit failed (a commit hook?):\n${commit.out.split(/\r?\n/).slice(-15).join('\n')}\n` +
        (aborted ? 'The revert was aborted (git revert --abort). Nothing was done.' : `git revert --abort failed too: check ${GIT_ROOT} with git status.`),
    );
  }
  const revert = git(['rev-parse', 'HEAD']);
  const at = new Date().toISOString();
  edit((queue) => {
    const t = queue.tasks.find((x) => x.id === id);
    if (t) UM.reopen(t, { at, merge: sha, revert, by: byName() });
  });
  logTime(id, 'undone', `merge ${short(sha)} reverted by ${short(revert)}`);
  console.log(
    `Undone ${id}: merge ${short(sha)} reverted by ${short(revert)} on ${BASE} (a local commit, not pushed: it goes with the next batch push). ` +
      `${id} is waiting again. To bring the work back: git revert ${short(revert)}.`,
  );

  // 7. The base gate on the new tip, as after a merge.
  if (!BASE_SETUP.enabled) return;
  const state = readHealth();
  const wasRed = BH.verdict(state, oldTip) === 'red' ? state.current : null;
  const check = runCheckNow({ tip: revert, folder: FOLDER, cause: { task: id, merge_commit: revert } });
  if (check.run.tampered)
    die(GB.tamperedMessage({ what: 'the base check after the undo', reason: check.run.tampered, ravenseat: CLI, again: `${CLI} doctor` }));
  const v = recordVerdict({ tip: revert, ok: check.run.ok, run: check.run, file: check.file, causeId: id, wasRed, note: `after ${CLI} undo ${id}` });
  if (!check.run.ok) {
    for (const l of redLines({ entry: v.entry, run: check.run, fix: v.fix, causeId: id, undo: true })) console.log(l);
    process.exit(BH.EXIT_RED_BASE);
  }
  console.log(`BASE GREEN: ${BASE} at ${short(revert)}.`);
  if (v.openFix) console.log(v.openFix);
}
