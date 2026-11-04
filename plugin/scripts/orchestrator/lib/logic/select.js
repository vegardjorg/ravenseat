// =============================================================
// logic/select.js: selecting the next tasks, the taken migration blocks, and the queue state.
//
// selectNext (ranked order within the limits, checked against each other), the migration blocks (assignMigrBlock,
// migrTens, blockInterval, takenBlocks, assignStartBlock, parseMoveBlock, moveBlockInText) and state (what can start
// now and why not, for show, the board and the loops).
//
// Part of the queueLogic.js split: lib/queueLogic.js re-exports every name, so callers keep requiring queueLogic.js.
// Used by queueLogic.js (the facade) and by logic/pick.js, agents.js, monitor.js.
// Tested in lib/__tests__/queueMigrBlock.test.ts, queueFocus.test.ts, loadSlots.test.ts and queueExternal.test.ts
// (through queueLogic.js).
// =============================================================

const { cfg, estimate, hasMigr, isBatched, inBatchQueue } = require('./base.js');
const { projectFor } = require('./projects.js');
const { conflict, blockers } = require('./conflicts.js');
const { blockersWithPause, parkedNow, rankingContext, ranking, compareRanking } = require('./ranking.js');
const { migrBlockText } = require('./questions.js');
const { uncommittedCollision } = require('./commits.js');
const { spaceUse, startGuard, loadSlotsFor } = require('./guards.js');
const { focusStatus } = require('./focus.js');

/**
 * Selects tasks that can be started now, in ranked order, within the limits.
 * The candidates are also checked against each other: two chosen tasks cannot own the same thing.
 * Projects with `pause` are skipped, and the project's `priority_bonus` is added to the task's priority.
 * A picked task (person/session) owns its files and counts toward maxDb and maxPerDomain (it is tested and merged
 * like a track), but not toward maxConcurrent/maxDPlus, which apply to the queue's agents.
 * `uncommitted`: the paths `git status` shows in the main tree. A task that owns one of them is skipped (another
 * session is working in the file); `uncommittedSkipped` says which and why.
 * `skip`: ids that must not be chosen now (the tasks waiting on an intake triage verdict, lib/queueTriage.js); the
 * next ones in the order take their slots, so the parallelism is kept.
 */
function selectNext(queue, now = Date.now(), { uncommitted = [], load = null, skip = null } = {}) {
  // The fix task for a red base (added by the base gate or the CI watch) is the only way forward: every delivery in review
  // holds a slot and cannot merge until the base is green, so waiting for a free slot could wait for ever. It goes ahead
  // of the slot count and the load-aware slots. The hard stops (the machine is full, budget, wind-down) still apply.
  const fixesTheBase = (o) => o.added_by === 'base gate' || o.added_by === 'ci watch';
  const tasks = queue.tasks ?? [];
  const register = queue.projects ?? {};
  const use = spaceUse(queue);
  const g = use.limits;
  let { available, dPlus, db } = use;
  // Load-aware slots (lib/loadSlots.js): with a measurement, fewer slots open under load. Without one (most callers),
  // exactly maxConcurrent as before.
  if (load) available = Math.min(available, loadSlotsFor(queue, load).newSlots);
  const perDomain = use.perDomain;

  // Common ranking (parked, paused and outside focus are out; then focusStep, score, id). Without focus and
  // without parked this is exactly the old filter (pause) and the old sorting (score, id).
  const k = rankingContext(queue, now);
  const candidates = tasks
    .filter(
      (o) =>
        o.status === 'waiting' &&
        !skip?.has?.(o.id) &&
        blockers(o, tasks, queue.resolved).length === 0 &&
        !uncommittedCollision(o, uncommitted),
    )
    .map((o) => ({ o, r: ranking(o, queue, k) }))
    .filter((x) => !x.r.out)
    .sort(compareRanking)
    .map(({ o, r }) => ({ o, s: r.score, r }));

  const selected = [];
  for (const { o, s, r } of candidates) {
    if (available <= 0 && !fixesTheBase(o)) continue;
    if (o.class === 'D+' && dPlus >= g.maxDPlus) continue;
    if (hasMigr(o) && db >= g.maxDb) continue;
    if ((perDomain.get(o.domain) ?? 0) >= g.maxPerDomain) continue;
    if (selected.some((v) => conflict(o, v.o) || conflict(v.o, o))) continue;
    selected.push({ o, s, r });
    available -= 1;
    if (o.class === 'D+') dPlus += 1;
    if (hasMigr(o)) db += 1;
    perDomain.set(o.domain, (perDomain.get(o.domain) ?? 0) + 1);
  }
  return selected.map(({ o, s, r }) => ({
    id: o.id,
    score: s,
    estimate: estimate(o),
    class: o.class,
    domain: o.domain,
    project: projectFor(o, register),
    // Only when the focus applies (otherwise the same row as before): the stage (0-based, null = rest with `fill`) and pulled along.
    ...(k.applies ? { step: r.step, dragged_by: r.dragged_by } : {}),
  }));
}

