#!/usr/bin/env node
// =============================================================
// lib/waitRunner.js: the detached runner of the wait mode (lib/waitMode.js). Never started by hand.
//
// Use: node lib/waitRunner.js <done file> <pid file> <hard cap sec> <lock file or -> <run id> -- <node arguments...>
//
// Runs `node <arguments>` with this process's stdout and stderr (the run's .out and .err files, opened by the call that
// started it) and the environment it got (QUEUE_WAIT=off, so the command never uses the wait mode itself). When the
// command exits it writes the done file ({ exit, endedAt }) through a rename, which frees the run's key. Over the hard cap it
// ends the command's whole process tree, prints a RED line as gates.mjs does for a gate over its budget, and writes
// { exit: 1, timedOut: true }. The environment is never written to a file: tokens stay in memory. The command runs under
// a guard (lib/treeRun.js), so a runner killed without warning (no cap, no done file) takes the command's tree along.
// =============================================================
'use strict';

const fs = require('node:fs');
const { renameWithRetry } = require('./stateFile.js');
const { spawn, spawnSync } = require('node:child_process');

const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
const [doneFile, pidFile, hardText, lockFile, id] = argv.slice(0, sep);
const childArgv = argv.slice(sep + 1);
const hardSec = Number(hardText) || 0;

function writeDone(value) {
  const tmp = `${doneFile}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ ...value, endedAt: new Date().toISOString() }));
    renameWithRetry(tmp, doneFile);
  } catch {
    try {
      fs.writeFileSync(doneFile, JSON.stringify({ ...value, endedAt: new Date().toISOString() }));
    } catch {
      // error-ignored: the waiter then reports the run as ended without a result
    }
  }
  // '-': the key is a pointer under a lib/queueLock.js lock (lib/waitMode.js startOrAttach), which the done file frees by
  // itself. A lock file path (a runner started by an older version): remove it when it is still this run's.
  if (lockFile === '-') return;
  try {
    if (fs.readFileSync(lockFile, 'utf8').trim() === id) fs.rmSync(lockFile, { force: true });
  } catch {
    // error-ignored: a lock of an ended run is taken over by the next call
  }
}

try {
  fs.writeFileSync(pidFile, String(process.pid));
} catch {
  // error-ignored: the waiter counts the run as starting for a while, then as lost
}

const isPosix = process.platform !== 'win32';
// Under a guard (lib/treeRun.js): `node <arguments>` in the guard's own process group, and the whole tree ended when this
// runner dies without warning (SIGKILL, taskkill without /T), since the hard cap dies with it. Detached: its own group on
// POSIX (so the group signals below reach the guard and the command), outside this process's job object on Windows.
const child = spawn(process.execPath, require('./treeRun.js').guardExecArgs(childArgv), {
  stdio: ['ignore', 'inherit', 'inherit'],
  env: process.env,
  windowsHide: true,
  detached: true,
});

let timedOut = false;
let finished = false;
/** Ends the command's tree: POSIX SIGTERM to the group (gates.mjs then ends its own gate command), SIGKILL after 5 s. */
function endTree() {
  if (isPosix) {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      // already gone
    }
    setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }, 5000).unref();
  } else spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
}

const cap = hardSec > 0
  ? setTimeout(() => {
      timedOut = true;
      endTree();
      // A process outside the tree can keep running: the run still ends here.
      setTimeout(() => done(null), 10_000).unref();
    }, hardSec * 1000)
  : null;

function done(code) {
  if (finished) return;
  finished = true;
  if (cap) clearTimeout(cap);
  if (timedOut) {
    try {
      fs.writeSync(1, `\nRED: the run stopped after the time budget of ${hardSec} s (the wait mode's hard cap); its processes were ended.\n`);
    } catch {
      // error-ignored: the done file below still says timed out
    }
    writeDone({ exit: 1, timedOut: true });
  } else writeDone({ exit: Number.isInteger(code) ? code : 1 });
  process.exit(0);
}

child.on('error', (e) => {
  try {
    fs.writeSync(2, `ravenseat: the run could not start: ${e.message}\n`);
  } catch {
    // error-ignored
  }
  done(1);
});
child.on('exit', (code) => done(code));
