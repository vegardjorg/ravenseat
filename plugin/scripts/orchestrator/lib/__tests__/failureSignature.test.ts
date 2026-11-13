// =============================================================
// failureSignature.test.ts: a red gate run or a red CI job becomes a stable signature (lib/failureSignature.js).
//
// Locks: (1) the same failure in two worktrees, at other times, with other durations, shas and line numbers, gives ONE
// signature; (2) different failures (another error code, another test, another command) give different ones; (3) a
// timeout has one signature per command, whatever it printed before the budget ran out; (4) secrets never reach the
// excerpt; (5) the excerpt is short; (6) the gate row and the CI watch row give the same kind of occurrence.
// The examples are realistic tool output with neutral names (no project data).
// =============================================================
import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const FS = require('../failureSignature');

const VITEST = (worktree: string, secs: string, line: number) =>
  [
    ' RUN  v3.2.4 ' + worktree,
    '',
    ' FAIL  src/sum.test.ts > sum > adds two numbers',
    'AssertionError: expected 3 to be 4 // Object.is equality',
    ` ❯ ${worktree}/src/sum.test.ts:${line}:17`,
    '',
    ' Test Files  1 failed | 12 passed (13)',
    `      Tests  1 failed | 80 passed (81)`,
    `   Duration  ${secs}s (transform 120ms, setup 0ms)`,
  ].join('\n');

describe('the same failure gives one signature', () => {
  it('a test failure in two worktrees, at other times, with other durations and line numbers', () => {
    const a = FS.gateExcerpt({
      command: 'npx vitest run',
      output: VITEST('C:/work/app/.claude/worktrees/queue-A-1', '4.21', 12),
      roots: ['C:/work/app/.claude/worktrees/queue-A-1'],
    });
    const b = FS.gateExcerpt({
      command: 'npx vitest run',
      output: VITEST('/home/dev/app/.claude/worktrees/queue-B-7', '19.80', 14),
      roots: [],
    });
    expect(a).toBe(b);
    expect(a).toContain('FAIL src/sum.test.ts > sum > adds two numbers');
    expect(FS.signatureId('npx vitest run', a)).toBe(FS.signatureId('npx vitest run', b));
  });

  it('a secret scan red in CI on two commits: the job, step and timestamp prefix of gh run view --log-failed go', () => {
    const log = (sha: string, ts: string) =>
      [
        `scan\tSecret scan\t${ts} Scanning 412 commits from ${sha}`,
        `scan\tSecret scan\t${ts} ##[error]leaks found: 1 in config/settings.example.json:3`,
        `scan\tSecret scan\t${ts} ##[error]Process completed with exit code 1.`,
      ].join('\n');
    const run = { workflowName: 'CI', name: 'CI', databaseId: 1 };
    const jobs = [{ name: 'scan', conclusion: 'failure', steps: [{ name: 'Checkout', conclusion: 'success' }, { name: 'Secret scan', conclusion: 'failure' }] }];
    const one = FS.ciFailures({ run, jobs, log: log('3f2a9c1d4e5b', '2026-11-01T10:00:00.1234567Z') });
    const two = FS.ciFailures({ run: { ...run, databaseId: 2 }, jobs, log: log('a1b2c3d4e5f6a7b8', '2026-11-09T22:41:07.0000001Z') });
    expect(one).toHaveLength(1);
    expect(one[0].name).toBe('ci: CI / scan / Secret scan');
    expect(one).toEqual(two);
    expect(one[0].excerpt).toContain('leaks found');
    expect(one[0].excerpt).not.toContain('2026-11');
  });

  it('a timeout: one signature per command, whatever was printed before the budget ran out', () => {
    const a = FS.gateExcerpt({ command: 'npm test', output: 'running 1203 tests\n... 40% done', timedOut: true });
    const b = FS.gateExcerpt({ command: 'npm test', output: 'running 1204 tests\n... 87% done', timedOut: true });
    expect(a).toBe('timed out');
    expect(b).toBe(a);
  });

  it('shas, ISO times, clock times, uuids, temp folders and counts are normalized', () => {
    const n = FS.normalize(
      'Error at 2026-11-02T08:15:00Z (12:01:33) in /tmp/vitest-abc123/out.json: commit 9f8e7d6c5b4a ' +
        'run 123e4567-e89b-12d3-a456-426614174000 took 812ms, 3 retries',
    );
    expect(n).toBe('Error at <time> (<time>) in <tmp>: commit <sha> run <id> took <dur>, <n> retries');
    // Windows temp folders too, with backslashes.
    expect(FS.normalize('cannot open C:\\Users\\dev\\AppData\\Local\\Temp\\ravenseat-gate-run-x1\\a.txt')).toBe('cannot open <tmp>');
    // Normalizing twice changes nothing.
    expect(FS.normalize(n)).toBe(n);
  });
});

