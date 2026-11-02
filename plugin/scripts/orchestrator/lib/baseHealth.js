// =============================================================
// baseHealth.js: the base gate, a health check of the base branch itself after `cq merge` (config().baseGate).
//
// Why: each track's gates run on its own branch. Two tracks can each be green and still break the base branch together
// (a semantic conflict: one renames a function, the other adds a new call to the old name; git merges both without a
// textual conflict). Until now nothing remembered that the base was red, so every later merge built on a red base and
// the next track's red gate looked like that track's fault. The base gate records the base branch's health per tip and
// `cq merge` refuses to merge another track while the recorded health for the current tip is red.
//
// The flow (the I/O lives in cli/baseHealth.mjs and cli/merge.mjs):
//   - Before a merge: the recorded verdict for the base tip. Green: merge. Red: refused (exit 9), except for the base fix
//     task itself or with --force-red-base (logged). Unknown (no record, or the tip moved since the last check, e.g. a
//     commit by hand): the check runs first, in the main checkout, on the current tip.
//   - After the merge: the quick gates already run on the new tip in the main checkout (the merge step's `gates`). When
//     the base gate commands are the quick gates (the default), that run IS the base check, so nothing runs twice. With
//     other commands (`baseGate.commands`, e.g. the full gate) a `base-gate` step runs them after the quick gates.
//   - Red after a merge: the merge stays (no automatic revert), a fix task `<id>-BASE<n>` (value 10, `fixes` the merged
//     task, `done_when` = the base gate commands) is added, and the next merge is refused until a check is green again.
//   - The skip rule (skipEvidence): the merge commit has exactly the tree the track tested, and the track's own gate ran
//     green on that commit with the base gate commands: the check would run the same commands on the same files, so
//     green is recorded without running them.
//
// Where the check runs: the main checkout (config root / QUEUE_GIT), which `cq merge` already requires to be on the base
// branch and where the merge and the quick gates run. A separate worktree would need the shared links (node_modules) to
// run the project's gates, and creating and removing such worktrees is the known hazard cleanup-worktree.mjs handles.
// The check never writes to the checkout itself; when a gate leaves tracked files changed, the caller warns.
//
// Secrets: as for the done command (lib/doneCheck.js), only the TAIL of the output is kept (tailLines, each line cut),
// and the tail goes only to a report file next to the merge log. The fix task's mission names that file and never holds
// the output itself (queue.json is read by every track and the board).
//
// The state file: <dataFolder>/base-health.json, { current: entry, history: [entry, ...] } with
//   entry = { tip, branch, status: "green"|"red", at, commands, skipped?, made_red_by?: { task, merge_commit },
//             fix_task?, tail_file?, failed?, exit?, timed_out?, note? }
// The history keeps the last HISTORY_MAX entries (the newest last).
//
// Pure except readState/writeState (one small file) and runBaseGate (it runs the commands; `spawn` can be swapped).
// Tested in lib/__tests__/baseHealth.test.ts and __tests__/queueBaseGate.test.ts (cq merge against temporary repos).
// =============================================================
'use strict';

const fs = require('node:fs');
const DC = require('./doneCheck.js');

/** The defaults for config().baseGate. A full gate can take long; the budget is for the whole list. */
const DEFAULT_TIMEOUT_SEC = 900;
/** Entries kept in the state file's history. */
const HISTORY_MAX = 20;
/** The exit code of `cq merge` when the base is red. */
const EXIT_RED_BASE = 9;
/** The longest done_when (lib/doneCheck.js); the fix task gets the base gate commands as its done command when they fit. */
const DONE_WHEN_MAX = DC.DONE_WHEN_MAX;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const commandList = (v) => (Array.isArray(v) ? v.filter((g) => typeof g === 'string' && g.trim()).map((g) => g.trim()) : []);
const positiveInt = (v, standard) => (Number.isInteger(v) && v > 0 ? v : standard);

/**
 * The base gate setup from the configuration.
 *   enabled: false turns the feature off; true or "auto" (the default) turns it on when there are commands. Lite mode
 *   (lib/liteMode.js) has no rule of its own: a lite project usually has no gates, and then the base gate is off; once
 *   `gates.quick` has a command it is on there too, since a red base costs a beginner the most.
 *   commands: config().baseGate.commands, else the quick gates (what tracks run before delivery).
 *   sameAsQuick: the commands are exactly the quick gates, so the merge step's own gates run is the base check.
 * @returns {{ enabled: boolean, commands: string[], sameAsQuick: boolean, timeoutSec: number, tailLines: number,
 *   reason: string }}
 */
