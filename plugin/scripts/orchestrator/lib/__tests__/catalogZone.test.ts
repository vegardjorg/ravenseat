// =============================================================
// catalogZone.test.ts: sensitive zones as catalog data (PG-5 step 0, the data shape only; lib/catalog.js kind zone,
// lib/catalogZones.js zonesFor).
//
// Locks: (1) a zone entry parses with paths and/or applies and/or keywords and a one-line reason, and needs no
// invariant; a zone without a reason, with an invariant or a check, or that names nothing to match is an error;
// (2) the kind, the paths, the applies and the keywords are in the fingerprint (a track cannot widen or narrow a zone
// after the owner's accept); (3) zonesFor returns only accepted zones, each with why it matched: files (owned_files or
// shared_patch meet its paths), category (its applies) or keyword (a whole word of the title or the mission, any case);
// (4) a zone never reaches the mission excerpt; on the board it is only in its own catalog group (PG-5,
// zoneBoard.test.ts); (5) an empty catalog gives no zones.
// Pure.
// =============================================================
import { describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const C = require('../catalog.js') as any;
const X = require('../catalogExcerpt.js') as any;
const Z = require('../catalogZones.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

/** A zone file; the frontmatter lines go in `more`. */
const zone = (id: string, status: string, more: string[]) =>
  ['---', `id: ${id}`, `title: Zone ${id}`, `status: ${status}`, 'kind: zone', ...more, '---', 'Why it is expensive to undo.', ''].join('\n');

function catalog(files: Record<string, string>) {
  return {
    exists: true,
    dir: 'docs/queue/catalog',
    stack: null,
    reuse: null,
    decisions: Object.entries(files).map(([name, source]) => ({ name, source, ...C.parseDecision(name, source) })),
    errors: [],
    warnings: [],
  };
}

function ledgerFor(cat: any, ids: string[]) {
  let l = C.emptyLedger();
  for (const x of cat.decisions) if (ids.includes(x.decision.id)) l = C.recordAccept(l, x.decision, { by: 'owner' });
  return l;
}

describe('the zone kind', () => {
  it('parses with paths, keywords and a reason, and needs no invariant', () => {
    const r = C.parseDecision(
      'D-0001-auth.md',
      zone('D-0001', 'proposed', ['paths: ["src/auth/**"]', 'keywords: ["session", "sign-in"]', 'reason: Sessions are hard to migrate once users rely on them.']),
    );
    expect(r.errors).toEqual([]);
    expect(r.decision.kind).toBe('zone');
    expect(r.decision.reason).toBe('Sessions are hard to migrate once users rely on them.');
    expect(r.decision.keywords).toEqual(['session', 'sign-in']);
    expect(C.KINDS).toContain('zone');
  });

  it('may match by keywords or applies alone', () => {
    expect(C.parseDecision('D-0001-a.md', zone('D-0001', 'proposed', ['keywords: ["tenant"]', 'reason: Tenant data must never mix.'])).errors).toEqual([]);
    expect(C.parseDecision('D-0002-b.md', zone('D-0002', 'proposed', ['applies: {"class": ["D+"]}', 'reason: Data model foundations.'])).errors).toEqual([]);
  });

  it('refuses a zone without a reason, with an invariant or a check, or with nothing to match', () => {
    const noReason = C.parseDecision('D-0001-a.md', zone('D-0001', 'proposed', ['paths: ["db/**"]']));
    expect(noReason.errors.join(' ')).toMatch(/reason/);
    const inv = C.parseDecision('D-0001-a.md', zone('D-0001', 'proposed', ['paths: ["db/**"]', 'reason: x.', 'invariant: Never do it.']));
    expect(inv.errors.join(' ')).toMatch(/zone has no invariant/);
    const nothing = C.parseDecision('D-0001-a.md', zone('D-0001', 'proposed', ['reason: Something.']));
    expect(nothing.errors.join(' ')).toMatch(/paths, applies or keywords/);
  });

  it('a reason is only for a zone', () => {
    const src = ['---', 'id: D-0001', 'title: T', 'status: proposed', 'paths: ["a/**"]', 'invariant: I.', 'reason: R.', '---', ''].join('\n');
    expect(C.parseDecision('D-0001-t.md', src).errors.join(' ')).toMatch(/reason is for kind zone/);
  });

  it('binds kind, paths, applies and keywords in the fingerprint', () => {
    const base = C.parseDecision('D-0001-a.md', zone('D-0001', 'accepted', ['paths: ["db/**"]', 'keywords: ["schema"]', 'reason: R.'])).decision;
    const wider = C.parseDecision('D-0001-a.md', zone('D-0001', 'accepted', ['paths: ["db/**"]', 'keywords: ["schema", "column"]', 'reason: R.'])).decision;
    const reworded = C.parseDecision('D-0001-a.md', zone('D-0001', 'accepted', ['paths: ["db/**"]', 'keywords: ["schema"]', 'reason: Other words.'])).decision;
    expect(C.fingerprint(base)).not.toBe(C.fingerprint(wider));
    expect(C.fingerprint(base)).toBe(C.fingerprint(reworded));
  });
});

describe('zonesFor', () => {
  const cat = catalog({
    'D-0001-auth.md': zone('D-0001', 'accepted', ['paths: ["src/auth/**"]', 'reason: Sign-in is a one-way door.']),
    'D-0002-tenant.md': zone('D-0002', 'accepted', ['keywords: ["tenant isolation", "RLS"]', 'reason: Tenant data must never mix.']),
    'D-0003-model.md': zone('D-0003', 'accepted', ['applies: {"class": ["D+"]}', 'reason: Data model foundations.']),
    'D-0004-later.md': zone('D-0004', 'proposed', ['paths: ["src/**"]', 'reason: Not yet accepted.']),
  });
  const ledger = ledgerFor(cat, ['D-0001', 'D-0002', 'D-0003']);

  it('gives the accepted zones a task meets, each with why', () => {
    const t = { id: 'T1', title: 'Change the rls policy', class: 'D+', owned_files: ['src/auth/session.ts'], mission: 'Add a column.' };
    const hits = Z.zonesFor(t, cat, { ledger });
    expect(hits.map((h: any) => [h.id, h.why])).toEqual([
      ['D-0001', 'files'],
      ['D-0002', 'keyword'],
      ['D-0003', 'category'],
    ]);
    expect(hits[0].detail).toBe('src/auth/session.ts');
    expect(hits[1].detail).toBe('RLS');
    expect(hits[0].reason).toBe('Sign-in is a one-way door.');
  });

  it('matches keywords as whole words in the title or the mission, any case', () => {
    const near = { id: 'T2', title: 'Rename the rlsx helper', class: 'K', mission: 'Nothing here.' };
    expect(Z.zonesFor(near, cat, { ledger })).toEqual([]);
    const mission = { id: 'T3', title: 'Work', class: 'K', mission: 'Fix Tenant Isolation for the export.' };
    expect(Z.zonesFor(mission, cat, { ledger }).map((h: any) => h.id)).toEqual(['D-0002']);
    const text = { id: 'T4', title: 'Work', class: 'K', mission: 'docs/m.md' };
    expect(Z.zonesFor(text, cat, { ledger, missionText: 'touches RLS' }).map((h: any) => h.id)).toEqual(['D-0002']);
  });

  it('counts a shared_patch file, and a folder the task owns', () => {
    expect(Z.zonesFor({ id: 'T5', title: 'x', class: 'K', shared_patch: ['src/auth/index.ts'] }, cat, { ledger }).map((h: any) => h.id)).toEqual(['D-0001']);
    expect(Z.zonesFor({ id: 'T6', title: 'x', class: 'K', owned_files: ['src/auth/'] }, cat, { ledger }).map((h: any) => h.id)).toEqual(['D-0001']);
  });

  it('a proposed or unconfirmed zone has no effect', () => {
    const t = { id: 'T7', title: 'x', class: 'K', owned_files: ['src/other.ts'] };
    expect(Z.zonesFor(t, cat, { ledger })).toEqual([]);
    expect(Z.zonesFor({ id: 'T8', title: 'x', class: 'K', owned_files: ['src/auth/a.ts'] }, cat, { ledger: C.emptyLedger() })).toEqual([]);
  });

  it('an empty or missing catalog gives no zones', () => {
    expect(Z.zonesFor({ id: 'T9', title: 'RLS', class: 'D+' }, { exists: false, decisions: [] }, {})).toEqual([]);
    expect(Z.zonesFor({ id: 'T9', title: 'RLS', class: 'D+' }, null, {})).toEqual([]);
  });

  it('a zone never reaches the mission excerpt, and is only in the zone group on the board', () => {
    const t = { id: 'T1', title: 'x', class: 'D+', owned_files: ['src/auth/session.ts'] };
    expect(X.excerpt(cat, t, { ledger })).toBe(null);
    expect(C.boardGroups(cat, ledger).map((g: any) => g.kind)).toEqual(['zone']);
  });
});
