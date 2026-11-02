// =============================================================
// logic/edit.js: bulk edit, the changelog, undo and block moves.
//
// editMany and parkedValue (`edit-many`, all or nothing), the changelog (logChange, bulkDiff, diffLines, cloneJson,
// equalValue), undo (lastUndoable, undoEntry, expectCheck) and rankBlock (moving a block of tasks on the board).
//
// Part of the queueLogic.js split: lib/queueLogic.js re-exports every name, so callers keep requiring queueLogic.js.
// Used by queueLogic.js (the facade) and by logic/focus.js.
// Tested in lib/__tests__/queueBulk.test.ts, queuePlan.test.ts and queueTaskEdit.test.ts (through queueLogic.js).
// =============================================================

const { isExternalRow, round2 } = require('./base.js');
const { projectFor, newRegister } = require('./projects.js');
const { validateNewField } = require('./validate.js');
const { FOCUS_MAX_TEXT, rankingContext, ranking, compareRanking, parseToDate, score } = require('./ranking.js');
const { batchedError } = require('./batch.js');

/** The fields `edit-many` can set per task. */
const EDIT_MANY_FIELD = new Set([
  'id',
  'project',
  'feature',
  'labels',
  'requires',
  'priority_bonus',
  // Put on hold / take off hold, and into / out of the batch queue, with the same rules as park and edit.
  'parked',
  'batched',
  // The link to the plan register (queue.mjs checks that the plan entry exists).
  'plan',
]);
/** The fields that are actually changed (everything except id). */
const EDIT_MANY_VALUES = [
  'project',
  'feature',
  'labels',
  'requires',
  'priority_bonus',
  'parked',
  'batched',
  'plan',
];
/**
 * Interprets `parked` in edit-many: null = take off hold; true = park (without reason and date); { reason?, to? } = park with
 * reason and/or date (YYYY-MM-DD = through that day, UTC). `by` and `at` are set by the tool (same shape as
 * queue.mjs park). Returns { val } (null = remove the field) or { error }.
 */
function parkedValue(raw, { by, now }) {
  if (raw === null) return { val: null };
  const who = String(by ?? '').trim() || 'unknown';
  if (raw === true) return { val: { by: who, at: now } };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { error: 'parked must be true, null or { reason?, to? }' };
  const unknown = Object.keys(raw).filter((k) => !['reason', 'to'].includes(k));
  if (unknown.length)
    return { error: `parked: unknown field ${unknown.join(', ')} (allowed: reason, to)` };
  const g = raw.reason == null ? null : String(raw.reason).trim();
  if (g && g.length > FOCUS_MAX_TEXT)
    return { error: `parked: the reason can be at most ${FOCUS_MAX_TEXT} characters` };
  let to = null;
  if (raw.to != null && raw.to !== '') {
    to = parseToDate(raw.to);
    if (!to) return { error: `parked: invalid date ${raw.to} (use YYYY-MM-DD or ISO time)` };
    if (Date.parse(to) <= Date.parse(now))
      return { error: `parked: the date ${raw.to} has passed` };
  }
  return {
    val: { by: who, at: now, ...(g ? { reason: g } : {}), ...(to ? { to } : {}) },
  };
}
/**
 * Bulk edit (`queue.mjs edit-many --file`): a list [{ id, project?, feature?, labels?, requires?,
 * priority_bonus?, parked?, batched? }] or an object { projects?: {…}, tasks?: [...] }. ALL OR NOTHING:
 * everything is validated before anything is changed, and on one error nothing is changed (neither tasks nor register). `null` removes a field
 * (project then falls back to the prefix rule). A project must exist in the register after the file is applied.
 * `priority_bonus` ("Lift dependencies too") must be a number.
 * `parked` (see parkedValue; only waiting and proposed can be parked, like queue.mjs park), `batched` (same
 * rules as add/edit: queueLogic.batchedError against the queue as it will be), the register fields `area`, `fileRoot` and `features`,
 * and `dry` (computes everything on a copy and changes nothing). The answer always has `changes` (bulkDiff: only fields that
 * actually changed, for the preview and the changelog) and `warnings` (move to a paused project, parking of a
 * task the focus has pulled along, batch queue for a task that is parked).
 * @param {{ by?: string, now?: string, dry?: boolean }} [option]
 * @returns {{ error: string[], changed?: string[], projects?: string[], changes?: object[], warnings?: string[] }}
 */
