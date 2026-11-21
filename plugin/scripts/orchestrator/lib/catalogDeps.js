// =============================================================
// catalogDeps.js: the dependencies in the project catalog (roadmap 0å KD-3,
// plans/katalog-design-stack-avhengigheter-2026-11-18.md § 5.1 and § 5.2).
//
// WHY: a model often knows another major version of a library than the one the project has locked, and a track has no
// network to look it up (no WebFetch, the push guard denies curl). So the mission says which version is installed and
// where on disk its types or README are, and the owner's table in stack.md adds what the package is for and where its
// docs are. The version is never written by hand: it comes from the lockfile each time the excerpt is made, so it
// cannot drift.
//
// Two parts with a sharp line between them:
//   - the hand-written table `## Dependencies` in stack.md (parseDepsTable): | Package | Purpose | Docs | Note |, at
//     most about TABLE_ROWS rows. Docs may be a template with {major}, {minor} or {version} (fillDocs).
//   - the facts read from the tree (depRows): the root manifests (lib/manifests.js), their lockfiles
//     (lib/lockfiles.js parseLock) and what is installed (node_modules, a venv, vendor/).
//
//   parseDepsTable(source)            { rows: [{ package, purpose, docs, note, line }], errors, warnings }
//   fillDocs(template, version)       the docs link for this version, or null when a placeholder cannot be filled
//   importsOf(file, text)             the package names a JS/TS, Python, Rust or Go file imports (a Set)
//   depRows(task, io, { table })      { rows, cut }: the packages the task's files import (owned_files, shared_patch,
//                                     reads; files only, a folder is not read), the table's rows first, at most
//                                     MAX_ROWS, each { name, ecosystem, version, how, path, docs, purpose, note }
//   proposals({ files, io })          the rows `catalog init` proposes, from local metadata only (never the network):
//                                     the packages the code imports, with docs from node_modules or the venv's
//                                     METADATA, a docs.rs or pkg.go.dev template for a crate or a Go module
//   tableText(rows)                   the `## Dependencies` section as lines
//
// io is { read(path) -> text|null, exists(path) -> boolean, list(folder) -> names }, root-relative with forward
// slashes. Nothing here throws on a broken file: a lockfile or manifest it cannot read gives no versions.
// Pure. Tested in lib/__tests__/catalogDeps.test.ts.
// =============================================================
'use strict';

const L = require('./lockfiles.js');
const MF = require('./manifests.js');

/** At most this many dependency rows in one excerpt (§ 5.2). */
const MAX_ROWS = 8;
/** The table stays short, like reuse.md. */
const TABLE_ROWS = 40;
/** At most this many of a task's files are read for their imports, none over FILE_BYTES. */
const TASK_FILES = 40;
const FILE_BYTES = 512 * 1024;
/** `catalog init` reads at most this many code files for the imports, and proposes at most PROPOSALS rows. */
const INIT_FILES = 2000;
const PROPOSALS = 20;
const PURPOSE_MAX = 80;

const HEADING = /^#{1,6}\s+dependencies\s*$/i;
const DEPS_INTRO =
  'One row per library a track should know: what it is for, where its docs are (a link, or a template with {major}, ' +
  '{minor} or {version} that the locked version fills), a note. The version is never written here: it comes from the ' +
  'lockfile.';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const cut = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 3).replace(/\s+\S*$/, '')}...`);
/** A name compared across ecosystems and with the table: lower case, runs of - _ . as one -. */
const key = (s) => String(s ?? '').toLowerCase().replace(/[-_.]+/g, '-');

// ---- the table ------------------------------------------------------------------------------------------------------

/**
 * The `## Dependencies` table of stack.md. A row with other than four cells or without a package is an error (as a
 * broken reuse row is); a docs cell that is no link a warning (it is left out); more than TABLE_ROWS rows a warning.
 */
