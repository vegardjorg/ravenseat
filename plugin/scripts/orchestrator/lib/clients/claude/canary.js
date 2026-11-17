// =============================================================
// clients/claude/canary.js: the format canary (roadmap 0w W4). It reads the last rows of a Claude Code transcript and
// sums up what the adapter did not expect, so a format change shows as one line in doctor and one card on the Checks
// tab instead of a stop or a quiet miscount.
//
// summarize(rows)  the summary of parsed rows (raw JSON values, as in the file):
//   { rows, versions, newest, covered, newer, unknownTypes, missingUsage, otherErrors, systemErrorShapes }
//     versions      the Claude Code versions seen (entries().version), oldest first; newest the last of them
//     covered       COVERED_VERSION; newer = the newest seen is above it
//     unknownTypes  [{ type, subtype, count }] for the rows entries() reads as kind 'unknown', minus QUIET_TYPES; a type
//                   that is not a short code is '<other>', a row that is not an object '<not an object>'
//     missingUsage  assistant turns (distinct message ids, never the synthetic API error entry) without usage
//     otherErrors   [{ form, code, status, count }] API errors of kind 'other'; code is the short code or '<other>'
//     systemErrorShapes  [{ shape, count }] the shape (shapeOf) of each API error row in the system form, whatever its
//                   kind: that form is not confirmed against real data yet (fixtures README), so its shape is what the
//                   owner needs to confirm or fix the fixtures
// hasSignal(s)     something read differently than the adapter expects (unknown rows, turns without usage, unknown
//                  API errors). A newer version alone is no signal: everything still reads as expected.
// news(s)          the findings in short plain lines (no content), for doctor and the card
// fromText(text, { fromStart, maxRows })  the rows of a tail: the half line at the cut (when not fromStart) and any line
//                  that is not JSON (one being written) are skipped; the last maxRows rows are kept
// readFile(file, { bytes, maxRows })  the summary of a file's tail (transcripts.readTail), or null when it cannot be read
// shapeOf(value)   keys and value types only; a string that is a short lowercase code is kept as 'string:<code>'
// compareVersions(a, b)  numeric compare of dotted versions (-1, 0, 1)
//
// What gives no noise on purpose: QUIET_TYPES, the row types the adapter reads as 'unknown' because the queue has no
// use for them (the 2.1.317 request rows, the file history snapshot, the session summary). Content never leaves this
// file: only type names, counts, statuses and codes that match CODE (a short lowercase identifier).
//
// Pure apart from readFile, which reads through ./transcript.js. Used through the adapter (clientFor().canary) by
// lib/clientCanary.js (doctor, the Checks card, the shape log). Tested in lib/__tests__/claudeCanary.test.ts.
// =============================================================
'use strict';

const E = require('./entries.js');

/** The newest Claude Code version the fixtures (./fixtures/formats) hold; the test keeps the two in step. */
const COVERED_VERSION = '2.1.317';

/**
 * Row types the adapter reads as 'unknown' on purpose (the queue reads nothing in them), so they never count:
 *   api-request, api-request-blob, api-request-shape  the request rows of 2.1.317+ (fixture 2.1.317.jsonl, confirmed names)
 *   file-history-snapshot                             the edit snapshot (fixture pre-2.1.317.jsonl, confirmed name)
 *   summary                                           the session summary row of older versions (assumed, not in a fixture)
 * A type that turns out to be harmless in real transcripts goes here, with where it was seen.
 */
const QUIET_TYPES = Object.freeze(['api-request', 'api-request-blob', 'api-request-shape', 'file-history-snapshot', 'summary']);

/** A short code: lowercase letters, digits, underscore and hyphen, at most 40 characters. Anything else is content. */
const CODE = /^[a-z][a-z0-9_-]{0,39}$/;
const codeOr = (x, other = '<other>') => (typeof x === 'string' && CODE.test(x) ? x : other);

/** How many rows a tail keeps, and how many bytes it reads (a long tool result can be a few hundred kB). */
const TAIL_ROWS = 400;
const TAIL_BYTES = 512 * 1024;
/** How deep shapeOf goes: deeper objects are 'object'. */
const SHAPE_DEPTH = 3;

/** Numeric compare of dotted versions: 2.1.40 < 2.1.317. A missing part counts as 0. */
function compareVersions(a, b) {
  const pa = String(a).split('.').map((x) => parseInt(x, 10) || 0);
  const pb = String(b).split('.').map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** The shape of a value: keys (sorted) and types, a short code kept as 'string:<code>', never another value. */
function shapeOf(v, depth = 0) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return v.length ? [shapeOf(v[0], depth + 1)] : [];
  if (typeof v === 'object') {
    if (depth > SHAPE_DEPTH) return 'object';
    const out = {};
    for (const k of Object.keys(v).sort()) out[codeOr(k, '<key>')] = shapeOf(v[k], depth + 1);
    return out;
  }
  if (typeof v === 'string') return CODE.test(v) ? `string:${v}` : 'string';
  return typeof v;
}

