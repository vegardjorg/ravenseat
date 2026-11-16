// =============================================================
// failureRules.js: the class a finding log row gets from a rule when the row is made (step 5 of the finding format
// contract, plans/funnformat-0i-0j-2026-11-15.md section 6; the learning loop plan section 3.3, "deterministic first").
//
// Why: until now every row from a gate, CI, the base gate or the secret scan had the class `other`, so a class that
// keeps coming back (the same type drift, the same missing module) could not be counted. Many of those failures say
// their class plainly: a red `tsc` is contract drift, a TS2532 is null or undefined, a secret hit is a leaked secret, a
// flaky command is a weak test. A rule that reads what the source already has costs nothing (no agent, no tokens, no
// extra run) and is the same every time, so it goes first; an agent's own class (the GATE and FINDING lines) still wins.
//
// THE REGISTER is data (failure-rules.json next to the orchestrator), never code per source. A rule has an `id`, a
// `class` from the taxonomy (lib/failureClasses.js), and exactly one match:
//   event   what the source itself saw, passed by the builder in lib/findingSources.js: `secret`, `flaky`, `unproven`
//           (red on base), `test-weakening`;
//   code    a regular expression (case does not matter) tried on the row's excerpt, the normalized first error line;
//   signal  a review signal (lib/reviewSignals.js) that hit on the task and lifted this row's reviewer in;
//   kind    a checksScan kind (lib/checksScan.js classify) of the red command: `types` gives contract drift.
// Tiers are tried in that order (event, code, signal, kind): the most specific evidence first, so a TS2532 under `tsc`
// is null-undefined, not plain contract drift. Within a tier, the project's rules come before the core ones, then the
// file order. `code` and `kind` read only rows from a command (gate, ci, base-gate, done-check), and `signal` only
// review rows: a reviewer's prose that names a TS code is no compiler output. A rule may narrow itself with `caught_by`.
//
// NOT SURE IS LOW: when the same tier gives two different classes (a command that is both `tsc` and a build, a task
// where two signals with different classes hit), the first one is kept with confidence `low`. A low row is logged but
// never gives a proposal (plan section 3.9: do not suggest what may be wrong).
//
// A PROJECT adds rules or turns core ones off in docs/queue/failure-rules.json, the same pattern as the classes:
// `{ "rules": [ { "id": "e1234", "code": "\\bE1234\\b", "class": "config-env" }, { "id": "kind-build", "off": true } ] }`.
// A new id must be kebab-case and not a core id; the class must be one the project has (its own classes count, a class
// it turned off does not); the pattern must compile and be at most 300 characters; `kind` must be a checksScan kind.
// Anything invalid is skipped with a warning (projectWarnings, shown by `ravenseat doctor`), and a broken file gives
// the core rules: a bad project file never stops a row, a gate or a review.
//
// NEVER A STOP: classify and applyRules never throw. Any error gives the row as it came (its class, `other` for most
// sources), which is the state before this step.
//
// Pure apart from rulesFor (one project file) and applyRules (which reads it). Used by: lib/findingLog.js append, the
// one place every source writes through. Tested in lib/__tests__/failureRules.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FC = require('./failureClasses.js');

/** Where a project keeps its own rules and switches, relative to its root. */
const PROJECT_FILE = path.join('docs', 'queue', 'failure-rules.json');

/** The ways a rule can match, in the order they are tried. */
const TIERS = Object.freeze(['event', 'code', 'signal', 'kind']);
/** The events the sources pass (lib/findingSources.js). */
const EVENTS = Object.freeze(['secret', 'flaky', 'unproven', 'test-weakening']);
/** The sources whose excerpt is a command's output and whose hint is a command. */
const COMMAND_SOURCES = Object.freeze(['gate', 'ci', 'base-gate', 'done-check']);
/** The longest pattern a rule may have: the excerpt is at most 200 characters, a pattern needs no more. */
const PATTERN_MAX = 300;

const KEBAB = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const REVIEW = /^review:/;

/** The checksScan kinds, read once (the module is pure). */
let kindKeys;
function kinds() {
  kindKeys ??= require('./checksScan.js').KINDS.map((k) => k.key);
  return kindKeys;
}

/**
 * One rule checked and compiled, or a reason it is not valid. `classes` are the ids a rule may give.
 * @returns {{ rule?: object, why?: string }}
 */
