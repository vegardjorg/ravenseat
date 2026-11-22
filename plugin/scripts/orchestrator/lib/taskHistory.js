// =============================================================
// taskHistory.js: the history of one task, one pure join of data that already exists (roadmap 0ø J5;
// plans/jira-vurdering-2026-11-18.md proposal 5, owner answer 3: no new log file).
//
// Why: the question after a night is "what happened with this one?". The answer sat in the task's own fields (added,
// approved, picked, started, delivered, received, done, QA), its blocks and fix rounds, the queue's questions, answers
// and changelog, the time log (gate runs, fix rounds, merge conflicts, CI, triage) and the finding log (review rounds).
// This joins them into one ordered list for the board's detail panel ("History") and `ravenseat info <id> --history`,
// so the two never disagree.
//
// THE STEPS (oldest first): { time, kind, text, fail, gap_ms }. gap_ms is the time since the step before (null for the
// first). Kinds, in the order used when two steps share a time:
//   added, approved, edited, status, undone (the changelog), picked, started, gate-red, gate-green, delivered, received,
//   review (H/M/L per review round from the finding log), fix-round, question, answered, conflict, blocked, unblocked,
//   triage, merged, qa-ok, ci-red, archived.
// A fix round is counted once: the task's `resumed` list wins, a time log row only fills a round it lacks.
//
// WHAT IS SHOWN (the time log's rule, lib/guardLog.js): ids, kinds, codes, counts, field names and times only. Never a
// question's text, an answer, a note, a remark, a finding's excerpt or a changed value; the one exception is a status
// change, whose before and after are fixed words (only known statuses are printed).
//
// Never throws on odd input: a part that cannot be read is left out, so the list is shorter, never wrong.
// Tested in lib/__tests__/taskHistory.test.ts.
// =============================================================
'use strict';

const AWAY = require('./awaySummary.js');

/** The order of kinds that share a time (a lifecycle order). */
const KIND_ORDER = Object.freeze([
  'added',
  'approved',
  'edited',
  'status',
  'undone',
  'picked',
  'started',
  'gate-red',
  'gate-green',
  'delivered',
  'received',
  'review',
  'fix-round',
  'question',
  'answered',
  'conflict',
  'blocked',
  'unblocked',
  'triage',
  'merged',
  'qa-ok',
  'ci-red',
  'archived',
]);
const RANK = new Map(KIND_ORDER.map((k, i) => [k, i]));
/** The `by` values that mean the owner (as lib/eventStatistics.js). */
const OWNER_BY = new Set(['owner', 'theBoard']);
/** Status words that may be printed in a status change. */
const STATUSES = new Set(['proposed', 'waiting', 'picked', 'running', 'review', 'done', 'cancelled', 'parked']);
/** Fixed `added_by` labels that are not free text. */
const ADDED_BY_LABELS = new Set(['base gate', 'ci watch', 'orchestrator', 'qa']);

const arr = (x) => (Array.isArray(x) ? x : []);
const isObj = (x) => x != null && typeof x === 'object' && !Array.isArray(x);
const ms = (iso) => {
  if (typeof iso !== 'string' && typeof iso !== 'number') return null;
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  return Number.isFinite(t) ? t : null;
};
const byYou = (by) => (OWNER_BY.has(String(by ?? '').trim()) ? ' by you' : '');
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const word = (x) => (typeof x === 'string' && /^[a-z][a-z0-9-]{0,40}$/.test(x) ? x : null);
const shortSha = (x) => (typeof x === 'string' && /^[0-9a-f]{7,40}$/i.test(x) ? x.slice(0, 7) : null);

/**
 * The history of one task (see the header).
 * @param {{ task: object, queue?: object, rows?: object[], findings?: object[], now?: number }} o
 *   queue = the queue (for questions, answers, the changelog and the auto-accept log), rows = time log rows (any tasks;
 *   filtered here), findings = finding log rows (any tasks; filtered here)
 * @returns {{ id: string|null, steps: object[], span_ms: number|null, open: boolean }}
 */
