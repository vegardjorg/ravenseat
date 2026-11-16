// =============================================================
// failureRules.test.ts: the class a finding log row gets from a rule (lib/failureRules.js, step 5 of the finding format
// contract), and the wiring through lib/findingLog.js append that every source writes through.
//
// Locks: (1) the core register compiles whole and every rule gives a core class other than `other`; (2) each tier gives
// its class: the source's event (secret, flaky, unproven), an error code in the excerpt (TS codes, the Python markers),
// the review signal that lifted the reviewer in, the checks kind of the red command; (3) the tiers are tried in order,
// so a TS2532 under tsc is null-undefined; (4) two classes in one tier keep the first with confidence low; (5) code and
// kind read only command rows and signal only review rows; (6) the agent's own class wins, and its `other` lets a rule
// help; (7) a project adds rules, turns core ones off, and its own classes count; a broken or invalid file gives the core
// rules and a warning, never a throw; (8) append writes the rule's class with class_source rule and never stores the
// hints; a failing classifier leaves the row as it came.
// =============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const FR = require('../failureRules.js') as any;
const FC = require('../failureClasses.js') as any;
const FL = require('../findingLog.js') as any;
const CORE = require('../../failure-rules.json') as { rules: { id: string; class: string }[] };
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

/** A temp project root with the given files under docs/queue (a string is written as is). */
function project(files: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ravenseat-failure-rules-'));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.join(root, 'docs', 'queue'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'queue', name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return root;
}

const core = () => FR.rulesFor(null).rules;
const cls = (input: object, rules = core()) => FR.classify(input, rules);
const gate = (excerpt: string, command = 'npm test') => ({ caught_by: 'gate', severity: 'M', class: 'other', excerpt, rule_hints: { command } });

describe('the core register', () => {
  it('compiles every rule, with a core class that is not other', () => {
    const rules = core();
    expect(rules).toHaveLength(CORE.rules.length);
    const ids = new Set(FC.coreClasses().map((c: { id: string }) => c.id));
    for (const r of CORE.rules) {
      expect(ids.has(r.class)).toBe(true);
      expect(r.class).not.toBe('other');
    }
    expect(FR.rulesFor(null).warnings).toEqual([]);
  });
});

describe('classify', () => {
  it('the event the source saw: a secret, a flaky command, an unproven test', () => {
    expect(cls({ caught_by: 'secret-scan', class: 'other', excerpt: 'x', rule_hints: { event: 'secret' } })).toMatchObject({ class: 'secret-leak', confidence: 'high', rule: 'event-secret' });
    expect(cls({ caught_by: 'gate', class: 'other', excerpt: 'x', rule_hints: { event: 'flaky', command: 'npm test' } })).toMatchObject({ class: 'test-weakening' });
    expect(cls({ caught_by: 'red-on-base', class: 'other', excerpt: 'x', rule_hints: { event: 'unproven' } })).toMatchObject({ class: 'test-weakening' });
  });

  it('an error code in the excerpt of a red command', () => {
    expect(cls(gate('src/a.ts(<line>,<col>): error TS2532: Object is possibly undefined.', 'npx tsc --noEmit'))).toMatchObject({ class: 'null-undefined', rule: 'code-ts-null' });
    // The catch-all TS rule leaves out the codes a rule above names, so a specific code is not made unsure by it.
    expect(cls(gate("src/a.ts: error TS2307: Cannot find module './b'"))).toMatchObject({ class: 'dependency-build', confidence: 'high' });
    expect(cls(gate('src/a.ts: error TS2345: Argument of type string'))).toMatchObject({ class: 'contract-drift', rule: 'code-ts' });
    expect(cls(gate("TypeError: Cannot read properties of undefined (reading 'id')"))).toMatchObject({ class: 'null-undefined' });
    expect(cls(gate("E ModuleNotFoundError: No module named 'yaml'", 'pytest -q'))).toMatchObject({ class: 'dependency-build' });
    expect(cls(gate("TypeError: can't compare offset-naive and offset-aware datetimes", 'pytest'))).toMatchObject({ class: 'time-zone' });
    expect(cls(gate('ERROR: relation "orders" does not exist'))).toMatchObject({ class: 'migration-schema' });
  });

  it('the kind of the red command when the excerpt says nothing', () => {
    expect(cls(gate('Found 3 errors.', 'npx tsc --noEmit'))).toMatchObject({ class: 'contract-drift', rule: 'kind-types' });
    expect(cls(gate('exit 1', 'npm run build'))).toMatchObject({ class: 'dependency-build' });
    expect(cls(gate('leaks found: 1', 'gitleaks detect'))).toMatchObject({ class: 'secret-leak' });
    // A plain red test says nothing about the class.
    expect(cls(gate('expected 1 to be 2', 'npm test'))).toBeNull();
  });

  it('the review signal that lifted the reviewer in', () => {
    const review = (signals: string[]) => ({ caught_by: 'review:reviewer-security', class: '-', class_source: 'agent', excerpt: 'x', rule_hints: { signals } });
    expect(cls(review(['raw-sql']))).toMatchObject({ class: 'injection', confidence: 'high' });
    expect(cls(review(['access-rule']))).toMatchObject({ class: 'access-control' });
    // Two signals with different classes: the first, but not sure.
    expect(cls(review(['raw-sql', 'access-rule']))).toMatchObject({ class: 'injection', confidence: 'low' });
    expect(cls(review([]))).toBeNull();
  });

  it('two kinds with different classes keep the first with confidence low', () => {
    expect(cls(gate('exit 1', 'npm run build && npx tsc --noEmit'))).toMatchObject({ confidence: 'low' });
  });

  it('code and kind read only command rows, signal only review rows', () => {
    expect(cls({ caught_by: 'review:reviewer', class: '-', class_source: 'agent', excerpt: 'error TS2532 here', rule_hints: { command: 'tsc' } })).toBeNull();
    expect(cls({ caught_by: 'gate-line', class: 'other', class_source: 'agent', excerpt: 'error TS2532' })).toBeNull();
    expect(cls({ caught_by: 'gate', class: 'other', excerpt: 'x', rule_hints: { signals: ['raw-sql'] } })).toBeNull();
  });

  it("the agent's own class wins; its other or '-' lets a rule help", () => {
    expect(cls({ caught_by: 'review:reviewer-security', class: 'data-loss', class_source: 'agent', excerpt: 'x', rule_hints: { signals: ['raw-sql'] } })).toBeNull();
    expect(cls({ caught_by: 'review:reviewer-security', class: 'other', class_source: 'agent', excerpt: 'x', rule_hints: { signals: ['raw-sql'] } })).toMatchObject({ class: 'injection' });
  });

  it('never throws on junk', () => {
    expect(cls(null as unknown as object)).toBeNull();
    expect(cls({ caught_by: 'gate', excerpt: 'x', rule_hints: 'junk' })).toBeNull();
    expect(FR.classify({ caught_by: 'gate', excerpt: 'x' }, 'not a list')).toBeNull();
  });
});

