// =============================================================
// treeRun.js: a shell command with a time budget that ends its WHOLE process tree when the budget runs out, and the
// guard that ends a command's whole tree when the process that started it is gone.
//
// Why (the budget): spawnSync's own `timeout` kills only the process it started. With `shell: true` that is the shell
// (cmd.exe on Windows), so the real command the shell started (node, npm, a test runner) lived on with a dead parent
// until it ended by itself, and a hanging one never did: it held its working folder, its memory and its pipes for days.
// Here a small supervisor (this file run as a script) starts the command itself and, at the budget, ends its tree while
// it is still alive, so the tree can still be found: taskkill /T /F on Windows, SIGKILL to the process group on POSIX.
// The same way gates.mjs ends a gate over its budget (runShell, killTree).
//
// Why (the guard): the budget lives in the process that started the command (a merge, gates.mjs, the wait runner).
// When that process dies without warning (a crash, SIGKILL, taskkill without /T, a closed terminal), nobody ends a
// hanging command any more. On POSIX the command runs in its own process group, so a kill of the parent's group never
// reaches it; on Windows a child outlives a parent that is ended alone, and libuv's job object (kill on close) takes
// only the parent's direct children, never what they started. So every command starts under a guard: this file run as
// `guard`, detached (its own process group on POSIX, outside the parent's job on Windows), with the command in the
// guard's own group. The guard looks every second whether the process it belongs to still lives and ends the whole tree
// once it does not: on POSIX by a changed parent pid (an orphan is taken over by init or a subreaper) or a dead one, on
// Windows (where the parent pid never changes) by a liveness check of the original pid. The caller ends the guard and
// the command together with one killTree on the guard's pid. The guard ignores SIGINT, SIGTERM and SIGHUP: a group
// signal reaches the command itself (lib/waitRunner.js sends SIGTERM first, so gates.mjs can clean up), and the guard
// ends when the command does, with its exit code, or by the same signal on POSIX.
//
// The script's two forms:
//   node treeRun.js <timeoutMs> <command> [<parentPid>]   the budget's supervisor (runBounded). Stays in its caller's
//       process group, so Ctrl-C in the terminal still reaches it and it ends the tree. It also watches its caller.
//   node treeRun.js guard <parentPid> shell <command>     the guard for a shell command (gates.mjs runShell, and the
//   node treeRun.js guard <parentPid> exec <file> [...]   supervisor above) or for a program (lib/waitRunner.js).
//
// runBounded(command, o) stays synchronous for its callers (lib/doneCheck.js runDoneWhen and through it the base gate
// and the red-on-base check): it runs the supervisor with spawnSync and gives back what spawnSync gives, plus
// `timedOut`. The supervisor says "timed out" on its own fd 3, so the command's exit code and output are never read
// for it. spawnSync keeps a fallback limit a little above the budget, for a supervisor that cannot end.
//
// Pure except the runs. Tested in lib/__tests__/doneCheck.test.ts (a hanging command leaves no process behind) and
// __tests__/redteam/rt15-hanging-gate.test.ts (a runner killed without warning takes its command along).
// =============================================================
'use strict';

const { spawn: spawnAsync, spawnSync } = require('node:child_process');
const { hiddenWindowsEnv } = require('./hideWindows.cjs');
const fs = require('node:fs');

/** How long the supervisor waits for the ended tree to close its pipes before it ends anyway. */
const GRACE_MS = 5000;
/** spawnSync's own limit over the budget: only reached when the supervisor itself cannot end. */
const FALLBACK_MS = 30_000;
/** What the supervisor writes on fd 3 when the budget ran out. */
const TIMED_OUT = 'timed-out';
/** How often a guard (and the supervisor) looks whether the process it belongs to still lives. */
const PARENT_POLL_MS = 1000;

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

/** True while `pid` runs (EPERM: it runs, as another user). */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

/**
 * True while the process this one belongs to (`parentPid`) lives. POSIX: an orphan gets a new parent (init or a
 * subreaper), so a changed ppid says it at once, also before the dead parent is reaped. Windows keeps the original ppid,
 * so there the pid itself is checked. No pid (run by hand): nothing to watch.
 */
function parentAlive(parentPid) {
  if (!(parentPid > 0)) return true;
  return process.ppid === parentPid && alive(parentPid);
}

/** Calls `onGone` once when `parentPid` is gone (looked at every PARENT_POLL_MS). Returns the timer, to clear. */
function watchParent(parentPid, onGone) {
  const t = setInterval(() => {
    if (parentAlive(parentPid)) return;
    clearInterval(t);
    onGone();
  }, PARENT_POLL_MS);
  t.unref();
  return t;
}

/**
 * The spawn arguments that start `command` (a shell command line) under a guard for this process: spawn(process.execPath,
 * guardShellArgs(command), { detached: true, ... }). gates.mjs runShell and the supervisor below.
 */
