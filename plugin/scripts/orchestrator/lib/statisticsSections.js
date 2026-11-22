// =============================================================
// statisticsSections.js: the figures for the reworked Statistics tab (plans/stats-vurdering-2026-11-18.md, S2 to S5 and
// S9): the top row and the sections Cost and tokens, Machine and Quality. Everything here is data the queue already
// records (the time log's done, gate, compact and load rows, queue.json, the finding log, rate-limits.json); nothing is
// a new registration.
//
// Kept apart from queueStatistics.js (which keeps the charts it had) so the two merge simply. The board server
// (queue-board.mjs) reads the files and calls `sections`; the board (board/statistics.js) only draws.
//
//   - top: the trend of the cost per merged change (this week against the week before), "waiting on you" (median
//     answer time, open owner questions now and the oldest wait), the quota (the 7-day percentage against the time gone
//     of the quota week, else the daily quota), and whether the queue grew in both of the last two weeks;
//   - cost: the token mix per day as USD per kind (input, output, cache read, cache write), the cost per phase (build,
//     review, fix round) per class from the tasks' measured cost.phases, the cache expiries per day (and their USD when
//     the rows carry cache_expiry_usd), the five most expensive tasks, and one context point per track against the cap;
//   - machine: per day the fills and starts the load guard limited or stopped, the lowest free memory, the gate queue
//     wait p50/p95, and the gate time p50 against how many tracks ran at the same time (1, 2, 3, 4+);
//   - quality: the gate health (lib/gateHealth.js) and the finding log per source and severity, with how many deferred
//     findings were fixed;
//   - plans (PG-6, only when the server passes the register): the built plans' estimate against the outcome and the
//     accuracy record per size (lib/planPostCheck.js section).
// The context cap is the compaction window from Claude Code's settings files (`compactWindow`), 300k when none sets it.
// Pure functions without I/O. Tested in lib/__tests__/statisticsSections.test.ts.
// =============================================================
'use strict';

const TK = require('./timeCost.js');
const CE = require('./costEstimate.js');
const GH = require('./gateHealth.js');
const S = require('./queueStatistics.js');
const L = require('./queueLogic.js');

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
/** The context points over this share of the cap are "near the cap". */
const NEAR_CAP = 0.8;
/** "Waiting on you" turns warn from this median (minutes) or this oldest wait (minutes). */
const WAIT_WARN_MEDIAN_MIN = 4 * 60;
const WAIT_WARN_OLDEST_MIN = 24 * 60;
/** The quota pace says nothing in the first hours of a quota week (a few % gone makes any use look fast). */
const QUOTA_MIN_ELAPSED_PCT = 5;
/** The most expensive tasks shown. */
const EXPENSIVE = 5;
/** The gate commands shown in the gate health table (slowest p95 first). */
const GATE_ROWS = 8;

const round = (x, d = 0) => Math.round(x * 10 ** d) / 10 ** d;
const num = (x) => (x != null && Number.isFinite(Number(x)) ? Number(x) : null);

/**
 * The compaction window (the context cap) from Claude Code's settings objects in precedence order (local project,
 * project, user): the first with a positive whole `autoCompactWindow` wins. 300k (what ravenseat setup --settings
 * writes) when none sets it, with source 'default'.
 * @param {{ name: string, settings: object|null }[]} list
 */
function compactWindow(list) {
  for (const { name, settings } of list ?? []) {
    const v = num(settings?.autoCompactWindow);
    if (v != null && v > 0) return { cap: Math.round(v), source: name };
  }
  return { cap: S.CONTEXT_CAP, source: 'default' };
}

