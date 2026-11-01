// =============================================================
// cli/planShared.mjs: the shared helpers of the plan register commands.
//
// The source root and existsSource, the role (who may write), planError, editPlans (the register under the lock with the
// diff), the answer lines, --for, one plan row, and readDoc/docFindingsLine for the document checks. Split out so
// cli/plans.mjs, cli/planCheck.mjs and cli/planDoc.mjs can share them without an import cycle.
//
// Why a module: queue.mjs was one file of about 6,300 lines. It is now a thin entry point (the usage comment and the
// dispatch on the command word) plus the modules in cli/. The code was moved as it was: same output, exit codes and files.
//
// Used by: cli/plans.mjs, cli/planCheck.mjs, cli/planDoc.mjs.
// Tested in: lib/__tests__/queuePlan.test.ts, queuePlanDoc.test.ts, queuePlanMap.test.ts, queuePlanWork.test.ts.
// =============================================================

import fs from 'node:fs';
import path from 'node:path';

import {
  a, byName, cut, die, hasLock, L, LOCK, MAIN_TREE, P, readPlans, readQueueForPlan, val, WIDTH, withLock, writePlans,
} from './context.mjs';

// The source paths in the plan entries are relative to the main tree. The tests set their own root (QUEUE_PLAN_SOURCE_ROOT).
export const SOURCE_ROOT = process.env.QUEUE_PLAN_SOURCE_ROOT ?? MAIN_TREE;
/** Does the source path exist under the source root? Never outside the root (queuePlan.sourcePathError already rejected .. and absolute paths). */
export function existsSource(filePath) {
  const full = path.resolve(SOURCE_ROOT, filePath);
  const rel = path.relative(SOURCE_ROOT, full);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return fs.existsSync(full);
}
/** The caller's role: agent (default) or owner. */
export function planRole() {
  const r = val('--set-by') ?? 'agent';
  if (!P.SET_BY.includes(r)) die(`--set-by must be ${P.SET_BY.join(' or ')}`);
  return r;
}
/** An error from a plan command: as JSON with --json (the board), otherwise as text. Releases the lock. */
export function planError(error, code = 1, extra = {}) {
  if (a.includes('--json')) {
    console.log(JSON.stringify({ ok: false, error, ...extra }));
    if (hasLock) fs.rmSync(LOCK, { recursive: true, force: true });
    process.exit(code);
  }
  die(`Nothing changed:\n  ${error.join('\n  ')}`, code);
}
/**
 * Writing to the plan register: under the lock, --expect-changed against plans.json, all or nothing. `fn(reg, queue)` changes
 * `reg` and gives the answer ({ error, warnings, ... }); errors give an exit without writing. With --dry nothing is written, and the answer has
 * the changes. Otherwise the changes are entered in the register's changelog (undone with `plan undo`).
 */
export function editPlans(action, fn) {
  const dry = a.includes('--dry');
  return withLock(() => {
    const reg = readPlans();
    const fe = P.expectCheck(reg, val('--expect-changed') ?? null);
    if (fe)
      planError([fe], fe.startsWith('invalid') ? 1 : 6, { outdated: !fe.startsWith('invalid') });
    const version = reg.changed ?? null;
    const forReg = JSON.parse(
      JSON.stringify({ entries: reg.entries, archive: reg.archive, documents: reg.documents }),
    );
    const answer = fn(reg, readQueueForPlan());
    if (answer.error?.length) planError(answer.error, 1, { warnings: answer.warnings ?? [] });
    const changes = P.planDiff(forReg, reg);
    if (dry) return { ...answer, changes, version, dry: true, log: null };
    const entry = P.logChange(reg, { by: byName(), action, changes });
    if (entry) writePlans(reg);
    return { ...answer, changes, version: reg.changed ?? version, log: entry?.nr ?? null };
  });
}
/** The lines in the preview and after a write. */
export const planDiffLines = (changes) =>
  L.diffLines(
    changes.map((e) => ({
      ...e,
      id: e.collection === 'archive' ? `${e.id} (archive)` : e.id,
      field: e.field === '*' ? (e.before == null ? 'new' : 'removed') : e.field,
      before: e.field === '*' && e.before ? e.before.title : e.before,
      after: e.field === '*' && e.after ? e.after.title : e.after,
    })),
  );
/** The answer after a writing plan command (text or JSON). */
export function planAnswer(r, heading) {
  if (a.includes('--json')) {
    console.log(
      JSON.stringify({
        ok: true,
        dry: Boolean(r.dry),
        changes: r.changes,
        warnings: r.warnings ?? [],
        log: r.log,
        changed: r.version,
        ...(r.entry ? { entry: r.entry } : {}),
        ...(r.doc ? { doc: r.doc } : {}),
        ...(r.boost?.length ? { boost: r.boost } : {}),
      }),
    );
    return;
  }
  console.log(`${r.dry ? 'Preview (nothing written): ' : ''}${heading}`);
  for (const l of planDiffLines(r.changes)) console.log(`  ${l}`);
  if (!r.changes.length) console.log('  (no change)');
  for (const x of r.warnings ?? []) console.log(`WARNING: ${x}`);
  if (r.log) console.log(`Changelog no. ${r.log} in plans.json; undo: cq plan undo`);
}
/** The positional arguments before the first flag (`plan prioritize A B now --category ...`). */
export const forFlag = (from) => {
  const out = [];
  for (const x of a.slice(from)) {
    if (x.startsWith('--')) break;
    out.push(x);
  }
  return out;
};
/** One line in `plan show`. */
export function planRow(p) {
  const pri =
    p.priority === 'now' && p.now_category?.length
      ? `now/${p.now_category.join('+')}`
      : p.priority;
  const mod = `${p.derived.maturity}${p.derived.fraction ? ` ${p.derived.fraction}` : ''}${p.derived.stale ? ' (stale)' : ''}`;
  const fixedLine = `${p.id.padEnd(16)} ${pri.padEnd(18)} ${mod.padEnd(14)} ${(p.size ?? '-').padEnd(3)} ${(p.project ?? '').padEnd(16)} `;
  return cut(`${fixedLine}${p.title}${p.deadline ? ` (deadline ${p.deadline})` : ''}`, WIDTH);
}
/** Larger documents are not read for the status deviation (they are not plans). */
const DOC_MAX_BYTE = 2 * 1024 * 1024;
/** The text of a source (only under the source root), or null. */
export function readDoc(filePath) {
  if (P.sourcePathError(filePath) || !existsSource(filePath)) return null;
  try {
    const full = path.resolve(SOURCE_ROOT, filePath);
    const st = fs.statSync(full);
    if (!st.isFile() || st.size > DOC_MAX_BYTE) return null;
    return fs.readFileSync(full, 'utf8');
  } catch {
    return null;
  }
}
// ---- The consistency checks for documents and agreements ---------------------------------------

/** One line per consistency finding. */
export const docFindingsLine = (f) =>
  `${f.severity.padEnd(7)} ${(f.doc ?? '-').padEnd(16)} ${f.check}: ${f.text}`;
