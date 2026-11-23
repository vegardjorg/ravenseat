// =============================================================
// cli/secrets.mjs: `ravenseat secrets clean`, removes the approved commands that hold a key (H1, S5), and `secrets scan`,
// keys in the tracked files and the history (roadmap 6b).
//
//   ravenseat secrets clean [--dry-run] [--yes]
//        Finds the rules in permissions.allow, ask and deny of .claude/settings.json and .claude/settings.local.json (main
//        tree and every worktree git lists, also outside the main tree) that lib/allowlistSecrets.js finds a key in
//        (ruleOf: the patterns and the password-flag rule), the same reading as `ravenseat doctor`.
//        --dry-run: names each one as <file>: permissions.allow[3] (rule id) and changes nothing.
//        Without --yes: the same list, nothing changed, exit 1.
//        --yes: copies each file to <dataFolder>/secrets-backup/<time>/ first (ignored by git with the data folder), then
//        removes those rules and writes the file back with its own indentation and line endings.
// The rule text and the value are NEVER printed or logged: only the file, the list, the index and the pattern's id.
// WHY a copy: the rule may be one the owner still needs in another form; the copy keeps it until they have moved the key
// to an environment variable or a password manager (and the copy holds the key, so it is said to delete it then).
// Removing a rule does not change the key: one in a file git tracks is in the history, and must be changed.
//
//   ravenseat secrets scan [--history [N] | --all-history] [--json]
//        Scans every file git tracks (HEAD; binaries and files over secretScan.maxBytes skipped and counted) and, with
//        --history, the added lines of the last N commits (default secretScan.historyDepth, 200), or of every commit with
//        --all-history, with the push check's rules (lib/repoSecretScan.js on lib/secretScan.js matchValue). Each finding is
//        file:line (a commit too in the history), the rule, at most the first and last two characters and a salted hash:
//        NEVER the value. Saved in <dataFolder>/secret-scan.json; exit 1 while a finding is open. Reports only: it never
//        changes a file or rewrites the history (the text says to rotate the key and how to purge by hand).
//   ravenseat secrets ignore <hash> [--note <text>] | unignore <hash>
//        A false alarm by its hash, in <dataFolder>/secret-scan-ignore.json (with the salt); the scan and doctor leave it
//        out of the open count.
// doctor's row keyscan (doctorKeyScan) reads the last result only and never scans (the tracked scan took 1.3 to 1.7 s
// on Ravenseat's own 1105 files, most of a 2 s budget, and grows with the repo).
// Refused from a track worktree; the push guard denies `secrets` to queue agents (not in AGENT_QUEUE_COMMANDS).
//
// Used by: queue.mjs, cli/doctor.mjs (doctorKeyScan). Tested in: __tests__/secretsCleanCli.test.ts,
// __tests__/secretsScanCli.test.ts.
// =============================================================

import fs from 'node:fs';
import path from 'node:path';

import { a, CLI, CONFIG, die, FOLDER, GIT_ROOT, MAIN_TREE, require, TIME_LOG } from './context.mjs';
import { trackBranchHere } from './settings.mjs';

const AS = require('./lib/allowlistSecrets.js');

/** The indentation of a JSON text (the first indented line), default two spaces. */
function indentOf(text) {
  const m = /\n([ \t]+)\S/.exec(text);
  return m ? m[1] : 2;
}

/**
 * The file's text without the rules that hold a key (found again in this very text, so an index never points at a rule
 * that moved). Returns { text, removed } or null when nothing is left to remove or the file is not JSON.
 */
function cleaned(text, file) {
  let json;
  try {
    json = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return null;
  }
  const p = json?.permissions;
  if (!p || typeof p !== 'object') return null;
  let removed = 0;
  for (const list of AS.LISTS) {
    if (!Array.isArray(p[list])) continue;
    // The same reading as the scan (lib/allowlistSecrets.js ruleOf: the patterns, then the password-flag rule).
    const keep = p[list].filter((rule) => !(typeof rule === 'string' && AS.ruleOf(rule, file)));
    removed += p[list].length - keep.length;
    p[list] = keep;
  }
  if (!removed) return null;
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const out = JSON.stringify(json, null, indentOf(text)).replace(/\n/g, eol) + (/\r?\n$/.test(text) ? eol : '');
  return { text: (text.startsWith('﻿') ? '﻿' : '') + out, removed };
}

