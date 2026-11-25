// =============================================================
// lib/store/fileBackend.js: how a stored record becomes a file, in ONE place (LAGRING-1a step 2,
// plans/lagring-gjennomgang-2026-11-24.md "Backends").
//
// WHY: about 45 places wrote their own temporary file and renamed it. They differed in the small things that decide
// whether a crash leaves a mess: only queue.json kept a .prev copy, only queue.json removed its tmp file when the rename
// failed (and none when the write itself failed, as on a full disk), and all but the board used <file>.<pid>.tmp, so two
// writes in one process could meet on the same name. This file does it the safe way once:
//   writeText  mkdir, <file>.prev of the last good state when asked (backup 'prev'), a UNIQUE tmp name
//              (<file>.<pid>.<hex>.tmp), the write, renameWithRetry (Windows EPERM/EBUSY/EACCES), and the tmp file
//              removed on ANY failure, the write's or the rename's. The old file is untouched until the rename.
//   readJson   the parse with the family's onCorrupt rule: fail (throw with the restore hint), empty (the fallback),
//              restorePrev (the .prev copy when it parses, never written back by itself).
//
// Efficiency (plan "Efficiency wins"): a per-process cache keyed on mtime and size.
//   * readJson with { cache: true } hands back the value it parsed before when the file has not changed. Only for
//     read-only callers: the value is shared, so a caller that changes it must read without the cache.
//   * keepPrevious copies the file without parsing it when this process already knows the bytes on disk are good JSON
//     (it wrote them, or parsed them, at the same mtime and size). Before, every queue.json write parsed it once more.
//
// Used by: lib/store/index.js, lib/stateFile.js (writeState), lib/gateEvidence.js, lib/ownerLog.js, lib/approvalWait.js,
// cli/catalog.mjs. Tested in: lib/__tests__/store.test.ts, lib/__tests__/queueStateSafety.test.ts.
// =============================================================
'use strict';

const crypto = require('node:crypto');
const nodeFs = require('node:fs');
const path = require('node:path');

const SF = require('../stateFile.js');

/**
 * A unique temporary name next to `file`: <file>.<pid>.<12 hex>.tmp (doctor and the sweep know the pid in it). `pid`
 * is the writer's (a simulated process on the memory backend), this process by default.
 */
