// =============================================================
// logic/commits.js: work outside the queue, the git side: commit classification, push plan and the orchestrator marker.
//
// classifyCommit (queue merge, orchestrator trailer or external), mentionedIds, consistency, pushPlan (a safe cut
// point), uncommittedCollision and uncommittedSkipped (tasks that collide with uncommitted files in the main tree),
// and the orchestrator cursor (orchestratorStatus, newCursor). The git reading itself lives in lib/queueGit.js; the
// rows for external work live in logic/external.js.
//
// Part of the queueLogic.js split: lib/queueLogic.js re-exports every name, so callers keep requiring queueLogic.js.
// Used by queueLogic.js (the facade) and by logic/guards.js, select.js, pick.js, external.js.
// Tested in lib/__tests__/queueExternal.test.ts and contextGuard.test.ts (through queueLogic.js).
// =============================================================

const { branchPrefix, isExternalRow, regexSafe } = require('./base.js');
const { norm, fileOverlap, blockers } = require('./conflicts.js');
const { rankingContext, focusSpace } = require('./ranking.js');

// ---- Work outside the queue ----------------------------------------------------------------------------
//
// Other sessions commit straight to baseBranch, create branches (hotfix/*) and have uncommitted files in the main tree. The queue must
// know about it: it does not start a track that collides, and it does not build something that is already done. The git reading lives in
// queueGit.js; here are only the decisions.

/** The trailer the orchestrator sets on its own commits on baseBranch: `git commit --trailer "Queue: orchestrator" …`. */
const ORCHESTRATOR_TRAILER = 'Queue: orchestrator';
const ORCHESTRATOR_TRAILER_PATTERN = /^Queue:[ \t]*orchestrator[ \t]*$/im;
/** The orchestrator cursor (scripts/.queue/orchestrator.json) is considered expired after this long without an update. */
const ORCHESTRATOR_EXPIRY_MS = 2 * 3_600_000;
/** Tasks that are compared with changes outside the queue (collisions), in display order. */
const COLLISION_STATUSES = ['running', 'picked', 'review', 'waiting'];

/** Does the commit message have the trailer "Queue: orchestrator" (on its own line)? */
function hasOrchestratorTrailer(message) {
  return ORCHESTRATOR_TRAILER_PATTERN.test(String(message ?? ''));
}

/**
 * The task id from the merge track message "Merge branch '<branchPrefix><id>' into <baseBranch>", otherwise null.
 * @param {string} subject
 * @param {string} [prefix] default config().branchPrefix
 */
function queueIdFromMerge(subject, prefix = branchPrefix()) {
  const m = new RegExp(`^Merge branch '${regexSafe(prefix)}([^']+)'`).exec(String(subject ?? ''));
  return m ? m[1] : null;
}

/**
 * Where does a commit on the base branch's first-parent line come from? `queue` = merge of a queue branch (merge-track.mjs, also a
 * picked task that the one who picked it merged themselves), `orchestrator` = the trailer "Queue: orchestrator", otherwise `external`.
 * A merge of another branch (hotfix/*, <remote>/<baseBranch>) is external; queueGit.js also looks at the commits it brings along.
 * @param {{ parents?: string[], subject?: string, message?: string }} c
 * @returns {{ source: 'queue'|'orchestrator'|'external', queue_id?: string }}
 */
function classifyCommit(c) {
  if ((c?.parents?.length ?? 0) >= 2) {
    const id = queueIdFromMerge(c.subject);
    if (id) return { source: 'queue', queue_id: id };
  }
  if (hasOrchestratorTrailer(c?.message)) return { source: 'orchestrator' };
  return { source: 'external' };
}

/**
 * The task ids that appear in the text as whole words: "(A-T8c)", "A-T8c:", "A-T8c." and "A-T8c" at the end match;
 * "A-T8c2", "A-T8c-QA1" and "XA-T8c" do not (then it is another id).
 */
function mentionedIds(text, ids) {
  const t = String(text ?? '');
  const out = [];
  for (const id of ids ?? []) {
    if (!id || !t.includes(id)) continue;
    const re = new RegExp(`(^|[^A-Za-z0-9_.-])${regexSafe(id)}(?![A-Za-z0-9_-])`);
    if (re.test(t)) out.push(id);
  }
  return out;
}

/**
 * Consistency: external commits that mention a task in the queue. For a pending task the suggestion is
 * `queue.mjs external accept <id> <sha>` (it may have been done outside the queue); this is never done automatically.
 * @param {{ sha: string, summary?: string, subject?: string, message?: string, side?: { message?: string }[] }[]} externalOnes
 * @returns {{ sha: string, summary: string, subject: string, id: string, status: string, proposed: string|null }[]}
 */
function consistency(externalOnes, tasks) {
  const perId = new Map((tasks ?? []).filter((o) => !isExternalRow(o)).map((o) => [o.id, o]));
  const ids = [...perId.keys()];
  const out = [];
  for (const c of externalOnes ?? []) {
    const summary = c.summary ?? String(c.sha).slice(0, 8);
    // The subject, the message and the messages of the commits an external merge brings along.
    const text = [c.subject, c.message, ...(c.side ?? []).map((s) => s.message)].join('\n');
    for (const id of mentionedIds(text, ids)) {
      const o = perId.get(id);
      out.push({
        sha: c.sha,
        summary,
        subject: c.subject ?? '',
        id,
        status: o.status,
        proposed: o.status === 'waiting' ? `cq external accept ${id} ${summary}` : null,
      });
    }
  }
  return out;
}

