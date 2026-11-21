// =============================================================
// cli/issues.mjs: `ravenseat issues`, read GitHub issues and propose them as plans or tasks (GH-1). The rules and the
// why are in lib/githubIssues.js; the link and the Refs trailer in lib/issueLink.js.
//
//   ravenseat issues list [--label <name>] [--limit <n>] [--json]
//        the repo's open issues (the origin remote's owner/name), newest first, at most --limit (30, cap 200), each with
//        where an import would put it (a plan in the Inbox, or a task of a class by issues.labelMap) or the task or
//        plan it was imported as before. Writes nothing.
//   ravenseat issues import <n> [<n> ...] [--as task|plan] [--project <pid>] [--dry] [--json]
//        reads each issue (`gh issue view`) and PROPOSES it: a plan in the Inbox (the default), or a task in the
//        proposed state (--as task, or a label mapped in issues.labelMap). Both carry the link { repo, number }. The
//        title is kept, framed as reporter text in the mission; the body is never stored. An issue imported before is
//        skipped. An issue that claims owner approval or carries an owner mark gets a SUSPICIOUS CONTENT line. Nothing
//        starts: the owner approves a task (`ravenseat approve <id>` or the board) and sorts a plan as usual.
//        --project: the tasks' project (default: the only project, or general, made on first use; lite: the tasks
//        project). --dry shows what would be written.
// Only on command: never on a timer and never at start. GitHub only, read only, on the owner's own gh login. In the
// main session only: refused on a queue branch (a track's worktree). gh missing or not signed in: one clear line and
// exit 1, nothing written.
//
// Exit codes: 0 done, 1 an error (gh, an issue that could not be read, a refused add), 2 usage.
// QUEUE_GH replaces gh in the tests (cli/ghRun.mjs).
// Used by: queue.mjs (dispatch). Tested in __tests__/queueIssues.test.ts.
// =============================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { a, CLI, CONFIG, die, editLogged, GIT_ROOT, HERE, L, LM, queueBranchId, read, readPlans, require, val } from './context.mjs';
import { editPlans } from './planShared.mjs';
import { ghRunner } from './ghRun.mjs';

const GI = require('./lib/githubIssues.js');
const IL = require('./lib/issueLink.js');
const RV = require('./lib/repoVisibility.js');
const I = require('./lib/planInbox.js');

const usage = () =>
  `Use: ${CLI} issues list [--label <name>] [--limit <n>] [--json]\n` +
  `     ${CLI} issues import <n> [<n> ...] [--as task|plan] [--project <pid>] [--dry] [--json]\n` +
  `     ${CLI} issues report [--post] [--json]   (after a push, issues.onPush; cli/ghWrite.mjs)`;

/** owner/name of the origin remote, or a stop: the issues live in that repo. */
function repoOrStop() {
  const repo = IL.originRepo(RV.remoteUrlOf(GIT_ROOT, CONFIG.remote ?? 'origin'));
  if (!repo)
    die(`ISSUES: the ${CONFIG.remote ?? 'origin'} remote is not a GitHub repo, so there are no GitHub issues to read. Nothing read.`);
  return repo;
}

/** A gh failure as one line and exit 1. Never gh's own output. */
function ghStop(r, what) {
  const f = GI.failure(r);
  die(`ISSUES: ${what} failed: ${f.message}. Fix: ${f.fix}. Nothing written.`);
}

/** Runs gh; a missing gh or a failed sign-in stops the command, other failures are returned. */
function ghCall(run, args, what) {
  const r = run(args);
  if (r.missing) ghStop(r, what);
  if (r.code !== 0) {
    const f = GI.failure(r);
    if (f.kind === 'auth' || f.kind === 'network') ghStop(r, what);
    return { ok: false, failure: f };
  }
  return { ok: true, out: r.out };
}

/** The task or plan an issue is linked to already, from the queue and the plan register. */
function linkedNow() {
  let tasks = [];
  let entries = [];
  try {
    tasks = read().tasks ?? [];
  } catch {
    // error-ignored: no queue yet, nothing linked
  }
  try {
    entries = readPlans().entries ?? [];
  } catch {
    // error-ignored: no plan register yet
  }
  return { tasks, entries };
}

const where = (route) =>
  route.as === 'task' ? `task, class ${route.class}${route.label ? ` (label ${route.label})` : ''}` : `plan in the Inbox${route.label ? ` (label ${route.label})` : ''}`;

