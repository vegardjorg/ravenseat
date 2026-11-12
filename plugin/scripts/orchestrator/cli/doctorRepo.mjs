// =============================================================
// cli/doctorRepo.mjs: the repo-state checks of `ravenseat doctor` (read-only). Review 2026-11-02, section 4.
//
// Three ways the queue breaks quietly, each a WARN with a one-line fix hint (never a FAIL: none of them is certain to be
// wrong, and the doctor must not block on a judgement call):
//   merge     a lingering MERGE_HEAD in the main checkout: a merge (often from an interrupted `ravenseat merge`) was never
//             finished or aborted, and the next merge fails in a confusing way. Counts the unresolved files too.
//   hooks-off `disableAllHooks: true` in a Claude Code settings file (project .claude/settings.json and
//             settings.local.json, user ~/.claude/settings.json, the managed settings file): every queue guard (push,
//             read, context, end gate) is off without a word. A file that does not parse is skipped (not this check's
//             business; Claude Code reports it).
//   in-base   done tasks whose work is not contained in the base branch (e.g. after `git reset --hard` on base). Uses
//             what the task stores: the merge commit (merge_commit, set by `ravenseat merge`; merge_sha as an older name) when it resolves, otherwise the branch
//             (o.branch, or the branch prefix + id) when it exists. A task with neither is counted as "not checked".
//             A squash merge also shows up here (its branch is not an ancestor); the hint says so.
// Git runs read-only (rev-parse, diff --name-only, merge-base --is-ancestor). Nothing is written.
//
// Kept apart from cli/doctor.mjs so other doctor changes merge cleanly. Used by: cli/doctor.mjs (REPO_CHECKS).
// Tested in: lib/__tests__/doctorRepo.test.ts.
// =============================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { BASE, branchFor, FILE, GIT_ROOT, MAIN_TREE } from './context.mjs';

const ok = (name, message) => ({ status: 'OK', name, message, fix: null });
const warn = (name, message, fix) => ({ status: 'WARN', name, message, fix });

/** git in the main checkout: { code, out } (code null when git could not start). Read-only commands only. */
function gitRun(args) {
  const r = spawnSync('git', args, {
    cwd: GIT_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
    timeout: 30_000,
  });
  return { code: r.status, out: String(r.stdout ?? '').trim() };
}

const short = (sha) => String(sha).slice(0, 9);
const quote = (p) => `"${p}"`;

/** merge: a MERGE_HEAD left in the main checkout. */
export function checkMergeHead() {
  const p = gitRun(['rev-parse', '--git-path', 'MERGE_HEAD']);
  if (p.code !== 0 || !p.out) return [];
  const file = path.resolve(GIT_ROOT, p.out);
  if (!fs.existsSync(file)) return [ok('merge', 'no unfinished merge in the main checkout')];
  const u = gitRun(['diff', '--name-only', '--diff-filter=U']);
  const unresolved = u.code === 0 ? u.out.split(/\r?\n/).filter(Boolean).length : null;
  let head = '';
  try {
    head = short(fs.readFileSync(file, 'utf8').trim().split(/\s+/)[0] ?? '');
  } catch {
    /* only shown when readable */
  }
  return [
    warn(
      'merge',
      `unfinished merge in the main checkout ${GIT_ROOT} (MERGE_HEAD${head ? ` ${head}` : ''}` +
        `${unresolved == null ? '' : `, ${unresolved} unresolved file(s)`}): the next merge will fail`,
      `finish it (resolve, git add, git commit) or undo it: git -C ${quote(GIT_ROOT)} merge --abort`,
    ),
  ];
}

/** The Claude Code settings files that can hold disableAllHooks, most specific first. */
export function settingsFiles({ root = MAIN_TREE, home = os.homedir(), platform = process.platform } = {}) {
  const managed =
    platform === 'win32'
      ? path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'ClaudeCode', 'managed-settings.json')
      : platform === 'darwin'
        ? '/Library/Application Support/ClaudeCode/managed-settings.json'
        : '/etc/claude-code/managed-settings.json';
  return [
    path.join(root, '.claude', 'settings.local.json'),
    path.join(root, '.claude', 'settings.json'),
    path.join(home, '.claude', 'settings.json'),
    managed,
  ];
}

/** hooks-off: disableAllHooks set in any Claude Code settings file. */
export function checkDisableAllHooks() {
  const files = settingsFiles();
  const off = [];
  for (const f of files) {
    let s;
    try {
      s = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch {
      continue; // missing or unparsable: nothing to say here
    }
    if (s && s.disableAllHooks === true) off.push(f);
  }
  if (!off.length) return [ok('hooks-off', 'no Claude Code settings file sets disableAllHooks')];
  return [
    warn(
      'hooks-off',
      `disableAllHooks is true in ${off.join(', ')}: every queue guard (push, read, context, end gate) is off`,
      'remove "disableAllHooks" from that file (or set it to false), then restart Claude Code',
    ),
  ];
}

/** The commit to check for a done task: the stored merge commit when it resolves, else the branch when it exists. */
function workRef(o) {
  for (const sha of [o?.merge_commit, o?.merge_sha]) {
    if (typeof sha !== 'string' || !/^[0-9a-f]{7,64}$/i.test(sha)) continue;
    if (gitRun(['rev-parse', '-q', '--verify', `${sha}^{commit}`]).code === 0) return { ref: sha, label: short(sha) };
  }
  const branch = typeof o?.branch === 'string' && o.branch ? o.branch : branchFor(o?.id);
  if (gitRun(['rev-parse', '-q', '--verify', `refs/heads/${branch}`]).code === 0) return { ref: `refs/heads/${branch}`, label: branch };
  return null;
}

/** in-base: done tasks whose merge or branch is not contained in the base branch. */
export function checkDoneInBase() {
  let q;
  try {
    q = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return []; // the queue check reports a missing or broken queue.json
  }
  const done = (Array.isArray(q?.tasks) ? q.tasks : []).filter((o) => o?.status === 'done' && o.id);
  if (!done.length) return [];
  if (gitRun(['rev-parse', '-q', '--verify', `refs/heads/${BASE}`]).code !== 0) return [];
  const missing = [];
  let unknown = 0;
  let checked = 0;
  for (const o of done) {
    const w = workRef(o);
    if (!w) {
      unknown++;
      continue;
    }
    const r = gitRun(['merge-base', '--is-ancestor', w.ref, `refs/heads/${BASE}`]);
    if (r.code === 0) checked++;
    else if (r.code === 1) missing.push(`${o.id} (${w.label})`);
    else unknown++;
  }
  const notChecked = unknown ? `; ${unknown} not checked (no branch or stored merge commit left)` : '';
  if (!missing.length) return [ok('in-base', `${checked} done task(s) contained in ${BASE}${notChecked}`)];
  const shown = missing.slice(0, 5).join(', ');
  return [
    warn(
      'in-base',
      `${missing.length} done task(s) whose work is not in ${BASE}: ${shown}${missing.length > 5 ? ' ...' : ''}${notChecked}`,
      `if ${BASE} was reset, merge the branch or the stored merge_commit again (git merge --no-ff <ref>); a squash merge also shows here and is fine`,
    ),
  ];
}

/** The checks in the order cmdDoctor prints them. */
export const REPO_CHECKS = [checkMergeHead, checkDisableAllHooks, checkDoneInBase];
