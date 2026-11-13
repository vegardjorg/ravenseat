// =============================================================
// queueAddFields.test.ts: `ravenseat add` warns about a task field no task has (lib/taskFields.js).
//
// Locks: (1) a task with `owns` (meant: owned_files) is added, with a WARNING that names the field and "did you mean
// owned_files?" (add already warns and keeps the task for `minutes`, F4 in queueAttempt.test.ts); (2) one line per
// unknown field, without a guess when nothing is close; (3) the documented fields and the ones the queue writes itself
// (a task copied from another queue) give no warning, and `minutes` keeps its own line. Found in a live test, where a
// task with `owns` ran without owned files and only a NOTE at merge said so.
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

function setup() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-add-fields-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  fs.mkdirSync(repo);
  const g = (args: string[]) =>
    execFileSync('git', ['-C', repo, ...ID, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  g(['init', '-q', '-b', 'develop']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'start\n');
  g(['add', '--', 'README.md']);
  g(['commit', '-q', '-m', 'start']);
  const queueFile = path.join(folder, 'queue.json');
  fs.writeFileSync(queueFile, JSON.stringify({ created: '2026-01-01T00:00:00.000Z', limits: {}, next_migr: 3600, resolved: [], tasks: [] }));
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'develop' }));
  const env = {
    ...process.env,
    QUEUE_FOLDER: folder,
    QUEUE_CONFIG: configFile,
    QUEUE_ROOT: folder,
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
      cwd: folder,
    });
    return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '' };
  };
  const tasks = () => (JSON.parse(fs.readFileSync(queueFile, 'utf8')) as { tasks: { id: string }[] }).tasks;
  return { run, tasks, queueFile };
}

const task = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Task ${id}`,
  domain: `dom-${id}`,
  class: 'K',
  mission: `The mission for ${id}.`,
  value: 6,
  content_min: 100,
  ...extra,
});

describe('ravenseat add and unknown task fields', () => {
  it('warns about owns and names owned_files; the task is added as given', () => {
    const p = setup();
    const r = p.run('add', '--json', JSON.stringify(task('T1', { owns: ['src/a.js'] })));
    expect(r.code, r.error).toBe(0);
    expect(r.out).toContain('WARNING: T1: unknown field "owns"; the queue does not read it (did you mean owned_files?).');
    expect(p.tasks().map((t) => t.id)).toEqual(['T1']);
  });

  it('one line per unknown field; a field with nothing close gets no guess', () => {
    const p = setup();
    const r = p.run('add', '--json', JSON.stringify([task('T1'), task('T2', { zzqx_flag: true, dependson: ['T1'] })]));
    expect(r.code, r.error).toBe(0);
    expect(r.out).toContain('WARNING: T2: unknown field "zzqx_flag"; the queue does not read it.');
    expect(r.out).toContain('WARNING: T2: unknown field "dependson"; the queue does not read it (did you mean depends_on?).');
    expect(r.out).not.toContain('WARNING: T1: unknown field');
  });

  it('no warning for the documented fields and the ones the queue writes itself; minutes keeps its own line', () => {
    const p = setup();
    const r = p.run(
      'add',
      '--json',
      JSON.stringify(
        task('T1', {
          owned_files: ['src/a.js'],
          owner_db: [],
          shared_patch: [],
          reads: ['docs/'],
          feature: 'Login',
          source: 'docs/plan.md § 2',
          added_by: 'owner',
          remarks: [],
          minutes: 10,
        }),
      ),
    );
    expect(r.code, r.error).toBe(0);
    expect(r.out).not.toContain('unknown field');
    expect(r.out).toContain('the queue does not read "minutes"; the field is content_min.');
  });
});
