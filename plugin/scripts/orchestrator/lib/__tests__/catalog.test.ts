// =============================================================
// catalog.test.ts: the project catalog in docs/queue/catalog/ (lib/catalog.js, bolk B3 of the scope drift plan).
//
// Locks: (1) a design choice file is read from its frontmatter (JSON values, block lists, a nested object, comments
// after a value) and every shape error is named with the file; (2) stack.md gives its prefer lines and the generated
// block, reuse.md its rows; (3) check names a dead path pattern, a reuse row whose file or symbol is gone, a supersede
// that points nowhere, a plan link the register does not have and a generated block out of step; (4) the owner lock:
// only owner or theBoard can accept, a superseded choice cannot be accepted, the accept writes status, accepted_by and
// accepted and keeps the rest of the file byte for byte, and a choice that says accepted counts only with the owner's
// record of exactly its invariant, paths and check (a hand edit or a later change of the invariant reads as
// unconfirmed, an error in check); (5) the settings shape for catalog.doctor and catalog.planLinks; (6) the catalog is
// a protected path by default; (7) a plan entry links to design choices with `decisions`, shape checked, and an
// unknown id is a warning when the caller knows the catalog.
// Pure: no file system except the temporary folder readCatalog reads.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const C = require('../catalog.js') as any;
const QC = require('../queueConfig.js') as any;
const MG = require('../mergeGuard.js') as any;
const P = require('../queuePlan.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});

const DECISION = [
  '---',
  'id: D-0007',
  'title: Client code goes through the service layer',
  'status: proposed            # proposed | accepted | superseded',
  'paths: ["app/**", "components/**"]',
  'invariant: Files under app/ and components/ never import the database client directly.',
  'check:',
  '  forbid: "from [\'\\"]@db/client[\'\\"]"',
  '  hit: ["import x from \'@db/client\'"]',
  '  miss: ["import x from \'@services/factory\'"]',
  '  mode: warn',
  'supersedes: null',
  'plan: PL-ARCH-2',
  '---',
  'Context, the choice, the consequence.',
  '',
].join('\n');

describe('a design choice file', () => {
  it('reads the frontmatter: JSON lists, a nested object, null and a comment after a value', () => {
    const r = C.parseDecision('D-0007-service-layer.md', DECISION);
    expect(r.errors).toEqual([]);
    expect(r.decision).toMatchObject({
      id: 'D-0007',
      status: 'proposed',
      paths: ['app/**', 'components/**'],
      invariant: 'Files under app/ and components/ never import the database client directly.',
      supersedes: null,
      plan: 'PL-ARCH-2',
    });
    expect(r.decision.check).toMatchObject({ mode: 'warn' });
    expect(r.decision.body).toContain('Context, the choice');
  });

  it('reads a block list for paths', () => {
    const text = DECISION.replace('paths: ["app/**", "components/**"]', 'paths:\n  - app/**\n  - lib/x.ts');
    expect(C.parseDecision('D-0007-x.md', text).decision.paths).toEqual(['app/**', 'lib/x.ts']);
  });

  it('names every shape error with the file', () => {
    const bad = (from: string, to: string) => C.parseDecision('D-0007-x.md', DECISION.replace(from, to)).errors.join('\n');
    expect(bad('status: proposed', 'status: done')).toMatch(/D-0007-x\.md.*status must be one of proposed, accepted, superseded/);
    expect(bad('id: D-0007', 'id: D-0008')).toMatch(/id D-0008 does not match the file name/);
    expect(bad('id: D-0007', 'id: D7')).toMatch(/id must look like D-0001/);
    expect(bad('paths: ["app/**", "components/**"]', 'paths: []')).toMatch(/paths must be a list of at least one path/);
    expect(bad('paths: ["app/**", "components/**"]', 'paths: ["../x"]')).toMatch(/paths: \.\.\/x: \.\. and absolute paths/);
    expect(bad('Files under app/ and components/ never import the database client directly.', '')).toMatch(/invariant missing/);
    expect(bad('invariant: Files under', `invariant: ${'x'.repeat(301)} Files under`)).toMatch(/invariant is over 300/);
    expect(bad('plan: PL-ARCH-2', 'plan: arch')).toMatch(/plan must be a plan entry id/);
    expect(bad('supersedes: null', 'supersedes: old')).toMatch(/supersedes must be a design choice id/);
    expect(bad('supersedes: null', 'colour: red')).toMatch(/unknown field colour/);
    expect(bad('title: Client code goes through the service layer', 'title: ')).toMatch(/title missing/);
    expect(C.parseDecision('notes.md', DECISION).errors.join('\n')).toMatch(/file name must be D-0001-<slug>\.md/);
    expect(C.parseDecision('D-0007-x.md', 'no frontmatter').errors.join('\n')).toMatch(/no frontmatter/);
  });

  it('warns about a long body, never errors on it', () => {
    const long = `${DECISION}${Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')}\n`;
    const r = C.parseDecision('D-0007-x.md', long);
    expect(r.errors).toEqual([]);
    expect(r.warnings.join('\n')).toMatch(/over 30 lines/);
  });
});

describe('stack.md and reuse.md', () => {
  it('stack.md gives the prefer lines under ## Prefer and the generated block; comments are skipped', () => {
    const text = [
      '# Stack',
      '',
      C.BLOCK_BEGIN,
      '- Languages: Node',
      C.BLOCK_END,
      '',
      '## Prefer',
      '',
      '<!-- - dates: use dayjs, not moment -->',
      '- dates: use dayjs, not moment',
      '- http: use fetch; no axios',
      'loose text',
      '',
      '## Other',
      '- not: a prefer line',
    ].join('\n');
    const r = C.parseStack(text);
    expect(r.prefer).toEqual([
      { purpose: 'dates', use: 'use dayjs, not moment' },
      { purpose: 'http', use: 'use fetch; no axios' },
    ]);
    expect(r.block).toBe('- Languages: Node');
    expect(r.warnings.join('\n')).toMatch(/stack\.md: under ## Prefer, "loose text" is not a line "- <job>: <what to use>"/);
  });

  it('a block with a begin and no end is an error', () => {
    expect(C.parseStack(`${C.BLOCK_BEGIN}\n- x\n`).errors.join('\n')).toMatch(/generated block has no end marker/);
  });

  it('reuse.md gives the table rows, header and separator skipped; a row without three cells is an error', () => {
    const text = ['# Reuse', '', '| Purpose | Symbol | File |', '|---|---|---|', '| path form | norm | lib/a.js |', '| broken | x |'].join('\n');
    const r = C.parseReuse(text);
    expect(r.rows).toEqual([{ purpose: 'path form', symbol: 'norm', file: 'lib/a.js', line: 5 }]);
    expect(r.errors.join('\n')).toMatch(/reuse\.md:6: a row needs three cells/);
  });

  it('reuse.md over 40 rows is a warning', () => {
    const rows = Array.from({ length: 41 }, (_, i) => `| p${i} | s${i} | lib/a.js |`);
    expect(C.parseReuse(['| Purpose | Symbol | File |', '|---|---|---|', ...rows].join('\n')).warnings.join('\n')).toMatch(/41 rows/);
  });
});

/** A catalog folder on disk with the given files (relative to docs/queue/catalog/). */
function folder(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-catalog-'));
  temporary.push(root);
  for (const [name, text] of Object.entries(files)) {
    const f = path.join(root, name);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  return root;
}

describe('readCatalog and checkCatalog', () => {
  it('a missing folder is no catalog and no problem', () => {
    const r = C.readCatalog(path.join(os.tmpdir(), 'queue-catalog-none-here'));
    expect(r.exists).toBe(false);
    expect(C.checkCatalog(r, {}).errors).toEqual([]);
  });

  it('reads the three parts; README.md in decisions is skipped, another file there is a warning', () => {
    const root = folder({
      'stack.md': '## Prefer\n- dates: use dayjs\n',
      'reuse.md': '| Purpose | Symbol | File |\n|---|---|---|\n| path form | norm | lib/a.js |\n',
      'decisions/README.md': 'how to write one',
      'decisions/D-0007-service-layer.md': DECISION,
      'decisions/draft.txt': 'x',
    });
    const r = C.readCatalog(root);
    expect(r.exists).toBe(true);
    expect(r.stack.prefer).toHaveLength(1);
    expect(r.reuse.rows).toHaveLength(1);
    expect(r.decisions.map((d: any) => d.decision?.id)).toEqual(['D-0007']);
    expect(r.warnings.join('\n')).toMatch(/decisions\/draft\.txt is not a design choice/);
  });

  it('check: a dead path, a gone file or symbol, a supersede to nowhere, an unknown plan, a stale block, a duplicate id', () => {
    const second = DECISION.replace('id: D-0007', 'id: D-0008').replace('supersedes: null', 'supersedes: D-0009');
    const root = folder({
      'stack.md': `${C.BLOCK_BEGIN}\n- old\n${C.BLOCK_END}\n`,
      'reuse.md': '| Purpose | Symbol | File |\n|---|---|---|\n| path form | norm | lib/a.js |\n| gone | x | lib/none.js |\n',
      'decisions/D-0007-a.md': DECISION.replace('paths: ["app/**", "components/**"]', 'paths: ["nowhere/**"]'),
      'decisions/D-0008-b.md': second,
      'decisions/D-0008-c.md': second,
    });
    const r = C.checkCatalog(C.readCatalog(root), {
      files: ['lib/a.js', 'app/x.ts'],
      readFile: (f: string) => (f === 'lib/a.js' ? 'function other() {}\n' : null),
      planIds: new Set(['PL-OTHER']),
      stackBlock: '- new',
      ledger: C.emptyLedger(),
    });
    const all = [...r.errors, ...r.warnings].join('\n');
    expect(all).toMatch(/D-0007.*paths match no tracked file: nowhere\/\*\*/);
    expect(all).toMatch(/reuse\.md:4: lib\/none\.js does not exist/);
    expect(all).toMatch(/reuse\.md:3: norm is not in lib\/a\.js/);
    expect(r.errors.join('\n')).toMatch(/D-0008.*supersedes D-0009, which is not in the catalog/);
    expect(all).toMatch(/plan PL-ARCH-2 is not in the plan register/);
    expect(all).toMatch(/generated block.*out of step/);
    expect(r.errors.join('\n')).toMatch(/D-0008 is used by two files/);
  });
});

describe('the owner lock', () => {
  it('only owner or theBoard can accept; the accept writes three lines and keeps the rest', () => {
    for (const by of ['agent', 'orchestrator', '', undefined]) expect(C.acceptText(DECISION, { by }).error).toMatch(/only the owner/);
    const r = C.acceptText(DECISION, { by: 'owner', now: '2026-11-16T10:00:00.000Z' });
    expect(r.error).toBeNull();
    expect(r.text).toContain('status: accepted\n');
    expect(r.text).toContain('accepted_by: owner\n');
    expect(r.text).toContain('accepted: 2026-11-16\n');
    const strip = (t: string) => t.split('\n').filter((l) => !/^(status|accepted_by|accepted):/.test(l)).join('\n');
    expect(strip(r.text)).toBe(strip(DECISION));
    expect(C.parseDecision('D-0007-x.md', r.text).errors).toEqual([]);
    expect(C.acceptText(r.text, { by: 'theBoard', now: '2026-11-17T10:00:00.000Z' }).text.match(/accepted_by/g)).toHaveLength(1);
  });

  it('a superseded choice cannot be accepted', () => {
    expect(C.acceptText(DECISION.replace('status: proposed', 'status: superseded'), { by: 'owner' }).error).toMatch(/superseded/);
  });

  it('accepted counts only with the owner record of exactly this invariant, paths and check', () => {
    const accepted = C.parseDecision('D-0007-x.md', C.acceptText(DECISION, { by: 'owner' }).text).decision;
    const ledger = C.emptyLedger();
    expect(C.effectiveStatus(accepted, ledger)).toBe('unconfirmed');
    const recorded = C.recordAccept(ledger, accepted, { by: 'owner', now: '2026-11-16T10:00:00.000Z' });
    expect(C.effectiveStatus(accepted, recorded)).toBe('accepted');
    // The title and the body may change; the invariant, the paths and the check may not.
    expect(C.effectiveStatus({ ...accepted, title: 'New title', body: 'more' }, recorded)).toBe('accepted');
    expect(C.effectiveStatus({ ...accepted, invariant: 'Something weaker.' }, recorded)).toBe('unconfirmed');
    expect(C.effectiveStatus({ ...accepted, paths: ['app/**'] }, recorded)).toBe('unconfirmed');
    expect(C.effectiveStatus({ ...accepted, check: null }, recorded)).toBe('unconfirmed');
    // A proposed one is proposed whatever the record says.
    expect(C.effectiveStatus({ ...accepted, status: 'proposed' }, recorded)).toBe('proposed');
    expect(() => C.recordAccept(ledger, accepted, { by: 'agent' })).toThrow(/only the owner/);
  });

  it('check makes a hand-set accepted an error that names the command', () => {
    const root = folder({ 'decisions/D-0007-x.md': C.acceptText(DECISION, { by: 'owner' }).text });
    const r = C.checkCatalog(C.readCatalog(root), { ledger: C.emptyLedger() });
    expect(r.errors.join('\n')).toMatch(/D-0007 says accepted, but the owner did not accept this version.*catalog accept D-0007 --by owner/);
  });

  it('a broken ledger reads as empty (nothing is confirmed), never as everything', () => {
    expect(C.parseLedger('{ not json')).toEqual(C.emptyLedger());
    expect(C.parseLedger(JSON.stringify({ version: 1, decisions: [] }))).toEqual(C.emptyLedger());
  });
});

describe('settings, protected path and plan links', () => {
  it('catalog.doctor and catalog.planLinks are on by default and checked for shape', () => {
    // The excerpt settings of bolk B4 are locked in catalogExcerpt.test.ts.
    expect(QC.STANDARD.catalog).toMatchObject({ doctor: true, planLinks: true });
    expect(C.setupProblems(undefined)).toEqual([]);
    expect(C.setupProblems({ doctor: 'yes' })).toEqual(['catalog.doctor must be true or false']);
    expect(C.setupProblems([])).toEqual(['catalog must be an object']);
    expect(C.setupProblems({ other: true })).toEqual([
      'catalog.other is not a catalog setting (doctor, planLinks, missionExcerpt, reviewExcerpt, excerptTokens, index, checks, checkStop, gateAfter, captureAnswers, stackFacts, depsExcerpt)',
    ]);
  });

  it('docs/queue/catalog/ is a protected path by default', () => {
    expect(QC.STANDARD.protectedPaths).toContain('docs/queue/catalog/');
    expect(MG.isProtected('docs/queue/catalog/decisions/D-0007-x.md')).toBe(true);
    expect(MG.isProtected('docs/queue/other.md')).toBe(false);
  });

  it('a plan entry links design choices with decisions; the shape is an error, an unknown id a warning', () => {
    const base = { id: 'PL-A', title: 'A', project: 'p', priority: 'later', priority_set_by: 'owner', maturity: 'idea' };
    const ctx = { projects: { p: { title: 'P', area: 'x' } } };
    expect(P.validateEntry({ ...base, decisions: ['D-0007'] }, ctx).error).toEqual([]);
    expect(P.validateEntry({ ...base, decisions: ['D7'] }, ctx).error.join('\n')).toMatch(/decisions must be a list of design choice ids/);
    expect(P.validateEntry({ ...base, decisions: 'D-0007' }, ctx).error.join('\n')).toMatch(/decisions must be a list/);
    const known = { ...ctx, decisionIds: new Set(['D-0001']) };
    expect(P.validateEntry({ ...base, decisions: ['D-0007'] }, known).warnings.join('\n')).toMatch(/decision D-0007 is not in docs\/queue\/catalog/);
    expect(P.validateEntry({ ...base, decisions: ['D-0001'] }, known).warnings).toEqual([]);
  });
});
