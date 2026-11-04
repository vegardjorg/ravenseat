// =============================================================
// logic/pick.js: picking a task (a person or session takes it), status changes and the visual QA list.
//
// pickable, pick, deliver, release, isOldPick, setStatus, qaList, qaOk and qaDeviation. The evidence in the QA entry
// lives in logic/evidence.js.
//
// Part of the queueLogic.js split: lib/queueLogic.js re-exports every name, so callers keep requiring queueLogic.js.
// Used by queueLogic.js (the facade) and by logic/external.js, cloud.js.
// Tested in lib/__tests__/queueProjectPick.test.ts (through queueLogic.js).
// =============================================================

const {
  cfg, baseBranch, queueBranch, STATUSES, WITHOUT_PROJECT, LABEL_VISUAL, OLD_PICK_MS, estimate, isExternalRow,
  BATCHED_BLOCKER, isBatched,
} = require('./base.js');
const { projectFor, hasLabel, groups } = require('./projects.js');
const { validate } = require('./validate.js');
const { blockers } = require('./conflicts.js');
const { parkedNow, rankingContext, parkedText, ranking, compareRanking } = require('./ranking.js');
const { statusAtAdd } = require('./questions.js');
const { uncommittedCollision } = require('./commits.js');
const { migrTens, assignStartBlock } = require('./select.js');
const { closeBlock } = require('./monitor.js');

// ---- Picking ---------------------------------------------------------------------------------------

/**
 * Tasks that can be picked now: status waiting, no open dependencies or owner questions, and no ownership collision
 * with running/review/picked. Sorted by priority (with the project's bonus). Pause only stops the queue; a
 * task in a paused project can still be picked, and the row says `paused: true`.
 * @param {{ label?: string, project?: string, maxMin?: number, uncommitted?: string[] }} filter
 *   `uncommitted`: the paths from `git status` in the main tree. A task that owns one of them still stays on the list
 *   (picking is a manual choice), but the row says `uncommitted: <path>` so the one picking sees it.
 */
function pickable(queue, { label, project, maxMin, uncommitted = [] } = {}, now = Date.now()) {
  const tasks = queue.tasks ?? [];
  const register = queue.projects ?? {};
  // Common ranking. Parked ones are skipped; outside the focus still stays on the list (picking is a manual
  // choice, as for a paused project), but last and with `outside_focus: true`.
  const k = rankingContext(queue, now);
  return tasks
    .filter((o) => o.status === 'waiting' && blockers(o, tasks, queue.resolved).length === 0)
    .filter((o) => !label || hasLabel(o, label))
    .filter((o) => !project || projectFor(o, register) === project)
    .filter((o) => maxMin == null || estimate(o) <= maxMin)
    .map((o) => ({ o, r: ranking(o, queue, k) }))
    .filter(({ r }) => !r.parked)
    .sort(compareRanking)
    .map(({ o, r }) => ({
      id: o.id,
      title: o.title,
      class: o.class,
      domain: o.domain,
      estimate: estimate(o),
      score: r.score,
      project: projectFor(o, register),
      feature: o.feature ?? null,
      labels: o.labels ?? [],
      migr: Number(o.migr_tens ?? 0) > 0,
      paused: r.paused,
      uncommitted: uncommittedCollision(o, uncommitted)?.path ?? null,
      ...(k.applies ? { step: r.step, dragged_by: r.dragged_by, outside_focus: r.outside } : {}),
    }));
}

/**
 * Picks a task: waiting → picked, with queue branch (`<branchPrefix><id>`) and migration block as with `start`. Refuses on open
 * dependencies, owner questions or ownership collision with running/review/picked; `force` (owner's word) overrides those
 * three, never the status (a proposed task must be approved first, and something that is running cannot be picked). A migration block
 * the task already has (e.g. after `release`) is reused, so the numbers on a kept branch are still its own.
 * Changes `queue` (the caller writes the file under lock).
 * @returns {{ error: string, blockers?: string[] } | { task: object, overridden: string[] }}
 */
