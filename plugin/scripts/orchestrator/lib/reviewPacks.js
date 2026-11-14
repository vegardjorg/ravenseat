// =============================================================
// reviewPacks.js: stack packs for the review signals. One pack per stack (Spring, Django, Next.js, Supabase ...) adds
// the risky APIs of that stack to the signals in lib/reviewSignals.js, so a class K task that opens an access rule,
// builds raw SQL or switches CSRF off brings the security reviewer in.
//
// Why data and not a text Claude reads at setup: a pack does the same thing every time, and its examples are tests.
// The data is review-packs/packs.json (shipped with the plugin); a project adds or replaces a pack with a file in
// docs/queue/review-packs/<id>.json. A pack is turned on per project with review.packs in queue.config.json, written by
// `ravenseat checks packs --apply` after the owner's yes (the Checks tab). Nothing here turns a pack on by itself.
//
// A pack: { id, title, kind, detect, signals, examples, codeExt?, codeFiles?, notes?, sources? }
//   detect    which manifests show the stack: npm, pypi, gem, composer, maven ("group:artifact"), go (module prefix),
//             hex, pub, nuget (a name ending in "." is a prefix), csprojSdk, files (a file that exists), contains
//             ([{ file, text }]), always (core: offered with any project)
//   signals   in the review.signals format: { "<signal>": { paths?, words? } }. A signal that is not built in must be
//             one of newSignals (raw-sql, access-rule ...), which gives its reviewer and text.
//   examples  hit: [{ file, line, signal }] must hit; miss: [{ file, line }] must hit nothing; pathHit / pathMiss the same
//             for paths. At least two hits and two misses.
//   codeExt / codeFiles  file kinds the signals should also read (.sql, .rules), which are not code files by default.
//
// Detection only READS manifest files (never runs a package manager), so it is safe in a repo someone else wrote.
//
//   builtinData()                 the shipped data (read once)
//   mergePacks(data, own)         a project's packs over the shipped ones
//   loadPacks({ own })            the shipped data with the project's folder merged in
//   packSignals(ids, data)        what a list of ids adds: { signals, codeExt, codeFiles }
//   validatePack(pack, data)      problems in words (empty = valid), including the lookahead trap
//   exampleProblems(pack, data)   the examples that do not behave
//   detectStacks(fsLike, data)    { packs: [ids found], unpacked: [known stacks with no pack] }
//
// Used by: lib/reviewSignals.js, cli/checks.mjs. Tested in: lib/__tests__/reviewPacks.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const BUILTIN_FILE = path.join(__dirname, '..', 'review-packs', 'packs.json');
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (x) => (Array.isArray(x) ? x.filter((v) => typeof v === 'string' && v) : []);

let builtin = null;
/** The shipped packs, read once. */
function builtinData() {
  if (!builtin) builtin = JSON.parse(fs.readFileSync(BUILTIN_FILE, 'utf8'));
  return builtin;
}

/** The project's packs over the shipped ones (same id replaces). */
function mergePacks(data, own) {
  const packs = { ...data.packs };
  for (const p of own ?? []) if (isObject(p) && typeof p.id === 'string') packs[p.id] = { ...p, own: true };
  return { ...data, packs };
}

/** The shipped packs with the project's folder (docs/queue/review-packs/*.json) merged in. Problems in words. */
function loadPacks({ own } = {}) {
  const data = builtinData();
  const mine = [];
  const problems = [];
  let names = [];
  try {
    names = own ? fs.readdirSync(own).filter((f) => f.endsWith('.json')).sort() : [];
  } catch {
    /* no own packs */
  }
  for (const f of names) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(own, f), 'utf8'));
      const errors = validatePack(p, data);
      if (errors.length) problems.push(...errors.map((e) => `docs/queue/review-packs/${f}: ${e}`));
      else mine.push(p);
    } catch (e) {
      problems.push(`docs/queue/review-packs/${f}: ${e.message}`);
    }
  }
  return { ...mergePacks(data, mine), problems };
}

/**
 * What a list of pack ids adds to the signals. Unknown ids are skipped (a project pack that is turned on has its
 * signals written to review.signals instead, see cli/checks.mjs).
 * @returns {{ signals: Record<string, { reviewer?: string, text?: string, paths: string[], words: string[] }>, codeExt: Set<string>, codeFiles: Set<string> }}
 */
