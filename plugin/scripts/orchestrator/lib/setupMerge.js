// =============================================================
// setupMerge.js: the three-way update of the project's copies (`ravenseat setup --update`).
//
// Why: setup copies the docs and the mission template to docs/queue/ and CLAUDE.queue.md. They are the project's own
// copies and may be edited, and the mission every agent gets is built from the copy. Before this the owner could only
// replace a copy (--overwrite, losing their edits) or keep an old one (agents briefed from old instructions).
//
// How: every time setup writes a copy (or finds it equal to the plugin), it saves the plugin text it wrote as the BASE in
// <dataFolder>/setup-base/<path>. --update then compares three texts per copy: the copy now (LOCAL), the base, and the
// plugin now (UPSTREAM):
//   - no copy: copy the plugin's;              - copy equals the plugin: nothing;
//   - copy equals the base: take the plugin's (nobody edited it);
//   - plugin equals the base: keep the copy (only the owner's edits);
//   - both changed: `git merge-file`; a clean merge is written, a conflict leaves the copy untouched and saves the
//     merge with markers in <dataFolder>/setup-merge/<path> for the owner, and the base is NOT moved on;
//   - no base recorded (a copy from before bases were kept): never touched; --overwrite or an edit by hand.
// Line endings do not count (git may have turned a copy into CRLF). Tested in lib/__tests__/setupMerge.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const lf = (s) => String(s).replace(/\r\n/g, '\n');

/** The merge of three texts with `git merge-file` (temp files), or null when git is missing. */
function mergeFile(local, base, upstream) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-setup-merge-'));
  try {
    const f = (name, text) => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, lf(text));
      return p;
    };
    const r = spawnSync(
      'git',
      ['merge-file', '-p', '-L', 'your copy', '-L', 'base', '-L', 'plugin', f('local', local), f('base', base), f('upstream', upstream)],
      { encoding: 'utf8' },
    );
    // Exit 0 = clean, 1..127 = that many conflicts, other = an error.
    if (r.error || r.status == null || r.status < 0 || r.status > 127) return null;
    return { text: r.stdout, conflicts: r.status };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * What --update does with one copy.
 * @param {{ local: string|null, base: string|null, upstream: string }} x
 * @returns {{ action: 'copy'|'same'|'update'|'own-edits'|'merged'|'conflict'|'no-base', text?: string }}
 */
function threeWay({ local, base, upstream }) {
  if (local == null) return { action: 'copy', text: upstream };
  if (lf(local) === lf(upstream)) return { action: 'same' };
  if (base == null) return { action: 'no-base' };
  if (lf(local) === lf(base)) return { action: 'update', text: upstream };
  if (lf(upstream) === lf(base)) return { action: 'own-edits' };
  const m = mergeFile(local, base, upstream);
  if (!m) return { action: 'no-base' }; // without git nothing is merged; the copy stays
  return m.conflicts === 0 ? { action: 'merged', text: m.text } : { action: 'conflict', text: m.text };
}

/** Where the base and a saved conflict of a copy live (rel: the copy's path from the project root). */
const basePath = (dataFolder, rel) => path.join(dataFolder, 'setup-base', ...rel.split('/'));
const conflictPath = (dataFolder, rel) => path.join(dataFolder, 'setup-merge', ...rel.split('/'));

/** The recorded base, or null. */
function readBase(dataFolder, rel) {
  try {
    return fs.readFileSync(basePath(dataFolder, rel), 'utf8');
  } catch {
    return null;
  }
}

/** Records the plugin text as the copy's base. */
function writeBase(dataFolder, rel, text) {
  const p = basePath(dataFolder, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}

module.exports = { threeWay, mergeFile, basePath, conflictPath, readBase, writeBase };
