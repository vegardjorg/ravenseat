// =============================================================
// taskLinks.js: the documents behind a task, found and checked in one place (roadmap 0p2, step B1).
//
// WHY: a task should link to an id and let the path be looked up when it is needed, like a foreign key. The plan entry
// (`plan` on the task) owns the paths, anchors and roles of its documents; the task's optional `sources` narrows that
// to the part one task needs ("of PL-AUTH, read only § 2"); and `source` is origin only ("review of AUTH-2, finding
// M1"), never reading material. Before this, the validated link (`plan`) never reached the agent, and a gitignored
// document was written as a relative path an agent in a worktree could not open.
//
// This module only answers "which documents, and what state are they in". Three later steps use the same answer:
//   - B2: the WARNING line in add/edit (`problems`) and the doctor row (`counts`);
//   - B3: the mission's read-first list (`read`, each with `entry`: the path to read plus a line range, and an
//     absolute main-tree path for a gitignored file) and the private line (`private`);
//   - V3: plan check, which reports an anchor that finds no heading (`anchorHit: false`).
//
// Pure: no I/O. The caller passes a file reader (worktree, then main tree), a gitignore test (git check-ignore) and
// the main tree's absolute path. The section lookup is the mission's own sectionArea (missionText.js), so a "§ 2"
// finds the same lines here as in the mission.
//
//   taskLinks(task, ctx)  the links of one task, checked: { plan, narrowed, links, read, private, overCap, problems, counts }
//   sourcePaths(text)     the repo-relative file paths (with an optional § N or #anchor) in a source text
//   anchorQuery(anchor)   an anchor as sectionArea's input: { section } for a number, { anchor } for heading text
//   READABLE_ROLES        the source roles that are reading material
//   LINKS_MAX             the cap on readable links (the read-first list's cap)
// B2 (the WARNING line, the doctor row and plan check's anchor check):
//   linksSetup(config)    the switches links.addWarn and links.doctor (both on by default)
//   warningLine(rows)     the ONE WARNING line for add/edit, or null
//   doctorTotals(tasks, linksOf) / doctorMessage(totals)   the doctor row's counts and text (counts only)
//   anchorHits(text, anchor)  does an anchor find a heading (plan check, V3)
// B3 (the mission):
//   missionLines(result)  the READ and PRIVATE header lines of the track block (make-mission.mjs reads them)
//
// Used by: cli/taskLinksCheck.mjs (add, edit, doctor, the track block), lib/queuePlan.js (plan check).
// Tested in: lib/__tests__/taskLinks.test.ts, lib/__tests__/taskLinksCli.test.ts, lib/__tests__/missionLinks.test.ts.
// =============================================================
'use strict';

const path = require('node:path');
const { sectionArea, READ_FIRST_MAX } = require('../missionText.js');
const PP = require('./privatePaths.js');

/**
 * The source roles that are reading material. A source without a role counts as `plan` (the entry's own plan
 * document), as in plan check, which skips only history and reference (queuePlan.js SOURCE_ROLES_WITHOUT_STATUS).
 */
const READABLE_ROLES = ['plan', 'investigation', 'spec'];

/** The most readable links one task gets: the same cap as the mission's read-first list, which they end up in. */
const LINKS_MAX = READ_FIRST_MAX;

/** Is this role reading material? A missing role is the plan itself. */
const readableRole = (role) => role == null || READABLE_ROLES.includes(role);

/**
 * An anchor as written in a plan entry or a task ("§ 3.2", "3.2", "#sync", "Sync") turned into sectionArea's input:
 * a number becomes { section }, anything else { anchor } as a lower-case slug. Null for an empty anchor.
 * @param {unknown} anchor
 * @returns {{ section: string } | { anchor: string } | null}
 */
