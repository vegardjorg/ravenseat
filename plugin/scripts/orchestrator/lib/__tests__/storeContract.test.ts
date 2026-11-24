// =============================================================
// storeContract.test.ts: ONE contract for the storage layer, run against both backends (LAGRING step 4,
// plans/lagring-gjennomgang-2026-11-24.md: "one contract suite runs on both (later on a DB backend)").
//
//   file    the real FileBackend on a temporary folder (never the repo's data folder)
//   memory  lib/store/memoryBackend.js: the same Store, FileBackend and queueLock code on an in-memory fs, a virtual
//           clock and simulated pids
//
// Locks, on both: a round trip and the family's empty value; plans.json keeps .prev and a broken one stops with the
// restore hint; a broken id-reservations file never hands an id out twice; nextId reserves (a deleted id stays used,
// atLeast is honoured); a failed write leaves the old file and no tmp file; the store lock is never taken from a live
// holder and is taken over from a dead one; scan and sweepTmp find an orphaned tmp file and spare a live one.
// Memory only (the deterministic scheduler puts one "process" exactly inside another's write): two nextId calls never
// share an id, two updates never lose one another's record (the race tests of storeFlow.test.ts, ported), and a
// write cut at the rename leaves the old value.
// =============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const ST = require('../store/index.js');
const FB = require('../store/fileBackend.js');
const QL = require('../queueLock.js');
const { createMemory } = require('../store/memoryBackend.js');

const DEAD_PID = 2_000_000_001;
const temporary: string[] = [];
afterAll(() => {
  for (const d of temporary) fs.rmSync(d, { recursive: true, force: true });
});

type Env = {
  name: string;
  folder: string;
  /** A store as one process (the default one). */
  store: (o?: object) => any;
  /** A store whose rename of a path matching `re` fails once with `code`. */
  failingStore: (re: RegExp, code: string) => any;
  /** Plants the store lock as held by a live (true) or dead (false) other process. */
  holdLock: (live: boolean) => void;
  read: (rel: string) => string | null;
  write: (rel: string, text: string, ageMs?: number) => void;
  list: () => string[];
};

function fileEnv(): Env {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'store-contract-'));
  temporary.push(folder);
  const abs = (rel: string) => path.join(folder, ...rel.split('/'));
  return {
    name: 'file',
    folder,
    store: (o = {}) => ST.openStore({ folder, lockWaitMs: 0, ...o }),
    failingStore: (re, code) => {
      let left = 1;
      const f = {
        ...fs,
        renameSync: (a: string, b: string) => {
          if (left > 0 && re.test(b.replace(/\\/g, '/'))) {
            left--;
            throw Object.assign(new Error(`${code}: injected`), { code });
          }
          return fs.renameSync(a, b);
        },
      };
      return ST.openStore({ folder, lockWaitMs: 0, io: { fs: f } });
    },
    holdLock: (live) => {
      // process.ppid is the worker's parent: alive for as long as this test runs.
      const got = QL.acquire(path.join(folder, ST.LOCK_DIR), { pid: live ? process.ppid : DEAD_PID, waitMs: 0 });
      expect(got.ok).toBe(true);
    },
    read: (rel) => {
      try {
        return fs.readFileSync(abs(rel), 'utf8');
      } catch {
        return null;
      }
    },
    write: (rel, text, ageMs = 0) => {
      fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
      fs.writeFileSync(abs(rel), text);
      if (ageMs) {
        const t = (Date.now() - ageMs) / 1000;
        fs.utimesSync(abs(rel), t, t);
      }
    },
    list: () => fs.readdirSync(folder).sort(),
  };
}

function memoryEnv(): Env & { mem: any } {
  const mem = createMemory();
  const folder = path.resolve('/mem-store/data');
  mem.fs.mkdirSync(folder, { recursive: true });
  const main = mem.io();
  const abs = (rel: string) => path.join(folder, ...rel.split('/'));
  return {
    name: 'memory',
    mem,
    folder,
    store: (o: any = {}) => ST.openStore({ folder, lockWaitMs: 0, io: o.io ?? main, ...o }),
    failingStore: (re, code) => {
      // The rename's source is the tmp file next to the target: match on the target's name with the tmp suffix.
      mem.fault({ op: 'rename', match: (p: string) => re.test(p.replace(/\\/g, '/').replace(/\.\d+\.[0-9a-f]{12}\.tmp$/, '')), code });
      return ST.openStore({ folder, lockWaitMs: 0, io: main });
    },
    holdLock: (live) => {
      const other = mem.io();
      if (!live) mem.kill(other.pid);
      const got = QL.lockOn(other).acquire(path.join(folder, ST.LOCK_DIR), { waitMs: 0 });
      expect(got.ok).toBe(true);
    },
    read: (rel) => mem.text(abs(rel)),
    write: (rel, text, ageMs = 0) => {
      mem.fs.mkdirSync(path.dirname(abs(rel)), { recursive: true });
      if (ageMs) {
        // Written "ageMs ago" on the virtual clock: write now, then move the clock on.
        mem.fs.writeFileSync(abs(rel), text);
        mem.advance(ageMs);
      } else mem.fs.writeFileSync(abs(rel), text);
    },
    list: () => mem.fs.readdirSync(folder).sort(),
  };
}