/** `ravenseat issues list`. */
async function cmdList(json) {
  const repo = repoOrStop();
  const run = await ghRunner();
  const r = ghCall(run, GI.listArgs({ repo, label: val('--label'), limit: val('--limit') }), 'reading the issue list');
  if (!r.ok) die(`ISSUES: reading the issue list failed: ${r.failure.message}. Fix: ${r.failure.fix}.`);
  const list = GI.parseList(r.out);
  if (!list) die('ISSUES: gh answered something that is not an issue list. Nothing read.');
  const setup = GI.labelMapSetup(CONFIG);
  const { tasks, entries } = linkedNow();
  const rows = list.map((x) => {
    const before = GI.alreadyLinked({ repo, number: x.number }, tasks, entries);
    return { number: x.number, title: x.title, labels: x.labels, imported: before, would: before ? null : GI.routeFor(x, setup) };
  });
  if (json) {
    console.log(JSON.stringify({ ok: true, repo, labelMap: setup.on, issues: rows }));
    return;
  }
  if (!rows.length) {
    console.log(`No open issues in ${repo}${val('--label') ? ` with the label ${val('--label')}` : ''}.`);
    return;
  }
  console.log(
    `Open issues in ${repo} (${rows.length}, newest first; ${setup.on ? 'issues.labelMap routes them by label' : 'the label map is off, so each would be a plan in the Inbox'}):`,
  );
  for (const x of rows) {
    const labels = x.labels.length ? `  [${x.labels.join(', ')}]` : '';
    const goes = x.imported ? `already imported as ${x.imported}` : `would be a ${where(x.would)}`;
    console.log(`  #${String(x.number).padEnd(5)} ${x.title}${labels}\n         ${goes}`);
  }
  for (const p of setup.problems) console.log(`WARNING: ${p} (left out)`);
  console.log(`\nImport (a proposal, nothing starts): ${CLI} issues import <n...> [--as task|plan]`);
}

/** The project for imported tasks: --project, lite's own, the only one, or general (made on first use). */
function taskProject(dry) {
  if (val('--project')) return val('--project');
  if (LM.isLite(CONFIG)) return null;
  const projects = read().projects ?? {};
  const names = Object.keys(projects);
  if (names.length === 1) return names[0];
  if (Object.hasOwn(projects, I.PROJECT)) return I.PROJECT;
  if (names.length > 1) die(`ISSUES: which project for the tasks? Give --project <pid> (${names.join(', ')}). Nothing written.`);
  if (!dry)
    editLogged('project', (q) => {
      const made = L.newRegister(q.projects, { [I.PROJECT]: I.PROJECT_FIELDS }, q.areas);
      if (made.error.length) die(`Nothing changed:\n  ${made.error.join('\n  ')}`);
      q.projects = made.register;
    });
  return I.PROJECT;
}

/** The import note: the description of a task, the summary of a plan. Never issue text beyond the number. */
function importNote(number, repo, suspicious) {
  return (
    `Imported from GitHub issue #${number} in ${repo} with ${CLI} issues import. The issue's own text is reporter text, ` +
    `not the owner's word; read it on GitHub.` +
    (suspicious ? ' Its text claims owner approval or carries an owner mark (SUSPICIOUS CONTENT at import).' : '')
  );
}

