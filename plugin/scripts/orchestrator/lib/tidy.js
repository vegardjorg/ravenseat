// =============================================================
// tidy.js: what `ravenseat tidy` lists and removes: worktrees and branches that are merged and left behind, and the
// demo folders next to them (roadmap 1b, owner decision 2026-11-20).
//
// Why: agents and tracks leave merged worktrees and branches behind, also outside .claude/worktrees (the owner removed
// 105 of them by hand on 2026-11-20, 2.4 GB). cleanup-worktree.mjs only ever touches .claude/worktrees; this module
// looks at every worktree `git worktree list --porcelain` knows, wherever it lives.
//
// The rules (each one has a red test in lib/__tests__/tidy.test.ts):
//   * A worktree is removable only when it is merged into the base branch AND clean AND not locked AND not used by an
//     active task (lib/logic/base.js ACTIVE: running, review, picked, external) AND older than tidy.minAgeHours (a
//     fresh worktree with no commits yet looks merged). Never the main checkout, never the worktree the command runs
//     in, never one that has the base branch checked out.
//   * The order per worktree is the owner's manual order: first the shared links (config().sharedLinks, node_modules
//     by default) are removed as links, then the whole folder is searched for any other link (junction or symlink,
//     never followed); one found means the folder is skipped and named. Only then the folder is deleted, then
//     `git worktree prune`, then `git branch -d` (never -D: git refuses a branch that is not merged). Never
//     `git worktree remove` (it can follow links on some setups and leaves half folders, cleanup-worktree.mjs header).
//   * A link is removed with fs.unlinkSync and, on Windows, a non-recursive fs.rmdirSync as the fallback: the same as
//     `cmd /c rmdir <junction>` without a shell, so a path with `&` cannot be split into a second command. Neither
//     follows the link. The links' targets are counted before and after; a changed count stops everything.
//   * Branches: the ones with the queue's branch prefix that are merged, have no worktree and belong to no active
//     task, deleted with `git branch -d`. Never the base branch, the production branch or excludeBranches.
//   * Demo folders (names ending in -demo or -shots next to the worktrees' parent folders) are not worktrees: a list
//     of their own, removed only with --demo --execute, by the same link rules.
//   * Stale clean-gate copies (GOS-1, <dataFolder>/clean-gate): GOS-1 is not built yet, so this only counts what is
//     there and never deletes it (cleanCopies). The removal belongs to GOS-1's own sweep (pid and age rules).
//
// Pure where it can be: scan() and the removers take every input as a parameter (main, base, prefix, tasks, cwd), so
// the tests run against temporary repos. Used by cli/tidy.mjs, cli/doctor.mjs (the INFO row), cli/merge.mjs
// (tidy.afterMerge) and queue-board.mjs (one line in Settings > Project).
// =============================================================
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const WIN = process.platform === 'win32';
/** The statuses in which a task owns its branch and worktree (lib/logic/base.js ACTIVE, copied so this file loads no config). */
const ACTIVE = new Set(['running', 'review', 'picked', 'external']);
/** Folder names that are demo or screenshot folders, never worktrees. */
const DEMO_NAME = /-(demo|shots)$/i;
/** A size walk stops after this many entries and says "at least". */
const SIZE_CAP = 400_000;

/** git, read only (GIT_OPTIONAL_LOCKS=0: git status does not rewrite the index). */
function gitIn(cwd) {
  return (args) => {
    const r = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 256 << 20,
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    return { ok: r.status === 0, out: (r.stdout || '').trim(), error: (r.stderr || '').trim() };
  };
}

