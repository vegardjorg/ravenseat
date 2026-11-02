// =============================================================
// transcriptMetrics.js: the per-model cost, the tool calls and errors, the API errors and the active time from the
// agents' done rows in the time log, for `cq cost`, `log-time.mjs --cost` and the board's Statistics tab.
//
// The numbers come from hook-time.mjs (lib/timeCost.js analyzeTranscript): byModel, tools, api_errors, active_s,
// idle_gaps and duration_s per done row, and killed: true on the rows cq writes itself for killed agents
// (lib/timeLogRows.js killedDoneRow). The rows are CUMULATIVE per agent (one per stop), so every row gives only the
// GROWTH since the previous row for the same agent, as in timeCost.usageEvents: the sum over all rows = the last row per
// agent, and a window (day or from/to) gets only what grew in it.
// Older rows without byModel count under their one `model` (priced as timeCost.costUsd did); older rows without tools,
// api_errors or active_s add nothing to those parts (the summary says how many rows had them).
//
// Pure functions without I/O. Tested in lib/__tests__/transcriptMetrics.test.ts.
// =============================================================
'use strict';

const TK = require('./timeCost.js');

/** The raw token kinds summed into `tokens` per model (as costEstimate and sumCost count them). */
const TOKEN_KINDS = ['input', 'output', 'cache_read', 'cache_written'];

/** The numbers of one done row as a flat map key -> number (cumulative values; growth is taken per agent). */
function flatten(r) {
  const out = new Map();
  const add = (k, v) => {
    const n = Number(v);
    if (Number.isFinite(n)) out.set(k, (out.get(k) ?? 0) + n);
  };
  const by = r.byModel && typeof r.byModel === 'object' ? Object.entries(r.byModel) : [];
  const models = by.length
    ? by.map(([m, v]) => [m, v?.tokens, v?.turns])
    : [[r.model ?? TK.DEFAULT_MODEL, r.tokens, r.modelTurns]];
  for (const [m, tokens, turns] of models) {
    add(`m\u0000${m}\u0000usd`, TK.costUsd(tokens, m));
    add(`m\u0000${m}\u0000turns`, turns ?? 0);
    add(`m\u0000${m}\u0000tokens`, TOKEN_KINDS.reduce((s, k) => s + (Number(tokens?.[k] ?? 0) || 0), 0));
  }
  for (const [name, v] of Object.entries(r.tools && typeof r.tools === 'object' ? r.tools : {})) {
    add(`t\u0000${name}\u0000calls`, v?.calls ?? 0);
    add(`t\u0000${name}\u0000errors`, v?.errors ?? 0);
  }
  for (const [kind, n] of Object.entries(r.api_errors && typeof r.api_errors === 'object' ? r.api_errors : {}))
    add(`e\u0000${kind}`, n);
  // The wall time only next to an active time, so the two compare the same rows (older rows have no active_s).
  if (r.active_s != null) {
    add('active_s', r.active_s);
    add('duration_s', r.duration_s ?? r.active_s);
    add('idle_gaps', r.idle_gaps ?? 0);
  }
  return out;
}

/**
 * The summary over the done rows (growth per agent, see the header).
 * @param {object[]} rows the time log rows
 * @param {{ day?: string|null, from?: number|null, to?: number|null, tz?: string }} [option]
 *   day = one local date (YYYY-MM-DD); from/to = epoch ms window [from, to). Nothing = the whole log.
 * @returns {{ perModel: { model: string, family: string, known: boolean, usd: number, turns: number, tokens: number,
 *   share: number }[], tools: { name: string, calls: number, errors: number, errorRate: number|null }[],
 *   toolTotal: { calls: number, errors: number, errorRate: number|null },
 *   apiErrors: { rate_limit: number, overloaded: number, other: number },
 *   time: { active_s: number, duration_s: number, idle_gaps: number, rowsWithActive: number },
 *   agents: number, killed: number, total_usd: number, assumed: boolean }}
 */
