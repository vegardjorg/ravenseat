// =============================================================
// agentPushBlock.js: a git pre-push hook that stops a push from a track's worktree (owner decision B1, 2026-11-12).
//
// Why: the push guard (lib/pushGuard.js) reads the command text. A push started by something it cannot see (a script the
// agent wrote and ran, a tool that pushes by itself) goes past it (review 2026-11-11, S2). Git runs the pre-push hook for
// every push whatever started it, so a block there does not depend on reading anything.
//
// How it tells a track from everything else: prepare-track writes a marker file (MARKER) into the worktree's own git dir
// (<common>/worktrees/<name>/, `git rev-parse --absolute-git-dir`). The hook stops the push when that file exists. The
// main checkout never has one (prepare-track refuses to run there), so the owner's and the orchestrator's pushes from the
// main checkout go on, and so does a worktree the owner made by hand or one Claude Code made for an interactive session.
// The marker goes away with the worktree (`git worktree remove` deletes that folder).
//
// How it chains to a hook that is already there (husky, lefthook, a plain .git/hooks/pre-push, core.hooksPath): it does
// not replace the file. BLOCK, a few lines of POSIX sh between two marker comments, goes in right after the first line
// of the existing pre-push, which must be a shell script (#!...sh, bash, dash, zsh, ksh). The rest of the file is kept as
// it was and still runs, with the same $0, arguments and stdin (husky's runner finds the user's script by $0). With no
// pre-push it writes a new one: "#!/bin/sh" and BLOCK. A pre-push in another language (node, python) is left alone
// and reported (status 'unsupported'); the text guard still applies there.
//
// Idempotent and removable: install() does nothing when BLOCK is there; remove() takes out exactly BLOCK and deletes a
// file it wrote itself. ensure() does one or the other from agentPushBlock.enabled; fill, start and resume run it for the
// hooks folder of the main checkout, and prepare-track for the worktree's own folder when it differs (a relative
// core.hooksPath, as husky sets, points every worktree at its own folder).
//
// The git surface (lib/gitExecSurface.js, lib/gitSurfaceBaseline.js) hashes the hooks folder. hookHash() is what it uses
// for pre-push: the file with exactly BLOCK taken out, and a file that is only "#!/bin/sh" and BLOCK counts as no file.
// So installing or removing the block is never a difference from the accepted baseline (no STOP in receive the first
// time), and anything else in the file is still seen: taking out a known, harmless text cannot hide anything.
//
// Limits (the same as for any hook): `git push --no-verify` skips it, and the agent runs as the same OS user, so it can
// delete the marker or the block. It is a second layer under the text guard, not a sandbox. Doctor says when it is off
// or not installed.
//
// Pure: hookHash, insertBlock, stripBlock, isShellScript. The rest is I/O and never throws. Tested in
// __tests__/agentPushBlock.test.ts and __tests__/gitSurfaceBaseline.test.ts.
// =============================================================
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/** The hook file name git runs before a push. */
const HOOK = 'pre-push';
/** The marker file in a track worktree's own git dir. */
const MARKER = 'ravenseat-track';
/** The first and last line of the block. */
const BEGIN = '# >>> ravenseat agent push block (agentPushBlock in queue.config.json). Do not edit between these lines.';
const END = '# <<< ravenseat agent push block';
/**
 * The block, with its own line ending. Static text: the git surface recognises exactly this. Changing it shows as a
 * hook change once in a project that has it (the owner accepts it with `ravenseat surface accept --by owner`).
 */
const BLOCK = [
  BEGIN,
  'if [ -f "$(git rev-parse --absolute-git-dir 2>/dev/null)/ravenseat-track" ]; then',
  '  echo "push stopped: this is a queue track\'s worktree, and queue agents never push. The orchestrator merges the branch and pushes the base in batches (agentPushBlock)." >&2',
  '  exit 1',
  'fi',
  END,
  '',
].join('\n');
/** The first line of a pre-push the block wrote itself. */
const SHEBANG = '#!/bin/sh';
const FRESH = `${SHEBANG}\n${BLOCK}`;

