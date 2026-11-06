// =============================================================
// logic/base.js: the shared base of the queue logic: config, vocabulary, estimates and small task helpers.
//
// The config (cfg, read once from queueConfig.js; resetConfig forgets it), the branch names (baseBranch, remoteName,
// branchPrefix, queueBranch), the weights and calibration (WEIGHT, CALIBRATED, estimate, estimateWall, estimateCost,
// costLabel), the default limits and the status, class, label and id vocabulary. Plus the small predicates and text
// helpers that most of the other modules need: isExternalRow, isBatched, inBatchQueue, openTask, openQuestion, hasMigr,
// REQUIRES, BATCHED_BLOCKER, utcText, ageText, cutText, round2, regexSafe and the bonus helpers (addToBonus, bonusBlock).
//
// Why one bottom module: these are used across the whole queue logic. Keeping them here, with no require of any other
// logic module, keeps the require graph between the modules free of cycles. Module state: the config cache only.
//
// Part of the queueLogic.js split: lib/queueLogic.js re-exports every name, so callers keep requiring queueLogic.js.
// Used by queueLogic.js (the facade) and by logic/projects.js, evidence.js, validate.js, conflicts.js, ranking.js,
// questions.js, commits.js, guards.js, batch.js, edit.js, focus.js, select.js, pick.js, external.js, cloud.js,
// agents.js, results.js, classify.js, monitor.js, resume.js.
// Tested in lib/__tests__/queueLogic.test.ts, costEstimate.test.ts, queueCapacity.test.ts and queueBatch.test.ts
// (through queueLogic.js).
// =============================================================

/**
 * The config (queue.config.json via queueConfig.js), read the first time it is needed. If reading fails (e.g. in a pure test without
 * config), the defaults are used.
 */
let configCache = null;
function cfg() {
  if (configCache) return configCache;
  try {
    configCache = require('../queueConfig.js').config();
  } catch {
    configCache = {};
  }
  return configCache;
}
/** Forgets the config that was read (tests that switch QUEUE_CONFIG). */
function resetConfig() {
  configCache = null;
}
/** The integration branch everything is merged into. */
const baseBranch = () => cfg().baseBranch ?? 'main';
/** The remote baseBranch is pushed to. */
const remoteName = () => cfg().remote ?? 'origin';
/** Prefix for the queue branches (`<prefix><id>`). */
const branchPrefix = () => cfg().branchPrefix ?? 'queue/';
/** The queue branch for a task. */
const queueBranch = (id) => `${branchPrefix()}${id}`;

/**
 * Weight per risk class. Estimate = content (min for a K track) × weight.
 *
 * `estimate` is NOT a good wall time; wall time depends little on content_min. WEIGHT and estimate drive priority (value
 * per minute in scoreParts), the size targets and the cloud bundle cap; editing them would reshuffle the queue. Calibrated wall time and
 * cost live in `estimateWall` and `estimateCost` below.
 */
const WEIGHT = { K: 1.0, D: 1.3, 'D+': 1.8, U: 0.6 };

/**
 * Calibrated model for WALL TIME (started → done, i.e. including review and merge) and COST (API-equivalent USD for track
 * and reviewers, timeCost.costUsd) per task: fixed + content_min × factor, per class. The start values are fitted to
 * the medians for finished queue tracks in a real project (a few hundred tracks):
 *   K: wall time approx. 15 min (content 30), 29 (90), 33 (120); cost approx. $0.9 / $2.4 / $3.5
 *   D: wall time approx. 60 min (30–60);                         cost approx. $3.6–5.4
 *   D+: wall time approx. 88 min (30);                            cost approx. $7.4
 *   U: wall time approx. 24 min (60);                             cost approx. $1.8
 * Fix rounds (2+ build agents) roughly double cost and wall time; they are rare and sit in the median.
 * Calibrate again (`queue.mjs cost`) when the class mix or way of working changes.
 */
const CALIBRATED = {
  date: '2026-10-23',
  wall: { K: [10, 0.19], D: [56, 0.4], 'D+': [65, 1.1], U: [6, 0.3] },
  cost: { K: [0.6, 0.022], D: [2, 0.08], 'D+': [3, 0.15], U: [0.6, 0.02] },
};

