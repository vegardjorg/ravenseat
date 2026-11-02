// =============================================================
// logic/ranking.js: the one ranking: areas, focus period and parking as they affect the order, and the priority score.
//
// Focus steps (parseStep, stepMatch, focusApplies, ownStep, draggedWith, focusSpace), parking (parkedNow, parkedText),
// rankingContext, ranking and compareRanking (used by selectNext, pickable, show and state), the priority (score,
// scoreParts) and blockersWithPause. Writing the focus period lives in logic/focus.js.
//
// Part of the queueLogic.js split: lib/queueLogic.js re-exports every name, so callers keep requiring queueLogic.js.
// Used by queueLogic.js (the facade) and by logic/commits.js, edit.js, focus.js, select.js, pick.js, agents.js.
// Tested in lib/__tests__/queueFocus.test.ts, queueLogic.test.ts and queueProjectPick.test.ts (through queueLogic.js).
// =============================================================

const { cfg, estimate, utcText, isExternalRow, openTask } = require('./base.js');
const { projectFor, projectPaused } = require('./projects.js');
const { blockers, lockUpCount } = require('./conflicts.js');

/**
 * The blockers, with pause first when the project is paused (for `show` and `state`; `start` checks pause itself).
 * A parked task and a task outside the focus (when the rest waits) get that as the first blocker.
 * @param {object} [k] rankingContext(queue, now), when many tasks are looked up
 */
function blockersWithPause(o, queue, k = null) {
  const register = queue.projects ?? {};
  const h = blockers(o, queue.tasks ?? [], queue.resolved);
  if (o.status !== 'waiting') return h;
  const ahead = [];
  if (o.parked && parkedNow(o, k?.now ?? Date.now())) ahead.push(parkedText(o));
  if (projectPaused(o, register)) ahead.push(`the project ${projectFor(o, register)} is paused`);
  if (queue.focus) {
    const p = focusSpace(o, k ?? rankingContext(queue));
    // Outside the focus (rest waiting), or the queue paused because the focus has ended (focusEndText).
    if (!p.parked && !p.paused && p.out) ahead.push(p.reason);
  }
  return [...ahead, ...h];
}

// ---- Areas, focus period and parking -------------------------------------------------------------
//
// Three optional fields in queue.json (docs/queue.md):
//   areas: { <oid>: { title, description? } }   the area register (program parts); the project gets `area`. The list is
//                                                  data, never hardcoded here.
//   focus: { name?, from?, to?, order: [stage], rest: 'wait'|'fill', drag_with_dependencies?, set_by? }
//          A stage is `area:<oid>`, `project:<pid>` or `feature:<pid>/<name>`. Everything in stage 1 comes before everything in
//          stage 2 (regardless of score); within a stage the usual score applies. A more specific stage wins over a less
//          specific one (feature > project > area), so "Widgets now, rest of Platform later" works both ways.
//          `rest: wait` (default) = tasks outside all stages are not started; `fill` = they come last and
//          fill slots the focus does not use. The focus applies until it is changed, with an optional end date `to`; when
//          it has passed, the queue is ranked as without focus and state/show give notice.
//          When every stage is done (focusRanEmpty) or `to` has passed, the focus has ENDED. Then the setting
//          continueWhenEmpty decides (focusContinues): off (the default) = nothing starts, the queue is paused until the
//          owner sets a new focus, turns it off, or answers the owner question (logic/focus.js syncFocusEnd); on = the
//          queue continues as without focus (rest fill keeps filling; an expired one is ranked as without focus).
//          `rest` only applies while the focus has work; once it has ended, this setting decides.
//          Pulled along: an open dependency (transitively) of a pending task in the focus gets the stage of the highest
//          ranked task that waits on it, even if it belongs to an area outside.
//   task.parked: { by, at, reason?, to? }      "put on hold" for one task. Status stays waiting (like batched);
//                                                  next, start and pickable skip it. With `to` the parking ends
//                                                  by itself.
// The ranking (ranking/compareRanking) is ONE function used by selectNext, pickable, nextUp (via selectNext),
// show and state: [parked/paused/outside focus → out] → focusStep → score → id. Without focus and without parked the
// result is the same as before (tested in lib/__tests__/queueFocus.test.ts).

