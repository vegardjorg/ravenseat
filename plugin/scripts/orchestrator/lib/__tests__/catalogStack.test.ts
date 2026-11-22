// =============================================================
// catalogStack.test.ts: stack entries in the catalog (roadmap 0å KD-2,
// plans/katalog-design-stack-avhengigheter-2026-11-18.md § 4).
//
// Locks: (1) a stack entry says which tool does a job (`uses: {job, tool}`), the tools it chose against
// (`alternatives`) and words for the checks (`stack`), only on kind stack, and all three are in the fingerprint;
// (2) only an accepted stack entry declares stack words (declaredStacks), and withDeclaredStacks adds them to
// facts.stacks, so a recipe's `stack:pnpm` holds and the dep-audit card names `pnpm audit` from the entry;
// (3) `catalog check` warns when an accepted entry does not match the manifests (an alternative in one, the tool
// missing from the manifest its paths name) or a Prefer line for the same job says another tool; (4) V3 names the
// choice: an added alternative, or a package of the tool's purpose group, gets the D-id; accepted gives a CATALOG line
// first (warn only), proposed a NOTE as before with the D-id; the review package names it; the tool itself is no fact;
// (5) catalog.stackFacts is on by default, in STANDARD and in the settings registry.
// Pure except the temporary folder readCatalog reads.
// =============================================================
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const C = require('../catalog.js') as any;
const SN = require('../scopeNotes.js') as any;
const CK = require('../checksCatalog.js') as any;
const QC = require('../queueConfig.js') as any;
const REG = require('../settingsRegistry.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const temporary: string[] = [];
afterAll(() => {
  for (const m of temporary) fs.rmSync(m, { recursive: true, force: true });
});

function folder(files: Record<string, string>) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-catalog-stack-'));
  temporary.push(root);
  for (const [name, text] of Object.entries(files)) {
    const f = path.join(root, ...name.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  return root;
}

const stackEntry = (extra: string[] = [], { id = 'D-0004', status = 'proposed' } = {}) =>
  [
    '---',
    `id: ${id}`,
    'title: Dates with dayjs',
    `status: ${status}`,
    'kind: stack',
    'uses: {"job": "dates", "tool": "dayjs"}',
    'alternatives: ["moment", "luxon"]',
    'stack: ["pnpm"]',
    'paths: ["package.json"]',
    'invariant: Dates are handled with dayjs; moment and luxon are not added.',
    ...extra,
    '---',
    'Why: small, immutable, the API the team knows.',
    '',
  ].join('\n');

const accepted = (text: string, name = 'D-0004-dates.md') => {
  const d = C.parseDecision(name, text).decision;
  const ledger = C.recordAccept(C.emptyLedger(), { ...d, status: 'accepted' }, { by: 'owner' });
  return { text: text.replace('status: proposed', 'status: accepted'), ledger };
};

describe('the stack fields', () => {
  it('reads uses, alternatives and stack on a stack entry, also in the indented form', () => {
    const r = C.parseDecision('D-0004-dates.md', stackEntry());
    expect(r.errors).toEqual([]);
    expect(r.decision).toMatchObject({ kind: 'stack', uses: { job: 'dates', tool: 'dayjs' }, alternatives: ['moment', 'luxon'], stack: ['pnpm'] });
    const indented = stackEntry()
      .replace('uses: {"job": "dates", "tool": "dayjs"}', 'uses:\n  job: dates\n  tool: dayjs')
      .replace('alternatives: ["moment", "luxon"]', 'alternatives:\n  - moment\n  - luxon');
    expect(C.parseDecision('D-0004-dates.md', indented).decision).toMatchObject({ uses: { job: 'dates', tool: 'dayjs' }, alternatives: ['moment', 'luxon'] });
  });

  it('refuses them on another kind, a stack entry with neither uses nor stack, and a broken uses', () => {
    const plain = stackEntry().replace('kind: stack\n', '');
    expect(C.parseDecision('D-0004-x.md', plain).errors.join('\n')).toMatch(/uses, alternatives and stack are for kind stack/);
    const bare = stackEntry().replace(/^uses: .*\n/m, '').replace(/^stack: .*\n/m, '');
    expect(C.parseDecision('D-0004-x.md', bare).errors.join('\n')).toMatch(/a stack entry needs uses \{job, tool\} or a stack list/);
    const broken = stackEntry().replace('"tool": "dayjs"', '"tool": ""');
    expect(C.parseDecision('D-0004-x.md', broken).errors.join('\n')).toMatch(/uses must be \{"job": "\.\.\.", "tool": "\.\.\."\}/);
    expect(C.parseDecision('D-0004-x.md', stackEntry().replace('["pnpm"]', '["no spaces please"]')).errors.join('\n')).toMatch(/stack: each word/);
  });

  it('puts uses, alternatives and stack in the fingerprint', () => {
    const base = C.parseDecision('D-0004-dates.md', stackEntry()).decision;
    for (const [from, to] of [['"tool": "dayjs"', '"tool": "date-fns"'], ['"luxon"', '"temporal"'], ['["pnpm"]', '["npm"]']])
      expect(C.fingerprint(C.parseDecision('D-0004-dates.md', stackEntry().replace(from, to)).decision), from).not.toBe(C.fingerprint(base));
  });

  it('propose writes them back the same', () => {
    const r = C.proposalFile({ id: 'D-0004', kind: 'stack', title: 'Dates with dayjs', invariant: 'Dayjs only.', paths: ['package.json'], uses: { job: 'dates', tool: 'dayjs' }, alternatives: ['moment'], stack: ['pnpm'] });
    expect(r.errors).toEqual([]);
    expect(C.parseDecision(r.name, r.text).decision).toMatchObject({ uses: { job: 'dates', tool: 'dayjs' }, alternatives: ['moment'], stack: ['pnpm'] });
  });
});

describe('declared stack words', () => {
  it('come only from accepted stack entries, and reach facts.stacks without duplicates', () => {
    const { text, ledger } = accepted(stackEntry());
    const cat = C.readCatalog(folder({ 'decisions/D-0004-dates.md': text, 'decisions/D-0005-tests.md': stackEntry([], { id: 'D-0005' }).replace('"dayjs"', '"vitest"').replace('Dates with dayjs', 'Tests') }));
    expect(C.declaredStacks(cat, ledger)).toEqual([{ word: 'dayjs', id: 'D-0004' }, { word: 'pnpm', id: 'D-0004' }]);
    expect(C.declaredStacks(cat, C.emptyLedger())).toEqual([]);
    const facts = C.withDeclaredStacks({ stacks: ['Node/TypeScript'], other: 1 }, C.declaredStacks(cat, ledger));
    expect(facts).toMatchObject({ stacks: ['Node/TypeScript', 'dayjs', 'pnpm'], other: 1 });
    expect(facts.declaredStacks).toEqual([{ word: 'dayjs', id: 'D-0004' }, { word: 'pnpm', id: 'D-0004' }]);
    expect(C.withDeclaredStacks({ stacks: ['pnpm'] }, [{ word: 'pnpm', id: 'D-0004' }]).stacks).toEqual(['pnpm']);
    expect(C.stackChoices(cat, ledger).map((c: any) => [c.id, c.status, c.tool])).toEqual([['D-0004', 'accepted', 'dayjs'], ['D-0005', 'proposed', 'vitest']]);
  });

  it('let a recipe condition stack:pnpm hold and give the dep-audit card its command', () => {
    const catalog = CK.loadCatalog({ builtin: path.resolve(__dirname, '..', '..', 'checks-catalog'), own: path.join(os.tmpdir(), 'no-such-own-catalog') });
    const facts = C.withDeclaredStacks({ git: true, hasCommit: true, stacks: [], ci: [], kinds: [] }, [{ word: 'pnpm', id: 'D-0004' }]);
    expect(CK.holds('stack:pnpm', facts)).toBe(true);
    const card = CK.buildReport({ facts, catalog, now: 'x' }).suggestions.find((s: { key: string }) => s.key === 'dep-audit');
    expect(card.detail).toMatch(/`pnpm audit` \(D-0004 in the catalog says pnpm\)/);
    const cargo = CK.buildReport({ facts: C.withDeclaredStacks({ ...facts, stacks: [] }, [{ word: 'cargo', id: 'D-0006' }]), catalog, now: 'x' }).suggestions.find((s: { key: string }) => s.key === 'dep-audit');
    expect(cargo.detail).toMatch(/`cargo audit`/);
    // Nothing declared: no tool line, only the pointer to the audit that needs no install (roadmap 0å KD-4).
    const plain = CK.buildReport({ facts: { ...facts, stacks: ['Node'], declaredStacks: [] }, catalog, now: 'x' }).suggestions.find((s: { key: string }) => s.key === 'dep-audit');
    expect(plain.detail).toMatch(/^Without installing anything: `ravenseat catalog deps --audit --dry`/);
    expect(plain.detail).not.toMatch(/audit` \(D-/);
  });
});

describe('catalog check against the manifests and the Prefer lines', () => {
  const pkg = (deps: string[]) => JSON.stringify({ dependencies: Object.fromEntries(deps.map((d) => [d, '1'])) });
  const run = (deps: string[], prefer = '') => {
    const { text, ledger } = accepted(stackEntry());
    const cat = C.readCatalog(folder({ 'decisions/D-0004-dates.md': text, 'stack.md': `# Stack\n\n## Prefer\n\n${prefer}` }));
    return C.checkCatalog(cat, { files: ['package.json'], readFile: (f: string) => (f === 'package.json' ? pkg(deps) : null), ledger });
  };

  it('is quiet when the manifest matches', () => {
    expect(run(['dayjs']).warnings).toEqual([]);
  });

  it('warns about an alternative in the manifest and the tool missing from it', () => {
    const w = run(['moment']).warnings.join('\n');
    expect(w).toMatch(/D-0004: moment is in package\.json, but D-0004 chose dayjs for dates/);
    expect(w).toMatch(/D-0004: dayjs \(the tool for dates\) is in none of the manifests its paths name \(package\.json\)/);
  });

  it('warns about a Prefer line for the same job that says another tool', () => {
    expect(run(['dayjs'], '- Dates: use luxon\n').warnings.join('\n')).toMatch(/stack\.md: the Prefer line for dates says "use luxon", but D-0004 chose dayjs/);
    expect(run(['dayjs'], '- dates: use dayjs, not moment\n').warnings).toEqual([]);
  });
});

describe('V3 names the stack choice', () => {
  const manifest = (base: string[], tip: string[]) => [
    { path: 'package.json', base: JSON.stringify({ dependencies: Object.fromEntries(base.map((d) => [d, '1'])) }), tip: JSON.stringify({ dependencies: Object.fromEntries(tip.map((d) => [d, '1'])) }) },
  ];
  const choice = (status: string) => ({ id: 'D-0004', status, job: 'dates', tool: 'dayjs', alternatives: ['luxon'] });

  it('an accepted choice: a CATALOG line first, the D-id in the package, never a stop', () => {
    const facts = SN.dependencyFacts(manifest(['dayjs'], ['dayjs', 'moment']), SN.PURPOSES, [choice('accepted')]);
    expect(facts).toEqual([expect.objectContaining({ added: 'moment', decision: { id: 'D-0004', status: 'accepted', tool: 'dayjs', job: 'dates' } })]);
    const r = { setup: SN.setupOf({}), reuse: [], folders: [], dependencies: facts, drift: null, errors: [] };
    const lines = SN.receiveLines({ ...r, folders: [{ folder: 'x', files: 1 }] }, { id: 'T-1' });
    expect(lines[0]).toMatch(/^CATALOG T-1: moment added in package\.json, but D-0004 chose dayjs for dates \(accepted by the owner\)/);
    // The other facts follow as before; the accepted choice is not counted again among them.
    expect(lines.slice(1)).toEqual([expect.stringMatching(/^NOTE new folder \(T-1\)/)]);
    expect(SN.packageSection(r).join('\n')).toMatch(/`moment` in `package\.json`.*D-0004 chose `dayjs` for dates \(accepted\)/);
  });

  it('a proposed choice: the NOTE names it; an alternative outside the purpose groups still counts; the tool itself never', () => {
    const note = SN.noteLines({ setup: SN.setupOf({}), reuse: [], folders: [], dependencies: SN.dependencyFacts(manifest([], ['moment']), SN.PURPOSES, [choice('proposed')]), drift: null, errors: [] }, { id: 'T-2' });
    expect(note).toEqual([expect.stringMatching(/^NOTE dependency \(T-2\): moment in package\.json; D-0004 \(proposed\) chose dayjs for dates\./)]);
    expect(SN.dependencyFacts(manifest([], ['luxon']), [], [choice('accepted')])[0]).toMatchObject({ added: 'luxon', decision: { id: 'D-0004' } });
    expect(SN.dependencyFacts(manifest([], ['dayjs']), SN.PURPOSES, [choice('accepted')])).toEqual([]);
    // Without choices V3 is as it was.
    expect(SN.dependencyFacts(manifest(['dayjs'], ['dayjs', 'moment']))[0].decision).toBeUndefined();
  });
});

describe('the setting catalog.stackFacts', () => {
  it('is on by default, in STANDARD and in the settings registry', () => {
    expect(C.DEFAULTS.stackFacts).toBe(true);
    expect(C.setupOf({}).stackFacts).toBe(true);
    expect(QC.STANDARD.catalog.stackFacts).toBe(true);
    expect(REG.rowFor('catalog.stackFacts')).toMatchObject({ key: 'catalog.stackFacts', category: 'scope', type: 'onoff' });
  });
});
