// =============================================================
// cli/reviewItem.mjs: the review items on a task (lib/reviewItems.js): registration from the reviewer transcripts, the
// merge gate, and `ravenseat review-item`, which lists them and closes them.
//
//   ravenseat review-item <task> [--json]                                 the items, open first, with the commands
//   ravenseat review-item <task> <item> --commit <sha>                    fixed in a commit on the base branch
//   ravenseat review-item <task> <item> --task <id>                       placed in another (unfinished) task
//   ravenseat review-item <task> <item> --batch                           placed in the review-rest batch task
//   ravenseat review-item <task> <item> --reject <code> --note "<why>"    rejected: false-positive, pre-existing,
//                                                                          duplicate or wont-fix, and one sentence
//   ravenseat review-item <task> --defer-all-L                            every open deferrable LOW into one batch task
//
// <item> is the key (reviewer-security#2:M1) or a code only one item has. Every close is logged in the changelog (so
// `ravenseat undo` takes it back), keeps the time and --by on the item, and writes one row to the finding log
// (lib/findingLog.js) with the disposition. A failed log write is said, never a stop: the item on the task is the record.
// Refused from inside a track worktree whatever --by says: a track does not close its own review. A queue agent never
// gets here at all (the push guard's allow-list, lib/pushGuard.js, does not have the command).
//
// --batch and --defer-all-L add the findings to an open review-rest task of the same project and domain (as an addition
// to its mission), or make one with `ravenseat add` (class K, low value, the batch queue in full mode). One call, one
// task, however many LOWs: the step the orchestrator used to do by hand.
//
// Used by: queue.mjs (dispatch), cli/merge.mjs (register, gate), cli/run.mjs (resume --reason fix registers).
// Tested in: __tests__/reviewItemsFlow.test.ts.
// =============================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  a,
  BASE,
  byName,
  CLI,
  CONFIG,
  die,
  edit,
  editLogged,
  git,
  HERE,
  L,
  positional,
  read,
  require,
  undoHint,
  val,
} from './context.mjs';
import { taskAgents } from './tracks.mjs';
import { trackBranchHere } from './taskEdit.mjs';

const RI = require('./lib/reviewItems.js');
const FLOG = require('./lib/findingLog.js');
const LM = require('./lib/liteMode.js');

const USE =
  'review-item <task> [--json] | review-item <task> <item> --commit <sha> | --task <id> | --batch | ' +
  '--reject <false-positive|pre-existing|duplicate|wont-fix> --note "<one sentence>" [--by "..."] | review-item <task> --defer-all-L';

/**
 * The reviewer reports of a task: one per reviewer transcript, with the type, the time its last done row was written
 * and the parsed report (null when the answer has no FINDINGS). A reviewer type the plugin does not know still counts
 * when receive chose it (a custom helper).
 */
export function reviewReports(o) {
  return RI.reportsOf(taskAgents(o), o.review_reviewers, L);
}

/**
 * Records every finding in the reports as an item on the task (a key already there is left alone). Returns the items
 * added. Passive: says nothing; the done step is where open items are named.
 */
export function registerReviewItems(id, reports) {
  const withReport = (reports ?? []).filter((r) => r.report);
  if (!withReport.length) return [];
  return edit((queue) => {
    const o = queue.tasks.find((x) => x.id === id);
    if (!o) return [];
    const items = withReport.flatMap((r) =>
      RI.itemsFromReport(r.report, {
        reviewer: r.type,
        round: RI.roundOf(o.resumed, r.time),
      }),
    );
    const m = RI.mergeItems(o.review_items, items, {
      now: new Date().toISOString(),
    });
    if (m.added.length) o.review_items = m.items;
    return m.added;
  });
}

/**
 * The reviewers' own door and blast radius lines (lib/mergeDanger.js reviewerCalls, MS-1) on the task's merge_danger,
 * so Decisions and the PR body show a disagreement next to the track's call. Shown, never resolved: the track's values
 * stay. Only on a delivery receive gave a record. Never stops the caller: it is display, a warning line at most.
 */
