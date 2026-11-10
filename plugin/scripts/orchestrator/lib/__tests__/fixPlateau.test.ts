// =============================================================
// fixPlateau.test.ts: the fix-round plateau (lib/fixPlateau.js).
//
// Why: a fix round costs a whole track session. A round that committed nothing (the branch tip did not move), or one
// that ends in exactly the same failure as the round before, is a sign the track is stuck. Then the owner is asked
// before the next round instead of paying for more of the same until the cap.
// =============================================================
import { describe, expect, it } from 'vitest';

type Round = { round: number; reason: string; tip?: string | null; signature?: string | null };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const FP = require('../fixPlateau.js') as {
  failureSignature: (x: {
    doneCheck?: { exit?: number | null; timedOut?: boolean; tail?: string[] } | null;
    gateCheck?: { exit?: number | null; tail?: string[] } | null;
    findingsText?: string | null;
  }) => string | null;
  plateauOf: (
    o: { id: string; resumed?: Round[] },
    now: { tip: string | null; signature: string | null },
  ) => { kind: 'tip' | 'failure'; previous: number; questionId: string } | null;
  plateauQuestionId: (id: string, n: number) => string;
  plateauQuestion: (
    o: { id: string; title?: string },
    p: { kind: string; previous: number; questionId: string },
  ) => Record<string, { type: string; text: string; recommendation: string; source: string }>;
  plateauOn: (cfg: Record<string, unknown>) => boolean;
};

describe('failureSignature: the same failure gives the same signature, noise does not count', () => {
  it('ignores durations, timestamps and commit shas, but not the failing names or counts', () => {
    const a = FP.failureSignature({ gateCheck: { exit: 1, tail: ['FAIL lib/x.test.ts > adds', 'Duration 4.21s', 'Start at 21:41:30'] } });
    const b = FP.failureSignature({ gateCheck: { exit: 1, tail: ['FAIL lib/x.test.ts > adds', 'Duration 9.80s', 'Start at 08:02:11'] } });
    expect(a).toBeTruthy();
    expect(a).toBe(b);
    expect(FP.failureSignature({ gateCheck: { exit: 1, tail: ['FAIL lib/y.test.ts > adds'] } })).not.toBe(a);
    expect(
      FP.failureSignature({ gateCheck: { exit: 1, tail: ['at abc1234def (commit 9f8e7d6c5b4a)'] } }),
    ).toBe(FP.failureSignature({ gateCheck: { exit: 1, tail: ['at abc1234def (commit 0123456789ab)'] } }));
    expect(FP.failureSignature({ gateCheck: { exit: 1, tail: ['2 failed'] } })).not.toBe(
      FP.failureSignature({ gateCheck: { exit: 1, tail: ['1 failed'] } }),
    );
  });

  it('keeps the kinds apart and gives null without any failure', () => {
    const tail = ['same text'];
    expect(FP.failureSignature({ doneCheck: { exit: 1, tail } })).not.toBe(FP.failureSignature({ gateCheck: { exit: 1, tail } }));
    expect(FP.failureSignature({ doneCheck: { exit: 1, tail } })).not.toBe(FP.failureSignature({ doneCheck: { exit: 2, tail } }));
    expect(FP.failureSignature({ findingsText: 'HIGH: x' })).toBeTruthy();
    expect(FP.failureSignature({})).toBeNull();
  });
});

describe('plateauOf: compares with the previous fix round', () => {
  const rounds = (...r: Round[]) => ({ id: 'A', resumed: r });

  it('the tip did not move since the previous fix round started', () => {
    const p = FP.plateauOf(rounds({ round: 1, reason: 'fix', tip: 'aaa', signature: 's1' }), { tip: 'aaa', signature: 's2' });
    expect(p).toEqual({ kind: 'tip', previous: 1, questionId: 'A.plateau1' });
  });

  it('the same failure as before the previous fix round', () => {
    const p = FP.plateauOf(rounds({ round: 1, reason: 'fix', tip: 'aaa', signature: 's1' }), { tip: 'bbb', signature: 's1' });
    expect(p).toEqual({ kind: 'failure', previous: 1, questionId: 'A.plateau1' });
  });

  it('no plateau: progress, the first fix round, context rounds or old rounds without the fields', () => {
    expect(FP.plateauOf(rounds({ round: 1, reason: 'fix', tip: 'aaa', signature: 's1' }), { tip: 'bbb', signature: 's2' })).toBeNull();
    expect(FP.plateauOf(rounds(), { tip: 'aaa', signature: 's1' })).toBeNull();
    expect(FP.plateauOf(rounds({ round: 1, reason: 'context', tip: 'aaa', signature: 's1' }), { tip: 'aaa', signature: 's1' })).toBeNull();
    expect(FP.plateauOf(rounds({ round: 1, reason: 'fix' }), { tip: 'aaa', signature: 's1' })).toBeNull();
    // An unknown signature now never matches.
    expect(FP.plateauOf(rounds({ round: 1, reason: 'fix', tip: 'aaa', signature: null }), { tip: 'bbb', signature: null })).toBeNull();
  });

  it('compares with the LAST fix round, and numbers the question by the fix rounds used', () => {
    const o = rounds(
      { round: 1, reason: 'fix', tip: 'aaa', signature: 's1' },
      { round: 2, reason: 'context', tip: 'bbb', signature: null },
      { round: 3, reason: 'fix', tip: 'ccc', signature: 's3' },
    );
    expect(FP.plateauOf(o, { tip: 'ddd', signature: 's1' })).toBeNull();
    expect(FP.plateauOf(o, { tip: 'ccc', signature: 'x' })).toEqual({ kind: 'tip', previous: 3, questionId: 'A.plateau2' });
  });
});

describe('the owner question', () => {
  it('says what was seen and how to answer, within the 40-character id rule', () => {
    const q = FP.plateauQuestion({ id: 'A', title: 'Task A' }, { kind: 'tip', previous: 1, questionId: 'A.plateau1' });
    const x = q['A.plateau1'];
    expect(x.type).toBe('question');
    expect(x.text).toMatch(/no new commits/);
    expect(x.recommendation).toContain('ravenseat resolve A.plateau1 --answer');
    const f = FP.plateauQuestion({ id: 'A' }, { kind: 'failure', previous: 2, questionId: 'A.plateau2' })['A.plateau2'];
    expect(f.text).toMatch(/same failure/);
    expect(FP.plateauQuestionId('X'.repeat(60), 3)).toHaveLength(40);
  });

  it('is on by default and off with fixPlateau: false', () => {
    expect(FP.plateauOn({})).toBe(true);
    expect(FP.plateauOn({ fixPlateau: false })).toBe(false);
  });
});
