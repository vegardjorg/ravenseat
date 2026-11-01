// =============================================================
// logic/focus.js: writing the focus period, evaluating done focus stages, and areas and parking.
//
// setFocus, removeFocus, saveFocusPlan and focusStatus; evaluateFocusStep, focusWithoutDone, cleanFocus and the rest
// texts (done stages are evaluated and taken out); setArea, areaOverview, park and proceed (`continue`). How the focus
// changes the order lives in logic/ranking.js.
//
// Part of the queueLogic.js split: lib/queueLogic.js re-exports every name, so callers keep requiring queueLogic.js.
// Used by queueLogic.js (the facade) and by logic/select.js.
// Tested in lib/__tests__/queueFocus.test.ts and queueBoardPlan.test.ts (through queueLogic.js).
// =============================================================

const { PID_PATTERN, estimate, utcText, isExternalRow, isBatched, openTask, openQuestion } = require('./base.js');
const { projectFor, projectPaused, projectOverview, withIndex } = require('./projects.js');
const { blockerParts, blockers } = require('./conflicts.js');
const {
  WITHOUT_AREA, FOCUS_REST, FOCUS_MAX_TEXT, areaFor, parseStep, stepMatch, ownStep, parkedNow, rankingContext,
  focusSpace, parseToDate, stepTitle, focusText,
} = require('./ranking.js');
const { cloneJson, equalValue, logChange } = require('./edit.js');

/**
 * Sets the focus (queue.mjs focus set). input: { order: [stage], rest?, to?, name?, drag_with_dependencies?, set_by? }.
 * Everything is validated before anything is changed. Warnings (not errors): stages without open tasks, paused projects in a stage, and
 * a focus that gives zero ready tasks now. Changes `queue` only when the error list is empty.
 * @returns {{ error: string[], warnings: string[], focus?: object }}
 */
function setFocus(queue, input, now = new Date().toISOString()) {
  const error = [];
  const warnings = [];
  const nowMs = Date.parse(now);
  const raw = Array.isArray(input?.order) ? input.order : [];
  if (!raw.length)
    error.push(
      'focus needs at least one stage (area:<oid>, project:<pid> or feature:<pid>/<name>)',
    );
  const order = [];
  for (const t of raw) {
    const r = parseStep(t, queue);
    if ('error' in r) error.push(r.error);
    else if (order.includes(r.stage)) error.push(`${r.stage} appears more than once`);
    else order.push(r.stage);
  }
  const rest = input?.rest ?? 'wait';
  if (!FOCUS_REST.includes(rest)) error.push(`rest must be ${FOCUS_REST.join(' or ')}`);
  let to = null;
  if (input?.to != null && input.to !== '') {
    to = parseToDate(input.to);
    if (!to) error.push(`invalid date ${input.to} (use YYYY-MM-DD or ISO time)`);
    else if (Date.parse(to) <= nowMs) error.push(`end date ${input.to} has passed`);
  }
  const name = input?.name == null ? null : String(input.name).trim();
  if (name != null && name.length > FOCUS_MAX_TEXT)
    error.push(`name can be at most ${FOCUS_MAX_TEXT} characters`);
  if (input?.drag_with_dependencies != null && typeof input.drag_with_dependencies !== 'boolean')
    error.push('drag_with_dependencies must be true/false');
  // How many of the stages the plan view shows in "Now" (the rest of the stages sit in "Next"). View only;
  // the order is the same. If the field is missing, "Now" is the first stage.
  const nowCount = input?.now_count == null ? null : Number(input.now_count);
  if (
    nowCount != null &&
    (!Number.isInteger(nowCount) || nowCount < 1 || nowCount > Math.max(order.length, 1))
  )
    error.push(`now_count must be an integer from 1 to ${Math.max(order.length, 1)}`);
  if (error.length) return { error, warnings };

  const focus = {
    ...(name ? { name } : {}),
    from: now,
    to,
    order,
    ...(nowCount != null ? { now_count: nowCount } : {}),
    rest,
    drag_with_dependencies: input?.drag_with_dependencies !== false,
    ...(input?.set_by ? { set_by: String(input.set_by).slice(0, FOCUS_MAX_TEXT) } : {}),
    // The history of stages taken out (cleanFocus) is carried over when the focus is set again.
    ...(Array.isArray(queue.focus?.history) && queue.focus.history.length
      ? { history: queue.focus.history }
      : {}),
  };
  // The warnings are computed on a copy with the new focus, so the queue is not changed before everything is ready.
  const trial = { ...queue, focus };
  const register = queue.projects ?? {};
  const opened = (queue.tasks ?? []).filter(
    (o) => openTask(o) && o.status !== 'proposed' && !isExternalRow(o),
  );
  order.forEach((t, i) => {
    const match = opened.filter((o) => stepMatch(o, t, trial) > 0);
    if (!match.length) warnings.push(`stage ${i + 1} (${t}) has no open tasks`);
    const pausedOnes = [
      ...new Set(
        match.filter((o) => projectPaused(o, register)).map((o) => projectFor(o, register)),
      ),
    ];
    for (const pid of pausedOnes)
      warnings.push(`the project ${pid} in stage ${i + 1} is paused (pause takes precedence over focus)`);
  });
  const status = focusStatus(trial, { now: nowMs });
  if (status.active && status.readyOnes === 0)
    warnings.push('the focus gives no ready tasks now (see cq focus)');
  queue.focus = focus;
  return { error: [], warnings, focus };
}

