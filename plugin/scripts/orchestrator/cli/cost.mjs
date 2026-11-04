// =============================================================
// cli/cost.mjs: the budget and capacity commands: forecast, limit, capacity, cost and calibrate.
//
// forecast (Monte Carlo on the throughput), limit (show or set the limits), capacity (the weekly quota: use, pace,
// calibration and the cloud credit), cost (measured cost per task and USD per merged change) and calibrate (per class:
// actual against estimated minutes, the suggested weight and the median USD).
//
// Why a module: queue.mjs was one file of about 6,300 lines. It is now a thin entry point (the usage comment and the
// dispatch on the command word) plus the modules in cli/. The code was moved as it was: same output, exit codes and files.
//
// Used by: queue.mjs (dispatch).
// Tested in: lib/__tests__/queueForecast.test.ts, queueLoadLimit.test.ts, queueNight.test.ts, costEstimate.test.ts, queuePlan.test.ts.
// =============================================================

import {
  a, BASE, CE, CH, CONFIG, cut, D, die, edit, FC, FOLDER, git, HELP, L, positional, read, readPlans, require, TK, val, WIDTH,
} from './context.mjs';
import {
  dailyUsageFor, measureLoad, measurementLine, measureTask, readTimeLog, saveMeasurement, sinceTime,
} from './tracks.mjs';
import { agentsBySession } from './events.mjs';

const ES = require('./lib/eventStatistics.js');

/** `cq forecast` (the usage is at the top of queue.mjs). */
export function cmdForecast() {
  // ---- Monte Carlo forecast: when are the remaining tasks done (lib/queueForecast.js) ----
  const days = a.includes('--days') ? Number(val('--days')) : FC.WINDOW_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > 365) die('--days must be a whole number 1-365');
  const project = a.includes('--project') ? val('--project') : null;
  if (a.includes('--project') && (!project || project.startsWith('--')))
    die('--project requires a project id (cq projects)');
  const queue = read();
  if (project && project !== L.WITHOUT_PROJECT && !Object.hasOwn(queue.projects ?? {}, project))
    die(`Unknown project ${project} (cq projects).`);
  // QUEUE_FORECAST_SEED gives a fixed random sequence (tests); otherwise Math.random.
  const seed = process.env.QUEUE_FORECAST_SEED;
  const f = FC.queueForecast(queue, {
    project,
    days,
    rng: seed ? FC.seededRandom(Number(seed)) : undefined,
  });
  if (a.includes('--json')) console.log(JSON.stringify(f, null, 2));
  else console.log(FC.forecastText(f));
}

/** `cq limit` (the usage is at the top of queue.mjs). */
export function cmdLimit() {
  const [, name, raw] = a;
  if (name) {
    // Validated under the lock against the limits as they are now (maxDPlus at most maxConcurrent).
    const t = edit((queue) => {
      const r = L.parseLimit(name, raw, { ...L.DEFAULT_LIMITS, ...(queue.limits ?? {}) });
      if ('error' in r) die(r.error);
      queue.limits = { ...(queue.limits ?? {}), [name]: r.val };
      return r;
    });
    console.log(`${name} = ${L.limitText(name, t.val)}`);
  }
  const queue = read();
  const g = { ...L.DEFAULT_LIMITS, ...(queue.limits ?? {}) };
  for (const n of L.LIMIT_NAME) console.log(`  ${n.padEnd(14)} ${L.limitText(n, g[n])}`);
  // The threshold for low parallelism (not a slot limit; default in queueDiagnose).
  console.log(`  ${'parallelThreshold'.padEnd(14)} ${D.thresholdFor(queue)}`);
  // The load limit (machine memory; the queue's value, otherwise queue.config.json) and the measurement now.
  console.log(`  ${'minFreeMemoryPct'.padEnd(14)} ${L.limitText('minFreeMemoryPct', L.minFreeMemoryFor(queue))}`);
  // The silence limit for running tracks (SILENT; 0 = off).
  const silentMin = L.silentMinFor(queue);
  console.log(`  ${'silentMin'.padEnd(14)} ${silentMin > 0 ? `${silentMin} min` : 'off'}`);
  const lm = measureLoad();
  console.log(
    `  load now: free memory ${lm.freeMemoryPct ?? '?'} %` +
      (lm.cpuPct != null ? `, CPU ${lm.cpuPct} % busy` : ''),
  );
  // The adaptive slot count (lib/loadSlots.js; loadGuard.adaptive in queue.config.json, QUEUE_LOAD_ADAPTIVE=off).
  const ls = L.loadSlotsFor(queue, lm);
  console.log(`  slots now: ${ls.active ? ls.text : `${ls.max} (adaptive off)`}`);
  const lg = L.loadGuard(queue, lm);
  if (lg.stop) console.log(lg.message);
  // When parallelism was limited and why, from the load rows of fill and start (lib/eventStatistics.js).
  for (const l of ES.loadLines(ES.loadStatistics(readTimeLog(), { from: Date.now() - 7 * 86_400_000, to: Date.now() + 1 }), 'last 7 days'))
    console.log(cut(l, WIDTH));
  const b = L.budgetGuard(queue, dailyUsageFor(queue));
  if (b.active) console.log(b.message);
  const night = L.nightGuard(queue);
  if (night.active) console.log(night.message);
}

