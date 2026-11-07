// =============================================================
// queueLogicFacade.test.ts: lib/queueLogic.js stays a facade over lib/logic/*.js with the same exports.
//
// queueLogic.js was split into modules under lib/logic/ (see the layout in its header). Every caller and test still
// requires queueLogic.js, so its export names must never change by accident: the list below is the sorted key list
// from before the split. A new export is added here on purpose; a lost one fails. The test also checks the two getters
// and the alias that are not plain re-exports, and that every logic module loads on its own (no require cycle that only
// works in one load order).
// =============================================================
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const LIB = path.join(__dirname, '..');
const L = require('../queueLogic.js');

/** The sorted export names of queueLogic.js before the split (276), plus the ones added on purpose since. */
const EXPORTS = [
  'MAX_OPEN_PER_TRACK', 'asTrackProposal', 'trackLimitError',
  'ACTIVE', 'AGENT_MODELS', 'BATCHED_BLOCKER', 'BATCH_MEASURE', 'BLOCK_CODES', 'CALIBRATED', 'CHANGELOG_MAX',
  'CLOUD_BUNDLE_MAX', 'CLOUD_BUNDLE_MIN', 'CLOUD_BY', 'CLOUD_MAX', 'COLLISION_STATUSES', 'DEFAULT_LIMITS',
  'DEFAULT_REVIEWERS', 'FOCUS_END_CHOICES', 'FOCUS_PLAN_MAX', 'FOCUS_REST', 'LABEL_PATTERN', 'LIMIT_EXTRA', 'LIMIT_NAME',
  'MIGR_FREE_STATUS', 'NIGHT_TZ', 'NO_AGENT_GRACE_MIN', 'OLD_PICK_MS', 'ORCHESTRATOR_EXPIRY_MS',
  'ORCHESTRATOR_TRAILER', 'QUESTION_ID_PATTERN', 'QUESTION_TYPES', 'RANK_STEP', 'REPORT_CAP', 'RESUME_REASONS',
  'REVIEWER_TYPES', 'SAME_TURN', 'SILENT_DEFAULT_MIN', 'SMALL_FIX_MIN', 'SMALL_LOW_VALUE', 'STATUSES',
  'TASK_AGENT_TYPES', 'WEIGHT', 'WITHOUT_AREA', 'WITHOUT_FEATURE', 'WITHOUT_PROJECT', 'activeLines',
  'addProjectWarnings', 'addToBonus', 'ageText', 'agentTypeFor', 'agentsForTask', 'answerBlock', 'approve', 'areaFor',
  'areaOverview', 'assessActive', 'assessDelivery', 'assignMigrBlock', 'assignStartBlock', 'baseBranch',
  'batchFindings', 'batchGroups', 'batchId', 'batchMissionText', 'batchPack', 'batchSuggestion', 'batchedError',
  'blockInterval', 'blockerLines', 'blockerParts', 'blockerSummary', 'blockers', 'blockersWithPause', 'blocksInText',
  'bonusBlock', 'branchPrefix', 'budgetGuard', 'bulkDiff', 'childrenMap', 'choiceLines', 'choicesError', 'classifyCommit', 'classifyQueue',
  'cleanFocus', 'cloneJson', 'closeBlock', 'cloudBranches', 'cloudBundleCap', 'cloudBundleMax', 'cloudBundlePackage', 'cloudBundles', 'cloudCancel',
  'cloudDone', 'cloudMarker', 'cloudMax', 'cloudPackage', 'cloudReferences', 'cloudSessions', 'cloudStart', 'cloudSuitable', 'collisionText',
  'compareRanking', 'concurrentBlock', 'conflict', 'conflictPart', 'cycleError', 'dependencyCycles', 'consistency', 'continue', 'costLabel',
  'costStatistics', 'counterAsAgent', 'dbObjectsFromDiff', 'deliver', 'deliveryBase', 'deliveryLines',
  'deliverySignal', 'diffLines', 'draggedWith', 'dropFocusEndQuestions', 'editMany', 'environmentCheck', 'equalValue', 'errorExcerpt',
  'estimate', 'estimateCost', 'estimateWall', 'evaluateFocusStep', 'evidenceCommand', 'evidenceRequired',
  'evidenceText', 'evidenceWarning', 'executeMerge', 'expectCheck', 'externalAccept', 'externalAdd',
  'externalCollisions', 'externalDone', 'externalId', 'fileOverlap', 'fileRootMatch', 'fillExcerpt',
  'findTrackReport', 'firstUserMessage', 'focusApplies', 'focusCleanLines', 'focusContinues', 'focusEnd',
  'focusEndLine', 'focusEndQuestionId', 'focusEndText', 'focusRanEmpty', 'focusSpace', 'focusStatus', 'focusText',
  'focusWithoutDone', 'groups', 'hasLabel', 'hasMigr', 'hasOrchestratorTrailer', 'heldBackLines', 'highestBlockNr', 'inBatchQueue',
  'inNightWindow', 'infoField', 'infoValueText', 'infoView', 'isAgentSource', 'isBatched', 'isCloud', 'isExternalRow',
  'isOldPick', 'isRecommendedChoice', 'lastAnswer', 'lastUndoable', 'limitText', 'loadGuard', 'loadSlotsFor', 'lockUpCount', 'logChange',
  'longestPrefix', 'markLogged', 'mentionedIds', 'mentionsTask', 'mergePlan', 'migrBlockText', 'migrFiles',
  'migrSetup', 'migrTens', 'minFreeMemoryFor', 'missingProject', 'modelFor', 'modelPart', 'moveBlockInText',
  'newCursor', 'newRegister', 'nextMigrGuard', 'nightGuard', 'openBlock', 'openBlockOf', 'openQuestion',
  'orchestratorStatus', 'ownStep', 'ownerAnswerBonus', 'ownerQuestionSection', 'packageFiles', 'park', 'parkedNow', 'parkedValue',
  'parseEvidence', 'parseFindings', 'parseLimit', 'parseMoveBlock', 'parseNightWindow', 'parseResult', 'parseStep',
  'parseToDate', 'pick', 'pickChoice', 'pickable', 'planMatch', 'prefixWarnings', 'projectFor', 'projectOverview', 'projectPaused',
  'promptTask', 'pushPlan', 'qaAutoOutcome', 'qaConfig', 'qaDeviation', 'qaList', 'qaOk', 'qaSplit',
  'questionOverview', 'questionRegistered', 'questionWithoutText', 'queueBranch', 'queueIdFromMerge', 'rankBlock',
  'ranking', 'rankingContext', 'release', 'removeFocus', 'reportCapWarning', 'resetConfig', 'resolve', 'resolveWaits',
  'resolveWaitsLines', 'restText', 'resumeBlock', 'resumePromptAdjust', 'reviewPackageIndex', 'reviewerPrompt',
  'reviewerTypes', 'reviewersFor', 'reviewersForTask', 'saveFocusPlan', 'score', 'scoreParts', 'selectNext',
  'setArea', 'setFocus', 'setQuestion', 'setStatus', 'silentCandidates', 'silentWatched', 'roundOpen', 'fixRoundLine', 'silentLines', 'silentMinFor',
  'silentTracks', 'smallTaskError', 'spaceUse', 'startGuard', 'reportSinceStart', 'reservedWithoutAgent', 'noAgentTracks', 'waitingOnCancelled', 'waitingOnCancelledLines', 'SILENT_CARD_MIN', 'startedWithoutAgent', 'state', 'stateLine',
  'statusAtAdd', 'stepMatch', 'stepText', 'stepTitle', 'successors', 'suggestProject', 'sumCost', 'summaryView',
  'syncFocusEnd', 'takenBlocks', 'trackBlock', 'trackFileWarning', 'trackFolderRound', 'trackMessage', 'trackQuestion', 'uncommittedCollision',
  'uncommittedSkipped', 'undoEntry', 'unlogged', 'validQuestionId', 'validate', 'validateEvidence',
  'usageLimitGuard', 'validateNewField', 'waitingOnError', 'windDownGuard', 'withIndex', 'withoutAgentLines',
];

