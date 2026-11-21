// =============================================================
// planPostCheck.js: the follow-up after a plan is built (PG-6 of plans/plan-gate-vurdering-2026-11-21.md, owner
// decision 2026-11-21: all questions as recommended).
//
// WHY: the size estimate (S, M, L, XL) and the task estimates were never compared with what a plan really took, so they
// could not get better, and nobody asked whether a large plan met its success measure. When every queue task of a plan
// is done (derived maturity `built` or `verified`, lib/queuePlan.js), this gives:
//   - one row per plan for Statistics: the size estimate in tracks (SIZE_TRACK) against the real tasks plus fix rounds,
//     the summed task estimate against the measured time (start to done per task), and the cost in USD from the time
//     log (lib/costEstimate.js taskTotals). An unsized plan shows "no estimate".
//   - only for a plan with a decision section (a source with role decision, lib/planGate.js) whose section names a
//     success measure: one owner question PC-<plan>, "Success measure: …. Met, partly, not met?". No task waits on it,
//     so it stops nothing. The answers build the accuracy record per size (`accuracy`).
//
// The setting: plans.postCheck (on by default; postCheckSetup). Off: no rows and no question.
//
// The parts:
//   postCheckSetup(cfg)            plans.postCheck, on unless false.
//   successMeasure(text, anchor)   the success measure from a decision section, one line, or null.
//   decisionMeasure(entry, read)   the same from a plan entry's decision source (read: path -> text|null).
//   planRow(entry, queue, o)       the Statistics row of one built plan, or null when it is not built.
//   rows(entries, queue, o)        the rows of all built plans, the last finished first.
//   accuracy(rows)                 per size: plans, estimate against actual, time ratio, and the answers.
//   postCheckQuestion(entry, m)    the PC-<plan> question to register (type question, three choices).
//   due(queue, entry)              should the question be registered now: built, and not registered or answered yet.
//
// Pure, without I/O. Used by cli/taskEdit.mjs (set <id> done registers the question), cli/plans.mjs (`plan postcheck`)
// and lib/statisticsSections.js (the board's Plans follow-up card). Tested in lib/__tests__/planPostCheck.test.ts.
// =============================================================
'use strict';

const P = require('./queuePlan.js');

/** The prefix of a post-check question id. */
const PREFIX = 'PC-';
/** The answer options, in this order. Each fits a button (logic/questions.js choicesError). */
const CHOICES = Object.freeze(['Met', 'Partly', 'Not met']);
/** The longest question id the queue takes (logic/questions.js), and the longest measure in the question. */
const ID_MAX = 40;
const MEASURE_MAX = 200;

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);
const round = (x, d = 0) => Math.round(x * 10 ** d) / 10 ** d;

/** plans.postCheck from the configuration: on unless it is false. */
function postCheckSetup(cfg = {}) {
  const plans = isObject(cfg?.plans) ? cfg.plans : {};
  return { on: plans.postCheck !== false };
}

