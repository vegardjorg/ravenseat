// =============================================================
// depsAuditFlow.test.ts: `ravenseat catalog deps --audit` through the real CLI, in a temporary project (roadmap 0å KD-4,
// cli/depsAudit.mjs, lib/osv.js).
//
// Locks: (1) --dry prints the count, the ecosystems, what is held back and the host, and calls no network; (2) the first
// real run needs --yes and sends nothing without it; (3) with --yes it sends exactly ecosystem, name and version of the
// public packages (a private scope, git and a local path never leave), writes <dataFolder>/deps-audit.json, and a later
// run needs no --yes; (4) the project's own audit tool in CI: the command names it and sends nothing, --anyway asks all
// the same; (5) deps.audit off refuses; (6) a track worktree is refused; (7) the Checks tab shows one card from the cache
// and its plan proposes one update task (also with --approved, as the board sends it); (8) doctor --all has the last
// audit from the cache, doctor without --all does not, and a risk acceptance whose review date passed shows always.
// The network is never used: every run preloads a fake fetch (node --import) that records each call in a file.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const QUEUE = path.resolve(__dirname, '..', 'queue.mjs');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];

const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) {
    try {
      fs.rmSync(m, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch {
      /* left for the OS */
    }
  }
});

const LOCK = JSON.stringify({
  name: 'app',
  lockfileVersion: 3,
  packages: {
    '': { name: 'app' },
    'node_modules/zod': { version: '1.0.0', resolved: 'https://registry.npmjs.org/zod/-/zod-1.0.0.tgz' },
    'node_modules/vitest': { version: '2.0.0', resolved: 'https://registry.npmjs.org/vitest/-/vitest-2.0.0.tgz', dev: true },
    'node_modules/@acme/ui': { version: '3.0.0', resolved: 'https://registry.npmjs.org/@acme/ui/-/ui-3.0.0.tgz' },
    'node_modules/forked': { version: '1.0.0', resolved: 'git+ssh://git@example.invalid/forked.git#abc' },
    'node_modules/local-lib': { version: '0.1.0', resolved: 'file:../local-lib' },
  },
});

/** The fake fetch: answers OSV.dev's two endpoints from a fixture and appends every call to calls.jsonl. */
const FAKE = `
import fs from 'node:fs';
const log = process.env.FAKE_FETCH_LOG;
globalThis.fetch = async (url, init = {}) => {
  fs.appendFileSync(log, JSON.stringify({ url: String(url), method: init.method ?? 'GET', body: init.body ?? null }) + '\\n');
  const json = (o) => ({ ok: true, status: 200, json: async () => o, text: async () => JSON.stringify(o) });
  if (String(url).endsWith('/v1/querybatch')) {
    const q = JSON.parse(init.body).queries;
    return json({ results: q.map((x) => (x.package.name === 'zod' ? { vulns: [{ id: 'GHSA-zod1' }] } : {})) });
  }
  if (String(url).endsWith('/v1/vulns/GHSA-zod1'))
    return json({
      id: 'GHSA-zod1',
      summary: 'Parser loops forever',
      database_specific: { severity: 'HIGH' },
      affected: [{ package: { ecosystem: 'npm', name: 'zod' }, ranges: [{ type: 'SEMVER', events: [{ introduced: '0' }, { fixed: '3.22.3' }] }] }],
    });
  return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
};
`;

function project(config: Record<string, unknown> = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-deps-audit-flow-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  const worktree = path.join(folder, 'wt-A');
  fs.mkdirSync(repo);
  const globalConfig = path.join(folder, 'global-gitconfig');
  fs.writeFileSync(globalConfig, '');
  const configFile = path.join(folder, 'queue.config.json');
  const setConfig = (c: Record<string, unknown>) =>
    fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'main', mode: 'lite', deps: { privateScopes: ['@acme'] }, ...c }));
  setConfig(config);
  const fake = path.join(folder, 'fake-fetch.mjs');
  fs.writeFileSync(fake, FAKE);
  const calls = path.join(folder, 'calls.jsonl');
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: folder,
    QUEUE_FOLDER: folder,
    QUEUE_CONFIG: configFile,
    QUEUE_ROOT: repo,
    QUEUE_GIT: repo,
    QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
    QUEUE_TRANSCRIPTS: path.join(folder, 'transcripts'),
    RAVENSEAT_CLAUDE_DIR: path.join(folder, 'claude'),
    RAVENSEAT_MANAGED_CLAUDE_MD: '',
    RAVENSEAT_INSTRUCTIONS_TOP: repo,
    FAKE_FETCH_LOG: calls,
  } as NodeJS.ProcessEnv;
  delete env.QUEUE_SCRATCHPAD;
  delete env.QUEUE_SESSION;
  const write = (f: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    fs.writeFileSync(path.join(repo, f), text);
  };
  const g = (args: string[], cwd = repo) => execFileSync('git', ['-C', cwd, ...ID, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  write('package.json', JSON.stringify({ scripts: { test: 'vitest run' }, dependencies: { zod: '1.0.0' } }));
  write('package-lock.json', LOCK);
  g(['init', '-q', '-b', 'main']);
  g(['add', '--', 'package.json', 'package-lock.json']);
  g(['commit', '-q', '-m', 'start']);
  g(['branch', 'queue/A']);
  g(['worktree', 'add', '-q', worktree, 'queue/A']);
  fs.writeFileSync(path.join(folder, 'queue.json'), JSON.stringify({ limits: {}, resolved: [], projects: { p: { title: 'P' } }, tasks: [] }));
  const run = (args: string[], cwd = repo) => {
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(fake).href, QUEUE, ...args], { encoding: 'utf8', env, cwd });
    return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '', all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const sent = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const cache = path.join(folder, 'deps-audit.json');
  const queue = () => JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8'));
  return { folder, repo, worktree, run, write, sent, cache, queue, setConfig };
}

