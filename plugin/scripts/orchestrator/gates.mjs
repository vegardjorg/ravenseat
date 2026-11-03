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
//   --timeout-sec <n>  (--quick/--full) one time budget for the whole list; a gate over it is red (cq merge passes the
//                 base gate's budget when the quick gates are the base gate, lib/baseHealth.js).
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
// run of this kind for the task), so reruns can be counted. The task is --track <id> (cq merge passes it) or the branch
// <branchPrefix><id>, otherwise null. The row also has the HEAD commit (`sha`) and `clean` (no uncommitted tracked
// changes) from the start of the run. The row format lives in lib/timeLogRows.js. Writing it never changes the result
// or the exit code (fail open). The time log row is MEASUREMENT ONLY: every agent can append to that file.
//
// Gate evidence (lib/gateEvidence.js): what cq receive, cq merge (the base gate's skip rule) and the push check rely on.
// A --quick/--full run records one entry in <dataFolder>/gate-evidence.json (sha, clean, the commands, green or red) only
// when the orchestrator's side runs it: with --evidence (cq receive and cq merge pass it) or in the MAIN checkout (not a
// linked worktree; the full gate before a batch push). A track's own run in its worktree is never evidence.
// Who writes it: THIS process, the orchestrator's side, and only after every gate command has exited. The gate commands
// load the track's code, so they run as child processes that only report an exit code; they get a scrubbed environment
// (lib/gateEnv.js: no tokens or cloud keys, no variable that points to the data folder or the store) and never the
// store's path on their command line. The entry carries `writer: "orchestrator"` and the `setup_hash` of the configured
// gates. The store's text is read before the first command and compared after the last one; a change during the run
// (a gate command wrote to it) is dropped and the run is recorded RED with `tampered: true` (lib/gateEvidence.js
// recordRun), printed on stderr, and the exit code is 1. This is no OS isolation: see the limits in lib/gateEnv.js.
//   --evidence  record evidence also outside the main checkout (the push guard denies it to queue agents).
//   --cwd <folder>  run in that folder (cq receive: the track's worktree).
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