function pick(
  queue,
  id,
  {
    by,
    force = false,
    now = new Date().toISOString(),
    migrations = cfg().migrations,
    taken = [],
  } = {},
) {
  const o = (queue.tasks ?? []).find((x) => x.id === id);
  if (!o) return { error: `unknown task ${id}` };
  const who = String(by ?? '').trim();
  if (!who) return { error: 'pick requires --by "<who>" (the person or session doing the task)' };
  if (o.status !== 'waiting') {
    const why =
      o.status === 'picked'
        ? `already picked by ${o.picked_by ?? '?'}`
        : o.status === 'proposed'
          ? `proposed (approve it first: cq approve ${id})`
          : `status ${o.status}`;
    return { error: `${id} cannot be picked: ${why}` };
  }
  // The batch queue is not overridden with --force; the task is taken out with edit (batched:false) or packed.
  if (isBatched(o))
    return { error: `${id} cannot be picked: ${BATCHED_BLOCKER}`, blockers: [BATCHED_BLOCKER] };
  const h = blockers(o, queue.tasks, queue.resolved);
  // A parked task is not picked without --force (focus and pause do not stop picking, as before).
  if (parkedNow(o, Date.parse(now))) h.unshift(parkedText(o));
  if (h.length && !force)
    return {
      error: `${id} cannot be picked: ${h.join(' · ')} (--force overrides, only on the owner's word)`,
      blockers: h,
    };
  const tens = migrTens(o, migrations);
  let block = null;
  if (tens > 0) {
    if (o.migr_block) block = o.migr_block;
    else {
      if (!Number.isFinite(Number(queue.next_migr)))
        return { error: 'the queue is missing next_migr; cannot assign a migration block' };
      // Past blocks that are already taken (the caller gives `taken`, see takenBlocks).
      block = assignStartBlock(queue, o, taken, migrations).block;
    }
  }
  o.status = 'picked';
  o.picked_by = who;
  o.picked_at = now;
  o.branch = queueBranch(id);
  o.migr_block = block;
  if (force && h.length)
    o.remarks = [...(o.remarks ?? []), `${now} picked with --force past: ${h.join(' · ')}`];
  return { task: o, overridden: force ? h : [] };
}

/** Delivers a picked task to review (picked → review). `picked_by` stays (history, and takes no agent slot). */
function deliver(queue, id, now = new Date().toISOString()) {
  const o = (queue.tasks ?? []).find((x) => x.id === id);
  if (!o) return { error: `unknown task ${id}` };
  if (o.status !== 'picked') return { error: `${id} is not picked (status ${o.status})` };
  o.status = 'review';
  if (!o.delivered) o.delivered = now;
  return { task: o };
}

/**
 * Releases a picked task (picked → waiting) and removes the pick fields. The queue branch and the migration block are kept.
 * `commits` (ahead of baseBranch on the queue branch, counted by the caller) gives a warning and a remark on the task.
 */
function release(queue, id, { commits = 0, now = new Date().toISOString() } = {}) {
  const o = (queue.tasks ?? []).find((x) => x.id === id);
  if (!o) return { error: `unknown task ${id}` };
  if (o.status !== 'picked') return { error: `${id} is not picked (status ${o.status})` };
  const by = o.picked_by;
  o.status = 'waiting';
  delete o.picked_by;
  delete o.picked_at;
  delete o.cloud; // a released cloud session has ended
  let warning = null;
  if (commits > 0) {
    const branch = o.branch ?? queueBranch(id);
    warning =
      `${branch} has ${commits} commit(s) that are not on ${baseBranch()}. Branch kept. NB: when the queue starts ` +
      `the task again, prepare-track creates the branch from ${baseBranch()} (checkout -B) and the commits fall out of it; save them ` +
      `first (git branch ${branch}-released ${branch}) or pick the task again and keep building.`;
    o.remarks = [
      ...(o.remarks ?? []),
      `${now} released by ${by ?? '?'}; ${branch} had ${commits} commit(s) ahead of ${baseBranch()}`,
    ];
  }
  return { task: o, by, warning };
}

