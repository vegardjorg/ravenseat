// =============================================================
// lib/decisionRows.js: one time log row per owner answer (section 7.1 of plans/autonomi-nivaa-utredning.md).
//
// What it holds: the `event: "decision"` row (key, verb, category, recommended, chosen, followed, note, asked_at,
// answered_at, by, surface, bulk, auto) and the rule for `followed` (table 7.1).
//
// Why: how often the owner follows the recommendation, per category, is what the autonomy levels are tuned on. So the
// number only counts what says something: a single answer by the owner (or the board) to a question that had a
// recommendation. Approve and QA have a fixed recommendation in code ("Approve", "QA ok"), so 100 % there says nothing:
// their rows are written (to see the volume) but `followed` is null. A bulk answer says nothing about each card.
//
// Privacy: a free-text answer can hold names, so its text is never in the row (`chosen` is null); only whether it
// followed. A choice's text is the question's own choice, written by the agent, so it is kept.
//
// Used by: cli/owner.mjs (resolve, approve, qa) and cli/taskEdit.mjs (cancel --remark declined). The board and
// /ravenseat:decide run those same commands, so this is the one place. Written with logEvent, which fails open.
// Tested in: lib/__tests__/decisionRows.test.ts.
// =============================================================
'use strict';

const { categoryOf, UNCATEGORIZED } = require('./askCatalog.js');

/** Who counts in "followed": the owner, from the main session or the board. Anyone else (an agent, auto) does not. */
const COUNTED_BY = new Set(['owner', 'theBoard']);
/** Free text that means "the recommendation" (the board's own words and the plain way to say it). */
const FOLLOW_WORDS = /^(use the recommendation|as recommended)[.!]?$/i;
/** The fixed answers of the machine cards. */
const MACHINE = Object.freeze({
  approve: { category: 'followups', recommended: 'Approve' },
  check: { category: UNCATEGORIZED, recommended: 'QA ok' },
  unstick: { category: UNCATEGORIZED, recommended: null },
});

const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();

/** Where the answer was given: the board server sets RAVENSEAT_SURFACE=board on the commands it runs; else the CLI. */
function surfaceOf(env = process.env) {
  return env?.RAVENSEAT_SURFACE === 'board' ? 'board' : 'cli';
}

/**
 * Table 7.1: true when the choice (or free text) is the recommendation, false when it is something else, null when the
 * answer does not count (a machine card, bulk, no recommendation, or an answer not by the owner).
 */
function followedOf({ verb, recommended, chosen, by, bulk = false }) {
  if (verb !== 'decide' || bulk) return null;
  if (!COUNTED_BY.has(String(by ?? ''))) return null;
  if (recommended == null || !String(recommended).trim() || chosen == null) return null;
  const c = norm(chosen);
  return c === norm(recommended) || FOLLOW_WORDS.test(c);
}

/**
 * The row for one resolved question. `chosen` is the picked choice's text, or the free-text answer (with `free: true`,
 * stored as null). `note`: a note was given after a choice.
 */
function resolveRow({ sp, q, chosen, free = false, note = false, by = null, surface = 'cli', bulk = false, now = new Date().toISOString() }) {
  const recommended = q?.recommendation ?? null;
  // Free text that IS the recommendation (the board's "As recommended" sends its text) is stored as the recommendation;
  // any other free text is not stored.
  const asRecommended = recommended != null && chosen != null && (norm(chosen) === norm(recommended) || FOLLOW_WORDS.test(norm(chosen)));
  return {
    time: now,
    event: 'decision',
    key: `decide:${sp}`,
    verb: 'decide',
    category: categoryOf(q),
    recommended,
    chosen: free ? (asRecommended ? recommended : null) : (chosen ?? null),
    followed: followedOf({ verb: 'decide', recommended, chosen, by, bulk }),
    note: !!note,
    asked_at: q?.added_at ?? null,
    answered_at: now,
    by: by ?? null,
    surface,
    bulk: !!bulk,
    auto: by === 'auto',
  };
}

/** The row for a machine card (approve, decline, QA ok, QA deviation): `followed` is always null. */
function taskRow({ verb, task, chosen, note = false, by = null, surface = 'cli', bulk = false, now = new Date().toISOString() }) {
  const m = MACHINE[verb] ?? { category: UNCATEGORIZED, recommended: null };
  return {
    time: now,
    event: 'decision',
    key: `${verb}:${task?.id ?? ''}`,
    verb,
    category: m.category,
    recommended: m.recommended,
    chosen: chosen ?? null,
    followed: null,
    note: !!note,
    asked_at: task?.added_at ?? null,
    answered_at: now,
    by: by ?? null,
    surface,
    bulk: !!bulk,
    auto: by === 'auto',
  };
}

module.exports = { COUNTED_BY, MACHINE, surfaceOf, followedOf, resolveRow, taskRow };
