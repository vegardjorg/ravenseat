// =============================================================
// storeJournalFlow.test.ts: the callers of store.transaction() (LAGRING step 7), through the CLI.
//
// A commit that stopped part way is planted with the real Store on the test's data folder and an fs that "crashes"
// right after the journal is written (every later call throws, as in a killed process): the journal and the tmp files
// are on disk, no target is renamed. Then:
//   - a queue write (`add`) finishes it BEFORE it reads, so the task of the stopped commit is kept, not overwritten;
//   - doctor names the journal in a row, and doctor --fix finishes it;
//   - `handover archive` finishes a stopped commit of the handover note and its archive first.
//
// THE REAL WRITE, KILLED (fix round jrn-r1): __tests__/journalCrashPreload.cjs kills the REAL `add` (cli/context.mjs
// write: the archive, the owner log and queue.json in one transaction) at each crash point of the commit, or fails the
// archive's rename with EPERM. At every point, what a reader sees on disk keeps the archive's ordering rule
// (lib/queueArchive.js THE ORDER: no task is in neither file) and the owner log's (every owner row in queue.json is
// recorded). Then:
//   - the next command finishes the commit right after it takes the lock, and nothing is lost;
//   - with store.journalRecover report, the next write refuses instead of writing past the kept journal; doctor --fix
//     finishes it, and the write then goes through.
// =============================================================
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const QUEUE = path.resolve(__dirname, '..', 'queue.mjs');
const CRASH_PRELOAD = path.resolve(__dirname, 'journalCrashPreload.cjs');
const OL = require('../lib/ownerLog.js');
const ST = require('../lib/store/index.js');

const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

function project(config: object = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-journal-flow-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  const data = path.join(folder, 'data');
  fs.mkdirSync(repo);
  fs.mkdirSync(data);
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'main', mode: 'lite', ...config }));
  const globalConfig = path.join(folder, 'global-gitconfig');
  fs.writeFileSync(globalConfig, '');
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CEILING_DIRECTORIES: folder,
    QUEUE_FOLDER: data,
    QUEUE_CONFIG: configFile,
    QUEUE_ROOT: repo,
    QUEUE_GIT: repo,
    QUEUE_TIME_LOG: path.join(data, 'times.jsonl'),
    QUEUE_TRANSCRIPTS: path.join(folder, 'transcripts'),
    RAVENSEAT_INSTRUCTIONS_TOP: repo,
    DISABLE_UPDATES: '1',
  } as NodeJS.ProcessEnv;
  delete env.QUEUE_SCRATCHPAD;
  delete env.QUEUE_SESSION;
  const ID = ['-c', 'user.name=queue-test', '-c', 'user.email=queue-test@example.invalid'];
  const g = (args: string[]) => spawnSync('git', ['-C', repo, ...ID, ...args], { env, encoding: 'utf8' });
  fs.writeFileSync(path.join(repo, 'package.json'), '{}');
  g(['init', '-q', '-b', 'main']);
  g(['add', '--', 'package.json']);
  g(['commit', '-q', '-m', 'start']);
  fs.writeFileSync(path.join(data, 'queue.json'), JSON.stringify({ limits: {}, resolved: [], projects: { p: { title: 'P' } }, tasks: [] }));
  // crash: a JRN_CRASH point of __tests__/journalCrashPreload.cjs (the process is killed there), or none.
  const run = (args: string[], crash?: string) => {
    const pre = crash ? ['--require', CRASH_PRELOAD] : [];
    const r = spawnSync(process.execPath, [...pre, QUEUE, ...args], { encoding: 'utf8', env: { ...env, JRN_CRASH: crash ?? '' }, cwd: repo, timeout: 60_000 });
    return { code: r.status, all: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  };
  const journal = () => {
    try {
      return fs.readdirSync(path.join(data, '.journal')).filter((n) => n.endsWith('.json'));
    } catch {
      return [];
    }
  };
  return { data, run, journal };
}

