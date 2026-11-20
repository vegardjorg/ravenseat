// =============================================================
// statistics.js: the Statistics tab (inline SVG, the colors from the CSS variables via the classes in
// board.css).
//
// One of the board's classic scripts in queue-board/board/ (see docs/board.md). They load in order with defer and
// share the page's global scope, so a top-level name in one is visible in all of them, as when they were one
// board.js. Code that runs while a script loads may only use names from the scripts before it.
// =============================================================
'use strict';

// ---- Statistics (inline SVG, the colors from the CSS variables via the classes in board.css) ----
const SVG_NS = 'http://www.w3.org/2000/svg';
function s(tag, attr, ...children) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attr ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'text') e.textContent = v;
    else e.setAttribute(k, String(v));
  }
  for (const b of children.flat()) if (b != null && b !== false) e.append(b);
  return e;
}
/** The tooltip in a chart. */
const tips = (text) => s('title', { text });
const CLASS_CSS = { K: 's-K', D: 's-D', 'D+': 's-Dp', U: 's-U' };
const counts = (x, d = 0) =>
  Number(x ?? 0).toLocaleString('en-GB', { minimumFractionDigits: d, maximumFractionDigits: d });
const usd = (x) => `${counts(x, Math.abs(Number(x ?? 0)) >= 100 ? 0 : 2)} USD`;
const date = (day) => `${day.slice(8, 10)}.${day.slice(5, 7)}`;
const thousand = (x) => `${counts(Number(x ?? 0) / 1000)}k`;
/** "25 min", "1 h 38 min". */
function duration(min) {
  if (min == null) return 'no data';
  const m = Math.round(min);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}
/** A nice cap for the axis: 1, 2, 2.5 or 5 × 10^n, at least x. */
function roundUp(x) {
  if (!(x > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(x));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= x) return m * p;
  return 10 * p;
}

/**
 * The drawing width of a chart (S7): a first guess before the cards are on the page, the width of a card on a narrow
 * screen and 560 from 720 px up. The builders read GW while they draw. After the tab is on the page, fitCharts draws
 * every chart again at the width its own card really has (st1), so a 12 unit text stays about 12 px at every screen
 * width: a 560 unit drawing in a 430 px card (three cards per row at 1440) made it about 9 px, and in a 690 px card
 * (two per row) about 15.
 */
let GW = 560;
function graphWidth() {
  const w = main?.clientWidth ?? 0;
  // The board's side padding (16 px each side under 720 px), the card's padding (16 each side) and its border.
  return w > 0 && w < 720 ? Math.max(280, Math.min(560, w - 66)) : 560;
}
/** The narrowest and widest drawing fitCharts makes (a full-width card on a wide screen stops at the widest). */
const GW_MIN = 280;
const GW_MAX = 1400;

/**
 * A chart builder that remembers how it was called, so fitCharts can draw the same chart again at another width. The
 * builder and its arguments ride on the SVG element itself (the chart is dropped with it).
 */
function fitted(build) {
  const make = (o) => {
    const svg = build(o);
    svg._fit = { make, o, at: GW };
    return svg;
  };
  return make;
}
const barGraph = fitted(barGraphAt);
const horizontalGraph = fitted(horizontalGraphAt);
const lineGraph = fitted(lineGraphAt);
const dotStrip = fitted(dotStripAt);

/**
 * Draws every chart under `root` again at the width its card has on screen, when that differs from the width it was
 * drawn at. A chart with no width (in a closed fold, or not laid out) is left as it is; it is fitted when its fold opens.
 */
function fitCharts(root) {
  if (!root) return;
  for (const svg of [...root.querySelectorAll('svg.graph-svg')]) {
    const fit = svg._fit;
    if (!fit) continue;
    const w = Math.round(svg.getBoundingClientRect().width);
    if (!(w > 0)) continue;
    const at = Math.max(GW_MIN, Math.min(GW_MAX, w));
    if (at === fit.at) continue;
    const keep = GW;
    GW = at;
    try {
      svg.replaceWith(fit.make(fit.o));
    } finally {
      GW = keep;
    }
  }
}
// A turned phone or a narrowed window gets charts at its new width, at most once per 150 ms while the window is
// dragged: the whole tab again when the first guess changes (the fold defaults follow it; what was opened or closed
// is remembered), otherwise only the charts whose card changed width.
let statResizeTimer = 0;
window.addEventListener('resize', () => {
  if (statResizeTimer) return;
  statResizeTimer = setTimeout(() => {
    statResizeTimer = 0;
    if (t.view !== 'statistics' || !t.stat?.data) return;
    if (graphWidth() !== GW) draw();
    else fitCharts(main);
  }, 150);
});
// A fold that opens shows charts that had no width while it was closed. The toggle event does not bubble, so the
// listener is on the capture side.
document.addEventListener(
  'toggle',
  (e) => {
    if (t.view === 'statistics' && e.target?.open) fitCharts(e.target);
  },
  true,
);
/** Every how many days a date label is drawn: every second at full width, every fourth on a phone. */
const labelStep = () => (GW < 450 ? 4 : 2);

/**
 * Stacked bars per day. `series`: [{ key, css }]; `stroke`: horizontal line (quota); `line` (optional): one more
 * series drawn as a solid line with points over the bars ({ key, css }), such as "Added" over the finished bars.
 */
function barGraphAt({ rows, series, tipsFor, format, stroke, summary, line }) {
  const B = GW;
  const H = 200;
  const V = 52;
  const HO = 8;
  const TO = 10;
  const BU = 24;
  const ph = H - TO - BU;
  const max = Math.max(
    0,
    ...rows.map((r) => series.reduce((sum, se) => sum + (r[se.key] ?? 0), 0)),
    ...(line ? rows.map((r) => r[line.key] ?? 0) : []),
  );
  const top = roundUp(Math.max(max, stroke?.val ?? 0));
  const y = (v) => TO + ph - (v / top) * ph;
  const svg = s('svg', {
    viewBox: `0 0 ${B} ${H}`,
    class: 'graph-svg',
    role: 'img',
    'aria-label': summary,
  });
  for (const v of [0, top / 2, top])
    svg.append(
      s('line', { x1: V, x2: B - HO, y1: y(v), y2: y(v), class: 'axis' }),
      s('text', { x: V - 6, y: y(v) + 4, 'text-anchor': 'end', text: format(v) }),
    );
  const step = (B - V - HO) / rows.length;
  const width = Math.max(4, step * 0.7);
  rows.forEach((r, i) => {
    const x = V + i * step + (step - width) / 2;
    const g = s('g', null, tips(tipsFor(r)));
    let bottom = 0;
    for (const se of series) {
      const v = r[se.key] ?? 0;
      if (v <= 0) continue;
      g.append(
        s('rect', {
          x,
          y: y(bottom + v),
          width: width,
          height: y(bottom) - y(bottom + v),
          class: se.css,
        }),
      );
      bottom += v;
    }
    // A hidden surface over the whole height, so the tooltip also exists on empty days.
    g.append(s('rect', { x, y: TO, width: width, height: ph, class: 'match' }));
    svg.append(g);
    if ((rows.length - 1 - i) % labelStep() === 0)
      svg.append(
        s('text', { x: x + width / 2, y: H - 8, 'text-anchor': 'middle', text: date(r.day) }),
      );
  });
  if (line) {
    const cx = (i) => V + i * step + step / 2;
    svg.append(
      s('polyline', { class: `line ${line.css}`, points: rows.map((r, i) => `${cx(i)},${y(r[line.key] ?? 0)}`).join(' ') }),
      ...rows.map((r, i) => s('circle', { cx: cx(i), cy: y(r[line.key] ?? 0), r: 3, class: `point ${line.css}` })),
    );
  }
  if (stroke)
    svg.append(
      s(
        'line',
        { x1: V, x2: B - HO, y1: y(stroke.val), y2: y(stroke.val), class: stroke.css },
        tips(stroke.tips),
      ),
    );
  return svg;
}