/** Is `path` the project root or a worktree of the project (<root>/.claude/worktrees/<name>/...)? */
function inProject(filePath) {
  const rel = path.relative(K.root, filePath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
// --cwd <folder>: run there (cq receive runs the quick gate in the track's worktree, which need not be under the root).
const cwd = option('--cwd') ? path.resolve(option('--cwd')) : inProject(process.cwd()) ? process.cwd() : K.root;

/**
 * Appends this run's `gate` row to the time log (lib/timeLogRows.js). Fail open: every error is swallowed, so the log
 * can never change the gate's result or exit code.
 */
function logRun({ kind, ran, failed, durationSec, exit, timedOut = false }) {
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
      TL.gateRow({ track, branch, kind, gates: ran, failed, durationSec, exit, timedOut, attempt, sha, clean: START.clean }),
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
const START = startState();

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
  const file = evidenceFile();
  const folder = file ? path.dirname(file) : null;
  // The data folder itself only when it is not the project root (then every variable naming the root would go too).
  const storePaths = [file, folder && path.resolve(folder) !== path.resolve(K.root) ? folder : null].filter(Boolean);
  return require('./lib/gateEnv.js').gateEnv(process.env, { storePaths }).env;
}
const CHILD_ENV = childEnvironment();

/**
 * Does this run record evidence? Only when the orchestrator's side runs it: --evidence (cq receive, cq merge) or a run
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
 * `before` is the store's text from before the run; a change during the run makes the entry red (tampered).
 * Fail open: a write error only means no evidence, so the caller runs the gate again or asks.
 * @returns {{ recorded: boolean, tampered: boolean }}
 */
function recordEvidence({ kind, ran, failed, exit, timedOut = false, want, before }) {
  try {
    if (!want?.wanted) return { recorded: false, tampered: false };
    const GE = require('./lib/gateEvidence.js');
    const file = evidenceFile();
    if (!file) return { recorded: false, tampered: false };
    const sha = START.sha && (git('rev-parse', 'HEAD') || '').trim() === START.sha ? START.sha : null;
    const branch = (git('rev-parse', '--abbrev-ref', 'HEAD') || '').trim() || null;
    const track = option('--track') ?? TL.trackFromBranch(branch, K.branchPrefix);
    return GE.recordRun({
      file,
      before: before ?? null,
      entry: GE.entry({
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
      }),
    });
  } catch {
    // error-ignored: no evidence is the safe direction (receive runs the gate again, the push check asks)
    return { recorded: false, tampered: false };
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

/** Runs one shell command with a time limit. Resolves to { status, out, timedOut }. */
function runCommand(command, { timeoutMs }) {
  return new Promise((resolve) => {
    let out = '';
    let timedOut = false;
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: process.platform !== 'win32', // its own process group, so the whole tree can be ended
      env: CHILD_ENV, // scrubbed (lib/gateEnv.js): the check runs the track's code
      windowsHide: true,
    });
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, Math.max(1, timeoutMs));
    child.on('error', (e) => (out += `\n${e.message}`));
    child.on('close', (status) => {
      clearTimeout(timer);
      if (logFile) fs.appendFileSync(logFile, `\n===== ${command} (exit ${status ?? 'unknown'}${timedOut ? ', timeout' : ''}) =====\n${out}`);
      resolve({ status, out, timedOut });
    });
  });
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

if (logFile) fs.writeFileSync(logFile, `gates --${mode} in ${cwd}\n`);
// Before the first gate command: does this run record evidence, and the store's text for the tamper check.
const WANT = evidenceWanted();
const BEFORE = evidenceBefore(WANT);
const width = Math.min(60, Math.max(...gates.map((g) => g.length)) + 2);
const start = Date.now();
let failedCount = 0;
const failedGates = [];

// --timeout-sec <n>: one time budget for the whole list (cq merge passes config().baseGate.timeoutSec when the quick
// gates are the base gate, so a hanging gate cannot hold the merge forever). Each gate gets what is left; a gate over
// it is red. As for the done command, on Windows a child the shell started can live on until it ends by itself.
const budgetSec = Number(option('--timeout-sec'));
const deadline = budgetSec > 0 ? start + budgetSec * 1000 : null;
let timedOutAny = false;

for (const command of gates) {
  const t0 = Date.now();
  const r = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    maxBuffer: 256 << 20,
    env: CHILD_ENV, // scrubbed (lib/gateEnv.js): the gate runs the track's code
    ...(deadline ? { timeout: Math.max(1000, deadline - t0) } : {}),
  });
  const sec = (Date.now() - t0) / 1000;
  const timedOut = r.error?.code === 'ETIMEDOUT';
  if (timedOut) timedOutAny = true;
  const out =
    `${r.stdout || ''}${r.stderr || ''}${r.error ? `\n${r.error.message}` : ''}` +
    (timedOut ? `\n(stopped after the time budget of ${budgetSec} s: --timeout-sec)` : '');
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
// Every gate command has exited: only now does this process (the orchestrator's side) record the evidence.
const recorded = recordEvidence({
  kind: mode,
  ran: gates,
  failed: failedGates,
  exit: failedCount === 0 ? 0 : 1,
  timedOut: timedOutAny,
  want: WANT,
  before: BEFORE,
});
// The store changed while the gate commands ran: the run is red whatever the gates said (lib/gateEvidence.js recordRun).
const exitCode = failedCount === 0 && !recorded.tampered ? 0 : 1;
logRun({
  kind: mode,
  ran: gates,
  failed: failedGates,
  durationSec: (Date.now() - start) / 1000,
  exit: exitCode,
  timedOut: timedOutAny,
});
if (recorded.tampered)
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