/**
 * Is a picked task "old"? Picked more than 72 h ago and without commits in the last 72 h (no commits on
 * the queue branch, or the last commit older than 72 h). Only a marker: it is never released automatically.
 * @param {{ commits?: number, lastCommit?: string|null }} git commits ahead of baseBranch and the time of the last one
 */
function isOldPick(o, { commits = 0, lastCommit = null } = {}, now = Date.now()) {
  if (o?.status !== 'picked' || !o.picked_at) return false;
  if (!(now - Date.parse(o.picked_at) > OLD_PICK_MS)) return false;
  if (!commits) return true;
  const last = lastCommit ? Date.parse(lastCommit) : NaN;
  return Number.isFinite(last) && now - last > OLD_PICK_MS;
}

// ---- Status and visual QA ---------------------------------------------------------------------------

/**
 * Sets the status with its side effects (`queue.mjs set`): delivered on review, done time, and `qa_status: "waiting"` when a
 * task with the label `visual` becomes done (from another status). `picked` is set only with `pick` (branch and
 * migration block). If a picked task goes back to waiting/proposed, the pick fields are removed (like `release`).
 * @returns {{ error: string } | { task: object, qa: boolean }}
 */
function setStatus(o, status, now = new Date().toISOString()) {
  if (!STATUSES.has(status)) return { error: `unknown status ${status}` };
  if (status === 'picked')
    return {
      error: 'status picked is set with cq pick <id> --by "<who>" (assigns branch and migration block)',
    };
  // Status external belongs only to records outside the queue, and such a record never becomes a task
  // that the queue can start (set waiting would have turned it into one).
  if (status === 'external')
    return {
      error: 'status external is set with cq external add --name "<session>" --files <…> (record outside the queue)',
    };
  if (isExternalRow(o) && status !== 'done' && status !== 'cancelled')
    return {
      error: `${o.id} is a record outside the queue; it can only be ended (cq external done "${o.external_name ?? o.id}")`,
    };
  const from = o.status;
  if (status === 'review' && !o.delivered) o.delivered = now;
  let qa = false;
  if (status === 'done') {
    o.done = now;
    if (from !== 'done' && hasLabel(o, LABEL_VISUAL)) {
      o.qa_status = 'waiting';
      qa = true;
    }
  }
  if (from === 'picked' && (status === 'waiting' || status === 'proposed')) {
    delete o.picked_by;
    delete o.picked_at;
    delete o.cloud;
  }
  // A cancelled task blocks nothing any more, so an open block (gate-red, for example) must not stay open and count.
  if (status === 'cancelled') closeBlock(o, { now: Date.parse(now) });
  o.status = status;
  return { task: o, qa };
}

/** QA list: finished tasks with `qa_status: "waiting"`, grouped project → feature (groups). */
function qaList(queue) {
  const i = (queue.tasks ?? []).filter((o) => o.status === 'done' && o.qa_status === 'waiting');
  return groups(i, queue.projects ?? {});
}

/**
 * The owner has looked at tasks and approves them: qa_status → ok. Applies to finished tasks that wait on QA or
 * have a deviation (checked again after the fix). All or nothing, like `approve`.
 * @returns {{ ok: string[], error: string[] }}
 */
