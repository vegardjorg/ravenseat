// =============================================================
// gateClean.js: the full gate in a clean copy of the exact commit (gates.runner clean, GOS-1).
//
// Why: in a track's worktree a gate can pass because of files the commit does not have (untracked and ignored files, a
// stale build output) or a shared node_modules installed from another lockfile (lib/gateCoverage.js counts both). Then
// the evidence entry says "this commit passed" when it was the commit plus the folder. A clean copy of the commit, with
// dependencies linked (or installed) from the lockfile, makes a green gate mean what it reads. Measured cost: about 2 s
// per full gate with linked dependencies, 25 to 60 s with an install (plans/gos1-clean-gate-analyse-2026-11-20.md).
//
// Off by default (gates.runner worktree): clean can stop work, since a project whose tests need an ignored local file is
// red in the copy until that file is listed in gates.clean.include.
//
// Which runs (runKind; gates.clean.kinds, default ["full"]):
//   full  the orchestrator's gate on the delivered tip before merge (ravenseat receive: --evidence in a linked worktree);
//   base  the gate on the merge commit in the main checkout (ravenseat merge's gates step: --evidence there);
//   push  `ravenseat gates --full` in the main checkout (the full gate before a batch push).
//   A track's own run in its worktree is never clean: it checks work in progress. `ravenseat gates --full --clean` is a
//   one-off trial whatever the setting.
//
// The copy (cleanup design, section 6.4 of the plan):
//   - one folder per run under <dataFolder>/clean-gate/<pid>-<sha8>-<random> (short, for long Windows paths), with a
//     meta file beside it (<name>.json: pid, sha, copy kind, the links made), never inside, so the copy holds only the
//     commit. Not in the system temp folder and not where the owner keeps worktrees.
//   - made with `git worktree add --detach` (keeps .git for tests that call git, LFS works) or, with gates.clean.copy
//     archive, `git archive` into a tar file read by tar in the copy folder (never `tar -C C:\...`: GNU tar reads C: as
//     a host). git runs with hooks pointed at an empty folder and fsmonitor off: making a copy starts no program.
//   - dependencies: each sharedLinks path as a junction (Windows) or symlink to the same folder the worktree uses, or an
//     install from the copy's lockfile (npm ci, pnpm, yarn or bun, frozen), or auto (install only when the lockfile
//     differs from the linked folder's).
//   - gates.clean.include: ignored files copied in from the worktree (an .env.test). Never an absolute path, .., .git,
//     a key file or an env file other than .env.test, .env.testing or .env.ci: the gate's environment is scrubbed of
//     secrets (lib/gateEnv.js), and a file must not carry them back in.
//   - removed when the run ends (process exit, also after a red run unless gates.clean.keepOnRed): each recorded link is
//     removed as a link (unlink, rmdir without recursion), checked gone, then a folder link that points OUT of the copy
//     stops everything (removing through it could delete what it points at), then `git worktree remove` without --force,
//     else fs.rmSync (which never follows links) and, with the folder gone, `git worktree remove --force` on that one
//     path, which then only drops git's record of it. Any failure leaves the folder, says so in one line and never
//     changes the gate's verdict (housekeeping, fail open, as lib/gateTemp.js).
//   - swept at the start of every clean run and by the doctor: our own names only, the process gone, older than
//     gates.clean.sweepAfterHours (1), links first; a copy that cannot be removed stays and gets a doctor WARN.
//
// A setup failure (git or tar missing, the copy, a link or the install failing) runs no gate command: gates.mjs prints
// and logs one line starting with SETUP_RED, and ravenseat receive turns it into one owner question through the
// "gate cannot run" path (lib/gateBroken.js setupRed, gates.brokenVerdict), not a fix round.
//
// Used by gates.mjs, cli/merge.mjs (the hint at receive) and cli/doctor.mjs. Tested in lib/__tests__/gateClean.test.ts
// and __tests__/gateCleanFlow.test.ts.
// =============================================================
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RUNNERS = Object.freeze(['worktree', 'clean']);
const DEPENDENCIES = Object.freeze(['link', 'install', 'auto']);
const COPIES = Object.freeze(['worktree', 'archive']);
const KINDS = Object.freeze(['full', 'base', 'push']);
/** The folder under the data folder that holds the copies. */
const FOLDER = 'clean-gate';
/** Only a whole name of this shape is ours to sweep. */
const NAME = /^(\d+)-([0-9a-f]{8})-([0-9a-z]{6})$/;
/** The first words of the line gates.mjs prints and logs when the copy could not be set up (lib/gateBroken.js reads it). */
const SETUP_RED = 'CLEAN COPY SETUP RED:';
/** The one hint for a worktree run that could see ignored files or a shared folder from another lockfile. */
const HINT = 'Hint: `gates.runner clean` would run the full gate on the exact commit (about 2 s more here).';
/** Above this many stale copies after a sweep the doctor says so (a count, never a stop). */
const CAP = 5;
const WIN = process.platform === 'win32';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---- settings ----------------------------------------------------------------------------------------------------------

