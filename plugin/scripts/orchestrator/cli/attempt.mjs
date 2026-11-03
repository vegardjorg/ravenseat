// =============================================================
// cli/attempt.mjs: `cq attempt list <id>` and `cq attempt close <id> --outcome <...>`.
//
// list derives the states from the time log (lib/logic/attempt.js deriveRunning) and saves them under the lock, but only
// when they changed: a read must not move queue.changed, or the board's --expect-changed would go stale. close is the
// way out for a running attempt whose agent is gone. It is logged in the changelog like an edit (so `cq undo` works) and
// refused from inside a track worktree, whatever --by says, as the locked fields are (cli/taskEdit.mjs). A queue agent
// never gets here: the push guard's allow-list (lib/pushGuard.js) does not have the command.
//
// Used by: queue.mjs (dispatch).
// Tested in: __tests__/queueAttempt.test.ts.
// =============================================================

import { a, CONFIG, die, editLogged, positional, read, require, undoHint, val, withLock, write } from './context.mjs';
import { attemptRows, syncAttempts } from './tracks.mjs';
import { trackBranchHere } from './taskEdit.mjs';

const AT = require('./lib/logic/attempt.js');
const USE = 'attempt list <id> [--json] | attempt close <id> --outcome <' + AT.CLOSE_OUTCOMES.join('|') + '> [--by "..."]';

/** The task with `id` in the queue, or die. */
function taskIn(queue, id) {
  const o = queue.tasks.find((x) => x.id === id);
  return o ?? die(`Unknown task ${id}`);
}

/** One line per attempt: what ran, how it stands and what it left. */
function attemptLine(x, ttl) {
  const parts = [
    x.id.padEnd(4),
    AT.shownState(x, ttl).padEnd(9),
    `client=${x.client}`,
    `round=${x.round}`,
    `reserved=${x.reserved}`,
    ...(x.started ? [`started=${x.started}`] : []),
    ...(x.ended ? [`ended=${x.ended}`] : []),
    ...(x.outcome ? [`outcome=${x.outcome}`] : []),
    ...(x.session_id ? [`agent=${x.session_id}`] : []),
    ...(x.delivered_sha ? [`sha=${x.delivered_sha.slice(0, 12)}`] : []),
    ...(x.evidence?.length ? [`evidence=${x.evidence.join(',')}`] : []),
  ];
  return parts.join(' ');
}

/** `cq attempt list <id>`. */
function list(id) {
  if (!id) die(USE);
  // The rows are read before the lock (the log can be large), as for the usage in cmdStart.
  const rows = attemptRows([taskIn(read(), id)]);
  const o = withLock(() => {
    const queue = read();
    const x = taskIn(queue, id);
    if (syncAttempts(x, rows)) write(queue);
    return x;
  });
  const ttl = { now: Date.now(), ttlMin: AT.reservationTtlMin(CONFIG) };
  const attempts = o.attempts ?? [];
  if (a.includes('--json')) {
    const shown = attempts.map((x) => ({ ...x, shown_state: AT.shownState(x, ttl) }));
    console.log(JSON.stringify({ id, attempts: shown }, null, 2));
    return;
  }
  if (!attempts.length) console.log(`${id} has no attempts (it has not been started since the attempt record came).`);
  for (const x of attempts) console.log(attemptLine(x, ttl));
}

/** `cq attempt close <id> --outcome <...>`. */
function close(id) {
  const outcome = val('--outcome');
  if (!id || !outcome) die(USE);
  const branch = trackBranchHere();
  if (branch) die(`An attempt cannot be closed from inside a track worktree (branch ${branch}); ask the owner (cq question).`);
  const rows = attemptRows([taskIn(read(), id)]);
  const closed = editLogged('attempt-close', (queue) => {
    const o = taskIn(queue, id);
    syncAttempts(o, rows);
    const r = AT.close(o.attempts, { outcome, now: new Date().toISOString() });
    if (r.error) die(`${id}: ${r.error}`);
    o.attempts = r.attempts;
    return r.closed;
  });
  console.log(`${id}: attempt ${closed.id} closed (${closed.outcome}).`);
  if (undoHint()) console.log(undoHint());
}

/** `cq attempt` (the usage is at the top of queue.mjs). */
export function cmdAttempt() {
  const [sub, id] = positional(1, ['--outcome', '--by']);
  if (sub === 'list') list(id);
  else if (sub === 'close') close(id);
  else die(USE);
}
