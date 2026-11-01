// =============================================================
// logic/batch.js: the batch queue: small, non-blocking tasks packed into one track of the right size.
//
// batchedError and smallTaskError (the add/edit rules), batchGroups, batchId, batchSuggestion, batchPack and
// batchMissionText. The small predicates (isBatched, inBatchQueue, BATCHED_BLOCKER) live in logic/base.js.
//
// Part of the queueLogic.js split: lib/queueLogic.js re-exports every name, so callers keep requiring queueLogic.js.
// Used by queueLogic.js (the facade) and by logic/edit.js.
// Tested in lib/__tests__/queueBatch.test.ts and queueSmall.test.ts (through queueLogic.js).
// =============================================================

const { WITHOUT_PROJECT, WITHOUT_FEATURE, isExternalRow, inBatchQueue, openTask, openQuestion } = require('./base.js');
const { projectFor, projectOrder } = require('./projects.js');
const { validate } = require('./validate.js');
const { norm, childrenMap, successors } = require('./conflicts.js');

// ---- Batch queue -----------------------------------------------------------------
// Small tasks that do not fit naturally into a track of the right size, and that do not block anything, are added with
// `batched: true` instead of becoming their own small tracks (fixed overhead is a large part of a small K track). They are shown, but never started or picked alone
// (the blocker `batched`). When a group (project → class) is large enough, the orchestrator packages it into one track with
// `queue.mjs batch pack`: a new task with a mission file that collects the originals in full, the originals cancelled with a
// remark, `depends_on` in other tasks redirected, and `merged_from` (same mechanics as other merging).

/**
 * The target size per class in content minutes (add-to-queue): `min` = lower target (a group is "ready for packing" from
 * this on), `measure` = the middle of the target, `max` = upper target (a package is not filled above this). D+ is never combined.
 */
const BATCH_MEASURE = {
  K: { min: 90, measure: 105, max: 120 },
  D: { min: 30, measure: 40, max: 50 },
  U: { min: 45, measure: 60, max: 75 },
};
/** The order the classes are shown in. */
const BATCH_CLASSES = ['K', 'D', 'U'];
const contentMin = (o) => Number(o?.content_min ?? 30) || 0;

/**
 * The rules for the batch queue on `add` and `edit` (called in addition to validate). `tasks` = the queue as it will be (on add:
 * the existing ones plus the new ones; the task itself may be included). Refuses `batched` for D+, for tasks that other
 * unfinished tasks depend on, for tasks that wait on an owner question that is not resolved, and for tasks
 * that are not waiting. Also refuses that a task depends on a task in the batch queue (it would never be started).
 * @returns {string[]} errors (empty = valid)
 */
function batchedError(o, tasks = [], resolved = []) {
  const error = [];
  if (!o || typeof o !== 'object') return error;
  if (o.batched != null && typeof o.batched !== 'boolean')
    error.push('batched must be true or false');
  if (o.batched === true) {
    if (o.class === 'D+')
      error.push('batched: D+ is never combined with others; add it as its own track');
    if (o.status && o.status !== 'waiting' && o.status !== 'proposed')
      error.push(`batched: only waiting tasks can sit in the batch queue (status ${o.status})`);
    const dependents = tasks
      .filter((x) => x.id !== o.id && openTask(x) && (x.depends_on ?? []).includes(o.id))
      .map((x) => x.id);
    if (dependents.length)
      error.push(
        `batched: ${dependents.join(', ')} depends on ${o.id}; a task that blocks something should not be in the batch queue`,
      );
    const sp = openQuestion(o, resolved);
    if (sp.length)
      error.push(
        `batched: ${o.id} waits on owner questions that are not resolved (${sp.join(', ')}); it does not belong in the batch queue until they are answered`,
      );
  }
  const perId = new Map(tasks.map((x) => [x.id, x]));
  for (const dep of o.depends_on ?? []) {
    const d = perId.get(dep);
    if (d && d.id !== o.id && inBatchQueue(d))
      error.push(
        `depends on ${dep}, which is in the batch queue and is not started alone (pack it or take it out first: cq edit ${dep} --json '{"batched":false}')`,
      );
  }
  return error;
}