/** Env files that are for tests by name; every other .env style file may hold real keys. */
const TEST_ENV = /^\.env\.(test|testing|ci)$/i;
/** Files that hold keys or registry tokens by name. */
const KEY_FILE = /^(\.npmrc|\.yarnrc(\.yml)?|\.netrc|\.pypirc|\.git-credentials|\.pgpass|id_[a-z0-9]+|.*\.(pem|key|p12|pfx|keystore|jks))$/i;

/** Why `p` cannot be copied into a clean copy, or null when it can. Pure. */
function includeRefusal(p) {
  if (typeof p !== 'string' || !p.trim()) return 'not a path';
  const s = p.trim();
  if (path.isAbsolute(s) || /^[A-Za-z]:/.test(s) || /^[\\/]/.test(s)) return 'an absolute path';
  const parts = s.split(/[\\/]+/).filter(Boolean);
  if (parts.includes('..')) return 'leaves the project (..)';
  if (parts[0]?.toLowerCase() === '.git') return 'inside .git';
  const base = parts[parts.length - 1] ?? '';
  if (KEY_FILE.test(base)) return 'a key or token file';
  if (/^\.env(\.[A-Za-z0-9_-]+)*$/i.test(base) && !TEST_ENV.test(base) && !/\.(example|sample|template)$/i.test(base))
    return 'an env file that may hold real keys (only .env.test, .env.testing and .env.ci are copied)';
  return null;
}

/** The include list split into what is copied and what is refused (with why). Pure. */
function includeList(list) {
  const accepted = [];
  const refused = [];
  for (const p of Array.isArray(list) ? list : []) {
    const why = includeRefusal(p);
    if (why) refused.push({ path: p, why });
    else accepted.push(p.trim().split('\\').join('/'));
  }
  return { accepted: [...new Set(accepted)], refused };
}

/**
 * The clean runner's setup from config(), every value checked; a value it does not know is its default. Pure.
 * @returns {{ runner: string, dependencies: string, copy: string, include: string[], kinds: string[], keepOnRed: boolean, sweepAfterHours: number }}
 */
function setup(config) {
  const g = isObject(config?.gates) ? config.gates : {};
  const c = isObject(g.clean) ? g.clean : {};
  const pick = (v, list, d) => (list.includes(v) ? v : d);
  const kinds = Array.isArray(c.kinds) ? [...new Set(c.kinds.map((k) => String(k).trim()).filter((k) => KINDS.includes(k)))] : ['full'];
  const hours = Number(c.sweepAfterHours);
  return {
    runner: pick(g.runner, RUNNERS, 'worktree'),
    dependencies: pick(c.dependencies, DEPENDENCIES, 'link'),
    copy: pick(c.copy, COPIES, 'worktree'),
    include: includeList(c.include).accepted,
    kinds,
    keepOnRed: c.keepOnRed === true,
    sweepAfterHours: Number.isFinite(hours) && hours > 0 ? hours : 1,
  };
}

