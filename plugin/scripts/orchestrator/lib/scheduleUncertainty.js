// =============================================================
// scheduleUncertainty.js: how sure the Timeline's plan is (roadmap TIDSLINJE T-C; plans: gantt investigation
// 2026-11-18, bolk C, section 6 and owner question 6). Pure: no file, no clock of its own; never changes the queue.
//
// THE BAND (uncertainty): a Monte Carlo over the measured actual/estimate ratios. One run plays the queue forward with
// the real simulation (queueSchedule.schedule, so the order, the slots, the limits, depends_on and the night window are
// the queue's own), but each task's length is estimateWall x a ratio DRAWN from the measured ones instead of the median:
//   - the pool follows queueSchedule.durationFor: the class + size bucket with MIN_SAMPLE or more, else the class, else
//     all measured ratios together (a class without data still gets the spread the queue has shown);
//   - a running task draws only among the lengths longer than what it has already run (it is known to take at least
//     that); none longer: it ends now, as in the plan.
// After the runs, each focus step's end (its last task's end) gives P50 and P85 by the nearest rank (the percentile of
// queueStatistics, which queueForecast uses too). A band per STEP only: per task the spread is a factor 2 to 3, so a
// task keeps its one rough bar (owner question 6).
//   Too few measured tasks (fewer than MIN_SAMPLE in the 28-day window of costEstimate.js): no band, one line why.
//   Cost: one run is one schedule() (about 2 to 3 ms on the demo queue with 12 open tasks). runsFor caps the runs by
//   WORK_CAP / open tasks, between MIN_RUNS and RUNS, so a big queue never takes seconds.
//
// AGREEMENT with queueForecast.js (investigation section 5: "no competitor"): both use the same 28-day window, the same
// floor of 5, the same seeded generator and seed and the same percentile. They still answer in two ways (tasks per
// day versus the order played forward), so the result carries the forecast's P85 date for the same tasks and `agree`:
// ok when the whole focus's P85 day is within a day of it, otherwise a sentence with both and why they differ.
//
// THE BACKTEST: replays past days from what queue.json records. For each of the last `days` days, at 12:00 UTC, the
// queue is rebuilt as it was (added before then; done before then is done; started before then is running; otherwise
// waiting; cancelled and proposed tasks and owner questions are left out, the focus too, since their history is not
// kept), the band is played with the ratios known then, and the tasks open at that moment that have since been done
// are the "step": its real finish is their last done time. A day counts when it had at least minTasks such tasks and
// enough measured tasks before it. byEnd = finished at or before the band's end (P85); late = after it. That gives
// the precision line "about N of 10 steps were done by the end of their band". Pure reading.
//
// Used by lib/queueTimeline.js (GET /api/schedule) and cli/schedule.mjs (`ravenseat schedule`). Shown by
// queue-board/board/timeline.js. Tested in lib/__tests__/scheduleUncertainty.test.ts.
// =============================================================
'use strict';

const SC = require('./queueSchedule.js');
const F = require('./queueForecast.js');
const S = require('./queueStatistics.js');
const CE = require('./costEstimate.js');
const TK = require('./timeCost.js');
const L = require('./queueLogic.js');

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** The calibration window and sample floor: costEstimate.js's (the same as queueForecast's WINDOW_DAYS and MIN_DONE). */
const WINDOW_DAYS = CE.WINDOW_DAYS;
const MIN_SAMPLE = CE.MIN_SAMPLE;
/** The seed: the board's forecast seed, so the same queue always gives the same band (and the payload version holds). */
const SEED = F.BOARD_SEED;
/** At most this many runs, at least MIN_RUNS, and at most WORK_CAP runs x open tasks (runsFor). */
const RUNS = 200;
const MIN_RUNS = 40;
const WORK_CAP = 6000;
/** The backtest: days back, runs per day, the least tasks that make a step, the least checked days for a number. */
const BACKTEST = Object.freeze({ days: 14, runs: 40, minTasks: 3, minDays: 5 });
/** The statuses that are open (as in queueSchedule). */
const OPEN = new Set(['waiting', 'running', 'review', 'picked']);
const RUNNING = new Set(['running', 'review', 'picked']);