function parseDepsTable(source) {
  const C = require('./catalog.js');
  const rows = [];
  const errors = [];
  const warnings = [];
  const sep = (l) => /^\s*\|[\s:|-]+\|?\s*$/.test(l) && /-/.test(l);
  const vis = C.visibleLines(source);
  let inside = false;
  vis.forEach(({ text: l, line }, i) => {
    if (/^#{1,6}\s/.test(l)) {
      inside = HEADING.test(l.trim());
      return;
    }
    if (!inside || !l.trim().startsWith('|') || sep(l)) return;
    if (sep(vis[i + 1]?.text ?? '')) return; // the header row
    const c = C.cells(l);
    if (c.length !== 4 || !c[0]) {
      errors.push(`stack.md:${line}: a row needs four cells: | package | purpose | docs | note |`);
      return;
    }
    const name = c[0].replace(/^`|`$/g, '');
    let docs = c[2].replace(/^<|>$/g, '');
    if (docs === '-') docs = '';
    if (docs && !/^https?:\/\/\S+$/.test(docs)) {
      warnings.push(`stack.md:${line}: the docs of ${name} is not a link (https://...); the excerpt leaves it out`);
      docs = '';
    }
    rows.push({ package: name, purpose: c[1], docs, note: c[3], line });
  });
  if (rows.length > TABLE_ROWS)
    warnings.push(`stack.md: ${rows.length} rows; keep it to about ${TABLE_ROWS}, the libraries a track should know`);
  return { rows, errors, warnings };
}

/** The `## Dependencies` section as lines (catalog init), cells escaped so parseDepsTable reads them back. */
function tableText(rows) {
  const cell = (s) => oneLine(s).replace(/\|/g, '\\|');
  return [
    '## Dependencies',
    '',
    `<!-- ${DEPS_INTRO} -->`,
    '',
    '| Package | Purpose | Docs | Note |',
    '|---|---|---|---|',
    // An empty cell is one space ("| |"), as a person writes it.
    ...(rows ?? []).map((r) => `|${[r.package, r.purpose, r.docs, r.note].map((c) => (cell(c) ? ` ${cell(c)} ` : ' ')).join('|')}|`),
    '',
  ];
}

/** The docs link for a version: {major}, {minor} and {version} filled; null when there is none or one cannot be. */
function fillDocs(template, version) {
  const t = String(template ?? '').trim();
  if (!t) return null;
  if (!/\{(major|minor|version)\}/.test(t)) return t;
  if (!version) return null;
  const n = String(version).replace(/^v/, '').split(/[-+]/)[0].split('.');
  return t
    .replace(/\{major\}/g, n[0] ?? '0')
    .replace(/\{minor\}/g, `${n[0] ?? '0'}.${n[1] ?? '0'}`)
    .replace(/\{version\}/g, String(version));
}

// ---- imports --------------------------------------------------------------------------------------------------------

const JS_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/i;
const RUST_SKIP = new Set(['crate', 'self', 'super', 'Self']);

/** The package names a file imports: npm package names, Python top modules, Rust crate idents, Go import paths. */
function importsOf(file, text) {
  const out = new Set();
  const s = String(text ?? '');
  const f = String(file ?? '');
  if (JS_FILE.test(f)) {
    for (const m of s.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"\s]+)['"]/g)) {
      const spec = m[1];
      if (/^[./#~]/.test(spec) || spec.includes(':')) continue;
      const parts = spec.split('/');
      out.add(spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]);
    }
  } else if (/\.pyi?$/i.test(f)) {
    for (const raw of s.split(/\r?\n/)) {
      const from = /^\s*from\s+([A-Za-z_][\w.]*)\s+import\b/.exec(raw);
      if (from) out.add(from[1].split('.')[0]);
      const imp = /^\s*import\s+(.+)$/.exec(raw);
      if (imp)
        for (const part of imp[1].replace(/#.*$/, '').split(',')) {
          const m = /^\s*([A-Za-z_]\w*)/.exec(part);
          if (m) out.add(m[1]);
        }
    }
  } else if (/\.rs$/i.test(f)) {
    for (const m of s.matchAll(/\b(?:use\s+(?:::)?|extern\s+crate\s+)([A-Za-z_]\w*)|\b([A-Za-z_]\w*)::/g)) {
      const id = m[1] ?? m[2];
      if (!RUST_SKIP.has(id)) out.add(id);
    }
  } else if (/\.go$/i.test(f)) {
    for (const m of s.matchAll(/\bimport\s*\(([\s\S]*?)\)/g)) for (const q of m[1].matchAll(/"([^"\s]+)"/g)) out.add(q[1]);
    for (const m of s.matchAll(/\bimport\s+(?:[\w.]+\s+)?"([^"\s]+)"/g)) out.add(m[1]);
  }
  return out;
}