/** What is wrong in the project's own gates.runner and gates.clean values, for the doctor. Pure. */
function problems(own) {
  const out = [];
  const g = isObject(own?.gates) ? own.gates : {};
  if (g.runner !== undefined && !RUNNERS.includes(g.runner)) out.push(`gates.runner must be one of ${RUNNERS.join(', ')}`);
  const c = g.clean;
  if (c === undefined) return out;
  if (!isObject(c)) return [...out, 'gates.clean must be an object'];
  if (c.dependencies !== undefined && !DEPENDENCIES.includes(c.dependencies)) out.push(`gates.clean.dependencies must be one of ${DEPENDENCIES.join(', ')}`);
  if (c.copy !== undefined && !COPIES.includes(c.copy)) out.push(`gates.clean.copy must be one of ${COPIES.join(', ')}`);
  if (c.kinds !== undefined && !(Array.isArray(c.kinds) && c.kinds.every((k) => KINDS.includes(k))))
    out.push(`gates.clean.kinds must be a list of ${KINDS.join(', ')}`);
  if (c.include !== undefined) {
    if (!Array.isArray(c.include)) out.push('gates.clean.include must be a list of paths');
    else for (const r of includeList(c.include).refused) out.push(`gates.clean.include: ${JSON.stringify(r.path)} is ${r.why}, so it is not copied`);
  }
  if (c.keepOnRed !== undefined && typeof c.keepOnRed !== 'boolean') out.push('gates.clean.keepOnRed must be true or false');
  if (c.sweepAfterHours !== undefined && !(typeof c.sweepAfterHours === 'number' && c.sweepAfterHours > 0))
    out.push('gates.clean.sweepAfterHours must be a number > 0');
  return out;
}

/**
 * The kind of a gates.mjs run for gates.clean.kinds, or null for a run that is never clean (a track's own run, or the
 * owner's quick run in the main checkout). Pure.
 */
function runKind({ mode, mainTree, evidence }) {
  if (mainTree === true) {
    if (evidence) return 'base';
    return mode === 'full' ? 'push' : null;
  }
  return evidence ? 'full' : null;
}

/** Does this run use a clean copy? `forced` is --clean (a one-off trial). Pure. */
function decide({ setup: s, kind, forced = false }) {
  if (forced) return { clean: true, source: '--clean' };
  if (s.runner === 'clean' && kind && s.kinds.includes(kind)) return { clean: true, source: 'gates.runner' };
  return { clean: false, source: null };
}

/**
 * The gates setup hash (lib/gateEvidence.js setupHash) together with the clean setup, for the "gate cannot run" verdict
 * of a copy that could not be set up: changing gates.runner or gates.clean forgets that verdict. Pure.
 */
function verdictHash(gatesHash, config) {
  return crypto.createHash('sha256').update(`${gatesHash}\n${JSON.stringify(setup(config))}`).digest('hex');
}

// ---- dependencies ------------------------------------------------------------------------------------------------------

/** Install, given the setting and the two lockfile hashes (the copy's, and the one beside the linked folder)? Pure. */
function wantsInstall({ dependencies, copyLock, linkedLock }) {
  if (dependencies === 'install') return true;
  if (dependencies === 'auto') return !!copyLock && copyLock !== linkedLock;
  return false;
}

/** The frozen install command for the lockfile in `folder`, or null when it has none. */
function installCommand(folder) {
  const has = (f) => fs.existsSync(path.join(folder, f));
  if (has('package-lock.json') || has('npm-shrinkwrap.json')) return 'npm ci --no-audit --no-fund';
  if (has('pnpm-lock.yaml')) return 'pnpm install --frozen-lockfile';
  if (has('yarn.lock')) return 'yarn install --frozen-lockfile';
  if (has('bun.lock') || has('bun.lockb')) return 'bun install --frozen-lockfile';
  return null;
}

// ---- names and the meta file -------------------------------------------------------------------------------------------

