// =============================================================
// cli/merge.mjs: the commands that finish work: receive, merge, block, unblock, blockers, deliver, release, deliveries, next-migr, migr.
//
// receive (take in a finished track), merge (merge-track.mjs, the gates and the migration push, with the merge guard
// and the base gate of cli/baseHealth.mjs: a red base branch refuses the merge, a merge that makes it red adds a fix task),
// the merge blocks, deliver/release of a picked task, deliveries (a report.md that has not been received yet), and the
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
  a, autoCleanFocus, BASE, branchFor, branchInfo, CONFIG, CQ, die, edit, focusCleanOut, FOLDER, git, GIT_ROOT, HELP,
  HERE, L, MAIN_TREE, MIGR, parallelWarning, positional, pulseCursor, read, require, TK, val,
} from './context.mjs';
import {
  blockList, findDeliveries, gitLarge, highestMigr, lastTrackReply, logTime, mergeBlock, minutes, readTimeLog,
  reviewerFindingsLines, scratchpadFor, takenForMigr, taskAgents,
} from './tracks.mjs';
import {
  BASE_SETUP, BH, flakyRecheck, gateRowsNow, guardBeforeMerge, HEALTH_FILE, recordVerdict, redLines, runCheckNow, treeOf, writeReport,
} from './baseHealth.mjs';
import { logEvent } from './events.mjs';

const ER = require('./lib/eventRows.js');
const CP = require('./lib/conflictPredict.js');

// ---- The done command (task field done_when, lib/doneCheck.js): receive and merge ---------------------------------

/**
 * Runs the task's done command in the track's worktree (the worktree that has the branch checked out; --done-cwd
 * overrides) and writes the tail of the output to `done-<id>.md` in the scratchpad (the data folder without one).
 * null when the task has no done command. Stops (exit 1, nothing changed) when no worktree has the branch: the command
 * must run on the track's own files, and the queue never creates or removes worktrees here (the shared links make a
 * delete dangerous, see cleanup-worktree.mjs).
 * @returns {null | { ok: boolean, run: object, record: object, file: string, cwd: string }}
 */
function runDoneCommand(o, { branch, scratch, step }) {
  const DC = require('./lib/doneCheck.js');
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
  const run = DC.runDoneWhen({ command, cwd, ...setup });
  const folder = scratch ?? FOLDER;
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, `done-${o.id}.md`);
  // Only the tail is written (lib/doneCheck.js, Secrets): the full output never leaves this process.
  fs.writeFileSync(file, DC.doneCheckReport({ id: o.id, command, cwd, step, run, tip }));
  const record = {
    ok: run.ok,
    exit: run.exit,
    ...(run.timedOut ? { timed_out: true } : {}),
    command,
    tip,
    step,
    at: new Date().toISOString(),
    duration_s: run.durationSec,
    file,
  };
  console.log(`Done command ${run.ok ? 'GREEN' : 'RED'} (${run.timedOut ? 'time budget' : `exit ${run.exit ?? '?'}`}, ${run.durationSec} s).`);
  return { ok: run.ok, run, record, file, cwd };
}

/**
 * A red done command gets the same treatment as a red gate: the blocker gate-red, the last lines on screen and a fix
 * round (`cq resume <id> --reason fix` with the tail file as findings; resume puts the tail into the brief and applies
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
  if (r.status === 0) console.log(`Start the fix round in the SAME turn (the line above), then ${CQ} receive ${id} again.`);
  process.exit(r.status === 8 ? 8 : 1);
}

// ---- The gate evidence at receive (lib/gateEvidence.js) -------------------------------------------------------------

/**
 * The quick gates bound to the delivered tip. The track's RESULT line (`gates=OK`) and its own gate rows in the time
 * log are informational only: what counts is a green, clean run of every quick gate on exactly the branch tip, recorded
 * by gates.mjs for the orchestrator (lib/gateEvidence.js). When the store has one for this tip (an earlier receive, no
 * new commits since), nothing runs. Otherwise receive runs `gates.mjs --quick --evidence` in the track's worktree (the
 * one with the branch checked out; --done-cwd overrides) and reads the evidence that run recorded.
 * Refused (exit 1, nothing changed), as for the done command: no worktree has the branch, the worktree is not at the
 * branch tip, or it has uncommitted tracked changes (a green run would then not be bound to the tip).
 * @returns {{ status: 'off' } | { status: 'green'|'red', record: object, check?: { run: object, file: string } }}
 */
