// =============================================================
// costMeasures.js: measurements on top of the cost (lib/timeCost.js), so a change in cost can be explained, not only
// seen. See docs/costs.md ("Reading a change in cost") and docs/queue.md ("Cost estimates and calibration").
//
// WHY: in one large project an external spike (thinking tokens per turn two to five times higher for every agent type,
// the orchestrator included, for five days, with the same model, effort and prompts) was found only afterwards, and
// fix rounds were counted inside build cost, so the rise looked like the work got harder. These numbers make both
// visible while it happens:
//   1. PER TURN (perTurn, agentTurnStats): per agent the turns, output per turn, thinking per turn and the Claude Code
//      version. Thinking comes from usage.output_tokens_details.thinking_tokens (timeCost.analyzeTranscript); a
//      transcript without it is UNKNOWN (null), never 0, so older rows do not pull a median down.
//   2. THE WARN AT 2x (turnBaseline, turnWarnings, turnCheck): output or thinking per turn over FACTOR times the agent
//      type's median over the last BASELINE_DAYS days, once at least MIN_N agents of that type are in the baseline.
//      Printed at `set <id> done` and in `ravenseat cost`. A measurement only: it never stops the queue or a track.
//   3. BUILD, REVIEW AND FIX ROUND (costPhases), the rule:
//        - a reviewer type is review;
//        - a label `<id>-r<N>` (or `-round<N>`) is a fix round, unless the task's `resumed` records round N with a
//          reason other than fix (a `context` continuation after a full context or of an adopted track: still build).
//          The track itself is always the bare `<id>` (round 0 in logic/attempt.js labelFor), and every round comes
//          from `ravenseat resume`, so `-r1` is the first fix round, never the track;
//        - any other agent (the bare `<id>`) is build, EXCEPT the growth after the task's first receive (`t_receive`)
//          when the agent had already stopped before it (a done row at or before t_receive): that is the same agent
//          sent back with SendMessage to fix what the review found, one fix round. `ravenseat resume` records such a
//          continuation in `resumed` (mode continue), and then each of those entries is one fix round.
//      Stored as cost.phases { build, review, fix, fix_rounds } and per agent `phase` (and `fix_usd` for the split).
//   4. BY START DATE (weekOverWeek, queueLogic.costStatistics): tasks are grouped by `started`, not by when they
//      finished; spend (the usage events) by its own time.
//   5. THE BREAKDOWN (unknownSources, breakdownLines): the orchestrator session as its own line, and the "unknown"
//      share split by why it could not be attributed.
//
// Pure functions without I/O. Must not require queueLogic.js (logic/results.js requires this file). Tested in
// lib/__tests__/costMeasures.test.ts.
// =============================================================
'use strict';

const TK = require('./timeCost.js');

/** The baseline window (days), the minimum agents per type before a median is trusted, and the warning factor. */
const BASELINE_DAYS = 14;
const MIN_N = 5;
const FACTOR = 2;
/** `ravenseat cost` compares the agents of the last RECENT_HOURS with the BASELINE_DAYS before them. */
const RECENT_HOURS = 24;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const METRICS = ['output', 'thinking'];

const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;
const num = (x) => (x != null && Number.isFinite(Number(x)) ? Number(x) : null);

/** Median of the numbers (null for an empty list). */
function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** 12345 -> "12,345" (fixed locale, so the output does not depend on the machine). */
const fmt = (x) => Math.round(Number(x)).toLocaleString('en-US');
const usd = (x) => `$${Number(x).toFixed(2)}`;

let bare;
const bareAgentType = (t) => (bare ??= require('./projectRoot.js').bareAgentType)(t);

// ---- 1. Per turn ------------------------------------------------------------------------------------------------

/**
 * Output and thinking per turn, rounded to whole tokens. Thinking is divided by the turns that reported it
 * (`thinking_turns`), so an agent that ran across a Claude Code update is not diluted by its older turns.
 * @param {{ turns?: number, output?: number, thinking_tokens?: number|null, thinking_turns?: number }} a
 * @returns {{ turns: number, output_per_turn: number|null, thinking_per_turn: number|null }}
 */
