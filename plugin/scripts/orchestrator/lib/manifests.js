// =============================================================
// manifests.js: the direct dependencies a manifest names (package.json, requirements*.txt, pyproject.toml, Cargo.toml,
// go.mod), with the range it asks for and whether it is a dev dependency.
//
// WHY: the dependency note at receive (lib/scopeNotes.js V3), the generated block of stack.md (lib/catalog.js jobsOf)
// and the dependency rows of the catalog excerpt (lib/catalogDeps.js) all need to know what a project depends on. Up to
// roadmap 0å KD-3 only package.json and requirements*.txt were read, so a Python project on pyproject, a Rust crate or a
// Go module got none of it (plans/katalog-design-stack-avhengigheter-2026-11-18.md § 4.3). One reader for all of them,
// so the three never disagree on what a manifest says.
//
//   MANIFEST_NAMES                    the file names read here
//   isManifestName(path)              a manifest by its file name, outside node_modules, vendor and .venv
//   ecosystemOf(path)                 npm, python, cargo or go
//   manifestDeps(path, text)          [{ name, range, dev, indirect? }] in the order of the file, or null when the file
//                                     is no manifest or cannot be read. Never throws.
//   manifestText(ecosystem, names)    a small manifest with these names (the purpose table's examples)
//
// A Python name is compared the way PyPI does (lower case, _ as -), the same form the V3 note always used. The TOML is
// read line by line (tables, `key = value`, arrays over several lines, inline tables): enough for the dependency
// tables, not a general TOML reader.
//
// Pure. Tested in lib/__tests__/manifests.test.ts.
// =============================================================
'use strict';

const MANIFEST_NAMES = Object.freeze(['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod']);
const REQUIREMENTS = /^requirements[\w.-]*\.txt$/i;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const norm = (p) => String(p ?? '').trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '');
const baseName = (p) => norm(p).split('/').pop();
/** The PyPI form of a name, as the V3 note has always compared them. */
const pyName = (n) => String(n ?? '').toLowerCase().replace(/_/g, '-');

/** A manifest by its file name, outside the folders that hold other people's packages. */
function isManifestName(p) {
  const s = norm(p);
  if (!s || /(^|\/)(node_modules|vendor|\.venv|venv|target)\//.test(s)) return false;
  const name = baseName(s);
  return MANIFEST_NAMES.includes(name) || REQUIREMENTS.test(name);
}

/** The ecosystem of a manifest; requirements files and anything unknown read as python (as before KD-3). */
function ecosystemOf(p) {
  const name = baseName(p);
  if (name === 'package.json') return 'npm';
  if (name === 'Cargo.toml') return 'cargo';
  if (name === 'go.mod') return 'go';
  return 'python';
}

// ---- the formats ----------------------------------------------------------------------------------------------------

function packageJson(text) {
  const j = JSON.parse(text);
  if (!isObject(j)) return null;
  const out = [];
  for (const [k, dev] of [['dependencies', false], ['devDependencies', true], ['peerDependencies', false], ['optionalDependencies', false]])
    if (isObject(j[k]))
      for (const [name, range] of Object.entries(j[k]))
        if (!out.some((d) => d.name === name)) out.push({ name, range: typeof range === 'string' ? range : '', dev });
  return out;
}

/** One PEP 508 requirement ("Requests[socks]>=2 ; marker") as { name, range }, or null. */
function requirement(s) {
  const l = String(s ?? '').replace(/\s+#.*$/, '').split(';')[0].trim();
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(.*)$/.exec(l);
  if (!m) return null;
  return { name: pyName(m[1]), range: m[2].replace(/\s+/g, '').replace(/^\(|\)$/g, '') };
}

function requirementsTxt(text) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const l = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!l || l.startsWith('-')) continue;
    const r = requirement(l);
    if (r && !out.some((d) => d.name === r.name)) out.push({ ...r, dev: false });
  }
  return out;
}

/** The quoted strings of a TOML value (an array or a single string), in order. */
const stringsIn = (v) => [...String(v).matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2]);

/**
 * A TOML text as entries { table, key, value }: the table header the line is under ("dependencies",
 * "tool.poetry.group.dev.dependencies"), the key, and the raw value text (an array or inline table over several lines
 * joined into one).
 */
