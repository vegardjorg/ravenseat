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
  branchFor, CE, CONFIG, CLI, die, edit, G, GIT_ROOT, gitRead, HERE, L, LS, MAIN_TREE, MIGR, missionFile, read, require,
  TIME_LOG, TK, val, values,
} from './context.mjs';

const AT = require('./lib/logic/attempt.js');
const CL = require('./lib/clients/index.js');

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
    // Only today matters: the archives that ended before the last two days (and the margin) are not read.
    const rows = readTimeLogOrThrow({ from: Date.now() - 2 * 86_400_000 });
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
export function findTranscript(agentId) {
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
/**
 * The rows in the time log, across its monthly archives (lib/timeLogArchive.js, owner decision B5). `from` (ms or ISO)
 * is the start of the caller's window: archives that ended well before it are not read. Throws when there is no log.
 */
export function readTimeLogOrThrow({ from = null } = {}) {
  return TK.readRows(require('./lib/timeLogArchive.js').readText(TIME_LOG, { from }));
}
/** The rows in the time log (empty list when it cannot be read); `from` as in readTimeLogOrThrow. */
export function readTimeLog({ from = null } = {}) {
  try {
    return readTimeLogOrThrow({ from });
  } catch {
    return [];
  }
}
/** The window for the rows of active tasks' agents (lib/timeLogArchive.js activeFrom). */
export const activeFrom = (tasks) => require('./lib/timeLogArchive.js').activeFrom(tasks);
/**
 * The agents that belonged to the task, with the transcript when it exists: the certain ones from the time log, plus the uncertain ones (unknown
 * track label) when their mission mentions the task id (queueLogic.agentsForTask and mentionsTask).
 */
export function taskAgents(o, to = new Date().toISOString()) {
  const from = o.started ?? o.picked_at ?? o.added_at ?? null;
  // Killed agents first (start row, no done row): their done row makes them part of the task like any other agent.
  recordKilledAgents(o, to);
  const { secure, uncertainOnes } = L.agentsForTask(readTimeLog({ from }), o.id, { from, to });
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
    for (const start of TLR.agentsWithoutDone(readTimeLog({ from }), { from })) {
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
          thinking_tokens: t.thinking_tokens,
          thinking_turns: t.thinking_turns,
          cc_version: t.cc_version,
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
        thinking_tokens: a.row.thinking_tokens ?? null,
        thinking_turns: a.row.thinking_turns,
        cc_version: a.row.cc_version ?? null,
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
// core.quotepath=off: the path lists (name-status, numstat) give non-ASCII paths as they are (review 2026-11-11, S1).
export function gitLarge(args, { buffer = false } = {}) {
  try {
    return execFileSync('git', ['-c', 'core.quotepath=off', ...args], {
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
/** Active tasks (running, review; not picked) with a track-result.md that has not been received (queueLogic.assessDelivery). */
export function findDeliveries(queue) {
  return queue.tasks
    .filter((o) => ['running', 'review'].includes(o.status) && !o.picked_by)
    .map((o) => L.assessDelivery(o, trackReport(o).report))
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
    console.error(`(The delivery check failed: ${e?.message ?? e}; ${CLI} deliveries)`);
    return [];
  }
}
/** The time of the newest commit on a task's branch in ms, or null. */
function lastCommitMs(o) {
  const s = String(gitRead(['log', '-1', '--format=%ct', `refs/heads/${o.branch}`, '--']) ?? '').trim();
  return /^\d+$/.test(s) ? Number(s) * 1000 : null;
}
/**
 * Tracks no agent works on (queueLogic.noAgentTracks): marked running with no worktree on the branch and no report from
 * this start, or an attempt or round that no agent ever took.
 * Read-only; `show`, `state` and `orchestrator pulse` use it, so the check also runs after every compaction (the
 * after-compact hook includes `show`). An error never stops the command it is attached to.
 */
export function findWithoutAgent(queue) {
  try {
    const worktreeBranches = new Set(G.readWorktrees(gitRead).map((w) => w.branch).filter(Boolean));
    return L.noAgentTracks(queue, {
      worktreeBranches,
      reportOf: (o) => trackReport(o).report,
      rows: () => readTimeLog({ from: activeFrom(queue.tasks) }),
      lastCommitMs,
    });
  } catch (e) {
    console.error(`(The agent check failed: ${e?.message ?? e})`);
    return [];
  }
}
/**
 * The last sign of life of ONE active task and its source ({ ms, source }; ms null when nothing is found), measured
 * like findSilent but without a freshness cut, so the newest source wins (ravenseat explain).
 */
export function activityFor(queue, o) {
  try {
    const ACT = require('./lib/trackActivity.js');
    const worktrees = G.readWorktrees(gitRead).filter((w) => w.branch);
    return ACT.lastActivity({
      branch: o.branch,
      worktree: worktrees.find((w) => w.branch === o.branch)?.path ?? null,
      trackDirs: trackRoots(o).map((r) => path.join(r, o.id)),
      agents: ACT.agentsByTask(readTimeLog({ from: activeFrom([o]) }), [o.id]).get(o.id) ?? null,
      findTranscript,
      git: gitRead,
    });
  } catch {
    return { ms: null, source: null };
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
      readTimeLog({ from: activeFrom(candidates) }),
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
    const list = L.silentTracks(queue, {
      worktreeBranches,
      lastActivity,
      hasReport: (o) => L.reportSinceStart(o, trackReport(o).report),
      now,
      limitMin,
    });
    if (!list.length) return list;
    // An old worktree can hold the branch of a track no agent took: that one has its own warning.
    const none = new Set(findWithoutAgent(queue).map((x) => x.id));
    return list.filter((x) => !none.has(x.id));
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
    console.log(`Blocker ${code} opened on ${id} (ravenseat blockers; the next successful merge closes it).`);
  } catch (e) {
    console.error(`(Could not record the blocker: ${e?.message ?? e})`);
  }
}
// ---- Attempts (the rules in lib/logic/attempt.js) ----
/** The report and handover for a task: its current attempt's folder when it names one, otherwise the mtime rule. */
export const trackReport = (o, roots = trackRoots(o)) => L.findTrackReport(o.id, roots, undefined, undefined, AT.current(o));
/** The label an agent's mission gives it, from its transcript; null when there is none yet. */
function labelFromTranscript(agentId) {
  const text = readTranscript(findTranscript(agentId));
  const first = text ? L.firstUserMessage(text) : null;
  return first ? TK.trackFromText(first) : null;
}
/**
 * The time log rows for deriving the attempts of `tasks`, with the labels the hook could not know yet (lib/logic/attempt.js
 * relabelRows). Read BEFORE the lock (the log can be large), and only when one of them has an open attempt, so a normal
 * start reads nothing. The hook only appends to the log: it never writes queue.json or waits for the lock.
 */
export function attemptRows(tasks) {
  const open = tasks.filter((o) => AT.hasOpen(o?.attempts));
  if (!open.length) return [];
  const from = Math.min(...open.flatMap((o) => o.attempts.filter((x) => x.state !== 'ended').map((x) => Date.parse(x.reserved))));
  return AT.relabelRows(readTimeLog({ from }), labelFromTranscript, { from });
}
/** Brings a task's attempts up to date with the rows (the caller holds the lock). True when something changed. */
export function syncAttempts(o, rows) {
  const r = AT.deriveRunning(o.attempts, rows, { taskId: o.id });
  if (r.changed) o.attempts = r.attempts;
  return r.changed;
}
/** Would a new attempt be refused? The running attempt that blocks it, after the rows, or null. Changes nothing on disk. */
export function runningAttempt(o, rows) {
  return AT.startBlock(AT.deriveRunning(o.attempts, rows, { taskId: o.id }).attempts);
}
/**
 * Reserves the attempt for a start or a round on the task (the caller holds the lock; `rows` from attemptRows). The
 * client's adapter gives the id and the guard. A running attempt stops the command: nothing has been written yet.
 */
export function reserveAttempt(o, { round = 0, head = null, scratch = null, rows = [] } = {}) {
  syncAttempts(o, rows);
  const adapter = CL.clientFor(o.client);
  const r = AT.reserve(o.attempts, {
    client: adapter.id,
    capabilities: adapter.capabilities,
    round,
    baseSha: head,
    now: new Date().toISOString(),
    scratch,
    taskId: o.id,
    ttlMin: AT.reservationTtlMin(CONFIG),
  });
  if (r.blocked) die(AT.blockMessage(o.id, r.blocked, CLI));
  o.attempts = r.attempts;
  return r.attempt;
}
/** The fields `start` and `fill` set (under the lock): status, branch, if any, migration block, and the attempt. */
export function markStarted(queue, o, { agent = null, head = null, scratchpad = null, rows = [] } = {}) {
  // First: a running attempt stops the start before anything on the task changes.
  reserveAttempt(o, { head, scratch: scratchpad, rows });
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
  // The owner's own Claude setup before the track runs (lib/claudeFingerprint.js); receive compares. Only hashes.
  if (CONFIG?.claudeFingerprint !== false) {
    try {
      o.claude_fp = require('./lib/claudeFingerprint.js').fingerprint();
    } catch {
      delete o.claude_fp;
    }
  }
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
  attachPhases(o, cost, agents);
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
/**
 * Splits the cost into build, review and fix round (lib/costMeasures.js costPhases, the rule is documented there):
 * cost.phases, and per agent `phase` (and `fix_usd` for the part after the receive). Fail open: a measurement
 * without the split is still a measurement.
 */
function attachPhases(o, cost, agents) {
  try {
    const C = require('./lib/costMeasures.js');
    const track = new Map(agents.map((a) => [a.agent, a.row?.track ?? null]));
    const from = o.started ?? o.picked_at ?? o.added_at ?? null;
    const { phases, perAgent } = C.costPhases({
      taskId: o.id,
      agents: cost.agents.map((a) => ({ ...a, track: track.get(a.agent) ?? null })),
      resumed: o.resumed,
      tReceive: o.t_receive ?? null,
      // Only needed for the SendMessage split, so read once and only when there was a receive.
      rows: o.t_receive ? readTimeLog({ from }) : [],
      isReviewer: (t) => L.REVIEWER_TYPES.includes(t),
    });
    cost.phases = phases;
    for (const a of cost.agents) if (perAgent[a.agent]) Object.assign(a, perAgent[a.agent]);
  } catch {
    // error-ignored: the split is measurement only
  }
}
/**
 * The WARN lines for `set <id> done` (lib/costMeasures.js): an agent of the task whose output or thinking per turn is
 * over 2x its type's median over the last 14 days (the task's own agents left out of the baseline). Measurement only:
 * never throws, never stops the command.
 */
export function turnWarningLines(o) {
  try {
    const C = require('./lib/costMeasures.js');
    const agents = o.cost?.agents ?? [];
    if (!agents.length) return [];
    const from = Date.now() - C.BASELINE_DAYS * 86_400_000;
    const exclude = new Set(agents.map((a) => a.agent));
    const baseline = C.turnBaseline(C.agentTurnStats(readTimeLog({ from }), { from, exclude }));
    const bare = require('./lib/projectRoot.js').bareAgentType;
    const items = agents.map((a) => ({
      agent: a.agent,
      type: bare(a.type) ?? 'unknown',
      output_per_turn: a.output_per_turn ?? null,
      thinking_per_turn: a.thinking_per_turn ?? null,
      version: a.cc_version ?? null,
    }));
    return C.turnWarningLines(C.turnWarnings(items, baseline));
  } catch {
    return []; // error-ignored: the warning is measurement only
  }
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
    (o.result ? ` · RESULT ${o.result.status ?? '?'}` : '') +
    require('./lib/costMeasures.js').phaseText(k.phases)
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
