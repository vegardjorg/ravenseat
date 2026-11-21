// =============================================================
// startChecksFlow.test.ts: the checks before a task starts (PS-1..3, lib/startChecks.js) through `ravenseat add` and
// `ravenseat start`.
//
// Locks: (1) add warns about a path the mission names outside the task's files, about a D task with no owned_files and
// about a D task without content_min, and the task is added anyway; (2) such a D task is stored with content_min null
// (the estimate still counts 30) and start says the size is a guess, and repeats the warnings; (3) with the
// planChecks settings off, add is as before: no lines, and content_min 30 is stored.
// Runs queue.mjs against a temporary queue (QUEUE_FOLDER) and a temporary git repo (QUEUE_GIT). Never the real queue.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];

const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

function setup(config: Record<string, unknown> = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-start-checks-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  fs.mkdirSync(path.join(repo, 'src', 'widgets'), { recursive: true });
  const g = (args: string[]) =>
    execFileSync('git', ['-C', repo, ...ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g(['init', '-q', '-b', 'develop']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'start\n');
  fs.writeFileSync(path.join(repo, 'src', 'widgets', 'a.ts'), 'export {};\n');
  g(['add', '--', 'README.md', 'src/widgets/a.ts']);
  g(['commit', '-q', '-m', 'start']);
  const queueFile = path.join(folder, 'queue.json');
  fs.writeFileSync(queueFile, JSON.stringify({ created: '2026-01-01T00:00:00.000Z', limits: {}, next_migr: 3600, resolved: [], tasks: [] }));
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'develop', ...config }));
  const env = {
    ...process.env,
    QUEUE_FOLDER: folder,
    QUEUE_CONFIG: configFile,
    QUEUE_ROOT: repo,
    QUEUE_GIT: repo,
    QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
    QUEUE_TRANSCRIPTS: path.join(folder, 'transcripts'),
  } as NodeJS.ProcessEnv;
  delete env.QUEUE_SCRATCHPAD;
  delete env.QUEUE_SESSION;
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'orchestrator', 'queue.mjs'), ...args], {
      encoding: 'utf8',
      env,
      cwd: repo,
    });
    return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '' };
  };
  const tasks = () => (JSON.parse(fs.readFileSync(queueFile, 'utf8')) as { tasks: Record<string, unknown>[] }).tasks;
  return { run, tasks };
}

const dTask = (extra: Record<string, unknown> = {}) => ({
  id: 'D1',
  title: 'A database task',
  domain: 'db',
  class: 'D',
  value: 6,
  mission: 'Change lib/store.js, see https://example.com/x.js, and look in src/widgets/ and README.md.',
  ...extra,
});

describe('the checks before a task starts, at add and start', () => {
  it('add warns about named paths, empty ownership and the missing size, and adds the task', () => {
    const p = setup();
    const r = p.run('add', '--json', JSON.stringify(dTask()));
    expect(r.code, r.error).toBe(0);
    expect(r.out).toContain('WARNING: D1: the mission names paths the task does not own, share or read: lib/store.js, src/widgets/, README.md.');
    expect(r.out).not.toContain('example.com');
    expect(r.out).toContain('WARNING: D1: class D with no owned_files');
    expect(r.out).toContain('WARNING: D1: class D without content_min (size not set)');
    const t = p.tasks().find((x) => x.id === 'D1')!;
    expect(t.content_min).toBeNull();
  });

  it('a task that owns what its mission names gets no path line', () => {
    const p = setup();
    const r = p.run('add', '--json', JSON.stringify(dTask({ owned_files: ['lib/store.js', 'src/widgets/'], reads: ['README.md'], content_min: 40 })));
    expect(r.code, r.error).toBe(0);
    expect(r.out).not.toContain('WARNING: D1');
    expect(p.tasks()[0].content_min).toBe(40);
  });

  it('start repeats the warnings and marks the estimate as a guess', () => {
    const p = setup();
    expect(p.run('add', '--json', JSON.stringify(dTask())).code).toBe(0);
    const r = p.run('start', 'D1', '--force');
    expect(r.code, r.error).toBe(0);
    expect(r.out).toMatch(/estimate \d+ min \(size not set, a guess\)/);
    expect(r.out).toContain('WARNING: D1: the mission names paths');
    expect(r.out).toContain('WARNING: D1: class D with no owned_files');
  });

  it('with the settings off, add says nothing and stores 30 as before', () => {
    const p = setup({ planChecks: { missionPaths: false, emptyOwnership: false, sizeNotSet: false } });
    const r = p.run('add', '--json', JSON.stringify(dTask()));
    expect(r.code, r.error).toBe(0);
    expect(r.out).not.toContain('WARNING: D1');
    expect(p.tasks()[0].content_min).toBe(30);
  });
});
