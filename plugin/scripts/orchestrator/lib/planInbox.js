// =============================================================
// planInbox.js: quick capture into the plan register's Inbox (`ravenseat plan capture`, the board's "+ New plan").
// P6 of plans/plans-tab-ux-review-2026-11-19.md (section 7.3); the owner answered the questions "as recommended".
//
// Why: an idea should take one step to write down, a title and a few sentences in the owner's own words. No id,
// project, priority or category to choose: Claude sorts the Inbox later (P7), and the owner confirms.
//
// What is stored: a normal plan entry, so the register stays one list and nothing needs a second store.
//   - id from the title (queuePlanView.entrySuggestion, e.g. PL-DARK-MODE-1), collision safe against the entries and the
//     archive (ids are never reused), stable for life;
//   - title, and summary = the text as written (owner question 3: summary, not a file per idea);
//   - project general (created on first use by the CLI, as `ravenseat finding` does), priority later, maturity idea,
//     priority_set_by owner (owner question 4: the owner captured it, so rule 2's owner question does not apply);
//   - the tool-owned field `inbox` { at, by: 'owner' }. queuePlan.editEntry removes it when the entry is sorted (a new
//     priority or maturity, or `plan edit --field inbox=null`); nobody sets it by hand.
// A captured plan is IN THE INBOX while it has the marker, is not dropped, and no queue task points to it (a task with
// plan = id has sorted it, the same rule as for findings). The same title again while it still waits there writes
// nothing (a double click or a second terminal is not two plans).
//
// Pure, no I/O: the CLI (cli/plans.mjs plan capture) does the lock and the write through cli/planShared.mjs editPlans,
// so the board's Undo is `plan undo --nr`. Tested in lib/__tests__/planInbox.test.ts.
// =============================================================
'use strict';

const P = require('./queuePlan.js');
const V = require('./queuePlanView.js');
const FI = require('./queueFindings.js');

// The limits, one set for the form, the server and the CLI (queuePlanView.CAPTURE): the title is a heading (the
// register's own limit, 160); the form shows a note past TEXT_SOFT ("about 2000 characters" in the plan) but saves the
// text as written; TEXT_MAX refuses a paste of a whole document with a clear reason.
const { TITLE_MAX, TEXT_SOFT, TEXT_MAX } = V.CAPTURE;
/** Where a captured plan lands until it is sorted. */
const PROJECT = 'general';
const PROJECT_FIELDS = Object.freeze({ title: 'General' });

/**
 * The capture input from the form, `--file` or the arguments: only the title is required.
 * @param {{ title?: unknown, text?: unknown }} raw
 * @returns {{ title: string, text: string|null, error: string[] }}
 */
function captureInput(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const title = typeof s.title === 'string' ? s.title.replace(/\s+/g, ' ').trim() : '';
  const error = [];
  if (!title) error.push('a title is needed');
  else if (title.length > TITLE_MAX) error.push(`the title is over ${TITLE_MAX} characters (the text is the place for more)`);
  let text = null;
  if (s.text != null && typeof s.text !== 'string') error.push('the text must be text');
  else if (typeof s.text === 'string') {
    const t = s.text.replace(/\r\n?/g, '\n').trim();
    if (t.length > TEXT_MAX) error.push(`the text is over ${TEXT_MAX} characters (a long plan belongs in a document)`);
    text = t || null;
  }
  return { title, text, error };
}

/**
 * Captures a plan into the Inbox (mutates `reg` only when it is valid and new).
 * @param {object} reg the plan register (normalized)
 * @param {{ title: string, text?: string|null }} input
 * @param {{ projects?: object, question?: object, now?: string }} ctx  queue.json projects (must hold `general`)
 * @returns {{ error: string[], warnings: string[], entry?: object, created?: boolean, duplicate?: string }}
 */
