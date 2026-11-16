// =============================================================
// catalogExcerpt.test.ts: the excerpt of the project catalog in the mission and the review package (lib/catalogExcerpt.js,
// bolk B4 of the scope drift plan).
//
// Locks: (1) the choice of what goes in: design choices whose paths meet the task's owned_files, shared_patch and reads
// (a file or a folder), the prefer lines, and the reuse rows in the task's folders; a superseded choice never; (2) only a
// choice the owner accepted (with the record) is binding, a proposed or unconfirmed one is marked as a suggestion; (3) a
// task that names no files gets the accepted choices only, never the proposed ones; (4) the cap: the text stays within
// the token cap, accepted choices are kept before the reuse rows, and the heading says how many tokens it used and what
// was cut; (5) nothing relevant, or no catalog, gives no block at all; (6) the settings (catalog.missionExcerpt,
// catalog.reviewExcerpt, catalog.excerptTokens) and that off gives nothing; (7) the track block and the review package
// carry the excerpt, and the reviewer agents have the point that checks the delivery against it (V9).
// Pure, except the temporary folder forTask reads.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const C = require('../catalog.js') as any;
const X = require('../catalogExcerpt.js') as any;
const QC = require('../queueConfig.js') as any;
const EXT = require('../logic/external.js') as any;
const RES = require('../logic/results.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});

const decision = (id: string, status: string, paths: string[], invariant: string) =>
  [
    '---',
    `id: ${id}`,
    `title: Choice ${id}`,
    `status: ${status}`,
    `paths: ${JSON.stringify(paths)}`,
    `invariant: ${invariant}`,
    'supersedes: null',
    'plan: null',
    '---',
    'Context.',
    '',
  ].join('\n');

const STACK = [
  '# Stack',
  '',
  '## Prefer',
  '',
  '- dates: dayjs, never moment',
  '- http: the fetch wrapper in lib/http.js',
  '',
].join('\n');

const REUSE = [
  '# Reuse',
  '',
  '| Purpose | Symbol | File |',
  '|---|---|---|',
  '| Normalize a repo path | norm | lib/paths.js |',
  '| Read a JSON file safely | readJson | lib/io/json.js |',
  '| Print a table | table | cli/print.mjs |',
  '',
].join('\n');

/** A catalog object as readCatalog gives it, from file texts. */
function catalog(decisions: Record<string, string>, { stack = STACK, reuse = REUSE } = {}) {
  return {
    exists: true,
    dir: 'docs/queue/catalog',
    stack: stack == null ? null : C.parseStack(stack),
    reuse: reuse == null ? null : C.parseReuse(reuse),
    decisions: Object.entries(decisions).map(([name, source]) => ({ name, source, ...C.parseDecision(name, source) })),
    errors: [],
    warnings: [],
  };
}

/** The owner's record for the given choices (as catalog accept writes it). */
function ledgerFor(cat: any, ids: string[]) {
  let l = C.emptyLedger();
  for (const x of cat.decisions) if (ids.includes(x.decision.id)) l = C.recordAccept(l, x.decision, { by: 'owner' });
  return l;
}

const CAT = catalog({
  'D-0001-pure-lib.md': decision('D-0001', 'accepted', ['lib/**'], 'Files under lib/ stay pure: no process starts and no writes.'),
  'D-0002-cli-io.md': decision('D-0002', 'proposed', ['cli/**'], 'Only cli/ prints to the terminal.'),
  'D-0003-old.md': decision('D-0003', 'superseded', ['lib/**'], 'An old rule nobody follows.'),
  'D-0004-hand.md': decision('D-0004', 'accepted', ['lib/io/**'], 'Every file read in lib/io/ goes through readJson.'),
  'D-0005-docs.md': decision('D-0005', 'accepted', ['docs/**'], 'Docs never name a person.'),
});
// D-0001 and D-0005 are accepted by the owner; D-0004 says accepted, but there is no record (a hand edit).
const LEDGER = ledgerFor(CAT, ['D-0001', 'D-0005']);

const task = (over: Record<string, unknown> = {}) => ({
  id: 'T1',
  title: 'Task T1',
  class: 'K',
  owned_files: ['lib/io/json.js'],
  reads: ['lib/paths.js'],
  ...over,
});

const text = (r: { lines: string[] } | null) => (r ? r.lines.join('\n') : '');

describe('what the excerpt holds', () => {
  it('the choices whose paths meet the task files, the prefer lines and the reuse rows in its folders', () => {
    const r = X.excerpt(CAT, task(), { ledger: LEDGER });
    const t = text(r);
    expect(t).toContain('D-0001');
    expect(t).toContain('Files under lib/ stay pure');
    expect(t).toContain('D-0004');
    // Not in the task's area, and superseded never.
    expect(t).not.toContain('D-0002');
    expect(t).not.toContain('D-0005');
    expect(t).not.toContain('D-0003');
    expect(t).toContain('dates: dayjs, never moment');
    expect(t).toContain('`readJson` in `lib/io/json.js`');
    expect(t).toContain('`norm` in `lib/paths.js`');
    expect(t).not.toContain('cli/print.mjs');
  });

  it('only an accepted choice with the owner record is binding; a proposed or unconfirmed one is a suggestion', () => {
    const r = X.excerpt(CAT, task({ owned_files: ['lib/io/json.js', 'cli/run.mjs'] }), { ledger: LEDGER });
    const lines = r.lines as string[];
    const binding = lines.findIndex((l) => l.includes('Design choices that hold'));
    const proposed = lines.findIndex((l) => l.includes('Proposed design choices'));
    expect(binding).toBeGreaterThanOrEqual(0);
    expect(proposed).toBeGreaterThan(binding);
    const at = (id: string) => lines.findIndex((l) => l.includes(id));
    expect(at('D-0001')).toBeGreaterThan(binding);
    expect(at('D-0001')).toBeLessThan(proposed);
    // Proposed, and accepted without the owner's record: both under the suggestions, the latter marked.
    expect(at('D-0002')).toBeGreaterThan(proposed);
    expect(at('D-0004')).toBeGreaterThan(proposed);
    expect(lines[at('D-0004')]).toContain('unconfirmed');
    expect(lines[proposed]).toMatch(/not binding/);
  });

  it('a folder in the ownership meets a choice inside it, and a choice elsewhere stays out', () => {
    const r = X.excerpt(CAT, task({ owned_files: ['lib/io/'], reads: [] }), { ledger: LEDGER });
    const t = text(r);
    expect(t).toContain('D-0001');
    expect(t).toContain('D-0004');
    expect(t).not.toContain('D-0002');
    expect(t).toContain('`readJson` in `lib/io/json.js`');
    expect(t).not.toContain('`norm`');
  });

  it('a task that names no files gets every accepted choice and no proposed one', () => {
    const r = X.excerpt(CAT, task({ owned_files: [], reads: [] }), { ledger: LEDGER });
    const t = text(r);
    expect(t).toContain('D-0001');
    expect(t).toContain('D-0005');
    expect(t).not.toContain('D-0002');
    expect(t).not.toContain('D-0004');
    expect(r.lines[0]).toContain('names no files');
  });

  it('nothing relevant, or no catalog, gives no block at all', () => {
    const empty = catalog({}, { stack: null, reuse: null });
    expect(X.excerpt(empty, task(), { ledger: LEDGER })).toBeNull();
    expect(X.excerpt({ exists: false, decisions: [] }, task(), { ledger: LEDGER })).toBeNull();
    expect(X.excerpt(null, task(), { ledger: LEDGER })).toBeNull();
    const only = catalog({ 'D-0005-docs.md': decision('D-0005', 'accepted', ['docs/**'], 'Docs never name a person.') }, { stack: null, reuse: null });
    expect(X.excerpt(only, task(), { ledger: ledgerFor(only, ['D-0005']) })).toBeNull();
  });
});

describe('the cap and the measurement line', () => {
  it('the heading says how many tokens the excerpt used, of the cap, and that nothing was cut', () => {
    const r = X.excerpt(CAT, task(), { ledger: LEDGER, capTokens: 1500 });
    const t = text(r);
    expect(r.tokens).toBe(Math.round(t.length / 4));
    expect(r.lines[0]).toContain(`about ${r.tokens} of at most 1500 tokens`);
    expect(r.lines[0]).toContain('nothing cut');
    expect(r.cut).toEqual({ binding: 0, proposed: 0, prefer: 0, reuse: 0 });
  });

  it('over the cap, the reuse rows go before the binding choices, and the heading names what was cut', () => {
    const many: Record<string, string> = {};
    for (let i = 1; i <= 9; i++)
      many[`D-000${i}-c${i}.md`] = decision(`D-000${i}`, 'accepted', ['lib/**'], `Rule number ${i} for lib, written out long enough to cost some tokens in the mission text.`);
    const rows = ['| Purpose | Symbol | File |', '|---|---|---|'];
    for (let i = 1; i <= 30; i++) rows.push(`| Helper ${i} for something useful | helper${i} | lib/io/h${i}.js |`);
    const big = catalog(many, { reuse: rows.join('\n') });
    const r = X.excerpt(big, task(), { ledger: ledgerFor(big, Object.keys(many).map((n) => n.slice(0, 6))), capTokens: 300 });
    const t = text(r);
    expect(r.tokens).toBeLessThanOrEqual(300);
    expect(Math.round(t.length / 4)).toBe(r.tokens);
    // At most five choices, the first ones by id; the rest are counted as cut.
    expect(t).toContain('D-0001');
    expect(t).not.toContain('D-0009');
    expect(r.cut.binding).toBeGreaterThanOrEqual(4);
    expect(r.cut.reuse).toBeGreaterThan(0);
    expect(r.lines[0]).toMatch(/cut: \d+ binding choices?, .*\d+ reuse rows?/);
    expect(r.lines[0]).toContain('catalog show');
  });

  it('the prefer lines stop at ten and the reuse rows at fifteen', () => {
    const prefer = ['## Prefer', ''];
    for (let i = 1; i <= 12; i++) prefer.push(`- job${i}: lib${i}`);
    const rows = ['| Purpose | Symbol | File |', '|---|---|---|'];
    for (let i = 1; i <= 20; i++) rows.push(`| Helper ${i} | h${i} | lib/io/h${i}.js |`);
    const c = catalog({}, { stack: prefer.join('\n'), reuse: rows.join('\n') });
    const r = X.excerpt(c, task(), { ledger: C.emptyLedger(), capTokens: 6000 });
    const t = text(r);
    expect(t).toContain('job10: lib10');
    expect(t).not.toContain('job11');
    expect(t).toContain('`h15`');
    expect(t).not.toContain('`h16`');
    expect(r.cut).toMatchObject({ prefer: 2, reuse: 5 });
  });
});

describe('the settings', () => {
  it('catalog.missionExcerpt and catalog.reviewExcerpt are on and the cap is 1500 tokens by default', () => {
    expect(QC.STANDARD.catalog).toEqual({ doctor: true, planLinks: true, missionExcerpt: true, reviewExcerpt: true, excerptTokens: 1500 });
    expect(C.setupOf({})).toEqual({ doctor: true, planLinks: true, missionExcerpt: true, reviewExcerpt: true, excerptTokens: 1500 });
    expect(C.setupOf({ catalog: { excerptTokens: 800, missionExcerpt: false } })).toMatchObject({ excerptTokens: 800, missionExcerpt: false });
    // A broken value reads as its default.
    expect(C.setupOf({ catalog: { excerptTokens: 'many' } }).excerptTokens).toBe(1500);
    expect(C.setupProblems({ excerptTokens: 50 })).toEqual(['catalog.excerptTokens must be a whole number from 200 to 6000']);
    expect(C.setupProblems({ excerptTokens: 2000, reviewExcerpt: false })).toEqual([]);
    expect(C.setupProblems({ missionExcerpt: 'yes' })).toEqual(['catalog.missionExcerpt must be true or false']);
  });

  it('forTask reads the catalog and the owner record from the folders, and gives nothing when the setting is off', () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-excerpt-')));
    temporary.push(root);
    const dir = path.join(root, 'docs', 'queue', 'catalog');
    fs.mkdirSync(path.join(dir, 'decisions'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'stack.md'), STACK);
    const src = decision('D-0001', 'accepted', ['lib/**'], 'Files under lib/ stay pure: no process starts and no writes.');
    fs.writeFileSync(path.join(dir, 'decisions', 'D-0001-pure-lib.md'), src);
    const data = path.join(root, 'data');
    fs.mkdirSync(data);
    const d = C.parseDecision('D-0001-pure-lib.md', src).decision;
    fs.writeFileSync(path.join(data, C.LEDGER_FILE), JSON.stringify(C.recordAccept(C.emptyLedger(), d, { by: 'owner' })));
    const on = X.forTask(task(), { which: 'mission', root, dataFolder: data, config: {} });
    expect(on.lines.join('\n')).toContain('Design choices that hold');
    expect(on.lines.join('\n')).toContain('D-0001');
    expect(X.forTask(task(), { which: 'mission', root, dataFolder: data, config: { catalog: { missionExcerpt: false } } })).toBeNull();
    expect(X.forTask(task(), { which: 'review', root, dataFolder: data, config: { catalog: { reviewExcerpt: false } } })).toBeNull();
    // Without the record, the same choice is only a suggestion.
    const noRecord = X.forTask(task(), { which: 'mission', root, dataFolder: path.join(root, 'none'), config: {} });
    expect(noRecord.lines.join('\n')).not.toContain('Design choices that hold');
    // No catalog folder: nothing, and never a throw.
    expect(X.forTask(task(), { which: 'mission', root: path.join(root, 'none'), dataFolder: data, config: {} })).toBeNull();
  });
});