/** Area for projects without `area`. */
const WITHOUT_AREA = 'without-area';
/** Valid values for focus.rest. Standard: wait. */
const FOCUS_REST = ['wait', 'fill'];
/** How specific a stage is: the most specific stage that matches a task decides the stage. */
const STEP_SPECIFICITY = { area: 1, project: 2, feature: 3 };
/** Sort values for tasks outside the focus (rest waiting) and parked (last of all). */
const REST_STEP = 1_000_000;
const PARKED_STEP = 2_000_000;
/** Longest free text in focus name and parking reason. */
const FOCUS_MAX_TEXT = 200;

/** The area a task belongs to: the project's `area`, otherwise `without-area`. Tasks never have their own area field. */
function areaFor(o, queue) {
  const register = queue?.projects ?? {};
  const oid = register[projectFor(o, register)]?.area;
  return typeof oid === 'string' && oid ? oid : WITHOUT_AREA;
}

/**
 * Interprets one stage from the CLI or the board: `area:<oid>`, `project:<pid>`, `feature:<pid>/<name>`, or a bare
 * name (area if it exists, otherwise project; if both exist, the type must be written). Returns the saved form.
 * @returns {{ stage: string } | { error: string }}
 */
function parseStep(raw, queue) {
  const areas = queue?.areas ?? {};
  const register = queue?.projects ?? {};
  const s = String(raw ?? '').trim();
  if (!s) return { error: 'empty stage' };
  const colon = s.indexOf(':');
  if (colon < 0) {
    const isArea = Object.hasOwn(areas, s);
    const isProject = Object.hasOwn(register, s);
    if (isArea && isProject)
      return {
        error: `${s} is both an area and a project: write area:${s} or project:${s}`,
      };
    if (isArea) return { stage: `area:${s}` };
    if (isProject) return { stage: `project:${s}` };
    return {
      error: `unknown stage ${s} (neither area nor project; see cq areas and projects)`,
    };
  }
  const type = s.slice(0, colon);
  const rest = s.slice(colon + 1).trim();
  if (type === 'area') {
    if (!Object.hasOwn(areas, rest))
      return { error: `unknown area ${rest} (create it with cq area ${rest} --title "…")` };
    return { stage: `area:${rest}` };
  }
  if (type === 'project') {
    if (!Object.hasOwn(register, rest)) return { error: `unknown project ${rest}` };
    return { stage: `project:${rest}` };
  }
  if (type === 'feature') {
    const separator = rest.indexOf('/');
    const pid = separator < 0 ? '' : rest.slice(0, separator).trim();
    const name = separator < 0 ? '' : rest.slice(separator + 1).trim();
    if (!pid || !name)
      return { error: `a feature stage is written feature:<project>/<name> (got ${s})` };
    if (!Object.hasOwn(register, pid)) return { error: `unknown project ${pid} in ${s}` };
    return { stage: `feature:${pid}/${name}` };
  }
  return { error: `unknown stage type ${type} (use area:, project: or feature:)` };
}

/** Does the task match a (saved) stage? Returns the specificity (1–3) or 0. */
function stepMatch(o, stage, queue) {
  const s = String(stage);
  const colon = s.indexOf(':');
  const type = s.slice(0, colon);
  const rest = s.slice(colon + 1);
  const register = queue?.projects ?? {};
  if (type === 'area') return areaFor(o, queue) === rest ? STEP_SPECIFICITY.area : 0;
  if (type === 'project')
    return projectFor(o, register) === rest ? STEP_SPECIFICITY.project : 0;
  if (type === 'feature') {
    const separator = rest.indexOf('/');
    const pid = rest.slice(0, separator);
    const name = rest.slice(separator + 1);
    const f = typeof o?.feature === 'string' ? o.feature.trim() : '';
    return projectFor(o, register) === pid && f === name ? STEP_SPECIFICITY.feature : 0;
  }
  return 0;
}