/**
 * Assigns the next free migration block. A task with `migr_tens` > 0 gets that many blocks of `size` numbers
 * (config().migrations.blockSize, default 10), and the block starts on a whole multiple of the size.
 * Blocks in `taken` (takenBlocks: a migration file, the block of a task that is not finished, or a block named in an
 * active prompt file, e.g. after a move by hand) are skipped, and `skipped` lists them. Without `taken` the answer is
 * the same as before.
 * Returns { from, to, nextAvailable, skipped? }.
 */
function assignMigrBlock(nextAvailable, tens, size = 10, taken = []) {
  if (!tens || tens <= 0) return { from: null, to: null, nextAvailable };
  const s = Number(size) > 0 ? Math.floor(Number(size)) : 10;
  let from = Math.ceil(nextAvailable / s) * s;
  const skipped = [];
  for (;;) {
    const to = from + tens * s - 1;
    const hit = taken.filter((t) => t.from <= to && t.to >= from);
    if (!hit.length) return { from, to, nextAvailable: to + 1, ...(taken.length ? { skipped } : {}) };
    skipped.push(...hit);
    from = Math.ceil((Math.max(...hit.map((t) => t.to)) + 1) / s) * s;
  }
}

/**
 * How many migration blocks the task should have: `migr_tens`, but 0 when the project has no migration flow
 * (config().migrations.folder is null). Then no task gets a block, and nothing is blocked by migrations.
 */
function migrTens(o, migrations = cfg().migrations) {
  if (!migrations?.folder) return 0;
  const t = Number(o?.migr_tens ?? 0);
  return Number.isFinite(t) && t > 0 ? t : 0;
}

// ---- Taken migration blocks ----------------------------------------------------------------------------------
// `fill` could hand out a block that a running track already had: the orchestrator moved the block by hand in the
// prompt file, but the queue (migr_block) and next_migr did not know, so the next fill got the same block. Free now
// means: not a migration file in migrations.folder, not the block of a task that is not finished, and not named in an
// active prompt file in the scratchpad.

/** Statuses in which a task no longer holds its block. */
const MIGR_FREE_STATUS = new Set(['done', 'cancelled']);

/** A block in text: "3450–3459" or "3450-3459" (en dash or hyphen, spaces allowed). The end can be short ("3450–59"). */
const BLOCK_PATTERN = /(?<!\d)(\d+)\s*[–-]\s*(\d+)(?!\d)/;

/**
 * "3450–3459" (en dash or hyphen, possibly with text around it) → { from: 3450, to: 3459 }, otherwise null. A short
 * end number ("2340–49") is filled in from the start.
 */
function blockInterval(text) {
  const m = BLOCK_PATTERN.exec(String(text ?? ''));
  if (!m) return null;
  const from = Number(m[1]);
  let to = Number(m[2]);
  if (to < from) {
    const s = String(from);
    to = Number(s.slice(0, Math.max(0, s.length - m[2].length)) + m[2]);
  }
  return to >= from ? { from, to } : null;
}

/**
 * All blocks named in a text (a prompt file), as intervals. Only lines that say "migration block" count, so line
 * ranges and dates elsewhere in the mission are never read as a block.
 */
function blocksInText(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!/migration block/i.test(line)) continue;
    for (const m of line.matchAll(new RegExp(BLOCK_PATTERN.source, 'g'))) {
      const b = blockInterval(m[0]);
      if (b) out.push(b);
    }
  }
  return out;
}

/** The last part of a path (/ or \). */
const fileName = (p) =>
  String(p ?? '')
    .split(/[\\/]/)
    .pop();

/** The task id a prompt file belongs to: "prompt-A-4.md" and "prompt-A-4-r2.md" → "A-4". */
function promptTask(name, tasks = []) {
  const m = /^prompt-(.+)\.md$/.exec(fileName(name));
  if (!m) return null;
  const ids = new Set(tasks.map((o) => o.id));
  if (ids.has(m[1])) return m[1];
  const without = m[1].replace(/-r\d+$/, '');
  return ids.has(without) ? without : m[1];
}