function packSignals(ids, data = builtinData()) {
  const signals = {};
  const codeExt = new Set();
  const codeFiles = new Set();
  for (const id of list(ids)) {
    const p = data.packs?.[id];
    if (!isObject(p)) continue;
    for (const [name, s] of Object.entries(isObject(p.signals) ? p.signals : {})) {
      const known = data.newSignals?.[name];
      const o = (signals[name] ??= { ...(known ? { reviewer: known.reviewer, text: known.text } : {}), paths: [], words: [] });
      for (const k of ['paths', 'words']) for (const v of list(s?.[k])) if (!o[k].includes(v)) o[k].push(v);
    }
    for (const e of list(p.codeExt)) codeExt.add(e.toLowerCase());
    for (const f of list(p.codeFiles)) codeFiles.add(f);
  }
  return { signals, codeExt, codeFiles };
}

// ---- Validation ----

// `\s*(?!x)` lets \s* take nothing and then sees the space, so "(  'x'" still matches. Write `\s*(?!\s*x)`.
const LOOKAHEAD_TRAP = /\\s\*\(\?!(?!\\s\*)/;

/** Problems in a pack, in words. Empty = valid. */
function validatePack(pack, data = builtinData()) {
  const RS = require('./reviewSignals.js');
  const id = typeof pack?.id === 'string' ? pack.id : '(no id)';
  const out = [];
  if (!/^[a-z0-9][a-z0-9-]{0,59}$/.test(pack?.id ?? '')) out.push(`${id}: "id" must be lower case letters, digits and -`);
  if (typeof pack?.title !== 'string' || !pack.title.trim()) out.push(`${id}: "title" is missing`);
  if (!isObject(pack?.detect)) out.push(`${id}: "detect" is missing`);
  if (!isObject(pack?.signals) || !Object.keys(pack.signals).length) out.push(`${id}: "signals" is missing`);
  for (const [name, s] of Object.entries(isObject(pack?.signals) ? pack.signals : {})) {
    if (!RS.BUILTIN[name] && !data.newSignals?.[name]) out.push(`${id}: unknown signal "${name}" (known: ${[...RS.BUILTIN_NAMES, ...Object.keys(data.newSignals ?? {})].join(', ')})`);
    for (const w of list(s?.words)) {
      try {
        new RegExp(w, 'i');
      } catch (e) {
        out.push(`${id}.${name}: word ${JSON.stringify(w)} does not compile (${e.message})`);
        continue;
      }
      if (LOOKAHEAD_TRAP.test(w)) out.push(`${id}.${name}: word ${JSON.stringify(w)} has the lookahead trap \\s*(?!...): write \\s*(?!\\s*...)`);
    }
  }
  const ex = isObject(pack?.examples) ? pack.examples : {};
  if (list((ex.hit ?? []).map((h) => h?.line)).length < 2 || list((ex.miss ?? []).map((m) => m?.line)).length < 2)
    out.push(`${id}: needs at least two hit and two miss examples`);
  return out;
}

/** A unified diff that adds one line to a file. */
const oneLine = (file, line) => [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, '@@ -0,0 +1 @@', `+${line}`].join('\n');

/** The examples that do not behave, with the pack and core on (as the Checks tab turns them on). */
function exampleProblems(pack, data = builtinData()) {
  const RS = require('./reviewSignals.js');
  const merged = mergePacks(data, [pack]);
  const ids = pack.id === 'core' ? ['core'] : ['core', pack.id];
  const config = { review: { packs: ids } };
  const names = (hits) => hits.map((h) => h.name);
  const out = [];
  const ex = isObject(pack.examples) ? pack.examples : {};
  for (const h of ex.hit ?? []) {
    const got = names(RS.signalHits({ config, diff: oneLine(h.file, h.line), packs: merged }));
    if (!got.includes(h.signal)) out.push(`${pack.id}: hit [${h.signal}] does not hit: ${h.line} (got ${got.join(',') || 'none'})`);
  }
  for (const m of ex.miss ?? []) {
    const got = names(RS.signalHits({ config, diff: oneLine(m.file, m.line), packs: merged }));
    if (got.length) out.push(`${pack.id}: miss hits [${got.join(',')}]: ${m.line}`);
  }
  for (const p of ex.pathHit ?? []) {
    const got = names(RS.signalHits({ config, changedPaths: [p.file], packs: merged }));
    if (!got.includes(p.signal)) out.push(`${pack.id}: path ${p.file} does not hit ${p.signal}`);
  }
  for (const p of ex.pathMiss ?? []) {
    const got = names(RS.signalHits({ config, changedPaths: [p], packs: merged }));
    if (got.length) out.push(`${pack.id}: path ${p} hits [${got.join(',')}]`);
  }
  return out;
}

// ---- Detection (reads manifests only) ----

const lower = (s) => String(s).toLowerCase();
const pyName = (s) => lower(s).replace(/_/g, '-');

/** JSON or null. */
function parse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Folders that hold other people's code or build output, never the project's own manifests. */
const SKIP = new Set(['node_modules', 'vendor', 'dist', 'build', 'target', 'out', 'coverage', 'tmp', 'temp']);

/** The folders a manifest is looked for in: the root, and one level below the usual workspace folders. */
function folders({ list: ls }) {
  const out = [''];
  for (const top of ['packages', 'apps', 'services', 'src', 'backend', 'frontend', 'server', 'client', 'web', 'api'])
    for (const name of safe(() => ls(top), [])) if (!name.includes('.') && !SKIP.has(name)) out.push(`${top}/${name}/`);
  for (const name of safe(() => ls(''), [])) if (!name.startsWith('.') && !name.includes('.') && !SKIP.has(name)) out.push(`${name}/`);
  return [...new Set(out)];
}

function safe(fn, fallback) {
  try {
    return fn() ?? fallback;
  } catch {
    return fallback;
  }
}

/** Every dependency name the manifests list, per ecosystem. */
function readManifests(fsLike) {
  const { exists, read, list: ls } = fsLike;
  const deps = { npm: new Set(), pypi: new Set(), gem: new Set(), composer: new Set(), maven: new Set(), go: new Set(), hex: new Set(), pub: new Set(), nuget: new Set(), csprojSdk: new Set(), cargo: new Set(), swiftpm: new Set() };
  const text = (f) => safe(() => (exists(f) ? read(f) : null), null);
  for (const dir of folders(fsLike)) {
    const pkg = parse(text(`${dir}package.json`) ?? 'null');
    if (isObject(pkg))
      for (const k of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'])
        for (const n of Object.keys(isObject(pkg[k]) ? pkg[k] : {})) deps.npm.add(lower(n));
    for (const f of safe(() => ls(dir.replace(/\/$/, '')), []).filter((n) => /^requirements.*\.txt$/i.test(n))) {
      for (const line of String(text(`${dir}${f}`) ?? '').split(/\r?\n/)) {
        const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line);
        if (m && !line.trim().startsWith('-')) deps.pypi.add(pyName(m[1]));
      }
    }
    const py = text(`${dir}pyproject.toml`);
    if (py) {
      let section = '';
      for (const line of py.split(/\r?\n/)) {
        const h = /^\s*\[([^\]]+)\]/.exec(line);
        if (h) section = h[1].trim();
        const quoted = /^\s*["']([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(line);
        if (quoted && /dependencies|^project$|optional-dependencies|dependency-groups/.test(section)) deps.pypi.add(pyName(quoted[1]));
        const inline = /dependencies\s*=\s*\[(.*)\]/.exec(line);
        if (inline) for (const q of inline[1].matchAll(/["']([A-Za-z0-9][A-Za-z0-9._-]*)/g)) deps.pypi.add(pyName(q[1]));
        const key = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/.exec(line);
        if (key && /poetry.*dependencies/.test(section)) deps.pypi.add(pyName(key[1]));
      }
    }
    for (const m of String(text(`${dir}Gemfile`) ?? '').matchAll(/^\s*gem\s+['"]([^'"]+)['"]/gm)) deps.gem.add(lower(m[1]));
    const composer = parse(text(`${dir}composer.json`) ?? 'null');
    if (isObject(composer)) for (const k of ['require', 'require-dev']) for (const n of Object.keys(isObject(composer[k]) ? composer[k] : {})) deps.composer.add(lower(n));
    const pom = text(`${dir}pom.xml`);
    if (pom)
      for (const block of pom.matchAll(/<(?:dependency|parent|plugin)>([\s\S]*?)<\/(?:dependency|parent|plugin)>/g)) {
        const g = /<groupId>\s*([^<\s]+)\s*<\/groupId>/.exec(block[1]);
        const a = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(block[1]);
        if (g && a) deps.maven.add(lower(`${g[1]}:${a[1]}`));
      }
    for (const f of ['build.gradle', 'build.gradle.kts'])
      for (const m of String(text(`${dir}${f}`) ?? '').matchAll(/["']([\w.-]+):([\w.-]+)(?::[^"']*)?["']/g)) deps.maven.add(lower(`${m[1]}:${m[2]}`));
    for (const m of String(text(`${dir}go.mod`) ?? '').matchAll(/^\s*(?:require\s+)?([\w.-]+\.[a-z]{2,}\/[\w./-]+)\s+v[\w.+-]+/gm)) deps.go.add(m[1]);
    for (const m of String(text(`${dir}mix.exs`) ?? '').matchAll(/\{\s*:([a-z0-9_]+)\s*,/g)) deps.hex.add(m[1]);
    const pub = text(`${dir}pubspec.yaml`);
    if (pub) {
      let inDeps = false;
      for (const line of pub.split(/\r?\n/)) {
        if (/^\S/.test(line)) inDeps = /^(dev_)?dependencies\s*:/.test(line);
        const m = /^ {2}([a-z0-9_]+)\s*:/.exec(line);
        if (inDeps && m) deps.pub.add(m[1]);
      }
    }
    for (const f of safe(() => ls(dir.replace(/\/$/, '')), []).filter((n) => /\.(?:cs|fs|vb)proj$/i.test(n))) {
      const x = String(text(`${dir}${f}`) ?? '');
      for (const m of x.matchAll(/<Project\s+Sdk\s*=\s*"([^"]+)"/g)) deps.csprojSdk.add(m[1]);
      for (const m of x.matchAll(/<PackageReference\s+Include\s*=\s*"([^"]+)"/g)) deps.nuget.add(m[1]);
    }
    const cargo = text(`${dir}Cargo.toml`);
    if (cargo) {
      let section = '';
      for (const line of cargo.split(/\r?\n/)) {
        const h = /^\s*\[([^\]]+)\]/.exec(line);
        if (h) section = h[1].trim();
        const key = /^\s*([A-Za-z0-9_-]+)\s*=/.exec(line);
        if (key && /dependencies/.test(section)) deps.cargo.add(lower(key[1]));
      }
    }
    for (const m of String(text(`${dir}Package.swift`) ?? '').matchAll(/\.package\s*\([^)]*url:\s*"[^"]*\/([^/"]+?)(?:\.git)?"/g)) deps.swiftpm.add(lower(m[1]));
  }
  return deps;
}

/** Does one detect rule hold for the manifests and files? */
function matches(detect, deps, fsLike) {
  if (!isObject(detect)) return false;
  const has = (eco, test) => [...(deps[eco] ?? [])].some(test);
  for (const [eco, names] of Object.entries(detect)) {
    if (eco === 'always' || eco === 'files' || eco === 'contains') continue;
    for (const n of list(names)) {
      if (eco === 'go' && has('go', (d) => d === n || d.startsWith(`${n}/`))) return true;
      if (eco === 'nuget' && has('nuget', (d) => (n.endsWith('.') ? d.startsWith(n) : d.toLowerCase() === n.toLowerCase()))) return true;
      if (eco === 'csprojSdk' && has('csprojSdk', (d) => d === n)) return true;
      if (eco === 'pypi' && has('pypi', (d) => d === pyName(n))) return true;
      if (!['go', 'nuget', 'csprojSdk', 'pypi'].includes(eco) && has(eco, (d) => d === lower(n))) return true;
    }
  }
  for (const f of list(detect.files)) if (safe(() => fsLike.exists(f), false)) return true;
  for (const c of Array.isArray(detect.contains) ? detect.contains : []) {
    const t = safe(() => (fsLike.exists(c.file) ? fsLike.read(c.file) : null), null);
    if (t && typeof c.text === 'string' && t.includes(c.text)) return true;
  }
  return false;
}

/**
 * The stacks found in a project, from its manifests. `packs` never has core (it is offered with any project);
 * `unpacked` are known stacks with no pack yet (a research task can write one).
 */
function detectStacks(fsLike, data = builtinData()) {
  const deps = readManifests(fsLike);
  const packs = Object.values(data.packs ?? {})
    .filter((p) => p.id !== 'core' && !p.detect?.always && matches(p.detect, deps, fsLike))
    .map((p) => p.id);
  const unpacked = (data.knownWithoutPack ?? [])
    .filter((k) => !data.packs?.[k.id])
    .filter((k) => matches(k, deps, fsLike))
    .map((k) => k.id);
  return { packs, unpacked };
}

module.exports = { BUILTIN_FILE, LOOKAHEAD_TRAP, builtinData, mergePacks, loadPacks, packSignals, validatePack, exampleProblems, detectStacks, readManifests };
