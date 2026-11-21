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
  a, autoCleanFocus, branchFor, branchInfo, byName, checkExpect, die, edit, editLogged, focusCleanOut, FX, hasLock, L, lastEntry, LOCK, P,
  missionMovedJson, missionMovedLine, moveLongMission, PREFIX, pulseCursor, read, readCursor, readPlans, require, undoHint, val, values, CONFIG, CLI, G, git,
} from './context.mjs';
import { logTime, measurementLine, measureTask, minutes, saveMeasurement, turnWarningLines } from './tracks.mjs';
import { linkProblems, linkProblemsJson, printLinkWarning } from './taskLinksCheck.mjs';
import { keepAsNotBuilding, keepRefused, remarkReason } from './notBuilding.mjs';
import { issueArg } from './issues.mjs';
import { readDoc } from './planShared.mjs';

// The lock on the finish line and the ownership (done_when, acceptance, owned_files, shared_patch, owner_db, migr_block;
// lib/doneCheck.js LOCKED_FIELDS and doneLockError): edit and undo refuse a change after the start unless --by is owner
// or theBoard, and always from inside a track worktree.
const D = require('./lib/doneCheck.js');
// The wiring spec's open items stop `set <id> done` (lib/wiringItems.js; wiring.stop false turns it off).
const WI = require('./lib/wiringItems.js');
// The reviewers' findings stop it the same way (lib/reviewItems.js; reviewItems.stop false or lite mode turns it off).
const RI = require('./lib/reviewItems.js');
// A new `fixes` link is a defect after merge: a row in the finding log (lib/findingSources.js).
const FSRC = require('./lib/findingSources.js');
// The task's short human summary (`description`): its stored form and the soft-limit WARNING (lib/taskDescription.js).
const DESC = require('./lib/taskDescription.js');
let trackBranchCache;
/**
 * The track branch the cwd is on (`<branchPrefix><id>`), or null. A track agent runs ravenseat from its worktree, so this is
 * what tells a track's edit apart from the owner's, whatever --by says. Asked only when a locked field is touched.
 */