/** Is the text a shell script (a #! line naming sh, bash, dash, zsh or ksh)? Pure. */
function isShellScript(text) {
  const first = String(text ?? '').split(/\r?\n/, 1)[0];
  return /^#!\s*\S*?(?:\/|\benv\s+(?:-\S+\s+)*)(?:sh|bash|dash|zsh|ksh)\b/.test(first);
}

/** The text with exactly BLOCK taken out (the first time it is there), or the text itself. Pure. */
function stripBlock(text) {
  const s = String(text ?? '');
  const at = s.indexOf(BLOCK);
  return at < 0 ? s : s.slice(0, at) + s.slice(at + BLOCK.length);
}

/** The text with BLOCK after its first line (a shell script), or null when it is not a shell script. Pure. */
function insertBlock(text) {
  const s = String(text ?? '');
  if (s.includes(BLOCK)) return s;
  if (!isShellScript(s)) return null;
  const nl = s.indexOf('\n');
  if (nl < 0) return `${s}\n${BLOCK}`;
  return s.slice(0, nl + 1) + BLOCK + s.slice(nl + 1);
}

/**
 * The hash the git surface keeps for a pre-push file (lib/gitExecSurface.js hookFiles): `armed` ('x' or '-') and the
 * sha256 of the content without BLOCK; null when the file is only what install() writes into an empty place (it counts
 * as no file). Pure.
 * @param {Buffer|string} content
 * @param {string} armed
 */
function hookHash(content, armed) {
  const text = Buffer.isBuffer(content) ? content.toString('utf8') : String(content);
  if (!text.includes(BLOCK)) return `${armed}${crypto.createHash('sha256').update(content).digest('hex')}`;
  const rest = stripBlock(text);
  if (rest === `${SHEBANG}\n`) return null;
  return `${armed}${crypto.createHash('sha256').update(rest).digest('hex')}`;
}

// ---- I/O -------------------------------------------------------------------------------------------------------

/** git in `cwd`: trimmed stdout, or null. */
function gitOut(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** The hooks folder git uses for `cwd` (it follows core.hooksPath, relative to the worktree), or null. */
function hooksDirFor(cwd) {
  const p = gitOut(cwd, ['rev-parse', '--git-path', 'hooks']);
  return p == null ? null : path.resolve(cwd, p);
}

/** What is in a hooks folder: 'installed' | 'missing' (no block yet; install can add it) | 'unsupported'. */
function status(dir) {
  let text = null;
  try {
    text = fs.readFileSync(path.join(dir, HOOK), 'utf8');
  } catch {
    return 'missing';
  }
  if (text.includes(BLOCK)) return 'installed';
  return isShellScript(text) ? 'missing' : 'unsupported';
}

/**
 * Puts the block into dir/pre-push. @returns 'installed' (written now) | 'present' (already there) | 'unsupported'
 * (a pre-push that is not a shell script; left alone) | 'error'.
 */
function install(dir) {
  const file = path.join(dir, HOOK);
  try {
    let text = null;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      text = null;
    }
    if (text == null) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, FRESH);
      fs.chmodSync(file, 0o755);
      return 'installed';
    }
    if (text.includes(BLOCK)) return 'present';
    const next = insertBlock(text);
    if (next == null) return 'unsupported';
    fs.writeFileSync(file, next); // keeps the file's mode
    return 'installed';
  } catch {
    return 'error';
  }
}

/** Takes the block out of dir/pre-push. @returns 'removed' | 'absent' | 'error'. A file install() wrote is deleted. */
function remove(dir) {
  const file = path.join(dir, HOOK);
  try {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      return 'absent';
    }
    if (!text.includes(BLOCK)) return 'absent';
    const rest = stripBlock(text);
    if (rest === `${SHEBANG}\n`) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, rest);
    return 'removed';
  } catch {
    return 'error';
  }
}

/** Is agentPushBlock on in this config (anything but false is on)? */
const enabledIn = (k) => k?.agentPushBlock?.enabled !== false;

/**
 * install() or remove() for the hooks folder git uses in `cwd`, from the setting. Never throws.
 * @returns {{ dir: string|null, result: string }}
 */
function ensure(cwd, k) {
  const dir = hooksDirFor(cwd);
  if (!dir) return { dir: null, result: 'error' };
  return { dir, result: enabledIn(k) ? install(dir) : remove(dir) };
}

