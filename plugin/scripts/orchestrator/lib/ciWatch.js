// =============================================================
// ciWatch.js: the pure parts of the CI watch (`cq push-check --watch-ci <sha>`, cli/ciWatch.mjs).
//
// Why: the local gates are the primary rule (a push needs a green `cq gates --full` on the tip), but the project's CI
// can still go red on what the batch push sent (another OS, a service the local run mocks, a secret only CI has).
// Nothing in the queue noticed that until someone opened GitHub. The CI watch is an OPTIONAL safety net
// (config().push.ciWatch: "off" by default, "github" to turn it on): after a batch push the orchestrator starts it in the
// background, it polls the runs for exactly the pushed commit and exits when they are done.
//
// The verdict (cli/ciWatch.mjs acts on it):
//   green  every run completed with success, skipped or neutral.
//   check  a run failed because a check failed: one fix task CI-<sha7> (value 10, class K, added_by "ci watch", so
//          waiting, as the base fix task), and the base is marked red at that tip the way the base gate does it (with
//          CI-<sha7> as its fix task), so cq merge refuses other tracks until it is fixed.
//   infra  every red run failed for a reason outside the code (cancelled, timed out, a runner that never started or
//          went away, billing): an owner question ci-<sha7>-infra (rerun or ignore). Nothing is frozen.
// Never twice: the task id and the question id are derived from the sha, so a rerun that is red again finds them.
//
// Secrets: only the TAIL of the failed jobs' log is kept (logTail: the last bytes and lines), redacted with the secret
// patterns of lib/secretScan.js (through lib/askBundle.js redact), and it goes only into a report file in the data
// folder. The task's mission and the question name that file and never hold the log itself.
//
// Pure, no I/O. Tested in lib/__tests__/ciWatch.test.ts; the loop in __tests__/queueCiWatch.test.ts.
// =============================================================
'use strict';

const { redact } = require('./askBundle.js');

/** The defaults for config().push.ciWatch* (lib/queueConfig.js STANDARD.push holds the same values). */
const DEFAULTS = Object.freeze({ mode: 'off', intervalSec: 60, timeoutMin: 90 });
const MODES = ['off', 'github'];
/** Minutes without any run for the commit before the watch gives up (no CI for this push). */
const NO_RUNS_MIN = 10;
/** The log tail kept per red run. */
const LOG_BYTES = 8000;
const LOG_LINES = 60;
const LINE_MAX = 400;
/** The fields `gh run list --json` is asked for. */
const RUN_FIELDS = 'databaseId,name,workflowName,status,conclusion,url,attempt,event';
/** Conclusions that are not red. */
const GREEN = new Set(['success', 'skipped', 'neutral']);
/** Conclusions that are infrastructure by themselves. */
const INFRA_CONCLUSION = { cancelled: 'cancelled', timed_out: 'timeout', startup_failure: 'runner', stale: 'cancelled' };
/** Log text that means the failure is not the code's. The order matters: the first hit names the reason. */
const INFRA_LOG = [
  { reason: 'billing', re: /billing|spending limit|account payments have failed|account is locked/i },
  {
    reason: 'runner',
    re: /runner has received a shutdown signal|lost communication with the server|not acquired by runner|no space left on device|hosted runner .*(?:unavailable|failed)|runner .* (?:offline|unavailable)/i,
  },
  { reason: 'timeout', re: /exceeded the maximum execution time|has timed out/i },
  { reason: 'cancelled', re: /the operation was canceled|the run was canceled|was cancelled/i },
];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const short = (sha) => String(sha ?? '').slice(0, 7);
const positive = (v, standard) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : standard);

/**
 * The CI watch setup from config().push.
 * @returns {{ mode: 'off'|'github', enabled: boolean, intervalSec: number, timeoutMin: number, noRunsMin: number }}
 */