export function trackBranchHere() {
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

/**
 * The success question for the plan of task `id` (PG-6), or null: plans.postCheck off, no plan, no decision section
 * with a success measure, or anything unreadable. Read-only; fail open, since it must never stop a done.
 * @returns {null | { entry: object, id: string, question: object }}
 */
function postCheckFor(id) {
  try {
    const PC = require('./lib/planPostCheck.js');
    if (!PC.postCheckSetup(CONFIG).on) return null;
    const o = read().tasks.find((x) => x.id === id);
    if (!o?.plan) return null;
    const reg = readPlans();
    // A task may point at an entry that was merged into another: the surviving entry owns it.
    const entry = (reg.entries ?? []).find((p) => p.id === o.plan || (p.merged_from ?? []).includes(o.plan));
    if (!entry) return null;
    const q = PC.postCheckQuestion(entry, PC.decisionMeasure(entry, readDoc));
    return q ? { entry, ...q } : null;
  } catch {
    return null; // error-ignored: the follow-up only asks; the done goes through without it
  }
}

/** `ravenseat set` (the usage is at the top of queue.mjs). */
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
  // PG-6 (lib/planPostCheck.js): the plan's success question, read before the lock (the register and the decision
  // section); registered under the lock below once this done makes the plan built.
  const postCheck = status === 'done' ? postCheckFor(id) : null;
  let postCheckAdded = null;
  // Done by hand without proof (red team, plans/redteam-plan.md finding 9): allowed, since a picked or outside task is done
  // that way, but said out loud, with the tasks it frees. Never a stop.
  let unproven = null;
  // The line when wiring.stop is off and the task goes done with open wiring items.
  let wiringOff = null;
  // The same when reviewItems.stop is off (or lite mode) and the task goes done with open review items.
  let reviewOff = null;
  const r = edit((queue) => {
    const o = queue.tasks.find((x) => x.id === id);
    if (!o) die(`Unknown task ${id}`);
    orchestratorStep = !o.picked_by && !L.isExternalRow(o);
    // The wiring spec (lib/wiringItems.js): done waits until each item is closed by a commit or rejected with a reason.
    if (status === 'done' && o.status !== 'done') {
      if (WI.stopOn(CONFIG)) {
        const refusal = WI.refusalLines(o, { cli: CLI, base: CONFIG.baseBranch });
        if (refusal) die(refusal.join('\n'));
      } else wiringOff = WI.offLine(o, CLI);
      if (RI.stopOn(CONFIG)) {
        const refusal = RI.refusalLines(o, { cli: CLI });
        if (refusal) die(refusal.join('\n'));
      } else reviewOff = RI.offLine(o, CLI);
    }
    if (status === 'done' && o.status !== 'done' && !L.isExternalRow(o)) {
      const freed = queue.tasks
        .filter((x) => (x.depends_on ?? []).includes(id) && !['done', 'cancelled'].includes(x.status))
        .map((x) => x.id);
      unproven = { started: !!o.started || !!o.picked_by, branch: o.branch ?? branchFor(id), freed };
    }
    const now = new Date().toISOString();
    // setStatus: delivered/done time, qa_status "waiting" for a visual task that becomes done, and the pick fields
    // are removed when a picked task is set back to waiting.
    const s = L.setStatus(o, status, now);
    if (s.error) die(s.error);
    qa = s.qa;
    if (val('--remark')) o.remarks = [...(o.remarks ?? []), `${now} ${val('--remark')}`];
    if (measurement) saveMeasurement(o, measurement);
    if (status === 'done' || status === 'cancelled') autoCleanFocus(queue, `set ${id} ${status}`);
    if (postCheck && require('./lib/planPostCheck.js').due(queue, postCheck.entry)) {
      const s = L.setQuestion(queue, { [postCheck.id]: postCheck.question }, now);
      // A question the queue refuses is left out: the follow-up never stops a done.
      if (!s.error?.length) postCheckAdded = postCheck;
    }
    return o;
  });
  if (measurement) {
    console.log(measurementLine(r));
    // Output or thinking per turn over 2x the agent type's 14-day median (lib/costMeasures.js): said, never a stop.
    for (const l of turnWarningLines(r)) console.log(l);
  }
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
    `${id}: ${status}${qa ? ' · label visual: now in the owner QA list (ravenseat qa)' : ''}`,
  );
  if (postCheckAdded)
    console.log(
      `${postCheckAdded.entry.id} is built: owner question ${postCheckAdded.id} asks whether its success measure was met ` +
        `(no task waits on it; ${CLI} plan postcheck shows the estimate record; plans.postCheck).`,
    );
  if (wiringOff) console.error(wiringOff);
  if (reviewOff) console.error(reviewOff);
  if (unproven) {
    const info = branchInfo(unproven.branch);
    const why = info.exists && info.commits
      ? `branch ${unproven.branch} has ${info.commits} commit(s) that are not in ${CONFIG.baseBranch}: nothing of it was merged`
      : !unproven.started
        ? 'the queue never started it and no branch holds work for it'
        : null;
    if (why) {
      const freed = unproven.freed.length ? ` ${unproven.freed.join(', ')} wait(s) on it and can start now.` : '';
      console.error(
        `WARNING: ${id} is set done by hand, but ${why}.${freed} ` +
          `If the work is not really done: ${CLI} set ${id} ${info.exists && info.commits ? 'review, then ' + CLI + ' merge ' + id : 'waiting'}.`,
      );
    }
  }
  if (status === 'cancelled') {
    // Nothing is deleted on its own, since the work may be wanted. Said here, so it does not stay unnoticed.
    const branch = r.branch ?? branchFor(id);
    const info = branchInfo(branch);
    if (info.exists) {
      const worktrees = G.readWorktrees(git);
      const holders = G.worktreesOfBranch(worktrees, (x, y) => git(['merge-base', '--is-ancestor', x, y]) != null, branch, CONFIG.baseBranch);
      const holder = holders.length ? holders.map((w) => w.path).join(', ') : null;
      console.log(
        `Left behind: branch ${branch}${info.commits ? ` with ${info.commits} commit(s) that are not merged` : ''}${holder ? `, worktree ${holder}` : ''}. ` +
          `To drop it: ${holder ? `${CLI} cleanup-worktree ${branch} --abandon --execute (the branch stays), then ` : ''}git branch -D ${branch}${info.commits ? ' (the commits go with it)' : ''}.`,
      );
    }
  }
  focusCleanOut();
  // Only a live cursor: an expired one belongs to a session long gone, and this would make it look alive under its name.
  if (orchestratorStep && L.orchestratorStatus(readCursor()).active) pulseCursor(`set ${id} ${status}`);
}

