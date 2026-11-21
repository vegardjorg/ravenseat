// =============================================================
// devilsAdvocate.js: one challenger run on a big plan's decision section (PG-7 of
// plans/plan-gate-vurdering-2026-11-21.md, owner decision 2026-11-21: all questions as recommended).
//
// WHY: the person who wrote a plan also wrote its "strongest case against", so it tends to be the weakest case. A
// reviewer that never saw the investigation, only the decision section and the code, is not anchored by it. It
// answers with the three strongest objections and the cheapest test that would show the plan is wrong, and that is
// appended under the section for the owner to read.
//
// The setting: plans.devilsAdvocate, OFF by default (setup). It costs one agent run (tokens) per use and a few minutes
// of reading, and the premortem in the decision section comes first. On, /plans offers it only for an XL plan or one
// in a sensitive zone (offer); it never runs without a yes.
//
// The parts:
//   setup(cfg)                       plans.devilsAdvocate: on only for true.
//   offer({ on, entry, zones })      should /plans offer a run: on, and size XL or a zone hit.
//   brief({ entry, section, code })  the prompt for the reviewer-challenger agent: the decision section's text and the
//                                    code paths, never the investigation document's path or text.
//   parseAnswer(text)                the agent's answer as { objections: [3], test } or the errors (exactly three
//                                    OBJECTION lines and one CHEAPEST TEST line).
//   appendBlock(text, anchor, a, o)  the document with the block appended at the end of the decision section.
//
// Pure, without I/O. Used by cli/plans.mjs (`plan challenge`) and the /plans skill (step 3c). Tested in
// lib/__tests__/devilsAdvocate.test.ts.
// =============================================================
'use strict';

/** The helper agent type that runs it (lib/queueHelpers.js CATALOG). */
const AGENT = 'reviewer-challenger';
/** How many objections the answer must have. */
const OBJECTIONS = 3;
/** The heading of the appended block; not one of the decision headings, so it never completes a section by itself. */
const HEADING = "Devil's advocate";
/** The longest line the block keeps from the answer. */
const LINE_MAX = 600;

const isObject = (v) => v != null && typeof v === 'object' && !Array.isArray(v);

/** plans.devilsAdvocate from the configuration: on only for true. */
function setup(cfg = {}) {
  const plans = isObject(cfg?.plans) ? cfg.plans : {};
  return { on: plans.devilsAdvocate === true };
}

/**
 * Should /plans offer a challenger run?
 * @param {{ on: boolean, entry: object|null, zones?: string[] }} o zones: the accepted zone ids the plan meets
 * @returns {{ offer: boolean, why: string|null, text: string }}
 */
function offer({ on = false, entry = null, zones = [] } = {}) {
  if (!on) return { offer: false, why: null, text: "No devil's advocate (plans.devilsAdvocate off)." };
  const z = (zones ?? []).filter(Boolean);
  const why = z.length ? `in sensitive zone ${z.join(', ')}` : entry?.size === 'XL' ? 'size XL' : null;
  if (!why) return { offer: false, why: null, text: `No devil's advocate: ${entry?.id ?? 'the plan'} is not XL and meets no zone.` };
  return {
    offer: true,
    why,
    text:
      `${entry.id} is ${why}. Run a devil's advocate on its decision section (one ${AGENT} run: three objections and ` +
      'the cheapest test, appended under the section)?',
  };
}

/**
 * The prompt for the challenger. It gets the decision section (text, not a path) and where the code is; the
 * investigation stays out, so the objections are not anchored by the reasoning that led to the plan.
 * @param {{ entry: object, section: string, code?: string[] }} o section: the decision section's lines as text; code:
 *   the files or folders the plan's tasks change (may be empty: then the whole repository)
 */
function brief({ entry, section, code = [] }) {
  const where = (code ?? []).filter(Boolean);
  return [
    `You are the devil's advocate for plan ${entry.id}${entry.title ? ` (${entry.title})` : ''}.`,
    'You get only its decision section and the code. You do not get the investigation behind it, on purpose: do not',
    'look for it. Read the code that the plan would change, then argue against the decision as strongly as you can.',
    '',
    'The decision section:',
    '<<<',
    String(section ?? '').trim(),
    '>>>',
    '',
    where.length ? `The code it would change: ${where.join(', ')}.` : 'The code: this repository.',
    '',
    'Answer with exactly these four lines and nothing else:',
    'OBJECTION 1: <the strongest reason this plan is wrong, too big or not needed, with the evidence from the code>',
    'OBJECTION 2: <the second strongest>',
    'OBJECTION 3: <the third strongest>',
    'CHEAPEST TEST: <the cheapest experiment that would show the plan is wrong before it is built>',
    'Read only: change no file and run no command that writes.',
  ].join('\n');
}

