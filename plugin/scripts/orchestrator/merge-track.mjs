#!/usr/bin/env node
// =============================================================
// merge-track.mjs: merges one track branch into baseBranch (config().baseBranch) and resolves the most common conflicts
// automatically. See docs/orchestration.md.
//
// WHY: when several tracks work in parallel, they often add blocks at the end of the same files (registries, lists,
// translations, test lists). Git sees two insertions at the same place as a conflict, and the sides often share lines (a
// closing "}" or "];"). Resolving this by hand per track is slow and error prone: conflict markers
// get committed, or a missing comma joins two strings together.
//
// HOW: git merges first. For each file in conflict the script does its OWN three-way merge from base (:1:), HEAD (:2:)
// and branch (:3:), instead of cutting in git's markers:
//   * text files: the changes from each side against base (git diff -U0) are applied to base.
//       - changes in different places: both are included
//       - insertions at the same place: HEAD's first, then the branch's
//       - the same base lines changed identically on both sides (for example a comma added to the previous element): the
//         changed lines once, then the rest from HEAD, then the rest from the branch
//       - otherwise: a real conflict, resolved by hand
//     In SQL and JS/TS a missing comma is inserted where HEAD's block ends with list values and the branch's block
//     starts with a new one.
//   * translation files (JSON under a locales/ folder): the HEAD text, plus top-level keys the branch has added, inserted
//     verbatim. Checked three-way against base.
//
// AFTERWARDS the affected files are validated: no conflict markers, JSON parses, `node --check` on JS, and in SQL files that
// were merged automatically: list values or tuples without a comma before a new one. If everything is green, the merge is
// committed. Otherwise the merge is left in place (git merge --abort to undo), and the script says what must be resolved by
// hand. The project's own gates (gates.mjs) are run by `queue.mjs merge` after this script, not here.
//
// BEFORE the merge: the guard check (lib/mergeGuard.js). If the branch touches a protected path (config().protectedPaths:
// .claude/, the orchestrator scripts, hooks, agents, queue.config.json, package.json and so on) that the task does not
// own in queue.json, the merge stops (exit 4). Other files outside the ownership only give a warning.
//
// With migrations turned on (config().migrations.folder) it also reports SQL functions that the branch rewrites entirely
// (create or replace) and that another track in the same wave has also rewritten. Then the one with the highest
// migration number wins, and the other's change silently disappears.
//
// THE TIP: what is merged is one commit, never "whatever the branch points at by then". With --tip <sha> (ravenseat merge
// passes the tip its checks ran on: the red gate at receive, the done command, the focus markers) the branch must still
// point there, or nothing is merged (exit 6): a commit that landed after the checks has had no receive and no review.
// Without --tip the tip is read once at the start. The guard, the trial merge and `git merge` all use that sha, and the
// merge commit must have it as its second parent (review 2026-11-11, G2).
//
// THE TRIAL MERGE before the real one (git >= 2.38): `git merge-tree --write-tree HEAD <sha>` writes objects only, never
// the index, the checkout or a ref. Each conflicting file it names goes through the same text merge as below, in memory.
// A file that would have to be resolved by hand stops the merge BEFORE git touches the checkout, so a conflict never
// leaves the main tree in the middle of a merge (review 2026-11-11, V2). An older git keeps the old way (with a note):
// the merge is then left in place for such a file.
//
// AFTER a successful merge the track worktree is cleaned up (cleanup-worktree.mjs: the links are removed as links, then
// `git worktree remove` without --force). The branch is kept here (`ravenseat merge` deletes a merged queue branch at the very end). The cleanup is best effort: it never turns a successful merge
// into exit ≠ 0, and locked, dirty or unmerged worktrees are left alone.
//
// USE:
//   node scripts/orchestrator/merge-track.mjs <branch> [--tip <sha>] [--wave-base <sha>] [--without-commit]
//                                             [--keep-worktree] [--allow-guard]
//     --tip <sha>        the commit of the branch that was checked; it is what is merged, and a branch that has moved
//                        since stops the merge (exit 6)
//     --wave-base <sha>  the base branch commit the wave started from (for the check of functions rewritten by several tracks)
//     --without-commit       resolve and validate, but do not commit (the merge is left in place)
//     --keep-worktree   do not clean up the track worktree after the merge
//     --allow-guard     merge even if the branch touches protected paths it does not own (logged as "guard-overridden"
//                       in the time log). Without it: exit 4 BEFORE the merge, with the list.
//   Exit: 0 merged, 1 merge or validation failed, 2 usage or no diff, 3 identity guard, 4 merge guard,
//         5 a merge, rebase, cherry-pick or revert is already in progress in the checkout (nothing was merged),
//         6 the branch moved after the checks (--tip; nothing was merged).
// NB: never use String.replace with a replacement text that may contain "$" (patterns such as $& are interpreted); build with slice.
// =============================================================

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { cleanupWorktree } from './cleanup-worktree.mjs';

const require = createRequire(import.meta.url);
const { config } = require('./lib/queueConfig.js');
const CLI = require('./lib/projectRoot.js').cliCommand();
const K = config();

const args = process.argv.slice(2);
const val = (n) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const waveBase = val('--wave-base');
const tipArg = val('--tip');
const branch = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--wave-base' && args[i - 1] !== '--tip');
const WITHOUT_COMMIT = args.includes('--without-commit');
const KEEP_WORKTREE = args.includes('--keep-worktree');
const ALLOW_GUARD = args.includes('--allow-guard');
if (!branch) {
  console.error(
    `Use: ${CLI} merge-track <branch> [--tip <sha>] [--wave-base <sha>] [--without-commit] [--keep-worktree] [--allow-guard]`,
  );
  process.exit(2);
}

