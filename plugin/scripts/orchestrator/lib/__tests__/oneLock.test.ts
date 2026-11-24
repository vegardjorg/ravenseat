// =============================================================
// oneLock.test.ts: ONE lock implementation (LAGRING step 6, plans/lagring-gjennomgang-2026-11-24.md): lib/queueLock.js's
// generation rule now also holds the merge lock (lib/mergeLock.js), the waiter lock (cli/wait.mjs) and the run-key
// lock of the wait mode (lib/waitMode.js); lib/gateQueue.js keeps its multi-slot semaphore. Temporary folders and the
// memory backend only.
//
// Locks: queueLock on an injected fs (lockOn) keeps its rule (a live holder is never taken over, a dead one at once);
// a token carries extra fields (meta) without letting them replace pid, nonce or generation; staleAgeMs sets the
// other-host age; waitMs 0 is one try, also on a clock that does not move; a takeover reports the previous holder.
// The merge lock: one merge at a time with the holder in the refusal, a dead holder taken over and reported, a live
// one never (also past the old 6 h cap: the safe side), a leftover merge.lock file from before still respected while
// its pid lives and cleared when it is gone. The wait-mode key: two calls for one key start one run, and a finished
// run's key is taken by the next call without removing a fresh one (the stale rmSync race of wait.mjs:93 and
// waitMode.js:198).
// =============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const QL = require('../queueLock.js');
const ML = require('../mergeLock.js');
const W = require('../waitMode.js');
const { createMemory } = require('../store/memoryBackend.js');

const temporary: string[] = [];
afterAll(() => {
  for (const d of temporary) fs.rmSync(d, { recursive: true, force: true, maxRetries: 40, retryDelay: 100 }); // the wait-mode runner may still be ending
});
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'one-lock-'));
  temporary.push(d);
  return d;
};
const DEAD_PID = 2_000_000_001;
const NOW = Date.parse('2026-11-24T12:00:00.000Z');

describe('queueLock on an injected fs, with meta and staleAgeMs', () => {
  it('memory: a live holder is never taken over, a dead one at once, and the takeover names the previous holder', () => {
    const mem = createMemory();
    const dir = path.resolve('/mem-lock/.x');
    mem.fs.mkdirSync(path.dirname(dir), { recursive: true });
    const a = mem.io();
    const b = mem.io();
    const got = QL.lockOn(a).acquire(dir, { waitMs: 0, meta: { task: 'T-1', pid: 1, nonce: 'forged' } });
    expect(got.ok).toBe(true);
    expect(got.me.pid).toBe(a.pid); // meta never replaces the token's own fields
    expect(got.me.task).toBe('T-1');
    mem.advance(24 * 3600_000);
    expect(QL.lockOn(b).acquire(dir, { waitMs: 0 }).ok).toBe(false); // alive, a day old: still held
    mem.kill(a.pid);
    const taken = QL.lockOn(b).acquire(dir, { waitMs: 0 });
    expect(taken.ok).toBe(true);
    expect(taken.previous?.task).toBe('T-1');
    expect(QL.lockOn(b).release(dir, taken.me)).toBe(true);
    expect(mem.fs.existsSync(dir)).toBe(false);
  });

  it('waitMs 0 is one try, also with a clock that never moves (no endless loop)', () => {
    const d = path.join(tmp(), '.x');
    expect(QL.acquire(d, { pid: process.ppid, waitMs: 0 }).ok).toBe(true);
    let calls = 0;
    const frozen = () => {
      if (++calls > 1000) throw new Error('acquire looped');
      return NOW;
    };
    const r = QL.acquire(d, { waitMs: 0, now: frozen });
    expect(r.ok).toBe(false);
    expect(calls).toBeLessThan(10);
  });

  it('staleAgeMs sets the age after which a holder on another host is taken over', () => {
    const owner = { pid: 5, hostname: 'elsewhere' };
    const at = (ageMs: number, staleAgeMs?: number) => QL.assessLock({ owner, ageMs, hostname: 'here', isAlive: () => true, staleAgeMs }).action;
    expect(at(QL.STALE_AGE_MS + 1)).toBe('take_over');
    expect(at(QL.STALE_AGE_MS + 1, ML.MAX_AGE_MS)).toBe('wait');
    expect(at(ML.MAX_AGE_MS + 1, ML.MAX_AGE_MS)).toBe('take_over');
  });
});

