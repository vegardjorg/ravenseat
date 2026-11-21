// =============================================================
// planReview.js: the narrow review before a risky task starts (DR-1, plans/drift-vurdering-2026-11-21.md section 5).
//
// WHY: a wrong boundary or data model is cheapest to find before a 40 to 120 minute track and its review rounds are
// spent on it. The intake triage (lib/queueTriage.js) already runs a short read-only agent before `fill` starts a task;
// the plan review is a second fixed checklist on that same step, not a new pipeline: one agent, one pass, one prompt
// with both answers (TRIAGE and PLANREVIEW), and only for risky tasks.
//
// Risky: the task's class is in planReview.classes (default D+: rare, and where a wrong plan costs most) OR it meets an
// accepted sensitive zone (lib/catalogZones.js zonesFor; the set is empty by default, so this adds nothing until the
// owner accepts a zone). A fix task or a continuation is never reviewed (the same rule as the triage).
//
// The checklist (one pass, about 20 turns, file:line or no note): (1) data model and migrations, (2) public interfaces
// and file formats, (3) irreversible steps (data deletion, renames others depend on), (4) file boundaries (a file the
// change needs missing from owned_files), (5) assumptions in the mission that the code contradicts. For a zone task also
// the reversibility questions (plans/plan-gate-vurdering-2026-11-21.md section 6).
//
// The answer: PLANREVIEW ok | notes | ask.
//   ok      nothing to add; the task can start.
//   notes   the note goes into the mission as an addition (the bonus, "PLAN REVIEW notes"), then the task can start.
//   ask     advisory (the default): the same as notes. block (planReview.mode, off by default since it stops work): an
//           owner question planreview-<id> with choices (Keep and start anyway, Rewrite); the task waits on it.
// A note without a file:line reference is dropped (recorded as ok with a remark): a vague note costs the track more than
// it gives.
//
// Pure logic (no file I/O). Used by lib/queueTriage.js and cli/triage.mjs. Tested in lib/__tests__/planReview.test.ts.
// =============================================================
'use strict';

const MODES = Object.freeze(['off', 'advisory', 'block']);
const RESULTS = Object.freeze(['ok', 'notes', 'ask']);
/** The defaults (lib/queueConfig.js STANDARD.planReview holds the same values). */
const DEFAULTS = Object.freeze({ mode: 'advisory', classes: Object.freeze(['D+']) });
/** A file:line reference: a path with an extension, a colon and a line number. */
const FILE_LINE = /[\w./\\-]+\.[A-Za-z0-9]+:\d+/;
const NOTE_MAX = 1500;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ms = (s) => (s ? Date.parse(s) : NaN);

/**
 * The setup: planReview in queue.config.json over DEFAULTS. A broken value reads as its default.
 * @returns {{ mode: 'off'|'advisory'|'block', classes: string[], on: boolean }}
 */
function setupOf(config) {
  const own = isObject(config?.planReview) ? config.planReview : {};
  const mode = MODES.includes(own.mode) ? own.mode : DEFAULTS.mode;
  const classes = Array.isArray(own.classes) && own.classes.every((c) => typeof c === 'string') ? [...own.classes] : [...DEFAULTS.classes];
  return { mode, classes, on: mode !== 'off' };
}

/** Why a task is risky, as reason parts ("class D+", "zone D-0001 Sign-in (files: src/a.ts)"); [] = not risky. */
function riskReasons(o, setup, zones = []) {
  const out = [];
  if (setup.classes.includes(String(o?.class))) out.push(`class ${o.class}`);
  const Z = require('./catalogZones.js');
  for (const z of Array.isArray(zones) ? zones : []) out.push(`zone ${Z.hitWords(z)}`);
  return out;
}

/** When the latest plan review counts from (ms): the review, or the owner's keep after it. NaN without one. */
function reviewTime(o) {
  const r = o?.plan_review;
  if (!isObject(r)) return NaN;
  return Math.max(...[ms(r.at), ms(r.kept_at)].filter(Number.isFinite), -Infinity);
}

