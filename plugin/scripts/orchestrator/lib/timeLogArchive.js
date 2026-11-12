// =============================================================
// timeLogArchive.js: the monthly rotation of the time log and the reading across its archives (owner decision B5,
// history.rotateTimeLog in queue.config.json).
//
// Why: the time log (config().timeLog, default scripts/.queue/times.jsonl) is appended to by every hook, gate run and
// command, and nothing ever trimmed it. The budget guard, the context hook, start, fill, show and the board read it whole,
// so every command got slower each week. Rotation keeps the current file to about one month; a reader whose window is
// short reads only that, and a reader that needs everything reads the archives too, so no number changes.
//
// THE FILES: next to the log, one archive per rotation, named after the UTC month of the file's last write (its mtime):
// times.jsonl -> times-2026-10.jsonl. A second archive for the same month (rotation turned off and on, or a log copied
// in) is times-2026-10.2.jsonl, never a write over the first. An archive holds rows written up to the end of its month
// (most of them inside the month; a log left idle holds older ones too).
//
// WHEN: lazily, on the first write of a new UTC month (appendText, which every writer of the log calls), never from a
// background job. Before an append the writer stats the log: a file whose mtime is in an earlier month is due.
//
// SAFE UNDER CONCURRENT WRITERS: the rotation itself is one rename, which is atomic. The rotators agree through a lock
// folder next to the log (<log>.rotate-lock, the owner token and takeover rule of lib/queueLock.js, waited on for at most
// 2 s), and the one that gets it stats again before it renames, so two rotators never move a file twice and a new file
// written by another process in the meantime is never moved over an archive. Writers append without the lock: a writer
// that saw an old-month mtime goes to the lock first, so an append outside it lands either in the old file before the
// rename (it is then in the archive) or in the new file; the append itself is O_APPEND, as before. Nothing is copied, so a
// row is never doubled; nothing is truncated, so a row is never lost.
// A CRASH: before the rename nothing changed; after it the current file is simply missing until the next write creates
// it, and readText reads the archives meanwhile. A lock left by a dead process is taken over (queueLock's rule). When
// the rotation cannot run (lock busy, rename refused on Windows), the row is appended to the current file and the next
// write tries again.
//
// READING (readText): the archives oldest first, then the current file, as one text. With `from` (a window's start, ms
// or ISO) an archive whose month ended more than MARGIN_MS before it is skipped. The margin is there because the usage
// rows are cumulative per agent (timeCost.usageEvents takes the growth since the agent's previous row): an agent's
// earlier row in an older file must still be read. MARGIN_MS is 7 days; an agent running for longer than that across a
// month boundary would be counted from its first row in the window (no agent runs that long). Without `from` everything
// is read. Without any file at all it throws the ENOENT of the current file, as fs.readFileSync did, so the callers'
// "no time log yet" paths stay the same.
//
// Tested in lib/__tests__/timeLogArchive.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MODES = Object.freeze(['monthly', 'off']);
const DAY_MS = 86_400_000;
/** How long before a window's start an archive must have ended to be skipped (see READING in the header). */
const MARGIN_MS = 7 * DAY_MS;
/** How long a rotator waits for another one before it leaves the rotation to the next write. */
const LOCK_WAIT_MS = 2_000;

/** 'YYYY-MM' (UTC) of a time in ms. */
function monthOf(ms) {
  return new Date(ms).toISOString().slice(0, 7);
}

/** The start of the month after 'YYYY-MM' (UTC), in ms: every row in that month's archive was written before it. */
function monthEnd(month) {
  const [y, m] = month.split('-').map(Number);
  return Date.UTC(y, m, 1);
}

/** The setting: 'monthly' (the default, also for an unknown value) or 'off'. */
function modeOf(config) {
  return config?.history?.rotateTimeLog === 'off' ? 'off' : 'monthly';
}

/** The setting from queue.config.json; 'monthly' when it cannot be read (a hook in an odd folder). */
function configuredMode() {
  try {
    return modeOf(require('./queueConfig.js').config());
  } catch {
    return 'monthly';
  }
}

const parts = (log) => {
  const ext = path.extname(log);
  return { dir: path.dirname(log), stem: path.basename(log, ext), ext };
};
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The lock folder the rotators share. */
function lockDir(log) {
  return `${log}.rotate-lock`;
}

/** The archive file name for a month and a number (1 = no suffix). */
function archiveName(log, month, n = 1) {
  const { dir, stem, ext } = parts(log);
  return path.join(dir, `${stem}-${month}${n > 1 ? `.${n}` : ''}${ext}`);
}

/**
 * The archives next to the log, oldest first: [{ file, month, n, endMs, size }].
 */
function archives(log) {
  const { dir, stem, ext } = parts(log);
  const re = new RegExp(`^${escapeRe(stem)}-(\\d{4}-\\d{2})(?:\\.(\\d+))?${escapeRe(ext)}$`);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const m = re.exec(name);
    if (!m) continue;
    const file = path.join(dir, name);
    let size = 0;
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) continue;
      size = st.size;
    } catch {
      continue;
    }
    out.push({ file, month: m[1], n: m[2] ? Number(m[2]) : 1, endMs: monthEnd(m[1]), size });
  }
  return out.sort((a, b) => a.month.localeCompare(b.month) || a.n - b.n);
}