function qaOk(queue, ids, now = new Date().toISOString()) {
  const error = [];
  const found = [];
  for (const id of ids) {
    const o = (queue.tasks ?? []).find((x) => x.id === id);
    if (!o) error.push(`unknown task ${id}`);
    else if (o.status !== 'done') error.push(`${id} is not done (status ${o.status})`);
    else if (o.qa_status !== 'waiting' && o.qa_status !== 'deviation')
      error.push(`${id} is not in the QA list (qa_status ${o.qa_status ?? 'none'})`);
    else found.push(o);
  }
  if (error.length) return { ok: [], error };
  for (const o of found) {
    o.qa_status = 'ok';
    o.qa_ok = now;
  }
  return { ok: found.map((o) => o.id), error: [] };
}

/**
 * The owner found a deviation: qa_status → deviation, `qa_note` = the text, and a fix task `<id>-QA<n>` is added
 * (K, same project and feature, the label visual, the original's files, mission = the text + link to the original,
 * added_by "owner", status waiting, `fixes` = [id]). A deviation on a fix task numbers on from the original (X-QA1 → X-QA2).
 * @returns {{ error: string } | { task: object, fix: object }}
 */
function qaDeviation(queue, id, text, now = new Date().toISOString()) {
  const tasks = queue.tasks ?? [];
  const o = tasks.find((x) => x.id === id);
  if (!o) return { error: `unknown task ${id}` };
  if (o.status !== 'done')
    return { error: `${id} is not done (status ${o.status}); QA applies to finished tasks` };
  const t = String(text ?? '').trim();
  if (!t) return { error: 'qa deviation requires a text: what is wrong, and where' };
  const root = typeof o.qa_original === 'string' && o.qa_original ? o.qa_original : id;
  const pattern = new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-QA(\\d+)$`);
  const n =
    1 +
    tasks.reduce((m, x) => {
      const match = pattern.exec(x.id);
      return match ? Math.max(m, Number(match[1])) : m;
    }, 0);
  const register = queue.projects ?? {};
  const pid = projectFor(o, register);
  const summary = t.length > 90 ? `${t.slice(0, 87)}...` : t;
  const isPath = typeof o.mission === 'string' && !/\n/.test(o.mission) && /\.md$/i.test(o.mission);
  const link = isPath
    ? `the mission: ${o.mission}`
    : `the mission is on ${o.id} in the queue (cq show --all)`;
  const fix = {
    id: `${root}-QA${n}`,
    title: `QA fix of ${o.id}: ${summary}`,
    domain: o.domain,
    class: 'K',
    ...(pid !== WITHOUT_PROJECT ? { project: pid } : {}),
    ...(typeof o.feature === 'string' && o.feature ? { feature: o.feature } : {}),
    labels: [LABEL_VISUAL],
    mission:
      `The owner found a deviation in visual QA of ${o.id} ("${o.title}"):\n\n${t}\n\n` +
      `The original: ${o.id}, ${link}. Fix the deviation and keep the rest of the original's behavior.`,
    value: Number(o.value ?? 5),
    content_min: 20,
    migr_tens: 0,
    depends_on: [],
    waiting_on: [],
    owned_files: [...(o.owned_files ?? [])],
    owner_db: [],
    shared_patch: [],
    source: `qa deviation ${o.id}`,
    added_by: 'owner',
    qa_original: root,
    // The task the deviation was found in (lib/fixLinks.js): a defect after merge of that task.
    fixes: [o.id],
  };
  // Without register: the project is inherited from the original, not written in again (it can be an older, explicit
  // project that is not in the register).
  const f = validate(fix, tasks);
  if (f.length) return { error: `fix task ${fix.id} is invalid: ${f.join('; ')}` };
  fix.status = statusAtAdd(fix, tasks);
  fix.added_at = now;
  o.qa_status = 'deviation';
  o.qa_note = t;
  o.remarks = [...(o.remarks ?? []), `${now} QA deviation, fix ${fix.id}`];
  tasks.push(fix);
  return { task: o, fix };
}

module.exports = {
  pickable,
  pick,
  deliver,
  release,
  isOldPick,
  setStatus,
  qaList,
  qaOk,
  qaDeviation,
};
