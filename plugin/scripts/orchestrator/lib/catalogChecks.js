// =============================================================
// catalogChecks.js: the check rules of the design choices (V4, bolk B6 of the scope drift plan,
// plans/scope-drift-dry-katalog-2026-11-15.md § 3 V4 and § 2.4).
//
// WHY: a design choice in docs/queue/catalog/decisions has one invariant a track gets as text (lib/catalogExcerpt.js).
// Text is read, weighed and sometimes missed. When the invariant can be said as "these files never contain that", the
// owner writes it as a rule, and receive checks the delivery's added lines against it mechanically, in milliseconds,
// with no agent and no tokens.
//
// The rule, under `check:` in the choice's frontmatter:
//   check:
//     forbid: "@db/client"                              a regular expression (case matters), tried on each added line
//     hit: ["import { db } from '@db/client'"]          lines the rule must hit
//     miss: ["import { save } from '@/services/factory'"]   lines it must not hit
//     mode: warn                                        warn (default) or stop
// `examples: {"hit": [...], "miss": [...]}` (one JSON object) is the same as hit and miss. At least one of each: the
// examples are run through the same line test as a delivery (ruleOf), so a rule that no longer does what it says is an
// error in `catalog check` and the choice cannot be accepted.
//
// Which lines: the added lines of the diff (lib/secretScan.js addedLines, with their line numbers) in files the choice's
// `paths` match, never a test file or a comment line (lib/reviewSignals.js isTestPath and isCommentLine, the review
// signals' engine), each cut to the same MAX_LINE. Removed lines and context lines never count.
//
// The level (owner decision 3, the owner lock): only a choice the owner accepted (lib/catalog.js effectiveStatus, the
// record of exactly this invariant, these paths and this check) enforces. Its hit is a warning, and a stop only with
// mode stop AND catalog.checkStop on (off by default: what can stop work is opt-in). A proposed choice, or one that says
// accepted without the owner's record, is never more than info. A superseded choice is not checked.
//
// Where it runs (the open B3 question): at receive, where the diff is already read for the scope notes: one line per
// rule, a section in the review package, a record on the task (catalog_checks) and, for a rule broken in several
// separate tasks, a gate proposal. At merge only the stop is checked again, on the merge's own diff, and only when
// catalog.checkStop is on: a delivery changed after receive cannot slip past a stop, and nothing else runs twice.
//
// A rule broken again and again (in at least catalog.gateAfter separate tasks) becomes a proposed gate task for the
// project's own lint (proposalTask), with the GATE tail's three parts: class scope-drift, the place and one sentence.
// Only with learning.proposals on, under the cap shared with the inspection queue and the GATE lines
// (lib/knownBugGate.js decide): Ravenseat should not become the project's linter.
//
// Pure: no git, no file system. Used by lib/catalog.js (ruleOf, lineHits), cli/catalog.mjs and cli/merge.mjs. Tested in
// lib/__tests__/catalogChecks.test.ts and __tests__/catalogChecksFlow.test.ts.
// =============================================================
'use strict';

const RS = require('./reviewSignals.js');

/** The fields of a check rule. */
const FIELDS = Object.freeze(['forbid', 'hit', 'miss', 'examples', 'mode']);
const MODES = Object.freeze(['warn', 'stop']);
/** A line is cut to this many characters before the rule is tried (the review signals' MAX_LINE). */
const MAX_LINE = 2000;
/** Places named per rule; the count says how many there were. */
const MAX_PLACES = 5;
/** The label a gate task proposed from a rule carries, besides `gate`. */
const LABEL = 'catalog-rule';
/** The finding class a broken invariant is (failure-classes.json). */
const CLASS = 'scope-drift';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const short = (s, n = 80) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

/** The settings this file reads (lib/catalog.js setupOf gives all of them; a test may pass a part). */
const setupWith = (setup) => ({ checks: true, checkStop: false, gateAfter: 3, ...(isObject(setup) ? setup : {}) });

/** Does the rule hit one line of text? Never a comment line. */
function lineHits(rule, text) {
  const t = String(text ?? '');
  if (RS.isCommentLine(t)) return false;
  return rule.re.test(t.length > MAX_LINE ? t.slice(0, MAX_LINE) : t);
}

/** A list of example lines, or a problem text. */
function examplesOf(v, name) {
  if (v == null) return { lines: [] };
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) return { problem: `check.${name} must be a list of lines` };
  return { lines: v.filter((x) => x.trim()) };
}

