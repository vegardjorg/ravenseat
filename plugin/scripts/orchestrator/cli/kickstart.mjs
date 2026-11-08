// =============================================================
// cli/kickstart.mjs: `ravenseat kickstart`: which controls the project has, and one next step.
//
//   ravenseat kickstart [--json]            what was found and the next step (read-only; works before ravenseat init and without git)
//   ravenseat kickstart gates [--apply]     shows the checks found as gates; --apply writes them to queue.config.json (never over
//                                    gates that are already set)
//   ravenseat kickstart add [gates|secrets|ci]   proposes the next step (or the named one) as a task. It starts only after
//                                    ravenseat approve or Approve on the board. A cancelled task counts as declined.
//
// The rules and the mission texts are in lib/kickstart.js.
// =============================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { a, CONFIG, CLI, die, FILE, GIT_ROOT, KK, LM, MAIN_TREE, read, require } from './context.mjs';
import { checkSecrets } from './doctorBaseline.mjs';

const K = require('./lib/kickstart.js');
const CONTROLS = require('./lib/controls.js');
const KNOWN = require('./lib/knownBugGate.js');
const QUEUE_PATH = fileURLToPath(new URL('../queue.mjs', import.meta.url));

// Outside a git repo the project root falls back to where the scripts live, which is the plugin's own folder in a plugin
// install. This command is meant to work before git exists, so it then reads the folder the user stands in.
const NO_PROJECT_ROOT = require('./lib/projectRoot.js').roots().mode === 'fallback';
export const PROJECT = NO_PROJECT_ROOT ? process.cwd() : MAIN_TREE;

