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
// unpushed work, the base health of the tip (base-health.json, the base gate), the full gate on the tip (the gate
// evidence store, lib/gateEvidence.js: a green, clean `cq gates --full` run in the main checkout on exactly that commit)
// and a verdict line: READY, NOT YET (n of minTasks), BLOCKED (base red, no green full gate on the tip while gates.full
// is set up, external commits, or the remote is ahead), LARGE (over warnTasks: push recommended)
// or NOTHING. In push mode "threshold" the orchestrator may push on READY or LARGE by itself, never on BLOCKED; in mode
// "owner" (the default) only on the owner's word. The verdict does not change the exit code.
//
// Read only: it never pushes, does not fetch and does not rewrite history (--watch-ci, the CI watch, is the exception
// that writes: the fix task or the owner question, and the base health).
//
// Use: node scripts/orchestrator/push-check.mjs [--from <remote>/<baseBranch>] [--to <baseBranch>] [--json]
//      node scripts/orchestrator/push-check.mjs --watch-ci <sha> [--interval <sec>] [--timeout <min>]
// --watch-ci is the optional CI watch after a batch push (config().push.ciWatch, off by default; cli/ciWatch.mjs):
// started in the background, it exits 0 green or infrastructure (an owner question), 9 on a failed check (the fix task
// CI-<sha7>, the base red), 10 on timeout. When it is on, the verdict below names the command to start.
// In push mode "owner" commits outside the queue are one neutral line and exit 0: nothing goes out before the owner's word.
// Exit: 0 = no external commits (or nothing to push); in mode threshold 2 = external commits (the list, and a safe cut point when one
// exists), or the git hooks and config differ from the accepted baseline (lib/gitSurfaceBaseline.js: said first, before
// any other git command, because `git status` below can start a planted core.fsmonitor); 1 = error (e.g. unknown ref).
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
const GE = require('./lib/gateEvidence.js');
// queue.config.json exists but does not parse: stop (H3); the default base branch and remote may be the wrong ones.
require('./lib/queueConfig.js').stopIfConfigUnreadable();
const CW = require('./lib/ciWatch.js');

if (process.argv.includes('--watch-ci')) {
  // The CI watch is its own flow (it writes the queue); the read-only push check below does not run.
  // It ends with process.exit; the line after it only guards a module that returns.
  await import('./cli/ciWatch.mjs');
  process.exit(process.exitCode ?? 0);
}

const K = config();
const CI = CW.ciWatchSetup(K);
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

// What runs at the next git command, against what was accepted. The push itself would run a planted pre-push hook. Read
// only: no baseline yet means nothing to compare (cq fill, start, resume, receive and merge record it).
const GB = require('./lib/gitSurfaceBaseline.js');
const surfaceDrift = GB.stopDetail(dataFolder(), process.env.QUEUE_GIT ?? K.root, { cq: require('./lib/projectRoot.js').cqCommand() });
if (surfaceDrift) {
  const message = GB.driftMessage({ ...surfaceDrift, cq: require('./lib/projectRoot.js').cqCommand() });
  console.log(AS_JSON ? JSON.stringify({ surface_drift: surfaceDrift.reason, message }, null, 2) : message);
  process.exit(2);
}

const sha = (ref) =>
  String(git(['rev-parse', '-q', '--verify', `${ref}^{commit}`]) ?? '').trim() || null;

const fromSha = sha(FROM);
const toSha = sha(TO);
// Before the first push there is no remote branch to compare with, and that is normal, not a failure.
if (!fromSha && toSha && val('--from') == null) {
  const hasRemote = String(git(['remote']) ?? '').split(/\r?\n/).includes(K.remote);
  const next = hasRemote
    ? `Next: git push -u ${K.remote} ${K.baseBranch} (when the owner says push). The check has something to compare with after that.`
    : `Next: add the remote (git remote add ${K.remote} <url>), then git push -u ${K.remote} ${K.baseBranch} when the owner says push.`;
  const message = `push-check: nothing to compare with yet: ${FROM} does not exist, which is normal before the first push. ${next}`;
  console.log(AS_JSON ? JSON.stringify({ first_push: true, message }, null, 2) : message);
  process.exit(0);
}
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
// The full gate on exactly the tip, from the trusted gate evidence (lib/gateEvidence.js: the orchestrator's own runs,
// never a track's rows in the time log). 'off' when gates.full has no commands.
const fullGate = GE.fullGateVerdict({ folder: dataFolder(), sha: toSha, cfg: K });
const blocked = PB.blockedTexts({ external: plan.externalOnes.length, behind: back, from: FROM, to: TO, mode: SETUP.mode });
const verdict = PB.batchVerdict({ batch, setup: SETUP, health, fullGate, blocked });
// No CI config or no gates (lib/controls.js): said here too, since the orchestrator reads this before a push.
const missingControls = require('./lib/controls.js').missing(K, K.root);

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
          full_gate: fullGate,
          verdict: verdict.verdict,
          reason: verdict.reason,
        },
        controls_missing: missingControls,
        ci_watch: CI.enabled ? { mode: CI.mode, command: `cq push-check --watch-ci ${toSha}` } : null,
      },
      null,
      2,
    ),
  );
} else {
  console.log(textReport().join('\n'));
}
// exitCode (not process.exit), so the output in a pipe is always written in full.
process.exitCode = plan.externalOnes.length && SETUP.mode !== 'owner' ? 2 : 0;

function textReport() {
  const out = [];
  out.push(
    `Push-check ${FROM} (${summary(fromSha)})..${TO} (${summary(toSha)}): ${plan.total} commit(s) on the first-parent line ` +
      `(${total} in total): ${plan.queue} from the queue, ${plan.orchestrator} from the orchestrator, ${plan.externalOnes.length} outside the queue.`,
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
  else if (SETUP.mode === 'owner')
    out.push(
      `${plan.externalOnes.length} commit(s) outside the queue go along with the next push (cq external lists them).` +
        (plan.cutPoint ? ` To leave them out: git push ${K.remote} ${plan.cutPoint}:${K.baseBranch}` : '') +
        ' Push only when the owner has said "push".',
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
  const gateText = { green: 'GREEN', red: 'RED', missing: 'not run on this tip', off: 'not set up' }[fullGate];
  const limits =
    `mode ${SETUP.mode}, minTasks ${SETUP.minTasks}, warnTasks ${SETUP.warnTasks}` +
    (SETUP.maxAgeHours != null ? `, maxAgeHours ${SETUP.maxAgeHours}` : '');
  return [
    `Batch: ${batch.taskCount} merged task(s) / ${batch.commits} commit(s) unpushed` +
      (batch.oldestAt ? `, oldest ${PB.ageText(batch.oldestAt)} old` : '') +
      `; base ${healthText}, full gate ${gateText} at ${summary(toSha)} (${limits}).`,
    `Verdict: ${PB.verdictWord(verdict.verdict)} (${verdict.reason}).`,
    ...(missingControls.length && K.push?.controlsWarning !== false && !require('./lib/guidance.js').readQuiet(dataFolder())
      ? [`Controls: ${missingControls.join(', ')}, so nothing automatic checks this push (/cq:kickstart).`]
      : []),
    ...(CI.enabled
      ? [`CI watch (${CI.mode}): after the push, start cq push-check --watch-ci ${toSha} in the background (run_in_background); exit 9 = a check failed (fix task CI-${toSha.slice(0, 7)}), 0 = green or an owner question, 10 = timeout.`]
      : []),
  ];
}