/**
 * The rule from a choice's `check` fields.
 * @returns {{ rule: { forbid: string, re: RegExp, hit: string[], miss: string[], mode: 'warn'|'stop' }|null, errors: string[] }}
 */
function ruleOf(check) {
  if (!isObject(check)) return { rule: null, errors: ['check must be fields under check: forbid, hit, miss and mode'] };
  const errors = [];
  for (const k of Object.keys(check)) if (!FIELDS.includes(k)) errors.push(`check: unknown field ${k} (allowed: ${FIELDS.join(', ')})`);
  let re = null;
  const forbid = check.forbid;
  if (typeof forbid !== 'string' || !forbid.trim()) errors.push('check.forbid missing (a regular expression tried on the added lines)');
  else {
    try {
      re = new RegExp(forbid);
    } catch (e) {
      errors.push(`check.forbid is not a valid regular expression (${e.message})`);
    }
    if (re && require('./reviewPacks.js').LOOKAHEAD_TRAP.test(forbid))
      errors.push('check.forbid has the lookahead trap \\s*(?!...): write \\s*(?!\\s*...)');
  }
  const mode = check.mode == null ? 'warn' : check.mode;
  if (!MODES.includes(mode)) errors.push('check.mode must be warn or stop');
  const ex = isObject(check.examples) ? check.examples : {};
  if (check.examples != null && !isObject(check.examples)) errors.push('check.examples must be an object {"hit": [...], "miss": [...]}');
  const hit = examplesOf(check.hit ?? ex.hit, 'hit');
  const miss = examplesOf(check.miss ?? ex.miss, 'miss');
  for (const x of [hit, miss]) if (x.problem) errors.push(x.problem);
  if (!hit.problem && !miss.problem && (!hit.lines.length || !miss.lines.length))
    errors.push('check needs at least one hit and one miss example (check.hit and check.miss: lists of lines), so a broken rule is seen');
  if (errors.length || !re) return { rule: null, errors };
  const rule = { forbid, re, hit: hit.lines, miss: miss.lines, mode };
  return { rule, errors: exampleProblems(rule) };
}

/** The examples that do not behave, through the same line test a delivery gets. */
function exampleProblems(rule) {
  const out = [];
  for (const l of rule.hit) if (!lineHits(rule, l)) out.push(`check: hit example does not hit: ${short(l)}`);
  for (const l of rule.miss) if (lineHits(rule, l)) out.push(`check: miss example hits: ${short(l)}`);
  return out;
}

/**
 * The rules that hit the delivery's added lines.
 * @param {{ decisions: object[], ledger: object, diff: string, setup?: object, glob?: Function }} c
 *   decisions: the design choices (lib/catalog.js parseDecision's decision), ledger: the owner's record,
 *   diff: a unified diff, setup: config().catalog with the defaults (lib/catalog.js setupOf)
 * @returns {{ rules: { id: string, title: string|null, invariant: string|null, file: string, status: string,
 *   mode: string, level: 'info'|'warn'|'stop', count: number, hits: { file: string, line: number }[] }[] }}
 */
function assess({ decisions = [], ledger, diff = '', setup, glob } = {}) {
  const s = setupWith(setup);
  if (!s.checks) return { rules: [] };
  const C = require('./catalog.js');
  const match = glob ?? require('./mergeGuard.js').globMatch;
  const lines = require('./secretScan.js')
    .addedLines(diff)
    .filter((l) => !RS.isTestPath(l.file));
  const rules = [];
  for (const d of Array.isArray(decisions) ? decisions : []) {
    if (!d || d.check == null || d.status === 'superseded') continue;
    const { rule, errors } = ruleOf(d.check);
    if (!rule || errors.length) continue;
    // In the choice's paths and not in its except (roadmap 0å KD-0: the token file of a colour rule).
    const hits = lines.filter((l) => C.covers(d, l.file, match) && lineHits(rule, l.text));
    if (!hits.length) continue;
    const status = C.effectiveStatus(d, ledger ?? C.emptyLedger());
    const level = status === 'accepted' ? (rule.mode === 'stop' && s.checkStop ? 'stop' : 'warn') : 'info';
    rules.push({
      id: d.id,
      title: d.title ?? null,
      invariant: d.invariant ?? null,
      file: d.file,
      status,
      mode: rule.mode,
      level,
      count: hits.length,
      hits: hits.slice(0, MAX_PLACES).map((h) => ({ file: h.file, line: h.line })),
    });
  }
  return { rules };
}

