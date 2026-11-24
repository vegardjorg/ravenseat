// =============================================================
// lib/store/logBackend.js: the log families of the storage layer (JSON lines, append only): append, last and byId with
// a small sidecar index (LAGRING step 5, plans/lagring-gjennomgang-2026-11-24.md: "Sidecar for last F-id and agent
// start rows: O(1) instead of full scans").
//
//   append(file, row|text, { rotate })   one whole line in one write. A file that ends in half a line (a writer that died
//                                        in the middle) gets a newline first, so the next row is never glued to it
//                                        (torn-tail repair; the half line stays as one bad line the readers skip).
//                                        rotate: 'monthly' goes through lib/timeLogArchive.js appendText (the monthly
//                                        archive), else a plain append.
//   last(file, n)                        the last n rows (parsed, bad lines skipped), oldest first, read from the end of
//                                        the file in chunks: the cost is the rows asked for, not the file.
//   indexOf(file, spec)                  the sidecar index's state (see below); byId(file, spec, key) one entry of it.
//
// THE SIDECAR: <file>.<spec.name>.idx, { version, size, headLen, head, state }. `size` is how many bytes of the log the
// state covers; `head` a hash of the log's first headLen bytes. The state is trusted only while the log still starts
// with those bytes and is at least `size` long: then only the bytes after `size` are read and folded in (spec.reduce).
// Anything else (no sidecar, a broken one, a rotated or rewritten log, a shorter log) rebuilds the state from spec.seed
// (what the archives hold) and the whole current file. Only complete lines are folded in, so a row being written is
// read on the next call.
//
// Why this is safe without a lock: the log only grows, and a sidecar always describes an exact prefix of it. Two writers
// that update the sidecar at once each write a state for some prefix; whichever rename lands last is still right for its
// prefix, and the next reader folds in the rest. A failed sidecar write is ignored (the next call reads a little more).
//
// Families (lib/store/families.js 'log-index'): findings.jsonl.lastid.idx (findingLog: the highest F-id, so append no
// longer parses every archive under its lock) and times.jsonl.starts.idx (hook-time.mjs: the wave an agent started in,
// instead of reading the last week of the time log on every SubagentStop).
//
// Used by: lib/findingLog.js, hook-time.mjs. Tested in: lib/__tests__/logBackend.test.ts.
// =============================================================
'use strict';

const crypto = require('node:crypto');
const nodeFs = require('node:fs');
const path = require('node:path');

const FB = require('./fileBackend.js');

const VERSION = 1;
/** How much of the log's start the sidecar's head hash covers. */
const HEAD_BYTES = 512;
/** The chunk last() reads backwards with. */
const TAIL_CHUNK = 64 * 1024;

const sidecarOf = (file, name) => `${file}.${name}.idx`;
const hashOf = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32);

/** Bytes [from, to) of a file, or an empty buffer. */
function readRange(file, from, to, f = nodeFs) {
  const len = Math.max(0, to - from);
  if (!len) return Buffer.alloc(0);
  let fd;
  try {
    fd = f.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    const n = f.readSync(fd, buf, 0, len, from);
    return buf.subarray(0, n);
  } finally {
    if (fd !== undefined) f.closeSync(fd);
  }
}

function sizeOf(file, f = nodeFs) {
  try {
    return f.statSync(file).size;
  } catch {
    return null;
  }
}

/** Parses the complete lines of a buffer; returns the rows (bad lines skipped) and how many bytes were complete lines. */
function completeRows(buf) {
  const end = buf.lastIndexOf(0x0a);
  if (end < 0) return { rows: [], used: 0 };
  const rows = [];
  for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
    const l = line.trim();
    if (!l) continue;
    try {
      rows.push(JSON.parse(l));
    } catch {
      /* a torn or foreign line: skipped, as every reader of these logs does */
    }
  }
  return { rows, used: end + 1 };
}

/**
 * Appends one row (an object, or a line of text) as one write. See the header on torn-tail repair and rotate.
 * Throws as fs.appendFileSync does.
 */
function append(file, row, { rotate = null, now = Date.now(), fs: f = nodeFs } = {}) {
  let text = typeof row === 'string' ? row : JSON.stringify(row);
  if (!text.endsWith('\n')) text += '\n';
  const size = sizeOf(file, f);
  if (size) {
    const lastByte = readRange(file, size - 1, size, f);
    if (lastByte.length && lastByte[0] !== 0x0a) text = `\n${text}`;
  }
  if (rotate) {
    require('../timeLogArchive.js').appendText(file, text, { now, mode: rotate });
    return;
  }
  f.mkdirSync(path.dirname(file), { recursive: true });
  f.appendFileSync(file, text);
}

/** The last n rows of a log (current file only), oldest first. [] when it is missing. */
function last(file, n, { fs: f = nodeFs } = {}) {
  const want = Math.max(0, Math.floor(Number(n) || 0));
  const size = sizeOf(file, f);
  if (!want || !size) return [];
  let from = size;
  let buf = Buffer.alloc(0);
  // Read backwards until the buffer holds more than `want` line ends (or the whole file).
  for (;;) {
    const start = Math.max(0, from - TAIL_CHUNK);
    buf = Buffer.concat([readRange(file, start, from, f), buf]);
    from = start;
    let ends = 0;
    for (const b of buf) if (b === 0x0a) ends++;
    if (from === 0 || ends > want) break;
  }
  // Drop a first line cut by the chunk (unless the read began at the start of the file).
  if (from > 0) buf = buf.subarray(buf.indexOf(0x0a) + 1);
  // The last line without its newline (being written, or torn) is not a row yet.
  const { rows } = completeRows(buf);
  return rows.slice(-want);
}