/** A new copy's folder name. */
function copyName({ pid = process.pid, sha }) {
  const rand = crypto.randomBytes(6).toString('base64').replace(/[^0-9a-z]/gi, '').toLowerCase().padEnd(6, '0').slice(0, 6);
  return `${pid}-${String(sha).toLowerCase().slice(0, 8)}-${rand}`;
}

/** { pid, sha8 } for one of our names, or null. Pure. */
function parseName(name) {
  const m = NAME.exec(String(name));
  return m ? { pid: Number(m[1]), sha8: m[2] } : null;
}

const metaFile = (base, name) => path.join(base, `${name}.json`);
function writeMeta(base, name, meta) {
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(metaFile(base, name), `${JSON.stringify({ ...meta, start: meta.start ?? new Date().toISOString() })}\n`);
}
function readMeta(base, name) {
  try {
    return JSON.parse(fs.readFileSync(metaFile(base, name), 'utf8'));
  } catch {
    return null;
  }
}

// ---- making the copy ---------------------------------------------------------------------------------------------------

/** git with nothing that starts a program: hooks in an empty folder, fsmonitor off. { status, stdout, stderr, error }. */
function runGitDefault(args, { cwd, noHooks } = {}) {
  const pre = noHooks ? ['-c', `core.hooksPath=${noHooks}`, '-c', 'core.fsmonitor=false'] : ['-c', 'core.fsmonitor=false'];
  return spawnSync('git', [...pre, ...args], { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 << 20 });
}

const firstLine = (s) => String(s ?? '').trim().split(/\r?\n/)[0]?.slice(0, 200) ?? '';
const missing = (r, program) => r?.error?.code === 'ENOENT' ? `the program ${program} is not found` : null;

/** Is `p` a link (Node reports NTFS junctions as symbolic links)? 'link', 'folder', 'other' or 'missing'. */
function linkType(p) {
  let st;
  try {
    st = fs.lstatSync(p);
  } catch {
    return 'missing';
  }
  if (st.isSymbolicLink()) return 'link';
  return st.isDirectory() ? 'folder' : 'other';
}

/**
 * Makes the copy of `sha` from the repo at `cwd` under `base`. Never throws.
 * @returns {{ ok: true, folder: string, name: string } | { ok: false, error: string, folder?: string, name?: string }}
 */
function make({ base, cwd, sha, copy = 'worktree', pid = process.pid, runGit = runGitDefault }) {
  if (!sha) return { ok: false, error: 'no commit to copy' };
  const name = copyName({ pid, sha });
  const folder = path.join(base, name);
  const noHooks = path.join(base, '.no-hooks');
  try {
    fs.mkdirSync(noHooks, { recursive: true });
    writeMeta(base, name, { pid, sha, copy, links: [] });
  } catch (e) {
    return { ok: false, error: `the copy folder ${base} cannot be made (${e?.code ?? e?.message ?? e})` };
  }
  if (copy === 'worktree') {
    const r = runGit(['-C', cwd, 'worktree', 'add', '--detach', '--quiet', folder, sha], { cwd, noHooks });
    if (r.error) return { ok: false, error: missing(r, 'git') ?? `git worktree add failed (${r.error.message})`, folder, name };
    if (r.status !== 0) return { ok: false, error: `git worktree add failed (${firstLine(r.stderr) || `exit ${r.status}`})`, folder, name };
    return { ok: true, folder, name };
  }
  try {
    fs.mkdirSync(folder);
  } catch (e) {
    return { ok: false, error: `the copy folder cannot be made (${e?.code ?? e})`, folder, name };
  }
  const tar = '.ravenseat-copy.tar';
  const a = runGit(['-C', cwd, 'archive', '--format=tar', '-o', path.join(folder, tar), sha], { cwd, noHooks });
  if (a.error) return { ok: false, error: missing(a, 'git') ?? `git archive failed (${a.error.message})`, folder, name };
  if (a.status !== 0) return { ok: false, error: `git archive failed (${firstLine(a.stderr) || `exit ${a.status}`})`, folder, name };
  // The tar file by a relative name, read with the copy as the working folder: GNU tar reads "C:\..." as host:path.
  const x = spawnSync('tar', ['-xf', tar], { cwd: folder, encoding: 'utf8', windowsHide: true });
  try {
    fs.unlinkSync(path.join(folder, tar));
  } catch {
    // error-ignored: removed with the folder
  }
  if (x.error) return { ok: false, error: missing(x, 'tar') ?? `tar failed (${x.error.message})`, folder, name };
  if (x.status !== 0) return { ok: false, error: `tar failed (${firstLine(x.stderr) || `exit ${x.status}`})`, folder, name };
  return { ok: true, folder, name };
}