/** The width of a value text in the charts' units: about 7.2 a character at the 12 unit font (an estimate). */
const textWidth = (text) => String(text ?? '').length * 7.2;

/**
 * Where a value text starts so no vertical line runs through it (S1): right after the bar, and past every line that
 * would cross it (`lineXs`, the x of the lines in the same rows). Pushed against the right edge `edge` it is drawn
 * ending there instead. Returns the x and the text anchor.
 */
function valuePlace(barEnd, text, lineXs, edge) {
  const w = textWidth(text);
  let x = barEnd + 6;
  for (const lx of [...lineXs].sort((a, b) => a - b)) if (lx >= x - 3 && lx <= x + w + 3) x = lx + 6;
  return x + w > edge ? { x: edge, anchor: 'end' } : { x, anchor: null };
}

/**
 * Horizontal bars (charts 2 and 4). `rows`: [{ label, strong?, parts: [{ val, css }], tips, text }]. `axisEnd` (optional)
 * is the end of the axis; without it the axis ends at a round number at or above `max`. The value texts are drawn
 * last, so a text lies on top of the lines, and they move past a line that would cross them.
 */
function horizontalGraphAt({ groups, max, axisEnd, strokes = [], summary, format }) {
  const B = GW;
  const V = GW < 450 ? 72 : 96;
  const HO = GW < 450 ? 64 : 84;
  const TO = 6;
  const BU = 22;
  const ROW = 14;
  const BETWEEN = 4;
  const GROUP = 14;
  const height = (g) => g.rows.length * (ROW + BETWEEN) - BETWEEN;
  const H = TO + groups.reduce((sum, g) => sum + height(g) + GROUP, 0) - GROUP + BU;
  const top = axisEnd > 0 ? axisEnd : roundUp(max);
  const pw = B - V - HO;
  const x = (v) => V + (Math.min(v, top) / top) * pw;
  // The value texts wait until every line is drawn (they go on top).
  const values = [];
  const svg = s('svg', {
    viewBox: `0 0 ${B} ${H}`,
    class: 'graph-svg',
    role: 'img',
    'aria-label': summary,
  });
  for (const v of [0, top / 2, top])
    svg.append(
      s('line', { x1: x(v), x2: x(v), y1: TO, y2: H - BU, class: 'axis' }),
      s('text', { x: x(v), y: H - 6, 'text-anchor': 'middle', text: format(v) }),
    );
  let y = TO;
  // The x of the lines that cross the rows: the global ones (all rows) plus the group's own.
  const globalXs = strokes.map((st) => x(st.val));
  for (const g of groups) {
    const y0 = y;
    const lineXs = [...globalXs, ...(g.strokes ?? []).map((st) => x(st.val))];
    for (const r of g.rows) {
      svg.append(
        s('text', {
          x: V - 8,
          y: y + ROW - 3,
          'text-anchor': 'end',
          class: r.strong ? 'label-strong' : null,
          text: r.label,
        }),
      );
      const chunk = s('g', null, tips(r.tips));
      let from = 0;
      for (const d of r.parts) {
        if (!(d.val > 0)) continue;
        chunk.append(
          s('rect', {
            x: x(from),
            y,
            width: x(from + d.val) - x(from),
            height: ROW,
            class: d.css,
          }),
        );
        from += d.val;
      }
      svg.append(chunk);
      const at = valuePlace(x(from), r.text, lineXs, B - 4);
      values.push(
        s('text', { x: at.x, y: y + ROW - 3, 'text-anchor': at.anchor, class: 'value', text: r.text }),
      );
      y += ROW + BETWEEN;
    }
    for (const st of g.strokes ?? [])
      svg.append(
        s(
          'line',
          { x1: x(st.val), x2: x(st.val), y1: y0 - 3, y2: y - BETWEEN + 3, class: st.css },
          tips(st.tips),
        ),
      );
    y += GROUP - BETWEEN;
  }
  for (const st of strokes)
    svg.append(
      s(
        'line',
        { x1: x(st.val), x2: x(st.val), y1: TO - 2, y2: H - BU, class: st.css },
        tips(st.tips),
      ),
    );
  svg.append(...values);
  return svg;
}

/**
 * Lines per day (In versus out). `series`: [{ key, css }]; every series becomes a line with a point per
 * day, and every day has a tooltip over the whole height (like the bar chart).
 */
function lineGraphAt({ rows, series, tipsFor, format, summary }) {
  const B = GW;
  const H = 200;
  const V = 52;
  const HO = 8;
  const TO = 10;
  const BU = 24;
  const ph = H - TO - BU;
  const max = Math.max(0, ...rows.flatMap((r) => series.map((se) => r[se.key] ?? 0)));
  const top = roundUp(max);
  const y = (v) => TO + ph - (v / top) * ph;
  const step = (B - V - HO) / rows.length;
  const x = (i) => V + i * step + step / 2;
  const svg = s('svg', {
    viewBox: `0 0 ${B} ${H}`,
    class: 'graph-svg',
    role: 'img',
    'aria-label': summary,
  });
  for (const v of [0, top / 2, top])
    svg.append(
      s('line', { x1: V, x2: B - HO, y1: y(v), y2: y(v), class: 'axis' }),
      s('text', { x: V - 6, y: y(v) + 4, 'text-anchor': 'end', text: format(v) }),
    );
  for (const se of series) {
    svg.append(
      s('polyline', {
        class: `line ${se.css}`,
        points: rows.map((r, i) => `${x(i)},${y(r[se.key] ?? 0)}`).join(' '),
      }),
    );
    for (const [i, r] of rows.entries())
      svg.append(
        s('circle', { cx: x(i), cy: y(r[se.key] ?? 0), r: 3, class: `point ${se.css}` }),
      );
  }
  rows.forEach((r, i) => {
    svg.append(
      s(
        'g',
        null,
        tips(tipsFor(r)),
        s('rect', { x: x(i) - step / 2, y: TO, width: step, height: ph, class: 'match' }),
      ),
    );
    if ((rows.length - 1 - i) % labelStep() === 0)
      svg.append(s('text', { x: x(i), y: H - 8, 'text-anchor': 'middle', text: date(r.day) }));
  });
  return svg;
}

