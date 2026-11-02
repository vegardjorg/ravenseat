// =============================================================
// eventRows.js: the flow, load and session rows cq appends to the time log (config().timeLog; QUEUE_TIME_LOG
// overrides), next to the agent rows (hook-time.mjs) and the gate and compaction rows (lib/timeLogRows.js).
//
// Why: the queue already knew about fix rounds (queue.json `resumed`), merge conflicts (a blocker), the base gate
// (base-health.json), triage verdicts (queue.json) and pushes (git), but only as the current state, so nothing could
// say "how many first-pass merges this week" or "when was parallelism limited". One appended JSON line per event makes
// that countable. The rows (all with `time` and `event`):
//   fixRound      { task, reason, round, from? }            cq resume (cli/run.mjs), also when receive or merge
//                                                            resumes by itself; reason fix or context; from = the
//                                                            reviewer types that caused it (cq resume --from)
//   mergeConflict { task, files, branch, guard? }           cq merge stopped in the merge step (cli/merge.mjs);
//                                                            files = "Conflicts in N files." from merge-track.mjs (null
//                                                            when not printed); guard: true when the merge guard stopped
//   baseGate      { tip, ok, skipped, duration_s, made_red_by, fix_task?, note? }
//                                                            every recorded base verdict (cli/baseHealth.mjs
//                                                            recordVerdict): before a merge, after it, the skip rule
//   flakyGate     { tip, commands, source, task? }          a base gate command that was red, then green on a rerun
//                                                            on the same sha (cli/baseHealth.mjs, the flaky check)
//   ciWatch       { sha, verdict, runs, red, task?, question? }
//                                                            the CI watch's verdict for a pushed commit (cli/ciWatch.mjs)
//   triage       { task, verdict, by? }                    cq triage <id> --verdict
//   push          { remote, branch, from, tip, tasks, task_count, commits, base_health, verdict, detected_at }
//                                                            detected after the fact from the reflog of the remote
//                                                            tracking ref (see pushesFromReflog), at cq fill
//   load          { command, free_memory_pct, cpu_pct, slots, max_slots, running, limited_by, reason, stopped,
//                   stop_reason? }                           one per cq fill and cq start (cli/events.mjs logLoad)
//   session       { session_id, usd, duration_s, api_duration_s, context_tokens, model, orchestrator, trigger }
//                                                            the main session's cost from the status line payload;
//                                                            CUMULATIVE per session_id (see sessionDecision)
//
// Writing a row never changes what the caller does: lib/timeLogRows.js appendRows swallows every error, and the
// callers wrap the building in try/catch too (cli/events.mjs).
// Pure functions, tested in lib/__tests__/eventRows.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** The event names written here (readers that keep only some rows, such as the board, filter on this set). */
const EVENTS = new Set(['fixRound', 'mergeConflict', 'baseGate', 'flakyGate', 'ciWatch', 'triage', 'push', 'load', 'session']);

const iso = (t) => (t == null ? new Date().toISOString() : typeof t === 'number' ? new Date(t).toISOString() : t);
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;

// ---- Flow rows --------------------------------------------------------------------------------------------------

function fixRoundRow({ time, task, reason, round, from = [] }) {
  const row = { time: iso(time), event: 'fixRound', task, reason: reason ?? null, round: Number.isInteger(round) ? round : null };
  if (Array.isArray(from) && from.length) row.from = [...from];
  return row;
}

/**
 * The conflicted file count in a merge step's output: merge-track.mjs's "Conflicts in N files." (0 for its "No
 * conflicts."), otherwise the "CONFLICT (...)" lines of a plain git merge; null when the output says neither.
 */
