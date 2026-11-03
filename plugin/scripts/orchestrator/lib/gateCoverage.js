// =============================================================
// gateCoverage.js: what a gate run could see beyond the commit, for the evidence entry (lib/gateEvidence.js).
//
// Why: the evidence is keyed on the commit, but the commands can read more than the commit has: untracked and ignored
// files, and the folders shared by a link (node_modules, sharedLinks in the config). The same sha can then give another
// result (__tests__/gateCoverageTamper.test.ts shows it). Forbidding such files would break ordinary worktrees, so the
// entry says what was there: how many, never which (for size and privacy no file name or content is stored).
//
// Read BEFORE the first gate command: this is what the run could depend on, not the build output it left behind, and no
// git status-like command runs after track code had its chance to plant something (lib/gitExecSurface.js).
//
// shared_links: the configured links that ARE links in this worktree. `lock_hash` is the sha256 of the lockfile beside
// the link; since that file is usually tracked, it says little on its own. `target_lock_hash` is the lockfile beside the
// link's target, present only when it differs: the shared folder was then installed from another lockfile than the
// commit asks for.
//
// Pure except lockHash, sharedLinksIn and readCoverage. Tested in lib/__tests__/gateCoverage.test.ts and
// __tests__/gateCoverageTamper.test.ts.
// =============================================================
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** The lockfiles looked for beside a shared link, the first one found counts. */
const LOCK_FILES = ['package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'];

/** The paths from `git ls-files -z` output, with "/" and no trailing slash (a collapsed folder has one). Pure. */
function splitPaths(text) {
  return String(text ?? '')
    .split('\0')
    .map((p) => p.split('\\').join('/').replace(/\/+$/, ''))
    .filter(Boolean);
}

/** How many of the paths are not one of the links (a link shows up as untracked or ignored itself). Pure. */
function countOutside(paths, links) {
  const skip = new Set(links);
  return paths.filter((p) => !skip.has(p)).length;
}

/** The sha256 of the first lockfile in a folder, or null when it has none. */
function lockHash(folder) {
  for (const name of LOCK_FILES) {
    try {
      return crypto.createHash('sha256').update(fs.readFileSync(path.join(folder, name))).digest('hex');
    } catch {
      // not this one
    }
  }
  return null;
}

/**
 * The configured links that are links in this worktree, with the lockfile hashes (the header). A real folder at that
 * path (the main checkout, or an install in the worktree) is not shared and not listed.
 * @param {string} top the worktree's root
 * @param {string[]} links config().sharedLinks through trackLinks (relative, with "/")
 * @returns {{ path: string, lock_hash?: string, target_lock_hash?: string }[]}
 */
function sharedLinksIn(top, links) {
  const out = [];
  for (const rel of links) {
    const file = path.join(top, ...rel.split('/'));
    try {
      if (!fs.lstatSync(file).isSymbolicLink()) continue; // Node reports NTFS junctions as symbolic links
    } catch {
      continue; // no such path
    }
    const here = lockHash(path.dirname(file));
    let there = null;
    try {
      there = lockHash(path.dirname(fs.realpathSync(file)));
    } catch {
      // a dangling link: nothing to compare with
    }
    out.push({ path: rel, ...(here ? { lock_hash: here } : {}), ...(there && there !== here ? { target_lock_hash: there } : {}) });
  }
  return out;
}

/**
 * What the run can see beyond the commit. `untracked` counts every untracked, not ignored file; `ignoredPresent` counts
 * ignored paths, with a whole ignored folder as one (so a real node_modules stays cheap). The shared links themselves are
 * not counted. A count is null when git could not tell. Never throws.
 * @param {{ top: string, links: string[], git: (...args: string[]) => string|null }} o `git` runs in the worktree's root
 * @returns {{ sharedLinks: object[], untracked: number|null, ignoredPresent: number|null }}
 */
function readCoverage({ top, links, git }) {
  const sharedLinks = sharedLinksIn(top, links);
  const skip = sharedLinks.map((l) => l.path);
  const count = (text) => (text == null ? null : countOutside(splitPaths(text), skip));
  return {
    sharedLinks,
    untracked: count(git('ls-files', '-z', '--others', '--exclude-standard')),
    ignoredPresent: count(git('ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory', '--no-empty-directory')),
  };
}

module.exports = { LOCK_FILES, splitPaths, countOutside, lockHash, sharedLinksIn, readCoverage };
