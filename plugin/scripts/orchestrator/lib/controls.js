// =============================================================
// controls.js: what checks this project's code automatically, and what a merged task was actually checked by.
//
// Why: a new user with no gates and no CI gets no signal that nothing checks the agents' code. Three places use this one
// answer: the push guard asks before a push (hook-push-guard.mjs, push.controlsWarning), cq receive and cq merge say what
// ran, and a missing control turns on the light review (the helper reviewer-light, lib/queueHelpers.js).
//
// Verification is a dimension of its own beside the task status (a task is `done` AND verified, audited or unverified):
//   verified    the configured checks passed. It never means the code is right.
//   audited     no check ran, but an agent reviewed the change. Never counted as verified.
//   unverified  nothing ran.
//
// Only ciHosts reads the disk (a few stats, cheap enough for a hook). Tested in lib/__tests__/controls.test.ts.
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

/** The push guard's question, or null when nothing is missing or nothing is pushed. Never blocks: it is an "ask". */
function question({ missing: what, commits }) {
  if (!what?.length || !commits) return null;
  return (
    `this push sends ${commits} commit(s) with ${what.join(' and ')}, so nothing automatic checks this code. ` +
    '/cq:kickstart adds checks one step at a time. "push": { "controlsWarning": false } in queue.config.json turns this question off. ' +
    'Push anyway?'
  );
}

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

/** The line cq merge prints for a verification. */
function verificationLine({ status, checks }) {
  if (status === 'verified') return `Verified: your checks passed (${checks.join(', ')}). The code can still be wrong.`;
  if (status === 'audited') return 'AUDITED, not verified: an agent reviewed this change, but no check ran. /cq:kickstart adds checks one step at a time.';
  return 'MERGED, NOT VERIFIED: no gates, no done command and no agent review ran. /cq:kickstart adds checks one step at a time.';
}

/** The line cq receive prints when neither a gate nor a done command ran on the delivery. */
const noChecksLine = (id) => `${id}: NO CHECKS RAN: gates.quick is empty and the task has no done command. /cq:kickstart adds checks one step at a time.`;

module.exports = { ciHosts, commandsOf, hasGates, missing, question, verification, verificationLine, noChecksLine };
