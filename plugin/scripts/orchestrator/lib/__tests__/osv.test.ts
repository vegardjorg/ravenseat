// =============================================================
// osv.test.ts: lib/osv.js, the dependency audit against OSV.dev (roadmap 0å KD-4). Every test injects fetch: no test
// ever reaches the network.
//
// Locks: (1) only public packages are sent, as ecosystem, name and version, and the exact request body is asserted;
// workspace, file:, link:, git, local paths, another registry and deps.privateScopes are held back; (2) the dry plan names
// the count, the ecosystems and the host; (3) querybatch first, then /v1/vulns/{id} for the details, only on api.osv.dev;
// (4) a time-out, a network error, a bad status and a broken answer give plain messages, never a throw; (5) severity
// from the advisory or a CVSS v3 vector, the fixed version for the locked one, aliases merged; (6) the cache is written
// and read in the data folder; (7) the summary counts per severity, puts prod before dev, and an owner-accepted
// advisory is left out until its review date passes.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OSV = require('../osv.js');

const temporary: string[] = [];
afterAll(() => {
  for (const d of temporary) fs.rmSync(d, { recursive: true, force: true });
});

const NPM_LOCK = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    '': { name: 'secret-app', version: '1.0.0' },
    'node_modules/lodash': { version: '4.17.20', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz' },
    'node_modules/vitest': { version: '2.0.0', resolved: 'https://registry.npmjs.org/vitest/-/vitest-2.0.0.tgz', dev: true },
    'node_modules/@acme/ui': { version: '1.2.0', resolved: 'https://registry.npmjs.org/@acme/ui/-/ui-1.2.0.tgz' },
    'node_modules/internal-tool': { version: '1.0.0', resolved: 'https://npm.corp.example/internal-tool-1.0.0.tgz' },
    'node_modules/shared': { resolved: 'packages/shared', link: true },
    'node_modules/fromgit': { version: '1.0.0', resolved: 'git+ssh://git@github.com/x/fromgit.git#abc' },
  },
});
const CARGO = ['[[package]]', 'name = "my-crate"', 'version = "0.1.0"', '[[package]]', 'name = "serde"', 'version = "1.0.190"', 'source = "registry+https://github.com/rust-lang/crates.io-index"'].join('\n');

/** A fake fetch that records each call and answers from a table by URL. */
function fakeFetch(answers: Record<string, any>) {
  const calls: { url: string; init: any }[] = [];
  const fn = async (url: string, init: any) => {
    calls.push({ url, init });
    const a = typeof answers[url] === 'function' ? answers[url](init) : answers[url];
    if (a instanceof Error) throw a;
    if (!a) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: (a.status ?? 200) === 200, status: a.status ?? 200, json: async () => (a.broken ? JSON.parse('{') : a.body) };
  };
  return { fn, calls };
}

const LODASH_VULN = {
  id: 'GHSA-35jh-r3h4-6jhm',
  summary: 'Command injection in lodash',
  aliases: ['CVE-2021-23337'],
  database_specific: { severity: 'HIGH' },
  affected: [{ package: { ecosystem: 'npm', name: 'lodash' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '4.17.21' }] }] }],
};

describe('the deps settings', () => {
  it('defaults: audit manual, no private scopes, auditStop off; a broken value reads as its default', () => {
    expect(OSV.setupOf({})).toEqual({ audit: 'manual', privateScopes: [], auditStop: false });
    expect(OSV.setupOf({ deps: { audit: 'off', privateScopes: ['@acme', 3], auditStop: true } })).toEqual({ audit: 'off', privateScopes: ['@acme'], auditStop: true });
    expect(OSV.setupOf({ deps: { audit: 'receive', privateScopes: 'x' } })).toEqual({ audit: 'manual', privateScopes: [], auditStop: false });
  });

  it('setupProblems names an unknown key and a wrong value', () => {
    expect(OSV.setupProblems(undefined)).toEqual([]);
    expect(OSV.setupProblems({ audit: 'manual', privateScopes: [], auditStop: false })).toEqual([]);
    expect(OSV.setupProblems({ audit: 'daily', privateScopes: 'x', auditStop: 1, other: 1 })).toEqual([
      'deps.audit must be manual or off',
      'deps.privateScopes must be a list of names or prefixes, e.g. ["@acme", "github.com/acme"]',
      'deps.auditStop must be true or false',
      'deps.other is not a deps setting (audit, privateScopes, auditStop)',
    ]);
  });
});

