// =============================================================
// queueDoctor.test.ts: `cq doctor`, the read-only health check (scripts/orchestrator/cli/doctor.mjs).
//
// Why: a half-deleted worktree folder, a hooks file that points at a missing script or a config value of the wrong
// type stop the queue quietly. The doctor must name each of them with a fix hint, exit 1 on a FAIL, and never change
// anything. Tested against temporary git repos (QUEUE_ROOT, QUEUE_FOLDER, QUEUE_CONFIG, QUEUE_GIT, QUEUE_HOOKS),
// never the real project.
// =============================================================
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PLUGIN = path.resolve(__dirname, '..', '..', '..', '..');
const QUEUE = path.join(PLUGIN, 'scripts', 'orchestrator', 'queue.mjs');
const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});

type Check = { status: 'OK' | 'INFO' | 'WARN' | 'FAIL'; name: string; message: string; fix: string | null };

/** A temporary project: a git repo with one commit, a data folder with queue.json, a config and a hooks file. */
function project({ config = {}, hooks = null }: { config?: object | string; hooks?: object | null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-doctor-'));
  temporary.push(root);
  const g = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(root, 'README.md'), 'x\n');
  g('add', 'README.md');
  g('commit', '-q', '-m', 'start');
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  fs.writeFileSync(
    path.join(data, 'queue.json'),
    JSON.stringify({
      tasks: [
        { id: 'A-1', status: 'done', class: 'K' },
        { id: 'A-2', status: 'waiting', class: 'K' },
      ],
      projects: {},
    }),
  );
  const configFile = path.join(root, 'queue.config.json');
  fs.writeFileSync(configFile, typeof config === 'string' ? config : JSON.stringify(config));
  // The plugin's own hooks file (the scripts exist in this repo), unless the test gives its own.
  const hooksFile = path.join(root, 'hooks.json');
  fs.writeFileSync(
    hooksFile,
    hooks ? JSON.stringify(hooks) : fs.readFileSync(path.join(PLUGIN, 'hooks', 'hooks.json'), 'utf8'),
  );
  const env = {
    ...process.env,
    QUEUE_ROOT: root,
    QUEUE_FOLDER: data,
    QUEUE_CONFIG: configFile,
    QUEUE_GIT: root,
    QUEUE_HOOKS: hooksFile,
    QUEUE_TIME_LOG: path.join(data, 'times.jsonl'),
  };
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [QUEUE, 'doctor', ...args], { encoding: 'utf8', env, cwd: root });
    return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '' };
  };
  const json = () => JSON.parse(run('--json').out) as { ok: boolean; checks: Check[] };
  return { root, data, g, run, json };
}

