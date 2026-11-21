// =============================================================
// catalogApplies.test.ts: catalog entries reach a task by its category, not only by its files (roadmap 0å KD-6,
// lib/catalog.js applies, lib/catalogExcerpt.js choose).
//
// Locks: (1) `applies` { class, domain, project, feature, label }: OR inside a dimension, AND between them, and an entry
// reaches a task when its paths OR its applies match; (2) a UI task in a new folder gets the design entry through its
// label; (3) a task with no files gets only category hits and the binding entries for the whole project, never every
// binding entry; (4) under the cap the category hits are cut before the file hits; (5) applies is in the fingerprint, so
// a changed applies needs a new accept; (6) catalog check warns on a value the queue and the project list do not know;
// (7) the excerpt lines carry their reason and the heading counts them, only when the catalog uses applies (without it
// the text is byte for byte as before); (8) proposalFile writes it, the board gets it in plain words.
// Pure.
// =============================================================
import { describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const C = require('../catalog.js') as any;
const X = require('../catalogExcerpt.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

/** A catalog entry file; extra frontmatter lines go in `more`. */
const entry = (id: string, status: string, paths: string[] | null, invariant: string, more: string[] = []) =>
  [
    '---',
    `id: ${id}`,
    `title: Choice ${id}`,
    `status: ${status}`,
    ...more,
    ...(paths ? [`paths: ${JSON.stringify(paths)}`] : []),
    `invariant: ${invariant}`,
    'supersedes: null',
    'plan: null',
    '---',
    'Context.',
    '',
  ].join('\n');

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

const text = (r: { lines: string[] } | null) => (r ? r.lines.join('\n') : '');

describe('the applies field', () => {
  it('parses each dimension as a list, and paths may be left out when applies says something', () => {
    const r = C.parseDecision('D-0001-ui.md', entry('D-0001', 'proposed', null, 'UI takes colours from tokens.', ['applies: {"label": ["visual"], "class": ["D", "K"]}']));
    expect(r.errors).toEqual([]);
    expect(r.decision.applies).toEqual({ class: ['D', 'K'], label: ['visual'] });
    expect(r.decision.paths).toEqual([]);
  });

  it('refuses an unknown dimension, a value that is not a list, and an entry with neither paths nor applies', () => {
    const bad = C.parseDecision('D-0001-ui.md', entry('D-0001', 'proposed', ['app/**'], 'x.', ['applies: {"colour": ["red"]}']));
    expect(bad.errors.join(' ')).toMatch(/applies: unknown dimension colour/);
    const notList = C.parseDecision('D-0001-ui.md', entry('D-0001', 'proposed', ['app/**'], 'x.', ['applies: {"class": "D"}']));
    expect(notList.errors.join(' ')).toMatch(/applies\.class must be a list/);
    const none = C.parseDecision('D-0001-ui.md', entry('D-0001', 'proposed', null, 'x.'));
    expect(none.errors.join(' ')).toMatch(/paths must be a list/);
    const empty = C.parseDecision('D-0001-ui.md', entry('D-0001', 'proposed', null, 'x.', ['applies: {}']));
    expect(empty.errors.join(' ')).toMatch(/paths must be a list/);
  });

  it('OR inside a dimension, AND between dimensions', () => {
    const applies = { class: ['D', 'K'], label: ['visual'] };
    expect(C.appliesMatch(applies, { class: 'D', labels: ['visual', 'x'] })).toBe('class D, label visual');
    expect(C.appliesMatch(applies, { class: 'K', labels: ['visual'] })).toBe('class K, label visual');
    expect(C.appliesMatch(applies, { class: 'D', labels: [] })).toBeNull();
    expect(C.appliesMatch(applies, { class: 'U', labels: ['visual'] })).toBeNull();
    expect(C.appliesMatch({}, { class: 'D' })).toBeNull();
    // The project: the task's own field, or the register's longest id prefix.
    expect(C.appliesMatch({ project: ['api'] }, { id: 'API-3', class: 'K' }, { register: { api: { prefixes: ['API-'] } } })).toBe('project api');
    expect(C.appliesMatch({ feature: ['login'], domain: ['web'] }, { feature: 'login', domain: 'Web' })).toBe('domain web, feature login');
  });

  it('is in the fingerprint: a changed applies needs a new accept; an entry without it keeps its fingerprint', () => {
    const one = C.parseDecision('D-0001-ui.md', entry('D-0001', 'accepted', ['app/**'], 'x.', ['applies: {"label": ["visual"]}'])).decision;
    const two = C.parseDecision('D-0001-ui.md', entry('D-0001', 'accepted', ['app/**'], 'x.', ['applies: {"label": ["visual", "ui"]}'])).decision;
    const plain = C.parseDecision('D-0001-ui.md', entry('D-0001', 'accepted', ['app/**'], 'x.')).decision;
    const ledger = C.recordAccept(C.emptyLedger(), one, { by: 'owner' });
    expect(C.effectiveStatus(one, ledger)).toBe('accepted');
    expect(C.effectiveStatus(two, ledger)).toBe('unconfirmed');
    expect(C.effectiveStatus(plain, ledger)).toBe('unconfirmed');
    // An entry without applies has the fingerprint it had before KD-6.
    expect(C.fingerprint(plain)).toBe(C.fingerprint({ ...plain, applies: null }));
  });

  it('catalog check warns on a value the queue and the project list do not know (a typo)', () => {
    const cat = catalog({
      'D-0001-ui.md': entry('D-0001', 'proposed', null, 'x.', ['applies: {"label": ["visaul"], "class": ["D"]}']),
    });
    const known = { class: new Set(['K', 'D', 'U']), label: new Set(['visual']), domain: new Set(), project: new Set(), feature: new Set() };
    const r = C.checkCatalog(cat, { known });
    expect(r.errors).toEqual([]);
    expect(r.warnings.join('\n')).toMatch(/D-0001.*applies label visaul/);
    expect(r.warnings.join('\n')).not.toMatch(/applies class D/);
    // Without the known values nothing is checked.
    expect(C.checkCatalog(cat, {}).warnings.join('\n')).not.toMatch(/visaul/);
  });

  it('knownValues collects the values from the tasks, the archive and the project list', () => {
    const k = C.knownValues({ tasks: [{ class: 'D', domain: 'board', labels: ['visual'], feature: 'login', project: 'api' }], projects: { web: {} } }, [{ class: 'K', labels: ['old'] }]);
    expect([...k.class]).toEqual(expect.arrayContaining(['D', 'K', 'U']));
    expect([...k.label]).toEqual(['visual', 'old']);
    expect([...k.project]).toEqual(expect.arrayContaining(['api', 'web']));
    expect([...k.domain]).toEqual(['board']);
    expect([...k.feature]).toEqual(['login']);
  });

  it('proposalFile writes applies and the file parses back to the same; no applies writes the file as before', () => {
    const r = C.proposalFile({ id: 'D-0003', title: 'Design for visual tasks', invariant: 'x.', paths: [], applies: { class: ['D'], label: ['visual'] } });
    expect(r.errors).toEqual([]);
    expect(r.text).toContain('applies: {"class":["D"],"label":["visual"]}');
    expect(C.parseDecision(r.name, r.text).decision.applies).toEqual({ class: ['D'], label: ['visual'] });
    const plain = C.proposalFile({ id: 'D-0003', title: 'Plain', invariant: 'x.', paths: ['app/**'] });
    expect(plain.text).not.toContain('applies');
  });

  it('the board gets applies in plain words', () => {
    expect(C.appliesWords({ class: ['D'], label: ['visual'] })).toBe('D tasks, visual');
    expect(C.appliesWords({ class: ['D', 'K'], project: ['api'] })).toBe('D or K tasks, project api');
    expect(C.appliesWords({})).toBeNull();
    const cat = catalog({ 'D-0001-ui.md': entry('D-0001', 'proposed', null, 'x.', ['applies: {"class": ["D"], "label": ["visual"]}']) });
    expect(C.boardGroups(cat)[0].entries[0].applies).toBe('D tasks, visual');
  });
});

// The excerpt: what reaches a task, in which order, and with which reason.
const DESIGN = entry('D-0010', 'accepted', ['app/**'], 'UI takes colours, type and spacing from the tokens.', [
  'kind: design',
  'applies: {"label": ["visual"]}',
]);
const CAT = catalog({
  'D-0001-lib.md': entry('D-0001', 'accepted', ['lib/**'], 'Files under lib/ stay pure.'),
  'D-0002-all.md': entry('D-0002', 'accepted', ['**'], 'No secret is ever written to a log.'),
  'D-0003-db.md': entry('D-0003', 'accepted', null, 'A D task names its rollback in the mission.', ['applies: {"class": ["D", "D+"]}']),
  'D-0004-k.md': entry('D-0004', 'accepted', null, 'A K task keeps its change under one folder.', ['applies: {"class": ["K"]}']),
  'D-0005-prop.md': entry('D-0005', 'proposed', null, 'A D task lists the tables it touches.', ['applies: {"class": ["D"]}']),
  'D-0010-design.md': DESIGN,
});
const LEDGER = ledgerFor(CAT, ['D-0001', 'D-0002', 'D-0003', 'D-0004', 'D-0010']);

describe('the excerpt by category', () => {
  it('a UI task in a new folder gets the design entry through its label, with the reason on the line', () => {
    const r = X.excerpt(CAT, { id: 'T1', class: 'K', labels: ['visual'], owned_files: ['newui/page.tsx'] }, { ledger: LEDGER });
    const t = text(r);
    expect(t).toContain('Design language');
    const line = r.lines.find((l: string) => l.includes('D-0010'));
    expect(line).toContain('label visual');
    // The whole-project entry reaches it by its files ("**"), the K entry by its class.
    expect(r.lines.find((l: string) => l.includes('D-0002'))).toMatch(/\(files/);
    expect(r.lines.find((l: string) => l.includes('D-0004'))).toContain('class K');
    expect(t).not.toContain('D-0001');
    expect(t).not.toContain('D-0003');
    // The heading counts the hits per reason.
    expect(r.lines[0]).toMatch(/1 by files, 2 by category/);
    expect(r.counts.reasons).toEqual({ files: 1, category: 2, project: 0 });
  });

  it('a task with no files gets only its category hits and the binding entries for the whole project', () => {
    const r = X.excerpt(CAT, { id: 'T2', class: 'D' }, { ledger: LEDGER });
    const t = text(r);
    expect(t).toContain('D-0003');
    expect(t).toContain('D-0002');
    // A category hit on a proposed entry is a proposal.
    expect(t).toContain('Proposed design choices');
    expect(t).toContain('D-0005');
    // Not every binding entry: lib/** names files the task does not name, and D-0004 is for K tasks.
    expect(t).not.toContain('D-0001');
    expect(t).not.toContain('D-0004');
    expect(t).not.toContain('D-0010');
    expect(r.lines.find((l: string) => l.includes('D-0002'))).toContain('whole project');
    expect(r.lines[0]).toContain('names no files');
  });

  it('a file hit ranks before a category hit, and the cap cuts the category hits first', () => {
    const files: Record<string, string> = {};
    for (let i = 1; i <= 3; i++)
      files[`D-000${i}-c${i}.md`] = entry(`D-000${i}`, 'accepted', null, `Category rule ${i}, written out long enough to cost some tokens in the mission text here.`, ['applies: {"class": ["D"]}']);
    for (let i = 7; i <= 9; i++)
      files[`D-000${i}-f${i}.md`] = entry(`D-000${i}`, 'accepted', ['lib/**'], `File rule ${i}, written out long enough to cost some tokens in the mission text here.`);
    const cat = catalog(files);
    const ledger = ledgerFor(cat, Object.keys(files).map((n) => n.slice(0, 6)));
    const wide = X.excerpt(cat, { id: 'T3', class: 'D', owned_files: ['lib/a.js'] }, { ledger, capTokens: 6000 });
    const at = (id: string) => wide.lines.findIndex((l: string) => l.includes(id));
    expect(at('D-0007')).toBeLessThan(at('D-0001'));
    // Room for the three file hits and not more: every category hit is cut, no file hit is.
    const r = X.excerpt(cat, { id: 'T3', class: 'D', owned_files: ['lib/a.js'] }, { ledger, capTokens: 230 });
    const t = text(r);
    expect(r.tokens).toBeLessThanOrEqual(230);
    for (const id of ['D-0007', 'D-0008', 'D-0009']) expect(t).toContain(id);
    for (const id of ['D-0001', 'D-0002', 'D-0003']) expect(t).not.toContain(id);
    expect(r.cut.binding).toBe(3);
    expect(r.counts.reasons).toEqual({ files: 3, category: 0, project: 0 });
  });

  it('a catalog without applies gives the text without reasons, as before', () => {
    const plain = catalog({ 'D-0001-lib.md': entry('D-0001', 'accepted', ['lib/**'], 'Files under lib/ stay pure.') });
    const r = X.excerpt(plain, { id: 'T4', class: 'D', owned_files: ['lib/a.js'] }, { ledger: ledgerFor(plain, ['D-0001']) });
    expect(r.lines.find((l: string) => l.includes('D-0001'))).toBe('  - D-0001 (lib/**): Files under lib/ stay pure.');
    expect(r.lines[0]).not.toMatch(/by files|by category/);
  });
});
