// =============================================================
// gitExecSurface.js: what in git can run code at the orchestrator's next git command, and did a gate run change it.
//
// Why: gate commands run the track's code, scrubbed (lib/gateEnv.js), but as the same OS user. They can write the shared
// .git. A hook planted there runs at the orchestrator's next git command (the merge, a commit) WITH the tokens the gate
// was scrubbed of; __tests__/gateCoverageTamper.test.ts shows it. The same goes for config values that name a program.
// So the runners that start track code (gates.mjs, the done command, the base gate) read this surface before the first
// command and compare it after the last one. A change makes the run red and names what changed. lib/gitSurfaceBaseline.js
// keeps the accepted state between runs: a rerun cannot go green over a planted hook, and what an agent's own Bash wrote
// outside any run is seen at the next ravenseat receive, ravenseat merge or push-check, before their git commands.
//
// This is DETECTION, against accidents and simple cheating, not prevention: the planted hook stays until someone removes
// it or accepts it (no hook or config is restored, the message says what to inspect), a change that is undone before the
// check is not seen, a process that outlives the run can change things after it, a hook planted between the check and
// the git command runs, and git commands outside those stops (by hand, merge-track.mjs alone) are not stopped. A real
// boundary needs OS isolation (lib/gateEnv.js, Limits).
//
// The surface: { hooksDir, hooks: { <relative name>: <hash> }, config: { <key>: [values] } }, in memory only. The
// reason text names files and keys, never values (a config value can hold a secret).
//
// Reading it runs `git rev-parse` and `git config` only: neither runs hooks, fsmonitor or filters, so a surface that was
// tampered with is safe to read with the orchestrator's environment.
//
// Pure except readSurface and hookFiles. Tested in lib/__tests__/gitExecSurface.test.ts, __tests__/gateCoverageTamper.test.ts.
// =============================================================
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/** Config keys that run a program, exact (lower case: git prints section and variable names in lower case). */
const EXEC_KEYS = new Set([
  'core.hookspath', 'core.fsmonitor', 'core.sshcommand', 'core.pager', 'credential.helper', 'diff.external',
]);
/** The same with a free name in the key: every alias and filter, and the per-URL helper and per-driver programs. */
const EXEC_SHAPES = [/^alias\./, /^filter\./, /^credential\..+\.helper$/, /^merge\..+\.driver$/, /^diff\..+\.command$/];

/** Hook files read at most, folder depth, and the size over which a file counts by its size alone (runtime stays small). */
const MAX_FILES = 500;
const MAX_DEPTH = 3;
const MAX_HASHED_BYTES = 1 << 20;
/** Names listed per kind of change in the reason. */
const MAX_NAMED = 5;

/** What the message tells a person to do (nothing is restored). `git config` and rev-parse run no hooks. */
const INSPECT =
  'No hook or config was restored. Before the next git command in this repository, inspect the hooks folder ' +
  '(git rev-parse --git-path hooks) and git config --list --show-origin';

/** Does this config key run a program? Pure. */
function isExecKey(key) {
  const k = String(key ?? '').toLowerCase();
  return EXEC_KEYS.has(k) || EXEC_SHAPES.some((r) => r.test(k));
}

/**
 * The executing keys from `git config --null --list` (entries "key\nvalue\0"; a key without a value has no newline).
 * A key given more than once keeps every value, in order. Pure.
 * @returns {Record<string, string[]>}
 */
function parseConfigList(text) {
  const out = {};
  for (const item of String(text ?? '').split('\0')) {
    if (!item) continue;
    const nl = item.indexOf('\n');
    const key = nl < 0 ? item : item.slice(0, nl);
    if (isExecKey(key)) (out[key] ??= []).push(nl < 0 ? '' : item.slice(nl + 1));
  }
  return out;
}

