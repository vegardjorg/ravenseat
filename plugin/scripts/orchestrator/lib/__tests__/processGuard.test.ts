// =============================================================
// processGuard.test.ts: the process guard (roadmap 0s part A, lib/processGuard.js).
//
// Locks: (1) the settings and their defaults (register and sweep on; autoKill and lowerPriority off; overtime factor 2);
// (2) the meta a caller hands the guard (lib/treeRun.js): the registry folder only with register on, a short command
// label without values, the track tag, lower priority only for heavy kinds; the child environment keeps the track tag
// and drops the meta; (3) the register: one file per process, read back, removed at the end; (4) the sweep: a dead
// entry is pruned, a live one whose owner is gone or that is over its max time is a finding with the stop command, a
// long heavy run without a track tag is shown apart, nothing else; (5) the automatic stop is off by default and never
// ends a process it cannot confirm as Ravenseat's own guard; (6) overtime per track against factor x estimate;
// (7) priority: BELOW_NORMAL, never IDLE, and a failure is no error; (8) a real guard run registers itself while it
// runs, removes the file at the end, lowers its command's priority and tags it. Only processes this test starts run.
// =============================================================
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

type Entry = Record<string, unknown> & { pid: number; file?: string };
type Sweep = { left: (Entry & { why: string; ageMs: number })[]; untagged: (Entry & { ageMs: number })[]; gone: string[] };
/* eslint-disable @typescript-eslint/no-require-imports */
const PG = require('../processGuard.js') as {
  META_ENV: string;
  TRACK_ENV: string;
  UNTAGGED_LONG_MS: number;
  SLACK_MS: number;
  setupOf: (cfg?: object) => { register: boolean; sweep: boolean; autoKill: boolean; lowerPriority: boolean; overtimeFactor: number };
  metaFor: (cfg: object, x: { folder: string; kind: string; track?: string | null; maxMs?: number | null; command?: string }) => string | null;
  withMeta: (env: Record<string, string | undefined>, meta: string | null) => Record<string, string | undefined>;
  childEnv: (env: Record<string, string | undefined>) => Record<string, string | undefined>;
  readMeta: (env: Record<string, string | undefined>) => Record<string, unknown> | null;
  register: (meta: Record<string, unknown>, x: { pid: number; parentPid: number; now?: number }) => string | null;
  unregister: (file: string | null) => void;
  readRegister: (dir: string) => Entry[];
  classify: (entries: Entry[], x: { now: number; alive: (pid: number) => boolean }) => Sweep;
  stopCommand: (pid: number, platform?: string) => string;
  autoStop: (left: Entry[], x: { on: boolean; identify: (pid: number) => boolean; killTree: (pid: number) => void }) => number[];
  overtimeTracks: (tasks: object[], x: { now: number; factor: number }) => { id: string; elapsedMin: number; estimateMin: number }[];
  lowerSelf: (x?: { os?: object }) => boolean;
  doctorRows: (s: Sweep, x: { platform?: string; overtime?: object[]; factor?: number; now?: number }) => { status: string; name: string; message: string; fix: string | null }[];
  pulseItems: (s: Sweep, x?: { platform?: string }) => string[];
};
const TR_PATH = path.join(__dirname, '..', 'treeRun.js');

const temps: string[] = [];
const tempDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-'));
  temps.push(d);
  return d;
};
afterAll(() => {
  for (const d of temps) fs.rmSync(d, { recursive: true, force: true });
});

describe('settings', () => {
  it('has the defaults: register, sweep and lower priority on, the automatic stop off, overtime at 2x', () => {
    expect(PG.setupOf({})).toEqual({ register: true, sweep: true, autoKill: false, lowerPriority: false, overtimeFactor: 2 });
  });
  it('takes the project values, and a bad factor falls back to the default', () => {
    const s = PG.setupOf({ processGuard: { register: false, autoKill: true, lowerPriority: false }, tracks: { overtimeFactor: 0 } });
    expect(s).toMatchObject({ register: false, autoKill: true, lowerPriority: false, overtimeFactor: 0 });
    expect(PG.setupOf({ tracks: { overtimeFactor: 'x' } }).overtimeFactor).toBe(2);
  });
});