function ciWatchSetup(cfg = {}) {
  const own = isObject(cfg?.push) ? cfg.push : {};
  const mode = MODES.includes(own.ciWatch) ? own.ciWatch : DEFAULTS.mode;
  return {
    mode,
    enabled: mode !== 'off',
    intervalSec: positive(own.ciWatchIntervalSec, DEFAULTS.intervalSec),
    timeoutMin: positive(own.ciWatchTimeoutMin, DEFAULTS.timeoutMin),
    noRunsMin: NO_RUNS_MIN,
  };
}

/** The problems in the ciWatch keys of config().push, for `cq doctor` (texts, empty when valid). */
function setupProblems(push) {
  if (!isObject(push)) return [];
  const out = [];
  if (push.ciWatch !== undefined && !MODES.includes(push.ciWatch)) out.push(`push.ciWatch is "${push.ciWatch}", expected off or github`);
  for (const k of ['ciWatchIntervalSec', 'ciWatchTimeoutMin'])
    if (push[k] !== undefined && !(typeof push[k] === 'number' && push[k] > 0)) out.push(`push.${k} must be a number > 0`);
  return out;
}

/** The runs from `gh run list --json`, as a list (anything else: none). */
function parseRuns(text) {
  try {
    const v = JSON.parse(String(text ?? ''));
    return Array.isArray(v) ? v.filter(isObject) : [];
  } catch {
    return [];
  }
}

/**
 * Where the runs for the commit stand: "none" (no run yet), "pending" (one is not completed) or "done", with the red runs.
 * @returns {{ phase: 'none'|'pending'|'done', red: object[], total: number }}
 */
function summarize(runs) {
  const list = (runs ?? []).filter(isObject);
  if (!list.length) return { phase: 'none', red: [], total: 0 };
  if (list.some((r) => r.status !== 'completed')) return { phase: 'pending', red: [], total: list.length };
  return { phase: 'done', red: list.filter((r) => !GREEN.has(String(r.conclusion ?? ''))), total: list.length };
}

/**
 * Why one red run is red: { kind: "check"|"infra", reason }. Infra: a conclusion that is infra by itself, a failed job
 * that never ran a step (no runner), log text that names the infrastructure, or no failed log at all. Otherwise a check.
 * @param {{ run: object, log?: string, jobs?: object[]|null }} x
 */
function classify({ run, log = '', jobs = null }) {
  const c = String(run?.conclusion ?? '');
  if (INFRA_CONCLUSION[c]) return { kind: 'infra', reason: INFRA_CONCLUSION[c] };
  if (c === 'action_required') return { kind: 'infra', reason: 'approval' };
  const text = String(log ?? '');
  for (const p of INFRA_LOG) if (p.re.test(text)) return { kind: 'infra', reason: p.reason };
  const failedJobs = (jobs ?? []).filter((j) => isObject(j) && j.conclusion && !GREEN.has(String(j.conclusion)));
  if (failedJobs.length && failedJobs.every((j) => !Array.isArray(j.steps) || j.steps.length === 0))
    return { kind: 'infra', reason: 'runner' };
  if (!text.trim()) return { kind: 'infra', reason: 'no failed log' };
  return { kind: 'check', reason: 'a check failed' };
}

/** The verdict over the classified red runs: a failed check wins over infrastructure. */
function verdictOf(items) {
  return (items ?? []).some((x) => x?.kind === 'check') ? 'check' : 'infra';
}

/** The fix task id for a commit. */
const taskId = (sha) => `CI-${short(sha)}`;
/** The owner question id for an infrastructure failure on a commit. */
const questionId = (sha) => `ci-${short(sha)}-infra`;

/** The last lines of a log, capped in bytes and lines, each line cut, secrets redacted. */
function logTail(text, { bytes = LOG_BYTES, lines = LOG_LINES } = {}) {
  const s = String(text ?? '');
  const end = s.length > bytes ? s.slice(-bytes) : s;
  const list = end.split(/\r?\n/);
  if (s.length > bytes) list.shift(); // the first line is cut in the middle
  const kept = list.filter((l) => l.trim()).slice(-lines).map((l) => (l.length > LINE_MAX ? `${l.slice(0, LINE_MAX)}…` : l));
  return kept.length ? redact(kept.join('\n')).text.split('\n') : [];
}

