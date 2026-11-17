// =============================================================
// recipePrecision.js: how often a recipe's gate proposals are accepted, per recipe and per class, and the damping of a
// recipe that is seldom accepted (0i step 9, plans/feillogg-til-gater-2026-11-15.md section 3.9 "Presisjon måles").
// Pure functions without I/O: cli/checks.mjs reads the tasks (queue and archive) and the owner's choices.
//
// Why: a recipe that the owner keeps declining is noise on the Checks tab. Counting what became of its proposals is
// free (the tasks already say it), so a recipe that is seldom accepted can step back by itself, and the owner can
// still bring it back.
//
// A PROPOSAL is a gate task from the finding log (labels gate and finding-log: "Build as gate" on the card
// ledger-recipes, or the log's own proposal with learning.proposals on). Its class is read from its source
// (`finding-log <class>@<area>`), its recipe from its own field `recipe` ({ id, db }), never from the mission. A task
// without a recipe counts for its class only. A GATE line or an inspection proposal is not a recipe's proposal.
// What became of it is read from its status, so no new file is needed:
//   accepted  approved or later (waiting, picked, running, review, done): the owner said yes
//   declined  cancelled: the owner said no (lib/knownBugGate.js decide remembers that no per class and area)
//   pending   proposed: not answered yet, so it never counts toward the minimum
// The rate is accepted out of the decided ones (accepted + declined), as a whole percent, or null before any is decided.
//
// DAMPING (learning.recipeDamping, on by default): a recipe below recipeMinAccepted percent accepted (30) after at
// least recipeMinProposals decided proposals (5) is damped: it is listed with its numbers on the Checks tab, but the
// card no longer offers it (lib/checksCatalog.js recipeFor takes the next recipe whose `when` holds, or none), so
// neither "Build as gate" nor the log's own proposal carries it. It stops nothing: the class still shows, still can be
// built as a gate, and the proposals from the log still come.
// A database recipe (db: true) has its own minimum, recipeMinProposalsDb (10): it is shown only with learning.dbProbes
// on and a local database found, so it gets few proposals, and a probe gate is often declined for its cost (a running
// database, a heavy gate) rather than for being the wrong guard. Five would damp it on too thin a basis. It is counted
// on its own rows too, so a database recipe and the ordinary ones for the same class are never mixed.
// The owner's choice per recipe wins both ways and also with damping off: `ravenseat checks recipe <id> show|damp|auto`
// (queue.json checksPanel.recipes, one person's, like the cards set aside).
//
// Nothing but recipe ids, class ids and counts leaves this file (0i section 3.11). Tested in
// lib/__tests__/recipePrecision.test.ts and __tests__/findingRepeatsFlow.test.ts.
// =============================================================
'use strict';