const oneLine = (s) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > LINE_MAX ? `${t.slice(0, LINE_MAX - 1)}…` : t;
};

/**
 * The agent's answer. Exactly OBJECTIONS numbered OBJECTION lines (1, 2, 3, each once) and one CHEAPEST TEST line, each
 * with text; other lines are ignored. Any case; "**OBJECTION 1:**" is read too.
 * @returns {{ objections: string[], test: string|null, error: string[] }}
 */
function parseAnswer(text) {
  const found = new Map();
  const tests = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const l = raw.replace(/\*\*/g, '').replace(/^\s*[-*]\s+/, '').trim();
    const o = l.match(/^objection\s+(\d+)\s*[:.)-]\s*(.*)$/i);
    if (o) {
      const n = Number(o[1]);
      if (!found.has(n)) found.set(n, []);
      found.get(n).push(oneLine(o[2]));
      continue;
    }
    const c = l.match(/^cheapest\s+test\s*[:.)-]\s*(.*)$/i);
    if (c) tests.push(oneLine(c[1]));
  }
  const error = [];
  const objections = [];
  for (let n = 1; n <= OBJECTIONS; n++) {
    const list = found.get(n) ?? [];
    if (list.length !== 1 || !list[0]) error.push(`OBJECTION ${n} must be there once, with text`);
    else objections.push(list[0]);
  }
  const extra = [...found.keys()].filter((n) => n < 1 || n > OBJECTIONS);
  if (extra.length) error.push(`exactly ${OBJECTIONS} objections, not ${OBJECTIONS + extra.length}`);
  if (tests.length !== 1 || !tests[0]) error.push('CHEAPEST TEST must be there once, with text');
  return error.length ? { objections: [], test: null, error } : { objections, test: tests[0], error: [] };
}

/**
 * The document with the block appended at the end of the decision section (before the next heading at the section's
 * level or above), or { error } when the anchor finds no section. Plain list lines, no bold labels, so the block never
 * counts as one of the decision headings.
 * @param {string} text the document
 * @param {string|null} anchor the decision source's anchor; without one the block goes at the end
 * @param {{ objections: string[], test: string }} answer parseAnswer's result
 * @param {{ date?: string, by?: string }} [o]
 * @returns {{ text: string|null, error: string|null }}
 */
function appendBlock(text, anchor, answer, { date = new Date().toISOString().slice(0, 10), by = AGENT } = {}) {
  const src = String(text ?? '');
  const eol = src.includes('\r\n') ? '\r\n' : '\n';
  const lines = src.split(/\r?\n/);
  let at = lines.length;
  let level = 2;
  if (typeof anchor === 'string' && anchor.trim()) {
    const { anchorQuery } = require('./taskLinks.js');
    const { sectionArea } = require('../missionText.js');
    const q = anchorQuery(anchor);
    const area = q ? sectionArea(src, q) : null;
    if (!area) return { text: null, error: `the document has no heading for ${anchor}` };
    at = area.to;
    const own = (lines[area.from - 1] ?? '').match(/^(#{1,6})\s/);
    level = own ? own[1].length : 2;
  }
  // Trailing empty lines of the section stay after the block.
  while (at > 0 && !lines[at - 1].trim()) at -= 1;
  const block = [
    '',
    `${'#'.repeat(Math.min(6, level + 1))} ${HEADING} (${date}, ${by})`,
    '',
    'Written without the investigation, from the decision section and the code. For the owner to weigh; it changes nothing by itself.',
    '',
    ...answer.objections.map((x, i) => `- Objection ${i + 1}: ${x}`),
    `- Cheapest test: ${answer.test}`,
  ];
  const out = [...lines.slice(0, at), ...block, ...lines.slice(at)];
  return { text: out.join(eol), error: null };
}

module.exports = { AGENT, OBJECTIONS, HEADING, setup, offer, brief, parseAnswer, appendBlock };