/** Does a dependency show among a file's imports? */
function imported(dep, imports) {
  if (dep.ecosystem === 'npm') return imports.has(dep.name);
  if (dep.ecosystem === 'python') {
    const mod = dep.name.toLowerCase().replace(/[-.]/g, '_');
    return [...imports].some((i) => i.toLowerCase() === mod);
  }
  if (dep.ecosystem === 'cargo') return imports.has(dep.name.replace(/-/g, '_'));
  if (dep.ecosystem === 'go') return [...imports].some((i) => i === dep.name || i.startsWith(`${dep.name}/`));
  return false;
}

// ---- the tree -------------------------------------------------------------------------------------------------------

const safe = (fn, fallback) => {
  try {
    return fn();
  } catch {
    // error-ignored: a file the tree cannot give is a missing file, never a stop
    return fallback;
  }
};
const readText = (io, p) => {
  const t = safe(() => io.read(p), null);
  return typeof t === 'string' && t.length <= FILE_BYTES && !t.includes('\u0000') ? t : null;
};
const exists = (io, p) => Boolean(safe(() => io.exists(p), false));
const list = (io, d) => {
  const l = safe(() => io.list(d), []);
  return Array.isArray(l) ? l : [];
};

/**
 * The root manifests with their direct dependencies and the lockfile that pins them (the first that parses, in the
 * order of lib/lockfiles.js LOCKS). Each dependency once, the first manifest that names it wins.
 */
function rootDeps(io) {
  const names = [...MF.MANIFEST_NAMES, ...list(io, '').filter((n) => /^requirements[\w.-]*\.txt$/i.test(n))];
  const out = [];
  for (const m of names) {
    const deps = MF.manifestDeps(m, readText(io, m));
    if (!deps) continue;
    const locks = (L.LOCKS.find(([x]) => x === m)?.[1] ?? []).filter((f) => exists(io, f));
    let lock = null;
    for (const f of locks) {
      lock = L.parseLock(f, readText(io, f));
      if (lock) break;
    }
    const ecosystem = MF.ecosystemOf(m);
    for (const d of deps)
      if (!out.some((x) => x.ecosystem === ecosystem && key(x.name) === key(d.name))) out.push({ ...d, ecosystem, manifest: m, lock });
  }
  return out;
}

/** The site-packages folders of a venv at the root (.venv or venv; lib/python3.x on POSIX, Lib on Windows). */
function sitePackages(io) {
  const out = [];
  for (const v of ['.venv', 'venv']) {
    if (!exists(io, v)) continue;
    for (const py of list(io, `${v}/lib`)) if (/^python\d/.test(py)) out.push(`${v}/lib/${py}/site-packages`);
    if (exists(io, `${v}/Lib/site-packages`)) out.push(`${v}/Lib/site-packages`);
  }
  return out;
}

