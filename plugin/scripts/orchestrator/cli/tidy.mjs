// =============================================================
// cli/tidy.mjs: `ravenseat tidy`, the list of merged worktrees and branches left behind, and their removal on request
// (roadmap 1b, owner decision 2026-11-20). The rules are in lib/tidy.js; this file prints and asks.
//
//   ravenseat tidy                     read only (the default): every worktree git knows, wherever it lives, with merged
//                                      or not, clean or not, locked, and the active task that uses it; the merged
//                                      queue branches with no worktree; the demo folders; counts and sizes per group
//   ravenseat tidy --execute           removes ONLY the worktrees that are merged, clean, not locked, not used by an
//                                      active task and older than tidy.minAgeHours, and the merged branches with no
//                                      worktree. Asks y/N first; --yes skips the question. Without a terminal and
//                                      without --yes nothing is deleted (it says so)
//   ravenseat tidy --demo [--execute]  the demo folders (*-demo, *-shots next to the worktrees); deleted only with both
//                                      flags, after the same question
//   --json                             the read-only picture as JSON
//
// Never touches the main checkout or the worktree it runs in, never `git worktree remove`, never `git branch -D`.
// The push guard denies the command to queue agents (it is not in lib/pushGuard.js AGENT_QUEUE_COMMANDS): deleting is
// the owner's call.
//
// Used by: queue.mjs. Tested in: lib/__tests__/tidy.test.ts.
// =============================================================

import fs from 'node:fs';
import readline from 'node:readline/promises';
import { a, BASE, CLI, CONFIG, FILE, FOLDER, GIT_ROOT, PREFIX, require } from './context.mjs';

const T = require('./lib/tidy.js');

/** The active tasks come from queue.json; a missing or broken file means none (the list still works). */
function tasks() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8')).tasks ?? [];
  } catch {
    return [];
  }
}

/** The scan options from the config, shared with doctor, the board and tidy.afterMerge. */
export function tidyOptions(extra = {}) {
  const minAge = Number(CONFIG.tidy?.minAgeHours);
  return {
    main: GIT_ROOT,
    base: BASE,
    prefix: PREFIX,
    tasks: tasks(),
    cwd: process.cwd(),
    minAgeHours: Number.isFinite(minAge) && minAge >= 0 ? minAge : 3,
    sharedLinks: CONFIG.sharedLinks,
    production: CONFIG.productionBranch ?? null,
    exclude: CONFIG.excludeBranches ?? [],
    dataFolder: FOLDER,
    ...extra,
  };
}

/** The facts of one worktree in plain words. */
function facts(w) {
  const out = [w.merged ? 'merged' : 'not merged'];
  out.push(w.dirty == null ? 'state unknown' : w.dirty < 0 ? 'state unknown' : w.dirty ? `${w.dirty} uncommitted change(s)` : 'clean');
  if (w.locked) out.push('locked');
  if (w.activeTask) out.push(`task ${w.activeTask} is active`);
  return out.join(', ');
}

function printPicture(p, { demo }) {
  const others = p.worktrees.filter((w) => !w.isMain);
  console.log(`Worktrees git knows about (besides the main checkout): ${others.length}`);
  for (const w of others) {
    const what = w.removable ? 'can go' : 'stays ';
    const size = w.missing ? '' : `, ${T.sizeText(w.bytes, w.capped)}`;
    console.log(`  ${what}  ${w.path}${w.branch ? ` (${w.branch})` : ' (detached)'}`);
    console.log(`          ${w.missing ? 'folder gone' : facts(w)}${size}${w.removable ? '' : `; stays because: ${w.reason}`}`);
  }
  const t = p.totals;
  console.log(`\nWorktrees that can be removed: ${t.worktrees} (${T.sizeText(t.worktreeBytes, t.capped)})`);
  console.log(`Merged branches with no worktree (${PREFIX}*): ${t.branches}`);
  for (const b of p.branches) console.log(`  ${b.name}`);
  console.log(`Demo folders: ${t.demos} (${T.sizeText(t.demoBytes)}), not worktrees; removed only with --demo --execute`);
  if (demo) for (const d of p.demos) console.log(`  ${d.path} (${T.sizeText(d.bytes, d.capped)})`);
  const c = p.cleanCopies;
  console.log(
    c.count
      ? `Clean-gate copies: ${c.count} in ${c.folder} (${T.sizeText(c.bytes)}). Clean gates (GOS-1) are not built yet, so tidy leaves them alone.`
      : 'Clean-gate copies: none (clean gates, GOS-1, are not built yet).',
  );
}

/** y/N on a terminal. Returns true only for y or yes. */
async function askYes(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^(y|yes)$/i.test((await rl.question(`${question} [y/N] `)).trim());
  } finally {
    rl.close();
  }
}

export async function cmdTidy() {
  const execute = a.includes('--execute');
  const demo = a.includes('--demo');
  const yes = a.includes('--yes');
  const picture = T.scan(tidyOptions());
  if (a.includes('--json')) {
    console.log(JSON.stringify(picture, null, 2));
    return;
  }
  printPicture(picture, { demo });
  if (!execute) {
    console.log(`\nNothing was changed. To remove what can go: ${CLI} tidy --execute${picture.totals.demos ? ` (demo folders: ${CLI} tidy --demo --execute)` : ''}`);
    return;
  }
  const count = demo ? picture.totals.demos : picture.totals.worktrees + picture.totals.branches;
  if (!count) {
    console.log('\nNothing to remove.');
    return;
  }
  const what = demo
    ? `${picture.totals.demos} demo folder(s)`
    : `${picture.totals.worktrees} worktree(s) and ${picture.totals.branches} branch(es) with no worktree, plus the branches of the removed worktrees (git branch -d)`;
  if (!yes) {
    if (!process.stdin.isTTY) {
      console.log(`\nNothing was deleted: there is no terminal to ask in. Add --yes to remove ${what}.`);
      return;
    }
    if (!(await askYes(`\nRemove ${what}? This cannot be undone.`))) {
      console.log('Nothing was deleted.');
      return;
    }
  }
  const r = T.execute(tidyOptions({ demo }));
  console.log(`\nRemoved: ${r.removed.length}`);
  for (const x of r.removed) console.log(`  ${x.kind}: ${x.name}`);
  console.log(`Kept: ${r.skipped.length}`);
  for (const x of r.skipped) console.log(`  ${x.kind}: ${x.name}: ${x.reason}`);
  if (r.stopped) {
    console.log(`\nSTOPPED: ${r.stopped}. Check the shared folders (${(CONFIG.sharedLinks ?? ['node_modules']).join(', ')}) in the main checkout.`);
    process.exit(1);
  }
}
