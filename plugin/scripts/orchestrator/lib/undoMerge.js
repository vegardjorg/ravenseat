// =============================================================
// lib/undoMerge.js: the rules of `ravenseat undo <id>` (GS-3): take a merged task back out of the base branch safely.
//
// WHY: the guide used to say "know git revert -m 1 <merge>". The owner's audience often cannot use git well, and a merge
// taken back by hand goes wrong in quiet ways: the wrong parent, a later task that built on it, a revert left half done
// after a conflict, or a reset that rewrites history. This command does the one safe thing: a NEW commit that reverts
// the task's merge (`git revert -m 1`), after showing what else touches the same files, and only after a yes.
//
// THE RULES:
//   * The merge commit: the task's merge_commit (written by ravenseat merge); without it, the newest commit on the base's
//     first-parent line whose subject is "Merge branch '<prefix><id>'" (the merge log). It must be in the base, on its
//     first-parent line, and have two parents (a fast-forward has no merge to revert; that is done by hand).
//   * What is shown before the question: the later work on the same line that shares a file with the merge (later
//     tasks, and commits by hand), the later tasks that depend on it (depends_on), and the open tasks that will wait for
//     it again. Nothing of that is reverted: it is shown so the owner knows what may break; the base gate checks it.
//   * Refused, with nothing changed: from a track (its queue branch or any linked worktree), the main checkout on
//     another branch than the base, uncommitted tracked changes, a git merge/rebase/cherry-pick/revert in progress, a
//     merge of this task cut off half way (merge --resume first), a task that is not done or in review, no merge found,
//     a commit not in the base, not on its first-parent line or not a merge, and a merge that was undone before.
//   * Never force, never rewrite history, never push. A revert that conflicts is aborted (git revert --abort).
//   * The task goes back to waiting: merge_commit and the done fields go, the undo is kept in `undone` and a remark
//     says how to bring the work back (revert the revert, or start the task again).
//
// Pure: strings and plain objects in, strings and objects out (reopen changes the task it is given). The git, the
// lock, the question and the base gate are in cli/undo.mjs. Tested in lib/__tests__/undoMerge.test.ts and
// __tests__/queueUndoMerge.test.ts.
// =============================================================
'use strict';

const { queueIdFromMerge } = require('./pushBatch.js');

const short = (sha) => String(sha ?? '').slice(0, 12);

/** The format cli/undo.mjs passes to `git log --first-parent`: sha, parents and subject, split by the unit separator. */
const LOG_FORMAT = '%H%x1f%P%x1f%s';

/**
 * The rows of `git log --first-parent --format=LOG_FORMAT <base>`, newest first.
 * @returns {{ sha: string, parents: string[], subject: string }[]}
 */
function parseLog(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .filter((l) => l.trim())
    .map((l) => {
      const [sha, parents = '', subject = ''] = l.split('\x1f');
      return { sha: sha.trim(), parents: parents.trim() ? parents.trim().split(/\s+/) : [], subject };
    });
}

/**
 * The task's merge commit: `recorded` (merge_commit) when there is one, otherwise the newest row whose subject is the
 * task's merge. `index` is its place in `rows` (-1: not on the base's first-parent line). null when nothing is found.
 */
function findMerge({ id, recorded = null, rows = [], prefix = 'queue/' }) {
  if (recorded) return { sha: recorded, source: 'merge_commit', index: rows.findIndex((r) => r.sha === recorded) };
  const index = rows.findIndex((r) => r.parents.length > 1 && queueIdFromMerge(r.subject, prefix) === id);
  return index < 0 ? null : { sha: rows[index].sha, source: 'merge log', index };
}

/**
 * The work merged after the merge at `index` that the owner should know about, oldest first: tasks that share a file
 * with it or depend on it, and commits by hand that share a file. `filesOf(row)` gives the files a row changed
 * (against its first parent); `ownFiles` are the files the task's merge changed.
 */
