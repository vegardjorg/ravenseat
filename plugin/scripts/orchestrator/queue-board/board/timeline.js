// =============================================================
// timeline.js: the Timeline tab (roadmap TIDSLINJE T-A; plans: gantt investigation 2026-11-18). Read only.
//
// Fetches GET /api/schedule (the queue played forward by lib/queueSchedule.js, the tasks that ran in the last day and the
// project of each task) and draws it with the pure layout in lib/timelineLayout.js (window.QueueTimelineLayout):
//   - Chart: a fixed column with the row titles and a scrolling inline SVG (no library): the time axis with ticks, a
//     now line, the ran and running part first, then one row per focus step (or per project). A planned bar is rough:
//     the thin line through it is its likely range, and its words never give a clock time. A hatched, dashed part
//     waits on the owner. Only the chart container scrolls sideways, never the page.
//   - Table: the same tasks with proper headers, for screen readers and for copying.
//   - Under both: the tasks that cannot start with the reason, and the precision line.
// The settings: board.timeline (the tab), board.timelineHorizonDays (days ahead), board.timelineRows (the default rows;
// this browser can switch, remembered in localStorage). Colors only from the theme tokens (board.css .tl-*).
// T-B: with board.timelineDrag on, order can be changed here (never time): board/timelinemove.js has the drag, the
// keyboard moves, the preview and the save; this file marks what can move and calls it.
//
// One of the board's classic scripts in queue-board/board/ (see docs/board.md): top-level names are shared with the
// other scripts. Called from draw() (board/draw.js) and the polling (api.js, start.js). Tested in
// lib/__tests__/queueBoardTimeline.test.ts.
// =============================================================
'use strict';

const TL_NS = 'http://www.w3.org/2000/svg';
const TL_STORE = 'queue-board-timeline';
/** The height of the time axis above the rows, the least pixels per hour, and the row title column. */
const TL_AXIS = 30;
const TL_PX_PER_HOUR = 9;

/** Is the Timeline tab on (board.timeline in the state)? */
function timelineOn() {
  return t.data?.boardTimeline?.on === true;
}

/** This browser's choices: { display: 'chart'|'table', rows: 'step'|'project'|null } (null rows: the setting). */
function timelinePrefs() {
  try {
    const v = JSON.parse(store.getItem(TL_STORE) ?? '{}') ?? {};
    return {
      display: v.display === 'table' ? 'table' : 'chart',
      rows: v.rows === 'step' || v.rows === 'project' ? v.rows : null,
    };
  } catch {
    return { display: 'chart', rows: null };
  }
}
function saveTimelinePrefs(p) {
  store.setItem(TL_STORE, JSON.stringify(p));
}
const timelineRows = () => timelinePrefs().rows ?? (t.data?.boardTimeline?.rows === 'project' ? 'project' : 'step');

/**
 * The data-focus key of what had focus in the view (a switch button, a bar, a table link), so a redraw (new data, a
 * switch) puts focus back on the same thing instead of dropping it to the page.
 */
let tlFocus = null;

let fetchingTimeline = false;
/**
 * Fetches the schedule (the server answers "unchanged" for the version the board has). Draws when it changed, or
 * always with `redraw` (after a new state, whose draw was left to this fetch).
 */
async function getTimeline(redraw = false) {
  if (!t.key || !timelineOn()) {
    if (redraw && t.view === 'timeline') draw();
    return;
  }
  if (fetchingTimeline) return;
  fetchingTimeline = true;
  let changed = redraw;
  try {
    const q = t.timeline.version ? `?version=${encodeURIComponent(t.timeline.version)}` : '';
    const answer = await api(`/api/schedule${q}`);
    if (t.timeline.error) changed = true;
    t.timeline.error = null;
    if (!answer.unchanged) {
      t.timeline.data = answer.data;
      t.timeline.version = answer.version;
      changed = true;
    }
  } catch (e) {
    changed = changed || t.timeline.error !== e.message;
    t.timeline.error = e.message;
  } finally {
    fetchingTimeline = false;
    // T-B: while a move is lifted or previewed the redraw waits (board/timelinemove.js catches up afterwards).
    if (changed && t.view === 'timeline') {
      if (tlHeld()) t.pending = true;
      else draw();
    }
  }
}

