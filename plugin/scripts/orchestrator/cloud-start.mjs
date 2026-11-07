#!/usr/bin/env node
// Starts queue tasks in a cloud session with `claude --cloud`. The session counts against your plan's usage limits, like the
// rest of your use. `claude --cloud "task"` needs a real terminal, so the owner runs this in a terminal themselves:
//
//   node scripts/orchestrator/cloud-start.mjs <id> [<id> …] [--force] [--allow-upload]
//
// The script makes the cloud package with `queue.mjs cloud-package`, marks the tasks as started in the cloud (`queue.mjs cloud start`,
// which obeys cloud.maxSessions and the usage limit pause; --force overrides) and then opens `claude --cloud <package>`. When the session
// has finished, `queue.mjs cloud check` sees the marker on its branch and the orchestrator goes on as for a local track (`cloud done`,
// `receive`, `merge`). Requires baseBranch (config().baseBranch) to be pushed to the remote (config().remote), because the session starts
// from it. To start without a terminal: `queue.mjs cloud send` (off until cloud.start is routine). See docs/guide.md.
//
// A remote that is not on GitHub is refused, since claude --cloud would then upload a copy of the local repo (--allow-upload overrides).
// QUEUE_CLOUD_FAKE_CLAUDE replaces claude and the terminal requirement (tests). Tested in lib/__tests__/queueCloudTracks.test.ts.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { config, featureOn, featureOffText } = require('./lib/queueConfig.js');
const { claudeCommand, isGitHubRemote } = require('./lib/cloudSetup.js');
const CLI = require('./lib/projectRoot.js').cliCommand();
const K = config();
// The cloud module is off (features.cloud in queue.config.json): say so, exit 0.
if (!featureOn('cloud', K)) {
  console.log(featureOffText('cloud'));
  console.log(`What it needs: ${CLI} cloud setup. To turn it on: ${CLI} cloud on.`);
  process.exit(0);
}
const ROOT = process.env.QUEUE_GIT ?? K.root;
const QUEUE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'queue.mjs');
const args = process.argv.slice(2);
const force = args.includes('--force');
const ids = args.filter((a) => !a.startsWith('--'));
if (!ids.length) {
  console.error(`Use: ${CLI} cloud-start <id> [<id> …] [--force] [--allow-upload]`);
  process.exit(1);
}
/** Windows limits a command line to about 32,000 characters, and the package is one argument. */
const WINDOWS_ARGUMENT_MAX = 30_000;
const claude = claudeCommand();
if (!process.stdout.isTTY && !process.env.QUEUE_CLOUD_FAKE_CLAUDE) {
  console.error(`claude --cloud requires a real terminal. Run the command yourself in a terminal window, or see ${CLI} cloud setup for the way without one.`);
  process.exit(1);
}

const gitText = (a) => {
  const r = spawnSync('git', a, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
};
// Without a GitHub remote claude --cloud uploads a copy of the local repo instead of cloning (on Windows with uncommitted changes in
// tracked files as they are), which is not what anyone expects from "start a track".
if (!isGitHubRemote(gitText(['remote', 'get-url', K.remote])) && !args.includes('--allow-upload')) {
  console.error(
    `${K.remote} is not on github.com, so claude --cloud would upload a copy of the local repo, uncommitted changes included. ` +
      `Use a GitHub remote (${CLI} cloud setup), or --allow-upload if that copy is fine.`,
  );
  process.exit(1);
}

// The cloud session starts from <remote>/<baseBranch>: if baseBranch has unpushed commits, the cloud does not see them.
{
  const r = spawnSync('git', ['rev-list', '--count', `${K.remote}/${K.baseBranch}..${K.baseBranch}`], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  const unpushed = Number((r.stdout || '').trim());
  if (r.status !== 0) {
    console.error(`Could not find ${K.remote}/${K.baseBranch}. The base branch must be pushed before a cloud session can start.`);
    process.exit(1);
  }
  if (unpushed > 0 && !force) {
    console.error(
      `${K.baseBranch} has ${unpushed} commit(s) not pushed to ${K.remote}. The cloud session would start without them. ` +
        'Push baseBranch first (when the owner says "push"), or use --force.',
    );
    process.exit(1);
  }
}

const file = path.join(os.tmpdir(), `cloud-package-${process.pid}-${Date.now()}.md`);
const queue = (...a) =>
  execFileSync(process.execPath, [QUEUE, ...a], {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
const flags = force ? ['--force'] : [];
try {
  process.stdout.write(queue('cloud-package', ...ids, '--out', file, ...flags));
} catch {
  console.error('Could not make the cloud package (see above). Add --force if you want to send it anyway.');
  process.exit(1);
}
const pkg = fs.readFileSync(file, 'utf8');
fs.rmSync(file, { force: true });
if (process.platform === 'win32' && pkg.length > WINDOWS_ARGUMENT_MAX) {
  console.error(
    `The package is ${pkg.length} characters, too long for a Windows command line (about ${WINDOWS_ARGUMENT_MAX}). Start fewer tasks at once, ` +
      `shorten the mission, or use ${CLI} cloud send.`,
  );
  process.exit(1);
}
// Marked before claude opens. The session limit and the usage limit pause are enforced here: nothing has been started yet.
try {
  process.stdout.write(queue('cloud', 'start', ...ids, ...flags));
} catch (e) {
  process.exit(e.status ?? 1);
}
console.log(`\nStarting a cloud session for ${ids.join(', ')}. It counts against your plan's usage limits.`);
console.log(`If the repo does not have the Claude GitHub App, the CLI uploads a copy of it: ${CLI} cloud setup.\n`);
const r = spawnSync(claude.command, [...claude.before, '--cloud', pkg], { cwd: ROOT, stdio: 'inherit' });
if (r.error) {
  // claude never ran, so no session exists: the tasks go back.
  console.error(`Could not start claude (${r.error.code ?? r.error.message}). Is Claude Code installed and on PATH? No session started.`);
  for (const id of ids) {
    try {
      queue('cloud', 'cancel', id);
    } catch {
      console.error(`Could not put ${id} back: ${CLI} cloud cancel ${id}`);
    }
  }
  process.exit(1);
}
process.exit(r.status ?? 0);
