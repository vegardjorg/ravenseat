// =============================================================
// cli/store.mjs: `ravenseat store`, a look at the storage layer (lib/store/, LAGRING-1a step 1).
//
//   ravenseat store [--json]                 the data folder against the family register (lib/store/families.js): the
//                                            entries it does not know and the tmp files crashed writes left behind.
//                                            Reads only.
//   ravenseat store sweep --tmp [--dry] [--json]
//                                            removes those orphaned tmp files (a dead pid and older than 10 min; a
//                                            write in progress is never one). --dry lists them and removes nothing.
//                                            Refused from a track worktree: the data folder is the main checkout's.
//   ravenseat store journal drop <id>        sets a FAILED store journal aside (one its recovery cannot finish, doctor's
//                                            row names it): the journal and the tmp files it names move to
//                                            <dataFolder>/.journal/failed/, nothing is deleted. A journal a recovery can
//                                            still finish is refused (doctor --fix finishes it). Refused from a track
//                                            worktree. Fix round jrn-r2, L2.
//
// Doctor shows the same listing as one INFO row (storeDoctorRows) and never deletes. Nothing deletes on its own: the
// sweep runs only when someone types it (any automatic cleanup is a later step, off by default with a setting).
// An unknown entry is never touched by the sweep: it is the owner's file or a family missing from the register.
//
// Used by: queue.mjs (store), cli/doctor.mjs (storeDoctorRows). Tested in: __tests__/storeFlow.test.ts.
// =============================================================

import path from 'node:path';

import { a, CLI, die, FOLDER, MAIN_TREE, queueBranchId, require } from './context.mjs';
import { trackBranchHere } from './settings.mjs';

const ST = require('./lib/store/index.js');

const USAGE = `${CLI} store [--json] | store sweep --tmp [--dry] [--json] | store journal drop <id>`;
/** How many names one doctor row shows before "+N more". */
const SHOW_MAX = 6;

const store = () => ST.openStore({ folder: FOLDER, tree: MAIN_TREE });

/** The queue row in doctor names queue.json's own tmp files already (cli/doctor.mjs checkState). */
const notQueueTmp = (t) => !/^queue\.json(\.prev)?\.\d+(\.[0-9a-f]+)?\.tmp$/.test(t.rel);

const tmpText = (t) => `${t.rel} (${ST.ageText(t.ageMs)} old, ${ST.sizeText(t.size)})`;
const some = (list, fmt) => `${list.slice(0, SHOW_MAX).map(fmt).join(', ')}${list.length > SHOW_MAX ? ` (+${list.length - SHOW_MAX} more)` : ''}`;

/**
 * Doctor's row: one INFO row when the data folder holds an entry the register does not know or an orphaned tmp file;
 * nothing otherwise. Never WARN or FAIL, never deletes. `info` is doctor's row maker.
 */
export function storeDoctorRows(info) {
  const r = store().scan();
  const tmp = r.orphanTmp.filter(notQueueTmp);
  if (!r.unknown.length && !tmp.length) return [];
  const parts = [];
  if (r.unknown.length)
    parts.push(`${r.unknown.length} data folder entr${r.unknown.length === 1 ? 'y' : 'ies'} the storage register does not know: ${some(r.unknown, (u) => `${u.name}${u.dir ? '/' : ''}`)}`);
  if (tmp.length) {
    const bytes = tmp.reduce((n, t) => n + t.size, 0);
    parts.push(`${tmp.length} orphaned tmp file(s) from crashed writes, ${ST.sizeText(bytes)}: ${some(tmp, tmpText)}`);
  }
  const fixes = [];
  if (tmp.length) fixes.push(`${CLI} store sweep --tmp --dry lists them, ${CLI} store sweep --tmp removes them`);
  if (r.unknown.length) fixes.push('an unknown entry is your own file or a family missing from lib/store/families.js; nothing removes it');
  return [info('store', parts.join('; '), fixes.join('; '))];
}

/**
 * Doctor's rows for store commits that stopped part way (lib/store/index.js transaction, step 7): one WARN row per
 * journal left in <dataFolder>/.journal, naming it, its families and what a recovery would do. Reads only.
 */
export function storeJournalRows(warn) {
  return store()
    .journals()
    .map((j) => {
      const what = `journal ${j.id} (${j.families.join(', ') || 'unreadable'}) is left by a store commit that stopped part way`;
      // A failed one is marked so in its file once a recovery has seen it (lib/store/index.js markFailed): doctor --fix
      // then leaves it, and the owner sets it aside after a look.
      if (j.plan === 'failed')
        return warn(
          'store journal',
          `${what}; it cannot be finished${j.marked && j.failedAt ? ` (marked failed ${j.failedAt})` : ''}: ${j.reason}`,
          `look at the files it names (${path.relative(FOLDER, j.file)}); nothing tries it again. ${CLI} store journal drop ${j.id} sets it aside in .journal/failed/ (nothing is deleted)`,
        );
      const how = j.plan === 'back' ? `the state before it comes back from .prev (${j.reason})` : j.plan === 'forward' ? 'the rest of its renames are made' : 'only the journal is left to remove';
      return warn('store journal', `${what}; a recovery finishes it: ${how}`, `${CLI} doctor --fix finishes it now (the next command on those families does it too; with store.journalRecover report, a write to them stops until then)`);
    });
}

