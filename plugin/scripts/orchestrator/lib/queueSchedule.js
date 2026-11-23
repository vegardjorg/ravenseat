// =============================================================
// queueSchedule.js: the schedule simulation (roadmap TIDSLINJE A0): plays the queue forward as a list scheduler and says
// when each task would start and end, and when each focus step would be done.
//
// Pure: no file, no clock of its own (the caller passes `now`, the quota cap and the load slots). Never changes the queue
// it is given; it plays a deep copy forward.
//
// HOW (plans: gantt investigation 2026-11-18, section 2):
//   1. Order and limits: the queue's own selectNext (logic/select.js), called on the copy at each simulated moment. So
//      the ranking (focus steps, then score), maxDPlus, maxDb, maxPerDomain, owned-file conflicts, depends_on, parking,
//      paused projects and the pause when a focus has ended come from the same code `next` and `fill` use. No rule is
//      copied here.
//   2. Slots: min(maxConcurrent, the quota cap fill would use, the load-aware slots), written into the copy's limits.
//   3. Duration: estimateWall(o) x the median actual/calibrated ratio (cycle time started to done, divided by
//      estimateWall) for the class and size bucket in the calibration window, with the fallback of costEstimate.js:
//      class + size with at least MIN_SAMPLE measurements, else the class, else the model alone (ratio 1). The raw minute
//      estimate (estimate) is never used as time: it drives priority, not duration.
//   4. Owner questions: an open question in waiting_on is answered after the median answer time
//      (queueStatistics.responseTimesOf; DEFAULT_ANSWER_MIN below 5 measurements), and the task is marked "waits on you".
//   5. Night: with nightRun off, nothing starts inside the night window (the real nightGuard, in `tz`).
//   6. Running tasks (running, review, picked): the remaining time = expected minus elapsed, never below zero; one past
//      its expected time is marked over_estimate.
//
// PRECISION: per task the measured spread is wide (P25 to P75 spans a factor 2.5 to 3), so every task row has rough: true
// and a band, and no text promises a date per task. A focus step's end evens out somewhat. Only the queue as it is now
// is played: new tasks that rank in ahead, fix rounds and changing quota or load are not modeled.
//
// Used by cli/schedule.mjs (`ravenseat schedule`). Tested in lib/__tests__/queueSchedule.test.ts.
// =============================================================
'use strict';

const L = require('./queueLogic.js');
const CE = require('./costEstimate.js');
const SQ = require('./queueStatistics.js');
const CH = require('./queueCapacity.js');

const MIN = 60_000;
/**
 * The answer time an open owner question gets when fewer than RESPONSE_TIME_MIN_COUNT answers have a time: 4 hours.
 * A guess, said as one in the output (answer.basis "default"), until the queue has measured its own.
 */
const DEFAULT_ANSWER_MIN = 240;
/**
 * The narrowest band a task row gets, as factors on the expected time. The investigation measured P25/P50 at about
 * 0.65 to 0.7 and P75/P50 at about 1.6 to 1.8 per class; a measured spread that is narrower (few samples) is widened to
 * this, so a bar never looks surer than the data allows.
 */
const BAND = Object.freeze({ low: 0.65, high: 1.8 });
/** Statuses that hold a slot or their files now and finish by themselves in the simulation. */
const RUNNING = new Set(['running', 'review', 'picked']);

/** The value at fraction p (0..1) of the sorted numbers, linear between neighbors (null for an empty list). */
function quantile(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}

/** { n, median, p25, p75, measured } for a list of ratios. */
function spread(xs, minSample) {
  return {
    n: xs.length,
    median: quantile(xs, 0.5),
    p25: quantile(xs, 0.25),
    p75: quantile(xs, 0.75),
    measured: xs.length >= minSample,
  };
}

/**
 * The measured ratios themselves (actual cycle time / estimateWall), as lists per class and per class + size bucket
 * ("K/S"). ratioModel sums them up; lib/scheduleUncertainty.js draws from them (T-C), so both read the same samples.
 * @returns {{ perClass: Map<string, number[]>, perBucket: Map<string, number[]> }}
 */
function ratioSamples(queue, { now = Date.now(), windowDays = CE.WINDOW_DAYS } = {}) {
  const byId = new Map((queue?.tasks ?? []).map((o) => [o.id, o]));
  const perClass = new Map();
  const perBucket = new Map();
  for (const s of CE.samples(queue, { now, windowDays })) {
    const wall = L.estimateWall(byId.get(s.id));
    if (s.minutes == null || !(wall > 0)) continue;
    const r = s.minutes / wall;
    if (!perClass.has(s.class)) perClass.set(s.class, []);
    perClass.get(s.class).push(r);
    const key = `${s.class}/${s.size}`;
    if (!perBucket.has(key)) perBucket.set(key, []);
    perBucket.get(key).push(r);
  }
  return { perClass, perBucket };
}

