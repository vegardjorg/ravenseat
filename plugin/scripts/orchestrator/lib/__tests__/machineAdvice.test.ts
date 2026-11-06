// =============================================================
// machineAdvice.test.ts: the suggested number of parallel tracks (lib/machineAdvice.js).
//
// Locks: the rule and its agreed figures, the row in doctor (OK or WARN, never FAIL), the estimate label wherever the number
// is shown, the measured suggestion and the QUEUE_MACHINE override.
// =============================================================
import { describe, expect, it } from 'vitest';

const M = require('../machineAdvice.js');

describe('suggestedTracks', () => {
  it('gives the agreed figures', () => {
    expect(M.suggestedTracks({ memGb: 16, cores: 8 })).toBe(1);
    expect(M.suggestedTracks({ memGb: 32, cores: 8 })).toBe(4);
    expect(M.suggestedTracks({ memGb: 64, cores: 12 })).toBe(8);
  });

  it('is capped by the cores', () => {
    expect(M.suggestedTracks({ memGb: 128, cores: 6 })).toBe(4);
    expect(M.suggestedTracks({ memGb: 64, cores: 4 })).toBe(2);
  });

  it('is at least 1, on a small machine or with bad input', () => {
    expect(M.suggestedTracks({ memGb: 8, cores: 4 })).toBe(1);
    expect(M.suggestedTracks({ memGb: 64, cores: 1 })).toBe(1);
    expect(M.suggestedTracks({ memGb: Number.NaN, cores: Number.NaN })).toBe(1);
  });
});

describe('doctorAdvice', () => {
  it('is OK at or below the suggestion', () => {
    expect(M.doctorAdvice({ memGb: 32, cores: 8, maxConcurrent: 4 })).toMatchObject({ status: 'OK', suggested: 4, fix: null });
    expect(M.doctorAdvice({ memGb: 32, cores: 8, maxConcurrent: 2 }).status).toBe('OK');
  });

  it('warns above it, explains with one sentence marked as an estimate and says how to act', () => {
    const r = M.doctorAdvice({ memGb: 16, cores: 8, maxConcurrent: 5 });
    expect(r.status).toBe('WARN');
    expect(r.message).toContain('Estimate');
    expect(r.fix).toContain('limit maxConcurrent 1');
    expect(r.fix).toContain('machine --measure');
  });

  it('marks the OK row as an estimate too', () => {
    expect(M.doctorAdvice({ memGb: 32, cores: 8, maxConcurrent: 4 }).message).toContain('estimate');
  });
});

describe('setupLine', () => {
  it('is one line with the suggestion and the estimate label, and says nothing changed', () => {
    const line = M.setupLine({ memGb: 32, cores: 8 });
    expect(line).not.toContain('\n');
    expect(line).toContain('about 4 parallel');
    expect(line).toContain('Estimate');
    expect(line).toContain('Nothing was changed');
  });
});

describe('measuredAdvice', () => {
  it('counts what was free before, what the check took, the margin and the track size', () => {
    // 32 GB, 50 % free = 16 GB; the check took 25 % = 8 GB; (16 - 4 - 8) / 2.5 = 1.6.
    expect(M.measuredAdvice({ memGb: 32, cores: 8, freeBeforePct: 50, minFreePct: 25 })).toEqual({ suggested: 1, usedGb: 8, freeBeforeGb: 16 });
    // 64 GB, 75 % free = 48 GB; the check took 5 % = 3.2 GB; (48 - 4 - 3.2) / 2.5 = 16.3, capped by 12 cores at 8.
    expect(M.measuredAdvice({ memGb: 64, cores: 12, freeBeforePct: 75, minFreePct: 70 }).suggested).toBe(8);
  });

  it('is at least 1, and never counts a rise in free memory as a negative use', () => {
    expect(M.measuredAdvice({ memGb: 16, cores: 8, freeBeforePct: 10, minFreePct: 2 }).suggested).toBe(1);
    expect(M.measuredAdvice({ memGb: 32, cores: 8, freeBeforePct: 50, minFreePct: 60 }).usedGb).toBe(0);
  });

  it('is null without a memory figure', () => {
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
