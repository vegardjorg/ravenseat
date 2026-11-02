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

/** Stacked bars per day (charts 1 and 3). `series`: [{ key, css }]; `stroke`: horizontal line (quota). */
function barGraph({ rows, series, tipsFor, format, stroke, summary }) {
  const B = 560;
  const H = 200;
  const V = 52;
  const HO = 8;
  const TO = 10;
  const BU = 24;
  const ph = H - TO - BU;
  const max = Math.max(
    0,
    ...rows.map((r) => series.reduce((sum, se) => sum + (r[se.key] ?? 0), 0)),
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
    if ((rows.length - 1 - i) % 2 === 0)
      svg.append(
        s('text', { x: x + width / 2, y: H - 8, 'text-anchor': 'middle', text: date(r.day) }),
      );
  });
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

/** Horizontal bars (charts 2 and 4). `rows`: [{ label, strong?, parts: [{ val, css }], tips, text }]. */
function horizontalGraph({ groups, max, strokes = [], summary, format }) {
  const B = 560;
  const V = 96;
  const HO = 84;
  const TO = 6;
  const BU = 22;
  const ROW = 14;
  const BETWEEN = 4;
  const GROUP = 14;
  const height = (g) => g.rows.length * (ROW + BETWEEN) - BETWEEN;
  const H = TO + groups.reduce((sum, g) => sum + height(g) + GROUP, 0) - GROUP + BU;
  const top = roundUp(max);
  const pw = B - V - HO;
  const x = (v) => V + (Math.min(v, top) / top) * pw;
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
  for (const g of groups) {
    const y0 = y;
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
      svg.append(chunk, s('text', { x: x(from) + 6, y: y + ROW - 3, text: r.text }));
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
  return svg;
}

/**
 * Lines per day (In versus out). `series`: [{ key, css }]; every series becomes a line with a point per
 * day, and every day has a tooltip over the whole height (like the bar chart).
 */
function lineGraph({ rows, series, tipsFor, format, summary }) {
  const B = 560;
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
    if ((rows.length - 1 - i) % 2 === 0)
      svg.append(s('text', { x: x(i), y: H - 8, 'text-anchor': 'middle', text: date(r.day) }));
  });
  return svg;
}

/** "3 d" for long times (response time on owner questions), otherwise as duration. */
const length = (min) =>
  min == null ? 'no data' : min >= 48 * 60 ? `${counts(min / 1440, 1)} d` : duration(min);

/** A chart with title, explanation (the colors) and a short remark (e.g. how many are excluded). */
function graph(title, content, explanation, remark) {
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
                class: `${stroke === 'line' ? 'draw-line' : stroke ? 'draw-line' : 'draw-dot'} ${css}`,
              }),
              text,
            ),
          ),
        )
      : null,
    remark ? el('p', { class: 'graph-remark', text: remark }) : null,
  );
}

/** A key figure: name, the large value, a line under it and (optional) a second, smaller detail line. */
function tile(name, val, under, detail) {
  return el(
    'div',
    { class: 'tile' },
    el('p', { class: 'tile-name', text: name }),
    el('p', { class: 'tile-value', text: val }),
    under ? el('p', { class: 'tile-under', text: under }) : null,
    detail ? el('p', { class: 'tile-under tile-detail', text: detail }) : null,
  );
}

/**
 * "Cost per merged change" (keyFigures.costPerMerged from lib/costEstimate.js): the value, the total over the merged
 * count, and a detail line with where the cost went and the secondary, estimate-based per content minute figure.
 */
