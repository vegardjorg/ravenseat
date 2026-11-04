// =============================================================
// doctorBaseline.test.ts: the safety baseline lines of `cq doctor` (cli/doctorBaseline.mjs) and the config rules for
// the new keys (productionBranch, deployCommands, secretScan, largeFileMb in cli/doctor.mjs).
//
// Why: users have very different stacks; the checks must work with plain git and file names, name each risk in one
// line with one fix, FAIL only on a secret file in git, and never change anything. Temporary git repos only; the fake
// key header is built at run time.
// =============================================================
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PLUGIN = path.resolve(__dirname, '..', '..', '..', '..');
const QUEUE = path.join(PLUGIN, 'scripts', 'orchestrator', 'queue.mjs');
const PEM = ['-----BEGIN ', 'PRIVATE KEY-----'].join('');
const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});

type Check = { status: 'OK' | 'INFO' | 'WARN' | 'FAIL'; name: string; message: string; fix: string | null };

/** A temporary project: a git repo, `files` committed, `loose` written but not committed, and a config. */
function project({ config = {}, files = {}, loose = {} }: { config?: object; files?: Record<string, string | Buffer>; loose?: Record<string, string> } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-baseline-'));
  temporary.push(root);
  const g = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  const write = (all: Record<string, string | Buffer>) => {
    for (const [f, text] of Object.entries(all)) {
      fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
      fs.writeFileSync(path.join(root, f), text);
    }
  };
  write({ 'README.md': 'x\n', ...files });
  g('add', '-f', '.');
  g('commit', '-q', '-m', 'start');
  g('branch', 'staging');
  write(loose);
  const data = path.join(os.tmpdir(), `queue-baseline-data-${path.basename(root)}`);
  temporary.push(data);
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'queue.json'), JSON.stringify({ tasks: [], projects: {} }));
  const configFile = path.join(data, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ loadGuard: { minFreeMemoryPct: null }, ...config }));
  const env = {
    ...process.env,
    QUEUE_ROOT: root,
    QUEUE_FOLDER: data,
    QUEUE_CONFIG: configFile,
    QUEUE_GIT: root,
    QUEUE_HOOKS: path.join(PLUGIN, 'hooks', 'hooks.json'),
    QUEUE_TIME_LOG: path.join(data, 'times.jsonl'),
  };
  const run = () => {
    const r = spawnSync(process.execPath, [QUEUE, 'doctor', '--json'], { encoding: 'utf8', env, cwd: root });
    return { code: r.status, checks: (JSON.parse(r.stdout).checks as Check[]) };
  };
  const text = () => spawnSync(process.execPath, [QUEUE, 'doctor'], { encoding: 'utf8', env, cwd: root }).stdout;
  const lines = (name: string) => run().checks.filter((c) => c.name === name);
  return { root, g, run, text, lines };
}

