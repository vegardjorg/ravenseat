// =============================================================
// redOnBase.js: "red on base", a check that the track's new or changed tests show its change works.
//
// Why: the mission asks for red first (a test that fails before the fix and passes after), but that was only what the
// track said in its report. A test that passes with or without the change shows nothing about the change; it is green
// but proves nothing. This is the FAIL_TO_PASS idea from SWE-bench: run the new tests on the old code, and they must fail.
//
// How (cli/merge.mjs redOnBaseCheck, at receive, after the quick gates are green):
//   1. The track's new or changed test files (testWeakening.isTestFile, plus testWeakening.testPaths) run on the
//      delivered tip with the configured command. They must pass; red there is "tip-red".
//   2. In the same worktree, the track's other changes are taken away (files it changed or deleted get their merge-base
//      version, files it added are removed), the test files stay as the track wrote them, and each test file runs on its
//      own (at most maxFiles). At least one must fail: "proven". All green: "unproven".
//   3. The worktree is put back with `git reset --hard HEAD` (receive has checked it was clean at the tip, so only the
//      check's own changes are undone; untracked files are left alone), then checked: same HEAD, nothing changed.
// A test that fails on the base because the module it imports is new counts as red: the change is what it needs.
//
// Only a warning, never a stop: a task that only adds tests, or refactors under existing tests, is right to have no
// failing test on the base. The receive line and the "Red on base" section in 00-package.md tell the reviewers.
// Only the verdict and the file names are kept (task field red_on_base), never the test output.
//
// Off by default. queue.config.json: gates.redOnBase = "<command>" (the files go where {files} is, else at the end), or
// { command, timeoutSec, maxFiles }. Ravenseat does not know a project's test runner, so the owner names it.
//
// Pure, no I/O; cli/merge.mjs runs the commands. Tested in lib/__tests__/redOnBase.test.ts and
// __tests__/redteam/redOnBase-cli.test.ts.
// =============================================================
'use strict';

const TW = require('./testWeakening.js');

