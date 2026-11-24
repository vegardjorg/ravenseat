// =============================================================
// settings/requires.js: REQUIRES, the rows a settings row needs to have any effect (finding M3), one table so each
// entry can name the code that ignores the row while its parent is off.
//
// Moved unchanged out of lib/settingsRegistry.js (SPLIT-1); the header there explains `requires`. row() in ./rowKit.js
// copies the entry onto the row, and lib/settingsRegistry.js exports the table as REQUIRES.
//
// Used by: ./rowKit.js, lib/settingsRegistry.js (and through it lib/settingsView.js).
// Tested in: lib/__tests__/settingsRegistry.test.ts (every key is a row, no cycles) and
// lib/__tests__/settingsRegistrySplit.test.ts.
// =============================================================
'use strict';

/**
 * The `requires` of each row that has one (see the header), kept in one table so each entry can name the code that
 * ignores the row while its parent is off. A key here that is no row fails the registry test. Read in the code, not
 * guessed; left out on purpose (the code still reads them with the parent off): gates.redOnBaseStrict (stops every fix
 * without red on base, which doctor warns about), limits.nightWindow (the Statistics night share), scopeNotes.ignoreNames
 * (the catalog's near names), instructionSize.maxLines/maxChars (`ravenseat instructions`), baseGate.timeoutSec (the
 * receive and merge budget), testWeakening.testPaths (red on base), migrations.pushCommand, environmentFile and
 * allowedEnvironment (the push guard), learning.proposals (the catalog rule gates need no learning.repeats) and the
 * cloud.* rows (the cloud commands do not read features.cloud).
 */
