// =============================================================
// conflictPredict.js: merge conflicts predicted BEFORE the merge, and the context of a real one.
//
// What: for each running, picked or delivered (review) track whose branch has commits ahead of the base, the tip is
// checked against the base branch and pairwise against the other tips with `git merge-tree --write-tree` (git >= 2.38).
// That command merges in memory: it writes tree and blob objects to the object store, never the index, the checkout
// or a ref, so it is safe while other sessions work in the main tree. A conflicted file list per pair comes out, plus a
// suggested merge order (orderFor). On older git (or an injected older version) the check degrades to changed-file
// overlap (a superset: two edits to different lines of one file also count) with a one-line note.
//
// Cost: one merge-tree call per pair, with a time budget (budgetMs) and a cap on the number of checks (maxChecks).
// Results are cached per sha pair in <dataFolder>/conflict-predict.json: a pair of unchanged shas is never checked
// again, and when neither the base nor any tip has moved since the last complete run, the last result is returned
// without any check. A run that hit the budget is PARTIAL: the next run continues from the cache.
//
// The real conflict (mergeConflictContext): when `cq merge` stops in the merge step, the conflicting files are read
// from merge-track's output (or the unmerged paths), and for each one the other tasks that touched it are named:
// active tasks that own it (owned_files) and queue merges on the base since the branch forked (git log). The fix
// round brief (logic/resume.js resumeBlock) prints them (briefLines), so the fix agent starts informed.
//
// The git runner is injected (makeRunner gives the real one: (args) -> { code, stdout }), and so is the git version,
// so the tests run against temporary repos and can force the fallback. Used by cli/conflicts.mjs (pulse and
// `cq conflicts`), cli/merge.mjs (the merge-conflict stop), cli/doctor.mjs (the git version line) and
// logic/resume.js (the fix round brief). Tested in lib/__tests__/conflictPredict.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/** The first git with `git merge-tree --write-tree` (git 2.38, October 2022). */
const MIN_GIT = [2, 38, 0];
const MIN_GIT_TEXT = MIN_GIT.slice(0, 2).join('.');
/** The statuses whose branch tip is checked: an agent or a person is on it, or it is delivered and not merged. */
const TIP_STATUSES = ['running', 'picked', 'review'];
/** Defaults: wall-clock budget for the checks that are not cached, and the cap on the number of checks per run. */
const DEFAULT_BUDGET_MS = 4000;
const DEFAULT_MAX_CHECKS = 80;
/** At most this many cache entries are kept (the ones for the current shas always are). */
const MAX_CACHE_ENTRIES = 2000;
const CACHE_VERSION = 1;
/** Files shown per line before "+N more". */
const SHOWN_FILES = 5;

/** The real git runner for a repo: (args) -> { code, stdout } (code null when git could not start). Never throws. */
function makeRunner(cwd) {
  return (args) => {
    const r = spawnSync('git', ['--no-optional-locks', '-c', 'core.quotepath=off', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    });
    return { code: r.error ? null : r.status, stdout: r.stdout ?? '' };
  };
}

