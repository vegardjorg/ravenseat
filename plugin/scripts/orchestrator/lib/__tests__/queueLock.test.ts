// =============================================================
// queueLock.test.ts: the owner of the queue lock (lib/queueLock.js) and how cli/context.mjs uses it.
//
// Why: a holder that was slow or paused used to lose the lock after 60 s, kept going, published queue.json and removed
// the lock of the process that came after it. The behaviour tests are real child processes against a temporary data
// folder: they hold, die and wake up for real. Age comes from utimes on the lock folder, so nothing sleeps for 60 s, and
// QUEUE_LOCK_WAIT_MS shortens the 15 s wait of a waiter that is meant to give up.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { spawn, spawnSync, execFileSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const QL = require('../queueLock.js');
const PG = require('../pushGuard.js');

const ORCH = path.resolve(__dirname, '..', '..');
const QUEUE = path.join(ORCH, 'queue.mjs');
const temporary: string[] = [];
const children: ChildProcess[] = [];
afterAll(() => {
  for (const c of children) c.kill('SIGKILL');
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});

const HOST = os.hostname();
/** A pid that was real a moment ago and is gone now. */
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid;

// The child: takes the real withLock from cli/context.mjs and does what the scenario says. It waits on files, not time.
const CHILD = `
import fs from 'node:fs';
import path from 'node:path';
const context = await import(process.env.CONTEXT_URL);
const { withLock, read, write, writePlans, die, hasLock, LOCK } = context;
const dir = process.env.SIGNALS;
const scenario = process.env.SCENARIO;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sign = (name) => fs.writeFileSync(path.join(dir, name), String(process.pid));
const until = (name) => { while (!fs.existsSync(path.join(dir, name))) sleep(10); };
const publish = () => { const q = read(); q.writer = process.pid; write(q); };
const out = withLock(() => {
  if (scenario === 'once') { publish(); return 'published'; }
  sign('ready');
  if (scenario === 'kill') process.kill(process.pid, 'SIGKILL');
  until('go');
  if (scenario === 'publish') { publish(); return 'published'; }
  if (scenario === 'plans') { writePlans({ plans: [] }); return 'published'; }
  if (scenario === 'die') die('stopped on purpose', 3);
  if (scenario === 'raw-exit') { if (hasLock) fs.rmSync(LOCK, { recursive: true, force: true }); process.exit(4); }
  if (scenario === 'exit') process.exit(4);
  return 'returned';
});
console.log(out);
`;

