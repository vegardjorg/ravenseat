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
//   - its writer is the orchestrator: gates.mjs writes `writer: "orchestrator"` from its own process AFTER the gate
//     commands have exited (they are child processes with a scrubbed environment, lib/gateEnv.js, and never get the
//     store's path from gates.mjs). An entry with any other writer is never evidence;
//   - `sha` is the HEAD commit at the start of the run and HEAD did not move during it (gates.mjs leaves sha out then);
//   - `clean` is true: no uncommitted tracked changes when the run started (untracked files are not counted, as for the
//     base gate's skip rule);
//   - it ran every command the caller needs (the quick gates for receive, the full gates for the push);
//   - its `setup_hash` is the hash of the CURRENT control setup (setupHash: the configured quick and full gate
//     commands), when the caller asks for one. A changed gate setup needs a new run on the same sha; the old entries stay
//     in the store as history (the store is append-only, entries are never overwritten).
// The NEWEST entry for a sha and kind decides (a later red run beats an earlier green one).
//
// Legacy entries (written before setup_hash and writer existed, so they have neither field): they count only where they
// counted before, that is for the push check (fullGateVerdict) and for callers that pass no setup hash, and only while
// the caller allows legacy (`legacy: true`, the default). `cq receive` reuses only an entry with the current setup hash
// and writer "orchestrator" (`legacy: false`), so after the upgrade it runs the quick gates once more. An entry that HAS
// a writer other than "orchestrator" is never accepted, by any caller.
//
// Tamper check (recordRun): gates.mjs reads the store's text before the first gate command starts and compares it when
// the last one has exited. When it changed during the run (a gate command wrote to it, or another writer did at the
// same moment), the store is put back as it was BEFORE the run (whatever was written during the run is dropped) and the
// run's own entry is appended as RED with `tampered: true`. A concurrent orchestrator run then loses its entry and runs
// again: the safe direction. A process that writes after gates.mjs has exited is not caught (no OS isolation, below).
//
// Out of the track's reach: the store is a file in the data folder that no track instruction mentions, and the push
// guard (hook-push-guard.mjs) denies a queue agent's shell command that names the store or passes `--evidence` or
// `--cwd` to the gate runner (tamperReason). Limits, on purpose: the agents run as the same OS user. A queue agent's Write/Edit/
// NotebookEdit on the file is denied by hook-write-guard.mjs (lib/writeGuard.js), but a Bash write or a gate run after
// `cd` into the main checkout is not stopped by a hook; the store is a guard
// against claims and casual forgery, not a security boundary against a hostile process.
//
// The file: <dataFolder>/gate-evidence.json, { version: 1, entries: [entry, ...] } (the newest last, at most MAX_ENTRIES).
//   entry = { id, time, by: "gates.mjs", writer: "orchestrator", sha, setup_hash, kind: "quick"|"full", ok, exit, clean,
//             gates: [commands], failed: [commands], timed_out?, tampered?, track?, branch?, main_tree }
//   legacy entry = the same without id, writer and setup_hash.
// Pure except readStoreText/readStore/writeStore/append/recordRun (one small file, written atomically).
// Tested in lib/__tests__/gateEvidence.test.ts, __tests__/queueGateEvidence.test.ts and __tests__/queueBaseGate.test.ts.
// =============================================================
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/** The store's file name in the data folder. */
const FILE_NAME = 'gate-evidence.json';
/** Entries kept (the oldest dropped first). */
const MAX_ENTRIES = 200;
/** The kinds that can be evidence (a precheck runs only some checks on some files, never evidence). */
const KINDS = new Set(['quick', 'full']);
/** The only writer whose entries are evidence. */
const WRITER = 'orchestrator';

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const commandList = (v) => (Array.isArray(v) ? v.filter((g) => typeof g === 'string' && g.trim()).map((g) => g.trim()) : []);

/**
 * The hash of the control setup: the configured quick and full gate commands (config().gates), trimmed, in order. The
 * same commands in the same order give the same hash; any change (a command added, removed, edited or moved, in quick
 * or in full) gives another. Both lists go in, so a quick entry and a full entry from the same setup share the hash
 * (receive accepts a full run that covered the quick gates). sha256 hex. Pure.
 * @param {{ quick?: unknown, full?: unknown } | null | undefined} gates
 */
function setupHash(gates) {
  const text = JSON.stringify({ v: 1, quick: commandList(gates?.quick), full: commandList(gates?.full) });
  return crypto.createHash('sha256').update(text).digest('hex');
}