/** Default limits: overridden in the queue file under `limits`. */
// maxDb: tracks with migrations (migr_tens > 0) concurrently. Many concurrent DB tracks compete for the same
// database (locks, queueing in test runs); client tracks do not load it and are not limited by this limit.
// dailyBudget: USD API equivalent per day (measured with timeCost.js). null = off (no limit) until the owner has set a
// number with `queue.mjs limit dailyBudget <usd>`.
// nightRun / nightWindow: with nightRun off, no new tasks are started in the night window (local time, "23-06" =
// from 23:00 to 06:00). Default is on.
// autocompact: automatic compaction of the orchestrator session. On (default, as in Claude Code itself): Claude Code compacts
// by itself (autoCompactEnabled on, window 300k) and the queue resumes automatically. Off: notice with a ready /compact line,
// so the owner follows along (also turn off Claude Code's own compaction then). The hooks
// read the value (contextGuard.compactMode); `queue.mjs compact auto|manual`.
const DEFAULT_LIMITS = {
  maxConcurrent: 5,
  maxDPlus: 2,
  maxPerDomain: 7,
  maxDb: 6,
  dailyBudget: null,
  nightRun: true,
  nightWindow: '23-06',
  autocompact: true,
};
/** The time zone the night window and the daily budget's day apply in: the machine's own (the TZ environment variable
 * overrides it). */
const NIGHT_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * Statuses in which the task keeps its ownership (running, picked by a person or session, delivered and waiting for
 * review/merge, or work registered outside the queue). The queue starts nothing that collides with these.
 */
const ACTIVE = new Set(['running', 'review', 'picked', 'external']);

// proposed: added by an agent (track, reviewer, fold/investigation agent) and not approved yet. Never
// started; `queue.mjs approve <id…>` makes it waiting.
// picked: a person or session does the task manually (`queue.mjs pick`). Owns its files and has
// migrationBlock, but does not count toward maxConcurrent/maxDPlus.
// external: not a task, but a record of work in progress outside the queue (`queue.mjs external add`). Owns
// its files like a picked task until `external done <name>`. The row has `external: true` and never counts as
// work (projects, show, state).
const STATUSES = new Set([
  'proposed',
  'waiting',
  'running',
  'picked',
  'review',
  'done',
  'cancelled',
  'external',
]);
const CLASSES = new Set(Object.keys(WEIGHT));

/** The project for a task without its own `project` and without a match on any prefix in the register. */
const WITHOUT_PROJECT = 'without-project';
/** The group name for tasks without `feature` in the grouped view and the QA list. */
const WITHOUT_FEATURE = '(no feature)';
/** Visual QA: the owner looks at finished tasks with the label `visual`. */
const QA_STATUSES = new Set(['waiting', 'ok', 'deviation']);
const LABEL_VISUAL = 'visual';
/** Project id: short kebab-case (webshop, api-v2, reports). */
const PID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Label: short word in lowercase (visual). */
const LABEL_PATTERN = /^[a-z0-9][a-z0-9-]{0,30}$/;
/** A picked task is "old" when it has been picked this long without commits (it is never released automatically). */
const OLD_PICK_MS = 72 * 3_600_000;

/** Estimated time in minutes for a task (content × weight). */
function estimate(o) {
  const content = Number(o.content_min ?? 30);
  return Math.round(content * (WEIGHT[o.class] ?? 1));
}

/** Calibrated wall time in minutes (started → done, including review and merge), see CALIBRATED. */
function estimateWall(o) {
  const [fixedLine, factor] = CALIBRATED.wall[o?.class] ?? CALIBRATED.wall.K;
  return Math.round(fixedLine + Number(o?.content_min ?? 30) * factor);
}

/** Calibrated cost in API-equivalent USD (track and reviewers), see CALIBRATED. The basis for the quota forecast. */
function estimateCost(o) {
  const [fixedLine, factor] = CALIBRATED.cost[o?.class] ?? CALIBRATED.cost.K;
  return Math.round((fixedLine + Number(o?.content_min ?? 30) * factor) * 10) / 10;
}

/**
 * "~$2.4" (one decimal below $10, whole dollars above) for a cost estimate { usd }: the short form shown next to the
 * minute estimate. The calibrated estimate itself lives in lib/costEstimate.js; '' when there is no number.
 */
