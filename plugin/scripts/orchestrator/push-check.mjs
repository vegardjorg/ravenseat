#!/usr/bin/env node
// =============================================================
// push-check.mjs: what goes into the next `git push <remote> <baseBranch>`? See docs/orchestration.md.
//
// Classifies <remote>/<baseBranch>..<baseBranch> (the first-parent line) as queue (merge of <branchPrefix><id>),
// orchestrator (the trailer "Queue: orchestrator") or external (other sessions, the owner, hotfixes). A push must never include
// anything the owner does not know about: the orchestrator runs this BEFORE every batch push and asks the owner on exit 2.
// The base branch and remote come from queue.config.json (config().baseBranch, config().remote).
//
// It also prints the batch status (lib/pushBatch.js, config().push): merged tasks and commits not pushed, the oldest
// unpushed work, the base health of the tip (base-health.json, the base gate) and a verdict line: READY, NOT YET
// (n of minTasks), BLOCKED (base red, external commits, or the remote is ahead), LARGE (over warnTasks: push recommended)
// or NOTHING. In push mode "threshold" the orchestrator may push on READY or LARGE by itself, never on BLOCKED; in mode
// "owner" (the default) only on the owner's word. The verdict does not change the exit code.
//
// Read only: it never pushes, does not fetch and does not rewrite history.
//
// Use: node scripts/orchestrator/push-check.mjs [--from <remote>/<baseBranch>] [--to <baseBranch>] [--json]
// Exit: 0 = no external commits (or nothing to push); 2 = external commits (the list, and a safe cut point when one
// exists); 1 = error (e.g. unknown ref).
// QUEUE_GIT overrides the repo (smoke test against a temporary repo), as in queue.mjs.
// =============================================================

import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const L = require('./lib/queueLogic.js');
const G = require('./lib/queueGit.js');
const { config, dataFolder } = require('./lib/queueConfig.js');
const PB = require('./lib/pushBatch.js');
const BH = require('./lib/baseHealth.js');

const K = config();
// Main tree (config().root): baseBranch and the uncommitted files that matter are there (also when the script runs from
// a worktree).
const git = G.makeGit(process.env.QUEUE_GIT ?? K.root);
const a = process.argv.slice(2);
const val = (name) => {
  const i = a.indexOf(name);
  return i >= 0 ? a[i + 1] : undefined;
};
const FROM = val('--from') ?? `${K.remote}/${K.baseBranch}`;
const TO = val('--to') ?? K.baseBranch;
const AS_JSON = a.includes('--json');

const sha = (ref) =>
  String(git(['rev-parse', '-q', '--verify', `${ref}^{commit}`]) ?? '').trim() || null;

const fromSha = sha(FROM);
const toSha = sha(TO);
if (!fromSha || !toSha) {
  console.error(
    `push-check: could not find ${!fromSha ? FROM : TO} (git rev-parse). Nothing was checked.`,
  );
  process.exit(1);
}

// Oldest first, as pushPlan wants them.
const raw = G.readFirstParents(git, { from: FROM, to: TO });
if (raw == null) {
  console.error(`push-check: could not read ${FROM}..${TO}.`);
  process.exit(1);
}
const commits = G.classify(git, raw, { from: FROM }).reverse();
const plan = L.pushPlan(commits);
const uncommitted = G.readUncommitted(git) ?? [];
const theTrack = uncommitted.filter((u) => !u.untracked);
const untracked = uncommitted.filter((u) => u.untracked);
// Commits not on the first-parent line but brought in by a merge (the queue branches' commits and what an external merge
// brings in), counted to show the whole scope.
const total = Number(String(git(['rev-list', '--count', `${FROM}..${TO}`]) ?? '0').trim()) || 0;
// If the remote branch has commits not in the local one (local ref after fetch), the push is rejected: say so.
const back = Number(String(git(['rev-list', '--count', `${TO}..${FROM}`]) ?? '0').trim()) || 0;

// The batch: merged tasks on the first-parent line (the queue merge commits), the commit count and the oldest work.
const SETUP = PB.pushSetup(K);
const batch = PB.summarize(
  raw.map((c) => ({ sha: c.sha, parents: c.parents, subject: c.subject, time: Date.parse(c.date) })),
  { prefix: K.branchPrefix, commits: total },
);
// The base health of the tip, as the base gate recorded it ('unknown' when the gate is off or has not checked this tip).
const health = BH.verdict(BH.readState(path.join(dataFolder(), 'base-health.json')), toSha);
const blocked = [
  ...(plan.externalOnes.length ? [`${plan.externalOnes.length} external commit(s): ask the owner first`] : []),
  ...(back ? [`${FROM} has ${back} commit(s) not in ${TO}`] : []),
];
const verdict = PB.batchVerdict({ batch, setup: SETUP, health, blocked });

const summary = (s) => String(s).slice(0, 8);
const fileText = (files, max = 6) =>
  files.length
    ? `${files.slice(0, max).join(', ')}${files.length > max ? ` (+${files.length - max})` : ''}`
    : '(no files)';