describe('plan: what would be sent', () => {
  it('only public packages, minus deps.privateScopes; the project itself never', () => {
    const p = OSV.plan({ lockfiles: [{ file: 'package-lock.json', text: NPM_LOCK }, { file: 'Cargo.lock', text: CARGO }], privateScopes: ['@acme'] });
    expect(p.send).toEqual([
      { ecosystem: 'npm', name: 'lodash', version: '4.17.20', dev: false },
      { ecosystem: 'npm', name: 'vitest', version: '2.0.0', dev: true },
      { ecosystem: 'crates.io', name: 'serde', version: '1.0.190', dev: null },
    ]);
    expect(p.held).toEqual({ total: 4, scope: 1, 'other-registry': 1, git: 1, local: 1, unknown: 0 });
    expect(p.ecosystems).toEqual({ npm: 2, 'crates.io': 1 });
    expect(p.host).toBe('api.osv.dev');
    expect(JSON.stringify(p.send)).not.toMatch(/secret-app|my-crate|internal-tool|shared|fromgit|acme/);
  });

  it('privateScopes: an exact name, a prefix with a slash, and a trailing *', () => {
    expect(OSV.isPrivateName('@acme/ui', ['@acme'])).toBe(true);
    expect(OSV.isPrivateName('@acmex/ui', ['@acme'])).toBe(false);
    expect(OSV.isPrivateName('github.com/acme/tool', ['github.com/acme'])).toBe(true);
    expect(OSV.isPrivateName('acme-core', ['acme-*'])).toBe(true);
    expect(OSV.isPrivateName('lodash', ['lodash'])).toBe(true);
    expect(OSV.isPrivateName('lodash', [])).toBe(false);
  });

  it('the request body is exactly ecosystem, name and version, nothing else', () => {
    const p = OSV.plan({ lockfiles: [{ file: 'package-lock.json', text: NPM_LOCK }], privateScopes: ['@acme'] });
    expect(OSV.requestBodies(p.send)).toEqual([
      {
        queries: [
          { package: { ecosystem: 'npm', name: 'lodash' }, version: '4.17.20' },
          { package: { ecosystem: 'npm', name: 'vitest' }, version: '2.0.0' },
        ],
      },
    ]);
  });

  it('more than 1000 packages go in several bodies', () => {
    const send = Array.from({ length: 1001 }, (_, i) => ({ ecosystem: 'npm', name: `p${i}`, version: '1.0.0', dev: null }));
    const bodies = OSV.requestBodies(send);
    expect(bodies.map((b: any) => b.queries.length)).toEqual([1000, 1]);
  });

  it('the dry text names the count, the ecosystems, what is held back and the host, and sends nothing', () => {
    const p = OSV.plan({ lockfiles: [{ file: 'package-lock.json', text: NPM_LOCK }], privateScopes: ['@acme'] });
    const text = OSV.dryText(p).join('\n');
    expect(text).toMatch(/2 packages/);
    expect(text).toMatch(/npm 2/);
    expect(text).toMatch(/api\.osv\.dev/);
    expect(text).toMatch(/3 held back \(1 by deps\.privateScopes, 1 other-registry, 1 git\)/);
    expect(text).toMatch(/"name":"lodash"/);
  });
});