const percentile = S.percentile;
const iso = (ms) => new Date(ms).toISOString();
const msOf = (v) => {
  const x = Date.parse(v ?? '');
  return Number.isFinite(x) ? x : null;
};

/** The runs for a queue with `open` open tasks: RUNS, cut by WORK_CAP, never below MIN_RUNS. */
function runsFor(open) {
  const n = Math.max(1, Math.floor(Number(open) || 0));
  return Math.max(MIN_RUNS, Math.min(RUNS, Math.floor(WORK_CAP / n)));
}

/** The pools to draw from: the ratio lists per bucket and class (queueSchedule.ratioSamples) and all of them together. */
function poolsOf(queue, { now, windowDays = WINDOW_DAYS }) {
  const { perClass, perBucket } = SC.ratioSamples(queue, { now, windowDays });
  const all = [...perClass.values()].flat();
  return { perClass, perBucket, all };
}

/**
 * The drawn length of one task for queueSchedule's minutesOf: the pool as durationFor picks its basis (class + size,
 * class, else all), a running task only among the lengths longer than it has run.
 */
function drawer(pools, minSample, rng) {
  return (o, d, elapsed = 0) => {
    const bucket = pools.perBucket.get(`${o?.class}/${CE.sizeBucket(o)}`) ?? [];
    const cls = pools.perClass.get(o?.class) ?? [];
    const pool = bucket.length >= minSample ? bucket : cls.length >= minSample ? cls : pools.all;
    const wall = d.wall > 0 ? d.wall : d.minutes;
    const pick = elapsed > 0 ? pool.filter((r) => wall * r > elapsed) : pool;
    if (!pick.length) return elapsed;
    const r = pick[Math.min(pick.length - 1, Math.floor(rng() * pick.length))];
    return Math.max(1, Math.round(wall * r));
  };
}

/** The key of a step (its index, or the title for the rest and the whole queue). */
const stepKey = (st) => (st.step != null ? `step:${st.step}` : `none:${st.title}`);

/**
 * The band played `runs` times: per step the drawn ends of its scheduled tasks (the last one), and of the scored set.
 * @returns {{ ends: Map<string, number[]>, steps: object[], whole: number[], scored: number[] }}
 */
function play(queue, { now, tz, runs, seed, quotaSlots = null, loadSlots = null, scoredIds = null, minSample = MIN_SAMPLE }) {
  const model = SC.ratioModel(queue, { now });
  const pools = poolsOf(queue, { now });
  const rng = F.seededRandom(seed);
  const minutesOf = drawer(pools, minSample, rng);
  const ends = new Map();
  const whole = [];
  const scored = [];
  let steps = [];
  for (let i = 0; i < runs; i += 1) {
    const s = SC.schedule(queue, { now, tz, model, quotaSlots, loadSlots, minutesOf });
    if (i === 0) steps = s.steps;
    const byId = new Map(s.tasks.map((r) => [r.id, msOf(r.end)]));
    let wholeEnd = null;
    for (const st of s.steps) {
      const mine = s.tasks.filter((r) => (r.step ?? null) === (st.step ?? null)).map((r) => msOf(r.end));
      if (!mine.length) continue;
      const end = Math.max(...mine);
      const k = stepKey(st);
      if (!ends.has(k)) ends.set(k, []);
      ends.get(k).push(end);
      // The whole focus: the focus steps (not the rest) when a focus applies, else the whole queue.
      if (st.step != null || st.title === 'the whole queue') wholeEnd = Math.max(wholeEnd ?? end, end);
    }
    if (wholeEnd != null) whole.push(wholeEnd);
    if (scoredIds) {
      const mine = scoredIds.map((id) => byId.get(id)).filter((x) => x != null);
      if (mine.length) scored.push(Math.max(...mine));
    }
  }
  return { ends, steps, whole, scored };
}

