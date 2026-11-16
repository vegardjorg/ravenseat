// =============================================================
// findingLog.js: the finding log, one row per finding from every source, append-only (step 2 of the finding format
// contract, plans/funnformat-0i-0j-2026-11-15.md section 5).
//
// Why: what review, the gates, CI and the secret scan catch was spread over task fields, reports and the time log, and
// a finding that was deferred was easy to lose for good. Counting what comes back (the same class in the same area) and
// how many deferred findings are actually fixed needs one place with one row form, whatever the source. This file is
// that place as a library only: no command and no output to the user. The writers are review-item (step 3) and the
// other sources through lib/findingSources.js (step 4).
//
// THE FILE: <dataFolder>/findings.jsonl (the contract calls it feillogg.jsonl; the code uses an English name). The data
// folder is ignored by git by default (setup), so the log never lands in a tracked place. One JSON object per line.
// Monthly archive exactly as the time log (lib/timeLogArchive.js): findings.jsonl -> findings-2026-10.jsonl on the first
// write of a new UTC month.
//
// THE ROW (makeRow): every field of section 5, validated. A row is either whole or refused with an error: an unknown
// caught_by, a missing severity, class or excerpt, or a field the source cannot fill (item and round only from review,
// signature only from gate and CI) throws, so a half row is never written. Derived, never taken from the input:
//   - `id` F-<n>, sequential across the archives, given by append under a lock (makeRow takes `seq` for a known n);
//   - `time` UTC to the second;
//   - `counts` false for L and for the class `other`;
//   - `status` 'fixed-without-test' when the row names a fix (`fix`, lib/fixTests.js) and its red on base verdict
//     (`test_added: { verdict, files }`) is no-tests or unproven (step 6); the repeat count reads it, and counts it twice;
//   - `where.area`: the module whose path prefix holds the files (a list passed in), else the common folder of the files;
//   - `excerpt`: agent text is data, so code blocks become [code], secrets are masked (askBundle.redact, then every
//     word and the whole line checked with secretScan.matchLine), and the text is one line of at most 200 characters.
// The class arrives as an id and is normalized by a function passed in (the taxonomy, lib/failureClasses.js), or by
// that module when it is there, else by normalizeClassFallback: kebab-case is kept, anything else is `other`.
//
// THE RULE CLASS (step 5): append first asks lib/failureRules.js for a class from the rule register (a red tsc is
// contract-drift, a secret hit secret-leak), with class_source `rule`, unless the agent gave a class of its own. The
// source's hints for it (`rule_hints`: an event, the command, the review signals) are read there and never stored.
// makeRow stays pure and does not classify.
//
// CONCURRENT WRITERS: append takes a lock folder next to the file (<file>.lock, lib/queueLock.js), reads the highest id,
// and appends one whole line with O_APPEND (timeLogArchive.appendText, which also rotates). The lock makes the ids
// unique; the single write per row keeps lines whole.
//
// FOLLOW-UPS (setFixedBy): old lines are never rewritten. A later fact (the commit that fixed a deferred finding) is a
// follow-up row { update: 'fixed_by', item, fixed_by, time }, and read merges the latest follow-up per item (the review
// item key, or the row id for sources without one) into the row.
//
// READING (read): the current file, or the archives too with includeArchive. A line that is not JSON or not a row is
// skipped and named in `warnings`; the reader never throws on the file's content. No file yet = no rows.
//
// Tested in lib/__tests__/findingLog.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const TA = require('./timeLogArchive.js');
const { checkPath } = require('./wiringItems.js');
const { matchLine } = require('./secretScan.js');
const { redact } = require('./askBundle.js');

/** The file name inside the data folder. */
const FILE_NAME = 'findings.jsonl';
/** The longest excerpt kept (as the FINDING line and failureSignature). */
const EXCERPT_MAX = 200;
/** How long append waits for another writer's lock before it gives up with an error. */
const LOCK_WAIT_MS = 15_000;

