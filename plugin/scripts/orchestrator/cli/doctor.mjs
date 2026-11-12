// =============================================================
// cli/doctor.mjs: `ravenseat doctor`, a read-only health check of the queue setup.
//
// Each check prints one line OK, WARN or FAIL with what it saw, and a one-line fix hint when it is not OK:
//   node        the Node version (>= 20, package.json engines), and that `node` is found on PATH the way the hooks
//               start it (exec form: command "node" spawned without a shell)
//   hooks       the hooks file (plugin: <plugin>/hooks/hooks.json, vendored: .claude/settings.json) parses, lists every
//               queue hook under its events (queueBoard.hooksCoverage) and every hook script it names exists
//   config      queue.config.json parses, has no unknown keys (WARN) and no value of the wrong type (FAIL)
//   queue       queue.json (and plans.json, follow.json when they exist) parse
//   surface     the git hooks and config that run code against the accepted baseline (lib/gitSurfaceBaseline.js): WARN on
//               a difference; no baseline yet is OK (the first command that runs code records it, doctor never does)
//   lock        a lock (<dataFolder>/.lockState) older than 60 s: a process died holding it
//   worktrees   folders under <mainTree>/.claude/worktrees without .git (a half-deleted worktree blocks agent starts),
//               and git worktrees whose folder is gone (`git worktree list --porcelain`)
//   branches    queue branches of done or cancelled tasks, and merged agent branches, still there (WARN only)
//   machine     cores and memory against maxConcurrent (lib/machineAdvice.js, an estimate): OK, or WARN when maxConcurrent
//               is above the suggestion; never FAIL
//   budget      WARN when no daily budget is set (`ravenseat limit dailyBudget <usd>`); never FAIL, quiet guidance
//               hides it
//   git         FAIL when `git` is not found on PATH at all (red team scenario 14).
//               INFO when git is older than 2.38: no `git merge-tree --write-tree`, so the conflict prediction
//               (lib/conflictPredict.js) falls back to file overlap (QUEUE_GIT_VERSION overrides the version, tests)
//   ci-cost     only with --all: .github/workflows/*.yml that run on push: INFO without concurrency cancel-in-progress or a
//               paths/paths-ignore filter (a text scan, lib/pushBatch.js workflowCost)
//   settings    one WARN line naming every guard weaker than its default (the registry's weakens, lib/settingsView.js
//               doctorRows), INFO for what lite softens and for each protectedPaths.remove entry; quiet guidance keeps it
//   merge, hooks-off, in-base (cli/doctorRepo.mjs): a lingering MERGE_HEAD in the main checkout, disableAllHooks in a
//               Claude Code settings file, done tasks whose merge commit or branch is not in baseBranch (all WARN)
//   cloud rows  only with features.cloud on: what cloud tracks need (lib/cloudSetup.js), read locally; the setup itself is
//               `ravenseat cloud setup`
//   the safety baseline (cli/doctorBaseline.mjs, offline): secrets (a tracked .env or private key is FAIL), gates,
//               ci, lockfile, prod (productionBranch vs baseBranch), largefile
// Exit code 1 when any check FAILs, otherwise 0. It never changes anything: no lock, no write, no git command that
// writes (git runs read-only, as in cli/context.mjs).
// QUEUE_HOOKS overrides the path to the hooks file (tests).
//
// Used by: queue.mjs (dispatch).
// Tested in: lib/__tests__/queueDoctor.test.ts.
// =============================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { a, branchFor, CONFIG, CLI, FILE, FOLDER, FOLLOW_FILE, git, GIT_ROOT, HERE, KK, L, LOCK, MAIN_TREE, require, SF } from './context.mjs';
import { cloudSetupFacts } from './cloud.mjs';
import { BASELINE_CHECKS } from './doctorBaseline.mjs';
import { REPO_CHECKS } from './doctorRepo.mjs';

const BOARD = require('./lib/queueBoard.js');
const QL = require('./lib/queueLock.js');
const PB = require('./lib/pushBatch.js');
const TW = require('./lib/testWeakening.js');
const RB = require('./lib/redOnBase.js');
const CP = require('./lib/conflictPredict.js');
const CW = require('./lib/ciWatch.js');
const GB = require('./lib/gitSurfaceBaseline.js');
const MG = require('./lib/mergeGuard.js');
const SV = require('./lib/settingsView.js');

/** The lowest Node major version the scripts support (package.json "engines"). */
const MIN_NODE = 20;
/** A lock older than this was left by a process that died (the same limit as withLock in cli/context.mjs). */
const STALE_LOCK_MS = 60_000;
/** The config objects whose keys are fixed: an unknown key in them is a typo. The others are open maps. */
const CLOSED = ['identity', 'cloud', 'gates', 'migrations', 'readGuard', 'loadGuard', 'qa', 'capacity', 'board', 'contextGuard', 'features', 'documents', 'proposals', 'push', 'secretScan', 'testWeakening', 'focus', 'gateQueue', 'gateTemp', 'usageLimit', 'stateSnapshots', 'reads', 'agentGuard', 'agentPushBlock', 'gateEvidence', 'ownership', 'history'];

