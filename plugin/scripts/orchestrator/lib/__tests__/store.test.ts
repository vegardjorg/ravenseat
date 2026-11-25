// =============================================================
// store.test.ts: the storage layer (lib/store/, LAGRING-1a, steps 1-3 of plans/lagring-gjennomgang-2026-11-24.md).
//
// Locks: (1) the family register knows the data folder's entries, and tells a crashed write's tmp file from a family;
// (2) FileBackend writes through a unique tmp name, removes it on ANY failure (also a failed write, not only a failed
// rename), keeps <file>.prev when the family asks for it, and a corrupt file with onCorrupt 'fail' throws with the way
// back; (3) nextId reserves: a deleted id is never handed out again, and two callers that read the same snapshot still
// get two ids; (4) update and withLock run under the store lock (queueLock's generation rule), so a concurrent writer's
// record is kept; (5) scan lists unknown entries and orphaned tmp files, and sweepTmp --dry deletes nothing.
// Temporary data folders only.
// =============================================================
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const FAM = require('../store/families.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const FB = require('../store/fileBackend.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const S = require('../store/index.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const QL = require('../queueLock.js');

const made: string[] = [];
afterAll(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
const tmpDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-store-'));
  made.push(d);
  return d;
};
/** A pid that is certainly not running (above the usual pid range). */
const DEAD_PID = 2_000_000_001;

describe('the family register', () => {
  it('knows the data folder families, and a tmp file is never a family', () => {
    for (const n of ['queue.json', 'queue.json.prev', 'plans.json', 'catalog-accepted.json', 'gate-evidence.json', 'owner-log.json', 'approval-waits.json', 'times.jsonl', 'times-2026-10.jsonl', 'findings-2026-10.2.jsonl', 'merge-state-A-1.json', 'id-reservations.json'])
      expect(FAM.classify(n, false)?.name, n).toBeTruthy();
    for (const d of ['mission', 'snapshots', 'processes', '.lockState', '.storeLock', 'collect'])
      expect(FAM.classify(d, true)?.name, d).toBeTruthy();
    expect(FAM.classify('my-own-notes.txt', false)).toBeNull();
    expect(FAM.isTmpName(`plans.json.${DEAD_PID}.tmp`)).toBe(true);
    expect(FAM.isTmpName(`plans.json.${DEAD_PID}.a1b2c3.tmp`)).toBe(true);
    expect(FAM.classify(`plans.json.${DEAD_PID}.tmp`, false)).toBeNull();
  });

  it('every family names its writers, backup, onCorrupt and share; git-tracked families are file-only', () => {
    for (const f of FAM.all()) {
      expect(Array.isArray(f.writers) && f.writers.length, f.name).toBeTruthy();
      expect(['prev', 'tiers', 'none']).toContain(f.backup);
      expect(['fail', 'empty', 'broken', 'restorePrev', 'skip']).toContain(f.onCorrupt);
      expect(['never', 'optIn']).toContain(f.share);
      if (f.root === 'tree') expect(f.backend, f.name).toBe('file-only');
    }
    expect(FAM.family('plans').backup).toBe('prev');
    expect(FAM.family('decisions').idScheme).toBe('D');
    expect(FAM.family('guards').idScheme).toBe('G');
  });
});

describe('FileBackend', () => {
  it('writes through a unique tmp name and leaves nothing behind', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'plans.json');
    const a = FB.tmpName(file);
    const b = FB.tmpName(file);
    expect(a).not.toBe(b);
    expect(path.basename(a)).toMatch(new RegExp(`^plans\\.json\\.${process.pid}\\.[0-9a-f]{6,}\\.tmp$`));
    FB.writeText(file, '{"n":1}\n');
    expect(fs.readdirSync(dir)).toEqual(['plans.json']);
  });

  it('removes the tmp file when the WRITE throws, not only when the rename does', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'gate-evidence.json');
    fs.writeFileSync(file, '{"entries":[]}\n');
    const full = {
      ...fs,
      writeFileSync: (p: string, text: string) => {
        if (String(p).endsWith('.tmp')) {
          fs.writeFileSync(p, String(text).slice(0, 3));
          throw Object.assign(new Error('no space left'), { code: 'ENOSPC' });
        }
        return fs.writeFileSync(p, text);
      },
    };
    expect(() => FB.writeText(file, '{"entries":[{"id":1}]}\n', { fs: full })).toThrow(/no space left/);
    expect(fs.readdirSync(dir)).toEqual(['gate-evidence.json']);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"entries":[]}\n');
  });

  it('keeps <file>.prev of the last good state when asked, and a broken file never replaces it', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'plans.json');
    FB.writeText(file, '{"n":1}\n', { backup: 'prev' });
    FB.writeText(file, '{"n":2}\n', { backup: 'prev' });
    expect(JSON.parse(fs.readFileSync(`${file}.prev`, 'utf8')).n).toBe(1);
    fs.writeFileSync(file, '{"n": [');
    FB.writeText(file, '{"n":3}\n', { backup: 'prev' });
    expect(JSON.parse(fs.readFileSync(`${file}.prev`, 'utf8')).n).toBe(1);
    expect(fs.readdirSync(dir).sort()).toEqual(['plans.json', 'plans.json.prev']);
  });

  it('a file this process wrote is copied to .prev without a parse', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'plans.json');
    FB.writeText(file, '{"n":1}\n', { backup: 'prev', json: true });
    const parse = JSON.parse;
    let parses = 0;
    JSON.parse = (...x: Parameters<typeof JSON.parse>) => (parses++, parse(...x));
    try {
      FB.writeText(file, '{"n":2}\n', { backup: 'prev', json: true });
    } finally {
      JSON.parse = parse;
    }
    expect(parses).toBe(0);
    expect(fs.readFileSync(`${file}.prev`, 'utf8')).toBe('{"n":1}\n');
  });

  it('readJson: onCorrupt fail throws with the restore hint; empty gives the fallback', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'plans.json');
    fs.writeFileSync(`${file}.prev`, '{"entries":[{"id":"PL-A"}]}');
    fs.writeFileSync(file, '{"entries": [');
    const describe = (j: { entries?: unknown[] }) => `${j.entries?.length ?? 0} plan(s)`;
    expect(() => FB.readJson(file, { onCorrupt: 'fail', describe })).toThrow(/plans\.json\.prev holds the previous good state \(1 plan\(s\)/);
    expect(FB.readJson(file, { onCorrupt: 'empty', fallback: { none: true } })).toEqual({ none: true });
    expect(FB.readJson(path.join(dir, 'missing.json'), { onCorrupt: 'fail', fallback: 7 })).toBe(7);
  });

  it('readJson caches by mtime and size: a second read of the same file does not parse again', () => {
    const dir = tmpDir();
    const file = path.join(dir, 'catalog-accepted.json');
    fs.writeFileSync(file, '{"version":1,"decisions":{}}');
    FB.readJson(file, { onCorrupt: 'empty', fallback: null, cache: true });
    const parse = JSON.parse;
    let parses = 0;
    JSON.parse = (...x: Parameters<typeof JSON.parse>) => (parses++, parse(...x));
    try {
      expect(FB.readJson(file, { onCorrupt: 'empty', fallback: null, cache: true })).toEqual({ version: 1, decisions: {} });
    } finally {
      JSON.parse = parse;
    }
    expect(parses).toBe(0);
  });
});