function baseGateSetup(cfg = {}) {
  const own = isObject(cfg?.baseGate) ? cfg.baseGate : {};
  const quick = commandList(cfg?.gates?.quick);
  const commands = Array.isArray(own.commands) ? commandList(own.commands) : quick;
  const sameAsQuick = commands.length === quick.length && commands.every((c, i) => c === quick[i]);
  const timeoutSec = positiveInt(own.timeoutSec, DEFAULT_TIMEOUT_SEC);
  const tailLines = positiveInt(own.tailLines, positiveInt(cfg?.doneCheck?.tailLines, DC.DEFAULT_TAIL_LINES));
  let enabled = commands.length > 0;
  let reason = enabled ? 'on' : 'off: no base gate commands (baseGate.commands or gates.quick)';
  if (own.enabled === false) {
    enabled = false;
    reason = 'off: baseGate.enabled is false';
  }
  return { enabled, commands, sameAsQuick, timeoutSec, tailLines, reason };
}

/** The state file's content, or an empty state when it is missing or broken (a broken file is never fatal: unknown). */
function readState(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (isObject(s)) return { current: isObject(s.current) ? s.current : null, history: Array.isArray(s.history) ? s.history : [] };
  } catch {
    // missing or broken: no record, so the next merge checks first
  }
  return { current: null, history: [] };
}

/** Writes the state atomically (a temporary file and a rename), so a reader never sees half a file. */
function writeState(file, state) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/** The state with `entry` as the current record and appended to the history (the oldest dropped). Pure. */
function record(state, entry) {
  const history = [...(state?.history ?? []), entry].slice(-HISTORY_MAX);
  return { current: entry, history };
}

/** The verdict for the base tip: the recorded status when the record is for this tip, else "unknown". */
function verdict(state, tip) {
  const c = state?.current;
  if (!c || !tip || c.tip !== tip) return 'unknown';
  return c.status === 'green' ? 'green' : c.status === 'red' ? 'red' : 'unknown';
}

/**
 * May `cq merge <id>` go on? Only after the verdict is known (the caller runs the check first when it is unknown).
 * Allowed: green; red for the open base fix task itself (it is what makes the base green again); red with --force-red-base.
 * @returns {{ allow: boolean, forced: boolean, fixTask: string|null }}
 */
function mergeAllowed({ state, tip, id, force = false }) {
  const v = verdict(state, tip);
  const fixTask = state?.current?.fix_task ?? null;
  if (v !== 'red') return { allow: true, forced: false, fixTask };
  if (fixTask && fixTask === id) return { allow: true, forced: false, fixTask };
  if (force) return { allow: true, forced: true, fixTask };
  return { allow: false, forced: false, fixTask };
}

/** The gate rows in the time log text (event "gate"), broken lines skipped. */
function gateRows(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    if (!line.includes('"gate"')) continue;
    try {
      const r = JSON.parse(line);
      if (r?.event === 'gate') out.push(r);
    } catch {
      // not a row
    }
  }
  return out;
}

/**
 * The skip rule: may the check record green without running? Yes only when BOTH hold:
 *   1. the new base tip has exactly the tree of the track tip (`git merge --no-ff` of a branch that already contains the
 *      base gives a merge commit with the track's own tree; a fast-forward gives the track tip itself), so the check
 *      would see exactly the files the track tested;
 *   2. the track's own gate ran green on exactly that track tip, in a clean worktree (no uncommitted tracked changes,
 *      which a green run could have depended on), and ran every base gate command (a quick or full row in the time log
 *      with `sha` = the track tip; gates.mjs writes sha and clean).
 * Anything less (another tree, a dirty or older run, a row without sha) runs the check.
 * @param {{ newTip: string, trackTip: string, treeOf: (sha: string) => string|null, rows: object[], commands: string[] }} x
 * @returns {{ skip: boolean, reason: string }}
 */
function skipEvidence({ newTip, trackTip, treeOf, rows, commands }) {
  if (!newTip || !trackTip) return { skip: false, reason: 'the tips are not known' };
  if (newTip !== trackTip) {
    const a = treeOf(newTip);
    const b = treeOf(trackTip);
    if (!a || !b || a !== b) return { skip: false, reason: 'the merge has files the track did not test' };
  }
  const want = new Set(commands);
  const hit = (rows ?? []).find(
    (r) =>
      r?.sha === trackTip &&
      r.ok === true &&
      r.clean === true &&
      (r.kind === 'quick' || r.kind === 'full') &&
      [...want].every((c) => (r.gates ?? []).includes(c)),
  );
  if (!hit) return { skip: false, reason: `no green, clean gate run of the base gate commands on ${short(trackTip)}` };
  return {
    skip: true,
    reason: `same tree as the track tip ${short(trackTip)}, where the track's ${hit.kind} gate ran green at ${hit.time ?? '?'}`,
  };
}