const ok = (name, message) => ({ status: 'OK', name, message, fix: null });
const warn = (name, message, fix) => ({ status: 'WARN', name, message, fix });
const fail = (name, message, fix) => ({ status: 'FAIL', name, message, fix });
/** A hint that is not a problem on its own (counted, never an exit code). */
const info = (name, message, fix) => ({ status: 'INFO', name, message, fix });

/**
 * The value rules of the safety baseline keys beyond the type check (productionBranch has the default null, so the
 * type check cannot see a wrong type there).
 */
export function baselineProblems(own) {
  const out = [];
  const p = own.productionBranch;
  if (p !== undefined && p !== null && !(typeof p === 'string' && /^[^\s]+$/.test(p)))
    out.push('productionBranch must be a branch name or null');
  const d = own.deployCommands;
  if (Array.isArray(d) && d.some((x) => typeof x !== 'string' || !x.trim())) out.push('deployCommands must hold non-empty strings');
  const s = own.secretScan;
  if (s && typeof s === 'object' && !Array.isArray(s))
    for (const k of ['maxBytes', 'timeoutMs'])
      if (s[k] !== undefined && !(Number.isInteger(s[k]) && s[k] > 0)) out.push(`secretScan.${k} must be a whole number > 0`);
  const rm = own.reads?.mode;
  if (rm !== undefined && !['wait', 'warn'].includes(rm)) out.push('reads.mode must be "wait" or "warn"');
  out.push(...RB.setupProblems(own.gates?.redOnBase));
  const gt = own.gates?.timeoutSec;
  if (gt !== undefined && gt !== null && !(Number.isInteger(gt) && gt >= 0))
    out.push('gates.timeoutSec must be a whole number >= 0 or null');
  const mb = own.largeFileMb;
  if (mb !== undefined && !(typeof mb === 'number' && mb > 0)) out.push('largeFileMb must be a number > 0');
  // gateEvidence (owner decision B2): an unknown mode reads as own, so it is named here rather than silently ignored.
  const gm = own.gateEvidence?.mode;
  if (gm !== undefined && !['own', 'external', 'off'].includes(gm)) out.push('gateEvidence.mode must be "own", "external" or "off"');
  const ge = own.gateEvidence?.external;
  if (ge !== undefined && !(Array.isArray(ge) && ge.every((x) => typeof x === 'string' && x.trim())))
    out.push('gateEvidence.external must be a list of check names');
  // history (owner decision B5): an unknown value reads as the default, so it is named here.
  const hr = own.history?.rotateTimeLog;
  if (hr !== undefined && !['monthly', 'off'].includes(hr)) out.push('history.rotateTimeLog must be "monthly" or "off" (treated as monthly)');
  const hd = own.history?.archiveDoneAfterDays;
  if (hd !== undefined && hd !== null && !(Number.isInteger(hd) && hd >= 0))
    out.push('history.archiveDoneAfterDays must be a whole number >= 0 or null (treated as null: nothing is archived)');
  return out;
}

/** The kind of a JSON value for the type check: array, object, null or the typeof. */
const kind = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);

/** The major version of a "v24.1.0" string, or NaN. */
const major = (v) => Number(String(v ?? '').replace(/^v/, '').split('.')[0]);

/** Node: this process's version, and the `node` the hooks spawn (PATH lookup, no shell). */
function checkNode() {
  const out = [];
  const own = process.versions.node;
  if (major(own) < MIN_NODE)
    out.push(fail('node', `Node ${own} is older than ${MIN_NODE}`, `install Node ${MIN_NODE} or newer`));
  else out.push(ok('node', `Node ${own}`));
  let hookNode = null;
  try {
    hookNode = execFileSync('node', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim();
  } catch {
    /* not found on PATH */
  }
  if (!hookNode)
    out.push(
      fail('node', '`node` is not found on PATH; the hooks start it as "node" without a shell', 'put the Node folder on PATH for the Claude Code process (then restart Claude Code)'),
    );
  else if (major(hookNode) < MIN_NODE)
    out.push(fail('node', `the hooks get ${hookNode} from PATH, older than ${MIN_NODE}`, 'put a newer Node first on PATH'));
  else if (hookNode !== `v${own}`)
    out.push(warn('node', `the hooks get ${hookNode} from PATH, this command runs ${own}`, 'fine if both work; otherwise keep one Node on PATH'));
  else out.push(ok('node', `the hooks find ${hookNode} on PATH`));
  return out;
}

/** The hook scripts a hooks file names: [{ event, script }] with the script path as written. */
function hookScripts(settings) {
  const out = [];
  for (const [event, entries] of Object.entries(settings?.hooks ?? {}))
    for (const e of Array.isArray(entries) ? entries : [])
      for (const h of Array.isArray(e?.hooks) ? e.hooks : []) {
        const parts = [String(h?.command ?? ''), ...(Array.isArray(h?.args) ? h.args.map(String) : [])].join(' ');
        // The .mjs path, with or without quotes; the queue's scripts all live in scripts/orchestrator/.
        for (const m of parts.matchAll(/"([^"]+\.mjs)"|'([^']+\.mjs)'|(\S+\.mjs)/g)) {
          const script = m[1] ?? m[2] ?? m[3];
          if (/scripts[\\/]orchestrator[\\/]/.test(script)) out.push({ event, script });
        }
      }
  return out;
}