/**
 * doctor --fix: finishes every journal it can (whatever store.journalRecover says: the owner asked). One line each. A
 * journal marked failed is not tried again (lib/store/index.js recover skips it); its doctor row stays.
 */
export function storeJournalFix() {
  return store()
    .recover()
    .results.map((r) => `store journal ${r.id} (${(r.families ?? []).join(', ')}): ${r.outcome === 'failed' ? `not finished, kept (${r.reason})` : r.outcome === 'back' ? 'put back the state before it' : 'finished'}`);
}

/** `ravenseat store journal drop <id>`: a failed journal set aside on the owner's command (lib/store/index.js dropJournal). */
function cmdJournal() {
  const id = a[3];
  if (a[2] !== 'drop' || !id || id.startsWith('--')) die(`${CLI} store journal drop <id> (the id is in ${CLI} doctor's store journal row)`);
  const track = trackBranchHere() ?? queueBranchId();
  if (track)
    die(`${CLI} store journal drop cannot be run from inside a track worktree (${track}): the data folder is the main checkout's. Nothing was moved.`);
  const r = store().dropJournal(id);
  if (!r.ok) die(`${CLI} store journal drop: ${String(r.error).replace(/\bravenseat (?=doctor)/g, `${CLI} `)}. Nothing was moved.`);
  console.log(`Set store journal ${id} aside (nothing was deleted); moved to ${path.join(FOLDER, '.journal', 'failed')}:`);
  for (const m of r.moved) console.log(`  ${m}`);
}

function cmdSweep(json) {
  if (!a.includes('--tmp')) die(`${USAGE}\n(only --tmp exists so far: the orphaned tmp files of crashed writes)`);
  const track = trackBranchHere() ?? queueBranchId();
  if (track)
    die(`${CLI} store sweep cannot be run from inside a track worktree (${track}): the data folder is the main checkout's. Nothing was removed.`);
  const dry = a.includes('--dry');
  const r = store().sweepTmp({ dry });
  if (json) {
    console.log(JSON.stringify({ ok: r.failed.length === 0, dry, folder: FOLDER, listed: r.listed, removed: r.removed, failed: r.failed }, null, 2));
    if (r.failed.length) process.exit(1);
    return;
  }
  if (!r.listed.length) {
    console.log(`No orphaned tmp files in ${FOLDER}. Nothing was removed.`);
    return;
  }
  console.log(`Orphaned tmp files in ${FOLDER} (a crashed write left them; the file they were for is whole):`);
  for (const t of r.listed) console.log(`  ${tmpText(t)}`);
  if (dry) {
    console.log(`Nothing was removed (--dry). ${CLI} store sweep --tmp removes them.`);
    return;
  }
  console.log(`Removed ${r.removed.length} of ${r.listed.length}.`);
  for (const f of r.failed) console.log(`  could not remove ${f.rel}: ${f.error}`);
  if (r.failed.length) process.exit(1);
}

export function cmdStore() {
  const json = a.includes('--json');
  if (a[1] === 'sweep') return cmdSweep(json);
  if (a[1] === 'journal') return cmdJournal();
  if (a[1] && !a[1].startsWith('--')) die(USAGE);
  const r = store().scan();
  if (json) {
    console.log(JSON.stringify({ folder: FOLDER, families: ST.families.all().length, unknown: r.unknown, orphanTmp: r.orphanTmp }, null, 2));
    return;
  }
  console.log(`Data folder ${FOLDER}: ${ST.families.all().length} registered families (lib/store/families.js).`);
  if (!r.unknown.length) console.log('Every entry belongs to a registered family.');
  else {
    console.log(`Not in the register (${r.unknown.length}): your own files, or a family missing from lib/store/families.js. Nothing removes them.`);
    for (const u of r.unknown) console.log(`  ${u.name}${u.dir ? '/' : ''}`);
  }
  if (!r.orphanTmp.length) console.log('No orphaned tmp files.');
  else {
    console.log(`Orphaned tmp files (${r.orphanTmp.length}); ${CLI} store sweep --tmp --dry, then without --dry:`);
    for (const t of r.orphanTmp) console.log(`  ${tmpText(t)}  ${path.relative(process.cwd(), t.path) || t.path}`);
  }
}
