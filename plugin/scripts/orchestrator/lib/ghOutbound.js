// =============================================================
// ghOutbound.js: the one guard every GitHub write goes through (GH-3 issue comments, GH-4 the draft pull request, GH-5
// the draft release; plans/trailhead-gsd-skills-vurdering-2026-11-20.md sections 5, 6 and 7, and the outbound secret
// guard and empty-body guard rows of its section 1).
//
// Why: until now Ravenseat wrote nothing to GitHub. A comment, a pull request or a release is outbound, often public, and
// on a public repo it stays. Agent text in such a post can carry a secret or a private path, and a task title imported
// from an issue was written by anyone who can open an issue. So:
//   - a body is only ever a FIXED TEMPLATE built here (commentBody, prBody; lib/releaseNotes.js for the release notes),
//     never agent prose. The only free text in it is a task title, put in a code span with its backticks taken out, one
//     line and capped (safeTitle): in a code span GitHub renders no @mention, no link, no image and no #ref.
//   - check() scans the whole body and the title with the secret scan's rules (lib/secretScan.js matchLine, one line at a
//     time, the strict rules) and the redaction rules (lib/askBundle.js redact: JWT, Bearer, the project's own .env
//     values). A hit BLOCKS the write; the reason names the rule, never the text. A scan that throws blocks too (fails
//     closed). An empty body is refused (the empty-body guard: a write after a failed read must not blank anything).
//     A configured private path (privatePaths) or a home folder path blocks as well.
//   - only the main session writes: mainSessionRefusal is the refusal on a queue branch or in a linked worktree; the push
//     guard denies a queue agent every one of these commands anyway (it may only run the read-only queue commands).
//   - the owner sees one preview that lists exactly what will be posted (previewLines), and the post must match it
//     (previewHash): the command writes the preview to outbound-preview.json in the data folder, `--post` builds the
//     posts again and refuses when they differ. The approval dialog (lib/approvalAsk.js, rule outbound-github) reads the
//     same file for its summary (dialogSummary): the kind, the targets and whether the repo is public, never a body.
//
// The setups: issues.onPush off (default) | comment | close; push.pr off (default) | draft. Anything that sends data out
// is off by default; an unknown value reads as off.
//
// Pure apart from previewFile/readPreview/writePreview (one JSON file). Used by: cli/ghWrite.mjs, lib/approvalAsk.js,
// lib/releaseNotes.js. Tested in lib/__tests__/ghOutbound.test.ts and __tests__/redteam/ghWrite.test.ts.
// =============================================================
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const { renameWithRetry } = require('./stateFile.js');
const path = require('node:path');

/** The longest task title in a post (characters, before the code span). */
const TITLE_MAX = 120;
const SIGNATURE = 'Posted by Ravenseat';
// The preview's file name in the data folder, from the register (lib/store/families.js, family 'gh-outbound-preview').
const PREVIEW_FILE = require('./store/families.js').family('gh-outbound-preview').file;
/** A preview older than this is stale: `--post` asks for a new one. */
const PREVIEW_MAX_AGE_MS = 60 * 60_000;

