// =============================================================
// startChecks.js: the checks before a task starts (roadmap 3c, PS-1..4, plans/drift-vurdering-2026-11-21.md).
//
// WHY: a task that is unclear about its files or its size costs a track, and the queue found out only at the merge (a
// drift WARNING) or never. These checks say it at `add` and again at `start` / `fill`, when it is still cheap to fix.
// Each one is a WARNING or a NOTE only: nothing here ever stops a task.
//
//   PS-1 missionPaths       the repo paths the title or mission names that are not in owned_files, shared_patch,
//                           hotspot_patch or reads. Only real paths: one with a folder and an extension, a folder or file
//                           that exists in the tree, or a bare file name that exists. Never a URL, an absolute path, a
//                           glob, "and/or" or other prose. One line per task, at most MAX_NAMED paths plus "and N more".
//   PS-2 emptyOwnership     a K, D or D+ task with no owned_files: nothing is promised, so the merge guard reports no
//                           drift and parallel tracks are not kept off its files.
//   PS-3 sizeNotSet         a D or D+ task without content_min. `add` stores null instead of 30 (the estimate still
//                           counts 30 for planning, queueLogic.estimate), and where the size is shown it says it is a guess.
//   PS-4 ownerQuestionCount at `receive`: ownerQuestions=<n> on the RESULT line against the items under the report's
//                           owner question heading. A mismatch is a NOTE, so a question the count left out is still read.
//
// Settings: planChecks.missionPaths, .emptyOwnership, .sizeNotSet, .ownerQuestionCount (all on by default, since none
// can stop work). Friction: one line per task at add and start, only when the check finds something.
//
// Pure logic: the caller passes `exists` (does a repo-relative path exist in the tree). Used by cli/tasks.mjs (add),
// cli/run.mjs (start, fill) and cli/merge.mjs (receive). Tested in lib/__tests__/startChecks.test.ts.
// =============================================================
'use strict';

const G = require('./mergeGuard.js');

/** At most this many paths are named on the PS-1 line. */
const MAX_NAMED = 5;
/** The classes whose empty owned_files is worth a warning (U is an investigation without code). */
const OWNERSHIP_CLASSES = new Set(['K', 'D', 'D+']);
/** The classes whose missing content_min is worth a warning (K defaults to 30 by design, U is fixed work). */
const SIZE_CLASSES = new Set(['D', 'D+']);
/** The word the size views use (lib/queueProposals.js SIZE_NOT_SET says the same). */
const SIZE_NOT_SET = 'size not set';

/** The four switches, each on unless the config says false. */
function setup(config) {
  const own = config?.planChecks && typeof config.planChecks === 'object' ? config.planChecks : {};
  const on = (k) => own[k] !== false;
  return {
    missionPaths: on('missionPaths'),
    emptyOwnership: on('emptyOwnership'),
    sizeNotSet: on('sizeNotSet'),
    ownerQuestionCount: on('ownerQuestionCount'),
  };
}

const norm = (p) => String(p ?? '').trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '');

/**
 * One token from the text as a repo path, or null. `exists` is asked for the path without a trailing slash.
 * A path must have a folder and an extension, or exist in the tree (a bare name only when it exists).
 */
