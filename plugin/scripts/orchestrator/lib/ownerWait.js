// =============================================================
// ownerWait.js: what counts as an owner action for `cq wait`, and the heartbeat the board reads.
//
// Why: the orchestrator only runs when an agent finishes or the owner types in the session. When everything waits on the
// owner, an answer given on the board sits unseen. `cq wait` (cli/wait.mjs) runs with run_in_background and exits when
// the owner acts, and Claude Code starts a new turn when a background command exits.
//
// Where an owner action is recorded. Only some writes go through the changelog (queue.changelog, lib/logic/edit.js:
// edit, edit-many, cancel, rank, park, continue, project, classify, focus clean, with `by` from --by and `undone.by`
// on an undo). resolve, approve, qa ok, qa deviation and add do not log there; they leave fields instead. So an owner
// action is any of these, compared with a snapshot taken when the waiter starts (never a clock comparison):
//   - a changelog entry with nr above the start point and `by` owner or theBoard (the action is the entry's action),
//   - a changelog entry undone by owner or theBoard since the start (undo),
//   - a resolution (`resolutions.<q>`) with a new time and `by` owner or theBoard (resolve; the board passes --by owner),
//   - a task with a new `approved` time that the auto-accept did not set (approve; only the owner approves by hand),
//   - a task with a new `qa_ok` time, not `qa_ok_by: "auto"` (qa ok),
//   - a task with a new QA deviation note (qa fail; the fix task it adds is not listed again as an add),
//   - a new task with `added_by` owner or theBoard (add).
// `cq set` writes no `by` and is not detected. Agent and orchestrator writes (by a task id, "cq", or no --by) do not
// count. Only ids are returned, never answer or note text.
//
// Everything here is pure (queue in, list out) apart from the heartbeat reader, which the board calls.
// Used by: cli/wait.mjs and queue-board.mjs (the "Orchestrator listening" line in "Waiting on you").
// Tested in: lib/__tests__/ownerWait.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** The `by` values that mean the owner (the board writes theBoard for edits and owner for answers). */
const OWNER_BY = new Set(['owner', 'theBoard']);
/** The heartbeat file in the data folder, and how old a beat may be before the board stops saying "listening". */
const HEARTBEAT_FILE = 'wait-heartbeat.json';
const LISTENING_MAX_AGE_MS = 90_000;

const isOwner = (by) => OWNER_BY.has(String(by ?? '').trim());
const log = (queue) => (Array.isArray(queue?.changelog) ? queue.changelog : []);
const tasks = (queue) => (Array.isArray(queue?.tasks) ? queue.tasks : []);

/** The highest changelog number in the queue (0 when empty): the default start point. */
function lastLogNr(queue) {
  return log(queue).reduce((m, p) => Math.max(m, Number(p?.nr) || 0), 0);
}

/**
 * The state the waiter compares against: the start point in the changelog and the field values that change on an owner
 * action. `since` overrides the changelog start point (tests, or a caller that knows where it left off).
 */
function snapshot(queue, { since = null } = {}) {
  const per = (field) => Object.fromEntries(tasks(queue).map((o) => [o.id, o[field] ?? null]));
  return {
    nr: since == null ? lastLogNr(queue) : Number(since) || 0,
    undone: Object.fromEntries(log(queue).map((p) => [p.nr, p.undone?.at ?? null])),
    resolutions: Object.fromEntries(Object.entries(queue?.resolutions ?? {}).map(([q, r]) => [q, r?.time ?? null])),
    approved: per('approved'),
    qaOk: per('qa_ok'),
    qaNote: per('qa_note'),
    ids: tasks(queue).map((o) => o.id),
  };
}

/** The ids a changelog entry touched: task ids, "project <pid>", or "focus". */
function entryIds(entry) {
  const out = [];
  for (const e of entry?.changes ?? []) {
    const who = e?.id != null ? String(e.id) : e?.pid != null ? `project ${e.pid}` : e?.focus ? 'focus' : null;
    if (who && !out.includes(who)) out.push(who);
  }
  return out;
}

/**
 * The owner actions in `queue` since the snapshot `base`, in a stable order: [{ action, id }], each pair once.
 * @returns {{ action: string, id: string }[]}
 */
function ownerActions(queue, base) {
  const out = [];
  const push = (action, id) => {
    if (!out.some((x) => x.action === action && x.id === id)) out.push({ action, id: String(id) });
  };
  for (const entry of log(queue)) {
    if (Number(entry?.nr) > base.nr && isOwner(entry.by))
      for (const id of entryIds(entry)) push(String(entry.action ?? 'edit'), id);
    if (entry?.undone && isOwner(entry.undone.by) && entry.undone.at !== (base.undone[entry.nr] ?? null))
      for (const id of entryIds(entry)) push('undo', id);
  }
  for (const [q, r] of Object.entries(queue?.resolutions ?? {}))
    if (r?.time && r.time !== (base.resolutions[q] ?? null) && isOwner(r.by)) push('resolve', q);
  // The auto-accept approves through the same path; its log (auto_accepted) tells those apart.
  const auto = new Set((queue?.auto_accepted ?? []).map((x) => `${x?.id} ${x?.at}`));
  const known = new Set(base.ids);
  for (const o of tasks(queue)) {
    if (o.approved && o.approved !== (base.approved[o.id] ?? null) && !auto.has(`${o.id} ${o.approved}`))
      push('approve', o.id);
    if (o.qa_ok && o.qa_ok !== (base.qaOk[o.id] ?? null) && o.qa_ok_by !== 'auto') push('qa ok', o.id);
    if (o.qa_status === 'deviation' && o.qa_note && o.qa_note !== (base.qaNote[o.id] ?? null)) push('qa fail', o.id);
    if (!known.has(o.id) && isOwner(o.added_by) && !o.qa_original) push('add', o.id);
  }
  return out;
}

/** The one line the waiter prints: "OWNER ACTED: resolve Q12, Q14; approve T-40" (ids only). */
function actedLine(actions) {
  const groups = new Map();
  for (const { action, id } of actions) groups.set(action, [...(groups.get(action) ?? []), id]);
  return `OWNER ACTED: ${[...groups].map(([action, ids]) => `${action} ${ids.join(', ')}`).join('; ')}`;
}

/** Is the process with this pid alive? (EPERM = it exists but belongs to someone else.) */
function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

/**
 * The board's indicator: { listening, beatAt } from <folder>/wait-heartbeat.json. Listening when the last beat is
 * under LISTENING_MAX_AGE_MS old. A missing or broken file means not listening; this never throws.
 */
function heartbeatState(folder, now = Date.now()) {
  try {
    const h = JSON.parse(fs.readFileSync(path.join(folder, HEARTBEAT_FILE), 'utf8'));
    const at = Date.parse(h?.beatAt);
    return { listening: Number.isFinite(at) && now - at < LISTENING_MAX_AGE_MS, beatAt: h?.beatAt ?? null };
  } catch {
    return { listening: false, beatAt: null };
  }
}

module.exports = {
  OWNER_BY,
  HEARTBEAT_FILE,
  LISTENING_MAX_AGE_MS,
  lastLogNr,
  snapshot,
  ownerActions,
  actedLine,
  pidAlive,
  heartbeatState,
};
