// =============================================================
// lib/store/families.js: the ONE register of Ravenseat's stored data ("families"), LAGRING-1a step 1
// (plans/lagring-gjennomgang-2026-11-24.md, "Adapter design").
//
// WHY: Ravenseat has no database. Its state is files in the data folder (<dataFolder>, scripts/.queue/ by default) plus
// a few git-tracked files in the project tree. Until now every module kept its own idea of which files exist, how they
// are written, what happens when one is broken, and whether it may be shared. This file says it once, so doctor, the
// sweep and (in later steps) tidy, the share list and the write guard can read the same list.
//
// A family:
//   name       the key callers use (store.path('plans'), store.readJson('ledger'))
//   root       'data' (the data folder) or 'tree' (git-tracked in the project tree)
//   file / dir the path relative to the root for a single-file family (file) or a folder family (dir)
//   match      extra names in the data folder that belong to the family: exact names, or a RegExp on the entry name
//   kind       doc (one JSON document) | collection (one file per record) | log (append-only rows) | blob (files agents
//              read by path) | lock | cache
//   writers    who writes it: main (the main checkout's CLI), track (a track worktree's CLI), hook, board
//   backup     prev (<file>.prev of the last good state), tiers (rolling snapshots), none
//   onCorrupt  what a reader does with a file that does not parse: fail (stop with the restore hint), empty (read as
//              empty, the safe side for that family), broken (the reader reports a broken state and its caller decides),
//              restorePrev (read <file>.prev instead; never written back by itself), skip (not JSON, or not read here)
//   share      never (stays on this machine) | optIn (may be shared when the owner turns sharing on)
//   backend    auto (could move to another backend later) | file-only (stays a file by design: git-tracked or read by
//              agents through a path)
//   idScheme   the id scheme the family hands out with store.nextId (D, G), or null
//   empty      the value a reader gets when the file is missing (doc families)
//
// ADDING A STATE FILE: add a family here (and use lib/store/index.js to read and write it). Doctor names any data folder
// entry this register does not know as an INFO row, so a forgotten family shows up the first time it is written.
//
// Pure: no I/O. Used by: lib/store/index.js, cli/store.mjs, cli/doctor.mjs. Tested in: lib/__tests__/store.test.ts.
// =============================================================
'use strict';

/** The id schemes store.nextId hands out. pad 0 = no padding. reserveDeleted: a deleted record never frees its id. */
const ID_SCHEMES = Object.freeze({
  D: Object.freeze({ prefix: 'D-', pad: 4, reserveDeleted: true, family: 'decisions' }),
  G: Object.freeze({ prefix: 'G-', pad: 0, reserveDeleted: true, family: 'guards' }),
});

const MONTH_ARCHIVE = (base) => new RegExp(`^${base}-\\d{4}-\\d{2}(\\.\\d+)?\\.jsonl$`);

/** The defaults every family gets; each entry below states what differs. */
const BASE = Object.freeze({
  root: 'data',
  kind: 'doc',
  writers: ['main'],
  backup: 'none',
  onCorrupt: 'empty',
  share: 'optIn',
  backend: 'auto',
  idScheme: null,
  match: [],
});

