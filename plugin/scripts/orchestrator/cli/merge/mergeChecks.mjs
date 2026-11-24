// =============================================================
// cli/merge/mergeChecks.mjs: the first step of `ravenseat merge`: everything before the merge itself. The usage,
// the git surface stop, the merge lock, the in-progress refusal, the task's status and the resume cases, then (not on a
// resume) the stops on receive's findings: PARTIAL, a secret, files that must stay out of git, red quick gates (with
// ravenseat's own evidence on the tip: mergeGateKnown, mergeGateRun), focus markers, the catalog's stop rules, a fix
// without a red test and the review gate; then the base gate and the done command once more.
//
// Why a module: the merge flow in steps (SPLIT-1, see cli/merge.mjs, which runs checks, steps and the after-merge part
// in that order). Moved as it was: same output, exit codes and files. mergeChecks is cmdMerge up to the plan, cut at
// that seam; it returns null where cmdMerge returned, else what the steps read.
//
// Used by: cli/merge.mjs (cmdMerge).
// Tested in: __tests__/queueBaseGate.test.ts, __tests__/queueMergeResume.test.ts, __tests__/queueGateEvidence.test.ts,
//   __tests__/redteam/focusStop-cli.test.ts, __tests__/redteam/fixTest-cli.test.ts, __tests__/redteam/secretAtReceive-cli.test.ts,
//   __tests__/reviewItemsFlow.test.ts, __tests__/catalogChecksFlow.test.ts, __tests__/redteam/rt13-outside-files.test.ts.
// =============================================================

import { a, BASE, branchFor, branchInfo, CLI, CONFIG, die, edit, FOLDER, git, GIT_ROOT, L, positional, read, require } from '../context.mjs';
import { gitLarge, logTime, scratchpadFor } from '../tracks.mjs';
import { guardBeforeMerge } from '../baseHealth.mjs';
import { registerQuietly, registerReviewerDanger, registerReviewItems, reviewReports } from '../reviewItem.mjs';
import { doneCommandRed, GE_MODE, receiveGates, runDoneCommand, stopOnDrift, stopOnOwnerRows } from './evidence.mjs';
import { catalogRulesFor, secretWhere } from './receiveChecks.mjs';
import { containsCommit, gitPathOf, mergeCommitFor, ML, takeMergeLock } from './lock.mjs';
import { tidyAfterMerge } from './afterMerge.mjs';

const GB = require('./lib/gitSurfaceBaseline.js');
const CONTROLS = require('./lib/controls.js');
// The reviewers' findings as items that stop done, and the merge gate on the chosen reviewers (lib/reviewItems.js).
const RI = require('./lib/reviewItems.js');

/** Set by cmdMerge when mergeGateKnown found no evidence for the tip: the gates run after the base gate check. */
let gateRunPending = false;

/**
 * merge in mode own or external, before the merge: the quick gates on the track tip come from ravenseat's own evidence
 * (lib/gateEvidence.js), never from the task's gate_check in queue.json (a file a track can write). A green entry for
 * this tip and setup (the one receive recorded) is used as it is, so nothing runs twice; a red one stops. Returns
 * { stop: null | 'same-tip', run: boolean }: run = there is no evidence, so mergeGateRun runs the gates. No quick gates:
 * nothing to check.
 */
function mergeGateKnown(tip) {
  const GE = require('./lib/gateEvidence.js');
  const commands = CONTROLS.commandsOf(CONFIG.gates?.quick);
  if (!commands.length) return { stop: null, run: false };
  const known = GE.latest(GE.readStore(GE.storeFile(FOLDER)).entries, {
    sha: tip, kinds: ['quick', 'full'], commands, setupHash: GE.setupHash(CONFIG.gates), legacy: false,
  });
  if (!known) return { stop: null, run: true };
  if (known.ok !== true) return { stop: 'same-tip', run: false };
  const covered = GE.coverageLine(known);
  console.log(`Gates green at ${String(tip).slice(0, 12)} (${known.kind}, ravenseat's own run at ${known.time}${covered ? `, ${covered}` : ''}); not run again.`);
  return { stop: null, run: false };
}

