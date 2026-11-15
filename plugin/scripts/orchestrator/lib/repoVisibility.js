// =============================================================
// repoVisibility.js: is the project's repo public, private or unknown?
//
// WHY: sharing the queue's files in git (`ravenseat share on`, lib/queueShare.js) is a useful backup in a private repo
// and nearly always unwanted in a public one, where anyone can read the queue and the plan register. So the visibility
// decides the advice and the confirmation: in a private repo setup and the Checks tab may offer `share on`, in a public
// or unknown one `share on` needs --public-ok as well. And the push guard refuses a push once the repo has turned
// public after a private confirmation (the most dangerous change, so it must not pass quietly).
//
// How it is found:
//   GitHub   `gh repo view --json visibility` (signed in, sees private repos), else GET /repos/<owner>/<name> on the API
//            with a short time limit: 200 with private false = public, private true = private, 404 (private or missing,
//            without login) = unknown.
//   GitLab   GET /api/v4/projects/<owner%2Fname>: the visibility field (internal counts as private).
//   other hosts, no remote, no network, an error: unknown. Unknown is treated as public (strict): isPrivate() is true
//   only for a clear private answer.
// The answer is cached in the data folder (repo-visibility.json, ignored by git like the rest of it) with its time and
// the remote it was asked for. It is fresh for 24 hours. The push hook (10 s limit) only ever reads the cache, of any age,
// and never calls the network; `share on`, `share status`, setup and merge refresh it when it is old.
//
// Pure apart from the cache file and the default callers: every test injects `gh` and `fetchJson`.
//
//   parseRemote(url)            { host: 'github'|'gitlab', owner, name } or null
//   fromGh / fromGithubApi / fromGitlabApi   one answer as 'public' | 'private' | 'unknown' (fromGh: null when unreadable)
//   detect({ remoteUrl, gh, fetchJson, timeoutMs })   async, never throws: { visibility, source }
//   readCache(folder, { now, any, remote }), writeCache(folder, entry)
//   current({ folder, remoteUrl, now, gh, fetchJson, refresh })   the cache when fresh, else detect and write
//   isPrivate(v)
//
// Used by: cli/share.mjs, cli/merge.mjs, cli/checks.mjs, setup.mjs, hook-push-guard.mjs (cache only).
// Tested in: lib/__tests__/repoVisibility.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CACHE_FILE = 'repo-visibility.json';
const MAX_AGE_MS = 24 * 3600_000;
const TIMEOUT_MS = 3000;
const VALUES = new Set(['public', 'private', 'unknown']);

/**
 * The host, owner and name of a GitHub or GitLab remote URL (ssh, scp-like or https), or null.
 * GitLab may have subgroups: the owner is then "group/sub".
 * @param {unknown} url
 */
function parseRemote(url) {
  if (typeof url !== 'string' || !url.trim()) return null;
  const u = url.trim();
  const m =
    /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?(github\.com|gitlab\.com)[:/](.+?)(?:\.git)?\/?$/i.exec(u);
  if (!m) return null;
  const parts = m[2].split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const host = m[1].toLowerCase().startsWith('github') ? 'github' : 'gitlab';
  if (host === 'github' && parts.length !== 2) return null;
  return { host, owner: parts.slice(0, -1).join('/'), name: parts[parts.length - 1] };
}

/** gh's JSON (`{"visibility":"PUBLIC"}`) as public/private, or null when it cannot be read. */
function fromGh(stdout) {
  try {
    const v = String(JSON.parse(String(stdout)).visibility ?? '').toLowerCase();
    if (v === 'public') return 'public';
    if (v === 'private' || v === 'internal') return 'private';
  } catch {
    // not gh's answer
  }
  return null;
}

/** The GitHub API's answer: only a 200 says anything; a 404 without login can be a private repo. */
function fromGithubApi(r) {
  if (r?.status !== 200 || !r.body || typeof r.body.private !== 'boolean') return 'unknown';
  return r.body.private ? 'private' : 'public';
}

/** The GitLab API's answer (internal: only signed-in users of the instance see it, so not public). */
function fromGitlabApi(r) {
  const v = r?.status === 200 ? String(r.body?.visibility ?? '') : '';
  if (v === 'public') return 'public';
  if (v === 'private' || v === 'internal') return 'private';
  return 'unknown';
}

/** The default gh caller: `gh repo view <owner>/<name> --json visibility`, with the time limit. Throws when gh is missing. */
function defaultGh(remote, { timeoutMs = TIMEOUT_MS } = {}) {
  const stdout = execFileSync('gh', ['repo', 'view', `${remote.owner}/${remote.name}`, '--json', 'visibility'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: timeoutMs,
    windowsHide: true,
  });
  return { status: 0, stdout };
}

