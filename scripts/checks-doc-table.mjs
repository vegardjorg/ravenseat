#!/usr/bin/env node
// =============================================================
// scripts/checks-doc-table.mjs: writes the card table and the list of conditions in plugin/docs/checks.md from the
// card files.
//
// Why: the Checks tab's cards are data (plugin/scripts/orchestrator/checks-catalog/suggestions/<key>.md), so a table typed
// by hand goes stale the day a card is added or its priority changes. This reads the same files with the same parser the
// tab uses (lib/checksCatalog.js parseTemplate) and replaces what is between the markers in checks.md:
//   <!-- checks-table:start --> ... <!-- checks-table:end -->            one row per card
//   <!-- checks-conditions:start --> ... <!-- checks-conditions:end -->  every condition a card's `when` may use
// Each condition has a plain sentence here (PHRASES, KIND_PHRASES). A card with a condition this file has no sentence
// for stops the script with a message, so a new condition in the code is described before the table can be written.
//
// Usage: npm run docs:checks        (writes checks.md)
//        npm run docs:checks -- --check   (writes nothing; exit 1 and the reasons when checks.md is out of date)
// Tested in: scripts/__tests__/checksDocTable.test.mjs (the table in checks.md must match the card files).
// =============================================================
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORCH = path.join(ROOT, 'plugin', 'scripts', 'orchestrator');
export const CATALOG_DIR = path.join(ORCH, 'checks-catalog');
export const DOC = path.join(ROOT, 'plugin', 'docs', 'checks.md');
export const COMMAND = 'npm run docs:checks';
const require = createRequire(import.meta.url);
const CATALOG = require(path.join(ORCH, 'lib', 'checksCatalog.js'));
const SCAN = require(path.join(ORCH, 'lib', 'checksScan.js'));

export const MARKERS = {
  table: ['<!-- checks-table:start -->', '<!-- checks-table:end -->'],
  conditions: ['<!-- checks-conditions:start -->', '<!-- checks-conditions:end -->'],
};

/** The conditions without an argument (lib/checksCatalog.js CONDITIONS), each as the fact it reads, in plain words. */
export const PHRASES = {
  'has-git': 'the project uses git',
  'no-git': 'the folder is known to have no git',
  'no-commit': 'there is no commit yet (no git, or git with no commit)',
  'has-remote': 'the repo has a remote',
  'has-ci': 'a CI config file is found',
  'no-ci': 'no CI config file is found',
  'has-gates': 'gates are set in `queue.config.json`',
  'no-gates': 'no gates are set',
  'checks-found': 'the project has check commands of its own',
  'secrets-open': 'a secret file is not kept out of git',
  'known-stack': 'the project\'s stack is known',
  'instructions-large': 'Claude\'s instruction files are over the size limit',
  'packs-missing': 'a stack pack for the project\'s stack is not on in `review.packs`',
  'stack-unpacked': 'a known stack has no pack yet',
  'allowlist-tracked-hit': 'a key is found in a tracked approved command or a tracked `.mcp.json`',
  'gitignore-gap': 'the project\'s own `.gitignore` does not ignore `.claude/settings.local.json`, or git tracks a file Ravenseat keeps local',
  'repo-private': 'the repo is known to be private',
  'catalog-missing': 'there is no `docs/queue/catalog/` folder',
  'has-database': 'the project has a database',
  'has-migrations': 'migrations are set up',
  'has-local-database': 'a local or throwaway database is found (`supabase/config.toml`, a database image in a compose file, or testcontainers); a database only named by a URL is not local',
  'db-probes-on': 'the database probe recipes are on (`learning.dbProbes`)',
  'shared-settings': 'a tracked `.claude/settings.json` exists',
  'bypass-tracked': 'the tracked `.claude/settings.json` has `bypassPermissions`',
  'branch-unprotected': 'the base branch is not known to be protected on the host',
  'actions-unpinned': 'a `uses:` line in `.github/workflows` points at a tag or a branch',
  'lockfile-missing': 'a tracked manifest has no tracked lockfile',
  'runtime-unpinned': 'no runtime version is written down',
  'env-no-example': 'an ignored `.env` has no `.env.example` beside it',
  'flaky-observed': 'the time log shows a gate command red and then green on the same commit',
  'red-on-base-off': '`gates.redOnBase` is not set',
  'ledger-due': 'the finding log has a failure class due for a guard, not declined and with no gate yet for that place',
  'ledger-guard-failed': 'the finding log shows a failure class back where a guard for it was in place',
  'ledger-marker': '`learning.guardFailedMarker` is on',
  'inspection-on': 'the inspection queue is on (`inspection.mode`)',
  'not-lite': 'the project is not in lite mode',
  'client-format-changed': 'the newest Claude Code transcript has rows Ravenseat reads differently than expected (the format canary, `client.canary`)',
  'guard-not-in-quick': 'a gate guard in the registry has a command that is not in `gates.quick` (`learning.quickGateCard`)',
  'audit-findings': 'the last [dependency audit](catalog.md#the-dependency-audit) (`catalog deps --audit`, read from its cache) found holes that no accepted catalog entry covers',
  'audit-high-prod': 'one of those holes is critical or high in a package that is not only for development',
  'processes-left': 'a process Ravenseat started is still running after its starter ended or past its time budget (`processGuard.sweep`)',
  'processes-untagged': 'a gate, done or base run without a track has run over 30 minutes',
  'tracks-overtime': 'a running track is over `tracks.overtimeFactor` times its estimate',
  'keyscan-open': 'the last `ravenseat secrets scan` (read from `secret-scan.json`) has a finding that is not set aside as a false alarm',
  'keyscan-due': 'no `ravenseat secrets scan` has run yet, or the last one is older than `secretScan.rescanDays` (not 0), and nothing is open',
};

