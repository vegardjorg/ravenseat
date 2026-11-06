// =============================================================
// eventStatistics.js: the views on the flow, load and session rows (lib/eventRows.js): the orchestration overhead,
// the flow figures (first-pass rate, fix rounds, merge conflicts, base red, pushes, triage), the quality figures
// (right first time, post-merge defects, owner interventions, reviewer hit rate, inflow by source) and when parallelism
// was limited by the load.
//
// Pure functions on the time log rows (timeCost.readRows), the usage events (timeCost.usageEvents) and the queue,
// apart from readAgentsBySession (one readdir per session). Used by cli/cost.mjs (ravenseat cost, ravenseat limit) and
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
// THE QUALITY FIGURES (part of flowStatistics, from data that already exists; old tasks without a field count as
// "nothing recorded", never as an error):
//   rightFirstTime: a merged task (the same tasks as firstPass) is right first time when it had 0 fix rounds, no QA
//     deviation (qa_status deviation or a qa_note), was not reopened (a changelog change of its status away from done),
//     and has no post-merge defect. A post-merge defect is a reverted merge (git says "This reverts commit <merge_commit>",
//     or the task was cancelled after it merged: those count among the merged here), a fix task that names it (`fixes`, or `qa_original` for the
//     QA fix chain; a base gate fix task names the task that made the base red) or a finding whose `finding.causes`
//     names it (`ravenseat finding --cause <id>`). Owner interventions are the changelog entries by owner or theBoard that
//     change the task between its start (started, otherwise picked_at) and done. The changelog keeps the last 50
//     entries, so a task started before the oldest kept entry is "unknown" for interventions (when entries fell out).
//   reviewers: per reviewer type, over the tasks done in the window with a cost measurement (cost.agents, saved at
//     set done): runs, runs whose FINDINGS line had H+M+L > 0, runs with no FINDINGS line recorded, the fix rounds the
//     orchestrator attributed to the type (`resumed[].from`, from `ravenseat resume --from`), and the dismissed ones (runs
//     with findings minus attributed fixes, never below 0). A type with REVIEWER_HINT_RUNS runs or more and no fix gets
//     a hint, but only once some fix round in the window carries `from` (otherwise every type would look useless).
//   autonomy: how far the queue got without the owner.
//     verified_per_intervention = the verified merged tasks (right first time, or every defect fixed: each fix task
//       done, no QA deviation open) divided by the owner interventions above; null ("no interventions") when 0.
//     longest_stretch_h = the longest period in the window when work ran with no owner action: work runs while some
//       task is between its start (started, otherwise picked_at) and its done (otherwise delivered; still open = the
//       window's end), so a time when nothing ran (all work waiting, on an owner question or otherwise) ends a stretch;
//       an owner action cuts it. Owner actions: changelog entries and undos by owner or theBoard, resolutions by
//       owner or theBoard, approvals not made by the auto-accept, qa ok not by auto, a QA deviation (the QA fix task's
//       added_at) and tasks the owner added. Old tasks without a start add no work time.
//     corrected = the failures on the tasks done in the window that ended green with no owner action on that task:
//       fix rounds from review (resumed reason fix), red done commands (fix rounds with from done_when, written by
//       ravenseat receive and ravenseat merge) and base red fix tasks (added_by base gate). An owner action on the task: an owner
//       changelog entry that changes it, a QA deviation on it, or an owner answer to its fix-round cap question.
//   inflow: the tasks added in the window by source (fix tasks, tasks from a finding via its plan entry = triage,
//     agent proposals, the owner, other = the orchestrator or unknown), and added versus done for the last
//     INFLOW_WEEKS whole weeks before the window's end; a hint when more came in than went out in each of them.
//
// Tested in lib/__tests__/eventStatistics.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { isAgentSource } = require('./logic/questions.js');

