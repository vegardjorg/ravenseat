// =============================================================
// cli/doctorBaseline.mjs: the safety baseline checks of `cq doctor` (offline, read-only).
//
// The queue's own loop is guarded (gates, base gate, push guard); these lines look at the project around it, in any
// stack, with plain git and file names only:
//   secrets    a tracked secret file (.env, .env.* other than .example/.sample/.template/.dist, a private key, a
//              .p12/.pfx, an id_rsa-style SSH key, a credentials JSON): FAIL (a key file under a test or fixture folder:
//              WARN). The same file on disk, untracked and NOT ignored: WARN (one `git add .` puts it in git).
//              An ignored local .env is fine.
//   gates      gates.quick and gates.full both empty: WARN (the agents run no checks before delivery).
//   ci         no CI config for the common hosts (GitHub, GitLab, Bitbucket, Azure, CircleCI, Jenkins): INFO.
//   lockfile   a tracked dependency manifest in the root whose lockfile is missing (INFO) or present but not
//              tracked (WARN).
//   prod       productionBranch equal to baseBranch: WARN (every batch push goes live). Not set: nothing.
//   largefile  tracked files at HEAD larger than largeFileMb: WARN.
// Every hint is one plain line. Nothing here changes anything; git runs read-only.
//
// Used by: cli/doctor.mjs. Tested in: lib/__tests__/doctorBaseline.test.ts.
// =============================================================

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { CONFIG, GIT_ROOT, MAIN_TREE, require } from './context.mjs';

const ok = (name, message) => ({ status: 'OK', name, message, fix: null });
const warn = (name, message, fix) => ({ status: 'WARN', name, message, fix });
const fail = (name, message, fix) => ({ status: 'FAIL', name, message, fix });
const info = (name, message, fix) => ({ status: 'INFO', name, message, fix });

