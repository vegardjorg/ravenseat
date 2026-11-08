#!/usr/bin/env node
// =============================================================
// gates.mjs: runs the project's gates (config().gates.quick or .full from queue.config.json) in order.
//
// WHY: tracks and the orchestrator must check the work the same way whatever the project. Which commands are
// gates (type check, lint, tests, custom checks) is the project's business and lives in queue.config.json, not here.
//   --quick  what tracks run before delivery (quick checks).
//   --full  what the orchestrator runs after merge and before a batch push (everything).
//
// Runs in process.cwd() when it is the project root or a worktree of the project (a track checks its own
// worktree), otherwise in the project root. Each gate is a shell command; it is green when the exit code is 0.
//
// Output: one line per gate (GREEN/RED + duration, and the first error line for red ones) and a final line.
// Exit 0 when all are green (or no gates are set up), 1 otherwise.
//   --log <file>  writes the whole output of each gate to the file (for debugging without filling the context).
//   --timeout-sec <n>  (--quick/--full) one time budget for the whole list; a gate over it is red (ravenseat merge passes the
//                 base gate's budget when the quick gates are the base gate, lib/baseHealth.js). The budget starts when the
//                 first gate command starts, not while the run waits in the gate queue.
//
// The gate queue (lib/gateQueue.js, config().gateQueue): a --quick/--full run whose last run of the same kind took at least
// heavyAfterSec waits for a slot shared by the whole machine. One line says who it waits for; the wait goes into the gate
// row as `wait_sec`. Everything a run binds itself to (the HEAD commit, the evidence store's text, the git surface) is read
// after the wait, so a commit or another run's evidence during the wait is not a change during the run. The gate commands
// get QUEUE_GATE_QUEUE=off: one that runs gates.mjs again must not wait for the slot its own parent holds.
//
// Free memory (lib/gateLoad.js): sampled at the start, every 30 s and at the end; the lowest value goes into the gate row as
// `min_free_memory_pct`. A red run or a timeout below the load guard's limit prints one line saying it is probably load and
// not the code. It stays red. The gate commands run with an async spawn: a spawnSync would block the sampling timer, the
// signal handlers and so the release of the slot.
//
//   --precheck  the fail-fast precheck a track runs BEFORE the class's full gate: the cheapest checks first, in a fixed
//               order, only on the files changed against baseBranch (`gates.precheck`, with `{changed}`/`{file}`;
//               standard checks when it is not set), and it STOPS at the first red one. One line per check with time
//               and GREEN/RED/SKIP; under a red one the first error lines. Exit 0 green, 1 red, 3 over a check's time
//               budget (gates.precheckBudgetSec), 2 setup error. --json gives the summary as JSON instead of lines;
//               --base <ref> compares against another ref. The logic lives in lib/gatePrecheck.js.
//
// Time log: every run (quick, full or precheck) appends one `gate` row to the time log (config().timeLog; QUEUE_TIME_LOG
// overrides): the kind, the gates that ran and the red ones, the duration, the exit code and `attempt` (the how-many-th
// run of this kind for the task), so reruns can be counted. The task is --track <id> (ravenseat merge passes it) or the branch
// <branchPrefix><id>, otherwise null. The row also has the HEAD commit (`sha`) and `clean` (no uncommitted tracked
// changes) from the start of the run. The row format lives in lib/timeLogRows.js. Writing it never changes the result
// or the exit code (fail open). The time log row is MEASUREMENT ONLY: every agent can append to that file.
//
// Gate evidence (lib/gateEvidence.js): what ravenseat receive, ravenseat merge (the base gate's skip rule) and the push check rely on.
// A --quick/--full run records one entry in <dataFolder>/gate-evidence.json (sha, clean, the commands, green or red) only
// when the orchestrator's side runs it: with --evidence (ravenseat receive and ravenseat merge pass it) or in the MAIN checkout (not a
// linked worktree; the full gate before a batch push). A track's own run in its worktree is never evidence.
// Who writes it: THIS process, the orchestrator's side, and only after every gate command has exited. The gate commands
// load the track's code, so they run as child processes that only report an exit code; they get a scrubbed environment
// (lib/gateEnv.js: no tokens or cloud keys, no variable that points to the data folder or the store) and never the
// store's path on their command line. The entry carries `writer: "orchestrator"` and the `setup_hash` of the configured
// gates. The store's text is read before the first command and compared after the last one; a change during the run
// (a gate command wrote to it) is dropped and the run is recorded RED with `tampered: true` (lib/gateEvidence.js
// recordRun), printed on stderr, and the exit code is 1. This is no OS isolation: see the limits in lib/gateEnv.js.
// What the entry covers (lib/gateCoverage.js, read before the first command): `runner`, the shared links and how many
// untracked and ignored paths the commands could see; a line before the final line says so when evidence was recorded.
//
// Git hooks and config (lib/gitExecSurface.js): a gate command can write the shared .git, and what it plants there runs at
// the orchestrator's next git command with the tokens the gate was scrubbed of. Every --quick/--full run reads the
// effective hooks folder and the config values that run a program before the first command and compares them after the
// last one. A change makes the run red (`tampered: true`, `tamper_reason` naming it, exit 1); nothing is restored, the
// message says what to inspect. This is detection against accidents and simple cheating, not prevention.
// A run that records evidence is also red when they differ from the accepted baseline (lib/gitSurfaceBaseline.js), so an
// evidence entry is never green over a drifted surface and a rerun after a planted hook stays red. A track's own run keeps
// the comparison during the run only: an owner's new hook must not make every track red. The baseline file itself is
// watched in both: a change to it during the run is undone and makes the run red.
//   --evidence  record evidence also outside the main checkout (the push guard denies it to queue agents).
//   --cwd <folder>  run in that folder (ravenseat receive: the track's worktree).
//
// Use: node scripts/orchestrator/gates.mjs --quick|--full [--track <id>] [--log <file>] [--timeout-sec <n>] [--evidence] [--cwd <folder>]
//      node scripts/orchestrator/gates.mjs --precheck [--json] [--base <ref>] [--track <id>] [--log <file>]
// See docs/orchestration.md.
// =============================================================

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { config } = require('./lib/queueConfig.js');
const { firstErrorLine, gateType, resultLine } = require('./lib/orchestratorHelp.js');
const TL = require('./lib/timeLogRows.js');
const { timeLog } = require('./lib/queueConfig.js');