/**
 * For prepare-track in a track worktree: writes the marker and, when the worktree's hooks folder is not the main
 * checkout's (a relative core.hooksPath), installs the block there too. A folder inside the worktree that git tracks is
 * left alone (the block would become part of the track's change); one that does not exist yet is created with a
 * .gitignore of "*", as husky does for its own. Never throws.
 * @returns {{ marker: boolean, dir: string|null, result: string }}  result also 'tracked' or 'not-ignored' (left alone)
 */
function prepareWorktree(worktree, mainCheckout, k) {
  let marker = false;
  const gitDir = gitOut(worktree, ['rev-parse', '--absolute-git-dir']);
  const common = gitOut(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  try {
    // Only in a linked worktree: its git dir is not the common one.
    if (gitDir && common && path.resolve(gitDir) !== path.resolve(common)) {
      fs.writeFileSync(path.join(gitDir, MARKER), 'This worktree belongs to a queue track (written by prepare-track).\n');
      marker = true;
    }
  } catch {
    marker = false;
  }
  const own = hooksDirFor(worktree);
  const shared = mainCheckout ? hooksDirFor(mainCheckout) : null;
  const same = (a, b) => {
    try {
      return fs.realpathSync.native(a).toLowerCase() === fs.realpathSync.native(b).toLowerCase();
    } catch {
      return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
    }
  };
  if (!own || (shared && same(own, shared))) return { marker, dir: own, result: 'shared' };
  if (!enabledIn(k)) return { marker, dir: own, result: remove(own) };
  const rel = path.relative(worktree, own);
  const inside = rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  if (inside) {
    if (!fs.existsSync(own)) {
      try {
        fs.mkdirSync(own, { recursive: true });
        fs.writeFileSync(path.join(own, '.gitignore'), '*\n');
      } catch {
        return { marker, dir: own, result: 'error' };
      }
    } else {
      const tracked = gitOut(worktree, ['ls-files', '--', rel.split(path.sep).join('/')]);
      if (tracked) return { marker, dir: own, result: 'tracked' };
      const ignored = spawnSync('git', ['-C', worktree, 'check-ignore', '-q', '--', path.join(rel, HOOK).split(path.sep).join('/')], {
        windowsHide: true,
      });
      if (ignored.status !== 0) return { marker, dir: own, result: 'not-ignored' };
    }
  }
  return { marker, dir: own, result: install(own) };
}

/**
 * The doctor row for the hook in the main checkout's hooks folder (the setting itself is in the settings row).
 * @returns {{ status: 'OK'|'INFO'|'WARN', message: string, fix: string|null }}
 */
function doctorRow(mainCheckout, k, cli = 'ravenseat') {
  const dir = hooksDirFor(mainCheckout);
  if (!dir) return { status: 'INFO', message: 'agent push block: git cannot say where the hooks folder is', fix: null };
  const s = status(dir);
  if (!enabledIn(k))
    return s === 'installed'
      ? { status: 'INFO', message: `agent push block is off but still in ${path.join(dir, HOOK)}`, fix: `the next ${cli} fill, start or resume removes it` }
      : { status: 'OK', message: 'agent push block is off and not installed', fix: null };
  if (s === 'installed') return { status: 'OK', message: `agent push block installed in ${path.join(dir, HOOK)}`, fix: null };
  if (s === 'unsupported')
    return {
      status: 'WARN',
      message: `agent push block cannot be installed: ${path.join(dir, HOOK)} is not a shell script, so agents can push from git itself when the text guard does not see the command`,
      fix: `make it a shell script that starts the other program, then run ${cli} fill or start; or set agentPushBlock.enabled off to silence this`,
    };
  return { status: 'INFO', message: 'agent push block not installed yet', fix: `the next ${cli} fill, start or resume installs it` };
}

module.exports = {
  HOOK,
  MARKER,
  BLOCK,
  isShellScript,
  stripBlock,
  insertBlock,
  hookHash,
  hooksDirFor,
  status,
  install,
  remove,
  enabledIn,
  ensure,
  prepareWorktree,
  doctorRow,
};