describe('nextId with reservation', () => {
  it('a deleted id is never handed out again', () => {
    const st = S.openStore({ folder: tmpDir() });
    expect(st.nextId('D', { atLeast: 1 })).toBe('D-0001');
    // The file of D-0001 was deleted: the caller sees nothing taken, and still gets D-0002.
    expect(st.nextId('D', { atLeast: 1 })).toBe('D-0002');
    expect(st.nextId('G', { atLeast: 1 })).toBe('G-1');
  });

  it('two callers that read the same snapshot of the folder get two ids', () => {
    const folder = tmpDir();
    const one = S.openStore({ folder });
    const two = S.openStore({ folder });
    // Both saw D-0004 as the highest file (atLeast 5): the old rule gave both D-0005.
    const ids = [one.nextId('D', { atLeast: 5 }), two.nextId('D', { atLeast: 5 })];
    expect(new Set(ids).size).toBe(2);
    expect(ids.sort()).toEqual(['D-0005', 'D-0006']);
  });

  it('a broken reservation file continues from its .prev one higher, never handing an id out twice', () => {
    const folder = tmpDir();
    const st = S.openStore({ folder });
    st.nextId('D', { atLeast: 1 });
    st.nextId('D', { atLeast: 1 });
    fs.writeFileSync(path.join(folder, 'id-reservations.json'), '{"ids": [');
    // .prev says D top 1 (one write older); D-0002 may be in use, so the next is D-0003.
    expect(st.nextId('D', { atLeast: 1 })).toBe('D-0003');
    // And the file is good again.
    expect(JSON.parse(fs.readFileSync(path.join(folder, 'id-reservations.json'), 'utf8')).ids.D.top).toBe(3);
  });
});