function editMany(queue, input, { by = null, now = new Date().toISOString(), dry = false } = {}) {
  if (dry) return editMany(cloneJson(queue), input, { by, now });
  let changes;
  let projects;
  const error = [];
  if (Array.isArray(input)) changes = input;
  else if (input && typeof input === 'object') {
    const unknown = Object.keys(input).filter((k) => !['tasks', 'projects'].includes(k));
    if (unknown.length)
      error.push(`unknown top-level keys: ${unknown.join(', ')} (allowed: projects, tasks)`);
    changes = input.tasks ?? [];
    projects = input.projects;
  } else {
    return { error: ['the file must be a list of changes or { projects, tasks }'] };
  }
  if (!Array.isArray(changes)) return { error: [...error, 'tasks must be a list'] };
  const reg = newRegister(queue.projects, projects, queue.areas);
  error.push(...reg.error);
  const perId = new Map((queue.tasks ?? []).map((o) => [o.id, o]));
  const set = new Set();
  const plan = [];
  changes.forEach((e, i) => {
    const name = e?.id ?? `no. ${i + 1}`;
    if (!e || typeof e !== 'object' || Array.isArray(e)) {
      error.push(
        `no. ${i + 1}: must be an object { id, project?, feature?, labels?, priority_bonus?, parked?, batched? }`,
      );
      return;
    }
    const unknown = Object.keys(e).filter((k) => !EDIT_MANY_FIELD.has(k));
    if (unknown.length)
      error.push(
        `${name}: unknown field ${unknown.join(', ')} (edit-many only takes ${[...EDIT_MANY_FIELD].join(', ')})`,
      );
    if (
      'priority_bonus' in e &&
      e.priority_bonus !== null &&
      (typeof e.priority_bonus !== 'number' || !Number.isFinite(e.priority_bonus))
    )
      error.push(`${name}: priority_bonus must be a number`);
    const o = perId.get(e.id);
    if (!o || isExternalRow(o)) {
      error.push(`${name}: unknown task`);
      return;
    }
    if (set.has(e.id)) error.push(`${e.id}: appears more than once in the file`);
    set.add(e.id);
    // The values that are written (parked is normalized; batched false/null removes the field, like queue.mjs edit).
    const values = {};
    for (const k of EDIT_MANY_VALUES) if (k in e) values[k] = e[k];
    if ('parked' in e) {
      if (e.parked === true && o.parked) delete values.parked;
      else {
        const p = parkedValue(e.parked, { by, now });
        if (p.error) error.push(`${e.id}: ${p.error}`);
        else {
          values.parked = p.val;
          if (p.val && o.status !== 'waiting' && o.status !== 'proposed')
            error.push(`${e.id}: status ${o.status} (only waiting and proposed can be parked)`);
        }
      }
    }
    if ('batched' in e) {
      if (e.batched != null && typeof e.batched !== 'boolean')
        error.push(`${e.id}: batched must be true, false or null`);
      else if (e.batched !== true) values.batched = null;
    }
    const fresh = { ...o };
    for (const [k, v] of Object.entries(values)) {
      if (v === null) delete fresh[k];
      else fresh[k] = v;
    }
    for (const f of validateNewField(fresh, reg.register, { stringProject: true }))
      error.push(`${e.id}: ${f}`);
    plan.push({ o, e, new: fresh, values });
  });
  // Batch queue: the rules against the queue as it will be after the WHOLE file (two tasks in the file can affect each other).
  const newPerId = new Map(plan.map((p) => [p.o.id, p.new]));
  const after = (queue.tasks ?? []).map((x) => newPerId.get(x.id) ?? x);
  for (const p of plan) {
    if (!('batched' in p.e)) continue;
    for (const f of batchedError(p.new, after, queue.resolved)) error.push(`${p.o.id}: ${f}`);
  }
  if (error.length) return { error };

  // Warnings (do not stop): computed against the queue BEFORE the change.
  const warnings = [];
  const k = rankingContext(queue, Date.parse(now));
  for (const p of plan) {
    const pidAfter = projectFor(p.new, reg.register);
    if (
      pidAfter !== projectFor(p.o, queue.projects ?? {}) &&
      reg.register?.[pidAfter]?.pause === true
    )
      warnings.push(
        `${p.o.id} is moved to ${pidAfter}, which is paused (not started until it continues)`,
      );
    if (p.values.parked && !p.o.parked) {
      const d = k.dragged.get(p.o.id);
      if (d && !newPerId.get(d.by)?.parked)
        warnings.push(
          `${p.o.id} is pulled along by ${d.by} in the focus (stage ${d.stage + 1}); it waits until ${p.o.id} continues`,
        );
    }
    if (p.new.batched === true && p.new.parked)
      warnings.push(
        `${p.o.id} is both parked and in the batch queue; it is packed, but not started until it continues`,
      );
  }

  const forQueue = {
    tasks: plan.map((p) => cloneJson(p.o)),
    projects: cloneJson(queue.projects ?? {}),
  };
  if (projects != null) queue.projects = reg.register;
  for (const { o, values } of plan) {
    for (const [kk, v] of Object.entries(values)) {
      if (v === null) delete o[kk];
      else o[kk] = v;
    }
  }
  return {
    error: [],
    changed: plan.map((p) => p.o.id),
    projects: Object.keys(projects ?? {}),
    changes: bulkDiff(forQueue, {
      tasks: plan.map((p) => p.o),
      projects: queue.projects ?? {},
    }),
    warnings,
  };
}

