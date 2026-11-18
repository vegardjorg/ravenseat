// =============================================================
// cli/doctorBaseline.mjs: the safety baseline checks of `ravenseat doctor` (offline, read-only).
//
// The queue's own loop is guarded (gates, base gate, push guard); these lines look at the project around it, in any
// stack, with plain git and file names only:
//   secrets    a tracked secret file (.env, .env.* other than .example/.sample/.template/.dist, a private key, a
//              .p12/.pfx, an id_rsa-style SSH key, a credentials JSON): FAIL (a key file under a test or fixture folder:
//              WARN). The same file on disk, untracked and NOT ignored: WARN (one `git add .` puts it in git).
//              An ignored local .env is fine.
//   allowlist  a secret in an approved command (permissions.allow, ask, deny in .claude/settings.json and
//              .claude/settings.local.json, main tree and .claude/worktrees/*; lib/allowlistSecrets.js): FAIL in a
//              tracked file, WARN in an untracked one. Shown as `<file>: permissions.allow[3]`, never the rule's text.
//   mcp        a key in .mcp.json (env, headers, args, url of each MCP server, main tree and .claude/worktrees/*;
//              lib/mcpSecrets.js): FAIL in a tracked file, WARN in an untracked one, shown as
//              `.mcp.json: mcpServers.github.env.GITHUB_TOKEN`, never the value. Same setting as allowlist
//              (secretScan.allowlist); while off, the allowlist INFO line covers both.
//   permissions  broad rules in the tracked .claude/settings.json (lib/broadPermissions.js): WARN for any shell command
//              and defaultMode bypassPermissions or acceptEdits, INFO for network tools, rm, git push and WebFetch
//              without a domain. Opt-in (permissionsCheck.enabled); while off one INFO line, which may say an important
//              gap (bypassPermissions) is there. Like every off line (offRow), plain doctor shows it only for that gap.
//   gitignore  a path Ravenseat keeps local (setup.mjs requiredIgnores, with the configured dataFolder and timeLog) that
//              the project's own rules do not ignore: WARN, split into "only ignored on your machine (global
//              gitignore)" and "not ignored". A tracked file in the data folder or .claude/settings.local.json: FAIL.
//              allowlist and gitignore are opt-in (secretScan.allowlist, gitignoreCheck.enabled; lib/optInChecks.js):
//              while off, each is one INFO line naming the setting, which may say an important gap is there (never what).
//              Plain doctor shows an off line only for such a gap, also when its Checks card is set aside (owner
//              decision 2026-11-18); `doctor --all` shows every off line (owner decision 2026-11-17: off is the
//              normal state, not a reminder).
//              allowlistFacts() and gitignoreFacts() are the same reads for the Checks tab (cli/checks.mjs).
//   base      the base branch does not exist: FAIL (in an empty repo: WARN).
//   gates      gates.quick and gates.full both empty: WARN (the agents run no checks before delivery). A gate naming a
//              package.json script that does not exist: FAIL (red on every run). A gate whose program is not found on
//              PATH (`pytest -q` without pytest), or a path in it that is not in the repo: WARN (the agents' PATH may
//              differ); a file lookup only, the gate is never run.
//   ci         no CI config for the common hosts (GitHub, GitLab, Bitbucket, Azure, CircleCI, Jenkins): INFO.
//   lockfile   a tracked dependency manifest in the root whose lockfile is missing (INFO) or present but not
//              tracked (WARN).
//   prod       productionBranch equal to baseBranch: WARN (every batch push goes live). Not set: nothing.
//   largefile  tracked files at HEAD larger than largeFileMb: WARN.
//   instructions      the instructions Claude Code loads in every session, track and subagent (lib/instructionSize.js):
//              OK with the size and the share per scope; WARN (advice, hidden in quiet) when a file has more than
//              instructionSize.maxLines lines or the set more than .maxChars characters.
//   instructions-cut  a file loaded on demand that Claude Code cuts at 40,000 characters: WARN, a fact, shown in quiet.
//              instructionSize.mode off: neither row.
// Every hint is one plain line. Nothing here changes anything; git runs read-only.
//
// Used by: cli/doctor.mjs. Tested in: lib/__tests__/doctorBaseline.test.ts.
// =============================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { CLI, CONFIG, FOLDER, GIT_ROOT, MAIN_TREE, require } from './context.mjs';
import { requiredIgnores } from '../setup.mjs';