describe('meta for the guard', () => {
  it('names the registry folder, the owner and the max time, and a short label without values', () => {
    const m = JSON.parse(PG.metaFor({}, { folder: '/data', kind: 'gate', track: 'T-1', maxMs: 60_000, command: 'API_KEY=abc123 npm run test -- --reporter dot' }) as string);
    expect(m.dir).toBe(path.join('/data', 'processes'));
    expect(m).toMatchObject({ kind: 'gate', track: 'T-1', owner: 'T-1', maxMs: 60_000, lower: false });
    expect(m.label).not.toContain('abc123');
    expect(m.label).toContain('npm run test');
  });
  it('has no folder with register off, and no meta at all when nothing is on', () => {
    const m = JSON.parse(PG.metaFor({ processGuard: { register: false, lowerPriority: true } }, { folder: '/data', kind: 'gate' }) as string);
    expect(m.dir).toBeNull();
    expect(PG.metaFor({ processGuard: { register: false, lowerPriority: false } }, { folder: '/data', kind: 'gate' })).toBeNull();
  });
  it('lowers nothing by default; with lowerPriority on, only heavy kinds (gate, done, base), never the wait runner', () => {
    expect(JSON.parse(PG.metaFor({}, { folder: '/d', kind: 'done' }) as string).lower).toBe(false);
    const on = { processGuard: { lowerPriority: true } };
    expect(JSON.parse(PG.metaFor(on, { folder: '/d', kind: 'wait' }) as string).lower).toBe(false);
    expect(JSON.parse(PG.metaFor(on, { folder: '/d', kind: 'done' }) as string).lower).toBe(true);
  });
  it('the owner is the command label when there is no track', () => {
    expect(JSON.parse(PG.metaFor({}, { folder: '/d', kind: 'base', command: 'npm test' }) as string).owner).toBe('base: npm test');
  });
  it('tags the environment with the track, and the child keeps the tag but not the meta', () => {
    const meta = PG.metaFor({}, { folder: '/d', kind: 'gate', track: 'T-9' });
    const env = PG.withMeta({ PATH: 'x' }, meta);
    expect(env[PG.TRACK_ENV]).toBe('T-9');
    expect(PG.readMeta(env)?.track).toBe('T-9');
    const child = PG.childEnv(env);
    expect(child[PG.META_ENV]).toBeUndefined();
    expect(child[PG.TRACK_ENV]).toBe('T-9');
    expect(child.PATH).toBe('x');
  });
  it('keeps a track tag the caller already had, and no meta leaves the environment as it was', () => {
    expect(PG.withMeta({ [PG.TRACK_ENV]: 'OLD' }, PG.metaFor({}, { folder: '/d', kind: 'gate' }))[PG.TRACK_ENV]).toBe('OLD');
    expect(PG.withMeta({ A: '1' }, null)).toEqual({ A: '1' });
    expect(PG.readMeta({ [PG.META_ENV]: '{not json' })).toBeNull();
  });
});

describe('the register', () => {
  it('writes one file per process, reads it back and removes it', () => {
    const dir = path.join(tempDir(), 'processes');
    const file = PG.register({ dir, kind: 'gate', owner: 'T-1', track: 'T-1', maxMs: 1000, label: 'npm test' }, { pid: 4242, parentPid: 1, now: 5 });
    expect(file).toBe(path.join(dir, '4242.json'));
    const [e] = PG.readRegister(dir);
    expect(e).toMatchObject({ pid: 4242, parentPid: 1, kind: 'gate', owner: 'T-1', track: 'T-1', maxMs: 1000, label: 'npm test', startedAt: new Date(5).toISOString() });
    PG.unregister(file);
    expect(PG.readRegister(dir)).toEqual([]);
  });
  it('writes nothing without a folder and never throws', () => {
    expect(PG.register({ dir: null }, { pid: 1, parentPid: 1 })).toBeNull();
    expect(PG.readRegister(path.join(tempDir(), 'none'))).toEqual([]);
    expect(() => PG.unregister(path.join(tempDir(), 'none.json'))).not.toThrow();
  });
});

