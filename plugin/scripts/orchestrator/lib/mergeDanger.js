// =============================================================
// mergeDanger.js: the door and blast radius of a delivery (MS-1 of plans/trailhead-gsd-skills-vurdering-2026-11-20.md).
//
// WHY: the owner should see at a glance what is hard to undo. The track says it in two lines of its report,
//   Door: one-way | two-way          (one-way: hard to undo once merged or used, such as a data or public API change)
//   Blast radius: <one word>         (what breaks if it is wrong: local, module, users, data, ...)
// the reviewer writes its own two lines, and the owner sees both where a delivery meets them (Decisions, "Decided for
// you", `ravenseat decide`, the PR body). It is written by agents, so it is NEVER a guard: nothing is blocked, approved
// or merged because of it, and a disagreement is shown, never resolved by code. A missing or malformed line is null,
// shown as "not stated", never a refusal.
//
//   parse(text)                     -> { door: 'one-way'|'two-way'|null, blast: string|null }
//   fromTrack({ report, reply })    each line from the report, else from the reply
//   record(values, { at })          what receive stores on the task (merge_danger)
//   reviewerCalls([{ type, text }]) -> [{ type, door, blast }], only the reviewers that state a call
//   disagreements(record)           -> [{ type, field, track, reviewer }] where a reviewer's call differs
//   packageSection(values)          the section in 00-package.md
//   receiveLine(id, values)         the one DOOR line receive prints
//   prFields(task)                  { door, blast, reviewerDoor } for the PR body (lib/ghOutbound.js prBody)
//
// The board's words for it live in lib/queueDecisions.js (it also runs in the browser). Pure: no git, no files.
// Tested in lib/__tests__/mergeDanger.test.ts and mergeDangerCards.test.ts.
// =============================================================
'use strict';

const NOT_STATED = 'not stated';
/** A blast radius is one word: a letter, then letters, digits or hyphens. */
const WORD = /^([a-z][a-z0-9-]{0,23})(?=$|[\s.,;:(])/i;

/** The value after "<label>:" on a line of its own (a list mark and bold allowed), or null. */
function valueOf(text, label) {
  const re = new RegExp(`^\\s*(?:[-*+]\\s+)?(?:\\*\\*|__)?${label}(?:\\*\\*|__)?\\s*:\\s*(?:\\*\\*|__)?\\s*(.*)$`, 'i');
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = re.exec(line);
    if (m) return m[1].replace(/[*_`]/g, '').trim();
  }
  return null;
}

function doorOf(value) {
  if (value == null) return null;
  const v = value.toLowerCase();
  const one = /\bone[\s-]?way\b/.test(v);
  const two = /\btwo[\s-]?way\b/.test(v);
  // Both (the template copied as is) or neither: malformed.
  if (one === two) return null;
  return /^(one|two)[\s-]?way\b/.test(v) ? (one ? 'one-way' : 'two-way') : null;
}

function blastOf(value) {
  if (value == null) return null;
  const v = value.trim();
  const m = WORD.exec(v);
  if (!m) return null;
  const rest = v.slice(m[1].length).trim();
  // One word, or one word and then an explanation set apart ("local (one file)", "users - every login").
  if (rest && !/^[.,;:(\-–]/.test(rest)) return null;
  return m[1].toLowerCase();
}

function parse(text) {
  return { door: doorOf(valueOf(text, 'door')), blast: blastOf(valueOf(text, 'blast[\\s-]radius')) };
}

function fromTrack({ report = null, reply = null } = {}) {
  const a = parse(report);
  const b = parse(reply);
  return { door: a.door ?? b.door, blast: a.blast ?? b.blast };
}

function record(values, { at = new Date().toISOString() } = {}) {
  return { door: values?.door ?? null, blast: values?.blast ?? null, at };
}

function reviewerCalls(reports) {
  const out = [];
  for (const r of reports ?? []) {
    if (!r?.type) continue;
    const p = parse(r.text);
    if (p.door || p.blast) out.push({ type: String(r.type), door: p.door, blast: p.blast });
  }
  return out;
}

function disagreements(rec) {
  if (!rec) return [];
  const out = [];
  for (const r of rec.reviewers ?? []) {
    for (const field of ['door', 'blast']) {
      const said = r?.[field] ?? null;
      if (said && said !== (rec[field] ?? null)) out.push({ type: r.type, field, track: rec[field] ?? null, reviewer: said });
    }
  }
  return out;
}

const shown = (v) => v ?? NOT_STATED;

function packageSection(values) {
  return [
    '',
    '## Door and blast radius',
    '',
    "The track's own call, read from its report. It is never a guard: nothing is blocked or approved by it. Check it and " +
      'write your own two lines after the FINDING lines, `Door: one-way|two-way` and `Blast radius: <one word>`; the owner ' +
      'sees a difference next to the track\'s call.',
    '',
    `- Door: ${shown(values?.door)}`,
    `- Blast radius: ${shown(values?.blast)}`,
  ];
}

function receiveLine(id, values) {
  return (
    `DOOR: ${id}: ${values?.door ? `${values.door} door` : `door ${NOT_STATED}`}, blast radius ${shown(values?.blast)} ` +
    "(the track's call; nothing is blocked or approved by it)."
  );
}

function prFields(task) {
  const md = task?.merge_danger ?? null;
  const door = md?.door ?? null;
  const other = (md?.reviewers ?? []).find((r) => r?.door && r.door !== door);
  return { door, blast: md?.blast ?? null, reviewerDoor: other?.door ?? null };
}

module.exports = { NOT_STATED, parse, fromTrack, record, reviewerCalls, disagreements, packageSection, receiveLine, prFields };