function tmpName(file, pid = process.pid) {
  return `${file}.${pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
}

// ---- the per-process cache -----------------------------------------------------------------------------------------

/**
 * Per fs object: file -> { mtimeMs, size, good: true, value?: any } for the version of the file this process last saw.
 * Per fs, so two memory backends (or a test's wrapped fs) with the same path and the same clock never share an entry.
 */
let seenByFs = new WeakMap();
function seenOf(f) {
  let m = seenByFs.get(f);
  if (!m) {
    m = new Map();
    seenByFs.set(f, m);
  }
  return m;
}

/** The stat key of a file now, or null when it cannot be read. */
function statOf(file, f = nodeFs) {
  try {
    const s = f.statSync(file);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}
const sameStat = (a, b) => !!a && !!b && a.mtimeMs === b.mtimeMs && a.size === b.size;

/** Records that the bytes of `file` as they are now are good JSON (and, when given, what they parse to). */
function markGood(file, f = nodeFs, value) {
  const st = statOf(file, f);
  if (!st) return;
  seenOf(f).set(path.resolve(file), { ...st, good: true, ...(value !== undefined ? { value } : {}) });
}

/**
 * markGood, but only when the file still has the stat `before` (taken before the caller read it): a file replaced
 * between the stat and the read is never marked.
 */
function markGoodIf(file, before, f = nodeFs) {
  if (before && sameStat(before, statOf(file, f))) markGood(file, f);
}

/** The cache entry for `file` when it still describes the file on disk. */
function cached(file, f = nodeFs) {
  const hit = seenOf(f).get(path.resolve(file));
  return hit && sameStat(hit, statOf(file, f)) ? hit : null;
}

/** Forgets everything (tests). */
const clearCache = () => {
  seenByFs = new WeakMap();
};

// ---- writes -----------------------------------------------------------------------------------------------------------

/**
 * Copies `file` to `<file>.prev` when it holds good JSON: never a broken file over the last good copy. Without a parse
 * when this process already knows the bytes are good. Never throws: a failed copy must not stop the write it protects.
 * o.bytes: the file's content the caller already read (lib/store/index.js commit hashes it), so a large file such as
 * queue.json is read once per write, not twice.
 * @returns {boolean} whether a copy was made
 */
function keepPrevious(file, o = {}) {
  const f = o.fs ?? nodeFs;
  const known = cached(file, f);
  let tmp = null;
  try {
    const text = o.bytes ?? f.readFileSync(file, 'utf8');
    if (!known) JSON.parse(String(text));
    const prev = SF.prevPath(file);
    tmp = tmpName(prev, o.pid);
    f.writeFileSync(tmp, text);
    SF.renameWithRetry(tmp, prev, { fs: f });
    return true;
  } catch {
    if (tmp)
      try {
        f.rmSync(tmp, { force: true });
      } catch {
        /* left for doctor's orphan row and ravenseat store sweep --tmp */
      }
    return false;
  }
}

/**
 * Writes `text` to `file` atomically. Options:
 *   backup     'prev' keeps <file>.prev of the last good state first
 *   before     a function run after the backup and before the write (writeState rolls the snapshots there)
 *   json       true when `text` is JSON (the cache then knows the new file is good, for the next .prev copy)
 *   mkdir      false skips creating the folder
 *   fs         an fs object (tests inject failures; the memory backend)
 *   pid        the writer's pid in the tmp name (the memory backend's simulated process)
 * Throws what the write or the rename threw, after removing the tmp file. The old file is untouched then.
 */
function writeText(file, text, o = {}) {
  const f = o.fs ?? nodeFs;
  if (o.mkdir !== false) f.mkdirSync(path.dirname(file), { recursive: true });
  if (o.backup === 'prev') keepPrevious(file, { fs: f, pid: o.pid });
  if (typeof o.before === 'function') o.before(f);
  const tmp = tmpName(file, o.pid);
  try {
    f.writeFileSync(tmp, text);
    SF.renameWithRetry(tmp, file, { fs: f });
  } catch (e) {
    try {
      f.rmSync(tmp, { force: true });
    } catch {
      /* left for doctor's orphan row and ravenseat store sweep --tmp */
    }
    throw e;
  }
  if (o.json) markGood(file, f);
  else seenOf(f).delete(path.resolve(file));
}

/** JSON with 2-space indent and a final newline (the format every family had). */
const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** writeText of a value as JSON. */
function writeJson(file, value, o = {}) {
  writeText(file, jsonText(value), { ...o, json: true });
}

// ---- reads -----------------------------------------------------------------------------------------------------------

/** The error a reader with onCorrupt 'fail' throws: the parse error and the way back. */
class StoreCorruptError extends Error {
  constructor(file, cause, hint) {
    super(
      `${path.basename(file)} does not parse (${file}): ${cause?.message ?? cause}\n  ` +
        (hint ?? `No good copy at ${SF.prevPath(file)}; restore it from a backup.`),
    );
    this.name = 'StoreCorruptError';
    this.code = 'ESTORECORRUPT';
    this.file = file;
  }
}

/**
 * Reads and parses `file`. A missing file gives `fallback`. A file that does not parse follows `onCorrupt`:
 *   fail         throws StoreCorruptError with the restore hint (lib/stateFile.js recoveryHint, `describe` names what
 *                the .prev copy holds)
 *   empty        `fallback`
 *   restorePrev  the .prev copy's value when it parses, else `fallback` (the broken file stays as it is)
 * `cache: true` returns the value parsed before when the file has not changed (read-only callers only).
 */
function readJson(file, { onCorrupt = 'fail', fallback = null, describe, cache = false, fs: f = nodeFs } = {}) {
  if (cache) {
    const hit = cached(file, f);
    if (hit && 'value' in hit) return hit.value;
  }
  let text;
  try {
    text = f.readFileSync(file, 'utf8');
  } catch (e) {
    if (e?.code === 'ENOENT') return fallback;
    throw e;
  }
  try {
    const value = JSON.parse(String(text).replace(/^﻿/, ''));
    markGood(file, f, cache ? value : undefined);
    return value;
  } catch (e) {
    if (onCorrupt === 'fail') throw new StoreCorruptError(file, e, SF.recoveryHint(file, { fs: f, describe }));
    if (onCorrupt === 'restorePrev') {
      try {
        return JSON.parse(f.readFileSync(SF.prevPath(file), 'utf8'));
      } catch {
        return fallback;
      }
    }
    return fallback;
  }
}

module.exports = { tmpName, keepPrevious, writeText, writeJson, jsonText, readJson, statOf, markGood, markGoodIf, clearCache, StoreCorruptError };