/**
 * The small task guard: a small task should not become its own track, because the fixed
 * cost per track (startup, worktree, gates, merge) is larger than the content. Called on `add`, and only kicks in
 * when `content_min` is set explicitly and is below the lower target for the class (BATCH_MEASURE.min). Exceptions: D+ (never
 * combined), tasks that wait on an owner question, tasks that other open tasks depend on, and
 * `own_track: "<reason>"` (deliberately its own track, e.g. on the owner's word).
 *   - Without `value` the priority is uncertain: ask the owner (with a recommendation) before the task is added.
 *   - content_min <= SMALL_FIX_MIN: not in the queue. The owner chooses "fix now" (recommended) or the batch queue (`batched: true`).
 *   - Otherwise, with low priority (value <= SMALL_LOW_VALUE): the batch queue (`batched: true`), which packages it into a track of
 *     sensible size (`queue.mjs batch`). High priority can be its own track.
 * @returns {string[]} errors (empty = valid)
 */
const SMALL_FIX_MIN = 10;
const SMALL_LOW_VALUE = 7;
function smallTaskError(o, tasks = [], resolved = []) {
  if (!o || typeof o !== 'object') return [];
  const error = [];
  const ownTrack = typeof o.own_track === 'string' && !!o.own_track.trim();
  if (o.own_track != null && !ownTrack)
    error.push('own_track must be a short reason (text), e.g. "the owner asked for its own track"');
  if (typeof o.content_min !== 'number' || o.class === 'D+' || ownTrack) return error;
  if (o.content_min >= (BATCH_MEASURE[o.class]?.min ?? 0)) return error;
  if (openQuestion(o, resolved).length) return error;
  const blocks = tasks.some(
    (x) => x.id !== o.id && openTask(x) && (x.depends_on ?? []).includes(o.id),
  );
  if (blocks) return error;
  const min = o.content_min;
  if (o.value == null) {
    error.push(
      `small task (${min} min) without value: the priority is uncertain. Ask the owner (with a recommendation) and set value`,
    );
  } else if (min <= SMALL_FIX_MIN && o.batched !== true) {
    error.push(
      `small task (${min} min, the limit is ${SMALL_FIX_MIN}): do not add it to the queue. Ask the owner: fix now (recommended) or batch queue ("batched": true). Deliberately its own track: "own_track": "<reason>"`,
    );
  } else if (min > SMALL_FIX_MIN && o.value <= SMALL_LOW_VALUE && o.batched !== true) {
    error.push(
      `small task with low priority (${min} min, below ${BATCH_MEASURE[o.class].min} for ${o.class}, value ${o.value}): add it to the batch queue with "batched": true. Deliberately its own track: "own_track": "<reason>"`,
    );
  }
  return error;
}

/** The common value when all have the same, otherwise the first (project, feature, domain). */
function commonOrFirst(values) {
  const v = values.filter((x) => x != null && x !== '');
  return v.length ? v[0] : null;
}
/** Union of the list field over the tasks, in the order they first occur. */
function unionField(parts, field) {
  const out = [];
  for (const o of parts) for (const x of o[field] ?? []) if (!out.includes(x)) out.push(x);
  return out;
}

/**
 * The batch queue grouped project → class, with the sum of content minutes against the target for the class. Deterministic: projects in
 * the register's order (like `show --grouped`), the classes K, D, U (D+ last, marked invalid), tasks by feature
 * and id. `ready` = the sum has reached the lower target (K 90, D 30, U 45). `common_files` = owned files that several in the group own.
 * @returns {{ pid, title, class, measure, sum, count, ready, over, invalid, tasks, features, common_files }[]}
 */