/** The one spelling of a path (git prints the long real path; the temp folder can be an 8.3 short path). */
function canonical(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}
const same = (a, b) => {
  const rel = path.relative(canonical(a), canonical(b));
  return rel === '';
};
/** true when `p` is `root` or inside it. */
const within = (p, root) => {
  const rel = path.relative(canonical(root), canonical(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** `git worktree list --porcelain` as objects: { path, head, branch, locked, detached, prunable, bare }. */
function parseWorktrees(text) {
  const out = [];
  let cur = null;
  for (const l of String(text).split(/\r?\n/)) {
    if (l.startsWith('worktree ')) {
      cur = { path: path.resolve(l.slice(9)), head: null, branch: null, locked: false, detached: false, prunable: false, bare: false };
      out.push(cur);
    } else if (!cur) continue;
    else if (l.startsWith('HEAD ')) cur.head = l.slice(5);
    else if (l.startsWith('branch ')) cur.branch = l.slice(7).replace(/^refs\/heads\//, '');
    else if (l === 'detached') cur.detached = true;
    else if (l === 'bare') cur.bare = true;
    else if (l === 'locked' || l.startsWith('locked ')) cur.locked = true;
    else if (l === 'prunable' || l.startsWith('prunable ')) cur.prunable = true;
  }
  return out;
}

/** 'link' (a symlink or a junction: Node reports both as a symbolic link), 'folder', 'file' or 'missing'. Never follows. */
function linkType(p) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch {
    return 'missing';
  }
  if (st.isSymbolicLink()) return 'link';
  return st.isDirectory() ? 'folder' : 'file';
}

/**
 * Every link inside `root` (junction or symlink), never followed, as paths relative to root with '/'. Unreadable
 * folders are listed too (unknown counts as unsafe). `skip` holds relative paths that are allowed (the shared links).
 */
function linksInside(root, skip = []) {
  const allowed = new Set(skip.map((s) => s.toLowerCase()));
  const links = [];
  const unreadable = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (e) {
      unreadable.push(`${path.relative(root, dir) || '.'} (${e.code})`);
      continue;
    }
    for (const name of names) {
      const p = path.join(dir, name);
      const t = linkType(p);
      if (t === 'link') {
        const rel = path.relative(root, p).split(path.sep).join('/');
        if (!allowed.has(rel.toLowerCase())) links.push(rel);
      } else if (t === 'folder') stack.push(p);
    }
  }
  return { links, unreadable };
}

/** The size of a folder in bytes, never following links. `capped` when the walk stopped at SIZE_CAP entries. */
function folderSize(root, cap = SIZE_CAP) {
  let bytes = 0;
  let seen = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (++seen > cap) return { bytes, capped: true };
      let st;
      try {
        st = fs.lstatSync(path.join(dir, name));
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) stack.push(path.join(dir, name));
      else bytes += st.size;
    }
  }
  return { bytes, capped: false };
}

/** "2.4 GB", "18 MB", "512 KB", "0 B". */
function sizeText(bytes, capped = false) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = Math.max(0, Number(bytes) || 0);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const n = i === 0 ? String(Math.round(v)) : v >= 10 ? String(Math.round(v)) : v.toFixed(1);
  return `${capped ? 'at least ' : ''}${n} ${units[i]}`;
}

/** The gitdir of a linked worktree (its .git file), or null. */
function gitdirOf(wt) {
  try {
    const m = fs.readFileSync(path.join(wt, '.git'), 'utf8').match(/^gitdir:\s*(.+)$/m);
    return m ? path.resolve(wt, m[1].trim()) : null;
  } catch {
    return null;
  }
}

/**
 * Last activity: the worktree folder itself and its HEAD and logs/HEAD (checkout and commit). Not the index: a plain
 * git status rewrites it (the same rule as cleanup-worktree.mjs lastChangedMs).
 */
function lastChangedMs(wt) {
  const gd = gitdirOf(wt);
  let max = 0;
  for (const k of [wt, ...(gd ? [path.join(gd, 'HEAD'), path.join(gd, 'logs', 'HEAD')] : [])]) {
    try {
      max = Math.max(max, fs.statSync(k).mtimeMs);
    } catch {
      // not there
    }
  }
  return max;
}

/** The normalized shared links (relative, '/', no '..' or absolute), node_modules when none are given. */
function sharedLinksOf(list) {
  const src = Array.isArray(list) ? list : ['node_modules'];
  return src
    .map((s) => String(s ?? '').trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, ''))
    .filter((s) => s && !s.startsWith('/') && !/^[A-Za-z]:/.test(s) && !s.split('/').includes('..'));
}

/** The task (id) whose branch or worktree this is, among the active ones; null when none. */
function activeTaskFor({ branch, wtPath }, tasks, prefix) {
  for (const o of tasks ?? []) {
    if (!o || !ACTIVE.has(o.status)) continue;
    const names = new Set([o.branch, o.id ? `${prefix}${o.id}` : null, o.cloud?.branch].filter(Boolean));
    if (branch && names.has(branch)) return o.id ?? '?';
    if (wtPath && o.worktree && same(o.worktree, wtPath)) return o.id ?? '?';
  }
  return null;
}

/** Branches never deleted, whatever else holds. */
function protectedBranches({ base, production, exclude, mainBranch }) {
  return new Set([base, production, mainBranch, ...(Array.isArray(exclude) ? exclude : [])].filter(Boolean));
}

/**
 * The first reason a worktree stays, cheapest facts first, or null when it can be removed. Pure: every fact is given.
 * Facts: isMain, isCurrent, missing, locked, baseCheckedOut, activeTask, merged, recent, dirty (count, or -1 unknown).
 */
