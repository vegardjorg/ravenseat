// =============================================================
// awaySummary.js: "Since you left", one pure join of the queue and the time log into a few numbers and a short ordered
// event list for a window (roadmap 3e, AW-1; plans/borte-flate-vurdering-2026-11-21.md).
//
// Why: the pieces of "what happened while I was away" sat in queue.json (merges, fix rounds, blockers, questions,
// answers), the time log (gate runs, base verdicts, pushes, CI, session cost, queue start and idle) and their archives,
// and nothing joined them. The board's Decisions band, `ravenseat since` and Claude's answer to "what happened while I
// was away?" all call this one function, so the three never disagree (the J8 rule: one text, one set of numbers).
//
// THE WINDOW (resolveWindow): since last seen (the default), the last 24 hours or the last 7 days. Last seen is the
// server-side mark in <dataFolder>/seen.json (lib/seenMark.js). A missing mark, one in the future or one older than 7
// days falls back to 24 hours, and the answer says so in `note`. `from` (ms) is an explicit start the board passes to
// keep the window it opened with for the whole visit (the mark moves while the owner reads); it counts only inside 7 days.
//
// THE NUMBERS (on the same rules as lib/eventStatistics.js, so the Statistics tab never disagrees):
//   merged     tasks done in the window (not external ones)
//   recovered  autonomy.corrected.without_owner: fix rounds, red done commands and base fix tasks on tasks done in the
//              window that ended green with no owner action on the task
//   blocked    tasks open now with an open stuck blocker (queueLogic.STUCK_BLOCK_CODES; a dependency is normal waiting)
//   waiting    what waits on the owner now; the caller passes the Decisions count (null: not read)
//   spend_usd  the main sessions' cost growth in the window (sessionCosts; the session total includes the agents it
//              started, as far as Claude Code reports it); null without session rows
//   longest_stretch_h  the longest time work ran with no owner action (longestStretch)
//
// THE EVENTS (newest first, at most `max`, `more` = the rest): ids, kinds, codes, counts and times only, the same rule
// as the time log (lib/guardLog.js): never a question's text, an answer, a note or anything an agent wrote. Failures
// carry `fail: true`, so a view can show them first-class (a red gate is a row, not a footnote). Kinds:
//   queue-start, queue-idle (AW-5 rows), started, merged (queue.json), gate-red (a track's red gate run), fix-round,
//   base-red, conflict, push, ci-red (time log rows), blocked (a stuck blocker opened), question (added_at), answered
//   (resolutions).
//
// Tested in lib/__tests__/awaySummary.test.ts.
// =============================================================
'use strict';

const ES = require('./eventStatistics.js');
const L = require('./queueLogic.js');

const H = 3_600_000;
const DAY = 24 * H;
/** The window choices, in the order the board and `ravenseat since --window` offer them. */
const WINDOWS = Object.freeze(['last-seen', '24h', '7d']);
/** The span of the fixed windows. */
const SPAN = Object.freeze({ '24h': DAY, '7d': 7 * DAY });
/** A seen mark older than this falls back to 24 hours. */
const SEEN_MAX_MS = 7 * DAY;
/** The `by` values that mean the owner (as eventStatistics). */
const OWNER_BY = new Set(['owner', 'theBoard']);

const num = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const round1 = (x) => Math.round(x * 10) / 10;
const round2 = (x) => Math.round(x * 100) / 100;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The window to show.
 * @param {{ choice?: string, seen?: { at?: string }|null, from?: number|null, now?: number }} o
 * @returns {{ choice: string, used: string, from: number, to: number, note: string|null }}
 *   choice = what was asked (unknown = last-seen), used = what the window is (a fallback says why in note)
 */
function resolveWindow({ choice = 'last-seen', seen = null, from = null, now = Date.now() } = {}) {
  const want = WINDOWS.includes(choice) ? choice : 'last-seen';
  if (want !== 'last-seen') return { choice: want, used: want, from: now - SPAN[want], to: now, note: null };
  const fallback = (note) => ({ choice: want, used: '24h', from: now - DAY, to: now, note });
  const inside = (ms) => num(ms) != null && ms <= now && now - ms <= SEEN_MAX_MS;
  if (num(from) != null) return inside(from) ? { choice: want, used: 'last-seen', from, to: now, note: null } : fallback('the start is older than 7 days, showing the last 24 hours');
  const mark = Date.parse(seen?.at ?? '');
  if (!Number.isFinite(mark)) return fallback('no seen mark yet, showing the last 24 hours');
  if (mark > now) return fallback('the seen mark is in the future, showing the last 24 hours');
  if (!inside(mark)) return fallback('last seen over 7 days ago, showing the last 24 hours');
  return { choice: want, used: 'last-seen', from: mark, to: now, note: null };
}