/** Removes the focus (queue.mjs focus off). Returns the old one, or null. */
function removeFocus(queue) {
  const oldOne = queue.focus ?? null;
  delete queue.focus;
  return oldOne;
}

/** At most this many stages and pause changes in one plan from the board. */
const FOCUS_PLAN_MAX = 50;

/**
 * Saves the plan view from the board (queue.mjs focus save) in ONE change, all or nothing:
 *   - focus: { order, now_count?, rest?, to?, name?, drag_with_dependencies?, set_by? } like setFocus;
 *     empty order = the focus is removed (like focus off);
 *   - the "Waiting" column in the plan: `pause` (projects that are paused) and `continue` (taken off pause).
 * The pause changes are made before the focus is checked, so the warnings (paused projects in a stage, no ready ones) apply to the queue
 * as it will be. Changes `queue` only when the error list is empty.
 * @returns {{ error: string[], warnings: string[], focus?: object|null, removed?: boolean, paused?: string[],
 *   still?: string[] }}
 */
function saveFocusPlan(queue, input, now = new Date().toISOString()) {
  const error = [];
  const order = Array.isArray(input?.order) ? input.order : null;
  if (!order) error.push('order must be a list (empty = no focus)');
  const pause = Array.isArray(input?.pause) ? [...new Set(input.pause.map(String))] : [];
  const proceed = Array.isArray(input?.continue) ? [...new Set(input.continue.map(String))] : [];
  if (
    (order?.length ?? 0) > FOCUS_PLAN_MAX ||
    pause.length + proceed.length > FOCUS_PLAN_MAX
  )
    error.push(`at most ${FOCUS_PLAN_MAX} stages and ${FOCUS_PLAN_MAX} pause changes`);
  const register = { ...(queue.projects ?? {}) };
  for (const pid of [...pause, ...proceed])
    if (!Object.hasOwn(register, pid))
      error.push(`unknown project ${pid} (only projects in the register can be paused)`);
  const both = pause.filter((pid) => proceed.includes(pid));
  if (both.length) error.push(`${both.join(', ')} appears in both pause and continue`);
  if (error.length) return { error, warnings: [] };

  const paused = [];
  const still = [];
  for (const pid of pause) {
    if (register[pid].pause === true) continue;
    register[pid] = { ...register[pid], pause: true };
    paused.push(pid);
  }
  for (const pid of proceed) {
    if (register[pid].pause !== true) continue;
    const p = { ...register[pid] };
    delete p.pause;
    register[pid] = p;
    still.push(pid);
  }
  // The trial: the same queue with the new register, so the warnings are computed on the queue as it will be.
  const trial = { ...queue, projects: register };
  let focus = null;
  let warnings = [];
  if (order.length) {
    const s = setFocus(trial, input, now);
    if (s.error.length) return { error: s.error, warnings: s.warnings };
    focus = s.focus;
    warnings = s.warnings;
  }
  const removed = !order.length && !!queue.focus;
  if (paused.length || still.length) queue.projects = register;
  if (focus) queue.focus = focus;
  else delete queue.focus;
  return { error: [], warnings, focus, removed, paused, still };
}