/** A hook path with the Claude Code variables filled in; relative paths are taken from the main tree. */
function expandHookPath(script, pluginRoot) {
  let p = script;
  for (const [name, value] of [
    ['CLAUDE_PLUGIN_ROOT', pluginRoot],
    ['CLAUDE_PROJECT_DIR', MAIN_TREE],
  ]) {
    if (value == null) continue;
    p = p.split(`\${${name}}`).join(value).split(`$${name}`).join(value).split(`%${name}%`).join(value);
  }
  return path.isAbsolute(p) ? p : path.resolve(MAIN_TREE, p);
}

/** Hooks: the file parses, every queue hook is listed, and every script it names exists. */
function checkHooks() {
  const src = BOARD.setupSources(HERE, MAIN_TREE, (p) => fs.existsSync(p));
  const file = process.env.QUEUE_HOOKS ?? src.hooksFile;
  const where = src.mode === 'plugin' ? 'the plugin' : 'the project';
  const reinstall = src.mode === 'plugin' ? 'reinstall or update the plugin' : `run ${CLI} setup again (vendored: node scripts/install.mjs)`;
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e?.code === 'ENOENT') return [fail('hooks', `no hooks file for ${where}: ${file}`, reinstall)];
    return [fail('hooks', `${file} does not parse: ${e.message}`, 'fix the JSON (a trailing comma is the usual cause)')];
  }
  const out = [];
  const cover = BOARD.hooksCoverage(settings);
  if (!cover.all) out.push(fail('hooks', `missing in ${file}: ${cover.missing.join(', ')}`, reinstall));
  const missing = hookScripts(settings).filter((h) => !fs.existsSync(expandHookPath(h.script, src.pluginRoot)));
  if (missing.length)
    out.push(
      fail(
        'hooks',
        `hook script(s) not found: ${[...new Set(missing.map((h) => `${h.script} (${h.event})`))].join(', ')}`,
        reinstall,
      ),
    );
  if (!out.length) out.push(ok('hooks', `${BOARD.QUEUE_HOOKS.length} queue hooks listed in ${file}, all scripts exist`));
  return out;
}

