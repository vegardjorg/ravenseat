// =============================================================
// cli/ciWatch.mjs: `cq push-check --watch-ci <sha>`, the optional CI watch after a batch push (lib/ciWatch.js holds the
// pure parts and the why).
//
// Off by default (config().push.ciWatch "off"); "github" turns it on and needs the gh CLI. The orchestrator starts it in
// the background right after a batch push (run_in_background), as with `cq wait`: it polls `gh run list --commit <sha>`
// every --interval seconds (config().push.ciWatchIntervalSec) and exits when the runs are done.
//
// Exit codes (as cq wait where they overlap):
//   0  green, an infrastructure failure (an owner question, nothing frozen), off, or no CI run for the commit at all
//   9  a check failed: the fix task CI-<sha7> and a red base (as the base gate, EXIT_RED_BASE)
//   10 timeout (--timeout minutes, config().push.ciWatchTimeoutMin): the runs were not done in time
//   1  error (no gh, unknown sha)
// Never twice: a second watch of the same sha (a rerun) finds the task or the question and adds nothing.
//
// QUEUE_CI_GH: a module whose default export (args) => { code, out } replaces gh (the tests; never set it otherwise).
// =============================================================

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { a, BASE, CONFIG, die, edit, FOLDER, GIT_ROOT, L, require, TIME_LOG, val } from './context.mjs';
import { BASE_SETUP, baseTip, readHealth, recordVerdict } from './baseHealth.mjs';

const CW = require('./lib/ciWatch.js');
const BH = require('./lib/baseHealth.js');
const TL = require('./lib/timeLogRows.js');
const ER = require('./lib/eventRows.js');

const EXIT_RED = BH.EXIT_RED_BASE ?? 9;
const EXIT_TIMEOUT = 10;

const SETUP = CW.ciWatchSetup(CONFIG);
if (!SETUP.enabled) {
  console.log('CI WATCH: off (push.ciWatch is off); nothing watched. Turn it on with push.ciWatch "github" in queue.config.json.');
  process.exit(0);
}

// gh: the real CLI, or the test module.
let gh;
if (process.env.QUEUE_CI_GH) {
  const mod = await import(pathToFileURL(path.resolve(process.env.QUEUE_CI_GH)).href);
  gh = (args) => mod.default(args);
} else {
  const r = spawnSync('gh', ['--version'], { encoding: 'utf8', shell: false });
  if (r.error || r.status !== 0) die('CI WATCH: gh (the GitHub CLI) was not found; install it and run gh auth login. Nothing watched.');
  gh = (args) => {
    const x = spawnSync('gh', args, { encoding: 'utf8', cwd: GIT_ROOT, maxBuffer: 64 * 1024 * 1024 });
    return { code: x.status ?? 1, out: `${x.stdout ?? ''}` };
  };
}

const given = val('--watch-ci');
if (!given || given.startsWith('--')) die('Use: cq push-check --watch-ci <sha> [--interval <sec>] [--timeout <min>]');
const resolved = spawnSync('git', ['-C', GIT_ROOT, 'rev-parse', '-q', '--verify', `${given}^{commit}`], { encoding: 'utf8' });
const sha = String(resolved.stdout ?? '').trim();
if (resolved.status !== 0 || !sha) die(`CI WATCH: unknown commit ${given} (git rev-parse). Nothing watched.`);
const sha7 = sha.slice(0, 7);

const num = (name, standard) => {
  const v = Number(val(name));
  return a.includes(name) && Number.isFinite(v) && v > 0 ? v : standard;
};
const intervalMs = num('--interval', SETUP.intervalSec) * 1000;
const timeoutMs = num('--timeout', SETUP.timeoutMin) * 60_000;
const noRunsMs = Math.min(SETUP.noRunsMin * 60_000, timeoutMs);

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const logRow = (row) => {
  try {
    TL.appendRows(TIME_LOG, ER.ciWatchRow({ time: new Date().toISOString(), sha, ...row }));
  } catch {
    // error-ignored: measurement only
  }
};

console.log(`CI WATCH: ${BASE} at ${sha7}, polling every ${intervalMs / 1000}s for at most ${timeoutMs / 60_000} min.`);

// The poll loop.
const started = Date.now();
let summary = null;
let runs = [];
for (;;) {
  const r = gh(['run', 'list', '--commit', sha, '--json', CW.RUN_FIELDS, '--limit', '50']);
  runs = r.code === 0 ? CW.parseRuns(r.out) : [];
  summary = CW.summarize(runs);
  if (summary.phase === 'done') break;
  const waited = Date.now() - started;
  if (summary.phase === 'none' && waited >= noRunsMs) {
    console.log(`CI WATCH: no CI run for ${sha7} after ${Math.round(waited / 1000)}s; nothing to watch (no CI for this push?).`);
    logRow({ verdict: 'none' });
    process.exit(0);
  }
  if (waited >= timeoutMs) {
    console.log(`TIMEOUT: CI for ${sha7} was not done after ${timeoutMs / 60_000} min (${summary.total} run(s)). Start the watch again later.`);
    logRow({ verdict: 'timeout', runs: summary.total });
    process.exit(EXIT_TIMEOUT);
  }
  sleep(intervalMs);
}