/** git with a large buffer (file lists), NUL-separated output split into entries; null on any error. */
function gitList(args) {
  try {
    const out = execFileSync('git', args, {
      cwd: GIT_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true,
    });
    return out.split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

/** .env files that hold names only and belong in git. */
const ENV_ALLOWED = /^\.env\.(example|sample|template|dist|defaults)$/i;

/**
 * What kind of secret file a path is: 'env', 'key' (a private key or key store), 'credentials', or null.
 * `.pem` and `.key` count only when the content has a PRIVATE KEY header (a certificate is public).
 * @param {string} file  repo-relative path
 * @param {(file: string) => string} [head]  the first bytes of the file (for .pem/.key)
 */
export function secretKind(file, head = () => '') {
  const base = String(file).split('/').pop();
  if (/^\.env$/i.test(base) || (/^\.env\./i.test(base) && !ENV_ALLOWED.test(base))) return 'env';
  if (/^id_(rsa|dsa|ecdsa|ed25519)$/i.test(base)) return 'key';
  if (/\.(p12|pfx)$/i.test(base)) return 'key';
  if (/^(credentials|client_secret[\w.-]*|service[-_]?account[\w.-]*|[\w.-]+-credentials)\.json$/i.test(base)) return 'credentials';
  if (/\.(pem|key)$/i.test(base)) return /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/.test(head(file)) ? 'key' : null;
  return null;
}

/** A path under a test or fixture folder (dummy keys are normal there). */
const isTestPath = (file) => /(^|\/)(tests?|__tests__|spec|fixtures?|testdata|mocks?)\//i.test(file);

/** The first 64 KB of a file in the main tree, or ''. */
function head(file) {
  try {
    const fd = fs.openSync(path.join(MAIN_TREE, file), 'r');
    try {
      const buf = Buffer.alloc(65536);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      return buf.subarray(0, n).toString('latin1');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

const list = (files) => `${files.slice(0, 5).join(', ')}${files.length > 5 ? ` and ${files.length - 5} more` : ''}`;

/** Secrets: tracked secret files (FAIL), and untracked ones that are not ignored (WARN). */
export function checkSecrets() {
  const tracked = gitList(['ls-files', '-z']);
  if (tracked == null) return [];
  const out = [];
  const hits = tracked.map((f) => ({ f, k: secretKind(f, head) })).filter((x) => x.k);
  const real = hits.filter((x) => !(x.k === 'key' && isTestPath(x.f))).map((x) => x.f);
  const fixtures = hits.filter((x) => x.k === 'key' && isTestPath(x.f)).map((x) => x.f);
  if (real.length)
    out.push(
      fail(
        'secrets',
        `secret file(s) in git: ${list(real)}. Anyone with the repo can read them, also in old commits`,
        'git rm --cached <file>, add it to .gitignore, and change the keys in it (removing it does not clean the history)',
      ),
    );
  if (fixtures.length)
    out.push(
      warn(
        'secrets',
        `private key file(s) in a test folder: ${list(fixtures)}`,
        'fine if they are dummy keys made for the tests; if one was ever real, change it',
      ),
    );
  const loose = (gitList(['ls-files', '-z', '--others', '--exclude-standard']) ?? []).filter((f) => secretKind(f, head));
  if (loose.length)
    out.push(
      warn(
        'secrets',
        `secret file(s) not in .gitignore: ${list(loose)}. One \`git add .\` puts them in git`,
        'add them to .gitignore (for example .env and .env.* with !.env.example)',
      ),
    );
  if (!out.length) out.push(ok('secrets', 'no secret files in git, local ones are ignored'));
  return out;
}

/** Gates: both lists empty means the agents deliver without running anything. */
export function checkGates() {
  const g = CONFIG.gates ?? {};
  const n = (Array.isArray(g.quick) ? g.quick.length : 0) + (Array.isArray(g.full) ? g.full.length : 0);
  if (n) return [ok('gates', `${n} gate command(s) set`)];
  return [
    warn(
      'gates',
      'gates.quick and gates.full are empty: your agents run no checks before they deliver',
      "put the project's own check commands (build, type check, lint, tests) in gates.quick and gates.full",
    ),
  ];
}

/** CI: is there a CI config for one of the common hosts? */
export function checkCi() {
  const found = require('./lib/controls.js').ciHosts(MAIN_TREE);
  if (found.length) return [ok('ci', `CI config found: ${found.join(', ')}`)];
  return [
    info(
      'ci',
      'no CI config found: nothing checks a push except your own machine',
      'set up CI on your git host to run your gates on every push (for GitHub: /cq:setup offers a template)',
    ),
  ];
}

/** Manifest -> the lockfiles that pin it (any one is enough). Root only. */
const LOCKS = [
  ['package.json', ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', 'bun.lock']],
  ['pyproject.toml', ['uv.lock', 'poetry.lock', 'pdm.lock', 'Pipfile.lock', 'requirements.txt']],
  ['Pipfile', ['Pipfile.lock']],
  ['Cargo.toml', ['Cargo.lock']],
  ['go.mod', ['go.sum']],
  ['Gemfile', ['Gemfile.lock']],
  ['composer.json', ['composer.lock']],
];

/** Lockfile: a tracked manifest in the root without a tracked lockfile. */
export function checkLockfile() {
  const tracked = gitList(['ls-files', '-z']);
  if (tracked == null) return [];
  const set = new Set(tracked);
  const out = [];
  for (const [manifest, locks] of LOCKS) {
    if (!set.has(manifest)) continue;
    if (locks.some((l) => set.has(l))) continue;
    const local = locks.find((l) => fs.existsSync(path.join(MAIN_TREE, l)));
    if (local)
      out.push(
        warn(
          'lockfile',
          `${local} exists but is not in git: agents and CI may install other versions than you`,
          `commit ${local} (remove it from .gitignore if it is there)`,
        ),
      );
    else
      out.push(
        info(
          'lockfile',
          `${manifest} has no lockfile in git: every install can pick newer versions`,
          `create one with your package manager (${locks.slice(0, 2).join(' or ')}) and commit it; fine to skip for a library`,
        ),
      );
  }
  if (!out.length && LOCKS.some(([m]) => set.has(m))) out.push(ok('lockfile', 'every dependency manifest has its lockfile in git'));
  return out;
}

/** Prod: productionBranch equal to baseBranch means every batch push goes live. */
export function checkProductionBranch() {
  const prod = CONFIG.productionBranch;
  if (prod == null || prod === '') return [];
  if (prod === CONFIG.baseBranch)
    return [
      warn(
        'prod',
        `productionBranch is the same as baseBranch (${prod}): every batch push goes straight to production`,
        'merge into a staging or develop branch as baseBranch, and promote to production in a separate step',
      ),
    ];
  return [ok('prod', `agents merge into ${CONFIG.baseBranch}, production is ${prod}`)];
}

/** Large files: tracked files at HEAD over largeFileMb (blob sizes from one `git ls-tree`). */
export function checkLargeFiles() {
  const mb = Number(CONFIG.largeFileMb) > 0 ? Number(CONFIG.largeFileMb) : 5;
  const rows = gitList(['ls-tree', '-r', '-l', '-z', 'HEAD']);
  if (rows == null) return [];
  const big = [];
  for (const r of rows) {
    const m = /^\S+ blob \S+\s+(\d+)\t(.*)$/s.exec(r);
    if (m && Number(m[1]) > mb * 1024 * 1024) big.push({ file: m[2], size: Number(m[1]) });
  }
  if (!big.length) return [ok('largefile', `no tracked file over ${mb} MB`)];
  big.sort((x, y) => y.size - x.size);
  const shown = big.map((b) => `${b.file} (${(b.size / 1024 / 1024).toFixed(1)} MB)`);
  return [
    warn(
      'largefile',
      `${big.length} tracked file(s) over ${mb} MB: ${list(shown)}. Every clone downloads them, and dumps or exports can leak data`,
      'remove what does not belong in git, use Git LFS for real assets, or raise largeFileMb',
    ),
  ];
}

/** The baseline checks in the order doctor prints them. */
export const BASELINE_CHECKS = [checkSecrets, checkGates, checkCi, checkLockfile, checkProductionBranch, checkLargeFiles];
