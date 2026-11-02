// =============================================================
// eventStatistics.js: the views on the flow, load and session rows (lib/eventRows.js): the orchestration overhead,
// the flow figures (first-pass rate, fix rounds, merge conflicts, base red, pushes, triage) and when parallelism was
// limited by the load.
//
// Pure functions on the time log rows (timeCost.readRows), the usage events (timeCost.usageEvents) and the queue,
// apart from readAgentsBySession (one readdir per session). Used by cli/cost.mjs (cq cost, cq limit) and
// queue-board.mjs (the Statistics tab).
//
// THE ORCHESTRATION OVERHEAD (orchestrationOverhead): the main sessions' cost comes from the status line payload
// (cost.total_cost_usd), which is cumulative per session id. Per session the readings are taken in time order and each
// reading adds its growth since the previous one (a reading BELOW the previous one means the counter started over:
// it adds its whole value). The growth of the readings inside [from, to) is the session's cost in the window, so a
// session that runs across the window's start counts only its part. The session total in Claude Code counts the
// session's own requests and, as far as we know (not verified against the source), the subagents it started too:
// so the subagents the session started (their transcripts are in <projects>/<session>/subagents/, the same files the
// time log is made from) are subtracted with their usage in the window, and what is left is the main conversation
// itself. "Orchestration overhead" is that net figure for the sessions bound as the orchestrator (orchestrator.json);
// other main sessions (the owner's own) are shown apart. It is divided by the same merged changes as the headline
// USD per merged change (lib/costEstimate.js perMergedChange) and shown as a share of track cost + overhead, so it is
// never folded into the track figure and never hides it.
//
// Tested in lib/__tests__/eventStatistics.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DAY_MS = 86_400_000;
const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;
const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** Rows of one event in [from, to), sorted by time. */
function rowsOf(rows, event, from, to) {
  return (rows ?? [])
    .filter((r) => r?.event === event)
    .map((r) => ({ r, t: Date.parse(r.time ?? '') }))
    .filter((x) => Number.isFinite(x.t) && x.t >= from && x.t < to)
    .sort((x, y) => x.t - y.t)
    .map((x) => x.r);
}

function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// ---- Session cost ------------------------------------------------------------------------------------------------

/**
 * The cost per main session in [from, to) from the cumulative `session` rows (see the header).
 * @returns {{ session_id: string, usd: number, orchestrator: boolean, readings: number, last_usd: number }[]}
 *   orchestrator = any row of the session says so; sessions without growth in the window are left out
 */
function sessionCosts(rows, { from = -Infinity, to = Infinity } = {}) {
  const per = new Map();
  for (const r of rows ?? []) {
    if (r?.event !== 'session' || !r.session_id || num(r.usd) == null) continue;
    const t = Date.parse(r.time ?? '');
    if (!Number.isFinite(t)) continue;
    if (!per.has(r.session_id)) per.set(r.session_id, []);
    per.get(r.session_id).push({ t, usd: r.usd, orchestrator: r.orchestrator === true });
  }
  const out = [];
  for (const [id, list] of per) {
    list.sort((a, b) => a.t - b.t);
    let previous = 0;
    let usd = 0;
    let readings = 0;
    for (const x of list) {
      const growth = x.usd >= previous ? x.usd - previous : x.usd;
      if (x.t >= from && x.t < to) {
        usd += growth;
        readings += 1;
      }
      previous = x.usd;
    }
    if (!readings) continue;
    out.push({
      session_id: id,
      usd: round2(usd),
      orchestrator: list.some((x) => x.orchestrator),
      readings,
      last_usd: list[list.length - 1].usd,
    });
  }
  return out.sort((a, b) => b.usd - a.usd);
}

/** The subagents per session from the transcript folders: Map session id -> Set of agent ids (empty when none). */
function readAgentsBySession(transcriptsDir, sessionIds) {
  const out = new Map();
  for (const id of sessionIds ?? []) {
    const set = new Set();
    try {
      for (const n of fs.readdirSync(path.join(transcriptsDir, id, 'subagents'))) {
        const m = /^agent-(.+)\.jsonl$/.exec(n);
        if (m) set.add(m[1]);
      }
    } catch {
      // no folder: no subagents known for the session
    }
    out.set(id, set);
  }
  return out;
}

