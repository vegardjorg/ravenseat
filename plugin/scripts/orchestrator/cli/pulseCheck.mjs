// =============================================================
// cli/pulseCheck.mjs: `ravenseat pulse-check`, the orchestrator's pulse in one read-only call.
//
//   ravenseat pulse-check [--session "<name>"] [--scratchpad <dir>] [--include-owner]
//
// Why: a repeated pulse (a scheduled or looped prompt, for example overnight) used to run `orchestrator pulse`, `state`
// and maybe `next` on every tick, each a turn with the whole context, also when nothing needed doing. This command
// gathers what needs the orchestrator into one answer:
//   SILENT                       (one line, exit 0): nothing to do; the session answers one line and stops.
//   ACTION: <n>                  (exit 13), then one line per item: what, and the exact next command.
// The items, each from the same check the other commands use (nothing is measured a second way here):
//   RECEIVE <id>   a track delivered (track-result.md with a RESULT line, not received yet; cli/tracks.mjs findDeliveries)
//   NO AGENT <id>  a track marked running (or a round prepared) that no agent took (findWithoutAgent, 15 min grace)
//   SILENT <id>    a running track with no sign of life for limits.silentMin minutes (findSilent; 0 = off)
//   START <n>      free slots and tasks that can start now (selectNext, after the start guards: budget, night pause,
//                  wind-down, load, usage limit; tasks waiting on an intake triage verdict count when its step is due)
//   RUN <id>       a wait-mode run (lib/waitMode.js) that finished while nobody waited for it
//   WIRING <id>    open wiring items on a task whose merge ran (done, or a merge state with the merge step done)
// And what only `orchestrator pulse` acts on, so a loop that runs only this command loses none of it:
//   CLOUD <id>     a cloud track that finished (collect auto or off), stopped, or has a tip this repo has not read
//                  (cloud.mjs cloudPulseItems: one ls-remote, no fetch, no cloud-check.json)
//   CONFLICTS      a predicted conflict the pulse has not reported (conflicts.mjs; the cache is left to the pulse)
//   AUTO-ACCEPT    proposals the owner's auto-accept rules would take (tried on a copy of the queue)
//   INSPECTION     recurring failures the pulse's hourly scan would propose (the pure scan, nothing saved)
// Those name `orchestrator pulse` (or the cloud command) as Next, which does the step and records it, so the next tick
// is silent. report_seen needs no item: RECEIVE lists every delivery not received, seen or not.
// What waits on the owner is never ACTION (at night nobody answers): with --include-owner a last line
// `FOR THE OWNER: <n> open question(s), <m> finished cloud track(s) to collect on your yes (...)` gives the counts for
// the morning. It does not change the exit code.
//
// Read-only apart from the orchestrator marker (the same update `orchestrator pulse` makes, so the session counts as
// active). It never starts, receives, merges, accepts, collects, deletes or marks anything, and writes no cache the
// pulse keeps. Runs in-process through ravenseat.mjs like every queue command.
// Exit codes: 0 SILENT, 13 ACTION, 2 usage error (nothing is written then).
//
// Used by: queue.mjs (dispatch). Tested in: __tests__/pulseCheckFlow.test.ts.
// =============================================================

import fs from 'node:fs';
import path from 'node:path';

import { cloudPulseItems } from './cloud.mjs';
import { conflictPulseItems } from './conflicts.mjs';
import { a, autoAcceptIn, CLI, FOLDER, L, pulseCursor, read, readCursor, require, uncommittedPaths } from './context.mjs';
import { inspectionDue } from './inspection.mjs';
import { dailyUsageFor, findDeliveries, findSilent, findWithoutAgent, measureLoad } from './tracks.mjs';
import { triageState } from './triage.mjs';

/** The exit code when something needs the orchestrator (0-7, 10-12 and 75 are taken; see the usage in queue.mjs). */
export const EXIT_ACTION = 13;
/** The exit code of a usage error. */
export const EXIT_USAGE = 2;

const USE = 'Use: ravenseat pulse-check [--session "<name>"] [--scratchpad <dir>] [--include-owner]';
const WITH_VALUE = ['--session', '--scratchpad'];
const FLAGS = ['--include-owner'];

