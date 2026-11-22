// =============================================================
// catalogDependency.test.ts: the risk acceptance on a catalog entry of kind dependency (roadmap 0å KD-4,
// plans/katalog-design-stack-avhengigheter-2026-11-18.md section 6.2): `accepts` (the advisory ids) and `review_by`.
//
// Locks: (1) accepts and review_by are read on kind dependency, and paths may be left out (it binds no code); (2) they
// are refused on any other kind, without each other, or in a bad shape; (3) both bind (the fingerprint), so a track that
// widens accepts or moves review_by makes the entry unconfirmed; (4) acceptedAdvisories gives only the owner-accepted
// entries; (5) proposalFile writes them.
// =============================================================
import { describe, expect, it } from 'vitest';

const C = require('../catalog.js');

const entry = (extra: string[] = [], { kind = 'dependency', status = 'proposed', paths = true } = {}) =>
  [
    '---',
    'id: D-0007',
    'title: lodash template hole does not apply',
    `status: ${status}`,
    `kind: ${kind}`,
    ...(paths ? ['paths: ["package.json"]'] : []),
    'invariant: We never call lodash.template with input from users.',
    ...extra,
    '---',
    'Checked 2026-11-21.',
    '',
  ].join('\n');

const OK = ['accepts: ["GHSA-35jh-r3h4-6jhm", "CVE-2021-23337"]', 'review_by: 2027-02-01'];

describe('accepts and review_by', () => {
  it('reads both on kind dependency; paths may be left out', () => {
    const r = C.parseDecision('D-0007-lodash.md', entry(OK, { paths: false }));
    expect(r.errors).toEqual([]);
    expect(r.decision).toMatchObject({ kind: 'dependency', accepts: ['GHSA-35jh-r3h4-6jhm', 'CVE-2021-23337'], review_by: '2027-02-01', paths: [] });
  });

  it('refuses them on another kind, without each other, and in a bad shape', () => {
    const errs = (extra: string[], o = {}) => C.parseDecision('D-0007-lodash.md', entry(extra, o)).errors.join(' ');
    expect(errs(OK, { kind: 'stack' })).toMatch(/accepts and review_by are for kind dependency/);
    expect(errs(['accepts: ["GHSA-35jh-r3h4-6jhm"]'])).toMatch(/review_by/);
    expect(errs(['review_by: 2027-02-01'])).toMatch(/accepts/);
    expect(errs(['accepts: ["not an id"]', 'review_by: 2027-02-01'])).toMatch(/advisory ids/);
    expect(errs(['accepts: []', 'review_by: 2027-02-01'])).toMatch(/advisory ids/);
    expect(errs(['accepts: ["GHSA-35jh-r3h4-6jhm"]', 'review_by: next year'])).toMatch(/YYYY-MM-DD/);
    expect(errs(['accepts: ["GHSA-35jh-r3h4-6jhm"]', 'review_by: 2027-02-31'])).toMatch(/YYYY-MM-DD/);
    expect(errs([], { paths: false })).toMatch(/paths must be a list/);
  });

  it('both bind: widening accepts or moving review_by changes the fingerprint', () => {
    const d = C.parseDecision('D-0007-lodash.md', entry(OK)).decision;
    const wider = C.parseDecision('D-0007-lodash.md', entry(['accepts: ["GHSA-35jh-r3h4-6jhm", "CVE-2021-23337", "GHSA-xxxx-yyyy-zzzz"]', 'review_by: 2027-02-01'])).decision;
    const later = C.parseDecision('D-0007-lodash.md', entry(['accepts: ["GHSA-35jh-r3h4-6jhm", "CVE-2021-23337"]', 'review_by: 2030-01-01'])).decision;
    expect(C.fingerprint(wider)).not.toBe(C.fingerprint(d));
    expect(C.fingerprint(later)).not.toBe(C.fingerprint(d));
    const ledger = C.recordAccept(C.emptyLedger(), { ...d, status: 'accepted' }, { by: 'owner' });
    expect(C.effectiveStatus({ ...wider, status: 'accepted' }, ledger)).toBe('unconfirmed');
    expect(C.effectiveStatus({ ...d, status: 'accepted' }, ledger)).toBe('accepted');
  });

  it('acceptedAdvisories: only the owner-accepted dependency entries', () => {
    const d = C.parseDecision('D-0007-lodash.md', entry(OK)).decision;
    const ledger = C.recordAccept(C.emptyLedger(), { ...d, status: 'accepted' }, { by: 'owner' });
    const cat = (status: string) => ({ exists: true, decisions: [{ decision: { ...d, status } }] });
    expect(C.acceptedAdvisories(cat('accepted'), ledger)).toEqual([{ id: 'D-0007', accepts: ['GHSA-35jh-r3h4-6jhm', 'CVE-2021-23337'], reviewBy: '2027-02-01' }]);
    expect(C.acceptedAdvisories(cat('proposed'), ledger)).toEqual([]);
    expect(C.acceptedAdvisories(cat('accepted'), C.emptyLedger())).toEqual([]);
    expect(C.acceptedAdvisories({ exists: false }, ledger)).toEqual([]);
  });

  it('proposalFile writes accepts and review_by for kind dependency, and the result parses', () => {
    const f = C.proposalFile({
      id: 'D-0008',
      title: 'Accept a dev-only hole',
      kind: 'dependency',
      invariant: 'The hole is in a build tool that never ships.',
      paths: [],
      accepts: ['GHSA-aaaa-bbbb-cccc'],
      review_by: '2027-03-01',
    });
    expect(f.errors).toEqual([]);
    expect(f.text).toMatch(/accepts: \["GHSA-aaaa-bbbb-cccc"\]/);
    expect(f.text).toMatch(/review_by: 2027-03-01/);
  });
});