function compile(entry, classIds) {
  const tiers = TIERS.filter((t) => entry[t] != null);
  if (tiers.length !== 1) return { why: `needs exactly one of ${TIERS.join(', ')}` };
  const tier = tiers[0];
  const value = String(entry[tier]);
  if (typeof entry.class !== 'string' || !classIds.has(entry.class)) return { why: `"class" must be one of the project's classes` };
  if (entry.class === FC.OTHER) return { why: '"class" other is what a row has without a rule' };
  if (entry.confidence != null && !['high', 'low'].includes(entry.confidence)) return { why: '"confidence" must be high or low' };
  let caughtBy = null;
  if (entry.caught_by != null) {
    const list = Array.isArray(entry.caught_by) ? entry.caught_by : [entry.caught_by];
    if (!list.every((c) => typeof c === 'string' && c)) return { why: '"caught_by" must be a list of sources' };
    caughtBy = list;
  }
  const rule = { id: entry.id, tier, value, class: entry.class, confidence: entry.confidence ?? 'high', caughtBy };
  if (tier === 'event' && !EVENTS.includes(value)) return { why: `"event" must be one of ${EVENTS.join(', ')}` };
  if (tier === 'kind' && !kinds().includes(value)) return { why: `"kind" must be a checks kind (${kinds().join(', ')})` };
  if (tier === 'code') {
    if (!value || value.length > PATTERN_MAX) return { why: `"code" must be a pattern of 1 to ${PATTERN_MAX} characters` };
    try {
      rule.re = new RegExp(value, 'i');
    } catch {
      return { why: '"code" is not a valid regular expression' };
    }
  }
  return { rule };
}

/** The core rules, compiled once against the core classes. A broken core rule is a bug the tests catch. */
let coreCache;
function coreRules() {
  if (coreCache) return coreCache;
  const ids = new Set(FC.coreClasses().map((c) => c.id));
  coreCache = require('../failure-rules.json')
    .rules.map((e) => compile(e, ids).rule)
    .filter(Boolean);
  return coreCache;
}

/**
 * The rules for a project: its own first, then the core ones it did not turn off, and the classes they may give.
 * Never throws: a missing file is the core rules, a broken one the core rules and a warning.
 * @param {string|null} root the project root (null: the core rules only)
 * @returns {{ rules: object[], classes: { id: string, title: string }[], warnings: string[] }}
 */
function rulesFor(root, { fsImpl = fs } = {}) {
  const warnings = [];
  const fromClasses = root == null ? { classes: FC.coreClasses(), warnings: [] } : FC.classesFor(root, { fsImpl });
  const classes = fromClasses.classes;
  const classIds = new Set(classes.map((c) => c.id));
  // A core rule whose class the project turned off gives nothing: the project said it does not count that class.
  const usable = (rules) => rules.filter((r) => classIds.has(r.class));
  if (root == null) return { rules: usable(coreRules()), classes, warnings };
  let raw;
  try {
    raw = fsImpl.readFileSync(path.join(String(root), PROJECT_FILE), 'utf8');
  } catch (e) {
    if (e?.code !== 'ENOENT') warnings.push(`${PROJECT_FILE}: could not read it (${e?.code ?? e?.message}); using the core rules`);
    return { rules: usable(coreRules()), classes, warnings };
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    warnings.push(`${PROJECT_FILE}: not valid JSON (${e.message}); using the core rules`);
    return { rules: usable(coreRules()), classes, warnings };
  }
  const list = Array.isArray(data) ? data : Array.isArray(data?.rules) ? data.rules : null;
  if (!list) {
    warnings.push(`${PROJECT_FILE}: expected { "rules": [ ... ] }; using the core rules`);
    return { rules: usable(coreRules()), classes, warnings };
  }
  const coreIds = new Set(coreRules().map((r) => r.id));
  const off = new Set();
  const own = [];
  for (const entry of list) {
    const id = typeof entry?.id === 'string' ? entry.id : null;
    if (!id) {
      warnings.push(`${PROJECT_FILE}: a rule without a string "id" was ignored`);
      continue;
    }
    const shown = id.replace(/\s+/g, ' ').slice(0, 40);
    if (entry.off === true) {
      if (coreIds.has(id) || own.some((r) => r.id === id)) off.add(id);
      else warnings.push(`${PROJECT_FILE}: "${shown}" is not a rule to turn off; ignored`);
      continue;
    }
    if (coreIds.has(id)) {
      warnings.push(`${PROJECT_FILE}: "${shown}" is a core rule; add one with an id of its own, or turn it off (ignored)`);
      continue;
    }
    if (id.length > 40 || !KEBAB.test(id)) {
      warnings.push(`${PROJECT_FILE}: "${shown}" is not a kebab-case id (like "my-rule"); ignored`);
      continue;
    }
    if (own.some((r) => r.id === id)) {
      warnings.push(`${PROJECT_FILE}: "${shown}" is listed twice; the first one is kept`);
      continue;
    }
    const c = compile(entry, classIds);
    if (!c.rule) {
      warnings.push(`${PROJECT_FILE}: "${shown}" ${c.why}; ignored`);
      continue;
    }
    own.push(c.rule);
  }
  const rules = [...own, ...usable(coreRules())].filter((r) => !off.has(r.id));
  return { rules, classes, warnings: [...fromClasses.warnings, ...warnings] };
}

