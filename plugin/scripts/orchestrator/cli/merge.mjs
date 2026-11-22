// =============================================================
// cli/merge.mjs: the commands that finish work: receive, merge, block, unblock, blockers, deliver, release, deliveries, next-migr, migr.
//
// receive (take in a finished track), merge (merge-track.mjs, the gates and the migration push, with the merge guard
// and the base gate of cli/baseHealth.mjs: a red base branch refuses the merge, a merge that makes it red adds a fix task),
// the merge blocks, deliver/release of a picked task, deliveries (a track-result.md that has not been received yet), and the
// migration number blocks (next-migr, migr). merge holds the merge lock, refuses while git has a merge (or rebase,
// cherry-pick, revert) in progress, checks that the track tip is in base before done, records each step in the merge
// state and continues a cut-off merge with --resume (lib/mergeLock.js).
//
// Why a module: queue.mjs was one file of about 6,300 lines. It is now a thin entry point (the usage comment and the
// dispatch on the command word) plus the modules in cli/. The code was moved as it was: same output, exit codes and files.
//
// Used by: queue.mjs (dispatch).
// Tested in: lib/__tests__/queueOrchestrator.test.ts, mergeGuard.test.ts, queueBlockers.test.ts, queueMigrBlock.test.ts,
//   queueExternal.test.ts, __tests__/queueAdopt.test.ts, __tests__/queueBaseGate.test.ts, __tests__/queueMergeResume.test.ts.
// =============================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import {
  a, autoCleanFocus, BASE, branchFor, branchInfo, CONFIG, CLI, die, edit, focusCleanOut, FOLDER, G, git, GIT_ROOT, HELP,
  HERE, L, MAIN_TREE, MIGR, parallelWarning, positional, pulseCursor, read, require, TIME_LOG, TK, val,
} from './context.mjs';
import {
  blockList, findDeliveries, gitLarge, highestMigr, lastTrackReply, logTime, mergeBlock, minutes, readTimeLog,
  attemptRows, controlWhere, missionMark, reviewerFindingsLines, scratchpadFor, syncAttempts, takenForMigr, taskAgents, trackReport,
} from './tracks.mjs';
import {
  BASE_SETUP, BH, fileFlaky, flakyRecheck, gateRowsNow, guardBeforeMerge, HEALTH_FILE, recordVerdict, redLines, runCheckNow, treeOf,
  writeReport,
} from './baseHealth.mjs';
import { logEvent } from './events.mjs';
import { cleanupDetachedOf, cleanupWorktree } from '../cleanup-worktree.mjs';
import { proposeGate } from './gate.mjs';
import { registerQuietly, registerReviewItems, reviewReports } from './reviewItem.mjs';
import { catalogRules, proposeRuleGates, stackChoicesNow } from './catalog.mjs';
import { notBuildingLines } from './notBuilding.mjs';
import { tidyOptions } from './tidy.mjs';

const ER = require('./lib/eventRows.js');
const CP = require('./lib/conflictPredict.js');
const AT = require('./lib/logic/attempt.js');
const GB = require('./lib/gitSurfaceBaseline.js');
const CONTROLS = require('./lib/controls.js');
const GUIDANCE = require('./lib/guidance.js');
// The wiring spec as open items that stop done (receive records them, merge's done step checks them).
const WI = require('./lib/wiringItems.js');
// The reviewers' findings as items that stop done, and the merge gate on the chosen reviewers (lib/reviewItems.js).
const RI = require('./lib/reviewItems.js');
// What receive and merge catch, as rows in the finding log (passive: at most a warning when a write fails).
const FSRC = require('./lib/findingSources.js');

// ---- The git hooks and config against the accepted baseline (lib/gitSurfaceBaseline.js) -------------------------------

/**
 * The stop at the top of receive and merge, before any git command that could run a hook: records the baseline on first
 * use, and on a difference stops (exit 1, nothing changed: no status, no blocker, no fix round). It is sticky until the
 * owner removes the difference or accepts it, or sets config gitSurface to warn or off (GB.stopDetail).
 */
function stopOnDrift(again, extra = () => []) {
  // A baseline written just now is the state just read: there is nothing to compare, so it is not read a second time.
  if (GB.ensure(FOLDER, GIT_ROOT)) return;
  const detail = GB.stopDetail(FOLDER, GIT_ROOT, { ravenseat: CLI });
  if (detail) die([GB.driftMessage({ ...detail, ravenseat: CLI, again }), ...extra()].join('\n'));
}

// ---- Whose gate evidence and owner rows count (gateEvidence.mode, owner decision B2) ------------------------------------

/** own (the default), external or off (lib/gateEvidence.js modeOf). */
const GE_MODE = require('./lib/gateEvidence.js').modeOf(CONFIG);

/**
 * The owner rows task `id` relies on (owner answers, edits, approvals in queue.json), confirmed against the owner log
 * (lib/ownerLog.js): a row no ravenseat write recorded stops receive and merge (exit 1, nothing changed) until the owner
 * accepts it or takes it out. The first use records the rows there are as the baseline. Mode off does not check.
 */
function stopOnOwnerRows(id, again) {
  if (GE_MODE === 'off') return;
  const OL = require('./lib/ownerLog.js');
  const r = OL.check(FOLDER, read(), id);
  if (r.baseline) console.log(`Owner log started (${OL.logFile(FOLDER)}): the owner rows in the queue now are its baseline.`);
  if (r.missing.length) die(OL.stopMessage({ id, missing: r.missing, ravenseat: CLI, again, file: OL.logFile(FOLDER) }));
}

/**
 * gateEvidence.mode off: the track's gates=OK taken at its word on the delivered tip. Nothing runs; the record says
 * where it came from (`source: "track"`, `ran: false`). `{ status: 'off' }` when there are no quick gates, as in own.
 */
function trackWordGates(branch) {
  if (!CONTROLS.commandsOf(CONFIG.gates?.quick).length) return { status: 'off' };
  const tip = git(['rev-parse', '--verify', `refs/heads/${branch}`]);
  console.log(
    `Gates not run at ${String(tip).slice(0, 12)}: gateEvidence.mode off, so the track's RESULT gates=OK is taken as given ` +
      '(nothing checked it; the merge step still runs the quick gates on the merge commit).',
  );
  return { status: 'green', record: { ok: true, kind: 'quick', tip, at: new Date().toISOString(), ran: false, source: 'track' } };
}

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
 * The reason a red gates.mjs run was tampered, or null: the entry it recorded for this task after `since` (also one for
 * another sha: a gate that moved HEAD), or, with no such entry, a surface that now differs from the baseline.
 */
function gatesTamperReason({ id, since }) {
  const GE = require('./lib/gateEvidence.js');
  const own = GE.readStore(GE.storeFile(FOLDER)).entries.filter((e) => e?.track === id && Date.parse(e.time) >= since - 1000);
  const entry = own.at(-1);
  if (entry?.tampered) return entry.tamper_reason ?? 'the evidence store changed during the run';
  return GB.driftReason(FOLDER, GIT_ROOT);
}

// ---- The done command (task field done_when, lib/doneCheck.js): receive and merge ---------------------------------

/**
 * Runs the task's done command in the track's worktree (the worktree that has the branch checked out; --done-cwd
 * overrides) and writes the tail of the output to `done-<id>.md` in the scratchpad (the data folder without one).
 * null when the task has no done command. Stops (exit 1, nothing changed) when no worktree has the branch: the command
 * must run on the track's own files, and the queue never creates or removes worktrees here (the shared links make a
 * delete dangerous, see cleanup-worktree.mjs).
 * The command runs the track's code, so it gets the same scrubbed environment as the gates (lib/gateEnv.js), and a
 * change to the git hooks or the executing config during it, or a difference from the accepted baseline, makes it red
 * with `record.tampered` (lib/gitSurfaceBaseline.js): the callers stop for the owner, no fix round.
 * @returns {null | { ok: boolean, run: object, record: object, file: string, cwd: string }}
 */
function runDoneCommand(o, { branch, scratch, step }) {
  const DC = require('./lib/doneCheck.js');
  const GV = require('./lib/gateEnv.js');
  const GX = require('./lib/gitExecSurface.js');
  const command = typeof o.done_when === 'string' ? o.done_when.trim() : '';
  if (!command) return null;
  const tip = git(['rev-parse', '--verify', `refs/heads/${branch}`]);
  const cwd = val('--done-cwd')
    ? path.resolve(val('--done-cwd'))
    : DC.worktreeFor(git(['worktree', 'list', '--porcelain']), branch);
  if (!cwd || !fs.existsSync(cwd))
    die(
      `${o.id}: the done command cannot run: no worktree has ${branch} checked out` +
        `${cwd ? ` (${cwd} is gone)` : ''}. Check the branch out in a worktree (git worktree add <folder> ${branch}, ` +
        `then prepare-track for the shared links) and run ${step} again with --done-cwd <folder>. Nothing changed.`,
    );
  // Uncommitted changes in the worktree are not on the branch: a green run would then prove more than the branch has.
  const dirty = spawnSync('git', ['-C', cwd, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' });
  if ((dirty.stdout ?? '').trim())
    console.log(`WARNING: ${cwd} has uncommitted changes; the done command also sees them (they are not on ${branch}).`);
  const setup = DC.doneCheckSetup(CONFIG);
  console.log(`DONE COMMAND (${step}) for ${o.id} in ${cwd}: ${command}  (time budget ${setup.timeoutSec} s)`);
  const watch = GB.watch(FOLDER, cwd);
  const spawn = GV.trackCodeSpawn(process.env, {
    storeFile: require('./lib/gateEvidence.js').storeFile(FOLDER),
    root: CONFIG.root,
  });
  const run = DC.runDoneWhen({ command, cwd, ...setup, spawn });
  const tamperReason = watch.finish();
  if (tamperReason) {
    run.ok = false;
    run.tail.push(`${tamperReason}. ${GX.INSPECT}`);
  }
  const folder = scratch ?? FOLDER;
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `done-${o.id}.md`);
  // Only the tail is written (lib/doneCheck.js, Secrets): the full output never leaves this process.
  fs.writeFileSync(file, DC.doneCheckReport({ id: o.id, command, cwd, step, run, tip }));
  const record = {
    ok: run.ok,
    exit: run.exit,
    ...(run.timedOut ? { timed_out: true } : {}),
    ...(tamperReason ? { tampered: true, tamper_reason: tamperReason } : {}),
    command,
    tip,
    step,
    at: new Date().toISOString(),
    duration_s: run.durationSec,
    file,
  };
  // Green, but no tests ran (lib/zeroTests.js, GS-1): the kept tail of a green run says no test ran. A caveat only.
  if (run.ok) {
    const ZT = require('./lib/zeroTests.js');
    const hit = ZT.detect(run.tail.join('\n'));
    if (hit) record.zeroTests = ZT.clean([{ gate: 'done_when', command, runner: hit.runner, signal: hit.signal }]);
  }
  // B2 follow-up: ravenseat's own evidence of the run, in the gate evidence store (not queue.json, which a track can
  // write). The merge's skip reads it under gateEvidence.mode own and external (mergeDoneKnown). Clean = git status ran
  // and showed no uncommitted tracked change; a run that also saw such changes never lets the merge skip.
  const GE = require('./lib/gateEvidence.js');
  GE.append(
    GE.storeFile(FOLDER),
    GE.doneEntry({
      sha: tip,
      command,
      ok: run.ok,
      exit: run.exit,
      clean: dirty.status === 0 && !(dirty.stdout ?? '').trim(),
      step,
      task: o.id,
      timedOut: run.timedOut,
      tampered: !!tamperReason,
    }),
  );
  console.log(`Done command ${run.ok ? 'GREEN' : 'RED'} (${run.timedOut ? 'time budget' : `exit ${run.exit ?? '?'}`}, ${run.durationSec} s).`);
  if (tamperReason) console.log(`TAMPERED: ${tamperReason}. ${GX.INSPECT}.`);
  // The finding log (lib/findingSources.js): a red run is one row, built from the tail already kept (each run is a
  // new run, so no `once`). Green gives nothing.
  if (!run.ok) FSRC.record(() => FSRC.doneCheck({ id: o.id, command, run, tamperReason }));
  return { ok: run.ok, run, record, file, cwd };
}

/**
 * A red done command gets the same treatment as a red gate: the blocker gate-red, the last lines on screen and a fix
 * round (`ravenseat resume <id> --reason fix` with the tail file as findings; resume puts the tail into the brief and applies
 * the fix-round cap). Never a review or a merge. Exits: 8 when the cap stopped the round (an owner question), else 1.
 */
function doneCommandRed(id, check, { scratch, what = 'done command' }) {
  const tail = check.run.tail;
  console.log(`NOT DONE: ${id}'s ${what} is red; no review and no merge. The last lines:`);
  console.log(tail.slice(-10).map((l) => `  | ${l}`).join('\n'));
  console.log(`Output tail (${tail.length} lines): ${check.file}`);
  const r = spawnSync(
    process.execPath,
    [
      path.join(HERE, 'queue.mjs'),
      'resume',
      id,
      '--reason',
      'fix',
      '--findings-file',
      check.file,
      // The cause of the round, for the autonomy figure (lib/eventStatistics.js): a red done command, not a reviewer.
      // A red quick gate at receive is counted the same way (a machine check, not a reviewer).
      '--from',
      'done_when',
      ...(scratch ? ['--scratchpad', scratch] : []),
    ],
    { encoding: 'utf8', env: process.env },
  );
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status === 0) console.log(L.fixRoundLine(r.stdout, CLI, id));
  process.exit(r.status === 8 ? 8 : 1);
}

