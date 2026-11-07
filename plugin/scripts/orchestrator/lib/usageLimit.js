// =============================================================
// usageLimit.js: the pause when the subscription's usage limit is reached.
//
// WHY: at the limit every new agent fails at once, and a fix round started then is burned for nothing. The queue stops
// starting work until the reset. Running tracks are left alone, and local work (receive, merge) still runs.
//
// THE SIGNAL: Claude Code's StopFailure hook fires when a turn ends on an API error (hook-usage-limit.mjs). Its input
// has no reset time, and a stop with `rate_limit` can also be a plain 429 (the API busy for a moment), which must not
// pause anything. So the session's transcript decides: the last assistant entry says `quotaLimits.status: "rejected"`
// or `apiError: "usage_limit_reached"`, with the reset. The text of the message is never parsed, and nothing but these
// fields is kept. If the entry is not written yet, a rate_limit stop with a status line window at 100 % also counts.
// A limit without a usable reset time gets a short default pause.
//
// WHAT THIS CANNOT DO: wake a stopped session. Claude Code itself waits and continues an interactive session after the
// reset in most setups. The agents' own transcripts do not show the limit, so the signal comes from the main session.
//
// Kept apart from queueLogic.js, so the hook loads next to nothing. Used by: hook-usage-limit.mjs, logic/guards.js
// (startGuard, exit 12), cli/cost.mjs (limit usageLimit clear), cli/orchestrator.mjs (the pulse).
// Tested in: __tests__/queueUsageLimit.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { renameWithRetry } = require('./stateFile.js');

/** The file name in the data folder. */
const FILE = 'usage-limit.json';
/** The pause when the limit is certain but no reset time is known. */
const DEFAULT_PAUSE_MS = 60 * 60 * 1000;
/** How much of the transcript's end is read: the limit entry is the last thing in it. */
const TAIL_BYTES = 256 * 1024;
/** The exit code of a refused start. */
const EXIT_CODE = 12;

const number = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/**
 * The limit a transcript entry reports, or null. Only a rejected quota counts; a warning or a plain 429 does not.
 * @returns {{ resetsAt: number|null, type: string|null } | null}
 */
function fromEntry(entry) {
  const q = entry?.quotaLimits;
  const info = entry?.apiErrorParams?.rate_limit_info;
  const rejected = q?.status === 'rejected' || info?.status === 'rejected' || entry?.apiError === 'usage_limit_reached';
  if (!rejected) return null;
  const type = q?.rateLimitType ?? info?.rateLimitType;
  return { resetsAt: number(q?.resetsAt) ?? number(info?.resetsAt), type: typeof type === 'string' ? type : null };
}

/**
 * The limit at the end of a transcript, or null. The LAST assistant entry decides: a normal answer or a plain 429 after
 * an old limit means the limit is not what stopped this turn. Other rows and a half-written last line are skipped.
 */
function fromTranscriptTail(text) {
  const lines = String(text ?? '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].trim()) continue;
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (entry?.type === 'assistant') return fromEntry(entry);
  }
  return null;
}

/** The end of a file as text ('' when it cannot be read). Never throws: the hook must not fail. */
function readTail(file) {
  if (typeof file !== 'string' || !file) return '';
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* nothing to do */
      }
    }
  }
}

/**
 * Does this StopFailure mean the usage limit? Returns the record to save, or null.
 * @param {{ error?: string }} input the hook's stdin JSON
 * @param {{ tail?: string, observed?: object|null, now?: number }} [o] the transcript's end and the status line reading
 * @returns {{ until: string, at: string, type: string|null, source: 'transcript'|'statusline'|'default' } | null}
 */
function decide(input, { tail = '', observed = null, now = Date.now() } = {}) {
  const record = (untilMs, type, source) => ({
    until: new Date(untilMs).toISOString(),
    at: new Date(now).toISOString(),
    type,
    source,
  });
  const found = fromTranscriptTail(tail);
  if (found) {
    const ms = found.resetsAt !== null ? found.resetsAt * 1000 : null;
    return ms !== null && ms > now
      ? record(ms, found.type, 'transcript')
      : record(now + DEFAULT_PAUSE_MS, found.type, 'default');
  }
  // No entry to read: a rate_limit stop with a window at 100 % that has not reset. The later reset is the one that counts.
  if (input?.error !== 'rate_limit') return null;
  const full = ['five_hour', 'seven_day']
    .map((type) => ({ type, w: observed?.[type] }))
    .filter(({ w }) => number(w?.used_percentage) !== null && w.used_percentage >= 100 && number(w?.resets_at) !== null && w.resets_at * 1000 > now)
    .sort((x, y) => y.w.resets_at - x.w.resets_at);
  return full.length ? record(full[0].w.resets_at * 1000, full[0].type, 'statusline') : null;
}

/** Is the pause still on? */
function isActive(rec, now = Date.now()) {
  const until = Date.parse(rec?.until);
  return Number.isFinite(until) && until > now;
}

/** A new limit on top of the saved one: the later reset wins, and `at` stays when the limit began. */
function merge(previous, next, now = Date.now()) {
  if (!isActive(previous, now)) return next;
  return Date.parse(next.until) > Date.parse(previous.until) ? { ...next, at: previous.at } : previous;
}

/** The saved record in `folder`, or null. */
function read(folder) {
  try {
    return JSON.parse(fs.readFileSync(path.join(folder, FILE), 'utf8'));
  } catch {
    return null;
  }
}

/** Saves the record (a temporary file renamed over the old one). */
function write(folder, rec) {
  const file = path.join(folder, FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`);
  renameWithRetry(tmp, file);
}

/** Removes the record. */
function clear(folder) {
  fs.rmSync(path.join(folder, FILE), { force: true });
}

/** The reset in the owner's local time, with the weekday since a weekly limit can be days away. */
function whenText(rec) {
  return new Date(rec.until).toLocaleString('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

/** The name of the limit for the messages. */
function typeText(rec) {
  if (rec?.type === 'seven_day') return 'weekly limit';
  if (rec?.type === 'five_hour') return 'session limit';
  return 'limit';
}

/**
 * The guard's stop while the pause is on, or null.
 * @returns {{ code: number, stop: 'usageLimit', summary: string, message: string } | null}
 */
function guard(rec, now = Date.now()) {
  if (!isActive(rec, now)) return null;
  const when = whenText(rec);
  return {
    code: EXIT_CODE,
    stop: 'usageLimit',
    summary: `the usage limit is reached until ${when}`,
    message:
      `USAGE LIMIT: the ${typeText(rec)} is reached until ${when}. No new tracks or fix rounds start, because they would ` +
      'only fail. Running tracks are left alone, and delivered tracks can still be received and merged. If you have ' +
      'added capacity: ravenseat limit usageLimit clear. One task anyway: start <id> --force.',
  };
}

/** The tracks that were running when the limit hit (started before it, still running). */
function runningAtLimit(tasks, rec) {
  const at = Date.parse(rec?.at);
  return (tasks ?? [])
    .filter((o) => o.status === 'running' && (!Number.isFinite(at) || !(Date.parse(o.started) > at)))
    .map((o) => o.id);
}

module.exports = {
  FILE, DEFAULT_PAUSE_MS, EXIT_CODE,
  fromEntry, fromTranscriptTail, readTail, decide, isActive, merge, read, write, clear, whenText, guard, runningAtLimit,
};