function costTile(p, windowDays) {
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
    (p.source === 'time-log'
      ? `Merged ${usd(p.parts.merged)}, cancelled ${usd(p.parts.cancelled)}, still open ${usd(p.parts.open)}, ` +
        `no task ${usd(p.parts.unattributed)}. `
      : '') +
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
    el('h3', { id: 'blocker-stat-title', class: 'setting-title', text: 'Blockers last 7 days' }),
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
      : el('p', { class: 'empty', text: 'No blockers recorded in the last 7 days (cq block <id> <code>).' }),
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
 * "Flow last 14 days": a plain table from lib/eventStatistics.js flowStatistics (the same figures as the Flow lines in
 * cq cost): first-pass rate, fix rounds per task, merge conflicts per week, base red verdicts, pushes and batch size.
 */
function flowTable(f) {
  const v = (x, unit = '') => (x == null ? '-' : `${counts(x, Number.isInteger(x) ? 0 : 1)}${unit}`);
  const triage = Object.entries(f.triage ?? {})
    .map(([k, n]) => `${k} ${n}`)
    .join(', ');
  const rows = [
    ['First pass', v(f.firstPass.rate_pct, ' %'), `${f.firstPass.first_pass} of ${f.firstPass.merged} merged tasks with 0 fix rounds`],
    ['Fix rounds per task', v(f.fixRounds.per_task), `${f.fixRounds.started} fix round(s) started, ${f.fixRounds.continuations} continuation(s)`],
    ['Merge conflicts per week', v(f.mergeConflicts.per_week), `${f.mergeConflicts.count} conflict(s), ${f.mergeConflicts.files} file(s)`],
    ['Base red', v(f.baseGate.red), `of ${f.baseGate.verdicts} verdict(s), ${f.baseGate.red_tips} red tip(s)`],
    ['Pushes per week', v(f.pushes.per_week), `${f.pushes.count} push(es), ${v(f.pushes.tasks_per_push)} tasks per push`],
    ['Triage', triage || '-', 'verdicts from cq triage'],
  ];
  return el(
    'section',
    { class: 'blocker-stat', 'aria-labelledby': 'flow-stat-title' },
    el('h3', { id: 'flow-stat-title', class: 'setting-title', text: 'Flow last 14 days' }),
    el(
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
        rows.map(([name, val, detail]) =>
          el('tr', null, el('th', { scope: 'row', text: name }), el('td', { text: val }), el('td', { text: detail })),
        ),
      ),
    ),
  );
}

