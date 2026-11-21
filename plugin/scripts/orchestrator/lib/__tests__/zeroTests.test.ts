// =============================================================
// zeroTests.test.ts: "green, but no tests ran" (lib/zeroTests.js, GS-1).
//
// Locks: (1) one zero-test signal per common runner is found in the tail of a green run's output (vitest, jest, mocha,
// pytest, go, cargo, rspec, unittest); (2) a normal run ("Tests  12 passed") and a run where only some files or packages
// had no tests (go's "[no test files]" next to an "ok" line, cargo's doc-tests "running 0 tests" after real tests) do not
// match; (3) only the tail is read; (4) colour codes and CRLF do not hide a signal; (5) the receive NOTE line, the package
// section and the board's short text are calm and say which gate and which signal.
// =============================================================
import { describe, expect, it } from 'vitest';

const ZT = require('../zeroTests.js');

describe('detect: one signal per runner', () => {
  const cases: Array<[string, string, string]> = [
    ['vitest', 'No test files found, exiting with code 0\n', 'No test files found'],
    ['vitest', ' Test Files  0 passed (0)\n      Tests  0 passed (0)\n', 'Tests 0'],
    ['vitest', ' Test Files  1 skipped (1)\n      Tests  4 skipped (4)\n', 'all tests skipped'],
    ['jest', 'No tests found, exiting with code 0\nRun with `--passWithNoTests` to exit with code 0\n', 'No tests found'],
    ['jest', 'Test Suites: 0 total\nTests:       0 total\nSnapshots:   0 total\n', 'Tests 0'],
    ['mocha', '\n\n  0 passing (2ms)\n\n', '0 passing'],
    ['pytest', '============================ no tests ran in 0.01s =============================\n', 'no tests ran'],
    ['pytest', 'platform linux -- Python 3.12\ncollected 0 items\n', 'collected 0 items'],
    ['go', '?   \texample.com/a\t[no test files]\n?   \texample.com/b\t[no test files]\n', 'no test files'],
    ['go', 'ok  \texample.com/a\t0.012s [no tests to run]\n', 'no tests to run'],
    ['cargo', 'running 0 tests\n\ntest result: ok. 0 passed; 0 failed; 0 ignored\n', 'running 0 tests'],
    ['rspec', 'Finished in 0.001 seconds\n0 examples, 0 failures\n', '0 examples'],
    ['unittest', '\n----------------------------------------------------------------------\nRan 0 tests in 0.000s\n\nOK\n', 'Ran 0 tests'],
  ];
  for (const [runner, text, signal] of cases)
    it(`${runner}: ${signal}`, () => {
      expect(ZT.detect(text)).toEqual({ runner: expect.any(String), signal });
      expect(ZT.detect(text).runner).toContain(runner);
    });
});

describe('detect: a real run does not match', () => {
  const normal: Array<[string, string]> = [
    ['vitest normal', ' Test Files  3 passed (3)\n      Tests  12 passed (12)\n   Duration  1.2s\n'],
    ['vitest with skipped', '      Tests  10 passed | 2 skipped (12)\n'],
    ['jest normal', 'Test Suites: 2 passed, 2 total\nTests:       12 passed, 12 total\n'],
    ['mocha normal', '  12 passing (40ms)\n  1 pending\n'],
    ['pytest normal', '======================== 12 passed in 0.31s ========================\n'],
    ['go: some packages without tests', '?   \texample.com/a\t[no test files]\nok  \texample.com/b\t0.020s\n'],
    ['go cached', '?   \texample.com/a\t[no test files]\nok  \texample.com/b\t(cached)\n'],
    ['cargo: doc-tests with none', 'running 5 tests\ntest result: ok. 5 passed\n\n   Doc-tests demo\n\nrunning 0 tests\ntest result: ok. 0 passed\n'],
    ['rspec normal', '12 examples, 0 failures\n'],
    ['unittest normal', 'Ran 12 tests in 0.010s\n\nOK\n'],
    ['no test runner at all', 'Compiled 40 files.\nDone.\n'],
    ['empty', ''],
  ];
  for (const [name, text] of normal) it(name, () => expect(ZT.detect(text)).toBeNull());
});

describe('detect: what is read', () => {
  it('only the tail: a signal far above the end is not read', () => {
    const text = `No test files found\n${'line\n'.repeat(200)}`;
    expect(ZT.detect(text)).toBeNull();
    expect(ZT.detect(text, { tailLines: 300 })).not.toBeNull();
  });
  it('colour codes and CRLF do not hide a signal', () => {
    expect(ZT.detect('\u001b[33mNo test files found\u001b[39m, exiting with code 0\r\n')?.signal).toBe('No test files found');
  });
  it('a non-string is no signal', () => {
    expect(ZT.detect(null)).toBeNull();
    expect(ZT.detect(undefined)).toBeNull();
  });
});

describe('the list and the texts', () => {
  const list = [
    { gate: 'quick', command: 'npx vitest run -t nothing', runner: 'vitest', signal: 'No test files found' },
    { gate: 'done_when', command: 'pytest -k nothing', runner: 'pytest', signal: 'no tests ran' },
  ];
  it('clean keeps known gates and short strings only', () => {
    const got = ZT.clean([...list, { gate: 'other', command: 'x', runner: 'y', signal: 'z' }, null, 'text']);
    expect(got).toEqual(list);
    expect(ZT.clean('nope')).toEqual([]);
  });
  it('receiveLine is one NOTE line naming the gate and the signal; nothing for an empty list', () => {
    const line = ZT.receiveLine('T-1', list);
    expect(line.startsWith('NOTE ')).toBe(true);
    expect(line).not.toContain('\n');
    expect(line).toContain('green, but no tests ran');
    expect(line).toContain('quick gate');
    expect(line).toContain('No test files found');
    expect(line).toContain('done command');
    expect(ZT.receiveLine('T-1', [])).toBeNull();
  });
  it('packageSection has a heading and one line per command; [] for none', () => {
    const lines = ZT.packageSection(list);
    expect(lines).toContain('## Green, but no tests ran');
    expect(lines.filter((l: string) => l.startsWith('- '))).toHaveLength(2);
    expect(ZT.packageSection([])).toEqual([]);
  });
  it('boardText is short and calm', () => {
    expect(ZT.boardText(list)).toEqual({
      badge: 'no tests ran',
      title: expect.stringContaining('Green, but no tests ran'),
      fact: expect.stringContaining('quick gate: No test files found'),
    });
    expect(ZT.boardText([])).toBeNull();
  });
  it('ofTask joins the gate record and the done command record', () => {
    const o = { gate_check: { ok: true, zeroTests: [list[0]] }, done_check: { ok: true, zeroTests: [list[1]] } };
    expect(ZT.ofTask(o)).toEqual(list);
    expect(ZT.ofTask({})).toEqual([]);
    // A red record says nothing here: red is red.
    expect(ZT.ofTask({ gate_check: { ok: false, zeroTests: [list[0]] } })).toEqual([]);
  });
});