/** "Tue 4 Nov" (queueForecast.dayText) for a moment, by its day in `tz`. */
const dayOf = (ms, tz) => TK.dayFor(iso(ms), tz);

/**
 * The band per focus step.
 * @param {object} queue the queue (not changed)
 * @param {{ now?: number, tz?: string, runs?: number, seed?: number, quotaSlots?: number|null, loadSlots?: number|null }} [option]
 * @returns {{ enough: boolean, reason: string|null, runs: number, sample: number, windowDays: number, minSample: number,
 *   steps: { step: number|null, stage: string|null, title: string, p50_end: string, p85_end: string }[],
 *   whole: { p50_end: string, p85_end: string }|null, forecast: object|null, agree: { ok: boolean, text: string|null } }}
 */
function uncertainty(queue, option = {}) {
  const now = option.now ?? Date.now();
  const tz = option.tz ?? TK.TZ;
  const pools = poolsOf(queue, { now });
  const base = { windowDays: WINDOW_DAYS, minSample: MIN_SAMPLE, sample: pools.all.length };
  if (pools.all.length < MIN_SAMPLE)
    return {
      ...base,
      enough: false,
      reason:
        `No band yet: ${pools.all.length} finished task${pools.all.length === 1 ? '' : 's'} with a measured time in the ` +
        `last ${WINDOW_DAYS} days, needs at least ${MIN_SAMPLE}.`,
      runs: 0,
      steps: [],
      whole: null,
      forecast: null,
      agree: { ok: true, text: null },
    };
  const open = (queue?.tasks ?? []).filter((o) => !L.isExternalRow(o) && OPEN.has(o.status)).length;
  const runs = Math.max(1, Math.floor(Number(option.runs) || runsFor(open)));
  const p = play(queue, {
    now,
    tz,
    runs,
    seed: option.seed ?? SEED,
    quotaSlots: option.quotaSlots ?? null,
    loadSlots: option.loadSlots ?? null,
  });
  const steps = [];
  for (const st of p.steps) {
    const xs = p.ends.get(stepKey(st));
    if (!xs?.length) continue;
    steps.push({
      step: st.step ?? null,
      stage: st.stage ?? null,
      title: st.title,
      p50_end: iso(percentile(xs, 50)),
      p85_end: iso(percentile(xs, 85)),
    });
  }
  const whole = p.whole.length ? { p50_end: iso(percentile(p.whole, 50)), p85_end: iso(percentile(p.whole, 85)) } : null;
  // The throughput forecast for the same tasks (queueForecast with the board's seed), and whether the two agree.
  let forecast = null;
  let agree = { ok: true, text: null };
  try {
    const f = F.queueForecast(queue, { rng: F.seededRandom(F.BOARD_SEED), now, tz });
    forecast = { enough: f.enough, p50: f.p50?.date ?? null, p85: f.p85?.date ?? null, reason: f.reason ?? null };
    if (f.enough && f.p85 && whole) {
      const bandDay = dayOf(Date.parse(whole.p85_end), tz);
      const diff = (Date.parse(`${f.p85.date}T00:00:00Z`) - Date.parse(`${bandDay}T00:00:00Z`)) / DAY;
      if (Math.abs(diff) > 1)
        agree = {
          ok: false,
          text:
            `The Focus forecast (finished tasks per day) says 85 %: by ${F.dayText(f.p85.date)}; playing the order ` +
            `says by ${F.dayText(bandDay)}. The forecast counts quiet days and new work; the band plays the queue as it ` +
            'is now.',
        };
    }
  } catch {
    forecast = null;
  }
  return { ...base, enough: true, reason: null, runs, steps, whole, forecast, agree };
}

