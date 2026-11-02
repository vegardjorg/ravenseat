// =============================================================
// cli/doctor.mjs: `cq doctor`, a read-only health check of the queue setup.
//
// Each check prints one line OK, WARN or FAIL with what it saw, and a one-line fix hint when it is not OK:
//   node        the Node version (>= 20, package.json engines), and that `node` is found on PATH the way the hooks
//               start it (exec form: command "node" spawned without a shell)
//   hooks       the hooks file (plugin: <plugin>/hooks/hooks.json, vendored: .claude/settings.json) parses, lists every
//               queue hook under its events (queueBoard.hooksCoverage) and every hook script it names exists
//   config      queue.config.json parses, has no unknown keys (WARN) and no value of the wrong type (FAIL)
//   queue       queue.json (and plans.json, follow.json when they exist) parse
//   lock        a lock (<dataFolder>/.lockState) older than 60 s: a process died holding it
//   worktrees   folders under <mainTree>/.claude/worktrees without .git (a half-deleted worktree blocks agent starts),
//               and git worktrees whose folder is gone (`git worktree list --porcelain`)
//   branches    queue branches of done or cancelled tasks that are still there (WARN only)
//   git         INFO when git is older than 2.38: no `git merge-tree --write-tree`, so the conflict prediction
//               (lib/conflictPredict.js) falls back to file overlap (QUEUE_GIT_VERSION overrides the version, tests)
//   ci-cost     .github/workflows/*.yml that run on push: WARN without concurrency cancel-in-progress, INFO without a
//               paths/paths-ignore filter (a text scan, lib/pushBatch.js workflowCost)
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
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { a, branchFor, CONFIG, CQ, FILE, FOLDER, FOLLOW_FILE, git, HERE, KK, LOCK, MAIN_TREE, require } from './context.mjs';
import { BASELINE_CHECKS } from './doctorBaseline.mjs';

const BOARD = require('./lib/queueBoard.js');
const PB = require('./lib/pushBatch.js');
const TW = require('./lib/testWeakening.js');
const CP = require('./lib/conflictPredict.js');

/** The lowest Node major version the scripts support (package.json "engines"). */
const MIN_NODE = 20;
/** A lock older than this was left by a process that died (the same limit as withLock in cli/context.mjs). */
const STALE_LOCK_MS = 60_000;
/** The config objects whose keys are fixed: an unknown key in them is a typo. The others are open maps. */
const CLOSED = ['gates', 'migrations', 'readGuard', 'loadGuard', 'qa', 'capacity', 'board', 'contextGuard', 'features', 'documents', 'proposals', 'push', 'secretScan', 'testWeakening'];

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
  const mb = own.largeFileMb;
  if (mb !== undefined && !(typeof mb === 'number' && mb > 0)) out.push('largeFileMb must be a number > 0');
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
  const reinstall = src.mode === 'plugin' ? 'reinstall or update the plugin' : `run ${CQ} setup again (vendored: node scripts/install.mjs)`;
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
  try {
    own = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e?.code === 'ENOENT')
      return [warn('config', `no ${path.basename(file)}: the defaults apply and the hooks stay off`, `run ${CQ} setup`)];
    return [fail('config', `${file} does not parse: ${e.message}`, 'fix the JSON; until then every command runs on the defaults')];
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
      if (w !== null && wantN !== 'null' && kind(w) !== wantN) wrong.push(`${k}.${n} is ${kind(w)}, expected ${wantN}`);
    }
  }
  if (own.mode != null && !['lite', 'full'].includes(own.mode)) wrong.push(`mode is "${own.mode}", expected lite or full`);
  // The push keys have value rules beyond the type (lib/pushBatch.js setupProblems).
  wrong.push(...PB.setupProblems(own.push).filter((p) => !wrong.some((w) => w.startsWith(p.split(' ')[0]))));
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

