// =============================================================
// repoVisibility.test.ts: is the repo public, private or unknown (lib/repoVisibility.js)?
//
// Why: sharing the queue's files in git is a useful backup in a private repo and nearly always unwanted in a public
// one, so `ravenseat share on` and the push guard ask the host. The answers are read from gh or the host's API; no
// test here makes a network call or runs gh: the callers are injected. Unknown counts as public (strict), and the
// answer is cached for 24 hours in the data folder so the push hook (10 s limit) never calls the network.
// =============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RV = require('../repoVisibility.js');

const temporary: string[] = [];
afterAll(() => {
  for (const d of temporary) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-'));
  temporary.push(d);
  return d;
};

describe('parseRemote', () => {
  it('reads GitHub and GitLab remotes in ssh and https form', () => {
    expect(RV.parseRemote('git@github.com:acme/tool.git')).toEqual({ host: 'github', owner: 'acme', name: 'tool' });
    expect(RV.parseRemote('https://github.com/acme/tool')).toEqual({ host: 'github', owner: 'acme', name: 'tool' });
    expect(RV.parseRemote('ssh://git@github.com/acme/tool.git')).toEqual({ host: 'github', owner: 'acme', name: 'tool' });
    expect(RV.parseRemote('https://gitlab.com/group/sub/tool.git')).toEqual({ host: 'gitlab', owner: 'group/sub', name: 'tool' });
  });

  it('gives null for other hosts, a local path or nothing', () => {
    for (const u of ['https://example.org/acme/tool.git', 'C:/repos/origin.git', '/srv/git/x.git', '', null])
      expect(RV.parseRemote(u), String(u)).toBeNull();
  });
});

describe('the answers', () => {
  it('gh repo view --json visibility', () => {
    expect(RV.fromGh('{"visibility":"PUBLIC"}')).toBe('public');
    expect(RV.fromGh('{"visibility":"PRIVATE"}')).toBe('private');
    // Internal: only the enterprise sees it, so it is not public.
    expect(RV.fromGh('{"visibility":"INTERNAL"}')).toBe('private');
    expect(RV.fromGh('not json')).toBeNull();
  });

  it('the GitHub API: 200 with private false is public; 404 (private or missing, without login) is unknown', () => {
    expect(RV.fromGithubApi({ status: 200, body: { private: false } })).toBe('public');
    expect(RV.fromGithubApi({ status: 200, body: { private: true } })).toBe('private');
    expect(RV.fromGithubApi({ status: 404, body: {} })).toBe('unknown');
  });

  it('the GitLab API: visibility', () => {
    expect(RV.fromGitlabApi({ status: 200, body: { visibility: 'public' } })).toBe('public');
    expect(RV.fromGitlabApi({ status: 200, body: { visibility: 'internal' } })).toBe('private');
    expect(RV.fromGitlabApi({ status: 200, body: { visibility: 'private' } })).toBe('private');
    expect(RV.fromGitlabApi({ status: 401, body: {} })).toBe('unknown');
  });
});

describe('detect (injected callers only)', () => {
  it('GitHub: gh first; without gh the API, with the time limit', async () => {
    const calls: string[] = [];
    const gh = () => ({ status: 0, stdout: '{"visibility":"PRIVATE"}' });
    const fetchJson = async (url: string, o: { timeoutMs: number }) => {
      calls.push(`${url} ${o.timeoutMs}`);
      return { status: 200, body: { private: false } };
    };
    expect(await RV.detect({ remoteUrl: 'git@github.com:acme/tool.git', gh, fetchJson })).toMatchObject({ visibility: 'private', source: 'gh' });
    expect(calls).toEqual([]);
    const noGh = () => {
      throw new Error('gh not found');
    };
    expect(await RV.detect({ remoteUrl: 'git@github.com:acme/tool.git', gh: noGh, fetchJson, timeoutMs: 1500 })).toMatchObject({ visibility: 'public', source: 'api' });
    expect(calls).toEqual(['https://api.github.com/repos/acme/tool 1500']);
  });

  it('GitLab: the project API with the path encoded', async () => {
    let asked = '';
    const fetchJson = async (url: string) => {
      asked = url;
      return { status: 200, body: { visibility: 'public' } };
    };
    expect((await RV.detect({ remoteUrl: 'https://gitlab.com/group/tool.git', fetchJson })).visibility).toBe('public');
    expect(asked).toBe('https://gitlab.com/api/v4/projects/group%2Ftool');
  });

  it('another host, no remote, or a caller that fails or times out: unknown, never an error', async () => {
    const boom = async () => {
      throw new Error('timeout');
    };
    expect((await RV.detect({ remoteUrl: 'https://example.org/a/b.git', fetchJson: boom })).visibility).toBe('unknown');
    expect((await RV.detect({ remoteUrl: null, fetchJson: boom })).visibility).toBe('unknown');
    expect((await RV.detect({ remoteUrl: 'git@github.com:a/b.git', gh: () => ({ status: 1, stdout: '' }), fetchJson: boom })).visibility).toBe('unknown');
  });

  it('strict: only private is private; unknown counts as public', () => {
    expect(RV.isPrivate('private')).toBe(true);
    for (const v of ['public', 'unknown', undefined, null]) expect(RV.isPrivate(v)).toBe(false);
  });
});

describe('the cache in the data folder (24 h)', () => {
  const now = Date.parse('2026-11-15T12:00:00Z');

  it('a fresh answer is used; an old one is not fresh, but the hook may still read it', () => {
    const folder = tmp();
    RV.writeCache(folder, { visibility: 'private', source: 'gh', remote: 'git@github.com:a/b.git', checkedAt: new Date(now).toISOString() });
    expect(RV.readCache(folder, { now: now + 60_000 })).toMatchObject({ visibility: 'private', fresh: true });
    const later = now + 25 * 3600_000;
    expect(RV.readCache(folder, { now: later })).toBeNull();
    expect(RV.readCache(folder, { now: later, any: true })).toMatchObject({ visibility: 'private', fresh: false });
  });

  it('an answer for another remote does not count; a broken file reads as none', () => {
    const folder = tmp();
    RV.writeCache(folder, { visibility: 'private', source: 'gh', remote: 'git@github.com:a/b.git', checkedAt: new Date(now).toISOString() });
    expect(RV.readCache(folder, { now, remote: 'git@github.com:a/other.git', any: true })).toBeNull();
    fs.writeFileSync(path.join(folder, RV.CACHE_FILE), '{oops');
    expect(RV.readCache(folder, { now, any: true })).toBeNull();
  });

  it('current(): the cache while fresh, otherwise asks once and writes the answer', async () => {
    const folder = tmp();
    let asked = 0;
    const fetchJson = async () => {
      asked++;
      return { status: 200, body: { private: true } };
    };
    const o = { folder, remoteUrl: 'https://github.com/a/b', now, gh: () => ({ status: 1, stdout: '' }), fetchJson };
    expect((await RV.current(o)).visibility).toBe('private');
    expect((await RV.current({ ...o, now: now + 3600_000 })).visibility).toBe('private');
    expect(asked).toBe(1);
    await RV.current({ ...o, now: now + 3600_000, refresh: true });
    expect(asked).toBe(2);
  });
});