// The racer: the library alone (faster to start than the whole CLI), so a race can be run many times. A folder as the
// critical section: mkdir fails if another racer is inside.
const RACER = `
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const QL = createRequire(import.meta.url)(process.env.LOCK_LIB);
const { LOCK_DIR: lock, GO: go, READY: ready, INSIDE: inside } = process.env;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
fs.writeFileSync(ready, '');
while (!fs.existsSync(go)) sleep(2);
const got = QL.acquire(lock, { waitMs: 10000 });
if (!got.ok) { console.log('TIMEOUT'); process.exit(0); }
try { fs.mkdirSync(inside); } catch { console.log('OVERLAP'); }
sleep(20);
try { fs.rmdirSync(inside); } catch { console.log('OVERLAP'); }
console.log(got.tookOver ? 'TOOK_OVER' : 'PLAIN');
QL.release(lock, got.me);
`;

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-lock-'));
  temporary.push(root);
  const data = path.join(root, 'data');
  const signals = path.join(root, 'signals');
  fs.mkdirSync(data);
  fs.mkdirSync(signals);
  const queueFile = path.join(data, 'queue.json');
  const start = `${JSON.stringify({ tasks: [], projects: {} }, null, 2)}\n`;
  fs.writeFileSync(queueFile, start);
  const configFile = path.join(root, 'queue.config.json');
  fs.writeFileSync(configFile, '{}');
  const childFile = path.join(root, 'child.mjs');
  fs.writeFileSync(childFile, CHILD);
  const env = {
    ...process.env,
    QUEUE_ROOT: root,
    QUEUE_FOLDER: data,
    QUEUE_CONFIG: configFile,
    QUEUE_GIT: root,
    SIGNALS: signals,
    CONTEXT_URL: pathToFileURL(path.join(ORCH, 'cli', 'context.mjs')).href,
  };
  const lock = path.join(data, '.lockState');
  const spawnChild = (scenario: string, extra: object = {}) => {
    const c = spawn(process.execPath, [childFile], { env: { ...env, SCENARIO: scenario, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(c);
    let out = '';
    let err = '';
    c.stdout!.on('data', (d) => (out += d));
    c.stderr!.on('data', (d) => (err += d));
    const done = new Promise<{ code: number | null; out: string; err: string; ms: number }>((resolve) => {
      const t0 = Date.now();
      c.on('close', (code) => resolve({ code, out, err, ms: Date.now() - t0 }));
    });
    return { child: c, done };
  };
  const signal = async (name: string) => {
    const f = path.join(signals, name);
    for (let i = 0; i < 3000 && !fs.existsSync(f); i++) await new Promise((r) => setTimeout(r, 10));
    expect(fs.existsSync(f), `signal ${name}`).toBe(true);
  };
  const go = () => fs.writeFileSync(path.join(signals, 'go'), '');
  /** Throws the holder's token out and puts another live owner's token in: what a takeover leaves behind. */
  const replaceToken = (generation = 2) => {
    for (const n of fs.readdirSync(lock)) fs.rmSync(path.join(lock, n));
    const other = QL.newOwner({ generation, pid: process.pid });
    fs.writeFileSync(path.join(lock, QL.tokenName(generation)), JSON.stringify(other));
    return QL.tokenName(generation);
  };
  const age = (seconds: number) => {
    const old = new Date(Date.now() - seconds * 1000);
    fs.utimesSync(lock, old, old);
  };
  const cq = (args: string[], o: { cwd?: string } = {}) => {
    const r = spawnSync(process.execPath, [QUEUE, ...args], { env, encoding: 'utf8', cwd: o.cwd ?? root });
    return { code: r.status, out: r.stdout ?? '', err: r.stderr ?? '' };
  };
  return { root, data, lock, queueFile, start, env, spawnChild, signal, go, replaceToken, age, cq };
}

describe('assessLock (the takeover rule)', () => {
  const owner = { pid: 42, nonce: 'n', hostname: 'here', started: '2026-11-03T10:00:00.000Z' };
  const alive = () => true;
  const dead = () => false;
  const rule = (o: object | null, ageMs: number, isAlive = alive, hostname = 'here') =>
    QL.assessLock({ owner: o, ageMs, hostname, isAlive });

  it('same host, dead pid: at once, even when the lock is seconds old', () => {
    expect(rule(owner, 10, dead)).toMatchObject({ action: 'take_over', holderAlive: false });
    expect(rule(owner, 10, dead).reason).toContain('42');
  });
  it('same host, live pid: never, whatever the age', () => {
    for (const ageMs of [0, 61_000, 7 * 24 * 3600_000]) expect(rule(owner, ageMs)).toMatchObject({ action: 'wait', holderAlive: true });
  });
  it('other host: the age rule, and it never asks about a pid it cannot see', () => {
    const never = () => {
      throw new Error('asked about a pid on another host');
    };
    expect(rule({ ...owner, hostname: 'there' }, 60_000, never).action).toBe('wait');
    expect(rule({ ...owner, hostname: 'there' }, 60_001, never).action).toBe('take_over');
  });
  it('no readable owner: the age rule', () => {
    for (const bad of [null, {}, { pid: 'x', hostname: 'here' }, { pid: 0, hostname: 'here' }, { pid: -1, hostname: 'here' }, { pid: 42 }, { pid: 1.5, hostname: 'here' }]) {
      expect(rule(bad, 60_000, dead).action).toBe('wait');
      expect(rule(bad, 60_001, dead).action).toBe('take_over');
    }
  });
});

describe('the small rules', () => {
  it('pidAlive: this process lives, a finished one does not, and EPERM counts as alive', () => {
    expect(QL.pidAlive(process.pid)).toBe(true);
    expect(QL.pidAlive(deadPid())).toBe(false);
    const real = process.kill;
    process.kill = (() => {
      throw Object.assign(new Error('x'), { code: 'EPERM' });
    }) as typeof process.kill;
    try {
      expect(QL.pidAlive(1234)).toBe(true);
    } finally {
      process.kill = real;
    }
  });
  it('QUEUE_LOCK_WAIT_MS can only shorten the wait', () => {
    expect(QL.waitMsFrom(undefined)).toBe(15_000);
    expect(QL.waitMsFrom('')).toBe(15_000);
    expect(QL.waitMsFrom('abc')).toBe(15_000);
    expect(QL.waitMsFrom('-1')).toBe(15_000);
    expect(QL.waitMsFrom('500')).toBe(500);
    expect(QL.waitMsFrom('999999')).toBe(15_000);
  });
  it('the message for a live holder names pid, age and how to release; the others say try again', () => {
    const state = { ageMs: 300_000, tokens: [{ owner: { pid: 42, hostname: 'h', started: 'then' } }], other: [] };
    const live = QL.heldMessage({ folder: '/d', cq: 'cq', state, verdict: { holderAlive: true }, waitedMs: 15_000 });
    expect(live).toMatch(/pid 42 on h/);
    expect(live).toMatch(/300 s/);
    expect(live).toContain('cq unlock --force --by owner');
    expect(QL.heldMessage({ folder: '/d', state: null })).toMatch(/Could not get the lock on \/d \(tried for 15 s\)\. Try again\./);
  });
});

describe('the atomic steps, without processes', () => {
  const folder = () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-lock-'));
    temporary.push(d);
    return path.join(d, '.lockState');
  };
  it('acquire writes a token with pid, nonce, hostname and start time; release leaves nothing', () => {
    const lock = folder();
    const got = QL.acquire(lock);
    expect(got.ok).toBe(true);
    expect(fs.readdirSync(lock)).toEqual(['owner-1.json']);
    const token = JSON.parse(fs.readFileSync(path.join(lock, 'owner-1.json'), 'utf8'));
    expect(token).toMatchObject({ pid: process.pid, hostname: HOST });
    expect(token.nonce).toMatch(/^[0-9a-f]{24}$/);
    expect(Date.parse(token.started)).not.toBeNaN();
    expect(QL.isHeld(lock, got.me)).toBe(true);
    expect(QL.release(lock, got.me)).toBe(true);
    expect(fs.existsSync(lock)).toBe(false);
    expect(fs.readdirSync(path.dirname(lock))).toEqual([]);
  });
  const putToken = (lock: string, owner: { generation: number }) =>
    fs.writeFileSync(path.join(lock, QL.tokenName(owner.generation)), JSON.stringify(owner));
  it('two waiters that judge the same stale generation: the second finds the name taken and removes nothing', () => {
    const lock = folder();
    const dead = deadPid();
    fs.mkdirSync(lock);
    putToken(lock, QL.newOwner({ pid: dead }));
    const state = QL.readState(lock);
    const a = QL.acquire(lock);
    expect(a.ok).toBe(true);
    expect(a.tookOver).toMatch(/gone/);
    expect(a.me.generation).toBe(2);
    expect(state.tokens[0].generation).toBe(1);
    // B, with the view from before A: owner-2 exists, so no write of B's can succeed.
    expect(() => fs.writeFileSync(path.join(lock, QL.tokenName(2)), 'x', { flag: 'wx' })).toThrow(/EEXIST/);
    expect(QL.isHeld(lock, a.me)).toBe(true);
    expect(fs.readdirSync(lock)).toEqual(['owner-2.json']);
  });
  it('a waiter with an old view placing into a lock taken since: backs off and leaves the holder, who keeps it', () => {
    const lock = folder();
    fs.mkdirSync(lock);
    // A saw generation 4 (dead), but the lock was released and taken again: the folder now holds C's generation 1.
    const c = QL.newOwner({ pid: process.pid });
    putToken(lock, c);
    const aView = { tokens: [{ name: 'owner-4.json', generation: 4, text: 'old', owner: null }], other: [] };
    const a = QL.newOwner({ generation: 5, pid: deadPid() });
    expect(QL.placeToken(lock, a, aView)).toBe(false);
    expect(fs.readdirSync(lock)).toEqual(['owner-1.json']);
    expect(QL.isHeld(lock, c)).toBe(true);
  });
  it('the same when the old view had the same name: the bytes differ, so it is another owner', () => {
    const lock = folder();
    fs.mkdirSync(lock);
    const c = QL.newOwner({ pid: process.pid });
    putToken(lock, c);
    const aView = { tokens: [{ name: 'owner-1.json', generation: 1, text: JSON.stringify(QL.newOwner({ pid: 1 })), owner: null }], other: [] };
    expect(QL.placeToken(lock, QL.newOwner({ generation: 2 }), aView)).toBe(false);
    expect(fs.readdirSync(lock)).toEqual(['owner-1.json']);
    expect(QL.isHeld(lock, c)).toBe(true);
  });
  it('a process that was paused between mkdir and its token finds the name taken, and the new holder stays', () => {
    const lock = folder();
    const y = QL.acquire(lock).me;
    expect(QL.placeToken(lock, QL.newOwner(), { tokens: [], other: [] })).toBe(false);
    expect(QL.isHeld(lock, y)).toBe(true);
  });
  it('a process placing a higher generation than a holder it never saw backs off; the holder is not disturbed', () => {
    const lock = folder();
    const y = QL.acquire(lock).me;
    expect(QL.placeToken(lock, QL.newOwner({ generation: 7 }), { tokens: [], other: [] })).toBe(false);
    expect(fs.readdirSync(lock)).toEqual(['owner-1.json']);
    expect(QL.isHeld(lock, y)).toBe(true);
  });
  it('a back-off leaves no empty folder behind for the others to wait 60 s on', () => {
    const lock = folder();
    fs.mkdirSync(lock);
    // Two placers that both found each other: the second one out removes the folder.
    const seen = { tokens: [{ name: 'owner-3.json', generation: 3, text: 'other', owner: null }], other: [] };
    fs.writeFileSync(path.join(lock, 'owner-3.json'), 'changed');
    expect(QL.placeToken(lock, QL.newOwner({ generation: 4 }), seen)).toBe(false);
    fs.rmSync(path.join(lock, 'owner-3.json'));
    expect(QL.placeToken(lock, QL.newOwner({ generation: 4 }), { tokens: [{ name: 'owner-3.json', generation: 3, text: 'x', owner: null }], other: [] })).toBe(true);
    expect(fs.readdirSync(lock)).toEqual(['owner-4.json']);
  });
  it('a holder that lost the lock removes nothing on release, whether the new token has another name or the same', () => {
    for (const generation of [2, 1]) {
      const lock = folder();
      const old = QL.acquire(lock).me;
      fs.rmSync(path.join(lock, QL.tokenName(old.generation)));
      const next = QL.newOwner({ generation });
      putToken(lock, next);
      expect(QL.isHeld(lock, old)).toBe(false);
      expect(QL.release(lock, old)).toBe(false);
      expect(QL.isHeld(lock, next)).toBe(true);
    }
  });
  it('rmdir is the last line: with a token in the folder it stays, whatever the releasing side believes', () => {
    const lock = folder();
    const me = QL.acquire(lock).me;
    const next = QL.newOwner({ generation: 2 });
    putToken(lock, next);
    expect(QL.release(lock, me)).toBe(true);
    expect(fs.existsSync(lock)).toBe(true);
    expect(QL.isHeld(lock, next)).toBe(true);
  });
  it('a live holder next to a leftover older token still waits', () => {
    const lock = folder();
    fs.mkdirSync(lock);
    putToken(lock, QL.newOwner({ pid: deadPid() }));
    putToken(lock, QL.newOwner({ generation: 2, pid: process.pid }));
    const late = QL.acquire(lock, { waitMs: 50 });
    expect(late.ok).toBe(false);
    expect(late.verdict.holderAlive).toBe(true);
    expect(fs.readdirSync(lock).sort()).toEqual(['owner-1.json', 'owner-2.json']);
  });
  it('an old lock folder without a token: waits while fresh, then taken by age; files in it do not block', () => {
    const lock = folder();
    fs.mkdirSync(lock);
    expect(QL.acquire(lock, { waitMs: 50 }).ok).toBe(false);
    expect(fs.existsSync(lock)).toBe(true);
    fs.writeFileSync(path.join(lock, 'left-over'), 'x');
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lock, old, old);
    const got = QL.acquire(lock, { waitMs: 2000 });
    expect(got.ok).toBe(true);
    expect(got.tookOver).toMatch(/older than 60 s/);
    expect(fs.existsSync(path.join(lock, 'left-over'))).toBe(false);
  });
  it('a token that cannot be read counts as no owner, and is taken only by age', () => {
    const lock = folder();
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, QL.tokenName(1)), '{"pid":');
    expect(QL.acquire(lock, { waitMs: 50 }).ok).toBe(false);
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lock, old, old);
    expect(QL.acquire(lock, { waitMs: 2000 }).me.generation).toBe(2);
    expect(fs.readdirSync(lock)).toEqual(['owner-2.json']);
  });
  it('another host: not taken while young, taken by age', () => {
    const lock = folder();
    const other = QL.newOwner({ pid: process.pid, hostname: 'another-machine' });
    fs.mkdirSync(lock);
    fs.writeFileSync(path.join(lock, QL.tokenName(other.generation)), JSON.stringify(other));
    expect(QL.acquire(lock, { waitMs: 50 }).ok).toBe(false);
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lock, old, old);
    expect(QL.acquire(lock, { waitMs: 2000 }).tookOver).toMatch(/another-machine/);
  });
});

