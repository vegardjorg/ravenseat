// =============================================================
// logic/conflicts.js: ownership conflicts between tasks, the blockers, and the per-list lookups.
//
// fileOverlap, conflictPart, conflict and conflictsWithActive (two tasks cannot own the same file, DB object or shared
// patch), blockerParts and blockers (dependencies, owner questions, batch queue, conflicts), and the lookups built on
// the fast index (perIdFor, activeFor, childrenMap, successors, lockUpCount).
//
// Part of the queueLogic.js split: lib/queueLogic.js re-exports every name, so callers keep requiring queueLogic.js.
// Used by queueLogic.js (the facade) and by logic/ranking.js, commits.js, batch.js, focus.js, select.js, pick.js,
// external.js, cloud.js, classify.js.
// Tested in lib/__tests__/queueBoardState.test.ts, queueLogic.test.ts and queueBoard.test.ts (through queueLogic.js).
// =============================================================

const { ACTIVE, isExternalRow, BATCHED_BLOCKER, isBatched } = require('./base.js');
const { indexFor } = require('./projects.js');

/** Normalizes a path: slashes, no leading ./. */
function norm(p) {
  return String(p).replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Do two file ownerships overlap? An entry that ends in "/" owns the whole folder.
 * Exact path otherwise. (Deliberately simple: glob patterns would give false security.)
 */
function fileOverlap(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (x === y) return true;
  if (x.endsWith('/') && y.startsWith(x)) return true;
  if (y.endsWith('/') && x.startsWith(y)) return true;
  return false;
}

/**
 * The comparison key for a DB object in `owner_db`: lower case, without quotes, without the default schema (`public.`)
 * and without an argument list. `users` and `public.users` are the same table, and `fn(uuid)` and `fn` the same
 * function name (two overloads of one function are treated as one: a false conflict only costs a wait, a missed one a
 * broken migration). Another schema stays: `auth.users` is not `users`.
 */
function dbKey(s) {
  return String(s ?? '')
    .trim()
    .replace(/"/g, '')
    .toLowerCase()
    .replace(/\s*\(.*$/, '')
    .replace(/^public\./, '');
}

/**
 * First conflict between a candidate and an active task, with the details (the guard rules on the board need
 * who and what, not just the text), or null.
 * @returns {{ type: 'file'|'db'|'patch', name: string, with: string, text: string } | null}
 */
function conflictPart(candidate, active) {
  // A record outside the queue (external add) is named after the session or person, so the blocker says who is working.
  // The text is built only when there actually is a conflict (conflictPart is called for every pair).
  const ownerText = () =>
    isExternalRow(active)
      ? `${active.id} (work outside the queue: ${active.external_name ?? '?'})`
      : active.id;
  for (const f of candidate.owned_files ?? []) {
    for (const g of active.owned_files ?? []) {
      if (fileOverlap(f, g))
        return {
          type: 'file',
          name: norm(f),
          with: active.id,
          text: `file ${norm(f)} is owned by ${ownerText()}`,
        };
    }
  }
  // The sets are built only when the candidate has something to compare (most have empty lists).
  const dbCandidate = candidate.owner_db ?? [];
  const dbActive = dbCandidate.length
    ? new Set((active.owner_db ?? []).map(dbKey))
    : null;
  for (const d of dbCandidate) {
    if (dbActive.has(dbKey(d)))
      return {
        type: 'db',
        name: d,
        with: active.id,
        text: `DB function ${d} is owned by ${ownerText()}`,
      };
  }
  // One dynamic patch of each shared function at a time (e.g. a common export or anonymization function).
  const patchCandidate = candidate.shared_patch ?? [];
  const patchActive = patchCandidate.length
    ? new Set((active.shared_patch ?? []).map((s) => s.toLowerCase()))
    : null;
  for (const d of patchCandidate) {
    if (patchActive.has(d.toLowerCase()))
      return {
        type: 'patch',
        name: d,
        with: active.id,
        text: `shared patch ${d} in progress in ${active.id}`,
      };
  }
  // A hotspot (shared config, lib/hotspots.js) is changed by one task at a time: hotspot_patch is a serial lock.
  for (const h of candidate.hotspot_patch ?? []) {
    for (const k of active.hotspot_patch ?? []) {
      if (fileOverlap(String(h).toLowerCase(), String(k).toLowerCase()))
        return {
          type: 'hotspot',
          name: norm(h),
          with: active.id,
          text: `hotspot ${norm(h)} is being changed by ${ownerText()}`,
        };
    }
  }
  return null;
}

/** First conflict between a candidate and an active task (as text), or null. */
function conflict(candidate, active) {
  return conflictPart(candidate, active)?.text ?? null;
}

/**
 * The blockers with details: [{ type, text, … }], where `text` is exactly what `blockers` gives. The types:
 * status (proposed, picked or another status), depends_on { id, status } (status null = unknown task),
 * question { sp }, and conflict { conflict: conflictPart }. (The limits are checked in selectNext.)
 */
function blockerParts(o, tasks, resolved = []) {
  if (o.status === 'proposed')
    return [{ type: 'status', text: `proposed (approve it first: ravenseat approve ${o.id})` }];
  if (o.status === 'picked')
    return [{ type: 'status', text: `picked by ${o.picked_by ?? '?'}` }];
  if (o.status !== 'waiting') return [{ type: 'status', text: `status ${o.status}` }];
  // A task in the batch queue is never started or picked alone; it is packed into a track (queue.mjs batch pack).
  if (isBatched(o)) return [{ type: 'batched', text: BATCHED_BLOCKER }];
  const h = [];
  const perId = perIdFor(tasks);
  for (const dep of o.depends_on ?? []) {
    const d = perId.get(dep);
    if (!d) h.push({ type: 'depends_on', id: dep, status: null, text: `depends on unknown ${dep}` });
    else if (d.status !== 'done')
      h.push({
        type: 'depends_on',
        id: dep,
        status: d.status,
        text: `waiting on ${dep} (${d.status})`,
      });
  }
  const resolvedSet = new Set(resolved);
  for (const sp of o.waiting_on ?? []) {
    if (!resolvedSet.has(sp)) h.push({ type: 'question', sp, text: `waiting on answer: ${sp}` });
  }
  // Copy, so a caller that changes a blocker never changes the buffered answer (conflictsWithActive).
  for (const k of conflictsWithActive(o, tasks))
    h.push({ type: 'conflict', conflict: { ...k }, text: k.text });
  return h;
}

/**
 * The conflicts between the candidate and each active task (conflictPart), in the order of the active ones. The board
 * asks blockerParts for the same card from several views (the card, nextUp, the plan basis, the areas, selectNext),
 * and each call walked all the active ones again. Inside withIndex the answer is therefore computed once per candidate
 * and reused (same condition as the rest of the fast index: the queue does not change while fn runs). Outside the
 * index it is computed again.
 */
function conflictsWithActive(o, tasks) {
  const ix = indexFor(tasks);
  if (ix) {
    ix.conflicts ??= new Map();
    const stored = ix.conflicts.get(o);
    if (stored) return stored;
  }
  const out = [];
  for (const a of activeFor(tasks)) {
    const k = conflictPart(o, a);
    if (k) out.push(k);
  }
  if (ix) ix.conflicts.set(o, out);
  return out;
}

/** Why can the task not be started now? Empty list = it can. (The limits are checked in selectNext.) */
function blockers(o, tasks, resolved = []) {
  return blockerParts(o, tasks, resolved).map((h) => h.text);
}

/** id → task (from the index when it applies; otherwise a new map). */
function perIdFor(tasks) {
  const ix = indexFor(tasks);
  if (!ix) return new Map(tasks.map((x) => [x.id, x]));
  ix.perId ??= new Map(tasks.map((x) => [x.id, x]));
  return ix.perId;
}

/** The tasks with an active status (ACTIVE), in queue order (from the index when it applies). */
function activeFor(tasks) {
  const ix = indexFor(tasks);
  if (!ix) return tasks.filter((x) => ACTIVE.has(x.status));
  ix.active ??= tasks.filter((x) => ACTIVE.has(x.status));
  return ix.active;
}

/** The successors per task: id → the ids that have it in `depends_on` (for successors; build it once for many calls). */
function childrenMap(tasks) {
  const ix = indexFor(tasks);
  if (ix) {
    ix.children ??= buildChildrenMap(tasks);
    return ix.children;
  }
  return buildChildrenMap(tasks);
}

function buildChildrenMap(tasks) {
  const children = new Map();
  for (const o of tasks) {
    for (const d of o.depends_on ?? []) {
      if (!children.has(d)) children.set(d, []);
      children.get(d).push(o.id);
    }
  }
  return children;
}

/**
 * Tasks that wait on this one, directly or indirectly (transitively through `depends_on`), and that still need doing
 * (not done or cancelled). Cycles are tolerated (each task is visited once), and the task itself is never included.
 * The same count as the bonus in the priority (lockUpCount) and "unlocks N" on the board.
 * @param {Map<string, string[]>} [children] childrenMap(tasks), when many tasks are looked up
 * @returns {string[]} the ids in the order they were found
 */
function successors(id, tasks, children) {
  // With the fast index (and the index's own childrenMap) each id is computed only once; the copy protects against the
  // caller sorting or changing the list (unlocksOf on the board sorts it).
  const ix = indexFor(tasks);
  if (ix && (children === undefined || children === childrenMap(tasks))) {
    if (!ix.after.has(id)) ix.after.set(id, computeSuccessors(id, tasks, childrenMap(tasks)));
    return [...ix.after.get(id)];
  }
  return computeSuccessors(id, tasks, children ?? childrenMap(tasks));
}

function computeSuccessors(id, tasks, children) {
  const set = new Set();
  const stack = [...(children.get(id) ?? [])];
  while (stack.length) {
    const x = stack.pop();
    if (set.has(x) || x === id) continue;
    set.add(x);
    stack.push(...(children.get(x) ?? []));
  }
  // Only tasks that still need doing count.
  const perId = perIdFor(tasks);
  return [...set].filter((x) => !['done', 'cancelled'].includes(perId.get(x)?.status));
}

/**
 * The open tasks' file ownership as a lookup: exact paths → ids, and the folder entries (ending in "/") as a list.
 * "Open" = not done or cancelled. Built once per index (withIndex), else once per call.
 */
function ownershipIndexFor(tasks) {
  const ix = indexFor(tasks);
  if (ix?.ownership) return ix.ownership;
  const exact = new Map();
  const folders = [];
  for (const x of tasks) {
    if (x.status === 'done' || x.status === 'cancelled') continue;
    for (const f of x.owned_files ?? []) {
      const p = norm(f);
      if (p.endsWith('/')) folders.push({ path: p, id: x.id });
      else {
        if (!exact.has(p)) exact.set(p, []);
        exact.get(p).push(x.id);
      }
    }
  }
  const out = { exact, folders };
  if (ix) ix.ownership = out;
  return out;
}

/**
 * The other open tasks (not done or cancelled) that own a file overlapping this task's owned_files (fileOverlap: exact,
 * or a folder entry either way). They cannot run at the same time as this one; the ranking uses the count to prefer a
 * short task on a contended file (scoreParts). The ids in the order they were found, each once.
 */
function contenders(o, tasks) {
  const own = (o.owned_files ?? []).map(norm);
  if (!own.length) return [];
  const { exact, folders } = ownershipIndexFor(tasks);
  const found = new Set();
  for (const p of own) {
    for (const id of exact.get(p) ?? []) found.add(id);
    for (const g of folders) if (fileOverlap(p, g.path)) found.add(g.id);
    // A folder this task owns overlaps every exact path below it.
    if (p.endsWith('/')) for (const [q, ids] of exact) if (q.startsWith(p)) for (const id of ids) found.add(id);
  }
  found.delete(o.id);
  return [...found];
}

/** How many tasks (directly or indirectly) wait on this one? Gives a bonus for unlocking others. */
function lockUpCount(id, tasks) {
  return successors(id, tasks).length;
}

module.exports = {
  norm,
  dbKey,
  contenders,
  fileOverlap,
  conflictPart,
  conflict,
  blockerParts,
  blockers,
  childrenMap,
  successors,
  lockUpCount,
};
