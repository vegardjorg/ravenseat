// =============================================================
// readOutline.js: a short outline of a large file, added to the read guard's denial (roadmap 0y Y1). See
// docs/orchestration.md, "Reading guard".
//
// Why: when the read guard (hook-read-guard.mjs, lib/trackGuard.js assessReading) denies a whole-file Read of a large
// file, the agent used to spend one extra Grep round only to find where to read. The outline lists the file's headings
// and top-level declarations with their line numbers, so the agent can go straight to Read with offset and limit.
//
// What is outlined (a small, language-light set, matched line by line with regular expressions, no parser):
//   Markdown  (.md .markdown .mdx)                 # headings (ATX, "# " to "###### "), not inside ``` or ~~~ fences
//   JS/TS     (.js .mjs .cjs .jsx .ts .tsx .mts .cts)  top-level (column 0) function and class lines, export lines
//                                                  (export const/let/var, interface, type, enum, default, export { })
//                                                  and module.exports / exports.x =
//   SQL       (.sql)                               create statements (table, function, view, policy, trigger ...)
//
// Fails OPEN, always: an unknown type, a binary file (a NUL byte), a file that cannot be read, a file over SCAN_BYTES,
// a scan that takes longer than TIME_MS, nothing found, or any error gives the denial text back unchanged, byte for
// byte. withOutline never throws. The setting readGuard.outline (on by default) turns it off: then the hook gives
// today's text exactly. Test: lib/__tests__/readOutline.test.ts.
// =============================================================

const nodeFs = require('node:fs');
const path = require('node:path');

/** At most this many entries; the rest is one "… N more" line. */
const OUTLINE_MAX = 60;
/** A file larger than this is not scanned at all (keeps the hook fast; the denial is then today's text). */
const SCAN_BYTES = 1024 * 1024;
/** The scan gives up after this many milliseconds (checked every CHECK_EVERY lines). */
const TIME_MS = 200;
const CHECK_EVERY = 256;
/** One entry is cut to this many characters, so a minified line cannot fill the message. */
const ENTRY_CHARS = 100;

