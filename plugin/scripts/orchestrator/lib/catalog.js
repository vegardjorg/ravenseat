// =============================================================
// catalog.js: the project catalog in docs/queue/catalog/ (ravenseat catalog init|show|check|accept, cli/catalog.mjs).
//
// WHY: parallel tracks write a helper the project already has, add a second library for a job it already has one for,
// and take an architecture choice nobody asked about. The reuse and scope notes at receive (lib/scopeNotes.js) see that
// after the fact. The catalog is what the tracks should have known before: the stack and what to prefer, the building
// blocks meant for reuse, and the design choices, each with one invariant that can be checked. Bolk B3 of the scope
// drift plan (plans/scope-drift-dry-katalog-2026-11-15.md, owner decision 16.11: hand-written and tracked here, only the
// owner accepts a design choice, the folder is a protected path). The generated index of the code is bolk B5 and lives
// in the data folder, not here; the excerpt in the mission is bolk B4; the check rules (`check:`) are bolk B6, read and
// run by lib/catalogChecks.js (this file checks their shape and examples in parseDecision, and in checkCatalog whether
// a rule already hits lines in the tree).
//
// The folder (all hand-written, tracked in git, a protected path: lib/queueConfig.js STANDARD.protectedPaths):
//   stack.md                 a generated block between BLOCK_BEGIN and BLOCK_END (languages, packs, checks, the libraries
//                            by job, from the manifests; `catalog init` refreshes only the block), then the owner's own
//                            text. Under "## Prefer": one line per job, "- <job>: <what to use>".
//   reuse.md                 a table "| Purpose | Symbol | File |" for building blocks that are not tagged in the code.
//   decisions/D-0001-<slug>.md   one design choice per file, a short frontmatter (FIELDS) and at most BODY_LINES lines.
//                            decisions/README.md is the format note `catalog init` writes; it is skipped.
//
// The owner lock (owner decision 3): status `accepted` counts only when the owner accepted exactly this version, with
// `ravenseat catalog accept <id> --by owner` (or the board, theBoard) from the main tree. The accept writes the status
// lines into the file and a record into <dataFolder>/catalog-accepted.json (gitignored, written by the queue only; the
// write guard keeps queue agents off it, lib/writeGuard.js). The record holds a fingerprint of what binds: id, invariant,
// paths and check. A choice that says accepted without a matching record (a track that edited the line, an invariant
// changed after the accept) reads as `unconfirmed` (effectiveStatus) and is an error in `catalog check`. Like the
// done_when lock (lib/doneCheck.js), the CLI refuses the accept from inside a track worktree whatever --by says.
//
// Pure except readCatalog (it reads the folder; fs can be swapped in tests). Tested in lib/__tests__/catalog.test.ts and
// __tests__/catalogFlow.test.ts (the CLI).
// =============================================================
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** The folder, relative to the project root (also the protected path entry). */
const DIR = 'docs/queue/catalog';
const STATUSES = Object.freeze(['proposed', 'accepted', 'superseded']);
/** The frontmatter fields of a design choice. accepted_by and accepted are written by `catalog accept`. */
const FIELDS = Object.freeze(['id', 'title', 'status', 'paths', 'invariant', 'check', 'supersedes', 'plan', 'accepted_by', 'accepted']);
const ID_PATTERN = /^D-\d{4}$/;
const FILE_PATTERN = /^(D-\d{4})-[a-z0-9][a-z0-9-]*\.md$/;
/** The plan entry id shape (lib/queuePlan.js ID_PATTERN, a looser copy: the register checks its own ids). */
const PLAN_PATTERN = /^PL-[A-Za-z0-9ÆØÅæøå-]+$/;
const TITLE_MAX = 120;
/** One sentence an agent can check against; the only text of a choice a mission gets (bolk B4). */
const INVARIANT_MAX = 300;
/** A design choice stays short; longer is a warning (the plan register holds the long text). */
const BODY_LINES = 30;
/** reuse.md stays a short list; the generated index (bolk B5) holds the rest. */
const REUSE_ROWS = 40;
/** The prefer lines a mission will get (bolk B4); more is a warning. */
const PREFER_LINES = 10;
const OWNER_BY = new Set(['owner', 'theBoard']);
const BLOCK_BEGIN = '<!-- ravenseat:generated begin (ravenseat catalog init writes this block from the manifests; write your own text below it) -->';
const BLOCK_END = '<!-- ravenseat:generated end -->';
const LEDGER_FILE = 'catalog-accepted.json';
/**
 * The defaults for config().catalog (lib/queueConfig.js STANDARD.catalog holds the same values). missionExcerpt and
 * reviewExcerpt: the excerpt in the mission and in the review package (lib/catalogExcerpt.js, bolk B4); excerptTokens:
 * its cap, a whole number from EXCERPT_TOKENS.min to EXCERPT_TOKENS.max. index: the generated index of the code's
 * exports and @shared blocks (lib/catalogIndex.js, bolk B5) is built at receive and when a mission is made, and the
 * excerpt gets the tagged blocks and, for the reviewer, the near names. Off by default (the plan's opt-in list: it
 * builds and stores a file, and its worth depends on the project's size); `catalog find` works either way.
 * checks, checkStop, gateAfter (bolk B6, lib/catalogChecks.js): the check rules are tried on the added lines at receive
 * (checks, on: only the owner writes a rule, and a hit is a line, never a stop); a rule in mode stop of an accepted
 * choice stops the merge only with checkStop on (off: what can stop work is opt-in); a rule broken in gateAfter
 * separate tasks becomes a gate proposal, only with learning.proposals on.
 */