/** The arguments after the command word, or the reason they are wrong. */
function parseArgs(args) {
  const out = { session: null, scratchpad: null, includeOwner: false };
  for (let i = 0; i < args.length; i += 1) {
    const x = args[i];
    if (WITH_VALUE.includes(x)) {
      const v = args[i + 1];
      if (v == null || v.startsWith('--')) return { error: `${x} needs a value` };
      out[x === '--session' ? 'session' : 'scratchpad'] = v;
      i += 1;
    } else if (FLAGS.includes(x)) out.includeOwner = true;
    else return { error: x.startsWith('-') ? `unknown flag ${x}` : `unexpected argument "${x}"` };
  }
  return out;
}

/** The scratchpad to name in the commands: --scratchpad, QUEUE_SCRATCHPAD, or a placeholder. */
function scratchText(given) {
  const s = given ?? process.env.QUEUE_SCRATCHPAD;
  return s ? path.resolve(s) : '<scratchpad>';
}

/** The delivered tracks (not received yet), as action lines. */
function deliveryItems(queue, scratch) {
  const now = Date.now();
  return findDeliveries(queue).map(
    (d) =>
      `RECEIVE ${d.id}: track-result.md ${d.status}, written ${L.ageText(now - d.mtimeMs)} ago. ` +
      `Next: ${CLI} receive ${d.id}${scratch === '<scratchpad>' ? '' : ` --scratchpad ${scratch}`}`,
  );
}

/** Tracks no agent took and silent tracks, with the next command each. */
function hungItems(queue, scratch) {
  const none = findWithoutAgent(queue).map((x) =>
    x.prepared
      ? `NO AGENT ${x.id}: round ${x.round} prepared ${L.ageText(x.age_ms)} ago, no agent started it. ` +
        `Next: ${CLI} resume ${x.id} --reason ${x.reason}, then start the agent line it prints`
      : `NO AGENT ${x.id}: marked running for ${L.ageText(x.age_ms)}, no agent started. ` +
        `Next: ${CLI} set ${x.id} waiting, then ${CLI} fill --ids ${x.id} --scratchpad ${scratch}`,
  );
  const limit = L.silentMinFor(queue);
  const silent = findSilent(queue).map(
    (x) =>
      `SILENT ${x.id}: no sign of life for ${L.ageText(x.silent_ms)} (limit ${limit} min). ` +
      `Next: ${CLI} explain ${x.id}, then ${CLI} resume ${x.id} --reason context (or ${CLI} set ${x.id} waiting)`,
  );
  return [...none, ...silent];
}

/** Free slots with tasks that can start, as at most one line. Nothing while a start guard stops new starts. */
function startItems(queue, scratch) {
  const load = measureLoad();
  const guard = L.startGuard(queue, dailyUsageFor(queue), { cursor: readCursor(), load });
  if (guard) return [];
  const uncommitted = uncommittedPaths();
  const triage = triageState(queue, { uncommitted });
  const now = Date.now();
  const startable = L.selectNext(queue, now, { uncommitted, load, skip: triage.skip }).map((v) => v.id);
  // A task waiting on a triage verdict: fill prints its step, unless the step was given recently (an agent may run).
  const slotted = new Set(L.selectNext(queue, now, { uncommitted, load }).map((v) => v.id));
  const triageDue = triage.list.filter((x) => !x.asked && slotted.has(x.id)).map((x) => x.id);
  if (!startable.length && !triageDue.length) return [];
  const parts = [];
  if (startable.length) parts.push(`${startable.length} task(s) can start (${startable.join(', ')})`);
  if (triageDue.length) parts.push(`${triageDue.length} need an intake triage first (${triageDue.join(', ')})`);
  return [`START ${parts.join(', ')}. Next: ${CLI} fill --scratchpad ${scratch}`];
}

/** Finished wait-mode runs whose output nobody has collected (lib/waitMode.js): the next command is `--wait <id>`. */
function runItems() {
  const W = require('./lib/waitMode.js');
  const folder = W.runsFolder(FOLDER);
  let names = [];
  try {
    names = fs.readdirSync(folder);
  } catch {
    return [];
  }
  const size = (p) => {
    try {
      return fs.statSync(p).size;
    } catch {
      return 0;
    }
  };
  const readJson = (p) => {
    try {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      return null;
    }
  };
  const out = [];
  for (const n of names.sort()) {
    const m = /^([a-z]+-[a-z0-9]+)\.json$/.exec(n);
    if (!m) continue;
    const id = m[1];
    const s = W.runState(folder, id);
    if (!s.done && !s.lost) continue; // still running (or not a run): nothing to do yet
    const shown = readJson(path.join(folder, `${id}.shown.json`));
    const unread =
      !shown ||
      Number(shown.out) < size(path.join(folder, `${id}.out`)) ||
      Number(shown.err) < size(path.join(folder, `${id}.err`));
    if (!unread) continue;
    const command = s.meta?.command ?? id.split('-')[0];
    const what = s.meta?.what ?? `${CLI} ${command}`;
    const how = s.lost ? 'ended without a result' : `finished (exit ${s.exit}${s.timedOut ? ', timed out' : ''})`;
    out.push(`RUN ${id} ${how}: ${what}. Next: ${CLI} ${command} --wait ${id}`);
  }
  return out;
}

