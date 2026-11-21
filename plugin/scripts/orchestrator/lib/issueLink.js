// =============================================================
// issueLink.js: the link from a task or a plan entry to its GitHub issue (GH-2 of
// plans/trailhead-gsd-skills-vurdering-2026-11-20.md, section 5 step 2).
//
// Why: many projects keep their backlog in GitHub issues. When a task came from an issue (`ravenseat issues import`,
// cli/issues.mjs) or the owner links one by hand (`--issue 12` on add and edit), the board card, the task panel,
// `ravenseat show` and the plan entry show "Issue #12" as a link, and the merge commit gets a local `Refs: #12`
// trailer. That is traceability without a sync: nothing is written to GitHub, and the trailer only becomes visible
// there when the owner pushes.
//
// The stored field is `issue: { repo: "owner/name", number: 12 }` and nothing else. The repo is taken from the origin
// remote when the link is set (originRepo), or named by the owner as owner/name#12. The link is always built here from
// that stored repo and number, never from a URL or any other text that came with the issue: issue text is written by
// anyone who can open an issue, and a link built from it could point anywhere.
//
// `Closes #12` is never written: a push to the default branch would then close the issue on GitHub, an outward
// action the owner did not ask for. issues.refsTrailer (default on) turns the Refs trailer off.
//
// Pure, no I/O. Used by: cli/issues.mjs, cli/tasks.mjs and cli/taskEdit.mjs (--issue), cli/view.mjs (show),
// cli/plans.mjs (plan show), lib/queueBoard.js (the card), lib/logic/validate.js and lib/queuePlan.js (the shape),
// merge-track.mjs (the trailer). Tested in lib/__tests__/issueLink.test.ts.
// =============================================================
'use strict';

const { parseRemote } = require('./repoVisibility.js');

/** owner/name as GitHub allows it: letters, digits, dot, dash and underscore, one slash. */
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const FIELDS = ['repo', 'number'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const goodNumber = (n) => Number.isInteger(n) && n > 0 && n < 1e9;
const goodRepo = (r) => typeof r === 'string' && REPO.test(r) && !r.split('/').some((p) => p === '.' || p === '..');

/** The problems with a stored `issue` value, as texts (empty when it is fine or absent). */
function issueErrors(v) {
  if (v == null) return [];
  if (!isObject(v)) return ['issue must be { repo: "owner/name", number } (set it with --issue 12)'];
  const out = [];
  for (const k of Object.keys(v)) if (!FIELDS.includes(k)) out.push(`issue: unknown field ${k} (allowed: ${FIELDS.join(', ')})`);
  if (!goodRepo(v.repo)) out.push('issue.repo must be owner/name');
  if (!goodNumber(v.number)) out.push('issue.number must be a whole number above 0');
  return out;
}

/** The view of a valid link: { repo, number, label, url }, or null (then nothing is drawn). */
function issueView(v) {
  if (v == null || issueErrors(v).length) return null;
  return { repo: v.repo, number: v.number, label: `Issue #${v.number}`, url: `https://github.com/${v.repo}/issues/${v.number}` };
}

/** owner/name of a GitHub remote URL, or null (no remote, another host). */
function originRepo(remoteUrl) {
  const r = parseRemote(remoteUrl);
  return r && r.host === 'github' ? `${r.owner}/${r.name}` : null;
}

/**
 * `--issue <value>`: 12 or #12 (the origin repo), owner/name#12, or none/null/"" to remove the link.
 * @returns {{ issue: { repo: string, number: number } | null, error: string|null }}
 */
function parseIssueArg(raw, origin) {
  const s = String(raw ?? '').trim();
  if (!s || s === 'none' || s === 'null') return { issue: null, error: null };
  const m = /^(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#?(\d+)$/.exec(s);
  if (!m) return { issue: null, error: `--issue takes 12, #12 or owner/name#12, not "${s.slice(0, 40)}"` };
  const number = Number(m[2]);
  if (!goodNumber(number)) return { issue: null, error: '--issue needs an issue number above 0' };
  const repo = m[1] ?? origin;
  if (!repo)
    return { issue: null, error: '--issue 12 takes the repo from the origin remote, and there is no GitHub origin here: write owner/name#12' };
  if (!goodRepo(repo)) return { issue: null, error: `--issue: ${repo} is not owner/name` };
  return { issue: { repo, number }, error: null };
}

/** Same issue (repo without regard to case, the same number)? */
function sameIssue(x, y) {
  if (!isObject(x) || !isObject(y)) return false;
  return String(x.repo).toLowerCase() === String(y.repo).toLowerCase() && x.number === y.number;
}

/** The trailer line: "Refs: #12" for the origin repo, "Refs: owner/name#12" for another. Null without a valid link. */
function refsLine(v, origin) {
  if (v == null || issueErrors(v).length) return null;
  const local = origin && String(origin).toLowerCase() === v.repo.toLowerCase();
  return `Refs: ${local ? '' : v.repo}#${v.number}`;
}

/** Is the Refs trailer on (issues.refsTrailer, default on)? */
const refsOn = (config) => config?.issues?.refsTrailer !== false;

/**
 * The commit message with the Refs trailer, added once. A message whose last paragraph is already a trailer block
 * (Key: value lines) gets it on a new line in that block; otherwise after a blank line.
 */
function withRefs(message, v, { originRepo: origin = null, config = {} } = {}) {
  const line = refsOn(config) ? refsLine(v, origin) : null;
  const text = String(message ?? '').replace(/\s+$/, '');
  if (!line) return text;
  const lines = text.split('\n');
  if (lines.includes(line)) return text;
  const para = text.split(/\n\s*\n/);
  const last = para.length > 1 ? para[para.length - 1] : '';
  const isTrailers = last && last.split('\n').every((l) => /^[A-Za-z][A-Za-z0-9-]*: \S/.test(l));
  return isTrailers ? `${text}\n${line}` : `${text}\n\n${line}`;
}

module.exports = { REPO, issueErrors, issueView, originRepo, parseIssueArg, sameIssue, refsLine, refsOn, withRefs };
