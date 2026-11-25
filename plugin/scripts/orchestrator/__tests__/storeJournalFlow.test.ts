// =============================================================
// storeJournalFlow.test.ts: the callers of store.transaction() (LAGRING step 7), through the CLI.
//
// A commit that stopped part way is planted with the real Store on the test's data folder and an fs that "crashes"
// right after the journal is written (every later call throws, as in a killed process): the journal and the tmp files
// are on disk, no target is renamed. Then:
//   - a queue write (`add`) finishes it BEFORE it reads, so the task of the stopped commit is kept, not overwritten;
//   - doctor names the journal in a row, and doctor --fix finishes it;
//   - `handover archive` finishes a stopped commit of the handover note and its archive first.
// =============================================================
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const QUEUE = path.resolve(__dirname, '..', 'queue.mjs');
const ST = require('../lib/store/index.js');

const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
});

function project() {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-journal-flow-'));
  temporary.push(folder);
  const repo = path.join(folder, 'repo');
  const data = path.join(folder, 'data');
  fs.mkdirSync(repo);
  fs.mkdirSync(data);
  const configFile = path.join(folder, 'queue.config.json');
  fs.writeFileSync(configFile, JSON.stringify({ baseBranch: 'main', mode: 'lite' }));
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
  const run = (args: string[]) => {
    const r = spawnSync(process.execPath, [QUEUE, ...args], { encoding: 'utf8', env, cwd: repo, timeout: 60_000 });
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
