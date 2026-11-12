// =============================================================
// queueArchive.js: done and cancelled tasks older than history.archiveDoneAfterDays (default 30; null = never) move
// from queue.json to <dataFolder>/queue-archive.json (owner decision B5).
//
// Why: queue.json only grew. Every command reads and parses it, the board sends it, and most of it was finished work
// nobody changes again. The archive keeps that work, read-only, out of the file every command parses.
//
// WHICH TASKS (candidates): status done or cancelled, seen so by the archive for more than N days, last touched more
// than N days ago (the latest of done, delivered, started, picked_at, added_at, t_merge, any other top-level time on the
// task such as a QA close, and every changelog entry or undo that names the task, so a task whose last change can still
// be undone stays), and none of these:
//   - an open task (not done, not cancelled) names it in depends_on, fixes or qa_original;
//   - its QA is not settled (qa_status waiting or deviation);
//   - it is a gate or kickstart task (labels gate or kickstart): knownBugGate and kickstart read those by class or key
//     to know what the owner declined, so they stay where those readers look.
// A task without any readable time is never a candidate.
//
// SEEN SINCE: not every status change leaves a time on the task (a cancel does not), so the pass keeps
// queue.terminal_since = { <id>: <time it first saw the task done or cancelled> } and a task moves only N days after
// that. A task that is open again loses its entry. So nothing moves in the first N days after the setting is turned on
// (or after an upgrade): every finished task is first seen then.
//
// THE FILE: { version: 1, tasks: [...] }, each task as it was in queue.json plus archived_at. queue.json keeps
// `archived`: { <id>: <status> } for every moved task, so an id is never given out again (the id generators and
// cli/context.mjs write read it) and a dependency on an archived task still counts as done (lib/conflicts.js).
//
// THE ORDER (crash safe): the archive is written first (atomically: a temporary file, a rename, and a .prev copy of
// the one before, lib/stateFile.js), and only then does the caller's queue let go of the tasks. A crash between the two
// leaves a task in both files: readers take the queue's copy (withArchive), and the next pass writes it again by id, so
// there is never a duplicate. A broken archive file is never written over: nothing moves and the pass says why (doctor
// shows it too). All of this runs inside the queue write (cli/context.mjs write), under the queue lock, and never from a
// track's worktree.
//
// READING: lookup(folder, id) finds one task, withArchive(queue, folder) is the queue with the archived tasks added last,
// marked archived: true (read-only: the queue's own copy wins on an id in both). restore(queue, folder, ids) puts tasks
// back in the queue (a new task depends on one, or names it in fixes).
//
// THE OWNER LOG (lib/ownerLog.js): it is keyed per task in the queue. A moved task's rows simply leave the set the log
// is compared with; a pass adds no row and removes none from the log, so nothing that moved can make receive or merge
// stop later. A restored task brings its rows back, and they are recorded by the write that restores it.
//
// Tested in lib/__tests__/queueArchive.test.ts and __tests__/historyFlow.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FILE_NAME = 'queue-archive.json';
const DAY_MS = 86_400_000;
const TERMINAL = new Set(['done', 'cancelled']);
/** Labels whose tasks stay in the queue (their readers look up the owner's decisions there). */
const KEEP_LABELS = ['gate', 'kickstart'];
const TIME_FIELDS = ['done', 'delivered', 'started', 'picked_at', 'added_at', 't_merge'];

const isObject = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const listOf = (x) => (Array.isArray(x) ? x : x == null || x === '' ? [] : [x]).map(String);

/** The archive file in a data folder. */
function archiveFile(folder) {
  return path.join(folder, FILE_NAME);
}

/** The setting: a whole number of days >= 0, or null (never). Anything else is never too; doctor names it. */
function daysOf(config) {
  const v = config?.history?.archiveDoneAfterDays;
  return Number.isInteger(v) && v >= 0 ? v : null;
}

/** The ids queue.json keeps for its archived tasks. */
function archivedIds(queue) {
  return isObject(queue?.archived) ? Object.keys(queue.archived) : [];
}

