// =============================================================
// queue-board/api/tasks.mjs: the task routes (selection bar, undo, detail panel, card and lane drag).
//
// The task routes: POST /api/bulk (the selection bar), /api/undo, /api/task-edit (cancel, decline, edit in the detail
// panel), /api/move (drag a card) and /api/lane (drag a project lane); GET /api/task (the detail panel) and
// /api/archive (the archived tasks for history and search).
//
// Moved out of queue-board.mjs unchanged (SPLIT-1). A handler that needs the server takes its context `ctx` first:
// the live paths and caches as getters (demo mode switches them), the data builders and the write plumbing
// (writeTools.mjs). A POST handler also gets `c`, the per-call tools write() builds (no, run, queueNow, info).
// taskRoutes(ctx) binds them, so queue-board.mjs calls them with the old arguments.
//
// Used by: queue-board.mjs (write() and the GET routes).
// Tested in: lib/__tests__/queueBoardServe.test.ts, queueTaskEdit.test.ts, queueBoardState.test.ts and the other board tests that start the server.
// =============================================================
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { idOrNull, pidOrNull, cleanText, spaceArgs, errorText } from './writeTools.mjs';

const require = createRequire(import.meta.url);
const CATALOG = require('../../lib/catalog.js');
const DESC = require('../../lib/taskDescription.js');
const KK = require('../../lib/queueConfig.js');
const L = require('../../lib/queueLogic.js');
const QARCH = require('../../lib/queueArchive.js');
const QT = require('../../lib/queueTimeline.js');
const T = require('../../lib/queueBoard.js');
const TE = require('../../lib/queueTaskEdit.js');

/**
 * The bulk action from the selection bar. The body: { action, ids[], val, dry, expect, confirm }.
 *   dry: true  → preview: what changes (queue.mjs edit-many/rank --dry, or queueBoard.packPreview
 *                 for "Pack into track"), the explanation, the guard rules and the queue's version `changed`. Writes nothing.
 *   otherwise   → the guard rules (stop 422, warning 409 without confirm), then queue.mjs with --expect-changed <expect>, so
 *                 an orchestrator that has changed the queue meanwhile is not overrun (409 with outdated: true).
 * The id list is the one the owner saw; the server never evaluates a search again.
 */