/** The installed copy of a dependency: { version, path, meta } (each may be null). path is what a track should read. */
function installedOf(dep, io) {
  const none = { version: null, path: null, meta: null };
  if (dep.ecosystem === 'npm') {
    const dir = `node_modules/${dep.name}`;
    const pkgText = readText(io, `${dir}/package.json`);
    if (pkgText == null) return none;
    const pkg = safe(() => JSON.parse(pkgText), null);
    const meta = isObject(pkg) ? pkg : {};
    const types = [meta.types, meta.typings].find((t) => typeof t === 'string' && t.trim());
    const candidates = [
      types ? `${dir}/${types.replace(/^\.\//, '')}` : null,
      `${dir}/index.d.ts`,
      `node_modules/@types/${dep.name.replace(/^@([^/]+)\//, '$1__')}/index.d.ts`,
      `${dir}/README.md`,
      `${dir}/readme.md`,
    ].filter(Boolean);
    const found = candidates.find((p) => exists(io, p)) ?? `${dir}/`;
    return { version: typeof meta.version === 'string' ? meta.version : null, path: found, meta };
  }
  if (dep.ecosystem === 'python') {
    const mod = dep.name.toLowerCase().replace(/[-.]/g, '_');
    for (const sp of sitePackages(io)) {
      const entries = list(io, sp);
      const info = entries.find((e) => {
        const m = /^(.+)-([^-]+)\.dist-info$/.exec(e);
        return m && key(m[1]) === key(dep.name);
      });
      const version = info ? /-([^-]+)\.dist-info$/.exec(info)[1] : null;
      const meta = info ? readText(io, `${sp}/${info}/METADATA`) : null;
      const dir = entries.find((e) => e.toLowerCase() === mod);
      const file = entries.find((e) => e.toLowerCase() === `${mod}.py`);
      const p = dir ? `${sp}/${dir}/` : file ? `${sp}/${file}` : null;
      if (p || version) return { version, path: p, meta };
    }
    return none;
  }
  if (dep.ecosystem === 'go') {
    const dir = `vendor/${dep.name}`;
    return exists(io, dir) ? { version: null, path: `${dir}/`, meta: null } : none;
  }
  return none; // a crate lives in the cargo registry outside the tree
}

/** An exact version the manifest itself pins (==1.2.3 in Python, a Go require, 1.2.3 in package.json), or null. */
function pinnedOf(dep) {
  const r = String(dep.range ?? '').trim();
  if (dep.ecosystem === 'go') return /^v\d/.test(r) ? r : null;
  const m = /^(?:==|=)?\s*(\d+\.\d+(?:\.\d+)?[\w.+-]*)$/.exec(r);
  return m && (dep.ecosystem !== 'python' || r.startsWith('==')) ? m[1] : null;
}