/** `ravenseat cancel` (the usage is at the top of queue.mjs). */
export function cmdCancel() {
  // Cancel (or decline) one waiting or proposed task, logged so `undo` can put it back (lib/queueTaskEdit.js).
  const TE = require('./lib/queueTaskEdit.js');
  const [, id] = a;
  if (!id || id.startsWith('--')) die('cancel <id> [--remark "..."] [--keep] [--by "..."] [--expect-changed <iso>] [--json]');
  const json = a.includes('--json');
  const remark = val('--remark') ?? null;
  // --keep (roadmap 0f): the no also becomes a proposed "Not building" entry in the catalog, the remark's reason as its
  // text. Refused before anything is cancelled when catalog.captureAnswers is off or from a track worktree.
  const keep = a.includes('--keep');
  if (keep) keepRefused('cancel');
  let title = null;
  editLogged('cancel', (queue) => {
    const o = queue.tasks.find((x) => x.id === id);
    const r = TE.cancelTask(o, { remark, now: new Date().toISOString() });
    if (r.error) {
      if (!json) die(`Not cancelled: ${o ? r.error : `unknown task ${id}`}`);
      console.log(JSON.stringify({ ok: false, error: [o ? r.error : `unknown task ${id}`] }));
      if (hasLock) fs.rmSync(LOCK, { recursive: true, force: true });
      process.exit(1);
    }
    title = o.title ?? id;
    autoCleanFocus(queue, `cancel ${id}`);
  });
  const declined = /^\s*declined\b/i.test(String(remark ?? ''));
  const kept = keep
    ? keepAsNotBuilding({ title, why: remarkReason(remark), source: `${declined ? 'declined proposal' : 'cancelled task'} ${id}` })
    : null;
  if (json) console.log(JSON.stringify({ ok: true, id, log: lastEntry?.nr ?? null, ...(kept ? { keep: kept } : {}) }));
  else {
    console.log(`${id}: cancelled`);
    if (kept) console.log(kept.line);
    focusCleanOut();
    if (undoHint()) console.log(undoHint());
  }
}

