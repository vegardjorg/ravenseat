// =============================================================
// decisionSignals.js: the choices a track's diff shows it made, read at `ravenseat receive` (phase 1 of
// plans/autonomi-nivaa-utredning.md, section 2.4).
//
// WHY: the mission tells agents to ask before a choice that is hard to undo (a new library, a migration, deleting
// things) and to write the rest under Assumptions. Nothing checked that they did. receive already has the whole diff, so
// the cheap facts can be read from it without a token: a signal per kind, and whether the agent asked about it. A
// signal without a matching owner question is "not asked", the one number that shows whether the instruction works.
// It is a hint, never a stop: the existing stops (merge guard on dependency files and migrations) stay as they are.
//
//   detect({ diff, migrations, testPaths, read, setup, report })
//       -> { signals: [{ category, what, items, asked, told }], notAsked: [category], lines }
//       category   dependency | migration | deletion | unstated
//       what       one line for a person ("2 new packages: date-fns, zod")
//       items      the names or paths behind it (package names, file paths, "Gemfile changed")
//       asked      true when an owner question in the report names the kind, false when none does, null for
//                  "unstated" (there is nothing to ask about; it is not counted)
//       told       true when the Assumptions name the kind (the agent said it, without asking)
//       lines      added plus removed lines outside tests and lockfiles (what "a big change" is measured on)
//     read(side, path) is optional ('base' | 'branch', as lib/testWeakening.js assess): with both sides of a manifest the
//     new names are exact; without it package.json is read from the diff's dependency sections and other manifests
//     only say the file changed.
//   record(result, { tip, at })   what receive stores on the task (decision_signals): cut, no diff text; null if none
//   row(task, record)             the time log row: { time, event: 'signal', task, tip, categories, not_asked }
//   isNewDelivery(prev, record)   a new row only when the tip changed (a second receive of the same delivery adds none)
//   receiveLine(id, record)       the one SIGNALS line receive prints, or null
//   LABELS                        the category names on the board and in `ravenseat decide --today`
//
// Pure (no git, no files). Tested in lib/__tests__/decisionSignals.test.ts.
// =============================================================
'use strict';

const MF = require('./manifests.js');
const { isMigrationPath } = require('./mergeGuard.js');
const { isTestFile } = require('./testWeakening.js');

/** The settings' defaults (config().decisionSignals in queueConfig.js STANDARD). */
const DEFAULTS = Object.freeze({ deleteMin: 3, bigDiffLines: 300 });
/** Stored on the task: at most this many items per signal, each at most this long. */
const ITEMS_MAX = 5;
const ITEM_MAX = 80;
const WHAT_MAX = 160;

/** The words people use for each kind, to see whether a question or an assumption is about it. */
const WORDS = Object.freeze({
  dependency: /packages?|librar(y|ies)|dependenc|\bnpm\b|\bpip\b|\bgems?\b|crates?\b|\bmodules?\b/i,
  migration: /migrat|schema|\btables?\b|\bcolumns?\b|database|\bdb\b|\bsql\b/i,
  deletion: /delet|remov|\bdrop/i,
});

/** The names on the board and in the CLI. */
const LABELS = Object.freeze({
  dependency: 'New package',
  migration: 'Migration or schema',
  deletion: 'Deletion',
  unstated: 'Unstated choices',
});
/** The same in a sentence ("Not asked: new package"). */
const lower = (c) => LABELS[c].toLowerCase();

const DEP_SECTIONS = new Set(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']);
const LOCKFILE = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|poetry\.lock|uv\.lock|Pipfile\.lock|Cargo\.lock|go\.sum|Gemfile\.lock|composer\.lock)$/i;
/** Manifests lib/manifests.js does not read: always "file changed". */
const OTHER_MANIFESTS = /(^|\/)(Gemfile|composer\.json|pom\.xml|build\.gradle(\.kts)?)$/;
const SCHEMA_NAMES = /(^|\/)(schema\.prisma|schema\.rb|structure\.sql)$/i;
const OUTSIDE = /(^|\/)(node_modules|vendor|\.venv|venv|target)\//;

