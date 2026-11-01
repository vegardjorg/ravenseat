// =============================================================
// logic/projects.js: project and feature of a task, the project register, and the fast index.
//
// projectFor (explicit field or the longest prefix in the register), pause, labels, the agent counter, the project order
// and groups, projectOverview and newRegister. The fast index (withIndex, indexFor) lives here too, because projectFor
// reads it and withIndex sets it: the module-level variable fastIndex must stay in one module with both.
//
// Part of the queueLogic.js split: lib/queueLogic.js re-exports every name, so callers keep requiring queueLogic.js.
// Used by queueLogic.js (the facade) and by logic/evidence.js, conflicts.js, ranking.js, guards.js, batch.js, edit.js,
// focus.js, select.js, pick.js, external.js, cloud.js.
// Tested in lib/__tests__/queueProjectPick.test.ts, queueBulk.test.ts and queueBoardState.test.ts (through
// queueLogic.js).
// =============================================================

const { WITHOUT_PROJECT, WITHOUT_FEATURE, PID_PATTERN, estimate, isExternalRow } = require('./base.js');

/** The fast index while queueLogic.withIndex runs (see "The fast index" below), otherwise null. Declared here, before first use. */
let fastIndex = null;

// ---- Project and feature -----------------------------------------------------------------------------

/**
 * The project a task belongs to: explicit `project`, otherwise the project with the LONGEST prefix in the register that
 * matches the start of the id (on equal length the first in the register wins), otherwise `without-project`.
 * The prefixes are data in the register, never hardcoded here.
 */
function projectFor(o, register) {
  if (typeof o?.project === 'string' && o.project) return o.project;
  // Inside withIndex each id is looked up once per register (the board asks many times per card).
  const ix = fastIndex;
  if (ix && register && typeof register === 'object') {
    ix.project ??= new WeakMap();
    let perId = ix.project.get(register);
    if (!perId) ix.project.set(register, (perId = new Map()));
    const id = String(o?.id ?? '');
    if (!perId.has(id)) perId.set(id, longestPrefix(id, register)?.pid ?? WITHOUT_PROJECT);
    return perId.get(id);
  }
  return longestPrefix(o?.id, register)?.pid ?? WITHOUT_PROJECT;
}

/**
 * The longest prefix in the register that matches the start of the id: { pid, prefix } or null. On equal length in two
 * projects the first in the register wins (as before), and `also` lists the others.
 */
function longestPrefix(id, register) {
  const s = String(id ?? '');
  let best = null;
  for (const [pid, p] of Object.entries(register ?? {})) {
    const prefixes = Array.isArray(p?.prefixes) ? p.prefixes : [];
    for (const pre of prefixes) {
      if (typeof pre !== 'string' || !pre || !s.startsWith(pre)) continue;
      if (!best || pre.length > best.prefix.length) best = { pid, prefix: pre, also: [] };
      else if (pre.length === best.prefix.length && pid !== best.pid && !best.also.includes(pid))
        best.also.push(pid);
    }
  }
  return best;
}

/** Is the project the task belongs to paused? Then the queue does not start it (next/start without --force). */
function projectPaused(o, register) {
  return register?.[projectFor(o, register)]?.pause === true;
}

/** Does the task have the label? */
function hasLabel(o, label) {
  return Array.isArray(o?.labels) && o.labels.includes(label);
}

/**
 * Does the task count toward the queue's agent slots (maxConcurrent, maxDPlus)? Running and review do, but not a task
 * that a person or session has picked, not even after it is delivered to review (it still has `picked_by`).
 */
function counterAsAgent(o) {
  return (o.status === 'running' || o.status === 'review') && !o.picked_by;
}

/** The order projects are shown in: the register's order, then unknown alphabetically, `without-project` last. */
function projectOrder(pids, register) {
  const inRegister = Object.keys(register ?? {});
  const others = [...pids]
    .filter((p) => !inRegister.includes(p) && p !== WITHOUT_PROJECT)
    .sort((x, y) => x.localeCompare(y, 'en'));
  return [
    ...inRegister.filter((p) => pids.has(p)),
    ...others,
    ...(pids.has(WITHOUT_PROJECT) ? [WITHOUT_PROJECT] : []),
  ];
}

/**
 * Groups tasks project → feature (the order within a feature is the one the caller gave). For `show --grouped`
 * and the QA list. Returns [{ pid, title, pause, features: [{ feature, tasks }] }].
 */
