// =============================================================
// logic/classify.js: proposed projects: which project a task belongs to, and the warnings in add and project.
//
// planMatch, fileRootMatch, suggestProject, classifyQueue (`queue.mjs classify`), prefixWarnings and addProjectWarnings.
//
// Part of the queueLogic.js split: lib/queueLogic.js re-exports every name, so callers keep requiring queueLogic.js.
// Used by queueLogic.js (the facade) only.
// Tested in lib/__tests__/queueBulk.test.ts (through queueLogic.js).
// =============================================================

const { WITHOUT_PROJECT, isExternalRow } = require('./base.js');
const { projectFor, longestPrefix } = require('./projects.js');
const { norm } = require('./conflicts.js');

/** Projects where the source or the mission (the text in the field, not the file) points to the project's plan. */
function planMatch(o, register) {
  const text = norm(
    [o?.source, typeof o?.mission === 'string' ? o.mission : '']
      .filter((x) => typeof x === 'string' && x)
      .join('\n'),
  ).toLowerCase();
  if (!text) return [];
  const match = [];
  for (const [pid, p] of Object.entries(register ?? {})) {
    if (typeof p?.plan !== 'string' || !p.plan.trim()) continue;
    const filePath = norm(p.plan.trim()).toLowerCase();
    const name = filePath.slice(filePath.lastIndexOf('/') + 1);
    if (text.includes(filePath) || (name.length >= 8 && text.includes(name))) match.push(pid);
  }
  return match;
}

/** Is the file (or folder) under the file root? A root that ends in "/" is a folder; otherwise a file or folder. */
function underRoot(file, root) {
  const f = norm(file);
  const r = norm(root);
  if (r.endsWith('/')) return f.startsWith(r);
  return f === r || f.startsWith(`${r}/`);
}

/** Number of owned files under each project's fileRoot, most first: [{ pid, n }] (only projects with at least one match). */
function fileRootMatch(o, register) {
  const files = (o?.owned_files ?? []).filter((x) => typeof x === 'string' && x);
  const out = [];
  for (const [pid, p] of Object.entries(register ?? {})) {
    const roots = Array.isArray(p?.fileRoot)
      ? p.fileRoot.filter((x) => typeof x === 'string' && x)
      : [];
    if (!roots.length) continue;
    const n = files.filter((f) => roots.some((r) => underRoot(f, r))).length;
    if (n) out.push({ pid, n });
  }
  return out.sort((a, b) => b.n - a.n || a.pid.localeCompare(b.pid));
}

/**
 * Proposed project for a task (add, classify, the "Sort" list). Signals in decreasing strength: (1) explicit
 * `project`, (2) longest prefix, (3) `source`/`mission` points to the project's `plan`, (4) most owned files under
 * the project's `fileRoot`. "Strong" signals are an unambiguous plan and a fileRoot that covers ALL the owned files; if they contradict
 * the choice, the suggestion is uncertain (or, with an explicit project, `disagree`). No or ambiguous signals: pid null
 * ("Sort"). Never an error, so add never stops on this.
 * @returns {{ pid: string|null, signal: 'explicit'|'prefix'|'plan'|'fileRoot'|null, safe: boolean, disagree: boolean,
 *   counterProposal: string|null, reason: string, candidates: { pid: string, signal: string, reason: string }[] }}
 */
