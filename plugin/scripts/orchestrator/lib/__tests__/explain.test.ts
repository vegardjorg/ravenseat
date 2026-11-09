// =============================================================
// explain.test.ts: `ravenseat explain <ID>` (lib/logic/explain.js), why one task stands where it stands.
//
// Locks: the answer comes from the same rules the queue starts by (a dependency, an owner question and an uncommitted
// file block; full slots and the domain limit hold a ready task; a task fill would start says so), and a running task
// gets its last sign of life with the source and SILENT over the limit. The CLI prints the verdict and the lines.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const L = require('../queueLogic.js');
const EX = require('../logic/explain.js');

const NOW = Date.parse('2026-11-08T12:00:00.000Z');
const base = { domain: 'dom', class: 'K', value: 5, content_min: 30, depends_on: [], waiting_on: [], mission: 'x' };
const task = (id: string, over: Record<string, unknown> = {}) => ({ ...base, id, title: id, status: 'waiting', owned_files: [`${id}.txt`], ...over });
const queueOf = (tasks: object[], limits: object = {}) => ({ created: '2026-01-01T00:00:00.000Z', limits, resolved: [], tasks });
const explain = (q: object, id: string, o: Record<string, unknown> = {}) => EX.explainTask(q, id, { L, now: NOW, ...o });

describe('a waiting task', () => {
  it('a task fill would start says so', () => {
    const r = explain(queueOf([task('A')]), 'A');
    expect(r.verdict).toBe('ready: starts at the next fill');
  });

  it('a dependency and an owner question block it', () => {
    const q = queueOf([task('A', { depends_on: ['B'], waiting_on: ['Q1'] }), task('B')]);
    const r = explain(q, 'A');
    expect(r.verdict).toBe('blocked');
    expect(r.lines.join('\n')).toMatch(/B/);
    expect(r.lines.join('\n')).toMatch(/Q1/);
  });

  it('an uncommitted file it owns blocks it', () => {
    const r = explain(queueOf([task('A')]), 'A', { uncommitted: ['A.txt'] });
    expect(r.verdict).toBe('blocked');
    expect(r.lines.join('\n')).toContain('A.txt is uncommitted');
  });

  it('full slots hold it, with its place among the startable ones', () => {
    const q = queueOf(
      [task('R', { status: 'running', started: '2026-11-08T11:00:00.000Z', branch: 'queue/R' }), task('A', { value: 9 }), task('B', { value: 2 })],
      { maxConcurrent: 1 },
    );
    const r = explain(q, 'B');
    expect(r.verdict).toBe('waiting for a slot');
    expect(r.lines.join('\n')).toContain('All 1 slots are taken');
    expect(r.lines.join('\n')).toMatch(/Place 2 of 2/);
  });

  it('the domain limit holds it', () => {
    const q = queueOf([task('R', { status: 'running', started: '2026-11-08T11:00:00.000Z', branch: 'queue/R' }), task('A')], { maxPerDomain: 1 });
    expect(explain(q, 'A').lines.join('\n')).toContain('limit maxPerDomain 1');
  });

  it('an unknown task is null', () => {
    expect(explain(queueOf([]), 'X')).toBeNull();
  });
});

describe('a running task', () => {
  const q = queueOf([task('R', { status: 'running', started: '2026-11-08T10:00:00.000Z', branch: 'queue/R' })], { silentMin: 20 });

  it('the last sign of life with its source, and SILENT over the limit', () => {
    const r = explain(q, 'R', { activity: { ms: NOW - 45 * 60_000, source: 'transcript' } });
    expect(r.verdict).toBe('running');
    expect(r.lines.join('\n')).toContain('Started 2026-11-08T10:00:00.000Z (2 h ago)');
    expect(r.lines.join('\n')).toContain('transcript 45 min ago');
    expect(r.lines.join('\n')).toContain('SILENT');
  });

  it('a fresh sign of life is not SILENT', () => {
    const r = explain(q, 'R', { activity: { ms: NOW - 5 * 60_000, source: 'commit' } });
    expect(r.lines.join('\n')).not.toContain('SILENT');
  });
});

describe('the CLI', () => {
  const temporary: string[] = [];
  afterAll(() => {
    for (const f of temporary) fs.rmSync(f, { recursive: true, force: true });
  });
  it('ravenseat explain prints the verdict and the reasons, and --json the same as data', () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-explain-'));
    temporary.push(folder);
    fs.writeFileSync(path.join(folder, 'queue.json'), JSON.stringify(queueOf([task('A', { depends_on: ['B'] }), task('B')])));
    const configFile = path.join(folder, 'queue.config.json');
    fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'develop' }));
    const env = { ...process.env, QUEUE_FOLDER: folder, QUEUE_CONFIG: configFile, QUEUE_ROOT: folder, QUEUE_GIT: folder } as NodeJS.ProcessEnv;
    const QUEUE = path.resolve(__dirname, '..', '..', 'queue.mjs');
    const r = spawnSync(process.execPath, [QUEUE, 'explain', 'A'], { encoding: 'utf8', env, cwd: folder });
    expect(r.stdout).toContain('A (waiting): blocked');
    expect(r.stdout).toMatch(/Blocked: .*B/);
    const j = spawnSync(process.execPath, [QUEUE, 'explain', 'B', '--json'], { encoding: 'utf8', env, cwd: folder });
    expect(JSON.parse(j.stdout).verdict).toBe('ready: starts at the next fill');
  });
});
