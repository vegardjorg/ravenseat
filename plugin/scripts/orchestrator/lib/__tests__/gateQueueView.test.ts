// =============================================================
// gateQueueView.test.ts: who holds a gate queue slot and who waits, for doctor and the pulse check
// (lib/gateQueueView.js, roadmap 0s V12). Display only.
//
// Locks: the snapshot names each live holder (slot, what, pid, age, heartbeat) and each live waiter in the order they
// are served; a stale slot and a dead waiter are left out, and reading never removes a ticket or a slot (doctor
// changes nothing). The doctor row is INFO (never WARN or FAIL) and absent when nothing is held or waited for, or when
// the queue is off. The pulse line is one line or null.
// =============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

const GQ = require('../gateQueue.js');
const V = require('../gateQueueView.js');

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});
function rootDir() {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-queue-view-'));
  roots.push(r);
  return path.join(r, 'q');
}

const NOW = Date.now();
const iso = (agoMs: number) => new Date(NOW - agoMs).toISOString();

function hold(root: string, i: number, holder: Record<string, unknown>) {
  const dir = path.join(root, `slot-${i}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'holder.json'), JSON.stringify(holder));
}
function ticket(root: string, t: Record<string, unknown>) {
  const dir = path.join(root, 'waiting');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${t.pid}-${Date.parse(String(t.arrived))}.json`);
  fs.writeFileSync(file, JSON.stringify(t));
  return file;
}

describe('the snapshot', () => {
  it('names the holder and the waiters in the order they are served', () => {
    const root = rootDir();
    hold(root, 0, { pid: 101, project: 'demo', kind: 'full', track: 'A-1', started: iso(12 * 60_000), beatSec: 30, staleSec: 300 });
    ticket(root, { pid: 202, project: 'demo', kind: 'quick', track: 'B-2', class: 'track', arrived: iso(3 * 60_000) });
    ticket(root, { pid: 303, project: 'other', kind: 'full', class: 'base', arrived: iso(60_000) });
    const s = V.snapshot({ root, slots: 1, now: NOW, alive: () => true });
    expect(s.holders).toHaveLength(1);
    expect(s.holders[0]).toMatchObject({ slot: 1, pid: 101, project: 'demo', kind: 'full', track: 'A-1', ageMin: 12 });
    expect(s.holders[0].beatAgoSec).toBeGreaterThanOrEqual(0);
    // base before track, whatever the arrival
    expect(s.waiters.map((w: { pid: number }) => w.pid)).toEqual([303, 202]);
    expect(s.waiters[0]).toMatchObject({ position: 1, class: 'base', waitMin: 1 });
    expect(s.waiters[1]).toMatchObject({ position: 2, class: 'track', waitMin: 3 });
  });

  it('leaves out a stale slot and a dead waiter, and removes nothing', () => {
    const root = rootDir();
    hold(root, 0, { pid: 101, project: 'demo', kind: 'full', started: iso(60_000) });
    const file = ticket(root, { pid: 202, project: 'demo', kind: 'quick', class: 'track', arrived: iso(60_000) });
    const s = V.snapshot({ root, slots: 1, now: NOW, alive: () => false });
    expect(s).toEqual({ holders: [], waiters: [] });
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(path.join(root, 'slot-0'))).toBe(true);
  });

  it('is empty for a folder that does not exist', () => {
    expect(V.snapshot({ root: path.join(rootDir(), 'none'), slots: 2, now: NOW })).toEqual({ holders: [], waiters: [] });
  });

  it('readLine with prune false keeps a dead ticket', () => {
    const root = rootDir();
    const file = ticket(root, { pid: 999999, class: 'track', arrived: iso(1000) });
    expect(GQ.readLine(root, { alive: () => false, prune: false })).toEqual([]);
    expect(fs.existsSync(file)).toBe(true);
    GQ.readLine(root, { alive: () => false });
    expect(fs.existsSync(file)).toBe(false);
  });
});

describe('the lines', () => {
  const snap = {
    holders: [{ slot: 1, pid: 101, project: 'demo', kind: 'full', track: 'A-1', ageMin: 12, beatAgoSec: 10 }],
    waiters: [{ position: 1, pid: 303, project: 'other', kind: 'heavy', class: 'base', waitMin: 1, command: 'npm test' }],
  };

  it('the doctor row is INFO with the holder and the waiters', () => {
    const rows = V.doctorRows(snap, { enabled: true, slots: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('INFO');
    expect(rows[0].name).toBe('gatequeue');
    expect(rows[0].message).toMatch(/slot 1: full gates of demo \(A-1\), pid 101, 12 min, heartbeat 10 s ago/);
    expect(rows[0].message).toMatch(/waiting: 1\. base heavy `npm test` of other, pid 303, 1 min/);
  });

  it('no doctor row when nothing is held or waited for, or with the queue off', () => {
    expect(V.doctorRows({ holders: [], waiters: [] }, { enabled: true, slots: 1 })).toEqual([]);
    expect(V.doctorRows(snap, { enabled: false, slots: 1 })).toEqual([]);
  });

  it('the pulse line is one line, or null', () => {
    const line = V.pulseLine(snap, { slots: 1 });
    expect(line).toMatch(/^GATE QUEUE: /);
    expect(line).not.toMatch(/\n/);
    expect(line).toMatch(/1 waiting/);
    expect(V.pulseLine({ holders: [], waiters: [] }, { slots: 1 })).toBe(null);
  });

  it('a heavy holder names its command, never more than a short part of it', () => {
    const long = `npm test ${'x'.repeat(300)}`;
    const rows = V.doctorRows({ holders: [{ slot: 1, pid: 5, project: 'p', kind: 'heavy', command: long, ageMin: 0 }], waiters: [] }, { enabled: true, slots: 1 });
    expect(rows[0].message).toMatch(/heavy `npm test x+…` of p/);
    expect(rows[0].message.length).toBeLessThan(300);
  });
});
