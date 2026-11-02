// =============================================================
// secretScan.js: the secret precheck the push guard runs before a plain push of baseBranch from the main session.
//
// WHY: a key that reaches the remote stays in its history, also after the file is deleted. The cheapest moment to
// catch one is right before the push, on exactly what is about to leave the machine. The guard only ASKS on a hit
// (never denies): the owner looks at the named lines and decides. It is a safety net, not a full scanner.
//
// What is scanned: the added lines of EVERY commit the push sends, `git log -p --no-merges <remote>/<baseBranch>..
// <baseBranch>` (M4 in plans/review-2026-11-02.md). The net diff alone missed a key added in one commit and deleted in
// the next: the remote still gets it in the history. A log over secretScan.maxBytes falls back to the net diff (better
// than nothing), and that one over the cap is skipped as before.
//   - gitleaks, when it is on PATH: `gitleaks git --log-opts=<range> --redact`, with the time cap. Any problem with
//     it (an old version without `git`, a crash, the time cap) falls back to the built-in patterns.
//   - otherwise the built-in patterns below (PATTERNS): few, specific formats with a low false-positive rate (JWTs
//     included), plus three rules that skip test, fixture, example and Markdown files: a URI with a password in it
//     (scheme://user:pass@host), a value line in a `.env` style file (.env, .env.local, .env.production; never
//     .env.example and the like), and the generic "name = long value" rule.
// Limits (fails OPEN, the push goes on without a question):
//   - the output is larger than secretScan.maxBytes even as a net diff: skipped, silently (a big push is not slowed);
//   - git takes longer than secretScan.timeoutMs, the remote ref is missing (a first push), or any error.
// The question names file:line, the rule and the commit only, NEVER the matched text (the dialog and the transcript
// would otherwise copy the secret around).
//
// Config: secretScan { enabled, maxBytes, timeoutMs } in queue.config.json (lib/queueConfig.js).
// QUEUE_SECRET_SCANNER=builtin skips gitleaks (tests).
//
// Used by: hook-push-guard.mjs (secretQuestion -> scanPush). scanRange takes any from..to range (e.g. a track branch
// against its merge base at receive). Tested in: lib/__tests__/secretScan.test.ts.
// =============================================================

const { spawnSync } = require('node:child_process');

/**
 * The built-in patterns: { id, re }. Kept small on purpose; each one is a format a provider issues, so a match is
 * almost always a real key. They run in every file (also tests and docs). lib/askBundle.js redacts with them too.
 */