function perTurn({ turns, output, thinking_tokens: thinking = null, thinking_turns: thinkingTurns = null } = {}) {
  const n = Math.max(0, num(turns) ?? 0);
  const out = n > 0 ? Math.round((num(output) ?? 0) / n) : null;
  let think = null;
  if (num(thinking) != null) {
    const d = (num(thinkingTurns) ?? 0) > 0 ? num(thinkingTurns) : n;
    if (d > 0) think = Math.round(num(thinking) / d);
  }
  return { turns: n, output_per_turn: out, thinking_per_turn: think };
}

/**
 * The per-turn numbers per agent from the time log's done rows in [from, to): the LAST row per agent in the window (the
 * rows are cumulative, so it holds the agent's total up to then). Agents without turns, and those in `exclude`, are
 * left out.
 * @returns {{ agent: string, type: string, time: string, turns: number, output_per_turn: number|null,
 *   thinking_per_turn: number|null, version: string|null }[]}
 */
function agentTurnStats(rows, { from = -Infinity, to = Infinity, exclude = null } = {}) {
  const last = new Map();
  for (const r of rows ?? []) {
    if (r?.event !== 'done' || !r.tokens) continue;
    const t = Date.parse(r.time);
    if (!(t >= from && t < to)) continue;
    const k = r.agent_id ?? `${r.track ?? '?'}|${r.time}`;
    if (exclude?.has(k)) continue;
    const f = last.get(k);
    if (!f || t >= f.t) last.set(k, { t, r });
  }
  const out = [];
  for (const [agent, { r }] of last) {
    const p = perTurn({
      turns: r.modelTurns,
      output: r.tokens?.output,
      thinking_tokens: r.thinking_tokens,
      thinking_turns: r.thinking_turns,
    });
    if (!p.turns) continue;
    out.push({
      agent,
      type: bareAgentType(r.agent_type) ?? 'unknown',
      time: r.time,
      ...p,
      version: typeof r.cc_version === 'string' && r.cc_version ? r.cc_version : null,
    });
  }
  return out;
}

// ---- 2. The baseline and the warning ----------------------------------------------------------------------------

/**
 * The median output and thinking per turn per agent type, with n. A median under `minN` agents is null (no warning
 * from it): a handful of agents says little about what is normal.
 * @returns {Record<string, { output: { n: number, median: number|null }, thinking: { n: number, median: number|null } }>}
 */
function turnBaseline(stats, { minN = MIN_N } = {}) {
  const per = new Map();
  for (const s of stats ?? []) {
    if (!per.has(s.type)) per.set(s.type, { output: [], thinking: [] });
    const p = per.get(s.type);
    if (s.output_per_turn != null) p.output.push(s.output_per_turn);
    if (s.thinking_per_turn != null) p.thinking.push(s.thinking_per_turn);
  }
  const out = {};
  for (const [type, p] of per) {
    out[type] = {};
    for (const m of METRICS)
      out[type][m] = { n: p[m].length, median: p[m].length >= minN ? Math.round(median(p[m])) : null };
  }
  return out;
}

/**
 * The warnings: an item whose output or thinking per turn is over `factor` times its type's baseline median.
 * @param {{ agent?: string|null, type: string, output_per_turn: number|null, thinking_per_turn: number|null,
 *   version?: string|null }[]} items
 * @returns {{ agent: string|null, type: string, metric: 'output'|'thinking', value: number, median: number, n: number,
 *   ratio: number, version: string|null }[]}
 */
function turnWarnings(items, baseline, { factor = FACTOR } = {}) {
  const out = [];
  for (const x of items ?? []) {
    for (const metric of METRICS) {
      const value = x[`${metric}_per_turn`];
      const base = baseline?.[x.type]?.[metric];
      if (value == null || !(base?.median > 0) || !(value > factor * base.median)) continue;
      out.push({
        agent: x.agent ?? null,
        type: x.type,
        metric,
        value,
        median: base.median,
        n: base.n,
        ratio: round1(value / base.median),
        version: x.version ?? null,
      });
    }
  }
  return out;
}