describe('the sweep', () => {
  const now = Date.parse('2026-11-23T12:00:00Z');
  const at = (min: number) => new Date(now - min * 60_000).toISOString();
  const entry = (pid: number, x: object = {}): Entry => ({ pid, parentPid: 100, kind: 'gate', owner: 'T-1', track: 'T-1', maxMs: 600_000, startedAt: at(1), file: `/r/${pid}.json`, ...x });
  const alive = (pid: number) => [1, 2, 3, 4, 5, 100].includes(pid);

  it('prunes dead entries, finds the ones that outlived their owner or their max time, and shows long untagged runs', () => {
    const s = PG.classify(
      [
        entry(9), // dead
        entry(1, { parentPid: 999 }), // owner gone
        entry(2, { startedAt: at(20) }), // over 10 min + slack
        entry(3, { track: null, owner: 'base: npm test', maxMs: null, startedAt: at(40) }), // untagged, long
        entry(4, { startedAt: at(5) }), // fine
        entry(5, { track: null, kind: 'wait', maxMs: null, startedAt: at(90) }), // not heavy: not shown
      ],
      { now, alive },
    );
    expect(s.gone).toEqual(['/r/9.json']);
    expect(s.left.map((e) => [e.pid, e.why])).toEqual([
      [1, 'owner gone'],
      [2, 'over time'],
    ]);
    expect(s.untagged.map((e) => e.pid)).toEqual([3]);
  });
  it('a run just over its max time is not a finding yet (slack)', () => {
    const s = PG.classify([entry(2, { maxMs: 600_000, startedAt: new Date(now - 600_000 - PG.SLACK_MS + 1000).toISOString() })], { now, alive });
    expect(s.left).toEqual([]);
  });
  it('names the stop command for the platform: the whole tree', () => {
    expect(PG.stopCommand(77, 'win32')).toBe('taskkill /pid 77 /T /F');
    expect(PG.stopCommand(77, 'linux')).toBe('kill -KILL -- -77');
  });
  it('doctor and the pulse name pid, owner, age and the stop command', () => {
    const s = PG.classify([entry(1, { parentPid: 999, startedAt: at(75) })], { now, alive });
    const rows = PG.doctorRows(s, { platform: 'linux' });
    expect(rows[0]).toMatchObject({ status: 'WARN', name: 'processes' });
    expect(rows[0].message).toContain('pid 1');
    expect(rows[0].message).toContain('T-1');
    expect(rows[0].message).toContain('1 h 15 min');
    expect(rows[0].fix).toContain('kill -KILL -- -1');
    const items = PG.pulseItems(s, { platform: 'win32' });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatch(/^PROCESS 1: /);
    expect(items[0]).toContain('taskkill /pid 1 /T /F');
  });
  it('nothing to say gives an OK row and no pulse item', () => {
    const s = PG.classify([], { now, alive });
    expect(PG.doctorRows(s, {})).toEqual([{ status: 'OK', name: 'processes', message: 'no process Ravenseat started is left over', fix: null }]);
    expect(PG.pulseItems(s)).toEqual([]);
  });
  it('untagged long runs are an INFO row, display only', () => {
    const s = PG.classify([entry(3, { track: null, owner: 'base: npm test', maxMs: null, startedAt: at(40) })], { now, alive });
    const rows = PG.doctorRows(s, { platform: 'linux' });
    expect(rows.map((r) => r.status)).toEqual(['OK', 'INFO']);
    expect(rows[1].message).toContain('pid 3');
    expect(PG.pulseItems(s)).toEqual([]);
  });
});

describe('the automatic stop', () => {
  const left = [{ pid: 11 }, { pid: 12 }] as Entry[];
  it('is off by default and then stops nothing', () => {
    const killed: number[] = [];
    expect(PG.autoStop(left, { on: false, identify: () => true, killTree: (p) => killed.push(p) })).toEqual([]);
    expect(killed).toEqual([]);
  });
  it('stops only what it can confirm as its own guard', () => {
    const killed: number[] = [];
    expect(PG.autoStop(left, { on: true, identify: (p) => p === 12, killTree: (p) => killed.push(p) })).toEqual([12]);
    expect(killed).toEqual([12]);
  });
});