function keepReason(f) {
  if (f.isMain) return 'the main checkout';
  if (f.isCurrent) return 'the command runs in it';
  if (f.missing) return 'the folder is gone (git worktree prune clears the record)';
  if (f.locked) return 'locked';
  if (f.baseCheckedOut) return 'has the base branch checked out';
  if (f.activeTask) return `used by the active task ${f.activeTask}`;
  if (!f.merged) return 'not merged';
  if (typeof f.dirty !== 'number' || f.dirty < 0) return 'unknown state (git status failed)';
  if (f.dirty > 0) return `uncommitted changes (${f.dirty})`;
  if (f.recent) return 'changed recently (below tidy.minAgeHours)';
  return null;
}

/**
 * The read-only picture. o: { main, base, prefix = 'queue/', tasks = [], cwd = process.cwd(), sizes = true,
 * minAgeHours = 3, sharedLinks, production, exclude, dataFolder, now = Date.now() }.
 * Returns { worktrees, branches, demos, cleanCopies, totals }.
 */
function scan(o) {
  const main = o.main;
  const base = o.base ?? 'main';
  const prefix = o.prefix ?? 'queue/';
  const cwd = o.cwd ?? process.cwd();
  const sizes = o.sizes === 'removable' ? 'removable' : o.sizes !== false;
  const minAgeHours = Number.isFinite(Number(o.minAgeHours)) ? Number(o.minAgeHours) : 3;
  const now = o.now ?? Date.now();
  const git = gitIn(main);
  const list = gitIn(main)(['worktree', 'list', '--porcelain']);
  if (!list.ok) throw new Error(`git worktree list failed: ${list.error}`);
  const all = parseWorktrees(list.out).filter((w) => !w.bare);
  const mainPath = all[0]?.path ?? main;
  const mainBranch = all[0]?.branch ?? null;
  const keep = protectedBranches({ base, production: o.production, exclude: o.exclude, mainBranch });
  const isAncestor = (rev) => !!rev && git(['merge-base', '--is-ancestor', rev, base]).ok;

  const worktrees = all.map((w, i) => {
    const isMain = i === 0 || same(w.path, mainPath);
    const missing = w.prunable || !fs.existsSync(w.path);
    const f = {
      path: w.path,
      branch: w.branch,
      head: w.head,
      isMain,
      isCurrent: !isMain && !missing && within(cwd, w.path),
      missing,
      locked: w.locked,
      baseCheckedOut: !!w.branch && keep.has(w.branch),
      activeTask: isMain ? null : activeTaskFor({ branch: w.branch, wtPath: w.path }, o.tasks, prefix),
      merged: isMain ? null : isAncestor(w.head),
      dirty: null,
      recent: false,
      bytes: 0,
      capped: false,
    };
    if (!isMain && !missing) {
      const s = gitIn(w.path)(['status', '--porcelain']);
      f.dirty = s.ok ? s.out.split('\n').filter(Boolean).length : -1;
      f.recent = minAgeHours > 0 && now - lastChangedMs(w.path) < minAgeHours * 3600e3;
    }
    f.reason = keepReason(f);
    f.removable = f.reason === null;
    // sizes 'removable' (doctor, the board): only what tidy --execute would remove is walked.
    if (sizes && !isMain && !missing && (sizes !== 'removable' || f.removable)) Object.assign(f, folderSize(w.path));
    return f;
  });

  // Branches with the prefix, merged, with no worktree, of no active task.
  const checkedOut = new Set(all.map((w) => w.branch).filter(Boolean));
  const merged = git(['branch', '--format=%(refname:short)', '--merged', base, '--list', `${prefix}*`]);
  const branches = (merged.ok ? merged.out.split('\n').map((s) => s.trim()).filter(Boolean) : [])
    .filter((b) => !checkedOut.has(b) && !keep.has(b) && !activeTaskFor({ branch: b }, o.tasks, prefix))
    .map((name) => ({ name }));

  // Demo folders next to the worktrees (their parent folders), never a worktree themselves.
  const parents = new Map();
  for (const w of all.slice(1)) parents.set(canonical(path.dirname(w.path)).toLowerCase(), path.dirname(w.path));
  const known = new Set(all.map((w) => canonical(w.path).toLowerCase()));
  const demos = [];
  for (const dir of parents.values()) {
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!DEMO_NAME.test(name)) continue;
      const p = path.join(dir, name);
      if (linkType(p) !== 'folder' || known.has(canonical(p).toLowerCase()) || within(cwd, p)) continue;
      demos.push({ path: p, ...(sizes ? folderSize(p) : { bytes: 0, capped: false }) });
    }
  }

  const cleanCopies = cleanCopiesIn(o.dataFolder, { sizes });
  const removable = worktrees.filter((w) => w.removable);
  const totals = {
    worktrees: removable.length,
    worktreeBytes: removable.reduce((n, w) => n + w.bytes, 0),
    capped: removable.some((w) => w.capped),
    branches: branches.length,
    demos: demos.length,
    demoBytes: demos.reduce((n, d) => n + d.bytes, 0),
  };
  return { worktrees, branches, demos, cleanCopies, totals };
}