function metricsSummary(rows, { day = null, from = null, to = null, tz = TK.TZ } = {}) {
  const perAgent = new Map();
  for (const r of rows ?? []) {
    if (r?.event !== 'done' || !r.tokens) continue;
    const k = r.agent_id ?? `${r.track ?? '?'}|${r.time}`;
    if (!perAgent.has(k)) perAgent.set(k, []);
    perAgent.get(k).push(r);
  }
  const inWindow = (r) => {
    const t = Date.parse(r.time);
    if (day && TK.dayFor(r.time, tz) !== day) return false;
    if (from != null && !(t >= from)) return false;
    if (to != null && !(t < to)) return false;
    return true;
  };
  const sum = new Map();
  const agents = new Set();
  const killed = new Set();
  let rowsWithActive = 0;
  for (const [agent, list] of perAgent) {
    list.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    const previous = new Map();
    // An agent counts as killed when its LAST row is a killed row (a later real done row means it was not).
    if (list[list.length - 1]?.killed === true && inWindow(list[list.length - 1])) killed.add(agent);
    for (const r of list) {
      const now = flatten(r);
      const counted = inWindow(r);
      if (counted) {
        agents.add(agent);
        if (r.active_s != null) rowsWithActive++;
      }
      for (const [k, v] of now) {
        const p = previous.get(k) ?? 0;
        if (counted) sum.set(k, (sum.get(k) ?? 0) + Math.max(0, v - p));
        // A row without full analysis can be lower than the previous one: keep the highest.
        previous.set(k, Math.max(p, v));
      }
    }
  }
  const r2 = (x) => Math.round(x * 100) / 100;
  const models = new Map();
  const tools = new Map();
  const apiErrors = { rate_limit: 0, overloaded: 0, other: 0 };
  for (const [k, v] of sum) {
    const [part, name, field] = k.split('\u0000');
    if (part === 'm') {
      const m = models.get(name) ?? { usd: 0, turns: 0, tokens: 0 };
      m[field] += v;
      models.set(name, m);
    } else if (part === 't') {
      const t = tools.get(name) ?? { calls: 0, errors: 0 };
      t[field] += v;
      tools.set(name, t);
    } else if (part === 'e') apiErrors[name in apiErrors ? name : 'other'] += v;
  }
  const total = [...models.values()].reduce((s, m) => s + m.usd, 0);
  const rate = (e, c) => (c > 0 ? Math.round((e / c) * 1000) / 10 : null);
  const toolList = [...tools.entries()]
    .map(([name, t]) => ({ name, calls: t.calls, errors: t.errors, errorRate: rate(t.errors, t.calls) }))
    .sort((a, b) => b.calls - a.calls || b.errors - a.errors || a.name.localeCompare(b.name));
  const calls = toolList.reduce((s, t) => s + t.calls, 0);
  const errors = toolList.reduce((s, t) => s + t.errors, 0);
  const perModel = [...models.entries()]
    .map(([model, m]) => {
      const p = TK.priceFor(model);
      return {
        model,
        family: p.family,
        known: p.known,
        usd: r2(m.usd),
        turns: m.turns,
        tokens: m.tokens,
        share: total > 0 ? Math.round((m.usd / total) * 1000) / 10 : 0,
      };
    })
    .sort((a, b) => b.usd - a.usd);
  return {
    perModel,
    tools: toolList,
    toolTotal: { calls, errors, errorRate: rate(errors, calls) },
    apiErrors,
    time: {
      active_s: sum.get('active_s') ?? 0,
      duration_s: sum.get('duration_s') ?? 0,
      idle_gaps: sum.get('idle_gaps') ?? 0,
      rowsWithActive,
    },
    agents: agents.size,
    killed: killed.size,
    total_usd: r2(total),
    assumed: perModel.some((m) => !m.known),
  };
}

/** "3 h 05 min" / "42 min" from seconds. */
function hours(s) {
  const min = Math.round(Number(s ?? 0) / 60);
  return min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min` : `${min} min`;
}

/**
 * The text lines for the CLI (`cq cost`, `log-time.mjs --cost`): per model, the top tools with their error rate, the
 * API errors, the active time and the killed agents. Empty list when there is nothing to show.
 * @param {ReturnType<typeof metricsSummary>} m
 * @param {{ topTools?: number }} [option]
 */
function metricsLines(m, { topTools = 8 } = {}) {
  if (!m || !m.agents) return [];
  const usd = (x) => `$${Number(x).toFixed(2)}`.padStart(10);
  const out = [];
  if (m.perModel.length) {
    out.push('Per model:');
    for (const x of m.perModel)
      out.push(
        `  ${x.model.padEnd(24)} ${usd(x.usd)} ${`${x.share} %`.padStart(7)}  ${String(x.turns).padStart(5)} turns` +
          (x.known ? '' : '  (no own price: priced as Opus 5.5)'),
      );
  }
  if (m.tools.length) {
    const t = m.toolTotal;
    out.push(
      `Tools (top ${Math.min(topTools, m.tools.length)} of ${m.tools.length}; ${t.calls} calls, ${t.errors} errors` +
        `${t.errorRate != null ? `, ${t.errorRate} %` : ''}):`,
    );
    for (const x of m.tools.slice(0, topTools))
      out.push(
        `  ${x.name.padEnd(24)} ${String(x.calls).padStart(6)} calls ${String(x.errors).padStart(5)} errors` +
          `${x.errorRate != null ? `  ${x.errorRate} %` : ''}`,
      );
  }
  const e = m.apiErrors;
  if (e.rate_limit || e.overloaded || e.other)
    out.push(`API errors: ${e.rate_limit} rate limit (429), ${e.overloaded} overloaded (529), ${e.other} other`);
  if (m.time.rowsWithActive)
    out.push(
      `Active time: ${hours(m.time.active_s)} of ${hours(m.time.duration_s)} wall time ` +
        `(${m.time.idle_gaps} idle gaps left out)`,
    );
  if (m.killed) out.push(`Killed agents (no SubagentStop, measured from the transcript): ${m.killed}`);
  return out;
}

module.exports = { metricsSummary, metricsLines };