function laterWork({ rows, index, id, prefix = 'queue/', filesOf, ownFiles = [], tasks = [] }) {
  const own = new Set(ownFiles);
  const out = { tasks: [], commits: [] };
  for (const row of rows.slice(0, Math.max(0, index)).reverse()) {
    const shared = (filesOf(row) ?? []).filter((f) => own.has(f));
    const tid = row.parents.length > 1 ? queueIdFromMerge(row.subject, prefix) : null;
    if (tid && tid !== id) {
      const dependsOn = (tasks.find((t) => t.id === tid)?.depends_on ?? []).includes(id);
      if (shared.length || dependsOn) out.tasks.push({ id: tid, sha: row.sha, shared, dependsOn });
    } else if (!tid && shared.length) out.commits.push({ sha: row.sha, subject: row.subject, shared });
  }
  return out;
}

/** The open tasks (not done, not cancelled) that depend on `id`: they wait for it again after the undo. */
function waitingOn(tasks = [], id) {
  return tasks.filter((t) => (t.depends_on ?? []).includes(id) && !['done', 'cancelled'].includes(t.status));
}

/** The revert commit of an earlier undo of this merge, or null. */
function alreadyUndone(task, sha) {
  return (task?.undone ?? []).find((u) => u.merge_commit === sha)?.revert_commit ?? null;
}

/**
 * The refusal outside the main session (a track's queue branch, or any linked worktree), or null. Checked first, before
 * the merge lock is taken: a track never waits for, or holds, the orchestrator's lock.
 */
function whereRefusal({ id, inTrack = null, inWorktree = false, ravenseat = 'ravenseat' }) {
  const why = inTrack
    ? `undo runs in the main session only, not on the track ${inTrack}'s queue branch.`
    : inWorktree
      ? 'undo runs in the main checkout only, not in a linked worktree.'
      : null;
  return why ? `${ravenseat} undo ${id}: ${why} Nothing was done.` : null;
}

/**
 * Why the undo is refused, or null. The first reason wins; every text ends with "Nothing was done."
 * facts: { id, base, root, ravenseat, inTrack, inWorktree, head, dirty[], inProgress[], cutOff, status, found, inBase,
 *          parents, alreadyUndone }
 */
function refusal(f) {
  const where = whereRefusal(f);
  if (where) return where;
  const rs = f.ravenseat ?? 'ravenseat';
  const why = (() => {
    if (f.head !== f.base)
      return `the main checkout ${f.root} is on ${f.head ?? 'no branch'}, not ${f.base}. Check ${f.base} out there first.`;
    // Before the dirty check: a conflicted merge also leaves changed files, and the operation is what to settle first.
    if (f.inProgress?.length)
      return f.inProgress.map((x) => `a ${x.kind} is in progress in ${f.root}; finish it or undo it (${x.undo}) first.`).join(' ');
    if (f.dirty?.length)
      return `the main checkout has uncommitted changes (${f.dirty.slice(0, 5).join(', ')}${f.dirty.length > 5 ? ', ...' : ''}). Commit or stash them first.`;
    if (f.cutOff) return `a merge of ${f.id} was cut off half way. Finish it first: ${rs} merge ${f.id} --resume.`;
    if (!['done', 'review'].includes(f.status)) return `${f.id} has status ${f.status}; undo applies to a merged task (done, or in review after a partial merge).`;
    if (!f.found) return `no merge commit found for ${f.id}: no merge_commit on the task and no "Merge branch" commit for it on ${f.base}.`;
    if (!f.inBase) return `the merge commit ${short(f.found.sha)} of ${f.id} is not in ${f.base}.`;
    if (f.found.index < 0)
      return `the merge commit ${short(f.found.sha)} is in ${f.base} but not on its first-parent line (it came in through another merge). Revert it by hand.`;
    if (f.parents < 2)
      return `${short(f.found.sha)} is not a merge commit (a fast-forward): there is no single merge to revert. Revert its commits by hand.`;
    if (f.alreadyUndone) return `the merge ${short(f.found.sha)} of ${f.id} was already undone by ${short(f.alreadyUndone)}.`;
    return null;
  })();
  return why ? `${rs} undo ${f.id}: ${why} Nothing was done.` : null;
}

