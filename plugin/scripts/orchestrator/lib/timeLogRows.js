// =============================================================
// timeLogRows.js: the measurement rows cq appends to the time log (config().timeLog, the file hook-time.mjs writes;
// QUEUE_TIME_LOG overrides) besides the agents' start and done rows.
//
// Why: a benchmark (bench/ in this repo) needs to count gate runs and reruns per task and compactions per session and
// per track. The rows are built here, in pure functions with tests, so gates.mjs and the hooks only do the thin I/O:
//   gate run      { time, event: "gate", track, branch, kind, gates, failed, duration_s, ok, exit, attempt, timed_out? }
//                 One row per gates.mjs run (kind quick, full or precheck). `track` is the task id when it is known (the
//                 --track argument, or the branch <branchPrefix><id>), else null. `gates` are the commands (quick/full)
//                 or check names (precheck) that ran, `failed` the red or timed-out ones. `attempt` counts the runs of the
//                 same kind for the same track (or the same branch when the track is unknown): 1 is the first run, so
//                 attempt > 1 is a rerun. `timed_out: true` only when a check went over its time budget. `sha` (the
//                 HEAD commit when the run started) and `clean` (no uncommitted tracked changes then), when known.
//                 MEASUREMENT ONLY: the time log is a file every agent appends to, so a gate row proves nothing. What
//                 cq receive, cq merge and the push check rely on is the gate evidence store (lib/gateEvidence.js).
//   compaction    { time, event: "compact", scope: "session", session_id, orchestrator }   a main session (SessionStart
//                 compact; orchestrator = the session is the bound orchestrator, contextGuard.afterCompactBound)
//                 { time, event: "compact", scope: "track", agent_id, agent_type, track, compactions }   one row per new
//                 compaction of a track agent (hook-track-context.mjs); `compactions` is the count after it (1, 2, ...)
//   killed agent  { time, wave, track, event: "done", killed: true, cumulative: true, agent_id, agent_type, ...the
//                 analysis }   a done row cq writes itself (cli/tracks.mjs recordKilledAgents) for an agent that has a
//                 start row and no done row (stopped, crashed or killed without SubagentStop), from what its transcript
//                 holds, so its cost is counted. It is cumulative like the hook's rows: when a real done row arrives later,
//                 the readers take only the growth per agent_id (timeCost.usageEvents), so nothing is counted twice.
//
// Writing a row never changes what the caller does: appendRows swallows every error (fail open).
// Tested in lib/__tests__/timeLogRows.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** The gate kinds gates.mjs runs. */
const GATE_KINDS = new Set(['quick', 'full', 'precheck']);

/** The task id in a queue branch (<prefix><id>), or null for any other branch. */
function trackFromBranch(branch, prefix = 'queue/') {
  const b = String(branch ?? '');
  const p = String(prefix ?? '');
  if (!p || !b.startsWith(p) || b.length === p.length) return null;
  return b.slice(p.length);
}

/**
 * The attempt number for a new gate run: 1 + the earlier gate rows in the log text with the same kind and the same
 * track (or, when the track is unknown, the same branch). Lines that are not gate rows, or are broken, are skipped.
 * @param {string|null} text the time log's content (null = no log yet)
 * @param {{ kind: string, track?: string|null, branch?: string|null }} key
 */
function gateAttempt(text, { kind, track = null, branch = null }) {
  let n = 0;
  for (const line of String(text ?? '').split('\n')) {
    // Cheap filter first: the time log is mostly agent rows.
    if (!line.includes('"gate"')) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    if (r?.event !== 'gate' || r.kind !== kind) continue;
    if (track != null ? r.track === track : r.track == null && r.branch === branch) n++;
  }
  return n + 1;
}

/**
 * One gate run row (see the header).
 * @param {{ time?: string, track?: string|null, branch?: string|null, kind: string, gates?: string[],
 *   failed?: string[], durationSec: number, exit: number, timedOut?: boolean, attempt?: number, sha?: string,
 *   clean?: boolean }} r
 */
