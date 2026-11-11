// =============================================================
// readsOwnership.test.ts: read ownership (`reads`, logic/conflicts.js), a task that reads a file another active task
// is changing.
//
// Why: two tasks queued hours apart can end up in code that sits close together without a text conflict: B builds on
// a file A is rewriting, and B sees the old version. `owned_files` only says what a task writes. `reads` says what it
// builds on, so B waits until A is done (the default), or starts with a warning (`reads.mode: "warn"`). It works both
// ways: a task that would change a file an active task reads waits too. Two readers never block each other.
// =============================================================
import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const L = require('../queueLogic.js');
const B = require('../logic/base.js');
const EX = require('../logic/explain.js');
const V = require('../logic/validate.js');
const C = require('../queueConfig.js');

const NOW = Date.parse('2026-11-11T12:00:00.000Z');
const base = { domain: 'dom', class: 'K', value: 5, content_min: 30, depends_on: [], waiting_on: [], mission: 'x' };
const task = (id: string, over: Record<string, unknown> = {}) => ({ ...base, id, title: id, status: 'waiting', owned_files: [`${id}.txt`], ...over });
const running = (id: string, over: Record<string, unknown> = {}) =>
  task(id, { status: 'running', started: '2026-11-11T11:00:00.000Z', branch: `queue/${id}`, ...over });
const queueOf = (tasks: object[]) => ({ created: '2026-01-01T00:00:00.000Z', limits: {}, resolved: [], tasks });

const oldConfig = process.env.QUEUE_CONFIG;
function withConfig(cfg: object) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reads-cfg-'));
  const file = path.join(dir, 'queue.config.json');
  fs.writeFileSync(file, JSON.stringify(cfg));
  process.env.QUEUE_CONFIG = file;
  // Both caches: queueConfig's own buffer and the logic's copy (base.js).
  C.config({ fresh: true });
  B.resetConfig();
}
afterEach(() => {
  if (oldConfig == null) delete process.env.QUEUE_CONFIG;
  else process.env.QUEUE_CONFIG = oldConfig;
  C.config({ fresh: true });
  B.resetConfig();
});

describe('reads: a task that reads a file an active task changes waits (the default)', () => {
  it('B reads a file A owns and is changing: B is blocked, named after A and the file', () => {
    const tasks = [running('A', { owned_files: ['src/api.ts'] }), task('B', { reads: ['src/api.ts'] })];
    const h = L.blockers(tasks[1], tasks, []);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatch(/reads src\/api\.ts, which A is changing/);
    const part = L.blockerParts(tasks[1], tasks, []).find((x: { type: string }) => x.type === 'conflict');
    expect(part.conflict).toMatchObject({ type: 'reads', name: 'src/api.ts', with: 'A' });
  });

  it('folders count both ways, and backslashes are the same path', () => {
    const a = [running('A', { owned_files: ['src/'] }), task('B', { reads: ['src\\api.ts'] })];
    expect(L.blockers(a[1], a, [])).toHaveLength(1);
    const b = [running('A', { owned_files: ['src/api.ts'] }), task('B', { reads: ['src/'] })];
    expect(L.blockers(b[1], b, [])).toHaveLength(1);
  });

  it('the other way: a task that would change a file an active task reads waits too', () => {
    const tasks = [running('A', { reads: ['src/api.ts'] }), task('B', { owned_files: ['src/api.ts'] })];
    const h = L.blockers(tasks[1], tasks, []);
    expect(h).toHaveLength(1);
    expect(h[0]).toMatch(/A reads src\/api\.ts, which this task would change/);
  });

  it('two readers never block each other, and a done owner does not count', () => {
    const readers = [running('A', { reads: ['src/api.ts'] }), task('B', { reads: ['src/api.ts'] })];
    expect(L.blockers(readers[1], readers, [])).toEqual([]);
    const done = [task('A', { status: 'done', owned_files: ['src/api.ts'] }), task('B', { reads: ['src/api.ts'] })];
    expect(L.blockers(done[1], done, [])).toEqual([]);
  });

  it('selectNext never starts a reader and the owner of the same file in one round', () => {
    const q = queueOf([task('A', { owned_files: ['src/api.ts'], value: 9 }), task('B', { reads: ['src/api.ts'], value: 8 })]);
    expect(L.selectNext(q, NOW).map((x: { id: string }) => x.id)).toEqual(['A']);
  });

  it('explain says why', () => {
    const q = queueOf([running('A', { owned_files: ['src/api.ts'] }), task('B', { reads: ['src/api.ts'] })]);
    const r = EX.explainTask(q, 'B', { L, now: NOW });
    expect(r.verdict).toBe('blocked');
    expect(r.lines.join('\n')).toMatch(/reads src\/api\.ts, which A is changing/);
  });
});

describe('reads.mode "warn": the reader starts, with the overlap named', () => {
  it('no blocker, but readsOverlaps names the file and the owner, and explain says it', () => {
    withConfig({ reads: { mode: 'warn' } });
    const tasks = [running('A', { owned_files: ['src/api.ts'] }), task('B', { reads: ['src/api.ts'] })];
    expect(L.blockers(tasks[1], tasks, [])).toEqual([]);
    expect(L.readsOverlaps(tasks[1], tasks)).toEqual([expect.objectContaining({ type: 'reads', name: 'src/api.ts', with: 'A' })]);
    const r = EX.explainTask(queueOf(tasks), 'B', { L, now: NOW });
    expect(r.lines.join('\n')).toMatch(/Reads: .*src\/api\.ts.*A.*reads\.mode warn/);
  });

  it('the mission says which read file is being changed, and lists the reads', () => {
    withConfig({ reads: { mode: 'warn' } });
    const tasks = [running('A', { owned_files: ['src/api.ts'] }), task('B', { reads: ['src/api.ts', 'lib/'] })];
    const block = L.trackBlock(tasks[1], queueOf(tasks), { text: 'the mission' });
    expect(block).toMatch(/\*\*Reads \(not owned\):\*\* src\/api\.ts, lib\//);
    expect(block).toMatch(/src\/api\.ts is being changed by A/);
  });
});

describe('the field', () => {
  it('must be a list', () => {
    expect(V.validate(task('X', { reads: 'src/api.ts' }), [])).toContain('reads must be a list');
    expect(V.validate(task('X', { reads: ['src/api.ts'] }), [])).toEqual([]);
  });

  it('a task without reads gets no Reads line in its mission', () => {
    const tasks = [task('B')];
    expect(L.trackBlock(tasks[0], queueOf(tasks), { text: 'm' })).not.toMatch(/Reads/);
  });
});

describe('config and batch', () => {
  it('doctor names a reads.mode that is neither wait nor warn', async () => {
    const D = await import('../../cli/doctor.mjs');
    expect(D.baselineProblems({ reads: { mode: 'stop' } })).toContain('reads.mode must be "wait" or "warn"');
    expect(D.baselineProblems({ reads: { mode: 'warn' } })).toEqual([]);
  });

  it('a packed batch track reads what its parts read, and a batch without reads gets no field', () => {
    const q = { ...queueOf([task('P1', { reads: ['a.ts'] }), task('P2', { reads: ['a.ts', 'b/'] }), task('P3'), task('P4')]), projects: {} };
    const r = L.batchPack(q, ['P1', 'P2'], { newId: 'PB', mission: 'x.md' });
    expect(r.error).toEqual([]);
    expect(r.new.reads).toEqual(['a.ts', 'b/']);
    const n = L.batchPack(q, ['P3', 'P4'], { newId: 'PC', mission: 'x.md' });
    expect(n.new).not.toHaveProperty('reads');
  });
});
