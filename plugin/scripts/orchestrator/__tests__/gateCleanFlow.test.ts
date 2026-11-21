// =============================================================
// gateCleanFlow.test.ts: the full gate in a clean copy of the exact commit (gates.runner clean, lib/gateClean.js), with
// the real gates.mjs, real git and a real junction (Windows) or symlink for node_modules.
//
// Locks: `--clean` runs the gate commands in a fresh copy under <dataFolder>/clean-gate that has the commit and .git but
// no ignored or untracked file of the worktree, with node_modules linked to the same folder; the copy is gone afterwards
// and the link's target survives; the evidence line says "ran in a clean copy of <sha>, dependencies linked"; the setting
// picks only the kinds listed (a track's own run never); the worktree mode prints the one hint when it saw ignored files;
// gates.clean.include copies a listed ignored file in; keepOnRed keeps a red copy; a link a test left pointing out of the
// copy keeps the folder (and its target) and never changes the verdict; a setup failure runs no gate command and says
// so in one CLEAN COPY SETUP RED line (also in the log); the sweep at start removes an old copy of a dead process.
// =============================================================
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const GC = require('../lib/gateClean.js');

const HERE = path.resolve(__dirname, '..');
const GATES = path.join(HERE, 'gates.mjs');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
const LINK = process.platform === 'win32' ? 'junction' : 'dir';

const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) {
    try {
      // Links first, as the code does: a recursive delete must never go through one.
      for (const p of [path.join(m, 'repo', 'node_modules'), path.join(m, 'wt', 'node_modules')])
        if (fs.existsSync(p) && fs.lstatSync(p).isSymbolicLink()) fs.unlinkSync(p);
      fs.rmSync(m, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
    } catch {
      /* left for the OS */
    }
  }
});

/** The gate command: writes where it ran and what it can see, then exits as asked. */
const CHECK = `
const fs = require('node:fs'), path = require('node:path');
const info = {
  cwd: process.cwd(),
  git: fs.existsSync('.git'),
  stray: fs.existsSync('stray.txt'),
  included: fs.existsSync('.env.test'),
  dep: fs.existsSync(path.join('node_modules', 'dep', 'index.js')),
};
fs.appendFileSync(process.argv[2], JSON.stringify(info) + '\\n');
if (process.argv[3] === 'outlink') fs.symlinkSync(process.argv[4], 'outlink', process.platform === 'win32' ? 'junction' : 'dir');
process.exit(process.argv[3] === 'red' ? 1 : 0);
`;

function project(gateArgs: string[] = [], gatesExtra: Record<string, unknown> = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-clean-flow-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  const data = path.join(folder, 'data');
  const deps = path.join(folder, 'deps', 'node_modules');
  const seen = path.join(folder, 'seen.jsonl');
  const outside = path.join(folder, 'outside');
  for (const d of [repo, data, path.join(deps, 'dep'), outside]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(deps, 'dep', 'index.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(deps, 'keep.txt'), 'must survive');
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'must survive');
  const g = (args: string[], cwd = repo) => execFileSync('git', ['-C', cwd, ...ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g(['init', '-q', '-b', 'develop']);
  fs.writeFileSync(path.join(repo, 'check.cjs'), CHECK);
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules\nstray.txt\n.env.test\n');
  g(['add', '--', 'check.cjs', '.gitignore']);
  g(['commit', '-q', '-m', 'start']);
  // What the worktree has and the commit does not: an ignored file, an ignored test env file and the shared link.
  fs.writeFileSync(path.join(repo, 'stray.txt'), 'only here');
  fs.writeFileSync(path.join(repo, '.env.test'), 'X=1\n');
  fs.symlinkSync(deps, path.join(repo, 'node_modules'), LINK);
  const command = ['node', 'check.cjs', JSON.stringify(seen), ...gateArgs.map((x) => JSON.stringify(x))].join(' ');
  const configFile = path.join(folder, 'queue.config.json');
  const writeConfig = (extra: Record<string, unknown>) =>
    fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'develop', gates: { quick: [command], full: [command], ...extra }, loadGuard: { minFreeMemoryPct: 10 } }));
  writeConfig(gatesExtra);
  const env: Record<string, string | undefined> = {
    ...process.env,
    QUEUE_FOLDER: data,
    QUEUE_CONFIG: configFile,
    QUEUE_ROOT: repo,
    QUEUE_GIT: repo,
    QUEUE_TIME_LOG: path.join(folder, 'time.jsonl'),
    QUEUE_GATE_QUEUE: 'off',
    QUEUE_LOAD: 'free=50',
  };
  delete env.QUEUE_GATE_QUEUE_DIR;
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [GATES, ...args], { env: env as NodeJS.ProcessEnv, encoding: 'utf8', cwd: repo });
    return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const runs = () =>
    fs.existsSync(seen)
      ? fs.readFileSync(seen, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { cwd: string; git: boolean; stray: boolean; included: boolean; dep: boolean })
      : [];
  const base = path.join(data, GC.FOLDER);
  const copies = () => (fs.existsSync(base) ? fs.readdirSync(base).filter((n) => GC.parseName(n.replace(/\.json$/, ''))) : []);
  const worktrees = () => g(['worktree', 'list', '--porcelain']).split('\n').filter((l) => l.startsWith('worktree ')).length;
  return { folder, repo, data, deps, seen, outside, base, env, run, runs, copies, worktrees, g, writeConfig };
}

