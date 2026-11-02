// =============================================================
// queueStateSafety.test.ts: the safe write of queue.json (lib/stateFile.js, cli/context.mjs write and read).
//
// Why: queue.json is the queue. Locks that each write keeps the previous GOOD state as queue.json.prev (a broken file
// never overwrites the good copy), that a rename refused for a moment on Windows (EPERM, EBUSY, EACCES) is retried
// with a short backoff while other errors are not, and that a queue.json that does not parse stops the CLI with the
// way back through queue.json.prev, in the command and in `cq doctor`. Temporary folders only.
// =============================================================
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { keepPrevious, recoveryHint, renameWithRetry, writeState } from '../stateFile';

const QUEUE = path.resolve(__dirname, '..', '..', 'queue.mjs');
const temporary: string[] = [];
afterAll(() => {
  for (const d of temporary) fs.rmSync(d, { recursive: true, force: true });
});
const tmpDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-state-'));
  temporary.push(d);
  return d;
};
const err = (code: string) => Object.assign(new Error(code), { code });

describe('renameWithRetry', () => {
  it('retries EPERM, EBUSY and EACCES with a growing wait, then succeeds', () => {
    let calls = 0;
    const waits: number[] = [];
    const fake = {
      renameSync: () => {
        calls++;
        if (calls === 1) throw err('EPERM');
        if (calls === 2) throw err('EBUSY');
        if (calls === 3) throw err('EACCES');
      },
    };
    expect(renameWithRetry('a', 'b', { fs: fake, sleep: (ms) => waits.push(ms) })).toBe(4);
    expect(waits).toEqual([25, 50, 100]);
  });

  it('gives up after the last try, and never retries another error', () => {
    let calls = 0;
    const always = { renameSync: () => (calls++, (() => { throw err('EPERM'); })()) };
    expect(() => renameWithRetry('a', 'b', { fs: always, tries: 3, sleep: () => {} })).toThrow('EPERM');
    expect(calls).toBe(3);
    calls = 0;
    const other = { renameSync: () => (calls++, (() => { throw err('ENOENT'); })()) };
    expect(() => renameWithRetry('a', 'b', { fs: other, sleep: () => {} })).toThrow('ENOENT');
    expect(calls).toBe(1);
  });
});

describe('writeState and queue.json.prev', () => {
  it('each write keeps the previous good state; a broken file never replaces the good copy', () => {
    const file = path.join(tmpDir(), 'queue.json');
    writeState(file, '{"tasks":[],"n":1}\n');
    expect(fs.existsSync(`${file}.prev`)).toBe(false);
    writeState(file, '{"tasks":[],"n":2}\n');
    expect(JSON.parse(fs.readFileSync(`${file}.prev`, 'utf8')).n).toBe(1);
    fs.writeFileSync(file, '{"tasks": [');
    expect(keepPrevious(file)).toBe(false);
    writeState(file, '{"tasks":[],"n":3}\n');
    expect(JSON.parse(fs.readFileSync(`${file}.prev`, 'utf8')).n).toBe(1);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).n).toBe(3);
    // No temporary files are left.
    expect(fs.readdirSync(path.dirname(file)).sort()).toEqual(['queue.json', 'queue.json.prev']);
  });

  it('recoveryHint names the good copy with its task count, or null without one', () => {
    const file = path.join(tmpDir(), 'queue.json');
    expect(recoveryHint(file)).toBeNull();
    fs.writeFileSync(`${file}.prev`, '{"tasks":[{"id":"A-1"}],"changed":"2026-11-02T10:00:00.000Z"}');
    const h = recoveryHint(file);
    expect(h).toContain(`${file}.prev`);
    expect(h).toMatch(/1 task\(s\), changed 2026-11-02T10:00:00\.000Z/);
    expect(h).toMatch(/Copy-Item/);
  });
});

describe('the CLI on a real data folder', () => {
  const setup = () => {
    const root = tmpDir();
    const data = path.join(root, 'q');
    const env = {
      ...process.env,
      QUEUE_ROOT: root,
      QUEUE_FOLDER: data,
      QUEUE_CONFIG: path.join(root, 'queue.config.json'),
      QUEUE_GIT: root,
      QUEUE_TIME_LOG: path.join(data, 'times.jsonl'),
      QUEUE_HOOKS: path.join(root, 'no-hooks.json'),
      DISABLE_UPDATES: '1',
    };
    const run = (...args: string[]) => {
      const r = spawnSync(process.execPath, [QUEUE, ...args], { encoding: 'utf8', env, cwd: root, timeout: 60_000 });
      return { code: r.status, out: r.stdout ?? '', error: r.stderr ?? '' };
    };
    return { data, run };
  };

  it('a write leaves queue.json.prev; a broken queue.json stops with the way back, in the command and in doctor', () => {
    const p = setup();
    expect(p.run('init', '--lite').code).toBe(0);
    const a = p.run('add', 'First task');
    expect(a.code, a.error).toBe(0);
    const file = path.join(p.data, 'queue.json');
    const prev = JSON.parse(fs.readFileSync(`${file}.prev`, 'utf8'));
    expect(Array.isArray(prev.tasks)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).tasks.length).toBe(prev.tasks.length + 1);

    fs.writeFileSync(file, '{"tasks": [');
    const show = p.run('show');
    expect(show.code).toBe(1);
    expect(show.error).toMatch(/queue\.json does not parse/);
    expect(show.error).toContain(`${file}.prev holds the previous good state`);
    const d = p.run('doctor');
    expect(d.out).toMatch(/^FAIL {2}queue {6}queue\.json does not parse/m);
    expect(d.out).toContain('queue.json.prev holds the previous good state');
  }, 60_000);
});