const args = process.argv.slice(2);
const quick = args.includes('--quick');
const full = args.includes('--full');
const precheck = args.includes('--precheck');
if ([quick, full, precheck].filter(Boolean).length !== 1) {
  console.error(
    'use: gates.mjs --quick|--full [--track <id>] [--log <file>] [--timeout-sec <n>] [--evidence] [--cwd <folder>]\n' +
      '     gates.mjs --precheck [--json] [--base <ref>] [--track-base <sha> --track-tip <sha>] [--track <id>] [--log <file>]',
  );
  process.exit(2);
}
const li = args.indexOf('--log');
const logFile = li >= 0 && args[li + 1] ? path.resolve(args[li + 1]) : null;
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : null;
};

const K = config();
// queue.config.json exists but does not parse: stop (H3); empty default gates would report a green run.
require('./lib/queueConfig.js').stopIfConfigUnreadable(K);

/** The repo's shared git folder as seen from `dir` (the same for the main checkout and all its worktrees), or null. */
function commonGitDir(dir) {
  const r = spawnSync('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' });
  return r.status === 0 && r.stdout.trim() ? path.resolve(r.stdout.trim()).toLowerCase() : null;
}
/**
 * Is `path` the project root, a folder under it (<root>/.claude/worktrees/<name>/...), or a linked worktree of the same
 * repo somewhere else? A worktree outside the root once fell back to the root, so a track's gate checked the main
 * checkout's commit and said green (R5, 2026-11-08).
 */
function inProject(filePath) {
  const rel = path.relative(K.root, filePath);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return true;
  const mine = commonGitDir(filePath);
  return mine !== null && mine === commonGitDir(K.root);
}
// --cwd <folder>: run there (ravenseat receive runs the quick gate in the track's worktree, which need not be under the root).
const cwd = option('--cwd') ? path.resolve(option('--cwd')) : inProject(process.cwd()) ? process.cwd() : K.root;

/**
 * Appends this run's `gate` row to the time log (lib/timeLogRows.js). Fail open: every error is swallowed, so the log
 * can never change the gate's result or exit code.
 */
