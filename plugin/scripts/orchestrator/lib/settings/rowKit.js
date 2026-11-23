// =============================================================
// settings/rowKit.js: what every settings area file builds its rows with: row() with its defaults, the weakens
// builders, the mode lists and the shared option objects and full-only reasons.
//
// Moved unchanged out of lib/settingsRegistry.js (SPLIT-1); the header there explains every field of a row.
//
// Used by: the area files in this folder (project.js, gates.js, guards.js, push.js, review.js, board.js, plans.js).
// Tested in: lib/__tests__/settingsRegistry.test.ts and lib/__tests__/settingsRegistrySplit.test.ts.
// =============================================================
'use strict';

const { REQUIRES } = require('./requires.js');

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---- weakens: small builders ----------------------------------------------------------------------

/** Weakens when the value is false and the standard is not (a guard switched off). */
const offWeakens = (v, std) => v === false && std !== false;

/** Weakens when the value is true and the standard is not (something that skips the owner switched on). */
const onWeakens = (v, std) => v === true && std !== true;

/** Weakens when the value is later than the standard in `order` (strongest first). Unknown values never weaken here. */
const rankWeakens = (order) => (v, std) => {
  const a = order.indexOf(v);
  const b = order.indexOf(std);
  return a >= 0 && b >= 0 && a > b;
};

/**
 * Weakens when the paths leave out an entry of the standard list that is not in the floor (lib/mergeGuard.js
 * CORE_PROTECTED, which holds whatever the list says). The value is a list or the object form { add, remove }, read as
 * config() reads it; a malformed object gives the defaults, so it weakens nothing. Compared without case.
 */
function listLosesEntries(v, std) {
  if (!Array.isArray(std)) return false;
  const MG = require('../mergeGuard.js'); // lazily: mergeGuard reads queueConfig, which this file must not load first
  const list = Array.isArray(v) ? v : isObject(v) ? MG.resolveProtectedPaths(v, std).list : null;
  if (!list) return false;
  const have = new Set(list.map((p) => String(p).toLowerCase()));
  return std.some((p) => !have.has(String(p).toLowerCase()) && !MG.inFloor(p));
}

/** Weakens when a class gets fewer of its default reviewers (a class left out keeps the default, as merge() does). */
function fewerReviewers(v, std) {
  if (!isObject(std)) return false;
  const own = isObject(v) ? v : {};
  return Object.entries(std).some(([cls, names]) => {
    const list = Array.isArray(own[cls]) ? own[cls] : names;
    return (Array.isArray(names) ? names : []).some((n) => !list.includes(n));
  });
}

const BOTH = Object.freeze(['lite', 'full']);
const FULL = Object.freeze(['full']);

/** One row with the defaults filled in: advanced, both modes, queue.config.json, settable, no warning texts. */
function row(key, category, type, title, explanation, o = {}) {
  return Object.freeze({
    key,
    category,
    level: o.level ?? 'advanced',
    modes: o.fullWhy ? FULL : BOTH,
    fullWhy: o.fullWhy ?? null,
    store: o.store ?? 'config',
    edit: o.edit ?? (['list', 'object'].includes(type) ? 'file' : 'set'),
    type,
    title,
    explanation,
    defaultByMode: o.defaultByMode ?? null,
    choices: o.choices ?? null,
    weakens: o.weakens ?? null,
    // What the row guards against, in one short sentence (finding M1): required with weakens, and also set on the guards
    // that have no weakening value (a list, a number or a choice that stops, asks or checks). Advice rows have none.
    protects: o.protects ?? null,
    whyNot: o.weakens ? o.whyNot : null,
    changes: o.weakens ? o.changes : null,
    // A number that also takes none (null) although its default is a number (parseValue).
    nullable: o.nullable === true,
    requires: REQUIRES[key] ? Object.freeze([...REQUIRES[key]]) : null,
  });
}

const BASIC = { level: 'basic' };
const QUEUE = { store: 'queue' };
const WHY_ONE_TYPE = 'lite has one task type (class K)';
const WHY_ONE_DOMAIN = 'lite has one domain (general)';
const WHY_PLANS = 'lite uses the plan register as a plain list; areas, documents and rules are full mode structure';
// The same words as the triage rows, so the lite fold line names the reason once (board/settings.js joins unique ones).
const WHY_PLAN_REVIEW = 'the intake triage is off in lite';

module.exports = {
  row,
  BASIC,
  QUEUE,
  offWeakens,
  onWeakens,
  rankWeakens,
  listLosesEntries,
  fewerReviewers,
  isObject,
  BOTH,
  FULL,
  WHY_ONE_TYPE,
  WHY_ONE_DOMAIN,
  WHY_PLANS,
  WHY_PLAN_REVIEW,
};