/** An SVG element with attributes (text via the `text` key, never as markup). */
function svgEl(tag, attr = {}, ...children) {
  const e = document.createElementNS(TL_NS, tag);
  for (const [k, v] of Object.entries(attr)) {
    if (v == null || v === false) continue;
    if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, String(v));
  }
  for (const c of children.flat()) if (c) e.append(c);
  return e;
}

/** A segmented switch (role group, aria-pressed), as the graph's Setup and the Plans views use. */
function timelineSwitch(label, options, current, choose) {
  return el(
    'div',
    { class: 'toggles tl-switch', role: 'group', 'aria-label': label },
    ...options.map(([value, text]) =>
      el('button', {
        type: 'button',
        class: 'toggles-button',
        'aria-pressed': value === current ? 'true' : 'false',
        'data-focus': `tl:${label}:${value}`,
        text,
        onclick: () => {
          if (value === current) return;
          choose(value);
          tlFocus = `tl:${label}:${value}`;
          draw();
        },
      }),
    ),
  );
}

/** "around Mon 14:30" for a step's end (rounded to the half hour): the only time the tab shows as a clock. */
function aroundStepEnd(ms) {
  const half = 30 * 60_000;
  const d = new Date(Math.round(ms / half) * half);
  const text = new Intl.DateTimeFormat('en-GB', { weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  return `around ${text.replace(',', '')}`;
}

/** The words under a row title: the step's end, the later ones and the ones that cannot start. */
function rowNotes(g) {
  const out = [];
  if (g.end != null) out.push(`done ${aroundStepEnd(g.end)}`);
  if (g.later) out.push(`${g.later} after the horizon`);
  if (g.unscheduled) out.push(`${g.unscheduled} cannot start`);
  return out.join(', ');
}

/** The chart: the fixed title column and the scrolling SVG. */
// A turned phone or a narrowed window gets the chart again at its new width (the title column, the pixel scale and the
// lanes all follow it), at most once per 150 ms while the window is dragged, and only when the width really changed.
let tlDrawnWidth = 0;
let tlResizeTimer = 0;
window.addEventListener('resize', () => {
  if (tlResizeTimer) return;
  tlResizeTimer = setTimeout(() => {
    tlResizeTimer = 0;
    if (t.view !== 'timeline' || !t.timeline.data) return;
    if (Math.abs((main.clientWidth || 1000) - tlDrawnWidth) >= 16) draw();
  }, 150);
});

function timelineChart(d, rows, horizon) {
  const TL = window.QueueTimelineLayout;
  tlDrawnWidth = main.clientWidth || 1000;
  const w = TL.windowOf(d, { horizonDays: horizon });
  const narrow = (main.clientWidth || 1000) < 640;
  const titleWidth = narrow ? 104 : 190;
  const room = Math.max(200, (main.clientWidth || 1000) - titleWidth - (narrow ? 34 : 50));
  const hours = (w.to - w.from) / 3_600_000;
  const width = Math.round(Math.max(room, hours * TL_PX_PER_HOUR * (narrow ? 1 : 0.5)));
  const sc = TL.scale(w, width);
  const lay = TL.layout(rows, sc);
  const height = TL_AXIS + lay.height;
  const svg = svgEl('svg', {
    class: 'tl-svg',
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    role: 'group',
    'aria-label': `Timeline chart, ${horizon} day${horizon === 1 ? '' : 's'} ahead. The table view has the same tasks.`,
  });
  // The hatch for "waits on you" (a pattern as well as a color, so color is never the only signal).
  svg.append(
    svgEl(
      'defs',
      {},
      svgEl(
        'pattern',
        { id: 'tl-hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
        svgEl('rect', { class: 'tl-hatch-bg', width: 6, height: 6 }),
        svgEl('line', { class: 'tl-hatch-line', x1: 0, y1: 0, x2: 0, y2: 6 }),
      ),
    ),
  );
  // The axis: ticks with labels, a line per tick down through the rows (stronger at midnight).
  const axis = svgEl('g', { class: 'tl-axis', 'aria-hidden': 'true' });
  const nowAt = sc.x(w.now);
  for (const k of TL.ticks(w, width)) {
    const x = sc.x(k.ms);
    axis.append(svgEl('line', { class: k.major ? 'tl-grid major' : 'tl-grid', x1: x, x2: x, y1: TL_AXIS - 6, y2: height }));
    // A tick's label right at the "now" word would touch it; the grid line stays, the word "now" wins.
    if (!k.major && x > nowAt - 34 && x < nowAt + 26) continue;
    axis.append(svgEl('text', { class: k.major ? 'tl-tick major' : 'tl-tick', x: x + 3, y: 13, text: k.label }));
  }
  axis.append(svgEl('line', { class: 'tl-axis-line', x1: 0, x2: width, y1: TL_AXIS - 0.5, y2: TL_AXIS - 0.5 }));
  svg.append(axis);
  // The rows: a line between them and the notes in each row's head line, after the now line so they are in view.
  const nowX = sc.x(w.now);
  const heads = svgEl('g', { class: 'tl-rows', 'aria-hidden': 'true' });
  for (const g of lay.groups) {
    const y = TL_AXIS + g.y;
    if (g.y > 0) heads.append(svgEl('line', { class: 'tl-row-line', x1: 0, x2: width, y1: y + 0.5, y2: y + 0.5 }));
    const note = rowNotes(g);
    if (note) heads.append(svgEl('text', { class: 'tl-row-note', x: Math.min(width - 4, nowX + 6), y: y + 15, text: note }));
    if (g.endX != null) {
      const top = y + 20;
      const bottom = y + g.h - 6;
      heads.append(svgEl('line', { class: 'tl-step-end', x1: g.endX, x2: g.endX, y1: top, y2: bottom }));
      heads.append(svgEl('path', { class: 'tl-step-end-mark', d: `M${g.endX} ${top - 5} l4 5 l-4 5 l-4 -5 z` }));
    }
  }
  svg.append(heads);
  // The bars: each one a button (Enter opens the card) with its words as the name; the title is the tooltip. T-B: a
  // planned bar in a step row can also be moved (board/timelinemove.js: Space lifts, or drag it up or down).
  const bars = svgEl('g', { class: 'tl-bars' });
  for (const b of lay.bars) {
    const y = TL_AXIS + b.y;
    const mid = y + b.h / 2;
    const movable = tlMovable(b.id);
    const g = svgEl('g', {
      class: `tl-bar ${b.kind}${b.over ? ' over' : ''}${movable && t.marked.has(b.id) ? ' marked' : ''}`,
      role: 'button',
      tabindex: '0',
      'aria-label': b.label,
      'aria-describedby': movable ? 'tl-move-help' : null,
      'data-id': b.id,
      'data-focus': `tl:bar:${b.id}`,
      'data-movable': movable ? 'true' : null,
      onclick: (e) => {
        if (tlBarClick(e, b)) return;
        openPanel(b.id);
      },
      onpointerdown: movable ? (e) => tlPointerDown(e, { id: b.id }) : null,
      onkeydown: (e) => {
        if (tlBarKey(e, b)) return;
        if (e.key !== 'Enter' && e.key !== ' ') return;
        e.preventDefault();
        openPanel(b.id);
      },
    });
    g.append(svgEl('title', { text: b.label }));
    const rect = (cls, x0, x1, yy = y, hh = b.h) =>
      svgEl('rect', { class: cls, x: x0, y: yy, width: Math.max(2, x1 - x0), height: hh, rx: 3 });
    if (b.kind === 'ran') {
      for (const p of b.phases)
        g.append(p.phase === 'review' ? rect('tl-review', p.x0, p.x1, y + b.h / 4, b.h / 2) : rect('tl-track', p.x0, p.x1));
    } else if (b.kind === 'running') {
      g.append(rect('tl-ran-part', b.x0, b.nowX));
      if (b.x1 > b.nowX) g.append(rect('tl-rest-part', b.nowX, b.x1));
    } else {
      if (b.wait && b.wait.x1 > b.wait.x0) g.append(rect('tl-wait', b.wait.x0, b.wait.x1));
      g.append(rect('tl-planned', b.x0, b.x1));
    }
    // The likely range (rough): a thin line with end ticks, through the bar.
    if (b.bandX0 != null && b.bandX1 > b.bandX0) {
      g.append(svgEl('line', { class: 'tl-band', x1: b.bandX0, x2: b.bandX1, y1: mid, y2: mid }));
      for (const x of [b.bandX0, b.bandX1]) g.append(svgEl('line', { class: 'tl-band', x1: x, x2: x, y1: mid - 4, y2: mid + 4 }));
    }
    if (b.clippedRight) g.append(svgEl('path', { class: 'tl-more', d: `M${width - 7} ${y + 2} l5 ${b.h / 2 - 2} l-5 ${b.h / 2 - 2}` }));
    // The label place comes from the layout (inside when it fits, else after the bar), which also packed the lanes so
    // that labels outside their bar never overlap.
    const where = !b.text.inside ? ' outside' : b.text.on === 'rest' ? ' on-rest' : '';
    g.append(svgEl('text', { class: `tl-bar-text${where}`, x: b.text.x, y: mid + 4, text: b.id }));
    bars.append(g);
  }
  svg.append(bars);
  // The now line over everything, with its word in the axis.
  svg.append(
    svgEl(
      'g',
      { class: 'tl-now', 'aria-hidden': 'true' },
      svgEl('line', { x1: nowX, x2: nowX, y1: 0, y2: height }),
      svgEl('text', { x: nowX + 4, y: TL_AXIS - 9, text: 'now' }),
    ),
  );

  // T-B: a focus step's title is a button that moves the step (Space lifts, or drag it up or down); the other titles
  // stay hidden from screen readers (the bars and the table carry the same words).
  const stepMoves = tlDragOn() && tlSteps.length > 1;
  const titles = el(
    'div',
    // Sizes as CSS variables through the style object (the CSP allows no style attribute).
    { class: 'tl-titles', '--tl-w': `${titleWidth}px`, 'aria-hidden': stepMoves ? null : 'true' },
    el('div', { class: 'tl-title-axis', '--tl-h': `${TL_AXIS}px`, 'aria-hidden': 'true' }),
    ...lay.groups.map((g) => {
      const moves = stepMoves && g.stage != null && tlSteps.some((s) => s.stage === g.stage);
      return el(
        'div',
        {
          class: `tl-title ${g.kind}${moves ? ' movable' : ''}`,
          '--tl-h': `${g.h}px`,
          'data-stage': g.stage ?? null,
          ...(moves
            ? {
                role: 'button',
                tabindex: '0',
                'aria-label': `Step ${g.step + 1} (${g.name})`,
                'aria-describedby': 'tl-step-help',
                'data-focus': `tl:step:${g.stage}`,
                onkeydown: (e) => tlStepKey(e, g.stage),
                onpointerdown: (e) => tlPointerDown(e, { stage: g.stage }),
              }
            : { 'aria-hidden': stepMoves ? 'true' : null }),
        },
        el('span', { class: 'tl-title-text', text: g.title }),
      );
    }),
  );
  tlSetChart(svg, lay);
  const scroller = el('div', { class: 'tl-scroll', tabindex: '0', role: 'region', 'aria-label': 'Timeline chart, scrolls sideways' }, svg);
  const frame = el('div', { class: 'tl-frame' }, titles, scroller);
  // Start with the now line near the left when the chart is wider than its box (the ran part a scroll away).
  window.requestAnimationFrame?.(() => {
    if (scroller.scrollWidth > scroller.clientWidth) scroller.scrollLeft = Math.max(0, nowX - scroller.clientWidth * 0.25);
  });
  return frame;
}

/** The legend: each mark with its word (shapes and patterns as well as colors). */
function timelineLegend() {
  const item = (cls, text) =>
    el(
      'li',
      { class: 'tl-legend-item' },
      (() => {
        const s = svgEl('svg', { class: 'tl-legend-mark', width: 28, height: 14, viewBox: '0 0 28 14', 'aria-hidden': 'true' });
        if (cls === 'tl-band') {
          s.append(svgEl('line', { class: 'tl-band', x1: 2, x2: 26, y1: 7, y2: 7 }));
          s.append(svgEl('line', { class: 'tl-band', x1: 2, x2: 2, y1: 3, y2: 11 }));
          s.append(svgEl('line', { class: 'tl-band', x1: 26, x2: 26, y1: 3, y2: 11 }));
        } else if (cls === 'tl-now') s.append(svgEl('line', { class: 'tl-now-mark', x1: 14, x2: 14, y1: 0, y2: 14 }));
        else if (cls === 'tl-step-end') s.append(svgEl('path', { class: 'tl-step-end-mark', d: 'M14 2 l5 5 l-5 5 l-5 -5 z' }));
        else if (cls === 'tl-review') s.append(svgEl('rect', { class: cls, x: 1, y: 4, width: 26, height: 6, rx: 2 }));
        else s.append(svgEl('rect', { class: cls, x: 1, y: 1, width: 26, height: 12, rx: 3 }));
        return s;
      })(),
      el('span', { text }),
    );
  return el(
    'ul',
    { class: 'tl-legend', 'aria-label': 'Legend' },
    item('tl-track', 'Ran (track)'),
    item('tl-review', 'Review and merge'),
    item('tl-ran-part', 'Running'),
    item('tl-planned', 'Planned, rough'),
    item('tl-band', 'Likely range'),
    item('tl-wait', 'Waits on you'),
    item('tl-step-end', 'Step done, around'),
    item('tl-now', 'Now'),
  );
}

/** The table view: the same tasks, with column and row headers. */
function timelineTable(d, rows) {
  const tb = window.QueueTimelineLayout.tableRows(rows, d);
  // T-B: with the drag on, a planned task in a step row has Move up and Move down (the same preview as a drop).
  const moves = tlPlace.size > 0;
  const moveCell = (id) => {
    const p = tlPlace.get(id);
    if (!p) return el('td', {});
    const i = p.order.indexOf(id);
    const button = (dir, delta, off) =>
      el('button', {
        type: 'button',
        class: 'button button-muted button-small',
        text: `Move ${dir}`,
        'aria-label': `Move ${id} ${dir}`,
        'data-focus': `tl:mv:${id}:${dir}`,
        disabled: off,
        onclick: () => tlTableMove(id, delta),
      });
    return el('td', { class: 'tl-move-cell' }, button('up', -1, i <= 0), button('down', 1, i >= p.order.length - 1));
  };
  return el(
    'div',
    { class: 'tl-table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Timeline table' },
    el(
      'table',
      { class: 'tl-table' },
      el('caption', { text: 'The timeline as a table: rough, relative times only' }),
      el(
        'thead',
        {},
        el('tr', {}, ...tb.columns.map((c) => el('th', { scope: 'col', text: c })), moves ? el('th', { scope: 'col', text: 'Order' }) : null),
      ),
      el(
        'tbody',
        {},
        ...tb.rows.map((r) =>
          el(
            'tr',
            { class: `tl-row-${r.state.toLowerCase().replace(/\s+/g, '-')}` },
            el(
              'th',
              { scope: 'row' },
              el('button', { type: 'button', class: 'link-button', text: r.id, 'data-focus': `tl:row:${r.id}`, onclick: () => openPanel(r.id) }),
              r.title ? el('span', { class: 'tl-table-title', text: ` ${r.title}` }) : null,
            ),
            el('td', { text: r.row || '-' }),
            el('td', { class: 'tl-nowrap', text: r.state }),
            el('td', { class: 'tl-nowrap', text: r.starts || '-' }),
            el('td', { class: 'tl-nowrap', text: r.takes || '-' }),
            el('td', { text: r.note || '' }),
            moves ? moveCell(r.id) : null,
          ),
        ),
      ),
    ),
  );
}

/** What cannot start, with the reason (under the chart; the table has them as rows). */
function timelineCannot(d) {
  const list = d.schedule?.unscheduled ?? [];
  if (!list.length) return null;
  return el(
    'section',
    { class: 'tl-cannot', 'aria-labelledby': 'tl-cannot-title' },
    el('h3', { id: 'tl-cannot-title', class: 'tl-sub', text: `Cannot start (${list.length})` }),
    el(
      'ul',
      { class: 'tl-cannot-list' },
      ...list.map((u) =>
        el(
          'li',
          {},
          el('button', { type: 'button', class: 'link-button', text: u.id, 'data-focus': `tl:cannot:${u.id}`, onclick: () => openPanel(u.id) }),
          el('span', { class: 'tl-cannot-reason', text: ` ${u.reason ?? ''}` }),
        ),
      ),
    ),
  );
}

/** The Timeline view. */
function drawTimeline() {
  const TL = window.QueueTimelineLayout;
  const prefs = timelinePrefs();
  const by = timelineRows();
  const horizon = TL.horizonDays(t.data?.boardTimeline?.horizonDays);
  const d = t.timeline.data;
  const head = el(
    'div',
    { class: 'stat-head tl-head' },
    el('h2', { class: 'decide-heading', text: 'Timeline' }),
    roomHelp('timeline', 'Timeline'),
    el('span', { class: 'top-fill' }),
    timelineSwitch('Rows', [['step', 'Focus steps'], ['project', 'Projects']], by, (v) => saveTimelinePrefs({ ...prefs, rows: v })),
    timelineSwitch('Show as', [['chart', 'Chart'], ['table', 'Table']], prefs.display, (v) => saveTimelinePrefs({ ...prefs, display: v })),
  );
  const view = el(
    'section',
    {
      class: 'tl-view',
      'aria-label': 'Timeline',
      onfocusin: (e) => {
        tlFocus = e.target?.dataset?.focus ?? e.target?.closest?.('[data-focus]')?.dataset?.focus ?? null;
      },
    },
    head,
  );
  main.append(view);
  if (!timelineOn()) {
    view.append(el('p', { class: 'empty', text: 'The Timeline tab is off (board.timeline in Settings, Board).' }));
    return;
  }
  if (!d) {
    view.append(el('p', { class: 'empty', text: t.timeline.error ? `Could not build the timeline: ${t.timeline.error}` : 'Playing the queue forward …' }));
    return;
  }
  const s = d.schedule ?? {};
  const slots = s.slots?.slots;
  view.append(
    el('p', {
      class: 'tl-intro',
      text:
        `The queue as it is now, played forward with ${slots ?? '?'} slot${slots === 1 ? '' : 's'}, ${horizon} day${horizon === 1 ? '' : 's'} ahead. ` +
        'Every bar is rough; only a step says when it is done.',
    }),
  );
  const rows = TL.buildRows(d, { by, horizonDays: horizon });
  // T-B: the drag for order (board/timelinemove.js): which tasks and steps can move, the words for a screen reader and
  // the live region that says each move.
  tlSetRows(rows, by);
  tlChart = null;
  if (tlDragOn()) {
    view.append(
      el('p', { id: 'tl-live', class: 'hidden-for-eye', role: 'status', 'aria-live': 'polite' }),
      el('p', {
        id: 'tl-move-help',
        class: 'hidden-for-eye',
        text: 'Space lifts it to change its place in the step; Enter opens the card.',
      }),
      el('p', { id: 'tl-step-help', class: 'hidden-for-eye', text: 'Space lifts the step to change the focus order.' }),
    );
    if (by === 'step' && tlPlace.size && prefs.display !== 'table')
      view.append(
        el('p', {
          class: 'tl-note',
          text: 'Drag a bar up or down to change its place in the step, or a step title to change the focus order. Time is calculated, so a sideways drag is refused.',
        }),
      );
  }
  if (!rows.length) view.append(el('p', { class: 'empty', text: 'Nothing ran in the last day and nothing is planned.' }));
  else if (prefs.display === 'table') view.append(timelineTable(d, rows));
  else view.append(timelineChart(d, rows, horizon), timelineLegend());
  if (prefs.display !== 'table') {
    const cannot = timelineCannot(d);
    if (cannot) view.append(cannot);
  }
  const notes = [];
  if (s.proposed) notes.push(`${s.proposed} proposed task${s.proposed === 1 ? ' is' : 's are'} not in the plan until approved.`);
  if (s.answer?.basis === 'default')
    notes.push(`An owner question is assumed answered after ${TL.roughDuration(s.answer.minutes)} (fewer than 5 measured answers).`);
  if (s.precision) notes.push(s.precision);
  for (const n of notes) view.append(el('p', { class: 'tl-note', text: n }));
  restoreTimelineFocus(view);
}

/** Focus back on what had it before the redraw (only while focus was in the view; never steals it from elsewhere). */
function restoreTimelineFocus(view) {
  if (!tlFocus) return;
  const a = document.activeElement;
  if (a && a !== document.body && !view.contains(a)) return;
  view.querySelector(`[data-focus="${CSS.escape(tlFocus)}"]`)?.focus({ preventScroll: true });
}
