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
// The map (SPLIT-1): this file is the entry point; the code lives in cli/merge/, one module per step of the flow.
//   receive: receiveIntake (merge/receive.mjs: the task, the stops, the delivery read)
//            -> receiveEvidence (merge/receiveChecks.mjs: the quick gates on the tip and the done command; red = a fix round)
//            -> receivePackage (merge/receive.mjs: the checks' lines, the review package, the reviewer prompts)
//            -> receiveRecord (merge/receiveRecord.mjs: the record on the task, the finding log, the closing lines)
//   merge:   mergeChecks (merge/mergeChecks.mjs: the lock, the status and resume cases, the stops before the merge)
//            -> mergeSteps (merge/mergeSteps.mjs: the plan, the merge state, the steps, executeMerge)
//            -> afterMerge (merge/afterMerge.mjs: the stop reports, the bookkeeping, the cleanup, the exit code)
//   shared:  merge/evidence.mjs (the git surface stop, the owner rows, the gate evidence, the done command),
//            merge/lock.mjs (the merge lock, the in-progress markers, the merge commit of a tip),
//            merge/receiveChecks.mjs (red on base, the secret scan, the scope and catalog notes, the control files).
//   others:  merge/blocks.mjs (block, unblock, blockers, next-migr, migr, deliver, release, deliveries).
// Each step returns what the next one reads, so nothing is shared at module level; null from a merge step ends the
// command where it ended before the split. The code was moved as it was: same output, exit codes and files.
//
// Why a module: queue.mjs was one file of about 6,300 lines. It is now a thin entry point (the usage comment and the
// dispatch on the command word) plus the modules in cli/. The code was moved as it was: same output, exit codes and files.
//
// Used by: queue.mjs (dispatch).
// Tested in: lib/__tests__/queueOrchestrator.test.ts, mergeGuard.test.ts, queueBlockers.test.ts, queueMigrBlock.test.ts,
//   queueExternal.test.ts, __tests__/queueAdopt.test.ts, __tests__/queueBaseGate.test.ts, __tests__/queueMergeResume.test.ts,
//   __tests__/queueDispatch.test.ts (the dispatch reaches the functions below). Each module in cli/merge/ names its own.
// =============================================================

import { receiveIntake, receivePackage } from './merge/receive.mjs';
import { receiveEvidence } from './merge/receiveChecks.mjs';
import { receiveRecord } from './merge/receiveRecord.mjs';
import { mergeChecks } from './merge/mergeChecks.mjs';
import { mergeSteps } from './merge/mergeSteps.mjs';
import { afterMerge } from './merge/afterMerge.mjs';
import * as BLOCKS from './merge/blocks.mjs';

// Exported from here before the split; kept so the import path stays.
export { controlFileLines, outsideCliLines } from './merge/receiveChecks.mjs';

/** `ravenseat receive` (the usage is at the top of queue.mjs). */
export function cmdReceive() {
  const intake = receiveIntake();
  const evidence = receiveEvidence(intake);
  const pkg = receivePackage({ ...intake, ...evidence });
  receiveRecord({ ...intake, ...evidence, ...pkg });
}

/** `ravenseat merge` (the usage is at the top of queue.mjs). */
export async function cmdMerge() {
  // ---- merge-track -> migrationPush (only with a migration flow, with the environment guard) -> gates --quick -> set done -> fill,
  // in one call. The steps, the stop rules and the environment check are in queueLogic (mergePlan, executeMerge, environmentCheck); here is only
  // the I/O. With --resume: the steps after the merge that have not run yet (the merge state, lib/mergeLock.js). ----
  const checked = await mergeChecks();
  if (!checked) return;
  const ran = await mergeSteps(checked);
  if (!ran) return;
  afterMerge(ran);
}

// The smaller commands (merge/blocks.mjs), named here so queue.mjs's dispatch finds them in this file.

/** `ravenseat block` (the usage is at the top of queue.mjs). */
export function cmdBlock() {
  BLOCKS.cmdBlock();
}

/** `ravenseat unblock` (the usage is at the top of queue.mjs). */
export function cmdUnblock() {
  BLOCKS.cmdUnblock();
}

/** `ravenseat blockers` (the usage is at the top of queue.mjs). */
export function cmdBlockers() {
  BLOCKS.cmdBlockers();
}

/** `ravenseat next-migr` (the usage is at the top of queue.mjs). */
export function cmdNextMigr() {
  BLOCKS.cmdNextMigr();
}

/** `ravenseat migr` (the usage is at the top of queue.mjs). */
export function cmdMigr() {
  BLOCKS.cmdMigr();
}

/** `ravenseat deliver` (the usage is at the top of queue.mjs). */
export function cmdDeliver() {
  BLOCKS.cmdDeliver();
}

/** `ravenseat release` (the usage is at the top of queue.mjs). */
export function cmdRelease() {
  BLOCKS.cmdRelease();
}

/** `ravenseat deliveries` (the usage is at the top of queue.mjs). */
export function cmdDeliveries() {
  BLOCKS.cmdDeliveries();
}
