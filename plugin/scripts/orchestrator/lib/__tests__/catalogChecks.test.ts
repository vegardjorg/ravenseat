// =============================================================
// catalogChecks.test.ts: the check rules of the design choices (lib/catalogChecks.js, bolk B6 of the scope drift plan,
// V4).
//
// Locks: (1) a rule is read from the check fields (forbid, hit, miss, mode; or examples as one JSON object) and every
// shape error is named: an unknown field, no forbid, a regex that does not compile or has the lookahead trap, a mode
// that is not warn or stop, and fewer than one hit and one miss example; (2) the examples are run through the same line
// test the deliveries get, so a broken rule (a hit that does not hit, a miss that hits) is an error; (3) a rule is
// tried only on added lines of files in the choice's paths, never on a test file, a comment line or a removed line;
// (4) the level: only a choice the owner accepted (with the record) warns, and stops only with mode stop AND
// catalog.checkStop on; a proposed or unconfirmed choice is never more than info, a superseded one is not checked;
// (5) the receive lines, the package section and the merge stop say the level, the place and the override, never the
// line's text; (6) the record on the task keeps the latest hits and every rule id that ever enforced on it, and the
// repeat count reads distinct tasks; (7) the gate proposal is a proposed gate task per rule with the GATE tail's place
// and sentence, under the shared cap; (8) the settings shape and defaults (checks on, checkStop off, gateAfter 3);
// (9) catalog check warns when an accepted rule already hits lines in the tree.
// Pure: no git, no file system.
// =============================================================
import { describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const CC = require('../catalogChecks.js') as any;
const C = require('../catalog.js') as any;
const QC = require('../queueConfig.js') as any;
const KBG = require('../knownBugGate.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const CHECK = {
  forbid: "from ['\"]@db/client['\"]",
  hit: ["import { db } from '@db/client'"],
  miss: ["import { save } from '@/services/factory'"],
  mode: 'warn',
};

/** A design choice as parseDecision gives it. */
const decision = (over: Record<string, unknown> = {}) => ({
  file: 'decisions/D-0007-service-layer.md',
  id: 'D-0007',
  title: 'Client code goes through the service layer',
  status: 'proposed',
  paths: ['app/**', 'components/**'],
  invariant: 'Files under app/ and components/ never import the database client directly.',
  check: CHECK,
  supersedes: null,
  plan: null,
  ...over,
});

/** The ledger with the owner's accept of exactly this version. */
const acceptedLedger = (d: any) => C.recordAccept(C.emptyLedger(), d, { by: 'owner', now: '2026-11-16T10:00:00.000Z' });

/** A unified diff that adds the lines to the file, from line 1. */
const diffOf = (file: string, ...added: string[]) =>
  [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, `@@ -0,0 +1,${added.length} @@`, ...added.map((l) => `+${l}`)].join('\n');

describe('a check rule', () => {
  it('is read from forbid, hit, miss and mode; mode defaults to warn', () => {
    const r = CC.ruleOf(CHECK);
    expect(r.errors).toEqual([]);
    expect(r.rule).toMatchObject({ forbid: CHECK.forbid, mode: 'warn', hit: CHECK.hit, miss: CHECK.miss });
    expect(CC.ruleOf({ ...CHECK, mode: undefined }).rule.mode).toBe('warn');
    // examples as one JSON object, as the plan writes it, is the same rule.
    const ex = CC.ruleOf({ forbid: CHECK.forbid, examples: { hit: CHECK.hit, miss: CHECK.miss }, mode: 'stop' });
    expect(ex.errors).toEqual([]);
    expect(ex.rule).toMatchObject({ mode: 'stop', hit: CHECK.hit, miss: CHECK.miss });
  });

  it('names each shape error', () => {
    const errs = (c: unknown) => CC.ruleOf(c).errors.join('\n');
    expect(errs('forbid it')).toMatch(/check must be fields/);
    expect(errs({ ...CHECK, forbid: undefined })).toMatch(/check\.forbid missing/);
    expect(errs({ ...CHECK, forbid: '(' })).toMatch(/check\.forbid is not a valid regular expression/);
    expect(errs({ ...CHECK, forbid: 'fetch\\(\\s*(?!x)' })).toMatch(/lookahead trap/);
    expect(errs({ ...CHECK, mode: 'block' })).toMatch(/check\.mode must be warn or stop/);
    expect(errs({ ...CHECK, words: ['x'] })).toMatch(/check: unknown field words/);
    expect(errs({ forbid: CHECK.forbid })).toMatch(/at least one hit and one miss example/);
    expect(errs({ ...CHECK, miss: [] })).toMatch(/at least one hit and one miss example/);
    expect(errs({ ...CHECK, hit: 'one line' })).toMatch(/check\.hit must be a list/);
  });

  it('runs the examples through the delivery line test, so a broken rule is an error', () => {
    expect(CC.ruleOf({ ...CHECK, hit: ["import { db } from '@db/other'"] }).errors.join('\n')).toMatch(
      /hit example does not hit: import \{ db \} from '@db\/other'/,
    );
    expect(CC.ruleOf({ ...CHECK, miss: ["import x from '@db/client'"] }).errors.join('\n')).toMatch(/miss example hits/);
    // A hit example written as a comment line can never hit a delivery either.
    expect(CC.ruleOf({ ...CHECK, hit: ["// import { db } from '@db/client'"] }).errors.join('\n')).toMatch(/hit example does not hit/);
  });

  it('parseDecision names a broken rule as an error of the file, and a good one passes', () => {
    const text = [
      '---',
      'id: D-0007',
      'title: Client code goes through the service layer',
      'status: proposed',
      'paths: ["app/**"]',
      'invariant: Files under app/ never import the database client directly.',
      'check:',
      '  forbid: "from [\'\\"]@db/client[\'\\"]"',
      '  hit: ["import { db } from \'@db/client\'"]',
      '  miss: ["import { save } from \'@/services/factory\'"]',
      '  mode: warn',
      '---',
      'Why.',
      '',
    ].join('\n');
    expect(C.parseDecision('D-0007-x.md', text).errors).toEqual([]);
    const broken = text.replace('  miss: ["import { save } from \'@/services/factory\'"]\n', '');
    expect(C.parseDecision('D-0007-x.md', broken).errors.join('\n')).toMatch(/decisions\/D-0007-x\.md: check needs at least one hit and one miss/);
  });
});

describe('which lines a rule is tried on', () => {
  it('added lines of files in the paths; not tests, comments, removed lines or other folders', () => {
    const d = decision({ status: 'accepted' });
    const ledger = acceptedLedger(d);
    const diff = [
      diffOf('app/page.ts', "import { db } from '@db/client'", 'const x = 1;'),
      diffOf('app/__tests__/page.test.ts', "import { db } from '@db/client'"),
      diffOf('app/other.ts', "// import { db } from '@db/client'"),
      diffOf('lib/db.ts', "import { db } from '@db/client'"),
      [
        'diff --git a/app/old.ts b/app/old.ts',
        '--- a/app/old.ts',
        '+++ b/app/old.ts',
        '@@ -1,2 +1,2 @@',
        "-import { db } from '@db/client'",
        ' const kept = 1;',
        '+const fresh = 2;',
      ].join('\n'),
    ].join('\n');
    const r = CC.assess({ decisions: [d], ledger, diff });
    expect(r.rules).toHaveLength(1);
    expect(r.rules[0]).toMatchObject({ id: 'D-0007', level: 'warn', count: 1, hits: [{ file: 'app/page.ts', line: 1 }] });
  });

  it('no hit, no rule in the result; a choice without check is skipped', () => {
    const d = decision({ status: 'accepted' });
    expect(CC.assess({ decisions: [d], ledger: acceptedLedger(d), diff: diffOf('app/page.ts', 'const x = 1;') }).rules).toEqual([]);
    expect(CC.assess({ decisions: [decision({ check: null })], ledger: C.emptyLedger(), diff: diffOf('app/a.ts', "from '@db/client'") }).rules).toEqual([]);
  });

  it('a rule with a shape error never runs', () => {
    const d = decision({ status: 'accepted', check: { forbid: '@db/client' } });
    expect(CC.assess({ decisions: [d], ledger: acceptedLedger(d), diff: diffOf('app/a.ts', "from '@db/client'") }).rules).toEqual([]);
  });
});

describe('the level: only an accepted choice enforces, and stop needs catalog.checkStop', () => {
  const diff = diffOf('app/page.ts', "import { db } from '@db/client'");
  const level = (d: any, ledger: any, setup: any = {}) => CC.assess({ decisions: [d], ledger, diff, setup }).rules[0]?.level ?? null;

  it('accepted with the record: warn; mode stop is warn until checkStop is on, then stop', () => {
    const warn = decision({ status: 'accepted' });
    expect(level(warn, acceptedLedger(warn))).toBe('warn');
    const stop = decision({ status: 'accepted', check: { ...CHECK, mode: 'stop' } });
    expect(level(stop, acceptedLedger(stop))).toBe('warn');
    expect(CC.assess({ decisions: [stop], ledger: acceptedLedger(stop), diff }).rules[0].mode).toBe('stop');
    expect(level(stop, acceptedLedger(stop), { checkStop: true })).toBe('stop');
  });

  it('proposed, unconfirmed (accepted without the record) and a changed rule after the accept are info only', () => {
    const stop = decision({ status: 'proposed', check: { ...CHECK, mode: 'stop' } });
    expect(level(stop, C.emptyLedger(), { checkStop: true })).toBe('info');
    const handSet = decision({ status: 'accepted', check: { ...CHECK, mode: 'stop' } });
    expect(level(handSet, C.emptyLedger(), { checkStop: true })).toBe('info');
    // Accepted as warn, then the file was switched to stop: the fingerprint differs, so it is unconfirmed.
    const asWarn = decision({ status: 'accepted' });
    expect(level(handSet, acceptedLedger(asWarn), { checkStop: true })).toBe('info');
  });

  it('a superseded choice is not checked, and catalog.checks off checks nothing', () => {
    expect(level(decision({ status: 'superseded' }), C.emptyLedger())).toBeNull();
    const d = decision({ status: 'accepted' });
    expect(level(d, acceptedLedger(d), { checks: false })).toBeNull();
  });
});

describe('what receive and merge say', () => {
  const diff = diffOf('app/page.ts', "import { db } from '@db/client'", "import { other } from '@db/client'");

  it('warn: one CATALOG line with the places, the invariant and the way out, never the line text', () => {
    const d = decision({ status: 'accepted' });
    const r = CC.assess({ decisions: [d], ledger: acceptedLedger(d), diff });
    const lines = CC.receiveLines(r, { id: 'A', cli: 'ravenseat' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^CATALOG A: 2 added line\(s\) break D-0007/);
    expect(lines[0]).toContain('app/page.ts:1, app/page.ts:2');
    expect(lines[0]).toContain('never import the database client directly');
    expect(lines[0]).toContain('ravenseat resume A --reason fix');
    expect(lines[0]).not.toContain('@db/client');
    expect(CC.mergeStop(r, { id: 'A', cli: 'ravenseat' })).toBeNull();
  });

  it('stop mode with checkStop off says it is a warning; on, the merge stops with the override named', () => {
    const d = decision({ status: 'accepted', check: { ...CHECK, mode: 'stop' } });
    const off = CC.assess({ decisions: [d], ledger: acceptedLedger(d), diff });
    expect(CC.receiveLines(off, { id: 'A', cli: 'ravenseat' })[0]).toMatch(/mode is stop, but catalog\.checkStop is off/);
    const on = CC.assess({ decisions: [d], ledger: acceptedLedger(d), diff, setup: { checkStop: true } });
    expect(CC.receiveLines(on, { id: 'A', cli: 'ravenseat' })[0]).toMatch(/The merge stops on it/);
    const stop = CC.mergeStop(on, { id: 'A', cli: 'ravenseat' });
    expect(stop).toMatch(/^STOP: A is not merged/);
    expect(stop).toContain('D-0007');
    expect(stop).toContain('ravenseat merge A --allow-catalog');
    expect(stop).not.toContain('@db/client');
  });

  it('info: a NOTE that binds nothing', () => {
    const r = CC.assess({ decisions: [decision()], ledger: C.emptyLedger(), diff });
    const lines = CC.receiveLines(r, { id: 'A', cli: 'ravenseat' });
    expect(lines[0]).toMatch(/^NOTE catalog A: 2 added line\(s\) match the check of D-0007, a proposed choice/);
    expect(lines[0]).toMatch(/binds nothing/);
  });

  it('M4: two or more proposed choices are one NOTE line at receive; the CATALOG lines stay whole and come first', () => {
    const held = decision({ id: 'D-0009', file: 'decisions/D-0009-x.md', status: 'accepted' });
    const decisions = [decision(), decision({ id: 'D-0008', file: 'decisions/D-0008-x.md' }), held];
    const r = CC.assess({ decisions, ledger: acceptedLedger(held), diff });
    const lines = CC.receiveLines(r, { id: 'A', cli: 'ravenseat' });
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^CATALOG A: 2 added line\(s\) break D-0009/);
    expect(lines[0]).toContain('ravenseat resume A --reason fix');
    expect(lines[1]).toBe(
      'NOTE catalog A: 2 proposed choices match added lines (D-0007, D-0008; 4 lines). They bind nothing; the reviewer weighs them. ' +
        'Each is in 00-package.md (Catalog rules), or ravenseat receive A --all prints them.',
    );
    // --all: the detail form, one NOTE per proposed choice, still after the CATALOG line.
    const all = CC.receiveLines(r, { id: 'A', cli: 'ravenseat', all: true });
    expect(all).toHaveLength(3);
    expect(all[0]).toMatch(/^CATALOG A: /);
    expect(all[1]).toMatch(/^NOTE catalog A: 2 added line\(s\) match the check of D-0007, a proposed choice: app\/page\.ts:1, app\/page\.ts:2\./);
    expect(all[2]).toMatch(/^NOTE catalog A: 2 added line\(s\) match the check of D-0008, a proposed choice/);
    // The package still names each rule.
    const section = CC.packageSection(r).join('\n');
    for (const x of ['D-0007 (proposed, binds nothing)', 'D-0008 (proposed, binds nothing)', 'D-0009 (holds, warn)']) expect(section).toContain(x);
  });

  it('the package section names each rule with its level; nothing hit, no section', () => {
    const d = decision({ status: 'accepted' });
    const s = CC.packageSection(CC.assess({ decisions: [d, decision({ id: 'D-0008', file: 'decisions/D-0008-x.md' })], ledger: acceptedLedger(d), diff }));
    const text = s.join('\n');
    expect(text).toContain('## Catalog rules');
    expect(text).toMatch(/D-0007 \(holds, warn\): `app\/page\.ts:1`/);
    expect(text).toMatch(/D-0008 \(proposed, binds nothing\)/);
    expect(text).toMatch(/scope-drift/);
    expect(CC.packageSection(CC.assess({ decisions: [d], ledger: acceptedLedger(d), diff: '' }))).toBeNull();
  });
});

describe('the record on the task and the repeat count', () => {
  const d = decision({ status: 'accepted' });
  const ledger = acceptedLedger(d);
  const hit = CC.assess({ decisions: [d], ledger, diff: diffOf('app/page.ts', "import { db } from '@db/client'") });
  const none = CC.assess({ decisions: [d], ledger, diff: '' });

  it('keeps the latest hits and every enforcing rule id; nothing at all gives no field', () => {
    expect(CC.record(none, undefined, '2026-11-16T10:00:00.000Z')).toBeNull();
    const first = CC.record(hit, undefined, '2026-11-16T10:00:00.000Z');
    expect(first).toEqual({ at: '2026-11-16T10:00:00.000Z', hits: [{ id: 'D-0007', level: 'warn', count: 1 }], ever: ['D-0007'] });
    // A fix round that took the line out: no hits now, but the task did break the rule once.
    expect(CC.record(none, first, '2026-11-17T10:00:00.000Z')).toEqual({ at: '2026-11-17T10:00:00.000Z', hits: [], ever: ['D-0007'] });
    // An info hit (a proposed choice) is never counted.
    const info = CC.assess({ decisions: [decision()], ledger: C.emptyLedger(), diff: diffOf('app/a.ts', "from '@db/client'") });
    expect(CC.record(info, undefined, 'x')).toEqual({ at: 'x', hits: [{ id: 'D-0007', level: 'info', count: 1 }], ever: [] });
  });

  it('counts distinct tasks that ever broke the rule', () => {
    const t = (id: string, ever: string[]) => ({ id, catalog_checks: { at: 'x', hits: [], ever } });
    expect(CC.repeatTasks('D-0007', [t('A', ['D-0007']), t('B', ['D-0008']), t('C', ['D-0007']), { id: 'D' }, t('A', ['D-0007'])])).toEqual(['A', 'C']);
  });
});

describe('the gate proposal for a rule that keeps being broken', () => {
  const d = decision({ status: 'accepted' });
  const r = CC.assess({ decisions: [d], ledger: acceptedLedger(d), diff: diffOf('app/page.ts', "import { db } from '@db/client'") });

  it('due only for an enforcing rule in at least gateAfter separate tasks', () => {
    const tasks = ['A', 'B', 'C'].map((id) => ({ id, catalog_checks: { at: 'x', hits: [], ever: ['D-0007'] } }));
    expect(CC.dueRules(r, tasks.slice(0, 2), { gateAfter: 3 })).toEqual([]);
    const due = CC.dueRules(r, tasks, { gateAfter: 3 });
    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ rule: { id: 'D-0007' }, tasks: ['A', 'B', 'C'] });
    const info = CC.assess({ decisions: [decision()], ledger: C.emptyLedger(), diff: diffOf('app/a.ts', "from '@db/client'") });
    expect(CC.dueRules(info, tasks, { gateAfter: 3 })).toEqual([]);
  });

  it('is a gate task per rule with the place and the sentence of the GATE tail, for the project lint', () => {
    const tasks = ['A', 'B', 'C'].map((id) => ({ id, catalog_checks: { at: 'x', hits: [], ever: ['D-0007'] } }));
    const [due] = CC.dueRules(r, tasks, { gateAfter: 3 });
    const task = CC.proposalTask(due, { id: 'GATE-4', from: 'C' });
    expect(task).toMatchObject({ id: 'GATE-4', class: 'K', labels: ['gate', 'catalog-rule'], source: 'catalog-rule D-0007' });
    expect(task.title).toBe('Gate: Lint rule for D-0007: Client code goes through the service layer');
    expect(task.mission).toMatch(/Seen in: task C: app\/page\.ts:1: /);
    expect(task.mission).toContain('scope-drift');
    expect(task.mission).toContain('decisions/D-0007-service-layer.md');
    expect(task.mission).toMatch(/project's own lint/);
    // The mission names a file and a line, so approving it is not work on a guess.
    expect(KBG.gateWithoutPlace(task)).toBe(false);
    // The same rule again is the same gate class (decide extends it), another rule is another.
    expect(KBG.classKey(task.title)).toBe(KBG.classKey(CC.gateTitle(due.rule)));
  });
});

