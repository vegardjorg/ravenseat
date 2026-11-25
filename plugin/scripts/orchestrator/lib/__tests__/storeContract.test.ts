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
  /** The entries of a folder under the data folder ('' = the data folder), sorted; [] when it does not exist. */
  listIn: (rel: string) => string[];
  /**
   * A store as a process that CRASHES at the op `spec` names: the op throws (or, with after: true, happens and then
   * throws), and from then on every fs call of that process throws ECRASH, so no finally block, cleanup or lock release
   * gets anything done. restart() ends the crash: the "process" is gone and its locks are free for the next one.
   */
  crashStore: (spec: { op: string; match: RegExp; after?: boolean }, o?: object) => any;
  restart: () => void;
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
    listIn: (rel) => {
      try {
        return fs.readdirSync(rel ? abs(rel) : folder).sort();
      } catch {
        return [];
      }
    },
    crashStore: (spec, o = {}) => {
      crashed = false;
      armed = spec;
      return ST.openStore({ folder, lockWaitMs: 0, io: { fs: crashFs }, ...o });
    },
    restart: () => {
      crashed = false;
      armed = null;
      // The crashed "process" was this one (alive): its locks go the way a dead holder's would.
      for (const d of [ST.LOCK_DIR, '.lockState']) fs.rmSync(abs(d), { recursive: true, force: true });
    },
  };
}

/** The op of an fs call, for crash matching (as the memory backend names them). */
const OP_OF: Record<string, string> = {
  writeFileSync: 'write', appendFileSync: 'append', renameSync: 'rename', copyFileSync: 'write', rmSync: 'rm',
  unlinkSync: 'rm', mkdirSync: 'mkdir', readFileSync: 'read', statSync: 'stat', readdirSync: 'readdir', rmdirSync: 'rmdir',
};
let crashed = false;
let armed: { op: string; match: RegExp; after?: boolean } | null = null;
const crashError = (p: unknown) => Object.assign(new Error(`ECRASH: the process crashed (${String(p)})`), { code: 'ECRASH' });
/** The real fs, crashing as crashStore's spec says (the file backend's crash point). */
const crashFs: any = new Proxy(fs, {
  get(target: any, key: string) {
    const real = target[key];
    if (typeof real !== 'function') return real;
    return (...args: any[]) => {
      if (crashed) throw crashError(args[0]);
      const hit = armed && OP_OF[key] === armed.op && armed.match.test(String(args[0]).replace(/\\/g, '/'));
      if (hit && !armed!.after) {
        armed = null;
        crashed = true;
        throw crashError(args[0]);
      }
      const out = real.apply(target, args);
      if (hit) {
        armed = null;
        crashed = true;
        throw crashError(args[0]);
      }
      return out;
    };
  },
});