function suggestProject(o, register) {
  const reg = register ?? {};
  const candidates = [];
  const pre = longestPrefix(o?.id, reg);
  if (pre) candidates.push({ pid: pre.pid, signal: 'prefix', reason: `the prefix ${pre.prefix}` });
  const plan = planMatch(o, reg);
  for (const pid of plan)
    candidates.push({ pid, signal: 'plan', reason: `the source points to the plan ${reg[pid].plan}` });
  const countFiles = (o?.owned_files ?? []).filter((x) => typeof x === 'string' && x).length;
  const root = fileRootMatch(o, reg);
  for (const r of root)
    candidates.push({
      pid: r.pid,
      signal: 'fileRoot',
      reason: `${r.n} of ${countFiles} owned files under the file root`,
    });
  const cand = (signal, pid) => candidates.find((x) => x.signal === signal && x.pid === pid);
  const strong = [];
  if (plan.length === 1) strong.push(cand('plan', plan[0]));
  const allRoot = root.filter((r) => r.n === countFiles);
  if (countFiles && allRoot.length === 1) strong.push(cand('fileRoot', allRoot[0].pid));

  let selected = null;
  const ambiguous = [];
  if (pre && !pre.also.length) selected = cand('prefix', pre.pid);
  else if (pre)
    ambiguous.push(`the prefix ${pre.prefix} is in ${[pre.pid, ...pre.also].join(', ')}`);
  if (!selected && plan.length === 1) selected = cand('plan', plan[0]);
  else if (!selected && plan.length > 1)
    ambiguous.push(`the source points to the plans of ${plan.join(', ')}`);
  if (!selected && root.length) {
    if (root.length === 1 || root[0].n > root[1].n) selected = cand('fileRoot', root[0].pid);
    else
      ambiguous.push(
        `equally many owned files under the file root of ${root
          .filter((r) => r.n === root[0].n)
          .map((r) => r.pid)
          .join(', ')}`,
      );
  }
  const against = (pid) => {
    const m = strong.filter((s) => s.pid !== pid);
    const pids = [...new Set(m.map((s) => s.pid))];
    return { m, counterProposal: pids.length === 1 ? pids[0] : null };
  };
  const explicit = typeof o?.project === 'string' && o.project ? o.project : null;
  if (explicit) {
    const { m, counterProposal } = against(explicit);
    return {
      pid: explicit,
      signal: 'explicit',
      safe: !m.length,
      disagree: m.length > 0,
      counterProposal,
      reason: m.length
        ? `set to ${explicit}, but ${m.map((s) => `${s.reason} (${s.pid})`).join('; ')}`
        : `set to ${explicit}`,
      candidates,
    };
  }
  if (!selected)
    return {
      pid: null,
      signal: null,
      safe: false,
      disagree: false,
      counterProposal: null,
      reason: ambiguous.length
        ? `ambiguous: ${ambiguous.join('; ')}`
        : 'no prefix, plan or fileRoot matches',
      candidates,
    };
  const { m, counterProposal } = against(selected.pid);
  const reservation = [...ambiguous, ...m.map((s) => `${s.reason} (${s.pid})`)];
  return {
    pid: selected.pid,
    signal: selected.signal,
    safe: !reservation.length,
    disagree: m.length > 0,
    counterProposal,
    reason: reservation.length ? `${selected.reason}, but ${reservation.join('; ')}` : selected.reason,
    candidates,
  };
}

/** The statuses classify looks at (open work; finished and cancelled ones stay as they are). */
const CLASSIFY_STATUSES = new Set(['proposed', 'waiting', 'running', 'picked', 'review']);

/**
 * Proposals for tasks that are already in the queue (queue.mjs classify, the "Sort" list on the board):
 *   move  = without a project today, and a safe proposal (`--execute` sets `project` on them);
 *   disagree  = the project today (explicit or prefix) contradicts a strong signal (the owner decides; never automatic);
 *   sort = without a project, and no or an ambiguous proposal.
 * Filters: `withoutProject` (only those in without-project today), `disagreeing` (only disagree).
 * @returns {{ move: object[], sort: object[] }} rows { id, title, now, proposed, signal, type, reason }
 */
function classifyQueue(queue, { withoutProject = false, disagreeing = false } = {}) {
  const register = queue.projects ?? {};
  const move = [];
  const sort = [];
  for (const o of queue.tasks ?? []) {
    if (isExternalRow(o) || !CLASSIFY_STATUSES.has(o.status)) continue;
    const now = projectFor(o, register);
    const f = suggestProject(o, register);
    let type = null;
    let proposed = f.pid;
    if (now === WITHOUT_PROJECT) type = f.pid && f.safe ? 'move' : 'sort';
    else if (f.disagree) {
      type = 'disagree';
      proposed = f.counterProposal;
    } else if (!f.safe) type = 'sort';
    if (!type) continue;
    if (withoutProject && now !== WITHOUT_PROJECT) continue;
    if (disagreeing && type !== 'disagree') continue;
    const row = {
      id: o.id,
      title: o.title ?? null,
      status: o.status,
      now,
      proposed: proposed ?? null,
      signal: f.signal,
      type,
      reason: f.reason,
    };
    (type === 'move' ? move : sort).push(row);
  }
  return { move, sort };
}