function groups(tasks, register) {
  const perProject = new Map();
  for (const o of tasks) {
    const pid = projectFor(o, register);
    if (!perProject.has(pid)) perProject.set(pid, new Map());
    const f =
      typeof o.feature === 'string' && o.feature.trim() ? o.feature.trim() : WITHOUT_FEATURE;
    const perFeature = perProject.get(pid);
    if (!perFeature.has(f)) perFeature.set(f, []);
    perFeature.get(f).push(o);
  }
  return projectOrder(new Set(perProject.keys()), register).map((pid) => {
    const perFeature = perProject.get(pid);
    const features = [...perFeature.keys()].sort((x, y) =>
      x === WITHOUT_FEATURE ? 1 : y === WITHOUT_FEATURE ? -1 : x.localeCompare(y, 'en'),
    );
    return {
      pid,
      title: register?.[pid]?.title ?? null,
      pause: register?.[pid]?.pause === true,
      features: features.map((f) => ({ feature: f, tasks: perFeature.get(f) })),
    };
  });
}

/**
 * Overview per project for `queue.mjs projects`: done/total (without cancelled and proposed), minutes left
 * (estimate for what is not done), active ones (running/review), picked, waiting, in the QA list, and the owner questions that
 * block most tasks in the project.
 */
function projectOverview(queue) {
  const register = queue.projects ?? {};
  const resolved = new Set(queue.resolved ?? []);
  const rows = new Map();
  const row = (pid) => {
    if (!rows.has(pid)) {
      const p = register[pid] ?? {};
      rows.set(pid, {
        pid,
        title: p.title ?? null,
        plan: p.plan ?? null,
        pause: p.pause === true,
        priority_bonus: Number(p.priority_bonus) || 0,
        in_register: Object.hasOwn(register, pid),
        total: 0,
        done: 0,
        min_left: 0,
        activeOnes: 0,
        picked: 0,
        waiting: 0,
        proposed: 0,
        qa: 0,
        sp: new Map(),
      });
    }
    return rows.get(pid);
  };
  for (const pid of Object.keys(register)) row(pid);
  // Records outside the queue (external add) are not work in any project.
  for (const o of (queue.tasks ?? []).filter((x) => !isExternalRow(x))) {
    const r = row(projectFor(o, register));
    if (o.status === 'cancelled') continue;
    if (o.status === 'proposed') {
      r.proposed += 1;
      continue;
    }
    r.total += 1;
    if (o.status === 'done') {
      r.done += 1;
      if (o.qa_status === 'waiting') r.qa += 1;
      continue;
    }
    r.min_left += estimate(o);
    if (o.status === 'running' || o.status === 'review') r.activeOnes += 1;
    else if (o.status === 'picked') r.picked += 1;
    else if (o.status === 'waiting') {
      r.waiting += 1;
      for (const sp of o.waiting_on ?? []) {
        if (!resolved.has(sp)) r.sp.set(sp, (r.sp.get(sp) ?? 0) + 1);
      }
    }
  }
  return projectOrder(new Set(rows.keys()), register).map((pid) => {
    const { sp, ...r } = rows.get(pid);
    return {
      ...r,
      ownerQuestion: [...sp.entries()]
        .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
        .map(([s, n]) => ({ sp: s, tasks: n })),
    };
  });
}

/** The fields a project in the register can have. */
const PROJECT_FIELD = new Set([
  'title',
  'plan',
  'prefixes',
  'pause',
  'priority_bonus',
  'area',
  // File roots (signal for classify) and known feature names.
  'fileRoot',
  'features',
  // 'plan' = the project exists in the plan register, but has no queue tasks yet (docs/plan-register.md).
  'phase',
]);

/**
 * Validates and applies changes to the project register: { <pid>: { title?, plan?, prefixes?, pause?,
 * priority_bonus? } }. A new project requires title. `null` removes an optional field. Returns a NEW
 * register (the old one is not changed) and the error list; the caller uses the register only when the error list is empty.
 */