/** "git version 2.52.0.windows.1" -> [2, 52, 0]; null when there is no version in the text. */
function parseGitVersion(text) {
  const m = /(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(text ?? ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

/** Is this version (text or [maj, min, patch]) new enough for merge-tree --write-tree? Unknown = no. */
function supportsMergeTree(version) {
  const v = Array.isArray(version) ? version : parseGitVersion(version);
  if (!v) return false;
  for (let i = 0; i < 3; i++) {
    if (v[i] > MIN_GIT[i]) return true;
    if (v[i] < MIN_GIT[i]) return false;
  }
  return true;
}

/**
 * The git version as text ("2.52.0"), or null. QUEUE_GIT_VERSION overrides it (the tests force an old git that way).
 * @param {(args: string[]) => { code: number|null, stdout: string }} run
 */
function gitVersion(run, env = process.env) {
  if (env.QUEUE_GIT_VERSION) return String(env.QUEUE_GIT_VERSION);
  const r = run(['--version']);
  const v = r.code === 0 ? parseGitVersion(r.stdout) : null;
  return v ? v.join('.') : null;
}

/** The one-line note when the fallback is used (null when merge-tree is available). */
function fallbackNote(version) {
  if (supportsMergeTree(version)) return null;
  return (
    `NOTE: git ${version ?? '(unknown version)'} is older than ${MIN_GIT_TEXT} (no git merge-tree --write-tree): ` +
    'conflict prediction uses changed-file overlap, which also flags edits to different lines of one file.'
  );
}

const splitLines = (s) =>
  String(s ?? '')
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * The tips to check: tasks in TIP_STATUSES whose branch exists, in queue order. `refs` maps branch -> sha (from
 * `git for-each-ref`). A tip at the base sha has nothing to merge and is left out by predict (after merge-base).
 * @returns {{ id: string, branch: string, sha: string, status: string, depends_on: string[] }[]}
 */
function tipsFor(tasks, refs, { prefix = 'queue/' } = {}) {
  const out = [];
  for (const o of tasks ?? []) {
    if (!TIP_STATUSES.includes(o?.status)) continue;
    const branch = o.branch ?? `${prefix}${o.id}`;
    const sha = refs.get(branch);
    if (!sha) continue;
    out.push({ id: o.id, branch, sha, status: o.status, depends_on: [...(o.depends_on ?? [])] });
  }
  return out;
}

/** branch -> sha for every local branch, in one git call. */
function readRefs(run) {
  const r = run(['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads/']);
  const refs = new Map();
  if (r.code !== 0) return refs;
  for (const l of splitLines(r.stdout)) {
    const i = l.lastIndexOf(' ');
    if (i > 0) refs.set(l.slice(0, i), l.slice(i + 1));
  }
  return refs;
}

// ---- The cache -----------------------------------------------------------------------------------------------------

function emptyCache() {
  return { version: CACHE_VERSION, entries: {}, last: null };
}

/** Reads the cache file; a missing, broken or older file is an empty cache (the checks just run again). */
function readCache(file) {
  try {
    const c = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (c?.version !== CACHE_VERSION || typeof c.entries !== 'object' || !c.entries) return emptyCache();
    return { version: CACHE_VERSION, entries: c.entries, last: c.last ?? null };
  } catch {
    return emptyCache();
  }
}

/** Writes the cache atomically (tmp + rename). Never throws: a cache that cannot be written only costs time. */
function writeCache(file, cache) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache) + '\n');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** The cache key of a check: the mode and the two shas, sorted (A x B and B x A conflict in the same files). */
function pairKey(mode, x, y) {
  return x < y ? `${mode}:${x}:${y}` : `${mode}:${y}:${x}`;
}

/** Keeps the entries for the current shas, then the newest others up to MAX_CACHE_ENTRIES. */
function pruneCache(cache, shas) {
  const keep = {};
  const others = [];
  for (const [k, v] of Object.entries(cache.entries)) {
    const [, x, y] = k.split(':');
    if (shas.has(x) && (y === undefined || shas.has(y))) keep[k] = v;
    else others.push([k, v]);
  }
  others.sort((p, q) => String(q[1]?.at ?? '').localeCompare(String(p[1]?.at ?? '')));
  for (const [k, v] of others.slice(0, Math.max(0, MAX_CACHE_ENTRIES - Object.keys(keep).length))) keep[k] = v;
  cache.entries = keep;
}

// ---- The checks ----------------------------------------------------------------------------------------------------

/**
 * One merge-tree check: { files } (empty = merges clean) or { error }. Exit 0 = clean, 1 = conflicts; with -z and
 * --name-only the output is "<tree>\0<file>\0<file>\0..." (no messages with --no-messages).
 */
function mergeTreeCheck(run, x, y) {
  const r = run(['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', x, y]);
  if (r.code !== 0 && r.code !== 1) return { error: `git merge-tree exit ${r.code ?? '?'}` };
  const parts = String(r.stdout ?? '').split('\0').filter(Boolean);
  const files = r.code === 1 ? [...new Set(parts.slice(1))].sort() : [];
  return { files };
}

/** The fallback for one tip: the files it changed and the files the base changed since they forked. */
function changedFiles(run, base, tip) {
  const mb = run(['merge-base', base, tip]);
  if (mb.code !== 0) return { error: 'no merge base' };
  const fork = mb.stdout.trim();
  const tipFiles = run(['diff', '--name-only', '--no-renames', fork, tip]);
  const baseFiles = run(['diff', '--name-only', '--no-renames', fork, base]);
  if (tipFiles.code !== 0 || baseFiles.code !== 0) return { error: 'git diff failed' };
  return { fork, tip: splitLines(tipFiles.stdout).sort(), base: splitLines(baseFiles.stdout).sort() };
}

const intersect = (p, q) => {
  const s = new Set(q);
  return p.filter((f) => s.has(f));
};

/**
 * The prediction. Checks the base first (each tip against the base), then the pairs, cached ones for free, the rest
 * while the budget lasts.
 * @param {object} p
 * @param {(args: string[]) => { code: number|null, stdout: string }} p.run the git runner
 * @param {{ name: string, sha: string }} p.base the base branch and its sha
 * @param {ReturnType<typeof tipsFor>} p.tips
 * @param {string|null} p.version the git version text (gitVersion)
 * @param {{ version: number, entries: object, last: object|null }} [p.cache] readCache(); changed in place
 * @param {number} [p.budgetMs]
 * @param {number} [p.maxChecks]
 * @param {() => number} [p.clock] ms clock (tests)
 * @returns {object} see the fields at the end
 */
function predict({
  run,
  base,
  tips,
  version,
  cache = emptyCache(),
  budgetMs = DEFAULT_BUDGET_MS,
  maxChecks = DEFAULT_MAX_CHECKS,
  clock = Date.now,
}) {
  const started = clock();
  const mode = supportsMergeTree(version) ? 'merge-tree' : 'file-overlap';
  const note = fallbackNote(version);
  // Unchanged since the last complete run: the same answer, no git call.
  const stateKey = [mode, base.sha, ...tips.map((t) => `${t.id}=${t.sha}`).sort()].join('|');
  if (cache.last?.key === stateKey && cache.last.result && !cache.last.result.partial)
    return { ...cache.last.result, unchanged: true, checks: 0, cacheHits: 0, ms: clock() - started };

  let checks = 0;
  let cacheHits = 0;
  let skipped = 0;
  const errors = [];
  const now = new Date(started).toISOString();
  const overBudget = () => checks >= maxChecks || clock() - started > budgetMs;

  // A tip whose sha is already in the base has nothing to merge.
  const live = tips.filter((t) => t.sha !== base.sha);
  const baseConflicts = [];
  const pairs = [];

  if (mode === 'merge-tree') {
    const check = (x, y) => {
      const k = pairKey(mode, x, y);
      const hit = cache.entries[k];
      if (hit) {
        cacheHits++;
        return hit;
      }
      if (overBudget()) {
        skipped++;
        return null;
      }
      checks++;
      const r = mergeTreeCheck(run, x, y);
      if (r.error) return r;
      const entry = { files: r.files, at: now };
      cache.entries[k] = entry;
      return entry;
    };
    const record = (r, what, push) => {
      if (!r) return;
      if (r.error) errors.push(`${what}: ${r.error}`);
      else if (r.files.length) push(r.files);
    };
    for (const t of live) record(check(base.sha, t.sha), t.id, (files) => baseConflicts.push({ id: t.id, files }));
    for (let i = 0; i < live.length; i++)
      for (let j = i + 1; j < live.length; j++) {
        const [x, y] = [live[i], live[j]];
        if (x.sha === y.sha) continue;
        record(check(x.sha, y.sha), `${x.id} x ${y.id}`, (files) => pairs.push({ a: x.id, b: y.id, files }));
      }
  } else {
    // Fallback: per tip one merge-base and two diffs (cached per base and tip sha); the pairs are set intersections.
    const changed = new Map();
    for (const t of live) {
      const k = pairKey(mode, base.sha, t.sha);
      let entry = cache.entries[k];
      if (entry) cacheHits++;
      else if (overBudget()) {
        skipped++;
        continue;
      } else {
        checks++;
        const r = changedFiles(run, base.sha, t.sha);
        if (r.error) {
          errors.push(`${t.id}: ${r.error}`);
          continue;
        }
        entry = { tip: r.tip, base: r.base, at: now };
        cache.entries[k] = entry;
      }
      changed.set(t.id, entry.tip);
      const both = intersect(entry.tip, entry.base);
      if (both.length) baseConflicts.push({ id: t.id, files: both });
    }
    for (let i = 0; i < live.length; i++)
      for (let j = i + 1; j < live.length; j++) {
        const [x, y] = [live[i], live[j]];
        if (!changed.has(x.id) || !changed.has(y.id)) continue;
        const both = intersect(changed.get(x.id), changed.get(y.id));
        if (both.length) pairs.push({ a: x.id, b: y.id, files: both });
      }
  }

  const order = orderFor(live, baseConflicts, pairs);
  const result = {
    mode,
    git: version ?? null,
    note,
    base: { name: base.name, sha: base.sha },
    tips: live.map((t) => ({ id: t.id, branch: t.branch, sha: t.sha, status: t.status })),
    baseConflicts,
    pairs,
    order: order.ids,
    orderRule: order.rule,
    partial: skipped > 0,
    skipped,
    errors,
  };
  pruneCache(cache, new Set([base.sha, ...live.map((t) => t.sha)]));
  cache.last = { key: stateKey, at: now, result };
  return { ...result, unchanged: false, checks, cacheHits, ms: clock() - started };
}

/** The rule orderFor uses, as one sentence (printed with the order). */
const ORDER_RULE =
  "a track's dependencies (depends_on) first; then the track with the fewest predicted conflicts (base and other " +
  'tracks, in files); then delivered (review) before running; then queue order';

/**
 * The suggested merge order: a topological order over depends_on (within the tips), and among the ones that are free
 * the one with the fewest predicted conflicted files first, delivered before running, then queue order. Merging the
 * least conflicted first keeps the others' conflicts where they are and moves no new conflict onto a clean track. A
 * dependency cycle does not stop it (the rest is added in queue order).
 */
function orderFor(tips, baseConflicts, pairs) {
  const ids = tips.map((t) => t.id);
  const inSet = new Set(ids);
  const score = new Map(ids.map((id) => [id, 0]));
  for (const c of baseConflicts) score.set(c.id, (score.get(c.id) ?? 0) + c.files.length);
  for (const p of pairs) {
    score.set(p.a, (score.get(p.a) ?? 0) + p.files.length);
    score.set(p.b, (score.get(p.b) ?? 0) + p.files.length);
  }
  const index = new Map(ids.map((id, i) => [id, i]));
  const byId = new Map(tips.map((t) => [t.id, t]));
  const deps = new Map(tips.map((t) => [t.id, (t.depends_on ?? []).filter((d) => inSet.has(d) && d !== t.id)]));
  const done = new Set();
  const out = [];
  const rank = (id) => [score.get(id), byId.get(id).status === 'review' ? 0 : 1, index.get(id)];
  const less = (x, y) => {
    const [p, q] = [rank(x), rank(y)];
    for (let i = 0; i < p.length; i++) if (p[i] !== q[i]) return p[i] < q[i];
    return false;
  };
  while (out.length < ids.length) {
    const free = ids.filter((id) => !done.has(id) && deps.get(id).every((d) => done.has(d)));
    const pool = free.length ? free : ids.filter((id) => !done.has(id)); // a cycle: take the best of the rest
    let best = pool[0];
    for (const id of pool) if (less(id, best)) best = id;
    done.add(best);
    out.push(best);
  }
  return { ids: out, rule: ORDER_RULE };
}

const fileList = (files) =>
  files.length > SHOWN_FILES
    ? `${files.slice(0, SHOWN_FILES).join(', ')} (+${files.length - SHOWN_FILES} more)`
    : files.join(', ');

/**
 * The pulse lines: PREDICTED CONFLICT A x B, CONFLICTS WITH BASE, the order (only when something conflicts), the
 * fallback note, and a partial or error line. Nothing at all when there is nothing to say.
 */
function pulseLines(r, { cq = 'cq' } = {}) {
  if (!r) return [];
  const out = [];
  const conflicts = r.pairs.length + r.baseConflicts.length;
  if (r.note && (r.tips.length > 1 || conflicts)) out.push(r.note);
  for (const c of r.baseConflicts) out.push(`CONFLICTS WITH BASE: ${c.id}: ${fileList(c.files)}`);
  for (const p of r.pairs) out.push(`PREDICTED CONFLICT ${p.a} x ${p.b}: ${fileList(p.files)}`);
  if (conflicts && r.order.length > 1) out.push(`Suggested merge order: ${r.order.join(', ')} (rule: ${r.orderRule}).`);
  if (r.partial)
    out.push(
      `CONFLICT PREDICTION PARTIAL: ${r.skipped} check(s) left over the budget; the next pulse continues from the cache ` +
        `(${cq} conflicts for the full picture).`,
    );
  for (const e of r.errors) out.push(`WARNING: conflict prediction could not check ${e}.`);
  return out;
}

// ---- A real merge conflict ------------------------------------------------------------------------------------------

/**
 * The conflicting files in merge-track.mjs's output: the lines under "MUST BE RESOLVED BY HAND" ("  <file>: reason"
 * or "  <file>:<line>: reason"). Empty when there is no such section.
 */
function conflictFilesFromOutput(out) {
  const lines = String(out ?? '').split(/\r?\n/);
  const start = lines.findIndex((l) => /MUST BE RESOLVED BY HAND/.test(l));
  if (start < 0) return [];
  const files = [];
  for (const l of lines.slice(start + 1)) {
    const m = /^\s+(\S[^:]*?):(?:\d+:)?\s/.exec(l);
    if (!m) {
      if (l.trim() === '') continue;
      break;
    }
    if (!files.includes(m[1])) files.push(m[1]);
  }
  return files;
}

/**
 * The context of a real conflict: per file, the other tasks that touched it. Active tasks that own it (owned_files,
 * with the folder rule of logic/conflicts.js) and queue merges on the base since the branch forked (first-parent log,
 * merge subject "Merge branch '<prefix><id>'"); other commits there are named by sha and subject.
 * @returns {{ at: string, files: { file: string, tasks: string[], commits: string[] }[] }}
 */
function mergeConflictContext({ out = '', task, tasks = [], run, base, branch, prefix = 'queue/', now = new Date() }) {
  const { fileOverlap } = require('./logic/conflicts.js');
  const { queueIdFromMerge } = require('./logic/commits.js');
  let files = conflictFilesFromOutput(out);
  if (!files.length) {
    const u = run(['diff', '--name-only', '--diff-filter=U']);
    if (u.code === 0) files = splitLines(u.stdout);
  }
  const mb = run(['merge-base', base, branch]);
  const fork = mb.code === 0 ? mb.stdout.trim() : null;
  const others = tasks.filter((x) => x.id !== task.id && ['running', 'picked', 'review', 'done'].includes(x.status));
  const result = [];
  for (const file of files.slice(0, 20)) {
    const ids = [];
    const commits = [];
    if (fork) {
      const log = run(['log', '--first-parent', '--format=%h%x1f%s', `${fork}..${base}`, '--', file]);
      for (const l of log.code === 0 ? splitLines(log.stdout) : []) {
        const [sha, subject = ''] = l.split('\x1f');
        const id = queueIdFromMerge(subject, prefix);
        if (id && id !== task.id) {
          if (!ids.includes(id)) ids.push(id);
        } else if (!id && commits.length < 3) commits.push(`${sha} ${subject}`.trim());
      }
    }
    for (const x of others) {
      if (x.status === 'done') continue; // a done one counts through the log (it merged after the fork) or not at all
      if ((x.owned_files ?? []).some((f) => fileOverlap(f, file)) && !ids.includes(x.id)) ids.push(x.id);
    }
    result.push({ file, tasks: ids, commits });
  }
  return { at: now.toISOString(), files: result };
}

/** One line per file: "lib/k.ts (also touched by B-2, C-1; commits abc123 fix)". */
function conflictFileLines(mc) {
  return (mc?.files ?? []).map((f) => {
    const parts = [];
    if (f.tasks.length) parts.push(`also touched by ${f.tasks.join(', ')}`);
    if (f.commits.length) parts.push(`commits on the base: ${f.commits.join('; ')}`);
    return `${f.file}${parts.length ? ` (${parts.join('; ')})` : ''}`;
  });
}

/** The lines `cq merge` prints at the merge-conflict stop. */
function mergeStopLines(mc, { id, cq = 'cq' }) {
  if (!mc?.files?.length) return [];
  return [
    `CONFLICTING FILES for ${id}:`,
    ...conflictFileLines(mc).map((l) => `  ${l}`),
    `Or leave it to an agent, and the fix round starts informed: git merge --abort here first, then ${cq} resume ${id} --reason fix (the brief names these files and tasks).`,
  ];
}

/** The section in the fix round brief (resumeBlock), or [] when the task has no recorded merge conflict. */
function briefLines(mc, { base = 'main', branch }) {
  if (!mc?.files?.length) return [];
  return [
    `The merge into ${base} CONFLICTED (${mc.at}). Resolve it on your branch: \`git merge ${base}\` in your worktree,`,
    'keep both intents in each file, run the gates, commit. The conflicting files and who else touched them:',
    ...conflictFileLines(mc).map((l) => `- ${l}`),
    `Read the other side first: \`git log -p ${base} -- <file>\` (since \`git merge-base ${base} ${branch}\`).`,
    '',
  ];
}

module.exports = {
  MIN_GIT_TEXT,
  TIP_STATUSES,
  DEFAULT_BUDGET_MS,
  DEFAULT_MAX_CHECKS,
  ORDER_RULE,
  makeRunner,
  parseGitVersion,
  supportsMergeTree,
  gitVersion,
  fallbackNote,
  tipsFor,
  readRefs,
  emptyCache,
  readCache,
  writeCache,
  predict,
  orderFor,
  pulseLines,
  conflictFilesFromOutput,
  mergeConflictContext,
  mergeStopLines,
  briefLines,
};
