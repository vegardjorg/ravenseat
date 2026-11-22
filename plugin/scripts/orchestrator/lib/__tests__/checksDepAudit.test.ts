// =============================================================
// checksDepAudit.test.ts: the Checks card for the dependency audit's findings (roadmap 0å KD-4, lib/checksCatalog.js,
// checks-catalog/suggestions/dep-audit-found.md). The facts come from the cache (lib/osv.js summarize), never the network.
//
// Locks: (1) the card shows only while the last audit has open findings; (2) low, raised to medium by a high or critical
// hole in code that ships, never high (no red marker); (3) its detail names the age, the counts and the worst three
// with the version that fixes them; the structured list is on the card; (4) action dep-fix needs no investigation
// sections; (5) the dep-audit card points at `catalog deps --audit --dry`.
// =============================================================
import { describe, expect, it } from 'vitest';
import path from 'node:path';

const C = require('../checksCatalog.js');
const BUILTIN = path.resolve(__dirname, '..', '..', 'checks-catalog');
const catalog = C.loadCatalog({ builtin: BUILTIN, own: path.join(BUILTIN, 'does-not-exist') });

const f = (id: string, severity: string, name: string, dev: boolean | null, fixed: string | null = '2.0.0') => ({ id, aliases: [], summary: 's', severity, ecosystem: 'npm', name, version: '1.0.0', fixed, dev });
const summary = (over: Record<string, unknown> = {}) => ({
  checkedAt: '2026-11-18T10:00:00.000Z',
  ageDays: 3,
  counts: { critical: 0, high: 1, moderate: 1, low: 0, unknown: 0 },
  open: 2,
  highProd: 0,
  worst: [f('GHSA-hi', 'high', 'vitest', true), f('GHSA-mod', 'moderate', 'zod', false, null)],
  accepted: 1,
  lapsed: [],
  errors: [],
  ...over,
});
const base = { stacks: ['node'], kinds: [], ci: [], git: true };
const card = (facts: Record<string, unknown>) => C.buildReport({ facts: { ...base, ...facts }, catalog, now: 'x' }).suggestions.find((s: any) => s.key === 'dep-audit-found');

describe('the dep-audit-found card', () => {
  it('parses without errors', () => {
    expect(catalog.errors).toEqual([]);
    expect(catalog.templates.find((t: any) => t.key === 'dep-audit-found')).toMatchObject({ action: 'dep-fix', priority: 'low' });
  });

  it('shows only while the last audit has open findings', () => {
    expect(card({})).toBeUndefined();
    expect(card({ depAudit: summary({ open: 0, worst: [] }) })).toBeUndefined();
    expect(card({ depAudit: summary() })).toBeDefined();
  });

  it('low for development-only or moderate holes, medium for a high or critical one in code that ships, never high', () => {
    expect(card({ depAudit: summary() }).priority).toBe('low');
    expect(card({ depAudit: summary() }).quiet).toBeUndefined();
    const raised = card({ depAudit: summary({ highProd: 1 }) });
    expect(raised.priority).toBe('medium');
    const r = C.buildReport({ facts: { ...base, depAudit: summary({ highProd: 3 }) }, catalog, now: 'x' });
    expect(r.important).toBe(C.buildReport({ facts: base, catalog, now: 'x' }).important);
  });

  it('the detail: age, counts, the worst with the fixing version, the accepted ones; the list is on the card', () => {
    const c = card({ depAudit: summary() });
    expect(c.detail).toBe(
      'Last audit 3 days ago (ravenseat catalog deps --audit): 1 high, 1 moderate. 1 accepted by a catalog entry. ' +
        'Worst: vitest 1.0.0 to 2.0.0 or later (GHSA-hi, high, development only); zod 1.0.0 (no fixed version published yet) (GHSA-mod, moderate).',
    );
    expect(c.depAudit.worst.map((x: any) => x.id)).toEqual(['GHSA-hi', 'GHSA-mod']);
    expect(c.depAudit.counts).toEqual({ critical: 0, high: 1, moderate: 1, low: 0, unknown: 0 });
  });

  it('a lapsed risk acceptance is named on the card', () => {
    const c = card({ depAudit: summary({ lapsed: [{ id: 'D-0007', reviewBy: '2026-11-01' }] }) });
    expect(c.detail).toMatch(/D-0007 was due for review on 2026-11-01, so its holes count again\./);
  });

  it('the dep-audit card names the audit command that needs no install', () => {
    const c = C.buildReport({ facts: { ...base }, catalog, now: 'x' }).suggestions.find((s: any) => s.key === 'dep-audit');
    expect(c.detail).toMatch(/ravenseat catalog deps --audit --dry/);
  });
});
