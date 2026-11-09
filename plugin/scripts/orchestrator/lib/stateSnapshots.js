// =============================================================
// stateSnapshots.js: rolling copies of queue.json at a few ages (one hour, five hours, a day ...).
//
// WHY: queue.json.prev is one write older, so a bad change found an hour later (a wrong bulk edit, a script that
// rewrote half the tasks) has no copy left. These copies keep the state at a few ages, in
// <dataFolder>/snapshots/queue.<tier>.json, with no backup tool and next to no cost.
//
// HOW (on every write of queue.json, lib/stateFile.js writeState):
//   - One stat per tier, and nothing more when no tier is due. A tier is due when its copy is missing or at least as
//     old as the tier (by the copy's mtime, which a rename keeps).
//   - The tiers are handled oldest first. A due tier takes the next younger tier's copy (a rename, so no two tiers
//     ever hold the same copy) once that copy has reached its own tier's age; the youngest takes the current file. So a
//     copy moves up a tier as it ages, and each tier holds a state roughly between the younger tier's age and its own.
//     A new project fills the tiers one by one as the copies age (the 7d tier after about a week).
//   - The current file is only copied when it parses (a broken queue.json never pushes out a good copy).
//   - Never throws: a failed copy must not stop the write it sits next to.
// Turned off with stateSnapshots.enabled false in queue.config.json; the tiers are stateSnapshots.tiers ("30m", "1h",
// "5h", "1d", "7d" ...; 2 to 8 of them, shortest first after sorting).
//
// Used by: lib/stateFile.js (writeState), cli/context.mjs (write), cli/doctor.mjs (recovery hint).
// =============================================================

const nodeFs = require('node:fs');
const path = require('node:path');

const DEFAULT_TIERS = ['1h', '5h', '1d', '2d', '7d'];
const MAX_TIERS = 8;
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** "5h" → 18 000 000 ms, or null for a value that is not <number><m|h|d>. */
function tierMs(tier) {
  const m = /^\s*(\d+)\s*([mhd])\s*$/i.exec(String(tier ?? ''));
  if (!m || Number(m[1]) <= 0) return null;
  return Number(m[1]) * UNIT_MS[m[2].toLowerCase()];
}

/**
 * The tiers to keep, shortest first, without duplicates; [] when it is turned off. An unreadable list falls back to the
 * default, so a typo never turns the copies off without a word (doctor names it: tierProblem).
 * @returns {{ name: string, ms: number }[]}
 */
function tiersFrom(setting) {
  if (setting?.enabled === false) return [];
  const raw = Array.isArray(setting?.tiers) ? setting.tiers : DEFAULT_TIERS;
  const list = raw.map((name) => ({ name: String(name).trim().toLowerCase(), ms: tierMs(name) }));
  if (!list.length || list.length > MAX_TIERS || list.some((t) => t.ms == null)) return tiersFrom({ tiers: DEFAULT_TIERS });
  const seen = new Set();
  return list.sort((a, b) => a.ms - b.ms).filter((t) => (seen.has(t.ms) ? false : seen.add(t.ms)));
}

/** What is wrong with the tier setting, or null (for doctor). */
function tierProblem(setting) {
  if (setting?.enabled === false || setting?.tiers == null) return null;
  const t = setting.tiers;
  if (!Array.isArray(t) || !t.length) return 'stateSnapshots.tiers is not a list of ages such as ["1h", "1d"]';
  if (t.length > MAX_TIERS) return `stateSnapshots.tiers has ${t.length} ages; at most ${MAX_TIERS}`;
  const bad = t.filter((x) => tierMs(x) == null);
  return bad.length ? `stateSnapshots.tiers: ${bad.join(', ')} is not an age such as 30m, 5h or 7d` : null;
}

const folderOf = (file) => path.join(path.dirname(file), 'snapshots');
const copyPath = (file, tier) => path.join(folderOf(file), `${path.basename(file, '.json')}.${tier}.json`);

/**
 * Moves the copies one tier up where they are due, and puts the current file in the youngest tier when it is due.
 * @param {string} file queue.json
 * @param {{ name: string, ms: number }[]} tiers from tiersFrom
 * @param {{ fs?: typeof nodeFs, now?: number }} [o]
 * @returns {string[]} the tiers that got a new copy
 */
function roll(file, tiers, o = {}) {
  const f = o.fs ?? nodeFs;
  const now = o.now ?? Date.now();
  const changed = [];
  if (!tiers?.length) return changed;
  try {
    const age = (p) => {
      try {
        return now - f.statSync(p).mtimeMs;
      } catch {
        return null; // missing
      }
    };
    const due = (i) => {
      const a = age(copyPath(file, tiers[i].name));
      return a == null || a >= tiers[i].ms;
    };
    let folderMade = false;
    const ensureFolder = () => {
      if (!folderMade) f.mkdirSync(folderOf(file), { recursive: true });
      folderMade = true;
    };
    for (let i = tiers.length - 1; i >= 1; i--) {
      if (!due(i)) continue;
      const younger = copyPath(file, tiers[i - 1].name);
      // Only a copy that has reached its own tier's age moves up: otherwise an empty tier would pull a copy made a
      // second ago, and the first few writes would race one copy through every tier.
      const ya = age(younger);
      if (ya == null || ya < tiers[i - 1].ms) continue;
      ensureFolder();
      f.renameSync(younger, copyPath(file, tiers[i].name));
      changed.push(tiers[i].name);
    }
    if (due(0)) {
      const text = f.readFileSync(file, 'utf8');
      JSON.parse(text);
      ensureFolder();
      const target = copyPath(file, tiers[0].name);
      const tmp = `${target}.${process.pid}.tmp`;
      f.writeFileSync(tmp, text);
      f.renameSync(tmp, target);
      changed.push(tiers[0].name);
    }
  } catch {
    /* never in the way: a missing or broken queue.json, or a full disk, leaves the copies as they are */
  }
  return changed;
}

/** The copies that exist, youngest first: { tier, path, at (ISO), tasks } (tasks null when the copy does not parse). */
function list(file, tiers, o = {}) {
  const f = o.fs ?? nodeFs;
  const out = [];
  for (const t of tiers ?? []) {
    const p = copyPath(file, t.name);
    let st;
    try {
      st = f.statSync(p);
    } catch {
      continue;
    }
    let tasks = null;
    try {
      const q = JSON.parse(f.readFileSync(p, 'utf8'));
      tasks = Array.isArray(q?.tasks) ? q.tasks.length : null;
    } catch {
      /* listed, with no count */
    }
    out.push({ tier: t.name, path: p, at: new Date(st.mtimeMs).toISOString(), tasks });
  }
  return out;
}

module.exports = { DEFAULT_TIERS, MAX_TIERS, tierMs, tiersFrom, tierProblem, copyPath, folderOf, roll, list };
