// =============================================================
// acceptanceGap.test.ts: a task with acceptance criteria always gets the gap reviewer (DR-3,
// plans/drift-vurdering-2026-11-21.md section 5; lib/queueHelpers.js reviewersForTask, the helper field `acceptance`).
//
// Locks: (1) a task with criteria gets reviewer-gap with one reason line ("acceptance: 2 criteria") even while the helper
// is off, as the drift signal lifts it; (2) a task without criteria is unchanged; (3) helpers.reviewer-gap.acceptance
// false removes it; (4) with the helper on and its own condition hitting, the reason is added once, not a second entry;
// (5) the default is on in STANDARD.
// Pure.
// =============================================================
import { describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const H = require('../queueHelpers.js') as any;
const KK = require('../queueConfig.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const conf = (own: object = {}) => KK.merge(KK.STANDARD, own);
const gap = (o: object, c: object) => H.reviewersForTask(o, { config: c }).find((r: any) => r.type === 'reviewer-gap');

describe('acceptance criteria lift the gap reviewer in', () => {
  it('is on by default, with the helper itself off', () => {
    expect(KK.STANDARD.helpers['reviewer-gap'].acceptance).toBe(true);
    expect(KK.STANDARD.helpers['reviewer-gap'].enabled).toBe(false);
  });

  it('a task with criteria gets reviewer-gap with one reason line', () => {
    const r = gap({ class: 'K', acceptance: ['The export has a header row', 'Empty input gives an empty file'] }, conf());
    expect(r).toEqual({ type: 'reviewer-gap', fixed: false, acceptance: true, reasons: ['acceptance: 2 criteria'] });
    expect(gap({ class: 'K', acceptance: ['One'] }, conf()).reasons).toEqual(['acceptance: 1 criterion']);
  });

  it('a task without criteria is unchanged', () => {
    expect(gap({ class: 'K' }, conf())).toBe(undefined);
    expect(gap({ class: 'K', acceptance: [] }, conf())).toBe(undefined);
    expect(H.reviewersForTask({ class: 'D' }, { config: conf() }).map((r: any) => r.type)).toEqual(['reviewer']);
  });

  it('the switch off removes it', () => {
    expect(gap({ class: 'K', acceptance: ['One'] }, conf({ helpers: { 'reviewer-gap': { acceptance: false } } }))).toBe(undefined);
  });

  it('the helper\'s condition text says it (the Helper agents tab, ravenseat helpers)', () => {
    const h = H.helperSetup(conf())['reviewer-gap'];
    expect(H.conditionText(h)).toMatch(/Also, even while off: a task with acceptance criteria\.$/);
    expect(H.conditionText(H.helperSetup(conf())['reviewer-docs'])).not.toMatch(/acceptance/);
  });

  it('adds the reason once when the helper already runs for another reason', () => {
    const c = conf({ helpers: { 'reviewer-gap': { enabled: true } } });
    const r = H.reviewersForTask({ class: 'K', plan: 'PL-3', acceptance: ['One'] }, { config: c }).filter((x: any) => x.type === 'reviewer-gap');
    expect(r).toHaveLength(1);
    expect(r[0].reasons).toEqual(['plan PL-3', 'acceptance: 1 criterion']);
  });
});