/** @type {object[]} */
const LIST = [
  // ---- The queue and what is written with it ----------------------------------------------------------------------
  { name: 'queue', file: 'queue.json', writers: ['main', 'track', 'board'], backup: 'tiers', onCorrupt: 'fail', note: 'the queue (cli/context.mjs read/write, lib/stateFile.js)' },
  { name: 'queue-snapshots', dir: 'snapshots', kind: 'collection', note: 'rolling copies of queue.json (lib/stateSnapshots.js)' },
  { name: 'queue-archive', file: 'queue-archive.json', writers: ['main'], onCorrupt: 'broken', note: 'done tasks moved out of the queue (lib/queueArchive.js)' },
  { name: 'plans', file: 'plans.json', writers: ['main', 'track', 'board'], backup: 'prev', onCorrupt: 'fail', empty: null, note: 'the plan register (cli/context.mjs readPlans/writePlans)' },
  { name: 'follow', file: 'follow.json', writers: ['main'], onCorrupt: 'fail', note: 'follow up entries (lib/queueFollow.js)' },
  { name: 'follow-reports', dir: 'follow', kind: 'blob', backend: 'file-only', note: 'follow up reports' },
  { name: 'missions', dir: 'mission', kind: 'blob', backend: 'file-only', writers: ['main'], note: 'long missions, <id>.md (agents read them by path)' },
  { name: 'missions-legacy', dir: 'missions', kind: 'blob', backend: 'file-only', note: 'the older folder name of mission/ (naming drift, plan part 2 point 11)' },
  { name: 'owner-log', file: 'owner-log.json', writers: ['main'], onCorrupt: 'broken', share: 'never', note: 'owner rows the queue recorded (lib/ownerLog.js)' },
  { name: 'owner-mark-key', file: 'owner-mark.key', kind: 'cache', onCorrupt: 'skip', share: 'never', note: 'the key of the owner mark (lib/ownerMark.js)' },
  // ---- Catalog, ids and guards ---------------------------------------------------------------------------------------
  { name: 'ledger', file: 'catalog-accepted.json', writers: ['main', 'board'], backup: 'prev', onCorrupt: 'empty', empty: { version: 1, decisions: {} }, note: "the owner's record of accepted design choices (cli/catalog.mjs)" },
  { name: 'catalog-index', file: 'catalog-index.json', kind: 'cache', writers: ['main', 'track'], note: 'the code index (lib/catalogIndex.js)' },
  { name: 'id-reservations', file: 'id-reservations.json', writers: ['main', 'track'], backup: 'prev', onCorrupt: 'restorePrev', empty: { version: 1, ids: {} }, note: 'the highest id each scheme handed out (store.nextId), so a deleted record never frees its id' },
  { name: 'decisions', root: 'tree', dir: 'docs/queue/catalog/decisions', kind: 'collection', backend: 'file-only', idScheme: 'D', onCorrupt: 'skip', note: 'design choices D-NNNN-<slug>.md, git-tracked' },
  { name: 'guards', root: 'tree', file: '.ravenseat/guards.json', writers: ['main', 'track'], backend: 'file-only', idScheme: 'G', onCorrupt: 'fail', note: 'the guard registry, git-tracked (lib/guardRegistry.js)' },
  // ---- Gates, merge and receive -----------------------------------------------------------------------------------
  { name: 'gate-evidence', file: 'gate-evidence.json', writers: ['main'], share: 'never', note: 'gate runs bound to a sha (lib/gateEvidence.js)' },
  { name: 'merge-state', match: [/^merge-state-.+\.json$/], kind: 'collection', writers: ['main'], onCorrupt: 'broken', note: 'a merge in progress, per task (lib/mergeLock.js)' },
  { name: 'collect', dir: 'collect', kind: 'blob', backend: 'file-only', note: 'cloud track results, per task' },
  { name: 'clean-gate', dir: 'clean-gate', kind: 'cache', note: 'clean copies for the gate (lib/gateClean.js)' },
  { name: 'base-health', file: 'base-health.json', kind: 'cache', match: [/^base-health-.+\.md$/], note: 'the base branch health (lib/baseHealth.js)' },
  // ---- Logs -------------------------------------------------------------------------------------------------------
  { name: 'time-log', file: 'times.jsonl', kind: 'log', writers: ['main', 'track', 'hook'], onCorrupt: 'skip', match: [MONTH_ARCHIVE('times')], note: 'the time log and its monthly archives (lib/timeLogArchive.js)' },
  { name: 'findings', file: 'findings.jsonl', kind: 'log', writers: ['main', 'track'], onCorrupt: 'skip', match: [MONTH_ARCHIVE('findings')], note: 'the finding log and its monthly archives (lib/findingLog.js)' },
  { name: 'log-index', kind: 'cache', writers: ['main', 'track', 'hook'], onCorrupt: 'skip', share: 'never', match: [/\.jsonl\.[a-z]+\.idx$/], note: 'sidecar indexes of the logs (lib/store/logBackend.js): rebuilt from the log when missing or stale' },
  { name: 'test-runs', file: 'test-runs.jsonl', kind: 'log', writers: ['main', 'track'], onCorrupt: 'skip', note: 'test run rows (cut at 512 KB)' },
  { name: 'client-shapes', file: 'client-shapes.jsonl', kind: 'log', writers: ['hook'], onCorrupt: 'skip', note: 'client payload shapes (lib/clientCanary.js)' },
  { name: 'cost-guard-log', file: 'cost-guard-log.jsonl', kind: 'log', writers: ['hook'], onCorrupt: 'skip', note: 'cost guard rows' },
  // ---- Secrets ------------------------------------------------------------------------------------------------------
  { name: 'secret-scan', file: 'secret-scan.json', share: 'never', note: 'the last secret scan (lib/repoSecretScan.js)' },
  { name: 'secret-scan-ignore', file: 'secret-scan-ignore.json', share: 'never', note: "the owner's ignores for the secret scan" },
  { name: 'secrets-backup', dir: 'secrets-backup', kind: 'blob', backend: 'file-only', share: 'never', note: 'backups made before a secrets clean (hold keys)' },
  // ---- Processes, hooks, waits --------------------------------------------------------------------------------------
  { name: 'processes', dir: 'processes', kind: 'collection', writers: ['main', 'track'], share: 'never', note: 'one file per guarded process (lib/processGuard.js)' },
  { name: 'approval-waits', file: 'approval-waits.json', writers: ['hook'], share: 'never', note: 'agents waiting on a permission prompt (lib/approvalWait.js)' },
  { name: 'silent-snapshots', dir: 'silent-snapshots', kind: 'collection', share: 'never', note: 'silent track snapshots (keep 20)' },
  { name: 'waiting', dir: 'waiting', kind: 'collection', share: 'never', note: 'wait mode state (lib/waitMode.js)' },
  // ---- Handover, release notes, ask ---------------------------------------------------------------------------------
  { name: 'handover', file: 'handover-ongoing.md', kind: 'blob', backend: 'file-only', onCorrupt: 'skip', match: ['handover.md'], note: 'the ongoing handover note (lib/queueHandover.js)' },
  { name: 'handover-archive', dir: 'handover-archive', kind: 'blob', backend: 'file-only', note: 'monthly handover archives' },
  { name: 'release-notes', dir: 'release-notes', kind: 'blob', backend: 'file-only', note: 'release notes drafts' },
  { name: 'ask', dir: 'ask', kind: 'blob', backend: 'file-only', note: 'ask bundles per task' },
  { name: 'issues', dir: 'issues', kind: 'blob', backend: 'file-only', note: 'issue bodies (cli/issues.mjs)' },
  { name: 'suggestions', dir: 'suggestions', kind: 'collection', note: 'suggestions' },
  { name: 'demo', dir: 'demo', kind: 'collection', share: 'never', note: 'the demo board, a data folder of its own (lib/demoMode.js)' },
  // ---- Locks ------------------------------------------------------------------------------------------------------
  { name: 'locks', kind: 'lock', share: 'never', onCorrupt: 'skip', match: ['.lockState', '.storeLock', 'merge.lock', 'wait.lock', /\.lock$/], note: 'locks (lib/queueLock.js, lib/mergeLock.js, cli/wait.mjs)' },
  // ---- Small state files and caches (one family each would be noise; they hold one small JSON each) ------------------
  {
    name: 'small-state',
    kind: 'cache',
    onCorrupt: 'empty',
    share: 'never',
    match: [
      'orchestrator.json', 'setup.json', 'effort.json', 'inspection.json', 'seen.json', 'git-surface.json', 'costGuard.json',
      'statusline.json', 'queue-session.json', 'session-cost.json', 'rate-limits.json', 'tool-trouble.json', 'usage-limit.json',
      'demo-offer.json', 'demo.json', 'outbound-preview.json', 'update-check.json', 'issue-reports.json', 'checks-report.json',
      'branch-protection.json', 'deps-audit.json', 'instruction-size.json', 'repo-visibility.json', 'conflict-predict.json',
      'cloud-check.json', 'compact-count.json', 'push-seen.json', 'wait-heartbeat.json', 'wait-tracks-seen.json',
      'setup-tips.json', 'mascot-phrases.json', 'ownership-files.json', 'queue-fill.json', 'ravenseat-version.json',
      'recipes.json', 'categories.json', 'holder.json', 'queue-statusline-count.json',
    ],
    note: 'one small JSON each: cursors, caches and per-feature state',
  },
];

