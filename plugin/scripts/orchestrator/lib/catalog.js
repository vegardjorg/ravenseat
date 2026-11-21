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
const STATUSES = Object.freeze(['proposed', 'accepted', 'superseded', 'not-building']);
/**
 * The frontmatter fields of a design choice. accepted_by and accepted are written by `catalog accept`. kind says what
 * sort of entry it is (KINDS). except (roadmap 0å KD-0) is the paths the entry does not apply to, inside its paths (the
 * globs have no negation). keywords, revisit and source are for a "Not building" entry (roadmap 0f,
 * lib/notBuilding.js): what the project deliberately does not build, with the words a new proposal is matched against,
 * when to look at it again, and where the no came from.
 */
const FIELDS = Object.freeze([
  'id', 'title', 'status', 'kind', 'paths', 'except', 'invariant', 'check', 'keywords', 'revisit', 'source', 'uses',
  'alternatives', 'stack', 'supersedes', 'plan', 'accepted_by', 'accepted',
]);
/**
 * A stack entry's fields (roadmap 0å KD-2): uses {job, tool} says which tool does a job, alternatives the tools it was
 * chosen against (a package name each), stack the words it declares for the checks (stack:<word> in recipes.json).
 * Only on kind stack; all three bind (fingerprint).
 */
const STACK_FIELDS = Object.freeze(['uses', 'alternatives', 'stack']);
/** A tool, an alternative: a package name (npm with a scope, PyPI, a crate, a Go module path). */
const PACKAGE_PATTERN = /^@?[A-Za-z0-9][\w.@/+-]*$/;
/** A declared stack word: what stackWords in lib/checksCatalog.js keeps of a word. */
const STACK_WORD = /^[a-z0-9][a-z0-9.+#-]*$/;
const STACK_MAX = 12;
const JOB_MAX = 60;
/**
 * One field, one set of values (roadmap 0å KD-0, plans/katalog-design-stack-avhengigheter-2026-11-18.md § 2):
 *   decision      a design choice (the default when the line is missing)
 *   design        a rule of the project's design language (colours from tokens, the type scale); KD-1
 *   stack         a stack choice: which tool does a job, with the reason; KD-2
 *   dependency    a decision about one library (a risk acceptance, roadmap KD-4)
 *   not-building  a rejection, roadmap 0f. Its draft is status proposed with kind not-building; the owner's accept writes
 *                 status not-building (never accepted). A file that says status not-building is of that kind without
 *                 the line.
 * The kind is part of the fingerprint (fingerprint), so a track cannot turn a binding entry into another sort.
 */
const KINDS = Object.freeze(['decision', 'design', 'stack', 'dependency', 'not-building']);
/** The board's and `catalog show`'s heading per kind, in the order they are shown (not-building has its own view). */
const KIND_TITLES = Object.freeze({ design: 'Design language', stack: 'Stack', dependency: 'Dependencies', decision: 'Design choices' });
/** A not-building entry's keywords: at most this many, each at most KEYWORD_MAX characters. */
const KEYWORDS_MAX = 12;
const KEYWORD_MAX = 40;
/** The revisit condition and the source of a not-building entry: one line each. */
const NOTE_MAX = 200;
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
 * stackFacts (roadmap 0å KD-2): the stack words of accepted stack entries go into the Checks tab's facts.stacks, so a
 * recipe's `stack:<word>` holds and the dep-audit card names the audit command. On: it can change which cards show and
 * stops nothing, and only the owner's accepted entries count; off gives the cards from the manifests alone.
 * depsExcerpt (roadmap 0å KD-3, lib/catalogDeps.js): the excerpt gets a row per dependency the task's files import, with
 * the locked version, the local types or README and the docs link from stack.md's Dependencies table. On: it is only
 * text inside the same cap (cut before the reuse rows), read from the lockfile with no network, and it fixes a known
 * problem (code written for another major version than the one installed). Off: the excerpt as before.
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
  captureAnswers: 'explicit',
  stackFacts: true,
  depsExcerpt: true,
});
/**
 * The settings with a fixed list of values. captureAnswers (roadmap 0z Z-A): whether an owner's answer can become a
 * proposed design choice. off: never (resolve --keep, the board's button and catalog propose all refuse); explicit: only
 * when the owner asks (resolve --keep, the button); suggest: also a hint when the question looks like a lasting rule
 * (looksLasting). Never an accept: only the owner accepts. Default explicit: asking costs nothing, the hint can be noise.
 */
const CHOICES = Object.freeze({ captureAnswers: Object.freeze(['off', 'explicit', 'suggest']) });
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
    } else if (CHOICES[k]) {
      if (!CHOICES[k].includes(v)) out.push(`catalog.${k} must be one of ${CHOICES[k].join(', ')}`);
    } else if (typeof v !== 'boolean') out.push(`catalog.${k} must be true or false`);
  }
  return out;
}

