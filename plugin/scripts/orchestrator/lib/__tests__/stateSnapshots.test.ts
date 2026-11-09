// =============================================================
// stateSnapshots.test.ts: the rolling copies of queue.json (lib/stateSnapshots.js).
//
// Locks: (1) the tiers are read from the setting, a bad list falls back to the default and doctor names it; (2) a
// write fills the youngest tier first and moves a copy up a tier as it ages, never two tiers with the same copy;
// (3) nothing is copied while no tier is due, and a broken queue.json never pushes out a good copy; (4) the copies
// are made through the real write (stateFile.writeState) and can be turned off.
// Runs in a temporary folder; the clock is moved by setting the copies' mtime.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const SS = require('../stateSnapshots.js');
const SF = require('../stateFile.js');

const temporary: string[] = [];
afterAll(() => {
  for (const f of temporary) fs.rmSync(f, { recursive: true, force: true });
});

function folder() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-snapshots-'));
  temporary.push(d);
  return { d, file: path.join(d, 'queue.json') };
}
const state = (n: number) => JSON.stringify({ tasks: Array.from({ length: n }, (_, i) => ({ id: `T-${i}` })) });
const H = 3_600_000;

describe('the tiers', () => {
  it('reads ages in minutes, hours and days, shortest first, and turns off with enabled false', () => {
    expect(SS.tiersFrom({ tiers: ['1d', '30m', '5h'] }).map((t: { name: string }) => t.name)).toEqual(['30m', '5h', '1d']);
    expect(SS.tiersFrom(undefined).map((t: { name: string }) => t.name)).toEqual(SS.DEFAULT_TIERS);
    expect(SS.tiersFrom({ enabled: false })).toEqual([]);
  });

  it('a bad list falls back to the default, and doctor gets the reason', () => {
    expect(SS.tiersFrom({ tiers: ['1h', 'soon'] }).map((t: { name: string }) => t.name)).toEqual(SS.DEFAULT_TIERS);
    expect(SS.tierProblem({ tiers: ['1h', 'soon'] })).toContain('soon');
    expect(SS.tierProblem({ tiers: Array(9).fill('1h') })).toContain('at most');
    expect(SS.tierProblem({ tiers: ['1h', '7d'] })).toBeNull();
  });
});

describe('the roll', () => {
  const tiers = SS.tiersFrom({ tiers: ['1h', '5h', '1d'] });
  const age = (file: string, tier: string, ms: number, now: number) => {
    const t = (now - ms) / 1000;
    fs.utimesSync(SS.copyPath(file, tier), t, t);
  };
  const tasksIn = (file: string, tier: string) => JSON.parse(fs.readFileSync(SS.copyPath(file, tier), 'utf8')).tasks.length;

  it('fills the youngest tier first and moves the copies up as they age, with no two tiers alike', () => {
    const { file } = folder();
    const now = Date.now();
    fs.writeFileSync(file, state(1));
    expect(SS.roll(file, tiers, { now })).toEqual(['1h']);
    // Not due yet: nothing is copied.
    fs.writeFileSync(file, state(2));
    expect(SS.roll(file, tiers, { now })).toEqual([]);
    // An hour later the 1h copy moves up to 5h and the current state takes 1h.
    age(file, '1h', H, now);
    expect(SS.roll(file, tiers, { now })).toEqual(['5h', '1h']);
    expect(tasksIn(file, '5h')).toBe(1);
    expect(tasksIn(file, '1h')).toBe(2);
    // The 5h copy has reached 5 h: it moves to the empty 1d. The fresh 1h copy has not reached 1 h, so 5h stays empty
    // for now instead of taking a copy made a moment ago.
    age(file, '5h', 5 * H, now);
    fs.writeFileSync(file, state(3));
    expect(SS.roll(file, tiers, { now })).toEqual(['1d']);
    expect(fs.existsSync(SS.copyPath(file, '5h'))).toBe(false);
    // Once the 1h copy is an hour old: 1h moves to 5h, and the current state takes 1h.
    age(file, '1h', H, now);
    expect(SS.roll(file, tiers, { now })).toEqual(['5h', '1h']);
    expect([tasksIn(file, '1d'), tasksIn(file, '5h'), tasksIn(file, '1h')]).toEqual([1, 2, 3]);
  });

  it('many writes in a row on a new project fill only the youngest tier', () => {
    const { file } = folder();
    for (let i = 1; i <= 5; i++) {
      fs.writeFileSync(file, state(i));
      SS.roll(file, tiers);
    }
    expect(SS.list(file, tiers).map((x: { tier: string }) => x.tier)).toEqual(['1h']);
  });

  it('a broken queue.json never pushes out a good copy', () => {
    const { file } = folder();
    const now = Date.now();
    fs.writeFileSync(file, state(4));
    SS.roll(file, tiers, { now });
    age(file, '1h', H, now);
    fs.writeFileSync(file, '{ broken');
    SS.roll(file, tiers, { now });
    // The good copy moved up to 5h; 1h is not filled from the broken file.
    expect(tasksIn(file, '5h')).toBe(4);
    expect(fs.existsSync(SS.copyPath(file, '1h'))).toBe(false);
  });

  it('the list shows the copies youngest first with their task count', () => {
    const { file } = folder();
    fs.writeFileSync(file, state(2));
    SS.roll(file, tiers, { now: Date.now() });
    const l = SS.list(file, tiers);
    expect(l.map((x: { tier: string; tasks: number }) => [x.tier, x.tasks])).toEqual([['1h', 2]]);
  });
});

describe('through the real write', () => {
  it('writeState makes the copy of the state before the write, and none when it is turned off', () => {
    const { d, file } = folder();
    fs.writeFileSync(file, state(5));
    SF.writeState(file, state(6), { snapshots: SS.tiersFrom(undefined) });
    expect(JSON.parse(fs.readFileSync(SS.copyPath(file, '1h'), 'utf8')).tasks.length).toBe(5);
    const other = path.join(d, 'off');
    fs.mkdirSync(other);
    const file2 = path.join(other, 'queue.json');
    fs.writeFileSync(file2, state(1));
    SF.writeState(file2, state(2), { snapshots: SS.tiersFrom({ enabled: false }) });
    expect(fs.existsSync(SS.folderOf(file2))).toBe(false);
  });
});
