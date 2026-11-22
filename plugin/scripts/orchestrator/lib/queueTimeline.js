// =============================================================
// queueTimeline.js: what GET /api/schedule sends to the board's Timeline tab (roadmap TIDSLINJE T-A).
//
// Read-only and pure (the caller passes `now`, the quota cap and the load slots, the same way cli/schedule.mjs does):
//   - schedule: lib/queueSchedule.js schedule() as it is (no rule or number is changed here),
//   - ran: the tasks done in the last day (RAN_WINDOW) with start, delivered (end of the track phase) and end, for the
//     ran part left of the now line,
//   - projects / projectTitles / titles: the project of each task (queueLogic.projectFor with the register) and the
//     register's titles, for the rows per project and the table.
// cacheKey: the board server keeps one payload per key (the queue's bytes, the settings and the minute), so a poll does
// not play the queue again while nothing changed; the minute keeps the running tasks' remaining time fresh.
//
// Used by queue-board.mjs. Drawn with lib/timelineLayout.js in queue-board/board/timeline.js. Tested in
// lib/__tests__/queueTimeline.test.ts.
// =============================================================
'use strict';

const L = require('./queueLogic.js');
const SC = require('./queueSchedule.js');

/** How far back the ran part reaches: a day. */
const RAN_WINDOW = 24 * 3_600_000;

const ms = (v) => {
  const x = Date.parse(v ?? '');
  return Number.isFinite(x) ? x : null;
};

/**
 * The payload.
 * @param {object} queue queue.json (not changed)
 * @param {{ now?: number, quotaSlots?: number|null, loadSlots?: number|null, tz?: string }} [option]
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
  return { schedule, ran, projects, projectTitles, titles };
}

/** The cache key: the queue's stamp (mtime and size), the settings and the minute. */
function cacheKey({ queueStamp, settings, now = Date.now() }) {
  return JSON.stringify([queueStamp, settings ?? null, Math.floor(now / 60_000)]);
}

module.exports = { RAN_WINDOW, timelineData, cacheKey };