function capturePlan(reg, input, ctx = {}) {
  const now = ctx.now ?? new Date().toISOString();
  const c = captureInput(input);
  if (c.error.length) return { error: c.error, warnings: [] };
  const key = FI.findingKey(c.title);
  const entries = reg.entries ?? [];
  const waiting = entries.find((p) => p.inbox && FI.findingKey(p.title) === key);
  if (waiting) return { error: [], warnings: [], entry: waiting, duplicate: waiting.id };
  const used = new Set([...entries.map((p) => p.id), ...Object.keys(reg.archive ?? {})]);
  const { id } = V.entrySuggestion(c.title, used);
  const s = P.newEntry(
    reg,
    { id, title: c.title, ...(c.text ? { summary: c.text } : {}), project: PROJECT, priority: 'later', maturity: 'idea' },
    { role: 'owner', projects: ctx.projects ?? {}, question: ctx.question ?? {}, now },
  );
  if (s.error.length) return s;
  s.entry.inbox = { at: now, by: 'owner' };
  // A plan with the same title that is already sorted: captured anyway (the owner meant to write it down), with a
  // pointer, so the sorting can merge them.
  const same = entries.filter((p) => p !== s.entry && FI.findingKey(p.title) === key).map((p) => p.id);
  // "the project general has no module" is no news for a capture (the sorting picks the real project), so it is left
  // out, as `ravenseat finding` does.
  const warnings = s.warnings.filter((x) => !x.includes('has no module'));
  if (same.length) warnings.push(`${id}: the same title as ${same.join(', ')} (merge them when sorting if they are one plan)`);
  return { ...s, warnings, created: true };
}

/** Is the entry a captured plan that still waits in the Inbox? `tasks` = queue.json tasks. */
function isInInbox(entry, tasks = []) {
  if (!entry?.inbox || entry.priority === 'drop') return false;
  return !tasks.some((o) => o?.plan === entry.id);
}

/**
 * The captured plans in the Inbox: { new, ids, proposals } (oldest first). `proposals` counts those with Claude's
 * proposal (P7, lib/planProposal.js) that wait for the owner's Accept.
 */
function inboxSummary(reg, tasks = []) {
  const list = (reg?.entries ?? []).filter((p) => isInInbox(p, tasks));
  list.sort((x, y) => String(x.inbox.at ?? '').localeCompare(String(y.inbox.at ?? '')));
  return { new: list.length, ids: list.map((p) => p.id), proposals: list.filter((p) => p.proposal).length };
}

/**
 * The line for `orchestrator pulse` and `show`, or null when the Inbox has no captured plan. With plans.inboxTriage
 * idle (P7) it asks the orchestrator to sort the ones without a proposal when a slot is free.
 */
function inboxLine(summary, ravenseat = 'ravenseat', { triage = 'on-request' } = {}) {
  if (!summary?.new) return null;
  const ids = summary.ids.slice(0, 5).join(', ') + (summary.ids.length > 5 ? ', ...' : '');
  const what = summary.new === 1 ? 'captured plan' : 'captured plans';
  const waiting = summary.proposals
    ? `; ${summary.proposals} with a proposal waiting on the owner (Accept on the board)`
    : '';
  const idle =
    triage === 'idle' && summary.new > (summary.proposals ?? 0)
      ? '; plans.inboxTriage idle: sort them when a slot is free (/plans inbox)'
      : '';
  return `INBOX: ${summary.new} ${what} not sorted yet (${ids}): ${ravenseat} plan inbox${waiting}${idle}`;
}

/**
 * The rows for `ravenseat plan inbox`, oldest first. `proposal` says whether Claude's proposal waits, `suggests` is
 * its line in words (queuePlanView.proposalText, with the project titles from `projects`).
 */
function inboxRows(reg, tasks = [], projects = {}) {
  const order = inboxSummary(reg, tasks).ids;
  const byId = new Map((reg?.entries ?? []).map((p) => [p.id, p]));
  return order.map((id) => {
    const p = byId.get(id);
    const t = V.proposalText(p, { projects, entries: reg?.entries ?? [] });
    return {
      id,
      title: p.title,
      summary: p.summary ?? null,
      at: p.inbox.at ?? null,
      by: p.inbox.by ?? 'owner',
      proposal: Boolean(t),
      suggests: t ? `${t.text}${t.because ? `, because ${t.because}` : ''}` : null,
    };
  });
}

module.exports = {
  TITLE_MAX,
  TEXT_SOFT,
  TEXT_MAX,
  PROJECT,
  PROJECT_FIELDS,
  captureInput,
  capturePlan,
  isInInbox,
  inboxSummary,
  inboxLine,
  inboxRows,
};