function conflictFiles(out) {
  const s = String(out ?? '');
  const m = /Conflicts in (\d+) files?\./.exec(s);
  if (m) return Number(m[1]);
  if (/^No conflicts\./m.test(s)) return 0;
  const n = (s.match(/^CONFLICT \(/gm) ?? []).length;
  return n || null;
}

function mergeConflictRow({ time, task, files = null, branch = null, guard = false }) {
  const row = { time: iso(time), event: 'mergeConflict', task, files: Number.isInteger(files) ? files : null, branch };
  if (guard) row.guard = true;
  return row;
}

/** One recorded base verdict. `run` is the base gate run (durationSec), null for the skip rule. */
function baseGateRow({ time, tip, ok, skipped = null, run = null, madeRedBy = null, fixTask = null, note = null }) {
  const d = num(run?.durationSec);
  const row = {
    time: iso(time),
    event: 'baseGate',
    tip: tip ?? null,
    ok: ok === true,
    skipped: skipped ?? null,
    duration_s: d == null ? null : round1(d),
    made_red_by: madeRedBy?.task ?? null,
  };
  if (fixTask) row.fix_task = fixTask;
  if (note) row.note = note;
  return row;
}

/** A flaky base gate command (or several): red, then green on a rerun on the same sha. */
function flakyGateRow({ time, tip, commands, source = null, task = null }) {
  const row = { time: iso(time), event: 'flakyGate', tip: tip ?? null, commands: Array.isArray(commands) ? [...commands] : [], source };
  if (task) row.task = task;
  return row;
}

/** The CI watch's verdict for a pushed commit: green, check or infra (the red run count, the task or question). */
function ciWatchRow({ time, sha, verdict, runs = 0, red = 0, task = null, question = null }) {
  const row = { time: iso(time), event: 'ciWatch', sha: sha ?? null, verdict, runs, red };
  if (task) row.task = task;
  if (question) row.question = question;
  return row;
}

function triageRow({ time, task, verdict, by = null }) {
  const row = { time: iso(time), event: 'triage', task, verdict };
  if (by) row.by = by;
  return row;
}

// ---- Load row ---------------------------------------------------------------------------------------------------

/**
 * One load row for fill or start.
 * @param {{ command: string, load: { freeMemoryPct?: number|null, cpuPct?: number|null }|null, slots: object|null,
 *   guard: { stop?: boolean, summary?: string }|null, running: number, override?: boolean }} x
 *   slots = queueLogic.loadSlotsFor, guard = queueLogic.loadGuard; override = --over-load / --force (nothing measured)
 */
function loadRow({ time, command, load, slots, guard, running, override = false }) {
  const row = {
    time: iso(time),
    event: 'load',
    command,
    free_memory_pct: num(load?.freeMemoryPct),
    cpu_pct: num(load?.cpuPct),
    slots: num(slots?.slots),
    max_slots: num(slots?.max),
    running: Number.isInteger(running) ? running : null,
    limited_by: slots?.limited ? (slots.by ?? null) : null,
    reason: slots?.limited ? (slots.reason ?? null) : null,
    stopped: guard?.stop === true,
  };
  if (guard?.stop) row.stop_reason = guard.summary ?? 'the machine is full';
  if (override) row.override = true;
  return row;
}

// ---- Session cost (the status line payload) ---------------------------------------------------------------------
//
// The payload (Claude Code 2.x, code.claude.com/docs/en/statusline) has, for cost: cost.total_cost_usd (the session's
// estimated cost so far at list price, cumulative; it starts over at $0 when /clear starts a new session id),
// cost.total_duration_ms (wall clock), cost.total_api_duration_ms, cost.total_lines_added/removed. It has NO
// cumulative token counts: context_window.total_input_tokens is what is in the context now (the last call), so the row
// keeps that as `context_tokens`, not as a usage sum.

/** The state file in the data folder: the last reading per session (for the throttle and the end/compact rows). */
const SESSION_FILE = 'session-cost.json';
/** A row is written when the cost grew by at least this much since the last row ... */
const SESSION_STEP_USD = 0.5;
/** ... or this long after the last row when it grew at all. */
const SESSION_INTERVAL_MS = 10 * 60 * 1000;
/** The state keeps at most this many sessions (the most recent). */
const SESSION_KEEP = 40;

/** The reading from the status line input, or null when it has no session id or no cost. */
function sessionReading(input, now = Date.now()) {
  const id = typeof input?.session_id === 'string' && input.session_id ? input.session_id : null;
  const usd = num(input?.cost?.total_cost_usd);
  if (!id || usd == null) return null;
  const ms = num(input?.cost?.total_duration_ms);
  const api = num(input?.cost?.total_api_duration_ms);
  return {
    session_id: id,
    usd: round2(usd),
    duration_s: ms == null ? null : Math.round(ms / 1000),
    api_duration_s: api == null ? null : Math.round(api / 1000),
    context_tokens: num(input?.context_window?.total_input_tokens),
    model: input?.model?.id ?? null,
    time: new Date(now).toISOString(),
  };
}

/**
 * What to do with a new reading against the saved one for the same session: `log` = append a session row,
 * `save` = write the state (the cost changed, or a row was logged). The first reading with a cost above 0 is logged.
 */
function sessionDecision(previous, reading, now = Date.now()) {
  if (!reading) return { log: false, save: false };
  if (!previous) return { log: reading.usd > 0, save: true };
  const logged = num(previous.logged_usd) ?? 0;
  const loggedAt = Date.parse(previous.logged_at ?? '');
  const grew = reading.usd - logged;
  // A drop means the counter started over (a resumed session can begin at $0 again): log it, readers handle it.
  const log =
    reading.usd < logged ||
    grew >= SESSION_STEP_USD ||
    (grew > 0 && (!Number.isFinite(loggedAt) || now - loggedAt >= SESSION_INTERVAL_MS));
  return { log, save: log || reading.usd !== previous.usd };
}

function sessionRow({ time, reading, orchestrator = false, trigger }) {
  return {
    time: iso(time ?? reading.time),
    event: 'session',
    session_id: reading.session_id,
    usd: reading.usd,
    duration_s: reading.duration_s ?? null,
    api_duration_s: reading.api_duration_s ?? null,
    context_tokens: reading.context_tokens ?? null,
    model: reading.model ?? null,
    orchestrator: orchestrator === true,
    trigger,
  };
}

/**
 * The session row for a hook (compact, end) from the last saved reading of the session, or null when the status
 * line has saved none (it is not set up, or the session has had no answer yet). The hook input has no cost of its own.
 */
function sessionRowFromState(state, sessionId, { trigger, orchestrator = false, time } = {}) {
  const reading = sessionId ? state?.sessions?.[sessionId] : null;
  if (!reading || num(reading.usd) == null) return null;
  return sessionRow({ time: iso(time), reading, orchestrator, trigger });
}

/** The saved state ({ sessions: { <id>: reading + logged_usd, logged_at } }); an empty one when missing or broken. */
function readSessionState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    return s && typeof s.sessions === 'object' && s.sessions ? s : { sessions: {} };
  } catch {
    return { sessions: {} };
  }
}

