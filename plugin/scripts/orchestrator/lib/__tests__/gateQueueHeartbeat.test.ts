// =============================================================
// gateQueueHeartbeat.test.ts: the heartbeat on a HELD gate queue slot (lib/gateQueue.js, roadmap 0s V11).
//
// Locks: a holder that declares a heartbeat (staleSec in holder.json) is judged by it: held while holder.json was
// touched within staleSec, stale once it was not, and never by the old 3 hour age rule while it beats; a beating holder
// is still stale after the safety ceiling (6 hours) and when its process is gone. A holder without the field (an older
// Ravenseat sharing the folder, or gateQueue.staleMin 0) keeps the 3 hour rule. startBeat touches the file and stops
// cleanly, also when the slot was taken away. The setting gateQueue.staleMin: default 5, 0 = the old rule.
// Every test has its own temp root.
// =============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const GQ = require('../gateQueue.js');

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});
function rootDir() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-queue-beat-'));
  roots.push(r);
  return path.join(r, 'q');
}

const NOW = Date.parse('2026-11-23T02:00:00Z');
const alive = () => true;
const dead = () => false;
const HOUR = 3_600_000;

describe('the setting gateQueue.staleMin', () => {
  it('is 5 minutes by default, takes the config, and 0 means the old 3 hour rule', () => {
    expect(GQ.setupFrom({}, {}).staleMin).toBe(5);
    expect(GQ.setupFrom({ gateQueue: { staleMin: 12 } }, {}).staleMin).toBe(12);
    expect(GQ.setupFrom({ gateQueue: { staleMin: 0 } }, {}).staleMin).toBe(0);
    expect(GQ.setupFrom({ gateQueue: { staleMin: -1 } }, {}).staleMin).toBe(5);
    expect(GQ.setupFrom({ gateQueue: { staleMin: 'x' } }, {}).staleMin).toBe(5);
  });

  it('gives the holder fields: the beat and the stale time, or none with 0', () => {
    expect(GQ.beatFields({ staleMin: 5 })).toEqual({ beatSec: 30, staleSec: 300 });
    expect(GQ.beatFields({ staleMin: 0 })).toEqual({});
  });
});

describe('a holder with a heartbeat', () => {
  const beating = (startedAgoMs: number) => ({ pid: 42, started: new Date(NOW - startedAgoMs).toISOString(), beatSec: 30, staleSec: 300 });

  it('is held while holder.json was touched within staleSec', () => {
    expect(GQ.staleReason(beating(60_000), { now: NOW, alive, mtimeMs: NOW - 200_000 })).toBe(null);
  });

  it('is stale once the heartbeat stopped, though the pid lives', () => {
    expect(GQ.staleReason(beating(60_000), { now: NOW, alive, mtimeMs: NOW - 400_000 })).toMatch(/heartbeat stopped/);
  });

  it('is not stale after 3 hours while it beats (a long full gate keeps its slot)', () => {
    expect(GQ.staleReason(beating(4 * HOUR), { now: NOW, alive, mtimeMs: NOW - 10_000 })).toBe(null);
  });

  it('is stale after the safety ceiling even when it beats', () => {
    expect(GQ.MAX_HELD_MS).toBe(6 * HOUR);
    expect(GQ.staleReason(beating(6 * HOUR + 1000), { now: NOW, alive, mtimeMs: NOW - 10_000 })).toMatch(/6 hours/);
  });

  it('is stale when the process is gone, as before', () => {
    expect(GQ.staleReason(beating(60_000), { now: NOW, alive: dead, mtimeMs: NOW })).toMatch(/42 is gone/);
  });

  it('a holder without the field keeps the 3 hour rule (an older version sharing the folder)', () => {
    const old = { pid: 42, started: new Date(NOW - 2 * HOUR).toISOString() };
    expect(GQ.staleReason(old, { now: NOW, alive, mtimeMs: NOW - 2 * HOUR })).toBe(null);
    const older = { pid: 42, started: new Date(NOW - 3 * HOUR - 1000).toISOString() };
    expect(GQ.staleReason(older, { now: NOW, alive, mtimeMs: NOW })).toMatch(/3 hours/);
  });
});

describe('startBeat', () => {
  it('touches holder.json while the slot is held and stops cleanly', async () => {
    const root = rootDir();
    const got = GQ.tryAcquire({ root, slots: 1, who: { project: 'p', kind: 'heavy', ...GQ.beatFields({ staleMin: 5 }) } });
    expect(got.ok).toBe(true);
    const file = path.join(got.slot.dir, 'holder.json');
    const old = (Date.now() - 10 * 60_000) / 1000;
    fs.utimesSync(file, old, old);
    const beat = GQ.startBeat(got.slot, { everyMs: 20 });
    await new Promise((r) => setTimeout(r, 120));
    beat.stop();
    expect(Date.now() - fs.statSync(file).mtimeMs).toBeLessThan(60_000);
    // The holder text is unchanged: only the time moves (takeOver compares the text).
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ project: 'p', beatSec: 30, staleSec: 300 });
    expect(GQ.release(got.slot)).toBe(true);
  });

  it('never throws and stops by itself when the slot was taken away', async () => {
    const root = rootDir();
    const got = GQ.tryAcquire({ root, slots: 1, who: { ...GQ.beatFields({ staleMin: 5 }) } });
    const beat = GQ.startBeat(got.slot, { everyMs: 10 });
    fs.rmSync(got.slot.dir, { recursive: true, force: true });
    await new Promise((r) => setTimeout(r, 60));
    expect(beat.stopped()).toBe(true);
    // It never wrote the folder back.
    expect(fs.existsSync(got.slot.dir)).toBe(false);
    beat.stop();
  });

  it('a slot without a beat (startBeat of null) is a no-op', () => {
    const beat = GQ.startBeat(null);
    expect(beat.stopped()).toBe(true);
    beat.stop();
  });
});