/**
 * Focus status for `focus`, `state` and `show`: what is in focus, what is ready, how many are pulled along,
 * and the warning when the period is over or the focus has nothing ready (with notice).
 * null when no focus is set.
 * @param {{ now?: number, canStart?: string[], context?: object }} [option]
 */
function focusStatus(queue, { now = Date.now(), canStart = null, context = null } = {}) {
  if (!queue?.focus) return null;
  const k = context ?? rankingContext(queue, now);
  const f = queue.focus;
  const name = f.name ? ` "${f.name}"` : '';
  const tasks = (queue.tasks ?? []).filter((o) => !isExternalRow(o));
  const out = {
    name: f.name ?? null,
    text: focusText(queue),
    order: f.order ?? [],
    rest: f.rest === 'fill' ? 'fill' : 'wait',
    to: f.to ?? null,
    active: k.applies,
    expired: k.expired,
    not_started: k.notStarted,
    in_focus: 0,
    readyOnes: 0,
    inProgress: 0,
    can_start: 0,
    dragged_with: k.dragged.size,
    per_step: (f.order ?? []).map((t) => ({ stage: t, waiting: 0, readyOnes: 0, min_left: 0 })),
    ownerQuestion: [],
    notice: null,
  };
  if (k.expired) {
    out.notice =
      `Focus period${name} is over (until ${utcText(f.to)}). The queue is ranked as without focus until it is changed: ` +
      'cq focus set … or cq focus off.';
    return out;
  }
  if (!k.applies) return out;
  const can = new Set(canStart ?? []);
  const sp = new Map();
  for (const o of tasks) {
    const p = focusSpace(o, k);
    if (p.step == null) continue;
    if (['running', 'review', 'picked'].includes(o.status)) {
      out.inProgress += 1;
      continue;
    }
    if (o.status !== 'waiting' || isBatched(o) || p.parked || p.paused) continue;
    const row = out.per_step[p.step];
    out.in_focus += 1;
    row.waiting += 1;
    row.min_left += estimate(o);
    if (blockers(o, queue.tasks ?? [], queue.resolved).length === 0) {
      out.readyOnes += 1;
      row.readyOnes += 1;
    }
    if (can.has(o.id)) out.can_start += 1;
    for (const s of openQuestion(o, queue.resolved)) sp.set(s, (sp.get(s) ?? 0) + 1);
  }
  out.ownerQuestion = [...sp.entries()]
    .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
    .map(([s, n]) => ({ sp: s, tasks: n }));
  if (out.readyOnes === 0) {
    const first = out.ownerQuestion[0];
    const answer = first
      ? ` Answering ${first.sp} unlocks ${first.tasks} task(s) in focus.`
      : '';
    const rest =
      out.rest === 'wait'
        ? ' The rest waits, so free slots stay empty until the focus has ready work or is changed (cq focus).'
        : ' The rest fills free slots (rest: fill).';
    out.notice =
      out.in_focus === 0 && out.inProgress === 0
        ? `Focus${name} is empty: nothing left in the stages.${rest}`
        : `Nothing ready in focus${name}${out.inProgress ? ` (${out.inProgress} in progress)` : ''}.${answer}${rest}`;
  }
  return out;
}

// ---- Done focus stages are evaluated and taken out ------------------------------------------------------------------
//
// The focus should only show stages that still have tasks in them. A stage is evaluated (evaluateFocusStep) to:
//   active           open tasks: waiting (also parked and paused ones), running, picked, review;
//   done-with-rests  0 open, but rests: batch queue tasks, proposals, tasks that ONLY wait on owner questions, and
//                    done tasks with QA still waiting on the owner. Each rest gets a suggestion, and the stage stays
//                    until they are settled;
//   done             0 open and 0 rests (also a stage that never had anything).
// cleanFocus takes out the stages with status done, records it in focus.history and in the changelog (changes with
// `focus: true`, undone with queue.mjs undo). The last stage is never taken out by itself: a focus without stages
// means "no focus" (everything in the queue can start), and that choice belongs to the owner (focus set … or focus off).
// Runs from queue.mjs focus clean, and automatically in receive, set <id> done|cancelled and fill. The board shows
// the queue as if the cleaning was done (focusWithoutDone), so done stages are never shown.

