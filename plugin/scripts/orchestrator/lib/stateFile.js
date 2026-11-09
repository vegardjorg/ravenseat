// =============================================================
// stateFile.js: the safe write of queue.json (cli/context.mjs write) and the recovery hint when it does not parse.
//
// WHY: queue.json is the queue. It is written as a temporary file and renamed over the old one (atomic on one disk),
// but two things could still lose it:
//   - Windows: a rename over a file another process has open (the board reading it, an antivirus or indexer scan)
//     fails with EPERM, EBUSY or EACCES for a moment. One failed rename used to fail the whole command after the
//     change was made in memory. renameWithRetry tries a few more times with a short backoff.
//   - A bad write or a hand edit that breaks the JSON: there was no copy of the state before it. keepPrevious copies
//     the current file to queue.json.prev before each write, but only when it parses (the previous GOOD state), so a
//     broken file never overwrites the last good copy.
// recoveryHint is the text read() and `ravenseat doctor` show when queue.json does not parse and queue.json.prev does. The
// queue never restores the copy by itself: the owner looks first (the copy is one write older).
//
// Used by: cli/context.mjs (write, read), cli/doctor.mjs (checkState). Tested in: lib/__tests__/queueStateSafety.test.ts.
// =============================================================

const nodeFs = require('node:fs');

/** The codes a rename on Windows gives while another process holds the target open for a moment. */
const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** A blocking sleep (the CLI is synchronous; the waits are tens of milliseconds). */
function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * fs.renameSync with retries on EPERM, EBUSY and EACCES: `tries` attempts in all, waiting 25, 50, 100 ... ms between
 * them. Any other error, or the last failed attempt, is thrown as it is.
 * @param {string} from
 * @param {string} to
 * @param {{ fs?: { renameSync: Function }, tries?: number, baseMs?: number, sleep?: (ms: number) => void }} [o]
 */
function renameWithRetry(from, to, o = {}) {
  const f = o.fs ?? nodeFs;
  const tries = Math.max(1, o.tries ?? 6);
  const baseMs = o.baseMs ?? 25;
  const sleep = o.sleep ?? sleepMs;
  for (let i = 1; ; i++) {
    try {
      f.renameSync(from, to);
      return i;
    } catch (e) {
      if (i >= tries || !RETRY_CODES.has(e?.code)) throw e;
      sleep(baseMs * 2 ** (i - 1));
    }
  }
}

/** The path of the previous-state copy. */
const prevPath = (file) => `${file}.prev`;

/** Does the file exist and hold valid JSON? */
function parses(file, f = nodeFs) {
  try {
    JSON.parse(f.readFileSync(file, 'utf8'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Copies `file` to `<file>.prev` (through a temporary file and a rename) when it exists and parses. Never throws: a
 * failed copy must not stop the write it protects.
 * @param {string} file
 * @param {{ fs?: typeof nodeFs }} [o]
 * @returns {boolean} whether a copy was made
 */
function keepPrevious(file, o = {}) {
  const f = o.fs ?? nodeFs;
  try {
    const text = f.readFileSync(file, 'utf8');
    JSON.parse(text);
    const tmp = `${prevPath(file)}.${process.pid}.tmp`;
    f.writeFileSync(tmp, text);
    renameWithRetry(tmp, prevPath(file), { fs: f });
    return true;
  } catch {
    return false;
  }
}

/**
 * Writes `text` to `file` safely: the previous good state to <file>.prev, then a temporary file renamed over it
 * (with retries).
 * @param {string} file
 * @param {string} text
 * @param {{ fs?: typeof nodeFs }} [o]
 */
function writeState(file, text, o = {}) {
  const f = o.fs ?? nodeFs;
  keepPrevious(file, { fs: f });
  // The rolling copies at a few ages (lib/stateSnapshots.js), of the state BEFORE this write; o.snapshots = the tiers.
  if (o.snapshots?.length) require('./stateSnapshots.js').roll(file, o.snapshots, { fs: f });
  const tmp = `${file}.${process.pid}.tmp`;
  f.writeFileSync(tmp, text);
  try {
    renameWithRetry(tmp, file, { fs: f });
  } catch (e) {
    try {
      f.rmSync(tmp, { force: true });
    } catch {
      /* the temporary file is left; doctor's hint names queue.json.*.tmp */
    }
    throw e;
  }
}

/**
 * The hint when `file` does not parse: names <file>.prev when that one parses (with its task count and time), else
 * null. Shown by read() and `ravenseat doctor`.
 * @param {string} file
 * @param {{ fs?: typeof nodeFs }} [o]
 * @returns {string|null}
 */
function recoveryHint(file, o = {}) {
  const f = o.fs ?? nodeFs;
  const prev = prevPath(file);
  let q;
  try {
    q = JSON.parse(f.readFileSync(prev, 'utf8'));
  } catch {
    return null;
  }
  const n = Array.isArray(q?.tasks) ? `${q.tasks.length} task(s)` : 'no tasks list';
  const when = typeof q?.changed === 'string' ? `, changed ${q.changed}` : '';
  return (
    `${prev} holds the previous good state (${n}${when}; one write older). Look at it, then copy it over the ` +
    `broken file: cp "${prev}" "${file}" (PowerShell: Copy-Item "${prev}" "${file}").`
  );
}

module.exports = { RETRY_CODES, renameWithRetry, prevPath, parses, keepPrevious, writeState, recoveryHint };
