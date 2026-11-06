// =============================================================
// costEstimate.js: calibrated cost estimates per class (and class + size) and the honest cost figure, USD per merged
// change. See docs/queue.md ("Cost estimates and calibration").
//
// Pure functions without I/O. The data is what the queue already has:
//   - the measured cost of done tasks (cost.usd, saved at `set <id> done` and `cost measure`, queue.mjs measureTask),
//   - the static model queueLogic.estimateCost (fixed + content_min x factor per class, CALIBRATED),
//   - the usage events from the time log (timeCost.usageEvents, the same numbers as the budget guard).
//
// WHY: minute estimates are poor predictors (in a project with about 2,800 tasks the median actual/estimate ratio was
// K 0.33, D 1.62, D+ 2.33, U 0.40), while the median measured cost per class predicts the cost well. So the cost
// estimate is calibrated on measured cost, not derived from the minute estimate:
//   1. class + size bucket with at least `minSample` measured done tasks in the window: the bucket's median USD,
//   2. otherwise the class with at least `minSample`: the static model for the task x the class's median ratio
//      measured / model (keeps the size scaling of the model, corrects its level),
//   3. otherwise the static model alone (source "model").
// The minute estimate (queueLogic.estimate) and the priority are NOT changed here: they still order the queue.
//
// USD PER MERGED CHANGE: all measured cost in a window (every usage event in the time log: tracks, reviewers, helpers,
// fix rounds, cancelled and abandoned work and agents that belong to no task) divided by the queue tasks that reached
// done in the window. "USD per content minute" is misleading as a headline: raising the estimate (the denominator) makes
// work look cheaper without anything changing. It is kept only as a secondary, estimate-based figure.
//
// COST PER TASK, ALL RUNS (taskTotals): one row per root task with its first track, fix rounds, continuations,
// reviewers and the fix tasks that point to it (`fixes`, `qa_original`). USD per merged change counts those fix tasks
// with the change they fix, so a merged change costs what it took in total.
//
// Used by queue.mjs (show, next, fill, info, state, cost, calibrate), lib/queueCapacity.js (queue cost),
// lib/queueForecast.js (expected cost) and lib/queueStatistics.js (the board's Statistics tab).
// Tested in lib/__tests__/costEstimate.test.ts.
// =============================================================
'use strict';

const L = require('./queueLogic.js');
const TK = require('./timeCost.js');
const FX = require('./fixLinks.js');

/** The window (days back from now) the calibration uses, and the minimum sample before measured data is trusted. */
const WINDOW_DAYS = 28;
const MIN_SAMPLE = 5;
/** Size buckets on content_min (default 30, as queueLogic.estimate): S up to 30, M up to 60, L above. */
const SIZE_BUCKETS = [
  { name: 'S', max: 30 },
  { name: 'M', max: 60 },
  { name: 'L', max: Infinity },
];
const CLASSES = Object.keys(L.WEIGHT);
const DAY_MS = 86_400_000;

const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;

/** Median of the numbers (null for an empty list). */
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** The content minutes of a task (the same default as queueLogic.estimate). */
const contentMin = (o) => {
  const n = Number(o?.content_min ?? 30);
  return Number.isFinite(n) ? n : 30;
};

/** The size bucket name (S, M, L) for a task. */
function sizeBucket(o) {
  const c = contentMin(o);
  return SIZE_BUCKETS.find((b) => c <= b.max).name;
}

/** Minutes between two ISO times; null when either is missing or the order is impossible. */
function minutesBetween(from, to) {
  const a = Date.parse(from ?? '');
  const b = Date.parse(to ?? '');
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return (b - a) / 60_000;
}

/**
 * The done tasks the calibration learns from: status done, a done time inside [now - windowDays, now], a known class,
 * not an entry outside the queue. `usd` is the measured cost (null when not measured), `model` the static estimate,
 * `minutes` the cycle time started -> done (null without a start), `estimate` the minute estimate.
 */