describe('ravenseat catalog deps --audit', () => {
  it('--dry says what would be sent and to which host, and calls no network', () => {
    const p = project();
    const r = p.run(['catalog', 'deps', '--audit', '--dry']);
    expect(r.code, r.all).toBe(0);
    expect(r.out).toMatch(/api\.osv\.dev/);
    expect(r.out).toMatch(/\b2\b.*npm/);
    expect(r.out).toMatch(/3 held back/);
    expect(p.sent()).toEqual([]);
    expect(fs.existsSync(p.cache)).toBe(false);
    const j = JSON.parse(p.run(['catalog', 'deps', '--audit', '--dry', '--json']).out);
    expect(j.bodies).toEqual([{ queries: [{ package: { ecosystem: 'npm', name: 'zod' }, version: '1.0.0' }, { package: { ecosystem: 'npm', name: 'vitest' }, version: '2.0.0' }] }]);
    expect(p.sent()).toEqual([]);
  });

  it('the first real run needs --yes; with it only ecosystem, name and version of public packages leave', () => {
    const p = project();
    const no = p.run(['catalog', 'deps', '--audit']);
    expect(no.code).not.toBe(0);
    expect(no.all).toMatch(/--yes/);
    expect(no.all).toMatch(/Nothing was sent/);
    expect(p.sent()).toEqual([]);
    const r = p.run(['catalog', 'deps', '--audit', '--yes']);
    expect(r.code, r.all).toBe(0);
    expect(r.out).toMatch(/1 high/);
    expect(r.out).toMatch(/zod 1\.0\.0 to 3\.22\.3 or later/);
    const calls = p.sent();
    expect(calls[0].url).toBe('https://api.osv.dev/v1/querybatch');
    expect(JSON.parse(calls[0].body)).toEqual({ queries: [{ package: { ecosystem: 'npm', name: 'zod' }, version: '1.0.0' }, { package: { ecosystem: 'npm', name: 'vitest' }, version: '2.0.0' }] });
    expect(calls.map((c) => c.body ?? '').join('')).not.toMatch(/acme|forked|local-lib/);
    expect(calls[1]).toMatchObject({ url: 'https://api.osv.dev/v1/vulns/GHSA-zod1', method: 'GET', body: null });
    const cache = JSON.parse(fs.readFileSync(p.cache, 'utf8'));
    expect(cache).toMatchObject({ confirmed: true, sent: 2, host: 'api.osv.dev' });
    expect(cache.findings[0]).toMatchObject({ id: 'GHSA-zod1', name: 'zod', severity: 'high', fixed: '3.22.3' });
    // Confirmed once: the next run needs no --yes.
    expect(p.run(['catalog', 'deps', '--audit']).code).toBe(0);
  });

  it('an audit tool in CI is named and nothing is sent; --anyway asks all the same', () => {
    const p = project();
    p.write('.github/workflows/ci.yml', 'jobs:\n  audit:\n    steps:\n      - run: npm audit --audit-level=high\n');
    const r = p.run(['catalog', 'deps', '--audit', '--yes']);
    expect(r.code, r.all).toBe(0);
    expect(r.out).toMatch(/already runs an audit tool/);
    expect(r.out).toMatch(/npm audit/);
    expect(p.sent()).toEqual([]);
    expect(p.run(['catalog', 'deps', '--audit', '--yes', '--anyway']).code).toBe(0);
    expect(p.sent().length).toBeGreaterThan(0);
  });

  it('deps.audit off refuses, and a track worktree is refused', () => {
    const p = project({ deps: { audit: 'off' } });
    const off = p.run(['catalog', 'deps', '--audit', '--dry']);
    expect(off.code).not.toBe(0);
    expect(off.all).toMatch(/deps\.audit off/);
    p.setConfig({});
    const track = p.run(['catalog', 'deps', '--audit', '--yes'], p.worktree);
    expect(track.code).not.toBe(0);
    expect(p.sent()).toEqual([]);
  });

  it('the Checks tab shows one card from the cache, and its plan proposes one update task', () => {
    const p = project();
    expect(p.run(['catalog', 'deps', '--audit', '--yes']).code).toBe(0);
    const before = p.sent().length;
    const report = JSON.parse(p.run(['checks', '--json']).out);
    const cards = report.suggestions.filter((s: { key: string }) => s.key === 'dep-audit-found');
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ category: 'dependencies', action: 'dep-fix', priority: 'medium' });
    expect(cards[0].depAudit.worst[0]).toMatchObject({ name: 'zod', severity: 'high' });
    // The board sends --approved; the update task is a proposal all the same.
    const r = p.run(['checks', 'plan', 'dep-audit-found', '--approved']);
    expect(r.code, r.all).toBe(0);
    const task = p.queue().tasks.find((x: { id: string }) => x.id === 'KS-PLAN-DEP-AUDIT-FOUND');
    expect(task).toMatchObject({ title: 'Update libraries with known holes', class: 'D' });
    expect(task.status).toBe('proposed');
    expect(task.mission).toMatch(/Update zod 1\.0\.0 to 3\.22\.3 or later/);
    expect(p.run(['checks', 'plan', 'dep-audit-found']).out).toMatch(/already there/);
    // Reading the card and planning the task never call the network.
    expect(p.sent().length).toBe(before);
  });

  it('doctor --all has the last audit from the cache; a lapsed risk acceptance shows always', () => {
    const p = project();
    const rows = (all: boolean) => JSON.parse(p.run(['doctor', '--json', ...(all ? ['--all'] : [])]).out).checks.filter((c: { name: string }) => c.name === 'deps-audit');
    expect(rows(true)).toEqual([]);
    expect(p.run(['catalog', 'deps', '--audit', '--yes']).code).toBe(0);
    const before = p.sent().length;
    const all = rows(true);
    expect(all).toHaveLength(1);
    expect(all[0].message).toMatch(/last audit today: 1 high/);
    expect(all[0].message).toMatch(/no network/);
    expect(rows(false)).toEqual([]);
    expect(p.sent().length).toBe(before);
  });

  it('an accepted risk hides its hole until review_by; after that it counts again and doctor names it', () => {
    const p = project();
    expect(p.run(['catalog', 'deps', '--audit', '--yes']).code).toBe(0);
    const entry = (reviewBy: string) =>
      [
        '---',
        'id: D-0001',
        'title: zod parser hole does not apply',
        'status: proposed',
        'kind: dependency',
        'invariant: We never parse input from users with zod.',
        'accepts: ["GHSA-zod1"]',
        `review_by: ${reviewBy}`,
        '---',
        'Checked by the owner.',
        '',
      ].join('\n');
    const card = () => JSON.parse(p.run(['checks', '--json']).out).suggestions.find((s: { key: string }) => s.key === 'dep-audit-found');
    p.write('docs/queue/catalog/decisions/D-0001-zod.md', entry('2999-01-01'));
    // Proposed is not accepted: the hole still counts.
    expect(card()).toBeTruthy();
    const ok = p.run(['catalog', 'accept', 'D-0001', '--by', 'owner']);
    expect(ok.code, ok.all).toBe(0);
    expect(card()).toBeUndefined();
    // A review date in the past: the acceptance stops hiding the hole, and doctor says so without --all.
    p.write('docs/queue/catalog/decisions/D-0001-zod.md', entry('2020-01-01').replace('status: proposed', 'status: accepted'));
    expect(p.run(['catalog', 'accept', 'D-0001', '--by', 'owner']).code).toBe(0);
    const again = card();
    expect(again?.depAudit.lapsed).toEqual([{ id: 'D-0001', reviewBy: '2020-01-01' }]);
    const doctor = JSON.parse(p.run(['doctor', '--json']).out).checks.filter((c: { name: string }) => c.name === 'deps-audit');
    expect(doctor.map((c: { message: string }) => c.message).join(' ')).toMatch(/D-0001 accepted its holes until 2020-01-01/);
  });
});