/** `cq capacity` (the usage is at the top of queue.mjs). */
export function cmdCapacity() {
  // ---- Weekly quota on the subscription (lib/queueCapacity.js; reset and planName in config().capacity). Changes
  // are written under the lock in queue.json
  // (the field `capacity`); the view is read-only. ----
  const events = TK.usageEvents(readTimeLog());
  const time = val('--time');
  const now = time ? Date.parse(time) : Date.now();
  if (!Number.isFinite(now)) die('--time must be an ISO time, e.g. 2026-10-23T10:35+02:00');
  if (val('--calibrate') != null) {
    let percent = val('--calibrate');
    if (percent === 'auto') {
      // The status line (statusline.mjs) saves the last rate_limits it saw; use its 7-day percentage.
      const p = CH.observedPercent(CH.readObserved(FOLDER), { now });
      if (p.error) die(`--calibrate auto: ${p.error}. Give the percentage from Claude instead.`);
      percent = p.percent;
      console.log(`Calibration point from the status line: ${p.percent} % (seen ${p.age_min} min ago).`);
    }
    const r = edit((queue) => {
      const k = CH.calibrate(queue, { percent, events, now });
      if (k.error) die(k.error);
      queue.capacity = k.capacity;
      return k;
    });
    console.log(`Calibrated: usd_per_100 ${r.previous} → ${r.capacity.usd_per_100}.`);
  }
  if (val('--set') != null) {
    const v = Number(val('--set'));
    if (!(v > 0))
      die(
        '--set must be a positive number (USD API equivalent in the time log per 100 % of weeklyQuota)',
      );
    edit((queue) => {
      queue.capacity = { ...(queue.capacity ?? {}), usd_per_100: Math.round(v) };
    });
  }
  if (val('--mode') != null) {
    const m = val('--mode');
    if (!['notice', 'cap', 'off'].includes(m)) die('--mode must be notice, cap or off');
    edit((queue) => {
      queue.capacity = { ...(queue.capacity ?? {}), mode: m };
    });
  }
  if (val('--cloud-credit') != null) {
    const left = Number(val('--cloud-credit'));
    const total = val('--total') != null ? Number(val('--total')) : undefined;
    const expires = val('--expires');
    if (!(left >= 0)) die('--cloud-credit must be a number >= 0 (USD left)');
    if (expires && !Number.isFinite(Date.parse(expires))) die('--expires must be an ISO time');
    edit((queue) => {
      const previous = queue.capacity?.cloudCredit ?? {};
      queue.capacity = {
        ...(queue.capacity ?? {}),
        cloudCredit: {
          left_usd: left,
          total_usd: total ?? previous.total_usd ?? null,
          expires: expires ? new Date(expires).toISOString() : (previous.expires ?? null),
          set: new Date().toISOString(),
        },
      };
    });
  }
  const p = CH.forecast({ queue: read(), events, now });
  if (a.includes('--json')) console.log(JSON.stringify(p, null, 2));
  else console.log(CH.lines(p).join('\n'));
}

