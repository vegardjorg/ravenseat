// =============================================================
// catalogPropose.test.ts: the way into the catalog (roadmap 0z, plans/decision-keeper-vurdering-2026-11-17.md).
//
// Locks: (Z-B) the next free D-id counts every file name and every id in the owner's record, so an id is never reused;
// the slug is lower-case ASCII letters, digits and hyphens; a proposal is written as a file that parseDecision reads back
// without an error, always with status proposed, and text that would be cut as a comment or read as JSON is quoted.
// Pure: lib/catalog.js only.
// =============================================================
import { describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const C = require('../catalog.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

describe('Z-B: catalog propose', () => {
  it('the next free id counts the files and the owner record, never reusing one', () => {
    expect(C.nextDecisionId([], C.emptyLedger())).toBe('D-0001');
    expect(C.nextDecisionId(['README.md', 'D-0001-a.md', 'D-0003-b.md', 'notes.txt'], C.emptyLedger())).toBe('D-0004');
    const ledger = { version: 1, decisions: { 'D-0009': { fingerprint: 'x' } } };
    expect(C.nextDecisionId(['D-0002-a.md'], ledger)).toBe('D-0010');
  });

  it('the slug is lower-case ASCII, digits and hyphens, short, never empty', () => {
    expect(C.slugOf('Dates through ONE library!')).toBe('dates-through-one-library');
    expect(C.slugOf('Bør æøå gå')).toBe('bor-aeoa-ga');
    expect(C.slugOf('   ')).toBe('choice');
    const long = C.slugOf('word '.repeat(30));
    expect(long.length).toBeLessThanOrEqual(48);
    expect(long).not.toMatch(/-$/);
  });

  it('a proposal reads back without an error, always proposed, and odd text is quoted', () => {
    const r = C.proposalFile({
      id: 'D-0004',
      title: 'Ids #1: never reused',
      invariant: 'true',
      paths: ['lib/**', 'app/'],
      supersedes: 'D-0002',
      plan: 'PL-IDS',
      why: 'The owner said so.',
    });
    expect(r.errors).toEqual([]);
    expect(r.name).toBe('D-0004-ids-1-never-reused.md');
    const back = C.parseDecision(r.name, r.text);
    expect(back.errors).toEqual([]);
    expect(back.decision).toMatchObject({
      id: 'D-0004',
      title: 'Ids #1: never reused',
      status: 'proposed',
      invariant: 'true',
      paths: ['lib/**', 'app/'],
      supersedes: 'D-0002',
      plan: 'PL-IDS',
    });
    expect(back.decision.body).toMatch(/The owner said so\./);
    expect(r.text).not.toMatch(/\r/);
  });

  it('a proposal with a missing invariant or a bad path is refused with the reason', () => {
    const bad = C.proposalFile({ id: 'D-0001', title: 'X', invariant: '', paths: ['../up'] });
    expect(bad.errors.join('\n')).toMatch(/invariant missing/);
    expect(bad.errors.join('\n')).toMatch(/\.\. and absolute paths/);
    expect(C.proposalFile({ id: 'D-0001', title: 'X', invariant: 'Y.', paths: [] }).errors.join('\n')).toMatch(/paths must be a list/);
  });
});

describe('Z-C: accept of a choice that supersedes another', () => {
  const OLD = ['---', 'id: D-0001', 'title: Old', 'status: accepted', 'paths: ["lib/**"]', 'invariant: Old rule.', 'accepted_by: owner', 'accepted: 2026-11-01', '---', 'Body stays.', ''].join('\n');

  it('the old file gets status superseded, every other line byte for byte', () => {
    const r = C.supersededText(OLD);
    expect(r.error).toBeNull();
    expect(r.text).toBe(OLD.replace('status: accepted', 'status: superseded'));
    expect(C.parseDecision('D-0001-old.md', r.text).decision.status).toBe('superseded');
    expect(C.supersededText(r.text).text).toBe(r.text);
    expect(C.supersededText('no frontmatter').error).toMatch(/frontmatter/);
  });
});
