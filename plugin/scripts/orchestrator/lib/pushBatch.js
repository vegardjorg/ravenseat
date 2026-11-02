// =============================================================
// pushBatch.js: the batch push threshold (config().push). When is the unpushed batch on the base branch big enough to
// push?
//
// Why: every push of the base branch runs the whole CI. Pushing per small change burns CI minutes quietly, and the rule
// "push in batches" used to live only as text. The batch is measured in MERGED TASKS, not commits: one track gives
// several commits plus a merge commit, so a commit count says little about how much work waits.
//
// How merged tasks are counted (cheap, and the same in push-check, the push guard and the board):
//   the first-parent line of <remote>/<baseBranch>..<baseBranch> (one `git log --first-parent`), where a commit with two
//   or more parents and the subject "Merge branch '<branchPrefix><id>' ..." is a merged task (the message `cq merge`
//   writes with `git merge --no-ff --no-edit`; logic/commits.js queueIdFromMerge). Distinct ids, so a task merged twice
//   counts once. The queue state (queue.json) is not read: the merge commits on the line ARE the tasks that are done
//   via cq merge and not yet on the remote, and git answers that in one call without parsing the queue. Commits are the
//   secondary figure (`git rev-list --count`, everything the push sends, also the track commits under the merges).
//   The remote ref is the local <remote>/<baseBranch> (as of the last fetch); nothing here fetches.
//   The age is the committer time of the oldest commit on the first-parent line: when the oldest unpushed work landed
//   on the base branch (a track's own commits can be older; they were not on the base until the merge).
//
// The verdict (batchVerdict):
//   NOTHING  nothing to push.
//   BLOCKED  the base is red at the tip (base-health.json), or push-check's own checks fail (external commits, or the
//            remote has commits the base does not). Never push.
//   LARGE    merged tasks >= warnTasks: push recommended (a big batch makes a red CI harder to bisect). Never a block.
//   READY    merged tasks >= minTasks (0 = no lower limit), or the oldest work is older than maxAgeHours.
//   NOT_YET  below minTasks ("4 of 10").
//
// Pure except readBatch (the two git calls through an injected runner).
// Tested in lib/__tests__/pushBatch.test.ts (temporary repos with a bare remote).
// =============================================================
'use strict';

/**
 * The task id from the merge message "Merge branch '<prefix><id>' ...", otherwise null. The same rule as
 * logic/commits.js queueIdFromMerge (a test holds them equal), kept here so the push guard hook does not load the queue
 * logic (ranking, conflicts) on every git push.
 */