function batchGroups(queue) {
  const register = queue.projects ?? {};
  const perGroup = new Map();
  for (const o of (queue.tasks ?? []).filter(inBatchQueue)) {
    const pid = projectFor(o, register);
    const key = `${pid}\u0000${o.class}`;
    if (!perGroup.has(key)) perGroup.set(key, { pid, class: o.class, parts: [] });
    perGroup.get(key).parts.push(o);
  }
  const pids = new Set([...perGroup.values()].map((g) => g.pid));
  const classRank = (k) => (BATCH_CLASSES.includes(k) ? BATCH_CLASSES.indexOf(k) : 99);
  const featureFor = (o) =>
    typeof o.feature === 'string' && o.feature.trim() ? o.feature.trim() : WITHOUT_FEATURE;
  const out = [];
  for (const pid of projectOrder(pids, register)) {
    const groups = [...perGroup.values()]
      .filter((g) => g.pid === pid)
      .sort(
        (x, y) =>
          classRank(x.class) - classRank(y.class) ||
          String(x.class).localeCompare(String(y.class)),
      );
    for (const g of groups) {
      const parts = [...g.parts].sort((x, y) => {
        const fx = featureFor(x);
        const fy = featureFor(y);
        if (fx !== fy)
          return fx === WITHOUT_FEATURE ? 1 : fy === WITHOUT_FEATURE ? -1 : fx.localeCompare(fy, 'en');
        return x.id.localeCompare(y.id);
      });
      const measure = BATCH_MEASURE[g.class] ?? null;
      const sum = parts.reduce((s, o) => s + contentMin(o), 0);
      const features = [];
      for (const o of parts) {
        const f = featureFor(o);
        let row = features.find((x) => x.feature === f);
        if (!row) features.push((row = { feature: f, sum: 0, ids: [] }));
        row.sum += contentMin(o);
        row.ids.push(o.id);
      }
      const countFile = new Map();
      for (const o of parts)
        for (const f of new Set((o.owned_files ?? []).map(norm)))
          countFile.set(f, (countFile.get(f) ?? 0) + 1);
      out.push({
        pid,
        title: register?.[pid]?.title ?? null,
        class: g.class,
        measure,
        sum,
        count: parts.length,
        ready: !!measure && sum >= measure.min,
        over: !!measure && sum > measure.max,
        invalid: !measure,
        features,
        common_files: [...countFile.entries()]
          .filter(([, n]) => n > 1)
          .map(([f]) => f)
          .sort(),
        tasks: parts.map((o) => ({
          id: o.id,
          title: o.title ?? '',
          status: o.status,
          content_min: contentMin(o),
          feature: featureFor(o),
          owned_files: o.owned_files ?? [],
        })),
      });
    }
  }
  return out;
}

/** A new, free id for a package: the project's first prefix + "S<n>" (A-S1), otherwise BATCH-<n>. */
function batchId(pid, register, used) {
  const pre = register?.[pid]?.prefixes?.[0];
  const base = pre ? (/[-._]$/.test(pre) ? pre : `${pre}-`) : 'BATCH-';
  for (let n = 1; ; n++) {
    const id = `${base}S${n}`;
    if (!used.has(id)) return id;
  }
}

/**
 * Proposed packages for the groups that are ready (`queue.mjs batch pack --auto`). Within a group the packages are filled in
 * the group's order (feature, id) up toward the upper target; a package is closed when the next task would pass the upper target and
 * the package has reached the lower target. A rest below the lower target stays in the batch queue. Tasks with different open owner questions
 * are never packed together. A "package" with one task that alone has reached the target is proposed to be taken out of the batch queue (`out: true`).
 * Deterministic; changes nothing.
 * @returns {{ id: string|null, pid: string, class: string, parts: string[], sum: number, out: boolean }[]}
 */
function batchSuggestion(queue) {
  const register = queue.projects ?? {};
  const perId = new Map((queue.tasks ?? []).map((o) => [o.id, o]));
  const used = new Set(perId.keys());
  const out = [];
  for (const g of batchGroups(queue)) {
    if (!g.ready || g.invalid) continue;
    // Split on open owner questions (normally none: the batch queue does not accept such), in order of first occurrence.
    const perSp = new Map();
    for (const r of g.tasks) {
      const k = openQuestion(perId.get(r.id), queue.resolved).join(',');
      if (!perSp.has(k)) perSp.set(k, []);
      perSp.get(k).push(r);
    }
    for (const rows of perSp.values()) {
      const packages = [];
      let cur = { parts: [], sum: 0 };
      for (const r of rows) {
        if (cur.parts.length && cur.sum + r.content_min > g.measure.max && cur.sum >= g.measure.min) {
          packages.push(cur);
          cur = { parts: [], sum: 0 };
        }
        cur.parts.push(r.id);
        cur.sum += r.content_min;
      }
      if (cur.parts.length && cur.sum >= g.measure.min) packages.push(cur);
      for (const p of packages) {
        const alone = p.parts.length === 1;
        const id = alone ? null : batchId(g.pid, register, used);
        if (id) used.add(id);
        out.push({ id, pid: g.pid, class: g.class, parts: p.parts, sum: p.sum, out: alone });
      }
    }
  }
  return out;
}