/**
 * The queue as it was at `t`, from what queue.json records: added before t; done before t stays done; started before
 * t is running; otherwise waiting. Cancelled, proposed and external tasks, owner questions and the focus are left out
 * (their history is not kept). Returns the copy and the ids open at t that have been done since (the step to score).
 */
function asOf(queue, t) {
  const tasks = [];
  const scored = [];
  for (const o0 of queue?.tasks ?? []) {
    if (!o0 || L.isExternalRow(o0)) continue;
    const added = msOf(o0.added_at) ?? msOf(o0.started);
    if (added == null || added > t) continue;
    const done = o0.status === 'done' ? msOf(o0.done) : null;
    if (o0.status === 'done' && done == null) continue;
    if (!(o0.status === 'done' || OPEN.has(o0.status))) continue;
    const o = JSON.parse(JSON.stringify(o0));
    o.waiting_on = [];
    if (done != null && done <= t) {
      tasks.push(o);
      continue;
    }
    const started = msOf(o0.started);
    delete o.done;
    delete o.delivered;
    if (started != null && started <= t && (done != null || RUNNING.has(o0.status))) o.status = 'running';
    else {
      o.status = 'waiting';
      delete o.started;
      delete o.picked_at;
    }
    tasks.push(o);
    if (done != null) scored.push({ id: o.id, done });
  }
  const copy = { ...JSON.parse(JSON.stringify({ ...(queue ?? {}), tasks: [] })), tasks };
  delete copy.focus;
  return { copy, scored };
}

/**
 * The backtest: how often the real finish of the tasks open at a past moment was inside the band or earlier.
 * @param {{ now?: number, tz?: string, days?: number, runs?: number, seed?: number }} [option]
 * @returns {{ enough: boolean, days: number, checked: number, byEnd: number, late: number, skipped: number,
 *   rate: number|null, tenths: number|null, text: string }}
 */
function backtest(queue, option = {}) {
  const now = option.now ?? Date.now();
  const tz = option.tz ?? TK.TZ;
  const days = Math.max(1, Math.floor(Number(option.days) || BACKTEST.days));
  const runs = Math.max(1, Math.floor(Number(option.runs) || BACKTEST.runs));
  let checked = 0;
  let byEnd = 0;
  let skipped = 0;
  const anchor = Math.floor(now / DAY) * DAY + 12 * 60 * MIN;
  for (let k = 1; k <= days; k += 1) {
    const t = anchor - k * DAY;
    if (t >= now) continue;
    const { copy, scored } = asOf(queue, t);
    if (scored.length < BACKTEST.minTasks) continue;
    if (poolsOf(copy, { now: t }).all.length < MIN_SAMPLE) {
      skipped += 1;
      continue;
    }
    const p = play(copy, { now: t, tz, runs, seed: option.seed ?? SEED, scoredIds: scored.map((x) => x.id) });
    if (!p.scored.length) {
      skipped += 1;
      continue;
    }
    const actual = Math.max(...scored.map((x) => x.done));
    checked += 1;
    if (actual <= percentile(p.scored, 85)) byEnd += 1;
  }
  const enough = checked >= BACKTEST.minDays;
  const rate = checked ? byEnd / checked : null;
  const tenths = enough ? Math.round(rate * 10) : null;
  return {
    enough,
    days,
    checked,
    byEnd,
    late: checked - byEnd,
    skipped,
    rate: rate == null ? null : Math.round(rate * 100) / 100,
    tenths,
    text: enough
      ? `Backtest: about ${tenths} of 10 steps were done by the end of their band (${checked} past days checked).`
      : `No backtest yet: ${checked} past days could be checked, needs at least ${BACKTEST.minDays}.`,
  };
}

module.exports = {
  WINDOW_DAYS,
  MIN_SAMPLE,
  SEED,
  RUNS,
  MIN_RUNS,
  WORK_CAP,
  BACKTEST,
  percentile,
  runsFor,
  uncertainty,
  asOf,
  backtest,
};