/** At most this many entries in focus.history (the oldest fall out). */
const FOCUS_HISTORY_MAX = 50;
/** The statuses that are open work in a stage (waiting is counted separately, see evaluateFocusStep). */
const FOCUS_OPEN_ACTIVE = new Set(['running', 'picked', 'review']);

/** The suggestion for what to do with a rest. */
function restSuggestion(type, o, sp = []) {
  if (type === 'batched')
    return `pack the batch queue (cq batch pack ${o.id} … --id <new-id>, or cq batch pack --auto)`;
  if (type === 'proposed')
    return `ask the owner for a yes on the proposal (cq approve ${o.id}), otherwise cancel it`;
  if (type === 'question') return `owner question ${sp.join(', ')} unlocks it`;
  return 'QA with the owner (cq qa)';
}

/**
 * Evaluates each focus stage. A task belongs to the stage it is dragged into, otherwise its own (the most specific,
 * ownStep). Pure function; changes nothing.
 * @returns {{ index: number, stage: string, title: string, open: number, ready: number, min_left: number,
 *   rests: { type: 'batched'|'proposed'|'question'|'qa', id: string, title: string|null, sp?: string[],
 *   suggestion: string }[], status: 'active'|'done-with-rests'|'done' }[]}
 */
function evaluateFocusStep(queue, now = Date.now()) {
  const order = queue?.focus?.order ?? [];
  const out = order.map((t, i) => ({
    index: i,
    stage: t,
    title: stepTitle(t, queue),
    open: 0,
    ready: 0,
    min_left: 0,
    rests: [],
    status: 'done',
  }));
  if (!out.length) return out;
  const tasks = queue.tasks ?? [];
  const k = rankingContext(queue, now);
  return withIndex(tasks, () => {
    for (const o of tasks) {
      if (!o || isExternalRow(o) || o.status === 'cancelled') continue;
      if (o.status === 'done' && o.qa_status !== 'waiting') continue;
      const step = k.dragged.get(o.id)?.stage ?? ownStep(o, queue);
      if (step == null) continue;
      const row = out[step];
      const rest = (type, sp) =>
        row.rests.push({
          type,
          id: o.id,
          title: o.title ?? null,
          ...(sp ? { sp } : {}),
          suggestion: restSuggestion(type, o, sp ?? []),
        });
      if (o.status === 'done') rest('qa');
      else if (o.status === 'proposed') rest('proposed');
      else if (o.status === 'waiting' && isBatched(o)) rest('batched');
      else if (o.status === 'waiting') {
        const h = blockerParts(o, tasks, queue.resolved);
        if (h.length && h.every((x) => x.type === 'question'))
          rest(
            'question',
            h.map((x) => x.sp),
          );
        else {
          row.open += 1;
          row.min_left += estimate(o);
          if (!h.length) row.ready += 1;
        }
      } else if (FOCUS_OPEN_ACTIVE.has(o.status)) row.open += 1;
    }
    for (const row of out)
      row.status = row.open ? 'active' : row.rests.length ? 'done-with-rests' : 'done';
    return out;
  });
}

/**
 * The focus without the stages with status done (pure; does not change `queue`). The first stage is kept when all
 * are done (see the top of the section). `now_count` (the plan view's "Now") is lowered by the stages taken out in
 * front of the limit.
 * @returns {{ evaluation: object[], focus: object|null, taken_out: object[], kept: object|null }} focus = null when
 *   nothing is taken out
 */
function focusWithoutDone(queue, now = Date.now()) {
  const evaluation = evaluateFocusStep(queue, now);
  const done = evaluation.filter((t) => t.status === 'done');
  let kept = null;
  let out = done;
  if (done.length && done.length === evaluation.length) {
    kept = done[0];
    out = done.slice(1);
  }
  if (!out.length) return { evaluation, focus: null, taken_out: [], kept };
  const gone = new Set(out.map((t) => t.index));
  const f = queue.focus;
  const focus = { ...f, order: f.order.filter((_, i) => !gone.has(i)) };
  if (f.now_count != null) {
    const before = out.filter((t) => t.index < f.now_count).length;
    focus.now_count = Math.min(Math.max(f.now_count - before, 1), focus.order.length);
  }
  return { evaluation, focus, taken_out: out, kept };
}