function guardShellArgs(command, parentPid = process.pid) {
  return [__filename, 'guard', String(parentPid), 'shell', command];
}

/** The spawn arguments that start `node <args...>` under a guard for this process (lib/waitRunner.js). */
function guardExecArgs(args, parentPid = process.pid) {
  return [__filename, 'guard', String(parentPid), 'exec', process.execPath, ...args];
}

/**
 * Runs `command` through the shell in `cwd`, at most `timeoutMs` long, and its whole tree is ended at the budget (and
 * when this process dies: the guard). `spawn` is a spawnSync (lib/gateEnv.js trackCodeSpawn gives one with a scrubbed
 * environment); it is called as spawn(file, args, options). Returns spawnSync's result with `timedOut` (true only when
 * the budget ran out).
 */
function runBounded(command, { cwd, timeoutMs, maxBuffer = 1 << 28, spawn = spawnSync }) {
  const s = spawn(process.execPath, [__filename, String(Math.max(1, Math.round(timeoutMs))), command, String(process.pid)], {
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

/** Writes a line to fd 2, if it is there. */
function say(text) {
  try {
    fs.writeSync(2, `${text}\n`);
  } catch {
    // error-ignored
  }
}

/**
 * The supervisor: node treeRun.js <timeoutMs> <command> [<parentPid>]. Exits with the command's exit code (1 when it
 * has none). The command runs under a guard for this process, so a supervisor killed with its caller's group (which
 * runs no handler) still takes the command along.
 */
function supervise(timeoutMs, command, parentPid) {
  const child = spawnAsync(process.execPath, guardShellArgs(command), {
    detached: true, // the guard: its own process group (POSIX), outside this process's job (Windows)
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
    env: hiddenWindowsEnv(process.env), // hidden windows passed on to the command (lib/hideWindows.cjs: windowsHide here does not reach what the run starts)
  });
  let ended = false;
  const end = (code) => {
    if (ended) return;
    ended = true;
    process.exit(code);
  };
  const endTree = () => {
    killTree(child.pid);
    // A process outside the tree can keep the pipes open: the supervisor still ends.
    setTimeout(() => end(1), GRACE_MS).unref();
  };
  const timer = setTimeout(() => {
    try {
      fs.writeSync(3, TIMED_OUT);
    } catch {
      // error-ignored: no fd 3 (run by hand); the exit below still ends the run
    }
    endTree();
  }, timeoutMs);
  // The caller died alone (its group lives on, and so does this supervisor): nobody waits for the command any more.
  const watch = watchParent(parentPid, endTree);
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
    say(e.message);
    clearTimeout(timer);
    end(1);
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    clearInterval(watch);
    end(Number.isInteger(code) ? code : 1);
  });
}

/** Ends this process the way its command ended: with its exit code, or (POSIX) by the same signal. */
function endLike(code, signal) {
  if (Number.isInteger(code)) process.exit(code);
  if (signal && process.platform !== 'win32') {
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeAllListeners(sig);
    try {
      process.kill(process.pid, signal);
    } catch {
      // error-ignored: the exit below
    }
    // A signal that does not end a process by default still ends this one.
    setTimeout(() => process.exit(1), 1000).unref();
    return;
  }
  process.exit(1);
}

/**
 * The guard: node treeRun.js guard <parentPid> shell <command> | exec <file> [args...]. Runs the command in this
 * process's own group (it is started detached), and ends the whole group once `parentPid` is gone.
 */
function guard(parentPid, how, rest) {
  const posix = process.platform !== 'win32';
  const shell = how === 'shell';
  const child = spawnAsync(rest[0], shell ? [] : rest.slice(1), {
    shell,
    stdio: ['ignore', 'inherit', 'inherit'],
    windowsHide: true,
  });
  let ended = false;
  const end = (code, signal = null) => {
    if (ended) return;
    ended = true;
    endLike(code, signal);
  };
  const watch = watchParent(parentPid, () => {
    // POSIX: the group is the guard's own (it was started detached) and holds the command's tree; Windows: /T from the
    // command. Either way this guard ends too.
    killTree(posix ? process.pid : child.pid);
    setTimeout(() => end(1), GRACE_MS).unref();
  });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    try {
      process.on(sig, () => {
        // ignored: the group signal reached the command too, and the guard ends when the command does
      });
    } catch {
      // a signal this platform does not have
    }
  }
  child.on('error', (e) => {
    say(e.message);
    clearInterval(watch);
    end(1);
  });
  child.on('exit', (code, signal) => {
    clearInterval(watch);
    end(Number.isInteger(code) ? code : null, signal);
  });
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv[0] === 'guard') guard(Number(argv[1]), argv[2], argv.slice(3));
  else supervise(Number(argv[0]), argv[1], Number(argv[2]));
}

module.exports = { FALLBACK_MS, GRACE_MS, PARENT_POLL_MS, TIMED_OUT, alive, guardExecArgs, guardShellArgs, killTree, parentAlive, runBounded };