/** The hash of one hook file: its content and whether it is executable (a chmod can arm a file). */
function fileHash(file, stat) {
  const armed = (stat.mode & 0o111) !== 0 ? 'x' : '-';
  if (stat.size > MAX_HASHED_BYTES) return `${armed}size:${stat.size}`;
  return `${armed}${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

/**
 * The files in a hooks folder with a hash each, by name relative to it (with "/"); {} when the folder is missing. A link
 * is followed; the depth and the file cap keep a cycle or a huge folder from costing anything.
 * @returns {Record<string, string>}
 */
function hookFiles(dir) {
  const out = {};
  let count = 0;
  const walk = (folder, prefix, depth) => {
    let names;
    try {
      names = fs.readdirSync(folder).sort();
    } catch {
      return; // no such folder: no hooks
    }
    for (const name of names) {
      if (++count > MAX_FILES) return;
      const file = path.join(folder, name);
      const rel = `${prefix}${name}`;
      try {
        const stat = fs.statSync(file);
        if (!stat.isDirectory()) out[rel] = fileHash(file, stat);
        else if (depth < MAX_DEPTH) walk(file, `${rel}/`, depth + 1);
      } catch {
        out[rel] = 'unreadable'; // a dangling link or a locked file still counts, as what it is now
      }
    }
  };
  walk(dir, '', 0);
  return out;
}

/** git in `cwd`: stdout, or null when the command failed. */
function gitOut(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });
  return r.status === 0 ? r.stdout : null;
}

/**
 * Reads the surface for a folder of the repository: the effective hooks folder (it follows core.hooksPath; from a linked
 * worktree it is the shared one) and the executing keys in the effective config (local, global and included files). A
 * part that cannot be read is null. Never throws.
 * @param {string} cwd
 * @param {{ git?: (cwd: string, args: string[]) => string|null }} [o]
 */
function readSurface(cwd, { git = gitOut } = {}) {
  const hooksPath = git(cwd, ['rev-parse', '--git-path', 'hooks']);
  const configText = git(cwd, ['config', '--null', '--list']);
  const hooksDir = hooksPath == null ? null : path.resolve(cwd, hooksPath.trim());
  return {
    hooksDir,
    hooks: hooksDir == null ? null : hookFiles(hooksDir),
    config: configText == null ? null : parseConfigList(configText),
  };
}

/** Sorted keys whose value differs between two maps, with values compared as JSON. Pure. */
function differingKeys(a, b) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).sort();
}

/** A short list of names. Pure. */
function named(list) {
  const shown = list.slice(0, MAX_NAMED).join(', ');
  return list.length > MAX_NAMED ? `${shown} and ${list.length - MAX_NAMED} more` : shown;
}

/**
 * What changed between two surfaces, one phrase per kind; [] when nothing did or the first read failed (nothing to
 * compare against). A surface that could be read before and not after is a change: broken config stops every later git
 * command. Names only, never values. Pure.
 * @returns {string[]}
 */
function surfaceChanges(before, after) {
  const out = [];
  if (before?.hooksDir && before.hooks && after) {
    if (!after.hooks) out.push('the hooks folder can no longer be found');
    else if (after.hooksDir !== before.hooksDir) out.push('the effective hooks folder moved');
    else {
      const changed = differingKeys(before.hooks, after.hooks);
      const added = changed.filter((k) => !(k in before.hooks));
      const removed = changed.filter((k) => !(k in after.hooks));
      const edited = changed.filter((k) => k in before.hooks && k in after.hooks);
      if (added.length) out.push(`hook added: ${named(added)}`);
      if (edited.length) out.push(`hook changed: ${named(edited)}`);
      if (removed.length) out.push(`hook removed: ${named(removed)}`);
    }
  }
  if (before?.config && after) {
    if (!after.config) out.push('the git config can no longer be read');
    else {
      const changed = differingKeys(before.config, after.config);
      if (changed.length) out.push(`git config changed: ${named(changed)}`);
    }
  }
  return out;
}

/** The reason text for a changed surface, or null when nothing changed. Pure. */
function surfaceChangeReason(before, after) {
  const changes = surfaceChanges(before, after);
  return changes.length ? `git hooks or config changed during the run (${changes.join('; ')})` : null;
}

module.exports = { INSPECT, isExecKey, parseConfigList, hookFiles, gitOut, readSurface, differingKeys, surfaceChanges, surfaceChangeReason };