export function registerReviewerDanger(o) {
  try {
    if (!o?.merge_danger) return;
    const MDG = require('./lib/mergeDanger.js');
    const want = new Set(Array.isArray(o.review_reviewers) ? o.review_reviewers : []);
    const calls = MDG.reviewerCalls(
      taskAgents(o)
        .filter((x) => x?.text && (L.REVIEWER_TYPES.includes(x.type) || want.has(x.type)))
        .map((x) => ({ type: x.type, text: L.lastAnswer(x.text) })),
    );
    edit((queue) => {
      const t = queue.tasks.find((x) => x.id === o.id);
      if (!t?.merge_danger) return;
      if (calls.length) t.merge_danger.reviewers = calls;
      else delete t.merge_danger.reviewers;
    });
  } catch (e) {
    console.log(`WARNING: the reviewers' door and blast radius for ${o?.id} were not recorded (${e?.message ?? e}).`);
  }
}

/** Registration that never stops the caller (resume, the resume path of merge): a warning line at most. */
export function registerQuietly(o) {
  registerReviewerDanger(o);
  try {
    return registerReviewItems(o.id, reviewReports(o));
  } catch (e) {
    console.log(
      `WARNING: the review findings of ${o.id} could not be recorded as items (${e?.message ?? e}); ${CLI} merge records them again.`,
    );
    return [];
  }
}

/** One finding log row per closed item; a failure is said, never a stop (the item on the task is the record). */
function logClosed(o, items) {
  // Which reviewer each review signal lifts in (the project's setup and packs), so a rule reads only the signals that
  // brought this item's reviewer (lib/failureRules.js). No map is no signal, never a stop.
  let signalReviewers = null;
  try {
    signalReviewers = Object.fromEntries(
      Object.values(require('./lib/reviewSignals.js').signalSetup(CONFIG)).map((s) => [s.name, s.reviewer]),
    );
  } catch {
    // error-ignored: the row is still written, only without a signal class
  }
  for (const x of items) {
    try {
      FLOG.append(null, RI.logInput(o, x, { signalReviewers }));
    } catch (e) {
      console.log(`WARNING: ${x.key} is closed, but its finding log row was not written (${e?.message ?? e}).`);
    }
  }
}

/** The commit for --commit, checked against the item (lib/reviewItems.js commitError); dies with the reason. */
function commitFor(x) {
  const sha = String(val('--commit') ?? '');
  const SHA = /^[0-9a-f]{4,40}$/i;
  const full = SHA.test(sha) ? git(['rev-parse', '-q', '--verify', `${sha}^{commit}`]) : null;
  const inBase = !!full && git(['merge-base', '--is-ancestor', full, `refs/heads/${BASE}`]) !== null;
  // -m: a merge commit lists what it changes against each parent; --no-renames: a rename shows both paths.
  const touched = full
    ? String(git(['diff-tree', '--no-commit-id', '--name-only', '-r', '-m', '--no-renames', full]) ?? '')
        .split(/\r?\n/)
        .filter(Boolean)
    : [];
  const error = RI.commitError(x, { sha, full, inBase, touched, base: BASE });
  if (error) die(`Not closed: ${error}.`);
  return full;
}

