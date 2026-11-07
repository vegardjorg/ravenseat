// =============================================================
// gateTemp.js: a temp folder of its own for each gate run, removed afterwards, and the doctor's line about the temp folder.
//
// Why: a project's tests leave things in the temp folder, and over thousands of runs it fills up. Ravenseat cannot know
// the prefixes a project's tests use, and must not sweep other programs' folders by guessing. So gates.mjs points TEMP, TMP
// and TMPDIR of its gate commands at one folder per run and removes that folder when the run ends. What the tests leave
// goes with it, without Ravenseat knowing what it was.
//
// Rules:
//   - gates.mjs itself keeps the real temp folder. The gate queue's slots (ravenseat-gate-queue-<user>) stay there, so
//     every run still shares them.
//   - The folder is made at the first gate command, so a run that waits in the gate queue holds no folder.
//   - A link or junction anywhere in the folder stops the removal: removing through one can delete what it points at.
//     The folder stays, and the run says so.
//   - Fail open: a folder that cannot be made means the normal temp folder, and a removal that fails leaves the folder.
//     This is housekeeping, so it never changes a gate's result.
//   - A killed run leaves its folder. The next run on the machine sweeps it: only our own names, only when the process in
//     the name is gone and the folder is older than an hour.
//   - gateTemp.enabled false in queue.config.json turns it off, for a project whose tests need the shared temp folder.
//
// Limits, said honestly: the commands of a separate base gate (baseGate.commands) and a task's done command keep the normal
// temp folder, and a process that outlives the run can keep writing or hold a file on Windows.
//
// Used by gates.mjs and cli/doctor.mjs. Tested in lib/__tests__/gateTemp.test.ts and __tests__/gateTempFlow.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PREFIX = 'ravenseat-gate-run-';
/** Only a whole name of this shape is ours to sweep. ravenseat-gate-queue-<user> does not match. */
const OURS = /^ravenseat-gate-run-(\d+)-[^/\\]+$/;
const SWEEP_AFTER_MS = 3_600_000;
const NAMES = ['TEMP', 'TMP', 'TMPDIR'];

/** Above this many entries the doctor's line becomes a hint. A number of entries, never a size: it must stay fast. */
const FULL_ENTRIES = 5000;
/** What Ravenseat and its tests make in the temp folder. */
const OWN = /^(ravenseat-|merge-track-|cloud-package-|queue-)/;

/** Is `pid` running? A process we may not signal is running too. */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

/** `env` with the temp variables pointing at `dir`. Without `dir`, `env` itself. Pure. */
function withTemp(env, dir) {
  if (!dir) return env;
  const out = {};
  // Every case variant goes: on Windows a child sees only one of Temp and TEMP, and which one is not ours to decide.
  for (const [name, value] of Object.entries(env)) if (!NAMES.includes(name.toUpperCase())) out[name] = value;
  for (const name of NAMES) out[name] = dir;
  return out;
}

/** Is there a link or a junction somewhere under `dir`? lstat reports a junction as a link. An unreadable folder counts. */
function hasLink(dir) {
  const stack = [dir];
  while (stack.length) {
    const here = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(here, { withFileTypes: true });
    } catch (e) {
      if (e?.code === 'ENOENT') continue;
      return true;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) return true;
      if (entry.isDirectory()) stack.push(path.join(here, entry.name));
    }
  }
  return false;
}

/**
 * Removes a run's folder, unless it holds a link. Never throws.
 * @returns {{ removed: boolean, link: boolean }}
 */
function remove(dir) {
  if (hasLink(dir)) return { removed: false, link: true };
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
    return { removed: true, link: false };
  } catch {
    return { removed: false, link: false }; // a process still holds a file: the sweep takes it later
  }
}

/**
 * Removes what killed runs left under `base`: our own names, the process gone, older than an hour. Never throws.
 * @returns {number} how many folders were removed
 */
function sweep(base, { alive = isAlive, now = Date.now() } = {}) {
  let names;
  try {
    names = fs.readdirSync(base);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    const match = OURS.exec(name);
    if (!match || alive(Number(match[1]))) continue;
    const dir = path.join(base, name);
    try {
      if (now - fs.lstatSync(dir).mtimeMs < SWEEP_AFTER_MS) continue;
    } catch {
      continue;
    }
    if (remove(dir).removed) removed++;
  }
  return removed;
}

/**
 * Makes this run's folder under `base`, after sweeping old ones.
 * @returns {string|null} the folder, or null when it cannot be made (the gate then uses the normal temp folder)
 */
function create({ base = os.tmpdir(), pid = process.pid, alive = isAlive } = {}) {
  sweep(base, { alive });
  try {
    return fs.mkdtempSync(path.join(base, `${PREFIX}${pid}-`));
  } catch {
    return null;
  }
}

/** The prefix a name is counted under: up to the first separator. "pip-install-x" is "pip". Pure. */
function prefixOf(name) {
  return String(name).toLowerCase().split(/[-_.]/)[0] || '(other)';
}

/**
 * Counts names per prefix. Ravenseat's own are counted apart, not in the list. Pure.
 * @returns {{ total: number, own: number, top: { prefix: string, count: number }[] }}
 */
function usage(names) {
  const counts = new Map();
  let own = 0;
  for (const name of names) {
    if (OWN.test(name)) {
      own++;
      continue;
    }
    const prefix = prefixOf(name);
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  const top = [...counts].map(([prefix, count]) => ({ prefix, count })).sort((a, b) => b.count - a.count || a.prefix.localeCompare(b.prefix));
  return { total: names.length, own, top };
}

/**
 * The doctor's line from the names in the temp folder. It says who left the most and changes nothing.
 * @returns {{ status: 'OK'|'INFO', message: string, fix: string|null }}
 */
function doctorLine(names) {
  const { total, own, top } = usage(names);
  const most = top.slice(0, 3).map((t) => `${t.prefix} ${t.count}`).join(', ');
  const message = `${total} entries in the temp folder.${most ? ` Most: ${most}.` : ''} Ravenseat's own: ${own}.`;
  if (total < FULL_ENTRIES) return { status: 'OK', message, fix: null };
  return {
    status: 'INFO',
    message,
    fix: 'the prefix tells which program left them, and Ravenseat only removes its own. A plugin hook runs once per agent: see "The temp folder" in docs/queue.md',
  };
}

/** The names in the temp folder, or null when it cannot be read. */
function readNames(base = os.tmpdir()) {
  try {
    return fs.readdirSync(base);
  } catch {
    return null;
  }
}

module.exports = { PREFIX, FULL_ENTRIES, withTemp, hasLink, remove, sweep, create, usage, doctorLine, readNames };
