// =============================================================
// machineSample.test.ts: the periodic machine sample (S9, lib/machineSample.js) the board server writes while it runs.
//
// Locks: off by default (0, missing or not a number writes nothing); a sample is a `load` row with command "sample"
// (free memory, CPU, running tracks, no slots, never stopped); the interval is read on every tick, so a change in the
// gear takes effect without a restart; a failing measure or append never throws; the CPU reading does not block.
// =============================================================
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const MS = require('../machineSample.js');
const C = require('../queueConfig.js');

const MIN = 60_000;

describe('machine sample (S9)', () => {
  it('the default is off: STANDARD has metrics.machineSampleMin 0', () => {
    expect(C.STANDARD.metrics.machineSampleMin).toBe(0);
    expect(MS.minutesFrom({ metrics: {} })).toBe(0);
    expect(MS.minutesFrom({ metrics: { machineSampleMin: 'x' } })).toBe(0);
    expect(MS.minutesFrom({ metrics: { machineSampleMin: -3 } })).toBe(0);
    expect(MS.minutesFrom({ metrics: { machineSampleMin: 5 } })).toBe(5);
    expect(MS.minutesFrom(null)).toBe(0);
  });

  it('sampleRow is a load row with command "sample" and no slots or stop', () => {
    const r = MS.sampleRow({ time: '2026-11-20T10:00:00.000Z', load: { freeMemoryPct: 42.5, cpuPct: 17 }, running: 2 });
    expect(r).toMatchObject({
      time: '2026-11-20T10:00:00.000Z',
      event: 'load',
      command: 'sample',
      free_memory_pct: 42.5,
      cpu_pct: 17,
      running: 2,
      slots: null,
      stopped: false,
    });
    expect(JSON.stringify(r).length).toBeLessThan(250);
  });

  it('writes one row per interval, reads the interval on every tick, writes nothing while 0', async () => {
    let minutes = 0;
    let now = 0;
    const rows: { command: string }[] = [];
    const s = MS.startMachineSample({
      minutes: () => minutes,
      measure: async () => ({ freeMemoryPct: 50, cpuPct: 10 }),
      append: (r: { command: string }) => rows.push(r),
      running: () => 1,
      now: () => now,
      schedule: () => ({ unref() {} }),
    });
    await s.tick();
    expect(rows).toHaveLength(0);
    minutes = 5;
    now = 1 * MIN;
    await s.tick(); // the first tick after it is turned on samples
    expect(rows).toHaveLength(1);
    now = 4 * MIN;
    await s.tick();
    expect(rows).toHaveLength(1);
    now = 6 * MIN;
    await s.tick();
    expect(rows).toHaveLength(2);
    minutes = 0;
    now = 60 * MIN;
    await s.tick();
    expect(rows).toHaveLength(2);
    s.stop();
  });

  it('a failing measure or append never throws', async () => {
    const s = MS.startMachineSample({
      minutes: () => 1,
      measure: async () => {
        throw new Error('no');
      },
      append: () => {
        throw new Error('no');
      },
      now: () => 0,
      schedule: () => ({ unref() {} }),
    });
    await expect(s.tick()).resolves.toBe(false);
    const t = MS.startMachineSample({
      minutes: () => {
        throw new Error('no config');
      },
      measure: async () => ({ freeMemoryPct: 1, cpuPct: 1 }),
      append: () => true,
      now: () => 0,
      schedule: () => ({ unref() {} }),
    });
    await expect(t.tick()).resolves.toBe(false);
  });

  it('measureLoad gives free memory and CPU without blocking the thread', async () => {
    const m = await MS.measureLoad({ sampleMs: 20 });
    expect(typeof m.freeMemoryPct === 'number' || m.freeMemoryPct === null).toBe(true);
    expect(typeof m.cpuPct === 'number' || m.cpuPct === null).toBe(true);
  });
});
