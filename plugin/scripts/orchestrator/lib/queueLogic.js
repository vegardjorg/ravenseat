// =============================================================
// queueLogic.js: pure logic for the work queue (scripts/orchestrator/queue.mjs).
//
// The queue gives continuous flow instead of fixed waves (docs/queue.md): when a slot becomes free, it starts the highest
// ranked task that (a) has all dependencies done, (b) is not waiting on an owner question, and (c) does not own
// a file, DB object or shared patch that a running task owns. The limits (concurrent, D+, per domain) sit in
// the queue file under `limits`.
//
// Project, feature, picking and QA: tasks belong to a project (explicit field or prefix rule from the
// `projects` register) and a feature; a person or session can pick a task (status `picked`, owns its files
// but takes no agent slot); tasks with the label `visual` land in the owner's QA list when they are done. All
// the new fields are optional, so an older queue.json works unchanged.
//
// Work outside the queue: commits on baseBranch (config().baseBranch) are classified as queue (merge of a queue branch,
// config().branchPrefix), orchestrator (the trailer "Queue: orchestrator") or external; external changes are compared with
// the owned files; a row with status `external` (`queue.mjs external add`) owns files like a picked task; `next` skips
// tasks that collide with uncommitted files in the main tree; the push check finds a safe cut point. The git reading
// lives in queueGit.js.
//
// Owner questions and resolutions: `question` holds the text behind the ids in `waiting_on`, and `resolutions` holds the
// answer with a timestamp (the id still sits in `resolved`). Both are optional.
//
// Batch queue: `batched: true` (optional) puts a small, non-blocking task in the batch queue; it is never started or
// picked alone, and `batchPack` combines a group into one track of the right size.
//
// Areas, focus period and parking: `areas` above projects, `focus` with stage, "rest" and "pulled along", and
// `parked` per task. One ranking (queueLogic.ranking) for selectNext, pickable, show and state. Without focus and
// parked the result is the same as without these fields.
//
// The orchestrator's routine as script and cost per task: short `show`, agent type and agent message for `fill`,
// review package for `receive`, the RESULT/FINDINGS parsers and the cost sum for `set done` and `cost`.
//
// No I/O here (except that config() is read when needed): the CLI reads and writes the file and calls these functions.
// The tests live in lib/__tests__/.
// =============================================================

const {
  cfg, resetConfig, baseBranch, remoteName, branchPrefix, queueBranch, WEIGHT, CALIBRATED, DEFAULT_LIMITS, NIGHT_TZ,
  ACTIVE, STATUSES, WITHOUT_PROJECT, WITHOUT_FEATURE, LABEL_VISUAL, LABEL_PATTERN, OLD_PICK_MS, estimate,
  estimateWall, estimateCost, costLabel, hasMigr, ageText, isExternalRow, regexSafe, BATCHED_BLOCKER, isBatched,
  inBatchQueue, openQuestion, round2, cutText, addToBonus, bonusBlock,
} = require('./logic/base.js');
const {
  projectFor, longestPrefix, projectPaused, hasLabel, counterAsAgent, groups, projectOverview, newRegister, withIndex,
} = require('./logic/projects.js');
const {
  qaConfig, validateEvidence, parseEvidence, evidenceRequired, evidenceWarning, evidenceText, qaSplit,
  evidenceCommand, qaAutoOutcome,
} = require('./logic/evidence.js');
const { validate, validateNewField } = require('./logic/validate.js');
const {
  norm, fileOverlap, conflictPart, conflict, blockerParts, blockers, childrenMap, successors, lockUpCount,
} = require('./logic/conflicts.js');
const {
  blockersWithPause, WITHOUT_AREA, FOCUS_REST, areaFor, parseStep, stepMatch, focusApplies, ownStep, parkedNow,
  draggedWith, rankingContext, parkedText, focusSpace, ranking, compareRanking, parseToDate, stepTitle, stepText,
  focusText, score, scoreParts,
} = require('./logic/ranking.js');
const {
  isAgentSource, statusAtAdd, approve, QUESTION_TYPES, validQuestionId, setQuestion, resolve, unlogged, markLogged,
  questionOverview, questionWithoutText, QUESTION_ID_PATTERN, questionRegistered, waitingOnError, resolveWaits,
  resolveWaitsLines, ownerAnswerBonus, answerBlock, migrBlockText,
} = require('./logic/questions.js');
const {
  ORCHESTRATOR_TRAILER, ORCHESTRATOR_EXPIRY_MS, COLLISION_STATUSES, hasOrchestratorTrailer, queueIdFromMerge,
  classifyCommit, mentionedIds, consistency, pushPlan, uncommittedCollision, uncommittedSkipped, orchestratorStatus,
  newCursor,
} = require('./logic/commits.js');
const {
  spaceUse, budgetGuard, parseNightWindow, inNightWindow, nightGuard, startGuard, minFreeMemoryFor, loadGuard,
  loadSlotsFor, windDownGuard, LIMIT_NAME, LIMIT_EXTRA, limitText, parseLimit,
} = require('./logic/guards.js');
const {
  BATCH_MEASURE, batchedError, SMALL_FIX_MIN, SMALL_LOW_VALUE, smallTaskError, batchGroups, batchId, batchSuggestion,
  batchPack, batchMissionText,
} = require('./logic/batch.js');
const {
  parkedValue, editMany, CHANGELOG_MAX, RANK_STEP, cloneJson, equalValue, bulkDiff, diffLines, logChange,
  lastUndoable, undoEntry, expectCheck, rankBlock,
} = require('./logic/edit.js');
const {
  setFocus, removeFocus, FOCUS_PLAN_MAX, saveFocusPlan, focusStatus, evaluateFocusStep, focusWithoutDone, cleanFocus,
  restText, focusCleanLines, setArea, areaOverview, park, proceed,
} = require('./logic/focus.js');
const {
  selectNext, assignMigrBlock, migrTens, MIGR_FREE_STATUS, blockInterval, blocksInText, promptTask, takenBlocks,
  assignStartBlock, parseMoveBlock, moveBlockInText, state,
} = require('./logic/select.js');
const TK = require('./timeCost.js');
// The reviewers (fixed per class and the helper agents) are worked out in ONE place: lib/queueHelpers.js.
const HELP = require('./queueHelpers.js');

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

/**
 * Collisions between work outside the queue and the owned files of tasks that are running, picked, in review or waiting.
 * @param {object[]} tasks the queue's tasks
 * @param {{ commits?: { sha: string, summary?: string, subject?: string, files: string[], date?: string }[],
 *           branches?: { name: string, files: string[] }[], uncommitted?: (string|{ path: string })[] }} sources
 *   commits = the external ones, with the date they landed on baseBranch; a commit counts only for tasks that were added
 *   BEFORE it landed. Branches (outside the queue branches, not merged) and uncommitted files always count.
 * @returns {{ id: string, status: string, file: string, owner: string, source: 'commit'|'branch'|'uncommitted',
 *             sha?: string, summary?: string, subject?: string, date?: string, branch?: string }[]}
 */
function externalCollisions(tasks, sources = {}, { statuses = COLLISION_STATUSES } = {}) {
  // Index path → sources, so each owned file is looked up instead of being compared with all changed files.
  const index = new Map();
  const addTo = (filePath, source) => {
    const s = norm(filePath ?? '');
    if (!s) return;
    if (!index.has(s)) index.set(s, []);
    index.get(s).push(source);
  };
  for (const c of sources.commits ?? []) {
    const summary = c.summary ?? String(c.sha).slice(0, 8);
    for (const f of c.files ?? [])
      addTo(f, { source: 'commit', sha: c.sha, summary, subject: c.subject ?? '', date: c.date });
  }
  for (const g of sources.branches ?? []) {
    for (const f of g.files ?? []) addTo(f, { source: 'branch', branch: g.name });
  }
  for (const u of sources.uncommitted ?? [])
    addTo(typeof u === 'string' ? u : u?.path, { source: 'uncommitted' });
  // Untracked folders ("?? new-folder/") own everything below them.
  const folders = [...index.keys()].filter((s) => s.endsWith('/'));

  const sequence = new Map(statuses.map((s, i) => [s, i]));
  const out = [];
  const set = new Set();
  for (const o of tasks ?? []) {
    if (isExternalRow(o) || !sequence.has(o.status)) continue;
    const addedAt = o.added_at ? Date.parse(o.added_at) : NaN;
    const match = (filePath, list, owner) => {
      for (const k of list) {
        // A commit that landed before the task was added is already part of the basis for the mission.
        if (
          k.source === 'commit' &&
          Number.isFinite(addedAt) &&
          k.date &&
          !(Date.parse(k.date) > addedAt)
        )
          continue;
        const key = `${o.id}|${filePath}|${k.source}|${k.sha ?? k.branch ?? ''}`;
        if (set.has(key)) continue;
        set.add(key);
        out.push({ id: o.id, status: o.status, file: filePath, owner, ...k });
      }
    };
    for (const e of o.owned_files ?? []) {
      const f = norm(e);
      if (f.endsWith('/')) {
        for (const [filePath, list] of index) if (fileOverlap(f, filePath)) match(filePath, list, f);
      } else {
        if (index.has(f)) match(f, index.get(f), f);
        for (const m of folders) if (f.startsWith(m)) match(m, index.get(m), f);
      }
    }
  }
  return out.sort((x, y) => sequence.get(x.status) - sequence.get(y.status) || x.id.localeCompare(y.id));
}

/** "<id>: the file X was changed outside the queue in <sha> "subject"" / "… on branch <branch>" / "… is uncommitted in the main tree". */
function collisionText(k, { withId = true } = {}) {
  const file = k.file === k.owner ? k.file : `${k.file} (under ${k.owner})`;
  const where =
    k.source === 'commit'
      ? `was changed outside the queue in ${k.summary} "${String(k.subject ?? '').slice(0, 70)}"`
      : k.source === 'branch'
        ? `was changed outside the queue on branch ${k.branch} (not in ${baseBranch()})`
        : 'is uncommitted in the main tree (another session is working in it)';
  return `${withId ? `${k.id}: ` : ''}the file ${file} ${where}`;
}

/**
 * The warning `trackFile` writes into the track block when the owned files have changed outside the queue since the task was added,
 * so the track reads the diff before it builds on an outdated mission. null when there is nothing to warn about.
 * @param {object} o the task
 * @param {object[]} collisions externalCollisions for this task
 * @param {{ summary: string, subject?: string }[]} mentioned external commits that mention the id
 */
function trackFileWarning(o, collisions = [], mentioned = []) {
  if (!collisions.length && !mentioned.length) return null;
  const MAX = 12;
  const lines = [
    `**WARNING from the queue (work outside the queue): your owned files have changed outside the queue since the task was added ` +
      `(${o.added_at ?? 'unknown time'}).** The mission may be outdated. Read the diff before you build on, and write in ` +
      'the report what no longer holds:',
  ];
  for (const k of collisions.slice(0, MAX)) {
    if (k.source === 'commit')
      lines.push(
        `- \`${k.file}\` in ${k.summary} "${String(k.subject ?? '').slice(0, 70)}": \`git show ${k.summary} -- ${k.file}\``,
      );
    else if (k.source === 'branch')
      lines.push(
        `- \`${k.file}\` on branch ${k.branch} (not merged to ${baseBranch()}): ` +
          `\`git diff ${baseBranch()}...${k.branch} -- ${k.file}\``,
      );
    else
      lines.push(
        `- \`${k.file}\` is uncommitted in the main tree: another session is working in the file. Do not touch it; report to the orchestrator.`,
      );
  }
  if (collisions.length > MAX)
    lines.push(`- … and ${collisions.length - MAX} more (cq external)`);
  if (mentioned.length)
    lines.push(
      `Commits outside the queue that mention ${o.id} (is something already done?): ` +
        mentioned
          .slice(0, 5)
          .map((c) => `${c.summary} "${String(c.subject ?? '').slice(0, 60)}"`)
          .join(', '),
    );
  return lines.join('\n');
}

/** Id for a new record outside the queue: external-<name as kebab-case>, with -2, -3 … when it already exists. */
function externalId(name, tasks = []) {
  const slug =
    String(name ?? '')
      .toLowerCase()
      .replace(/\u00E6/g, 'ae')
      .replace(/\u00F8/g, 'o')
      .replace(/\u00E5/g, 'a')
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 28)
      .replace(/-+$/, '') || 'session';
  const ids = new Set(tasks.map((o) => o.id));
  let id = `external-${slug}`;
  for (let n = 2; ids.has(id); n++) id = `external-${slug}-${n}`;
  return id;
}

/**
 * Registers work in progress outside the queue (`queue.mjs external add`): a row with status `external` that owns the files (and
 * the DB functions, if any) like a picked task, until `external done <name>`. The same name again while the row is active
 * adds the files (and sets the branch when given). Changes `queue` (the caller writes the file under lock).
 * @returns {{ error: string } | { row: object, new: boolean, warnings: string[] }}
 */
function externalAdd(
  queue,
  { name, files = [], db = [], branch = null, now = new Date().toISOString() } = {},
) {
  const who = String(name ?? '').trim();
  if (!who) return { error: 'external add requires --name "<session or person>"' };
  const newFiles = [...new Set((files ?? []).map((f) => norm(f).trim()).filter(Boolean))];
  const newDb = [...new Set((db ?? []).map((d) => String(d).trim()).filter(Boolean))];
  if (!newFiles.length && !newDb.length)
    return {
      error: 'external add requires --files <path …> (folder with "/" at the end), or --db <function …>',
    };
  queue.tasks = queue.tasks ?? [];
  let row = queue.tasks.find(
    (o) => isExternalRow(o) && o.status === 'external' && o.external_name === who,
  );
  const fresh = !row;
  if (row) {
    row.owned_files = [...new Set([...(row.owned_files ?? []), ...newFiles])];
    row.owner_db = [...new Set([...(row.owner_db ?? []), ...newDb])];
    if (branch) row.branch = branch;
    row.updated = now;
  } else {
    row = {
      id: externalId(who, queue.tasks),
      title: `Work outside the queue: ${who}`,
      domain: 'external',
      class: 'K',
      mission:
        'Registered with cq external add. Not a task: the row owns the files until external done.',
      value: 5,
      content_min: 0,
      migr_tens: 0,
      depends_on: [],
      waiting_on: [],
      owned_files: newFiles,
      owner_db: newDb,
      shared_patch: [],
      status: 'external',
      external: true,
      external_name: who,
      ...(branch ? { branch } : {}),
      added_at: now,
      added_by: who,
    };
    const f = validate(row, queue.tasks);
    if (f.length) return { error: `the record is invalid: ${f.join('; ')}` };
    queue.tasks.push(row);
  }
  // Warnings: tasks in the queue that already own the same thing (they must talk), and pending ones that are now held back.
  const warnings = [];
  const held = [];
  for (const o of queue.tasks) {
    if (o === row || isExternalRow(o)) continue;
    const k = conflict(o, row);
    if (!k) continue;
    if (ACTIVE.has(o.status))
      warnings.push(
        `${o.id} (${o.status}) owns the same thing: ${k.replace(/ is owned by .*$/, '')}; tell the orchestrator`,
      );
    else if (o.status === 'waiting') held.push(o.id);
  }
  if (held.length)
    warnings.push(
      `${held.length} pending task(s) are not started before external done: ${held.slice(0, 8).join(', ')}${held.length > 8 ? ' …' : ''}`,
    );
  return { row, new: fresh, warnings };
}

/** Ends a record outside the queue (by name or id): status done, and the files are free again. */
function externalDone(queue, nameOrId, now = new Date().toISOString()) {
  const x = String(nameOrId ?? '').trim();
  if (!x) return { error: 'external done <name>' };
  const row = (queue.tasks ?? []).find(
    (o) => isExternalRow(o) && o.status === 'external' && (o.external_name === x || o.id === x),
  );
  if (!row)
    return { error: `no active record outside the queue with the name ${x} (see cq external)` };
  row.status = 'done';
  row.done = now;
  return { row };
}

