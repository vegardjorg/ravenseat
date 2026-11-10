// =============================================================
// writeWarn.js: the soft warning a track gets WHILE it writes (hook-write-guard.mjs, PreToolUse on Write|Edit|NotebookEdit).
//
// Why: three things a track can do are only caught after the whole round: a change to a protected path the task does
// not own (the merge guard stops the merge, lib/mergeGuard.js), a new skip or focus marker in a test file, and a test
// file that loses its last assertion (both flagged as test weakening at receive, lib/testWeakening.js). The track then
// learns it from a review round or a stopped merge. A warning at the write itself lets the track ask the owner, or fix
// the code instead, before it builds on it.
//
// It only WARNS (additionalContext to the agent), never denies: the same judgment stays at merge and receive, with the
// diff in front of the owner and the reviewers. Same rules as there, reused, never an own copy: mergeGuard.isProtected
// (with the floor CORE_PROTECTED), the task's owned_files, shared_patch and migration block, testWeakening's markers,
// test file rule and assertion count.
// Pure apart from repoRelative (a few fs.existsSync calls). Tested in lib/__tests__/writeWarn.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const G = require('./mergeGuard.js');
const TW = require('./testWeakening.js');

/** Forward slashes, no leading ./ */
const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^(\.\/)+/, '');

/**
 * The path relative to the nearest folder above it that holds .git (a folder in a main checkout, a file in a linked
 * worktree), or null when there is none.
 */
function repoRelative(file) {
  let dir = path.dirname(path.resolve(String(file)));
  for (let i = 0; i < 40; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return norm(path.relative(dir, path.resolve(String(file))));
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

/**
 * The file text after an Edit call, or null when old_string is not in it (the call then fails anyway). Replaced by
 * position, never with String.replace, so a $ in new_string stays literal.
 */
function afterEdit(text, { old_string: from, new_string: to, replace_all: all } = {}) {
  const s = String(text ?? '');
  if (typeof from !== 'string' || !from || typeof to !== 'string') return null;
  if (!s.includes(from)) return null;
  if (all) return s.split(from).join(to);
  const i = s.indexOf(from);
  return s.slice(0, i) + to + s.slice(i + from.length);
}

/** The lines of `after` that are new: their trimmed text is not in `before` (a moved or re-indented line is not new). */
function newLines(before, after) {
  const had = new Map();
  for (const l of String(before ?? '').split(/\r?\n/)) {
    const t = l.trim();
    if (t) had.set(t, (had.get(t) ?? 0) + 1);
  }
  const out = [];
  for (const l of String(after ?? '').split(/\r?\n/)) {
    const t = l.trim();
    if (!t) continue;
    if ((had.get(t) ?? 0) > 0) had.set(t, had.get(t) - 1);
    else out.push(t);
  }
  return out;
}

/**
 * The warnings for one write.
 * @param {{ rel: string, task: object|null, before: string|null, after: string|null, protectedPaths?: string[],
 *   migrations?: object|null, dependencyFiles?: string, testSetup?: { testPaths?: string[], markers?: string[] } }} x
 *   rel: the path from the repository root; before: the file text now (null for a new file); after: the text the write
 *   leaves (null when it cannot be known, e.g. a notebook)
 * @returns {{ kind: 'protected'|'marker'|'emptied', text: string }[]}
 */
function assessTrackWrite({
  rel,
  task,
  before,
  after,
  protectedPaths,
  migrations = null,
  dependencyFiles = 'stop',
  testSetup = {},
  hotspots = [],
  tasks = [],
}) {
  const p = norm(rel);
  if (!p) return [];
  const out = [];

  // Shared config (lib/hotspots.js) the task has not agreed in hotspot_patch: the merge stops on it.
  const H = require('./hotspots.js');
  if (task && H.unagreed([p], task, hotspots).length)
    out.push({
      kind: 'hotspot',
      text:
        `Write guard (warning): ${p} is a hotspot (shared config, hotspots in queue.config.json) that task ${task.id} has ` +
        'not agreed in its hotspot_patch. The merge guard stops the merge on it. Leave the file as it is and write a wiring ' +
        'spec in your report instead (what to add where); the orchestrator makes that change after the merge.',
    });
  // A file another active task owns: that task is building on it now, and the merge stops on it.
  const foreign = task ? G.foreignOwners([p], task, tasks) : [];
  if (foreign.length)
    out.push({
      kind: 'foreign',
      text:
        `Write guard (warning): ${p} is owned by ${foreign[0].owner}, another active task, which is building on it now. ` +
        'The merge guard stops the merge on it. Leave it alone, and write in your report what you would have needed changed there.',
    });

  if (task) {
    const owned = [...(task.owned_files ?? []), ...(task.shared_patch ?? [])].map(norm).filter(Boolean);
    const isOwned = owned.some((e) => (e.endsWith('/') ? p.startsWith(e) : p === e)) || G.migrCovered(p, task.migr_block ?? null, migrations);
    // A dependency file under dependencyFiles "warn" only gets a warning at merge, so it gets none here.
    const r = !isOwned ? G.assessGuard({ changes: [{ status: 'M', paths: [p] }], ownedFiles: owned, protectedPaths, dependencyFiles }) : null;
    if (r?.violations.length)
      out.push({
        kind: 'protected',
        text:
          `Write guard (warning): ${p} is a protected path that task ${task.id} does not own (owned_files, shared_patch). ` +
          'The merge guard stops the merge on it, and only the owner can let it through. If the task needs this change, ' +
          'put it as an owner question in your report instead of building on it.',
      });
  }

  const extra = testSetup?.testPaths ?? [];
  if (after != null && TW.isTestFile(p, extra)) {
    const markers = [...TW.MARKERS, ...TW.extraMarkers(testSetup?.markers)];
    const hits = newLines(before, after)
      .map((l) => ({ l, m: markers.find((x) => x.re.test(l)) }))
      .filter((x) => x.m && x.m.kind !== 'todo');
    if (hits.length)
      out.push({
        kind: 'marker',
        text:
          `Write guard (warning): this adds a ${hits[0].m.kind} marker to the test file ${p} (${hits[0].l.slice(0, 120)}). ` +
          'receive flags it as test weakening for the reviewers. Fix the code or the test instead, or say in your report why the test must not run.',
      });
    const had = TW.assertionLines(before);
    if (had > 0 && TW.assertionLines(after) === 0)
      out.push({
        kind: 'emptied',
        text:
          `Write guard (warning): the test file ${p} had ${had} assertion line(s) and has none after this write. ` +
          'receive flags a test file without assertions as test weakening. Keep what the test checks, or say in your report why it goes.',
      });
  }
  return out;
}

module.exports = { repoRelative, afterEdit, newLines, assessTrackWrite };
