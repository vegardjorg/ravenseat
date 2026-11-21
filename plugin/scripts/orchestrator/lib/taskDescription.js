// =============================================================
// taskDescription.js: a task's short, human-written summary (`description`, roadmap 2c4, owner decision 2026-11-19).
//
// WHY: the board panel derived "what the task is about" from the mission text (panel.js missionSummary), and a
// generated mission often opens with boilerplate, so the derived line can miss the point. The author now writes the
// point themselves in `description`; the panel shows it in the summary's place and falls back to the derived summary
// when there is none. `info` shows it too.
//
// The field is for HUMANS ONLY. Nothing that builds the agent's track block or mission reads it, so a mission is
// byte-identical with or without one (locked in __tests__/taskDescriptionFlow.test.ts). It is optional and stops
// nothing: there is no setting for it.
//
// The rules, kept in one place:
//   - text only; it is trimmed, and an empty one means "no description" (add does not store it, edit removes it);
//   - a soft limit of DESCRIPTION_SOFT_MAX characters (the panel summary's own SUMMARY_MAX): a longer one gives ONE
//     WARNING line in add and edit and is stored anyway;
//   - a line break is allowed, as in the title (validate checks neither for line breaks); info writes it as one line.
//
//   descriptionValue(v)        { value: string|null, error: string|null }: the stored form of an input value
//   descriptionErrors(task)    [] or ['description must be text'] (queueLogic.validate, so add, edit and the board)
//   descriptionWarning(id, s)  the WARNING line over the soft limit, or null
//   infoLines(task)            the info lines for description, plan, sources and source (lib/logic/monitor.js)
//   panelFields(task)          { description, sources } that /api/task adds for the board's detail panel
//
// Pure, no I/O. Used by lib/logic/validate.js, lib/logic/monitor.js, lib/queueTaskEdit.js, cli/tasks.mjs (add),
// cli/taskEdit.mjs (edit) and queue-board.mjs (/api/task). Tested in lib/__tests__/taskDescription.test.ts,
// __tests__/taskDescriptionFlow.test.ts and lib/__tests__/queueBoardPanelDescription.test.ts.
// =============================================================
'use strict';

/** The soft limit in characters: the same number as the panel's derived summary (queue-board/board/panel.js). */
const DESCRIPTION_SOFT_MAX = 320;

/** The error for a description that is not text. */
const NOT_TEXT = 'description must be text';

/**
 * The stored form of a description from add, edit or the board: trimmed text, or null for "no description"
 * (missing, null, empty or blank). Anything that is not text is an error, so the panel and info only see strings.
 * @param {unknown} v
 * @returns {{ value: string|null, error: string|null }}
 */
function descriptionValue(v) {
  if (v == null) return { value: null, error: null };
  if (typeof v !== 'string') return { value: null, error: NOT_TEXT };
  const s = v.trim();
  return { value: s || null, error: null };
}

/** The validate errors for a task's description: [] for text or none, otherwise one error. */
function descriptionErrors(task) {
  return descriptionValue(task?.description).error ? [NOT_TEXT] : [];
}

/** The length in characters (code points), so "å" or an emoji counts as one, as a reader counts them. */
const charCount = (s) => [...s].length;

/**
 * The ONE WARNING line for a description over the soft limit, or null. The description is stored either way: the
 * line only tells the author while it is cheap to shorten.
 * @param {string} id
 * @param {unknown} text
 * @returns {string|null}
 */
function descriptionWarning(id, text) {
  if (typeof text !== 'string') return null;
  const n = charCount(text);
  if (n <= DESCRIPTION_SOFT_MAX) return null;
  return (
    `WARNING: ${id}: the description is ${n} characters, over the soft limit of ${DESCRIPTION_SOFT_MAX}; it was saved ` +
    'anyway. Keep it to a short summary; the mission holds the detail.'
  );
}

/** Whitespace runs (line breaks too) as one space, so a value stays one info line. */
const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();

/** One source as info writes it: "docs/a.md § 2 (spec)", "docs/b.md". */
function sourceText(k) {
  const anchor = typeof k.anchor === 'string' && k.anchor.trim() ? ` ${k.anchor.trim()}` : '';
  const role = typeof k.role === 'string' && k.role ? ` (${k.role})` : '';
  return oneLine(`${k.path}${anchor}${role}`);
}

/** The task's own sources that have a path (the shape validate checks), or []. */
const ownSources = (task) =>
  Array.isArray(task?.sources) ? task.sources.filter((k) => k && typeof k === 'object' && typeof k.path === 'string') : [];

/**
 * The info lines (`ravenseat info <id>`) for the human summary and the links (0p2 B5), each only when set:
 *   description: <text>         (as one line)
 *   plan: <plan entry id>
 *   issue: Issue #12 https://github.com/<owner>/<name>/issues/12
 *   sources: <path anchor (role)>; ...
 *   source: <origin text>       (as one line)
 * The caller places `description` right after the title and the rest after the summary fields.
 * @returns {{ description: string[], links: string[] }}
 */
function infoLines(task) {
  const d = descriptionValue(task?.description).value;
  const links = [];
  if (typeof task?.plan === 'string' && task.plan) links.push(`plan: ${task.plan}`);
  // The GitHub issue (GH-2): the link built from the stored repo and number (lib/issueLink.js), never from issue text.
  const issue = require('./issueLink.js').issueView(task?.issue);
  if (issue) links.push(`issue: ${issue.label} ${issue.url}`);
  const src = ownSources(task);
  if (src.length) links.push(`sources: ${src.map(sourceText).join('; ')}`);
  if (typeof task?.source === 'string' && task.source.trim()) links.push(`source: ${oneLine(task.source)}`);
  return { description: d ? [`description: ${oneLine(d)}`] : [], links };
}

/**
 * What /api/task adds for the board's detail panel: the description (or null) and the task's OWN sources as
 * { path, anchor, role }. The sources go through taskLinks (lib/taskLinks.js), the same normalising and dedupe the
 * mission's read-first list uses, without a file reader: a path outside the project is dropped, "./a.md" becomes
 * "a.md", "§ 2" and "2" are one link. The plan entry's sources are not listed here (the panel links to the entry).
 * The panel draws every value as text (el with text), never as markup.
 * @returns {{ description: string|null, sources: { path: string, anchor: string|null, role: string|null }[] }}
 */
function panelFields(task) {
  const TL = require('./taskLinks.js');
  const own = ownSources(task);
  const sources = own.length
    ? TL.taskLinks({ sources: own })
        .links.filter((l) => l.from === 'sources')
        .map((l) => ({ path: l.path, anchor: l.anchor, role: l.role }))
    : [];
  return { description: descriptionValue(task?.description).value, sources };
}

module.exports = {
  DESCRIPTION_SOFT_MAX,
  descriptionValue,
  descriptionErrors,
  descriptionWarning,
  infoLines,
  panelFields,
};
