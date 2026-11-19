// =============================================================
// missionText.js: pure text logic for make-queue-common.mjs and make-mission.mjs. See docs/orchestration.md.
//
// Why: the shared protocol is pasted into EVERY track prompt and stays in the context for all turns. The parts that
// only apply to D and D+ (DB, self-review, full gate) therefore sit in class sections that are only included for the
// classes that need them, and pointers such as "file.md § 3" get their line range appended, so the track reads only that section.
//
//   makeQueueCommon(template, scratch, k, addendum) the shared part of the mission template (docs/queue/mission-template.md), filled for queue and
//                                project (k = config(): projectName, baseBranch, gates, architectureRules) and for the
//                                client (addendum = its missionAddendum function; Claude Code when it is left out)
//   fillClient(text, pieces, eol) fills the <CLIENT_*> placeholders from addendum.template
//   filterClass(text, k)      keeps only the <!-- class: … --> … <!-- /class --> sections that apply to class k
//   classFromBlock(body)        the class in a track block ("class D+" in the ## TRACK line, or a CLASS: line)
//   sectionPointers(text, read)   appends "(line A–B)" after "file.md § N" and "file.md#heading"
//   readFirstPaths(text, exists)  the existing repo paths a mission names, for the block at its top (readFirstBlock)
//   readFirstList(text, exists, o)  the same list with the task's links first, placed paths and private lines
//                                (roadmap 0p2 B3), under the one cap; privateBlock(list) writes the private lines
// No I/O here (the read and exists functions and the config are injected; repoFileExists and repoFileRoot make the
// real ones); tests: __tests__/missionText.test.ts, __tests__/missionReadFirst.test.ts and
// lib/__tests__/missionLinks.test.ts.
// =============================================================

const CLASSES = ['K', 'D', 'D+', 'U'];

// The default client's mission addendum (the registry's first adapter, today's Claude text); a caller for another
// client passes its own adapter's missionAddendum.
const defaultAddendum = (ctx) => require('./lib/clients/index.js').clientFor().missionAddendum(ctx);

// Split/join, never String.replace (a replacement containing "$'" duplicates text).
const swap = (s, from, to) => s.split(from).join(to);

const CODE = '`';

/** The gate list as text: the commands in order, or "none set up". */
function gateText(list) {
  const l = Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x.trim()) : [];
  return l.length ? l.map((x) => CODE + x + CODE).join(', ') : 'none set up in queue.config.json';
}

/**
 * Fills the client placeholders (<CLIENT_NAME>) from pieces (NAME -> text). A line that holds only a placeholder whose
 * value is '' is dropped, so a client without that piece leaves no empty bullet. A line break in a piece becomes eol,
 * the template's own line ending (the Claude text was part of the template before the split, so it keeps its bytes).
 * A placeholder without a piece is left as it is (make-queue-common.mjs warns about unfilled placeholders).
 * @param {string} text
 * @param {Record<string, string>} [pieces]
 * @param {string} [eol] '\n' or '\r\n'
 */
function fillClient(text, pieces = {}, eol = '\n') {
  let s = String(text);
  for (const [name, value] of Object.entries(pieces ?? {})) {
    const mark = `<CLIENT_${name}>`;
    if (value === '') s = swap(swap(s, `\n${mark}\r\n`, '\n'), `\n${mark}\n`, '\n');
    s = swap(s, mark, swap(String(value), '\n', eol));
  }
  return s;
}

/**
 * Shared protocol for the queue tracks, with the placeholders __BRANCH__ __HEAD__ __TRACK__ __BLOCK__ left in (they are
 * filled per track by make-mission.mjs). The class markers are kept; make-mission filters per track.
 * @param {string} template the whole mission template (docs/queue/mission-template.md)
 * @param {string} scratch the scratchpad root
 * @param {{ projectName?: string, baseBranch?: string, gates?: { quick?: string[], full?: string[] },
 *   architectureRules?: string[] }} [k] the project config (config()); missing fields give neutral defaults
 * @param {(ctx: object) => { template?: Record<string, string>, readExcerpts?: string, newWorkWrite?: string }} [missionAddendum]
 *   the client's mission addendum (lib/clients/<client>/mission.js); default Claude Code
 */