/**
 * Takes out the done focus stages (queue.mjs focus clean, and automatically in receive, set and fill). Each removal
 * is recorded in focus.history ({ at, by, action: 'taken out', stage, title }) and as one entry in the changelog, so
 * queue.mjs undo works. `dry` computes without changing anything.
 * @returns {{ evaluation: object[], taken_out: { stage: string, title: string }[], with_rests: object[],
 *   kept: object|null, changes: object[], entry: object|null }}
 */
function cleanFocus(queue, { by = null, now = new Date().toISOString(), dry = false } = {}) {
  const empty = {
    evaluation: [],
    taken_out: [],
    with_rests: [],
    kept: null,
    changes: [],
    entry: null,
  };
  if (!queue?.focus?.order?.length) return empty;
  const r = focusWithoutDone(queue, Date.parse(now));
  const answer = {
    evaluation: r.evaluation,
    taken_out: r.taken_out.map((t) => ({ stage: t.stage, title: t.title })),
    with_rests: r.evaluation.filter((t) => t.status === 'done-with-rests'),
    kept: r.kept,
    changes: [],
    entry: null,
  };
  if (!r.focus) return answer;
  const who = String(by ?? '').trim() || 'unknown';
  const history = [
    ...(Array.isArray(queue.focus.history) ? queue.focus.history : []),
    ...answer.taken_out.map((t) => ({ at: now, by: who, action: 'taken out', ...t })),
  ].slice(-FOCUS_HISTORY_MAX);
  const after = { ...r.focus, history };
  for (const field of ['order', 'now_count', 'history'])
    if (!equalValue(queue.focus[field], after[field]))
      answer.changes.push({
        focus: true,
        field,
        before: cloneJson(queue.focus[field] ?? null),
        after: cloneJson(after[field] ?? null),
      });
  if (dry) return answer;
  queue.focus = after;
  answer.entry = logChange(queue, { by: who, action: 'focus clean', changes: answer.changes, now });
  return answer;
}

/** One rest in plain text: "SEC-1 proposed → ask the owner for a yes …". */
function restText(r) {
  return `${r.id} ${r.type}${r.sp ? ` (${r.sp.join(', ')})` : ''} → ${r.suggestion}`;
}

/** The suggestion per rest type in the short line (the one per rest is in focus evaluate). */
const REST_GROUP_SUGGESTION = {
  batched: 'pack the batch queue (cq batch pack --auto)',
  proposed: 'ask the owner for a yes (cq approve <id>) or cancel',
  question: 'the answer unlocks it',
  qa: 'QA with the owner (cq qa)',
};

/** The rests grouped per type, short: "proposed 2 (SEC-1, SEC-2) → ask …; qa 1 (SK-2) → QA with the owner". */
function restGroupText(rests, maxId = 4) {
  const groups = new Map();
  for (const r of rests ?? []) {
    if (!groups.has(r.type)) groups.set(r.type, []);
    groups.get(r.type).push(r.sp ? `${r.id}: ${r.sp.join(', ')}` : r.id);
  }
  return [...groups]
    .map(([type, ids]) => {
      const show = ids.slice(0, maxId).join(', ');
      const more = ids.length > maxId ? `, +${ids.length - maxId}` : '';
      return `${type} ${ids.length} (${show}${more}) → ${REST_GROUP_SUGGESTION[type] ?? '?'}`;
    })
    .join('; ');
}

/**
 * The lines after a cleaning (queue.mjs focus clean and the automatic one in receive, set and fill): one per stage
 * taken out, one per stage that is done with rests (the rests and suggestions; the orchestrator puts them to the owner
 * at the end of the round), and one when the last stage is done and stays.
 */
function focusCleanLines(r) {
  const lines = [];
  const tnr = new Map((r?.evaluation ?? []).map((t) => [t.stage, t.index + 1]));
  for (const t of r?.taken_out ?? [])
    lines.push(
      `Focus stage T${tnr.get(t.stage) ?? '?'} ${t.title} (${t.stage}) done and taken out (undo: cq undo)`,
    );
  for (const t of r?.with_rests ?? [])
    lines.push(
      `Focus stage T${t.index + 1} ${t.title} done with rests (${t.rests.length}): ` +
        `${restGroupText(t.rests)}. Details: cq focus evaluate`,
    );
  if (r?.kept)
    lines.push(
      `Focus stage T${r.kept.index + 1} ${r.kept.title} is done, and all stages are done: set a new focus ` +
        '(cq focus set …) or cq focus off.',
    );
  return lines;
}

