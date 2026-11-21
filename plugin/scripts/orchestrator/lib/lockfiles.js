// =============================================================
// lockfiles.js: a dependency manifest in git without its lockfile in git.
//
// WHY: without a lockfile in git, every install (each agent's worktree, CI, a teammate) may pick newer versions than
// the ones that were tested, so a red run can come from a library that changed overnight. One rule, two readers: the
// doctor row `lockfile` (cli/doctorBaseline.mjs checkLockfile) and the Checks card lockfile-in-git (cli/checks.mjs,
// condition lockfile-missing), so the two never disagree.
//
//   LOCKS                              manifest -> the lockfiles that pin it (any one is enough). Root only.
//   lockGaps(tracked, existsOnDisk)    [{ manifest, local }] per tracked manifest with no tracked lockfile; `local` is a
//                                      lockfile that is on disk but not in git (null when there is none)
//   hasManifest(tracked)               is any known manifest tracked?
//
// The locked versions (roadmap 0å KD-3, plans/katalog-design-stack-avhengigheter-2026-11-18.md § 5.1): the catalog
// excerpt tells a track which version of a library is installed, so it reads the right API instead of the one it
// remembers. The version comes from the lockfile each time, so it cannot drift from what is installed.
//   parseLock(file, text)              { ecosystem, packages: [{ name, version, specs }] } for package-lock.json,
//                                      npm-shrinkwrap.json, pnpm-lock.yaml, yarn.lock (v1 and berry), bun.lock, uv.lock,
//                                      poetry.lock, Cargo.lock and go.sum (by the file name); null for any other file, an
//                                      empty or broken one. Never throws: a lockfile it cannot read gives no versions.
//   lockedVersion(lock, name, range)   the version of one package, or null. With several versions of a name, the
//                                      manifest's range picks (an exact match, a yarn header that names it, the same
//                                      major), else the highest.
//
// Pure. Tested in: lib/__tests__/lockfiles.test.ts (and doctorBaseline.test.ts for the doctor row) and
// lib/__tests__/lockfilesVersions.test.ts (one fixture per lockfile format).
// =============================================================
'use strict';

