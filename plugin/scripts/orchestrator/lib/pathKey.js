// =============================================================
// lib/pathKey.js: one comparable form for a path, for every guard that asks "is this the same file" or "is this inside
// that folder" (ARK-1 T4, architecture review C).
//
//   abs(p, { platform })            absolute, "/" separators, no trailing slash; on win32 Git Bash's /c/x is C:/x
//   key(p, { platform, real })      abs, then the real path of the longest part that exists (a link or junction into a
//                                   folder compares as that folder), then case folded where the file system folds
//   keys(p, o)                      both forms a guard checks: the folders resolved with the last part as written, and
//                                   the whole path resolved (a file link compares both as its name and as its target)
//   folds(platform)                 win32 and darwin fold case by default (NTFS, APFS); linux does not
//   rel(p, root, o) / rels(...)     the path below root in key form ("a/b", "" for root itself), or null when outside;
//                                   rels gives it for every form in keys
//   inside(a, b, o)                 a is b or below it (in key form)
//   shown(p, root, o)               the path as a message shows it: below root in the case it was written, else abs
//
// Why: the guards each lower-cased "on Windows" only, so on macOS a write to `claude.md` passed the protection for
// `CLAUDE.md` in a main tree spelled the same way, and the same for a folder named in another case. `platform` is
// injectable so the tests can run the macOS rules anywhere. The real path uses the host's file system whatever
// `platform` says; `real: false` skips it (a path that is only text).
// Pure apart from fs.realpathSync (no writes); never throws.
// =============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** Does the platform's default file system fold case? */
const folds = (platform = process.platform) => platform === 'win32' || platform === 'darwin';

/** Absolute with "/" separators and no trailing slash; on win32 Git Bash's /c/x is C:/x. */
function abs(p, { platform = process.platform } = {}) {
  let s = String(p ?? '');
  if (platform === 'win32') {
    const gb = /^\/([a-zA-Z])(\/|$)/.exec(s);
    if (gb) s = `${gb[1]}:/${s.slice(3)}`;
  }
  return path.resolve(s).replace(/\\/g, '/').replace(/(.)\/+$/, '$1');
}

/** The real path of the longest part of `a` (abs form) that exists, with the rest appended as written. */
function realOf(a) {
  const parts = [];
  let cur = a;
  for (let i = 0; i < 256; i++) {
    try {
      const r = fs.realpathSync.native(cur).replace(/\\/g, '/').replace(/(.)\/+$/, '$1');
      return parts.length ? `${r}/${parts.reverse().join('/')}` : r;
    } catch {
      const up = path.posix.dirname(cur);
      if (up === cur || !up) return a; // nothing of it exists: as written
      parts.push(path.posix.basename(cur));
      cur = up;
    }
  }
  return a;
}

/** The comparable form of a path (see the header). */
function key(p, { platform = process.platform, real = true } = {}) {
  const a = abs(p, { platform });
  const r = real ? realOf(a) : a;
  return folds(platform) ? r.toLowerCase() : r;
}

/**
 * Both comparable forms of a file path, without repeats: the folders resolved with the last part as written (a
 * `CLAUDE.md` that is a link to `AGENTS.md` is still named CLAUDE.md), then the whole path resolved (a link that points
 * at a guarded file is that file). A guard checks each.
 */
function keys(p, { platform = process.platform, real = true } = {}) {
  const a = abs(p, { platform });
  if (!real) return [key(a, { platform, real: false })];
  const parent = path.posix.dirname(a);
  const leafAsWritten = parent === a ? realOf(a) : `${realOf(parent).replace(/\/$/, '')}/${path.posix.basename(a)}`;
  const fold = (s) => (folds(platform) ? s.toLowerCase() : s);
  return [...new Set([fold(leafAsWritten), fold(realOf(a))])];
}

/** Every form of `p` below `root` (keys), in key form ("" for root itself); empty when it is not inside. */
function rels(p, root, o = {}) {
  if (!p || !root) return [];
  const r = key(root, o);
  const base = r.endsWith('/') ? r : `${r}/`; // a drive root ("c:/") already ends with one
  const out = [];
  for (const k of keys(p, o)) {
    const x = k === r ? '' : k.startsWith(base) ? k.slice(base.length) : null;
    if (x != null && !out.includes(x)) out.push(x);
  }
  return out;
}

/** `p` below `root` in key form ("" for root itself), or null when it is not inside. */
const rel = (p, root, o = {}) => rels(p, root, o)[0] ?? null;

/** `a` is `b` or inside it. */
const inside = (a, b, o = {}) => rel(a, b, o) != null;

/**
 * The path as a message shows it: below root in the case it was written (the same number of trailing parts as rel
 * gives), else the absolute path.
 */
function shown(p, root, o = {}) {
  const r = rel(p, root, o);
  const a = abs(p, o);
  if (r == null || r === '') return a;
  const n = r.split('/').length;
  return a.split('/').slice(-n).join('/');
}

module.exports = { folds, abs, key, keys, rel, rels, inside, shown };