/**
 * The owner or the orchestrator accepts that a pending task was done outside the queue (`queue.mjs external accept <id> <sha>`):
 * status done with the remark "done outside the queue in <sha>". Never automatic. `mentioned` = the commit message mentions the id
 * (otherwise the remark says so). A visual task lands in the QA list as with `set done`.
 * @returns {{ error: string } | { task: object, qa: boolean }}
 */
function externalAccept(queue, id, sha, { mentioned = true, now = new Date().toISOString() } = {}) {
  const o = (queue.tasks ?? []).find((x) => x.id === id);
  if (!o) return { error: `unknown task ${id}` };
  if (isExternalRow(o))
    return { error: `${id} is a record outside the queue (cq external done)` };
  if (!sha) return { error: 'external accept <id> <sha>' };
  if (o.status !== 'waiting' && o.status !== 'proposed') {
    const why =
      o.status === 'picked' ? `picked by ${o.picked_by ?? '?'}` : `status ${o.status}`;
    return { error: `${id} cannot be accepted as done outside the queue: ${why}` };
  }
  const s = setStatus(o, 'done', now);
  if (s.error) return s;
  o.done_outside_queue = sha;
  o.remarks = [
    ...(o.remarks ?? []),
    `${now} done outside the queue in ${String(sha).slice(0, 8)}${mentioned ? '' : ' (the commit message does not mention the id)'}`,
  ];
  return { task: o, qa: s.qa };
}

/**
 * Tasks in work (proposed, waiting, running, picked, review) that are missing a project (land in without-project, only
 * when the register has projects) or feature. New tasks should have both (add-to-queue); another session that adds
 * without them becomes visible here and in `add`.
 */
function missingProject(tasks, register) {
  const inWork = new Set(['proposed', 'waiting', 'running', 'picked', 'review']);
  const withRegister = Object.keys(register ?? {}).length > 0;
  const withoutProject = [];
  const withoutFeature = [];
  for (const o of tasks ?? []) {
    if (isExternalRow(o) || !inWork.has(o.status)) continue;
    if (withRegister && projectFor(o, register) === WITHOUT_PROJECT) withoutProject.push(o.id);
    if (typeof o.feature !== 'string' || !o.feature.trim()) withoutFeature.push(o.id);
  }
  return { withoutProject, withoutFeature };
}

// ---- The track block (trackFile and cloud-package) ------------------------------------------------------------------------

/**
 * The track block from the heading "## TRACK …" down: the ownership, a warning about changes outside the queue if any, owner answers
 * and the mission text. `queue.mjs trackFile` puts TITLE/BLOCK/BRANCH in front; `cloud-package` puts it under "## The mission".
 * @param {object} o the task
 * @param {object} queue the queue (for answerBlock)
 * @param {{ text: string, warning?: string|null, cloud?: boolean }} v `cloud`: the cloud session has no SendMessage, so
 *   the ownership line says "stop" instead of "report".
 */
function trackBlock(o, queue, { text, warning = null, cloud = false } = {}) {
  const list = (x) => (Array.isArray(x) && x.length ? x.join(', ') : 'none');
  const reportFrom = cloud
    ? 'if you need to, stop with CLOUD-STOP and say what is needed.'
    : 'if you need to, report it (SendMessage) instead of editing it.';
  const answer = answerBlock(o, queue);
  return [
    `## TRACK ${o.id} (${o.title}; source: ${o.source ?? 'see the mission'}; class ${o.class}, estimate ${estimate(o)} min)`,
    '',
    `**Ownership in the queue:** files ${list(o.owned_files)}; DB ${list(o.owner_db)}; shared patch ${list(o.shared_patch)}. Do not touch anything other tasks in the queue own; ${reportFrom}`,
    '',
    ...(warning ? [warning, ''] : []),
    ...(answer ? [answer, ''] : []),
    String(text ?? '').trim(),
    // `queue.mjs edit <id> --bonus "…"` (instead of node -e against queue.json).
    ...(bonusBlock(o) ? ['', bonusBlock(o)] : []),
    '',
  ].join('\n');
}

// ---- Cloud: queue tasks in cloud sessions on claude.ai --------------------------------------------------------
// The cloud session only sees what is pushed to the remote and has no database. So only client/tool tasks
// (K, U) without migrations and DB are suitable, and only when the owned files are pushed. The orchestrator (or the owner from the board) sends
// the package; the cloud pushes the queue branch (<branchPrefix><id>, or the branch the session is allowed to use), and the orchestrator merges as
// usual.

/** Who a cloud session appears as in `picked_by`. */
const CLOUD_BY = 'cloud';
/** At most this many cloud sessions concurrently (does not count toward maxConcurrent). */
const CLOUD_MAX = 3;
const CLOUD_CLASSES = new Set(['K', 'U']);
const CLOUD_CLOSED = new Map([
  ['db', 'needs the database (test runs against a database)'],
  ['web', 'needs the network (downloads or external sources; the cloud is behind a block)'],
  ['sources', 'needs local source collections or primary sources'],
  ['local-files', 'needs files that only exist locally (gitignored or untracked)'],
  ['unit', "needs the owner's device or a running app"],
]);

/** Is the task in a cloud session now? (picked by "cloud", with the cloud field set by `cloud start`) */
function isCloud(o) {
  return o?.status === 'picked' && o.picked_by === CLOUD_BY && !!o.cloud;
}

/**
 * The areas the cloud does not see (gitignored or untracked). The queue's dataFolder (scripts/.queue/) is always included; the folders in
 * config().cloudHidden (list of paths, e.g. 'docs/private/') are added.
 */
