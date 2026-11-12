// =============================================================
// instructionAdvice.js: rules of thumb for splitting Claude's instructions, for `ravenseat instructions` (cli/instructions.mjs).
//
// Why: a large CLAUDE.md is usually a mix of rules that apply everywhere and rules for one area, procedures and
// descriptions of the code. Only the first kind belongs in what loads at start. These rules are simple on purpose, so the
// owner can see why a section got its suggestion (no model is asked):
//   delete  a folder layout, a dependency list or an architecture overview: Claude reads that from the code
//   skill   a numbered procedure (a runbook): a skill loads only its name and description until it is used
//   rule    most of the paths named in the section (in backticks) share one top folder: .claude/rules/<topic>.md with
//           `paths: <folder>/**` loads only when Claude works on files there
//   keep    the rest: no paths, paths from several areas, or a short section where a move saves little
// Duplicates: the same line (normalized) in two files drifts when one copy is fixed; keep one and point to it.
// Nothing here reads or writes a file: the text comes in, suggestions come out.
//
// Tested in lib/__tests__/instructionsCli.test.ts.
// =============================================================
'use strict';

const IS = require('./instructionSize.js');

/** A section shorter than this is kept: moving it saves little and splits the text for nothing. */
const SHORT_CHARS = 200;
/** The share of a section's paths that must share a top folder before it is proposed as a rule for that folder. */
const ONE_AREA = 0.6;
/** A normalized line shorter than this is too common to call a duplicate ("Run the tests."). */
const DUPLICATE_MIN = 25;

const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/** The sections of a file: the text before the first heading, then one per heading (none inside a code block). */
function sectionsOf(raw) {
  const lines = String(raw ?? '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let current = { heading: '(before the first heading)', level: 0, line: 1, body: [] };
  let fence = null;
  lines.forEach((l, i) => {
    const f = FENCE_LINE.exec(l);
    if (f) {
      if (!fence) fence = f[1][0];
      else if (f[1][0] === fence) fence = null;
    }
    const h = !fence && !f ? HEADING.exec(l) : null;
    if (h) {
      out.push(current);
      current = { heading: h[2].trim(), level: h[1].length, line: i + 1, body: [l] };
    } else current.body.push(l);
  });
  out.push(current);
  return out
    .map((s) => ({ heading: s.heading, level: s.level, line: s.line, text: s.body.join('\n') }))
    .filter((s) => s.level > 0 || s.text.trim())
    .map((s) => ({ ...s, chars: IS.letters(s.text) }));
}

/** The repo paths named in backticks: something with a folder in it, not a URL, a home path or a flag. */
function pathsIn(text) {
  const out = [];
  for (const m of String(text).matchAll(/`([^`\s]+)`/g)) {
    const p = m[1].replace(/^\.\//, '');
    if (/^[a-z]+:\/\//i.test(p) || /^[~/\\-]/.test(p) || !p.includes('/')) continue;
    if (!/^[\w.@*-]+(\/[\w.@*{},-]*)+$/.test(p)) continue;
    out.push(p);
  }
  return out;
}

const slug = (s) =>
  String(s)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

const LAYOUT = /\b(folder|directory|project|file|repo(sitory)?|code ?base)\s+(structure|layout|tree|map|overview)\b|\btech(nology)?\s+stack\b|\bdependencies\b|\barchitecture overview\b/i;
const TREE = /[├└│]──|^\s*[│├└]/m;
const PROCEDURE = /\b(runbook|procedure|how to|steps?|checklist|release|deploy(ment)?|workflow|when you)\b/i;

/** One section's suggestion: { action, why, paths?, file? }. */
function adviseSection(s) {
  const text = s.text ?? '';
  if (LAYOUT.test(s.heading) || TREE.test(text))
    return { action: 'delete', why: 'a description of the code (layout, stack or dependencies): Claude can read it from the files' };
  const steps = text.split('\n').filter((l) => /^\s*\d+[.)]\s+\S/.test(l)).length;
  if (steps >= 5 || (steps >= 3 && PROCEDURE.test(`${s.heading}\n${text}`)))
    return { action: 'skill', why: `a procedure (${steps} numbered steps): a skill loads only its name and description until it is used` };
  if ((s.chars ?? IS.letters(text)) < SHORT_CHARS) return { action: 'keep', why: 'short: moving it saves little' };
  const paths = pathsIn(text);
  if (paths.length >= 2) {
    const count = new Map();
    for (const p of paths) count.set(p.split('/')[0], (count.get(p.split('/')[0]) ?? 0) + 1);
    const [top, k] = [...count.entries()].sort((a, b) => b[1] - a[1])[0];
    if (k / paths.length >= ONE_AREA) {
      const topic = slug(s.heading) || slug(top) || 'area';
      return {
        action: 'rule',
        why: `${k} of ${paths.length} paths are under ${top}/`,
        paths: `${top}/**`,
        file: `.claude/rules/${topic}.md`,
      };
    }
    return { action: 'keep', why: `paths from ${count.size} areas: it applies across the project` };
  }
  return { action: 'keep', why: 'names no area of the code: it applies everywhere' };
}

/** The words of a suggestion as the CLI prints them. */
function adviceText(a) {
  if (a.action === 'rule') return `move to ${a.file} with paths: ${a.paths} (${a.why})`;
  if (a.action === 'skill') return `move to a skill (${a.why})`;
  if (a.action === 'delete') return `consider removing it (${a.why})`;
  return `keep in the root (${a.why})`;
}

/** A line as compared for duplicates: no list marker, no case, single spaces, no closing punctuation. */
const normalize = (l) =>
  l
    .trim()
    .replace(/^([-*+]|\d+[.)])\s+/, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,;:!?]+$/, '');

/**
 * The same line in two or more files: [{ line, at: ['file:line', ...] }], each line once, in the order first met.
 * Headings, code blocks, table rules and short lines are left out.
 */
function duplicates(files) {
  const seen = new Map();
  for (const f of files) {
    let fence = false;
    String(f.raw ?? '')
      .replace(/\r\n/g, '\n')
      .split('\n')
      .forEach((l, i) => {
        if (FENCE_LINE.test(l)) {
          fence = !fence;
          return;
        }
        if (fence || HEADING.test(l) || /^\s*\|?[\s:|-]+\|?\s*$/.test(l)) return;
        const key = normalize(l);
        if (key.length < DUPLICATE_MIN) return;
        if (!seen.has(key)) seen.set(key, { line: l.trim(), at: [], files: new Set() });
        const hit = seen.get(key);
        if (hit.files.has(f.rel)) return;
        hit.files.add(f.rel);
        hit.at.push(`${f.rel}:${i + 1}`);
      });
  }
  return [...seen.values()].filter((d) => d.files.size > 1).map(({ line, at }) => ({ line, at }));
}

module.exports = { SHORT_CHARS, ONE_AREA, sectionsOf, pathsIn, adviseSection, adviceText, duplicates };
