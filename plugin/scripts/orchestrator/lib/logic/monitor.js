// =============================================================
// logic/monitor.js: the views over running work: info, active tracks, tracks without an agent, silent tracks and blocker reasons.
//
// infoField, infoValueText and infoView (`info`), activeLines, startedWithoutAgent and withoutAgentLines, silentTracks
// and silentLines, the blocker reasons (openBlock, closeBlock, blockerSummary, blockerLines), and nextMigrGuard.
//
// Part of the queueLogic.js split: lib/queueLogic.js re-exports every name, so callers keep requiring queueLogic.js.
// Used by queueLogic.js (the facade) only.
// Tested in lib/__tests__/queueSilent.test.ts, queueBlockers.test.ts, queueOrchestrator.test.ts and
// queueNoAgent.test.ts (through queueLogic.js).
// =============================================================

const { estimate, ageText, cutText } = require('./base.js');
const { blockInterval } = require('./select.js');

/** The fields `info` shows by default (summary), in this order. */
const INFO_FIELD = [
  'id',
  'title',
  'status',
  'class',
  'domain',
  'project',
  'feature',
  'branch',
  'migr_block',
  'head_start',
  'started',
  'delivered',
  'done',
  'depends_on',
  'waiting_on',
  'fixes',
  'owned_files',
  'owner_db',
  'scratchpad',
  'review_package',
];

/** The value of a field, also with a dot (`cost.usd`, `result.line`). undefined when it does not exist. */
function infoField(o, field) {
  let v = o;
  for (const chunk of String(field).split('.')) {
    if (v == null || typeof v !== 'object' || !(chunk in v)) return undefined;
    v = v[chunk];
  }
  return v;
}

/** One field as text: strings raw (so they can be used in a shell), everything else as compact JSON. */
function infoValueText(v) {
  if (v === undefined) return '';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/**
 * Summary default view of one task (`queue.mjs info <id>`): one field per line, the mission and remarks shortened.
 * `fixedBy` (lib/fixLinks.fixedBy) lists the fix tasks that name this one in `fixes`. `costEstimate` (lib/costEstimate.js
 * calibratedCost) adds the line "estimate: 39 min · ~$2.4 (measured, class+size, n=7)".
 */
function infoView(o, { fixedBy = [], costEstimate = null } = {}) {
  const out = [];
  for (const f of INFO_FIELD) {
    const v = o[f];
    if (v == null || (Array.isArray(v) && !v.length)) continue;
    out.push(
      `${f}: ${Array.isArray(v) ? v.join(', ') : f === 'head_start' ? String(v).slice(0, 12) : v}`,
    );
  }
  if (costEstimate && Number.isFinite(costEstimate.usd))
    out.push(
      `estimate: ${estimate(o)} min · ~$${costEstimate.usd} (` +
        (costEstimate.source === 'measured'
          ? `measured, ${costEstimate.basis}, n=${costEstimate.n})`
          : 'model, too little measured data)'),
    );
  if (fixedBy.length) out.push(`fixed by: ${fixedBy.join(', ')}`);
  // The finish line (lib/doneCheck.js), locked once the task has started.
  if (typeof o.done_when === 'string' && o.done_when.trim()) out.push(`done_when: ${o.done_when.trim()}`);
  const accept = require('../doneCheck.js').acceptanceList(o);
  if (accept.length) out.push(`acceptance: ${accept.map((c, i) => `${i + 1}) ${c}`).join(' ')}`);
  if (o.result?.line) out.push(`result: ${o.result.line}`);
  if (o.cost)
    out.push(
      `cost: $${o.cost.usd} (${o.cost.agents?.length ?? 0} agent(s), ${o.cost.turns ?? '?'} turns)`,
    );
  if (o.findings) out.push(`findings: H=${o.findings.H} M=${o.findings.M} L=${o.findings.L}`);
  const bonus = Array.isArray(o.bonus) ? o.bonus : [];
  if (bonus.length)
    out.push(`bonus: ${bonus.length} (last ${bonus[bonus.length - 1].time})`);
  const mark = Array.isArray(o.remarks) ? o.remarks : [];
  if (mark.length)
    out.push(`remarks: ${mark.length}; last: ${cutText(mark[mark.length - 1], 160)}`);
  if (o.mission) out.push(`mission: ${cutText(String(o.mission).replace(/\s+/g, ' '), 200)}`);
  out.push('One field: cq info <id> --field <name> (also cost.usd, result.line).');
  return out;
}

// The age is written with ageText (above), same format as in show.
const ACTIVE_STATUSES = ['running', 'picked', 'review'];

