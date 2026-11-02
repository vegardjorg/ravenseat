// =============================================================
// ciWatch.test.ts: the pure parts of the CI watch (lib/ciWatch.js), the optional safety net after a batch push.
//
// Locks: (1) the setup is off by default and on only with push.ciWatch "github"; (2) the run list summary: no runs,
// pending while any run is not completed, done with the red runs; (3) the classification: a failed check vs an
// infrastructure failure (cancelled, timed out, startup failure, a job that never got a runner, billing and runner
// messages in the log); (4) the fix task CI-<sha7> (value 10, class K, by "ci watch", the report file named, the log
// never in the mission); (5) the infra question has a strict id and choices; (6) the log tail is capped and redacted.
// The watch loop itself (gh, the queue, the base health) is in __tests__/queueCiWatch.test.ts.
// =============================================================
import { describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports */
type Run = Record<string, unknown>;
const CW = require('../ciWatch.js') as {
  ciWatchSetup: (cfg?: object) => { mode: string; enabled: boolean; intervalSec: number; timeoutMin: number };
  summarize: (runs: Run[]) => { phase: string; red: Run[]; total: number };
  classify: (x: { run: Run; log?: string; jobs?: object[] | null }) => { kind: string; reason: string };
  verdictOf: (items: { kind: string }[]) => string;
  taskId: (sha: string) => string;
  questionId: (sha: string) => string;
  fixTask: (x: object) => Record<string, unknown>;
  infraQuestion: (x: object) => { id: string; question: Record<string, unknown> };
  logTail: (text: string, o?: { bytes?: number; lines?: number }) => string[];
};
const L = require('../queueLogic.js') as { validate: (t: object, tasks: object[]) => string[] };

const SHA = 'abcdef1234567890abcdef1234567890abcdef12';
const run = (over: Run = {}): Run => ({
  databaseId: 11,
  name: 'CI',
  workflowName: 'CI',
  status: 'completed',
  conclusion: 'failure',
  url: 'https://github.com/o/r/actions/runs/11',
  attempt: 1,
  ...over,
});

describe('ciWatch (pure)', () => {
  it('the setup: off by default, github turns it on, anything else is off', () => {
    expect(CW.ciWatchSetup({}).enabled).toBe(false);
    expect(CW.ciWatchSetup({ push: { ciWatch: 'off' } }).mode).toBe('off');
    const on = CW.ciWatchSetup({ push: { ciWatch: 'github', ciWatchIntervalSec: 30, ciWatchTimeoutMin: 20 } });
    expect(on).toMatchObject({ mode: 'github', enabled: true, intervalSec: 30, timeoutMin: 20 });
    expect(CW.ciWatchSetup({ push: { ciWatch: 'gitlab' } }).enabled).toBe(false);
    expect(CW.ciWatchSetup({ push: { ciWatch: 'github', ciWatchIntervalSec: -1 } }).intervalSec).toBe(60);
  });

  it('summarizes the run list: none, pending while one runs, done with the red runs', () => {
    expect(CW.summarize([]).phase).toBe('none');
    expect(CW.summarize([run({ status: 'in_progress', conclusion: '' }), run({ conclusion: 'success' })]).phase).toBe('pending');
    const green = CW.summarize([run({ conclusion: 'success' }), run({ conclusion: 'skipped', databaseId: 12 })]);
    expect(green).toMatchObject({ phase: 'done', red: [], total: 2 });
    const red = CW.summarize([run({ conclusion: 'success' }), run({ databaseId: 12 })]);
    expect(red.phase).toBe('done');
    expect(red.red.map((r) => r.databaseId)).toEqual([12]);
  });

  it('classifies a failed check against an infrastructure failure', () => {
    const check = CW.classify({ run: run(), log: 'test\tRun tests\tFAIL src/a.test.ts\nexpected 1 to be 2', jobs: [{ conclusion: 'failure', steps: [{ conclusion: 'failure' }] }] });
    expect(check.kind).toBe('check');
    expect(CW.classify({ run: run({ conclusion: 'cancelled' }) })).toMatchObject({ kind: 'infra', reason: 'cancelled' });
    expect(CW.classify({ run: run({ conclusion: 'timed_out' }) })).toMatchObject({ kind: 'infra', reason: 'timeout' });
    expect(CW.classify({ run: run({ conclusion: 'startup_failure' }) })).toMatchObject({ kind: 'infra', reason: 'runner' });
    expect(
      CW.classify({ run: run(), log: '', jobs: [{ conclusion: 'failure', steps: [] }] }),
    ).toMatchObject({ kind: 'infra', reason: 'runner' });
    expect(
      CW.classify({ run: run(), log: 'The job was not started because recent account payments have failed or your spending limit needs to be increased.' }),
    ).toMatchObject({ kind: 'infra', reason: 'billing' });
    expect(
      CW.classify({ run: run(), log: 'build\tx\tThe runner has received a shutdown signal.' }),
    ).toMatchObject({ kind: 'infra', reason: 'runner' });
    expect(CW.verdictOf([{ kind: 'infra' }, { kind: 'check' }])).toBe('check');
    expect(CW.verdictOf([{ kind: 'infra' }])).toBe('infra');
  });

  it('the fix task: CI-<sha7>, value 10, by ci watch, the report file named and no log text', () => {
    expect(CW.taskId(SHA)).toBe('CI-abcdef1');
    const t = CW.fixTask({ sha: SHA, branch: 'develop', runs: [run()], reportFile: '/q/ci-abcdef1.md', project: 'app' });
    expect(t).toMatchObject({ id: 'CI-abcdef1', class: 'K', value: 10, added_by: 'ci watch', project: 'app' });
    expect(String(t.mission)).toContain('/q/ci-abcdef1.md');
    expect(String(t.mission)).toContain(SHA);
    expect(String(t.mission)).not.toContain('expected 1');
    expect(L.validate(t, [])).toEqual([]);
  });

  it('the infra question: a strict id, a recommendation and choices', () => {
    expect(CW.questionId(SHA)).toBe('ci-abcdef1-infra');
    const q = CW.infraQuestion({ sha: SHA, branch: 'develop', items: [{ run: run({ conclusion: 'cancelled' }), kind: 'infra', reason: 'cancelled' }], reportFile: '/q/r.md' });
    expect(q.id).toBe('ci-abcdef1-infra');
    expect(q.question).toMatchObject({ type: 'question', source: 'ci watch' });
    expect((q.question.choices as string[]).length).toBeGreaterThanOrEqual(2);
    expect(String(q.question.text)).toContain('Nothing was frozen');
  });

  it('the log tail: the last lines only, capped in size, secrets redacted', () => {
    const long = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const tail = CW.logTail(`${long}\ntoken ghp_${'a'.repeat(40)}\nthe end`, { bytes: 2000, lines: 20 });
    expect(tail.length).toBeLessThanOrEqual(20);
    expect(tail.at(-1)).toBe('the end');
    expect(tail.join('\n')).toContain('[REDACTED');
    expect(tail.join('\n')).not.toContain('ghp_aaaa');
  });
});
