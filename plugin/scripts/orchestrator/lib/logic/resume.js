// =============================================================
// logic/resume.js: adoption: a new orchestrator session adopts tracks that are running.
//
// deliverySignal, trackFolderRound, findTrackReport, deliveryBase, assessDelivery, assessActive, deliveryLines,
// resumeBlock and resumePromptAdjust.
//
// Part of the queueLogic.js split: lib/queueLogic.js re-exports every name, so callers keep requiring queueLogic.js.
// Used by queueLogic.js (the facade) only.
// Tested in __tests__/queueAdopt.test.ts (through queueLogic.js).
// =============================================================

const { baseBranch, branchPrefix, ageText } = require('./base.js');
const { parseResult } = require('./results.js');

// ---- Adoption: a new orchestrator session adopts tracks that are running ----------------------------------------
//
// The only thing that ties a track to the session that started it is the <task-notification> when the track delivers.
// These functions make the delivery visible without the notification:
//   - report.md in the track folder (<scratchpad>/<id>/, or the fix round <scratchpad>/<id>-r<N>/) is a SAFE delivery
//     signal when its first line is the RESULT line (status DONE or PARTIAL);
//   - `queue.mjs orchestrator pulse` and `queue.mjs deliveries` report reports that came after the start or the last receive;
//   - `queue.mjs resume <id>` makes the mission for a NEW agent on the same branch (fix round or continuation).
// The fields on the task (all optional): report_received (mtime in ms of the report `receive` read) and report_seen
// (mtime in ms of the newest report a pulse has reported), so the same report is only reported as new once.
// findTrackReport is the one function here that touches the file system: it only reads, and fs/path can be swapped in tests.

/** The reasons `resume` accepts: a fix round after review, or a continuation after the context guard (PARTIAL). */
const RESUME_REASONS = ['fix', 'context'];

/**
 * Safe delivery signal: the first non-empty line of report.md is `RESULT status=DONE|PARTIAL …` (markdown decoration
 * such as `#` and backticks is tolerated, as in parseResult). Otherwise null: a report that is half written or lacks the
 * line is not a delivery (then the heuristic in assessActive applies).
 * @returns {null | { status: 'DONE' | 'PARTIAL', line: string }}
 */
function deliverySignal(text) {
  const first = String(text ?? '')
    .split(/\r?\n/)
    .find((l) => l.trim() !== '');
  if (!first) return null;
  const r = parseResult(first);
  if (!r || !['DONE', 'PARTIAL'].includes(r.status)) return null;
  return { status: r.status, line: r.line };
}

/** The round a scratchpad folder belongs to: `<id>` is 0, `<id>-r<N>` is N, anything else null. */
function trackFolderRound(name, id) {
  const n = String(name ?? '');
  if (n === id) return 0;
  const prefix = `${id}-r`;
  if (!n.startsWith(prefix)) return null;
  const rest = n.slice(prefix.length);
  return /^\d+$/.test(rest) ? Number(rest) : null;
}

/**
 * Looks in the scratchpad roots (the orchestrator's own and the one saved on the task, o.scratchpad) for the track's
 * folders `<id>` and `<id>-r<N>`, and for the fix round prompts `prompt-<id>-r<N>.md`. Gives the newest report.md, the
 * newest handover.md and the next free round number. Only reads; `fsx` and `pathx` can be swapped in tests.
 * @returns {{ report: null | { path: string, folder: string, round: number, mtimeMs: number, text: string },
 *   handover: null | { path: string, mtimeMs: number }, nextRound: number }}
 */
function findTrackReport(id, roots, fsx = require('node:fs'), pathx = require('node:path')) {
  let report = null;
  let handover = null;
  let maxRound = 0;
  const seen = new Set();
  for (const root of roots ?? []) {
    if (!root) continue;
    const r = pathx.resolve(root);
    if (seen.has(r.toLowerCase())) continue;
    seen.add(r.toLowerCase());
    let names = [];
    try {
      names = fsx.readdirSync(r);
    } catch {
      continue; // the root does not exist (e.g. an old session's scratchpad that has been cleaned up)
    }
    for (const n of names) {
      const prompt = /^prompt-(.+)\.md$/.exec(n);
      const promptRound = prompt ? trackFolderRound(prompt[1], id) : null;
      if (promptRound != null) maxRound = Math.max(maxRound, promptRound);
      const round = trackFolderRound(n, id);
      if (round == null) continue;
      maxRound = Math.max(maxRound, round);
      const folder = pathx.join(r, n);
      for (const file of ['report.md', 'handover.md']) {
        const filePath = pathx.join(folder, file);
        let mtimeMs;
        try {
          const st = fsx.statSync(filePath);
          if (!st.isFile()) continue;
          mtimeMs = st.mtimeMs;
        } catch {
          continue;
        }
        if (file === 'handover.md') {
          if (!handover || mtimeMs > handover.mtimeMs) handover = { path: filePath, mtimeMs };
        } else if (!report || mtimeMs > report.mtimeMs) {
          let text;
          try {
            text = fsx.readFileSync(filePath, 'utf8');
          } catch {
            continue; // file lock while the track writes: the next pulse takes it
          }
          report = { path: filePath, folder, round, mtimeMs, text };
        }
      }
    }
  }
  return { report, handover, nextRound: maxRound + 1 };
}

