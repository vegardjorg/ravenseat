// =============================================================
// journalCrashPreload.cjs: a `node --require` preload for __tests__/storeJournalFlow.test.ts. It kills the REAL CLI
// (cli/context.mjs write, a store transaction) at one point of the commit, as a crash or a kill would, so the flow
// tests never build a journal by hand. JRN_CRASH says where:
//   journal        right after the journal <dataFolder>/.journal/<txid>.json is in place (no target renamed yet)
//   rename:<n>     right after the n-th rename of a target over its file
//   rm             at the journal delete (every target is in place)
//   eperm:<regex>  every rename whose source path matches fails with EPERM (renameWithRetry gives up; the commit's
//                  own recovery fails too, so the journal is kept and the command fails)
// The kill is SIGKILL: no exit hook runs, so the queue lock is left to a dead holder, as after a real kill.
// Test-only: nothing outside __tests__ loads it.
// =============================================================
'use strict';

const fs = require('node:fs');

const spec = process.env.JRN_CRASH || '';
const realRename = fs.renameSync;
const realRm = fs.rmSync;
const inJournal = (p) => /[\\/]\.journal[\\/]/.test(String(p));
const isJournal = (p) => /[\\/]\.journal[\\/][^\\/]+\.json$/.test(String(p));
let journalIn = false;
let renames = 0;

function die() {
  process.kill(process.pid, 'SIGKILL');
  for (;;) {
    /* SIGKILL ends the process; nothing after this runs */
  }
}

fs.renameSync = function renameSync(from, to) {
  if (spec.startsWith('eperm:') && new RegExp(spec.slice('eperm:'.length)).test(String(from)))
    throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}' (test)`), { code: 'EPERM' });
  const out = realRename.apply(this, arguments);
  if (isJournal(to)) {
    journalIn = true;
    if (spec === 'journal') die();
  } else if (journalIn && !inJournal(to)) {
    renames++;
    if (spec === `rename:${renames}`) die();
  }
  return out;
};

fs.rmSync = function rmSync(p) {
  if (spec === 'rm' && journalIn && isJournal(p)) die();
  return realRm.apply(this, arguments);
};