function costLabel(c) {
  const usd = Number(c?.usd);
  if (c?.usd == null || !Number.isFinite(usd)) return '';
  return `~$${usd < 10 ? usd.toFixed(1) : Math.round(usd)}`;
}
/** Does the task have migrations (counts toward maxDb)? */
const hasMigr = (o) => Number(o.migr_tens ?? 0) > 0;
/** "2026-10-01 14:02 UTC" from an ISO time (for the track file; the time is always saved in UTC). */
const utcText = (iso) =>
  typeof iso === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d/.test(iso)
    ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`
    : '?';
/** "14 min", "3 h 12 min", "4 d" from milliseconds ("?" when unknown). */
function ageText(ms) {
  if (ms == null || Number.isNaN(ms)) return '?';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const t = Math.floor(min / 60);
  return t < 48 ? `${t} h ${min % 60} min` : `${Math.floor(t / 24)} d`;
}
/** Is the row a record of work outside the queue (`queue.mjs external add`), not a task? */
function isExternalRow(o) {
  return o?.external === true;
}
const regexSafe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The field `requires` (set when the task is added): what the task needs beyond the repo on the remote.
// The resources in CLOUD_CLOSED do not exist in a cloud session (no database, the network is blocked behind a proxy, gitignored
// files, local source collections and the owner's device are local), so the task runs locally. `deploy` does not close:
// the orchestrator deploys after the merge.
const REQUIRES = new Set(['db', 'web', 'sources', 'local-files', 'unit', 'deploy']);
/** The blocker a task in the batch queue gets (show, the board, start, pick). */
const BATCHED_BLOCKER =
  'in the batch queue (packed into a track with ravenseat batch pack; taken out with edit --json \'{"batched":false}\')';
/** Does the task have `batched: true` (and is it a queue task, not a record outside the queue)? */
function isBatched(o) {
  return o?.batched === true && !isExternalRow(o);
}
/** Is the task in the batch queue now (batched and waiting or proposed)? Cancelled and finished ones are out of it. */
function inBatchQueue(o) {
  return isBatched(o) && (o.status === 'waiting' || o.status === 'proposed');
}
const openTask = (o) => !!o && o.status !== 'done' && o.status !== 'cancelled';
/** The owner questions in `waiting_on` that are not resolved. */
const openQuestion = (o, resolved = []) => {
  const a = new Set(resolved ?? []);
  return [...new Set(o?.waiting_on ?? [])].filter((sp) => !a.has(sp)).sort();
};
const round2 = (x) => Math.round(x * 100) / 100;
function cutText(s, n) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}
/**
 * Adds a bonus to the mission: in `bonus` (the track block shows it, so the prompt file gets it at the next fill/trackFile)
 * and in the remarks, both with a timestamp. Mutates the task; returns the error text or null.
 */
function addToBonus(o, text, now) {
  const t = String(text ?? '').trim();
  if (!t) return 'the addition is empty';
  o.bonus = [...(Array.isArray(o.bonus) ? o.bonus : []), { time: now, text: t }];
  o.remarks = [
    ...(Array.isArray(o.remarks) ? o.remarks : []),
    `${now} bonus to the mission: ${t}`,
  ];
  return null;
}
/** The additions as a separate section in the track block (null when there are none). */
function bonusBlock(o) {
  const t = Array.isArray(o?.bonus) ? o.bonus : [];
  if (!t.length) return null;
  return [
    '**Bonus from the orchestrator (binding, newest last):**',
    ...t.map((x) => `- ${x.time}: ${x.text}`),
  ].join('\n');
}

module.exports = {
  cfg,
  resetConfig,
  baseBranch,
  remoteName,
  branchPrefix,
  queueBranch,
  WEIGHT,
  CALIBRATED,
  DEFAULT_LIMITS,
  NIGHT_TZ,
  ACTIVE,
  STATUSES,
  CLASSES,
  WITHOUT_PROJECT,
  WITHOUT_FEATURE,
  QA_STATUSES,
  LABEL_VISUAL,
  PID_PATTERN,
  LABEL_PATTERN,
  OLD_PICK_MS,
  estimate,
  estimateWall,
  estimateCost,
  costLabel,
  hasMigr,
  utcText,
  ageText,
  isExternalRow,
  regexSafe,
  REQUIRES,
  BATCHED_BLOCKER,
  isBatched,
  inBatchQueue,
  openTask,
  openQuestion,
  round2,
  cutText,
  addToBonus,
  bonusBlock,
};
