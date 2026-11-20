// =============================================================
// lib/checksCatalog.js: the suggestions on the Checks tab, as data. No suggestion is written in code.
//
// One template file per suggestion (checks-catalog/suggestions/<key>.md) and one list of categories
// (checks-catalog/categories.json). A project changes them without touching the plugin, in docs/queue/checks/ (same layout):
//   - a new file adds a suggestion, a file with the same name replaces it, a file with `off: true` removes it;
//   - a category with a new key is added, the same key replaces it, `"off": true` removes it and its suggestions.
//
// A template: a header (title, category, priority, when, why, content_min, also_task, action, setting, important_when,
// medium_when, lift_when) and two sections,
// "## Investigate" and "## Plan and build". The sections become the mission of the investigation task.
// Three kinds need no agent: `action: gates` (ravenseat kickstart gates --apply), `action: packs` (ravenseat checks packs
// --apply: the stack packs for the review signals, lib/reviewPacks.js) and `action: ask`, whose one section
// "## Ask Claude" is the text the owner gives Claude in their own session. `ask` is for a step a queue agent cannot take,
// such as the first commit: an agent's worktree is made from a commit. `action: setting` (with `setting: <key>`) turns an
// opt-in check on (lib/optInChecks.js, `ravenseat checks turn-on <key>`); its `when` is usually `off:<key>`.
// `important_when` raises the priority to high while its conditions hold, so an important gap lights the red marker
// until it is fixed or the card is set aside (a card set aside never comes back by itself, and stays in the report with
// applies: false when its `when` no longer holds, so it can still be brought back). `medium_when` raises a low
// card to medium while its conditions hold (something was observed, such as a flaky test), without the red marker.
// `lift_when` puts the card first within its own priority while its conditions hold, and names why (a built gate guard
// whose kind of check CI does not run, 0i step 9b). It never changes the priority, so it never lights the red marker
// (plans/feillogg-til-gater-2026-11-15.md section 3.9: the marker is for a guard that failed). `action: quick-gate` is
// the card that offers to add a gate guard's command to gates.quick (`ravenseat checks quick-add <G-n>`, lib/quickGate.js):
// the items come from the registry through facts.quickGate, never from the card's text.
//
// The same folders hold recipes.json: per failure class and stack, what would guard a class the finding log keeps seeing
// (0i section 3.7). The card ledger-recipes shows the due classes with the first recipe whose `when` holds; see the
// Recipes block below.
//
//   parseTemplate(text, key)      one file as an object, with errors in words
//   recipeFor(cls, facts, list)   the recipe for a class in this project, or null (a damped one is skipped)
//   dampedFor(cls, facts, list)   the recipes for a class damped by their precision (lib/recipePrecision.js, 0i step 9)
//   recipeExampleProblems(r)      a recipe's examples that do not behave
//   mergeCatalog(builtin, own)    the project's files over the plugin's
//   loadCatalog({ builtin, own }) reads the two folders
//   holds(when, facts)            does a suggestion apply? Named conditions only, see CONDITIONS
//   buildReport(...)              what `ravenseat checks --json`, the board and checks-report.json read
//   planTask(...)                 the investigation task for `ravenseat add`
//
// Used by: cli/checks.mjs. Tested in: lib/__tests__/checksCatalog.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PRIORITIES = ['high', 'medium', 'low'];
const ACTIONS = ['gates', 'ask', 'packs', 'setting', 'quick-gate'];
/** The card that offers to add a gate guard's command to gates.quick (action quick-gate, lib/quickGate.js items). */
const QUICK_GATE_CARD = 'quick-gate-add';
const REPORT_VERSION = 1;
/** Incidents of a class in one area within 30 days (lib/findingRepeats.js facts.recent) that make ledger-recent hold. */
const RECENT_MIN = 3;

const anyKind = (arg, test) => arg.split('|').some((k) => test(k));
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** Where a kind of check was found: Set of ci, gate, script, hook, config. */
const placesOf = (facts, kind) => new Set((facts.kinds?.find((k) => k.key === kind)?.places ?? []).map((p) => p.where));

