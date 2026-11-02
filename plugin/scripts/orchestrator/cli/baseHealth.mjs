// =============================================================
// cli/baseHealth.mjs: the I/O of the base gate (lib/baseHealth.js): the state file, the check in the main checkout,
// the guard before `cq merge`, the verdict after it (with the base fix task) and the one line for show and the pulse.
//
// Why a module of its own: cli/merge.mjs is the merge flow; the base gate adds a guard before it and a record after it,
// and show/pulse need the line without importing the merge command. The rules (when to check, when to refuse, the
// skip rule, the fix task) are pure functions in lib/baseHealth.js; here is only the git, file and queue I/O.
//
// Used by: cli/merge.mjs (cmdMerge), cli/view.mjs (show), cli/orchestrator.mjs (pulse).
// Tested in: __tests__/queueBaseGate.test.ts (cq merge against temporary repos), lib/__tests__/baseHealth.test.ts.
// =============================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  BASE, CONFIG, CQ, die, edit, FOLDER, git, GIT_ROOT, L, P, readPlans, readQueueForPlan, require, TIME_LOG, withLock,
  writePlans,
} from './context.mjs';

const BH = require('./lib/baseHealth.js');
const FI = require('./lib/queueFindings.js');
const TL = require('./lib/timeLogRows.js');
const ER = require('./lib/eventRows.js');
const GE = require('./lib/gateEvidence.js');

/** The resolved setup (config().baseGate with the defaults; off without commands or with enabled: false). */
export const BASE_SETUP = BH.baseGateSetup(CONFIG);
/** The state file: the verdict per base tip (lib/baseHealth.js, "The state file"). */
export const HEALTH_FILE = path.join(FOLDER, 'base-health.json');

const short = (sha) => String(sha ?? '').slice(0, 12);

/** The base branch's tip (the ref, not HEAD: the main checkout may be elsewhere), or null. */
export function baseTip() {
  return git(['rev-parse', '--verify', '-q', `refs/heads/${BASE}`]);
}

/** The recorded state (an empty one when the file is missing or broken). */
export function readHealth() {
  return BH.readState(HEALTH_FILE);
}

/** The one line for show and the pulse; null when the feature is off. Never throws (a status line must not stop show). */
export function baseHealthLine() {
  if (!BASE_SETUP.enabled) return null;
  try {
    return BH.healthLine({ state: readHealth(), tip: baseTip(), setup: BASE_SETUP, branch: BASE, cq: CQ });
  } catch {
    return null;
  }
}

