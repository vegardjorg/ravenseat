// =============================================================
// fixLinks.test.ts: the optional task field `fixes` (a fix task names the task(s) it fixes).
//
// Why: the benchmark counts a merged task that a later task names in `fixes` as a defect after merge, so the link
// must be valid data: an id or a list, the ids must exist, never the task itself. The rule lives in lib/fixLinks.js
// (pure) and is enforced by queue.mjs add and edit, and shown by info and state, so both are tested here: the pure
// functions, and queue.mjs against a temporary folder and repo (never the real queue).
// =============================================================
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

type Task = Record<string, unknown> & { id: string };
const FX = require('../fixLinks.js') as {
  fixesList: (v: unknown) => string[] | undefined;
  fixesShapeError: (o: object) => string[];
  fixesError: (o: object, known: Iterable<string>) => string[];
  fixedBy: (id: string, tasks: Task[]) => string[];
  openFixLinks: (tasks: Task[]) => { id: string; status: string | null; fixes: string[] }[];
};
const L = require('../queueLogic.js') as {
  validate: (o: object, existing?: object[], register?: object) => string[];
  infoView: (o: object, option?: { fixedBy?: string[] }) => string[];
};

describe('fixLinks (pure)', () => {
  it('fixesList: one id becomes a list, duplicates go, null and [] give an empty list', () => {
    expect(FX.fixesList('A')).toEqual(['A']);
    expect(FX.fixesList(['A', 'B', 'A'])).toEqual(['A', 'B']);
    expect(FX.fixesList(null)).toEqual([]);
    expect(FX.fixesList([])).toEqual([]);
    expect(FX.fixesList(undefined)).toBeUndefined();
  });

  it('the shape: an id or a list of ids; validate reports it', () => {
    expect(FX.fixesShapeError({ fixes: 'A-1' })).toEqual([]);
    expect(FX.fixesShapeError({ fixes: ['A-1', 'B.2'] })).toEqual([]);
    expect(FX.fixesShapeError({})).toEqual([]);
    expect(FX.fixesShapeError({ fixes: 7 })[0]).toMatch(/fixes must be a task id/);
    expect(FX.fixesShapeError({ fixes: ['A', ''] })[0]).toMatch(/fixes must be a task id/);
    const task = { id: 'F', title: 't', domain: 'd', class: 'K', mission: 'm' };
    expect(L.validate({ ...task, fixes: 'A' })).toEqual([]);
    expect(L.validate({ ...task, fixes: { id: 'A' } }).join(' ')).toMatch(/fixes must be/);
  });

  it('fixesError: unknown ids and the task itself are refused', () => {
    expect(FX.fixesError({ id: 'F', fixes: ['A'] }, ['A', 'B'])).toEqual([]);
    expect(FX.fixesError({ id: 'F', fixes: ['A', 'X', 'Y'] }, ['A'])).toEqual([
      'fixes names unknown task(s) X, Y (the id(s) must exist in the queue)',
    ]);
    expect(FX.fixesError({ id: 'F', fixes: 'F' }, ['F'])).toEqual(['fixes cannot name the task itself (F)']);
  });

  it('fixedBy and openFixLinks: who fixes a task, and the open fix tasks for state', () => {
    const tasks: Task[] = [
      { id: 'A', status: 'done' },
      { id: 'F1', status: 'waiting', fixes: ['A'] },
      { id: 'F2', status: 'done', fixes: 'A' },
      { id: 'F3', status: 'cancelled', fixes: ['A'] },
      { id: 'F4', status: 'running', fixes: ['F1', 'A'] },
    ];
    expect(FX.fixedBy('A', tasks)).toEqual(['F1', 'F2', 'F3', 'F4']);
    expect(FX.fixedBy('F1', tasks)).toEqual(['F4']);
    expect(FX.openFixLinks(tasks)).toEqual([
      { id: 'F1', status: 'waiting', fixes: ['A'] },
      { id: 'F4', status: 'running', fixes: ['F1', 'A'] },
    ]);
  });

  it('infoView shows fixes and fixed by', () => {
    const view = L.infoView({ id: 'F1', title: 't', status: 'waiting', fixes: ['A'] }, { fixedBy: ['F4'] });
    expect(view).toContain('fixes: A');
    expect(view).toContain('fixed by: F4');
    expect(L.infoView({ id: 'A' }).join('\n')).not.toContain('fixed by');
  });
});

