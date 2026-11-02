// =============================================================
// queueFindings.js: findings, the things a track notices outside its scope (`cq finding "<title>"`).
//
// Why: a track that sees a bug or a smell in a file it does not own must not fix it (the files belong to other tasks,
// and the change would be unreviewed scope creep), and writing a full task JSON for `cq add --file` is too much for
// "this looks wrong". A finding is one line, and it lands where unvetted work belongs.
//
// Where it lands: the plan register, as an entry with maturity "idea" and priority "later" (set by agent), not the
// batch queue. The batch queue holds small tasks someone has already decided to do, with class, estimate and owned
// files; a finding is an observation nobody has looked at yet, which is exactly what an idea in the plan register is
// (docs/plan-register.md). The orchestrator or the owner triages it from there: prioritize, investigate, drop, or turn
// it into queue tasks with `cq add --plan <id>`.
//
// The entry: id PL-FINDING-<n>, the title, the detail as `summary`, the reporting task's project, and the tool-owned
// field `finding` { tasks: [ids that reported it], files: [paths], reported, last, count }. Deduplicated on the
// normalized title (case, punctuation and spacing ignored): the same finding again adds the task and the files to the
// existing entry and counts it; a title that matches a plan entry that is not a finding changes nothing.
//
// A finding is NEW (counted in `orchestrator pulse`, `show` and `state`) until someone triages it: while the derived
// maturity is still idea, the priority is still later as an agent set it, and no queue task points to it.
//
// Pure, no I/O: the CLI (cli/finding.mjs) does the lock and the write through cli/planShared.mjs. Tested in
// lib/__tests__/queueFindings.test.ts.
// =============================================================
'use strict';

const P = require('./queuePlan.js');

/** The id prefix of the entries `cq finding` creates. */
const ID_PREFIX = 'PL-FINDING-';
/** At most this many files are kept on one finding (they are pointers, not a diff). */
const MAX_FILES = 20;

/** The title as it is compared for duplicates: lower case, letters and digits only, single spaces. */
function findingKey(title) {
  return String(title ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The next free id PL-FINDING-<n> (entries and archive; ids are never reused). */
function nextFindingId(reg) {
  const used = [...(reg.entries ?? []).map((p) => p.id), ...Object.keys(reg.archive ?? {})];
  const n = used.reduce((m, id) => {
    const x = String(id).startsWith(ID_PREFIX) ? Number(String(id).slice(ID_PREFIX.length)) : NaN;
    return Number.isInteger(x) && x > m ? x : m;
  }, 0);
  return `${ID_PREFIX}${n + 1}`;
}

/**
 * The --files list: split on commas, trimmed, slashes forward, and only paths relative to the project root
 * (queuePlan.sourcePathError). Returns the paths and the errors.
 */
function parseFiles(raw) {
  const files = [];
  const error = [];
  for (const x of String(raw ?? '').split(',')) {
    const p = x.trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (!p) continue;
    const e = P.sourcePathError(p);
    if (e) error.push(`--files ${e}`);
    else if (!files.includes(p)) files.push(p);
  }
  if (files.length > MAX_FILES) error.push(`--files: at most ${MAX_FILES} paths (name the folder instead)`);
  return { files, error };
}

/**
 * Records a finding in the register (mutates `reg` only when it is valid).
 * @param {object} reg the plan register (normalized)
 * @param {{ title: string, detail?: string|null, task?: string|null, files?: string[], project: string }} input
 * @param {{ projects?: object, question?: object, now?: string }} ctx  queue.json projects and question
 * @returns {{ error: string[], warnings: string[], entry?: object, created?: boolean, duplicate?: string,
 *   finding?: boolean }}  created: a new entry; duplicate: the id of the entry it matched (finding false = an entry
 *   that is not a finding, left unchanged)
 */
function recordFinding(reg, input, ctx = {}) {
  const now = ctx.now ?? new Date().toISOString();
  const title = String(input?.title ?? '').trim();
  const key = findingKey(title);
  if (!key) return { error: ['the title is empty (cq finding "<title>")'], warnings: [] };
  const files = input.files ?? [];
  const task = input.task ?? null;
  const same = (reg.entries ?? []).find((p) => findingKey(p.title) === key);
  if (same && !same.finding) return { error: [], warnings: [], entry: same, duplicate: same.id, finding: false };
  if (same) {
    const fi = same.finding;
    if (task && !fi.tasks.includes(task)) fi.tasks.push(task);
    for (const f of files) if (!fi.files.includes(f) && fi.files.length < MAX_FILES) fi.files.push(f);
    fi.count = (Number(fi.count) || 1) + 1;
    fi.last = now;
    if (input.detail && !same.summary) same.summary = String(input.detail);
    return { error: [], warnings: [], entry: same, duplicate: same.id, finding: true };
  }
  const s = P.newEntry(
    reg,
    {
      id: nextFindingId(reg),
      title,
      ...(input.detail ? { summary: String(input.detail) } : {}),
      project: input.project,
      priority: 'later',
      priority_reason: `Finding reported by ${task ?? 'an agent'} outside its scope; not triaged yet.`,
    },
    { role: 'agent', projects: ctx.projects ?? {}, question: ctx.question ?? {}, now },
  );
  if (s.error.length) return s;
  s.entry.finding = { tasks: task ? [task] : [], files: [...files], reported: now, last: now, count: 1 };
  return { ...s, created: true };
}

/** Is the entry a finding nobody has triaged yet? `tasks` = queue.json tasks (a task with plan = id triages it). */
function isNewFinding(entry, tasks = []) {
  if (!entry?.finding) return false;
  if (entry.maturity !== 'idea' || entry.priority !== 'later' || entry.priority_set_by !== 'agent') return false;
  return !tasks.some((o) => o?.plan === entry.id);
}

/** The new findings in the register: { new: number, ids: string[] } (oldest first). */
function findingsSummary(reg, tasks = []) {
  const list = (reg?.entries ?? []).filter((p) => isNewFinding(p, tasks));
  list.sort((x, y) => String(x.finding.reported ?? '').localeCompare(String(y.finding.reported ?? '')));
  return { new: list.length, ids: list.map((p) => p.id) };
}

/** The line for `orchestrator pulse` and `show`, or null when there is nothing new. */
function findingsLine(summary, cq = 'cq') {
  if (!summary?.new) return null;
  const ids = summary.ids.slice(0, 5).join(', ') + (summary.ids.length > 5 ? ', ...' : '');
  return `FINDINGS: ${summary.new} new from the tracks, not triaged (${ids}): ${cq} finding list`;
}

/** The rows for `cq finding list`: the findings (new ones first unless `all` keeps the triaged ones too). */
function findingRows(reg, tasks = [], { all = false } = {}) {
  return (reg?.entries ?? [])
    .filter((p) => p.finding && (all || isNewFinding(p, tasks)))
    .map((p) => ({
      id: p.id,
      title: p.title,
      summary: p.summary ?? null,
      project: p.project ?? null,
      new: isNewFinding(p, tasks),
      priority: p.priority,
      tasks: p.finding.tasks ?? [],
      files: p.finding.files ?? [],
      count: p.finding.count ?? 1,
      reported: p.finding.reported ?? null,
    }))
    .sort((x, y) => Number(y.new) - Number(x.new) || String(x.reported).localeCompare(String(y.reported)));
}

module.exports = {
  ID_PREFIX,
  MAX_FILES,
  findingKey,
  nextFindingId,
  parseFiles,
  recordFinding,
  isNewFinding,
  findingsSummary,
  findingsLine,
  findingRows,
};