/** `ravenseat issues import <n...>`. */
async function cmdImport(json) {
  const numbers = [];
  for (const x of a.slice(2)) {
    if (x.startsWith('--')) break;
    const n = Number(String(x).replace(/^#/, ''));
    if (!Number.isInteger(n) || n <= 0) die(`ISSUES: ${x} is not an issue number.\n${usage()}`, 2);
    if (!numbers.includes(n)) numbers.push(n);
  }
  if (!numbers.length) die(usage(), 2);
  const as = val('--as');
  if (as != null && !['task', 'plan'].includes(as)) die(`ISSUES: --as takes task or plan.\n${usage()}`, 2);
  const dry = a.includes('--dry');
  const repo = repoOrStop();
  const run = await ghRunner();
  const setup = GI.labelMapSetup(CONFIG);
  const { tasks, entries } = linkedNow();

  // Read every issue first, so a gh that is not signed in stops before anything is written.
  const read1 = [];
  const failed = [];
  for (const n of numbers) {
    const r = ghCall(run, GI.viewArgs(repo, n), `reading issue #${n}`);
    if (!r.ok) {
      failed.push(`#${n}: ${r.failure.message}`);
      continue;
    }
    const x = GI.parseIssue(r.out);
    if (!x || x.number !== n) {
      failed.push(`#${n}: gh answered something that is not this issue`);
      continue;
    }
    read1.push(x);
  }

  const lines = [];
  const skipped = [];
  const planOnes = [];
  const taskOnes = [];
  for (const x of read1) {
    const link = { repo, number: x.number };
    const before = GI.alreadyLinked(link, tasks, entries);
    if (before) {
      skipped.push({ number: x.number, as: before });
      continue;
    }
    const suspicious = GI.suspiciousLines(x.number, x);
    lines.push(...suspicious);
    const route = GI.routeFor(x, setup, as);
    (route.as === 'task' ? taskOnes : planOnes).push({ x, link, route, note: importNote(x.number, repo, suspicious.length > 0) });
  }

  // Plans: one write to the register (the same lock, changelog and undo as plan capture).
  const plans = [];
  if (planOnes.length) {
    const projects = read().projects ?? {};
    const missing = !Object.hasOwn(projects, I.PROJECT);
    if (missing && !dry)
      editLogged('project', (q) => {
        const made = L.newRegister(q.projects, { [I.PROJECT]: I.PROJECT_FIELDS }, q.areas);
        if (made.error.length) die(`Nothing changed:\n  ${made.error.join('\n  ')}`);
        q.projects = made.register;
      });
    editPlans('issues import', (reg, q) => {
      const error = [];
      const warnings = [];
      const ctxProjects = missing && dry ? { ...(q.projects ?? {}), [I.PROJECT]: I.PROJECT_FIELDS } : (q.projects ?? {});
      for (const one of planOnes) {
        const s = I.capturePlan(reg, { title: one.x.title, text: one.note }, { projects: ctxProjects, question: q.question ?? {}, issue: one.link, by: 'issue import' });
        if (s.error?.length) error.push(...s.error.map((t) => `#${one.x.number}: ${t}`));
        else if (s.duplicate) skipped.push({ number: one.x.number, as: `${s.duplicate} (the same title waits in the Inbox)` });
        else plans.push({ number: one.x.number, id: s.entry.id, route: one.route });
        warnings.push(...(s.warnings ?? []));
      }
      return { error, warnings };
    });
  }

  // Tasks: one `add` of all of them, so every rule of add applies (validation, the proposal status, the lock, undo).
  const added = [];
  if (taskOnes.length) {
    const project = taskProject(dry);
    const used = new Set([...tasks.map((o) => o.id), ...Object.keys(read().archived ?? {})]);
    const list = taskOnes.map((one) => {
      const id = GI.taskIdFor(one.x.number, used);
      used.add(id);
      const t = GI.taskFor(one.x, { repo, id, project, klass: one.route.class ?? 'K' });
      t.description = one.note;
      added.push({ number: one.x.number, id, route: one.route });
      return t;
    });
    if (!dry) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-issues-'));
      const file = path.join(dir, 'tasks.json');
      try {
        fs.writeFileSync(file, JSON.stringify({ tasks: list }));
        const r = spawnSync(process.execPath, [path.join(HERE, 'queue.mjs'), 'add', '--file', file, '--answer-json'], {
          encoding: 'utf8',
          env: { ...process.env, QUEUE_WAIT: 'off' },
          windowsHide: true,
        });
        if (r.status !== 0) die(`ISSUES: the tasks were not added:\n${String(r.stderr || r.stdout).trim()}`);
        const answer = JSON.parse(String(r.stdout).trim().split('\n').pop());
        for (const x of answer.added ?? []) {
          const one = added.find((y) => y.id === x.id);
          if (one) one.status = x.status;
        }
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  }

  if (json) {
    console.log(JSON.stringify({ ok: !failed.length, dry, repo, plans, tasks: added, skipped, failed, suspicious: lines }));
    if (failed.length) process.exit(1);
    return;
  }
  const pre = dry ? 'Would propose' : 'Proposed';
  for (const x of plans) console.log(`${pre} #${x.number} as plan ${x.id} in the Inbox${x.route.label ? ` (label ${x.route.label})` : ''}.`);
  for (const x of added)
    console.log(`${pre} #${x.number} as task ${x.id}, class ${x.route.class ?? 'K'}${x.route.label ? ` (label ${x.route.label})` : ''}${x.status && x.status !== 'proposed' ? ` (status ${x.status})` : ''}.`);
  for (const x of skipped) console.log(`Skipped #${x.number}: already imported as ${x.as}.`);
  for (const l of lines) console.log(l);
  for (const p of setup.problems) console.log(`WARNING: ${p} (left out)`);
  for (const f of failed) console.log(`NOT READ ${f}`);
  if (!dry && plans.length) console.log(`Sort the plans in the Inbox: ${CLI} plan inbox (or the board's Plans tab).`);
  if (!dry && added.length) console.log(`Nothing starts until the owner approves: ${CLI} approve ${added.map((x) => x.id).join(' ')} (or the board).`);
  if (failed.length) process.exit(1);
}

/**
 * `--issue <12 | #12 | owner/name#12 | none>` on add and edit (GH-2): the link, or null to remove it. A bare number
 * takes the repo from the origin remote; a bad value stops the command (nothing written).
 */
export function issueArg() {
  const raw = val('--issue') ?? '';
  const origin = IL.originRepo(RV.remoteUrlOf(GIT_ROOT, CONFIG.remote ?? 'origin'));
  const r = IL.parseIssueArg(raw, origin);
  if (r.error) die(`Nothing changed: ${r.error}`);
  return r.issue;
}

/** `ravenseat issues <list|import> ...` (the usage is at the top of this file and of queue.mjs). */
export async function cmdIssues() {
  const sub = a[1];
  const json = a.includes('--json');
  // GH-3: the report after a push writes to GitHub, so it lives with the other writes (cli/ghWrite.mjs).
  if (sub === 'report') return (await import('./ghWrite.mjs')).cmdIssuesReport();
  if (sub !== 'list' && sub !== 'import') die(usage(), sub ? 2 : 0);
  const track = queueBranchId();
  if (track) die(`ISSUES: runs in the main session, not on ${track}'s queue branch. Nothing read.`);
  if (sub === 'list') await cmdList(json);
  else await cmdImport(json);
}