describe('the project file', () => {
  it('adds a rule (tried before the core), turns a core one off, and may give its own class', () => {
    const root = project({
      'failure-classes.json': { classes: [{ id: 'audit-trail', title: 'missing audit row' }] },
      'failure-rules.json': {
        rules: [
          { id: 'audit-missing', code: 'audit row missing', class: 'audit-trail' },
          { id: 'kind-build', off: true },
        ],
      },
    });
    const { rules, warnings } = FR.rulesFor(root);
    expect(warnings).toEqual([]);
    expect(rules[0].id).toBe('audit-missing');
    expect(cls(gate('Error: audit row missing for save'), rules)).toMatchObject({ class: 'audit-trail' });
    expect(cls(gate('exit 1', 'npm run build'), rules)).toBeNull();
  });

  it('a core class the project turned off gives no rule', () => {
    const root = project({ 'failure-classes.json': { classes: [{ id: 'contract-drift', off: true }] } });
    expect(cls(gate('Found 3 errors.', 'npx tsc --noEmit'), FR.rulesFor(root).rules)).toBeNull();
  });

  it('a broken file is the core rules and a warning, never a throw', () => {
    const broken = FR.rulesFor(project({ 'failure-rules.json': '{ not json' }));
    expect(broken.rules).toHaveLength(CORE.rules.length);
    expect(broken.warnings[0]).toMatch(/not valid JSON/);
    expect(FR.rulesFor(project({ 'failure-rules.json': { rules: 'x' } })).warnings[0]).toMatch(/expected/);
  });

  it('an invalid rule is skipped with a warning naming it', () => {
    const root = project({
      'failure-rules.json': {
        rules: [
          { id: 'code-ts', off: false, code: 'x', class: 'injection' },
          { id: 'Bad Id', code: 'x', class: 'injection' },
          { id: 'two-tiers', code: 'x', kind: 'types', class: 'injection' },
          { id: 'bad-class', code: 'x', class: 'made-up' },
          { id: 'bad-pattern', code: '(', class: 'injection' },
          { id: 'bad-kind', kind: 'nope', class: 'injection' },
          { id: 'to-other', code: 'x', class: 'other' },
          { id: 'not-there', off: true },
          { code: 'x', class: 'injection' },
        ],
      },
    });
    const { rules, warnings } = FR.rulesFor(root);
    expect(rules).toHaveLength(CORE.rules.length);
    expect(warnings).toHaveLength(9);
    expect(warnings.join('\n')).toMatch(/"code-ts" is a core rule/);
    expect(warnings.join('\n')).toMatch(/"bad-pattern" "code" is not a valid regular expression/);
    expect(FR.projectWarnings(root)).toHaveLength(9);
    expect(FR.projectWarnings(project())).toEqual([]);
  });
});

describe('append classifies the row', () => {
  const NOW = Date.parse('2026-11-16T10:00:00Z');

  it('the rule class with class_source rule, the hints never stored', () => {
    const root = project();
    const row = FL.append(root, gate('Found 3 errors.', 'npx tsc --noEmit'), { now: NOW });
    expect(row).toMatchObject({ class: 'contract-drift', class_source: 'rule', confidence: 'high', counts: true });
    expect(row).not.toHaveProperty('rule_hints');
    expect(JSON.stringify(FL.read(root).rows[0])).not.toContain('rule_hints');
  });

  it("a project's own class from its rule is kept, not cut to other", () => {
    const root = project({
      'failure-classes.json': { classes: [{ id: 'audit-trail', title: 'missing audit row' }] },
      'failure-rules.json': { rules: [{ id: 'audit-missing', code: 'audit row missing', class: 'audit-trail' }] },
    });
    expect(FL.append(root, gate('Error: audit row missing'), { now: NOW }).class).toBe('audit-trail');
  });

  it('no rule: the row as it came; a broken rules file is still a row', () => {
    const root = project({ 'failure-rules.json': '{ broken' });
    expect(FL.append(root, gate('expected 1 to be 2'), { now: NOW })).toMatchObject({ class: 'other', class_source: 'signal' });
    expect(FL.append(root, gate('Found 3 errors.', 'tsc'), { now: NOW }).class).toBe('contract-drift');
  });

  it('rules: false leaves the class alone', () => {
    const root = project();
    expect(FL.append(root, gate('Found 3 errors.', 'tsc'), { now: NOW, rules: false }).class).toBe('other');
  });
});
