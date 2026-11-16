// =============================================================
// lib/optInChecks.js: the checks a project turns on itself, and how each is offered.
//
// Why: the owner decided (2026-11-15) that every NEW check is off by default, each with its own setting, so an existing
// project sees no new WARN or FAIL after an update. Instead of nagging, each check is offered in three quiet ways, all
// from this one list so they never disagree:
//   - setup prints one short "turn on X?" tip per check that is off, once per check (the asked keys are kept in the
//     queue's data folder, setup-tips.json), and the setup skill asks the user, who may decline;
//   - the Checks tab has a card per check (checks-catalog/suggestions/<suggestion>.md, action: setting) whose
//     "Turn on" writes the setting; a card set aside stays set aside;
//   - doctor shows one INFO line while the check is off (never WARN or FAIL), naming the setting.
// A check counts as on only when its setting is exactly true: a missing or odd value is off, the default.
// A no to a setup tip sets the Checks card aside (owner decision 2026-11-15): the tip names `ravenseat checks dismiss
// <suggestion>`, the same "Set aside" as on the Checks tab, so the suggestion does not come back there either.
// An entry may have `on` (the command that turns it on, when `settings set` cannot: share needs its confirmation) and
// `offer(facts)` (tip only when it holds: share is offered as a backup only in a repo known to be private).
//
//   OPT_IN                 the checks, in the order setup and doctor name them
//   isOn(config, key)      is the setting true?
//   byKey(key), bySuggestion(key)
//   tipsToGive(config, asked)   the checks setup still has to tip about
//   tipLine(check)         the line setup prints
//   offLine(check, gap)    doctor's INFO text while the check is off
//
// Used by: setup.mjs, cli/doctorBaseline.mjs, cli/checks.mjs. Tested in: lib/__tests__/optInChecks.test.ts.
// =============================================================
'use strict';

const OPT_IN = Object.freeze([
  Object.freeze({
    key: 'secretScan.allowlist',
    row: 'allowlist',
    suggestion: 'allowlist-scan',
    // One setting for both of Claude Code's own config files: the approved commands (lib/allowlistSecrets.js) and the
    // MCP servers in .mcp.json (lib/mcpSecrets.js). Same risk, same patterns, same FAIL/WARN rule, so one tip.
    title: 'keys in the commands Claude Code has approved and in .mcp.json',
    tip: 'look for keys in the commands Claude Code has approved ("Yes, and don\'t ask again" stores the whole command) and in the MCP servers in .mcp.json',
  }),
  Object.freeze({
    key: 'gitignoreCheck.enabled',
    row: 'gitignore',
    suggestion: 'gitignore-own-rules',
    title: 'the project\'s own .gitignore',
    tip: 'check that the project\'s own .gitignore, not only your global one, keeps your personal settings and the queue\'s data out of git',
  }),
  Object.freeze({
    key: 'secretScan.atReceive',
    row: null,
    suggestion: 'secret-scan-receive',
    title: 'the secret scan at receive',
    tip: 'scan each track\'s commits for keys at receive, so a merge stops on one before it reaches the base branch',
  }),
  // Sharing queue.json and the plan register in git (lib/queueShare.js): a backup, offered only in a private repo
  // (lib/repoVisibility.js, the cached answer). Never important: off is the safe side.
  Object.freeze({
    key: 'share.queueData',
    row: 'share',
    suggestion: 'share-backup',
    title: 'the queue\'s files in git as a backup',
    tip: 'keep queue.json and the plan register in git as a backup (this repo is private; the time log, missions and answers stay out)',
    on: 'share on --yes',
    offer: (facts) => facts?.visibility === 'private',
  }),
  // Broad rules in the tracked .claude/settings.json (lib/broadPermissions.js). Offered only where that file exists.
  Object.freeze({
    key: 'permissionsCheck.enabled',
    row: 'permissions',
    suggestion: 'broad-permissions',
    title: 'broad permissions in the shared .claude/settings.json',
    tip: 'name the broad rules in the shared .claude/settings.json (any shell command, network tools, rm, git push, bypassPermissions)',
    offer: (facts) => facts?.sharedSettings === true,
  }),
  // Probe gates only against a local database (lib/dbGuard.js). Offered only in a project with a database.
  Object.freeze({
    key: 'dbGuard.localOnly',
    row: null,
    suggestion: 'db-shared-guard',
    title: 'the local-only database guard for probe gates',
    tip: 'refuse a database probe gate whose database is not local (localhost, 127.0.0.1, ::1 or a Docker service name)',
    offer: (facts) => facts?.hasDatabase === true,
  }),
  // Guard proposals from the finding log (lib/findingRepeats.js, 0i section 3.9): the counting itself is on and quiet,
  // the proposals ask for the owner's time, so they are opt-in with one tip and one card. No doctor row: being off is
  // the normal state, and an INFO line about it on every doctor run would be the nagging the plan rules out.
  Object.freeze({
    key: 'learning.proposals',
    row: null,
    suggestion: 'learning-proposals',
    title: 'guard proposals from the finding log',
    tip: 'propose a gate task (you approve it) when the same kind of failure keeps coming back in one part of the code, sharing one cap of three proposals with the inspection queue',
  }),
  // The scope drift guards (lib/scopeNotes.js, bolk B7, V6 and V7). Full mode only: a lite task names no files. No doctor
  // row, as for the proposals: off is the normal state. Their cards turn important when the finding log shows scope
  // drift three times in one area within 30 days (important_when: ledger-recent:scope-drift).
  Object.freeze({
    key: 'scopeNotes.driftGap',
    row: null,
    suggestion: 'drift-gap-review',
    title: 'the gap review on large drift',
    tip: 'add the gap reviewer at receive when most of a change lies outside the task\'s files (at least 4 files and over 40 %), at the cost of one reviewer run when it fires',
    offer: (facts) => facts?.lite !== true,
  }),
  Object.freeze({
    key: 'scopeNotes.driftWarn',
    row: null,
    suggestion: 'drift-write-warn',
    title: 'the write warning for drift',
    tip: 'note to a track, while it writes, that a file lies outside its files and reads, once per file and never a denial',
    offer: (facts) => facts?.lite !== true,
  }),
]);

