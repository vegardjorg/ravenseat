// =============================================================
// lib/waitMode.js: one wait mode for long calls (`ravenseat gates`, `ravenseat receive`, `ravenseat merge`).
//
// Why: Claude Code's Bash tool stops a call after 120 s by default (600 s at most). A gate run can take up to about 900 s
// (and wait in the gate queue first), so agents moved these calls to the background, and every completion notification
// cost one more turn with the whole context. A wait over 300 s also misses the 5 minute prompt cache.
//
// What it does: the command runs in a detached runner (lib/waitRunner.js) with its output in files under
// <dataFolder>/runs/. The call shows that output as it comes and blocks for at most wait.blockSec (default 280, under the
// cache's 300 s). Done by then: it ends with the command's own output and exit code, as before. Not done: it prints ONE line
//   RUNNING: <what> (run <id>), started <time>. Next: <cli> <command> --wait <id> (Bash timeout <ms>)
// and exits 75. The next command waits for the SAME run (it never starts another one), shows only the output the earlier
// calls did not show, and blocks again for at most wait.blockSec. The run goes on while nobody waits.
//   - The same command with the same arguments in the same folder on the same commit is never started twice while one
//     runs: a second call says so and waits for the first run (a lock file per key, created exclusively).
//   - A hard cap (hardSec, generous over the gate budgets; QUEUE_WAIT_HARD_SEC overrides) ends a run that hangs; the
//     runner reports it red as timed out, as gates.mjs reports a gate over its budget.
//   - Off: wait.blockSec 0, QUEUE_WAIT=off (the runner sets it for the command it runs, so nothing nests), or a terminal
//     (a person at a terminal waits as before). `--wait <id>` always works.
// The run files are a relay for what the command printed, not evidence: the queue state and the gate evidence store
// (lib/gateEvidence.js) stay what receive, merge and the push check rely on.
// =============================================================
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

/** The default block budget: under the 5 minute prompt cache, with room for the call's own start and end. */
const DEFAULT_BLOCK_SEC = 280;
/** The highest block budget: the Bash tool's maximum timeout is 600 s. */
const MAX_BLOCK_SEC = 590;
/** The exit code of a call that returns with RUNNING (EX_TEMPFAIL): never 0, so `&&` never goes on as if green. */
const RUNNING_EXIT = 75;
/** The commands that use the wait mode. */
const COMMANDS = Object.freeze(['gates', 'receive', 'merge']);
/** How often a waiter looks for new output and the result. */
const POLL_MS = 200;
/** Finished runs older than this are removed when a new run starts. */
const KEEP_MS = 3 * 24 * 60 * 60 * 1000;
/** A run whose runner has not written its pid yet counts as starting for this long. */
const STARTING_MS = 30_000;

/** A whole number >= 0 from a config or env value, or null. */
function wholeOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * The setup: { blockSec, hardSec }. blockSec 0 = off. QUEUE_WAIT=off turns it off, QUEUE_WAIT_BLOCK_SEC and
 * QUEUE_WAIT_HARD_SEC override (tests, and a one-off call). The hard cap is at least two hours and four times the
 * largest budget a run can use (gates, base gate, done check): a flaky rerun gets a fresh budget, and receive and merge
 * run several lists. A run waiting in the gate queue counts too, so the cap is wide on purpose: it is a backstop.
 */
function setupFrom(cfg = {}, env = process.env) {
  let blockSec = wholeOrNull(cfg?.wait?.blockSec) ?? DEFAULT_BLOCK_SEC;
  const fromEnv = wholeOrNull(env.QUEUE_WAIT_BLOCK_SEC);
  if (fromEnv !== null) blockSec = fromEnv;
  if (/^(off|0|false|no)$/i.test(String(env.QUEUE_WAIT ?? ''))) blockSec = 0;
  blockSec = Math.min(MAX_BLOCK_SEC, blockSec);
  const budgets = [cfg?.gates?.timeoutSec, cfg?.baseGate?.timeoutSec, cfg?.doneCheck?.timeoutSec, 900].map((v) => wholeOrNull(v) ?? 0);
  const hardEnv = wholeOrNull(env.QUEUE_WAIT_HARD_SEC);
  const hardSec = hardEnv && hardEnv > 0 ? hardEnv : Math.max(7200, 4 * Math.max(...budgets));
  return { blockSec, hardSec };
}