const DAY_MS = 86_400_000;
/** The `by` values that mean the owner (the board writes theBoard for edits and owner for answers; lib/ownerWait.js). */
const OWNER_BY = new Set(['owner', 'theBoard']);
/** The id prefix of the plan entries `ravenseat finding` creates (lib/queueFindings.js). */
const FINDING_PREFIX = 'PL-FINDING-';
/** A reviewer type with at least this many runs and no fix round gets the hint. */
const REVIEWER_HINT_RUNS = 10;
/** Inflow above outflow this many whole weeks in a row gives the hint. */
const INFLOW_WEEKS = 3;
/** The `--from` value ravenseat receive and ravenseat merge pass for a fix round after a red done command (not a reviewer). */
const DONE_WHEN = 'done_when';
/** The inflow sources, in the order they are shown. */
const INFLOW_SOURCES = ['owner', 'agent', 'fix', 'triage', 'other'];
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

/** The overhead as text lines for `ravenseat cost` (after the headline). */
function overheadLines(o, label) {
  const $ = (x) => `$${Number(x).toFixed(2)}`;
  if (!o.sessions && !o.other.sessions)
    return [
      `Orchestration overhead (${label}): no session cost recorded (the status line saves it; ravenseat setup --settings sets it up).`,
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

/**
 * Did this `resumed` entry's round really run? `ravenseat resume` only prepares a round, so its attempt (same round number)
 * must have started or delivered. Tasks from before attempts existed have none: their rounds count.
 */
function roundRan(o, r) {
  const attempts = (Array.isArray(o?.attempts) ? o.attempts : []).filter((x) => x?.round === r?.round);
  return !attempts.length || attempts.some((x) => x.started || x.delivered_sha || x.state === 'running');
}
/** The fix rounds that ran. The cap in lib/doneCheck.js counts every one issued, on purpose: it stops a loop. */
const fixList = (o) => (Array.isArray(o?.resumed) ? o.resumed : []).filter((r) => r?.reason === 'fix' && roundRan(o, r));
const fixRounds = (o) => fixList(o).length;

/** The commits a `git log --format=%B` text says were reverted ("This reverts commit <sha>"). */
function revertedCommitsIn(text) {
  return new Set([...String(text ?? '').matchAll(/This reverts commit ([0-9a-f]{7,40})/g)].map((m) => m[1]));
}

/** The task's `fixes` as a list (a string or a list; lib/fixLinks.js). */
const fixesOf = (o) => (Array.isArray(o?.fixes) ? o.fixes : typeof o?.fixes === 'string' && o.fixes ? [o.fixes] : []);
/** Is the task a fix task of another task (`fixes`, or a QA fix with `qa_original`)? Fix tasks are not merged changes. */
const isFixTask = (o) => (typeof o?.qa_original === 'string' && o.qa_original !== o.id) || fixesOf(o).length > 0;
const per10 = (n, of) => (of > 0 ? round1((n / of) * 10) : null);

/**
 * The right-first-time figures for the merged tasks (see the header).
 * @param {object[]} merged the tasks done in the window that are not fix tasks
 * @param {object} queue  for the other tasks (fix tasks) and the changelog
 * @param {object|null} plans the plan register (findings with `finding.causes`); null = no findings known
 * @param {(o: object) => boolean} wasReverted the merge was undone afterwards: one defect
 */
function rightFirstTime(merged, queue, plans, wasReverted = () => false) {
  const tasks = (queue?.tasks ?? []).filter(Boolean);
  const log = (Array.isArray(queue?.changelog) ? queue.changelog : []).filter((e) => e && Array.isArray(e.changes));
  // The changelog keeps its last entries only: when entry 1 is gone, what happened before the oldest kept one is unknown.
  const oldestNr = log.reduce((m, e) => Math.min(m, Number(e.nr) || Infinity), Infinity);
  const oldestAt = log.reduce((m, e) => Math.min(m, Date.parse(e.at ?? '') || Infinity), Infinity);
  const complete = !log.length || oldestNr <= 1;
  const findings = (plans?.entries ?? []).filter((p) => p?.finding && Array.isArray(p.finding.causes));
  let right = 0;
  let defects = 0;
  let interventions = 0;
  let known = 0;
  const misses = [];
  for (const o of merged) {
    const fixTasks = tasks.filter((t) => t.id !== o.id && (fixesOf(t).includes(o.id) || t.qa_original === o.id));
    const caused = findings.filter((p) => p.finding.causes.includes(o.id));
    const qa = o.qa_status === 'deviation' || (typeof o.qa_note === 'string' && !!o.qa_note);
    const reopened = log.some((e) =>
      e.changes.some((c) => c?.id === o.id && c.field === 'status' && c.before === 'done' && c.after !== 'done'),
    );
    const rounds = fixRounds(o);
    const reverted = wasReverted(o);
    const d = fixTasks.length + caused.length + (reverted ? 1 : 0);
    defects += d;
    if (!rounds && !qa && !reopened && !d) right += 1;
    else
      misses.push({
        id: o.id,
        fix_rounds: rounds,
        qa_deviation: qa,
        reopened,
        reverted,
        defects: [...fixTasks.map((t) => t.id), ...caused.map((p) => p.id), ...(reverted ? [`${o.id} reverted`] : [])],
      });
    // Owner interventions: the owner's logged edits of the task while it ran (start to done).
    const start = Date.parse(o.started ?? o.picked_at ?? '');
    const end = Date.parse(o.done ?? '');
    if (!Number.isFinite(start) || !Number.isFinite(end) || (!complete && !(oldestAt <= start))) continue;
    known += 1;
    interventions += log.filter((e) => {
      const t = Date.parse(e.at ?? '');
      return OWNER_BY.has(String(e.by ?? '').trim()) && t >= start && t <= end && e.changes.some((c) => c?.id === o.id);
    }).length;
  }
  return {
    merged: merged.length,
    right,
    rate_pct: merged.length ? round1((right / merged.length) * 100) : null,
    defects,
    defects_per_10: per10(defects, merged.length),
    findings_linked: findings.length > 0,
    interventions,
    interventions_known: known,
    interventions_per_10: per10(interventions, known),
    misses,
  };
}

/** The reviewer types to show: the given ones plus every `reviewer...` type in the measurements. */
function reviewerTypeList(done, types) {
  const out = [...(types ?? [])];
  for (const o of done)
    for (const a of o.cost.agents) if (/^reviewer(-|$)/.test(a?.type ?? '') && !out.includes(a.type)) out.push(a.type);
  return out;
}

/**
 * The reviewer hit rate over the tasks done in [from, to) with a cost measurement (see the header).
 * @param {string[]|null} types the reviewer types (queueLogic.REVIEWER_TYPES: the fixed ones and the helpers)
 */
function reviewerStatistics(queue, { from, to, types = null }) {
  const inWindow = (t) => Number.isFinite(t) && t >= from && t < to;
  const done = (queue?.tasks ?? []).filter(
    (o) => o && o.external !== true && o.status === 'done' && inWindow(Date.parse(o.done ?? '')) && Array.isArray(o.cost?.agents),
  );
  // A red done command (from done_when) is no reviewer's: it neither counts as attributed nor gets a row.
  const from_ = (r) => (Array.isArray(r?.from) ? r.from : []).filter((x) => x !== DONE_WHEN);
  const rounds = done.flatMap(fixList);
  const attributed = rounds.filter((r) => from_(r).length).length;
  const rows = [];
  for (const type of reviewerTypeList(done, types)) {
    const row = { type, runs: 0, tasks: 0, with_findings: 0, no_line: 0, fixes: 0, dismissed: 0 };
    for (const o of done) {
      const mine = o.cost.agents.filter((a) => a?.type === type);
      if (!mine.length) continue;
      row.tasks += 1;
      row.runs += mine.length;
      const hit = mine.filter((a) => a.findings && (Number(a.findings.H) || 0) + (Number(a.findings.M) || 0) + (Number(a.findings.L) || 0) > 0).length;
      row.no_line += mine.filter((a) => !a.findings).length;
      const fixes = fixList(o).filter((r) => from_(r).includes(type)).length;
      row.with_findings += hit;
      row.fixes += fixes;
      row.dismissed += Math.max(0, hit - fixes);
    }
    if (row.runs) rows.push(row);
  }
  const hints = attributed
    ? rows.filter((r) => r.runs >= REVIEWER_HINT_RUNS && r.fixes === 0).map((r) => `${r.type}: 0 fixes in ${r.runs} runs`)
    : [];
  return { tasks: done.length, rows, fix_rounds: rounds.length, attributed, hints };
}

/** The owner action times in the queue (see the header, autonomy), as ms, sorted. */
function ownerActionTimes(queue) {
  const isOwner = (by) => OWNER_BY.has(String(by ?? '').trim());
  const out = [];
  const push = (t) => {
    const ms = Date.parse(t ?? '');
    if (Number.isFinite(ms)) out.push(ms);
  };
  for (const e of Array.isArray(queue?.changelog) ? queue.changelog : []) {
    if (isOwner(e?.by)) push(e.at);
    if (e?.undone && isOwner(e.undone.by)) push(e.undone.at);
  }
  for (const r of Object.values(queue?.resolutions ?? {})) if (isOwner(r?.by)) push(r.time);
  // The auto-accept approves through the same path; its log (auto_accepted) tells those apart (as lib/ownerWait.js).
  const auto = new Set((Array.isArray(queue?.auto_accepted) ? queue.auto_accepted : []).map((x) => `${x?.id} ${x?.at}`));
  for (const o of (queue?.tasks ?? []).filter(Boolean)) {
    if (o.approved && !auto.has(`${o.id} ${o.approved}`)) push(o.approved);
    if (o.qa_ok && o.qa_ok_by !== 'auto') push(o.qa_ok);
    if (isOwner(o.added_by)) push(o.added_at); // also the QA fix task: the time of the deviation
  }
  return out.sort((a, b) => a - b);
}

/** The longest stretch in [from, to) with work running and no owner action, in ms (see the header). */
function longestStretch(queue, { from, to }) {
  const spans = [];
  for (const o of (queue?.tasks ?? []).filter((x) => x && x.external !== true)) {
    const a = Date.parse(o.started ?? o.picked_at ?? '');
    if (!Number.isFinite(a)) continue;
    const end = Date.parse(o.done ?? o.delivered ?? '');
    const b = Number.isFinite(end) ? end : ['picked', 'running', 'review'].includes(o.status) ? to : NaN;
    const x = Math.max(a, from);
    const y = Math.min(b, to);
    if (Number.isFinite(y) && y > x) spans.push([x, y]);
  }
  spans.sort((p, q) => p[0] - q[0]);
  // The union of the work spans: the times when something ran.
  const union = [];
  for (const [a, b] of spans) {
    const last = union[union.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else union.push([a, b]);
  }
  const cuts = ownerActionTimes(queue);
  let best = 0;
  for (const [a, b] of union) {
    let s = a;
    for (const c of cuts.filter((t) => t > a && t < b)) {
      best = Math.max(best, c - s);
      s = c;
    }
    best = Math.max(best, b - s);
  }
  return best;
}

/** Did the owner act on the task while it ran (a changelog entry, a QA deviation, an answer to its fix-round cap)? */
function ownerTouched(o, queue) {
  const start = Date.parse(o.started ?? o.picked_at ?? o.added_at ?? '');
  const end = Date.parse(o.done ?? '');
  const inSpan = (t) => Number.isFinite(t) && (!Number.isFinite(start) || t >= start) && (!Number.isFinite(end) || t <= end);
  const logged = (Array.isArray(queue?.changelog) ? queue.changelog : []).some(
    (e) =>
      OWNER_BY.has(String(e?.by ?? '').trim()) &&
      inSpan(Date.parse(e.at ?? '')) &&
      (Array.isArray(e.changes) ? e.changes : []).some((c) => c?.id === o.id),
  );
  const qa = o.qa_status === 'deviation' || (typeof o.qa_note === 'string' && !!o.qa_note);
  // The fix-round cap question <id>.fixcap<N> (lib/doneCheck.js; the id may be cut to fit 40 characters).
  const isCap = (q) => {
    const m = /^(.+)\.fixcap\d+$/.exec(String(q));
    return !!m && String(o.id).startsWith(m[1]);
  };
  const cap =
    (Array.isArray(queue?.resolved) ? queue.resolved : []).some(isCap) || Object.keys(queue?.resolutions ?? {}).some(isCap);
  return logged || qa || cap;
}

/**
 * The autonomy figures (see the header).
 * @param {object[]} merged the merged tasks (as for rightFirstTime)
 * @param {object} rft the rightFirstTime result (its interventions and misses)
 */
function autonomyStatistics(queue, merged, rft, { from, to }) {
  const tasks = (queue?.tasks ?? []).filter(Boolean);
  const byId = new Map(tasks.map((o) => [o.id, o]));
  const missed = new Map(rft.misses.map((m) => [m.id, m]));
  // A defect is fixed when its fix task is done; a finding when a task made from it (plan = its id) is done.
  const fixedDefect = (d) => (byId.has(d) ? byId.get(d).status === 'done' : tasks.some((o) => o.plan === d && o.status === 'done'));
  const verified = merged.filter((o) => {
    const m = missed.get(o.id);
    return !m || (o.qa_status !== 'deviation' && !m.reopened && m.defects.every(fixedDefect));
  }).length;
  const inWindow = (t) => Number.isFinite(t) && t >= from && t < to;
  const done = tasks.filter((o) => o.external !== true && o.status === 'done' && inWindow(Date.parse(o.done ?? '')));
  const corrected = {
    fix_rounds: { total: 0, without_owner: 0 },
    done_when: { total: 0, without_owner: 0 },
    base_fix: { total: 0, without_owner: 0 },
  };
  for (const o of done) {
    const alone = !ownerTouched(o, queue);
    for (const r of fixList(o)) {
      const k = (Array.isArray(r.from) ? r.from : []).includes(DONE_WHEN) ? 'done_when' : 'fix_rounds';
      corrected[k].total += 1;
      if (alone) corrected[k].without_owner += 1;
    }
    if (o.added_by === 'base gate') {
      corrected.base_fix.total += 1;
      if (alone) corrected.base_fix.without_owner += 1;
    }
  }
  const parts = Object.values(corrected);
  return {
    verified,
    verified_per_intervention: rft.interventions > 0 ? round1(verified / rft.interventions) : null,
    longest_stretch_h: round1(longestStretch(queue, { from, to }) / 3_600_000),
    corrected: {
      ...corrected,
      total: parts.reduce((s, x) => s + x.total, 0),
      without_owner: parts.reduce((s, x) => s + x.without_owner, 0),
    },
  };
}

/** Where a task came from (see the header): fix, triage, agent, owner or other. */
function inflowSource(o, tasks) {
  if (isFixTask(o) || o.added_by === 'base gate') return 'fix';
  if (typeof o.plan === 'string' && o.plan.startsWith(FINDING_PREFIX)) return 'triage';
  if (o.approved || o.status === 'proposed' || isAgentSource(o.added_by, tasks)) return 'agent';
  if (OWNER_BY.has(String(o.added_by ?? '').trim())) return 'owner';
  return 'other';
}

/** The inflow in [from, to) by source, and added versus done for the INFLOW_WEEKS whole weeks before `to`. */
function inflowStatistics(queue, { from, to }) {
  const tasks = (queue?.tasks ?? []).filter((o) => o && o.external !== true);
  const between = (t, a, b) => Number.isFinite(t) && t >= a && t < b;
  const by = Object.fromEntries(INFLOW_SOURCES.map((k) => [k, 0]));
  let added = 0;
  for (const o of tasks) {
    if (!between(Date.parse(o.added_at ?? ''), from, to)) continue;
    added += 1;
    by[inflowSource(o, tasks)] += 1;
  }
  const weeks = [];
  for (let i = INFLOW_WEEKS; i >= 1; i--) {
    const a = to - i * 7 * DAY_MS;
    const b = a + 7 * DAY_MS;
    weeks.push({
      from: new Date(a).toISOString(),
      in: tasks.filter((o) => between(Date.parse(o.added_at ?? ''), a, b)).length,
      out: tasks.filter((o) => o.status === 'done' && between(Date.parse(o.done ?? ''), a, b)).length,
    });
  }
  const growing = weeks.every((w) => w.in > w.out);
  return {
    added,
    by,
    weeks,
    hint: growing
      ? `inflow exceeded outflow ${INFLOW_WEEKS} weeks in a row (added ${weeks.map((w) => w.in).join(', ')}; ` +
        `done ${weeks.map((w) => w.out).join(', ')})`
      : null,
  };
}

/**
 * The flow figures in [from, to).
 *   firstPass: the tasks that reached done in the window (not fix tasks of another task: `fixes` or `qa_original`),
 *     and how many of them had 0 fix rounds (queue.json `resumed`, so it also covers the time before the rows existed),
 *   fixRounds: per merged task (the same tasks), and the fixRound rows started in the window,
 *   mergeConflicts: the mergeConflict rows (not the merge guard's stops, counted apart), per week,
 *   baseGate: recorded verdicts, how many were skipped by the skip rule, red verdicts and red tips, the median run time,
 *   pushes: the push rows (deduplicated on tip + time), the merged tasks and commits per push,
 *   triage: the verdicts by word,
 *   rightFirstTime, autonomy, reviewers, inflow: the quality figures (see the header).
 * @param {{ from: number, to: number, plans?: object|null, reviewerTypes?: string[]|null }} window  plans = the plan
 *   register (for the findings' causes), reviewerTypes = queueLogic.REVIEWER_TYPES
 */
function flowStatistics(queue, rows, { from, to, plans = null, reviewerTypes = null, revertedCommits = new Set() }) {
  const weeks = Math.max(1 / 7, (to - from) / (7 * DAY_MS));
  const inWindow = (t) => Number.isFinite(t) && t >= from && t < to;
  const tasks = (queue?.tasks ?? []).filter((o) => o && o.external !== true);
  const merged = tasks.filter((o) => o.status === 'done' && inWindow(Date.parse(o.done ?? '')) && !isFixTask(o));
  const rounds = merged.map(fixRounds);
  const first = rounds.filter((n) => n === 0).length;

  // A merge that was undone: the commit was reverted on the base, or the task was cancelled after it merged. A cancelled
  // one is no longer "done", but it did merge, so right first time must still see it.
  const cancelledMerges = tasks.filter(
    (o) => o.status === 'cancelled' && o.merge_commit && inWindow(Date.parse(o.t_merge ?? o.done ?? '')) && !isFixTask(o),
  );
  const wasReverted = (o) => !!o.merge_commit && (o.status === 'cancelled' || revertedCommits.has(o.merge_commit));
  const rft = rightFirstTime([...merged, ...cancelledMerges], queue, plans, wasReverted);
  const fixRows = rowsOf(rows, 'fixRound', from, to);
  const byId = new Map(tasks.map((o) => [o.id, o]));
  // The row is written when the round is prepared; a round that never ran is not one (a row without its task counts).
  const ranRow = (r) => !byId.has(r.task) || roundRan(byId.get(r.task), r);
  const conflicts = rowsOf(rows, 'mergeConflict', from, to);
  const real = conflicts.filter((r) => !r.guard);
  const gates = rowsOf(rows, 'baseGate', from, to);
  const red = gates.filter((r) => r.ok === false);
  const flakyCommands = {};
  for (const r of rowsOf(rows, 'flakyGate', from, to))
    for (const c of r.commands ?? []) flakyCommands[c] = (flakyCommands[c] ?? 0) + 1;
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
      started: fixRows.filter((r) => r.reason === 'fix' && ranRow(r)).length,
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
    // The flaky check (cli/baseHealth.mjs): base gate commands that were red, then green on a rerun on the same sha.
    flakyGates: { count: Object.values(flakyCommands).reduce((x, y) => x + y, 0), commands: flakyCommands },
    triage,
    // The quality figures (see the header).
    rightFirstTime: rft,
    autonomy: autonomyStatistics(queue, merged, rft, { from, to }),
    reviewers: reviewerStatistics(queue, { from, to, types: reviewerTypes }),
    inflow: inflowStatistics(queue, { from, to }),
  };
}

/** The flow figures as text lines for `ravenseat cost`. */
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
    ...(f.flakyGates?.count
      ? [
          `  flaky gate command(s): ${f.flakyGates.count} green on a rerun (` +
            `${Object.entries(f.flakyGates.commands).map(([c, n]) => `${c} x${n}`).join(', ')})`,
        ]
      : []),
    `  triage verdicts: ${triage || 'none'}`,
    ...qualityLines(f),
  ];
}