/** "3 d" for long times (response time on owner questions), otherwise as duration. */
const length = (min) =>
  min == null ? 'no data' : min >= 48 * 60 ? `${counts(min / 1440, 1)} d` : duration(min);

/**
 * A chart with its question as the title, the explanation (the colors), a short remark (e.g. how many are excluded) and
 * the "Does this look bad?" line (`advice`, an element from adviceLine).
 */
function graph(title, content, explanation, remark, advice) {
  return el(
    'figure',
    { class: 'graph' },
    el('figcaption', { text: title }),
    content,
    explanation?.length
      ? el(
          'ul',
          { class: 'explanation', 'aria-hidden': 'true' },
          explanation.map(([css, text, stroke]) =>
            el(
              'li',
              null,
              el('span', {
                // 'line' is a solid line in the chart ("Added"), true a dashed one (estimate, quota, cap, "Done").
                class: `${stroke === 'line' ? 'draw-line draw-solid' : stroke ? 'draw-line' : 'draw-dot'} ${css}`,
              }),
              text,
            ),
          ),
        )
      : null,
    remark ? el('p', { class: 'graph-remark', text: remark }) : null,
    advice ?? null,
  );
}

/**
 * A key figure: name, the large value, a line under it and (optional) a second, smaller detail line. `tone` 'warn'
 * marks a figure past its limit (the detail line then says why in words, so the color is never the only signal).
 */
function tile(name, val, under, detail, tone) {
  return el(
    'div',
    { class: tone ? `tile tile-${tone}` : 'tile' },
    el('p', { class: 'tile-name', text: name }),
    // A value in words ("too few answers yet", "no reading") has no digit: the smaller text style, so it does not wrap
    // over two big lines next to the numbers.
    el('p', { class: /\d/.test(String(val)) ? 'tile-value' : 'tile-value tile-value-text', text: val }),
    under ? el('p', { class: 'tile-under', text: under }) : null,
    detail ? el('p', { class: 'tile-under tile-detail', text: detail }) : null,
  );
}

/**
 * "Cost per merged change" (keyFigures.costPerMerged from lib/costEstimate.js): the value, the total over the merged
 * count, and a detail line with the week over week trend (S2) and the secondary, estimate-based per content minute
 * figure. Where the cost went (merged, cancelled, open, no task) is in the Cost and tokens section.
 */
function costTile(p, windowDays, trend = null) {
  if (!p.merged)
    return tile(
      'Cost per merged change',
      'no data',
      `no task merged in the last ${windowDays} days (${usd(p.total_usd)} measured)`,
    );
  return tile(
    'Cost per merged change',
    usd(p.usd_per_merged),
    `${usd(p.total_usd)} all measured cost / ${counts(p.merged)} merged, last ${windowDays} days` +
      (p.source === 'task-cost' ? ' (task cost only, no usage in the time log)' : ''),
    (trend ? `${trend}. ` : '') +
      (p.usd_per_content_min != null
        ? `Estimate-based, secondary: ${usd(p.usd_per_content_min)} per content minute.`
        : ''),
  );
}

/** "Blockers last 7 days": a plain table (code, count, time) from queueLogic.blockerSummary, top first. */
function blockerTable(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return el(
    'section',
    { class: 'blocker-stat', 'aria-labelledby': 'blocker-stat-title' },
    el('h4', { id: 'blocker-stat-title', class: 'stat-card-title', text: 'Blockers last 7 days' }),
    list.length
      ? el(
          'table',
          { class: 'blocker-table' },
          el(
            'thead',
            null,
            el(
              'tr',
              null,
              el('th', { scope: 'col', text: 'Reason' }),
              el('th', { scope: 'col', text: 'Count' }),
              el('th', { scope: 'col', text: 'Blocked time' }),
            ),
          ),
          el(
            'tbody',
            null,
            list.map((r) =>
              el(
                'tr',
                null,
                el('th', { scope: 'row', text: r.code }),
                el('td', { text: `${counts(r.count)}${r.open ? ` (${r.open} open)` : ''}` }),
                el('td', { text: duration(Math.round(r.ms / 60_000)) }),
              ),
            ),
          ),
        )
      : el('p', { class: 'empty', text: 'No blockers recorded in the last 7 days (ravenseat block <id> <code>).' }),
  );
}

/**
 * "Guard decisions last 7 days": deny and ask per track from lib/guardLog.js counts (the doctor's decisions row), the
 * rules seen, and the override events in the same window. Never the command or the path: the log holds neither.
 */
function guardTable(g) {
  const list = Array.isArray(g?.byTrack) ? g.byTrack : [];
  const over = Array.isArray(g?.overrides) ? g.overrides : [];
  return el(
    'section',
    { class: 'blocker-stat guard-stat', 'aria-labelledby': 'guard-stat-title' },
    el('h4', { id: 'guard-stat-title', class: 'stat-card-title', text: 'Guard decisions last 7 days' }),
    list.length
      ? metricsTableOf(
          ['Track', 'Denied', 'Asked', 'Rules'],
          list.map((x) => [x.track, counts(x.deny), counts(x.ask), (x.rules ?? []).join(', ') || '-']),
        )
      : el('p', { class: 'empty', text: 'No guard decisions logged in the last 7 days (guardLog.enabled).' }),
    ...(over.length
      ? [el('p', { class: 'graph-remark', text: `Overrides: ${over.map((x) => `${x.event} ${x.count}`).join(', ')}` })]
      : []),
  );
}

/** A plain table (the blocker table's style): the header cells and the rows (first cell is the row header). */
function metricsTableOf(head, rows) {
  return el(
    'table',
    { class: 'blocker-table metrics-table' },
    el('thead', null, el('tr', null, head.map((h) => el('th', { scope: 'col', text: h })))),
    el(
      'tbody',
      null,
      rows.map(([first, ...rest]) =>
        el('tr', null, el('th', { scope: 'row', text: first }), rest.map((v) => el('td', { text: v }))),
      ),
    ),
  );
}

/**
 * The flow figures from lib/eventStatistics.js flowStatistics (the same as the Flow lines in ravenseat cost), split in
 * two tables (S5): `quality` (first pass, fix rounds, merge conflicts, base red, triage, right first time, post-merge
 * defects, inflow, with the reviewer hit rate table and the hints) and `autonomy` (owner interventions, verified tasks
 * per intervention, the longest stretch, corrected without the owner, pushes).
 */
