// =============================================================
// taskFields.js: the task fields the queue knows, and the warning for one it does not.
//
// Why: a task file with a misspelled field (`owns` for `owned_files`) was added without a word. The queue never reads
// the unknown field, so the task ran without what the author meant (here: no owned files, so no ownership guard), and
// nothing said so until a NOTE at merge. `ravenseat add` already warned for a few known wrong names (`minutes` for
// content_min, test round 4) and keeps the task, so an unknown field is warned about the same way: the task is added, and
// one WARNING line per field names it and the nearest known field.
//
// KNOWN holds every field a task can carry: the ones an author sets (docs/queue.md, A task) and the ones the queue
// writes itself (status, attempts, gate_check, wiring, ...), so a task copied from another queue file gets no warning. A
// field the queue starts to write or read is added here in the same change; lib/__tests__/taskFields.test.ts keeps the
// fields of docs/queue.md in the list.
//
// Pure, no I/O. Used by cli/tasks.mjs (cmdAdd). Tested in lib/__tests__/taskFields.test.ts and
// __tests__/queueAddFields.test.ts.
// =============================================================
'use strict';

const { editDistance } = require('./cliHelp.js');

/** The fields an author sets in a task file (docs/queue.md, A task, and the optional fields after it). */
const AUTHOR = [
  'id', 'title', 'domain', 'class', 'mission', 'value', 'content_min', 'depends_on', 'waiting_on', 'owned_files',
  'owner_db', 'shared_patch', 'hotspot_patch', 'reads', 'project', 'feature', 'source', 'sources', 'batched',
  'done_when', 'acceptance', 'max_fix_rounds', 'fixes', 'plan', 'labels', 'requires', 'evidence', 'qa_status',
  'status', 'description', 'roadmap', 'priority_reason', 'priority_set_by', 'priority_bonus', 'bonus', 'deadline',
  'external', 'external_name', 'parallel', 'critical', 'migr_block', 'migr_tens', 'remarks', 'triage', 'own_track',
];

/** The fields the queue writes on a task itself (start, delivery, review, merge, QA, cloud, proposals, archive). */
const WRITTEN = [
  'added_at', 'added_by', 'approved', 'approved_by', 'proposal', 'started', 'branch', 'scratchpad', 'picked_at',
  'picked_by', 'attempts', 'resumed', 'fix_rounds', 'blocks', 'delivered', 'delivered_partial', 'delivered_sha',
  'report_seen', 'report_received', 'result', 'done', 'done_check', 'done_outside_queue', 'gate_check', 'wiring',
  'review_package', 'review_sha', 'review_base', 'review_at', 'review_reviewers', 'verification', 'merge_commit',
  'merge_sha', 'merge_conflict', 'merged_from', 'red_on_base', 'findings', 'qa_note', 'qa_ok', 'qa_ok_by',
  'qa_original', 'parked', 'snoozed', 'cloud', 'agent', 'agent_boost', 'head_start', 'silent', 'snapshots', 'cost',
  'claude_fp', 'triage_asked', 'triage_log', 'now_category', 'wind', 'drop_reason', 'undone', 'closed', 'track',
  'focus', 't_receive', 't_merge', 'diff_lines', 'changed_files', 'archived_at',
];

const KNOWN = Object.freeze([...new Set([...AUTHOR, ...WRITTEN])]);
const KNOWN_SET = new Set(KNOWN);

/**
 * Slips that are close in meaning, not in spelling, so the edit distance would point elsewhere (`owns` is nearer to
 * `own_track` than to `owned_files` by letters).
 */
const ALIAS = Object.freeze({
  owns: 'owned_files',
  owned: 'owned_files',
  own_files: 'owned_files',
  owner_files: 'owned_files',
  ownedfiles: 'owned_files',
  deps: 'depends_on',
  dependencies: 'depends_on',
  depends_upon: 'depends_on',
  waits_on: 'waiting_on',
  done_command: 'done_when',
});

/**
 * The known field closest to `name`, or null when none is close. An ALIAS first; otherwise an edit distance of at most
 * a third of the longer word (at least 2), measured against the whole field and against its first part before `_`, so
 * `dependson` finds `depends_on` and `titel` finds `title`.
 */
function nearest(name, known = KNOWN) {
  const w = String(name ?? '').toLowerCase();
  if (!w) return null;
  if (Object.hasOwn(ALIAS, w) && known.includes(ALIAS[w])) return ALIAS[w];
  let best = null;
  const limit = (other) => Math.max(2, Math.floor(Math.max(w.length, other.length) / 3));
  for (const k of known) {
    const whole = editDistance(w, k);
    const first = k.split('_')[0];
    const head = k.includes('_') ? editDistance(w, first) : Infinity;
    // A match on the first part ranks half a step behind the same distance on the whole field.
    const score = Math.min(whole <= limit(k) ? whole : Infinity, head <= limit(first) ? head + 0.5 : Infinity);
    if (score !== Infinity && (!best || score < best.score || (score === best.score && k < best.k))) best = { k, score };
  }
  return best ? best.k : null;
}

/**
 * The fields of `task` that no task has, each with its nearest known field: [{ field, near }] (near null when none is
 * close). `skip` names fields the caller warns about itself. Empty for a valid task or a value that is not an object.
 */
function unknownFields(task, skip = []) {
  if (!task || typeof task !== 'object' || Array.isArray(task)) return [];
  const skipped = new Set(skip);
  return Object.keys(task)
    .filter((k) => !KNOWN_SET.has(k) && !skipped.has(k))
    .map((field) => ({ field, near: nearest(field) }));
}

/** The warning line for one unknown field of task `id`. */
function unknownFieldWarning(id, { field, near }) {
  return `WARNING: ${id}: unknown field "${field}"; the queue does not read it${near ? ` (did you mean ${near}?)` : ''}.`;
}

module.exports = { KNOWN, nearest, unknownFields, unknownFieldWarning };