/** Open wiring items on tasks whose merge ran: one line per task with the commands that close them. */
function wiringItems(queue) {
  const WI = require('./lib/wiringItems.js');
  const ML = require('./lib/mergeLock.js');
  const out = [];
  for (const o of queue.tasks ?? []) {
    if (o.status === 'cancelled') continue;
    const open = WI.openItems(o);
    if (!open.length) continue;
    const merged = o.status === 'done' || (ML.readState(FOLDER, o.id)?.steps_done ?? []).includes('merge');
    if (!merged) continue;
    const list = open.map((x) => `${x.id} ${x.file ?? '(no file)'}`).join(', ');
    const close = WI.closeCommands(o.id, open[0], CLI).join(' or ');
    out.push(
      `WIRING ${o.id}: ${open.length} open item(s) (${list}). Apply each on the base branch and commit it. ` +
        `Next: ${close}` +
        (o.status === 'done' ? '' : `, then ${CLI} merge ${o.id} --resume`),
    );
  }
  return out;
}

/** Proposals the pulse's auto-accept would take now, tried on a copy so nothing is accepted here. */
function autoAcceptItems(queue) {
  try {
    const took = autoAcceptIn(structuredClone(queue));
    return took.length
      ? [`AUTO-ACCEPT ${took.length} proposal(s) fit the owner's rules (${took.map((x) => x.id).join(', ')}). Next: ${CLI} orchestrator pulse`]
      : [];
  } catch {
    return [];
  }
}

/** Inspection proposals the pulse's next hourly scan would add. */
function inspectionItems() {
  const due = inspectionDue();
  return due.length
    ? [`INSPECTION ${due.length} recurring failure(s) due for a proposal (${due.map((e) => e.id).join(', ')}). Next: ${CLI} orchestrator pulse`]
    : [];
}

/**
 * What waits on the owner, as counts for the morning: open questions, and finished cloud tracks that are collected
 * only on the owner's yes (cloud.collect ask).
 */
function ownerLine(queue, cloudOwner) {
  const resolved = new Set(queue.resolved ?? []);
  const open = Object.keys(queue.question ?? {}).filter((id) => !resolved.has(id));
  const parts = [];
  if (open.length) parts.push(`${open.length} open question(s)`);
  if (cloudOwner.length) parts.push(`${cloudOwner.length} finished cloud track(s) to collect on your yes (${cloudOwner.join(', ')})`);
  return parts.length ? `FOR THE OWNER: ${parts.join(', ')}. Next (in the morning): ${CLI} decide` : null;
}

/** `ravenseat pulse-check` (the usage is at the top of queue.mjs and of this file). */
export function cmdPulseCheck() {
  const args = parseArgs(a.slice(1));
  if (args.error) {
    console.error(`ravenseat pulse-check: ${args.error}. ${USE}`);
    process.exit(EXIT_USAGE);
  }
  const queue = read();
  // The marker, as orchestrator pulse writes it (--session, otherwise QUEUE_SESSION, otherwise the previous name).
  pulseCursor('pulse-check');
  const scratch = scratchText(args.scratchpad);
  const cloud = cloudPulseItems(queue);
  const items = [
    ...deliveryItems(queue, scratch),
    ...hungItems(queue, scratch),
    ...cloud.action,
    ...runItems(),
    ...wiringItems(queue),
    ...conflictPulseItems(),
    ...autoAcceptItems(queue),
    ...inspectionItems(),
    ...startItems(queue, scratch),
  ];
  const lines = items.length ? [`ACTION: ${items.length}`, ...items] : ['SILENT'];
  if (args.includeOwner) {
    const owner = ownerLine(queue, cloud.owner);
    if (owner) lines.push(owner);
  }
  console.log(lines.join('\n'));
  // exitCode, not process.exit: output to a pipe is written in full before the process ends.
  process.exitCode = items.length ? EXIT_ACTION : 0;
}