const REQUIRES = Object.freeze({
  // lib/fixRound.js: continueWithinMin 0 turns continuation off before the context cap is read.
  'fixRound.continueMaxContextK': ['fixRound.continueWithinMin'],
  // lib/gateEvidence.js: the names are read only in mode external.
  'gateEvidence.external': ['gateEvidence.mode=external'],
  // lib/gateClean.js decide: with gates.runner worktree no run uses a clean copy (only a one-off --clean reads them).
  'gates.clean.dependencies': ['gates.runner=clean'],
  'gates.clean.copy': ['gates.runner=clean'],
  'gates.clean.include': ['gates.runner=clean'],
  'gates.clean.kinds': ['gates.runner=clean'],
  'gates.clean.keepOnRed': ['gates.runner=clean'],
  // lib/baseHealth.js setup: enabled false turns the base gate off, with its commands, output tail and rerun.
  'baseGate.commands': ['baseGate.enabled'],
  'baseGate.tailLines': ['baseGate.enabled'],
  'baseGate.flakyRerun': ['baseGate.enabled'],
  // cli/merge.mjs: the test weakening check (and its focus stop, finding row and markers) is skipped when off.
  'testWeakening.focusStop': ['testWeakening.enabled'],
  'testWeakening.findingLog': ['testWeakening.enabled'],
  'testWeakening.markers': ['testWeakening.enabled'],
  // cli/merge.mjs: no decision signal is read when off, so the thresholds have nothing to count.
  'decisionSignals.deleteMin': ['decisionSignals.enabled'],
  'decisionSignals.bigDiffLines': ['decisionSignals.enabled'],
  // lib/fixTests.js receiveLine: red on base off gives no verdict, so the default mode prints no fix line.
  'gates.fixWithoutTestWarning': ['gates.redOnBase'],
  // board/checks.js drawChecksTab: the dot sits on the tab, which is hidden with the tab off.
  'checksPanel.marker': ['checksPanel.mode'],
  // cli/inspection.mjs: with inspection.mode off nothing is scanned or proposed.
  'inspection.minRepeats': ['inspection.mode'],
  'inspection.windowDays': ['inspection.mode'],
  // lib/findingRepeats.js scan and facts: learning.repeats off returns no entries, nothing due and no guard failed.
  'learning.windowDays': ['learning.repeats'],
  'learning.areaRepeats': ['learning.repeats'],
  'learning.projectRepeats': ['learning.repeats'],
  'learning.guardFailedMarker': ['learning.repeats'],
  // checks-catalog/suggestions/ledger-recipes.md (when: inspection-on, ledger-due): the recipes, the database ones and
  // their damping (lib/checksCatalog.js, lib/recipePrecision.js) are only on that card.
  'learning.dbProbes': ['inspection.mode', 'learning.repeats'],
  'learning.recipeDamping': ['inspection.mode', 'learning.repeats'],
  'learning.recipeMinProposals': ['learning.recipeDamping'],
  'learning.recipeMinProposalsDb': ['learning.recipeDamping', 'learning.dbProbes'],
  'learning.recipeMinAccepted': ['learning.recipeDamping'],
  // lib/agentGuard.js: with enabled false the other types are not guarded, so there is nothing to leave out.
  'agentGuard.except': ['agentGuard.enabled'],
  // lib/pushBatch.js ownerAskOn: only in push mode owner.
  'push.ownerAsk': ['push.mode=owner'],
  // cli/ciWatch.mjs: with push.ciWatch off nothing is watched.
  'push.ciWatchIntervalSec': ['push.ciWatch=github'],
  'push.ciWatchTimeoutMin': ['push.ciWatch=github'],
  // lib/logic/merge.js migrFiles and lib/logic/select.js migrTens: no folder, no migration files and no blocks.
  'migrations.filePattern': ['migrations.folder'],
  'migrations.blockSize': ['migrations.folder'],
  // lib/queueProposals.js: auto-accept off approves nothing, whatever the rules say.
  'proposals.autoAccept.classes': ['proposals.autoAccept.enabled'],
  'proposals.autoAccept.maxEstimateMin': ['proposals.autoAccept.enabled'],
  'proposals.autoAccept.maxValue': ['proposals.autoAccept.enabled'],
  // lib/scopeNotes.js: the depth is read only for the new folder note, the two numbers only for the gap review.
  'scopeNotes.folderDepth': ['scopeNotes.newFolders'],
  'scopeNotes.driftGapFiles': ['scopeNotes.driftGap'],
  'scopeNotes.driftGapShare': ['scopeNotes.driftGap'],
  // lib/catalogChecks.js: checks off tries no rule, so there is nothing to stop on and nothing broken again; the lint
  // proposal also needs learning.proposals (cli/catalog.mjs proposeRuleGates).
  'catalog.checkStop': ['catalog.checks'],
  'catalog.gateAfter': ['learning.proposals', 'catalog.checks'],
  // board/top.js applyFeatures: the Cloud tab comes with the cloud module.
  'board.showCloud': ['features.cloud'],
  // board/timeline.js: with the Timeline tab off nothing is fetched or drawn, so its horizon and rows are not read.
  'board.timelineHorizonDays': ['board.timeline'],
  'board.timelineRows': ['board.timeline'],
  // board/timeline.js (T-B): the drag lives on the Timeline, and the preview is a step of the drag.
  'board.timelineDrag': ['board.timeline'],
  'board.timelineDragPreview': ['board.timeline', 'board.timelineDrag'],
  // T-C: the band is drawn on the Timeline only.
  'board.timelineUncertainty': ['board.timeline'],
  // board/palette.js paletteOn: Ctrl+K opens the palette only while the shortcuts are on as well.
  'board.palette': ['board.shortcuts'],
  // cli/checks.mjs canaryFacts: with the canary off no transcript is read, so no shape is logged.
  'client.shapeLog': ['client.canary'],
  // lib/queueConfig.js features: a part is off while its parent is off.
  'features.plans.legal': ['features.plans'],
  'features.plans.launch': ['features.plans'],
  'features.plans.documents': ['features.plans'],
  'features.plans.inbox': ['features.plans'],
  // The Roadmap rows: without the Plans room there is no roadmap, and queue-board.mjs plans() reads no plan document.
  'plans.startView': ['features.plans'],
  'plans.roadmapLayout': ['features.plans'],
  'plans.roadmapFoldAfter': ['features.plans'],
  'plans.leadFromDocument': ['features.plans'],
  'plans.searchDocuments': ['features.plans'],
  // lib/loadSlots.js: adaptive off keeps every slot open, so the scaling numbers are not read.
  'loadGuard.minSlots': ['loadGuard.adaptive'],
  'loadGuard.allSlotsFreeMemoryPct': ['loadGuard.adaptive'],
  'loadGuard.allSlotsCpuPct': ['loadGuard.adaptive'],
  'loadGuard.minSlotsCpuPct': ['loadGuard.adaptive'],
  // lib/gateQueue.js isHeavy: with the gate queue off no run counts as heavy or waits for a slot.
  'gateQueue.slots': ['gateQueue.enabled'],
  'gateQueue.heavyAfterSec': ['gateQueue.enabled'],
  'gateQueue.agingMin': ['gateQueue.enabled'],
  'gateQueue.staleMin': ['gateQueue.enabled'],
  // lib/heavyCommand.js: with the gate queue off there is no slot to take, so the hook says nothing.
  'processGuard.heavyQueue': ['gateQueue.enabled'],
  // lib/stateSnapshots.js tiersFrom: enabled false gives no tiers.
  'stateSnapshots.tiers': ['stateSnapshots.enabled'],
  // lib/silentSnapshot.js: enabled false writes no snapshot, so neither the count nor the cap is read.
  'silentSnapshot.keep': ['silentSnapshot.enabled'],
  'silentSnapshot.maxKB': ['silentSnapshot.enabled'],
  // lib/processGuard.js: the sweep reads what the register wrote, and the automatic stop acts on the sweep's findings.
  'processGuard.sweep': ['processGuard.register'],
  'processGuard.autoKill': ['processGuard.sweep'],
});

module.exports = { REQUIRES };