function logRun({ kind, ran, failed, durationSec, exit, timedOut = false, waitSec = null, minFreeMemoryPct = null }) {
  try {
    const branch = (git('rev-parse', '--abbrev-ref', 'HEAD') || '').trim() || null;
    const track = option('--track') ?? TL.trackFromBranch(branch, K.branchPrefix);
    const file = timeLog();
    let text = null;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      text = null; // no log yet: this is the first run
    }
    const attempt = TL.gateAttempt(text, { kind, track, branch });
    // A commit made during the run means the run checked neither commit exactly: no sha then.
    const sha = START.sha && (git('rev-parse', 'HEAD') || '').trim() === START.sha ? START.sha : null;
    TL.appendRows(
      file,
      TL.gateRow({ track, branch, kind, gates: ran, failed, durationSec, exit, timedOut, attempt, sha, clean: START.clean, waitSec, minFreeMemoryPct }),
    );
  } catch {
    // error-ignored: the time log is for measurement; the gate's result is what matters
  }
}

/**
 * The commit and the cleanliness when the run starts (for the gate row: the base gate's skip rule, lib/baseHealth.js,
 * trusts only a green run on exactly one commit with no uncommitted tracked changes). Untracked files are not counted:
 * build output and logs are usually untracked, and a new file a gate depended on would be in the track's commit anyway.
 */
function startState() {
  const sha = (git('rev-parse', 'HEAD') || '').trim() || null;
  const status = git('status', '--porcelain', '--untracked-files=no');
  return { sha, clean: status == null ? undefined : status.trim() === '' };
}
// Read again after a wait in the gate queue: the run checks the commit that is there when its commands start.
let START = startState();
// The gate command running now, for the signal handlers. Up here because --precheck runs before the code further down.
let runningChild = null;
/** A gate command that prints more than this is stopped and red (the limit spawnSync's maxBuffer used to give). */
const MAX_OUTPUT = 256 << 20;

/**
 * Is the gate folder the MAIN checkout (not a linked worktree)? git-dir and git-common-dir are the same folder there.
 * A run in the main checkout is the orchestrator's (before a batch push, after a merge) and records gate evidence by
 * default; a track runs in its own worktree. null when git cannot tell.
 */
function inMainTree() {
  const out = git('rev-parse', '--git-dir', '--git-common-dir');
  if (out == null) return null;
  const [dir, common] = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!dir || !common) return null;
  const norm = (p) => {
    const abs = path.resolve(cwd, p);
    return process.platform === 'win32' ? abs.toLowerCase() : abs;
  };
  return norm(dir) === norm(common);
}

/** The evidence store file (lib/gateEvidence.js) in the data folder, or null when the data folder cannot be found. */
function evidenceFile() {
  try {
    const { dataFolder } = require('./lib/queueConfig.js');
    return require('./lib/gateEvidence.js').storeFile(dataFolder());
  } catch {
    return null;
  }
}

/**
 * The environment for the gate commands (lib/gateEnv.js): this process's environment without tokens, cloud keys and
 * every variable that points to the data folder or the evidence store. Computed once; the gate commands never get the
 * unscrubbed one.
 */
function childEnvironment() {
  // QUEUE_GATE_QUEUE=off: a gate command that runs gates.mjs again must not wait for the slot its parent holds.
  // QUEUE_EVIDENCE_LOCK=held: nor for the evidence lock (below) its parent holds.
  return {
    ...require('./lib/gateEnv.js').trackCodeEnv(process.env, { storeFile: evidenceFile(), root: K.root }).env,
    QUEUE_GATE_QUEUE: 'off',
    QUEUE_EVIDENCE_LOCK: 'held',
  };
}
const CHILD_ENV = childEnvironment();

/**
 * The gate commands' own temp folder (lib/gateTemp.js): made at the first command, so a run waiting in the gate queue holds
 * none, and removed when this process ends. Only the commands get it: this process keeps the real temp folder, where the
 * gate queue's slots live. What a project's tests leave behind goes with the folder.
 */