function gateRow(r) {
  const row = {
    time: r.time ?? new Date().toISOString(),
    event: 'gate',
    track: r.track ?? null,
    branch: r.branch ?? null,
    kind: r.kind,
    gates: Array.isArray(r.gates) ? r.gates : [],
    failed: Array.isArray(r.failed) ? r.failed : [],
    duration_s: Math.round(Number(r.durationSec) * 10) / 10 || 0,
    ok: r.exit === 0,
    exit: r.exit,
    attempt: Number.isInteger(r.attempt) && r.attempt > 0 ? r.attempt : 1,
  };
  if (r.timedOut) row.timed_out = true;
  // The commit the run checked and whether the tree had uncommitted tracked changes (for measurement: reruns per
  // commit). No decision reads them; the trusted copy is the gate evidence store (lib/gateEvidence.js).
  if (typeof r.sha === 'string' && r.sha) row.sha = r.sha;
  if (typeof r.clean === 'boolean') row.clean = r.clean;
  return row;
}

/** A main session's compaction row (SessionStart with source compact). */
function sessionCompactRow({ time, sessionId, orchestrator }) {
  return {
    time: time ?? new Date().toISOString(),
    event: 'compact',
    scope: 'session',
    session_id: sessionId ?? null,
    orchestrator: orchestrator === true,
  };
}

/**
 * The rows for a track agent's NEW compactions: one per compaction between `before` (the count already logged) and
 * `after` (the count now), so a hook call that sees two new compactions at once still gives two rows. Empty when the
 * count did not rise (or went down: a new transcript with the same name starts over).
 */
function trackCompactRows({ time, agentId, agentType, track = null, before, after }) {
  const from = Number.isInteger(before) && before >= 0 ? before : 0;
  const to = Number.isInteger(after) ? after : 0;
  const rows = [];
  for (let n = from + 1; n <= to; n++)
    rows.push({
      time: time ?? new Date().toISOString(),
      event: 'compact',
      scope: 'track',
      agent_id: agentId ?? null,
      agent_type: agentType ?? null,
      track,
      compactions: n,
    });
  return rows;
}

/** Appends rows as JSONL. Never throws: returns false when the log could not be written. */
function appendRows(file, rows) {
  try {
    const list = [].concat(rows ?? []).filter(Boolean);
    if (!file || !list.length) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, list.map((r) => JSON.stringify(r)).join('\n') + '\n');
    return true;
  } catch {
    return false; // error-ignored: the time log is for measurement only
  }
}

// ---- Killed agents (transcript metrics): kept apart from the rows above to keep merges simple ----

/**
 * The agents with a start row and no done row: the earliest start row per agent_id, only starts at or after `from`
 * (an ISO time; null = all). A done row of any kind (hook or killed) for the agent leaves it out.
 * @param {object[]} rows the time log rows
 * @param {{ from?: string|null }} [option]
 * @returns {object[]} start rows
 */
function agentsWithoutDone(rows, { from = null } = {}) {
  const done = new Set();
  const start = new Map();
  for (const r of rows ?? []) {
    if (!r?.agent_id) continue;
    if (r.event === 'done') done.add(r.agent_id);
    else if (r.event === 'start') {
      const earlier = start.get(r.agent_id);
      if (!earlier || Date.parse(r.time) < Date.parse(earlier.time)) start.set(r.agent_id, r);
    }
  }
  const limit = from ? Date.parse(from) : NaN;
  return [...start.values()].filter(
    (r) => !done.has(r.agent_id) && (Number.isNaN(limit) || !(Date.parse(r.time) < limit)),
  );
}

/**
 * The done row for a killed agent: the start row's wave, id and type, and the analysis of its transcript
 * (timeCost.analyzeTranscript), marked killed and cumulative. The track is the mission's (the analysis), else the
 * start row's label.
 * @param {{ start: object, stat: object, time?: string }} a
 */
function killedDoneRow({ start, stat, time }) {
  const { track, ...counts } = stat ?? {};
  const row = {
    time: time ?? new Date().toISOString(),
    wave: start?.wave ?? 'unknown',
    track: track ?? start?.track ?? String(start?.agent_id ?? '').slice(0, 12),
    event: 'done',
    agent_id: start?.agent_id ?? null,
    agent_type: start?.agent_type ?? null,
    killed: true,
    cumulative: true,
    ...counts,
  };
  row.remark =
    `killed (no SubagentStop): ${counts.toolCall ?? 0} calls, ${counts.modelTurns ?? 0} turns, ` +
    `about $${counts.cost_usd ?? 0} (cumulative)`;
  return row;
}

module.exports = {
  GATE_KINDS,
  trackFromBranch,
  gateAttempt,
  gateRow,
  sessionCompactRow,
  trackCompactRows,
  appendRows,
  agentsWithoutDone,
  killedDoneRow,
};