/** The Bash timeout (ms) to give the call: the budget and 20 s for the start and the end, never over 600000. */
function bashTimeoutMs(blockSec) {
  return Math.min(600_000, (Math.max(0, Number(blockSec) || 0) + 20) * 1000);
}

/** Does this call use the wait mode? `--wait <id>` always does; otherwise not for --health/--help or a terminal. */
function wanted({ command, args = [], isTTY = false, setup }) {
  if (!COMMANDS.includes(command)) return false;
  if (args.includes('--wait')) return true;
  if (args.some((a) => a === '--health' || a === '--help' || a === '-h')) return false;
  if (isTTY) return false;
  return Number(setup?.blockSec) > 0;
}

/** The RUNNING line (one line, the last one the call prints). */
function runningLine({ what, id, startedAt, command, cli, blockSec }) {
  const t = new Date(startedAt);
  const at = Number.isFinite(t.getTime()) ? `${t.toISOString().slice(0, 19).replace('T', ' ')} UTC` : 'at an unknown time';
  return `RUNNING: ${what} (run ${id}), started ${at}. Next: ${cli} ${command} --wait ${id} (Bash timeout ${bashTimeoutMs(blockSec)})`;
}

/** The folder of the run files. */
function runsFolder(dataFolder) {
  return path.join(dataFolder || path.join(os.tmpdir(), 'ravenseat'), 'runs');
}

/** The key of a run: the same command, arguments, folder and commit is the same run. */
function runKey({ command, args, cwd, sha }) {
  const folder = process.platform === 'win32' ? path.resolve(cwd).toLowerCase() : path.resolve(cwd);
  return crypto.createHash('sha256').update(JSON.stringify([command, args, folder, sha ?? null])).digest('hex').slice(0, 24);
}

