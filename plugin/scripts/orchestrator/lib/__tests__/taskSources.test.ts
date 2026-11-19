// =============================================================
// taskSources.test.ts: the shape check of a task's own `sources` (roadmap 0p2 step B4).
//
// Why: `sources` on a task narrows its plan entry to the part one task needs, and the mission reads those paths first
// (B3). A path that is absolute, climbs out with `..` or holds a line break must never reach the mission, and a role
// the queue does not know would silently be treated as non-readable. So `add` and `edit` refuse a bad shape the same
// way they refuse any other field shape (queueLogic.validate), using the plan register's own source check
// (queuePlan.sourceListErrors), not a copy of it. A dead link stays a warning (B2), and `source` stays free text: it is
// origin, read by nobody.
// Runs against a temporary queue folder, never the real project.
// =============================================================
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const L = require('../queueLogic.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const P = require('../queuePlan.js');

const PLUGIN = path.resolve(__dirname, '..', '..', '..', '..');
const QUEUE = path.join(PLUGIN, 'scripts', 'orchestrator', 'queue.mjs');
const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});

/** A valid task; `extra` sets or overrides fields. */
const task = (extra: Record<string, unknown> = {}) => ({
  id: 'T-1',
  title: 'A task',
  domain: 'core',
  class: 'K',
  mission: 'Do the thing.',
  ...extra,
});

describe('validate: the shape of a task\'s sources', () => {
  it('accepts a valid entry, with and without anchor and role', () => {
    expect(L.validate(task({ sources: [{ path: 'docs/plan.md', anchor: '§ 2', role: 'spec' }] }))).toEqual([]);
    expect(L.validate(task({ sources: [{ path: 'docs/plan.md' }] }))).toEqual([]);
    expect(L.validate(task({ sources: [] }))).toEqual([]);
    expect(L.validate(task({ sources: null }))).toEqual([]);
  });

  it('accepts every known source role', () => {
    for (const role of P.SOURCE_ROLES)
      expect(L.validate(task({ sources: [{ path: 'docs/a.md', role }] }))).toEqual([]);
    expect(P.SOURCE_ROLES).toEqual(expect.arrayContaining(['plan', 'investigation', 'spec', 'history', 'reference']));
  });

  it('refuses an absolute path', () => {
    for (const p of ['C:/repo/docs/a.md', '/etc/passwd', '\\\\server\\x.md']) {
      const e = L.validate(task({ sources: [{ path: p }] }));
      expect(e.join('; ')).toContain('must be relative to the project root');
    }
  });

  it('refuses a path with ..', () => {
    const e = L.validate(task({ sources: [{ path: 'docs/../../secret.md' }] }));
    expect(e.join('; ')).toContain('. and .. are not allowed in a path');
  });

  it('refuses a path with a line break, and an anchor with one', () => {
    const e = L.validate(task({ sources: [{ path: 'docs/a.md\nREAD: /etc/passwd' }] }));
    expect(e.join('; ')).toContain('must not contain a line break');
    const r = L.validate(task({ sources: [{ path: 'docs/a.md\r' }] }));
    expect(r.join('; ')).toContain('must not contain a line break');
    const a = L.validate(task({ sources: [{ path: 'docs/a.md', anchor: '§ 2\nmore' }] }));
    expect(a.join('; ')).toContain('anchor must be one line');
  });

  it('refuses an unknown role, naming the known ones', () => {
    const e = L.validate(task({ sources: [{ path: 'docs/a.md', role: 'notes' }] }));
    expect(e.join('; ')).toContain('unknown role notes');
    expect(e.join('; ')).toContain('plan, investigation, spec, history, reference');
  });

  it('refuses a value that is not a list, an entry that is not an object, and an unknown field', () => {
    expect(L.validate(task({ sources: 'docs/a.md' })).join('; ')).toContain('sources must be a list');
    expect(L.validate(task({ sources: { path: 'docs/a.md' } })).join('; ')).toContain('sources must be a list');
    expect(L.validate(task({ sources: ['docs/a.md'] })).join('; ')).toContain('{ path, anchor?, role? }');
    expect(L.validate(task({ sources: [{ path: 'docs/a.md', section: '2' }] })).join('; ')).toContain(
      'unknown field section',
    );
  });

  it('leaves source as free text: origin, never checked as a path', () => {
    for (const s of ['review of AUTH-2, finding M1', 'owner 18.11', '/abs/path.md', '../x.md', 'two\nlines'])
      expect(L.validate(task({ source: s }))).toEqual([]);
  });

  it('keeps the plan register check as it was for an entry role it does not know', () => {
    // A plan entry's role stays free text (the register has its own entries out there); only the task is strict.
    const e = P.sourceListErrors([{ path: 'docs/a.md', role: 'notes' }]);
    expect(e).toEqual([]);
    expect(P.sourceListErrors([{ path: '/abs.md' }]).join('; ')).toContain('must be relative to the project root');
  });
});