/**
 * The hook for GOS-1 (gates.runner clean, plans/gos1-clean-gate-analyse-2026-11-20.md 6.4): its copies will live in
 * <dataFolder>/clean-gate/. GOS-1 is not built, so this only counts what is there (built: false) and tidy never
 * deletes it: whether a copy is stale needs GOS-1's pid and age rules, which its own sweep will own.
 */
function cleanCopiesIn(dataFolder, { sizes = true } = {}) {
  const folder = dataFolder ? path.join(dataFolder, 'clean-gate') : null;
  const out = { built: false, folder, count: 0, bytes: 0 };
  if (!folder || linkType(folder) !== 'folder') return out;
  try {
    const names = fs.readdirSync(folder);
    out.count = names.length;
    if (sizes) out.bytes = folderSize(folder).bytes;
  } catch {
    // unreadable: counted as none
  }
  return out;
}

/** Counts the entries of each link's target, to prove afterwards that nothing followed a link. */
function targetCounts(root, rels) {
  const out = {};
  for (const rel of rels) {
    const p = path.join(root, ...rel.split('/'));
    if (linkType(p) !== 'link') continue;
    try {
      const target = fs.realpathSync.native(p);
      out[target] = fs.readdirSync(target).length;
    } catch {
      out[p] = -1; // a dangling link: nothing to follow
    }
  }
  return out;
}
const countsChanged = (before) =>
  Object.entries(before).some(([t, n]) => {
    if (n < 0) return false;
    try {
      return fs.readdirSync(t).length !== n;
    } catch {
      return true;
    }
  });

/** Removes ONLY the link, never its target, and refuses anything that is not a link (cleanup-worktree.mjs removeLinkOnly). */
function removeLinkOnly(p) {
  if (linkType(p) !== 'link') throw new Error(`${p} is not a link`);
  try {
    fs.unlinkSync(p);
  } catch (e) {
    if (!WIN || !['EPERM', 'EISDIR', 'EACCES'].includes(e.code)) throw e;
    fs.rmdirSync(p); // never recursive: removes the junction itself, like `cmd /c rmdir <junction>`
  }
  if (linkType(p) !== 'missing') throw new Error(`the link ${p} is still there`);
}

/**
 * Removes one folder by the link rules: the shared links as links, then any other link inside stops it (named), then
 * the folder. Returns { status: 'removed' | 'skipped' | 'error', reason }.
 */
