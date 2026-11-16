// =============================================================
// scopeNotes.js: the reuse and scope facts `receive` prints and puts in the review package (config().scopeNotes).
//
// WHY: parallel tracks write the same helper again under the same name (Ravenseat itself has isObject in many files and
// norm in several variants that differ a little), open a new top folder without asking, pull in a second library for a
// job the project already has one for, or drift far outside the files the task named. None of this is wrong for sure,
// so nothing here stops anything: each part is a plain fact, one NOTE line at receive and a line in the "Reuse and
// scope" section of 00-package.md, so the owner and the reviewer see it before the merge. Bolk B1 of the scope drift
// plan (plans/scope-drift-dry-katalog-2026-11-15.md, owner decision 16.11: these four facts are on by default, also in
// lite, since they are only NOTE lines).
//
// The four parts (each with its own switch, scopeNotes.<part>):
//   reuse         V1. A name the diff DEFINES on an added line (JS/TS only: a top-level function, a const/let/var
//                 holding a function, a class, an `exports.x =`, an entry of a `module.exports = { ... }` block) that
//                 the base already defines in another file. The caller looks it up (`git grep -w` on the merge base);
//                 only hits that define the name count, never a use. Test files, names the diff also removes (a move)
//                 and the ignore list (BUILTIN_IGNORE plus scopeNotes.ignoreNames) are skipped. At most MAX_NAMES
//                 names, all in one look-up.
//   newFolders    V2. An added (or renamed-in) file in a folder at depth 1..folderDepth that the base does not have.
//                 Only the shallowest new folder of a path is named.
//   dependencies  V3. A dependency added to a manifest (package.json, requirements*.txt) whose purpose group in
//                 dependency-purposes.json (data, with examples a test runs) already has another package in the same
//                 manifest, or got one earlier in the same change. Also when the task owns the manifest, which the
//                 dependency file guard does not look at.
//   drift         V5. How many changed files lie outside owned_files, shared_patch and reads (a migration in the
//                 task's migr_block counts as owned), and the folders among them the task does not name. A task with no
//                 ownership at all (usual in lite) gets the number of folders it touches instead, from two folders.
//
// Pure logic without I/O: the caller (cli/merge.mjs, receive) passes the diff, the changed paths and three look-ups
// (io.findDefinitions, io.dirExists, io.readFile). A look-up that throws skips its part with a line in `errors`; this
// module never throws at receive. Test: lib/__tests__/scopeNotes.test.ts.
// =============================================================
'use strict';

const { globMatch, migrCovered } = require('./mergeGuard.js');
const { isTestFile } = require('./testWeakening.js');

/** The defaults (lib/queueConfig.js STANDARD.scopeNotes holds the same values). */
const DEFAULTS = Object.freeze({ reuse: true, newFolders: true, dependencies: true, drift: true, ignoreNames: [], folderDepth: 2 });
const ONOFF = ['reuse', 'newFolders', 'dependencies', 'drift'];

/** Names so common in separate scripts that a second one says nothing (scopeNotes.ignoreNames adds to these). */
const BUILTIN_IGNORE = Object.freeze(['main', 'run', 'usage', 'help', 'handler', 'init', 'setup', 'start', 'render', 'test', 'App']);

/** At most this many new names are looked up on the base per receive (each is one `git grep`). */
const MAX_NAMES = 30;
/** At most this many receive lines of each kind; the package section has them all (the trial on Ravenseat's own step
 * 7 commit gave nine reuse names, which read as a wall at 8 lines). */
const MAX_LINES = 5;

/** The purpose groups for V3 (dependency-purposes.json next to the orchestrator). */
const PURPOSES = Object.freeze(require('../dependency-purposes.json').purposes.map((p) => Object.freeze(p)));

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
/** Forward slashes, no leading ./ (the same as testWeakening's norm, so both read a diff path alike). */
const norm = (p) =>
  String(p ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '');
const inNodeModules = (p) => p.startsWith('node_modules/') || p.includes('/node_modules/');
const CODE = /\.(?:[cm]?[jt]sx?)$/i;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const escape = (s) => s.replace(/[$]/g, '\\$');