// ---- Bulk edit, changelog and undo, block moves, proposed projects ----------------------
//
// Used by queue.mjs
// (edit-many --dry/--expect-changed, ranger, undo, classify, the warnings in add and project) and by the board via
// queue.mjs. New, optional fields in queue.json:
//   changelog: [{ nr, at, by, action, changes: [{ id|pid, field, before, after }], undone? }]   the last 50
//                 writes from edit, edit-many, ranger, park, continue, project and classify. Only fields that
//                 actually changed (id, field and values; no personal data). `null` = the field did not exist.
//   projects.<pid>.fileRoot: [path]       folders/files that characterize the project (signal for classify).
//   projects.<pid>.features: [name]  known feature names (add warns about new ones).

/** At most this many entries in the changelog (the oldest fall out). */
const CHANGELOG_MAX = 50;
/** How far past the neighbor a block lands at the top or bottom (in priority points; like queueBoard.STEP). */
const RANK_STEP = 10;
/** Fields that are owned by their own commands (set, start, pick …) and are never rolled back by undo. */
const UNDO_BLOCKED = new Set([
  'id',
  'status',
  'started',
  'done',
  'branch',
  'migr_block',
  'picked_by',
  'picked_at',
  'added_at',
  'external',
  'external_name',
  'done_outside_queue',
]);
/**
 * The one status change undo may roll back: a logged `queue.mjs cancel` (the board's "Cancel task" and "Decline") of a
 * task that was waiting or proposed. Other status changes belong to their own commands and stay blocked.
 */
const undoableCancel = (entry, e) =>
  entry?.action === 'cancel' &&
  e.field === 'status' &&
  e.after === 'cancelled' &&
  (e.before === 'waiting' || e.before === 'proposed');

/** Deep copy of a JSON value; undefined becomes null. */
function cloneJson(x) {
  return x === undefined ? null : JSON.parse(JSON.stringify(x));
}