function tomlEntries(text) {
  const out = [];
  let table = '';
  let open = null;
  let depth = 0;
  const balance = (s) => {
    let d = 0;
    let quote = null;
    for (const ch of s) {
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '[' || ch === '{') d++;
      else if (ch === ']' || ch === '}') d--;
      else if (ch === '#') break;
    }
    return d;
  };
  for (const raw of String(text).split(/\r?\n/)) {
    if (open) {
      open.value += ` ${raw.trim()}`;
      depth += balance(raw);
      if (depth <= 0) open = null;
      continue;
    }
    const l = raw.trim();
    if (!l || l.startsWith('#')) continue;
    const h = /^\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/.exec(l);
    if (h) {
      table = h[1].replace(/\s*\.\s*/g, '.');
      continue;
    }
    const kv = /^("[^"]+"|'[^']+'|[A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(l);
    if (!kv) continue;
    const entry = { table, key: kv[1].replace(/^["']|["']$/g, ''), value: kv[2] };
    out.push(entry);
    depth = balance(kv[2]);
    if (depth > 0) open = entry;
  }
  return out;
}

/** A dependency value in Cargo or Poetry: "1.0" or { version = "1.0", ... }; '' when it names no version. */
function versionOfValue(v) {
  const s = String(v ?? '').trim();
  if (/^["']/.test(s)) return stringsIn(s)[0] ?? '';
  const m = /\bversion\s*=\s*["']([^"']*)["']/.exec(s);
  return m ? m[1] : '';
}

function pyprojectToml(text) {
  const out = [];
  const add = (name, range, dev) => {
    if (name && name !== 'python' && !out.some((d) => d.name === name)) out.push({ name, range, dev });
  };
  const entries = tomlEntries(text);
  // PEP 621 first, then the optional and dependency groups (dev), then Poetry.
  for (const e of entries)
    if (e.table === 'project' && e.key === 'dependencies')
      for (const s of stringsIn(e.value)) {
        const r = requirement(s);
        if (r) add(r.name, r.range, false);
      }
  for (const e of entries)
    if (e.table === 'project.optional-dependencies' || e.table === 'dependency-groups')
      for (const s of stringsIn(e.value)) {
        const r = requirement(s);
        if (r) add(r.name, r.range, true);
      }
  for (const e of entries) {
    const main = e.table === 'tool.poetry.dependencies';
    const dev = e.table === 'tool.poetry.dev-dependencies' || /^tool\.poetry\.group\.[^.]+\.dependencies$/.test(e.table);
    if (main || dev) add(pyName(e.key), versionOfValue(e.value), dev);
  }
  return out;
}

function cargoToml(text) {
  const out = [];
  const add = (name, range, dev) => {
    if (name && !out.some((d) => d.name === name)) out.push({ name, range, dev });
  };
  // A dependency table: [dependencies], [dev-dependencies], [build-dependencies], [workspace.dependencies] and the
  // same under [target.'cfg(...)'.]; [dependencies.serde] is the table form of one dependency.
  const kindOf = (table) => {
    const t = table.replace(/^target\.(?:'[^']*'|"[^"]*"|[^.]+)\./, '').replace(/^workspace\./, '');
    const m = /^(dependencies|dev-dependencies|build-dependencies)(?:\.(.+))?$/.exec(t);
    return m ? { dev: m[1] !== 'dependencies', one: m[2] ?? null } : null;
  };
  const single = new Map();
  for (const e of tomlEntries(text)) {
    const k = kindOf(e.table);
    if (!k) continue;
    if (k.one) {
      const name = k.one.replace(/^["']|["']$/g, '');
      if (!single.has(name)) {
        single.set(name, true);
        add(name, '', k.dev);
      }
      if (e.key === 'version') out.find((d) => d.name === name).range = stringsIn(e.value)[0] ?? '';
    } else add(e.key, versionOfValue(e.value), k.dev);
  }
  return out;
}

function goMod(text) {
  const out = [];
  let block = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const l = raw.trim();
    if (block) {
      if (l.startsWith(')')) {
        block = false;
        continue;
      }
    } else if (/^require\s*\($/.test(l)) {
      block = true;
      continue;
    }
    const m = (block ? /^(\S+)\s+(v\S+)(.*)$/ : /^require\s+(\S+)\s+(v\S+)(.*)$/).exec(l);
    if (!m || out.some((d) => d.name === m[1])) continue;
    out.push({ name: m[1], range: m[2], dev: false, ...(/\/\/\s*indirect/.test(m[3]) ? { indirect: true } : {}) });
  }
  return out;
}

/**
 * The direct dependencies a manifest names, or null when the path is no manifest, there is no text, or it cannot be
 * read. Never throws.
 * @returns {{ name: string, range: string, dev: boolean, indirect?: boolean }[]|null}
 */
function manifestDeps(p, text) {
  if (typeof text !== 'string') return null;
  const name = baseName(p);
  try {
    if (name === 'package.json') return packageJson(text);
    if (REQUIREMENTS.test(name)) return requirementsTxt(text);
    if (name === 'pyproject.toml') return pyprojectToml(text);
    if (name === 'Cargo.toml') return cargoToml(text);
    if (name === 'go.mod') return goMod(text);
    return null;
  } catch {
    // error-ignored: an unreadable manifest gives no facts, never a wrong one
    return null;
  }
}

/** A small manifest that names these packages, so the purpose table's examples run through the real reader. */
function manifestText(ecosystem, names) {
  if (ecosystem === 'npm') return { path: 'package.json', text: JSON.stringify({ dependencies: Object.fromEntries(names.map((n) => [n, '1'])) }) };
  if (ecosystem === 'cargo') return { path: 'Cargo.toml', text: ['[dependencies]', ...names.map((n) => `${n} = "1"`)].join('\n') };
  if (ecosystem === 'go') return { path: 'go.mod', text: ['module example.com/m', 'require (', ...names.map((n) => `\t${n} v1.0.0`), ')'].join('\n') };
  return { path: 'requirements.txt', text: names.join('\n') };
}

module.exports = { MANIFEST_NAMES, isManifestName, ecosystemOf, manifestDeps, manifestText, pyName };