/** The WARN lines (empty without warnings). */
function turnWarningLines(warnings, { days = BASELINE_DAYS } = {}) {
  if (!warnings?.length) return [];
  const lines = warnings.map(
    (w) =>
      `WARN: ${w.type}${w.agent ? ` ${w.agent}` : ''} ${w.metric} per turn ${fmt(w.value)} is ${w.ratio}x its ${days}-day ` +
      `median ${fmt(w.median)} (n ${w.n})${w.version ? `, Claude Code ${w.version}` : ''}: measurement only, the queue goes on.`,
  );
  lines.push(
    '  The same jump for several agent types at once points outside the work (the model or the Claude Code version): ' +
      'see "Per turn" in ravenseat cost.',
  );
  return lines;
}

/**
 * For `ravenseat cost`: per agent type the median per turn of the agents in the last `recentHours` against the
 * baseline of the `days` before them (those agents left out of it), the warnings, and the Claude Code versions the
 * recent agents ended on.
 */
function turnCheck(rows, { now = Date.now(), recentHours = RECENT_HOURS, days = BASELINE_DAYS, minN = MIN_N, factor = FACTOR } = {}) {
  const recentFrom = now - recentHours * 3_600_000;
  const recent = agentTurnStats(rows, { from: recentFrom, to: now });
  const exclude = new Set(recent.map((s) => s.agent));
  const baseline = turnBaseline(agentTurnStats(rows, { from: recentFrom - days * DAY_MS, to: recentFrom, exclude }), { minN });
  const types = new Map();
  for (const s of recent) {
    if (!types.has(s.type)) types.set(s.type, []);
    types.get(s.type).push(s);
  }
  const med = (xs) => (xs.length ? Math.round(median(xs)) : null);
  const perType = [...types.entries()]
    .map(([type, list]) => ({
      type,
      recent: {
        n: list.length,
        output: med(list.map((s) => s.output_per_turn).filter((x) => x != null)),
        thinking: med(list.map((s) => s.thinking_per_turn).filter((x) => x != null)),
      },
      baseline: baseline[type] ?? { output: { n: 0, median: null }, thinking: { n: 0, median: null } },
    }))
    .sort((a, b) => b.recent.n - a.recent.n || a.type.localeCompare(b.type));
  const warnings = turnWarnings(
    perType.map((p) => ({ type: p.type, output_per_turn: p.recent.output, thinking_per_turn: p.recent.thinking })),
    baseline,
    { factor },
  );
  const versions = new Map();
  for (const s of recent) if (s.version) versions.set(s.version, (versions.get(s.version) ?? 0) + 1);
  return {
    recent_hours: recentHours,
    days,
    perType,
    warnings,
    versions: [...versions.entries()]
      .map(([version, agents]) => ({ version, agents }))
      .sort((a, b) => b.agents - a.agents || a.version.localeCompare(b.version)),
  };
}

/** The "Per turn" lines for `ravenseat cost`. */
function turnCheckLines(c) {
  const head = `Per turn (median per agent type, the last ${c.recent_hours} h against the ${c.days} days before; n = agents):`;
  if (!c.perType.length) return [`${head} no agent finished in the last ${c.recent_hours} h.`];
  const v = (x) => (x == null ? '?' : fmt(x));
  const base = (b) => (b.median == null ? `? (n ${b.n}, too few)` : `${fmt(b.median)} (n ${b.n})`);
  const out = [head];
  for (const p of c.perType)
    out.push(
      `  ${p.type.padEnd(18)} output ${v(p.recent.output)} (n ${p.recent.n}) vs ${base(p.baseline.output)}` +
        `   thinking ${v(p.recent.thinking)} vs ${base(p.baseline.thinking)}`,
    );
  for (const l of turnWarningLines(c.warnings, { days: c.days })) out.push(`  ${l}`);
  if (c.versions.length)
    out.push(`  Claude Code in the last ${c.recent_hours} h: ${c.versions.map((x) => `${x.version} (${x.agents})`).join(', ')}`);
  return out;
}

// ---- 3. Build, review and fix round -------------------------------------------------------------------------------

