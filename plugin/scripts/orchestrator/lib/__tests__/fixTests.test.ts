// =============================================================
// fixTests.test.ts: "a fix needs a red test first" (lib/fixTests.js, step 6 of the finding format contract).
//
// Locks: (1) which tasks are fixes, read from the fields the queue already has (fixes, qa_original, added_by of the base
// gate and the CI watch, a plan id from `ravenseat finding`, a GATE line in the report); (2) only no-tests and unproven
// on a fix are "fixed without test"; (3) the default is one warning line at receive and no stop; (4) the strict mode is
// off unless the setting is exactly true, and then only a proven red test lets a fix merge, with --allow-no-test named;
// (5) the command for gates.redOnBase is suggested from the project's own files, never guessed for an unknown stack.
// =============================================================
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const FT = require('../fixTests.js');

describe('fixKind: which tasks are fixes', () => {
  it('reads the fields the queue already has, the most specific first', () => {
    expect(FT.fixKind({ id: 'A-QA1', qa_original: 'A', fixes: ['A'] })).toBe('qa');
    expect(FT.fixKind({ id: 'BASE-1', added_by: 'base gate' })).toBe('base-fix');
    expect(FT.fixKind({ id: 'CI-abc1234', added_by: 'ci watch' })).toBe('base-fix');
    expect(FT.fixKind({ id: 'F', fixes: ['A'] })).toBe('fixes');
    expect(FT.fixKind({ id: 'F', plan: 'PL-FINDING-3' })).toBe('finding');
    expect(FT.fixKind({ id: 'G' }, { gateLine: true })).toBe('gate-line');
  });

  it('a plain task, a task that fixes only itself and a plan that is no finding are no fixes', () => {
    expect(FT.fixKind({ id: 'A' })).toBeNull();
    expect(FT.fixKind({ id: 'A', fixes: ['A'] })).toBeNull();
    expect(FT.fixKind({ id: 'A', fixes: [] })).toBeNull();
    expect(FT.fixKind({ id: 'A', qa_original: 'A' })).toBeNull();
    expect(FT.fixKind({ id: 'A', plan: 'PL-KO-7' })).toBeNull();
    expect(FT.fixKind({ id: 'A', added_by: 'owner' })).toBeNull();
    expect(FT.fixKind(null)).toBeNull();
  });
});

describe('the verdict on a fix', () => {
  it('only no-tests and unproven are fixed without test', () => {
    expect(FT.untested('no-tests')).toBe(true);
    expect(FT.untested('unproven')).toBe(true);
    for (const v of ['proven', 'tip-red', 'tests-only', 'error', null, undefined]) expect(FT.untested(v)).toBe(false);
  });

  it('testAdded keeps the verdict and the test paths, never the output', () => {
    const rec = { verdict: 'unproven', files: [{ path: 'src/a.test.ts', base: 'green' }], skipped: ['x'], command: 'npx vitest run {files}' };
    expect(FT.testAdded(rec)).toEqual({ verdict: 'unproven', files: ['src/a.test.ts'] });
    expect(FT.testAdded({ verdict: 'no-tests', files: [] })).toEqual({ verdict: 'no-tests', files: [] });
    expect(FT.testAdded(null)).toBeNull();
  });
});

describe('the receive line (the default: a warning)', () => {
  const unproven = { verdict: 'unproven', files: [{ path: 'src/a.test.ts', base: 'green' }] };

  it('one line for a fix without a proven red test, none for a proven one or a plain task', () => {
    const line = FT.receiveLine('F', { fix: 'fixes', task: { id: 'F', fixes: ['A'] }, record: unproven });
    expect(line).toMatch(/^FIX WITHOUT TEST F: /);
    expect(line).toMatch(/fixes A/);
    expect(line).toMatch(/unproven/);
    expect(line).not.toMatch(/\n/);
    expect(line).not.toMatch(/stops/);
    expect(FT.receiveLine('F', { fix: 'fixes', task: { id: 'F', fixes: ['A'] }, record: { verdict: 'proven', files: [] } })).toBeNull();
    expect(FT.receiveLine('A', { fix: null, task: { id: 'A' }, record: unproven })).toBeNull();
  });

  it('red on base off: nothing in the default mode, one line in the strict mode', () => {
    expect(FT.receiveLine('F', { fix: 'fixes', task: { id: 'F', fixes: ['A'] }, record: null })).toBeNull();
    const strict = FT.receiveLine('F', { fix: 'fixes', task: { id: 'F', fixes: ['A'] }, record: null, strict: true });
    expect(strict).toMatch(/gates\.redOnBase/);
    expect(strict).toMatch(/--allow-no-test/);
  });

  it('the strict mode says the merge stops', () => {
    expect(FT.receiveLine('F', { fix: 'qa', task: { id: 'F', qa_original: 'A' }, record: unproven, strict: true })).toMatch(/merge stops/i);
  });
});

