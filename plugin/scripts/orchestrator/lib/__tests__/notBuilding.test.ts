// =============================================================
// notBuilding.test.ts: "Not building", the register of what the project deliberately does not build (roadmap 0f).
//
// Locks: (a) a rejection is a D-entry in the catalog with kind not-building (status proposed until the owner accepts,
// then status not-building), read with its keywords, revisit condition and source, and never put in a mission excerpt;
// its accept writes status not-building, not accepted, and a not-building entry set by hand is unconfirmed; (b) a draft
// from a declined proposal or a card set aside carries the reason as its text and keywords from the title; (c) a new
// proposal whose text has a keyword of an entry the owner decided gives one INFO line, a proposed draft never does;
// (d) doctor gives one INFO row: always when a revisit date has passed, else only on request (doctor --all);
// notBuilding.match off gives nothing.
// Pure: lib/catalog.js and lib/notBuilding.js.
// =============================================================
import { describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const C = require('../catalog.js') as any;
const NB = require('../notBuilding.js') as any;
const EX = require('../catalogExcerpt.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const ENTRY = [
  '---',
  'id: D-0003',
  'title: A keepalive ping for idle sessions',
  'status: not-building',
  'kind: not-building',
  'keywords: ["keepalive", "idle ping"]',
  'revisit: "2026-12-01: when a client drops idle sessions"',
  'source: roadmap, deliberately not now',
  'supersedes: null',
  'plan: null',
  'accepted_by: owner',
  'accepted: 2026-11-18',
  '---',
  'Why: the client keeps the session; a ping costs tokens every hour.',
  '',
].join('\n');

const parsed = (name: string, text: string) => C.parseDecision(name, text);
const catalogOf = (...files: [string, string][]) => ({
  exists: true,
  decisions: files.map(([name, source]) => ({ name, source, ...parsed(name, source) })),
  errors: [],
  warnings: [],
});
const confirmed = (d: any) => C.recordAccept(C.emptyLedger(), d, { by: 'owner', now: '2026-11-18T10:00:00Z' });

describe('(a) the not-building entry in the catalog', () => {
  it('reads with its keywords, revisit and source; no invariant or paths needed', () => {
    const r = parsed('D-0003-keepalive.md', ENTRY);
    expect(r.errors).toEqual([]);
    expect(r.decision).toMatchObject({
      id: 'D-0003',
      kind: 'not-building',
      status: 'not-building',
      keywords: ['keepalive', 'idle ping'],
      revisit: '2026-12-01: when a client drops idle sessions',
      source: 'roadmap, deliberately not now',
      invariant: null,
      paths: [],
    });
    expect(C.isNotBuilding(r.decision)).toBe(true);
  });

  it('refuses a check rule, accepted as status and a bad keyword list on a not-building entry', () => {
    expect(parsed('D-0003-k.md', ENTRY.replace('status: not-building', 'status: accepted')).errors.join(' ')).toMatch(/status not-building/);
    expect(parsed('D-0003-k.md', ENTRY.replace('keywords: ["keepalive", "idle ping"]', 'keywords: "keepalive"')).errors.join(' ')).toMatch(/keywords must be a list/);
    expect(parsed('D-0003-k.md', ENTRY.replace('kind: not-building', 'kind: maybe')).errors.join(' ')).toMatch(/kind must be/);
    const withCheck = ENTRY.replace('plan: null', 'plan: null\ncheck:\n  forbid: "x"\n  hit: ["x"]\n  miss: ["y"]');
    expect(parsed('D-0003-k.md', withCheck).errors.join(' ')).toMatch(/no check rule/);
    // A plain design choice still needs its invariant and paths.
    const plain = ENTRY.replace('status: not-building', 'status: proposed').replace('kind: not-building\n', '');
    expect(parsed('D-0003-k.md', plain).errors.join(' ')).toMatch(/invariant missing/);
  });

  it('the owner lock holds: hand-set not-building is unconfirmed, the accept of a draft writes status not-building', () => {
    const d = parsed('D-0003-k.md', ENTRY).decision;
    expect(C.effectiveStatus(d, C.emptyLedger())).toBe('unconfirmed');
    expect(C.effectiveStatus(d, confirmed(d))).toBe('not-building');
    // A changed keyword list needs a new accept: it decides what the INFO lines match.
    const changed = parsed('D-0003-k.md', ENTRY.replace('"idle ping"', '"ping"')).decision;
    expect(C.effectiveStatus(changed, confirmed(d))).toBe('unconfirmed');
    const draft = C.proposalFile({ id: 'D-0004', ...NB.draft({ title: 'Agent summaries after each turn', why: 'Too noisy.', source: 'declined proposal A-7' }) });
    expect(draft.errors).toEqual([]);
    expect(draft.text).toMatch(/\nstatus: proposed\nkind: not-building\n/);
    const acc = C.acceptText(draft.text, { by: 'owner', now: '2026-11-20T08:00:00Z' });
    expect(acc.error).toBeNull();
    expect(acc.text).toMatch(/\nstatus: not-building\naccepted_by: owner\naccepted: 2026-11-20\n/);
    expect(C.parseDecision(draft.name, acc.text).errors).toEqual([]);
  });

  it('reopening: a choice that supersedes the entry sets it superseded; a not-building entry is never in an excerpt', () => {
    const s = C.supersededText(ENTRY);
    expect(s.text).toMatch(/\nstatus: superseded\n/);
    expect(parsed('D-0003-k.md', s.text).errors).toEqual([]);
    // Even with an invariant and paths, and also while it is only a draft (proposed).
    const full = ENTRY.replace('plan: null', 'plan: null\ninvariant: We do not add a keepalive ping.\npaths: ["**"]');
    for (const text of [full, full.replace('status: not-building', 'status: proposed')]) {
      const cat = catalogOf(['D-0003-k.md', text]);
      expect(cat.decisions[0].errors).toEqual([]);
      const d = cat.decisions[0].decision;
      for (const task of [{ owned_files: [] }, { owned_files: ['lib/a.js'] }]) {
        const ex = EX.choose(cat, task, { ledger: confirmed(d) });
        expect([...ex.binding, ...ex.proposed].map((x: any) => x.d.id)).toEqual([]);
      }
    }
  });
});

describe('(b) drafts from a decline or a card set aside', () => {
  it('the reason becomes the text, the title the keywords, the source says where it came from', () => {
    const d = NB.draft({ title: 'Rename queue.config.json to ravenseat.json', why: 'Every install would break.', source: 'declined proposal B-2' });
    expect(d).toMatchObject({ kind: 'not-building', title: 'Rename queue.config.json to ravenseat.json', source: 'declined proposal B-2', paths: [] });
    expect(d.why).toMatch(/Every install would break\./);
    expect(d.keywords).toEqual(expect.arrayContaining(['rename', 'queue.config.json', 'ravenseat.json']));
    expect(d.keywords.length).toBeLessThanOrEqual(NB.KEYWORDS_MAX);
    const none = NB.draft({ title: 'Live sync with Issues', why: '', source: 'Checks card x' });
    expect(none.why).toMatch(/no reason was given/i);
  });
});

describe('(c) a new proposal against the register', () => {
  const cat = catalogOf(['D-0003-k.md', ENTRY]);
  const d = cat.decisions[0].decision;
  const ledger = confirmed(d);

  it('a keyword in the text gives one INFO line with the date and the reason; it stops nothing', () => {
    const list = NB.entries(cat, ledger);
    const hits = NB.matches(list, 'Add a KEEPALIVE so the session never times out');
    expect(hits.map((h: any) => h.id)).toEqual(['D-0003']);
    const line = NB.infoLine(hits[0], { subject: 'A-9', cli: 'ravenseat' });
    expect(line).toMatch(/^INFO not-building: A-9 /);
    expect(line).toMatch(/chosen not to build 2026-11-18 because the client keeps the session/);
    expect(line).toMatch(/ravenseat catalog show D-0003/);
    // A whole word only, and a phrase keyword as a phrase.
    expect(NB.matches(list, 'keepalives and pings')).toEqual([]);
    expect(NB.matches(list, 'an idle ping now and then').length).toBe(1);
  });

  it('a proposed draft or an unconfirmed entry matches nothing: only the owner decides what is not built', () => {
    expect(NB.matches(NB.entries(cat, C.emptyLedger()), 'keepalive')).toEqual([]);
    expect(NB.lines(cat, ledger, [{ id: 'A-9', text: 'keepalive' }], { setup: { match: false } })).toEqual([]);
    expect(NB.lines(cat, ledger, [{ id: 'A-9', text: 'keepalive' }], { setup: { match: true } })).toHaveLength(1);
  });
});

describe('(d) doctor and the setting', () => {
  const cat = catalogOf(['D-0003-k.md', ENTRY]);
  const ledger = confirmed(cat.decisions[0].decision);

  it('a passed revisit date is shown always; an old entry only on request', () => {
    const due = NB.doctorRows(NB.entries(cat, ledger), { now: Date.parse('2026-12-05T00:00:00Z') });
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ status: 'INFO', name: 'not-building' });
    expect(due[0].onRequest).toBeFalsy();
    expect(due[0].message).toMatch(/D-0003/);
    // No date in the revisit condition: an old entry is a row only on request (doctor --all).
    const undated = catalogOf(['D-0003-k.md', ENTRY.replace('"2026-12-01: when a client drops idle sessions"', 'when a client drops idle sessions')]);
    const later = Date.parse('2026-11-18T00:00:00Z') + 200 * 86_400_000;
    const old = NB.doctorRows(NB.entries(undated, confirmed(undated.decisions[0].decision)), { now: later });
    expect(old).toHaveLength(1);
    expect(old[0].onRequest).toBe(true);
    expect(old[0].message).toMatch(/decided over 180 days ago/);
    const recent = NB.doctorRows(NB.entries(cat, ledger), { now: Date.parse('2026-11-25T00:00:00Z') });
    expect(recent).toEqual([]);
  });

  it('notBuilding.match is a boolean, on by default', () => {
    expect(NB.setupOf({})).toEqual({ match: true });
    expect(NB.setupOf({ notBuilding: { match: false } })).toEqual({ match: false });
    expect(NB.setupProblems({ match: 'yes' })).toEqual(['notBuilding.match must be true or false']);
    expect(NB.setupProblems({ other: true })[0]).toMatch(/not a notBuilding setting/);
  });
});