/** Is `p` (a folder that may be gone by now) under `root`? Only the root is resolved: the copy is removed after the run. */
const under = (p: string, root: string) => {
  const low = (s: string) => (process.platform === 'win32' ? s.toLowerCase() : s);
  const rel = path.relative(low(fs.realpathSync.native(root)), low(path.resolve(p)));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

describe('gates.mjs --full --clean: a one-off run in a clean copy', () => {
  it('runs in a fresh copy of the commit with .git and linked node_modules, without the worktree\'s ignored files, and removes it', () => {
    const p = project();
    const r = p.run('--full', '--clean', '--cwd', p.repo);
    expect(r.code, r.out).toBe(0);
    const [info] = p.runs();
    expect(under(info.cwd, p.base), info.cwd).toBe(true);
    expect(info).toMatchObject({ git: true, stray: false, included: false, dep: true });
    const sha = p.g(['rev-parse', 'HEAD']);
    expect(r.out).toContain(`ran in a clean copy of ${sha.slice(0, 12)}, dependencies linked`);
    // Gone afterwards: the copy, its meta file and git's record; the link's target and its file survive.
    expect(p.copies()).toEqual([]);
    expect(p.worktrees()).toBe(1);
    expect(fs.readFileSync(path.join(p.deps, 'keep.txt'), 'utf8')).toBe('must survive');
    expect(fs.existsSync(path.join(p.deps, 'dep', 'index.js'))).toBe(true);
    const store = JSON.parse(fs.readFileSync(path.join(p.data, 'gate-evidence.json'), 'utf8'));
    expect(store.entries.at(-1)).toMatchObject({ sha, ok: true, runner: 'clean-checkout', clean_copy: { copy: 'worktree', dependencies: 'link' } });
  });

  it('an archive copy works too (no .git in it)', () => {
    const p = project([], { clean: { copy: 'archive' } });
    const r = p.run('--full', '--clean', '--cwd', p.repo);
    expect(r.code, r.out).toBe(0);
    expect(p.runs()[0]).toMatchObject({ git: false, stray: false, dep: true });
    expect(p.copies()).toEqual([]);
    expect(fs.readFileSync(path.join(p.deps, 'keep.txt'), 'utf8')).toBe('must survive');
  });

  it('gates.clean.include copies a listed ignored file in', () => {
    const p = project([], { clean: { include: ['.env.test'] } });
    expect(p.run('--full', '--clean', '--cwd', p.repo).code).toBe(0);
    expect(p.runs()[0]).toMatchObject({ included: true, stray: false });
  });

  it('a red run removes the copy, unless keepOnRed', () => {
    const p = project(['red']);
    expect(p.run('--full', '--clean', '--cwd', p.repo).code).toBe(1);
    expect(p.copies()).toEqual([]);
    p.writeConfig({ clean: { keepOnRed: true } });
    const r = p.run('--full', '--clean', '--cwd', p.repo);
    expect(r.code).toBe(1);
    expect(p.copies().filter((n) => !n.endsWith('.json'))).toHaveLength(1);
    expect(r.out).toMatch(/kept for inspection/);
  });

  it('a link a test left pointing out of the copy keeps the folder and its target, and the verdict stays green', () => {
    const p = project(['outlink']);
    // The outside folder as the test's third argument.
    p.writeConfig({});
    const cfg = JSON.parse(fs.readFileSync(path.join(p.folder, 'queue.config.json'), 'utf8'));
    cfg.gates.full = [`${cfg.gates.full[0]} ${JSON.stringify(p.outside)}`];
    fs.writeFileSync(path.join(p.folder, 'queue.config.json'), JSON.stringify(cfg));
    const r = p.run('--full', '--clean', '--cwd', p.repo);
    expect(r.code, r.out).toBe(0);
    expect(r.out).toMatch(/left in place/);
    expect(fs.readFileSync(path.join(p.outside, 'keep.txt'), 'utf8')).toBe('must survive');
    expect(fs.readFileSync(path.join(p.deps, 'keep.txt'), 'utf8')).toBe('must survive');
  });

  it('a setup failure runs no gate command and says so in one line, also in the log', () => {
    // install with no lockfile in the commit: the copy cannot get its dependencies.
    const p = project([], { clean: { dependencies: 'install' } });
    const log = path.join(p.folder, 'gate.log');
    const r = p.run('--full', '--clean', '--cwd', p.repo, '--log', log);
    expect(r.code).toBe(1);
    expect(r.out).toContain(GC.SETUP_RED);
    expect(p.runs()).toEqual([]);
    expect(fs.readFileSync(log, 'utf8')).toContain(GC.SETUP_RED);
    expect(p.copies()).toEqual([]);
    expect(p.worktrees()).toBe(1);
  });

  it('the sweep at start removes an old copy of a dead process, links first', () => {
    const p = project();
    const name = GC.copyName({ pid: 999_999_9, sha: 'abcdef0123456789' });
    const stale = path.join(p.base, name);
    fs.mkdirSync(stale, { recursive: true });
    fs.symlinkSync(p.deps, path.join(stale, 'node_modules'), LINK);
    GC.writeMeta(p.base, name, { pid: 999_999_9, sha: 'abcdef0123456789', copy: 'archive', links: ['node_modules'] });
    const old = new Date(Date.now() - 2 * 3_600_000);
    fs.utimesSync(stale, old, old);
    fs.utimesSync(GC.metaFile(p.base, name), old, old);
    expect(p.run('--full', '--clean', '--cwd', p.repo).code).toBe(0);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.readFileSync(path.join(p.deps, 'keep.txt'), 'utf8')).toBe('must survive');
  });
});