// Best-effort cleanup of the track worktree after a successful merge. One log line; an error here NEVER makes the merge
// fail (exit stays 0).
function cleanupAfterMerge() {
  if (KEEP_WORKTREE) {
    console.log('Worktree: kept (--keep-worktree).');
    return;
  }
  try {
    const r = cleanupWorktree(branch, { against: 'HEAD' });
    console.log(`Worktree: ${r.status}: ${r.message}`);
  } catch (e) {
    console.log(`Worktree: the cleanup failed, the merge stands: ${e.message}`);
  }
}

// core.quotepath=off: git gives a path with non-ASCII characters as it is, not quoted with octal escapes. Every path list
// below is read as plain paths (the guard, the conflicts, the staged and changed files; review 2026-11-11, S1).
const QUOTE_OFF = ['-c', 'core.quotepath=off'];
const git = (...a) => execFileSync('git', [...QUOTE_OFF, ...a], { encoding: 'utf8', maxBuffer: 256 << 20 });
const gitOk = (...a) => spawnSync('git', [...QUOTE_OFF, ...a], { encoding: 'utf8', maxBuffer: 256 << 20 });

// Identity guard BEFORE merge: merge commits must have the owner's real git identity. A test identity left behind
// in the repo config (for example from a test of this script) would otherwise end up in all merge commits.
// Tests for this script must use a temporary repo.
{
  const GI = require('./lib/gitIdentity.js');
  const { ident, refused } = GI.readIdentity();
  if (refused) {
    process.stderr.write(
      `The identity guard stopped the merge: the git identity looks like a test or is missing (${ident || 'none'}). ` +
        `Set it first: ${GI.IDENTITY_FIX}\n`,
    );
    process.exit(3);
  }
}

// An unfinished merge, rebase, cherry-pick or revert in this checkout BEFORE anything else (review 2026-11-02, M6):
// with MERGE_HEAD from an earlier conflict, `git merge <branch>` fails with "unmerged files", the conflict list is the
// earlier merge's files, and this script would resolve and commit THAT merge and report this branch as merged.
{
  const ML = require('./lib/mergeLock.js');
  const gitPath = (name) => {
    const r = spawnSync('git', ['rev-parse', '--git-path', name], { encoding: 'utf8' });
    return r.status === 0 && r.stdout.trim() ? path.resolve(r.stdout.trim()) : null;
  };
  const found = ML.gitInProgress(gitPath);
  if (found.length) {
    const tip = spawnSync('git', ['rev-parse', '-q', '--verify', `refs/heads/${branch}`], { encoding: 'utf8' });
    const own = (tip.stdout || '').trim();
    const lines = [];
    for (const x of found)
      lines.push(
        `A ${x.kind} is in progress in this checkout (${x.marker}${x.sha ? ` ${x.sha.slice(0, 12)}` : ''}` +
          `${x.sha && x.sha === own ? `, the tip of ${branch}` : ''}). Finish it (${x.finish}) or undo it (${x.undo}).`,
      );
    process.stderr.write(`${lines.join('\n')}\nNothing was merged.\n`);
    process.exit(5);
  }
}

// ---- The tip: the one commit this run merges (G2) ------------------------------------------------------------------
// Read once. Every git command below uses TIP, never the branch name, so a commit that lands on the branch while this
// script runs is not merged either. With --tip the branch must still be there: the checks ran on that commit.
const TIP = (() => {
  const sha = (ref) => {
    const r = gitOk('rev-parse', '-q', '--verify', `${ref}^{commit}`);
    return r.status === 0 ? r.stdout.trim() : null;
  };
  const now = sha(branch);
  if (!now) {
    console.error(`Not merged: ${branch} is not a branch or commit here.`);
    process.exit(2);
  }
  if (!tipArg) return now;
  const checked = sha(tipArg);
  if (!checked) {
    console.error(`Not merged: --tip ${tipArg} is not a commit here.`);
    process.exit(2);
  }
  if (checked === now) return checked;
  const newer = gitOk('log', '--oneline', '--no-decorate', '-n', '10', `${checked}..${now}`).stdout.trim();
  console.error(
    `Not merged: ${branch} moved after the checks. They ran on ${checked.slice(0, 12)}; the branch is now at ` +
      `${now.slice(0, 12)}.\n` +
      (newer
        ? `Commits that came after the checks:\n${newer.split('\n').map((l) => `  ${l}`).join('\n')}\n`
        : 'The branch was rewritten (the checked commit is not under its tip).\n') +
      `The new commits have had no receive and no review. Run ${CLI} receive <id> again (the gates and the review), ` +
      'then merge. Nothing was touched.',
  );
  process.exit(6);
})();
// The subject git itself would write for `git merge <branch>` (with the default merge.suppressDest): the branch name
// stays in it, so the queue still finds the task in the base's history (lib/logic/commits.js queueIdFromMerge).
const mergeMessage = (into) => `Merge branch '${branch}'${['main', 'master'].includes(into) ? '' : ` into ${into}`}`;

