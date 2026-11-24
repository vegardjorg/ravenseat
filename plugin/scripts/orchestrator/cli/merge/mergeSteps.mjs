// =============================================================
// cli/merge/mergeSteps.mjs: the second step of `ravenseat merge`: the plan (lib/logic mergePlan), the merge state that
// records each step as it starts, the command per step, the base gate after the merge (settleBase, the skip rule, the
// owner stop on a changed git surface), the step runner with its checks right after the merge (the tip is in HEAD, and
// exactly that tip), and executeMerge with the migration push guard and the last check before done.
//
// Why a module: the merge flow in steps (SPLIT-1, see cli/merge.mjs). Moved as it was: same output, exit codes and files.
// mergeSteps is cmdMerge from the plan to the end of executeMerge, cut at those seams; it returns null where cmdMerge
// returned (a resume with nothing left), else the flow's result and the state for the after-merge part.
//
// Used by: cli/merge.mjs (cmdMerge).
// Tested in: __tests__/queueMergeResume.test.ts, __tests__/queueFaultInjection.test.ts, __tests__/queueBaseGate.test.ts,
//   __tests__/redteam/rt15-hanging-gate.test.ts, __tests__/redteam/rt07-interrupted.test.ts, __tests__/redteam/mergeTipLock.test.ts,
//   lib/__tests__/queueOrchestrator.test.ts.
// =============================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { a, BASE, CLI, CONFIG, die, edit, FOLDER, git, GIT_ROOT, HERE, L, MAIN_TREE, MIGR, read, require, TK } from '../context.mjs';
import { reviewerFindingsLines } from '../tracks.mjs';
import {
  BASE_SETUP, BH, flakyRecheck, gateRowsNow, recordVerdict, redLines, runCheckNow, treeOf, writeReport,
} from '../baseHealth.mjs';
import { gatesTamperReason } from './evidence.mjs';
import { containsCommit, interruptedBy, ML } from './lock.mjs';

const GB = require('./lib/gitSurfaceBaseline.js');
const WI = require('./lib/wiringItems.js');
const RI = require('./lib/reviewItems.js');