describe('queue.mjs add, edit, info and state with fixes (against a temporary folder)', () => {
  const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
  const folders: string[] = [];
  afterAll(() => {
    for (const f of folders) fs.rmSync(f, { recursive: true, force: true });
  });

  it('accepts existing ids (from a file and JSON), refuses unknown ones, and shows the link', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-fixes-'));
    folders.push(folder);
    const repo = path.join(folder, 'repo');
    fs.mkdirSync(repo);
    execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main'], { stdio: 'ignore' });
    const task = (id: string, extra: object = {}) => ({
      id,
      title: `Task ${id}`,
      domain: 'dom',
      class: 'K',
      mission: 'Do it.',
      value: 5,
      content_min: 120,
      ...extra,
    });
    fs.writeFileSync(
      path.join(folder, 'queue.json'),
      JSON.stringify({ created: '2026-10-01T00:00:00.000Z', limits: {}, resolved: [], tasks: [{ ...task('A'), status: 'done' }] }),
    );
    const configFile = path.join(folder, 'queue.config.json');
    fs.writeFileSync(configFile, JSON.stringify({}));
    const env = {
      ...process.env,
      QUEUE_FOLDER: folder,
      QUEUE_CONFIG: configFile,
      QUEUE_ROOT: folder,
      QUEUE_GIT: repo,
      QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
      QUEUE_TRANSCRIPTS: path.join(folder, 'transcripts'),
    };
    const run = (...args: string[]) => {
      const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'orchestrator', 'queue.mjs'), ...args], {
        encoding: 'utf8',
        env,
      });
      return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '' };
    };
    const tasks = () => JSON.parse(fs.readFileSync(path.join(folder, 'queue.json'), 'utf8')).tasks as Task[];

    // An unknown id: nothing is added, and the message names it.
    const bad = run('add', '--json', JSON.stringify(task('F0', { fixes: ['NOPE'] })));
    expect(bad.code).toBe(1);
    expect(bad.error).toContain('fixes names unknown task(s) NOPE');
    expect(tasks().map((t) => t.id)).toEqual(['A']);

    // One id from a file is stored as a list; a task added in the same add can be named too.
    const file = path.join(folder, 'add.json');
    fs.writeFileSync(file, JSON.stringify([task('F1', { fixes: 'A' }), task('F2', { fixes: ['F1', 'A'] })]));
    const ok = run('add', '--file', file);
    expect(ok.error).toBe('');
    expect(ok.code).toBe(0);
    expect(tasks().find((t) => t.id === 'F1')!.fixes).toEqual(['A']);
    expect(tasks().find((t) => t.id === 'F2')!.fixes).toEqual(['F1', 'A']);

    // edit: unknown and self are refused, [] removes the link.
    expect(run('edit', 'F1', '--json', JSON.stringify({ fixes: ['NOPE'] })).error).toContain('unknown task(s) NOPE');
    expect(run('edit', 'F1', '--json', JSON.stringify({ fixes: 'F1' })).error).toContain('cannot name the task itself');
    expect(run('edit', 'F2', '--json', JSON.stringify({ fixes: 'A' })).code).toBe(0);
    expect(tasks().find((t) => t.id === 'F2')!.fixes).toEqual(['A']);

    // info shows both directions; state lists the open fix tasks.
    expect(run('info', 'F1').out).toContain('fixes: A');
    expect(run('info', 'A').out).toContain('fixed by: F1, F2');
    const state = JSON.parse(run('state').out) as { fixLinks: { id: string; fixes: string[] }[] };
    expect(state.fixLinks).toEqual([
      { id: 'F1', status: 'waiting', fixes: ['A'] },
      { id: 'F2', status: 'waiting', fixes: ['A'] },
    ]);

    expect(run('edit', 'F2', '--json', JSON.stringify({ fixes: [] })).code).toBe(0);
    expect(tasks().find((t) => t.id === 'F2')).not.toHaveProperty('fixes');
  }, 60_000);
});
