// =============================================================
// logic/agents.js: the orchestrator's routine as script: reviewers, the state line and the short `show`.
//
// reviewersFor, reviewersForTask, reviewerTypes (lib/queueHelpers.js holds the reviewer rules), stateLine and
// summaryView. agentTypeFor, AGENT_MODELS, modelFor, modelPart and trackMessage are re-exported from the Claude
// adapter (lib/clients/claude/dispatch.js), where they moved in the client adapter split.
//
// Part of the queueLogic.js split: lib/queueLogic.js re-exports every name, so callers keep requiring queueLogic.js.
// Used by queueLogic.js (the facade) and by logic/results.js, merge.js.
// Tested in lib/__tests__/queueOrchestrator.test.ts, queueModels.test.ts and queueHelpers.test.ts (through
// queueLogic.js).
// =============================================================

const { cfg, WEIGHT, costLabel, ageText, isExternalRow, isBatched } = require('./base.js');
const { stepText } = require('./ranking.js');
const { budgetGuard, nightGuard, startGuard, loadSlotsFor } = require('./guards.js');
const { batchGroups } = require('./batch.js');
const { selectNext, state } = require('./select.js');
// The reviewers (fixed per class and the helper agents) are worked out in ONE place: lib/queueHelpers.js.
const HELP = require('../queueHelpers.js');
// The Claude facts (agent names, model list, the agent message) live in the Claude adapter; re-exported here so the
// queueLogic.js facade and its callers keep the names (lib/clients/claude/dispatch.js).
const { agentTypeFor, AGENT_MODELS, modelFor, modelPart, trackMessage } = require('../clients/claude/dispatch.js');

// ---- The orchestrator's routine as script and cost per task -----
//
// `show` (short by default), `fill`, `receive`, `set <id> done` and `cost` in queue.mjs. Here is only the pure part: the
// short view, agent type and agent message, the content of the review package, the parsers for the RESULT and FINDINGS lines, which
// agents in the time log belong to a task, and the sum of the cost. Git, the transcripts and the time log are read in queue.mjs.
// Tested in lib/__tests__/queueOrchestrator.test.ts.

/** The FIXED reviewers by class (config().reviewers): by default K and U none, D `reviewer`, D+ also `reviewer-security`. */
function reviewersFor(cls) {
  return HELP.fixedFor(cfg(), cls);
}

/**
 * All the reviewers for a task: the fixed ones for its class and the helpers that are on and hit (queueHelpers.js).
 * @returns {{ type: string, fixed: boolean, reasons: string[] }[]}
 */
function reviewersForTask(o, { queue = null, changedPaths = [], missionText = null, hashes = null, missingControls = [] } = {}) {
  return HELP.reviewersForTask(o, { config: cfg(), queue, changedPaths, missionText, hashes, missingControls });
}

/** All reviewer types (fixed and helpers, unique, in order): the agents that count toward a task. */
function reviewerTypes(queue = null) {
  return HELP.allReviewerTypes(cfg(), queue);
}

/** The summary line under `show` (same in the short and full view). `t` is queueLogic.state. */
function stateLine(t) {
  return (
    `${t.activeOnes} active · ${t.picked ? `${t.picked} picked · ` : ''}${t.waiting} waiting · ${t.proposed} proposed · ` +
    `${t.canStart} can start now` +
    `${t.batched ? ` · ${t.batched} in the batch queue (ravenseat batch)` : ''}` +
    `${t.qa ? ` · ${t.qa} in the QA list (ravenseat qa)` : ''}${t.external ? ` · ${t.external} outside the queue (ravenseat external)` : ''}` +
    `${t.parked ? ` · ${t.parked} parked (ravenseat continue)` : ''}` +
    `${t.focus?.notice ? ' · FOCUS WARNING (ravenseat focus)' : ''}` +
    `${t.empty ? (t.waiting ? ' · NOTHING CAN START (ravenseat show --full says why)' : ' · THE QUEUE IS OUT OF WORK') : ''}`
  );
}

const SUMMARY_STATUSES = ['running', 'review', 'picked'];
/** How many proposals the short view names; `ravenseat proposals` lists them all. */
const MAX_PROPOSALS_SHOWN = 5;

/**
 * `queue.mjs show` (short, the default for the orchestrator): one line per active task (running, review, picked) and per
 * task that can start now, then the counts. The target is below approx. 3,000 characters (the full table was approx. 66,000 characters,
 * approx. 20,000 tokens per call). The full one is behind `show --full`.
 * @param {object} queue the queue
 * `costEstimate` (o => { usd }, lib/costEstimate.js calibratedCost with a model) adds "~$x" to the startable lines, and
 * with `outlook` (lib/costEstimate.js budgetOutlook) a budget outlook line; passed in by queue.mjs, since costEstimate.js
 * itself requires this module.
 * @param {object} queue the queue
 * @param {{ now?: number, uncommitted?: string[], dailyUsage?: number, width?: number,
 *   costEstimate?: ((o: object) => { usd: number }) | null, outlook?: ((b: object, usd: number) => { message: string } | null) | null }} [option]
 * @returns {string[]} the lines
 */