/** The settings with the defaults filled in; a broken value reads as its default. */
function setupOf(config) {
  const own = isObject(config?.catalog) ? config.catalog : {};
  const out = {};
  for (const [k, d] of Object.entries(DEFAULTS))
    out[k] = WHOLE[k]
      ? WHOLE[k].ok(own[k]) ? own[k] : d
      : CHOICES[k]
        ? CHOICES[k].includes(own[k]) ? own[k] : d
        : typeof own[k] === 'boolean' ? own[k] : d;
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
  // A "Not building" entry (roadmap 0f): kind not-building, or status not-building without the line.
  if (d.kind != null && !KINDS.includes(d.kind)) e(`kind must be one of ${KINDS.join(', ')} (or left out: a design choice)`);
  if (d.status === 'not-building' && d.kind != null && d.kind !== 'not-building') e('status not-building needs kind not-building (or no kind line)');
  const nb = d.kind === 'not-building' || d.status === 'not-building';
  const kind = nb ? 'not-building' : KINDS.includes(d.kind) ? d.kind : 'decision';
  if (nb && d.status === 'accepted') e('a not-building entry is accepted as status not-building, not accepted (ravenseat catalog accept writes it)');
  // What a rejection does not need: an invariant and paths (it binds no code). When it has them, they are checked.
  if (!nb || d.paths != null) {
    if (!Array.isArray(d.paths) || (!nb && !d.paths.length)) e('paths must be a list of at least one path pattern, e.g. ["app/**"]');
    else for (const p of d.paths) {
      const pe = typeof p === 'string' ? pathPatternError(p) : 'not text';
      if (pe) e(`paths: ${pe}`);
    }
  }
  // except (KD-0): the paths inside `paths` the entry does not apply to, such as the token file of a colour rule.
  if (d.except != null) {
    if (!Array.isArray(d.except)) e('except must be a list of path patterns, e.g. ["ui/tokens.css"]');
    else for (const p of d.except) {
      const pe = typeof p === 'string' ? pathPatternError(p) : 'not text';
      if (pe) e(`except: ${pe}`);
    }
  }
  if (!nb || d.invariant != null) {
    if (!text(d.invariant)) e('invariant missing (one sentence that can be checked)');
    else if (/[\u0000-\u001f]/.test(d.invariant)) e('invariant must be one line');
    else if (d.invariant.length > INVARIANT_MAX) e(`invariant is over ${INVARIANT_MAX} characters; keep it to one sentence`);
  }
  if (nb && d.check != null) e('a not-building entry has no check rule (it binds no code)');
  if (d.keywords != null) {
    if (!Array.isArray(d.keywords) || d.keywords.some((k) => !text(k) || /[\u0000-\u001f]/.test(k) || k.length > KEYWORD_MAX))
      e(`keywords must be a list of words or short phrases (each at most ${KEYWORD_MAX} characters), e.g. ["keepalive", "idle ping"]`);
    else if (d.keywords.length > KEYWORDS_MAX) e(`keywords: at most ${KEYWORDS_MAX}`);
  }
  // source on a design entry (roadmap 0å KD-1) may be a list: where the tokens live, each a path with an optional
  // #anchor (a file, or a name inside it). The catalog points at the token file; it never holds a copy of the tokens.
  if (Array.isArray(d.source)) {
    if (kind !== 'design') e('source as a list is for kind design (where its tokens live); other kinds take one line of text');
    else for (const s of d.source) {
      const one = typeof s === 'string' && !/[\u0000-\u001f]/.test(s) && s.length <= NOTE_MAX;
      const pe = one ? pathPatternError(s.split('#')[0]) : `each item must be one line of text, at most ${NOTE_MAX} characters`;
      if (pe) e(`source: ${pe}`);
    }
  }
  // A stack entry (roadmap 0å KD-2): uses, alternatives and stack, only on kind stack; it needs uses or stack.
  const given = STACK_FIELDS.filter((f) => d[f] != null);
  if (given.length && kind !== 'stack') e('uses, alternatives and stack are for kind stack');
  if (kind === 'stack') {
    if (d.uses == null && d.stack == null) e('a stack entry needs uses {job, tool} or a stack list (the words it declares for the checks)');
    const line = (v, max) => text(v) && !/[\u0000-\u001f]/.test(v) && v.length <= max;
    if (d.uses != null && !(isObject(d.uses) && Object.keys(d.uses).every((k) => k === 'job' || k === 'tool') && line(d.uses.job, JOB_MAX) && line(d.uses.tool, 100) && PACKAGE_PATTERN.test(d.uses.tool)))
      e('uses must be {"job": "...", "tool": "..."}: the job in a few words, the tool as its package name');
    if (d.alternatives != null && !(Array.isArray(d.alternatives) && d.alternatives.every((x) => typeof x === 'string' && x.length <= 100 && PACKAGE_PATTERN.test(x))))
      e('alternatives must be a list of package names, e.g. ["moment", "luxon"]');
    if (d.stack != null) {
      if (!Array.isArray(d.stack)) e('stack must be a list of words, e.g. ["pnpm", "vitest"]');
      else if (d.stack.length > STACK_MAX) e(`stack: at most ${STACK_MAX} words`);
      else for (const w of d.stack) if (!(typeof w === 'string' && STACK_WORD.test(w))) e(`stack: each word in lower case, letters, digits and . + # - (${JSON.stringify(w)})`);
    }
  }
  for (const f of ['revisit', 'source'])
    if (d[f] != null && !(f === 'source' && Array.isArray(d[f])) && (typeof d[f] !== 'string' || /[\u0000-\u001f]/.test(d[f]) || d[f].length > NOTE_MAX))
      e(`${f} must be one line of text, at most ${NOTE_MAX} characters`);
  if (nb && d.status !== 'superseded' && !(Array.isArray(d.keywords) && d.keywords.length))
    warnings.push(`${where}: a not-building entry without keywords is never matched against a new proposal`);
  // The check rule (bolk B6): its shape, and its examples run through the same line test a delivery gets.
  if (d.check != null && !nb) for (const t of require('./catalogChecks.js').ruleOf(d.check).errors) e(t);
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
    kind,
    paths: Array.isArray(d.paths) ? d.paths.filter((p) => typeof p === 'string') : [],
    except: Array.isArray(d.except) ? d.except.filter((p) => typeof p === 'string') : [],
    invariant: typeof d.invariant === 'string' ? d.invariant : null,
    check: d.check ?? null,
    keywords: Array.isArray(d.keywords) ? d.keywords.filter((k) => typeof k === 'string') : [],
    revisit: typeof d.revisit === 'string' ? d.revisit : null,
    // A string for every kind; a list only on a design entry (KD-1).
    source: typeof d.source === 'string' ? d.source : kind === 'design' && Array.isArray(d.source) ? d.source.filter((s) => typeof s === 'string') : null,
    // A stack entry's fields (KD-2); null and [] on every other kind.
    uses: kind === 'stack' && isObject(d.uses) && text(d.uses.job) && text(d.uses.tool) ? { job: d.uses.job.trim(), tool: d.uses.tool.trim() } : null,
    alternatives: kind === 'stack' && Array.isArray(d.alternatives) ? d.alternatives.filter((x) => typeof x === 'string') : [],
    stack: kind === 'stack' && Array.isArray(d.stack) ? d.stack.filter((x) => typeof x === 'string') : [],
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

/** The intro sentence init puts under "## Prefer" (inside a comment, so check never reads it as a prefer line). */
const PREFER_INTRO = 'One line per job: what to use, and what not to add. A track gets these lines before it picks a library.';

/**
 * stack.md: the generated block (text between the markers, trimmed), the prefer lines under "## Prefer" and the rows of
 * the "## Dependencies" table (KD-3).
 * @returns {{ block: string|null, prefer: { purpose: string, use: string }[], deps: object[], errors: string[],
 *   warnings: string[] }}
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
    // An older init wrote this intro as plain text under the heading; it is the template's, not a broken line.
    if (l.trim() === PREFER_INTRO) continue;
    const m = l.match(/^\s*[-*]\s+([^:]+?):\s+(.+?)\s*$/);
    if (m) prefer.push({ purpose: m[1].trim(), use: m[2] });
    else warnings.push(`stack.md: under ## Prefer, "${l.trim().slice(0, 60)}" is not a line "- <job>: <what to use>"`);
  }
  if (prefer.length > PREFER_LINES)
    warnings.push(`stack.md: ${prefer.length} prefer lines; a mission gets the first ${PREFER_LINES}`);
  // The hand-written "## Dependencies" table (roadmap 0å KD-3, lib/catalogDeps.js): purpose, docs and a note per
  // package; the version is never in it (it comes from the lockfile).
  const deps = require('./catalogDeps.js').parseDepsTable(source);
  errors.push(...deps.errors);
  warnings.push(...deps.warnings);
  return { block, prefer, deps: deps.rows, errors, warnings };
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
  // A not-building entry (roadmap 0f) binds no code, but its keywords decide what a new proposal is matched against, so
  // they are part of it. A design choice keeps the fingerprint it always had (its records stay valid).
  const parts = [d?.id ?? null, d?.invariant ?? null, d?.paths ?? [], d?.check ?? null];
  if (isNotBuilding(d)) parts.push('not-building', d?.keywords ?? []);
  // The kind and except (roadmap 0å KD-0) bind too: a track must not turn an accepted stack entry into a plain note, or
  // widen what a rule skips. Only when they say something, so an entry without them keeps its fingerprint.
  else if (d?.kind != null && d.kind !== 'decision') parts.push({ kind: d.kind });
  if (Array.isArray(d?.except) && d.except.length) parts.push({ except: d.except });
  // A stack entry's choice (KD-2): the tool, what it was chosen against and the words it declares.
  if (d?.kind === 'stack' && (d.uses || d.alternatives?.length || d.stack?.length))
    parts.push({ uses: d.uses ?? null, alternatives: d.alternatives ?? [], stack: d.stack ?? [] });
  const what = JSON.stringify(canon(parts));
  return crypto.createHash('sha256').update(what).digest('hex');
}

/** Whether a parsed entry is a "Not building" entry (roadmap 0f): kind not-building, or status not-building. */
function isNotBuilding(d) {
  return d?.kind === 'not-building' || d?.status === 'not-building';
}

/**
 * Does an entry apply to a file: one of its paths matches and none of its except patterns does (roadmap 0å KD-0). The
 * one test the check rules, `catalog check` and the excerpt use, so except means the same everywhere.
 */
function covers(d, file, glob = require('./mergeGuard.js').globMatch) {
  const paths = Array.isArray(d?.paths) ? d.paths : [];
  const except = Array.isArray(d?.except) ? d.except : [];
  return paths.some((p) => glob(p, file)) && !except.some((p) => glob(p, file));
}

/**
 * The board's catalog list (Decisions, roadmap 0å KD-0): the entries grouped by kind in the order of KIND_TITLES, each
 * with the status that counts. Not-building entries have their own view (lib/notBuilding.js boardEntries) and a
 * superseded entry binds nothing, so both are left out. Empty groups are left out too.
 */
function boardGroups(cat, ledger = emptyLedger()) {
  if (!cat?.exists) return [];
  const ds = (cat.decisions ?? []).map((x) => x?.decision).filter((d) => d?.id && !isNotBuilding(d) && d.status !== 'superseded');
  const out = [];
  for (const [kind, title] of Object.entries(KIND_TITLES)) {
    const entries = ds
      .filter((d) => (d.kind ?? 'decision') === kind)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((d) => ({
        id: d.id,
        title: d.title ?? '',
        status: effectiveStatus(d, ledger),
        invariant: d.invariant ?? null,
        paths: d.paths ?? [],
        except: d.except ?? [],
        source: d.kind === 'design' ? d.source ?? null : null,
        // A stack entry's choice (roadmap 0å KD-3): the tool for the job and what it was chosen over, so the card says
        // it. Null and [] on the other kinds.
        uses: d.kind === 'stack' && d.uses?.tool ? { job: d.uses.job ?? null, tool: d.uses.tool } : null,
        alternatives: d.kind === 'stack' && Array.isArray(d.alternatives) ? d.alternatives.filter((a) => typeof a === 'string' && a) : [],
        file: d.file ?? null,
      }));
    if (entries.length) out.push({ kind, title, entries });
  }
  return out;
}

/**
 * The stack entries (roadmap 0å KD-2) that are not superseded, with the status that counts: what V3 (lib/scopeNotes.js
 * dependencyFacts) and `catalog check` compare a manifest against.
 * @returns {{ id: string, title: string, status: string, job: string|null, tool: string|null, alternatives: string[],
 *   stack: string[], paths: string[] }[]}
 */
function stackChoices(cat, ledger = emptyLedger()) {
  if (!cat?.exists) return [];
  return (cat.decisions ?? [])
    .map((x) => x?.decision)
    .filter((d) => d?.id && d.kind === 'stack' && d.status !== 'superseded')
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((d) => ({
      id: d.id,
      title: d.title ?? '',
      status: effectiveStatus(d, ledger),
      job: d.uses?.job ?? null,
      tool: d.uses?.tool ?? null,
      alternatives: d.alternatives ?? [],
      stack: d.stack ?? [],
      paths: d.paths ?? [],
    }));
}

/**
 * The stack words the accepted stack entries declare (the tool of uses, and the stack list), lower case, each once with
 * the first entry that declares it. Only accepted: the owner lock keeps a track from turning check cards on or off.
 * @returns {{ word: string, id: string }[]}
 */
function declaredStacks(cat, ledger = emptyLedger()) {
  const out = [];
  for (const c of stackChoices(cat, ledger)) {
    if (c.status !== 'accepted') continue;
    for (const w of [c.tool, ...c.stack]) {
      const word = String(w ?? '').trim().toLowerCase();
      if (word && !out.some((x) => x.word === word)) out.push({ word, id: c.id });
    }
  }
  return out;
}

/**
 * The checks' facts with the declared words in facts.stacks (once each) and the list in facts.declaredStacks, so a
 * recipe's `stack:<word>` holds and a card can name the command for it (lib/checksCatalog.js). catalog.stackFacts.
 */
function withDeclaredStacks(facts, declared) {
  const stacks = Array.isArray(facts?.stacks) ? [...facts.stacks] : [];
  const have = new Set(stacks.map((s) => String(s).toLowerCase()));
  for (const x of declared ?? []) if (!have.has(x.word)) stacks.push(x.word), have.add(x.word);
  return { ...facts, stacks, declaredStacks: [...(declared ?? [])] };
}

/** At most this many manifests are read for a stack entry's check. */
const STACK_MANIFESTS = 50;

/** The warnings for the accepted stack entries against the manifests and the Prefer lines (`catalog check`, KD-2). */
function stackWarnings(cat, { files, readFile, ledger, glob }) {
  const out = [];
  const SN = require('./scopeNotes.js');
  const low = (s) => String(s ?? '').toLowerCase();
  const prefer = cat.stack?.prefer ?? [];
  for (const c of stackChoices(cat, ledger)) {
    if (c.status !== 'accepted') continue;
    if (files && readFile) {
      const all = files.filter((f) => SN.isManifest(f));
      const named = all.filter((f) => c.paths.some((p) => glob(p, f)));
      const read = (named.length ? named : all).slice(0, STACK_MANIFESTS).map((f) => ({ f, deps: (SN.depsOf(f, readFile(f)) ?? []).map(low) }));
      for (const alt of c.alternatives)
        for (const m of read)
          if (m.deps.includes(low(alt))) out.push(`${c.id}: ${alt} is in ${m.f}, but ${c.id} chose ${c.tool ?? 'another tool'}${c.job ? ` for ${c.job}` : ''}`);
      if (c.tool && named.length && !read.some((m) => m.deps.includes(low(c.tool))))
        out.push(`${c.id}: ${c.tool} (the tool for ${c.job}) is in none of the manifests its paths name (${named.slice(0, 3).join(', ')})`);
    }
    if (c.tool && c.job)
      for (const p of prefer)
        if (low(p.purpose) === low(c.job) && !new RegExp(`(^|[^\\w@/.-])${c.tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w/-])`, 'i').test(p.use))
          out.push(`stack.md: the Prefer line for ${c.job} says "${p.use}", but ${c.id} chose ${c.tool}; make them agree (the Prefer line is the short form)`);
  }
  return out;
}

/**
 * The status that counts: `accepted` (or `not-building` for a rejection, roadmap 0f) only with the owner's record of
 * this exact version, else `unconfirmed`. A proposed or superseded choice is what it says.
 */
function effectiveStatus(d, ledger) {
  if (d?.status === 'not-building') {
    const rec = ledger?.decisions?.[d.id];
    return rec && rec.fingerprint === fingerprint(d) ? 'not-building' : 'unconfirmed';
  }
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
  // A rejection's accept (roadmap 0f) writes status not-building: the owner decided not to build it.
  const status = isNotBuilding(fm.data) ? 'not-building' : 'accepted';
  const stamp = [`status: ${status}`, `accepted_by: ${who}`, `accepted: ${String(now).slice(0, 10)}`];
  if (at >= 0) head.splice(at, 1, ...stamp);
  else head.push(...stamp);
  return { text: [all[0], ...head, ...all.slice(end)].join('\n'), error: null };
}

/**
 * The file text with status: superseded; every other line stays as it was (also accepted_by and accepted: they say who
 * accepted it while it held). Used by `catalog accept` of the choice that supersedes it (roadmap 0z Z-C), so the two
 * manual edits the format note asks for are one step. Only the owner's accept calls it.
 * @returns {{ text: string|null, error: string|null }}
 */
function supersededText(source) {
  const fm = parseFrontmatter(source);
  if (!fm.data) return { text: null, error: fm.errors.join('; ') };
  const all = lines(source);
  const at = all.findIndex((l, i) => i > 0 && i < fm.bodyStart - 1 && /^status:/.test(l));
  if (at < 0) all.splice(fm.bodyStart - 1, 0, 'status: superseded');
  else all[at] = 'status: superseded';
  return { text: all.join('\n'), error: null };
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
  // A "Not building" draft (roadmap 0f, lib/notBuilding.js draft): kind not-building, its keywords, revisit and source;
  // paths and invariant only when given (it binds no code). A design choice is written exactly as before.
  const nb = p.kind === 'not-building';
  const paths = Array.isArray(p.paths) ? p.paths : [];
  const fields = nb
    ? [
        'kind: not-building',
        ...(paths.length ? [`paths: ${JSON.stringify(paths)}`] : []),
        ...(one(p.invariant) ? [`invariant: ${frontValue(one(p.invariant))}`] : []),
        `keywords: ${JSON.stringify(Array.isArray(p.keywords) ? p.keywords : [])}`,
        `revisit: ${one(p.revisit) ? frontValue(one(p.revisit)) : 'null'}`,
        `source: ${one(p.source) ? frontValue(one(p.source)) : 'null'}`,
      ]
    : [
        // A kind other than decision, and except (roadmap 0å KD-0), only when given: a plain choice is written as before.
        ...(KINDS.includes(p.kind) && p.kind !== 'decision' ? [`kind: ${p.kind}`] : []),
        // A design entry's source (KD-1): where its tokens live, one path or a list.
        ...(Array.isArray(p.source) && p.source.length
          ? [`source: ${JSON.stringify(p.source)}`]
          : one(p.source) ? [`source: ${frontValue(one(p.source))}`] : []),
        // A stack entry's fields (KD-2), as JSON, only when given.
        ...(p.kind === 'stack' && isObject(p.uses) ? [`uses: ${JSON.stringify({ job: one(p.uses.job), tool: one(p.uses.tool) })}`] : []),
        ...(p.kind === 'stack' && Array.isArray(p.alternatives) && p.alternatives.length ? [`alternatives: ${JSON.stringify(p.alternatives)}`] : []),
        ...(p.kind === 'stack' && Array.isArray(p.stack) && p.stack.length ? [`stack: ${JSON.stringify(p.stack)}`] : []),
        `paths: ${JSON.stringify(paths)}`,
        ...(Array.isArray(p.except) && p.except.length ? [`except: ${JSON.stringify(p.except)}`] : []),
        `invariant: ${frontValue(one(p.invariant))}`,
        // A check rule (KD-1, the design draft's colour rule): one field per line, each value as JSON.
        ...(isObject(p.check) ? ['check:', ...Object.entries(p.check).map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)] : []),
      ];
  const text = [
    '---',
    `id: ${p.id}`,
    `title: ${frontValue(title)}`,
    'status: proposed',
    ...fields,
    `supersedes: ${p.supersedes ? p.supersedes : 'null'}`,
    `plan: ${p.plan ? p.plan : 'null'}`,
    '---',
    why || 'Context, the choice and what follows from it, in at most 30 lines.',
    '',
  ].join('\n');
  const r = parseDecision(name, text);
  return { name, text, errors: r.errors, warnings: r.warnings };
}