let gateTempDir = null;
let gateEnvNow = null;
function gateCommandEnv() {
  if (gateEnvNow) return gateEnvNow;
  const GT = require('./lib/gateTemp.js');
  gateTempDir = K.gateTemp?.enabled === false ? null : GT.create();
  gateEnvNow = GT.withTemp(CHILD_ENV, gateTempDir);
  return gateEnvNow;
}
/** Housekeeping: it never changes the result of the run, and a folder it leaves is swept by a later run. */
function removeGateTemp() {
  if (!gateTempDir) return;
  const dir = gateTempDir;
  gateTempDir = null;
  if (require('./lib/gateTemp.js').remove(dir).link) console.log(`TEMP: ${dir} was left in place: it holds a link, and removing through one can delete what it points at.`);
}

/**
 * Does this run record evidence? Only when the orchestrator's side runs it: --evidence (ravenseat receive, ravenseat merge) or a run
 * in the main checkout. A track's own run in its worktree never does. Decided BEFORE the gate commands run.
 */
function evidenceWanted() {
  const mainTree = inMainTree() === true;
  return { wanted: args.includes('--evidence') || mainTree, mainTree };
}

/**
 * The evidence store's text before the first gate command (the tamper check in lib/gateEvidence.js recordRun), or
 * undefined when this run records no evidence.
 */
function evidenceBefore(want) {
  if (!want.wanted) return undefined;
  const file = evidenceFile();
  return file ? require('./lib/gateEvidence.js').readStoreText(file) : undefined;
}

/**
 * Records this run as trusted gate evidence (lib/gateEvidence.js), in this process after every gate command has exited,
 * when the orchestrator's side ran it (evidenceWanted). The entry needs the sha (HEAD did not move during the run) and
 * the cleanliness at the start; it carries the setup hash of the configured gates and `writer: "orchestrator"`.
 * `before` is the store's text from before the run; a change during the run makes the entry red (tampered), and so does
 * `tamperReason` (git hooks or config changed). `coverage` is what the run could see beyond the commit.
 * Fail open: a write error only means no evidence, so the caller runs the gate again or asks.
 * @returns {{ recorded: boolean, tampered: boolean, reason?: string, covered?: string }}
 */
function recordEvidence({ kind, ran, failed, exit, timedOut = false, want, before, coverage = null, tamperReason = null }) {
  try {
    if (!want?.wanted) return { recorded: false, tampered: false };
    const GE = require('./lib/gateEvidence.js');
    const file = evidenceFile();
    if (!file) return { recorded: false, tampered: false };
    const sha = START.sha && (git('rev-parse', 'HEAD') || '').trim() === START.sha ? START.sha : null;
    const branch = (git('rev-parse', '--abbrev-ref', 'HEAD') || '').trim() || null;
    const track = option('--track') ?? TL.trackFromBranch(branch, K.branchPrefix);
    const entry = GE.entry({
      kind,
      sha,
      setupHash: GE.setupHash(K.gates),
      clean: START.clean,
      exit,
      gates: ran,
      failed,
      timedOut,
      track,
      branch,
      mainTree: want.mainTree,
      coverage,
    });
    const result = GE.recordRun({ file, before: before ?? null, entry, tamperReason });
    return { ...result, covered: result.recorded ? GE.coverageLine(entry) : '' };
  } catch {
    // error-ignored: no evidence is the safe direction (receive runs the gate again, the push check asks)
    return { recorded: false, tampered: false };
  }
}

/**
 * What this run could see beyond the commit, for the evidence entry (lib/gateCoverage.js). Read before the first gate
 * command and only when this run records evidence. core.fsmonitor is off for these git calls: they must not start a
 * program someone planted. null when git cannot tell where the worktree's root is.
 */
function coverageNow(want) {
  if (!want.wanted) return null;
  try {
    const top = (git('rev-parse', '--show-toplevel') || '').trim();
    if (!top) return null;
    return require('./lib/gateCoverage.js').readCoverage({
      top: path.resolve(top),
      links: require('./lib/orchestratorHelp.js').trackLinks(K.sharedLinks),
      git: (...a) => git('-C', top, '-c', 'core.fsmonitor=false', ...a),
    });
  } catch {
    return null; // error-ignored: the entry is then without the counts, which reads as unknown
  }
}

// Before --precheck too: its commands run in their own process group on POSIX, so Ctrl-C reaches them only through here.
const GQ = require('./lib/gateQueue.js');
let slot = null;
const releaseSlot = () => {
  if (slot) GQ.release(slot);
  slot = null;
};
process.on('exit', releaseSlot);
process.on('exit', removeGateTemp);
/**
 * Ends the running gate command and gives the slot back, then ends as the signal asks, so a caller (ravenseat merge) still
 * sees an interrupted child and never a red gate: on POSIX by the signal itself, on Windows with the Ctrl-C exit status.
 */