/**
 * Does the focus apply now? No when it is not set, has an empty order, `to` has passed (the period is over) or `from` is
 * in the future. Also returns why, for the notice.
 * @returns {{ applies: boolean, expired: boolean, notStarted: boolean }}
 */
function focusApplies(queue, now = Date.now()) {
  const f = queue?.focus;
  if (!f || !Array.isArray(f.order) || !f.order.length)
    return { applies: false, expired: false, notStarted: false };
  const to = f.to ? Date.parse(f.to) : NaN;
  if (Number.isFinite(to) && to <= now)
    return { applies: false, expired: true, notStarted: false };
  const from = f.from ? Date.parse(f.from) : NaN;
  if (Number.isFinite(from) && from > now)
    return { applies: false, expired: false, notStarted: true };
  return { applies: true, expired: false, notStarted: false };
}

// ---- When the focus has ended ---------------------------------------------------------------------------------------
//
// A focus ENDS when every stage is done (nothing open and no rests in any stage: the same as status `done` in
// logic/focus.js evaluateFocusStep) or when its period `to` has passed. What happens then is the setting
// "continue the regular queue automatically when the focus is empty":
//   queue.json         focus.continue_when_empty: true|false   per focus (cq focus set ... --continue-when-empty on|off); wins
//   queue.config.json  focus.continueWhenEmpty                 the project's default (false)
// Off: the queue is paused (every waiting task is out of the ranking, with focusEndText as the reason) until the owner
// sets a new focus, turns it off, or answers the owner question (focusEndQuestionId) with "Continue the regular queue".
// On: the queue continues (the old behavior). A project that never set a focus is never affected.

/** The id of the owner question for one focus (from its `from`, so a new focus gets a new question). */
function focusEndQuestionId(focus) {
  const stamp = String(focus?.from ?? '').replace(/\D/g, '').slice(0, 14);
  return `focus-done-${stamp || 'unset'}`;
}
/** The choices of the owner question; the second one lifts the pause (focusContinues). */
const FOCUS_END_CHOICES = ['Set a new focus', 'Continue the regular queue'];

/**
 * Is every stage of the focus done? True when no task belongs to a stage that is still open (waiting, also batched,
 * parked, proposed and waiting on questions; running, picked, review) or done with QA waiting on the owner. Pulled-along
 * tasks need not be checked: they are only pulled by a waiting task in a stage, which already counts.
 */
function focusRanEmpty(queue) {
  if (!queue?.focus?.order?.length) return false;
  for (const o of queue.tasks ?? []) {
    if (!o || isExternalRow(o) || o.status === 'cancelled') continue;
    if (o.status === 'done' && o.qa_status !== 'waiting') continue;
    if (ownStep(o, queue) != null) return false;
  }
  return true;
}

/**
 * Does the queue continue when the focus has ended? The per-focus override wins over the config; an owner answer
 * "Continue the regular queue" to this focus's question also continues.
 * @returns {{ on: boolean, source: 'focus'|'config'|'answer', setting: boolean, settingSource: 'focus'|'config' }}
 */
function focusContinues(queue) {
  const own = queue?.focus?.continue_when_empty;
  let setting;
  let settingSource;
  if (typeof own === 'boolean') {
    setting = own;
    settingSource = 'focus';
  } else {
    setting = cfg()?.focus?.continueWhenEmpty === true;
    settingSource = 'config';
  }
  if (setting) return { on: true, source: settingSource, setting, settingSource };
  const id = focusEndQuestionId(queue?.focus);
  const answer = (queue?.resolved ?? []).includes(id) ? queue?.resolutions?.[id]?.answer : null;
  const continued = typeof answer === 'string' && answer.startsWith(FOCUS_END_CHOICES[1]);
  return { on: continued, source: continued ? 'answer' : settingSource, setting, settingSource };
}