const DEFAULTS = Object.freeze({
  doctor: true,
  planLinks: true,
  missionExcerpt: true,
  reviewExcerpt: true,
  excerptTokens: 1500,
  index: false,
  checks: true,
  checkStop: false,
  gateAfter: 3,
});
/** The range of catalog.excerptTokens: under 200 not even one design choice fits, over 6000 it is no excerpt. */
const EXCERPT_TOKENS = Object.freeze({ min: 200, max: 6000 });
const isTokens = (v) => Number.isInteger(v) && v >= EXCERPT_TOKENS.min && v <= EXCERPT_TOKENS.max;
/** The range of catalog.gateAfter: one task is no repeat; more than 20 never proposes in practice. */
const GATE_AFTER = Object.freeze({ min: 2, max: 20 });
const isGateAfter = (v) => Number.isInteger(v) && v >= GATE_AFTER.min && v <= GATE_AFTER.max;
/** The whole-number settings and their test. */
const WHOLE = Object.freeze({
  excerptTokens: { ok: isTokens, range: EXCERPT_TOKENS },
  gateAfter: { ok: isGateAfter, range: GATE_AFTER },
});

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => typeof v === 'string' && v.trim().length > 0;
const lines = (t) => String(t ?? '').replace(/\r\n/g, '\n').split('\n');

// ---- settings -------------------------------------------------------------------------------------------------------

/** The shape errors in the project's own `catalog` object (doctor's config row). undefined = the defaults. */
function setupProblems(own) {
  if (own === undefined) return [];
  if (!isObject(own)) return ['catalog must be an object'];
  const out = [];
  for (const [k, v] of Object.entries(own)) {
    if (!Object.hasOwn(DEFAULTS, k)) out.push(`catalog.${k} is not a catalog setting (${Object.keys(DEFAULTS).join(', ')})`);
    else if (WHOLE[k]) {
      if (!WHOLE[k].ok(v)) out.push(`catalog.${k} must be a whole number from ${WHOLE[k].range.min} to ${WHOLE[k].range.max}`);
    } else if (typeof v !== 'boolean') out.push(`catalog.${k} must be true or false`);
  }
  return out;
}

/** The settings with the defaults filled in; a broken value reads as its default. */
function setupOf(config) {
  const own = isObject(config?.catalog) ? config.catalog : {};
  const out = {};
  for (const [k, d] of Object.entries(DEFAULTS))
    out[k] = WHOLE[k] ? (WHOLE[k].ok(own[k]) ? own[k] : d) : typeof own[k] === 'boolean' ? own[k] : d;
  return out;
}

// ---- frontmatter ----------------------------------------------------------------------------------------------------