/**
 * The sidecar index's state for `file`.
 * @param {string} file
 * @param {{ name: string, init: () => any, reduce: (state: any, row: any) => any, seed?: (file: string) => any }} spec
 *   init: the empty state; reduce: folds one row in (returns the state); seed: the state of what came before the
 *   current file (its archives), used on a rebuild (default init()).
 * @param {{ fs?: object }} [o]
 */
function indexOf(file, spec, { fs: f = nodeFs } = {}) {
  const size = sizeOf(file, f);
  const side = sidecarOf(file, spec.name);
  if (size == null) return spec.seed ? spec.seed(file) : spec.init();
  let saved = null;
  try {
    saved = JSON.parse(f.readFileSync(side, 'utf8'));
  } catch {
    saved = null;
  }
  let state;
  let from;
  const trusted =
    saved &&
    saved.version === VERSION &&
    Number.isInteger(saved.size) &&
    Number.isInteger(saved.headLen) &&
    saved.size <= size &&
    saved.headLen <= size &&
    saved.headLen === Math.min(HEAD_BYTES, saved.size) &&
    hashOf(readRange(file, 0, saved.headLen, f)) === saved.head;
  if (trusted) {
    state = saved.state;
    from = saved.size;
  } else {
    state = spec.seed ? spec.seed(file) : spec.init();
    from = 0;
  }
  const { rows, used } = completeRows(readRange(file, from, size, f));
  for (const r of rows) state = spec.reduce(state, r);
  const covered = from + used;
  if (!trusted || used > 0) {
    const headLen = Math.min(HEAD_BYTES, covered);
    try {
      FB.writeText(side, `${JSON.stringify({ version: VERSION, size: covered, headLen, head: hashOf(readRange(file, 0, headLen, f)), state })}\n`, { fs: f, json: true });
    } catch {
      // error-ignored: the index is a shortcut; the next call reads from the last good sidecar or rebuilds
    }
  }
  return state;
}

/** One entry of an index whose state is a map ({ [key]: value }): byId(file, spec, key). null when it is not there. */
function byId(file, spec, key, o) {
  const state = indexOf(file, spec, o);
  const map = spec.map ? spec.map(state) : state;
  return map && Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
}

// ---- the two indexes in use ----------------------------------------------------------------------------------------

const F_ID = /^F-([1-9][0-9]*)$/;
/** How long an agent's start row is kept in the starts index (the old scan read the last week too). */
const START_KEEP_MS = 8 * 86_400_000;

/** The rows of the archives of `file` (lib/timeLogArchive.js), oldest first; `sinceMs` skips archives that ended before. */
function archiveRows(file, sinceMs = null) {
  const TA = require('../timeLogArchive.js');
  const rows = [];
  for (const a of TA.archives(file)) {
    if (sinceMs != null && a.endMs < sinceMs) continue;
    try {
      rows.push(...completeRows(Buffer.from(`${nodeFs.readFileSync(a.file, 'utf8')}\n`)).rows);
    } catch {
      /* moved away while listing */
    }
  }
  return rows;
}

/** findings.jsonl: the highest F-id (ids only grow, across the monthly archives). */
const FINDINGS_LAST_ID = {
  name: 'lastid',
  init: () => ({ lastId: 0 }),
  reduce(state, r) {
    const m = r && typeof r === 'object' ? F_ID.exec(String(r.id ?? '')) : null;
    if (m && typeof r.caught_by === 'string') state.lastId = Math.max(state.lastId, Number(m[1]));
    return state;
  },
  seed(file) {
    const state = { lastId: 0 };
    for (const r of archiveRows(file)) FINDINGS_LAST_ID.reduce(state, r);
    return state;
  },
};

/** times.jsonl: per agent_id, the newest start row's { wave, track, time } (hook-time.mjs reads the wave at done). */
const AGENT_STARTS = {
  name: 'starts',
  init: () => ({ newest: null, starts: {} }),
  map: (state) => state?.starts ?? {},
  reduce(state, r) {
    if (!r || r.event !== 'start' || !r.agent_id || !r.wave) return state;
    const t = Date.parse(r.time ?? '');
    state.starts[r.agent_id] = { wave: r.wave, track: r.track ?? null, time: r.time ?? null };
    if (Number.isFinite(t) && (!state.newest || t > Date.parse(state.newest))) {
      state.newest = r.time;
      // Drop what is older than the keep window, measured from the newest row (the clock of the log, not of the reader).
      for (const [k, v] of Object.entries(state.starts)) if (Date.parse(v.time ?? '') < t - START_KEEP_MS) delete state.starts[k];
    }
    return state;
  },
  seed(file) {
    const state = AGENT_STARTS.init();
    for (const r of archiveRows(file, Date.now() - START_KEEP_MS)) AGENT_STARTS.reduce(state, r);
    return state;
  },
};

module.exports = { VERSION, HEAD_BYTES, START_KEEP_MS, sidecarOf, append, last, indexOf, byId, completeRows, FINDINGS_LAST_ID, AGENT_STARTS };