function taskHistory({ task, queue = null, rows = [], findings = [], now = Date.now() } = {}) {
  if (!isObj(task) || !task.id) return { id: null, steps: [], span_ms: null, open: false };
  const id = String(task.id);
  const q = isObj(queue) ? queue : {};
  const steps = [];
  const add = (time, kind, text, fail = false) => {
    const t = ms(time);
    if (t == null) return;
    steps.push({ t, kind, text, fail: fail === true });
  };

  // ---- The task's own fields ----
  const tasks = arr(q.tasks).filter(isObj);
  const taskIds = new Set(tasks.map((x) => String(x.id)));
  const addedBy = String(task.added_by ?? '').trim();
  const who = OWNER_BY.has(addedBy)
    ? ' by you'
    : ADDED_BY_LABELS.has(addedBy)
      ? ` by the ${addedBy}`
      : addedBy && taskIds.has(addedBy) && addedBy !== id
        ? `, proposed by ${addedBy}`
        : '';
  add(task.added_at, 'added', `Added${who}`);
  const auto = new Set(arr(q.auto_accepted).filter(isObj).map((x) => `${x.id} ${x.at}`));
  if (typeof task.approved === 'string')
    add(task.approved, 'approved', auto.has(`${id} ${task.approved}`) ? 'Approved automatically' : `Approved${byYou(task.approved_by ?? 'owner')}`);
  add(task.picked_at, 'picked', 'Picked for a track');
  add(task.started, 'started', 'Track started');
  add(task.delivered, 'delivered', 'Track reported done');
  add(task.t_receive, 'received', 'Received for review');
  if (task.status === 'done') {
    const sha = shortSha(task.merge_commit);
    add(task.done ?? task.t_merge, 'merged', `Merged${sha ? ` (${sha})` : ''}`);
  }
  if (typeof task.qa_ok === 'string') add(task.qa_ok, 'qa-ok', task.qa_ok_by === 'auto' ? 'QA approved automatically' : `QA approved${byYou(task.qa_ok_by)}`);
  add(task.archived_at, 'archived', 'Moved to the archive');

  // ---- Blocks: opened and closed, with how long ----
  for (const b of arr(task.blocks).filter(isObj)) {
    const code = word(b.code) ?? 'other';
    const from = ms(b.from);
    const to = ms(b.to);
    if (from == null) continue;
    const long = AWAY.durationText((to ?? now) - from);
    add(b.from, 'blocked', to == null ? `Blocked: ${code} (still open, ${long})` : `Blocked: ${code} (${long})`, true);
    if (to != null) add(b.to, 'unblocked', `Unblocked: ${code}`);
  }

  // ---- Fix rounds: resumed first, the time log fills a round it lacks ----
  const rounds = new Set();
  const roundText = (reason, round) => `${reason === 'context' ? 'Fresh context' : 'Fix'} round${Number.isInteger(round) ? ` ${round}` : ''}`;
  for (const r of arr(task.resumed).filter(isObj)) {
    if (ms(r.time) == null) continue;
    if (Number.isInteger(r.round)) rounds.add(r.round);
    const from = arr(r.from).map(word).filter(Boolean);
    add(r.time, 'fix-round', `${roundText(r.reason, r.round)}${from.length ? ` (from ${from.join(', ')})` : ''}`);
  }

  // ---- The time log rows for this task ----
  for (const r of arr(rows).filter(isObj)) {
    switch (r.event) {
      case 'gate': {
        if (String(r.track ?? '') !== id) break;
        const kind = word(r.kind);
        const label = kind ? `${kind[0].toUpperCase()}${kind.slice(1)} gate` : 'Gate';
        if (r.ok === false) {
          const failed = arr(r.failed).map(String).filter(Boolean);
          const what = failed.length ? `: ${failed[0].slice(0, 80)}${failed.length > 1 ? ` +${failed.length - 1}` : ''}` : '';
          add(r.time, 'gate-red', `${label} red${what}`, true);
        } else if (r.ok === true) add(r.time, 'gate-green', `${label} green`);
        break;
      }
      case 'fixRound':
        if (String(r.task ?? '') !== id || (Number.isInteger(r.round) && rounds.has(r.round))) break;
        if (Number.isInteger(r.round)) rounds.add(r.round);
        add(r.time, 'fix-round', roundText(r.reason, r.round));
        break;
      case 'mergeConflict':
        if (String(r.task ?? '') !== id) break;
        add(r.time, 'conflict', r.guard ? 'Stopped by the merge guard' : `Merge conflict${Number.isInteger(r.files) ? ` in ${plural(r.files, 'file')}` : ''}`, true);
        break;
      case 'ciWatch': {
        if (String(r.task ?? '') !== id || !r.verdict || r.verdict === 'green') break;
        const sha = shortSha(r.sha);
        add(r.time, 'ci-red', `CI ${r.verdict === 'infra' ? 'infrastructure trouble' : 'red'}${sha ? ` on ${sha}` : ''}`, true);
        break;
      }
      case 'triage': {
        if (String(r.task ?? '') !== id) break;
        const v = word(r.verdict);
        add(r.time, 'triage', `Triage${v ? `: ${v}` : ''}${byYou(r.by)}`);
        break;
      }
      default:
        break;
    }
  }

  // ---- Review rounds: H/M/L counts per round from the finding log ----
  const perRound = new Map();
  for (const f of arr(findings).filter(isObj)) {
    if (String(f.task ?? '') !== id || !String(f.caught_by ?? '').startsWith('review:') || ms(f.time) == null) continue;
    const key = Number.isInteger(f.round) ? f.round : 0;
    const g = perRound.get(key) ?? { t: ms(f.time), H: 0, M: 0, L: 0 };
    g.t = Math.min(g.t, ms(f.time));
    if (['H', 'M', 'L'].includes(f.severity)) g[f.severity] += 1;
    perRound.set(key, g);
  }
  for (const [round, g] of perRound)
    add(g.t, 'review', `Review${round ? ` round ${round}` : ''}: H ${g.H}, M ${g.M}, L ${g.L}`, g.H > 0);

  // ---- Questions and answers, by id only ----
  const waits = new Set(arr(task.waiting_on).map(String));
  const mine = (qid) => waits.has(qid) || qid.startsWith(`${id}.`);
  for (const [qid, x] of Object.entries(isObj(q.question) ? q.question : {}))
    if (mine(qid) && isObj(x)) add(x.added_at, 'question', `Question ${qid}`);
  for (const [qid, r] of Object.entries(isObj(q.resolutions) ? q.resolutions : {}))
    if (mine(qid) && isObj(r)) add(r.time, 'answered', `${qid} answered${byYou(r.by)}`);

  // ---- The changelog: field names, status words ----
  for (const e of arr(q.changelog).filter(isObj)) {
    const changes = arr(e.changes).filter((c) => isObj(c) && String(c.id ?? '') === id);
    if (!changes.length) continue;
    const by = byYou(e.by);
    const status = changes.find((c) => c.field === 'status');
    if (status) {
      const sv = (v) => (STATUSES.has(v) ? v : null);
      const b = sv(status.before);
      const a = sv(status.after);
      add(e.at, 'status', b && a ? `Status ${b} -> ${a}${by}` : `Status changed${by}`);
    }
    const fields = [...new Set(changes.filter((c) => c.field !== 'status').map((c) => word(c.field) ?? 'a field'))];
    if (fields.length) add(e.at, 'edited', `Edited: ${fields.join(', ')}${by}`);
    if (isObj(e.undone)) add(e.undone.at, 'undone', `Change ${Number.isInteger(e.nr) ? `#${e.nr} ` : ''}undone${byYou(e.undone.by)}`);
  }

  steps.sort((a, b) => a.t - b.t || (RANK.get(a.kind) ?? 99) - (RANK.get(b.kind) ?? 99));
  const out = steps.map((s, i) => ({
    time: new Date(s.t).toISOString(),
    kind: s.kind,
    text: s.text,
    fail: s.fail,
    gap_ms: i === 0 ? null : s.t - steps[i - 1].t,
  }));
  return {
    id,
    steps: out,
    span_ms: steps.length > 1 ? steps[steps.length - 1].t - steps[0].t : null,
    open: !['done', 'cancelled'].includes(task.status),
  };
}

/** The terminal lines for `ravenseat info <id> --history`: a header, then one line per step (x = a failure). */
function historyLines(h, { now = Date.now() } = {}) {
  if (!h?.steps?.length) return [`History of ${h?.id ?? 'the task'}: nothing recorded yet.`];
  const span = h.span_ms ? ` over ${AWAY.durationText(h.span_ms)}` : '';
  const lines = [`History of ${h.id}: ${plural(h.steps.length, 'step')}${span}${h.open ? ', still open' : ''}`];
  for (const s of h.steps) {
    const gap = s.gap_ms ? ` (+${AWAY.durationText(s.gap_ms)})` : '';
    lines.push(`  ${AWAY.whenText(Date.parse(s.time), now).padEnd(16)} ${s.fail ? 'x' : '-'} ${s.text}${gap}`);
  }
  return lines;
}

module.exports = { KIND_ORDER, taskHistory, historyLines };
