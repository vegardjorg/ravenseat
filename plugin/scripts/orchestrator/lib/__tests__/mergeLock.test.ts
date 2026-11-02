// =============================================================
// mergeLock.test.ts: the rules of lib/mergeLock.js without a repo: when a merge lock is stale, taking and releasing
// it, the in-progress detection from the git markers, and which steps are left for --resume.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ML = require('../mergeLock.js');

const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cq-mergelock-'));
  temporary.push(d);
  return d;
};

const NOW = Date.parse('2026-11-02T12:00:00.000Z');

describe('staleReason', () => {
  const lock = (x: Record<string, unknown> = {}) => ({ pid: 42, host: 'here', started: new Date(NOW - 60_000).toISOString(), ...x });
  it('held: same host and the pid runs, younger than the age cap', () => {
    expect(ML.staleReason(lock(), { now: NOW, host: 'here', alive: () => true })).toBeNull();
  });
  it('stale: same host and the pid is gone', () => {
    expect(ML.staleReason(lock(), { now: NOW, host: 'here', alive: () => false })).toMatch(/process 42 on here is no longer running/);
  });
  it('another host: the pid cannot be checked, only the age decides', () => {
    expect(ML.staleReason(lock(), { now: NOW, host: 'there', alive: () => false })).toBeNull();
    const old = lock({ started: new Date(NOW - ML.MAX_AGE_MS - 1).toISOString() });
    expect(ML.staleReason(old, { now: NOW, host: 'there', alive: () => true })).toMatch(/older than 360 min/);
  });
  it('a reused pid does not hold a lock forever: too old is stale on this host too', () => {
    const old = lock({ started: new Date(NOW - ML.MAX_AGE_MS - 1).toISOString() });
    expect(ML.staleReason(old, { now: NOW, host: 'here', alive: () => true })).toMatch(/older than/);
  });
  it('an unreadable lock: stale only when the file is older than a minute (it may be being written)', () => {
    expect(ML.staleReason(null, { now: NOW, mtimeMs: NOW - 1000 })).toBeNull();
    expect(ML.staleReason(null, { now: NOW, mtimeMs: NOW - 120_000 })).toMatch(/cannot be read/);
  });
});

describe('acquire and release', () => {
  it('the first takes it, the second is refused with the holder, release only removes its own lock', () => {
    const d = tmp();
    const a = ML.acquire(d, { task: 'A', now: NOW, pid: 100, host: 'h', alive: () => true });
    expect(a.ok).toBe(true);
    const b = ML.acquire(d, { task: 'B', now: NOW, pid: 200, host: 'h', alive: () => true });
    expect(b).toMatchObject({ ok: false, holder: { task: 'A', pid: 100, host: 'h' } });
    // A foreign lock object is not released.
    expect(ML.release(d, { ...a.lock, pid: 999 })).toBe(false);
    expect(fs.existsSync(ML.lockFile(d))).toBe(true);
    expect(ML.release(d, a.lock)).toBe(true);
    expect(fs.existsSync(ML.lockFile(d))).toBe(false);
  });
  it('a stale lock is taken over and the old holder is reported', () => {
    const d = tmp();
    ML.acquire(d, { task: 'A', now: NOW, pid: 100, host: 'h', alive: () => true });
    const b = ML.acquire(d, { task: 'B', now: NOW, pid: 200, host: 'h', alive: (pid: number) => pid !== 100 });
    expect(b.ok).toBe(true);
    expect(b.tookOver).toMatchObject({ holder: { task: 'A', pid: 100 } });
    expect(JSON.parse(fs.readFileSync(ML.lockFile(d), 'utf8'))).toMatchObject({ task: 'B', pid: 200 });
    expect(fs.readdirSync(d).filter((f) => f.includes('stale'))).toEqual([]);
  });
  it('the message names the holder and the lock file', () => {
    const t = ML.heldMessage({ file: '/d/merge.lock', holder: { task: 'A', pid: 1, host: 'h', started: 'x', command: 'merge' }, cq: 'cq', id: 'B' });
    expect(t).toContain('merge A (pid 1 on h, started x)');
    expect(t).toContain('/d/merge.lock');
    expect(t).toContain('cq merge B again');
  });
});

describe('gitInProgress', () => {
  it('finds MERGE_HEAD with its sha, and the rebase folder', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 'MERGE_HEAD'), 'abc123\n');
    fs.mkdirSync(path.join(d, 'rebase-merge'));
    const found = ML.gitInProgress((name: string) => path.join(d, name));
    expect(found.map((x: { kind: string }) => x.kind)).toEqual(['merge', 'rebase']);
    expect(found[0].sha).toBe('abc123');
    const text = ML.inProgressMessage(found, { root: '/repo', id: 'B', cq: 'cq', branch: 'queue/B', branchTip: 'fff', branchOf: () => 'queue/A', taskOf: () => 'A' });
    expect(text).toContain('the tip of queue/A');
    expect(text).toContain('cq merge A --resume');
    expect(text).toContain('git merge --abort');
    expect(text).toContain('git rebase --abort');
    expect(text).toContain('Then run cq merge B again. Nothing was done.');
  });
  it('nothing in progress: an empty list', () => {
    const d = tmp();
    expect(ML.gitInProgress((name: string) => path.join(d, name))).toEqual([]);
  });
});

describe('the merge state', () => {
  it('remainingSteps never gives merge, and skips the done ones', () => {
    expect(ML.remainingSteps(['merge', 'migr-push', 'gates', 'done', 'fill'], ['merge', 'migr-push'])).toEqual(['gates', 'done', 'fill']);
    expect(ML.remainingSteps(['merge', 'gates', 'done'], [])).toEqual(['gates', 'done']);
  });
  it('markBefore adds the steps before the current one and keeps the earlier ones', () => {
    expect(ML.markBefore(['gates', 'done', 'fill'], ['merge'], 'done')).toEqual(['merge', 'gates']);
    expect(ML.markBefore(['gates', 'done'], ['merge'], null)).toEqual(['merge', 'gates', 'done']);
  });
  it('write, read and clear; another task id is not read', () => {
    const d = tmp();
    expect(ML.writeState(d, { task: 'A/1', steps_done: ['merge'] })).toBe(true);
    expect(path.basename(ML.stateFile(d, 'A/1'))).toBe('merge-state-A_1.json');
    expect(ML.readState(d, 'A/1')).toMatchObject({ task: 'A/1', steps_done: ['merge'] });
    expect(ML.readState(d, 'A_1')).toBeNull();
    ML.clearState(d, 'A/1');
    expect(ML.readState(d, 'A/1')).toBeNull();
  });
});
