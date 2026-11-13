// =============================================================
// deltaReview.test.ts: the review after a fix round sees only the commits since the last review (lib/deltaReview.js).
//
// Locks: (1) when receive makes a delta package (an earlier review on this branch, a fix round since, the reviewed
// commit an ancestor of the tip, the same merge base) and why it falls back to the whole package otherwise; (2) the
// record receive saves for the next round; (3) the package section and the reviewer line for a delta review.
// =============================================================
import { describe, it, expect } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const DR = require('../deltaReview.js') as any;
const L = require('../queueLogic.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const o = {
  id: 'A',
  class: 'D',
  review_sha: 'aaa111',
  review_base: 'bbb222',
  review_at: '2026-11-13T10:00:00.000Z',
  review_reviewers: ['reviewer', 'reviewer-tests'],
  resumed: [
    { round: 1, reason: 'fix', time: '2026-11-13T10:30:00.000Z', findings: 'scratch/findings-A-r1.md' },
  ],
};
const yes = () => true;
const R = ['reviewer', 'reviewer-tests'];

describe('deltaScope', () => {
  it('a fix round after a review on the same base gives the delta from the reviewed commit to the tip', () => {
    expect(DR.deltaScope({ o, tip: 'ccc333', mergeBase: 'bbb222', isAncestor: yes, reviewers: R })).toEqual({
      delta: { from: 'aaa111', to: 'ccc333', round: 1, findings: 'scratch/findings-A-r1.md' },
      why: null,
    });
  });

  it('falls back to the whole package, with the reason', () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ full: true }, /--full-review/],
      [{ partial: true }, /PARTIAL/],
      [{ o: { ...o, review_sha: undefined } }, /no earlier review/],
      [{ tip: 'aaa111' }, /no commits since the last review/],
      [{ mergeBase: 'other' }, /base was merged/],
      [{ isAncestor: () => false }, /not an ancestor/],
      [{ o: { ...o, resumed: [{ round: 1, reason: 'fix', time: '2026-11-13T09:00:00.000Z' }] } }, /no fix round since the last review/],
      [{ o: { ...o, resumed: [{ round: 1, reason: 'context', time: '2026-11-13T11:00:00.000Z' }] } }, /no fix round since the last review/],
      // A reviewer that did not review the earlier commits must see the whole track, or those commits go unreviewed.
      [{ reviewers: ['reviewer', 'reviewer-tests', 'reviewer-security'] }, /reviewer-security.*did not see the earlier commits/],
      [{ o: { ...o, review_reviewers: undefined } }, /no reviewer saw the earlier commits/],
      [{ o: { ...o, review_reviewers: [] } }, /no reviewer saw the earlier commits/],
      [{ reviewers: undefined }, /no reviewers given/],
      [{ reviewers: [] }, /no reviewers run now/],
    ];
    for (const [change, why] of cases) {
      const r = DR.deltaScope({ o, tip: 'ccc333', mergeBase: 'bbb222', isAncestor: yes, reviewers: R, ...change });
      expect(r.delta, JSON.stringify(change)).toBeNull();
      expect(r.why).toMatch(why);
    }
  });

  it('the newest fix round after the review gives the findings; a round without a findings file gives null', () => {
    const two = {
      ...o,
      resumed: [...o.resumed, { round: 2, reason: 'fix', time: '2026-11-13T11:00:00.000Z' }],
    };
    expect(DR.deltaScope({ o: two, tip: 'c', mergeBase: 'bbb222', isAncestor: yes, reviewers: R }).delta).toMatchObject({ round: 2, findings: null });
  });
});

describe('reviewRecord, packageSection and the reviewer prompt', () => {
  it('reviewRecord is what receive saves after it made reviewer prompts', () => {
    expect(DR.reviewRecord({ tip: 't', mergeBase: 'm', now: '2026-11-13T12:00:00.000Z', reviewers: ['reviewer'] })).toEqual({
      review_sha: 't',
      review_base: 'm',
      review_at: '2026-11-13T12:00:00.000Z',
      review_reviewers: ['reviewer'],
    });
  });

  it('a round where a subset of the earlier reviewers runs still gets the delta', () => {
    expect(DR.deltaScope({ o, tip: 'ccc333', mergeBase: 'bbb222', isAncestor: yes, reviewers: ['reviewer'] }).delta).not.toBeNull();
  });

  it('no reviewer ran: there is no record, so the next round is not a delta of an unreviewed one', () => {
    expect(DR.reviewRecord({ tip: 't', mergeBase: 'm', now: 'n', reviewers: [] })).toBeNull();
  });

  it('the package section says what the delta holds and where the rest is', () => {
    const lines = DR.packageSection({ from: 'aaa1112223334445', to: 'ccc3334445556667', round: 1 }, { previousFindings: true });
    const text = lines.join('\n');
    expect(text).toContain('## Delta review (after fix round 1)');
    expect(text).toContain('`git diff aaa111222333..ccc333444555`');
    expect(text).toContain('previous-findings.md');
    expect(text).toContain('diff-full.patch');
    const without = DR.packageSection({ from: 'a', to: 'c', round: 2 }, { previousFindings: false }).join('\n');
    expect(without).toContain('No findings file was given to the fix round');
  });

  it('reviewPackageIndex and reviewerPrompt keep the whole-package text without delta and say delta with it', () => {
    const task = { id: 'A', class: 'K', title: 'T', branch: 'queue/A' };
    const full = L.reviewPackageIndex({ o: task, branch: 'queue/A', stat: '1 file', base: 'develop', migrFolder: null });
    expect(full).toContain('the whole diff (`git diff develop...<branch>`)');
    const delta = L.reviewPackageIndex({
      o: task,
      branch: 'queue/A',
      stat: '1 file',
      base: 'develop',
      migrFolder: null,
      delta: { from: 'aaa111', to: 'ccc333', round: 1 },
      deltaSection: DR.packageSection({ from: 'aaa111', to: 'ccc333', round: 1 }, { previousFindings: true }),
    });
    expect(delta).toContain('the commits since the last review (`git diff aaa111..ccc333`)');
    expect(delta).toContain('## Delta review (after fix round 1)');
    expect(delta).not.toContain('the whole diff');
    const p = L.reviewerPrompt({ o: task, type: 'reviewer', folder: 'scratch/rev-A' });
    expect(p).not.toMatch(/delta/i);
    const pd = L.reviewerPrompt({ o: task, type: 'reviewer', folder: 'scratch/rev-A', delta: { from: 'a', to: 'c', round: 1 } });
    expect(pd).toMatch(/delta review after fix round 1/i);
    expect(pd).toContain('previous-findings.md');
  });
});