/** `ravenseat edit` (the usage is at the top of queue.mjs). */
export function cmdEdit() {
  const [, id] = a;
  const field = JSON.parse(val('--json') ?? '{}');
  // --accept "<criterion>" (repeatable) replaces the acceptance criteria (null in --json removes them).
  const accepts = values('--accept');
  if (accepts.length) field.acceptance = accepts;
  // --files a,b replaces the files the task owns (--files "" empties the list). Locked after the start like --json.
  if (a.includes('--files'))
    field.owned_files = String(val('--files') ?? '').split(',').map((s) => s.trim().replace(/\\/g, '/')).filter(Boolean);
  // --description "<text>" sets or replaces the short human summary; --description "" removes it (as null or "" in
  // --json does). Stored trimmed (lib/taskDescription.js); a value that is not text is refused by validate below.
  if (a.includes('--description')) field.description = val('--description') ?? '';
  if (Object.hasOwn(field, 'description')) {
    const d = DESC.descriptionValue(field.description);
    if (!d.error) field.description = d.value;
  }
  // --issue 12 | owner/name#12 | none links the task to a GitHub issue (GH-2, lib/issueLink.js); the repo of a bare
  // number is the origin remote's. none (or "") removes the link.
  if (a.includes('--issue')) field.issue = issueArg();
  // --risk-first "<assumption>" sets the riskiest assumption (lib/riskFirst.js, DR-2); --risk-first "" removes it.
  // Locked after the start like --accept (lib/doneCheck.js LOCKED_FIELDS): only --by owner changes it then.
  if (a.includes('--risk-first')) field.risk_first = String(val('--risk-first') ?? '').trim() || null;
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
    // The attempts are the queue's own record of what ran (lib/logic/attempt.js); only ravenseat attempt close changes one by hand.
    'attempts',
    // The plan review (lib/planReview.js) is only recorded by triage --plan.
    'plan_review',
  ])
    delete field[f];
  // An edit with nothing to write (a mistyped flag, or only fields with their own commands) must not look like it worked.
  const unknownFlags = a.filter(
    (x) => x.startsWith('--') && !['--json', '--files', '--accept', '--bonus', '--description', '--issue', '--risk-first', '--by'].includes(x),
  );
  if (!Object.keys(field).length && bonus == null && !read().tasks.some((x) => x.id === id)) die(`Unknown task ${id}`);
  if (!Object.keys(field).length && bonus == null)
    die(`Nothing changed: ${unknownFlags.length ? `edit does not know ${unknownFlags.join(', ')}. ` : ''}edit ${id} needs --json '{...}', --files a,b, --accept "<criterion>", --description "<text>" or --bonus "<text>". Status: ${CLI} set ${id} <status>.`);
  // The ids a `fixes` edit adds (not the ones already there): each is a new defect after merge for the finding log.
  let newFixes = [];
  // The mission this edit moved out of queue.json (moveLongMission), for the NOTE line and --answer-json.
  const missionMoved = [];
  editLogged('edit', (queue) => {
    const o = queue.tasks.find((x) => x.id === id);
    if (!o) die(`Unknown task ${id}`);
    const fixesBefore = FX.fixesList(o.fixes) ?? [];
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
    // No task owns a hotspot (lib/hotspots.js). Checked only when the edit touches the ownership, so a task from before
    // the hotspot was listed never blocks an unrelated edit.
    if ('owned_files' in field || 'hotspot_patch' in field) {
      const H = require('./lib/hotspots.js');
      f.push(...H.ownershipErrors(fresh, H.hotspotsOf(CONFIG)));
    }
    // A depends_on that closes a cycle leaves every task in it waiting forever. Checked only when the edit touches
    // depends_on or status, so a cycle made before this check existed never blocks an unrelated edit (doctor reports it).
    if ('depends_on' in field || 'status' in field)
      f.push(...L.cycleError(fresh, queue.tasks.map((x) => (x.id === id ? fresh : x))));
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
      newFixes = list.filter((x) => !fixesBefore.includes(x));
    }
    // `batched: false` takes the task out of the batch queue; the field is removed so the queue file looks as before.
    if (o.batched === false) delete o.batched;
    // null removes the done command, the criteria and the task's own fix-round cap (the config cap applies again).
    // And null (--risk-first "") removes the riskiest assumption.
    for (const k of ['done_when', 'acceptance', 'max_fix_rounds', 'risk_first']) if (k in field && field[k] == null) delete o[k];
    // `sources` is replaced as a whole; null or [] removes it (the task then reads its plan entry's sources again).
    if ('sources' in field && !(Array.isArray(field.sources) && field.sources.length)) delete o.sources;
    // An empty description (null, "" or blank, made null above) removes the field, so the queue file looks as before.
    if ('description' in field && field.description == null) delete o.description;
    // null (--issue none) removes the issue link.
    if ('issue' in field && field.issue == null) delete o.issue;
    if (bonus != null) {
      const t = L.addToBonus(o, bonus, new Date().toISOString());
      if (t) die(`Invalid bonus: ${t}`);
    }
    // A new mission longer than queue.missionInlineMax goes to <dataFolder>/mission/<id>.md (cli/context.mjs
    // moveLongMission), last, so a refused edit writes no file. Only when this edit sets the mission: an old long
    // inline mission is left alone by an edit of another field. The changelog (editLogged) then holds the path.
    if ('mission' in field) {
      const m = moveLongMission(o);
      if (m) missionMoved.push(m);
    }
  });
  // The finding log (lib/findingSources.js), after the write: one row per newly fixed task, at most a warning.
  if (newFixes.length) FSRC.record(() => FSRC.fixLinks({ id, fixes: newFixes }));
  const changedField = [...Object.keys(field), ...(bonus != null ? ['bonus', 'remarks'] : [])];
  // The task links (V1, cli/taskLinksCheck.mjs), only when this edit wrote one (plan, sources or source): an old
  // broken link is doctor's row, not a surprise on an unrelated edit. The change is saved either way.
  const touchesLinks = ['plan', 'sources', 'source'].some((k) => k in field);
  const links = touchesLinks ? linkProblems(read().tasks.filter((x) => x.id === id)) : [];
  // A description this edit set over the soft limit (lib/taskDescription.js): one WARNING line; it is saved anyway.
  const descriptionLine = 'description' in field ? DESC.descriptionWarning(id, field.description) : null;
  // --answer-json (the board): one JSON line with the changelog no., so "Undo" rolls back exactly this edit.
  if (a.includes('--answer-json'))
    console.log(
      JSON.stringify({
        ok: true,
        id,
        changed: changedField,
        log: lastEntry?.nr ?? null,
        linkProblems: linkProblemsJson(links),
        // Only when the mission moved, so the answer is as before otherwise.
        ...(missionMoved.length ? { missionMoved: missionMovedJson(missionMoved) } : {}),
        // Only when the description is over the soft limit, for the same reason (a list, as in add).
        ...(descriptionLine ? { descriptionWarning: [descriptionLine] } : {}),
      }),
    );
  else {
    console.log(`${id} changed: ${changedField.join(', ')}`);
    for (const m of missionMoved) console.log(missionMovedLine(m));
    printLinkWarning(links, 'changed');
    if (descriptionLine) console.log(descriptionLine);
    if (bonus != null)
      console.log(
        'The addition is in the track block from now on (ravenseat trackFile / fill --ids). If the track is already running: send it with SendMessage.',
      );
    if (undoHint()) console.log(undoHint());
  }
}

/** `ravenseat edit-many` (the usage is at the top of queue.mjs). */
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

/** `ravenseat undo` (the usage is at the top of queue.mjs). */
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
          : 'Can be undone (ravenseat undo).',
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