// ---- The gate evidence at receive (lib/gateEvidence.js) -------------------------------------------------------------

/**
 * The quick gates bound to the delivered tip. The track's RESULT line (`gates=OK`) and its own gate rows in the time
 * log are informational only: what counts is a green, clean run of every quick gate on exactly the branch tip, recorded
 * by gates.mjs for the orchestrator (lib/gateEvidence.js). When the store has one for this tip (an earlier receive, no
 * new commits since), nothing runs. Otherwise receive runs `gates.mjs --quick --evidence` in the track's worktree (the
 * one with the branch checked out; --done-cwd overrides) and reads the evidence that run recorded.
 * Reuse needs ALL of: the same sha, the setup hash of the CURRENT gate config (lib/gateEvidence.js setupHash, so a
 * changed gate setup runs again on the same commit) and `writer: "orchestrator"`; a legacy entry (from before those
 * fields) is never reused here. `reuse: false` always runs the gates (prepared for an external attempt, which must never
 * ride on evidence it did not get from this run; no caller passes it yet). The entry read back after the run must be
 * newer than the run's start, so an older entry can never stand in for a run that recorded nothing.
 * Refused (exit 1, nothing changed), as for the done command: no worktree has the branch, the worktree is not at the
 * branch tip, or it has uncommitted tracked changes (a green run would then not be bound to the tip).
 * A red run that was tampered carries `tampered` (the reason): ravenseat receive stops for the owner instead of a fix round.
 * A green entry with `flaky` (lib/trackFlaky.js: red, then green on gates.mjs's rerun on the same commit) is green; the
 * record gets `flaky` and `flaky_times` (withFlaky), the FLAKY lines are printed, and a fresh run files the finding.
 * @returns {{ status: 'off' } | { status: 'green'|'red', record: object, tampered?: string, check?: { run: object, file: string } }}
 */