function flowTable(f, part = 'quality') {
  const v = (x, unit = '') => (x == null ? '-' : `${counts(x, Number.isInteger(x) ? 0 : 1)}${unit}`);
  const triage = Object.entries(f.triage ?? {})
    .map(([k, n]) => `${k} ${n}`)
    .join(', ');
  const rows = [
    ['First pass', v(f.firstPass.rate_pct, ' %'), `${f.firstPass.first_pass} of ${f.firstPass.merged} merged tasks with 0 fix rounds`],
    ['Fix rounds per task', v(f.fixRounds.per_task), `${f.fixRounds.started} fix round(s) started, ${f.fixRounds.continuations} continuation(s)`],
    ['Merge conflicts per week', v(f.mergeConflicts.per_week), `${f.mergeConflicts.count} conflict(s), ${f.mergeConflicts.files} file(s)`],
    ['Base red', v(f.baseGate.red), `of ${f.baseGate.verdicts} verdict(s), ${f.baseGate.red_tips} red tip(s)`],
    ['Triage', triage || '-', 'verdicts from ravenseat triage'],
  ];
  const own = [];
  // The quality figures (lib/eventStatistics.js header); older server data without them shows the rows above only.
  const r = f.rightFirstTime;
  if (r)
    rows.push(
      ['Right first time', v(r.rate_pct, ' %'), `${r.right} of ${r.merged} merged: no fix round, QA deviation, reopen or post-merge defect`],
      ['Post-merge defects per 10 merged', v(r.defects_per_10), `${r.defects} fix task(s) or finding(s) naming a merged task`],
    );
  if (r)
    own.push(
      [
        'Owner interventions per 10 merged',
        v(r.interventions_per_10),
        `${r.interventions} owner edit(s) while the task ran` +
          (r.interventions_known < r.merged ? `, ${r.merged - r.interventions_known} task(s) unknown (changelog too short)` : ''),
      ],
    );
  const au = f.autonomy;
  if (au) {
    const c = au.corrected;
    own.push(
      [
        'Verified tasks per owner intervention',
        au.verified_per_intervention == null ? 'no interventions' : v(au.verified_per_intervention),
        `${au.verified} merged task(s) right first time or with every defect fixed`,
      ],
      ['Longest stretch without the owner', v(au.longest_stretch_h, ' h'), 'work running, no owner action'],
      [
        'Corrected without the owner',
        `${c.without_owner} of ${c.total}`,
        `fix rounds ${c.fix_rounds.without_owner}/${c.fix_rounds.total}, red done commands ` +
          `${c.done_when.without_owner}/${c.done_when.total}, base red fix tasks ${c.base_fix.without_owner}/${c.base_fix.total}`,
      ],
    );
  }
  const i = f.inflow;
  if (i) {
    const by = Object.entries(i.by ?? {})
      .filter(([, n]) => n)
      .map(([k, n]) => `${k} ${n}`)
      .join(', ');
    rows.push(['Inflow', v(i.added), `${by || 'nothing added'}; added/done last ${i.weeks.length} weeks ${i.weeks.map((w) => `${w.in}/${w.out}`).join(', ')}`]);
  }
  own.push([
    'Pushes per week',
    v(f.pushes.per_week),
    f.pushes.count
      ? `${f.pushes.count} push(es), ${v(f.pushes.tasks_per_push)} tasks per push`
      : 'no push in the window, so no tasks per push yet',
  ]);
  const auto = part === 'autonomy';
  const hints = auto ? [] : [...(f.reviewers?.hints ?? []), ...(i?.hint ? [i.hint] : [])];
  const id = auto ? 'autonomy-stat-title' : 'flow-stat-title';
  return el(
    'section',
    { class: 'blocker-stat', 'aria-labelledby': id },
    el('h4', { id, class: 'stat-card-title', text: auto ? 'How much runs without you?' : 'Is it right the first time?' }),
    scrollBox(el(
      'table',
      { class: 'blocker-table' },
      el(
        'thead',
        null,
        el(
          'tr',
          null,
          el('th', { scope: 'col', text: 'Figure' }),
          el('th', { scope: 'col', text: 'Value' }),
          el('th', { scope: 'col', text: 'Detail' }),
        ),
      ),
      el(
        'tbody',
        null,
        (auto ? own : rows).map(([name, val, detail]) =>
          el('tr', null, el('th', { scope: 'row', text: name }), el('td', { text: val }), el('td', { text: detail })),
        ),
      ),
    )),
    ...(!auto && f.reviewers?.rows?.length ? [scrollBox(reviewerTable(f.reviewers))] : []),
    ...hints.map((h) => el('p', { class: 'graph-remark', text: `Hint: ${h}.` })),
  );
}

/**
 * The reviewer hit rate under the Flow table: per reviewer type the runs, the runs with findings, the fix rounds the
 * orchestrator attributed to it (ravenseat resume --from) and the dismissed ones (lib/eventStatistics.js reviewerStatistics).
 */
function reviewerTable(rv) {
  const head = ['Reviewer', 'Runs', 'With findings', 'Led to a fix', 'Dismissed'];
  return el(
    'table',
    { class: 'blocker-table' },
    el('caption', {
      text:
        `Reviewer hit rate: fix rounds attributed ${rv.attributed} of ${rv.fix_rounds}` +
        (rv.fix_rounds && !rv.attributed ? ' (ravenseat resume --from records which reviewer caused one)' : ''),
    }),
    el('thead', null, el('tr', null, head.map((h) => el('th', { scope: 'col', text: h })))),
    el(
      'tbody',
      null,
      rv.rows.map((x) =>
        el(
          'tr',
          null,
          el('th', { scope: 'row', text: x.type }),
          [x.runs, x.with_findings, x.fixes, x.dismissed].map((n) => el('td', { text: String(n) })),
        ),
      ),
    ),
  );
}

/**
 * "Agents: models, tools and errors" (queueStatistics.transcriptMetrics, the same numbers as `ravenseat cost`): cost per
 * model, the top tools with their error rate, the API errors, the active time and the killed agents. Nothing when
 * the time log has no done rows in the window.
 */
function transcriptMetricsSection(m, windowDays) {
  if (!m?.agents) return null;
  const pct = (x) => (x == null ? '' : `${counts(x, 1)} %`);
  const e = m.apiErrors ?? {};
  const facts = [
    m.time?.rowsWithActive
      ? `Active time ${duration(m.time.active_s / 60)} of ${duration(m.time.duration_s / 60)} wall time ` +
        `(${counts(m.time.idle_gaps)} idle gaps left out).`
      : null,
    e.rate_limit || e.overloaded || e.other
      ? `API errors: ${counts(e.rate_limit)} rate limit, ${counts(e.overloaded)} overloaded, ${counts(e.other)} other.`
      : null,
    m.killed ? `${counts(m.killed)} killed agents measured from their transcripts.` : null,
  ].filter(Boolean);
  return el(
    'section',
    { class: 'blocker-stat', 'aria-labelledby': 'metrics-stat-title' },
    el('h4', {
      id: 'metrics-stat-title',
      class: 'stat-card-title',
      text: `Agents last ${windowDays} days: models, tools and errors`,
    }),
    m.perModel?.length
      ? metricsTableOf(
          ['Model', 'Turns', 'Cost', 'Share'],
          m.perModel.map((x) => [
            x.known ? x.model : `${x.model} (priced as Opus 5.5)`,
            counts(x.turns),
            usd(x.usd),
            pct(x.share),
          ]),
        )
      : null,
    m.tools?.length
      ? // Only the tools that fail more than 5 % of the time (S4): the rest answer nothing one could change.
        (() => {
          const failing = m.tools.filter((x) => (x.errorRate ?? 0) > 5);
          return failing.length
            ? metricsTableOf(
                ['Tool', 'Calls', 'Errors', 'Error rate'],
                failing.map((x) => [x.name, counts(x.calls), counts(x.errors), pct(x.errorRate)]),
              )
            : el('p', { class: 'graph-remark', text: 'No tool failed more than 5 % of its calls.' });
        })()
      : null,
    ...facts.map((text) => el('p', { class: 'graph-remark', text })),
  );
}