const PATTERNS = Object.freeze([
  { id: 'private-key', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { id: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/ },
  { id: 'gitlab-token', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
  { id: 'slack-webhook', re: /https:\/\/hooks\.slack\.com\/services\/T[A-Za-z0-9]+\/B[A-Za-z0-9]+\/[A-Za-z0-9]{20,}/ },
  { id: 'stripe-live-key', re: /\b[sr]k_live_[A-Za-z0-9]{20,}\b/ },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'azure-storage-key', re: /AccountKey=[A-Za-z0-9+/]{80,}={0,2}/ },
  { id: 'openai-key', re: /\bsk-[A-Za-z0-9_-]*T3BlbkFJ[A-Za-z0-9_-]{10,}/ },
  { id: 'anthropic-key', re: /\bsk-ant-[a-z]+\d{2}-[A-Za-z0-9_-]{60,}/ },
  // A JSON Web Token (three base64url parts, header and payload starting with {"): e.g. a Supabase service_role key.
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/ },
  { id: 'supabase-secret-key', re: /\bsb_secret_[A-Za-z0-9_-]{20,}/ },
  { id: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { id: 'sendgrid-key', re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/ },
  { id: 'huggingface-token', re: /\bhf_[A-Za-z0-9]{34,}\b/ },
  { id: 'digitalocean-token', re: /\bdo[por]_v1_[a-f0-9]{64}\b/ },
  { id: 'google-oauth-secret', re: /\bGOCSPX-[A-Za-z0-9_-]{28}\b/ },
  { id: 'gcp-service-account', re: /"type"\s*:\s*"service_account"/ },
]);

/**
 * The generic rule: a name with password/secret/token/api key (or a cloud key name such as SERVICE_ROLE_KEY,
 * AWS_SECRET_ACCESS_KEY, CLIENT_SECRET) in it, then = or :, then a long value.
 */
const GENERIC =
  /(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|access[_-]?key|role[_-]?key|signing[_-]?key|encryption[_-]?key|auth[_-]?key)[A-Za-z0-9_-]*["']?\s*[:=]\s*["']?([^\s"'`,;]{16,})/i;
/** Values that are references or placeholders, not a secret. */
const PLACEHOLDER = /^[$%{<]|process\.env|os\.environ|getenv|\(|\{\{|example|changeme|your[_-]|x{6,}|\*{4,}|<.*>/i;
/** A URI with a user and a password: scheme://user:password@host. Group 1 = user, group 2 = password. */
const URI_CREDENTIALS = /\b[a-z][a-z0-9+.-]{1,30}:\/\/([^\s:@/"'`]{1,128}):([^\s@/"'`]{1,256})@[A-Za-z0-9[\]._-]+/i;
/** Passwords in URIs that are local defaults or placeholders, not a secret. */
const DEFAULT_PASSWORDS = new Set([
  'password',
  'pass',
  'passwd',
  'pwd',
  'secret',
  'postgres',
  'root',
  'admin',
  'test',
  'user',
  'changeme',
  'guest',
  'mysql',
]);
/** A value line in a .env style file: NAME=value (optionally `export NAME=value`). Group 1 = the value. */
const ENV_LINE = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*=\s*(.*?)\s*$/;

/** Test, fixture, example and docs files: the context rules are skipped there (dummy values are normal in them). */
function isQuietFile(file) {
  const f = String(file || '').replace(/\\/g, '/');
  if (/(^|\/)(tests?|__tests__|spec|specs|fixtures?|testdata|mocks?|__mocks__|examples?)\//i.test(f)) return true;
  const base = f.split('/').pop();
  return (
    /\.(test|spec)\.[a-z0-9]+$/i.test(base) ||
    /_test\.[a-z0-9]+$/i.test(base) ||
    /^test_.*\.py$/i.test(base) ||
    /\.(md|mdx|rst|txt)$/i.test(base) ||
    /\.(example|sample|template|dist)$/i.test(base) ||
    /(^|[.-])lock(\.json|\.ya?ml)?$|-lock\.|\.lock$/i.test(base)
  );
}

/** A `.env` style file: .env, .env.local, .env.production ... (not the example, sample or template ones). */
function isEnvFile(file) {
  const base = String(file || '').replace(/\\/g, '/').split('/').pop();
  return /^\.env(\.[A-Za-z0-9_-]+)*$/i.test(base) && !/\.(example|sample|template|dist|defaults|schema)$/i.test(base);
}

/** Does the line hold a URI whose password looks real (not a placeholder, a local default or the user name)? */
function uriSecret(text) {
  const m = URI_CREDENTIALS.exec(text);
  if (!m) return false;
  const [, user, pass] = m;
  if (pass.length < 6 || PLACEHOLDER.test(pass) || DEFAULT_PASSWORDS.has(pass.toLowerCase())) return false;
  return pass !== user;
}

/** Is the line a value line in a .env file that holds a value (not a comment, empty, a reference or a placeholder)? */
function envValue(text) {
  if (/^\s*#/.test(text)) return false;
  const m = ENV_LINE.exec(text);
  if (!m) return false;
  const v = m[1].replace(/^(["'])(.*)\1$/, '$2').trim();
  return v.length > 0 && !PLACEHOLDER.test(v);
}

/**
 * The added lines of a unified diff: [{ file, line, text }]. Reads the `+++ b/<path>` headers and the `@@ ... +c,d @@`
 * hunk heads; only `+` lines count (removed lines leave the remote anyway). Also reads `git log -p` output written with
 * `--format=commit %H`: each line then carries `commit` (the short sha of the commit that added it).
 * @param {string} diff  `git diff` or `git log -p` output
 */
function addedLines(diff) {
  const out = [];
  let file = null;
  let line = 0;
  let commit = null;
  for (const raw of String(diff || '').split('\n')) {
    const l = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const c = /^commit ([0-9a-f]{40}|[0-9a-f]{64})$/.exec(l);
    if (c) {
      commit = c[1].slice(0, 7);
      file = null;
      continue;
    }
    if (l.startsWith('+++ ')) {
      const p = l.slice(4).replace(/^"(.*)"$/, '$1');
      file = p === '/dev/null' ? null : p.replace(/^b\//, '');
      continue;
    }
    if (l.startsWith('--- ') || l.startsWith('diff --git ')) continue;
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(l);
    if (h) {
      line = Number(h[1]);
      continue;
    }
    if (!file) continue;
    if (l.startsWith('+')) {
      out.push(commit ? { file, line, text: l.slice(1), commit } : { file, line, text: l.slice(1) });
      line++;
    } else if (l.startsWith(' ')) line++;
  }
  return out;
}

/**
 * The hits in a list of added lines: [{ file, line, rule, commit? }], at most one per line. The matched text is never
 * returned. `commit` is there when the lines came from `git log -p`.
 * @param {{ file: string, line: number, text: string, commit?: string }[]} lines
 */
function scanLines(lines) {
  const hits = [];
  for (const { file, line, text, commit } of lines) {
    if (text.length > 4000) continue; // a minified bundle or a data blob: not a place a key is typed in
    const hit = (rule) => hits.push(commit ? { file, line, rule, commit } : { file, line, rule });
    const p = PATTERNS.find((x) => x.re.test(text));
    if (p) {
      hit(p.id);
      continue;
    }
    if (isQuietFile(file)) continue;
    if (uriSecret(text)) {
      hit('uri-credentials');
      continue;
    }
    if (isEnvFile(file) && envValue(text)) {
      hit('env-file');
      continue;
    }
    const m = GENERIC.exec(text);
    const v = m?.[1] ?? '';
    if (m && !PLACEHOLDER.test(v) && /\d/.test(v) && /[A-Za-z]/.test(v)) hit('generic-secret');
  }
  return hits;
}

/**
 * gitleaks on the range, or null when it is not there or did not give a clean answer (then the built-in scan runs).
 * Exit 0 = no leaks, exit 1 = leaks (JSON report on stdout), anything else = a problem.
 */
function gitleaks(cwd, range, timeoutMs) {
  if (process.env.QUEUE_SECRET_SCANNER === 'builtin') return null;
  try {
    const r = spawnSync(
      'gitleaks',
      ['git', '--no-banner', '--redact', '--log-level', 'error', '--report-format', 'json', '--report-path', '-', `--log-opts=${range}`, '.'],
      { cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
    );
    if (r.error || (r.status !== 0 && r.status !== 1)) return null;
    if (r.status === 0) return [];
    const report = JSON.parse(r.stdout || '[]');
    if (!Array.isArray(report)) return null;
    return report.map((f) => ({ file: String(f.File ?? '?'), line: Number(f.StartLine) || 0, rule: String(f.RuleID ?? 'gitleaks') }));
  } catch {
    return null;
  }
}

/**
 * Scan what a push of `branch` to `remote` sends (scanRange on <remote>/<branch>..<branch>).
 * @param {object} o
 * @param {string} o.cwd
 * @param {string} o.remote
 * @param {string} o.branch
 * @param {{ maxBytes?: number, timeoutMs?: number }} [o.setup]
 */
function scanPush(o) {
  return scanRange({ cwd: o.cwd, from: `refs/remotes/${o.remote}/${o.branch}`, to: `refs/heads/${o.branch}`, setup: o.setup });
}

/**
 * Scan the commits in `from..to` one by one (`git log -p --no-merges`), so a secret added and later removed in the
 * range is still found. Returns { hits, scanner } or null (skipped: `from` missing, the output over the cap even as a
 * net diff, a timeout, any error).
 * @param {{ cwd: string, from: string, to: string, setup?: { maxBytes?: number, timeoutMs?: number } }} o
 */
function scanRange(o) {
  const maxBytes = Number(o.setup?.maxBytes) > 0 ? Number(o.setup.maxBytes) : 2_000_000;
  const timeoutMs = Number(o.setup?.timeoutMs) > 0 ? Number(o.setup.timeoutMs) : 3000;
  const run = (args, extra = {}) =>
    spawnSync('git', ['-C', o.cwd, ...args], { encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, ...extra });
  const quote = ['-c', 'core.quotepath=off'];
  const plain = ['--no-color', '--no-ext-diff', '--no-textconv', '--unified=0'];
  try {
    // A first push (no remote ref) would scan the whole history: skipped (fails open).
    if (run(['rev-parse', '-q', '--verify', o.from]).status !== 0) return null;
    const range = `${o.from}..${o.to}`;
    // Every commit's own added lines. Merge commits are skipped: the commits they bring in are in the range themselves.
    let d = run([...quote, 'log', '-p', '--no-merges', '--format=commit %H', ...plain, range], { maxBuffer: maxBytes });
    // The log over the cap: the net diff instead (it still sees what the tip holds); that one over the cap is skipped.
    if (d.error && /ENOBUFS|maxBuffer/i.test(`${d.error.code ?? ''} ${d.error.message ?? ''}`))
      d = run([...quote, 'diff', ...plain, range], { maxBuffer: maxBytes });
    // Over the cap (ENOBUFS), over the time (ETIMEDOUT) or a git error: no question.
    if (d.error || d.status !== 0) return null;
    if (!d.stdout.trim()) return { hits: [], scanner: 'none' };
    const leaks = gitleaks(o.cwd, range, timeoutMs);
    if (leaks) return { hits: leaks, scanner: 'gitleaks' };
    return { hits: scanLines(addedLines(d.stdout)), scanner: 'built-in' };
  } catch {
    return null;
  }
}

/** The push guard's question for the hits, or null. Names file:line, the rule and the commit, never the value. */
function question(result) {
  const hits = result?.hits ?? [];
  if (!hits.length) return null;
  const shown = hits.slice(0, 5).map((h) => `${h.file}:${h.line} (${h.rule})${h.commit ? ` in ${h.commit}` : ''}`);
  const more = hits.length > 5 ? ` and ${hits.length - 5} more` : '';
  return (
    `Possible secret in what this push sends (${result.scanner} scan): ${shown.join(', ')}${more}. ` +
    'Check those lines before you push: every commit is scanned, so a line deleted again later still counts; once ' +
    'pushed, a key stays in the history, so change it if it was real. A false alarm: push anyway.'
  );
}

module.exports = { PATTERNS, addedLines, scanLines, isQuietFile, isEnvFile, scanPush, scanRange, question };