/**
 * Creates, changes or deletes an area (queue.mjs area). field: { title?, description?, projects?: [pid],
 * remove?: [pid], delete?: true }. `projects` sets the projects' `area` (a project belongs to one area, so it
 * is moved from another). Deletion is refused when a project or the focus uses the area. All or nothing.
 * @returns {{ error: string[], new?: boolean, deleted?: boolean, area?: object, moved?: string[], removed?: string[] }}
 */
function setArea(queue, oid, field = {}) {
  const error = [];
  if (!PID_PATTERN.test(String(oid ?? '')) || oid === WITHOUT_AREA)
    return { error: [`area id ${oid} must be short kebab-case (and not ${WITHOUT_AREA})`] };
  const areas = { ...(queue.areas ?? {}) };
  const register = { ...(queue.projects ?? {}) };
  const exists = Object.hasOwn(areas, oid);
  if (field.delete) {
    if (!exists) return { error: [`unknown area ${oid}`] };
    const users = Object.entries(register)
      .filter(([, p]) => p?.area === oid)
      .map(([pid]) => pid);
    if (users.length)
      error.push(
        `${oid} is used by ${users.join(', ')} (move them first: cq area ${oid} --remove …)`,
      );
    if ((queue.focus?.order ?? []).includes(`area:${oid}`))
      error.push(`${oid} is in the focus (edit the focus first: cq focus set … or focus off)`);
    if (error.length) return { error };
    delete areas[oid];
    queue.areas = areas;
    return { error: [], deleted: true };
  }
  const o = { ...(areas[oid] ?? {}) };
  if (field.title != null) o.title = String(field.title).trim();
  if (field.description === null) delete o.description;
  else if (field.description != null) o.description = String(field.description).trim();
  if (typeof o.title !== 'string' || !o.title) error.push(`${oid}: title missing (--title "…")`);
  else if (o.title.length > FOCUS_MAX_TEXT) error.push(`${oid}: the title is too long`);
  const moved = [];
  for (const pid of field.projects ?? []) {
    if (!Object.hasOwn(register, pid)) {
      error.push(`unknown project ${pid}`);
      continue;
    }
    register[pid] = { ...register[pid], area: oid };
    moved.push(pid);
  }
  const removed = [];
  for (const pid of field.remove ?? []) {
    if (register[pid]?.area !== oid) {
      error.push(`${pid} does not belong to ${oid}`);
      continue;
    }
    const p = { ...register[pid] };
    delete p.area;
    register[pid] = p;
    removed.push(pid);
  }
  if (error.length) return { error };
  areas[oid] = o;
  queue.areas = areas;
  if (moved.length || removed.length) queue.projects = register;
  return { error: [], new: !exists, area: o, moved, removed };
}

/**
 * Overview per area for `queue.mjs areas`: projects, pending, ready ones (no blockers now, not parked), minutes
 * left, active ones and parked. The register's order, unknown areas (a project points to an area that does not exist)
 * alphabetically, `without-area` last.
 */
function areaOverview(queue, now = Date.now()) {
  const areas = queue.areas ?? {};
  const tasks = (queue.tasks ?? []).filter((o) => !isExternalRow(o));
  const rows = new Map();
  const row = (oid) => {
    if (!rows.has(oid))
      rows.set(oid, {
        oid,
        title: areas[oid]?.title ?? null,
        description: areas[oid]?.description ?? null,
        in_register: Object.hasOwn(areas, oid),
        projects: [],
        waiting: 0,
        readyOnes: 0,
        parked: 0,
        activeOnes: 0,
        min_left: 0,
      });
    return rows.get(oid);
  };
  for (const oid of Object.keys(areas)) row(oid);
  for (const p of projectOverview(queue)) {
    const oid = areaFor({ project: p.pid }, queue);
    row(oid).projects.push(p.pid);
  }
  for (const o of tasks) {
    if (!openTask(o) || o.status === 'proposed') continue;
    const r = row(areaFor(o, queue));
    r.min_left += estimate(o);
    if (o.status === 'running' || o.status === 'review' || o.status === 'picked') r.activeOnes += 1;
    if (o.status !== 'waiting' || isBatched(o)) continue;
    r.waiting += 1;
    if (parkedNow(o, now)) r.parked += 1;
    else if (blockers(o, queue.tasks ?? [], queue.resolved).length === 0) r.readyOnes += 1;
  }
  const inRegister = Object.keys(areas);
  const unknown = [...rows.keys()]
    .filter((x) => !inRegister.includes(x) && x !== WITHOUT_AREA)
    .sort((x, y) => x.localeCompare(y, 'en'));
  return [...inRegister, ...unknown, ...(rows.has(WITHOUT_AREA) ? [WITHOUT_AREA] : [])].map((oid) =>
    rows.get(oid),
  );
}