/** `cq cost` (the usage is at the top of queue.mjs). */
export function cmdCost() {
  // ---- Cost per task. `cost measure <id...>` measures and saves again (e.g. older finished ones). ----
  if (a[1] === 'measure') {
    const ids = positional(2, ['--findings', '--result']);
    if (!ids.length) die('cost measure <id> [...]');
    for (const id of ids) {
      const o = read().tasks.find((x) => x.id === id);
      if (!o) die(`Unknown task ${id}`);
      const m = measureTask(o);
      const r = edit((queue) => {
        const x = queue.tasks.find((y) => y.id === id);
        saveMeasurement(x, m);
        return x;
      });
      console.log(measurementLine(r));
    }
  } else {
    const queue = read();
    const since = sinceTime(val('--since'));
    const s = L.costStatistics(queue, { since });
    // The headline: USD per merged change (lib/costEstimate.js), all measured cost in the window / merged tasks. The
    // window is --since, otherwise the last WINDOW_DAYS days (the per-class lines below keep their all-time default).
    const from = since ? Date.parse(since) : Date.now() - CE.WINDOW_DAYS * 86_400_000;
    const rows = readTimeLog();
    const events = TK.usageEvents(rows);
    const to = Date.now() + 1;
    const merged = CE.perMergedChange({ queue, events, from, to });
    // The orchestration overhead (the main sessions' cost from the status line, minus their subagents) and the flow
    // figures over the SAME window, shown apart from the headline (lib/eventStatistics.js).
    const sessionIds = ES.sessionCosts(rows, { from, to }).map((x) => x.session_id);
    const orchestration = ES.orchestrationOverhead({
      rows,
      events,
      from,
      to,
      merged: merged.merged,
      trackUsd: merged.total_usd,
      agentsBySession: agentsBySession(sessionIds),
    });
    // The plan register gives the findings' causes (post-merge defects); an unreadable one only leaves them out.
    let plans = null;
    try {
      plans = readPlans();
    } catch {
      plans = null; // error-ignored: the findings are one input of the right-first-time figure
    }
    const revertedCommits = ES.revertedCommitsIn(git(['log', BASE, '--grep=This reverts commit', '--format=%B']));
    const flow = ES.flowStatistics(queue, rows, { from, to, plans, reviewerTypes: L.REVIEWER_TYPES, revertedCommits });
    // Cost per task with all its runs (first track, fix rounds, continuations, reviewers, fix tasks), by cost. All
    // time unless --since, like the per-class lines.
    const perTask = CE.taskTotals({ queue, events, since: since ? Date.parse(since) : null });
    const max = Number(val('--max') ?? 10);
    const metrics = transcriptMetricsSince(from);
    if (a.includes('--json')) {
      console.log(
        JSON.stringify(
          { perMerged: merged, orchestration, flow, perTask, perClass: s.perClass, total: s.total, metrics },
          null,
          2,
        ),
      );
      process.exit(0);
    }
    const label = since ? `since ${since.slice(0, 10)}` : `last ${CE.WINDOW_DAYS} days`;
    for (const l of CE.perMergedLines(merged, label)) console.log(l);
    for (const l of ES.overheadLines(orchestration, label)) console.log(cut(l, WIDTH));
    for (const l of ES.flowLines(flow, label)) console.log(cut(l, WIDTH));
    for (const l of TM().metricsLines(metrics)) console.log(cut(l, WIDTH));
    for (const l of CE.taskTotalLines(perTask, max)) console.log(cut(l, WIDTH));
    if (!s.rows.length)
      console.log('No finished tasks with a measured cost yet (measured at set <id> done).');
    else {
      console.log(`Cost per task (${s.total.n} finished, $${s.total.usd} total):`);
      for (const k of s.perClass)
        console.log(
          `  ${k.class.padEnd(2)} n=${String(k.n).padEnd(3)} median $${k.median_usd}  sum $${k.usd}` +
            (k.reviewed ? `  findings H=${k.H} M=${k.M} L=${k.L} (${k.reviewed} reviewed)` : ''),
        );
      // What the helper agents added (lib/queueHelpers.js): the same numbers as `cq helpers`.
      const helpers = HELP.helperRows(CONFIG, read());
      if (helpers.length) {
        const st = HELP.helperStatistics(read(), helpers.map((h) => h.name), { since: sinceTime(val('--since')) });
        console.log('Helper agents:');
        for (const h of helpers)
          console.log(cut(`  ${h.name.padEnd(20)} ${HELP.measurementText(st[h.name])}`, WIDTH));
      }
      console.log(`Last ${Math.min(max, s.rows.length)} finished (each task's own measurement):`);
      for (const x of s.rows.slice(0, max))
        console.log(
          `  ${x.id.padEnd(12)} ${String(x.class).padEnd(2)} $${String(x.usd).padEnd(7)} ${x.agents} agent(s)` +
            (x.findings ? `  H=${x.findings.H} M=${x.findings.M} L=${x.findings.L}` : '') +
            (x.result ? `  ${x.result}` : ''),
        );
    }
  }
}

// ---- Transcript metrics (lib/transcriptMetrics.js): per model, tools and errors, API errors, active time ----
const TM = () => require('./lib/transcriptMetrics.js');
/** The metrics summary for the done rows in the time log since `from` (epoch ms), the same window as the headline. */
function transcriptMetricsSince(from) {
  return TM().metricsSummary(readTimeLog(), { from, to: Date.now() + 1 });
}

/** `cq calibrate` (the usage is at the top of queue.mjs). */
export function cmdCalibrate() {
  // ---- The calibration view (lib/costEstimate.js): how far the minute estimates and the cost model are off per class.
  // Read-only: it never changes the weights, the order or the queue. ----
  const days = a.includes('--days') ? Number(val('--days')) : CE.WINDOW_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > 365) die('--days must be a whole number 1-365');
  const min = a.includes('--min') ? Number(val('--min')) : CE.MIN_SAMPLE;
  if (!Number.isInteger(min) || min < 1) die('--min must be a whole number >= 1');
  const c = CE.calibration(read(), { windowDays: days, minSample: min });
  if (a.includes('--json')) console.log(JSON.stringify(c, null, 2));
  else for (const l of CE.calibrationLines(c)) console.log(l);
}
