// =============================================================
// cli/merge/afterMerge.mjs: the last step of `ravenseat merge`: the merge state after the flow, the stop reports
// (the merge guard, a conflict with its context for the fix round, a moved branch, what --resume can still do), and on
// success the bookkeeping on the task (verification, times, size, changed files, blockers closed, the partial remark),
// the cleanup after the merge (tidyAfterMerge, deleteCloudBranch) and the closing lines and exit code.
//
// Why a module: the merge flow in steps (SPLIT-1, see cli/merge.mjs). Moved as it was: same output, exit codes and files;
// afterMerge is the end of cmdMerge, cut at its seam.
//
// Used by: cli/merge.mjs (cmdMerge), cli/merge/mergeChecks.mjs (tidyAfterMerge on a resume of a done task).
// Tested in: lib/__tests__/queueOrchestrator.test.ts, __tests__/queueMergeResume.test.ts, __tests__/eventRowsCli.test.ts,
//   lib/__tests__/conflictPredict.test.ts, lib/__tests__/tidy.test.ts, lib/__tests__/queueCloudTracks.test.ts,
//   lib/__tests__/mergeGuard.test.ts, __tests__/queueBaseGate.test.ts.
// =============================================================

import { spawnSync } from 'node:child_process';

import { BASE, CLI, CONFIG, edit, FOLDER, G, git, GIT_ROOT, L, read, require, TK } from '../context.mjs';

/** The cloud branch delete talks to the remote: a remote that does not answer must not hold the merge's last step. */
const DELETE_TIMEOUT_MS = 60_000;
import { mergeBlock, readTimeLog, reviewerFindingsLines } from '../tracks.mjs';
import { BASE_SETUP, BH, HEALTH_FILE } from '../baseHealth.mjs';
import { logEvent } from '../events.mjs';
import { cleanupDetachedOf, cleanupWorktree } from '../../cleanup-worktree.mjs';
import { tidyOptions } from '../tidy.mjs';
import { containsCommit, gitPathOf, ML } from './lock.mjs';

const ER = require('./lib/eventRows.js');
const CP = require('./lib/conflictPredict.js');
const CONTROLS = require('./lib/controls.js');
const GUIDANCE = require('./lib/guidance.js');

