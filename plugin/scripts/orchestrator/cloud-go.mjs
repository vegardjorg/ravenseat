#!/usr/bin/env node
// Starts several cloud sessions in one go, for when you are about to leave the machine: "I'm logging off, take three".
//
//   node scripts/orchestrator/cloud-go.mjs [<sessions>] [--single] [--dry-run] [--force] [--allow-upload]
//
// It takes the cloud-suitable tasks in priority order, grouped the way `ravenseat cloud-bundles` groups them, and starts one session
// for each bundle, one after another. Every session is started by cloud-start.mjs (or `cloud send` when cloud.start is routine), so
// the same checks hold: the base branch pushed, cloud.maxSessions, the usage limit pause, no silent upload.
//
//   <sessions>     how many sessions to start. Default and upper limit: what cloud.maxSessions has free.
//   --single       one task per session, so they run side by side. Default: up to cloud.bundleMax (4) related tasks in one session, one after another.
//   --dry-run      only lists what would start.
//   --offer        for the orchestrator when the owner says they are leaving: like --dry-run, but prints nothing at all when there is
//                  nothing to offer (cloud off, cloud.offerOnLeave false, no task that fits, no free session), so silence means say nothing.
//
// A failed start stops the rest, so a problem is not repeated once per session. `claude --cloud` returns when the session is created,
// and from there it runs without this machine. Nothing here runs on its own: someone has to run it, since it spends the owner's plan.
// Not on the board on purpose. The orchestrator offers it when the owner says they are leaving (skills/parallel-wave).
// Tested in lib/__tests__/queueCloudTracks.test.ts.
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { config, featureOn, featureOffText } = require('./lib/queueConfig.js');
const CLI = require('./lib/projectRoot.js').cliCommand();
const K = config();
const offer = process.argv.includes('--offer');
// The owner's setting decides, whatever else is true. The default is on (queue.config.json cloud.offerOnLeave).
if (offer && (!featureOn('cloud', K) || K.cloud?.offerOnLeave === false)) process.exit(0);
if (!featureOn('cloud', K)) {
  console.log(featureOffText('cloud'));
  console.log(`What it needs: ${CLI} cloud setup. To turn it on: ${CLI} cloud on.`);
  process.exit(0);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const asked = args.find((x) => !x.startsWith('--'));
if (asked !== undefined && !/^[1-9]\d*$/.test(asked)) {
  console.error(`Use: ${CLI} cloud-go [<sessions>] [--single] [--dry-run] [--force] [--allow-upload]`);
  process.exit(1);
}

// The proposal, from the queue's own list: priority order, and only what suits the cloud now.
const listed = spawnSync(
  process.execPath,
  [path.join(HERE, 'queue.mjs'), 'cloud-bundles', '--json', ...(has('--single') ? ['--max', '1'] : [])],
  { cwd: K.root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
);
let plan;
try {
  plan = JSON.parse(listed.stdout);
} catch {
  console.error('Could not read the list of cloud-suitable tasks (see above). Nothing started.');
  process.exit(1);
}

const free = Math.max(0, plan.max - plan.sessions);
if (offer && (!plan.bundles.length || !free)) process.exit(0);
if (!plan.bundles.length) {
  console.log(`No cloud-suitable tasks now. ${CLI} cloud says why a task does not fit. Nothing started.`);
  process.exit(0);
}
if (!free) {
  console.log(`${plan.sessions} cloud session(s) are running, and cloud.maxSessions is ${plan.max}. Nothing started.`);
  process.exit(0);
}
const wanted = asked === undefined ? free : Number(asked);
const chosen = plan.bundles.slice(0, Math.min(wanted, free));
if (wanted > free) console.log(`You asked for ${wanted}, but cloud.maxSessions leaves room for ${free}.`);

// What would stop the first start, said now and not after the owner has walked away.
const pushed = spawnSync('git', ['rev-list', '--count', `${K.remote}/${K.baseBranch}..${K.baseBranch}`], { cwd: process.env.QUEUE_GIT ?? K.root, encoding: 'utf8' });
const unpushed = pushed.status === 0 ? Number(pushed.stdout.trim()) : null;
const baseProblem =
  unpushed === null
    ? `${K.remote}/${K.baseBranch} was not found, and a session starts from it. Push the base branch first.`
    : unpushed > 0
      ? `${K.baseBranch} has ${unpushed} commit(s) not on ${K.remote}, which the sessions would not see. Push first, or use --force.`
      : null;
if (baseProblem) console.log(`Note: ${baseProblem}`);
if (baseProblem && !has('--force') && !has('--dry-run') && !offer) {
  console.log('Nothing started.');
  process.exit(1);
}
console.log(`${has('--dry-run') || offer ? 'Would start' : 'Starting'} ${chosen.length} cloud session(s). They count against your plan's usage limits.`);
chosen.forEach((b, i) => {
  console.log(`  ${i + 1}. about ${b.minutes} min`);
  for (const id of b.ids) console.log(`     ${id}  ${b.titles[id] ?? ''}`);
});
if (has('--dry-run') || offer) process.exit(0);

const routine = K.cloud?.start === 'routine';
const passOn = [...(has('--force') ? ['--force'] : []), ...(has('--allow-upload') && !routine ? ['--allow-upload'] : [])];
// Seen in practice: the first start in a folder stops on a question from claude, and nothing runs until it is answered.
if (!routine) console.log('\nStay until this says the sessions have started. The first time in a folder, claude asks whether you trust it: answer in this terminal.');
let started = 0;
for (const b of chosen) {
  console.log(`\n--- ${b.ids.join(', ')} ---`);
  const r = routine
    ? spawnSync(process.execPath, [path.join(HERE, 'queue.mjs'), 'cloud', 'send', ...b.ids, ...passOn], { cwd: K.root, stdio: 'inherit' })
    : spawnSync(process.execPath, [path.join(HERE, 'cloud-start.mjs'), ...b.ids, ...passOn], { cwd: K.root, stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`\nStopped: the start of ${b.ids.join(', ')} failed. ${started} session(s) had started before it, and the rest were not tried.`);
    process.exit(r.status ?? 1);
  }
  started += 1;
}
console.log(
  `\n${started} session(s) started. They go on without this machine, so you can close it. ` +
    `When you are back: ${CLI} cloud check says what has finished, and ${CLI} cloud collect brings it home.`,
);