function onSignal(sig) {
  if (runningChild) killTree(runningChild);
  releaseSlot();
  removeGateTemp(); // ending by the signal below fires no 'exit' on POSIX
  if (process.platform === 'win32') process.exit(3221225786);
  process.removeAllListeners(sig);
  process.kill(process.pid, sig);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  try {
    process.on(sig, () => onSignal(sig));
  } catch {
    /* a signal this platform does not have */
  }
}

if (precheck) process.exit(await precheckMode());

// ---- --precheck: the cheapest checks first, stop at the first red one (lib/gatePrecheck.js) ----------------------------

/** git in the gate folder; stdout, or null when the command failed. */
function git(...a) {
  const r = spawnSync('git', ['-C', cwd, ...a], { encoding: 'utf8', maxBuffer: 64 << 20 });
  return r.status === 0 ? r.stdout : null;
}

/** Lines of git output (paths with "/"), or [] for null. */
function lines(s) {
  if (s == null) return [];
  return s
    .split(/\r?\n/)
    .map((l) => l.trim().split('\\').join('/'))
    .filter(Boolean);
}

/**
 * The changed files against the base branch, relative to the gate folder: committed since the fork point (merge-base
 * of HEAD and the base), staged, unstaged and untracked (not ignored). Deleted files are left out (nothing to check).
 * --track-base/--track-tip (the merge step's arguments, lib/trackDiff.js) give a merged track's own diff instead.
 * Returns { base, files } or { error }.
 */
function changedFiles() {
  const wanted = option('--base') || K.baseBranch;
  const candidates = [wanted, `${K.remote}/${wanted}`];
  const ref = candidates.find((c) => git('rev-parse', '--verify', '--quiet', `${c}^{commit}`) != null);
  if (!ref) return { error: `the base branch ${wanted} was not found (also not ${K.remote}/${wanted}); use --base <ref>` };
  const fork = (git('merge-base', 'HEAD', ref) || '').trim();
  if (!fork) return { error: `no merge base between HEAD and ${ref}` };
  const tracked = git('diff', '--name-only', '--relative', '--diff-filter=d', fork);
  const untracked = git('ls-files', '--others', '--exclude-standard');
  if (tracked == null || untracked == null) return { error: 'git diff failed in the gate folder' };
  let files = [...new Set([...lines(tracked), ...lines(untracked)])];
  const trackBase = option('--track-base');
  if (trackBase) {
    const own = require('./lib/trackDiff.js').trackChangedFiles({
      git: (...a) => git(...a),
      trackBase,
      trackTip: option('--track-tip'),
      changed: files,
    });
    if (own == null) return { error: `git diff ${trackBase}... failed` };
    files = lines(own.join('\n'));
  }
  return { base: ref, files: files.filter((f) => fs.existsSync(path.join(cwd, f))).sort() };
}

/** Ends a process and its children (a shell starts the real tool as a child; on Windows taskkill /T takes the tree). */
function killTree(child) {
  try {
    if (process.platform === 'win32')
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // already gone
    }
  }
}

/**
 * Runs one shell command, with a time limit when `timeoutMs` is given. Resolves to { status, out, timedOut }.
 * Async, so the event loop stays free for the memory sampling and the signal handlers.
 */
function runShell(command, { timeoutMs = null } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let timedOut = false;
    let full = false;
    let grace = null;
    let timer = null;
    let settled = false;
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: process.platform !== 'win32', // its own process group, so the whole tree can be ended
      env: gateCommandEnv(), // scrubbed (lib/gateEnv.js): the check runs the track's code. With its own temp folder (lib/gateTemp.js)
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'], // no stdin: a command that reads it gets end of file instead of hanging
    });
    runningChild = child;
    const finish = (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      runningChild = null;
      resolve({ status, out, timedOut });
    };
    const add = (d) => {
      if (full) return;
      out += d;
      if (out.length <= MAX_OUTPUT) return;
      full = true;
      out += `\n(stopped: more than ${MAX_OUTPUT >> 20} MB of output)`;
      killTree(child);
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', add);
    child.stderr.on('data', add);
    if (timeoutMs != null)
      timer = setTimeout(() => {
        timedOut = true;
        killTree(child);
        // A process outside the tree can keep the pipes open: the run must still end.
        grace = setTimeout(() => {
          child.stdout.destroy();
          child.stderr.destroy();
          finish(null);
        }, 5000);
      }, Math.max(1, timeoutMs));
    child.on('error', (e) => add(`\n${e.message}`));
    child.on('close', (status) => finish(status));
  });
}