/** The open owner questions now: ids in an open task's waiting_on or registered in `question`, not resolved, with the time they exist since. */
function openQuestions(queue) {
  const resolved = new Set([...(queue?.resolved ?? []), ...Object.keys(queue?.resolutions ?? {})]);
  const since = new Map();
  const note = (sp, t) => {
    const ms = Date.parse(t ?? '');
    if (!since.has(sp) || (Number.isFinite(ms) && (since.get(sp) == null || ms < since.get(sp))))
      since.set(sp, Number.isFinite(ms) ? ms : (since.get(sp) ?? null));
  };
  for (const o of queue?.tasks ?? []) {
    if (!o || o.status === 'done' || o.status === 'cancelled') continue;
    for (const sp of o.waiting_on ?? []) if (!resolved.has(sp)) note(sp, o.added_at);
  }
  for (const [sp, q] of Object.entries(queue?.question ?? {})) if (!resolved.has(sp)) note(sp, q?.added_at);
  // A checkpoint whose stage is not done yet (PG-4) is not waiting on the owner yet.
  return [...since.entries()].filter(([id]) => !L.questionHidden(queue, id)).map(([id, ms]) => ({ id, since: ms }));
}

/**
 * The quota figure: the 7-day percentage from rate-limits.json against the share of the quota week gone (when the
 * reading has a reset time in the future), else null. `pace` is the percentage the week ends at at this rate; warn when
 * it passes 100 once at least QUOTA_MIN_ELAPSED_PCT of the week is gone.
 */
function weekQuota(observed, now = Date.now()) {
  const w = observed?.seven_day;
  const used = num(w?.used_percentage);
  const resets = num(w?.resets_at);
  if (used == null || resets == null || resets * 1000 <= now) return null;
  const elapsed = Math.min(100, Math.max(0, ((now - (resets * 1000 - WEEK_MS)) / WEEK_MS) * 100));
  const pace = elapsed > 0 ? (used / elapsed) * 100 : null;
  return {
    used_pct: round(used, 1),
    elapsed_pct: round(elapsed, 1),
    pace_pct: pace == null ? null : round(pace),
    resets_at: new Date(resets * 1000).toISOString(),
    reading_at: observed.time ?? null,
    warn: pace != null && elapsed >= QUOTA_MIN_ELAPSED_PCT && pace > 100,
  };
}

/** The top row's own figures (the rest come from queueStatistics and the flow figures). */
function topFigures({ queue, events, inOutPerDay, responseTime, observed, now }) {
  const per = (from, to) => CE.perMergedChange({ queue, events, from, to });
  const thisWeek = per(now - WEEK_MS, now + 1);
  const lastWeek = per(now - 2 * WEEK_MS, now - WEEK_MS);
  const open = openQuestions(queue);
  const oldest = open.map((q) => q.since).filter((x) => x != null);
  const oldestMin = oldest.length ? round((now - Math.min(...oldest)) / 60_000) : null;
  const net = (list) => list.reduce((s, r) => s + r.in - r.out, 0);
  const days = inOutPerDay ?? [];
  return {
    costTrend: {
      this: thisWeek.merged ? round(thisWeek.usd_per_merged, 2) : null,
      last: lastWeek.merged ? round(lastWeek.usd_per_merged, 2) : null,
    },
    waiting: {
      median: responseTime?.median ?? null,
      answered: responseTime?.count ?? 0,
      open: open.length,
      oldest_min: oldestMin,
      warn: (responseTime?.median ?? 0) > WAIT_WARN_MEDIAN_MIN || (oldestMin ?? 0) > WAIT_WARN_OLDEST_MIN,
    },
    quota: weekQuota(observed, now),
    // The queue grew in both of the last two weeks (the in-versus-out tile turns warn only then).
    growing: days.length >= 14 && net(days.slice(-14, -7)) > 0 && net(days.slice(-7)) > 0,
  };
}

/**
 * USD per token kind for one usage event, priced as costOf prices the row (PC-1): each model's growth at its own price
 * when the event has byModel, else the tokens at the event's model; cache writes at the 5 min or 1 h price by their
 * split (writes without a split count as 5 min). Before PC-1 every write was priced at 5 min and the whole event at one
 * model, so with 1 h writes the bars did not add up to the measured cost.
 */