// ---- an owner's answer as a draft (roadmap 0z Z-A) -------------------------------------------------------------------

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const cutTo = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 3).replace(/\s+\S*$/, '')}...`);
/** At most this many paths a draft takes from the waiting tasks; more is no longer a narrow choice. */
const DRAFT_PATHS = 10;

/**
 * The fields of a proposed design choice from an owner's answer: the title from the question, the invariant from the
 * answer (both one line, cut to their caps), the paths from the owned_files of the tasks that wait on the question (a
 * folder "lib/" as "lib/**"; "**" when they name none), and the plan when they all share one. Only the question and the
 * answer go in, never a conversation. The owner sharpens it before the accept; the file says so.
 * @param {{ sp: string, question?: { text?: string }|null, answer: string, tasks?: object[] }} x
 */
function answerDraft({ sp, question = null, answer, tasks = [] }) {
  const q = oneLine(question?.text);
  const title = cutTo(q || `The owner's answer to ${sp}`, TITLE_MAX);
  const invariant = cutTo(oneLine(answer), INVARIANT_MAX);
  const paths = [];
  for (const t of tasks ?? [])
    for (const f of Array.isArray(t?.owned_files) ? t.owned_files : []) {
      if (typeof f !== 'string' || pathPatternError(f)) continue;
      const p = f.endsWith('/') ? `${f}**` : f;
      if (!paths.includes(p)) paths.push(p);
    }
  const plans = [...new Set((tasks ?? []).map((t) => t?.plan).filter((p) => typeof p === 'string' && PLAN_PATTERN.test(p)))];
  const why = [
    `From the owner's answer to ${sp}${q ? `: "${cutTo(q, 200)}"` : ''}.`,
    'A draft: make the invariant one sentence that can be checked and narrow the paths before you accept it.',
  ].join('\n');
  return { title, invariant, paths: paths.length ? paths.slice(0, DRAFT_PATHS) : ['**'], plan: plans.length === 1 ? plans[0] : null, why };
}