/** The quality figures as text lines (part of flowLines). Older results without them give no lines. */
function qualityLines(f) {
  const out = [];
  const v = (x) => (x == null ? '-' : String(x));
  const r = f.rightFirstTime;
  if (r)
    out.push(
      `  right first time: ${r.right} of ${r.merged} merged (${r.rate_pct == null ? '-' : `${r.rate_pct} %`}); ` +
        `post-merge defects ${r.defects} (${v(r.defects_per_10)} per 10 merged)` +
        `; owner interventions ${r.interventions} (${v(r.interventions_per_10)} per 10 merged` +
        (r.interventions_known < r.merged ? `, ${r.merged - r.interventions_known} task(s) unknown` : '') +
        ')',
    );
  const au = f.autonomy;
  if (au) {
    const c = au.corrected;
    const per =
      au.verified_per_intervention == null
        ? `no interventions (${au.verified} verified)`
        : `${au.verified_per_intervention} (${au.verified} verified)`;
    out.push(
      `  autonomy: verified tasks per owner intervention ${per}; longest stretch without the owner ` +
        `${au.longest_stretch_h} h; corrected without the owner ${c.without_owner} of ${c.total} failure(s) ` +
        `(fix rounds ${c.fix_rounds.without_owner}/${c.fix_rounds.total}, red done commands ` +
        `${c.done_when.without_owner}/${c.done_when.total}, base red fix tasks ${c.base_fix.without_owner}/${c.base_fix.total})`,
    );
  }
  const rv = f.reviewers;
  if (rv) {
    if (!rv.rows.length) out.push('  reviewers: no measured reviewer runs in the window');
    else {
      out.push(
        `  reviewers (${rv.tasks} measured task(s); fix rounds attributed ${rv.attributed} of ${rv.fix_rounds}` +
          (rv.fix_rounds && !rv.attributed ? ', ravenseat resume --from records it' : '') +
          '):',
      );
      for (const x of rv.rows)
        out.push(
          `    ${x.type.padEnd(20)} ${x.runs} run(s), ${x.with_findings} with findings, ${x.fixes} led to a fix round, ` +
            `${x.dismissed} dismissed` +
            (x.no_line ? `, ${x.no_line} without a FINDINGS line` : ''),
        );
      for (const h of rv.hints) out.push(`  HINT ${h}`);
    }
  }
  const i = f.inflow;
  if (i) {
    const by = Object.entries(i.by)
      .filter(([, n]) => n)
      .map(([k, n]) => `${k} ${n}`)
      .join(', ');
    out.push(
      `  inflow: ${i.added} added${by ? ` (${by})` : ''}; last ${i.weeks.length} weeks added/done ` +
        i.weeks.map((w) => `${w.in}/${w.out}`).join(', '),
    );
    if (i.hint) out.push(`  HINT ${i.hint}`);
  }
  return out;
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

/** The load history as text lines for `ravenseat limit`. */
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
  revertedCommitsIn,
  REVIEWER_HINT_RUNS,
  INFLOW_WEEKS,
  INFLOW_SOURCES,
  rightFirstTime,
  ownerActionTimes,
  longestStretch,
  ownerTouched,
  autonomyStatistics,
  reviewerStatistics,
  inflowSource,
  inflowStatistics,
  flowStatistics,
  flowLines,
  qualityLines,
  loadStatistics,
  loadLines,
};
