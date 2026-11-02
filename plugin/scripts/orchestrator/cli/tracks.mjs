// =============================================================
// cli/tracks.mjs: the shared helpers for running tracks: time log, migration numbers, load, usage, transcripts and measurements.
//
// logTime (log-time.mjs), the migration number blocks (highestMigr, takenForMigr), the load measurement and slot line,
// the daily usage and cost estimate state, the agent transcripts and the measured cost of a task, the scratchpad and
// the deliveries, the tracks without an agent or without a sign of life, and the start bookkeeping (markStarted,
// logStart, makeTrackBlocks). Several command modules need them (show, state, next, start, fill, receive, merge,
// set, cost, cloud), so they live here and not in one of them.
//
// Why a module: queue.mjs was one file of about 6,300 lines. It is now a thin entry point (the usage comment and the
// dispatch on the command word) plus the modules in cli/. The code was moved as it was: same output, exit codes and files.
//
// Used by: cli/view.mjs, cli/run.mjs, cli/merge.mjs, cli/taskEdit.mjs, cli/tasks.mjs, cli/cost.mjs, cli/cloud.mjs, cli/orchestrator.mjs.
// Tested in: lib/__tests__/queueNoAgent.test.ts, queueSilent.test.ts, queueLoadLimit.test.ts, queueMigrBlock.test.ts, loadSlots.test.ts,
//   contextGuard.test.ts and the other tests that spawn queue.mjs.
// =============================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import {
  branchFor, CE, CONFIG, CQ, die, edit, G, GIT_ROOT, gitRead, HERE, L, LS, MAIN_TREE, MIGR, missionFile, read, require,
  TIME_LOG, TK, val, values,
} from './context.mjs';

export function logTime(id, event, remark) {
  try {
    execFileSync(
      process.execPath,
      [
        path.join(HERE, 'log-time.mjs'),
        'queue',
        id,
        event,
        '--remark',
        remark,
      ],
      {
        stdio: 'ignore',
      },
    );
  } catch {
    /* the time log is an aid; the queue must not stop if it fails */
  }
}
/**
 * The highest migration number in config().migrations.folder (the first group in filePattern), or 0 when the migration flow is
 * off or the folder is missing. Used by init and next-migr.
 */
export function highestMigr(root = MAIN_TREE) {
  if (!MIGR.folder) return 0;
  const dir = path.join(root, MIGR.folder);
  const pattern = new RegExp(MIGR.filePattern ?? String.raw`^(\d+)_.*\.sql$`);
  let max = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const f of fs.readdirSync(dir)) {
    const m = pattern.exec(f);
    if (m && Number.isSafeInteger(Number(m[1]))) max = Math.max(max, Number(m[1]));
  }
  return max;
}
/**
 * The blocks that are taken (queueLogic.takenBlocks): the migration files in the main tree, the blocks of tasks that
 * are not finished, and the blocks in the prompt files (`prompt-*.md`) in the scratchpads of active tasks and in
 * `scratch`. A file that cannot be read is skipped (the error never stops a start). Empty without a migration flow.
 */
export function takenForMigr(queue, { scratch = null, except = null } = {}) {
  if (!MIGR.folder) return [];
  const fileNrs = [];
  try {
    const pattern = new RegExp(MIGR.filePattern ?? '^(\\d+)_.*\\.sql$');
    for (const f of fs.readdirSync(path.join(GIT_ROOT, MIGR.folder))) {
      const m = pattern.exec(f);
      if (m && Number.isSafeInteger(Number(m[1]))) fileNrs.push(Number(m[1]));
    }
  } catch {
    // no migration folder yet: only the queue and the prompt files
  }
  const folders = new Set(
    [scratch, ...queue.tasks.filter((o) => !L.MIGR_FREE_STATUS.has(o.status)).map((o) => o.scratchpad)]
      .filter(Boolean)
      .map((m) => path.resolve(m)),
  );
  const prompts = [];
  for (const m of folders) {
    let names = [];
    try {
      names = fs.readdirSync(m).filter((f) => /^prompt-.+\.md$/.test(f));
    } catch {
      continue;
    }
    for (const n of names) {
      try {
        prompts.push({ name: n, text: fs.readFileSync(path.join(m, n), 'utf8') });
      } catch {
        // locked or gone: skip
      }
    }
  }
  return L.takenBlocks({ tasks: queue.tasks, fileNrs, prompts, except });
}
/** "3450–3459 task A-1, 3460–3469 prompt-B.md" for the blocks a start skipped or a move hit. */
export const blockList = (list) => [...new Set(list.map((h) => `${h.from}–${h.to} ${h.source}`))].join(', ');
/**
 * The load now for the load guard (queueLogic.loadGuard) and the adaptive slots (lib/loadSlots.js): free memory in
 * percent, and CPU busy in percent only when the CPU thresholds are set (a ~200 ms sample). An error in the
 * measurement gives null, and null never stops or limits. QUEUE_LOAD="free=<pct>,cpu=<pct>" replaces it (tests).
 * @returns {{ freeMemoryPct: number|null, cpuPct: number|null }}
 */