async function bulk(ctx, b, queueNow) {
  const { editManyJson, guard, planEffectOf, queueJson } = ctx;
  const no = (message) => ({ status: 400, answer: { ok: false, message } });
  const action = String(b.action ?? '');
  if (!T.BULK_ACTIONS.includes(action)) return no(`unknown bulk action ${action}`);
  if (!Array.isArray(b.ids)) return no('invalid id-list');
  const ids = b.ids.map(idOrNull);
  if (!ids.length || ids.length > T.BULK_MAX || ids.some((x) => !x))
    return no('invalid id-list');
  const expectValue = b.expect == null ? null : String(b.expect);
  if (expectValue != null && !Number.isFinite(Date.parse(expectValue))) return no('invalid expect');
  const val = b.val && typeof b.val === 'object' && !Array.isArray(b.val) ? b.val : {};
  if (val.title != null) val.title = cleanText(val.title, 200);
  const queue = queueNow();
  const plan = T.bulkPlan(queue, action, ids, val);
  if (plan.error.length) return no(plan.error.join('\n'));
  const assessment = { type: 'bulk', action, ids, val };

  if (b.dry === true) {
    let changes = [];
    let warnings = [];
    let error = [];
    let pkg = null;
    let changed = queue.changed ?? null;
    if (plan.command === 'batch-pack') {
      const p = T.packPreview(queue, ids, { newId: plan.newId, title: plan.title });
      if (p.error.length) error = p.error;
      else pkg = p;
    } else {
      const r =
        plan.command === 'rank'
          ? await queueJson(['rank', ...ids, ...spaceArgs(plan.space), '--dry', '--json'])
          : await editManyJson(plan.content, ['--dry']);
      if (r.ok && r.data?.ok) {
        changes = r.data.changes ?? [];
        warnings = r.data.warnings ?? [];
        changed = r.data.changed ?? changed;
      } else error = [errorText(r, 'ravenseat failed')];
    }
    const list = T.assess(queue, assessment, { now: Date.now() });
    // T-B: a Timeline drop asks for the plan in words; only a rank (order) is played, and only when the dry run worked.
    const effect =
      b.plan_effect === true && plan.command === 'rank' && !error.length
        ? { plan: planEffectOf(queue, QT.applyChanges(queue, changes), ids) }
        : {};
    return {
      status: 200,
      answer: {
        ok: true,
        dry: true,
        ...effect,
        changed,
        recap: T.bulkSummary(queue, action, ids, val, changes),
        lines: L.diffLines(changes, { max: 300 }),
        field: changes.length,
        warnings,
        error,
        package: pkg,
        guard: list,
        can: !error.length && !list.some((v) => v.level === 'stop'),
      },
    };
  }

  const v = guard(queue, assessment, {}, b);
  if (v.stop) return v.stop;
  const fv = expectValue ? ['--expect-changed', expectValue] : [];
  let r;
  if (plan.command === 'batch-pack')
    r = await queueJson([
      'batch',
      'pack',
      ...ids,
      '--id',
      plan.newId,
      ...(plan.title ? ['--title', plan.title] : []),
      ...fv,
    ]);
  else if (plan.command === 'rank')
    r = await queueJson([
      'rank',
      ...ids,
      ...spaceArgs(plan.space),
      '--json',
      '--by',
      'theBoard',
      ...fv,
    ]);
  else r = await editManyJson(plan.content, ['--by', 'theBoard', ...fv]);
  ctx.clearQuick();
  const clock = new Date().toLocaleTimeString('en-GB');
  const what = `bulk ${action} ${ids.length === 1 ? ids[0] : `${ids.length} tasks`}`;
  console.log(`${clock} ${what}: ${r.ok ? 'ok' : `failed (${errorText(r, '?')})`}`);
  if (!r.ok || (r.data && r.data.ok === false)) {
    const outdated = r.code === 6 || r.data?.outdated === true;
    return {
      status: 409,
      answer: {
        ok: false,
        outdated,
        message: outdated
          ? 'The queue has changed since the preview. Review the change again.'
          : errorText(r, 'ravenseat failed'),
      },
    };
  }
  return {
    status: 200,
    answer: {
      ok: true,
      message: plan.command === 'batch-pack' ? r.out : `${r.data?.changed?.length ?? ids.length}`,
      info: v.info,
      // The entry in the changelog ("Undo" sends it back as --nr). Packing is not logged and cannot be undone.
      log: r.data?.log ?? null,
      new_id: plan.command === 'batch-pack' ? plan.newId : null,
    },
  };
}

/**
 * "Undo" (queue.mjs undo). { show: true } shows the last entry that can be undone and whether that works now;
 * otherwise it is undone, with { nr } when the board knows which entry (after a bulk action), so someone else's change is never
 * undone instead.
 */
async function undo(ctx, b) {
  const { queueJson } = ctx;
  if (b.show === true) {
    const r = await queueJson(['undo', '--show', '--json']);
    if (!r.data)
      return { status: 500, answer: { ok: false, message: errorText(r, 'ravenseat failed') } };
    return {
      status: 200,
      answer: {
        ok: true,
        can: r.data.ok === true,
        error: r.data.error ?? [],
        entry: r.data.entry ?? null,
        lines: r.data.entry ? L.diffLines(r.data.entry.changes ?? [], { max: 300 }) : [],
      },
    };
  }
  const nr = b.nr == null ? null : Number(b.nr);
  if (nr != null && !(Number.isInteger(nr) && nr > 0))
    return { status: 400, answer: { ok: false, message: 'invalid nr' } };
  const r = await queueJson(['undo', '--json', '--by', 'theBoard', ...(nr ? ['--nr', String(nr)] : [])]);
  ctx.clearQuick();
  console.log(
    `${new Date().toLocaleTimeString('en-GB')} undo${nr ? ` no. ${nr}` : ''}: ${r.ok ? 'ok' : `failed (${errorText(r, '?')})`}`,
  );
  if (!r.ok || r.data?.ok !== true)
    return { status: 409, answer: { ok: false, message: errorText(r, 'ravenseat undo failed') } };
  const p = r.data.entry;
  return {
    status: 200,
    answer: { ok: true, message: `Undone ${p?.action ?? 'change'} (no. ${p?.nr ?? '?'})` },
  };
}

/**
 * "Cancel task", "Decline" and "Edit" from the detail panel. The body: { type: 'cancel'|'decline'|'edit', id, reason?,
 * form?: { value?, content_min?, class? }, expect? }. The rules are in lib/queueTaskEdit.js (only waiting and proposed;
 * decline only a proposal; the edit checked with queueLogic.validate). The write is `queue.mjs cancel` or `queue.mjs edit`
 * with --by theBoard (and --expect-changed when the board sends it), both logged in the changelog: the answer has `log`,
 * which "Undo" sends back as { nr } to /api/undo, as after a bulk action.
 */
