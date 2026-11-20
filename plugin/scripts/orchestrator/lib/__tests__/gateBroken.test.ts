// =============================================================
// gateBroken.test.ts: "the gate cannot run" (lib/gateBroken.js).
//
// Why: a gate whose own program is not installed is a setup problem, not a code failure; a fix round cannot help. The
// rule is narrow on purpose: only the FIRST program of the command, never "Cannot find module", and only when the base
// fails the same way.
// =============================================================
import { describe, expect, it } from 'vitest';

type Run = { command: string; exit: number | null; output: string; timedOut?: boolean };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const GB = require('../gateBroken.js') as {
  on: (c: unknown) => boolean;
  firstProgram: (c: string) => string | null;
  missingPrograms: (t: string) => string[];
  cannotRun: (r: Run) => string | null;
  logSections: (t: string) => { command: string; exit: number | null; output: string }[];
  candidates: (t: string, commands: string[]) => { command: string; program: string }[];
  questionId: (id: string, hash: string) => string;
  verdict: (x: {
    id: string;
    found: { command: string; program: string }[];
    baseRuns: Record<string, { exit: number | null; output: string; timedOut?: boolean }>;
    setupHash: string;
    now?: string;
  }) => null | { commands: string[]; program: string; setup_hash: string; question: string };
};

const HASH = 'abcdef0123456789'.repeat(4);

describe('gateBroken', () => {
  it('is on by default and off only with false', () => {
    expect(GB.on({})).toBe(true);
    expect(GB.on({ gates: { brokenVerdict: true } })).toBe(true);
    expect(GB.on({ gates: { brokenVerdict: false } })).toBe(false);
  });

  it('finds the first program after env assignments and quotes', () => {
    expect(GB.firstProgram('npm run lint')).toBe('npm');
    expect(GB.firstProgram('CI=1 FOO=bar tsc --noEmit')).toBe('tsc');
    expect(GB.firstProgram('"C:\\Tools\\lint.exe" --all')).toBe('lint');
    expect(GB.firstProgram('./bin/check.sh')).toBe('check.sh');
    expect(GB.firstProgram('(cd x && make)')).toBeNull();
  });

  it('reads the shells\' own lines', () => {
    expect(GB.missingPrograms('sh: 1: pg_prove: not found')).toEqual(['pg_prove']);
    expect(GB.missingPrograms('bash: shellcheck: command not found')).toEqual(['shellcheck']);
    expect(GB.missingPrograms('/bin/sh: line 1: deno: command not found')).toEqual(['deno']);
    expect(GB.missingPrograms('zsh: command not found: ruff')).toEqual(['ruff']);
    expect(GB.missingPrograms("'tsc' is not recognized as an internal or external command,")).toEqual(['tsc']);
    expect(GB.missingPrograms("The term 'pwsh-lint' is not recognized as the name of a cmdlet")).toEqual(['pwsh-lint']);
    expect(GB.missingPrograms('Error: spawn cargo ENOENT')).toEqual(['cargo']);
    expect(GB.missingPrograms('Error: file not found')).toEqual([]);
  });

  it('a missing first program is the verdict; a missing inner program, a code failure and a timeout are not', () => {
    expect(GB.cannotRun({ command: 'deno test', exit: 127, output: 'sh: 1: deno: not found' })).toBe('deno');
    expect(GB.cannotRun({ command: 'tsc', exit: 9009, output: "'tsc.cmd' is not recognized as an internal or external command," })).toBe('tsc');
    // npm runs, the script inside it misses a tool: not the gate's first program.
    expect(GB.cannotRun({ command: 'npm run lint', exit: 127, output: 'sh: 1: eslint: not found' })).toBeNull();
    // The track's own code: always a code failure, even next to a not-found line.
    expect(
      GB.cannotRun({ command: 'node lib/a.js', exit: 1, output: "Error: Cannot find module './b.js'\nsh: 1: node: not found" }),
    ).toBeNull();
    expect(GB.cannotRun({ command: 'deno test', exit: 0, output: 'sh: 1: deno: not found' })).toBeNull();
    expect(GB.cannotRun({ command: 'deno test', exit: null, output: 'sh: 1: deno: not found', timedOut: true })).toBeNull();
  });

  it('reads the first run of each command from the gate log, not the rerun', () => {
    const log = [
      'gates --quick in /x',
      '',
      '===== deno test (exit 127, 0 s) =====',
      'sh: 1: deno: not found',
      '',
      '===== node -e "1" (exit 0, 0 s) =====',
      '',
      '===== deno test (rerun, exit 0, 0 s) =====',
      'all good',
    ].join('\n');
    const s = GB.logSections(log);
    expect(s.map((x) => [x.command, x.exit])).toEqual([
      ['deno test', 127],
      ['node -e "1"', 0],
    ]);
    expect(s[0].output).toContain('deno: not found');
    expect(GB.candidates(log, ['deno test', 'node -e "1"'])).toEqual([{ command: 'deno test', program: 'deno' }]);
    // A command that is not a configured quick gate never counts.
    expect(GB.candidates(log, ['node -e "1"'])).toEqual([]);
  });

  it('needs the base to fail the same way, and ties the question to the setup hash', () => {
    const found = [{ command: 'deno test', program: 'deno' }];
    const missing = { exit: 127, output: 'sh: 1: deno: not found' };
    const v = GB.verdict({ id: 'T1', found, baseRuns: { 'deno test': missing }, setupHash: HASH });
    expect(v).toMatchObject({ commands: ['deno test'], program: 'deno', setup_hash: HASH, question: 'T1.nogateabcdef01' });
    // The base runs it (red for another reason, green, or over the budget): the track's to fix.
    expect(GB.verdict({ id: 'T1', found, baseRuns: { 'deno test': { exit: 1, output: '1 failed' } }, setupHash: HASH })).toBeNull();
    expect(GB.verdict({ id: 'T1', found, baseRuns: { 'deno test': { exit: 0, output: '' } }, setupHash: HASH })).toBeNull();
    expect(
      GB.verdict({ id: 'T1', found, baseRuns: { 'deno test': { exit: null, output: '', timedOut: true } }, setupHash: HASH }),
    ).toBeNull();
    expect(GB.verdict({ id: 'T1', found, baseRuns: {}, setupHash: HASH })).toBeNull();
    // A long task id still gives a valid question id (at most 40 characters).
    expect(GB.questionId('X'.repeat(60), HASH)).toHaveLength(40);
  });
});
