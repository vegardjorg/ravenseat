// =============================================================
// logic/evidence.js: evidence in the QA entry (the `qa` config, parsing, validation, warnings and the auto outcome).
//
// qaConfig, validateEvidence, parseEvidence, evidenceRequired, evidenceWarning, evidenceText, qaSplit, evidenceCommand
// and qaAutoOutcome. The QA status changes themselves (qaOk, qaDeviation) live in logic/pick.js.
//
// Part of the queueLogic.js split: lib/queueLogic.js re-exports every name, so callers keep requiring queueLogic.js.
// Used by queueLogic.js (the facade) and by logic/validate.js.
// Tested in lib/__tests__/queueQaEvidence.test.ts (through queueLogic.js).
// =============================================================

const { cfg } = require('./base.js');
const { hasLabel, groups } = require('./projects.js');

// ---- Evidence in the QA entry --------------------------------------------------------------------------------
//
// Every QA entry (a finished task waiting on QA) has one piece of evidence: how the owner, or the queue itself, sees that
// the delivery works. The track writes it as one line in track-result.md, `EVIDENCE <type>[=<ref>[,<ref>...]]`, and `receive`
// stores it as `evidence: { type, ref: [...] }` on the task (`qa evidence <id>` sets it by hand). The types and what
// they mean are config().qa (queue.config.json); the defaults:
//   screenshot   the owner looks at a screen; ref = the route or the screen
//   test         ref = the test file(s); the entry is closed automatically when qa.autoCommand is green (qa auto --run)
//   manual       the owner checks something by hand; ref = free text, gathered in one manual round in `qa`
// Without evidence every QA round has to guess where to look, and pure logic waits needlessly on the owner's eyes.

const QA_STANDARD = Object.freeze({
  evidenceTypes: ['screenshot', 'test', 'manual'],
  autoTypes: ['test'],
  manualTypes: ['manual'],
  autoCommand: null,
  evidenceLabels: ['visual'],
});
// A ref that is not free text: a path or a name, never spaces or shell characters (it goes into autoCommand as is).
const EVIDENCE_REF = /^[\w./@:+-]+$/;

/** The QA settings: config().qa merged with the defaults (the lists are replaced as a whole, as in queueConfig). */
function qaConfig(qa = cfg().qa) {
  const out = { ...QA_STANDARD, ...(qa && typeof qa === 'object' ? qa : {}) };
  for (const k of ['evidenceTypes', 'autoTypes', 'manualTypes', 'evidenceLabels'])
    if (!Array.isArray(out[k])) out[k] = [...QA_STANDARD[k]];
  return out;
}

/** The errors in an evidence object (empty list = valid). */
function validateEvidence(e, qa = qaConfig()) {
  if (!e || typeof e !== 'object' || Array.isArray(e))
    return ['evidence must be { type, ref } (set it with cq qa evidence <id> <type>[=<ref>])'];
  if (!qa.evidenceTypes.includes(e.type))
    return [`evidence.type must be one of ${qa.evidenceTypes.join(', ')}`];
  const ref = e.ref ?? [];
  if (!Array.isArray(ref) || ref.some((r) => typeof r !== 'string' || !r.trim()))
    return ['evidence.ref must be a list of texts'];
  const error = [];
  if (qa.autoTypes.includes(e.type) && !ref.length)
    error.push(`evidence ${e.type} needs a ref (what the command runs, e.g. the test file)`);
  if (!qa.manualTypes.includes(e.type))
    for (const r of ref)
      if (!EVIDENCE_REF.test(r))
        error.push(`evidence ${e.type}: "${r}" must be a path or a name (letters, digits and . / _ - @ : +)`);
  return error;
}

/**
 * Reads the EVIDENCE line in a text (track-result.md or the answer): `EVIDENCE test=src/x.test.ts`, `EVIDENCE: screenshot`,
 * `- EVIDENCE manual=the camera on a phone`. The first line that starts with EVIDENCE counts.
 * @returns {null | { error: string } | { evidence: { type: string, ref: string[] } }}
 */