/** A snapshot of every file under a folder (path -> content), to show the doctor wrote nothing. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p, 'latin1');
    }
  };
  walk(dir);
  return out;
}

describe('cq doctor', () => {
  it('a healthy project: no FAIL, exit 0, every line OK or WARN, and nothing is written', () => {
    const p = project({ config: { baseBranch: 'main', loadGuard: { minFreeMemoryPct: null } } });
    const before = snapshot(p.root);
    const r = p.run();
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/^FAIL/m);
    expect(r.out).toMatch(/^OK {4}node {7}Node \d+/m);
    expect(r.out).toMatch(/^OK {4}hooks {6}10 queue hooks listed in .*, all scripts exist$/m);
    expect(r.out).toMatch(/^OK {4}config {5}queue\.config\.json parses, keys and types valid$/m);
    expect(r.out).toMatch(/^OK {4}queue {6}queue\.json parses \(2 task\(s\)\)$/m);
    expect(r.out).toMatch(/^OK {4}lock {7}no lock held$/m);
    expect(r.out).toMatch(/^OK {4}worktrees {2}0 agent worktree folder/m);
    expect(r.out).toMatch(/^OK {4}branches {3}no branches of finished tasks left$/m);
    expect(r.out).toMatch(/0 FAIL\. Nothing was changed\.$/m);
    expect(p.json().ok).toBe(true);
    expect(snapshot(p.root)).toEqual(before);
  }, 60_000);

  it('names each problem with a fix hint and exits 1 on a FAIL', () => {
    const p = project({
      config: { baseBranch: 7, mode: 'tiny', gatez: [], loadGuard: { minFreePct: 3, adaptive: 'yes' } },
      hooks: {
        hooks: {
          SubagentStart: [{ matcher: '*', hooks: [{ type: 'command', command: 'node', args: ['/nowhere/scripts/orchestrator/hook-time.mjs'] }] }],
        },
      },
    });
    // A half-deleted worktree (a folder without .git), and a git worktree whose folder is gone.
    fs.mkdirSync(path.join(p.root, '.claude', 'worktrees', 'half', 'src'), { recursive: true });
    const gone = path.join(p.root, '.claude', 'worktrees', 'gone');
    p.g('worktree', 'add', '-q', '-b', 'side', gone);
    fs.rmSync(gone, { recursive: true, force: true });
    // The branch of the done task A-1 is still there; the waiting A-2's branch does not count.
    p.g('branch', 'queue/A-1');
    p.g('branch', 'queue/A-2');
    // A lock left by a process that died 5 minutes ago.
    const lock = path.join(p.data, '.lockState');
    fs.mkdirSync(lock);
    const old = new Date(Date.now() - 5 * 60_000);
    fs.utimesSync(lock, old, old);
    const before = snapshot(p.root);

    const r = p.run();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^FAIL {2}hooks {6}missing in .*hook-push-guard\.mjs \(PreToolUse\)/m);
    expect(r.out).toMatch(/^FAIL {2}hooks {6}hook script\(s\) not found: \/nowhere\/scripts\/orchestrator\/hook-time\.mjs \(SubagentStart\)$/m);
    expect(r.out).toMatch(/wrong type in queue\.config\.json: baseBranch is number, expected string; loadGuard\.adaptive is string, expected boolean; mode is "tiny"/);
    expect(r.out).toMatch(/^WARN {2}config {5}unknown key\(s\) ignored: gatez, loadGuard\.minFreePct$/m);
    expect(r.out).toMatch(/^WARN {2}lock {7}stale lock .*\.lockState \(\d+ s old\)$/m);
    expect(r.out).toMatch(/^FAIL {2}worktrees {2}folder\(s\) without \.git under .*: half \(a half-deleted worktree blocks agent starts\)$/m);
    expect(r.out).toMatch(/^WARN {2}worktrees {2}git worktree\(s\) whose folder is gone: .*gone \(side\)$/m);
    expect(r.out).toMatch(/^ {17}fix: git worktree prune/m);
    expect(r.out).toMatch(/^WARN {2}branches {3}1 branch\(es\) of done or cancelled tasks still exist: queue\/A-1$/m);
    expect(r.out).toMatch(/^ {17}fix: git branch -d queue\/A-1 /m);
    const j = p.json();
    expect(j.ok).toBe(false);
    for (const c of j.checks) if (c.status !== 'OK') expect(c.fix).toEqual(expect.any(String));
    // Read-only: the lock, the broken folder, the branches and the worktree record are all still there.
    expect(snapshot(p.root)).toEqual(before);
    expect(fs.existsSync(lock)).toBe(true);
  }, 60_000);

  it('a queue.json or config that does not parse is a FAIL; a missing queue is a WARN', () => {
    const p = project({ config: '{ "baseBranch": "main", }' });
    fs.writeFileSync(path.join(p.data, 'plans.json'), '{');
    let r = p.run();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/^FAIL {2}config {5}.*queue\.config\.json does not parse/m);
    expect(r.out).toMatch(/^FAIL {2}queue {6}plans\.json does not parse/m);
    fs.writeFileSync(path.join(p.data, 'queue.json'), '{"tasks": [');
    expect(p.run().out).toMatch(/^FAIL {2}queue {6}queue\.json does not parse/m);
    fs.rmSync(path.join(p.data, 'queue.json'));
    fs.rmSync(path.join(p.data, 'plans.json'));
    fs.writeFileSync(path.join(p.root, 'queue.config.json'), '{}');
    r = p.run();
    expect(r.out).toMatch(/^WARN {2}queue {6}no queue at .*\n {17}fix: run cq init$/m);
    expect(r.code).toBe(0);
  }, 60_000);

  it('push config: valid keys pass, bad values FAIL, an unknown push key WARNs', () => {
    let p = project({
      config: { push: { mode: 'threshold', minTasks: 10, warnTasks: 50, maxAgeHours: 24 }, loadGuard: { minFreeMemoryPct: null } },
    });
    expect(p.run().out).toMatch(/^OK {4}config {5}queue\.config\.json parses, keys and types valid$/m);
    p = project({ config: { push: { mode: 'auto', minTasks: -2, minTask: 3 }, loadGuard: { minFreeMemoryPct: null } } });
    const r = p.run();
    expect(r.code).toBe(1);
    expect(r.out).toMatch(
      /wrong type in queue\.config\.json: push\.mode is "auto", expected owner or threshold; push\.minTasks must be a whole number >= 0/,
    );
    expect(r.out).toMatch(/^WARN {2}config {5}unknown key\(s\) ignored: push\.minTask$/m);
  }, 60_000);

  it('ci-cost: WARN without cancel-in-progress, INFO without a path filter, nothing for workflows not on push', () => {
    const p = project({ config: { loadGuard: { minFreeMemoryPct: null } } });
    // No workflows folder: no ci-cost line at all.
    expect(p.json().checks.some((c) => c.name === 'ci-cost')).toBe(false);
    const dir = path.join(p.root, '.github', 'workflows');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ci.yml'), ['name: ci', 'on:', '  push:', '    branches: [main]', 'jobs:', '  t:', '    runs-on: x', ''].join('\n'));
    fs.writeFileSync(
      path.join(dir, 'good.yaml'),
      ['on:', '  push:', "    paths-ignore: ['docs/**']", 'concurrency:', '  group: g-${{ github.ref }}', '  cancel-in-progress: true', 'jobs: {}', ''].join('\n'),
    );
    fs.writeFileSync(path.join(dir, 'pr.yml'), 'on: pull_request\njobs: {}\n');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'on: push\n');
    const r = p.run();
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^WARN {2}ci-cost {4}ci\.yml runs on push without concurrency cancel-in-progress/m);
    expect(r.out).toMatch(/^INFO {2}ci-cost {4}ci\.yml runs on push without a paths\/paths-ignore filter/m);
    expect(r.out).toMatch(/fix: add `concurrency: /);
    expect(r.out).not.toMatch(/good\.yaml|pr\.yml|notes\.txt/);
    expect(p.json().checks.filter((c) => c.name === 'ci-cost').map((c) => c.status)).toEqual(['WARN', 'INFO']);
    // All fixed: one OK line.
    fs.rmSync(path.join(dir, 'ci.yml'));
    expect(p.run().out).toMatch(/^OK {4}ci-cost {4}1 workflow\(s\) on push, all with cancel-in-progress and a path filter$/m);
  }, 60_000);
});