const runName = (r) => `${r?.workflowName ?? r?.name ?? 'workflow'} #${r?.databaseId ?? '?'}${Number(r?.attempt) > 1 ? ` (attempt ${r.attempt})` : ''}`;

/**
 * The fix task for a failed CI check (not yet validated or added): K, value 10 (as the base fix task: the queue waits on
 * it), `added_by` "ci watch" (so waiting, not proposed), a mission that names the commit, the red runs and the report
 * file, and never the log.
 */
function fixTask({ sha, branch, runs, reportFile, project = null }) {
  const names = (runs ?? []).map(runName).join(', ') || 'the CI run';
  return {
    id: taskId(sha),
    title: `Make CI green again on ${branch} at ${short(sha)}`,
    domain: 'general',
    class: 'K',
    ...(project ? { project } : {}),
    mission:
      `CI is red on ${branch} at ${sha} after a batch push: ${names} failed on a check (not the infrastructure). ` +
      `The local gates were green on that commit, so the difference is in what CI runs or where it runs.\n\n` +
      `The tail of the failed jobs' log (redacted) is in ${reportFile} (read it first; the runs are linked there).\n\n` +
      `Make CI green on top of ${branch} as it is now with the smallest change. When the cause is the CI setup and not ` +
      'the code, say so in the report. cq merge refuses every other track until this task is merged and the base is green.',
    value: 10,
    content_min: 30,
    migr_tens: 0,
    depends_on: [],
    waiting_on: [],
    owned_files: [],
    owner_db: [],
    shared_patch: [],
    source: `ci watch ${short(sha)}`,
    added_by: 'ci watch',
  };
}

/** The owner question for an infrastructure failure: { id, question } (setQuestion input). Never the log. */
function infraQuestion({ sha, branch, items, reportFile }) {
  const what = (items ?? []).map((x) => `${runName(x.run)}: ${x.reason}`).join('; ') || 'a CI run';
  const first = (items ?? [])[0]?.run?.databaseId;
  return {
    id: questionId(sha),
    question: {
      type: 'question',
      text:
        `CI on ${branch} at ${short(sha)} failed for a reason outside the code (${what}). Nothing was frozen: cq merge ` +
        `goes on. Details: ${reportFile}. Rerun the failed jobs${first ? ` (gh run rerun ${first} --failed, then cq push-check --watch-ci ${sha})` : ''}, or ignore this run?`,
      recommendation: 'Rerun the failed jobs',
      source: 'ci watch',
      choices: ['Rerun the failed jobs', 'Ignore this run'],
    },
  };
}

/** The report file: markdown with the verdict, the runs (linked) and each red run's redacted log tail. */
function report({ sha, branch, verdict, items, total }) {
  const head = { check: 'RED (a check failed)', infra: 'RED (infrastructure)', green: 'GREEN' }[verdict] ?? verdict;
  const out = [`# CI for ${branch} at ${short(sha)}: ${head}`, '', `- Commit: ${sha}`, `- Runs: ${total}, red: ${(items ?? []).length}`, ''];
  for (const x of items ?? []) {
    out.push(`## ${runName(x.run)}: ${x.kind} (${x.reason})`, '', `- ${x.run?.url ?? '(no url)'}`, '');
    out.push(`The last ${x.tail.length} line(s) of the failed jobs' log (redacted; only the tail is kept):`, '', '~~~~', ...x.tail, '~~~~', '');
  }
  return out.join('\n');
}

module.exports = {
  DEFAULTS,
  NO_RUNS_MIN,
  RUN_FIELDS,
  ciWatchSetup,
  setupProblems,
  parseRuns,
  summarize,
  classify,
  verdictOf,
  taskId,
  questionId,
  logTail,
  fixTask,
  infraQuestion,
  report,
};
