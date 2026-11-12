// =============================================================
// ownerLog.js: the owner log, the record of the owner rows the queue CLI itself wrote (owner decision B2).
//
// Why: an owner row is a row in queue.json that says the owner decided something a track relies on: a changelog entry
// or an undo by the owner (an edit that widened owned_files, raised a limit), the owner's answer in `resumed`, a
// resolution of one of the task's questions, a hand approval (`approved` that the auto-accept did not write) and a task
// the owner added. queue.json is a plain file, so a track (with a shell write, or text it read that told it to) could
// write such a row itself, and receive and merge would believe it. The text guard (lib/gateEvidence.js tamperReason,
// review 2026-11-11 S3) reads command text only.
//
// The rule: every queue write through the CLI (cli/context.mjs write(), under the queue lock) records the keys of the
// owner rows it ADDED: the rows in what it writes that were not in the file on disk just before. A row that shows up in
// queue.json without such a write (a shell write, a hand edit, another tool) is missing from the log, and receive and
// merge stop on it (gateEvidence.mode own and external; off does not check). The owner confirms a row that was theirs
// with `ravenseat owner-log accept <id> --by owner`. A write from a track worktree (queueBranchId) records nothing.
//
// The first use (no log file): every owner row there is becomes the baseline, as the accepted git baseline does
// (lib/gitSurfaceBaseline.js). A row forged before the upgrade is therefore accepted once; from then on it is checked. A
// broken log file is read as an empty log that is not a first use: every row is missing until accepted, never a new
// baseline over a file someone broke.
//
// A key is a hash of the row's content (kind, task, the fields that say what was decided), so an answer whose text was
// changed afterwards is a new row. Labels name the row without its text (never an answer or a note).
//
// Limits, on purpose: the agents run as the same OS user. The log is a file in the data folder; the push guard denies a
// queue agent's shell command that names it (tamperReason) and the write guard covers the file tools, but a hostile
// process can still write both files. A task field changed straight in queue.json WITHOUT an owner row (owned_files
// edited, no changelog entry) is not an owner row and is not caught here.
//
// The file: <dataFolder>/owner-log.json, { version: 1, since, entries: [{ key, task, kind, at, accepted_by? }] }
// (the newest last, at most MAX_ENTRIES). Pure except the file functions (one small file, written atomically).
// Tested in lib/__tests__/ownerLog.test.ts and __tests__/gateEvidenceFlow.test.ts.
// =============================================================
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** The log's file name in the data folder. */
const FILE_NAME = 'owner-log.json';
/** Entries kept (the oldest dropped first; an old task's row dropped here is missing again and asks for an accept). */
const MAX_ENTRIES = 20000;
/** Who is the owner in a row's `by` (the board calls the CLI with --by theBoard). */
const OWNER_BY = new Set(['owner', 'theBoard']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isOwner = (by) => OWNER_BY.has(String(by ?? '').trim());
const hash = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex').slice(0, 32);

/** The log file in a data folder. */
function logFile(folder) {
  return path.join(folder, FILE_NAME);
}

/** The task ids a changelog entry touches (its changes[].id). */
function entryTasks(entry) {
  const out = [];
  for (const c of Array.isArray(entry?.changes) ? entry.changes : [])
    if (c?.id != null && !out.includes(String(c.id))) out.push(String(c.id));
  return out;
}

/** Does question `q` belong to task `o` (in its waiting_on, `<id>.<anything>`, or the id itself)? */
function questionOf(q, o) {
  const id = String(o.id);
  return q === id || q.startsWith(`${id}.`) || (Array.isArray(o.waiting_on) && o.waiting_on.includes(q));
}

/**
 * The owner rows task `id` relies on: [{ key, kind, label, task }]. Kinds: changelog, undo, answer, resolution,
 * approved, added. Never an agent's or the orchestrator's own writes, never an approval the auto-accept wrote. Pure.
 */
function rowsOf(queue, id) {
  const o = (Array.isArray(queue?.tasks) ? queue.tasks : []).find((t) => isObject(t) && String(t.id) === String(id));
  if (!o) return [];
  const task = String(o.id);
  const out = [];
  const add = (kind, label, content) => out.push({ key: hash({ kind, task, content }), kind, label, task });
  for (const e of Array.isArray(queue?.changelog) ? queue.changelog : []) {
    if (!isObject(e) || !entryTasks(e).includes(task)) continue;
    if (isOwner(e.by))
      add('changelog', `changelog #${e.nr} (${e.action ?? 'edit'} by ${e.by})`, { nr: e.nr, at: e.at, by: e.by, action: e.action, changes: e.changes });
    if (isObject(e.undone) && isOwner(e.undone.by))
      add('undo', `undo of changelog #${e.nr} (by ${e.undone.by})`, { nr: e.nr, at: e.undone.at, by: e.undone.by });
  }
  (Array.isArray(o.resumed) ? o.resumed : []).forEach((r, i) => {
    if (isObject(r) && isOwner(r.by))
      add('answer', `answer ${i + 1} in resumed (by ${r.by}, ${r.answered_at ?? 'no time'})`, { i, answer: r.answer, at: r.answered_at, by: r.by });
  });
  for (const [q, r] of Object.entries(isObject(queue?.resolutions) ? queue.resolutions : {})) {
    if (!isObject(r) || !isOwner(r.by) || !questionOf(q, o)) continue;
    add('resolution', `resolution of ${q} (by ${r.by})`, { q, time: r.time, by: r.by, answer: r.answer ?? null });
  }
  if (o.approved) {
    const auto = (Array.isArray(queue?.auto_accepted) ? queue.auto_accepted : []).some(
      (x) => String(x?.id) === task && x?.at === o.approved,
    );
    if (!auto) add('approved', `approval of ${task} (${o.approved_by ?? 'by hand'})`, { at: o.approved, by: o.approved_by ?? null });
  }
  if (isOwner(o.added_by)) add('added', `${task} added by ${o.added_by}`, { by: o.added_by, at: o.added_at ?? null });
  return out;
}

/** The keys of every owner row of every task in the queue. Pure. */
function keySet(queue) {
  const keys = new Set();
  for (const o of Array.isArray(queue?.tasks) ? queue.tasks : [])
    if (isObject(o) && o.id != null) for (const r of rowsOf(queue, o.id)) keys.add(r.key);
  return keys;
}

/** The log from the file: { state: 'missing' | 'broken' | 'ok', log }. */
function load(folder) {
  let text;
  try {
    text = fs.readFileSync(logFile(folder), 'utf8');
  } catch {
    return { state: 'missing', log: { version: 1, since: null, entries: [] } };
  }
  try {
    const s = JSON.parse(text);
    if (isObject(s) && Array.isArray(s.entries)) return { state: 'ok', log: { version: 1, since: s.since ?? null, entries: s.entries.filter(isObject) } };
  } catch {
    // broken: an empty log, not a first use (below)
  }
  return { state: 'broken', log: { version: 1, since: null, entries: [] } };
}

/** Writes the log atomically (a temporary file and a rename). */
function save(folder, log) {
  const file = logFile(folder);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ ...log, entries: log.entries.slice(-MAX_ENTRIES) })}\n`);
  fs.renameSync(tmp, file);
}

/** The log with every owner row of the queue added (the first use). */
function baselineOf(queue) {
  const at = new Date().toISOString();
  const entries = [];
  for (const o of Array.isArray(queue?.tasks) ? queue.tasks : [])
    if (isObject(o) && o.id != null) for (const r of rowsOf(queue, o.id)) entries.push({ key: r.key, task: r.task, kind: r.kind, at, baseline: true });
  return { version: 1, since: at, entries };
}

/**
 * Records the owner rows a queue write added: those in `after` whose key was not in `before` (keySet of the file on
 * disk just before the write). With no log file yet, the whole of `after` is the baseline. A write from a track
 * worktree (`inTrack`) records nothing. Never throws.
 * @returns {{ recorded: number }}
 */
function recordWrite(folder, { before, after, inTrack = false }) {
  try {
    if (inTrack || !folder) return { recorded: 0 };
    const { state, log } = load(folder);
    if (state === 'missing') {
      const base = baselineOf(after);
      save(folder, base);
      return { recorded: base.entries.length };
    }
    const had = new Set(log.entries.map((e) => e.key));
    const at = new Date().toISOString();
    let recorded = 0;
    for (const o of Array.isArray(after?.tasks) ? after.tasks : []) {
      if (!isObject(o) || o.id == null) continue;
      for (const r of rowsOf(after, o.id)) {
        if (before?.has?.(r.key) || had.has(r.key)) continue;
        had.add(r.key);
        log.entries.push({ key: r.key, task: r.task, kind: r.kind, at });
        recorded++;
      }
    }
    if (recorded) save(folder, log);
    return { recorded };
  } catch {
    return { recorded: 0 }; // error-ignored: a row left out is missing at receive and merge, the owner accepts it
  }
}

/**
 * The owner rows of task `id` the log does not have. The first use (no file) records every row there is and reports
 * none missing; a broken file reports every row missing.
 * @returns {{ baseline: boolean, missing: { key: string, kind: string, label: string, task: string }[] }}
 */
function check(folder, queue, id) {
  const { state, log } = load(folder);
  if (state === 'missing') {
    try {
      save(folder, baselineOf(queue));
    } catch {
      return { baseline: false, missing: rowsOf(queue, id) }; // no log could be written: nothing is confirmed
    }
    return { baseline: true, missing: [] };
  }
  const had = new Set(log.entries.map((e) => e.key));
  return { baseline: false, missing: rowsOf(queue, id).filter((r) => !had.has(r.key)) };
}

/**
 * The owner confirms the missing rows of task `id` as theirs (`ravenseat owner-log accept <id> --by owner`). Only
 * `by` owner or theBoard. A broken file is replaced by a log with these rows (the other tasks' rows are then missing).
 * @returns {{ ok: boolean, accepted: number, error?: string }}
 */
function accept(folder, queue, id, by) {
  if (!isOwner(by)) return { ok: false, accepted: 0, error: 'only the owner accepts owner rows (--by owner)' };
  const { state, log } = load(folder);
  if (state === 'missing') {
    save(folder, baselineOf(queue));
    return { ok: true, accepted: 0 };
  }
  const had = new Set(log.entries.map((e) => e.key));
  const at = new Date().toISOString();
  let accepted = 0;
  for (const r of rowsOf(queue, id)) {
    if (had.has(r.key)) continue;
    log.entries.push({ key: r.key, task: r.task, kind: r.kind, at, accepted_by: String(by).trim() });
    accepted++;
  }
  if (accepted || state === 'broken') save(folder, { ...log, since: log.since ?? at });
  return { ok: true, accepted };
}

/** The stop text for receive and merge when owner rows are missing. */
function stopMessage({ id, missing, ravenseat = 'ravenseat', again, file }) {
  const list = (missing ?? []).map((r) => `  - ${r.label}`).join('\n');
  return [
    `STOP: ${id} relies on ${missing.length} owner row(s) in queue.json that no ${ravenseat} write recorded in the owner log (${file}):`,
    list,
    'They were written into the queue file some other way (a shell write, a hand edit or another tool). Nothing changed.',
    `If they are yours: ${ravenseat} owner-log accept ${id} --by owner, then ${again}.`,
    `If not: take them out of the queue file, or set them again with ${ravenseat}, and find out what wrote them.`,
    `(${ravenseat} owner-log ${id} lists the rows; gateEvidence.mode off turns this check off.)`,
  ].join('\n');
}

module.exports = { FILE_NAME, MAX_ENTRIES, OWNER_BY, logFile, rowsOf, keySet, load, recordWrite, check, accept, stopMessage };