const GI = require('./lib/gitIdentity.js');

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
  // secretScan.enabled: false is named in the doctor row `settings` (cli/doctor.mjs checkSettings) with the other weakened guards.
  return out;
}

/** Is `inTree` tracked by git in the tree `tree` (relative to the main tree, '' for the main tree)? */
function trackedIn(tree, inTree) {
  try {
    const out = execFileSync('git', ['-C', path.join(MAIN_TREE, tree || '.'), 'ls-files', '-z', '--', inTree], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    return out.split('\0').some(Boolean);
  } catch {
    return false;
  }
}

/** Is `inTree` ignored in the tree `tree` (by any rule, the global one too)? On any git error: not ignored. */
function ignoredIn(tree, inTree) {
  try {
    execFileSync('git', ['-C', path.join(MAIN_TREE, tree || '.'), 'check-ignore', '-q', '--no-index', '--', inTree], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Approved commands with a secret in them (H1, lib/allowlistSecrets.js): permissions.allow, ask and deny in
 * .claude/settings.json and .claude/settings.local.json, in the main tree and the agents' worktrees. FAIL when the file
 * is tracked (the key is in the repo and its history), WARN when it is not (clear text on disk, and when it is not even
 * ignored, one `git add .` away). The lines name `<file>: permissions.allow[3]` and the rule id, never the rule's text.
 */
export function allowlistFacts() {
  const AS = require('./lib/allowlistSecrets.js');
  const hits = AS.scanTrees(MAIN_TREE);
  const tracked = [];
  const local = [];
  for (const h of hits) {
    if (trackedIn(h.tree, h.inTree)) tracked.push(h);
    else local.push({ ...h, loose: !ignoredIn(h.tree, h.inTree) });
  }
  return { hits, tracked, local };
}

/**
 * Keys in .mcp.json (lib/mcpSecrets.js), main tree and the agents' worktrees, split as allowlistFacts: tracked (FAIL)
 * and local (WARN, `loose` when not even ignored).
 */
export function mcpFacts() {
  const MS = require('./lib/mcpSecrets.js');
  const hits = MS.scanMcpTrees(MAIN_TREE);
  const tracked = [];
  const local = [];
  for (const h of hits) {
    if (trackedIn(h.tree, h.inTree)) tracked.push(h);
    else local.push({ ...h, loose: !ignoredIn(h.tree, h.inTree) });
  }
  return { hits, tracked, local };
}

/**
 * The doctor row of an opt-in check that is off (lib/optInChecks.js): one INFO line, never WARN or FAIL. Plain doctor
 * shows it only for an important gap, set aside or not (OI.offShown); otherwise the row is marked onRequest and
 * only `doctor --all` shows it (lib/guidance.js filterDoctor). Off is the normal state, so it is not named every run.
 */
function offRow(key, gap) {
  const OI = require('./lib/optInChecks.js');
  const c = OI.byKey(key);
  const row = info(c.row, OI.offLine(c, { cli: CLI, gap }), `${OI.onCommand(c, CLI)} (or Turn on on the Checks tab); leave it off if you do not want it`);
  return [OI.offShown(c, { gap }) ? row : { ...row, onRequest: true }];
}

export function checkAllowlistSecrets() {
  const AS = require('./lib/allowlistSecrets.js');
  // Off by default (secretScan.allowlist). Off, it still reads quietly, so the INFO line can say an important gap
  // (a key in a TRACKED file) is there, never which.
  const { hits, tracked, local } = allowlistFacts();
  // The setting covers .mcp.json too (checkMcpSecrets): while off, this one INFO line speaks for both.
  if (CONFIG.secretScan?.allowlist !== true) return offRow('secretScan.allowlist', tracked.length > 0 || mcpTrackedQuietly());
  if (!hits.length) return [ok('allowlist', 'no secret in the commands Claude Code has approved (permissions in .claude/settings*.json)')];
  const out = [];
  if (tracked.length)
    out.push(
      fail(
        'allowlist',
        `a secret in an approved command, in a file git tracks: ${list(tracked.map(AS.where))}. Anyone with the repo can read it`,
        'change the key first (it stays in the history), then remove the rule from the file and commit; removing it does not clean the history',
      ),
    );
  if (local.length) {
    const loose = [...new Set(local.filter((h) => h.loose).map((h) => h.file))];
    out.push(
      warn(
        'allowlist',
        `a secret in an approved command, in clear text on disk: ${list(local.map(AS.where))}` +
          `${loose.length ? `. Not even ignored: ${list(loose)}` : ''}. Backups and screen sharing copy it too`,
        'remove the rule, change the key if it may have been seen, and pass it as an environment variable or from a password manager instead of typing it in the command',
      ),
    );
  }
  return out;
}

/** A key in a tracked .mcp.json, read quietly for the off line; an error counts as none. */
function mcpTrackedQuietly() {
  try {
    return mcpFacts().tracked.length > 0;
  } catch {
    return false;
  }
}

/** Keys in .mcp.json (lib/mcpSecrets.js): FAIL when tracked, WARN when only on disk. Nothing while the setting is off. */
export function checkMcpSecrets() {
  if (CONFIG.secretScan?.allowlist !== true) return [];
  const MS = require('./lib/mcpSecrets.js');
  const { hits, tracked, local } = mcpFacts();
  if (!hits.length) return [];
  const advice = 'write ${NAME} in .mcp.json instead of the value (Claude Code reads it from the environment), and set NAME in your shell or a password manager';
  const out = [];
  if (tracked.length)
    out.push(
      fail(
        'mcp',
        `a key in .mcp.json, in a file git tracks: ${list(tracked.map(MS.where))}. Anyone with the repo can read it`,
        `change the key first (it stays in the history), then ${advice}, and commit`,
      ),
    );
  if (local.length) {
    const loose = [...new Set(local.filter((h) => h.loose).map((h) => h.file))];
    out.push(
      warn(
        'mcp',
        `a key in .mcp.json, in clear text on disk: ${list(local.map(MS.where))}${loose.length ? `. Not even ignored: ${list(loose)}` : ''}`,
        advice,
      ),
    );
  }
  return out;
}

/**
 * The broad rules in the tracked .claude/settings.json of the main tree (lib/broadPermissions.js). An untracked or
 * missing file gives none: only the shared file reaches every clone.
 */
export function broadFacts() {
  const BP = require('./lib/broadPermissions.js');
  const file = '.claude/settings.json';
  if (!trackedIn('', file)) return { file, tracked: false, hits: [] };
  let text = null;
  try {
    text = fs.readFileSync(path.join(MAIN_TREE, '.claude', 'settings.json'), 'utf8');
  } catch {
    text = null;
  }
  return { file, tracked: true, hits: text == null ? [] : BP.findBroad(text) };
}

export function checkBroadPermissions() {
  const BP = require('./lib/broadPermissions.js');
  const { file, tracked, hits } = broadFacts();
  // Off: one INFO line, and only where a shared settings file exists (the check has nothing to read elsewhere).
  if (CONFIG.permissionsCheck?.enabled !== true) return tracked ? offRow('permissionsCheck.enabled', BP.hasBypass(hits)) : [];
  if (!tracked) return [ok('permissions', 'no tracked .claude/settings.json, so no shared permissions')];
  if (!hits.length) return [ok('permissions', `no broad rule in ${file}`)];
  const line = (h) => `${h.at} ${h.rule} (${BP.KINDS[h.kind]})`;
  const out = [];
  const warns = hits.filter((h) => h.level === 'warn');
  const infos = hits.filter((h) => h.level !== 'warn');
  if (warns.length)
    out.push(
      warn(
        'permissions',
        `${file} (tracked) gives every clone and every agent: ${list(warns.map(line))}`,
        'remove the rule or the defaultMode from the shared file; keep a personal one in .claude/settings.local.json if you want it yourself',
      ),
    );
  if (infos.length)
    out.push(
      info(
        'permissions',
        `${file} (tracked) has broad rules: ${list(infos.map(line))}`,
        'narrow each rule to the commands you mean (for example Bash(npm test:*) or WebFetch(domain:docs.example.com)), or move it to .claude/settings.local.json',
      ),
    );
  return out;
}

/**
 * The core.excludesFile that switches the global gitignore off: a path that does not exist, so git reads no rules from
 * it and nothing is written (NUL and /dev/null are read differently by git on Windows and elsewhere).
 */
const NO_EXCLUDES = path.join(os.tmpdir(), `ravenseat-no-global-gitignore-${process.pid}-${Date.now()}`);

/** A path git can test for a .gitignore line: `<dir>/` gets a file in it, a `*` a plain name. A negation: null. */
const probeOf = (line) => (line.startsWith('!') ? null : line.endsWith('/') ? `${line}probe` : line.replace(/\*/g, 'local'));

/** The probes `check-ignore --no-index` reports as ignored, by the project's rules only or (global) by every rule. */
function ignoredProbes(probes, { global }) {
  const args = [...(global ? [] : ['-c', `core.excludesFile=${NO_EXCLUDES}`]), 'check-ignore', '--no-index', '-z', '--stdin'];
  const opts = { cwd: GIT_ROOT, input: `${probes.join('\0')}\0`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true };
  try {
    return new Set(execFileSync('git', args, opts).split('\0').filter(Boolean));
  } catch (e) {
    // Exit 1 means none is ignored; stdout is still read in case git said more before it stopped.
    return new Set(String(e?.stdout ?? '').split('\0').filter(Boolean));
  }
}

/**
 * The project's own .gitignore (H2): every path Ravenseat keeps local (setup.mjs requiredIgnores: GITIGNORE_LINES, the
 * configured dataFolder and timeLog, .claude/worktrees/) must be ignored by the project's rules, with the user's global
 * gitignore switched off. WHY: the global file only exists on this machine; a teammate's clone, CI or a fresh checkout
 * does not have it, so what only it ignores is one `git add .` from the repo. WARN "only ignored on your machine" and
 * WARN "not ignored", each with the lines to add. FAIL when git already tracks a file in the data folder, the time log
 * or .claude/settings.local.json: ignoring does not untrack, `git rm --cached` does.
 * .git/info/exclude still counts as the project's here: it is local too, but rare, and git has no switch for it.
 */
export function gitignoreFacts() {
  const lines = requiredIgnores(CONFIG);
  // Already tracked: the data folder, a time log of its own, and the personal settings (not the worktrees or .env,
  // which checkWorktrees and checkSecrets name).
  // A share line `<folder>/*` counts as the folder; a shared file (lib/queueShare.js, share on) is meant to be tracked.
  const QS = require('./lib/queueShare.js');
  const local = lines
    .filter((l) => l !== '.claude/worktrees/' && !l.startsWith('.env') && !l.startsWith('!'))
    .map((l) => l.replace(/\/\*$/, '/'));
  const tracked = (gitList(['ls-files', '-z', '--', ...local.map((l) => l.replace(/\/$/, ''))]) ?? []).filter((f) => !QS.sharedFile(f, CONFIG));
  const roots = [...new Set(tracked.map((f) => (local.find((l) => f === l || f.startsWith(l)) ?? f).replace(/\/$/, '')))];
  const withProbe = lines.map((line) => ({ line, probe: probeOf(line) })).filter((x) => x.probe);
  const probes = withProbe.map((x) => x.probe);
  const own = ignoredProbes(probes, { global: false });
  const any = ignoredProbes(probes, { global: true });
  const machineOnly = withProbe.filter((x) => !own.has(x.probe) && any.has(x.probe)).map((x) => x.line);
  const none = withProbe.filter((x) => !own.has(x.probe) && !any.has(x.probe)).map((x) => x.line);
  // The important gaps (the red dot on the Checks tab): a tracked file Ravenseat keeps local, or the personal settings
  // not ignored by the project's own rules.
  const important = tracked.length > 0 || [...machineOnly, ...none].includes('.claude/settings.local.json');
  return { tracked, roots, machineOnly, none, count: withProbe.length, important };
}

export function checkGitignore() {
  const { tracked, roots, machineOnly, none, count, important } = gitignoreFacts();
  // Off by default (gitignoreCheck.enabled): one INFO line that may say an important gap is there.
  if (CONFIG.gitignoreCheck?.enabled !== true) return offRow('gitignoreCheck.enabled', important);
  const out = [];
  if (tracked.length) {
    out.push(
      fail(
        'gitignore',
        `git tracks file(s) Ravenseat keeps local: ${list(tracked)}. Anyone with the repo can read them, also in old commits`,
        `git rm --cached -r -- ${roots.join(' ')} (keeps them on disk), commit, and check that .gitignore holds them; a key in them must be changed`,
      ),
    );
  }
  const fix = (missing) => `run ${CLI} doctor --fix (or ${CLI} setup; both add them to the project's .gitignore), or add these lines to .gitignore: ${missing.join(' ')}`;
  if (machineOnly.length)
    out.push(
      warn(
        'gitignore',
        `only ignored on your machine (global gitignore): ${machineOnly.join(', ')}. A teammate's clone or CI does not ignore them`,
        fix(machineOnly),
      ),
    );
  if (none.length) out.push(warn('gitignore', `not ignored: ${none.join(', ')}. One \`git add .\` puts them in git`, fix(none)));
  if (!out.length) out.push(ok('gitignore', `the project's own .gitignore holds the ${count} paths Ravenseat keeps local`));
  return out;
}

/**
 * The queue's own files in git (H3, lib/queueShare.js). Share on: FAIL when git tracks a data folder file outside
 * share.include (the push guard refuses it), WARN when the repo is not known to be private and the owner has not
 * confirmed that (share.publicOk), else OK. Share off: one INFO line that offers it, only in a repo known to be private
 * (the cached answer, never a network call here); elsewhere nothing, as off is the safe side.
 */
export function checkShare() {
  const QS = require('./lib/queueShare.js');
  const RV = require('./lib/repoVisibility.js');
  const s = QS.shareOf(CONFIG);
  const cache = RV.readCache(FOLDER, { any: true });
  if (!s.on) return RV.isPrivate(cache?.visibility) ? offRow('share.queueData', false) : [];
  const df = QS.dataFolderOf(CONFIG);
  const tracked = df ? (gitList(['ls-files', '-z', '--', df]) ?? []) : [];
  const out = [];
  const wrong = QS.breaches(tracked, CONFIG).filter((b) => b.kind === 'data').map((b) => b.file);
  if (wrong.length)
    out.push(
      fail(
        'share',
        `git tracks data folder file(s) that are not shared (not in share.include): ${list(wrong)}. The push guard refuses commits with them`,
        `git rm --cached -- ${wrong.join(' ')} (keeps them on disk) and commit; a key in them must be changed`,
      ),
    );
  for (const p of s.problems) out.push(warn('share', `share.include: ${p}`, 'take it out of share.include in queue.config.json'));
  const pub = QS.publicReason(CONFIG, cache, CLI);
  if (pub) out.push(warn('share', pub, `${CLI} share status checks the repo again`));
  if (!out.length) out.push(ok('share', `share on: ${s.include.join(', ')} in git, the repo is private (checked ${cache?.checkedAt ?? 'earlier'})`));
  return out;
}

/** The base branch must exist: tracks branch from it and merge into it. An empty repo has no branch yet, and only a warning. */
export function checkBaseBranch() {
  const base = CONFIG.baseBranch;
  const has = (ref) => gitList(['rev-parse', '-q', '--verify', ref]) !== null;
  if (has(`refs/heads/${base}`)) return [ok('base', `base branch ${base} exists`)];
  const branches = gitList(['for-each-ref', '--format=%(refname:short)%00', 'refs/heads']) ?? [];
  const names = branches.map((b) => b.trim()).filter(Boolean);
  const fix = `set baseBranch in queue.config.json${names.length ? ` (your branches: ${names.slice(0, 5).join(', ')})` : ''}`;
  if (!names.length) return [warn('base', `base branch ${base} does not exist yet: the repo has no commits`, 'make a first commit')];
  return [fail('base', `base branch ${base} does not exist, so no track can start`, fix)];
}

/** The git identity: `ravenseat merge` refuses a test identity or none, so say it now. WARN: nothing is broken until then. */
export function checkIdentity() {
  const { ident, refused } = GI.readIdentity(GIT_ROOT);
  if (!refused) return [ok('identity', `git identity ${ident}`)];
  return [warn('identity', `git identity looks like a test or is missing (${ident || 'none'}): ravenseat merge will refuse it`, GI.IDENTITY_FIX)];
}

/** Gates: both lists empty means the agents deliver without running anything. */
export function checkGates() {
  const g = CONFIG.gates ?? {};
  const n = (Array.isArray(g.quick) ? g.quick.length : 0) + (Array.isArray(g.full) ? g.full.length : 0);
  if (!n) return gateLines(g, n);
  const commands = [...new Set([...(g.quick ?? []), ...(g.full ?? [])].filter((c) => typeof c === 'string'))];
  return [...gateLines(g, n), ...gateProgramLines(commands)];
}

/**
 * A gate whose program is not installed (red team scenario 14): `pytest -q` without pytest on PATH is red on every run.
 * WARN, not FAIL: the agents run the gates with Claude Code's PATH, which may differ from this shell's. Cheap: only a
 * file lookup per program (lib/kickstart.js gatePrograms, programFound); the gate is never run.
 */
export function gateProgramLines(commands) {
  const KS = require('./lib/kickstart.js');
  const isFile = (f) => {
    try {
      return fs.statSync(f).isFile();
    } catch {
      return false;
    }
  };
  const o = {
    pathValue: process.env.PATH ?? '',
    pathExt: process.env.PATHEXT ?? '',
    root: MAIN_TREE,
    isFile,
    join: path.join,
    resolve: path.resolve,
    delimiter: path.delimiter,
  };
  const missing = KS.gatePrograms(commands).filter((p) => !KS.programFound(p, o));
  if (!missing.length) return [];
  const named = missing.slice(0, 5).map((p) => `${p.program} (in "${p.command}")`);
  return [
    warn(
      'gates',
      `gate program(s) not found${missing.some((p) => !p.path) ? ' on PATH' : ''}: ${named.join(', ')}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''}. Such a gate is red on every run`,
      'install the program and put its folder on PATH for Claude Code (then restart it), or change the gate in queue.config.json; a path in a gate is read from the repo root',
    ),
  ];
}

/** The gates line itself: empty lists, a missing package script, or gates that check nothing. */
function gateLines(g, n) {
  if (n) {
    // A gate that names a script the project does not have is red on every run, so every delivery would look broken.
    const commands = [...new Set([...(g.quick ?? []), ...(g.full ?? [])].filter((c) => typeof c === 'string'))];
    let text = null;
    try {
      text = fs.readFileSync(path.join(MAIN_TREE, 'package.json'), 'utf8');
    } catch {
      /* no package.json: every npm script counts as missing */
    }
    const missing = require('./lib/kickstart.js').missingScripts(commands, text);
    if (missing.length)
      return [
        fail(
          'gates',
          `gate command(s) that cannot run, the script is not in package.json: ${missing.join(', ')}`,
          'change gates.quick and gates.full in queue.config.json to commands your project has',
        ),
      ];
    // Gates that check nothing (red team RT-17): every delivery is green whatever the code does. A warning, never a stop:
    // a project without tests yet may set it on purpose, and `checks` proposes real ones.
    const empty = require('./lib/kickstart.js').noOpCommands(commands, text);
    if (empty.length === commands.length)
      return [
        warn(
          'gates',
          `every gate command checks nothing (${empty.slice(0, 3).join(', ')}): each delivery is green whatever the code does`,
          'set a real check in gates.quick in queue.config.json (a test run or a type check); ravenseat checks proposes some',
        ),
      ];
    return [ok('gates', `${n} gate command(s) set${empty.length ? `, ${empty.length} of them check nothing (${empty.slice(0, 3).join(', ')})` : ''}`)];
  }
  // With CI missing too, the ci row names the dismissal; said here only when it is not said there (once per doctor run).
  const note = require('./lib/controls.js').ciHosts(MAIN_TREE).length ? controlsDismissedNote() : '';
  return [
    warn(
      'gates',
      `gates.quick and gates.full are empty: your agents run no checks before they deliver${note}`,
      "put the project's own check commands (build, type check, lint, tests) in gates.quick and gates.full",
    ),
  ];
}

/**
 * The push question was dismissed for this project (`ravenseat controls dismiss`, lib/controls.js) and still covers what
 * is missing: a short note for one doctor row, so the fact and the undo stay visible without a row of their own.
 */
function controlsDismissedNote() {
  const C = require('./lib/controls.js');
  return C.covers(C.readDismissal(FOLDER), C.missing(CONFIG, MAIN_TREE))
    ? ` (push question dismissed for this project; undo: ${C.RESTORE(CLI)})`
    : '';
}

/** CI: is there a CI config for one of the common hosts? */
export function checkCi() {
  const found = require('./lib/controls.js').ciHosts(MAIN_TREE);
  if (found.length) return [ok('ci', `CI config found: ${found.join(', ')}`)];
  return [
    info(
      'ci',
      `no CI config found: nothing checks a push except your own machine${controlsDismissedNote()}`,
      'set up CI on your git host to run your gates on every push (for GitHub: /ravenseat:setup offers a template)',
    ),
  ];
}

/**
 * The manifests without a tracked lockfile (lib/lockfiles.js, the same rule as the Checks card lockfile-in-git), or
 * null when git cannot list the files.
 */
export function lockfileFacts() {
  const tracked = gitList(['ls-files', '-z']);
  if (tracked == null) return null;
  const LF = require('./lib/lockfiles.js');
  const set = new Set(tracked);
  return { gaps: LF.lockGaps(set, (l) => fs.existsSync(path.join(MAIN_TREE, l))), any: LF.hasManifest(set) };
}

/** Lockfile: a tracked manifest in the root without a tracked lockfile. */
export function checkLockfile() {
  const facts = lockfileFacts();
  if (facts == null) return [];
  const out = [];
  for (const { manifest, locks, local } of facts.gaps) {
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
  if (!out.length && facts.any) out.push(ok('lockfile', 'every dependency manifest has its lockfile in git'));
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

/** The share per scope for a doctor line: the project, the user's ~/.claude, Ravenseat (always named), the organization. */
export function instructionParts(byScope) {
  const IS = require('./lib/instructionSize.js');
  const parts = [`project ${IS.n(byScope.project)}`, `your ~/.claude ${IS.n(byScope.user)}`, `Ravenseat ${IS.n(byScope.ravenseat)}`];
  if (byScope.organization) parts.push(`organization ${IS.n(byScope.organization)}`);
  return parts.join(', ');
}

/** The limit texts: the source of a default, the setting's name when the owner changed it. */
export function limitTexts({ maxLines, maxChars }) {
  const IS = require('./lib/instructionSize.js');
  return {
    lines: maxLines === IS.MAX_LINES ? `${maxLines} lines (the target in the Claude Code docs)` : `${maxLines} lines (instructionSize.maxLines)`,
    chars: maxChars === IS.MAX_CHARS ? `${IS.n(maxChars)}, where Claude Code itself warns` : `${IS.n(maxChars)} (instructionSize.maxChars)`,
  };
}

/**
 * Claude's instructions: what loads at the start of every session, track and subagent, against instructionSize. Reads the
 * files once (no network, no git except one ls-files for the subfolder CLAUDE.md files).
 */
export function checkInstructions() {
  const IS = require('./lib/instructionSize.js');
  const limits = IS.limitsOf(CONFIG);
  if (limits.mode === 'off') return [];
  const m = IS.measureDisk(MAIN_TREE, { nested: true });
  const a = IS.assess(m, limits);
  const t = limitTexts(limits);
  const size =
    `about ${IS.n(m.total.tokens)} tokens load in every session, track and subagent (${IS.n(m.total.chars)} chars in ${m.total.files} files: ${instructionParts(m.byScope)})`;
  const out = [];
  if (!a.overTotal && !a.overLines.length)
    out.push(ok('instructions', m.total.files ? `${size}, within ${limits.maxLines} lines per file and ${IS.n(limits.maxChars)} in all` : 'no CLAUDE.md or rule loads at start'));
  else {
    const found = [];
    if (a.overTotal) found.push(`The total is over ${t.chars}`);
    if (a.overLines.length)
      found.push(`Longer than ${t.lines}: ${list(a.overLines.map((f) => `${f.rel} (${f.lines} lines)`))}`);
    out.push(
      warn(
        'instructions',
        `${size}. ${found.join('. ')}`,
        `${CLI} instructions shows what each part could move to (.claude/rules/ with paths:, a skill) and changes nothing; why it matters: docs/costs.md#claudes-instructions`,
      ),
    );
  }
  if (a.cut.length)
    out.push(
      warn(
        'instructions-cut',
        `Claude sees only the first ${IS.n(IS.CUT_CHARS)} chars of a file it loads on demand (on a 200K window): ${list(
          a.cut.map((f) => `${f.rel} (${IS.n(f.chars)} chars${f.files > 1 ? ` with ${f.files - 1} import(s)` : ''})`),
        )}`,
        `split it into smaller files, or move a procedure in it to a skill; ${CLI} instructions shows the sections`,
      ),
    );
  return out;
}

/** The baseline checks in the order doctor prints them. */
export const BASELINE_CHECKS = [checkBaseBranch, checkIdentity, checkSecrets, checkAllowlistSecrets, checkMcpSecrets, checkBroadPermissions, checkGitignore, checkShare, checkGates, checkCi, checkLockfile, checkProductionBranch, checkLargeFiles, checkInstructions];
