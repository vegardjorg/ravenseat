// =============================================================
// ownershipHints.js: better ownership from the start.
//
// `merge` keeps the files a task actually changed on the task (changed_files, changedFilesOf). When a new task is added,
// coChangeHints compares its owned_files with that history: a file that earlier tasks changed together with the new
// task's files, in at least two of them and at least half, is named as a hint. The owner can then add it to owned_files
// before the track starts, instead of meeting it as an ownership stop or drift at merge (lib/mergeGuard.js).
// A hint, never a refusal: history is a guess about the future.
//
// Used by: cli/merge.mjs (changedFilesOf), cli/tasks.mjs add (hintLines).
// Tested in: lib/__tests__/ownershipHints.test.ts.
// =============================================================
'use strict';

const { norm, fileOverlap } = require('./logic/conflicts.js');

/** At most this many changed files are kept per task (a huge rename should not bloat queue.json). */
const MAX_CHANGED = 300;
/** A file must have been changed in at least this many of the matching tasks... */
const MIN_SEEN = 2;
/** ...and in at least this share of them. */
const MIN_SHARE = 0.5;
/** At most this many files are named per task. */
const MAX_NAMED = 5;

/** The changed files as merge stores them: normalized, each once, at most MAX_CHANGED. */
function changedFilesOf(names) {
  const out = [];
  const seen = new Set();
  for (const n of names ?? []) {
    const p = norm(String(n ?? '').trim());
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
    if (out.length >= MAX_CHANGED) break;
  }
  return out;
}

/**
 * The files earlier done tasks changed together with this task's owned_files, that this task does not own.
 * A matching task = a done task with changed_files that overlap the new task's owned_files.
 * @returns {{ file: string, seen: number, of: number }[]} most often seen first, then by name
 */
function coChangeHints(o, tasks) {
  const own = (o?.owned_files ?? []).map(norm);
  if (!own.length) return [];
  const owns = (f) => own.some((g) => fileOverlap(f, g));
  let of = 0;
  const count = new Map();
  for (const t of tasks ?? []) {
    if (t?.status !== 'done' || t.id === o.id || !Array.isArray(t.changed_files)) continue;
    const files = t.changed_files.map(norm);
    if (!files.some(owns)) continue;
    of += 1;
    for (const f of new Set(files)) if (!owns(f)) count.set(f, (count.get(f) ?? 0) + 1);
  }
  if (of < MIN_SEEN) return [];
  return [...count]
    .filter(([, n]) => n >= MIN_SEEN && n / of >= MIN_SHARE)
    .map(([file, seen]) => ({ file, seen, of }))
    .sort((a, b) => b.seen - a.seen || a.file.localeCompare(b.file));
}

/** One line per task with hints, for `add` (empty when there is nothing to say). */
function hintLines(o, tasks, { ravenseat = 'ravenseat' } = {}) {
  const h = coChangeHints(o, tasks);
  if (!h.length) return [];
  const named = h.slice(0, MAX_NAMED).map((x) => `${x.file} (${x.seen} of ${x.of})`);
  const more = h.length > MAX_NAMED ? `, and ${h.length - MAX_NAMED} more` : '';
  return [
    `OWNERSHIP HINT ${o.id}: earlier tasks that changed its files also changed ${named.join(', ')}${more}. ` +
      `If this task will touch them, add them now (${ravenseat} edit ${o.id} --files <files>): a file another task owns ` +
      'stops the merge, and one nobody owns is drift.',
  ];
}

module.exports = { MAX_CHANGED, changedFilesOf, coChangeHints, hintLines };