/** Does a rule's own `caught_by` (when it has one) and its tier's sources let it read this row? */
function reads(rule, caughtBy) {
  if (rule.caughtBy && !rule.caughtBy.includes(caughtBy)) return false;
  if (rule.tier === 'code' || rule.tier === 'kind') return COMMAND_SOURCES.includes(caughtBy);
  if (rule.tier === 'signal') return REVIEW.test(caughtBy);
  return true;
}

/** The rules of one tier that match the row, in order. */
function matches(rules, tier, { caughtBy, hints, excerpt }) {
  const hit = (r) => {
    if (r.tier !== tier || !reads(r, caughtBy)) return false;
    if (tier === 'event') return hints.event === r.value;
    if (tier === 'code') return r.re.test(excerpt);
    if (tier === 'signal') return hints.signals.includes(r.value);
    return hints.kinds.includes(r.value);
  };
  return rules.filter(hit);
}

/** The hints a source passed, cleaned: an event, the command's kinds, the signals for this reviewer. */
function hintsOf(input) {
  const h = input?.rule_hints && typeof input.rule_hints === 'object' ? input.rule_hints : {};
  const command = typeof h.command === 'string' ? h.command.slice(0, 2000) : '';
  let kindList = [];
  if (command) {
    try {
      kindList = require('./checksScan.js').classify(command);
    } catch {
      kindList = []; // error-ignored: no kind is no rule, never a stop
    }
  }
  return {
    event: typeof h.event === 'string' ? h.event : null,
    kinds: kindList,
    signals: Array.isArray(h.signals) ? h.signals.filter((s) => typeof s === 'string') : [],
  };
}

/**
 * The class a rule gives the row, or null when none applies or the agent's own class stands.
 * @param {object} input  a finding log input (lib/findingLog.js makeRow) with optional `rule_hints`
 *   ({ event?, command?, signals? }, never stored)
 * @param {object[]} rules  from rulesFor
 * @returns {{ class: string, confidence: 'high'|'low', rule: string }|null}
 */
function classify(input, rules) {
  try {
    const x = input && typeof input === 'object' ? input : {};
    // The agent's own line wins: a class it chose stands. `other` or '-' from an agent is no choice, so a rule may help.
    const given = typeof x.class === 'string' ? x.class.trim() : '';
    if (x.class_source === 'agent' && given && given !== '-' && given !== FC.OTHER) return null;
    const caughtBy = String(x.caught_by ?? '');
    const ctx = { caughtBy, hints: hintsOf(x), excerpt: String(x.excerpt ?? '').slice(0, 2000) };
    for (const tier of TIERS) {
      const hit = matches(Array.isArray(rules) ? rules : [], tier, ctx);
      if (!hit.length) continue;
      const first = hit[0];
      const unsure = hit.some((r) => r.class !== first.class);
      return { class: first.class, confidence: unsure ? 'low' : first.confidence, rule: first.id };
    }
    return null;
  } catch {
    // error-ignored: a rule that fails gives no class, and the row keeps the one it came with
    return null;
  }
}

/** The project root for a row written without one: the tree we run in (a track's worktree, or the main tree). */
function defaultRoot() {
  try {
    return require('./projectRoot.js').roots().tree;
  } catch {
    return null; // error-ignored: without a root, the core rules
  }
}

/**
 * The input with the rule's class set (class_source `rule`), or as it came. Also returns the project's classes, so the
 * caller can normalize the class against them (a project's own class is not a core one). Never throws.
 * @param {string|null} root  the project root (null: the tree we run in)
 * @param {object} input
 * @returns {{ input: object, classes: { id: string }[]|null }}
 */
function applyRules(root, input, { fsImpl = fs } = {}) {
  try {
    const { rules, classes } = rulesFor(root ?? defaultRoot(), { fsImpl });
    const got = classify(input, rules);
    if (!got) return { input, classes };
    return { input: { ...input, class: got.class, class_source: 'rule', confidence: got.confidence }, classes };
  } catch {
    // error-ignored: no rule is the state before this step
    return { input, classes: null };
  }
}

/** The warnings for a project's two taxonomy files (classes and rules), for `ravenseat doctor`. [] when all is well. */
function projectWarnings(root, { fsImpl = fs } = {}) {
  try {
    return rulesFor(root, { fsImpl }).warnings;
  } catch (e) {
    return [`${PROJECT_FILE}: could not be checked (${e?.message ?? e})`];
  }
}

module.exports = { PROJECT_FILE, TIERS, EVENTS, COMMAND_SOURCES, rulesFor, classify, applyRules, projectWarnings };