describe('gates.runner: which runs use the clean copy', () => {
  it('worktree (the default) runs in place and prints the one hint when it saw ignored files', () => {
    const p = project();
    const r = p.run('--full', '--cwd', p.repo);
    expect(r.code, r.out).toBe(0);
    expect(p.runs()[0]).toMatchObject({ stray: true });
    expect(r.out).toContain('ran locally in the main checkout');
    expect(r.out).toContain(GC.HINT);
  });

  it('clean picks the listed kinds only: the main checkout\'s full run is push, not in the default list', () => {
    const p = project([], { runner: 'clean' });
    expect(p.run('--full', '--cwd', p.repo).code).toBe(0);
    expect(p.runs()[0].stray).toBe(true);
    p.writeConfig({ runner: 'clean', clean: { kinds: ['full', 'push'] } });
    const r = p.run('--full', '--cwd', p.repo);
    expect(r.code, r.out).toBe(0);
    expect(p.runs()[1].stray).toBe(false);
    expect(r.out).not.toContain(GC.HINT);
  });

  it('receive\'s run on a track\'s worktree (--evidence) is the full kind; the track\'s own run there never is', () => {
    const p = project([], { runner: 'clean' });
    const wt = path.join(p.folder, 'wt');
    p.g(['worktree', 'add', '-q', '-b', 'queue/A', wt]);
    fs.writeFileSync(path.join(wt, 'stray.txt'), 'only in the track');
    fs.symlinkSync(p.deps, path.join(wt, 'node_modules'), LINK);
    expect(p.run('--quick', '--cwd', wt).code).toBe(0);
    expect(p.runs()[0]).toMatchObject({ stray: true });
    const r = p.run('--quick', '--evidence', '--cwd', wt, '--track', 'A');
    expect(r.code, r.out).toBe(0);
    expect(p.runs()[1]).toMatchObject({ stray: false, git: true, dep: true });
    expect(p.copies()).toEqual([]);
    expect(p.worktrees()).toBe(2);
  });
});
