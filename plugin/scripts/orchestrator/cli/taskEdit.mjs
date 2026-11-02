// =============================================================
// cli/taskEdit.mjs: the commands that change tasks: set, cancel, edit, edit-many and undo.
//
// set moves a task to a status (with the measurement and the focus clean-up), cancel and edit change one task through
// editLogged (so undo can take it back), edit-many changes many at once (with --expect-changed), and undo reverts the
// last logged change.
//
// Why a module: queue.mjs was one file of about 6,300 lines. It is now a thin entry point (the usage comment and the
// dispatch on the command word) plus the modules in cli/. The code was moved as it was: same output, exit codes and files.
//
// Used by: queue.mjs (dispatch).
// Tested in: lib/__tests__/queueTaskEdit.test.ts, queueBulk.test.ts, queueAnswer.test.ts, queueFocus.test.ts, queuePlan.test.ts.
// =============================================================

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

import {
  a, autoCleanFocus, byName, checkExpect, die, edit, editLogged, focusCleanOut, FX, hasLock, L, lastEntry, LOCK, P,
  PREFIX, pulseCursor, read, readPlans, require, undoHint, val, values,
} from './context.mjs';
import { logTime, measurementLine, measureTask, minutes, saveMeasurement } from './tracks.mjs';

// The lock on the finish line (done_when and acceptance, lib/doneCheck.js doneLockError): edit and undo refuse a
// change after the start unless --by is owner or theBoard, and always from inside a track worktree.
const D = require('./lib/doneCheck.js');
let trackBranchCache;
/**
 * The track branch the cwd is on (`<branchPrefix><id>`), or null. A track agent runs cq from its worktree, so this is
 * what tells a track's edit apart from the owner's, whatever --by says. Asked only when a locked field is touched.
 */