const cut = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** The files in a git diff, in order: { path, from, status ('new' | 'deleted' | 'changed'), lines: [hunk lines] }. */
function parseFiles(diff) {
  const out = [];
  let f = null;
  let inHunk = false;
  for (const l of String(diff ?? '').split(/\r?\n/)) {
    const head = /^diff --git a\/(.+?) b\/(.+)$/.exec(l);
    if (head) {
      f = { from: head[1], path: head[2], status: 'changed', lines: [] };
      out.push(f);
      inHunk = false;
      continue;
    }
    if (!f) continue;
    if (!inHunk) {
      if (l.startsWith('new file mode')) f.status = 'new';
      else if (l.startsWith('deleted file mode')) f.status = 'deleted';
      if (l.startsWith('@@')) inHunk = true;
      continue;
    }
    f.lines.push(l);
  }
  return out;
}

/** The npm names added to a dependency section in the diff's hunks (an added and removed name is a bump). */
function npmFromDiff(lines) {
  const added = [];
  const removed = new Set();
  let section = null;
  for (const l of lines) {
    if (l.startsWith('@@')) {
      section = null;
      continue;
    }
    const sign = l[0];
    const body = l.slice(1);
    if (sign === ' ' || sign === '+') {
      const open = /^\s*"([^"]+)"\s*:\s*\{\s*$/.exec(body);
      if (open) {
        section = open[1];
        continue;
      }
      if (/^\s*\}/.test(body)) {
        section = null;
        continue;
      }
    }
    if (!DEP_SECTIONS.has(section)) continue;
    const m = /^\s*"([^"]+)"\s*:\s*"/.exec(body);
    if (!m) continue;
    if (sign === '+' && !added.includes(m[1])) added.push(m[1]);
    if (sign === '-') removed.add(m[1]);
  }
  return added.filter((n) => !removed.has(n));
}

/** The new names of a manifest from both sides, or null when a side cannot be read. */
function namesFromSides(f, read) {
  if (typeof read !== 'function') return null;
  const key = MF.ecosystemOf(f.path) === 'python' ? MF.pyName : (n) => n;
  const after = MF.manifestDeps(f.path, read('branch', f.path));
  if (!after) return null;
  let before = [];
  if (f.status !== 'new') {
    const text = read('base', f.from);
    before = text == null ? null : MF.manifestDeps(f.from, text);
  }
  if (!before) return null;
  const had = new Set(before.map((d) => key(d.name)));
  const out = [];
  for (const d of after) if (!had.has(key(d.name)) && !out.includes(d.name)) out.push(d.name);
  return out;
}

/** The dependency items of the diff: new names where they can be told, "<file> changed" where not. */
function dependencyItems(files, read) {
  const items = [];
  for (const f of files) {
    if (f.status === 'deleted' || OUTSIDE.test(f.path)) continue;
    const name = f.path.split('/').pop();
    if (OTHER_MANIFESTS.test(f.path)) {
      items.push(`${f.path} changed`);
      continue;
    }
    if (!MF.isManifestName(f.path)) continue;
    const exact = namesFromSides(f, read);
    if (exact) items.push(...exact);
    else if (name === 'package.json') items.push(...npmFromDiff(f.lines));
    else if (f.lines.some((l) => l[0] === '+' || l[0] === '-')) items.push(`${f.path} changed`);
  }
  return items.filter((x, i) => items.indexOf(x) === i);
}

/**
 * The signals in a track's diff and report.
 * @param {{ diff?: string, migrations?: { folder?: string|null }|null, testPaths?: string[],
 *   read?: (side: 'base'|'branch', path: string) => string|null,
 *   setup?: { deleteMin?: number, bigDiffLines?: number },
 *   report?: { assumptions?: string|null, questionText?: string|null, ownerQuestions?: number|null } }} input
 */