/** JSON with sorted keys, so two equal objects always compare equal. */
function stableJson(x) {
  if (Array.isArray(x)) return `[${x.map(stableJson).join(',')}]`;
  if (x && typeof x === 'object')
    return `{${Object.keys(x)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(x[k])}`)
      .join(',')}}`;
  return JSON.stringify(x === undefined ? null : x);
}

/** Are two field values equal? null and a missing field are the same. */
function equalValue(a, b) {
  return stableJson(a ?? null) === stableJson(b ?? null);
}

/**
 * The difference between two versions of the queue: tasks (per id, only those that exist in both) and the project register (per pid).
 * Only fields that actually changed. For the preview (`edit-many --dry`) and the changelog.
 * @returns {{ id?: string, pid?: string, field: string, before: unknown, after: unknown }[]}
 */
function bulkDiff(forQueue, afterQueue) {
  const out = [];
  const forPerId = new Map((forQueue?.tasks ?? []).map((o) => [o.id, o]));
  for (const o of afterQueue?.tasks ?? []) {
    const f = forPerId.get(o.id);
    if (!f) continue;
    for (const field of [...new Set([...Object.keys(f), ...Object.keys(o)])].sort()) {
      if (!equalValue(f[field], o[field]))
        out.push({
          id: o.id,
          field,
          before: cloneJson(f[field] ?? null),
          after: cloneJson(o[field] ?? null),
        });
    }
  }
  const forReg = forQueue?.projects ?? {};
  const afterReg = afterQueue?.projects ?? {};
  for (const pid of [...new Set([...Object.keys(forReg), ...Object.keys(afterReg)])]) {
    const f = forReg[pid] ?? {};
    const e = afterReg[pid] ?? {};
    for (const field of [...new Set([...Object.keys(f), ...Object.keys(e)])].sort()) {
      if (!equalValue(f[field], e[field]))
        out.push({ pid, field, before: cloneJson(f[field] ?? null), after: cloneJson(e[field] ?? null) });
    }
  }
  return out;
}

/** Short text for a value in the preview and error messages. */
function valueText(v, max = 60) {
  if (v == null) return '(none)';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** What a change concerns: the task id, "project <pid>" or "focus" (cleanFocus). */
function changeWho(e) {
  if (e?.id != null) return e.id;
  if (e?.pid != null) return `project ${e.pid}`;
  return e?.focus ? 'focus' : '?';
}

/** The lines in the preview: "A-1 project: alpha → beta". */
function diffLines(changes, { max = 200 } = {}) {
  const lines = (changes ?? [])
    .slice(0, max)
    .map((e) => `${changeWho(e)} ${e.field}: ${valueText(e.before)} → ${valueText(e.after)}`);
  if ((changes ?? []).length > max) lines.push(`… and ${changes.length - max} more`);
  return lines;
}

/**
 * Adds an entry to the changelog (the last CHANGELOG_MAX are kept). No entry when nothing changed.
 * @returns {object|null} entry
 */
function logChange(queue, { by = null, action, changes, now = new Date().toISOString() } = {}) {
  if (!Array.isArray(changes) || !changes.length) return null;
  const log = Array.isArray(queue.changelog) ? queue.changelog : [];
  const nr = log.reduce((m, p) => Math.max(m, Number(p?.nr) || 0), 0) + 1;
  const entry = {
    nr,
    at: now,
    by: String(by ?? '').trim() || 'unknown',
    action: String(action ?? 'unknown'),
    changes: cloneJson(changes),
  };
  log.push(entry);
  queue.changelog = log.slice(-CHANGELOG_MAX);
  return entry;
}

/** The last entry that is not undone (the one `undo` rolls back), or null. */
function lastUndoable(queue) {
  const log = Array.isArray(queue?.changelog) ? queue.changelog : [];
  for (let i = log.length - 1; i >= 0; i -= 1) if (!log[i]?.undone) return log[i];
  return null;
}

/**
 * Rolls back the last entry in the changelog that is not undone (queue.mjs undo). Refuses (nothing is changed) when a
 * field no longer has the "after" value (someone has changed it since), when a task is gone, or when the result breaks
 * the rules (the project must exist, only waiting and proposed can be parked, the batch queue rules). The entry stays, marked
 * `undone`, so the log shows what happened; the next undo takes the entry before it. `show` checks without editing anything.
 * `lockError(task, { field: value })` (optional; queue.mjs passes doneCheck.doneLockError for the caller) refuses a
 * field the caller may not set, so undo cannot move a locked finish line back either.
 * @returns {{ error: string[], entry?: object, show?: boolean }}
 */
function undoEntry(queue, { by = null, now = new Date().toISOString(), show = false, lockError = null } = {}) {
  const entry = lastUndoable(queue);
  if (!entry)
    return { error: ['nothing to undo (the changelog is empty, or everything in it is undone)'] };
  const tasks = cloneJson(queue.tasks ?? []);
  const register = cloneJson(queue.projects ?? {});
  const perId = new Map(tasks.map((o) => [o.id, o]));
  const error = [];
  const affected = new Set();
  const batchedAffected = new Set();
  const pids = new Set();
  // Changes to the focus itself (focus clean) have `focus: true` and are rolled back on a copy.
  const focus = cloneJson(queue.focus ?? {});
  let focusAffected = false;
  for (const e of entry.changes ?? []) {
    const who = changeWho(e);
    if (e.id != null && UNDO_BLOCKED.has(e.field) && !undoableCancel(entry, e)) {
      error.push(`${who}: ${e.field} cannot be undone (use the command that owns the field)`);
      continue;
    }
    const lock = e.id != null && lockError && perId.has(e.id) ? lockError(perId.get(e.id), { [e.field]: e.before }) : null;
    if (lock) {
      error.push(`${who}: ${lock}`);
      continue;
    }
    let measure;
    if (e.id == null && e.pid == null && e.focus === true) {
      measure = focus;
      focusAffected = true;
    } else if (e.id != null) {
      measure = perId.get(e.id);
      if (!measure) {
        error.push(`${e.id}: no longer exists in the queue`);
        continue;
      }
    } else if (e.pid != null) {
      measure = register[e.pid] ?? {};
      register[e.pid] = measure;
      pids.add(e.pid);
    } else {
      error.push('the entry has a change without id or pid');
      continue;
    }
    if (!equalValue(measure[e.field], e.after)) {
      error.push(
        `${who} ${e.field} has changed since (now ${valueText(measure[e.field])}, the entry set ${valueText(e.after)})`,
      );
      continue;
    }
    if (e.before == null) delete measure[e.field];
    else measure[e.field] = cloneJson(e.before);
    if (e.id != null) {
      affected.add(e.id);
      if (e.field === 'batched') batchedAffected.add(e.id);
    }
  }
  // A project the entry created disappears again when all fields are rolled back.
  const removed = [...pids].filter((pid) => !Object.keys(register[pid]).length);
  for (const pid of removed) delete register[pid];
  if (!error.length) {
    for (const pid of pids) {
      if (removed.includes(pid)) continue;
      const r = newRegister({}, { [pid]: register[pid] }, queue.areas);
      error.push(...r.error);
    }
    for (const o of tasks) {
      if (removed.includes(o.project))
        error.push(`${o.id} uses the project ${o.project}, which undo would remove`);
    }
    for (const id of affected) {
      const o = perId.get(id);
      for (const f of validateNewField(o, register, { stringProject: true }))
        error.push(`${id}: ${f}`);
      if (o.parked && o.status !== 'waiting' && o.status !== 'proposed')
        error.push(`${id}: status ${o.status} (only waiting and proposed can be parked)`);
      if (batchedAffected.has(id))
        for (const f of batchedError(o, tasks, queue.resolved)) error.push(`${id}: ${f}`);
    }
  }
  if (error.length) return { error, entry };
  if (show) return { error: [], entry, show: true };
  queue.tasks = (queue.tasks ?? []).map((o) => (affected.has(o.id) ? perId.get(o.id) : o));
  if (pids.size) queue.projects = register;
  if (focusAffected) {
    if (!Array.isArray(focus.history) || !focus.history.length) delete focus.history;
    queue.focus = focus;
  }
  entry.undone = { at: now, by: String(by ?? '').trim() || 'unknown' };
  return { error: [], entry };
}

/**
 * Optimistic concurrency (`--expect-changed <iso>`): null when the queue has not changed after the time the board (or another
 * caller) previewed, otherwise the error text. Called under the lock.
 */
function expectCheck(queue, expectValue) {
  if (expectValue == null) return null;
  const f = Date.parse(String(expectValue));
  if (!Number.isFinite(f))
    return `invalid --expect-changed ${expectValue} (ISO time, e.g. the field changed in /api/state)`;
  const e = Date.parse(String(queue?.changed ?? ''));
  if (Number.isFinite(e) && e > f)
    return (
      `the queue was changed ${queue.changed}, after ${expectValue} which the preview was built on. ` +
      'Get the queue again and review the change again.'
    );
  return null;
}

/**
 * Block move (queue.mjs ranger): moves tasks together to the top (`top`), the bottom (`bottom`), right above (`over: id`)
 * or right below (`under: id`) another, WITHIN the focus stage, and keeps their mutual order. Computes
 * new `priority_bonus` (generalization of queueBoard.boostBonus): the block is spread evenly between the neighbors, or
 * RANK_STEP past the neighbor at the top/bottom. If the block is in several stages, each part is moved within its stage (top/bottom);
 * over/under requires that all are in the reference's stage. Only waiting and proposed.
 * @returns {{ error: string[], changes?: Record<string, number|null>, warnings?: string[] }}
 */
function rankBlock(queue, ids, space = {}, now = Date.now()) {
  const error = [];
  const list = [...new Set(ids ?? [])];
  if (!list.length) error.push('ranger <id> … --top|--bottom|--over <id>|--under <id>');
  const selected = ['top', 'bottom', 'over', 'under'].filter((k) => space?.[k]);
  if (selected.length !== 1) error.push('choose one of --top, --bottom, --over <id> and --under <id>');
  const tasks = queue.tasks ?? [];
  const register = queue.projects ?? {};
  const perId = new Map(tasks.map((o) => [o.id, o]));
  const canBeRanked = (o) => o.status === 'waiting' || o.status === 'proposed';
  for (const id of list) {
    const o = perId.get(id);
    if (!o || isExternalRow(o)) error.push(`unknown task ${id}`);
    else if (!canBeRanked(o))
      error.push(`${id}: status ${o.status} (only waiting and proposed can be ranked)`);
  }
  const ref = space?.over ?? space?.under ?? null;
  if (ref && selected.length === 1) {
    const r = perId.get(ref);
    if (!r || isExternalRow(r)) error.push(`unknown task ${ref}`);
    else if (list.includes(ref)) error.push(`${ref} is in the block itself`);
    else if (!canBeRanked(r)) error.push(`${ref}: status ${r.status} (is not ranked)`);
  }
  if (error.length) return { error };
  const k = rankingContext(queue, now);
  const rank = new Map();
  const ra = (o) => {
    if (!rank.has(o.id)) rank.set(o.id, ranking(o, queue, k));
    return rank.get(o.id);
  };
  const without = (o) => score({ ...o, priority_bonus: 0 }, tasks, now, register);
  const block = list
    .map((id) => perId.get(id))
    .map((o) => ({ o, r: ra(o) }))
    .sort(compareRanking);
  const perStep = new Map();
  for (const x of block) {
    if (!perStep.has(x.r.stage)) perStep.set(x.r.stage, []);
    perStep.get(x.r.stage).push(x);
  }
  if (ref) {
    const t = ra(perId.get(ref)).stage;
    const outside = block.filter((x) => x.r.stage !== t).map((x) => x.o.id);
    if (outside.length)
      return {
        error: [
          `${outside.join(', ')} is in another stage than ${ref}; ranger only moves within the stage (edit the focus to move between stages)`,
        ],
      };
  }
  const inBlock = new Set(list);
  const changes = {};
  const warnings = [];
  for (const [stage, parts] of perStep) {
    const others = tasks
      .filter(
        (o) => !inBlock.has(o.id) && !isExternalRow(o) && canBeRanked(o) && ra(o).stage === stage,
      )
      .map((o) => ({ o, r: ra(o) }))
      .sort(compareRanking);
    let high = null;
    let low = null;
    if (space.top) low = others.length ? others[0].r.score : null;
    else if (space.bottom) high = others.length ? others[others.length - 1].r.score : null;
    else {
      const i = others.findIndex((x) => x.o.id === ref);
      if (space.over) {
        low = others[i].r.score;
        high = i > 0 ? others[i - 1].r.score : null;
      } else {
        high = others[i].r.score;
        low = i < others.length - 1 ? others[i + 1].r.score : null;
      }
    }
    const n = parts.length;
    if (high != null && low != null && high - low < 0.02 * (n + 1))
      warnings.push(
        `too little room between the neighbors (${high} and ${low} score); the block may end up tied with a neighbor (id then decides)`,
      );
    parts.forEach((x, j) => {
      let measure;
      if (high == null && low == null) return; // no others in the stage: the order is already correct
      if (high == null) measure = low + RANK_STEP * (n - j);
      else if (low == null) measure = high - RANK_STEP * (j + 1);
      else measure = low + ((high - low) * (n - j)) / (n + 1);
      const t = round2(measure - without(x.o));
      changes[x.o.id] = Math.abs(t) < 0.005 ? null : t;
    });
  }
  return { error: [], changes, warnings };
}

module.exports = {
  parkedValue,
  editMany,
  CHANGELOG_MAX,
  RANK_STEP,
  cloneJson,
  equalValue,
  bulkDiff,
  diffLines,
  logChange,
  lastUndoable,
  undoEntry,
  expectCheck,
  rankBlock,
};