// Windows locks large files for a moment after git has written them (virus scanner or file watcher): the write gives
// UNKNOWN/EBUSY/EPERM. Try again a few times with a short pause before giving up.
function writeWithNewAttempt(file, text) {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.writeFileSync(file, text);
      return;
    } catch (e) {
      if (attempt >= 10 || !['UNKNOWN', 'EBUSY', 'EPERM', 'EACCES'].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500 * attempt);
    }
  }
}
// ---- 0) Guard check: protected paths need ownership ---------------------------------------------------------------
// Hooks, settings, agent definitions, orchestrator scripts, the queue config and package.json can only be changed by a
// task that owns the path (owned_files/shared_patch in queue.json). Otherwise the merge stops BEFORE it starts;
// --allow-guard overrides and is logged. The logic and the rules are in lib/mergeGuard.js, the list in
// config().protectedPaths. The diff is HEAD...<branch> (the branch's own changes since the fork point), so base branch
// commits merged into the branch are not counted as the track's.
{
  const G = require('./lib/mergeGuard.js');
  const { dataFolder, timeLog } = require('./lib/queueConfig.js');
  const id = G.taskIdFromBranch(branch, K.branchPrefix);
  let task = null;
  // The agent files of the custom helpers (ravenseat helpers add) are protected like .claude/, also when protectedPaths was
  // changed: a track cannot rewrite an approved helper without owning its file.
  let helperPaths = [];
  // Every task, for the ownership check: a file another active task owns stops the merge (lib/mergeGuard.js foreignOwners).
  let allTasks = [];
  try {
    const queue = JSON.parse(fs.readFileSync(path.join(dataFolder(), 'queue.json'), 'utf8'));
    const tasks = queue.tasks || [];
    allTasks = tasks;
    task = tasks.find((o) => o.branch === branch) ?? (id ? tasks.find((o) => o.id === id) : null) ?? null;
    const HELP = require('./lib/queueHelpers.js');
    helperPaths = HELP.customPaths(HELP.helperSetup(K, queue));
  } catch {
    // no queue here (a wave track or a test): empty ownership, so every protected path stops
  }
  const taskName = task?.id ?? id;
  // -z: NUL separated and never quoted, so a path with æøå, a tab or a quote reaches the guard as it is (lib/mergeGuard.js readDiff).
  const diff = gitOk('diff', '--name-status', '-z', '-M', `HEAD...${TIP}`);
  if (diff.status !== 0) {
    console.error(`Guard check: could not get the diff HEAD...${TIP.slice(0, 12)} (${branch}):\n${diff.stderr}`);
    process.exit(2);
  }
  const guard = G.assessGuard({
    changes: G.readDiff(diff.stdout),
    ownedFiles: task?.owned_files ?? [],
    sharedPatch: task?.shared_patch ?? [],
    migrBlock: task?.migr_block ?? null,
    migrations: K.migrations,
    protectedPaths: G.withPaths(Array.isArray(K.protectedPaths) ? K.protectedPaths : undefined, helperPaths),
    allowGuard: ALLOW_GUARD,
    dependencyFiles: K.dependencyFiles,
  });
  if (guard.warned.length > 0) {
    console.log(
      `WARNING dependency file(s) changed (${taskName ?? branch}): ${guard.warned.join(', ')}. They can run code on install ` +
        `and hold check settings, so read the diff (git diff HEAD...${branch} -- <path>). dependencyFiles: "stop" in ` +
        'queue.config.json makes this a stop.',
    );
  }
  if (guard.drift.length > 0) {
    console.log(
      `WARNING ownership drift (${taskName ?? branch}): ${guard.drift.length} file(s) outside owned_files + shared_patch:`,
    );
    for (const f of guard.drift.slice(0, 30)) console.log(`  ${f}`);
    if (guard.drift.length > 30) console.log(`  … and ${guard.drift.length - 30} more`);
  }
  // A queue task without owned_files merges freely, so the owner at least sees what it changed. A wave track has no task.
  if (task && guard.unlisted.length > 0) {
    console.log(`NOTE ${taskName}: no owned_files, and this merge changes ${guard.unlisted.length} file(s). Check that they fit the mission:`);
    for (const f of guard.unlisted.slice(0, 30)) console.log(`  ${f}`);
    if (guard.unlisted.length > 30) console.log(`  … and ${guard.unlisted.length - 30} more`);
  }
  if (guard.violations.length > 0) {
    const list = guard.violations.map((b) => `  ${b.path}  (${b.reason})`).join('\n');
    if (guard.stop) {
      console.error(
        `\nGUARD: ${branch} changes protected paths that the task${taskName ? ` ${taskName}` : ''} does not own:\n${list}\n\n` +
          'Hooks, settings, agents, orchestrator scripts, the queue config and package.json can run code with the owner\'s rights.\n' +
          'The test, lint and type configs (vitest.config.*, tsconfig*.json, pytest.ini …) can switch checks off.\n' +
          `Read the diff (git diff HEAD...${branch} -- <path>). If the change is intended: add the path to the task's\n` +
          'owned_files/shared_patch (locked after start: the owner, ravenseat edit <id> --json ... --by owner), or merge\n' +
          'with --allow-guard (logged as "guard-overridden"). Nothing was merged.',
      );
      process.exit(4);
    }
    console.log(`GUARD OVERRIDDEN (--allow-guard) for ${branch}:\n${list}`);
    try {
      fs.appendFileSync(
        timeLog(),
        `${JSON.stringify({
          time: new Date().toISOString(),
          wave: task ? 'queue' : null,
          track: taskName ?? branch,
          event: 'guard-overridden',
          branch,
          paths: guard.violations.map((b) => b.path),
        })}\n`,
      );
    } catch (e) {
      console.error(`  (could not log guard-overridden: ${e.message})`);
    }
  }
  // A file another active task owns (running, in review or picked): that task is building on it now, so the merge stops
  // here instead of going in with a warning. Same exit code and override as the protected paths.
  const foreign = G.foreignOwners(
    G.readDiff(diff.stdout).flatMap((e) => (e.status === 'C' ? e.paths.slice(1) : e.paths)),
    task,
    allTasks,
  );
  if (foreign.length > 0) {
    const list = foreign.map((f) => `  ${f.path}  (owned by ${f.owner})`).join('\n');
    if (!ALLOW_GUARD) {
      console.error(
        `\nOWNERSHIP: ${branch} changes file(s) that another active task owns:\n${list}\n\n` +
          'That task is building on them now, so this merge would change them under it. Read the diff\n' +
          `(git diff HEAD...${branch} -- <path>). Not intended: a fix round that leaves the file alone. Intended: merge\n` +
          'the owner task first, or move the path to this task (ravenseat edit <id> --json ... --by owner on both), or merge\n' +
          'with --allow-guard (logged as "guard-overridden"). Nothing was merged.',
      );
      process.exit(4);
    }
    console.log(`OWNERSHIP OVERRIDDEN (--allow-guard) for ${branch}:\n${list}`);
    try {
      fs.appendFileSync(
        timeLog(),
        `${JSON.stringify({
          time: new Date().toISOString(),
          wave: 'queue',
          track: taskName ?? branch,
          event: 'guard-overridden',
          branch,
          foreign,
        })}\n`,
      );
    } catch (e) {
      console.error(`  (could not log guard-overridden: ${e.message})`);
    }
  }
  // A hotspot (shared config: routes, registries, i18n, feature flags; `hotspots` in queue.config.json, lib/hotspots.js)
  // changed without the task's hotspot_patch: the change was not agreed, so the merge stops. Same exit code and override.
  const H = require('./lib/hotspots.js');
  const hot = H.unagreed(
    G.readDiff(diff.stdout).flatMap((e) => (e.status === 'C' ? e.paths.slice(1) : e.paths)),
    task,
    H.hotspotsOf(K),
  );
  if (hot.length > 0) {
    const list = hot.map((p) => `  ${p}`).join('\n');
    if (!ALLOW_GUARD) {
      console.error(
        `\nHOTSPOT: ${branch} changes shared config that was not agreed (hotspots in queue.config.json):\n${list}\n\n` +
          "Parallel tracks break each other on these files. The track's report should say what to add where (a wiring\n" +
          'spec); the orchestrator makes that change after the merge. Not intended: a fix round that leaves the file\n' +
          "alone. Agreed for this task: add the path to its hotspot_patch (ravenseat edit <id> --json ... --by owner; one\n" +
          'task at a time), or merge with --allow-guard (logged as "guard-overridden"). Nothing was merged.',
      );
      process.exit(4);
    }
    console.log(`HOTSPOT OVERRIDDEN (--allow-guard) for ${branch}:\n${list}`);
    try {
      fs.appendFileSync(
        timeLog(),
        `${JSON.stringify({ time: new Date().toISOString(), wave: task ? 'queue' : null, track: taskName ?? branch, event: 'guard-overridden', branch, hotspots: hot })}\n`,
      );
    } catch (e) {
      console.error(`  (could not log guard-overridden: ${e.message})`);
    }
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'merge-track-'));