describe('audit: the calls and the answers', () => {
  const send = [
    { ecosystem: 'npm', name: 'lodash', version: '4.17.20', dev: false },
    { ecosystem: 'npm', name: 'vitest', version: '2.0.0', dev: true },
  ];

  it('querybatch, then the details of each advisory, only on api.osv.dev, with no credentials', async () => {
    const f = fakeFetch({
      'https://api.osv.dev/v1/querybatch': { body: { results: [{ vulns: [{ id: 'GHSA-35jh-r3h4-6jhm' }] }, {}] } },
      'https://api.osv.dev/v1/vulns/GHSA-35jh-r3h4-6jhm': { body: LODASH_VULN },
    });
    const r = await OSV.audit({ send, fetch: f.fn, now: Date.parse('2026-11-21T10:00:00Z') });
    expect(f.calls.map((c) => c.url)).toEqual(['https://api.osv.dev/v1/querybatch', 'https://api.osv.dev/v1/vulns/GHSA-35jh-r3h4-6jhm']);
    expect(f.calls[0].init.method).toBe('POST');
    expect(JSON.parse(f.calls[0].init.body)).toEqual({
      queries: [
        { package: { ecosystem: 'npm', name: 'lodash' }, version: '4.17.20' },
        { package: { ecosystem: 'npm', name: 'vitest' }, version: '2.0.0' },
      ],
    });
    for (const c of f.calls) {
      expect(Object.keys(c.init.headers ?? {}).map((k) => k.toLowerCase()).sort()).toEqual(c.init.method === 'POST' ? ['accept', 'content-type', 'user-agent'] : ['accept', 'user-agent']);
      expect(c.init.headers['user-agent']).toBe('ravenseat');
      expect(c.init.signal).toBeDefined();
    }
    expect(r.errors).toEqual([]);
    expect(r.findings).toEqual([
      {
        id: 'GHSA-35jh-r3h4-6jhm',
        aliases: ['CVE-2021-23337'],
        summary: 'Command injection in lodash',
        severity: 'high',
        ecosystem: 'npm',
        name: 'lodash',
        version: '4.17.20',
        fixed: '4.17.21',
        dev: false,
      },
    ]);
    expect(r.checkedAt).toBe('2026-11-21T10:00:00.000Z');
  });

  it('a time-out, no network, a bad status and a broken answer give plain messages, never a throw', async () => {
    const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    const cases: [any, RegExp][] = [
      [timeout, /did not answer within 10 s/],
      [new TypeError('fetch failed'), /Could not reach api\.osv\.dev/],
      [{ status: 503 }, /api\.osv\.dev answered 503/],
      [{ broken: true }, /could not be read/],
      [{ body: { results: [] } }, /could not be read/],
    ];
    for (const [answer, msg] of cases) {
      const f = fakeFetch({ 'https://api.osv.dev/v1/querybatch': answer });
      const r = await OSV.audit({ send, fetch: f.fn, timeoutMs: 10000 });
      expect(r.findings).toEqual([]);
      expect(r.errors.join(' ')).toMatch(msg);
      expect(r.errors.join(' ')).not.toMatch(/lodash|vitest/);
    }
  });

  it('a detail that fails keeps the finding with severity unknown and says so', async () => {
    const f = fakeFetch({ 'https://api.osv.dev/v1/querybatch': { body: { results: [{ vulns: [{ id: 'GHSA-aaaa-bbbb-cccc' }] }, {}] } } });
    const r = await OSV.audit({ send, fetch: f.fn });
    expect(r.findings[0]).toMatchObject({ id: 'GHSA-aaaa-bbbb-cccc', severity: 'unknown', fixed: null, name: 'lodash' });
    expect(r.errors.join(' ')).toMatch(/1 advisory could not be fetched/);
  });

  it('nothing to send: no call at all', async () => {
    const f = fakeFetch({});
    const r = await OSV.audit({ send: [], fetch: f.fn });
    expect(f.calls).toEqual([]);
    expect(r.findings).toEqual([]);
  });

  it('aliases of the same hole for one package are one finding (the one with a severity wins)', async () => {
    const f = fakeFetch({
      'https://api.osv.dev/v1/querybatch': { body: { results: [{ vulns: [{ id: 'PYSEC-2021-1' }, { id: 'GHSA-35jh-r3h4-6jhm' }] }, {}] } },
      'https://api.osv.dev/v1/vulns/PYSEC-2021-1': { body: { id: 'PYSEC-2021-1', aliases: ['GHSA-35jh-r3h4-6jhm'], affected: [] } },
      'https://api.osv.dev/v1/vulns/GHSA-35jh-r3h4-6jhm': { body: LODASH_VULN },
    });
    const r = await OSV.audit({ send, fetch: f.fn });
    expect(r.findings.map((x: any) => x.id)).toEqual(['GHSA-35jh-r3h4-6jhm']);
    expect(r.findings[0].aliases).toEqual(expect.arrayContaining(['CVE-2021-23337', 'PYSEC-2021-1']));
  });
});