const LOCKS = Object.freeze([
  ['package.json', ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock']],
  ['pyproject.toml', ['uv.lock', 'poetry.lock', 'pdm.lock', 'Pipfile.lock', 'requirements.txt']],
  ['Pipfile', ['Pipfile.lock']],
  ['Cargo.toml', ['Cargo.lock']],
  ['go.mod', ['go.sum']],
  ['Gemfile', ['Gemfile.lock']],
  ['composer.json', ['composer.lock']],
]);

/**
 * @param {Set<string>|string[]} tracked  the files git tracks (root-relative, forward slashes)
 * @param {(file: string) => boolean} [existsOnDisk]
 * @returns {{ manifest: string, locks: string[], local: string|null }[]}
 */
function lockGaps(tracked, existsOnDisk = () => false) {
  const set = tracked instanceof Set ? tracked : new Set(tracked ?? []);
  const out = [];
  for (const [manifest, locks] of LOCKS) {
    if (!set.has(manifest) || locks.some((l) => set.has(l))) continue;
    out.push({ manifest, locks, local: locks.find((l) => existsOnDisk(l)) ?? null });
  }
  return out;
}

const hasManifest = (tracked) => {
  const set = tracked instanceof Set ? tracked : new Set(tracked ?? []);
  return LOCKS.some(([m]) => set.has(m));
};

// ---- locked versions (roadmap 0å KD-3) --------------------------------------------------------------------------------

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const textLines = (t) => String(t).replace(/\r\n/g, '\n').split('\n');
/** A PyPI name compared the way the index does (PEP 503): lower case, runs of - _ . as one -. */
const pyName = (n) => String(n ?? '').toLowerCase().replace(/[-_.]+/g, '-');
/** A version without what a lockfile adds after it: pnpm's peer suffix "(react@18)" or "_react@18", a /go.mod. */
const cleanVersion = (s) => {
  const v = String(s ?? '').trim().replace(/^['"]|['"]$/g, '').replace(/\/go\.mod$/, '').split('(')[0];
  if (!v || /^(link|file|workspace|portal|patch):/.test(v)) return null;
  return v.replace(/_.*$/, '') || null;
};
/** "name@range" split at the last @ that is not the first character (a scope); the npm: protocol cut from the range. */
function splitSpec(spec) {
  const s = String(spec ?? '').trim().replace(/^['"]|['"]$/g, '');
  const at = s.lastIndexOf('@');
  if (at <= 0) return { name: s, range: '' };
  return { name: s.slice(0, at), range: s.slice(at + 1).replace(/^npm:/, '') };
}

/** package-lock.json and npm-shrinkwrap.json: v2/v3 `packages` (top level only), v1 `dependencies`. */
function npmLock(text) {
  const j = JSON.parse(text);
  if (!isObject(j)) return null;
  const out = [];
  if (isObject(j.packages))
    for (const [key, e] of Object.entries(j.packages)) {
      const m = /^node_modules\/((?:@[^/]+\/)?[^/]+)$/.exec(key);
      if (m && isObject(e) && typeof e.version === 'string') out.push({ name: m[1], version: e.version, specs: [] });
    }
  else if (isObject(j.dependencies))
    for (const [name, e] of Object.entries(j.dependencies))
      if (isObject(e) && typeof e.version === 'string') out.push({ name, version: e.version, specs: [] });
  return out;
}

/** pnpm-lock.yaml: the root importer (".") of v6 and v9, or the top-level dependency sections of v5. */
function pnpmLock(text) {
  const out = [];
  const SECTIONS = /^(dependencies|devDependencies|optionalDependencies):\s*$/;
  const unquote = (s) => s.trim().replace(/^['"]|['"]$/g, '');
  let top = null; // the top-level key the line is under
  let importer = null; // the importer key (v6, v9)
  let section = false; // inside a dependency section that counts
  let sectionIndent = -1;
  let pending = null; // a name whose version is on an indented line below
  for (const raw of textLines(text)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const l = raw.trim();
    if (indent === 0) {
      top = l.replace(/:.*$/, '');
      importer = null;
      section = top !== 'importers' && SECTIONS.test(l);
      sectionIndent = section ? 0 : -1;
      pending = null;
      continue;
    }
    if (top === 'importers' && indent === 2) {
      importer = unquote(l.replace(/:\s*$/, ''));
      section = false;
      pending = null;
      continue;
    }
    if (top === 'importers' && indent === 4) {
      section = importer === '.' && SECTIONS.test(l);
      sectionIndent = section ? 4 : -1;
      pending = null;
      continue;
    }
    if (!section) continue;
    if (indent === sectionIndent + 2) {
      const m = /^((?:'[^']*'|"[^"]*"|[^:\s]+)):\s*(.*)$/.exec(l);
      if (!m) continue;
      const name = unquote(m[1]);
      const inline = m[2].trim();
      pending = null;
      if (inline) {
        const version = cleanVersion(inline);
        if (version) out.push({ name, version, specs: [] });
      } else pending = name;
      continue;
    }
    if (pending && indent > sectionIndent + 2) {
      const m = /^version:\s*(.+)$/.exec(l);
      if (m) {
        const version = cleanVersion(m[1]);
        if (version) out.push({ name: pending, version, specs: [] });
        pending = null;
      }
    }
  }
  return out;
}

/** yarn.lock, v1 (`version "1.2.3"`) and berry (`version: 1.2.3`): the header names the ranges it resolves. */
function yarnLock(text) {
  const out = [];
  let cur = null;
  for (const raw of textLines(text)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      cur = null;
      if (!raw.trimEnd().endsWith(':') || raw.startsWith('__metadata')) continue;
      const specs = raw
        .trimEnd()
        .slice(0, -1)
        .split(/,\s*/)
        .map(splitSpec)
        .filter((s) => s.name);
      if (!specs.length) continue;
      cur = { name: specs[0].name, version: null, specs: specs.filter((s) => s.name === specs[0].name).map((s) => s.range) };
      out.push(cur);
      continue;
    }
    if (!cur || cur.version) continue;
    const m = /^\s+version:?\s+"?([^"\s]+)"?\s*$/.exec(raw);
    if (m) cur.version = cleanVersion(m[1]);
  }
  return out.filter((e) => e.version);
}

/** bun.lock (the text lockfile; bun.lockb is binary and gives nothing): `packages` key -> ["name@version", ...]. */
function bunLock(text) {
  const j = JSON.parse(String(text).replace(/,(\s*[}\]])/g, '$1'));
  if (!isObject(j) || !isObject(j.packages)) return null;
  const out = [];
  for (const [key, e] of Object.entries(j.packages)) {
    if (!Array.isArray(e) || typeof e[0] !== 'string') continue;
    const s = splitSpec(e[0]);
    const version = cleanVersion(s.range);
    if (s.name === key && version) out.push({ name: s.name, version, specs: [] });
  }
  return out;
}

/** uv.lock, poetry.lock and Cargo.lock: one `[[package]]` table per package, with name and version. */
function tomlPackages(text) {
  const out = [];
  let cur = null;
  for (const raw of textLines(text)) {
    const l = raw.trim();
    if (l.startsWith('[')) {
      cur = l === '[[package]]' ? { name: null, version: null, specs: [] } : null;
      if (cur) out.push(cur);
      continue;
    }
    if (!cur) continue;
    const m = /^(name|version)\s*=\s*"([^"]*)"/.exec(l);
    if (m && cur[m[1]] == null) cur[m[1]] = m[2];
  }
  return out.filter((e) => e.name && e.version);
}

/** go.sum: "module version[/go.mod] hash" per line; each module version once. */
function goSum(text) {
  const out = [];
  for (const raw of textLines(text)) {
    const m = /^(\S+)\s+(v[^\s/]+)(?:\/go\.mod)?\s+\S+/.exec(raw.trim());
    if (m && !out.some((e) => e.name === m[1] && e.version === m[2])) out.push({ name: m[1], version: m[2], specs: [] });
  }
  return out;
}

/** The lockfile formats by file name: the ecosystem and the parser. */
const LOCK_FORMATS = Object.freeze({
  'package-lock.json': ['npm', npmLock],
  'npm-shrinkwrap.json': ['npm', npmLock],
  'pnpm-lock.yaml': ['npm', pnpmLock],
  'yarn.lock': ['npm', yarnLock],
  'bun.lock': ['npm', bunLock],
  'uv.lock': ['python', tomlPackages],
  'poetry.lock': ['python', tomlPackages],
  'Cargo.lock': ['cargo', tomlPackages],
  'go.sum': ['go', goSum],
});

/**
 * The packages a lockfile pins, or null: an unknown file name, no text, a file with a NUL byte or one its parser cannot
 * read. Never throws.
 * @returns {{ ecosystem: string, file: string, packages: { name: string, version: string, specs: string[] }[] }|null}
 */
function parseLock(file, text) {
  const base = String(file ?? '').replace(/\\/g, '/').split('/').pop();
  const format = Object.hasOwn(LOCK_FORMATS, base) ? LOCK_FORMATS[base] : null;
  if (!format || typeof text !== 'string' || !text.trim() || text.includes('\u0000')) return null;
  try {
    const packages = format[1](text);
    if (!Array.isArray(packages)) return null;
    const norm = format[0] === 'python' ? pyName : (n) => n;
    return { ecosystem: format[0], file: base, packages: packages.map((p) => ({ ...p, name: norm(p.name) })) };
  } catch {
    // error-ignored: a lockfile that cannot be read gives no versions, never a stop
    return null;
  }
}

/** The numbers of a version ("v1.9.1-rc.1" -> [1, 9, 1]) and whether it has a pre-release part. */
const numbersOf = (v) => {
  const s = String(v ?? '').replace(/^[v=^~<>\s]+/, '');
  return { n: (s.split(/[-+]/)[0].match(/\d+/g) ?? []).map(Number), pre: /-/.test(s.split('+')[0]) };
};
/** Compares two versions by their numbers; a pre-release before the release. */
function compareVersions(a, b) {
  const x = numbersOf(a);
  const y = numbersOf(b);
  for (let i = 0; i < Math.max(x.n.length, y.n.length); i++) {
    const d = (x.n[i] ?? 0) - (y.n[i] ?? 0);
    if (d) return d;
  }
  return x.pre === y.pre ? 0 : x.pre ? -1 : 1;
}

/**
 * The locked version of a package, or null. range is the manifest's (optional): with several versions of the name it
 * picks the one the range names exactly, then one a yarn header lists for it, then the highest of the same major.
 */
function lockedVersion(lock, name, range = null) {
  if (!lock || !Array.isArray(lock.packages)) return null;
  const want = lock.ecosystem === 'python' ? pyName(name) : String(name ?? '');
  const all = lock.packages.filter((p) => p.name === want);
  if (!all.length) return null;
  const highest = (list) => [...list].sort((a, b) => compareVersions(b.version, a.version))[0]?.version ?? null;
  const r = typeof range === 'string' ? range.trim().replace(/^npm:/, '') : '';
  if (r && all.length > 1) {
    const exact = all.find((p) => p.version === r.replace(/^[=\s]+/, ''));
    if (exact) return exact.version;
    const named = all.find((p) => (p.specs ?? []).includes(r));
    if (named) return named.version;
    const major = numbersOf(r).n[0];
    if (major != null) {
      const same = all.filter((p) => numbersOf(p.version).n[0] === major);
      if (same.length) return highest(same);
    }
  }
  return highest(all);
}

// ---- every package, with where it came from (roadmap 0å KD-4, the dependency audit) ---------------------------------
//
// The audit (lib/osv.js) asks a public database about public packages only, so it needs every package a lockfile pins
// (a hole in a library of a library counts too) and where each one came from. origin:
//   public          the ecosystem's public registry (registry.npmjs.org or registry.yarnpkg.com, pypi.org, crates.io;
//                   every Go module, since go.sum does not say: deps.privateScopes holds private Go paths back)
//   other-registry  another registry or index (often a company's own): its names may be internal
//   git             a git source
//   local           workspace:, file:, link:, a path, an editable or virtual project (the project itself)
//   unknown         the lockfile does not say, or the version is not a plain version (never sent)
// dev is true when the lockfile marks the package as only for development, false when it marks it as not, null when the
// format does not say.

const PUBLIC_NPM = /^https?:\/\/registry\.(?:npmjs\.org|yarnpkg\.com)\//i;
const PLAIN_VERSION = /^v?\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.+-]*)?$/;

