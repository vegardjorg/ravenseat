// =============================================================
// controls.js: what checks this project's code automatically, and what a merged task was actually checked by.
//
// Why: a new user with no gates and no CI gets no signal that nothing checks the agents' code. Three places use this one
// answer: the push guard asks before a push (hook-push-guard.mjs, push.controlsWarning), ravenseat receive and ravenseat merge say what
// ran, and a missing control turns on the light review (the helper reviewer-light, lib/queueHelpers.js).
//
// Verification is a dimension of its own beside the task status (a task is `done` AND verified, audited or unverified):
//   verified    the configured checks passed. It never means the code is right.
//   audited     no check ran, but an agent reviewed the change. Never counted as verified.
//   unverified  nothing ran.
//
// The dismissal (`ravenseat controls dismiss`, owner decision 2026-11-18): in owner mode a push only happens on the owner's
// word, so the same question after every "push" is friction with no news in it. The owner can stop it for this project.
// It is state, not a setting: queue.json in the data folder (`controlsDismissed`, ignored by git, like `guidance`), so one
// person's dismissal never silences a colleague and queue.config.json stays the shared rules. It remembers WHAT was
// missing: when something else goes missing later, the question is back. The fact never goes: push-check and doctor
// keep one quiet line that names the undo (`ravenseat controls restore`).
//
// ciHosts and readDismissal read the disk (a few stats and one small file, cheap enough for a hook).
// Tested in lib/__tests__/controls.test.ts and __tests__/queueGuidance.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** The CI config files of the common hosts: [host, path from the root, is a folder of yml files]. */
const CI_FILES = [
  ['GitHub Actions', '.github/workflows', true],
  ['GitLab CI', '.gitlab-ci.yml'],
  ['Bitbucket Pipelines', 'bitbucket-pipelines.yml'],
  ['Azure Pipelines', 'azure-pipelines.yml'],
  ['CircleCI', '.circleci/config.yml'],
  ['Jenkins', 'Jenkinsfile'],
];

/** The hosts with a CI config under `root`. A file there does not prove that it runs on a push, only that CI is set up. */
function ciHosts(root) {
  return CI_FILES.filter(([, p, dir]) => {
    const full = path.join(root, p);
    try {
      return dir ? fs.readdirSync(full).some((f) => /\.ya?ml$/i.test(f)) : fs.statSync(full).isFile();
    } catch {
      return false;
    }
  }).map(([host]) => host);
}

/** The commands in a gate list (gates.quick or gates.full), without blanks. */
const commandsOf = (x) => (Array.isArray(x) ? x.map((c) => String(c ?? '').trim()).filter(Boolean) : []);

/** Is any gate command set up? */
const hasGates = (config) => commandsOf(config?.gates?.quick).length + commandsOf(config?.gates?.full).length > 0;

/** What is missing, in words for the owner: empty when both gates and CI are there. */
function missing(config, root) {
  return [...(ciHosts(root).length ? [] : ['no CI config']), ...(hasGates(config) ? [] : ['no gates'])];
}

/** The command that stops the question for this project, and its undo. `cli` is the CLI as the user runs it (cliCommand). */
const DISMISS = (cli = 'ravenseat') => `${cli} controls dismiss`;
const RESTORE = (cli = 'ravenseat') => `${cli} controls restore`;

/** The push guard's question, or null when nothing is missing or nothing is pushed. Never blocks: it is an "ask". */
function question({ missing: what, commits, cli = 'ravenseat' }) {
  if (!what?.length || !commits) return null;
  return (
    `this push sends ${commits} commit(s) with ${what.join(' and ')}, so nothing automatic checks this code. ` +
    '/ravenseat:kickstart adds checks one step at a time. ' +
    `${DISMISS(cli)} stops this question for this project until something else goes missing (undo: ${RESTORE(cli)}); ` +
    '"push": { "controlsWarning": false } in queue.config.json turns it off for everyone. ' +
    'Push anyway?'
  );
}

/**
 * The dismissal stored in a queue (queue.json `controlsDismissed`), or null. Only a non-empty list of words counts: a
 * hand-edited or broken value is no dismissal, so the question shows (the safe side).
 * @returns {{ missing: string[], at: string|null }|null}
 */
function dismissalOf(queue) {
  const d = queue?.controlsDismissed;
  if (!d || !Array.isArray(d.missing)) return null;
  const words = d.missing.filter((w) => typeof w === 'string' && w);
  return words.length ? { missing: words, at: typeof d.at === 'string' ? d.at : null } : null;
}

/** For the places with no queue at hand (the push hook, push-check, doctor). Unreadable: null, so the question shows. */
function readDismissal(folder) {
  try {
    return dismissalOf(JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8')));
  } catch {
    return null;
  }
}

/** Does the dismissal cover what is missing now? Only when every word was missing at the dismissal too. */
const covers = (dismissal, what) => Boolean(dismissal && what?.length && what.every((w) => dismissal.missing.includes(w)));

/** The quiet line push-check prints for a dismissed question: the fact and the undo, no advice. */
const dismissedLine = (what, cli = 'ravenseat') => `Controls: ${what.join(', ')} (dismissed for this project; undo: ${RESTORE(cli)}).`;

/**
 * The verification of a merge that went through (a red gate or done command never gets here).
 * @param {{ quickGates: boolean, doneCommand: boolean, reviewed: boolean }} ran
 * @returns {{ status: 'verified'|'audited'|'unverified', checks: string[] }}
 */
function verification({ quickGates, doneCommand, reviewed }) {
  const checks = [...(quickGates ? ['quick gates'] : []), ...(doneCommand ? ['done command'] : [])];
  const status = checks.length ? 'verified' : reviewed ? 'audited' : 'unverified';
  return { status, checks: [...checks, ...(reviewed ? ['agent review'] : [])] };
}

/** The line ravenseat merge prints for a verification. Quiet guidance (lib/guidance.js) keeps the fact and drops the advice. */
function verificationLine({ status, checks }, { quiet = false } = {}) {
  if (quiet && status === 'audited') return 'Audited, not verified: an agent reviewed this change, but no check ran.';
  if (quiet && status === 'unverified') return 'Not verified: no gates, done command or agent review ran.';
  if (status === 'verified') return `Verified: your checks passed (${checks.join(', ')}). The code can still be wrong.`;
  if (status === 'audited') return 'AUDITED, not verified: an agent reviewed this change, but no check ran. /ravenseat:kickstart adds checks one step at a time.';
  return 'MERGED, NOT VERIFIED: no gates, no done command and no agent review ran. /ravenseat:kickstart adds checks one step at a time.';
}

/** The line ravenseat receive prints when neither a gate nor a done command ran on the delivery. */
const noChecksLine = (id, { quiet = false } = {}) =>
  quiet ? `${id}: no checks ran.` : `${id}: NO CHECKS RAN: gates.quick is empty and the task has no done command. /ravenseat:kickstart adds checks one step at a time.`;

module.exports = {
  CI_FILES,
  ciHosts,
  commandsOf,
  hasGates,
  missing,
  DISMISS,
  RESTORE,
  question,
  dismissalOf,
  readDismissal,
  covers,
  dismissedLine,
  verification,
  verificationLine,
  noChecksLine,
};