function makeQueueCommon(template, scratch, k = {}, missionAddendum = defaultAddendum) {
  const addendum = missionAddendum({});
  const start = template.search(/^## Common protocol/m);
  if (start < 0) throw new Error('could not find "## Common protocol" in the mission template');
  const base = k.baseBranch || 'main';
  const rules = Array.isArray(k.architectureRules)
    ? k.architectureRules.filter((r) => typeof r === 'string' && r.trim())
    : [];
  // The template's line endings depend on the checkout (autocrlf on Windows). Work on LF so a mission has the same
  // text on every platform: a CRLF template used to keep one blank line more after filterClass.
  let s = template.slice(start).replace(/\r\n/g, '\n');
  // Client pieces first: they sit in the template text.
  s = fillClient(s, addendum.template, '\n');
  // Saver mode: the track reads only its own part of the source, in excerpts.
  s = swap(
    s,
    '<READ_ALSO>',
    [
      'The source the track block names: read only the part that applies to this track (`grep -n` on the id or',
      `  heading, then excerpts${addendum.readExcerpts ?? ''}).`,
      ...(rules.length
        ? ['- The project architecture rules (binding, from `queue.config.json`):', ...rules.map((r) => `  - ${r}`)]
        : []),
    ].join('\n'),
  );
  s = swap(
    s,
    '<OWNERSHIP>',
    [
      'Your ownership is listed in the track block. Other tasks run at the same time and own their files',
      `(\`${require('./lib/projectRoot.js').cliCommand()} show\`, works from the worktree). Never touch what they own.`,
      '',
      // Here and not in the template: a project keeps its own copy of the template, and this reaches it with the plugin update.
      '**New work you discover** (outside the mission, or a follow-up bug): do not build it, propose it:',
      `\`${require('./lib/projectRoot.js').cliCommand()} add --json '{"id":"<new id>","title":"<short title>","mission":"<what, why, where, how to check it>"}'\`.`,
      'That is all it needs: it waits for approval, the owner decides its size and priority, and a track may have 3 open proposals.',
      'Domain, project and feature follow your track and the class is K, unless you set them (`"class":"D"` for database work). Add',
      '`"owned_files":[...]` if you know the files. Run it on its own from your worktree: no `cd`, no `QUEUE_` variable, no `--approved`,',
      `and nothing else in the same command. On Windows, or with quotes in the text, write the JSON to a file in \`<folder>\`${addendum.newWorkWrite ?? ''} and use \`--file\`.`,
      'Mention the id in the report, and a HIGH security finding in its own section.',
      `Noticed something outside your scope? Run \`${require('./lib/projectRoot.js').cliCommand()} finding "<title>" [--detail "..."] [--files a,b]\` instead of fixing it.`,
    ].join('\n'),
  );
  s = swap(s, '<BRANCH>', '__BRANCH__');
  s = swap(s, '<HEAD>', '__HEAD__');
  s = swap(s, '<BLOCK>', '__BLOCK__');
  s = swap(s, '<TRACK>', '__TRACK__');
  s = swap(s, '<base>', base);
  s = swap(s, '<scratchpad-root>', scratch);
  s = swap(s, '<scratchpad>', scratch);
  const header = [
    '## SHARED PROTOCOL FOR TRACKS FROM THE WORK QUEUE (binding)',
    '',
    'Made from `docs/queue/mission-template.md`' +
      (k.projectName ? ` for ${k.projectName}` : '') +
      '. Other tracks start and finish while you work. The class (K, D, D+, U) is in the track block; the parts ' +
      'below are selected for it.',
    `Base branch: ${CODE}${base}${CODE}. Quick gate: ${gateText(k.gates?.quick)}. ` +
      `Full gate: ${gateText(k.gates?.full)}.`,
    '',
    '',
  ].join('\n');
  return header + s.replace(/^## Common protocol[^\n]*\n/, '');
}

const START = /^\s*<!--\s*class:\s*([^>]*?)\s*-->\s*$/;
const END = /^\s*<!--\s*\/class\s*-->\s*$/;

/**
 * Keeps only the class sections that apply to the class. An unknown or missing class gives EVERYTHING (safe: nothing
 * binding is dropped). The marker lines are always removed, and three or more line breaks are collapsed to two.
 * @param {string} text
 * @param {string|null} class K, D, D+ or U
 */
function filterClass(text, cls) {
  const known = CLASSES.includes(cls);
  const stack = [];
  const out = [];
  for (const l of String(text).split('\n')) {
    const m = l.match(START);
    if (m) {
      stack.push(m[1].split(/[\s,]+/).filter(Boolean));
      continue;
    }
    if (END.test(l)) {
      if (!stack.length) throw new Error('<!-- /class --> without a start');
      stack.pop();
      continue;
    }
    if (!known || stack.every((list) => list.includes(cls))) out.push(l);
  }
  if (stack.length) throw new Error('<!-- class: … --> without <!-- /class -->');
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

/**
 * The class in a track block: a separate "CLASS: X" line wins, otherwise "class X" in the ## TRACK heading (queue.mjs writes
 * "## TRACK id (title; source: …; class D+, estimate 40 min)"). Null when there is none.
 * @param {string} body
 */
function classFromBlock(body) {
  const lines = String(body).split(/\r?\n/);
  const own = lines.find((l) => /^CLASS:/.test(l));
  const candidate = own
    ? own.slice('CLASS:'.length).trim()
    : (lines.find((l) => /^## TRACK\b/.test(l))?.match(/\bclass\s+(D\+|[KDU])(?![\w+])/)?.[1] ??
      null);
  return CLASSES.includes(candidate) ? candidate : null;
}

/** GitHub-style slug of a heading: lowercase, punctuation removed, whitespace to hyphens. */
function slug(t) {
  return String(t)
    .toLowerCase()
    .replace(/[`*_]/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

/**
 * The line range (1-based, inclusive) of the section the pointer refers to, or null.
 * § N: a heading that starts with N (also "§ N", "N.", "N)" or "N:"), but not N.M when only N is referenced.
 * #anchor: a heading with the same slug, otherwise one that contains the anchor (hyphens as whitespace).
 * @param {string} text the whole document
 * @param {{ section?: string, anchor?: string }} p
 */
function sectionArea(text, { section, anchor }) {
  const lines = String(text).split(/\r?\n/);
  const headings = [];
  let inCode = false;
  lines.forEach((l, i) => {
    if (/^```/.test(l)) inCode = !inCode;
    const m = !inCode && l.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (m) headings.push({ i, level: m[1].length, text: m[2] });
  });
  let match = null;
  if (section) {
    const esc = section.replace(/\./g, '\\.');
    const re = new RegExp(`^(?:§\\s*)?${esc}(?:$|[\\s):]|\\.(?!\\d))`);
    match = headings.find((o) => re.test(o.text.trim()));
  } else if (anchor) {
    const a = anchor.toLowerCase();
    match =
      headings.find((o) => slug(o.text) === a) ??
      headings.find((o) => o.text.toLowerCase().includes(a.replace(/-/g, ' ')));
  }
  if (!match) return null;
  const next = headings.find((o) => o.i > match.i && o.level <= match.level);
  let end = next ? next.i : lines.length;
  while (end > match.i + 1 && !lines[end - 1].trim()) end--; // empty lines at the end do not count
  return { from: match.i + 1, to: end };
}

// "docs/x.md § 6", "`docs/x.md` § 6.2", "`docs/x.md#heading`", also with an absolute Windows path. A closing
// backtick is included in the match, so "(line A–B)" ends up outside the code span.
const POINTER =
  /`?((?:[A-Za-z]:[\\/])?[\w.~\\/-]*[\w-]\.md)`?(?:\s*§\s*(\d+(?:\.\d+)*)(?![\d.]\d)|#([\p{L}\p{N}_-]+)(?![\p{L}\p{N}_-]))`?(?!`?\s*\(line)/gu;

/**
 * Appends "(line A–B)" after every section pointer that can be looked up. Pointers without a section, and pointers to
 * files or sections that do not exist, are left untouched (backward compatible).
 * @param {string} text the mission
 * @param {(file: string) => string|null} read reads a document (path relative to the repo root, or absolute)
 */
function sectionPointers(text, read) {
  const cache = new Map();
  const get = (file) => {
    if (!cache.has(file)) {
      let t = null;
      try {
        t = read(file);
      } catch {
        t = null;
      }
      cache.set(file, t);
    }
    return cache.get(file);
  };
  return String(text).replace(POINTER, (whole, file, section, anchor) => {
    const doc = get(file);
    if (doc == null) return whole;
    const o = sectionArea(doc, { section, anchor });
    return o ? `${whole} (line ${o.from}–${o.to})` : whole;
  });
}

// ---- The read-first list ---------------------------------------------------------------------------------------------
//
// Why: a track mostly makes one tool call per turn, and every turn rereads the whole context. The files a mission names
// can be read in one turn with parallel calls, so the mission starts with them as a list. The mission text is untrusted
// data: only a bare repo-relative path that exists comes through (checked by the injected exists function), never a
// URL, a glob, an absolute path, a ".." escape or other text.

/** The most paths in the list: enough for a normal mission, short enough to stay one quick block. */
const READ_FIRST_MAX = 12;
const READ_FIRST_HEADING = 'Read these in your first turn, all in the same turn:';

// A word is cut at whitespace, quotes, backticks, parentheses, angle brackets, commas, semicolons, pipes, "=" and "§".
const WORD = /[^\s`'"()<>,;|=§]+/g;
// A bare repo-relative path (no leading "/", no backslash, no drive letter, no "~" or "%VAR%"), optionally followed
// by ":" and the rest of the word.
const BARE = /^([\w@+.-]+(?:\/[\w@+.-]+)*)(?::(.*))?$/;
const GLOB = /[*?[\]{}]/;
const LINES = /^(\d+)(?:[-\u2013](\d+))?$/;
const SECTION_AFTER = /^\s*§\s*(\d+(?:\.\d+)*)/;
const READ_ALSO = /^\s*(?:#{1,6}\s*|[-*]\s*)?(?:\*\*)?read also\b/i;

/**
 * One word as a list entry ("path", "path:12", "path:3-9" or "path § 2.1"), or null when it is not a safe candidate.
 * @param {string} raw the word
 * @param {string} after the text right after the word (for a "§ N" suffix)
 */
function entryFromWord(raw, after) {
  if (raw.includes('://')) return null; // a URL
  let w = raw.replace(/[.,;:!?]+$/, '');
  // Markdown emphasis around a path: **docs/x.md** or *docs/x.md*.
  const em = w.match(/^(\*\*?)([^*]+)\1$/);
  if (em) w = em[2];
  if (GLOB.test(w)) return null;
  const m = w.match(BARE);
  if (!m) return null;
  const file = m[1].replace(/^(?:\.\/)+/, '');
  const parts = file.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..' || p.toLowerCase() === '.git')) return null;
  // It must look like a file: a folder part or an extension. Existence is checked by the caller.
  if (parts.length < 2 && !/\.[\w-]+$/.test(file)) return null;
  const lines = m[2] != null ? m[2].match(LINES) : null;
  if (lines) return { file, entry: `${file}:${lines[1]}${lines[2] ? `-${lines[2]}` : ''}` };
  const section = m[2] == null ? String(after).match(SECTION_AFTER) : null;
  return { file, entry: section ? `${file} § ${section[1]}` : file };
}

/** The candidate entries in a text, in order. */
function entriesIn(text) {
  const s = String(text);
  const out = [];
  for (const m of s.matchAll(WORD)) {
    const e = entryFromWord(m[0], s.slice(m.index + m[0].length, m.index + m[0].length + 40));
    if (e) out.push(e);
  }
  return out;
}

/** The text of a "Read also" section: its own line and the lines under it, up to a blank line after content or a heading. */
function readAlsoSection(text) {
  const lines = String(text).split(/\r?\n/);
  const start = lines.findIndex((l) => READ_ALSO.test(l));
  if (start < 0) return '';
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^#{1,6}\s/.test(l)) break;
    if (!l.trim()) {
      if (out.length > 1) break;
      continue;
    }
    out.push(l);
  }
  return out.join('\n');
}

// The lines the queue writes into a track block itself (logic/external.js trackBlock, doneCheck.js): the ## TRACK
// heading, ownership, reads and the done command. Their paths only fill what is left under the cap after the
// mission text, so twelve owned files never push out the files the mission asks the track to read.
const QUEUE_LINE = /^(?:## TRACK\b|\*\*(?:Ownership in the queue|Reads \(not owned\)|Done command \(binding\)):\*\*)/;

/** The text split into the mission's own lines and the queue's lines. */
function splitQueueLines(text) {
  const own = [];
  const queue = [];
  for (const l of String(text).split(/\r?\n/)) (QUEUE_LINE.test(l) ? queue : own).push(l);
  return { own: own.join('\n'), queue: queue.join('\n') };
}

/**
 * The paths named in a mission, for the read-first list: a "Read also" section first, then the rest of the mission
 * text in order, then (only if there is room) the queue's own lines (ownership, reads, done command, heading).
 * Deduplicated on the whole entry (path and suffix), capped at max, and only paths for which exists(path) is
 * true. Never throws for odd input.
 * @param {string} text the mission (the track block)
 * @param {(relPath: string) => boolean} exists is this repo-relative path an existing file in the repo
 * @param {number} [max]
 * @returns {string[]}
 */
function readFirstPaths(text, exists, max = READ_FIRST_MAX) {
  return readFirstItems(text, exists, max).map((x) => x.entry);
}

/** readFirstPaths with the file of each entry kept ({ file, entry }), for readFirstList's placing. */
function readFirstItems(text, exists, max = READ_FIRST_MAX) {
  const seen = new Set();
  const known = new Map();
  const out = [];
  const { own, queue } = splitQueueLines(text);
  for (const { file, entry } of [...entriesIn(readAlsoSection(own)), ...entriesIn(own), ...entriesIn(queue)]) {
    if (out.length >= max) break;
    if (seen.has(entry)) continue;
    if (!known.has(file)) {
      let ok = false;
      try {
        ok = exists(file) === true;
      } catch {
        ok = false;
      }
      known.set(file, ok);
    }
    if (!known.get(file)) continue;
    seen.add(entry);
    out.push({ file, entry });
  }
  return out;
}

// A read-first entry with a line range at its end ("docs/a.md:3-9" or "docs/a.md:12"). Without one, the entry reads the
// whole file. Matched at the end only, so the colon of a Windows drive ("C:/x/a.md") is no range.
const LINE_RANGE_END = /:\d+(?:-\d+)?$/;

/**
 * The read-first list of a mission with the task's links (roadmap 0p2 step B3), split into what the agent opens and
 * what is private.
 *
 * Order, under ONE cap (max, READ_FIRST_MAX): first the task's links (`links`, already in read-first form, made by
 * the orchestrator from the plan entry and the task's `sources`: lib/taskLinks.js missionLines), then the private
 * links (`privateLinks`, one label each, never a path to open), then the mission's own paths in readFirstPaths order.
 *
 * Each mission path is placed with `place(file)`: it returns the path to write (the same repo-relative path, or the
 * absolute path when the agent's worktree will not have the file), or null for a private file, which then becomes a
 * private line instead. A mission path already read whole by a link is left out, as is an exact duplicate.
 *
 * With no links and the default placing this is exactly readFirstPaths (a task without links keeps its mission
 * byte for byte). Pure: the caller does the I/O (exists, place). Never throws for odd input; a place that throws
 * keeps the path as it is.
 * @param {string} text the mission (the track block)
 * @param {(relPath: string) => boolean} exists is this repo-relative path an existing file in the repo
 * @param {{ links?: string[], privateLinks?: string[], place?: (file: string) => string|null, max?: number }} [o]
 * @returns {{ read: string[], private: string[] }}
 */
function readFirstList(text, exists, { links = [], privateLinks = [], place = (f) => f, max = READ_FIRST_MAX } = {}) {
  // A link is one line of text: anything with a line break is dropped (it could not be one list entry).
  const clean = (l) =>
    Array.isArray(l) ? l.filter((x) => typeof x === 'string' && x.trim() && !/[\r\n]/.test(x)).map((x) => x.trim()) : [];
  const read = [];
  const priv = [];
  const full = () => read.length + priv.length >= max;
  for (const e of clean(links)) if (!full() && !read.includes(e)) read.push(e);
  for (const e of clean(privateLinks)) if (!full() && !priv.includes(e)) priv.push(e);
  // The files a link already reads whole: the mission's own pointer into the same file adds nothing.
  const whole = new Set(read.filter((e) => !LINE_RANGE_END.test(e)));
  const privWhole = new Set(priv);
  for (const { file, entry } of readFirstItems(text, exists, Infinity)) {
    if (full()) break;
    let at = file;
    try {
      at = place(file);
    } catch {
      at = file; // a broken helper never stops the mission: the path stays as the mission wrote it
    }
    const rest = entry.slice(file.length); // "", ":3-9" or " § 2"
    if (at === null) {
      // Private: a label from the repo-relative path, never a path to open.
      const label = `${file}${rest}`;
      if (!privWhole.has(file) && !priv.includes(label)) priv.push(label);
      continue;
    }
    const placed = typeof at === 'string' && at ? at : file;
    const e = `${placed}${rest}`;
    if (whole.has(placed) || read.includes(e)) continue;
    read.push(e);
  }
  return { read, private: priv };
}

/** The block at the top of the mission, or '' for an empty list (no block at all). */
function readFirstBlock(list) {
  const l = Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x) : [];
  return l.length ? [READ_FIRST_HEADING, ...l.map((p) => `- ${p}`)].join('\n') : '';
}

/** The start of the line for a private document: the agent asks for an excerpt instead of opening the file. */
const PRIVATE_LINE = 'Private, ask the orchestrator for an excerpt (do not open it):';

/**
 * The private lines right under the read-first block, one per private document (privatePaths with read: false), or
 * '' when there are none. Never a path to open: the label is the repo-relative path and its anchor, so the agent can
 * name what it needs, and the orchestrator decides what to hand over.
 * @param {string[]} list labels such as "docs/internal/x.md § 2"
 */
function privateBlock(list) {
  const l = Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x) : [];
  return l.map((p) => `${PRIVATE_LINE} ${p}`).join('\n');
}

/**
 * An exists function for readFirstPaths: true only for a file that, after resolving symlinks, lies inside one of the
 * roots (this tree first, then the main tree). An absolute path or a ".." escape is false. The only I/O in this file,
 * and only when the caller uses it (fs can be replaced in tests).
 * @param {string[]} roots
 * @param {typeof import('node:fs')} [f]
 */
function repoFileExists(roots, f = require('node:fs')) {
  const rootOf = repoFileRoot(roots, f);
  return (rel) => rootOf(rel) !== null;
}

/**
 * The same test as repoFileExists, answering WHICH root holds the file (the first one, as given), or null. The
 * mission uses it to write the absolute path of a file the agent's worktree will not have (make-mission.mjs place).
 * @param {string[]} roots
 * @param {typeof import('node:fs')} [f]
 * @returns {(rel: string) => string|null}
 */
function repoFileRoot(roots, f = require('node:fs')) {
  const path = require('node:path');
  return (rel) => {
    if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return null;
    for (const root of roots.filter(Boolean)) {
      try {
        const base = f.realpathSync(root);
        const full = f.realpathSync(path.resolve(base, rel));
        const r = path.relative(base, full);
        if (!r || path.isAbsolute(r) || r.split(path.sep)[0] === '..') continue;
        if (f.statSync(full).isFile()) return root;
      } catch {
        // not in this root; try the next one
      }
    }
    return null;
  };
}

module.exports = {
  CLASSES,
  READ_FIRST_MAX,
  READ_FIRST_HEADING,
  readFirstPaths,
  readFirstList,
  readFirstBlock,
  privateBlock,
  repoFileExists,
  repoFileRoot,
  gateText,
  makeQueueCommon,
  fillClient,
  filterClass,
  classFromBlock,
  sectionArea,
  sectionPointers,
};