function clean() {
  const hits = AS.scanTrees(MAIN_TREE);
  if (!hits.length) {
    console.log('No approved command with a key in it (permissions in .claude/settings*.json, also the agents\' worktrees). Nothing to do.');
    return;
  }
  const lines = hits.map((h) => `  ${AS.where(h)}`);
  const files = [...new Set(hits.map((h) => h.file))];
  if (a.includes('--dry-run')) {
    console.log(`Would remove ${hits.length} rule(s) from ${files.length} file(s), after a copy in ${path.join(FOLDER, 'secrets-backup')}:\n${lines.join('\n')}\nNothing was changed.`);
    return;
  }
  if (!a.includes('--yes'))
    die(
      `${hits.length} approved command(s) hold a key:\n${lines.join('\n')}\n` +
        `${CLI} secrets clean --yes removes them, after a copy of each file in ${path.join(FOLDER, 'secrets-backup')}. Nothing was changed.`,
    );
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(FOLDER, 'secrets-backup', stamp);
  let total = 0;
  for (const file of files) {
    // The hit's own absolute path: a worktree outside the main tree is named by its absolute path (lib/allowlistSecrets.js).
    const abs = hits.find((h) => h.file === file)?.abs ?? path.resolve(MAIN_TREE, ...file.split('/'));
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch (e) {
      console.log(`  ${file}: could not read it (${e.code ?? e.message}); left as it is.`);
      continue;
    }
    const next = cleaned(text, file);
    if (!next) continue;
    // The copy first: without it nothing is changed in this file.
    try {
      fs.mkdirSync(backup, { recursive: true });
      fs.writeFileSync(path.join(backup, file.replace(/[\\/:]/g, '__')), text);
    } catch (e) {
      die(`secrets clean: could not copy ${file} to ${backup} (${e.message}). ${file} was not changed.`);
    }
    fs.writeFileSync(abs, next.text);
    total += next.removed;
    console.log(`  ${file}: removed ${next.removed} rule(s)`);
  }
  try {
    require('./lib/timeLogArchive.js').appendText(TIME_LOG, `${JSON.stringify({ time: new Date().toISOString(), event: 'secrets-clean', removed: total, files, by: 'owner' })}\n`);
  } catch {
    // error-ignored: the files are cleaned; the row is a record
  }
  console.log(
    `Removed ${total} rule(s). The copies are in ${backup} (ignored by git; they hold the keys, so delete them once the keys are changed). ` +
      'Change each key that was there: a file git tracks keeps it in its history. Pass keys as an environment variable or from a password manager instead.',
  );
}

// ---- `ravenseat secrets scan`: keys in the tracked files and the history (roadmap 6b, lib/repoSecretScan.js) ----------

/** One time log row, counts only (never a value or a file). An error is not the scan's failure. */
function logRow(row) {
  try {
    require('./lib/timeLogArchive.js').appendText(TIME_LOG, `${JSON.stringify({ time: new Date().toISOString(), ...row, by: 'owner' })}\n`);
  } catch {
    // error-ignored: the result is saved; the row is a record
  }
}

/** The history part of the arguments: null (none), { all: true } or { depth }. A bad number is refused. */
function historyArg(setup) {
  if (a.includes('--all-history')) return { all: true };
  const i = a.indexOf('--history');
  if (i < 0) return null;
  const n = a[i + 1];
  if (n === undefined || n.startsWith('--')) return { depth: setup.historyDepth };
  if (!/^[1-9]\d*$/.test(n)) die(`--history takes a whole number of commits > 0 (got ${JSON.stringify(n)}). Nothing was scanned.`);
  return { depth: Number(n) };
}

/** One finding as a line: where, rule, preview, hash. Never the value. */
function findingLine(f, sinceCommit) {
  const where = f.where === 'history' ? `${f.commit} ${f.file}:${f.line}` : `${f.file}:${f.line}`;
  const since = sinceCommit ? `  (in the history since ${sinceCommit})` : '';
  const many = f.where === 'history' && f.commits > 1 ? `  (added in ${f.commits} commits)` : '';
  return `  ${where}  ${f.rule}  ${f.preview ?? '-'}  #${f.hash}${since}${many}`;
}

