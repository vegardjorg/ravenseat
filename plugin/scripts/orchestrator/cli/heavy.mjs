// =============================================================
// cli/heavy.mjs: `ravenseat heavy -- <command>`: runs a heavy command (a test suite, vitest, a red team run) in a slot
// of the machine queue (lib/gateQueue.js), so parallel tracks take turns instead of slowing each other into timeouts.
// Roadmap 0s V10; idea A in plans/coral-tester-ressurser-2026-11-17.md.
//
//   ravenseat heavy -- npm test
//   ravenseat heavy -- npx vitest run lib/__tests__/x.test.ts
//   ravenseat heavy -- "npm run test:changed -- main"
//
// What it does: waits for a free slot (one line says who it waits for and its place in line, as a gate run does), holds
// it with a heartbeat (gateQueue.staleMin), runs the command through the shell with its output passed through, frees
// the slot and exits with the command's exit code. Always heavy: unlike a gate run it does not look at the time log,
// the person or agent who wrapped the command already said it is heavy. Its class is base in the main checkout and
// track elsewhere (a receive run is never a heavy wrap), so a track's run never goes before the orchestrator's.
//   - The command gets QUEUE_GATE_QUEUE=off: a `ravenseat gates` inside it must not wait for the slot its parent holds.
//   - It runs under the guard of lib/treeRun.js: when this process dies without warning, the whole tree goes with it, and
//     the slot is taken over by the next run (the process is gone, or the heartbeat stops).
//   - Ctrl-C or a signal ends the command's tree, frees the slot and exits as the signal asks (130 on Windows).
//   - The gate queue off (gateQueue.enabled false, QUEUE_GATE_QUEUE=off), or a queue folder that cannot be used: the
//     command just runs, with one line saying so. Never a stuck command because of the queue.
//   - No time budget of its own: the caller's (the Bash tool's timeout) applies. A command that is denied when run bare
//     is denied wrapped too: the push guard reads the words after `--` as a command of their own.
// The slot names the command (the first words, environment values masked) so doctor and the pulse check can show it.
//
// Exit codes: the command's; 2 for a usage error (no `--` or no command). Used by: queue.mjs (dispatch).
// Tested in: __tests__/heavyFlow.test.ts.
// =============================================================

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

import { a, CONFIG, MAIN_TREE, PREFIX, require, ROOT } from './context.mjs';

const GQ = require('./lib/gateQueue.js');
const TR = require('./lib/treeRun.js');
const { hiddenWindowsEnv } = require('./lib/hideWindows.cjs');

const USE = 'Use: ravenseat heavy -- <command>   (for example: ravenseat heavy -- npm test)';
/** How much of the command the slot records. */
const SHOWN_CHARS = 120;

/** A word as the shell reads it back: quoted when it has a space or a quote of its own. */
function shellWord(w) {
  if (/^[\w@%+=:,./\\-]+$/.test(w)) return w;
  return `"${String(w).replace(/"/g, '\\"')}"`;
}

/** The command for holder.json: environment assignments masked (they can hold a token), cut to SHOWN_CHARS. */
export function shownCommand(command) {
  const masked = String(command)
    .replace(/(^|\s)(\$env:)?([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S+)/g, '$1$2$3=…')
    .replace(/\s+/g, ' ')
    .trim();
  return masked.length > SHOWN_CHARS ? `${masked.slice(0, SHOWN_CHARS)}…` : masked;
}

/** The track of the current branch (queue/<id>), or null. */
function trackHere() {
  const r = spawnSync('git', ['-C', ROOT, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', windowsHide: true });
  const branch = r.status === 0 ? r.stdout.trim() : null;
  try {
    return require('./lib/timeLogRows.js').trackFromBranch(branch, PREFIX);
  } catch {
    return null;
  }
}

/** Runs the command under the tree guard, output passed through. Resolves to its exit code (1 without one). */
function runCommand(command, onChild) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, TR.guardShellArgs(command), {
      cwd: process.cwd(),
      // Its own process group on POSIX (one killTree ends the guard and the command), outside this job on Windows.
      detached: true,
      windowsHide: true,
      env: hiddenWindowsEnv({ ...process.env, QUEUE_GATE_QUEUE: 'off' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    onChild(child);
    child.stdout.on('data', (d) => process.stdout.write(d));
    child.stderr.on('data', (d) => process.stderr.write(d));
    child.on('error', (e) => {
      process.stderr.write(`ravenseat heavy: ${e.message}\n`);
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

/** `ravenseat heavy -- <command>` (the usage is at the top of queue.mjs and of this file). */
export async function cmdHeavy() {
  const args = a.slice(1);
  const at = args.indexOf('--');
  const words = at >= 0 ? args.slice(at + 1) : [];
  if (at < 0 || !words.length || !words.join('').trim()) {
    console.error(`ravenseat heavy: no command. ${USE}`);
    process.exit(2);
  }
  // One word: a whole command line in quotes, run as it is. Several: joined back as the shell would read them.
  const command = words.length === 1 ? words[0] : words.map(shellWord).join(' ');

  const setup = GQ.setupFrom(CONFIG);
  let slot = null;
  let beat = null;
  let child = null;
  const release = () => {
    beat?.stop();
    beat = null;
    if (slot) GQ.release(slot);
    slot = null;
  };
  process.on('exit', release);
  const onSignal = (sig) => {
    if (child) TR.killTree(child.pid);
    release();
    if (process.platform === 'win32') process.exit(130);
    process.removeAllListeners(sig);
    process.kill(process.pid, sig);
  };
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    try {
      process.on(sig, () => onSignal(sig));
    } catch {
      /* a signal this platform does not have */
    }
  }

  if (setup.enabled) {
    const mainTree = path.resolve(ROOT) === path.resolve(MAIN_TREE);
    const got = await GQ.acquireWait({
      root: setup.root,
      slots: setup.slots,
      who: {
        project: CONFIG.projectName ?? path.basename(CONFIG.root ?? ROOT),
        kind: 'heavy',
        track: trackHere(),
        command: shownCommand(command),
        ...GQ.beatFields(setup),
      },
      order: { cls: GQ.priorityClass({ mainTree, evidence: false }), agingMs: setup.agingMin * 60_000 },
      onWait: (holders, info) => console.error(GQ.waitLine(holders, { slots: setup.slots, ...info }).replace(/ The time budget starts when this check starts\.$/, '')),
    });
    slot = got.slot;
    if (got.failedOpen) console.error(`GATE QUEUE: ${setup.root} cannot be used, so this command runs without the queue.`);
    else if (got.waitSec >= 1) console.error(`GATE QUEUE: waited ${Math.round(got.waitSec)} s for a slot.`);
    if (slot && setup.staleMin > 0) beat = GQ.startBeat(slot);
  } else console.error('GATE QUEUE: off (gateQueue.enabled false or QUEUE_GATE_QUEUE=off), so the command runs at once.');

  const code = await runCommand(command, (c) => {
    child = c;
  });
  child = null;
  release();
  process.exit(code);
}
