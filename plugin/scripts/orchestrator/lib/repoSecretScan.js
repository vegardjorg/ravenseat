// =============================================================
// repoSecretScan.js: the scan of every file git tracks and of the history's added lines, for keys (roadmap 6b).
//
// WHY: the push check (lib/secretScan.js scanPush) reads only what a push is about to send. A key that is already in a
// tracked file, or that an old commit added and a later one deleted, is never seen by it, yet every clone can read it.
// This scan finds those. It REPORTS and never rewrites: a finding says rotate the key, and for one in the history how to
// purge it by hand (git filter-repo); nothing here changes a file or a commit.
//
// What is read:
//   - scanTracked: every blob of HEAD (`git ls-tree -r -l HEAD`, then `git cat-file --batch` in parts), so the files git
//     has, not what happens to be on disk. A file over secretScan.maxBytes and a binary file (a NUL byte in its first
//     8000 bytes) are skipped and counted. Symlinks and submodules are not files here.
//   - scanHistory: the added lines of the last N commits (`git log -p --no-merges -n N HEAD`, read as a stream, one
//     commit at a time, so a long history never sits in memory at once). A commit whose diff is over maxBytes is skipped
//     and counted. `all` reads every commit.
// The rules are secretScan.js matchValue (the same patterns, quiet-file and placeholder handling as the push check);
// nothing is forked here.
//
// A finding NEVER holds the value: { where: tree|history, file, line, rule, hash, preview, commit?, inTree? }.
//   hash     HMAC-SHA256 of the value with a salt made once per data folder (16 hex characters), so the same key is known
//            again across runs and in both the tree and the history, while a short password cannot be guessed back from
//            the hash. A rule that matches a fixed text (a private key header, a service account file) hashes the line
//            after it, or the rule and the file.
//   preview  the first and last two characters, only for a value of 12 characters or more; otherwise null.
// The results go to <dataFolder>/secret-scan.json, the salt and the false alarms to <dataFolder>/secret-scan-ignore.json.
// Both are ignored by git with the data folder, and a file with "secret" in its name can never be shared
// (lib/queueShare.js NEVER).
//
// Used by: cli/secrets.mjs (`ravenseat secrets scan|ignore|unignore`, and the doctor row), cli/checks.mjs (the cards
// secret-scan-found and secret-scan-due). Tested in: lib/__tests__/repoSecretScan.test.ts, __tests__/secretsScanCli.test.ts.
// =============================================================

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');

const SS = require('./secretScan.js');

const RESULT_FILE = 'secret-scan.json';
const IGNORE_FILE = 'secret-scan-ignore.json';
const DEFAULTS = Object.freeze({ historyDepth: 200, rescanDays: 14, maxBytes: 2_000_000 });
/** How to purge a key from the history by hand (never done by Ravenseat). */
const PURGE_DOCS = 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository';
/** The rules whose match is a fixed text: the value that tells two keys apart is the line after it, or the file. */
const STRUCTURAL = new Set(['private-key', 'gcp-service-account']);
/** cat-file reads at most this many bytes of blobs per call. */
const BATCH_BYTES = 32 * 1024 * 1024;
const HASH = /^[0-9a-f]{16}$/;

/** The settings: secretScan.historyDepth (> 0), secretScan.rescanDays (>= 0, 0 = no reminder), secretScan.maxBytes. */
function setupOf(config) {
  const s = config?.secretScan ?? {};
  const pos = (v, d) => (Number.isInteger(v) && v > 0 ? v : d);
  return {
    historyDepth: pos(s.historyDepth, DEFAULTS.historyDepth),
    rescanDays: Number.isInteger(s.rescanDays) && s.rescanDays >= 0 ? s.rescanDays : DEFAULTS.rescanDays,
    maxBytes: pos(s.maxBytes, DEFAULTS.maxBytes),
  };
}

/** What is wrong with secretScan.historyDepth and rescanDays (a broken value reads as its default; doctor names it). */
function setupProblems(s) {
  const out = [];
  if (!s || typeof s !== 'object' || Array.isArray(s)) return out;
  if (s.historyDepth !== undefined && !(Number.isInteger(s.historyDepth) && s.historyDepth > 0)) out.push('secretScan.historyDepth must be a whole number > 0');
  if (s.rescanDays !== undefined && !(Number.isInteger(s.rescanDays) && s.rescanDays >= 0)) out.push('secretScan.rescanDays must be a whole number >= 0');
  return out;
}

/**
 * The findings in a list of lines of one file: [{ line, rule, value, structural }]. The value stays inside this module:
 * finalize turns it into a hash and drops it.
 * @param {{ line: number, text: string }[]} lines
 * @param {string} file
 */