/** The label every gate task proposed from the finding log carries (lib/findingRepeats.js LABEL). */
const LABEL = 'finding-log';
/** A recipe id as the catalog allows it (lib/checksCatalog.js RECIPE_ID). */
const RECIPE_ID = /^[a-z0-9][a-z0-9-]{0,59}$/;
const SOURCE = /^finding-log ([a-z0-9-]+)@(.+)$/;
/** The owner's choices per recipe; `auto` removes the choice. */
const OVERRIDES = Object.freeze(['show', 'damp']);
/** The statuses that mean the owner said yes (approved or later). */
const ACCEPTED = new Set(['waiting', 'picked', 'running', 'review', 'done']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** What became of a proposal: accepted, declined, pending, or null for a status that says nothing. */
function outcomeOf(status) {
  if (status === 'proposed') return 'pending';
  if (status === 'cancelled') return 'declined';
  return ACCEPTED.has(status) ? 'accepted' : null;
}

/** The task field for a recipe: its id and db mark only, or null (no recipe, a hint, or an id that is not one). */
function recipeRef(recipe) {
  if (!isObject(recipe) || typeof recipe.id !== 'string' || !RECIPE_ID.test(recipe.id)) return null;
  return { id: recipe.id, db: recipe.db === true };
}

/** The proposals in the tasks: { class, recipe, db, outcome }, one per task id (the first wins). */
function proposalsOf(tasks) {
  const seen = new Set();
  const out = [];
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (!isObject(t) || !Array.isArray(t.labels) || !t.labels.includes('gate') || !t.labels.includes(LABEL)) continue;
    const id = String(t.id ?? '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const m = SOURCE.exec(String(t.source ?? ''));
    const outcome = outcomeOf(t.status);
    if (!m || !outcome) continue;
    const ref = recipeRef(t.recipe);
    out.push({ class: m[1], recipe: ref?.id ?? null, db: ref?.db === true, outcome });
  }
  return out;
}

const empty = () => ({ proposals: 0, accepted: 0, declined: 0, pending: 0, rate: null });
function add(stat, outcome) {
  stat.proposals += 1;
  stat[outcome] += 1;
  const decided = stat.accepted + stat.declined;
  stat.rate = decided ? Math.round((stat.accepted * 100) / decided) : null;
}

/**
 * The counts per recipe and per class (database recipes on their own class rows).
 * @param {object[]} tasks  the queue's tasks with the archived ones
 * @returns {{ recipes: object[], classes: object[] }}
 */
function measure(tasks) {
  const recipes = new Map();
  const classes = new Map();
  for (const p of proposalsOf(tasks)) {
    const ck = `${p.class}\u0000${p.db}`;
    if (!classes.has(ck)) classes.set(ck, { class: p.class, db: p.db, ...empty() });
    add(classes.get(ck), p.outcome);
    if (!p.recipe) continue;
    if (!recipes.has(p.recipe)) recipes.set(p.recipe, { id: p.recipe, class: p.class, db: p.db, ...empty() });
    add(recipes.get(p.recipe), p.outcome);
  }
  const byClass = (a, b) => a.class.localeCompare(b.class) || Number(a.db) - Number(b.db);
  return {
    recipes: [...recipes.values()].sort((a, b) => byClass(a, b) || a.id.localeCompare(b.id)),
    classes: [...classes.values()].sort(byClass),
  };
}

/**
 * Is a recipe damped? The owner's choice first (show or damp), then the automatic rule (see DAMPING).
 * @param {{ db?: boolean, accepted: number, declined: number }} stat
 * @param {object} setup  lib/findingRepeats.js setupOf(config) (the learning settings)
 * @param {'show'|'damp'|null} [override]
 * @returns {{ damped: boolean, by: 'owner'|'auto'|null }}
 */
function dampOf(stat, setup, override = null) {
  if (override === 'show') return { damped: false, by: 'owner' };
  if (override === 'damp') return { damped: true, by: 'owner' };
  if (!setup?.recipeDamping || !stat) return { damped: false, by: null };
  const decided = (stat.accepted ?? 0) + (stat.declined ?? 0);
  const min = stat.db === true ? setup.recipeMinProposalsDb : setup.recipeMinProposals;
  // Below the floor, in whole numbers: accepted / decided < floor / 100.
  return decided >= min && (stat.accepted ?? 0) * 100 < setup.recipeMinAccepted * decided ? { damped: true, by: 'auto' } : { damped: false, by: null };
}

/** The owner's choices from queue.json (checksPanel.recipes): only recipe ids with show or damp. */
function overridesOf(queue) {
  const own = queue?.checksPanel?.recipes;
  const out = {};
  if (!isObject(own)) return out;
  for (const [id, v] of Object.entries(own)) if (RECIPE_ID.test(id) && OVERRIDES.includes(v)) out[id] = v;
  return out;
}

/**
 * The facts for the Checks tab and lib/checksCatalog.js (facts.recipePrecision, facts.recipeDamped): every recipe with
 * a proposal or an owner's choice, with its title from the catalog, its counts, its rate and whether it is damped.
 * @param {{ tasks: object[], setup: object, overrides?: Record<string, string>, recipes?: { id: string, title?: string, class?: string, db?: boolean }[] }} o
 */
function facts({ tasks = [], setup, overrides = {}, recipes = [] } = {}) {
  const m = measure(tasks);
  const known = new Map((Array.isArray(recipes) ? recipes : []).map((r) => [r.id, r]));
  const rows = new Map(m.recipes.map((r) => [r.id, r]));
  for (const id of Object.keys(overrides ?? {}))
    if (!rows.has(id)) {
      const r = known.get(id);
      rows.set(id, { id, class: r?.class ?? null, db: r?.db === true, ...empty() });
    }
  const list = [...rows.values()]
    .map((r) => {
      const override = overrides?.[r.id] ?? null;
      const d = dampOf(r, setup, override);
      const k = known.get(r.id);
      return { id: r.id, title: k?.title ?? r.id, class: r.class, db: r.db, proposals: r.proposals, accepted: r.accepted, declined: r.declined, pending: r.pending, rate: r.rate, damped: d.damped, by: d.by, override };
    })
    .sort((a, b) => String(a.class).localeCompare(String(b.class)) || a.id.localeCompare(b.id));
  return {
    on: setup?.recipeDamping === true,
    floor: setup?.recipeMinAccepted ?? null,
    min: setup?.recipeMinProposals ?? null,
    minDb: setup?.recipeMinProposalsDb ?? null,
    recipes: list,
    classes: m.classes,
    damped: list.filter((r) => r.damped).map((r) => r.id),
  };
}

/** One line per recipe for `ravenseat checks` (and the board): counts, percent and the damping. */
function line(r) {
  const rate = r.rate == null ? 'none decided yet' : `${r.accepted} accepted (${r.rate}%)`;
  const state = r.damped ? (r.by === 'owner' ? 'damped by you' : 'damped') : r.by === 'owner' ? 'shown by you' : 'shown';
  const pending = r.pending ? `, ${r.pending} waiting` : '';
  return `${r.id}${r.db ? ' (database)' : ''}: ${r.proposals} proposals, ${rate}${pending}, ${state}`;
}

module.exports = { LABEL, OVERRIDES, RECIPE_ID, outcomeOf, recipeRef, proposalsOf, measure, dampOf, overridesOf, facts, line };