// ---- The reworked tab (plans/stats-vurdering-2026-11-18.md S2 to S7): a top row of five numbers, then the sections
// Cost and tokens, Flow, Quality and Machine. Every chart has one question as its title and a "Does this look bad?" line
// whose buttons open the gear on the setting to change (openSettings, then focusSetting on the row). ----

/** A quiet button that opens Settings on one registry row (the gear's own deep link, board/settings.js). */
function settingButton(key) {
  return el('button', {
    type: 'button',
    class: 'link-button graph-setting',
    text: key,
    'aria-label': `Open the setting ${key}`,
    onclick: async () => {
      await openSettings();
      focusSetting(settingTarget(key));
    },
  });
}

/** "Does this look bad? <what to do>" with a button per setting. */
function adviceLine(text, keys = []) {
  return el(
    'p',
    { class: 'graph-advice' },
    el('span', { class: 'graph-advice-q', text: 'Does this look bad? ' }),
    text,
    keys.length ? el('span', { class: 'graph-advice-keys' }, keys.map(settingButton)) : null,
  );
}

/** A table that scrolls inside its card on a narrow screen, never the page (S7). */
const scrollBox = (table) => el('div', { class: 'stat-scroll' }, table);

/**
 * One point per track agent against the cap (the context strip, S4): the points on one axis, a dashed cap line in the
 * neutral tone (near the cap is a state, not an error), and the points over 80 % of the cap marked.
 */
function dotStripAt({ points, cap, summary }) {
  const B = GW;
  const V = 12;
  const HO = 12;
  const H = 64;
  const mid = 26;
  const top = Math.max(cap, ...points.map((p) => p.end)) * 1.1;
  const x = (v) => V + (v / top) * (B - V - HO);
  const svg = s('svg', { viewBox: `0 0 ${B} ${H}`, class: 'graph-svg', role: 'img', 'aria-label': summary });
  svg.append(s('line', { x1: x(0), x2: x(top), y1: mid, y2: mid, class: 'axis' }));
  for (const v of [0, cap])
    svg.append(s('text', { x: x(v), y: H - 6, 'text-anchor': v ? 'middle' : 'start', text: thousand(v) }));
  svg.append(
    s('line', { x1: x(cap), x2: x(cap), y1: 6, y2: mid + 12, class: 'line-cap' }, tips(`Cap ${thousand(cap)}`)),
    s('text', { x: x(cap) - 4, y: 12, 'text-anchor': 'end', text: `cap ${thousand(cap)}` }),
  );
  for (const p of points)
    svg.append(
      s(
        'circle',
        { cx: x(p.end), cy: mid, r: 5, class: `point dot ${p.end > cap * 0.8 ? 's-near' : 's-context'}` },
        tips(`${p.track ?? 'track'}: ${thousand(p.end)}`),
      ),
    );
  return svg;
}

/**
 * A section of the tab: a fold with a 14/600 heading (no capitals). Which are open is remembered per viewer
 * (localStorage, via the store wrapper); the default is all open, and on a phone only Cost and tokens (S7).
 */
const STAT_FOLDS = 'queue-board-stat-folds';
function statSection(id, title, ...content) {
  let saved = null;
  try {
    saved = JSON.parse(store.getItem(STAT_FOLDS) ?? 'null');
  } catch {
    saved = null; // a broken value: the default
  }
  const open = saved && typeof saved[id] === 'boolean' ? saved[id] : GW >= 560 || id === 'cost';
  const fold = el(
    'details',
    { class: 'stat-section', id: `stat-section-${id}`, open: open || null },
    el('summary', null, el('h3', { class: 'stat-section-title', id: `stat-section-${id}-title`, text: title })),
    ...content,
  );
  fold.addEventListener('toggle', () => {
    let all = {};
    try {
      all = JSON.parse(store.getItem(STAT_FOLDS) ?? '{}') ?? {};
    } catch {
      all = {};
    }
    all[id] = fold.open;
    store.setItem(STAT_FOLDS, JSON.stringify(all));
  });
  return fold;
}

/** The five numbers on top (S2): cost per merged change, finished against new, right first time, waiting on you, quota. */
function topRow(d) {
  const n = d.keyFigures;
  const top = d.sections?.top ?? {};
  const out = [];
  // 1. Cost per merged change, with the week over week trend as text (an arrow, never only a color).
  const ct = top.costTrend;
  const trend =
    ct?.this != null && ct?.last != null
      ? `${ct.this > ct.last ? '↑' : ct.this < ct.last ? '↓' : '→'} this week ${usd(ct.this)}, the week before ${usd(ct.last)}`
      : null;
  if (n.costPerMerged) out.push(costTile(n.costPerMerged, d.windowDays, trend));
  // 2. Finished against new per day, warn only when the queue grew in both of the last two weeks.
  if (n.inOut)
    out.push(
      tile(
        'Finished against new',
        `${counts(n.inOut.out, 1)} out / ${counts(n.inOut.in, 1)} in`,
        `per day, last ${d.doneDays} days · ` +
          (n.inOut.net > 0
            ? `↑ the queue grows by ${counts(n.inOut.net, 1)} a day`
            : n.inOut.net < 0
              ? `↓ the queue shrinks by ${counts(-n.inOut.net, 1)} a day`
              : '→ as many in as out'),
        top.growing ? 'The queue grew in both of the last two weeks.' : null,
        top.growing ? 'warn' : null,
      ),
    );
  // 3. Right first time (the flow figures).
  const r = d.flow?.rightFirstTime;
  out.push(
    tile(
      'Right first time',
      r?.rate_pct == null ? 'no data' : `${counts(r.rate_pct, Number.isInteger(r.rate_pct) ? 0 : 1)} %`,
      r ? `${r.right} of ${r.merged} merged, last 14 days: no fix round, QA deviation, reopen or defect` : 'no merged task yet',
    ),
  );
  // 4. Waiting on you: shown also with too few answers (says so instead of hiding the tile).
  const w = top.waiting;
  if (w)
    out.push(
      tile(
        'Waiting on you',
        w.median != null ? length(w.median) : 'too few answers yet',
        w.median != null
          ? `median from question to answer, ${w.answered} answers`
          : `${w.answered} of ${d.responseMin ?? 5} answers with a time needed for a median`,
        `${counts(w.open)} open question${w.open === 1 ? '' : 's'} now` +
          (w.oldest_min != null ? `, the oldest waiting ${length(w.oldest_min)}` : ''),
        w.warn ? 'warn' : null,
      ),
    );
  // 5. The quota: the week's when the status line saved one, else the daily quota, else what is missing.
  const q = top.quota;
  if (q)
    out.push(
      tile(
        'Weekly quota',
        `${counts(q.used_pct)} % used`,
        `${counts(q.elapsed_pct)} % of the quota week gone` +
          (q.pace_pct != null ? `; at this pace the week ends at about ${counts(q.pace_pct)} %` : ''),
        q.warn ? 'At this pace the quota runs out before it resets.' : null,
        q.warn ? 'warn' : null,
      ),
    );
  else if (n.dailyBudget)
    out.push(
      tile(
        'Usage today',
        usd(n.usageToday),
        `of ${usd(n.dailyBudget)} daily quota (${Math.round((n.usageToday / n.dailyBudget) * 100)} %)`,
        null,
        n.usageToday > n.dailyBudget ? 'warn' : null,
      ),
    );
  else out.push(tile('Weekly quota', 'no reading', 'the status line has saved no quota reading yet (Pro or Max only)'));
  return el('section', { class: 'keyFigures', 'aria-label': 'Key figures' }, out);
}