export function measureLoad() {
  let cpu = false;
  try {
    cpu = LS.cpuOn(LS.settingsFrom(require('./lib/queueConfig.js').config().loadGuard));
  } catch {
    cpu = false;
  }
  return LS.measure({ cpu });
}
/** One line when the load limits the slots ("LOAD: 2 of 5 slots: free memory 18 % (all slots from 40 %)."), or null. */
export function loadSlotsLine(queue, load) {
  if (!load) return null;
  try {
    const ls = L.loadSlotsFor(queue, load);
    return ls.limited ? `LOAD: ${ls.reason}. Fewer tracks start until the load goes down.` : null;
  } catch {
    return null; // never let the explanation stop a command
  }
}
export const minutes = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 60_000);
/**
 * Today's usage in USD (Norwegian day), only when a dailyBudget is set (otherwise the log is not read). If the log cannot
 * be read, the usage is unknown: that is reported on stderr (the budget guard then cannot kick in), and the number becomes 0.
 */
export function dailyUsageFor(queue) {
  if (queue?.limits?.dailyBudget == null) return undefined;
  try {
    const rows = TK.readRows(fs.readFileSync(TIME_LOG, 'utf8'));
    return TK.dailyUsage(rows, TK.dayFor(new Date().toISOString()));
  } catch (e) {
    console.error(
      `WARNING: could not find the usage in ${TIME_LOG} (${e?.code ?? e?.message}); the budget guard assumes 0 USD today.`,
    );
    return 0;
  }
}
/** The summed calibrated cost estimate (USD) of what selectNext would start now (lib/costEstimate.js). */
export function nextCostUsd(queue, uncommitted, model = CE.costModel(queue)) {
  return L.selectNext(queue, Date.now(), { uncommitted }).reduce(
    (s, v) => s + CE.calibratedCost(queue.tasks.find((o) => o.id === v.id), model).usd,
    0,
  );
}
/**
 * The `costEstimate` field in `state`: the calibrated model per class (window, sample, median USD, factor, measured or
 * model), the tasks that can start now with their estimate, the sum, and the daily budget outlook when a budget is set.
 */
export function costEstimateState(queue, uncommitted, usage) {
  const model = CE.costModel(queue);
  // uncommitted null = a guard stops new starts: nothing would start, so no next list.
  const can = uncommitted == null ? [] : L.selectNext(queue, Date.now(), { uncommitted });
  const next = can.map((v) => {
    const c = CE.calibratedCost(queue.tasks.find((o) => o.id === v.id), model);
    return { id: v.id, class: v.class, estimate_min: v.estimate, usd: c.usd, source: c.source, basis: c.basis };
  });
  const nextUsd = Math.round(next.reduce((s, x) => s + x.usd, 0) * 100) / 100;
  return {
    windowDays: model.windowDays,
    minSample: model.minSample,
    perClass: model.classes,
    next,
    nextUsd,
    budget: CE.budgetOutlook(L.budgetGuard(queue, usage), nextUsd),
  };
}
// ---- The orchestrator's routine as a script and cost per task ---------------------------------------------
// The agent transcripts: ~/.claude/projects/<repo-slug>/<session>/subagents/agent-<agent_id>.jsonl (the same source as
// hook-time.mjs). QUEUE_TRANSCRIPTS overrides (tests).
const TRANSCRIPTS =
  process.env.QUEUE_TRANSCRIPTS ??
  path.join(os.homedir(), '.claude', 'projects', MAIN_TREE.replace(/[^A-Za-z0-9]/g, '-'));
