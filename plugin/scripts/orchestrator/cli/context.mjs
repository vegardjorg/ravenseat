// =============================================================
// cli/context.mjs: the shared state of the queue CLI (queue.mjs and the command modules in cli/).
//
// The libraries (L = lib/queueLogic.js and the other one- and two-letter aliases), the project settings (CONFIG, BASE,
// the migration flow), the paths (the data folder, queue.json, the lock, the cursor, the plan register), the parsed
// arguments (a, command, val, values, positional) and the helpers every command uses: git, read, write, edit and
// editLogged under the file lock (the owner token and the takeover rule: lib/queueLock.js), die (releases the lock), the
// orchestrator cursor and the auto-accept of proposals.
// It imports no other cli/ module, so the command modules can all import it without a cycle. `require` is made
// relative to queue.mjs, so `require('./lib/...')` means the same in every module as it did in the single file.
//
// Why a module: queue.mjs was one file of about 6,300 lines. It is now a thin entry point (the usage comment and the
// dispatch on the command word) plus the modules in cli/. The code was moved as it was: same output, exit codes and files.
//
// Used by: queue.mjs and every module in cli/.
// Tested in: every test that spawns queue.mjs (plugin/scripts/orchestrator/lib/__tests__/ and __tests__/).
// =============================================================

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Relative to queue.mjs (one folder up), so require('./lib/...') resolves as it did in the single file.
export const require = createRequire(new URL('../queue.mjs', import.meta.url));
export const L = require('./lib/queueLogic.js');
export const KV = require('./lib/contextGuard.js');
export const TK = require('./lib/timeCost.js');
export const G = require('./lib/queueGit.js');
export const D = require('./lib/queueDiagnose.js');
export const P = require('./lib/queuePlan.js');
export const S = require('./lib/queueStatistics.js');
export const CH = require('./lib/queueCapacity.js');
export const KK = require('./lib/queueConfig.js');
export const HELP = require('./lib/queueHelpers.js');
export const HO = require('./lib/queueHandover.js');
export const F = require('./lib/queueFollow.js');
// The forecast (`forecast`) and auto-accept of proposals (`proposals`, add, orchestrator pulse).
export const FC = require('./lib/queueForecast.js');
export const PR = require('./lib/queueProposals.js');
const MG = require('./lib/mergeGuard.js');
// The owner of the lock in withLock: the token, the takeover rule and the atomic takeover.
const QL = require('./lib/queueLock.js');
// The safe write of queue.json (queue.json.prev and the rename retry) and the recovery hint.
export const SF = require('./lib/stateFile.js');
// The optional `fixes` field: the task(s) a fix task fixes (add, edit, info, state).
export const FX = require('./lib/fixLinks.js');
// Calibrated cost estimates (~$ in show, next, fill, info, state), `calibrate`, and USD per merged change (`cost`).
export const CE = require('./lib/costEstimate.js');
// Lite mode ("mode": "lite"): quick add with only a title, no small-task guard or batch queue on add, `ravenseat mode`.
export const LM = require('./lib/liteMode.js');
// Load-aware slots: the measurement (free memory, optional CPU) for the load guard and the adaptive slot count.
export const LS = require('./lib/loadSlots.js');
// The project's settings (queue.config.json merged with the defaults in lib/queueConfig.js).
export const CONFIG = KK.config();
// queue.config.json exists but does not parse: stop instead of running on the defaults (H3). `doctor` still runs (it
// names the error with a fix hint) and so does `help`.
if (!['doctor', 'help', '--help', '-h'].includes(process.argv[2])) KK.stopIfConfigUnreadable(CONFIG);
// The integration branch everything is merged into (often main), the remote and the branch prefix for queue tasks.
export const BASE = CONFIG.baseBranch;
export const REMOTE = CONFIG.remote;
export const PREFIX = CONFIG.branchPrefix ?? 'queue/';
/** Branch for a queue task: <branchPrefix><id>. */
export const branchFor = (id) => `${PREFIX}${id}`;
// The optional migration flow (folder null = off: no number blocks and no push in merge).
export const MIGR = CONFIG.migrations ?? { folder: null };
// The folder of the orchestrator scripts. Sibling scripts are started from here, not from the project, because in a
// plugin install the scripts live outside the project.
export const HERE = path.dirname(fileURLToPath(new URL('../queue.mjs', import.meta.url)));
// ROOT = the tree we run in (a worktree for a track); MAIN_TREE = the main tree, where the queue ALWAYS lives, otherwise
// each track would get its own empty queue. Both come from lib/projectRoot.js. QUEUE_FOLDER overrides (tests).
export const { tree: ROOT, main: MAIN_TREE } = require('./lib/projectRoot.js').roots();
// The command to write in hints: `ravenseat` (plugin) or `node scripts/orchestrator/ravenseat.mjs` (vendored install).
export const CLI = require('./lib/projectRoot.js').cliCommand();
export const FOLDER = KK.dataFolder();
export const FILE = path.join(FOLDER, 'queue.json');
export const LOCK = path.join(FOLDER, '.lockState');
// The "Follow up" entries (queue.mjs follow; the rules in lib/queueFollow.js) and their reports.
export const FOLLOW_FILE = path.join(FOLDER, 'follow.json');
export const FOLLOW_REPORTS = path.join(FOLDER, 'follow');
// The time log with the usage per agent (hook-time.mjs writes it). QUEUE_TIME_LOG overrides (tests).
export const TIME_LOG = KK.timeLog();
// The repo the queue branches are counted in (pick, release, show). QUEUE_GIT overrides (smoke test against a temporary repo).
export const GIT_ROOT = process.env.QUEUE_GIT ?? MAIN_TREE;
export const a = process.argv.slice(2);
export const command = a[0];
export const val = (name) => {
  const i = a.indexOf(name);
  return i >= 0 ? a[i + 1] : undefined;
};
// All the values after a flag, up to the next flag (`--prefix A- B-`); the flag can also be repeated.
export const values = (name) => {
  const out = [];
  a.forEach((x, i) => {
    if (x !== name) return;
    for (let j = i + 1; j < a.length && !a[j].startsWith('--'); j++) out.push(a[j]);
  });
  return out;
};
// The positional arguments after the command, without flags and flag values (the flags with a value are listed in `withValue`).
export const positional = (from, withValue = []) =>
  a.slice(from).filter((x, i, arr) => !x.startsWith('--') && !withValue.includes(arr[i - 1]));
