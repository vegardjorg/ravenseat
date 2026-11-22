// =============================================================
// cli/schedule.mjs: `ravenseat schedule [--json] [--next <n>]`, the schedule simulation as a read-only command.
//
// Reads the queue, the quota forecast (the cap `fill` would use) and the load-aware slots, plays the queue forward with
// lib/queueSchedule.js and prints per focus step the expected end and the task count, the next few tasks with start and
// length relative to now, and one line on how rough it is. Writes nothing. Exit 2 on a usage error.
//
// Used by: queue.mjs (dispatch). Tested in: lib/__tests__/queueSchedule.test.ts.
// =============================================================

import { a, CH, die, L, read, require, TK } from './context.mjs';
import { measureLoad, readTimeLog } from './tracks.mjs';

const SC = require('./lib/queueSchedule.js');

const USAGE = 'Use: ravenseat schedule [--json] [--next <n>]   (--next: how many upcoming tasks to list, 1-100, default 5)';

/** `ravenseat schedule` (the usage is at the top of queue.mjs). */
export function cmdSchedule() {
  let json = false;
  let next = 5;
  for (let i = 1; i < a.length; i += 1) {
    if (a[i] === '--json') json = true;
    else if (a[i] === '--next') {
      const n = Number(a[i + 1]);
      if (!Number.isInteger(n) || n < 1 || n > 100) die(`--next must be a whole number 1-100. ${USAGE}`, 2);
      next = n;
      i += 1;
    } else die(`Unknown argument ${a[i]}. ${USAGE}`, 2);
  }
  const queue = read();
  const now = Date.now();
  // The quota cap fill would use (queueCapacity.quotaCap). A forecast that fails never stops the command: no cap then.
  let quotaSlots = null;
  try {
    const running = (queue.tasks ?? []).filter((o) => o.status === 'running').length;
    const p = CH.forecast({ queue, events: TK.usageEvents(readTimeLog({ from: now - 8 * 86_400_000 })) });
    quotaSlots = SC.quotaSlotsFrom(p, running);
  } catch {
    quotaSlots = null;
  }
  // The load-aware slots (lib/loadSlots.js), only when the adaptive rule limits them now.
  let loadSlots = null;
  try {
    const ls = L.loadSlotsFor(queue, measureLoad());
    loadSlots = ls.active ? ls.slots : null;
  } catch {
    loadSlots = null;
  }
  const s = SC.schedule(queue, { now, quotaSlots, loadSlots });
  if (json) console.log(JSON.stringify(s, null, 2));
  else console.log(SC.scheduleLines(s, { next }).join('\n'));
}