/** A new entry id (random, so two runs in the same millisecond differ). */
function newId() {
  return `ge-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

/** The store file in a data folder. */
function storeFile(folder) {
  return path.join(folder, FILE_NAME);
}

/** The store from the file's text (null: no file); an empty store when it is missing or broken. Pure. */
function parseStore(text) {
  try {
    const s = JSON.parse(String(text));
    if (isObject(s) && Array.isArray(s.entries)) return { version: 1, entries: s.entries.filter(isObject) };
  } catch {
    // missing or broken: no evidence, so the caller runs the gate or asks
  }
  return { version: 1, entries: [] };
}

/** The store file's raw text, or null when it cannot be read (the tamper check compares it before and after a run). */
function readStoreText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** The store's content; an empty store when the file is missing or broken (missing evidence is the safe direction). */
function readStore(file) {
  return parseStore(readStoreText(file));
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
 * The writer is always "orchestrator": only gates.mjs's own process calls this, after the gate commands have exited.
 * `setupHash` (setupHash(config().gates)) is left out only by old callers; such an entry is then trusted as legacy is.
 * `tampered` (recordRun) makes the entry red whatever the exit code.
 * @param {{ id?: string, time?: string, sha?: string|null, setupHash?: string|null, kind: string, exit: number,
 *   clean?: boolean, gates?: string[], failed?: string[], timedOut?: boolean, tampered?: boolean, track?: string|null,
 *   branch?: string|null, mainTree?: boolean }} r
 */
function entry(r) {
  if (!KINDS.has(r?.kind)) return null;
  if (typeof r.sha !== 'string' || !/^[0-9a-f]{7,64}$/i.test(r.sha)) return null;
  if (typeof r.clean !== 'boolean') return null;
  const e = {
    id: r.id ?? newId(),
    time: r.time ?? new Date().toISOString(),
    by: 'gates.mjs',
    writer: WRITER,
    sha: r.sha,
  };
  if (typeof r.setupHash === 'string' && r.setupHash) e.setup_hash = r.setupHash;
  Object.assign(e, {
    kind: r.kind,
    ok: r.exit === 0 && r.tampered !== true,
    exit: r.exit,
    clean: r.clean,
    gates: commandList(r.gates),
    failed: commandList(r.failed),
  });
  if (r.timedOut) e.timed_out = true;
  if (r.tampered) e.tampered = true;
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

/**
 * Records a finished run (gates.mjs, in its own process after every gate command has exited). `before` is the store's
 * raw text from readStoreText before the first gate command started. When the text is the same now, the entry is
 * appended. When it changed during the run, the store is put back to `before` and the entry is appended as RED with
 * `tampered: true` (the tamper check at the top). Never throws.
 * @param {{ file: string, before: string|null, entry: object|null }} r
 * @returns {{ recorded: boolean, tampered: boolean }}
 */
function recordRun({ file, before, entry: e }) {
  try {
    if (!file || !e) return { recorded: false, tampered: false };
    if (readStoreText(file) === before) return { recorded: append(file, e), tampered: false };
    writeStore(file, add(parseStore(before), { ...e, ok: false, tampered: true }));
    return { recorded: true, tampered: true };
  } catch {
    return { recorded: false, tampered: false }; // error-ignored: no evidence is the safe direction
  }
}

/** Is the entry from before writer and setup_hash existed (it has neither field)? */
function isLegacy(e) {
  return isObject(e) && !('writer' in e) && !('setup_hash' in e);
}

/**
 * May the entry speak for the caller's setup? Never when it has a writer other than the orchestrator. With
 * `legacy: false`: the writer must be the orchestrator and, when a setup hash is asked for, setup_hash must equal it.
 * With `legacy: true` (the default) an entry WITHOUT the field in question (no writer, or no setup_hash) passes that
 * check, as it did before the fields existed; a setup_hash that is present must still equal the one asked for. Pure.
 * @param {object} e
 * @param {{ setupHash?: string|null, legacy?: boolean }} [q]
 */
function trusted(e, { setupHash: want = null, legacy = true } = {}) {
  if (!isObject(e)) return false;
  if ('writer' in e ? e.writer !== WRITER : !legacy) return false;
  if (!want) return true;
  if ('setup_hash' in e) return e.setup_hash === want;
  return legacy;
}

/** Did the entry run every one of `commands`? */
function covers(e, commands) {
  const ran = new Set(commandList(e?.gates));
  return commandList(commands).every((c) => ran.has(c));
}

/**
 * The newest entry that speaks for `sha`: the same sha, a clean run, one of `kinds`, every one of `commands` ran, and
 * it is trusted for the caller's setup (trusted: the writer, `setupHash`, `legacy`). Green or red: the newest decides.
 * null when there is none.
 * @param {object[]} entries
 * @param {{ sha: string|null, kinds?: string[], commands?: string[], setupHash?: string|null, legacy?: boolean }} q
 */
function latest(entries, { sha, kinds = ['quick', 'full'], commands = [], setupHash: want = null, legacy = true }) {
  if (!sha) return null;
  const list = (entries ?? []).filter(
    (e) =>
      isObject(e) &&
      e.sha === sha &&
      e.clean === true &&
      kinds.includes(e.kind) &&
      covers(e, commands) &&
      trusted(e, { setupHash: want, legacy }),
  );
  return list.length ? list[list.length - 1] : null;
}

/**
 * The verdict for a commit: "green" (the newest matching entry is green), "red" (it is red) or "missing" (none).
 * "off" when there are no commands to require (no gates set up of that kind). The query is latest's.
 */
function verdict(entries, { sha, kinds = ['quick', 'full'], commands = [], setupHash: want = null, legacy = true }) {
  if (!commandList(commands).length) return 'off';
  const e = latest(entries, { sha, kinds, commands, setupHash: want, legacy });
  if (!e) return 'missing';
  return e.ok === true ? 'green' : 'red';
}

/**
 * The full-gate verdict for a tip from the data folder (the push check and the push guard), for the current control
 * setup (setupHash(cfg.gates)); legacy entries count as they did before. Never throws.
 */
function fullGateVerdict({ folder, sha, cfg }) {
  try {
    const commands = commandList(cfg?.gates?.full);
    if (!commands.length) return 'off';
    return verdict(readStore(storeFile(folder)).entries, {
      sha,
      kinds: ['full'],
      commands,
      setupHash: setupHash(cfg?.gates),
    });
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
  WRITER,
  setupHash,
  storeFile,
  parseStore,
  readStoreText,
  readStore,
  writeStore,
  entry,
  add,
  append,
  recordRun,
  isLegacy,
  trusted,
  covers,
  latest,
  verdict,
  fullGateVerdict,
  tamperReason,
};