describe('queueLogic.js facade', () => {
  it('exports exactly the same names as before the split', () => {
    expect(Object.keys(L).sort()).toEqual([...EXPORTS].sort());
  });

  it('keeps the getters and the alias', () => {
    const d = Object.getOwnPropertyDescriptors(L);
    expect(typeof d.REVIEWER_TYPES.get).toBe('function');
    expect(typeof d.TASK_AGENT_TYPES.get).toBe('function');
    expect(L.continue).toBe(require('../logic/focus.js').proceed);
  });

  it('re-exports the same objects the modules hold', () => {
    for (const f of fs.readdirSync(path.join(LIB, 'logic')).filter((x) => x.endsWith('.js'))) {
      const m = require(path.join(LIB, 'logic', f));
      for (const [k, v] of Object.entries(m)) if (k in L && k !== 'continue') expect(L[k], `${f} ${k}`).toBe(v);
    }
  });

  it('every logic module loads on its own (fresh process, empty cache before each)', () => {
    const code =
      "const fs = require('fs'); const path = require('path'); const dir = process.argv[1]; const bad = [];" +
      "for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {" +
      '  for (const k of Object.keys(require.cache)) delete require.cache[k];' +
      '  try { const m = require(path.join(dir, f)); if (!Object.keys(m).length) bad.push(f + ": no exports"); }' +
      '  catch (e) { bad.push(f + ": " + e.message); } }' +
      'console.log(JSON.stringify(bad));';
    const r = spawnSync(process.execPath, ['-e', code, path.join(LIB, 'logic')], { encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([]);
  });
});