function receiveGates(o, { branch, scratch, reuse = true, step = 'receive' }) {
  const GE = require('./lib/gateEvidence.js');
  const DC = require('./lib/doneCheck.js');
  const commands = (Array.isArray(CONFIG.gates?.quick) ? CONFIG.gates.quick : [])
    .filter((g) => typeof g === 'string' && g.trim())
    .map((g) => g.trim());
  if (!commands.length) return { status: 'off' };
  const tip = git(['rev-parse', '--verify', `refs/heads/${branch}`]);
  const storeFile = GE.storeFile(FOLDER);
  // Only the orchestrator's own entries for this exact control setup (legacy: false), see the comment above.
  const trust = { setupHash: GE.setupHash(CONFIG.gates), legacy: false };
  const known = reuse
    ? GE.latest(GE.readStore(storeFile).entries, { sha: tip, kinds: ['quick', 'full'], commands, ...trust })
    : null;
  if (known?.ok === true) {
    const covered = GE.coverageLine(known);
    console.log(`Gates green at ${String(tip).slice(0, 12)} (${known.kind}, ravenseat's own run at ${known.time}${covered ? `, ${covered}` : ''}); not run again.`);
    // The finding was filed by the receive that ran it; the lines say it again.
    const record = withZeroTests(
      withFlaky(
        o,
        { ok: true, kind: known.kind, tip, at: new Date().toISOString(), ran: false, evidence_at: known.time, evidence_id: known.id },
        known,
        { storeFile },
      ),
      known,
    );
    return { status: 'green', record };
  }
  const cwd = val('--done-cwd')
    ? path.resolve(val('--done-cwd'))
    : DC.worktreeFor(git(['worktree', 'list', '--porcelain']), branch);
  if (!cwd || !fs.existsSync(cwd))
    die(
      `${o.id}: the quick gates cannot run: no worktree has ${branch} checked out${cwd ? ` (${cwd} is gone)` : ''}. ` +
        `receive runs them itself on the delivered tip (the track's RESULT gates= is not evidence). Check the branch out ` +
        `in a worktree (git worktree add <folder> ${branch}, then prepare-track for the shared links) and run receive ` +
        'again with --done-cwd <folder>. Nothing changed.',
    );
  const at = spawnSync('git', ['-C', cwd, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
  const head = (at.stdout ?? '').trim();
  if (head !== tip)
    die(
      `${o.id}: ${cwd} is at ${head.slice(0, 12) || '?'}, not at the tip of ${branch} (${String(tip).slice(0, 12)}); the ` +
        'gates must run on the delivered commit. Check the branch out there and run receive again. Nothing changed.',
    );
  const dirty = spawnSync('git', ['-C', cwd, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' });
  if ((dirty.stdout ?? '').trim())
    die(
      `${o.id}: ${cwd} has uncommitted tracked changes; a gate run there would not be bound to ${branch} at ` +
        `${String(tip).slice(0, 12)}. Commit them on the branch (then the tip moves) or discard them, and run receive ` +
        'again. Nothing changed.',
    );
  const folder = scratch ?? FOLDER;
  fs.mkdirSync(folder, { recursive: true });
  const logFile = path.join(folder, `gates-${step}-${o.id}.log`);
  // Why it runs: only ravenseat's own green run on exactly this tip and gate setup is reused; a track's own run in its
  // worktree never records evidence (lib/gateEvidence.js), however green it was.
  if (reuse)
    console.log(
      `No green run of ravenseat's own on ${String(tip).slice(0, 12)} with the current gate setup (a track's own run is ` +
        `never evidence), so ${step} runs the quick gates now.`,
    );
  console.log(`GATES (${step}) for ${o.id} in ${cwd}: ${commands.join(' ; ')}  (the quick gates, ravenseat's own run)`);
  const t0 = Date.now();
  const r = spawnSync(
    process.execPath,
    [
      path.join(HERE, 'gates.mjs'),
      '--quick',
      '--evidence',
      '--cwd',
      cwd,
      '--track',
      o.id,
      '--log',
      logFile,
      '--timeout-sec',
      String(BASE_SETUP.timeoutSec),
    ],
    { cwd, encoding: 'utf8', env: process.env, maxBuffer: 1 << 26 },
  );
  const durationSec = Math.round((Date.now() - t0) / 100) / 10;
  // Mode "warn": the gates' own output is only shown when they are red, so what the run left behind is said here.
  if (GB.mode() === 'warn') GB.stopDetail(FOLDER, GIT_ROOT, { ravenseat: CLI });
  const found = GE.latest(GE.readStore(storeFile).entries, { sha: tip, kinds: ['quick'], commands, ...trust });
  // Written by THIS run (not before it started; a second of slack for the clock's resolution), or none.
  const entry = found && Date.parse(found.time) >= t0 - 1000 ? found : null;
  // What the run covered, in a short phrase (lib/gateEvidence.js coverageLine): a sha does not name everything it saw.
  const covered = GE.coverageLine(entry);
  // The run's own result and its recorded evidence must agree; a green exit without an entry (a commit during the run,
  // or the store could not be written) is no evidence.
  if (r.status === 0 && entry?.ok === true) {
    console.log(`Gates GREEN at ${String(tip).slice(0, 12)} (${durationSec} s), recorded as evidence for that commit${covered ? `; ${covered}` : ''}.`);
    // Ignored files or a shared folder from another lockfile in a run in place: the one hint (lib/gateClean.js).
    const cleanHint = require('./lib/gateClean.js').hint(entry, require('./lib/gateClean.js').setup(CONFIG));
    if (cleanHint) console.log(cleanHint);
    const record = withZeroTests(
      withFlaky(
        o,
        { ok: true, kind: 'quick', tip, at: entry.time, ran: true, duration_s: durationSec, evidence_id: entry.id },
        entry,
        { storeFile, file: true },
      ),
      entry,
    );
    return { status: 'green', record };
  }
  if (r.status === 0)
    die(
      `${o.id}: the quick gates exited green but left no evidence for ${String(tip).slice(0, 12)} (did the branch move ` +
        `during the run, or could ${storeFile} not be written?). Run receive again. Nothing changed.`,
    );
  let text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  try {
    text = fs.readFileSync(logFile, 'utf8');
  } catch {
    /* no log file: the output */
  }
  const tampered = gatesTamperReason({ id: o.id, since: t0 });
  // Only the tail goes into the fix brief (as for the done command: a secret printed early is not copied around).
  const tail = DC.tailOf(text, DC.doneCheckSetup(CONFIG).tailLines);
  const file = path.join(folder, `gates-${o.id}.md`);
  fs.writeFileSync(
    file,
    [
      `# Quick gates for ${o.id} at ${String(tip).slice(0, 12)}: RED (exit ${r.status ?? '?'})`,
      '',
      `- Commands: ${commands.map((c) => `\`${c}\``).join(', ')}`,
      `- Where: ${cwd} (ravenseat ${step}'s own run; the track's RESULT line is not evidence)`,
      '',
      `The last ${tail.length} line(s) of the output:`,
      '',
      '~~~~',
      ...tail,
      '~~~~',
      '',
    ].join('\n'),
  );
  console.log(`Gates RED at ${String(tip).slice(0, 12)} (exit ${r.status ?? '?'}, ${durationSec} s)${covered ? `; ${covered}` : ''}.`);
  if (entry?.tampered)
    console.log(`TAMPERED: ${entry.tamper_reason ?? 'the evidence store changed during the run'}. ${require('./lib/gitExecSurface.js').INSPECT}.`);
  return {
    status: 'red',
    record: {
      ok: false, kind: 'quick', tip, at: new Date().toISOString(), ran: true, exit: r.status, duration_s: durationSec, file,
      ...(entry?.id ? { evidence_id: entry.id } : {}),
    },
    ...(tampered ? { tampered } : {}),
    check: { run: { tail, exit: r.status }, file },
    // Kept in memory only (never written to the task): "the gate cannot run" reads the per-command sections.
    log: text,
    commands,
  };
}

/**
 * "The gate cannot run" (lib/gateBroken.js, gates.brokenVerdict, default on): a red quick gate whose own first program
 * is missing on the tip, and the same command fails the same way on the base (the main checkout, a short budget, the
 * scrubbed environment). The verdict, with `resolved` when the owner has answered its question, or null.
 */
function brokenGate(o, gateCheck) {
  const GBR = require('./lib/gateBroken.js');
  if (!GBR.on(CONFIG) || !gateCheck?.log) return null;
  const GE = require('./lib/gateEvidence.js');
  // A clean copy that could not be set up (gates.runner clean, lib/gateClean.js): no gate command ran, so there is no
  // base to compare with. The question id also carries the clean setup, so changing it forgets the verdict.
  const setupReason = GBR.setupRed(gateCheck.log);
  if (setupReason) {
    const hash = require('./lib/gateClean.js').verdictHash(GE.setupHash(CONFIG.gates), CONFIG);
    const v = GBR.setupVerdict({ id: o.id, reason: setupReason, setupHash: hash });
    return { ...v, resolved: (read().resolved ?? []).includes(v.question) };
  }
  const found = GBR.candidates(gateCheck.log, gateCheck.commands);
  if (!found.length) return null;
  const TR = require('./lib/treeRun.js');
  const spawn = require('./lib/gateEnv.js').trackCodeSpawn(process.env, { storeFile: GE.storeFile(FOLDER), root: CONFIG.root });
  const baseRuns = {};
  for (const c of found) {
    console.log(`The gate's program \`${c.program}\` was not found; checking the base (${GIT_ROOT}) for the same: ${c.command}`);
    const r = TR.runBounded(c.command, { cwd: GIT_ROOT, timeoutMs: GBR.BASE_CHECK_SEC * 1000, spawn });
    baseRuns[c.command] = { exit: r.status ?? null, output: `${r.stdout ?? ''}${r.stderr ?? ''}`, timedOut: !!r.timedOut };
  }
  const v = GBR.verdict({ id: o.id, found, baseRuns, setupHash: GE.setupHash(CONFIG.gates) });
  if (!v) {
    console.log('The base runs it, so the missing program is the track\'s change: a fix round as usual.');
    return null;
  }
  return { ...v, resolved: (read().resolved ?? []).includes(v.question) };
}

/**
 * The flaky part of a green gate record (lib/trackFlaky.js): `flaky` from the trusted evidence entry and `flaky_times`,
 * how often each command has been flaky on this track (this run included, it is in the store). Prints the FLAKY lines;
 * `file: true` (a fresh run, not a reused entry) also files the finding per command (cli/baseHealth.mjs fileFlaky, the
 * base gate's title, so it is deduplicated on the command). The record unchanged when the entry has no `flaky`.
 */
/**
 * "Green, but no tests ran" (lib/zeroTests.js, GS-1): the evidence entry's zero_tests on the green record as
 * `zeroTests` (which gate: the entry's kind, quick or full). The record as it was when there are none.
 */
function withZeroTests(record, entry) {
  const ZT = require('./lib/zeroTests.js');
  const list = ZT.clean((Array.isArray(entry?.zero_tests) ? entry.zero_tests : []).map((z) => ({ ...z, gate: entry.kind })));
  return list.length ? { ...record, zeroTests: list } : record;
}

function withFlaky(o, record, entry, { storeFile, file = false }) {
  const flaky = Array.isArray(entry?.flaky) ? entry.flaky : [];
  if (!flaky.length) return record;
  const TF = require('./lib/trackFlaky.js');
  const GE = require('./lib/gateEvidence.js');
  const entries = GE.readStore(storeFile).entries;
  const out = {
    ...record,
    flaky,
    flaky_times: Object.fromEntries(flaky.map((c) => [c, Math.max(1, TF.timesOnTrack(entries, { track: o.id, command: c }))])),
  };
  const finding = file
    ? fileFlaky({
        commands: flaky,
        tip: record.tip,
        causeId: o.id,
        source: `track gate of ${o.id}`,
        row: false,
        detail:
          `Red, then green on a rerun on the same commit ${record.tip} (the quick gates of ${o.id} at ravenseat receive). ` +
          'Counted as green. Make the command deterministic or take it out of the gate.',
      })
    : null;
  for (const l of TF.summaryLines(o.id, out, { finding })) console.log(l);
  return out;
}

/**
 * Red on base (lib/redOnBase.js, gates.redOnBase): the track's new or changed test files must pass on the tip and at
 * least one must fail with the track's code change taken away. Runs in the track's worktree and puts it back. Returns
 * null when the setting is off, else the record for the task (red_on_base). Never stops receive.
 */
function redOnBaseCheck(o, { branch }) {
  const RB = require('./lib/redOnBase.js');
  const DC = require('./lib/doneCheck.js');
  const set = RB.setup(CONFIG.gates);
  if (!set) return null;
  const at = new Date().toISOString();
  const tip = git(['rev-parse', '--verify', `refs/heads/${branch}`]);
  const fail = (reason) => ({ verdict: 'error', reason, command: set.command, tip, at, files: [], skipped: [] });
  const cwd = val('--done-cwd') ? path.resolve(val('--done-cwd')) : DC.worktreeFor(git(['worktree', 'list', '--porcelain']), branch);
  if (!cwd || !fs.existsSync(cwd)) return fail(`no worktree has ${branch} checked out`);
  const g = (args) => spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if ((g(['rev-parse', 'HEAD']).stdout ?? '').trim() !== tip) return fail(`${cwd} is not at the tip of ${branch}`);
  if ((g(['status', '--porcelain', '--untracked-files=no']).stdout ?? '').trim()) return fail(`${cwd} has uncommitted changes`);
  const mb = (git(['merge-base', BASE, branch]) ?? '').trim();
  if (!mb) return fail(`no merge base between ${BASE} and ${branch}`);
  const { tests, code, unsafe } = RB.split(gitLarge(['diff', '--name-status', '--no-renames', `${mb}..${branch}`]), CONFIG.testWeakening?.testPaths ?? []);
  const run = (files) => DC.runDoneWhen({ command: RB.commandFor(set.command, files), cwd, timeoutSec: set.timeoutSec, tailLines: 1 });
  const record = (extra) => ({ command: set.command, tip, at, ...extra });
  if (!tests.length) return record({ verdict: 'no-tests', codeChanged: code.length > 0, files: [], skipped: unsafe });
  const tipRun = run(tests);
  if (!tipRun.ok) return record({ verdict: 'tip-red', files: tests.map((p) => ({ path: p, base: 'not run' })), skipped: unsafe });
  if (!code.length) return record({ verdict: 'tests-only', files: tests.map((p) => ({ path: p, base: 'not run' })), skipped: unsafe });
  const picked = tests.slice(0, set.maxFiles);
  const base = [];
  let reason = null;
  try {
    // The change taken away: what the track changed or deleted gets its merge-base version, what it added goes.
    const back = code.filter((c) => c.status !== 'A').map((c) => c.path);
    for (let i = 0; i < back.length; i += 50) {
      const r = g(['checkout', mb, '--', ...back.slice(i, i + 50)]);
      if (r.status !== 0) throw new Error(`git checkout of the base version failed: ${(r.stderr ?? '').trim().split('\n')[0]}`);
    }
    for (const c of code.filter((x) => x.status === 'A')) fs.rmSync(path.join(cwd, ...c.path.split('/')), { force: true });
    for (const p of picked) base.push({ path: p, ok: run([p]).ok });
  } catch (e) {
    reason = e.message;
  } finally {
    // Back to the tip: receive checked the worktree was clean there, so this undoes only the check's own changes.
    g(['reset', '-q', '--hard', 'HEAD']);
    // A checkout ran here (paths only, but the rule is simple): the path answers kept for this process go (lib/gitFacts.js).
    require('./lib/gitFacts.js').invalidate();
  }
  const head = (g(['rev-parse', 'HEAD']).stdout ?? '').trim();
  const dirty = (g(['status', '--porcelain', '--untracked-files=no']).stdout ?? '').trim();
  if (head !== tip || dirty) return fail(`${cwd} could not be put back to ${String(tip).slice(0, 12)}: look at it before anything else (git status)`);
  if (reason) return fail(reason);
  const verdict = RB.verdict({ tests, code, tip: tipRun, base });
  return record({
    verdict,
    files: base.map((b) => ({ path: b.path, base: b.ok ? 'green' : 'red' })),
    skipped: [...tests.slice(set.maxFiles), ...unsafe],
  });
}

// ---- The secret scan at receive (H5, lib/secretScan.js scanRange) ---------------------------------------------------

/**
 * The track's own commits (<baseBranch>..<branch>, every commit, so a key added and deleted again still counts), with
 * the push check's patterns, exceptions and time limit. WHY here and not only at push: once merged, a key is in the base
 * branch's history; caught now, the track can take it out of its own branch and the base stays clean.
 * Returns null unless secretScan.atReceive is true (off by default, lib/optInChecks.js), else { hits, scanner, incomplete? } (never the matched text).
 */
function receiveSecretScan(branch) {
  if (CONFIG.secretScan?.atReceive !== true) return null;
  const SS = require('./lib/secretScan.js');
  return SS.scanRange({ cwd: GIT_ROOT, from: `refs/heads/${BASE}`, to: `refs/heads/${branch}`, setup: CONFIG.secretScan });
}

/** One hit as file:line (rule) in <commit>: never the value. */
const secretWhere = (h) => `${h.file}:${h.line} (${h.rule})${h.commit ? ` in ${h.commit}` : ''}`;

/** The receive lines for the scan: a warning when it did not finish, the SECRET line on hits, nothing when clean or off. */
function secretScanLines(id, scan) {
  if (!scan) return [];
  const out = [];
  if (scan.incomplete)
    out.push(
      `WARNING: the secret scan at receive did not finish (${scan.incomplete}), so nothing is blocked on it. ` +
        `Look at ${id}'s diff for keys yourself; the push check scans again before the push.`,
    );
  if (scan.hits?.length) {
    const shown = scan.hits.slice(0, 5).map(secretWhere).join(', ');
    out.push(
      `SECRET: possible secret(s) in ${id}'s commits (${scan.scanner} scan): ${shown}${scan.hits.length > 5 ? ` and ${scan.hits.length - 5} more` : ''}. ` +
        `The merge stops on it (block secret-found). Every commit counts, so a fix round takes it out of the branch's history ` +
        `(rewrite the commits that added it), and a real key must be changed. A false alarm: ${CLI} merge ${id} --allow-secret (owner only, logged).`,
    );
  }
  return out;
}

/** The code files V1 looks up on the base (lib/scopeNotes.js reads JS/TS only). */
const SCOPE_CODE = ['*.js', '*.cjs', '*.mjs', '*.jsx', '*.ts', '*.cts', '*.mts', '*.tsx'];

/**
 * The reuse and scope facts for a delivery (lib/scopeNotes.js): { lines, section }. The look-ups run here against the
 * merge base (`base`) and the branch: `git grep -n -w` for a name, `git ls-tree -d` for the folders, `git show` for a
 * manifest. Everything is read, nothing runs from the track. A failure gives one NOTE line and no section; receive
 * goes on.
 */
function scopeNotesFor(o, { branch, base, diff, changedNames, all = false }) {
  const SN = require('./lib/scopeNotes.js');
  const setup = SN.setupOf(CONFIG);
  try {
    let dirs = null;
    const io = {
      // One git grep for all names (an -e per name): a process per name took seconds on Windows.
      findDefinitions: (names) => {
        if (!base || !names.length) return [];
        const out = gitLarge(['grep', '-n', '-w', '-I', '-F', ...names.flatMap((n) => ['-e', n]), base, '--', ...SCOPE_CODE]);
        const rows = [];
        for (const l of String(out ?? '').split(/\r?\n/)) {
          const m = (l.startsWith(`${base}:`) ? l.slice(base.length + 1) : l).match(/^(.*?):(\d+):(.*)$/);
          if (m) rows.push({ file: m[1], line: Number(m[2]), text: m[3] });
        }
        return rows;
      },
      dirExists: (d) => {
        if (!base) return true;
        dirs ??= new Set(String(gitLarge(['ls-tree', '-r', '-d', '--name-only', base]) ?? '').split(/\r?\n/).filter(Boolean));
        return dirs.has(d);
      },
      readFile: (side, p) => {
        const rev = side === 'base' ? base : branch;
        if (!rev) return null;
        const t = gitLarge(['show', `${rev}:${p}`]);
        return t == null ? null : String(t);
      },
    };
    // The catalog's stack entries (roadmap 0å KD-2): a dependency note names the one an added package goes against, and
    // an accepted one gives a CATALOG line. A catalog that cannot be read gives the notes as before.
    let choices = [];
    try {
      choices = setup.dependencies ? stackChoicesNow() : [];
    } catch {
      choices = []; // error-ignored: the notes are facts for the reviewer; without the catalog they are as before
    }
    const r = SN.assess({ diff, changedPaths: changedNames, task: o, setup, io, migrations: CONFIG.migrations ?? null, choices });
    return { lines: SN.receiveLines(r, { id: o.id, cli: CLI, all }), section: SN.packageSection(r) };
  } catch (e) {
    return { lines: [`NOTE scope notes (${o.id}): could not be made (${e?.message ?? e}); nothing is blocked on it.`], section: null };
  }
}

/**
 * The check rules of the design choices on a diff (lib/catalogChecks.js through cli/catalog.mjs catalogRules), or null
 * when there is nothing to try. A read error gives one NOTE line in `lines` and no result: receive and merge go on.
 */
function catalogRulesFor(id, diff) {
  try {
    return { result: catalogRules(diff), lines: [] };
  } catch (e) {
    return { result: null, lines: [`NOTE catalog rules (${id}): could not be tried (${e?.message ?? e}); nothing is blocked on it.`] };
  }
}

/** The names the delivery's added lines define (lib/scopeNotes.js newNames), for the near names (V1b); [] on any error. */
function reviewNewNames(diff) {
  try {
    const SN = require('./lib/scopeNotes.js');
    return SN.newNames(SN.parseDiff(diff), { ignoreNames: SN.setupOf(CONFIG).ignoreNames });
  } catch {
    return []; // error-ignored: the near names are context for the reviewer, nothing waits on them
  }
}

/**
 * The receive lines for the main tree's control files that changed since the fingerprint `before` (lib/controlFiles.js),
 * leaving out a file that is tracked and clean now: it came in through a commit (another track's merge), which git log
 * shows. Never throws: the check is a warning.
 */
export function controlFileLines(id, before, others = []) {
  try {
    const CF = require('./lib/controlFiles.js');
    const where = controlWhere();
    const changes = CF.compare(before, CF.fingerprint(where));
    if (!changes.length) return [];
    // The names git can know: relative to the main tree, not in .git, and the scripts folder when it lies in the tree.
    const rel = path.relative(where.mainTree, where.scriptsDir).replace(/\\/g, '/');
    const scriptsRel = rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? rel : null;
    const asGit = (name) => (name === CF.SCRIPTS_KEY ? scriptsRel : name.startsWith('.git/') ? null : name);
    const names = changes.map((c) => asGit(c.name)).filter(Boolean);
    const committed = new Set();
    if (names.length) {
      const tracked = new Set(String(git(['ls-files', '--', ...names]) ?? '').split(/\r?\n/).filter(Boolean));
      const dirty = String(git(['status', '--porcelain', '--untracked-files=all', '--', ...names]) ?? '')
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => l.slice(3).replace(/^"|"$/g, ''));
      for (const c of changes) {
        const g = asGit(c.name);
        if (!g) continue;
        const isTracked = g === scriptsRel ? [...tracked].some((t) => t.startsWith(`${g}/`)) : tracked.has(g);
        const isDirty = dirty.some((d) => d === g || d.startsWith(`${g}/`));
        if (isTracked && !isDirty && c.change !== 'removed') committed.add(c.name);
      }
    }
    const kept = CF.unexplained(changes, { committed });
    if (kept.length) logTime(id, 'control-files-changed', `${kept.length} file(s)`);
    return CF.warningLines(id, kept, { root: where.mainTree, others });
  } catch {
    return []; // error-ignored: the fingerprint is a warning; receive goes on
  }
}

/**
 * The weakened settings no setting-weakened row explains (lib/guardLog.js outsideCli), each logged once as
 * config-changed-outside-cli, as lines. `where` names the command that found it. Never throws.
 */
export function outsideCliLines(where) {
  try {
    const GL = require('./lib/guardLog.js');
    const SV = require('./lib/settingsView.js');
    const queue = fs.existsSync(path.join(FOLDER, 'queue.json')) ? read() : { tasks: [] };
    const view = SV.settingsView({ config: CONFIG, queue, migrations: !!CONFIG.migrations?.folder });
    const weakened = view.categories.flatMap((c) => c.rows).filter((r) => r.weakened).map((r) => ({ key: r.key, value: r.value }));
    if (!weakened.length) return [];
    const keys = GL.outsideCli(weakened, readTimeLog());
    if (!keys.length) return [];
    const TA = require('./lib/timeLogArchive.js');
    for (const key of keys)
      TA.appendText(TIME_LOG, `${JSON.stringify(GL.outsideCliRow(key, weakened.find((w) => w.key === key).value, { where }))}\n`);
    return [
      `CONFIG CHANGED OUTSIDE THE CLI: ${keys.join(', ')} ${keys.length === 1 ? 'is' : 'are'} weakened with no setting-weakened row ` +
        `(queue.config.json was edited by hand or by an agent). Logged as config-changed-outside-cli. If you did not do it, ` +
        `look at queue.config.json; ${CLI} settings set <key> <value> --i-understand --by owner is the way that logs it.`,
    ];
  } catch {
    return []; // error-ignored: a check, never a stop
  }
}

/** `ravenseat receive` (the usage is at the top of queue.mjs). */
export function cmdReceive() {
  // ---- A track has delivered -> review + review package as plain files + reviewer prompts ----
  const id = positional(1, ['--scratchpad', '--result', '--done-cwd'])[0];
  if (!id) die('receive <id> [--scratchpad <folder>] [--result "RESULT ..."] [--force] [--all]');
  const o0 = read().tasks.find((x) => x.id === id);
  if (!o0) die(`Unknown task ${id}`);
  if (!['running', 'picked', 'review'].includes(o0.status))
    die(`${id} has status ${o0.status}; receive applies to running, picked or review.`);
  // Before any git command and any change: a difference in what runs at the next git command is the owner's to settle.
  stopOnDrift(`${CLI} receive ${id}`);
  // The owner rows the task relies on, confirmed against the owner log (owner decision B2), before anything changes.
  stopOnOwnerRows(id, `${CLI} receive ${id} again`);
  const scratch = scratchpadFor(o0.scratchpad ?? null);
  if (!scratch) die('receive needs --scratchpad <folder> (or QUEUE_SCRATCHPAD).');
  const branch = o0.branch ?? branchFor(id);
  const gi = branchInfo(branch);
  if (!gi.exists) die(`Branch ${branch} does not exist.`);
  /** Prints the track's owner questions. They would otherwise stay in a file nobody opens. */
  const printQuestion = (asked) => {
    console.log(`Owner question(s) from the track (${asked.count}), also in ${CLI} decide:`);
    console.log(asked.text ?? "  (no \"Owner questions\" section: read the track's report and answer)");
  };
  /**
   * PS-4 (lib/startChecks.js): ownerQuestions=<n> against the items in the report's owner question section. A mismatch
   * is one NOTE line, never a stop; planChecks.ownerQuestionCount false turns it off.
   */
  const ownerQuestionNote = (v) => {
    const note = require('./lib/startChecks.js').ownerQuestionNote({ ...v, config: CONFIG });
    if (note) console.log(note);
  };
  /** The card in ravenseat decide. The report's path goes with it, since the note holds only the start of the question. */
  // Section 6.3 of plans/autonomi-nivaa-utredning.md: ownerQuestions=<n> against the questions the track registered with
  // `ravenseat question`. What is beyond them was free text, so the card is marked "Not filled in by the agent" and one
  // NOTE line is printed. Never a refusal: the question still reaches the owner, only without its card fields.
  const openQuestion = (queue, o, asked, file) => {
    const reg = L.registeredQuestions(queue, o.id, asked.count);
    const note = L.registeredQuestionNote(o.id, reg, CLI);
    if (note) console.log(note);
    const opened = L.openBlock(o, 'track-question', { note: asked.note });
    if (opened.block && file) opened.block.file = file;
    if (opened.block) {
      opened.block.unfilled = reg.unfilled;
      opened.block.registered = reg.registered;
    }
  };
  if (gi.commits === 0 && !a.includes('--force')) {
    // No commits is no delivery, but the track may have said why: a mission it could not do without the owner's answer.
    // What it said is read first, so the answer does not stay in a file while the task looks like it is running.
    const reply = lastTrackReply(taskAgents(o0));
    const found = trackReport(o0, [scratch, o0.scratchpad ?? null]);
    const file = found.report?.path && fs.existsSync(found.report.path) ? found.report.path : null;
    // A report from before the last ravenseat resume has been dealt with (resume saves report_seen).
    const fresh = !file || found.report.mtimeMs > Number(o0.report_seen ?? 0);
    const reportText = file && fresh ? fs.readFileSync(file, 'utf8') : null;
    const said = fresh ? (L.parseResult(val('--result')) ?? L.parseResult(reply) ?? L.parseResult(reportText)) : null;
    if (said) console.log(`The track says: ${said.line}`);
    const asked = L.trackQuestion({ result: said, reportText, reply });
    ownerQuestionNote({ result: said, reportText, reply });
    if (asked) {
      printQuestion(asked);
      edit((queue) => {
        const o = queue.tasks.find((x) => x.id === id);
        o.result = said;
        openQuestion(queue, o, asked, file);
      });
    }
    die(
      `Nothing to receive: ${branch} has no commits ahead of ${BASE}, and ${id} stays ${o0.status}.\n` +
        'The agent may not have committed: look for uncommitted work in its worktree (git worktree list).\n' +
        `Next: ${CLI} resume ${id} --reason context${asked ? ' --answer "<text>"' : ''} for a new round, ${CLI} set ${id} done if the work is already on ${BASE}, ` +
        `or ${CLI} set ${id} cancelled --remark "<why>". --force makes an empty package anyway.`,
    );
  }
  const scope = `${BASE}...${branch}`;
  const folder = path.join(scratch, `rev-${id}`);
  // The package is made again every time (a new round after a fix replaces the old one). Only files we made ourselves.
  fs.rmSync(folder, { recursive: true, force: true });
  fs.mkdirSync(path.join(folder, 'files'), { recursive: true });
  // The whole track diff. WHICH reviewers run, the DB objects, the test-weakening check and the ownership notes always
  // use it, also when the package itself is a delta (below).
  const stat = gitLarge(['diff', '--stat', scope]) ?? '';
  const diff = gitLarge(['diff', scope]) ?? '';
  const { copy, skipped } = L.packageFiles(
    gitLarge(['diff', '--name-status', '--no-renames', scope]),
    gitLarge(['diff', '--numstat', '--no-renames', scope]),
  );
  // The track's answer (from the transcript), track-result.md and handover.md from the track folder in the scratchpad.
  const agents = taskAgents(o0);
  // The attempt (lib/logic/attempt.js): its rows are read here, before the lock and after taskAgents wrote any killed
  // agent's row. Every way out of receive below records on it, so the fix round a red check starts is a new attempt.
  const attemptLog = attemptRows([o0]);
  const trackReply = lastTrackReply(agents);
  const files = {};
  if (trackReply) {
    // Agent text: redacted before it is stored, withheld if that fails (lib/storeText.js, lib/sinkRegister.js).
    fs.writeFileSync(path.join(folder, 'trackReply.md'), require('./lib/storeText.js').storeText(trackReply));
    files.trackReply = true;
  }
  // Adoption: the newest report in the orchestrator's and the task's scratchpad, also from a fix round (<id>-r<N>/).
  const trackFound = trackReport(o0, [scratch, o0.scratchpad ?? null]);
  for (const [k, measure, n] of [
    [trackFound.report?.path, 'trackReport.md', 'report'],
    [trackFound.handover?.path, 'handover.md', 'handover'],
  ]) {
    if (k && fs.existsSync(k)) {
      fs.copyFileSync(k, path.join(folder, measure));
      files[n] = true;
    }
  }
  const reportText = files.report
    ? fs.readFileSync(path.join(folder, 'trackReport.md'), 'utf8')
    : null;
  const result =
    L.parseResult(val('--result')) ??
    L.parseResult(trackReply) ??
    L.parseResult(reportText);
  const asked = L.trackQuestion({ result, reportText, reply: trackReply });
  // Owner claims without this mission's owner mark (lib/ownerMark.js, roadmap 0æ N4): a line and a package section.
  const OM = require('./lib/ownerMark.js');
  // A cloud mission is built elsewhere and has no mark, so it is not checked.
  const suspicious = OM.suspicious([reportText, trackReply], o0?.cloud ? null : missionMark(o0));
  for (const l of OM.receiveLines(id, suspicious)) console.log(l);
  if (asked) printQuestion(asked);
  ownerQuestionNote({ result, reportText, reply: trackReply });
  // The choices the track made itself: shown here and in the package so the owner reads them before the merge.
  const assumptions = L.assumptionSection(reportText) ?? L.assumptionSection(trackReply);
  if (assumptions)
    console.log(
      `Assumptions ${id}'s track made (read them before you merge; to change one: ${CLI} resume ${id} --reason fix --answer "<text>"):\n${assumptions}`,
    );
  // The owner's own Claude setup: did a listed entry in ~/.claude change while the track ran (lib/claudeFingerprint.js)?
  if (o0.claude_fp && CONFIG?.claudeFingerprint !== false) {
    const CFP = require('./lib/claudeFingerprint.js');
    const changes = CFP.compare(o0.claude_fp, CFP.fingerprint({ dir: o0.claude_fp.dir }));
    const others = read().tasks.filter((x) => x.id !== id && ['running', 'review', 'picked'].includes(x.status)).map((x) => x.id);
    for (const l of CFP.warningLines(id, changes, { dir: o0.claude_fp.dir, others })) console.log(l);
  }
  // The main tree's control files (lib/controlFiles.js): a change no commit explains while the track ran. Warns only.
  if (o0.control_fp && CONFIG?.controlFiles?.fingerprint !== false) {
    const others = read().tasks.filter((x) => x.id !== id && ['running', 'review', 'picked'].includes(x.status)).map((x) => x.id);
    for (const l of controlFileLines(id, o0.control_fp, others)) console.log(l);
  }
  // A weakened setting no setting-weakened row explains: queue.config.json was edited outside the CLI (lib/guardLog.js).
  for (const l of outsideCliLines(`receive ${id}`)) console.log(l);
  // The quick gates bound to the delivered tip (receiveGates), BEFORE the done command and any reviewer: the track's own
  // claim is informational only. A PARTIAL track is known to be unfinished, so no gate runs for it.
  // gateEvidence.mode off (owner decision B2): a track that says gates=OK is taken at its word, nothing runs; without
  // that claim receive runs them as in own.
  const trackSaidGreen = GE_MODE === 'off' && /^ok$/i.test(String(result?.gates ?? '').trim()) && result?.status !== 'PARTIAL';
  if (result?.gates != null && result.status !== 'PARTIAL' && !trackSaidGreen)
    console.log(`The track's RESULT gates=${result.gates} is self-reported (informational only; receive checks the tip itself).`);
  const gateCheck =
    result?.status === 'PARTIAL'
      ? { status: 'off' }
      : trackSaidGreen
        ? trackWordGates(branch)
        : receiveGates(o0, { branch, scratch });
  // A run that changed what runs at the next git command (or the evidence store) is the owner's decision: no red path,
  // no blocker, no fix round, no attempt closed. The rerun hits the drift stop while the hook is there, else runs again.
  if (gateCheck.tampered)
    die(GB.tamperedMessage({ what: 'the check run at receive', reason: gateCheck.tampered, ravenseat: CLI, again: `${CLI} receive ${id}` }));
  const recordAttempt = (o, { gateRed = false, doneRed = false } = {}) => {
    if (!o.attempts?.length) return;
    syncAttempts(o, attemptLog);
    o.attempts = AT.recordReceive(o.attempts, {
      sha: gateCheck.record?.tip ?? git(['rev-parse', '--verify', `refs/heads/${branch}`]),
      outcome: AT.receiveOutcome({ status: result?.status ?? null, gateRed, doneRed }),
      evidenceId: gateCheck.record?.evidence_id ?? null,
      now: new Date().toISOString(),
      report: trackFound.report?.path ?? null,
      handover: trackFound.handover?.path ?? null,
    });
  };
  if (gateCheck.status === 'red') {
    // The gate cannot run (lib/gateBroken.js): a missing program on this machine is the owner's, not a fix round.
    const broken = brokenGate(o0, gateCheck);
    const { resolved: brokenResolved = false, ...brokenVerdict } = broken ?? {};
    edit((queue) => {
      const o = queue.tasks.find((x) => x.id === id);
      if (o.status !== 'review') {
        const s = L.setStatus(o, 'review', new Date().toISOString());
        if (s.error) die(s.error);
      }
      if (result) o.result = result;
      o.review_package = folder;
      o.gate_check = gateCheck.record;
      if (trackFound.report) {
        o.report_received = trackFound.report.mtimeMs;
        o.report_seen = Math.max(Number(o.report_seen ?? 0), trackFound.report.mtimeMs);
      }
      o.t_receive ??= new Date().toISOString();
      L.openBlock(o, 'gate-red', { note: `quick gates red at receive (exit ${gateCheck.record.exit ?? '?'})` });
      if (broken) o.gate_broken = brokenVerdict;
      else delete o.gate_broken;
      if (broken && !brokenResolved) {
        // The same setup asks once: the question id carries the setup hash, so a second receive finds it registered.
        if (!queue.question?.[broken.question]) {
          const s = L.setQuestion(queue, require('./lib/gateBroken.js').question(o, brokenVerdict, { cli: CLI }));
          if (s.error.length) die(`Could not register the owner question: ${s.error.join('; ')}`);
        }
        if (!(o.waiting_on ?? []).includes(broken.question)) o.waiting_on = [...(o.waiting_on ?? []), broken.question];
        L.openBlock(o, 'owner-question', {
          note: broken.setup
            ? `the gate cannot run: the clean copy could not be set up (${broken.question})`
            : `the gate cannot run: ${broken.program} not found (${broken.question})`,
        });
      }
      recordAttempt(o, { gateRed: true });
      return o;
    });
    if (!o0.picked_by) pulseCursor(`receive ${id} gates red`);
    if (broken && !brokenResolved && broken.setup) {
      // The clean copy could not be set up (lib/gateClean.js): no gate command ran.
      console.log(
        `GATE CANNOT RUN: ${id}'s gate could not start in a clean copy of the commit (gates.runner clean): ${broken.setup}. ` +
          'A setup problem, so no fix round was started.\n' +
          `Owner question ${broken.question} registered (ravenseat question; blocker owner-question). Fix the setup (or list ` +
          `the file in gates.clean.include, or set gates.runner worktree), then ${CLI} receive ${id} again. A fix round ` +
          `anyway: ${CLI} resolve ${broken.question} --answer "…", then ${CLI} receive ${id}. Off: "gates": { "brokenVerdict": false }.`,
      );
      process.exit(8);
    }
    if (broken && !brokenResolved) {
      console.log(
        `GATE CANNOT RUN: ${id}'s quick gate ${broken.commands.map((c) => `\`${c}\``).join(', ')} needs \`${broken.program}\`, ` +
          'which is not found here, on the delivered tip and on the base. A setup problem, so no fix round was started.\n' +
          `Owner question ${broken.question} registered (ravenseat question; blocker owner-question). Install the tool or fix ` +
          `gates.quick, then ${CLI} receive ${id} again (a changed gates setup forgets this verdict). A fix round anyway: ` +
          `${CLI} resolve ${broken.question} --answer "…", then ${CLI} receive ${id}. Off: "gates": { "brokenVerdict": false }.`,
      );
      process.exit(8);
    }
    doneCommandRed(id, gateCheck.check, { scratch, what: 'quick gate run (ravenseat receive, on the delivered tip)' });
  }
  // The done command (lib/doneCheck.js), BEFORE any reviewer is started: a red one is not a delivery but a fix round.
  // A PARTIAL track is known to be unfinished (a context continuation), so the command is not run for it.
  const doneCheck = result?.status === 'PARTIAL' ? null : runDoneCommand(o0, { branch, scratch, step: 'receive' });
  if (doneCheck?.record.tampered)
    die(GB.tamperedMessage({ what: 'the done command', reason: doneCheck.record.tamper_reason, ravenseat: CLI, again: `${CLI} receive ${id}` }));
  if (doneCheck && !doneCheck.ok) {
    edit((queue) => {
      const o = queue.tasks.find((x) => x.id === id);
      if (o.status !== 'review') {
        const s = L.setStatus(o, 'review', new Date().toISOString());
        if (s.error) die(s.error);
      }
      if (result) o.result = result;
      o.review_package = folder;
      if (gateCheck.record) o.gate_check = gateCheck.record;
      o.done_check = doneCheck.record;
      // The report has been read: it is no longer a new delivery (the fix round's report is the next one).
      if (trackFound.report) {
        o.report_received = trackFound.report.mtimeMs;
        o.report_seen = Math.max(Number(o.report_seen ?? 0), trackFound.report.mtimeMs);
      }
      o.t_receive ??= new Date().toISOString();
      L.openBlock(o, 'gate-red', { note: `done command red at receive (exit ${doneCheck.run.exit ?? '?'})` });
      recordAttempt(o, { doneRed: true });
      return o;
    });
    if (!o0.picked_by) pulseCursor(`receive ${id} done command red`);
    doneCommandRed(id, doneCheck, { scratch });
  }
  // Nothing automatic looked at this delivery (lib/controls.js). A warning, never a stop; a PARTIAL track runs nothing anyway.
  if (result?.status !== 'PARTIAL' && !CONTROLS.commandsOf(CONFIG.gates?.quick).length && !doneCheck)
    console.log(CONTROLS.noChecksLine(id, { quiet: GUIDANCE.isQuiet(read()) }));
  // Green, but no tests ran (lib/zeroTests.js, GS-1): one NOTE line for the quick gate and the done command together.
  // A caveat, never a stop; the package gets a section and the board a small badge.
  const ZT = require('./lib/zeroTests.js');
  const zeroTests = ZT.ofTask({ gate_check: gateCheck.record, done_check: doneCheck?.record });
  const zeroLine = ZT.receiveLine(id, zeroTests);
  if (zeroLine) console.log(zeroLine);
  // The secret scan of the track's own commits (H5): a hit is recorded in the edit below (block secret-found), and the
  // merge stops on it. Said here, where the receive output is read.
  const secretScan = receiveSecretScan(branch);
  for (const l of secretScanLines(id, secretScan)) console.log(l);
  // QA evidence: the EVIDENCE line (track-result.md first, otherwise the answer) and the warning when a task that needs it
  // (config().qa.evidenceLabels) has none. A warning, not a stop.
  const evidenceRead = L.parseEvidence(reportText) ?? L.parseEvidence(trackReply);
  const evidenceWarn = L.evidenceWarning({
    o: o0,
    evidence: evidenceRead?.evidence ?? null,
    evidenceError: evidenceRead?.error ?? null,
  });
  // The mission (prompt-<id>.md) goes into the package too: reviewer-gap compares the delivery with it, and the helper
  // condition minMissionItems counts its numbered points.
  const missionFile = path.join(scratch, `prompt-${id}.md`);
  let missionText = null;
  if (fs.existsSync(missionFile)) {
    missionText = fs.readFileSync(missionFile, 'utf8');
    fs.writeFileSync(path.join(folder, 'mission.md'), missionText);
    files.mission = true;
  }
  // THE reviewers for the task (lib/queueHelpers.js): the fixed ones for the class and the helpers that are on and hit
  // (class, label, changed paths, plan, mission points). A custom helper only when its agent file is the one the owner
  // approved (sha256, lib/helperFiles.js); one that changed since is turned off here and left out.
  const HF = require('./lib/helperFiles.js');
  const checked = HF.verifiedSetup(CONFIG, read(), MAIN_TREE);
  const stale = HELP.switchesToTurnOff(checked.setup);
  if (stale.length) {
    edit((queue) => {
      for (const s of stale) queue.helpers[s.name] = { ...queue.helpers[s.name], enabled: false };
    });
    for (const s of stale)
      console.log(`Helper agent ${s.name}: turned off and left out (${HELP.REVIEW_TEXT[s.review]}; ravenseat helpers scan ${s.name}).`);
  }
  const reviewerList = L.reviewersForTask(o0, {
    queue: read(),
    changedPaths: [...copy, ...skipped.map((h) => h.path)],
    missionText,
    hashes: checked.hashes,
    missingControls: CONTROLS.missing(CONFIG, MAIN_TREE),
    // The review signals (lib/reviewSignals.js) read what the whole track diff adds.
    diff,
  });
  const reviewers = reviewerList.map((x) => x.type);
  // The hit rate per signal is measured from this record (the latest receive of the task): `ravenseat helpers`.
  const signalNames = require('./lib/reviewSignals.js')
    .signalHits({ config: CONFIG, changedPaths: [...copy, ...skipped.map((h) => h.path)], diff })
    .map((h) => h.name);
  edit((queue) => {
    const t = (queue.tasks ?? []).find((x) => x.id === id);
    if (t) t.review_signals = { at: new Date().toISOString(), hits: signalNames };
  });
  // ---- The package's diff and files (lib/deltaReview.js): after a fix round, only the commits since the last review,
  // with the findings the fix round got and the whole diff as a context file. Otherwise the whole diff, as before.
  const DR = require('./lib/deltaReview.js');
  const reviewTip = git(['rev-parse', '--verify', `refs/heads/${branch}`]);
  const reviewBase = git(['merge-base', BASE, branch]) || null;
  const picked = DR.deltaScope({
    o: o0,
    tip: reviewTip,
    mergeBase: reviewBase,
    isAncestor: (x, y) => git(['merge-base', '--is-ancestor', x, y]) != null,
    reviewers,
    full: a.includes('--full-review'),
    partial: result?.status === 'PARTIAL',
  });
  const delta = picked.delta;
  const range = delta ? `${delta.from}..${delta.to}` : scope;
  const shown = delta
    ? L.packageFiles(
        gitLarge(['diff', '--name-status', '--no-renames', range]),
        gitLarge(['diff', '--numstat', '--no-renames', range]),
      )
    : { copy, skipped };
  const packageStat = delta ? (gitLarge(['diff', '--stat', range]) ?? '') : stat;
  fs.writeFileSync(path.join(folder, 'diff.patch'), delta ? (gitLarge(['diff', range]) ?? '') : diff);
  if (delta) {
    fs.writeFileSync(path.join(folder, 'diff-full.patch'), diff);
    if (delta.findings && fs.existsSync(delta.findings)) {
      fs.copyFileSync(delta.findings, path.join(folder, 'previous-findings.md'));
      files.previousFindings = true;
    }
  }
  const copied = [];
  for (const filePath of shown.copy) {
    const content = gitLarge(['show', `${branch}:${filePath}`], { buffer: true });
    if (content == null) {
      shown.skipped.push({ path: filePath, reason: 'could not be read from the branch' });
      continue;
    }
    const templateFile = path.join(folder, 'files', ...filePath.split('/'));
    fs.mkdirSync(path.dirname(templateFile), { recursive: true });
    fs.writeFileSync(templateFile, content);
    copied.push(filePath);
  }
  const customReviewers = new Set(reviewerList.filter((x) => x.custom).map((x) => x.type));
  const dbObjects = L.dbObjectsFromDiff(diff, { folder: MIGR.folder });
  // Test weakening (lib/testWeakening.js): deleted test files and added skip/focus markers. A warning, never a stop.
  const TW = require('./lib/testWeakening.js');
  // The file text at both ends, for a test file emptied of assertions (red team RT-08).
  const weakBase = (git(['merge-base', BASE, branch]) ?? '').trim();
  const weak =
    CONFIG.testWeakening?.enabled === false
      ? null
      : TW.assess(diff, CONFIG.testWeakening, {
          read: (side, p) => (side === 'base' && !weakBase ? null : git(['show', `${side === 'base' ? weakBase : branch}:${p}`])),
        });
  const weakLine = weak && TW.summaryLine(weak);
  if (weakLine) console.log(weakLine);
  // Decision signals (lib/decisionSignals.js, phase 1 of plans/autonomi-nivaa-utredning.md): a new package, a migration or
  // schema file, deleted files, unstated choices, each marked "not asked" without a matching owner question. Read from
  // the diff already here (no tokens), one SIGNALS line, stored on the task for "Decided for you". Never a stop.
  // A PARTIAL delivery is unfinished, so it gets none. decisionSignals.enabled false: nothing.
  const DSIG = require('./lib/decisionSignals.js');
  const signalRecord =
    CONFIG.decisionSignals?.enabled === false || result?.status === 'PARTIAL'
      ? null
      : DSIG.record(
          DSIG.detect({
            diff,
            migrations: MIGR,
            testPaths: CONFIG.testWeakening?.testPaths ?? [],
            read: (side, p) => (side === 'base' && !weakBase ? null : git(['show', `${side === 'base' ? weakBase : branch}:${p}`])),
            setup: CONFIG.decisionSignals ?? {},
            report: {
              assumptions,
              questionText: L.ownerQuestionSection(reportText) ?? L.ownerQuestionSection(trackReply),
              ownerQuestions: result?.ownerQuestions ?? null,
            },
          }),
          { tip: git(['rev-parse', '-q', '--verify', `refs/heads/${branch}`]), at: new Date().toISOString() },
        );
  const signalLine = DSIG.receiveLine(id, signalRecord);
  if (signalLine) console.log(signalLine);
  // One time log row per delivery (a second receive of the same tip adds none), read before the edit below replaces it.
  const signalNew = signalRecord && DSIG.isNewDelivery(o0.decision_signals ?? null, signalRecord);
  // Red on base (lib/redOnBase.js): do the new tests fail without the change? Off unless gates.redOnBase is set; a
  // PARTIAL track is unfinished, so not for it. A warning, never a stop.
  const RB = require('./lib/redOnBase.js');
  const redBase = result?.status === 'PARTIAL' ? null : redOnBaseCheck(o0, { branch });
  // A fix needs a red test first (lib/fixTests.js): is this task a fix (its fields, or a GATE line in the report)? The
  // kind goes on the red on base record, so merge's strict mode knows a GATE-line fix without reading the report again.
  const FT = require('./lib/fixTests.js');
  const KBG = require('./lib/knownBugGate.js');
  const fixKind = FT.fixKind(o0, { gateLine: !!(KBG.parseGate(reportText) ?? KBG.parseGate(trackReply)) });
  if (redBase && fixKind) redBase.fix = fixKind;
  // One line, not two: for a fix without a proven red test, the fix line says what the red on base line would, and more.
  // gates.fixWithoutTestWarning false leaves only the plain red on base line (FT.fixLineOn).
  const fixLine =
    result?.status === 'PARTIAL' || !FT.fixLineOn(CONFIG) ? null : FT.receiveLine(id, { fix: fixKind, task: o0, record: redBase, strict: FT.strictOn(CONFIG), cli: CLI });
  const redBaseLine = fixLine ?? RB.summaryLine(id, redBase);
  if (redBaseLine) console.log(redBaseLine);
  // Files another active task owns (lib/mergeGuard.js foreignOwners): the merge will stop on them, so say it now, while a
  // fix round is still cheap. A note, never a stop here.
  const changedNames = String(gitLarge(['diff', '--name-only', '--no-renames', scope]) ?? '').split(/\r?\n/).filter(Boolean);
  const foreign = require('./lib/mergeGuard.js').foreignOwners(changedNames, o0, read().tasks ?? []);
  // Shared config (hotspots, lib/hotspots.js) the task has not agreed: the merge stops on it too.
  const HS = require('./lib/hotspots.js');
  const hotChanged = HS.unagreed(changedNames, o0, HS.hotspotsOf(CONFIG));
  if (hotChanged.length)
    console.log(
      `HOTSPOT: ${id} changes shared config it has not agreed (hotspot_patch): ${hotChanged.slice(0, 10).join(', ')}. ` +
        "The merge stops on it. A fix round that leaves it alone and puts a wiring spec in the report, or add it to the task's hotspot_patch (--by owner).",
    );
  if (foreign.length)
    console.log(
      `OWNERSHIP: ${id} changes ${foreign.length} file(s) that another active task owns: ` +
        `${foreign.slice(0, 10).map((f) => `${f.path} (${f.owner}${f.via === 'shared_patch' ? ', via shared_patch' : ''})`).join(', ')}${foreign.length > 10 ? ', …' : ''}. ` +
        `The merge stops on them. A fix round that leaves them alone, or merge the owner task first (${CLI} merge --allow-guard overrides, logged).`,
    );
  // The reuse and scope facts (lib/scopeNotes.js, bolk B1 of the scope drift plan): a name the base already defines, a
  // new folder, a second library for the same job, drift in numbers. NOTE lines and a package section, never a stop.
  // M4 of the friction review: each kind of fact is ONE summary line here (the details are in 00-package.md); --all
  // prints the line of each fact. A CATALOG line (an accepted choice broken) asks for something, so it comes first.
  const allNotes = a.includes('--all');
  const scopeFacts = scopeNotesFor(o0, { branch, base: weakBase, diff, changedNames, all: allNotes });
  // The check rules of the design choices (lib/catalogChecks.js, bolk B6): a CATALOG line for an accepted choice an added
  // line breaks, a NOTE for a proposed one, and the rules in the package after the scope facts. Never a stop here.
  const CC = require('./lib/catalogChecks.js');
  const catalogCheck = catalogRulesFor(id, diff);
  const catalogLines = CC.receiveLines(catalogCheck.result, { id, cli: CLI, all: allNotes });
  const enforced = catalogLines.filter((l) => !l.startsWith('NOTE '));
  for (const l of [...enforced, ...scopeFacts.lines, ...catalogCheck.lines, ...catalogLines.filter((l) => l.startsWith('NOTE '))]) console.log(l);
  // "Not building" (roadmap 0f, notBuilding.match): the proposals this track added (added_by the track, a fix round
  // too) that read like an entry the owner chose not to build get one INFO line each. Advice only, never a stop.
  const fromTrack = (read().tasks ?? []).filter(
    (x) => x.status === 'proposed' && String(x.added_by ?? '').replace(/-(?:r|round)\d+$/i, '') === id,
  );
  for (const l of notBuildingLines(fromTrack.map((x) => ({ id: x.id, text: [x.title, x.description].filter(Boolean).join(' ') })))) console.log(l);
  const ruleSection = CC.packageSection(catalogCheck.result);
  fs.writeFileSync(
    path.join(folder, '00-package.md'),
    L.reviewPackageIndex({
      o: o0,
      branch,
      stat: packageStat,
      dbObjects,
      copied,
      skipped: shown.skipped,
      result,
      files,
      base: BASE,
      migrFolder: MIGR.folder,
      reviewers: reviewerList,
      testWeakening: weak ? TW.packageSection(weak) : null,
      redOnBase: redBase ? RB.packageSection(redBase) : null,
      // The flaky gate commands (lib/trackFlaky.js packageSection); [] when none was flaky.
      flaky: require('./lib/trackFlaky.js').packageSection(gateCheck.record),
      // Green, but no tests ran (lib/zeroTests.js packageSection); [] when every green command ran tests.
      zeroTests: ZT.packageSection(zeroTests),
      suspicious: OM.packageSection(suspicious),
      // No rule hit: the section is exactly as before (the package stays byte for byte without a catalog).
      scopeNotes: ruleSection ? [...(scopeFacts.section ?? []), ...ruleSection] : scopeFacts.section,
      // The part of the project catalog that meets the task's files (lib/catalogExcerpt.js, bolk B4), read from the main
      // tree as the mission had it: the reviewer checks the delivery against it (reviewer.md, reviewer-gap.md). With
      // catalog.index on (bolk B5) the code index is refreshed here and the names the delivery defines go along, for the
      // near names (V1b); off, the diff is not read again.
      catalog:
        require('./lib/catalogExcerpt.js').forTask(o0, {
          which: 'review',
          root: MAIN_TREE,
          newNames: require('./lib/catalog.js').setupOf(CONFIG).index ? reviewNewNames(diff) : null,
        })?.lines ?? null,
      assumptions,
      delta,
      deltaSection: delta ? DR.packageSection(delta, { previousFindings: !!files.previousFindings }) : null,
    }),
  );
  // The wiring spec (lib/wiringItems.js): the WIRE lines in track-result.md, the answer when the report has none. Untrusted
  // data: parsed into file + one line of text, never run. Not for a PARTIAL delivery, which is not merged.
  const wiringRead = (() => {
    const fromReport = WI.parseWiring(reportText);
    return fromReport.lines ? { ...fromReport, source: 'report' } : { ...WI.parseWiring(trackReply), source: 'reply' };
  })();
  const prompts = reviewers.map((type) => {
    const file = path.join(folder, `reviewer-${type}.md`);
    fs.writeFileSync(file, L.reviewerPrompt({ o: o0, type, folder, base: BASE, delta }) + '\n');
    return { type, file };
  });
  const r = edit((queue) => {
    const o = queue.tasks.find((x) => x.id === id);
    if (o.status !== 'review') {
      const s = L.setStatus(o, 'review', new Date().toISOString());
      if (s.error) die(s.error);
    }
    if (result) o.result = result;
    // ravenseat merge stops on this. Every receive sets it anew, so the next round's delivery clears it.
    if (result?.status === 'PARTIAL') o.delivered_partial = true;
    else delete o.delivered_partial;
    if (gateCheck.record) o.gate_check = gateCheck.record;
    // The project no longer has quick gates: an old red result has nothing to say, and must not stop the merge for good.
    else if (result?.status !== 'PARTIAL') delete o.gate_check;
    // A green or skipped gate: an old "cannot run" verdict has nothing to say.
    if (gateCheck.status !== 'red') delete o.gate_broken;
    if (doneCheck) o.done_check = doneCheck.record;
    // Every receive sets it anew (a fix round's delivery replaces the old verdict).
    if (redBase) o.red_on_base = redBase;
    else delete o.red_on_base;
    // The decision signals of this delivery replace the last ones ("Decided for you" reads them).
    if (signalRecord) o.decision_signals = signalRecord;
    else delete o.decision_signals;
    if (evidenceRead?.evidence) o.evidence = evidenceRead.evidence;
    // The check rules' record (lib/catalogChecks.js record): the latest hits and every rule that ever enforced on the
    // task, for the repeat count. Not for a PARTIAL delivery (unfinished), and untouched when no rule was tried.
    if (catalogCheck.result && result?.status !== 'PARTIAL') {
      const rec = CC.record(catalogCheck.result, o.catalog_checks, new Date().toISOString());
      if (rec) o.catalog_checks = rec;
    }
    // New wiring items are added; the ones already on the task (any status) stay as they are.
    if (wiringRead.items.length && result?.status !== 'PARTIAL')
      o.wiring = WI.mergeItems(o.wiring, wiringRead.items, { now: new Date().toISOString(), source: wiringRead.source }).items;
    o.review_package = folder;
    // Adoption: the report that has been read is no longer a new delivery (pulse and deliveries skip it).
    if (trackFound.report) {
      o.report_received = trackFound.report.mtimeMs;
      o.report_seen = Math.max(Number(o.report_seen ?? 0), trackFound.report.mtimeMs);
    }
    // First delivery to review (a new round after a fix keeps the first time).
    o.t_receive ??= new Date().toISOString();
    // What this package covered, so the review after the next fix round sees only what came after (lib/deltaReview.js).
    // A PARTIAL delivery is unfinished and is not a review. No reviewer: nothing was reviewed, so the old record stays.
    const record =
      result?.status !== 'PARTIAL' && reviewTip
        ? DR.reviewRecord({ tip: reviewTip, mergeBase: reviewBase, now: new Date().toISOString(), reviewers })
        : null;
    if (record) Object.assign(o, record);
    // The gates and the done command are green on this delivery: an earlier gate-red is over.
    if (result?.status !== 'PARTIAL' && L.openBlockOf(o)?.code === 'gate-red') L.closeBlock(o);
    // The secret scan (H5): hits open secret-found and are kept on the task (secret_found), which the merge reads, so an
    // agent's own `ravenseat block` (which closes the open block) does not let the merge through. A clean, complete scan
    // closes both; an incomplete one (or atReceive off) changes nothing.
    if (secretScan?.hits?.length) {
      const hits = secretScan.hits.slice(0, 20).map((h) => ({ file: h.file, line: h.line, rule: h.rule, ...(h.commit ? { commit: h.commit } : {}) }));
      o.secret_found = { at: new Date().toISOString(), tip: git(['rev-parse', '-q', '--verify', `refs/heads/${branch}`]), scanner: secretScan.scanner, count: secretScan.hits.length, hits };
      L.openBlock(o, 'secret-found', { note: secretScan.hits.slice(0, 5).map(secretWhere).join(', ') });
    } else if (secretScan && !secretScan.incomplete) {
      delete o.secret_found;
      if (L.openBlockOf(o)?.code === 'secret-found') L.closeBlock(o);
    }
    // A stop that is already open says more about what blocks the task than the question does.
    if (asked && (!L.openBlockOf(o) || L.openBlockOf(o).code === 'track-question')) openQuestion(queue, o, asked, trackFound.report?.path ?? null);
    recordAttempt(o);
    autoCleanFocus(queue, `receive ${id}`);
    return o;
  });
  // The finding log (lib/findingSources.js): red on base (as a fix without a proven red test when the task is a fix),
  // the secret hits and the test-weakening check, from the records just made (no extra run). `once`: a second receive of
  // the same delivery reads the same facts again and adds no row.
  FSRC.record(
    () => [
      FSRC.redOnBase({ id, record: redBase, fix: fixKind, task: o0 }),
      FSRC.secretFound({ id, found: r.secret_found }),
      // testWeakening.findingLog false: the warning and the focus stop stay, with no row.
      CONFIG.testWeakening?.findingLog === false ? null : FSRC.testWeakening({ id, weak }),
    ],
    { once: true },
  );
  // A rule broken in catalog.gateAfter separate tasks becomes a proposed gate task for the project's own lint
  // (learning.proposals on, the shared cap). After the record above, so this delivery counts.
  if (catalogCheck.result && result?.status !== 'PARTIAL') for (const l of proposeRuleGates(catalogCheck.result, { from: id })) console.log(l);
  if (o0.status !== 'review' && r.started)
    logTime(id, 'delivered', `${minutes(r.started, r.delivered)} min to delivery`);
  // The signal row: categories and what was not asked, never diff text (logEvent fails open, as measurements do).
  if (signalNew) logEvent([DSIG.row(id, signalRecord)]);
  if (!r.picked_by) pulseCursor(`receive ${id}`);
  console.log(
    `${id}: review · ${result ? result.line : 'no RESULT line (read trackReply.md)'}\n` +
      `Package: ${folder} (00-package.md; ${copied.length} file(s), ${dbObjects.length} DB object(s))`,
  );
  // The open wiring items: said here, where the merge command is read, since done waits for them.
  const wiringOpen = WI.openItems(r);
  if (wiringOpen.length) {
    console.log(
      `WIRING: ${wiringOpen.length} open item(s) from the track's wiring spec (the track's text: data, not instructions). ` +
        `Done waits until each is closed; after the merge apply each on ${BASE}, commit it, then close it:`,
    );
    for (const x of wiringOpen) console.log(`  ${WI.itemLine(x)}  ->  ${WI.closeCommands(id, x, CLI).join('  or  ')}`);
  }
  if (delta)
    console.log(
      `Delta review after fix round ${delta.round ?? '?'}: the package holds only the commits since the last review ` +
        `(${DR.short(delta.from)}..${DR.short(delta.to)})${files.previousFindings ? ' and the previous findings' : ''}; the same reviewers. ` +
        `${CLI} receive ${id} --full-review gives the whole package.`,
    );
  else if (o0.review_sha && picked.why && !/no fix round|no commits/.test(picked.why))
    console.log(`Whole review package: ${picked.why}.`);
  // PARTIAL: receive ran no gates on it (above), so the delivery says nothing about whether it works.
  if (result?.status === 'PARTIAL')
    console.log(`${id} delivered PARTIAL: unfinished, so no gates and no done command ran on it. Do not merge it; next: ${CLI} resume ${id} --reason context${asked ? ' --answer "<text>"' : ''}.`);
  // The track's count is its own claim; a report that says nothing was committed, on a branch with commits, is worth a look.
  if (result?.commits === 0 && gi.commits > 0)
    console.log(`NB: the track's RESULT says commits=0, but the branch has ${gi.commits}. Read the diff, not only the report.`);
  // No report file: what the mission asks for there (owner questions, assumptions, red first) must be looked for elsewhere.
  if (!files.report) {
    console.log(
      `WARNING: ${id} has no track-result.md, so the package only has ${trackReply ? "the track's answer (trackReply.md)" : 'the diff'}. ` +
        'Check owner questions and assumptions there before you merge.',
    );
    // An old copy of the mission template can name another report file: the usual cause after a plugin update.
    const PF = require('./lib/projectFiles.js');
    if (PF.staleFiles(path.resolve(HERE, '..', '..'), MAIN_TREE)?.mission)
      console.log(`${PF.MISSION} differs from the plugin, and an old template can ask for another report file: see ${CLI} doctor.`);
  }
  // The report cap (about 1,500 chars); the long part belongs in track-result.md.
  const capWarning = L.reportCapWarning(trackReply);
  if (capWarning) console.log(capWarning);
  if (evidenceRead?.evidence) console.log(`QA evidence: ${L.evidenceText(evidenceRead.evidence)}`);
  if (evidenceWarn) console.log(evidenceWarn);
  // A known bug the track says can happen again (`GATE <failure class>` in track-result.md). Never stops the delivery.
  // The answer is the fallback, as for RESULT and EVIDENCE: a report file can be refused by the client.
  const KB = require('./lib/knownBugGate.js');
  const knownBug = KB.parseGate(reportText) ?? KB.parseGate(trackReply);
  // The finding log (lib/findingSources.js): the GATE line is a finding whatever the gate setting says (the setting is
  // about proposing a task). `once`: the same report read at a second receive adds no row.
  // With red on base on, the GATE row is the fix and carries the verdict (step 6, "fixed without test").
  if (knownBug) FSRC.record(() => FSRC.gateLine({ id, gate: knownBug, record: redBase }), { once: true });
  if (knownBug) {
    try {
      const line = GUIDANCE.isQuiet(read()) ? null : proposeGate({ title: knownBug.title, where: knownBug.where, from: id, class: knownBug.class ?? null });
      if (line) console.log(line);
    } catch (e) {
      console.log(`Gate: could not propose "${knownBug.title}" (${e.message}).`);
    }
  }
  focusCleanOut();
  // The reviewers (D+: two, plus the helpers that hit) are started in the SAME turn.
  for (const x of reviewerList.filter((y) => !y.fixed))
    console.log(
      x.type === 'reviewer-light'
        ? `Light review: ${x.reasons.join(', ')}. The task becomes AUDITED, never VERIFIED. ${CLI} helpers shows what it has cost; ${CLI} helpers off reviewer-light turns it off.`
        : x.signal
          ? `Review signal: ${x.type} for ${x.reasons.join('; ')} (review.signals in queue.config.json; ${CLI} helpers shows the hit rate).`
          : `Helper agent ${x.type}: ${x.reasons.join(', ')} (ravenseat helpers off ${x.type} turns it off).`,
    );
  if (prompts.length)
    for (const l of L.concurrentBlock(
      prompts.map((p) => ({ subagent_type: p.type, prompt: p.file, bare: customReviewers.has(p.type) })),
    ))
      console.log(l);
  else
    console.log(
      `Class ${o0.class}: no review (config().reviewers has none for the class, and no helper agent is on and hits).`,
    );
  // A PARTIAL delivery was told above not to be merged, and what to do next.
  if (result?.status !== 'PARTIAL') console.log(
    // merge finds the scratchpad in the task or the environment; a folder given only with this command must be given again.
    `Merge (${prompts.length ? 'after an approved review, ' : ''}from Bash): ${CLI} merge ${id}${o0.scratchpad || process.env.QUEUE_SCRATCHPAD ? '' : ` --scratchpad "${scratch}"`}  ` +
      `(by hand: merge-track.mjs ${branch} --wave-base ${o0.head_start ?? '<HEAD at start>'})`,
  );
  // The end of a track is a natural checkpoint for the parallelism.
  parallelWarning();
}