/** Section A: what the days cost, where the money goes, the token mix, cache expiry, context and the top tasks. */
function costSectionOf(d) {
  const n = d.keyFigures;
  const c = d.sections?.cost;
  const night = String(d.nightWindow ?? '23-06').replace('-', ' to ');
  const costTotal = d.costPerDay.reduce((a, r) => a + r.usd, 0);
  const nightTotal = d.costPerDay.reduce((a, r) => a + r.night, 0);
  const nightShare = costTotal ? Math.round((nightTotal / costTotal) * 100) : 0;
  const cards = [
    graph(
      'What do the days cost?',
      barGraph({
        rows: d.costPerDay.map((r) => ({ day: r.day, dayPart: Math.max(0, r.usd - r.night), night: r.night, usd: r.usd })),
        series: [
          { key: 'dayPart', css: 's-day' },
          { key: 'night', css: 's-night' },
        ],
        format: (v) => counts(v),
        tipsFor: (r) => `${date(r.day)}: ${usd(r.usd)}, of which night ${usd(r.night)}`,
        stroke: n.dailyBudget ? { val: n.dailyBudget, css: 'line-quota', tips: `Daily quota ${usd(n.dailyBudget)}` } : null,
        summary:
          `Cost per day in the last ${d.windowDays} days: ${usd(costTotal)} in total, ${nightShare} % at night (${night})` +
          (n.dailyBudget ? `, daily quota ${usd(n.dailyBudget)}.` : '.'),
      }),
      [['s-day', 'Day'], ['s-night', `Night (${night})`], ...(n.dailyBudget ? [['line-quota', 'Daily quota', true]] : [])],
      `USD, API equivalent. ${nightShare} % at night.`,
      adviceLine('Set or lower the daily quota; a large night share is work the night run can take.', [
        'limits.dailyBudget',
        'limits.nightRun',
      ]),
    ),
  ];
  if (c) {
    // Where does the money go: build, review and fix round per class (the tasks' measured cost.phases).
    cards.push(
      graph(
        'Where does the money go?',
        c.phases.length
          ? horizontalGraph({
              groups: c.phases.map((p) => ({
                rows: [
                  {
                    label: p.class,
                    strong: true,
                    parts: [
                      { val: p.build, css: 's-work' },
                      { val: p.review, css: 's-review' },
                      { val: p.fix, css: 's-fix' },
                    ],
                    text: usd(p.build + p.review + p.fix),
                    tips: `${p.class}, ${p.tasks} task(s): build ${usd(p.build)}, review ${usd(p.review)}, fix rounds ${usd(p.fix)}`,
                  },
                ],
              })),
              max: Math.max(0.01, ...c.phases.map((p) => p.build + p.review + p.fix)),
              format: (v) => counts(v),
              summary:
                'Cost per class split in build, review and fix rounds: ' +
                c.phases.map((p) => `${p.class} ${usd(p.build + p.review + p.fix)}`).join(', ') +
                (c.fixShare != null ? `. Fix rounds ${c.fixShare} % of it.` : '.'),
            })
          : el('p', { class: 'empty', text: 'No done task with a measured cost per phase yet (ravenseat set <id> done).' }),
        [['s-work', 'Build'], ['s-review', 'Review'], ['s-fix', 'Fix rounds']],
        c.fixShare != null ? `Fix rounds are ${c.fixShare} % of the cost.` : null,
        adviceLine('Fix rounds over a quarter of the cost: the tasks are too large or the done command is unclear; split D tasks.', [
          'maxFixRounds',
        ]),
      ),
      graph(
        'What do we pay for in tokens?',
        barGraph({
          rows: c.tokenMix,
          series: [
            { key: 'input', css: 's-input' },
            { key: 'output', css: 's-output' },
            { key: 'cache_read', css: 's-cache-read' },
            { key: 'cache_write', css: 's-cache-write' },
          ],
          format: (v) => counts(v),
          tipsFor: (r) =>
            `${date(r.day)}: input ${usd(r.input)}, output ${usd(r.output)}, cache read ${usd(r.cache_read)}, cache write ${usd(r.cache_write)}`,
          summary: `Cost per token kind per day, last ${d.windowDays} days` + (c.cacheWriteShare != null ? `; cache write ${c.cacheWriteShare} % of it.` : '.'),
        }),
        [['s-input', 'Input'], ['s-output', 'Output'], ['s-cache-read', 'Cache read'], ['s-cache-write', 'Cache write']],
        c.cacheWriteShare != null ? `Cache write is ${c.cacheWriteShare} % of the token cost.` : null,
        adviceLine('Cache write over 30 % of the cost: the context is written again (see cache expiry and context below).', [
          'cost.contextThresholdK',
        ]),
      ),
      graph(
        'How much does waiting cost?',
        barGraph({
          rows: c.cacheExpiry,
          series: [{ key: 'count', css: 's-expiry' }],
          format: (v) => counts(v, v % 1 ? 1 : 0),
          tipsFor: (r) => `${date(r.day)}: ${r.count} cache expiries` + (r.usd ? `, about ${usd(r.usd)}` : ''),
          summary: `Cache expiries per day, last ${d.windowDays} days: ${c.cacheExpiry.reduce((a, r) => a + r.count, 0)} in total.`,
        }),
        [['s-expiry', 'Cache expiries']],
        (() => {
          const u = c.cacheExpiry.reduce((a, r) => a + r.usd, 0);
          return u > 0 ? `About ${usd(u)} extra cost when the cache had expired.` : 'A pause longer than the cache lifetime writes the whole context again.';
        })(),
        adviceLine('Many expiries: agents wait, on a gate slot or on an answer from you.', ['gateQueue.slots']),
      ),
      graph(
        'Do the tracks come near the cap?',
        c.context.points.length
          ? dotStrip({
              points: c.context.points,
              cap: c.context.cap,
              summary: `Context at end for ${c.context.points.length} track agents against the cap ${thousand(c.context.cap)}: ${c.context.near} over 80 %.`,
            })
          : el('p', { class: 'empty', text: 'No track agents with context logged yet.' }),
        [['s-context', 'One track'], ['s-near', 'Over 80 % of the cap'], ['line-cap', `Cap ${thousand(c.context.cap)}`, true]],
        `${c.context.near} of ${c.context.points.length} over 80 % of the cap; ` +
          (c.context.source === 'default' ? 'the cap is the 300k default' : `the cap is autoCompactWindow in ${c.context.source}`) +
          (c.context.compactions ? `; ${c.context.compactions} track compaction(s).` : '.'),
        adviceLine('More than 1 in 5 near the cap: make the tasks smaller.', ['fixRound.continueMaxContextK']),
      ),
    );
  }
  const list = [el('div', { class: 'graphs' }, cards)];
  if (c?.expensive?.length)
    list.push(
      el(
        'section',
        { class: 'stat-card', 'aria-labelledby': 'expensive-stat-title' },
        el('h4', { id: 'expensive-stat-title', class: 'stat-card-title', text: 'The most expensive tasks' }),
        scrollBox(
          metricsTableOf(
            ['Task', 'Class', 'Cost', 'Fix rounds', 'Context max'],
            c.expensive.map((x) => [x.id, x.class ?? '-', usd(x.usd), counts(x.fix_rounds), x.context_max ? thousand(x.context_max) : '-']),
          ),
        ),
        n.costPerMerged?.source === 'time-log'
          ? el('p', {
              class: 'graph-remark',
              text:
                `Of the measured cost: merged ${usd(n.costPerMerged.parts.merged)}, cancelled ${usd(n.costPerMerged.parts.cancelled)}, ` +
                `still open ${usd(n.costPerMerged.parts.open)}, no task ${usd(n.costPerMerged.parts.unattributed)}.`,
            })
          : null,
      ),
    );
  if (d.metrics?.agents) list.push(transcriptMetricsSection(d.metrics, d.windowDays));
  return statSection('cost', 'Cost and tokens', ...list);
}

