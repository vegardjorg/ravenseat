// =============================================================
// cli/view.mjs: the read-only views of the queue: show (short and full), state, info, activeOnes and diagnose.
//
// show without a flag is the short view (active, startable, counts); show --full/--all/--grouped/--project is the
// table. state is the one-line status with exit code 3 for an empty queue, info one task, diagnose the problems.
//
// Why a module: queue.mjs was one file of about 6,300 lines. It is now a thin entry point (the usage comment and the
// dispatch on the command word) plus the modules in cli/. The code was moved as it was: same output, exit codes and files.
//
// Used by: queue.mjs (dispatch).
// Tested in: lib/__tests__/queueNoAgent.test.ts, queueSilent.test.ts, queueAnswer.test.ts, queueFocus.test.ts, queueBoard.test.ts,
//   cliHelp.test.ts.
// =============================================================

import fs from 'node:fs';
import path from 'node:path';

import {
  a, branchFor, branchInfo, CE, cut, D, die, FOLDER, FX, HERE, L, MAIN_TREE, positional, read, readCursor, require,
  uncommittedPaths, val, WIDTH,
} from './context.mjs';
import { costEstimateState, dailyUsageFor, findSilent, findWithoutAgent, measureLoad, nextCostUsd } from './tracks.mjs';
import { batchGroupLine } from './batch.mjs';
import { followLines } from './orchestrator.mjs';
import { findingsLineNow, findingsStateNow } from './finding.mjs';
import { baseHealthLine } from './baseHealth.mjs';

/** "picked by X 3 h ago · 2 commits · OLD" for a picked task. */
function pickLine(o) {
  const g = branchInfo(o.branch ?? branchFor(o.id));
  const age = o.picked_at ? L.ageText(Date.now() - Date.parse(o.picked_at)) : '?';
  const old = L.isOldPick(o, g)
    ? ' · OLD (over 72 h without commits; never released automatically)'
    : '';
  return `picked by ${o.picked_by ?? '?'} ${age} ago · ${g.commits} commit(s) on ${o.branch ?? branchFor(o.id)}${old}`;
}

/** One line when setup was last run for an older version (the board has it as a banner). Never stops the view. */
function setupBehindLine() {
  try {
    const U = require('./lib/queueUpdate.js');
    const src = require('./lib/queueBoard.js').setupSources(HERE, MAIN_TREE, (f) => fs.existsSync(f));
    const file = src.manifest ?? path.join(HERE, 'ravenseat-version.json');
    return U.setupBehindLine({
      mode: src.mode,
      installed: JSON.parse(fs.readFileSync(file, 'utf8')).version ?? null,
      setupVersion: U.readSetupRecord(fs, path.join(FOLDER, 'setup.json')),
    });
  } catch {
    return null;
  }
}

/** show prints tables for people. Silently ignoring --json gave a script text it could not parse (test round 5, Q10). */
function refuseJson() {
  if (a.includes('--json')) die('show has no --json. Use ravenseat state for JSON, or ravenseat info <id> --json for one task.');
}

/** `ravenseat show` without --full/--all/--grouped/--project: the short view (the usage is at the top of queue.mjs). */
export function cmdShowSummary() {
  // The short view by default (active ones, startable and counts, under about 3,000 chars); the full table was
  // about 66,000 chars (about 20,000 tokens per call). `--summary` is also accepted. The full one: `show --full`.
  refuseJson();
  const queue = read();
  // First, so it survives when the after-compact hook trims the show output.
  const withoutAgent = L.withoutAgentLines(findWithoutAgent(queue));
  if (withoutAgent.length) console.log(`${withoutAgent.join('\n')}\n`);
  // Silent tracks (an agent worktree, but no sign of life), right after.
  const silent = L.silentLines(findSilent(queue));
  if (silent.length) console.log(`${silent.join('\n')}\n`);
  const onCancelled = L.waitingOnCancelledLines(L.waitingOnCancelled(queue));
  if (onCancelled.length) console.log(`${onCancelled.join('\n')}\n`);
  // The base branch's health (lib/baseHealth.js): one line, also first, since a red base stops every merge.
  const baseLine = baseHealthLine();
  if (baseLine) console.log(baseLine);
  const setupLine = setupBehindLine();
  if (setupLine) console.log(setupLine);
  // The calibrated cost estimate (~$x) on the startable lines and the budget outlook (lib/costEstimate.js).
  const costModel = CE.costModel(queue);
  for (const l of L.summaryView(queue, {
    uncommitted: uncommittedPaths(),
    dailyUsage: dailyUsageFor(queue),
    width: WIDTH,
    cursor: readCursor(),
    load: measureLoad(),
    costEstimate: (o) => CE.calibratedCost(o, costModel),
    outlook: CE.budgetOutlook,
  }))
    console.log(l);
  // Loose waits (free text or an unregistered question, or an answer that still blocks).
  for (const l of L.resolveWaitsLines(L.resolveWaits(queue), { max: 5 })) console.log(l);
  // Follow up: the active entries and TO REPORT. The resume text after a compaction has this view, so due entries are
  // mentioned there too (hook-after-compact.mjs runs queue.mjs show).
  for (const l of followLines()) console.log(l);
  // Findings from the tracks (ravenseat finding) that nobody has triaged yet.
  const fl = findingsLineNow();
  if (fl) console.log(fl);
}

