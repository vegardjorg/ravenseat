#!/usr/bin/env node
// =============================================================
// lib/waitRunner.js: the detached runner of the wait mode (lib/waitMode.js). Never started by hand.
//
// Use: node lib/waitRunner.js <done file> <pid file> <hard cap sec> <lock file> <run id> -- <node arguments...>
//
// Runs `node <arguments>` with this process's stdout and stderr (the run's .out and .err files, opened by the call that
// started it) and the environment it got (QUEUE_WAIT=off, so the command never uses the wait mode itself). When the
// command exits it writes the done file ({ exit, endedAt }) through a rename and frees the run's lock. Over the hard cap it
// ends the command's whole process tree, prints a RED line as gates.mjs does for a gate over its budget, and writes
// { exit: 1, timedOut: true }. The environment is never written to a file: tokens stay in memory.
// =============================================================
'use strict';

const fs = require('node:fs');
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
    fs.renameSync(tmp, doneFile);
  } catch {
    try {
      fs.writeFileSync(doneFile, JSON.stringify({ ...value, endedAt: new Date().toISOString() }));
    } catch {
      // error-ignored: the waiter then reports the run as ended without a result
    }
  }
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
const child = spawn(process.execPath, childArgv, {
  stdio: ['ignore', 'inherit', 'inherit'],
  env: process.env,
  windowsHide: true,
  detached: isPosix, // POSIX: its own process group, so the whole tree can be ended at the cap
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