function samples(queue, { now = Date.now(), windowDays = WINDOW_DAYS } = {}) {
  const from = now - windowDays * DAY_MS;
  const out = [];
  for (const o of queue?.tasks ?? []) {
    if (o.status !== 'done' || L.isExternalRow(o) || !CLASSES.includes(o.class)) continue;
    const t = Date.parse(o.done ?? '');
    if (!Number.isFinite(t) || t < from || t > now) continue;
    const usd = Number(o.cost?.usd);
    out.push({
      id: o.id,
      class: o.class,
      size: sizeBucket(o),
      usd: o.cost && Number.isFinite(usd) && usd > 0 ? usd : null,
      model: L.estimateCost(o),
      minutes: minutesBetween(o.started, o.done),
      estimate: L.estimate(o),
    });
  }
  return out;
}

/**
 * The calibrated cost model: per class and per class + size bucket, from the measured done tasks in the window.
 * @returns {{ windowDays: number, minSample: number, classes: Record<string, { n: number, median_usd: number|null,
 *   factor: number|null, measured: boolean }>, buckets: Record<string, { n: number, median_usd: number|null,
 *   measured: boolean }> }}
 *   factor = median of measured / model for the class (null below minSample); buckets are keyed "K/S", "D/M", ...
 */
function costModel(queue, { now = Date.now(), windowDays = WINDOW_DAYS, minSample = MIN_SAMPLE } = {}) {
  const measured = samples(queue, { now, windowDays }).filter((s) => s.usd != null);
  const classes = {};
  const buckets = {};
  for (const cls of CLASSES) {
    const r = measured.filter((s) => s.class === cls);
    const enough = r.length >= minSample;
    classes[cls] = {
      n: r.length,
      median_usd: r.length ? round2(median(r.map((s) => s.usd))) : null,
      factor: enough ? round2(median(r.map((s) => s.usd / s.model))) : null,
      measured: enough,
    };
    for (const b of SIZE_BUCKETS) {
      const rb = r.filter((s) => s.size === b.name);
      if (!rb.length) continue;
      buckets[`${cls}/${b.name}`] = {
        n: rb.length,
        median_usd: round2(median(rb.map((s) => s.usd))),
        measured: rb.length >= minSample,
      };
    }
  }
  return { windowDays, minSample, classes, buckets };
}

/**
 * The calibrated cost estimate for one task (see the rule order at the top).
 * @returns {{ usd: number, source: 'measured'|'model', basis: 'class+size'|'class'|'model', n: number }}
 *   n = the sample the number rests on (0 for the model).
 */
function calibratedCost(o, model) {
  const fallback = { usd: L.estimateCost(o), source: 'model', basis: 'model', n: 0 };
  if (!model || !CLASSES.includes(o?.class)) return fallback;
  const b = model.buckets[`${o.class}/${sizeBucket(o)}`];
  if (b?.measured) return { usd: round1(b.median_usd), source: 'measured', basis: 'class+size', n: b.n };
  const k = model.classes[o.class];
  if (k?.measured)
    return { usd: round1(L.estimateCost(o) * k.factor), source: 'measured', basis: 'class', n: k.n };
  return fallback;
}

/** "~$2.4" for a calibrated estimate (the CLI's short form next to the minute estimate; queueLogic.costLabel). */
const costText = (c) => L.costLabel(c);

/**
 * The calibration view (`ravenseat calibrate`): per class the sample, the median actual/estimate ratio for the minutes and
 * the suggested weight, the median measured USD, the model's median and the cost correction factor, and the basis new
 * tasks of the class get. Only classes with at least one done task in the window.
 * @returns {{ windowDays: number, minSample: number, rows: object[], buckets: object[] }}
 */
