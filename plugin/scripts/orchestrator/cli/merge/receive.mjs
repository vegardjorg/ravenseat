// =============================================================
// cli/merge/receive.mjs: `ravenseat receive`, the intake and the review package: the task, the stops before
// anything changes, the delivery read (the track's answer, report and handover; owner questions, assumptions and the
// owner mark), and then the package (diff, files, mission, reviewers and their prompts, the checks' lines and sections).
//
// Why a module: the receive flow in steps (SPLIT-1, see cli/merge.mjs, which runs intake, receiveEvidence, package and
// record in that order). Moved as it was: same output, exit codes and files. The two functions are cmdReceive cut at
// its seams; what one step hands the next is passed as an object, nothing is shared at module level.
//
// Used by: cli/merge.mjs (cmdReceive).
// Tested in: __tests__/queueAdopt.test.ts, lib/__tests__/queueOrchestrator.test.ts, lib/__tests__/mergeDangerReceive.test.ts,
//   __tests__/redteam/rt08-weakened-test.test.ts, __tests__/queueFixContinue.test.ts, __tests__/redteam/rt16-changed-helper.test.ts.
// =============================================================

import fs from 'node:fs';
import path from 'node:path';

import { a, BASE, branchFor, branchInfo, CLI, CONFIG, die, edit, git, HELP, L, MAIN_TREE, MIGR, positional, read, require, val } from '../context.mjs';
import { attemptRows, gitLarge, gitShowAt, lastTrackReply, missionMark, scratchpadFor, taskAgents, trackReport } from '../tracks.mjs';
import { notBuildingLines } from '../notBuilding.mjs';
import { stopOnDrift, stopOnOwnerRows } from './evidence.mjs';
import {
  catalogRulesFor, controlFileLines, outsideCliLines, receiveSecretScan, redOnBaseCheck, reviewNewNames, scopeNotesFor,
  secretScanLines,
} from './receiveChecks.mjs';

const CONTROLS = require('./lib/controls.js');
const GUIDANCE = require('./lib/guidance.js');
// The wiring spec as open items that stop done (receive records them, merge's done step checks them).
const WI = require('./lib/wiringItems.js');

/**
 * The first step of `ravenseat receive` (the usage is at the top of queue.mjs): the task, the stops, and the delivery as
 * the track left it. Returns what the later steps read.
 */