function asPath(raw, exists) {
  // Quotes, brackets and the punctuation that ends a sentence are not part of the path.
  let s = String(raw).replace(/^[`'"([{<]+/, '').replace(/[`'")\]}>,;:!?.]+$/, '');
  if (!s || s.length > 200) return null;
  if (/:\/\/|^www\./i.test(s) || /^[a-z]:/i.test(s) || /^[/~]/.test(s) || s.startsWith('..')) return null;
  if (/[*?<>|"'`$%&=@#]/.test(s)) return null;
  s = norm(s);
  if (!/^[\w.\-/]+$/.test(s) || !/[A-Za-z]/.test(s)) return null;
  const parts = s.replace(/\/$/, '').split('/');
  if (parts.some((x) => !x || x === '.' || x === '..')) return null;
  // A domain as the first folder (example.com/a.js) is a link without its scheme.
  if (parts.length > 1 && /^([a-z0-9-]+\.)+[a-z]{2,}$/i.test(parts[0]) && !parts[0].startsWith('.')) return null;
  const last = parts[parts.length - 1];
  const hasExt = /^[^.].*\.[A-Za-z][A-Za-z0-9]{0,7}$/.test(last) || /^\.[A-Za-z]/.test(last);
  const bare = s.replace(/\/$/, '');
  if (parts.length > 1 && hasExt) return s;
  return exists(bare) ? s : null;
}

/** Is the path covered by the task's own lists (owned, shared, hotspot patch, reads)? */
function covered(p, lists) {
  if (!lists.length) return false;
  if (G.inList(p, lists)) return true;
  const bare = p.replace(/\/$/, '').toLowerCase();
  return lists.some((x) => {
    const e = norm(x).replace(/\/$/, '').toLowerCase();
    // The same folder with or without its slash, a path under an owned folder written without one ("lib/x"), and a
    // named folder that holds an owned path ("work in docs/" while owning docs/queue.md).
    return e === bare || bare.startsWith(`${e}/`) || e.startsWith(`${bare}/`);
  });
}

/**
 * PS-1: the repo paths the title or mission names that the task does not own, share or read, in the order they appear.
 * @param {object} task `mission` is the text (the caller reads a mission file first)
 * @param {{ exists: (p: string) => boolean, skip?: string[] }} o
 * @returns {string[]}
 */
function missionPaths(task, { exists = () => false, skip = [] } = {}) {
  const text = `${task?.title ?? ''}\n${task?.mission ?? ''}`;
  const lists = [
    ...(task?.owned_files ?? []),
    ...(task?.shared_patch ?? []),
    ...(task?.hotspot_patch ?? []),
    ...(task?.reads ?? []),
  ]
    .map(norm)
    .filter(Boolean);
  const skipped = new Set(skip.map((x) => norm(x).toLowerCase()));
  const out = [];
  const seen = new Set();
  for (const raw of text.split(/[\s,]+/)) {
    const p = asPath(raw, exists);
    if (!p) continue;
    const key = p.toLowerCase();
    if (seen.has(key) || skipped.has(key)) continue;
    seen.add(key);
    if (!covered(p, lists)) out.push(p);
  }
  return out;
}

/** The PS-1 line for a task, or null when nothing is named. */
function missionPathLine(task, paths, { ravenseat = 'ravenseat' } = {}) {
  if (!paths?.length) return null;
  const named = paths.slice(0, MAX_NAMED).join(', ');
  const more = paths.length > MAX_NAMED ? ` and ${paths.length - MAX_NAMED} more` : '';
  return (
    `WARNING: ${task.id}: the mission names ${paths.length === 1 ? 'a path' : 'paths'} the task does not own, share or read: ` +
    `${named}${more}. If the track is to change ${paths.length === 1 ? 'it' : 'them'}, add ${paths.length === 1 ? 'it' : 'them'} ` +
    `(${ravenseat} edit ${task.id} --files <files>, or reads / shared_patch); a change there is otherwise drift at the merge. ` +
    'Only mentioned: nothing to do.'
  );
}

/** PS-2: the line for a K, D or D+ task with no owned_files, or null. */
function emptyOwnershipLine(task, { ravenseat = 'ravenseat' } = {}) {
  if (!OWNERSHIP_CLASSES.has(task?.class) || (task?.owned_files ?? []).length) return null;
  return (
    `WARNING: ${task.id}: class ${task.class} with no owned_files: nothing is promised, so the merge reports no drift and ` +
    `parallel tracks are not kept off its files. Add them: ${ravenseat} edit ${task.id} --files <files>.`
  );
}

/** PS-3: a D or D+ task without its own size (content_min missing or null). */
const sizeNotSet = (task) => SIZE_CLASSES.has(task?.class) && task?.content_min == null;

/** The PS-3 line, or null. */
function sizeNotSetLine(task, { ravenseat = 'ravenseat' } = {}) {
  if (!sizeNotSet(task)) return null;
  return (
    `WARNING: ${task.id}: class ${task.class} without content_min (${SIZE_NOT_SET}): the estimate counts 30 content ` +
    `minutes, a guess. Set it: ${ravenseat} edit ${task.id} --json '{"content_min":60}'.`
  );
}

/** "60 min", or "60 min (size not set, a guess)" for a D or D+ without its own size. */
function estimateText(task, minutes) {
  return `${minutes} min${sizeNotSet(task) ? ` (${SIZE_NOT_SET}, a guess)` : ''}`;
}

/**
 * The checks for one task at add or start, as lines (nothing when every check is quiet or off).
 * @param {object} task the mission as text
 * @param {{ config?: object, exists?: (p: string) => boolean, skip?: string[], ravenseat?: string, lite?: boolean }} o
 *   lite: lite mode has no ownership, so PS-1 and PS-2 say nothing there
 */
function warningLines(task, { config = {}, exists = () => false, skip = [], ravenseat = 'ravenseat', lite = false } = {}) {
  const on = setup(config);
  const lines = [];
  if (on.missionPaths && !lite) lines.push(missionPathLine(task, missionPaths(task, { exists, skip }), { ravenseat }));
  if (on.emptyOwnership && !lite) lines.push(emptyOwnershipLine(task, { ravenseat }));
  if (on.sizeNotSet) lines.push(sizeNotSetLine(task, { ravenseat }));
  return lines.filter(Boolean);
}

/** The items in an owner question section: the top-level list items, else the paragraphs. */
function questionItems(section) {
  const lines = String(section ?? '').split(/\r?\n/);
  const marks = lines.map((l) => l.match(/^(\s*)(?:[-*+]|\d+[.)])\s+\S/)).filter(Boolean);
  if (marks.length) {
    const top = Math.min(...marks.map((m) => m[1].length));
    return marks.filter((m) => m[1].length === top).length;
  }
  return String(section ?? '')
    .split(/\r?\n\s*\r?\n/)
    .filter((p) => p.trim()).length;
}

/**
 * PS-4: a NOTE when ownerQuestions=<n> on the RESULT line and the report's owner question section disagree, or null.
 * No count on the line, or no section at all, is no mismatch (receive already says when the section is missing).
 */
function ownerQuestionNote({ result, reportText = null, reply = null, config = {} }) {
  if (!setup(config).ownerQuestionCount) return null;
  const count = result?.ownerQuestions;
  if (count == null) return null;
  const R = require('./logic/results.js');
  const section = R.ownerQuestionSection(reportText) ?? R.ownerQuestionSection(reply);
  if (!section) return null;
  const items = questionItems(section);
  if (items === count) return null;
  return (
    `NOTE: the RESULT line says ownerQuestions=${count}, but the report's owner question section has ${items} ` +
    `item(s). Read the section before you answer or merge; a question the count left out is still a question.`
  );
}

module.exports = {
  MAX_NAMED,
  SIZE_NOT_SET,
  setup,
  missionPaths,
  missionPathLine,
  emptyOwnershipLine,
  sizeNotSet,
  sizeNotSetLine,
  estimateText,
  warningLines,
  questionItems,
  ownerQuestionNote,
};