async function scan() {
  const RS = require('./lib/repoSecretScan.js');
  const json = a.includes('--json');
  const setup = RS.setupOf(CONFIG);
  const hist = historyArg(setup);
  const t0 = Date.now();
  const tree = RS.scanTracked({ cwd: GIT_ROOT, maxBytes: setup.maxBytes });
  const t1 = Date.now();
  const history = hist ? await RS.scanHistory({ cwd: GIT_ROOT, maxBytes: setup.maxBytes, ...hist }) : null;
  const t2 = Date.now();
  const salt = RS.ensureSalt(FOLDER);
  const findings = RS.finalize([...tree.findings, ...(history?.findings ?? [])], { salt });
  const result = {
    version: 1,
    scannedAt: new Date().toISOString(),
    scanner: 'built-in',
    ms: { tracked: t1 - t0, ...(history ? { history: t2 - t1 } : {}) },
    tracked: { files: tree.files, skipped: tree.skipped, ...(tree.incomplete ? { incomplete: tree.incomplete } : {}) },
    history: history
      ? { depth: hist.all ? 'all' : hist.depth, commits: history.commits, skipped: history.skipped, ...(history.incomplete ? { incomplete: history.incomplete } : {}) }
      : null,
    findings,
  };
  RS.writeResult(FOLDER, result);
  const ignored = RS.ignoredSet(FOLDER);
  const s = RS.summary(result, { ignored, rescanDays: setup.rescanDays });
  logRow({ event: 'secrets-scan', open: s.open, tree: s.tree, historyOnly: s.historyOnly, ignored: s.ignored, history: result.history?.depth ?? null });
  const open = findings.filter((f) => !ignored.has(f.hash));
  if (json) {
    console.log(JSON.stringify({ ...result, open: s.open, ignoredCount: s.ignored, findings: findings.map((f) => ({ ...f, ignored: ignored.has(f.hash) })) }, null, 2));
  } else {
    const out = [`Key scan of the ${RS.scopeText(result)} (the push check's rules; a value is never shown or stored):`];
    const inTree = open.filter((f) => f.where === 'tree');
    const onlyHistory = open.filter((f) => f.where === 'history' && !f.inTree);
    const since = (f) => open.find((h) => h.where === 'history' && h.hash === f.hash && h.file === f.file)?.commit ?? null;
    if (inTree.length) out.push('In the tracked files:', ...inTree.map((f) => findingLine(f, since(f))));
    if (onlyHistory.length) out.push('Only in the history (the file no longer holds it, every clone still does):', ...onlyHistory.map((f) => findingLine(f)));
    if (!open.length) out.push('  Nothing open.');
    const skip = [];
    if (tree.skipped.binary) skip.push(`${tree.skipped.binary} binary file(s)`);
    if (tree.skipped.large) skip.push(`${tree.skipped.large} file(s) over secretScan.maxBytes`);
    if (history?.skipped.large) skip.push(`${history.skipped.large} commit(s) over secretScan.maxBytes`);
    if (skip.length) out.push(`Not read: ${skip.join(', ')}.`);
    for (const why of [tree.incomplete, history?.incomplete].filter(Boolean)) out.push(`Incomplete: ${why}.`);
    out.push(`${s.open} open${s.ignored ? `, ${s.ignored} set aside as false alarms` : ''}. Saved in ${path.join(FOLDER, RS.RESULT_FILE)} (ignored by git).`);
    if (open.length) out.push(`What to do: ${RS.actionText(CLI)}`);
    if (!hist) out.push(`The history was not read: ${CLI} secrets scan --history (the last ${setup.historyDepth} commits) or --all-history.`);
    console.log(out.join('\n'));
  }
  if (s.open) process.exit(1);
}

/** `ravenseat secrets ignore|unignore <hash> [--note <text>]`: a false alarm by its hash, remembered in the data folder. */
function ignore(add) {
  const RS = require('./lib/repoSecretScan.js');
  const hash = String(a[2] ?? '').replace(/^#/, '');
  if (!RS.HASH.test(hash)) die(`Use: ${CLI} secrets ${add ? 'ignore' : 'unignore'} <hash> (the 16 hex characters after # in ${CLI} secrets scan). Nothing was changed.`);
  const i = a.indexOf('--note');
  const note = i > 0 ? a[i + 1] : null;
  const known = (RS.readResult(FOLDER)?.findings ?? []).some((f) => f.hash === hash);
  const changed = add ? RS.addIgnore(FOLDER, hash, { note }) : RS.removeIgnore(FOLDER, hash);
  if (changed) logRow({ event: add ? 'secrets-ignore' : 'secrets-unignore', hash });
  const unknown = known ? '' : ' (the last scan has no finding with it; it applies when one shows up)';
  if (add) console.log(changed ? `Set aside as a false alarm: #${hash}${unknown}. ${CLI} secrets unignore ${hash} brings it back.` : `#${hash} was already set aside.`);
  else console.log(changed ? `#${hash} counts again from the next ${CLI} secrets scan or doctor.` : `#${hash} was not set aside. Nothing was changed.`);
}

/** doctor's keyscan row (cli/doctor.mjs): the last scan from its file, never a scan (a read of two small files). */
export function doctorKeyScan() {
  const RS = require('./lib/repoSecretScan.js');
  return RS.doctorRows({ result: RS.readResult(FOLDER), ignored: RS.ignoredSet(FOLDER), rescanDays: RS.setupOf(CONFIG).rescanDays, cli: CLI });
}

const USAGE = `${CLI} secrets clean [--dry-run] [--yes] | scan [--history [N] | --all-history] [--json] | ignore <hash> [--note <text>] | unignore <hash>`;

/** `ravenseat secrets ...` (the usage is at the top of queue.mjs). */
export async function cmdSecrets() {
  const sub = a[1];
  if (!['clean', 'scan', 'ignore', 'unignore'].includes(sub)) return die(`Use: ${USAGE}`);
  const track = trackBranchHere();
  if (track) die(`${CLI} secrets ${sub} cannot be run from inside a track worktree (branch ${track}); ask the owner. Nothing was changed.`);
  if (sub === 'scan') return scan();
  if (sub === 'ignore' || sub === 'unignore') return ignore(sub === 'ignore');
  return clean();
}