/** Config: parses, no unknown keys, the right types (compared with the defaults in lib/queueConfig.js). */
function checkConfig() {
  const file = KK.configFile(MAIN_TREE);
  let own;
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
    own = KK.parseConfigText(text);
  } catch (e) {
    if (e?.code === 'ENOENT')
      return [warn('config', `no ${path.basename(file)}: the defaults apply and the hooks stay off`, `run ${CLI} setup`)];
    // The same reading as config() (lib/queueConfig.js readConfigFile): the queue commands stop on it, and the push
    // guard asks (main session) or denies (queue agents) every push, migration and deploy command until it is fixed.
    const at = KK.parseErrorPosition(e?.message, text);
    const where = at ? ` (line ${at.line}, column ${at.column})` : '';
    return [
      fail(
        'config',
        `${file} does not parse${where}: ${e.message}`,
        'fix the JSON (a trailing comma is the usual cause); until then the queue commands stop and the push guard asks before every push, migration and deploy',
      ),
    ];
  }
  if (kind(own) !== 'object') return [fail('config', `${file} must hold one JSON object`, 'wrap the settings in { }')];
  const S = KK.STANDARD;
  const unknown = [];
  const wrong = [];
  const skip = (k) => k.startsWith('$') || k.startsWith('_');
  for (const [k, v] of Object.entries(own)) {
    if (skip(k)) continue;
    if (!Object.hasOwn(S, k)) {
      unknown.push(k);
      continue;
    }
    // protectedPaths: a list, or { add: [...], remove: [...] } (lib/mergeGuard.js resolveProtectedPaths).
    if (k === 'protectedPaths' && kind(v) === 'object') {
      if (MG.resolveProtectedPaths(v, S.protectedPaths).invalid)
        wrong.push('protectedPaths must be a list of paths or { "add": [...], "remove": [...] }');
      continue;
    }
    const want = kind(S[k]);
    if (v !== null && want !== 'null' && kind(v) !== want) wrong.push(`${k} is ${kind(v)}, expected ${want}`);
    if (want !== 'object' || kind(v) !== 'object') continue;
    for (const [n, w] of Object.entries(v)) {
      if (skip(n)) continue;
      if (!Object.hasOwn(S[k], n)) {
        if (CLOSED.includes(k)) unknown.push(`${k}.${n}`);
        continue;
      }
      const wantN = kind(S[k][n]);
      // A default of "auto" also takes true or false (baseGate.enabled: false is the documented way to turn it off).
      if (S[k][n] === 'auto' && typeof w === 'boolean') continue;
      if (w !== null && wantN !== 'null' && kind(w) !== wantN) wrong.push(`${k}.${n} is ${kind(w)}, expected ${wantN}`);
    }
  }
  if (own.mode != null && !['lite', 'full'].includes(own.mode)) wrong.push(`mode is "${own.mode}", expected lite or full`);
  if (own.dependencyFiles != null && !['stop', 'warn'].includes(own.dependencyFiles)) wrong.push(`dependencyFiles is "${own.dependencyFiles}", expected stop or warn`);
  if (own.gitSurface != null && !GB.MODES.includes(own.gitSurface)) wrong.push(`gitSurface is "${own.gitSurface}", expected ${GB.MODES.join(', ')} (treated as stop)`);
  // The push keys have value rules beyond the type (lib/pushBatch.js setupProblems).
  wrong.push(...PB.setupProblems(own.push).filter((p) => !wrong.some((w) => w.startsWith(p.split(' ')[0]))));
  // The CI watch keys (lib/ciWatch.js setupProblems): off or github, positive interval and timeout.
  wrong.push(...CW.setupProblems(own.push).filter((p) => !wrong.some((w) => w.startsWith(p.split(' ')[0]))));
  // The test-weakening markers must be valid regular expressions (lib/testWeakening.js setupProblems).
  wrong.push(...TW.setupProblems(own.testWeakening).filter((p) => !wrong.some((w) => w.startsWith(p.split(' ')[0]))));
  wrong.push(...baselineProblems(own).filter((p) => !wrong.some((w) => w.startsWith(p.split(' ')[0]))));
  const out = [];
  if (wrong.length) out.push(fail('config', `wrong type in ${path.basename(file)}: ${wrong.join('; ')}`, 'compare with queue.config.example.json'));
  if (unknown.length)
    out.push(warn('config', `unknown key(s) ignored: ${unknown.join(', ')}`, 'check the spelling against queue.config.example.json'));
  if (!out.length) out.push(ok('config', `${path.basename(file)} parses, keys and types valid`));
  return out;
}