/** What a template's `when` may say. Comma = all must hold. `missing:a|b` = at least one of a and b. */
const CONDITIONS = {
  'has-git': (f) => !!f.git,
  // Only when the scan says so (false), never when the fact is unknown.
  'no-git': (f) => f.git === false,
  'no-commit': (f) => f.hasCommit === false,
  'has-remote': (f) => !!f.remote,
  'has-ci': (f) => (f.ci?.length ?? 0) > 0,
  'no-ci': (f) => (f.ci?.length ?? 0) === 0,
  'has-gates': (f) => !!f.hasGates,
  'no-gates': (f) => !f.hasGates,
  'checks-found': (f) => (f.checks?.length ?? 0) > 0,
  'secrets-open': (f) => f.secretsOk === false,
  'known-stack': (f) => (f.stacks?.length ?? 0) > 0,
  // Claude's instructions are over a limit (lib/instructionSize.js assess().large, off with instructionSize.mode off).
  'instructions-large': (f) => f.instructionsLarge === true,
  // Stack packs (lib/reviewPacks.js): a pack for the project's stack is not on in review.packs yet, or a known stack has none.
  'packs-missing': (f) => (f.packs?.missing?.length ?? 0) > 0,
  'stack-unpacked': (f) => (f.packs?.unpacked?.length ?? 0) > 0,
  // The important gaps of the opt-in checks (cli/doctorBaseline.mjs allowlistFacts, gitignoreFacts), read while off.
  'allowlist-tracked-hit': (f) => f.allowlistTrackedHit === true,
  'gitignore-gap': (f) => f.gitignoreGap === true,
  // The repo is known to be private (the cached answer, lib/repoVisibility.js); unknown or public: false.
  'repo-private': (f) => f.repoPrivate === true,
  // The project has no catalog in docs/queue/catalog/ yet (lib/catalog.js, cli/checks.mjs). Unknown: not missing, no card.
  'catalog-missing': (f) => f.catalogMissing === true,
  // The database (lib/checksScan.js scan): a database at all, and migrations set up.
  'has-database': (f) => f.hasDatabase === true,
  'has-migrations': (f) => f.hasMigrations === true,
  // A local or throwaway database is found in the files (lib/checksScan.js localDatabase: supabase/config.toml, a
  // database image in a compose file, testcontainers). A database only named by a URL is not local (0i section 3.8).
  'has-local-database': (f) => isPlainObject(f.localDatabase),
  // The database probe recipes are on (learning.dbProbes, off by default; lib/findingRepeats.js setupOf, cli/checks.mjs).
  'db-probes-on': (f) => f.dbProbesOn === true,
  // The tracked .claude/settings.json (lib/broadPermissions.js, cli/checks.mjs): it exists, and bypassPermissions in it.
  'shared-settings': (f) => f.sharedSettings === true,
  'bypass-tracked': (f) => f.bypassTracked === true,
  // The base branch on the host (lib/branchProtection.js): only a clear "on" hides the card; unknown shows it.
  'branch-unprotected': (f) => f.branchProtected !== true,
  // A `uses:` in .github/workflows on a tag or branch, not a commit SHA (lib/checksScan.js).
  'actions-unpinned': (f) => (f.unpinnedActions ?? 0) > 0,
  // A tracked manifest without a tracked lockfile (lib/lockfiles.js, the same rule as doctor's lockfile row).
  'lockfile-missing': (f) => f.lockfileMissing === true,
  // No runtime version written down (lib/checksScan.js runtimePinned). Unknown: pinned, so no card.
  'runtime-unpinned': (f) => f.runtimePinned === false,
  // An ignored .env on disk and no .env.example next to it (cli/checks.mjs).
  'env-no-example': (f) => f.envWithoutExample === true,
  // A gate command was red and then green on the same commit (lib/flakyObserved.js, from the time log).
  'flaky-observed': (f) => (f.flakyObserved ?? 0) > 0,
  // gates.redOnBase is not set (lib/redOnBase.js setup, read by cli/checks.mjs). Unknown: not off, so no card.
  'red-on-base-off': (f) => f.redOnBaseOff === true,
  // The finding log (lib/findingRepeats.js facts, read by cli/checks.mjs into facts.ledger): a class came back in an
  // area often enough for a proposal, a guard did not hold, and whether learning.guardFailedMarker is on. No log, or
  // learning.repeats off: no facts, so none of these holds.
  // Due counts only an open entry: a class and area the owner declined as a gate proposal, or one with a gate, is left
  // out (openDue), so a no is remembered per class and area.
  'ledger-due': (f) => openDue(f.ledger).length > 0,
  'ledger-guard-failed': (f) => (f.ledger?.guardFailed?.length ?? 0) > 0,
  'ledger-marker': (f) => f.ledger?.marker === true,
  // The inspection queue is on (inspection.mode, lib/inspection.js setupOf, read by cli/checks.mjs). Proposals from the
  // finding log need it (owner decision 2026-11-16). Unknown: not on, so no card that needs it.
  'inspection-on': (f) => f.inspectionOn === true,
  // The project is not in lite mode (cli/checks.mjs facts.lite). Unknown: not lite, so the card shows.
  'not-lite': (f) => f.lite !== true,
  // The client format canary (lib/clientCanary.js facts, read by cli/checks.mjs): the newest transcript has rows the
  // adapter reads differently than expected. A newer version alone does not hold it. Off with client.canary off.
  'client-format-changed': (f) => f.clientCanary?.signal === true,
  // A gate guard in the registry whose command is not in gates.quick (facts.quickGate.items, lib/quickGate.js items).
  'guard-not-in-quick': (f) => Array.isArray(f.quickGate?.items) && f.quickGate.items.length > 0,
};

/** The classes of the finding log entries in `list` (facts.ledger.due or .guardFailed). */
const ledgerClasses = (list) => new Set((Array.isArray(list) ? list : []).map((e) => e?.class));

/** What became of a due entry as a proposal that takes it off the cards (lib/findingRepeats.js proposalOf). */
const CLOSED_PROPOSAL = new Set(['declined', 'exists']);

/**
 * The due entries still open: not `other` (it never gives a proposal), and not declined by the owner or already built
 * as a gate for that class and area. An entry whose proposal is unknown (no tasks read) stays.
 */
const openDue = (ledger) =>
  (Array.isArray(ledger?.due) ? ledger.due : []).filter((e) => e && e.class !== 'other' && !CLOSED_PROPOSAL.has(e.proposal?.state));