/** The state files in the data folder parse. */
function checkState() {
  const out = [];
  const q = readJson(FILE);
  if (!q) out.push(warn('queue', `no queue at ${FILE}`, `run ${CQ} init`));
  else if (q.error) out.push(fail('queue', `queue.json does not parse: ${q.error}`, 'restore it from queue.json.*.tmp or a backup; never edit it while the queue runs'));
  else if (!Array.isArray(q.value?.tasks)) out.push(fail('queue', 'queue.json has no tasks list', `restore it from a backup, or ${CQ} init in a fresh data folder`));
  else out.push(ok('queue', `queue.json parses (${q.value.tasks.length} task(s))`));
  for (const [name, file] of [
    ['plans.json', path.join(FOLDER, 'plans.json')],
    ['follow.json', FOLLOW_FILE],
  ]) {
    const r = readJson(file);
    if (r?.error) out.push(fail('queue', `${name} does not parse: ${r.error}`, `restore ${name} from a backup`));
  }
  return out;
}

/** A lock left behind by a process that died. */
function checkLock() {
  let st;
  try {
    st = fs.statSync(LOCK);
  } catch {
    return [ok('lock', 'no lock held')];
  }
  const age = Date.now() - st.mtimeMs;
  if (age <= STALE_LOCK_MS) return [ok('lock', 'a command holds the lock right now')];
  return [
    warn(
      'lock',
      `stale lock ${LOCK} (${Math.round(age / 1000)} s old)`,
      'the next writing command removes it; if commands hang, check that no cq process runs, then delete the folder',
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
  if (!left.length) return [ok('branches', 'no branches of finished tasks left')];
  const shown = left.slice(0, 5).join(' ');
  return [
    warn(
      'branches',
      `${left.length} branch(es) of done or cancelled tasks still exist: ${shown}${left.length > 5 ? ' ...' : ''}`,
      `git branch -d ${shown} (-d refuses unmerged work; check those by hand)`,
    ),
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
        warn(
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

/** git: new enough for `git merge-tree --write-tree` (the conflict prediction)? Only an INFO line when it is not. */
function checkGit() {
  const v = CP.gitVersion(CP.makeRunner(MAIN_TREE));
  if (v && CP.supportsMergeTree(v)) return [];
  return [
    info(
      'git',
      `git ${v ?? '(version unknown)'} is older than ${CP.MIN_GIT_TEXT}: the conflict prediction (pulse, ${CQ} conflicts) uses file overlap instead of git merge-tree --write-tree`,
      `update git to ${CP.MIN_GIT_TEXT} or newer`,
    ),
  ];
}

/** `cq doctor [--json]` (the usage is at the top of queue.mjs). */
export function cmdDoctor() {
  const checks = [checkNode, checkHooks, checkConfig, checkState, checkLock, checkWorktrees, checkBranches, checkGit, checkCiCost, ...BASELINE_CHECKS].flatMap((f) => {
    try {
      return f();
    } catch (e) {
      // A check that crashes is a finding of its own, never the end of the run.
      return [fail(f.name.replace(/^check/, '').toLowerCase(), `the check failed: ${e?.message ?? e}`, 'report it as a bug')];
    }
  });
  const failed = checks.some((c) => c.status === 'FAIL');
  if (a.includes('--json')) console.log(JSON.stringify({ ok: !failed, checks }, null, 2));
  else {
    for (const c of checks) {
      console.log(`${c.status.padEnd(4)}  ${c.name.padEnd(9)}  ${c.message}`);
      if (c.fix) console.log(`${' '.repeat(17)}fix: ${c.fix}`);
    }
    const n = (s) => checks.filter((c) => c.status === s).length;
    console.log(`\n${n('OK')} OK, ${n('WARN')} WARN, ${n('INFO')} INFO, ${n('FAIL')} FAIL${failed ? ' (exit 1)' : ''}. Nothing was changed.`);
  }
  if (failed) process.exit(1);
}