/** Runs a transaction on the data folder whose process "crashes" right after its journal is written. */
function stopAfterJournal(data: string, fams: string[], stage: (tx: any) => void) {
  let crashed = false;
  const crashFs: any = new Proxy(fs, {
    get(target: any, key: string) {
      const real = target[key];
      if (typeof real !== 'function') return real;
      return (...args: any[]) => {
        if (crashed) throw Object.assign(new Error('ECRASH'), { code: 'ECRASH' });
        const out = real.apply(target, args);
        if (key === 'renameSync' && /[\\/]\.journal[\\/][^\\/]+\.json\.\d+\.[0-9a-f]+\.tmp$/.test(String(args[0]))) crashed = true;
        return out;
      };
    },
  });
  expect(() => ST.openStore({ folder: data, lockWaitMs: 0, io: { fs: crashFs } }).transaction(fams, stage)).toThrow(/ECRASH/);
  // The crashed process is gone: its locks go the way a dead holder's would.
  for (const d of Object.values(ST.LOCK_DIRS) as string[]) fs.rmSync(path.join(data, d), { recursive: true, force: true });
}

const queueWith = (data: string, id: string) => {
  const q = JSON.parse(fs.readFileSync(path.join(data, 'queue.json'), 'utf8'));
  q.tasks.push({ id, title: `Task ${id}`, status: 'waiting', project: 'p', class: 'K' });
  return q;
};
const ids = (data: string) => JSON.parse(fs.readFileSync(path.join(data, 'queue.json'), 'utf8')).tasks.map((o: any) => o.id);

describe('store transactions through the CLI', () => {
  it('a queue write finishes a stopped commit before it reads, so that commit is kept', () => {
    const p = project();
    stopAfterJournal(p.data, ['owner-log', 'queue'], (tx) => {
      tx.put('queue', queueWith(p.data, 'T-1'));
      tx.put('owner-log', { version: 1, since: null, entries: [] });
    });
    expect(p.journal().length).toBe(1);
    expect(ids(p.data)).toEqual([]);
    const r = p.run(['add', 'Second task', '--id', 'T-2']);
    expect(r.code, r.all).toBe(0);
    expect(ids(p.data)).toEqual(['T-1', 'T-2']);
    expect(p.journal()).toEqual([]);
    expect(r.all).toMatch(/finished a store commit that stopped part way/);
  });

  it('doctor names the journal; doctor --fix finishes it', () => {
    const p = project();
    stopAfterJournal(p.data, ['owner-log', 'queue'], (tx) => {
      tx.put('queue', queueWith(p.data, 'T-1'));
      tx.put('owner-log', { version: 1, since: null, entries: [] });
    });
    const id = p.journal()[0].replace(/\.json$/, '');
    const d = p.run(['doctor']);
    expect(d.all).toMatch(/store journal/);
    expect(d.all).toContain(id);
    expect(p.journal().length).toBe(1); // doctor without --fix changes nothing
    p.run(['doctor', '--fix']);
    expect(p.journal()).toEqual([]);
    expect(ids(p.data)).toEqual(['T-1']);
  });

  it('handover archive finishes a stopped commit of the note and its archive first', () => {
    const p = project();
    fs.writeFileSync(path.join(p.data, 'handover-ongoing.md'), '# Handover\n\n## Now\n- old note\n');
    stopAfterJournal(p.data, ['handover', 'handover-archive'], (tx) => {
      tx.put('handover', '# Handover\n\n## Now\n- new note\n');
      tx.append('handover-archive', '2026-11.md', '- moved line\n');
    });
    const r = p.run(['handover', 'archive']);
    expect(r.code, r.all).toBe(0);
    expect(fs.readFileSync(path.join(p.data, 'handover-ongoing.md'), 'utf8')).toContain('new note');
    expect(fs.readFileSync(path.join(p.data, 'handover-archive', '2026-11.md'), 'utf8')).toContain('moved line');
    expect(p.journal()).toEqual([]);
  });
});

// ---- The real write, killed (fix round jrn-r1) ------------------------------------------------------------------------