/**
 * The orchestration overhead in [from, to) (see the header).
 * @param {{ rows: object[], events: object[], from: number, to: number, merged: number, trackUsd: number,
 *   agentsBySession?: Map<string, Set<string>> }} x  events = timeCost.usageEvents; merged and trackUsd = the
 *   headline's merged count and total (costEstimate.perMergedChange), so the figures share one window
 * @returns {{ sessions: number, gross_usd: number, subagent_usd: number, usd: number, usd_per_merged: number|null,
 *   share_pct: number|null, other: { sessions: number, gross_usd: number, subagent_usd: number, usd: number },
 *   subagents_known: boolean }}
 */
function orchestrationOverhead({ rows, events = [], from, to, merged = 0, trackUsd = 0, agentsBySession = new Map() }) {
  const inWindow = (t) => Number.isFinite(t) && t >= from && t < to;
  const costs = sessionCosts(rows, { from, to });
  const part = (list) => {
    let gross = 0;
    let sub = 0;
    let net = 0;
    for (const s of list) {
      const agents = agentsBySession.get(s.session_id) ?? new Set();
      const own = (events ?? [])
        .filter((h) => agents.has(h.agent) && inWindow(Date.parse(h.time ?? '')))
        .reduce((x, h) => x + (Number(h.usd) || 0), 0);
      gross += s.usd;
      sub += Math.min(own, s.usd);
      net += Math.max(0, s.usd - own);
    }
    return { sessions: list.length, gross_usd: round2(gross), subagent_usd: round2(sub), usd: round2(net) };
  };
  const orch = part(costs.filter((s) => s.orchestrator));
  const other = part(costs.filter((s) => !s.orchestrator));
  const both = orch.usd + (Number(trackUsd) || 0);
  return {
    ...orch,
    usd_per_merged: merged > 0 ? round2(orch.usd / merged) : null,
    share_pct: orch.sessions && both > 0 ? round1((orch.usd / both) * 100) : null,
    other,
    subagents_known: costs.some((s) => (agentsBySession.get(s.session_id)?.size ?? 0) > 0),
  };
}

/** The overhead as text lines for `cq cost` (after the headline). */
function overheadLines(o, label) {
  const $ = (x) => `$${Number(x).toFixed(2)}`;
  if (!o.sessions && !o.other.sessions)
    return [
      `Orchestration overhead (${label}): no session cost recorded (the status line saves it; cq setup --settings sets it up).`,
    ];
  const out = [];
  if (o.sessions)
    out.push(
      `Orchestration overhead (${label}): ${$(o.usd)} in ${o.sessions} orchestrator session(s)` +
        (o.usd_per_merged != null ? ` = ${$(o.usd_per_merged)} per merged change` : '') +
        (o.share_pct != null ? `, ${o.share_pct} % of track cost + overhead` : '') +
        ' (not in the figure above)',
      `  session total ${$(o.gross_usd)} from the status line, minus ${$(o.subagent_usd)} for the subagents the session started` +
        (o.subagents_known ? '' : ' (no subagent transcripts found for the session: nothing subtracted)'),
    );
  else out.push(`Orchestration overhead (${label}): no orchestrator session cost recorded in the window.`);
  if (o.other.sessions)
    out.push(`  other main sessions (not bound as the orchestrator): ${$(o.other.usd)} in ${o.other.sessions} session(s)`);
  return out;
}

// ---- Flow figures ------------------------------------------------------------------------------------------------

/** The fix rounds a task has had (queue.json `resumed` with reason fix; the same rule as lib/doneCheck.js). */
const fixRounds = (o) => (Array.isArray(o?.resumed) ? o.resumed : []).filter((r) => r?.reason === 'fix').length;