/**
 * THE rule: does this task need a plan review before it starts? A waiting, risky task that is no fix task or
 * continuation, with no review newer than its last edit (lib/queueTriage.js lastEdit).
 * @param {object} o the task
 * @param {object} queue
 * @param {{ setup: object, zones?: object[], missionMtimeMs?: number|null }} c setup = setupOf(config); zones = the
 *   accepted zones the task meets (lib/catalogZones.js zonesFor)
 * @returns {{ need: boolean, reason: string|null }}
 */
function needsPlanReview(o, queue, { setup, zones = [], missionMtimeMs = null } = {}) {
  const no = { need: false, reason: null };
  if (!setup?.on || o?.status !== 'waiting') return no;
  const T = require('./queueTriage.js');
  if (T.continuation(o)) return no;
  const why = riskReasons(o, setup, zones);
  if (!why.length) return no;
  const reviewed = reviewTime(o);
  if (Number.isFinite(reviewed)) {
    const edited = T.lastEdit(o, queue, { missionMtimeMs });
    if (!(Number.isFinite(edited) && edited > reviewed)) return no;
  }
  return { need: true, reason: `plan review: ${why.join(', ')}` };
}

/** The plan review part of the triage prompt: the fixed checklist and the answer line. zones: the zone hits. */
function promptLines({ zones = [] } = {}) {
  const Z = require('./catalogZones.js');
  const zoneList = Array.isArray(zones) ? zones : [];
  return [
    '## Plan review (one pass, fixed checklist)',
    '',
    'This task is risky, so check the PLAN against the code before it starts. One pass, at most about 20 turns. Only',
    'these five points, and only what you can show with `file:line`; a point you cannot point at is no note.',
    '',
    '1. Data model and migrations: does the mission change a table, column, schema or stored format, and does the task own',
    '   the migration or schema files that change needs?',
    '2. Public interfaces and file formats: an exported function, an API, a CLI flag or a file other code or users read.',
    '3. Irreversible steps: deleting data, renaming something others depend on, a one-way format change.',
    '4. File boundaries: a file the change needs that is missing from the owned files.',
    '5. Assumptions in the mission that the code contradicts.',
    ...(zoneList.length
      ? [
          '',
          `The task is in a sensitive zone: ${zoneList.map((z) => `${Z.hitWords(z)}${z.reason ? `: ${z.reason}` : ''}`).join('; ')}.`,
          'Also answer briefly: what will be built on this choice, can it be reversed (behind an interface, a flag, a',
          'versioned contract, expand and contract), and what is the cheapest experiment that shows it.',
        ]
      : []),
    '',
    'Second line exactly one of:',
    '',
    '- `PLANREVIEW ok`: nothing on the five points.',
    '- `PLANREVIEW notes`: then the notes, each with `file:line`. They go into the mission for the track.',
    '- `PLANREVIEW ask`: a point the owner should decide before the start (a data model or boundary choice). Then why,',
    '  with `file:line`.',
  ];
}

/** The record line for the orchestrator: the flags of `ravenseat triage` for the plan review. */
function recordHint(cli, id) {
  return `\`${cli} triage ${id} --verdict <...> --plan <ok|notes|ask> --plan-note "<its notes>"\``;
}

/** The owner question id for an ask in block mode: planreview-<id>, then planreview-<id>-2 ... */
function questionIdFor(queue, id) {
  const taken = (q) => Object.hasOwn(queue?.question ?? {}, q) || (queue?.resolved ?? []).includes(q);
  const base = `planreview-${id}`.slice(0, 37);
  if (!taken(base)) return base;
  for (let n = 2; n < 100; n++) if (!taken(`${base}-${n}`)) return `${base}-${n}`;
  return null;
}

/** The choices of the owner question (the first is the recommendation); the triage's ownerChoice answers them. */
const CHOICES = Object.freeze(['Keep and start anyway', 'Rewrite']);