/** The cumulative cost of the agent's last done row at or before `time`, or null when it has none (or no time). */
function costBefore(rows, agent, time) {
  const limit = Date.parse(time ?? '');
  if (!Number.isFinite(limit)) return null;
  let best = null;
  for (const r of rows ?? []) {
    if (r?.event !== 'done' || !r.tokens || r.agent_id !== agent) continue;
    const t = Date.parse(r.time);
    if (!(t <= limit)) continue;
    if (!best || t >= best.t) best = { t, r };
  }
  return best ? TK.costOf(best.r) : null;
}

/**
 * The task's cost split into build, review and fix round (the rule is at the top of this file).
 * @param {{ taskId: string, agents: { agent: string, type: string, usd: number, track?: string|null }[],
 *   resumed?: { round: number, reason: string }[], tReceive?: string|null, rows?: object[],
 *   isReviewer: (type: string) => boolean }} input
 * @returns {{ phases: { build: number, review: number, fix: number, fix_rounds: number },
 *   perAgent: Record<string, { phase: 'build'|'review'|'fix', fix_usd?: number }> }}
 */
function costPhases({ taskId, agents, resumed = [], tReceive = null, rows = [], isReviewer }) {
  const sum = { build: 0, review: 0, fix: 0 };
  const rounds = new Set();
  let continued = false;
  const perAgent = {};
  const reasonOf = new Map((Array.isArray(resumed) ? resumed : []).map((r) => [r?.round, r?.reason]));
  const ofTask = (track) => track != null && TK.taskIdFor(track, (x) => x === taskId) === taskId;
  for (const a of agents ?? []) {
    const cost = Number(a.usd) || 0;
    if (isReviewer(a.type)) {
      sum.review += cost;
      perAgent[a.agent] = { phase: 'review' };
      continue;
    }
    const n = ofTask(a.track) ? TK.roundOf(a.track) : null;
    if (n != null) {
      const reason = reasonOf.get(n);
      if (reason && reason !== 'fix') {
        sum.build += cost;
        perAgent[a.agent] = { phase: 'build' };
      } else {
        sum.fix += cost;
        rounds.add(n);
        perAgent[a.agent] = { phase: 'fix' };
      }
      continue;
    }
    // The bare track agent: what it used after the first receive, having stopped before it, is a SendMessage fix round.
    const before = costBefore(rows, a.agent, tReceive);
    const after = before != null ? round2(Math.max(0, cost - before)) : 0;
    if (after >= 0.01) {
      sum.build += cost - after;
      sum.fix += after;
      continued = true;
      perAgent[a.agent] = { phase: 'build', fix_usd: after };
    } else {
      sum.build += cost;
      perAgent[a.agent] = { phase: 'build' };
    }
  }
  // A fix round `ravenseat resume` ran as a continuation (mode continue: the same agent sent the fix list, no -r<N>
  // agent) is one round each; its cost is the growth above. Without such entries a growth after receive is one round.
  const continuedRounds = (Array.isArray(resumed) ? resumed : [])
    .filter((r) => r?.reason === 'fix' && r?.mode === 'continue' && Number.isFinite(r.round))
    .map((r) => r.round);
  const all = new Set([...rounds, ...continuedRounds]);
  return {
    phases: {
      build: round2(sum.build),
      review: round2(sum.review),
      fix: round2(sum.fix),
      fix_rounds: all.size + (continued && !continuedRounds.length ? 1 : 0),
    },
    perAgent,
  };
}

/** " · build $4.00 review $0.50 fix $2.00 (1 fix round(s))" for the measurement line; empty without phases. */
function phaseText(phases) {
  if (!phases) return '';
  return (
    ` · build ${usd(phases.build)} review ${usd(phases.review)} fix ${usd(phases.fix)}` +
    (phases.fix_rounds ? ` (${phases.fix_rounds} fix round(s))` : '')
  );
}

// ---- 5. The breakdown -------------------------------------------------------------------------------------------

/** Why a usage event belongs to no task, as text. */
const REASON_TEXT = {
  'no-task-id': 'no task id in the mission (the label is the agent id: a helper, Explore or general-purpose agent, or a mission without a prompt file)',
  'not-a-task': 'a label that is no task in the queue or its archive',
  'no-agent-type': 'no agent type in the time log row (the hook got none)',
};

