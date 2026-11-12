// =============================================================
// instructionNotice.js: the one-time chat message about the size of Claude's instructions, for hook-context.mjs
// (UserPromptSubmit, the owner's prompts).
//
// Why: doctor shows the size only when someone runs it. The owner should also hear it once in the chat, in plain words,
// when the always-loaded set first passes instructionSize.maxChars, and again only when it has grown by more than a tenth
// since then (GROWTH), so it never nags. The text goes to the owner as systemMessage, never into the model's context:
// that would add to the very thing it is about. Quiet guidance and instructionSize.mode off stop it; quiet does not use it
// up, so it shows if guidance turns guided again.
//
// The hook runs on every prompt, so the set is not read again while nothing changed: <dataFolder>/instruction-size.json
// keeps every path the last measurement looked at (files and folders, also those that did not exist) with its mtime and
// size, and a stat of each is all a hit costs. A new CLAUDE.local.md or rules folder changes the stat of a path that was
// looked at, so it is seen. The cache lives in the data folder, not in queue.json: the hook would otherwise take the
// queue lock on the owner's prompts. lib/instructionSize.js uses only node built-ins, so requiring it is cheap; the cost
// guarded here is reading the files.
//
// Tested in lib/__tests__/instructionNotice.test.ts and lib/__tests__/contextGuard.test.ts (the hook process).
// =============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CACHE_FILE = 'instruction-size.json';
/** Shown again only when the set has grown by more than this share since the last notice. */
const GROWTH = 0.1;

/** The stat of a path as the cache compares it: mtime and size, or '-' when it does not exist. */
function stamp(p) {
  try {
    const s = fs.statSync(p, { throwIfNoEntry: false });
    return s ? `${s.mtimeMs}:${s.isDirectory() ? 'd' : s.size}` : '-';
  } catch {
    return '?';
  }
}

const signature = (watched) => watched.map((w) => [w.path, stamp(w.path)]);
const same = (a, b) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x[0] === b[i][0] && x[1] === b[i][1]);

function readCache(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(file, data) {
  try {
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  } catch {
    // error-ignored: the cache only saves work; without it the next prompt measures again
  }
}

/** The text for the owner. */
function noticeText(total, limits, cli) {
  const IS = require('./instructionSize.js');
  const limit =
    limits.maxChars === IS.MAX_CHARS
      ? `over the ${IS.n(IS.MAX_CHARS)} where Claude Code itself warns`
      : `over your limit of ${IS.n(limits.maxChars)} (instructionSize.maxChars)`;
  return [
    `Claude's instructions in this project are about ${IS.n(total.tokens)} tokens (${IS.n(total.chars)} chars in ` +
      `${total.files} ${total.files === 1 ? 'file' : 'files'}), ${limit}.`,
    'They load on every turn, every track and every subagent, so they cost tokens all the time and take attention from',
    'the task at hand. Long files are followed less well, and a rule written in two places drifts when one copy is fixed.',
    '@ imports do not help: they load anyway. What works is to keep only the rules that apply everywhere in the root and',
    'move area rules to .claude/rules/<topic>.md with paths:, which load when Claude works on those files.',
    `${cli} instructions proposes a split and changes nothing. Turn off: ${cli} settings set instructionSize.mode off`,
  ].join(' ');
}

/**
 * The notice to show now, or null. Records what it measured and what it showed in the cache.
 * @param {{ folder: string, root: string, config: object, quiet: () => boolean, cli: string, now?: number,
 *   measure?: (root: string) => { total: { chars: number, files: number, tokens: number }, watched: { path: string }[] } }} o
 *   quiet: asked only when the set is over the limit (it reads queue.json). measure: lib/instructionSize.js measureDisk
 *   by default; tests count the calls.
 */
function check(o) {
  const own = o.config?.instructionSize ?? {};
  if (own.mode === 'off') return null;
  const IS = require('./instructionSize.js');
  const limits = IS.limitsOf(o.config);
  const file = path.join(o.folder, CACHE_FILE);
  const cache = readCache(file) ?? {};
  let total = cache.root === o.root && same(cache.sig, signature(cache.watched ?? [])) ? cache.total : null;
  let changed = false;
  if (!total) {
    const m = (o.measure ?? ((r) => IS.measureDisk(r)))(o.root);
    const watched = m.watched.map((w) => ({ path: w.path }));
    Object.assign(cache, { root: o.root, watched, sig: signature(watched), total: m.total });
    total = m.total;
    changed = true;
  }
  let text = null;
  const last = cache.notified;
  if (total.chars > limits.maxChars && (!last || total.chars > last.chars * (1 + GROWTH)) && !o.quiet()) {
    text = noticeText(total, limits, o.cli);
    cache.notified = { chars: total.chars, at: new Date(o.now ?? Date.now()).toISOString() };
    changed = true;
  }
  if (changed) writeCache(file, cache);
  return text;
}

module.exports = { CACHE_FILE, GROWTH, check, noticeText };