/** The origin of an npm package from its resolved URL or protocol (package-lock, yarn v1, bun). Empty: the default. */
function npmOrigin(resolved) {
  const r = String(resolved ?? '').trim();
  if (!r || PUBLIC_NPM.test(r)) return 'public';
  if (/^(?:git\+|git:|github:|gitlab:|bitbucket:)/i.test(r) || /\.git(?:#|$)/.test(r)) return 'git';
  if (/^https?:\/\//i.test(r)) return 'other-registry';
  return 'local';
}

/** One package; a version that is not plain is never public (it is a URL, a commit or a local marker). */
const entry = (name, version, origin, dev = null) => {
  const v = String(version ?? '').trim();
  return { name, version: v, origin: origin === 'public' && !PLAIN_VERSION.test(v) ? 'unknown' : origin, dev };
};

/** package-lock.json v2/v3 (every node_modules entry, nested copies too) and v1 (dependencies, nested). */
function npmAll(text) {
  const j = JSON.parse(text);
  if (!isObject(j)) return null;
  const out = [];
  if (isObject(j.packages)) {
    for (const [key, e] of Object.entries(j.packages)) {
      const i = key.lastIndexOf('node_modules/');
      if (i < 0 || !isObject(e) || e.link === true || typeof e.version !== 'string') continue;
      out.push(entry(key.slice(i + 'node_modules/'.length), e.version, npmOrigin(e.resolved), e.dev === true || e.devOptional === true));
    }
    return out;
  }
  const walk = (deps) => {
    for (const [name, e] of Object.entries(isObject(deps) ? deps : {})) {
      if (!isObject(e) || typeof e.version !== 'string') continue;
      const origin = /^(?:file|link):/.test(e.version) ? 'local' : /^(?:git|github:)/.test(e.version) ? 'git' : npmOrigin(e.resolved);
      out.push(entry(name, e.version, origin, e.dev === true));
      walk(e.dependencies);
    }
  };
  walk(j.dependencies);
  return out;
}

/** pnpm-lock.yaml: the `packages:` section (v5 /name/version, v6 /name@version, v9 name@version), resolution and dev. */
function pnpmAll(text) {
  const out = [];
  let inPackages = false;
  let cur = null;
  for (const raw of textLines(text)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const l = raw.trim();
    if (indent === 0) {
      inPackages = /^packages:\s*$/.test(l);
      cur = null;
      continue;
    }
    if (!inPackages) continue;
    if (indent === 2 && l.endsWith(':')) {
      let key = l.slice(0, -1).trim().replace(/^['"]|['"]$/g, '').replace(/\(.*$/, '');
      const slash = key.startsWith('/');
      if (slash) key = key.slice(1);
      const at = key.lastIndexOf('@');
      let name;
      let version;
      if (at > 0) [name, version] = [key.slice(0, at), key.slice(at + 1)];
      else if (slash) {
        const parts = key.split('/'); // v5: /name/version or /@scope/name/version
        version = parts.pop();
        name = parts.join('/');
      } else {
        cur = null;
        continue;
      }
      cur = { name, version: version.replace(/_.*$/, ''), origin: 'public', dev: null };
      out.push(cur);
      continue;
    }
    if (!cur || indent < 4) continue;
    const res = /^resolution:\s*\{(.*)\}\s*$/.exec(l);
    if (res) {
      const tar = /\btarball:\s*([^,\s}]+)/.exec(res[1]);
      if (/\btype:\s*git\b|\brepo:/.test(res[1])) cur.origin = 'git';
      else if (/\btype:\s*directory\b|\bdirectory:/.test(res[1])) cur.origin = 'local';
      else if (tar) cur.origin = npmOrigin(tar[1]);
      continue;
    }
    const dev = /^dev:\s*(true|false)\s*$/.exec(l);
    if (dev) cur.dev = dev[1] === 'true';
  }
  return out.map((p) => entry(p.name, p.version, p.origin, p.dev));
}

/** yarn.lock v1 (`resolved "url"`) and berry (`resolution: "name@protocol:..."`). */
function yarnAll(text) {
  const out = [];
  let cur = null;
  for (const raw of textLines(text)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      cur = null;
      if (!raw.trimEnd().endsWith(':') || raw.startsWith('__metadata')) continue;
      const first = splitSpec(raw.trimEnd().slice(0, -1).split(/,\s*/)[0]);
      if (!first.name) continue;
      cur = { name: first.name, range: first.range, version: null, resolved: null, resolution: null };
      out.push(cur);
      continue;
    }
    if (!cur) continue;
    const v = /^\s+version:?\s+"?([^"\s]+)"?\s*$/.exec(raw);
    if (v && !cur.version) cur.version = v[1];
    const r = /^\s+resolved\s+"?([^"\s]+)"?\s*$/.exec(raw);
    if (r) cur.resolved = r[1];
    const b = /^\s+resolution:\s+"?([^"]+)"?\s*$/.exec(raw);
    if (b) cur.resolution = b[1];
  }
  return out
    .filter((e) => e.version)
    .map((e) => {
      let origin;
      if (e.resolution) {
        const proto = /@([a-z]+):/.exec(e.resolution.slice(1))?.[1] ?? '';
        origin = proto === 'npm' ? 'public' : /^(?:git|github|https?)$/.test(proto) ? 'git' : 'local';
      } else origin = /^(?:file|link|workspace|portal):/.test(e.range) ? 'local' : npmOrigin(e.resolved);
      return entry(e.name, e.version, origin, null);
    });
}