const FAMILIES = LIST.map((f) => Object.freeze({ ...BASE, ...f, writers: Object.freeze([...(f.writers ?? BASE.writers)]), match: Object.freeze([...(f.match ?? [])]) }));
const BY_NAME = new Map(FAMILIES.map((f) => [f.name, f]));

/** Every family (frozen). */
const all = () => FAMILIES;

/** One family by name; throws for an unknown name (a typo in a caller must not read or write somewhere new). */
function family(name) {
  const f = BY_NAME.get(name);
  if (!f) throw new Error(`no storage family "${name}" (lib/store/families.js)`);
  return f;
}

/**
 * Is this entry name a temporary file of an atomic write? `<name>.<pid>.tmp` (the older form) or
 * `<name>.<pid>.<hex>.tmp` (FileBackend's unique name). Returns the pid, or null when it is not one.
 */
function tmpPid(name) {
  const m = /\.(\d+)(?:\.[0-9a-f]{4,})?\.tmp$/.exec(String(name));
  return m ? Number(m[1]) : null;
}
const isTmpName = (name) => tmpPid(name) != null;

/** Does a matcher (exact name or RegExp) take this entry name? */
const takes = (m, name) => (m instanceof RegExp ? m.test(name) : m === name);

/**
 * The data folder family an entry belongs to, or null when the register does not know it. A tmp file of a write is
 * never a family (it is listed apart). `<file>.prev` belongs to the family of <file>.
 * @param {string} name the entry's name at the top of the data folder
 * @param {boolean} isDir whether it is a folder
 */
function classify(name, isDir) {
  if (isTmpName(name)) return null;
  for (const f of FAMILIES) {
    if (f.root !== 'data') continue;
    if (isDir && f.dir && f.dir === name) return f;
    if (!isDir && f.file && (f.file === name || `${f.file}.prev` === name)) return f;
    if (f.match.some((m) => takes(m, name))) return f;
  }
  return null;
}

/** The text an id scheme formats a number as (D-0007, G-7). */
function formatId(scheme, n) {
  const s = ID_SCHEMES[scheme];
  if (!s) throw new Error(`no id scheme "${scheme}" (lib/store/families.js ID_SCHEMES)`);
  return `${s.prefix}${s.pad ? String(n).padStart(s.pad, '0') : String(n)}`;
}

module.exports = { ID_SCHEMES, all, family, classify, isTmpName, tmpPid, formatId };