/**
 * The blocks that are taken, as { from, to, source }. `fileNrs`: the numbers of the migration files in the main tree
 * (the first group in migrations.filePattern). `prompts`: [{ name, text }] from the scratchpad; a prompt file counts
 * when its task is not done or cancelled (an unknown id counts too: rather one block too many than a collision).
 * `except`: the task itself (for move and start).
 */
function takenBlocks({ tasks = [], fileNrs = [], prompts = [], except = null } = {}) {
  const taken = [];
  for (const n of fileNrs) {
    const v = Number(n);
    if (Number.isFinite(v) && v > 0) taken.push({ from: v, to: v, source: 'migration file' });
  }
  for (const o of tasks) {
    if (o.id === except || MIGR_FREE_STATUS.has(o.status)) continue;
    const b = blockInterval(o.migr_block);
    if (b) taken.push({ ...b, source: `task ${o.id}` });
  }
  const status = new Map(tasks.map((o) => [o.id, o.status]));
  for (const p of prompts) {
    const id = promptTask(p.name, tasks);
    if (!id || id === except || MIGR_FREE_STATUS.has(status.get(id))) continue;
    for (const b of blocksInText(p.text)) taken.push({ ...b, source: fileName(p.name) });
  }
  return taken;
}

/**
 * Assigns the block for a start (common for `start`, `fill` and `pick`): the next free one from `queue.next_migr`
 * past `taken`, and moves `next_migr` past it (never backward). The new block is added to `taken`, so several starts in
 * the same call get different blocks.
 * @returns {{ block: string|null, skipped: object[] }}
 */
function assignStartBlock(queue, o, taken = [], migrations = cfg().migrations) {
  const b = assignMigrBlock(
    Number(queue.next_migr),
    migrTens(o, migrations),
    migrations?.blockSize,
    taken,
  );
  if (b.from == null) return { block: null, skipped: [] };
  queue.next_migr = Math.max(Number(queue.next_migr) || 0, b.nextAvailable);
  taken.push({ from: b.from, to: b.to, source: `task ${o.id}` });
  return { block: migrBlockText(b), skipped: b.skipped ?? [] };
}

/**
 * `queue.mjs migr move <id> <block>`: "3470" or "3470-3479" → { from, to }. With only the start given the block gets
 * as many blocks of `size` as the task has (`tens`, at least 1). Error: { error }.
 */
function parseMoveBlock(text, tens = 1, size = 10) {
  const s = String(text ?? '').trim();
  const z = Number(size) > 0 ? Math.floor(Number(size)) : 10;
  const m = /^(\d+)(?:\s*[–-]\s*(\d+))?$/.exec(s);
  if (!m) return { error: `invalid block "${s}" (e.g. 3470 or 3470-3479)` };
  const from = Number(m[1]);
  const b =
    m[2] != null ? blockInterval(s) : { from, to: from + Math.max(1, Number(tens) || 1) * z - 1 };
  if (!b || b.from % z !== 0 || (b.to + 1) % z !== 0)
    return {
      error: `the block ${b ? `${b.from}–${b.to}` : s} must cover whole blocks of ${z} (start on a multiple of ${z}, end just before one)`,
    };
  return b;
}

/**
 * Swaps the block in a prompt file: the "Migration block:" line and every mention of the old block (en dash or
 * hyphen, any spacing). The old block is both the queue's and the one the file itself names (an earlier move by hand
 * only stands in the file). No String.replace with a replacement string ("$'" duplicates text): callbacks only.
 */
function moveBlockInText(text, old, fresh) {
  const freshText = migrBlockText(fresh);
  let t = String(text ?? '');
  const inFile = blockInterval((/^Migration block:.*$/m.exec(t) ?? [''])[0]);
  t = t.replace(/^Migration block:.*$/m, () => `Migration block: ${freshText}`);
  const olds = [old, inFile].filter((g) => g && !(g.from === fresh.from && g.to === fresh.to));
  if (!olds.length) return t;
  return t.replace(new RegExp(BLOCK_PATTERN.source, 'g'), (hit) => {
    const b = blockInterval(hit);
    return b && olds.some((g) => g.from === b.from && g.to === b.to) ? freshText : hit;
  });
}