/** One JSON state file: OK, missing (null), or the parse error. */
function readJson(file) {
  try {
    return { value: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (e) {
    return e?.code === 'ENOENT' ? null : { error: e.message };
  }
}

const SS = require('./lib/stateSnapshots.js');
/** The rolling copies of queue.json that parse (lib/stateSnapshots.js), as one hint line, or null when there are none. */
function snapshotHint() {
  const copies = SS.list(FILE, SS.tiersFrom(CONFIG.stateSnapshots)).filter((c) => c.tasks != null);
  if (!copies.length) return null;
  return `Older copies: ${copies.map((c) => `${c.path} (${c.tasks} task(s), ${c.at})`).join('; ')}.`;
}

/** The state files in the data folder parse. */
function checkState() {
  const out = [];
  const q = readJson(FILE);
  if (!q) out.push(warn('queue', `no queue at ${FILE}`, `run ${CLI} init`));
  else if (q.error)
    out.push(
      fail(
        'queue',
        `queue.json does not parse: ${q.error}`,
        // queue.json.prev (lib/stateFile.js) is the previous good state when it parses.
        [SF.recoveryHint(FILE) ?? 'restore it from queue.json.*.tmp or a backup; never edit it while the queue runs', snapshotHint()]
          .filter(Boolean)
          .join(' '),
      ),
    );
  else if (!Array.isArray(q.value?.tasks))
    out.push(fail('queue', 'queue.json has no tasks list', [`restore it from a backup, or ${CLI} init in a fresh data folder`, snapshotHint()].filter(Boolean).join(' ')));
  else {
    out.push(ok('queue', `queue.json parses (${q.value.tasks.length} task(s))`));
    const tierProblem = SS.tierProblem(CONFIG.stateSnapshots);
    if (tierProblem) out.push(warn('snapshots', `${tierProblem}; the default tiers are used`, 'fix stateSnapshots.tiers in queue.config.json'));
    // A dependency cycle among open tasks: add and edit refuse a new one, but a hand edit or an older queue can hold one.
    for (const c of L.dependencyCycles(q.value.tasks))
      out.push(
        warn(
          'queue',
          `dependency cycle: ${c.join(' -> ')} (none of these tasks can ever start)`,
          `remove one dependency: ${CLI} edit ${c[0]} --json '{"depends_on":[...]}'`,
        ),
      );
    // A temporary file of a process that is gone (lib/stateFile.js writes queue.json.<pid>.tmp and renames it): a crash in
    // the middle of a write. The queue above is fine and never read it; the file is only left over (red team RT-21).
    let left = [];
    try {
      left = fs
        .readdirSync(path.dirname(FILE))
        .filter((n) => new RegExp(`^${path.basename(FILE).replace(/\./g, '\\.')}(\\.prev)?\\.(\\d+)\\.tmp$`).test(n))
        .filter((n) => !QL.pidAlive(Number(n.match(/\.(\d+)\.tmp$/)[1])));
    } catch {
      left = []; // error-ignored: an unreadable folder is reported by the checks that need it
    }
    if (left.length)
      out.push(
        info(
          'queue',
          `left over from an interrupted write: ${left.join(', ')} (queue.json itself is fine and never read it)`,
          `delete it when no ravenseat command is running: ${left.map((n) => path.join(path.dirname(FILE), n)).join(' ')}`,
        ),
      );
  }
  for (const [name, file] of [
    ['plans.json', path.join(FOLDER, 'plans.json')],
    ['follow.json', FOLLOW_FILE],
  ]) {
    const r = readJson(file);
    if (r?.error) out.push(fail('queue', `${name} does not parse: ${r.error}`, `restore ${name} from a backup`));
  }
  return out;
}

/** The git hooks and config that run code against the accepted baseline. Reads only: no ensure here. */
function checkSurface() {
  if (GB.mode() === 'off') return [ok('surface', 'not compared: gitSurface is off in queue.config.json, so a changed git hook or setting goes unnoticed')];
  if (!GB.read(FOLDER)) return [ok('surface', 'no accepted git baseline yet (the next fill, start, resume, receive or merge records it)')];
  const reason = GB.driftDetail(FOLDER, GIT_ROOT)?.reason;
  if (!reason) return [ok('surface', 'the git hooks and config that run code match the accepted baseline')];
  return [warn('surface', reason, `${CLI} surface shows where; ${CLI} surface accept --by owner if you made the change, otherwise remove it`)];
}

/** The agent push block in the main checkout's hooks folder (lib/agentPushBlock.js, owner decision B1). Reads only. */
function checkPushBlock() {
  const r = require('./lib/agentPushBlock.js').doctorRow(GIT_ROOT, CONFIG, CLI);
  return [{ status: r.status, name: 'pushblock', message: r.message, fix: r.fix }];
}

/** A lock left behind by a process that died. */
function checkLock() {
  const state = QL.readState(LOCK);
  if (!state) return [ok('lock', 'no lock held')];
  const seconds = Math.round(state.ageMs / 1000);
  // The same rule withLock uses: a live holder on this machine is never taken over, however old its lock is.
  const owner = state.tokens[0]?.owner ?? null;
  const verdict = QL.assessLock({ owner, ageMs: state.ageMs, hostname: os.hostname(), isAlive: QL.pidAlive });
  if (verdict.action === 'take_over')
    return [warn('lock', `stale lock ${LOCK} (${seconds} s old)`, 'the next writing command takes it over')];
  if (state.ageMs <= STALE_LOCK_MS) return [ok('lock', 'a command holds the lock right now')];
  return [
    warn(
      'lock',
      `lock ${LOCK} held for ${seconds} s by a live process (${owner ? QL.holderText(state.tokens[0]) : 'unknown'})`,
      `${CLI} unlock shows the holder; if it hangs, stop it, or release the lock with ${CLI} unlock --force --by owner`,
    ),
  ];
}

/** The git worktrees from `git worktree list --porcelain`: [{ path, branch, prunable }]. */
function gitWorktrees() {
  const text = git(['worktree', 'list', '--porcelain']);
  if (text == null) return null;
  const out = [];
  let cur = null;
  for (const l of text.split(/\r?\n/)) {
    if (l.startsWith('worktree ')) {
      cur = { path: l.slice('worktree '.length), branch: null, prunable: false };
      out.push(cur);
    } else if (cur && l.startsWith('branch ')) cur.branch = l.slice('branch '.length).replace(/^refs\/heads\//, '');
    else if (cur && l.startsWith('prunable')) cur.prunable = true;
  }
  return out;
}

/** Half-deleted worktree folders and git worktrees whose folder is gone. */
function checkWorktrees() {
  const out = [];
  const root = path.join(MAIN_TREE, '.claude', 'worktrees');
  let dirs = [];
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    /* no worktree folder yet */
  }
  const broken = dirs.filter((d) => !fs.existsSync(path.join(root, d.name, '.git'))).map((d) => d.name);
  if (broken.length)
    out.push(
      fail(
        'worktrees',
        `folder(s) without .git under ${root}: ${broken.join(', ')} (a half-deleted worktree blocks agent starts)`,
        'move the folder(s) out of .claude/worktrees (check for uncommitted work first), then git worktree prune',
      ),
    );
  const list = gitWorktrees();
  if (list == null) out.push(warn('worktrees', 'could not run git worktree list', 'check that git is on PATH and the project is a git repo'));
  else {
    const gone = list.filter((w) => w.prunable || !fs.existsSync(w.path));
    if (gone.length)
      out.push(
        warn(
          'worktrees',
          `git worktree(s) whose folder is gone: ${gone.map((w) => `${w.path}${w.branch ? ` (${w.branch})` : ''}`).join(', ')}`,
          'git worktree prune (the branch stays; it frees the branch for a new worktree)',
        ),
      );
  }
  if (!out.length) out.push(ok('worktrees', `${dirs.length} agent worktree folder(s), all intact`));
  return out;
}

/** What a plugin update leaves behind: the project's own copies of the docs and mission template, and the status line path. */
function checkProjectFiles() {
  const PF = require('./lib/projectFiles.js');
  const plugin = path.resolve(HERE, '..', '..');
  const out = [];
  const stale = PF.staleFiles(plugin, MAIN_TREE);
  const message = PF.staleMessage(stale);
  // Only the mission template changes what agents do; the rest is reading matter, and a file that is merely new is added by ravenseat setup.
  if (message) out.push((stale.mission ? warn : info)('project files', message, stale.changed.length ? PF.STALE_FIX : 'ravenseat setup adds the new files and keeps the rest'));
  for (const s of PF.staleStatusLines(plugin, MAIN_TREE))
    out.push(warn('project files', `the status line in ${s.file} runs plugin version ${s.version}, not ${PF.pluginVersion(plugin)}`, 'ravenseat setup --settings'));
  return out;
}

/** Queue branches of done or cancelled tasks that are still there. */
function checkBranches() {
  const q = readJson(FILE);
  if (!q || q.error || !Array.isArray(q.value?.tasks)) return [];
  const refs = git(['for-each-ref', '--format=%(refname:short)', 'refs/heads/']);
  if (refs == null) return [];
  const have = new Set(refs.split(/\r?\n/).filter(Boolean));
  const left = q.value.tasks
    .filter((o) => ['done', 'cancelled'].includes(o?.status))
    .map((o) => o.branch ?? branchFor(o.id))
    .filter((b) => have.has(b) && b !== CONFIG.baseBranch);
  // Claude Code's own agent branches: only merged ones with no worktree left (a running agent's new branch also counts
  // as merged, but it has a worktree).
  const QG = require('./lib/queueGit.js');
  const agents = QG.mergedAgentBranches(git, CONFIG.baseBranch);
  // A worktree detached by an agent when it delivered has no branch name, so nothing above sees it.
  const within = (x, y) => git(['merge-base', '--is-ancestor', x, y]) != null;
  const root = path.resolve(GIT_ROOT, '.claude', 'worktrees').toLowerCase();
  const detached = QG.readWorktrees(git).filter((w) => w.detached && w.head && path.resolve(w.path).toLowerCase().startsWith(root));
  const merged = detached.filter((w) => within(w.head, CONFIG.baseBranch));
  const abandoned = left.filter((b) => detached.some((w) => !within(w.head, CONFIG.baseBranch) && within(w.head, b)));
  const detachedLines = [
    ...(merged.length
      ? [warn('branches', `${merged.length} detached worktree(s) hold nothing the base lacks: ${merged.map((w) => path.basename(w.path)).join(' ')}`,
          'ravenseat cleanup-worktree --all --execute removes them once they are 3 hours old and clean (without --execute it ' +
            'only lists them; it also removes folders git does not list, but only when they hold no repository or live ' +
            'worktree and git status shows nothing)')]
      : []),
    ...(abandoned.length
      ? [warn('branches', `detached worktree(s) still hold the work of finished or cancelled: ${abandoned.join(' ')}`,
          `ravenseat cleanup-worktree ${abandoned[0]} --abandon --execute (the branch stays; the same for each)`)]
      : []),
  ];
  if (!left.length && !agents.length && !detachedLines.length) return [ok('branches', 'no branches of finished tasks left')];
  // git refuses to delete a branch a worktree has checked out, so those need the worktree cleaned up first.
  const checkedOut = new Set((gitWorktrees() ?? []).map((w) => w.branch).filter(Boolean));
  const held = left.filter((b) => checkedOut.has(b));
  const free = left.filter((b) => !checkedOut.has(b));
  const line = (what, list) => {
    const shown = list.join(' ');
    return warn('branches', `${list.length} ${what}: ${shown}`, `git branch -d ${shown} (-d refuses unmerged work; check those by hand)`);
  };
  return [
    ...(held.length
      ? [
          warn(
            'branches',
            `${held.length} branch(es) of done or cancelled tasks still have a worktree: ${held.join(' ')}`,
            `ravenseat cleanup-worktree --all --execute removes the merged ones (without --execute it only lists them), then git branch -d ${held.join(' ')}. ` +
              'A cancelled task with commits: ravenseat cleanup-worktree <branch> --abandon --execute (the branch stays).',
          ),
        ]
      : []),
    ...(free.length ? [line('branch(es) of done or cancelled tasks still exist', free)] : []),
    ...(agents.length ? [line('merged agent branch(es) with no worktree left', agents)] : []),
    ...detachedLines,
  ];
}

/**
 * CI cost: the project's GitHub Actions workflows that run on push. Every push of the base branch runs them, so a
 * workflow without `concurrency` + `cancel-in-progress: true` runs every push to the end even when a newer one already
 * replaced it (WARN), and one without a path filter runs for a docs-only push too (INFO). A text scan
 * (lib/pushBatch.js workflowCost, its limits are listed there); no workflows folder = nothing to say.
 */
function checkCiCost() {
  const dir = path.join(MAIN_TREE, '.github', 'workflows');
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/i.test(f)).sort();
  } catch {
    return [];
  }
  const out = [];
  let onPush = 0;
  for (const f of files) {
    let text;
    try {
      text = fs.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      continue;
    }
    const c = PB.workflowCost(text);
    if (!c.push) continue;
    onPush++;
    if (!c.concurrency)
      out.push(
        info(
          'ci-cost',
          `${f} runs on push without concurrency cancel-in-progress: an older run is not stopped when a newer push replaces it`,
          'add `concurrency: { group: ${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: true }` at the top level',
        ),
      );
    if (!c.pathFilter)
      out.push(
        info(
          'ci-cost',
          `${f} runs on push without a paths/paths-ignore filter: a docs-only push runs it too`,
          'add `paths-ignore: ["**/*.md", "docs/**"]` under on.push (or `paths:` for what it really tests)',
        ),
      );
  }
  if (!onPush) return files.length ? [ok('ci-cost', `${files.length} workflow(s), none runs on push`)] : [];
  if (!out.length) out.push(ok('ci-cost', `${onPush} workflow(s) on push, all with cancel-in-progress and a path filter`));
  return out;
}