/** The places of a rule as one list, with how many more there were. */
const placesOf = (r, tick = (x) => x) =>
  `${r.hits.map((h) => tick(`${h.file}:${h.line}`)).join(', ')}${r.count > r.hits.length ? ` and ${r.count - r.hits.length} more` : ''}`;

/** The status of a choice that does not hold, in words. */
const notHolding = (status) => (status === 'proposed' ? 'a proposed choice' : `a proposed choice (${status}: not accepted by the owner in this version)`);

/**
 * The receive output. Never the line's text: it may hold anything. A CATALOG line per rule that enforces (warn or
 * stop) comes first and stays whole: it asks for a fix round or the owner. The rules that bind nothing (info) are one
 * NOTE line each when there is one, else ONE NOTE line with the ids and the count (M4 of the friction review,
 * 2026-11-17); `all` (receive --all) gives one per rule. The package section (packageSection) always names each rule.
 */
function receiveLines(result, { id, cli = 'ravenseat', all = false } = {}) {
  const rules = result?.rules ?? [];
  const info = rules.filter((r) => r.level === 'info');
  const out = enforcedLines(rules.filter((r) => r.level !== 'info'), { id, cli });
  if (info.length > 1 && !all) {
    const n = info.reduce((s, r) => s + r.count, 0);
    out.push(
      `NOTE catalog ${id}: ${info.length} proposed choices match added lines (${info.map((r) => r.id).join(', ')}; ${n} line${n === 1 ? '' : 's'}). ` +
        `They bind nothing; the reviewer weighs them. Each is in 00-package.md (Catalog rules), or ${cli} receive ${id} --all prints them.`,
    );
    return out;
  }
  for (const r of info)
    out.push(
      `NOTE catalog ${id}: ${r.count} added line(s) match the check of ${r.id}, ${notHolding(r.status)}: ${placesOf(r)}. ` +
        'It binds nothing; the reviewer weighs it.',
    );
  return out;
}

/** The CATALOG line of each rule that enforces (warn or stop), with the way out. */
function enforcedLines(rules, { id, cli }) {
  const out = [];
  for (const r of rules) {
    let line =
      `CATALOG ${id}: ${r.count} added line(s) break ${r.id} (${r.title ?? 'a design choice'}): ${placesOf(r)}. ` +
      `The choice holds (accepted by the owner): ${r.invariant ?? ''} A fix round takes the lines out (${cli} resume ${id} --reason fix), ` +
      `or the owner changes the choice (${cli} catalog show ${r.id}).`;
    if (r.level === 'stop')
      line += ` The merge stops on it (catalog.checkStop). On the owner's word only: ${cli} merge ${id} --allow-catalog (logged).`;
    else if (r.mode === 'stop') line += ' Its mode is stop, but catalog.checkStop is off, so this is a warning.';
    out.push(line);
  }
  return out;
}

/** The review package section (lines), or null when no rule hit. */
function packageSection(result) {
  const rules = result?.rules ?? [];
  if (!rules.length) return null;
  const tick = (x) => `\`${x}\``;
  const out = [
    '',
    '## Catalog rules',
    '',
    'The check rules of the design choices in docs/queue/catalog/decisions, tried on the added lines at receive ' +
      `(lib/catalogChecks.js). A hit on a choice that holds breaks its invariant: a \`${CLASS}\` finding, MEDIUM at least, ` +
      'unless the line only looks like it (then say why). A proposed choice binds nothing.',
    '',
  ];
  for (const r of rules) {
    const how = r.level === 'info' ? `${r.status === 'proposed' ? 'proposed' : r.status}, binds nothing` : `holds, ${r.level}`;
    out.push(`- ${r.id} (${how}): ${placesOf(r, tick)} · invariant: ${r.invariant ?? ''}`);
  }
  return out;
}

/** The merge stop text, or null: only rules at level stop. */
function mergeStop(result, { id, cli = 'ravenseat' } = {}) {
  const stops = (result?.rules ?? []).filter((r) => r.level === 'stop');
  if (!stops.length) return null;
  const n = stops.reduce((s, r) => s + r.count, 0);
  return (
    `STOP: ${id} is not merged. ${n} added line(s) break design choice(s) whose rule is in mode stop: ` +
    `${stops.map((r) => `${r.id} (${placesOf(r)})`).join('; ')}. ` +
    `A fix round takes them out: ${cli} resume ${id} --reason fix, then ${cli} receive ${id}. ` +
    `On the owner's word only: ${cli} merge ${id} --allow-catalog (logged as "catalog-overridden"). Nothing was done.`
  );
}