/**
 * Warnings about the prefixes in the register: a one-character prefix without a separator (catches everything starting with it, like "4"), a prefix
 * that is the start of another project's prefix (the longest wins), and the same prefix in two projects (the first in the
 * register wins). `pid` limits to warnings that apply to that project.
 */
function prefixWarnings(register, { pid: bare = null } = {}) {
  const out = [];
  const list = [];
  for (const [pid, p] of Object.entries(register ?? {}))
    for (const pre of Array.isArray(p?.prefixes) ? p.prefixes : [])
      if (typeof pre === 'string' && pre) list.push({ pid, pre });
  for (const a of list) {
    if (bare && a.pid !== bare) continue;
    if (a.pre.length === 1)
      out.push(
        `the prefix ${a.pre} in ${a.pid} is only one character and catches all ids that start with ${a.pre}`,
      );
  }
  for (const a of list) {
    for (const b of list) {
      if (a.pid === b.pid) continue;
      if (bare && a.pid !== bare && b.pid !== bare) continue;
      if (a.pre === b.pre && a.pid < b.pid)
        out.push(
          `the prefix ${a.pre} is in both ${a.pid} and ${b.pid} (the first in the register wins)`,
        );
      else if (a.pre !== b.pre && b.pre.startsWith(a.pre))
        out.push(
          `the prefix ${a.pre} in ${a.pid} is the start of ${b.pre} in ${b.pid} (longest prefix wins: ${b.pre}… goes to ${b.pid})`,
        );
    }
  }
  return out;
}

/**
 * The warnings `add` writes about project and feature for new tasks (never stops add): without a project (with the suggestion
 * and which signal decided, or "Sort"), an explicit project that contradicts strong signals, and a feature
 * that is not in the project's `features` (when that list exists).
 * @returns {string[]}
 */
function addProjectWarnings(newOnes, register) {
  const reg = register ?? {};
  if (!Object.keys(reg).length) return [];
  const out = [];
  for (const n of newOnes ?? []) {
    if (!n || typeof n !== 'object') continue;
    const pid = projectFor(n, reg);
    const f = suggestProject(n, reg);
    if (pid === WITHOUT_PROJECT) {
      out.push(
        f.pid
          ? `${n.id} has no project; proposed ${f.pid} (${f.reason}). Set "project": "${f.pid}", or run cq classify --execute${f.safe ? '' : ' (the suggestion is uncertain: see cq classify)'}`
          : `${n.id} has no project and lands in "Sort" (${f.reason}). Set "project", or give the project a fileRoot/prefix`,
      );
    } else if (f.disagree) {
      out.push(`${n.id}: ${f.reason}. Check the project (cq classify --disagree)`);
    }
    const known = reg[pid]?.features;
    if (
      Array.isArray(known) &&
      known.length &&
      typeof n.feature === 'string' &&
      n.feature.trim() &&
      !known.includes(n.feature.trim())
    ) {
      const equal = known.filter((x) => x.toLowerCase() === n.feature.trim().toLowerCase());
      out.push(
        equal.length
          ? `${n.id}: feature "${n.feature}" is called "${equal[0]}" in ${pid}`
          : `${n.id}: new feature "${n.feature}" in ${pid} (known: ${known.slice(0, 8).join(', ')}${known.length > 8 ? ' …' : ''})`,
      );
    }
  }
  return out;
}

module.exports = {
  planMatch,
  fileRootMatch,
  suggestProject,
  classifyQueue,
  prefixWarnings,
  addProjectWarnings,
};