describe('severity and the fixed version', () => {
  it('the advisory word, then a CVSS v3 vector, else unknown', () => {
    expect(OSV.severityOf({ database_specific: { severity: 'MODERATE' } })).toBe('moderate');
    expect(OSV.severityOf({ database_specific: { severity: 'CRITICAL' } })).toBe('critical');
    expect(OSV.severityOf({ severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H' }] })).toBe('critical');
    expect(OSV.severityOf({ severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:N/A:N' }] })).toBe('moderate');
    expect(OSV.severityOf({ severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N' }] })).toBe('high');
    expect(OSV.severityOf({ severity: [{ type: 'CVSS_V3', score: 'CVSS:3.1/AV:L/AC:H/PR:H/UI:R/S:U/C:L/I:N/A:N' }] })).toBe('low');
    expect(OSV.severityOf({})).toBe('unknown');
  });

  it('cvss3Score matches the published examples', () => {
    expect(OSV.cvss3Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H')).toBe(9.8);
    expect(OSV.cvss3Score('CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H')).toBe(10);
    expect(OSV.cvss3Score('CVSS:3.0/AV:N/AC:L/PR:L/UI:N/S:C/C:L/I:L/A:N')).toBe(6.4);
    expect(OSV.cvss3Score('not a vector')).toBeNull();
  });

  it('the lowest fixed version above the locked one, for that package', () => {
    const v = {
      affected: [
        { package: { ecosystem: 'npm', name: 'other' }, ranges: [{ events: [{ fixed: '9.9.9' }] }] },
        { package: { ecosystem: 'npm', name: 'x' }, ranges: [{ events: [{ introduced: '0' }, { fixed: '1.2.0' }, { introduced: '2.0.0' }, { fixed: '2.1.1' }] }] },
      ],
    };
    expect(OSV.fixedFor(v, { ecosystem: 'npm', name: 'x', version: '2.0.5' })).toBe('2.1.1');
    expect(OSV.fixedFor(v, { ecosystem: 'npm', name: 'x', version: '1.0.0' })).toBe('1.2.0');
    expect(OSV.fixedFor(v, { ecosystem: 'npm', name: 'y', version: '1.0.0' })).toBeNull();
  });
});

describe('cache and summary', () => {
  const finding = (id: string, severity: string, name: string, dev: boolean | null, fixed: string | null = '9.0.0') => ({
    id, aliases: [], summary: 's', severity, ecosystem: 'npm', name, version: '1.0.0', fixed, dev,
  });
  const cache = {
    version: 1,
    checkedAt: '2026-11-09T10:00:00.000Z',
    host: 'api.osv.dev',
    sent: 10,
    held: { total: 2 },
    findings: [
      finding('GHSA-low1', 'low', 'a', false),
      finding('GHSA-hi-dev', 'high', 'vitest', true),
      finding('GHSA-hi-prod', 'high', 'lodash', false),
      finding('GHSA-crit', 'critical', 'zod', false),
      finding('GHSA-mod', 'moderate', 'b', null),
    ],
    errors: [],
  };

  it('writes and reads <dataFolder>/deps-audit.json; missing or broken reads as null', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'osv-cache-'));
    temporary.push(dir);
    expect(OSV.readCache(dir)).toBeNull();
    OSV.writeCache(dir, cache);
    expect(OSV.readCache(dir)).toEqual(cache);
    expect(fs.existsSync(path.join(dir, 'deps-audit.json'))).toBe(true);
    fs.writeFileSync(path.join(dir, 'deps-audit.json'), '{');
    expect(OSV.readCache(dir)).toBeNull();
  });

  it('counts per severity, the three worst with prod before dev, the age in days', () => {
    const s = OSV.summarize(cache, { now: Date.parse('2026-11-21T10:00:00Z') });
    expect(s.counts).toEqual({ critical: 1, high: 2, moderate: 1, low: 1, unknown: 0 });
    expect(s.open).toBe(5);
    expect(s.highProd).toBe(2);
    expect(s.ageDays).toBe(12);
    expect(s.worst.map((x: any) => x.id)).toEqual(['GHSA-crit', 'GHSA-hi-prod', 'GHSA-hi-dev']);
  });

  it('an accepted advisory (by id or alias) is left out until its review date passes, then it counts again', () => {
    const c = { ...cache, findings: [...cache.findings, { ...finding('PYSEC-1', 'high', 'p', false), aliases: ['GHSA-acc'] }] };
    const accepted = [{ id: 'D-0003', accepts: ['GHSA-crit', 'GHSA-acc'], reviewBy: '2027-02-01' }];
    const s = OSV.summarize(c, { accepted, now: Date.parse('2026-11-21T10:00:00Z') });
    expect(s.accepted).toBe(2);
    expect(s.counts.critical).toBe(0);
    expect(s.worst.map((x: any) => x.id)).not.toContain('GHSA-crit');
    expect(s.lapsed).toEqual([]);
    const later = OSV.summarize(c, { accepted, now: Date.parse('2027-02-02T10:00:00Z') });
    expect(later.counts.critical).toBe(1);
    expect(later.accepted).toBe(0);
    expect(later.lapsed).toEqual([{ id: 'D-0003', reviewBy: '2027-02-01' }]);
  });

  it('the doctor line: age, counts, from the cache only', () => {
    const s = OSV.summarize(cache, { now: Date.parse('2026-11-21T10:00:00Z') });
    expect(OSV.doctorLine(s)).toBe('last audit 12 days ago: 1 critical, 2 high, 1 moderate, 1 low (from the cache, no network)');
    expect(OSV.doctorLine(OSV.summarize({ ...cache, findings: [] }, { now: Date.parse('2026-11-09T12:00:00Z') }))).toBe(
      'last audit today: no known holes (from the cache, no network)',
    );
  });

  it('the fix task: one proposed update task with the packages and the fixed versions', () => {
    const s = OSV.summarize(cache, { now: Date.parse('2026-11-21T10:00:00Z') });
    const t = OSV.fixTask(s, { id: 'KS-PLAN-DEP-AUDIT-FOUND' });
    expect(t.id).toBe('KS-PLAN-DEP-AUDIT-FOUND');
    expect(t.title).toBe('Update libraries with known holes');
    expect(t.mission).toMatch(/zod 1\.0\.0 to 9\.0\.0 or later \(GHSA-crit, critical\)/);
    expect(t.mission).toMatch(/Run the gates/);
    expect(t.mission.indexOf('zod')).toBeLessThan(t.mission.indexOf('vitest'));
  });
});
