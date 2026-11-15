// =============================================================
// queueShare.js: the queue's files in git, off by default and an allow list when on (queue.config.json share, H3).
//
// WHY: the data folder (dataFolder, scripts/.queue/ by default) holds harmless data, queue.json and the plan register,
// next to sensitive data: the time log, missions and prompt files, reports, transcript extracts, the owner's answers and
// questions, locks, the gate evidence and the setup record. Some owners want queue.json in git as a backup (useful in a
// private repo). So:
//   off (default)   everything in the data folder is private, as before: setup ignores the whole folder.
//   on              only the files in share.include may be tracked. Setup, `ravenseat share on` and `doctor --fix` write
//                   `<dataFolder>/*` and `!<dataFolder>/<file>` per file: an allow list, not a block list.
//   never           a hardcoded list (NEVER) that cannot be shared whatever include says; an include naming one is refused
//                   with the reason. Private does not mean secret: everyone with access, and every fork, sees the files.
// The guard (push hook and merge, owner decision 2026-11-15: refuse, never ask, since it is a settings breach and not a
// possible false positive): a commit that tracks a file in the data folder that include does not list, or anything under
// a private path (lib/privatePaths.js), is refused. With share on, a repo that is public or of unknown visibility
// (lib/repoVisibility.js, the cache) is refused too until the owner confirms with `share on --public-ok`, so a repo that
// turned public after a private confirmation never passes quietly.
//
//   STANDARD_INCLUDE, NEVER
//   includeProblem(name, cfg)  why a name cannot be in include, or null
//   shareOf(cfg)               { on, include (the valid names), publicOk, problems }
//   ignoreLines(cfg)           the .gitignore lines while on ([] while off)
//   sharedFile(file, cfg)      is this repo-relative file one that may be tracked?
//   editGitignore(text, o)     the .gitignore text with lines removed and the missing ones added, EOL kept
//   breaches(files, cfg)       [{ file, kind: 'data'|'private' }] for repo-relative files a commit tracks
//   publicReason(cfg, cache)   why a push is refused on the repo's visibility, or null
//   denyReason({ files, cfg, cache, cli })   the one text the push hook and merge give, or null
//
// Pure. Used by: setup.mjs, cli/share.mjs, cli/merge.mjs, cli/doctorBaseline.mjs, hook-push-guard.mjs.
// Tested in: lib/__tests__/queueShare.test.ts.
// =============================================================
'use strict';

const path = require('node:path');

const PP = require('./privatePaths.js');
const RV = require('./repoVisibility.js');

/** What `share on` lists when --include is not given: the queue and the plan register (cli/context.mjs PLAN_FILE). */
const STANDARD_INCLUDE = Object.freeze(['queue.json', 'plans.json']);

/** The header setup writes over the lines it adds (the same one since the first version, so a file is recognised). */
const HEADER = "# Ravenseat (the queue's data, the agents' worktrees and local secrets)";

/**
 * The files that are never shared, as tests on the lower-cased file name with the reason. Broad on purpose: a file the
 * queue adds later under one of these names stays private without a change here.
 */
const NEVER = Object.freeze([
  { test: (n, log) => /^times(-.*)?\.jsonl$/.test(n) || (log && n === log), why: 'the time log (who worked on what, when, and the cost)' },
  { test: (n) => n === 'setup-tips.json' || n === 'setup.json' || n.startsWith('setup-'), why: 'the setup record (setup-tips.json and what setup wrote)' },
  { test: (n) => n === 'missions' || n.endsWith('.md') || /mission|prompt|handover|bundle/.test(n), why: 'a mission or prompt file' },
  { test: (n) => /report|result/.test(n), why: 'a report (also track-result.md)' },
  { test: (n) => /transcript|excerpt/.test(n), why: 'a transcript extract' },
  { test: (n) => /owner|answer|question/.test(n), why: "the owner's answers and questions" },
  { test: (n) => /lock/.test(n), why: 'a lock' },
  { test: (n) => /evidence/.test(n), why: 'an evidence store (the gate evidence decides what may be pushed)' },
  { test: (n) => /key|token|secret/.test(n), why: 'the board key or another secret' },
]);

const dataFolderOf = (cfg) => PP.projectPath(cfg?.dataFolder ?? 'scripts/.queue');