const tmpLeft = (env: Env) => env.list().filter((n) => n.endsWith('.tmp'));

describe.each([['file', fileEnv], ['memory', memoryEnv]] as const)('store contract (%s backend)', (_name, make) => {
  it('round trip; a missing family reads as its empty value', () => {
    const env = make();
    const st = env.store();
    expect(st.readJson('ledger')).toEqual({ version: 1, decisions: {} });
    st.writeJson('ledger', { version: 1, decisions: { 'D-0001': { by: 'owner' } } });
    expect(st.readJson('ledger').decisions['D-0001'].by).toBe('owner');
    expect(JSON.parse(env.read('catalog-accepted.json')!).version).toBe(1);
  });

  it('plans.json keeps .prev; a broken plans.json stops with the restore hint', () => {
    const env = make();
    const st = env.store();
    st.writeJson('plans', { entries: [{ id: 'PL-1' }] });
    st.writeJson('plans', { entries: [{ id: 'PL-1' }, { id: 'PL-2' }] });
    expect(JSON.parse(env.read('plans.json.prev')!).entries.length).toBe(1);
    env.write('plans.json', '{"entries": [');
    let err: any = null;
    try {
      st.readJson('plans', { describe: (j: any) => `${j.entries.length} plan(s)` });
    } catch (e) {
      err = e;
    }
    expect(err?.code).toBe('ESTORECORRUPT');
    expect(String(err.message)).toMatch(/plans\.json\.prev holds the previous good state \(1 plan\(s\)/);
    // A broken file is never copied over the last good copy.
    st.writeJson('plans', { entries: [] });
    expect(JSON.parse(env.read('plans.json.prev')!).entries.length).toBe(1);
  });

  it('nextId reserves: sequential, a deleted record never frees its id, atLeast is honoured', () => {
    const env = make();
    const st = env.store();
    expect(st.nextId('D')).toBe('D-0001');
    expect(st.nextId('D')).toBe('D-0002');
    // The caller's own data says 0001 is the highest (0002 was deleted): the reservation still gives 0003.
    expect(st.nextId('D', { atLeast: 2 })).toBe('D-0003');
    expect(st.nextId('D', { atLeast: 10 })).toBe('D-0010');
    expect(st.nextId('G')).toBe('G-1');
  });

  it('a broken reservation file falls back to .prev one higher: never the same id twice', () => {
    const env = make();
    const st = env.store();
    st.nextId('D');
    st.nextId('D'); // the file says 2, .prev says 1
    env.write('id-reservations.json', '{"ids": {');
    const errors: string[] = [];
    const orig = console.error;
    console.error = (m: string) => errors.push(String(m));
    try {
      expect(st.nextId('D')).toBe('D-0003');
    } finally {
      console.error = orig;
    }
    expect(errors.join('\n')).toMatch(/does not parse/);
  });

  it('a write that fails at the rename keeps the old file and leaves no tmp file', () => {
    const env = make();
    env.store().writeJson('ledger', { version: 1, decisions: { old: {} } });
    const st = env.failingStore(/catalog-accepted\.json$/, 'ENOSPC');
    expect(() => st.writeJson('ledger', { version: 1, decisions: { new: {} } })).toThrow(/ENOSPC/);
    expect(Object.keys(JSON.parse(env.read('catalog-accepted.json')!).decisions)).toEqual(['old']);
    expect(tmpLeft(env)).toEqual([]);
  });

  it('the store lock: never taken from a live holder, taken over from a dead one', () => {
    const live = make();
    live.holdLock(true);
    expect(() => live.store().nextId('D')).toThrow(/store lock/);
    const dead = make();
    dead.holdLock(false);
    expect(dead.store().nextId('D')).toBe('D-0001');
  });

  it('withLock is re-entrant in one process (nextId inside update)', () => {
    const env = make();
    const st = env.store();
    const out = st.update('ledger', (v: any) => ({ ...v, decisions: { [st.nextId('D')]: {} } }));
    expect(Object.keys(out.decisions)).toEqual(['D-0001']);
  });

  it('scan and sweepTmp: an orphaned tmp file is listed and removed, a fresh one is spared, nothing else is touched', () => {
    const env = make();
    env.write(`plans.json.${DEAD_PID}.tmp`, '{"half', 3 * 3600_000);
    env.write('my-notes.txt', 'x');
    env.write(`ledger-like.json.${DEAD_PID}.tmp`, '{"fresh'); // young: a write may still be going on
    const st = env.store();
    const s = st.scan();
    expect(s.unknown.map((u: any) => u.name)).toContain('my-notes.txt');
    expect(s.orphanTmp.map((t: any) => t.rel)).toEqual([`plans.json.${DEAD_PID}.tmp`]);
    expect(st.sweepTmp({ dry: true }).removed).toEqual([]);
    expect(env.read(`plans.json.${DEAD_PID}.tmp`)).not.toBeNull();
    expect(st.sweepTmp({ dry: false }).removed.length).toBe(1);
    expect(env.read(`plans.json.${DEAD_PID}.tmp`)).toBeNull();
    expect(env.read(`ledger-like.json.${DEAD_PID}.tmp`)).not.toBeNull();
    expect(env.read('my-notes.txt')).toBe('x');
  });
});

describe('memory backend: races, exactly', () => {
  it('a second process inside the first one\'s reservation write cannot get an id until the first is done; no id is shared', () => {
    const env = memoryEnv();
    const a = env.store();
    const bIo = env.mem.io();
    const b = env.store({ io: bIo });
    let inside: any = null;
    env.mem.before({ op: 'rename', match: /id-reservations\.json\.\d+\.[0-9a-f]+\.tmp$/ }, () => {
      try {
        inside = b.nextId('D');
      } catch (e) {
        inside = e;
      }
    });
    expect(a.nextId('D')).toBe('D-0001');
    expect(String(inside?.message ?? inside)).toMatch(/store lock/); // B waited (virtual clock) and gave up, A held it
    expect(b.nextId('D')).toBe('D-0002');
  });

  it('two updates never lose one another\'s record (the concurrent accept race, ported)', () => {
    const env = memoryEnv();
    const a = env.store();
    const b = env.store({ io: env.mem.io() });
    const add = (id: string) => (v: any) => ({ ...v, decisions: { ...v.decisions, [id]: { by: 'owner' } } });
    let bTried = false;
    env.mem.before({ op: 'rename', match: /catalog-accepted\.json\.\d+\.[0-9a-f]+\.tmp$/ }, () => {
      bTried = true;
      expect(() => b.update('ledger', add('D-0002'))).toThrow(/store lock/);
    });
    a.update('ledger', add('D-0001'));
    expect(bTried).toBe(true);
    b.update('ledger', add('D-0002'));
    expect(Object.keys(JSON.parse(env.read('catalog-accepted.json')!).decisions).sort()).toEqual(['D-0001', 'D-0002']);
  });

  it('without the lock the same interleaving loses a record: the race the lock closes is real', () => {
    const env = memoryEnv();
    const a = env.store();
    const b = env.store({ io: env.mem.io() });
    const add = (id: string) => (v: any) => ({ ...v, decisions: { ...v.decisions, [id]: {} } });
    env.write('catalog-accepted.json', JSON.stringify({ version: 1, decisions: {} }));
    // A plain read-modify-write, as cli/catalog.mjs accept was before step 3.
    const before = a.readJson('ledger');
    b.writeJson('ledger', add('D-0002')(b.readJson('ledger')));
    a.writeJson('ledger', add('D-0001')(before));
    expect(Object.keys(JSON.parse(env.read('catalog-accepted.json')!).decisions)).toEqual(['D-0001']);
  });

  it('a holder that dies mid-write leaves the old value, and the next process takes the lock over', () => {
    const env = memoryEnv();
    const aIo = env.mem.io();
    const a = env.store({ io: aIo });
    a.writeJson('plans', { entries: [{ id: 'PL-1' }] });
    env.mem.fault({ op: 'rename', match: /plans\.json\.\d+\.[0-9a-f]+\.tmp$/, code: 'EIO' });
    expect(() => a.update('plans', () => ({ entries: [] }))).toThrow(/EIO/);
    expect(JSON.parse(env.read('plans.json')!).entries.length).toBe(1);
    expect(tmpLeft(env)).toEqual([]);
    env.mem.kill(aIo.pid);
    const b = env.store({ io: env.mem.io() });
    expect(b.update('plans', (v: any) => ({ entries: [...v.entries, { id: 'PL-2' }] })).entries.length).toBe(2);
  });

  it('nothing reaches the disk', () => {
    const env = memoryEnv();
    env.store().writeJson('plans', { entries: [] });
    expect(fs.existsSync(path.join(env.folder, 'plans.json'))).toBe(false);
    expect(env.mem.files().some((f: string) => f.endsWith('/plans.json'))).toBe(true);
  });
});

// FileBackend's cache is per fs: two memory worlds with the same path and clock never share a "known good" entry.
describe('FileBackend cache per fs', () => {
  it('a broken file in one memory world is not taken as good because another world wrote the same path', () => {
    const one = memoryEnv();
    const two = memoryEnv();
    const value = { entries: [{ id: 'PL-1' }] };
    one.store().writeJson('plans', value);
    // The same byte length as the good file, and it does not parse.
    two.write('plans.json', `{${'x'.repeat(FB.jsonText(value).length - 1)}`, 0);
    // Same path, same virtual time, maybe the same size: only a per-fs cache keeps these apart.
    two.store().writeJson('plans', { entries: [] });
    expect(two.read('plans.json.prev')).toBeNull();
    FB.clearCache();
  });
});
