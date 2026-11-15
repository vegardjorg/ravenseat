// =============================================================
// machineAdvice.test.ts: the suggested number of parallel tracks (lib/machineAdvice.js).
//
// Locks: the rule and its figures (2026-11-15: an agent costs about 0.1 GB, a light quick check about 0.6 GB, one heavy
// check counts once because of the gate queue), free memory instead of the fixed part when it is known, the core cap with
// and without the gate queue, the row in doctor (OK or WARN, never FAIL), the estimate label wherever the number is shown,
// the measured suggestion (full and quick check) and the QUEUE_MACHINE override.
// =============================================================
import { describe, expect, it } from 'vitest';

const M = require('../machineAdvice.js');

describe('suggestedTracks', () => {
  it('gives the figures for a light project from memory and cores', () => {
    // (16 - 8 system and apps - 3 margin - 2 heavy check) / 0.7 per track = 4.3
    expect(M.suggestedTracks({ memGb: 16, cores: 8 })).toBe(4);
    // (32 - 13) / 0.7 = 27, so the 8 cores decide
    expect(M.suggestedTracks({ memGb: 32, cores: 8 })).toBe(8);
    expect(M.suggestedTracks({ memGb: 64, cores: 12 })).toBe(12);
  });

  it('uses the free memory instead of the fixed part when it is known', () => {
    // (7 free - 3 margin - 2 heavy) / 0.7 = 2.9
    expect(M.suggestedTracks({ memGb: 32, cores: 8, freeGb: 7 })).toBe(2);
    expect(M.suggestedTracks({ memGb: 32, cores: 8, freeGb: 30 })).toBe(8);
  });

  it('is capped by one track per core with the gate queue on, and one per 1.5 cores with it off', () => {
    expect(M.suggestedTracks({ memGb: 128, cores: 6 })).toBe(6);
    expect(M.suggestedTracks({ memGb: 128, cores: 6, gateQueue: false })).toBe(4);
    expect(M.suggestedTracks({ memGb: 32, cores: 8, gateQueue: false })).toBe(5);
  });

  it('is at least 1, on a small machine or with bad input', () => {
    expect(M.suggestedTracks({ memGb: 8, cores: 4 })).toBe(1);
    expect(M.suggestedTracks({ memGb: 64, cores: 1 })).toBe(1);
    expect(M.suggestedTracks({ memGb: 32, cores: 8, freeGb: 2 })).toBe(1);
    expect(M.suggestedTracks({ memGb: Number.NaN, cores: Number.NaN })).toBe(1);
  });
});

describe('doctorAdvice', () => {
  it('is OK at or below the suggestion', () => {
    expect(M.doctorAdvice({ memGb: 32, cores: 8, maxConcurrent: 5 })).toMatchObject({ status: 'OK', suggested: 8, fix: null });
    expect(M.doctorAdvice({ memGb: 16, cores: 8, maxConcurrent: 4 }).status).toBe('OK');
  });

  it('warns above it, explains with one sentence marked as an estimate and says how to act', () => {
    const r = M.doctorAdvice({ memGb: 16, cores: 8, maxConcurrent: 5 });
    expect(r.status).toBe('WARN');
    expect(r.message).toContain('Estimate');
    expect(r.fix).toContain('limit maxConcurrent 4');
    expect(r.fix).toContain('machine --measure');
  });

  it('marks the OK row as an estimate too', () => {
    expect(M.doctorAdvice({ memGb: 32, cores: 8, maxConcurrent: 4 }).message).toContain('estimate');
  });
});

describe('the explanation', () => {
  it('names what the number is built from, so a heavy project knows to measure', () => {
    expect(M.WHY).toContain('Estimate');
    expect(M.WHY).toMatch(/0\.1 GB/);
    expect(M.WHY).toMatch(/quick check/);
    expect(M.WHY).toMatch(/one heavy check/i);
    expect(M.WHY).toMatch(/--measure/);
  });
});

describe('setupLine', () => {
  it('is one line with the suggestion and the estimate label, and says nothing changed', () => {
    const line = M.setupLine({ memGb: 32, cores: 8 });
    expect(line).not.toContain('\n');
    expect(line).toContain('about 8 parallel');
    expect(line).toContain('Estimate');
    expect(line).toContain('Nothing was changed');
  });

  it('uses the free memory when it is given', () => {
    expect(M.setupLine({ memGb: 32, cores: 8, freeGb: 7 })).toContain('about 2 parallel');
  });
});

describe('measuredAdvice', () => {
  it('counts what was free before, the full check once, the margin and the track size', () => {
    // 32 GB, 50 % free = 16 GB; the full check took 25 % = 8 GB; (16 - 3 - 8) / 0.7 = 7.1.
    expect(M.measuredAdvice({ memGb: 32, cores: 8, freeBeforePct: 50, minFreePct: 25 })).toEqual({
      suggested: 7, usedGb: 8, freeBeforeGb: 16, quickGb: null, trackGb: 0.7,
    });
    // 64 GB, 75 % free = 48 GB; the check took 5 % = 3.2 GB; (48 - 3 - 3.2) / 0.7 = 59.7, capped by 12 cores.
    expect(M.measuredAdvice({ memGb: 64, cores: 12, freeBeforePct: 75, minFreePct: 70 }).suggested).toBe(12);
  });

  it('uses the measured quick check as the cost of a track', () => {
    // The quick check took 5 % of 32 GB = 1.6 GB, so a track is 1.7 GB; (16 - 3 - 8) / 1.7 = 2.9.
    const r = M.measuredAdvice({ memGb: 32, cores: 8, freeBeforePct: 50, minFreePct: 25, quickBeforePct: 50, quickMinFreePct: 45 });
    expect(r).toMatchObject({ suggested: 2, quickGb: 1.6, trackGb: 1.7 });
  });

  it('keeps the general track size when the quick check has no memory figure', () => {
    const r = M.measuredAdvice({ memGb: 32, cores: 8, freeBeforePct: 50, minFreePct: 25, quickBeforePct: 50, quickMinFreePct: null });
    expect(r).toMatchObject({ quickGb: null, trackGb: 0.7 });
  });

  it('is at least 1, and never counts a rise in free memory as a negative use', () => {
    expect(M.measuredAdvice({ memGb: 16, cores: 8, freeBeforePct: 10, minFreePct: 2 }).suggested).toBe(1);
    expect(M.measuredAdvice({ memGb: 32, cores: 8, freeBeforePct: 50, minFreePct: 60 }).usedGb).toBe(0);
  });

  it('is null without a memory figure for the full check', () => {
    expect(M.measuredAdvice({ memGb: 32, cores: 8, freeBeforePct: 50, minFreePct: null })).toBe(null);
    expect(M.measuredAdvice({ memGb: 32, cores: 8, freeBeforePct: null, minFreePct: 40 })).toBe(null);
  });
});

describe('readMachine', () => {
  it('reads the machine', () => {
    const m = M.readMachine('');
    expect(m.memGb).toBeGreaterThan(0);
    expect(m.cores).toBeGreaterThan(0);
  });

  it('takes QUEUE_MACHINE, and ignores an incomplete one', () => {
    expect(M.readMachine('mem=32,cores=8')).toEqual({ memGb: 32, cores: 8 });
    expect(M.parseOverride('mem=32')).toBe(null);
    expect(M.parseOverride('mem=x,cores=y')).toBe(null);
  });
});