/** Section B: does the queue shrink, how long does a task take, do the estimates hold, what stops work. */
function flowSectionOf(d) {
  const n = d.keyFigures;
  const inOut = d.inOutPerDay ?? [];
  const rows = d.donePerDay.map((r, i) => ({ ...r, in: inOut[i]?.in ?? 0 }));
  const doneTotal = rows.reduce((a, r) => a + r.sum, 0);
  const inTotal = rows.reduce((a, r) => a + r.in, 0);
  const shrink = graph(
    'Does the queue shrink?',
    barGraph({
      rows,
      series: ['K', 'D', 'D+', 'U'].map((k) => ({ key: k, css: CLASS_CSS[k] })),
      line: { key: 'in', css: 's-in' },
      format: (v) => counts(v, v % 1 ? 1 : 0),
      tipsFor: (r) => `${date(r.day)}: ${r.sum} finished (K ${r.K}, D ${r.D}, D+ ${r['D+']}, U ${r.U}), ${r.in} added`,
      summary: `Finished per day, stacked per class, against added, last ${d.windowDays} days: ${doneTotal} finished and ${inTotal} added.`,
    }),
    [...['K', 'D', 'D+', 'U'].map((k) => [CLASS_CSS[k], k]), ['s-in', 'Added', 'line']],
    null,
    adviceLine('More added than finished for weeks: fewer new tasks, or more tracks if the machine has room.', ['limits.maxConcurrent']),
  );
  const classes = d.perClass.filter((k) => k.count > 0);
  const sum = (k) => (k.work.median ?? 0) + (k.review.median ?? 0);
  const time = graph(
    'How long does a task take?',
    classes.length
      ? horizontalGraph({
          groups: classes.map((k) => ({
            rows: [
              {
                label: `${k.class} median`,
                strong: true,
                parts: [
                  { val: k.work.median ?? 0, css: 's-work' },
                  { val: k.review.median ?? 0, css: 's-review' },
                ],
                text: duration(sum(k)),
                tips: `${k.class}, median of ${k.count}: work ${duration(k.work.median)} + review and merge ${duration(k.review.median)}`,
              },
            ],
            strokes:
              k.estimateAverage != null
                ? [{ val: k.estimateAverage, css: 'line-estimate', tips: `${k.class}: estimated average ${duration(k.estimateAverage)}` }]
                : [],
          })),
          max: Math.max(1, ...classes.flatMap((k) => [sum(k), k.estimateAverage ?? 0])),
          format: (v) => duration(v),
          summary:
            'Median time from start to done per class: ' +
            classes.map((k) => `${k.class} ${duration(sum(k))}`).join(', ') +
            '. The line is the estimated average.',
        })
      : el('p', { class: 'empty', text: 'No finished tasks with all the times yet.' }),
    [['s-work', 'Work (start to delivered)'], ['s-review', 'Review and merge (delivered to done)'], ['line-estimate', 'Estimated average', true]],
    `All classes: median ${duration(n.cycleMedian)} over ${n.cycleCount} tasks; actual over estimate ` +
      (n.accuracy == null ? 'no data' : `${counts(n.accuracy, 2)} × (1.00 = as estimated)`) +
      (d.excluded.class ? `. ${d.excluded.class} without all times are excluded.` : '.'),
    adviceLine('Far from the estimate line: calibrate the class weights with ravenseat calibrate.'),
  );
  return statSection(
    'flow',
    'Flow',
    el('div', { class: 'graphs' }, shrink, time),
    blockerTable(d.blockers),
    // The batch queue is work status, not statistics: one quiet line here instead of a tile.
    n.batchQueue?.count
      ? el('p', {
          class: 'graph-remark',
          text: `In the batch queue: ${counts(n.batchQueue.count)} tasks, ${counts(n.batchQueue.minutes)} content minutes in ${n.batchQueue.groups} group(s), ${n.batchQueue.readyOnes} ready for packing.`,
        })
      : null,
  );
}

/** Section C: right first time, what the controls catch, which gates are worth the time, autonomy. */
function qualitySectionOf(d) {
  const q = d.sections?.quality;
  const list = [];
  if (d.flow) list.push(flowTable(d.flow, 'quality'), flowTable(d.flow, 'autonomy'));
  if (q?.findings?.sources?.length)
    list.push(
      el(
        'section',
        { class: 'stat-card', 'aria-labelledby': 'findings-stat-title' },
        el('h4', { id: 'findings-stat-title', class: 'stat-card-title', text: 'Do the controls catch anything?' }),
        scrollBox(metricsTableOf(['Caught by', 'H', 'M', 'L'], q.findings.sources.map((x) => [x.source, String(x.H), String(x.M), String(x.L)]))),
        el('p', { class: 'graph-remark', text: `Deferred findings fixed: ${q.findings.deferredFixed} of ${q.findings.deferred}.` }),
        adviceLine('A reviewer type without a fix in 20 runs can be turned off.', ['reviewers']),
      ),
    );
  if (q?.gates?.runs)
    list.push(
      el(
        'section',
        { class: 'stat-card', 'aria-labelledby': 'gates-stat-title' },
        el('h4', { id: 'gates-stat-title', class: 'stat-card-title', text: 'Which gates are worth the time?' }),
        scrollBox(
          metricsTableOf(
            ['Command', 'Runs', 'Red', 'Flaky', 'p50', 'p95'],
            q.gates.commands.map((c) => [c.command, counts(c.runs), counts(c.red), counts(c.flaky), c.p50 == null ? '-' : `${c.p50} s`, c.p95 == null ? '-' : `${c.p95} s`]),
          ),
        ),
        el('p', {
          class: 'graph-remark',
          text:
            `${q.gates.runs} gate runs, slowest p95 first. ` +
            (q.gates.neverRed.length
              ? `Never red in ${q.gates.minRuns} or more runs: ${q.gates.neverRed.join(', ')}.`
              : `No command has gone ${q.gates.minRuns} runs without a red one.`),
        }),
        adviceLine('Flaky: rerun them once before red counts. Never red and slow: consider moving it to the full gate.', ['gates.flakyRerun']),
      ),
    );
  if (!list.length) list.push(el('p', { class: 'empty', text: 'No flow figures, findings or gate runs yet.' }));
  return statSection('quality', 'Quality', ...list);
}

