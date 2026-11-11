// =============================================================
// redOnBase.test.ts: the pure part of "red on base" (lib/redOnBase.js): which files are tests and which are the change,
// the command line, the verdict and the lines receive prints.
//
// Why: a track's "red first" was only what the track said in its report. Red on base checks it: the track's new or
// changed test files must fail on the merge base (with the track's code change taken away) and pass on the delivered tip,
// the FAIL_TO_PASS idea from SWE-bench. A test that passes both ways shows nothing about the change.
// =============================================================
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const RB = require('../redOnBase.js');

describe('setup', () => {
  it('off by default; a string is the command; an object sets the budget and the file cap', () => {
    expect(RB.setup({})).toBeNull();
    expect(RB.setup({ redOnBase: null })).toBeNull();
    expect(RB.setup({ redOnBase: 'node --test {files}' })).toEqual({ command: 'node --test {files}', timeoutSec: 300, maxFiles: 10 });
    expect(RB.setup({ redOnBase: { command: 'npx vitest run {files}', timeoutSec: 60, maxFiles: 3 } })).toEqual({
      command: 'npx vitest run {files}',
      timeoutSec: 60,
      maxFiles: 3,
    });
  });

  it('setupProblems names a wrong value (doctor)', () => {
    expect(RB.setupProblems(undefined)).toEqual([]);
    expect(RB.setupProblems('npm test -- {files}')).toEqual([]);
    expect(RB.setupProblems('')).toHaveLength(1);
    expect(RB.setupProblems(5)).toHaveLength(1);
    expect(RB.setupProblems({ command: 'x', maxFiles: 0 })).toHaveLength(1);
    expect(RB.setupProblems({ timeoutSec: 10 })).toHaveLength(1);
  });

  it('doctor names it, and the default config has the key (null), so it is never "unknown"', async () => {
    const D = await import('../../cli/doctor.mjs');
    expect(D.baselineProblems({ gates: { redOnBase: 5 } }).join('\n')).toMatch(/gates\.redOnBase must be/);
    expect(D.baselineProblems({ gates: { redOnBase: 'npx vitest run {files}' } })).toEqual([]);
    const C = require('../queueConfig.js');
    expect(C.DEFAULTS?.gates ?? C.defaults?.gates ?? C.config({ fresh: true }).gates).toHaveProperty('redOnBase');
  });
});

describe('split', () => {
  it('new and changed test files are run; the rest is the change; a deleted test is not run', () => {
    const ns = ['M\tsrc/sum.ts', 'A\tsrc/__tests__/sum.test.ts', 'M\tsrc/old.test.ts', 'D\tsrc/gone.ts', 'D\tsrc/x.test.ts', 'A\tdocs/a.md'].join('\n');
    const s = RB.split(ns);
    expect(s.tests).toEqual(['src/__tests__/sum.test.ts', 'src/old.test.ts']);
    expect(s.code).toEqual([
      { path: 'src/sum.ts', status: 'M' },
      { path: 'src/gone.ts', status: 'D' },
      { path: 'docs/a.md', status: 'A' },
    ]);
    expect(s.unsafe).toEqual([]);
  });

  it('extra test globs count, and a path the shell could read as code is never run', () => {
    const s = RB.split('A\tchecks/sum.check.js\nA\tsrc/__tests__/a$b.test.ts', ['checks/**']);
    expect(s.tests).toEqual(['checks/sum.check.js']);
    expect(s.unsafe).toEqual(['src/__tests__/a$b.test.ts']);
  });
});

describe('commandFor', () => {
  it('{files} becomes the quoted list; without it the list is added at the end', () => {
    expect(RB.commandFor('node --test {files}', ['a b.test.mjs', 'c.test.mjs'])).toBe('node --test "a b.test.mjs" "c.test.mjs"');
    expect(RB.commandFor('npm test --', ['c.test.mjs'])).toBe('npm test -- "c.test.mjs"');
  });
});

describe('verdict', () => {
  const tests = ['t1.test.mjs', 't2.test.mjs'];
  const code = [{ path: 'src/sum.mjs', status: 'M' }];
  it('proven: at least one test fails on the base and all pass on the tip', () => {
    expect(RB.verdict({ tests, code, tip: { ok: true }, base: [{ path: 't1.test.mjs', ok: false }, { path: 't2.test.mjs', ok: true }] })).toBe('proven');
  });
  it('unproven: every test passes on the base too', () => {
    expect(RB.verdict({ tests, code, tip: { ok: true }, base: [{ path: 't1.test.mjs', ok: true }, { path: 't2.test.mjs', ok: true }] })).toBe('unproven');
  });
  it('tip-red, no-tests and tests-only', () => {
    expect(RB.verdict({ tests, code, tip: { ok: false }, base: [] })).toBe('tip-red');
    expect(RB.verdict({ tests: [], code, tip: null, base: [] })).toBe('no-tests');
    expect(RB.verdict({ tests, code: [], tip: { ok: true }, base: [] })).toBe('tests-only');
  });
});

describe('the lines', () => {
  it('unproven is a warning that names the files; proven is one quiet line', () => {
    const un = RB.summaryLine('A', { verdict: 'unproven', files: [{ path: 't1.test.mjs', base: 'green' }] });
    expect(un).toMatch(/^RED ON BASE A: /);
    expect(un).toContain('t1.test.mjs');
    expect(un).toMatch(/pass without/);
    const ok = RB.summaryLine('A', { verdict: 'proven', files: [{ path: 't1.test.mjs', base: 'red' }, { path: 't2.test.mjs', base: 'green' }] });
    expect(ok).toMatch(/^Red on base A: 1 of 2/);
  });

  it('no line when the check is off; the package section lists each file with its base result', () => {
    expect(RB.summaryLine('A', null)).toBeNull();
    const sec = RB.packageSection({ verdict: 'proven', command: 'node --test {files}', files: [{ path: 't1.test.mjs', base: 'red' }], skipped: [] }).join('\n');
    expect(sec).toMatch(/## Red on base/);
    expect(sec).toMatch(/t1\.test\.mjs: red on the base/);
  });
});