/**
 * The measured ratio actual cycle time / estimateWall per class and per class + size bucket ("K/S"), from the done tasks
 * in the calibration window (costEstimate.samples: the same window and size buckets as the cost estimate).
 * @returns {{ windowDays: number, minSample: number, classes: Record<string, object>, buckets: Record<string, object> }}
 */
function ratioModel(queue, { now = Date.now(), windowDays = CE.WINDOW_DAYS, minSample = CE.MIN_SAMPLE } = {}) {
  const { perClass, perBucket } = ratioSamples(queue, { now, windowDays });
  const classes = {};
  for (const [k, xs] of perClass) classes[k] = spread(xs, minSample);
  const buckets = {};
  for (const [k, xs] of perBucket) buckets[k] = spread(xs, minSample);
  return { windowDays, minSample, classes, buckets };
}

/** "about 15 min", "about 2.5 h", "about 3 d": a rough length, never more precise than the data. */
function roughDuration(min) {
  const m = Math.max(0, Number(min) || 0);
  const five = Math.max(5, Math.round(m / 5) * 5);
  if (five < 60) return `${five} min`;
  if (m < 48 * 60) return `${Math.round((m / 60) * 2) / 2} h`;
  return `${Math.round(m / 1440)} d`;
}

/**
 * The expected duration of one task in minutes, with the basis and a rough band.
 * @returns {{ minutes: number, wall: number, ratio: number, basis: 'class+size'|'class'|'model', n: number,
 *   band: { low_min: number, high_min: number, label: string } }}
 */
function durationFor(o, model) {
  const wall = L.estimateWall(o);
  const b = model?.buckets?.[`${o?.class}/${CE.sizeBucket(o)}`];
  const k = model?.classes?.[o?.class];
  const used = b?.measured ? { s: b, basis: 'class+size' } : k?.measured ? { s: k, basis: 'class' } : null;
  const ratio = used && used.s.median > 0 ? used.s.median : 1;
  const minutes = Math.max(1, Math.round(wall * ratio));
  const lowF = Math.min(used && used.s.median > 0 ? used.s.p25 / used.s.median : BAND.low, BAND.low);
  const highF = Math.max(used && used.s.median > 0 ? used.s.p75 / used.s.median : BAND.high, BAND.high);
  const low = Math.max(1, Math.round(minutes * lowF));
  const high = Math.max(low + 1, Math.round(minutes * highF));
  return {
    minutes,
    wall,
    ratio: Math.round(ratio * 100) / 100,
    basis: used ? used.basis : 'model',
    n: used ? used.s.n : 0,
    band: { low_min: low, high_min: high, label: `rough: ${roughDuration(low)} to ${roughDuration(high)}` },
  };
}

/**
 * The slot cap the quota forecast gives, the way `fill` uses it (queueCapacity.quotaCap): null in notice or off mode or
 * without a suggestion; in cap mode the running tracks plus the new ones fill may start (at least 1 with nothing running).
 * @param {object} p queueCapacity.forecast
 * @param {number} running the tracks running now (the same count fill passes)
 */
function quotaSlotsFrom(p, running) {
  const t = CH.quotaCap(p, running);
  return t.limit == null ? null : running + t.limit;
}

/** The next moment (quarter-hour steps, at most two days ahead) when the night guard no longer stops starts. */
function nightEnd(queue, t, tz) {
  const q = 15 * MIN;
  let x = Math.floor(t / q) * q + q;
  for (let i = 0; i < 2 * 24 * 4; i += 1, x += q) if (!L.nightGuard(queue, x, tz).stop) return x;
  return null;
}

const iso = (ms) => new Date(ms).toISOString();

/**
 * Play the queue forward.
 * @param {object} queue the queue (queue.json); not changed
 * @param {{ now?: number, tz?: string, quotaSlots?: number|null, loadSlots?: number|null, model?: object }} [option]
 *   tz: the time zone of the night window (the machine's by default); quotaSlots: quotaSlotsFrom; loadSlots: the
 *   load-aware slot count (loadSlotsFor(...).slots when active); model: ratioModel (computed from the queue by default);
 *   minutesOf(o, d, elapsedMin): the whole length in minutes of one task (d = durationFor), for one run of the
 *   uncertainty band (lib/scheduleUncertainty.js draws it); d.minutes, the median, by default
 * @returns {object} see the test for the shape: now, rough, slots, answer, tasks, unscheduled, proposed, steps, end,
 *   night, precision
 */
