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
//
// Layout: this file is a facade. The code lives in lib/logic/, one module per area (each has a header with what it
// holds and where it is tested), listed here bottom layer first. A module requires only modules listed before it,
// so there are no require cycles. This file re-exports exactly the names it always had, so every require of it
// keeps working; lib/__tests__/queueLogicFacade.test.ts asserts that the export names stay the same.
//   base.js       the shared base of the queue logic: config, vocabulary, estimates and small task helpers.
//   projects.js   project and feature of a task, the project register, and the fast index.
//   evidence.js   evidence in the QA entry (the `qa` config, parsing, validation, warnings and the auto outcome).
//   validate.js   validation of a new task (validate) and of its project fields (validateNewField).
//   conflicts.js  ownership conflicts between tasks, the blockers, and the per-list lookups.
//   ranking.js    the one ranking: areas, focus period and parking as they affect the order, and the priority score.
//   questions.js  proposed tasks, owner questions and resolutions, and owner answers that cannot be lost.
//   commits.js    work outside the queue, the git side: commit classification, push plan and the orchestrator marker.
//   guards.js     the guards that decide whether the queue may start more now, and the limits.
//   batch.js      the batch queue: small, non-blocking tasks packed into one track of the right size.
//   edit.js       bulk edit, the changelog, undo and block moves.
//   focus.js      writing the focus period, evaluating done focus stages, and areas and parking.
//   select.js     selecting the next tasks, the taken migration blocks, and the queue state.
//   pick.js       picking a task (a person or session takes it), status changes and the visual QA list.
//   external.js   rows for work outside the queue, and the track block.
//   cloud.js      queue tasks in cloud sessions on claude.ai.
//   agents.js     the orchestrator's routine as script: agent type, model, reviewers, the agent message and the short
//                 `show`.
//   results.js    the RESULT and FINDINGS lines, the transcripts, the cost per task and the review package.
//   classify.js   proposed projects: which project a task belongs to, and the warnings in add and project.
//   merge.js      fewer orchestrator turns: merge in one call, fill excerpts, concurrent starts and the report cap.
//   monitor.js    the views over running work: info, active tracks, tracks without an agent, silent tracks and blocker
//                 reasons.
//   resume.js     adoption: a new orchestrator session adopts tracks that are running.
// =============================================================