/** bun.lock: `packages` key -> ["name@version", registry ("" is the default), ...]. Workspaces are left out. */
function bunAll(text) {
  const j = JSON.parse(String(text).replace(/,(\s*[}\]])/g, '$1'));
  if (!isObject(j) || !isObject(j.packages)) return null;
  const out = [];
  for (const e of Object.values(j.packages)) {
    if (!Array.isArray(e) || typeof e[0] !== 'string') continue;
    const s = splitSpec(e[0]);
    if (!s.name || /^(?:workspace|link|file|portal):/.test(s.range)) continue;
    const origin = /^(?:git|github):/.test(s.range) ? 'git' : npmOrigin(typeof e[1] === 'string' ? e[1] : '');
    out.push(entry(s.name, s.range, origin, null));
  }
  return out;
}

/** The origin of a uv.lock source line. */
function uvOrigin(source) {
  const s = String(source ?? '');
  const reg = /registry\s*=\s*"([^"]*)"/.exec(s)?.[1];
  if (reg != null) return /^https:\/\/pypi\.org\/simple\/?$/i.test(reg) ? 'public' : 'other-registry';
  if (/\bgit\s*=/.test(s)) return 'git';
  if (/\b(?:editable|virtual|path|directory)\s*=/.test(s)) return 'local';
  if (/\burl\s*=/.test(s)) return 'other-registry';
  return 'unknown';
}

