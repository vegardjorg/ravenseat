// =============================================================
// gateQueue.test.ts: the shared queue for heavy gate runs (lib/gateQueue.js).
//
// Locks: a free slot is taken, a held one is not; a slot whose process is dead or that is older than 3 hours is taken over;
// a light run or a run without history does not queue; the time budget is counted from when the check starts, not from
// when it began to wait; a waiter says once who it waits for; a queue that cannot be used fails open.
// Every test has its own temp root, so it shares nothing with the machine's real queue or with other test files.
// The two-process flow is in __tests__/gateQueueFlow.test.ts.
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
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-queue-unit-'));
  roots.push(r);
  return path.join(r, 'q');
}

const NOW = Date.parse('2026-11-06T12:00:00Z');
const SETUP = { enabled: true, slots: 1, heavyAfterSec: 120, root: 'x' };
const who = { project: 'demo', kind: 'quick', track: 'A' };
const alive = () => true;
const dead = () => false;

function holdSlot(root: string, holder: Record<string, unknown>, i = 0) {
  const dir = path.join(root, `slot-${i}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'holder.json'), JSON.stringify(holder));
  return dir;
}

describe('settings', () => {
  it('has the agreed defaults', () => {
    const s = GQ.setupFrom({}, {});
    expect(s).toMatchObject({ enabled: true, slots: 1, heavyAfterSec: 120 });
    expect(s.root).toContain(os.tmpdir());
    expect(s.root).toContain('ravenseat-gate-queue');
  });

  it('takes the config, and invalid values give the defaults', () => {
    expect(GQ.setupFrom({ gateQueue: { enabled: false, slots: 3, heavyAfterSec: 10 } }, {})).toMatchObject({ enabled: false, slots: 3, heavyAfterSec: 10 });
    expect(GQ.setupFrom({ gateQueue: { slots: 0, heavyAfterSec: 'x' } }, {})).toMatchObject({ slots: 1, heavyAfterSec: 120 });
  });

  it('lets the environment override enabled and the root', () => {
    expect(GQ.setupFrom({}, { QUEUE_GATE_QUEUE: 'off' }).enabled).toBe(false);
    expect(GQ.setupFrom({ gateQueue: { enabled: false } }, { QUEUE_GATE_QUEUE: 'on' }).enabled).toBe(true);
    expect(GQ.setupFrom({}, { QUEUE_GATE_QUEUE_DIR: 'C:/own' }).root).toBe('C:/own');
  });
});

describe('light or heavy', () => {
  const row = (kind: string, sec: number) => JSON.stringify({ event: 'gate', kind, duration_s: sec });

  it('reads the newest row of the same kind', () => {
    const text = [row('quick', 500), row('full', 900), row('quick', 40), row('full', 700), '{"event":"agent"}', 'not json'].join('\n');
    expect(GQ.lastDurationSec(text, 'quick')).toBe(40);
    expect(GQ.lastDurationSec(text, 'full')).toBe(700);
  });

  it('has no duration without history', () => {
    expect(GQ.lastDurationSec(null, 'quick')).toBe(null);
    expect(GQ.lastDurationSec(row('full', 900), 'quick')).toBe(null);
  });

  it('needs a slot from heavyAfterSec, and a light check or one without history runs without the queue', () => {
    expect(GQ.needsSlot({ setup: SETUP, kind: 'quick', lastSec: 120 })).toBe(true);
    expect(GQ.needsSlot({ setup: SETUP, kind: 'full', lastSec: 900 })).toBe(true);
    expect(GQ.needsSlot({ setup: SETUP, kind: 'quick', lastSec: 119 })).toBe(false);
    expect(GQ.needsSlot({ setup: SETUP, kind: 'quick', lastSec: null })).toBe(false);
  });

  it('never queues when off or for another kind', () => {
    expect(GQ.needsSlot({ setup: { ...SETUP, enabled: false }, kind: 'full', lastSec: 900 })).toBe(false);
    expect(GQ.needsSlot({ setup: SETUP, kind: 'precheck', lastSec: 900 })).toBe(false);
  });
});

describe('the time budget', () => {
  it('runs from when the check starts, however long the wait was', () => {
    const asked = NOW;
    const startedAfterWait = NOW + 600_000;
    expect(GQ.budgetDeadline(startedAfterWait, 60)).toBe(startedAfterWait + 60_000);
    expect(GQ.budgetDeadline(startedAfterWait, 60)).toBeGreaterThan(asked + 60_000);
  });

  it('has no deadline without a budget', () => {
    expect(GQ.budgetDeadline(NOW, 0)).toBe(null);
    expect(GQ.budgetDeadline(NOW, Number.NaN)).toBe(null);
  });
});

describe('stale slots', () => {
  const held = { pid: 42, started: new Date(NOW - 60_000).toISOString() };

  it('is held while the process lives and is young', () => {
    expect(GQ.staleReason(held, { now: NOW, alive })).toBe(null);
  });

  it('is stale when the process is gone', () => {
    expect(GQ.staleReason(held, { now: NOW, alive: dead })).toMatch(/42 is gone/);
  });

  it('is stale after 3 hours even when the pid lives (a pid can be reused)', () => {
    const justUnder = { pid: 42, started: new Date(NOW - 3 * 3_600_000 + 1000).toISOString() };
    const over = { pid: 42, started: new Date(NOW - 3 * 3_600_000 - 1000).toISOString() };
    expect(GQ.staleReason(justUnder, { now: NOW, alive })).toBe(null);
    expect(GQ.staleReason(over, { now: NOW, alive })).toMatch(/3 hours/);
  });

  it('gives a slot without a holder file a minute to be written', () => {
    expect(GQ.staleReason(null, { now: NOW, mtimeMs: NOW - 5000 })).toBe(null);
    expect(GQ.staleReason(null, { now: NOW, mtimeMs: NOW - 120_000 })).toMatch(/no readable holder/);
  });
});

describe('tryAcquire and release', () => {
  it('takes a free slot and records who holds it', () => {
    const root = rootDir();
    const r = GQ.tryAcquire({ root, slots: 1, who, now: NOW, pid: 7, alive });
    expect(r.ok).toBe(true);
    const holder = JSON.parse(fs.readFileSync(path.join(root, 'slot-0', 'holder.json'), 'utf8'));
    expect(holder).toMatchObject({ pid: 7, project: 'demo', kind: 'quick', track: 'A', started: new Date(NOW).toISOString() });
  });

  it('refuses when the slot is held, and names the holder', () => {
    const root = rootDir();
    expect(GQ.tryAcquire({ root, slots: 1, who, now: NOW, pid: 7, alive }).ok).toBe(true);
    const r = GQ.tryAcquire({ root, slots: 1, who, now: NOW, pid: 8, alive });
    expect(r.ok).toBe(false);
    expect(r.holders).toHaveLength(1);
    expect(r.holders[0].pid).toBe(7);
  });

  it('uses the next slot when there are more', () => {
    const root = rootDir();
    expect(GQ.tryAcquire({ root, slots: 2, who, now: NOW, pid: 7, alive }).ok).toBe(true);
    const second = GQ.tryAcquire({ root, slots: 2, who, now: NOW, pid: 8, alive });
    expect(second.ok).toBe(true);
    expect(second.slot.dir).toMatch(/slot-1$/);
    expect(GQ.tryAcquire({ root, slots: 2, who, now: NOW, pid: 9, alive }).ok).toBe(false);
  });

  it('takes over a slot whose process is dead', () => {
    const root = rootDir();
    holdSlot(root, { pid: 111, started: new Date(NOW - 1000).toISOString() });
    const r = GQ.tryAcquire({ root, slots: 1, who, now: NOW, pid: 7, alive: (p: number) => p !== 111 });
    expect(r.ok).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(root, 'slot-0', 'holder.json'), 'utf8')).pid).toBe(7);
    // Nothing is left beside the slot.
    expect(fs.readdirSync(root)).toEqual(['slot-0']);
  });

  it('takes over a slot older than 3 hours, even with a living pid', () => {
    const root = rootDir();
    holdSlot(root, { pid: 111, started: new Date(NOW - 4 * 3_600_000).toISOString() });
    expect(GQ.tryAcquire({ root, slots: 1, who, now: NOW, pid: 7, alive }).ok).toBe(true);
  });

  it('treats a holder with its own pid as a leftover (a reused pid)', () => {
    const root = rootDir();
    holdSlot(root, { pid: 7, started: new Date(NOW - 1000).toISOString() });
    expect(GQ.tryAcquire({ root, slots: 1, who, now: NOW, pid: 7, alive }).ok).toBe(true);
  });

  it('does not take away a slot that changed after it was judged stale', () => {
    const root = rootDir();
    const dir = holdSlot(root, { pid: 111, started: new Date(NOW).toISOString() });
    const seenBefore = { text: 'something else', holder: null, mtimeMs: NOW };
    expect(GQ.takeOver(dir, seenBefore, { pid: 7, now: NOW })).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'holder.json'), 'utf8')).pid).toBe(111);
  });

  it('frees the slot on release, and the next one gets it', () => {
    const root = rootDir();
    const a = GQ.tryAcquire({ root, slots: 1, who, now: NOW, pid: 7, alive });
    expect(GQ.release(a.slot)).toBe(true);
    expect(GQ.tryAcquire({ root, slots: 1, who, now: NOW, pid: 8, alive }).ok).toBe(true);
  });

  it('never releases a slot someone else took over', () => {
    const root = rootDir();
    const a = GQ.tryAcquire({ root, slots: 1, who, now: NOW, pid: 7, alive });
    fs.rmSync(a.slot.dir, { recursive: true });
    const b = GQ.tryAcquire({ root, slots: 1, who, now: NOW + 5, pid: 8, alive });
    expect(GQ.release(a.slot)).toBe(false);
    expect(fs.existsSync(b.slot.dir)).toBe(true);
  });

  it('release never throws on a slot that is gone, or on none', () => {
    expect(GQ.release(null)).toBe(false);
    expect(GQ.release({ dir: path.join(rootDir(), 'nothing'), holder: { pid: 1, started: 'x' } })).toBe(false);
  });
});

describe('acquireWait', () => {
  it('returns at once on a free slot', async () => {
    let waited = 0;
    const r = await GQ.acquireWait({ root: rootDir(), slots: 1, who, onWait: () => waited++, sleep: async () => {}, alive });
    expect(r.slot).toBeTruthy();
    expect(r.failedOpen).toBe(false);
    expect(waited).toBe(0);
  });

  it('polls every 3 seconds, says once who it waits for, and counts the wait', async () => {
    const root = rootDir();
    const dir = holdSlot(root, { pid: 111, kind: 'full', project: 'other', started: new Date().toISOString() });
    let now = NOW;
    const pauses: number[] = [];
    const lines: unknown[][] = [];
    const r = await GQ.acquireWait({
      root,
      slots: 1,
      who,
      pid: 7,
      alive,
      now: () => now,
      onWait: (h: unknown[]) => lines.push(h),
      sleep: async (ms: number) => {
        pauses.push(ms);
        now += ms;
        if (pauses.length === 3) fs.rmSync(dir, { recursive: true });
      },
    });
    expect(r.slot).toBeTruthy();
    expect(pauses).toEqual([3000, 3000, 3000]);
    expect(lines).toHaveLength(1);
    expect(r.waitSec).toBe(9);
  });

  it('fails open when the queue folder cannot be made', async () => {
    const parent = rootDir();
    fs.mkdirSync(path.dirname(parent), { recursive: true });
    fs.writeFileSync(parent, 'a file where the folder should be');
    const r = await GQ.acquireWait({ root: path.join(parent, 'q'), slots: 1, who, sleep: async () => {}, alive });
    expect(r.slot).toBe(null);
    expect(r.failedOpen).toBe(true);
  });
});

describe('the wait line', () => {
  it('says who it waits for and that the budget has not started', () => {
    const line = GQ.waitLine([{ pid: 12, kind: 'full', project: 'demo', track: 'B', started: new Date(NOW - 300_000).toISOString() }], { now: NOW, slots: 1 });
    expect(line).toContain('GATE QUEUE');
    expect(line).toContain('full gates of demo (B), pid 12, running for 5 min');
    expect(line).toContain('time budget starts');
  });
});