const {
  resetConfig, baseBranch, branchPrefix, queueBranch, WEIGHT, CALIBRATED, DEFAULT_LIMITS, NIGHT_TZ, ACTIVE, STATUSES,
  WITHOUT_PROJECT, WITHOUT_FEATURE, LABEL_PATTERN, OLD_PICK_MS, estimate, estimateWall, estimateCost, costLabel,
  hasMigr, ageText, isExternalRow, BATCHED_BLOCKER, isBatched, inBatchQueue, openQuestion, addToBonus, bonusBlock,
} = require('./logic/base.js');
const {
  projectFor, longestPrefix, projectPaused, hasLabel, counterAsAgent, groups, projectOverview, newRegister, withIndex,
} = require('./logic/projects.js');
const {
  qaConfig, validateEvidence, parseEvidence, evidenceRequired, evidenceWarning, evidenceText, qaSplit,
  evidenceCommand, qaAutoOutcome,
} = require('./logic/evidence.js');
const { validate, validateNewField, dependencyCycles, cycleError } = require('./logic/validate.js');
const {
  fileOverlap, conflictPart, conflict, blockerParts, blockers, childrenMap, successors, lockUpCount, contenders, dbKey,
  readsMode, readsOverlaps,
} = require('./logic/conflicts.js');
const {
  blockersWithPause, WITHOUT_AREA, FOCUS_REST, areaFor, parseStep, stepMatch, focusApplies, ownStep, parkedNow,
  focusEndQuestionId, FOCUS_END_CHOICES, focusRanEmpty, focusContinues, focusEndText, draggedWith, rankingContext, focusSpace, ranking, compareRanking, parseToDate, stepTitle, stepText, focusText,
  score, scoreParts,
} = require('./logic/ranking.js');
const {
  MAX_OPEN_PER_TRACK, asTrackProposal, trackLimitError,
  isAgentSource, statusAtAdd, approve, QUESTION_TYPES, validQuestionId, setQuestion, resolve, unlogged, markLogged,
  choicesError, choiceLines, isRecommendedChoice, pickChoice,
  questionOverview, questionWithoutText, QUESTION_ID_PATTERN, questionRegistered, waitingOnError, resolveWaits,
  resolveWaitsLines, ownerAnswerBonus, answerBlock, migrBlockText,
} = require('./logic/questions.js');
const {
  ORCHESTRATOR_TRAILER, ORCHESTRATOR_EXPIRY_MS, COLLISION_STATUSES, hasOrchestratorTrailer, queueIdFromMerge,
  classifyCommit, mentionedIds, consistency, pushPlan, uncommittedCollision, uncommittedSkipped, heldBackLines, orchestratorStatus,
  newCursor,
} = require('./logic/commits.js');
const {
  spaceUse, budgetGuard, parseNightWindow, inNightWindow, nightGuard, startGuard, minFreeMemoryFor, loadGuard,
  loadSlotsFor, windDownGuard, usageLimitGuard, LIMIT_NAME, LIMIT_EXTRA, limitText, parseLimit,
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
  restText, focusCleanLines, setArea, areaOverview, park, proceed, focusEnd, syncFocusEnd, dropFocusEndQuestions,
  focusEndLine,
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
  CLOUD_BY, CLOUD_MAX, cloudMax, cloudMarker, cloudBranches, isCloud, cloudReferences, cloudSuitable, CLOUD_BUNDLE_MAX, CLOUD_BUNDLE_MIN, cloudPackage,
  cloudBundleCap, cloudBundleMax, cloudBundlePackage, cloudBundles, cloudSessions, cloudStart, cloudDone, cloudCancel,
} = require('./logic/cloud.js');
const {
  agentTypeFor, AGENT_MODELS, modelFor, modelPart, reviewersFor, reviewersForTask, reviewerTypes, trackMessage,
  stateLine, summaryView,
} = require('./logic/agents.js');
const {
  parseResult, parseFindings, batchFindings, lastAnswer, firstUserMessage, mentionsTask, taskAgentTypes,
  agentsForTask, sumCost, costStatistics, packageFiles, dbObjectsFromDiff, reviewPackageIndex, reviewerPrompt,
  ownerQuestionSection,
  assumptionSection,
  trackQuestion,
} = require('./logic/results.js');
const {
  planMatch, fileRootMatch, suggestProject, classifyQueue, prefixWarnings, addProjectWarnings,
} = require('./logic/classify.js');
const {
  REPORT_CAP, migrSetup, environmentCheck, migrFiles, mergePlan, errorExcerpt, executeMerge, fillExcerpt, SAME_TURN,
  concurrentBlock, reportCapWarning, fixRoundLine,
} = require('./logic/merge.js');
const {
  infoField, infoValueText, infoView, activeLines, NO_AGENT_GRACE_MIN, startedWithoutAgent, reportSinceStart, reservedWithoutAgent, noAgentTracks, withoutAgentLines, waitingOnCancelled, waitingOnCancelledLines, SILENT_CARD_MIN,
  SILENT_DEFAULT_MIN, silentMinFor, silentCandidates, silentWatched, roundOpen, silentTracks, silentLines, BLOCK_CODES, STUCK_BLOCK_CODES, openBlockOf, stuckBlockOf, openBlock,
  closeBlock, blockerSummary, blockerLines, highestBlockNr, nextMigrGuard,
} = require('./logic/monitor.js');
const {
  RESUME_REASONS, deliverySignal, trackFolderRound, findTrackReport, deliveryBase, assessDelivery, assessActive,
  deliveryLines, fixWorkLines, resumeBlock, resumePromptAdjust,
} = require('./logic/resume.js');
// The reviewers (fixed per class and the helper agents) are worked out in ONE place: lib/queueHelpers.js.
const HELP = require('./queueHelpers.js');

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
  readsMode,
  readsOverlaps,
  blockers,
  blockerParts,
  childrenMap,
  withIndex,
  successors,
  lockUpCount,
  contenders,
  dbKey,
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
  usageLimitGuard,
  loadGuard,
  loadSlotsFor,
  modelFor,
  modelPart,
  AGENT_MODELS,
  minFreeMemoryFor,
  limitText,
  parseLimit,
  MAX_OPEN_PER_TRACK,
  asTrackProposal,
  trackLimitError,
  isAgentSource,
  statusAtAdd,
  approve,
  // Project, feature, picking and visual QA
  STATUSES,
  WITHOUT_PROJECT,
  WITHOUT_FEATURE,
  OLD_PICK_MS,
  validateNewField,
  dependencyCycles,
  cycleError,
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
  // When the focus has ended (all stages done or the period over): continueWhenEmpty, the record and the question
  focusEndQuestionId,
  FOCUS_END_CHOICES,
  focusRanEmpty,
  focusContinues,
  focusEndText,
  focusEnd,
  syncFocusEnd,
  dropFocusEndQuestions,
  focusEndLine,
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
  heldBackLines,
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
  choicesError,
  choiceLines,
  isRecommendedChoice,
  pickChoice,
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
  cloudMax,
  cloudMarker,
  cloudBranches,
  cloudReferences,
  cloudSuitable,
  cloudPackage,
  CLOUD_BUNDLE_MAX,
  CLOUD_BUNDLE_MIN,
  cloudBundleCap,
  cloudBundleMax,
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
  ownerQuestionSection,
  assumptionSection,
  trackQuestion,
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
  fixRoundLine,
  reportCapWarning,
  infoField,
  infoValueText,
  infoView,
  addToBonus,
  bonusBlock,
  activeLines,
  startedWithoutAgent,
  reportSinceStart,
  reservedWithoutAgent,
  noAgentTracks,
  withoutAgentLines,
  waitingOnCancelled,
  waitingOnCancelledLines,
  SILENT_CARD_MIN,
  NO_AGENT_GRACE_MIN,
  SILENT_DEFAULT_MIN,
  silentMinFor,
  silentCandidates,
  silentWatched,
  roundOpen,
  silentTracks,
  silentLines,
  BLOCK_CODES,
  STUCK_BLOCK_CODES,
  openBlockOf,
  stuckBlockOf,
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
  fixWorkLines,
  resumeBlock,
  resumePromptAdjust,
};