/** "9 h 30 min", "45 min", "2 days 3 h". */
function durationText(ms) {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h < 24) return m ? `${h} h ${m} min` : `${h} h`;
  const d = Math.floor(h / 24);
  const rest = h % 24;
  return rest ? `${plural(d, 'day')} ${rest} h` : plural(d, 'day');
}

/** HH:MM in local time. */
function clock(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** "21:40", "21:40 yesterday" or "21:40 on 17 Nov", seen from `to`. */
function whenText(ms, to) {
  const day = (x) => {
    const d = new Date(x);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const days = Math.round((day(to) - day(ms)) / DAY);
  if (days <= 0) return clock(ms);
  if (days === 1) return `${clock(ms)} yesterday`;
  const d = new Date(ms);
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()];
  return `${clock(ms)} on ${d.getDate()} ${month}`;
}

/** The window in words: "since 21:40 yesterday (9 h 20 min)", "last 24 hours", "last 7 days". */
function windowText(w) {
  if (w.used === '24h') return 'last 24 hours';
  if (w.used === '7d') return 'last 7 days';
  return `since ${whenText(w.from, w.to)} (${durationText(w.to - w.from)})`;
}

/** The events in the window (all of them, unsorted). */
function collectEvents(queue, rows, from, to) {
  const out = [];
  const inWindow = (iso) => {
    const t = Date.parse(iso ?? '');
    return Number.isFinite(t) && t >= from && t <= to ? t : null;
  };
  const add = (iso, kind, task, text, extra = {}) => {
    const t = inWindow(iso);
    if (t == null) return;
    out.push({ time: new Date(t).toISOString(), kind, task: task ?? null, fail: extra.fail === true, text, ...(extra.ref ? { ref: extra.ref } : {}) });
  };
  const tasks = (Array.isArray(queue?.tasks) ? queue.tasks : []).filter((o) => o && typeof o === 'object' && o.external !== true);
  const stuck = new Set(L.STUCK_BLOCK_CODES);
  for (const o of tasks) {
    const id = String(o.id ?? '');
    if (!id) continue;
    add(o.started, 'started', id, `${id} started`);
    if (o.status === 'done') add(o.done, 'merged', id, `${id} merged`);
    for (const b of Array.isArray(o.blocks) ? o.blocks : [])
      if (b && stuck.has(b.code)) add(b.from, 'blocked', id, `${id} blocked: ${b.code}`, { fail: true });
  }
  // A question is shown by its id and the task waiting on it, never by its text.
  const waitingFor = (qid) => tasks.find((o) => Array.isArray(o.waiting_on) && o.waiting_on.includes(qid))?.id ?? null;
  for (const [qid, q] of Object.entries(queue?.question ?? {})) {
    const task = waitingFor(qid);
    add(q?.added_at, 'question', task, `Question ${qid}${task ? ` for ${task}` : ''}`, { ref: qid });
  }
  for (const [qid, r] of Object.entries(queue?.resolutions ?? {}))
    add(r?.time, 'answered', null, `${qid} answered${OWNER_BY.has(String(r?.by ?? '')) ? ' by you' : ''}`, { ref: qid });
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r !== 'object') continue;
    switch (r.event) {
      case 'queue-start':
        add(r.time, 'queue-start', null, `Queue started${r.command ? ` (${r.command})` : ''}`);
        break;
      case 'queue-idle':
        add(r.time, 'queue-idle', null, num(r.duration_s) != null ? `Queue went idle after ${durationText(r.duration_s * 1000)}` : 'Queue went idle');
        break;
      case 'gate': {
        if (r.ok !== false || !r.track) break;
        const failed = Array.isArray(r.failed) ? r.failed.map(String) : [];
        const what = failed.length ? `: ${failed[0]}${failed.length > 1 ? ` +${failed.length - 1}` : ''}` : '';
        add(r.time, 'gate-red', r.track, `${r.track} ${r.kind ? `${r.kind} ` : ''}gate red${what}`, { fail: true });
        break;
      }
      case 'fixRound':
        add(r.time, 'fix-round', r.task, `${r.task} ${r.reason === 'context' ? 'fresh context' : 'fix'} round${Number.isInteger(r.round) ? ` ${r.round}` : ''}`);
        break;
      case 'baseGate':
        if (r.ok === false) add(r.time, 'base-red', r.made_red_by ?? null, `Base red${r.made_red_by ? ` after ${r.made_red_by}` : ''}`, { fail: true });
        break;
      case 'mergeConflict':
        add(r.time, 'conflict', r.task, r.guard ? `${r.task} stopped by the merge guard` : `${r.task} merge conflict${Number.isInteger(r.files) ? ` in ${plural(r.files, 'file')}` : ''}`, { fail: true });
        break;
      case 'push': {
        const n = Number(r.task_count) || 0;
        add(r.time, 'push', null, `Pushed ${plural(n, 'task')}${r.branch ? ` to ${r.branch}` : ''}`);
        break;
      }
      case 'ciWatch':
        if (r.verdict && r.verdict !== 'green')
          add(r.time, 'ci-red', r.task ?? null, `CI ${r.verdict === 'infra' ? 'infrastructure trouble' : 'red'}${r.sha ? ` on ${String(r.sha).slice(0, 7)}` : ''}`, { fail: true });
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * The summary for a window (see the header).
 * @param {{ queue: object, rows: object[], from: number, to: number, waiting?: number|null, max?: number }} o
 *   queue with its archive (queueArchive.withArchive), rows = the time log rows (with its archives)
 */
function awaySummary({ queue, rows, from, to, waiting = null, max = 10 }) {
  const q = queue && typeof queue === 'object' ? queue : { tasks: [] };
  const tasks = (Array.isArray(q.tasks) ? q.tasks : []).filter((o) => o && typeof o === 'object');
  const safe = { ...q, tasks };
  const inWindow = (iso) => {
    const t = Date.parse(iso ?? '');
    return Number.isFinite(t) && t >= from && t <= to;
  };
  const merged = tasks.filter((o) => o.external !== true && o.status === 'done' && inWindow(o.done)).length;
  let recovered = 0;
  let stretch = 0;
  try {
    recovered = ES.autonomyStatistics(safe, [], { misses: [], interventions: 0 }, { from, to }).corrected.without_owner;
    stretch = ES.longestStretch(safe, { from, to });
  } catch {
    /* an odd queue: the numbers stay 0, the list still shows */
  }
  const stuck = new Set(L.STUCK_BLOCK_CODES);
  const blocked = tasks.filter((o) => !['done', 'cancelled'].includes(o.status) && stuck.has(L.openBlockOf(o)?.code)).length;
  const sessions = ES.sessionCosts(Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [], { from, to });
  const all = collectEvents(safe, rows, from, to).sort((a, b) => b.time.localeCompare(a.time) || a.kind.localeCompare(b.kind));
  const keep = Math.max(0, Math.floor(max));
  return {
    from: new Date(from).toISOString(),
    to: new Date(to).toISOString(),
    counts: {
      merged,
      recovered,
      blocked,
      waiting: num(waiting),
      spend_usd: sessions.length ? round2(sessions.reduce((s, x) => s + x.usd, 0)) : null,
      longest_stretch_h: round1(stretch / H),
    },
    events: all.slice(0, keep),
    total_events: all.length,
    more: Math.max(0, all.length - keep),
    empty: all.length === 0,
  };
}

/**
 * The terminal text for `ravenseat since`: the window line, four parts (Done, Stuck, Waiting on you, Spend) of one
 * line each, and the event list. A part that could not be read says `not read: <what> -> <why>` instead of a zero.
 */
function summaryLines(s, w, { ravenseat = 'ravenseat' } = {}) {
  const lines = [];
  const note = w.note ? ` (${w.note})` : '';
  if (s.empty) {
    lines.push(`Nothing ran since ${whenText(w.from, w.to)}.${note}`);
    if (s.counts.waiting) lines.push(`Waiting on you: ${s.counts.waiting} (${ravenseat} decide)`);
    return lines;
  }
  const c = s.counts;
  lines.push(`Since you left: ${windowText(w)}${note}`);
  lines.push(`Done: ${c.merged} merged, ${c.recovered} recovered without you, longest stretch without you ${c.longest_stretch_h} h`);
  lines.push(`Stuck: ${c.blocked} blocked now`);
  lines.push(c.waiting == null ? 'not read: waiting on you -> the decision list could not be built' : `Waiting on you: ${c.waiting}${c.waiting ? ` (${ravenseat} decide)` : ''}`);
  lines.push(c.spend_usd == null ? 'not read: spend -> no session cost rows in the window' : `Spend: $${c.spend_usd.toFixed(2)} (main sessions with their agents)`);
  lines.push('', 'Events, newest first:');
  for (const e of s.events) lines.push(`  ${whenText(Date.parse(e.time), w.to).padEnd(16)} ${e.fail ? 'x' : '-'} ${e.text}`);
  if (s.more) lines.push(`  ... and ${plural(s.more, 'older event')} (--json lists them all with --max)`);
  return lines;
}

module.exports = { WINDOWS, SEEN_MAX_MS, resolveWindow, durationText, whenText, windowText, collectEvents, awaySummary, summaryLines };
