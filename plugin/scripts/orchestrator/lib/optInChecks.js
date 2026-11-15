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
    title: 'keys in the commands Claude Code has approved',
    tip: 'look for keys in the commands Claude Code has approved ("Yes, and don\'t ask again" stores the whole command)',
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
]);

/** The value at a dotted key, or undefined. */
function valueAt(config, key) {
  return key.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), config);
}

const isOn = (config, key) => valueAt(config ?? {}, key) === true;
const byKey = (key) => OPT_IN.find((c) => c.key === key) ?? null;
const bySuggestion = (key) => OPT_IN.find((c) => c.suggestion === key) ?? null;

/** The checks that are off and that setup has not tipped about yet. `asked` is the list of keys already tipped. */
function tipsToGive(config, asked = []) {
  const done = new Set(Array.isArray(asked) ? asked : []);
  return OPT_IN.filter((c) => !isOn(config, c.key) && !done.has(c.key));
}

const tipLine = (c, cli = 'ravenseat') => `TIP: turn on a check that is off? It would ${c.tip}. On: ${cli} settings set ${c.key} on`;

/** Doctor's INFO text while a check is off. `gap`: the check, run quietly, found something (never what). */
function offLine(c, { cli = 'ravenseat', gap = false } = {}) {
  return (
    `off: ${c.title} (${c.key})${gap ? '. It found something to look at' : ''}. ` +
    `On: ${cli} settings set ${c.key} on, or Turn on on the Checks tab`
  );
}

module.exports = { OPT_IN, isOn, byKey, bySuggestion, tipsToGive, tipLine, offLine, valueAt };