/**
 * Runs the base gate commands in `cwd` one after the other, stopping at the first red one. One time budget for the whole
 * list: each command gets what is left. The tail is the red command's (or, when all are green, the last command's).
 * @returns {{ ok: boolean, failed: string|null, exit: number|null, timedOut: boolean, durationSec: number, tail: string[] }}
 */
function runBaseGate({ commands, cwd, timeoutSec = DEFAULT_TIMEOUT_SEC, tailLines = DC.DEFAULT_TAIL_LINES, spawn = null }) {
  const t0 = Date.now();
  let last = { ok: true, exit: 0, timedOut: false, tail: [] };
  for (const command of commands) {
    const left = Math.max(1, Math.round(timeoutSec - (Date.now() - t0) / 1000));
    last = DC.runDoneWhen({ command, cwd, timeoutSec: left, tailLines, spawn });
    if (!last.ok) {
      const tail = last.tail.map((l) => l.replace('config().doneCheck.timeoutSec', 'config().baseGate.timeoutSec'));
      return { ok: false, failed: command, exit: last.exit, timedOut: last.timedOut, durationSec: secSince(t0), tail };
    }
  }
  return { ok: true, failed: null, exit: 0, timedOut: false, durationSec: secSince(t0), tail: last.tail };
}

const secSince = (t0) => Math.round((Date.now() - t0) / 100) / 10;
const short = (sha) => String(sha ?? '').slice(0, 12);

/** The report file for a check (overwritten per tip): markdown with the verdict, the commands and the tail. */
function baseReport({ branch, tip, run, commands, cause = null, cwd }) {
  const verdictText = run.ok ? 'GREEN' : run.timedOut ? 'RED (time budget)' : `RED (exit ${run.exit ?? '?'})`;
  return [
    `# Base gate for ${branch} at ${short(tip)}: ${verdictText}`,
    '',
    `- Commands: ${commands.map((c) => `\`${c}\``).join(', ')}`,
    `- Where: ${cwd} (the main checkout, on ${branch})`,
    ...(cause ? [`- Made red by: the merge of ${cause.task} (merge commit ${short(cause.merge_commit)})`] : []),
    ...(run.failed ? [`- The red command: \`${run.failed}\``] : []),
    `- Time: ${run.durationSec ?? '?'} s`,
    '',
    `The last ${run.tail.length} line(s) of the output (only the tail is kept, never the full output):`,
    '',
    '~~~~',
    ...run.tail,
    '~~~~',
    '',
  ].join('\n');
}

/**
 * The id for a new base fix task: `<root>-BASE<n>`, where root is the merged task without an earlier -BASE<n> (a fix
 * task that leaves the base red numbers on: A-BASE1 -> A-BASE2), or `BASE-<sha7>` when no merge is to blame. Kept within
 * the 41-character id rule.
 */
