// =============================================================
// logic/external.js: rows for work outside the queue, and the track block.
//
// externalCollisions, collisionText, trackFileWarning, externalAdd, externalDone, externalAccept and missingProject
// (`queue.mjs external ...`), and trackBlock (the task block in the track file and the cloud package). The git side
// lives in logic/commits.js.
//
// Part of the queueLogic.js split: lib/queueLogic.js re-exports every name, so callers keep requiring queueLogic.js.
// Used by queueLogic.js (the facade) and by logic/cloud.js.
// Tested in lib/__tests__/queueExternal.test.ts (through queueLogic.js).
// =============================================================

const { baseBranch, ACTIVE, WITHOUT_PROJECT, estimate, isExternalRow, bonusBlock } = require('./base.js');
const { projectFor } = require('./projects.js');
const { validate } = require('./validate.js');
const { norm, fileOverlap, conflict } = require('./conflicts.js');
const { answerBlock } = require('./questions.js');
const { COLLISION_STATUSES } = require('./commits.js');
const { setStatus } = require('./pick.js');

/**
 * Collisions between work outside the queue and the owned files of tasks that are running, picked, in review or waiting.
 * @param {object[]} tasks the queue's tasks
 * @param {{ commits?: { sha: string, summary?: string, subject?: string, files: string[], date?: string }[],
 *           branches?: { name: string, files: string[] }[], uncommitted?: (string|{ path: string })[] }} sources
 *   commits = the external ones, with the date they landed on baseBranch; a commit counts only for tasks that were added
 *   BEFORE it landed. Branches (outside the queue branches, not merged) and uncommitted files always count.
 * @returns {{ id: string, status: string, file: string, owner: string, source: 'commit'|'branch'|'uncommitted',
 *             sha?: string, summary?: string, subject?: string, date?: string, branch?: string }[]}
 */
function externalCollisions(tasks, sources = {}, { statuses = COLLISION_STATUSES } = {}) {
  // Index path → sources, so each owned file is looked up instead of being compared with all changed files.
  const index = new Map();
  const addTo = (filePath, source) => {
    const s = norm(filePath ?? '');
    if (!s) return;
    if (!index.has(s)) index.set(s, []);
    index.get(s).push(source);
  };
  for (const c of sources.commits ?? []) {
    const summary = c.summary ?? String(c.sha).slice(0, 8);
    for (const f of c.files ?? [])
      addTo(f, { source: 'commit', sha: c.sha, summary, subject: c.subject ?? '', date: c.date });
  }
  for (const g of sources.branches ?? []) {
    for (const f of g.files ?? []) addTo(f, { source: 'branch', branch: g.name });
  }
  for (const u of sources.uncommitted ?? [])
    addTo(typeof u === 'string' ? u : u?.path, { source: 'uncommitted' });
  // Untracked folders ("?? new-folder/") own everything below them.
  const folders = [...index.keys()].filter((s) => s.endsWith('/'));

  const sequence = new Map(statuses.map((s, i) => [s, i]));
  const out = [];
  const set = new Set();
  for (const o of tasks ?? []) {
    if (isExternalRow(o) || !sequence.has(o.status)) continue;
    const addedAt = o.added_at ? Date.parse(o.added_at) : NaN;
    const match = (filePath, list, owner) => {
      for (const k of list) {
        // A commit that landed before the task was added is already part of the basis for the mission.
        if (
          k.source === 'commit' &&
          Number.isFinite(addedAt) &&
          k.date &&
          !(Date.parse(k.date) > addedAt)
        )
          continue;
        const key = `${o.id}|${filePath}|${k.source}|${k.sha ?? k.branch ?? ''}`;
        if (set.has(key)) continue;
        set.add(key);
        out.push({ id: o.id, status: o.status, file: filePath, owner, ...k });
      }
    };
    for (const e of o.owned_files ?? []) {
      const f = norm(e);
      if (f.endsWith('/')) {
        for (const [filePath, list] of index) if (fileOverlap(f, filePath)) match(filePath, list, f);
      } else {
        if (index.has(f)) match(f, index.get(f), f);
        for (const m of folders) if (f.startsWith(m)) match(m, index.get(m), f);
      }
    }
  }
  return out.sort((x, y) => sequence.get(x.status) - sequence.get(y.status) || x.id.localeCompare(y.id));
}

/** "<id>: the file X was changed outside the queue in <sha> "subject"" / "… on branch <branch>" / "… is uncommitted in the main tree". */
function collisionText(k, { withId = true } = {}) {
  const file = k.file === k.owner ? k.file : `${k.file} (under ${k.owner})`;
  const where =
    k.source === 'commit'
      ? `was changed outside the queue in ${k.summary} "${String(k.subject ?? '').slice(0, 70)}"`
      : k.source === 'branch'
        ? `was changed outside the queue on branch ${k.branch} (not in ${baseBranch()})`
        : 'is uncommitted in the main tree (another session is working in it)';
  return `${withId ? `${k.id}: ` : ''}the file ${file} ${where}`;
}

