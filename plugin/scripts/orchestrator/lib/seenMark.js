// =============================================================
// seenMark.js: the server-side "last seen" mark, <dataFolder>/seen.json { at, by, previous } (roadmap 3e, AW-3).
//
// Why: "since you left" needs one cut that the board, `ravenseat since` and Claude share. Before this the only last
// visit time was a browser's localStorage, written whenever the tab was hidden, so a board left open on a second screen
// all night never moved it and the CLI could not see it. The mark is set only by an explicit act (owner answer 3):
//   board  the Decisions room with the "Since you left" band on screen for a few seconds, or its "Mark seen" button
//          (POST /api/seen, queue-board.mjs)
//   cli    `ravenseat since --mark`
// Never by a page hide or a key press. `previous` is the mark before, kept for a reader that wants the window just seen.
//
// Fail open: a missing or broken file reads as no mark (the window falls back to 24 hours, lib/awaySummary.js), and a
// write that fails returns { ok: false } instead of throwing, since the mark is a convenience and must never stop work.
// Tested in lib/__tests__/seenMark.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { renameWithRetry } = require('./stateFile.js');

const SEEN_FILE = 'seen.json';
/** Who may set the mark. */
const SEEN_BY = Object.freeze(['board', 'cli']);

/** The mark, or null (no file, not JSON, or no valid time). */
function readSeen(folder) {
  try {
    const x = JSON.parse(fs.readFileSync(path.join(folder, SEEN_FILE), 'utf8'));
    if (!x || typeof x !== 'object' || !Number.isFinite(Date.parse(x.at ?? ''))) return null;
    return {
      at: x.at,
      by: SEEN_BY.includes(x.by) ? x.by : null,
      previous: Number.isFinite(Date.parse(x.previous ?? '')) ? x.previous : null,
    };
  } catch {
    return null;
  }
}

/**
 * Sets the mark to `now` (atomic: a temporary file, then a rename).
 * @returns {{ ok: true, seen: { at: string, by: string, previous: string|null } } | { ok: false, error: string }}
 */
function writeSeen(folder, { by, now = Date.now() } = {}) {
  if (!SEEN_BY.includes(by)) return { ok: false, error: `by must be ${SEEN_BY.join(' or ')}` };
  const seen = { at: new Date(now).toISOString(), by, previous: readSeen(folder)?.at ?? null };
  const file = path.join(folder, SEEN_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(seen, null, 2)}\n`);
    renameWithRetry(tmp, file);
    return { ok: true, seen };
  } catch (e) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* nothing to clean */
    }
    return { ok: false, error: e?.code ?? 'could not write' };
  }
}

module.exports = { SEEN_FILE, SEEN_BY, readSeen, writeSeen };