/** The sources (section 5). `review:<type>` is the review form; the rest are fixed names. */
const SOURCES = Object.freeze([
  'gate',
  'ci',
  'base-gate',
  'done-check',
  'red-on-base',
  'secret-scan',
  'gate-line',
  'finding',
  'qa',
  'owner',
  'post-merge',
  'test-weakening',
]);
/** The sources that have a failure signature (lib/failureSignature.js): the gates and CI. */
const SIGNATURE_SOURCES = Object.freeze(['gate', 'ci', 'base-gate']);
const SEVERITIES = Object.freeze(['H', 'M', 'L']);
const CLASS_SOURCES = Object.freeze(['agent', 'rule', 'signal']);
const CONFIDENCES = Object.freeze(['high', 'low']);
const DISPOSITION_KINDS = Object.freeze(['fixed', 'task', 'batch', 'rejected']);
/** The reason codes of a `rejected` disposition (section 3). */
const REJECT_REASONS = Object.freeze(['false-positive', 'pre-existing', 'duplicate', 'wont-fix']);
/** The red on base verdicts test_added may carry (lib/redOnBase.js verdict, plus `error` when it was not checked). */
const TEST_VERDICTS = Object.freeze(['proven', 'unproven', 'no-tests', 'tip-red', 'tests-only', 'error']);
/** The kinds of fix a row may name (lib/fixTests.js FIX_KINDS; kept here so this file needs no other module). */
const FIX_KINDS = Object.freeze(['qa', 'base-fix', 'fixes', 'finding', 'gate-line']);
/** The verdicts that make a fix "fixed without test" (lib/fixTests.js UNTESTED). */
const UNTESTED = Object.freeze(['no-tests', 'unproven']);
/** The status a fix without a proven red test gets: the repeat count (step 7) counts such a row twice. */
const FIXED_WITHOUT_TEST = 'fixed-without-test';