if (!summary.red.length) {
  console.log(`CI GREEN: ${summary.total} run(s) for ${sha7} on ${BASE} are green.`);
  logRow({ verdict: 'green', runs: summary.total });
  process.exit(0);
}

// Red: only the failed jobs' log tail per red run, redacted, into the report file.
const items = summary.red.map((run) => {
  const id = String(run.databaseId ?? '');
  const log = id ? gh(['run', 'view', id, '--log-failed']) : { code: 1, out: '' };
  let jobs = null;
  if (id) {
    const j = gh(['run', 'view', id, '--json', 'jobs']);
    try {
      jobs = j.code === 0 ? (JSON.parse(j.out)?.jobs ?? null) : null;
    } catch {
      jobs = null;
    }
  }
  const text = log.code === 0 ? log.out : '';
  const c = CW.classify({ run, log: text, jobs });
  return { run, kind: c.kind, reason: c.reason, tail: CW.logTail(text) };
});
const verdict = CW.verdictOf(items);
fs.mkdirSync(FOLDER, { recursive: true });
const reportFile = path.join(FOLDER, `ci-${sha7}.md`);
fs.writeFileSync(reportFile, CW.report({ sha, branch: BASE, verdict, items, total: summary.total }));

if (verdict === 'infra') {
  const q = CW.infraQuestion({ sha, branch: BASE, items, reportFile });
  const r = edit((queue) => {
    if (queue.question?.[q.id]) return { existed: true };
    const s = L.setQuestion(queue, { [q.id]: q.question });
    return { existed: false, error: s.error };
  });
  if (r.existed) console.log(`${q.id} is already asked; nothing added.`);
  else if (r.error?.length) console.log(`WARNING: the owner question ${q.id} could not be set: ${r.error.join('; ')}.`);
  else console.log(`Owner question ${q.id} set.`);
  console.log(`CI INFRA: ${items.map((x) => `${x.run.workflowName ?? x.run.name} #${x.run.databaseId}: ${x.reason}`).join('; ')}. Nothing was frozen. Report: ${reportFile}`);
  logRow({ verdict: 'infra', runs: summary.total, red: items.length, question: q.id });
  process.exit(0);
}

// A failed check: one fix task, and the base red at its tip with that task as the fix task.
const checks = items.filter((x) => x.kind === 'check').map((x) => x.run);
const added = edit((queue) => {
  const tasks = queue.tasks ?? (queue.tasks = []);
  const id = CW.taskId(sha);
  const open = tasks.find((t) => t.id === id);
  if (open) {
    open.remarks = [...(open.remarks ?? []), `${new Date().toISOString()} ci watch: still red at ${sha7} (report ${reportFile})`];
    return { id, existed: true };
  }
  const projects = Object.keys(queue.projects ?? {});
  const task = CW.fixTask({ sha, branch: BASE, runs: checks, reportFile, project: projects.length === 1 ? projects[0] : null });
  const errors = L.validate(task, tasks);
  if (errors.length) return { id, error: errors };
  task.status = L.statusAtAdd(task, tasks);
  task.added_at = new Date().toISOString();
  tasks.push(task);
  return { id, existed: false };
});
if (added.existed) console.log(`${added.id} already exists; a remark was added, no second task.`);
else if (added.error?.length) console.log(`WARNING: the fix task ${added.id} could not be added: ${added.error.join('; ')}. Add one by hand.`);
else console.log(`Fix task ${added.id} added (value 10, waiting).`);

// The base: red at the base tip when the watched commit is on it (the tip or an ancestor), as the base gate does.
const tip = baseTip();
const onBase =
  tip && (tip === sha || spawnSync('git', ['-C', GIT_ROOT, 'merge-base', '--is-ancestor', sha, tip]).status === 0);
if (!BASE_SETUP.enabled) console.log('NOTE: the base gate is off, so the base is not marked red; the fix task is the record.');
else if (!onBase) console.log(`NOTE: ${sha7} is not on ${BASE}; the base is not marked red.`);
else if (!added.error?.length) {
  const current = readHealth().current;
  const already = current?.tip === tip && current.status === 'red' && current.fix_task === added.id;
  if (!already)
    recordVerdict({
      tip,
      ok: false,
      file: reportFile,
      fixTask: added.id,
      run: { failed: `CI: ${checks.map((r) => r.workflowName ?? r.name).join(', ')}` },
      wasRed: current?.tip === tip && current.status === 'red' ? current : null,
      note: `ci watch: CI red at ${sha7}`,
    });
}
console.log(`CI RED: a check failed on ${BASE} at ${sha7} (${checks.length} run(s)). Fix task ${added.id}; cq merge lets only it through. Report: ${reportFile}`);
logRow({ verdict: 'check', runs: summary.total, red: items.length, task: added.id });
process.exit(EXIT_RED);