/**
 * git: on PATH at all (a FAIL when not), and new enough for `git merge-tree --write-tree` (the conflict prediction)?
 * Only an INFO line when it is old.
 */
function checkGit() {
  // git not found at all (red team scenario 14): every queue command needs it, and the other rows would only show the
  // symptoms ("the repo has no commits", "version unknown"). Without a cwd, so a missing folder is not taken for it.
  try {
    execFileSync('git', ['--version'], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 10_000, windowsHide: true });
  } catch (e) {
    if (e?.code === 'ENOENT')
      return [
        fail(
          'git',
          '`git` is not found on PATH; the queue runs every git command through it (worktrees, merges, the checks)',
          'install git and put it on PATH for the Claude Code process (then restart Claude Code)',
        ),
      ];
  }
  const v = CP.gitVersion(CP.makeRunner(MAIN_TREE));
  if (v && CP.supportsMergeTree(v)) return [];
  return [
    info(
      'git',
      `git ${v ?? '(version unknown)'} is older than ${CP.MIN_GIT_TEXT}: the conflict prediction (pulse, ${CLI} conflicts) uses file overlap instead of git merge-tree --write-tree`,
      `update git to ${CP.MIN_GIT_TEXT} or newer`,
    ),
  ];
}

/** The machine against maxConcurrent: one line, an estimate. It suggests and changes nothing. */
function checkMachine() {
  const M = require('./lib/machineAdvice.js');
  const q = readJson(FILE);
  const maxConcurrent = L.spaceUse(q?.value && !q.error ? q.value : {}).limits.maxConcurrent;
  const r = M.doctorAdvice({ ...M.readMachine(), maxConcurrent, ravenseat: CLI });
  return [r.status === 'WARN' ? warn('machine', r.message, r.fix) : ok('machine', r.message)];
}

