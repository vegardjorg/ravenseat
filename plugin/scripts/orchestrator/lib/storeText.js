// =============================================================
// storeText.js: the one way agent text reaches a file, redacted and failing closed (roadmap 0æ N2).
//
// Why: more agent text is stored over time (gate and done command tails, the track's last answer in the review
// package, the time log's remark, the SILENT snapshot). Each place used to choose its own redaction, or none. This is
// the shared entry: redact first (lib/askBundle.js redact, the secret scan's provider patterns plus JWT, Bearer and the
// generic name=value rule), cut afterwards, so a cut never leaves the prefix of a key that the redaction no longer sees.
//
// Fails closed: when the redaction throws, or takes longer than the budget (a regex that backtracks badly on a strange
// input), the text is replaced by WITHHELD, never stored raw. The budget is measured after the call (JavaScript cannot
// stop a regex in the same thread), so a hang still costs its time, but its output is never kept. The input is capped
// before redaction (the newest part is kept), which bounds that time.
//
// The register of write sites (lib/sinkRegister.js) lists every module that stores agent text and the route it takes;
// the guard test (lib/__tests__/sinkRegister.test.ts) fails when a new module stores agent text without a route.
// Pure, no I/O. Tested in lib/__tests__/storeText.test.ts.
// =============================================================
'use strict';

const WITHHELD = '[withheld: the redaction failed, so the text was not stored]';
/** The largest input redacted; longer text keeps its end (a log's newest lines matter most). */
const MAX_INPUT = 1024 * 1024;
const BUDGET_MS = 2000;

/**
 * Redacts `text` for storing. `redact` can be swapped (tests); `clock` too.
 * @param {unknown} text
 * @param {{ maxChars?: number|null, keep?: 'head'|'tail', budgetMs?: number, redact?: (s: string) => { text: string, count?: number }, clock?: () => number }} [o]
 * @returns {{ text: string, withheld: boolean, count: number }}
 */
function forStore(text, { maxChars = null, keep = 'head', budgetMs = BUDGET_MS, redact = null, clock = Date.now } = {}) {
  let s = String(text ?? '');
  if (s.length > MAX_INPUT) s = s.slice(-MAX_INPUT);
  let r;
  try {
    const fn = redact ?? require('./askBundle.js').redact;
    const t0 = clock();
    r = fn(s);
    if (clock() - t0 > budgetMs || typeof r?.text !== 'string') return { text: WITHHELD, withheld: true, count: 0 };
  } catch {
    return { text: WITHHELD, withheld: true, count: 0 };
  }
  let out = r.text;
  // Cut AFTER the redaction (see the header).
  if (Number.isInteger(maxChars) && maxChars > 0 && out.length > maxChars)
    out = keep === 'tail' ? `…${out.slice(-(maxChars - 1))}` : `${out.slice(0, maxChars - 1)}…`;
  return { text: out, withheld: false, count: Number(r.count) || 0 };
}

/** The redacted text alone (forStore(...).text). */
function storeText(text, o) {
  return forStore(text, o).text;
}

module.exports = { WITHHELD, MAX_INPUT, BUDGET_MS, forStore, storeText };