/** One precheck command: runShell, and the output in the --log file. */
async function runCommand(command, { timeoutMs }) {
  const r = await runShell(command, { timeoutMs });
  if (logFile) fs.appendFileSync(logFile, `\n===== ${command} (exit ${r.status ?? 'unknown'}${r.timedOut ? ', timeout' : ''}) =====\n${r.out}`);
  return r;
}

/** --precheck. Exit 0 green (or nothing to check), 1 red, 3 a check over its time budget, 2 setup error. */
async function precheckMode() {
  const P = require('./lib/gatePrecheck.js');
  const json = args.includes('--json');
  const exists = (rel) => fs.existsSync(path.join(cwd, rel)) || fs.existsSync(path.join(K.root, rel));
  const checks = P.checksFrom(K.gates, exists);
  const ch = changedFiles();
  if (ch.error) {
    if (json) console.log(JSON.stringify({ ok: false, status: 'ERROR', error: ch.error }));
    else console.error(`precheck: ${ch.error}`);
    return 2;
  }
  if (logFile) fs.writeFileSync(logFile, `gates --precheck in ${cwd} against ${ch.base}\n${ch.files.join('\n')}\n`);
  const t0 = Date.now();
  const r = await P.runPrecheck({ checks, changed: ch.files, run: runCommand, root: cwd });
  const totalSec = (Date.now() - t0) / 1000;
  const exit = r.ok ? 0 : r.status === 'TIMEOUT' ? 3 : 1;
  const ran = r.results.filter((x) => ['GREEN', 'RED', 'TIMEOUT'].includes(x.status));
  logRun({
    kind: 'precheck',
    ran: ran.map((x) => x.name),
    failed: ran.filter((x) => x.status !== 'GREEN').map((x) => x.name),
    durationSec: totalSec,
    exit,
    timedOut: r.status === 'TIMEOUT',
  });
  if (json)
    console.log(
      JSON.stringify(
        { ok: r.ok, status: r.status, stoppedAt: r.stoppedAt, base: ch.base, changed: ch.files, totalSec, checks: r.results },
        null,
        2,
      ),
    );
  else {
    for (const l of P.precheckLines(r, { changedCount: ch.files.length, base: ch.base, totalSec })) console.log(l);
    if (!r.ok && logFile) console.log(`full log: ${logFile}`);
  }
  return exit;
}

// ---- --quick / --full ---------------------------------------------------------------------------------------------------
const mode = quick ? 'quick' : 'full';
const gates = (Array.isArray(K.gates?.[mode]) ? K.gates[mode] : []).filter(
  (g) => typeof g === 'string' && g.trim(),
);
if (gates.length === 0) {
  console.log('no gates set up in queue.config.json');
  process.exit(0);
}

// ---- The gate queue and the memory sampling (lib/gateQueue.js, lib/gateLoad.js) ----
const GL = require('./lib/gateLoad.js');
const LS = require('./lib/loadSlots.js');
/** The time log's text, or null when there is none yet. */
function timeLogText() {
  try {
    return fs.readFileSync(timeLog(), 'utf8');
  } catch {
    return null;
  }
}

/** The load guard's limit in effect (the queue's own value wins, as for fill), or null when off or unknown. */
function loadLimit() {
  try {
    const { dataFolder } = require('./lib/queueConfig.js');
    let queue = null;
    try {
      queue = JSON.parse(fs.readFileSync(path.join(dataFolder(), 'queue.json'), 'utf8'));
    } catch {
      queue = null; // no queue yet: the config's value
    }
    return require('./lib/logic/guards.js').minFreeMemoryFor(queue);
  } catch {
    return null;
  }
}

