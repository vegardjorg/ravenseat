// =============================================================
// doneCheck.js: the done command (task field `done_when`) and the fix-round cap (`max_fix_rounds`, config().maxFixRounds).
//
// Why: a track's own RESULT line says "DONE", but nothing checked that against something the owner chose. `done_when`
// is a shell command (e.g. "npm test -- src/x.test.ts") that must exit 0 in the track's worktree for the track to count
// as done. `cq receive` runs it before the review package is made (no reviewer is spent on a red track), and `cq merge`
// runs it again when the branch tip changed since the last green run. A red run gets the same treatment as a red gate:
// a blocker `gate-red` and a fix round (`cq resume <id> --reason fix`) with the command's last output lines in the brief.
//
// The cap: every fix round counts (`resumed` entries with reason fix, written by `cq resume`). At max_fix_rounds (the
// task's own field, else config().maxFixRounds, default 3) `resume --reason fix` stops retrying and asks the owner instead,
// with the queue's existing mechanism: a registered owner question (`queue.question`), the id in the task's `waiting_on`
// (so the answer reaches the next brief through answerBlock) and an open blocker `owner-question`. Each round beyond the
// cap needs its own resolved question (`<id>.fixcap<N>`), so the owner is asked again if the next round also fails.
//
// Secrets: the command's output can hold anything the project prints (tokens in an error, env dumps). Only the TAIL is
// kept (config().doneCheck.tailLines, default 40 lines, each cut to LINE_MAX characters); the full output is never written
// to disk or to queue.json, and the tail itself goes only to a file in the scratchpad and into the fix brief.
//
// Pure except runDoneWhen (it runs the command; `spawn` can be swapped in tests). Tested in lib/__tests__/doneCheck.test.ts
// and __tests__/queueAdopt.test.ts (receive and resume against a temporary queue).
// =============================================================
'use strict';

/** The longest done command accepted (one command line, not a script). */
const DONE_WHEN_MAX = 500;
/** The highest max_fix_rounds a task may set (a higher number is a typo, not a plan). */
const MAX_FIX_ROUNDS_LIMIT = 20;
/** The defaults for config().doneCheck and config().maxFixRounds. */
const DEFAULT_TIMEOUT_SEC = 600;
const DEFAULT_TAIL_LINES = 40;
const DEFAULT_MAX_FIX_ROUNDS = 3;
/** Each kept output line is cut to this many characters (a minified bundle on one line must not fill the brief). */
const LINE_MAX = 400;

/**
 * The shape errors for `done_when` and `max_fix_rounds` (queueLogic.validate, so add and edit both check them).
 * null or a missing field is fine (no done command, the config cap).
 * @returns {string[]} errors (empty = valid)
 */
function doneWhenErrors(o) {
  const error = [];
  const d = o?.done_when;
  if (d != null) {
    if (typeof d !== 'string' || !d.trim()) error.push('done_when must be a non-empty shell command (text)');
    else if (d.length > DONE_WHEN_MAX) error.push(`done_when can be at most ${DONE_WHEN_MAX} characters`);
    // One line: a newline would hide a second command in what the owner reads as one.
    else if (/[\u0000-\u001f\u007f]/.test(d)) error.push('done_when must be one line without control characters');
  }
  const m = o?.max_fix_rounds;
  if (m != null && !(Number.isInteger(m) && m >= 0 && m <= MAX_FIX_ROUNDS_LIMIT))
    error.push(`max_fix_rounds must be a whole number 0 to ${MAX_FIX_ROUNDS_LIMIT} (0 = no automatic fix round)`);
  return error;
}

/** A positive integer from the config, or the default. */
const positiveInt = (v, standard) => (Number.isInteger(v) && v > 0 ? v : standard);

/** The time budget and the tail length from config().doneCheck, with the defaults. */
function doneCheckSetup(cfg = {}) {
  const k = cfg?.doneCheck ?? {};
  return {
    timeoutSec: positiveInt(k.timeoutSec, DEFAULT_TIMEOUT_SEC),
    tailLines: positiveInt(k.tailLines, DEFAULT_TAIL_LINES),
  };
}

/** The last `n` lines of the text (trailing empty lines dropped), each cut to LINE_MAX characters. */
function tailOf(text, n = DEFAULT_TAIL_LINES) {
  const lines = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/\s+$/, '')
    .split('\n');
  const kept = lines.length === 1 && lines[0] === '' ? [] : lines.slice(-n);
  return kept.map((l) => (l.length > LINE_MAX ? `${l.slice(0, LINE_MAX)} …` : l));
}

/**
 * Runs the done command in `cwd` (the track's worktree) through the shell, with a time budget. Only the tail of the
 * output is returned (see Secrets in the header); stdout comes first, then stderr, since spawnSync cannot interleave them.
 * On Windows the shell is cmd.exe: a timeout kills it, but a child it started can live on until it ends by itself.
 * @returns {{ ok: boolean, exit: number|null, timedOut: boolean, durationSec: number, tail: string[] }}
 */