function anchorQuery(anchor) {
  if (typeof anchor !== 'string') return null;
  const a = anchor.trim();
  if (!a) return null;
  const num = a.match(/^(?:§\s*)?(\d+(?:\.\d+)*)\.?$/);
  if (num) return { section: num[1] };
  const text = a.replace(/^#+\s*/, '').trim().toLowerCase().replace(/\s+/g, '-');
  return text ? { anchor: text } : null;
}

/** The dedupe key of a link: the path and the anchor in its looked-up form, so "§ 3.2" and "3.2" are the same. */
function linkKey(p, anchor) {
  const q = anchorQuery(anchor);
  const a = !q ? '' : 'section' in q ? `s:${q.section}` : `a:${q.anchor}`;
  return `${p}\u0000${a}`;
}

// A repo-relative file path in free text: path parts of word characters, @ + . -, joined by "/", ending in an
// extension. Optionally followed by "#anchor" or " § N". A backtick around the path is allowed.
const SOURCE_PATH =
  /(^|[\s(`'"[,;])((?:[\w@+-][\w@+.-]*\/)*[\w@+-][\w@+.-]*\.[A-Za-z0-9]+)(?:#([\p{L}\p{N}_-]+)|`?\s*§\s*(\d+(?:\.\d+)*))?/gu;

/**
 * The repo-relative file paths in a source text, in order, each with its anchor (or null). A URL, an absolute path,
 * a ".." escape and plain text give nothing. Never throws.
 * @param {unknown} text
 * @returns {{ path: string, anchor: string|null }[]}
 */
function sourcePaths(text) {
  if (typeof text !== 'string' || !text) return [];
  const out = [];
  for (const m of text.matchAll(SOURCE_PATH)) {
    const start = m.index + m[1].length;
    // Part of a URL ("https://x.org/a.md"), an absolute path ("C:/x/y.md", "/etc/x.md") or "../up.md": the path
    // then starts right after a slash, a backslash, a dot or a colon.
    if (/[\\/.:]$/.test(text.slice(0, start))) continue;
    const p = PP.projectPath(m[2]);
    if (!p || p !== m[2].replace(/^\.\//, '')) continue;
    // A version number or a date ("18.11") is not a file: it needs a folder or a letter in the extension.
    if (!p.includes('/') && !/\.[A-Za-z][A-Za-z0-9]*$/.test(p)) continue;
    out.push({ path: p, anchor: m[3] ? `#${m[3]}` : m[4] ? `§ ${m[4]}` : null });
  }
  return out;
}

/** Calls a helper, and gives `fallback` when it is missing or throws (a broken helper never stops the lookup). */
function safe(fn, args, fallback) {
  if (typeof fn !== 'function') return fallback;
  try {
    return fn(...args);
  } catch {
    return fallback;
  }
}

/** The plan entry behind the task's `plan`, and its state: none, found, merged (archive) or unknown. */
function planOf(task, register) {
  const id = typeof task?.plan === 'string' && task.plan ? task.plan : null;
  if (!id) return { plan: { id: null, state: 'none' }, entry: null };
  const entry = (Array.isArray(register?.entries) ? register.entries : []).find((p) => p?.id === id) ?? null;
  if (entry) return { plan: { id, state: 'found' }, entry };
  const merged = register?.archive?.[id];
  if (merged) return { plan: { id, state: 'merged', mergedTo: merged.merged_to ?? null }, entry: null };
  return { plan: { id, state: 'unknown' }, entry: null };
}

/** A list of { path, anchor?, role? } objects, with anything else dropped. */
const sourceList = (v) => (Array.isArray(v) ? v.filter((k) => k && typeof k === 'object' && typeof k.path === 'string') : []);

/**
 * The links of a task, each checked, in a stable order without duplicates.
 *
 * Order: the task's own `sources` when it has any (they narrow the plan, so the plan's sources are then left out,
 * `narrowed: true`), otherwise the plan entry's sources with a readable role; then the paths in `source` (origin only,
 * never read). Dedupe is on path and anchor, first one wins, so a readable link beats its origin copy. A task source
 * with a non-readable role (history, reference) is checked but not read.
 *
 * @param {object} task  the queue task (plan, sources, source)
 * @param {{
 *   register?: { entries?: object[], archive?: object },   the plan register (plans.json)
 *   readFile?: (relPath: string) => string|null,          the document's text (worktree, then main tree), null when missing
 *   isIgnored?: (relPath: string) => boolean,             is the path gitignored (git check-ignore)
 *   mainRoot?: string,                                    the main tree's absolute path, for gitignored files
 *   config?: object,                                      queue.config.json (privatePaths)
 *   max?: number,                                         the cap on readable links (LINKS_MAX)
 * }} [ctx]
 * @returns {{
 *   plan: { id: string|null, state: 'none'|'found'|'merged'|'unknown', mergedTo?: string|null },
 *   narrowed: boolean,
 *   links: Link[],          every link found, checked (readable and origin)
 *   read: Link[],           the readable links an agent may open (exist, not private), within the cap
 *   private: Link[],        the readable links under privatePaths with read: false, within the cap
 *   overCap: number,        the readable links left out by the cap
 *   problems: { kind: 'plan'|'dead'|'anchor'|'ignored', ... }[],
 *   counts: { links, readable, dead, anchorMiss, ignored, private, nothingToRead },
 * }}
 *
 * A Link is { path, anchor, role, from: 'plan'|'sources'|'source', planId?, readable, exists, anchorHit, lines,
 * ignored, private, readPath, entry }:
 *   anchorHit  true/false when there is an anchor and the file exists, otherwise null;
 *   lines      { from, to } (1-based, inclusive) when the anchor hit, otherwise null (read the whole file);
 *   readPath   the path the agent opens: repo-relative for a tracked file, the absolute main-tree path for a
 *              gitignored one; null when the file is missing or private;
 *   entry      readPath plus ":from-to" when there is a line range (the read-first list's form), or null.
 */
function taskLinks(task, ctx = {}) {
  const max = Number.isInteger(ctx.max) && ctx.max >= 0 ? ctx.max : LINKS_MAX;
  const { plan, entry } = planOf(task, ctx.register);
  const own = sourceList(task?.sources);
  const narrowed = own.length > 0;

  // 1. The candidates, in order.
  const candidates = [];
  if (narrowed) for (const k of own) candidates.push({ ...k, from: 'sources', readable: readableRole(k.role ?? null) });
  else
    for (const k of sourceList(entry?.sources))
      if (readableRole(k.role ?? null)) candidates.push({ ...k, from: 'plan', planId: plan.id, readable: true });
  for (const k of sourcePaths(task?.source)) candidates.push({ ...k, from: 'source', readable: false });

  // 2. Normalised and deduplicated (first one wins). A path that is not inside the project is dropped: plan check
  //    and the sources shape check (B4) refuse it where it is written.
  const seen = new Set();
  const links = [];
  for (const c of candidates) {
    const p = PP.projectPath(c.path);
    if (!p) continue;
    const anchor = typeof c.anchor === 'string' && c.anchor.trim() ? c.anchor.trim() : null;
    const key = linkKey(p, anchor);
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(check({ ...c, path: p, anchor, role: c.role ?? null }, ctx));
  }

  // 3. The readable ones within the cap, split into what the agent opens and what is private.
  const readable = links.filter((l) => l.readable && l.exists);
  const kept = readable.slice(0, max);
  const read = kept.filter((l) => !l.private);
  const priv = kept.filter((l) => l.private);

  // 4. Problems, for the add/edit warning and the doctor row. An origin path is checked for dead and anchor only:
  //    being gitignored does not matter for something nobody reads.
  const problems = [];
  if (plan.state === 'unknown' || plan.state === 'merged')
    problems.push(plan.state === 'merged' ? { kind: 'plan', id: plan.id, mergedTo: plan.mergedTo } : { kind: 'plan', id: plan.id });
  for (const l of links) {
    const where = { path: l.path, anchor: l.anchor, from: l.from };
    if (!l.exists) problems.push({ kind: 'dead', ...where });
    else if (l.anchorHit === false) problems.push({ kind: 'anchor', ...where });
    if (l.exists && l.readable && l.ignored && !l.private) problems.push({ kind: 'ignored', ...where });
  }

  return {
    plan,
    narrowed,
    links,
    read,
    private: priv,
    overCap: readable.length - kept.length,
    problems,
    counts: {
      links: links.length,
      readable: readable.length,
      dead: links.filter((l) => !l.exists).length,
      anchorMiss: links.filter((l) => l.anchorHit === false).length,
      ignored: readable.filter((l) => l.ignored && !l.private).length,
      private: readable.filter((l) => l.private).length,
      nothingToRead: readable.length === 0,
    },
  };
}

/** One link checked: exists, anchor, gitignored, private, and the path and entry the agent reads. */
function check(link, ctx) {
  const text = safe(ctx.readFile, [link.path], null);
  const exists = typeof text === 'string';
  const q = anchorQuery(link.anchor);
  const lines = exists && q ? sectionArea(text, q) : null;
  const anchorHit = exists && q ? lines != null : null;
  const ignored = exists && safe(ctx.isIgnored, [link.path], false) === true;
  const closed = PP.matching(link.path, ctx.config);
  const isPrivate = Boolean(closed && closed.read === false);
  let readPath = null;
  if (exists && !isPrivate)
    readPath =
      ignored && typeof ctx.mainRoot === 'string' && ctx.mainRoot
        ? path.join(ctx.mainRoot, link.path).replace(/\\/g, '/')
        : link.path;
  const entry = readPath == null ? null : lines ? `${readPath}:${lines.from}-${lines.to}` : readPath;
  return { ...link, exists, anchorHit, lines, ignored, private: isPrivate, readPath, entry };
}

// ---- B2: the add/edit warning (V1) and the doctor row (V2) ---------------------------------------------------------
//
// Pure, like the rest of this file: the CLI (cli/taskLinksCheck.mjs) runs taskLinks with the real file reader and git
// check-ignore, and these turn the answers into the one WARNING line and the counts of the doctor row.

/** The statuses of a task that is finished with: its links are no longer read by anyone, so doctor skips them. */
const CLOSED_STATUSES = ['done', 'cancelled'];

/**
 * The two switches of B2 from queue.config.json `links`: `addWarn` (the add/edit line) and `doctor` (the doctor row).
 * Both on by default; only a boolean false turns one off (any other value keeps the default, as in catalog setupOf).
 * @param {object} [config]
 * @returns {{ addWarn: boolean, doctor: boolean }}
 */
function linksSetup(config) {
  const own = config && typeof config.links === 'object' && config.links && !Array.isArray(config.links) ? config.links : {};
  return { addWarn: own.addWarn !== false, doctor: own.doctor !== false };
}

/**
 * Where a link was written, as the reader of the warning knows it: "PL-AUTH source docs/a.md" for a plan entry's
 * source, "sources docs/a.md" for the task's own `sources`, "source text docs/a.md" for a path in `source`.
 */
function whereText(problem, planId) {
  const p = `${problem.path}${problem.anchor ? ` ${problem.anchor}` : ''}`;
  if (problem.from === 'plan') return `${planId ?? 'plan'} source ${p}`;
  if (problem.from === 'sources') return `sources ${p}`;
  return `source text ${p}`;
}

/** One problem from taskLinks as a short phrase (no file content, only the path and the anchor the author wrote). */
function problemText(problem, planId) {
  if (problem.kind === 'plan')
    return problem.mergedTo !== undefined
      ? `plan ${problem.id} was merged${problem.mergedTo ? ` into ${problem.mergedTo}` : ''}`
      : `plan ${problem.id} is not in the plan register`;
  if (problem.kind === 'dead') return `${whereText({ ...problem, anchor: null }, planId)} is missing`;
  if (problem.kind === 'anchor') return `${whereText(problem, planId)} finds no heading`;
  if (problem.kind === 'ignored')
    return `${whereText({ ...problem, anchor: null }, planId)} is gitignored, so an agent's worktree does not have it`;
  return `${whereText(problem, planId)}: ${problem.kind}`;
}

/** How many problems the one line names before it says "and N more" (a list of 40 tasks must stay one readable line). */
const WARNING_MAX = 6;

/**
 * The ONE WARNING line for add or edit (V1), or null when no task has a problem. Each problem is "<task id>: <phrase>";
 * the line ends with what to do. The task is saved either way: the line only tells the author while it is cheap to fix.
 * @param {{ id: string, plan?: string|null, problems: object[] }[]} rows  one row per task added or edited
 * @param {{ verb?: string, cli?: string }} [o]  verb: 'added' (add) or 'changed' (edit); cli: the command to name
 *   in the hint (projectRoot cliCommand: `ravenseat`, or the node form in a vendored install)
 * @returns {string|null}
 */
function warningLine(rows, { verb = 'added', cli = 'ravenseat' } = {}) {
  const all = [];
  for (const r of Array.isArray(rows) ? rows : [])
    for (const p of r?.problems ?? []) all.push(`${r.id}: ${problemText(p, r.plan ?? null)}`);
  if (!all.length) return null;
  const shown = all.slice(0, WARNING_MAX).join('; ');
  const more = all.length > WARNING_MAX ? `; and ${all.length - WARNING_MAX} more` : '';
  return (
    `WARNING: task links: ${shown}${more}. The task was ${verb} anyway; fix a plan source with ${cli} plan edit, ` +
    `a task link with ${cli} edit <id>.`
  );
}

/** Does the task link to reading material at all (a plan id, or its own sources)? Only then is "nothing to read" a gap. */
const linksSomewhere = (task) =>
  (typeof task?.plan === 'string' && task.plan !== '') || (Array.isArray(task?.sources) && task.sources.length > 0);

/**
 * The doctor counts over the open tasks (V2). `linksOf(task)` is taskLinks for that task (the caller holds the I/O).
 * "Nothing to read" counts only tasks that link somewhere and still end up with nothing readable: a task without a
 * plan or sources has nothing to read by design.
 * @param {object[]} tasks
 * @param {(task: object) => { counts: object } | null | undefined} linksOf
 * @returns {{ tasks: number, dead: number, anchorMiss: number, ignored: number, private: number, nothingToRead: number }}
 */
function doctorTotals(tasks, linksOf) {
  const t = { tasks: 0, dead: 0, anchorMiss: 0, ignored: 0, private: 0, nothingToRead: 0 };
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!task || typeof task !== 'object' || CLOSED_STATUSES.includes(task.status)) continue;
    t.tasks += 1;
    const c = safe(linksOf, [task], null)?.counts;
    if (!c) continue;
    t.dead += c.dead || 0;
    t.anchorMiss += c.anchorMiss || 0;
    t.ignored += c.ignored || 0;
    t.private += c.private || 0;
    if (c.nothingToRead && linksSomewhere(task)) t.nothingToRead += 1;
  }
  return t;
}

/**
 * The doctor row's message, counts only, or null when there is nothing to report. Private links are named in the
 * message when there is a finding, but are no finding on their own: a private plan is a choice, not a fault.
 */
function doctorMessage(t) {
  if (!t || !(t.dead || t.anchorMiss || t.ignored || t.nothingToRead)) return null;
  const parts = [
    t.dead ? `${t.dead} dead link(s)` : null,
    t.anchorMiss ? `${t.anchorMiss} anchor(s) without a heading` : null,
    t.ignored ? `${t.ignored} gitignored source(s)` : null,
    t.private ? `${t.private} private link(s)` : null,
    t.nothingToRead ? `${t.nothingToRead} task(s) with nothing to read` : null,
  ].filter(Boolean);
  return `open tasks: ${parts.join(', ')} (${t.tasks} open task(s) checked)`;
}

/**
 * Does the anchor find a heading in the text (plan check, V3)? The same lookup as taskLinks and the mission
 * (anchorQuery + sectionArea), so plan check, the add warning and the read-first list never disagree. An empty or
 * missing anchor is no miss.
 */
function anchorHits(text, anchor) {
  const q = anchorQuery(anchor);
  if (!q || typeof text !== 'string') return true;
  return sectionArea(text, q) != null;
}

// ---- B3: the mission's read-first list ------------------------------------------------------------------------------
//
// The orchestrator (cli/taskLinksCheck.mjs missionLinkLines, called from the track block in cli/tracks.mjs) writes a
// task's links as header lines of its track block, before the "## TRACK" heading; make-mission.mjs reads them and
// puts them first in the read-first list (missionText.js readFirstList):
//   READ: <entry>      a link the agent opens: "docs/plan.md:6-7", or the absolute main-tree path of a gitignored file
//   PRIVATE: <label>   a private link (privatePaths read: false): the agent asks the orchestrator for an excerpt
// The track agent never runs this: taskLinks reads private files to check them, which is the orchestrator's job.

/** A private link as the agent sees it: the repo-relative path and its anchor ("docs/x.md § 2", "docs/x.md #sync"). */
function privateLabel(link) {
  const q = anchorQuery(link.anchor);
  if (!q) return link.path;
  return 'section' in q ? `${link.path} § ${q.section}` : `${link.path} #${q.anchor}`;
}

/**
 * The track block header lines for a taskLinks answer: READ lines for `read` (in order), then PRIVATE lines for
 * `private`, both within the cap taskLinks applied. [] for a task without readable links (an origin-only `source`
 * gives nothing). A value with a line break is left out: one header line must stay one line.
 * @param {{ read?: object[], private?: object[] } | null | undefined} result
 * @returns {string[]}
 */
function missionLines(result) {
  const oneLine = (s) => typeof s === 'string' && s !== '' && !/[\r\n]/.test(s);
  const out = [];
  for (const l of result?.read ?? []) if (oneLine(l?.entry)) out.push(`READ: ${l.entry}`);
  for (const l of result?.private ?? []) if (oneLine(l?.path) && oneLine(privateLabel(l))) out.push(`PRIVATE: ${privateLabel(l)}`);
  return out;
}

module.exports = {
  taskLinks,
  missionLines,
  sourcePaths,
  anchorQuery,
  anchorHits,
  linksSetup,
  problemText,
  warningLine,
  doctorTotals,
  doctorMessage,
  READABLE_ROLES,
  LINKS_MAX,
  CLOSED_STATUSES,
};