describe('withLock with real processes', () => {
  it('a holder paused past 60 s while alive keeps the lock, the waiter errors clearly, and the holder can still publish', async () => {
    const p = project();
    const holder = p.spawnChild('publish');
    await p.signal('ready');
    const token = fs.readdirSync(p.lock);
    expect(token).toHaveLength(1);
    p.age(300);

    const waiter = await p.spawnChild('once', { QUEUE_LOCK_WAIT_MS: '400' }).done;
    expect(waiter.code).toBe(1);
    expect(waiter.err).toContain(`pid ${holder.child.pid} on ${HOST}`);
    expect(waiter.err).toMatch(/for (29\d|30\d) s now/);
    expect(waiter.err).toMatch(/unlock --force --by owner/);
    expect(waiter.out).toBe('');
    expect(fs.readdirSync(p.lock)).toEqual(token);
    expect(fs.readFileSync(p.queueFile, 'utf8')).toBe(p.start);

    p.go();
    const end = await holder.done;
    expect(end.code).toBe(0);
    expect(JSON.parse(fs.readFileSync(p.queueFile, 'utf8')).writer).toBe(holder.child.pid);
    expect(fs.existsSync(p.lock)).toBe(false);
  });

  it('a dead holder is taken over at once, with no waiting for the age', async () => {
    const p = project();
    const holder = p.spawnChild('kill');
    await p.signal('ready');
    await holder.done;
    expect(fs.readdirSync(p.lock)).toHaveLength(1); // nothing cleaned up after a kill
    expect(Date.now() - fs.statSync(p.lock).mtimeMs).toBeLessThan(60_000);

    // A wait of 0 ms: any wait for the holder would end in the error.
    const waiter = await p.spawnChild('once', { QUEUE_LOCK_WAIT_MS: '0' }).done;
    expect(waiter.err).toBe('');
    expect(waiter.code).toBe(0);
    expect(fs.existsSync(p.lock)).toBe(false);
  });

  it('a lock folder from before tokens: a fresh one is left alone, an old one is taken', async () => {
    const p = project();
    fs.mkdirSync(p.lock);
    const fresh = await p.spawnChild('once', { QUEUE_LOCK_WAIT_MS: '200' }).done;
    expect(fresh.code).toBe(1);
    expect(fresh.err).toMatch(/Could not get the lock/);
    expect(fs.existsSync(p.lock)).toBe(true);
    p.age(120);
    const old = await p.spawnChild('once', { QUEUE_LOCK_WAIT_MS: '2000' }).done;
    expect(old.code).toBe(0);
  });

  describe('a stale holder that wakes after losing the lock', () => {
    async function wakesUp(scenario: string, generation = 2) {
      const p = project();
      const holder = p.spawnChild(scenario);
      await p.signal('ready');
      const newToken = p.replaceToken(generation);
      p.go();
      const end = await holder.done;
      // The new holder's lock is as it was.
      expect(fs.readdirSync(p.lock)).toEqual([newToken]);
      return { p, end };
    }
    it('cannot publish queue.json, says why, and writes nothing, not even queue.json.prev', async () => {
      const { p, end } = await wakesUp('publish');
      expect(end.code).toBe(1);
      expect(end.err).toMatch(/Lost the lock/);
      expect(end.err).toMatch(/Nothing was written/);
      expect(end.out).not.toContain('published');
      expect(fs.readFileSync(p.queueFile, 'utf8')).toBe(p.start);
      expect(fs.existsSync(`${p.queueFile}.prev`)).toBe(false);
    });
    it('cannot publish the plan register either', async () => {
      const { p, end } = await wakesUp('plans');
      expect(end.code).toBe(1);
      expect(fs.existsSync(path.join(p.data, 'plans.json'))).toBe(false);
    });
    it('does not remove the new lock at the end of withLock, and warns', async () => {
      const { end } = await wakesUp('return');
      expect(end.code).toBe(0);
      expect(end.out).toContain('returned');
      expect(end.err).toMatch(/lost the lock/i);
    });
    it('does not remove the new lock through die', async () => {
      const { end } = await wakesUp('die');
      expect(end.code).toBe(3);
      expect(end.err).toContain('stopped on purpose');
    });
    it('does not remove it through the command modules\' own `if (hasLock) rmSync(LOCK)` before process.exit', async () => {
      const { end } = await wakesUp('raw-exit');
      expect(end.code).toBe(4);
    });
    it('does not remove it through a bare process.exit', async () => {
      const { end } = await wakesUp('exit');
      expect(end.code).toBe(4);
    });
    it('cannot publish when the new token has the same file name as its own: the nonce decides', async () => {
      const { p, end } = await wakesUp('publish', 1);
      expect(end.code).toBe(1);
      expect(fs.readFileSync(p.queueFile, 'utf8')).toBe(p.start);
    });
  });

  describe('a holder that still owns the lock', () => {
    async function ends(scenario: string, code: number) {
      const p = project();
      const holder = p.spawnChild(scenario);
      await p.signal('ready');
      p.go();
      expect((await holder.done).code).toBe(code);
      expect(fs.existsSync(p.lock)).toBe(false);
    }
    it('releases through die', () => ends('die', 3));
    it('releases through the modules\' own raw release before process.exit', () => ends('raw-exit', 4));
    it('releases through a bare process.exit', () => ends('exit', 4));
    it('releases when the function returns', () => ends('return', 0));
  });
});

