// =============================================================
// logic/attempt.js: the attempt, one try at a task by one agent: who ran, under which guard, and how it ended.
//
// A task's `attempts: []` in queue.json holds the records, oldest first; the last one is the current attempt:
//   { id: "a<N>", client, role, round, state, session_id?, reserved, started?, ended?, outcome?, base_sha, delivered_sha?,
//     evidence?: [<gate evidence id>], guard: { sandbox, network, hooks }, artifacts: { report, handover } }
// (usage comes with the first client that reports it). `client` is the adapter id, `guard` comes from the adapter's
// capabilities (guardFor), never from its name. `evidence` points into the gate evidence store: the attempt answers
// "who ran and how did it end", the evidence "what was checked, on which commit" (lib/gateEvidence.js).
//
// The states: reserved -> running -> ended, and reserved -> ended for a reservation that never ran. Expired is not a
// state: it is how an old reservation reads (isExpired), so an agent that starts late still turns it into running.
//
// Double start. A running attempt blocks a new one until it is closed; a reservation never blocks (reserve).
// For a client with a runner this can be a guarantee (phase 2). For Claude it is BEST EFFORT, because the queue never
// starts the agent: it prints the Agent call and the orchestrator session makes it. `running` is derived from the
// SubagentStart row in the time log (hook-time.mjs must not write queue.json or wait for the lock). It can fail when:
//   1. The agent starts from the same reservation twice: nothing goes through the queue, so nothing can refuse it. The
//      second agent has the same label and the same attempt. The same goes for the time before the first row exists: a
//      second start in that gap sees a reservation, which does not block.
//   2. No row: the hook is not installed, has a narrow matcher, or failed (it fails open). The reservation expires.
//   3. A row without a label: the hook fired before the transcript was written, and the transcript cannot be found or
//      has no track label when the queue reads (relabelRows). The row is not matched, so the attempt stays reserved.
//   4. A stop row while the agent lives on: SendMessage resumes a stopped agent without a start row, the end gate
//      (hook-track-end.mjs) can refuse a stop after hook-time wrote its row, and recordKilledAgents can write a killed
//      row for an agent that is only quiet. The attempt reads as ended, and a new one is allowed.
//   5. The rows are read before the lock (the log is large; see cmdStart), so a row written in that moment is missed.
//   6. The paths with no attempt at all: cq pick and cq cloud.
// A false block is the other direction: an agent killed without a stop row stays running until `cq attempt close`.
//
// Everything here is pure: no file system, no exit. Text for the caller to print, values in and values out.
// Used by cli/tracks.mjs, cli/run.mjs, cli/merge.mjs and cli/attempt.mjs. Tested in lib/__tests__/attempt.test.ts and,
// through real processes, __tests__/queueAttempt.test.ts.
// =============================================================
'use strict';

const path = require('node:path');
const TK = require('../timeCost.js');

/** How long a reservation without a start row counts as live (config attempts.reservationTtlMin). */
const DEFAULT_RESERVATION_TTL_MIN = 30;
/** What `cq attempt close --outcome` takes. */
const CLOSE_OUTCOMES = Object.freeze(['delivered', 'failed', 'interrupted', 'abandoned']);

/** The reservation bound in minutes from the config; the default for a missing or unusable value. */
function reservationTtlMin(config) {
  const v = config?.attempts?.reservationTtlMin;
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_RESERVATION_TTL_MIN;
}

/**
 * The guard an attempt runs under, from the adapter's capabilities. `network` says what stands between the agent and
 * the network: the OS sandbox, the queue's hooks, or nothing. What the adapter can do, not a measurement of the run.
 */
function guardFor(capabilities) {
  const sandbox = capabilities?.sandbox === true;
  const hooks = capabilities?.hooks === true;
  return { sandbox, network: sandbox ? 'sandbox' : hooks ? 'hook' : 'none', hooks };
}

/**
 * Where the attempt's report and handover belong: <scratch>/<id>/a<N>/, only for a client that declares
 * `attemptFolder` (its runner moves the files there). Claude does not: its agent writes where the mission says
 * (<scratch>/<id>/ or <id>-r<N>/) and the mission text must stay byte-identical, so both are null and findTrackReport
 * uses its mtime rule.
 */
function artifactsFor({ capabilities, scratch, taskId, n }) {
  if (capabilities?.attemptFolder !== true || !scratch) return { report: null, handover: null };
  const folder = path.join(scratch, taskId, `a${n}`);
  return { report: path.join(folder, 'track-result.md'), handover: path.join(folder, 'handover.md') };
}

/** The current attempt of a task: the last one, or null. */
function current(o) {
  return o?.attempts?.length ? o.attempts[o.attempts.length - 1] : null;
}

/** Does the list have an attempt that has not ended? (Then the time log has something to say about it.) */
const hasOpen = (attempts) => (attempts ?? []).some((x) => x.state !== 'ended');