/**
 * Links each shared folder into the copy, pointing at the same folder the worktree (or else the main checkout) uses.
 * Records every link it makes in the meta file BEFORE making it, so the cleanup always knows it. Never throws.
 * @param {{ base: string, name: string, folder: string, links: string[], from: string[] }} o `from`: where to look for
 *   each link's source, in order (the gate folder, then the project root)
 * @returns {{ ok: true, made: string[] } | { ok: false, error: string, made: string[] }}
 */
function linkShared({ base, name, folder, links, from, skip = () => false }) {
  const made = [];
  for (const rel of links) {
    if (skip(rel)) continue;
    let target = null;
    for (const root of from) {
      try {
        target = fs.realpathSync(path.join(root, ...rel.split('/')));
        break;
      } catch {
        // not here
      }
    }
    if (!target) continue; // nothing to share: the copy goes without it
    const dest = path.join(folder, ...rel.split('/'));
    if (linkType(dest) !== 'missing') return { ok: false, error: `${rel} is in the commit itself, so it cannot be linked in the copy`, made };
    try {
      const meta = readMeta(base, name) ?? {};
      writeMeta(base, name, { ...meta, links: [...new Set([...(meta.links ?? []), rel])] });
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.symlinkSync(target, dest, WIN ? 'junction' : 'dir');
      made.push(rel);
    } catch (e) {
      return { ok: false, error: `the link ${rel} could not be made (${e?.code ?? e?.message ?? e})`, made };
    }
  }
  return { ok: true, made };
}

/** Is there a link or junction anywhere under `dir`? lstat reports a junction as a link. */
function hasLink(dir) {
  const stack = [dir];
  while (stack.length) {
    const here = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(here, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isSymbolicLink()) return true;
      if (e.isDirectory()) stack.push(path.join(here, e.name));
    }
  }
  return false;
}

/**
 * Copies the include list's files and folders from `from` into the copy. A path that is not there is skipped (listed);
 * a link, or a folder holding one, is refused (it would carry the outside in). Never throws.
 * @returns {{ ok: true, copied: string[], absent: string[] } | { ok: false, error: string }}
 */
