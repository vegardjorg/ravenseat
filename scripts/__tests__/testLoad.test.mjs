// =============================================================
// testLoad.test.mjs: load-adaptive test runs in test:changed (scripts/test-load.mjs, roadmap 0s V9).
//
// Locks: a calm machine changes nothing (the vitest config's half the cores and 60 s stand); high CPU load or low free
// memory gives a quarter of the cores (at least 1) and 120 s test and hook timeouts; an unknown measurement never
// adapts; the setting testChanged.adaptLoad (default on) and RAVENSEAT_TEST_LOAD=off turn it off; the vitest flags and
// the one line say what changed and why.
// =============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { BUSY_CPU_PCT, LOW_FREE_PCT, adaptOn, loadLine, loadPlan, vitestLoadArgs } from '../test-load.mjs';

const roots = [];
afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});
function rootWith(config) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'test-load-'));
  roots.push(r);
  if (config) fs.writeFileSync(path.join(r, 'queue.config.json'), JSON.stringify(config));
  return r;
}

describe('loadPlan', () => {
  it('a calm machine changes nothing', () => {
    expect(loadPlan({ cpuPct: 20, freeMemoryPct: 60, cores: 8 })).toBe(null);
  });

  it('high CPU load: a quarter of the cores and 120 s timeouts', () => {
    expect(BUSY_CPU_PCT).toBe(70);
    const p = loadPlan({ cpuPct: 85, freeMemoryPct: 60, cores: 8 });
    expect(p).toMatchObject({ workers: 2, timeoutMs: 120_000 });
    expect(p.reason).toMatch(/CPU 85 %/);
  });

  it('low free memory adapts too', () => {
    expect(LOW_FREE_PCT).toBe(20);
    expect(loadPlan({ cpuPct: 10, freeMemoryPct: 12, cores: 8 })?.reason).toMatch(/free memory 12 %/);
  });

  it('never below one worker', () => {
    expect(loadPlan({ cpuPct: 95, freeMemoryPct: 50, cores: 2 })?.workers).toBe(1);
  });

  it('an unknown measurement never adapts', () => {
    expect(loadPlan({ cpuPct: null, freeMemoryPct: null, cores: 8 })).toBe(null);
  });
});

describe('the flags and the line', () => {
  it('gives vitest fewer workers and longer timeouts', () => {
    expect(vitestLoadArgs({ workers: 2, timeoutMs: 120_000 })).toEqual(['--maxWorkers=2', '--testTimeout=120000', '--hookTimeout=120000']);
    expect(vitestLoadArgs(null)).toEqual([]);
  });

  it('says what changed and why, in one line', () => {
    const line = loadLine({ workers: 2, timeoutMs: 120_000, reason: 'CPU 85 % busy' });
    expect(line).toMatch(/^test:changed: the machine is busy \(CPU 85 % busy\)/);
    expect(line).toMatch(/2 vitest workers/);
    expect(line).toMatch(/120 s/);
    expect(line).toMatch(/testChanged\.adaptLoad/);
  });
});

describe('the setting testChanged.adaptLoad', () => {
  it('is on by default and without a config', () => {
    expect(adaptOn(rootWith(null), {})).toBe(true);
    expect(adaptOn(rootWith({}), {})).toBe(true);
  });

  it('false in the config or RAVENSEAT_TEST_LOAD=off turns it off', () => {
    expect(adaptOn(rootWith({ testChanged: { adaptLoad: false } }), {})).toBe(false);
    expect(adaptOn(rootWith({}), { RAVENSEAT_TEST_LOAD: 'off' })).toBe(false);
  });
});
