// =============================================================
// releaseNotes.js: a release notes draft from the merged tasks since a tag (GH-5 of
// plans/trailhead-gsd-skills-vurdering-2026-11-20.md, section 6).
//
// Why: the merged tasks already say what changed. Grouping them into the CHANGELOG's own groups (Added, Changed, Fixed,
// Hardened) gives a first draft to edit, instead of reading the log by hand. The draft is local; only `--github`
// (cli/ghWrite.mjs) makes a DRAFT release on GitHub, after the preview and the approval, and never publishes it.
//
// The group comes from what a task already carries (no new field):
//   Fixed     a fix link (`fixes`), a QA fix task (`qa_original`), a base or CI fix task (added_by "base gate" or
//             "ci watch"), or a label bug, fix or bugfix
//   Hardened  a label security, hardening or hardened
//   Added     a label feature, added, enhancement or new
//   Changed   a label changed, and everything else (the fallback)
// Only done tasks count. An investigation (class U) changes no production code, so it is left out and counted.
//
// The ids come from the merge commits on the first-parent line since the tag (lib/pushBatch.js summarize), in merge
// order. Pure. Used by: cli/ghWrite.mjs. Tested in lib/__tests__/releaseNotes.test.ts.
// =============================================================
'use strict';

const GO = require('./ghOutbound.js');

const GROUPS = Object.freeze(['Added', 'Changed', 'Fixed', 'Hardened']);
const LABELS = Object.freeze({
  Fixed: ['bug', 'fix', 'bugfix'],
  Hardened: ['security', 'hardening', 'hardened'],
  Added: ['feature', 'added', 'enhancement', 'new'],
  Changed: ['changed'],
});

const labelsOf = (task) => (Array.isArray(task?.labels) ? task.labels.map((x) => String(x).toLowerCase()) : []);

/** The group of one task. */
function groupOf(task) {
  const fixes = Array.isArray(task?.fixes) ? task.fixes.length > 0 : !!task?.fixes;
  if (fixes || task?.qa_original || ['base gate', 'ci watch'].includes(task?.added_by)) return 'Fixed';
  const labels = labelsOf(task);
  for (const g of ['Fixed', 'Hardened', 'Added', 'Changed']) if (LABELS[g].some((l) => labels.includes(l))) return g;
  return 'Changed';
}

/**
 * The groups for the merged ids (merge order), from the tasks (queue plus archive).
 * @returns {{ groups: Record<string, { id: string, title: string }[]>, leftOut: { investigation: number, notDone: number, unknown: number }, count: number }}
 */
function build({ ids, tasks }) {
  const byId = new Map((tasks ?? []).map((t) => [t.id, t]));
  const groups = Object.fromEntries(GROUPS.map((g) => [g, []]));
  const leftOut = { investigation: 0, notDone: 0, unknown: 0 };
  for (const id of ids ?? []) {
    const t = byId.get(id);
    if (!t) leftOut.unknown++;
    else if (t.status !== 'done') leftOut.notDone++;
    else if (t.class === 'U') leftOut.investigation++;
    else groups[groupOf(t)].push({ id, title: String(t.title ?? '') });
  }
  return { groups, leftOut, count: GROUPS.reduce((n, g) => n + groups[g].length, 0) };
}

const oneLine = (s) => String(s ?? '').replace(/[\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * The draft as Markdown. `github`: titles and ids in code spans (no mention, link or image renders) and the signature.
 * @param {{ groups: object, leftOut: object, count: number }} r
 * @param {{ from?: string|null, github?: boolean }} o
 */
function markdown(r, { from = null, github = false } = {}) {
  const since = from ? `since ${oneLine(from)}` : 'all history';
  const out = [`## Unreleased (${since})`, ''];
  if (!r.count) out.push(`No merged tasks ${from ? `since ${oneLine(from)}` : 'yet'}.`, '');
  for (const g of GROUPS) {
    const list = r.groups[g] ?? [];
    if (!list.length) continue;
    out.push(`### ${g}`);
    for (const x of list) out.push(github ? `- ${GO.safeTitle(x.title)} (${GO.safeId(x.id)})` : `- **${oneLine(x.title)}** (${x.id})`);
    out.push('');
  }
  const lo = r.leftOut ?? {};
  const notes = [
    lo.investigation ? `${lo.investigation} investigation task(s) left out` : null,
    lo.notDone ? `${lo.notDone} merged task(s) not done left out` : null,
    lo.unknown ? `${lo.unknown} merge(s) of a task the queue no longer knows left out` : null,
  ].filter(Boolean);
  if (notes.length && !github) out.push(`<!-- ${notes.join('; ')} -->`, '');
  if (github) out.push('A draft from the merged tasks in Ravenseat.', '', GO.SIGNATURE);
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

module.exports = { GROUPS, LABELS, groupOf, build, markdown };