/** The value at a dotted key, or undefined. */
function valueAt(config, key) {
  return key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), config);
}

const isOn = (config, key) => valueAt(config ?? {}, key) === true;
const byKey = (key) => OPT_IN.find((c) => c.key === key) ?? null;
const bySuggestion = (key) => OPT_IN.find((c) => c.suggestion === key) ?? null;

/**
 * The checks that are off and that setup has not tipped about yet. `asked` is the list of keys already tipped; `facts`
 * what the entries' offer() reads ({ visibility }). An entry whose offer does not hold is not tipped, and not recorded.
 */
function tipsToGive(config, asked = [], facts = {}) {
  const done = new Set(Array.isArray(asked) ? asked : []);
  return OPT_IN.filter((c) => !isOn(config, c.key) && !done.has(c.key) && (!c.offer || c.offer(facts)));
}

/** The command that turns a check on. */
const onCommand = (c, cli = 'ravenseat') => `${cli} ${c.on ?? `settings set ${c.key} on`}`;

/** The setup line: what it would do, how to turn it on, and how to say no (which sets the Checks card aside too). */
const tipLine = (c, cli = 'ravenseat') =>
  `TIP: turn on a check that is off? It would ${c.tip}. On: ${onCommand(c, cli)}. No: ${cli} checks dismiss ${c.suggestion}`;

/** Doctor's INFO text while a check is off. `gap`: the check, run quietly, found something (never what). */
function offLine(c, { cli = 'ravenseat', gap = false } = {}) {
  return (
    `off: ${c.title} (${c.key})${gap ? '. It found something to look at' : ''}. ` +
    `On: ${onCommand(c, cli)}, or Turn on on the Checks tab`
  );
}

module.exports = { OPT_IN, isOn, byKey, bySuggestion, tipsToGive, tipLine, offLine, onCommand, valueAt };