describe('different failures give different signatures', () => {
  it('another type error code, another test, another command', () => {
    const ts = (code: string) => FS.gateExcerpt({ command: 'npx tsc --noEmit', output: `src/a.ts(4,7): error ${code}: Type 'string' is not assignable to type 'number'.` });
    expect(ts('TS2322')).not.toBe(ts('TS2345'));
    expect(ts('TS2322')).toContain('TS2322');
    const t1 = FS.gateExcerpt({ command: 'npx vitest run', output: ' FAIL  src/a.test.ts > a > works\n' });
    const t2 = FS.gateExcerpt({ command: 'npx vitest run', output: ' FAIL  src/b.test.ts > b > works\n' });
    expect(t1).not.toBe(t2);
    expect(FS.signatureId('npm run lint', t1)).not.toBe(FS.signatureId('npx vitest run', t1));
  });
});

describe('what is kept', () => {
  it('no secrets in the excerpt, and the excerpt is short', () => {
    const token = `ghp_${'a1'.repeat(20)}`;
    const e = FS.gateExcerpt({
      command: 'node scan.js',
      output: `Error: leaked value API_KEY=${'x9'.repeat(12)} and ${token} ${'word '.repeat(200)}`,
    });
    expect(e).not.toContain(token);
    expect(e).not.toContain('x9x9x9');
    expect(e).toContain('[REDACTED');
    expect(e.length).toBeLessThanOrEqual(FS.EXCERPT_MAX);
  });

  it('no error line at all: the last line, normalized', () => {
    expect(FS.gateExcerpt({ command: 'make check', output: 'step 1\nstep 2 stopped after 3 s\n' })).toBe('step <n> stopped after <dur>');
    expect(FS.gateExcerpt({ command: 'make check', output: '' })).toBe('(no output)');
  });
});

describe('occurrences from the time log rows', () => {
  it('a red gate row gives one occurrence per failed command, with the track as the incident', () => {
    const row = {
      time: '2026-11-03T10:00:00.000Z',
      event: 'gate',
      track: 'A-1',
      branch: 'queue/A-1',
      gates: ['npm run lint', 'npx vitest run'],
      failed: ['npx vitest run'],
      errors: { 'npx vitest run': 'FAIL src/sum.test.ts > sum > adds two numbers' },
    };
    const [o, ...rest] = FS.fromGateRow(row);
    expect(rest).toEqual([]);
    expect(o).toMatchObject({ source: 'gate', name: 'npx vitest run', task: 'A-1', incident: 'task A-1', time: row.time });
    expect(o.id).toBe(FS.signatureId('npx vitest run', 'FAIL src/sum.test.ts > sum > adds two numbers'));
    // An older row without errors still counts, by the command alone; without a track the incident is branch and day.
    const old = FS.fromGateRow({ ...row, track: null, errors: undefined });
    expect(old[0]).toMatchObject({ excerpt: '', incident: 'queue/A-1 2026-11-03' });
    // Green rows give nothing.
    expect(FS.fromGateRow({ ...row, failed: [] })).toEqual([]);
  });

  it('a red CI watch row gives one occurrence per failure, with the commit as the incident', () => {
    const row = { time: '2026-11-03T10:00:00.000Z', event: 'ciWatch', sha: 'abc1234def', verdict: 'check', task: 'CI-abc1234', failures: [{ name: 'ci: CI / scan / Secret scan', excerpt: '##[error]leaks found: <n>' }] };
    expect(FS.fromCiRow(row)).toEqual([
      expect.objectContaining({ source: 'ci', name: 'ci: CI / scan / Secret scan', task: 'CI-abc1234', incident: 'commit abc1234def' }),
    ]);
    expect(FS.fromCiRow({ ...row, verdict: 'green', failures: undefined })).toEqual([]);
  });
});