/**
 * Is the queue out of work? Empty = nothing running and nothing can be started. Also returns what is blocked.
 * With `dailyUsage` (USD today, from timeCost.js) and a daily budget that is used up, nothing can
 * be started (stop: 'dailyBudget'), so the loop stops when the running ones are done.
 * `uncommitted`: as in selectNext; a task that is only stopped by an uncommitted file gets that as its blocker.
 * Night pause: with nightRun off and `now` inside the night window, nothing can be started either
 * (stop: 'nightPause', night: the message), the same way as the budget guard.
 */
function state(
  queue,
  dailyUsage,
  { uncommitted = [], now = Date.now(), cursor = null, load = null } = {},
) {
  const tasks = queue.tasks ?? [];
  // Active = what the orchestrator waits on (running or to be merged). A picked task does not keep the loop going:
  // the person or session that picked it delivers (review) or merges it itself.
  const activeOnes = tasks.filter((o) => o.status === 'running' || o.status === 'review');
  const picked = tasks.filter((o) => o.status === 'picked');
  // The batch queue is counted separately (it waits to be packed, not to be started).
  const waiting = tasks.filter((o) => o.status === 'waiting' && !isBatched(o));
  const batched = tasks.filter(inBatchQueue);
  const guard = startGuard(queue, dailyUsage, { now, cursor, load });
  const canStart = guard ? [] : selectNext(queue, now, { uncommitted, load });
  // Load-aware slots: why fewer slots are open (only when a measurement was given and the adaptive rule applies).
  const ls = load && !guard ? loadSlotsFor(queue, load) : null;
  const guardBlocker = guard?.stop === 'dailyBudget' ? 'the daily budget is used up' : guard?.summary;
  const rk = rankingContext(queue, now);
  const blocked = waiting
    .filter((o) => !canStart.some((k) => k.id === o.id))
    .map((o) => {
      const h = blockersWithPause(o, queue, rk);
      const u = h.length ? null : uncommittedCollision(o, uncommitted);
      if (u) h.push(`file ${u.path} is uncommitted in the main tree`);
      return {
        id: o.id,
        blockers: guard && !h.length ? [guardBlocker] : h,
      };
    });
  const parked = waiting.filter((o) => parkedNow(o, now)).length;
  // The owner question that unlocks the most tasks first.
  const question = new Map();
  for (const o of waiting) {
    for (const sp of o.waiting_on ?? []) {
      if (!(queue.resolved ?? []).includes(sp)) question.set(sp, (question.get(sp) ?? 0) + 1);
    }
  }
  return {
    activeOnes: activeOnes.length,
    picked: picked.length,
    waiting: waiting.length,
    proposed: tasks.filter((o) => o.status === 'proposed' && !isBatched(o)).length,
    batched: batched.length,
    qa: tasks.filter((o) => o.status === 'done' && o.qa_status === 'waiting').length,
    external: tasks.filter((o) => o.status === 'external').length,
    canStart: canStart.length,
    empty: activeOnes.length === 0 && canStart.length === 0,
    ...(guard?.stop === 'dailyBudget' ? { stop: 'dailyBudget', budget: guard.message } : {}),
    ...(guard?.stop === 'nightPause' ? { stop: 'nightPause', night: guard.message } : {}),
    ...(guard?.stop === 'windDown' ? { stop: 'windDown', windDown: guard.message } : {}),
    ...(guard?.stop === 'load' ? { stop: 'load', load: guard.message } : {}),
    // The effective slot count from the load (lib/loadSlots.js), e.g. "2 of 5 slots: free memory 18 % (...)".
    ...(ls?.active
      ? {
          loadSlots: {
            slots: ls.slots,
            max: ls.max,
            newSlots: ls.newSlots,
            limited: ls.limited,
            by: ls.by,
            text: ls.text,
          },
        }
      : {}),
    blocked,
    ownerQuestion: [...question.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([sp, n]) => ({ sp, tasks: n })),
    // Only when something is parked or a focus is set (otherwise the same answer as before).
    ...(parked ? { parked } : {}),
    ...(queue.focus
      ? {
          focus: focusStatus(queue, {
            now,
            canStart: canStart.map((x) => x.id),
            context: rk,
          }),
        }
      : {}),
  };
}

module.exports = {
  selectNext,
  assignMigrBlock,
  migrTens,
  MIGR_FREE_STATUS,
  blockInterval,
  blocksInText,
  promptTask,
  takenBlocks,
  assignStartBlock,
  parseMoveBlock,
  moveBlockInText,
  state,
};