/**
 * The flow figures in [from, to).
 *   firstPass: the tasks that reached done in the window (not fix tasks of another task: `fixes` or `qa_original`),
 *     and how many of them had 0 fix rounds (queue.json `resumed`, so it also covers the time before the rows existed),
 *   fixRounds: per merged task (the same tasks), and the fixRound rows started in the window,
 *   mergeConflicts: the mergeConflict rows (not the merge guard's stops, counted apart), per week,
 *   baseGate: recorded verdicts, how many were skipped by the skip rule, red verdicts and red tips, the median run time,
 *   pushes: the push rows (deduplicated on tip + time), the merged tasks and commits per push,
 *   triage: the verdicts by word.
 */
function flowStatistics(queue, rows, { from, to }) {
  const weeks = Math.max(1 / 7, (to - from) / (7 * DAY_MS));
  const inWindow = (t) => Number.isFinite(t) && t >= from && t < to;
  const tasks = (queue?.tasks ?? []).filter((o) => o && o.external !== true);
  const isFix = (o) =>
    (typeof o.qa_original === 'string' && o.qa_original !== o.id) ||
    (Array.isArray(o.fixes) ? o.fixes.length > 0 : typeof o.fixes === 'string' && !!o.fixes);
  const merged = tasks.filter((o) => o.status === 'done' && inWindow(Date.parse(o.done ?? '')) && !isFix(o));
  const rounds = merged.map(fixRounds);
  const first = rounds.filter((n) => n === 0).length;

  const fixRows = rowsOf(rows, 'fixRound', from, to);
  const conflicts = rowsOf(rows, 'mergeConflict', from, to);
  const real = conflicts.filter((r) => !r.guard);
  const gates = rowsOf(rows, 'baseGate', from, to);
  const red = gates.filter((r) => r.ok === false);
  const durations = gates.map((r) => num(r.duration_s)).filter((x) => x != null);
  const seen = new Set();
  const pushes = rowsOf(rows, 'push', from, to).filter((r) => {
    const k = `${r.tip}|${r.time}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const sizes = pushes.map((r) => Number(r.task_count) || 0);
  const commits = pushes.map((r) => num(r.commits)).filter((x) => x != null);
  const triage = {};
  for (const r of rowsOf(rows, 'triage', from, to)) triage[r.verdict] = (triage[r.verdict] ?? 0) + 1;

  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    firstPass: {
      merged: merged.length,
      first_pass: first,
      rate_pct: merged.length ? round1((first / merged.length) * 100) : null,
    },
    fixRounds: {
      per_task: merged.length ? round2(rounds.reduce((a, b) => a + b, 0) / merged.length) : null,
      started: fixRows.filter((r) => r.reason === 'fix').length,
      continuations: fixRows.filter((r) => r.reason !== 'fix').length,
    },
    mergeConflicts: {
      count: real.length,
      per_week: round1(real.length / weeks),
      files: real.reduce((s, r) => s + (Number(r.files) || 0), 0),
      guard_stops: conflicts.length - real.length,
    },
    baseGate: {
      verdicts: gates.length,
      skipped: gates.filter((r) => r.skipped).length,
      red: red.length,
      red_tips: new Set(red.map((r) => r.tip)).size,
      median_s: durations.length ? round1(median(durations)) : null,
    },
    pushes: {
      count: pushes.length,
      per_week: round1(pushes.length / weeks),
      tasks_per_push: pushes.length ? round1(sizes.reduce((a, b) => a + b, 0) / pushes.length) : null,
      max_tasks: sizes.length ? Math.max(...sizes) : null,
      commits_per_push: commits.length ? round1(commits.reduce((a, b) => a + b, 0) / commits.length) : null,
      red_tip: pushes.filter((r) => r.base_health === 'red').length,
    },
    triage,
  };
}

/** The flow figures as text lines for `cq cost`. */
function flowLines(f, label) {
  const pct = (x) => (x == null ? '-' : `${x} %`);
  const v = (x) => (x == null ? '-' : String(x));
  const triage = Object.entries(f.triage)
    .map(([k, n]) => `${k} ${n}`)
    .join(', ');
  return [
    `Flow (${label}):`,
    `  first pass: ${f.firstPass.first_pass} of ${f.firstPass.merged} merged with 0 fix rounds (${pct(f.firstPass.rate_pct)}); ` +
      `fix rounds per merged task ${v(f.fixRounds.per_task)}; fix rounds started ${f.fixRounds.started}, continuations ${f.fixRounds.continuations}`,
    `  merge conflicts: ${f.mergeConflicts.count} (${f.mergeConflicts.per_week} per week, ${f.mergeConflicts.files} file(s))` +
      (f.mergeConflicts.guard_stops ? `; merge guard stops ${f.mergeConflicts.guard_stops}` : ''),
    `  base gate: ${f.baseGate.verdicts} verdict(s), ${f.baseGate.skipped} by the skip rule, red ${f.baseGate.red} ` +
      `(${f.baseGate.red_tips} tip(s))` + (f.baseGate.median_s != null ? `, median run ${f.baseGate.median_s} s` : ''),
    `  pushes: ${f.pushes.count} (${f.pushes.per_week} per week)` +
      (f.pushes.count
        ? `, ${v(f.pushes.tasks_per_push)} merged task(s) per push (max ${v(f.pushes.max_tasks)}), ` +
          `${v(f.pushes.commits_per_push)} commit(s) per push` +
          (f.pushes.red_tip ? `, ${f.pushes.red_tip} with a red base tip` : '')
        : ''),
    `  triage verdicts: ${triage || 'none'}`,
  ];
}

// ---- Load ------------------------------------------------------------------------------------------------------

/**
 * When parallelism was limited in [from, to), from the `load` rows (one per fill and start).
 * @returns {{ rows: number, limited: number, stopped: number, override: number, by: Record<string, number>,
 *   min_free_memory_pct: number|null, recent: object[] }}  recent = the last few limited or stopped rows, newest first
 */
function loadStatistics(rows, { from, to, recent = 5 } = {}) {
  const list = rowsOf(rows, 'load', from, to);
  const limited = list.filter((r) => r.limited_by);
  const stopped = list.filter((r) => r.stopped);
  const by = {};
  for (const r of limited) by[r.limited_by] = (by[r.limited_by] ?? 0) + 1;
  const free = list.map((r) => num(r.free_memory_pct)).filter((x) => x != null);
  return {
    rows: list.length,
    limited: limited.length,
    stopped: stopped.length,
    override: list.filter((r) => r.override).length,
    by,
    min_free_memory_pct: free.length ? Math.min(...free) : null,
    recent: list
      .filter((r) => r.limited_by || r.stopped)
      .slice(-recent)
      .reverse()
      .map((r) => ({
        time: r.time,
        command: r.command,
        slots: r.slots,
        max_slots: r.max_slots,
        running: r.running,
        reason: r.stopped ? r.stop_reason : r.reason,
        stopped: !!r.stopped,
      })),
  };
}

/** The load history as text lines for `cq limit`. */
function loadLines(s, label) {
  if (!s.rows) return [`Load history (${label}): no fill or start recorded yet.`];
  const by = Object.entries(s.by)
    .map(([k, n]) => `${k} ${n}`)
    .join(', ');
  const out = [
    `Load history (${label}): ${s.rows} fill/start, slots limited ${s.limited}` + (by ? ` (${by})` : ''),
    `  stopped (machine full, exit 7) ${s.stopped}` +
      (s.override ? `, guard skipped by the owner ${s.override}` : '') +
      (s.min_free_memory_pct != null ? `; lowest free memory ${s.min_free_memory_pct} %` : ''),
  ];
  for (const r of s.recent)
    out.push(
      `  ${String(r.time).slice(0, 16).replace('T', ' ')} ${r.command.padEnd(5)} ${r.stopped ? 'STOPPED' : 'limited'}: ` +
        `${r.reason ?? '?'} (${r.running ?? '?'} running)`,
    );
  return out;
}

module.exports = {
  sessionCosts,
  readAgentsBySession,
  orchestrationOverhead,
  overheadLines,
  fixRounds,
  flowStatistics,
  flowLines,
  loadStatistics,
  loadLines,
};