const files = (folder, id) => ({
  meta: path.join(folder, `${id}.json`),
  out: path.join(folder, `${id}.out`),
  err: path.join(folder, `${id}.err`),
  done: path.join(folder, `${id}.done.json`),
  pid: path.join(folder, `${id}.pid`),
  shown: path.join(folder, `${id}.shown.json`),
});

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Writes JSON through a temporary file and a rename, so a reader never sees half of it. */
function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  try {
    fs.renameSync(tmp, file);
  } catch {
    fs.writeFileSync(file, JSON.stringify(value)); // Windows: a reader holding the file blocks the rename
    fs.rmSync(tmp, { force: true });
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

/** A run's state: { missing } | { done, exit } | { running } | { lost } (the runner is gone without a result). */
function runState(folder, id, { now = Date.now() } = {}) {
  const f = files(folder, id);
  const meta = readJson(f.meta);
  if (!meta) return { missing: true };
  const done = readJson(f.done);
  if (done) return { meta, done: true, exit: Number.isInteger(done.exit) ? done.exit : 1, timedOut: done.timedOut === true };
  const pid = Number(readText(f.pid));
  if (pid) return pidAlive(pid) || fs.existsSync(f.done) ? { meta, running: true } : { meta, lost: true };
  return now - Date.parse(meta.startedAt) < STARTING_MS ? { meta, running: true } : { meta, lost: true };
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

/** Removes finished (or lost) runs older than KEEP_MS. Housekeeping: errors are ignored. */
function sweep(folder, { now = Date.now() } = {}) {
  let names = [];
  try {
    names = fs.readdirSync(folder);
  } catch {
    return;
  }
  for (const n of names) {
    const m = /^([a-z]+-[a-z0-9]+)\.json$/.exec(n);
    if (!m) continue;
    try {
      if (now - fs.statSync(path.join(folder, n)).mtimeMs < KEEP_MS) continue;
      const s = runState(folder, m[1], { now });
      if (s.running) continue;
      for (const file of Object.values(files(folder, m[1]))) fs.rmSync(file, { force: true });
    } catch {
      // error-ignored: housekeeping
    }
  }
}

/**
 * Starts the command in a detached runner, or finds the run already going for the same key.
 * @returns {{ id: string, attached: boolean, meta: object }}
 */
function startOrAttach({ folder, command, args, key, what, childArgv, cwd, hardSec, env = process.env, now = Date.now }) {
  fs.mkdirSync(folder, { recursive: true });
  const lock = path.join(folder, `key-${key}.lock`);
  for (let attempt = 0; attempt < 5; attempt++) {
    const held = readText(lock);
    if (held) {
      const s = runState(folder, held);
      if (s.running) return { id: held, attached: true, meta: s.meta };
      fs.rmSync(lock, { force: true }); // the run there is over: this call starts a new one
      continue;
    }
    const id = `${command}-${now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
    try {
      fs.writeFileSync(lock, id, { flag: 'wx' });
    } catch {
      continue; // another call took the key just now: look again, and wait for that run
    }
    sweep(folder);
    const f = files(folder, id);
    const meta = { id, command, args, what, cwd, key, startedAt: new Date(now()).toISOString(), hardSec };
    writeJson(f.meta, meta);
    const out = fs.openSync(f.out, 'a');
    const err = fs.openSync(f.err, 'a');
    try {
      const runner = spawn(
        process.execPath,
        [path.join(__dirname, 'waitRunner.js'), f.done, f.pid, String(hardSec), lock, id, '--', ...childArgv],
        {
          cwd,
          detached: true, // its own process group (POSIX) / no console (Windows): it outlives this call
          windowsHide: true,
          stdio: ['ignore', out, err],
          env: { ...env, QUEUE_WAIT: 'off' }, // the command it runs never uses the wait mode itself
        },
      );
      runner.unref();
    } finally {
      fs.closeSync(out);
      fs.closeSync(err);
    }
    return { id, attached: false, meta };
  }
  throw new Error('the run lock could not be taken');
}

/** Writes the bytes of `file` from `offset` to `stream`; returns the new offset. */
async function pump(file, offset, stream) {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return offset;
  }
  if (size <= offset) return offset;
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - offset);
    const n = fs.readSync(fd, buf, 0, buf.length, offset);
    if (n > 0) await new Promise((resolve) => stream.write(buf.subarray(0, n), () => resolve()));
    return offset + n;
  } finally {
    fs.closeSync(fd);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Shows the run's output from where the earlier calls stopped (or from the start) and waits for at most blockSec.
 * @returns {Promise<{ done: true, exit: number } | { done: false }>}
 */
async function waitFor({ folder, id, blockSec, fromStart = false, stdout = process.stdout, stderr = process.stderr }) {
  const f = files(folder, id);
  const shown = fromStart ? null : readJson(f.shown);
  let at = { out: Number(shown?.out) || 0, err: Number(shown?.err) || 0 };
  const save = () => {
    try {
      const before = readJson(f.shown) ?? {};
      writeJson(f.shown, { out: Math.max(at.out, Number(before.out) || 0), err: Math.max(at.err, Number(before.err) || 0) });
    } catch {
      // error-ignored: the next call shows a part again, nothing is lost
    }
  };
  // Asked again after everything was shown: show the whole output once more (the caller lost it).
  const s0 = runState(folder, id);
  if (s0.done && !fromStart) {
    const size = (p) => {
      try {
        return fs.statSync(p).size;
      } catch {
        return 0;
      }
    };
    if (at.out >= size(f.out) && at.err >= size(f.err)) at = { out: 0, err: 0 };
  }
  const deadline = Date.now() + blockSec * 1000;
  for (;;) {
    at.out = await pump(f.out, at.out, stdout);
    at.err = await pump(f.err, at.err, stderr);
    const s = runState(folder, id);
    if (s.done) {
      at.out = await pump(f.out, at.out, stdout);
      at.err = await pump(f.err, at.err, stderr);
      save();
      return { done: true, exit: s.exit };
    }
    if (s.lost) {
      save();
      const line = `RED: the run ${id} ended without a result (its process is gone, for example after a restart). Run the command again.\n`;
      await new Promise((resolve) => stderr.write(line, () => resolve()));
      return { done: true, exit: 1 };
    }
    if (Date.now() >= deadline) {
      save();
      return { done: false };
    }
    await sleep(Math.min(POLL_MS, Math.max(10, deadline - Date.now())));
  }
}

/** The HEAD commit of a folder, or null. */
function headOf(dir) {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

/** The value after a flag, or null. */
function option(args, name) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
}

/**
 * The whole call: `--wait <id>`, or start (or attach) and wait. Returns the exit code.
 * @param {{ command: string, args: string[], childArgv: string[], setup: { blockSec: number, hardSec: number },
 *   cwd: string, dataFolder: string|null, cli: string }} o
 */
async function main(o) {
  const folder = runsFolder(o.dataFolder);
  const blockSec = o.setup.blockSec > 0 ? o.setup.blockSec : DEFAULT_BLOCK_SEC;
  const say = (line) => new Promise((resolve) => process.stdout.write(`${line}\n`, () => resolve()));
  const what = `${o.cli} ${o.command}${o.args.length ? ` ${o.args.join(' ')}` : ''}`;
  if (o.args.includes('--wait')) {
    const id = option(o.args, '--wait');
    const s = id && /^[a-z]+-[a-z0-9]+$/.test(id) ? runState(folder, id) : { missing: true };
    if (s.missing) {
      process.stderr.write(`ravenseat: no run ${id ?? '(none given)'} in ${folder}. Use the id the RUNNING line printed.\n`);
      return 2;
    }
    if (s.meta.command !== o.command) {
      process.stderr.write(`ravenseat: run ${id} is a ${s.meta.command} run: wait for it with ${o.cli} ${s.meta.command} --wait ${id}.\n`);
      return 2;
    }
    const r = await waitFor({ folder, id, blockSec });
    if (r.done) return r.exit;
    await say(runningLine({ what: s.meta.what, id, startedAt: s.meta.startedAt, command: o.command, cli: o.cli, blockSec }));
    return RUNNING_EXIT;
  }
  const runCwd = o.command === 'gates' && option(o.args, '--cwd') ? path.resolve(o.cwd, option(o.args, '--cwd')) : o.cwd;
  const key = runKey({ command: o.command, args: o.args, cwd: runCwd, sha: headOf(runCwd) });
  const run = startOrAttach({ folder, command: o.command, args: o.args, key, what, childArgv: o.childArgv, cwd: o.cwd, hardSec: o.setup.hardSec });
  if (run.attached)
    await say(
      `ALREADY RUNNING: the same ${run.meta.what} is already running on this commit (run ${run.id}, started ` +
        `${String(run.meta.startedAt).slice(11, 19)} UTC); this call waits for it instead of starting a second one.`,
    );
  const r = await waitFor({ folder, id: run.id, blockSec, fromStart: true });
  if (r.done) return r.exit;
  await say(runningLine({ what: run.meta.what, id: run.id, startedAt: run.meta.startedAt, command: o.command, cli: o.cli, blockSec }));
  return RUNNING_EXIT;
}

module.exports = {
  DEFAULT_BLOCK_SEC,
  MAX_BLOCK_SEC,
  RUNNING_EXIT,
  COMMANDS,
  setupFrom,
  bashTimeoutMs,
  wanted,
  runningLine,
  runsFolder,
  runKey,
  runState,
  startOrAttach,
  waitFor,
  main,
};
