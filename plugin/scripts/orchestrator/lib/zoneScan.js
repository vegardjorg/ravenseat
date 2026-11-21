// =============================================================
// zoneScan.js: the starter scan that PROPOSES sensitive zones (PG-5, plans/plan-gate-vurdering-2026-11-21.md section 6,
// owner decision 2026-11-21: all eight questions as recommended; question 5: a catalog kind with an empty start and a
// proposing scan).
//
// WHY: Ravenseat is generic, so it ships no list of zones. A new owner still gains from a nudge: "these parts of your
// tree look expensive to undo". The scan reads only what the tree shows and returns candidates; it never adds one by
// itself. `ravenseat catalog zones` prints them and `--write` writes each as a proposed catalog entry (kind zone); a
// proposed zone does nothing until the owner accepts it (`catalog accept`), edits it or deletes the file.
//
// The four candidates (at most one each, with up to PATHS_MAX paths):
//   data-model  the configured migrations folder (queue.config.json migrations.folder), else folders named migrations
//   contracts   files that look like a public contract: OpenAPI or Swagger files, GraphQL schemas, protobuf files, JSON
//               schemas, and a published package's entry points (package.json without "private": true: main, module,
//               types, bin, and the plain file values of exports)
//   auth        folders named like sign-in or permissions (auth, authz, oauth, sso, login, session, permissions, rbac,
//               acl, roles)
//   crypto      folders named crypto, encryption, kms, keys, keystore or secrets, and files named like encryption
//               (encrypt, decrypt, crypto, cipher, keystore, kms)
// Test, fixture, vendor and build folders never count. A candidate path whose files an existing zone already covers is
// left out, and so is a candidate whose title an existing zone has, whatever its status: what the owner declined or
// rewrote is not proposed again.
//
// Pure: the caller passes the tracked files and a file reader. Used by cli/catalog.mjs (`catalog zones`, and one hint
// line after `catalog init`). Tested in lib/__tests__/zoneScan.test.ts.
// =============================================================
'use strict';

/** At most this many paths per candidate: more is no longer a zone, it is the whole project. */
const PATHS_MAX = 8;
/** The example files a candidate names in its text. */
const FOUND_MAX = 3;

/** Folders whose files never count: tests, fixtures, vendored and built code. */
const IGNORED = new Set([
  'node_modules', 'vendor', 'third_party', 'dist', 'build', 'out', 'coverage', 'target', '.git',
  '__tests__', '__mocks__', 'test', 'tests', 'spec', 'specs', 'e2e', 'fixtures', '__fixtures__', 'testdata', 'examples',
]);
const AUTH_DIR = /^(auth|authn|authz|authentication|authorization|oauth2?|sso|login|sessions?|permissions?|rbac|acl|roles)$/i;
const CRYPTO_DIR = /^(crypto|cryptography|encryption|kms|keys|keystore|secrets)$/i;
const CRYPTO_FILE = /(encrypt|decrypt|crypto|cipher|keystore|kms)/i;
const CONTRACT_FILE = [
  /^(openapi|swagger)[\w.-]*\.(ya?ml|json)$/i,
  /\.(graphql|gql)$/i,
  /\.proto$/i,
  /\.schema\.json$/i,
];

/** The four kinds: title, reason (one line, "why expensive to undo") and the keywords a mission may name. */
const KINDS = Object.freeze({
  'data-model': {
    title: 'Data model and migrations',
    reason: 'Stored data outlives the code: a schema change that has shipped is expensive to undo.',
    keywords: ['migration', 'schema change', 'data model'],
  },
  contracts: {
    title: 'Public contracts',
    reason: 'Others build on a published API, schema or file format; a breaking change needs a versioned path.',
    keywords: ['public API', 'breaking change', 'file format'],
  },
  auth: {
    title: 'Sign-in and permissions',
    reason: 'A mistake here exposes data or locks people out, and sessions and roles are hard to migrate.',
    keywords: ['authentication', 'authorization', 'permissions'],
  },
  crypto: {
    title: 'Encryption and keys',
    reason: 'Data encrypted under a scheme or a key stays tied to it; changing it means re-encrypting.',
    keywords: ['encryption', 'key rotation'],
  },
});

const norm = (p) => String(p ?? '').trim().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
const ignored = (f) => f.split('/').some((s) => IGNORED.has(s.toLowerCase())) || /\.(test|spec)\.[a-z0-9]+$/i.test(f);

/** The folder up to and including the first segment that matches `re`, as "<dir>/**", or null. */
function folderOf(f, re) {
  const parts = f.split('/');
  for (let i = 0; i < parts.length - 1; i++) if (re.test(parts[i])) return `${parts.slice(0, i + 1).join('/')}/**`;
  return null;
}

