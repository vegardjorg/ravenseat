// =============================================================
// queueTimeline.js: what GET /api/schedule sends to the board's Timeline tab (roadmap TIDSLINJE T-A).
//
// Read-only and pure (the caller passes `now`, the quota cap and the load slots, the same way cli/schedule.mjs does):
//   - schedule: lib/queueSchedule.js schedule() as it is (no rule or number is changed here),
//   - ran: the tasks done in the last day (RAN_WINDOW) with start, delivered (end of the track phase) and end, for the
//     ran part left of the now line,
//   - projects / projectTitles / titles: the project of each task (queueLogic.projectFor with the register) and the
//     register's titles, for the rows per project and the table.
//   - uncertainty / backtest (T-C, board.timelineUncertainty): lib/scheduleUncertainty.js's P50 to P85 band per focus
//     step and its backtest line; null when the setting is off. The server may pass cached ones in.
// cacheKey: the board server keeps one payload per key (the queue's bytes, the settings and the minute), so a poll does
// not play the queue again while nothing changed; the minute keeps the running tasks' remaining time fresh.
//
// Used by queue-board.mjs. Drawn with lib/timelineLayout.js in queue-board/board/timeline.js. Tested in
// lib/__tests__/queueTimeline.test.ts.
// =============================================================
'use strict';

const L = require('./queueLogic.js');
const SC = require('./queueSchedule.js');
const UN = require('./scheduleUncertainty.js');

/** How far back the ran part reaches: a day. */
const RAN_WINDOW = 24 * 3_600_000;

const ms = (v) => {
  const x = Date.parse(v ?? '');
  return Number.isFinite(x) ? x : null;
};

/**
 * The payload.
 * @param {object} queue queue.json (not changed)
 * @param {{ now?: number, quotaSlots?: number|null, loadSlots?: number|null, tz?: string, uncertainty?: boolean,
 *   band?: object, backtest?: object }} [option] uncertainty: add the band and the backtest (T-C); band, backtest:
 *   ones the caller has cached
 */
function timelineData(queue, option = {}) {
  const now = option.now ?? Date.now();
  const schedule = SC.schedule(queue, {
    now,
    quotaSlots: option.quotaSlots ?? null,
    loadSlots: option.loadSlots ?? null,
    ...(option.tz ? { tz: option.tz } : {}),
  });
  const tasks = (queue?.tasks ?? []).filter((o) => o && !L.isExternalRow(o));
  const ran = tasks
    .filter((o) => o.status === 'done')
    .map((o) => ({ o, s: ms(o.started), e: ms(o.done) }))
    .filter(({ s, e }) => s != null && e != null && e >= s && e >= now - RAN_WINDOW && e <= now)
    .sort((x, y) => x.s - y.s || String(x.o.id).localeCompare(String(y.o.id)))
    .map(({ o }) => ({
      id: o.id,
      title: o.title ?? null,
      class: o.class ?? null,
      start: o.started,
      delivered: o.delivered ?? null,
      end: o.done,
    }));
  const register = queue?.projects ?? {};
  const projects = {};
  const titles = {};
  for (const o of tasks) {
    projects[o.id] = L.projectFor(o, register);
    titles[o.id] = o.title ?? '';
  }
  const projectTitles = {};
  for (const [pid, p] of Object.entries(register)) projectTitles[pid] = typeof p?.title === 'string' && p.title ? p.title : pid;
  // T-C (board.timelineUncertainty): the band per focus step and the backtest (lib/scheduleUncertainty.js), with the
  // same moment, caps and time zone as the schedule. The caller may pass the band or the backtest it has cached (the
  // board server keeps the band a few minutes and the backtest a day).
  let uncertainty = null;
  let backtest = null;
  if (option.uncertainty === true) {
    const tz = option.tz ? { tz: option.tz } : {};
    uncertainty =
      option.band ?? UN.uncertainty(queue, { now, quotaSlots: option.quotaSlots ?? null, loadSlots: option.loadSlots ?? null, ...tz });
    backtest = option.backtest ?? UN.backtest(queue, { now, ...tz });
  }
  return { schedule, ran, projects, projectTitles, titles, uncertainty, backtest };
}

/** The cache key: the queue's stamp (mtime and size), the settings and the minute. */
function cacheKey({ queueStamp, settings, now = Date.now() }) {
  return JSON.stringify([queueStamp, settings ?? null, Math.floor(now / 60_000)]);
}

// ---- What a drop does to the plan (roadmap TIDSLINJE T-B; investigation section 3, "one new thing") -----------------
// The board's preview before a drop is saved: the dry run's changes are put on a copy (applyChanges), both queues are
// played forward with the same model, caps and moment (planEffect), and the two schedules are compared in words
// (planChange). Pure reading: nothing here writes, and no text gives a clock time.

/** A shift smaller than this many minutes is not named (the plan is rough; noise is not news). */
const SHIFT_MIN = 10;
/** At most this many steps are named; the rest are counted. */
const STEPS_NAMED = 3;
/** The sentence when nothing moves by SHIFT_MIN or more. */
const PLAN_SAME = `The plan stays about the same: no step ends ${SHIFT_MIN} min or more earlier or later.`;

/**
 * A copy of the queue with a dry run's changes ({ id, field, after } for a task, { pid, field, after } for a
 * project; after null removes the field), the form queueLogic.bulkDiff gives. The queue itself is never changed.
 */