describe('the merge lock on queueLock', () => {
  it('one merge at a time; the refusal names the holder; release only by the holder', () => {
    const d = tmp();
    const a = ML.acquire(d, { task: 'A', pid: process.ppid });
    expect(a.ok).toBe(true);
    const b = ML.acquire(d, { task: 'B' });
    expect(b).toMatchObject({ ok: false, holder: { task: 'A', pid: process.ppid, command: 'merge' } });
    expect(ML.heldMessage({ file: b.file, holder: b.holder, id: 'B' })).toContain('merge A (pid');
    expect(ML.release(d, { ...a.lock, nonce: 'not-mine' })).toBe(false);
    expect(ML.release(d, a.lock)).toBe(true);
    expect(ML.acquire(d, { task: 'B' }).ok).toBe(true);
  });

  it('a dead holder is taken over and reported; a live one is never, also past the old 6 h cap', () => {
    const d = tmp();
    expect(ML.acquire(d, { task: 'A', pid: DEAD_PID }).ok).toBe(true);
    const b = ML.acquire(d, { task: 'B' });
    expect(b.ok).toBe(true);
    expect(b.tookOver).toMatchObject({ holder: { task: 'A', pid: DEAD_PID } });
    ML.release(d, b.lock);
    const old = ML.acquire(d, { task: 'C', pid: process.ppid, now: NOW - ML.MAX_AGE_MS - 60_000 });
    expect(old.ok).toBe(true);
    expect(ML.acquire(d, { task: 'D', now: NOW }).ok).toBe(false);
  });

  it('a leftover merge.lock file from an older version: respected while its pid lives, cleared when it is gone', () => {
    const d = tmp();
    const legacy = path.join(d, 'merge.lock');
    fs.writeFileSync(legacy, JSON.stringify({ pid: process.ppid, host: os.hostname(), started: new Date().toISOString(), task: 'OLD', command: 'merge' }));
    expect(ML.acquire(d, { task: 'B' })).toMatchObject({ ok: false, holder: { task: 'OLD' } });
    fs.writeFileSync(legacy, JSON.stringify({ pid: DEAD_PID, host: os.hostname(), started: new Date().toISOString(), task: 'OLD' }));
    const got = ML.acquire(d, { task: 'B' });
    expect(got.ok).toBe(true);
    expect(fs.existsSync(legacy)).toBe(false);
  });
});

describe('the wait-mode run key on queueLock', () => {
  it('two calls for one key start one run; a finished run frees the key for the next call', () => {
    const folder = path.join(tmp(), 'runs');
    const start = () =>
      W.startOrAttach({
        folder,
        command: 'gates',
        args: [],
        key: 'k1',
        what: 'gates',
        childArgv: ['-e', 'setTimeout(() => {}, 600)'],
        cwd: os.tmpdir(),
        hardSec: 30,
      });
    fs.mkdirSync(folder, { recursive: true });
    const one = start();
    const two = start();
    expect(one.attached).toBe(false);
    expect(two).toMatchObject({ attached: true, id: one.id });
    // The run ends: its done file is there. The next call starts a new run and never sees the old id.
    fs.writeFileSync(path.join(folder, `${one.id}.done.json`), JSON.stringify({ exit: 0 }));
    const three = start();
    expect(three.attached).toBe(false);
    expect(three.id).not.toBe(one.id);
    expect(start()).toMatchObject({ attached: true, id: three.id });
  });
});