// Waiting comes first: everything below binds this run to the state when its commands start, not when it was asked for.
const QUEUE_SETUP = GQ.setupFrom(K);
let waitSec = null;
if (GQ.needsSlot({ setup: QUEUE_SETUP, kind: mode, lastSec: GQ.lastDurationSec(timeLogText(), mode) })) {
  const branchNow = (git('rev-parse', '--abbrev-ref', 'HEAD') || '').trim() || null;
  const got = await GQ.acquireWait({
    root: QUEUE_SETUP.root,
    slots: QUEUE_SETUP.slots,
    who: { project: K.projectName ?? path.basename(K.root), kind: mode, track: option('--track') ?? TL.trackFromBranch(branchNow, K.branchPrefix) },
    onWait: (holders) => console.log(GQ.waitLine(holders, { slots: QUEUE_SETUP.slots })),
  });
  slot = got.slot;
  waitSec = got.waitSec;
  if (got.failedOpen) console.log(`GATE QUEUE: ${QUEUE_SETUP.root} cannot be used, so this run goes without the queue.`);
  if (waitSec >= 1) START = startState();
}

// The evidence lock (red team RT-03, __tests__/redteam/rt03-two-sessions.test.ts). The tamper check compares the whole
// store before and after the run, so a second run of this project recording evidence at the same time (a second session,
// or two tracks received at once, both quick enough to skip the gate queue) read as tampering: both runs went red and
// receive stopped for the owner. One recording run per store at a time, the slot mechanism of the gate queue (a dead
// holder is taken over). A nested run (a gate command that runs gates.mjs) never waits for the lock its parent holds.
// Fail open as the gate queue: a lock folder that cannot be used means the old behaviour, never a stuck gate.
let evidenceSlot = null;
process.on('exit', () => {
  if (evidenceSlot) GQ.release(evidenceSlot);
});
if (evidenceWanted().wanted && evidenceFile() && process.env.QUEUE_EVIDENCE_LOCK !== 'held') {
  const branchNow = (git('rev-parse', '--abbrev-ref', 'HEAD') || '').trim() || null;
  const got = await GQ.acquireWait({
    root: `${evidenceFile()}.lock`,
    slots: 1,
    pollMs: 250,
    who: { project: K.projectName ?? path.basename(K.root), kind: mode, track: option('--track') ?? TL.trackFromBranch(branchNow, K.branchPrefix) },
    onWait: (holders) =>
      console.log(
        `EVIDENCE: another gate run of this project is recording evidence (${holders.map((h) => `${h.track ?? h.kind ?? '?'}, pid ${h.pid ?? '?'}`).join('; ')}); ` +
          'this run waits for it, so neither reads the other as tampering. The time budget starts when this check starts.',
      ),
  });
  evidenceSlot = got.slot;
  if (got.waitSec >= 1) START = startState();
}

if (logFile) fs.writeFileSync(logFile, `gates --${mode} in ${cwd}\n`);
// Before the first gate command: does this run record evidence, and the store's text for the tamper check.
const WANT = evidenceWanted();
const BEFORE = evidenceBefore(WANT);
const COVERAGE = coverageNow(WANT);
// The hooks and the executing config, also for a track's own run: what is planted in the shared .git reaches every run.
const GX = require('./lib/gitExecSurface.js');
const GB = require('./lib/gitSurfaceBaseline.js');
const SURFACE_FOLDER = evidenceFile() ? path.dirname(evidenceFile()) : null;
const SURFACE = GB.watch(SURFACE_FOLDER, cwd);
const width = Math.min(60, Math.max(...gates.map((g) => g.length)) + 2);
const start = Date.now();
let failedCount = 0;
const failedGates = [];

// --timeout-sec <n>: one time budget for the whole list (ravenseat receive and merge always pass config().baseGate.timeoutSec,
// so a hanging gate cannot hold them forever). Each gate gets what is left; a gate over
// it is red. As for the done command, on Windows a child the shell started can live on until it ends by itself.
const budgetSec = Number(option('--timeout-sec'));
const deadline = GQ.budgetDeadline(start, budgetSec);
let timedOutAny = false;

// The lowest free memory during the run, with the load guard's own measure and macOS exception (lib/gateLoad.js).
const LOAD_LIMIT = loadLimit();
const sampler = GL.samplingOn({ limit: LOAD_LIMIT, overridden: !!process.env.QUEUE_LOAD }) ? GL.startSampler({ measure: () => LS.measure() }) : null;

