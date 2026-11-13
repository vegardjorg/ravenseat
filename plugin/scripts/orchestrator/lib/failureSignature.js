// =============================================================
// failureSignature.js: a red gate run or a red CI job as a stable signature, so the same failure seen many times is
// counted as one thing (the inspection queue, lib/inspection.js).
//
// Why: a failure that comes back is handled once, alone, every time, and the pattern is never seen. One large user had
// 13 of 22 red CI runs from the same secret scan, and hundreds of local timeouts with the same shape. Counting them needs
// a key that is the same for the same failure in another worktree, on another commit, at another time.
//
// The signature is the gate command (or the CI job "ci: <workflow> / <job> / <step>") plus a normalized excerpt of the
// first error line (orchestratorHelp.firstErrorLine, the line the gate output already shows). Normalizing removes what
// changes from run to run and says nothing about the failure:
//   - secrets first (lib/askBundle.js redact, the secret scan's patterns), so nothing that looks like one is ever kept;
//   - colors, backslashes (Windows paths become /), the given roots (the worktree or project folder);
//   - paths under a worktree (.claude/worktrees/<name>/ and any /worktrees/<name>/) become relative;
//   - paths under a temp folder become <tmp>; other absolute folders are dropped (the file name stays);
//   - ISO times and clock times <time>, dates <date>, uuids <id>, shas <sha> (7-40 hex with a digit and a letter),
//     line:col <line>:<col>, durations <dur>, and any other free-standing number <n>. A number glued to letters stays
//     (TS2345, ES2022), so error codes still tell failures apart.
// A timeout is "timed out" whatever was printed before the budget ran out. The excerpt is at most EXCERPT_MAX
// characters, and it is the only text of the output a row keeps.
//
// Pure functions (node:crypto for the id only). Tested in lib/__tests__/failureSignature.test.ts.
// =============================================================
'use strict';

const crypto = require('node:crypto');
const { redact } = require('./askBundle.js');
const { firstErrorLine, gateType } = require('./orchestratorHelp.js');

/** The longest excerpt kept. */
const EXCERPT_MAX = 200;
/** The excerpt of every timeout. */
const TIMEOUT = 'timed out';
/** Conclusions of a CI job or step that are not red. */
const GREEN = new Set(['success', 'skipped', 'neutral', '']);

