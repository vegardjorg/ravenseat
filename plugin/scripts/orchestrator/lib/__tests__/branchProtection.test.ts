// =============================================================
// branchProtection.test.ts: is the base branch protected on GitHub (lib/branchProtection.js)?
//
// Why: the Checks card branch-protection hides itself only on a clear "protected" from the host. Every other answer
// (no gh, not signed in, a time-out, another host) shows the card. gh is always injected here: no test makes a network
// call, and without an injected gh the module never calls the real one under the tests.
// =============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { current, detect, fromClassic, fromRules, readCache } from '../branchProtection';

const temporary: string[] = [];
afterAll(() => {
  for (const d of temporary) fs.rmSync(d, { recursive: true, force: true });
});

const REMOTE = { host: 'github', owner: 'o', name: 'r' };
type Answer = { code: number; stdout: string; stderr?: string } | null;
/** A fake gh: the rules answer and the classic answer, and the calls it got. */
function fakeGh(rules: Answer, classic: Answer) {
  const calls: string[][] = [];
  const gh = (args: string[]) => {
    calls.push(args);
    return args[1].includes('/rules/branches/') ? rules : classic;
  };
  return { gh, calls };
}

describe('the answers', () => {
  it('a ruleset with a protecting rule is on; other rules say nothing', () => {
    expect(fromRules([{ type: 'deletion' }, { type: 'pull_request' }])).toBe('on');
    expect(fromRules([{ type: 'non_fast_forward' }])).toBe('on');
    expect(fromRules([{ type: 'deletion' }])).toBeNull();
    expect(fromRules({})).toBeNull();
  });

  it('classic protection: an object is on, "Branch not protected" is off, anything else says nothing', () => {
    expect(fromClassic({ code: 0, stdout: JSON.stringify({ url: 'x', required_status_checks: {} }) })).toBe('on');
    expect(fromClassic({ code: 1, stdout: '{"message":"Branch not protected","status":"404"}' })).toBe('off');
    expect(fromClassic({ code: 1, stdout: '', stderr: 'HTTP 403: Must have admin rights' })).toBeNull();
    expect(fromClassic(null)).toBeNull();
  });
});

describe('detect', () => {
  it('a ruleset answers first; the classic endpoint only when the rules do not say on', () => {
    const a = fakeGh({ code: 0, stdout: JSON.stringify([{ type: 'required_status_checks' }]) }, null);
    expect(detect({ remote: REMOTE, branch: 'main', gh: a.gh })).toBe('on');
    expect(a.calls).toEqual([['api', 'repos/o/r/rules/branches/main']]);
    const b = fakeGh({ code: 0, stdout: '[]' }, { code: 1, stdout: '{"message":"Branch not protected"}' });
    expect(detect({ remote: REMOTE, branch: 'main', gh: b.gh })).toBe('off');
    expect(b.calls[1]).toEqual(['api', 'repos/o/r/branches/main/protection']);
  });

  it('no gh, no clear answer, another host or no branch: unknown', () => {
    expect(detect({ remote: REMOTE, branch: 'main', gh: () => null })).toBe('unknown');
    expect(detect({ remote: REMOTE, branch: 'main', gh: fakeGh({ code: 1, stdout: '' }, { code: 1, stdout: 'HTTP 403' }).gh })).toBe('unknown');
    expect(detect({ remote: { host: 'gitlab', owner: 'o', name: 'r' }, branch: 'main', gh: () => ({ code: 0, stdout: '[]' }) })).toBe('unknown');
    expect(detect({ remote: REMOTE, branch: '', gh: () => ({ code: 0, stdout: '[]' }) })).toBe('unknown');
    // Under the tests, no gh passed means no call at all.
    expect(detect({ remote: REMOTE, branch: 'main' })).toBe('unknown');
  });
});

describe('current', () => {
  it('caches the answer per remote and branch for a day, so a refresh does not ask again', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'branch-protection-'));
    temporary.push(folder);
    const a = fakeGh({ code: 0, stdout: JSON.stringify([{ type: 'pull_request' }]) }, null);
    const url = 'https://github.com/o/r.git';
    const now = Date.parse('2026-11-15T10:00:00Z');
    expect(current({ folder, remoteUrl: url, branch: 'main', now, gh: a.gh })).toBe('on');
    expect(current({ folder, remoteUrl: url, branch: 'main', now: now + 3600_000, gh: a.gh })).toBe('on');
    expect(a.calls.length).toBe(1);
    expect(readCache(folder, { remoteUrl: url, branch: 'other', now })).toBeNull();
    expect(readCache(folder, { remoteUrl: url, branch: 'main', now: now + 25 * 3600_000 })).toBeNull();
  });
});
