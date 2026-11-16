// =============================================================
// catalogIndex.js: the generated index of the code's exports and the building blocks tagged `@shared` (bolk B5 of the
// scope drift plan, plans/scope-drift-dry-katalog-2026-11-15.md § 2.3 and V1b; owner decision 16.11: the list of
// building blocks comes from a tag in the code, the index is gitignored, JS/TS first).
//
// WHY: reuse.md is short on purpose, so most helpers are only in the code, and a track finds one only if it greps for
// the right word. A `@shared <purpose>` line in a helper's JSDoc keeps the purpose next to the code (it moves with the
// file and goes when the function goes); this module collects those, and every other top-level export, into one index
// the queue can search (`ravenseat catalog find`), put in the excerpt (the tagged blocks in the task's folders) and hold a
// delivery's new names against (V1b, the near names for the reviewer).
//
// Precision before coverage. The scan is a light tokenizer, no parser and no dependency: it follows strings, template
// literals (with ${...}), comments and regex literals, counts braces and brackets, and reads a definition only at the
// top level of the file (brace depth 0) and an entry only in a `module.exports = {` or `export {` block. It misses
// exotic forms (a computed export, an export built in a loop) rather than invent a name. A re-export
// (`export { x } from`) is not indexed: the helper lives in the other file.
//
// The cache: <dataFolder>/catalog-index.json (gitignored, the queue writes it; the write guard keeps queue agents off it,
// lib/writeGuard.js). Per file the git blob sha and what the scan found; a file whose sha is unchanged is not read again,
// also after a move (the sha is looked up whatever the path). The listing comes from git (ls-files -s, and the blob sha of
// a changed or untracked file is computed the way git does), so the cache only saves work: what the index says always
// follows the tree it was built for.
//
// The text that reaches a mission or a review package (a purpose, a first doc line) is code from the project, so it is
// cut to one clean line: no control characters, no backticks and no HTML comment markers.
//
// Pure except refresh (git and the files; both can be swapped). Tested in lib/__tests__/catalogIndex.test.ts, the
// excerpt in catalogExcerpt.test.ts and the CLI in __tests__/catalogFlow.test.ts.
// =============================================================
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { isTestFile } = require('./testWeakening.js');

/** The cache file in the data folder. */
const FILE = 'catalog-index.json';
const VERSION = 1;
/** A file over this size is not read (generated or minified code). */
const MAX_BYTES = 512 * 1024;
/** At most this many files are indexed per tree. */
const MAX_FILES = 20000;
/** A purpose and a doc line are cut to this many characters. */
const PURPOSE_MAX = 120;
const DOC_MAX = 100;
/** find shows at most this many rows by default. */
const FIND_MAX = 10;
/** V1b gives the reviewer at most this many near names. */
const NEAR_MAX = 5;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ID = '[A-Za-z_$][\\w$]*';
const IDENT_CHAR = /[A-Za-z0-9_$]/;

// ---- what is indexed ------------------------------------------------------------------------------------------------

/** A JS/TS source file outside node_modules, not a test, not a declaration file, not minified. */
function isIndexed(p) {
  const s = String(p ?? '').replace(/\\/g, '/');
  if (!/\.(?:[cm]?[jt]sx?)$/i.test(s)) return false;
  if (/\.d\.[cm]?ts$/i.test(s) || /\.min\.[cm]?js$/i.test(s)) return false;
  if (s.startsWith('node_modules/') || s.includes('/node_modules/')) return false;
  return !isTestFile(s);
}

/** The git blob sha of a text or a buffer (what `git hash-object` gives). */
function blobSha(content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  return crypto.createHash('sha1').update(`blob ${buf.length}\0`).update(buf).digest('hex');
}