/** The stop for a red quick gate before the merge (nothing was done). */
function dieGateRed(id, stop, tip) {
  die(
    `STOP: ${id} is not merged. ${stop === 'same-tip'
      ? `The quick gates were red on this exact commit (${String(tip).slice(0, 12)}). Fix it in a fix round: ${CLI} resume ${id}.`
      : `The quick gates were red at the last receive, and the commits since then have not been checked. Run ${CLI} receive ${id}.`} ` +
      `On the owner's word only: ${CLI} merge ${id} --force-red-gate (logged as "gate-red-overridden"). Nothing was done.`,
  );
}

/**
 * The quick gates run by merge itself on the track tip when there was no evidence for it (mergeGateKnown): in the
 * track's worktree (receiveGates, step merge), the record stored as the task's gate_check. Returns null (green) or
 * 'same-tip' (red), or dies for the owner when the run was tampered.
 */
function mergeGateRun(o, { branch, scratch }) {
  const r = receiveGates(o, { branch, scratch, step: 'merge' });
  if (r.tampered)
    die(GB.tamperedMessage({ what: 'the check run at merge', reason: r.tampered, ravenseat: CLI, again: `${CLI} merge ${o.id}` }));
  if (r.status === 'off') return null;
  // A fresh run's record goes into the queue (red: what resume and the fix brief read); a reused green one is there already.
  if (r.record.ran)
    edit((queue) => {
      const t = queue.tasks.find((x) => x.id === o.id);
      if (t) t.gate_check = r.record;
    });
  return r.status === 'red' ? 'same-tip' : null;
}

/**
 * The checks before the merge of `ravenseat merge` (the usage is at the top of queue.mjs). null when there is nothing to
 * do (a resume of a task that is done); a stop dies. Otherwise what the steps read.
 */
