// =============================================================
// ghStatus.test.ts: the doctor row for the GitHub CLI (lib/ghStatus.js, TH-1).
//
// Locks: (1) no gh feature in use: no row and gh is never run (no network call); (2) each feature counts: push.ciWatch
// github, gateEvidence external, the branch-protection card (its cache), issue links and issues.labelMap; (3) gh missing
// and gh not signed in are WARN with the fix; (4) a GH_TOKEN or GITHUB_TOKEN that GitHub rejects while gh's own login
// works is named as such, and the token's value is never in the row; (5) a network error says nothing; (6) never FAIL.
// gh is an injected runner here: no test runs the real gh.
// =============================================================
import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const GS = require('../ghStatus.js');

type Res = { missing?: boolean; code?: number | null; out?: string; err?: string; timedOut?: boolean };
// Built at run time so no committed file holds a string the secret scan flags.
const SECRET = ['ghp', 'abcdefghijklmnopqrstuvwxyz0123456789'].join('_');

/** A fake gh: `auth status` answers by whether a token var is set in the env it got. */
function fakeGh({ missing = false, withToken, withoutToken }: { missing?: boolean; withToken?: Res; withoutToken?: Res }) {
  const calls: { args: string[]; env: Record<string, string | undefined> }[] = [];
  const run = (args: string[], o: { env: Record<string, string | undefined> }) => {
    calls.push({ args, env: o.env });
    if (missing) return { missing: true, code: null, out: '', err: '' };
    if (args[0] === '--version') return { code: 0, out: 'gh version 2.60.0', err: '' };
    const has = !!(o.env.GH_TOKEN || o.env.GITHUB_TOKEN);
    return (has ? withToken : withoutToken) ?? { code: 0, out: '', err: '' };
  };
  return { run, calls };
}

describe('featuresInUse', () => {
  it('is empty by default', () => {
    expect(GS.featuresInUse({}, {})).toEqual([]);
  });
  it('names each gh feature', () => {
    expect(GS.featuresInUse({ push: { ciWatch: 'github' } }, {})).toEqual(['push.ciWatch github']);
    expect(GS.featuresInUse({ gateEvidence: { mode: 'external' } }, {})).toEqual(['gateEvidence external']);
    expect(GS.featuresInUse({}, { branchProtectionCache: true })).toEqual(['the branch-protection card']);
    expect(GS.featuresInUse({}, { issueLinks: 2 })).toEqual(['issue links']);
    expect(GS.featuresInUse({ issues: { labelMap: { bug: 'K' } } }, {})).toEqual(['issues.labelMap']);
    expect(GS.featuresInUse({ issues: { onPush: 'close' } }, {})).toEqual(['issues.onPush close']);
    expect(GS.featuresInUse({ push: { pr: 'draft' } }, {})).toEqual(['push.pr draft']);
    expect(GS.featuresInUse({ issues: { onPush: 'off' }, push: { pr: 'off' } }, {})).toEqual([]);
  });
});

describe('doctorRows', () => {
  it('runs nothing when no gh feature is in use', () => {
    const g = fakeGh({});
    expect(GS.doctorRows({ features: [], run: g.run, env: {} })).toEqual([]);
    expect(g.calls).toEqual([]);
  });
  it('WARN when gh is missing', () => {
    const g = fakeGh({ missing: true });
    const rows = GS.doctorRows({ features: ['push.ciWatch github'], run: g.run, env: {} });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'WARN', name: 'gh' });
    expect(rows[0].message).toMatch(/not installed/);
    expect(rows[0].message).toMatch(/push\.ciWatch github/);
    expect(rows[0].fix).toMatch(/cli\.github\.com/);
  });
  it('OK when gh is signed in', () => {
    const g = fakeGh({});
    const rows = GS.doctorRows({ features: ['issue links'], run: g.run, env: {} });
    expect(rows[0]).toMatchObject({ status: 'OK', name: 'gh' });
  });
  it('WARN when gh is not signed in', () => {
    const g = fakeGh({ withoutToken: { code: 1, err: 'You are not logged into any GitHub hosts. To log in, run: gh auth login' } });
    const rows = GS.doctorRows({ features: ['issue links'], run: g.run, env: {} });
    expect(rows[0]).toMatchObject({ status: 'WARN', name: 'gh' });
    expect(rows[0].message).toMatch(/not signed in/);
    expect(rows[0].fix).toMatch(/gh auth login/);
  });
  it('names a rejected GH_TOKEN while gh itself is signed in, without its value', () => {
    const g = fakeGh({
      withToken: { code: 1, err: `The token in GH_TOKEN is invalid. ${SECRET}` },
      withoutToken: { code: 0, out: 'Logged in to github.com account someone (keyring)' },
    });
    const rows = GS.doctorRows({ features: ['gateEvidence external'], run: g.run, env: { GH_TOKEN: SECRET, PATH: 'x' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'WARN', name: 'gh' });
    expect(rows[0].message).toMatch(/GH_TOKEN/);
    expect(rows[0].message).toMatch(/rejects/);
    expect(rows[0].fix).toMatch(/unset GH_TOKEN|GH_TOKEN/);
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    // The second call ran without the token vars, and kept the rest of the env.
    const second = g.calls.filter((c) => c.args[0] === 'auth').at(-1)!;
    expect(second.env.GH_TOKEN).toBeUndefined();
    expect(second.env.PATH).toBe('x');
  });
  it('names GITHUB_TOKEN too', () => {
    const g = fakeGh({ withToken: { code: 1, err: 'HTTP 401: Bad credentials' }, withoutToken: { code: 0 } });
    const rows = GS.doctorRows({ features: ['issue links'], run: g.run, env: { GITHUB_TOKEN: SECRET } });
    expect(rows[0].message).toMatch(/GITHUB_TOKEN/);
  });
  it('says nothing on a network error or a time-out', () => {
    const net = fakeGh({ withoutToken: { code: 1, err: 'error connecting to api.github.com' } });
    expect(GS.doctorRows({ features: ['issue links'], run: net.run, env: {} })).toEqual([]);
    const slow = fakeGh({ withoutToken: { code: null, timedOut: true } });
    expect(GS.doctorRows({ features: ['issue links'], run: slow.run, env: {} })).toEqual([]);
  });
  it('is never FAIL', () => {
    const cases = [fakeGh({ missing: true }), fakeGh({ withoutToken: { code: 1, err: 'gh auth login' } }), fakeGh({})];
    for (const g of cases)
      for (const r of GS.doctorRows({ features: ['issue links'], run: g.run, env: {} })) expect(r.status).not.toBe('FAIL');
  });
});