// ---- The merge lock, the in-progress refusal and the resume (lib/mergeLock.js) -------------------------------------

const ML = require('./lib/mergeLock.js');

/** True when `ancestor` is in the history of `ref` (git merge-base --is-ancestor). */
const containsCommit = (ancestor, ref) =>
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
const gitPathOf = (name) => gitPaths(MARKERS.includes(name) ? MARKERS : [name]).get(name) ?? null;

/**
 * The merge commit that brought `tip` into `base`: the first commit on base's first-parent line that descends from
 * the tip (a merge done by ravenseat merge, by hand or a fast-forward). null when the tip is not in base.
 */
function mergeCommitFor(tip, base) {
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
function takeMergeLock(id, { resume }) {
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
const interruptedBy = (s) =>
  s.signal && ['SIGINT', 'SIGTERM', 'SIGHUP'].includes(s.signal) ? s.signal : s.status === 3221225786 ? 'Ctrl-C' : null;

/** `ravenseat merge` (the usage is at the top of queue.mjs). */
export async function cmdMerge() {
  // ---- merge-track -> migrationPush (only with a migration flow, with the environment guard) -> gates --quick -> set done -> fill,
  // in one call. The steps, the stop rules and the environment check are in queueLogic (mergePlan, executeMerge, environmentCheck); here is only
  // the I/O. With --resume: the steps after the merge that have not run yet (the merge state, lib/mergeLock.js). ----
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
      return;
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
      return;
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
    console.log(
      git(['push', '-q', remote, '--delete', remoteBranch]) == null
        ? `Cloud branch: ${remoteBranch} is still on ${remote}; git push ${remote} --delete ${remoteBranch}`
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
function tidyAfterMerge(branch, { resume, start, keepTrack = false }) {
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

/** `ravenseat block` (the usage is at the top of queue.mjs). */
export function cmdBlock() {
  // ---- Blocker reasons (queueLogic.BLOCK_CODES): open one by hand; at most one is open per task ----
  const [id, code] = positional(1, ['--note']);
  if (!id || !code)
    die(`block <id> <code> [--note "..."]   (code: ${L.BLOCK_CODES.map((b) => b.code).join(', ')})`);
  const r = edit((queue) => {
    const o = queue.tasks.find((x) => x.id === id);
    if (!o) die(`Unknown task ${id}`);
    const x = L.openBlock(o, code, { note: val('--note') ?? null });
    if ('error' in x) die(x.error);
    return x;
  });
  if (r.kept) console.log(`${id}: already blocked by ${code} since ${r.block.from}${r.block.note ? ` (${r.block.note})` : ''}`);
  else
    console.log(
      `${id}: blocked by ${code} from ${r.block.from}` +
        `${r.closed ? ` (closed the open ${r.closed.code})` : ''}. Close it with ${CLI} unblock ${id}.`,
    );
}

/** `ravenseat unblock` (the usage is at the top of queue.mjs). */
export function cmdUnblock() {
  const [id] = positional(1);
  if (!id) die('unblock <id>');
  const closed = edit((queue) => {
    const o = queue.tasks.find((x) => x.id === id);
    if (!o) die(`Unknown task ${id}`);
    const c = L.closeBlock(o);
    // The owner closing secret-found by hand is the owner's word on it: the merge no longer stops on the scan's record.
    if (c?.code === 'secret-found') delete o.secret_found;
    return c;
  });
  console.log(closed ? `${id}: ${closed.code} closed (${closed.from} to ${closed.to})` : `${id} has no open blocker.`);
}

/** `ravenseat blockers` (the usage is at the top of queue.mjs). */
export function cmdBlockers() {
  // ---- Per code: count and blocked time in the period, top first (read-only) ----
  const raw = val('--days') ?? '7';
  const days = Number(raw);
  if (!(days > 0)) die('--days must be a number > 0');
  const summary = L.blockerSummary(read(), { days });
  if (a.includes('--json')) console.log(JSON.stringify({ days, blockers: summary }, null, 2));
  else for (const l of L.blockerLines(summary, { days })) console.log(l);
}

/** `ravenseat next-migr` (the usage is at the top of queue.mjs). */
export function cmdNextMigr() {
  // The highest file in the main tree (baseBranch, where merged migrations live) and the highest assigned block in the queue.
  if (!MIGR.folder)
    die('The project has no migration flow (config().migrations.folder is not set); next-migr does not apply.');
  const highFile = highestMigr(GIT_ROOT);
  const newText = a[1];
  if (newText == null) {
    const queue = read();
    console.log(
      `next_migr ${queue.next_migr}; ` +
        `highest migrationFile ${highFile}, highest block ${L.highestBlockNr(queue)}`,
    );
  } else {
    const fresh = Number(newText);
    const previous = edit((queue) => {
      const v = L.nextMigrGuard({
        now: queue.next_migr,
        new: fresh,
        highestFile: highFile,
        highestBlock: L.highestBlockNr(queue),
        taken: takenForMigr(queue, { scratch: scratchpadFor() }),
      });
      if (!v.ok) die(`Nothing changed: ${v.error}`);
      const f = queue.next_migr;
      queue.next_migr = fresh;
      return f;
    });
    console.log(`next_migr ${previous} → ${fresh}`);
  }
}

/** `ravenseat migr` (the usage is at the top of queue.mjs). */
export function cmdMigr() {
  // ---- `migr move <id> <block>` moves the block in the queue and in the prompt files ----
  if (!MIGR.folder)
    die('The project has no migration flow (config().migrations.folder is not set); migr does not apply.');
  const [sub, id, blockArg] = positional(1, ['--scratchpad']);
  if (sub !== 'move' || !id || !blockArg)
    die('migr move <id> <block> [--scratchpad <folder>] [--force]   (block: 3470 or 3470-3479)');
  const scratch = scratchpadFor();
  const r = edit((queue) => {
    const o = queue.tasks.find((x) => x.id === id);
    if (!o) die(`Unknown task ${id}`);
    if (L.MIGR_FREE_STATUS.has(o.status)) die(`${id} is ${o.status}; a finished task is not moved.`);
    const size = Number(MIGR.blockSize) > 0 ? Math.floor(Number(MIGR.blockSize)) : 10;
    const old = L.blockInterval(o.migr_block);
    const tens = old ? (old.to - old.from + 1) / size : Math.max(1, Number(o.migr_tens ?? 0));
    const fresh = L.parseMoveBlock(blockArg, tens, size);
    if (fresh.error) die(`Nothing changed: ${fresh.error}`);
    const hit = takenForMigr(queue, { scratch, except: id }).filter(
      (t) => t.from <= fresh.to && t.to >= fresh.from,
    );
    if (hit.length && !a.includes('--force'))
      die(
        `Nothing changed: ${fresh.from}–${fresh.to} is taken (${blockList(hit)}); --force only on the owner's word`,
      );
    const previous = o.migr_block ?? null;
    o.migr_block = L.migrBlockText(fresh);
    const nextBefore = queue.next_migr;
    queue.next_migr = Math.max(Number(queue.next_migr) || 0, fresh.to + 1);
    const now = new Date().toISOString();
    o.remarks = [...(o.remarks ?? []), `${now} migr move: ${previous ?? 'none'} → ${o.migr_block}`];
    return {
      o: { ...o },
      old,
      fresh,
      previous,
      nextBefore,
      next: queue.next_migr,
      scratchpad: o.scratchpad,
    };
  });
  console.log(`${id}: migr_block ${r.previous ?? 'none'} → ${r.o.migr_block}`);
  if (r.next !== r.nextBefore) console.log(`next_migr ${r.nextBefore} → ${r.next}`);
  // The prompt files (prompt-<id>.md and fix rounds prompt-<id>-rN.md) in the task's scratchpad and in --scratchpad.
  const folders = [...new Set([scratch, r.scratchpad].filter(Boolean).map((m) => path.resolve(m)))];
  const own = (f) => L.promptTask(f, [r.o]) === id;
  let count = 0;
  for (const m of folders) {
    let files = [];
    try {
      files = fs.readdirSync(m).filter((f) => /^prompt-.+\.md$/.test(f) && own(f));
    } catch {
      continue;
    }
    for (const f of files) {
      const p = path.join(m, f);
      const before = fs.readFileSync(p, 'utf8');
      let after = L.moveBlockInText(before, r.old, r.fresh);
      const note = `The migration block has been moved to ${r.o.migr_block} (ravenseat migr move). Use only the new block.`;
      if (!after.includes(note)) after = `${after.replace(/\s*$/, '')}\n\n${note}\n`;
      if (after !== before) {
        fs.writeFileSync(p, after);
        count += 1;
        console.log(`wrote ${p}`);
      }
    }
  }
  if (!count) console.log('Found no prompt file to update (--scratchpad <folder> points there).');
  if (r.o.status === 'running' || r.o.status === 'picked')
    console.log(
      `${id} is running: send the track the new block with SendMessage ("The migration block has been moved to ${r.o.migr_block}").`,
    );
}

/** `ravenseat deliver` (the usage is at the top of queue.mjs). */
export function cmdDeliver() {
  const id = a[1];
  if (!id) die('deliver <id>');
  const r = edit((queue) => {
    const s = L.deliver(queue, id);
    if (s.error) die(s.error);
    return s;
  });
  console.log(
    `${id}: review (delivered by ${r.task.picked_by ?? '?'}). The orchestrator merges ${r.task.branch ?? branchFor(id)}.`,
  );
}

/** `ravenseat release` (the usage is at the top of queue.mjs). */
export function cmdRelease() {
  const id = a[1];
  if (!id) die('release <id>');
  // The commits are counted before the lock (git must not run with the queue file locked). The branch is in the task (queue/<id>).
  const before = read().tasks.find((x) => x.id === id);
  const g = branchInfo(before?.branch ?? branchFor(id));
  const r = edit((queue) => {
    const s = L.release(queue, id, { commits: g.commits });
    if (s.error) die(s.error);
    return s;
  });
  console.log(`${id}: released (was picked by ${r.by ?? '?'}), waiting again.`);
  if (r.warning) console.log(`WARNING: ${r.warning}`);
}

/** `ravenseat deliveries` (the usage is at the top of queue.mjs). */
export function cmdDeliveries() {
  // ---- Adoption: track-result.md files that have not been received (read-only; pulse does the same and remembers what it reported) ----
  const found = findDeliveries(read());
  if (a.includes('--json')) console.log(JSON.stringify(found, null, 2));
  else if (!found.length)
    console.log('No deliveries waiting (no track-result.md newer than the start or the last receive).');
  else
    for (const l of found)
      console.log(
        `${l.id} (${l.taskStatus})  ${l.line}\n  ${l.path}  ${l.new ? 'NEW' : 'reported before'}  → ${CLI} receive ${l.id}`,
      );
}