/** The latest change per task id in the changelog (an entry's time and its undo's), in ms. */
function lastTouchedByLog(queue) {
  const out = new Map();
  const bump = (id, t) => {
    const ms = Date.parse(t ?? '');
    if (Number.isFinite(ms) && !(out.get(id) >= ms)) out.set(id, ms);
  };
  for (const e of Array.isArray(queue?.changelog) ? queue.changelog : []) {
    if (!isObject(e)) continue;
    for (const c of Array.isArray(e.changes) ? e.changes : []) {
      if (c?.id == null) continue;
      bump(String(c.id), e.at);
      if (isObject(e.undone)) bump(String(c.id), e.undone.at);
    }
  }
  return out;
}

/**
 * The tasks that move now (see WHICH TASKS in the header), in queue order. Pure.
 * @param {{ tasks?: object[], changelog?: object[] }} queue
 * @param {{ days: number|null, now?: number }} o
 */
function candidates(queue, { days, now = Date.now() }) {
  if (!Number.isInteger(days) || days < 0) return [];
  const tasks = Array.isArray(queue?.tasks) ? queue.tasks : [];
  const held = new Set();
  for (const o of tasks) {
    if (!isObject(o) || TERMINAL.has(o.status)) continue;
    for (const id of [...listOf(o.depends_on), ...listOf(o.fixes), ...listOf(o.qa_original)]) held.add(id);
  }
  const byLog = lastTouchedByLog(queue);
  const limit = now - days * DAY_MS;
  return tasks.filter((o) => {
    if (!isObject(o) || o.id == null || !TERMINAL.has(o.status)) return false;
    const id = String(o.id);
    if (held.has(id)) return false;
    if (o.qa_status === 'waiting' || o.qa_status === 'deviation') return false;
    if (Array.isArray(o.labels) && o.labels.some((l) => KEEP_LABELS.includes(l))) return false;
    const seen = Date.parse(isObject(queue.terminal_since) ? (queue.terminal_since[id] ?? '') : '');
    if (!Number.isFinite(seen) || seen >= limit) return false;
    const times = TIME_FIELDS.map((f) => Date.parse(o[f] ?? '')).filter(Number.isFinite);
    for (const v of Object.values(o)) if (typeof v === 'string' && ISO.test(v)) times.push(Date.parse(v));
    if (byLog.has(id)) times.push(byLog.get(id));
    const known = times.filter(Number.isFinite);
    if (!known.length) return false;
    return Math.max(...known) < limit;
  });
}

/**
 * Keeps queue.terminal_since (see SEEN SINCE in the header; `queue` is changed in place): stamps the done and cancelled
 * tasks it has not seen yet with `now`, and drops the entries of tasks that are open again or gone. Returns whether it
 * changed anything.
 */
function stamp(queue, now = Date.now()) {
  const tasks = Array.isArray(queue?.tasks) ? queue.tasks : [];
  const old = isObject(queue.terminal_since) ? queue.terminal_since : {};
  const next = {};
  const at = new Date(now).toISOString();
  let changed = false;
  for (const o of tasks) {
    if (!isObject(o) || o.id == null || !TERMINAL.has(o.status)) continue;
    const id = String(o.id);
    next[id] = old[id] ?? at;
    if (!old[id]) changed = true;
  }
  if (Object.keys(old).some((id) => !(id in next))) changed = true;
  if (changed || queue.terminal_since !== undefined) queue.terminal_since = next;
  return changed;
}