function calibration(queue, { now = Date.now(), windowDays = WINDOW_DAYS, minSample = MIN_SAMPLE } = {}) {
  const all = samples(queue, { now, windowDays });
  const model = costModel(queue, { now, windowDays, minSample });
  const rows = [];
  for (const cls of CLASSES) {
    const r = all.filter((s) => s.class === cls);
    if (!r.length) continue;
    const timed = r.filter((s) => s.minutes != null && s.estimate > 0);
    const ratio = timed.length ? median(timed.map((s) => s.minutes / s.estimate)) : null;
    const costed = r.filter((s) => s.usd != null);
    const k = model.classes[cls];
    rows.push({
      class: cls,
      n: r.length,
      n_time: timed.length,
      minutes_ratio: ratio == null ? null : round2(ratio),
      weight: L.WEIGHT[cls],
      suggested_weight: ratio == null ? null : round2(L.WEIGHT[cls] * ratio),
      n_cost: costed.length,
      median_usd: k.median_usd,
      model_median_usd: costed.length ? round2(median(costed.map((s) => s.model))) : null,
      cost_factor: costed.length ? round2(median(costed.map((s) => s.usd / s.model))) : null,
      basis: k.measured ? 'measured' : 'model',
    });
  }
  const buckets = Object.entries(model.buckets).map(([key, b]) => ({ key, ...b }));
  return { windowDays, minSample, rows, buckets };
}

/** The calibration as text lines for the CLI. */
function calibrationLines(c) {
  if (!c.rows.length)
    return [`No done tasks in the last ${c.windowDays} days; nothing to calibrate (ravenseat cost measure <id> for older ones).`];
  const out = [
    `Calibration, done tasks in the last ${c.windowDays} days (measured data is used from n >= ${c.minSample}):`,
    '  class  n    minutes actual/estimate  weight now -> suggested   median USD  model USD  cost factor  estimates from',
  ];
  const f = (x, d = 2) => (x == null ? '-' : Number(x).toFixed(d));
  for (const r of c.rows)
    out.push(
      `  ${r.class.padEnd(5)}  ${String(r.n).padEnd(3)}  ${`${f(r.minutes_ratio)} (n=${r.n_time})`.padEnd(23)}  ` +
        `${`${f(r.weight, 1)} -> ${f(r.suggested_weight)}`.padEnd(20)}  ${`$${f(r.median_usd)}`.padEnd(10)}  ` +
        `${`$${f(r.model_median_usd)}`.padEnd(9)}  ${`x${f(r.cost_factor)}`.padEnd(11)}  ` +
        (r.basis === 'measured' ? `measured (n=${r.n_cost})` : `model (n=${r.n_cost} < ${c.minSample})`),
    );
  const bucketed = c.buckets.filter((b) => b.measured);
  if (bucketed.length)
    out.push(
      `  Per class + size (S <= 30, M <= 60, L > 60 content min) with n >= ${c.minSample}: ` +
        bucketed.map((b) => `${b.key} $${f(b.median_usd)} (n=${b.n})`).join(', '),
    );
  out.push(
    '  The cost estimates (~$ in show, next, fill, info, state) already use this calibration. The suggested weight is',
    '  advice only: the weights order the queue and are not changed automatically.',
  );
  return out;
}

// ---- Cost per task, all runs ----------------------------------------------------------------------------
//
// A task's cost is spread over several runs: the first track, fix rounds and continuations (new agents on the same
// branch, logged as <id>-r<N>, timeCost.taskIdFor), the reviewers, and follow-up tasks of their own that fix it (the
// field `fixes`, lib/fixLinks.js, or `qa_original` on a QA fix task). The rollup sums all of it per ROOT task, the
// task nothing else claims to fix, so the cost of a change is the change plus everything it took to get it right.

/** The task a fix task belongs to: qa_original, otherwise the first id in `fixes` that is in the queue; null for none. */
function parentOf(o, byId) {
  if (typeof o?.qa_original === 'string' && o.qa_original !== o.id && byId.has(o.qa_original)) return o.qa_original;
  for (const id of FX.fixesList(o?.fixes) ?? []) if (id !== o.id && byId.has(id)) return id;
  return null;
}