/** `ravenseat show` (the usage is at the top of queue.mjs). */
export function cmdShow() {
  refuseJson();
  const queue = read();
  const all = a.includes('--all');
  const register = queue.projects ?? {};
  const pid = val('--project');
  const inProject = (o) => !pid || L.projectFor(o, register) === pid;
  const uncommitted = uncommittedPaths();
  // Shared ranking (focusStep, then score); parked and the blockers "outside focus"/"parked" from the same source.
  const rk = L.rankingContext(queue);
  // A pending task without other blockers that owns an uncommitted file is skipped by `next`; say why.
  const blockersFor = (o) => {
    const h = L.blockersWithPause(o, queue, rk);
    const u = h.length ? null : L.uncommittedCollision(o, uncommitted);
    return u ? [`file ${u.path} is uncommitted in the main tree`] : h;
  };
  const withStep = rk.applies || queue.tasks.some((o) => L.parkedNow(o, rk.now));
  // The calibrated cost estimate (~$x) next to the minute estimate (lib/costEstimate.js); the order is unchanged.
  const costModel = CE.costModel(queue);
  const costCol = (o) => CE.costText(CE.calibratedCost(o, costModel));
  const rows = queue.tasks
    .filter((o) => o.status !== 'proposed' && !L.isExternalRow(o) && !L.inBatchQueue(o))
    .filter((o) => all || !['done', 'cancelled'].includes(o.status))
    .filter(inProject)
    .map((o) => {
      const r = o.status === 'waiting' ? L.ranking(o, queue, rk) : null;
      return { o, r, s: r ? r.score : null, h: o.status === 'waiting' ? blockersFor(o) : [] };
    })
    // As before: pending ones by priority at the top, then the rest (running, picked, review, done) in queue order. With focus
    // or parked, the pending ones are sorted by stage first (parked last among them).
    .sort(
      (x, y) =>
        (withStep ? (x.r?.stage ?? 3e6) - (y.r?.stage ?? 3e6) : 0) || (y.s ?? -1) - (x.s ?? -1),
    );
  const under = (text, indent) => {
    console.log(`${' '.repeat(indent)}↳ ${cut(text, WIDTH - indent - 2)}`);
  };
  // First, so it survives when the after-compact hook trims the show output.
  const withoutAgent = L.withoutAgentLines(findWithoutAgent(queue));
  if (withoutAgent.length) console.log(`${withoutAgent.join('\n')}\n`);
  const silent = L.silentLines(findSilent(queue));
  if (silent.length) console.log(`${silent.join('\n')}\n`);
  if (a.includes('--grouped')) {
    // Tree: project -> feature -> tasks, narrow enough for a narrow terminal window.
    for (const p of L.groups(
      rows.map((r) => r.o),
      register,
    )) {
      const header = `${p.pid}${p.title ? `  ${p.title}` : ''}${p.pause ? '  [PAUSE]' : ''}`;
      console.log(cut(header, WIDTH));
      for (const f of p.features) {
        console.log(`  ${cut(f.feature, WIDTH - 2)}`);
        for (const o of f.tasks) {
          const r = rows.find((x) => x.o === o);
          const col = `    ${o.id.padEnd(12)} ${o.status.padEnd(8)} ${o.class.padEnd(2)} ${`${L.estimate(o)}m`.padEnd(5)} ${costCol(o).padEnd(6)} `;
          console.log(col + cut(o.title, WIDTH - col.length));
          if (o.status === 'picked') under(pickLine(o), 6);
          else if (r.h.length) under(r.h.join(' · '), 6);
        }
      }
    }
  } else {
    for (const { o, s, h, r } of rows) {
      const col = [
        o.id.padEnd(12),
        o.status.padEnd(9),
        o.class.padEnd(3),
        o.domain.padEnd(14),
        `${L.estimate(o)} min`.padEnd(8),
        costCol(o).padEnd(6),
        s == null ? '        ' : String(s).padEnd(8),
        // The stage (T2 ..., rest) only when focus applies, so the table is otherwise as before.
        ...(rk.applies
          ? [(r ? (r.parked ? 'parked' : L.stepText(r).split(' ')[0]) : '').padEnd(7)]
          : []),
        o.title,
      ];
      console.log(col.join(' '));
      if (o.status === 'picked') console.log(`${' '.repeat(13)}↳ ${pickLine(o)}`);
      else if (h.length) console.log(`${' '.repeat(13)}↳ ${h.join(' · ')}`);
      if (r?.dragged_by) console.log(`${' '.repeat(13)}↳ dragged along by ${r.dragged_by} (in focus)`);
    }
  }
  // Proposals separately: they do not start until they are approved.
  const proposed = queue.tasks
    .filter((o) => o.status === 'proposed' && !L.inBatchQueue(o))
    .filter(inProject);
  if (proposed.length) {
    console.log(
      `\nSUGGESTION (${proposed.length}, not started until they are approved: ravenseat approve <id...>):`,
    );
    for (const o of proposed.sort((x, y) => Number(y.value ?? 5) - Number(x.value ?? 5))) {
      console.log(
        [
          o.id.padEnd(12),
          o.class.padEnd(3),
          o.domain.padEnd(14),
          `${L.estimate(o)} min`.padEnd(8),
          costCol(o).padEnd(6),
          `value ${o.value ?? 5}`.padEnd(9),
          `from ${o.added_by ?? '?'}`.padEnd(16),
          o.title,
        ].join(' '),
      );
    }
  }
  // The batch queue separately (not started alone; packed with queue.mjs batch pack).
  const batchGr = L.batchGroups(queue).filter((g) => !pid || g.pid === pid);
  if (batchGr.length) {
    const n = batchGr.reduce((s, g) => s + g.count, 0);
    const readyOnes = batchGr.filter((g) => g.ready).length;
    console.log(
      `\nBATCH_QUEUE (${n} task(s) in ${batchGr.length} group(s)${readyOnes ? `, ${readyOnes} ready for packing` : ''}; ` +
        'not started alone, see ravenseat batch):',
    );
    for (const g of batchGr) console.log(cut(`  ${batchGroupLine(g)}`, WIDTH));
  }
  // Work registered outside the queue (external add) separately; it owns files, but is not work in the queue.
  const registered = queue.tasks.filter((o) => L.isExternalRow(o) && o.status === 'external');
  if (registered.length) {
    console.log(
      `\nOUTSIDE QUEUE (${registered.length}, registered with external add; owns the files until ravenseat external done "<name>"):`,
    );
    for (const o of registered) {
      const age = o.added_at ? L.ageText(Date.now() - Date.parse(o.added_at)) : '?';
      const owner = [...(o.owned_files ?? []), ...(o.owner_db ?? [])].join(', ');
      console.log(
        cut(
          `${o.id.padEnd(24)} "${o.external_name}" ${age} ago · ${owner}${o.branch ? ` · branch ${o.branch}` : ''}`,
          WIDTH,
        ),
      );
    }
  }
  const usage = dailyUsageFor(queue);
  const t = L.state(queue, usage, { uncommitted, cursor: readCursor(), load: measureLoad() });
  console.log(`\n${L.stateLine(t)}`);
  // The base branch's health (lib/baseHealth.js), one line under the status line.
  const baseLine = baseHealthLine();
  if (baseLine) console.log(baseLine);
  if (t.focus)
    console.log(cut(`FOCUS${t.focus.name ? ` "${t.focus.name}"` : ''}: ${t.focus.text}`, WIDTH));
  if (t.focus?.notice) console.log(`NOTICE: ${t.focus.notice}`);
  const b = L.budgetGuard(queue, usage);
  if (b.active) console.log(b.message);
  // What would start now, estimated (calibrated) against what is left of the daily budget. Information only.
  if (b.active && !b.stop) console.log(CE.budgetOutlook(b, nextCostUsd(queue, uncommitted, costModel)).message);
  const n = L.nightGuard(queue);
  if (n.active) console.log(n.message);
  // Loose waits (free text or an unregistered question, or an answer that still blocks).
  for (const l of L.resolveWaitsLines(L.resolveWaits(queue), { max: 50 })) console.log(l);
  for (const l of followLines()) console.log(l);
}