// ---- 1) Merge ------------------------------------------------------------------------
const now = git('rev-parse', '--abbrev-ref', 'HEAD').trim();
console.log(`Merging ${branch} at ${TIP.slice(0, 12)} into ${now} …`);
// Stale index after `git commit -- <files>` with a pre-commit hook: the file equals HEAD in the working tree, but
// the index has an older version, and then merge refuses ("local changes would be overwritten"). Clean up only such files.
for (const f of git('diff', '--cached', '--name-only').split('\n').filter(Boolean)) {
  if (gitOk('diff', '--quiet', 'HEAD', '--', f).status === 0) {
    gitOk('reset', '-q', '--', f);
    console.log(`  cleaned stale index for ${f} (equal to HEAD)`);
  }
}
// The user's own staged changes: git merge refuses to merge on top of them, but first saves and restores the working tree
// itself, and with core.autocrlf (on by default in Git for Windows) that rewrites the user's uncommitted files with other
// line endings. Stop before git touches anything, and say what to do (red team flow 3, __tests__/redteam/flows.test.ts).
const staged = git('diff', '--cached', '--name-only').split('\n').filter(Boolean);
if (staged.length) {
  console.error(
    `Not merged: the checkout has staged changes that are not committed: ${staged.slice(0, 10).join(', ')}` +
      `${staged.length > 10 ? ` and ${staged.length - 10} more` : ''}.\n` +
      'git merge refuses to merge on top of them. Nothing was touched. Commit them, or unstage them with ' +
      '"git restore --staged <file>" (the change stays in the file), then merge again.',
  );
  process.exit(1);
}
// The same for the user's uncommitted work in a file the branch changes (a changed tracked file, or an untracked file at
// a path the branch adds): git merge would refuse, after the same save and restore. Stop first, and name the files
// (red team RT-01, __tests__/redteam/rt01-uncommitted-work.test.ts).
{
  const base = gitOk('merge-base', 'HEAD', TIP);
  const theirs =
    base.status === 0
      ? new Set(git('diff', '--name-only', '-z', base.stdout.trim(), TIP).split('\0').filter(Boolean))
      : new Set();
  const mine = git('status', '--porcelain=v1', '-z', '--untracked-files=all').split('\0').filter(Boolean);
  const blocked = [];
  for (let i = 0; i < mine.length; i++) {
    const code = mine[i].slice(0, 2);
    const p = mine[i].slice(3);
    if (code.startsWith('R') || code.startsWith('C')) i++;
    if (theirs.has(p)) blocked.push(`${p}${code === '??' ? ' (untracked)' : ''}`);
  }
  if (blocked.length) {
    console.error(
      `Not merged: ${branch} changes files that have uncommitted work in this checkout: ${blocked.slice(0, 10).join(', ')}` +
        `${blocked.length > 10 ? ` and ${blocked.length - 10} more` : ''}.\n` +
        'git merge would refuse to overwrite them. Nothing was touched. Commit them, or move them aside ' +
        '(git stash push -- <file>, or rename an untracked file), then merge again.',
    );
    process.exit(1);
  }
}
// The merge itself runs after the text merge's helpers below (1b and 1c), so the trial merge can use them.