function applyChanges(queue, changes) {
  const copy = JSON.parse(JSON.stringify(queue ?? {}));
  const perId = new Map((copy.tasks ?? []).map((o) => [o.id, o]));
  for (const c of changes ?? []) {
    let target = null;
    if (c?.id != null) target = perId.get(c.id) ?? null;
    else if (c?.pid != null) {
      copy.projects = copy.projects ?? {};
      copy.projects[c.pid] = copy.projects[c.pid] ?? {};
      target = copy.projects[c.pid];
    }
    if (!target || typeof c.field !== 'string') continue;
    if (c.after == null) delete target[c.field];
    else target[c.field] = JSON.parse(JSON.stringify(c.after));
  }
  return copy;
}

const msOf = (v) => {
  const x = Date.parse(v ?? '');
  return Number.isFinite(x) ? x : null;
};

/** "step 2 (Beta)", "the rest" or "the whole queue". */
function stepName(st) {
  if (st.step == null) return st.title === 'the whole queue' ? 'the whole queue' : 'the rest';
  return `step ${st.step + 1} (${st.title})`;
}
const stepKey = (st) => st.stage ?? `none:${st.title}`;
const shiftText = (min) => `about ${SC.roughDuration(Math.abs(min))} ${min > 0 ? 'later' : 'earlier'}`;
/** The planned (not running) rows, by start, then id. */
const plannedRows = (s) =>
  (s?.tasks ?? [])
    .filter((r) => !r.running && msOf(r.start) != null)
    .sort((a, b) => msOf(a.start) - msOf(b.start) || String(a.id).localeCompare(String(b.id)));

/**
 * Two schedules (queueSchedule.schedule) in words: { sentence, parts }.
 *   - each step (matched by its key, named as after the change) whose expected end moves SHIFT_MIN or more, at most
 *     STEPS_NAMED of them, then how many more;
 *   - the task that now starts first: in the moved tasks' step (`moved`, a rank), or in the whole plan (a step move);
 *   - otherwise the first moved task's own start, when it moves SHIFT_MIN or more.
 * PLAN_SAME when nothing is named.
 */
function planChange(before, after, { moved = [] } = {}) {
  const parts = [];
  const old = new Map((before?.steps ?? []).map((st) => [stepKey(st), st]));
  const shifted = [];
  for (const st of after?.steps ?? []) {
    const was = old.get(stepKey(st));
    const a = msOf(st.p50_end);
    const b = msOf(was?.p50_end);
    if (a == null || b == null) continue;
    const min = (a - b) / 60_000;
    if (Math.abs(min) >= SHIFT_MIN) shifted.push(`${stepName(st)} done ${shiftText(min)}`);
  }
  parts.push(...shifted.slice(0, STEPS_NAMED));
  const more = shifted.length - STEPS_NAMED;
  if (more > 0) parts.push(`${more} more step${more === 1 ? ' moves' : 's move'} too`);

  const pb = plannedRows(before);
  const pa = plannedRows(after);
  let firstId = null;
  if (moved.length) {
    const was = pb.find((r) => r.id === moved[0]) ?? pa.find((r) => r.id === moved[0]);
    const step = was?.step ?? null;
    const b0 = pb.find((r) => (r.step ?? null) === step);
    const a0 = pa.find((r) => (r.step ?? null) === step);
    if (a0 && b0 && a0.id !== b0.id) {
      const st = (after?.steps ?? []).find((x) => (x.step ?? null) === step);
      firstId = a0.id;
      parts.push(`${a0.id} starts first${st ? ` in ${stepName(st)}` : ''}`);
    }
  } else if (pa[0] && pb[0] && pa[0].id !== pb[0].id) {
    firstId = pa[0].id;
    parts.push(`${pa[0].id} starts first`);
  }
  if (moved.length && firstId == null) {
    const id = moved[0];
    const a = msOf(pa.find((r) => r.id === id)?.start);
    const b = msOf(pb.find((r) => r.id === id)?.start);
    if (a != null && b != null && Math.abs(a - b) / 60_000 >= SHIFT_MIN) parts.push(`${id} starts ${shiftText((a - b) / 60_000)}`);
  }
  if (!parts.length) return { sentence: PLAN_SAME, parts };
  const text = parts.join('; ');
  return { sentence: `${text.charAt(0).toUpperCase()}${text.slice(1)}.`, parts };
}

/**
 * Plays the queue and the changed copy forward with the same moment, model and caps, and says the difference
 * (planChange). Neither queue is changed.
 * @param {object} queue the queue as it is
 * @param {object} copy the queue as the drop would leave it (applyChanges, or saveFocusPlan on a copy)
 * @param {{ now?: number, quotaSlots?: number|null, loadSlots?: number|null, tz?: string, moved?: string[] }} [option]
 */
function planEffect(queue, copy, option = {}) {
  const now = option.now ?? Date.now();
  const model = SC.ratioModel(queue, { now });
  const common = {
    now,
    model,
    quotaSlots: option.quotaSlots ?? null,
    loadSlots: option.loadSlots ?? null,
    ...(option.tz ? { tz: option.tz } : {}),
  };
  const before = SC.schedule(queue, common);
  const after = SC.schedule(copy, common);
  return planChange(before, after, { moved: option.moved ?? [] });
}

module.exports = { RAN_WINDOW, SHIFT_MIN, PLAN_SAME, timelineData, cacheKey, applyChanges, planChange, planEffect };