/** `ravenseat state` (the usage is at the top of queue.mjs). */
export function cmdState() {
  const queue = read();
  const usage = dailyUsageFor(queue);
  const uncommitted = uncommittedPaths();
  const t = L.state(queue, usage, {
    uncommitted,
    cursor: readCursor(),
    load: measureLoad(),
  });
  // The calibrated cost estimates (always included): the model per class, what can start now with ~$ each (empty when
  // a guard stops new starts), and the daily budget outlook (null without a budget).
  t.costEstimate = costEstimateState(queue, t.canStart ? uncommitted : null, usage);
  // A separate list of loose waits (always included; empty list when everything is in order).
  t.resolveWaits = L.resolveWaits(queue);
  // Running tracks without an agent (always included; empty list when all is well).
  t.withoutAgent = findWithoutAgent(queue);
  // Silent tracks: an agent worktree, but no sign of life for limits.silentMin (always included; empty when all is well).
  t.silent = findSilent(queue);
  // The parallelism (active ones, max, share, threshold, low) always; the findings only when it is low.
  const par = D.parallelDiagnose(queue);
  t.parallel = { ...par, findings: par.low ? par.findings : [] };
  // Open fix tasks and the task(s) they fix (`fixes`, lib/fixLinks.js; always included, empty when there are none).
  t.fixLinks = FX.openFixLinks(queue.tasks);
  // Findings the tracks reported outside their scope (ravenseat finding): how many are not triaged yet, and their ids.
  t.findings = findingsStateNow();
  console.log(JSON.stringify(t, null, 2));
  if (t.empty) process.exit(3);
}