/**
 * The active tasks (running, picked, review) as short lines: id, status, class, branch, migration block,
 * head_start and age (from start/pick; for review also the time since delivery).
 */
function activeLines(queue, now = Date.now()) {
  const rows = (queue?.tasks ?? []).filter((o) => ACTIVE_STATUSES.includes(o.status));
  if (!rows.length) return ['No active tasks (running, picked, review).'];
  return rows.map((o) => {
    const from = Date.parse(o.started ?? o.picked_at ?? '');
    const vendorList =
      o.status === 'review' && o.delivered
        ? `, delivered ${ageText(now - Date.parse(o.delivered))} ago`
        : '';
    return (
      `${o.id}  ${o.status}  ${o.class}  ${o.branch ?? '-'}  migr ${o.migr_block ?? '-'}  ` +
      `head ${o.head_start ? String(o.head_start).slice(0, 8) : '-'}  age ${Number.isNaN(from) ? '?' : ageText(now - from)}${vendorList}` +
      `${o.picked_by ? `  picked by ${o.picked_by}` : ''}`
    );
  });
}

/**
 * Tracks marked running that no agent is working on. `fill` and `start` only MARK a track as running; the orchestrator
 * must start the agent from the "Start these in the SAME turn" lines. When fill runs where nobody reads its output (a
 * `merge` in the background, a script that chains several merges), the track stays "running" with no agent, and the
 * queue stalls without any error. A real agent runs `prepare-track` within minutes, and that checks the branch out in
 * its worktree. So: running, older than `graceMin`, no worktree has the branch, and no track-result.md = no agent.
 * Picked tasks and cloud sessions are left out (they have no local worktree). `worktreeBranches` is a Set of branch
 * names, `hasReport(o)` says whether the track has delivered.
 */
const NO_AGENT_GRACE_MIN = 15;
function startedWithoutAgent(
  queue,
  { worktreeBranches, hasReport = () => false, now = Date.now(), graceMin = NO_AGENT_GRACE_MIN } = {},
) {
  const branches = worktreeBranches ?? new Set();
  return (queue?.tasks ?? [])
    .filter((o) => o.status === 'running' && !o.picked_by && !o.cloud && o.branch)
    .map((o) => ({ o, from: Date.parse(o.started ?? '') }))
    .filter(({ from }) => !Number.isNaN(from) && now - from >= graceMin * 60_000)
    .filter(({ o }) => !branches.has(o.branch) && !hasReport(o))
    .map(({ o, from }) => ({ id: o.id, branch: o.branch, migr_block: o.migr_block ?? null, age_ms: now - from }));
}

/** The warning lines for `startedWithoutAgent` (show, orchestrator pulse). Empty list when all is well. */
function withoutAgentLines(list) {
  if (!list?.length) return [];
  return [
    `STARTED WITHOUT AGENT (${list.length}): marked running, but no worktree has the branch and there is no report. ` +
      'fill or start marked them and the agents were never started (was fill run where nobody read the output?). ' +
      'For each: cq set <id> waiting, then cq fill --ids <id> and start what it lists in the SAME turn ' +
      '(fill checks the migration block again).',
    ...list.map(
      (x) =>
        `  ${x.id}  ${x.branch}  running for ${ageText(x.age_ms)}${x.migr_block ? `  migr ${x.migr_block}` : ''}`,
    ),
  ];
}

// ---- Silent tracks and blocker reasons ----------------------------------------------------------------------

/**
 * Silent tracks ("SILENT"): running, an agent has the branch checked out in a worktree (so not STARTED WITHOUT
 * AGENT), but no sign of life for `limitMin` minutes. The sign of life is measured by the caller (queue.mjs and the
 * board server, with lib/trackActivity.js) as the newest of: the last commit on the branch, the newest mtime in the
 * worktree, the track folder in the scratchpad and the agent transcript. `lastActivity` maps id -> that time in ms
 * (missing = nothing found). The start time counts as activity too, so a new track always gets the whole limit.
 * Picked tasks, cloud sessions and delivered tracks (track-result.md) are left out. limits.silentMin sets the limit
 * (`cq limit silentMin <n>`, 0 = off).
 */
const SILENT_DEFAULT_MIN = 20;

/** The silence limit in minutes: limits.silentMin, otherwise the default. 0 turns the check off. */
function silentMinFor(queue) {
  const raw = queue?.limits?.silentMin;
  const v = Number(raw);
  return raw != null && Number.isFinite(v) && v >= 0 ? v : SILENT_DEFAULT_MIN;
}