describe('overtime per track', () => {
  const now = Date.parse('2026-11-23T12:00:00Z');
  const started = (min: number) => new Date(now - min * 60_000).toISOString();
  it('a running track over factor x estimate is listed, with elapsed and estimate minutes', () => {
    // class K weight 1, content 30 min: estimate 30, so over 60 min at factor 2
    const tasks = [
      { id: 'A', status: 'running', class: 'K', content_min: 30, started: started(70) },
      { id: 'B', status: 'running', class: 'K', content_min: 30, started: started(50) },
      { id: 'C', status: 'review', class: 'K', content_min: 30, started: started(300) },
      { id: 'D', status: 'running', class: 'K', content_min: 30 },
    ];
    expect(PG.overtimeTracks(tasks, { now, factor: 2 })).toEqual([{ id: 'A', elapsedMin: 70, estimateMin: 30 }]);
  });
  it('factor 0 turns it off', () => {
    expect(PG.overtimeTracks([{ id: 'A', status: 'running', content_min: 1, started: started(500) }], { now, factor: 0 })).toEqual([]);
  });
  it('doctor warns per track, never fails', () => {
    const rows = PG.doctorRows(PG.classify([], { now, alive: () => false }), { overtime: [{ id: 'A', elapsedMin: 70, estimateMin: 30 }], factor: 2 });
    const o = rows.find((r) => r.name === 'overtime');
    expect(o?.status).toBe('WARN');
    expect(o?.message).toContain('A');
    expect(o?.message).toContain('70 min');
  });
});

describe('priority', () => {
  it('asks for BELOW_NORMAL on this process, never IDLE', () => {
    const calls: number[][] = [];
    const fake = { constants: os.constants, setPriority: (a: number, b?: number) => calls.push(b === undefined ? [a] : [a, b]) };
    expect(PG.lowerSelf({ os: fake })).toBe(true);
    expect(calls).toEqual([[0, os.constants.priority.PRIORITY_BELOW_NORMAL]]);
    expect(calls.flat()).not.toContain(os.constants.priority.PRIORITY_LOWEST);
  });
  it('a refusal is no error', () => {
    const fake = { constants: os.constants, setPriority: () => { throw new Error('EACCES'); } };
    expect(PG.lowerSelf({ os: fake })).toBe(false);
  });
});

describe('the hook-ins (doctor, pulse, Checks)', () => {
  type Rows = { status: string; name: string; message: string; fix: string | null }[];
  const H = PG as unknown as {
    rowsFor: (x: object) => Rows;
    pulseFor: (x: object) => string[];
    factsFor: (x: object) => { left: { pid: number; stop: string }[]; untagged: object[]; overtime: object[]; factor: number };
    cardLine: (key: string, f: object) => string | null;
  };
  // A pid that is surely gone: a process this test started and that has ended.
  const deadPid = () => spawnSync(process.execPath, ['-e', '0']).pid as number;
  const setUp = () => {
    const folder = tempDir();
    const dir = path.join(folder, 'processes');
    const old = new Date(Date.now() - 5 * 60_000).toISOString();
    fs.mkdirSync(dir, { recursive: true });
    // This test's own process, registered as if its starter were gone: a finding that must never be stopped (not a guard).
    fs.writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify({ pid: process.pid, parentPid: deadPid(), kind: 'gate', owner: 'T-1', track: 'T-1', maxMs: null, startedAt: old }));
    const stale = path.join(dir, `${deadPid()}.json`);
    fs.writeFileSync(stale, JSON.stringify({ pid: Number(path.basename(stale, '.json')), parentPid: 1, kind: 'gate', startedAt: old }));
    fs.utimesSync(stale, new Date(Date.now() - 10 * 60_000), new Date(Date.now() - 10 * 60_000));
    return { folder, stale };
  };

  it('doctor: a WARN row for the finding, the stale file removed, nothing stopped while autoKill is off', () => {
    const { folder, stale } = setUp();
    const killed: number[] = [];
    const rows = H.rowsFor({ folder, cfg: {}, tasks: [], killTree: (p: number) => killed.push(p) });
    expect(rows[0]).toMatchObject({ status: 'WARN', name: 'processes' });
    expect(rows[0].message).toContain(`pid ${process.pid}`);
    expect(fs.existsSync(stale)).toBe(false);
    expect(killed).toEqual([]);
  });
  it('autoKill on still leaves a process it cannot confirm as its own guard', () => {
    const { folder } = setUp();
    const killed: number[] = [];
    H.rowsFor({ folder, cfg: { processGuard: { autoKill: true } }, tasks: [], killTree: (p: number) => killed.push(p) });
    expect(killed).toEqual([]);
  }, 30_000);
  it('the pulse names it; sweep off gives no row and no line', () => {
    const { folder } = setUp();
    expect(H.pulseFor({ folder, cfg: {}, killTree: () => {} })[0]).toMatch(new RegExp(`^PROCESS ${process.pid}: `));
    expect(H.pulseFor({ folder, cfg: { processGuard: { sweep: false } } })).toEqual([]);
    expect(H.rowsFor({ folder, cfg: { processGuard: { sweep: false } }, tasks: [] })).toEqual([]);
  });
  it('the Checks facts and card lines name pid, owner, age and the stop command', () => {
    const { folder } = setUp();
    const f = H.factsFor({ folder, cfg: {}, tasks: [], platform: 'win32' });
    expect(f.left.map((e) => e.pid)).toEqual([process.pid]);
    const line = H.cardLine('processes-left', f) as string;
    expect(line).toContain(`pid ${process.pid} (T-1, 5 min, owner gone)`);
    expect(line).toContain(`taskkill /pid ${process.pid} /T /F`);
    expect(H.cardLine('tracks-overtime', { overtime: [{ id: 'A', elapsedMin: 70, estimateMin: 30 }], factor: 2 })).toBe('Over 2x the estimate: A (70 min, estimate 30 min).');
    expect(H.cardLine('processes-untagged', f)).toBeNull();
  });
});

