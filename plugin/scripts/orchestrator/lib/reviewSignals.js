// =============================================================
// reviewSignals.js: review signals lift a reviewer in by what a task's diff ADDS, not only by its class.
//
// Why: the fixed reviewers follow the class (config().reviewers: K and U none, D `reviewer`, D+ also
// `reviewer-security`), and the helper agents are chosen by paths, labels and the plan. So a class K task that changed
// the sign-in flow, added a secret, fetched a URL built from data or wrote raw HTML got no security review at all.
//
// A signal has paths (a changed file matches, lib/queueHelpers.js pathPattern) and words (regular expressions tried on
// the ADDED lines of the diff). It counts only product code: code files (CODE_EXT), never test files, comment lines,
// removed lines or docs. The hit lifts the signal's reviewer in with one line of reason
// ("signal auth: src/Login.tsx, words auth.signOut"). The class stays the floor: a signal only adds, never removes.
//
// Narrow on purpose. A signal that fires on nearly every task gets ignored, and every review costs: no hit on the word
// "auth" alone or on reading the signed-in user (useAuth(), getUser()). The hit rate per signal is measured from the
// task records (`review_signals` written by receive) and shown by `ravenseat helpers`; a broad signal is marked.
//
// Project setup in queue.config.json, `review.signals`:
//   { "<name>": { "enabled": false } }                       switch a built-in off (a weakening, doctor names it)
//   { "auth": { "paths": ["src/gate/**"], "words": ["\\bmyLogin\\("] } }   add to a built-in
//   { "payments": { "reviewer": "reviewer", "words": ["\\bstripe\\.charges\\."] } }   a signal of its own
// Words are regular expressions (case does not matter). An invalid one is reported in signalSetup().problems and skipped.
//
// Pure logic (no file I/O), tested in lib/__tests__/reviewSignals.test.ts.
// =============================================================
'use strict';

const list = (x) => (Array.isArray(x) ? x.map(String).filter(Boolean) : []);
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '');

/** A line is cut to this many characters before the words are tried (minified code, a slow match). */
const MAX_LINE = 2000;

/** A signal is broad when it hits on more than this share of at least BROAD_MIN checked tasks. */
const BROAD_PCT = 30;
const BROAD_MIN = 10;

// The storage APIs a token or session must not land in carelessly (web, React Native, Expo, cookies).
const STORES = '(?:localStorage|sessionStorage|AsyncStorage|SecureStore|document\\.cookie|cookies\\.set)';

/**
 * The built-in signals. Words are regex sources (flag i). Paths use the helper path patterns: "dir/" = the folder from
 * the root, a pattern without "/" = that file name anywhere, "**" = any folders.
 */
const BUILTIN = Object.freeze({
  auth: Object.freeze({
    reviewer: 'reviewer-security',
    text: 'Sign-in, session, token storage, MFA, passkeys and route guards.',
    paths: Object.freeze([
      '**/auth/**',
      '**/(auth)/**',
      '**/mfa/**',
      '**/oauth/**',
      '**/login/**',
      '**/passkeys/**',
      '**/webauthn/**',
      'auth.*',
      '*auth.*',
      'auth.config.*',
      '*session*',
      '*login*',
      '*signin*',
      '*sign-in*',
      '*logout*',
      '*oauth*',
      '*mfa*',
      '*passkey*',
      '*webauthn*',
      '*stepup*',
      '*step-up*',
      'middleware.ts',
      'middleware.js',
    ]),
    words: Object.freeze([
      // Supabase, Firebase, NextAuth, Clerk, Auth0 and the like: calls that CHANGE who is signed in.
      '\\b(?:signIn\\w*|signUp\\w*|signOut|logout|setSession|refreshSession|verifyOtp|exchangeCodeForSession|onAuthStateChange|setActive|loginWithRedirect|handleRedirectCallback)\\s*\\(',
      '\\bauth\\.mfa\\.',
      '\\b(?:refresh_token|access_token|id_token)\\b',
      `${STORES}[^\\n]*(?:token|session|jwt)`,
      `(?:token|session|jwt)[^\\n]*${STORES}`,
      '\\bjwt\\.(?:sign|verify|decode)\\s*\\(',
      '\\b(?:SignJWT|jwtVerify)\\b',
      // Django and Rails sessions.
      '\\b(?:login|logout|authenticate)\\s*\\(\\s*request\\b',
      '\\breset_session\\b',
      '\\bsession\\[:',
    ]),
  }),
  secret: Object.freeze({
    reviewer: 'reviewer-security',
    text: 'A service-role or secret key, or a private key, in the code.',
    paths: Object.freeze([]),
    words: Object.freeze(['SERVICE_ROLE','\\b[A-Z0-9_]*(?:SECRET_KEY|PRIVATE_KEY|CLIENT_SECRET)\\b', 'PRIVATE KEY-----']),
  }),
  'url-from-data': Object.freeze({
    reviewer: 'reviewer-security',
    text: 'A request to a URL that is not a literal (server-side request forgery, open redirect).',
    paths: Object.freeze([]),
    // Not a regex: urlFromData() reads the first argument of the call (see below).
    words: Object.freeze([]),
    check: 'url',
  }),
  'html-sink': Object.freeze({
    reviewer: 'reviewer-security',
    text: 'Raw HTML into the page (cross-site scripting).',
    paths: Object.freeze([]),
    words: Object.freeze([
      '\\.(?:innerHTML|outerHTML)\\s*\\+?=',
      '\\bdangerouslySetInnerHTML\\b',
      '\\binsertAdjacentHTML\\s*\\(',
      '\\bdocument\\.write(?:ln)?\\s*\\(',
      '\\bv-html\\b',
      '\\{@html\\b',
      '\\bmark_safe\\s*\\(',
      '\\.html_safe\\b',
    ]),
  }),
});