/**
 * The push check: the first-parent commits in <remote>/<baseBranch>..<baseBranch>, OLDEST FIRST, each with `source`.
 * - `externalOnes`: the commits with source external (empty = safe to push everything).
 * - `cutPoint`: the sha of the last commit before the first external one, when ALL commits from the first external one onward are
 *   external. The queue's and the orchestrator's part then sits together in front and can be pushed alone with `git push <remote> <sha>:<baseBranch>`.
 *   null when the first commit is already external (the queue has nothing to push alone) or when they are interleaved.
 * - `merged`: a queue or orchestrator commit comes after an external one. Then the external ones cannot be held back
 *   without rewriting history, and that is never done.
 */
function pushPlan(firstParents) {
  const list = firstParents ?? [];
  const i = list.findIndex((c) => c.source === 'external');
  const countOf = (k) => list.filter((c) => c.source === k).length;
  const common = { total: list.length, queue: countOf('queue'), orchestrator: countOf('orchestrator') };
  if (i < 0)
    return {
      ...common,
      externalOnes: [],
      cutPoint: null,
      merged: false,
      ownForCut: list.length,
    };
  const merged = list.slice(i).some((c) => c.source !== 'external');
  return {
    ...common,
    externalOnes: list.filter((c) => c.source === 'external'),
    cutPoint: !merged && i > 0 ? list[i - 1].sha : null,
    merged,
    ownForCut: i,
  };
}

/** The first owned file in the task that an uncommitted path in the main tree overlaps: { file (the owned file), path }, otherwise null. */
function uncommittedCollision(o, uncommitted) {
  for (const f of o?.owned_files ?? []) {
    for (const u of uncommitted ?? []) {
      const filePath = typeof u === 'string' ? u : u?.path;
      if (filePath && fileOverlap(f, filePath)) return { file: norm(f), path: norm(filePath) };
    }
  }
  return null;
}

/**
 * Tasks `next` skips because they collide with an uncommitted file in the main tree: the pending ones that could otherwise
 * be started (no blockers, the project not paused). [{ id, file, path }].
 */
function uncommittedSkipped(queue, uncommitted) {
  const tasks = queue.tasks ?? [];
  const rk = rankingContext(queue);
  const out = [];
  for (const o of tasks) {
    // What selectNext would not start anyway (paused, parked, outside focus) is not "skipped".
    if (o.status !== 'waiting' || focusSpace(o, rk).out) continue;
    const k = uncommittedCollision(o, uncommitted);
    if (k && blockers(o, tasks, queue.resolved).length === 0) out.push({ id: o.id, ...k });
  }
  return out;
}
/**
 * Is an orchestrator active? The cursor (scripts/.queue/orchestrator.json: { session, updated, event }) is updated by
 * the orchestrator on each loop round (`queue.mjs orchestrator pulse`, and by `start`/`set`), and is considered expired after 2 h.
 */
function orchestratorStatus(cursor, now = Date.now()) {
  if (!cursor || !cursor.updated)
    return { active: false, session: null, age_ms: null, reason: 'no marker' };
  const age = now - Date.parse(cursor.updated);
  if (!Number.isFinite(age))
    return { active: false, session: cursor.session ?? null, age_ms: null, reason: 'invalid timestamp' };
  const active = age <= ORCHESTRATOR_EXPIRY_MS;
  return {
    active,
    session: cursor.session ?? null,
    age_ms: age,
    event: cursor.event ?? null,
    reason: active ? null : 'expired (over 2 h without update)',
  };
}
/** New marker: the session name is the one given, otherwise the previous marker's, otherwise "orchestrator". */
function newCursor(previous, { session, event, now = new Date().toISOString() } = {}) {
  const name = String(session ?? '').trim() || previous?.session || 'orchestrator';
  const m = { session: name, updated: now, event: event ?? null };
  // The session binding (session_id/session_id_time, set by hook-context.mjs) and the wind-down flag carry over as
  // long as it is the same session (same name) and the cursor is not expired. A new name (or an expired marker) means that a
  // new session takes the cursor: then both are reset, and session_id_time is set to now, so only orchestrator calls made AFTER
  // the takeover can bind a session (contextGuard.orchestratorBinding).
  const live = previous != null && orchestratorStatus(previous, Date.parse(now)).active;
  if (live && name === previous.session) {
    if (previous.session_id) m.session_id = previous.session_id;
    if (previous.session_id_time != null) m.session_id_time = previous.session_id_time;
    if (previous.windDown) m.windDown = previous.windDown;
  } else if (previous) {
    m.session_id_time = Date.parse(now);
  }
  return m;
}

module.exports = {
  ORCHESTRATOR_TRAILER,
  ORCHESTRATOR_EXPIRY_MS,
  COLLISION_STATUSES,
  hasOrchestratorTrailer,
  queueIdFromMerge,
  classifyCommit,
  mentionedIds,
  consistency,
  pushPlan,
  uncommittedCollision,
  uncommittedSkipped,
  orchestratorStatus,
  newCursor,
};
