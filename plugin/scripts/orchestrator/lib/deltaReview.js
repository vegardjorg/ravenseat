// =============================================================
// deltaReview.js: the review after a fix round sees only the commits since the last review, plus what it found.
//
// Why: `ravenseat receive` rebuilt the whole review package after every fix round, so the reviewers read the whole track
// again to check a few fixes. Now receive saves the commit the package covered (`review_sha`), the merge base then
// (`review_base`) and when (`review_at`). The next receive makes a delta package when all of these hold:
//   - not asked for the whole package (`receive --full-review`) and not a PARTIAL delivery;
//   - an earlier package on this branch, and the tip has moved since;
//   - the base was not merged into the branch since (the same merge base): otherwise the delta would carry the base's
//     changes too, so the whole package is made again;
//   - the reviewed commit is an ancestor of the tip (no rewritten history);
//   - a fix round (`resumed` reason fix) after that review: only then is there something to check against;
//   - every reviewer that runs now got the earlier package (`review_reviewers`): a new one sees the whole track.
// The delta package: diff.patch and files/ hold only `git diff <review_sha>..<tip>`, previous-findings.md is the findings
// file the fix round got, and diff-full.patch is the whole track diff for context. WHICH reviewers run, the DB objects,
// the test-weakening check, the ownership and hotspot notes and every gate still use the whole track diff.
//
// Pure, no I/O: cli/merge.mjs cmdReceive does the git and the files. Tested in lib/__tests__/deltaReview.test.ts and
// __tests__/queueFixContinue.test.ts.
// =============================================================
'use strict';

const short = (sha) => String(sha ?? '').slice(0, 12);

/**
 * The delta for this receive, or null with the reason the whole package is made.
 * @param {{ o: object, tip: string, mergeBase: string|null, isAncestor: (a: string, b: string) => boolean,
 *   full?: boolean, partial?: boolean }} x
 * @returns {{ delta: null | { from: string, to: string, round: number|null, findings: string|null }, why: string|null }}
 */
function deltaScope({ o, tip, mergeBase, isAncestor, reviewers, full = false, partial = false }) {
  const whole = (why) => ({ delta: null, why });
  if (full) return whole('asked for the whole package (--full-review)');
  if (partial) return whole('a PARTIAL delivery gets the whole package');
  if (!o?.review_sha) return whole('no earlier review on this branch');
  // A reviewer that did not review the earlier commits must see the whole track: with only the delta, the commits
  // before the last review would never be reviewed by it. The reviewers are worked out from the whole diff, so a fix
  // round that touches new areas can bring in a new one.
  if (!Array.isArray(reviewers)) return whole('no reviewers given');
  if (!reviewers.length) return whole('no reviewers run now');
  const before = Array.isArray(o.review_reviewers) ? o.review_reviewers : [];
  if (!before.length) return whole('no reviewer saw the earlier commits');
  const added = reviewers.filter((r) => !before.includes(r));
  if (added.length) return whole(`${added.join(', ')} did not see the earlier commits`);
  if (!tip || tip === o.review_sha) return whole('no commits since the last review');
  if (!mergeBase || mergeBase !== o.review_base) return whole('the base was merged into the branch since the last review');
  if (!isAncestor(o.review_sha, tip)) return whole('the reviewed commit is not an ancestor of the tip (history rewritten)');
  const since = Date.parse(o.review_at ?? '');
  const fixes = (Array.isArray(o.resumed) ? o.resumed : []).filter(
    (r) => r?.reason === 'fix' && (!Number.isFinite(since) || Date.parse(r.time ?? '') > since),
  );
  if (!fixes.length) return whole('no fix round since the last review');
  const last = fixes[fixes.length - 1];
  return {
    delta: { from: o.review_sha, to: tip, round: last.round ?? null, findings: last.findings ?? null },
    why: null,
  };
}

/**
 * What receive saves on the task after it made the package: the tip it covered, the merge base, when, and the reviewers
 * that got it. null when no reviewer runs: nothing was reviewed, so the next round must not be a delta from here.
 */
function reviewRecord({ tip, mergeBase, now, reviewers }) {
  if (!Array.isArray(reviewers) || !reviewers.length) return null;
  return { review_sha: tip, review_base: mergeBase, review_at: now, review_reviewers: [...reviewers] };
}

/** The "Delta review" section of 00-package.md, as lines. */
function packageSection(delta, { previousFindings = false } = {}) {
  return [
    '',
    `## Delta review (after fix round ${delta.round ?? '?'})`,
    '',
    `This package holds only the commits since the last review: \`git diff ${short(delta.from)}..${short(delta.to)}\` (diff.patch and files/).`,
    previousFindings
      ? '- `previous-findings.md`: what the last review found. Check that each HIGH and MEDIUM finding is fixed, then review the new commits.'
      : '- No findings file was given to the fix round: check the new commits against the last review as you know it.',
    '- `diff-full.patch`: the whole track diff against the base, for context only. Read it only when a finding needs it.',
  ];
}

/** The reviewer prompt line for a delta review. */
function reviewerLine(delta) {
  return (
    `This is a delta review after fix round ${delta.round ?? '?'}: diff.patch holds only the commits since the last review. ` +
    'Check that the findings in previous-findings.md are fixed and review the new commits; diff-full.patch is context only.'
  );
}

module.exports = { deltaScope, reviewRecord, packageSection, reviewerLine, short };