describe('two or more waiters on a dead lock', () => {
  it('one wins the takeover and the critical sections never overlap, over repeated runs', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-lock-race-'));
    temporary.push(root);
    const racer = path.join(root, 'racer.mjs');
    fs.writeFileSync(racer, RACER);
    for (let round = 0; round < 10; round++) {
      const here = path.join(root, `r${round}`);
      fs.mkdirSync(here);
      const lock = path.join(here, '.lockState');
      const go = path.join(here, 'go');
      const runs = [0, 1, 2, 3].map((i) => {
        const ready = path.join(here, `ready${i}`);
        const c = spawn(
          process.execPath,
          [racer],
          {
            env: { ...process.env, LOCK_LIB: path.resolve(__dirname, '..', 'queueLock.js'), LOCK_DIR: lock, GO: go, READY: ready, INSIDE: path.join(here, 'inside') },
            stdio: ['ignore', 'pipe', 'inherit'],
          },
        );
        children.push(c);
        let out = '';
        c.stdout!.on('data', (d) => (out += d));
        return {
          ready,
          pid: c.pid,
          done: new Promise<string>((resolve) => c.on('close', () => resolve(out))),
        };
      });
      for (const r of runs) while (!fs.existsSync(r.ready)) await new Promise((res) => setTimeout(res, 2));
      // The dead pid is picked with the racers running: Windows reuses pids fast, and a dead pid that became one of the
      // racers reads as a live holder (the safe side of the rule, and a timeout here).
      let dead = deadPid();
      while (runs.some((r) => r.pid === dead)) dead = deadPid();
      const stale = QL.newOwner({ pid: dead });
      fs.mkdirSync(lock);
      fs.writeFileSync(path.join(lock, QL.tokenName(stale.generation)), JSON.stringify(stale));
      fs.writeFileSync(go, '');
      const lines = (await Promise.all(runs.map((r) => r.done))).flatMap((s) => s.trim().split(/\s+/));
      expect(lines.filter((l) => l === 'OVERLAP'), `round ${round}`).toEqual([]);
      expect(lines.filter((l) => l === 'TIMEOUT'), `round ${round}`).toEqual([]);
      expect(lines.filter((l) => l === 'TOOK_OVER'), `round ${round}: ${lines}`).toHaveLength(1);
      expect(lines.filter((l) => l === 'PLAIN'), `round ${round}: ${lines}`).toHaveLength(3);
      expect(fs.existsSync(lock), `round ${round}`).toBe(false);
    }
  });

  it('through the real withLock too: both finish, one after the other', async () => {
    const p = project();
    const holder = p.spawnChild('kill');
    await p.signal('ready');
    await holder.done;
    const [a, b] = await Promise.all([p.spawnChild('once').done, p.spawnChild('once').done]);
    expect([a.code, b.code, a.err, b.err]).toEqual([0, 0, '', '']);
    expect(fs.existsSync(p.lock)).toBe(false);
  });
});