/** The root of a task: follows parentOf up the chain (a cycle stops at the first task seen twice). */
function rootOf(o, byId) {
  const seen = new Set([o.id]);
  let x = o;
  for (;;) {
    const p = parentOf(x, byId);
    if (!p || seen.has(p)) return x;
    seen.add(p);
    x = byId.get(p);
  }
}

/** The sum of the four raw token kinds in a usage event's growth (timeCost.usageEvents). */
const eventTokens = (h) =>
  ['input', 'output', 'cache_read', 'cache_written'].reduce((s, k) => s + (Number(h?.tokens?.[k] ?? 0) || 0), 0);

/**
 * The cost per root task with all its runs. Per task, the measured cost saved at `set <id> done` (cost.usd, which
 * already holds the fix rounds, continuations and reviewers) wins; a task without it (open, cancelled, or done without
 * a measurement) gets its usage events from the time log instead, attributed by track label. Never both, so nothing is
 * counted twice. The tasks that fix a task are then added to its root.
 * @param {{ queue: object, events?: object[], since?: number|null }} input  since (ms): keep the roots with activity
 *   (a done time or a usage event of any task in the family) at or after it
 * @returns {{ id: string, title: string|null, class: string|null, status: string|null, done: string|null, usd: number,
 *   tokens: number, runs: number, tasks: number, children: string[], children_usd: number,
 *   source: 'measured'|'time-log'|'mixed', last: string|null }[]}  sorted by usd, highest first
 */
function taskTotals({ queue, events = [], since = null }) {
  const tasks = (queue?.tasks ?? []).filter((o) => !L.isExternalRow(o));
  const byId = new Map(tasks.map((o) => [o.id, o]));
  // The usage events per task id (fix rounds and continuations map to their task).
  const perTask = new Map();
  for (const h of events ?? []) {
    const id = h?.track ? TK.taskIdFor(h.track, (x) => byId.has(x)) : null;
    if (!id) continue;
    if (!perTask.has(id)) perTask.set(id, []);
    perTask.get(id).push(h);
  }
  const families = new Map();
  for (const o of tasks) {
    const evs = perTask.get(o.id) ?? [];
    let own;
    if (o.cost && Number.isFinite(Number(o.cost.usd)))
      own = {
        usd: Number(o.cost.usd),
        tokens: Number(o.cost.tokens?.sum ?? 0) || 0,
        runs: Array.isArray(o.cost.agents) ? o.cost.agents.length : 0,
        source: 'measured',
      };
    else if (evs.length)
      own = {
        usd: evs.reduce((s, h) => s + (Number(h.usd) || 0), 0),
        tokens: evs.reduce((s, h) => s + eventTokens(h), 0),
        runs: new Set(evs.map((h) => h.agent ?? h.track)).size,
        source: 'time-log',
      };
    else continue;
    const times = [o.done, ...evs.map((h) => h.time)].map((t) => Date.parse(t ?? '')).filter(Number.isFinite);
    const last = times.length ? Math.max(...times) : null;
    const root = rootOf(o, byId);
    const f = families.get(root.id) ?? {
      id: root.id,
      title: root.title ?? null,
      class: root.class ?? null,
      status: root.status ?? null,
      done: root.done ?? null,
      usd: 0,
      tokens: 0,
      runs: 0,
      tasks: 0,
      children: [],
      children_usd: 0,
      sources: new Set(),
      last: null,
    };
    f.usd += own.usd;
    f.tokens += own.tokens;
    f.runs += own.runs;
    f.tasks += 1;
    f.sources.add(own.source);
    if (o.id !== root.id) {
      f.children.push(o.id);
      f.children_usd += own.usd;
    }
    if (last != null && (f.last == null || last > f.last)) f.last = last;
    families.set(root.id, f);
  }
  return [...families.values()]
    .filter((f) => since == null || (f.last != null && f.last >= since))
    .map(({ sources, ...f }) => ({
      ...f,
      usd: round2(f.usd),
      children_usd: round2(f.children_usd),
      source: sources.size > 1 ? 'mixed' : [...sources][0],
      last: f.last == null ? null : new Date(f.last).toISOString(),
    }))
    .sort((x, y) => y.usd - x.usd || x.id.localeCompare(y.id));
}