function kindCost(h) {
  const by = h.byModel && typeof h.byModel === 'object' ? Object.entries(h.byModel) : [];
  const parts = by.length ? by.map(([m, v]) => TK.costByKind(v?.tokens, m)) : [TK.costByKind(h.tokens, h.model ?? undefined)];
  const out = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  for (const p of parts) for (const k of Object.keys(out)) out[k] += p[k];
  return out;
}

/** Section A: cost and tokens. */
function costSection({ queue, rows, events, days, cap, tz, now }) {
  const inWindow = new Set(days);
  const mix = new Map(days.map((d) => [d, { day: d, input: 0, output: 0, cache_read: 0, cache_write: 0 }]));
  const expiry = new Map(days.map((d) => [d, { day: d, count: 0, usd: 0 }]));
  for (const h of events) {
    const m = mix.get(h.day);
    if (!m) continue;
    const c = kindCost(h);
    for (const k of Object.keys(c)) m[k] += c[k];
    const e = expiry.get(h.day);
    e.count += h.cache_expiry ?? 0;
    e.usd += h.cache_expiry_usd ?? 0;
  }
  const mixTotal = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
  for (const m of mix.values()) for (const k of Object.keys(mixTotal)) mixTotal[k] += m[k];
  const mixSum = Object.values(mixTotal).reduce((a, b) => a + b, 0);

  // The cost per phase per class: the tasks done in the window with a measured cost.phases (ravenseat set <id> done).
  const from = now - days.length * DAY_MS;
  const phases = Object.fromEntries(S.CLASSES.map((k) => [k, { class: k, build: 0, review: 0, fix: 0, tasks: 0 }]));
  for (const o of queue?.tasks ?? []) {
    const ph = o?.cost?.phases;
    if (o?.status !== 'done' || !ph || !(Date.parse(o.done ?? '') >= from) || !phases[o.class]) continue;
    const p = phases[o.class];
    p.build += num(ph.build) ?? 0;
    p.review += num(ph.review) ?? 0;
    p.fix += num(ph.fix) ?? 0;
    p.tasks += 1;
  }
  const phaseList = Object.values(phases)
    .filter((p) => p.tasks)
    .map((p) => ({ ...p, build: round(p.build, 2), review: round(p.review, 2), fix: round(p.fix, 2) }));
  const phaseSum = phaseList.reduce((s, p) => s + p.build + p.review + p.fix, 0);
  const fixSum = phaseList.reduce((s, p) => s + p.fix, 0);

  // One context point per build agent (its last row; the rows are cumulative), and the highest per task.
  const last = new Map();
  for (const r of rows ?? []) {
    if (r?.event !== 'done' || !TK.isBuildAgent(r.agent_type)) continue;
    last.set(r.agent_id ?? `${r.track ?? '?'}|${r.time}`, r);
  }
  const points = [...last.values()]
    .filter((r) => inWindow.has(TK.dayFor(r.time, tz)) && num(r.context?.end) > 0)
    .map((r) => ({ track: r.track ?? null, end: Number(r.context.end) }))
    .sort((a, b) => a.end - b.end);
  const byTask = new Map(queue?.tasks?.map((o) => [o.id, o]) ?? []);
  const contextOf = new Map();
  for (const p of points) {
    const id = p.track ? TK.taskIdFor(p.track, (x) => byTask.has(x)) : null;
    if (id) contextOf.set(id, Math.max(contextOf.get(id) ?? 0, p.end));
  }

  const expensive = CE.taskTotals({ queue, events, since: from })
    .filter((x) => x.usd > 0)
    .slice(0, EXPENSIVE)
    .map((x) => ({
      id: x.id,
      class: x.class,
      usd: round(x.usd, 2),
      fix_rounds: byTask.get(x.id)?.cost?.phases?.fix_rounds ?? (byTask.get(x.id)?.resumed ?? []).length,
      context_max: contextOf.get(x.id) ?? null,
    }));

  return {
    tokenMix: [...mix.values()].map((m) => ({
      day: m.day,
      input: round(m.input, 2),
      output: round(m.output, 2),
      cache_read: round(m.cache_read, 2),
      cache_write: round(m.cache_write, 2),
    })),
    cacheWriteShare: mixSum > 0 ? round((mixTotal.cache_write / mixSum) * 100) : null,
    phases: phaseList,
    fixShare: phaseSum > 0 ? round((fixSum / phaseSum) * 100) : null,
    cacheExpiry: [...expiry.values()].map((e) => ({ day: e.day, count: e.count, usd: round(e.usd, 2) })),
    expensive,
    context: {
      cap,
      points,
      near: points.filter((p) => p.end > cap * NEAR_CAP).length,
    },
  };
}