/** A color code: the escape character, or the two characters "^[" that gh run view --log-failed writes for it. */
const ANSI = /(?:\u001b|\^\[)\[[0-9;]*[A-Za-z]/g;

const STOP = `\\s'"()<>\\[\\],;`;

/** The normalized form of one line (see the header). Normalizing twice gives the same text. */
function normalize(line, { roots = [] } = {}) {
  let s = redact(String(line ?? '')).text;
  s = s.replace(ANSI, '').replace(/\\/g, '/');
  for (const r of roots ?? []) {
    const root = String(r ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
    if (root) s = s.split(`${root}/`).join('').split(root).join('');
  }
  // A path inside a worktree: keep the part inside it.
  s = s.replace(new RegExp(`(?:[A-Za-z]:)?[^${STOP}]*?/worktrees/[^/${STOP}]+/`, 'g'), '');
  // A path under a temp folder (also macOS /var/folders/../T/): all of it.
  s = s.replace(new RegExp(`(?:[A-Za-z]:)?(?:/[^/${STOP}:]+)*/(?:tmp|temp|T)/[^${STOP}:]*`, 'gi'), '<tmp>');
  // Any other absolute folder: dropped, the file name stays.
  s = s.replace(new RegExp(`(?:\\b[A-Za-z]:)?(?<![\\w.<>-])/(?:[^/${STOP}:]+/)+(?=[^/${STOP}:]+)`, 'g'), '');
  s = s.replace(/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<time>');
  s = s.replace(/\b\d{4}-\d{2}-\d{2}\b/g, '<date>');
  s = s.replace(/\b\d{1,2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<time>');
  s = s.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<id>');
  s = s.replace(/\b[0-9a-f]{7,40}\b/gi, (m) => (/\d/.test(m) && /[a-f]/i.test(m) ? '<sha>' : m));
  s = s.replace(/:\d+:\d+\b/g, ':<line>:<col>').replace(/\(\d+,\d+\)/g, '(<line>,<col>)').replace(/:\d+\b/g, ':<line>');
  s = s.replace(/\b\d+(?:\.\d+)?\s?(?:ms|s|sec|secs|seconds|m|min|mins|minutes|h)\b/g, '<dur>');
  s = s.replace(/\b\d+(?:\.\d+)?\b/g, '<n>');
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > EXCERPT_MAX ? `${s.slice(0, EXCERPT_MAX - 1)}…` : s;
}

/** The stable id of a signature: the first 12 hex of sha1(name + newline + excerpt). */
function signatureId(name, excerpt) {
  return crypto.createHash('sha1').update(`${String(name ?? '').trim()}\n${String(excerpt ?? '')}`).digest('hex').slice(0, 12);
}

/**
 * The excerpt of one red gate command's output: "timed out" for a timeout, else the first error line, normalized. The
 * whole output is redacted before the line is picked, so a cut never leaves half a secret.
 * @param {{ command: string, output: string, timedOut?: boolean, roots?: string[] }} x
 */
function gateExcerpt({ command, output, timedOut = false, roots = [] }) {
  if (timedOut) return TIMEOUT;
  const text = redact(String(output ?? '')).text;
  return normalize(firstErrorLine(gateType(command), text, null), { roots });
}

/** One line of `gh run view --log-failed` without its "<job>\t<step>\t<time> " prefix. */
function logText(line) {
  const parts = String(line).split('\t');
  const text = parts.length >= 3 ? parts.slice(2).join('\t') : line;
  return String(text).replace(/^﻿?\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/, '');
}

/** The excerpt of a CI log: the first ##[error] line that is not the generic exit line, else the first error line. */
function ciExcerpt(log) {
  const lines = redact(String(log ?? '')).text.split(/\r?\n/).map(logText);
  const marked = lines.find((l) => /##\[error\]/.test(l) && !/Process completed with exit code/i.test(l));
  // A test runner's ##[error] line is often only the assertion ("expected false to be true"), the same for many tests,
  // so the first FAIL line naming the test file goes in front of it when the log has one.
  const plain = (l) => l.replace(ANSI, '').trim();
  const fail = lines.map(plain).find((l) => /^FAIL\s+\S+\.(?:test|spec)\.[cm]?[jt]sx?\b/.test(l));
  if (marked && fail) return normalize(`${fail}: ${plain(marked).replace(/^##\[error\]/, '')}`);
  return normalize(marked ?? firstErrorLine('test', lines.join('\n'), null));
}

/** A job name without its matrix values ("test (ubuntu-latest, node 20)" is "test"): the same failure is one failure. */
function jobBase(name) {
  return String(name ?? '').replace(/\s*\([^()]*\)\s*$/, '').trim() || String(name ?? '');
}

/**
 * The failures of one red CI run that failed on a check: one per failed job, named "ci: <workflow> / <job> / <step>"
 * (the first failed step), with the excerpt of that job's lines in the failed log. Without the jobs, one for the run.
 * @param {{ run: object, jobs?: object[]|null, log?: string }} x
 * @returns {{ name: string, excerpt: string }[]}
 */
function ciFailures({ run, jobs = null, log = '' }) {
  const workflow = String(run?.workflowName ?? run?.name ?? 'workflow').trim();
  const failed = (Array.isArray(jobs) ? jobs : []).filter((j) => j && !GREEN.has(String(j.conclusion ?? '')));
  if (!failed.length) return [{ name: `ci: ${workflow}`, excerpt: ciExcerpt(log) }];
  const lines = String(log ?? '').split(/\r?\n/);
  const out = new Map();
  for (const j of failed) {
    const step = (Array.isArray(j.steps) ? j.steps : []).find((s) => s && !GREEN.has(String(s.conclusion ?? '')));
    const own = lines.filter((l) => l.split('\t')[0] === j.name);
    const f = {
      name: `ci: ${workflow} / ${jobBase(j.name)}${step?.name ? ` / ${step.name}` : ''}`,
      excerpt: ciExcerpt((own.length ? own : lines).join('\n')),
    };
    // Matrix jobs with the same failure give it once; a different failure on one platform stays its own.
    out.set(`${f.name}\n${f.excerpt}`, f);
  }
  return [...out.values()];
}

/**
 * The occurrences in one gate row of the time log (lib/timeLogRows.js gateRow): one per failed command. The incident
 * says what one occurrence belongs to: the task, or without one the branch and the day, so a track's reruns of the same
 * red gate are one incident (the inspection queue's threshold counts incidents).
 */
function fromGateRow(row) {
  if (row?.event !== 'gate' || !Array.isArray(row.failed) || !row.failed.length) return [];
  const day = String(row.time ?? '').slice(0, 10);
  const incident = row.track ? `task ${row.track}` : `${row.branch ?? 'unknown branch'} ${day}`;
  return row.failed
    .filter((c) => typeof c === 'string' && c.trim())
    .map((name) => {
      const raw = row.errors?.[name];
      const excerpt = typeof raw === 'string' ? normalize(raw) : '';
      return { id: signatureId(name, excerpt), source: 'gate', name, excerpt, time: row.time ?? null, task: row.track ?? null, incident };
    });
}

/** The occurrences in one CI watch row (lib/eventRows.js ciWatchRow) with failures; the commit is the incident. */
function fromCiRow(row) {
  if (row?.event !== 'ciWatch' || !Array.isArray(row.failures)) return [];
  return row.failures
    .filter((f) => f && typeof f.name === 'string' && f.name.trim())
    .map((f) => {
      const excerpt = typeof f.excerpt === 'string' ? normalize(f.excerpt) : '';
      return { id: signatureId(f.name, excerpt), source: 'ci', name: f.name, excerpt, time: row.time ?? null, task: row.task ?? null, incident: `commit ${row.sha ?? '?'}` };
    });
}

/** All occurrences in the time log rows (gate and ciWatch rows; others are skipped). */
function occurrences(rows) {
  const out = [];
  for (const r of rows ?? []) {
    if (r?.event === 'gate') out.push(...fromGateRow(r));
    else if (r?.event === 'ciWatch') out.push(...fromCiRow(r));
  }
  return out;
}

/** The gate and ciWatch rows from the time log text; other rows and broken lines are skipped. */
function rowsFromText(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.includes('"gate"') && !line.includes('"ciWatch"')) continue; // cheap skip before JSON.parse
    try {
      const r = JSON.parse(line);
      if (r?.event === 'gate' || r?.event === 'ciWatch') out.push(r);
    } catch {
      // error-ignored: a half-written line; the rest of the log still counts
    }
  }
  return out;
}

module.exports = {
  EXCERPT_MAX,
  TIMEOUT,
  normalize,
  signatureId,
  gateExcerpt,
  ciExcerpt,
  ciFailures,
  fromGateRow,
  fromCiRow,
  occurrences,
  rowsFromText,
};