function memoryEnv(): Env & { mem: any } {
  const mem = createMemory();
  const folder = path.resolve('/mem-store/data');
  mem.fs.mkdirSync(folder, { recursive: true });
  const main = mem.io();
  let crashIo: any = null;
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
    listIn: (rel) => {
      try {
        return mem.fs.readdirSync(rel ? abs(rel) : folder).sort();
      } catch {
        return [];
      }
    },
    crashStore: (spec, o: any = {}) => {
      crashIo = mem.io();
      mem.crash(spec);
      return ST.openStore({ folder, lockWaitMs: 0, io: crashIo, ...o });
    },
    restart: () => {
      mem.restart();
      if (crashIo) mem.kill(crashIo.pid);
      crashIo = null;
    },
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

// ---- transaction() with a file journal (LAGRING step 7) ---------------------------------------------------------------
// Two families with .prev (ledger: the store lock; plans: the queue lock) and one without (owner-log: the queue lock).
// Renames go in family-name order: ledger (catalog-accepted.json) first, then owner-log, then plans.
const TMP_OF = (file: string) => new RegExp(`/${file.replace(/\./g, '\\.')}\\.\\d+\\.[0-9a-f]+\\.tmp$`);
const JOURNAL_TMP = /\/\.journal\/[^/]+\.json\.\d+\.[0-9a-f]+\.tmp$/;
const JOURNAL_FILE = /\/\.journal\/[^/]+\.json$/;
const OLD = { ledger: { version: 1, decisions: { old: {} } }, plans: { entries: [{ id: 'PL-1' }] } };
const NEW = { ledger: { version: 1, decisions: { old: {}, new: {} } }, plans: { entries: [{ id: 'PL-1' }, { id: 'PL-2' }] } };

describe.each([['file', fileEnv], ['memory', memoryEnv]] as const)('store transaction (%s backend)', (_name, make) => {
  /** A world with OLD in both families (and their .prev copies of an older state). */
  const seeded = () => {
    const env = make();
    const st = env.store();
    st.writeJson('ledger', { version: 1, decisions: {} });
    st.writeJson('ledger', OLD.ledger);
    st.writeJson('plans', { entries: [] });
    st.writeJson('plans', OLD.plans);
    return env;
  };
  const both = (env: Env) => ({ ledger: JSON.parse(env.read('catalog-accepted.json')!), plans: JSON.parse(env.read('plans.json')!) });
  const clean = (env: Env) => {
    expect(tmpLeft(env)).toEqual([]);
    expect(env.listIn('.journal')).toEqual([]);
  };
  const rmIn = (env: Env, name: string) => {
    if (env.name === 'file') fs.rmSync(path.join(env.folder, name));
    else (env as any).mem.fs.rmSync(path.join(env.folder, name));
  };
  const commitBoth = (st: any) =>
    st.transaction(['plans', 'ledger'], (tx: any) => {
      tx.put('ledger', NEW.ledger);
      tx.put('plans', NEW.plans);
    });
  const quiet = <T,>(fn: () => T): { out: T; err: string } => {
    const errors: string[] = [];
    const orig = console.error;
    console.error = (m: string) => errors.push(String(m));
    try {
      return { out: fn(), err: errors.join('\n') };
    } finally {
      console.error = orig;
    }
  };

  it('commits every family at once; nothing reaches a target before the commit; .prev as for a single write', () => {
    const env = seeded();
    const st = env.store();
    const out = st.transaction(['plans', 'ledger'], (tx: any) => {
      tx.put('ledger', NEW.ledger);
      expect(tx.get('ledger')).toEqual(NEW.ledger); // the transaction sees its own staged write
      tx.update('plans', (v: any) => ({ entries: [...v.entries, { id: 'PL-2' }] }));
      expect(both(env)).toEqual(OLD); // staged only
      return 'answer';
    });
    expect(out).toBe('answer');
    expect(both(env)).toEqual(NEW);
    expect(JSON.parse(env.read('plans.json.prev')!)).toEqual(OLD.plans);
    expect(JSON.parse(env.read('catalog-accepted.json.prev')!)).toEqual(OLD.ledger);
    clean(env);
  });

  it('a throw inside fn writes nothing and leaves no tmp file or journal', () => {
    const env = seeded();
    expect(() =>
      env.store().transaction(['plans', 'ledger'], (tx: any) => {
        tx.put('ledger', NEW.ledger);
        throw new Error('changed my mind');
      }),
    ).toThrow(/changed my mind/);
    expect(both(env)).toEqual(OLD);
    clean(env);
  });

  it('a family the transaction did not name is refused', () => {
    const env = seeded();
    expect(() => env.store().transaction(['plans'], (tx: any) => tx.put('ledger', NEW.ledger))).toThrow(/not in this transaction/);
    expect(both(env)).toEqual(OLD);
  });

  it('ENOSPC on a tmp file: nothing changed, no tmp file, no journal', () => {
    const env = seeded();
    if (env.name === 'memory') (env as any).mem.fault({ op: 'write', match: TMP_OF('plans.json'), code: 'ENOSPC' });
    else {
      // The file backend: a crash at the same write leaves no journal either (nothing was renamed yet).
      expect(() => commitBoth(env.crashStore({ op: 'write', match: TMP_OF('plans.json') }))).toThrow(/ECRASH/);
      env.restart();
      expect(both(env)).toEqual(OLD);
      expect(env.listIn('.journal')).toEqual([]);
      return;
    }
    expect(() => commitBoth(env.store())).toThrow(/ENOSPC/);
    expect(both(env)).toEqual(OLD);
    clean(env);
  });

  it('a crash right after the journal write: the next transaction on those families rolls forward', () => {
    const env = seeded();
    expect(() => commitBoth(env.crashStore({ op: 'rename', match: JOURNAL_TMP, after: true }))).toThrow(/ECRASH/);
    env.restart();
    expect(both(env)).toEqual(OLD);
    expect(env.listIn('.journal').length).toBe(1);
    const { err } = quiet(() => env.store().transaction(['ledger', 'plans'], (tx: any) => expect(tx.get('plans')).toEqual(NEW.plans)));
    expect(err).toMatch(/finished/);
    expect(both(env)).toEqual(NEW);
    clean(env);
  });

  it('a crash after the first rename: recovery finishes the rest', () => {
    const env = seeded();
    expect(() => commitBoth(env.crashStore({ op: 'rename', match: TMP_OF('catalog-accepted.json'), after: true }))).toThrow(/ECRASH/);
    env.restart();
    expect(both(env)).toEqual({ ledger: NEW.ledger, plans: OLD.plans }); // out of step
    const r = env.store().recover();
    expect(r.results.map((x: any) => x.outcome)).toEqual(['forward']);
    expect(both(env)).toEqual(NEW);
    clean(env);
  });

  it('a crash before the journal delete: recovery only removes the journal', () => {
    const env = seeded();
    // Every target is in place when the journal delete crashes: the commit itself only warns (on stderr).
    quiet(() => commitBoth(env.crashStore({ op: 'rm', match: JOURNAL_FILE })));
    env.restart();
    expect(env.listIn('.journal').length).toBe(1);
    expect(both(env)).toEqual(NEW);
    expect(env.store().recover().results.map((x: any) => x.outcome)).toEqual(['done']);
    expect(both(env)).toEqual(NEW);
    clean(env);
  });

  it('nothing can be finished (a tmp file is gone): the before-state comes back from .prev where the hash matches', () => {
    const env = seeded();
    expect(() => commitBoth(env.crashStore({ op: 'rename', match: TMP_OF('catalog-accepted.json'), after: true }))).toThrow(/ECRASH/);
    env.restart();
    const lost = env.list().filter((n) => /^plans\.json\.\d+\.[0-9a-f]+\.tmp$/.test(n));
    expect(lost.length).toBe(1);
    rmIn(env, lost[0]);
    const r = env.store().recover();
    expect(r.results[0].outcome).toBe('back');
    expect(both(env)).toEqual(OLD);
    clean(env);
  });

  it('a recovery that fails keeps the journal, never blocks reads, and is listed for doctor', () => {
    const env = seeded();
    const st0 = env.crashStore({ op: 'rename', match: TMP_OF('owner-log.json'), after: true });
    expect(() =>
      st0.transaction(['owner-log', 'plans'], (tx: any) => {
        tx.put('owner-log', { version: 1, since: null, entries: [] });
        tx.put('plans', NEW.plans);
      }),
    ).toThrow(/ECRASH/);
    env.restart();
    for (const n of env.list().filter((x) => /^plans\.json\..+\.tmp$/.test(x))) rmIn(env, n);
    const st = env.store();
    // owner-log.json had no file before and keeps no .prev: it cannot be put back, so the recovery fails.
    const r = st.recover();
    expect(r.results[0].outcome).toBe('failed');
    expect(r.results[0].reason).toMatch(/owner-log\.json/);
    expect(env.listIn('.journal').length).toBe(1);
    expect(st.readJson('plans')).toEqual(OLD.plans);
    const listed = st.journals();
    expect(listed.length).toBe(1);
    expect(listed[0]).toMatchObject({ families: ['owner-log', 'plans'], plan: 'failed' });
    // A later transaction on the same families is never stopped by it.
    const { err } = quiet(() => st.transaction(['plans'], (tx: any) => tx.put('plans', NEW.plans)));
    expect(err).toMatch(/could not be finished/);
    expect(JSON.parse(env.read('plans.json')!)).toEqual(NEW.plans);
  });

  it('journalRecover report: the transaction leaves the journal and says so; recover() finishes it', () => {
    const env = seeded();
    expect(() => commitBoth(env.crashStore({ op: 'rename', match: JOURNAL_TMP, after: true }))).toThrow(/ECRASH/);
    env.restart();
    const st = env.store({ journalRecover: 'report' });
    const { err } = quiet(() => st.transaction(['ledger'], (tx: any) => expect(tx.get('ledger')).toEqual(OLD.ledger)));
    expect(err).toMatch(/journal/);
    expect(env.listIn('.journal').length).toBe(1);
    expect(st.recover().results[0].outcome).toBe('forward');
    expect(both(env)).toEqual(NEW);
    clean(env);
  });

  it('append, remove and a collection member by id', () => {
    const env = seeded();
    env.write('handover-ongoing.md', 'a\n');
    env.write('handover-archive/2026-10.md', 'old\n');
    const st = env.store();
    st.transaction(['handover', 'handover-archive'], (tx: any) => {
      expect(tx.text('handover')).toBe('a\n');
      tx.append('handover-archive', '2026-11.md', 'one\n');
      tx.append('handover-archive', '2026-11.md', 'two\n');
      tx.remove('handover-archive', '2026-10.md');
      tx.put('handover', 'b\n');
    });
    expect(env.read('handover-ongoing.md')).toBe('b\n');
    expect(env.read('handover-archive/2026-11.md')).toBe('one\ntwo\n');
    expect(env.read('handover-archive/2026-10.md')).toBeNull();
    expect(() => st.transaction(['handover-archive'], (tx: any) => tx.put('handover-archive', '../x.md', 'x'))).toThrow(/id/);
    clean(env);
  });

  it('the locks: a live holder of one of them stops the transaction before fn runs', () => {
    const env = seeded();
    env.holdLock(true);
    let ran = false;
    expect(() =>
      env.store().transaction(['plans', 'ledger'], () => {
        ran = true;
      }),
    ).toThrow(/store lock/);
    expect(ran).toBe(false);
  });

  it('an outer holder of the queue lock (cli/context.mjs) is used, not waited on', () => {
    const env = seeded();
    const io = env.name === 'memory' ? (env as any).mem.io() : null;
    const LK = io ? QL.lockOn(io) : QL;
    const dir = path.join(env.folder, '.lockState');
    const got = LK.acquire(dir, { waitMs: 0 });
    expect(got.ok).toBe(true);
    const st = env.store({ ...(io ? { io } : {}), outerLocks: { queue: () => got.me } });
    st.transaction(['plans'], (tx: any) => tx.put('plans', NEW.plans));
    expect(JSON.parse(env.read('plans.json')!)).toEqual(NEW.plans);
    // Still held by the outer holder: the transaction never released a lock it did not take.
    expect(LK.isHeld(dir, got.me)).toBe(true);
    LK.release(dir, got.me);
  });
});

describe('memory backend: crash points', () => {
  it('crash() before and after an op; while crashed every call throws; restart() ends it', () => {
    const mem = createMemory();
    mem.fs.mkdirSync(path.resolve('/c'), { recursive: true });
    mem.crash({ op: 'write', match: /a\.txt$/, after: true });
    expect(() => mem.fs.writeFileSync(path.resolve('/c/a.txt'), 'x')).toThrow(/ECRASH/);
    expect(mem.text('/c/a.txt')).toBe('x');
    expect(() => mem.fs.readFileSync(path.resolve('/c/a.txt'), 'utf8')).toThrow(/ECRASH/);
    mem.restart();
    mem.crash({ op: 'rename', match: /a\.txt$/ });
    expect(() => mem.fs.renameSync(path.resolve('/c/a.txt'), path.resolve('/c/b.txt'))).toThrow(/ECRASH/);
    mem.restart();
    expect(mem.text('/c/a.txt')).toBe('x');
    expect(mem.text('/c/b.txt')).toBeNull();
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