if (AS_JSON) {
  console.log(
    JSON.stringify(
      {
        from: FROM,
        from_sha: fromSha,
        to: TO,
        to_sha: toSha,
        commits_total: total,
        back_origin: back,
        first_parent: plan.total,
        queue: plan.queue,
        orchestrator: plan.orchestrator,
        externalOnes: plan.externalOnes.map((c) => ({
          sha: c.sha,
          subject: c.subject,
          date: c.date,
          files: c.files,
          side: c.side.map((s) => ({ sha: s.sha, subject: s.subject, source: s.source })),
        })),
        cutPoint: plan.cutPoint,
        merged: plan.merged,
        uncommitted: theTrack.map((u) => `${u.xy} ${u.path}`),
        untracked: untracked.length,
        batch: {
          mode: SETUP.mode,
          minTasks: SETUP.minTasks,
          warnTasks: SETUP.warnTasks,
          maxAgeHours: SETUP.maxAgeHours,
          tasks: batch.tasks,
          task_count: batch.taskCount,
          commits: batch.commits,
          oldest_at: batch.oldestAt,
          base_health: health,
          verdict: verdict.verdict,
          reason: verdict.reason,
        },
      },
      null,
      2,
    ),
  );
} else {
  console.log(textReport().join('\n'));
}
// exitCode (not process.exit), so the output in a pipe is always written in full.
process.exitCode = plan.externalOnes.length ? 2 : 0;

function textReport() {
  const out = [];
  out.push(
    `Push-check ${FROM} (${summary(fromSha)})..${TO} (${summary(toSha)}): ${plan.total} commit(s) on the first-parent line ` +
      `(${total} in total): ${plan.queue} from the queue, ${plan.orchestrator} from the orchestrator, ${plan.externalOnes.length} external.`,
  );
  if (back)
    out.push(
      `NB: ${FROM} has ${back} commit(s) not in ${TO}; the push will be rejected until they are merged in (do not rewrite).`,
    );
  if (!plan.total) out.push('Nothing to push.');
  else if (!plan.externalOnes.length)
    out.push(
      SETUP.mode === 'threshold'
        ? 'No external commits: everything belongs to the queue and the orchestrator. Push mode threshold: push when the verdict below is READY or LARGE, never BLOCKED.'
        : 'No external commits: everything belongs to the queue and the orchestrator. Push only when the owner has said "push".',
    );
  else {
    out.push('');
    out.push('EXTERNAL COMMITS (not from the queue and without the trailer "Queue: orchestrator"), oldest first:');
    for (const c of plan.externalOnes) {
      out.push(`  ${summary(c.sha)}  ${c.date.slice(0, 16).replace('T', ' ')}  ${c.subject}`);
      out.push(`            files: ${fileText(c.files)}`);
      const side = c.side.filter((s) => s.source === 'external');
      if (side.length)
        out.push(
          `            merge that brings in ${side.length} commit(s): ${side
            .slice(0, 3)
            .map((s) => `${summary(s.sha)} "${s.subject.slice(0, 50)}"`)
            .join(', ')}${side.length > 3 ? ' …' : ''}`,
        );
    }
    out.push('');
    if (plan.cutPoint) {
      out.push(`safe cut point: ${summary(plan.cutPoint)} (${plan.cutPoint})`);
      out.push(
        `  All external commits come after the cut point. The queue's part (${plan.ownForCut} commit(s) on the first-parent line) can ` +
          `be pushed alone with: git push ${K.remote} ${plan.cutPoint}:${K.baseBranch}`,
      );
    } else if (plan.merged) {
      out.push(
        'No safe cut point: external commits are merged in between the queue commits, and cannot be held back without rewriting.',
      );
      out.push('  History is never rewritten. The choices are to include everything or to wait.');
    } else {
      out.push(
        'No safe cut point: everything not pushed is external (the queue has nothing to push alone).',
      );
    }
    out.push('');
    out.push(
      'Ask the owner before pushing (AskUserQuestion): "Include everything" / "Push only the queue part" (only with a cut point) / "Wait".',
    );
  }
  out.push('');
  out.push(...batchLines());
  if (theTrack.length || untracked.length) {
    out.push('');
    out.push(
      `Info: uncommitted in ${TO === K.baseBranch ? 'mainTree' : 'repo'} (not pushed): ${theTrack.length} changed, ${untracked.length} untracked.`,
    );
    for (const u of theTrack.slice(0, 10)) out.push(`  ${u.xy} ${u.path}`);
    if (theTrack.length > 10) out.push(`  … and ${theTrack.length - 10} more`);
  }
  return out;
}

/** The batch status and the verdict line (lib/pushBatch.js). */
function batchLines() {
  const healthText = { green: 'GREEN', red: 'RED', unknown: 'not checked at this tip' }[health];
  const limits =
    `mode ${SETUP.mode}, minTasks ${SETUP.minTasks}, warnTasks ${SETUP.warnTasks}` +
    (SETUP.maxAgeHours != null ? `, maxAgeHours ${SETUP.maxAgeHours}` : '');
  return [
    `Batch: ${batch.taskCount} merged task(s) / ${batch.commits} commit(s) unpushed` +
      (batch.oldestAt ? `, oldest ${PB.ageText(batch.oldestAt)} old` : '') +
      `; base ${healthText} at ${summary(toSha)} (${limits}).`,
    `Verdict: ${PB.verdictWord(verdict.verdict)} (${verdict.reason}).`,
  ];
}
