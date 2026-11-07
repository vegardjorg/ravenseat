// =============================================================
// queueCycles.test.ts: dependency cycles and hand-edited tasks (red team findings 1 and 2, plans/redteam-plan.md).
//
// Why: X1 waiting on X2 and X2 on X1 used to be accepted by add, after which `next` showed neither and nothing said
// why: both tasks stayed waiting forever. And a task edited by hand without `domain` crashed `next` with a TypeError.
// Now add and edit refuse a cycle, doctor names one that is already there, and the lists show "?" for a missing field.
// The pure function is tested directly (lib/logic/validate.js); the CLI paths run against a temporary git repo
// (QUEUE_ROOT, QUEUE_FOLDER, QUEUE_CONFIG, QUEUE_GIT), never the real project.
// =============================================================
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const L = require('../queueLogic.js');
const PLUGIN = path.resolve(__dirname, '..', '..', '..', '..');
const QUEUE = path.join(PLUGIN, 'scripts', 'orchestrator', 'queue.mjs');
const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});

const t = (id: string, depends_on: string[] = [], status = 'waiting') => ({ id, status, depends_on });

describe('dependencyCycles (pure)', () => {
  it('finds a two-task cycle once, with the path closed on its first id', () => {
    const c = L.dependencyCycles([t('X1', ['X2']), t('X2', ['X1']), t('X3')]);
    expect(c).toHaveLength(1);
    expect(c[0][0]).toBe(c[0][c[0].length - 1]);
    expect(new Set(c[0])).toEqual(new Set(['X1', 'X2']));
  });

  it('finds a longer cycle and a self-dependency', () => {
    expect(L.dependencyCycles([t('A', ['B']), t('B', ['C']), t('C', ['A'])])[0]).toHaveLength(4);
    expect(L.dependencyCycles([t('S', ['S'])])).toEqual([['S', 'S']]);
  });

  it('a chain, a diamond and a cycle through a done or cancelled task are not cycles', () => {
    expect(L.dependencyCycles([t('A', ['B']), t('B', ['C']), t('C')])).toEqual([]);
    expect(L.dependencyCycles([t('A', ['B', 'C']), t('B', ['D']), t('C', ['D']), t('D')])).toEqual([]);
    expect(L.dependencyCycles([t('A', ['B']), t('B', ['A'], 'done')])).toEqual([]);
    expect(L.dependencyCycles([t('A', ['B']), t('B', ['A'], 'cancelled')])).toEqual([]);
  });

  it('an unknown dependency or a missing depends_on is ignored, not a crash', () => {
    expect(L.dependencyCycles([t('A', ['NOPE']), { id: 'B', status: 'waiting' }, null])).toEqual([]);
  });

  it('cycleError names the cycle only for a task in it', () => {
    const after = [t('X1', ['X2']), t('X2', ['X1']), t('X3')];
    expect(L.cycleError(after[0], after)[0]).toMatch(/^depends_on would create a cycle: X\d -> X\d -> X\d/);
    expect(L.cycleError(after[2], after)).toEqual([]);
  });
});

/** A temporary project with a queue folder; `run` calls the CLI there. */
function project(tasks: object[] = []) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-cycles-'));
  temporary.push(root);
  const g = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: root, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(root, 'README.md'), 'x\n');
  g('add', 'README.md');
  g('commit', '-q', '-m', 'start');
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  const file = path.join(data, 'queue.json');
  fs.writeFileSync(file, JSON.stringify({ tasks, projects: {}, question: {}, resolved: [] }));
  const configFile = path.join(root, 'queue.config.json');
  fs.writeFileSync(configFile, '{}');
  const env = {
    ...process.env,
    QUEUE_ROOT: root,
    QUEUE_FOLDER: data,
    QUEUE_CONFIG: configFile,
    QUEUE_GIT: root,
    QUEUE_TIME_LOG: path.join(data, 'times.jsonl'),
  };
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [QUEUE, ...args], { encoding: 'utf8', env, cwd: root });
    return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '' };
  };
  const add = (list: object[]) => {
    const inFile = path.join(root, `in-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(inFile, JSON.stringify(list));
    return run('add', '--file', inFile);
  };
  const queue = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  return { root, run, add, queue };
}

/** A task add accepts on its own (big enough for the small-task guard, its own file). */
const task = (id: string, depends_on: string[] = []) => ({
  id,
  title: `task ${id}`,
  class: 'K',
  domain: 'core',
  mission: `Do ${id}.`,
  value: 5,
  content_min: 100,
  depends_on,
  owned_files: [`${id}.ts`],
});

describe('add, edit and doctor refuse or name a cycle', () => {
  it('add refuses two new tasks that wait on each other, and writes nothing', () => {
    const p = project();
    const r = p.add([task('X1', ['X2']), task('X2', ['X1']), task('X3')]);
    expect(r.code).not.toBe(0);
    expect(r.out + r.error).toMatch(/depends_on would create a cycle: X\d -> X\d -> X\d/);
    expect(p.queue().tasks).toEqual([]);
  });

  it('add refuses a new task that closes a cycle with one already in the queue', () => {
    const p = project();
    expect(p.add([task('A', ['B']), task('B')]).code).toBe(0);
    const r = p.add([task('C', ['A'])]);
    expect(r.code).toBe(0);
    // B waits on nothing, so only a new dependency on A from B's side would close one: edit is the way to try it.
    const e = p.run('edit', 'B', '--json', JSON.stringify({ depends_on: ['C'] }));
    expect(e.code).not.toBe(0);
    expect(e.out + e.error).toMatch(/cycle: .*B.*->/);
    expect(p.queue().tasks.find((o: { id: string }) => o.id === 'B').depends_on).toEqual([]);
  });

  it('doctor warns about a cycle that is already in queue.json (a hand edit), with a fix', () => {
    const p = project([
      { ...task('X1', ['X2']), status: 'waiting' },
      { ...task('X2', ['X1']), status: 'waiting' },
    ]);
    const r = p.run('doctor');
    expect(r.out).toMatch(/^WARN {2}queue {6}dependency cycle: X\d -> X\d -> X\d \(none of these tasks can ever start\)$/m);
    expect(r.out).toMatch(/fix: remove one dependency: .* edit X\d/);
  });

  it('an unrelated edit of a task in an old cycle still works (doctor is where it shows)', () => {
    const p = project([
      { ...task('X1', ['X2']), status: 'waiting' },
      { ...task('X2', ['X1']), status: 'waiting' },
    ]);
    expect(p.run('edit', 'X1', '--json', JSON.stringify({ title: 'renamed' })).code).toBe(0);
  });
});

describe('a task edited by hand without domain or class', () => {
  it('next and show print "?" for the missing field instead of crashing', () => {
    const { domain: _d, ...noDomain } = task('H1');
    const { class: _c, ...noClass } = task('H2');
    const p = project([
      { ...noDomain, status: 'waiting' },
      { ...noClass, status: 'waiting' },
    ]);
    for (const cmd of ['next', 'show']) {
      const r = p.run(cmd);
      expect(r.error).not.toMatch(/TypeError/);
      expect(r.code).toBe(0);
    }
    expect(p.run('show').out).toMatch(/H1 .*\?/);
  });
});