const DEFAULT_TIMEOUT_SEC = 300;
const DEFAULT_MAX_FILES = 10;
/** Characters a shell could read as code or a variable inside double quotes (cmd.exe and sh): such a path never runs. */
const UNSAFE = /["$`%!\r\n\\]/;

const posInt = (x) => Number.isInteger(x) && x > 0;

/** The setting from config().gates, or null when it is off. */
function setup(gates = {}) {
  const v = gates?.redOnBase;
  if (typeof v === 'string' && v.trim()) return { command: v.trim(), timeoutSec: DEFAULT_TIMEOUT_SEC, maxFiles: DEFAULT_MAX_FILES };
  if (v && typeof v === 'object' && typeof v.command === 'string' && v.command.trim())
    return {
      command: v.command.trim(),
      timeoutSec: posInt(v.timeoutSec) ? v.timeoutSec : DEFAULT_TIMEOUT_SEC,
      maxFiles: posInt(v.maxFiles) ? v.maxFiles : DEFAULT_MAX_FILES,
    };
  return null;
}

/** What doctor says about a wrong gates.redOnBase. */
function setupProblems(v) {
  if (v === undefined || v === null) return [];
  const msg = 'gates.redOnBase must be a test command (text), { command, timeoutSec, maxFiles } or null';
  if (typeof v === 'string') return v.trim() ? [] : [msg];
  if (typeof v !== 'object' || Array.isArray(v)) return [msg];
  if (typeof v.command !== 'string' || !v.command.trim()) return [msg];
  for (const k of ['timeoutSec', 'maxFiles']) if (v[k] !== undefined && !posInt(v[k])) return [`gates.redOnBase.${k} must be a whole number > 0`];
  return [];
}

/**
 * The track's changes from `git diff --name-status --no-renames <base>...<branch>`: the test files to run (added or
 * changed), the rest (the change taken away on the base) and test paths never run because the shell could misread them.
 * A deleted test file is in neither list: it cannot run, and testWeakening already reports it.
 */
function split(nameStatus, extraTestPaths = []) {
  const tests = [];
  const code = [];
  const unsafe = [];
  for (const line of String(nameStatus ?? '').split(/\r?\n/)) {
    const [st, ...rest] = line.split('\t');
    const p = rest.join('\t').trim().replace(/\\/g, '/');
    const status = (st ?? '').trim().charAt(0);
    if (!p || !['A', 'M', 'D', 'T'].includes(status)) continue;
    if (TW.isTestFile(p, extraTestPaths)) {
      if (status === 'D') continue;
      if (UNSAFE.test(p)) unsafe.push(p);
      else tests.push(p);
    } else code.push({ path: p, status: status === 'T' ? 'M' : status });
  }
  return { tests, code, unsafe };
}

/** The command line: the quoted files where {files} is, or at the end. */
function commandFor(template, files) {
  const list = files.map((f) => `"${f}"`).join(' ');
  return template.includes('{files}') ? template.split('{files}').join(list) : `${template} ${list}`;
}

/**
 * The verdict.
 * @param {{ tests: string[], code: object[], tip: {ok:boolean}|null, base: {path:string, ok:boolean}[] }} r
 * @returns {'no-tests'|'tip-red'|'tests-only'|'proven'|'unproven'}
 */
function verdict({ tests, code, tip, base }) {
  if (!tests?.length) return 'no-tests';
  if (tip && !tip.ok) return 'tip-red';
  if (!code?.length) return 'tests-only';
  return (base ?? []).some((b) => !b.ok) ? 'proven' : 'unproven';
}

const list = (files, n = 5) => files.slice(0, n).join(', ') + (files.length > n ? ', …' : '');

/** The receive line; null when the check is off. */
function summaryLine(id, r) {
  if (!r) return null;
  const files = r.files ?? [];
  const red = files.filter((f) => f.base === 'red');
  switch (r.verdict) {
    case 'proven':
      return `Red on base ${id}: ${red.length} of ${files.length} new or changed test file(s) fail without the change and pass with it.`;
    case 'unproven':
      return (
        `RED ON BASE ${id}: the new or changed tests (${list(files.map((f) => f.path))}) pass without the track's code change too, ` +
        'so they do not show the change works. Read them before you merge (fine for a pure refactor under existing tests).'
      );
    case 'tip-red':
      return `RED ON BASE ${id}: the new or changed tests fail on the delivered tip (${r.command ? `\`${r.command}\`` : 'the redOnBase command'}), so the base was not tried.`;
    case 'no-tests':
      return r.codeChanged
        ? `Red on base ${id}: no test file was added or changed, so nothing shows the change works.`
        : null;
    case 'tests-only':
      return `Red on base ${id}: the track only changed tests, so there is no change to take away.`;
    case 'error':
      return `RED ON BASE ${id}: not checked (${r.reason}).`;
    default:
      return null;
  }
}

/** The "Red on base" section of 00-package.md, as lines. */
function packageSection(r) {
  if (!r) return [];
  const out = ['', '## Red on base', '', `Verdict: ${r.verdict}${r.command ? ` (command \`${r.command}\`)` : ''}.`];
  if (r.reason) out.push(`Reason: ${r.reason}.`);
  for (const f of r.files ?? []) out.push(`- ${f.path}: ${f.base} on the base (the track's code change taken away)`);
  for (const p of r.skipped ?? []) out.push(`- ${p}: not run (over maxFiles, or a path the shell could misread)`);
  if (r.verdict === 'unproven')
    out.push('', 'None of these tests fails without the change. Check that they test what the task changed.');
  return out;
}

module.exports = { DEFAULT_TIMEOUT_SEC, DEFAULT_MAX_FILES, setup, setupProblems, split, commandFor, verdict, summaryLine, packageSection };