/** The words of the stacks a project has (lib/kickstart.js detectChecks: "Node/TypeScript", "Python") and its packs. */
function stackWords(f) {
  const words = new Set();
  for (const s of Array.isArray(f.stacks) ? f.stacks : []) for (const w of String(s).toLowerCase().split(/[^a-z0-9.+#-]+/)) if (w) words.add(w);
  for (const id of Array.isArray(f.packs?.detected) ? f.packs.detected : []) words.add(String(id).toLowerCase());
  return words;
}

/** The finding log entries as one short line for a card: the class, the area and the guard that did not hold. */
function ledgerLine(list, { guard = false } = {}) {
  const items = (Array.isArray(list) ? list : []).slice(0, 3).map((e) => {
    const where = e.scope === 'project' ? 'across the project' : `in ${e.area}`;
    const seen = e.tasks?.length ? `, seen in ${e.tasks.slice(0, 3).join(', ')}` : '';
    const held = guard && e.guardFailed ? ` after ${e.guardFailed.ref} (${GUARD_REASON[e.guardFailed.reason] ?? e.guardFailed.reason})` : '';
    return `${e.title ?? e.class} ${where}: ${e.incidents} incident(s)${seen}${held}`;
  });
  const more = (list?.length ?? 0) > 3 ? ` And ${list.length - 3} more.` : '';
  return items.length ? `${items.join('; ')}.${more}` : null;
}

/** What held before the class came back (lib/findingRepeats.js guardFailed.reason), in plain words. */
const GUARD_REASON = { guard: 'a guard for it', fix: 'a fix with a test that failed without it', 'untested-h': 'a fix without a test, high severity' };

/** The guards not in gates.quick, as one line: id, command, and whether gates.full already runs it. */
function quickGateLine(items) {
  const list = (Array.isArray(items) ? items : []).slice(0, 3).map((i) => `${i.guard} "${i.command}"${i.inFull ? ' (in gates.full only)' : ''}`);
  const more = (items?.length ?? 0) > 3 ? ` And ${items.length - 3} more.` : '';
  return list.length ? `Not in gates.quick: ${list.join('; ')}.${more}` : null;
}

/**
 * The audit command per declared stack word (roadmap 0å KD-2): the package manager or toolchain a stack entry the owner
 * accepted names. The first word in this order wins, so pnpm beats a plain npm.
 */
const AUDIT = Object.freeze([
  ['pnpm', 'pnpm audit'],
  ['yarn', 'yarn npm audit'],
  ['npm', 'npm audit'],
  ['uv', 'pip-audit'],
  ['poetry', 'pip-audit'],
  ['pip', 'pip-audit'],
  ['cargo', 'cargo audit'],
  ['rust', 'cargo audit'],
  ['go', 'govulncheck ./...'],
]);

/** The dep-audit card's line from the declared stack words (facts.declaredStacks), or null: nothing is guessed. */
function auditLine(declared) {
  const list = Array.isArray(declared) ? declared : [];
  for (const [word, command] of AUDIT) {
    const hit = list.find((x) => x?.word === word);
    if (hit) return `For this project: \`${command}\` (${hit.id} in the catalog says ${word}).`;
  }
  return null;
}

/** The line a suggestion adds from the facts, so the card names the stacks. Null when it has none. */
function detailOf(key, facts) {
  // The command for the project's test runner (lib/fixTests.js suggestCommand); none is made up for an unknown stack.
  if (key === 'red-on-base')
    return typeof facts.redOnBaseCommand === 'string' && facts.redOnBaseCommand
      ? `For this project: \`${facts.redOnBaseCommand}\` (read from its own files). Check that it runs only the files it is given.`
      : null;
  if (key === 'guard-failed') return ledgerLine(facts.ledger?.guardFailed, { guard: true });
  if (key === 'dep-audit') return auditLine(facts.declaredStacks);
  // The canary's own lines: the version and the row types with counts, never content (lib/clients/claude/canary.js news).
  if (key === 'client-format')
    return facts.clientCanary?.lines?.length ? `Seen in the newest transcript: ${facts.clientCanary.lines.join('; ')}.` : null;
  if (key === 'learning-proposals') return ledgerLine(openDue(facts.ledger));
  if (key === QUICK_GATE_CARD) return quickGateLine(facts.quickGate?.items);
  const p = facts.packs;
  if (!p) return null;
  const name = (id) => p.titles?.[id] ?? id;
  if (key === 'stack-review-signals' && p.missing?.length)
    return `Packs for your stack: ${p.missing.map(name).join(', ')}. They add the risky calls of these stacks to the review signals, so the security reviewer is asked when such code changes.`;
  if (key === 'stack-pack-research' && p.unpacked?.length)
    return `No pack yet for: ${p.unpacked.join(', ')}. The research writes one for docs/queue/review-packs/, with examples that test it.`;
  return null;
}

/** Two detail lines as one (either may be null). */
const joinDetail = (a, b) => (a && b ? `${a} ${b}` : (a ?? b ?? null));

/** Why a card was lifted: the gate guards of the kinds in its lift_when that CI does not run. */
function liftLine(x, facts) {
  const ids = new Set();
  for (const c of conditionsOf(x.liftWhen)) {
    const [name, arg] = c.split(':');
    if (name !== 'guard-not-in-ci' || !arg) continue;
    for (const k of arg.split('|')) if (!placesOf(facts, k).has('ci')) for (const id of guardsOfKind(facts, k)) ids.add(id);
  }
  const list = [...ids].slice(0, 5).join(', ');
  return list ? `A gate guard runs this on merge but CI does not: ${list}. A push around the queue skips it.` : null;
}

/** The line the cards that count something add (flaky runs, unpinned actions). Null when there is nothing to say. */
function countDetail(key, facts) {
  const n = (x) => (Number.isFinite(x) ? x : 0);
  if (key === 'flaky-tests' && n(facts.flakyObserved) > 0)
    return `Seen in the time log: ${facts.flakyObserved} time(s) a gate command was red and then green on the same commit, with no new commit in between.`;
  // The scope drift guards' cards (V6, V7): what the finding log saw when it made them important.
  const drift = n(facts.ledger?.recent?.['scope-drift']);
  if ((key === 'drift-gap-review' || key === 'drift-write-warn') && drift >= RECENT_MIN && facts.lite !== true)
    return `Seen in the finding log: scope drift ${drift} time(s) in one area within 30 days.`;
  if (key === 'pin-actions' && n(facts.unpinnedActions) > 0)
    return `${facts.unpinnedActions} \`uses:\` line(s) in .github/workflows point at a tag or a branch.`;
  return null;
}
const KIND_CONDITIONS = {
  missing: (f, arg) => anyKind(arg, (k) => placesOf(f, k).size === 0),
  found: (f, arg) => anyKind(arg, (k) => placesOf(f, k).size > 0),
  'not-in-ci': (f, arg) => anyKind(arg, (k) => placesOf(f, k).size > 0 && !placesOf(f, k).has('ci')),
  // None of the kinds runs in CI (found elsewhere or not at all): `none-in-ci:migrate`.
  'none-in-ci': (f, arg) => !anyKind(arg, (k) => placesOf(f, k).has('ci')),
  // A gate guard's command is one of the kinds (facts.guardKinds, lib/quickGate.js guardKinds) and CI does not run that
  // kind: `guard-not-in-ci:test`. Unknown facts (the setting learning.ciParityLift off): never.
  'guard-not-in-ci': (f, arg) => anyKind(arg, (k) => guardsOfKind(f, k).length > 0 && !placesOf(f, k).has('ci')),
  // An opt-in check that is off (facts.optInOff: the keys, lib/optInChecks.js). Unknown facts: not off.
  off: (f, arg) => anyKind(arg, (k) => (f.optInOff ?? []).includes(k)),
  // The finding log per class: `ledger-due:migration-schema|access-control` (a proposal is due for one of them),
  // `ledger-guard-failed:<classes>`, and `ledger-recent:duplication|scope-drift`, which holds at 3 incidents of one of
  // the classes in one area within 30 days (the scope drift cards' important_when, plans/scope-drift-dry-katalog).
  // Never in lite mode: no scope drift or catalog card lights the red marker there (the plan's section 4).
  'ledger-due': (f, arg) => anyKind(arg, (k) => ledgerClasses(openDue(f.ledger)).has(k)),
  'ledger-guard-failed': (f, arg) => anyKind(arg, (k) => ledgerClasses(f.ledger?.guardFailed).has(k)),
  'ledger-recent': (f, arg) => f.lite !== true && anyKind(arg, (k) => (f.ledger?.recent?.[k] ?? 0) >= RECENT_MIN),
  // The project's stack: `stack:typescript|python`. A word of a stack the manifests show (facts.stacks, so
  // "Node/TypeScript" is node and typescript) or a stack pack found (facts.packs.detected, such as supabase).
  stack: (f, arg) => anyKind(arg, (k) => stackWords(f).has(k.toLowerCase())),
  // The engine of the local database found: `local-db:postgres|mysql` (lib/checksScan.js localDatabase.engines).
  'local-db': (f, arg) => anyKind(arg, (k) => isPlainObject(f.localDatabase) && Array.isArray(f.localDatabase.engines) && f.localDatabase.engines.includes(k)),
};

/** The gate guards whose command is this kind of check (facts.guardKinds). */
const guardsOfKind = (f, kind) => (isPlainObject(f.guardKinds) && Array.isArray(f.guardKinds[kind]) ? f.guardKinds[kind] : []);

const conditionsOf = (when) => String(when ?? '').split(',').map((x) => x.trim()).filter(Boolean);

/** A condition's name is known? */
function knownCondition(c) {
  const [name, arg] = c.split(':');
  return arg ? !!KIND_CONDITIONS[name] : !!CONDITIONS[name];
}

/**
 * The conditions that only describe the project's setup (it has git, CI, gates, tests, a stack; an opt-in setting is off)
 * and so observe no gap or hit in it. A low card whose `when` has only these is quiet: the Checks tab folds it under
 * "More ideas" (board/checks.js), since it would show in nearly every project (0x M6). Every other condition, also one
 * added later, counts as a signal, so a new kind of gap is never folded away by mistake. Quiet changes no priority, and
 * a card raised by medium_when, important_when or lift_when is not quiet.
 */
const CONTEXT = new Set([
  'has-git', 'has-remote', 'has-ci', 'has-gates', 'checks-found', 'known-stack', 'not-lite', 'shared-settings',
  'repo-private', 'has-database', 'has-migrations', 'has-local-database', 'db-probes-on', 'inspection-on',
  'red-on-base-off', 'found', 'off', 'stack', 'local-db',
]);

/** Is a card quiet: low, not lifted, and every condition in its `when` is context (see CONTEXT)? */
function quietCard(x) {
  if (x.priority !== 'low' || x.lifted) return false;
  return conditionsOf(x.when).every((c) => CONTEXT.has(c.split(':')[0]));
}

/** Does `when` hold? An empty `when` always does; an unknown condition never does (parseTemplate reports it). */
function holds(when, facts) {
  return conditionsOf(when).every((c) => {
    const [name, arg] = c.split(':');
    if (arg) return KIND_CONDITIONS[name] ? KIND_CONDITIONS[name](facts, arg) : false;
    return CONDITIONS[name] ? CONDITIONS[name](facts) : false;
  });
}

/**
 * One template file as an object.
 * @returns {{ key: string, off: boolean, errors: string[], title?: string, category?: string, priority?: string, when?: string,
 *   why?: string, contentMin?: number, alsoTask?: string|null, action?: string|null, investigate?: string, plan?: string }}
 */
function parseTemplate(text, key) {
  const src = String(text ?? '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(src);
  if (!m) return { key, off: false, errors: [`${key}: no header between --- lines`] };
  const head = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) head[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  if (head.off === 'true') return { key, off: true, errors: [] };
  const sections = {};
  let current = null;
  for (const line of m[2].split('\n')) {
    const h = /^##\s+(.+)$/.exec(line);
    if (h) current = h[1].trim().toLowerCase();
    else if (current) sections[current] = `${sections[current] ?? ''}${line}\n`;
  }
  const out = {
    key,
    off: false,
    title: head.title,
    category: head.category,
    priority: head.priority,
    when: head.when ?? '',
    why: head.why,
    contentMin: Number(head.content_min) > 0 ? Number(head.content_min) : 60,
    alsoTask: head.also_task || null,
    action: head.action || null,
    setting: head.setting || null,
    importantWhen: head.important_when || '',
    mediumWhen: head.medium_when || '',
    liftWhen: head.lift_when || '',
    ask: (sections['ask claude'] ?? '').trim(),
    investigate: (sections.investigate ?? '').trim(),
    plan: (sections['plan and build'] ?? '').trim(),
    errors: [],
  };
  for (const field of ['title', 'category', 'why']) if (!out[field]) out.errors.push(`${key}: "${field}" is missing`);
  if (!PRIORITIES.includes(out.priority)) out.errors.push(`${key}: priority must be ${PRIORITIES.join(', ')}`);
  for (const c of conditionsOf(out.when)) if (!knownCondition(c)) out.errors.push(`${key}: unknown condition "${c}"`);
  if (out.action && !ACTIONS.includes(out.action)) out.errors.push(`${key}: action must be ${ACTIONS.join(' or ')}`);
  // A suggestion with its own action needs no agent, so it has no mission to fill. `ask` needs the text to give Claude.
  if (out.action === 'ask' && !out.ask) out.errors.push(`${key}: action ask needs the section "## Ask Claude"`);
  if (out.action === 'setting' && !out.setting) out.errors.push(`${key}: action setting needs "setting: <key>"`);
  for (const c of conditionsOf(out.importantWhen)) if (!knownCondition(c)) out.errors.push(`${key}: unknown condition "${c}" in important_when`);
  for (const c of conditionsOf(out.mediumWhen)) if (!knownCondition(c)) out.errors.push(`${key}: unknown condition "${c}" in medium_when`);
  for (const c of conditionsOf(out.liftWhen)) if (!knownCondition(c)) out.errors.push(`${key}: unknown condition "${c}" in lift_when`);
  if (!out.action && (!out.investigate || !out.plan)) out.errors.push(`${key}: needs the sections "## Investigate" and "## Plan and build"`);
  return out;
}

// ---- Recipes: failure class x stack (recipes.json), 0i section 3.7 ----
//
// A recipe says what would guard a failure class that keeps coming back (the finding log), in one stack. They live in
// the same catalog folder as the cards, as recipes.json, and a project changes them the same way in docs/queue/checks/
// (same id replaces, `off: true` removes, a new id comes before the plugin's). `when` is a card condition, so a stack and
// what the project has are said once, in one language (holds). `cards` names cards that already do the work, never a
// copy. `examples` are facts the recipe must hold for (hit) and must not (miss): recipeExampleProblems, a test.
// `db: true` marks a database probe recipe (0i section 3.8): its `when` must say db-probes-on (learning.dbProbes, off by
// default) and has-local-database or local-db:<engine>, so it is shown only when the owner turned the recipes on and a
// local or throwaway database is found, and "Build as gate" adds the shared database guard to the mission
// (lib/findingRepeats.js buildTask). A db recipe without those conditions is an error and left out, also a project's.
//   { id, class, when, title, text, cards: [card keys], db?: boolean, examples: { hit: [facts], miss: [facts] } }

const RECIPE_ID = /^[a-z0-9][a-z0-9-]{0,59}$/;
const CLASS_ID = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const RECIPE_TEXT_MAX = 400;
const RECIPE_CARDS_MAX = 3;
const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** The examples that do not behave, in words (empty: they all do). */
function recipeExampleProblems(r) {
  const out = [];
  for (const [i, f] of (r?.examples?.hit ?? []).entries()) if (!holds(r.when, isPlain(f) ? f : {})) out.push(`${r.id}: hit example ${i + 1} does not hold for "${r.when}"`);
  for (const [i, f] of (r?.examples?.miss ?? []).entries()) if (holds(r.when, isPlain(f) ? f : {})) out.push(`${r.id}: miss example ${i + 1} holds for "${r.when}"`);
  return out;
}

/** One recipe as an object with its errors in words. `{ id, off: true }` is a removal. */
function parseRecipe(raw, label) {
  const id = typeof raw?.id === 'string' ? raw.id : '(no id)';
  const at = `${label}/recipes.json: ${String(id).slice(0, 60)}`;
  if (!isPlain(raw)) return { id, off: false, errors: [`${label}/recipes.json: every recipe must be an object`] };
  if (raw.off === true) return { id, off: true, errors: RECIPE_ID.test(id) ? [] : [`${at}: "id" must be lower case letters, digits and -`] };
  const r = {
    id,
    off: false,
    class: typeof raw.class === 'string' ? raw.class : '',
    when: typeof raw.when === 'string' ? raw.when : '',
    title: typeof raw.title === 'string' ? raw.title.trim() : '',
    text: typeof raw.text === 'string' ? raw.text.replace(/\s+/g, ' ').trim() : '',
    cards: Array.isArray(raw.cards) ? raw.cards.filter((k) => typeof k === 'string' && k) : [],
    db: raw.db === true,
    examples: { hit: Array.isArray(raw.examples?.hit) ? raw.examples.hit : [], miss: Array.isArray(raw.examples?.miss) ? raw.examples.miss : [] },
    errors: [],
  };
  const err = (m) => r.errors.push(`${at}: ${m}`);
  if (!RECIPE_ID.test(id)) err('"id" must be lower case letters, digits and -');
  if (!CLASS_ID.test(r.class)) err('"class" must be a failure class id (failure-classes.json)');
  else if (r.class === 'other') err('the class other never gets a recipe');
  for (const c of conditionsOf(r.when)) if (!knownCondition(c)) err(`unknown condition "${c}" in when`);
  if (!r.title) err('"title" is missing');
  if (!r.text) err('"text" is missing');
  else if (r.text.length > RECIPE_TEXT_MAX) err(`"text" is over ${RECIPE_TEXT_MAX} characters`);
  if (r.cards.length > RECIPE_CARDS_MAX) err(`at most ${RECIPE_CARDS_MAX} cards`);
  if (raw.db !== undefined && typeof raw.db !== 'boolean') err('"db" must be true or false');
  if (r.db) {
    const cs = conditionsOf(r.when);
    if (!cs.includes('db-probes-on') || !cs.some((c) => c === 'has-local-database' || c.startsWith('local-db:')))
      err('a database recipe (db: true) needs db-probes-on and has-local-database or local-db:<engine> in when, so it is off by default and only for a local database');
  }
  if (!r.examples.hit.length) err('needs at least one hit example (facts it holds for)');
  if (conditionsOf(r.when).length && !r.examples.miss.length) err('needs at least one miss example (facts it does not hold for)');
  if (!r.errors.length) for (const p of recipeExampleProblems(r)) r.errors.push(`${label}/recipes.json: ${p}`);
  return r;
}

/** recipes.json in a folder as { recipes, errors }. A folder without one has none. */
function readRecipes(folder, label) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(path.join(folder, 'recipes.json'), 'utf8'));
  } catch (e) {
    return { recipes: [], errors: e?.code === 'ENOENT' ? [] : [`${label}/recipes.json: ${e.message}`] };
  }
  const list = Array.isArray(data) ? data : Array.isArray(data?.recipes) ? data.recipes : null;
  if (!list) return { recipes: [], errors: [`${label}/recipes.json: expected { "recipes": [ ... ] }`] };
  return { recipes: list.map((x) => parseRecipe(x, label)), errors: [] };
}

/**
 * The project's recipes over the plugin's: off removes, the same id replaces in place, a new one comes first (the
 * project's own choice wins for its class). A card a recipe names must be a card of the catalog: an unknown key is an
 * error and leaves the recipe out; a card the project turned off only drops the link.
 */
function mergeRecipes(builtin = [], own = [], { allKeys, liveKeys }) {
  const byId = new Map(builtin.map((r) => [r.id, r]));
  const fresh = [];
  for (const r of own) {
    if (byId.has(r.id)) byId.set(r.id, r);
    else fresh.push(r);
  }
  const errors = [];
  const recipes = [];
  for (const r of [...fresh, ...byId.values()]) {
    // A removal or a recipe with a mistake: only its errors (a broken entry may have no cards at all).
    if (r.off || r.errors.length) {
      errors.push(...r.errors);
      continue;
    }
    const unknown = r.cards.filter((k) => !allKeys.has(k));
    if (unknown.length) {
      errors.push(...unknown.map((k) => `recipes.json: ${r.id}: names the card "${k}", which is no card`));
      continue;
    }
    const { errors: _none, off: _off, ...clean } = r;
    recipes.push({ ...clean, cards: r.cards.filter((k) => liveKeys.has(k)) });
  }
  return { recipes, errors };
}

/** The recipes damped by their precision (facts.recipeDamped, lib/recipePrecision.js), as a set of ids. */
const dampedIds = (facts) => new Set(Array.isArray(facts?.recipeDamped) ? facts.recipeDamped : []);

/**
 * The damped recipes for a class whose `when` holds (lib/recipePrecision.js): listed on the card by id and title, never
 * offered. Empty when none is damped.
 */
function dampedFor(cls, facts, recipes = []) {
  const damped = dampedIds(facts);
  if (!damped.size || cls === 'other') return [];
  return (Array.isArray(recipes) ? recipes : []).filter((r) => r.class === cls && damped.has(r.id) && holds(r.when, facts ?? {})).map((r) => ({ id: r.id, title: r.title }));
}

/**
 * The recipe for a class in this project: the first whose `when` holds for the facts and that is not damped
 * (facts.recipeDamped: seldom accepted, or damped by the owner), or null. Never one for other.
 */
function recipeFor(cls, facts, recipes = []) {
  if (!cls || cls === 'other') return null;
  const damped = dampedIds(facts);
  return (Array.isArray(recipes) ? recipes : []).find((r) => r.class === cls && !damped.has(r.id) && holds(r.when, facts ?? {})) ?? null;
}

/** The project's categories and templates over the plugin's. */
function mergeCatalog(builtin, own) {
  const categories = new Map(builtin.categories.map((c) => [c.key, c]));
  for (const c of own.categories) categories.set(c.key, { ...categories.get(c.key), ...c });
  const templates = new Map(builtin.templates.map((x) => [x.key, x]));
  for (const x of own.templates) templates.set(x.key, x);
  const shown = [...categories.values()].filter((c) => !c.off);
  const shownKeys = new Set(shown.map((c) => c.key));
  const valid = [...templates.values()].filter((x) => !x.off);
  // A category switched off takes its suggestions with it. A category nobody listed is not lost: it shows under its key.
  const live = valid.filter((x) => !x.errors.length && (shownKeys.has(x.category) || !categories.has(x.category)));
  const recipes = mergeRecipes(builtin.recipes ?? [], own.recipes ?? [], { allKeys: new Set(templates.keys()), liveKeys: new Set(live.map((x) => x.key)) });
  return {
    categories: shown,
    templates: live,
    recipes: recipes.recipes,
    errors: [...builtin.errors, ...own.errors, ...valid.flatMap((x) => x.errors), ...recipes.errors],
  };
}

/** One folder as { categories, templates, errors }. A folder that is not there is simply empty. */
function readFolder(folder, label) {
  const errors = [];
  let categories = [];
  try {
    const list = JSON.parse(fs.readFileSync(path.join(folder, 'categories.json'), 'utf8'));
    if (!Array.isArray(list)) throw new Error('not a list');
    categories = list.filter((c) => {
      const ok = c && typeof c.key === 'string' && (c.off === true || typeof c.title === 'string');
      if (!ok) errors.push(`${label}/categories.json: every category needs "key" and "title"`);
      return ok;
    });
  } catch (e) {
    if (e?.code !== 'ENOENT') errors.push(`${label}/categories.json: ${e.message}`);
  }
  let names = [];
  try {
    names = fs.readdirSync(path.join(folder, 'suggestions')).filter((f) => f.endsWith('.md')).sort();
  } catch {
    /* no templates in this folder */
  }
  const templates = names.map((f) => parseTemplate(fs.readFileSync(path.join(folder, 'suggestions', f), 'utf8'), f.slice(0, -3)));
  const recipes = readRecipes(folder, label);
  return { categories, templates, recipes: recipes.recipes, errors: [...errors, ...recipes.errors] };
}

const loadCatalog = ({ builtin, own }) => mergeCatalog(readFolder(builtin, 'plugin catalog'), readFolder(own, 'docs/queue/checks'));

const planIdBase = (key) => `KS-PLAN-${key.toUpperCase()}`;

/** The investigation tasks of a suggestion, newest last (a declined one can be asked for again: -2, -3). */
function planTasks(key, tasks) {
  const re = new RegExp(`^${planIdBase(key)}(?:-(\\d+))?$`);
  return (tasks ?? []).filter((x) => re.test(x.id));
}

/** Where a suggestion stands: open, queued (a task is on its way), planned (an investigation is delivered), dismissed. */
function suggestionState(t, tasks, dismissed) {
  if (dismissed.includes(t.key)) return { state: 'dismissed', taskId: null };
  const related = [...planTasks(t.key, tasks), ...(tasks ?? []).filter((x) => x.id === t.alsoTask)].filter((x) => x.status !== 'cancelled');
  const task = related[related.length - 1];
  if (!task) return { state: 'open', taskId: null };
  return { state: task.status === 'done' ? 'planned' : 'queued', taskId: task.id };
}

/** The card that shows the due classes with their recipes, and how many classes it shows (the rest are counted). */
const LEDGER_CARD = 'ledger-recipes';
const LEDGER_MAX = 3;
const PLACES_MAX = 5;
/** The failure classes the database probe recipes are for (0i section 3.8), and the card's line while they are off. */
const DB_CLASSES = new Set(['access-control', 'migration-schema']);
const DB_HINT =
  'A local database is found, and the database probe recipes are off: ravenseat settings set learning.dbProbes on shows one (probes only against a local database, rolled back).';

/**
 * The due classes for the card ledger-recipes: per open entry the class, the count, the places (paths only, never an
 * excerpt or code, 0i section 3.11), the stack, what became of it as a proposal, and the recipe with the cards it points
 * to (their state on the tab when they show, else applies false). Fields are picked one by one, so nothing else on an
 * entry reaches the card. What a "Build as gate" button needs later is here: the class, the area and the recipe id.
 */
function ledgerItems(facts, catalog, suggestions) {
  const open = openDue(facts.ledger);
  const stacks = (Array.isArray(facts.stacks) ? facts.stacks : []).filter((s) => typeof s === 'string');
  const shown = new Map(suggestions.map((s) => [s.key, s]));
  const titles = new Map((catalog.templates ?? []).map((x) => [x.key, x.title]));
  const items = open.slice(0, LEDGER_MAX).map((e) => {
    const r = recipeFor(e.class, facts, catalog.recipes);
    return {
      key: typeof e.key === 'string' ? e.key : `${e.class}@${e.area}`,
      class: e.class,
      title: e.title ?? e.class,
      area: e.area,
      scope: e.scope,
      incidents: e.incidents,
      severity: e.severity ?? null,
      tasks: (Array.isArray(e.tasks) ? e.tasks : []).slice(0, 5),
      files: (Array.isArray(e.files) ? e.files : []).filter((f) => typeof f === 'string' && f).slice(0, PLACES_MAX),
      stacks,
      proposal: e.proposal ? { state: e.proposal.state, task: e.proposal.task ?? null } : null,
      // A database class with a local database and the recipes off: one line on how to turn them on (no recipe).
      hint: !r && DB_CLASSES.has(e.class) && isPlainObject(facts.localDatabase) && facts.dbProbesOn !== true ? DB_HINT : null,
      // Recipes for the class that are damped by their precision: named, never offered (lib/recipePrecision.js).
      damped: dampedFor(e.class, facts, catalog.recipes),
      recipe: r
        ? {
            id: r.id,
            title: r.title,
            text: r.text,
            db: r.db === true,
            cards: r.cards.map((k) => {
              const s = shown.get(k);
              return s && s.applies ? { key: k, title: s.title, applies: true, state: s.state } : { key: k, title: titles.get(k) ?? k, applies: false, state: null };
            }),
          }
        : null,
    };
  });
  return { items, more: Math.max(0, open.length - items.length), capFull: facts.ledger?.cap?.full === true };
}

/** The card's line from its items: per class where, how often, the places, the stack and the recipe. */
function ledgerRecipeLine({ items, more, capFull }) {
  if (!items.length) return null;
  const parts = items.map((i) => {
    const where = i.scope === 'project' ? 'across the project' : `in ${i.area}`;
    const at = i.files.length ? ` at ${i.files.join(', ')}` : '';
    const proposed = i.proposal?.state === 'extend' && i.proposal.task ? ` (proposed as ${i.proposal.task})` : '';
    const stack = ` Stack: ${i.stacks.length ? i.stacks.join(', ') : 'not known'}.`;
    const cards = i.recipe?.cards.length ? ` See the card${i.recipe.cards.length > 1 ? 's' : ''} ${i.recipe.cards.map((c) => `"${c.title}"`).join(' and ')}.` : '';
    const recipe = i.recipe ? ` Recipe: ${i.recipe.title}. ${i.recipe.text}${cards}` : i.hint ? ` ${i.hint}` : i.damped?.length ? '' : ' No recipe yet for this class in this stack.';
    return `${capital(i.title)} ${where}: ${i.incidents} incident(s)${at}${proposed}.${stack}${recipe}${dampedNote(i.damped)}`;
  });
  if (more) parts.push(`And ${more} more.`);
  if (capFull) parts.push('The cap of three open proposals is full, so a new gate proposal waits for a free slot.');
  return parts.join(' ');
}
const capital = (s) => (s ? `${String(s)[0].toUpperCase()}${String(s).slice(1)}` : s);

/** The card's note for damped recipes: their ids, and how to show one again. Empty without any. */
function dampedNote(damped) {
  if (!Array.isArray(damped) || !damped.length) return '';
  const ids = damped.map((d) => d.id).join(', ');
  return ` Damped recipe, listed under Recipe precision and not offered here: ${ids} (ravenseat checks recipe <id> show offers it again).`;
}

/**
 * The whole picture. It is a plain snapshot: the same object is the file, the --json answer and what the board draws.
 * @param {{ facts: object, catalog: object, tasks: object[], dismissed: string[], knownBugs?: object, now: string }} input
 */
function buildReport({ facts, catalog, tasks = [], dismissed = [], knownBugs = null, now }) {
  const rank = (x) => PRIORITIES.indexOf(x.priority);
  const order = new Map(catalog.categories.map((c, i) => [c.key, i]));
  const suggestions = catalog.templates
    // A card applies while its `when` holds. A card set aside stays in the report also when it no longer applies, so
    // the "Set aside" list can still bring it back (its key would otherwise stay in checksPanel.dismissed for good).
    .map((x) => ({ ...x, applies: holds(x.when, facts) }))
    .filter((x) => x.applies || dismissed.includes(x.key))
    // important_when: an important gap makes the card high while it lasts (an empty one never does). Only for a card
    // that applies: one that does not apply now keeps its own priority and is never counted (it is set aside anyway).
    .map((x) => (x.applies && x.importantWhen && holds(x.importantWhen, facts) ? { ...x, priority: 'high' } : x))
    // medium_when: something observed raises a low card to medium (never to high, so no red marker).
    .map((x) => (x.applies && x.priority === 'low' && x.mediumWhen && holds(x.mediumWhen, facts) ? { ...x, priority: 'medium' } : x))
    // lift_when: first within its own priority while it holds (never a higher priority, so never the red marker).
    .map((x) => (x.applies && x.liftWhen && holds(x.liftWhen, facts) ? { ...x, lifted: true } : x))
    .sort((a, b) => rank(a) - rank(b) || Number(!!b.lifted) - Number(!!a.lifted) || (order.get(a.category) ?? 99) - (order.get(b.category) ?? 99) || a.key.localeCompare(b.key))
    .map((x) => ({
      key: x.key,
      title: x.title,
      category: x.category,
      priority: x.priority,
      why: x.why,
      contentMin: x.contentMin,
      action: x.action,
      setting: x.setting ?? null,
      ask: x.ask,
      investigate: x.investigate,
      plan: x.plan,
      detail: x.applies ? joinDetail(detailOf(x.key, facts) ?? countDetail(x.key, facts), x.lifted ? liftLine(x, facts) : null) : null,
      ...(x.lifted ? { lifted: true } : {}),
      // A low idea with no signal in the project: folded under "More ideas" on the Checks tab (CONTEXT above).
      ...(x.applies && quietCard(x) ? { quiet: true } : {}),
      // false only for a card set aside whose `when` no longer holds (state is then always dismissed).
      applies: x.applies,
      ...suggestionState(x, tasks, dismissed),
    }));
  // The due classes with their recipes, on the one card that shows them (read after the other cards' states are known).
  const ledgerCard = suggestions.find((s) => s.key === LEDGER_CARD && s.applies);
  if (ledgerCard) {
    ledgerCard.ledger = ledgerItems(facts, catalog, suggestions);
    ledgerCard.detail = ledgerRecipeLine(ledgerCard.ledger);
  }
  // The guards whose command is not in gates.quick, on the one card that offers to add them (the command from the
  // registry, through facts.quickGate; the board posts only the guard id).
  const quickCard = suggestions.find((s) => s.key === QUICK_GATE_CARD && s.applies);
  if (quickCard) quickCard.quickGate = facts.quickGate.items;
  return {
    version: REPORT_VERSION,
    scannedAt: now,
    stacks: facts.stacks ?? [],
    git: !!facts.git,
    hasCommit: facts.hasCommit !== false,
    // hasDatabase and localDatabase: what "Build as gate" needs for the shared database guard (cli/checks.mjs buildGate).
    found: { ci: facts.ci ?? [], kinds: facts.kinds ?? [], hasDatabase: facts.hasDatabase === true, localDatabase: isPlainObject(facts.localDatabase) ? facts.localDatabase : null },
    categories: catalog.categories.map(({ key, title, text }) => ({ key, title, text: text ?? '' })),
    packs: facts.packs ?? null,
    suggestions,
    // Open suggestions with high priority: the red marker on the Checks tab (checksPanel.marker). A card that does not
    // apply is always set aside, so it never counts here.
    important: suggestions.filter((x) => x.applies && x.state === 'open' && x.priority === 'high').length,
    knownBugs,
    // Accepted and declined per recipe and per class, and which recipes are damped (lib/recipePrecision.js facts).
    recipePrecision: isPlainObject(facts.recipePrecision) ? facts.recipePrecision : null,
    catalogErrors: catalog.errors,
  };
}

/** One line per kind, so the agent starts from what was found. */
function foundLines(found) {
  const lines = found.kinds.map((k) => `- ${k.title}: ${[...new Set(k.places.map((p) => (p.where === 'ci' ? `CI (${p.file})` : p.where)))].join(', ')}`);
  return lines.length ? lines.join('\n') : '- No checks found.';
}

/** The investigation task a suggestion becomes: the template's sections, what was found, and what the task must deliver. */
function planTask(s, found, tasks) {
  const n = planTasks(s.key, tasks).length;
  return {
    id: `${planIdBase(s.key)}${n ? `-${n + 1}` : ''}`,
    title: `Investigate and plan: ${s.title}`,
    class: 'U',
    domain: 'ci',
    feature: 'Checks and CI',
    value: { high: 8, medium: 6, low: 4 }[s.priority],
    content_min: s.contentMin,
    labels: ['checks-plan'],
    added_by: 'checks agent',
    own_track: 'an investigation the owner chose on the Checks tab',
    mission: [
      `Investigate and plan: ${s.title}. Do not build it in this task.`,
      `Why it was suggested: ${s.why}`,
    ...(s.detail ? [s.detail] : []),
      `What ravenseat read from the project's files (nothing was run):\n${foundLines(found)}`,
      `## Investigate\n${s.investigate}`,
      `## Plan and build\n${s.plan}`,
      '## Deliver\nWrite track-result.md in plain words for someone who may never have used CI: what you found, your recommendation (saying it is not worth doing is a fine result), what it costs in agent time and CI minutes, and the risks. ' +
        'End track-result.md with the plan: each build step you recommend, as title, why, files and size. The owner decides which become tasks. Do not change the project\'s code, its config or queue.config.json. Never push, deploy or change settings on the git host.',
    ].join('\n\n'),
    acceptance: ['track-result.md has a recommendation and what it costs', 'No project files are changed, and each recommended build step is listed for the owner'],
  };
}

module.exports = { PRIORITIES, ACTIONS, CONDITIONS, holds, parseTemplate, mergeCatalog, loadCatalog, buildReport, planTask, planTasks, recipeFor, dampedFor, recipeExampleProblems };
