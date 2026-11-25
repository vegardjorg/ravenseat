// =============================================================
// cli/merge/evidence.mjs: the checks receive and merge share: the stop on a changed git surface (stopOnDrift), whose gate evidence and owner
// rows count (GE_MODE, stopOnOwnerRows, trackWordGates), the done command (runDoneCommand, doneCommandRed) and the quick
// gates bound to the delivered tip (receiveGates, with brokenGate, withZeroTests and withFlaky).
//
// Why a module: cli/merge.mjs was about 2,700 lines; it is now the entry point and a map of the receive and merge flow,
// and this is the evidence part both flows read. Moved as it was (SPLIT-1): same output, exit codes and files.
//
// Used by: cli/merge/receive.mjs, cli/merge/receiveChecks.mjs, cli/merge/mergeChecks.mjs, cli/merge/mergeSteps.mjs.
// Tested in: __tests__/queueGateEvidence.test.ts, __tests__/gateEvidenceFlow.test.ts, __tests__/queueDoneCheck.test.ts,
//   __tests__/queueGateBroken.test.ts, __tests__/trackFlakyGate.test.ts, __tests__/zeroTestsGate.test.ts,
//   __tests__/gitSurfaceBaseline.test.ts, __tests__/gateCoverageTamper.test.ts.
// =============================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { CLI, CONFIG, die, FOLDER, git, GIT_ROOT, HERE, L, read, require, saveOwnerLog, val } from '../context.mjs';
import { BASE_SETUP, fileFlaky } from '../baseHealth.mjs';

const GB = require('./lib/gitSurfaceBaseline.js');
const CONTROLS = require('./lib/controls.js');
// What receive and merge catch, as rows in the finding log (passive: at most a warning when a write fails).
const FSRC = require('./lib/findingSources.js');

// ---- The git hooks and config against the accepted baseline (lib/gitSurfaceBaseline.js) -------------------------------

/**
 * The stop at the top of receive and merge, before any git command that could run a hook: records the baseline on first
 * use, and on a difference stops (exit 1, nothing changed: no status, no blocker, no fix round). It is sticky until the
 * owner removes the difference or accepts it, or sets config gitSurface to warn or off (GB.stopDetail).
 */
export function stopOnDrift(again, extra = () => []) {
  // A baseline written just now is the state just read: there is nothing to compare, so it is not read a second time.
  if (GB.ensure(FOLDER, GIT_ROOT)) return;
  const detail = GB.stopDetail(FOLDER, GIT_ROOT, { ravenseat: CLI });
  if (detail) die([GB.driftMessage({ ...detail, ravenseat: CLI, again }), ...extra()].join('\n'));
}

// ---- Whose gate evidence and owner rows count (gateEvidence.mode, owner decision B2) ------------------------------------

/** own (the default), external or off (lib/gateEvidence.js modeOf). */
export const GE_MODE = require('./lib/gateEvidence.js').modeOf(CONFIG);

/**
 * The owner rows task `id` relies on (owner answers, edits, approvals in queue.json), confirmed against the owner log
 * (lib/ownerLog.js): a row no ravenseat write recorded stops receive and merge (exit 1, nothing changed) until the owner
 * accepts it or takes it out. The first use records the rows there are as the baseline. Mode off does not check.
 */
export function stopOnOwnerRows(id, again) {
  if (GE_MODE === 'off') return;
  const OL = require('./lib/ownerLog.js');
  // The first use's baseline goes through the store (saveOwnerLog), never past an open store journal (fix round jrn-r2).
  const r = OL.check(FOLDER, read(), id, { save: saveOwnerLog });
  if (r.baseline) console.log(`Owner log started (${OL.logFile(FOLDER)}): the owner rows in the queue now are its baseline.`);
  if (r.missing.length) die(OL.stopMessage({ id, missing: r.missing, ravenseat: CLI, again, file: OL.logFile(FOLDER) }));
}

/**
 * gateEvidence.mode off: the track's gates=OK taken at its word on the delivered tip. Nothing runs; the record says
 * where it came from (`source: "track"`, `ran: false`). `{ status: 'off' }` when there are no quick gates, as in own.
 */
export function trackWordGates(branch) {
  if (!CONTROLS.commandsOf(CONFIG.gates?.quick).length) return { status: 'off' };
  const tip = git(['rev-parse', '--verify', `refs/heads/${branch}`]);
  console.log(
    `Gates not run at ${String(tip).slice(0, 12)}: gateEvidence.mode off, so the track's RESULT gates=OK is taken as given ` +
      '(nothing checked it; the merge step still runs the quick gates on the merge commit).',
  );
  return { status: 'green', record: { ok: true, kind: 'quick', tip, at: new Date().toISOString(), ran: false, source: 'track' } };
}


/**
 * The reason a red gates.mjs run was tampered, or null: the entry it recorded for this task after `since` (also one for
 * another sha: a gate that moved HEAD), or, with no such entry, a surface that now differs from the baseline.
 */
export function gatesTamperReason({ id, since }) {
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
export function runDoneCommand(o, { branch, scratch, step }) {
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
  // processGuard (lib/processGuard.js): the run registers itself, carries the track tag and runs at a lower priority.
  const run = DC.runDoneWhen({ command, cwd, ...setup, spawn, processGuard: { cfg: CONFIG, folder: FOLDER, kind: 'done', track: o.id } });
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
export function doneCommandRed(id, check, { scratch, what = 'done command' }) {
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
export function receiveGates(o, { branch, scratch, reuse = true, step = 'receive' }) {
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
export function brokenGate(o, gateCheck) {
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
    const timeoutMs = GBR.BASE_CHECK_SEC * 1000;
    // The process guard's meta (lib/processGuard.js): register and lower priority; a run in the main checkout has no track.
    const meta = require('./lib/processGuard.js').metaFor(CONFIG, { folder: FOLDER, kind: 'base', maxMs: timeoutMs, command: c.command });
    const r = TR.runBounded(c.command, { cwd: GIT_ROOT, timeoutMs, spawn, meta });
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