// JS/TS: only lines that start in column 0, which in practice are the top-level ones.
const JS_LINE = [
  /^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\b\s*\*?\s*[\w$]*\s*[(<]/,
  /^(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+[\w$]+/,
  /^export\s+(?:const|let|var)\s+[\w${[]/,
  /^export\s+(?:declare\s+)?(?:interface|type|enum|namespace|abstract\s+class)\s+[\w$]+/,
  /^export\s+default\b/,
  /^export\s*(?:\*|\{)/,
  /^module\.exports\b/,
  /^exports\.[\w$]+\s*=/,
];
const SQL_LINE =
  /^create\s+(?:or\s+replace\s+)?(?:(?:unique|materialized|temp|temporary)\s+)?(?:table|function|procedure|view|trigger|policy|index|type|schema|sequence|extension|domain)\b/i;
const MD_HEADING = /^#{1,6}\s+\S/;
const MD_FENCE = /^\s{0,3}(?:```|~~~)/;

/** The kinds the outline knows, by file extension, with the label the message uses. */
const KINDS = [
  { id: 'markdown', ext: ['.md', '.markdown', '.mdx'], label: 'Markdown headings' },
  {
    id: 'js',
    ext: ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.mts', '.cts'],
    label: 'JS/TS top-level functions, classes and exports',
  },
  { id: 'sql', ext: ['.sql'], label: 'SQL create statements' },
];

/** The outline kind for a file path, or null for a type the outline does not know. */
function outlineKind(file) {
  if (typeof file !== 'string' || !file) return null;
  const ext = path.extname(file).toLowerCase();
  return KINDS.find((k) => k.ext.includes(ext)) ?? null;
}

/**
 * Reads at most `cap` bytes of the file. Returns null when it is not a regular file, is larger than the cap (also when it
 * grew after stat), holds a NUL byte (binary) or cannot be read.
 */
function readCapped(file, cap, fs) {
  let fd = null;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > cap) return null;
    fd = fs.openSync(file, 'r');
    // One byte more than the cap, so a file that grew past the cap after stat is caught without reading it all.
    const buf = Buffer.alloc(cap + 1);
    let got = 0;
    while (got < buf.length) {
      const n = fs.readSync(fd, buf, got, buf.length - got, got);
      if (!n) break;
      got += n;
    }
    if (got > cap) return null;
    const bytes = buf.subarray(0, got);
    if (bytes.includes(0)) return null; // binary
    return bytes.toString('utf8');
  } catch {
    return null; // error-ignored: unreadable means no outline, never a denial of its own
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch {
        // error-ignored: closing a read-only descriptor
      }
    }
  }
}

/** Cuts one entry to ENTRY_CHARS characters, with "…" when it was cut. */
function cut(line) {
  const t = line.replace(/\s+$/, '');
  return t.length > ENTRY_CHARS ? `${t.slice(0, ENTRY_CHARS - 1)}…` : t;
}

/**
 * The outline entries of a text: [{ line, text }] (line numbers from 1), at most `max`, plus the total found.
 * Returns null when the time budget runs out.
 * @param {string} text
 * @param {string} kindId 'markdown' | 'js' | 'sql'
 * @param {{ max?: number, timeMs?: number, now?: () => number }} [o]
 */
function outlineEntries(text, kindId, { max = OUTLINE_MAX, timeMs = TIME_MS, now = Date.now } = {}) {
  const start = now();
  const lines = text.split('\n');
  const entries = [];
  let total = 0;
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    if (i % CHECK_EVERY === 0 && now() - start > timeMs) return null;
    const l = lines[i].replace(/\r$/, '');
    let hit = false;
    if (kindId === 'markdown') {
      if (MD_FENCE.test(l)) fenced = !fenced;
      else hit = !fenced && MD_HEADING.test(l);
    } else if (kindId === 'js') hit = JS_LINE.some((re) => re.test(l));
    else if (kindId === 'sql') hit = SQL_LINE.test(l);
    if (!hit) continue;
    total++;
    if (entries.length < max) entries.push({ line: i + 1, text: cut(l) });
  }
  return { entries, total };
}

/**
 * The denial text with the file's outline added, or the denial text unchanged (fails open, never throws).
 * @param {string} reason  the read guard's denial text as it is today
 * @param {string} file    absolute path of the denied file
 * @param {{ enabled?: boolean, max?: number, scanBytes?: number, timeMs?: number, now?: () => number,
 *   fs?: typeof import('node:fs') }} [o]  enabled = config().readGuard.outline (false = today's text exactly)
 * @returns {string}
 */
function withOutline(reason, file, o = {}) {
  try {
    if (o.enabled === false) return reason;
    const kind = outlineKind(file);
    if (!kind) return reason;
    const fs = o.fs === undefined ? nodeFs : o.fs;
    if (!fs) return reason;
    const text = readCapped(file, o.scanBytes ?? SCAN_BYTES, fs);
    if (text == null) return reason;
    const found = outlineEntries(text, kind.id, { max: o.max ?? OUTLINE_MAX, timeMs: o.timeMs ?? TIME_MS, now: o.now ?? Date.now });
    if (!found || !found.entries.length) return reason;
    const rows = found.entries.map((e) => `  ${e.line}: ${e.text}`);
    const rest = found.total - found.entries.length;
    if (rest > 0) rows.push(`  … ${rest} more (Grep -n for the rest)`);
    return `${reason}\nOutline (${kind.label}, line: text), to Read with offset and limit straight away:\n${rows.join('\n')}`;
  } catch {
    return reason; // error-ignored: the outline only adds text and must never change or stop a denial
  }
}

module.exports = { OUTLINE_MAX, SCAN_BYTES, TIME_MS, ENTRY_CHARS, KINDS, outlineKind, outlineEntries, withOutline };