/**
 * Packages the tasks `ids` into one new track `newId` (`queue.mjs batch pack`). ALL OR NOTHING: everything is checked before anything
 * is changed, and on error `queue` is untouched. Requirements: at least two tasks, all waiting (or proposed), same class (K and D are thus
 * never mixed), not D+, equal open owner questions, new id free and valid, and no cycle (a part cannot depend on
 * something that itself waits on another part). The fields are combined: content_min sum, value and migr_tens max, depends_on
 * union minus the parts, owned_files/owner_db/shared_patch/requires/labels/waiting_on union, project/feature/domain common
 * or first, source "id: source | …", `merged_from`. The originals become `cancelled` with the remark "merged into
 * <newId>", and `depends_on` in all other open tasks is redirected to the new one. Status: waiting when all parts are waiting,
 * otherwise proposed. The caller writes the mission file (batchMissionText).
 * @param {{ newId: string, title?: string, mission: string, by?: string, now?: string }} option
 * @returns {{ error: string[] } | { error: [], new: object, cancelled: string[], redirected: string[] }}
 */
function batchPack(queue, ids, { newId, title, mission, by, now = new Date().toISOString() } = {}) {
  const tasks = queue.tasks ?? [];
  const register = queue.projects ?? {};
  const perId = new Map(tasks.map((o) => [o.id, o]));
  const error = [];
  const list = [...(ids ?? [])];
  if (new Set(list).size !== list.length) error.push('the same id appears more than once');
  if (list.length < 2)
    error.push(
      'pack requires at least two tasks (one task is taken out with cq edit <id> --json \'{"batched":false}\')',
    );
  if (!newId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/.test(newId))
    error.push('--id <new-id> missing or has invalid characters');
  else if (perId.has(newId)) error.push(`id ${newId} already exists`);
  const parts = [];
  for (const id of list) {
    const o = perId.get(id);
    if (!o) error.push(`unknown task ${id}`);
    else if (isExternalRow(o)) error.push(`${id} is a record outside the queue`);
    else if (o.status !== 'waiting' && o.status !== 'proposed')
      error.push(`${id} has status ${o.status} (only pending and proposed tasks can be packed)`);
    else parts.push(o);
  }
  if (parts.some((o) => o.class === 'D+')) error.push('D+ is never combined with others');
  const classes = [...new Set(parts.map((o) => o.class))];
  if (classes.length > 1)
    error.push(`different classes (${classes.join(', ')}); K and D (and U) are never packed together`);
  const spSet = [...new Set(parts.map((o) => openQuestion(o, queue.resolved).join(',')))];
  if (spSet.length > 1)
    error.push(
      `different open owner questions (${parts.map((o) => `${o.id}: ${openQuestion(o, queue.resolved).join(', ') || 'none'}`).join('; ')}); such tasks are never packed together`,
    );
  if (error.length) return { error };

  const partIds = new Set(list);
  const depends_on = unionField(parts, 'depends_on').filter((d) => !partIds.has(d) && d !== newId);
  // Cycle: an external predecessor that itself (transitively) waits on one of the parts would wait on the new track.
  const children = childrenMap(tasks);
  const after = new Set(list.flatMap((id) => successors(id, tasks, children)));
  const cycle = depends_on.filter((d) => after.has(d));
  if (cycle.length)
    return {
      error: [
        `would create a cycle: ${cycle.join(', ')} itself waits on one of the parts; pack them together or split differently`,
      ],
    };

  const first = parts[0];
  const pids = parts.map((o) => projectFor(o, register));
  const sources = parts.filter((o) => o.source).map((o) => `${o.id}: ${o.source}`);
  const fresh = {
    value: Math.max(...parts.map((o) => Number(o.value ?? 5))),
    content_min: parts.reduce((s, o) => s + contentMin(o), 0),
    migr_tens: Math.max(...parts.map((o) => Number(o.migr_tens ?? 0))),
    depends_on,
    waiting_on: unionField(parts, 'waiting_on'),
    owned_files: unionField(parts, 'owned_files'),
    owner_db: unionField(parts, 'owner_db'),
    shared_patch: unionField(parts, 'shared_patch'),
    id: newId,
    title:
      String(title ?? '').trim() ||
      `Combined track (${parts.length}): ${parts.map((o) => o.title ?? o.id).join(' + ')}`,
    domain: commonOrFirst(parts.map((o) => o.domain)),
    project: pids[0],
    class: first.class,
    mission,
    ...(sources.length ? { source: sources.join(' | ') } : {}),
    added_by: by ?? 'cq batch pack',
    merged_from: list,
  };
  const feature = commonOrFirst(
    parts.map((o) => (typeof o.feature === 'string' ? o.feature.trim() : null)),
  );
  if (feature) fresh.feature = feature;
  for (const field of ['requires', 'labels']) {
    const u = unionField(parts, field);
    if (u.length) fresh[field] = u;
  }
  if (fresh.project === WITHOUT_PROJECT) delete fresh.project;
  fresh.status = parts.every((o) => o.status === 'waiting') ? 'waiting' : 'proposed';
  fresh.added_at = now;
  // Same validation as add (without tasks that are cancelled in the same write).
  const vf = validate(fresh, tasks, register);
  if (vf.length) return { error: vf.map((f) => `${newId}: ${f}`) };

  // ---- Execute (everything is checked) ----
  for (const o of parts) {
    o.status = 'cancelled';
    o.remarks = [...(o.remarks ?? []), `${now} merged into ${newId}`];
  }
  const redirected = [];
  for (const o of tasks) {
    if (partIds.has(o.id) || !openTask(o) || !(o.depends_on ?? []).some((d) => partIds.has(d)))
      continue;
    const newOnes = [];
    for (const d of o.depends_on) {
      const x = partIds.has(d) ? newId : d;
      if (!newOnes.includes(x)) newOnes.push(x);
    }
    o.depends_on = newOnes;
    redirected.push(o.id);
  }
  queue.tasks.push(fresh);
  return { error: [], new: fresh, cancelled: list, redirected };
}