// ---- the setup ------------------------------------------------------------------------------------------------------

/** The setup from config().scopeNotes; a value of the wrong type is the default. */
function setupOf(cfg) {
  const own = isObject(cfg?.scopeNotes) ? cfg.scopeNotes : {};
  const out = {};
  for (const k of ONOFF) out[k] = typeof own[k] === 'boolean' ? own[k] : DEFAULTS[k];
  out.ignoreNames = Array.isArray(own.ignoreNames) ? own.ignoreNames.filter((n) => typeof n === 'string' && n.trim()) : [];
  out.folderDepth = [1, 2, 3].includes(own.folderDepth) ? own.folderDepth : DEFAULTS.folderDepth;
  return out;
}

/** The problems in config().scopeNotes, for doctor (texts, empty when valid). */
function setupProblems(own) {
  if (own === undefined) return [];
  if (!isObject(own)) return ['scopeNotes must be an object'];
  const out = [];
  for (const k of ONOFF) if (own[k] !== undefined && typeof own[k] !== 'boolean') out.push(`scopeNotes.${k} must be true or false`);
  if (own.ignoreNames !== undefined && !(Array.isArray(own.ignoreNames) && own.ignoreNames.every((n) => typeof n === 'string')))
    out.push('scopeNotes.ignoreNames must be a list of names');
  if (own.folderDepth !== undefined && ![1, 2, 3].includes(own.folderDepth)) out.push('scopeNotes.folderDepth must be 1, 2 or 3');
  return out;
}

// ---- the diff -------------------------------------------------------------------------------------------------------

