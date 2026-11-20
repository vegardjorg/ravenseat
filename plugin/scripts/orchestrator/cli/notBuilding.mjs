// =============================================================
// cli/notBuilding.mjs: "Not building" in the commands (roadmap 0f, lib/notBuilding.js holds the rules).
//
//   notBuildingLines(items)   the INFO lines for new proposals ({ id, text }) against the main tree's catalog: `add`,
//                             `receive` (the proposals a track added) and `plan capture` print them. Advice only:
//                             never a stop, never an exit code, and nothing with notBuilding.match off or no catalog
//   keepRefused(what)         dies before anything changes when a --keep cannot be done (catalog.captureAnswers off,
//                             a track worktree), the same refusal as `resolve --keep` (roadmap 0z Z-A)
//   keepAsNotBuilding(...)    writes a proposed not-building draft (cancel --keep, checks dismiss --keep, the board's
//                             "Keep as not building"); the owner accepts it with `catalog accept`. Never throws: a draft
//                             that cannot be written is one line, and the decline or the set aside stands
//   doctorNotBuilding()       doctor's INFO row (a revisit date passed: always; old entries: doctor --all)
//
// The catalog is always read from the main tree, like the excerpt: a track cannot change what its proposals meet.
//
// Used by: cli/tasks.mjs (add), cli/merge.mjs (receive), cli/planInbox.mjs (plan capture), cli/taskEdit.mjs (cancel),
// cli/checks.mjs (checks dismiss), cli/doctor.mjs. Tested in: __tests__/notBuildingFlow.test.ts.
// =============================================================

import { CLI, CONFIG, MAIN_TREE, require } from './context.mjs';
import { captureOn, catalogDir, notFromTrack, readLedger, writeProposal } from './catalog.mjs';

const C = require('./lib/catalog.js');
const NB = require('./lib/notBuilding.js');

/** The main tree's catalog and the owner's record, or null when there is no catalog. */
function mainCatalog() {
  const cat = C.readCatalog(catalogDir(MAIN_TREE));
  return cat.exists ? { cat, ledger: readLedger() } : null;
}

/** The INFO lines for new proposals; [] on any trouble (advice must never break the command that prints it). */
export function notBuildingLines(items) {
  try {
    const setup = NB.setupOf(CONFIG);
    if (!setup.match || !items?.length) return [];
    const m = mainCatalog();
    return m ? NB.lines(m.cat, m.ledger, items, { setup, cli: CLI }) : [];
  } catch {
    return []; // error-ignored: a catalog that cannot be read gives no advice; catalog check names the problem
  }
}

/** Dies when a --keep would not be written: before the decline or the set aside, so a refusal changes nothing. */
export function keepRefused(what) {
  captureOn(`${CLI} ${what} --keep`);
  notFromTrack(`propose (${what} --keep)`);
}

/**
 * A proposed not-building draft in the main tree's catalog. Returns { ok, id, file, line } or { ok: false, line }.
 * @param {{ title: string, why?: string|null, source: string }} x
 */
export function keepAsNotBuilding({ title, why = null, source }) {
  try {
    const w = writeProposal(NB.draft({ title, why, source }));
    return {
      ok: true,
      id: w.id,
      file: w.file,
      line:
        `KEEP: proposed ${w.id} as not building (${w.file}). Check the keywords and the revisit line, then ` +
        `${CLI} catalog accept ${w.id} --by owner. Commit the file yourself.`,
    };
  } catch (e) {
    return { ok: false, line: `KEEP: the not-building draft was not written (${e?.message ?? e}); the rest stands. ${CLI} catalog propose --not-building --title "..." writes it by hand.` };
  }
}

/** The reason in a cancel remark: "declined: too noisy" gives "too noisy"; the bare word gives null. */
export function remarkReason(remark) {
  const r = String(remark ?? '').replace(/^\s*(declined|cancelled)\s*:?\s*/i, '').trim();
  return r || null;
}

/** Doctor's row (lib/notBuilding.js doctorRows); [] without a catalog or with notBuilding.match off. */
export function doctorNotBuilding() {
  if (!NB.setupOf(CONFIG).match) return [];
  const m = mainCatalog();
  return m ? NB.doctorRows(NB.entries(m.cat, m.ledger), { cli: CLI }) : [];
}