function matchLines(lines, file) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = SS.matchValue(lines[i].text, file);
    if (!m) continue;
    let value = m.value;
    const structural = STRUCTURAL.has(m.rule);
    if (structural) {
      const next = lines.slice(i + 1).find((l) => l.text.trim());
      value = m.rule === 'private-key' && next ? `${m.rule}\n${next.text.trim()}` : `${m.rule}\n${file}`;
    }
    out.push({ line: lines[i].line, rule: m.rule, value, structural });
  }
  return out;
}

/** The text of a blob as numbered lines. */
function numbered(text) {
  return text.split('\n').map((l, i) => ({ line: i + 1, text: l.endsWith('\r') ? l.slice(0, -1) : l }));
}

/**
 * Scan every file of HEAD. Returns { findings (raw, with value), files, skipped: { binary, large }, incomplete? }.
 * @param {{ cwd: string, maxBytes?: number }} o
 */
function scanTracked(o) {
  const maxBytes = Number(o.maxBytes) > 0 ? Number(o.maxBytes) : DEFAULTS.maxBytes;
  const out = { findings: [], files: 0, skipped: { binary: 0, large: 0 } };
  const git = (args, extra = {}) =>
    spawnSync('git', ['-C', o.cwd, ...args], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, maxBuffer: 256 * 1024 * 1024, ...extra });
  if (git(['rev-parse', '-q', '--verify', 'HEAD^{commit}']).status !== 0) return { ...out, incomplete: 'no commit yet, so git tracks no file' };
  const tree = git(['ls-tree', '-r', '-z', '-l', '--full-tree', 'HEAD'], { encoding: 'utf8' });
  if (tree.status !== 0 || tree.error) return { ...out, incomplete: 'git could not list the tracked files' };
  const blobs = [];
  for (const entry of tree.stdout.split('\0')) {
    const m = /^(\d+) (\w+) ([0-9a-f]+)\s+(\d+|-)\t([\s\S]+)$/.exec(entry);
    if (!m || m[2] !== 'blob' || m[1] === '120000') continue;
    const size = Number(m[4]);
    if (size > maxBytes) out.skipped.large++;
    else blobs.push({ sha: m[3], size, file: m[5] });
  }
  // In parts, so no single read holds more than BATCH_BYTES of blobs.
  for (let i = 0; i < blobs.length; ) {
    const part = [];
    let bytes = 0;
    while (i < blobs.length && (part.length === 0 || bytes + blobs[i].size <= BATCH_BYTES)) {
      bytes += blobs[i].size;
      part.push(blobs[i++]);
    }
    const r = git(['cat-file', '--batch'], { input: `${part.map((b) => b.sha).join('\n')}\n`, stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: bytes + part.length * 128 + 1024 * 1024 });
    if (r.status !== 0 || r.error) return { ...out, incomplete: 'git could not read the tracked files' };
    const buf = r.stdout;
    let pos = 0;
    for (const b of part) {
      const nl = buf.indexOf(10, pos);
      if (nl < 0) break;
      const head = buf.toString('utf8', pos, nl).split(' ');
      pos = nl + 1;
      if (head[1] === 'missing') continue;
      const size = Number(head[2]);
      const body = buf.subarray(pos, pos + size);
      pos += size + 1;
      if (body.subarray(0, 8000).includes(0)) {
        out.skipped.binary++;
        continue;
      }
      out.files++;
      for (const f of matchLines(numbered(body.toString('utf8')), b.file)) out.findings.push({ where: 'tree', file: b.file, ...f });
    }
  }
  return out;
}

/**
 * Scan the added lines of the last `depth` commits (or `all`), one commit at a time from a stream.
 * Resolves { findings (raw, with value and the short commit), commits, skipped: { large }, incomplete? }.
 * @param {{ cwd: string, depth?: number, all?: boolean, maxBytes?: number }} o
 * @returns {Promise<object>}
 */