function cloudHidden() {
  const extra = Array.isArray(cfg().cloudHidden) ? cfg().cloudHidden : [];
  return [
    ...extra
      .map((s) => String(s).replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
      .filter(Boolean)
      .map((s) => ({
        pattern: new RegExp(`(^|/)${regexSafe(s)}(/|$)`),
        area: `${s}/`,
        boostable: true,
      })),
    { pattern: /(^|\/)scripts\/\.queue(\/|$)/, area: 'scripts/.queue/', boostable: false },
  ];
}
// A line that says the binding content is lifted into the mission (the template's "GITIGNORED; everything binding is lifted in here"),
// is a source reference, not something the cloud needs to read.
const BOOSTED_IN = /lifted in|everything binding/i;

/**
 * The references in the mission text to files the cloud does not see. The task's own mission file does not count (it is put
 * into the package). `boosted`: the line says the binding content is lifted in (does not apply to scripts/.queue/, where other
 * tasks' missions live).
 * @returns {{ path: string, area: string, boosted: boolean }[]} unique paths in order
 */
function cloudReferences(text, { id, ownPath } = {}) {
  const own = ownPath ? norm(ownPath).toLowerCase() : null;
  const hiddenOnes = cloudHidden();
  const out = [];
  const set = new Set();
  for (const line of String(text ?? '').split('\n')) {
    const boosted = BOOSTED_IN.test(line);
    for (const raw of line.replace(/\\/g, '/').split(/[\s`'"()<>[\]|,;\u00AB\u00BB*]+/)) {
      const filePath = raw.replace(/[.:]+$/, '');
      if (!filePath) continue;
      const match = hiddenOnes.find((u) => u.pattern.test(filePath));
      if (!match) continue;
      const low = filePath.toLowerCase();
      if (own && (low === own || low.endsWith(`/${own}`))) continue;
      if (id && match.area === 'scripts/.queue/' && low.endsWith(`/mission/${id.toLowerCase()}.md`))
        continue;
      if (set.has(filePath)) continue;
      set.add(filePath);
      out.push({ path: filePath, area: match.area, boosted: match.boostable && boosted });
    }
  }
  return out;
}

/**
 * Can the task run in a cloud session? Suitable when all of this holds:
 *   - class K or U, no migrations (migr_tens 0), empty owner_db and shared_patch
 *   - the mission does not point to folders the cloud does not see (config().cloudHidden, and scripts/.queue/ beyond its own file; a
 *     source reference on a line that says the binding content is lifted in is fine)
 *   - status waiting without open dependencies, owner questions or ownership collision (or already in a cloud session)
 *   - the owned files are not changed locally since <remote>/<baseBranch> (committed and not pushed, or uncommitted):
 *     otherwise the cloud builds on old code
 * @param {{ pushedHead?: string|null, changed?: string[], missionText?: string, ownPath?: string|null }} v
 *   `pushedHead`: the sha of <remote>/<baseBranch> (null: unknown, then it cannot be checked). `changed`: the paths that are
 *   changed locally since then. `missionText`: the mission itself (the file `mission` points to, or the text).
 * @returns {{ suitable: boolean, reasons: string[] }}
 */
function cloudSuitable(queue, id, { pushedHead = null, changed = [], missionText, ownPath = null } = {}) {
  const tasks = queue?.tasks ?? [];
  const o = tasks.find((x) => x.id === id);
  if (!o) return { suitable: false, reasons: [`unknown task ${id}`] };
  const reasons = [];
  if (!CLOUD_CLASSES.has(o.class)) reasons.push(`class ${o.class} (only K and U run in the cloud)`);
  if (Number(o.migr_tens ?? 0) > 0) reasons.push('has migrations (the cloud has no database)');
  // The label "not-cloud": a cloud session has tried and stopped because the task needs something only available locally (sources,
  // downloads, local files). Set by the orchestrator after CLOUD-STOP.
  for (const k of o.requires ?? []) if (CLOUD_CLOSED.has(k)) reasons.push(CLOUD_CLOSED.get(k));
  if (hasLabel(o, 'not-cloud'))
    reasons.push('marked not-cloud (needs something that only exists locally)');
  if ((o.owner_db ?? []).length) reasons.push(`owns DB functions: ${o.owner_db.join(', ')}`);
  if ((o.shared_patch ?? []).length) reasons.push(`shared patch: ${o.shared_patch.join(', ')}`);

  if (isCloud(o)) {
    // Already in a cloud session: the status is correct, and the blockers applied when it was started.
  } else if (o.status !== 'waiting') {
    reasons.push(
      o.status === 'picked' ? `picked by ${o.picked_by ?? '?'}` : `status ${o.status}`,
    );
  } else {
    for (const h of blockerParts(o, tasks, queue.resolved)) {
      if (h.type === 'depends_on') reasons.push(`open dependency: ${h.text}`);
      else if (h.type === 'question') reasons.push(`open owner question: ${h.sp}`);
      else reasons.push(h.text);
    }
  }

  const text = missionText ?? (String(o.mission ?? '').includes('\n') ? o.mission : '');
  // References to other tasks' missions (scripts/.queue/mission/<another>.md) are context, not binding content:
  // the package explains that the file does not exist in the cloud. They do not close.
  const hiddenOnes = cloudReferences(text, { id: o.id, ownPath }).filter(
    (r) => !r.boosted && r.area !== 'scripts/.queue/',
  );
  if (hiddenOnes.length)
    reasons.push(
      `the mission points to files the cloud does not see: ${hiddenOnes.map((r) => r.path).join(', ')}`,
    );

  if (!pushedHead)
    reasons.push(
      `did not find ${remoteName()}/${baseBranch()} (run git fetch ${remoteName()} ${baseBranch()})`,
    );
  else {
    const local = [];
    for (const f of o.owned_files ?? []) {
      const e = (changed ?? []).find((filePath) => fileOverlap(f, filePath));
      if (e) local.push(norm(e));
    }
    if (local.length)
      reasons.push(
        `owned files changed locally and not pushed: ${[...new Set(local)].slice(0, 5).join(', ')}` +
          ` (push ${baseBranch()} first)`,
      );
  }
  return { suitable: reasons.length === 0, reasons };
}

/** The general rules for a K or U track in the cloud, short. The project's own rules are in config().architectureRules. */
const CLOUD_RULES_COMMON = [
  'No migrations and no database: the cloud has no database. If you need it, CLOUD-STOP.',
  "Follow the project's CLAUDE.md; the rules below are the most important ones for the track.",
  'No personal data or secrets in logs, error messages or commits. No dev server or preview.',
  'Commit only the files you own (git add -- <files>); do not touch files outside the ownership list.',
];

/** The rules the cloud package brings along: the general ones and the project's architecture rules (config().architectureRules). */
function cloudRules() {
  const ownOnes = Array.isArray(cfg().architectureRules) ? cfg().architectureRules : [];
  return [...CLOUD_RULES_COMMON, ...ownOnes.map(String).filter((r) => r.trim())];
}

/** Bundle: at most this many tasks, and at most this many minutes of estimate in total, in one cloud session. */
const CLOUD_BUNDLE_MAX = 4;
const CLOUD_BUNDLE_MIN = 120;

const CLOUD_GATES =
  'npm install; the tests for the new/changed files; and at the end, before push, ' +
  `\`${require('./projectRoot.js').cqCommand()} gates --quick --wave cloud --track <id>\` (the quick gates from config().gates.quick). ` +
  'If a gate is red, fix it and run it again; if it is red because of something outside the task or an environment issue in the cloud, ' +
  'mention it in the report.';
// npm install can rewrite package-lock.json; then the session must reset it itself.
const CLOUD_LOCK =
  'Do not commit package-lock.json unless the mission says so (npm install rewrites it; reset it before commit).';
const commitLine = (id) =>
  `Commit message: "<type>(<area>): <summary> (${id})" + line "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>".`;
const branchLine = (branch, explanation = '') => {
  const r = remoteName();
  const b = baseBranch();
  return (
    `Branch rule${explanation}: start from ${r}/${b} (git fetch ${r} ${b} && git checkout -b ${branch} ${r}/${b}). ` +
    `Push only branch ${branch} to ${r}. If the push to ${branch} is rejected by access rules, push instead to the ` +
    `branch the session is allowed to use (for example claude/...) and write the name of the branch in the report. Never ${b}, ` +
    'never PR.'
  );
};

/** "Files the cloud does not see …" for all the parts in the package, or null. */
function hiddenLine(parts) {
  const paths = [
    ...new Set(
      parts.flatMap((d) =>
        cloudReferences(d.text, { id: d.o.id, ownPath: d.ownPath }).map((r) => r.path),
      ),
    ),
  ];
  return paths.length
    ? `Files the cloud does not see (gitignored or untracked): ${paths.join(', ')}. Everything binding is in the mission ` +
        'below; ignore these references.'
    : null;
}

/**
 * The cloud package: one self-contained message for the routine "queue-cloud" (or to paste into a cloud session). Structure: branch rule, gates, commit message, files the cloud does not see, rules, report format, and then
 * the mission in full with the track block.
 * @param {{ text: string, ownPath?: string|null }} v the mission text (the file or the text itself)
 */
function cloudPackage(o, queue, { text, ownPath = null } = {}) {
  const id = o.id;
  const hidden = hiddenLine([{ o, text, ownPath }]);
  return [
    `# CLOUD TRACK ${id} (class ${o.class}, approx. ${estimate(o)} min)`,
    '',
    branchLine(queueBranch(id)),
    `Gates in the cloud: ${CLOUD_GATES}`,
    CLOUD_LOCK,
    commitLine(id),
    ...(hidden ? [hidden] : []),
    '',
    'Rules (the ones that apply to this track):',
    ...cloudRules().map((r) => `- ${r}`),
    '',
    'Report: at most 20 lines (what, files, test result red first then green, gates, branch), last line ' +
      `"CLOUD-DONE ${id} <sha>" or "CLOUD-STOP ${id} <reason>".`,
    '',
    '## The mission',
    '',
    trackBlock(o, queue, { text, cloud: true }),
  ].join('\n');
}

/**
 * The cap for a bundle: at most CLOUD_BUNDLE_MAX tasks and CLOUD_BUNDLE_MIN minutes of estimate, and no id twice.
 * @param {object[]} tasks
 * @returns {string[]} the reasons (empty = within the cap)
 */
function cloudBundleCap(tasks, { max = CLOUD_BUNDLE_MAX, maxMin = CLOUD_BUNDLE_MIN } = {}) {
  const reasons = [];
  const ids = tasks.map((o) => o.id);
  if (new Set(ids).size !== ids.length) reasons.push('the same task twice');
  if (tasks.length > max) reasons.push(`${tasks.length} tasks (at most ${max} in one bundle)`);
  const sum = tasks.reduce((s, o) => s + estimate(o), 0);
  if (sum > maxMin) reasons.push(`${sum} min estimate in total (at most approx. ${maxMin} in one bundle)`);
  return reasons;
}

/**
 * The cloud package for a bundle: several small tasks in one cloud session (the startup, clone + npm install + CLAUDE.md, costs the same
 * regardless of size). The missions are done one after another in the order given. Each gets its own queue branch made from
 * <remote>/<baseBranch> (never from the previous task's branch), its own commit, its own push and its own report line; a stop on one
 * does not hinder the next ones. The last line is CLOUD-BUNDLE-DONE <done>/<count>. One task gives the usual cloudPackage.
 * @param {{ o: object, text: string, ownPath?: string|null }[]} parts
 */
function cloudBundlePackage(parts, queue) {
  if (parts.length === 1) return cloudPackage(parts[0].o, queue, parts[0]);
  const n = parts.length;
  const ids = parts.map((d) => d.o.id);
  const sum = parts.reduce((s, d) => s + estimate(d.o), 0);
  const hidden = hiddenLine(parts);
  return [
    `# CLOUD BUNDLE ${ids.join(', ')} (${n} tasks, approx. ${sum} min)`,
    '',
    `Do the ${n} missions below one after another, in this order: ${ids.join(' → ')}. For EACH task:`,
    `- ${branchLine(queueBranch('<id>'), ' (own branch per task)')} Make each branch from ${remoteName()}/${baseBranch()}, ` +
      'never from the previous ' +
      "task's branch, and do not bring along changes from an earlier task.",
    `- Own commit and own push. ${commitLine('<id>')}`,
    `- Gates for the task: ${CLOUD_GATES}`,
    '- Report line right after the push: "CLOUD-DONE <id> <sha>", or "CLOUD-STOP <id> <reason>" when the task cannot ' +
      'be done. A stop does not hinder the next ones: move on to the next task.',
    CLOUD_LOCK,
    ...(hidden ? [hidden] : []),
    '',
    'Rules (the ones that apply to all tasks):',
    ...cloudRules().map((r) => `- ${r}`),
    '',
    'Report: at most 8 lines per task (what, files, test result red first then green, gates, branch), each ending ' +
      'with its report line. Last line of the whole report: ' +
      `"CLOUD-BUNDLE-DONE <count CLOUD-DONE>/${n}".`,
    '',
    ...parts.flatMap((d, i) => [
      '---',
      '',
      `# Task ${i + 1} of ${n}: ${d.o.id} (branch ${queueBranch(d.o.id)})`,
      '',
      trackBlock(d.o, queue, { text: d.text, cloud: true }),
    ]),
  ].join('\n');
}

/**
 * Proposed bundles (`queue.mjs cloud-bundles`): the cloud-suitable candidates grouped by project and feature (same area
 * one after another, so the context is reused), the groups by best priority, and within the group by priority. Then
 * the bundles are filled in that order as long as the cap holds; a task that alone is over the cap stands alone.
 * @param {{ id: string, project: string, feature?: string|null, estimate: number, score: number }[]} candidates
 * @returns {{ ids: string[], minutes: number, areas: string[] }[]}
 */
function cloudBundles(candidates, { max = CLOUD_BUNDLE_MAX, maxMin = CLOUD_BUNDLE_MIN } = {}) {
  const groups = new Map();
  for (const k of candidates) {
    const area = `${k.project}${k.feature ? ` / ${k.feature}` : ''}`;
    if (!groups.has(area)) groups.set(area, []);
    groups.get(area).push({ ...k, area });
  }
  const afterScore = (a, b) => b.score - a.score || a.id.localeCompare(b.id);
  const sorted = [...groups.values()]
    .map((g) => g.sort(afterScore))
    .sort((a, b) => afterScore(a[0], b[0]))
    .flat();
  const bundles = [];
  let now = null;
  for (const k of sorted) {
    if (!now || now.ids.length >= max || now.minutes + k.estimate > maxMin) {
      now = { ids: [], minutes: 0, areas: [] };
      bundles.push(now);
    }
    now.ids.push(k.id);
    now.minutes += k.estimate;
    if (!now.areas.includes(k.area)) now.areas.push(k.area);
  }
  return bundles;
}

/** Number of cloud sessions running: tasks in the same session (same execution, or same bundle) count once. */
function cloudSessions(queue) {
  return new Set((queue.tasks ?? []).filter(isCloud).map((o) => o.cloud.execution ?? o.cloud.bundle ?? o.id))
    .size;
}

/**
 * `queue.mjs cloud start <id> [<id> …]`: picks tasks for one cloud session (picked_by "cloud", branch queue/<id>) and sets
 * `cloud: { started, execution?, bundle? }` (bundle = the ids when several run in the same session). All or nothing. Refuses when a
 * task is not suitable (`suitability` per id, computed by the caller with git), when the bundle is over the cap, or when CLOUD_MAX
 * cloud sessions are already running; `force` overrides those three, and the pick's blockers. If a task is already in the cloud, only
 * the execution is set (the orchestrator got the session id after the owner pressed start).
 * @param {string|string[]} ids
 * @param {{ suitability?: Record<string, { suitable: boolean, reasons: string[] }>, execution?: string|null, force?: boolean,
 *   now?: string }} v
 * @returns {{ error: string } | { tasks: object[], newOnes: string[], left: string[], overridden: string[] }}
 */
function cloudStart(
  queue,
  ids,
  { suitability = {}, execution = null, force = false, now = new Date().toISOString() } = {},
) {
  const list = [].concat(ids);
  const tasks = [];
  for (const id of list) {
    const o = (queue.tasks ?? []).find((x) => x.id === id);
    if (!o) return { error: `unknown task ${id}` };
    tasks.push(o);
  }
  const newOnes = tasks.filter((o) => !isCloud(o));
  const left = tasks.filter((o) => isCloud(o));
  const overridden = [];
  const stop = (text) => {
    if (!force) return `${text} (--force overrides)`;
    overridden.push(text);
    return null;
  };
  for (const o of newOnes) {
    const e = suitability[o.id];
    if (e && !e.suitable) {
      const f = stop(`${o.id} is not suitable for the cloud: ${e.reasons.join(' · ')}`);
      if (f) return { error: f };
    }
  }
  const cap = cloudBundleCap(tasks);
  if (cap.length) {
    const f = stop(`the bundle is over the cap: ${cap.join(' · ')}`);
    if (f) return { error: f };
  }
  if (newOnes.length) {
    const sessions = cloudSessions(queue);
    if (sessions >= CLOUD_MAX) {
      const f = stop(`${sessions} cloud sessions are already running (at most ${CLOUD_MAX})`);
      if (f) return { error: f };
    }
  }
  // pick changes the queue; check all before any is changed (the caller does not write the file on error, but keep it clean).
  for (const o of newOnes) {
    if (o.status !== 'waiting')
      return { error: `${o.id} cannot be started in the cloud: status ${o.status}` };
  }
  const bundle = list.length > 1 ? list.join(',') : null;
  for (const o of newOnes) {
    const p = pick(queue, o.id, { by: CLOUD_BY, force, now });
    if (p.error) return p;
    overridden.push(...p.overridden);
    o.cloud = { started: now, ...(execution ? { execution } : {}), ...(bundle ? { bundle } : {}) };
  }
  for (const o of left) if (execution) o.cloud.execution = execution;
  return {
    tasks,
    newOnes: newOnes.map((o) => o.id),
    left: left.map((o) => o.id),
    overridden,
  };
}

/**
 * `queue.mjs cloud done`: the cloud has pushed the branch (the caller has checked it with git). The task goes to review as with
 * `deliver`, with `cloud.done`, branch and the sha. The orchestrator merges.
 */
function cloudDone(queue, id, { branch, sha = null, now = new Date().toISOString() } = {}) {
  const o = (queue.tasks ?? []).find((x) => x.id === id);
  if (!o) return { error: `unknown task ${id}` };
  if (!isCloud(o))
    return {
      error: `${id} is not in a cloud session (status ${o.status}${o.picked_by ? `, picked by ${o.picked_by}` : ''})`,
    };
  const l = deliver(queue, id, now);
  if (l.error) return l;
  o.cloud = { ...o.cloud, done: now, branch: branch ?? queueBranch(id), ...(sha ? { sha } : {}) };
  return { task: o };
}

/** `queue.mjs cloud cancel` = release for a cloud session (branch and migration block kept, the cloud field is removed). */
function cloudCancel(queue, id, { commits = 0, now = new Date().toISOString() } = {}) {
  const o = (queue.tasks ?? []).find((x) => x.id === id);
  if (!o) return { error: `unknown task ${id}` };
  if (!isCloud(o)) return { error: `${id} is not in a cloud session (status ${o.status})` };
  const execution = o.cloud?.execution ?? null;
  const s = release(queue, id, { commits, now });
  if (s.error) return s;
  o.remarks = [...(o.remarks ?? []), `${now} cloud session aborted${execution ? ` (${execution})` : ''}`];
  return s;
}

// ---- The orchestrator's routine as script and cost per task -----
//
// `show` (short by default), `fill`, `receive`, `set <id> done` and `cost` in queue.mjs. Here is only the pure part: the
// short view, agent type and agent message, the content of the review package, the parsers for the RESULT and FINDINGS lines, which
// agents in the time log belong to a task, and the sum of the cost. Git, the transcripts and the time log are read in queue.mjs.
// Tested in lib/__tests__/queueOrchestrator.test.ts.

/** The agent type for a track by class: D and D+ on `track-d` (high), K and U on `track` (medium). */
function agentTypeFor(cls) {
  return cls === 'D' || cls === 'D+' ? 'track-d' : 'track';
}

/** The models the Agent tool takes (config().models). */
const AGENT_MODELS = ['opus', 'sonnet', 'haiku', 'fable'];

/**
 * The model set for an agent in config().models, or null (the agent file's own model). An unknown value counts as
 * not set, so a typo never starts an agent with a model the Agent tool refuses.
 * @param {string} agent the agent name without the plugin prefix (track, reviewer-docs ...)
 */
function modelFor(agent) {
  let m;
  try {
    m = cfg().models?.[String(agent ?? '').replace(/^[^:]+:/, '')];
  } catch {
    return null; // no config: the agent file decides
  }
  const v = typeof m === 'string' ? m.trim().toLowerCase() : null;
  return v && AGENT_MODELS.includes(v) ? v : null;
}

/** " · model=sonnet" for a start line when the agent has a model set, otherwise "". */
function modelPart(agent) {
  const m = modelFor(agent);
  return m ? ` · model=${m}` : '';
}

/** The FIXED reviewers by class (config().reviewers): by default K and U none, D `reviewer`, D+ also `reviewer-security`. */
function reviewersFor(cls) {
  return HELP.fixedFor(cfg(), cls);
}

/**
 * All the reviewers for a task: the fixed ones for its class and the helpers that are on and hit (queueHelpers.js).
 * @returns {{ type: string, fixed: boolean, reasons: string[] }[]}
 */
function reviewersForTask(o, { queue = null, changedPaths = [], missionText = null, hashes = null } = {}) {
  return HELP.reviewersForTask(o, { config: cfg(), queue, changedPaths, missionText, hashes });
}

/** All reviewer types (fixed and helpers, unique, in order): the agents that count toward a task. */
function reviewerTypes(queue = null) {
  return HELP.allReviewerTypes(cfg(), queue);
}

/**
 * The short message the orchestrator starts the track agent with; the mission is in the prompt file. "track <id>" and
 * "prompt-<id>.md" in the text are what timeCost.trackFromText recognizes the track by (the cost per task).
 */
function trackMessage(id, promptPath) {
  return (
    `You are track ${id} in the work queue (continuous queue, wave "queue"). Your mission is in ${promptPath} and is ` +
    'binding: read it first and follow the protocol there. Your answer to the orchestrator is at most approx. 1,500 characters: ' +
    'RESULT line first, at most 5 lines, then the path to report.md (the long version is there).'
  );
}

/** The summary line under `show` (same in the short and full view). `t` is queueLogic.state. */
function stateLine(t) {
  return (
    `${t.activeOnes} active · ${t.picked ? `${t.picked} picked · ` : ''}${t.waiting} waiting · ${t.proposed} proposed · ` +
    `${t.canStart} can start now` +
    `${t.batched ? ` · ${t.batched} in the batch queue (cq batch)` : ''}` +
    `${t.qa ? ` · ${t.qa} in the QA list (cq qa)` : ''}${t.external ? ` · ${t.external} outside the queue (cq external)` : ''}` +
    `${t.parked ? ` · ${t.parked} parked (cq continue)` : ''}` +
    `${t.focus?.notice ? ' · FOCUS WARNING (cq focus)' : ''}` +
    `${t.empty ? ' · THE QUEUE IS OUT OF WORK' : ''}`
  );
}

const SUMMARY_STATUSES = ['running', 'review', 'picked'];

/**
 * `queue.mjs show` (short, the default for the orchestrator): one line per active task (running, review, picked) and per
 * task that can start now, then the counts. The target is below approx. 3,000 characters (the full table was approx. 66,000 characters,
 * approx. 20,000 tokens per call). The full one is behind `show --full`.
 * @param {object} queue the queue
 * `costEstimate` (o => { usd }, lib/costEstimate.js calibratedCost with a model) adds "~$x" to the startable lines, and
 * with `outlook` (lib/costEstimate.js budgetOutlook) a budget outlook line; passed in by queue.mjs, since costEstimate.js
 * itself requires this module.
 * @param {object} queue the queue
 * @param {{ now?: number, uncommitted?: string[], dailyUsage?: number, width?: number,
 *   costEstimate?: ((o: object) => { usd: number }) | null, outlook?: ((b: object, usd: number) => { message: string } | null) | null }} [option]
 * @returns {string[]} the lines
 */
function summaryView(
  queue,
  {
    now = Date.now(),
    uncommitted = [],
    dailyUsage,
    width = 110,
    cursor = null,
    load = null,
    costEstimate = null,
    outlook = null,
  } = {},
) {
  const tasks = queue.tasks ?? [];
  const cut = (s) => (s.length > width ? `${s.slice(0, width - 1)}…` : s);
  const out = [];

  const activeOnes = tasks.filter((o) => SUMMARY_STATUSES.includes(o.status) && !isExternalRow(o));
  out.push(`ACTIVE (${activeOnes.length}):`);
  for (const o of activeOnes) {
    // Age: in review since delivery, picked since picking, otherwise since start.
    const from =
      o.status === 'picked'
        ? o.picked_at
        : o.status === 'review'
          ? (o.delivered ?? o.started)
          : o.started;
    const age = from ? ageText(now - Date.parse(from)) : '?';
    const who = o.status === 'picked' ? ` by ${o.picked_by ?? '?'}` : '';
    out.push(
      cut(
        `  ${o.id.padEnd(12)} ${o.status.padEnd(7)} ${String(o.class).padEnd(2)} ${age.padEnd(10)} ` +
          `migr ${o.migr_block ?? '-'}${who}  ${o.title ?? ''}`,
      ),
    );
  }

  const guard = startGuard(queue, dailyUsage, { now, cursor, load });
  const startable = guard ? [] : selectNext(queue, now, { uncommitted, load });
  // Load-aware slots: say why fewer tracks start (only when the load limits them).
  const ls = load && !guard ? loadSlotsFor(queue, load) : null;
  if (ls?.limited) out.push(cut(`LOAD: ${ls.reason}. Fewer tracks start until the load goes down.`));
  out.push(
    `STARTABLE NOW (${startable.length}${startable.length ? '; cq fill starts them' : ''}):`,
  );
  for (const v of startable) {
    const o = tasks.find((x) => x.id === v.id);
    out.push(
      cut(
        `  ${v.id.padEnd(12)} ${v.class.padEnd(2)} ${String(v.domain).padEnd(12)} ${`${v.estimate} min`.padEnd(8)} ` +
          (costEstimate ? `${costLabel(costEstimate(o)).padEnd(6)} ` : '') +
          `prio ${v.score}${'step' in v ? ` ${stepText(v)}` : ''}  ${o?.title ?? ''}`,
      ),
    );
  }
  if (guard) out.push(cut(`  ${guard.message}`));

  const t = state(queue, dailyUsage, { uncommitted, now, cursor, load });
  // The focus line and the warning (only when a focus is set).
  if (t.focus) {
    out.push(cut(`FOCUS${t.focus.name ? ` "${t.focus.name}"` : ''}: ${t.focus.text}`));
    if (t.focus.active)
      out.push(
        cut(
          `  ${t.focus.readyOnes} ready in focus · ${t.focus.in_focus} waiting in focus · ${t.focus.inProgress} in progress · ` +
            `${t.focus.dragged_with} pulled along`,
        ),
      );
    if (t.focus.notice) out.push(cut(`  ${t.focus.notice}`));
  }
  const waiting = tasks.filter((o) => o.status === 'waiting' && !isBatched(o));
  const perClass = Object.keys(WEIGHT)
    .map((k) => [k, waiting.filter((o) => o.class === k).length])
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} ${n}`)
    .join(' · ');
  out.push('', stateLine(t));
  if (waiting.length)
    out.push(
      `Waiting per class: ${perClass}; ${t.blocked.length} of them are blocked now (see show --full).`,
    );
  const batch = batchGroups(queue);
  if (batch.length) {
    const n = batch.reduce((s, g) => s + g.count, 0);
    const readyOnes = batch.filter((g) => g.ready).length;
    out.push(
      `BATCH_QUEUE (${n} task(s) in ${batch.length} group(s)${readyOnes ? `, ${readyOnes} ready for packing` : ''}; ` +
        'cq batch)',
    );
  }
  if (t.ownerQuestion.length)
    out.push(
      cut(
        `Owner questions that unlock the most: ${t.ownerQuestion
          .slice(0, 5)
          .map((s) => `${s.sp} (${s.tasks})`)
          .join(' · ')}`,
      ),
    );
  if (!guard) {
    const b = budgetGuard(queue, dailyUsage);
    if (b.active && b.message) out.push(cut(b.message));
    // The calibrated estimate of what can start now against what is left of the budget (information only).
    if (b.active && outlook && costEstimate) {
      const sum = startable.reduce((s, v) => s + (costEstimate(tasks.find((x) => x.id === v.id))?.usd ?? 0), 0);
      const line = outlook(b, sum)?.message;
      if (line) out.push(cut(line));
    }
    const n = nightGuard(queue, now);
    if (n.active && n.message) out.push(cut(n.message));
  }
  out.push('Full list: cq show --full (or --all, --grouped, --project <pid>).');
  return out;
}

// ---- RESULT and FINDINGS lines ------------------------------------------------------------------------------

/**
 * Finds the first line that starts with `word` (RESULT or FINDINGS). Tolerant: markdown characters (`*`, backtick, `>`,
 * `#`, `-`) around the line and a colon after the word are accepted.
 * @returns {{ line: string, rest: string } | null}
 */
function fixedLine(text, word) {
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const l = raw
      .replace(/[`*]/g, '')
      .replace(/^[\s>#-]+/, '')
      .trim();
    if (l === word || l.startsWith(`${word} `) || l.startsWith(`${word}:`))
      return {
        line: l,
        rest: l.slice(word.length).replace(/^:/, '').trim(),
      };
  }
  return null;
}

/** The `key=value` pairs in the rest of a fixed line; the keys in lowercase. */
function keyValues(rest) {
  const out = {};
  // Keys are lowercased, so camelCase keys (ownerQuestions) are read as lowercase (ownerquestions).
  for (const m of String(rest).matchAll(/([A-Za-z\u00C6\u00D8\u00C5\u00E6\u00F8\u00E5_]+)=(\S*)/g)) out[m[1].toLowerCase()] = m[2];
  return out;
}

const numberOrNull = (v) => (v != null && /^\d+$/.test(v) ? Number(v) : null);

/**
 * The track's RESULT line, e.g. `RESULT status=DONE branch=queue/X commits=3 migr=3490-3492 gates=OK
 * probe=red→green(12/12) ownerQuestions=0 edge=-` (`probe`: the tests red before and green after; `edge`: deploy after
 * the merge, `-` = none). Missing line: null (the caller falls back to the current behavior).
 * @returns {null | { line: string, status: string|null, branch: string|null, commits: number|null, migr: string|null,
 *   gates: string|null, probe: string|null, ownerQuestions: number|null, edge: string|null, extra: object }}
 */
function parseResult(text) {
  const f = fixedLine(text, 'RESULT');
  if (!f) return null;
  const kv = keyValues(f.rest);
  const known = ['status', 'branch', 'commits', 'migr', 'gates', 'probe', 'ownerquestions', 'edge'];
  const extra = {};
  for (const [k, v] of Object.entries(kv)) if (!known.includes(k)) extra[k] = v;
  return {
    line: f.line,
    status: kv.status ? kv.status.toUpperCase() : null,
    branch: kv.branch ?? null,
    commits: numberOrNull(kv.commits),
    migr: kv.migr ?? null,
    gates: kv.gates ?? null,
    probe: kv.probe ?? null,
    ownerQuestions: numberOrNull(kv.ownerquestions),
    edge: kv.edge ?? null,
    extra,
  };
}

/**
 * The reviewer's FINDINGS line, e.g. `FINDINGS H=0 M=1 L=3 deferrable=L2,L3`. Missing line: null. A missing number
 * becomes 0 when at least one of H/M/L is there.
 * @returns {null | { line: string, H: number, M: number, L: number, deferrable: string[] }}
 */
function parseFindings(text) {
  const f = fixedLine(text, 'FINDINGS');
  if (!f) return null;
  const kv = keyValues(f.rest);
  const h = numberOrNull(kv.h);
  const m = numberOrNull(kv.m);
  const l = numberOrNull(kv.l);
  if (h == null && m == null && l == null) return null;
  const u = String(kv.deferrable ?? '').trim();
  return {
    line: f.line,
    H: h ?? 0,
    M: m ?? 0,
    L: l ?? 0,
    deferrable:
      !u || u === '-'
        ? []
        : u
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean),
  };
}

/** The sum of the review reports' FINDINGS lines (one per reviewer and round). No lines: null. */
function batchFindings(list) {
  const validOnes = (list ?? []).filter(Boolean);
  if (!validOnes.length) return null;
  const out = { H: 0, M: 0, L: 0, deferrable: [], reports: validOnes.length };
  for (const f of validOnes) {
    out.H += f.H;
    out.M += f.M;
    out.L += f.L;
    for (const x of f.deferrable) if (!out.deferrable.includes(x)) out.deferrable.push(x);
  }
  return out;
}

// ---- The transcripts (the track's and the reviewer's last answer) ----------------------------------------------------------

/** The lines in an agent transcript (JSONL) as objects; broken lines are skipped. */
function transcriptRows(text) {
  const out = [];
  for (const l of String(text ?? '').split('\n')) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      /* half line (the transcript is written while we read) */
    }
  }
  return out;
}

/**
 * The agent's last answer: the last text from the assistant, or the message in a SubagentHandback call (the report
 * is delivered that way when the agent has that tool). Null when the transcript has no answer.
 */
function lastAnswer(text) {
  let last = null;
  for (const r of transcriptRows(text)) {
    if (r.type !== 'assistant' || !Array.isArray(r.message?.content)) continue;
    for (const c of r.message.content) {
      if (c?.type === 'text' && String(c.text ?? '').trim()) last = c.text;
      else if (c?.type === 'tool_use' && c.name === 'SubagentHandback' && c.input?.message)
        last = c.input.message;
    }
  }
  return last;
}

/** The first user message in a transcript (the mission the agent got). */
function firstUserMessage(text) {
  for (const r of transcriptRows(text)) {
    if (r.type !== 'user' || !r.message) continue;
    const m = r.message.content;
    if (typeof m === 'string') return m;
    if (Array.isArray(m)) return m.map((c) => c?.text ?? '').join(' ');
  }
  return null;
}

/**
 * Does the text mention the task id as a whole word? `A-1b` is found in "queue/A-1b" and "A-1b-r2", but not in "A-1b2" or
 * "XA-1b".
 */
function mentionsTask(text, id) {
  return new RegExp(`(^|[^A-Za-z0-9-])${regexSafe(id)}(?![A-Za-z0-9])`).test(String(text ?? ''));
}

// ---- Cost per task ---------------------------------------------------------------------------------------

/** The agent types that count toward a task: tracks and the reviewers (from the setup). */
const taskAgentTypes = () => ['track', 'track-d', ...reviewerTypes()];

/**
 * The agents in the time log (config().timeLog, written by hook-time.mjs from the transcripts) that belong to the
 * task. `secure`: the track label is the task or a fix round of it (timeCost.taskIdFor). `uncertainOnes`: agents
 * without a recognized track label (the label is the agent id) of the types track, track-d and the reviewers, that stopped after `from`
 * and started before `to`; the caller keeps them only when their mission mentions the task (mentionsTask).
 * The rows are cumulative; the last row with tokens per agent is the agent's total usage.
 * @returns {{ secure: {agent: string, type: string, row: object}[], uncertainOnes: {agent: string, type: string, row: object}[] }}
 */
function agentsForTask(rows, id, { from = null, to = null } = {}) {
  const last = new Map();
  const first = new Map();
  const types = new Map();
  for (const r of rows ?? []) {
    if (!r?.agent_id) continue;
    const t = Date.parse(r.time);
    if (!first.has(r.agent_id) || t < first.get(r.agent_id)) first.set(r.agent_id, t);
    if (r.agent_type) types.set(r.agent_id, require('./projectRoot.js').bareAgentType(r.agent_type));
    if (r.event !== 'done' || !r.tokens) continue;
    const f = last.get(r.agent_id);
    if (!f || t >= Date.parse(f.time)) last.set(r.agent_id, r);
  }
  const isId = (s) => s === id;
  const secure = [];
  const uncertainOnes = [];
  for (const [agent, row] of last) {
    const type = types.get(agent) ?? 'unknown';
    const track = row.track ?? null;
    if (track && TK.taskIdFor(track, isId) === id) {
      secure.push({ agent, type, row });
      continue;
    }
    const unknownTrack = !track || agent.startsWith(track);
    if (!unknownTrack || !taskAgentTypes().includes(type)) continue;
    if (from && Date.parse(row.time) < Date.parse(from)) continue;
    if (to && first.get(agent) > Date.parse(to)) continue;
    uncertainOnes.push({ agent, type, row });
  }
  return { secure, uncertainOnes };
}

/**
 * The sum of the usage of the agents that belonged to the task. Each agent has `tokens` and `model` from the transcript
 * (timeCost.analyzeTranscript) or from the last row in the time log; the price is timeCost.costUsd (API-equivalent USD).
 * @param {{ agent: string, type: string, tokens: object, model?: string|null, turns?: number, source?: string,
 *   minutes?: number|null, findings?: { H: number, M: number, L: number }|null }[]} agents
 * @returns {{ usd: number, tokens: { input: number, output: number, cache_read: number, cache_written: number,
 *   sum: number }, turns: number, agents: { agent: string, type: string, usd: number, source: string }[],
 *   measured: string }}
 */
function sumCost(agents, now = new Date().toISOString()) {
  const tokens = { input: 0, output: 0, cache_read: 0, cache_written: 0, sum: 0 };
  let usd = 0;
  let turns = 0;
  const list = [];
  for (const a of agents ?? []) {
    const u = TK.costUsd(a.tokens, a.model ?? undefined);
    usd += u;
    turns += Number(a.turns ?? 0) || 0;
    for (const k of ['input', 'output', 'cache_read', 'cache_written']) {
      const n = Number(a.tokens?.[k] ?? 0) || 0;
      tokens[k] += n;
      tokens.sum += n;
    }
    // Per agent also the tokens, the minutes and (for reviewers) the FINDINGS numbers: the helper measurement
    // (queueHelpers.helperStatistics) reads them from cost.agents. Fields without a value are left out.
    const entry = { agent: a.agent, type: a.type, usd: round2(u), source: a.source ?? 'timeLog' };
    entry.tokens = ['input', 'output', 'cache_read', 'cache_written'].reduce(
      (s, k) => s + (Number(a.tokens?.[k] ?? 0) || 0),
      0,
    );
    if (Number.isFinite(Number(a.minutes)) && a.minutes != null) entry.minutes = Math.round(Number(a.minutes) * 10) / 10;
    if (a.findings) entry.findings = { H: a.findings.H, M: a.findings.M, L: a.findings.L };
    list.push(entry);
  }
  return { usd: round2(usd), tokens, turns, agents: list, measured: now };
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * The statistics `queue.mjs cost` shows: finished tasks with measured cost (since `since`), per class and total, with findings
 * from the review.
 * @returns {{ rows: object[], perClass: object[], total: { n: number, usd: number } }}
 */
function costStatistics(queue, { since = null } = {}) {
  const rows = (queue.tasks ?? [])
    .filter((o) => o.status === 'done' && o.cost && Number.isFinite(Number(o.cost.usd)))
    .filter((o) => !since || Date.parse(o.done ?? o.cost.measured) >= Date.parse(since))
    .map((o) => ({
      id: o.id,
      class: o.class,
      done: o.done ?? null,
      usd: Number(o.cost.usd),
      tokens: Number(o.cost.tokens?.sum ?? 0),
      agents: (o.cost.agents ?? []).length,
      findings: o.findings ?? null,
      result: o.result?.status ?? null,
    }))
    .sort((a, b) => String(b.done).localeCompare(String(a.done)));
  const perClass = Object.keys(WEIGHT)
    .map((cls) => {
      const r = rows.filter((x) => x.class === cls);
      const withFindings = r.filter((x) => x.findings);
      return {
        class: cls,
        n: r.length,
        usd: round2(r.reduce((s, x) => s + x.usd, 0)),
        median_usd: r.length ? round2(median(r.map((x) => x.usd))) : null,
        reviewed: withFindings.length,
        H: withFindings.reduce((s, x) => s + x.findings.H, 0),
        M: withFindings.reduce((s, x) => s + x.findings.M, 0),
        L: withFindings.reduce((s, x) => s + x.findings.L, 0),
      };
    })
    .filter((k) => k.n > 0);
  return {
    rows,
    perClass,
    total: { n: rows.length, usd: round2(rows.reduce((s, x) => s + x.usd, 0)) },
  };
}

// ---- Review package (`queue.mjs receive`) -------------------------------------------------------------------------------

/**
 * Which files the package gets in full version from the branch. `nameStatus` is `git diff --name-status --no-renames`, `numstat`
 * is `git diff --numstat --no-renames` (binary files have "-" in the numbers). Deleted and binary files are skipped.
 * @returns {{ copy: string[], skipped: { path: string, reason: string }[] }}
 */
function packageFiles(nameStatus, numstat) {
  const binary = new Set();
  for (const l of String(numstat ?? '').split(/\r?\n/)) {
    const m = l.match(/^-\t-\t(.+)$/);
    if (m) binary.add(m[1]);
  }
  const copy = [];
  const skipped = [];
  for (const l of String(nameStatus ?? '').split(/\r?\n/)) {
    const m = l.match(/^([A-Z])\d*\t(.+)$/);
    if (!m) continue;
    const [, s, filePath] = m;
    if (s === 'D') skipped.push({ path: filePath, reason: 'deleted' });
    else if (binary.has(filePath)) skipped.push({ path: filePath, reason: 'binary' });
    else copy.push(filePath);
  }
  return { copy, skipped };
}

/**
 * Changed DB objects in the diff: `create`/`alter`/`drop` of function, table, policy, trigger, view, index and type on
 * new lines in .sql files under the migration folder (config().migrations.folder). Policies get the table included when it is
 * on the same line. Without a migration folder: empty list.
 * @param {string} diff
 * @param {{ folder?: string|null }} [migrations]
 * @returns {string[]} e.g. "create function public.foo", "create policy "read" on public.bar"
 */
function dbObjectsFromDiff(diff, migrations = cfg().migrations) {
  const folder = migrations?.folder
    ? String(migrations.folder).replace(/\\/g, '/').replace(/\/+$/, '')
    : null;
  if (!folder) return [];
  const fileRe = new RegExp(`^${regexSafe(folder)}/.+\\.sql$`);
  const out = [];
  let file = null;
  const re =
    /^\+\s*(create|alter|drop)\s+(?:or\s+replace\s+)?(?:unique\s+)?(function|procedure|table|policy|trigger|materialized\s+view|view|index|type)\s+(?:if\s+(?:not\s+)?exists\s+)?(?:concurrently\s+)?("[^"]+"|[\w.]+(?:\."[^"]+")?)(.*)$/i;
  for (const l of String(diff ?? '').split(/\r?\n/)) {
    if (l.startsWith('+++ ')) {
      file = l.replace(/^\+\+\+ (b\/)?/, '');
      continue;
    }
    if (!file || !fileRe.test(file) || l.startsWith('+++')) continue;
    const m = l.match(re);
    if (!m) continue;
    const type = m[2].toLowerCase().replace(/\s+/g, ' ');
    let name = `${m[1].toLowerCase()} ${type} ${m[3]}`;
    if (type === 'policy') {
      const on = m[4].match(/\bon\s+([\w."]+)/i);
      if (on) name += ` on ${on[1]}`;
    }
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * The index file in the review package (`00-package.md`): what the task is, the track's RESULT line, the diff statistics, changed
 * DB objects and which files are in the package. The package is PLAIN FILES (a reviewer without Bash cannot read
 * git objects).
 */
function reviewPackageIndex({
  o,
  branch,
  stat,
  dbObjects = [],
  copied = [],
  skipped = [],
  result = null,
  files = {},
  base = baseBranch(),
  migrFolder = cfg().migrations?.folder ?? null,
  reviewers = null,
}) {
  const lines = [
    `# Review package ${o.id} (${o.class}): ${o.title ?? ''}`,
    '',
    `Branch \`${branch}\`, diff against \`${base}\` (merge-base).` +
      (migrFolder ? ` Migration block: ${o.migr_block ?? 'none'}.` : ''),
    `Track result line: ${result ? `\`${result.line}\`` : "(missing; see the track's answer and report)"}`,
    '',
    '## The files in the package',
    '',
    `- \`diff.patch\`: the whole diff (\`git diff ${base}...<branch>\`).`,
    `- \`files/\`: ${copied.length} changed file(s) in full version from the branch (same paths as in the repo).`,
  ];
  if (files.trackReply)
    lines.push("- `trackReply.md`: the track's last answer (the report to the orchestrator).");
  if (files.report)
    lines.push("- `trackReport.md`: the track's `report.md` (self-review, test run, connections).");
  if (files.handover) lines.push('- `handover.md`: the handover from a PARTIAL track.');
  if (files.mission) lines.push("- `mission.md`: the track's mission (its prompt file).");
  if (skipped.length)
    lines.push(`- Not included: ${skipped.map((h) => `\`${h.path}\` (${h.reason})`).join(', ')}.`);
  if (migrFolder) {
    lines.push('', '## Changed DB objects', '');
    if (dbObjects.length) for (const d of dbObjects) lines.push(`- ${d}`);
    else lines.push(`- (none in ${migrFolder})`);
  }
  // The reviewers for this task (queueHelpers.reviewersForTask): the fixed ones for the class (the floor), then each
  // helper agent with one line on why it was chosen.
  if (Array.isArray(reviewers)) {
    lines.push('', '## Reviewers', '');
    if (!reviewers.length) lines.push('- (none for this task)');
    for (const x of reviewers)
      lines.push(`- \`${x.type}\`: ${x.fixed ? 'fixed for the class' : 'helper agent'}. why: ${x.reasons.join(', ')}`);
  }
  lines.push('', '## Diff statistics', '', '```', String(stat ?? '').trimEnd(), '```', '');
  return lines.join('\n');
}

/** The short reviewer prompt. "track <id>" in the text ties the reviewer's cost to the task. */
function reviewerPrompt({ o, type, folder }) {
  const sep = String(folder).includes('\\') ? '\\' : '/';
  return [
    `You are ${type} for track ${o.id} (class ${o.class}, branch ${o.branch ?? queueBranch(o.id)}) in the work queue.`,
    `Read the review package: ${folder}${sep}00-package.md first, then diff.patch and the files under files${sep} (full version from the`,
    "branch), and the track's answer and report when they are there. Look things up in the rest of the repo only for a concrete",
    'question, with grep -n and excerpts. At most approx. 40 turns; rather leave the question open in the report.',
    'Your answer is at most approx. 1,500 characters. First line in fixed format: FINDINGS H=<count> M=<count> L=<count>',
    'deferrable=<finding codes that can wait, comma-separated, or ->. Then one short point per H and M finding (code,',
    'file:line, fix), L findings only with code and one sentence. Do not repeat the package.',
  ].join('\n');
}

/** Projects where the source or the mission (the text in the field, not the file) points to the project's plan. */
function planMatch(o, register) {
  const text = norm(
    [o?.source, typeof o?.mission === 'string' ? o.mission : '']
      .filter((x) => typeof x === 'string' && x)
      .join('\n'),
  ).toLowerCase();
  if (!text) return [];
  const match = [];
  for (const [pid, p] of Object.entries(register ?? {})) {
    if (typeof p?.plan !== 'string' || !p.plan.trim()) continue;
    const filePath = norm(p.plan.trim()).toLowerCase();
    const name = filePath.slice(filePath.lastIndexOf('/') + 1);
    if (text.includes(filePath) || (name.length >= 8 && text.includes(name))) match.push(pid);
  }
  return match;
}

/** Is the file (or folder) under the file root? A root that ends in "/" is a folder; otherwise a file or folder. */
function underRoot(file, root) {
  const f = norm(file);
  const r = norm(root);
  if (r.endsWith('/')) return f.startsWith(r);
  return f === r || f.startsWith(`${r}/`);
}

/** Number of owned files under each project's fileRoot, most first: [{ pid, n }] (only projects with at least one match). */
function fileRootMatch(o, register) {
  const files = (o?.owned_files ?? []).filter((x) => typeof x === 'string' && x);
  const out = [];
  for (const [pid, p] of Object.entries(register ?? {})) {
    const roots = Array.isArray(p?.fileRoot)
      ? p.fileRoot.filter((x) => typeof x === 'string' && x)
      : [];
    if (!roots.length) continue;
    const n = files.filter((f) => roots.some((r) => underRoot(f, r))).length;
    if (n) out.push({ pid, n });
  }
  return out.sort((a, b) => b.n - a.n || a.pid.localeCompare(b.pid));
}

/**
 * Proposed project for a task (add, classify, the "Sort" list). Signals in decreasing strength: (1) explicit
 * `project`, (2) longest prefix, (3) `source`/`mission` points to the project's `plan`, (4) most owned files under
 * the project's `fileRoot`. "Strong" signals are an unambiguous plan and a fileRoot that covers ALL the owned files; if they contradict
 * the choice, the suggestion is uncertain (or, with an explicit project, `disagree`). No or ambiguous signals: pid null
 * ("Sort"). Never an error, so add never stops on this.
 * @returns {{ pid: string|null, signal: 'explicit'|'prefix'|'plan'|'fileRoot'|null, safe: boolean, disagree: boolean,
 *   counterProposal: string|null, reason: string, candidates: { pid: string, signal: string, reason: string }[] }}
 */
function suggestProject(o, register) {
  const reg = register ?? {};
  const candidates = [];
  const pre = longestPrefix(o?.id, reg);
  if (pre) candidates.push({ pid: pre.pid, signal: 'prefix', reason: `the prefix ${pre.prefix}` });
  const plan = planMatch(o, reg);
  for (const pid of plan)
    candidates.push({ pid, signal: 'plan', reason: `the source points to the plan ${reg[pid].plan}` });
  const countFiles = (o?.owned_files ?? []).filter((x) => typeof x === 'string' && x).length;
  const root = fileRootMatch(o, reg);
  for (const r of root)
    candidates.push({
      pid: r.pid,
      signal: 'fileRoot',
      reason: `${r.n} of ${countFiles} owned files under the file root`,
    });
  const cand = (signal, pid) => candidates.find((x) => x.signal === signal && x.pid === pid);
  const strong = [];
  if (plan.length === 1) strong.push(cand('plan', plan[0]));
  const allRoot = root.filter((r) => r.n === countFiles);
  if (countFiles && allRoot.length === 1) strong.push(cand('fileRoot', allRoot[0].pid));

  let selected = null;
  const ambiguous = [];
  if (pre && !pre.also.length) selected = cand('prefix', pre.pid);
  else if (pre)
    ambiguous.push(`the prefix ${pre.prefix} is in ${[pre.pid, ...pre.also].join(', ')}`);
  if (!selected && plan.length === 1) selected = cand('plan', plan[0]);
  else if (!selected && plan.length > 1)
    ambiguous.push(`the source points to the plans of ${plan.join(', ')}`);
  if (!selected && root.length) {
    if (root.length === 1 || root[0].n > root[1].n) selected = cand('fileRoot', root[0].pid);
    else
      ambiguous.push(
        `equally many owned files under the file root of ${root
          .filter((r) => r.n === root[0].n)
          .map((r) => r.pid)
          .join(', ')}`,
      );
  }
  const against = (pid) => {
    const m = strong.filter((s) => s.pid !== pid);
    const pids = [...new Set(m.map((s) => s.pid))];
    return { m, counterProposal: pids.length === 1 ? pids[0] : null };
  };
  const explicit = typeof o?.project === 'string' && o.project ? o.project : null;
  if (explicit) {
    const { m, counterProposal } = against(explicit);
    return {
      pid: explicit,
      signal: 'explicit',
      safe: !m.length,
      disagree: m.length > 0,
      counterProposal,
      reason: m.length
        ? `set to ${explicit}, but ${m.map((s) => `${s.reason} (${s.pid})`).join('; ')}`
        : `set to ${explicit}`,
      candidates,
    };
  }
  if (!selected)
    return {
      pid: null,
      signal: null,
      safe: false,
      disagree: false,
      counterProposal: null,
      reason: ambiguous.length
        ? `ambiguous: ${ambiguous.join('; ')}`
        : 'no prefix, plan or fileRoot matches',
      candidates,
    };
  const { m, counterProposal } = against(selected.pid);
  const reservation = [...ambiguous, ...m.map((s) => `${s.reason} (${s.pid})`)];
  return {
    pid: selected.pid,
    signal: selected.signal,
    safe: !reservation.length,
    disagree: m.length > 0,
    counterProposal,
    reason: reservation.length ? `${selected.reason}, but ${reservation.join('; ')}` : selected.reason,
    candidates,
  };
}

/** The statuses classify looks at (open work; finished and cancelled ones stay as they are). */
const CLASSIFY_STATUSES = new Set(['proposed', 'waiting', 'running', 'picked', 'review']);

/**
 * Proposals for tasks that are already in the queue (queue.mjs classify, the "Sort" list on the board):
 *   move  = without a project today, and a safe proposal (`--execute` sets `project` on them);
 *   disagree  = the project today (explicit or prefix) contradicts a strong signal (the owner decides; never automatic);
 *   sort = without a project, and no or an ambiguous proposal.
 * Filters: `withoutProject` (only those in without-project today), `disagreeing` (only disagree).
 * @returns {{ move: object[], sort: object[] }} rows { id, title, now, proposed, signal, type, reason }
 */
function classifyQueue(queue, { withoutProject = false, disagreeing = false } = {}) {
  const register = queue.projects ?? {};
  const move = [];
  const sort = [];
  for (const o of queue.tasks ?? []) {
    if (isExternalRow(o) || !CLASSIFY_STATUSES.has(o.status)) continue;
    const now = projectFor(o, register);
    const f = suggestProject(o, register);
    let type = null;
    let proposed = f.pid;
    if (now === WITHOUT_PROJECT) type = f.pid && f.safe ? 'move' : 'sort';
    else if (f.disagree) {
      type = 'disagree';
      proposed = f.counterProposal;
    } else if (!f.safe) type = 'sort';
    if (!type) continue;
    if (withoutProject && now !== WITHOUT_PROJECT) continue;
    if (disagreeing && type !== 'disagree') continue;
    const row = {
      id: o.id,
      title: o.title ?? null,
      status: o.status,
      now,
      proposed: proposed ?? null,
      signal: f.signal,
      type,
      reason: f.reason,
    };
    (type === 'move' ? move : sort).push(row);
  }
  return { move, sort };
}

/**
 * Warnings about the prefixes in the register: a one-character prefix without a separator (catches everything starting with it, like "4"), a prefix
 * that is the start of another project's prefix (the longest wins), and the same prefix in two projects (the first in the
 * register wins). `pid` limits to warnings that apply to that project.
 */
function prefixWarnings(register, { pid: bare = null } = {}) {
  const out = [];
  const list = [];
  for (const [pid, p] of Object.entries(register ?? {}))
    for (const pre of Array.isArray(p?.prefixes) ? p.prefixes : [])
      if (typeof pre === 'string' && pre) list.push({ pid, pre });
  for (const a of list) {
    if (bare && a.pid !== bare) continue;
    if (a.pre.length === 1)
      out.push(
        `the prefix ${a.pre} in ${a.pid} is only one character and catches all ids that start with ${a.pre}`,
      );
  }
  for (const a of list) {
    for (const b of list) {
      if (a.pid === b.pid) continue;
      if (bare && a.pid !== bare && b.pid !== bare) continue;
      if (a.pre === b.pre && a.pid < b.pid)
        out.push(
          `the prefix ${a.pre} is in both ${a.pid} and ${b.pid} (the first in the register wins)`,
        );
      else if (a.pre !== b.pre && b.pre.startsWith(a.pre))
        out.push(
          `the prefix ${a.pre} in ${a.pid} is the start of ${b.pre} in ${b.pid} (longest prefix wins: ${b.pre}… goes to ${b.pid})`,
        );
    }
  }
  return out;
}

/**
 * The warnings `add` writes about project and feature for new tasks (never stops add): without a project (with the suggestion
 * and which signal decided, or "Sort"), an explicit project that contradicts strong signals, and a feature
 * that is not in the project's `features` (when that list exists).
 * @returns {string[]}
 */
function addProjectWarnings(newOnes, register) {
  const reg = register ?? {};
  if (!Object.keys(reg).length) return [];
  const out = [];
  for (const n of newOnes ?? []) {
    if (!n || typeof n !== 'object') continue;
    const pid = projectFor(n, reg);
    const f = suggestProject(n, reg);
    if (pid === WITHOUT_PROJECT) {
      out.push(
        f.pid
          ? `${n.id} has no project; proposed ${f.pid} (${f.reason}). Set "project": "${f.pid}", or run cq classify --execute${f.safe ? '' : ' (the suggestion is uncertain: see cq classify)'}`
          : `${n.id} has no project and lands in "Sort" (${f.reason}). Set "project", or give the project a fileRoot/prefix`,
      );
    } else if (f.disagree) {
      out.push(`${n.id}: ${f.reason}. Check the project (cq classify --disagree)`);
    }
    const known = reg[pid]?.features;
    if (
      Array.isArray(known) &&
      known.length &&
      typeof n.feature === 'string' &&
      n.feature.trim() &&
      !known.includes(n.feature.trim())
    ) {
      const equal = known.filter((x) => x.toLowerCase() === n.feature.trim().toLowerCase());
      out.push(
        equal.length
          ? `${n.id}: feature "${n.feature}" is called "${equal[0]}" in ${pid}`
          : `${n.id}: new feature "${n.feature}" in ${pid} (known: ${known.slice(0, 8).join(', ')}${known.length > 8 ? ' …' : ''})`,
      );
    }
  }
  return out;
}

// ---- Fewer orchestrator turns ----
//
// The decisions behind the commands that save orchestrator turns (the I/O lives in queue.mjs):
//   merge <id>        merge-track → (migrationPush, with environment guard) → gates --quick → set done → fill, in one call
//   info / activeOnes     fixed lookups instead of `node -e`
//   edit --bonus   text for the mission (the track block) and the remarks, with a timestamp
//   next-migr [<n>]  show or set the next migration number; never backward and never down into a used number
//   "Start these in the SAME turn:" after fill and receive, and the report cap (approx. 1,500 characters) for the agents' answers.
// The migration step exists only when config().migrations has both `folder` and `pushCommand`.

/** The cap for the agent's answer to the orchestrator (characters). The long version is in report.md. */
const REPORT_CAP = 1500;

/** The migration setup from config(), or "off" when the config cannot be read (pure tests without config). */
function migrSetup(migrations) {
  if (migrations !== undefined) return migrations ?? { folder: null };
  try {
    return require('./queueConfig.js').config().migrations ?? { folder: null };
  } catch {
    return { folder: null };
  }
}

/**
 * Is the environment the migrations are pushed to an allowed environment? Without `environmentFile` in the setup there is no guard (ok). With
 * `environmentFile` the content must be in `allowedEnvironment`; if the file is missing or empty, `merge` stops before the push.
 * @param {string|null|undefined} environment the content of the environment file (null when the file is missing)
 * @param {{ environmentFile?: string|null, allowedEnvironment?: string[] }} [migrations]
 * @returns {{ ok: boolean, environment: string, message: string }}
 */
function environmentCheck(environment, migrations) {
  const m = migrSetup(migrations);
  if (!m.environmentFile) return { ok: true, environment: 'without-guard', message: 'no environment file set' };
  const allowedOnes = Array.isArray(m.allowedEnvironment) ? m.allowedEnvironment : [];
  const r = typeof environment === 'string' ? environment.trim() : '';
  if (!r)
    return {
      ok: false,
      environment: 'missing',
      message:
        `Did not find the environment file ${m.environmentFile} (or it is empty). STOP: merge pushes migrations only to an environment in ` +
        `migrations.allowedEnvironment (${allowedOnes.length ? allowedOnes.join(', ') : 'empty list'}).`,
    };
  if (!allowedOnes.includes(r))
    return {
      ok: false,
      environment: 'unknown',
      message:
        `${m.environmentFile} points to "${r}", which is not in migrations.allowedEnvironment ` +
        `(${allowedOnes.length ? allowedOnes.join(', ') : 'empty list'}). STOP: link to the correct environment first.`,
    };
  return { ok: true, environment: r, message: `${r} (allowed)` };
}

/**
 * The migration files in a file list (the paths from `git diff --name-only`): files directly under `migrations.folder` that
 * match `filePattern`. Without a folder: none.
 */
function migrFiles(files, migrations) {
  const m = migrSetup(migrations);
  if (!m.folder) return [];
  const folder = String(m.folder).replace(/\\/g, '/').replace(/\/+$/, '');
  const pattern = new RegExp(m.filePattern ?? '^(\\d+)_.*\\.sql$');
  return (Array.isArray(files) ? files : []).filter((f) => {
    const s = String(f).replace(/\\/g, '/');
    if (!s.startsWith(`${folder}/`)) return false;
    const name = s.slice(folder.length + 1);
    return !name.includes('/') && pattern.test(name);
  });
}

/**
 * Which steps `merge` runs. Migration push when the project has a migration flow (folder + pushCommand) and the branch has
 * migration files; if the diff cannot be read (`files` null), the migration block decides (rather one push too many than one too
 * few). A block without files gives only a note. Without a migration folder there is never a push step.
 * @param {{ o: object, files: string[]|null, withoutMigrPush?: boolean, withoutFill?: boolean, base?: string,
 *   migrations?: object }} x
 * @returns {{ step: string[], migrPush: boolean, migr: string[], notes: string[] }}
 */
function mergePlan({ o, files, withoutMigrPush = false, withoutFill = false, base = 'baseBranch', migrations }) {
  const m = migrSetup(migrations);
  const notes = [];
  let migr = [];
  let migrPush = false;
  if (m.folder) {
    migr = migrFiles(files, m);
    const hasMigr = Array.isArray(files) ? migr.length > 0 : !!o?.migr_block;
    if (Array.isArray(files) && !migr.length && o?.migr_block)
      notes.push(`migration block ${o.migr_block}, but no migration files in the branch: no push`);
    if (!Array.isArray(files))
      notes.push(`did not find the diff against ${base}; the migration block decides the push`);
    if (hasMigr && !m.pushCommand)
      notes.push(
        'the branch has migrations, but migrations.pushCommand is not set: push them yourself after the merge',
      );
    else if (hasMigr && withoutMigrPush)
      notes.push('migration push skipped (--without-migr-push): the migrations are NOT pushed yet');
    migrPush = hasMigr && !!m.pushCommand && !withoutMigrPush;
  }
  const step = ['merge', ...(migrPush ? ['migr-push'] : []), 'gates', 'done'];
  if (!withoutFill) step.push('fill');
  return { step, migrPush, migr, notes };
}

/** The last `n` non-empty lines (the error excerpt when a step stops). */
function errorExcerpt(out, n = 20) {
  return String(out ?? '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter((l) => l.trim())
    .slice(-n);
}

/** The last line that matches the pattern (or the last non-empty one), cut to `max` characters. */
function lastLine(out, pattern = null, max = 140) {
  const lines = errorExcerpt(out, 1000);
  const match = pattern ? lines.filter((l) => pattern.test(l)) : lines;
  const l = (match.length ? match[match.length - 1] : (lines[lines.length - 1] ?? '')).trim();
  return l.length > max ? `${l.slice(0, max - 1)}…` : l;
}

/** Exit codes from `fill` that are not errors: dailyBudget (4), nightPause (5), windDown (6), the machine is full (7). */
const FILL_STOP_CODES = new Set([4, 5, 6, 7]);

/**
 * Runs the steps in `merge` in order and stops at the first error. Does no I/O itself: `run({ step })` runs one
 * step and gives `{ code, out }` (stdout and stderr combined), `readEnvironment()` gives the content of migrations.environmentFile (null when
 * the file is missing), and `guard(environment)` is the push guard for the migration command (null = free). The order, the stop rules
 * and the environment check are here, so they can be tested without git, database or the gates.
 * @param {{ o: object, plan: object, branch: string, currentBranch: string|null, run: Function,
 *   readEnvironment?: Function, guard?: Function, base?: string, migrations?: object }} x
 * @returns {{ ok: boolean, lines: string[], stop: { step: string, message: string, excerpt: string[] }|null }}
 */
function executeMerge({
  o,
  plan,
  branch,
  currentBranch,
  run,
  readEnvironment = () => null,
  guard = () => null,
  base = 'main',
  migrations,
}) {
  const lines = [...plan.notes.map((n) => `NB: ${n}`)];
  const stop = (step, message, out = '') => ({
    ok: false,
    lines,
    stop: { step, message, excerpt: errorExcerpt(out) },
  });
  if (currentBranch !== base)
    return stop(
      'merge',
      `The main tree is on ${currentBranch ?? 'unknown branch'}, not ${base}. Nothing was done.`,
    );
  for (const step of plan.step) {
    if (step === 'merge') {
      const r = run({ step });
      if (r.code !== 0)
        return stop(
          step,
          `merge-track.mjs ${branch} failed (exit ${r.code}). Nothing after the merge was done; ` +
            'if the merge is still in progress, resolve it or undo with git merge --abort.',
          r.out,
        );
      const wt = lastLine(r.out, /^Worktree:/);
      lines.push(
        `merge: ${lastLine(r.out, /^Merged/)}${/^Worktree:/.test(wt) ? ` · ${wt}` : ''}`,
      );
    } else if (step === 'migr-push') {
      const m = migrSetup(migrations);
      const environment = readEnvironment();
      const ms = environmentCheck(environment, m);
      if (!ms.ok) return stop(step, `Merged, but no migration push: ${ms.message}`);
      const v = guard(environment);
      if (v)
        return stop(
          step,
          `Merged, but no migration push: the push guard says ${v.decision}: ${v.reason}`,
        );
      const r = run({ step });
      if (r.code !== 0)
        return stop(
          step,
          `Merged, but the migration push failed (exit ${r.code}). The gates, set done and fill have not run.`,
          r.out,
        );
      lines.push(
        `migrationPush: OK${m.environmentFile ? ` (environment ${ms.environment})` : ''}: ${lastLine(r.out) || 'no output'}`,
      );
      if (m.environmentFile) {
        const after = environmentCheck(readEnvironment(), m);
        if (!after.ok || after.environment !== ms.environment)
          return stop(step, `The environment changed during the migration push: ${after.message}`);
      }
    } else if (step === 'gates') {
      const r = run({ step });
      if (r.code !== 0)
        return stop(
          step,
          `The gates (--quick) are red after the merge${plan.migrPush ? ' and the migration push' : ''}. The task stays in ` +
            'review; fix it (or send a fix round), and then run set <id> done and fill.',
          r.out,
        );
      lines.push(`gates --quick: ${lastLine(r.out)}`);
    } else if (step === 'done') {
      const r = run({ step });
      if (r.code !== 0) return stop(step, `set ${o.id} done failed (exit ${r.code}).`, r.out);
      lines.push(`done: ${lastLine(r.out, /^Cost |: done/)}`);
    } else if (step === 'fill') {
      const r = run({ step });
      if (FILL_STOP_CODES.has(r.code)) {
        lines.push(`fill: no new ones (exit ${r.code}): ${lastLine(r.out)}`);
        continue;
      }
      if (r.code !== 0)
        return stop(step, `fill failed (exit ${r.code}). ${o.id} is done.`, r.out);
      lines.push(...fillExcerpt(r.out));
    }
  }
  return { ok: true, lines, stop: null };
}

/**
 * From the `fill` output: the FILLED line, one line per track and the agent list "Start these in the SAME turn:"; otherwise the last line
 * (e.g. "Nothing can be started now").
 */
function fillExcerpt(out) {
  const lines = String(out ?? '')
    .split(/\r?\n/)
    .filter((l) => l.trim());
  const i = lines.findIndex((l) => /^FILLED /.test(l));
  // fill only MARKS the tracks running; the agents start only when someone reads this. Said last, where it is seen.
  if (i >= 0)
    return [
      `fill: ${lines[i]}`,
      ...lines.slice(i + 1),
      `NOTE: the tracks above are only marked running. Start the agents now; ${FILL_NOTE}`,
    ];
  return [`fill: ${lines[lines.length - 1] ?? 'no output'}`];
}

const SAME_TURN = 'Start these in the SAME turn:';
/** Why merge must not run where nobody reads it (a background job, a script that chains merges). */
const FILL_NOTE =
  'never run merge where nobody reads the output (in the background or chained in a script): use --without-fill there ' +
  'and run fill yourself afterwards. cq show and the pulse warn about tracks STARTED WITHOUT AGENT.';

/**
 * The agent list the orchestrator starts in ONE turn (in parallel): one line per agent with subagent_type and the message
 * (the track message mentions the prompt file; a reviewer gets the content of the prompt file as the message).
 * `bare: true` keeps the name as it is: a custom helper lives in the project's .claude/agents/, never under the
 * plugin's prefix.
 * @param {{ subagent_type: string, prompt: string, message?: string|null, bare?: boolean }[]} agents
 */
function concurrentBlock(agents) {
  if (!agents?.length) return [];
  const ref = (x) => (x.bare ? x.subagent_type : require('./projectRoot.js').agentRef(x.subagent_type));
  return [
    SAME_TURN,
    ...agents.map((x) =>
      x.message
        ? `  subagent_type=${ref(x)}${modelPart(x.subagent_type)} · message: ${x.message}`
        : `  subagent_type=${ref(x)}${modelPart(x.subagent_type)} · message: the content of ${x.prompt}`,
    ),
  ];
}

/** The warning `receive` gives when the track's answer is over the report cap (null otherwise). */
function reportCapWarning(text, cap = REPORT_CAP) {
  const n = String(text ?? '').trim().length;
  if (n <= cap) return null;
  return (
    `WARNING: trackReply.md is ${n} characters (cap approx. ${cap}). The answer should be the RESULT line, at most 5 lines and the path to ` +
    'report.md; the long version goes in report.md (see docs/mission-template.md, "Report").'
  );
}

/** The fields `info` shows by default (summary), in this order. */
const INFO_FIELD = [
  'id',
  'title',
  'status',
  'class',
  'domain',
  'project',
  'feature',
  'branch',
  'migr_block',
  'head_start',
  'started',
  'delivered',
  'done',
  'depends_on',
  'waiting_on',
  'fixes',
  'owned_files',
  'owner_db',
  'scratchpad',
  'review_package',
];

/** The value of a field, also with a dot (`cost.usd`, `result.line`). undefined when it does not exist. */
function infoField(o, field) {
  let v = o;
  for (const chunk of String(field).split('.')) {
    if (v == null || typeof v !== 'object' || !(chunk in v)) return undefined;
    v = v[chunk];
  }
  return v;
}

/** One field as text: strings raw (so they can be used in a shell), everything else as compact JSON. */
function infoValueText(v) {
  if (v === undefined) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/**
 * Summary default view of one task (`queue.mjs info <id>`): one field per line, the mission and remarks shortened.
 * `fixedBy` (lib/fixLinks.fixedBy) lists the fix tasks that name this one in `fixes`. `costEstimate` (lib/costEstimate.js
 * calibratedCost) adds the line "estimate: 39 min · ~$2.4 (measured, class+size, n=7)".
 */
function infoView(o, { fixedBy = [], costEstimate = null } = {}) {
  const out = [];
  for (const f of INFO_FIELD) {
    const v = o[f];
    if (v == null || (Array.isArray(v) && !v.length)) continue;
    out.push(
      `${f}: ${Array.isArray(v) ? v.join(', ') : f === 'head_start' ? String(v).slice(0, 12) : v}`,
    );
  }
  if (costEstimate && Number.isFinite(costEstimate.usd))
    out.push(
      `estimate: ${estimate(o)} min · ~$${costEstimate.usd} (` +
        (costEstimate.source === 'measured'
          ? `measured, ${costEstimate.basis}, n=${costEstimate.n})`
          : 'model, too little measured data)'),
    );
  if (fixedBy.length) out.push(`fixed by: ${fixedBy.join(', ')}`);
  if (o.result?.line) out.push(`result: ${o.result.line}`);
  if (o.cost)
    out.push(
      `cost: $${o.cost.usd} (${o.cost.agents?.length ?? 0} agent(s), ${o.cost.turns ?? '?'} turns)`,
    );
  if (o.findings) out.push(`findings: H=${o.findings.H} M=${o.findings.M} L=${o.findings.L}`);
  const bonus = Array.isArray(o.bonus) ? o.bonus : [];
  if (bonus.length)
    out.push(`bonus: ${bonus.length} (last ${bonus[bonus.length - 1].time})`);
  const mark = Array.isArray(o.remarks) ? o.remarks : [];
  if (mark.length)
    out.push(`remarks: ${mark.length}; last: ${cutText(mark[mark.length - 1], 160)}`);
  if (o.mission) out.push(`mission: ${cutText(String(o.mission).replace(/\s+/g, ' '), 200)}`);
  out.push('One field: cq info <id> --field <name> (also cost.usd, result.line).');
  return out;
}

// The age is written with ageText (above), same format as in show.
const ACTIVE_STATUSES = ['running', 'picked', 'review'];

/**
 * The active tasks (running, picked, review) as short lines: id, status, class, branch, migration block,
 * head_start and age (from start/pick; for review also the time since delivery).
 */
function activeLines(queue, now = Date.now()) {
  const rows = (queue?.tasks ?? []).filter((o) => ACTIVE_STATUSES.includes(o.status));
  if (!rows.length) return ['No active tasks (running, picked, review).'];
  return rows.map((o) => {
    const from = Date.parse(o.started ?? o.picked_at ?? '');
    const vendorList =
      o.status === 'review' && o.delivered
        ? `, delivered ${ageText(now - Date.parse(o.delivered))} ago`
        : '';
    return (
      `${o.id}  ${o.status}  ${o.class}  ${o.branch ?? '-'}  migr ${o.migr_block ?? '-'}  ` +
      `head ${o.head_start ? String(o.head_start).slice(0, 8) : '-'}  age ${Number.isNaN(from) ? '?' : ageText(now - from)}${vendorList}` +
      `${o.picked_by ? `  picked by ${o.picked_by}` : ''}`
    );
  });
}

/**
 * Tracks marked running that no agent is working on. `fill` and `start` only MARK a track as running; the orchestrator
 * must start the agent from the "Start these in the SAME turn" lines. When fill runs where nobody reads its output (a
 * `merge` in the background, a script that chains several merges), the track stays "running" with no agent, and the
 * queue stalls without any error. A real agent runs `prepare-track` within minutes, and that checks the branch out in
 * its worktree. So: running, older than `graceMin`, no worktree has the branch, and no report.md = no agent.
 * Picked tasks and cloud sessions are left out (they have no local worktree). `worktreeBranches` is a Set of branch
 * names, `hasReport(o)` says whether the track has delivered.
 */
const NO_AGENT_GRACE_MIN = 15;
function startedWithoutAgent(
  queue,
  { worktreeBranches, hasReport = () => false, now = Date.now(), graceMin = NO_AGENT_GRACE_MIN } = {},
) {
  const branches = worktreeBranches ?? new Set();
  return (queue?.tasks ?? [])
    .filter((o) => o.status === 'running' && !o.picked_by && !o.cloud && o.branch)
    .map((o) => ({ o, from: Date.parse(o.started ?? '') }))
    .filter(({ from }) => !Number.isNaN(from) && now - from >= graceMin * 60_000)
    .filter(({ o }) => !branches.has(o.branch) && !hasReport(o))
    .map(({ o, from }) => ({ id: o.id, branch: o.branch, migr_block: o.migr_block ?? null, age_ms: now - from }));
}

/** The warning lines for `startedWithoutAgent` (show, orchestrator pulse). Empty list when all is well. */
function withoutAgentLines(list) {
  if (!list?.length) return [];
  return [
    `STARTED WITHOUT AGENT (${list.length}): marked running, but no worktree has the branch and there is no report. ` +
      'fill or start marked them and the agents were never started (was fill run where nobody read the output?). ' +
      'For each: cq set <id> waiting, then cq fill --ids <id> and start what it lists in the SAME turn ' +
      '(fill checks the migration block again).',
    ...list.map(
      (x) =>
        `  ${x.id}  ${x.branch}  running for ${ageText(x.age_ms)}${x.migr_block ? `  migr ${x.migr_block}` : ''}`,
    ),
  ];
}

// ---- Silent tracks and blocker reasons ----------------------------------------------------------------------

/**
 * Silent tracks ("SILENT"): running, an agent has the branch checked out in a worktree (so not STARTED WITHOUT
 * AGENT), but no sign of life for `limitMin` minutes. The sign of life is measured by the caller (queue.mjs and the
 * board server, with lib/trackActivity.js) as the newest of: the last commit on the branch, the newest mtime in the
 * worktree, the track folder in the scratchpad and the agent transcript. `lastActivity` maps id -> that time in ms
 * (missing = nothing found). The start time counts as activity too, so a new track always gets the whole limit.
 * Picked tasks, cloud sessions and delivered tracks (report.md) are left out. limits.silentMin sets the limit
 * (`cq limit silentMin <n>`, 0 = off).
 */
const SILENT_DEFAULT_MIN = 20;

/** The silence limit in minutes: limits.silentMin, otherwise the default. 0 turns the check off. */
function silentMinFor(queue) {
  const raw = queue?.limits?.silentMin;
  const v = Number(raw);
  return raw != null && Number.isFinite(v) && v >= 0 ? v : SILENT_DEFAULT_MIN;
}

/** The tracks the silence check measures: running, not picked or cloud, with a branch some worktree has checked out. */
function silentCandidates(queue, worktreeBranches) {
  const branches = worktreeBranches ?? new Set();
  return (queue?.tasks ?? []).filter(
    (o) => o.status === 'running' && !o.picked_by && !o.cloud && o.branch && branches.has(o.branch),
  );
}

function silentTracks(
  queue,
  { worktreeBranches, lastActivity = {}, hasReport = () => false, now = Date.now(), limitMin } = {},
) {
  const limit = limitMin ?? silentMinFor(queue);
  if (!(limit > 0)) return [];
  const activity = lastActivity instanceof Map ? Object.fromEntries(lastActivity) : (lastActivity ?? {});
  return silentCandidates(queue, worktreeBranches)
    .map((o) => {
      const started = Date.parse(o.started ?? '');
      const seen = Number(activity[o.id]);
      const last = Math.max(
        Number.isFinite(started) ? started : -Infinity,
        Number.isFinite(seen) ? seen : -Infinity,
      );
      return { o, last };
    })
    .filter(({ last }) => Number.isFinite(last) && now - last >= limit * 60_000)
    .filter(({ o }) => !hasReport(o))
    .map(({ o, last }) => ({
      id: o.id,
      branch: o.branch,
      last_activity: new Date(last).toISOString(),
      silent_ms: now - last,
    }));
}

/** The warning lines for `silentTracks` (show, orchestrator pulse). Empty list when all is well. */
function silentLines(list) {
  if (!list?.length) return [];
  return [
    `SILENT (${list.length}): running with an agent worktree, but no commit, file change or transcript write for a ` +
      'while (the agent may have hung or run out of context). For each: check the track (its worktree and ' +
      'transcript), then cq resume <id> --reason context and start the new agent, or stop it (cq set <id> waiting; ' +
      'cq block <id> silent records why).',
    ...list.map((x) => `  ${x.id}  ${x.branch}  silent for ${ageText(x.silent_ms)}`),
  ];
}

/**
 * The blocker reasons: one fixed table, so `cq blockers` and the board's statistics can cluster on them. A task has
 * `blocks: [{ code, from, to?, note? }]`, with at most one open (no `to`). `cq block` / `cq unblock` set them by hand;
 * `cq merge` opens merge-conflict or gate-red when it stops in that step, and closes the open one after a merge.
 */
const BLOCK_CODES = [
  { code: 'merge-conflict', text: 'the merge step stopped (conflict or merge guard)' },
  { code: 'gate-red', text: 'the gates failed after the merge' },
  { code: 'context', text: 'the agent ran out of context' },
  { code: 'quota', text: 'the usage quota or budget stopped it' },
  { code: 'owner-question', text: 'waiting on an owner answer' },
  { code: 'dependency', text: 'waiting on another task' },
  { code: 'no-agent', text: 'marked running without an agent' },
  { code: 'silent', text: 'the agent went silent' },
  { code: 'other', text: 'something else (say what in the note)' },
];
const BLOCK_NOTE_MAX = 200;

/** The open block on a task (no `to`), or null. */
function openBlockOf(o) {
  return (Array.isArray(o?.blocks) ? o.blocks : []).find((b) => b && !b.to) ?? null;
}

/**
 * Opens a block on the task (mutates `o`). An open block with another code is closed at the same moment, so a task has
 * at most one open block; the same code again keeps the open one and its start (a new note replaces the old).
 * @returns {{ block: object, closed: object|null, kept: boolean } | { error: string }}
 */
function openBlock(o, code, { now = Date.now(), note = null } = {}) {
  if (!BLOCK_CODES.some((b) => b.code === code))
    return { error: `unknown blocker code ${code} (${BLOCK_CODES.map((b) => b.code).join(', ')})` };
  const text = note == null ? '' : String(note).replace(/\s+/g, ' ').trim().slice(0, BLOCK_NOTE_MAX);
  const open = openBlockOf(o);
  if (open && open.code === code) {
    if (text) open.note = text;
    return { block: open, closed: null, kept: true };
  }
  const at = new Date(now).toISOString();
  if (open) open.to = at;
  const block = { code, from: at, ...(text ? { note: text } : {}) };
  o.blocks = [...(Array.isArray(o.blocks) ? o.blocks : []), block];
  return { block, closed: open, kept: false };
}

/** Closes the open block on the task (mutates `o`). @returns the closed block, or null when none was open. */
function closeBlock(o, { now = Date.now() } = {}) {
  const open = openBlockOf(o);
  if (!open) return null;
  open.to = new Date(now).toISOString();
  return open;
}

/**
 * Per code: how many blocks overlap the last `days` days and the blocked time inside that window (an open block counts
 * up to now). Sorted by time, then count; codes without blocks are left out.
 * @returns {{ code: string, count: number, ms: number, open: number }[]}
 */
function blockerSummary(queue, { now = Date.now(), days = 7 } = {}) {
  const windowFrom = now - days * 86_400_000;
  const per = new Map();
  for (const o of queue?.tasks ?? []) {
    // A block left open on a finished task stops counting when the task was done (it no longer blocks anything).
    const finished = o?.status === 'done' && o.done ? Date.parse(o.done) : NaN;
    for (const b of Array.isArray(o?.blocks) ? o.blocks : []) {
      const from = Date.parse(b?.from ?? '');
      const open = !b?.to && !Number.isFinite(finished);
      const to = b?.to ? Date.parse(b.to) : Number.isFinite(finished) ? finished : now;
      if (!Number.isFinite(from) || !Number.isFinite(to) || to < windowFrom || from > now) continue;
      const r = per.get(b.code) ?? { code: b.code, count: 0, ms: 0, open: 0 };
      r.count += 1;
      r.ms += Math.max(0, Math.min(to, now) - Math.max(from, windowFrom));
      if (open) r.open += 1;
      per.set(b.code, r);
    }
  }
  return [...per.values()].sort((x, y) => y.ms - x.ms || y.count - x.count || x.code.localeCompare(y.code));
}

/** `cq blockers` as text lines. */
function blockerLines(summary, { days = 7 } = {}) {
  if (!summary?.length) return [`No blockers recorded in the last ${days} days.`];
  return [
    `Blockers in the last ${days} days (count, blocked time; top first):`,
    ...summary.map(
      (r) =>
        `  ${r.code.padEnd(15)} ${String(r.count).padStart(3)}  ${ageText(r.ms)}${r.open ? `  (${r.open} open)` : ''}`,
    ),
  ];
}

/** Highest used number in the queue's migration blocks ("3600–3609" → 3609). */
function highestBlockNr(queue) {
  let max = 0;
  for (const o of queue?.tasks ?? []) {
    // Via blockInterval, so a hyphen or a short end number ("3450–59") is read the same way as in takenBlocks.
    const b = blockInterval(o.migr_block);
    if (b) max = Math.max(max, b.to);
  }
  return max;
}

/**
 * Guard for `next-migr <n>`: refuses to go backward (below the current next_migr) and down into a used number (highest
 * migration file in the series or highest assigned block). `taken` (takenBlocks) also refuses a number inside a taken
 * block, e.g. a block moved by hand that only stands in the prompt file. Returns { ok, error } (error = null when ok).
 */
function nextMigrGuard({ now, new: fresh, highestFile = 0, highestBlock = 0, taken = [] }) {
  if (!Number.isInteger(fresh) || fresh <= 0)
    return { ok: false, error: `invalid number "${fresh}" (integer above 0)` };
  if (Number.isInteger(now) && fresh < now)
    return { ok: false, error: `${fresh} is backward (next_migr is ${now}); the queue never goes backward` };
  const used = Math.max(highestFile || 0, highestBlock || 0);
  if (fresh <= used)
    return {
      ok: false,
      error: `${fresh} is not above the highest used number ${used} (migration file ${highestFile || 0}, block ${highestBlock || 0})`,
    };
  const inside = taken.find((t) => t.from <= fresh && t.to >= fresh);
  if (inside)
    return {
      ok: false,
      error: `${fresh} lies in a taken block ${inside.from}–${inside.to} (${inside.source})`,
    };
  return { ok: true, error: null };
}

// ---- Adoption: a new orchestrator session adopts tracks that are running ----------------------------------------
//
// The only thing that ties a track to the session that started it is the <task-notification> when the track delivers.
// These functions make the delivery visible without the notification:
//   - report.md in the track folder (<scratchpad>/<id>/, or the fix round <scratchpad>/<id>-r<N>/) is a SAFE delivery
//     signal when its first line is the RESULT line (status DONE or PARTIAL);
//   - `queue.mjs orchestrator pulse` and `queue.mjs deliveries` report reports that came after the start or the last receive;
//   - `queue.mjs resume <id>` makes the mission for a NEW agent on the same branch (fix round or continuation).
// The fields on the task (all optional): report_received (mtime in ms of the report `receive` read) and report_seen
// (mtime in ms of the newest report a pulse has reported), so the same report is only reported as new once.
// findTrackReport is the one function here that touches the file system: it only reads, and fs/path can be swapped in tests.

/** The reasons `resume` accepts: a fix round after review, or a continuation after the context guard (PARTIAL). */
const RESUME_REASONS = ['fix', 'context'];

/**
 * Safe delivery signal: the first non-empty line of report.md is `RESULT status=DONE|PARTIAL …` (markdown decoration
 * such as `#` and backticks is tolerated, as in parseResult). Otherwise null: a report that is half written or lacks the
 * line is not a delivery (then the heuristic in assessActive applies).
 * @returns {null | { status: 'DONE' | 'PARTIAL', line: string }}
 */
function deliverySignal(text) {
  const first = String(text ?? '')
    .split(/\r?\n/)
    .find((l) => l.trim() !== '');
  if (!first) return null;
  const r = parseResult(first);
  if (!r || !['DONE', 'PARTIAL'].includes(r.status)) return null;
  return { status: r.status, line: r.line };
}

/** The round a scratchpad folder belongs to: `<id>` is 0, `<id>-r<N>` is N, anything else null. */
function trackFolderRound(name, id) {
  const n = String(name ?? '');
  if (n === id) return 0;
  const prefix = `${id}-r`;
  if (!n.startsWith(prefix)) return null;
  const rest = n.slice(prefix.length);
  return /^\d+$/.test(rest) ? Number(rest) : null;
}

/**
 * Looks in the scratchpad roots (the orchestrator's own and the one saved on the task, o.scratchpad) for the track's
 * folders `<id>` and `<id>-r<N>`, and for the fix round prompts `prompt-<id>-r<N>.md`. Gives the newest report.md, the
 * newest handover.md and the next free round number. Only reads; `fsx` and `pathx` can be swapped in tests.
 * @returns {{ report: null | { path: string, folder: string, round: number, mtimeMs: number, text: string },
 *   handover: null | { path: string, mtimeMs: number }, nextRound: number }}
 */
function findTrackReport(id, roots, fsx = require('node:fs'), pathx = require('node:path')) {
  let report = null;
  let handover = null;
  let maxRound = 0;
  const seen = new Set();
  for (const root of roots ?? []) {
    if (!root) continue;
    const r = pathx.resolve(root);
    if (seen.has(r.toLowerCase())) continue;
    seen.add(r.toLowerCase());
    let names = [];
    try {
      names = fsx.readdirSync(r);
    } catch {
      continue; // the root does not exist (e.g. an old session's scratchpad that has been cleaned up)
    }
    for (const n of names) {
      const prompt = /^prompt-(.+)\.md$/.exec(n);
      const promptRound = prompt ? trackFolderRound(prompt[1], id) : null;
      if (promptRound != null) maxRound = Math.max(maxRound, promptRound);
      const round = trackFolderRound(n, id);
      if (round == null) continue;
      maxRound = Math.max(maxRound, round);
      const folder = pathx.join(r, n);
      for (const file of ['report.md', 'handover.md']) {
        const filePath = pathx.join(folder, file);
        let mtimeMs;
        try {
          const st = fsx.statSync(filePath);
          if (!st.isFile()) continue;
          mtimeMs = st.mtimeMs;
        } catch {
          continue;
        }
        if (file === 'handover.md') {
          if (!handover || mtimeMs > handover.mtimeMs) handover = { path: filePath, mtimeMs };
        } else if (!report || mtimeMs > report.mtimeMs) {
          let text;
          try {
            text = fsx.readFileSync(filePath, 'utf8');
          } catch {
            continue; // file lock while the track writes: the next pulse takes it
          }
          report = { path: filePath, folder, round, mtimeMs, text };
        }
      }
    }
  }
  return { report, handover, nextRound: maxRound + 1 };
}

/** The baseline for a new delivery: the start, the delivery to review or the last receive, whichever is latest (ms). */
function deliveryBase(o) {
  const t = [
    Date.parse(o?.started ?? ''),
    Date.parse(o?.delivered ?? ''),
    Number(o?.report_received ?? Number.NaN),
  ].filter(Number.isFinite);
  return t.length ? Math.max(...t) : 0;
}

/**
 * Is the report a delivery that has not been received? Requires the delivery signal and that the report is newer than
 * deliveryBase (a report from before the start, or the one `receive` has already read, does not count). `new` is true
 * when no pulse has reported exactly this report before (o.report_seen).
 * @param {object} o the task
 * @param {null | { path: string, mtimeMs: number, text: string }} report from findTrackReport
 */
function assessDelivery(o, report) {
  if (!o || !report) return null;
  const sig = deliverySignal(report.text);
  if (!sig) return null;
  if (!(report.mtimeMs > deliveryBase(o))) return null;
  return {
    id: o.id,
    taskStatus: o.status,
    status: sig.status,
    line: sig.line,
    path: report.path,
    mtimeMs: report.mtimeMs,
    new: report.mtimeMs > Number(o.report_seen ?? 0),
  };
}

/**
 * The classification in queue-takeover.mjs for an active task. The safe signal (a delivery from assessDelivery) goes
 * first; the heuristic is the fallback:
 *   DELIVERED: commits ahead of baseBranch, a clean worktree, and no new commit in 20 min (the agent has finished).
 *   EMPTY: no commits and started over an hour ago (the agent died before it did anything). `anotherBranch` is only
 *          called then (git log --all is expensive) and gives a commit on another branch that mentions the id, or null.
 */
function assessActive({
  status,
  commits = 0,
  uncommitted = null,
  lastMs = null,
  startedMs = null,
  delivery = null,
  anotherBranch = () => null,
}) {
  if (delivery)
    return `DELIVERED (report.md ${delivery.status}${status === 'review' ? ', new round after receive' : ''})`;
  if (status === 'review') return commits > 0 ? 'DELIVERED (review)' : 'UNCERTAIN (review without commits)';
  if (commits > 0 && (uncommitted ?? 0) === 0 && (lastMs ?? 0) > 20 * 60_000) return 'DELIVERED';
  if (commits === 0 && (startedMs ?? 0) > 60 * 60_000) {
    const another = anotherBranch();
    return another ? `UNCERTAIN (commit ${another} mentions the id on another branch)` : 'EMPTY';
  }
  if ((uncommitted ?? 0) > 0) return 'UNCERTAIN (uncommitted in worktree)';
  return 'UNCERTAIN';
}

/** The lines pulse and `deliveries` print: one per new delivery (with the next command), and one summary line for the rest. */
function deliveryLines(deliveries, nowMs = Date.now()) {
  const cq = require('./projectRoot.js').cqCommand();
  const fresh = (deliveries ?? []).filter((l) => l.new);
  const old = (deliveries ?? []).filter((l) => !l.new);
  const out = fresh.map(
    (l) =>
      `NEW DELIVERY (report.md): ${l.id} ${l.status}, written ${ageText(nowMs - l.mtimeMs)} ago. ` +
      `Next: ${cq} receive ${l.id}`,
  );
  if (old.length)
    out.push(
      `Report waiting, not received: ${old.map((l) => `${l.id} (${l.status})`).join(', ')} (${cq} deliveries)`,
    );
  return out;
}

/**
 * The track block (make-mission.mjs format) for a NEW agent that continues a track on the same branch: a fix round after
 * review (`fix`) or a continuation after the context guard or PARTIAL (`context`). The track id is `<id>-r<round>`, so the
 * agent's folder becomes `<scratchpad>/<id>-r<round>/` (findTrackReport finds the report there). `original` is the
 * trackBlock text of the task (ownership, mission) and comes along as reference.
 */
function resumeBlock({
  o,
  round,
  reason,
  reportPath = null,
  handoverPath = null,
  reviewFolder = null,
  reviewFiles = [],
  findingsFile = null,
  original = '',
}) {
  const base = baseBranch();
  const trackId = `${o.id}-r${round}`;
  const branch = o.branch ?? `${branchPrefix()}${o.id}`;
  const block =
    o.migr_block ?? 'none (the track must not have migrations; if it needs them, ask the orchestrator)';
  const fix = reason === 'fix';
  const name = fix ? 'Fix round' : 'Continuation';
  const cq = require('./projectRoot.js').cqCommand();
  const read = [
    `1. \`git log --oneline ${base}..${branch}\` and \`git diff --stat ${base}...${branch}\` (what is done; do not redo it).`,
    reportPath
      ? `2. The track's last report: ${reportPath}`
      : '2. The track has no report: build the picture from the commits and the commit messages.',
    handoverPath
      ? `3. The handover (done, remaining, next command, open questions): ${handoverPath}`
      : `3. No handover.md${fix ? '' : ': continue from the report and the commits'}.`,
  ];
  if (reviewFolder)
    read.push(
      `4. The review package: ${reviewFolder} (00-package.md first)` +
        (reviewFiles.length ? `; the reviewers' files there: ${reviewFiles.join(', ')}` : ''),
    );
  if (findingsFile) read.push(`${reviewFolder ? 5 : 4}. The findings to fix: ${findingsFile}`);
  const work = fix
    ? [
        'Fix the review findings: HIGH, and MEDIUM that is not small and mechanical; LOW findings in the same files come along.',
        'Fix at the file:line the findings point to, and only in the files the track owns. A finding you disagree with:',
        'give the reason in the report instead of fixing it.',
      ]
    : [
        'Continue where the previous agent stopped (context guard): do "remaining" from the handover, with "next command"',
        'first. What is already committed is not redone.',
      ];
  return [
    `=====${trackId}=====`,
    `TITLE: TRACK ${trackId} (${name.toLowerCase()} ${round} for ${o.id}: ${o.title})`,
    `CLASS: ${o.class}`,
    `BLOCK: ${block}`,
    `BRANCH: ${branch}`,
    '',
    `## ${name} ${round} for ${o.id} (new agent on the same branch, adoption)`,
    '',
    `The branch ${branch} already has the track's commits. The first call is prepare-track WITH \`--continue\` (it is in the setup`,
    `above): the branch is taken over with \`git switch\` without reset, and its own commits are counted against ${base}. Never`,
    `run it without \`--continue\`: \`checkout -B ${branch} ${base}\` would reset the branch. If it refuses because the branch is`,
    'checked out in another worktree, stop and report the path (the orchestrator frees it).',
    '',
    'Read first (excerpts, not whole files):',
    ...read,
    '',
    ...work,
    '',
    `Report: write report.md in your own folder (\`<folder>\`, that is ${trackId}) with the RESULT line as the FIRST line;`,
    `it covers the whole track (branch=${branch}, commits = all on the branch ahead of ${base}). The orchestrator finds it there`,
    `(${cq} deliveries and ${cq} receive ${o.id}), also without a notification. Your answer starts with the same RESULT line.`,
    '',
    `## The original mission for ${o.id} (reference; ownership, gates and "Do NOT touch" still apply)`,
    '',
    String(original ?? '').trim(),
    '',
  ].join('\n');
}

/**
 * Adapts a prompt from make-mission.mjs to a continuation: the setup call gets `--continue`, and the git line says
 * `git switch` instead of `checkout -B` (the common protocol is written for a new track).
 * @returns {{ text: string, swapped: number }}
 */
function resumePromptAdjust(text, { trackId, branch, base = baseBranch() }) {
  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  let swapped = 0;
  let t = String(text ?? '').replace(
    new RegExp(`(prepare-track(?:\\.mjs)? ${esc(trackId)} --branch ${esc(branch)})(?! --continue)`, 'g'),
    (m) => {
      swapped++;
      return `${m} --continue`;
    },
  );
  t = t.replace(
    new RegExp(`\`prepare-track\` runs \`git checkout -B ${esc(branch)} ${esc(base)}\``, 'g'),
    () => {
      swapped++;
      return `\`prepare-track --continue\` runs \`git switch ${branch}\` (without reset)`;
    },
  );
  return { text: t, swapped };
}

module.exports = {
  WEIGHT,
  CALIBRATED,
  estimateWall,
  estimateCost,
  costLabel,
  DEFAULT_LIMITS,
  LIMIT_NAME,
  LIMIT_EXTRA,
  estimate,
  validate,
  fileOverlap,
  conflict,
  conflictPart,
  blockers,
  blockerParts,
  childrenMap,
  withIndex,
  successors,
  lockUpCount,
  score,
  hasMigr,
  ACTIVE,
  spaceUse,
  selectNext,
  assignMigrBlock,
  migrTens,
  // Taken migration blocks (start, fill, pick, next-migr, migr move)
  MIGR_FREE_STATUS,
  blockInterval,
  blocksInText,
  promptTask,
  takenBlocks,
  assignStartBlock,
  parseMoveBlock,
  moveBlockInText,
  resetConfig,
  baseBranch,
  branchPrefix,
  queueBranch,
  state,
  budgetGuard,
  NIGHT_TZ,
  parseNightWindow,
  inNightWindow,
  nightGuard,
  startGuard,
  windDownGuard,
  loadGuard,
  loadSlotsFor,
  modelFor,
  modelPart,
  AGENT_MODELS,
  minFreeMemoryFor,
  limitText,
  parseLimit,
  isAgentSource,
  statusAtAdd,
  approve,
  // Project, feature, picking and visual QA
  STATUSES,
  WITHOUT_PROJECT,
  WITHOUT_FEATURE,
  OLD_PICK_MS,
  validateNewField,
  projectFor,
  projectPaused,
  blockersWithPause,
  hasLabel,
  counterAsAgent,
  groups,
  projectOverview,
  newRegister,
  editMany,
  // Areas, focus period, pulled along and parking
  WITHOUT_AREA,
  FOCUS_REST,
  areaFor,
  parseStep,
  stepMatch,
  focusApplies,
  ownStep,
  parkedNow,
  draggedWith,
  rankingContext,
  focusSpace,
  ranking,
  compareRanking,
  parseToDate,
  stepText,
  focusText,
  setFocus,
  removeFocus,
  FOCUS_PLAN_MAX,
  saveFocusPlan,
  scoreParts,
  stepTitle,
  openQuestion,
  focusStatus,
  // Done focus stages are evaluated and taken out
  evaluateFocusStep,
  focusWithoutDone,
  cleanFocus,
  focusCleanLines,
  restText,
  setArea,
  areaOverview,
  park,
  continue: proceed,
  migrBlockText,
  pickable,
  pick,
  deliver,
  release,
  isOldPick,
  ageText,
  setStatus,
  qaList,
  qaOk,
  qaDeviation,
  qaConfig,
  validateEvidence,
  parseEvidence,
  evidenceRequired,
  evidenceWarning,
  evidenceText,
  qaSplit,
  evidenceCommand,
  qaAutoOutcome,
  // Work outside the queue, push check and orchestrator marker
  ORCHESTRATOR_TRAILER,
  ORCHESTRATOR_EXPIRY_MS,
  COLLISION_STATUSES,
  isExternalRow,
  hasOrchestratorTrailer,
  queueIdFromMerge,
  classifyCommit,
  mentionedIds,
  consistency,
  pushPlan,
  uncommittedCollision,
  uncommittedSkipped,
  externalCollisions,
  collisionText,
  trackFileWarning,
  externalId,
  externalAdd,
  externalDone,
  externalAccept,
  orchestratorStatus,
  newCursor,
  missingProject,
  QUESTION_TYPES,
  validQuestionId,
  setQuestion,
  resolve,
  unlogged,
  markLogged,
  questionOverview,
  questionWithoutText,
  answerBlock,
  // Owner answers cannot be lost
  QUESTION_ID_PATTERN,
  questionRegistered,
  waitingOnError,
  resolveWaits,
  resolveWaitsLines,
  ownerAnswerBonus,
  // The track block (trackFile and cloud package) and queue tasks in cloud sessions
  trackBlock,
  CLOUD_BY,
  CLOUD_MAX,
  isCloud,
  cloudReferences,
  cloudSuitable,
  cloudPackage,
  CLOUD_BUNDLE_MAX,
  CLOUD_BUNDLE_MIN,
  cloudBundleCap,
  cloudBundlePackage,
  cloudBundles,
  cloudSessions,
  cloudStart,
  cloudDone,
  cloudCancel,
  // Batch queue
  BATCHED_BLOCKER,
  BATCH_MEASURE,
  isBatched,
  inBatchQueue,
  batchedError,
  smallTaskError,
  SMALL_FIX_MIN,
  SMALL_LOW_VALUE,
  batchGroups,
  batchSuggestion,
  batchPack,
  batchMissionText,
  // The orchestrator's routine as script (show summary, fill, receive) and cost per task
  agentTypeFor,
  reviewersFor,
  reviewersForTask,
  trackMessage,
  stateLine,
  summaryView,
  parseResult,
  parseFindings,
  batchFindings,
  lastAnswer,
  firstUserMessage,
  mentionsTask,
  DEFAULT_REVIEWERS: HELP.DEFAULT_REVIEWERS,
  reviewerTypes,
  get REVIEWER_TYPES() {
    return reviewerTypes();
  },
  get TASK_AGENT_TYPES() {
    return taskAgentTypes();
  },
  agentsForTask,
  sumCost,
  costStatistics,
  packageFiles,
  dbObjectsFromDiff,
  reviewPackageIndex,
  reviewerPrompt,
  // Bulk edit, changelog and undo, block moves, proposed projects
  CHANGELOG_MAX,
  RANK_STEP,
  longestPrefix,
  parkedValue,
  cloneJson,
  equalValue,
  bulkDiff,
  diffLines,
  logChange,
  lastUndoable,
  undoEntry,
  expectCheck,
  rankBlock,
  planMatch,
  fileRootMatch,
  suggestProject,
  classifyQueue,
  prefixWarnings,
  addProjectWarnings,
  // The bulk actions on the board (queueBoard.bulkPlan, packPreview).
  batchId,
  LABEL_PATTERN,
  // Merge in one call, fixed lookups, concurrent calls and the report cap
  REPORT_CAP,
  environmentCheck,
  migrSetup,
  migrFiles,
  mergePlan,
  errorExcerpt,
  executeMerge,
  fillExcerpt,
  SAME_TURN,
  concurrentBlock,
  reportCapWarning,
  infoField,
  infoValueText,
  infoView,
  addToBonus,
  bonusBlock,
  activeLines,
  startedWithoutAgent,
  withoutAgentLines,
  NO_AGENT_GRACE_MIN,
  SILENT_DEFAULT_MIN,
  silentMinFor,
  silentCandidates,
  silentTracks,
  silentLines,
  BLOCK_CODES,
  openBlockOf,
  openBlock,
  closeBlock,
  blockerSummary,
  blockerLines,
  highestBlockNr,
  nextMigrGuard,
  // Adoption of running tracks (deliveries, resume)
  RESUME_REASONS,
  deliverySignal,
  trackFolderRound,
  findTrackReport,
  deliveryBase,
  assessDelivery,
  assessActive,
  deliveryLines,
  resumeBlock,
  resumePromptAdjust,
};