function fixTaskId(tasks, { cause = null, tip }) {
  const ids = new Set((tasks ?? []).map((t) => t.id));
  if (!cause) {
    let id = `BASE-${String(tip).slice(0, 7)}`;
    for (let n = 2; ids.has(id); n++) id = `BASE-${String(tip).slice(0, 7)}-${n}`;
    return id;
  }
  const root = String(cause).replace(/-BASE\d+$/, '');
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escaped}-BASE(\\d+)$`);
  let n = 1;
  for (const id of ids) {
    const m = pattern.exec(id);
    if (m) n = Math.max(n, Number(m[1]) + 1);
  }
  const suffix = `-BASE${n}`;
  return `${root.slice(0, 41 - suffix.length)}${suffix}`;
}

/**
 * The base fix task (not yet validated or added): K, value 10 (the highest priority, the whole queue waits on it),
 * `fixes` the merged task when one is to blame, the base gate commands as its done command when they fit on one line,
 * and a mission that names the merge commit and the report file with the tail.
 * @returns {object}
 */
function fixTask({ tasks, causeTask = null, tip, branch, commands, tailFile, failed = null, project = null }) {
  const id = fixTaskId(tasks, { cause: causeTask?.id ?? null, tip });
  const doneWhen = commands.join(' && ');
  const blame = causeTask
    ? `The merge of ${causeTask.id} ("${causeTask.title ?? ''}") made it red: merge commit ${tip}. ${causeTask.id}'s own ` +
      'gates were green on its branch, so the break is most likely the combination with what was merged before it.'
    : `The tip ${tip} is red, and no merge through cq merge is known to have caused it (a commit made by hand, or a merge ` +
      'whose check did not run).';
  return {
    id,
    title: causeTask ? `Make ${branch} green again after the merge of ${causeTask.id}` : `Make ${branch} green again at ${short(tip)}`,
    domain: causeTask?.domain ?? 'general',
    class: 'K',
    ...(project ? { project } : {}),
    ...(typeof causeTask?.feature === 'string' && causeTask.feature ? { feature: causeTask.feature } : {}),
    mission:
      `The base branch ${branch} is red. ${blame}\n\n` +
      `The base gate: ${commands.map((c) => `\`${c}\``).join(', ')}${failed ? `; the red command is \`${failed}\`` : ''}. ` +
      `The tail of its output is in ${tailFile} (read it first).\n\n` +
      `Make the base gate green on top of ${branch} as it is now (branch from its tip, which has the merge), with the ` +
      'smallest change that keeps both sides\' intent. Do not revert the merged work unless that is the only fix; say so ' +
      'in the report if you do. cq merge refuses every other track until this task is merged and the base is green.',
    value: 10,
    content_min: 30,
    migr_tens: 0,
    depends_on: [],
    waiting_on: [],
    owned_files: [],
    owner_db: [],
    shared_patch: [],
    ...(doneWhen.length <= DONE_WHEN_MAX && !/[\u0000-\u001f\u007f]/.test(doneWhen) ? { done_when: doneWhen } : {}),
    source: `base gate ${short(tip)}`,
    added_by: 'base gate',
    ...(causeTask ? { fixes: [causeTask.id] } : {}),
  };
}

/**
 * The lines of the tail shown on screen (at most `max`): the first lines that look like the error (a stack trace puts
 * the message far above its last lines), then the last lines. The full tail stays in the report file.
 */
function excerpt(tail, max = 10) {
  const lines = (tail ?? []).filter((l) => String(l).trim());
  if (lines.length <= max) return lines;
  // No \b before "error": TypeError, AssertionError.
  const error = /(error\b|\bfail(ed|ure|s)?\b|\bassert|\bexpected\b|\bnot ok\b)/i;
  const hits = lines.map((l, i) => ({ l, i })).filter((x) => error.test(x.l)).slice(0, Math.floor(max / 2));
  const rest = max - hits.length;
  const last = lines.map((l, i) => ({ l, i })).slice(-rest).filter((x) => !hits.some((h) => h.i === x.i));
  const keep = [...hits, ...last].sort((x, y) => x.i - y.i);
  const out = [];
  keep.forEach((x, k) => {
    if (k > 0 && x.i !== keep[k - 1].i + 1) out.push('…');
    out.push(x.l);
  });
  return out;
}

/** How long ago, short (min / h / d). */
function ago(at, now = Date.now()) {
  const ms = now - Date.parse(at ?? '');
  if (!Number.isFinite(ms)) return '?';
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h`;
  return `${Math.round(min / 1440)} d`;
}

/**
 * The one line for `cq show` and the orchestrator pulse. null when the feature is off.
 * @param {{ state: object, tip: string|null, setup: object, branch: string, cq?: string, now?: number }} x
 */
function healthLine({ state, tip, setup, branch, cq = 'cq', now = Date.now() }) {
  if (!setup?.enabled) return null;
  const c = state?.current;
  const v = verdict(state, tip);
  if (v === 'green')
    return `BASE ${branch}: GREEN at ${short(tip)} (checked ${ago(c.at, now)} ago${c.skipped ? ', the track\'s own run' : ''}).`;
  if (v === 'red') {
    const by = c.made_red_by ? ` by the merge of ${c.made_red_by.task}` : '';
    const fix = c.fix_task ? `; fix task ${c.fix_task} (${cq} merge ${c.fix_task} is allowed)` : '';
    return `BASE ${branch}: RED at ${short(tip)}${by} (${ago(c.at, now)} ago)${fix}. ${cq} merge refuses other tracks.`;
  }
  if (!c) return `BASE ${branch}: not checked yet; the next ${cq} merge runs the base gate first.`;
  return (
    `BASE ${branch}: unknown at ${short(tip)} (the last check was ${c.status} at ${short(c.tip)}); ` +
    `the next ${cq} merge runs the base gate first.`
  );
}

/** The short form for the board header: { status, tip, text } or null when off. */
function boardHealth({ state, tip, setup, branch, now = Date.now() }) {
  const text = healthLine({ state, tip, setup, branch, now });
  if (!text) return null;
  return { status: verdict(state, tip), tip: short(tip), fixTask: state?.current?.fix_task ?? null, text };
}

module.exports = {
  DEFAULT_TIMEOUT_SEC,
  HISTORY_MAX,
  EXIT_RED_BASE,
  baseGateSetup,
  readState,
  writeState,
  record,
  verdict,
  mergeAllowed,
  gateRows,
  skipEvidence,
  runBaseGate,
  baseReport,
  fixTaskId,
  fixTask,
  excerpt,
  healthLine,
  boardHealth,
};