/** The tracks the silence check measures: running, not picked or cloud, with a branch some worktree has checked out. */
function silentCandidates(queue, worktreeBranches) {
  const branches = worktreeBranches ?? new Set();
  return (queue?.tasks ?? []).filter(
    (o) => o.status === 'running' && !o.picked_by && !o.cloud && o.branch && branches.has(o.branch),
  );
}

function silentTracks(
  queue,
  { worktreeBranches, lastActivity = {}, hasReport = () => false, now = Date.now(), limitMin } = {},
) {
  const limit = limitMin ?? silentMinFor(queue);
  if (!(limit > 0)) return [];
  const activity = lastActivity instanceof Map ? Object.fromEntries(lastActivity) : (lastActivity ?? {});
  return silentCandidates(queue, worktreeBranches)
    .map((o) => {
      const started = Date.parse(o.started ?? '');
      const seen = Number(activity[o.id]);
      const last = Math.max(
        Number.isFinite(started) ? started : -Infinity,
        Number.isFinite(seen) ? seen : -Infinity,
      );
      return { o, last };
    })
    .filter(({ last }) => Number.isFinite(last) && now - last >= limit * 60_000)
    .filter(({ o }) => !hasReport(o))
    .map(({ o, last }) => ({
      id: o.id,
      branch: o.branch,
      last_activity: new Date(last).toISOString(),
      silent_ms: now - last,
    }));
}

/** The warning lines for `silentTracks` (show, orchestrator pulse). Empty list when all is well. */
function silentLines(list) {
  if (!list?.length) return [];
  return [
    `SILENT (${list.length}): running with an agent worktree, but no commit, file change or transcript write for a ` +
      'while (the agent may have hung or run out of context). For each: check the track (its worktree and ' +
      'transcript), then cq resume <id> --reason context and start the new agent, or stop it (cq set <id> waiting; ' +
      'cq block <id> silent records why).',
    ...list.map((x) => `  ${x.id}  ${x.branch}  silent for ${ageText(x.silent_ms)}`),
  ];
}

/**
 * The blocker reasons: one fixed table, so `cq blockers` and the board's statistics can cluster on them. A task has
 * `blocks: [{ code, from, to?, note? }]`, with at most one open (no `to`). `cq block` / `cq unblock` set them by hand;
 * `cq merge` opens merge-conflict, merge-guard, merge-stopped or gate-red when it stops, and closes the open one after a merge.
 */
const BLOCK_CODES = [
  { code: 'merge-conflict', text: 'the merge hit a real conflict' },
  { code: 'merge-guard', text: 'the merge guard stopped it (protected paths)' },
  { code: 'merge-stopped', text: 'the merge step stopped without a conflict (identity guard, validation)' },
  { code: 'gate-red', text: 'the gates or the done command failed' },
  { code: 'context', text: 'the agent ran out of context' },
  { code: 'quota', text: 'the usage quota or budget stopped it' },
  { code: 'owner-question', text: 'waiting on an owner answer' },
  { code: 'track-question', text: 'the track delivered and asks the owner something' },
  { code: 'dependency', text: 'waiting on another task' },
  { code: 'no-agent', text: 'marked running without an agent' },
  { code: 'silent', text: 'the agent went silent' },
  { code: 'other', text: 'something else (say what in the note)' },
];
const BLOCK_NOTE_MAX = 200;

/** The open block on a task (no `to`), or null. */
function openBlockOf(o) {
  return (Array.isArray(o?.blocks) ? o.blocks : []).find((b) => b && !b.to) ?? null;
}

/**
 * Opens a block on the task (mutates `o`). An open block with another code is closed at the same moment, so a task has
 * at most one open block; the same code again keeps the open one and its start (a new note replaces the old).
 * @returns {{ block: object, closed: object|null, kept: boolean } | { error: string }}
 */
function openBlock(o, code, { now = Date.now(), note = null } = {}) {
  if (!BLOCK_CODES.some((b) => b.code === code))
    return { error: `unknown blocker code ${code} (${BLOCK_CODES.map((b) => b.code).join(', ')})` };
  const text = note == null ? '' : String(note).replace(/\s+/g, ' ').trim().slice(0, BLOCK_NOTE_MAX);
  const open = openBlockOf(o);
  if (open && open.code === code) {
    if (text) open.note = text;
    return { block: open, closed: null, kept: true };
  }
  const at = new Date(now).toISOString();
  if (open) open.to = at;
  const block = { code, from: at, ...(text ? { note: text } : {}) };
  o.blocks = [...(Array.isArray(o.blocks) ? o.blocks : []), block];
  return { block, closed: open, kept: false };
}