/** The names of the built-in signals. */
const BUILTIN_NAMES = Object.freeze(Object.keys(BUILTIN));

// ---- What counts as product code ----

/** The code file extensions a signal reads (never .md, .txt, .json or images). */
const CODE_EXT = new Set(
  'js jsx mjs cjs ts tsx mts cts vue svelte astro html htm py rb erb go java kt kts swift php cs rs scala dart ex exs lua'.split(' '),
);

/** Is the path a code file? */
function isCodePath(p) {
  const m = /\.([a-z0-9]+)$/i.exec(norm(p));
  return !!m && CODE_EXT.has(m[1].toLowerCase());
}

/** Is the path a test file (test folders, *.test.*, *.spec.*, *_test.go, test_*.py)? */
function isTestPath(p) {
  const s = norm(p).toLowerCase();
  return (
    /(^|\/)(__tests__|__mocks__|tests?|spec|specs|e2e|cypress|playwright)\//.test(s) ||
    /\.(test|spec|e2e)\.[a-z0-9]+$/.test(s) ||
    /_test\.go$/.test(s) ||
    /(^|\/)test_[^/]*\.py$/.test(s) ||
    /_spec\.rb$/.test(s)
  );
}

/** Is the line (an added line, without its "+") only a comment? */
function isCommentLine(text) {
  const t = String(text ?? '').trim();
  return /^(\/\/|\/\*|\*|#|<!--|--|\{\/\*)/.test(t);
}

// ---- The diff ----

/**
 * The added lines of a unified diff, per file: [{ file, text }]. The "+++" header and removed lines are never included;
 * a deleted file ("+++ /dev/null") has none.
 */
function addedLines(diff) {
  const out = [];
  let file = null;
  let inHunk = false;
  for (const line of String(diff ?? '').split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      file = null;
      inHunk = false;
      continue;
    }
    if (!inHunk && line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      file = p === '/dev/null' ? null : norm(p.replace(/^b\//, ''));
      continue;
    }
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (inHunk && file && line.startsWith('+')) out.push({ file, text: line.slice(1) });
  }
  return out;
}

// ---- The url-from-data check ----

// The request calls whose first argument is the URL (fetch, axios, got, ky, Python requests and urllib, Node http).
const REQUEST_CALL =
  /\b(?:fetch|axios(?:\.(?:get|post|put|patch|delete|head|request))?|got(?:\.(?:get|post|put|patch|delete))?|ky(?:\.(?:get|post|put|patch|delete))?|requests\.(?:get|post|put|patch|delete|head|request)|httpx\.(?:get|post|put|patch|delete)|urlopen|https?\.(?:get|request))\s*\(\s*/gi;

/** A fixed start of a URL: scheme + host + "/" or a same-site path ("/x", not "//x"). */
const FIXED_START = /^(?:https?:\/\/[^/\s'"`$]+\/|\/(?!\/))/i;

/**
 * Does a request call on the line take a URL that is not a literal? Fail-closed: a call whose argument cannot be read
 * on the line (nothing after "(") is a hit. A whole literal string is fine; a literal followed by "+" or a template
 * with "${" is fine only when the fixed part starts with scheme + host + "/" or a same-site path.
 */
function urlFromData(text) {
  REQUEST_CALL.lastIndex = 0;
  let m;
  while ((m = REQUEST_CALL.exec(text))) {
    const rest = text.slice(m.index + m[0].length);
    if (!rest.trim()) return true;
    const q = rest[0];
    if (q === "'" || q === '"' || q === '`') {
      const end = rest.indexOf(q, 1);
      if (end < 0) return true;
      const body = rest.slice(1, end);
      const after = rest.slice(end + 1).trimStart();
      if (q === '`' && body.includes('${')) {
        if (!FIXED_START.test(body.slice(0, body.indexOf('${')))) return true;
        continue;
      }
      if (after.startsWith('+')) {
        if (!FIXED_START.test(body)) return true;
        continue;
      }
      continue;
    }
    return true;
  }
  return false;
}

// ---- The setup ----

/** A word as a regular expression, or a problem text. */
function compile(source) {
  try {
    return { re: new RegExp(source, 'i') };
  } catch (e) {
    return { problem: `word ${JSON.stringify(source)} is not a valid regular expression (${e.message})` };
  }
}

const NO_PACKS = Object.freeze({ signals: {}, codeExt: new Set(), codeFiles: new Set() });

/** What the turned-on stack packs add (review.packs). None turned on: nothing, and the pack data is not read. */
function packAdditions(config, packs) {
  const ids = list(config?.review?.packs);
  if (!ids.length) return NO_PACKS;
  const RP = require('./reviewPacks.js');
  return RP.packSignals(ids, packs ?? RP.builtinData());
}

/**
 * The signals for a project: the built-ins, what the turned-on stack packs add (review.packs, lib/reviewPacks.js),
 * what review.signals adds, and the project's own. Each:
 * { name, enabled, reviewer, text, paths, words (RegExp[]), check, builtin, fromPack, problems }. A signal with a
 * problem in its own definition (no reviewer, no paths and words) never hits; an invalid word is skipped and reported.
 * `packs` is the pack data (tests and validation pass their own; otherwise the shipped packs).
 */
function signalSetup(config, packs = undefined) {
  const own = isObject(config?.review?.signals) ? config.review.signals : {};
  const fromPacks = packAdditions(config, packs).signals;
  const out = {};
  const names = [...new Set([...BUILTIN_NAMES, ...Object.keys(fromPacks), ...Object.keys(own)])];
  for (const name of names) {
    // A pack's new signal (raw-sql, access-rule ...) is defined by the pack, with its reviewer and text.
    const b = BUILTIN[name] ?? fromPacks[name] ?? null;
    const p = BUILTIN[name] ? (fromPacks[name] ?? null) : null;
    const x = isObject(own[name]) ? own[name] : {};
    const problems = [];
    const sources = [...(b?.words ?? []), ...(p?.words ?? []), ...list(x.words)];
    const words = [];
    for (const s of sources) {
      const c = compile(s);
      if (c.re) words.push(c.re);
      else problems.push(c.problem);
    }
    const reviewer = typeof x.reviewer === 'string' && x.reviewer ? x.reviewer : (b?.reviewer ?? null);
    const paths = [...(b?.paths ?? []), ...(p?.paths ?? []), ...list(x.paths)];
    if (!b) {
      if (!reviewer) problems.push('no reviewer: set "reviewer" to the agent the signal lifts in');
      if (!paths.length && !list(x.words).length) problems.push('no paths and no words: the signal can never hit');
    }
    out[name] = {
      name,
      enabled: x.enabled !== false,
      reviewer,
      text: typeof x.text === 'string' ? x.text : (b?.text ?? ''),
      paths,
      words,
      check: b?.check ?? null,
      builtin: !!BUILTIN[name],
      fromPack: !BUILTIN[name] && !!fromPacks[name],
      problems,
      broken: !b && problems.some((p) => !p.startsWith('word ')),
    };
  }
  return out;
}

/**
 * The signals that hit for a task: [{ name, reviewer, reason }], at most one per signal. Paths count only for changed
 * code files outside tests; words only on added lines of such files that are not comment lines.
 * @param {{ config: object, changedPaths?: string[], diff?: string|null }} c
 */
function signalHits({ config, changedPaths = [], diff = null, packs = undefined } = {}) {
  const { matchesAny } = require('./queueHelpers.js');
  const setup = signalSetup(config, packs);
  // A pack can make more files count as code (.sql for database rules, .rules for Firebase).
  const extra = packAdditions(config, packs);
  const extraCode = (p) => {
    const f = norm(p);
    const ext = (/\.([a-z0-9]+)$/i.exec(f)?.[1] ?? '').toLowerCase();
    return extra.codeExt.has(ext) || extra.codeFiles.has(f.split('/').pop());
  };
  const product = (p) => (isCodePath(p) || extraCode(p)) && !isTestPath(p);
  const paths = list(changedPaths).map(norm).filter(product);
  const lines = addedLines(diff).filter((l) => product(l.file) && !isCommentLine(l.text));
  const out = [];
  for (const s of Object.values(setup)) {
    if (!s.enabled || s.broken || !s.reviewer) continue;
    const why = [];
    if (s.paths.length) {
      const hit = paths.find((p) => matchesAny(p, s.paths));
      if (hit) why.push({ file: hit, what: 'path' });
    }
    for (const l of lines) {
      if (why.some((w) => w.what !== 'path')) break;
      const text = l.text.length > MAX_LINE ? l.text.slice(0, MAX_LINE) : l.text;
      if (s.check === 'url' && urlFromData(text)) {
        why.push({ file: l.file, what: 'a request URL that is not a literal' });
        continue;
      }
      const re = s.words.find((w) => w.test(text));
      if (re) {
        const word = (re.exec(text)?.[0] ?? '').trim().slice(0, 40);
        why.push({ file: l.file, what: `words ${word}` });
      }
    }
    if (!why.length) continue;
    const first = why.find((w) => w.what !== 'path') ?? why[0];
    const pathHit = why.find((w) => w.what === 'path');
    const parts = [first.what === 'path' ? `${first.file}` : `${first.file}, ${first.what}`];
    if (pathHit && pathHit !== first) parts.push(`path ${pathHit.file}`);
    out.push({ name: s.name, reviewer: s.reviewer, reason: `signal ${s.name}: ${parts.join(', ')}` });
  }
  return out;
}

// ---- The measurement ----

/**
 * The hit rate per signal from the task records receive writes (`review_signals: { at, hits }`, the latest receive).
 * @returns {{ checked: number, signals: Record<string, { hits: number, pct: number, broad: boolean }> }}
 */
function signalStatistics(queue, config) {
  const tasks = (Array.isArray(queue?.tasks) ? queue.tasks : []).filter((o) => isObject(o?.review_signals));
  const checked = tasks.length;
  const signals = {};
  for (const name of Object.keys(signalSetup(config))) {
    const hits = tasks.filter((o) => list(o.review_signals.hits).includes(name)).length;
    const pct = checked ? Math.round((hits * 100) / checked) : 0;
    signals[name] = { hits, pct, broad: checked >= BROAD_MIN && pct > BROAD_PCT };
  }
  return { checked, signals };
}

/** The measurement in lines for `ravenseat helpers`: one per signal, with the rate and a note when it is broad. */
function statisticsLines(st, setup = null) {
  if (!st.checked) return ['  No tasks checked yet (receive records which signals hit).'];
  return Object.entries(st.signals).map(([name, s]) => {
    const off = setup && setup[name] && !setup[name].enabled ? ' (off)' : '';
    const broad = s.broad ? ` · broad: hits on more than ${BROAD_PCT} %, narrow its paths or words in review.signals` : '';
    return `  ${name}${off}: ${s.hits} of ${st.checked} checked tasks (${s.pct} %)${broad}`;
  });
}

/** Is a value for review.signals a weakening (a built-in switched off)? */
function weakens(value) {
  if (!isObject(value)) return false;
  return Object.entries(value).some(([n, s]) => BUILTIN[n] && isObject(s) && s.enabled === false);
}

module.exports = {
  BUILTIN,
  BUILTIN_NAMES,
  BROAD_PCT,
  BROAD_MIN,
  isCodePath,
  isTestPath,
  isCommentLine,
  addedLines,
  urlFromData,
  signalSetup,
  signalHits,
  signalStatistics,
  statisticsLines,
  weakens,
};