/**
 * Whether a text reads like a lasting rule (catalog.captureAnswers suggest, plugin/docs/catalog.md "What belongs in the
 * catalog"): a word that reaches past the task (always, never, from now on, every time, by default; the same in
 * Norwegian), and no word that limits it to now (this time, for now, just once). A bare pick ("Vendor B") is not one.
 * A hint only: it never writes anything.
 */
function looksLasting(textIn) {
  const t = oneLine(textIn).toLowerCase();
  if (!t) return false;
  // A whole word or phrase: no letter or digit right before or after (\b does not see the Norwegian letters as letters).
  const has = (phrase) => new RegExp(`(?<![\\p{L}\\p{N}])${phrase}(?![\\p{L}\\p{N}])`, 'u').test(t);
  const now = ['this time', 'for now', 'just once', 'only (?:here|now|today)', 'denne gangen', 'foreløpig', 'bare nå', 'i dag'];
  if (now.some(has)) return false;
  const lasting = ['always', 'never', 'from now on', 'every time', 'by default', 'in general', 'alltid', 'aldri', 'fra nå av', 'hver gang', 'som standard'];
  return lasting.some(has);
}

// ---- a design draft (roadmap 0å KD-1) -------------------------------------------------------------------------------

/**
 * The colour rule a design draft proposes: a hex colour or rgb()/hsl() in code that should use tokens. Tuned so it does
 * not hit what is not a colour: an issue number (#123 in the text), an anchor (href="#add"), an HTML entity (&#123456;),
 * a CSS id selector (#fed {) and color-mix(in srgb, ...). A 6 or 8 digit hex counts anywhere a # starts a value; a 3 or
 * 4 digit one only after a colon, comma, bracket or space and not before a selector character or a word.
 * (The design doc's first rule hit its own miss examples #123 and href="#add"; this one is tested against them.)
 */