function git(args) {
  try {
    return execFileSync('git', ['-C', GIT_ROOT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
  } catch {
    return null;
  }
}

/** What the steps are decided from. Reads files and local git only. */
export function readFacts() {
  const exists = (f) => fs.existsSync(path.join(PROJECT, f));
  const readFile = (f) => {
    try {
      return fs.readFileSync(path.join(PROJECT, f), 'utf8');
    } catch {
      return null;
    }
  };
  const inGit = !NO_PROJECT_ROOT && git(['rev-parse', '--is-inside-work-tree']) === 'true';
  const url = inGit ? git(['remote', 'get-url', CONFIG.remote ?? 'origin']) : null;
  return {
    git: inGit,
    // A repo with no commit yet: the agents make their worktrees from a commit, so the queue cannot start work there.
    hasCommit: inGit && !!git(['rev-parse', '--verify', '-q', 'HEAD^{commit}']),
    remote: !url ? null : /github\.com[:/]/i.test(url) ? 'github' : 'other',
    ...K.detectChecks({ exists, read: readFile }),
    hasGates: !NO_PROJECT_ROOT && CONTROLS.hasGates(CONFIG),
    ciHosts: CONTROLS.ciHosts(PROJECT),
    secretsOk: inGit ? checkSecrets().every((c) => c.status === 'OK') : true,
  };
}

const queueTasks = () => (!NO_PROJECT_ROOT && fs.existsSync(FILE) ? read().tasks : []);

const LABEL = { done: 'OK', next: 'NEXT', queued: 'QUEUED', declined: 'DECLINED', later: 'LATER' };

function overview() {
  const facts = readFacts();
  const list = K.steps({ facts, tasks: queueTasks() });
  const next = K.nextStep(list);
  const knownBugs = KNOWN.summary(queueTasks(), KNOWN.modeOf(CONFIG));
  if (a.includes('--json')) {
    console.log(JSON.stringify({ facts, steps: list, next: next?.key ?? null, knownBugs }, null, 2));
    return;
  }
  if (require('./lib/guidance.js').readQuiet(KK.dataFolder())) console.log(`Guidance is quiet (${CLI} guidance guided). Showing this because you asked.\n`);
  console.log(`Project: ${facts.stacks.length ? facts.stacks.join(', ') : 'no known stack found'}`);
  if (facts.checks.length) console.log(`Checks found: ${facts.checks.map((c) => `${c.command} (${c.source})`).join(', ')}`);
  console.log('');
  for (const s of list) console.log(`${LABEL[s.state].padEnd(9)}${s.title}`);
  console.log('');
  if (next) {
    console.log(`Next: ${next.title}`);
    console.log(`  Why: ${next.why}`);
    console.log(`  How: ${next.how}`);
  } else {
    console.log('Nothing waits on you here. An approved task runs when the queue starts it.');
  }
  // CI that has no step to take gets its reason here, so nobody wonders why it was left out.
  for (const s of list.filter((x) => x.state === 'later' && x.key === 'ci' && !x.task)) console.log(`\nCI: ${s.why}`);
  if (knownBugs.open || knownBugs.done)
    console.log(`\nGates from known bugs: ${knownBugs.proposed} waiting for your yes, ${knownBugs.open - knownBugs.proposed} approved, ${knownBugs.done} done (${CLI} gate list).`);
  console.log(`\nNothing here starts by itself, and you can stop at any step. ${CLI} doctor has the full health check.`);
}

function gates() {
  needsGit();
  const facts = readFacts();
  const lists = K.gateLists(facts.checks);
  if (facts.hasGates) {
    console.log('Gates are already set in queue.config.json. Nothing changed.');
    return;
  }
  if (!facts.checks.length) {
    console.log(`No check commands found. ${CLI} kickstart add gates proposes a task that adds a first one.`);
    return;
  }
  console.log(`gates.quick (before every delivery): ${lists.quick.join(', ') || 'none'}`);
  console.log(`gates.full (before a push): ${lists.full.join(', ')}`);
  if (!a.includes('--apply')) {
    console.log(`Nothing written. ${CLI} kickstart gates --apply writes these to queue.config.json.`);
    return;
  }
  const file = KK.configFile(MAIN_TREE);
  let own = {};
  if (fs.existsSync(file)) {
    try {
      own = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      die(`queue.config.json does not parse (${e.message}). Nothing written.`);
    }
  }
  fs.writeFileSync(file, `${JSON.stringify({ ...own, gates: { ...own.gates, ...lists } }, null, 2)}\n`);
  console.log(`Written to queue.config.json. ${CLI} gates --full runs them now, so you can see whether they pass today.`);
}

/** Writing needs a project root. Without git there is none, and a write would land in the plugin's own folder. */
function needsGit() {
  if (NO_PROJECT_ROOT) die('This folder is not under git yet, and that step comes first. Ask Claude to run "git init" and make a first commit.');
}

/** Full mode needs a project for the tasks; lite mode has its own. */
export function ensureProject() {
  if (LM.isLite(CONFIG) || read().projects?.cicd) return;
  const r = spawnSync(process.execPath, [QUEUE_PATH, 'project', 'cicd', '--title', 'CI setup', '--prefix', 'KS-', 'GATE-'], { encoding: 'utf8' });
  if (r.status !== 0) die(`Could not create the project cicd: ${r.stderr || r.stdout}`);
}

/** Adds one task through `ravenseat add`, under its lock and its checks. { ok, output } */
export function addTask(task, { approved = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-kickstart-'));
  const taskFile = path.join(tmp, 'task.json');
  try {
    fs.writeFileSync(taskFile, JSON.stringify(task));
    const r = spawnSync(process.execPath, [QUEUE_PATH, 'add', '--file', taskFile, ...(approved ? ['--approved'] : [])], { encoding: 'utf8' });
    return { ok: r.status === 0, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function add(named) {
  needsGit();
  if (!fs.existsSync(FILE)) die(`The queue does not exist yet, so a task has nowhere to go. Run: ${CLI} init`);
  const facts = readFacts();
  const list = K.steps({ facts, tasks: queueTasks() });
  const step = named ? list.find((s) => s.key === named) : K.nextStep(list);
  if (named && !step) die(`Unknown step ${named}. Use: gates, secrets or ci`);
  if (!step) {
    console.log('Nothing to propose: every step is done, queued, declined or waiting on an earlier one.');
    return;
  }
  if (!step.task) {
    console.log(`${step.title}: this is not a task. ${step.how || step.why}`);
    return;
  }
  if (step.state !== 'next') {
    const reasons = { done: 'it is already in place', queued: `${step.taskId} is already in the queue`, declined: `${step.taskId} was cancelled`, later: 'an earlier step comes first' };
    console.log(`Not proposed: ${reasons[step.state]}.`);
    return;
  }
  ensureProject();
  const task = { ...K.taskFor(step.task, facts), ...(LM.isLite(CONFIG) ? {} : { project: 'cicd' }) };
  const r = addTask(task);
  console.log(r.output);
  if (!r.ok) process.exit(1);
  console.log(`About ${task.content_min} min of agent work, and it uses tokens. ${CLI} approve ${task.id} (or Approve on the board) lets it run; ${CLI} set ${task.id} cancelled declines it.`);
}

/** `ravenseat kickstart ...` (the usage is at the top of queue.mjs). */
export function cmdKickstart() {
  const sub = a[1];
  if (!sub || sub === '--json') return overview();
  if (sub === 'gates') return gates();
  if (sub === 'add') return add(a[2] && !a[2].startsWith('--') ? a[2] : null);
  return die('Use: ravenseat kickstart [--json] | ravenseat kickstart gates [--apply] | ravenseat kickstart add [gates|secrets|ci]');
}