/**
 * The per-task rollup as text lines for `ravenseat cost`: the most expensive roots first, with the runs and the fix tasks
 * folded in. `max` rows at most.
 */
function taskTotalLines(rows, max = 10) {
  if (!rows.length) return ['Cost per task, all runs: nothing measured yet.'];
  const n = Math.min(max, rows.length);
  const out = [
    `Cost per task, all runs (track, fix rounds, continuations, reviewers, fix tasks; top ${n} of ${rows.length}):`,
  ];
  for (const r of rows.slice(0, n)) {
    const tok = r.tokens >= 1e5 ? `${(r.tokens / 1e6).toFixed(1)}M tok` : `${r.tokens} tok`;
    out.push(
      `  ${r.id.padEnd(12)} ${String(r.class ?? '-').padEnd(2)} ${String(r.status ?? '-').padEnd(9)} ` +
        `$${r.usd.toFixed(2).padEnd(8)} ${tok.padEnd(10)} ${r.runs} run(s)` +
        (r.children.length ? `  + ${r.children.join(', ')} ($${r.children_usd.toFixed(2)})` : '') +
        (r.source === 'time-log' ? '  (time log, not measured yet)' : ''),
    );
  }
  return out;
}

/**
 * USD per merged change in [from, to): all measured cost (the usage events in the window) divided by the queue tasks
 * that reached done in the window. Every event is attributed by its track label (timeCost.taskIdFor, so fix rounds
 * and continuations count) to its ROOT task (rootOf: a fix task counts with the task it fixes and is not a merged
 * change of its own): to a merged task, a cancelled task, another open task (work in progress), or nothing (agents
 * without a task). Without any usage event in the window (no time log) the fallback total is the task total of the
 * merged roots (taskTotals: the measured cost with all runs, plus the fix tasks folded in), and `source` says
 * "task-cost".
 * @param {{ queue: object, events: object[], from: number, to: number }} input  from/to in ms
 * @returns {{ from: string, to: string, merged: number, total_usd: number, usd_per_merged: number|null,
 *   source: 'time-log'|'task-cost', parts: { merged: number, cancelled: number, open: number, unattributed: number },
 *   task_cost_usd: number, fix_tasks: number, content_min: number, usd_per_content_min: number|null }}
 */
function perMergedChange({ queue, events = [], from, to }) {
  const tasks = (queue?.tasks ?? []).filter((o) => !L.isExternalRow(o));
  const byId = new Map(tasks.map((o) => [o.id, o]));
  const inWindow = (t) => Number.isFinite(t) && t >= from && t < to;
  // Only roots are merged changes; a done fix task is part of the change it fixes (counted in fix_tasks).
  const isRoot = (o) => rootOf(o, byId) === o;
  const doneInWindow = tasks.filter((o) => o.status === 'done' && inWindow(Date.parse(o.done ?? '')));
  const merged = doneInWindow.filter(isRoot);
  const mergedIds = new Set(merged.map((o) => o.id));
  const parts = { merged: 0, cancelled: 0, open: 0, unattributed: 0 };
  let total = 0;
  let count = 0;
  for (const h of events ?? []) {
    if (!inWindow(Date.parse(h.time ?? ''))) continue;
    count += 1;
    total += h.usd;
    const id = h.track ? TK.taskIdFor(h.track, (x) => byId.has(x)) : null;
    const o = id ? rootOf(byId.get(id), byId) : null;
    if (!o) parts.unattributed += h.usd;
    else if (mergedIds.has(o.id)) parts.merged += h.usd;
    else if (o.status === 'cancelled') parts.cancelled += h.usd;
    else parts.open += h.usd;
  }
  // The task total of the merged roots (all runs and the fix tasks), from the measured cost or the time log.
  const totals = new Map(taskTotals({ queue, events }).map((r) => [r.id, r]));
  const taskCost = merged.reduce((s, o) => s + (totals.get(o.id)?.usd ?? 0), 0);
  const source = count ? 'time-log' : 'task-cost';
  if (!count) {
    total = taskCost;
    parts.merged = taskCost;
  }
  const content = merged.reduce((s, o) => s + contentMin(o), 0);
  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    merged: merged.length,
    total_usd: round2(total),
    usd_per_merged: merged.length ? round2(total / merged.length) : null,
    source,
    parts: {
      merged: round2(parts.merged),
      cancelled: round2(parts.cancelled),
      open: round2(parts.open),
      unattributed: round2(parts.unattributed),
    },
    task_cost_usd: round2(taskCost),
    fix_tasks: doneInWindow.length - merged.length,
    content_min: content,
    usd_per_content_min: content > 0 ? round2(total / content) : null,
  };
}

