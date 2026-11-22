// =============================================================
// timelineLayout.js: the pure layout of the board's Timeline tab (roadmap TIDSLINJE T-A; plans: gantt investigation
// 2026-11-18, sections 4 and 6).
//
// Input is what GET /api/schedule sends (lib/queueTimeline.js): the schedule from lib/queueSchedule.js as it is, the
// tasks that ran in the last day, and the project of each task. Nothing here plays the queue or knows a queue rule; it
// only turns times into rows, lanes and pixels, and into the table for screen readers:
//   - windowOf, scale, ticks: the time axis. It starts at the earliest ran or running start (at most a day back) and
//     ends at now + the horizon (board.timelineHorizonDays).
//   - packLanes: overlapping bars of one row go to separate lanes (first free lane).
//   - buildRows: the ran and running part first, then one row per focus step in the schedule's order (rest last) or
//     one per project (board.timelineRows). A task that starts after the horizon is counted (later), not drawn.
//   - layout: the y of each row and the geometry of each bar: the band of a planned bar (start + low to start + high),
//     a wait on the owner as its own segment, the phases of a ran bar (track, review).
//   - tableRows: the same tasks as a table, with relative times only.
// HONESTY: no text here gives a clock time for one task (the measured spread per task is a factor 2.5 to 3); a step's
// end is the only time the renderer may show as "around".
//
// The file is both a CommonJS module (the tests) and a script in the browser (queue-board.mjs serves it as
// /timelineLayout.js and it sets window.QueueTimelineLayout), so the board uses exactly the tested code.
// Drawn by queue-board/board/timeline.js. Tested in lib/__tests__/timelineLayout.test.ts.
// =============================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QueueTimelineLayout = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MIN = 60_000;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  /** The horizon when the setting is missing or not a number, and its bounds (board.timelineHorizonDays). */
  const HORIZON = Object.freeze({ standard: 3, min: 1, max: 14 });
  /** How far back the ran part reaches at most, and the margin before now when nothing ran. */
  const LOOKBACK = DAY;
  const MARGIN = HOUR;
  /** The least distance between two ticks on the axis, in pixels. */
  const MIN_TICK_PX = 56;
  /** The tick steps tried in order, in hours (the first that keeps MIN_TICK_PX wins). */
  const TICK_STEPS = [1, 2, 3, 6, 12, 24, 48, 168];
  /** Row geometry in pixels: the row's title line, one lane, the gap after a row. */
  const SIZE = Object.freeze({ head: 22, lane: 26, gap: 10, bar: 16 });

  /**
   * "15 min", "2.5 h", "3 d": a rough length. The same text as queueSchedule.roughDuration (a test locks it), copied
   * because that file is not a browser script.
   */
  function roughDuration(min) {
    const m = Math.max(0, Number(min) || 0);
    const five = Math.max(5, Math.round(m / 5) * 5);
    if (five < 60) return `${five} min`;
    if (m < 48 * 60) return `${Math.round((m / 60) * 2) / 2} h`;
    return `${Math.round(m / 1440)} d`;
  }

  /** "now", "in about 2 h" or "about 3 h ago": a moment relative to now, never a clock time. */
  function relativeText(ms, now) {
    const d = ms - now;
    if (Math.abs(d) < 5 * MIN) return 'now';
    return d > 0 ? `in about ${roughDuration(d / MIN)}` : `about ${roughDuration(-d / MIN)} ago`;
  }

  /** The horizon in days: a whole number 1 to 14; anything that is not a number gives 3. */
  function horizonDays(v) {
    const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
    if (!Number.isFinite(n)) return HORIZON.standard;
    return Math.min(HORIZON.max, Math.max(HORIZON.min, Math.round(n)));
  }

  const ms = (v) => {
    const x = Date.parse(v ?? '');
    return Number.isFinite(x) ? x : null;
  };

  /** The time window: { from, to, now } in ms. */
  function windowOf(d, option = {}) {
    const s = d?.schedule ?? {};
    const now = ms(s.now) ?? Date.now();
    const starts = [
      ...(d?.ran ?? []).map((r) => ms(r.start)),
      ...(s.tasks ?? []).filter((r) => r.running).map((r) => ms(r.start)),
    ].filter((x) => x != null);
    const from = starts.length ? Math.max(now - LOOKBACK, Math.min(Math.min(...starts), now - MARGIN)) : now - MARGIN;
    return { from, to: now + horizonDays(option.horizonDays) * DAY, now };
  }

  /** The linear scale from the window to 0..width pixels, clamped (one decimal, so the SVG stays small). */
  function scale(w, width) {
    const span = Math.max(1, w.to - w.from);
    const x = (t) => Math.round(Math.min(width, Math.max(0, ((t - w.from) / span) * width)) * 10) / 10;
    return { x, width, from: w.from, to: w.to, now: w.now };
  }

  // One formatter per time zone (the browser's own when tz is undefined).
  const formatters = new Map();
  function partsOf(t, tz) {
    const key = tz ?? '';
    if (!formatters.has(key))
      formatters.set(
        key,
        new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', hour: '2-digit', hourCycle: 'h23' }),
      );
    const p = {};
    for (const x of formatters.get(key).formatToParts(new Date(t))) p[x.type] = x.value;
    return { weekday: p.weekday, day: p.day, hour: Number(p.hour) % 24 };
  }

  /**
   * The ticks of the axis: { ms, label, major }. Whole hours in `tz` (the browser's by default), every `step` hours,
   * the step the first of TICK_STEPS that keeps MIN_TICK_PX between ticks. Midnight is major and says the day
   * ("Mon 23"), the rest the hour ("14:00").
   */
  function ticks(w, width, option = {}) {
    const span = Math.max(1, w.to - w.from);
    const perHour = (HOUR / span) * width;
    const step = TICK_STEPS.find((h) => h * perHour >= MIN_TICK_PX) ?? TICK_STEPS[TICK_STEPS.length - 1];
    const out = [];
    let dayIndex = 0;
    for (let t = Math.ceil(w.from / HOUR) * HOUR; t <= w.to; t += HOUR) {
      const p = partsOf(t, option.tz);
      const midnight = p.hour === 0;
      const take = step < 24 ? p.hour % step === 0 : midnight && dayIndex % (step / 24) === 0;
      if (midnight) dayIndex += 1;
      if (!take) continue;
      out.push({
        ms: t,
        major: midnight,
        label: midnight ? `${p.weekday} ${p.day}` : `${String(p.hour).padStart(2, '0')}:00`,
      });
    }
    return out;
  }

  /** Puts overlapping items ({ s, e }) in separate lanes: { items (with lane), lanes }. */
  function packLanes(items) {
    const sorted = [...items].sort((x, y) => x.s - y.s || x.e - y.e);
    const ends = [];
    const out = sorted.map((it) => {
      let lane = ends.findIndex((end) => end <= it.s);
      if (lane < 0) lane = ends.push(0) - 1;
      ends[lane] = Math.max(it.e, it.s + 1);
      return { ...it, lane };
    });
    return { items: out, lanes: ends.length };
  }

  /** The item of a planned task: start, end, the band in ms, and the owner wait. */
  function plannedItem(r) {
    const s = ms(r.start);
    const e = ms(r.end);
    const low = r.band?.low_min ?? r.minutes;
    const high = r.band?.high_min ?? r.minutes;
    return {
      id: r.id,
      title: r.title ?? '',
      class: r.class ?? null,
      kind: 'planned',
      s,
      e,
      band: { low: s + low * MIN, high: s + high * MIN, label: r.band?.label ?? 'rough' },
      waitsOnYou: r.waits_on_you === true,
      step: r.step ?? null,
    };
  }

  /** The item of a running task: started, expected end, remaining minutes, over its estimate. */
  function runningItem(r) {
    const s = ms(r.start);
    return {
      id: r.id,
      title: r.title ?? '',
      class: r.class ?? null,
      kind: 'running',
      s,
      e: ms(r.end),
      remaining: r.remaining_min ?? 0,
      over: r.over_estimate === true,
      band: { low: s + (r.band?.low_min ?? 0) * MIN, high: s + (r.band?.high_min ?? 0) * MIN, label: r.band?.label ?? 'rough' },
    };
  }

  /** The item of a task that ran: start, delivered (end of the track phase), end. */
  function ranItem(r) {
    return {
      id: r.id,
      title: r.title ?? '',
      class: r.class ?? null,
      kind: 'ran',
      s: ms(r.start),
      e: ms(r.end),
      delivered: ms(r.delivered),
    };
  }

  /** How far an item reaches on the axis (its band or wait included), for the lane packing. */
  function reach(it, now) {
    const s = it.waitsOnYou ? Math.min(it.s, now) : it.s;
    const e = it.kind === 'ran' ? it.e : Math.max(it.e, it.band?.high ?? it.e);
    return { s, e };
  }

  /** Lanes for the drawn items of a row (the later ones are kept for the table only). */
  function withLanes(group, now) {
    const packed = packLanes(group.items.map((it, i) => ({ i, ...reach(it, now) })));
    const items = packed.items.map((p) => ({ ...group.items[p.i], lane: p.lane }));
    return { ...group, items, lanes: packed.lanes };
  }

  /**
   * The rows: [{ key, kind: 'ran'|'step'|'project', title, items, laterItems, later, unscheduled, end, lanes }].
   * by 'step' (default) or 'project'.
   */
  function buildRows(d, option = {}) {
    const s = d?.schedule ?? {};
    const w = windowOf(d, option);
    const now = w.now;
    const by = option.by === 'project' ? 'project' : 'step';
    const rows = [];

    const ranItems = [
      ...(d?.ran ?? []).map(ranItem),
      ...(s.tasks ?? []).filter((r) => r.running).map(runningItem),
    ].filter((it) => it.s != null && it.e != null);
    ranItems.sort((x, y) => x.s - y.s || x.id.localeCompare(y.id));
    if (ranItems.length)
      rows.push({ key: 'ran', kind: 'ran', title: 'Ran and running', items: ranItems, laterItems: [], later: 0, unscheduled: 0, end: null });

    const planned = (s.tasks ?? []).filter((r) => !r.running).map(plannedItem).filter((it) => it.s != null && it.e != null);
    planned.sort((x, y) => x.s - y.s || x.id.localeCompare(y.id));
    const split = (items) => ({ items: items.filter((it) => it.s < w.to), laterItems: items.filter((it) => it.s >= w.to) });

    if (by === 'step') {
      const steps = s.steps ?? [];
      const whole = steps.length === 1 && steps[0].stage == null && steps[0].title === 'the whole queue';
      for (const st of steps) {
        const mine = planned.filter((it) => (it.step ?? null) === (st.step ?? null));
        if (!mine.length && !st.unscheduled) continue;
        const end = ms(st.p50_end);
        rows.push({
          key: `step:${st.step ?? 'rest'}`,
          kind: 'step',
          title: st.step == null ? (whole ? 'Planned' : 'Rest') : `${st.step + 1} ${st.title ?? ''}`.trim(),
          ...split(mine),
          later: mine.filter((it) => it.s >= w.to).length,
          unscheduled: st.unscheduled ?? 0,
          end: end != null && end <= w.to ? end : null,
        });
      }
    } else {
      const pid = (id) => d?.projects?.[id] ?? 'without-project';
      const title = (p) => d?.projectTitles?.[p] ?? (p === 'without-project' ? 'Without project' : p);
      const order = [];
      const per = new Map();
      for (const it of planned) {
        const p = pid(it.id);
        if (!per.has(p)) {
          per.set(p, []);
          order.push(p);
        }
        per.get(p).push(it);
      }
      const cannot = new Map();
      for (const u of s.unscheduled ?? []) {
        const p = pid(u.id);
        cannot.set(p, (cannot.get(p) ?? 0) + 1);
        if (!per.has(p)) {
          per.set(p, []);
          order.push(p);
        }
      }
      for (const p of order) {
        const mine = per.get(p);
        rows.push({
          key: `project:${p}`,
          kind: 'project',
          title: title(p),
          ...split(mine),
          later: mine.filter((it) => it.s >= w.to).length,
          unscheduled: cannot.get(p) ?? 0,
          end: null,
        });
      }
    }
    return rows.map((r) => withLanes(r, now));
  }

  /** The words for one bar (its aria-label and tooltip). Never a clock time. */
  function labelOf(it, now) {
    const head = `${it.id}${it.title ? ` ${it.title}` : ''}`;
    if (it.kind === 'ran') return `${head}: ran, took about ${roughDuration((it.e - it.s) / MIN)}`;
    if (it.kind === 'running')
      return `${head}: running, ${it.over ? 'over its estimate' : `about ${roughDuration(it.remaining)} left (rough)`}`;
    return `${head}: starts ${relativeText(it.s, now)}, ${it.band.label}${it.waitsOnYou ? ', waits on you first' : ''}`;
  }

  /**
   * The geometry: { height, groups: [{ key, kind, title, y, h, lanes, end, endX, later, unscheduled }], bars: [...] }.
   * A bar: { id, title, class, kind, x0, x1, y, h, label, clippedLeft, clippedRight } plus bandX0/bandX1 (planned,
   * running), wait { x0, x1 } (planned that waits on the owner), nowX (running), phases [{ phase, x0, x1 }] (ran).
   */
  function layout(rows, sc) {
    const groups = [];
    const bars = [];
    let y = 0;
    for (const r of rows) {
      const lanes = Math.max(1, r.lanes);
      const h = SIZE.head + lanes * SIZE.lane + SIZE.gap;
      groups.push({
        key: r.key,
        kind: r.kind,
        title: r.title,
        y,
        h,
        lanes: r.lanes,
        end: r.end,
        endX: r.end == null ? null : sc.x(r.end),
        later: r.later,
        unscheduled: r.unscheduled,
      });
      for (const it of r.items) {
        const b = {
          id: it.id,
          title: it.title,
          class: it.class,
          kind: it.kind,
          row: r.key,
          x0: sc.x(it.s),
          x1: sc.x(it.e),
          y: y + SIZE.head + it.lane * SIZE.lane + (SIZE.lane - SIZE.bar) / 2,
          h: SIZE.bar,
          label: labelOf(it, sc.now),
          clippedLeft: it.s < sc.from,
          clippedRight: it.e > sc.to,
        };
        if (it.kind === 'planned') {
          b.bandX0 = sc.x(it.band.low);
          b.bandX1 = sc.x(it.band.high);
          b.wait = it.waitsOnYou ? { x0: sc.x(sc.now), x1: sc.x(it.s) } : null;
        }
        if (it.kind === 'running') {
          b.nowX = sc.x(sc.now);
          b.over = it.over;
          b.bandX0 = sc.x(Math.max(sc.now, it.band.low));
          b.bandX1 = sc.x(Math.max(sc.now, it.band.high));
        }
        if (it.kind === 'ran') {
          const cut = it.delivered != null && it.delivered > it.s && it.delivered < it.e ? it.delivered : it.e;
          b.phases = [{ phase: 'track', x0: sc.x(it.s), x1: sc.x(cut) }];
          if (cut < it.e) b.phases.push({ phase: 'review', x0: sc.x(cut), x1: sc.x(it.e) });
        }
        bars.push(b);
      }
      y += h;
    }
    return { height: y, groups, bars };
  }

  /**
   * The table of the same data: { columns, rows: [{ id, title, row, state, starts, takes, note }] }, row by row as the
   * chart (later ones after the drawn ones of their row), then the tasks that cannot start with their reason.
   */
  function tableRows(rows, d, option = {}) {
    const now = option.now ?? ms(d?.schedule?.now) ?? Date.now();
    const out = [];
    for (const r of rows) {
      for (const it of [...r.items, ...(r.laterItems ?? [])]) {
        const later = (r.laterItems ?? []).includes(it);
        const base = { id: it.id, title: it.title, row: r.title, starts: relativeText(it.s, now) };
        if (it.kind === 'ran') out.push({ ...base, state: 'Ran', takes: `took about ${roughDuration((it.e - it.s) / MIN)}`, note: '' });
        else if (it.kind === 'running')
          out.push({
            ...base,
            state: 'Running',
            takes: it.over ? 'over its estimate' : `about ${roughDuration(it.remaining)} left (rough)`,
            note: '',
          });
        else
          out.push({
            ...base,
            state: it.waitsOnYou ? 'Waits on you' : 'Planned',
            takes: it.band.label,
            note: [
              it.waitsOnYou ? 'an answer is assumed after the median answer time' : '',
              later ? 'starts after the horizon' : '',
            ]
              .filter(Boolean)
              .join('; '),
          });
      }
    }
    const pid = (id) => d?.projects?.[id] ?? null;
    for (const u of d?.schedule?.unscheduled ?? [])
      out.push({
        id: u.id,
        title: d?.titles?.[u.id] ?? '',
        row: pid(u.id) ? (d?.projectTitles?.[pid(u.id)] ?? pid(u.id)) : '',
        state: 'Cannot start',
        starts: '',
        takes: '',
        note: u.reason ?? '',
      });
    return { columns: ['Task', 'Row', 'State', 'Starts', 'Takes', 'Note'], rows: out };
  }

  return {
    MIN_TICK_PX,
    HORIZON,
    SIZE,
    roughDuration,
    relativeText,
    horizonDays,
    windowOf,
    scale,
    ticks,
    packLanes,
    buildRows,
    layout,
    tableRows,
  };
});
