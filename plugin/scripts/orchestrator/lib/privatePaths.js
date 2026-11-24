// =============================================================
// privatePaths.js: the project's own private folders and files (queue.config.json privatePaths, H4).
//
// WHY: a project often has folders that must never reach git or the agents, such as internal notes or a business folder.
// Until now the rule lived only as text in the project's CLAUDE.md, and cloudHidden was a second list for a related
// purpose. One list now drives four things, so they cannot disagree:
//   1. .gitignore: setup, `ravenseat private add` and `doctor --fix` write each path (setup.mjs requiredIgnores);
//   2. the push and merge guard refuse a commit that tracks something under one (lib/queueShare.js breaches);
//   3. read: false: the read guard (hook-read-guard.mjs) denies the queue's agents (tracks, reviewers) a Read there; the
//      main session is never stopped;
//   4. the cloud does not see them (cloudHiddenOf, lib/logic/cloud.js).
// Filling the list is turning the guard on, so it is off by default (an empty list) like the other new checks.
// The list is also meant for the folders of what agents make (roadmap T11), which can add entries here later.
//
// An entry is a project-relative path, "docs/notes/" (a folder) or "notes.txt", or { "path": "...", "read": false }.
// A path ending in / is a folder; without it, the path and everything under it match.
//
//   projectPath(p)            a project-relative path in gitignore form, or null (absolute, outside, empty)
//   entries(cfg)              [{ path, line, read }] for the valid entries; problems(cfg) the rest in words
//   matching(file, cfg)       the entry a repo-relative file falls under, or null
//   readDenied(abs, { root, cfg })   the read: false entry an absolute path falls under (main tree or an agent worktree)
//   cloudHiddenOf(cfg)        cloudHidden plus the private paths, one list
//   addEntry(list, p, { read }) / removeEntry(list, p)   the config list after `ravenseat private add|remove`
//
// Used by: lib/queueShare.js, setup.mjs, cli/private.mjs, hook-read-guard.mjs, lib/logic/cloud.js.
// Tested in: lib/__tests__/queueShare.test.ts.
// =============================================================
'use strict';

const path = require('node:path');
const PK = require('./pathKey.js');

/**
 * A project-relative path in gitignore form (forward slashes, no leading ./ or trailing /), or null when it is empty,
 * absolute or outside the project (then the project's .gitignore has no say over it).
 * @param {unknown} p
 */
function projectPath(p) {
  if (typeof p !== 'string' || !p.trim()) return null;
  const s = p.trim().replace(/\\/g, '/');
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s)) return null;
  const n = path.posix.normalize(s).replace(/^(\.\/)+/, '').replace(/\/+$/, '');
  if (!n || n === '.' || n === '..' || n.startsWith('../')) return null;
  return n;
}

/** One entry read: { path, line, read } or { error }. */
function readEntry(e) {
  const raw = typeof e === 'string' ? e : e && typeof e === 'object' && !Array.isArray(e) ? e.path : undefined;
  if (typeof raw !== 'string') return { error: `privatePaths: ${JSON.stringify(e)} is not a path or { "path": ..., "read": false }` };
  const p = projectPath(raw);
  if (!p) return { error: `privatePaths: "${raw}" is not a path inside the project` };
  if (/[*?[\]!]/.test(p)) return { error: `privatePaths: "${raw}" has a pattern character; name the folder or file itself` };
  const folder = raw.trim().replace(/\\/g, '/').endsWith('/');
  return { path: p, line: folder ? `${p}/` : p, read: !(typeof e === 'object' && e.read === false) };
}

const listOf = (cfg) => (Array.isArray(cfg?.privatePaths) ? cfg.privatePaths : []);

/** The valid entries, in order, each path once (a later duplicate is left out). */
function entries(cfg) {
  const out = [];
  for (const e of listOf(cfg)) {
    const r = readEntry(e);
    if (!r.error && !out.some((x) => x.path === r.path)) out.push(r);
  }
  return out;
}

/** The entries that cannot be used, in words (doctor's config row and `private list` name them). */
const problems = (cfg) => listOf(cfg).map(readEntry).filter((r) => r.error).map((r) => r.error);

/** Is the repo-relative `file` the entry's path or under it? */
const under = (file, entry) => file === entry.path || file.startsWith(`${entry.path}/`);

/** The entry a repo-relative file falls under, or null. */
function matching(file, cfg) {
  const f = String(file ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
  return entries(cfg).find((e) => under(f, e)) ?? null;
}

/**
 * The repo-relative forms of an absolute path: from the main tree, and from inside an agent worktree there. In
 * lib/pathKey.js key form (ARK-1 T4): the real path, case folded on win32 AND darwin.
 */
function relativeForms(abs, root, platform = process.platform) {
  const out = [];
  for (const rel of PK.rels(abs, root, { platform })) {
    if (!rel) continue;
    const m = /^\.claude\/worktrees\/[^/]+\/(.+)$/.exec(rel);
    const form = m ? m[1] : rel;
    if (!out.includes(form)) out.push(form);
  }
  return out;
}

/** The read: false entry `abs` falls under, read from the main tree `root` (also through an agent's worktree), or null. */
function readDenied(abs, { root, cfg, platform = process.platform } = {}) {
  const noRead = entries(cfg).filter((e) => !e.read);
  if (!noRead.length || !abs || !root) return null;
  const fold = (s) => (PK.folds(platform) ? s.toLowerCase() : s);
  for (const rel of relativeForms(abs, root, platform)) {
    const hit = noRead.find((e) => rel === fold(e.path) || rel.startsWith(`${fold(e.path)}/`));
    if (hit) return hit;
  }
  return null;
}

/** cloudHidden and the private paths as one list (each folder once, with a trailing /). */
function cloudHiddenOf(cfg) {
  const own = Array.isArray(cfg?.cloudHidden) ? cfg.cloudHidden.filter((x) => typeof x === 'string' && x) : [];
  const out = [...own];
  const seen = new Set(own.map((x) => projectPath(x)));
  for (const e of entries(cfg)) {
    if (seen.has(e.path)) continue;
    seen.add(e.path);
    out.push(`${e.path}/`);
  }
  return out;
}

/** The list with `p` added (or replaced, same path): a plain string, or { path, read: false } for --no-read. */
function addEntry(list, p, { read = true } = {}) {
  const r = readEntry(p);
  if (r.error) throw new Error(r.error);
  const rest = (Array.isArray(list) ? list : []).filter((e) => readEntry(e).path !== r.path);
  return [...rest, read ? r.line : { path: r.line, read: false }];
}

/** The list without `p` (by path, whatever the form). */
function removeEntry(list, p) {
  const target = projectPath(p);
  return (Array.isArray(list) ? list : []).filter((e) => readEntry(e).path !== target);
}

module.exports = { projectPath, entries, problems, matching, readDenied, cloudHiddenOf, addEntry, removeEntry };