/** The state with the session's new entry, pruned to the SESSION_KEEP most recent sessions. */
function withSession(state, reading, { logged = false } = {}) {
  const previous = state?.sessions?.[reading.session_id] ?? {};
  const entry = {
    ...reading,
    logged_usd: logged ? reading.usd : (previous.logged_usd ?? null),
    logged_at: logged ? reading.time : (previous.logged_at ?? null),
  };
  const all = { ...(state?.sessions ?? {}), [reading.session_id]: entry };
  const kept = Object.entries(all)
    .sort((x, y) => Date.parse(y[1].time ?? '') - Date.parse(x[1].time ?? ''))
    .slice(0, SESSION_KEEP);
  return { sessions: Object.fromEntries(kept) };
}

/** Writes the state atomically (tmp + rename). Never throws: false when it could not be written. */
function writeSessionState(file, state) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state) + '\n');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false; // error-ignored: the state only throttles the rows
  }
}

// ---- Pushes from the reflog of the remote tracking ref ----------------------------------------------------------
//
// WHY THE REFLOG: the push guard (a PreToolUse hook) sees the command but not whether the push went through, and
// push-check runs BEFORE a push. After a successful `git push <remote> <base>` git moves refs/remotes/<remote>/<base>
// and writes "update by push" in that ref's reflog, with the time; a fetch writes "fetch: ..." instead. So the reflog
// says exactly which pushes happened and when, also pushes made by the owner by hand, and `cq fill` reads it
// (one git call) and logs the new ones. The batch of a push is the first-parent line between the ref before it (the
// next older reflog entry) and the pushed tip. Requires reflogs for remote refs (core.logAllRefUpdates, on by default
// in a non-bare repo); without them no push row is written.

/** The reflog format for `git reflog show --date=unix`: sha, subject and the selector with the unix time. */
const REFLOG_FORMAT = '%H%x1f%gs%x1f%gd';

/** Parses the reflog lines (newest first): [{ sha, subject, time (ms) }]. */
function parseReflog(out) {
  const US = String.fromCharCode(0x1f);
  const rows = [];
  for (const line of String(out ?? '').split(/\r?\n/)) {
    const [sha, subject, sel] = line.split(US);
    if (!sha || !sel) continue;
    const m = /@\{(\d+)\}/.exec(sel);
    if (!m) continue;
    rows.push({ sha: sha.trim(), subject: String(subject ?? '').trim(), time: Number(m[1]) * 1000 });
  }
  return rows;
}

/**
 * The pushes in the reflog newer than `since` (ms), oldest first: { from, tip, time }. `from` is the ref before the
 * push (the next older entry); a push with no older entry is skipped (its batch is unknown).
 */
function pushesFromReflog(entries, { since = 0 } = {}) {
  const out = [];
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (!(e.time > since) || !/^update by push/.test(e.subject)) continue;
    const before = entries[i + 1];
    if (!before) continue;
    out.push({ from: before.sha, tip: e.sha, time: e.time });
  }
  return out.reverse();
}

function pushRow({ time, detectedAt, remote, branch, from, tip, batch, health = 'unknown', verdict = null }) {
  return {
    time: iso(time),
    event: 'push',
    remote,
    branch,
    from,
    tip,
    tasks: batch?.tasks ?? [],
    task_count: batch?.taskCount ?? 0,
    commits: batch?.commits ?? null,
    base_health: health,
    verdict,
    detected_at: iso(detectedAt),
  };
}

module.exports = {
  EVENTS,
  fixRoundRow,
  conflictFiles,
  mergeConflictRow,
  baseGateRow,
  flakyGateRow,
  ciWatchRow,
  triageRow,
  loadRow,
  SESSION_FILE,
  SESSION_STEP_USD,
  SESSION_INTERVAL_MS,
  SESSION_KEEP,
  sessionReading,
  sessionDecision,
  sessionRow,
  sessionRowFromState,
  readSessionState,
  withSession,
  writeSessionState,
  REFLOG_FORMAT,
  parseReflog,
  pushesFromReflog,
  pushRow,
};
