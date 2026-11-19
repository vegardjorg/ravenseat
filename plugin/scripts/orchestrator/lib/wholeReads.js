// =============================================================
// wholeReads.js: `ravenseat cost --reads`, the files that tracks most often read WHOLE, across tracks. A file many
// tracks read whole is a candidate for a catalog excerpt (docs/catalog.md) or for splitting it into smaller files.
// See docs/costs.md ("Whole-file reads").
//
// The calls come from the ONE transcript reader, lib/timeCost.js analyzeTranscript with { detail: true } (no second
// parser); cli/cost.mjs lists the subagent transcripts of the cost window and hands each one in with its track.
//   1. WHOLE OR EXCERPT (readKind): a Read call with a file_path is "whole" when it has no offset, no limit and no
//      pages, else "excerpt". A whole read the read guard refused (lib/readOutline.js) still counts: the agent asked
//      for the whole file, which is the signal. Other tools (Grep, a `cat` in Bash) are not counted: only Read says
//      plainly whether the agent wanted the whole file. An image (IMAGE) is no read here: Read shows it whole by
//      nature, and it can be neither excerpted nor split.
//   2. REPO-RELATIVE PATHS (relPath): a relative path is resolved against the transcript's working directory. The roots
//      are the project roots (the main tree and its git worktrees) plus that working directory, because a track's
//      worktree is usually removed after the merge and is then no longer a git worktree. The longest root a path is
//      under wins (a worktree inside the main tree's .claude/worktrees beats the main tree).
//   3. PRIVACY: a path under no root is counted as "outside" and never printed; a path under a root that is no file in
//      the main tree now (deleted, renamed, or a working directory that was not this repo) is counted as "gone" and
//      never printed either. So only paths that exist in the main tree are listed, and only repo-relative.
//   4. PER FILE: the distinct tracks that read it whole, the whole reads and the excerpt reads (all tracks), and an
//      approximate size from the main tree now (lines and KB). Sorted by tracks, then whole reads, then path; the top
//      `limit` are kept (DEFAULT_LIMIT), and the size is looked up only for those.
//
// Display only: it changes nothing and has no setting. Pure functions without I/O (cli/cost.mjs passes `exists` and
// `sizeOf`). Tested in lib/__tests__/wholeReads.test.ts.
// =============================================================
'use strict';

/** The number of files listed when --limit is not given. */
const DEFAULT_LIMIT = 15;

const round1 = (x) => Math.round(x * 10) / 10;

/** Image files: Read shows them whole by nature, and they can be neither excerpted nor split (an SVG is text). */
const IMAGE = /\.(?:png|jpe?g|gif|webp|bmp|ico|tiff?|avif|heic)$/i;

/**
 * A Read call's kind: 'whole' (no offset, limit or pages), 'excerpt' (any of them), or null (not a Read with a path).
 * @param {{ name?: string, input?: Record<string, unknown> }} c
 */
function readKind(c) {
  if (c?.name !== 'Read') return null;
  const input = c.input ?? {};
  if (typeof input.file_path !== 'string' || !input.file_path.trim()) return null;
  if (IMAGE.test(input.file_path.trim())) return null;
  const set = (v) => v !== undefined && v !== null && v !== '';
  return set(input.offset) || set(input.limit) || set(input.pages) ? 'excerpt' : 'whole';
}

/**
 * A path in one form: forward slashes, `/c/x` as `c:/x`, no doubled or trailing slash, `.` and `..` resolved.
 * The spelling (case) is kept: the listing shows it. Returns '' for an empty path.
 */
function slash(p) {
  let n = String(p ?? '').trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  n = n.replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:');
  if (!n) return '';
  // Resolve `.` and `..` segment by segment; a `..` above the start of a relative path is kept (it leaves the root).
  const abs = isAbsolute(n);
  const head = /^[a-zA-Z]:/.test(n) ? n.slice(0, 2) : '';
  const parts = [];
  for (const s of n.slice(head.length).split('/')) {
    if (!s || s === '.') continue;
    if (s === '..' && parts.length && parts[parts.length - 1] !== '..') parts.pop();
    else if (s === '..' && abs) continue; // above the filesystem root: stays at the root
    else parts.push(s);
  }
  return `${head}${abs ? '/' : ''}${parts.join('/')}`;
}
const isAbsolute = (n) => /^[a-zA-Z]:(\/|$)/.test(n) || n.startsWith('/');

/**
 * The repo-relative path of `file` (as the call gave it), or null when it is under none of the roots.
 * @param {string} file
 * @param {{ roots: string[], cwd?: string|null, caseInsensitive?: boolean }} o
 */