/** A scalar or flow value: JSON for [ { and ", null and ~ for none, true and false, else the text without a comment. */
function scalar(raw) {
  let v = String(raw ?? '').trim();
  if (!v || v === '~' || v === 'null') return { value: null };
  if (/^[[{"]/.test(v)) {
    // A trailing comment after a JSON value: cut a "  # ..." that holds no quote or bracket.
    const bare = v.replace(/\s+#[^"'\]}]*$/, '');
    try {
      return { value: JSON.parse(bare) };
    } catch {
      return { value: v, json: false };
    }
  }
  v = v.replace(/\s+#.*$/, '').trim();
  if (v === 'true') return { value: true };
  if (v === 'false') return { value: false };
  if (/^'.*'$/.test(v)) return { value: v.slice(1, -1) };
  return { value: v === 'null' || v === '' ? null : v };
}

/**
 * The frontmatter between the first two `---` lines: `key: value` lines, a key with no value and indented lines under
 * it (`  - item` makes a list, `  key: value` an object one level deep). A value that starts with [ { or " is JSON.
 * @returns {{ data: object|null, body: string, errors: string[], bodyStart: number }}
 */
function parseFrontmatter(source) {
  const all = lines(source);
  if (all[0]?.trim() !== '---') return { data: null, body: String(source ?? ''), errors: ['no frontmatter (a --- line first)'], bodyStart: 0 };
  const end = all.findIndex((l, i) => i > 0 && l.trim() === '---');
  if (end < 0) return { data: null, body: '', errors: ['the frontmatter has no closing --- line'], bodyStart: 0 };
  const data = {};
  const errors = [];
  let open = null; // the key whose indented children are being read
  for (let i = 1; i < end; i++) {
    const l = all[i];
    if (!l.trim() || /^\s*#/.test(l)) continue;
    if (/^\s/.test(l)) {
      if (!open) {
        errors.push(`line ${i + 1}: an indented line with no key above it`);
        continue;
      }
      const item = l.trim().match(/^-\s+(.*)$/);
      if (item) {
        if (data[open] === null) data[open] = [];
        if (Array.isArray(data[open])) data[open].push(scalar(item[1]).value);
        else errors.push(`line ${i + 1}: ${open} mixes a list and fields`);
        continue;
      }
      const kv = l.trim().match(/^([A-Za-z_][\w-]*):\s?(.*)$/);
      if (!kv) {
        errors.push(`line ${i + 1}: not "key: value"`);
        continue;
      }
      if (data[open] === null) data[open] = {};
      if (isObject(data[open])) data[open][kv[1]] = scalar(kv[2]).value;
      else errors.push(`line ${i + 1}: ${open} mixes a list and fields`);
      continue;
    }
    const kv = l.match(/^([A-Za-z_][\w-]*):\s?(.*)$/);
    if (!kv) {
      errors.push(`line ${i + 1}: not "key: value"`);
      open = null;
      continue;
    }
    if (Object.hasOwn(data, kv[1])) errors.push(`line ${i + 1}: ${kv[1]} is given twice`);
    const s = scalar(kv[2]);
    if (s.json === false) errors.push(`line ${i + 1}: ${kv[1]} is not valid JSON`);
    data[kv[1]] = s.value;
    open = s.value === null ? kv[1] : null;
  }
  return { data, body: all.slice(end + 1).join('\n'), errors, bodyStart: end + 1 };
}

// ---- a design choice ------------------------------------------------------------------------------------------------

/** A path pattern a choice may name: relative, forward slashes, no `..`. */
function pathPatternError(p) {
  if (!text(p)) return 'empty';
  if (/^[A-Za-z]:|^[\\/]/.test(p) || p.split('/').includes('..')) return `${p}: .. and absolute paths are not allowed`;
  if (p.includes('\\')) return `${p}: use / , not \\`;
  return null;
}

/**
 * One design choice file. `name` is the file name in decisions/.
 * @returns {{ decision: object|null, errors: string[], warnings: string[] }}
 */
function parseDecision(name, source) {
  const where = `decisions/${name}`;
  const errors = [];
  const warnings = [];
  const e = (t) => errors.push(`${where}: ${t}`);
  const fileId = FILE_PATTERN.exec(name)?.[1] ?? null;
  if (!fileId) e('the file name must be D-0001-<slug>.md (lower-case letters, digits and hyphens)');
  const fm = parseFrontmatter(source);
  for (const t of fm.errors) e(t);
  if (!fm.data) return { decision: null, errors, warnings };
  const d = fm.data;
  for (const k of Object.keys(d)) if (!FIELDS.includes(k)) e(`unknown field ${k} (allowed: ${FIELDS.join(', ')})`);
  if (typeof d.id !== 'string' || !ID_PATTERN.test(d.id)) e('id must look like D-0001 (D-, four digits)');
  else if (fileId && d.id !== fileId) e(`id ${d.id} does not match the file name (${fileId})`);
  if (!text(d.title)) e('title missing');
  else if (d.title.length > TITLE_MAX) e(`title is over ${TITLE_MAX} characters`);
  if (!STATUSES.includes(d.status)) e(`status must be one of ${STATUSES.join(', ')}`);
  if (!Array.isArray(d.paths) || !d.paths.length) e('paths must be a list of at least one path pattern, e.g. ["app/**"]');
  else for (const p of d.paths) {
    const pe = typeof p === 'string' ? pathPatternError(p) : 'not text';
    if (pe) e(`paths: ${pe}`);
  }
  if (!text(d.invariant)) e('invariant missing (one sentence that can be checked)');
  else if (/[\u0000-\u001f]/.test(d.invariant)) e('invariant must be one line');
  else if (d.invariant.length > INVARIANT_MAX) e(`invariant is over ${INVARIANT_MAX} characters; keep it to one sentence`);
  // The check rule (bolk B6): its shape, and its examples run through the same line test a delivery gets.
  if (d.check != null) for (const t of require('./catalogChecks.js').ruleOf(d.check).errors) e(t);
  if (d.supersedes != null && !(typeof d.supersedes === 'string' && ID_PATTERN.test(d.supersedes)))
    e('supersedes must be a design choice id (D-0001) or null');
  if (d.plan != null && !(typeof d.plan === 'string' && PLAN_PATTERN.test(d.plan))) e('plan must be a plan entry id (PL-...) or null');
  if (d.accepted_by != null && typeof d.accepted_by !== 'string') e('accepted_by must be text (written by ravenseat catalog accept)');
  const bodyLines = lines(fm.body).filter((l) => l.trim()).length;
  if (bodyLines > BODY_LINES) warnings.push(`${where}: the text is over ${BODY_LINES} lines (${bodyLines}); the plan register holds the long version`);
  const decision = {
    file: where,
    id: typeof d.id === 'string' ? d.id : fileId,
    title: typeof d.title === 'string' ? d.title : null,
    status: d.status ?? null,
    paths: Array.isArray(d.paths) ? d.paths.filter((p) => typeof p === 'string') : [],
    invariant: typeof d.invariant === 'string' ? d.invariant : null,
    check: d.check ?? null,
    supersedes: d.supersedes ?? null,
    plan: d.plan ?? null,
    accepted_by: d.accepted_by ?? null,
    accepted: d.accepted ?? null,
    body: fm.body,
  };
  return { decision, errors, warnings };
}

// ---- stack.md and reuse.md ------------------------------------------------------------------------------------------

/** The lines outside HTML comments (<!-- ... -->, also over several lines), with their line numbers. */
function visibleLines(source) {
  const out = [];
  let inComment = false;
  lines(source).forEach((raw, i) => {
    let l = raw;
    if (inComment) {
      const end = l.indexOf('-->');
      if (end < 0) return;
      l = l.slice(end + 3);
      inComment = false;
    }
    l = l.replace(/<!--.*?-->/g, '');
    const start = l.indexOf('<!--');
    if (start >= 0) {
      l = l.slice(0, start);
      inComment = true;
    }
    out.push({ text: l, line: i + 1 });
  });
  return out;
}

/**
 * stack.md: the generated block (text between the markers, trimmed) and the prefer lines under "## Prefer".
 * @returns {{ block: string|null, prefer: { purpose: string, use: string }[], errors: string[], warnings: string[] }}
 */
function parseStack(source) {
  const errors = [];
  const warnings = [];
  const all = lines(source);
  const b = all.findIndex((l) => l.trim() === BLOCK_BEGIN);
  const en = all.findIndex((l) => l.trim() === BLOCK_END);
  let block = null;
  if (b >= 0 && en < 0) errors.push('stack.md: the generated block has no end marker');
  else if (b < 0 && en >= 0) errors.push('stack.md: the generated block has no begin marker');
  else if (b >= 0 && en < b) errors.push('stack.md: the generated block ends before it begins');
  else if (b >= 0) block = all.slice(b + 1, en).join('\n').trim();
  const prefer = [];
  let inPrefer = false;
  for (const { text: l } of visibleLines(source)) {
    const h = l.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      inPrefer = /^prefer\b/i.test(h[2].trim());
      continue;
    }
    if (!inPrefer || !l.trim()) continue;
    const m = l.match(/^\s*[-*]\s+([^:]+?):\s+(.+?)\s*$/);
    if (m) prefer.push({ purpose: m[1].trim(), use: m[2] });
    else warnings.push(`stack.md: under ## Prefer, "${l.trim().slice(0, 60)}" is not a line "- <job>: <what to use>"`);
  }
  if (prefer.length > PREFER_LINES)
    warnings.push(`stack.md: ${prefer.length} prefer lines; a mission gets the first ${PREFER_LINES}`);
  return { block, prefer, errors, warnings };
}

/** The cells of a table row "| a | b | c |" (escaped \| kept as |). */
const cells = (l) =>
  l
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.replace(/\\\|/g, '|').trim());

/**
 * reuse.md: the rows of its table (the header row, the row before a |---| separator, is skipped).
 * @returns {{ rows: { purpose: string, symbol: string, file: string, line: number }[], errors: string[], warnings: string[] }}
 */
function parseReuse(source) {
  const errors = [];
  const warnings = [];
  const rows = [];
  const vis = visibleLines(source);
  vis.forEach(({ text: l, line }, i) => {
    if (!l.trim().startsWith('|')) return;
    if (/^\s*\|[\s:|-]+\|?\s*$/.test(l)) return; // the separator
    const next = vis[i + 1]?.text ?? '';
    if (/^\s*\|[\s:|-]+\|?\s*$/.test(next) && /-/.test(next)) return; // the header row
    const c = cells(l);
    if (c.length !== 3 || c.some((x) => !x)) {
      errors.push(`reuse.md:${line}: a row needs three cells: | purpose | symbol | file |`);
      return;
    }
    const pe = pathPatternError(c[2]);
    if (pe) {
      errors.push(`reuse.md:${line}: ${pe}`);
      return;
    }
    rows.push({ purpose: c[0], symbol: c[1].replace(/^`|`$/g, ''), file: c[2].replace(/^`|`$/g, ''), line });
  });
  if (rows.length > REUSE_ROWS)
    warnings.push(`reuse.md: ${rows.length} rows; keep it to about ${REUSE_ROWS}, the building blocks really meant for reuse`);
  return { rows, errors, warnings };
}

// ---- the folder -----------------------------------------------------------------------------------------------------

/**
 * Reads the catalog folder (absolute path). A missing folder is { exists: false }, no problem.
 * @returns {{ exists: boolean, dir: string, stack: object|null, reuse: object|null,
 *   decisions: { name: string, decision: object|null, errors: string[], warnings: string[], source: string }[],
 *   errors: string[], warnings: string[] }}
 */
function readCatalog(dir, fsLike = fs) {
  const out = { exists: false, dir, stack: null, reuse: null, decisions: [], errors: [], warnings: [] };
  try {
    if (!fsLike.statSync(dir).isDirectory()) return out;
  } catch {
    return out;
  }
  out.exists = true;
  const readText = (f) => {
    try {
      return fsLike.readFileSync(path.join(dir, f), 'utf8');
    } catch {
      return null;
    }
  };
  const stack = readText('stack.md');
  if (stack != null) out.stack = parseStack(stack);
  const reuse = readText('reuse.md');
  if (reuse != null) out.reuse = parseReuse(reuse);
  for (const part of [out.stack, out.reuse]) if (part) out.errors.push(...part.errors), out.warnings.push(...part.warnings);
  let names = [];
  try {
    names = fsLike.readdirSync(path.join(dir, 'decisions')).sort();
  } catch {
    names = [];
  }
  for (const name of names) {
    if (name === 'README.md' || name.startsWith('.')) continue;
    if (!name.endsWith('.md')) {
      out.warnings.push(`decisions/${name} is not a design choice (D-0001-<slug>.md); it is skipped`);
      continue;
    }
    const source = readText(path.join('decisions', name)) ?? '';
    const r = parseDecision(name, source);
    out.decisions.push({ name, source, ...r });
    out.errors.push(...r.errors);
    out.warnings.push(...r.warnings);
  }
  return out;
}

// ---- the owner record -----------------------------------------------------------------------------------------------

const emptyLedger = () => ({ version: 1, decisions: {} });

/** The record file's text read into a ledger; anything broken reads as empty: nothing is confirmed, never everything. */
function parseLedger(source) {
  try {
    const j = JSON.parse(String(source));
    if (!isObject(j) || !isObject(j.decisions)) return emptyLedger();
    const decisions = {};
    for (const [id, e] of Object.entries(j.decisions))
      if (ID_PATTERN.test(id) && isObject(e) && typeof e.fingerprint === 'string') decisions[id] = { ...e };
    return { version: 1, decisions };
  } catch {
    return emptyLedger();
  }
}

/** What binds in a choice: id, invariant, paths and check. The title and the text may change without a new accept. */
function fingerprint(d) {
  const canon = (v) =>
    Array.isArray(v) ? v.map(canon) : isObject(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v;
  const what = JSON.stringify(canon([d?.id ?? null, d?.invariant ?? null, d?.paths ?? [], d?.check ?? null]));
  return crypto.createHash('sha256').update(what).digest('hex');
}

/**
 * The status that counts: `accepted` only with the owner's record of this exact version, else `unconfirmed`. A proposed
 * or superseded choice is what it says.
 */
function effectiveStatus(d, ledger) {
  if (d?.status !== 'accepted') return d?.status ?? null;
  const rec = ledger?.decisions?.[d.id];
  return rec && rec.fingerprint === fingerprint(d) ? 'accepted' : 'unconfirmed';
}

/** The ledger with the owner's accept of `d` recorded (a new object). Throws for anyone but the owner. */
function recordAccept(ledger, d, { by, now = new Date().toISOString() } = {}) {
  if (!OWNER_BY.has(String(by ?? '').trim())) throw new Error('only the owner accepts a design choice (--by owner)');
  const base = isObject(ledger?.decisions) ? ledger : emptyLedger();
  return { version: 1, decisions: { ...base.decisions, [d.id]: { fingerprint: fingerprint(d), by: String(by).trim(), at: now } } };
}

/**
 * The file text with status: accepted, accepted_by and accepted (the date) in the frontmatter; every other line stays as
 * it was. Only `by` owner or theBoard.
 * @returns {{ text: string|null, error: string|null }}
 */
function acceptText(source, { by, now = new Date().toISOString() } = {}) {
  const who = String(by ?? '').trim();
  if (!OWNER_BY.has(who)) return { text: null, error: 'only the owner accepts a design choice (--by owner)' };
  const fm = parseFrontmatter(source);
  if (!fm.data) return { text: null, error: fm.errors.join('; ') };
  if (fm.data.status === 'superseded') return { text: null, error: 'a superseded design choice cannot be accepted; write a new one' };
  const all = lines(source);
  const end = fm.bodyStart - 1;
  const head = all.slice(1, end).filter((l) => !/^(accepted_by|accepted):/.test(l));
  const at = head.findIndex((l) => /^status:/.test(l));
  const stamp = ['status: accepted', `accepted_by: ${who}`, `accepted: ${String(now).slice(0, 10)}`];
  if (at >= 0) head.splice(at, 1, ...stamp);
  else head.push(...stamp);
  return { text: [all[0], ...head, ...all.slice(end)].join('\n'), error: null };
}

// ---- propose (roadmap 0z Z-B) ---------------------------------------------------------------------------------------

/**
 * The next free design choice id: one above the highest number in the file names and in the owner's record. The record
 * counts too, so an id whose file was deleted is still never handed out again.
 */
function nextDecisionId(names, ledger) {
  let top = 0;
  for (const n of names ?? []) {
    const m = /^D-(\d{4})-/.exec(String(n));
    if (m) top = Math.max(top, Number(m[1]));
  }
  for (const id of Object.keys(ledger?.decisions ?? {})) {
    const m = /^D-(\d{4})$/.exec(id);
    if (m) top = Math.max(top, Number(m[1]));
  }
  return `D-${String(top + 1).padStart(4, '0')}`;
}

/** Letters a slug spells out (Norwegian and a few others); the rest of the non-ASCII letters lose their accent. */
const SLUG_LETTERS = Object.freeze({ æ: 'ae', ø: 'o', å: 'a', ß: 'ss', œ: 'oe' });
const SLUG_MAX = 48;

/** The slug of a file name from a title: lower-case ASCII letters, digits and hyphens, at most SLUG_MAX, never empty. */
function slugOf(title) {
  const s = String(title ?? '')
    .toLowerCase()
    .replace(/[æøåßœ]/g, (c) => SLUG_LETTERS[c])
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/, '');
  return s || 'choice';
}

/**
 * A frontmatter value as text parseFrontmatter reads back the same: plain where that is safe, else JSON (a value that
 * starts like JSON or a quote, reads as true, false or null, holds a " #" that would be cut as a comment, or has spaces
 * at an end).
 */
function frontValue(v) {
  if (v == null) return 'null';
  if (Array.isArray(v)) return JSON.stringify(v);
  const s = String(v);
  const plain = s.trim() === s && s !== '' && !/^[[{"'~]/.test(s) && !/^(true|false|null)$/.test(s) && !/\s#/.test(s);
  return plain ? s : JSON.stringify(s);
}

/**
 * A proposed design choice as a file: { name, text, errors }. The text is what `catalog propose` writes; errors are
 * parseDecision's on that text, so nothing broken is ever written. The status is always proposed: only the owner accepts.
 * @param {{ id: string, title: string, invariant: string, paths: string[], supersedes?: string|null, plan?: string|null,
 *   why?: string|null }} p
 */
function proposalFile(p) {
  const one = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
  const title = one(p.title);
  const name = `${p.id}-${slugOf(title)}.md`;
  const why = String(p.why ?? '').replace(/\r\n/g, '\n').trim();
  const text = [
    '---',
    `id: ${p.id}`,
    `title: ${frontValue(title)}`,
    'status: proposed',
    `paths: ${JSON.stringify(Array.isArray(p.paths) ? p.paths : [])}`,
    `invariant: ${frontValue(one(p.invariant))}`,
    `supersedes: ${p.supersedes ? p.supersedes : 'null'}`,
    `plan: ${p.plan ? p.plan : 'null'}`,
    '---',
    why || 'Context, the choice and what follows from it, in at most 30 lines.',
    '',
  ].join('\n');
  const r = parseDecision(name, text);
  return { name, text, errors: r.errors, warnings: r.warnings };
}

// ---- check ----------------------------------------------------------------------------------------------------------

/** At most this many files of a choice's paths are read for treeHits, and none over TREE_FILE_BYTES. */
const TREE_FILES = 3000;
const TREE_FILE_BYTES = 512 * 1024;

/**
 * The lines in the tree a choice's check rule already hits (files in its paths, never tests or comment lines), or
 * null: { count, first: "file:line" }. A superseded choice and a rule with errors are not tried.
 */
function treeHits(d, { files, readFile, glob }) {
  if (d.check == null || d.status === 'superseded') return null;
  const CC = require('./catalogChecks.js');
  const RS = require('./reviewSignals.js');
  const { rule, errors } = CC.ruleOf(d.check);
  if (!rule || errors.length) return null;
  let count = 0;
  let first = null;
  const mine = files.filter((f) => !RS.isTestPath(f) && d.paths.some((p) => glob(p, f))).slice(0, TREE_FILES);
  for (const f of mine) {
    const body = readFile(f);
    if (typeof body !== 'string' || body.length > TREE_FILE_BYTES || body.includes('\u0000')) continue;
    lines(body).forEach((l, i) => {
      if (!CC.lineHits(rule, l)) return;
      count++;
      first ??= `${f}:${i + 1}`;
    });
  }
  return count ? { count, first } : null;
}

/**
 * Everything `catalog check` reports, on top of the read's own errors.
 * @param {object} cat readCatalog's result
 * @param {{ files?: string[]|null, readFile?: (p: string) => string|null, ledger?: object, planIds?: Set<string>|null,
 *   stackBlock?: string|null, ravenseat?: string, globMatch?: Function }} ctx
 *   files: the tracked paths (null = the path checks are skipped); readFile: a project file's text (for a reuse symbol);
 *   planIds: the plan register's ids (null = not checked); stackBlock: the block as init would write it now.
 * @returns {{ errors: string[], warnings: string[] }}
 */
function checkCatalog(cat, ctx = {}) {
  const errors = [...(cat?.errors ?? [])];
  const warnings = [...(cat?.warnings ?? [])];
  if (!cat?.exists) return { errors, warnings };
  const cli = ctx.ravenseat ?? 'ravenseat';
  const glob = ctx.globMatch ?? require('./mergeGuard.js').globMatch;
  const files = Array.isArray(ctx.files) ? ctx.files : null;
  const ds = cat.decisions.map((x) => x.decision).filter(Boolean);
  const byId = new Map();
  for (const d of ds) {
    if (!d.id) continue;
    if (byId.has(d.id)) errors.push(`${d.id} is used by two files (${byId.get(d.id).file}, ${d.file}); ids are never reused`);
    else byId.set(d.id, d);
  }
  for (const d of ds) {
    const st = effectiveStatus(d, ctx.ledger ?? emptyLedger());
    if (st === 'unconfirmed')
      errors.push(
        `${d.id} says accepted, but the owner did not accept this version (the invariant, paths or check differ, or the line was set by hand). ` +
          `If it is the owner's choice: ${cli} catalog accept ${d.id} --by owner. Until then it counts as proposed.`,
      );
    if (files && d.paths.length && !files.some((f) => d.paths.some((p) => glob(p, f))))
      warnings.push(`${d.id} (${d.file}): its paths match no tracked file: ${d.paths.join(', ')}`);
    if (d.supersedes && !byId.has(d.supersedes)) errors.push(`${d.id} supersedes ${d.supersedes}, which is not in the catalog`);
    else if (d.supersedes && byId.get(d.supersedes).status !== 'superseded')
      warnings.push(`${d.id} supersedes ${d.supersedes}, but ${d.supersedes} is not marked status: superseded`);
    if (d.status === 'superseded' && !ds.some((x) => x.supersedes === d.id))
      warnings.push(`${d.id} is superseded, but no design choice names it in supersedes`);
    if (d.plan && ctx.planIds && !ctx.planIds.has(d.plan)) warnings.push(`${d.id}: plan ${d.plan} is not in the plan register`);
    const already = files && ctx.readFile ? treeHits(d, { files, readFile: ctx.readFile, glob }) : null;
    if (already)
      warnings.push(
        `${d.id}: its check already hits ${already.count} line(s) in the tree (first ${already.first}). Receive tries only ` +
          'added lines, so these stay until a task takes them out; a rule that hits much of the tree is too broad.',
      );
  }
  for (const r of cat.reuse?.rows ?? []) {
    const body = ctx.readFile ? ctx.readFile(r.file) : undefined;
    const tracked = files ? files.includes(r.file) : body != null;
    if (files || ctx.readFile) {
      if (!tracked && body == null) {
        warnings.push(`reuse.md:${r.line}: ${r.file} does not exist`);
        continue;
      }
    }
    if (typeof body === 'string') {
      const word = new RegExp(`(^|[^A-Za-z0-9_$])${r.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9_$])`);
      if (!word.test(body)) warnings.push(`reuse.md:${r.line}: ${r.symbol} is not in ${r.file}`);
    }
  }
  if (cat.stack?.block != null && ctx.stackBlock != null && cat.stack.block.trim() !== ctx.stackBlock.trim())
    warnings.push(`stack.md: the generated block is out of step with the manifests; ${cli} catalog init refreshes it`);
  return { errors, warnings };
}

// ---- init -----------------------------------------------------------------------------------------------------------

/**
 * The generated block of stack.md (without the markers) from what the manifests show.
 * @param {{ stacks?: string[], packs?: string[], checks?: { kind: string, command: string, source: string }[],
 *   jobs?: { title: string, packages: string[], manifest: string }[] }} facts
 */
function stackBlock(facts = {}) {
  const out = [];
  out.push(`- Languages and runtimes: ${(facts.stacks ?? []).join(', ') || 'none found in the manifests'}`);
  if (facts.packs?.length) out.push(`- Frameworks with a review pack: ${facts.packs.join(', ')}`);
  for (const c of facts.checks ?? []) out.push(`- ${c.kind}: \`${c.command}\` (${c.source})`);
  for (const j of facts.jobs ?? []) out.push(`- ${j.title}: ${j.packages.join(', ')} (${j.manifest})`);
  return out.join('\n');
}

/** The libraries by job a manifest already has (the purpose groups of dependency-purposes.json). */
function jobsOf(manifests, purposes = require('./scopeNotes.js').PURPOSES) {
  const SN = require('./scopeNotes.js');
  const out = [];
  for (const m of manifests ?? []) {
    const eco = m.path.split('/').pop() === 'package.json' ? 'npm' : 'python';
    const deps = SN.depsOf(m.path, m.text) ?? [];
    for (const p of purposes) {
      if (p.ecosystem !== eco) continue;
      const have = p.packages.filter((n) => deps.includes(n));
      if (have.length) out.push({ title: p.title, packages: have, manifest: m.path });
    }
  }
  return out;
}

/** stack.md with the block put in (a new file, or the block replaced; the owner's text stays). */
function stackWithBlock(existing, block) {
  const inner = [BLOCK_BEGIN, block, BLOCK_END].join('\n');
  if (existing == null)
    return [
      '# Stack',
      '',
      inner,
      '',
      '## Prefer',
      '',
      'One line per job: what to use, and what not to add. A track gets these lines before it picks a library.',
      '',
      '<!-- - dates: use dayjs; do not add moment -->',
      '<!-- - HTTP: use the fetch wrapper in lib/http.ts; do not add axios -->',
      '',
    ].join('\n');
  const all = lines(existing);
  const b = all.findIndex((l) => l.trim() === BLOCK_BEGIN);
  const e = all.findIndex((l) => l.trim() === BLOCK_END);
  if (b >= 0 && e > b) return [...all.slice(0, b), inner, ...all.slice(e + 1)].join('\n');
  return null; // no block (or a broken one): the file is the owner's, init leaves it
}

const REUSE_TEMPLATE = [
  '# Reuse',
  '',
  'Building blocks meant for reuse that a track would not find by itself. One row each; keep it short. A track looks here',
  'before it writes a new helper.',
  '',
  '| Purpose | Symbol | File |',
  '|---|---|---|',
  '',
].join('\n');

const DECISIONS_README = [
  '# Design choices',
  '',
  'One file per choice: `D-0001-<slug>.md` (lower-case letters, digits and hyphens), with this frontmatter:',
  '',
  '```markdown',
  '---',
  'id: D-0001',
  'title: Client code goes through the service layer',
  'status: proposed',
  'paths: ["app/**", "components/**"]',
  'invariant: Files under app/ and components/ never import the database client directly.',
  'supersedes: null',
  'plan: null',
  '---',
  'Context, the choice and what follows from it, in at most 30 lines.',
  '```',
  '',
  'When the invariant can be checked line by line, add a rule under `check:` (receive tries it on the added lines):',
  '',
  '```markdown',
  'check:',
  '  forbid: "from [\'\\"]@db/client[\'\\"]"',
  '  hit: ["import { db } from \'@db/client\'"]',
  '  miss: ["import { save } from \'@/services/factory\'"]',
  '  mode: warn',
  '```',
  '',
  '- `forbid` is a regular expression (case matters); `hit` and `miss` are example lines it must and must not hit.',
  '  `mode` is `warn` (the default) or `stop` (stops the merge only with `catalog.checkStop` on). Only an accepted',
  '  choice enforces; a proposed one gives a note.',
  '',
  '- `status`: `proposed`, `accepted` or `superseded`. Anyone may propose. Only the owner accepts:',
  '  `ravenseat catalog accept D-0001 --by owner`. A status set to accepted by hand is unconfirmed: `catalog check`',
  '  names it as an error, and it counts as proposed until the owner accepts it.',
  '- `invariant`: one sentence that can be checked. It is the only text a track gets.',
  '- `paths`: the files the choice applies to.',
  '- To change an accepted choice, write a new one with `supersedes: D-0001` and set the old one to `superseded`.',
  '- `plan`: the plan entry with the long version, if there is one. A plan entry links back with `decisions`.',
  '',
].join('\n');

module.exports = {
  DIR,
  STATUSES,
  FIELDS,
  ID_PATTERN,
  BLOCK_BEGIN,
  BLOCK_END,
  LEDGER_FILE,
  DEFAULTS,
  EXCERPT_TOKENS,
  OWNER_BY,
  REUSE_TEMPLATE,
  DECISIONS_README,
  setupProblems,
  setupOf,
  parseFrontmatter,
  parseDecision,
  parseStack,
  parseReuse,
  readCatalog,
  emptyLedger,
  parseLedger,
  fingerprint,
  effectiveStatus,
  recordAccept,
  acceptText,
  nextDecisionId,
  slugOf,
  proposalFile,
  checkCatalog,
  stackBlock,
  jobsOf,
  stackWithBlock,
};