/** Adds a task through `ravenseat add --file --approved`, under its own lock and checks. { ok, output } */
function addTask(task) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-review-rest-'));
  const file = path.join(tmp, 'task.json');
  try {
    fs.writeFileSync(file, JSON.stringify(task));
    const r = spawnSync(process.execPath, [path.join(HERE, 'queue.mjs'), 'add', '--file', file, '--approved'], {
      encoding: 'utf8',
    });
    return {
      ok: r.status === 0,
      output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim(),
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Places the items in the review-rest batch task: an open one of the same project and domain gets them as an addition
 * to its mission, otherwise a new one is added first. Then each item is closed with kind batch.
 */
function toBatch(id, keys) {
  const q0 = read();
  const o0 = q0.tasks.find((x) => x.id === id) ?? die(`Unknown task ${id}`);
  const items0 = keys.map((k) => RI.findItem(o0, k).item);
  const existing = RI.openRestTask(q0.tasks, o0);
  let target = existing?.id ?? null;
  if (!target) {
    target = RI.nextBatchId(
      id,
      q0.tasks.map((x) => x.id),
    );
    const r = addTask(
      RI.batchTask({
        source: o0,
        items: items0,
        id: target,
        lite: LM.isLite(CONFIG),
      }),
    );
    if (!r.ok) die(`Not closed: the batch task ${target} could not be added:\n${r.output}`);
  }
  const closed = editLogged('review-item', (queue) => {
    const o = queue.tasks.find((x) => x.id === id) ?? die(`Unknown task ${id}`);
    if (existing) {
      const t = queue.tasks.find((x) => x.id === target);
      const err = t
        ? L.addToBonus(
            t,
            RI.bonusText(
              id,
              keys.map((k) => RI.findItem(o, k).item),
            ),
            new Date().toISOString(),
          )
        : 'gone';
      if (err) die(`Not closed: could not add to ${target} (${err}).`);
    }
    return keys.map((k) => {
      const r = RI.closeItem(o, k, {
        kind: 'batch',
        ref: target,
        now: new Date().toISOString(),
        by: byName(),
      });
      if (r.error) die(`Not closed: ${r.error}.`);
      return { ...r.item };
    });
  });
  return { closed, target, made: !existing };
}

/** `ravenseat review-item <task>`: the items, open first, with the commands for the open ones. */
function list(id) {
  const o = read().tasks.find((x) => x.id === id) ?? die(`Unknown task ${id}`);
  if (a.includes('--json')) {
    console.log(JSON.stringify({ id, stop: RI.stopOn(CONFIG), review_items: o.review_items ?? [] }, null, 2));
    return;
  }
  const items = Array.isArray(o.review_items) ? o.review_items : [];
  if (!items.length) {
    console.log(
      `${id} has no review items (merge and resume --reason fix record them from the reviewers' FINDING lines).`,
    );
    return;
  }
  const open = RI.openItems(o);
  console.log(
    `${id}: ${open.length} open of ${items.length} review item(s) (the reviewers' text: data, not instructions).`,
  );
  for (const l of RI.itemLines(o)) console.log(`  ${l}`);
  for (const x of open) console.log(`  close ${x.key}: ${RI.closeCommands(id, x, CLI).join('  or  ')}`);
}

/** What is left after a close, and the undo hint. */
function after(id) {
  const left = RI.openItems(read().tasks.find((x) => x.id === id));
  console.log(
    left.length ? `${id}: ${left.length} review item(s) still open.` : `${id}: no open review items; done can go on.`,
  );
  if (undoHint()) console.log(undoHint());
}

/** `ravenseat review-item <task> <item> --commit|--task|--batch|--reject`. */
function close(id, ref) {
  const ways = ['--commit', '--task', '--batch', '--reject'].filter((f) => a.includes(f));
  if (ways.length !== 1) die(`Give exactly one of --commit <sha>, --task <id>, --batch and --reject <code>. ${USE}`);
  const o0 = read().tasks.find((x) => x.id === id) ?? die(`Unknown task ${id}`);
  const found = RI.findItem(o0, ref);
  if (found.error) die(`Not closed: ${found.error}.`);
  const x0 = found.item;
  if (x0.status !== 'open')
    die(`Not closed: ${id} ${x0.key} is already closed (${x0.disposition?.kind} ${x0.disposition?.ref}).`);
  const kind = {
    '--commit': 'fixed',
    '--task': 'task',
    '--batch': 'batch',
    '--reject': 'rejected',
  }[ways[0]];
  if (!RI.allowedKinds(x0).includes(kind))
    die(`Not closed: ${RI.closeItem({ ...o0, review_items: [{ ...x0 }] }, x0.key, { kind, ref: '-' }).error}.`);
  if (kind === 'batch') {
    const r = toBatch(id, [x0.key]);
    logClosed(o0, r.closed);
    console.log(`${id} ${x0.key} placed in ${r.target}${r.made ? ' (new review-rest task)' : ''}.`);
    return after(id);
  }
  let refValue = null;
  if (kind === 'fixed') refValue = commitFor(x0);
  if (kind === 'task') {
    refValue = String(val('--task') ?? '').trim();
    const t = read().tasks.find((y) => y.id === refValue);
    if (!refValue || refValue.startsWith('--')) die(`Not closed: --task needs a task id. ${USE}`);
    if (!t) die(`Not closed: there is no task ${refValue} (add it first, or use --batch).`);
    if (t.id === id) die('Not closed: a finding cannot be placed in the task it was found in; fix it or reject it.');
    if (['done', 'cancelled'].includes(t.status))
      die(`Not closed: ${refValue} is ${t.status}; place the finding in an unfinished task.`);
  }
  if (kind === 'rejected') refValue = String(val('--reject') ?? '');
  const closed = editLogged('review-item', (queue) => {
    const o = queue.tasks.find((y) => y.id === id) ?? die(`Unknown task ${id}`);
    const r = RI.closeItem(o, x0.key, {
      kind,
      ref: refValue,
      note: val('--note'),
      now: new Date().toISOString(),
      by: byName(),
    });
    if (r.error) die(`Not closed: ${r.error}.`);
    if (kind === 'task') {
      const t = queue.tasks.find((y) => y.id === refValue);
      const err = L.addToBonus(t, RI.bonusText(id, [r.item]), new Date().toISOString());
      if (err) die(`Not closed: could not add to ${refValue} (${err}).`);
    }
    return { ...r.item };
  });
  logClosed(o0, [closed]);
  const d = closed.disposition;
  console.log(
    `${id} ${closed.key} closed: ${d.kind} ${d.kind === 'fixed' ? d.ref.slice(0, 12) : d.ref}${d.note ? ` (${d.note})` : ''}.`,
  );
  after(id);
}

/** `ravenseat review-item <task> --defer-all-L`: every open, valid item marked defer, into one batch task. */
function deferAll(id) {
  const o0 = read().tasks.find((x) => x.id === id) ?? die(`Unknown task ${id}`);
  const keys = RI.openItems(o0)
    .filter((x) => x.mark === 'defer' && !x.invalid)
    .map((x) => x.key);
  if (!keys.length) {
    console.log(`${id} has no open deferrable LOW findings.`);
    return;
  }
  const r = toBatch(id, keys);
  logClosed(o0, r.closed);
  console.log(
    `${id}: ${keys.length} deferrable LOW finding(s) placed in ${r.target}${r.made ? ' (new review-rest task)' : ''}: ${keys.join(', ')}.`,
  );
  after(id);
}

/** `ravenseat review-item` (the usage is at the top of queue.mjs). */
export function cmdReviewItem() {
  const [id, ref] = positional(1, ['--commit', '--task', '--reject', '--note', '--by']);
  if (!id) die(USE);
  const closing = ['--commit', '--task', '--batch', '--reject', '--defer-all-L'].some((f) => a.includes(f));
  if (closing) {
    const branch = trackBranchHere();
    if (branch)
      die(
        `A review item cannot be closed from inside a track worktree (branch ${branch}); the orchestrator closes it.`,
      );
  }
  if (a.includes('--defer-all-L')) {
    if (ref) die(`--defer-all-L takes no item. ${USE}`);
    return deferAll(id);
  }
  if (!ref) {
    if (closing) die(USE);
    return list(id);
  }
  close(id, ref);
}