for (const command of gates) {
  const t0 = Date.now();
  const r = await runShell(command, { timeoutMs: deadline ? Math.max(1000, deadline - t0) : null });
  const sec = (Date.now() - t0) / 1000;
  const timedOut = r.timedOut;
  if (timedOut) timedOutAny = true;
  const out = `${r.out}${timedOut ? `\n(stopped after the time budget of ${budgetSec} s: --timeout-sec)` : ''}`;
  const green = r.status === 0 && !timedOut;
  if (!green) {
    failedCount++;
    failedGates.push(command);
  }
  console.log(
    resultLine(
      {
        name: command,
        status: green ? 'GREEN' : 'RED',
        sec,
        first: green ? '' : firstErrorLine(gateType(command), out, cwd),
      },
      width,
    ),
  );
  if (logFile)
    fs.appendFileSync(logFile, `\n===== ${command} (exit ${r.status ?? 'unknown'}, ${Math.round(sec)} s) =====\n${out}`);
}

const total = Math.round((Date.now() - start) / 1000);
const minFreeMemoryPct = sampler ? sampler.stop() : null;
// The commands are done: the next heavy run can start while this process does its bookkeeping.
releaseSlot();
// Every gate command has exited: did one of them change what runs at the next git command (lib/gitExecSurface.js)?
const surfaceChange = SURFACE.finish({ drift: WANT.wanted });
// Only now does this process (the orchestrator's side) record the evidence.
const recorded = recordEvidence({
  kind: mode,
  ran: gates,
  failed: failedGates,
  exit: failedCount === 0 ? 0 : 1,
  timedOut: timedOutAny,
  want: WANT,
  before: BEFORE,
  coverage: COVERAGE,
  tamperReason: surfaceChange,
});
// The store or the git surface changed while the gate commands ran: the run is red whatever the gates said.
const exitCode = failedCount === 0 && !recorded.tampered && !surfaceChange ? 0 : 1;
logRun({
  kind: mode,
  ran: gates,
  failed: failedGates,
  durationSec: (Date.now() - start) / 1000,
  exit: exitCode,
  timedOut: timedOutAny,
  waitSec,
  minFreeMemoryPct,
});
// Probably load, not the code. Only a remark: the exit code above is already decided and stays as it is.
const loadRemark = GL.loadLine({ red: failedCount > 0 || timedOutAny, minFreePct: minFreeMemoryPct, limitPct: LOAD_LIMIT });
if (loadRemark) {
  console.log(loadRemark);
  // In the log too: ravenseat receive and ravenseat merge take the fix brief and the base report from the log's tail.
  if (logFile) fs.appendFileSync(logFile, `\n${loadRemark}\n`);
}
if (recorded.covered) console.log(`Evidence for ${String(START.sha).slice(0, 12)}: ${recorded.covered}.`);
if (surfaceChange) {
  // Nothing happened during the run: the plain message for someone who may simply have installed a hook tool.
  const detail = GB.isDriftOnly(surfaceChange) ? GB.driftDetail(SURFACE_FOLDER, cwd) : null;
  const text = detail
    ? `RED (${total} s). ${GB.driftMessage({ ...detail, afterRun: true, ravenseat: require('./lib/projectRoot.js').cliCommand() })}`
    : `RED: ${recorded.reason ?? surfaceChange}. ${GX.INSPECT} (${total} s)`;
  // In the log too: ravenseat receive and ravenseat merge take the fix brief and the base report from the log's tail.
  if (logFile) fs.appendFileSync(logFile, `\n${text}\n`);
  console.log(`${text}${logFile ? `, full log: ${logFile}` : ''}`);
} else if (recorded.tampered)
  console.log(
    `RED: the gate evidence store changed while the gate commands ran (a gate wrote to it); the change was dropped and ` +
      `the run recorded as red (tampered) (${total} s)${logFile ? `, full log: ${logFile}` : ''}`,
  );
else
  console.log(
    failedCount === 0
      ? `ALL GREEN: ${gates.length} gate(s) --${mode} in ${total} s`
      : `RED: ${failedCount} of ${gates.length} gate(s) --${mode} failed (${total} s)${logFile ? `, full log: ${logFile}` : ''}`,
  );
process.exit(exitCode);