function receiveGates(o, { branch, scratch }) {
  const GE = require('./lib/gateEvidence.js');
  const DC = require('./lib/doneCheck.js');
  const commands = (Array.isArray(CONFIG.gates?.quick) ? CONFIG.gates.quick : [])
    .filter((g) => typeof g === 'string' && g.trim())
    .map((g) => g.trim());
  if (!commands.length) return { status: 'off' };
  const tip = git(['rev-parse', '--verify', `refs/heads/${branch}`]);
  const storeFile = GE.storeFile(FOLDER);
  const known = GE.latest(GE.readStore(storeFile).entries, { sha: tip, kinds: ['quick', 'full'], commands });
  if (known?.ok === true) {
    console.log(`Gates green at ${String(tip).slice(0, 12)} (${known.kind}, cq's own run at ${known.time}); not run again.`);
    return {
      status: 'green',
      record: { ok: true, kind: known.kind, tip, at: new Date().toISOString(), ran: false, evidence_at: known.time },
    };
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
  const logFile = path.join(folder, `gates-receive-${o.id}.log`);
  console.log(`GATES (receive) for ${o.id} in ${cwd}: ${commands.join(' ; ')}  (the quick gates, cq's own run)`);
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
  const entry = GE.latest(GE.readStore(storeFile).entries, { sha: tip, kinds: ['quick'], commands });
  // The run's own result and its recorded evidence must agree; a green exit without an entry (a commit during the run,
  // or the store could not be written) is no evidence.
  if (r.status === 0 && entry?.ok === true) {
    console.log(`Gates GREEN at ${String(tip).slice(0, 12)} (${durationSec} s), recorded as evidence for that commit.`);
    return { status: 'green', record: { ok: true, kind: 'quick', tip, at: entry.time, ran: true, duration_s: durationSec } };
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
  // Only the tail goes into the fix brief (as for the done command: a secret printed early is not copied around).
  const tail = DC.tailOf(text, DC.doneCheckSetup(CONFIG).tailLines);
  const file = path.join(folder, `gates-${o.id}.md`);
  fs.writeFileSync(
    file,
    [
      `# Quick gates for ${o.id} at ${String(tip).slice(0, 12)}: RED (exit ${r.status ?? '?'})`,
      '',
      `- Commands: ${commands.map((c) => `\`${c}\``).join(', ')}`,
      `- Where: ${cwd} (cq receive's own run; the track's RESULT line is not evidence)`,
      '',
      `The last ${tail.length} line(s) of the output:`,
      '',
      '~~~~',
      ...tail,
      '~~~~',
      '',
    ].join('\n'),
  );
  console.log(`Gates RED at ${String(tip).slice(0, 12)} (exit ${r.status ?? '?'}, ${durationSec} s).`);
  return {
    status: 'red',
    record: { ok: false, kind: 'quick', tip, at: new Date().toISOString(), ran: true, exit: r.status, duration_s: durationSec, file },
    check: { run: { tail, exit: r.status }, file },
  };
}

/** `cq receive` (the usage is at the top of queue.mjs). */
export function cmdReceive() {
  // ---- A track has delivered -> review + review package as plain files + reviewer prompts ----
  const id = positional(1, ['--scratchpad', '--result', '--done-cwd'])[0];
  if (!id) die('receive <id> [--scratchpad <folder>] [--result "RESULT ..."] [--force]');
  const o0 = read().tasks.find((x) => x.id === id);
  if (!o0) die(`Unknown task ${id}`);
  if (!['running', 'picked', 'review'].includes(o0.status))
    die(`${id} has status ${o0.status}; receive applies to running, picked or review.`);
  const scratch = scratchpadFor(o0.scratchpad ?? null);
  if (!scratch) die('receive needs --scratchpad <folder> (or QUEUE_SCRATCHPAD).');
  const branch = o0.branch ?? branchFor(id);
  const gi = branchInfo(branch);
  if (!gi.exists) die(`Branch ${branch} does not exist.`);
  if (gi.commits === 0 && !a.includes('--force'))
    die(
      `${branch} has no commits ahead of ${BASE} (already merged?). The package will be empty; --force to make it anyway.`,
    );
  const scope = `${BASE}...${branch}`;
  const folder = path.join(scratch, `rev-${id}`);
  // The package is made again every time (a new round after a fix replaces the old one). Only files we made ourselves.
  fs.rmSync(folder, { recursive: true, force: true });
  fs.mkdirSync(path.join(folder, 'files'), { recursive: true });
  const stat = gitLarge(['diff', '--stat', scope]) ?? '';
  const diff = gitLarge(['diff', scope]) ?? '';
  fs.writeFileSync(path.join(folder, 'diff.patch'), diff);
  const { copy, skipped } = L.packageFiles(
    gitLarge(['diff', '--name-status', '--no-renames', scope]),
    gitLarge(['diff', '--numstat', '--no-renames', scope]),
  );
  const copied = [];
  for (const filePath of copy) {
    const content = gitLarge(['show', `${branch}:${filePath}`], { buffer: true });
    if (content == null) {
      skipped.push({ path: filePath, reason: 'could not be read from the branch' });
      continue;
    }
    const templateFile = path.join(folder, 'files', ...filePath.split('/'));
    fs.mkdirSync(path.dirname(templateFile), { recursive: true });
    fs.writeFileSync(templateFile, content);
    copied.push(filePath);
  }
  // The track's answer (from the transcript), report.md and handover.md from the track folder in the scratchpad.
  const agents = taskAgents(o0);
  const trackReply = lastTrackReply(agents);
  const files = {};
  if (trackReply) {
    fs.writeFileSync(path.join(folder, 'trackReply.md'), trackReply);
    files.trackReply = true;
  }
  // Adoption: the newest report in the orchestrator's and the task's scratchpad, also from a fix round (<id>-r<N>/).
  const trackFound = L.findTrackReport(id, [scratch, o0.scratchpad ?? null]);
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
  // The quick gates bound to the delivered tip (receiveGates), BEFORE the done command and any reviewer: the track's own
  // claim is informational only. A PARTIAL track is known to be unfinished, so no gate runs for it.
  if (result?.gates != null)
    console.log(`The track's RESULT gates=${result.gates} is self-reported (informational only; receive checks the tip itself).`);
  const gateCheck = result?.status === 'PARTIAL' ? { status: 'off' } : receiveGates(o0, { branch, scratch });
  if (gateCheck.status === 'red') {
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
      return o;
    });
    if (!o0.picked_by) pulseCursor(`receive ${id} gates red`);
    doneCommandRed(id, gateCheck.check, { scratch, what: 'quick gate run (cq receive, on the delivered tip)' });
  }
  // The done command (lib/doneCheck.js), BEFORE any reviewer is started: a red one is not a delivery but a fix round.
  // A PARTIAL track is known to be unfinished (a context continuation), so the command is not run for it.
  const doneCheck = result?.status === 'PARTIAL' ? null : runDoneCommand(o0, { branch, scratch, step: 'receive' });
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
      return o;
    });
    if (!o0.picked_by) pulseCursor(`receive ${id} done command red`);
    doneCommandRed(id, doneCheck, { scratch });
  }
  // QA evidence: the EVIDENCE line (report.md first, otherwise the answer) and the warning when a task that needs it
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
      console.log(`Helper agent ${s.name}: turned off and left out (${HELP.REVIEW_TEXT[s.review]}; cq helpers scan ${s.name}).`);
  }
  const reviewerList = L.reviewersForTask(o0, {
    queue: read(),
    changedPaths: [...copy, ...skipped.map((h) => h.path)],
    missionText,
    hashes: checked.hashes,
  });
  const reviewers = reviewerList.map((x) => x.type);
  const customReviewers = new Set(reviewerList.filter((x) => x.custom).map((x) => x.type));
  const dbObjects = L.dbObjectsFromDiff(diff, { folder: MIGR.folder });
  // Test weakening (lib/testWeakening.js): deleted test files and added skip/focus markers. A warning, never a stop.
  const TW = require('./lib/testWeakening.js');
  const weak = CONFIG.testWeakening?.enabled === false ? null : TW.assess(diff, CONFIG.testWeakening);
  const weakLine = weak && TW.summaryLine(weak);
  if (weakLine) console.log(weakLine);
  fs.writeFileSync(
    path.join(folder, '00-package.md'),
    L.reviewPackageIndex({
      o: o0,
      branch,
      stat,
      dbObjects,
      copied,
      skipped,
      result,
      files,
      base: BASE,
      migrFolder: MIGR.folder,
      reviewers: reviewerList,
      testWeakening: weak ? TW.packageSection(weak) : null,
    }),
  );
  const prompts = reviewers.map((type) => {
    const file = path.join(folder, `reviewer-${type}.md`);
    fs.writeFileSync(file, L.reviewerPrompt({ o: o0, type, folder, base: BASE }) + '\n');
    return { type, file };
  });
  const r = edit((queue) => {
    const o = queue.tasks.find((x) => x.id === id);
    if (o.status !== 'review') {
      const s = L.setStatus(o, 'review', new Date().toISOString());
      if (s.error) die(s.error);
    }
    if (result) o.result = result;
    if (gateCheck.record) o.gate_check = gateCheck.record;
    if (doneCheck) o.done_check = doneCheck.record;
    if (evidenceRead?.evidence) o.evidence = evidenceRead.evidence;
    o.review_package = folder;
    // Adoption: the report that has been read is no longer a new delivery (pulse and deliveries skip it).
    if (trackFound.report) {
      o.report_received = trackFound.report.mtimeMs;
      o.report_seen = Math.max(Number(o.report_seen ?? 0), trackFound.report.mtimeMs);
    }
    // First delivery to review (a new round after a fix keeps the first time).
    o.t_receive ??= new Date().toISOString();
    autoCleanFocus(queue, `receive ${id}`);
    return o;
  });
  if (o0.status !== 'review' && r.started)
    logTime(id, 'delivered', `${minutes(r.started, r.delivered)} min to delivery`);
  if (!r.picked_by) pulseCursor(`receive ${id}`);
  console.log(
    `${id}: review · ${result ? result.line : 'no RESULT line (read trackReply.md)'}\n` +
      `Package: ${folder} (00-package.md; ${copied.length} file(s), ${dbObjects.length} DB object(s))`,
  );
  // The report cap (about 1,500 chars); the long part belongs in report.md.
  const capWarning = L.reportCapWarning(trackReply);
  if (capWarning) console.log(capWarning);
  if (evidenceRead?.evidence) console.log(`QA evidence: ${L.evidenceText(evidenceRead.evidence)}`);
  if (evidenceWarn) console.log(evidenceWarn);
  focusCleanOut();
  // The reviewers (D+: two, plus the helpers that hit) are started in the SAME turn.
  for (const x of reviewerList.filter((y) => !y.fixed))
    console.log(`Helper agent ${x.type}: ${x.reasons.join(', ')} (cq helpers off ${x.type} turns it off).`);
  if (prompts.length)
    for (const l of L.concurrentBlock(
      prompts.map((p) => ({ subagent_type: p.type, prompt: p.file, bare: customReviewers.has(p.type) })),
    ))
      console.log(l);
  else
    console.log(
      `Class ${o0.class}: no review (config().reviewers has none for the class, and no helper agent is on and hits).`,
    );
  console.log(
    `Merge (after an approved review, from Bash): ${CQ} merge ${id}  ` +
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

/** The absolute path of a file in the main checkout's git directory (MERGE_HEAD, rebase-merge, ...). */
const gitPathOf = (name) => {
  const p = git(['rev-parse', '--git-path', name]);
  return p ? path.resolve(GIT_ROOT, p) : null;
};

/**
 * The merge commit that brought `tip` into `base`: the first commit on base's first-parent line that descends from
 * the tip (a merge done by cq merge, by hand or a fast-forward). null when the tip is not in base.
 */
function mergeCommitFor(tip, base) {
  if (!containsCommit(tip, `refs/heads/${base}`)) return null;
  const list = git(['rev-list', '--first-parent', '--ancestry-path', '--reverse', `${tip}..refs/heads/${base}`]);
  const first = (list ?? '').split(/\r?\n/).filter(Boolean)[0];
  // Nothing on the line after the tip: base IS the tip (a fast-forward, or the branch was reset onto base).
  return first ?? tip;
}

/**
 * Takes the merge lock (one cq merge at a time per data folder) and makes sure it is released however the process ends:
 * a normal end, die()/process.exit (the 'exit' handler), an uncaught error (also 'exit') and Ctrl-C or a kill
 * (the signal handlers, which also record the interruption in the merge state). A hard crash (power, kill -9) leaves
 * the lock behind; the next merge sees that its pid is gone and takes it over.
 */
function takeMergeLock(id, { resume }) {
  const got = ML.acquire(FOLDER, { task: id, command: resume ? 'merge --resume' : 'merge' });
  if (!got.ok) die(ML.heldMessage({ file: got.file, holder: got.holder, cq: CQ, id }));
  if (got.tookOver) {
    const h = got.tookOver.holder;
    console.log(
      `NB: took over a stale merge lock (${h?.command ?? 'merge'} ${h?.task ?? '?'}: ${got.tookOver.reason}).` +
        `${h?.task ? ` If that merge was cut off, ${CQ} merge ${h.task} --resume finishes it.` : ''}`,
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

/** `cq merge` (the usage is at the top of queue.mjs). */
export async function cmdMerge() {
  // ---- merge-track -> migrationPush (only with a migration flow, with the environment guard) -> gates --quick -> set done -> fill,
  // in one call. The steps, the stop rules and the environment check are in queueLogic (mergePlan, executeMerge, environmentCheck); here is only
  // the I/O. With --resume: the steps after the merge that have not run yet (the merge state, lib/mergeLock.js). ----
  const id = positional(1, ['--scratchpad', '--done-cwd'])[0];
  if (!id)
    die(
      'merge <id> [--resume] [--without-migr-push] [--without-fill] [--scratchpad <folder>] [--force] [--allow-guard] [--force-red-base]',
    );
  const resume = a.includes('--resume');
  // The merge guard's override (see lib/mergeGuard.js): passed on to merge-track.mjs, which logs it.
  const allowGuard = a.includes('--allow-guard');
  if (!read().tasks.some((x) => x.id === id)) die(`Unknown task ${id}`);
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
        cq: CQ,
        branch,
        branchTip,
        branchOf: (sha) => tips.get(sha) ?? null,
        taskOf: (b) => tasks.find((t) => (t.branch ?? branchFor(t.id)) === b)?.id ?? null,
      }),
    );
  }
  const state0 = ML.readState(FOLDER, id);
  const force = a.includes('--force');
  if (resume) {
    const left = state0 ? ML.remainingSteps(state0.plan ?? [], state0.steps_done ?? []) : [];
    if (o.status === 'done' && !left.some((s) => s !== 'done')) {
      ML.clearState(FOLDER, id);
      console.log(`${id} is done; nothing to resume.`);
      return;
    }
    if (!['review', 'done'].includes(o.status) && !(force && ['running', 'picked'].includes(o.status)))
      die(`${id} has status ${o.status}; merge --resume applies to a task in review whose branch is already merged.`);
  } else if (o.status !== 'review' && !(force && ['running', 'picked'].includes(o.status)))
    die(
      `${id} has status ${o.status}; merge applies to review (after receive and an approved review). ` +
        '--force only for running/picked on the owner\'s word.',
    );
  const gi = branchInfo(branch);
  if (!gi.exists) die(`Branch ${branch} does not exist.`);
  const trackTip = branchTip;
  const tipInBase = containsCommit(trackTip, `refs/heads/${BASE}`);
  if (resume && !tipInBase)
    die(
      `${branch} at ${String(trackTip).slice(0, 12)} is not in ${BASE}, so there is nothing to resume: the merge itself ` +
        `has not happened${gi.commits ? ` (${gi.commits} commit(s) ahead)` : ''}. Run ${CQ} merge ${id} (without --resume).`,
    );
  if (!resume && gi.commits === 0) {
    // M7: the branch is in base already. A task still in review was cut off after the merge (Ctrl-C, a crash, a stop
    // after the merge): the remaining steps are what is left, not a new merge.
    if (tipInBase && o.status === 'review')
      die(
        `${branch} is already merged into ${BASE} (its tip ${String(trackTip).slice(0, 12)} is on ${BASE}), but ${id} is ` +
          'still in review: the merge was cut off before the end' +
          `${state0?.steps_done?.length ? ` (steps done: ${state0.steps_done.join(', ')})` : ''}. ` +
          `Run the remaining steps (migration push, gates, base gate, done, fill) with: ${CQ} merge ${id} --resume`,
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
  // The base gate (lib/baseHealth.js) BEFORE anything else runs: a red base refuses the merge (exit 9) unless this is the
  // base fix task or --force-red-base (logged); an unknown verdict (the tip moved since the last check) is checked first.
  // `wasRed` is the red record the merge goes on despite, so the record after it keeps the merge that made it red.
  // A resume does not ask: the merge is in already, and the base gate on it is one of the steps that are left.
  const wasRed = resume ? null : guardBeforeMerge({ id, force: a.includes('--force-red-base'), folder: scratch ?? FOLDER });
  // The done command (lib/doneCheck.js) once more before the merge, unless the last run was green on this exact tip with
  // this command (receive ran it, and no fix round has added commits since). Red: a fix round, never a merge.
  if (typeof o.done_when === 'string' && o.done_when.trim()) {
    const tipNow = git(['rev-parse', '--verify', `refs/heads/${branch}`]);
    const last = o.done_check;
    if (last?.ok && last.tip === tipNow && last.command === o.done_when.trim())
      console.log(`Done command green at ${String(tipNow).slice(0, 12)} (${last.step}, ${last.at}); not run again.`);
    else {
      const check = runDoneCommand(o, { branch, scratch, step: 'merge' });
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
      `\nINTERRUPTED (${sig}) in the step ${mstate.current ?? '(between steps)'} of ${CQ} merge ${id}. Steps done: ` +
        `${mstate.steps_done.join(', ') || 'none'}. Continue with ${CQ} merge ${id} --resume ` +
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
  const remark =`merged with cq merge${plan.migrPush ? ' (migrations pushed)' : ''}`;
  /** The command for one step: [program, arguments, shell?]. The migration command is a shell line from the config. */
  const command = ({ step }) => {
    if (step === 'merge')
      return [
        process.execPath,
        [
          path.join(HERE, 'merge-track.mjs'),
          branch,
          ...(o.head_start ? ['--wave-base', o.head_start] : []),
          ...(allowGuard ? ['--allow-guard'] : []),
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
          // When the quick gates are the base gate, they get its time budget (a hanging gate must not hold the merge).
          ...(BASE_SETUP.enabled && BASE_SETUP.sameAsQuick ? ['--timeout-sec', String(BASE_SETUP.timeoutSec)] : []),
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
    const before = wasRed ?? (v.previous?.status === 'red' ? v.previous : null);
    if (before?.fix_task && before.fix_task !== id)
      baseLines.push(
        `${BASE} is green again, but the base fix task ${before.fix_task} is still open: cancel it if it is obsolete ` +
          `(${CQ} set ${before.fix_task} cancelled).`,
      );
  };
  // The skip rule: the merge commit has the tree of the track tip, and cq's own gate run (receive) was green on that
  // tip. The rows are the trusted gate evidence (lib/gateEvidence.js), never the time log a track can append to.
  const skipNow = () =>
    BH.skipEvidence({ newTip: mergeCommit, trackTip, treeOf, rows: gateRowsNow(), commands: BASE_SETUP.commands });
  const skipped = (reason) => {
    settleBase({ ok: true, skipped: reason });
    return { code: 0, out: `skipped, recorded green: ${reason}` };
  };
  /** The `base-gate` step: the base gate commands on the merge commit, in the main checkout (or the skip rule). */
  const baseGateStep = () => {
    if (!mergeCommit) return { code: 1, out: 'no merge commit to check' };
    const sk = skipNow();
    if (sk.skip) return skipped(sk.reason);
    const check = runCheckNow({ tip: mergeCommit, folder: logFolder, cause: { task: id, merge_commit: mergeCommit } });
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
        if (!containsCommit(trackTip, head)) {
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
    }
    if (x.step === 'gates' && BASE_SETUP.enabled && mergeCommit) {
      // The flaky check (lib/baseHealth.js): the failed quick gates once more on the same sha before the base freezes.
      const flaky = r.code !== 0 ? flakyRecheck({ tip: mergeCommit, causeId: id }) : null;
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
    beforeDone: () =>
      containsCommit(trackTip, `refs/heads/${BASE}`)
        ? null
        : `NOT DONE: ${branch} at ${short(trackTip)} is not in ${BASE} (git merge-base --is-ancestor failed), so ${id} ` +
          'is not marked done and stays in review. Check git log on the base (was it reset or moved?) and merge again.',
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
    console.log(`BASE: ${BASE} at ${short(mergeCommit)} is not checked yet (the flow stopped first); the next ${CQ} merge checks it first.`);
  const printBase = () => {
    for (const l of baseLines) console.log(l);
  };
  if (!res.ok && res.stop.step === 'merge' && mergeCode === 4) {
    // The merge guard: nothing was merged. Say what to do instead of a raw exit code.
    console.log(
      `STOP: the merge guard stopped ${branch} before the merge. The branch changes protected paths ` +
        `(protectedPaths in queue.config.json: hooks, settings, agents, orchestrator scripts, the queue config, ` +
        `package.json) that ${id} does not own. Nothing was merged.`,
    );
    if (res.stop.excerpt.length) console.log(res.stop.excerpt.map((l) => `  | ${l}`).join('\n'));
    console.log(
      `Read the diff first: git diff ${BASE}...${branch} -- <path>. A change you did not ask for may come from text ` +
        'the track read (prompt injection): then do not merge, and start a fix round.\n' +
        `If the change is intended: add the path to the task's owned_files/shared_patch (after start: \`${CQ} edit ${id} --by owner\`), or run ` +
        `\`${CQ} merge ${id} --allow-guard\` (logged as "guard-overridden").`,
    );
    ML.clearState(FOLDER, id);
    mergeBlock(id, 'merge-conflict', 'merge guard');
    logEvent(ER.mergeConflictRow({ task: id, branch, files: ER.conflictFiles(mergeOut), guard: true }));
    console.log(`Full log: ${logFile}`);
    process.exit(4);
  }
  if (!res.ok) {
    // A stop in the merge or the gates step opens a blocker reason (cq blockers); the next successful merge closes it.
    const code = { merge: 'merge-conflict', gates: 'gate-red' }[res.stop.step];
    if (code) mergeBlock(id, code, res.stop.message);
    // The mergeConflict row (lib/eventRows.js): only when merge-track itself failed (not the wrong branch), and not
    // when it said "No conflicts." (a validation stop). Fail open.
    if (code === 'merge-conflict' && mergeCode != null && mergeCode !== 0 && ER.conflictFiles(mergeOut) !== 0)
      logEvent(ER.mergeConflictRow({ task: id, branch, files: ER.conflictFiles(mergeOut) }));
    console.log(`STOP in the step ${res.stop.step}: ${res.stop.message}`);
    if (res.stop.excerpt.length) console.log(res.stop.excerpt.map((l) => `  | ${l}`).join('\n'));
    // After the merge, the rest can be continued once the cause is fixed (the environment, a flaky gate, a base reset).
    if (containsCommit(trackTip, `refs/heads/${BASE}`)) {
      const left = ML.remainingSteps(plan.step, mstate.steps_done);
      if (left.length)
        console.log(`RESUME: when the cause is fixed, ${CQ} merge ${id} --resume runs the steps that are left (${left.join(', ')}).`);
    } else if (ML.gitInProgress(gitPathOf).some((x) => x.kind === 'merge'))
      console.log(
        `RESUME: resolve the files, git add them and git commit --no-edit, then ${CQ} merge ${id} --resume runs the rest ` +
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
          for (const l of CP.mergeStopLines(mc, { id, cq: CQ })) console.log(l);
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
  edit((queue) => {
    const ox = queue.tasks.find((x) => x.id === id);
    if (!ox) return null;
    if (resume) ox.t_merge ??= new Date().toISOString();
    else ox.t_merge = new Date().toISOString();
    if (mstate.merge_commit) ox.merge_commit = mstate.merge_commit;
    if (diffLines != null) ox.diff_lines = diffLines;
    const tReview = TK.firstReviewStart(readTimeLog(), id, {
      types: L.REVIEWER_TYPES,
      from: ox.t_receive ?? null,
    });
    if (tReview && !ox.t_review) ox.t_review = tReview;
    // The merge went through: an open blocker (merge-conflict, gate-red or one set by hand) is closed.
    L.closeBlock(ox);
    delete ox.merge_conflict;
    return ox;
  });
  ML.clearState(FOLDER, id);
  console.log(`Full log: ${logFile}`);
  printBase();
  // The merge went through, but the base gate made the base red: exit 9 (as a refused merge), so a script that chains
  // merges stops here instead of reading a 0.
  if (baseSettled && BH.verdict(BH.readState(HEALTH_FILE), mergeCommit) === 'red') process.exit(BH.EXIT_RED_BASE);
}

/** `cq block` (the usage is at the top of queue.mjs). */
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
        `${r.closed ? ` (closed the open ${r.closed.code})` : ''}. Close it with ${CQ} unblock ${id}.`,
    );
}

/** `cq unblock` (the usage is at the top of queue.mjs). */
export function cmdUnblock() {
  const [id] = positional(1);
  if (!id) die('unblock <id>');
  const closed = edit((queue) => {
    const o = queue.tasks.find((x) => x.id === id);
    if (!o) die(`Unknown task ${id}`);
    return L.closeBlock(o);
  });
  console.log(closed ? `${id}: ${closed.code} closed (${closed.from} to ${closed.to})` : `${id} has no open blocker.`);
}

/** `cq blockers` (the usage is at the top of queue.mjs). */
export function cmdBlockers() {
  // ---- Per code: count and blocked time in the period, top first (read-only) ----
  const raw = val('--days') ?? '7';
  const days = Number(raw);
  if (!(days > 0)) die('--days must be a number > 0');
  const summary = L.blockerSummary(read(), { days });
  if (a.includes('--json')) console.log(JSON.stringify({ days, blockers: summary }, null, 2));
  else for (const l of L.blockerLines(summary, { days })) console.log(l);
}

/** `cq next-migr` (the usage is at the top of queue.mjs). */
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

/** `cq migr` (the usage is at the top of queue.mjs). */
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
      const note = `The migration block has been moved to ${r.o.migr_block} (cq migr move). Use only the new block.`;
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

/** `cq deliver` (the usage is at the top of queue.mjs). */
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

/** `cq release` (the usage is at the top of queue.mjs). */
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

/** `cq deliveries` (the usage is at the top of queue.mjs). */
export function cmdDeliveries() {
  // ---- Adoption: report.md files that have not been received (read-only; pulse does the same and remembers what it reported) ----
  const found = findDeliveries(read());
  if (a.includes('--json')) console.log(JSON.stringify(found, null, 2));
  else if (!found.length)
    console.log('No deliveries waiting (no report.md newer than the start or the last receive).');
  else
    for (const l of found)
      console.log(
        `${l.id} (${l.taskStatus})  ${l.line}\n  ${l.path}  ${l.new ? 'NEW' : 'reported before'}  → ${CQ} receive ${l.id}`,
      );
}