/** A path from a diff header: quotes removed, the a/ or b/ prefix cut, /dev/null = none. */
function headerPath(raw, prefix) {
  let s = String(raw ?? '').replace(/\t.*$/, '').trim();
  if (s.startsWith('"') && s.endsWith('"')) s = s.slice(1, -1).replace(/\\(["\\])/g, '$1');
  if (s === '/dev/null') return null;
  if (prefix && s.startsWith(prefix)) s = s.slice(prefix.length);
  return norm(s);
}

/**
 * Parse a unified diff into files: { from, to, status: 'A'|'D'|'M'|'R', hunks: [{ header, lines: [{ mark, text }] }] }.
 * Unlike testWeakening.parseDiff it keeps the context lines and the hunk header's function text, which V1 needs to know
 * that an added line sits inside a `module.exports = {` block.
 */
function parseDiff(text) {
  const files = [];
  let f = null;
  let h = null;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (oldLeft > 0 || newLeft > 0) {
      const c = line.charAt(0);
      if (c === '+') {
        h.lines.push({ mark: '+', text: line.slice(1) });
        newLeft--;
      } else if (c === '-') {
        h.lines.push({ mark: '-', text: line.slice(1) });
        oldLeft--;
      } else if (c !== '\\') {
        h.lines.push({ mark: ' ', text: line.slice(1) });
        oldLeft--;
        newLeft--;
      }
      continue;
    }
    const start = line.match(/^diff --git (?:"?a\/(.+?)"? "?b\/(.+?)"?)$/);
    if (start || line.startsWith('diff --git ')) {
      f = { from: start ? norm(start[1]) : null, to: start ? norm(start[2]) : null, status: 'M', hunks: [] };
      files.push(f);
      continue;
    }
    if (!f) continue;
    let m;
    if (line.startsWith('new file mode')) f.status = 'A';
    else if (line.startsWith('deleted file mode')) f.status = 'D';
    else if ((m = line.match(/^rename from (.+)$/))) {
      f.from = headerPath(m[1]);
      f.status = 'R';
    } else if ((m = line.match(/^rename to (.+)$/))) {
      f.to = headerPath(m[1]);
      f.status = 'R';
    } else if ((m = line.match(/^--- (.+)$/))) {
      const p = headerPath(m[1], 'a/');
      if (p) f.from = p;
    } else if ((m = line.match(/^\+\+\+ (.+)$/))) {
      const p = headerPath(m[1], 'b/');
      if (p) f.to = p;
    } else if ((m = line.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@ ?(.*)$/))) {
      oldLeft = m[1] === undefined ? 1 : Number(m[1]);
      newLeft = m[2] === undefined ? 1 : Number(m[2]);
      h = { header: m[3] ?? '', lines: [] };
      f.hunks.push(h);
    }
  }
  for (const x of files) {
    if (x.status === 'A') x.from = null;
    if (x.status === 'D') x.to = null;
  }
  return files;
}

// ---- V1: new names that already exist -------------------------------------------------------------------------------

const ID = '[A-Za-z_$][\\w$]*';
/**
 * A function-like value after `=`: `function`, an arrow (`x =>`, `(a, b) =>`, `<T,>(x: T): T =>`, typed return), or
 * a parenthesis that ends the line (the parameters go on below). A plain `(` is not enough: `const list = (a ?? [])
 * .filter(...)` is a value, which the trial on Ravenseat itself showed.
 */
const FN_VALUE = `(?:async\\s+)?(?:function\\b|(?:<[^>]*>\\s*)?\\([^()]*\\)\\s*(?::[^=]+)?=>|\\(\\s*$|${ID}\\s*=>)`;
/** Definitions at the start of a line (no indentation: top level), with the name in group 1. */
const TOP_DEFS = [
  new RegExp(`^(?:export\\s+(?:default\\s+)?)?(?:async\\s+)?function\\s*\\*?\\s*(${ID})\\s*[(<]`),
  new RegExp(`^(?:export\\s+)?(?:const|let|var)\\s+(${ID})\\s*(?::[^=]+)?=\\s*${FN_VALUE}`),
  new RegExp(`^(?:export\\s+(?:default\\s+)?)?(?:abstract\\s+)?class\\s+(${ID})`),
  new RegExp(`^(?:module\\.)?exports\\.(${ID})\\s*=`),
];

/** Does the line define `name` (at any indentation)? A use, or a const holding a plain value, does not. */
function isDefinitionOf(name, text) {
  const n = escape(String(name));
  const t = String(text ?? '');
  return [
    new RegExp(`^\\s*(?:export\\s+(?:default\\s+)?)?(?:async\\s+)?function\\s*\\*?\\s*${n}\\s*[(<]`),
    new RegExp(`^\\s*(?:export\\s+)?(?:const|let|var)\\s+${n}\\s*(?::[^=]+)?=\\s*${FN_VALUE}`),
    new RegExp(`^\\s*(?:export\\s+(?:default\\s+)?)?(?:abstract\\s+)?class\\s+${n}(?![\\w$])`),
    new RegExp(`^\\s*(?:module\\.)?exports\\.${n}\\s*=`),
  ].some((re) => re.test(t));
}

/** The braces a line opens minus those it closes, with string contents taken out first. */
function braceDelta(text) {
  const s = String(text).replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""').replace(/\/\/.*$/, '');
  return (s.match(/\{/g) ?? []).length - (s.match(/\}/g) ?? []).length;
}

/** The names a file's added lines define or export (in order, once each). */
function namesInFile(f, mark) {
  const out = [];
  const add = (n) => {
    if (n && !out.includes(n)) out.push(n);
  };
  for (const h of f.hunks) {
    // git puts the nearest line starting with a letter in the hunk header: `module.exports = {` there means the hunk
    // starts inside the block.
    let depth = /^module\.exports\s*=\s*\{/.test(h.header) ? 1 : 0;
    for (const l of h.lines) {
      // The new file is context + added lines; the old one context + removed. `mark` picks which side is read.
      if (l.mark !== ' ' && l.mark !== mark) continue;
      const mine = l.mark === mark;
      if (depth === 0) {
        const block = l.text.match(/^module\.exports\s*=\s*\{(.*)$/);
        if (block) {
          const rest = block[1];
          if (braceDelta(`{${rest}`) <= 0) {
            // One line: module.exports = { a, b: c };
            if (mine)
              for (const part of rest.replace(/\}.*$/, '').split(','))
                add((part.trim().match(new RegExp(`^(${ID})\\s*(?::|$)`)) ?? [])[1]);
          } else depth = braceDelta(`{${rest}`);
          continue;
        }
        if (mine) for (const re of TOP_DEFS) add((l.text.match(re) ?? [])[1]);
        continue;
      }
      if (depth === 1 && mine) add((l.text.match(new RegExp(`^\\s+(${ID})\\s*(?:,|:|\\(|$)`)) ?? [])[1]);
      depth += braceDelta(l.text);
      if (depth <= 0) depth = 0;
    }
  }
  return out;
}

const codeFile = (p) => !!p && CODE.test(p) && !inNodeModules(p) && !isTestFile(p);

/**
 * The names the diff's added lines define in code files: [{ name, file }], once per name (its first file). Skipped:
 * test files, names under 3 characters, the ignore list, and names a removed line defines (moved, not new).
 */
function newNames(files, { ignoreNames = [] } = {}) {
  const ignore = new Set([...BUILTIN_IGNORE, ...ignoreNames]);
  const removed = new Set();
  for (const f of files) if (codeFile(f.from)) for (const n of namesInFile(f, '-')) removed.add(n);
  const out = [];
  for (const f of files) {
    if (f.status === 'D' || !codeFile(f.to)) continue;
    for (const name of namesInFile(f, '+')) {
      if (name.length < 3 || ignore.has(name) || removed.has(name) || out.some((x) => x.name === name)) continue;
      out.push({ name, file: f.to });
    }
  }
  return out;
}

/**
 * V1: the new names the base already defines in another file. `findDefinitions(names)` is ONE look-up for all of them
 * (one `git grep -n -w` with an -e per name, since a process per name took seconds on Windows) and gives the base's
 * lines that mention any of the words ([{ file, line, text }]). Per name only the lines that define THAT name count,
 * never the same file, a test file or a file the diff deletes.
 * @returns {{ name: string, file: string, others: { file: string, line: number }[] }[]}
 */
function reuseFacts(files, { findDefinitions, ignoreNames = [], maxNames = MAX_NAMES } = {}) {
  const deleted = new Set(files.filter((f) => f.status === 'D' || f.status === 'R').map((f) => f.from));
  const names = newNames(files, { ignoreNames }).slice(0, maxNames);
  if (!names.length) return [];
  const rows = findDefinitions(names.map((n) => n.name)) ?? [];
  const out = [];
  for (const { name, file } of names) {
    const others = [];
    for (const hit of rows) {
      const p = norm(hit.file);
      if (p === file || deleted.has(p) || !codeFile(p) || !isDefinitionOf(name, hit.text)) continue;
      if (!others.some((o) => o.file === p)) others.push({ file: p, line: Number(hit.line) });
    }
    if (others.length) out.push({ name, file, others: others.sort((x, y) => x.file.localeCompare(y.file)) });
  }
  return out;
}

// ---- V2: a new folder -----------------------------------------------------------------------------------------------

/**
 * V2: the new folders (depth 1..depth) of the files the diff adds or renames in. `dirExists(folder)` says whether the
 * base has the folder. Only the shallowest new folder of a path counts.
 * @returns {{ folder: string, files: number }[]}
 */
function newFolderFacts(files, { dirExists, depth = DEFAULTS.folderDepth } = {}) {
  const out = [];
  const known = new Map();
  const exists = (d) => {
    if (!known.has(d)) known.set(d, !!dirExists(d));
    return known.get(d);
  };
  for (const f of files) {
    if (!(f.status === 'A' || f.status === 'R') || !f.to || inNodeModules(f.to)) continue;
    const dirs = f.to.split('/').slice(0, -1);
    for (let i = 1; i <= Math.min(depth, dirs.length); i++) {
      const d = dirs.slice(0, i).join('/');
      if (exists(d)) continue;
      const seen = out.find((x) => x.folder === d);
      if (seen) seen.files++;
      else out.push({ folder: d, files: 1 });
      break;
    }
  }
  return out;
}

// ---- V3: a new dependency with the same purpose ---------------------------------------------------------------------

/** Is the path a manifest V3 reads (package.json, requirements*.txt), outside node_modules? */
function isManifest(p) {
  const s = norm(p);
  if (!s || inNodeModules(s)) return false;
  const name = s.split('/').pop();
  return name === 'package.json' || /^requirements[\w.-]*\.txt$/i.test(name);
}
const ecosystemOf = (p) => (norm(p).split('/').pop() === 'package.json' ? 'npm' : 'python');

/** The dependency names a manifest text holds, in order; null when it cannot be read. */
function depsOf(p, text) {
  if (text == null) return null;
  if (ecosystemOf(p) === 'npm') {
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      // error-ignored: an unreadable manifest gives no facts, never a wrong one
      return null;
    }
    if (!isObject(j)) return null;
    const out = [];
    for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'])
      if (isObject(j[k])) for (const n of Object.keys(j[k])) if (!out.includes(n)) out.push(n);
    return out;
  }
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const l = raw.replace(/#.*$/, '').trim();
    if (!l || l.startsWith('-')) continue;
    const m = l.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
    const n = m ? m[1].toLowerCase().replace(/_/g, '-') : null;
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * V3: per manifest { path, base, tip } (the texts; base null for a new manifest), the added dependencies whose purpose
 * group already has another package there (on the base, or added earlier in the same change).
 * @returns {{ manifest: string, added: string, purpose: string, title: string, existing: string[] }[]}
 */
function dependencyFacts(manifests, purposes = PURPOSES) {
  const out = [];
  for (const m of manifests ?? []) {
    const eco = ecosystemOf(m.path);
    const base = m.base == null ? [] : depsOf(m.path, m.base);
    const tip = depsOf(m.path, m.tip);
    if (!base || !tip) continue;
    const have = [...base];
    for (const n of tip) {
      if (base.includes(n)) continue;
      const group = purposes.find((p) => p.ecosystem === eco && p.packages.includes(n));
      const existing = group ? have.filter((x) => x !== n && group.packages.includes(x)) : [];
      if (group && existing.length) out.push({ manifest: m.path, added: n, purpose: group.id, title: group.title, existing });
      have.push(n);
    }
  }
  return out;
}

/** The examples in the purpose table that do not behave, and a package listed twice in one ecosystem (texts). */
function exampleProblems(purposes = PURPOSES) {
  const out = [];
  const seen = new Map();
  const text = (eco, names) =>
    eco === 'npm' ? JSON.stringify({ dependencies: Object.fromEntries(names.map((n) => [n, '1'])) }) : names.join('\n');
  for (const p of purposes) {
    const file = p.ecosystem === 'npm' ? 'package.json' : 'requirements.txt';
    for (const n of p.packages ?? []) {
      const key = `${p.ecosystem}:${n}`;
      if (seen.has(key)) out.push(`${p.id}: ${n} is also in ${seen.get(key)}`);
      else seen.set(key, p.id);
    }
    for (const [kind, want] of [['hit', true], ['miss', false]])
      for (const [x, y] of p.examples?.[kind] ?? []) {
        const facts = dependencyFacts([{ path: file, base: text(p.ecosystem, [x]), tip: text(p.ecosystem, [x, y]) }], purposes);
        if (facts.some((f) => f.added === y) !== want) out.push(`${p.id}: the ${kind} example ${x} + ${y} gives ${want ? 'no note' : 'a note'}`);
      }
  }
  return out;
}

// ---- V5: drift in numbers -------------------------------------------------------------------------------------------

const dirOf = (p) => p.split('/').slice(0, -1).join('/') || '(root)';

/** Does an ownership entry cover the path? A folder ("x/"), a glob, or the exact path. */
function covers(entry, p) {
  const e = norm(entry);
  if (!e) return false;
  if (/[*?]/.test(e)) return globMatch(e, p);
  return e.endsWith('/') ? p.startsWith(e) : p === e;
}

/** The folder an entry names: a folder entry itself, a glob up to its first wildcard, a file its folder. */
function entryFolder(entry) {
  const e = norm(entry);
  if (e.endsWith('/')) return { folder: e.replace(/\/+$/, '') || '(root)', below: true };
  if (/[*?]/.test(e)) {
    const fixed = e.split('/').filter((_, i, a) => !a.slice(0, i + 1).some((s) => /[*?]/.test(s)));
    return { folder: fixed.join('/') || '(root)', below: true };
  }
  return { folder: dirOf(e), below: false };
}

/**
 * V5: how many changed files lie outside owned_files + shared_patch + reads, and their folders; `unnamed` are the
 * folders among them no entry of the task names. A task without owned_files, shared_patch or migr_block has no
 * ownership: every file counts as outside, and `unnamed` is empty (nothing was named).
 */
function driftFacts(changedPaths, task, { migrations = null } = {}) {
  const changed = [...new Set((changedPaths ?? []).map(norm).filter(Boolean))];
  const owned = [...(task?.owned_files ?? []), ...(task?.shared_patch ?? [])].map(norm).filter(Boolean);
  const entries = [...owned, ...(task?.reads ?? []).map(norm).filter(Boolean)];
  const hasOwnership = owned.length > 0 || Boolean(task?.migr_block);
  const covered = (p) => entries.some((e) => covers(e, p)) || migrCovered(p, task?.migr_block ?? null, migrations);
  const outside = hasOwnership ? changed.filter((p) => !covered(p)) : changed;
  const folders = [...new Set(outside.map(dirOf))].sort();
  const named = entries.map(entryFolder);
  const isNamed = (f) => named.some((n) => n.folder === f || (n.below && n.folder !== '(root)' && f.startsWith(`${n.folder}/`)) || (n.below && n.folder === '(root)'));
  return { changed: changed.length, outside: outside.length, hasOwnership, folders, unnamed: hasOwnership ? folders.filter((f) => !isNamed(f)) : [] };
}

// ---- all four, the lines and the package section --------------------------------------------------------------------

/**
 * All parts that are on. `io.findDefinitions(names)`, `io.dirExists(folder)` and `io.readFile(side, path)` ('base' or
 * 'tip') are the caller's look-ups. A part whose look-up throws is skipped, with a line in `errors`.
 */
function assess({ diff, changedPaths = [], task = null, setup = setupOf({}), io = {}, migrations = null }) {
  const files = parseDiff(diff);
  const r = { setup, reuse: [], folders: [], dependencies: [], drift: null, errors: [] };
  const part = (name, fn) => {
    try {
      fn();
    } catch (e) {
      r.errors.push(`${name}: ${e?.message ?? e}`);
    }
  };
  if (setup.reuse) part('reuse', () => (r.reuse = reuseFacts(files, { findDefinitions: io.findDefinitions, ignoreNames: setup.ignoreNames })));
  if (setup.newFolders) part('new folders', () => (r.folders = newFolderFacts(files, { dirExists: io.dirExists, depth: setup.folderDepth })));
  if (setup.dependencies)
    part('dependencies', () => {
      const manifests = files
        .filter((f) => f.status !== 'D' && f.to && isManifest(f.to))
        .map((f) => ({ path: f.to, base: f.status === 'A' ? null : io.readFile('base', f.from ?? f.to), tip: io.readFile('tip', f.to), status: f.status }))
        // A changed manifest the base side of which could not be read would make every dependency look new.
        .filter((m) => m.status === 'A' || m.base != null);
      r.dependencies = dependencyFacts(manifests);
    });
  if (setup.drift) part('drift', () => (r.drift = driftFacts(changedPaths, task, { migrations })));
  return r;
}

const shownFolder = (f) => (f === '(root)' ? 'the root' : f);
/** A short list: the first `n`, then "and k more". */
const shortList = (items, n = 5) => items.slice(0, n).join(', ') + (items.length > n ? ` and ${items.length - n} more` : '');

/** The drift line's fact, or null when there is nothing to say. */
function driftText(d) {
  if (!d) return null;
  if (d.hasOwnership) {
    if (!d.outside) return null;
    const where = d.unnamed.length
      ? `in ${plural(d.unnamed.length, 'folder')} the task does not name (${shortList(d.unnamed.map(shownFolder))})`
      : 'all in folders the task names';
    return { kind: 'drift', text: `${d.outside} of ${plural(d.changed, 'changed file')} ${d.outside === 1 ? 'is' : 'are'} outside owned_files, shared_patch and reads, ${where}` };
  }
  // No ownership (usual in lite): one folder says nothing, two or more say how wide the change went.
  if (d.folders.length < 2) return null;
  return { kind: 'scope', text: `the task names no files; the change touches ${plural(d.changed, 'file')} in ${d.folders.length} folders (${shortList(d.folders.map(shownFolder))})` };
}

/** The receive lines: one NOTE line per fact (at most MAX_LINES of a kind), never a stop. */
function noteLines(r, { id = '?' } = {}) {
  const out = [];
  const where = (o) => `${o.file}:${o.line}`;
  r.reuse.slice(0, MAX_LINES).forEach((x) => {
    const more = x.others.length > 3 ? ` and ${x.others.length - 3} more` : '';
    out.push(`NOTE reuse (${id}): ${x.name} (new in ${x.file}) is already defined in ${x.others.slice(0, 3).map(where).join(', ')}${more}. Reuse it, or say in the report why it differs.`);
  });
  if (r.reuse.length > MAX_LINES) out.push(`NOTE reuse (${id}): and ${plural(r.reuse.length - MAX_LINES, 'more name')} (see 00-package.md).`);
  if (r.folders.length) {
    const list = shortList(r.folders.map((f) => `${f.folder}/ (${plural(f.files, 'file')})`));
    out.push(`NOTE new folder (${id}): ${list} ${r.folders.length === 1 ? 'is' : 'are'} not on the base. A new module boundary is an architecture choice: was it an owner question?`);
  }
  r.dependencies.slice(0, MAX_LINES).forEach((x) =>
    out.push(`NOTE dependency (${id}): ${x.added} in ${x.manifest}, and the project already has ${x.existing.join(', ')} for ${x.title}.`),
  );
  const d = driftText(r.drift);
  if (d) out.push(`NOTE ${d.kind} (${id}): ${d.text}.`);
  return out;
}

/** The "Reuse and scope" section of 00-package.md, as lines; null when every part is off. */
function packageSection(r) {
  const s = r.setup;
  const checked = [s.reuse && 'reuse', s.newFolders && 'new folders', s.dependencies && 'dependencies', s.drift && 'drift'].filter(Boolean);
  if (!checked.length) return null;
  const lines = [
    '',
    '## Reuse and scope',
    '',
    'Facts from receive (lib/scopeNotes.js), never a stop. Weigh them: a helper or rule written again where one exists is ' +
      '`duplication`, a change outside the mission or its files is `scope-drift`. A fact can be fine (a deliberate variant, ' +
      'a folder the mission asked for): then it is no finding.',
    '',
  ];
  const tick = (s2) => `\`${s2}\``;
  for (const x of r.reuse)
    lines.push(`- reuse: ${tick(x.name)} (new in ${tick(x.file)}) is already defined in ${x.others.map((o) => tick(`${o.file}:${o.line}`)).join(', ')}`);
  for (const f of r.folders) lines.push(`- new folder: ${tick(`${f.folder}/`)} (${plural(f.files, 'file')}), not on the base`);
  for (const x of r.dependencies)
    lines.push(`- dependency: ${tick(x.added)} in ${tick(x.manifest)}, the project already has ${x.existing.map(tick).join(', ')} (${x.title})`);
  const d = driftText(r.drift);
  if (d) lines.push(`- ${d.kind}: ${d.text}`);
  for (const e of r.errors) lines.push(`- could not check ${e}`);
  if (lines.length === 5) lines.push(`- None found (checked: ${checked.join(', ')}).`);
  return lines;
}

module.exports = {
  DEFAULTS,
  BUILTIN_IGNORE,
  PURPOSES,
  setupOf,
  setupProblems,
  parseDiff,
  isDefinitionOf,
  newNames,
  reuseFacts,
  newFolderFacts,
  isManifest,
  dependencyFacts,
  exampleProblems,
  driftFacts,
  assess,
  noteLines,
  packageSection,
};