function summaryView(
  queue,
  {
    now = Date.now(),
    uncommitted = [],
    dailyUsage,
    width = 110,
    cursor = null,
    load = null,
    costEstimate = null,
    outlook = null,
  } = {},
) {
  const tasks = queue.tasks ?? [];
  const cut = (s) => (s.length > width ? `${s.slice(0, width - 1)}…` : s);
  const out = [];

  const activeOnes = tasks.filter((o) => SUMMARY_STATUSES.includes(o.status) && !isExternalRow(o));
  out.push(`ACTIVE (${activeOnes.length}):`);
  for (const o of activeOnes) {
    // Age: in review since delivery, picked since picking, otherwise since start.
    const from =
      o.status === 'picked'
        ? o.picked_at
        : o.status === 'review'
          ? (o.delivered ?? o.started)
          : o.started;
    const age = from ? ageText(now - Date.parse(from)) : '?';
    const who = o.status === 'picked' ? ` by ${o.picked_by ?? '?'}` : '';
    out.push(
      cut(
        `  ${o.id.padEnd(12)} ${o.status.padEnd(7)} ${String(o.class).padEnd(2)} ${age.padEnd(10)} ` +
          `migr ${o.migr_block ?? '-'}${who}  ${o.title ?? ''}`,
      ),
    );
  }

  const guard = startGuard(queue, dailyUsage, { now, cursor, load });
  const startable = guard ? [] : selectNext(queue, now, { uncommitted, load });
  // Load-aware slots: say why fewer tracks start (only when the load limits them).
  const ls = load && !guard ? loadSlotsFor(queue, load) : null;
  if (ls?.limited) out.push(cut(`LOAD: ${ls.reason}. Fewer tracks start until the load goes down.`));
  out.push(
    `STARTABLE NOW (${startable.length}${startable.length ? '; ravenseat fill starts them' : ''}):`,
  );
  for (const v of startable) {
    const o = tasks.find((x) => x.id === v.id);
    out.push(
      cut(
        `  ${v.id.padEnd(12)} ${v.class.padEnd(2)} ${String(v.domain).padEnd(12)} ${`${v.estimate} min`.padEnd(8)} ` +
          (costEstimate ? `${costLabel(costEstimate(o)).padEnd(6)} ` : '') +
          `prio ${v.score}${'step' in v ? ` ${stepText(v)}` : ''}  ${o?.title ?? ''}`,
      ),
    );
  }
  if (guard) out.push(cut(`  ${guard.message}`));

  const t = state(queue, dailyUsage, { uncommitted, now, cursor, load });
  // The focus line and the warning (only when a focus is set).
  if (t.focus) {
    out.push(cut(`FOCUS${t.focus.name ? ` "${t.focus.name}"` : ''}: ${t.focus.text}`));
    if (t.focus.active)
      out.push(
        cut(
          `  ${t.focus.readyOnes} ready in focus · ${t.focus.in_focus} waiting in focus · ${t.focus.inProgress} in progress · ` +
            `${t.focus.dragged_with} pulled along`,
        ),
      );
    if (t.focus.notice) out.push(cut(`  ${t.focus.notice}`));
  }
  const waiting = tasks.filter((o) => o.status === 'waiting' && !isBatched(o));
  const perClass = Object.keys(WEIGHT)
    .map((k) => [k, waiting.filter((o) => o.class === k).length])
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} ${n}`)
    .join(' · ');
  out.push('', stateLine(t));
  if (waiting.length)
    out.push(
      `Waiting per class: ${perClass}; ${t.blocked.length} of them are blocked now (see show --full).`,
    );
  // Proposals by name: a count alone does not tell the owner that something new came in.
  const proposals = tasks.filter((o) => o.status === 'proposed' && !isBatched(o));
  if (proposals.length) {
    out.push(`PROPOSED (${proposals.length}; ravenseat approve <id> lets one start):`);
    for (const o of proposals.slice(0, MAX_PROPOSALS_SHOWN))
      out.push(cut(`  ${o.id.padEnd(12)} ${o.added_by ? `from ${o.added_by}  ` : ''}${o.title ?? ''}`));
    if (proposals.length > MAX_PROPOSALS_SHOWN)
      out.push(`  ... and ${proposals.length - MAX_PROPOSALS_SHOWN} more (ravenseat proposals)`);
  }
  const batch = batchGroups(queue);
  if (batch.length) {
    const n = batch.reduce((s, g) => s + g.count, 0);
    const readyOnes = batch.filter((g) => g.ready).length;
    out.push(
      `BATCH_QUEUE (${n} task(s) in ${batch.length} group(s)${readyOnes ? `, ${readyOnes} ready for packing` : ''}; ` +
        'ravenseat batch)',
    );
  }
  if (t.ownerQuestion.length)
    out.push(
      cut(
        `Owner questions that unlock the most: ${t.ownerQuestion
          .slice(0, 5)
          .map((s) => `${s.sp} (${s.tasks})`)
          .join(' · ')}`,
      ),
    );
  if (!guard) {
    const b = budgetGuard(queue, dailyUsage);
    if (b.active && b.message) out.push(cut(b.message));
    // The calibrated estimate of what can start now against what is left of the budget (information only).
    if (b.active && outlook && costEstimate) {
      const sum = startable.reduce((s, v) => s + (costEstimate(tasks.find((x) => x.id === v.id))?.usd ?? 0), 0);
      const line = outlook(b, sum)?.message;
      if (line) out.push(cut(line));
    }
    const n = nightGuard(queue, now);
    if (n.active && n.message) out.push(cut(n.message));
  }
  out.push('Full list: ravenseat show --full (or --all, --grouped, --project <pid>).');
  return out;
}

module.exports = {
  agentTypeFor,
  AGENT_MODELS,
  modelFor,
  modelPart,
  reviewersFor,
  reviewersForTask,
  reviewerTypes,
  trackMessage,
  stateLine,
  summaryView,
};