describe('guard ids', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const GR = require('../guardRegistry.js');
  const input = { title: 'T', explain: 'One sentence.', kind: 'review', against: { lesson: 'l' } };

  it('addGuard takes the reserved id, reserves only for a valid entry, and refuses an id the registry has', () => {
    const reg = GR.empty();
    let asked = 0;
    expect(GR.addGuard(reg, { ...input, title: '' }, { id: () => (asked++, 'G-9') }).error.length).toBeGreaterThan(0);
    expect(asked).toBe(0);
    expect(GR.addGuard(reg, input, { id: () => 'G-7' }).guard.id).toBe('G-7');
    expect(GR.addGuard(reg, input, { id: 'G-7' }).error[0]).toMatch(/G-7 is already in the registry/);
    reg.guards.push({ ...reg.guards[0] });
    expect(GR.duplicateIds(reg)).toEqual([{ id: 'G-7', count: 2 }]);
  });
});

describe('withLock and update', () => {
  it('waits for a lock another live process holds (queueLock), and gives up with the holder named', () => {
    const folder = tmpDir();
    const lockDir = path.join(folder, '.storeLock');
    const got = QL.acquire(lockDir, { pid: process.ppid || 1 });
    expect(got.ok).toBe(true);
    const st = S.openStore({ folder, lockWaitMs: 300 });
    expect(() => st.withLock(() => 1)).toThrow(/lock/i);
    QL.release(lockDir, got.me);
    expect(st.withLock(() => 2)).toBe(2);
  });

  it('is re-entrant in one process: nextId inside withLock does not wait on itself', () => {
    const st = S.openStore({ folder: tmpDir(), lockWaitMs: 300 });
    expect(st.withLock(() => st.nextId('G', { atLeast: 1 }))).toBe('G-1');
  });

  it('two concurrent updates keep both records', async () => {
    const folder = tmpDir();
    const ready = path.join(folder, 'holder-ready');
    // A second process takes the store lock, reads the ledger, waits, then writes its record and lets go.
    const script = path.join(folder, 'holder.cjs');
    fs.writeFileSync(
      script,
      [
        `const S = require(${JSON.stringify(path.resolve(__dirname, '..', 'store', 'index.js'))});`,
        `const fs = require('node:fs');`,
        `const st = S.openStore({ folder: ${JSON.stringify(folder)} });`,
        `st.update('ledger', (l) => {`,
        `  fs.writeFileSync(${JSON.stringify(ready)}, '1');`,
        `  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);`,
        `  return { ...l, decisions: { ...l.decisions, 'D-0001': { fingerprint: 'a', by: 'owner', at: 'x' } } };`,
        `});`,
      ].join('\n'),
    );
    const child = spawn(process.execPath, [script], { stdio: 'ignore' });
    const done = new Promise((r) => child.on('exit', r));
    for (let i = 0; i < 200 && !fs.existsSync(ready); i++) await new Promise((r) => setTimeout(r, 20));
    expect(fs.existsSync(ready)).toBe(true);
    const st = S.openStore({ folder });
    st.update('ledger', (l: { decisions: Record<string, unknown> }) => ({ ...l, decisions: { ...l.decisions, 'D-0002': { fingerprint: 'b', by: 'owner', at: 'y' } } }));
    await done;
    const ledger = JSON.parse(fs.readFileSync(path.join(folder, 'catalog-accepted.json'), 'utf8'));
    expect(Object.keys(ledger.decisions).sort()).toEqual(['D-0001', 'D-0002']);
  }, 20_000);
});