/** How many tasks were running (started, not yet delivered or done) at `t`. */
function runningAt(tasks, t, now) {
  let n = 0;
  for (const o of tasks) {
    const a = Date.parse(o.started ?? '');
    if (!Number.isFinite(a) || a > t) continue;
    const end = Date.parse(o.delivered ?? '') || Date.parse(o.done ?? '') || (L.ACTIVE?.has?.(o.status) ? now : NaN);
    if (Number.isFinite(end) && end > t) n += 1;
  }
  return n;
}

/** p50 and p95 (nearest rank) of a list, or nulls. */
const spread = (xs) => ({ p50: S.percentile(xs, 50), p95: S.percentile(xs, 95), n: xs.length });

/** Section D: the machine (load rows, gate queue wait, gate time against concurrent tracks). */
function machineSection({ queue, gateRows, loadRows, days, tz, now }) {
  const inWindow = new Set(days);
  const load = new Map(days.map((d) => [d, { day: d, rows: 0, limited: 0, stopped: 0, min_free: null, samples: 0 }]));
  for (const r of loadRows ?? []) {
    const x = load.get(TK.dayFor(r.time, tz));
    if (!x) continue;
    const free = num(r.free_memory_pct);
    if (free != null) x.min_free = x.min_free == null ? free : Math.min(x.min_free, free);
    if (r.command === 'sample') {
      x.samples += 1;
      continue;
    }
    x.rows += 1;
    if (r.limited_by) x.limited += 1;
    if (r.stopped) x.stopped += 1;
  }
  const waits = new Map(days.map((d) => [d, []]));
  const buckets = { 1: [], 2: [], 3: [], '4+': [] };
  const durations = [];
  const tasks = (queue?.tasks ?? []).filter((o) => o && !L.isExternalRow(o));
  let lowestGateFree = null;
  for (const r of gateRows ?? []) {
    if (r?.event !== 'gate') continue;
    const day = TK.dayFor(r.time, tz);
    if (!inWindow.has(day)) continue;
    const w = num(r.wait_sec);
    if (w != null) waits.get(day).push(w);
    const free = num(r.min_free_memory_pct);
    if (free != null) lowestGateFree = lowestGateFree == null ? free : Math.min(lowestGateFree, free);
    const d = num(r.duration_s);
    if (!(d > 0) || r.timed_out) continue;
    durations.push(d);
    // The run started duration_s before its row; count the tracks running then (a base gate counts as 1).
    const at = Date.parse(r.time) - d * 1000;
    const n = Math.max(1, runningAt(tasks, at, now));
    buckets[n >= 4 ? '4+' : String(n)].push(d);
  }
  const waitAll = [...waits.values()].flat();
  return {
    load: [...load.values()],
    lowestGateFree,
    gateWait: days.map((d) => ({ day: d, ...spread(waits.get(d)) })),
    waitAll: spread(waitAll),
    gateAll: spread(durations),
    byConcurrency: Object.entries(buckets).map(([tracks, xs]) => ({ tracks, ...spread(xs) })),
  };
}

