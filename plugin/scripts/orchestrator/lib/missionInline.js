// =============================================================
// missionInline.js: when a long inline mission moves out of queue.json (roadmap 2c3 MISSION-INLINE-MAX).
//
// Why: a task without documents keeps its whole text in queue.json (`mission`, owner decision 2026-11-19), and
// queue.json is read and written by every CLI command and every board refresh. A mission longer than
// queue.missionInlineMax characters (default 16000; 0 turns it off) is written to <dataFolder>/mission/<id>.md by add
// and edit (edit-many does not take a mission), the same place and form the board and batch pack use, and the task
// stores the path. The agent's
// mission build (cli/context.mjs missionFile/readMission, cli/tracks.mjs trackFile) reads that file as it always read
// a mission file, so the agent sees the very same text.
//
// The rules here are pure (the file system is passed in for the tests); the write itself is cli/context.mjs
// moveLongMission, under the queue lock.
//
//   inlineMax(config)            the limit in characters: a whole number >= 0, otherwise the default
//   needsMove(mission, max)      true when the mission is a string longer than max (and max is not 0)
//   sizeKb(text)                 the UTF-8 size in KB, rounded, at least 1 (for the NOTE line)
//   chooseFile(dir, id, text)    the file to use: <id>.md when free or already holding this text; otherwise the first
//                                free <id>+N.md (N = 2, 3, ...). A file with other text is never overwritten.
//   noteLine(moved)              the one INFO line add and edit print
//
// Used by: cli/context.mjs (moveLongMission), cli/tasks.mjs (add), cli/taskEdit.mjs (edit).
// Tested in: lib/__tests__/missionInlineMax.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** The default limit in characters (queue.missionInlineMax in lib/queueConfig.js STANDARD says the same). */
const DEFAULT_MAX = 16000;

// How many names chooseFile tries before it refuses (<id>.md, then <id>+2.md up to <id>+999.md). Each edit that sends
// a new long text for the same task takes the next name, because the old file is never overwritten.
const MAX_TRIES = 999;

/**
 * The limit from the merged config. A value that is not a whole number >= 0 reads as the default (it stops nothing,
 * so a typo must not turn it off; doctor names the broken value).
 * @param {object} config the merged queue.config.json (lib/queueConfig.js config())
 * @returns {number} characters; 0 = off
 */
function inlineMax(config) {
  const v = config?.queue?.missionInlineMax;
  return Number.isInteger(v) && v >= 0 ? v : DEFAULT_MAX;
}

/**
 * Should this mission move to a file? Only a string, only when the limit is on, only when it is longer than the limit.
 * A path is short, so a mission that is already a file path never moves again.
 * @param {unknown} mission
 * @param {number} max
 */
function needsMove(mission, max) {
  return typeof mission === 'string' && max > 0 && mission.length > max;
}

/** The size of the text in KB (UTF-8 bytes / 1024), rounded, and at least 1 so the line never says 0 KB. */
function sizeKb(text) {
  return Math.max(1, Math.round(Buffer.byteLength(String(text), 'utf8') / 1024));
}

/**
 * The file a moved mission goes to, in `dir` (<dataFolder>/mission).
 *   - <id>.md does not exist: use it.
 *   - <id>.md holds exactly this text (a retry, or the same text sent again): reuse it, write nothing.
 *   - <id>.md holds other text (the board's or batch pack's mission, or an earlier move): never overwritten. The next
 *     free <id>+2.md, <id>+3.md, ... is used instead. `+` cannot occur in a task id (lib/logic/validate.js), so the name
 *     never collides with another task's own <id>.md.
 *   - A folder or anything else that is not a file under a name is skipped the same way.
 * @param {string} dir
 * @param {string} id
 * @param {string} text
 * @param {{ fsLike?: { statSync: Function, readFileSync: Function } }} [o] the file system (tests pass a fake one)
 * @returns {{ file: string, reused: boolean, renamed: boolean } | { error: string }}
 */
function chooseFile(dir, id, text, { fsLike = fs } = {}) {
  for (let n = 1; n <= MAX_TRIES; n++) {
    const file = path.join(dir, n === 1 ? `${id}.md` : `${id}+${n}.md`);
    let stat = null;
    try {
      stat = fsLike.statSync(file);
    } catch (e) {
      if (e?.code !== 'ENOENT') return { error: `could not check ${file} (${e?.code ?? e?.message ?? e})` };
    }
    if (!stat) return { file, reused: false, renamed: n > 1 };
    if (!stat.isFile()) continue;
    let now;
    try {
      now = fsLike.readFileSync(file, 'utf8');
    } catch {
      continue; // unreadable: treated as other text, so it is left alone
    }
    if (now === text) return { file, reused: true, renamed: n > 1 };
  }
  return {
    error:
      `no free file name for the mission in ${dir} (${id}.md to ${id}+${MAX_TRIES}.md all hold other text). ` +
      'Move old mission files away, or shorten the mission.',
  };
}

/**
 * The INFO line add and edit print for a moved mission (never in --answer-json output, where the
 * same facts are the missionMoved field).
 * @param {{ id: string, path: string, kb: number, renamed?: boolean, reused?: boolean, taken?: string }} m
 *   taken: the stored form of <id>.md, named when the mission went to another name
 */
function noteLine(m) {
  let s = `NOTE: ${m.id}: the mission (${m.kb} KB) was moved to ${m.path} to keep queue.json small; the agent reads it as before.`;
  if (m.renamed && m.taken) s += ` ${m.taken} already holds other text, so it was left as it is.`;
  if (m.reused) s += ' The file already held this text.';
  return s;
}

module.exports = { DEFAULT_MAX, MAX_TRIES, inlineMax, needsMove, sizeKb, chooseFile, noteLine };
