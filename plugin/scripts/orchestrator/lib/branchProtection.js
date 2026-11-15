// =============================================================
// branchProtection.js: is the base branch protected on GitHub (CI required before merge, no force-push)?
//
// WHY: the queue's own guards run on this machine. On the remote, anyone with write access (or a session with a token)
// can still force-push over the base branch or merge without CI. Branch protection or a ruleset on the host closes
// that, and only the owner can turn it on. The Checks card branch-protection suggests it, and hides itself once the
// host says the branch is protected.
//
// How it asks: with gh only (signed in, so it sees private repos), never a plain web call and never without gh.
//   1. `gh api repos/<owner>/<name>/rules/branches/<branch>`: the rulesets in force on the branch (readable with read
//      access). A pull_request, required_status_checks or non_fast_forward rule counts as protected.
//   2. `gh api repos/<owner>/<name>/branches/<branch>/protection`: classic protection (needs admin to read). An answer
//      with content: protected. "Branch not protected": not.
//   No gh, not signed in, another host, a time-out or no clear answer: unknown, and the card is shown.
// The answer is cached for 24 hours in the data folder (branch-protection.json, ignored like the rest), per remote and
// branch, so the board's refresh never asks again within a day. A run under the tests (VITEST set) never calls gh
// unless a gh function is passed in.
//
//   fromRules(json), fromClassic(r)   one answer as 'on' | 'off' | null (null: says nothing)
//   detect({ remote, branch, gh, timeoutMs })   'on' | 'off' | 'unknown', never throws
//   current({ folder, remoteUrl, branch, now, gh })   the cache while fresh, else detect and write it
//
// Used by: cli/checks.mjs. Tested in: lib/__tests__/branchProtection.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { parseRemote } = require('./repoVisibility.js');

const CACHE_FILE = 'branch-protection.json';
const MAX_AGE_MS = 24 * 3600_000;
const TIMEOUT_MS = 3000;
const PROTECTING_RULES = new Set(['pull_request', 'required_status_checks', 'non_fast_forward']);

/** The rulesets endpoint's list: on when a protecting rule is in force, else null (classic protection may still be on). */
function fromRules(json) {
  if (!Array.isArray(json)) return null;
  return json.some((r) => PROTECTING_RULES.has(r?.type)) ? 'on' : null;
}

/** The classic protection endpoint: { code, stdout }. A JSON object back: on. A 404 "not protected": off. */
function fromClassic(r) {
  if (!r) return null;
  const text = String(r.stdout ?? '');
  if (r.code === 0) {
    try {
      const j = JSON.parse(text);
      if (j && typeof j === 'object' && (j.required_status_checks || j.allow_force_pushes || j.required_pull_request_reviews || j.url)) return 'on';
    } catch {
      return null;
    }
    return null;
  }
  return /branch not protected/i.test(`${text} ${r.stderr ?? ''}`) ? 'off' : null;
}

/** The default gh caller: { code, stdout, stderr }, or null when gh is missing or the call timed out. */
function defaultGh(args, { timeoutMs = TIMEOUT_MS } = {}) {
  const x = spawnSync('gh', args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  if (x.error || x.signal) return null;
  return { code: x.status ?? 1, stdout: x.stdout ?? '', stderr: x.stderr ?? '' };
}

/**
 * Asks GitHub through gh. Never throws.
 * @param {{ remote: { host: string, owner: string, name: string }|null, branch: string, gh?: Function|null, timeoutMs?: number }} o
 * @returns {'on'|'off'|'unknown'}
 */
function detect({ remote, branch, gh = null, timeoutMs = TIMEOUT_MS }) {
  if (!remote || remote.host !== 'github' || !branch) return 'unknown';
  const call = gh ?? (process.env.VITEST ? null : defaultGh);
  if (!call) return 'unknown';
  try {
    const repo = `repos/${remote.owner}/${remote.name}`;
    const b = encodeURIComponent(branch);
    const rules = call(['api', `${repo}/rules/branches/${b}`], { timeoutMs });
    if (!rules) return 'unknown'; // no gh: the second call would not answer either
    if (rules.code === 0) {
      let json = null;
      try {
        json = JSON.parse(String(rules.stdout ?? ''));
      } catch {
        json = null;
      }
      if (fromRules(json) === 'on') return 'on';
    }
    return fromClassic(call(['api', `${repo}/branches/${b}/protection`], { timeoutMs })) ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The cached answer for this remote and branch while fresh, else null. A broken file reads as none. */
function readCache(folder, { remoteUrl, branch, now = Date.now() }) {
  try {
    const c = JSON.parse(fs.readFileSync(path.join(folder, CACHE_FILE), 'utf8'));
    if (!c || c.remote !== remoteUrl || c.branch !== branch || !['on', 'off', 'unknown'].includes(c.state)) return null;
    const at = Date.parse(c.checkedAt);
    return Number.isFinite(at) && now - at <= MAX_AGE_MS && now >= at - 60_000 ? c.state : null;
  } catch {
    return null;
  }
}

/**
 * The answer now: the cache while fresh, else asks and caches (an unknown answer too, so a missing gh is not asked
 * again on every refresh). A cache that cannot be written still gives the answer.
 */
function current({ folder, remoteUrl, branch, now = Date.now(), gh = null, timeoutMs = TIMEOUT_MS }) {
  if (!remoteUrl || !branch) return 'unknown';
  const cached = folder ? readCache(folder, { remoteUrl, branch, now }) : null;
  if (cached) return cached;
  const state = detect({ remote: parseRemote(remoteUrl), branch, gh, timeoutMs });
  if (folder && (gh || !process.env.VITEST)) {
    try {
      fs.mkdirSync(folder, { recursive: true });
      const file = path.join(folder, CACHE_FILE);
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify({ state, remote: remoteUrl, branch, checkedAt: new Date(now).toISOString() }, null, 2)}\n`);
      fs.renameSync(tmp, file);
    } catch {
      // error-ignored: the answer is still used, it is asked again next time
    }
  }
  return state;
}

module.exports = { CACHE_FILE, fromRules, fromClassic, detect, readCache, current };