/**
 * The warning `trackFile` writes into the track block when the owned files have changed outside the queue since the task was added,
 * so the track reads the diff before it builds on an outdated mission. null when there is nothing to warn about.
 * @param {object} o the task
 * @param {object[]} collisions externalCollisions for this task
 * @param {{ summary: string, subject?: string }[]} mentioned external commits that mention the id
 */
function trackFileWarning(o, collisions = [], mentioned = []) {
  if (!collisions.length && !mentioned.length) return null;
  const MAX = 12;
  const lines = [
    `**WARNING from the queue (work outside the queue): your owned files have changed outside the queue since the task was added ` +
      `(${o.added_at ?? 'unknown time'}).** The mission may be outdated. Read the diff before you build on, and write in ` +
      'the report what no longer holds:',
  ];
  for (const k of collisions.slice(0, MAX)) {
    if (k.source === 'commit')
      lines.push(
        `- \`${k.file}\` in ${k.summary} "${String(k.subject ?? '').slice(0, 70)}": \`git show ${k.summary} -- ${k.file}\``,
      );
    else if (k.source === 'branch')
      lines.push(
        `- \`${k.file}\` on branch ${k.branch} (not merged to ${baseBranch()}): ` +
          `\`git diff ${baseBranch()}...${k.branch} -- ${k.file}\``,
      );
    else
      lines.push(
        `- \`${k.file}\` is uncommitted in the main tree: another session is working in the file. Do not touch it; report to the orchestrator.`,
      );
  }
  if (collisions.length > MAX)
    lines.push(`- … and ${collisions.length - MAX} more (cq external)`);
  if (mentioned.length)
    lines.push(
      `Commits outside the queue that mention ${o.id} (is something already done?): ` +
        mentioned
          .slice(0, 5)
          .map((c) => `${c.summary} "${String(c.subject ?? '').slice(0, 60)}"`)
          .join(', '),
    );
  return lines.join('\n');
}

/** Id for a new record outside the queue: external-<name as kebab-case>, with -2, -3 … when it already exists. */
function externalId(name, tasks = []) {
  const slug =
    String(name ?? '')
      .toLowerCase()
      .replace(/\u00E6/g, 'ae')
      .replace(/\u00F8/g, 'o')
      .replace(/\u00E5/g, 'a')
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 28)
      .replace(/-+$/, '') || 'session';
  const ids = new Set(tasks.map((o) => o.id));
  let id = `external-${slug}`;
  for (let n = 2; ids.has(id); n++) id = `external-${slug}-${n}`;
  return id;
}

/**
 * Registers work in progress outside the queue (`queue.mjs external add`): a row with status `external` that owns the files (and
 * the DB functions, if any) like a picked task, until `external done <name>`. The same name again while the row is active
 * adds the files (and sets the branch when given). Changes `queue` (the caller writes the file under lock).
 * @returns {{ error: string } | { row: object, new: boolean, warnings: string[] }}
 */
function externalAdd(
  queue,
  { name, files = [], db = [], branch = null, now = new Date().toISOString() } = {},
) {
  const who = String(name ?? '').trim();
  if (!who) return { error: 'external add requires --name "<session or person>"' };
  const newFiles = [...new Set((files ?? []).map((f) => norm(f).trim()).filter(Boolean))];
  const newDb = [...new Set((db ?? []).map((d) => String(d).trim()).filter(Boolean))];
  if (!newFiles.length && !newDb.length)
    return {
      error: 'external add requires --files <path …> (folder with "/" at the end), or --db <function …>',
    };
  queue.tasks = queue.tasks ?? [];
  let row = queue.tasks.find(
    (o) => isExternalRow(o) && o.status === 'external' && o.external_name === who,
  );
  const fresh = !row;
  if (row) {
    row.owned_files = [...new Set([...(row.owned_files ?? []), ...newFiles])];
    row.owner_db = [...new Set([...(row.owner_db ?? []), ...newDb])];
    if (branch) row.branch = branch;
    row.updated = now;
  } else {
    row = {
      id: externalId(who, queue.tasks),
      title: `Work outside the queue: ${who}`,
      domain: 'external',
      class: 'K',
      mission:
        'Registered with cq external add. Not a task: the row owns the files until external done.',
      value: 5,
      content_min: 0,
      migr_tens: 0,
      depends_on: [],
      waiting_on: [],
      owned_files: newFiles,
      owner_db: newDb,
      shared_patch: [],
      status: 'external',
      external: true,
      external_name: who,
      ...(branch ? { branch } : {}),
      added_at: now,
      added_by: who,
    };
    const f = validate(row, queue.tasks);
    if (f.length) return { error: `the record is invalid: ${f.join('; ')}` };
    queue.tasks.push(row);
  }
  // Warnings: tasks in the queue that already own the same thing (they must talk), and pending ones that are now held back.
  const warnings = [];
  const held = [];
  for (const o of queue.tasks) {
    if (o === row || isExternalRow(o)) continue;
    const k = conflict(o, row);
    if (!k) continue;
    if (ACTIVE.has(o.status))
      warnings.push(
        `${o.id} (${o.status}) owns the same thing: ${k.replace(/ is owned by .*$/, '')}; tell the orchestrator`,
      );
    else if (o.status === 'waiting') held.push(o.id);
  }
  if (held.length)
    warnings.push(
      `${held.length} pending task(s) are not started before external done: ${held.slice(0, 8).join(', ')}${held.length > 8 ? ' …' : ''}`,
    );
  return { row, new: fresh, warnings };
}