/** What is left of `ravenseat merge` after executeMerge (mergeSteps' result): the reports, the record and the cleanup. */
export function afterMerge({
  id, o, branch, trackTip, resume, keepReview, restLine, lockCtl, plan, mstate, saveState, res, mergeCode, mergeOut,
  notAsChecked, mergeCommit, baseSettled, baseLines, logFile, short, name, diffLines,
}) {
  for (const l of res.lines) console.log(l);
  // The flow is over: a late signal (Ctrl-C that the child survived) no longer rewrites the state.
  lockCtl.onSignal = null;
  // The merge state after the flow: removed when everything ran, kept with the stop otherwise (for --resume).
  if (res.ok) {
    mstate.steps_done = ML.markBefore(plan.step, mstate.steps_done, null);
    mstate.current = null;
  } else {
    mstate.steps_done = ML.markBefore(plan.step, mstate.steps_done, res.stop.step);
    mstate.current = null;
    mstate.stopped = { step: res.stop.step, message: res.stop.message, at: new Date().toISOString() };
    if (res.stop.step === 'merge' && mergeCode !== 0 && !containsCommit(trackTip, `refs/heads/${BASE}`) && !ML.gitInProgress(gitPathOf).length)
      ML.clearState(FOLDER, id); // nothing was merged and nothing is in progress: nothing to resume
    else saveState();
  }
  // A flow that stopped after the merge but before any verdict (the migration push): the tip is unknown, so the next
  // merge checks it first. Said here; the red or green verdict lines come last, where they are read.
  if (BASE_SETUP.enabled && mergeCommit && !baseSettled)
    console.log(`BASE: ${BASE} at ${short(mergeCommit)} is not checked yet (the flow stopped first); the next ${CLI} merge checks it first.`);
  const printBase = () => {
    for (const l of baseLines) console.log(l);
  };
  if (!res.ok && res.stop.step === 'merge' && mergeCode === 4) {
    // The merge guard: nothing was merged. Say what to do instead of a raw exit code. Two causes share exit 4: protected
    // paths the task does not own, and files another active task owns (OWNERSHIP in the excerpt).
    const seen = (re) => re.test(mergeOut ?? '') || res.stop.excerpt.some((l) => re.test(l));
    const foreign = seen(/OWNERSHIP:|\(owned by /);
    const hotspot = !foreign && seen(/HOTSPOT:/);
    console.log(
      foreign
        ? `STOP: the merge guard stopped ${branch} before the merge. The branch changes files that another active task ` +
            `owns (running, in review or picked), so it would change them under that task. Nothing was merged.`
        : hotspot
        ? `STOP: the merge guard stopped ${branch} before the merge. The branch changes shared config (hotspots in ` +
            `queue.config.json) that ${id} has not agreed in its hotspot_patch. Nothing was merged.`
        : `STOP: the merge guard stopped ${branch} before the merge. The branch changes protected paths ` +
            `(protectedPaths in queue.config.json: hooks, settings, agents, orchestrator scripts, the queue config, ` +
            `package.json) that ${id} does not own. Nothing was merged.`,
    );
    if (res.stop.excerpt.length) console.log(res.stop.excerpt.map((l) => `  | ${l}`).join('\n'));
    console.log(
      `Read the diff first: git diff ${BASE}...${branch} -- <path>. A change you did not ask for may come from text ` +
        'the track read (prompt injection): then do not merge, and start a fix round.\n' +
        `If the change is intended: add the path to the task's owned_files/shared_patch (after start: \`${CLI} edit ${id} --by owner\`), or run ` +
        `\`${CLI} merge ${id} --allow-guard\` (logged as "guard-overridden").`,
    );
    ML.clearState(FOLDER, id);
    mergeBlock(id, 'merge-guard', foreign ? 'files another active task owns' : hotspot ? 'shared config not agreed (hotspot)' : 'protected paths the task does not own');
    logEvent(ER.mergeConflictRow({ task: id, branch, files: ER.conflictFiles(mergeOut), guard: true }));
    console.log(`Full log: ${logFile}`);
    process.exit(4);
  }
  if (!res.ok) {
    // A stop in the merge or the gates step opens a blocker reason (ravenseat blockers); the next successful merge closes it.
    // Only a real conflict counts as one (files named by git, or a merge left in progress): an identity guard or a
    // validation stop is merge-stopped, so the statistics do not call it a conflict.
    const realConflict =
      res.stop.step === 'merge' && (ER.conflictFiles(mergeOut) > 0 || ML.gitInProgress(gitPathOf).some((x) => x.kind === 'merge'));
    const code = { merge: realConflict ? 'merge-conflict' : 'merge-stopped', gates: 'gate-red' }[res.stop.step];
    if (code) mergeBlock(id, code, res.stop.message);
    // The mergeConflict row (lib/eventRows.js): only for a real conflict that merge-track itself reported. Fail open.
    if (code === 'merge-conflict' && mergeCode != null && mergeCode !== 0)
      logEvent(ER.mergeConflictRow({ task: id, branch, files: ER.conflictFiles(mergeOut) }));
    console.log(`STOP in the step ${res.stop.step}: ${res.stop.message}`);
    if (res.stop.excerpt.length) console.log(res.stop.excerpt.map((l) => `  | ${l}`).join('\n'));
    if (res.stop.step === 'merge' && mergeCode === 6)
      console.log(
        `${branch} moved after the checks of this merge, so nothing was merged. The new commits need receive again: ` +
          `${CLI} receive ${id}, then ${CLI} merge ${id}.`,
      );
    // After the merge, the rest can be continued once the cause is fixed (the environment, a flaky gate, a base reset).
    if (notAsChecked) {
      // Never resume on top of commits nobody checked: the merge is undone first, and receive runs again.
      ML.clearState(FOLDER, id);
    } else if (containsCommit(trackTip, `refs/heads/${BASE}`)) {
      const left = ML.remainingSteps(plan.step, mstate.steps_done);
      if (left.length)
        console.log(`RESUME: when the cause is fixed, ${CLI} merge ${id} --resume runs the steps that are left (${left.join(', ')}).`);
    } else if (ML.gitInProgress(gitPathOf).some((x) => x.kind === 'merge'))
      console.log(
        `RESUME, doing it yourself: resolve the files, git add them and git commit --no-edit, then ${CLI} merge ${id} --resume runs the rest ` +
          '(or undo with git merge --abort).',
      );
    // A real conflict: the files and the other tasks that touched them go on the task (merge_conflict), so the fix
    // round brief names them (lib/conflictPredict.js, logic/resume.js). Fail open.
    if (code === 'merge-conflict' && mergeCode != null && mergeCode !== 0) {
      try {
        const mc = CP.mergeConflictContext({
          out: mergeOut, task: o, tasks: read().tasks, run: CP.makeRunner(GIT_ROOT), base: BASE, branch,
          prefix: CONFIG.branchPrefix ?? 'queue/',
        });
        if (mc.files.length) {
          edit((q) => {
            const x = q.tasks.find((y) => y.id === id);
            if (x) x.merge_conflict = mc;
          });
          for (const l of CP.mergeStopLines(mc, {
            id,
            ravenseat: CLI,
            open: ML.gitInProgress(gitPathOf).some((x) => x.kind === 'merge'),
          })) console.log(l);
        }
      } catch {
        /* the context helps the fix round; it is never a reason to fail the stop */
      }
    }
    console.log(`Full log: ${logFile}`);
    printBase();
    process.exit(1);
  }
  // The timestamps and the size. t_review is the first reviewer start after t_receive (hook-time writes
  // the start row with the task id from the path rev-<id>); the tests run with an injected runner, without a real merge.
  // What the merge was checked by (lib/controls.js): res.ok means the gates and the done command that exist were green.
  const verified = CONTROLS.verification({
    quickGates: CONTROLS.commandsOf(CONFIG.gates?.quick).length > 0,
    doneCommand: !!o.done_when,
    reviewed: reviewerFindingsLines(o).length > 0,
  });
  edit((queue) => {
    const ox = queue.tasks.find((x) => x.id === id);
    if (!ox) return null;
    ox.verification = { ...verified, sha: mstate.merge_commit ?? null };
    if (resume) ox.t_merge ??= new Date().toISOString();
    else ox.t_merge = new Date().toISOString();
    if (mstate.merge_commit) ox.merge_commit = mstate.merge_commit;
    if (diffLines != null) ox.diff_lines = diffLines;
    // The files the task actually changed (lib/ownershipHints.js): `add` uses them to suggest owned_files for new tasks.
    if (name != null) ox.changed_files = require('./lib/ownershipHints.js').changedFilesOf(name.split(/\r?\n/));
    const tReview = TK.firstReviewStart(readTimeLog({ from: ox.t_receive ?? null }), id, {
      types: L.REVIEWER_TYPES,
      from: ox.t_receive ?? null,
    });
    if (tReview && !ox.t_review) ox.t_review = tReview;
    // The merge went through: an open blocker (merge-conflict, gate-red or one set by hand) is closed.
    L.closeBlock(ox);
    delete ox.merge_conflict;
    // A partial merge: the task stays in review, and the remark says why (delivered_partial is left as it is).
    if (keepReview)
      ox.remarks = [
        ...(ox.remarks ?? []),
        `${new Date().toISOString()} merged with --allow-partial at ${short(mstate.merge_commit ?? trackTip)}; the rest of the task remains, so it stays in review until a finished delivery (${CLI} resume ${id} --reason context)`,
      ];
    return ox;
  });
  ML.clearState(FOLDER, id);
  tidyAfterMerge(branch, { resume, start: o.head_start, keepTrack: keepReview });
  console.log(`Full log: ${logFile}`);
  printBase();
  console.log(CONTROLS.verificationLine(verified, { quiet: GUIDANCE.isQuiet(read()) }));
  if (keepReview)
    console.log(
      `PARTIAL: ${id} is merged, but ${id} stays in review, not done: the track delivered it PARTIAL, so the rest remains. ` +
        `Tasks that wait on it stay waiting. Next: ${restLine}.`,
    );
  // When fill started tracks, the very last line says so (a background merge read with tail still shows it).
  const reminder = L.startReminderLine(res.filled);
  if (reminder) console.log(reminder);
  // The merge went through, but the base gate made the base red: exit 9 (as a refused merge), so a script that chains
  // merges stops here instead of reading a 0.
  if (baseSettled && BH.verdict(BH.readState(HEALTH_FILE), mergeCommit) === 'red') process.exit(BH.EXIT_RED_BASE);
}

/** A cloud track's branch on the remote: a session cannot delete it, and an old one would get in the way of a new attempt. cloud.deleteBranch false keeps it. */
function deleteCloudBranch(branch) {
  try {
    const id = branch.slice((CONFIG.branchPrefix ?? 'queue/').length);
    const remoteBranch = read().tasks.find((o) => o.id === id)?.cloud?.branch;
    if (!remoteBranch || CONFIG.cloud?.deleteBranch === false) return;
    const remote = CONFIG.remote ?? 'origin';
    // A time limit and no password prompt (ARK-1 T3): the merge stands either way, so a slow remote only leaves the branch.
    const r = spawnSync('git', ['push', '-q', remote, '--delete', remoteBranch], {
      cwd: GIT_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      timeout: DELETE_TIMEOUT_MS,
      windowsHide: true,
    });
    console.log(
      r.status !== 0
        ? `Cloud branch: ${remoteBranch} is still on ${remote}${r.error?.code === 'ETIMEDOUT' ? ` (no answer within ${DELETE_TIMEOUT_MS / 1000} s)` : ''}; git push ${remote} --delete ${remoteBranch}`
        : `Cloud branch: ${remoteBranch} removed from ${remote}.`,
    );
  } catch (e) {
    console.log(`Cloud branch: could not remove it, the merge stands: ${e?.message ?? e}`);
  }
}

/**
 * Best effort after a whole merge; it never changes the merge's result. A resume never ran merge-track's worktree
 * cleanup, so it runs here. The queue's own branch goes with `git branch -d`, which refuses anything not merged; a
 * branch the owner named (a picked task's own) stays. `keepTrack` (a partial merge): the track's branch, its worktrees and
 * its cloud branch stay, since the rest of the task is continued on them; only other merged agent branches go.
 */
export function tidyAfterMerge(branch, { resume, start, keepTrack = false }) {
  if (keepTrack) {
    const gone = G.mergedAgentBranches(git, BASE).filter((b) => git(['branch', '-d', b]) != null);
    if (gone.length) console.log(`Agent branches: ${gone.length} merged one(s) deleted.`);
    console.log(`Branch: ${branch} kept (the rest of the task is continued on it).`);
    return;
  }
  try {
    for (const r of cleanupDetachedOf(branch, { start, against: BASE, main: GIT_ROOT })) console.log(`Worktree: ${r.status}: ${r.message}`);
  } catch (e) {
    console.log(`Worktree: the cleanup failed, the merge stands: ${e?.message ?? e}`);
  }
  if (resume) {
    try {
      const r = cleanupWorktree(branch, { against: BASE, main: GIT_ROOT });
      console.log(`Worktree: ${r.status}: ${r.message}`);
    } catch (e) {
      console.log(`Worktree: the cleanup failed, the merge stands: ${e?.message ?? e}`);
    }
  }
  // tidy.afterMerge (off by default: a delete cannot be undone): the branch's worktrees anywhere on disk, by the tidy
  // rules (lib/tidy.js: merged, clean, unlocked, links first, never git worktree remove). No minimum age: the merge just
  // proved the work is in the base. The branch itself goes below with git branch -d, as before.
  if (CONFIG.tidy?.afterMerge === true) {
    try {
      for (const line of require('./lib/tidy.js').tidyBranch(branch, tidyOptions({ minAgeHours: 0 }))) console.log(line);
    } catch (e) {
      console.log(`Tidy: the cleanup failed, the merge stands: ${e?.message ?? e}`);
    }
  }
  // Claude Code leaves a worktree-agent-* branch per agent; once merged with no worktree, nothing is on it that the base lacks.
  const gone = G.mergedAgentBranches(git, BASE).filter((b) => git(['branch', '-d', b]) != null);
  if (gone.length) console.log(`Agent branches: ${gone.length} merged one(s) deleted.`);
  deleteCloudBranch(branch);
  if (!branch.startsWith(CONFIG.branchPrefix ?? 'queue/')) return;
  console.log(git(['branch', '-d', branch]) == null ? `Branch: ${branch} kept (git branch -d refused).` : `Branch: ${branch} deleted (merged).`);
}
