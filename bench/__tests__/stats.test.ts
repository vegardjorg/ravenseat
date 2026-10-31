// =============================================================
// stats.test.ts: descriptive numbers, the seeded bootstrap, correlations and the sample size rule (bench/lib/stats.js).
// =============================================================
import { describe, it, expect } from 'vitest';

const S = require('../lib/stats.js') as Record<string, any>;

describe('descriptive', () => {
  it('median, mean, percentile and sd, with null as a missing value (not zero)', () => {
    expect(S.median([3, 1, 2])).toBe(2);
    expect(S.median([4, 1, 2, 3])).toBe(2.5);
    expect(S.median([])).toBeNull();
    expect(S.mean([1, null, 3])).toBe(2);
    expect(S.percentile([0, 10], 50)).toBe(5);
    expect(S.sd([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
  });
});

describe('bootstrap', () => {
  it('is reproducible with the same seed', () => {
    const xs = [1, 5, 2, 8, 3, 9, 4];
    const a = S.bootstrapCi(xs, S.mean, { B: 300, seed: 7 });
    const b = S.bootstrapCi(xs, S.mean, { B: 300, seed: 7 });
    expect(a).toEqual(b);
    expect(a.lo).toBeLessThan(a.estimate);
    expect(a.hi).toBeGreaterThan(a.estimate);
  });

  it('paired bootstrap: a constant shift gives a zero-width CI at the shift', () => {
    const pairs = [1, 2, 3, 4, 5].map((a) => ({ a, b: a + 2 }));
    const r = S.pairedBootstrap(pairs, { B: 200 });
    expect(r.estimate).toBe(2);
    expect(r.lo).toBe(2);
    expect(r.hi).toBe(2);
  });

  it('paired bootstrap skips incomplete pairs; ratio of totals is sum(b)/sum(a)', () => {
    const pairs = [{ a: 2, b: 1 }, { a: 4, b: 2 }, { a: null, b: 5 }];
    expect(S.pairedBootstrap(pairs, { B: 100 }).n).toBe(2);
    expect(S.ratioBootstrap(pairs, { B: 100 }).estimate).toBe(0.5);
  });

  it('a CI from noisy pairs with no real difference contains zero', () => {
    const r = S.rng(3);
    const pairs = Array.from({ length: 30 }, () => {
      const base = 5 + r() * 10;
      return { a: base + r() - 0.5, b: base + r() - 0.5 };
    });
    const ci = S.pairedBootstrap(pairs, { B: 1000, seed: 2 });
    expect(ci.lo).toBeLessThan(0);
    expect(ci.hi).toBeGreaterThan(0);
  });
});

describe('correlation and sample size', () => {
  it('spearman is 1 for any monotone relation and handles ties', () => {
    expect(S.spearman([1, 2, 3, 4], [1, 4, 9, 100])).toBeCloseTo(1, 10);
    expect(S.spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 10);
    expect(S.ranks([5, 5, 1])).toEqual([2.5, 2.5, 1]);
    expect(S.spearman([1, 2], [1, 2])).toBeNull();
  });

  it('pairsNeeded follows the normal approximation', () => {
    expect(S.pairsNeeded({ sdDiff: 4, delta: 2 })).toBe(32);
    expect(S.pairsNeeded({ sdDiff: 4, delta: 4 })).toBe(8);
    expect(S.pairsNeeded({ sdDiff: 0, delta: 1 })).toBeNull();
  });
});