/** A data folder where the next queue write archives D-1 (done long ago) and records an owner row: three targets. */
function archiving(config: object = {}) {
  const p = project({ history: { archiveDoneAfterDays: 1 }, ...config });
  const old = '2026-01-01T00:00:00.000Z';
  const queue = {
    limits: {},
    resolved: [],
    projects: { p: { title: 'P' } },
    tasks: [{ id: 'D-1', title: 'Done long ago', status: 'done', project: 'p', class: 'K', done: old }],
    terminal_since: { 'D-1': old },
  };
  fs.writeFileSync(path.join(p.data, 'queue.json'), JSON.stringify(queue));
  fs.writeFileSync(path.join(p.data, 'owner-log.json'), JSON.stringify({ version: 1, since: old, entries: [] }));
  return p;
}
const readJson = (data: string, name: string) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(data, name), 'utf8'));
  } catch {
    return null;
  }
};
/**
 * What a reader sees on disk keeps both ordering rules: D-1 is in queue.json or in the archive (never in neither), and
 * every owner row in queue.json is in the owner log.
 */
function consistent(data: string) {
  const q = readJson(data, 'queue.json');
  const inQueue = q.tasks.map((o: any) => o.id);
  const inArchive = (readJson(data, 'queue-archive.json')?.tasks ?? []).map((o: any) => o.id);
  expect(inQueue.includes('D-1') || inArchive.includes('D-1'), `D-1 is in neither file (queue ${inQueue}, archive ${inArchive})`).toBe(true);
  const had = new Set((readJson(data, 'owner-log.json')?.entries ?? []).map((e: any) => e.key));
  for (const o of q.tasks) for (const r of OL.rowsOf(q, o.id)) expect(had.has(r.key), `${r.label} is not in the owner log`).toBe(true);
}
/** The end state of T-1's write and T-2's: both tasks queued, D-1 archived (and only there), no journal. */
function finished(p: ReturnType<typeof project>) {
  consistent(p.data);
  expect(ids(p.data)).toEqual(['T-1', 'T-2']);
  expect(readJson(p.data, 'queue-archive.json').tasks.map((o: any) => o.id)).toEqual(['D-1']);
  expect(readJson(p.data, 'queue.json').archived).toMatchObject({ 'D-1': 'done' });
  expect(p.journal()).toEqual([]);
}
const FIRST = ['add', 'First task', '--id', 'T-1', '--by', 'owner'];
const SECOND = ['add', 'Second task', '--id', 'T-2'];
const ARCHIVE_EPERM = 'eperm:queue-archive\\.json\\.\\d+\\.[0-9a-f]+\\.tmp$';

