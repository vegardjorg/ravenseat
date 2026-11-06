// =============================================================
// gateLoad.test.ts: the lowest free memory during a gate run and the line about load (lib/gateLoad.js), and the two new
// fields of the gate row (lib/timeLogRows.js).
//
// Locks: the sampler keeps the lowest value and its timer never keeps the process alive; the macOS exception is the load
// guard's; the line comes only for a red run below the limit; rows without the new values look as they did.
// That the line leaves a red run red is locked with real runs in __tests__/gateQueueFlow.test.ts.
// =============================================================
import { describe, expect, it } from 'vitest';

const GL = require('../gateLoad.js');
const TL = require('../timeLogRows.js');

describe('startSampler', () => {
  /** A fake timer: tick() is one interval. */
  function fakes(values: Array<number | null>) {
    let fn = () => {};
    let unref = 0;
    let cleared = 0;
    let i = 0;
    return {
      measure: () => ({ freeMemoryPct: values[Math.min(i++, values.length - 1)] }),
      setTimer: (f: () => void, ms: number) => {
        fn = f;
        expect(ms).toBe(30_000);
        return { unref: () => unref++ };
      },
      clearTimer: () => cleared++,
      tick: () => fn(),
      unrefCount: () => unref,
      clearedCount: () => cleared,
    };
  }

  it('keeps the lowest value of the start, the ticks and the end', () => {
    const f = fakes([40, 12, 33, 25]);
    const s = GL.startSampler({ measure: f.measure, setTimer: f.setTimer, clearTimer: f.clearTimer });
    f.tick();
    f.tick();
    expect(s.stop()).toBe(12);
  });

  it('unrefs the timer and clears it', () => {
    const f = fakes([40]);
    const s = GL.startSampler({ measure: f.measure, setTimer: f.setTimer, clearTimer: f.clearTimer });
    s.stop();
    expect(f.unrefCount()).toBe(1);
    expect(f.clearedCount()).toBe(1);
  });

  it('gives null when nothing could be measured, and a throwing measure hurts nothing', () => {
    const f = fakes([null]);
    expect(GL.startSampler({ measure: f.measure, setTimer: f.setTimer, clearTimer: f.clearTimer }).stop()).toBe(null);
    const s = GL.startSampler({
      measure: () => {
        throw new Error('no');
      },
      setTimer: f.setTimer,
      clearTimer: f.clearTimer,
    });
    expect(s.stop()).toBe(null);
  });
});

describe('samplingOn: the macOS exception', () => {
  it('samples everywhere but macOS', () => {
    expect(GL.samplingOn({ platform: 'win32' })).toBe(true);
    expect(GL.samplingOn({ platform: 'linux' })).toBe(true);
    expect(GL.samplingOn({ platform: 'darwin' })).toBe(false);
  });

  it('samples on macOS with a limit set by hand or a replaced measurement', () => {
    expect(GL.samplingOn({ platform: 'darwin', limit: 10 })).toBe(true);
    expect(GL.samplingOn({ platform: 'darwin', overridden: true })).toBe(true);
  });
});

describe('loadLine', () => {
  it('names the figure and the limit on a red run below the limit', () => {
    const line = GL.loadLine({ red: true, minFreePct: 4, limitPct: 10 });
    expect(line).toContain('4 %');
    expect(line).toContain('10 %');
    expect(line).toContain('probably load');
    expect(line).toContain('still counts as red');
  });

  it('says nothing on a green run', () => {
    expect(GL.loadLine({ red: false, minFreePct: 4, limitPct: 10 })).toBe(null);
  });

  it('says nothing at or above the limit, or without a figure or a limit', () => {
    expect(GL.loadLine({ red: true, minFreePct: 10, limitPct: 10 })).toBe(null);
    expect(GL.loadLine({ red: true, minFreePct: 40, limitPct: 10 })).toBe(null);
    expect(GL.loadLine({ red: true, minFreePct: null, limitPct: 10 })).toBe(null);
    expect(GL.loadLine({ red: true, minFreePct: 4, limitPct: null })).toBe(null);
    expect(GL.loadLine({ red: true, minFreePct: 4, limitPct: 0 })).toBe(null);
  });

  it('never uses the phrase cli/merge.mjs reads as a timeout', () => {
    expect(GL.loadLine({ red: true, minFreePct: 4, limitPct: 10 })).not.toMatch(/time budget/);
  });
});

describe('the gate row', () => {
  const base = { kind: 'quick', gates: ['a'], durationSec: 3, exit: 0 };

  it('carries the wait and the lowest free memory', () => {
    const row = TL.gateRow({ ...base, waitSec: 12.5, minFreeMemoryPct: 8 });
    expect(row.wait_sec).toBe(12.5);
    expect(row.min_free_memory_pct).toBe(8);
  });

  it('keeps a 0, and has neither field without values', () => {
    expect(TL.gateRow({ ...base, waitSec: 0, minFreeMemoryPct: 0 })).toMatchObject({ wait_sec: 0, min_free_memory_pct: 0 });
    const row = TL.gateRow({ ...base, waitSec: null, minFreeMemoryPct: null });
    expect(row).not.toHaveProperty('wait_sec');
    expect(row).not.toHaveProperty('min_free_memory_pct');
    expect(TL.gateRow(base)).not.toHaveProperty('wait_sec');
  });
});