function scanHistory(o) {
  const maxBytes = Number(o.maxBytes) > 0 ? Number(o.maxBytes) : DEFAULTS.maxBytes;
  const depth = Number(o.depth) > 0 ? Number(o.depth) : DEFAULTS.historyDepth;
  const out = { findings: [], commits: 0, skipped: { large: 0 } };
  const args = ['-C', o.cwd, '-c', 'core.quotepath=off', 'log', '-p', '--no-merges', '--format=commit %H', '--no-color', '--no-ext-diff', '--no-textconv', '--unified=0'];
  if (!o.all) args.push('-n', String(depth));
  args.push('HEAD');
  return new Promise((resolve) => {
    if (spawnSync('git', ['-C', o.cwd, 'rev-parse', '-q', '--verify', 'HEAD^{commit}'], { stdio: 'ignore', windowsHide: true }).status !== 0) {
      resolve({ ...out, incomplete: 'no commit yet' });
      return;
    }
    const child = spawn('git', args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let chunk = [];
    let bytes = 0;
    let over = false;
    const flush = () => {
      if (!chunk.length) return;
      if (over) out.skipped.large++;
      else {
        const lines = SS.addedLines(chunk.join('\n'));
        // Per file, so the line after a private key header is taken from the same file.
        const byFile = new Map();
        for (const l of lines) byFile.set(l.file, [...(byFile.get(l.file) ?? []), l]);
        for (const [file, ls] of byFile)
          for (const f of matchLines(ls, file)) out.findings.push({ where: 'history', file, commit: ls[0].commit, ...f });
      }
      chunk = [];
      bytes = 0;
      over = false;
    };
    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (l) => {
      if (/^commit [0-9a-f]{40,64}$/.test(l)) {
        flush();
        out.commits++;
      }
      if (over) return;
      bytes += l.length + 1;
      if (bytes > maxBytes) {
        over = true;
        chunk = [chunk[0]];
        return;
      }
      chunk.push(l);
    });
    let failed = null;
    child.on('error', () => {
      failed = 'git could not be started';
    });
    child.on('close', (code) => {
      flush();
      if (failed || code !== 0) resolve({ ...out, incomplete: failed ?? 'git could not read the history' });
      else resolve(out);
    });
  });
}

/** The salted hash of a value: 16 hex characters. */
function hashOf(value, salt) {
  return crypto.createHmac('sha256', String(salt)).update(String(value)).digest('hex').slice(0, 16);
}

/** At most the first and last two characters, for a value of 12 characters or more; otherwise null. */
function previewOf(value) {
  const v = String(value ?? '');
  return v.length >= 12 ? `${v.slice(0, 2)}...${v.slice(-2)}` : null;
}

/**
 * The raw findings of both scans as stored findings: the value becomes a hash and a short preview, and is dropped.
 * A key in the history is one finding per file and key (the oldest commit that added it, with how many did), marked
 * inTree when the same key is still in a tracked file.
 * @param {object[]} raw
 * @param {{ salt: string }} o
 */
function finalize(raw, { salt }) {
  const tree = [];
  const history = new Map();
  for (const r of raw) {
    const f = { where: r.where, file: r.file, line: r.line, rule: r.rule, hash: hashOf(r.value, salt), preview: r.structural ? null : previewOf(r.value) };
    if (r.where === 'tree') tree.push(f);
    else {
      const k = `${f.hash}\0${f.file}`;
      const seen = history.get(k);
      // The log runs newest first: the last one seen is the oldest commit that added it.
      history.set(k, { ...f, commit: r.commit, commits: (seen?.commits ?? 0) + 1 });
    }
  }
  const inTree = new Set(tree.map((f) => f.hash));
  return [...tree, ...[...history.values()].map((f) => ({ ...f, inTree: inTree.has(f.hash) }))];
}

// ---- The files in the data folder ----------------------------------------------------------------------------------

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  require('./stateFile.js').renameWithRetry(tmp, file); // Windows: a reader at the same moment (RNM-1)
}

/** The ignore file: { salt, ignored: [{ hash, at, note? }] }. A missing or broken file reads as empty. */
function readIgnore(folder) {
  const j = readJson(path.join(folder, IGNORE_FILE));
  return { salt: typeof j?.salt === 'string' && j.salt ? j.salt : null, ignored: Array.isArray(j?.ignored) ? j.ignored.filter((x) => HASH.test(x?.hash)) : [] };
}

/** The salt of this data folder, made once (random) and kept in the ignore file. */
function ensureSalt(folder) {
  const cur = readIgnore(folder);
  if (cur.salt) return cur.salt;
  const salt = crypto.randomBytes(16).toString('hex');
  writeJson(path.join(folder, IGNORE_FILE), { version: 1, salt, ignored: cur.ignored });
  return salt;
}

/** The hashes set aside as false alarms. */
function ignoredSet(folder) {
  return new Set(readIgnore(folder).ignored.map((x) => x.hash));
}

/** Sets a hash aside as a false alarm. False when it already was. */
function addIgnore(folder, hash, { note = null, now = new Date() } = {}) {
  if (!HASH.test(hash)) throw new Error('not a scan hash (16 hex characters)');
  const salt = ensureSalt(folder);
  const cur = readIgnore(folder);
  if (cur.ignored.some((x) => x.hash === hash)) return false;
  const entry = { hash, at: now.toISOString(), ...(note ? { note: String(note).slice(0, 200) } : {}) };
  writeJson(path.join(folder, IGNORE_FILE), { version: 1, salt, ignored: [...cur.ignored, entry] });
  return true;
}