describe('transaction commit cost', () => {
  it('reads each target once: its hash before and its .prev copy come from the same read (queue.json is ~12 MB)', () => {
    const folder = tmpDir();
    const file = path.join(folder, 'plans.json');
    fs.writeFileSync(file, JSON.stringify({ entries: [{ id: 'PL-1' }] }));
    let reads = 0;
    const counting: any = new Proxy(fs, {
      get(target: any, key: string) {
        const real = target[key];
        if (typeof real !== 'function') return real;
        return (...args: any[]) => {
          if (key === 'readFileSync' && path.resolve(String(args[0])) === path.resolve(file)) reads++;
          return real.apply(target, args);
        };
      },
    });
    S.openStore({ folder, lockWaitMs: 0, io: { fs: counting } }).transaction(['plans'], (tx: any) => tx.put('plans', { entries: [] }));
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ entries: [] });
    expect(JSON.parse(fs.readFileSync(`${file}.prev`, 'utf8'))).toEqual({ entries: [{ id: 'PL-1' }] });
    expect(reads).toBe(1);
  });
});

describe('scan and sweepTmp', () => {
  const seeded = () => {
    const folder = tmpDir();
    fs.writeFileSync(path.join(folder, 'queue.json'), '{"tasks":[]}');
    fs.writeFileSync(path.join(folder, 'my-own-notes.txt'), 'x');
    const orphan = path.join(folder, `plans.json.${DEAD_PID}.tmp`);
    fs.writeFileSync(orphan, '{"half');
    const old = (Date.now() - 3 * 3600_000) / 1000;
    fs.utimesSync(orphan, old, old);
    fs.mkdirSync(path.join(folder, 'mission'));
    const nested = path.join(folder, 'mission', `A-1.md.${DEAD_PID}.ab12cd.tmp`);
    fs.writeFileSync(nested, 'x');
    fs.utimesSync(nested, old, old);
    // A tmp file of this live process is a write in progress, never an orphan.
    fs.writeFileSync(path.join(folder, `owner-log.json.${process.pid}.tmp`), 'x');
    return { folder, orphan, nested };
  };

  it('lists the unknown entries and the orphaned tmp files with age and size', () => {
    const { folder } = seeded();
    const r = S.openStore({ folder }).scan();
    expect(r.unknown.map((u: { name: string }) => u.name)).toEqual(['my-own-notes.txt']);
    const rels = r.orphanTmp.map((t: { rel: string }) => t.rel).sort();
    expect(rels).toEqual([`mission/A-1.md.${DEAD_PID}.ab12cd.tmp`, `plans.json.${DEAD_PID}.tmp`]);
    for (const t of r.orphanTmp) {
      expect(t.ageMs).toBeGreaterThan(3600_000);
      expect(typeof t.size).toBe('number');
    }
  });

  it('sweepTmp dry lists and deletes nothing; without dry it removes only the orphans', () => {
    const { folder, orphan, nested } = seeded();
    const st = S.openStore({ folder });
    const dry = st.sweepTmp({ dry: true });
    expect(dry.removed).toEqual([]);
    expect(dry.listed.length).toBe(2);
    expect(fs.existsSync(orphan) && fs.existsSync(nested)).toBe(true);
    const wet = st.sweepTmp({ dry: false });
    expect(wet.removed.length).toBe(2);
    expect(fs.existsSync(orphan) || fs.existsSync(nested)).toBe(false);
    expect(fs.existsSync(path.join(folder, `owner-log.json.${process.pid}.tmp`))).toBe(true);
    expect(fs.existsSync(path.join(folder, 'my-own-notes.txt'))).toBe(true);
  });
});