/**
 * The usage events that belong to no task (the "unknown" / "no task" part of the cost), split by why: no agent type,
 * no task id in the mission, or a label that is no queue task. Synthetic model entries (Claude Code's own API error
 * entries) are never priced (timeCost.analyzeTranscript), so they cannot land here.
 * @param {object[]} events timeCost.usageEvents, already in the window
 * @param {{ exists: (id: string) => boolean }} o  is the id a queue task (archive included)?
 * @returns {{ usd: number, agents: number, reasons: { reason: string, text: string, usd: number, agents: number,
 *   types: { type: string, usd: number, agents: number }[] }[] }}
 */
function unknownSources(events, { exists }) {
  const per = new Map();
  const all = new Set();
  let total = 0;
  for (const h of events ?? []) {
    if (h.track && TK.taskIdFor(h.track, exists)) continue;
    const labelIsAgent = !h.track || String(h.agent ?? '').startsWith(String(h.track));
    const reason = h.type === 'unknown' ? 'no-agent-type' : labelIsAgent ? 'no-task-id' : 'not-a-task';
    if (!per.has(reason)) per.set(reason, { usd: 0, agents: new Set(), types: new Map() });
    const p = per.get(reason);
    const u = Number(h.usd) || 0;
    p.usd += u;
    p.agents.add(h.agent);
    const t = p.types.get(h.type) ?? { usd: 0, agents: new Set() };
    t.usd += u;
    t.agents.add(h.agent);
    p.types.set(h.type, t);
    all.add(h.agent);
    total += u;
  }
  return {
    usd: round2(total),
    agents: all.size,
    reasons: [...per.entries()]
      .map(([reason, p]) => ({
        reason,
        text: REASON_TEXT[reason],
        usd: round2(p.usd),
        agents: p.agents.size,
        types: [...p.types.entries()]
          .map(([type, t]) => ({ type, usd: round2(t.usd), agents: t.agents.size }))
          .sort((a, b) => b.usd - a.usd || a.type.localeCompare(b.type)),
      }))
      .sort((a, b) => b.usd - a.usd || a.reason.localeCompare(b.reason)),
  };
}

/**
 * The breakdown as one object: the subagent parts (costEstimate.perMergedChange), the orchestrator and other main
 * sessions (eventStatistics.orchestrationOverhead, net of their subagents), the unknown sources and the cost priced at
 * the default model's price.
 */
function breakdown({ merged, orchestration, unknown, assumedUsd = 0 }) {
  return {
    total_usd: Number(merged?.total_usd) || 0,
    parts: merged?.parts ?? { merged: 0, cancelled: 0, open: 0, unattributed: 0 },
    orchestrator: { usd: Number(orchestration?.usd) || 0, sessions: orchestration?.sessions ?? 0 },
    other_sessions: { usd: Number(orchestration?.other?.usd) || 0, sessions: orchestration?.other?.sessions ?? 0 },
    unknown,
    assumed_usd: round2(assumedUsd),
  };
}

/** The "Where the cost went" lines for `ravenseat cost`. */
function breakdownLines(b, label) {
  const all = b.total_usd + b.orchestrator.usd + b.other_sessions.usd;
  const pct = (x) => (all > 0 ? `${Math.round((x / all) * 100)} %` : '0 %');
  const out = [
    `Where the cost went (${label}): ${usd(all)} measured (subagents from the time log, main sessions from the status line)`,
  ];
  const orch = b.orchestrator.sessions
    ? `orchestrator session(s) ${usd(b.orchestrator.usd)} (${pct(b.orchestrator.usd)}, ${b.orchestrator.sessions} session(s))`
    : 'orchestrator session not recorded (the status line saves it: ravenseat setup --settings)';
  out.push(
    `  merged tasks ${usd(b.parts.merged)} (${pct(b.parts.merged)}), cancelled ${usd(b.parts.cancelled)}, still open ` +
      `${usd(b.parts.open)}, ${orch}` +
      (b.other_sessions.sessions ? `, other main sessions ${usd(b.other_sessions.usd)}` : '') +
      `, unknown ${usd(b.parts.unattributed)} (${pct(b.parts.unattributed)})`,
  );
  for (const r of b.unknown?.reasons ?? [])
    out.push(
      `  unknown: ${r.text ?? REASON_TEXT[r.reason] ?? r.reason}: ${usd(r.usd)}, ${r.agents} agent(s): ` +
        r.types.slice(0, 4).map((t) => `${t.type} ${usd(t.usd)}`).join(', '),
    );
  if (b.assumed_usd > 0)
    out.push(`  priced at the default model's price (a model id with no price; set prices in queue.config.json): ${usd(b.assumed_usd)}`);
  return out;
}