/** The archive: { state: 'missing' | 'ok' | 'broken', tasks, error? }. */
function load(folder) {
  let text;
  try {
    text = fs.readFileSync(archiveFile(folder), 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return { state: 'missing', tasks: [] };
    return { state: 'broken', tasks: [], error: `${archiveFile(folder)} cannot be read (${e?.code ?? e?.message ?? e})` };
  }
  try {
    const s = JSON.parse(text);
    if (isObject(s) && Array.isArray(s.tasks)) return { state: 'ok', tasks: s.tasks.filter((o) => isObject(o) && o.id != null) };
  } catch {
    /* below */
  }
  return { state: 'broken', tasks: [], error: `${archiveFile(folder)} does not parse; nothing was archived (fix it or move it away)` };
}

/** Writes the archive atomically, with a .prev copy of the one before (lib/stateFile.js). */
function save(folder, tasks) {
  fs.mkdirSync(folder, { recursive: true });
  require('./stateFile.js').writeState(archiveFile(folder), `${JSON.stringify({ version: 1, tasks }, null, 2)}\n`);
}

/**
 * Moves the candidates from `queue` (changed in place) to the archive (see THE ORDER in the header). Never throws.
 * @param {object} queue
 * @param {{ folder: string, days: number|null, now?: number }} o
 * @returns {{ moved: string[], error?: string }}
 */
function archiveDone(queue, { folder, days, now = Date.now() }) {
  try {
    if (!Number.isInteger(days) || days < 0) return { moved: [] };
    stamp(queue, now);
    const list = candidates(queue, { days, now });
    if (!list.length || !folder) return { moved: [] };
    const cur = load(folder);
    if (cur.state === 'broken') return { moved: [], error: cur.error };
    const at = new Date(now).toISOString();
    const ids = new Set(list.map((o) => String(o.id)));
    // By id: a task already there (a crash between the two writes, or an id restored and archived again) is replaced.
    const kept = cur.tasks.filter((o) => !ids.has(String(o.id)));
    save(folder, [...kept, ...list.map((o) => ({ ...o, archived_at: at }))]);
    // Only now does the queue let go of them.
    queue.tasks = queue.tasks.filter((o) => !(isObject(o) && ids.has(String(o.id))));
    queue.archived = { ...(isObject(queue.archived) ? queue.archived : {}) };
    for (const o of list) {
      queue.archived[String(o.id)] = o.status;
      delete queue.terminal_since[String(o.id)];
    }
    return { moved: [...ids] };
  } catch (e) {
    return { moved: [], error: `the archive could not be written (${e?.code ?? e?.message ?? e}); nothing was archived` };
  }
}

/** One archived task by id (a copy), or null. */
function lookup(folder, id) {
  const o = load(folder).tasks.find((t) => String(t.id) === String(id));
  return o ? { ...o } : null;
}

/**
 * The queue with the archived tasks added last, each marked archived: true (a new object; the queue is not changed).
 * A task in both files is the queue's copy.
 */
function withArchive(queue, folder) {
  const tasks = Array.isArray(queue?.tasks) ? queue.tasks : [];
  const extra = folder ? load(folder).tasks : [];
  if (!extra.length) return queue;
  const have = new Set(tasks.map((o) => String(o?.id)));
  return { ...queue, tasks: [...tasks, ...extra.filter((o) => !have.has(String(o.id))).map((o) => ({ ...o, archived: true }))] };
}

/**
 * Puts archived tasks back in `queue` (changed in place) and takes them off queue.archived. The archive file keeps its
 * copy (the next pass replaces it by id), so a crash before the queue write loses nothing.
 * @returns {{ restored: string[], missing: string[] }}
 */
function restore(queue, folder, ids) {
  const want = [...new Set(listOf(ids))];
  const have = new Set((queue.tasks ?? []).map((o) => String(o?.id)));
  const arch = load(folder).tasks;
  const restored = [];
  const missing = [];
  for (const id of want) {
    if (have.has(id)) continue;
    const o = arch.find((t) => String(t.id) === id);
    if (!o) {
      missing.push(id);
      continue;
    }
    const { archived_at: _at, archived: _flag, ...task } = o;
    queue.tasks.push(task);
    if (isObject(queue.archived)) delete queue.archived[id];
    restored.push(id);
  }
  return { restored, missing };
}

/** For doctor: { tasks, bytes, state } of the archive file. */
function stats(folder) {
  let bytes = 0;
  try {
    bytes = fs.statSync(archiveFile(folder)).size;
  } catch {
    bytes = 0;
  }
  const cur = load(folder);
  return { state: cur.state, tasks: cur.tasks.length, bytes, error: cur.error };
}

module.exports = {
  FILE_NAME,
  KEEP_LABELS,
  archiveFile,
  daysOf,
  archivedIds,
  candidates,
  stamp,
  load,
  archiveDone,
  lookup,
  withArchive,
  restore,
  stats,
};
