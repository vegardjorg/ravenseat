// =============================================================
// cli/finding.mjs: `cq finding`, what a track reports when it notices something outside its scope.
//
//   cq finding "<title>" [--detail "..."] [--task <id>] [--cause <id>[,<id>]] [--files a,b] [--project <pid>] [--dry] [--json]
//        an idea in the plan register (PL-FINDING-<n>, priority later), linked to the reporting task and deduplicated
//        on the normalized title. --task defaults to the task whose queue branch the worktree is on. The project is
//        --project, otherwise the task's project, otherwise the only project in the register. With no project at all
//        (a fresh project; an agent may not run cq project) it creates one called general. --cause names the
//        merged task(s) the finding is a defect of (a post-merge defect in the right-first-time figure).
//   cq finding list [--all] [--json]
//        the findings nobody has triaged yet (--all: every finding)
// The rules (where it lands, dedup, when it stops being new) are in lib/queueFindings.js. The write goes through
// cli/planShared.mjs editPlans: the same lock, changelog and `cq plan undo` as every plan command.
//
// Used by: queue.mjs (dispatch).
// Tested in: lib/__tests__/queueFindings.test.ts.
// =============================================================

import { a, CQ, cut, die, editLogged, L, queueBranchId, readPlans, readQueueForPlan, require, val, WIDTH } from './context.mjs';
import { editPlans, planAnswer } from './planShared.mjs';

const FI = require('./lib/queueFindings.js');

// Where a finding lands while the project has no projects registered yet.
const FIRST_PROJECT = 'general';
const FIRST_PROJECT_FIELDS = { title: 'General' };

/** The task id from the branch the current worktree is on (<branchPrefix><id>), or null. */
function taskFromBranch(tasks) {
  const id = queueBranchId();
  return id && tasks.some((o) => o.id === id) ? id : null;
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
    const from = (r.tasks.length ? ` from ${r.tasks.join(', ')}` : '') + (r.causes.length ? `, caused by ${r.causes.join(', ')}` : '');
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
  const usage = `${CQ} finding "<title>" [--detail "..."] [--task <id>] [--cause <id>[,<id>]] [--files a,b] [--project <pid>]`;
  if (!title || title.startsWith('--')) die(`Use: ${usage}`);
  const queue = readQueueForPlan();
  const tasks = queue.tasks ?? [];
  const task = val('--task') ?? taskFromBranch(tasks);
  if (task && !tasks.some((o) => o.id === task)) die(`Unknown task ${task} (--task takes a queue task id).`);
  const causes = [...new Set(String(val('--cause') ?? '').split(',').map((x) => x.trim()).filter(Boolean))];
  const unknown = causes.filter((c) => !tasks.some((o) => o.id === c));
  if (unknown.length) die(`Unknown task ${unknown.join(', ')} (--cause takes the id(s) of the merged task(s) that caused it).`);
  const parsed = FI.parseFiles(val('--files'));
  if (parsed.error.length) die(parsed.error.join('\n'));
  // The project: --project, the task's project when it is registered, otherwise the only project there is.
  const projects = queue.projects ?? {};
  const own = task ? L.projectFor(tasks.find((o) => o.id === task), projects) : null;
  const names = Object.keys(projects);
  const none = !names.length && val('--project') == null;
  const project =
    val('--project') ?? (own && Object.hasOwn(projects, own) ? own : names.length === 1 ? names[0] : none ? FIRST_PROJECT : null);
  if (!project)
    die(
      `Which project? ${task ? `${task} has no registered project. ` : ''}Give --project <pid> (${names.join(', ') || `none yet: ${CQ} project <pid> --title "..."`}).`,
    );
  // The first finding in a fresh project also registers the project, so it can be triaged like any other. --dry writes nothing.
  if (none && !a.includes('--dry'))
    editLogged('project', (q) => {
      const made = L.newRegister(q.projects, { [FIRST_PROJECT]: FIRST_PROJECT_FIELDS }, q.areas);
      if (made.error.length) die(`Nothing changed:\n  ${made.error.join('\n  ')}`);
      q.projects = made.register;
    });
  const r = editPlans('finding', (reg, q) =>
    FI.recordFinding(
      reg,
      { title, detail: val('--detail') ?? null, task, files: parsed.files, causes, project },
      { projects: none ? { ...q.projects, [FIRST_PROJECT]: FIRST_PROJECT_FIELDS } : (q.projects ?? {}), question: q.question ?? {} },
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
  // A project without a module is for the owner to sort out, not for the agent reporting a finding.
  for (const x of r.warnings ?? []) if (!x.includes('has no module')) console.log(`WARNING: ${x}`);
}