/** Is the log due: it exists, has content and was last written in an earlier UTC month than `now`? */
function dueMonth(log, now) {
  let st;
  try {
    st = fs.statSync(log);
  } catch {
    return null;
  }
  if (!st.isFile() || st.size === 0) return null;
  const month = monthOf(st.mtimeMs);
  return month < monthOf(now) ? month : null;
}

/** A rename with a few tries for the moment Windows holds the file (another process appending). */
function renameRetry(from, to) {
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (e) {
      if (i >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(e?.code)) throw e;
      // A short blocking pause (the CLI and the hooks are synchronous) gives the other writer time to close the file.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}

/**
 * Rotates the log when it is due (see the header). Never throws.
 * @param {string} log
 * @param {{ now?: number, mode?: 'monthly'|'off', waitMs?: number }} [o]
 * @returns {{ rotated: boolean, to?: string, reason?: string }}
 */
function rotateIfDue(log, { now = Date.now(), mode, waitMs = LOCK_WAIT_MS } = {}) {
  try {
    if (!dueMonth(log, now)) return { rotated: false };
    if ((mode ?? configuredMode()) === 'off') return { rotated: false, reason: 'off' };
    const QL = require('./queueLock.js');
    const lock = lockDir(log);
    const got = QL.acquire(lock, { waitMs });
    if (!got.ok) return { rotated: false, reason: 'lock' };
    try {
      // Again under the lock: another rotator may have moved it, and a new file may have been written since.
      const month = dueMonth(log, now);
      if (!month) return { rotated: false };
      let n = 1;
      while (fs.existsSync(archiveName(log, month, n))) n++;
      const to = archiveName(log, month, n);
      renameRetry(log, to);
      return { rotated: true, to };
    } finally {
      QL.release(lock, got.me);
    }
  } catch (e) {
    return { rotated: false, reason: e?.code ?? String(e?.message ?? e) };
  }
}

/**
 * Appends text to the log, rotating first when a new month has begun. The append throws as fs.appendFileSync does (the
 * callers decide whether that matters); the rotation never does.
 */
function appendText(log, text, o = {}) {
  rotateIfDue(log, o);
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.appendFileSync(log, text);
}

/**
 * The log's text across its archives (see READING in the header).
 * @param {string} log
 * @param {{ from?: number|string|null }} [o] the window's start; null = everything
 */
function readText(log, { from = null } = {}) {
  const fromMs = from == null ? null : typeof from === 'number' ? from : Date.parse(from);
  const list = archives(log).filter((a) => fromMs == null || !Number.isFinite(fromMs) || a.endMs + MARGIN_MS >= fromMs);
  const texts = [];
  for (const a of list) {
    try {
      texts.push(fs.readFileSync(a.file, 'utf8'));
    } catch {
      /* moved away while listing: its rows are elsewhere or gone, as with any file the reader cannot open */
    }
  }
  let current = null;
  try {
    current = fs.readFileSync(log, 'utf8');
  } catch (e) {
    if (!texts.length) throw e;
  }
  if (current != null) texts.push(current);
  // A file that ends in a half line must not glue its last row to the next file's first.
  return texts.map((t) => (t && !t.endsWith('\n') ? `${t}\n` : t)).join('');
}

/**
 * The window for reading the rows of active tasks' agents: the earliest start (ms) of the running, reviewed and picked
 * tasks in `tasks`. null (read everything) when one of them has no start time or none is active.
 */
function activeFrom(tasks) {
  const times = (Array.isArray(tasks) ? tasks : [])
    .filter((o) => ['running', 'review', 'picked'].includes(o?.status))
    .map((o) => Date.parse(o.started ?? o.picked_at ?? o.added_at ?? ''));
  if (!times.length || times.some((t) => !Number.isFinite(t))) return null;
  return Math.min(...times);
}

/** A key that changes when the current file or the set of archives changes (for the board's caches). */
function signature(log) {
  let cur = 'missing';
  try {
    const st = fs.statSync(log);
    cur = `${st.mtimeMs}:${st.size}`;
  } catch {
    /* no current file */
  }
  return [cur, ...archives(log).map((a) => `${path.basename(a.file)}:${a.size}`)].join('|');
}

const countRows = (file) => {
  try {
    const t = fs.readFileSync(file, 'utf8');
    let n = 0;
    for (const l of t.split('\n')) if (l.trim()) n++;
    return n;
  } catch {
    return 0;
  }
};

/** For doctor: { bytes, rows } of the current file and { archives, archiveBytes, archiveRows } of the archives. */
function stats(log) {
  let bytes = 0;
  try {
    bytes = fs.statSync(log).size;
  } catch {
    bytes = 0;
  }
  const list = archives(log);
  return {
    bytes,
    rows: bytes ? countRows(log) : 0,
    archives: list.length,
    archiveBytes: list.reduce((s, a) => s + a.size, 0),
    archiveRows: list.reduce((s, a) => s + countRows(a.file), 0),
  };
}

module.exports = {
  MODES,
  MARGIN_MS,
  monthOf,
  monthEnd,
  modeOf,
  lockDir,
  archiveName,
  archives,
  rotateIfDue,
  appendText,
  readText,
  activeFrom,
  signature,
  stats,
};