/** Counts by a key, in first-seen order. */
function counter() {
  const map = new Map();
  return {
    add(key, item) {
      const k = JSON.stringify(key);
      const x = map.get(k);
      if (x) x.count++;
      else map.set(k, { ...item, count: 1 });
    },
    list: () => [...map.values()],
  };
}

/** The canary summary of parsed transcript rows (see the header). Never throws. */
function summarize(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const versions = new Set();
  const unknown = counter();
  const errors = counter();
  const shapes = counter();
  const withUsage = new Set();
  const without = new Set();
  for (const raw of list) {
    const e = E.entry(raw);
    if (e.version) versions.add(e.version);
    if (e.kind === 'unknown') {
      const isObject = raw !== null && typeof raw === 'object' && !Array.isArray(raw);
      const type = isObject ? codeOr(e.type) : '<not an object>';
      if (!QUIET_TYPES.includes(type)) {
        const subtype = e.subtype == null ? null : codeOr(e.subtype);
        unknown.add([type, subtype], { type, subtype });
      }
    }
    if (e.kind === 'assistant' && e.messageId != null && !e.synthetic && !e.apiError) {
      if (e.usage) withUsage.add(e.messageId);
      else without.add(e.messageId);
    }
    if (e.apiError) {
      if (e.apiError.kind === 'other') {
        const code = codeOr(e.apiError.code);
        const status = Number.isFinite(e.apiError.status) ? e.apiError.status : null;
        errors.add([e.apiError.form, code, status], { form: e.apiError.form, code, status });
      }
      if (e.apiError.form === 'system') {
        const shape = shapeOf(raw);
        // The common entry fields say nothing about the error's form.
        for (const k of ['uuid', 'parentUuid', 'timestamp', 'sessionId', 'agentId', 'cwd', 'isSidechain', 'userType', 'gitBranch'])
          delete shape[k];
        shapes.add(shape, { shape });
      }
    }
  }
  const sorted = [...versions].sort(compareVersions);
  const newest = sorted.length ? sorted[sorted.length - 1] : null;
  return {
    rows: list.length,
    versions: sorted,
    newest,
    covered: COVERED_VERSION,
    newer: newest != null && compareVersions(newest, COVERED_VERSION) > 0,
    unknownTypes: unknown.list(),
    // A turn streamed over several rows counts once; one with usage on any of its rows has usage.
    missingUsage: [...without].filter((id) => !withUsage.has(id)).length,
    otherErrors: errors.list(),
    systemErrorShapes: shapes.list(),
  };
}

/** Did the canary see something the adapter reads differently than expected? */
function hasSignal(s) {
  return !!s && ((s.unknownTypes?.length ?? 0) > 0 || (s.missingUsage ?? 0) > 0 || (s.otherErrors?.length ?? 0) > 0);
}

/** The findings in short plain lines, no content. Empty when there is nothing new. */
function news(s) {
  if (!s) return [];
  const out = [];
  if (s.newer) out.push(`Claude Code ${s.newest} is newer than the formats the fixtures cover (${s.covered})`);
  if (s.unknownTypes?.length)
    out.push(`row types Ravenseat does not know: ${s.unknownTypes.map((u) => `${u.type}${u.subtype ? `/${u.subtype}` : ''} (${u.count})`).join(', ')}`);
  if (s.missingUsage) out.push(`${s.missingUsage} assistant turn(s) without token usage`);
  if (s.otherErrors?.length)
    out.push(`API errors of an unknown kind: ${s.otherErrors.map((x) => `${x.code}${x.status != null ? ` ${x.status}` : ''} (${x.count})`).join(', ')}`);
  return out;
}

/** The rows of a tail (see the header). */
function fromText(text, { fromStart = true, maxRows = TAIL_ROWS } = {}) {
  const lines = String(text ?? '').split(/\r?\n/);
  if (!fromStart) lines.shift(); // the half line at the cut
  const rows = [];
  for (const l of lines) {
    if (!l.trim()) continue;
    const r = E.parse(l);
    if (r !== undefined) rows.push(r); // a line that is not JSON is being written, or was cut
  }
  return rows.slice(-maxRows);
}

/** The summary of a file's tail, or null when it cannot be read. */
function readFile(file, { bytes = TAIL_BYTES, maxRows = TAIL_ROWS } = {}) {
  const tail = require('./transcript.js').readTail(file, bytes);
  if (!tail) return null;
  return summarize(fromText(tail.text, { fromStart: tail.fromStart, maxRows }));
}

module.exports = { COVERED_VERSION, QUIET_TYPES, TAIL_ROWS, TAIL_BYTES, compareVersions, shapeOf, summarize, hasSignal, news, fromText, readFile };