function parseEvidence(text, qa = qaConfig()) {
  const m = /^[ \t]*(?:[-*][ \t]+)?`?EVIDENCE(?::|[ \t])[ \t]*([^\n`]*)`?[ \t]*$/m.exec(String(text ?? ''));
  if (!m) return null;
  const body = m[1].trim();
  const i = body.indexOf('=');
  const type = (i < 0 ? body : body.slice(0, i)).trim();
  const rest = i < 0 ? '' : body.slice(i + 1).trim();
  // A manual type has free text (what to check); the others are comma separated paths or names.
  const ref = qa.manualTypes.includes(type)
    ? rest
      ? [rest]
      : []
    : rest
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
  const evidence = { type, ref };
  const error = validateEvidence(evidence, qa);
  if (error.length) return { error: `the EVIDENCE line is invalid: ${error.join('; ')}` };
  return { evidence };
}

/** Does the task need evidence (one of the labels in qa.evidenceLabels)? */
function evidenceRequired(o, qa = qaConfig()) {
  return qa.evidenceLabels.some((l) => hasLabel(o, l));
}

/**
 * The warning `receive` gives (null when everything is in place, or when the task does not need evidence). A warning,
 * not a stop: the owner can still set it with qa evidence.
 * @param {{ o: object, evidence?: object|null, evidenceError?: string|null }} x
 */
function evidenceWarning({ o, evidence = null, evidenceError = null }, qa = qaConfig()) {
  if (evidenceError)
    return `WARNING: ${o.id}: ${evidenceError}. Fix the line in track-result.md, or set it: cq qa evidence ${o.id} <type>[=<ref>].`;
  if (!evidenceRequired(o, qa) || evidence || o.evidence) return null;
  const labels = qa.evidenceLabels.filter((l) => hasLabel(o, l)).join(', ');
  return (
    `WARNING: ${o.id} has the label ${labels}, but track-result.md has no EVIDENCE line ` +
    `(EVIDENCE ${qa.evidenceTypes.map((t) => (qa.manualTypes.includes(t) ? `${t}=<what>` : `${t}=<ref>`)).join(' | ')}). ` +
    `Set it by hand: cq qa evidence ${o.id} <type>[=<ref>].`
  );
}

/** The text for evidence in lists: "test src/x.test.ts", "screenshot", "manual: the camera". */
function evidenceText(e, qa = qaConfig()) {
  if (!e) return 'no evidence';
  const ref = e.ref ?? [];
  if (!ref.length) return e.type;
  return qa.manualTypes.includes(e.type) ? `${e.type}: ${ref[0]}` : `${e.type} ${ref.join(', ')}`;
}

/**
 * The QA list split by evidence (queue.mjs qa): `look` (everything the owner looks at, also entries without evidence)
 * grouped as qaList, `manual` (the manual types, one round) and `auto` (the auto types, closed by qa auto --run).
 */
function qaSplit(queue, qa = qaConfig()) {
  const waiting = (queue.tasks ?? []).filter((o) => o.status === 'done' && o.qa_status === 'waiting');
  const type = (o) => o.evidence?.type ?? null;
  const isManual = (o) => qa.manualTypes.includes(type(o));
  const isAuto = (o) => qa.autoTypes.includes(type(o));
  return {
    look: groups(
      waiting.filter((o) => !isManual(o) && !isAuto(o)),
      queue.projects ?? {},
    ),
    manual: waiting.filter(isManual),
    auto: waiting.filter(isAuto),
  };
}

/**
 * The shell command that runs the evidence of an auto entry (from qa.autoCommand). A pure function, so queue.mjs only runs
 * it. The refs are checked by validateEvidence (no spaces or shell characters), so they go in as they are.
 * @returns {{ command: string } | { error: string }}
 */
function evidenceCommand(o, qa = qaConfig()) {
  const e = o?.evidence;
  if (!e || !qa.autoTypes.includes(e.type)) return { error: `${o?.id} has no ${qa.autoTypes.join('/')} evidence` };
  const ref = e.ref ?? [];
  const f = validateEvidence(e, qa);
  if (f.length) return { error: `${o.id}: ${f.join('; ')}` };
  const c = qa.autoCommand;
  const template = typeof c === 'string' ? c : c && typeof c === 'object' ? c[e.type] : null;
  if (typeof template !== 'string' || !template.trim())
    return {
      error: `qa.autoCommand is not set for ${e.type} in queue.config.json (e.g. "npx vitest run {refs}")`,
    };
  const refs = ref.join(' ');
  const withId = template.replaceAll('{id}', o.id);
  return {
    command: withId.includes('{refs}') ? withId.replaceAll('{refs}', refs) : `${withId} ${refs}`,
  };
}

/**
 * Closes an auto entry when the evidence is green: qa_status -> ok, `qa_ok_by: "auto"`, the note says what was green.
 * Red changes nothing in the QA status (the entry stays for the owner or a new run), but is written as a remark.
 * @returns {{ error: string } | { closed: boolean }}
 */
function qaAutoOutcome(queue, id, green, now = new Date().toISOString(), qa = qaConfig()) {
  const o = (queue.tasks ?? []).find((x) => x.id === id);
  if (!o) return { error: `unknown task ${id}` };
  if (o.status !== 'done' || o.qa_status !== 'waiting')
    return { error: `${id} is not waiting on QA (status ${o.status}, qa_status ${o.qa_status ?? 'none'})` };
  if (!qa.autoTypes.includes(o.evidence?.type))
    return { error: `${id} has no ${qa.autoTypes.join('/')} evidence (${evidenceText(o.evidence, qa)})` };
  if (!green) {
    o.remarks = [...(o.remarks ?? []), `${now} QA auto red: ${evidenceText(o.evidence, qa)}`];
    return { closed: false };
  }
  o.qa_status = 'ok';
  o.qa_ok = now;
  o.qa_ok_by = 'auto';
  o.qa_note = `green ${evidenceText(o.evidence, qa)}`;
  return { closed: true };
}

module.exports = {
  qaConfig,
  validateEvidence,
  parseEvidence,
  evidenceRequired,
  evidenceWarning,
  evidenceText,
  qaSplit,
  evidenceCommand,
  qaAutoOutcome,
};