/** The baseline for a new delivery: the start, the delivery to review or the last receive, whichever is latest (ms). */
function deliveryBase(o) {
  const t = [
    Date.parse(o?.started ?? ''),
    Date.parse(o?.delivered ?? ''),
    Number(o?.report_received ?? Number.NaN),
  ].filter(Number.isFinite);
  return t.length ? Math.max(...t) : 0;
}

/**
 * Is the report a delivery that has not been received? Requires the delivery signal and that the report is newer than
 * deliveryBase (a report from before the start, or the one `receive` has already read, does not count). `new` is true
 * when no pulse has reported exactly this report before (o.report_seen).
 * @param {object} o the task
 * @param {null | { path: string, mtimeMs: number, text: string }} report from findTrackReport
 */
function assessDelivery(o, report) {
  if (!o || !report) return null;
  const sig = deliverySignal(report.text);
  if (!sig) return null;
  if (!(report.mtimeMs > deliveryBase(o))) return null;
  return {
    id: o.id,
    taskStatus: o.status,
    status: sig.status,
    line: sig.line,
    path: report.path,
    mtimeMs: report.mtimeMs,
    new: report.mtimeMs > Number(o.report_seen ?? 0),
  };
}

/**
 * The classification in queue-takeover.mjs for an active task. The safe signal (a delivery from assessDelivery) goes
 * first; the heuristic is the fallback:
 *   DELIVERED: commits ahead of baseBranch, a clean worktree, and no new commit in 20 min (the agent has finished).
 *   EMPTY: no commits and started over an hour ago (the agent died before it did anything). `anotherBranch` is only
 *          called then (git log --all is expensive) and gives a commit on another branch that mentions the id, or null.
 */
function assessActive({
  status,
  commits = 0,
  uncommitted = null,
  lastMs = null,
  startedMs = null,
  delivery = null,
  anotherBranch = () => null,
}) {
  if (delivery)
    return `DELIVERED (report.md ${delivery.status}${status === 'review' ? ', new round after receive' : ''})`;
  if (status === 'review') return commits > 0 ? 'DELIVERED (review)' : 'UNCERTAIN (review without commits)';
  if (commits > 0 && (uncommitted ?? 0) === 0 && (lastMs ?? 0) > 20 * 60_000) return 'DELIVERED';
  if (commits === 0 && (startedMs ?? 0) > 60 * 60_000) {
    const another = anotherBranch();
    return another ? `UNCERTAIN (commit ${another} mentions the id on another branch)` : 'EMPTY';
  }
  if ((uncommitted ?? 0) > 0) return 'UNCERTAIN (uncommitted in worktree)';
  return 'UNCERTAIN';
}

/** The lines pulse and `deliveries` print: one per new delivery (with the next command), and one summary line for the rest. */
function deliveryLines(deliveries, nowMs = Date.now()) {
  const cq = require('../projectRoot.js').cqCommand();
  const fresh = (deliveries ?? []).filter((l) => l.new);
  const old = (deliveries ?? []).filter((l) => !l.new);
  const out = fresh.map(
    (l) =>
      `NEW DELIVERY (report.md): ${l.id} ${l.status}, written ${ageText(nowMs - l.mtimeMs)} ago. ` +
      `Next: ${cq} receive ${l.id}`,
  );
  if (old.length)
    out.push(
      `Report waiting, not received: ${old.map((l) => `${l.id} (${l.status})`).join(', ')} (${cq} deliveries)`,
    );
  return out;
}

/**
 * The track block (make-mission.mjs format) for a NEW agent that continues a track on the same branch: a fix round after
 * review (`fix`) or a continuation after the context guard or PARTIAL (`context`). The track id is `<id>-r<round>`, so the
 * agent's folder becomes `<scratchpad>/<id>-r<round>/` (findTrackReport finds the report there). `original` is the
 * trackBlock text of the task (ownership, mission) and comes along as reference.
 */