/** Why `name` cannot be in share.include, or null. Only a plain file name in the data folder, never one in NEVER. */
function includeProblem(name, cfg = {}) {
  if (typeof name !== 'string' || !name.trim() || /[\\/*?[\]!]/.test(name) || name === '.' || name === '..')
    return `${JSON.stringify(name)} is not a plain file name in the data folder (no folders, no patterns)`;
  const n = name.trim().toLowerCase();
  const log = typeof cfg?.timeLog === 'string' ? path.posix.basename(cfg.timeLog.replace(/\\/g, '/')).toLowerCase() : null;
  const hit = NEVER.find((x) => x.test(n, log));
  return hit ? `${name} can never be shared: it is ${hit.why}` : null;
}

/** The share setting as read: on only when queueData is exactly true; include holds the valid names only. */
function shareOf(cfg = {}) {
  const s = cfg?.share && typeof cfg.share === 'object' ? cfg.share : {};
  const raw = Array.isArray(s.include) ? s.include : [...STANDARD_INCLUDE];
  const problems = [];
  const include = [];
  for (const name of raw) {
    const why = includeProblem(name, cfg);
    if (why) problems.push(why);
    else if (!include.includes(name.trim())) include.push(name.trim());
  }
  return { on: s.queueData === true, include, publicOk: s.publicOk === true, problems };
}

/** The .gitignore lines while share is on: the folder's content, then one exception per file. [] while off. */
function ignoreLines(cfg) {
  const s = shareOf(cfg);
  const df = dataFolderOf(cfg);
  if (!s.on || !df) return [];
  return [`${df}/*`, ...s.include.map((f) => `!${df}/${f}`)];
}

/** May this repo-relative file be tracked under the share setting (it is in the data folder and in include)? */
function sharedFile(file, cfg) {
  const s = shareOf(cfg);
  const df = dataFolderOf(cfg);
  if (!s.on || !df) return false;
  return s.include.some((f) => file === `${df}/${f}`);
}

/**
 * The .gitignore text after the edit, with the line ending the file already uses:
 *   remove          exact lines to take out (the plain folder line while share is on: git cannot re-include a file in an
 *                   ignored folder), unless `required` holds them;
 *   keepExceptions  the `!<dataFolder>/<file>` lines that may stay; every other exception for the data folder goes;
 *   required        lines that must be there; the missing ones are appended under the Ravenseat header.
 * Other lines are never touched. Returns { text, added, removed }.
 */
function editGitignore(text, { required = [], remove = [], keepExceptions = [], dataFolder } = {}) {
  const src = String(text ?? '');
  const eol = /\r\n/.test(src) ? '\r\n' : '\n';
  const lines = src.length ? src.replace(/\r?\n$/, '').split(/\r?\n/) : [];
  const need = new Set(required);
  const df = PP.projectPath(dataFolder);
  const removed = [];
  const kept = lines.filter((l) => {
    const t = l.trim();
    if (need.has(t)) return true;
    const exception = df && t.startsWith(`!${df}/`) && !keepExceptions.includes(t.slice(df.length + 2));
    if (remove.includes(t) || exception) {
      removed.push(t);
      return false;
    }
    return true;
  });
  const have = new Set(kept.map((l) => l.trim()));
  const added = required.filter((l) => !have.has(l));
  let out = kept.length ? `${kept.join(eol)}${eol}` : '';
  if (added.length) out += `${out ? eol : ''}${HEADER}${eol}${added.join(eol)}${eol}`;
  if (!removed.length && !added.length) return { text: src, added, removed };
  return { text: out, added, removed };
}

/**
 * The files a commit may not track: in the data folder and not shared (kind data), or under a private path (kind
 * private). `files` are repo-relative with forward slashes.
 */
function breaches(files, cfg) {
  const df = dataFolderOf(cfg);
  const out = [];
  for (const raw of files ?? []) {
    const file = String(raw).replace(/\\/g, '/');
    if (df && (file === df || file.startsWith(`${df}/`)) && !sharedFile(file, cfg)) out.push({ file, kind: 'data' });
    else if (PP.matching(file, cfg)) out.push({ file, kind: 'private' });
  }
  return out;
}

/**
 * Why a push is refused on the repo's visibility, or null: only while share is on and the owner has not confirmed a
 * public repo (share.publicOk). `cache` is lib/repoVisibility.js readCache (any age), or null when nothing is known.
 */
function publicReason(cfg, cache, cli = 'ravenseat') {
  const s = shareOf(cfg);
  if (!s.on || s.publicOk || RV.isPrivate(cache?.visibility)) return null;
  const shared = s.include.join(', ');
  if (!cache)
    return (
      `share is on (${shared} in git), and the repo's visibility is not known, which counts as public. ` +
      `Check it with ${cli} share status; for a public repo confirm with ${cli} share on --public-ok --yes, or turn it off with ${cli} share off.`
    );
  return (
    `share is on (${shared} in git), and the repo is ${cache.visibility === 'public' ? 'public' : 'of unknown visibility (counted as public)'} ` +
    `while share was confirmed for a private one: anyone can read those files. Confirm again with ${cli} share on --public-ok --yes, ` +
    `or ${cli} share off (and git rm --cached the files).`
  );
}

/**
 * The one refusal text for the push hook and merge, or null. Names the files, never their content.
 * The visibility rule (publicReason) applies when the range carries a shared file: that is what would become readable
 * to anyone. A push without one goes out as before (the files already pushed are named by `share status`).
 */
function denyReason({ files, cfg, cache, cli = 'ravenseat' }) {
  const b = breaches(files, cfg);
  const parts = [];
  if (b.length) {
    const shown = (kind) => b.filter((x) => x.kind === kind).map((x) => x.file);
    const data = shown('data');
    const priv = shown('private');
    const list = (xs) => `${xs.slice(0, 8).join(', ')}${xs.length > 8 ? ` and ${xs.length - 8} more` : ''}`;
    const what = [];
    if (data.length)
      what.push(
        `the queue's data folder (${shareOf(cfg).on ? `not in share.include: ${list(data)}` : `private while share is off: ${list(data)}`})`,
      );
    if (priv.length) what.push(`a private path (privatePaths: ${list(priv)})`);
    parts.push(
      `A commit tracks what must stay out of git: ${what.join('; ')}. Take it out: git rm --cached -r -- <file> (keeps it on disk), ` +
        `commit, and try again. To share a queue file on purpose: ${cli} share on --include <file>.`,
    );
  }
  const pub = (files ?? []).some((f) => sharedFile(String(f).replace(/\\/g, '/'), cfg)) ? publicReason(cfg, cache, cli) : null;
  if (pub) parts.push(pub);
  return parts.length ? parts.join(' Also: ') : null;
}

module.exports = {
  STANDARD_INCLUDE,
  NEVER,
  HEADER,
  includeProblem,
  shareOf,
  ignoreLines,
  sharedFile,
  editGitignore,
  breaches,
  publicReason,
  denyReason,
  dataFolderOf,
};