export function receiveIntake() {
  // ---- A track has delivered -> review + review package as plain files + reviewer prompts ----
  const id = positional(1, ['--scratchpad', '--result', '--done-cwd'])[0];
  if (!id) die('receive <id> [--scratchpad <folder>] [--result "RESULT ..."] [--force] [--all]');
  const o0 = read().tasks.find((x) => x.id === id);
  if (!o0) die(`Unknown task ${id}`);
  if (!['running', 'picked', 'review'].includes(o0.status))
    die(`${id} has status ${o0.status}; receive applies to running, picked or review.`);
  // Before any git command and any change: a difference in what runs at the next git command is the owner's to settle.
  stopOnDrift(`${CLI} receive ${id}`);
  // The owner rows the task relies on, confirmed against the owner log (owner decision B2), before anything changes.
  stopOnOwnerRows(id, `${CLI} receive ${id} again`);
  const scratch = scratchpadFor(o0.scratchpad ?? null);
  if (!scratch) die('receive needs --scratchpad <folder> (or QUEUE_SCRATCHPAD).');
  const branch = o0.branch ?? branchFor(id);
  const gi = branchInfo(branch);
  if (!gi.exists) die(`Branch ${branch} does not exist.`);
  /** Prints the track's owner questions. They would otherwise stay in a file nobody opens. */
  const printQuestion = (asked) => {
    console.log(`Owner question(s) from the track (${asked.count}), also in ${CLI} decide:`);
    console.log(asked.text ?? "  (no \"Owner questions\" section: read the track's report and answer)");
  };
  /**
   * PS-4 (lib/startChecks.js): ownerQuestions=<n> against the items in the report's owner question section. A mismatch
   * is one NOTE line, never a stop; planChecks.ownerQuestionCount false turns it off.
   */
  const ownerQuestionNote = (v) => {
    const note = require('./lib/startChecks.js').ownerQuestionNote({ ...v, config: CONFIG });
    if (note) console.log(note);
  };
  /** The card in ravenseat decide. The report's path goes with it, since the note holds only the start of the question. */
  // Section 6.3 of plans/autonomi-nivaa-utredning.md: ownerQuestions=<n> against the questions the track registered with
  // `ravenseat question`. What is beyond them was free text, so the card is marked "Not filled in by the agent" and one
  // NOTE line is printed. Never a refusal: the question still reaches the owner, only without its card fields.
  const openQuestion = (queue, o, asked, file) => {
    const reg = L.registeredQuestions(queue, o.id, asked.count);
    const note = L.registeredQuestionNote(o.id, reg, CLI);
    if (note) console.log(note);
    const opened = L.openBlock(o, 'track-question', { note: asked.note });
    if (opened.block && file) opened.block.file = file;
    if (opened.block) {
      opened.block.unfilled = reg.unfilled;
      opened.block.registered = reg.registered;
    }
  };
  if (gi.commits === 0 && !a.includes('--force')) {
    // No commits is no delivery, but the track may have said why: a mission it could not do without the owner's answer.
    // What it said is read first, so the answer does not stay in a file while the task looks like it is running.
    const reply = lastTrackReply(taskAgents(o0));
    const found = trackReport(o0, [scratch, o0.scratchpad ?? null]);
    const file = found.report?.path && fs.existsSync(found.report.path) ? found.report.path : null;
    // A report from before the last ravenseat resume has been dealt with (resume saves report_seen).
    const fresh = !file || found.report.mtimeMs > Number(o0.report_seen ?? 0);
    const reportText = file && fresh ? fs.readFileSync(file, 'utf8') : null;
    const said = fresh ? (L.parseResult(val('--result')) ?? L.parseResult(reply) ?? L.parseResult(reportText)) : null;
    if (said) console.log(`The track says: ${said.line}`);
    const asked = L.trackQuestion({ result: said, reportText, reply });
    ownerQuestionNote({ result: said, reportText, reply });
    if (asked) {
      printQuestion(asked);
      edit((queue) => {
        const o = queue.tasks.find((x) => x.id === id);
        o.result = said;
        openQuestion(queue, o, asked, file);
      });
    }
    die(
      `Nothing to receive: ${branch} has no commits ahead of ${BASE}, and ${id} stays ${o0.status}.\n` +
        'The agent may not have committed: look for uncommitted work in its worktree (git worktree list).\n' +
        `Next: ${CLI} resume ${id} --reason context${asked ? ' --answer "<text>"' : ''} for a new round, ${CLI} set ${id} done if the work is already on ${BASE}, ` +
        `or ${CLI} set ${id} cancelled --remark "<why>". --force makes an empty package anyway.`,
    );
  }
  const scope = `${BASE}...${branch}`;
  const folder = path.join(scratch, `rev-${id}`);
  // The package is made again every time (a new round after a fix replaces the old one). Only files we made ourselves.
  fs.rmSync(folder, { recursive: true, force: true });
  fs.mkdirSync(path.join(folder, 'files'), { recursive: true });
  // The whole track diff. WHICH reviewers run, the DB objects, the test-weakening check and the ownership notes always
  // use it, also when the package itself is a delta (below).
  const stat = gitLarge(['diff', '--stat', scope]) ?? '';
  const diff = gitLarge(['diff', scope]) ?? '';
  const { copy, skipped } = L.packageFiles(
    gitLarge(['diff', '--name-status', '--no-renames', scope]),
    gitLarge(['diff', '--numstat', '--no-renames', scope]),
  );
  // The track's answer (from the transcript), track-result.md and handover.md from the track folder in the scratchpad.
  const agents = taskAgents(o0);
  // The attempt (lib/logic/attempt.js): its rows are read here, before the lock and after taskAgents wrote any killed
  // agent's row. Every way out of receive below records on it, so the fix round a red check starts is a new attempt.
  const attemptLog = attemptRows([o0]);
  const trackReply = lastTrackReply(agents);
  const files = {};
  if (trackReply) {
    // Agent text: redacted before it is stored, withheld if that fails (lib/storeText.js, lib/sinkRegister.js).
    fs.writeFileSync(path.join(folder, 'trackReply.md'), require('./lib/storeText.js').storeText(trackReply));
    files.trackReply = true;
  }
  // Adoption: the newest report in the orchestrator's and the task's scratchpad, also from a fix round (<id>-r<N>/).
  const trackFound = trackReport(o0, [scratch, o0.scratchpad ?? null]);
  for (const [k, measure, n] of [
    [trackFound.report?.path, 'trackReport.md', 'report'],
    [trackFound.handover?.path, 'handover.md', 'handover'],
  ]) {
    if (k && fs.existsSync(k)) {
      fs.copyFileSync(k, path.join(folder, measure));
      files[n] = true;
    }
  }
  const reportText = files.report
    ? fs.readFileSync(path.join(folder, 'trackReport.md'), 'utf8')
    : null;
  const result =
    L.parseResult(val('--result')) ??
    L.parseResult(trackReply) ??
    L.parseResult(reportText);
  const asked = L.trackQuestion({ result, reportText, reply: trackReply });
  // Owner claims without this mission's owner mark (lib/ownerMark.js, roadmap 0æ N4): a line and a package section.
  const OM = require('./lib/ownerMark.js');
  // A cloud mission is built elsewhere and has no mark, so it is not checked.
  const suspicious = OM.suspicious([reportText, trackReply], o0?.cloud ? null : missionMark(o0));
  for (const l of OM.receiveLines(id, suspicious)) console.log(l);
  if (asked) printQuestion(asked);
  ownerQuestionNote({ result, reportText, reply: trackReply });
  // The choices the track made itself: shown here and in the package so the owner reads them before the merge.
  const assumptions = L.assumptionSection(reportText) ?? L.assumptionSection(trackReply);
  if (assumptions)
    console.log(
      `Assumptions ${id}'s track made (read them before you merge; to change one: ${CLI} resume ${id} --reason fix --answer "<text>"):\n${assumptions}`,
    );
  // The owner's own Claude setup: did a listed entry in ~/.claude change while the track ran (lib/claudeFingerprint.js)?
  if (o0.claude_fp && CONFIG?.claudeFingerprint !== false) {
    const CFP = require('./lib/claudeFingerprint.js');
    const changes = CFP.compare(o0.claude_fp, CFP.fingerprint({ dir: o0.claude_fp.dir }));
    const others = read().tasks.filter((x) => x.id !== id && ['running', 'review', 'picked'].includes(x.status)).map((x) => x.id);
    for (const l of CFP.warningLines(id, changes, { dir: o0.claude_fp.dir, others })) console.log(l);
  }
  // The main tree's control files (lib/controlFiles.js): a change no commit explains while the track ran. Warns only.
  if (o0.control_fp && CONFIG?.controlFiles?.fingerprint !== false) {
    const others = read().tasks.filter((x) => x.id !== id && ['running', 'review', 'picked'].includes(x.status)).map((x) => x.id);
    for (const l of controlFileLines(id, o0.control_fp, others)) console.log(l);
  }
  // A weakened setting no setting-weakened row explains: queue.config.json was edited outside the CLI (lib/guardLog.js).
  for (const l of outsideCliLines(`receive ${id}`)) console.log(l);
  return {
    id, o0, scratch, branch, gi, openQuestion, scope, folder, stat, diff, copy, skipped, attemptLog, trackReply, files,
    trackFound, reportText, result, asked, suspicious, assumptions,
  };
}

