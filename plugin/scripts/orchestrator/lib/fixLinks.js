// =============================================================
// fixLinks.js: the optional task field `fixes`, the link from a fix task to the task(s) it fixes.
//
// Why: a fix that lands after a task was merged is a defect of that task. Until now the only trace was a naming habit
// (<id>-QA1, <id>-FIX) or a label; with `fixes` the link is explicit data, so the benchmark (bench/) can count defects
// after merge per task, and `cq info`/`cq state` can show what a fix task is for.
//
// The field: one task id or a list of ids in what is added (`cq add`) or edited (`cq edit`); stored as a list. Every id
// must exist in the queue (or be added in the same `add`), and a task cannot fix itself. `qa deviation` sets it on the
// fix task it creates (queueLogic.qaDeviation).
//
// Pure, no I/O. Tested in lib/__tests__/fixLinks.test.ts.
// =============================================================
'use strict';

/** The id pattern queueLogic.validate uses for task ids. */
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/;

/**
 * The field as a list: a string becomes [id], a list is kept (duplicates removed, order kept). undefined when the field
 * is absent; null or an empty list gives [] (the caller removes the field).
 */
function fixesList(value) {
  if (value === undefined) return undefined;
  if (value == null) return [];
  const list = Array.isArray(value) ? value : [value];
  return [...new Set(list)];
}

/** Shape errors only (for queueLogic.validate): an id or a list of ids. Existence is checked by fixesError. */
function fixesShapeError(o) {
  const v = o?.fixes;
  if (v == null) return [];
  const list = Array.isArray(v) ? v : [v];
  if (list.some((x) => typeof x !== 'string' || !ID.test(x)))
    return ['fixes must be a task id or a list of task ids (the task(s) this one fixes)'];
  return [];
}

/**
 * The full check for add and edit: shape, the task does not fix itself, and every id exists in `knownIds` (the queue's
 * task ids, plus the ids added in the same write).
 * @param {object} o the task as it will be
 * @param {Iterable<string>} knownIds
 * @returns {string[]} errors (empty = valid)
 */
function fixesError(o, knownIds) {
  const shape = fixesShapeError(o);
  if (shape.length) return shape;
  const list = fixesList(o?.fixes) ?? [];
  const known = new Set(knownIds);
  const error = [];
  if (list.includes(o?.id)) error.push(`fixes cannot name the task itself (${o.id})`);
  const unknown = list.filter((x) => x !== o?.id && !known.has(x));
  if (unknown.length)
    error.push(`fixes names unknown task(s) ${unknown.join(', ')} (the id(s) must exist in the queue)`);
  return error;
}

/** The fix tasks that name `id` in `fixes`: their ids, in queue order. */
function fixedBy(id, tasks = []) {
  return tasks.filter((t) => (fixesList(t?.fixes) ?? []).includes(id)).map((t) => t.id);
}

/**
 * The open fix links for `cq state`: every task that is not done or cancelled and has `fixes`, as
 * { id, status, fixes }. Done fix tasks are left out so the list stays short; the queue file keeps them all.
 */
function openFixLinks(tasks = []) {
  return tasks
    .filter((t) => !['done', 'cancelled'].includes(t?.status))
    .map((t) => ({ t, list: fixesList(t?.fixes) ?? [] }))
    .filter((x) => x.list.length)
    .map(({ t, list }) => ({ id: t.id, status: t.status ?? null, fixes: list }));
}

module.exports = { fixesList, fixesShapeError, fixesError, fixedBy, openFixLinks };