const ON_PUSH = ['off', 'comment', 'close'];
const PR_MODES = ['off', 'draft'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** issues.onPush: off (default), comment or close. */
function onPushOf(cfg) {
  const v = isObject(cfg?.issues) ? cfg.issues.onPush : undefined;
  return ON_PUSH.includes(v) ? v : 'off';
}

/** push.pr: off (default) or draft. */
function prModeOf(cfg) {
  const v = isObject(cfg?.push) ? cfg.push.pr : undefined;
  return PR_MODES.includes(v) ? v : 'off';
}

/** The one batch branch of a day, in UTC: ravenseat/batch-2026-11-21. */
function batchBranch(now = new Date()) {
  return `ravenseat/batch-${new Date(now).toISOString().slice(0, 10)}`;
}

/** The refusal outside the main session, or null. */
function mainSessionRefusal({ queueBranch = null, inWorktree = false } = {}) {
  if (queueBranch) return `runs in the main session only, not on ${queueBranch}'s queue branch. Nothing posted.`;
  if (inWorktree) return 'runs in the main checkout only, not in a linked worktree. Nothing posted.';
  return null;
}

// ---- the templates ---------------------------------------------------------------------------------------------------

/** A task title as a code span: one line, no backticks, capped. Never empty. */
function safeTitle(title) {
  let t = String(title ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/`/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) t = '(no title)';
  if (t.length > TITLE_MAX) t = `${t.slice(0, TITLE_MAX - 3)}...`;
  return `\`${t}\``;
}

/** A task id as a code span, or `unknown` when it is not an id shape. */
function safeId(id) {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/.test(String(id ?? '')) ? `\`${id}\`` : '`unknown`';
}

const shaOf = (s) => (/^[0-9a-f]{7,64}$/i.test(String(s ?? '')) ? String(s).toLowerCase() : null);
const short = (s) => (shaOf(s) ? shaOf(s).slice(0, 7) : 'unknown');

/** The checks on a commit in words (lib/gateEvidence.js fullGateVerdict). */
function gateWords(fullGate) {
  return (
    {
      green: 'full gate green (a clean run Ravenseat recorded on this commit)',
      red: 'full gate red on this commit',
      missing: 'full gate not run on this commit',
      off: 'no full gate is set up',
    }[fullGate] ?? 'full gate unknown'
  );
}

/**
 * The comment on an issue after a push (GH-3). Fixed text: the task, the merge commit, the pushed tip and its checks.
 * @param {{ id: string, title: string, mergeCommit: string, tip: string, fullGate: string, action: 'comment'|'close' }} o
 */
function commentBody({ id, title, mergeCommit, tip, fullGate, action }) {
  const lines = [
    `Ravenseat: task ${safeId(id)} ${safeTitle(title)} is merged and pushed.`,
    '',
    `- Merge commit: ${shaOf(mergeCommit) ?? 'unknown'}`,
    `- Pushed tip: ${short(tip)}; checks: ${gateWords(fullGate)}`,
  ];
  if (action === 'close') lines.push('- Closed by Ravenseat, because issues.onPush is close in this project.');
  lines.push('', SIGNATURE);
  return lines.join('\n');
}

const healthWords = (h) => ({ green: 'base green', red: 'base RED', unknown: 'base not checked' })[h] ?? 'base not checked';

/**
 * The draft pull request body for a batch (GH-4). Door and blast radius only when a task carries them (MS-1,
 * lib/mergeDanger.js prFields), and a reviewer's door when it differs from the track's: shown, never resolved.
 * @param {{ tasks: { id: string, title: string, door?: string, blast?: string, reviewerDoor?: string }[], tip: string,
 *   base: string, fullGate: string, health: string, caveats: string[] }} o
 */
function prBody({ tasks, tip, base, fullGate, health, caveats = [] }) {
  const word = (v) => String(v ?? '').replace(/[^A-Za-z0-9 -]/g, '').trim().slice(0, 30);
  const list = (tasks ?? []).map((t) => {
    const extra = [
      t.door ? `door ${word(t.door)}` : null,
      t.blast ? `blast radius ${word(t.blast)}` : null,
      t.reviewerDoor ? `reviewer says door ${word(t.reviewerDoor)}` : null,
    ].filter(Boolean);
    return `- ${safeId(t.id)}: ${safeTitle(t.title)}${extra.length ? ` (${extra.join(', ')})` : ''}`;
  });
  const lines = [
    `A batch of ${list.length} merged task(s) from Ravenseat, for review before it reaches \`${String(base).replace(/`/g, '')}\`.`,
    '',
    'Tasks:',
    ...(list.length ? list : ['- none']),
    '',
    `Checks on ${short(tip)}: ${gateWords(fullGate)}; ${healthWords(health)}.`,
    '',
  ];
  const c = (caveats ?? []).map((x) => String(x).replace(/[\u0000-\u001f`]+/g, ' ').trim()).filter(Boolean);
  if (c.length) lines.push('Caveats:', ...c.map((x) => `- ${x}`));
  else lines.push('Caveats: none recorded.');
  lines.push('', 'A draft: nothing here merges by itself.', '', SIGNATURE);
  return lines.join('\n');
}

// ---- the guard -------------------------------------------------------------------------------------------------------

/** Home folders: a local path in a post says who and where. */
const HOME_PATH = /(?:\b[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s]+|(?:^|[\s(`'"])\/(?:home|Users)\/[^/\s]+)/;

/** The default scan: the rule ids one text hits (secret scan per line, then the redaction rules on the whole). */
function defaultScan(text) {
  const SS = require('./secretScan.js');
  const hits = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const r = SS.matchLine(line, '');
    if (r) hits.add(r);
  }
  const red = require('./askBundle.js').redact(String(text));
  for (const k of Object.keys(red.rules ?? {})) hits.add(k);
  return [...hits];
}

/** The private path entries (lib/privatePaths.js) as text to look for, without a trailing slash; short ones are left out. */
function privateNeedles(cfg) {
  try {
    return require('./privatePaths.js')
      .entries(cfg ?? {})
      .map((e) => String(e.path).replace(/\/+$/, ''))
      .filter((p) => p.length >= 3);
  } catch {
    return [];
  }
}

/**
 * The outbound check for one post. ok false = do not post; problems name the rule, never the text.
 * @param {{ body: unknown, title?: unknown, cfg?: object, scan?: (text: string) => string[] }} o
 * @returns {{ ok: boolean, problems: string[] }}
 */
function check({ body, title = null, cfg = {}, scan = defaultScan }) {
  const problems = [];
  const text = typeof body === 'string' ? body : '';
  if (!text.trim()) problems.push('the body is empty (an empty post is refused)');
  const all = [title == null ? '' : String(title), text].join('\n');
  try {
    const rules = scan(all);
    if (rules.length) problems.push(`a secret-looking value (${rules.join(', ')})`);
  } catch {
    problems.push('the text could not be scanned for secrets, so it is not posted');
  }
  const lower = all.replace(/\\/g, '/');
  const hit = privateNeedles(cfg).find((p) => lower.includes(p));
  if (hit) problems.push('a private path (privatePaths)');
  if (HOME_PATH.test(all)) problems.push('a local home folder path');
  return { ok: problems.length === 0, problems };
}

// ---- the preview -----------------------------------------------------------------------------------------------------

/** The visibility line: public and unknown are said, private is quiet. */
function visibilityLine(visibility, repo) {
  if (visibility === 'public') return `${repo} is a PUBLIC repo: anyone can read this, and it stays.`;
  if (visibility !== 'private') return `${repo} may be public (its visibility is unknown): treat this as public, and it stays.`;
  return null;
}

/**
 * The preview: what, where, and the exact text of each post.
 * @param {{ what: string, repo: string, visibility: string, items: { target: string, action: string, body: string, title?: string }[] }} o
 */
function previewLines({ what, repo, visibility, items }) {
  const out = [`GITHUB WRITE PREVIEW: ${items.length} ${what} to ${repo}. Exactly this would be posted:`];
  const v = visibilityLine(visibility, repo);
  if (v) out.push(v);
  for (const x of items) {
    out.push('', `--- ${x.action} ${x.target}${x.title ? `, title: ${x.title}` : ''}`);
    for (const l of String(x.body).split('\n')) out.push(`  | ${l}`);
  }
  return out;
}

/** The hash of exactly what would be posted (targets, actions, titles, bodies). */
function previewHash(items) {
  const h = crypto.createHash('sha256');
  for (const x of items ?? []) h.update(JSON.stringify([x.target, x.action, x.title ?? null, x.body]));
  return h.digest('hex');
}

/** The short summary for the approval dialog: kind, targets and visibility. Never a body. */
function dialogSummary({ kind, repo, visibility, items }) {
  const what = { 'issues-report': 'issue comments', pr: 'a draft pull request', release: 'a draft release' }[kind] ?? 'a write';
  const targets = (items ?? []).map((x) => String(x.target).replace(/[^\w./#:-]/g, '')).slice(0, 8);
  const more = (items ?? []).length > targets.length ? ` and ${(items ?? []).length - targets.length} more` : '';
  const vis = visibility === 'public' ? 'a PUBLIC repo (anyone can read it, and it stays)' : visibility === 'private' ? 'a private repo' : 'a repo that may be public';
  return `posts ${what} to ${String(repo).replace(/[^\w./-]/g, '')}, ${vis}: ${targets.join(', ')}${more}, as the preview listed.`;
}

const previewFile = (folder) => path.join(folder, PREVIEW_FILE);

/** The saved preview, or null (missing, broken). */
function readPreview(folder) {
  try {
    const x = JSON.parse(fs.readFileSync(previewFile(folder), 'utf8'));
    return isObject(x) && typeof x.hash === 'string' && Array.isArray(x.items) ? x : null;
  } catch {
    return null;
  }
}

/** Saves the preview (targets and hash only, never a body). */
function writePreview(folder, { kind, repo, visibility, items, now = Date.now() }) {
  fs.mkdirSync(folder, { recursive: true });
  const entry = {
    kind,
    repo,
    visibility,
    at: new Date(now).toISOString(),
    hash: previewHash(items),
    items: items.map((x) => ({ target: x.target, action: x.action })),
  };
  const file = previewFile(folder);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(entry, null, 2)}\n`);
  renameWithRetry(tmp, file);
  return entry;
}

/**
 * Does the saved preview match what would be posted now? A reason when not.
 * @returns {string|null}
 */
function previewMismatch(saved, { kind, items, now = Date.now() }) {
  if (!saved) return 'there is no preview to match; run the command without --post first and read what it lists';
  if (saved.kind !== kind) return 'the last preview was of another write; run the preview again';
  const at = Date.parse(saved.at);
  if (!Number.isFinite(at) || now - at > PREVIEW_MAX_AGE_MS) return 'the preview is over an hour old; run it again';
  if (saved.hash !== previewHash(items)) return 'what would be posted has changed since the preview; run the preview again and read it';
  return null;
}

module.exports = {
  TITLE_MAX,
  SIGNATURE,
  PREVIEW_FILE,
  ON_PUSH,
  PR_MODES,
  onPushOf,
  prModeOf,
  batchBranch,
  mainSessionRefusal,
  safeTitle,
  safeId,
  gateWords,
  commentBody,
  prBody,
  check,
  // Also the scan of an issue body before `issues import --with-body` stores it (lib/githubIssues.js bodyReference).
  defaultScan,
  previewLines,
  previewHash,
  dialogSummary,
  previewFile,
  readPreview,
  writePreview,
  previewMismatch,
};