/** The origin of a Cargo.lock source line: no source is a workspace or path crate. */
function cargoOrigin(source) {
  const s = String(source ?? '').replace(/^"|"$/g, '');
  if (!s) return 'local';
  if (/^(?:registry\+https:\/\/github\.com\/rust-lang\/crates\.io-index|sparse\+https:\/\/index\.crates\.io\/?)$/.test(s)) return 'public';
  return /^git\+/.test(s) ? 'git' : 'other-registry';
}

/** uv.lock, poetry.lock and Cargo.lock: one `[[package]]` table each, with its source. */
function tomlAll(text, kind) {
  const out = [];
  let cur = null;
  let inSource = false;
  for (const raw of textLines(text)) {
    const l = raw.trim();
    if (l.startsWith('[')) {
      inSource = l === '[package.source]' && !!cur;
      if (inSource) continue;
      cur = l === '[[package]]' ? { name: null, version: null, source: null, sourceType: null, category: null } : null;
      if (cur) out.push(cur);
      continue;
    }
    if (!cur) continue;
    if (inSource) {
      const t = /^type\s*=\s*"([^"]*)"/.exec(l);
      if (t) cur.sourceType = t[1];
      else if (!cur.sourceType && /^url\s*=/.test(l)) cur.sourceType = 'url';
      continue;
    }
    const m = /^(name|version|category)\s*=\s*"([^"]*)"/.exec(l);
    if (m && cur[m[1]] == null) cur[m[1]] = m[2];
    const s = /^source\s*=\s*(.+)$/.exec(l);
    if (s && cur.source == null) cur.source = s[1].trim();
  }
  return out
    .filter((e) => e.name && e.version)
    .map((e) => {
      if (kind === 'cargo') return entry(e.name, e.version, cargoOrigin(e.source), null);
      if (kind === 'uv') return entry(pyName(e.name), e.version, uvOrigin(e.source), null);
      // poetry: no source table is PyPI; any source table (git, directory, file, url, a legacy index) is not public
      const t = e.sourceType;
      const origin = !t ? 'public' : t === 'git' ? 'git' : t === 'directory' || t === 'file' ? 'local' : 'other-registry';
      return entry(pyName(e.name), e.version, origin, !t && e.category ? e.category === 'dev' : null);
    });
}