function queueIdFromMerge(subject, prefix) {
  const p = prefix ?? require('./queueConfig.js').config().branchPrefix ?? 'queue/';
  const safe = String(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = new RegExp(`^Merge branch '${safe}([^']+)'`).exec(String(subject ?? ''));
  return m ? m[1] : null;
}

/** The defaults for config().push (lib/queueConfig.js STANDARD.push holds the same values). */
const DEFAULTS = Object.freeze({ mode: 'owner', minTasks: 10, warnTasks: 50, maxAgeHours: null });
const MODES = ['owner', 'threshold'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const count = (v, standard) => (Number.isInteger(v) && v >= 0 ? v : standard);

/**
 * The push setup from the configuration, with the defaults for missing or invalid values (a wrong value never stops a
 * push; `cq doctor` names it).
 * @returns {{ mode: 'owner'|'threshold', minTasks: number, warnTasks: number, maxAgeHours: number|null }}
 */
function pushSetup(cfg = {}) {
  const own = isObject(cfg?.push) ? cfg.push : {};
  return {
    mode: MODES.includes(own.mode) ? own.mode : DEFAULTS.mode,
    minTasks: count(own.minTasks, DEFAULTS.minTasks),
    warnTasks: count(own.warnTasks, DEFAULTS.warnTasks),
    maxAgeHours: typeof own.maxAgeHours === 'number' && own.maxAgeHours > 0 ? own.maxAgeHours : null,
  };
}

/**
 * The problems in config().push, for `cq doctor` (texts, empty when valid).
 * @param {unknown} push the raw `push` value from queue.config.json
 */
function setupProblems(push) {
  if (push === undefined || push === null) return [];
  if (!isObject(push)) return ['push must be an object'];
  const out = [];
  if (push.mode !== undefined && !MODES.includes(push.mode)) out.push(`push.mode is "${push.mode}", expected owner or threshold`);
  for (const k of ['minTasks', 'warnTasks'])
    if (push[k] !== undefined && !(Number.isInteger(push[k]) && push[k] >= 0)) out.push(`push.${k} must be a whole number >= 0`);
  if (push.maxAgeHours !== undefined && push.maxAgeHours !== null && !(typeof push.maxAgeHours === 'number' && push.maxAgeHours > 0))
    out.push('push.maxAgeHours must be a number > 0 or null');
  return out;
}

/**
 * The batch from the first-parent rows, NEWEST FIRST (as git log gives them).
 * @param {{ sha: string, parents: string[], subject: string, time: number }[]} rows  time = committer time in ms
 * @param {{ prefix?: string, commits?: number|null }} [o]  commits = the rev-list count (null = the rows' count)
 * @returns {{ tasks: string[], taskCount: number, commits: number, firstParent: number, tip: string|null,
 *   oldestAt: string|null }}
 */
function summarize(rows, { prefix, commits = null } = {}) {
  const list = rows ?? [];
  const ids = [];
  for (const r of list) {
    if ((r?.parents?.length ?? 0) < 2) continue;
    const id = queueIdFromMerge(r.subject, prefix);
    if (id && !ids.includes(id)) ids.push(id);
  }
  // Oldest first in the result (the order they were merged).
  ids.reverse();
  const times = list.map((r) => r.time).filter((t) => Number.isFinite(t));
  return {
    tasks: ids,
    taskCount: ids.length,
    commits: commits ?? list.length,
    firstParent: list.length,
    tip: list[0]?.sha ?? null,
    oldestAt: times.length ? new Date(Math.min(...times)).toISOString() : null,
  };
}

// Field and record separators in the git log format (made with fromCharCode, not as escapes in the source).
const US = String.fromCharCode(0x1f);
const RS = String.fromCharCode(0x1e);

/** Parses `git log --format=%x1e%H%x1f%P%x1f%ct%x1f%s`: rows newest first. */
function parseRows(out) {
  return String(out ?? '')
    .split(RS)
    .filter((r) => r.includes(US))
    .map((r) => {
      const [sha, parents = '', ct = '', subject = ''] = r.split(US);
      return { sha: sha.trim(), parents: parents.trim().split(' ').filter(Boolean), time: Number(ct.trim()) * 1000, subject: subject.trim() };
    });
}

/**
 * Reads the batch with at most two git calls: the first-parent log of from..to (subject, parents, committer time), and
 * the commit count when `withCommits` (the guard skips it). null when git fails (an unknown ref: no remote tip yet).
 * @param {(args: string[]) => string|null} git  a runner (queueGit.makeGit)
 * @param {{ from: string, to: string, prefix?: string, withCommits?: boolean }} o
 */
function readBatch(git, { from, to, prefix, withCommits = true }) {
  const out = git(['log', '--first-parent', `--format=${RS}%H${US}%P${US}%ct${US}%s`, `${from}..${to}`, '--']);
  if (out == null) return null;
  let commits = null;
  if (withCommits) {
    const n = Number(String(git(['rev-list', '--count', `${from}..${to}`, '--']) ?? '').trim());
    commits = Number.isFinite(n) ? n : null;
  }
  return summarize(parseRows(out), { prefix, commits });
}

/** Hours since an ISO time (NaN when unknown). */
const hoursSince = (at, now) => (now - Date.parse(at ?? '')) / 3_600_000;

/**
 * The verdict for the batch.
 * @param {{ batch: ReturnType<typeof summarize>|null, setup: ReturnType<typeof pushSetup>, health?: 'green'|'red'|'unknown',
 *   blocked?: string[], now?: number }} x  blocked = push-check's own failing checks, as texts
 * @returns {{ verdict: 'NOTHING'|'BLOCKED'|'LARGE'|'READY'|'NOT_YET', reason: string, aged: boolean }}
 */
function batchVerdict({ batch, setup, health = 'unknown', blocked = [], now = Date.now() }) {
  const n = batch?.taskCount ?? 0;
  const age = hoursSince(batch?.oldestAt, now);
  const aged = setup.maxAgeHours != null && Number.isFinite(age) && age >= setup.maxAgeHours;
  if (!batch || batch.firstParent === 0) return { verdict: 'NOTHING', reason: 'nothing to push', aged: false };
  const why = [...(health === 'red' ? [`base is red at ${String(batch.tip ?? '').slice(0, 7)}`] : []), ...blocked];
  if (why.length) return { verdict: 'BLOCKED', reason: why.join('; '), aged };
  if (setup.warnTasks > 0 && n >= setup.warnTasks)
    return {
      verdict: 'LARGE',
      reason: `${n} merged tasks unpushed (warnTasks ${setup.warnTasks}): push recommended, a large batch makes a red CI harder to bisect`,
      aged,
    };
  if (n >= setup.minTasks) return { verdict: 'READY', reason: `${n} of ${setup.minTasks} merged tasks`, aged };
  if (aged)
    return {
      verdict: 'READY',
      reason: `${n} of ${setup.minTasks} merged tasks, but the oldest unpushed work is ${Math.floor(age)} h old (maxAgeHours ${setup.maxAgeHours})`,
      aged,
    };
  return { verdict: 'NOT_YET', reason: `${n} of ${setup.minTasks} merged tasks`, aged };
}

/** The verdict word as printed ("NOT YET" with a space). */
const verdictWord = (v) => (v === 'NOT_YET' ? 'NOT YET' : v);

/**
 * The push guard's question for a plain push of the base branch by the orchestrator: a reason for "ask", or null (no
 * question). Both modes: in owner mode the owner pushes, and a reminder dialog is cheap. Never deny: the owner can
 * always push. External commits are not asked about here (push-check handles them before a batch push).
 * @param {{ batch: object|null, setup: object, health?: string, now?: number }} x
 */
function guardQuestion({ batch, setup, health = 'unknown', now = Date.now() }) {
  if (!batch || batch.firstParent === 0) return null;
  if (health === 'red') return `base is red at ${String(batch.tip ?? '').slice(0, 7)}; push anyway?`;
  if (setup.minTasks === 0) return null;
  const v = batchVerdict({ batch, setup, health, now });
  if (v.verdict !== 'NOT_YET') return null;
  return `${batch.taskCount} of ${setup.minTasks} merged tasks since the last push (${batch.firstParent} commit(s) on the first-parent line); push anyway?`;
}

/** The age, short (min / h / d). */
function ageText(at, now = Date.now()) {
  const ms = now - Date.parse(at ?? '');
  if (!Number.isFinite(ms)) return '?';
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  if (min < 48 * 60) return `${Math.round(min / 60)} h`;
  return `${Math.round(min / 1440)} d`;
}

/** The short form for the board's status line: { verdict, text } or null without a batch. */
function boardBatch({ batch, setup, health = 'unknown', now = Date.now() }) {
  if (!batch) return null;
  const v = batchVerdict({ batch, setup, health, now });
  const counts = setup.minTasks > 0 ? `${batch.taskCount} of ${setup.minTasks}` : `${batch.taskCount}`;
  const text = v.verdict === 'NOTHING' ? 'nothing to push' : `${counts} tasks, ${verdictWord(v.verdict)}`;
  return { verdict: v.verdict, tasks: batch.taskCount, minTasks: setup.minTasks, text };
}

// ---- CI cost of the project's workflows (for `cq doctor`) ------------------------------------------------------------
//
// A plain text scan of a GitHub Actions workflow, no YAML parser (the plugin has no dependencies). Limits, on purpose:
//   - the trigger block is the top-level `on:` key (also `"on":` and `true:`, how some YAML tools write it) up to the next
//     top-level key, or the inline forms `on: push` and `on: [push, pull_request]`; anchors, aliases and flow maps
//     spread over several lines are not followed;
//   - "has concurrency" means a `cancel-in-progress:` set to true or to an expression (`${{ ... }}`) anywhere in the file
//     (workflow or job level); it does not check that the group is per branch;
//   - "has a path filter" means `paths:` or `paths-ignore:` inside the trigger block (for push or for another event).
// A finding is a hint, never a failure: the scan can be wrong, and only the owner knows which runs are needed.

/** The trigger block of a workflow text: { inline: string|null, block: string }. */
function triggerBlock(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const i = lines.findIndex((l) => /^(on|"on"|'on'|true)\s*:/.test(l));
  if (i < 0) return { inline: null, block: '' };
  const inline = lines[i].replace(/^[^:]*:\s*/, '').replace(/\s+#.*$/, '').trim() || null;
  const block = [];
  for (const l of lines.slice(i + 1)) {
    if (/^\S/.test(l) && !l.startsWith('#')) break;
    block.push(l.replace(/\s+#.*$/, ''));
  }
  return { inline, block: block.join('\n') };
}

/**
 * The CI cost findings for one workflow text: { push, concurrency, pathFilter } (push = it triggers on push).
 * @param {string} text
 */
function workflowCost(text) {
  const { inline, block } = triggerBlock(text);
  const push =
    (inline != null && /(^|[\s[,'"])push([\s\],'"]|$)/.test(inline)) ||
    /^\s+push\s*:/m.test(block) ||
    /^\s+-\s*push\s*$/m.test(block);
  const concurrency = /^\s*cancel-in-progress\s*:\s*(true\b|\$\{\{)/m.test(String(text ?? ''));
  const pathFilter = /^\s+paths(-ignore)?\s*:/m.test(block);
  return { push, concurrency, pathFilter };
}



module.exports = {
  DEFAULTS,
  MODES,
  pushSetup,
  setupProblems,
  summarize,
  parseRows,
  readBatch,
  batchVerdict,
  verdictWord,
  queueIdFromMerge,
  guardQuestion,
  ageText,
  boardBatch,
  triggerBlock,
  workflowCost,
};