describe('cq unlock', () => {
  it('without a lock: says so', () => {
    const p = project();
    const r = p.cq(['unlock']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/No lock held/);
  });
  it('without flags: prints the holder and leaves the lock', async () => {
    const p = project();
    const holder = p.spawnChild('return');
    await p.signal('ready');
    p.age(90);
    const before = fs.readdirSync(p.lock);
    const r = p.cq(['unlock']);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`pid ${holder.child.pid} on ${HOST}`);
    expect(r.out).toMatch(/alive/);
    expect(r.out).toMatch(/\b(89|9\d) s\b/);
    expect(r.out).toContain('--force --by owner');
    expect(fs.readdirSync(p.lock)).toEqual(before);
    p.go();
    await holder.done;
  });
  it('--force needs --by owner, and --by owner alone releases nothing', async () => {
    const p = project();
    const holder = p.spawnChild('return');
    await p.signal('ready');
    const before = fs.readdirSync(p.lock);
    for (const args of [['--force'], ['--force', '--by', 'agent'], ['--force', '--by']]) {
      const r = p.cq(['unlock', ...args]);
      expect(r.code, args.join(' ')).toBe(1);
      expect(r.err).toMatch(/--by owner/);
      expect(fs.readdirSync(p.lock)).toEqual(before);
    }
    expect(p.cq(['unlock', '--by', 'owner']).code).toBe(0);
    expect(fs.readdirSync(p.lock)).toEqual(before);
    p.go();
    await holder.done;
  });
  it('--force --by owner releases a live holder, who then cannot publish; the next command gets the lock', async () => {
    const p = project();
    const holder = p.spawnChild('publish');
    await p.signal('ready');
    const r = p.cq(['unlock', '--force', '--by', 'owner']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/Released/);
    expect(r.out).toMatch(/still running/);
    expect(fs.existsSync(p.lock)).toBe(false);
    p.go();
    const end = await holder.done;
    expect(end.code).toBe(1);
    expect(end.err).toMatch(/Lost the lock/);
    expect(fs.readFileSync(p.queueFile, 'utf8')).toBe(p.start);
    expect((await p.spawnChild('once').done).code).toBe(0);
  });
  it('releases an old lock folder without a token', () => {
    const p = project();
    fs.mkdirSync(p.lock);
    expect(p.cq(['unlock']).out).toMatch(/no readable owner/);
    expect(p.cq(['unlock', '--force', '--by', 'owner']).code).toBe(0);
    expect(fs.existsSync(p.lock)).toBe(false);
  });
  it('is refused from inside a track worktree, whatever --by says', () => {
    const p = project();
    fs.mkdirSync(p.lock);
    const tree = path.join(p.root, 'tree');
    fs.mkdirSync(tree);
    const g = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: tree, stdio: 'pipe' });
    g('init', '-q', '-b', 'queue/A-1');
    g('commit', '-q', '--allow-empty', '-m', 'start');
    const r = p.cq(['unlock', '--force', '--by', 'owner'], { cwd: tree });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/track worktree/);
    expect(fs.existsSync(p.lock)).toBe(true);
  });
  it('is denied to queue agents by the push guard, also just looking', () => {
    for (const command of ['cq unlock', 'cq unlock --force --by owner', 'node scripts/orchestrator/queue.mjs unlock --force --by owner']) {
      expect(PG.assess(command, { agentType: 'track', branch: 'queue/A-1', environment: null })?.decision, command).toBe('deny');
    }
  });
});