describe('settings and catalog check', () => {
  it('checks on, checkStop off, gateAfter 3, and checked for shape', () => {
    expect(QC.STANDARD.catalog).toMatchObject({ checks: true, checkStop: false, gateAfter: 3 });
    expect(C.setupOf({})).toMatchObject({ checks: true, checkStop: false, gateAfter: 3 });
    expect(C.setupProblems({ checkStop: 'yes' })).toEqual(['catalog.checkStop must be true or false']);
    expect(C.setupProblems({ gateAfter: 1 })).toEqual(['catalog.gateAfter must be a whole number from 2 to 20']);
    expect(C.setupOf({ catalog: { gateAfter: 1 } }).gateAfter).toBe(3);
    expect(C.setupOf({ catalog: { gateAfter: 5 } }).gateAfter).toBe(5);
  });

  it('catalog check warns when a rule already hits lines in the tree, not in tests or other folders', () => {
    const text = [
      '---',
      'id: D-0007',
      'title: Client code goes through the service layer',
      'status: proposed',
      'paths: ["app/**"]',
      'invariant: Files under app/ never import the database client directly.',
      'check:',
      '  forbid: "@db/client"',
      '  hit: ["import { db } from \'@db/client\'"]',
      '  miss: ["import { save } from \'@/services/factory\'"]',
      '---',
      '',
    ].join('\n');
    const cat = { exists: true, errors: [], warnings: [], decisions: [{ name: 'D-0007-x.md', ...C.parseDecision('D-0007-x.md', text) }] };
    const files: Record<string, string> = {
      'app/a.ts': "const x = 1;\nimport { db } from '@db/client'\n",
      'app/__tests__/a.test.ts': "import { db } from '@db/client'\n",
      'lib/b.ts': "import { db } from '@db/client'\n",
    };
    const r = C.checkCatalog(cat, { files: Object.keys(files), readFile: (f: string) => files[f] ?? null, ledger: C.emptyLedger() });
    expect(r.errors).toEqual([]);
    expect(r.warnings.join('\n')).toMatch(/D-0007: its check already hits 1 line\(s\) in the tree \(first app\/a\.ts:2\)/);
  });
});