/** The file values of a published package's entry points (main, module, types, bin and plain exports). */
function packageEntries(text) {
  let pkg;
  try {
    pkg = JSON.parse(String(text ?? ''));
  } catch {
    return []; // error-ignored: a broken package.json names no entry point
  }
  if (!pkg || typeof pkg !== 'object' || pkg.private === true || typeof pkg.name !== 'string') return [];
  const out = [];
  const add = (v) => {
    if (typeof v === 'string') out.push(norm(v));
    else if (v && typeof v === 'object') for (const x of Object.values(v)) add(x);
  };
  for (const k of ['main', 'module', 'types', 'typings', 'bin', 'exports']) add(pkg[k]);
  return out.filter((f) => f && !f.includes('*'));
}

/** Keep the outermost folders: "src/auth/**" covers "src/auth/oauth/**" and any file under it. */
function outermost(paths) {
  const sorted = [...new Set(paths)].sort();
  const folders = sorted.filter((p) => p.endsWith('/**')).map((p) => p.slice(0, -2));
  return sorted.filter((p) => {
    const self = p.endsWith('/**') ? p.slice(0, -2) : null;
    return !folders.some((f) => f !== self && p.startsWith(f));
  });
}

/**
 * The zone candidates for a tree.
 * @param {{ files: string[], readFile?: (f: string) => string|null, migrationsFolder?: string|null,
 *   existing?: { title?: string, paths?: string[] }[], glob?: Function }} o files: the tracked files; existing: the
 *   zone entries already in the catalog, any status
 * @returns {{ key: string, title: string, reason: string, keywords: string[], paths: string[], found: string[] }[]}
 */
function zoneCandidates({ files = [], readFile = () => null, migrationsFolder = null, existing = [], glob = require('./mergeGuard.js').globMatch } = {}) {
  const list = (files ?? []).map(norm).filter((f) => f && !ignored(f));
  /** key -> Map(path -> the files that gave it) */
  const hits = new Map(Object.keys(KINDS).map((k) => [k, new Map()]));
  const hit = (key, p, f) => {
    const m = hits.get(key);
    if (!m.has(p)) m.set(p, []);
    m.get(p).push(f);
  };
  const mig = typeof migrationsFolder === 'string' && norm(migrationsFolder) ? norm(migrationsFolder).replace(/\/+$/, '') : null;
  const published = new Set(list.includes('package.json') ? packageEntries(readFile('package.json')) : []);
  for (const f of list) {
    const base = f.split('/').pop();
    if (mig ? f.startsWith(`${mig}/`) : false) hit('data-model', `${mig}/**`, f);
    else if (!mig) {
      const m = folderOf(f, /^migrations$/i);
      if (m) hit('data-model', m, f);
    }
    if (CONTRACT_FILE.some((re) => re.test(base)) || published.has(f)) hit('contracts', f, f);
    const a = folderOf(f, AUTH_DIR);
    if (a) hit('auth', a, f);
    const c = folderOf(f, CRYPTO_DIR);
    if (c) hit('crypto', c, f);
    else if (CRYPTO_FILE.test(base.replace(/\.[^.]+$/, ''))) hit('crypto', f, f);
  }
  const titles = new Set((existing ?? []).map((z) => String(z?.title ?? '').trim().toLowerCase()).filter(Boolean));
  const covered = (f) => (existing ?? []).some((z) => (z?.paths ?? []).some((p) => glob(norm(p), f)));
  const out = [];
  for (const [key, m] of hits) {
    const k = KINDS[key];
    if (!m.size || titles.has(k.title.toLowerCase())) continue;
    const kept = [...m.entries()].filter(([, fs]) => !fs.every(covered));
    const paths = outermost(kept.map(([p]) => p)).slice(0, PATHS_MAX);
    if (!paths.length) continue;
    const found = [...new Set(kept.flatMap(([, fs]) => fs))].sort().slice(0, FOUND_MAX);
    out.push({ key, title: k.title, reason: k.reason, keywords: [...k.keywords], paths, found });
  }
  return out.sort((x, y) => x.key.localeCompare(y.key));
}

/** The fields for catalog.proposalFile / writeProposal: a proposed zone with the found files in its text. */
function proposalOf(c) {
  return {
    title: c.title,
    kind: 'zone',
    paths: c.paths,
    keywords: c.keywords,
    reason: c.reason,
    why:
      `Proposed by the starter scan (ravenseat catalog zones) from ${c.found.join(', ')}. It counts only after the ` +
      'owner accepts it: narrow the paths and keywords first, or delete this file if it is not a zone.',
  };
}

module.exports = { PATHS_MAX, KINDS, zoneCandidates, proposalOf, packageEntries };
