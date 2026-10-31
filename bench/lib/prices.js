// =============================================================
// prices.js: USD for a set of tokens, per model, for arms that use different models per agent.
//
// The default table is the queue's own (plugin/scripts/orchestrator/lib/timeCost.js PRICES), so the benchmark and the
// queue's cost numbers agree. Other models (a cheaper reviewer, for example) must be priced in the manifest
// (settings.prices); this file deliberately ships no guessed prices. A model without a price is priced as the default
// model and flagged `assumed`, and the report lists it, so a missing price is never silent.
// A model id with a date or variant suffix ("claude-opus-5-5-20261001") matches the longest known prefix.
//
// Pure. Tested in bench/__tests__/collect.test.ts.
// =============================================================
'use strict';

const TC = require('../../plugin/scripts/orchestrator/lib/timeCost.js');

/** The price table in effect: the queue's defaults plus the manifest's overrides. */
function priceTable(overrides = {}) {
  return { ...TC.PRICES, ...(overrides ?? {}) };
}

/** { price, model, assumed } for a model id. */
function priceFor(model, table) {
  const t = table ?? priceTable();
  if (model && t[model]) return { price: t[model], model, assumed: false };
  if (model) {
    const hit = Object.keys(t)
      .filter((k) => String(model).startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    if (hit) return { price: t[hit], model: hit, assumed: false };
  }
  return { price: t[TC.DEFAULT_MODEL] ?? TC.PRICES[TC.DEFAULT_MODEL], model: TC.DEFAULT_MODEL, assumed: !!model };
}

const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);

/**
 * USD for tokens { input, output, cache_read, cache_written, cache_written_5m?, cache_written_1h? }. Writes without a
 * 5m/1h split count as 5 min (the same rule as timeCost.costUsd).
 */
function costUsd(tokens, model, table) {
  if (!tokens) return { usd: 0, assumed: false };
  const { price: p, assumed } = priceFor(model, table);
  let s5 = tokens.cache_written_5m;
  let s1 = tokens.cache_written_1h;
  if (s5 == null && s1 == null) {
    s5 = n(tokens.cache_written);
    s1 = 0;
  } else {
    s5 = n(s5);
    s1 = n(s1);
    const rest = n(tokens.cache_written) - s5 - s1;
    if (rest > 0) s5 += rest;
  }
  const usd =
    (n(tokens.input) * p.input +
      n(tokens.output) * p.output +
      n(tokens.cache_read) * p.cache_read +
      s5 * p.cache_5m +
      s1 * p.cache_1h) /
    1e6;
  return { usd, assumed };
}

module.exports = { priceTable, priceFor, costUsd };