/** The reason a task does not start while the queue is paused after the focus ended. */
function focusEndText(queue, k) {
  const name = queue?.focus?.name ? ` "${queue.focus.name}"` : '';
  return (
    `focus${name} ${k?.expired ? 'period is over' : 'is done'}: queue paused ` +
    '(cq focus set ... for a new focus, cq focus off, or focus.continueWhenEmpty)'
  );
}

/**
 * The task's own stage (0-based index in focus.order), or null when no stage matches. The most specific
 * stage wins; on equal level the first one. Does not look at "pulled along" (draggedWith/focusSpace does that).
 */
function ownStep(o, queue) {
  const order = queue?.focus?.order ?? [];
  let best = null;
  let bestSpec = 0;
  order.forEach((t, i) => {
    const spec = stepMatch(o, t, queue);
    if (spec > bestSpec) {
      best = i;
      bestSpec = spec;
    }
  });
  return best;
}

/** Is the task parked now? The parking ends by itself when `to` has passed. */
function parkedNow(o, now = Date.now()) {
  const p = o?.parked;
  if (!p || typeof p !== 'object') return false;
  const to = p.to ? Date.parse(p.to) : NaN;
  return !(Number.isFinite(to) && to <= now);
}

/**
 * "Pulled along": open dependencies (transitively) of pending tasks in the focus that do not themselves have an equally good stage.
 * Each gets the stage of the highest ranked focus task that waits on it, and `by` = that task. The roots are
 * pending tasks with their own stage that are not parked or in a paused project (they should not pull anything along).
 * Empty when the focus does not apply or `drag_with_dependencies` is false.
 * @returns {Map<string, { stage: number, by: string }>}
 */
function draggedWith(queue, now = Date.now()) {
  const dragged = new Map();
  if (!focusApplies(queue, now).applies || queue.focus.drag_with_dependencies === false) return dragged;
  const tasks = queue.tasks ?? [];
  const register = queue.projects ?? {};
  const perId = new Map(tasks.map((o) => [o.id, o]));
  const ownOne = new Map();
  const stepFor = (o) => {
    if (!ownOne.has(o.id)) ownOne.set(o.id, ownStep(o, queue));
    return ownOne.get(o.id);
  };
  const roots = tasks
    .filter(
      (o) =>
        o.status === 'waiting' &&
        !isExternalRow(o) &&
        !parkedNow(o, now) &&
        !projectPaused(o, register),
    )
    .map((o) => ({ o, t: stepFor(o) }))
    .filter((x) => x.t != null)
    .sort((x, y) => x.t - y.t || x.o.id.localeCompare(y.o.id));
  for (const { o, t } of roots) {
    const set = new Set([o.id]);
    const stack = [...(o.depends_on ?? [])];
    while (stack.length) {
      const id = stack.pop();
      if (set.has(id)) continue;
      set.add(id);
      const d = perId.get(id);
      if (!openTask(d) || isExternalRow(d)) continue;
      const own = stepFor(d);
      const previous = dragged.get(id);
      if ((own == null || own > t) && (!previous || previous.stage > t))
        dragged.set(id, { stage: t, by: o.id });
      stack.push(...(d.depends_on ?? []));
    }
  }
  return dragged;
}

/**
 * The context the ranking needs, computed once per call (draggedWith walks the whole dependency graph).
 * `finished` = applies and every stage is done; `ended` = finished or expired; `halted` = ended and the queue does not
 * continue (focusContinues), so nothing starts.
 * @returns {{ queue: object, now: number, applies: boolean, expired: boolean, notStarted: boolean,
 *             finished: boolean, ended: boolean, halted: boolean,
 *             rest: string, dragged: Map<string, { stage: number, by: string }> }}
 */