const COLOUR_RULE = Object.freeze({
  forbid:
    '(?<![\\w&/=?#])#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\\b|(?:^|[:,(]|\\s)#[0-9a-fA-F]{3,4}\\b(?![\\w-]|\\s*[{.:\\[>~+]|\\s+[A-Za-z])|\\b(?:rgb|hsl)a?\\(',
  hit: ['  color: #1a73e8;', 'background: rgba(0,0,0,.4)', '  border: 1px solid #ccc;'],
  miss: ['color: var(--color-primary);', 'see issue #123 in the tracker', '<a href="#add">', '#fed {', 'color-mix(in srgb, var(--color-on-surface) 8%, transparent)'],
  mode: 'warn',
});
/** The files a draft looks at for CSS custom properties: at most this many, none over TREE_FILE_BYTES. */
const DRAFT_CSS_FILES = 200;
/** The UI files a token file at the project root covers (a folder's token file covers its folder). */
const UI_GLOBS = Object.freeze(['**/*.css', '**/*.scss', '**/*.less', '**/*.tsx', '**/*.jsx', '**/*.vue', '**/*.svelte']);

/**
 * A proposed design entry from the project's token file (`catalog init`, KD-1), or null when there is none. The token
 * file is the first of: a CSS file with :root and --color- custom properties, tailwind.config.*, a tokens.json, a
 * theme.ts or theme.js. The entry names it in source (the tokens stay there), covers its folder (or the UI files when
 * it is at the root), excepts the token file itself and carries COLOUR_RULE. It is a draft: status proposed, the owner
 * narrows it and accepts it, or deletes it.
 * @param {{ files: string[], readFile: (p: string) => string|null }} x
 */