export async function mergeChecks() {
  const id = positional(1, ['--scratchpad', '--done-cwd'])[0];
  if (!id)
    die(
      'merge <id> [--resume] [--without-migr-push] [--without-fill] [--scratchpad <folder>] [--force] [--allow-guard] [--allow-partial] [--allow-focus] [--allow-catalog] [--allow-secret] [--allow-unreviewed] [--allow-no-test] [--force-red-base] [--force-red-gate]',
    );
  const resume = a.includes('--resume');
  // The merge guard's override (see lib/mergeGuard.js): passed on to merge-track.mjs, which logs it.
  const allowGuard = a.includes('--allow-guard');
  if (!read().tasks.some((x) => x.id === id)) die(`Unknown task ${id}`);
  // Before any git merge step, and also for --resume: the merge itself is what would run a planted hook. A merge cut off
  // part-way is still named, so whoever settles this knows what is left.
  stopOnDrift(`${CLI} merge ${id}${resume ? ' --resume' : ''}`, () => {
    const cut = ML.readState(FOLDER, id);
    const busy = ML.gitInProgress(gitPathOf);
    return [
      ...(cut ? [`A merge of ${id} was cut off earlier (steps done: ${cut.steps_done?.join(', ') || 'none'}): when this is settled, ${CLI} merge ${id} --resume goes on.`] : []),
      ...(busy.length ? [`git also has an unfinished ${busy.map((b) => b.kind).join(', ')} in ${GIT_ROOT}. Settle the above first: git commit there runs the hooks.`] : []),
    ];
  });
  // One merge at a time (review 2026-11-02, M8), before anything reads git or the queue for the merge.
  const lockCtl = takeMergeLock(id, { resume });
  const o = read().tasks.find((x) => x.id === id);
  if (!o) die(`Unknown task ${id}`);
  const branch = o.branch ?? branchFor(id);
  const branchTip = git(['rev-parse', '-q', '--verify', `refs/heads/${branch}`]);
  // An unfinished merge, rebase, cherry-pick or revert in the main checkout refuses the merge and the resume (M6).
  const busy = ML.gitInProgress(gitPathOf);
  if (busy.length) {
    const tasks = read().tasks;
    const tips = new Map();
    for (const t of tasks) {
      const b = t.branch ?? branchFor(t.id);
      const sha = git(['rev-parse', '-q', '--verify', `refs/heads/${b}`]);
      if (sha) tips.set(sha, b);
    }
    die(
      ML.inProgressMessage(busy, {
        root: GIT_ROOT,
        id,
        ravenseat: CLI,
        branch,
        branchTip,
        branchOf: (sha) => tips.get(sha) ?? null,
        taskOf: (b) => tasks.find((t) => (t.branch ?? branchFor(t.id)) === b)?.id ?? null,
      }),
    );
  }
  const state0 = ML.readState(FOLDER, id);
  const force = a.includes('--force');
  // A PARTIAL delivery (receive sets delivered_partial, a later finished delivery clears it): merged only with
  // --allow-partial, and then the task stays in review, since the track said the rest is not done. The flag stays until
  // a finished delivery is received; the merge never clears it. A resume of such a merge keeps it in review too.
  const keepReview = !!o.delivered_partial;
  const restLine = `${CLI} resume ${id} --reason context, then ${CLI} receive ${id} and ${CLI} merge ${id}`;
  // A partial merge that already went through has nothing left to resume: what is left is the rest of the task.
  if (resume && keepReview && !state0 && o.status === 'review' && o.merge_commit && containsCommit(branchTip, `refs/heads/${BASE}`))
    die(`${id} was merged with --allow-partial and stays in review: nothing of the merge is left to resume. The rest of the task remains: ${restLine}.`);
  if (resume) {
    const left = state0 ? ML.remainingSteps(state0.plan ?? [], state0.steps_done ?? []) : [];
    if (o.status === 'done' && !left.some((s) => s !== 'done')) {
      ML.clearState(FOLDER, id);
      console.log(`${id} is done; nothing to resume.`);
      // What an earlier cleanup left behind goes now. Merged work only: both steps refuse anything else.
      const leftBranch = o.branch ?? branchFor(id);
      if (branchInfo(leftBranch).exists) tidyAfterMerge(leftBranch, { resume: true, start: o.head_start });
      return null;
    }
    if (!['review', 'done'].includes(o.status) && !(force && ['running', 'picked'].includes(o.status)))
      die(`${id} has status ${o.status}; merge --resume applies to a task in review whose branch is already merged.`);
  } else if (o.status !== 'review' && !(force && ['running', 'picked'].includes(o.status)))
    die(
      `${id} has status ${o.status}; merge applies to review (after receive and an approved review). ` +
        '--force only for running/picked on the owner\'s word.',
    );
  // A merge of a running or picked task skips receive: logged like the other overrides (lib/guardLog.js counts it).
  if (force && ['running', 'picked'].includes(o.status)) logTime(id, 'force-merged', `status ${o.status}${resume ? ', resume' : ''}`);
  const gi = branchInfo(branch);
  if (!gi.exists) die(`Branch ${branch} does not exist.`);
  const trackTip = branchTip;
  const tipInBase = containsCommit(trackTip, `refs/heads/${BASE}`);
  if (resume && !tipInBase)
    die(
      `${branch} at ${String(trackTip).slice(0, 12)} is not in ${BASE}, so there is nothing to resume: the merge itself ` +
        `has not happened${gi.commits ? ` (${gi.commits} commit(s) ahead)` : ''}. Run ${CLI} merge ${id} (without --resume).`,
    );
  if (!resume && gi.commits === 0) {
    // A partial merge that went through (no merge state left): the branch is in base, and the task waits for the rest.
    if (tipInBase && o.status === 'review' && keepReview && !state0)
      die(
        `${branch} is already merged into ${BASE}: ${id} was merged with --allow-partial and stays in review until the rest ` +
          `is delivered. Next: ${restLine}. Nothing was done.`,
      );
    // M7: the branch is in base already. A task still in review was cut off after the merge (Ctrl-C, a crash, a stop
    // after the merge): the remaining steps are what is left, not a new merge.
    if (tipInBase && o.status === 'review')
      die(
        `${branch} is already merged into ${BASE} (its tip ${String(trackTip).slice(0, 12)} is on ${BASE}), but ${id} is ` +
          'still in review: the merge was cut off before the end' +
          `${state0?.steps_done?.length ? ` (steps done: ${state0.steps_done.join(', ')})` : ''}. ` +
          `Run the remaining steps (migration push, gates, base gate, done, fill) with: ${CLI} merge ${id} --resume`,
      );
    die(`${branch} has no commits ahead of ${BASE} (already merged?). Nothing completed.`);
  }
  const withoutFill = a.includes('--without-fill');
  const scratch = scratchpadFor(o.scratchpad ?? null);
  if (!scratch && !withoutFill)
    die('merge needs --scratchpad <folder> (or QUEUE_SCRATCHPAD) for fill, or --without-fill.');
  // The merge commit when resuming: the one recorded (still in base and holding the tip), otherwise the one found.
  const recorded = state0?.merge_commit ?? o.merge_commit ?? null;
  let resumeCommit = null;
  if (resume)
    resumeCommit =
      recorded && containsCommit(recorded, `refs/heads/${BASE}`) && containsCommit(trackTip, recorded)
        ? recorded
        : mergeCommitFor(trackTip, BASE);
  // The first parent of the merge commit: the base as it was before the merge (for the plan's diff when resuming).
  const beforeMerge = resumeCommit ? (git(['rev-parse', '-q', '--verify', `${resumeCommit}^1`]) ?? null) : null;
  // What receive found (lib/gateEvidence.js mergeStop): a red quick gate is a fix round, never a merge. The merge's own
  // gates run after the merge, so without this stop the red code is on the base branch before anyone says no. A resume
  // does not ask: the merge is in already.
  if (!resume) {
    // The owner rows the task relies on, against the owner log (owner decision B2): a row written into queue.json some
    // other way stops here, before any step.
    stopOnOwnerRows(id, `${CLI} merge ${id} again`);
    if (o.delivered_partial && !a.includes('--allow-partial'))
      die(
        `STOP: ${id} is not merged. Its last receive was a PARTIAL delivery: unfinished, and no gates ran on it. Next: ${CLI} resume ${id} --reason context${L.openBlockOf(o)?.code === 'track-question' ? ' --answer "<text>"' : ''}, then ${CLI} receive ${id}. ` +
          `On the owner's word only: ${CLI} merge ${id} --allow-partial (logged as "partial-overridden"). Nothing was done.`,
      );
    if (o.delivered_partial) {
      logTime(id, 'partial-overridden', `tip ${String(trackTip).slice(0, 12)}`);
      console.log(`WARNING: --allow-partial: merging ${id}, which the track itself called unfinished; logged as "partial-overridden".`);
    }
    // The secret scan at receive (H5): a hit stops the merge until a clean receive. The record on the task decides (an
    // open secret-found block too, when the record was removed by hand); --allow-secret is the owner's, logged.
    const secretOpen = L.openBlockOf(o)?.code === 'secret-found';
    if (o.secret_found || secretOpen) {
      const where = (o.secret_found?.hits ?? []).slice(0, 5).map(secretWhere).join(', ') || L.openBlockOf(o)?.note || 'see ravenseat blockers';
      if (!a.includes('--allow-secret'))
        die(
          `STOP: ${id} is not merged. Receive found possible secret(s) in its commits: ${where}. Every commit is merged with ` +
            `its history, so a fix round takes the key out of the branch (rewrite the commits that added it, ${CLI} resume ${id} --reason fix), ` +
            `then ${CLI} receive ${id}; a real key must be changed. A false alarm, on the owner's word only: ${CLI} merge ${id} --allow-secret ` +
            '(logged as "secret-overridden"). Nothing was done.',
        );
      logTime(id, 'secret-overridden', `tip ${String(trackTip).slice(0, 12)}: ${where}`);
      console.log(`WARNING: --allow-secret: merging ${id} past the secret found at receive (${where}); logged as "secret-overridden".`);
    }
    // What must stay out of git (H3 share, H4 privatePaths; lib/queueShare.js denyReason, the same rule as the push
    // hook): a track that adds or changes a data folder file that is not shared, or a file under a private path, is not
    // merged, since the base branch would then carry it to the next push. No override flag: the way out is to take the
    // file out of the track's commits. While share is on, the repo's visibility is asked again when the cached answer
    // is older than a day (lib/repoVisibility.js, a short time limit; no answer is unknown, which counts as public).
    {
      const QS = require('./lib/queueShare.js');
      const RV = require('./lib/repoVisibility.js');
      const changed = (git(['diff', '--name-only', '--diff-filter=ACMR', `refs/heads/${BASE}...${trackTip}`, '--']) ?? '')
        .split(/\r?\n/)
        .filter(Boolean);
      let cache = null;
      if (QS.shareOf(CONFIG).on && changed.some((f) => QS.sharedFile(f, CONFIG))) {
        try {
          cache = await RV.current({ folder: FOLDER, remoteUrl: RV.remoteUrlOf(GIT_ROOT, CONFIG.remote) });
        } catch {
          cache = RV.readCache(FOLDER, { any: true });
        }
      }
      const refused = QS.denyReason({ files: changed, cfg: CONFIG, cache, cli: CLI });
      if (refused)
        die(
          `STOP: ${id} is not merged. ${refused} The commits are the track's: a fix round takes the file out of its branch ` +
            `(${CLI} resume ${id} --reason fix), then ${CLI} receive ${id}. Nothing was done.`,
        );
    }
    // gateEvidence.mode own and external: ravenseat's own evidence on the tip decides (mergeGateKnown); a red one stops
    // here, and with none the gates run after the base gate check below (mergeGateRun), so a red base gets its own stop
    // first. off, and --force-red-gate: the record in queue.json, as before (only a recorded red stops).
    const known = GE_MODE === 'off' || a.includes('--force-red-gate') ? null : mergeGateKnown(trackTip);
    const stop = known ? known.stop : require('./lib/gateEvidence.js').mergeStop(o.gate_check, trackTip);
    gateRunPending = known?.run === true;
    if (stop && !a.includes('--force-red-gate')) dieGateRed(id, stop, trackTip);
    // A focus marker (.only, fit, fdescribe) on an added line in a test file (lib/testWeakening.js focusHits): the gates
    // were green while most tests never ran. The one test-weakening finding that stops; testWeakening.focusStop false = off.
    if (CONFIG.testWeakening?.enabled !== false && CONFIG.testWeakening?.focusStop !== false) {
      const TW = require('./lib/testWeakening.js');
      const focus = TW.focusHits(TW.assess(gitLarge(['diff', `${BASE}...${trackTip}`]) ?? '', CONFIG.testWeakening));
      if (focus.length && !a.includes('--allow-focus'))
        die(
          `STOP: ${id} is not merged. It adds ${focus.length} focus marker(s), which make the runner skip the other tests: ` +
            `${focus.slice(0, 5).map((f) => `${f.path} (${f.line.trim().slice(0, 60)})`).join(', ')}. ` +
            `Remove them in a fix round: ${CLI} resume ${id} --reason fix. On the owner's word only: ${CLI} merge ${id} --allow-focus ` +
            '(logged as "focus-overridden"). Nothing was done.',
        );
      if (focus.length) {
        logTime(id, 'focus-overridden', `${focus.length} focus marker(s), tip ${String(trackTip).slice(0, 12)}`);
        console.log(`WARNING: --allow-focus: merging ${id} with ${focus.length} focus marker(s); logged as "focus-overridden".`);
      }
    }
    // A check rule in mode stop of a design choice the owner accepted (lib/catalogChecks.js, bolk B6): tried again here on
    // the merge's own diff, so commits after receive cannot slip past it. Only with catalog.checkStop on (off by default);
    // --allow-catalog is the owner's, logged.
    if (require('./lib/catalog.js').setupOf(CONFIG).checkStop) {
      const rules = catalogRulesFor(id, gitLarge(['diff', `${BASE}...${trackTip}`]) ?? '');
      for (const l of rules.lines) console.log(l);
      const catalogStop = require('./lib/catalogChecks.js').mergeStop(rules.result, { id, cli: CLI });
      if (catalogStop && !a.includes('--allow-catalog')) die(catalogStop);
      if (catalogStop) {
        const ids = rules.result.rules.filter((x) => x.level === 'stop').map((x) => x.id);
        logTime(id, 'catalog-overridden', `${ids.join(', ')}, tip ${String(trackTip).slice(0, 12)}`);
        console.log(`WARNING: --allow-catalog: merging ${id} past the stop rule(s) of ${ids.join(', ')}; logged as "catalog-overridden".`);
      }
    }
    // A fix without a proven red test (lib/fixTests.js): a stop only in the strict mode (gates.redOnBaseStrict, off by
    // default); the default is the warning receive printed. --allow-no-test is the owner's, logged.
    const noTest = require('./lib/fixTests.js').mergeStop(o, { config: CONFIG, cli: CLI });
    if (noTest && !a.includes('--allow-no-test')) die(noTest);
    if (noTest) {
      logTime(id, 'no-test-overridden', `tip ${String(trackTip).slice(0, 12)}, red on base ${o.red_on_base?.verdict ?? 'off'}`);
      console.log(`WARNING: --allow-no-test: merging ${id}, a fix without a proven red test; logged as "no-test-overridden".`);
    }
    if (stop) {
      logTime(id, 'gate-red-overridden', `tip ${String(trackTip).slice(0, 12)}, receive said red at ${String(o.gate_check.tip).slice(0, 12)}`);
      console.log(`WARNING: --force-red-gate: merging ${id} past a red quick gate; logged as "gate-red-overridden".`);
    }
    // The review (lib/reviewItems.js): every FINDING line becomes an item on the task (passive; done names them), and
    // the gate wants a FINDINGS report after the last receive from each reviewer receive chose, with no HIGH in the
    // newest one. Without it the choice of reviewers is only advice: a D+ task could be merged with no security review,
    // or with its HIGH still open. --allow-unreviewed is the owner's, logged.
    const reports = reviewReports(o);
    registerReviewItems(id, reports);
    // The reviewers' door and blast radius next to the track's (MS-1): display only, never part of the gate below.
    registerReviewerDanger(o);
    if (RI.requireOn(CONFIG)) {
      const gate = RI.reviewGate({ required: o.review_reviewers, since: o.review_at ?? o.t_receive ?? null, reports });
      const lines = RI.gateLines(id, gate, { cli: CLI });
      if (lines && !a.includes('--allow-unreviewed')) die(lines.join('\n'));
      if (lines) {
        const what = [...gate.missing.map((t) => `${t} missing`), ...gate.high.map((h) => `${h.type} H=${h.H}`)].join(', ');
        logTime(id, 'unreviewed-overridden', `tip ${String(trackTip).slice(0, 12)}: ${what}`);
        console.log(`WARNING: --allow-unreviewed: merging ${id} past the review gate (${what}); logged as "unreviewed-overridden".`);
      }
    }
  } else registerQuietly(o); // a resume: the merge is in, but done still needs the items
  // The base gate (lib/baseHealth.js) BEFORE anything else runs: a red base refuses the merge (exit 9) unless this is the
  // base fix task or --force-red-base (logged); an unknown verdict (the tip moved since the last check) is checked first.
  // `wasRed` is the red record the merge goes on despite, so the record after it keeps the merge that made it red.
  // A resume does not ask: the merge is in already, and the base gate on it is one of the steps that are left.
  const wasRed = resume ? null : guardBeforeMerge({ id, force: a.includes('--force-red-base'), folder: scratch ?? FOLDER });
  // gateEvidence.mode own and external with no evidence for the tip (mergeGateKnown above): the quick gates run now in
  // the track's worktree, before the merge. Red: a fix round, never a merge.
  if (!resume && gateRunPending) {
    const s = mergeGateRun(o, { branch, scratch });
    if (s) dieGateRed(id, s, trackTip);
  }
  // The done command (lib/doneCheck.js) once more before the merge, unless the last run was green on this exact tip with
  // this command (receive ran it, and no fix round has added commits since). Red: a fix round, never a merge.
  // B2 follow-up: under gateEvidence.mode own and external the skip rests on ravenseat's own done entry in the evidence
  // store (runDoneCommand writes it), never on done_check in queue.json, which a track can write. Under off, done_check
  // decides as before.
  if (typeof o.done_when === 'string' && o.done_when.trim()) {
    const tipNow = git(['rev-parse', '--verify', `refs/heads/${branch}`]);
    const command = o.done_when.trim();
    let skip = null;
    if (GE_MODE === 'off') {
      const last = o.done_check;
      if (last?.ok && last.tip === tipNow && last.command === command) skip = `${last.step}, ${last.at}`;
    } else {
      const GE = require('./lib/gateEvidence.js');
      const known = GE.latestDone(GE.readStore(GE.storeFile(FOLDER)).entries, { sha: tipNow, command, task: id });
      if (known?.ok === true) skip = `${known.step}, ravenseat's own run at ${known.time}`;
    }
    if (skip) console.log(`Done command green at ${String(tipNow).slice(0, 12)} (${skip}); not run again.`);
    else {
      const check = runDoneCommand(o, { branch, scratch, step: 'merge' });
      if (check.record.tampered)
        die(GB.tamperedMessage({ what: 'the done command', reason: check.record.tamper_reason, ravenseat: CLI, again: `${CLI} merge ${id}` }));
      edit((queue) => {
        const x = queue.tasks.find((y) => y.id === id);
        x.done_check = check.record;
        if (!check.ok) L.openBlock(x, 'gate-red', { note: `done command red before merge (exit ${check.run.exit ?? '?'})` });
        return null;
      });
      if (!check.ok) doneCommandRed(id, check, { scratch });
    }
  }
  return {
    id, resume, allowGuard, lockCtl, o, branch, trackTip, state0, keepReview, restLine, withoutFill, scratch, resumeCommit,
    beforeMerge, wasRed,
  };
}