/** Closes the open block on the task (mutates `o`). @returns the closed block, or null when none was open. */
function closeBlock(o, { now = Date.now() } = {}) {
  const open = openBlockOf(o);
  if (!open) return null;
  open.to = new Date(now).toISOString();
  return open;
}

/**
 * Per code: how many blocks overlap the last `days` days and the blocked time inside that window (an open block counts
 * up to now). Sorted by time, then count; codes without blocks are left out.
 * @returns {{ code: string, count: number, ms: number, open: number }[]}
 */
function blockerSummary(queue, { now = Date.now(), days = 7 } = {}) {
  const windowFrom = now - days * 86_400_000;
  const per = new Map();
  for (const o of queue?.tasks ?? []) {
    // A block left open on a finished task stops counting when the task was done (it no longer blocks anything).
    const finished = o?.status === 'done' && o.done ? Date.parse(o.done) : NaN;
    for (const b of Array.isArray(o?.blocks) ? o.blocks : []) {
      const from = Date.parse(b?.from ?? '');
      const open = !b?.to && !Number.isFinite(finished);
      const to = b?.to ? Date.parse(b.to) : Number.isFinite(finished) ? finished : now;
      if (!Number.isFinite(from) || !Number.isFinite(to) || to < windowFrom || from > now) continue;
      const r = per.get(b.code) ?? { code: b.code, count: 0, ms: 0, open: 0 };
      r.count += 1;
      r.ms += Math.max(0, Math.min(to, now) - Math.max(from, windowFrom));
      if (open) r.open += 1;
      per.set(b.code, r);
    }
  }
  return [...per.values()].sort((x, y) => y.ms - x.ms || y.count - x.count || x.code.localeCompare(y.code));
}

/** `cq blockers` as text lines. */
function blockerLines(summary, { days = 7 } = {}) {
  if (!summary?.length) return [`No blockers recorded in the last ${days} days.`];
  return [
    `Blockers in the last ${days} days (count, blocked time; top first):`,
    ...summary.map(
      (r) =>
        `  ${r.code.padEnd(15)} ${String(r.count).padStart(3)}  ${ageText(r.ms)}${r.open ? `  (${r.open} open)` : ''}`,
    ),
  ];
}

/** Highest used number in the queue's migration blocks ("3600–3609" → 3609). */
function highestBlockNr(queue) {
  let max = 0;
  for (const o of queue?.tasks ?? []) {
    // Via blockInterval, so a hyphen or a short end number ("3450–59") is read the same way as in takenBlocks.
    const b = blockInterval(o.migr_block);
    if (b) max = Math.max(max, b.to);
  }
  return max;
}

/**
 * Guard for `next-migr <n>`: refuses to go backward (below the current next_migr) and down into a used number (highest
 * migration file in the series or highest assigned block). `taken` (takenBlocks) also refuses a number inside a taken
 * block, e.g. a block moved by hand that only stands in the prompt file. Returns { ok, error } (error = null when ok).
 */
function nextMigrGuard({ now, new: fresh, highestFile = 0, highestBlock = 0, taken = [] }) {
  if (!Number.isInteger(fresh) || fresh <= 0)
    return { ok: false, error: `invalid number "${fresh}" (integer above 0)` };
  if (Number.isInteger(now) && fresh < now)
    return { ok: false, error: `${fresh} is backward (next_migr is ${now}); the queue never goes backward` };
  const used = Math.max(highestFile || 0, highestBlock || 0);
  if (fresh <= used)
    return {
      ok: false,
      error: `${fresh} is not above the highest used number ${used} (migration file ${highestFile || 0}, block ${highestBlock || 0})`,
    };
  const inside = taken.find((t) => t.from <= fresh && t.to >= fresh);
  if (inside)
    return {
      ok: false,
      error: `${fresh} lies in a taken block ${inside.from}–${inside.to} (${inside.source})`,
    };
  return { ok: true, error: null };
}

module.exports = {
  infoField,
  infoValueText,
  infoView,
  activeLines,
  NO_AGENT_GRACE_MIN,
  startedWithoutAgent,
  withoutAgentLines,
  SILENT_DEFAULT_MIN,
  silentMinFor,
  silentCandidates,
  silentTracks,
  silentLines,
  BLOCK_CODES,
  openBlockOf,
  openBlock,
  closeBlock,
  blockerSummary,
  blockerLines,
  highestBlockNr,
  nextMigrGuard,
};