/**
 * The conditions with an argument (`name:a|b`). `any` is the argument in words joined by "or" ("tests or lint"),
 * `each` the same words one by one. `missing` and `not-in-ci` hold when ONE of the kinds is missing or outside CI,
 * so they say it per kind; `none-in-ci` holds when none of them runs in CI.
 */
const orJoin = (parts, sep = ', ') => (parts.length > 1 ? `${parts.slice(0, -1).join(sep)} or ${parts[parts.length - 1]}` : parts[0]);
export const KIND_PHRASES = {
  missing: (any, each) => orJoin(each.map((k) => `no ${k} found`), ', '),
  found: (any) => `${any} found`,
  'not-in-ci': (any, each) => orJoin(each.map((k) => `${k} found but not in CI`), ', '),
  'none-in-ci': (any) => `no ${any} in CI`,
  off: (any) => `${any} is off`,
  'ledger-due': (any) => `the finding log has ${any} due for a guard`,
  'ledger-guard-failed': (any) => `the finding log shows ${any} back where a guard was in place`,
  'ledger-recent': (any) => `the finding log shows ${any} 3 times in one area within 30 days (never in lite mode)`,
  stack: (any) => `the project's stack is ${any} (a word of a stack found, such as typescript in Node/TypeScript, or a stack pack found, or a word an accepted [stack entry](catalog.md#stack-entries) in the catalog declares, with \`catalog.stackFacts\` on)`,
  'local-db': (any) => `the local database found runs ${any}`,
  'guard-not-in-ci': (any, each) => orJoin(each.map((k) => `a gate guard runs ${k} but CI does not`), ', '),
};
/** What each argument names: kinds of check, settings, or failure classes. */
const ARG_KIND = { missing: 'kind', found: 'kind', 'not-in-ci': 'kind', 'none-in-ci': 'kind', 'guard-not-in-ci': 'kind', off: 'setting' };
const KIND_TITLE = Object.fromEntries(SCAN.KINDS.map((k) => [k.key, k.title.toLowerCase()]));

/** The button on the tab for each `action`, and the command it runs. */
const BUTTONS = {
  none: (key) => `Add investigation to queue (\`checks plan ${key}\`)`,
  gates: () => 'Use as gates (`kickstart gates --apply`)',
  packs: () => 'Turn on (`checks packs --apply`)',
  setting: (key) => `Turn on (\`checks turn-on ${key}\`)`,
  ask: () => 'Copy the text for Claude (no agent)',
  'quick-gate': () => 'Add to gates.quick, one per guard (`checks quick-add <G-n>`; nothing runs)',
  'dep-fix': (key) => `Propose update task (\`checks plan ${key}\`; always a proposal)`,
};
const PRIORITY = { high: 'High', medium: 'Medium', low: 'Low' };

/** Text that goes into a table cell: no pipes, no line breaks. */
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