// ---- 4. Week over week ------------------------------------------------------------------------------------------

/**
 * This week (the last 7 days) against the week before: spend by usage time (the usage events), the orchestrator's
 * net cost from `orchestratorUsd(from, to)` (null when not given), and the tasks by START date: how many started, how
 * many of those are done with a measured cost, and their median cost, also per class.
 */
function weekOverWeek({ queue, events = [], now = Date.now(), orchestratorUsd = null }) {
  const tasks = (queue?.tasks ?? []).filter((o) => o?.external !== true);
  const week = (from, to) => {
    const inW = (t) => Number.isFinite(t) && t >= from && t < to;
    const evs = (events ?? []).filter((h) => inW(Date.parse(h.time ?? '')));
    const started = tasks.filter((o) => inW(Date.parse(o.started ?? '')));
    const measured = started.filter((o) => o.status === 'done' && !o.cloud && num(o.cost?.usd) != null);
    const perClass = {};
    for (const o of measured) (perClass[o.class ?? '?'] ??= []).push(Number(o.cost.usd));
    const m = median(measured.map((o) => Number(o.cost.usd)));
    return {
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      usd: round2(evs.reduce((s, h) => s + (Number(h.usd) || 0), 0)),
      agents: new Set(evs.map((h) => h.agent)).size,
      orchestrator_usd: typeof orchestratorUsd === 'function' ? round2(Number(orchestratorUsd(from, to)) || 0) : null,
      started: started.length,
      done: measured.length,
      median_usd: m == null ? null : round2(m),
      perClass: Object.entries(perClass)
        .map(([cls, xs]) => ({ class: cls, n: xs.length, median_usd: round2(median(xs)) }))
        .sort((a, b) => a.class.localeCompare(b.class)),
    };
  };
  return { this: week(now - WEEK_MS, now), last: week(now - 2 * WEEK_MS, now - WEEK_MS) };
}

/** The week-over-week lines for `ravenseat cost`. */
function weekLines(w) {
  const change = (a, b) => (a == null || b == null || !(b > 0) ? '?' : `${a >= b ? '+' : ''}${Math.round(((a - b) / b) * 100)} %`);
  const line = (name, x) =>
    `  ${name.padEnd(10)} subagents ${usd(x.usd)} (${x.agents} agent(s))` +
    (x.orchestrator_usd != null ? `, orchestrator ${usd(x.orchestrator_usd)}` : '') +
    `; tasks started n=${x.started}, done n=${x.done}` +
    (x.median_usd != null ? `, median ${usd(x.median_usd)} per done task` : '') +
    (x.perClass.length ? ` (${x.perClass.map((k) => `${k.class} ${usd(k.median_usd)} n=${k.n}`).join(', ')})` : '');
  return [
    'Week over week (spend by usage time; tasks by start date):',
    line('this week', w.this),
    line('last week', w.last),
    `  ${'change'.padEnd(10)} subagents ${change(w.this.usd, w.last.usd)}` +
      (w.this.orchestrator_usd != null ? `, orchestrator ${change(w.this.orchestrator_usd, w.last.orchestrator_usd)}` : '') +
      `, median per done task ${change(w.this.median_usd, w.last.median_usd)}`,
  ];
}

module.exports = {
  BASELINE_DAYS,
  MIN_N,
  FACTOR,
  RECENT_HOURS,
  REASON_TEXT,
  perTurn,
  agentTurnStats,
  turnBaseline,
  turnWarnings,
  turnWarningLines,
  turnCheck,
  turnCheckLines,
  costBefore,
  costPhases,
  phaseText,
  unknownSources,
  breakdown,
  breakdownLines,
  weekOverWeek,
  weekLines,
};