/**
 * Records a plan review (`ravenseat triage <id> --plan ok|notes|ask --plan-note "..."`). Mutates the queue (the caller
 * writes it under the lock).
 * @returns {{ error: string|null, question?: string|null, dropped?: boolean, task?: object }}
 */
function recordPlanReview(queue, id, { result, note = null, setup, by = null, now = new Date().toISOString() } = {}) {
  const L = require('./queueLogic.js');
  const o = (queue?.tasks ?? []).find((x) => x.id === id);
  if (!o) return { error: `unknown task ${id}` };
  if (!RESULTS.includes(result)) return { error: `--plan must be ${RESULTS.join(', ')}` };
  if (o.status !== 'waiting') return { error: `${id} has status ${o.status}; a plan review is for a waiting task` };
  const text = note == null ? '' : String(note).replace(/\s+/g, ' ').trim();
  if (result !== 'ok' && !text) return { error: `--plan ${result} needs --plan-note "..." (each point with file:line)` };
  if (text.length > NOTE_MAX) return { error: `the plan note is longer than ${NOTE_MAX.toLocaleString('en-US')} characters; keep it short` };
  const day = String(now).slice(0, 10);
  // file:line or no note: a vague note is dropped, the review counts as ok.
  if (result !== 'ok' && !FILE_LINE.test(text)) {
    o.plan_review = { result: 'ok', at: now, dropped: result, ...(by ? { by: String(by) } : {}) };
    o.remarks = [...(Array.isArray(o.remarks) ? o.remarks : []), `${now} plan review: ${result} dropped: no file:line in the note`];
    return { error: null, question: null, dropped: true, task: o };
  }
  let question = null;
  if (result === 'ask' && setup?.mode === 'block') {
    question = questionIdFor(queue, id);
    if (!question) return { error: `no free question id for ${id}` };
    const s = L.setQuestion(
      queue,
      {
        [question]: {
          type: 'question',
          text:
            `The plan review of ${id} ("${String(o.title ?? id).slice(0, 120)}") asks before the start: ${text.slice(0, 1200)}` +
            `${/[.!?]$/.test(text.slice(0, 1200)) ? '' : '.'} Start it as planned (with the note in the mission), or rewrite the mission?`,
          recommendation: CHOICES[0],
          source: 'plan review (triage helper)',
          choices: [...CHOICES],
        },
      },
      now,
    );
    if (s.error.length) return { error: s.error.join('; ') };
    o.waiting_on = [...new Set([...(o.waiting_on ?? []), question])];
    L.openBlock(o, 'owner-question', { now: Date.parse(now), note: `plan review ask (${question})` });
  }
  if (result !== 'ok') {
    const f = L.addToBonus(o, `PLAN REVIEW ${result} (${day}): ${text} (a read-only review before the start: check each point against the code)`, now);
    if (f) return { error: f };
  }
  o.plan_review = { result, at: now, ...(text ? { note: text } : {}), ...(by ? { by: String(by) } : {}), ...(question ? { question } : {}) };
  o.remarks = [...(Array.isArray(o.remarks) ? o.remarks : []), `${now} plan review: ${result}${text ? `: ${text.slice(0, 200)}` : ''}`];
  return { error: null, question, dropped: false, task: o };
}

/** The plan review in a few words for the board and `info` ("notes (2026-11-21)", "ask, waiting on planreview-X"). */
function summary(o) {
  const r = o?.plan_review;
  if (!isObject(r) || !RESULTS.includes(r.result)) return null;
  const day = typeof r.at === 'string' ? r.at.slice(0, 10) : '?';
  const extra = r.dropped ? `, a ${r.dropped} note dropped (no file:line)` : r.question ? `, owner question ${r.question}` : '';
  return `${r.result} (${day}${extra})${r.note ? `: ${r.note}` : ''}`;
}

module.exports = {
  MODES,
  RESULTS,
  DEFAULTS,
  CHOICES,
  FILE_LINE,
  setupOf,
  riskReasons,
  needsPlanReview,
  promptLines,
  recordHint,
  questionIdFor,
  recordPlanReview,
  summary,
};