function trackBranchHere() {
  if (trackBranchCache !== undefined) return trackBranchCache;
  let branch = '';
  try {
    branch = execFileSync('git', ['-C', process.cwd(), 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
  } catch {
    // Not a git tree: not a track worktree either.
  }
  trackBranchCache = branch.startsWith(PREFIX) && branch.length > PREFIX.length ? branch : null;
  return trackBranchCache;
}
/** doneLockError for this caller: --by and, only when a locked field is in `changes`, the cwd's track branch. */
const lockError = (o, changes) =>
  D.doneLockError(o, changes, {
    by: byName(),
    inTrack: D.LOCKED_FIELDS.some((f) => Object.hasOwn(changes, f)) ? trackBranchHere() : null,
  });

/** `cq set` (the usage is at the top of queue.mjs). */
export function cmdSet() {
  const [, id, status] = a;
  if (!id || !status) die('set <id> <status>');
  let qa = false;
  // The orchestrator cursor is updated when the queue's own tasks are moved; not for a picked task (whoever
  // picked it can set it done themselves) or a registration outside the queue.
  let orchestratorStep = false;
  // On `done` the cost is measured (the agents' usage from the transcripts) and the findings from the reviewers'
  // FINDINGS line (or --findings "FINDINGS H=... M=... L=...", repeatable), and the RESULT line is fetched when `receive` did not take it.
  // The reading happens before the lock; if it fails, the task is set done anyway (the measurement never stops the queue).
  let measurement = null;
  if (status === 'done' && !a.includes('--without-cost')) {
    try {
      const o = read().tasks.find((x) => x.id === id);
      if (o && !L.isExternalRow(o)) measurement = measureTask(o);
    } catch (e) {
      console.error(
        `WARNING: could not measure the cost for ${id} (${e?.message ?? e}); set done without it.`,
      );
    }
  }
  const r = edit((queue) => {
    const o = queue.tasks.find((x) => x.id === id);
    if (!o) die(`Unknown task ${id}`);
    orchestratorStep = !o.picked_by && !L.isExternalRow(o);
    const now = new Date().toISOString();
    // setStatus: delivered/done time, qa_status "waiting" for a visual task that becomes done, and the pick fields
    // are removed when a picked task is set back to waiting.
    const s = L.setStatus(o, status, now);
    if (s.error) die(s.error);
    qa = s.qa;
    if (val('--remark')) o.remarks = [...(o.remarks ?? []), `${now} ${val('--remark')}`];
    if (measurement) saveMeasurement(o, measurement);
    if (status === 'done' || status === 'cancelled') autoCleanFocus(queue, `set ${id} ${status}`);
    return o;
  });
  if (measurement) console.log(measurementLine(r));
  if (status === 'review' && r.started)
    logTime(id, 'delivered', `${minutes(r.started, r.delivered)} min to delivery`);
  if (status === 'done' && r.started) {
    logTime(
      id,
      'done',
      `${minutes(r.started, r.done)} min total${r.delivered ? `, ${minutes(r.delivered, r.done)} min review/merge` : ''}; ${val('--remark') ?? ''}`,
    );
  }
  console.log(
    `${id}: ${status}${qa ? ' · label visual: now in the owner QA list (cq qa)' : ''}`,
  );
  focusCleanOut();
  if (orchestratorStep) pulseCursor(`set ${id} ${status}`);
}

/** `cq cancel` (the usage is at the top of queue.mjs). */
export function cmdCancel() {
  // Cancel (or decline) one waiting or proposed task, logged so `undo` can put it back (lib/queueTaskEdit.js).
  const TE = require('./lib/queueTaskEdit.js');
  const [, id] = a;
  if (!id || id.startsWith('--')) die('cancel <id> [--remark "..."] [--by "..."] [--expect-changed <iso>] [--json]');
  const json = a.includes('--json');
  const remark = val('--remark') ?? null;
  editLogged('cancel', (queue) => {
    const o = queue.tasks.find((x) => x.id === id);
    const r = TE.cancelTask(o, { remark, now: new Date().toISOString() });
    if (r.error) {
      if (!json) die(`Not cancelled: ${o ? r.error : `unknown task ${id}`}`);
      console.log(JSON.stringify({ ok: false, error: [o ? r.error : `unknown task ${id}`] }));
      if (hasLock) fs.rmSync(LOCK, { recursive: true, force: true });
      process.exit(1);
    }
    autoCleanFocus(queue, `cancel ${id}`);
  });
  if (json) console.log(JSON.stringify({ ok: true, id, log: lastEntry?.nr ?? null }));
  else {
    console.log(`${id}: cancelled`);
    focusCleanOut();
    if (undoHint()) console.log(undoHint());
  }
}

/** `cq edit` (the usage is at the top of queue.mjs). */
export function cmdEdit() {
  const [, id] = a;
  const field = JSON.parse(val('--json') ?? '{}');
  // --accept "<criterion>" (repeatable) replaces the acceptance criteria (null in --json removes them).
  const accepts = values('--accept');
  if (accepts.length) field.acceptance = accepts;
  // --bonus "<text>" adds text to the mission (the track block) and the remarks, with a timestamp.
  const bonus = a.includes('--bonus') ? (val('--bonus') ?? '') : null;
  if (bonus != null && !String(bonus).trim())
    die('edit <id> --bonus "<text>": the addition is empty.');
  // The fields bonus and remarks are only kept by --bonus (and set --remark).
  delete field.bonus;
  // Status fields and the pick fields are only changed with their own commands (set, pick, deliver, release).
  for (const f of [
    'id',
    'status',
    'added_at',
    'started',
    'done',
    'branch',
    'migr_block',
    'picked_by',
    'picked_at',
    // A registration outside the queue never becomes a task, and vice versa.
    'external',
    'external_name',
    'done_outside_queue',
  ])
    delete field[f];
  editLogged('edit', (queue) => {
    const o = queue.tasks.find((x) => x.id === id);
    if (!o) die(`Unknown task ${id}`);
    // The finish line is fixed once the task has started (only the owner moves it, never a track).
    const locked = lockError(o, field);
    if (locked) die(`Not changed: ${locked}`);
    const fresh = { ...o, ...field };
    const f = L.validate(
      fresh,
      queue.tasks.filter((x) => x.id !== id),
      queue.projects,
    );
    // Batched (into or out of the batch queue) and depends_on against a task in the batch queue.
    f.push(
      ...L.batchedError(
        fresh,
        queue.tasks.map((x) => (x.id === id ? fresh : x)),
        queue.resolved,
      ),
    );
    // A new waiting_on id must be a registered question (queue.mjs question <id> --text ... first).
    f.push(...L.waitingOnError(fresh, queue, { earlier: o.waiting_on ?? [] }));
    // `fixes` must name tasks in the queue, never the task itself (lib/fixLinks.js; validate has checked the shape).
    if ('fixes' in field && !FX.fixesShapeError(fresh).length)
      f.push(...FX.fixesError(fresh, queue.tasks.map((x) => x.id)));
    if (f.length) die(`Invalid change: ${f.join('; ')}`);
    Object.assign(o, field);
    // Stored as a list; null or [] removes the link.
    if ('fixes' in field) {
      const list = FX.fixesList(field.fixes);
      if (list.length) o.fixes = list;
      else delete o.fixes;
    }
    // `batched: false` takes the task out of the batch queue; the field is removed so the queue file looks as before.
    if (o.batched === false) delete o.batched;
    // null removes the done command, the criteria and the task's own fix-round cap (the config cap applies again).
    for (const k of ['done_when', 'acceptance', 'max_fix_rounds']) if (k in field && field[k] == null) delete o[k];
    if (bonus != null) {
      const t = L.addToBonus(o, bonus, new Date().toISOString());
      if (t) die(`Invalid bonus: ${t}`);
    }
  });
  const changedField = [...Object.keys(field), ...(bonus != null ? ['bonus', 'remarks'] : [])];
  // --answer-json (the board): one JSON line with the changelog no., so "Undo" rolls back exactly this edit.
  if (a.includes('--answer-json'))
    console.log(JSON.stringify({ ok: true, id, changed: changedField, log: lastEntry?.nr ?? null }));
  else {
    console.log(`${id} changed: ${changedField.join(', ')}`);
    if (bonus != null)
      console.log(
        'The addition is in the track block from now on (cq trackFile / fill --ids). If the track is already running: send it with SendMessage.',
      );
    if (undoHint()) console.log(undoHint());
  }
}

/** `cq edit-many` (the usage is at the top of queue.mjs). */
export function cmdEditMany() {
  const file = val('--file');
  if (!file) die('edit-many --file <json>');
  const input = JSON.parse(fs.readFileSync(file, 'utf8'));
  const json = a.includes('--json');
  const now = new Date().toISOString();
  // With --json: the errors as JSON on stdout (the board shows them); the lock is released as in die().
  const errorOut = (s, code = 1) => {
    if (!json) die(`Nothing changed (${s.length} error(s)):\n  ${s.join('\n  ')}`, code);
    console.log(JSON.stringify({ ok: false, error: s }));
    if (hasLock) fs.rmSync(LOCK, { recursive: true, force: true });
    process.exit(code);
  };
  // `plan` must point to a plan entry that exists (null removes the link).
  const planErrorList = (reg) =>
    (Array.isArray(input) ? input : (input?.tasks ?? []))
      .filter((e) => e && typeof e === 'object' && e.plan != null)
      .map((e) => {
        const fe = P.planLinkError(reg, e.plan);
        return fe ? `${e.id ?? '?'}: ${fe}` : null;
      })
      .filter(Boolean);
  if (a.includes('--dry')) {
    // Preview. Computes everything on a copy and writes nothing; `changed` is the version the board sends
    // back as --expect-changed when the owner confirms.
    const queue = read();
    checkExpect(queue);
    const s = L.editMany(queue, input, { by: byName(), now, dry: true });
    if (s.error.length) errorOut(s.error);
    const pf = planErrorList(readPlans());
    if (pf.length) errorOut(pf);
    if (json)
      console.log(
        JSON.stringify({
          ok: true,
          dry: true,
          changed: queue.changed ?? null,
          changes: s.changes,
          warnings: s.warnings,
        }),
      );
    else {
      const ids = new Set(s.changes.filter((e) => e.id).map((e) => e.id));
      console.log(
        `Dry run (nothing written): ${s.changes.length} field(s) in ${ids.size} task(s)` +
          `${s.projects.length ? ` and ${s.projects.length} project(s)` : ''}; ` +
          `${s.changed.length - ids.size} of ${s.changed.length} task(s) are already like that. The queue's version: ${queue.changed ?? '(none)'}`,
      );
      for (const l of L.diffLines(s.changes)) console.log(`  ${l}`);
      for (const x of s.warnings) console.log(`WARNING: ${x}`);
    }
  } else {
    // All or nothing: editMany validates everything before anything changes, and die()/errorOut release the lock without writing the file.
    const r = editLogged('edit-many', (queue) => {
      const pf = planErrorList(readPlans());
      if (pf.length) errorOut(pf);
      const s = L.editMany(queue, input, { by: byName(), now });
      if (s.error.length) errorOut(s.error);
      // New or changed prefixes: the same warnings as queue.mjs project (one char, overlap).
      const pre = s.projects
        .filter((p) => input?.projects?.[p]?.prefixes)
        .flatMap((pid) => L.prefixWarnings(queue.projects, { pid }));
      return { ...s, warnings: [...s.warnings, ...new Set(pre)] };
    });
    if (json)
      console.log(
        JSON.stringify({
          ok: true,
          changed: r.changed,
          changes: r.changes,
          warnings: r.warnings,
          log: lastEntry?.nr ?? null,
        }),
      );
    else {
      console.log(
        `Changed ${r.changed.length} task(s)${r.projects.length ? ` and ${r.projects.length} project(s) in the register (${r.projects.join(', ')})` : ''}.`,
      );
      for (const x of r.warnings) console.log(`WARNING: ${x}`);
      if (undoHint()) console.log(undoHint());
    }
  }
}

/** `cq undo` (the usage is at the top of queue.mjs). */
export function cmdUndo() {
  // ---- Undo the last change ----
  // Rolls back the last changelog entry that is not undone, when the fields still have the values the entry set.
  const json = a.includes('--json');
  const entryText = (p) =>
    `no. ${p.nr} ${p.action} by ${p.by} ${p.at} (${p.changes.length} field(s))`;
  // --nr <n> = undo only when the last undoable entry is no. n (the board's "Undo" after a bulk action;
  // if someone else has written a logged change since, theirs is not undone instead).
  const nrError = (queue) => {
    if (val('--nr') == null) return null;
    const last = L.lastUndoable(queue);
    return last && String(last.nr) === String(val('--nr'))
      ? null
      : `the last change that can be undone is ${last ? `no. ${last.nr} (${last.action} by ${last.by})` : 'none'}, not no. ${val('--nr')}; nothing undone`;
  };
  if (a.includes('--show')) {
    const queue0 = read();
    const nf = nrError(queue0);
    const s = nf ? { error: [nf], entry: L.lastUndoable(queue0) } : L.undoEntry(queue0, { show: true, lockError });
    if (json)
      console.log(JSON.stringify({ ok: !s.error.length, error: s.error, entry: s.entry ?? null }));
    else if (!s.entry) console.log(s.error.join('\n'));
    else {
      console.log(`Last undoable: ${entryText(s.entry)}`);
      for (const l of L.diffLines(s.entry.changes)) console.log(`  ${l}`);
      console.log(
        s.error.length
          ? `Can NOT be undone now:\n  ${s.error.join('\n  ')}`
          : 'Can be undone (cq undo).',
      );
    }
  } else {
    const now = new Date().toISOString();
    const r = edit((queue) => {
      checkExpect(queue);
      const nf = nrError(queue);
      const s = nf ? { error: [nf], entry: null } : L.undoEntry(queue, { by: byName(), now, lockError });
      if (s.error.length) {
        if (json) {
          console.log(JSON.stringify({ ok: false, error: s.error, entry: s.entry ?? null }));
          if (hasLock) fs.rmSync(LOCK, { recursive: true, force: true });
          process.exit(1);
        }
        die(`Nothing undone${s.entry ? ` (${entryText(s.entry)})` : ''}:\n  ${s.error.join('\n  ')}`);
      }
      return s;
    });
    if (json) console.log(JSON.stringify({ ok: true, entry: r.entry }));
    else {
      console.log(`Undone ${entryText(r.entry)}:`);
      for (const l of L.diffLines(
        r.entry.changes.map((e) => ({ ...e, before: e.after, after: e.before })),
      ))
        console.log(`  ${l}`);
    }
  }
}