describe('the real queue write, killed at each point of its commit', () => {
  it('the write has three targets (the archive, the owner log and queue.json), and leaves no journal', () => {
    const p = archiving();
    const r = p.run(FIRST);
    expect(r.code, r.all).toBe(0);
    expect(ids(p.data)).toEqual(['T-1']);
    expect(readJson(p.data, 'queue-archive.json').tasks.map((o: any) => o.id)).toEqual(['D-1']);
    expect(readJson(p.data, 'owner-log.json').entries.length).toBeGreaterThan(0);
    expect(p.journal()).toEqual([]);
  });

  it.each(['journal', 'rename:1', 'rename:2', 'rename:3', 'rm', ARCHIVE_EPERM])(
    'stopped at %s: a reader never sees D-1 in neither file, and the next command finishes the commit after the lock',
    (point) => {
      const p = archiving();
      const r1 = p.run(FIRST, point);
      expect(r1.code, r1.all).not.toBe(0);
      expect(p.journal().length).toBe(1);
      consistent(p.data);
      const r2 = p.run(SECOND);
      expect(r2.code, r2.all).toBe(0);
      expect(r2.all).toMatch(/finished a store commit that stopped part way/);
      finished(p);
    },
  );

  it.each(['journal', 'rename:1', 'rename:2', ARCHIVE_EPERM])(
    'store.journalRecover report, stopped at %s: the next write refuses instead of writing past the kept journal; doctor --fix finishes it',
    (point) => {
      const p = archiving({ store: { journalRecover: 'report' } });
      p.run(FIRST, point);
      expect(p.journal().length).toBe(1);
      const before = fs.readFileSync(path.join(p.data, 'queue.json'), 'utf8');
      const r2 = p.run(SECOND);
      expect(r2.code, r2.all).not.toBe(0);
      expect(r2.all).toMatch(/doctor --fix/);
      expect(fs.readFileSync(path.join(p.data, 'queue.json'), 'utf8')).toBe(before);
      expect(p.journal().length).toBe(1);
      const fix = p.run(['doctor', '--fix']);
      expect(p.journal(), fix.all).toEqual([]);
      consistent(p.data);
      const r3 = p.run(SECOND);
      expect(r3.code, r3.all).toBe(0);
      finished(p);
    },
  );

  // Fix round jrn-r2, M1: owner-log accept wrote owner-log.json straight past an open journal (report mode, or a
  // lock-time recovery that failed), so the journal found the owner log changed and could never be finished.
  it.each([
    ['store.journalRecover report', { store: { journalRecover: 'report' } }, undefined],
    ['auto, and the recovery at the lock fails', {}, ARCHIVE_EPERM],
  ])('%s: owner-log accept refuses instead of writing past the kept journal; doctor --fix finishes it', (_name, config, acceptCrash) => {
    const p = archiving(config);
    // X-1 has an owner row the log does not have yet: the owner accepts it below.
    const q = readJson(p.data, 'queue.json');
    q.tasks.push({ id: 'X-1', title: 'Added by the owner', status: 'waiting', project: 'p', class: 'K', added_by: 'owner', added_at: '2026-01-02T00:00:00.000Z' });
    fs.writeFileSync(path.join(p.data, 'queue.json'), JSON.stringify(q));
    p.run(FIRST, 'journal');
    expect(p.journal().length).toBe(1);
    const acc = p.run(['owner-log', 'accept', 'X-1', '--by', 'owner'], acceptCrash);
    expect(acc.code, acc.all).not.toBe(0);
    expect(acc.all).toMatch(/doctor --fix/);
    // Nothing accepted was written (a recovery at the lock may have renamed the journal's own owner log into place).
    expect(readJson(p.data, 'owner-log.json').entries.filter((e: any) => e.accepted_by)).toEqual([]);
    const fix = p.run(['doctor', '--fix']);
    expect(p.journal(), fix.all).toEqual([]);
    expect(ids(p.data)).toEqual(['X-1', 'T-1']);
    const again = p.run(['owner-log', 'accept', 'X-1', '--by', 'owner']);
    expect(again.code, again.all).toBe(0);
    expect(again.all).toMatch(/Accepted 1 owner row/);
    consistent(p.data);
    expect(p.journal()).toEqual([]);
  });

  it('a hand edit over a kept journal is never written over: doctor --fix keeps it and says so', () => {
    const p = archiving({ store: { journalRecover: 'report' } });
    p.run(FIRST, 'journal');
    expect(p.journal().length).toBe(1);
    // The owner edits queue.json by hand while the journal is kept.
    const q = readJson(p.data, 'queue.json');
    q.tasks.push({ id: 'T-9', title: 'Added by hand', status: 'waiting', project: 'p', class: 'K' });
    fs.writeFileSync(path.join(p.data, 'queue.json'), JSON.stringify(q));
    const d = p.run(['doctor']);
    expect(d.all).toMatch(/queue\.json was changed by a later write/);
    const fix = p.run(['doctor', '--fix']);
    expect(fix.all).toMatch(/not finished, kept/);
    expect(ids(p.data)).toContain('T-9');
    consistent(p.data);
    // The journal stays for the owner, and a write still goes on (nothing in it can be finished any more).
    expect(p.journal().length).toBe(1);
    const r = p.run(SECOND);
    expect(r.code, r.all).toBe(0);
    expect(ids(p.data)).toEqual(['T-9', 'T-2']); // D-1 is archived by this write
    consistent(p.data);
  });
});