function designDraft({ files, readFile }) {
  const skip = (f) => /(^|\/)(node_modules|dist|build|vendor|\.git)\//.test(f) || require('./reviewSignals.js').isTestPath(f);
  const all = (files ?? []).filter((f) => typeof f === 'string' && !skip(f));
  const base = (f) => f.split('/').pop();
  const cssTokens = () => {
    for (const f of all.filter((x) => /\.(css|scss|less)$/.test(x)).slice(0, DRAFT_CSS_FILES)) {
      const body = readFile(f);
      if (typeof body === 'string' && body.length <= TREE_FILE_BYTES && /:root\b/.test(body) && /--color-/.test(body)) return f;
    }
    return null;
  };
  const token =
    cssTokens() ??
    all.find((f) => /^tailwind\.config\.(js|cjs|mjs|ts)$/.test(base(f))) ??
    all.find((f) => /^(design-)?tokens\.json$|\.tokens\.json$/.test(base(f))) ??
    all.find((f) => /^theme\.(ts|js|tsx|mjs)$/.test(base(f))) ??
    null;
  if (!token) return null;
  const folder = token.includes('/') ? token.slice(0, token.lastIndexOf('/')) : '';
  return {
    kind: 'design',
    title: 'Colours only from the design tokens',
    source: [token],
    paths: folder ? [`${folder}/**`] : [...UI_GLOBS],
    except: [token],
    invariant: `UI code takes its colours from the tokens in ${token}; a hex colour or rgb() stands only in the token file.`,
    check: { ...COLOUR_RULE, hit: [...COLOUR_RULE.hit], miss: [...COLOUR_RULE.miss] },
    why: [
      `A draft from ravenseat catalog init: ${token} looks like the project's token file.`,
      'Narrow the paths to the UI code, add more token files to source and except if there are any, run',
      '`ravenseat catalog check` to see what the rule already hits, then accept it or delete the file.',
    ].join('\n'),
  };
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
  const mine = files.filter((f) => !RS.isTestPath(f) && covers(d, f, glob)).slice(0, TREE_FILES);
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
    if (st === 'unconfirmed' && d.status === 'not-building')
      errors.push(
        `${d.id} says not-building, but the owner did not accept this version (the keywords differ, or the line was set by hand). ` +
          `If the owner decided it: ${cli} catalog accept ${d.id} --by owner. Until then no proposal is matched against it.`,
      );
    else if (st === 'unconfirmed')
      errors.push(
        `${d.id} says accepted, but the owner did not accept this version (the invariant, paths or check differ, or the line was set by hand). ` +
          `If it is the owner's choice: ${cli} catalog accept ${d.id} --by owner. Until then it counts as proposed.`,
      );
    if (files && d.paths.length && !files.some((f) => d.paths.some((p) => glob(p, f))))
      warnings.push(`${d.id} (${d.file}): its paths match no tracked file: ${d.paths.join(', ')}`);
    else if (files && d.paths.length && !files.some((f) => covers(d, f, glob)))
      warnings.push(`${d.id} (${d.file}): its except leaves no tracked file of its paths: ${d.except.join(', ')}`);
    for (const p of files && d.except?.length ? d.except : [])
      if (!files.some((f) => d.paths.some((q) => glob(q, f)) && glob(p, f)))
        warnings.push(`${d.id} (${d.file}): except ${p} matches no tracked file inside its paths`);
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
  // An accepted stack entry against the manifests and the Prefer lines (roadmap 0å KD-2), like the block below.
  warnings.push(...stackWarnings(cat, { files, readFile: ctx.readFile ?? null, ledger: ctx.ledger ?? emptyLedger(), glob }));
  // A Dependencies row (roadmap 0å KD-3) for a package that is in no manifest: a removed library, or a typo.
  if (files && ctx.readFile && cat.stack?.deps?.length) {
    const SN = require('./scopeNotes.js');
    const key = (s) => String(s ?? '').toLowerCase().replace(/[-_.]+/g, '-');
    const named = new Set();
    for (const f of files.filter((x) => SN.isManifest(x)).slice(0, STACK_MANIFESTS)) for (const n of SN.depsOf(f, ctx.readFile(f)) ?? []) named.add(key(n));
    for (const r of cat.stack.deps)
      if (!named.has(key(r.package))) warnings.push(`stack.md: the Dependencies row ${r.package} names a package that is in no manifest`);
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

/**
 * The libraries by job a manifest already has (the purpose groups of dependency-purposes.json). Any manifest
 * lib/manifests.js reads: package.json, requirements*.txt and, since roadmap 0å KD-3, pyproject.toml, Cargo.toml, go.mod.
 */
function jobsOf(manifests, purposes = require('./scopeNotes.js').PURPOSES) {
  const SN = require('./scopeNotes.js');
  const out = [];
  for (const m of manifests ?? []) {
    const eco = require('./manifests.js').ecosystemOf(m.path);
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
      `<!-- ${PREFER_INTRO} -->`,
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
  '- `paths`: the files the choice applies to. `except` (optional): files inside them it does not apply to.',
  '- `kind` (optional): `decision` (the default), `design`, `stack`, `dependency` or `not-building`.',
  '- `source` on a `design` entry: where its tokens live, a path or a list (`["ui/tokens.css", "lib/theme.js#PALETTE"]`).',
  '- On a `stack` entry: `uses: {"job": "dates", "tool": "dayjs"}`, `alternatives: ["moment"]` (chosen against) and',
  '  `stack: ["pnpm"]` (words for the checks). Accepted, they reach the Checks tab and the dependency notes at receive.',
  '- To change an accepted choice, write a new one with `supersedes: D-0001`; its accept sets the old one to `superseded`.',
  '- `plan`: the plan entry with the long version, if there is one. A plan entry links back with `decisions`.',
  '',
].join('\n');

module.exports = {
  DIR,
  STATUSES,
  FIELDS,
  KINDS,
  KIND_TITLES,
  KEYWORDS_MAX,
  KEYWORD_MAX,
  isNotBuilding,
  covers,
  boardGroups,
  COLOUR_RULE,
  designDraft,
  STACK_FIELDS,
  stackChoices,
  declaredStacks,
  withDeclaredStacks,
  ID_PATTERN,
  BLOCK_BEGIN,
  BLOCK_END,
  LEDGER_FILE,
  DEFAULTS,
  CHOICES,
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
  visibleLines,
  cells,
  readCatalog,
  emptyLedger,
  parseLedger,
  fingerprint,
  effectiveStatus,
  recordAccept,
  acceptText,
  supersededText,
  nextDecisionId,
  slugOf,
  proposalFile,
  answerDraft,
  looksLasting,
  checkCatalog,
  stackBlock,
  jobsOf,
  stackWithBlock,
};
