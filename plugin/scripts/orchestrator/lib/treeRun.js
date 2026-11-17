// =============================================================
// treeRun.js: a shell command with a time budget that ends its WHOLE process tree when the budget runs out.
//
// Why: spawnSync's own `timeout` kills only the process it started. With `shell: true` that is the shell (cmd.exe on
// Windows), so the real command the shell started (node, npm, a test runner) lived on with a dead parent until it
// ended by itself, and a hanging one never did: it held its working folder, its memory and its pipes for days. Here a
// small supervisor (this file run as a script) starts the shell itself and, at the budget, ends the shell's tree while
// the shell is still alive, so the tree can still be found: taskkill /T /F on Windows, SIGKILL to the process group on
// POSIX. The same way gates.mjs ends a gate over its budget (runShell, killTree).
//
// runBounded(command, o) stays synchronous for its callers (lib/doneCheck.js runDoneWhen and through it the base gate
// and the red-on-base check): it runs the supervisor with spawnSync and gives back what spawnSync gives, plus
// `timedOut`. The supervisor says "timed out" on its own fd 3, so the command's exit code and output are never read
// for it. spawnSync keeps a fallback limit a little above the budget, for a supervisor that cannot end.
//
// Pure except the runs. Tested in lib/__tests__/doneCheck.test.ts (a hanging command leaves no process behind).
// =============================================================
'use strict';

const { spawn: spawnAsync, spawnSync } = require('node:child_process');
const fs = require('node:fs');

/** How long the supervisor waits for the ended tree to close its pipes before it ends anyway. */
const GRACE_MS = 5000;
/** spawnSync's own limit over the budget: only reached when the supervisor itself cannot end. */
const FALLBACK_MS = 30_000;
/** What the supervisor writes on fd 3 when the budget ran out. */
const TIMED_OUT = 'timed-out';

/** Ends a process and everything it started (taskkill /T on Windows, the process group on POSIX). */
function killTree(pid, platform = process.platform) {
  try {
    if (platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

/**
 * Runs `command` through the shell in `cwd`, at most `timeoutMs` long, and its whole tree is ended at the budget.
 * `spawn` is a spawnSync (lib/gateEnv.js trackCodeSpawn gives one with a scrubbed environment); it is called as
 * spawn(file, args, options). Returns spawnSync's result with `timedOut` (true only when the budget ran out).
 */
function runBounded(command, { cwd, timeoutMs, maxBuffer = 1 << 28, spawn = spawnSync }) {
  const s = spawn(process.execPath, [__filename, String(Math.max(1, Math.round(timeoutMs))), command], {
    cwd,
    encoding: 'utf8',
    maxBuffer,
    timeout: timeoutMs + FALLBACK_MS,
    killSignal: 'SIGKILL',
    windowsHide: true,
    // no stdin (a command that reads it gets end of file); fd 3 carries only the supervisor's own "timed out"
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
  });
  const said = String(s?.output?.[3] ?? '');
  const timedOut = said.includes(TIMED_OUT) || s?.error?.code === 'ETIMEDOUT';
  return { ...s, timedOut, error: timedOut ? undefined : s?.error };
}

/** The supervisor: node treeRun.js <timeoutMs> <command>. Exits with the command's exit code (1 when it has none). */
function supervise(timeoutMs, command) {
  const posix = process.platform !== 'win32';
  const child = spawnAsync(command, {
    shell: true,
    detached: posix, // its own process group, so the whole tree can be ended
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });
  let ended = false;
  const end = (code) => {
    if (ended) return;
    ended = true;
    process.exit(code);
  };
  const timer = setTimeout(() => {
    try {
      fs.writeSync(3, TIMED_OUT);
    } catch {
      // error-ignored: no fd 3 (run by hand); the exit below still ends the run
    }
    killTree(child.pid);
    // A process outside the tree can keep the pipes open: the supervisor still ends.
    setTimeout(() => end(1), GRACE_MS).unref();
  }, timeoutMs);
  // Ended from outside (spawnSync's fallback limit sends SIGKILL, which runs nothing; these do): take the tree along.
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    try {
      process.on(sig, () => {
        killTree(child.pid);
        end(1);
      });
    } catch {
      // a signal this platform does not have
    }
  }
  child.on('error', (e) => {
    try {
      fs.writeSync(2, `${e.message}\n`);
    } catch {
      // error-ignored
    }
    clearTimeout(timer);
    end(1);
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    end(Number.isInteger(code) ? code : 1);
  });
}

if (require.main === module) supervise(Number(process.argv[2]), process.argv[3]);

module.exports = { FALLBACK_MS, GRACE_MS, TIMED_OUT, killTree, runBounded };
