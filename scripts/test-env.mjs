// =============================================================
// scripts/test-env.mjs: environment the vitest config (vitest.config.mjs) adds for the test run, and only for it.
//
// Why: the suite starts thousands of node and git processes (queue.mjs, gates.mjs, hooks, and the git calls they make);
// on Windows that process cost is most of the run time (plans: test-suite-tid-analyse, TT-6 and TT-11).
//   - NODE_COMPILE_CACHE (node 22.1 and later): every spawned node child reuses the code it compiled before, kept in
//     one folder under the temp folder. Older node ignores the variable, so it is not set there.
//   - git settings, through GIT_CONFIG_COUNT/KEY/VALUE (the environment of this run only, never a config file):
//     gc.auto=0 and maintenance.auto=false (no background housekeeping after the many small commits of the test repos),
//     commit.gpgsign=false (a developer who signs commits does not get a prompt or a failure from a test repo).
//     Not set: GIT_CONFIG_NOSYSTEM (on Windows the system config holds core.fscache=true, which makes git faster, and
//     core.autocrlf; the flows that need a clean config already set it themselves), core.fsmonitor (off unless someone
//     sets it, and the git surface checks read it), core.untrackedCache (measured: no gain).
// A value the developer set wins: an own NODE_COMPILE_CACHE (or NODE_DISABLE_COMPILE_CACHE) is kept, own GIT_CONFIG_*
// entries stay first and a key they already set is not set again. RAVENSEAT_TEST_ENV=off adds nothing.
// A change to this file changes how every test runs: scripts/test-changed.mjs gives FULL for it.
// =============================================================
import os from 'node:os';
import path from 'node:path';

/** The git settings, in order: [key, value]. */
const GIT_SETTINGS = [
  ['gc.auto', '0'],
  ['maintenance.auto', 'false'],
  ['commit.gpgsign', 'false'],
];

/** Is this node version at least major.minor? */
function atLeast(version, major, minor) {
  const [a, b] = String(version).replace(/^v/, '').split('.').map(Number);
  return a > major || (a === major && b >= minor);
}

/**
 * The variables to add to the test run's environment (nothing is changed in `env`).
 * @param {Record<string, string | undefined>} env  the current environment
 * @param {{ nodeVersion?: string, tmpdir?: string }} [o]  for the tests: the node version and the temp folder
 * @returns {Record<string, string>}
 */
export function testEnv(env, { nodeVersion = process.versions.node, tmpdir = os.tmpdir() } = {}) {
  if (String(env.RAVENSEAT_TEST_ENV ?? '').toLowerCase() === 'off') return {};
  const add = {};
  if (atLeast(nodeVersion, 22, 1) && !env.NODE_COMPILE_CACHE && !env.NODE_DISABLE_COMPILE_CACHE) {
    add.NODE_COMPILE_CACHE = path.join(tmpdir, 'ravenseat-node-compile-cache');
  }
  const own = Math.max(0, Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10) || 0);
  const ownKeys = new Set();
  for (let i = 0; i < own; i++) if (env[`GIT_CONFIG_KEY_${i}`]) ownKeys.add(String(env[`GIT_CONFIG_KEY_${i}`]).toLowerCase());
  let n = own;
  for (const [key, value] of GIT_SETTINGS) {
    if (ownKeys.has(key.toLowerCase())) continue;
    add[`GIT_CONFIG_KEY_${n}`] = key;
    add[`GIT_CONFIG_VALUE_${n}`] = value;
    n++;
  }
  if (n > own) add.GIT_CONFIG_COUNT = String(n);
  return add;
}
