// =============================================================
// secretLiterals.js: the values of the project's own secrets, redacted as literals in what Ravenseat stores
// (roadmap 1c SEC-T item 5; SP-1 in plans/sammy-pack-vurdering-2026-11-20.md).
//
// WHY: the redaction before storing (lib/askBundle.js redact, lib/silentSnapshot.js) matches patterns: provider formats,
// JWT, Bearer and a generic name=value rule that needs 16+ characters. A database password, a short self-hosted token
// or a key with no known prefix matches none of them, and a gate tail or a transcript line can print one. The values in
// the project's own .env files are known to be secret, so they are removed as exact text, whatever their shape.
//
// What is read: the .env style files in the MAIN tree's root (.env, .env.local, .env.<anything>; never .env.example,
// .env.sample, .env.template and the like: secretScan.isEnvFile tells them apart). Tracked or ignored, both count: a
// tracked .env is already a doctor FAIL, and its values are no less secret.
// What is kept: each value of 6 characters or more that is not plain: true/false/yes/no, localhost, a number, a port or
// an address, a URL without credentials, a placeholder or reference (${X}, $X, <x>, ***). A URL with a password keeps
// the password too. Sorted longest first, so a value inside a longer one does not leave the rest behind.
//
// THE RULES:
//   - In memory only, per process: never written, never hashed to disk, never logged, never in an error message.
//     Callers get the redacted text and a count, never the list.
//   - Fails open: a file that cannot be read, a config error or anything else gives no values (the pattern redaction
//     still runs); redaction must never stop a write.
//   - Read again after REREAD_MS in a long-lived process (the board), so a changed .env is seen without a restart.
//   - redact.envValues (default true) turns it off. Turning it off is a weakened setting.
//
// Used by: lib/askBundle.js redact (so lib/storeText.js and every route in lib/sinkRegister.js gain it) and
// lib/silentSnapshot.js redactCommand/redactText. Tested in lib/__tests__/secretLiterals.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** What a value is replaced with. Names the rule, never the variable or the value. */
const MARK = '[REDACTED:env-value]';
/** Shorter values are skipped: too many harmless words and ids would match (false hits). */
const MIN_LENGTH = 6;
/** At most this many values and this many bytes per file are read (a .env is small; anything else is not one). */
const MAX_VALUES = 500;
const MAX_FILE_BYTES = 256 * 1024;
/** A long-lived process (the board) reads the files again after this long. */
const REREAD_MS = 60_000;

/** Plain values that are not secrets. */
const PLAIN = /^(true|false|yes|no|on|off|null|none|nil|undefined|localhost|development|production|staging|test|debug|info|warn|warning|error)$/i;

/** The value lines of a .env text: [{ name, value }], quotes and trailing comments removed. */
function parseEnv(text) {
  const out = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(raw);
    if (!m) continue;
    let v = m[2].trim();
    const q = /^(["'`])(.*?)\1/.exec(v);
    if (q) v = q[2];
    else v = v.replace(/\s+#.*$/, '').trim();
    out.push({ name: m[1], value: v });
  }
  return out;
}

/** Is the value worth redacting (long enough, not plain, not a placeholder or a plain URL)? */
function usable(v) {
  const s = String(v ?? '');
  if (s.length < MIN_LENGTH || PLAIN.test(s)) return false;
  if (/^[\d\s.,:+\-/]+$/.test(s)) return false; // a number, a port, an address, a date
  if (require('./commandSecrets.js').isPlaceholder(s)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) && !/^[a-z][a-z0-9+.-]*:\/\/[^\s/@]*:[^\s/@]+@/i.test(s)) return false;
  return true;
}

/** The values of one .env text worth redacting: each usable value, and the password of a URL with credentials. */
function valuesOf(text) {
  const out = [];
  for (const { value } of parseEnv(text)) {
    if (!usable(value)) continue;
    out.push(value);
    const pw = /^[a-z][a-z0-9+.-]*:\/\/[^\s/@:]*:([^\s/@]+)@/i.exec(value);
    if (pw && usable(pw[1])) out.push(pw[1]);
  }
  return out;
}

/** The .env style files in the main tree's root (secretScan.isEnvFile: no example, sample or template files). */
function envFiles(mainTree) {
  const { isEnvFile } = require('./secretScan.js');
  try {
    return fs
      .readdirSync(mainTree, { withFileTypes: true })
      .filter((e) => e.isFile() && /^\.env/i.test(e.name) && isEnvFile(e.name))
      .map((e) => path.join(mainTree, e.name))
      .sort();
  } catch {
    return [];
  }
}

/**
 * The literal values for a main tree, longest first. Read fresh (no cache); never written anywhere.
 * @param {string} mainTree
 * @returns {string[]}
 */
function literalsFor(mainTree) {
  const all = new Set();
  for (const f of envFiles(mainTree)) {
    let text;
    try {
      if (fs.statSync(f).size > MAX_FILE_BYTES) continue;
      text = fs.readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const v of valuesOf(text)) {
      if (all.size >= MAX_VALUES) break;
      all.add(v);
    }
  }
  return [...all].sort((a, b) => b.length - a.length);
}

/** A source set by reset() (tests), else null: the config decides. */
let source = null;
/** The values read last: { tree, list, at }. In memory only. */
let cache = null;

/**
 * The values for this process: the main tree and redact.envValues from config() (or the source reset() set), read
 * once and again after REREAD_MS. Any error gives [] (fails open).
 * @param {{ now?: number }} [o]
 * @returns {string[]}
 */
function current(o = {}) {
  try {
    const now = o.now ?? Date.now();
    let tree;
    let enabled;
    if (source) {
      tree = source.mainTree;
      enabled = source.enabled !== false;
    } else {
      const cfg = require('./queueConfig.js').config();
      tree = cfg.root;
      enabled = cfg?.redact?.envValues !== false;
    }
    if (!enabled || !tree) return [];
    if (cache && cache.tree === tree && now - cache.at < REREAD_MS) return cache.list;
    cache = { tree, list: literalsFor(tree), at: now };
    return cache.list;
  } catch {
    return [];
  }
}

/**
 * `text` with every literal replaced by MARK. Never throws; never returns the values.
 * @param {unknown} text
 * @param {string[]} [list]  the values (default: current())
 * @returns {{ text: string, count: number }}
 */
function redactLiterals(text, list) {
  let s = String(text ?? '');
  let count = 0;
  try {
    // Longest first, also for a list a caller passes (a value inside a longer one must not leave the rest behind).
    const values = list ? [...list].sort((a, b) => b.length - a.length) : current();
    for (const v of values) {
      if (!v || !s.includes(v)) continue;
      const parts = s.split(v);
      count += parts.length - 1;
      s = parts.join(MARK);
    }
  } catch {
    // error-ignored: the pattern redaction after this still runs
  }
  return { text: s, count };
}

/**
 * Drops the cached values. With `{ mainTree, enabled }` the process reads that tree instead of the config's (tests);
 * without, the config decides again.
 * @param {{ mainTree: string, enabled?: boolean }|null} [o]
 */
function reset(o = null) {
  cache = null;
  source = o && typeof o === 'object' ? { mainTree: o.mainTree, enabled: o.enabled } : null;
}

module.exports = { MARK, MIN_LENGTH, REREAD_MS, parseEnv, usable, valuesOf, envFiles, literalsFor, current, redactLiterals, reset };