describe('cq doctor: the safety baseline', () => {
  it('a missing base branch and a gate naming a missing script are FAIL', () => {
    const p = project({ config: { gates: { quick: ['npm run nope'], full: [] }, baseBranch: 'develop' }, files: { 'package.json': '{}' } });
    const r = p.run();
    expect(r.code).toBe(1);
    const hit = (n: string) => r.checks.find((c) => c.name === n);
    expect(hit('base')?.status).toBe('FAIL');
    expect(hit('gates')?.status).toBe('FAIL');
    expect(hit('gates')?.message).toContain('npm run nope');
  });

  it('a clean project: OK lines, no FAIL, and nothing is written', () => {
    const p = project({
      config: { gates: { quick: ['npm test'], full: [] }, baseBranch: 'staging', productionBranch: 'main' },
      files: { '.gitignore': '.env\n', '.env.example': 'API_KEY=\n', 'package.json': JSON.stringify({ scripts: { test: 'x' } }), 'package-lock.json': '{}', '.gitlab-ci.yml': 'test:\n  script: npm test\n' },
      loose: { '.env': 'API_KEY=real\n' },
    });
    const before = fs.readdirSync(p.root).sort();
    const r = p.run();
    expect(r.code).toBe(0);
    const by = (n: string) => r.checks.filter((c) => c.name === n).map((c) => c.status);
    expect(by('secrets')).toEqual(['OK']);
    expect(by('gates')).toEqual(['OK']);
    expect(by('ci')).toEqual(['OK']);
    expect(r.checks.find((c) => c.name === 'ci')?.message).toMatch(/GitLab CI/);
    expect(by('lockfile')).toEqual(['OK']);
    expect(by('prod')).toEqual(['OK']);
    expect(by('largefile')).toEqual(['OK']);
    expect(fs.readdirSync(p.root).sort()).toEqual(before);
  }, 60_000);

  it('secrets: a tracked .env and private key FAIL (exit 1), a test-folder key WARNs, an unignored one WARNs', () => {
    const p = project({
      files: {
        '.env.production': 'DB_URL=x\n',
        'deploy/server.pem': `${PEM}\nabc\n`,
        'certs/public.pem': '-----BEGIN CERTIFICATE-----\nabc\n',
        'tests/fixtures/dummy.pem': `${PEM}\nabc\n`,
        'config/service-account.json': '{}',
        '.env.sample': 'X=\n',
      },
      loose: { '.env.local': 'X=1\n', 'id_ed25519': 'k' },
    });
    const r = p.run();
    expect(r.code).toBe(1);
    const s = r.checks.filter((c) => c.name === 'secrets');
    expect(s.map((c) => c.status)).toEqual(['FAIL', 'WARN', 'WARN']);
    expect(s[0].message).toMatch(/^secret file\(s\) in git: \.env\.production, config\/service-account\.json, deploy\/server\.pem\./);
    expect(s[0].message).not.toMatch(/public\.pem|\.env\.sample|dummy/);
    expect(s[0].fix).toMatch(/git rm --cached .*change the keys/);
    expect(s[1].message).toMatch(/tests\/fixtures\/dummy\.pem/);
    expect(s[2].message).toMatch(/not in \.gitignore: \.env\.local, id_ed25519/);
    for (const c of s) expect(c.fix).toEqual(expect.any(String));
  }, 60_000);

  it('gates, ci, prod and lockfile: WARN/INFO with a one-line fix each', () => {
    const p = project({
      config: { baseBranch: 'main', productionBranch: 'main' },
      files: { 'package.json': '{}', 'Cargo.toml': '[package]\n', '.gitignore': 'yarn.lock\n' },
      loose: { 'yarn.lock': '' },
    });
    const r = p.run();
    expect(r.code).toBe(0);
    const one = (n: string) => r.checks.filter((c) => c.name === n);
    expect(one('gates')[0]).toMatchObject({ status: 'WARN', message: expect.stringMatching(/your agents run no checks/) });
    expect(one('ci')[0]).toMatchObject({ status: 'INFO', message: expect.stringMatching(/^no CI config found/) });
    expect(one('prod')[0]).toMatchObject({ status: 'WARN', message: expect.stringMatching(/same as baseBranch \(main\): every batch push goes straight to production/) });
    const lock = one('lockfile');
    expect(lock.map((c) => c.status)).toEqual(['WARN', 'INFO']);
    expect(lock[0].message).toMatch(/^yarn\.lock exists but is not in git/);
    expect(lock[1].message).toMatch(/^Cargo\.toml has no lockfile in git/);
    for (const c of [...one('gates'), ...one('ci'), ...one('prod'), ...lock]) expect(c.fix).toMatch(/^\S.*[^.]$/);
    // The text form: one line per check, the hint on the next.
    expect(p.text()).toMatch(/^WARN {2}gates {6}gates\.quick and gates\.full are empty.*\n {17}fix: /m);
  }, 60_000);

  it('largefile: WARN over largeFileMb (configurable), and no prod line when productionBranch is not set', () => {
    const big = Buffer.alloc(2 * 1024 * 1024, 7);
    let p = project({ config: { largeFileMb: 1 }, files: { 'data/dump.bin': big } });
    const l = p.lines('largefile');
    expect(l[0]).toMatchObject({ status: 'WARN', message: expect.stringMatching(/^1 tracked file\(s\) over 1 MB: data\/dump\.bin \(2\.0 MB\)/) });
    expect(p.lines('prod')).toEqual([]);
    p = project({ files: { 'data/dump.bin': big } });
    expect(p.lines('largefile')[0].status).toBe('OK');
  }, 60_000);

  it('branches: a merged agent branch is named, one with a worktree or unmerged work is not', () => {
    const p = project({ config: { baseBranch: 'main' } });
    p.g('branch', 'worktree-agent-old');
    p.g('branch', 'worktree-agent-live');
    p.g('worktree', 'add', '-q', path.join(p.root, '.claude', 'worktrees', 'live'), 'worktree-agent-live');
    p.g('switch', '-q', '-c', 'worktree-agent-open');
    p.g('commit', '-q', '--allow-empty', '-m', 'not merged');
    p.g('switch', '-q', 'main');
    const b = p.lines('branches');
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ status: 'WARN', message: '1 merged agent branch(es) with no worktree left: worktree-agent-old' });
    expect(b[0].fix).toContain('git branch -d worktree-agent-old');
  }, 60_000);

  it('config: the new keys are known, and bad values FAIL', () => {
    let p = project({ config: { productionBranch: 'main', deployCommands: ['fly deploy'], secretScan: { enabled: true, maxBytes: 1000, timeoutMs: 500 }, largeFileMb: 2 } });
    expect(p.lines('config')).toEqual([expect.objectContaining({ status: 'OK' })]);
    p = project({ config: { productionBranch: 'my branch', deployCommands: ['', 3], secretScan: { maxBytes: -1, timeoutMs: 1.5, enable: true }, largeFileMb: 0 } });
    const c = p.lines('config');
    expect(c[0].status).toBe('FAIL');
    expect(c[0].message).toMatch(/productionBranch must be a branch name or null/);
    expect(c[0].message).toMatch(/deployCommands must hold non-empty strings/);
    expect(c[0].message).toMatch(/secretScan\.maxBytes must be a whole number > 0; secretScan\.timeoutMs must be a whole number > 0/);
    expect(c[0].message).toMatch(/largeFileMb must be a number > 0/);
    expect(c[1]).toMatchObject({ status: 'WARN', message: 'unknown key(s) ignored: secretScan.enable' });
    p = project({ config: { productionBranch: 5 } });
    expect(p.lines('config')[0].message).toMatch(/productionBranch must be a branch name or null/);
    // focus.continueWhenEmpty (continue the regular queue when the focus has ended): known, boolean, closed object.
    p = project({ config: { focus: { continueWhenEmpty: true } } });
    expect(p.lines('config')).toEqual([expect.objectContaining({ status: 'OK' })]);
    p = project({ config: { focus: { continueWhenEmpty: 'yes', continueWhenEmty: true } } });
    const fc = p.lines('config');
    expect(fc[0]).toMatchObject({ status: 'FAIL' });
    expect(fc[0].message).toMatch(/focus\.continueWhenEmpty is string, expected boolean/);
    expect(fc[1]).toMatchObject({ status: 'WARN', message: 'unknown key(s) ignored: focus.continueWhenEmty' });
  }, 60_000);
});