/** Brings a hash back. False when it was not set aside. */
function removeIgnore(folder, hash) {
  const cur = readIgnore(folder);
  if (!cur.ignored.some((x) => x.hash === hash)) return false;
  writeJson(path.join(folder, IGNORE_FILE), { version: 1, salt: cur.salt ?? ensureSalt(folder), ignored: cur.ignored.filter((x) => x.hash !== hash) });
  return true;
}

const readResult = (folder) => {
  const j = readJson(path.join(folder, RESULT_FILE));
  return j && Array.isArray(j.findings) ? j : null;
};
const writeResult = (folder, result) => writeJson(path.join(folder, RESULT_FILE), result);

// ---- What the last scan says ---------------------------------------------------------------------------------------

/** The age as text: today, 1 day ago, n days ago. */
const ageText = (d) => (d == null ? 'at an unknown time' : d <= 0 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago`);

/**
 * The last scan in numbers: { ageDays, open, tree, historyOnly, ignored, due, history }. open counts the keys in
 * tracked files plus the ones only in the history; one in both is counted once (in the tree).
 */
function summary(result, { ignored = new Set(), now = Date.now(), rescanDays = DEFAULTS.rescanDays } = {}) {
  if (!result) return null;
  const t = Date.parse(result.scannedAt);
  const ageDays = Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 86_400_000)) : null;
  const findings = Array.isArray(result.findings) ? result.findings : [];
  const open = findings.filter((f) => !ignored.has(f.hash));
  const tree = open.filter((f) => f.where === 'tree').length;
  const historyOnly = open.filter((f) => f.where === 'history' && !f.inTree).length;
  return {
    ageDays,
    open: tree + historyOnly,
    tree,
    historyOnly,
    ignored: findings.length - open.length,
    due: rescanDays > 0 && (ageDays == null || ageDays >= rescanDays),
    history: result.history ?? null,
  };
}

/** What was scanned, as a short phrase: "tracked files and the last 200 commits". */
function scopeText(result) {
  const h = result?.history;
  if (!h) return 'tracked files only';
  return h.depth === 'all' ? `tracked files and all ${h.commits} commits` : `tracked files and the last ${h.commits} commits`;
}

/** The suggested actions for open findings, never a value. */
function actionText(cli) {
  return (
    `${cli} secrets scan lists them (file, line or commit, rule, hash; never the value). A real key: change (rotate) it ` +
    'where it was issued, then take it out of the code. One in the history stays readable in every clone after the ' +
    `file is gone: rotate it, and purge the history by hand if you must (git filter-repo, ${PURGE_DOCS}); Ravenseat never ` +
    `rewrites it. A false alarm: ${cli} secrets ignore <hash>.`
  );
}

/**
 * doctor's row from the stored result (never a scan): INFO when never run (unless rescanDays is 0), WARN with open
 * findings, INFO when older than rescanDays, else OK.
 */
function doctorRows({ result, ignored = new Set(), now = Date.now(), rescanDays = DEFAULTS.rescanDays, cli = 'ravenseat' }) {
  const row = (status, message, fix = null) => ({ status, name: 'keyscan', message, fix });
  if (!result) {
    if (rescanDays <= 0) return [];
    return [
      row(
        'INFO',
        'The tracked files and the git history have never been scanned for keys (the push check sees only what a push sends).',
        `${cli} secrets scan --history (reads only; it changes no file and no commit)`,
      ),
    ];
  }
  const s = summary(result, { ignored, now, rescanDays });
  const when = `last scan ${ageText(s.ageDays)}, ${scopeText(result)}`;
  const aside = s.ignored ? `, ${s.ignored} set aside as false alarms` : '';
  if (s.open)
    return [row('WARN', `${s.open} possible key(s) in the repo (${when}): ${s.tree} in tracked files, ${s.historyOnly} only in the history${aside}.`, actionText(cli))];
  if (s.due)
    return [row('INFO', `The key scan is ${ageText(s.ageDays)} old (secretScan.rescanDays is ${rescanDays}); nothing was open then.`, `${cli} secrets scan --history`)];
  return [row('OK', `Nothing open in the key scan (${when}${aside}).`)];
}

module.exports = {
  RESULT_FILE,
  IGNORE_FILE,
  DEFAULTS,
  PURGE_DOCS,
  HASH,
  setupOf,
  setupProblems,
  scanTracked,
  scanHistory,
  finalize,
  hashOf,
  previewOf,
  readIgnore,
  ensureSalt,
  ignoredSet,
  addIgnore,
  removeIgnore,
  readResult,
  writeResult,
  summary,
  ageText,
  scopeText,
  actionText,
  doctorRows,
};