/**
 * "Agents: models, tools and errors" (queueStatistics.transcriptMetrics, the same numbers as `cq cost`): cost per
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
    el('h3', {
      id: 'metrics-stat-title',
      class: 'setting-title',
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
      ? metricsTableOf(
          ['Tool', 'Calls', 'Errors', 'Error rate'],
          m.tools.map((x) => [x.name, counts(x.calls), counts(x.errors), pct(x.errorRate)]),
        )
      : null,
    ...facts.map((text) => el('p', { class: 'graph-remark', text })),
  );
}

function drawStatistics() {
  const d = t.stat.data;
  if (!d) {
    main.append(
      el('p', {
        class: 'empty',
        text: t.stat.error
          ? `Could not build the statistics: ${t.stat.error}`
          : 'Fetching the statistics …',
      }),
    );
    return;
  }
  const n = d.keyFigures;
  const night = String(d.nightWindow ?? '23-06').replace('-', ' to ');

  // Chart 1: finished per day, stacked per class.
  const doneTotal = d.donePerDay.reduce((sum, r) => sum + r.sum, 0);
  const most = d.donePerDay.reduce((a, r) => (r.sum > a.sum ? r : a), d.donePerDay[0]);
  const graph1 = graph(
    `Done per day, last ${d.windowDays} days`,
    barGraph({
      rows: d.donePerDay,
      series: ['K', 'D', 'D+', 'U'].map((k) => ({ key: k, css: CLASS_CSS[k] })),
      format: (v) => counts(v, v % 1 ? 1 : 0),
      tipsFor: (r) =>
        `${date(r.day)}: ${r.sum} finished (K ${r.K}, D ${r.D}, D+ ${r['D+']}, U ${r.U})`,
      summary:
        `Done per day in the last ${d.windowDays} days, stacked per class: ${doneTotal} in total` +
        (most?.sum ? `, most ${most.sum} on ${date(most.day)}.` : '.'),
    }),
    ['K', 'D', 'D+', 'U'].map((k) => [CLASS_CSS[k], k]),
  );

  // In versus out: added and finished per day, two lines.
  const inOut = d.inOutPerDay ?? [];
  const inTotal = inOut.reduce((a, r) => a + r.in, 0);
  const outTotal = inOut.reduce((a, r) => a + r.out, 0);
  const graphInOut = graph(
    `Added and finished per day, last ${d.windowDays} days`,
    lineGraph({
      rows: inOut,
      series: [
        { key: 'in', css: 's-in' },
        { key: 'out', css: 's-out' },
      ],
      format: (v) => counts(v, v % 1 ? 1 : 0),
      tipsFor: (r) => `${date(r.day)}: ${r.in} added, ${r.out} finished`,
      summary:
        `Added and finished per day in the last ${d.windowDays} days: ${inTotal} added and ${outTotal} ` +
        `finished in total.`,
    }),
    [
      ['s-in', 'Added', 'line'],
      ['s-out', 'Done', true],
    ],
  );

  // Chart 2: time per class, median and average, split into work and review/merge, with estimated average as a line.
  const classes = d.perClass.filter((k) => k.count > 0);
  const sum = (k, template) => (k.work[template] ?? 0) + (k.review[template] ?? 0);
  const graph2 = graph(
    'Time per class (start to done)',
    classes.length
      ? horizontalGraph({
          groups: classes.map((k) => ({
            rows: ['median', 'average'].map((template) => ({
              label: template === 'median' ? `${k.class} median` : 'average',
              strong: template === 'median',
              parts: [
                { val: k.work[template] ?? 0, css: 's-work' },
                { val: k.review[template] ?? 0, css: 's-review' },
              ],
              text: duration(sum(k, template)),
              tips:
                `${k.class}, ${template} of ${k.count}: work ${duration(k.work[template])} + review and merge ` +
                `${duration(k.review[template])}`,
            })),
            strokes:
              k.estimateAverage != null
                ? [
                    {
                      val: k.estimateAverage,
                      css: 'line-estimate',
                      tips: `${k.class}: estimated average ${duration(k.estimateAverage)}`,
                    },
                  ]
                : [],
          })),
          max: Math.max(
            1,
            ...classes.flatMap((k) => [sum(k, 'median'), sum(k, 'average'), k.estimateAverage ?? 0]),
          ),
          format: (v) => duration(v),
          summary:
            'Median time from start to done per class: ' +
            classes.map((k) => `${k.class} ${duration(sum(k, 'median'))}`).join(', ') +
            '. The line is the estimated average.',
        })
      : el('p', { class: 'empty', text: 'No finished tasks with all the times yet.' }),
    [
      ['s-work', 'Work (start to delivered)'],
      ['s-review', 'Review and merge (delivered to done)'],
      ['line-estimate', 'Estimated average', true],
    ],
    d.excluded.class
      ? `${d.excluded.class} finished without start, delivery or done time are excluded.`
      : null,
  );

  // Chart 3: cost per day, night separately, with the daily quota as a line.
  const costTotal = d.costPerDay.reduce((a, r) => a + r.usd, 0);
  const nightTotal = d.costPerDay.reduce((a, r) => a + r.night, 0);
  const graph3 = graph(
    `Cost per day, last ${d.windowDays} days (USD, API equivalent)`,
    barGraph({
      rows: d.costPerDay.map((r) => ({
        day: r.day,
        dayPart: Math.max(0, r.usd - r.night),
        night: r.night,
        usd: r.usd,
      })),
      series: [
        { key: 'dayPart', css: 's-day' },
        { key: 'night', css: 's-night' },
      ],
      format: (v) => counts(v),
      tipsFor: (r) => `${date(r.day)}: ${usd(r.usd)}, of which night ${usd(r.night)}`,
      stroke: n.dailyBudget
        ? { val: n.dailyBudget, css: 'line-quota', tips: `Daily quota ${usd(n.dailyBudget)}` }
        : null,
      summary:
        `Cost per day in the last ${d.windowDays} days: ${usd(costTotal)} in total, ` +
        `${costTotal ? Math.round((nightTotal / costTotal) * 100) : 0} % at night (${night})` +
        (n.dailyBudget ? `, daily quota ${usd(n.dailyBudget)}.` : '.'),
    }),
    [
      ['s-day', 'Day'],
      ['s-night', `Night (${night})`],
      ...(n.dailyBudget ? [['line-quota', 'Daily quota', true]] : []),
    ],
  );

  // Chart 4: the context of the track agents against the cap.
  const k = d.context;
  const graph4 = graph(
    `Context at end, track agents last ${d.windowDays} days`,
    k.count
      ? horizontalGraph({
          groups: [
            {
              rows: [
                ['median', k.median],
                ['max', k.max],
              ].map(([label, v]) => ({
                label,
                strong: label === 'median',
                parts: [{ val: v, css: v > k.cap ? 's-over' : 's-context' }],
                text: thousand(v),
                tips: `${label} of ${k.count} tracks: ${thousand(v)} tokens`,
              })),
            },
          ],
          strokes: [{ val: k.cap, css: 'line-quota', tips: `Cap approx. ${thousand(k.cap)}` }],
          max: Math.max(k.max ?? 0, k.cap),
          format: thousand,
          summary: `Context at end for ${k.count} track agents: median ${thousand(k.median)}, max ${thousand(k.max)}, cap approx. ${thousand(k.cap)}.`,
        })
      : el('p', { class: 'empty', text: 'No track agents with context logged yet.' }),
    [
      ['s-context', 'Context'],
      ['line-quota', `Cap approx. ${thousand(k.cap)}`, true],
    ],
    d.excluded.context ? `${d.excluded.context} tracks without context in the log are excluded.` : null,
  );

  main.append(
    el(
      'section',
      { class: 'keyFigures', 'aria-label': 'Key figures' },
      // The main cost figure: all measured cost in the window (also cancelled work and agents without a task) divided
      // by the tasks that reached done (lib/costEstimate.js perMergedChange). Per content minute is only in the
      // detail line, labelled estimate-based: it moves when the estimates change.
      n.costPerMerged ? costTile(n.costPerMerged, d.windowDays) : null,
      tile(
        `Done last ${d.doneDays} days`,
        counts(n.finished),
        'tasks set to done in the queue',
      ),
      tile(
        'Median cycle time',
        duration(n.cycleMedian),
        `start to done, ${n.cycleCount} tasks last ${d.windowDays} days` +
          (d.excluded.cycle ? `; ${d.excluded.cycle} without start time are excluded` : ''),
      ),
      tile(
        'Estimate accuracy',
        n.accuracy == null ? 'no data' : `${counts(n.accuracy, 2)} ×`,
        'median of actual time divided by the estimate (1.00 = as estimated)',
      ),
      // Only with a daily quota: without one, "0.00 USD" as a large number says nothing to act on.
      n.dailyBudget
        ? tile(
            'Usage today',
            usd(n.usageToday),
            `of ${usd(n.dailyBudget)} daily quota (${Math.round((n.usageToday / n.dailyBudget) * 100)} %)`,
          )
        : null,
      // Batch queue counted separately (waiting to be packed, not to be started).
      n.batchQueue?.count
        ? tile(
            'In batch queue',
            counts(n.batchQueue.count),
            `${counts(n.batchQueue.minutes)} content minutes in ${n.batchQueue.groups} ` +
              `${n.batchQueue.groups === 1 ? 'group' : 'groups'}, ${n.batchQueue.readyOnes} ready for packing`,
          )
        : null,
      // In versus out: arrow up when the queue grows.
      n.inOut
        ? tile(
            `In versus out, last ${d.doneDays} days`,
            `${counts(n.inOut.in, 1)} / ${counts(n.inOut.out, 1)}`,
            `added / finished per day · ` +
              (n.inOut.net > 0
                ? `↑ queue grows by ${counts(n.inOut.net, 1)} per day`
                : n.inOut.net < 0
                  ? `↓ queue shrinks by ${counts(-n.inOut.net, 1)} per day`
                  : '→ as many in as out'),
          )
        : null,
      // Only when enough resolutions have a time (otherwise the number is excluded).
      n.responseTime
        ? tile(
            'Median time from question to answer',
            length(n.responseTime.median),
            `${n.responseTime.count} owner questions resolved with timestamp`,
          )
        : null,
    ),
    // The forecast (lib/queueForecast.js, the same as `cq forecast` and the box in Focus).
    ...(d.forecast?.text
      ? [el('p', { class: 'stat-forecast', text: `Forecast: ${d.forecast.text}` })]
      : []),
    el('div', { class: 'graphs' }, graph1, graphInOut, graph2, graph3, graph4),
    // Blockers last 7 days (cq blockers): per reason code, count and blocked time, top first.
    blockerTable(d.blockers),
    // Models, tools and errors (lib/transcriptMetrics.js); append() turns null into "null", so only when it exists.
    ...(d.metrics?.agents ? [transcriptMetricsSection(d.metrics, d.windowDays)] : []),
    // Flow last 14 days (lib/eventStatistics.js flowStatistics, the same figures as cq cost).
    ...(d.flow ? [flowTable(d.flow)] : []),
    // The legend for the classes and badges (same as in the help).
    legend('stat'),
    // append() turns null into the text "null", so the remark is only added when it exists.
    ...(d.timeLogError
      ? [
          el('p', {
            class: 'graph-remark',
            text: `Could not find the time log (${d.timeLogError}); cost and context missing.`,
          }),
        ]
      : []),
  );
}