async function taskEdit(ctx, b, queueNow) {
  const { queueJson } = ctx;
  const no = (message) => ({ status: 400, answer: { ok: false, message } });
  const type = String(b.type ?? '');
  const id = idOrNull(b.id);
  if (!id) return no('invalid id');
  const expectValue = b.expect == null ? null : String(b.expect);
  if (expectValue != null && !Number.isFinite(Date.parse(expectValue))) return no('invalid expect');
  const fv = expectValue ? ['--expect-changed', expectValue] : [];
  const queue = queueNow();
  const o = (queue.tasks ?? []).find((x) => x.id === id);
  let args;
  if (type === 'cancel' || type === 'decline') {
    const f = TE.cancelError(o);
    if (f) return no(f === 'unknown task' ? `unknown task ${id}` : f);
    if (type === 'decline' && o.status !== 'proposed') return no(`${id} is not a proposal (it is ${o.status})`);
    const remark = TE.cancelRemark(b.reason, { declined: type === 'decline' });
    // "Keep as not building" (roadmap 0f): decline --keep, only while catalog.captureAnswers is not off (read fresh,
    // as the state is). queue.mjs checks the setting again and writes only a proposed draft.
    const keep = type === 'decline' && b.keep === true ? ['--keep'] : [];
    if (keep.length && CATALOG.setupOf(KK.config({ fresh: true })).captureAnswers === 'off')
      return no('catalog.captureAnswers is off: the proposal is not kept as a "not building" entry');
    args = ['cancel', id, '--remark', remark, ...keep, '--by', 'theBoard', '--json', ...fv];
  } else if (type === 'edit') {
    const p = TE.editPlan(queue, id, b.form);
    if (p.error.length) return no(p.error.join('\n'));
    args = ['edit', id, '--json', JSON.stringify(p.field), '--by', 'theBoard', '--answer-json', ...fv];
  } else return no(`unknown action ${type}`);
  const r = await queueJson(args);
  ctx.clearQuick();
  console.log(
    `${new Date().toLocaleTimeString('en-GB')} ${type} ${id}: ${r.ok && r.data?.ok === true ? 'ok' : `failed (${errorText(r, '?')})`}`,
  );
  if (!r.ok || r.data?.ok !== true) {
    const outdated = r.code === 6 || r.data?.outdated === true;
    return {
      status: 409,
      answer: {
        ok: false,
        outdated,
        message: outdated
          ? 'The queue has changed since you opened the task. Look at it again.'
          : errorText(r, `ravenseat ${args[0]} failed`),
      },
    };
  }
  // A description over the soft limit is saved with a WARNING (lib/taskDescription.js); the board shows the line.
  const warning = Array.isArray(r.data.descriptionWarning) ? r.data.descriptionWarning.join(' ') : '';
  // decline --keep: the KEEP line (the draft's id, or why it was not written) goes to the owner as an info line.
  const keepLine = typeof r.data.keep?.line === 'string' ? [r.data.keep.line] : [];
  return {
    status: 200,
    answer: { ok: true, log: r.data.log ?? null, ...(warning ? { warning } : {}), ...(keepLine.length ? { info: keepLine } : {}) },
  };
}

/** POST /api/move. */
function move(ctx, b, c) {
  const { no, queueNow, run } = c;
  const { editMany, guard } = ctx;
  const id = idOrNull(b.id);
  const over = idOrNull(b.over);
  const under = idOrNull(b.under);
  if (!id || over === undefined || under === undefined) return no('invalid id');
  const space = { over, under, top: b.top === true };
  const queue = queueNow();
  const r = T.newBonus(queue, id, space);
  if (r.error) return no(r.error);
  const v = guard(queue, { type: 'move', id, ...space }, {}, b);
  if (v.stop) return v.stop;
  c.info = v.info;
  // A move is the owner's edit (owner 22.11): --by theBoard, so the moved tasks get edited_at (cli/taskEdit.mjs).
  // "Boost dependencies too": the card and the open dependencies are moved in one edit-many call.
  if (b.boost === true) {
    const l = T.boostBonus(queue, id, space);
    if (l.error) return no(l.error);
    const changes = Object.entries(l.changes);
    if (changes.length > 1)
      return editMany(
        { tasks: changes.map(([oid, t]) => ({ id: oid, priority_bonus: t })) },
        run,
        `move ${id} with dependencies (${changes.map(([oid, t]) => `${oid} ${t}`).join(', ')})`,
        ['--by', 'theBoard'],
      );
  }
  return run(
    ['edit', id, '--json', JSON.stringify({ priority_bonus: r.bonus }), '--by', 'theBoard'],
    `move ${id} (priority_bonus ${r.bonus})`,
  );
}