/** One line, without markdown emphasis, list marks or a closing full stop, at most MEASURE_MAX characters. */
function oneLine(s) {
  const t = String(s ?? '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
    .replace(/\*\*|__|`/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[:\s-]+/, '')
    .replace(/[.\s]+$/, '');
  if (!t) return null;
  return t.length > MEASURE_MAX ? `${t.slice(0, MEASURE_MAX - 1)}…` : t;
}

/**
 * The success measure in a decision section: the text after a "Success measure" label on the same line
 * ("**Success measure:** exports open in a spreadsheet"), or else the first plain line under that heading or label.
 * @param {string} text the document
 * @param {string|null} [anchor] the source's anchor (the section); without it the whole text
 * @returns {string|null}
 */
function successMeasure(text, anchor = null) {
  if (typeof text !== 'string') return null;
  const G = require('./planGate.js');
  const part = G.sectionLines(text, anchor);
  if (!part) return null;
  const lines = part.lines;
  const heading = (l) => /^#{1,6}\s/.test(l) || /^\s*(?:[-*]\s+)?\*\*[^*]+\*\*/.test(l);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const h = l.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    const b = l.match(/^\s*(?:[-*]\s+)?\*\*([^*]+)\*\*(.*)$/);
    const label = h ? h[1] : b ? b[1] : null;
    if (!label || !/\bsuccess\b/i.test(label)) continue;
    const rest = b ? oneLine(b[2]) : null;
    if (rest) return rest;
    // A label that ends with the colon inside the bold ("**Success measure:**") and text after it was handled above.
    for (let j = i + 1; j < lines.length; j++) {
      const n = lines[j];
      if (!n.trim()) continue;
      if (heading(n)) break;
      const t = oneLine(n);
      if (t) return t;
    }
    return null;
  }
  return null;
}

/** The success measure of a plan entry's decision source, or null (no source, unreadable, or no measure in it). */
function decisionMeasure(entry, readDoc) {
  const source = (entry?.sources ?? []).find((k) => k?.role === 'decision');
  if (!source || typeof source.path !== 'string' || typeof readDoc !== 'function') return null;
  let text = null;
  try {
    text = readDoc(source.path);
  } catch {
    text = null; // error-ignored: an unreadable section has no measure; the row still shows
  }
  return successMeasure(text, source.anchor ?? null);
}

/** The question id for a plan, or null when it would be too long. */
function questionId(entry) {
  const id = typeof entry?.id === 'string' && entry.id ? `${PREFIX}${entry.id}` : null;
  return id && id.length <= ID_MAX ? id : null;
}

/** The owner's answer to a PC question as one of CHOICES, or null (not answered, or free text that names none). */
function answerOf(queue, id) {
  const a = id ? queue?.resolutions?.[id]?.answer : null;
  if (typeof a !== 'string') return null;
  const s = a.trim().toLowerCase();
  if (s.startsWith('not met') || s.startsWith('not')) return 'Not met';
  if (s.startsWith('partly') || s.startsWith('partial')) return 'Partly';
  if (s.startsWith('met')) return 'Met';
  return null;
}

/**
 * The Statistics row of one plan, or null when not every queue task of it is done.
 * @param {object} entry the plan entry
 * @param {object} queue the queue (with the archived tasks, so a row does not change when a task is archived)
 * @param {{ estimate?: (task: object) => number, usd?: Map<string, number>|null, measure?: string|null }} [o] estimate:
 *   minutes per task (queueLogic.estimate); usd: the cost per task id (costEstimate.taskTotals), null without a time
 *   log; measure: the success measure (decisionMeasure), null without a decision section
 */
function planRow(entry, queue, { estimate = () => 0, usd = null, measure = null } = {}) {
  const tasks = queue?.tasks ?? [];
  const m = P.derivedMaturity(entry, tasks);
  if (m.maturity !== 'built' && m.maturity !== 'verified') return null;
  const list = P.queueTasksFor(entry, tasks);
  const fix = list.reduce((s, o) => s + (Number(o?.cost?.phases?.fix_rounds ?? (o.resumed ?? []).length) || 0), 0);
  const est = list.reduce((s, o) => s + (Number(estimate(o)) || 0), 0);
  const spans = list
    .map((o) => Date.parse(o.done ?? '') - Date.parse(o.started ?? ''))
    .filter((x) => Number.isFinite(x) && x >= 0);
  const cost = usd ? list.reduce((s, o) => s + (usd.get(o.id) ?? 0), 0) : null;
  const done = list
    .map((o) => o.done)
    .filter(Boolean)
    .sort()
    .pop();
  const qid = measure ? questionId(entry) : null;
  return {
    id: entry.id,
    title: entry.title ?? '',
    size: P.SIZES.includes(entry.size) ? entry.size : null,
    maturity: m.maturity,
    estimate_tasks: P.SIZE_TRACK[entry.size] ?? null,
    tasks: list.length,
    fix_rounds: fix,
    actual: list.length + fix,
    estimate_min: round(est),
    // Only when every task has both times; otherwise the comparison would be against part of the work.
    measured_min: spans.length === list.length && list.length ? round(spans.reduce((a, b) => a + b, 0) / 60_000) : null,
    usd: cost == null || !(cost > 0) ? null : round(cost, 2),
    done: done ?? null,
    measure: measure ?? null,
    question: qid,
    success: qid ? answerOf(queue, qid) : null,
  };
}

/** The rows of all built plans, the last finished first. Options as planRow, with measureFor(entry) for the measure. */
function rows(entries, queue, { estimate, usd = null, measureFor = () => null } = {}) {
  const out = [];
  for (const e of entries ?? []) {
    if (!e?.id) continue;
    let measure = null;
    try {
      measure = measureFor(e);
    } catch {
      measure = null; // error-ignored: the row shows without the question
    }
    const r = planRow(e, queue, { estimate, usd, measure });
    if (r) out.push(r);
  }
  return out.sort((a, b) => String(b.done ?? '').localeCompare(String(a.done ?? '')) || a.id.localeCompare(b.id));
}

/**
 * The accuracy record per size, from the rows: plans, the size estimate in tracks, the average actual (tasks plus fix
 * rounds), actual over estimate, measured time over estimated time, and how the success questions were answered.
 * Unsized plans are one group with size null and no estimate.
 */
function accuracy(list) {
  const groups = new Map();
  for (const r of list ?? []) {
    const k = r.size ?? '-';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const order = [...P.SIZES, '-'];
  return [...groups.entries()]
    .sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([k, rs]) => {
      const size = k === '-' ? null : k;
      const est = size ? P.SIZE_TRACK[size] : null;
      const actual = rs.reduce((s, r) => s + r.actual, 0) / rs.length;
      const timed = rs.filter((r) => r.measured_min != null && r.estimate_min > 0);
      const answers = { Met: 0, Partly: 0, 'Not met': 0 };
      for (const r of rs) if (r.success) answers[r.success] += 1;
      return {
        size,
        plans: rs.length,
        estimate_tasks: est,
        actual_avg: round(actual, 1),
        ratio: est ? round(actual / est, 2) : null,
        time_ratio: timed.length
          ? round(timed.reduce((s, r) => s + r.measured_min, 0) / timed.reduce((s, r) => s + r.estimate_min, 0), 2)
          : null,
        met: answers.Met,
        partly: answers.Partly,
        not_met: answers['Not met'],
        asked: rs.filter((r) => r.question).length,
      };
    });
}

/**
 * The PC-<plan> question to register, or null without a measure or with an id that is too long. Type question, the
 * three choices, no recommendation (only the owner can judge it), and no task waits on it.
 */
function postCheckQuestion(entry, measure) {
  const m = oneLine(measure);
  const id = questionId(entry);
  if (!m || !id) return null;
  return {
    id,
    question: {
      type: 'question',
      text: `${entry.id} is built. Success measure: ${m}. Met, partly, not met?`,
      choices: [...CHOICES],
      context:
        'Every queue task of the plan is done. No task waits on this answer; it goes into the estimate record per size ' +
        '(Statistics, Plans follow-up) so the next plan of this size is estimated better (plans.postCheck).',
    },
  };
}

/** Should the question be registered now: the plan is built (or verified) and its question is not registered or answered. */
function due(queue, entry) {
  const id = questionId(entry);
  if (!id) return false;
  if (Object.hasOwn(queue?.question ?? {}, id) || (queue?.resolved ?? []).includes(id)) return false;
  const m = P.derivedMaturity(entry, queue?.tasks ?? []).maturity;
  return m === 'built' || m === 'verified';
}

/** The cost per task id from the time log's usage events (costEstimate.taskTotals), or null without events. */
function usdPerTask(queue, events) {
  if (!Array.isArray(events) || !events.length) return null;
  const CE = require('./costEstimate.js');
  return new Map(CE.taskTotals({ queue, events }).map((x) => [x.id, x.usd]));
}

/**
 * The whole follow-up for the board and `plan postcheck`: { rows, accuracy }, at most `max` rows (the last finished).
 * @param {{ entries: object[], queue: object, events?: object[], estimate?: Function, measureFor?: Function, max?: number }} o
 */
function section({ entries, queue, events = [], estimate = require('./queueLogic.js').estimate, measureFor = () => null, max = 20 }) {
  const list = rows(entries, queue, { estimate, usd: usdPerTask(queue, events), measureFor });
  return { rows: list.slice(0, max), accuracy: accuracy(list), total: list.length };
}

module.exports = {
  PREFIX,
  CHOICES,
  postCheckSetup,
  successMeasure,
  decisionMeasure,
  questionId,
  answerOf,
  planRow,
  rows,
  accuracy,
  postCheckQuestion,
  due,
  usdPerTask,
  section,
};