function newRegister(register, changes, areas = {}) {
  const error = [];
  const fresh = { ...(register ?? {}) };
  if (changes == null) return { register: fresh, error };
  if (typeof changes !== 'object' || Array.isArray(changes))
    return { register: fresh, error: ['projects must be an object { <pid>: { title, … } }'] };
  for (const [pid, field] of Object.entries(changes)) {
    if (!PID_PATTERN.test(pid) || pid === WITHOUT_PROJECT) {
      error.push(`project id ${pid} must be short kebab-case (and not ${WITHOUT_PROJECT})`);
      continue;
    }
    if (!field || typeof field !== 'object' || Array.isArray(field)) {
      error.push(`${pid}: must be an object`);
      continue;
    }
    const unknown = Object.keys(field).filter((k) => !PROJECT_FIELD.has(k));
    if (unknown.length)
      error.push(
        `${pid}: unknown field ${unknown.join(', ')} (allowed: ${[...PROJECT_FIELD].join(', ')})`,
      );
    const p = { ...(fresh[pid] ?? {}) };
    for (const [k, v] of Object.entries(field)) {
      if (!PROJECT_FIELD.has(k)) continue;
      if (v === null) delete p[k];
      else p[k] = v;
    }
    if (typeof p.title !== 'string' || !p.title.trim()) error.push(`${pid}: title missing`);
    if (p.plan != null && typeof p.plan !== 'string')
      error.push(`${pid}: plan must be a text (path)`);
    if (
      p.prefixes != null &&
      (!Array.isArray(p.prefixes) ||
        p.prefixes.some((x) => typeof x !== 'string' || !x || /\s/.test(x)))
    )
      error.push(`${pid}: prefixes must be a list of non-empty prefixes without whitespace`);
    if (p.pause != null && typeof p.pause !== 'boolean')
      error.push(`${pid}: pause must be true/false`);
    if (p.priority_bonus != null && !Number.isFinite(p.priority_bonus))
      error.push(`${pid}: priority_bonus must be a number`);
    // File root = folders/files (paths, not patterns), features = known feature names.
    if (
      p.fileRoot != null &&
      (!Array.isArray(p.fileRoot) ||
        p.fileRoot.some((x) => typeof x !== 'string' || !x.trim() || /\s/.test(x) || /[*?]/.test(x)))
    )
      error.push(`${pid}: fileRoot must be a list of paths without whitespace and wildcards`);
    if (
      p.features != null &&
      (!Array.isArray(p.features) ||
        p.features.some((x) => typeof x !== 'string' || !x.trim() || x.length > 80))
    )
      error.push(`${pid}: features must be a list of short names`);
    if (p.phase != null && p.phase !== 'plan')
      error.push(`${pid}: phase must be plan (or be removed with null)`);
    // Area must exist in the area register when the change sets it.
    if ('area' in field && field.area != null) {
      if (typeof field.area !== 'string' || !PID_PATTERN.test(field.area))
        error.push(`${pid}: area must be a short kebab-case id`);
      else if (!Object.hasOwn(areas ?? {}, field.area))
        error.push(
          `${pid}: unknown area ${field.area} (create it first: cq area ${field.area} --title "…")`,
        );
    }
    fresh[pid] = p;
  }
  return { register: fresh, error };
}

// ---- The fast index ------------------------------------------------------------------------------------------------
// blockerParts, successors and score were called once per card, and each call built the lookups for the WHOLE queue
// again (the id map, the active ones, childrenMap and the transitive successor list). With 3 000 tasks the board was
// then quadratic (close to a minute). withIndex(tasks, fn) lets fn use lookups that are built ONCE and reused, but only
// for exactly this task list and only while fn runs: outside (and for another list) everything is built again as
// before, so a mutation of the queue (queue.mjs changes status, depends_on …) can never meet a stale lookup. The
// requirement on fn is therefore that it does not change the tasks (the list, status or depends_on) or the project
// register while it runs; the board and the views only read. (The variable fastIndex is declared at the top, before
// projectFor.)

/**
 * Run fn with the fast index for `tasks` (see above). Nested calls reuse the outer index. Synchronous fn only.
 * @template T
 * @param {object[]} tasks
 * @param {() => T} fn
 * @returns {T}
 */
function withIndex(tasks, fn) {
  if (fastIndex) return fn();
  fastIndex = {
    tasks,
    perId: null,
    active: null,
    children: null,
    after: new Map(),
    project: null,
    conflicts: null,
  };
  try {
    return fn();
  } finally {
    fastIndex = null;
  }
}
/** The index when it applies to exactly this list, otherwise null. */
function indexFor(tasks) {
  return fastIndex && fastIndex.tasks === tasks ? fastIndex : null;
}

module.exports = {
  projectFor,
  longestPrefix,
  projectPaused,
  hasLabel,
  counterAsAgent,
  projectOrder,
  groups,
  projectOverview,
  newRegister,
  withIndex,
  indexFor,
};