/** POST /api/lane. */
function lane(ctx, b, c) {
  const { no, queueNow, run } = c;
  const { editMany } = ctx;
  const pid = pidOrNull(b.pid);
  const over = pidOrNull(b.over);
  const under = pidOrNull(b.under);
  if (!pid || over === undefined || under === undefined) return no('invalid project id');
  const lanes = T.projectLanes(queueNow()).filter((x) => x.movable);
  const r = T.laneBonus(lanes, pid, { over, under });
  if (r.error) return no(r.error);
  const changes = Object.entries(r.changes);
  if (changes.length === 1)
    return run(
      ['project', pid, '--priority', String(changes[0][1])],
      `lane ${pid} (priority ${changes[0][1]})`,
    );
  // Several projects at once: edit-many is all or nothing.
  const projects = Object.fromEntries(changes.map(([p, t]) => [p, { priority_bonus: t }]));
  return editMany(
    { projects },
    run,
    `lane ${pid} (${changes.map(([p, t]) => `${p} ${t}`).join(', ')})`,
  );
}

/** GET /api/task. */
function getTask(ctx, req, res, url) {
  const { branchFor, branchInfo, historyFor, json, missionFor } = ctx;
  const id = idOrNull(url.searchParams.get('id'));
  if (!id) return json(res, 400, { ok: false, message: 'invalid id' });
  const queue = JSON.parse(fs.readFileSync(ctx.FILE, 'utf8'));
  // An archived task (lib/queueArchive.js) is found too, read-only and marked so.
  const o = (queue.tasks ?? []).find((x) => x.id === id) ?? QARCH.lookup(ctx.FOLDER, id);
  if (!o) return json(res, 404, { ok: false, message: `unknown task ${id}` });
  const mission = missionFor(o);
  const branch = branchFor(o);
  const archived = o.archived_at ? { archived: true, archived_at: o.archived_at, task: o } : {};
  // The description (or null) and the task's own sources ({ path, anchor, role }), drawn as text by the panel.
  return json(res, 200, {
    ok: true,
    mission,
    branch: { name: branch, ...branchInfo(branch) },
    ...DESC.panelFields(o),
    ...archived,
    // J5: the card's History (lib/taskHistory.js), ids, codes, counts and times only; null = could not be built.
    history: historyFor(o, queue),
  });
}

// The archived tasks (lib/queueArchive.js) for the board's history and search: ?q= matches id, title, project and
// feature (case blind), newest first, at most 50. Read-only.
function getArchive(ctx, req, res, url) {
  const { json } = ctx;
  const q = String(url.searchParams.get('q') ?? '').trim().toLowerCase().slice(0, 100);
  const all = QARCH.load(ctx.FOLDER).tasks;
  const hit = (o) => !q || [o.id, o.title, o.project, o.feature].some((v) => String(v ?? '').toLowerCase().includes(q));
  const tasks = all
    .filter(hit)
    .sort((x, y) => String(y.done ?? y.archived_at ?? '').localeCompare(String(x.done ?? x.archived_at ?? '')))
    .slice(0, 50)
    .map((o) => ({ id: o.id, title: o.title ?? null, status: o.status, project: o.project ?? null, feature: o.feature ?? null, done: o.done ?? null, archived_at: o.archived_at ?? null }));
  return json(res, 200, { ok: true, total: all.length, tasks });
}

/** The handlers bound to the server's context (queue-board.mjs builds ctx once and calls them with the old arguments). */
export function taskRoutes(ctx) {
  return {
    bulk: (...args) => bulk(ctx, ...args),
    undo: (...args) => undo(ctx, ...args),
    taskEdit: (...args) => taskEdit(ctx, ...args),
    move: (...args) => move(ctx, ...args),
    lane: (...args) => lane(ctx, ...args),
    getTask: (...args) => getTask(ctx, ...args),
    getArchive: (...args) => getArchive(ctx, ...args),
  };
}