// Width of the terminal (narrow window: shorter titles). Outside a terminal (a pipe, a log, the Bash tool of an agent)
// nothing is cut: there is no window to fit, and a cut line can lose the command the reader was told to run.
export const WIDTH = process.stdout.isTTY ? Math.max(60, Math.min(process.stdout.columns || 110, 160)) : Infinity;
export const cut = (s, n) => {
  const t = String(s ?? '');
  return n <= 1 ? '' : t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
// ---- Git (the queue branches) --------------------------------------------------------------------------------
// core.quotepath=off: a path with non-ASCII characters comes out as it is, not quoted (review 2026-11-11, S1).
export function git(args) {
  try {
    return execFileSync('git', ['-c', 'core.quotepath=off', ...args], {
      cwd: GIT_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}
/** Does the branch exist, how many commits is it ahead of baseBranch, and when was the last one? */
export function branchInfo(branch) {
  if (git(['rev-parse', '-q', '--verify', `refs/heads/${branch}`]) == null)
    return { exists: false, commits: 0, lastCommit: null };
  const commits = Number(git(['rev-list', '--count', `${BASE}..${branch}`]) ?? 0) || 0;
  const lastCommit = commits > 0 ? git(['log', '-1', '--format=%cI', branch]) : null;
  return { exists: true, commits, lastCommit };
}
/** The mission file (absolute path) when `mission` is a path that exists in the worktree or the main tree, otherwise null. */
export function missionFile(o) {
  const s = String(o.mission ?? '');
  if (!s || s.includes('\n')) return null;
  for (const root of [ROOT, MAIN_TREE]) {
    const filePath = path.resolve(root, s);
    try {
      if (fs.statSync(filePath).isFile()) return filePath;
    } catch {
      /* does not exist here */
    }
  }
  return null;
}
/** The mission text of a task to be packed: the file (worktree or main tree), otherwise the text in the queue file. */
export function readMission(o) {
  const s = String(o.mission ?? '');
  const file = missionFile(o);
  if (file) return { text: fs.readFileSync(file, 'utf8'), path: s };
  if (!s.includes('\n') && /\.md$/i.test(s.trim()))
    return { error: `${o.id}: could not find the mission file ${s}` };
  return { text: s, path: null };
}
/** The `mission` field for a new mission file: relative to the main tree (<dataFolder>/mission/<id>.md), otherwise absolute. */
export function missionRef(file) {
  const rel = path.relative(MAIN_TREE, file);
  return (rel.startsWith('..') || path.isAbsolute(rel) ? file : rel).replace(/\\/g, '/');
}
// ---- Work outside the queue and the orchestrator cursor ------------------------------------------------
// Read-only, with --no-optional-locks (queueGit.js): a scan never takes index.lock from a session that is committing.
export const gitRead = G.makeGit(GIT_ROOT);
/** The paths `git status` shows in the main tree. If they cannot be read, that is reported, and nothing is skipped. */
export function uncommittedPaths() {
  const u = G.readUncommitted(gitRead);
  if (u == null) {
    console.error(
      'WARNING: could not read git status in the main tree; uncommitted files are not checked.',
    );
    return [];
  }
  return u.map((x) => x.path);
}
// The cursor for "orchestrator active" lives next to the queue file (gitignored), as a file of its own.
export const CURSOR = path.join(FOLDER, 'orchestrator.json');
export function readCursor() {
  try {
    return JSON.parse(fs.readFileSync(CURSOR, 'utf8'));
  } catch {
    return null;
  }
}
/** Updates the cursor (session name: --session, otherwise QUEUE_SESSION, otherwise the previous). An error never stops the queue. */
export function pulseCursor(event) {
  try {
    fs.mkdirSync(FOLDER, { recursive: true });
    const m = L.newCursor(readCursor(), { session: val('--session') ?? process.env.QUEUE_SESSION, event });
    const tmp = `${CURSOR}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n');
    fs.renameSync(tmp, CURSOR);
    return m;
  } catch {
    return null;
  }
}
/** Prints the warning for `start`/`pick` when the owned files have changed outside the queue since the task was added. */
export function writeExternalWarning(o) {
  const v = G.externalForTasks(gitRead, [o]).get(o.id);
  if (!v) return;
  if (v.collisions.length) {
    console.log(
      `WARNING: ${v.collisions.length} change(s) in the owned files outside the queue since ${o.id} was added. ` +
        'The track file gets the warning (ravenseat trackFile), so the track reads the diff before it builds:',
    );
    for (const k of v.collisions.slice(0, 5))
      console.log(`  ${L.collisionText(k, { withId: false })}`);
    if (v.collisions.length > 5)
      console.log(`  ... and ${v.collisions.length - 5} more (ravenseat external --all)`);
  }
  if (v.mentioned.length)
    console.log(
      `NOTE: commits outside the queue mention ${o.id}; is it already completed? (ravenseat external accept ${o.id} <sha>): ` +
        v.mentioned
          .slice(0, 3)
          .map((c) => `${c.summary} "${c.subject.slice(0, 50)}"`)
          .join(', '),
    );
}
// The token of the lock this process holds (null: none). Set by withLock, cleared by releaseLock.
let held = null;
let releaseOnExit = false;
/** Gives the lock back if this process still owns it. A lock another process has taken is left alone (lib/queueLock.js). */
function releaseLock() {
  if (!held) return;
  const me = held;
  held = null;
  QL.release(LOCK, me);
}
// Always false, on purpose. Command modules (planShared, projects, taskEdit) have `if (hasLock) fs.rmSync(LOCK, ...)`
// before their process.exit on a --json error. That removal has no owner check, so it must never run: the 'exit' handler
// withLock registers does the release, with the check, for those exits and every other one. They can drop the line.
export const hasLock = false;
// process.exit skips finally blocks: the 'exit' handler releases the lock, otherwise it would stop all other calls
// (e.g. "cannot be started" inside the lock would otherwise block the queue). A lost lock is not removed.
export const die = (message, code = 1) => {
  console.error(message);
  releaseLock();
  process.exit(code);
};
/**
 * The id in the queue branch this worktree is on (<branchPrefix><id>), or null: the main tree, another branch, or no git.
 * This is how the queue knows that a command comes from a track, and which one, without taking the track's word for it.
 */
export function queueBranchId() {
  if (ROOT === MAIN_TREE) return null;
  try {
    const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return branch.startsWith(PREFIX) && branch !== PREFIX ? branch.slice(PREFIX.length) : null;
  } catch {
    return null;
  }
}

// ---- Lock and storage --------------------------------------------------------------------------------------
export function withLock(fn) {
  fs.mkdirSync(FOLDER, { recursive: true });
  const got = QL.acquire(LOCK, { waitMs: QL.waitMsFrom(process.env.QUEUE_LOCK_WAIT_MS) });
  if (!got.ok) die(QL.heldMessage({ folder: FOLDER, ravenseat: CLI, ...got }));
  held = got.me;
  if (!releaseOnExit) {
    releaseOnExit = true;
    process.on('exit', releaseLock);
  }
  try {
    return fn();
  } finally {
    if (held && !QL.isHeld(LOCK, held))
      console.error(`WARNING: this command lost the lock on ${FOLDER} while it ran; the lock was left to its new holder.`);
    releaseLock();
  }
}
/**
 * Stops the command if it holds the lock no more (taken over, or released with ravenseat unlock): it must not publish.
 * The gap between this check and the rename: on one machine it is closed by the rule in lib/queueLock.js, not by the
 * check, because a live holder is never taken over, so a holder that gets here and still lives keeps the lock through
 * the rename. (Only the owner's ravenseat unlock --force breaks that, on the owner's word.) For a holder on another host the
 * age rule still applies: a holder pausing right here past 60 s can publish after losing the lock. The check only makes
 * that window small; a data folder shared across machines would need a lease or a real database to close it.
 */
function stopIfLockLost(what) {
  if (held && !QL.isHeld(LOCK, held))
    die(
      `Lost the lock on ${FOLDER} before writing ${what}: another process took it over or the owner released it. ` +
        'Nothing was written, and the lock was left to its new holder. Run the command again.',
    );
}
export function read() {
  if (!fs.existsSync(FILE)) die(`The queue does not exist. Run: ${CLI} init`);
  const text = fs.readFileSync(FILE, 'utf8');
  try {
    return JSON.parse(text);
  } catch (e) {
    // A broken queue.json: stop with the error and, when queue.json.prev parses, how to get the last good state back
    // (lib/stateFile.js). The queue never restores it by itself.
    const hint = SF.recoveryHint(FILE);
    return die(
      `queue.json does not parse (${FILE}): ${e?.message ?? e}\n` +
        (hint ? `  ${hint}` : `  No good copy at ${SF.prevPath(FILE)}; restore it from queue.json.*.tmp or a backup.`),
    );
  }
}
// The short diagnosis paragraph when parallelism is low (fill, receive, orchestrator pulse). Reads the queue
// again, so tracks that were just started or received are counted. Prints nothing when parallelism is not low, and an
// error in the diagnosis never stops the command it is attached to.
export function parallelWarning() {
  try {
    for (const l of D.diagnoseLines(D.parallelDiagnose(read()))) console.log(l);
  } catch (e) {
    console.log(`(The queue diagnosis failed: ${e?.message ?? e}. Run ravenseat diagnose.)`);
  }
}
// The write keeps queue.json.prev (the previous good state) and retries the rename on Windows EPERM/EBUSY/EACCES
// (lib/stateFile.js writeState).
//
// The owner log (lib/ownerLog.js, owner decision B2): the owner rows this write adds (in `queue`, not in the file on
// disk just before, read here under the lock) are recorded, so receive and merge can tell them from a row written into
// queue.json some other way. A write from a track worktree records nothing. Never stops the write.
export function write(queue) {
  stopIfLockLost('queue.json');
  queue.changed = new Date().toISOString();
  const before = ownerKeysOnDisk();
  SF.writeState(FILE, JSON.stringify(queue, null, 2) + '\n', { snapshots: SNAPSHOT_TIERS });
  if (before) OL.recordWrite(FOLDER, { before, after: queue, inTrack: queueBranchId() !== null });
}
const OL = require('./lib/ownerLog.js');
/** The owner row keys in queue.json as it is on disk now (an empty set when there is no file yet), or null on an error. */
function ownerKeysOnDisk() {
  try {
    return fs.existsSync(FILE) ? OL.keySet(JSON.parse(fs.readFileSync(FILE, 'utf8'))) : new Set();
  } catch {
    return null; // error-ignored: nothing recorded, so a new row asks for an accept at receive and merge
  }
}
// The rolling copies of queue.json at a few ages (lib/stateSnapshots.js; stateSnapshots in queue.config.json).
const SNAPSHOT_TIERS = require('./lib/stateSnapshots.js').tiersFrom(CONFIG.stateSnapshots);
export const edit = (fn) =>
  withLock(() => {
    const queue = read();
    const answer = fn(queue);
    write(queue);
    return answer;
  });
// Who made the change (the changelog) and optimistic concurrency (--expect-changed).
export const byName = () => val('--by') ?? 'ravenseat';
/** Refuses with exit 6 when the queue has changed after the time the caller previewed (called under the lock). */
export function checkExpect(queue) {
  const f = L.expectCheck(queue, val('--expect-changed') ?? null);
  if (!f) return;
  const code = f.startsWith('invalid') ? 1 : 6;
  if (a.includes('--json')) {
    console.log(JSON.stringify({ ok: false, error: [f], outdated: code === 6 }));
    process.exit(code); // The 'exit' handler releases the lock.
  }
  die(`Nothing changed: ${f}`, code);
}
/** The entry editLogged added to the changelog (null when nothing changed). */
export let lastEntry = null;
/**
 * Like edit, but checks --expect-changed and puts what actually changed (tasks and the project register) in
 * the changelog, so `queue.mjs undo` can roll it back.
 */
export const editLogged = (action, fn) =>
  withLock(() => {
    const queue = read();
    checkExpect(queue);
    const forQueue = L.cloneJson({ tasks: queue.tasks ?? [], projects: queue.projects ?? {} });
    const answer = fn(queue);
    lastEntry = L.logChange(queue, {
      by: byName(),
      action,
      changes: L.bulkDiff(forQueue, queue),
      now: new Date().toISOString(),
    });
    write(queue);
    return answer;
  });
// receive, set <id> done|cancelled and fill evaluate the focus stages in the SAME write (under the lock) and take out
// the stages that are done (queueLogic.cleanFocus: history + changelog, so queue.mjs undo works). An error here never
// stops the command; the lines are printed afterwards with focusCleanOut.
let focusClean = null;
export function autoCleanFocus(queue, action) {
  try {
    focusClean = L.cleanFocus(queue, { by: `ravenseat ${action} (auto)` });
  } catch (e) {
    focusClean = { error: e?.message ?? String(e) };
  }
}
export function focusCleanOut() {
  if (!focusClean) return;
  if (focusClean.error)
    console.log(`WARNING: the focus cleaning failed (${focusClean.error}); see ravenseat focus evaluate.`);
  else for (const l of L.focusCleanLines(focusClean)) console.log(l);
}
/** "(undo: queue.mjs undo)" after a logged write. */
export const undoHint = () =>
  lastEntry
    ? `Changelog no. ${lastEntry.nr} (${lastEntry.changes.length} field(s)); undo: ravenseat undo`
    : null;
// ---- The plan register: storage under the same lock as the queue ---------------------------------------
const PLAN_FILE = path.join(FOLDER, 'plans.json');
export function readPlans() {
  if (!fs.existsSync(PLAN_FILE)) return P.emptyRegister();
  return P.normalize(JSON.parse(fs.readFileSync(PLAN_FILE, 'utf8')));
}
// `bump: false` (plan active) leaves `changed` alone: a pulse is no plan change and must not make --expect-changed outdated.
export function writePlans(reg, { bump = true } = {}) {
  stopIfLockLost('plans.json');
  if (bump) reg.changed = new Date().toISOString();
  const tmp = `${PLAN_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2) + '\n');
  SF.renameWithRetry(tmp, PLAN_FILE);
}
/** The queue read-only (projects, areas, tasks, owner questions); empty when it does not exist. */
export const readQueueForPlan = () => (fs.existsSync(FILE) ? read() : {});
// ---- Auto-accept of proposals (the rules in lib/queueProposals.js) -------------------------------------------
/** The rules in force (the config's default with the queue's own on top). */
export const autoAcceptRules = (queue) => PR.rulesFor(CONFIG.proposals?.autoAccept, queue);
/** What the hard rules need: the protected paths (with the custom helpers' files, like the merge guard) and the plan
 * entries with open legal points (an unreadable plan register only means that check has nothing to stop). */
export function autoAcceptContext(queue) {
  let reg = null;
  try {
    reg = readPlans();
  } catch {
    /* no plan register: no plan entry has open legal points */
  }
  const base = Array.isArray(CONFIG.protectedPaths) ? CONFIG.protectedPaths : undefined;
  return {
    protectedPaths: MG.withPaths(base, HELP.customPaths(HELP.helperSetup(CONFIG, queue))),
    openLegalPlans: PR.openLegalPlans(reg),
  };
}
/** Applies the rules inside an edit (the caller holds the lock); `ids` = only these. Returns the accepted ones. */
export function autoAcceptIn(queue, ids = null) {
  const rules = autoAcceptRules(queue);
  if (!rules.enabled) return [];
  return PR.applyAutoAccept(queue, rules, autoAcceptContext(queue), { ids });
}