// ---- 2) Three-way merge per file -------------------------------------------------------
// The stage as bytes (null when it does not exist). Read as a Buffer, never straight as utf8: a binary or non-UTF-8 stage
// would otherwise turn into text with U+FFFD in it before anything could see that (review 2026-11-11, G1).
const stage = (n, file) => {
  const r = spawnSync('git', [...QUOTE_OFF, 'show', `:${n}:${file}`], { maxBuffer: 256 << 20 });
  return r.status === 0 ? r.stdout : null;
};
// Why a stage cannot go through the text merge, or null. A NUL byte is how git itself tells binary from text (in the first
// 8000 bytes); text that does not survive a round trip through utf8 (Latin-1, an encrypted or filtered blob) would be
// written back changed. Both go to the owner: the text merge would return the base and drop both sides' changes.
function notText(buf) {
  if (buf.subarray(0, 8000).includes(0)) return 'binary file, both sides changed it (resolve by hand)';
  if (!Buffer.from(buf.toString('utf8'), 'utf8').equals(buf)) return 'not UTF-8 text, the text merge would change its bytes (resolve by hand)';
  return null;
}

// Changes from base to side as hunks: { a: start line (0-based) in base, n: number of base lines, new: [lines] }.
function hunker(base, side, name) {
  const fb = path.join(tmp, `${name}.base`);
  const fside = path.join(tmp, `${name}.side`);
  fs.writeFileSync(fb, base);
  fs.writeFileSync(fside, side);
  const r = spawnSync(
    'git',
    ['diff', '--no-index', '-U0', '--no-color', '--diff-algorithm=myers', fb, fside],
    {
      encoding: 'utf8',
      maxBuffer: 256 << 20,
    },
  );
  // A diff git calls binary has no hunks, and no hunks would read as "nothing changed" (G1). The stages are checked for
  // this before the text merge; this is the last stop if git still judges the pair binary (a .gitattributes rule).
  if (/^Binary files .* differ$/m.test(r.stdout)) throw new BinaryDiff();
  const out = [];
  let cur = null;
  for (const l of r.stdout.split('\n')) {
    const h = l.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (h) {
      const bStart = Number(h[1]);
      const bCount = h[2] === undefined ? 1 : Number(h[2]);
      // For a pure insertion (bCount = 0) bStart points to the line BEFORE the insertion.
      cur = { a: bCount === 0 ? bStart : bStart - 1, n: bCount, new: [] };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    if (l.startsWith('+') && !l.startsWith('+++')) cur.new.push(l.slice(1));
  }
  return out;
}

// A line that consists only of list values ('a' or 'a', 'b') and does not end with a comma.
const LIT = `('[^']*'|"[^"]*")`;
const LIST_LINE = new RegExp(`^\\s*${LIT}(\\s*,\\s*${LIT})*\\s*(--.*|//.*)?$`);
const LAST_VALUE = new RegExp(`${LIT}(\\s*(--.*|//.*)?)$`);
const startsWithListValue = (l) => /^\s*['"]/.test(l);
// A tuple row in a VALUES list: "('a', 'b')" without a comma at the end (optional comment). If two tracks add a row
// at the end of the same list, the merge could otherwise lose the comma between the tuples.
// The code part of the line: everything before a "--"/"//" comment that sits OUTSIDE a string. Then a parenthesis in
// the comment ("-- row (2)") does not look like the end of a tuple.
function codePart(l) {
  let inString = null;
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (inString) {
      if (c === inString) inString = null;
    } else if (c === "'" || c === '"') inString = c;
    else if ((c === '-' || c === '/') && l[i + 1] === c) return l.slice(0, i);
  }
  return l;
}
const isTupleLine = (l) => /^\s*\(.*\)\s*$/.test(codePart(l));
const startsWithTuple = (l) => /^\s*\(/.test(l);

// Inserts a comma when block A ends with list values (or a tuple) without a comma and block B starts with a new one.
function commaBetween(a, b, file) {
  if (!/\.(sql|js|mjs|ts|tsx)$/.test(file)) return a;
  const isContent = (l) => l.trim() && !/^\s*(--|\/\/)/.test(l);
  let i = a.length - 1;
  while (i >= 0 && !isContent(a[i])) i--;
  const firstB = b.find(isContent);
  if (i < 0 || firstB === undefined) return a;
  const copy = [...a];
  // Without String.replace: build the line with slice, so "$" in the content is never interpreted as a pattern.
  if (LIST_LINE.test(a[i]) && startsWithListValue(firstB)) {
    const match = copy[i].match(LAST_VALUE);
    const pos = match.index + match[1].length;
    copy[i] = `${copy[i].slice(0, pos)},${copy[i].slice(pos)}`;
    return copy;
  }
  if (isTupleLine(a[i]) && startsWithTuple(firstB)) {
    const pos = codePart(copy[i]).lastIndexOf(')') + 1;
    copy[i] = `${copy[i].slice(0, pos)},${copy[i].slice(pos)}`;
    return copy;
  }
  return a;
}

class BinaryDiff extends Error {}

function mergeText(file, base, ours, theirs) {
  const bl = base.split('\n');
  let ho;
  let ht;
  try {
    ho = hunker(base, ours, 'o');
    ht = hunker(base, theirs, 't');
  } catch (e) {
    if (e instanceof BinaryDiff) return { ok: false, reason: 'git diffs it as a binary file (resolve by hand)' };
    throw e;
  }
  const all = [...ho.map((h) => ({ ...h, s: 'o' })), ...ht.map((h) => ({ ...h, s: 't' }))].sort(
    (x, y) => x.a - y.a || (x.s === 'o' ? -1 : 1),
  );
  const out = [];
  let pos = 0;
  for (let i = 0; i < all.length;) {
    const h = all[i];
    const end = (x) => x.a + x.n;
    // Groups hunks that overlap (same base range, or insertion at the same anchor point).
    const group = [h];
    let gEnd = end(h);
    let j = i + 1;
    while (j < all.length && (all[j].a < gEnd || (all[j].a === h.a && all[j].a === gEnd))) {
      group.push(all[j]);
      gEnd = Math.max(gEnd, end(all[j]));
      j++;
    }
    for (; pos < h.a; pos++) out.push(bl[pos]);
    const fromO = group.filter((x) => x.s === 'o');
    const fromT = group.filter((x) => x.s === 't');
    if (!fromO.length || !fromT.length) {
      for (const x of group) out.push(...x.new);
    } else if (
      fromO.length === 1 &&
      fromT.length === 1 &&
      fromO[0].a === fromT[0].a &&
      fromO[0].n === fromT[0].n
    ) {
      const o = fromO[0].new;
      const t = fromT[0].new;
      const n = fromO[0].n;
      if (o.join('\n') === t.join('\n')) out.push(...o);
      else if (n === 0) {
        // Pure insertions at the same place: HEAD's block, then the branch's. NEVER a common prefix here: both may start
        // with the same line (for example a closing "}" that the diff has "rotated" into the block), and it is needed twice.
        out.push(...commaBetween(o, t, file), ...t);
      } else {
        // The same base lines changed on both sides: accepted only when both changed them identically (for example a comma
        // added to the previous element), and the rest is insertions. Then the changed lines are taken once, then the rest from each side.
        if (o.slice(0, n).join('\n') !== t.slice(0, n).join('\n'))
          return { ok: false, reason: `the same lines changed differently (base line ${h.a + 1})` };
        const common = o.slice(0, n);
        const oRest = o.slice(n);
        const tRest = t.slice(n);
        out.push(...commaBetween(common.concat(oRest), tRest, file), ...tRest);
      }
    } else {
      return { ok: false, reason: `overlapping changes around base line ${h.a + 1}` };
    }
    pos = gEnd;
    i = j;
  }
  for (; pos < bl.length; pos++) out.push(bl[pos]);
  return { ok: true, text: out.join('\n') };
}

// Translation files: HEAD's text (conflict free after the HEAD side), plus top-level keys the branch has added, verbatim.
function mergeIn18n(base, ours, theirs, current) {
  const main = [];
  let mode = 'common';
  for (const l of current.split('\n')) {
    if (/^<<<<<<< /.test(l)) {
      mode = 'ours';
      continue;
    }
    if (l === '=======' && mode === 'ours') {
      mode = 'theirs';
      continue;
    }
    if (/^>>>>>>> /.test(l)) {
      mode = 'common';
      continue;
    }
    if (mode !== 'theirs') main.push(l);
  }
  let s = main.join('\n');
  let res;
  try {
    res = JSON.parse(s);
  } catch (e) {
    return { ok: false, reason: `the HEAD side does not parse: ${e.message}` };
  }
  const B = JSON.parse(base);
  const O = JSON.parse(ours);
  const T = JSON.parse(theirs);
  const tl = theirs.split('\n');
  for (const k of Object.keys(T)) {
    if (k in res || k in B) continue;
    const start = tl.findIndex((l) => l.startsWith(`  ${JSON.stringify(k)}: `));
    if (start < 0) return { ok: false, reason: `could not find top-level key ${k} in the branch` };
    let end = start;
    if (tl[start].trim().endsWith('{')) {
      for (let i = start + 1; i < tl.length; i++)
        if (/^ {2}\},?$/.test(tl[i])) {
          end = i;
          break;
        }
    }
    let block = tl.slice(start, end + 1).join('\n');
    if (block.endsWith(',')) block = block.slice(0, -1);
    const last = s.lastIndexOf('}');
    s = `${s.slice(0, last).trimEnd()},\n${block}\n}\n`;
    res = JSON.parse(s);
  }
  // Three-way check: everything the branch added exists; everything HEAD has exists unless the branch removed it from the base.
  const missing = [];
  const checkT = (a, b, bb, filePath) => {
    for (const k of Object.keys(b)) {
      const fresh = !bb || !(k in bb);
      if (!(k in a)) {
        if (fresh) missing.push(filePath + k);
        continue;
      }
      if (b[k] && typeof b[k] === 'object') checkT(a[k], b[k], bb && bb[k], `${filePath + k}.`);
    }
  };
  const checkO = (a, o, t, bb, filePath) => {
    for (const k of Object.keys(o)) {
      const removed = bb && k in bb && !(t && k in t);
      if (!(k in a)) {
        if (!removed) missing.push(filePath + k);
        continue;
      }
      if (o[k] && typeof o[k] === 'object')
        checkO(a[k], o[k], t && t[k], bb && bb[k], `${filePath + k}.`);
    }
  };
  checkT(res, T, B, '');
  checkO(res, O, T, B, '');
  if (missing.length)
    return { ok: false, reason: `keys missing after merge: ${missing.slice(0, 5).join(', ')}` };
  return { ok: true, text: s };
}

// One conflicting file: { ok: true, text } or { ok: false, reason }. `stages` are the three versions as bytes (null when
// one is missing); `current()` gives the file with git's conflict markers (only the translation merge reads it). The
// trial merge and the real one both go through here, so the trial predicts exactly what the real merge will do.
function resolveOne(file, stages, current) {
  if (stages.includes(null)) return { ok: false, reason: 'added or deleted on one side' };
  const why = stages.map(notText).find(Boolean);
  if (why) return { ok: false, reason: why };
  const [base, ours, theirs] = stages.map((b) => b.toString('utf8'));
  if (/(^|\/)locales\/[A-Za-z_-]+\.json$/.test(file)) {
    const text = current();
    return text == null ? { ok: false, reason: 'could not read the conflicted file' } : mergeIn18n(base, ours, theirs, text);
  }
  if (file.endsWith('.json')) return { ok: false, reason: 'JSON outside locales/ is resolved by hand' };
  return mergeText(file, base, ours, theirs);
}

// ---- 1b) The trial merge of TIP, before git touches the checkout (V2) ---------------------------------------------
// `git merge-tree --write-tree` (git >= 2.38) merges HEAD and TIP the way `git merge` does, but writes objects only.
// Exit 0: clean. Exit 1: conflicts, and with -z the output is "<tree>\0" followed by "<mode> <oid> <stage>\t<path>\0"
// per conflicting stage (--no-messages leaves out the informational part). Each file is resolved in memory; when one
// would have to be done by hand, the merge stops here and the checkout is never in the middle of a merge. Anything
// else (another exit code, an output this cannot read) falls back to the real merge, which handles it as before.
{
  const CP = require('./lib/conflictPredict.js');
  const version = CP.gitVersion(CP.makeRunner(process.cwd()));
  if (!CP.supportsMergeTree(version)) {
    console.log(
      `NOTE: git ${version ?? '(unknown version)'} is older than ${CP.MIN_GIT_TEXT} (no git merge-tree --write-tree), ` +
        'so there is no trial merge first: a conflict that must be resolved by hand leaves the merge in place, as before.',
    );
  } else {
    const t = spawnSync('git', [...QUOTE_OFF, 'merge-tree', '--write-tree', '-z', '--no-messages', 'HEAD', TIP], {
      encoding: 'utf8',
      maxBuffer: 256 << 20,
    });
    if (t.status === 1) {
      const [tree, ...entries] = String(t.stdout ?? '').split('\0').filter(Boolean);
      const files = new Map();
      for (const e of entries) {
        const x = /^(\d+) ([0-9a-f]+) ([123])\t(.+)$/s.exec(e);
        if (!x) continue;
        if (!files.has(x[4])) files.set(x[4], [null, null, null]);
        files.get(x[4])[Number(x[3]) - 1] = x[2];
      }
      const blob = (spec) => {
        const r = spawnSync('git', [...QUOTE_OFF, 'cat-file', 'blob', spec], { maxBuffer: 256 << 20 });
        return r.status === 0 ? r.stdout : null;
      };
      const byHand = [];
      for (const [file, oids] of files) {
        let r;
        try {
          const current = () => blob(`${tree}:${file}`)?.toString('utf8') ?? null;
          r = resolveOne(file, oids.map((o) => (o ? blob(o) : null)), current);
        } catch (e) {
          r = { ok: false, reason: `the text merge failed (${e.message})` };
        }
        if (!r.ok) byHand.push(`${file}: ${r.reason}`);
      }
      if (byHand.length) {
        fs.rmSync(tmp, { recursive: true, force: true });
        console.log(`Conflicts in ${files.size} files.`);
        console.log(
          `\nMUST BE RESOLVED BY HAND (trial merge with git merge-tree: nothing was merged, the checkout is untouched):`,
        );
        for (const x of byHand) console.log(`  ${x}`);
        console.log(
          `\nNothing was merged and nothing is left open. Resolve it on the branch: a fix round (${CLI} resume <id> ` +
            `--reason fix) merges ${now} into ${branch} and resolves it there, or do that yourself in the track's ` +
            `worktree (git merge ${now}). Then ${CLI} receive <id> and ${CLI} merge <id>.`,
        );
        process.exit(1);
      }
      console.log(`Trial merge: ${files.size} conflicting file(s), all resolved automatically in the trial.`);
    }
  }
}

// ---- 1c) The real merge of TIP ---------------------------------------------------------------------------------------
const m = gitOk('merge', '--no-ff', '-m', mergeMessage(now), TIP);
const conflicts = git('diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean);
if (m.status !== 0 && !conflicts.length) {
  console.error(`git merge failed without conflicts:\n${m.stdout}${m.stderr}`);
  process.exit(1);
}
console.log(conflicts.length ? `Conflicts in ${conflicts.length} files.` : 'No conflicts.');

const resolved = [];
const manual = [];
for (const file of conflicts) {
  const r = resolveOne(file, [stage(1, file), stage(2, file), stage(3, file)], () => fs.readFileSync(file, 'utf8'));
  if (!r.ok) {
    manual.push(`${file}: ${r.reason}`);
    continue;
  }
  writeWithNewAttempt(file, r.text);
  resolved.push(file);
}

// ---- 3) Validation ---------------------------------------------------------------------
const error = [];
const changed = git('diff', '--name-only', 'HEAD').split('\n').filter(Boolean);
const checked = [...new Set([...resolved, ...changed])].filter((f) => fs.existsSync(f));
// Two identifier-like list values in a row without a comma: SQL joins them into one string, and
// both disappear from the list. Messages split over several lines have whitespace inside the string and are
// deliberate concatenations; they are not flagged.
const IDENT = `'[A-Za-z0-9_.:/-]+'`;
const identLine = new RegExp(`^\\s*${IDENT}(\\s*,\\s*${IDENT})*\\s*(--.*)?$`);
const identStart = new RegExp(`^\\s*${IDENT}`);
for (const f of checked) {
  const t = fs.readFileSync(f, 'utf8');
  if (/^(<<<<<<<|>>>>>>>) /m.test(t) || /^=======$/m.test(t)) error.push(`${f}: conflict markers`);
  if (f.endsWith('.json')) {
    try {
      JSON.parse(t);
    } catch (e) {
      error.push(`${f}: JSON does not parse (${e.message})`);
    }
  }
  if (/\.(js|mjs|cjs)$/.test(f)) {
    const r = spawnSync('node', ['--check', f], { encoding: 'utf8' });
    if (r.status !== 0) error.push(`${f}: node --check failed`);
  }
  if (resolved.includes(f) && f.endsWith('.sql')) {
    const L = t.split('\n');
    for (let i = 0; i < L.length; i++) {
      if (!identLine.test(L[i])) continue;
      let j = i + 1;
      while (j < L.length && /^\s*(--|$)/.test(L[j])) j++;
      if (j < L.length && identStart.test(L[j]))
        error.push(`${f}:${i + 1}: list value without a comma before a new value on line ${j + 1}`);
    }
    // The same error for tuple rows in a VALUES list ("('a', 'b')" followed by a new "(" row): gives a syntax error, which
    // is only discovered when the SQL actually runs.
    for (let i = 0; i < L.length; i++) {
      if (!isTupleLine(L[i]) || !/^\s*\('/.test(L[i])) continue;
      let j = i + 1;
      while (j < L.length && /^\s*(--|$)/.test(L[j])) j++;
      if (j < L.length && /^\s*\('/.test(L[j]))
        error.push(`${f}:${i + 1}: tuple without a comma before a new tuple on line ${j + 1}`);
    }
  }
}
// ---- 4) Functions rewritten by several tracks in the wave ---------------------------------------
const overlap = [];
const migFolder = K.migrations?.folder;
if (waveBase && migFolder) {
  const fnInFiles = (ref, files) => {
    const name = new Map();
    for (const f of files) {
      const r = gitOk('show', `${ref}:${f}`);
      if (r.status !== 0) continue;
      for (const x of r.stdout.matchAll(
        /create\s+or\s+replace\s+function\s+(?:public\.)?([a-z_0-9]+)/gi,
      ))
        name.set(x[1].toLowerCase(), f);
    }
    return name;
  };
  const branchFiles = git(
    'diff',
    '--name-only',
    `${waveBase}...${TIP}`,
    '--',
    migFolder,
  )
    .split('\n')
    .filter(Boolean);
  const otherFiles = git('diff', '--name-only', waveBase, 'HEAD', '--', migFolder)
    .split('\n')
    .filter((f) => f && !branchFiles.includes(f));
  const g = fnInFiles(TIP, branchFiles);
  const a = fnInFiles('HEAD', otherFiles);
  for (const [fn, f] of g)
    if (a.has(fn)) overlap.push(`${fn}: ${path.basename(f)} and ${path.basename(a.get(fn))}`);
}

// ---- 5) Result and commit --------------------------------------------------------------
fs.rmSync(tmp, { recursive: true, force: true });
if (resolved.length) console.log(`Resolved automatically: ${resolved.join(', ')}`);
if (overlap.length) {
  console.log(
    'WARNING: SQL functions rewritten entirely by several tracks in the wave (the one with the highest number wins):',
  );
  for (const o of overlap) console.log(`  ${o}`);
}
if (manual.length || error.length) {
  console.log('\nMUST BE RESOLVED BY HAND (the merge is left in place; git merge --abort undoes it):');
  for (const x of [...manual, ...error]) console.log(`  ${x}`);
  process.exit(1);
}
if (WITHOUT_COMMIT) {
  console.log('\nEverything resolved and validated. Not committed (--without-commit).');
  process.exit(0);
}
if (resolved.length) git('add', '--', ...resolved);
// Without conflicts git merge has already committed itself (no MERGE_HEAD). Then there is nothing to commit.
// The merge commit must have TIP as its second parent (G2): then it holds exactly the checked commit and nothing else.
const secondParentIsTip = () => {
  const p2 = gitOk('rev-parse', '-q', '--verify', 'HEAD^2');
  if (p2.status === 0 && p2.stdout.trim() === TIP) return;
  console.error(
    `The merge commit ${git('rev-parse', '--short=12', 'HEAD').trim()} does not have ${TIP.slice(0, 12)} (${branch}, the ` +
      `commit that was checked) as its second parent. Check git log -3 before anything else.`,
  );
  process.exit(1);
};
const mergeInProgress = gitOk('rev-parse', '-q', '--verify', 'MERGE_HEAD').status === 0;
if (!mergeInProgress) {
  secondParentIsTip();
  console.log(`\nMerged and committed by git merge: ${git('log', '--oneline', '-1').trim()}`);
  cleanupAfterMerge();
  process.exit(0);
}
const c = gitOk('commit', '--no-edit');
if (c.status !== 0 && !/nothing to commit/.test(`${c.stdout}${c.stderr}`)) {
  console.error(`commit failed:\n${c.stdout}${c.stderr}`);
  process.exit(1);
}
secondParentIsTip();
console.log(`\nMerged and committed: ${git('log', '--oneline', '-1').trim()}`);
cleanupAfterMerge();
process.exit(0);