function detect({ diff = '', migrations = null, testPaths = [], read = null, setup = {}, report = {} } = {}) {
  const deleteMin = Number.isInteger(setup?.deleteMin) && setup.deleteMin > 0 ? setup.deleteMin : DEFAULTS.deleteMin;
  const bigDiffLines = Number.isInteger(setup?.bigDiffLines) && setup.bigDiffLines > 0 ? setup.bigDiffLines : DEFAULTS.bigDiffLines;
  const files = parseFiles(diff);
  const isTest = (p) => isTestFile(p, testPaths ?? []);
  const signals = [];

  const deps = dependencyItems(files, read);
  if (deps.length) {
    const names = deps.filter((x) => !/ changed$/.test(x));
    const what = names.length
      ? `${plural(names.length, 'new package', 'new packages')}: ${names.join(', ')}${names.length < deps.length ? `, and ${plural(deps.length - names.length, 'manifest', 'manifests')} changed` : ''}`
      : `${plural(deps.length, 'dependency file', 'dependency files')} changed: ${deps.map((x) => x.replace(/ changed$/, '')).join(', ')}`;
    signals.push({ category: 'dependency', what, items: deps });
  }

  const migr = files
    .filter((f) => f.status !== 'deleted' && !OUTSIDE.test(f.path))
    .map((f) => f.path)
    .filter((p) => isMigrationPath(p, migrations) || SCHEMA_NAMES.test(p) || /\.sql$/i.test(p));
  if (migr.length)
    signals.push({ category: 'migration', what: plural(migr.length, 'migration or schema file', 'migration or schema files'), items: migr });

  const deleted = files.filter((f) => f.status === 'deleted' && !isTest(f.path)).map((f) => f.path);
  if (deleted.length >= deleteMin)
    signals.push({ category: 'deletion', what: plural(deleted.length, 'file deleted', 'files deleted'), items: deleted });

  let lines = 0;
  for (const f of files) {
    if (isTest(f.path) || LOCKFILE.test(f.path)) continue;
    for (const l of f.lines) if (l[0] === '+' || l[0] === '-') lines += 1;
  }
  const assumptions = report?.assumptions ? String(report.assumptions) : '';
  const questionText = report?.questionText ? String(report.questionText) : '';
  if (lines >= bigDiffLines && !assumptions.trim())
    signals.push({ category: 'unstated', what: `a big change (${lines} lines) with no Assumptions`, items: [] });
  if (questionText.trim() && !(Number(report?.ownerQuestions) > 0))
    signals.push({ category: 'unstated', what: 'owner questions written, but ownerQuestions=0', items: [] });

  for (const s of signals) {
    const words = WORDS[s.category];
    s.asked = words ? Number(report?.ownerQuestions) > 0 && words.test(questionText) : null;
    s.told = words ? words.test(assumptions) : false;
  }
  const notAsked = signals.filter((s) => s.asked === false).map((s) => s.category);
  return { signals, notAsked: notAsked.filter((c, i) => notAsked.indexOf(c) === i), lines };
}

/** What receive stores on the task: the signals cut to size, the tip and the time. null when there are none. */
function record(result, { tip = null, at = new Date().toISOString() } = {}) {
  const list = result?.signals ?? [];
  if (!list.length) return null;
  return {
    at,
    tip,
    signals: list.map((s) => {
      const items = (s.items ?? []).slice(0, ITEMS_MAX).map((x) => cut(x, ITEM_MAX));
      const more = (s.items ?? []).length - items.length;
      return { category: s.category, what: cut(s.what, WHAT_MAX), items, ...(more > 0 ? { more } : {}), asked: s.asked ?? null, told: !!s.told };
    }),
    not_asked: [...(result.notAsked ?? [])],
  };
}

/** The time log row for one delivery: categories and what was not asked, never item text or file contents. */
function row(task, rec) {
  const categories = (rec?.signals ?? []).map((s) => s.category);
  return {
    time: rec?.at ?? new Date().toISOString(),
    event: 'signal',
    task,
    tip: rec?.tip ?? null,
    categories: categories.filter((c, i) => categories.indexOf(c) === i),
    not_asked: [...(rec?.not_asked ?? [])],
  };
}

/** A new delivery (another tip) gets a row; a second receive of the same one does not. */
function isNewDelivery(prev, rec) {
  return !prev || (prev.tip ?? null) !== (rec?.tip ?? null);
}

/** The one line receive prints. */
function receiveLine(id, rec) {
  if (!rec?.signals?.length) return null;
  const what = rec.signals.map((s) => s.what).join('; ');
  const notAsked = rec.not_asked?.length ? ` Not asked: ${rec.not_asked.map(lower).join(', ')}.` : '';
  return `SIGNALS: ${id}: ${what}.${notAsked} Shown in Decided for you; never a stop.`;
}

module.exports = { DEFAULTS, ITEMS_MAX, ITEM_MAX, WHAT_MAX, LABELS, WORDS, parseFiles, detect, record, row, isNewDelivery, receiveLine };