function removeFolderSafely(folder, sharedLinks) {
  const rels = sharedLinksOf(sharedLinks);
  // Looked at before anything is touched as well, so a folder that will be skipped is left exactly as it was.
  const first = linksInside(folder, rels);
  if (first.links.length) return { status: 'skipped', reason: `has another link inside: ${first.links.slice(0, 3).join(', ')}` };
  if (first.unreadable.length) return { status: 'skipped', reason: `could not read ${first.unreadable.slice(0, 3).join(', ')}` };
  for (const rel of rels) {
    const p = path.join(folder, ...rel.split('/'));
    const t = linkType(p);
    if (t === 'folder' || t === 'file') return { status: 'skipped', reason: `${rel} is a real folder, not a link` };
  }
  const before = targetCounts(folder, rels);
  for (const rel of rels) {
    const p = path.join(folder, ...rel.split('/'));
    if (linkType(p) !== 'link') continue;
    try {
      removeLinkOnly(p);
    } catch (e) {
      return { status: 'skipped', reason: `could not remove the link ${rel}: ${e.message}` };
    }
  }
  if (countsChanged(before)) return { status: 'error', reason: 'a link target changed while its link was removed; stopped' };
  // The check after the links are gone (the owner's order): any link left means the folder stays.
  const after = linksInside(folder, []);
  if (after.links.length) return { status: 'skipped', reason: `has another link inside: ${after.links.slice(0, 3).join(', ')}` };
  if (after.unreadable.length) return { status: 'skipped', reason: `could not read ${after.unreadable.slice(0, 3).join(', ')}` };
  try {
    // No link is left inside, so nothing here can be followed. No shell.
    fs.rmSync(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
  } catch {
    // checked below
  }
  if (countsChanged(before)) return { status: 'error', reason: 'a link target changed during the delete; stopped' };
  if (fs.existsSync(folder)) return { status: 'skipped', reason: 'the folder is left (a file held open by a program?)' };
  return { status: 'removed', reason: 'removed' };
}

/**
 * Removes the removable worktrees and branches of a scan (scan() is run again first, so the facts are fresh). Each
 * worktree: links, check for other links, folder, git worktree prune, git branch -d. Then the merged branches with no
 * worktree. Returns { removed: [{ kind, name }], skipped: [{ kind, name, reason }], stopped }.
 * o: the scan options plus { demo: false } (true removes the demo folders instead of worktrees and branches).
 */
function execute(o) {
  const picture = scan({ ...o, sizes: false });
  const git = gitIn(o.main);
  const removed = [];
  const skipped = [];
  let stopped = null;
  if (o.demo) {
    for (const d of picture.demos) {
      const r = removeFolderSafely(d.path, o.sharedLinks);
      if (r.status === 'removed') removed.push({ kind: 'demo folder', name: d.path });
      else skipped.push({ kind: 'demo folder', name: d.path, reason: r.reason });
      if (r.status === 'error') {
        stopped = r.reason;
        break;
      }
    }
    return { removed, skipped, stopped };
  }
  const keep = protectedBranches({ base: o.base, production: o.production, exclude: o.exclude, mainBranch: picture.worktrees[0]?.branch });
  for (const w of picture.worktrees) {
    const name = `${w.path}${w.branch ? ` (${w.branch})` : ''}`;
    if (!w.removable) {
      if (!w.isMain) skipped.push({ kind: 'worktree', name, reason: w.reason });
      continue;
    }
    const r = removeFolderSafely(w.path, o.sharedLinks);
    if (r.status !== 'removed') {
      skipped.push({ kind: 'worktree', name, reason: r.reason });
      if (r.status === 'error') {
        stopped = r.reason;
        break;
      }
      continue;
    }
    git(['worktree', 'prune']);
    removed.push({ kind: 'worktree', name: w.path });
    if (w.branch && !keep.has(w.branch)) {
      const d = git(['branch', '-d', w.branch]);
      if (d.ok) removed.push({ kind: 'branch', name: w.branch });
      else skipped.push({ kind: 'branch', name: w.branch, reason: `git branch -d refused: ${d.error.split('\n')[0]}` });
    }
  }
  if (!stopped)
    for (const b of picture.branches) {
      const d = git(['branch', '-d', b.name]);
      if (d.ok) removed.push({ kind: 'branch', name: b.name });
      else skipped.push({ kind: 'branch', name: b.name, reason: `git branch -d refused: ${d.error.split('\n')[0]}` });
    }
  return { removed, skipped, stopped };
}

/**
 * tidy.afterMerge: the worktrees of one merged branch (anywhere on disk) and the branch, by the same rules. Only the
 * worktrees with that branch checked out are looked at; everything else is left alone.
 */
function tidyBranch(branch, o) {
  const picture = scan({ ...o, sizes: false });
  const git = gitIn(o.main);
  const out = [];
  for (const w of picture.worktrees.filter((x) => x.branch === branch && !x.isMain)) {
    if (!w.removable) {
      out.push(`Tidy: ${w.path} kept: ${w.reason}.`);
      continue;
    }
    const r = removeFolderSafely(w.path, o.sharedLinks);
    if (r.status !== 'removed') {
      out.push(`Tidy: ${w.path} kept: ${r.reason}.`);
      continue;
    }
    git(['worktree', 'prune']);
    out.push(`Tidy: ${w.path} removed.`);
  }
  return out;
}

/** The doctor's INFO row text, or null when there is nothing to remove. */
function doctorText(t, cli = 'ravenseat') {
  if (!t.worktrees && !t.branches) return null;
  const parts = [];
  if (t.worktrees) parts.push(`${t.worktrees} merged, clean worktree(s) (${sizeText(t.worktreeBytes, t.capped)})`);
  if (t.branches) parts.push(`${t.branches} merged branch(es) with no worktree`);
  return { message: `${parts.join(' and ')} can be removed`, fix: `${cli} tidy (lists them), then ${cli} tidy --execute` };
}

module.exports = {
  ACTIVE,
  DEMO_NAME,
  parseWorktrees,
  linksInside,
  folderSize,
  sizeText,
  sharedLinksOf,
  activeTaskFor,
  keepReason,
  scan,
  cleanCopiesIn,
  removeLinkOnly,
  removeFolderSafely,
  execute,
  tidyBranch,
  doctorText,
};