/** One clean line: no control characters, no backticks, no HTML comment markers, cut to `max`. */
function clean(s, max = PURPOSE_MAX) {
  const t = String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/<!--|-->/g, ' ')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 3).trimEnd()}...` : t;
}

// ---- the tokenizer --------------------------------------------------------------------------------------------------

/** Words after which a `/` starts a regex literal, not a division. */
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'instanceof']);

/** The end of a regex literal that starts at j (the index after its closing / and flags), or -1 when the line has none. */
function regexEnd(l, j) {
  let inClass = false;
  for (let k = j + 1; k < l.length; k++) {
    const ch = l[k];
    if (ch === '\\') k++;
    else if (inClass) {
      if (ch === ']') inClass = false;
    } else if (ch === '[') inClass = true;
    else if (ch === '/') {
      k++;
      while (k < l.length && /[a-z]/i.test(l[k])) k++;
      return k;
    }
  }
  return -1;
}

/**
 * Per line, the state at its start: `code` (not inside a string, template literal or comment), `depth` (braces) and
 * `nest` (parentheses and brackets). And the JSDoc blocks (`/** ... *\/`) with their first and last line.
 * @returns {{ lines: string[], meta: { code: boolean, depth: number, nest: number }[], docs: { start: number, end: number, text: string }[] }}
 */
function lex(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const meta = [];
  const docs = [];
  let state = 'code'; // code | block | sq | dq | tpl
  let depth = 0;
  let nest = 0;
  const tpl = []; // the brace depth at each open ${, to go back into the template literal at its }
  let prev = ''; // the last significant character in code ('a' for a word or a number)
  let word = ''; // the last word in code
  let block = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    meta.push({ code: state === 'code', depth, nest });
    let j = 0;
    while (j < l.length) {
      const c = l[j];
      if (state === 'block') {
        const end = l.indexOf('*/', j);
        if (end < 0) {
          block.buf.push(l.slice(j));
          break;
        }
        block.buf.push(l.slice(j, end));
        if (block.doc) docs.push({ start: block.start, end: i, text: block.buf.join('\n') });
        block = null;
        state = 'code';
        j = end + 2;
        continue;
      }
      if (state === 'sq' || state === 'dq') {
        if (c === '\\') j += 2;
        else {
          if (c === (state === 'sq' ? "'" : '"')) {
            state = 'code';
            prev = 'a';
            word = '';
          }
          j++;
        }
        continue;
      }
      if (state === 'tpl') {
        if (c === '\\') j += 2;
        else if (c === '`') {
          state = 'code';
          prev = 'a';
          word = '';
          j++;
        } else if (c === '$' && l[j + 1] === '{') {
          tpl.push(depth);
          depth++;
          state = 'code';
          prev = '{';
          word = '';
          j += 2;
        } else j++;
        continue;
      }
      // In code.
      if (c === '/' && l[j + 1] === '/') break;
      if (c === '/' && l[j + 1] === '*') {
        const doc = l[j + 2] === '*' && l[j + 3] !== '/';
        block = { start: i, doc, buf: [] };
        state = 'block';
        j += doc ? 3 : 2;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') {
        state = c === "'" ? 'sq' : c === '"' ? 'dq' : 'tpl';
        j++;
        continue;
      }
      if (c === '/') {
        const isRegex = REGEX_AFTER_WORD.has(word) || !(prev === 'a' || prev === ')' || prev === ']');
        const end = isRegex ? regexEnd(l, j) : -1;
        prev = end > 0 ? 'a' : '/';
        word = '';
        j = end > 0 ? end : j + 1;
        continue;
      }
      if (IDENT_CHAR.test(c)) {
        let k = j;
        while (k < l.length && IDENT_CHAR.test(l[k])) k++;
        word = l.slice(j, k);
        prev = 'a';
        j = k;
        continue;
      }
      if (c === '{') depth++;
      else if (c === '}') {
        if (tpl.length && tpl[tpl.length - 1] === depth - 1) {
          tpl.pop();
          depth--;
          state = 'tpl';
          j++;
          continue;
        }
        depth = Math.max(0, depth - 1);
      } else if (c === '(' || c === '[') nest++;
      else if (c === ')' || c === ']') nest = Math.max(0, nest - 1);
      if (!/\s/.test(c)) {
        prev = c;
        word = '';
      }
      j++;
    }
    // A quoted string ends with its line (a line continuation is rare enough to give up on): a stray quote in JSX text
    // costs one line, never the rest of the file.
    if (state === 'sq' || state === 'dq') state = 'code';
  }
  meta.push({ code: state === 'code', depth, nest }); // the state after the last line
  return { lines, meta, docs };
}