/** `ravenseat diagnose` (the usage is at the top of queue.mjs). */
export function cmdDiagnose() {
  // ---- The whole queue diagnosis, regardless of parallelism (read-only) ----
  const d = D.parallelDiagnose(read());
  if (a.includes('--json')) console.log(JSON.stringify(d, null, 2));
  else console.log(D.diagnoseFull(d).join('\n'));
}

/** `ravenseat info` (the usage is at the top of queue.mjs). */
export function cmdInfo() {
  // ---- Fixed lookups instead of `node -e` against queue.json ----
  const id = positional(1, ['--field'])[0];
  if (!id) die('info <id> [--field <name>] [--json]');
  const infoQueue = read();
  const o = infoQueue.tasks.find((x) => x.id === id);
  if (!o) die(`Unknown task ${id}`);
  const field = val('--field');
  if (field) {
    const v = L.infoField(o, field);
    if (v === undefined) die(`${id} does not have the field ${field}`);
    console.log(L.infoValueText(v));
  } else if (a.includes('--json')) console.log(JSON.stringify(o, null, 2));
  else
    for (const l of L.infoView(o, {
      fixedBy: FX.fixedBy(id, infoQueue.tasks),
      // The minute estimate and the calibrated cost estimate (lib/costEstimate.js); not for records outside the queue.
      costEstimate: L.isExternalRow(o) ? null : CE.calibratedCost(o, CE.costModel(infoQueue)),
    }))
      console.log(l);
}

/** `ravenseat activeOnes` (the usage is at the top of queue.mjs). */
export function cmdActiveOnes() {
  for (const l of L.activeLines(read())) console.log(l);
}
