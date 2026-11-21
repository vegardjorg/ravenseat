// =============================================================
// planGate.js: the light plan gate, "decide before you build" (PG-1, PG-2 and PG-3 of
// plans/plan-gate-vurdering-2026-11-21.md, owner decision 2026-11-21: all eight questions as recommended).
//
// WHY: Ravenseat is strong on HOW to build and on gating a task's start, but nothing asked WHETHER and HOW MUCH. A
// large request went straight into many startable tasks, and a large plan reached `ready` by one field edit. Three small
// pieces, none of which stops work by default:
//   PG-2  shapeQuestion   when a request with no plan entry splits into more than `shape.threshold` tasks (default 5),
//                         or meets an accepted sensitive zone, /add-to-queue asks ONE question first: shape it
//                         (recommended), build the smallest version first, or build it all now. "All now" is a fine
//                         answer; it is recorded on the tasks as `shaped: skipped` (`smallest` for the second answer).
//                         `ravenseat plan shape --tasks <n>` prints it, so the skill text needs no rule of its own.
//   PG-1  decisionState   a plan of size L or XL, or one that meets a zone, expects a one-page decision section
//                         (plugin/docs/decision-note.md) linked as a source with role `decision`. The state is
//                         not-needed, missing, incomplete (which headings), skipped (the owner's reason) or done.
//   PG-3  readyGate       `plan edit … maturity=ready` on such a plan without a complete section: advisory (the
//                         default) prints one WARNING naming what is missing; block refuses the edit (off by default,
//                         it stops work); off says nothing. `plan edit <id> --skip-decision "<reason>"` records a skip
//                         (`decision_skip`), shown in `plan get`, which lets ready through in every mode.
//
// Why advisory by default: for a solo owner the author and the approver are the same person, so a block they lift with
// one command trains them to lift it. Seeing the gap, and a visible "skipped" mark, keep it honest without a wall.
//
// The settings: shape.nudge (off / offer / always-shape, default offer), shape.threshold (default 5),
// plans.decisionNote (default on), plans.readyCheck (off / advisory / block, default advisory). gateSetup reads them
// each with its own fallback, so a hand-edited config never breaks a command.
//
//   PG-8  largeBatchLine  `ravenseat add` with add.largeBatchWarn (default 5) or more tasks without a plan entry, or an
//                         estimate over a week at the measured pace, prints one WARNING. Never stops; 0 is off.
//   (PG-4, staged queueing with a checkpoint question, is lib/checkpoint.js.)
//
// Pure: no I/O. The caller passes readDoc (the text of a source path, or null) and the zone hits. Used by
// lib/queuePlan.js (editEntry's ctx.decisionGate, the decision_skip shape) and cli/plans.mjs (plan edit, plan get,
// plan shape). Tested in lib/__tests__/planGate.test.ts.
// =============================================================
'use strict';

const NUDGES = Object.freeze(['off', 'offer', 'always-shape']);
const READY_CHECKS = Object.freeze(['off', 'advisory', 'block']);
/** The values a task's `shaped` field may have: the user chose "build it all now" (skipped) or "smallest first". */
const SHAPED = Object.freeze(['skipped', 'smallest']);
/** Plan sizes that expect a decision section (4 or more tracks). */
const LARGE_SIZES = Object.freeze(['L', 'XL']);
/** The source role of the decision section. */
const ROLE = 'decision';
/** A skip reason is one line of at most this many characters. */
const REASON_MAX = 300;

const STANDARD = Object.freeze({ nudge: 'offer', threshold: 5, decisionNote: true, readyCheck: 'advisory' });

/**
 * The headings a decision section has, in template order (plugin/docs/decision-note.md). A heading counts when a
 * markdown heading or a bold label in the section matches `match`, so the owner's own wording ("Non-goals", "Out of
 * scope") still counts.
 */
const HEADINGS = Object.freeze([
  { title: 'Need and evidence', match: /\bneed\b|\bevidence\b/i },
  { title: 'Success measure', match: /\bsuccess\b/i },
  { title: 'Non-goals', match: /\bnon[- ]?goals?\b|\bout of scope\b/i },
  { title: 'Alternatives', match: /\balternatives?\b/i },
  { title: 'Cost', match: /\bcost\b/i },
  { title: 'Stop criteria', match: /\bstop\b|\bkill criteria\b/i },
  { title: 'Strongest case against', match: /\bagainst\b|\bpremortem\b/i },
  { title: 'Cheapest test', match: /\bcheapest\b|\bexperiment\b/i },
]);
/** The extra heading when the plan meets a sensitive zone (the five reversibility questions). */
const REVERSIBILITY = Object.freeze({ title: 'Reversibility', match: /\breversib/i });

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/**
 * The gate's settings from the configuration, each checked on its own (a wrong value falls back to its default).
 * @param {object} [cfg] the resolved configuration (queueConfig.config())
 * @returns {{ nudge: string, threshold: number, decisionNote: boolean, readyCheck: string }}
 */
