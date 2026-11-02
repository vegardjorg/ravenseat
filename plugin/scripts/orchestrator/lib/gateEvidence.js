// =============================================================
// gateEvidence.js: the trusted gate evidence, the gate runs `cq receive`, `cq merge` and the push check rely on.
//
// Why: `cq receive` used to trust the track's own RESULT line (`gates=OK`), and the base gate's skip rule trusted the
// `gate` rows in the time log. Both come from the track: it writes the RESULT line itself, and the time log is a plain
// file every agent appends to (hook-time.mjs, gates.mjs run in the track's worktree). A track that wanted to (or text it
// read that told it to) could claim a green gate it never ran, or add a green row for a sha nobody tested. The time log
// stays what it was: measurement. Decisions read only this store.
//
// The rule: an entry is evidence for a commit only when ALL hold:
//   - it was written by gates.mjs (`--quick` or `--full`) when run by the orchestrator's side: `cq receive` and `cq merge`
//     pass `--evidence`, and a run in the MAIN checkout (not a linked worktree: what the orchestrator does before a batch
//     push) records by default. A track's own run in its worktree never records evidence, so it is informational, like
//     its RESULT line;
//   - `sha` is the HEAD commit at the start of the run and HEAD did not move during it (gates.mjs leaves sha out then);
//   - `clean` is true: no uncommitted tracked changes when the run started (untracked files are not counted, as for the
//     base gate's skip rule);
//   - it ran every command the caller needs (the quick gates for receive, the full gates for the push).
// The NEWEST entry for a sha and kind decides (a later red run beats an earlier green one).
//
// Out of the track's reach: the store is a file in the data folder that no track instruction mentions, and the push
// guard (hook-push-guard.mjs) denies a queue agent's shell command that names the store or passes `--evidence` or
// `--cwd` to the gate runner (tamperReason). Limits, on purpose: the agents run as the same OS user, so a Write/Edit tool
// call on the file, or a gate run after `cd` into the main checkout, is not stopped by a hook; the store is a guard
// against claims and casual forgery, not a security boundary against a hostile process.
//
// The file: <dataFolder>/gate-evidence.json, { version: 1, entries: [entry, ...] } (the newest last, at most MAX_ENTRIES).
//   entry = { time, by: "gates.mjs", sha, kind: "quick"|"full", ok, exit, clean, gates: [commands], failed: [commands],
//             timed_out?, track?, branch?, main_tree }
// Pure except readStore/writeStore/append (one small file, written atomically).
// Tested in lib/__tests__/gateEvidence.test.ts, __tests__/queueGateEvidence.test.ts and __tests__/queueBaseGate.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/** The store's file name in the data folder. */
const FILE_NAME = 'gate-evidence.json';
/** Entries kept (the oldest dropped first). */
const MAX_ENTRIES = 200;
/** The kinds that can be evidence (a precheck runs only some checks on some files, never evidence). */
const KINDS = new Set(['quick', 'full']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const commandList = (v) => (Array.isArray(v) ? v.filter((g) => typeof g === 'string' && g.trim()).map((g) => g.trim()) : []);

/** The store file in a data folder. */
function storeFile(folder) {
  return path.join(folder, FILE_NAME);
}

/** The store's content; an empty store when the file is missing or broken (missing evidence is the safe direction). */
function readStore(file) {
  try {
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (isObject(s) && Array.isArray(s.entries)) return { version: 1, entries: s.entries.filter(isObject) };
  } catch {
    // missing or broken: no evidence, so the caller runs the gate or asks
  }
  return { version: 1, entries: [] };
}

/** Writes the store atomically (a temporary file and a rename), so a reader never sees half a file. */
function writeStore(file, store) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/**
 * One entry from a gates.mjs run, or null when the run cannot be evidence (another kind, no sha, cleanliness unknown).
 * @param {{ time?: string, sha?: string|null, kind: string, exit: number, clean?: boolean, gates?: string[],
 *   failed?: string[], timedOut?: boolean, track?: string|null, branch?: string|null, mainTree?: boolean }} r
 */
function entry(r) {
  if (!KINDS.has(r?.kind)) return null;
  if (typeof r.sha !== 'string' || !/^[0-9a-f]{7,64}$/i.test(r.sha)) return null;
  if (typeof r.clean !== 'boolean') return null;
  const e = {
    time: r.time ?? new Date().toISOString(),
    by: 'gates.mjs',
    sha: r.sha,
    kind: r.kind,
    ok: r.exit === 0,
    exit: r.exit,
    clean: r.clean,
    gates: commandList(r.gates),
    failed: commandList(r.failed),
  };
  if (r.timedOut) e.timed_out = true;
  if (r.track) e.track = String(r.track);
  if (r.branch) e.branch = String(r.branch);
  e.main_tree = r.mainTree === true;
  return e;
}

/** The store with the entry appended (the oldest dropped over MAX_ENTRIES). Pure. */
function add(store, e) {
  if (!e) return store;
  return { version: 1, entries: [...(store?.entries ?? []), e].slice(-MAX_ENTRIES) };
}

/** Appends one entry to the store file. Never throws: false when it could not be written (no evidence then). */
function append(file, e) {
  try {
    if (!file || !e) return false;
    writeStore(file, add(readStore(file), e));
    return true;
  } catch {
    return false; // error-ignored: missing evidence makes the caller run the gate again or ask, never pass
  }
}

/** Did the entry run every one of `commands`? */
function covers(e, commands) {
  const ran = new Set(commandList(e?.gates));
  return commandList(commands).every((c) => ran.has(c));
}

/**
 * The newest entry that speaks for `sha`: the same sha, a clean run, one of `kinds`, and every one of `commands` ran.
 * Green or red: the newest decides. null when there is none.
 * @param {object[]} entries
 * @param {{ sha: string|null, kinds?: string[], commands?: string[] }} q
 */
function latest(entries, { sha, kinds = ['quick', 'full'], commands = [] }) {
  if (!sha) return null;
  const list = (entries ?? []).filter(
    (e) => isObject(e) && e.sha === sha && e.clean === true && kinds.includes(e.kind) && covers(e, commands),
  );
  return list.length ? list[list.length - 1] : null;
}

/**
 * The verdict for a commit: "green" (the newest matching entry is green), "red" (it is red) or "missing" (none).
 * "off" when there are no commands to require (no gates set up of that kind).
 */
function verdict(entries, { sha, kinds = ['quick', 'full'], commands = [] }) {
  if (!commandList(commands).length) return 'off';
  const e = latest(entries, { sha, kinds, commands });
  if (!e) return 'missing';
  return e.ok === true ? 'green' : 'red';
}

/** The full-gate verdict for a tip from the data folder (the push check and the push guard). Never throws. */
function fullGateVerdict({ folder, sha, cfg }) {
  try {
    const commands = commandList(cfg?.gates?.full);
    if (!commands.length) return 'off';
    return verdict(readStore(storeFile(folder)).entries, { sha, kinds: ['full'], commands });
  } catch {
    return 'missing';
  }
}

/**
 * The push guard's reason to deny a queue agent's shell command that could forge evidence, or null: it names the store
 * file, or it passes `--evidence` or `--cwd` to the gate runner (`cq gates`, `gates.mjs`). A track runs its own gates
 * without either flag; only the orchestrator's side records evidence.
 */
function tamperReason(command) {
  const c = String(command ?? '');
  if (c.includes(FILE_NAME.replace('.json', '')))
    return `the gate evidence (${FILE_NAME}) is written only by the orchestrator's gate runs; a queue agent may not touch it`;
  // The gate runner itself (gates.mjs, `cq gates`, `queue.mjs gates`), not any command that mentions the word.
  const gateRun = /\bgates\.mjs\b/.test(c) || /\b(cq|cq\.mjs|queue\.mjs)["']?\s+gates\b/.test(c);
  if (gateRun && /(^|\s)--(evidence|cwd)\b/.test(c))
    return (
      'a queue agent runs its gates without --evidence and --cwd (the evidence comes from cq receive and cq merge, ' +
      'not from the track); run `cq gates --quick` or `--full` in your own worktree'
    );
  return null;
}

module.exports = {
  FILE_NAME,
  MAX_ENTRIES,
  storeFile,
  readStore,
  writeStore,
  entry,
  add,
  append,
  covers,
  latest,
  verdict,
  fullGateVerdict,
  tamperReason,
};