function copyIncluded({ folder, from, include }) {
  const copied = [];
  const absent = [];
  for (const rel of include) {
    if (includeRefusal(rel)) continue;
    const src = path.join(from, ...rel.split('/'));
    const t = linkType(src);
    if (t === 'missing') {
      absent.push(rel);
      continue;
    }
    if (t === 'link' || (t === 'folder' && hasLink(src))) return { ok: false, error: `gates.clean.include ${rel} is or holds a link, so it is not copied` };
    try {
      const dest = path.join(folder, ...rel.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.cpSync(src, dest, { recursive: true, force: true, errorOnExist: false });
      copied.push(rel);
    } catch (e) {
      return { ok: false, error: `gates.clean.include ${rel} could not be copied (${e?.code ?? e?.message ?? e})` };
    }
  }
  return { ok: true, copied, absent };
}

// ---- removing the copy -------------------------------------------------------------------------------------------------

const norm = (p) => (WIN ? path.resolve(p).toLowerCase() : path.resolve(p));
const isUnder = (p, root) => {
  const rel = path.relative(norm(root), norm(p));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

/** Folder links inside `root` that point OUT of it, and folders that cannot be read (unknown is unsafe). Never follows links. */
function outLinks(root) {
  const out = [];
  let unreadable = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch (e) {
      if (e?.code !== 'ENOENT') unreadable++;
      continue;
    }
    for (const n of names) {
      const p = path.join(dir, n);
      let st;
      try {
        st = fs.lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) {
        let real = null;
        let folder = false;
        try {
          real = fs.realpathSync(p);
          folder = fs.statSync(p).isDirectory();
        } catch {
          // a dangling link: removing it removes only the link
        }
        if (folder && !isUnder(real, root)) out.push(p);
        continue;
      }
      if (st.isDirectory()) stack.push(p);
    }
  }
  return { out, unreadable };
}

/** Removes ONLY the link at `p` (unlink; rmdir without recursion for a Windows junction unlink refuses), and checks it is gone. */
function removeLinkOnly(p) {
  try {
    fs.unlinkSync(p);
  } catch (e) {
    if (!WIN || !['EPERM', 'EISDIR', 'EACCES'].includes(e?.code)) throw e;
    fs.rmdirSync(p);
  }
  if (linkType(p) !== 'missing') throw new Error(`the link ${p} is still there`);
}

/** Is `folder` registered as a worktree of the repo at `gitCwd`? null when git cannot tell. */
function registered(folder, { gitCwd, runGit = runGitDefault }) {
  if (!gitCwd) return null;
  const r = runGit(['-C', gitCwd, 'worktree', 'list', '--porcelain'], { cwd: gitCwd });
  if (r.status !== 0) return null;
  return String(r.stdout ?? '')
    .split(/\r?\n/)
    .filter((l) => l.startsWith('worktree '))
    .some((l) => norm(l.slice(9).trim()) === norm(folder));
}

/**
 * Removes one copy: links first, then the folder, then git's record of it. Never throws, never removes through a link.
 * @returns {{ removed: boolean, reason?: string }}
 */
function removeCopy({ base, name, gitCwd, runGit = runGitDefault }) {
  const folder = path.join(base, name);
  const meta = readMeta(base, name) ?? {};
  try {
    // 1. Our own dependency links, as links. A real folder where a link should be is never deleted.
    for (const rel of Array.isArray(meta.links) ? meta.links : []) {
      const p = path.join(folder, ...String(rel).split('/'));
      const t = linkType(p);
      if (t === 'missing') continue;
      if (t !== 'link') return { removed: false, reason: `${rel} in ${folder} is a real folder where a link should be; left in place` };
      removeLinkOnly(p);
    }
  } catch (e) {
    return { removed: false, reason: `a link in ${folder} could not be removed (${e?.code ?? e?.message ?? e}); left in place` };
  }
  if (fs.existsSync(folder)) {
    // 2. Anything else that points out of the copy (a test made it) stops the removal.
    const o = outLinks(folder);
    if (o.out.length) return { removed: false, reason: `${folder} holds a link out of it (${o.out[0]}); left in place, so the target stays safe` };
    if (o.unreadable) return { removed: false, reason: `${folder} has a folder that cannot be read; left in place` };
    // 3. git's own removal (no --force: it refuses on changes), else a plain delete that never follows links.
    const isWorktree = gitCwd && fs.existsSync(path.join(folder, '.git'));
    if (isWorktree) runGit(['-C', gitCwd, 'worktree', 'remove', folder], { cwd: gitCwd });
    if (fs.existsSync(folder)) {
      try {
        fs.rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (e) {
        return { removed: false, reason: `${folder} could not be removed (${e?.code ?? e?.message ?? e}, a process may still hold a file); the next sweep tries again` };
      }
    }
  }
  // 4. The folder is gone: drop git's record of that one path (with nothing left there, --force deletes no file).
  if (gitCwd && registered(folder, { gitCwd, runGit })) runGit(['-C', gitCwd, 'worktree', 'remove', '--force', folder], { cwd: gitCwd });
  try {
    fs.rmSync(metaFile(base, name), { force: true });
  } catch {
    // error-ignored: a meta file without a folder is swept next time
  }
  return { removed: true };
}

/** Is `pid` running? A process we may not signal is running too. */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

/**
 * Removes what earlier runs left under `base`: our own names, the process gone, older than `afterHours`. Then drops
 * git's record of copies whose folder is gone. Never throws.
 * @returns {{ removed: number, kept: { name: string, reason: string }[] }}
 */
function sweep({ base, gitCwd, alive = isAlive, now = Date.now(), afterHours = 1, runGit = runGitDefault }) {
  let names;
  try {
    names = fs.readdirSync(base);
  } catch {
    return { removed: 0, kept: [] };
  }
  const own = new Set();
  for (const n of names) {
    const m = parseName(n.replace(/\.json$/, ''));
    if (m) own.add(n.replace(/\.json$/, ''));
  }
  let removed = 0;
  const kept = [];
  for (const name of own) {
    const { pid } = parseName(name);
    if (alive(pid)) continue;
    let mtime = 0;
    for (const p of [path.join(base, name), metaFile(base, name)]) {
      try {
        mtime = Math.max(mtime, fs.lstatSync(p).mtimeMs);
      } catch {
        // not there
      }
    }
    if (now - mtime < afterHours * 3_600_000) continue;
    const r = removeCopy({ base, name, gitCwd, runGit });
    if (r.removed) removed++;
    else kept.push({ name, reason: r.reason ?? 'left in place' });
  }
  // git's records of copies under base whose folder is gone (a hand delete, a reboot mid-removal).
  if (gitCwd) {
    const r = runGit(['-C', gitCwd, 'worktree', 'list', '--porcelain'], { cwd: gitCwd });
    if (r.status === 0)
      for (const l of String(r.stdout ?? '').split(/\r?\n/)) {
        if (!l.startsWith('worktree ')) continue;
        const p = l.slice(9).trim();
        if (isUnder(p, base) && parseName(path.basename(p)) && !fs.existsSync(p))
          runGit(['-C', gitCwd, 'worktree', 'remove', '--force', p], { cwd: gitCwd });
      }
  }
  return { removed, kept };
}

// ---- lines -------------------------------------------------------------------------------------------------------------

/** The hint for a worktree run's evidence entry, or null. `entry` is a gate evidence entry (lib/gateEvidence.js). */
function hint(entry, s) {
  if (s?.runner === 'clean') return null;
  const c = require('./gateEvidence.js').coverage(entry);
  if (!c || c.runner !== require('./gateEvidence.js').RUNNER_LOCAL) return null;
  return c.ignored || c.sharedLinks.some((l) => l.lockDiffers) ? HINT : null;
}

/** The doctor's row from a sweep's result. */
function doctorLine({ removed, kept }, { cli = 'ravenseat' } = {}) {
  const swept = removed ? ` Swept ${removed} old one(s) now.` : '';
  if (!kept.length) return { status: 'OK', message: `no clean gate copies left behind.${swept}`.trim(), fix: null };
  return {
    status: 'WARN',
    message: `${kept.length} clean gate cop${kept.length === 1 ? 'y' : 'ies'} could not be removed${kept.length > CAP ? ` (more than ${CAP})` : ''}: ${kept[0].reason}.${swept}`,
    fix: `stop what holds the files, then ${cli} doctor sweeps again; by hand, remove the links in the copy first, never the folder with a link still in it`,
  };
}

module.exports = {
  RUNNERS,
  DEPENDENCIES,
  COPIES,
  KINDS,
  FOLDER,
  SETUP_RED,
  HINT,
  CAP,
  includeRefusal,
  includeList,
  setup,
  problems,
  runKind,
  decide,
  verdictHash,
  wantsInstall,
  installCommand,
  copyName,
  parseName,
  metaFile,
  writeMeta,
  readMeta,
  make,
  linkShared,
  copyIncluded,
  hasLink,
  outLinks,
  removeLinkOnly,
  removeCopy,
  sweep,
  isAlive,
  hint,
  doctorLine,
};