function gateSetup(cfg = {}) {
  const shape = isObject(cfg?.shape) ? cfg.shape : {};
  const plans = isObject(cfg?.plans) ? cfg.plans : {};
  const t = shape.threshold;
  return {
    nudge: NUDGES.includes(shape.nudge) ? shape.nudge : STANDARD.nudge,
    threshold: Number.isInteger(t) && t >= 1 ? t : STANDARD.threshold,
    decisionNote: typeof plans.decisionNote === 'boolean' ? plans.decisionNote : STANDARD.decisionNote,
    readyCheck: READY_CHECKS.includes(plans.readyCheck) ? plans.readyCheck : STANDARD.readyCheck,
  };
}

// ---- PG-2: the shape-first question -------------------------------------------------------------------------------

/**
 * The one question before the split, or null when none applies (nudge off, a plan entry already given, or at most
 * `threshold` tasks and no zone hit). mode `always-shape` means: shape without asking (the user can still decline).
 * @param {{ tasks: number, zones?: string[], plan?: string|null }} req the split's task count, the zone ids it meets,
 *   and the plan entry when the work already has one
 * @param {{ nudge: string, threshold: number }} setup gateSetup's result
 * @returns {null | { mode: string, text: string, why: string, choices: { key: string, label: string, recommended: boolean,
 *   record: string|null }[] }}
 */
function shapeQuestion(req, setup = STANDARD) {
  if (setup.nudge === 'off' || req?.plan) return null;
  const tasks = Number.isFinite(req?.tasks) ? req.tasks : 0;
  const zones = Array.isArray(req?.zones) ? req.zones.filter(Boolean) : [];
  const over = tasks > setup.threshold;
  if (!over && !zones.length) return null;
  const why = [
    ...(over ? [`${tasks} tasks (over ${setup.threshold})`] : []),
    ...(zones.length ? [`sensitive zone ${zones.join(', ')}`] : []),
  ].join(' and ');
  return {
    mode: setup.nudge,
    why,
    text: `This would be ${why}. How do you want to go on?`,
    choices: [
      {
        key: 'shape',
        label:
          'Shape it first (recommended): up to three questions (who has the problem, what does done look like, what ' +
          'is out), then a one-page note as a plan entry',
        recommended: true,
        record: null,
      },
      {
        key: 'smallest',
        label: 'Build the smallest version first: stage 1 now, the rest later',
        recommended: false,
        record: 'smallest',
      },
      { key: 'all', label: 'Build it all now', recommended: false, record: 'skipped' },
    ],
  };
}

/** The shape errors of a task's `shaped` field: missing or null is fine, else one of SHAPED. */
function shapedErrors(o) {
  const v = o?.shaped;
  if (v == null) return [];
  return SHAPED.includes(v) ? [] : [`shaped must be ${SHAPED.join(' or ')} (the answer to the shape-first question)`];
}

// ---- PG-1: the decision section -----------------------------------------------------------------------------------

/** The shape errors of a plan entry's `decision_skip` ({ reason, at, by }), without the entry id. */
function skipErrors(v) {
  if (v == null) return [];
  const bad = ['decision_skip must be { reason, at, by } (set it with plan edit <id> --skip-decision "<reason>")'];
  if (!isObject(v)) return bad;
  if (Object.keys(v).some((k) => !['reason', 'at', 'by'].includes(k))) return bad;
  if (typeof v.reason !== 'string' || !v.reason.trim()) return bad;
  if (typeof v.at !== 'string' || typeof v.by !== 'string') return bad;
  if (v.reason.length > REASON_MAX || /[\u0000-\u001f\u007f]/.test(v.reason))
    return [`decision_skip.reason must be one line of at most ${REASON_MAX} characters`];
  return [];
}

/** Why a plan expects a decision section ("size L", "zone D-0001"), or null. */
function needWhy(entry, zones = []) {
  const z = (zones ?? []).filter(Boolean);
  if (z.length) return `zone ${z.join(', ')}`;
  if (LARGE_SIZES.includes(entry?.size)) return `size ${entry.size}`;
  return null;
}