// As in hook-time.mjs: huge transcripts are not analyzed (the time log's last row is used instead).
const MAX_TRANSCRIPT = 300 * 1024 * 1024;
/** The path to the transcript for an agent, or null. */
function findTranscript(agentId) {
  let sessions;
  try {
    sessions = fs.readdirSync(TRANSCRIPTS, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return null;
  }
  for (const d of sessions) {
    const filePath = path.join(TRANSCRIPTS, d.name, 'subagents', `agent-${agentId}.jsonl`);
    if (fs.existsSync(filePath)) return filePath;
  }
  return null;
}
/** The transcript text, or null when the file is missing or too large. */
function readTranscript(filePath) {
  try {
    if (!filePath || fs.statSync(filePath).size > MAX_TRANSCRIPT) return null;
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}
/** The rows in the time log (empty list when it cannot be read). */
export function readTimeLog() {
  try {
    return TK.readRows(fs.readFileSync(TIME_LOG, 'utf8'));
  } catch {
    return [];
  }
}
/**
 * The agents that belonged to the task, with the transcript when it exists: the certain ones from the time log, plus the uncertain ones (unknown
 * track label) when their mission mentions the task id (queueLogic.agentsForTask and mentionsTask).
 */
export function taskAgents(o, to = new Date().toISOString()) {
  const from = o.started ?? o.picked_at ?? o.added_at ?? null;
  // Killed agents first (start row, no done row): their done row makes them part of the task like any other agent.
  recordKilledAgents(o, to);
  const { secure, uncertainOnes } = L.agentsForTask(readTimeLog(), o.id, { from, to });
  const out = [];
  for (const a of [...secure, ...uncertainOnes.map((x) => ({ ...x, uncertain: true }))]) {
    const filePath = findTranscript(a.agent);
    const text = readTranscript(filePath);
    // The reviewer's mission mentions the task only in the path "rev-<id>\reviewer-...", which mentionsTask does not see
    // (the hyphen before the id); timeCost.trackFromText knows the path.
    const firstMessage = text ? L.firstUserMessage(text) : null;
    const mentions =
      firstMessage != null &&
      (L.mentionsTask(firstMessage, o.id) ||
        TK.taskIdFor(TK.trackFromText(firstMessage) ?? '', (x) => x === o.id) === o.id);
    if (a.uncertain && !mentions) continue;
    out.push({ ...a, path: filePath, text });
  }
  return out;
}
// ---- Killed agents (transcript metrics): kept apart to keep merges simple ----
/** The idle threshold for active time (config metrics.idleGapMin, default 5 min), as in hook-time.mjs. */
const idleGapMin = () => CONFIG?.metrics?.idleGapMin ?? TK.IDLE_GAP_MIN;
/**
 * A transcript written this recently may belong to an agent that is still alive (its SubagentStop has not come yet);
 * it is left for the next measurement.
 */
const KILLED_QUIET_MS = 2 * 60_000;
/**
 * Writes a done row with `killed: true` (lib/timeLogRows.js killedDoneRow) for each agent of task `o` that has a start
 * row and no done row: an agent that was stopped, crashed or killed without SubagentStop, whose cost would otherwise be
 * lost. The analysis is of what its transcript holds. The agent belongs to the task when the mission's track label is
 * the task (or a fix round of it) or the mission mentions the task id. Called by taskAgents, so `receive`, `set done`
 * and `cost measure` all run it. A later real done row is cumulative too, so the readers count only its growth.
 * Never throws (the measurement must not stop the command); returns the rows written.
 */
export function recordKilledAgents(o, to = new Date().toISOString()) {
  try {
    const TLR = require('./lib/timeLogRows.js');
    const from = o.started ?? o.picked_at ?? o.added_at ?? null;
    const isId = (x) => x === o.id;
    const rows = [];
    for (const start of TLR.agentsWithoutDone(readTimeLog(), { from })) {
      if (to && Date.parse(start.time) > Date.parse(to)) continue;
      const filePath = findTranscript(start.agent_id);
      if (!filePath) continue;
      if (Date.now() - fs.statSync(filePath).mtimeMs < KILLED_QUIET_MS) continue;
      const text = readTranscript(filePath);
      if (!text) continue;
      const stat = TK.analyzeTranscript(text, { idleGapMin: idleGapMin() });
      const firstMessage = L.firstUserMessage(text);
      const belongs =
        (stat.track && TK.taskIdFor(stat.track, isId) === o.id) ||
        (firstMessage != null && L.mentionsTask(firstMessage, o.id));
      if (belongs) rows.push(TLR.killedDoneRow({ start, stat }));
    }
    if (rows.length) TLR.appendRows(TIME_LOG, rows);
    return rows;
  } catch {
    return []; // error-ignored: a killed agent's row is for measurement only
  }
}
/** The cost of the task (queueLogic.sumCost): the transcript when it exists, otherwise the last row in the time log. */
function measureCost(agents) {
  return L.sumCost(
    agents.map((a) => {
      if (a.text) {
        const t = TK.analyzeTranscript(a.text, { idleGapMin: idleGapMin() });
        // Time spent = active time (idle gaps left out); older analyses without it use the wall time.
        const seconds = t.active_s ?? t.duration_s;
        return {
          agent: a.agent,
          type: a.type,
          tokens: t.tokens,
          model: t.model,
          byModel: t.byModel,
          turns: t.modelTurns,
          minutes: seconds != null ? seconds / 60 : null,
          // The reviewer's FINDINGS numbers per agent (the helper measurement, queueHelpers.helperStatistics).
          findings: L.REVIEWER_TYPES.includes(a.type) ? L.parseFindings(L.lastAnswer(a.text)) : null,
          source: 'transcript',
        };
      }
      return {
        agent: a.agent,
        type: a.type,
        tokens: a.row.tokens,
        model: a.row.model,
        byModel: a.row.byModel ?? null,
        turns: a.row.modelTurns,
        minutes: (a.row.active_s ?? a.row.duration_s) != null ? (a.row.active_s ?? a.row.duration_s) / 60 : null,
        source: 'timeLog',
      };
    }),
  );
}
/** The last answer from the last track agent (track or track-d), or null. */
export function lastTrackReply(agents) {
  const track = agents
    .filter((a) => TK.isBuildAgent(a.type))
    .sort((x, y) => Date.parse(y.row.time) - Date.parse(x.row.time));
  for (const a of track) {
    const s = a.text ? L.lastAnswer(a.text) : null;
    if (s) return s;
  }
  return null;
}
/** Git with a large buffer (the diffs in the review package); null on error. `buffer: true` gives the bytes (git show of a file). */
export function gitLarge(args, { buffer = false } = {}) {
  try {
    return execFileSync('git', args, {
      cwd: GIT_ROOT,
      encoding: buffer ? 'buffer' : 'utf8',
      maxBuffer: 1 << 28,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}
/** The orchestrator's scratchpad: --scratchpad, otherwise QUEUE_SCRATCHPAD, otherwise `reserve` (saved on the task). */
export function scratchpadFor(reserve = null) {
  const s = val('--scratchpad') ?? process.env.QUEUE_SCRATCHPAD ?? reserve;
  return s ? path.resolve(s) : null;
}
// ---- Adoption: deliveries without <task-notification> (a new session has adopted the tracks) ----
/** The scratchpad roots where the track folder can lie: the orchestrator's (--scratchpad/env) and the one saved on the task. */
export const trackRoots = (o) => [scratchpadFor(), o?.scratchpad ?? null].filter(Boolean);
/** Active tasks (running, review; not picked) with a report.md that has not been received (queueLogic.assessDelivery). */
export function findDeliveries(queue) {
  return queue.tasks
    .filter((o) => ['running', 'review'].includes(o.status) && !o.picked_by)
    .map((o) => L.assessDelivery(o, L.findTrackReport(o.id, trackRoots(o)).report))
    .filter(Boolean);
}
/**
 * Prints the delivery lines. With `update` (pulse) report_seen is saved for the new ones under the lock, so the same
 * report is only reported as new once. An error never stops the pulse.
 */
export function deliveryWarning({ update = false } = {}) {
  try {
    const found = findDeliveries(read());
    for (const l of L.deliveryLines(found)) console.log(l);
    const fresh = found.filter((l) => l.new);
    if (update && fresh.length)
      edit((queue) => {
        for (const l of fresh) {
          const o = queue.tasks.find((x) => x.id === l.id);
          if (o) o.report_seen = Math.max(Number(o.report_seen ?? 0), l.mtimeMs);
        }
      });
    return found;
  } catch (e) {
    console.error(`(The delivery check failed: ${e?.message ?? e}; ${CQ} deliveries)`);
    return [];
  }
}
/**
 * Running tracks without an agent (queueLogic.startedWithoutAgent): no worktree has the branch and there is no report.
 * Read-only; `show`, `state` and `orchestrator pulse` use it, so the check also runs after every compaction (the
 * after-compact hook includes `show`). An error never stops the command it is attached to.
 */
export function findWithoutAgent(queue) {
  try {
    const worktreeBranches = new Set(G.readWorktrees(gitRead).map((w) => w.branch).filter(Boolean));
    return L.startedWithoutAgent(queue, {
      worktreeBranches,
      hasReport: (o) => !!L.findTrackReport(o.id, trackRoots(o)).report,
    });
  } catch (e) {
    console.error(`(The agent check failed: ${e?.message ?? e})`);
    return [];
  }
}
/**
 * Silent tracks (queueLogic.silentTracks): running, a worktree has the branch, but no sign of life for limits.silentMin
 * minutes. The last activity is measured by lib/trackActivity.js (commit, track folder, time log and transcript,
 * worktree mtime; it stops at the first fresh source). Read-only, like findWithoutAgent; an error never stops the command.
 */
export function findSilent(queue) {
  try {
    const limitMin = L.silentMinFor(queue);
    if (!(limitMin > 0)) return [];
    const worktrees = G.readWorktrees(gitRead).filter((w) => w.branch);
    const worktreeBranches = new Set(worktrees.map((w) => w.branch));
    const candidates = L.silentCandidates(queue, worktreeBranches);
    if (!candidates.length) return [];
    const ACT = require('./lib/trackActivity.js');
    const now = Date.now();
    const freshMs = now - limitMin * 60_000;
    const agents = ACT.agentsByTask(
      readTimeLog(),
      candidates.map((o) => o.id),
    );
    const lastActivity = {};
    for (const o of candidates) {
      lastActivity[o.id] = ACT.lastActivity({
        branch: o.branch,
        worktree: worktrees.find((w) => w.branch === o.branch)?.path ?? null,
        trackDirs: trackRoots(o).map((r) => path.join(r, o.id)),
        agents: agents.get(o.id) ?? null,
        findTranscript,
        git: gitRead,
        freshMs,
      }).ms;
    }
    return L.silentTracks(queue, {
      worktreeBranches,
      lastActivity,
      hasReport: (o) => !!L.findTrackReport(o.id, trackRoots(o)).report,
      now,
      limitMin,
    });
  } catch (e) {
    console.error(`(The silence check failed: ${e?.message ?? e})`);
    return [];
  }
}
/** `merge` stopped: open the blocker reason on the task (queueLogic.openBlock). Never stops the merge's own output. */
export function mergeBlock(id, code, note) {
  try {
    edit((queue) => {
      const o = queue.tasks.find((x) => x.id === id);
      if (o) L.openBlock(o, code, { note });
      return null;
    });
    console.log(`Blocker ${code} opened on ${id} (cq blockers; the next successful merge closes it).`);
  } catch (e) {
    console.error(`(Could not record the blocker: ${e?.message ?? e})`);
  }
}
/** The fields `start` and `fill` set (under the lock): status, branch and, if any, migration block. */
export function markStarted(queue, o, { agent = null, head = null, scratchpad = null } = {}) {
  // Past blocks that are already taken (a file, a task that is not finished, an active prompt file).
  const t = L.assignStartBlock(queue, o, takenForMigr(queue, { scratch: scratchpad, except: o.id }), MIGR);
  if (t.skipped.length) console.error(`${o.id}: skipped taken blocks (${blockList(t.skipped)})`);
  o.status = 'running';
  o.started = new Date().toISOString();
  o.branch = branchFor(o.id);
  o.agent = agent ?? o.agent ?? null;
  o.migr_block = t.block;
  // HEAD on baseBranch at start (--wave-base for merge-track) and the scratchpad (receive finds the report there).
  if (head) o.head_start = head;
  if (scratchpad) o.scratchpad = scratchpad;
  return o;
}
/** The time log row for a start (the same for start and fill). */
export function logStart(r) {
  logTime(
    r.id,
    'start',
    `class=${r.class} weight=${L.WEIGHT[r.class]} estimate=${L.estimate(r)} migr=${r.migr_block ?? 'none'} domain=${r.domain}`,
  );
}
/**
 * The track blocks (make-mission.mjs format) for running or picked tasks, with the warning about changes outside
 * the queue. Shared by `trackFile` and `fill`.
 */
export function makeTrackBlocks(queue, idList) {
  // Have the owned files changed outside the queue since the task was added? Then the track block gets a warning, so the track
  // reads the diff before it builds on an outdated mission.
  const notices = G.externalForTasks(
    gitRead,
    idList
      .map((id) => queue.tasks.find((x) => x.id === id))
      .filter((o) => o && (o.status === 'running' || o.status === 'picked')),
  );
  const blocks = idList.map((id) => {
    const o = queue.tasks.find((x) => x.id === id);
    if (!o) die(`Unknown task ${id}`);
    if (o.status !== 'running' && o.status !== 'picked')
      die(
        `${id} is not started or picked (run \`start ${id}\` or \`pick ${id} --by ...\` first)`,
      );
    // The mission files (<dataFolder>/mission/) are gitignored and only exist in the main tree; someone who has picked the
    // task often runs this from their own worktree.
    const sourcePath = missionFile(o);
    const text = sourcePath ? fs.readFileSync(sourcePath, 'utf8') : o.mission;
    const block =
      o.migr_block ??
      (MIGR.folder
        ? 'none (the track must not have migrations; if it needs them, ask the orchestrator)'
        : 'none (the project has no migration flow)');
    // The block itself (ownership, the warning, owner answer and the mission) is shared with cloud-package.
    return [
      `=====${o.id}=====`,
      `TITLE: TRACK ${o.id} (${o.title})`,
      `BLOCK: ${block}`,
      `BRANCH: ${o.branch}`,
      '',
      L.trackBlock(o, queue, { text, warning: notices.get(o.id)?.warning ?? null }),
    ].join('\n');
  });
  const withWarning = [...notices].filter(([, v]) => v.warning).map(([id]) => id);
  return { blocks, withWarning };
}
/**
 * The measurement at `set done` and `cost measure`: the cost, the findings (the reviewers' FINDINGS lines, or --findings) and
 * the RESULT line (when it was not saved by `receive`; --result overrides).
 */
export function measureTask(o) {
  const agents = taskAgents(o);
  const cost = measureCost(agents);
  const findingsFlag = values('--findings');
  const findings = findingsFlag.length
    ? L.batchFindings(findingsFlag.map((f) => L.parseFindings(f)))
    : L.batchFindings(
        agents
          .filter((x) => L.REVIEWER_TYPES.includes(x.type) && x.text)
          .map((x) => L.parseFindings(L.lastAnswer(x.text))),
      );
  const resultText = val('--result') ?? (o.result ? null : lastTrackReply(agents));
  return { cost, findings, result: resultText ? L.parseResult(resultText) : null };
}
/**
 * The reviewers' FINDINGS lines for the task (the last answer in each reviewer transcript), for `--findings` when `merge`
 * calls `set done`. Empty list when no reviewer has a FINDINGS line (the field is then left out, without error).
 */
export function reviewerFindingsLines(o) {
  return taskAgents(o)
    .filter((x) => L.REVIEWER_TYPES.includes(x.type) && x.text)
    .map((x) => L.parseFindings(L.lastAnswer(x.text)))
    .filter(Boolean)
    .map((f) => f.line);
}
export function saveMeasurement(o, m) {
  o.cost = m.cost;
  if (m.findings) o.findings = m.findings;
  if (m.result) o.result = m.result;
}
/** "Cost X: $12.3 (3 agent(s), 25.1 mill. tokens, 140 turns) · findings H=0 M=1 L=2 (1 report(s))". */
export function measurementLine(o) {
  const k = o.cost;
  const mill = (k.tokens.sum / 1e6).toFixed(1);
  return (
    `Cost ${o.id}: $${k.usd} (${k.agents.length} agent(s), ${mill} mill. tokens, ${k.turns} turns)` +
    (o.findings
      ? ` · findings H=${o.findings.H} M=${o.findings.M} L=${o.findings.L} (${o.findings.reports} report(s))`
      : ' · no FINDINGS line found') +
    (o.result ? ` · RESULT ${o.result.status ?? '?'}` : '')
  );
}
/** "7d", "24h", "90m" or a date/ISO time -> ISO time; null when nothing is given. */
export function sinceTime(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d+)\s*([dhm])$/i);
  if (m) {
    const ms = { d: 86_400_000, h: 3_600_000, m: 60_000 }[m[2].toLowerCase()];
    return new Date(Date.now() - Number(m[1]) * ms).toISOString();
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) die(`Unknown time "${s}" (use e.g. 7d, 24h or 2026-10-01).`);
  return new Date(t).toISOString();
}