describe('the mission and the review package carry it', () => {
  it('the track block has the excerpt after the ownership lines, and none when it is null', () => {
    const r = X.excerpt(CAT, task(), { ledger: LEDGER });
    const o = { ...task(), status: 'running', estimate_min: 30 };
    const withIt = EXT.trackBlock(o, { tasks: [o] }, { text: 'Mission text.', catalog: r.lines });
    expect(withIt).toContain('**From the project catalog**');
    expect(withIt.indexOf('**From the project catalog**')).toBeGreaterThan(withIt.indexOf('**Ownership in the queue:**'));
    expect(withIt.indexOf('**From the project catalog**')).toBeLessThan(withIt.indexOf('Mission text.'));
    const without = EXT.trackBlock(o, { tasks: [o] }, { text: 'Mission text.', catalog: null });
    expect(without).not.toContain('From the project catalog');
  });

  it('the review package has the same excerpt with the reviewer instruction, and no section without one', () => {
    const r = X.excerpt(CAT, task(), { ledger: LEDGER, form: 'review' });
    expect(r.lines).toContain('## From the project catalog');
    const t = text(r);
    expect(t).toContain('`duplication`');
    expect(t).toContain('`scope-drift`');
    expect(t).toContain('D-0001');
    const o = { ...task(), branch: 'queue/T1' };
    const pkg = RES.reviewPackageIndex({ o, branch: 'queue/T1', stat: '', base: 'main', migrFolder: null, catalog: r.lines });
    expect(pkg).toContain('## From the project catalog');
    const none = RES.reviewPackageIndex({ o, branch: 'queue/T1', stat: '', base: 'main', migrFolder: null });
    expect(none).not.toContain('From the project catalog');
  });

  it.each(['reviewer.md', 'reviewer-gap.md'])('%s checks the delivery against the excerpt (V9)', (f) => {
    const s = fs.readFileSync(path.resolve(__dirname, '..', '..', '..', '..', 'agents', f), 'utf8').replace(/\r?\n\s*/g, ' ');
    expect(s).toContain('From the project catalog');
    expect(s).toContain('invariant of an accepted');
    expect(s).toContain('`duplication`');
    expect(s).toContain('`scope-drift`');
  });
});