const REVIEW = /^review:([a-z0-9][a-z0-9-]{0,59})$/;
const KEBAB = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ID = /^F-([1-9][0-9]*)$/;
const SHA = /^[0-9a-f]{7,40}$/;
/** A task id or a review item key: printable, no spaces, short. */
const TOKEN = /^[\p{L}\p{N}._:#@/+-]{1,120}$/u;

/** A validation error that names the field. */
function fail(field, why) {
  const e = new Error(`finding row: ${field} ${why}`);
  e.field = field;
  return e;
}

/** One line of printable text: control characters out, white space collapsed (as wiringItems.plain). */
function oneLine(text) {
  return (
    String(text ?? '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

/**
 * The excerpt as it may be stored: no code, no secret, one line, at most EXCERPT_MAX characters (see the header).
 * Code is a fenced block or an inline span longer than 40 characters (a short `name` in backticks is prose).
 */
function cleanExcerpt(text) {
  let s = String(text ?? '')
    .replace(/```[\s\S]*?(?:```|$)/g, ' [code] ')
    .replace(/`[^`\n]{41,}`/g, '[code]');
  s = oneLine(redact(s).text);
  // Every word on its own (a key the redact patterns do not know but matchLine does), then the whole line once more.
  s = s
    .split(' ')
    .map((w) => {
      const rule = w ? matchLine(w) : null;
      return rule ? `[REDACTED:${rule}]` : w;
    })
    .join(' ');
  const rule = matchLine(s);
  if (rule) s = `[REDACTED:${rule}] (excerpt withheld)`;
  return s.length > EXCERPT_MAX ? `${s.slice(0, EXCERPT_MAX - 1).trim()}…` : s;
}

/** The fallback class normalizer: a kebab-case id is kept, anything else (also '-' and nothing) is `other`. */
function normalizeClassFallback(id) {
  const s = String(id ?? '').trim();
  return KEBAB.test(s) && s.length <= 60 ? s : 'other';
}

/**
 * The taxonomy's normalizer when lib/failureClasses.js is there (built by another step), else null. Looked up once.
 * It is used only when it exports a function named normalizeClass or normalize.
 */
let taxonomyNormalizer;
function taxonomyNormalize() {
  if (taxonomyNormalizer !== undefined) return taxonomyNormalizer;
  taxonomyNormalizer = null;
  try {
    const mod = require('./failureClasses.js');
    const fn = mod?.normalizeClass ?? mod?.normalize;
    if (typeof fn === 'function') taxonomyNormalizer = fn;
  } catch {
    /* not there yet: the fallback */
  }
  return taxonomyNormalizer;
}

/** UTC to the second: '2026-11-16T10:02:11Z'. Throws on a time that cannot be read. */
function utc(t) {
  const ms = t instanceof Date ? t.getTime() : typeof t === 'number' ? t : Date.parse(String(t));
  if (!Number.isFinite(ms)) throw fail('time', 'is not a time');
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The files as repo paths: '-' or nothing is none, a path that is not a plain repo path is dropped (agent text). */
function filesOf(raw) {
  const list = raw == null || raw === '-' ? [] : Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const f of list) {
    const c = checkPath(f);
    if ('file' in c && !out.includes(c.file)) out.push(c.file);
  }
  return out.slice(0, 20);
}

/**
 * The area: the module whose path prefix holds every file (the longest prefix wins), else the folder all the files share
 * ('.' for files at the root). null without files.
 * @param {string[]} files
 * @param {{ id: string, paths: string[] }[]} [modules]
 */
function areaOf(files, modules = []) {
  if (!files.length) return null;
  let best = null;
  for (const m of Array.isArray(modules) ? modules : []) {
    for (const raw of Array.isArray(m?.paths) ? m.paths : []) {
      const p = String(raw ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
      if (!p) continue;
      const prefix = p.endsWith('/') ? p : `${p}/`;
      if (files.every((f) => f.startsWith(prefix) || f === p) && (!best || prefix.length > best.len)) {
        best = { id: String(m.id), len: prefix.length };
      }
    }
  }
  if (best) return best.id;
  const dirs = files.map((f) => f.split('/').slice(0, -1));
  const common = [];
  for (let i = 0; dirs.every((d) => i < d.length && d[i] === dirs[0][i]); i++) common.push(dirs[0][i]);
  return common.length ? common.join('/') : '.';
}

/** An optional short token (task id, item key), or null. */
function token(field, v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (!TOKEN.test(s)) throw fail(field, 'is not a short id without spaces');
  return s;
}

/** An optional sha, lower case, or null. */
function sha(field, v) {
  if (v == null || v === '') return null;
  const s = String(v).trim().toLowerCase();
  if (!SHA.test(s)) throw fail(field, 'is not a commit sha (7-40 hex)');
  return s;
}

/** An optional value from a fixed list, or the default. */
function oneOf(field, v, list, dflt) {
  if (v == null || v === '') return dflt;
  if (!list.includes(v)) throw fail(field, `must be one of ${list.join(', ')}`);
  return v;
}

/**
 * test_added as stored: { verdict, files }, the red on base verdict and the test paths. A path or a list of paths alone
 * (no verdict) is still read as { verdict: null, files }, so a caller from before step 6 is not refused.
 */
function testAddedOf(v) {
  if (v == null) return null;
  if (typeof v === 'string' || Array.isArray(v)) return { verdict: null, files: filesOf(v) };
  if (typeof v !== 'object') throw fail('test_added', 'must be { verdict, files } or a path');
  const verdict = oneOf('test_added', v.verdict, TEST_VERDICTS, null);
  return { verdict, files: filesOf(v.files) };
}

function disposition(v) {
  if (v == null) return null;
  if (typeof v !== 'object' || !DISPOSITION_KINDS.includes(v.kind)) {
    throw fail('disposition', `needs a kind of ${DISPOSITION_KINDS.join(', ')}`);
  }
  const ref = oneLine(v.ref).slice(0, 120);
  if (!ref) throw fail('disposition', 'needs a ref');
  if (v.kind === 'rejected' && !REJECT_REASONS.includes(ref)) {
    throw fail('disposition', `of kind rejected needs a ref of ${REJECT_REASONS.join(', ')}`);
  }
  const out = { kind: v.kind, ref };
  if (v.note != null && oneLine(v.note)) out.note = cleanExcerpt(v.note);
  return out;
}

/**
 * Builds and validates one row (see THE ROW in the header). Throws an Error naming the field on anything invalid.
 * @param {object} input  class, caught_by, severity, excerpt (required); files, line, task, round, item, cause_task,
 *   signature, disposition, fixed_by, test_added, fix, guard, class_source, confidence, time, id (optional)
 * @param {{ now?: number, seq?: number, normalizeClass?: (id: string) => string,
 *   modules?: { id: string, paths: string[] }[] }} [o]
 */
function makeRow(input, { now = Date.now(), seq, normalizeClass, modules } = {}) {
  const x = input && typeof input === 'object' ? input : {};

  let id = null;
  if (seq != null) {
    if (!Number.isInteger(seq) || seq < 1) throw fail('id', 'needs a positive whole seq');
    id = `F-${seq}`;
  } else if (x.id != null) {
    if (!ID.test(String(x.id))) throw fail('id', 'must be F-<n>');
    id = String(x.id);
  }

  const caughtBy = String(x.caught_by ?? '');
  const isReview = REVIEW.test(caughtBy);
  if (!isReview && !SOURCES.includes(caughtBy)) {
    throw fail('caught_by', `must be review:<type> or one of ${SOURCES.join(', ')}`);
  }
  if (!SEVERITIES.includes(x.severity)) throw fail('severity', 'must be H, M or L');
  if (x.class == null || x.class === '') throw fail('class', "is required (an id from the taxonomy, or '-')");

  const norm = normalizeClass ?? taxonomyNormalize() ?? normalizeClassFallback;
  let cls = 'other';
  if (x.class !== '-') {
    try {
      cls = normalizeClassFallback(norm(String(x.class)));
    } catch {
      cls = 'other';
    }
  }

  const excerpt = cleanExcerpt(x.excerpt);
  if (!excerpt) throw fail('excerpt', 'is required (one sentence)');

  const files = filesOf(x.files ?? x.file);
  let line = null;
  if (x.line != null && x.line !== '') {
    line = Number(x.line);
    if (!Number.isInteger(line) || line < 1) throw fail('line', 'must be a positive whole number');
  }

  let round = null;
  if (x.round != null) {
    if (!isReview) throw fail('round', 'is filled only from review');
    round = Number(x.round);
    if (!Number.isInteger(round) || round < 1) throw fail('round', 'must be a positive whole number');
  }
  const item = token('item', x.item);
  if (item && !isReview) throw fail('item', 'is filled only from review');
  const signature = x.signature == null || x.signature === '' ? null : oneLine(x.signature).slice(0, 64);
  if (signature && !SIGNATURE_SOURCES.includes(caughtBy)) throw fail('signature', 'is filled only from gate and CI');
  const testAdded = testAddedOf(x.test_added);
  const fix = oneOf('fix', x.fix, FIX_KINDS, null);

  return {
    id,
    time: utc(x.time ?? now),
    class: cls,
    class_source: oneOf('class_source', x.class_source, CLASS_SOURCES, isReview ? 'agent' : 'signal'),
    confidence: oneOf('confidence', x.confidence, CONFIDENCES, 'high'),
    where: { files, line, area: areaOf(files, modules) },
    caught_by: caughtBy,
    severity: x.severity,
    task: token('task', x.task),
    round,
    item,
    cause_task: token('cause_task', x.cause_task),
    signature,
    excerpt,
    disposition: disposition(x.disposition),
    fixed_by: sha('fixed_by', x.fixed_by),
    test_added: testAdded,
    fix,
    // Derived only (step 6): a fix whose red on base verdict shows nothing. Never taken from the input, so a source cannot
    // mark a row it has no verdict for.
    status: fix && testAdded && UNTESTED.includes(testAdded.verdict) ? FIXED_WITHOUT_TEST : null,
    guard: x.guard == null ? null : oneLine(x.guard).slice(0, 120) || null,
    // Derived only (section 5): L and `other` are logged but never count toward a repeat suggestion alone.
    counts: x.severity !== 'L' && cls !== 'other',
  };
}

/**
 * The log file. With a root: <root>/<dataFolder setting of that root>/findings.jsonl. Without: the current project's data
 * folder (queueConfig.dataFolder, QUEUE_FOLDER overrides).
 */
function fileOf(root) {
  const QC = require('./queueConfig.js');
  if (root == null) return path.join(QC.dataFolder(), FILE_NAME);
  return path.join(root, QC.config({ root }).dataFolder, FILE_NAME);
}

/** The files to read, oldest first: the archives (when asked, and not ended before `sinceMs`), then the current one. */
function filesToRead(file, { includeArchive, sinceMs }) {
  const list = includeArchive
    ? TA.archives(file)
        .filter((a) => sinceMs == null || a.endMs >= sinceMs)
        .map((a) => a.file)
    : [];
  return [...list, file];
}

/** Parses one file's lines into rows and follow-ups; a bad line becomes a warning. */
function parseFile(file, out) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return; // not there (yet), or moved by a rotation while listing
  }
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (!l) continue;
    let v;
    try {
      v = JSON.parse(l);
    } catch {
      out.warnings.push(`${path.basename(file)} line ${i + 1}: not JSON, skipped`);
      continue;
    }
    if (v && typeof v === 'object' && !Array.isArray(v) && v.update === 'fixed_by' && typeof v.item === 'string') {
      out.updates.push(v);
    } else if (v && typeof v === 'object' && !Array.isArray(v) && ID.test(String(v.id)) && typeof v.caught_by === 'string') {
      out.rows.push(v);
    } else {
      out.warnings.push(`${path.basename(file)} line ${i + 1}: not a finding row, skipped`);
    }
  }
}

/**
 * The rows with the latest follow-up merged in, oldest first, and the warnings for skipped lines. Never throws on the
 * file's content.
 * @param {string} [root]  the project root (see fileOf)
 * @param {{ since?: number|string|null, includeArchive?: boolean }} [o]
 * @returns {{ rows: object[], warnings: string[] }}
 */
function read(root, { since = null, includeArchive = false } = {}) {
  const file = fileOf(root);
  const sinceMs = since == null ? null : typeof since === 'number' ? since : Date.parse(String(since));
  const out = { rows: [], updates: [], warnings: [] };
  for (const f of filesToRead(file, { includeArchive, sinceMs: Number.isFinite(sinceMs) ? sinceMs : null })) {
    parseFile(f, out);
  }
  // The latest follow-up per key wins (the file order is the write order).
  const latest = new Map();
  for (const u of out.updates) latest.set(u.item, u);
  const rows = out.rows
    .filter((r) => sinceMs == null || !Number.isFinite(sinceMs) || Date.parse(r.time) >= sinceMs)
    .map((r) => {
      const u = (r.item != null && latest.get(r.item)) || latest.get(r.id);
      return u ? { ...r, fixed_by: u.fixed_by } : r;
    });
  return { rows, warnings: out.warnings };
}

/** The highest id in the log: the newest file with a row holds it (ids only grow). 0 for none. */
function highestId(file) {
  const files = [file, ...TA.archives(file).map((a) => a.file).reverse()];
  for (const f of files) {
    const out = { rows: [], updates: [], warnings: [] };
    parseFile(f, out);
    if (out.rows.length) return Math.max(...out.rows.map((r) => Number(ID.exec(r.id)[1])));
  }
  return 0;
}

/** Runs fn under the writers' lock next to the file. Throws when the lock cannot be had in time. */
function withLock(file, fn, waitMs = LOCK_WAIT_MS) {
  const QL = require('./queueLock.js');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  const got = QL.acquire(lock, { waitMs });
  if (!got.ok) throw new Error(`finding log: another writer holds ${path.basename(lock)}; try again`);
  try {
    return fn();
  } finally {
    QL.release(lock, got.me);
  }
}

/**
 * Validates the row (makeRow), gives it the next id and appends it as one line. Creates the file on the first write.
 * Throws on an invalid row (nothing is written) or a write error.
 * @param {string} [root]  the project root (see fileOf)
 * @param {object} input  the row's fields (makeRow)
 * @param {{ now?: number, normalizeClass?: Function, modules?: object[], waitMs?: number, rules?: boolean }} [o]
 * @returns {object} the row as written
 */
function append(root, input, o = {}) {
  const file = fileOf(root);
  // The rule class (lib/failureRules.js) when the row is made: this is the one place every source writes through, so the
  // register applies to all of them alike. It never throws; `rules: false` skips it. The project's classes come back with
  // it, so a project's own class from its own rule is not cut to `other` by the core list.
  let x = input;
  let opts = o;
  if (o.rules !== false) {
    const ruled = require('./failureRules.js').applyRules(root, input);
    x = ruled.input;
    if (!o.normalizeClass && ruled.classes) {
      const FC = require('./failureClasses.js');
      opts = { ...o, normalizeClass: (id) => FC.normalizeClass(id, ruled.classes) };
    }
  }
  // Validate before the lock: an invalid row neither waits nor writes. The id is the only field set under the lock.
  const row = makeRow({ ...x, id: undefined }, opts);
  return withLock(
    file,
    () => {
      const written = { ...row, id: `F-${highestId(file) + 1}` };
      TA.appendText(file, `${JSON.stringify(written)}\n`, { now: o.now ?? Date.now(), mode: 'monthly' });
      return written;
    },
    o.waitMs,
  );
}

/**
 * Records the commit that fixed a finding as a follow-up row (old lines are never rewritten; read merges it).
 * @param {string} [root]
 * @param {string} item  the review item key (reviewer-security#2:M1), or the row id (F-118) for a source without one
 * @param {string} commit  the sha
 * @param {{ now?: number, waitMs?: number }} [o]
 */
function setFixedBy(root, item, commit, o = {}) {
  const key = String(item ?? '').trim();
  if (!key || !TOKEN.test(key)) throw fail('item', 'is required (an item key or a row id)');
  const fixedBy = sha('sha', commit);
  if (!fixedBy) throw fail('sha', 'is required');
  const file = fileOf(root);
  const row = { update: 'fixed_by', item: key, fixed_by: fixedBy, time: utc(o.now ?? Date.now()) };
  withLock(file, () => TA.appendText(file, `${JSON.stringify(row)}\n`, { now: o.now ?? Date.now(), mode: 'monthly' }), o.waitMs);
  return row;
}

/** Groups rows by a key: { [key]: { total, counts, rows } } (counts = the rows with counts true). */
function groupBy(rows, keyOf) {
  const out = {};
  for (const r of Array.isArray(rows) ? rows : []) {
    const k = keyOf(r);
    const g = (out[k] ??= { total: 0, counts: 0, rows: [] });
    g.total += 1;
    if (r.counts === true) g.counts += 1;
    g.rows.push(r);
  }
  return out;
}

/** The rows per class. */
const byClass = (rows) => groupBy(rows, (r) => r?.class ?? 'other');
/** The rows per area ('-' for rows without files). */
const byArea = (rows) => groupBy(rows, (r) => r?.where?.area ?? '-');

module.exports = {
  FILE_NAME,
  EXCERPT_MAX,
  SOURCES,
  SIGNATURE_SOURCES,
  REJECT_REASONS,
  TEST_VERDICTS,
  FIXED_WITHOUT_TEST,
  normalizeClassFallback,
  cleanExcerpt,
  areaOf,
  makeRow,
  fileOf,
  read,
  append,
  setFixedBy,
  byClass,
  byArea,
};