/** The plan, the state and the steps of `ravenseat merge`, after mergeChecks (everything it found is passed in). */
export async function mergeSteps({
  id, resume, allowGuard, lockCtl, o, branch, trackTip, state0, keepReview, restLine, withoutFill, scratch, resumeCommit,
  beforeMerge, wasRed,
}) {
  // Before the merge: the branch against base. When resuming: the track against the base before its merge commit.
  const against = resume ? (beforeMerge ?? BASE) : BASE;
  const name = git(['diff', '--name-only', `${against}...${trackTip}`]);
  // The branch's merge base and tip BEFORE the merge. After the merge HEAD = baseBranch and the gates' diff against base is empty;
  // with these gates.mjs can still see the track's own changes.
  const trackArgs = require('./lib/trackDiff.js').trackArgs({
    separator: git(['merge-base', against, trackTip]),
    tip: trackTip,
  });
  // The size in code lines (a stable size unit), measured BEFORE the merge against the wave base (HEAD at start;
  // without it: baseBranch). Three dots: only the branch's own changes.
  const diffLines = TK.diffLinesFromShortstat(
    git(['diff', '--shortstat', `${o.head_start ?? against}...${trackTip}`]),
  );
  const fullPlan = L.mergePlan({
    o,
    files: name == null ? null : name.split(/\r?\n/).filter(Boolean),
    withoutMigrPush: a.includes('--without-migr-push'),
    withoutFill,
    base: BASE,
    migrations: MIGR,
    baseGate: BASE_SETUP.enabled && !BASE_SETUP.sameAsQuick,
    keepReview,
  });
  // The steps this call runs: all of them, or (resume) the ones after the merge that the state does not list as done.
  // A task already done (set by hand, or the done step ran) never gets `done` again.
  const doneBefore = resume ? [...(state0?.steps_done ?? []), 'merge', ...(o.status === 'done' ? ['done'] : [])] : [];
  const plan = resume ? { ...fullPlan, step: ML.remainingSteps(fullPlan.step, doneBefore) } : fullPlan;
  // The merge state (lib/mergeLock.js): written as each step starts and when the flow ends, so an interruption at any
  // point leaves a record of the steps that ran. A completed flow removes it.
  const mstate = {
    task: id,
    branch,
    base: BASE,
    track_tip: trackTip,
    plan: fullPlan.step,
    steps_done: fullPlan.step.filter((s) => doneBefore.includes(s)),
    current: null,
    merge_commit: resumeCommit,
    started: new Date().toISOString(),
    pid: process.pid,
    ...(resume ? { resumed: (state0?.resumed ?? 0) + 1 } : {}),
  };
  const saveState = () => ML.writeState(FOLDER, mstate);
  lockCtl.onSignal = (sig) => {
    mstate.interrupted = { step: mstate.current, by: sig, at: new Date().toISOString() };
    saveState();
    console.error(
      `\nINTERRUPTED (${sig}) in the step ${mstate.current ?? '(between steps)'} of ${CLI} merge ${id}. Steps done: ` +
        `${mstate.steps_done.join(', ') || 'none'}. Continue with ${CLI} merge ${id} --resume ` +
        '(it explains first when git still has a merge in progress).',
    );
  };
  if (resume) {
    if (!plan.step.length) {
      ML.clearState(FOLDER, id);
      console.log(`${id}: every step of the merge has run already; nothing to resume.`);
      return null;
    }
    console.log(
      `RESUME ${id}: ${branch} at ${String(trackTip).slice(0, 12)} is in ${BASE}` +
        `${resumeCommit ? ` (merge commit ${String(resumeCommit).slice(0, 12)})` : ''}; ` +
        `steps done: ${mstate.steps_done.join(', ') || 'merge'}.`,
    );
    if (resumeCommit && o.merge_commit !== resumeCommit)
      edit((queue) => {
        const x = queue.tasks.find((y) => y.id === id);
        if (x) x.merge_commit = resumeCommit;
        return null;
      });
  }
  saveState();
  const logFolder = scratch ?? FOLDER;
  fs.mkdirSync(logFolder, { recursive: true });
  const logFile = path.join(logFolder, `merge-${id}.log`);
  const logParts = [];
  const writeLog = (text) => {
    logParts.push(text);
    try {
      fs.writeFileSync(logFile, logParts.join('\n'));
    } catch {
      /* the log is an aid (Windows file lock); the steps go on */
    }
  };
  const queueMjs = path.join(HERE, 'queue.mjs');
  const gatesLog = path.join(logFolder, `merge-${id}-gates`);
  const remark =`merged with ravenseat merge${plan.migrPush ? ' (migrations pushed)' : ''}`;
  /** The command for one step: [program, arguments, shell?]. The migration command is a shell line from the config. */
  const command = ({ step }) => {
    if (step === 'merge')
      return [
        process.execPath,
        [
          path.join(HERE, 'merge-track.mjs'),
          branch,
          // The tip the checks ran on (G2): merge-track merges this sha, and stops (exit 6) if the branch has moved.
          '--tip',
          trackTip,
          ...(o.head_start ? ['--wave-base', o.head_start] : []),
          ...(allowGuard ? ['--allow-guard'] : []),
          // A partial merge: the rest is continued on the same branch, so the track's worktree stays (resume frees it).
          ...(keepReview ? ['--keep-worktree'] : []),
        ],
      ];
    if (step === 'migr-push') return [String(MIGR.pushCommand), [], true];
    if (step === 'gates')
      return [
        process.execPath,
        [
          path.join(HERE, 'gates.mjs'),
          '--quick',
          // Trusted evidence for the merge commit (lib/gateEvidence.js); the main checkout records it anyway.
          '--evidence',
          ...trackArgs,
          // The task id for the gate row in the time log (gates.mjs): after the merge HEAD is the base branch.
          '--track',
          id,
          '--log',
          gatesLog,
          // Always the base gate's time budget, as receive does: a hanging gate must not hold the merge, also when the
          // base gate is off or has its own commands (red team RT-15, __tests__/redteam/rt15-hanging-gate.test.ts).
          '--timeout-sec',
          String(BASE_SETUP.timeoutSec),
        ],
      ];
    if (step === 'done')
      return [
        process.execPath,
        [
          queueMjs,
          'set',
          id,
          'done',
          '--remark',
          remark,
          // The reviewers' FINDINGS lines are entered into the task (`findings`); no line: no --findings.
          ...reviewerFindingsLines(o).flatMap((l) => ['--findings', l]),
        ],
      ];
    if (step === 'fill') return [process.execPath, [queueMjs, 'fill', '--scratchpad', scratch]];
    throw new Error(`unknown step ${step}`);
  };
  // The tests inject the runner (QUEUE_MERGE_RUNNING = a module with default export run({ step, cmd, args }) ->
  // { code, out }), so there is never a real migrationPush, merge or gate run in a test.
  const injected = process.env.QUEUE_MERGE_RUNNING
    ? (await import(pathToFileURL(path.resolve(process.env.QUEUE_MERGE_RUNNING)).href)).default
    : null;
  // The exit code of merge-track.mjs: 4 = the merge guard stopped it before the merge (gets its own message below).
  let mergeCode = null;
  // The merge step's output, for the conflict count in the mergeConflict row ("Conflicts in N files.").
  // notAsChecked: the merge commit holds more than the checked tip (G2); then --resume is not offered.
  let notAsChecked = false;
  let mergeOut = '';
  // ---- The base gate after the merge (lib/baseHealth.js) ----
  // The verdict is recorded for the merge commit as soon as it is known: from the quick gates when they are the base
  // gate (or when they are red: a red quick gate on the new tip is a red base whatever the base gate commands are),
  // otherwise from the `base-gate` step. Before `done` and `fill`, so fill already sees the base fix task.
  // When resuming, the merge is in already: the base verdict goes to the base tip as it is now.
  let mergeCommit = resume && BASE_SETUP.enabled ? git(['rev-parse', '--verify', `refs/heads/${BASE}`]) : null;
  let baseSettled = false;
  const baseLines = [];
  const short = (sha) => String(sha ?? '').slice(0, 12);
  const settleBase = ({ ok, check = null, file = null, skipped = null, stayedInReview = false }) => {
    if (baseSettled || !mergeCommit) return;
    baseSettled = true;
    const v = recordVerdict({ tip: mergeCommit, ok, run: check, file, causeId: id, wasRed, skipped });
    if (!ok) {
      baseLines.push(...redLines({ entry: v.entry, run: check, fix: v.fix, causeId: id, stayedInReview }));
      return;
    }
    baseLines.push(`BASE GREEN: ${BASE} at ${short(mergeCommit)}${skipped ? ` (not run again: ${skipped})` : ''}.`);
    if (v.openFix) baseLines.push(v.openFix);
  };
  // The skip rule: the merge commit has the tree of the track tip, and ravenseat's own gate run (receive) was green on that
  // tip. The rows are the trusted gate evidence (lib/gateEvidence.js), never the time log a track can append to.
  const skipNow = () =>
    BH.skipEvidence({ newTip: mergeCommit, trackTip, treeOf, rows: gateRowsNow(), commands: BASE_SETUP.commands });
  const skipped = (reason) => {
    settleBase({ ok: true, skipped: reason });
    return { code: 0, out: `skipped, recorded green: ${reason}` };
  };
  /**
   * A run after the merge changed what runs at the next git command: the owner's decision, not a base fix task for an
   * agent. No verdict is recorded (the next merge checks the base first) and no blocker opened; the merge state stays,
   * so --resume runs what is left once the owner has settled it.
   */
  const ownerStop = (step, what, reason) => {
    mstate.steps_done = ML.markBefore(plan.step, mstate.steps_done, step);
    mstate.current = null;
    mstate.stopped = { step, message: 'owner stop: git hooks, config or the evidence store changed', at: new Date().toISOString() };
    saveState();
    lockCtl.onSignal = null;
    die(GB.tamperedMessage({ what, reason, ravenseat: CLI, again: `${CLI} merge ${id} --resume` }));
  };
  /** The `base-gate` step: the base gate commands on the merge commit, in the main checkout (or the skip rule). */
  const baseGateStep = () => {
    if (!mergeCommit) return { code: 1, out: 'no merge commit to check' };
    const sk = skipNow();
    if (sk.skip) return skipped(sk.reason);
    const check = runCheckNow({ tip: mergeCommit, folder: logFolder, cause: { task: id, merge_commit: mergeCommit } });
    if (check.run.tampered) ownerStop('base-gate', 'the base check after the merge', check.run.tampered);
    settleBase({ ok: check.run.ok, check: check.run, file: check.file });
    return {
      code: check.run.ok ? 0 : 1,
      out: check.run.ok
        ? `GREEN (${check.run.durationSec} s)`
        : `\`${check.run.failed}\` ${check.run.timedOut ? 'over the time budget' : `exit ${check.run.exit ?? '?'}`}`,
    };
  };
  /** A red quick gates run on the merge commit as a base verdict: the tail of the gates log (or of the output). */
  const gatesRed = (r) => {
    let text = r.out;
    try {
      text = fs.readFileSync(gatesLog, 'utf8');
    } catch {
      /* no log file (an injected runner): the step's output */
    }
    const check = {
      ok: false,
      failed: null,
      exit: r.code,
      timedOut: /time budget/.test(text),
      durationSec: null,
      tail: require('./lib/doneCheck.js').tailOf(text, BASE_SETUP.tailLines),
    };
    const file = writeReport({ folder: logFolder, tip: mergeCommit, run: check, cause: { task: id, merge_commit: mergeCommit } });
    settleBase({ ok: false, check, file, stayedInReview: true });
  };
  /** Ctrl-C or a kill reached a step's child: the state says where, the lock goes, exit 130 (as a shell does). */
  const stepInterrupted = (sig) => {
    lockCtl.onSignal?.(sig);
    lockCtl.release();
    process.exit(130);
  };
  const run = (x) => {
    // The steps before this one have succeeded (executeMerge stops at the first error): recorded before it starts.
    mstate.steps_done = ML.markBefore(plan.step, mstate.steps_done, x.step);
    mstate.current = x.step;
    saveState();
    if (x.step === 'base-gate') {
      const r = baseGateStep();
      writeLog(`===== base-gate (exit ${r.code}) =====\n${r.out}`);
      return r;
    }
    if (x.step === 'gates' && BASE_SETUP.enabled && BASE_SETUP.sameAsQuick && mergeCommit) {
      const sk = skipNow();
      if (sk.skip) {
        const r = skipped(sk.reason);
        writeLog(`===== gates (skipped by the base gate's skip rule) =====\n${r.out}`);
        return r;
      }
    }
    const [cmd, args, shell = false] = command(x);
    const stepStarted = Date.now();
    let r;
    if (injected) {
      r = injected({ ...x, cmd, args });
      // A test runner can answer as an interrupted child would ({ signal: 'SIGINT' }).
      if (r && interruptedBy({ signal: r.signal ?? null, status: r.code })) stepInterrupted(interruptedBy({ signal: r.signal ?? null, status: r.code }));
    } else {
      const s = spawnSync(cmd, args, {
        cwd: GIT_ROOT,
        encoding: 'utf8',
        maxBuffer: 1 << 28,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: shell,
      });
      if (interruptedBy(s)) stepInterrupted(interruptedBy(s));
      r = {
        code: s.status ?? 1,
        out: `${s.stdout ?? ''}${s.stderr ?? ''}${s.error ? `\n${s.error.message}` : ''}`,
      };
    }
    writeLog(`===== ${x.step}: ${cmd} ${args.join(' ')} (exit ${r.code}) =====\n${r.out}`);
    if (x.step === 'merge') {
      if (r.code === 0) {
        // The invariant right after the merge (M6): HEAD holds the track's tip. A merge step that says "merged" while
        // the tip is not in HEAD (it committed another, unfinished merge, or nothing) is a stop, never a done task.
        const head = git(['rev-parse', '--verify', 'HEAD']);
        // And exactly that tip (G2): the merge commit's second parent is the checked commit. A merge of a branch that
        // moved after the checks also contains the tip, with commits that had no receive and no review on top.
        const second = git(['rev-parse', '-q', '--verify', `${head}^2`]);
        // Asked once: both are commit shas here, so the answer cannot change between the two branches below.
        const tipInHead = containsCommit(trackTip, head);
        if (tipInHead && second !== trackTip) {
          notAsChecked = true;
          r = {
            code: 1,
            out:
              `${r.out}\nNOT MERGED AS CHECKED: the merge commit ${short(head)} on ${BASE} has ` +
              `${second ? short(second) : 'no second parent'} as its second parent, not ${short(trackTip)}, the tip of ` +
              `${branch} that the checks ran on. Commits that had no receive and no review may be in ${BASE} now. Check ` +
              `git log -3 ${BASE}, undo the merge (git revert -m 1 ${short(head)}, or git reset --keep HEAD~1 when nothing ` +
              `came after it and it is not pushed), then ${CLI} receive ${id} and merge again. ${id} is not marked done.`,
          };
        } else if (!tipInHead) {
          r = {
            code: 1,
            out:
              `${r.out}\nNOT MERGED: the merge step exited 0, but ${BASE} at ${short(head)} does not contain ${branch} at ` +
              `${short(trackTip)} (git merge-base --is-ancestor). It may have committed an earlier, unfinished merge. ` +
              `Check git log -3 ${BASE}; nothing after the merge was done.`,
          };
        } else {
          mstate.merge_commit = head;
          saveState();
          // The merge commit on the task (merge_commit): doctor and later checks can see that it is still in base.
          edit((queue) => {
            const t = queue.tasks.find((y) => y.id === id);
            if (t) t.merge_commit = head;
            return null;
          });
          if (BASE_SETUP.enabled) mergeCommit = head;
        }
      }
      mergeCode = r.code;
      mergeOut = r.out;
      // Said now and not at the end: a later step can stop the merge, and the warning is about what is already in.
      if (r.code === 0) for (const note of require('./lib/mergeGuard.js').ownerNotes(r.out)) console.log(note);
    }
    if (x.step === 'gates' && r.code !== 0) {
      const tampered = gatesTamperReason({ id, since: stepStarted });
      if (tampered) ownerStop('gates', 'the quick gates after the merge', tampered);
    }
    if (x.step === 'gates' && BASE_SETUP.enabled && mergeCommit) {
      // The flaky check (lib/baseHealth.js): the failed quick gates once more on the same sha before the base freezes.
      const flaky = r.code !== 0 ? flakyRecheck({ tip: mergeCommit, causeId: id }) : null;
      if (flaky?.tampered) ownerStop('gates', 'the rerun of the quick gates after the merge', flaky.tampered);
      if (flaky) {
        const list = flaky.run.flaky.join(' ; ');
        r = { code: 0, out: `${r.out}\nflaky: green on a rerun of ${list}` };
        writeLog(`===== gates: flaky, green on a rerun of ${list} =====`);
        if (BASE_SETUP.sameAsQuick) settleBase({ ok: true, check: flaky.run });
      } else if (r.code !== 0) gatesRed(r);
      else if (BASE_SETUP.sameAsQuick) settleBase({ ok: true });
    }
    return r;
  };
  const PRIVACY = require('./lib/pushGuard.js');
  // The environment file is often gitignored and only in the main tree; so the git root is tried first and then the main tree.
  const readEnvironment = () => PRIVACY.readEnvironment([GIT_ROOT, MAIN_TREE], MIGR.environmentFile ?? null);
  console.log(`MERGE ${id} (${branch}): ${plan.step.join(' → ')}`);
  const res = L.executeMerge({
    o,
    plan,
    branch,
    currentBranch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    run,
    readEnvironment,
    // The push guard (hook-push-guard.mjs) does not see commands inside this script; so it is asked here too.
    guard: (environment) =>
      PRIVACY.assess(String(MIGR.pushCommand ?? ''), {
        branch: BASE,
        environment,
        baseBranch: BASE,
        migrations: MIGR,
      }),
    base: BASE,
    migrations: MIGR,
    // The last check before the task is marked done (M6): the track's tip is in base.
    beforeDone: () => {
      if (!containsCommit(trackTip, `refs/heads/${BASE}`))
        return (
          `NOT DONE: ${branch} at ${short(trackTip)} is not in ${BASE} (git merge-base --is-ancestor failed), so ${id} ` +
          'is not marked done and stays in review. Check git log on the base (was it reset or moved?) and merge again.'
        );
      // The wiring spec (lib/wiringItems.js): the merge is in, and the orchestrator applies the open items on the base
      // now. Read fresh: receive recorded them, and a `ravenseat wiring` call may have closed some since.
      const now = read().tasks.find((x) => x.id === id) ?? o;
      const refusals = [];
      if (!WI.stopOn(CONFIG)) {
        const off = WI.offLine(now, CLI);
        if (off) console.log(off);
      } else refusals.push(...(WI.refusalLines(now, { cli: CLI, base: BASE }) ?? []));
      // The review items (lib/reviewItems.js): each finding is fixed, placed or rejected before done.
      if (!RI.stopOn(CONFIG)) {
        const off = RI.offLine(now, CLI);
        if (off) console.log(off);
      } else refusals.push(...(RI.refusalLines(now, { cli: CLI }) ?? []));
      return refusals.length
        ? `${refusals.join('\n')}\n(${CLI} merge ${id} --resume runs done and fill once they are closed.)`
        : null;
    },
  });
  return {
    id, o, branch, trackTip, resume, keepReview, restLine, lockCtl, plan, mstate, saveState, res, mergeCode, mergeOut,
    notAsChecked, mergeCommit, baseSettled, baseLines, logFile, short, name, diffLines,
  };
}