/** The default API caller: fetch with a time limit, no credentials. */
async function defaultFetchJson(url, { timeoutMs = TIMEOUT_MS } = {}) {
  const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'ravenseat' }, signal: AbortSignal.timeout(timeoutMs) });
  let body = {};
  try {
    body = await r.json();
  } catch {
    // not JSON: the status alone
  }
  return { status: r.status, body };
}

/**
 * Asks the host. Never throws: any error, a time-out or another host gives unknown.
 * @param {{ remoteUrl?: string|null, gh?: Function, fetchJson?: Function, timeoutMs?: number }} o
 * @returns {Promise<{ visibility: 'public'|'private'|'unknown', source: string }>}
 */
async function detect({ remoteUrl, gh = defaultGh, fetchJson = defaultFetchJson, timeoutMs = TIMEOUT_MS } = {}) {
  const remote = parseRemote(remoteUrl);
  if (!remote) return { visibility: 'unknown', source: 'host' };
  try {
    if (remote.host === 'github') {
      try {
        const r = gh(remote, { timeoutMs });
        const v = r && r.status === 0 ? fromGh(r.stdout) : null;
        if (v) return { visibility: v, source: 'gh' };
      } catch {
        // no gh, or not signed in: the API
      }
      const r = await fetchJson(`https://api.github.com/repos/${remote.owner}/${remote.name}`, { timeoutMs });
      return { visibility: fromGithubApi(r), source: 'api' };
    }
    const r = await fetchJson(`https://gitlab.com/api/v4/projects/${encodeURIComponent(`${remote.owner}/${remote.name}`)}`, { timeoutMs });
    return { visibility: fromGitlabApi(r), source: 'api' };
  } catch {
    return { visibility: 'unknown', source: 'error' };
  }
}

/** Only a clear private answer is private; unknown is treated as public. */
const isPrivate = (v) => v === 'private';

/**
 * The cached answer, or null. Not fresh (older than maxAgeMs): null, unless `any` (the push hook reads any age).
 * An answer for another remote does not count. A missing or broken file reads as none.
 */
function readCache(folder, { now = Date.now(), maxAgeMs = MAX_AGE_MS, any = false, remote } = {}) {
  let c;
  try {
    c = JSON.parse(fs.readFileSync(path.join(folder, CACHE_FILE), 'utf8'));
  } catch {
    return null;
  }
  if (!c || !VALUES.has(c.visibility)) return null;
  if (remote !== undefined && (c.remote ?? null) !== (remote ?? null)) return null;
  const at = Date.parse(c.checkedAt);
  const fresh = Number.isFinite(at) && now - at <= maxAgeMs && now >= at - 60_000;
  if (!fresh && !any) return null;
  return { visibility: c.visibility, source: c.source ?? null, remote: c.remote ?? null, checkedAt: c.checkedAt ?? null, fresh };
}

/** Writes the answer (temp file and rename, so a reader never sees half of it). Errors are the caller's. */
function writeCache(folder, entry) {
  fs.mkdirSync(folder, { recursive: true });
  const file = path.join(folder, CACHE_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/**
 * The visibility now: the cache while fresh (and for the same remote), otherwise asks the host and caches the answer.
 * `refresh` asks even when the cache is fresh. A cache that cannot be written still gives the answer.
 */
async function current({ folder, remoteUrl = null, now = Date.now(), gh, fetchJson, timeoutMs, refresh = false } = {}) {
  if (!refresh) {
    const c = readCache(folder, { now, remote: remoteUrl });
    if (c) return c;
  }
  const r = await detect({ remoteUrl, gh, fetchJson, timeoutMs });
  const entry = { visibility: r.visibility, source: r.source, remote: remoteUrl, checkedAt: new Date(now).toISOString() };
  try {
    writeCache(folder, entry);
  } catch {
    // error-ignored: the answer is still used, it is only asked again next time
  }
  return { ...entry, fresh: true };
}

/** The remote's URL for `remote` in the repo at `cwd`, or null (no remote, no git). */
function remoteUrlOf(cwd, remote = 'origin') {
  try {
    return (
      execFileSync('git', ['-C', cwd, 'remote', 'get-url', remote], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim() ||
      null
    );
  } catch {
    return null;
  }
}

module.exports = {
  CACHE_FILE,
  MAX_AGE_MS,
  parseRemote,
  fromGh,
  fromGithubApi,
  fromGitlabApi,
  detect,
  isPrivate,
  readCache,
  writeCache,
  current,
  remoteUrlOf,
};