/** A reservation past its bound. It no longer counts as live; a start row still makes it running. */
function isExpired(x, { now, ttlMin = DEFAULT_RESERVATION_TTL_MIN }) {
  return x.state === 'reserved' && now - Date.parse(x.reserved) > ttlMin * 60_000;
}

/** The state to show: the stored one, or `expired` for a reservation past its bound. */
const shownState = (x, o) => (isExpired(x, o) ? 'expired' : x.state);

/** The attempt that blocks a new one: a running one, or null. A reservation never blocks. */
const startBlock = (attempts) => (attempts ?? []).find((x) => x.state === 'running') ?? null;

/** The refusal when a running attempt blocks. `cq` is the command to write in the hint. */
function blockMessage(taskId, x, cq) {
  return (
    `${taskId}: attempt ${x.id} is running${x.session_id ? ` (agent ${x.session_id})` : ''}, so a new one cannot start. ` +
    `If that agent is gone: ${cq} attempt close ${taskId} --outcome interrupted`
  );
}

const ended = (x, outcome, now) => ({ ...x, state: 'ended', ended: now, outcome });

/**
 * Reserves an attempt (the caller holds the queue lock). A running attempt blocks: `{ blocked }`. A live reservation for
 * the same round is the same attempt, so two starts give one. Any other reservation never ran and is closed (`expired`
 * or `superseded`), so it never stops the next start.
 * @param {object[]|undefined} attempts the task's list, after deriveRunning
 * @param {{ client: string, role?: string, round: number, baseSha?: string|null, now: string, capabilities: object,
 *   scratch?: string|null, taskId: string, ttlMin?: number }} o
 * @returns {{ attempts: object[], attempt?: object, created?: boolean, blocked?: object }}
 */
function reserve(attempts, o) {
  const list = attempts ?? [];
  const blocked = startBlock(list);
  if (blocked) return { attempts: list, blocked };
  const nowMs = Date.parse(o.now);
  const live = list.find(
    (x) => x.state === 'reserved' && x.round === o.round && !isExpired(x, { now: nowMs, ttlMin: o.ttlMin }),
  );
  if (live) return { attempts: list, attempt: live, created: false };
  const n = list.reduce((max, x) => Math.max(max, Number(String(x.id).slice(1)) || 0), 0) + 1;
  const attempt = {
    id: `a${n}`,
    client: o.client,
    role: o.role ?? 'track',
    round: o.round,
    state: 'reserved',
    reserved: o.now,
    base_sha: o.baseSha ?? null,
    guard: guardFor(o.capabilities),
    artifacts: artifactsFor({ capabilities: o.capabilities, scratch: o.scratch, taskId: o.taskId, n }),
  };
  const closed = list.map((x) =>
    x.state === 'reserved' ? ended(x, isExpired(x, { now: nowMs, ttlMin: o.ttlMin }) ? 'expired' : 'superseded', o.now) : x,
  );
  return { attempts: [...closed, attempt], attempt, created: true };
}

/** The track label an attempt's agent logs under: `<id>`, or `<id>-r<N>` for a round (the mission's prompt file). */
const labelFor = (taskId, round) => (round ? `${taskId}-r${round}` : taskId);

/** The agent rows that belong to an attempt, per agent id, in log order. */
function rowsOfAttempt(x, rows, taskId) {
  const label = labelFor(taskId, x.round);
  const from = Date.parse(x.reserved);
  const inScope = (r) =>
    r?.agent_id && (r.event === 'start' || r.event === 'done') && TK.isBuildAgent(r.agent_type) && Date.parse(r.time) >= from;
  // One labelled row is enough: a start row from before the transcript existed joins through the same agent's other rows.
  const agents = new Set(rows.filter((r) => inScope(r) && r.track === label).map((r) => r.agent_id));
  const byAgent = new Map();
  for (const r of rows) {
    if (!inScope(r) || !agents.has(r.agent_id)) continue;
    if (!byAgent.has(r.agent_id)) byAgent.set(r.agent_id, []);
    byAgent.get(r.agent_id).push(r);
  }
  return byAgent;
}

/** One open attempt after its rows; the same object when they change nothing. */
function applyRows(x, byAgent) {
  if (!byAgent.size) return x;
  const firsts = [...byAgent].map(([agent, list]) => ({ agent, time: list[0].time }));
  const earliest = firsts.reduce((m, f) => (Date.parse(f.time) < Date.parse(m.time) ? f : m));
  const newest = firsts.reduce((m, f) => (Date.parse(f.time) >= Date.parse(m.time) ? f : m));
  const lasts = [...byAgent.values()].map((list) => list[list.length - 1]);
  const next = { ...x, state: 'running', started: x.started ?? earliest.time, session_id: newest.agent };
  // Every agent has stopped: nothing is running any more. Without this a continuation after PARTIAL, which today needs
  // no receive, would be refused. See point 4 at the top for when the row can be wrong.
  if (lasts.every((r) => r.event === 'done')) {
    const stop = lasts.reduce((m, r) => (Date.parse(r.time) >= Date.parse(m.time) ? r : m));
    return ended(next, lasts.some((r) => r.killed) ? 'interrupted' : 'stopped', stop.time);
  }
  return x.state === 'running' && x.session_id === next.session_id && x.started === next.started ? x : next;
}