/** The task's files (not folders), as catalogExcerpt.js scopeOf names them. */
function taskFiles(task) {
  const out = [];
  for (const k of ['owned_files', 'shared_patch', 'reads'])
    for (const p of Array.isArray(task?.[k]) ? task[k] : []) {
      const n = typeof p === 'string' ? p.trim().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '') : '';
      if (n && !n.endsWith('/') && !/[*?[{]/.test(n) && !out.includes(n)) out.push(n);
    }
  return out;
}

/**
 * The dependency rows for a task: the packages its files import, the table's rows first (in table order), then the
 * other direct dependencies in manifest order; at most MAX_ROWS. A package with no version (no lockfile entry, not
 * installed, not pinned) is left out unless the table has a row for it. Never throws.
 * @returns {{ rows: { name: string, ecosystem: string, version: string|null, how: 'locked'|'installed'|'pinned'|null,
 *   path: string|null, docs: string|null, purpose: string, note: string }[], cut: number }}
 */
function depRows(task, io, { table = [] } = {}) {
  const files = taskFiles(task).slice(0, TASK_FILES);
  if (!files.length) return { rows: [], cut: 0 };
  const imports = new Set();
  for (const f of files) for (const i of importsOf(f, readText(io, f))) imports.add(i);
  if (!imports.size) return { rows: [], cut: 0 };
  const deps = safe(() => rootDeps(io), []).filter((d) => imported(d, imports));
  if (!deps.length) return { rows: [], cut: 0 };
  const rowOf = (d) => (table ?? []).find((r) => key(r.package) === key(d.name)) ?? null;
  const order = (d) => {
    const i = (table ?? []).indexOf(rowOf(d));
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  const sorted = deps.map((d, i) => ({ d, i })).sort((a, b) => order(a.d) - order(b.d) || a.i - b.i).map((x) => x.d);
  const rows = [];
  for (const d of sorted) {
    const row = rowOf(d);
    const inst = safe(() => installedOf(d, io), { version: null, path: null });
    const locked = L.lockedVersion(d.lock, d.name, d.range);
    const pinned = pinnedOf(d);
    const version = locked ?? inst.version ?? pinned ?? null;
    const how = locked ? 'locked' : inst.version ? 'installed' : pinned ? 'pinned' : null;
    if (!version && !row) continue;
    rows.push({
      name: d.name,
      ecosystem: d.ecosystem,
      version,
      how,
      path: inst.path ?? null,
      docs: row ? fillDocs(row.docs, version) : null,
      purpose: row?.purpose ?? '',
      note: row?.note ?? '',
    });
  }
  return { rows: rows.slice(0, MAX_ROWS), cut: Math.max(0, rows.length - MAX_ROWS) };
}

// ---- init proposals -------------------------------------------------------------------------------------------------

/** A repository field as an https link (git+https, .git, git@github.com:), or ''. */
function repoLink(r) {
  const raw = typeof r === 'string' ? r : isObject(r) && typeof r.url === 'string' ? r.url : '';
  let s = raw.trim().replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://');
  s = s.replace(/^git@([^:]+):/, 'https://$1/').replace(/^github:/, 'https://github.com/');
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) s = `https://github.com/${s}`;
  return /^https?:\/\/\S+$/.test(s) ? s : '';
}

/** The docs link and a short description from local metadata only. */
function localMeta(dep, io) {
  if (dep.ecosystem === 'cargo') return { docs: `https://docs.rs/${dep.name}/{version}`, about: '' };
  if (dep.ecosystem === 'go') return { docs: `https://pkg.go.dev/${dep.name}@{version}`, about: '' };
  const inst = safe(() => installedOf(dep, io), { meta: null });
  if (dep.ecosystem === 'npm') {
    const m = isObject(inst.meta) ? inst.meta : {};
    const home = typeof m.homepage === 'string' ? m.homepage.trim().replace(/#readme$/, '') : '';
    return { docs: /^https?:\/\/\S+$/.test(home) ? home : repoLink(m.repository), about: typeof m.description === 'string' ? m.description : '' };
  }
  const text = typeof inst.meta === 'string' ? inst.meta : '';
  const header = (re) => text.split(/\r?\n/).map((l) => re.exec(l)?.[1]?.trim()).find(Boolean) ?? '';
  const docs =
    header(/^Project-URL:\s*Documentation\s*,\s*(\S+)/i) ||
    header(/^Project-URL:\s*Home(?:page)?\s*,\s*(\S+)/i) ||
    header(/^Home-page:\s*(\S+)/i);
  return { docs: /^https?:\/\/\S+$/.test(docs) ? docs : '', about: header(/^Summary:\s*(.+)$/i) };
}

/**
 * The rows `catalog init` proposes for the Dependencies table: the direct dependencies the tracked code imports (at most
 * INIT_FILES files read), in manifest order, at most PROPOSALS. The purpose is the purpose group's title, else the
 * package's own description; the docs come from local metadata. No network, ever.
 * @param {{ files: string[], io: object, purposes?: object[] }} x
 */
function proposals({ files, io, purposes = require('./scopeNotes.js').PURPOSES }) {
  const code = (files ?? [])
    .filter((f) => typeof f === 'string' && !/(^|\/)(node_modules|vendor|\.venv|venv|target|dist|build)\//.test(f))
    .filter((f) => JS_FILE.test(f) || /\.(pyi?|rs|go)$/i.test(f))
    .slice(0, INIT_FILES);
  const imports = new Set();
  for (const f of code) for (const i of importsOf(f, readText(io, f))) imports.add(i);
  if (!imports.size) return [];
  const out = [];
  for (const d of safe(() => rootDeps(io), [])) {
    if (out.length >= PROPOSALS) break;
    if (!imported(d, imports)) continue;
    const group = (purposes ?? []).find((p) => p.ecosystem === d.ecosystem && (p.packages ?? []).some((n) => key(n) === key(d.name)));
    const meta = localMeta(d, io);
    out.push({ package: d.name, purpose: cut(oneLine(group?.title ?? meta.about), PURPOSE_MAX), docs: meta.docs, note: '' });
  }
  return out;
}

module.exports = { MAX_ROWS, TABLE_ROWS, DEPS_INTRO, parseDepsTable, tableText, fillDocs, importsOf, depRows, proposals };