function rankingContext(queue, now = Date.now()) {
  const g = focusApplies(queue, now);
  const finished = g.applies && focusRanEmpty(queue);
  const ended = finished || g.expired;
  return {
    queue,
    now,
    ...g,
    finished,
    ended,
    halted: ended && !focusContinues(queue).on,
    rest: g.applies && queue.focus.rest === 'fill' ? 'fill' : 'wait',
    dragged: g.applies ? draggedWith(queue, now) : new Map(),
  };
}

/** The text for a parked task (blocker in show/state). */
function parkedText(o) {
  const p = o.parked ?? {};
  return (
    `parked${p.to ? ` until ${utcText(p.to)}` : ''} by ${p.by ?? '?'}` +
    `${p.reason ? `: ${p.reason}` : ''} (cq continue ${o.id})`
  );
}

/** The text for a task outside the focus when the rest waits. */
function outsideText(queue) {
  const name = queue?.focus?.name ? ` "${queue.focus.name}"` : '';
  return `outside focus${name} (rest waiting; cq focus)`;
}

/**
 * The placement of one task, without score: focusStep (0-based, null = outside all stages), pulled along by, and whether it is
 * out of the ranking (parked, paused project, outside the focus when the rest waits, or the queue paused because the
 * focus has ended: `halted`) with the reason.
 * `stage` is the sort value: 0 without focus; the stage index with focus; the stage count for the rest with `fill`;
 * REST_STEP for the rest with `wait`; PARKED_STEP for parked.
 */
function focusSpace(o, k) {
  const queue = k.queue;
  const parked = parkedNow(o, k.now);
  const paused = projectPaused(o, queue.projects ?? {});
  let step = null;
  let draggedBy = null;
  let outside = false;
  let stage = 0;
  if (k.applies) {
    const d = k.dragged.get(o.id);
    step = d ? d.stage : ownStep(o, queue);
    draggedBy = d ? d.by : null;
    outside = step == null;
    stage = outside ? (k.rest === 'fill' ? queue.focus.order.length : REST_STEP) : step;
  }
  if (parked) stage = PARKED_STEP;
  const outsideWait = outside && k.rest !== 'fill';
  const halted = k.halted === true;
  let reason = null;
  if (parked) reason = parkedText(o);
  else if (paused) reason = `the project ${projectFor(o, queue.projects ?? {})} is paused`;
  else if (halted) reason = focusEndText(queue, k);
  else if (outsideWait) reason = outsideText(queue);
  return {
    stage,
    step,
    dragged_by: draggedBy,
    parked,
    paused,
    outside,
    halted,
    out: parked || paused || outsideWait || halted,
    reason,
  };
}

/**
 * The ranking of one task: focusSpace + score. ONE source for selectNext, pickable, nextUp, show and state.
 * @param {object} [k] rankingContext(queue, now), when many tasks are ranked
 */
function ranking(o, queue, k = rankingContext(queue)) {
  return {
    ...focusSpace(o, k),
    score: score(o, queue.tasks ?? [], k.now, queue.projects ?? {}),
  };
}

/** The sorting: lowest stage first, then highest score, then id. Takes { o, r } where r = ranking(o, …). */
function compareRanking(a, b) {
  return a.r.stage - b.r.stage || b.r.score - a.r.score || a.o.id.localeCompare(b.o.id);
}

