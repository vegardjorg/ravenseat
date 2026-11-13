// =============================================================
// stateSweep.js: removes old per-agent state files from the track hooks' folders in the OS temp folder.
//
// Why: hook-track-context.mjs (queue-track-context-guard), hook-read-guard.mjs (queue-read-hint), hook-track-end.mjs
// (queue-track-end) and hook-write-guard.mjs (queue-write-warn) each keep one small `<agent_id>.json` per agent there, and
// nothing removed them, so the folders grew with every track ever run on the machine. An agent's state is only read while
// that agent runs, so a file untouched for 7 days is dead.
//
// Rules:
//   - Only the folder it is given, never a parent or a sibling. A folder that is itself a link or junction is left alone.
//   - Only plain files named like the hooks name them (`<safe id>.json`). Links, junctions, folders and other names stay:
//     a link is never followed and never removed.
//   - At most once a day per folder: the mtime of the marker file `.last-sweep` in the folder decides, so a call that does
//     not sweep costs one stat. The marker is touched BEFORE the sweep, so hooks that run at the same time do not all sweep.
//   - Never throws. This is housekeeping inside a hook that must fail open.
//
// Used by the four hooks above, right before they write their state. Tested in lib/__tests__/stateSweep.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MARKER = '.last-sweep';
const DAY_MS = 86_400_000;
const MAX_AGE_MS = 7 * DAY_MS;
/** The names the hooks write: the agent id with unsafe characters replaced by _, plus .json. */
const OWN = /^[\w][\w.-]*\.json$/;

/**
 * Sweeps `dir` when its last sweep is a day old or more (or there was none).
 * @param {string} dir the hook's state folder
 * @param {{ now?: number, maxAgeMs?: number, everyMs?: number }} [o]
 * @returns {{ swept: boolean, removed: number }}
 */
function sweepState(dir, { now = Date.now(), maxAgeMs = MAX_AGE_MS, everyMs = DAY_MS } = {}) {
  const none = { swept: false, removed: 0 };
  try {
    if (typeof dir !== 'string' || !dir) return none;
    const marker = path.join(dir, MARKER);
    // The common case: swept less than a day ago. One stat.
    try {
      if (now - fs.statSync(marker).mtimeMs < everyMs) return none;
    } catch {
      // no marker yet: sweep below
    }
    const st = fs.lstatSync(dir, { throwIfNoEntry: false });
    if (!st || !st.isDirectory() || st.isSymbolicLink()) return none;
    // Touch the marker first: a second hook starting now sees it and skips.
    fs.writeFileSync(marker, '');
    const at = new Date(now);
    fs.utimesSync(marker, at, at);
    let removed = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      // A Dirent never follows a link: a link or junction is isSymbolicLink(), not isFile().
      if (!e.isFile() || e.name === MARKER || !OWN.test(e.name)) continue;
      const p = path.join(dir, e.name);
      try {
        const f = fs.lstatSync(p);
        if (!f.isFile() || now - f.mtimeMs <= maxAgeMs) continue;
        fs.unlinkSync(p);
        removed++;
      } catch {
        // error-ignored: a file in use or already gone stays for the next sweep
      }
    }
    return { swept: true, removed };
  } catch {
    return none; // error-ignored: housekeeping never fails the hook
  }
}

module.exports = { sweepState, MARKER, MAX_AGE_MS };