/**
 * The daily budget (`limits.dailyBudget` in queue.json, logic/guards.js budgetGuard): WARN when none is set, so the
 * queue starts tasks whatever the day costs. A recommendation, never a FAIL: no budget is a valid choice. No
 * readable queue: nothing to say (the queue line reports it).
 */
function checkBudget() {
  const q = readJson(FILE);
  if (!q?.value || q.error || !Array.isArray(q.value.tasks)) return [];
  const b = L.budgetGuard(q.value, 0);
  if (b.active) return [ok('budget', `daily budget ${b.limit.toFixed(2)} USD (API equivalent, local day)`)];
  return [
    warn(
      'budget',
      'no daily spending limit set',
      `optional: ${CLI} limit dailyBudget <usd> stops new tasks when the day's measured spend reaches it ` +
        '(running ones finish)',
    ),
  ];
}

/** The temp folder: entries per prefix, without sizes, so it stays fast with tens of thousands. It changes nothing. */
function checkTemp() {
  const T = require('./lib/gateTemp.js');
  const names = T.readNames();
  if (!names) return [ok('temp', 'the temp folder cannot be read')];
  const line = T.doctorLine(names);
  return [line.status === 'INFO' ? info('temp', line.message, line.fix) : ok('temp', line.message)];
}

/** What cloud tracks need, only while they are on. The rows that are not problems stay in `ravenseat cloud setup`. */
/**
 * Settings: the guards weaker than their default, in one line (lib/settingsView.js doctorRows). Not an advice row, so
 * quiet guidance shows it. Reads the file itself as well, for the protectedPaths.remove lines.
 */