/** The tracked changes in the main checkout (`git status` without untracked files), as text. */
function trackedChanges() {
  const r = spawnSync('git', ['-C', GIT_ROOT, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' });
  return (r.stdout ?? '').trim();
}

/**
 * Runs the base gate commands in the main checkout now and writes the report (the tail only) to
 * `<folder>/base-health-<sha>.md`. Warns when the checkout had or got tracked changes: the commands then saw files that
 * are not on the tip, and the checkout is left as it is (the queue never cleans up someone's changes).
 * @returns {{ run: object, file: string }}
 */
export function runCheckNow({ tip, folder, cause = null }) {
  const before = trackedChanges();
  if (before)
    console.log(`WARNING: the main checkout ${GIT_ROOT} has uncommitted changes; the base gate also sees them (they are not on ${BASE}).`);
  console.log(
    `BASE GATE on ${BASE} at ${short(tip)} in ${GIT_ROOT}: ${BASE_SETUP.commands.join(' ; ')}  ` +
      `(time budget ${BASE_SETUP.timeoutSec} s)`,
  );
  let run = BH.runBaseGate({
    commands: BASE_SETUP.commands,
    cwd: GIT_ROOT,
    timeoutSec: BASE_SETUP.timeoutSec,
    tailLines: BASE_SETUP.tailLines,
  });
  // The flaky check: the red command (and the ones after it, which never ran) once more on the same sha.
  if (!run.ok) {
    const again = rerunFailed({ tip, commands: BH.afterFailed(BASE_SETUP.commands, run.failed) });
    if (again) {
      run = BH.flakyResult({ first: run, rerun: again, firstFailed: [run.failed] });
      flakyLines({ tip, run, causeId: cause?.task ?? null, source: 'base gate' });
    }
  }
  const after = trackedChanges();
  if (after !== before)
    console.log(
      `WARNING: the base gate changed tracked files in the main checkout (${GIT_ROOT}); they are left as they are. ` +
        'See git status there; a gate should not write tracked files.',
    );
  console.log(`Base gate ${run.ok ? 'GREEN' : 'RED'} (${run.timedOut ? 'time budget' : `exit ${run.exit ?? '?'}`}, ${run.durationSec} s).`);
  const file = writeReport({ folder, tip, run, cause });
  return { run, file };
}

/**
 * The flaky check's rerun: `commands` once more in the main checkout, only when baseGate.flakyRerun is on and the
 * checkout is still on exactly `tip` (a rerun on another commit would prove nothing). null when it does not run.
 */
function rerunFailed({ tip, commands }) {
  if (!BASE_SETUP.flakyRerun || !commands.length) return null;
  if (git(['rev-parse', 'HEAD']) !== tip) return null;
  console.log(`Base gate red: running the failed command(s) once more on the same sha (${short(tip)}): ${commands.join(' ; ')}`);
  return BH.runBaseGate({ commands, cwd: GIT_ROOT, timeoutSec: BASE_SETUP.timeoutSec, tailLines: BASE_SETUP.tailLines });
}

/** The lines after a flaky check, and on green the finding and the flakyGate row (fileFlaky). */
function flakyLines({ tip, run, causeId, source }) {
  if (!run.ok) {
    console.log(`Base gate red again on a rerun of \`${run.failed ?? '?'}\` on the same sha (${short(tip)}): not flaky, the base is frozen.`);
    return;
  }
  const finding = fileFlaky({ commands: run.flaky, tip, causeId, source });
  for (const c of run.flaky)
    console.log(
      `FLAKY: \`${c}\` was red, then green on a rerun on the same sha (${short(tip)}); the base is not frozen.` +
        (finding ? ` Finding ${finding} (${CQ} finding list).` : ''),
    );
}

/**
 * Records a flaky command: one `flakyGate` row in the time log (measurement; cq cost Flow counts them) and a finding
 * in the plan register per command (deduplicated on the title, so a command that is flaky again counts on the same
 * entry). The project: the merged task's, else the only registered one; without one only the row is written.
 * Never throws (a flaky record must not stop the merge flow).
 * @returns {string|null} the finding id (the first command's), or null
 */
function fileFlaky({ commands, tip, causeId = null, source }) {
  try {
    TL.appendRows(TIME_LOG, ER.flakyGateRow({ tip, commands, source, task: causeId }));
  } catch {
    // error-ignored: measurement only
  }
  try {
    return withLock(() => {
      const queue = readQueueForPlan();
      const projects = queue.projects ?? {};
      const task = causeId ? (queue.tasks ?? []).find((t) => t.id === causeId) : null;
      const own = task ? L.projectFor(task, projects) : null;
      const names = Object.keys(projects);
      const project = own && Object.hasOwn(projects, own) ? own : names.length === 1 ? names[0] : null;
      if (!project) {
        console.log(`NOTE: no registered project to file the flaky finding under (${CQ} project <pid>); the time log has the row.`);
        return null;
      }
      const reg = readPlans();
      const before = JSON.parse(JSON.stringify({ entries: reg.entries, archive: reg.archive, documents: reg.documents }));
      let first = null;
      for (const c of commands) {
        const r = FI.recordFinding(
          reg,
          {
            title: `Flaky gate command: ${c}`.slice(0, 200),
            detail:
              `Red, then green on a rerun on the same commit ${tip} (${source}, ${BASE}). Not frozen. ` +
              'Make the command deterministic or take it out of the gate.',
            task: null,
            files: [],
            project,
          },
          { projects, question: queue.question ?? {} },
        );
        if (!r.error?.length) first ??= r.entry?.id ?? r.duplicate ?? null;
      }
      const entry = P.logChange(reg, { by: source, action: 'finding', changes: P.planDiff(before, reg) });
      if (entry) writePlans(reg);
      return first;
    });
  } catch {
    return null; // error-ignored: the row above is the measurement; the finding is a convenience
  }
}

/**
 * The flaky check for the merge step's red quick gates (cli/merge.mjs): the failed commands from the gate evidence the
 * run recorded for `tip` (gates.mjs --evidence; all the quick gates when none is found) once more on the same sha.
 * Green: the lines and the record, and the green run for the verdict ({ run }). Red again or off: null (the caller
 * freezes as before).
 */
export function flakyRecheck({ tip, causeId = null }) {
  if (!BASE_SETUP.enabled || !BASE_SETUP.flakyRerun || !tip) return null;
  const quick = (CONFIG.gates?.quick ?? []).filter((g) => typeof g === 'string' && g.trim());
  const entry = gateRowsNow().filter((e) => e?.sha === tip && e.kind === 'quick').at(-1);
  const failed = entry?.failed?.length ? entry.failed : quick;
  const again = rerunFailed({ tip, commands: failed });
  if (!again) return null;
  const run = BH.flakyResult({ first: { durationSec: null }, rerun: again, firstFailed: failed });
  flakyLines({ tip, run, causeId, source: 'quick gates after a merge' });
  return run.ok ? { run } : null;
}

/** Writes the report for a check and returns its path. */
export function writeReport({ folder, tip, run, cause = null }) {
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `base-health-${short(tip)}.md`);
  fs.writeFileSync(
    file,
    BH.baseReport({ branch: BASE, tip, run, commands: BASE_SETUP.commands, cause, cwd: GIT_ROOT }),
  );
  return file;
}

/**
 * Records the verdict for `tip`. Green: the current record, the red state is cleared. Red: the base fix task is added,
 * or the open one is reused (the task that is being merged is never reused: it is set done right after), and the record
 * names the merge that made it red. When the base was already red before this merge (`wasRed`: a forced merge or the
 * fix task itself), the record keeps the merge that first made it red.
 * `fixTask`: a fix task the caller already added (the CI watch, CI-<sha7>) is the record's fix task and no base fix
 * task is added. A green `run` with `flaky` (the flaky check) records `flaky` and a note.
 * @returns {{ entry: object, previous: object|null, fix: { id: string, reused: boolean } | null }}
 */
export function recordVerdict({
  tip, ok, run = null, file = null, causeId = null, wasRed = null, skipped = null, note = null, fixTask = null,
}) {
  const state = readHealth();
  const previous = state.current;
  const at = new Date().toISOString();
  const base = { tip, branch: BASE, status: ok ? 'green' : 'red', at, commands: BASE_SETUP.commands };
  if (ok) {
    const flaky = run?.flaky?.length ? { flaky: run.flaky, note: note ?? `flaky: green on a rerun of ${run.flaky.join(', ')}` } : {};
    const entry = { ...base, ...(skipped ? { skipped } : {}), ...(note ? { note } : {}), ...flaky };
    BH.writeState(HEALTH_FILE, BH.record(state, entry));
    logBaseGate({ entry, run });
    return { entry, previous, fix: null };
  }
  // Already red before this merge: this merge did not make it red, so the earlier cause (possibly none) is kept.
  const madeRedBy = wasRed ? (wasRed.made_red_by ?? null) : causeId ? { task: causeId, merge_commit: tip } : null;
  // A fix task the caller already added (the CI watch: CI-<sha7>) is the fix task; no base fix task is added then.
  const fix = fixTask ? { id: fixTask, reused: true } : edit((queue) => {
    const tasks = queue.tasks ?? (queue.tasks = []);
    const candidate = wasRed?.fix_task ?? (previous?.status === 'red' ? previous.fix_task : null);
    const open = candidate ? tasks.find((t) => t.id === candidate) : null;
    if (open && !['done', 'cancelled'].includes(open.status) && open.id !== causeId) {
      open.remarks = [...(open.remarks ?? []), `${at} base gate still red at ${short(tip)} (report ${file})`];
      return { id: open.id, reused: true };
    }
    // The task to blame (and to number the fix task from): the one whose merge made it red, never a merge that only
    // went on despite red (forced, or the fix task that did not fix it: its successor numbers on, A-BASE1 -> A-BASE2).
    const blameId = madeRedBy?.task ?? null;
    const causeTask = blameId ? (tasks.find((t) => t.id === blameId) ?? { id: blameId }) : null;
    const pid = causeTask ? L.projectFor(causeTask, queue.projects ?? {}) : null;
    const task = BH.fixTask({
      tasks,
      causeTask,
      tip,
      branch: BASE,
      commands: BASE_SETUP.commands,
      tailFile: file,
      failed: run?.failed ?? null,
      project: causeTask?.project ?? (pid && pid !== L.WITHOUT_PROJECT ? pid : null),
    });
    // As qaDeviation: no register check here (the project is inherited from the merged task).
    const errors = L.validate(task, tasks);
    if (errors.length) {
      console.log(`WARNING: the base fix task ${task.id} could not be added: ${errors.join('; ')}. Add one by hand.`);
      return null;
    }
    task.status = L.statusAtAdd(task, tasks);
    task.added_at = at;
    tasks.push(task);
    return { id: task.id, reused: false };
  });
  const entry = {
    ...base,
    ...(madeRedBy ? { made_red_by: madeRedBy } : {}),
    ...(fix ? { fix_task: fix.id } : {}),
    ...(file ? { tail_file: file } : {}),
    ...(run?.failed ? { failed: run.failed } : {}),
    ...(run && run.exit != null ? { exit: run.exit } : {}),
    ...(run?.timedOut ? { timed_out: true } : {}),
    ...(note ? { note } : {}),
  };
  BH.writeState(HEALTH_FILE, BH.record(state, entry));
  logBaseGate({ entry, run });
  return { entry, previous, fix };
}

/** The baseGate row for a recorded verdict (lib/eventRows.js). Fail open: never stops the merge flow. */
function logBaseGate({ entry, run }) {
  try {
    TL.appendRows(
      TIME_LOG,
      ER.baseGateRow({
        time: entry.at,
        tip: entry.tip,
        ok: entry.status === 'green',
        skipped: entry.skipped ?? null,
        run,
        madeRedBy: entry.made_red_by ?? null,
        fixTask: entry.fix_task ?? null,
        note: entry.note ?? null,
      }),
    );
  } catch {
    // error-ignored: measurement only
  }
}

/** The orchestrator instruction after a red verdict (printed last, where it is read). */
export function redLines({ entry, run, fix, causeId = null, stayedInReview = false }) {
  const tail = run?.tail ?? [];
  const by = entry.made_red_by;
  const lines = [
    `BASE RED: ${BASE} is red at ${short(entry.tip)}` +
      (by ? ` after the merge of ${by.task} (merge commit ${short(by.merge_commit)})` : '') +
      (run?.failed ? `: \`${run.failed}\` ${run.timedOut ? 'went over the time budget' : `exit ${run.exit ?? '?'}`}` : '') +
      '.',
    ...BH.excerpt(tail).map((l) => `  | ${l}`),
    ...(entry.tail_file ? [`Output tail: ${entry.tail_file}`] : []),
    `The merge stays (no automatic revert). ${CQ} merge refuses every other track until ${BASE} is green again (exit ${BH.EXIT_RED_BASE}).`,
  ];
  if (fix)
    lines.push(
      fix.reused
        ? `Fix task: ${fix.id} is still open; it fixes this too. Merge it with ${CQ} merge ${fix.id} (allowed while the base is red).`
        : `Fix task: ${fix.id} (value 10${causeId ? `, fixes ${causeId}` : ''}, done command = the base gate) was added. ` +
            `Start it now (${CQ} fill), then merge it with ${CQ} merge ${fix.id} (allowed while the base is red).`,
    );
  if (stayedInReview && causeId)
    lines.push(
      `${causeId} stays in review (the gates step stopped the merge flow): when ${fix?.id ?? 'the fix'} is merged and the ` +
        `base is green, run ${CQ} set ${causeId} done.`,
    );
  if (by?.merge_commit)
    lines.push(
      `Undo instead (by hand, never done automatically): git -C "${GIT_ROOT}" revert -m 1 ${by.merge_commit}; the next ` +
        `${CQ} merge checks the base again${fix && !fix.reused ? ` (then cancel ${fix.id})` : ''}.`,
    );
  lines.push(`One merge on a red base anyway (logged as "base-red-overridden"): ${CQ} merge <id> --force-red-base`);
  return lines;
}

/**
 * The guard before `cq merge <id>`: the verdict for the base tip, the check first when it is unknown, and the refusal
 * (exit 9) while it is red, except for the open base fix task or with --force-red-base (logged in the time log).
 * @returns {object|null} the red record the merge goes on despite (forced, or the fix task), else null
 */
export function guardBeforeMerge({ id, force, folder }) {
  if (!BASE_SETUP.enabled) return null;
  const tip = baseTip();
  if (!tip) return null; // no base branch: the merge itself says so
  let state = readHealth();
  if (BH.verdict(state, tip) === 'unknown') {
    const head = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const headSha = git(['rev-parse', 'HEAD']);
    if (head !== BASE || headSha !== tip)
      die(
        `The base gate cannot check ${BASE}: the main checkout ${GIT_ROOT} is on ${head ?? 'an unknown branch'}` +
          `${head === BASE ? ` at ${short(headSha)}, not ${short(tip)}` : ''}. Check ${BASE} out there first. Nothing was done.`,
      );
    const c = state.current;
    console.log(
      `Base health of ${BASE} at ${short(tip)} is unknown (${c ? `the last check was at ${short(c.tip)}` : 'never checked'}): ` +
        'checking it before the merge.',
    );
    const check = runCheckNow({ tip, folder });
    const v = recordVerdict({ tip, ok: check.run.ok, run: check.run, file: check.file, note: `checked before merging ${id}` });
    if (!check.run.ok) for (const l of redLines({ entry: v.entry, run: check.run, fix: v.fix })) console.log(l);
    state = readHealth();
  }
  const m = BH.mergeAllowed({ state, tip, id, force });
  const current = state.current;
  if (!m.allow) {
    const by = current.made_red_by ? ` (made red by the merge of ${current.made_red_by.task})` : '';
    console.log(
      `STOP: ${BASE} is red at ${short(tip)}${by}; ${id} is not merged on a red base.` +
        (m.fixTask ? ` Merge the fix task first: ${CQ} merge ${m.fixTask}.` : ' Fix the base first.') +
        `${current.tail_file ? ` Output tail: ${current.tail_file}.` : ''}\n` +
        `On the owner's word only: ${CQ} merge ${id} --force-red-base (logged as "base-red-overridden"). Nothing was done.`,
    );
    process.exit(BH.EXIT_RED_BASE);
  }
  if (BH.verdict(state, tip) !== 'red') return null;
  if (m.forced) {
    TL.appendRows(TIME_LOG, {
      time: new Date().toISOString(),
      event: 'base-red-overridden',
      track: id,
      branch: BASE,
      tip,
      fix_task: m.fixTask,
    });
    console.log(`WARNING: --force-red-base: merging ${id} on a red ${BASE} (${short(tip)}); logged as "base-red-overridden".`);
  } else console.log(`${BASE} is red at ${short(tip)}; merging the base fix task ${id}.`);
  return current;
}

/**
 * The trusted gate runs for the skip rule: the gate evidence store (lib/gateEvidence.js), written by gates.mjs only for
 * the orchestrator's own runs (cq receive, cq merge, the main checkout). NOT the time log: every agent can append a
 * `gate` row there, so a row in it proves nothing. An empty list when the store is missing or broken (the check runs).
 */
export function gateRowsNow() {
  return GE.readStore(GE.storeFile(FOLDER)).entries;
}

/** The tree of a commit (for the skip rule), or null. */
export function treeOf(sha) {
  return git(['rev-parse', `${sha}^{tree}`]);
}

// Re-exported so cli/merge.mjs needs only this module for the base gate.
export { BH };
