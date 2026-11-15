// =============================================================
// findingLine.js: the FINDING line a reviewer writes per finding, and the tail of a track's GATE line.
//
// Why: a review report used to give only counts (`FINDINGS H=0 M=1 L=3 deferrable=L2,L3`) and free prose under it.
// The orchestrator could not tell which LOW findings were decided and which were lost, and two reviewers' `L1` became
// one. Now every finding, LOW too, is one line in a fixed form, with the same `@ <place>` as GATE and the same
// ` | <sentence>` tail as WIRE:
//
//   FINDING <code> <H|M|L> <mark> <class> @ <place> | <one sentence>
//
//   code      H1, M2, L3 ...: unique in the report, the letter is the severity.
//   mark      fix-round (H always), mechanical (M only), defer or before-merge (L only).
//   class     an id from the taxonomy (lib/failureClasses.js); unknown or "-" is `other`.
//   place     path, path:line or "-"; a path is checked like a WIRE path (lib/wiringItems.js checkPath).
//   sentence  cut to 200 characters and masked with the secret rules (lib/secretScan.js matchLine).
//
// The report is written by an agent, so it is DATA: the length and the count are capped (20 lines; the rest becomes one
// summary item), and a line that cannot be parsed still becomes an item, without a file and marked `invalid`, so it can
// only be closed by rejecting it. A finding never vanishes because of its format. The same goes for a report with
// counts over 0 and no FINDING lines (findingsOf): one summary item, so the counts alone never pass.
//
// The GATE line gets the same tail: `GATE <class> @ <place> | <sentence>`. The old free-text form (`GATE <words> @
// <file:line>`, `GATE: <words>`) is still read: the words are the title and the class is `other`.
//
// Pure: no I/O (secretScan.js is required for matchLine only). Used by: lib/logic/results.js (parseFindings,
// reportFindings), lib/knownBugGate.js (parseGate). Tested in: lib/__tests__/findingLine.test.ts.
// =============================================================
'use strict';

const { checkPath } = require('./wiringItems.js');
const { matchLine } = require('./secretScan.js');
const FC = require('./failureClasses.js');

/** At most this many FINDING lines are read from one report; more give one summary item. */
const MAX_LINES = 20;
/** The sentence is cut to this many characters (after masking). */
const MAX_TEXT = 200;
/** A free-text GATE title longer than this is cut (knownBugGate cuts the task title further). */
const MAX_TITLE = 1000;

/** The marks each severity may carry. */
const MARKS = Object.freeze({ H: ['fix-round'], M: ['fix-round', 'mechanical'], L: ['defer', 'before-merge'] });

/**
 * One FINDING line: upper case only and a space after it (so prose "finding" and the FINDINGS counts line are not
 * one), optionally a list item or the whole line in backticks. Group 1 is the opening backtick, group 2 the rest.
 */