describe('the strict mode at merge (opt-in)', () => {
  const fix = { id: 'F', fixes: ['A'], red_on_base: { verdict: 'no-tests', files: [] } };

  it('off unless gates.redOnBaseStrict is exactly true', () => {
    expect(FT.strictOn({})).toBe(false);
    expect(FT.strictOn({ gates: { redOnBaseStrict: 'yes' } })).toBe(false);
    expect(FT.strictOn({ gates: { redOnBaseStrict: true } })).toBe(true);
    // The fix line is on unless set to exactly false, and the strict mode keeps it, since it explains the stop.
    expect(FT.fixLineOn({})).toBe(true);
    expect(FT.fixLineOn({ gates: { fixWithoutTestWarning: false } })).toBe(false);
    expect(FT.fixLineOn({ gates: { fixWithoutTestWarning: false, redOnBaseStrict: true } })).toBe(true);
    expect(FT.mergeStop(fix, { config: {} })).toBeNull();
  });

  it('on: a fix without a proven red test stops, with the way out named', () => {
    const cfg = { gates: { redOnBaseStrict: true } };
    const stop = FT.mergeStop(fix, { config: cfg, cli: 'ravenseat' });
    expect(stop).toMatch(/^STOP: F is not merged\./);
    expect(stop).toMatch(/ravenseat merge F --allow-no-test/);
    expect(stop).toMatch(/no-test-overridden/);
    // No record (red on base off) is not proven either; the stop names the setting.
    expect(FT.mergeStop({ id: 'F', fixes: ['A'] }, { config: cfg })).toMatch(/gates\.redOnBase/);
    // A GATE-line fix is known from the record receive stored.
    expect(FT.mergeStop({ id: 'G', red_on_base: { verdict: 'unproven', files: [], fix: 'gate-line' } }, { config: cfg })).toMatch(/STOP: G/);
  });

  it('on: a proven fix and a task that is no fix merge as before', () => {
    const cfg = { gates: { redOnBaseStrict: true } };
    expect(FT.mergeStop({ ...fix, red_on_base: { verdict: 'proven', files: [] } }, { config: cfg })).toBeNull();
    expect(FT.mergeStop({ id: 'A', red_on_base: { verdict: 'no-tests', files: [] } }, { config: cfg })).toBeNull();
  });
});

describe('suggestCommand: gates.redOnBase from the stack', () => {
  const fsOf = (files: Record<string, string>) => ({
    exists: (f: string) => Object.hasOwn(files, f),
    read: (f: string) => (Object.hasOwn(files, f) ? files[f] : null),
  });

  it('the test runner the project has', () => {
    expect(FT.suggestCommand(fsOf({ 'package.json': JSON.stringify({ devDependencies: { vitest: '^3' } }) }))).toBe('npx vitest run {files}');
    expect(FT.suggestCommand(fsOf({ 'package.json': JSON.stringify({ devDependencies: { jest: '^29' } }) }))).toBe('npx jest {files}');
    expect(FT.suggestCommand(fsOf({ 'package.json': JSON.stringify({ scripts: { test: 'node --test' } }) }))).toBe('node --test {files}');
    expect(FT.suggestCommand(fsOf({ 'pyproject.toml': '[tool.pytest.ini_options]\n' }))).toBe('pytest {files}');
    expect(FT.suggestCommand(fsOf({ 'pyproject.toml': '[tool.pytest.ini_options]\n', 'uv.lock': '' }))).toBe('uv run pytest {files}');
    expect(FT.suggestCommand(fsOf({ 'requirements.txt': 'pytest==8.0\n' }))).toBe('pytest {files}');
    // Go runs packages, not files: {dirs} is the folders of the test files.
    expect(FT.suggestCommand(fsOf({ 'go.mod': 'module x\n' }))).toBe('go test {dirs}');
  });

  it('nothing for an unknown stack or an unreadable manifest', () => {
    expect(FT.suggestCommand(fsOf({}))).toBeNull();
    expect(FT.suggestCommand(fsOf({ 'package.json': '{ not json' }))).toBeNull();
    expect(FT.suggestCommand(fsOf({ 'package.json': JSON.stringify({ scripts: { test: 'echo "Error: no test specified" && exit 1' } }) }))).toBeNull();
  });
});