function schedule(queue, option = {}) {
  const now = option.now ?? Date.now();
  const tz = option.tz ?? L.NIGHT_TZ;
  const model = option.model ?? ratioModel(queue, { now });
  const lengthOf = typeof option.minutesOf === 'function' ? option.minutesOf : (_o, d) => d.minutes;
  const q = JSON.parse(JSON.stringify(queue ?? {}));
  q.tasks = Array.isArray(q.tasks) ? q.tasks : [];
  q.resolved = Array.isArray(q.resolved) ? q.resolved : [];

  // ---- Slots: min(maxConcurrent, quota, load). maxDPlus, maxDb and conflicts are selectNext's own. ----
  const g = { ...L.DEFAULT_LIMITS, ...(q.limits ?? {}) };
  const num = (x) => (x == null || !Number.isFinite(Number(x)) ? null : Math.max(0, Math.floor(Number(x))));
  const quota = num(option.quotaSlots);
  const load = num(option.loadSlots);
  const slots = Math.min(...[num(g.maxConcurrent) ?? 0, quota, load].filter((x) => x != null));
  q.limits = { ...(q.limits ?? {}), maxConcurrent: slots };

  // ---- The answer time for an open owner question ----
  const measured = SQ.responseTimesOf(queue);
  const answer =
    measured.length >= SQ.RESPONSE_TIME_MIN_COUNT
      ? { minutes: Math.round(CE.median(measured)), basis: 'measured', n: measured.length }
      : { minutes: DEFAULT_ANSWER_MIN, basis: 'default', n: 0 };

  // ---- The step each task has now (focus step, or null for the rest / no focus) ----
  const k0 = L.rankingContext(q, now);
  const open = q.tasks.filter((o) => !L.isExternalRow(o) && (o.status === 'waiting' || RUNNING.has(o.status)));
  const stepOf = new Map(open.map((o) => [o.id, k0.applies ? L.ranking(o, q, k0).step : null]));
  const byId = new Map(q.tasks.map((o) => [o.id, o]));

  const rows = new Map();
  const finishes = new Map();
  const answers = new Map();
  const base = (o) => ({
    id: o.id,
    title: o.title ?? null,
    class: o.class ?? null,
    status: o.status,
    step: stepOf.get(o.id) ?? null,
  });

  // ---- Running tasks: the remaining time, never below zero ----
  for (const o of open.filter((x) => RUNNING.has(x.status))) {
    const d = durationFor(o, model);
    const started = Date.parse(o.started ?? o.picked_at ?? '');
    const elapsed = Number.isFinite(started) ? Math.max(0, (now - started) / MIN) : 0;
    const remaining = Math.max(0, Math.round(lengthOf(o, d, elapsed) - elapsed));
    const end = now + remaining * MIN;
    finishes.set(o.id, end);
    rows.set(o.id, {
      ...base(o),
      start: Number.isFinite(started) ? iso(started) : iso(now),
      end: iso(end),
      minutes: d.minutes,
      remaining_min: remaining,
      basis: d.basis,
      n: d.n,
      rough: true,
      band: d.band,
      waits_on_you: false,
      answer_at: null,
      over_estimate: elapsed > d.minutes,
      running: true,
    });
  }

  // ---- Open owner questions: answered after the median answer time ----
  const waitsOnYou = new Set();
  for (const o of open.filter((x) => x.status === 'waiting')) {
    const qs = L.openQuestion(o, q.resolved);
    if (!qs.length) continue;
    waitsOnYou.add(o.id);
    for (const sp of qs) answers.set(sp, now + answer.minutes * MIN);
  }
  const answerAt = (o) => {
    const ts = (o.waiting_on ?? []).map((sp) => answers.get(sp) ?? null).filter((x) => x != null);
    return ts.length ? iso(Math.max(...ts)) : null;
  };
  const answerTimes = new Map(open.filter((o) => waitsOnYou.has(o.id)).map((o) => [o.id, answerAt(o)]));

  // ---- The event loop: finish, answer, start what selectNext gives, jump to the next event ----
  let t = now;
  const maxEvents = q.tasks.length * 6 + 1000;
  for (let e = 0; e < maxEvents; e += 1) {
    for (const [id, end] of finishes) {
      if (end > t) continue;
      const o = byId.get(id);
      o.status = 'done';
      o.done = iso(end);
      finishes.delete(id);
    }
    for (const [sp, ms] of answers) {
      if (ms > t) continue;
      if (!q.resolved.includes(sp)) q.resolved.push(sp);
      answers.delete(sp);
    }
    const night = L.nightGuard(q, t, tz).stop;
    // withIndex: the lookups are built once per call; the copy only changes between the calls.
    const chosen = L.withIndex(q.tasks, () => L.selectNext(q, t));
    if (!night) {
      for (const v of chosen) {
        const o = byId.get(v.id);
        const d = durationFor(o, model);
        o.status = 'running';
        o.started = iso(t);
        const end = t + lengthOf(o, d, 0) * MIN;
        finishes.set(o.id, end);
        rows.set(o.id, {
          ...base({ ...o, status: 'waiting' }),
          start: iso(t),
          end: iso(end),
          minutes: d.minutes,
          basis: d.basis,
          n: d.n,
          rough: true,
          band: d.band,
          waits_on_you: waitsOnYou.has(o.id),
          answer_at: answerTimes.get(o.id) ?? null,
          over_estimate: false,
          running: false,
        });
      }
    }
    const next = [...finishes.values(), ...answers.values()];
    if (night && chosen.length) {
      const wake = nightEnd(q, t, tz);
      if (wake != null) next.push(wake);
    }
    if (!next.length) break;
    t = Math.max(t + 1, Math.min(...next));
  }

  // ---- What never started, with the first reason the queue itself gives ----
  const kEnd = L.rankingContext(q, t);
  const unscheduled = open
    .filter((o) => o.status === 'waiting' && !rows.has(o.id))
    .map((o) => ({
      id: o.id,
      reason:
        L.blockersWithPause(o, q, kEnd)[0] ??
        'no slot opened in the simulation (the limits or an owned-file conflict)',
    }));
  const unscheduledIds = new Set(unscheduled.map((x) => x.id));

  // ---- Per focus step: how many tasks and the P50 end (the last expected end in the step) ----
  const groups = k0.applies
    ? q.focus.order.map((stage, i) => ({ step: i, stage, title: L.stepTitle(stage, q) }))
    : [{ step: null, stage: null, title: 'the whole queue' }];
  if (k0.applies && open.some((o) => stepOf.get(o.id) == null))
    groups.push({ step: null, stage: null, title: 'rest' });
  const tasks = [...rows.values()].sort(
    (x, y) => x.start.localeCompare(y.start) || x.end.localeCompare(y.end) || x.id.localeCompare(y.id),
  );
  const steps = groups.map((gr) => {
    const ids = open.filter((o) => (stepOf.get(o.id) ?? null) === gr.step).map((o) => o.id);
    const done = tasks.filter((r) => ids.includes(r.id));
    const last = done.length ? Math.max(...done.map((r) => Date.parse(r.end))) : null;
    return {
      ...gr,
      tasks: ids.length,
      scheduled: done.length,
      unscheduled: ids.filter((id) => unscheduledIds.has(id)).length,
      p50_end: last == null ? null : iso(last),
    };
  });
  const ends = tasks.map((r) => Date.parse(r.end));

  return {
    now: iso(now),
    rough: true,
    slots: {
      slots,
      maxConcurrent: num(g.maxConcurrent),
      quota,
      load,
      maxDPlus: g.maxDPlus,
      maxDb: g.maxDb,
    },
    answer,
    night: g.nightRun === false ? { off: true, window: g.nightWindow } : { off: false, window: null },
    tasks,
    unscheduled,
    proposed: (queue?.tasks ?? []).filter((o) => o.status === 'proposed').length,
    steps,
    end: ends.length ? iso(Math.max(...ends)) : null,
    precision:
      'Rough: for one task the middle half of measured outcomes spans a factor 2.5 to 3, so no task has a promised ' +
      'time; a focus step with many tasks evens out to roughly 25 to 40 % either way. This plays the queue as it is ' +
      'now: new tasks that rank in ahead, fix rounds and changes in quota or load are not in it.',
  };
}