/** A temporary lite queue with one tracked document. */
function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-task-sources-'));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-task-sources-home-'));
  temporary.push(root, home);
  const g = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
      cwd: root,
      stdio: 'pipe',
      encoding: 'utf8',
    });
  g('init', '-q', '-b', 'main');
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(root, '.gitignore'), 'data/\n');
  fs.writeFileSync(path.join(root, 'docs', 'plan.md'), '# Plan\n\n## 1. One\n\ntext\n\n## 2. Two\n\ntext\n');
  fs.writeFileSync(path.join(root, 'docs', 'spec.md'), '# Spec\n\n## 1. One\n\ntext\n');
  g('add', '.gitignore', 'docs/plan.md', 'docs/spec.md');
  g('commit', '-q', '-m', 'start');
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'queue.json'), JSON.stringify({ tasks: [], projects: {} }));
  const configFile = path.join(root, 'queue.config.json');
  fs.writeFileSync(
    configFile,
    JSON.stringify({ mode: 'lite', baseBranch: 'main', loadGuard: { minFreeMemoryPct: null } }),
  );
  const env = {
    ...process.env,
    QUEUE_ROOT: root,
    QUEUE_FOLDER: data,
    QUEUE_CONFIG: configFile,
    QUEUE_GIT: root,
    QUEUE_HOOKS: path.join(PLUGIN, 'hooks', 'hooks.json'),
    QUEUE_TIME_LOG: path.join(data, 'times.jsonl'),
    HOME: home,
    USERPROFILE: home,
  };
  const run = (...args: string[]) => {
    const r = spawnSync(process.execPath, [QUEUE, ...args], { encoding: 'utf8', env, cwd: root });
    return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
  };
  const add = (t: object) => run('add', '--json', JSON.stringify(t));
  const tasks = () =>
    JSON.parse(fs.readFileSync(path.join(data, 'queue.json'), 'utf8')).tasks as Record<string, unknown>[];
  return { run, add, tasks };
}

describe('add and edit refuse a bad sources shape', () => {
  it('add refuses an absolute path and adds nothing', () => {
    const p = project();
    const r = p.add({ id: 'T-ABS', title: 'Abs', sources: [{ path: '/etc/passwd' }] });
    expect(r.code).not.toBe(0);
    expect(r.err + r.out).toContain('Nothing added');
    expect(r.err + r.out).toContain('sources /etc/passwd: must be relative to the project root');
    expect(p.tasks()).toEqual([]);
  });

  it('add accepts a valid entry and keeps it as given', () => {
    const p = project();
    const r = p.add({ id: 'T-OK', title: 'Ok', sources: [{ path: 'docs/plan.md', anchor: '§ 2', role: 'plan' }] });
    expect(r.code).toBe(0);
    expect(p.tasks().find((t) => t.id === 'T-OK')?.sources).toEqual([
      { path: 'docs/plan.md', anchor: '§ 2', role: 'plan' },
    ]);
  });

  it('edit replaces sources, refuses a bad shape without writing, and null removes the field', () => {
    const p = project();
    expect(p.add({ id: 'T-E', title: 'Edit me', sources: [{ path: 'docs/plan.md', anchor: '§ 1' }] }).code).toBe(0);
    const ok = p.run('edit', 'T-E', '--json', JSON.stringify({ sources: [{ path: 'docs/spec.md', role: 'spec' }] }));
    expect(ok.code).toBe(0);
    expect(p.tasks().find((t) => t.id === 'T-E')?.sources).toEqual([{ path: 'docs/spec.md', role: 'spec' }]);

    const bad = p.run('edit', 'T-E', '--json', JSON.stringify({ sources: [{ path: 'docs/spec.md', role: 'notes' }] }));
    expect(bad.code).not.toBe(0);
    expect(bad.err + bad.out).toContain('Invalid change');
    expect(bad.err + bad.out).toContain('unknown role notes');
    expect(p.tasks().find((t) => t.id === 'T-E')?.sources).toEqual([{ path: 'docs/spec.md', role: 'spec' }]);

    expect(p.run('edit', 'T-E', '--json', JSON.stringify({ sources: null })).code).toBe(0);
    expect(p.tasks().find((t) => t.id === 'T-E')).not.toHaveProperty('sources');
  });

  it('add and edit keep source as free text', () => {
    const p = project();
    expect(p.add({ id: 'T-S', title: 'Origin', source: 'review of AUTH-2, finding M1' }).code).toBe(0);
    expect(p.run('edit', 'T-S', '--json', JSON.stringify({ source: 'owner 18.11' })).code).toBe(0);
    expect(p.tasks().find((t) => t.id === 'T-S')?.source).toBe('owner 18.11');
  });
});