function resumeBlock({
  o,
  round,
  reason,
  reportPath = null,
  handoverPath = null,
  reviewFolder = null,
  reviewFiles = [],
  findingsFile = null,
  original = '',
}) {
  const base = baseBranch();
  const trackId = `${o.id}-r${round}`;
  const branch = o.branch ?? `${branchPrefix()}${o.id}`;
  const block =
    o.migr_block ?? 'none (the track must not have migrations; if it needs them, ask the orchestrator)';
  const fix = reason === 'fix';
  const name = fix ? 'Fix round' : 'Continuation';
  const cq = require('../projectRoot.js').cqCommand();
  const read = [
    `1. \`git log --oneline ${base}..${branch}\` and \`git diff --stat ${base}...${branch}\` (what is done; do not redo it).`,
    reportPath
      ? `2. The track's last report: ${reportPath}`
      : '2. The track has no report: build the picture from the commits and the commit messages.',
    handoverPath
      ? `3. The handover (done, remaining, next command, open questions): ${handoverPath}`
      : `3. No handover.md${fix ? '' : ': continue from the report and the commits'}.`,
  ];
  if (reviewFolder)
    read.push(
      `4. The review package: ${reviewFolder} (00-package.md first)` +
        (reviewFiles.length ? `; the reviewers' files there: ${reviewFiles.join(', ')}` : ''),
    );
  if (findingsFile) read.push(`${reviewFolder ? 5 : 4}. The findings to fix: ${findingsFile}`);
  const work = fix
    ? [
        'Fix the review findings: HIGH, and MEDIUM that is not small and mechanical; LOW findings in the same files come along.',
        'Fix at the file:line the findings point to, and only in the files the track owns. A finding you disagree with:',
        'give the reason in the report instead of fixing it.',
      ]
    : [
        'Continue where the previous agent stopped (context guard): do "remaining" from the handover, with "next command"',
        'first. What is already committed is not redone.',
      ];
  return [
    `=====${trackId}=====`,
    `TITLE: TRACK ${trackId} (${name.toLowerCase()} ${round} for ${o.id}: ${o.title})`,
    `CLASS: ${o.class}`,
    `BLOCK: ${block}`,
    `BRANCH: ${branch}`,
    '',
    `## ${name} ${round} for ${o.id} (new agent on the same branch, adoption)`,
    '',
    `The branch ${branch} already has the track's commits. The first call is prepare-track WITH \`--continue\` (it is in the setup`,
    `above): the branch is taken over with \`git switch\` without reset, and its own commits are counted against ${base}. Never`,
    `run it without \`--continue\`: \`checkout -B ${branch} ${base}\` would reset the branch. If it refuses because the branch is`,
    'checked out in another worktree, stop and report the path (the orchestrator frees it).',
    '',
    'Read first (excerpts, not whole files):',
    ...read,
    '',
    ...work,
    '',
    `Report: write report.md in your own folder (\`<folder>\`, that is ${trackId}) with the RESULT line as the FIRST line;`,
    `it covers the whole track (branch=${branch}, commits = all on the branch ahead of ${base}). The orchestrator finds it there`,
    `(${cq} deliveries and ${cq} receive ${o.id}), also without a notification. Your answer starts with the same RESULT line.`,
    '',
    `## The original mission for ${o.id} (reference; ownership, gates and "Do NOT touch" still apply)`,
    '',
    String(original ?? '').trim(),
    '',
  ].join('\n');
}

/**
 * Adapts a prompt from make-mission.mjs to a continuation: the setup call gets `--continue`, and the git line says
 * `git switch` instead of `checkout -B` (the common protocol is written for a new track).
 * @returns {{ text: string, swapped: number }}
 */
function resumePromptAdjust(text, { trackId, branch, base = baseBranch() }) {
  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  let swapped = 0;
  let t = String(text ?? '').replace(
    new RegExp(`(prepare-track(?:\\.mjs)? ${esc(trackId)} --branch ${esc(branch)})(?! --continue)`, 'g'),
    (m) => {
      swapped++;
      return `${m} --continue`;
    },
  );
  t = t.replace(
    new RegExp(`\`prepare-track\` runs \`git checkout -B ${esc(branch)} ${esc(base)}\``, 'g'),
    () => {
      swapped++;
      return `\`prepare-track --continue\` runs \`git switch ${branch}\` (without reset)`;
    },
  );
  return { text: t, swapped };
}

module.exports = {
  RESUME_REASONS,
  deliverySignal,
  trackFolderRound,
  findTrackReport,
  deliveryBase,
  assessDelivery,
  assessActive,
  deliveryLines,
  resumeBlock,
  resumePromptAdjust,
};