/** Ends a record outside the queue (by name or id): status done, and the files are free again. */
function externalDone(queue, nameOrId, now = new Date().toISOString()) {
  const x = String(nameOrId ?? '').trim();
  if (!x) return { error: 'external done <name>' };
  const row = (queue.tasks ?? []).find(
    (o) => isExternalRow(o) && o.status === 'external' && (o.external_name === x || o.id === x),
  );
  if (!row)
    return { error: `no active record outside the queue with the name ${x} (see cq external)` };
  row.status = 'done';
  row.done = now;
  return { row };
}

/**
 * The owner or the orchestrator accepts that a pending task was done outside the queue (`queue.mjs external accept <id> <sha>`):
 * status done with the remark "done outside the queue in <sha>". Never automatic. `mentioned` = the commit message mentions the id
 * (otherwise the remark says so). A visual task lands in the QA list as with `set done`.
 * @returns {{ error: string } | { task: object, qa: boolean }}
 */
function externalAccept(queue, id, sha, { mentioned = true, now = new Date().toISOString() } = {}) {
  const o = (queue.tasks ?? []).find((x) => x.id === id);
  if (!o) return { error: `unknown task ${id}` };
  if (isExternalRow(o))
    return { error: `${id} is a record outside the queue (cq external done)` };
  if (!sha) return { error: 'external accept <id> <sha>' };
  if (o.status !== 'waiting' && o.status !== 'proposed') {
    const why =
      o.status === 'picked' ? `picked by ${o.picked_by ?? '?'}` : `status ${o.status}`;
    return { error: `${id} cannot be accepted as done outside the queue: ${why}` };
  }
  const s = setStatus(o, 'done', now);
  if (s.error) return s;
  o.done_outside_queue = sha;
  o.remarks = [
    ...(o.remarks ?? []),
    `${now} done outside the queue in ${String(sha).slice(0, 8)}${mentioned ? '' : ' (the commit message does not mention the id)'}`,
  ];
  return { task: o, qa: s.qa };
}

/**
 * Tasks in work (proposed, waiting, running, picked, review) that are missing a project (land in without-project, only
 * when the register has projects) or feature. New tasks should have both (add-to-queue); another session that adds
 * without them becomes visible here and in `add`.
 */
function missingProject(tasks, register) {
  const inWork = new Set(['proposed', 'waiting', 'running', 'picked', 'review']);
  const withRegister = Object.keys(register ?? {}).length > 0;
  const withoutProject = [];
  const withoutFeature = [];
  for (const o of tasks ?? []) {
    if (isExternalRow(o) || !inWork.has(o.status)) continue;
    if (withRegister && projectFor(o, register) === WITHOUT_PROJECT) withoutProject.push(o.id);
    if (typeof o.feature !== 'string' || !o.feature.trim()) withoutFeature.push(o.id);
  }
  return { withoutProject, withoutFeature };
}

// ---- The track block (trackFile and cloud-package) ------------------------------------------------------------------------

/**
 * The track block from the heading "## TRACK …" down: the ownership, a warning about changes outside the queue if any, owner answers
 * and the mission text. `queue.mjs trackFile` puts TITLE/BLOCK/BRANCH in front; `cloud-package` puts it under "## The mission".
 * @param {object} o the task
 * @param {object} queue the queue (for answerBlock)
 * @param {{ text: string, warning?: string|null, cloud?: boolean }} v `cloud`: the cloud session has no SendMessage, so
 *   the ownership line says "stop" instead of "report".
 */
function trackBlock(o, queue, { text, warning = null, cloud = false } = {}) {
  const list = (x) => (Array.isArray(x) && x.length ? x.join(', ') : 'none');
  const reportFrom = cloud
    ? 'if you need to, stop with CLOUD-STOP and say what is needed.'
    : 'if you need to, report it (SendMessage) instead of editing it.';
  const answer = answerBlock(o, queue);
  return [
    `## TRACK ${o.id} (${o.title}; source: ${o.source ?? 'see the mission'}; class ${o.class}, estimate ${estimate(o)} min)`,
    '',
    `**Ownership in the queue:** files ${list(o.owned_files)}; DB ${list(o.owner_db)}; shared patch ${list(o.shared_patch)}. Do not touch anything other tasks in the queue own; ${reportFrom}`,
    '',
    ...(warning ? [warning, ''] : []),
    ...(answer ? [answer, ''] : []),
    String(text ?? '').trim(),
    // `queue.mjs edit <id> --bonus "…"` (instead of node -e against queue.json).
    ...(bonusBlock(o) ? ['', bonusBlock(o)] : []),
    '',
  ].join('\n');
}

module.exports = {
  externalCollisions,
  collisionText,
  trackFileWarning,
  externalId,
  externalAdd,
  externalDone,
  externalAccept,
  missingProject,
  trackBlock,
};