const ID = /^D-\d{4}$/;

/**
 * The record on the task (catalog_checks): the latest receive's hits, and every rule id that ever enforced on the task
 * (warn or stop), so a fix round that took the line out still counts toward a repeat. null when there is nothing to keep.
 */
function record(result, prev, now = new Date().toISOString()) {
  const ever = Array.isArray(prev?.ever) ? prev.ever.filter((x) => typeof x === 'string' && ID.test(x)) : [];
  const rules = result?.rules ?? [];
  if (!rules.length && !isObject(prev)) return null;
  for (const r of rules) if (r.level !== 'info' && !ever.includes(r.id)) ever.push(r.id);
  return { at: now, hits: rules.map((r) => ({ id: r.id, level: r.level, count: r.count })), ever };
}

/** The ids of the separate tasks that ever broke the rule (catalog_checks.ever), in order, each once. */
function repeatTasks(ruleId, tasks = []) {
  const out = [];
  for (const o of Array.isArray(tasks) ? tasks : []) {
    const ever = o?.catalog_checks?.ever;
    if (Array.isArray(ever) && ever.includes(ruleId) && o.id && !out.includes(o.id)) out.push(o.id);
  }
  return out;
}

/** The enforcing rules of this delivery that were broken in at least gateAfter separate tasks: [{ rule, tasks }]. */
function dueRules(result, tasks = [], { gateAfter = 3 } = {}) {
  const out = [];
  for (const r of result?.rules ?? []) {
    if (r.level === 'info') continue;
    const ids = repeatTasks(r.id, tasks);
    if (ids.length >= gateAfter) out.push({ rule: r, tasks: ids });
  }
  return out;
}

/** The gate title for a rule, so lib/knownBugGate.js decide finds the same one again (one gate class per rule). */
function gateTitle(rule) {
  return require('./knownBugGate.js').cleanTitle(`Lint rule for ${rule.id}: ${rule.title ?? rule.invariant ?? 'a design choice'}`);
}

/**
 * The gate task for a rule broken again and again, ready for `ravenseat add` (added_by makes it proposed). The GATE
 * tail's parts: class scope-drift, the place (the first hit of this delivery) and one sentence.
 * @param {{ rule: object, tasks: string[] }} due  from dueRules
 */
function proposalTask(due, { id, from = null } = {}) {
  const G = require('./knownBugGate.js');
  const { rule } = due;
  const h = rule.hits[0];
  const where = h ? `${h.file}:${h.line}` : null;
  const sentence = `the check rule of ${rule.id} was broken in ${due.tasks.length} separate tasks (${due.tasks.slice(0, 5).join(', ')})`;
  const task = G.gateTask({
    id,
    title: gateTitle(rule),
    whole: `${rule.invariant ?? rule.title ?? rule.id} (design choice ${rule.id}, class ${CLASS})`,
    from,
    where,
    detail: sentence,
  });
  const mission = [
    task.mission,
    '',
    `Where it comes from: the project catalog, docs/queue/catalog/${rule.file} (${rule.id}), its rule check.forbid and the ` +
      'examples in check.hit and check.miss. Ravenseat tries it only on the added lines at receive. Build the same rule into ' +
      "the project's own lint or check (for example no-restricted-imports or no-restricted-syntax in ESLint, a banned-API " +
      'rule in the Python linter, or a small script the quick gate runs), with the examples as its test cases, so the editor ' +
      'and CI catch it before a track delivers. Do not edit the catalog: say in track-result.md whether the check rule can ' +
      'then be removed (an owner question).',
    where ? `In the GATE tail form: GATE ${CLASS} @ ${where} | ${sentence}` : null,
  ]
    .filter((x) => x != null)
    .join('\n');
  return { ...task, mission, labels: [...task.labels, LABEL], source: `catalog-rule ${rule.id}` };
}

module.exports = {
  FIELDS,
  MODES,
  LABEL,
  CLASS,
  ruleOf,
  lineHits,
  exampleProblems,
  assess,
  receiveLines,
  packageSection,
  mergeStop,
  record,
  repeatTasks,
  dueRules,
  gateTitle,
  proposalTask,
};