/** The labels of the section: markdown headings and bold labels at the start of a line ("**Cost:**", "- **Cost**"). */
function labelsIn(lines) {
  const out = [];
  let inCode = false;
  for (const l of lines) {
    if (/^```/.test(l)) inCode = !inCode;
    if (inCode) continue;
    const h = l.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (h) out.push(h[1]);
    const b = l.match(/^\s*(?:[-*]\s+)?\*\*([^*]+)\*\*/);
    if (b) out.push(b[1]);
  }
  return out;
}

/** The lines of the source's section (the anchor's heading and what is under it), or the whole text without one. */
function sectionLines(text, anchor) {
  const lines = String(text).split(/\r?\n/);
  if (typeof anchor !== 'string' || !anchor.trim()) return { lines, own: null };
  const { anchorQuery } = require('./taskLinks.js');
  const { sectionArea } = require('../missionText.js');
  const q = anchorQuery(anchor);
  const area = q ? sectionArea(text, q) : null;
  if (!area) return null;
  // The anchor's own heading is left out, so "## Decision and cost" does not count as the Cost heading.
  return { lines: lines.slice(area.from, area.to), own: lines[area.from - 1] };
}

/**
 * The state of a plan's decision section.
 * @param {object} entry the plan entry
 * @param {{ readDoc?: (path: string) => string|null, zones?: string[], on?: boolean }} [o] readDoc: the text of a source
 *   path; zones: the accepted zone ids the plan meets; on: plans.decisionNote (false: never needed)
 * @returns {{ state: 'not-needed'|'missing'|'incomplete'|'skipped'|'done', why?: string, missing?: string[],
 *   reason?: string, source?: object, note?: string }}
 */
function decisionState(entry, { readDoc = () => null, zones = [], on = true } = {}) {
  const why = on ? needWhy(entry, zones) : null;
  if (!why) return { state: 'not-needed' };
  const wanted = [...HEADINGS, ...((zones ?? []).filter(Boolean).length ? [REVERSIBILITY] : [])];
  const skip = entry?.decision_skip;
  const skipped = (base) =>
    skip && !skipErrors(skip).length ? { state: 'skipped', why, reason: skip.reason, ...base } : null;
  const source = (entry?.sources ?? []).find((k) => k?.role === ROLE);
  if (!source) return skipped({}) ?? { state: 'missing', why, missing: wanted.map((h) => h.title) };
  const text = typeof source.path === 'string' ? readDoc(source.path) : null;
  if (typeof text !== 'string')
    return skipped({ source }) ?? { state: 'missing', why, source, note: `${source.path} cannot be read` };
  const part = sectionLines(text, source.anchor);
  if (!part)
    return (
      skipped({ source }) ?? {
        state: 'missing',
        why,
        source,
        note: `${source.path} has no heading for ${source.anchor}`,
      }
    );
  const labels = labelsIn(part.lines);
  const missing = wanted.filter((h) => !labels.some((l) => h.match.test(l))).map((h) => h.title);
  if (!missing.length) return { state: 'done', why, missing: [], source };
  return skipped({ source, missing }) ?? { state: 'incomplete', why, missing, source };
}

/** The state as one line for `plan get` ("Decision: missing (size L; ...)"), or null when none is expected. */
function decisionLine(s) {
  if (!s || s.state === 'not-needed') return null;
  if (s.state === 'done') return 'Decision: done';
  if (s.state === 'skipped') return `Decision: skipped (${s.reason})`;
  if (s.state === 'incomplete') return `Decision: incomplete (missing ${s.missing.join(', ')})`;
  return `Decision: missing (${s.why}${s.note ? `; ${s.note}` : ''}; template: the plugin's docs/decision-note.md)`;
}

// ---- PG-3: the check at ready -------------------------------------------------------------------------------------

/**
 * The check for editEntry (ctx.decisionGate): (old, fresh) -> { error, warning }. It speaks only when the edit moves
 * the plan TO ready (not when a ready plan gets another field), the plan expects a section, and the section is missing
 * or incomplete with no recorded skip.
 * @param {{ mode: string, on?: boolean, readDoc?: Function, zonesFor?: (entry: object) => string[] }} o mode:
 *   plans.readyCheck; on: plans.decisionNote; zonesFor: the zone ids a plan meets
 */
function readyGate({ mode = STANDARD.readyCheck, on = true, readDoc = () => null, zonesFor = () => [] } = {}) {
  const quiet = { error: null, warning: null };
  return (old, fresh) => {
    if (mode === 'off' || !on) return quiet;
    if (fresh?.maturity !== 'ready' || old?.maturity === 'ready') return quiet;
    let zones = [];
    try {
      zones = zonesFor(fresh) ?? [];
    } catch {
      // error-ignored: a zone only raises attention; the size rule still applies
      zones = [];
    }
    const s = decisionState(fresh, { readDoc, zones, on });
    if (s.state !== 'missing' && s.state !== 'incomplete') return quiet;
    const what =
      s.state === 'incomplete'
        ? `the decision section lacks ${s.missing.join(', ')}`
        : `no decision section (a source with role decision${s.note ? `; ${s.note}` : ''})`;
    const text =
      `${fresh.id} is ${s.why} and set to ready with ${what}. Template: the plugin's docs/decision-note.md; or record a skip ` +
      `with plan edit ${fresh.id} --skip-decision "<reason>"`;
    if (mode === 'block') return { error: `refused (plans.readyCheck block): ${text}`, warning: null };
    return { error: null, warning: text };
  };
}

/**
 * The zone ids a plan meets: its title and summary against the zones' keywords, and the zones of its queue tasks.
 * @param {object} entry the plan entry
 * @param {object[]} tasks the queue tasks
 * @param {(task: object) => { id: string }[]} zonesFor catalogZones.zonesOnDisk()'s function
 */
function planZones(entry, tasks, zonesFor) {
  if (typeof zonesFor !== 'function' || zonesFor.empty) return [];
  const ids = new Set();
  const own = { id: entry?.id, title: entry?.title ?? '', mission: entry?.summary ?? '' };
  for (const h of zonesFor(own) ?? []) ids.add(h.id);
  for (const t of tasks ?? []) if (t?.plan === entry?.id) for (const h of zonesFor(t) ?? []) ids.add(h.id);
  return [...ids].sort();
}

// ---- PG-8: the large unplanned batch line at add ------------------------------------------------------------------
//
// `ravenseat add` with at least `add.largeBatchWarn` tasks (default 5) that have no plan entry, or fewer whose estimate
// sum is over a week at the measured pace, prints ONE warning: "large batch without a plan entry; consider /plans
// first". It backs up PG-2 when /add-to-queue was not used. Tasks with `shaped` set already answered the shape-first
// question, so they do not count. It never stops the add. 0 turns it off.

const LARGE_BATCH = 5;
/** The pace window: the estimate of the tasks done in the last 28 days, per week. */
const PACE_DAYS = 28;
/** Fewer done tasks than this in the window: the pace is not known (queueForecast.MIN_DONE). */
const PACE_MIN_DONE = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

/** add.largeBatchWarn from the configuration: a whole number, 0 or more (0 = off); anything else falls back to 5. */
function largeBatchSetup(cfg = {}) {
  const v = isObject(cfg?.add) ? cfg.add.largeBatchWarn : undefined;
  return { min: Number.isInteger(v) && v >= 0 ? v : LARGE_BATCH };
}

/**
 * The estimate minutes done per week over the last 28 days, or null when fewer than 5 tasks were done in that window.
 * @param {object[]} tasks the queue tasks
 * @param {{ now?: number, estimate: (o: object) => number }} o estimate: queueLogic.estimate
 */
function weekPace(tasks, { now = Date.now(), estimate } = {}) {
  const from = now - PACE_DAYS * DAY_MS;
  const done = (tasks ?? []).filter((o) => {
    const t = o?.status === 'done' && o.done ? Date.parse(o.done) : NaN;
    return Number.isFinite(t) && t >= from && t <= now && o.status !== 'external';
  });
  if (done.length < PACE_MIN_DONE) return null;
  return done.reduce((s, o) => s + Number(estimate(o) || 0), 0) / (PACE_DAYS / 7);
}

/** "about 7 h" or "about 2 days" (8-hour days are not assumed: hours up to 48). */
function hoursText(min) {
  const h = Math.round(min / 60);
  return h <= 48 ? `about ${h} h` : `about ${Math.round(h / 24)} days of work`;
}

/**
 * The one WARNING line for a large batch with no plan entry, or null.
 * @param {object[]} added the tasks being added
 * @param {{ min: number, pace?: number|null, estimate: (o: object) => number }} o min: add.largeBatchWarn; pace: the
 *   minutes done per week (weekPace), null when not known
 */
function largeBatchLine(added, { min = LARGE_BATCH, pace = null, estimate } = {}) {
  if (!(min > 0)) return null;
  const loose = (added ?? []).filter((o) => o && !o.plan && o.shaped == null);
  if (!loose.length) return null;
  const sum = loose.reduce((s, o) => s + Number(estimate(o) || 0), 0);
  const many = loose.length >= min;
  const long = loose.length >= 2 && Number.isFinite(pace) && pace > 0 && sum > pace;
  if (!many && !long) return null;
  const what = `${loose.length} tasks, ${hoursText(sum)}${long ? ', over a week at the current pace' : ''}`;
  return (
    `WARNING: large batch without a plan entry (${what}); consider /plans first, or link the tasks with --plan <id>. ` +
    'Nothing was refused (add.largeBatchWarn).'
  );
}

module.exports = {
  LARGE_BATCH,
  largeBatchSetup,
  weekPace,
  largeBatchLine,
  NUDGES,
  READY_CHECKS,
  SHAPED,
  LARGE_SIZES,
  ROLE,
  HEADINGS,
  REVERSIBILITY,
  STANDARD,
  gateSetup,
  shapeQuestion,
  shapedErrors,
  skipErrors,
  needWhy,
  sectionLines,
  decisionState,
  decisionLine,
  readyGate,
  planZones,
};