/**
 * The mission file for a packed track: introduction (order, commit per part, the union is in the queue task) and each part's
 * original track description in full. `texts`: id → { text, path } (path = the mission file the part came from, or
 * null when the mission was text in the queue file).
 */
function batchMissionText(fresh, parts, texts, now = new Date().toISOString()) {
  const date = String(now).slice(0, 10);
  const lines = [
    `# ${fresh.id}: combined track (${parts.length} parts, ${fresh.class}, approx. ${fresh.content_min} content minutes)`,
    '',
    `Combined track of ${parts.map((o) => o.id).join(', ')} (batch queue, cq batch pack ${date}, to save fixed ` +
      'overhead per track). Do them in this order, and commit per part (the commit message mentions the part id, e.g. ' +
      `"${parts[0].id}: …"). Each part below is the original track description unchanged; "Depends on" inside the parts ` +
      'that points to another part in this track is fulfilled by doing the parts in order. Owned files, owned DB and ' +
      `dependencies for the whole track are the union of the parts (in the queue task ${fresh.id}). Report per part at the end.`,
    '',
    'Order:',
    ...parts.map(
      (o, i) => `${i + 1}. ${o.id}: ${o.title ?? ''} (${o.class}, ${contentMin(o)} min)`,
    ),
    '',
  ];
  for (const o of parts) {
    const t = texts.get(o.id) ?? { text: '', path: null };
    lines.push(
      '',
      '---',
      '',
      `## Part ${o.id}: ${o.title ?? ''}`,
      '',
      t.path
        ? `(Original mission file: \`${t.path}\`)`
        : '(The original mission was text in the queue file.)',
      '',
      String(t.text ?? '').trimEnd(),
      '',
    );
  }
  return lines.join('\n');
}

module.exports = {
  BATCH_MEASURE,
  batchedError,
  SMALL_FIX_MIN,
  SMALL_LOW_VALUE,
  smallTaskError,
  batchGroups,
  batchId,
  batchSuggestion,
  batchPack,
  batchMissionText,
};