/** "around Mon 14:30" in `tz`, rounded to the half hour (only for step ends, never for one task). */
function aroundText(ms, tz) {
  const half = 30 * MIN;
  const d = new Date(Math.round(ms / half) * half);
  const text = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);
  return `around ${text.replace(',', '')}`;
}

/**
 * The schedule as text lines for `ravenseat schedule`: the steps with the expected end, the next `next` tasks relative to
 * now (never a clock time per task), what cannot start, and the precision line.
 */
function scheduleLines(s, { tz = L.NIGHT_TZ, next = 5, band = null, backtest = null } = {}) {
  // T-C: the band per step (lib/scheduleUncertainty.js uncertainty) adds "likely by" (its P85) to the step's line.
  const bandFor = (st) =>
    band?.enough
      ? ((band.steps ?? []).find((b) => (st.step != null ? b.step === st.step : b.step == null && b.title === st.title)) ?? null)
      : null;
  const now = Date.parse(s.now);
  const inText = (ms) => (ms - now < 5 * MIN ? 'now' : `in about ${roughDuration((ms - now) / MIN)}`);
  const sl = s.slots;
  const parts = [`maxConcurrent ${sl.maxConcurrent}`];
  if (sl.quota != null) parts.push(`quota ${sl.quota}`);
  if (sl.load != null) parts.push(`load ${sl.load}`);
  const out = [
    `Schedule, played from the queue as it is now (${sl.slots} slot${sl.slots === 1 ? '' : 's'}: ` +
      `${parts.length > 1 ? `min of ${parts.join(', ')}` : parts[0]}` +
      `${s.night.off ? `; no starts in the night window ${s.night.window}` : ''}):`,
  ];
  const stepLine = (st, label) => {
    const n = `${st.tasks} task${st.tasks === 1 ? '' : 's'}`;
    const notIn = st.unscheduled ? `, ${st.unscheduled} cannot start` : '';
    if (st.p50_end == null) return `${label}: ${n}${notIn}, no expected end`;
    const end = Date.parse(st.p50_end);
    const b = bandFor(st);
    const likely = b ? `, likely by ${aroundText(Date.parse(b.p85_end), tz)} (P85)` : '';
    return `${label}: ${n}${notIn}, expected done ${inText(end)} (${aroundText(end, tz)})${likely}`;
  };
  if (s.steps.length === 1 && s.steps[0].stage == null && s.steps[0].title === 'the whole queue') {
    out.push(stepLine(s.steps[0], 'The whole queue'));
  } else {
    out.push('Focus steps:');
    for (const st of s.steps) out.push(`  ${stepLine(st, st.step == null ? 'rest' : `${st.step + 1} ${st.title}`)}`);
  }
  const upcoming = s.tasks.filter((r) => Date.parse(r.end) >= now).slice(0, next);
  if (upcoming.length) {
    out.push(`Next ${upcoming.length} (rough, from now):`);
    const w = Math.max(...upcoming.map((r) => r.id.length));
    for (const r of upcoming) {
      const head = `  ${r.id.padEnd(w)}  ${String(r.class ?? '-').padEnd(2)}  `;
      if (r.running) {
        out.push(
          head +
            (r.over_estimate
              ? 'running, over its estimate'
              : `running, about ${roughDuration(r.remaining_min)} left (rough)`),
        );
        continue;
      }
      const start = Date.parse(r.start);
      out.push(
        `${head}starts ${inText(start)}, takes about ${roughDuration(r.minutes)} (${r.band.label})` +
          (r.waits_on_you ? '; waits on you (an answer is assumed after the median answer time)' : ''),
      );
    }
  } else out.push('Nothing can start in the simulation.');
  if (s.unscheduled.length) {
    const shown = s.unscheduled.slice(0, 5).map((x) => `${x.id} (${x.reason})`);
    out.push(
      `${s.unscheduled.length} cannot start in the simulation: ${shown.join('; ')}` +
        (s.unscheduled.length > 5 ? `; and ${s.unscheduled.length - 5} more (--json)` : ''),
    );
  }
  if (s.proposed) out.push(`${s.proposed} proposed task${s.proposed === 1 ? ' is' : 's are'} not in the plan until approved.`);
  if (s.answer.basis === 'default')
    out.push(`Owner questions: an answer is assumed after ${roughDuration(s.answer.minutes)} (fewer than 5 measured answers).`);
  out.push(s.precision);
  if (band && !band.enough && band.reason) out.push(band.reason);
  if (band?.agree?.text) out.push(band.agree.text);
  if (backtest?.text) out.push(backtest.text);
  return out;
}

module.exports = {
  DEFAULT_ANSWER_MIN,
  BAND,
  quantile,
  ratioSamples,
  ratioModel,
  roughDuration,
  durationFor,
  quotaSlotsFrom,
  schedule,
  scheduleLines,
};