describe('a real guard run', () => {
  it('registers while it runs, removes the file after, lowers the command and tags it', () => {
    const data = tempDir();
    const meta = PG.metaFor({ processGuard: { lowerPriority: true } }, { folder: data, kind: 'gate', track: 'T-REAL', maxMs: 60_000, command: 'node -e probe' });
    const dir = path.join(data, 'processes');
    // The command: its own priority, its environment's tag and meta, and the register as it sees it while running.
    const script =
      `const fs=require('fs');const os=require('os');` +
      `const files=fs.readdirSync(${JSON.stringify(dir)});` +
      `console.log(JSON.stringify({prio:os.getPriority(),track:process.env.RAVENSEAT_TRACK??null,meta:process.env.RAVENSEAT_GUARD_META??null,files}))`;
    const r = spawnSync(process.execPath, [TR_PATH, 'guard', String(process.pid), 'exec', process.execPath, '-e', script], {
      encoding: 'utf8',
      env: PG.withMeta({ ...process.env }, meta),
      timeout: 30_000,
    });
    expect(r.status).toBe(0);
    const seen = JSON.parse(r.stdout.trim().split('\n').pop() as string);
    expect(seen.files).toHaveLength(1);
    expect(seen.track).toBe('T-REAL');
    expect(seen.meta).toBeNull();
    expect(seen.prio).toBe(os.constants.priority.PRIORITY_BELOW_NORMAL);
    expect(fs.readdirSync(dir)).toEqual([]);
  }, 60_000);
  it('identify confirms a real guard (one this test started, and ends)', async () => {
    const { spawn } = await import('node:child_process');
    const TR = require('../treeRun.js') as { killTree: (pid: number) => void; alive: (pid: number) => boolean };
    const g = spawn(process.execPath, [TR_PATH, 'guard', String(process.pid), 'exec', process.execPath, '-e', 'setTimeout(()=>{},60000)'], {
      stdio: 'ignore',
      detached: true,
      windowsHide: true,
    });
    try {
      await new Promise((r) => setTimeout(r, 500));
      const I = PG as unknown as { identify: (pid: number) => boolean };
      expect(I.identify(g.pid as number)).toBe(true);
    } finally {
      TR.killTree(g.pid as number);
    }
    for (let i = 0; i < 50 && TR.alive(g.pid as number); i++) await new Promise((r) => setTimeout(r, 100));
    expect(TR.alive(g.pid as number)).toBe(false);
  }, 60_000);
  it('without meta registers nothing and leaves the priority alone', () => {
    const r = spawnSync(process.execPath, [TR_PATH, 'guard', String(process.pid), 'exec', process.execPath, '-e', 'console.log(require("os").getPriority())'], {
      encoding: 'utf8',
      env: PG.childEnv({ ...process.env }),
      timeout: 30_000,
    });
    expect(r.status).toBe(0);
    expect(Number(r.stdout.trim())).toBe(os.getPriority());
  }, 60_000);
});