/** Section C: gate health and the finding log. */
function qualitySection({ gateRows, findings, from }) {
  const h = GH.gateHealth(gateRows ?? []);
  const sources = new Map();
  let deferred = 0;
  let deferredFixed = 0;
  for (const f of findings ?? []) {
    if (!(Date.parse(f?.time ?? '') >= from)) continue;
    const src = String(f.caught_by ?? '?');
    const s = sources.get(src) ?? { source: src, H: 0, M: 0, L: 0 };
    if (s[f.severity] != null) s[f.severity] += 1;
    sources.set(src, s);
    if (f.disposition?.kind === 'task' || f.disposition?.kind === 'batch') {
      deferred += 1;
      if (f.fixed_by) deferredFixed += 1;
    }
  }
  return {
    gates: {
      runs: h.runs,
      minRuns: h.minRuns,
      commands: h.commands.slice(0, GATE_ROWS).map((c) => ({
        command: c.command,
        runs: c.runs,
        red: c.red,
        flaky: c.flaky,
        p50: c.p50,
        p95: c.p95,
      })),
      neverRed: h.neverRed.map((c) => c.command),
      flaky: h.commands.filter((c) => c.flaky > 0).length,
    },
    findings: {
      sources: [...sources.values()].sort((a, b) => b.H + b.M + b.L - (a.H + a.M + a.L) || a.source.localeCompare(b.source)),
      deferred,
      deferredFixed,
    },
  };
}

/**
 * A gate or flakyGate row in the slim form the board server keeps (S3): the numbers and command names only, never the
 * error excerpts, so the server's memory stays low though gate rows are most of the time log.
 */
function slimGateRow(r) {
  if (r?.event === 'flakyGate') return { time: r.time, event: r.event, source: r.source ?? null, commands: r.commands ?? [] };
  const out = { time: r.time, event: 'gate', gates: r.gates ?? [], failed: r.failed ?? [], duration_s: r.duration_s };
  // sha: the commit the run checked, so "Gates run twice" (CI-1) finds the merge step's quick gates on a merge commit.
  for (const k of ['durations', 'wait_sec', 'min_free_memory_pct', 'start_free_memory_pct', 'flaky', 'timed_out', 'sha'])
    if (r[k] != null) out[k] = r[k];
  return out;
}

/**
 * All sections for the board.
 * @param {{ queue: object, rows: object[], gateRows?: object[], loadRows?: object[], findings?: object[],
 *   observed?: object|null, cap?: number, statistics: object, now?: number, tz?: string }} input  `statistics` is
 *   queueStatistics.statistics' answer (inOutPerDay and responseTime are read from it)
 */
function sections({ queue, rows, gateRows = [], loadRows = [], findings = [], observed = null, cap = S.CONTEXT_CAP, statistics, plans = null, now = Date.now(), tz = TK.TZ }) {
  const days = S.daysBackward(now, S.WINDOW_DAYS, tz);
  const events = TK.usageEvents(rows ?? [], tz);
  return {
    top: topFigures({ queue, events, inOutPerDay: statistics?.inOutPerDay, responseTime: statistics?.keyFigures?.responseTime, observed, now }),
    cost: costSection({ queue, rows, events, days, cap, tz, now }),
    machine: machineSection({ queue, gateRows, loadRows, days, tz, now }),
    quality: qualitySection({ gateRows, findings, from: now - S.WINDOW_DAYS * DAY_MS }),
    // PG-6 (lib/planPostCheck.js): the built plans against their estimates. Only when the caller passes the register
    // ({ entries, measureFor }) with plans.postCheck on; all time, not the window, since a plan spans weeks.
    ...(plans ? { plans: require('./planPostCheck.js').section({ entries: plans.entries ?? [], queue, events, measureFor: plans.measureFor }) } : {}),
  };
}

module.exports = {
  NEAR_CAP,
  WAIT_WARN_MEDIAN_MIN,
  WAIT_WARN_OLDEST_MIN,
  compactWindow,
  openQuestions,
  weekQuota,
  runningAt,
  slimGateRow,
  sections,
};