/** The plan shown before the question (and by --dry). */
function planLines({ id, sha, subject, source, base, files = [], later, waiting = [], baseGate }) {
  const lines = [
    `Undo ${id}: revert its merge ${short(sha)} ("${subject}", found by ${source === 'merge_commit' ? 'the task\'s merge_commit' : 'the merge log'}).`,
    `  It changed ${files.length} file(s)${files.length ? `: ${files.slice(0, 8).join(', ')}${files.length > 8 ? ', ...' : ''}` : ''}.`,
  ];
  const n = later.tasks.length + later.commits.length;
  if (!n) lines.push(`  Nothing merged after it touches the same files or depends on it.`);
  else {
    lines.push(`  Merged after it, and NOT reverted (check these still work):`);
    for (const t of later.tasks)
      lines.push(
        `    ${t.id} (${short(t.sha)}): ${[t.shared.length ? `shares ${t.shared.join(', ')}` : null, t.dependsOn ? `depends on ${id}` : null].filter(Boolean).join('; ')}`,
      );
    for (const c of later.commits) lines.push(`    commit ${short(c.sha)} "${c.subject}": shares ${c.shared.join(', ')}`);
  }
  if (waiting.length) lines.push(`  Waiting on ${id} again afterwards: ${waiting.map((t) => t.id).join(', ')}.`);
  lines.push(
    `  What happens: git revert -m 1 ${short(sha)} as ONE new commit on ${base} (nothing rewritten, never pushed), ` +
      `${id} goes back to waiting with a note${baseGate ? ', then the base gate runs on the new tip as after a merge' : ''}.`,
  );
  return lines;
}

/** The revert commit's message: what was undone, and the trailer that marks the orchestrator's own commits. */
function commitMessage({ id, sha, subject }) {
  return [
    `Undo ${id}: revert merge ${short(sha)}`,
    '',
    `Reverts "${subject}" (${sha}) with git revert -m 1 (ravenseat undo ${id}).`,
    '',
    'Queue: orchestrator',
  ].join('\n');
}

/** What to say when the revert conflicted. `aborted`: git revert --abort put the checkout back. */
function conflictLines({ id, sha, files = [], root, aborted }) {
  return [
    `The revert of ${id}'s merge ${short(sha)} conflicts with later work${files.length ? ` in ${files.join(', ')}` : ''}.`,
    aborted
      ? '  It was aborted (git revert --abort): the checkout is as it was. Nothing was changed.'
      : `  git revert --abort failed: check ${root} with git status. Nothing in the queue was changed.`,
    '  To do it by hand:',
    `    cd ${root}`,
    `    git revert -m 1 ${sha}`,
    '    (resolve the files, git add them, git revert --continue; or give up with git revert --abort)',
    `  Then set the task back yourself: ravenseat set ${id} waiting --remark "undone by hand".`,
  ];
}

/** The task back to waiting after the revert `revert` of `merge`. Changes and returns `task`. */
function reopen(task, { at, merge, revert, by = 'ravenseat' }) {
  task.status = 'waiting';
  for (const k of ['merge_commit', 'done', 'delivered', 'delivered_partial', 'verification', 'qa_status', 'qa_ok_by', 'qa_note'])
    delete task[k];
  task.undone = [...(task.undone ?? []), { merge_commit: merge, revert_commit: revert, at, by }];
  task.remarks = [
    ...(task.remarks ?? []),
    `${at} undone: merge ${short(merge)} reverted by ${short(revert)} (ravenseat undo). To bring the work back: ` +
      `git revert ${short(revert)}, or start the task again.`,
  ];
  return task;
}

module.exports = {
  LOG_FORMAT,
  parseLog,
  findMerge,
  laterWork,
  waitingOn,
  alreadyUndone,
  whereRefusal,
  refusal,
  planLines,
  commitMessage,
  conflictLines,
  reopen,
};