/** Interprets a date (YYYY-MM-DD = through that day, UTC; otherwise ISO). null if invalid. */
function parseToDate(raw) {
  if (raw == null || raw === '') return null;
  const s = String(raw).trim();
  const ms = /^\d{4}-\d\d-\d\d$/.test(s) ? Date.parse(`${s}T23:59:59.000Z`) : Date.parse(s);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Short text for a stage: the area's or project's title, or the feature name. */
function stepTitle(stage, queue) {
  const s = String(stage);
  const colon = s.indexOf(':');
  const type = s.slice(0, colon);
  const rest = s.slice(colon + 1);
  if (type === 'area') return queue?.areas?.[rest]?.title ?? rest;
  if (type === 'project') return queue?.projects?.[rest]?.title ?? rest;
  return rest.slice(rest.indexOf('/') + 1);
}

/** "T1", "T2 pulled along by A-1" or "rest" for a row with { step, dragged_by } (show, next, pickable). */
function stepText(r) {
  if (r?.step == null) return 'rest';
  return `T${r.step + 1}${r.dragged_by ? ` pulled along by ${r.dragged_by}` : ''}`;
}

/** "1 Auth → 2 Payment and invoicing · rest waiting" */
function focusText(queue) {
  const f = queue?.focus;
  if (!f?.order?.length) return 'no focus';
  const stage = f.order.map((t, i) => `${i + 1} ${stepTitle(t, queue)}`).join(' → ');
  const rest = f.rest === 'fill' ? 'rest fills free slots' : 'rest waiting';
  return `${stage} · ${rest}${f.to ? ` · until ${utcText(f.to)}` : ''}`;
}
/**
 * Priority: value per estimated minute, with a bonus for tasks that unlock others and a small
 * age bonus so nothing sits still forever. Manual `priority_bonus` (±) from reprioritizing, plus
 * the project's `priority_bonus` from the register (when `register` is given).
 */
function score(o, tasks, now = Date.now(), register) {
  return scoreParts(o, tasks, now, register).score;
}
/**
 * The parts the priority (score) is computed from, for "Placement" in the detail panel on the board: value, the minutes
 * used (at least 5), unlocks N (+25 % each), age in days (+2 % per day, at most 14), the task's and the project's
 * bonus, and the result. score() is just `.score` from here, so the explanation can never drift from the number.
 * @returns {{ value: number, minutes: number, unlocks: number, lock_factor: number, days: number,
 *   age_factor: number, reason: number, bonus: number, project_bonus: number, score: number }}
 */
function scoreParts(o, tasks, now = Date.now(), register) {
  const value = Number(o.value ?? 5);
  const time = Math.max(estimate(o), 5);
  const lockState = lockUpCount(o.id, tasks);
  const days = o.added_at ? Math.max(0, (now - Date.parse(o.added_at)) / 86_400_000) : 0;
  const lockFactor = 1 + 0.25 * lockState;
  const ageFactor = 1 + Math.min(days, 14) * 0.02;
  const s = (value / time) * 100 * lockFactor * ageFactor;
  const projectBonus = register
    ? Number(register[projectFor(o, register)]?.priority_bonus) || 0
    : 0;
  const bonus = Number(o.priority_bonus ?? 0);
  return {
    value,
    minutes: time,
    unlocks: lockState,
    lock_factor: lockFactor,
    days: Math.round(days * 10) / 10,
    age_factor: Math.round(ageFactor * 1000) / 1000,
    reason: Math.round(s * 100) / 100,
    bonus,
    project_bonus: projectBonus,
    score: Math.round((s + bonus + projectBonus) * 100) / 100,
  };
}

module.exports = {
  blockersWithPause,
  WITHOUT_AREA,
  FOCUS_REST,
  FOCUS_MAX_TEXT,
  areaFor,
  parseStep,
  stepMatch,
  focusApplies,
  focusEndQuestionId,
  FOCUS_END_CHOICES,
  focusRanEmpty,
  focusContinues,
  focusEndText,
  ownStep,
  parkedNow,
  draggedWith,
  rankingContext,
  parkedText,
  focusSpace,
  ranking,
  compareRanking,
  parseToDate,
  stepTitle,
  stepText,
  focusText,
  score,
  scoreParts,
};