/** Section D: is the machine the bottleneck, do the tracks wait on a gate slot, do more tracks pay off. */
function machineSectionOf(d) {
  const m = d.sections?.machine;
  const list = [];
  if (m) {
    const limited = m.load.reduce((a, r) => a + r.limited + r.stopped, 0);
    const minFree = m.load.map((r) => r.min_free).filter((x) => x != null);
    list.push(
      el(
        'div',
        { class: 'graphs' },
        graph(
          'Is the machine the bottleneck?',
          barGraph({
            rows: m.load,
            series: [
              { key: 'limited', css: 's-limited' },
              { key: 'stopped', css: 's-stopped' },
            ],
            format: (v) => counts(v, v % 1 ? 1 : 0),
            tipsFor: (r) =>
              `${date(r.day)}: ${r.rows} fill/start, ${r.limited} limited, ${r.stopped} stopped` +
              (r.min_free != null ? `, lowest free memory ${r.min_free} %` : ''),
            summary: `Fills and starts the load guard limited or stopped per day, last ${d.windowDays} days: ${limited} in total.`,
          }),
          [['s-limited', 'Limited'], ['s-stopped', 'Stopped (machine full)']],
          (minFree.length ? `Lowest free memory ${Math.min(...minFree)} %` : 'No free memory reading yet') +
            (m.lowestGateFree != null ? `, during a gate ${m.lowestGateFree} %.` : '.'),
          adviceLine('Often limited or stopped: fewer tracks at a time, or a lower free memory level for all slots.', [
            'limits.maxConcurrent',
            'loadGuard.allSlotsFreeMemoryPct',
          ]),
        ),
        graph(
          'Do the tracks wait on a gate slot?',
          lineGraph({
            rows: m.gateWait.map((r) => ({ day: r.day, p50: r.p50 ?? 0, p95: r.p95 ?? 0, n: r.n })),
            series: [
              { key: 'p50', css: 's-p50' },
              { key: 'p95', css: 's-p95' },
            ],
            format: (v) => `${counts(v)} s`,
            tipsFor: (r) => `${date(r.day)}: ${r.n} gate runs, wait p50 ${r.p50} s, p95 ${r.p95} s`,
            summary: `Gate queue wait per day: p50 ${m.waitAll.p50 ?? 0} s and p95 ${m.waitAll.p95 ?? 0} s over ${m.waitAll.n} runs.`,
          }),
          [['s-p50', 'p50', 'line'], ['s-p95', 'p95', 'line']],
          `Over ${m.waitAll.n} runs: wait p95 ${m.waitAll.p95 ?? 0} s against a gate time p50 of ${m.gateAll.p50 ?? 0} s.`,
          adviceLine('Wait p95 longer than the gate itself: more gate slots, if the machine has the memory.', ['gateQueue.slots']),
        ),
        graph(
          'Do more tracks pay off?',
          m.byConcurrency.some((b) => b.n)
            ? horizontalGraph({
                groups: [
                  {
                    rows: m.byConcurrency.map((b) => ({
                      label: `${b.tracks} track${b.tracks === '1' ? '' : 's'}`,
                      parts: [{ val: b.p50 ?? 0, css: 's-gate' }],
                      text: b.n ? `${b.p50} s` : 'no runs',
                      tips: `${b.tracks} running: gate time p50 ${b.p50 ?? '-'} s over ${b.n} runs`,
                    })),
                  },
                ],
                max: Math.max(1, ...m.byConcurrency.map((b) => b.p50 ?? 0)),
                format: (v) => `${counts(v)} s`,
                summary:
                  'Gate time p50 by tracks running at the same time: ' +
                  m.byConcurrency.map((b) => `${b.tracks}: ${b.n ? `${b.p50} s` : 'no runs'}`).join(', ') +
                  '.',
              })
            : el('p', { class: 'empty', text: 'No timed gate runs in the window yet.' }),
          [['s-gate', 'Gate time p50']],
          'The tracks running when each gate started (from the queue: started to delivered).',
          adviceLine('The gate time more than doubles from 2 to 4 tracks: lower the most at a time.', ['limits.maxConcurrent']),
        ),
      ),
      el('p', {
        class: 'graph-remark',
        text: d.sections.settings?.machineSampleMin
          ? `Machine samples every ${d.sections.settings.machineSampleMin} min while the board runs.`
          : 'Readings come from fill, start and gate runs.',
      }),
    );
  }
  // Guard decisions at the very bottom, folded (a weekly look, not a daily one).
  list.push(el('details', { class: 'stat-fold' }, el('summary', { text: 'Guard decisions last 7 days' }), guardTable(d.guards)));
  return statSection('machine', 'Machine', ...list);
}

function drawStatistics() {
  const d = t.stat.data;
  GW = graphWidth();
  // B30: a one-line header with the "?", drawn while the figures load too.
  main.append(
    el('div', { class: 'stat-head' }, el('h2', { class: 'decide-heading', text: 'Statistics' }), roomHelp('statistics', 'Statistics')),
  );
  if (!d) {
    main.append(
      el('p', {
        class: 'empty',
        text: t.stat.error ? `Could not build the statistics: ${t.stat.error}` : 'Fetching the statistics …',
      }),
    );
    return;
  }
  main.append(
    topRow(d),
    // The forecast (lib/queueForecast.js, the same as `ravenseat forecast` and the box in Focus).
    ...(d.forecast?.text ? [el('p', { class: 'stat-forecast', text: `Forecast: ${d.forecast.text}` })] : []),
    costSectionOf(d),
    flowSectionOf(d),
    qualitySectionOf(d),
    machineSectionOf(d),
    // append() turns null into the text "null", so the remark is only added when it exists.
    ...(d.timeLogError
      ? [el('p', { class: 'graph-remark', text: `Could not find the time log (${d.timeLogError}); cost and context missing.` })]
      : []),
  );
  // Now that the cards are on the page: each chart at its own card's width.
  fitCharts(main);
}