/** The figure as text lines for `ravenseat cost`: the headline first, the parts, then the secondary estimate-based figure. */
function perMergedLines(p, label) {
  const $ = (x) => `$${Number(x).toFixed(2)}`;
  if (!p.merged)
    return [`USD per merged change (${label}): no task reached done in the window (${$(p.total_usd)} measured).`];
  const out = [
    `USD per merged change (${label}): ${$(p.usd_per_merged)} = ${$(p.total_usd)} all measured cost / ${p.merged} merged`,
  ];
  if (p.source === 'time-log')
    out.push(
      `  of which merged tasks ${$(p.parts.merged)}, cancelled ${$(p.parts.cancelled)}, still open ${$(p.parts.open)}, ` +
        `no task ${$(p.parts.unattributed)} (subagents only; the orchestrator session is the overhead line below)`,
    );
  else out.push('  no usage in the time log for the window: the total is the measured task cost of the merged tasks only');
  if (p.fix_tasks)
    out.push(`  ${p.fix_tasks} done fix task(s) counted with the change they fix, not as merged changes of their own`);
  if (p.usd_per_content_min != null)
    out.push(
      `  secondary, estimate-based: ${$(p.usd_per_content_min)} per content minute (moves when estimates change; not a headline)`,
    );
  return out;
}

/**
 * Today's budget outlook for `next`/`show`/`state`: what the tasks that would start now are estimated to cost against
 * what is left of the daily budget. Informational only: the budget guard still stops on measured usage alone.
 * @param {{ active: boolean, limit?: number, usage?: number }} budget  queueLogic.budgetGuard
 * @param {number} nextUsd  the summed calibrated estimate of the tasks that would start
 * @returns {{ left: number, next_usd: number, over: boolean, message: string } | null}  null without a budget
 */
function budgetOutlook(budget, nextUsd) {
  if (!budget?.active) return null;
  const left = round2(Math.max(0, budget.limit - budget.usage));
  const next = round2(Number(nextUsd) || 0);
  const over = next > left;
  return {
    left,
    next_usd: next,
    over,
    message:
      `Budget outlook: what can start now is estimated at ~$${next.toFixed(2)}; $${left.toFixed(2)} is left today.` +
      (over ? ' It will probably pass the daily budget (the guard stops on measured usage only).' : ''),
  };
}

module.exports = {
  WINDOW_DAYS,
  MIN_SAMPLE,
  SIZE_BUCKETS,
  median,
  sizeBucket,
  samples,
  costModel,
  calibratedCost,
  costText,
  calibration,
  calibrationLines,
  parentOf,
  rootOf,
  taskTotals,
  taskTotalLines,
  perMergedChange,
  perMergedLines,
  budgetOutlook,
};