/**
 * Derives the states from the time log: a row with the attempt's label turns reserved into running, and a stop row of
 * every agent ends it. Only a build agent's rows count (a reviewer's label is the task id too), and only rows from
 * after the reservation (an older agent had an earlier attempt). An ended attempt is never reopened. Never mutates.
 * @param {object[]|undefined} attempts
 * @param {object[]} rows the time log rows (timeCost.readRows), in log order
 * @param {{ taskId: string }} o
 * @returns {{ attempts: object[]|undefined, changed: boolean }} the same list when nothing changed
 */
function deriveRunning(attempts, rows, { taskId }) {
  if (!attempts?.length || !rows?.length) return { attempts, changed: false };
  let changed = false;
  const out = attempts.map((x) => {
    if (x.state === 'ended') return x;
    const next = applyRows(x, rowsOfAttempt(x, rows, taskId));
    if (next !== x) changed = true;
    return next;
  });
  return { attempts: changed ? out : attempts, changed };
}

/**
 * Fills in the track label of the build agents' rows that lack one (the hook fired before the transcript was written,
 * so the row's label is the agent id or null), by what `lookup(agentId)` says. Only rows at or after `from`, and once
 * per agent, so the caller's lookup can read a transcript. Never mutates.
 */
function relabelRows(rows, lookup, { from }) {
  const known = new Map();
  return (rows ?? []).map((r) => {
    if (!r?.agent_id || !TK.isBuildAgent(r.agent_type) || !(Date.parse(r.time) >= from)) return r;
    if (r.track && !String(r.agent_id).startsWith(r.track)) return r;
    if (!known.has(r.agent_id)) known.set(r.agent_id, lookup(r.agent_id));
    const track = known.get(r.agent_id);
    return track ? { ...r, track } : r;
  });
}

/**
 * Closes the open attempt by hand (`cq attempt close`).
 * @returns {{ attempts?: object[], closed?: object, error?: string }}
 */
function close(attempts, { outcome, now }) {
  if (!CLOSE_OUTCOMES.includes(outcome)) return { error: `--outcome must be one of ${CLOSE_OUTCOMES.join(', ')}` };
  const open = (attempts ?? []).find((x) => x.state !== 'ended');
  if (!open) return { error: 'no open attempt to close' };
  const closed = ended(open, outcome, now);
  return { attempts: attempts.map((x) => (x === open ? closed : x)), closed };
}

/**
 * How a delivery ended, as receive saw it. A red check goes first; otherwise the RESULT status (a signal, not a verdict:
 * the evidence the attempt points to is the verdict). No RESULT line: receive only runs on a branch with commits.
 */
function receiveOutcome({ status = null, gateRed = false, doneRed = false }) {
  if (gateRed) return 'gate-red';
  if (doneRed) return 'done-red';
  if (status === 'PARTIAL') return 'partial';
  return status && status !== 'DONE' ? String(status).toLowerCase() : 'delivered';
}

/**
 * What receive knows goes on the current attempt: the delivered commit, the outcome, the end and the evidence id. A new
 * receive of the same attempt updates them, keeps the first end and adds new evidence. `report` and `handover` are the
 * files receive actually read. No attempts (an old task or a picked one): nothing is written.
 */
function recordReceive(attempts, { sha = null, outcome, evidenceId = null, now, report = null, handover = null }) {
  if (!attempts?.length) return attempts;
  const last = attempts[attempts.length - 1];
  const evidence = [...new Set([...(last.evidence ?? []), ...(evidenceId ? [evidenceId] : [])])];
  const next = {
    ...last,
    state: 'ended',
    ended: last.ended ?? now,
    outcome,
    ...(sha ? { delivered_sha: sha } : {}),
    ...(evidence.length ? { evidence } : {}),
    artifacts: { report: report ?? last.artifacts?.report ?? null, handover: handover ?? last.artifacts?.handover ?? null },
  };
  return [...attempts.slice(0, -1), next];
}

module.exports = {
  DEFAULT_RESERVATION_TTL_MIN,
  CLOSE_OUTCOMES,
  reservationTtlMin,
  guardFor,
  current,
  hasOpen,
  isExpired,
  shownState,
  startBlock,
  blockMessage,
  reserve,
  labelFor,
  deriveRunning,
  relabelRows,
  close,
  receiveOutcome,
  recordReceive,
};