/**
 * Parks tasks ("put on hold", queue.mjs park). Only `waiting` and `proposed` can be parked. `to` (YYYY-MM-DD or
 * ISO) must be in the future. Warns when a task is pulled along by something in the focus (then the focus task waits too). All or
 * nothing; a parked task can be parked again (reason and date are updated).
 * @returns {{ error: string[], parked?: string[], warnings?: string[] }}
 */
function park(queue, ids, { by, reason = null, to = null, now = new Date().toISOString() } = {}) {
  const error = [];
  const nowMs = Date.parse(now);
  const list = [...new Set(ids ?? [])];
  if (!list.length) error.push('park <id> …');
  const who = String(by ?? '').trim() || 'unknown';
  const g = reason == null ? null : String(reason).trim();
  if (g && g.length > FOCUS_MAX_TEXT)
    error.push(`the reason can be at most ${FOCUS_MAX_TEXT} characters`);
  let toIso = null;
  if (to != null && to !== '') {
    toIso = parseToDate(to);
    if (!toIso) error.push(`invalid date ${to} (use YYYY-MM-DD or ISO time)`);
    else if (Date.parse(toIso) <= nowMs) error.push(`the date ${to} has passed`);
  }
  const perId = new Map((queue.tasks ?? []).map((o) => [o.id, o]));
  const selected = [];
  for (const id of list) {
    const o = perId.get(id);
    if (!o || isExternalRow(o)) error.push(`unknown task ${id}`);
    else if (o.status !== 'waiting' && o.status !== 'proposed')
      error.push(`${id}: status ${o.status} (only waiting and proposed can be parked)`);
    else selected.push(o);
  }
  if (error.length) return { error };
  const warnings = [];
  const k = rankingContext(queue, nowMs);
  for (const o of selected) {
    const d = k.dragged.get(o.id);
    if (d && !list.includes(d.by))
      warnings.push(
        `${o.id} is pulled along by ${d.by} in the focus (stage ${d.stage + 1}); it waits until ${o.id} continues`,
      );
  }
  for (const o of selected)
    o.parked = {
      by: who,
      at: now,
      ...(g ? { reason: g } : {}),
      ...(toIso ? { to: toIso } : {}),
    };
  return { error: [], parked: selected.map((o) => o.id), warnings };
}

/**
 * Takes tasks off hold (queue.mjs continue). Unknown ids are errors (nothing is changed); one that was not parked is reported.
 * @returns {{ error: string[], still?: string[], notParked?: string[] }}
 */
function proceed(queue, ids) {
  const list = [...new Set(ids ?? [])];
  if (!list.length) return { error: ['continue <id> …'] };
  const perId = new Map((queue.tasks ?? []).map((o) => [o.id, o]));
  const error = list.filter((id) => !perId.has(id)).map((id) => `unknown task ${id}`);
  if (error.length) return { error };
  const still = [];
  const notParked = [];
  for (const id of list) {
    const o = perId.get(id);
    if (o.parked) {
      delete o.parked;
      still.push(id);
    } else notParked.push(id);
  }
  return { error: [], still, notParked };
}

module.exports = {
  setFocus,
  removeFocus,
  FOCUS_PLAN_MAX,
  saveFocusPlan,
  focusStatus,
  evaluateFocusStep,
  focusWithoutDone,
  cleanFocus,
  restText,
  focusCleanLines,
  setArea,
  areaOverview,
  park,
  proceed,
};