function runDoneWhen({ command, cwd, timeoutSec = DEFAULT_TIMEOUT_SEC, tailLines = DEFAULT_TAIL_LINES, spawn = null }) {
  const run = spawn ?? require('node:child_process').spawnSync;
  const t0 = Date.now();
  const s = run(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    // A large buffer: an overflow kills the command, which would read as a red run that is not the code's fault.
    maxBuffer: 1 << 28,
    timeout: timeoutSec * 1000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const timedOut = s?.error?.code === 'ETIMEDOUT';
  const exit = typeof s?.status === 'number' ? s.status : null;
  const text = [s?.stdout ?? '', s?.stderr ?? '', s?.error && !timedOut ? s.error.message : '']
    .map((x) => String(x).replace(/\s+$/, ''))
    .filter(Boolean)
    .join('\n');
  const tail = tailOf(text, tailLines);
  if (timedOut) tail.push(`(stopped after the time budget of ${timeoutSec} s: config().doneCheck.timeoutSec)`);
  return { ok: exit === 0 && !timedOut, exit, timedOut, durationSec: Math.round((Date.now() - t0) / 100) / 10, tail };
}

/** The file the orchestrator keeps the red run in (overwritten each run): markdown with the command and the tail. */
function doneCheckReport({ id, command, cwd, step, run, tip = null }) {
  const verdict = run.ok ? 'GREEN' : run.timedOut ? 'RED (time budget)' : `RED (exit ${run.exit ?? '?'})`;
  return [
    `# Done command for ${id}: ${verdict}`,
    '',
    `- Command: \`${command}\``,
    `- Where: ${cwd} (the track's worktree)${tip ? `, branch tip ${String(tip).slice(0, 12)}` : ''}`,
    `- Step: ${step}, ${run.durationSec} s`,
    '',
    `The last ${run.tail.length} line(s) of the output (only the tail is kept, never the full output):`,
    '',
    '~~~~',
    ...run.tail,
    '~~~~',
    '',
  ].join('\n');
}

/** The cap for the task: its own max_fix_rounds, else config().maxFixRounds, else 3. */
function maxFixRoundsFor(o, cfg = {}) {
  if (Number.isInteger(o?.max_fix_rounds) && o.max_fix_rounds >= 0) return o.max_fix_rounds;
  const c = cfg?.maxFixRounds;
  return Number.isInteger(c) && c >= 0 ? c : DEFAULT_MAX_FIX_ROUNDS;
}

/** The fix rounds the task has had: `resumed` entries with reason fix (a context continuation is not a fix round). */
function fixRoundsUsed(o) {
  return (Array.isArray(o?.resumed) ? o.resumed : []).filter((r) => r?.reason === 'fix').length;
}

/** The owner question id for a fix round beyond the cap: `<id>.fixcap<used>`, kept within the 40-character id rule. */
function capQuestionId(id, used) {
  const suffix = `.fixcap${used}`;
  return `${String(id).slice(0, 40 - suffix.length)}${suffix}`;
}

/**
 * May the task get one more fix round? `allowed` is true below the cap, and at or above it only when the owner has
 * resolved the question for exactly this round (queue.resolved has capQuestionId).
 * @returns {{ used: number, max: number, reached: boolean, questionId: string, allowed: boolean, byOwner: boolean }}
 */
function fixCap(o, queue, cfg = {}) {
  const used = fixRoundsUsed(o);
  const max = maxFixRoundsFor(o, cfg);
  const questionId = capQuestionId(o?.id, used);
  const reached = used >= max;
  const byOwner = reached && (queue?.resolved ?? []).includes(questionId);
  return { used, max, reached, questionId, allowed: !reached || byOwner, byOwner };
}

/** The owner question (the input for queueLogic.setQuestion) when the cap is reached. */
function capQuestion(o, cap, { lastFailure = null } = {}) {
  const why = lastFailure ? ` The last check: ${lastFailure}.` : '';
  return {
    [cap.questionId]: {
      type: 'question',
      text:
        `${o.id} (${o.title ?? ''}) has had ${cap.used} fix round(s) (the cap is ${cap.max}) and is still not done.${why} ` +
        'Should the queue start another fix round, or do you take it over, split it or cancel it?',
      recommendation:
        'Read the last report and the done command output before another round. Another round: answer with what the ' +
        `agent should do differently (cq resolve ${cap.questionId} --answer "…"); a higher cap: cq edit ${o.id} --json ` +
        `'{"max_fix_rounds": N}'; give up: cq set ${o.id} cancelled.`,
      source: `fix-round cap (${o.id})`,
    },
  };
}

/** The lines in the track block (the mission) when the task has a done command; null without one. */
function doneWhenBlock(o) {
  const d = typeof o?.done_when === 'string' ? o.done_when.trim() : '';
  if (!d) return null;
  return [
    `**Done command (binding):** \`${d}\` must exit 0 in your worktree. Run it yourself, from the worktree root, before`,
    'you report DONE, and say in the report that it was green. The orchestrator runs it again before review and merge; a',
    'red run gives a fix round, never a merge.',
  ].join('\n');
}

/**
 * The worktree that has `branch` checked out, from `git worktree list --porcelain`; null when none has it (the track's
 * worktree was cleaned up or detached).
 */
function worktreeFor(porcelain, branch) {
  for (const block of String(porcelain ?? '').split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/);
    if (!lines.includes(`branch refs/heads/${branch}`)) continue;
    const w = lines.find((l) => l.startsWith('worktree '));
    if (w) return w.slice('worktree '.length);
  }
  return null;
}

module.exports = {
  DONE_WHEN_MAX,
  MAX_FIX_ROUNDS_LIMIT,
  DEFAULT_TIMEOUT_SEC,
  DEFAULT_TAIL_LINES,
  DEFAULT_MAX_FIX_ROUNDS,
  doneWhenErrors,
  doneCheckSetup,
  tailOf,
  runDoneWhen,
  doneCheckReport,
  maxFixRoundsFor,
  fixRoundsUsed,
  capQuestionId,
  fixCap,
  capQuestion,
  doneWhenBlock,
  worktreeFor,
};
