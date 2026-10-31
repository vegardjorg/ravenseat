// =============================================================
// stats.js: the small statistics toolkit the benchmark needs, with no dependencies.
//
//   - median, mean, percentile, sd: descriptive numbers (null for an empty list, never NaN in a report)
//   - rng(seed): a seeded generator (mulberry32), so the same data always gives the same confidence interval
//   - bootstrapCi: percentile bootstrap of any statistic over one sample
//   - pairedBootstrap: the difference B - A over matched pairs, resampling PAIRS (keeps the matching)
//   - ratioBootstrap: ratio of totals (sum B / sum A), e.g. USD per merged change in arm B vs arm A
//   - spearman / pearson: correlation, for load vs duration
//   - pairsNeeded: how many matched pairs a paired comparison needs to see an effect of a given size
//
// Pure, no I/O. Tested in bench/__tests__/stats.test.ts.
// =============================================================
'use strict';

// null and '' are missing values, not zero (Number(null) is 0).
const num = (x) => (x == null || x === '' ? NaN : Number(x));
const finite = (xs) => (xs ?? []).map(num).filter((x) => Number.isFinite(x));
/** A pair with both values present. */
const ok = (p) => Number.isFinite(num(p?.a)) && Number.isFinite(num(p?.b));

function median(xs) {
  const s = finite(xs).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function mean(xs) {
  const s = finite(xs);
  return s.length ? s.reduce((a, b) => a + b, 0) / s.length : null;
}

/** Percentile p (0-100) with linear interpolation between ranks. */
function percentile(xs, p) {
  const s = finite(xs).sort((a, b) => a - b);
  if (!s.length) return null;
  const r = (Math.min(100, Math.max(0, p)) / 100) * (s.length - 1);
  const lo = Math.floor(r);
  const hi = Math.ceil(r);
  return s[lo] + (s[hi] - s[lo]) * (r - lo);
}

/** Sample standard deviation (n - 1). null below two values. */
function sd(xs) {
  const s = finite(xs);
  if (s.length < 2) return null;
  const m = mean(s);
  return Math.sqrt(s.reduce((a, x) => a + (x - m) ** 2, 0) / (s.length - 1));
}

/** mulberry32: a small, fast, seeded PRNG giving numbers in [0, 1). */
function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Percentile bootstrap confidence interval of `stat` over the items (any type).
 * @returns {{ estimate: number|null, lo: number|null, hi: number|null, n: number, B: number }}
 */
function bootstrapCi(items, stat, { B = 2000, level = 0.95, seed = 1 } = {}) {
  const list = items ?? [];
  const n = list.length;
  const estimate = n ? stat(list) : null;
  if (n < 2 || estimate == null) return { estimate, lo: null, hi: null, n, B };
  const r = rng(seed);
  const values = [];
  for (let b = 0; b < B; b++) {
    const sample = new Array(n);
    for (let i = 0; i < n; i++) sample[i] = list[Math.floor(r() * n)];
    const v = stat(sample);
    if (v != null && Number.isFinite(v)) values.push(v);
  }
  const tail = ((1 - level) / 2) * 100;
  return { estimate, lo: percentile(values, tail), hi: percentile(values, 100 - tail), n, B };
}

/**
 * Paired difference B - A over matched pairs [{ a, b }], with a bootstrap CI that resamples whole pairs.
 * `stat` is applied to the list of differences (default: mean).
 */
function pairedBootstrap(pairs, { stat = mean, ...opt } = {}) {
  const diffs = (pairs ?? [])
    .filter((p) => ok(p))
    .map((p) => Number(p.b) - Number(p.a));
  return { ...bootstrapCi(diffs, stat, opt), diffs };
}

/** Ratio of totals, sum(b) / sum(a), over matched pairs, with a pair bootstrap CI. 1.0 = no difference. */
function ratioBootstrap(pairs, opt = {}) {
  const complete = (pairs ?? []).filter((p) => ok(p));
  const ratio = (list) => {
    const sa = list.reduce((s, p) => s + Number(p.a), 0);
    const sb = list.reduce((s, p) => s + Number(p.b), 0);
    return sa > 0 ? sb / sa : null;
  };
  return bootstrapCi(complete, ratio, opt);
}

function pearson(xs, ys) {
  const pts = (xs ?? [])
    .map((x, i) => [num(x), num(ys?.[i])])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (pts.length < 3) return null;
  const mx = mean(pts.map((p) => p[0]));
  const my = mean(pts.map((p) => p[1]));
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const [x, y] of pts) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

/** Ranks with ties given their average rank (1-based). */
function ranks(xs) {
  const idx = xs.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
  const out = new Array(xs.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) out[idx[k][1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return out;
}

/** Spearman rank correlation (robust to outliers and non-linear but monotone relations). */
function spearman(xs, ys) {
  const pts = (xs ?? [])
    .map((x, i) => [num(x), num(ys?.[i])])
    .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
  if (pts.length < 3) return null;
  return pearson(ranks(pts.map((p) => p[0])), ranks(pts.map((p) => p[1])));
}

/** Two-sided normal quantiles for the usual levels (enough for planning numbers). */
const Z = { 0.8: 1.2816, 0.9: 1.6449, 0.95: 1.96, 0.99: 2.5758 };

/**
 * Matched pairs needed to detect a mean paired difference `delta` when the differences have standard deviation `sdDiff`
 * (normal approximation, two-sided). E.g. sdDiff 4 USD, delta 2 USD, 80 % power at 95 % -> 32 pairs.
 */
function pairsNeeded({ sdDiff, delta, level = 0.95, power = 0.8 }) {
  if (!(sdDiff > 0) || !(delta > 0)) return null;
  const za = Z[level] ?? 1.96;
  const zb = { 0.8: 0.8416, 0.9: 1.2816, 0.95: 1.6449 }[power] ?? 0.8416;
  return Math.ceil(((za + zb) * sdDiff / delta) ** 2);
}

module.exports = {
  median,
  mean,
  percentile,
  sd,
  rng,
  bootstrapCi,
  pairedBootstrap,
  ratioBootstrap,
  pearson,
  spearman,
  ranks,
  pairsNeeded,
};