/**
 * The review package of `ravenseat receive`, after the gate and done command step: the checks' lines, the package files
 * and the reviewer prompts. Returns what the record and the closing lines read.
 */
export function receivePackage({
  id, o0, scratch, branch, scope, folder, stat, diff, copy, skipped, trackReply, files, reportText, result, suspicious,
  assumptions, gateCheck, doneCheck,
}) {
  const OM = require('./lib/ownerMark.js');
  // Nothing automatic looked at this delivery (lib/controls.js). A warning, never a stop; a PARTIAL track runs nothing anyway.
  if (result?.status !== 'PARTIAL' && !CONTROLS.commandsOf(CONFIG.gates?.quick).length && !doneCheck)
    console.log(CONTROLS.noChecksLine(id, { quiet: GUIDANCE.isQuiet(read()) }));
  // Green, but no tests ran (lib/zeroTests.js, GS-1): one NOTE line for the quick gate and the done command together.
  // A caveat, never a stop; the package gets a section and the board a small badge.
  const ZT = require('./lib/zeroTests.js');
  const zeroTests = ZT.ofTask({ gate_check: gateCheck.record, done_check: doneCheck?.record });
  const zeroLine = ZT.receiveLine(id, zeroTests);
  if (zeroLine) console.log(zeroLine);
  // The secret scan of the track's own commits (H5): a hit is recorded in the edit below (block secret-found), and the
  // merge stops on it. Said here, where the receive output is read.
  const secretScan = receiveSecretScan(branch);
  for (const l of secretScanLines(id, secretScan)) console.log(l);
  // QA evidence: the EVIDENCE line (track-result.md first, otherwise the answer) and the warning when a task that needs it
  // (config().qa.evidenceLabels) has none. A warning, not a stop.
  const evidenceRead = L.parseEvidence(reportText) ?? L.parseEvidence(trackReply);
  const evidenceWarn = L.evidenceWarning({
    o: o0,
    evidence: evidenceRead?.evidence ?? null,
    evidenceError: evidenceRead?.error ?? null,
  });
  // The mission (prompt-<id>.md) goes into the package too: reviewer-gap compares the delivery with it, and the helper
  // condition minMissionItems counts its numbered points.
  const missionFile = path.join(scratch, `prompt-${id}.md`);
  let missionText = null;
  if (fs.existsSync(missionFile)) {
    missionText = fs.readFileSync(missionFile, 'utf8');
    fs.writeFileSync(path.join(folder, 'mission.md'), missionText);
    files.mission = true;
  }
  // THE reviewers for the task (lib/queueHelpers.js): the fixed ones for the class and the helpers that are on and hit
  // (class, label, changed paths, plan, mission points). A custom helper only when its agent file is the one the owner
  // approved (sha256, lib/helperFiles.js); one that changed since is turned off here and left out.
  const HF = require('./lib/helperFiles.js');
  const checked = HF.verifiedSetup(CONFIG, read(), MAIN_TREE);
  const stale = HELP.switchesToTurnOff(checked.setup);
  if (stale.length) {
    edit((queue) => {
      for (const s of stale) queue.helpers[s.name] = { ...queue.helpers[s.name], enabled: false };
    });
    for (const s of stale)
      console.log(`Helper agent ${s.name}: turned off and left out (${HELP.REVIEW_TEXT[s.review]}; ravenseat helpers scan ${s.name}).`);
  }
  const reviewerList = L.reviewersForTask(o0, {
    queue: read(),
    changedPaths: [...copy, ...skipped.map((h) => h.path)],
    missionText,
    hashes: checked.hashes,
    missingControls: CONTROLS.missing(CONFIG, MAIN_TREE),
    // The review signals (lib/reviewSignals.js) read what the whole track diff adds.
    diff,
  });
  const reviewers = reviewerList.map((x) => x.type);
  // The hit rate per signal is measured from this record (the latest receive of the task): `ravenseat helpers`.
  const signalNames = require('./lib/reviewSignals.js')
    .signalHits({ config: CONFIG, changedPaths: [...copy, ...skipped.map((h) => h.path)], diff })
    .map((h) => h.name);
  edit((queue) => {
    const t = (queue.tasks ?? []).find((x) => x.id === id);
    if (t) t.review_signals = { at: new Date().toISOString(), hits: signalNames };
  });
  // ---- The package's diff and files (lib/deltaReview.js): after a fix round, only the commits since the last review,
  // with the findings the fix round got and the whole diff as a context file. Otherwise the whole diff, as before.
  const DR = require('./lib/deltaReview.js');
  const reviewTip = git(['rev-parse', '--verify', `refs/heads/${branch}`]);
  const reviewBase = git(['merge-base', BASE, branch]) || null;
  const picked = DR.deltaScope({
    o: o0,
    tip: reviewTip,
    mergeBase: reviewBase,
    isAncestor: (x, y) => git(['merge-base', '--is-ancestor', x, y]) != null,
    reviewers,
    full: a.includes('--full-review'),
    partial: result?.status === 'PARTIAL',
  });
  const delta = picked.delta;
  const range = delta ? `${delta.from}..${delta.to}` : scope;
  const shown = delta
    ? L.packageFiles(
        gitLarge(['diff', '--name-status', '--no-renames', range]),
        gitLarge(['diff', '--numstat', '--no-renames', range]),
      )
    : { copy, skipped };
  const packageStat = delta ? (gitLarge(['diff', '--stat', range]) ?? '') : stat;
  fs.writeFileSync(path.join(folder, 'diff.patch'), delta ? (gitLarge(['diff', range]) ?? '') : diff);
  if (delta) {
    fs.writeFileSync(path.join(folder, 'diff-full.patch'), diff);
    if (delta.findings && fs.existsSync(delta.findings)) {
      fs.copyFileSync(delta.findings, path.join(folder, 'previous-findings.md'));
      files.previousFindings = true;
    }
  }
  const copied = [];
  // Reads at a commit that git failed (lib/gitShow.js): a bad object or a time-out is never read as a missing file. One
  // WARN line below names them, so the owner knows a check ran without that file.
  const readErrors = [];
  const noteReadError = (e) => {
    if (e?.name !== 'GitReadError') throw e;
    if (readErrors.length < 20) readErrors.push(e);
  };
  for (const filePath of shown.copy) {
    let content = null;
    try {
      content = gitShowAt(branch, filePath, { buffer: true });
    } catch (e) {
      noteReadError(e);
      shown.skipped.push({ path: filePath, reason: `git could not read it from the branch (${e.reason}), not a missing file` });
      continue;
    }
    if (content == null) {
      shown.skipped.push({ path: filePath, reason: 'not in the branch tip' });
      continue;
    }
    const templateFile = path.join(folder, 'files', ...filePath.split('/'));
    fs.mkdirSync(path.dirname(templateFile), { recursive: true });
    fs.writeFileSync(templateFile, content);
    copied.push(filePath);
  }
  const customReviewers = new Set(reviewerList.filter((x) => x.custom).map((x) => x.type));
  const dbObjects = L.dbObjectsFromDiff(diff, { folder: MIGR.folder });
  // Test weakening (lib/testWeakening.js): deleted test files and added skip/focus markers. A warning, never a stop.
  const TW = require('./lib/testWeakening.js');
  // The file text at both ends, for a test file emptied of assertions (red team RT-08).
  const weakBase = (git(['merge-base', BASE, branch]) ?? '').trim();
  const weak =
    CONFIG.testWeakening?.enabled === false
      ? null
      : TW.assess(diff, CONFIG.testWeakening, {
          // A git failure throws: testWeakening skips that file (no text, no warning), and the WARN line names it.
          read: (side, p) => {
            if (side === 'base' && !weakBase) return null;
            try {
              return gitShowAt(side === 'base' ? weakBase : branch, p);
            } catch (e) {
              noteReadError(e);
              throw e;
            }
          },
        });
  const weakLine = weak && TW.summaryLine(weak);
  if (weakLine) console.log(weakLine);
  // Decision signals (lib/decisionSignals.js, phase 1 of plans/autonomi-nivaa-utredning.md): a new package, a migration or
  // schema file, deleted files, unstated choices, each marked "not asked" without a matching owner question. Read from
  // the diff already here (no tokens), one SIGNALS line, stored on the task for "Decided for you". Never a stop.
  // A PARTIAL delivery is unfinished, so it gets none. decisionSignals.enabled false: nothing.
  const DSIG = require('./lib/decisionSignals.js');
  const signalRecord =
    CONFIG.decisionSignals?.enabled === false || result?.status === 'PARTIAL'
      ? null
      : DSIG.record(
          DSIG.detect({
            diff,
            migrations: MIGR,
            testPaths: CONFIG.testWeakening?.testPaths ?? [],
            // A git failure reads as "cannot be told" (null: the item says "<file> changed"), and the WARN line names it.
            read: (side, p) => {
              if (side === 'base' && !weakBase) return null;
              try {
                return gitShowAt(side === 'base' ? weakBase : branch, p);
              } catch (e) {
                noteReadError(e);
                return null;
              }
            },
            setup: CONFIG.decisionSignals ?? {},
            report: {
              assumptions,
              questionText: L.ownerQuestionSection(reportText) ?? L.ownerQuestionSection(trackReply),
              ownerQuestions: result?.ownerQuestions ?? null,
            },
          }),
          { tip: git(['rev-parse', '-q', '--verify', `refs/heads/${branch}`]), at: new Date().toISOString() },
        );
  const signalLine = DSIG.receiveLine(id, signalRecord);
  if (signalLine) console.log(signalLine);
  if (readErrors.length)
    console.log(
      `WARN git could not read ${readErrors.length} file(s) at a commit, so the checks above ran without them (an error, ` +
        `not a missing file): ${readErrors.map((e) => `${e.path} (${e.reason})`).join('; ')}. Check with \`git show <commit>:<path>\` ` +
        'and receive again.',
    );
  // One time log row per delivery (a second receive of the same tip adds none), read before the edit below replaces it.
  const signalNew = signalRecord && DSIG.isNewDelivery(o0.decision_signals ?? null, signalRecord);
  // Door and blast radius (lib/mergeDanger.js, MS-1): the track's two lines, from the report, else the reply. One DOOR
  // line, a section in the package for the reviewer, merge_danger on the task for Decisions and the PR body. Written by
  // the agent, so NEVER a guard: missing or malformed is "not stated", nothing is blocked or approved by it. A PARTIAL
  // delivery is unfinished, so it gets none. mergeDanger.show off (lib/doorShow.js): none either, so the line, the
  // section and the record are all left out (and an earlier record is removed below).
  const MDG = require('./lib/mergeDanger.js');
  const doorOn = require('./lib/doorShow.js').on(CONFIG);
  const dangerValues = result?.status === 'PARTIAL' || !doorOn ? null : MDG.fromTrack({ report: reportText, reply: trackReply });
  if (dangerValues) console.log(MDG.receiveLine(id, dangerValues));
  // Red on base (lib/redOnBase.js): do the new tests fail without the change? Off unless gates.redOnBase is set; a
  // PARTIAL track is unfinished, so not for it. A warning, never a stop.
  const RB = require('./lib/redOnBase.js');
  const redBase = result?.status === 'PARTIAL' ? null : redOnBaseCheck(o0, { branch });
  // A fix needs a red test first (lib/fixTests.js): is this task a fix (its fields, or a GATE line in the report)? The
  // kind goes on the red on base record, so merge's strict mode knows a GATE-line fix without reading the report again.
  const FT = require('./lib/fixTests.js');
  const KBG = require('./lib/knownBugGate.js');
  const fixKind = FT.fixKind(o0, { gateLine: !!(KBG.parseGate(reportText) ?? KBG.parseGate(trackReply)) });
  if (redBase && fixKind) redBase.fix = fixKind;
  // One line, not two: for a fix without a proven red test, the fix line says what the red on base line would, and more.
  // gates.fixWithoutTestWarning false leaves only the plain red on base line (FT.fixLineOn).
  const fixLine =
    result?.status === 'PARTIAL' || !FT.fixLineOn(CONFIG) ? null : FT.receiveLine(id, { fix: fixKind, task: o0, record: redBase, strict: FT.strictOn(CONFIG), cli: CLI });
  const redBaseLine = fixLine ?? RB.summaryLine(id, redBase);
  if (redBaseLine) console.log(redBaseLine);
  // Files another active task owns (lib/mergeGuard.js foreignOwners): the merge will stop on them, so say it now, while a
  // fix round is still cheap. A note, never a stop here.
  const changedNames = String(gitLarge(['diff', '--name-only', '--no-renames', scope]) ?? '').split(/\r?\n/).filter(Boolean);
  const foreign = require('./lib/mergeGuard.js').foreignOwners(changedNames, o0, read().tasks ?? []);
  // Shared config (hotspots, lib/hotspots.js) the task has not agreed: the merge stops on it too.
  const HS = require('./lib/hotspots.js');
  const hotChanged = HS.unagreed(changedNames, o0, HS.hotspotsOf(CONFIG));
  if (hotChanged.length)
    console.log(
      `HOTSPOT: ${id} changes shared config it has not agreed (hotspot_patch): ${hotChanged.slice(0, 10).join(', ')}. ` +
        "The merge stops on it. A fix round that leaves it alone and puts a wiring spec in the report, or add it to the task's hotspot_patch (--by owner).",
    );
  if (foreign.length)
    console.log(
      `OWNERSHIP: ${id} changes ${foreign.length} file(s) that another active task owns: ` +
        `${foreign.slice(0, 10).map((f) => `${f.path} (${f.owner}${f.via === 'shared_patch' ? ', via shared_patch' : ''})`).join(', ')}${foreign.length > 10 ? ', …' : ''}. ` +
        `The merge stops on them. A fix round that leaves them alone, or merge the owner task first (${CLI} merge --allow-guard overrides, logged).`,
    );
  // The reuse and scope facts (lib/scopeNotes.js, bolk B1 of the scope drift plan): a name the base already defines, a
  // new folder, a second library for the same job, drift in numbers. NOTE lines and a package section, never a stop.
  // M4 of the friction review: each kind of fact is ONE summary line here (the details are in 00-package.md); --all
  // prints the line of each fact. A CATALOG line (an accepted choice broken) asks for something, so it comes first.
  const allNotes = a.includes('--all');
  const scopeFacts = scopeNotesFor(o0, { branch, base: weakBase, diff, changedNames, all: allNotes });
  // The check rules of the design choices (lib/catalogChecks.js, bolk B6): a CATALOG line for an accepted choice an added
  // line breaks, a NOTE for a proposed one, and the rules in the package after the scope facts. Never a stop here.
  const CC = require('./lib/catalogChecks.js');
  const catalogCheck = catalogRulesFor(id, diff);
  const catalogLines = CC.receiveLines(catalogCheck.result, { id, cli: CLI, all: allNotes });
  const enforced = catalogLines.filter((l) => !l.startsWith('NOTE '));
  for (const l of [...enforced, ...scopeFacts.lines, ...catalogCheck.lines, ...catalogLines.filter((l) => l.startsWith('NOTE '))]) console.log(l);
  // "Not building" (roadmap 0f, notBuilding.match): the proposals this track added (added_by the track, a fix round
  // too) that read like an entry the owner chose not to build get one INFO line each. Advice only, never a stop.
  const fromTrack = (read().tasks ?? []).filter(
    (x) => x.status === 'proposed' && String(x.added_by ?? '').replace(/-(?:r|round)\d+$/i, '') === id,
  );
  for (const l of notBuildingLines(fromTrack.map((x) => ({ id: x.id, text: [x.title, x.description].filter(Boolean).join(' ') })))) console.log(l);
  const ruleSection = CC.packageSection(catalogCheck.result);
  fs.writeFileSync(
    path.join(folder, '00-package.md'),
    L.reviewPackageIndex({
      o: o0,
      branch,
      stat: packageStat,
      dbObjects,
      copied,
      skipped: shown.skipped,
      result,
      files,
      base: BASE,
      migrFolder: MIGR.folder,
      reviewers: reviewerList,
      testWeakening: weak ? TW.packageSection(weak) : null,
      redOnBase: redBase ? RB.packageSection(redBase) : null,
      // The flaky gate commands (lib/trackFlaky.js packageSection); [] when none was flaky.
      flaky: require('./lib/trackFlaky.js').packageSection(gateCheck.record),
      // Green, but no tests ran (lib/zeroTests.js packageSection); [] when every green command ran tests.
      zeroTests: ZT.packageSection(zeroTests),
      suspicious: OM.packageSection(suspicious),
      // No rule hit: the section is exactly as before (the package stays byte for byte without a catalog).
      scopeNotes: ruleSection ? [...(scopeFacts.section ?? []), ...ruleSection] : scopeFacts.section,
      // The part of the project catalog that meets the task's files (lib/catalogExcerpt.js, bolk B4), read from the main
      // tree as the mission had it: the reviewer checks the delivery against it (reviewer.md, reviewer-gap.md). With
      // catalog.index on (bolk B5) the code index is refreshed here and the names the delivery defines go along, for the
      // near names (V1b); off, the diff is not read again.
      catalog:
        require('./lib/catalogExcerpt.js').forTask(o0, {
          which: 'review',
          root: MAIN_TREE,
          newNames: require('./lib/catalog.js').setupOf(CONFIG).index ? reviewNewNames(diff) : null,
        })?.lines ?? null,
      assumptions,
      mergeDanger: dangerValues ? MDG.packageSection(dangerValues) : null,
      delta,
      deltaSection: delta ? DR.packageSection(delta, { previousFindings: !!files.previousFindings }) : null,
    }),
  );
  // The wiring spec (lib/wiringItems.js): the WIRE lines in track-result.md, the answer when the report has none. Untrusted
  // data: parsed into file + one line of text, never run. Not for a PARTIAL delivery, which is not merged.
  const wiringRead = (() => {
    const fromReport = WI.parseWiring(reportText);
    return fromReport.lines ? { ...fromReport, source: 'report' } : { ...WI.parseWiring(trackReply), source: 'reply' };
  })();
  const prompts = reviewers.map((type) => {
    const file = path.join(folder, `reviewer-${type}.md`);
    fs.writeFileSync(file, L.reviewerPrompt({ o: o0, type, folder, base: BASE, delta, door: doorOn }) + '\n');
    return { type, file };
  });
  return {
    secretScan, evidenceRead, evidenceWarn, reviewerList, reviewers, reviewTip, reviewBase, picked, delta, copied,
    customReviewers, dbObjects, weak, signalRecord, signalNew, dangerValues, redBase, fixKind, catalogCheck, wiringRead,
    prompts,
  };
}