function checkSettings() {
  let own = {};
  try {
    own = KK.parseConfigText(fs.readFileSync(KK.configFile(MAIN_TREE), 'utf8'));
  } catch {
    own = {}; // a missing or broken file is the config row's finding
  }
  let queue = { tasks: [] };
  let queueBytes = 0;
  try {
    const text = fs.readFileSync(FILE, 'utf8');
    queueBytes = Buffer.byteLength(text);
    queue = JSON.parse(text);
  } catch {
    /* no queue yet: only the file's settings count */
  }
  // The facts for the history lines (owner decision B5): the sizes only matter when a setting is off.
  const TA = require('./lib/timeLogArchive.js');
  const history = {
    timeLog: CONFIG.history?.rotateTimeLog === 'off' ? TA.stats(KK.timeLog()) : null,
    queue: {
      bytes: queueBytes,
      finished: (queue.tasks ?? []).filter((o) => o?.status === 'done' || o?.status === 'cancelled').length,
    },
    archive: require('./lib/queueArchive.js').stats(FOLDER),
  };
  return SV.doctorRows({ config: CONFIG, queue, own: kind(own) === 'object' ? own : {}, cli: CLI, history });
}

function checkCloud() {
  if (!KK.featureOn('cloud', CONFIG)) return [];
  const rows = require('./lib/cloudSetup.js').cloudSetupRows(cloudSetupFacts());
  return rows
    .filter((r) => r.status !== 'INFO' || r.name === 'github app')
    .map((r) => ({ ...r, name: `cloud ${r.name}` }));
}

/** `ravenseat doctor [--json] [--all]` (the usage is at the top of queue.mjs). */
export function cmdDoctor() {
  const every = [checkNode, checkHooks, checkConfig, checkState, checkSurface, checkPushBlock, checkLock, checkWorktrees, checkBranches, checkProjectFiles, checkSettings, ...REPO_CHECKS, checkCloud, checkMachine, checkBudget, checkTemp, checkGit, checkCiCost, ...BASELINE_CHECKS].flatMap((f) => {
    try {
      return f();
    } catch (e) {
      // A check that crashes is a finding of its own, never the end of the run.
      return [fail(f.name.replace(/^check/, '').toLowerCase(), `the check failed: ${e?.message ?? e}`, 'report it as a bug')];
    }
  });
  // Quiet guidance (lib/guidance.js) drops the advice rows, never a FAIL, and says how many went. --all shows everything.
  const { rows: checks, hidden } = require('./lib/guidance.js').filterDoctor(every, require('./lib/guidance.js').readQuiet(FOLDER), {
    all: a.includes('--all'),
  });
  const failed = checks.some((c) => c.status === 'FAIL');
  if (a.includes('--json')) console.log(JSON.stringify({ ok: !failed, checks, advice_hidden: hidden }, null, 2));
  else {
    for (const c of checks) {
      console.log(`${c.status.padEnd(4)}  ${c.name.padEnd(9)}  ${c.message}`);
      if (c.fix) console.log(`${' '.repeat(17)}fix: ${c.fix}`);
    }
    const n = (s) => checks.filter((c) => c.status === s).length;
    console.log(`\n${n('OK')} OK, ${n('WARN')} WARN, ${n('INFO')} INFO, ${n('FAIL')} FAIL${failed ? ' (exit 1)' : ''}. Nothing was changed.`);
    if (hidden) console.log(`${hidden} advice line(s) not shown: guidance is quiet (${CLI} doctor --all shows them).`);
  }
  if (failed) process.exit(1);
}