// ---- the scan -------------------------------------------------------------------------------------------------------

/** The parts of a list text at its own level (not inside brackets or strings), stopping at a closer it did not open. */
function splitTop(s) {
  const out = [];
  let cur = '';
  let level = 0;
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      cur += ch;
      if (ch === '\\') cur += s[++i] ?? '';
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if ('([{'.includes(ch)) level++;
    else if (')]}'.includes(ch)) {
      if (level === 0) break;
      level--;
    } else if (ch === ',' && level === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** The doc text's first line (not a tag) and the @shared purpose, if tagged. */
function readDoc(text) {
  const rows = String(text)
    .split('\n')
    .map((l) => l.replace(/^\s*\*?\s?/, '').trim());
  const first = rows.find((l) => l && !l.startsWith('@')) ?? '';
  const tag = rows.map((l) => l.match(/^@shared(?:\s+(.*))?$/)).find(Boolean);
  return { first: clean(first, DOC_MAX), shared: tag ? clean(tag[1] || first) : null };
}

const FN_VALUE = new RegExp(`^(?:async\\s+)?(?:function\\b|(?:<[^>]*>\\s*)?\\([^()]*\\)\\s*(?::[^=]+)?=>|${ID}\\s*=>|\\(\\s*$)`);
const DEF_FUNCTION = new RegExp(`^(export\\s+(?:default\\s+)?)?(?:declare\\s+)?(?:async\\s+)?function\\s*\\*?\\s*(${ID})`);
const DEF_VALUE = new RegExp(`^(export\\s+)?(?:declare\\s+)?(?:const|let|var)\\s+(${ID})\\s*(?::[^=]+)?=\\s*(.*)$`);
const DEF_CLASS = new RegExp(`^(export\\s+(?:default\\s+)?)?(?:declare\\s+)?(?:abstract\\s+)?class\\s+(${ID})`);
const EXPORTS_DOT = new RegExp(`^(?:module\\.)?exports\\.(${ID})\\s*=\\s*(.*)$`);
const MODULE_EXPORTS = /^module\.exports\s*=\s*(.*)$/;
const ESM_LIST = /^export\s*\{(.*)$/;
const ESM_DEFAULT = new RegExp(`^export\\s+default\\s+(${ID})\\s*;?\\s*$`);
const LOCAL = new RegExp(`^(${ID})\\s*;?\\s*$`);

/** One entry of a module.exports block: { name, local } or null. */
function cjsEntry(piece) {
  let m = piece.match(new RegExp(`^(?:async\\s+)?\\*?\\s*(${ID})\\s*\\(`));
  if (m) return { name: m[1], local: null, kind: 'function' };
  m = piece.match(new RegExp(`^(${ID})\\s*:\\s*(.*)$`));
  if (m) {
    const local = m[2].match(new RegExp(`^(${ID})$`))?.[1] ?? null;
    return { name: m[1], local, kind: local ? null : FN_VALUE.test(m[2]) ? 'function' : 'value' };
  }
  m = piece.match(new RegExp(`^(${ID})$`));
  return m ? { name: m[1], local: m[1], kind: null } : null;
}

/** One entry of an `export { ... }` list: { name, local } or null (a type entry is skipped). */
function esmEntry(piece) {
  if (/^type\s/.test(piece)) return null;
  const m = piece.match(new RegExp(`^(${ID})(?:\\s+as\\s+(${ID}))?$`));
  return m ? { name: m[2] ?? m[1], local: m[1], kind: null } : null;
}

/**
 * The top-level exports of a JS/TS source and the ones tagged @shared in the JSDoc right above their definition.
 * @returns {{ exports: { name: string, line: number, kind: string, doc: string }[],
 *   shared: { name: string, line: number, purpose: string }[], problems: string[] }}
 */
function scanSource(text) {
  const { lines, meta, docs } = lex(text);
  const docAt = new Map(docs.map((d) => [d.end, d]));
  const used = new Set();
  const defs = new Map(); // local name -> { line, kind, doc }
  const exports = [];
  const exported = new Set();
  const problems = [];
  let block = null; // { kind: 'cjs'|'esm', entries: [], line }

  const docFor = (i, sameLine) => {
    if (sameLine && docAt.has(i)) return docAt.get(i);
    let k = i - 1;
    while (k >= 0 && meta[k].code && meta[k].depth === 0 && /^\s*@/.test(lines[k])) k--;
    return docAt.get(k) ?? null;
  };
  const addExport = (name, line, kind, doc) => {
    if (exported.has(name)) return;
    exported.add(name);
    exports.push({ name, line, kind, doc });
  };
  const resolve = (entries, line) => {
    for (const e of entries) {
      const local = e.local ? defs.get(e.local) : null;
      const line1 = local?.line ?? line;
      const kind = e.kind ?? local?.kind ?? 'value';
      addExport(e.name, line1, kind, local?.doc ?? null);
    }
  };
  const take = (entries, parser, piecesText) => {
    for (const p of splitTop(piecesText)) {
      const e = parser(p);
      if (e) entries.push(e);
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const m0 = meta[i];
    if (!m0.code) continue;
    const raw = lines[i];
    if (block) {
      // Inside a module.exports = { or export { block: an entry starts on a line at depth 1, outside brackets.
      if (m0.depth === 1 && m0.nest === block.nest) take(block.entries, block.kind === 'cjs' ? cjsEntry : esmEntry, raw.trim());
      if (meta[i + 1].depth === 0) {
        if (!(block.kind === 'esm' && /\}\s*from\b/.test(raw))) resolve(block.entries, block.line);
        block = null;
      }
      continue;
    }
    if (m0.depth !== 0 || m0.nest !== 0) continue;
    // A one-line doc in front of the definition: /** ... */ export function x() {}
    const lead = raw.match(/^\s*\/\*\*.*?\*\/\s*/);
    const t = (lead ? raw.slice(lead[0].length) : raw).trimStart();
    const line = i + 1;
    let m;
    let def = null; // { name, kind, exported }
    if ((m = t.match(DEF_FUNCTION))) def = { name: m[2], kind: 'function', exported: !!m[1] };
    else if ((m = t.match(DEF_CLASS))) def = { name: m[2], kind: 'class', exported: !!m[1] };
    else if ((m = t.match(DEF_VALUE))) def = { name: m[2], kind: FN_VALUE.test(m[3]) ? 'function' : 'value', exported: !!m[1] };
    if (def) {
      const d = docFor(i, !!lead);
      if (d) used.add(d);
      const info = d ? readDoc(d.text) : { first: '', shared: null };
      defs.set(def.name, { line, kind: def.kind, doc: info.first || null, shared: info.shared });
      if (def.exported) addExport(def.name, line, def.kind, info.first || null);
      continue;
    }
    if ((m = t.match(EXPORTS_DOT))) {
      const local = m[2].match(LOCAL)?.[1] ?? null;
      const d = docFor(i, !!lead);
      if (d) used.add(d);
      if (local) resolve([{ name: m[1], local, kind: null }], line);
      else {
        const info = d ? readDoc(d.text) : { first: '', shared: null };
        defs.set(m[1], { line, kind: FN_VALUE.test(m[2]) ? 'function' : 'value', doc: info.first || null, shared: info.shared });
        addExport(m[1], line, defs.get(m[1]).kind, info.first || null);
      }
      continue;
    }
    if ((m = t.match(MODULE_EXPORTS))) {
      const rest = m[1].trim();
      if (rest.startsWith('{')) {
        const entries = [];
        take(entries, cjsEntry, rest.slice(1));
        if (meta[i + 1].depth === 0) resolve(entries, line);
        else block = { kind: 'cjs', entries, line, nest: 0 };
      } else {
        const fn = rest.match(new RegExp(`^(?:function|class)\\s*\\*?\\s*(${ID})`));
        const local = fn?.[1] ?? rest.match(LOCAL)?.[1] ?? null;
        if (local) resolve([{ name: local, local, kind: fn ? (rest.startsWith('class') ? 'class' : 'function') : null }], line);
      }
      continue;
    }
    if ((m = t.match(ESM_LIST))) {
      const entries = [];
      take(entries, esmEntry, m[1]);
      if (meta[i + 1].depth === 0) {
        if (!/\}\s*from\b/.test(t)) resolve(entries, line);
      } else block = { kind: 'esm', entries, line, nest: 0 };
      continue;
    }
    if ((m = t.match(ESM_DEFAULT))) resolve([{ name: m[1], local: m[1], kind: null }], line);
  }

  // The tagged ones: an export whose own definition carries @shared.
  const taggedAt = new Map([...defs.values()].filter((d) => d.shared).map((d) => [d.line, d.shared]));
  const shared = exports
    .filter((e) => taggedAt.has(e.line))
    .map((e) => ({ name: e.name, line: e.line, purpose: taggedAt.get(e.line) }))
    .sort((a, b) => a.line - b.line);
  const tagged = new Set(shared.map((s) => s.line));
  for (const [name, d] of defs)
    if (d.shared && !tagged.has(d.line)) problems.push(`@shared on ${name} (line ${d.line}), but ${name} is not exported`);
  for (const d of docs)
    if (!used.has(d) && readDoc(d.text).shared != null) problems.push(`@shared at line ${d.start + 1} is not right above a definition`);
  return { exports, shared, problems };
}

// ---- the index and the cache ----------------------------------------------------------------------------------------

const emptyIndex = () => ({ version: VERSION, built: null, files: {} });

const validExport = (x) => isObject(x) && typeof x.name === 'string' && Number.isInteger(x.line) && typeof x.kind === 'string';
const validShared = (x) => isObject(x) && typeof x.name === 'string' && Number.isInteger(x.line) && typeof x.purpose === 'string';

/** The cache file's text read into an index; anything broken reads as empty (it is only a cache). */
function parseIndex(source) {
  try {
    const j = JSON.parse(String(source));
    if (!isObject(j) || j.version !== VERSION || !isObject(j.files)) return emptyIndex();
    const files = {};
    for (const [p, e] of Object.entries(j.files)) {
      if (!isObject(e) || typeof e.sha !== 'string' || !Array.isArray(e.exports) || !Array.isArray(e.shared)) continue;
      files[p] = {
        sha: e.sha,
        exports: e.exports.filter(validExport),
        shared: e.shared.filter(validShared),
        problems: Array.isArray(e.problems) ? e.problems.filter((x) => typeof x === 'string') : [],
      };
    }
    return { version: VERSION, built: typeof j.built === 'string' ? j.built : null, files };
  } catch {
    return emptyIndex();
  }
}

/**
 * The index for a tree: `entries` are its files with their blob sha, `read(path)` gives a file's text (null = gone).
 * An entry whose sha the cache already has (at any path) is not read.
 * @returns {{ index: object, stats: { files: number, scanned: number, reused: number, skipped: number, exports: number,
 *   shared: number, problems: number } }}
 */
function build({ entries, read, cache = null, now = new Date().toISOString() }) {
  const old = isObject(cache?.files) ? cache.files : {};
  const bySha = new Map();
  for (const e of Object.values(old)) if (isObject(e) && typeof e.sha === 'string') bySha.set(e.sha, e);
  const files = {};
  const stats = { files: 0, scanned: 0, reused: 0, skipped: 0, exports: 0, shared: 0, problems: 0 };
  for (const { path: p, sha } of entries ?? []) {
    if (!isIndexed(p) || typeof sha !== 'string') continue;
    const hit = old[p]?.sha === sha ? old[p] : bySha.get(sha);
    let entry;
    if (hit) {
      entry = { sha, exports: hit.exports, shared: hit.shared, problems: hit.problems ?? [] };
      stats.reused++;
    } else {
      const text = read(p);
      if (text == null) {
        stats.skipped++;
        continue;
      }
      if (String(text).length > MAX_BYTES) {
        entry = { sha, exports: [], shared: [], problems: [`over ${MAX_BYTES / 1024} KB, not read`] };
        stats.skipped++;
      } else {
        const r = scanSource(text);
        entry = { sha, exports: r.exports, shared: r.shared, problems: r.problems };
        stats.scanned++;
      }
    }
    files[p] = entry;
    stats.files++;
    stats.exports += entry.exports.length;
    stats.shared += entry.shared.length;
    stats.problems += entry.problems.length;
  }
  return { index: { version: VERSION, built: now, files }, stats };
}

/** The tagged building blocks of an index: [{ purpose, symbol, file, line }], by file and line. */
function sharedRows(index) {
  const out = [];
  for (const [file, e] of Object.entries(index?.files ?? {}))
    for (const s of e.shared ?? []) out.push({ purpose: clean(s.purpose), symbol: s.name, file, line: s.line });
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

// ---- the tree (I/O) -------------------------------------------------------------------------------------------------

const gitIn = (root) => (args) =>
  execFileSync('git', ['-C', root, '-c', 'core.quotepath=off', ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });

/**
 * The indexed files of a tree with their blob sha: git's for a tracked file, computed from the disk for a changed or
 * untracked one (not ignored). null when git cannot list the tree.
 */
function listTree(root, { git = gitIn(root), fsLike = fs } = {}) {
  let staged;
  let changed;
  try {
    staged = git(['ls-files', '-s', '-z']);
    changed = git(['ls-files', '-m', '-o', '--exclude-standard', '-z']);
  } catch {
    return null;
  }
  const map = new Map();
  for (const rec of String(staged).split('\0')) {
    const m = rec.match(/^(\d+) ([0-9a-f]{40,64}) \d\t(.+)$/);
    if (m && (m[1] === '100644' || m[1] === '100755') && isIndexed(m[3])) map.set(m[3], m[2]);
  }
  for (const p of String(changed).split('\0').filter(Boolean)) {
    if (!isIndexed(p)) continue;
    try {
      map.set(p, blobSha(fsLike.readFileSync(path.join(root, ...p.split('/')))));
    } catch {
      map.delete(p); // deleted on the disk
    }
  }
  return [...map.entries()].slice(0, MAX_FILES).map(([p, sha]) => ({ path: p, sha }));
}

/** The cache as it is on disk (empty when missing or broken). */
function readCache(dataFolder, fsLike = fs) {
  try {
    return parseIndex(fsLike.readFileSync(path.join(dataFolder, FILE), 'utf8'));
  } catch {
    return emptyIndex();
  }
}

const memo = new Map(); // root -> { at, value }: one build per tree for a short while (fill makes many missions)
const MEMO_MS = 10_000;

/**
 * Builds (or refreshes) the index for a tree and writes the cache. Never throws: null when git cannot list the tree.
 * @param {string} root the tree
 * @param {{ dataFolder: string, fsLike?: typeof fs, git?: Function, fresh?: boolean }} o fresh: skip the short memo
 * @returns {{ index: object, stats: object } | null}
 */
function refresh(root, { dataFolder, fsLike = fs, git, fresh = false } = {}) {
  try {
    const key = `${path.resolve(root)}|${dataFolder}`;
    const seen = memo.get(key);
    if (!fresh && seen && Date.now() - seen.at < MEMO_MS) return seen.value;
    const entries = listTree(root, { git: git ?? gitIn(root), fsLike });
    if (!entries) return null;
    const cache = dataFolder ? readCache(dataFolder, fsLike) : emptyIndex();
    const read = (p) => {
      try {
        return fsLike.readFileSync(path.join(root, ...p.split('/')), 'utf8');
      } catch {
        return null;
      }
    };
    const value = build({ entries, read, cache });
    if (dataFolder) {
      try {
        fsLike.mkdirSync(dataFolder, { recursive: true });
        const file = path.join(dataFolder, FILE);
        const tmp = `${file}.${process.pid}.tmp`;
        fsLike.writeFileSync(tmp, `${JSON.stringify(value.index)}\n`);
        fsLike.renameSync(tmp, file);
      } catch {
        // error-ignored: the cache only saves work; the index in hand is complete
      }
    }
    memo.set(key, { at: Date.now(), value });
    return value;
  } catch {
    // error-ignored: the index is guidance; nothing waits on it
    return null;
  }
}

// ---- find -----------------------------------------------------------------------------------------------------------

/** The words of a name: camelCase, PascalCase, snake_case and kebab-case split, lower case. */
function splitWords(name) {
  return String(name ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

const KIND_ORDER = ['shared', 'reuse', 'decision', 'prefer', 'export'];
const KIND_BONUS = { shared: 15, reuse: 15, decision: 10, prefer: 10, export: 0 };

/** Every row find can show, from the index and the catalog. */
function candidates(index, catalog, ledger) {
  const out = [];
  for (const [file, e] of Object.entries(index?.files ?? {})) {
    const tagged = new Set((e.shared ?? []).map((s) => s.name));
    for (const s of e.shared ?? []) out.push({ kind: 'shared', name: s.name, file, line: s.line, text: clean(s.purpose) });
    for (const x of e.exports ?? [])
      if (!tagged.has(x.name)) out.push({ kind: 'export', name: x.name, file, line: x.line, text: clean(x.doc ?? '', DOC_MAX) });
  }
  for (const r of catalog?.reuse?.rows ?? []) out.push({ kind: 'reuse', name: r.symbol, file: r.file, line: null, text: r.purpose });
  const C = require('./catalog.js');
  for (const x of catalog?.decisions ?? []) {
    const d = x?.decision;
    if (!d?.id) continue;
    const status = ledger ? C.effectiveStatus(d, ledger) : d.status;
    out.push({ kind: 'decision', name: d.id, file: d.file ?? null, line: null, status, text: `${d.title ?? ''}: ${d.invariant ?? ''}` });
  }
  for (const p of catalog?.stack?.prefer ?? []) out.push({ kind: 'prefer', name: p.purpose, file: null, line: null, text: p.use });
  return out;
}

/** The score of a row for all the words (0 = a word does not match). A name hit counts more than a text hit. */
function score(c, words) {
  const lower = c.name.toLowerCase();
  const nameWords = splitWords(c.name);
  const rest = `${c.text ?? ''} ${c.file ?? ''}`.toLowerCase();
  let total = 0;
  for (const w of words) {
    let s = 0;
    if (lower === w) s = 100;
    else if (nameWords.includes(w)) s = 60;
    else if (nameWords.some((x) => x.startsWith(w))) s = 45;
    else if (lower.includes(w)) s = 40;
    else if (rest.includes(w)) s = 20;
    if (!s) return 0;
    total += s;
  }
  return total + KIND_BONUS[c.kind];
}

/**
 * Search the index, the reuse rows, the design choices and the prefer lines. Every word must match.
 * @returns {{ rows: object[], total: number }}
 */
function search({ index = null, catalog = null, query = '', max = FIND_MAX, ledger = null } = {}) {
  const words = String(query ?? '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return { rows: [], total: 0 };
  const hits = candidates(index, catalog, ledger)
    .map((c) => ({ ...c, score: score(c, words) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.name.localeCompare(b.name));
  return { rows: hits.slice(0, max), total: hits.length };
}

const LINE_MAX = 160;
const cut = (s) => (s.length > LINE_MAX ? `${s.slice(0, LINE_MAX - 3)}...` : s);

/** find's short text: a heading, one line per row, and how many more. */
function findLines({ rows, total }, { query = '', index = null } = {}) {
  if (!total) return [`Nothing matches ${query} in the code index or the catalog.`];
  const files = Object.keys(index?.files ?? {}).length;
  const tagged = sharedRows(index).length;
  const where = index ? `index: ${files} code files, ${tagged} tagged @shared` : 'no code index';
  const out = [`catalog find ${query}: ${total} hit${total === 1 ? '' : 's'}${total > rows.length ? `, the first ${rows.length}` : ''} (${where}):`];
  for (const r of rows) {
    if (r.kind === 'decision') out.push(cut(`  decision ${r.name} (${r.status ?? '?'})  ${r.text}`));
    else if (r.kind === 'prefer') out.push(cut(`  prefer   ${r.name}: ${r.text}`));
    else {
      const at = r.line ? `${r.file}:${r.line}` : r.file;
      out.push(cut(`  ${r.kind.padEnd(8)} ${r.name.padEnd(15)} ${at.padEnd(15)} ${r.text ?? ''}`.trimEnd()));
    }
  }
  if (total > rows.length) out.push(`  and ${total - rows.length} more; add a word to narrow it.`);
  return out;
}

// ---- V1b: near names ------------------------------------------------------------------------------------------------

/** The edit distance of two strings, or limit + 1 once it is over the limit. */
function distance(a, b, limit = 2) {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let low = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      low = Math.min(low, cur[j]);
    }
    if (low > limit) return limit + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Why two different names are near, or null: the same words in another order or style (normPath, pathNorm), or one
 * small edit in one word with the same first word (readFile, readFiles). A different first word never counts, so a verb
 * pair (getUser, setUser) is no hit. A one-word name needs 8 characters and one edit.
 */
function nearWhy(a, aw, b, bw) {
  if (aw.length >= 2 && aw.length === bw.length && [...aw].sort().join(' ') === [...bw].sort().join(' ')) return 'the same words';
  if (aw.length !== bw.length || (aw.length > 1 && aw[0] !== bw[0])) return null;
  if (aw.length === 1) return a.length >= 8 && b.length >= 8 && distance(a.toLowerCase(), b.toLowerCase(), 1) <= 1 ? 'one edit' : null;
  if (a.length < 6 || b.length < 6) return null;
  if (aw.filter((w, i) => w !== bw[i]).length !== 1) return null;
  return distance(a.toLowerCase(), b.toLowerCase(), 2) <= 2 ? 'one small edit' : null;
}

/**
 * V1b: the delivery's new names that are near a name the index exports in another file. The same name is the reuse
 * note's job (lib/scopeNotes.js, V1), so it is skipped. One hit per new name, at most `max`.
 * @param {{ name: string, file: string }[]} newNames lib/scopeNotes.js newNames
 * @returns {{ name: string, file: string, other: string, otherFile: string, line: number, why: string }[]}
 */
function nearNames(newNames, index, { max = NEAR_MAX } = {}) {
  if (!index?.files) return [];
  const known = [];
  for (const [file, e] of Object.entries(index.files)) for (const x of e.exports ?? []) known.push({ ...x, file, words: splitWords(x.name) });
  known.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  const out = [];
  for (const n of newNames ?? []) {
    if (out.length >= max) break;
    const words = splitWords(n.name);
    let best = null;
    for (const k of known) {
      if (k.name === n.name || k.file === n.file) continue;
      const why = nearWhy(n.name, words, k.name, k.words);
      if (why && (!best || (why === 'the same words' && best.why !== 'the same words'))) best = { ...k, why };
    }
    if (best) out.push({ name: n.name, file: n.file, other: best.name, otherFile: best.file, line: best.line, why: best.why });
  }
  return out;
}

module.exports = {
  FILE,
  MAX_BYTES,
  isIndexed,
  blobSha,
  clean,
  lex,
  scanSource,
  parseIndex,
  build,
  sharedRows,
  listTree,
  readCache,
  refresh,
  splitWords,
  search,
  findLines,
  nearNames,
};