/** The argument of a condition in words, one per part: `test|lint` is ["tests", "lint"], `scope-drift` is ["scope drift"]. */
function argWords(name, arg) {
  return arg.split('|').map((x) => {
    if (ARG_KIND[name] === 'kind') {
      if (!KIND_TITLE[x]) throw new Error(`the kind "${x}" is not in lib/checksScan.js KINDS`);
      return KIND_TITLE[x];
    }
    if (ARG_KIND[name] === 'setting') return `\`${x}\``;
    return x.replace(/-/g, ' ');
  });
}

/** One condition in words. Throws for a condition this file does not describe, naming the file to change. */
export function phrase(condition) {
  const [name, arg] = condition.split(':');
  if (arg) {
    if (!KIND_PHRASES[name]) throw new Error(`no sentence for the condition "${name}:" in scripts/checks-doc-table.mjs KIND_PHRASES`);
    const each = argWords(name, arg);
    return KIND_PHRASES[name](orJoin(each), each);
  }
  if (!PHRASES[name]) throw new Error(`no sentence for the condition "${name}" in scripts/checks-doc-table.mjs PHRASES`);
  return PHRASES[name];
}

/** A `when` in words: every condition must hold, so they are joined with "and". Empty: always. */
export function whenWords(when) {
  const list = String(when ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (!list.length) return 'always';
  const words = list.map(phrase);
  return words.length > 1 ? `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}` : words[0];
}

/** The categories and cards of a catalog folder (the plugin's by default), with the parser's own errors as a stop. */
export function readCards(dir = CATALOG_DIR) {
  const categories = JSON.parse(fs.readFileSync(path.join(dir, 'categories.json'), 'utf8'));
  const files = fs.readdirSync(path.join(dir, 'suggestions')).filter((f) => f.endsWith('.md')).sort();
  const cards = files.map((f) => CATALOG.parseTemplate(fs.readFileSync(path.join(dir, 'suggestions', f), 'utf8'), f.slice(0, -3)));
  const errors = cards.flatMap((c) => c.errors);
  if (errors.length) throw new Error(`a card file has a mistake: ${errors.join('; ')}`);
  return { categories, cards: cards.filter((c) => !c.off) };
}

/** The priority cell: the card's own priority, and what raises it. */
function priorityCell(c) {
  const out = [PRIORITY[c.priority] ?? c.priority];
  if (c.importantWhen) out.push(`high (red dot) while ${whenWords(c.importantWhen)}`);
  if (c.mediumWhen && c.priority === 'low') out.push(`medium while ${whenWords(c.mediumWhen)}`);
  if (c.liftWhen) out.push(`first in its priority while ${whenWords(c.liftWhen)} (learning.ciParityLift)`);
  return out.join('; ');
}

/** One table row per card, keyed by the card's key. */
export function rows(dir = CATALOG_DIR) {
  const { categories, cards } = readCards(dir);
  const order = new Map(categories.map((c, i) => [c.key, i]));
  const title = new Map(categories.map((c) => [c.key, c.title]));
  const rank = (c) => CATALOG.PRIORITIES.indexOf(c.priority);
  return cards
    .slice()
    .sort((a, b) => (order.get(a.category) ?? 99) - (order.get(b.category) ?? 99) || rank(a) - rank(b) || a.key.localeCompare(b.key))
    .map((c) => {
      const button = BUTTONS[c.action ?? 'none'](c.key) + (c.alsoTask ? `; shows as under way while ${c.alsoTask} is in the queue` : '');
      const cells = [
        `${c.title} (\`${c.key}\`)`,
        title.get(c.category) ?? c.category,
        whenWords(c.when),
        priorityCell(c),
        button,
        c.setting ? `\`${c.setting}\`` : 'none',
      ];
      return { key: c.key, line: `| ${cells.map(cell).join(' | ')} |` };
    });
}

/** The whole block between the table markers. */
export function renderTable(dir = CATALOG_DIR) {
  const list = rows(dir);
  return [
    '',
    `Generated by \`${COMMAND}\` from \`plugin/scripts/orchestrator/checks-catalog/\` (${list.length} cards). Do not edit by hand.`,
    '',
    '| Card | Category | Shows when | Priority | Button | Setting |',
    '| --- | --- | --- | --- | --- | --- |',
    ...list.map((r) => r.line),
    '',
  ].join('\n');
}

/** The whole block between the condition markers: every condition the code knows, with its sentence. */
export function renderConditions() {
  const plain = Object.keys(CATALOG.CONDITIONS).map((name) => `| \`${name}\` | ${cell(phrase(name))} |`);
  const withArg = [
    ['missing:<kinds>', 'missing:test|lint'],
    ['found:<kinds>', 'found:test'],
    ['not-in-ci:<kinds>', 'not-in-ci:types|lint'],
    ['none-in-ci:<kinds>', 'none-in-ci:migrate'],
    ['off:<setting>', 'off:secretScan.atReceive'],
    ['ledger-due:<classes>', 'ledger-due:access-control'],
    ['ledger-guard-failed:<classes>', 'ledger-guard-failed:access-control'],
    ['ledger-recent:<classes>', 'ledger-recent:duplication|scope-drift'],
    ['stack:<stacks>', 'stack:typescript|python'],
  ].map(([form, example]) => `| \`${form}\` | ${cell(phrase(example))} (example: \`${example}\`) |`);
  return [
    '',
    `Generated by \`${COMMAND}\` from \`lib/checksCatalog.js\` and \`lib/checksScan.js\`. Do not edit by hand.`,
    '',
    '| Condition | Holds when |',
    '| --- | --- |',
    ...plain,
    ...withArg,
    '',
    `The kinds for \`missing\`, \`found\`, \`not-in-ci\` and \`none-in-ci\`: ${SCAN.KINDS.map((k) => `\`${k.key}\` (${k.title.toLowerCase()})`).join(', ')}.`,
    '',
  ].join('\n');
}

/** The text between two markers, or null when they are not both there in order. */
export function between(text, [start, end]) {
  const a = text.indexOf(start);
  const b = text.indexOf(end);
  return a >= 0 && b > a ? text.slice(a + start.length, b) : null;
}

/**
 * What is out of date in checks.md, as sentences (empty: up to date). It names a card that is missing from the table, a
 * row the table has for no card, and a row that no longer says what the card file says.
 */
export function problems(docText, { dir = CATALOG_DIR } = {}) {
  const text = String(docText).replace(/\r\n/g, '\n');
  const out = [];
  const table = between(text, MARKERS.table);
  if (table == null) out.push(`checks.md has no ${MARKERS.table.join(' ... ')} block`);
  else {
    const want = rows(dir);
    const have = new Map();
    for (const line of table.split('\n').filter((l) => l.startsWith('| ') && !l.startsWith('| Card') && !l.startsWith('| ---'))) {
      const key = /\(`([a-z0-9-]+)`\)/.exec(line)?.[1];
      if (key) have.set(key, line);
    }
    for (const r of want) {
      if (!have.has(r.key)) out.push(`the card ${r.key} is missing from the table`);
      else if (have.get(r.key) !== r.line) out.push(`the row for ${r.key} is out of date`);
    }
    const known = new Set(want.map((r) => r.key));
    for (const key of have.keys()) if (!known.has(key)) out.push(`the table has a row for ${key}, which is no card`);
    if (!out.length && table !== renderTable(dir)) out.push('the table is in another order or its header changed');
  }
  const conditions = between(text, MARKERS.conditions);
  if (conditions == null) out.push(`checks.md has no ${MARKERS.conditions.join(' ... ')} block`);
  else if (conditions !== renderConditions()) out.push('the list of conditions is out of date');
  return out;
}

/** checks.md with both blocks written fresh. */
export function updated(docText, { dir = CATALOG_DIR } = {}) {
  let text = String(docText).replace(/\r\n/g, '\n');
  for (const [name, render] of [['table', () => renderTable(dir)], ['conditions', renderConditions]]) {
    const [start, end] = MARKERS[name];
    const a = text.indexOf(start);
    const b = text.indexOf(end);
    if (a < 0 || b < a) throw new Error(`checks.md has no ${start} ... ${end} block to write into`);
    text = text.slice(0, a + start.length) + render() + text.slice(b);
  }
  return text;
}

function main() {
  const text = fs.readFileSync(DOC, 'utf8');
  if (process.argv.includes('--check')) {
    const p = problems(text);
    if (p.length) {
      console.error(`plugin/docs/checks.md is out of date:\n- ${p.join('\n- ')}\nRun: ${COMMAND}`);
      process.exit(1);
    }
    console.log('plugin/docs/checks.md matches the card files.');
    return;
  }
  const next = updated(text);
  if (next === text.replace(/\r\n/g, '\n')) console.log('plugin/docs/checks.md was already up to date.');
  else {
    fs.writeFileSync(DOC, next);
    console.log(`plugin/docs/checks.md: the table (${rows().length} cards) and the conditions are written.`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error(`checks-doc-table: ${e.message}`);
    process.exit(1);
  }
}
