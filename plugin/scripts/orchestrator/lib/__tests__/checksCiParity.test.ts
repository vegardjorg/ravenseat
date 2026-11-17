// =============================================================
// checksCiParity.test.ts: the Checks tab's CI parity for a built gate guard (0i step 9b, plans/feillogg-til-gater-
// 2026-11-15.md section 3.7 point 4 and section 3.9), lib/checksCatalog.js with the plugin's own catalog.
//
// Locks: (1) the card quick-gate-add shows while a gate guard's command is not in gates.quick, carries the items (the
// command from the registry, through facts.quickGate) and has the action quick-gate, never a free command; (2) lift_when
// puts tests-in-ci and quality-in-ci first in their priority when a guard's kind of check is not run in CI, names the
// guard, and never raises a card to high (the red marker is only for a guard that failed, section 3.9); (3) an unknown
// lift_when condition is a catalog error.
// =============================================================
import path from 'node:path';

import { describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports */
const C = require('../checksCatalog.js');
/* eslint-enable @typescript-eslint/no-require-imports */

const BUILTIN = path.resolve(__dirname, '..', '..', 'checks-catalog');
const catalog = C.loadCatalog({ builtin: BUILTIN, own: path.join(BUILTIN, 'none') });
const report = (facts: object) => C.buildReport({ facts: { git: true, ...facts }, catalog, now: 'x' });
type Card = { key: string; priority: string; action: string | null; detail: string | null; lifted?: boolean; quickGate?: unknown[] };
const card = (r: { suggestions: Card[] }, key: string) => r.suggestions.find((s) => s.key === key);
const kinds = (...list: [string, string][]) => list.map(([key, where]) => ({ key, places: [{ where }] }));
const item = { guard: 'G-1', title: 'Lint for unchecked results', command: 'npm run lint', task: 'GATE-1', inFull: false };

describe('the card "add a guard\'s command to gates.quick"', () => {
  it('shows with the items while a guard\'s command is not in gates.quick, and is gone without one', () => {
    expect(catalog.errors).toEqual([]);
    expect(card(report({}), 'quick-gate-add')).toBeUndefined();
    expect(card(report({ quickGate: { items: [] } }), 'quick-gate-add')).toBeUndefined();
    const c = card(report({ quickGate: { items: [item] } }), 'quick-gate-add') as Card;
    expect(c).toMatchObject({ action: 'quick-gate', priority: 'medium', quickGate: [item] });
    expect(c.detail).toContain('G-1');
    expect(c.detail).toContain('npm run lint');
    // Never the red marker: it is a gap worth a look, not a guard that failed.
    expect(report({ quickGate: { items: [item] } }).important).toBe(report({}).important);
  });
});

describe('the CI cards are lifted when a guard\'s kind is not run in CI', () => {
  const ci = [{ file: '.github/workflows/ci.yml' }];
  const base = { ci, kinds: kinds(['test', 'gate'], ['lint', 'gate'], ['types', 'gate']) };

  it('puts the card first in its priority and names the guard, but never raises it to high', () => {
    const plain = report(base);
    expect(card(plain, 'quality-in-ci')).toMatchObject({ priority: 'medium' });
    expect(card(plain, 'quality-in-ci')?.lifted).toBeUndefined();
    const lifted = report({ ...base, guardKinds: { lint: ['G-1'] } });
    const q = card(lifted, 'quality-in-ci') as Card;
    expect(q).toMatchObject({ priority: 'medium', lifted: true });
    expect(q.detail).toContain('G-1');
    const medium = lifted.suggestions.filter((s: Card) => s.priority === 'medium');
    expect(medium[0].key).toBe('quality-in-ci');
    // tests-in-ci is already high; a test guard puts it first there and does not add to the marker count.
    const t = report({ ...base, guardKinds: { test: ['G-2'] } });
    expect(card(t, 'tests-in-ci')).toMatchObject({ priority: 'high', lifted: true });
    expect(t.suggestions.filter((s: Card) => s.priority === 'high')[0].key).toBe('tests-in-ci');
    expect(t.important).toBe(report(base).important);
  });

  it('a guard kind that CI already runs, or another kind, lifts nothing', () => {
    const inCi = report({ ci, kinds: kinds(['lint', 'ci'], ['types', 'gate']), guardKinds: { lint: ['G-1'] } });
    expect(card(inCi, 'quality-in-ci')?.lifted).toBeUndefined();
    expect(card(report({ ...base, guardKinds: { test: ['G-2'] } }), 'quality-in-ci')?.lifted).toBeUndefined();
  });

  it('an unknown lift_when condition is a catalog error', () => {
    const t = C.parseTemplate('---\ntitle: T\ncategory: ci\npriority: medium\nwhy: B.\nlift_when: no-such-thing\n---\n## Investigate\nA.\n\n## Plan and build\nB.\n', 'x');
    expect(t.errors.join(' ')).toMatch(/lift_when/);
  });
});