function relPath(file, { roots, cwd = null, caseInsensitive = false }) {
  let n = slash(file);
  if (!n) return null;
  const base = cwd ? slash(cwd) : '';
  if (!isAbsolute(n)) {
    // A relative path resolves under the working directory; without one it is taken as repo-relative already.
    if (!base) return n.startsWith('..') ? null : n;
    n = slash(`${base}/${n}`);
  }
  const key = (x) => (caseInsensitive ? x.toLowerCase() : x);
  const nk = key(n);
  let best = null;
  for (const r of [...(roots ?? []), base].map(slash).filter(Boolean)) {
    const rk = key(r);
    if ((nk === rk || nk.startsWith(rk.endsWith('/') ? rk : `${rk}/`)) && (!best || r.length > best.length)) best = r;
  }
  if (!best) return null;
  const rel = n.slice(best.length).replace(/^\//, '');
  return rel || null;
}

/** KB with one decimal under 10 KB, whole above (an approximation, as the listing says). */
function kbOf(bytes) {
  const kb = bytes / 1024;
  return kb < 10 ? round1(kb) : Math.round(kb);
}

/**
 * The whole-read report over [from, to).
 * @param {{
 *   transcripts: Iterable<{ track: string, detail: { turns: object[], cwd?: string|null } }>,
 *   roots: string[],
 *   exists: (rel: string) => boolean,
 *   sizeOf: (rel: string) => ({ lines: number, bytes: number } | null),
 *   from?: number, to?: number, limit?: number, caseInsensitive?: boolean, scan?: object|null,
 * }} o
 * @returns {{ files: { path: string, tracks: number, whole: number, excerpt: number, lines: number|null, kb: number|null }[],
 *   files_total: number, tracks: number, whole_reads: number, excerpt_reads: number, outside: number, gone: number,
 *   limit: number, scan: object|null }}
 */
function wholeReads({ transcripts, roots, exists, sizeOf, from = -Infinity, to = Infinity, limit = DEFAULT_LIMIT, caseInsensitive = false, scan = null }) {
  const byFile = new Map(); // key -> { path, tracks: Set, whole, excerpt }
  const tracks = new Set();
  let whole = 0;
  let excerpt = 0;
  let outside = 0;
  let gone = 0;
  // The existence check once per path (a stat each in the CLI).
  const known = new Map();
  const there = (rel) => {
    if (!known.has(rel)) known.set(rel, Boolean(exists(rel)));
    return known.get(rel);
  };
  for (const tr of transcripts ?? []) {
    const cwd = tr?.detail?.cwd ?? null;
    for (const t of tr?.detail?.turns ?? []) {
      // timeCost gives the turn's time as epoch ms (an ISO string is accepted too); no time = outside any window.
      const at = typeof t.ts === 'number' ? t.ts : Date.parse(t.ts ?? '');
      if (!(at >= from && at < to)) continue;
      for (const c of t.calls ?? []) {
        const kind = readKind(c);
        if (!kind) continue;
        const rel = relPath(c.input.file_path, { roots, cwd, caseInsensitive });
        if (!rel) {
          outside++;
          continue;
        }
        if (!there(rel)) {
          gone++;
          continue;
        }
        const k = caseInsensitive ? rel.toLowerCase() : rel;
        let f = byFile.get(k);
        if (!f) byFile.set(k, (f = { path: rel, tracks: new Set(), whole: 0, excerpt: 0 }));
        if (kind === 'whole') {
          f.whole++;
          f.tracks.add(String(tr.track));
          tracks.add(String(tr.track));
          whole++;
        } else {
          f.excerpt++;
          excerpt++;
        }
      }
    }
  }
  // Only files read whole at least once; tracks, then whole reads, then path (a stable order for the same data).
  const all = [...byFile.values()]
    .filter((f) => f.whole > 0)
    .map((f) => ({ path: f.path, tracks: f.tracks.size, whole: f.whole, excerpt: f.excerpt }))
    .sort((x, y) => y.tracks - x.tracks || y.whole - x.whole || (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
  const n = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_LIMIT;
  const files = all.slice(0, n).map((f) => {
    const s = sizeOf(f.path);
    // A very large file has bytes but no line count (cli/cost.mjs counts lines only up to a cap).
    return { ...f, lines: s?.lines ?? null, kb: s ? kbOf(s.bytes) : null };
  });
  return { files, files_total: all.length, tracks: tracks.size, whole_reads: whole, excerpt_reads: excerpt, outside, gone, limit: n, scan };
}

/** The compact lines for `ravenseat cost --reads`. */
function wholeReadLines(rep, label) {
  const title = `Whole-file reads by tracks (${label}`;
  if (!rep.files.length) return [`${title}): nothing yet.`];
  const sc = rep.scan;
  const out = [
    `${title}; ${rep.tracks} track(s), ${rep.whole_reads} whole read(s), ${rep.excerpt_reads} excerpt read(s)` +
      (sc ? `; ${sc.files} transcript(s)${sc.skipped ? `, ${sc.skipped} skipped over the read budget` : ''}` : '') +
      '):',
    `  ${'tracks'.padStart(6)} ${'whole'.padStart(5)} ${'excerpt'.padStart(7)}  ${'size'.padEnd(22)} file`,
  ];
  for (const f of rep.files) {
    const size = f.kb == null ? '?' : f.lines == null ? `${f.kb} KB` : `${f.lines} lines, ${f.kb} KB`;
    out.push(`  ${String(f.tracks).padStart(6)} ${String(f.whole).padStart(5)} ${String(f.excerpt).padStart(7)}  ${size.padEnd(22)} ${f.path}`);
  }
  const more = rep.files_total - rep.files.length;
  if (more > 0) out.push(`  (${more} more file(s); --limit ${rep.files_total} shows all.)`);
  const left = [];
  if (rep.outside) left.push(`${rep.outside} read(s) outside the repo`);
  if (rep.gone) left.push(`${rep.gone} read(s) of files no longer in the main tree`);
  if (left.length) out.push(`  Left out: ${left.join(', ')}.`);
  out.push(
    'Hint: a file many tracks read whole is a candidate for a catalog excerpt (docs/catalog.md) or for splitting into ' +
      'smaller files, so a track reads only the part it needs.',
  );
  return out;
}

module.exports = { DEFAULT_LIMIT, readKind, relPath, wholeReads, wholeReadLines };