const LINE = /^[ \t]*(?:[-*][ \t]+)?(`?)FINDING[ \t]+([^\n]*?)\1[ \t]*$/gm;

/** One line of printable text: control characters out, white space collapsed. Not cut. */
function oneLine(text) {
  return String(text ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Cut to `max` characters with an ellipsis. */
const cut = (t, max) => (t.length > max ? `${t.slice(0, max - 1).trim()}…` : t);

/**
 * The text with every secret masked: each word a rule hits becomes `[secret:<rule>]`, and when the whole line still
 * hits (a rule that spans words, like a private key header), the whole text is replaced. Masked BEFORE it is cut, so
 * a cut never leaves part of a key that no longer matches. matchLine gives up over 4,000 characters, so the text is
 * first cut to 1,000 (more than any field keeps).
 */
function maskText(text) {
  const words = oneLine(text).slice(0, 1000).split(' ');
  const masked = words.map((w) => {
    const rule = w ? matchLine(w) : null;
    return rule ? `[secret:${rule}]` : w;
  });
  const line = masked.join(' ');
  const rest = matchLine(line);
  return rest ? `[masked: the text hit the ${rest} rule]` : line;
}

/** A masked, cut sentence. */
const sentence = (t, max = MAX_TEXT) => cut(maskText(t), max);

/**
 * The place: "-" (none), a path, or path:line. A path that is not a plain repo path gives no file and the reason.
 * @returns {{ file: string|null, line: number|null, error?: string }}
 */
function parsePlace(raw) {
  const s = String(raw ?? '').trim();
  if (!s || s === '-') return { file: null, line: null };
  const m = /^(.*?):(\d{1,7})$/.exec(s);
  const checked = checkPath(m ? m[1] : s);
  if ('error' in checked) return { file: null, line: null, error: checked.error };
  return { file: checked.file, line: m ? Number(m[2]) : null };
}

/**
 * One body (the part after FINDING) as an item, or the reason it is not one.
 * @returns {{ ok: object } | { error: string, severity: string|null }}
 */
function parseBody(body, classes, seen) {
  const bar = body.indexOf('|');
  const head = (bar >= 0 ? body.slice(0, bar) : body).trim().split(/\s+/);
  const severity = /^[HML]$/.test(head[1] ?? '') ? head[1] : null;
  const fail = (error) => ({ error, severity });
  if (head.length < 4) return fail('too few fields: want <code> <H|M|L> <mark> <class> @ <place> | <sentence>');
  const [code, sev, mark, cls, at, ...placeParts] = head;
  if (!severity) return fail(`no such severity "${cut(oneLine(sev), 20)}" (H, M or L)`);
  if (!/^[HML]\d{1,3}$/.test(code)) return fail(`the code "${cut(oneLine(code), 20)}" is not like ${sev}1`);
  if (code[0] !== sev) return fail(`the code ${code} does not match the severity ${sev}`);
  if (!MARKS[sev].includes(mark)) return fail(`the mark "${cut(oneLine(mark), 20)}" is not allowed on ${sev} (${MARKS[sev].join(', ')})`);
  if (at !== '@') return fail('no " @ " after the class');
  if (!placeParts.length) return fail('no place after " @ " (a path, path:line or -)');
  if (bar < 0) return fail('no " | " before the sentence');
  const text = sentence(body.slice(bar + 1));
  if (!text) return fail('no sentence after " | "');
  if (seen.has(code)) return fail(`the code ${code} is used twice in the report`);
  seen.add(code);
  const place = parsePlace(placeParts.join(' '));
  return {
    ok: {
      code,
      severity: sev,
      mark,
      class: FC.normalizeClass(cls, classes),
      file: place.file,
      line: place.line,
      text,
      ...(place.error ? { place_error: place.error } : {}),
    },
  };
}

/** An item that can only be rejected: no file, class other, an X<n> code so it still has a key. */
const invalidItem = (n, severity, text, invalid) => ({
  code: `X${n}`,
  severity,
  mark: null,
  class: FC.OTHER,
  file: null,
  line: null,
  text,
  invalid,
});

/**
 * The FINDING lines in a report. `FINDING none` (or n/a, -) is no line.
 * counts: per severity over ALL lines (also those over the cap, and malformed ones whose severity can be read).
 * @param {string} text
 * @param {{ classes?: { id: string }[] }} [o]
 * @returns {{ items: object[], lines: number, counts: { H: number, M: number, L: number } }}
 */
function parseFindingLines(text, { classes = FC.coreClasses() } = {}) {
  const items = [];
  const counts = { H: 0, M: 0, L: 0 };
  const seen = new Set();
  let lines = 0;
  let bad = 0;
  for (const m of String(text ?? '').matchAll(LINE)) {
    const body = m[2].trim();
    if (!body || /^(none|n\/a|no|-)$/i.test(body)) continue;
    lines += 1;
    const r = parseBody(body, classes, seen);
    const sev = r.ok ? r.ok.severity : r.severity;
    if (sev) counts[sev] += 1;
    if (lines > MAX_LINES) continue;
    items.push(r.ok ?? invalidItem(++bad, r.severity, sentence(body), r.error));
  }
  if (lines > MAX_LINES)
    items.push(invalidItem(++bad, null, `${lines - MAX_LINES} finding line(s) over the cap of ${MAX_LINES} were not read; read the report`, 'over the cap'));
  return { items, lines, counts };
}

/** The deferrable codes: the valid items marked defer. */
const deferrableOf = (items) => items.filter((x) => !x.invalid && x.mark === 'defer').map((x) => x.code);

const countText = (c) => `H=${c.H} M=${c.M} L=${c.L}`;

/**
 * The findings of one report: the items, the counts (from the lines when there are any) and the deferrable codes.
 * With counts over 0 and no FINDING lines, one summary item, so the counts never pass alone.
 * @param {string} text the report
 * @param {{ counts?: { H: number, M: number, L: number } | null, classes?: object[] }} [o] counts: from the FINDINGS line
 * @returns {{ items: object[], lines: number, counts: object, deferrable: string[], note: string|null }}
 */
function findingsOf(text, { counts = null, classes } = {}) {
  const parsed = parseFindingLines(text, classes ? { classes } : {});
  if (!parsed.lines) {
    const c = counts ?? { H: 0, M: 0, L: 0 };
    const total = c.H + c.M + c.L;
    const items = total
      ? [invalidItem(1, null, `${['H', 'M', 'L'].filter((k) => c[k]).map((k) => `${k}=${c[k]}`).join(' ')} without FINDING lines; read the report`, 'no lines')]
      : [];
    return { items, lines: 0, counts: { ...c }, deferrable: [], note: null };
  }
  const differ = counts && ['H', 'M', 'L'].some((k) => counts[k] !== parsed.counts[k]);
  return {
    items: parsed.items,
    lines: parsed.lines,
    counts: parsed.counts,
    deferrable: deferrableOf(parsed.items),
    note: differ
      ? `the FINDINGS counts (${countText(counts)}) differ from the FINDING lines (${countText(parsed.counts)}); the lines count`
      : null,
  };
}

/**
 * The first GATE line in a report, old or new form. Upper case only, so a heading "Gate: ..." is not one.
 *   new  `GATE <class id> @ <place> | <sentence>`: the title is the class title.
 *   old  `GATE <words> [@ <file:line>]` or `GATE: <words>`: the words are the title, the class is other.
 * Free text with the new tail (`GATE <words> @ <place> | <sentence>`) is read the same way: words as title, class other.
 * @returns {null | { title: string, where: string|null, class: string, text: string|null, form: 'old'|'new' }}
 */
function parseGateLine(text, { classes = FC.coreClasses() } = {}) {
  const m = /^[ \t]*(?:[-*][ \t]+)?`?GATE(?::|[ \t])[ \t]*([^\n`]*)`?[ \t]*$/m.exec(String(text ?? ''));
  if (!m) return null;
  const body = m[1];
  const bar = body.indexOf('|');
  const tail = bar >= 0 ? sentence(body.slice(bar + 1)) || null : null;
  const before = bar >= 0 ? body.slice(0, bar) : body;
  // The place is the last " @ <one word>" before the tail.
  const at = /^(.*\S)\s+@\s+(\S+)\s*$/.exec(before);
  const head = oneLine(at ? at[1] : before);
  if (!head || /^(none|n\/a|no|-)$/i.test(head)) return null;
  let where = null;
  if (at) {
    const place = parsePlace(at[2]);
    if (place.file) where = place.line != null ? `${place.file}:${place.line}` : place.file;
  }
  const id = FC.normalizeClass(head, classes);
  if (id !== FC.OTHER) return { title: FC.titleOf(id, classes), where, class: id, text: tail, form: 'new' };
  // "other" or "-" as the class: the sentence is the best title there is.
  const title = head === FC.OTHER || head === '-' ? tail : cut(maskText(head), MAX_TITLE);
  if (!title) return null;
  return { title, where, class: FC.OTHER, text: tail, form: bar >= 0 ? 'new' : 'old' };
}

/**
 * The answer contract as short lines, for the reviewer prompt (lib/logic/results.js). The reviewer agent files
 * (plugin/agents/reviewer*.md) carry the same lines with the core classes; lib/__tests__/agentFiles.test.ts keeps them
 * equal.
 */
function contractLines(classes = FC.coreClasses()) {
  return [
    'First line exactly: `FINDINGS H=<n> M=<n> L=<n>`. Then one line per finding, LOW too:',
    '`FINDING <code> <H|M|L> <mark> <class> @ <file:line|-> | <one sentence>`',
    '(code H1, M1, L1 ...; mark: H fix-round, M fix-round or mechanical, L defer or before-merge.',
    `${FC.promptLine(classes)})`,
  ];
}

module.exports = { contractLines, MAX_LINES, MAX_TEXT, MARKS, maskText, parsePlace, parseFindingLines, findingsOf, deferrableOf, parseGateLine };
