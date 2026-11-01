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
  resetConfig, baseBranch, branchPrefix, queueBranch, WEIGHT, CALIBRATED, DEFAULT_LIMITS, NIGHT_TZ, ACTIVE, STATUSES,
  WITHOUT_PROJECT, WITHOUT_FEATURE, LABEL_PATTERN, OLD_PICK_MS, estimate, estimateWall, estimateCost, costLabel,
  hasMigr, ageText, isExternalRow, BATCHED_BLOCKER, isBatched, inBatchQueue, openQuestion, cutText, addToBonus,
  bonusBlock,
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
  draggedWith, rankingContext, focusSpace, ranking, compareRanking, parseToDate, stepTitle, stepText, focusText,
  score, scoreParts,
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
const {
  pickable, pick, deliver, release, isOldPick, setStatus, qaList, qaOk, qaDeviation,
} = require('./logic/pick.js');
const {
  externalCollisions, collisionText, trackFileWarning, externalId, externalAdd, externalDone, externalAccept,
  missingProject, trackBlock,
} = require('./logic/external.js');
const {
  CLOUD_BY, CLOUD_MAX, isCloud, cloudReferences, cloudSuitable, CLOUD_BUNDLE_MAX, CLOUD_BUNDLE_MIN, cloudPackage,
  cloudBundleCap, cloudBundlePackage, cloudBundles, cloudSessions, cloudStart, cloudDone, cloudCancel,
} = require('./logic/cloud.js');
const {
  agentTypeFor, AGENT_MODELS, modelFor, modelPart, reviewersFor, reviewersForTask, reviewerTypes, trackMessage,
  stateLine, summaryView,
} = require('./logic/agents.js');
const {
  parseResult, parseFindings, batchFindings, lastAnswer, firstUserMessage, mentionsTask, taskAgentTypes,
  agentsForTask, sumCost, costStatistics, packageFiles, dbObjectsFromDiff, reviewPackageIndex, reviewerPrompt,
} = require('./logic/results.js');
// The reviewers (fixed per class and the helper agents) are worked out in ONE place: lib/queueHelpers.js.
const HELP = require('./queueHelpers.js');

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