/** go.sum: the module versions that are built (a line with the module's own hash, not only its go.mod). */
function goAll(text) {
  const out = [];
  for (const raw of textLines(text)) {
    const m = /^(\S+)\s+(v[^\s/]+)\s+\S+/.exec(raw.trim());
    if (m && !out.some((e) => e.name === m[1] && e.version === m[2])) out.push(entry(m[1], m[2], 'public', null));
  }
  return out;
}

const AUDIT_FORMATS = Object.freeze({
  'package-lock.json': npmAll,
  'npm-shrinkwrap.json': npmAll,
  'pnpm-lock.yaml': pnpmAll,
  'yarn.lock': yarnAll,
  'bun.lock': bunAll,
  'uv.lock': (t) => tomlAll(t, 'uv'),
  'poetry.lock': (t) => tomlAll(t, 'poetry'),
  'Cargo.lock': (t) => tomlAll(t, 'cargo'),
  'go.sum': goAll,
});

/**
 * Every package a lockfile pins, once per name, version and origin, with its dev flag (see above), or null: an unknown
 * file name, no text, a NUL byte or a file its reader cannot read. Never throws.
 * @returns {{ ecosystem: string, file: string, packages: { name: string, version: string, origin: string, dev: boolean|null }[] }|null}
 */
function auditPackages(file, text) {
  const base = String(file ?? '').replace(/\\/g, '/').split('/').pop();
  const read = Object.hasOwn(AUDIT_FORMATS, base) ? AUDIT_FORMATS[base] : null;
  if (!read || typeof text !== 'string' || !text.trim() || text.includes('\u0000')) return null;
  try {
    const list = read(text);
    if (!Array.isArray(list)) return null;
    const seen = new Map();
    for (const p of list) {
      if (!p.name) continue;
      const k = `${p.name}\u0000${p.version}\u0000${p.origin}`;
      const had = seen.get(k);
      if (!had) seen.set(k, { ...p });
      // dev only when every copy says dev: one copy that is not makes it code that ships
      else if (had.dev !== p.dev) had.dev = had.dev === false || p.dev === false ? false : null;
    }
    return { ecosystem: LOCK_FORMATS[base][0], file: base, packages: [...seen.values()] };
  } catch {
    // error-ignored: a lockfile that cannot be read gives nothing to audit, never a stop
    return null;
  }
}

module.exports = { LOCKS, lockGaps, hasManifest, LOCK_FORMATS, parseLock, lockedVersion, compareVersions, pyName, auditPackages };
