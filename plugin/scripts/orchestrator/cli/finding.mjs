// =============================================================
// cli/finding.mjs: `cq finding`, what a track reports when it notices something outside its scope.
//
//   cq finding "<title>" [--detail "..."] [--task <id>] [--files a,b] [--project <pid>] [--dry] [--json]
//        an idea in the plan register (PL-FINDING-<n>, priority later), linked to the reporting task and deduplicated
//        on the normalized title. --task defaults to the task whose queue branch the worktree is on. The project is
//        --project, otherwise the task's project, otherwise the only project in the register.
//   cq finding list [--all] [--json]
//        the findings nobody has triaged yet (--all: every finding)
// The rules (where it lands, dedup, when it stops being new) are in lib/queueFindings.js. The write goes through
// cli/planShared.mjs editPlans: the same lock, changelog and `cq plan undo` as every plan command.
//
// Used by: queue.mjs (dispatch).
// Tested in: lib/__tests__/queueFindings.test.ts.
// =============================================================

import { execFileSync } from 'node:child_process';

import { a, CQ, cut, die, L, MAIN_TREE, PREFIX, readPlans, readQueueForPlan, ROOT, require, val, WIDTH } from './context.mjs';
import { editPlans, planAnswer } from './planShared.mjs';

const FI = require('./lib/queueFindings.js');

/** The task id from the branch the current worktree is on (<branchPrefix><id>), or null. */
function taskFromBranch(tasks) {
  if (ROOT === MAIN_TREE) return null;
  let branch = null;
  try {
    branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
  if (!branch?.startsWith(PREFIX)) return null;
  const id = branch.slice(PREFIX.length);
  return tasks.some((o) => o.id === id) ? id : null;
}

/** The new findings line for pulse and show, or null; never throws (an unreadable plans.json is not this view's problem). */
export function findingsLineNow() {
  try {
    return FI.findingsLine(FI.findingsSummary(readPlans(), readQueueForPlan().tasks ?? []), CQ);
  } catch {
    return null;
  }
}

/** The { new, ids } summary for `cq state`; empty when the register cannot be read. */
export function findingsStateNow() {
  try {
    return FI.findingsSummary(readPlans(), readQueueForPlan().tasks ?? []);
  } catch {
    return { new: 0, ids: [] };
  }
}

/** `cq finding list [--all] [--json]`. */
function findingList() {
  const rows = FI.findingRows(readPlans(), readQueueForPlan().tasks ?? [], { all: a.includes('--all') });
  if (a.includes('--json')) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (!rows.length) {
    console.log(a.includes('--all') ? 'No findings in the plan register.' : `No new findings (${CQ} finding list --all shows every one).`);
    return;
  }
  for (const r of rows) {
    const from = r.tasks.length ? ` from ${r.tasks.join(', ')}` : '';
    const times = r.count > 1 ? ` x${r.count}` : '';
    console.log(cut(`${r.new ? 'NEW ' : '    '}${r.id.padEnd(16)} ${r.priority.padEnd(6)} ${r.title}${from}${times}`, WIDTH));
    if (r.files.length) console.log(cut(`${' '.repeat(21)}files: ${r.files.join(', ')}`, WIDTH));
  }
  console.log(
    `Triage: ${CQ} plan prioritize <id> now|owner|drop --reason "...", ${CQ} plan edit <id> --field maturity=investigated, ` +
      `or tasks with ${CQ} add --file <f> --plan <id>.`,
  );
}

/** `cq finding` (the usage is at the top of queue.mjs). */
export function cmdFinding() {
  if (a[1] === 'list') return findingList();
  const title = a[1];
  const usage = `${CQ} finding "<title>" [--detail "..."] [--task <id>] [--files a,b] [--project <pid>]`;
  if (!title || title.startsWith('--')) die(`Use: ${usage}`);
  const queue = readQueueForPlan();
  const tasks = queue.tasks ?? [];
  const task = val('--task') ?? taskFromBranch(tasks);
  if (task && !tasks.some((o) => o.id === task)) die(`Unknown task ${task} (--task takes a queue task id).`);
  const parsed = FI.parseFiles(val('--files'));
  if (parsed.error.length) die(parsed.error.join('\n'));
  // The project: --project, the task's project when it is registered, otherwise the only project there is.
  const projects = queue.projects ?? {};
  const own = task ? L.projectFor(tasks.find((o) => o.id === task), projects) : null;
  const names = Object.keys(projects);
  const project =
    val('--project') ?? (own && Object.hasOwn(projects, own) ? own : names.length === 1 ? names[0] : null);
  if (!project)
    die(
      `Which project? ${task ? `${task} has no registered project. ` : ''}Give --project <pid> (${names.join(', ') || `none yet: ${CQ} project <pid> --title "..."`}).`,
    );
  const r = editPlans('finding', (reg, q) =>
    FI.recordFinding(
      reg,
      { title, detail: val('--detail') ?? null, task, files: parsed.files, project },
      { projects: q.projects ?? {}, question: q.question ?? {} },
    ),
  );
  if (a.includes('--json')) return planAnswer(r, '');
  if (r.duplicate && r.finding === false) {
    console.log(`Already in the plan register as ${r.duplicate} ("${r.entry.title}"); nothing changed.`);
    return;
  }
  if (r.duplicate) {
    const fi = r.entry.finding;
    console.log(
      `${r.dry ? 'Preview (nothing written): ' : ''}Already reported as ${r.duplicate}: now ${fi.count} report(s)` +
        `${fi.tasks.length ? ` from ${fi.tasks.join(', ')}` : ''}. Nothing new created.`,
    );
    return;
  }
  console.log(
    `${r.dry ? 'Preview (nothing written): ' : ''}FINDING ${r.entry.id}: "${r.entry.title}"` +
      `${task ? ` from ${task}` : ''}, an idea in the plan register (project ${project}). ` +
      'Do not fix it in this track; the orchestrator triages it.',
  );
  for (const x of r.warnings ?? []) console.log(`WARNING: ${x}`);
}
