// =============================================================
// lib/processGuard.js: the process guard (roadmap 0s part A). Which processes Ravenseat started are still running,
// which outlived the process that started them or their time budget, and which tracks run far over their estimate.
//
// Why: the time budgets and the tree guard (lib/treeRun.js, 0o) end a gate command when its budget runs out or its
// runner dies. When one of those fails anyway (a guard that was itself killed, a machine that slept, a bug), nothing
// told anyone: 21 gate processes once ran on for two days. The register makes every guarded run visible, and the sweep
// names the ones left over with the exact command that ends them.
//
// The parts:
//   V2 register   every guarded run (gate commands in gates.mjs runShell, done commands, the base gate, the red-on-base
//                 check and the base check through lib/treeRun.js runBounded, wait-mode runs through lib/waitRunner.js)
//                 writes <dataFolder>/processes/<pid>.json: pid, the pid of the process that started it, owner (the
//                 track, or the kind and a short command label), track, kind, start and max time. The guard itself
//                 writes it when it starts and removes it when its command ends. One file per process, so no lock and
//                 no lost update. processGuard.register (on: it costs one small file and stops nothing).
//   V3 sweep      doctor and the pulse check read the register: a dead pid is a stale file and is removed; a live one
//                 whose starter is gone ("owner gone") or that is over its max time plus a minute ("over time") is a
//                 finding with pid, owner, age and the stop command (the whole tree). processGuard.sweep (on, display).
//                 processGuard.autoKill (off: it can stop work) ends those findings, but only after the process is
//                 confirmed as a Ravenseat guard by its command line; a pid it cannot confirm is only shown. It never
//                 looks at a process that is not in the register, so it never touches what Ravenseat did not start.
//   V6 track tag  a run for a track gets RAVENSEAT_TRACK=<id> in its environment (kept when the caller already had one),
//                 so the register and the sweep name the track. No setting: an environment variable changes nothing.
//   V7 priority   the guard of a heavy run (gate, done, base) lowers its own priority to BELOW_NORMAL before it starts
//                 the command, so the command and its children inherit it (nice on POSIX; on Windows a child of a
//                 BELOW_NORMAL process inherits that class). Never IDLE, which could starve a run on a busy machine.
//                 The wait runner, dev servers and the main session's own commands are never touched: they do not run
//                 under a heavy guard. processGuard.lowerPriority (on: it slows, it stops nothing).
//   V4 overtime   a running track whose time since start is over tracks.overtimeFactor x its estimate (lib/logic/base.js
//                 estimate, the minutes shown in `ravenseat show`) gets a WARN row and a Checks card. Never a stop. 2 by
//                 default (owner 16.11); 0 = off.
//   V8 untagged   a live heavy run without a track tag that has run over 30 minutes (a long gate in the main checkout):
//                 one INFO row and a low Checks card, display only (under processGuard.sweep).
//
// How the guard learns what to do: the caller puts RAVENSEAT_GUARD_META (JSON from metaFor) in the guard's environment;
// the guard reads it, registers, maybe lowers its priority, and starts the command with the meta removed (childEnv) but
// the track tag kept. No meta (a caller that passes none, a test): the guard does exactly what it did before.
//
// Pure except register, unregister, readRegister, prune, lowerSelf and identify (small file I/O, one priority call,
// one read-only process query). Used by lib/treeRun.js, gates.mjs, lib/doneCheck.js, lib/waitMode.js, cli/doctor.mjs,
// cli/pulseCheck.mjs and cli/checks.mjs. Tested in lib/__tests__/processGuard.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const nodeOs = require('node:os');
const path = require('node:path');

/** The environment variable that carries the meta from the caller to the guard. */
const META_ENV = 'RAVENSEAT_GUARD_META';
/** The track tag (V6) on every process started for a track. */
const TRACK_ENV = 'RAVENSEAT_TRACK';
/** The register's folder under the data folder. */
const DIR = 'processes';
/** The kinds whose guard lowers its priority (V7) and that count for the untagged card (V8). */
const HEAVY = new Set(['gate', 'done', 'base']);
/** A run counts as over time only this long after its max time: the runner's own grace ends it first. */
const SLACK_MS = 60_000;
/** A heavy run without a track tag is shown as long running after this (V8). */
const UNTAGGED_LONG_MS = 30 * 60_000;
/** A register file of a dead pid younger than this may be one being written: left alone. */
const FRESH_MS = 60_000;
const DEFAULTS = Object.freeze({ register: true, sweep: true, autoKill: false, lowerPriority: true, overtimeFactor: 2 });

/** The settings (processGuard.*, tracks.overtimeFactor) with the defaults filled in. */
function setupOf(cfg = {}) {
  const g = cfg?.processGuard ?? {};
  const on = (v, d) => (typeof v === 'boolean' ? v : d);
  const f = cfg?.tracks?.overtimeFactor;
  return {
    register: on(g.register, DEFAULTS.register),
    sweep: on(g.sweep, DEFAULTS.sweep),
    autoKill: on(g.autoKill, DEFAULTS.autoKill),
    lowerPriority: on(g.lowerPriority, DEFAULTS.lowerPriority),
    overtimeFactor: typeof f === 'number' && Number.isFinite(f) && f >= 0 ? f : DEFAULTS.overtimeFactor,
  };
}

/**
 * A short label for a command: its first words, without any NAME=value word or anything after a value-like flag
 * (a command line can carry a token). At most 60 characters.
 */
function labelOf(command) {
  const words = String(command ?? '').trim().split(/\s+/).filter(Boolean);
  const kept = [];
  for (const w of words) {
    if (w.includes('=')) continue;
    if (kept.length >= 3) break;
    kept.push(w);
  }
  return kept.join(' ').slice(0, 60);
}

/**
 * The meta for a guard (a JSON string for META_ENV), or null when neither the register nor the priority is on.
 * @param {object} cfg config()
 * @param {{ folder: string, kind: 'gate'|'done'|'base'|'wait', track?: string|null, maxMs?: number|null, command?: string }} x
 */
function metaFor(cfg, { folder, kind, track = null, maxMs = null, command = '' }) {
  const s = setupOf(cfg);
  const lower = s.lowerPriority && HEAVY.has(kind);
  if (!s.register && !lower) return null;
  const label = labelOf(command);
  return JSON.stringify({
    dir: s.register && folder ? path.join(folder, DIR) : null,
    kind,
    track: track || null,
    owner: track || (label ? `${kind}: ${label}` : kind),
    maxMs: Number.isFinite(maxMs) && maxMs > 0 ? Math.round(maxMs) : null,
    label,
    lower,
  });
}

/** The environment with the meta, and the track tag unless the caller already has one. null meta: unchanged. */
function withMeta(env, meta) {
  if (!meta) return env;
  const out = { ...env, [META_ENV]: meta };
  let track = null;
  try {
    track = JSON.parse(meta).track;
  } catch {
    // error-ignored: no track then
  }
  if (track && !out[TRACK_ENV]) out[TRACK_ENV] = track;
  return out;
}

/** The meta in an environment, or null. */
function readMeta(env) {
  const text = env?.[META_ENV];
  if (!text) return null;
  try {
    const m = JSON.parse(text);
    return m && typeof m === 'object' ? m : null;
  } catch {
    return null;
  }
}

/** The environment for the guard's command: the same, without the meta (the track tag stays). */
function childEnv(env) {
  const out = { ...env };
  delete out[META_ENV];
  return out;
}

/** Writes the register file for `pid` (atomic rename). Returns its path, or null (no folder, or it cannot write). */
function register(meta, { pid, parentPid, now = Date.now() }) {
  if (!meta?.dir) return null;
  const file = path.join(meta.dir, `${pid}.json`);
  const row = {
    pid,
    parentPid,
    kind: meta.kind ?? null,
    owner: meta.owner ?? null,
    track: meta.track ?? null,
    label: meta.label ?? '',
    maxMs: meta.maxMs ?? null,
    startedAt: new Date(now).toISOString(),
  };
  try {
    fs.mkdirSync(meta.dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(row));
    fs.renameSync(tmp, file);
    return file;
  } catch {
    return null; // fail open: the register shows, it never stops a run
  }
}

/** Removes a register file. Never throws. */
function unregister(file) {
  if (!file) return;
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // error-ignored: the sweep removes a file of a dead pid
  }
}

/** The register's rows, each with its `file` and `mtimeMs`. An unreadable folder or row is skipped. */
function readRegister(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const n of names.sort()) {
    if (!/^\d+\.json$/.test(n)) continue;
    const file = path.join(dir, n);
    try {
      const row = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Number.isInteger(row?.pid)) out.push({ ...row, file, mtimeMs: fs.statSync(file).mtimeMs });
    } catch {
      // error-ignored: a half-written or foreign file
    }
  }
  return out;
}

/** True while `pid` runs (EPERM: it runs, as another user). */
function alive(pid) {
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === 'EPERM';
  }
}

/**
 * Sorts the register: `gone` (files of dead pids, to remove), `left` (alive, and the starter is gone or it is over its
 * max time plus SLACK_MS; `why` says which) and `untagged` (alive heavy runs without a track over UNTAGGED_LONG_MS,
 * not already in left). Pure: `alive` is passed in.
 */
function classify(entries, { now = Date.now(), alive: isAlive = alive } = {}) {
  const gone = [];
  const left = [];
  const untagged = [];
  for (const e of entries ?? []) {
    const started = Date.parse(e.startedAt ?? '');
    const ageMs = Number.isFinite(started) ? Math.max(0, now - started) : 0;
    if (!isAlive(e.pid)) {
      if (e.file && !(Number.isFinite(e.mtimeMs) && now - e.mtimeMs < FRESH_MS)) gone.push(e.file);
      continue;
    }
    const ownerGone = e.parentPid > 0 && !isAlive(e.parentPid);
    const overTime = Number.isFinite(e.maxMs) && e.maxMs > 0 && ageMs > e.maxMs + SLACK_MS;
    if (ownerGone || overTime) left.push({ ...e, ageMs, why: ownerGone ? 'owner gone' : 'over time' });
    else if (!e.track && HEAVY.has(e.kind) && ageMs > UNTAGGED_LONG_MS) untagged.push({ ...e, ageMs });
  }
  return { gone, left, untagged };
}

/** Removes the files of dead pids (classify's `gone`). */
function prune(files) {
  for (const f of files ?? []) unregister(f);
}

/** The command that ends a registered run and everything it started (the guard leads its own group on POSIX). */
function stopCommand(pid, platform = process.platform) {
  return platform === 'win32' ? `taskkill /pid ${pid} /T /F` : `kill -KILL -- -${pid}`;
}

/**
 * True when `pid` is a Ravenseat guard: its command line runs lib/treeRun.js as `guard`. Read only (ps on POSIX, a CIM
 * query on Windows). Anything unclear is false, so the automatic stop leaves it alone.
 */
function identify(pid, { platform = process.platform, spawnSync = require('node:child_process').spawnSync } = {}) {
  if (!(pid > 0)) return false;
  try {
    const r =
      platform === 'win32'
        ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], {
            encoding: 'utf8',
            timeout: 15_000,
            windowsHide: true,
          })
        : spawnSync('ps', ['-o', 'args=', '-p', String(Number(pid))], { encoding: 'utf8', timeout: 5000 });
    const line = String(r?.stdout ?? '');
    return r?.status === 0 && /treeRun\.js/.test(line) && /\bguard\b/.test(line);
  } catch {
    return false;
  }
}

/** With `on`, ends each finding confirmed by `identify`; returns the pids it ended. Off: nothing. */
function autoStop(left, { on, identify: isOurs = identify, killTree }) {
  if (!on) return [];
  const killed = [];
  for (const e of left ?? []) {
    if (!isOurs(e.pid)) continue;
    try {
      killTree(e.pid);
      killed.push(e.pid);
    } catch {
      // error-ignored: shown again on the next sweep
    }
  }
  return killed;
}

/**
 * The running tracks over factor x estimate: [{ id, elapsedMin, estimateMin }]. Only status running with a start time;
 * factor 0 (or less) gives none. The estimate is lib/logic/base.js estimate (content minutes x class weight).
 */
function overtimeTracks(tasks, { now = Date.now(), factor = DEFAULTS.overtimeFactor } = {}) {
  if (!(factor > 0)) return [];
  const { estimate } = require('./logic/base.js');
  const out = [];
  for (const o of tasks ?? []) {
    if (o?.status !== 'running') continue;
    const started = Date.parse(o.started ?? '');
    if (!Number.isFinite(started)) continue;
    const estimateMin = estimate(o);
    const elapsedMin = Math.floor((now - started) / 60_000);
    if (estimateMin > 0 && elapsedMin > factor * estimateMin) out.push({ id: o.id, elapsedMin, estimateMin });
  }
  return out;
}

/** Lowers this process to BELOW_NORMAL (never IDLE). True when it was set; a refusal is no error. */
function lowerSelf({ os = nodeOs } = {}) {
  try {
    os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL);
    return true;
  } catch {
    return false;
  }
}

/** "5 min", "1 h 15 min". */
function ageText(ms) {
  const min = Math.floor(Math.max(0, ms) / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${min % 60} min`;
}

/** One finding as text: pid, owner, age and why. */
function findingText(e) {
  const why = e.why === 'owner gone' ? 'the process that started it is gone' : `over its max time of ${ageText(e.maxMs)}`;
  return `pid ${e.pid} (${e.owner ?? e.kind ?? '?'}, running ${ageText(e.ageMs)}: ${why})`;
}

/**
 * Doctor's rows: `processes` (OK, or WARN with the findings and their stop commands; INFO for long untagged runs) and
 * `overtime` (WARN per track over the factor, only when there is one). Never FAIL.
 */
function doctorRows(s, { platform = process.platform, overtime = [], factor = DEFAULTS.overtimeFactor, killed = [] } = {}) {
  const rows = [];
  const left = s?.left ?? [];
  if (left.length)
    rows.push({
      status: 'WARN',
      name: 'processes',
      message: `${left.length} process(es) Ravenseat started outlived their owner or their time budget: ${left.map(findingText).join('; ')}`,
      fix: `stop each (it and what it started): ${left.map((e) => stopCommand(e.pid, platform)).join(' ; ')}`,
    });
  else rows.push({ status: 'OK', name: 'processes', message: 'no process Ravenseat started is left over', fix: null });
  if (killed.length) rows.push({ status: 'INFO', name: 'processes', message: `stopped by processGuard.autoKill: pid ${killed.join(', ')}`, fix: null });
  const long = s?.untagged ?? [];
  if (long.length)
    rows.push({
      status: 'INFO',
      name: 'processes',
      message: `${long.length} heavy run(s) without a track have run long: ${long.map((e) => `pid ${e.pid} (${e.owner ?? e.kind}, ${ageText(e.ageMs)})`).join('; ')}`,
      fix: `nothing to do while it is expected; to stop one: ${stopCommand(long[0].pid, platform)}`,
    });
  if (overtime.length)
    rows.push({
      status: 'WARN',
      name: 'overtime',
      message: `${overtime.length} running track(s) over ${factor}x their estimate: ${overtime.map((o) => `${o.id} (${o.elapsedMin} min, estimate ${o.estimateMin} min)`).join('; ')}`,
      fix: 'look at the track (ravenseat explain <id>); nothing is stopped. tracks.overtimeFactor 0 turns this off',
    });
  return rows;
}

/** The pulse check's ACTION lines: one per finding, with the stop command. Long untagged runs are not an action. */
function pulseItems(s, { platform = process.platform } = {}) {
  return (s?.left ?? []).map((e) => `PROCESS ${e.pid}: ${findingText(e)}. Next: look at it; ${stopCommand(e.pid, platform)} stops it and what it started`);
}

/**
 * The sweep as doctor and the pulse run it: reads the register under `folder`, removes stale files, and with
 * processGuard.autoKill ends the confirmed findings. Off (processGuard.sweep false) or unreadable: nothing.
 * @returns {{ left: object[], untagged: object[], gone: string[], killed: number[] } | null}
 */
function sweepFolder(folder, cfg, { now = Date.now(), killTree = null } = {}) {
  const s = setupOf(cfg);
  if (!s.sweep || !folder) return null;
  try {
    const found = classify(readRegister(path.join(folder, DIR)), { now });
    prune(found.gone);
    const end = killTree ?? require('./treeRun.js').killTree;
    const killed = autoStop(found.left, { on: s.autoKill, killTree: end });
    const left = found.left.filter((e) => !killed.includes(e.pid));
    return { ...found, left, killed };
  } catch {
    return null;
  }
}

/**
 * Doctor's rows (cli/doctor.mjs): the sweep (with its pruning and, when on, the automatic stop) and the overtime
 * tracks. Sweep off: only the overtime rows. Never FAIL.
 */
function rowsFor({ folder, cfg, tasks = [], now = Date.now(), platform = process.platform, killTree = null }) {
  const s = setupOf(cfg);
  const swept = sweepFolder(folder, cfg, { now, killTree });
  const overtime = overtimeTracks(tasks, { now, factor: s.overtimeFactor });
  if (!swept) return overtime.length ? doctorRows(null, { platform, overtime, factor: s.overtimeFactor }).filter((r) => r.name === 'overtime') : [];
  return doctorRows(swept, { platform, overtime, factor: s.overtimeFactor, killed: swept.killed });
}

/** The pulse check's PROCESS lines (cli/pulseCheck.mjs): the sweep's findings. Sweep off: none. */
function pulseFor({ folder, cfg, now = Date.now(), platform = process.platform, killTree = null }) {
  const swept = sweepFolder(folder, cfg, { now, killTree });
  return swept ? pulseItems(swept, { platform }) : [];
}

/**
 * The facts for the Checks cards (cli/checks.mjs, lib/checksCatalog.js conditions processes-left, processes-untagged,
 * tracks-overtime). Read only: no pruning and no stop here, since the board reads this on every refresh.
 */
function factsFor({ folder, cfg, tasks = [], now = Date.now(), platform = process.platform, isAlive = alive }) {
  const s = setupOf(cfg);
  const out = { left: [], untagged: [], overtime: [], factor: s.overtimeFactor };
  try {
    out.overtime = overtimeTracks(tasks, { now, factor: s.overtimeFactor });
  } catch {
    // error-ignored: no overtime card
  }
  if (!s.sweep || !folder) return out;
  try {
    const found = classify(readRegister(path.join(folder, DIR)), { now, alive: isAlive });
    const shown = (e) => ({ pid: e.pid, owner: e.owner ?? e.kind ?? '?', age: ageText(e.ageMs), why: e.why ?? null, stop: stopCommand(e.pid, platform) });
    out.left = found.left.map(shown);
    out.untagged = found.untagged.map(shown);
  } catch {
    // error-ignored: no card
  }
  return out;
}

/** The detail line of a process guard card (lib/checksCatalog.js detailOf), or null. */
function cardLine(key, f) {
  if (!f) return null;
  const list = (xs) => xs.slice(0, 5).map((e) => `pid ${e.pid} (${e.owner}, ${e.age}${e.why ? `, ${e.why}` : ''}): \`${e.stop}\``).join('; ');
  if (key === 'processes-left' && f.left?.length) return `Left over: ${list(f.left)}.`;
  if (key === 'processes-untagged' && f.untagged?.length) return `Running long without a track: ${list(f.untagged)}.`;
  if (key === 'tracks-overtime' && f.overtime?.length)
    return `Over ${f.factor}x the estimate: ${f.overtime.slice(0, 5).map((o) => `${o.id} (${o.elapsedMin} min, estimate ${o.estimateMin} min)`).join('; ')}.`;
  return null;
}

module.exports = {
  DEFAULTS,
  cardLine,
  factsFor,
  pulseFor,
  rowsFor,
  DIR,
  HEAVY,
  META_ENV,
  SLACK_MS,
  TRACK_ENV,
  UNTAGGED_LONG_MS,
  ageText,
  alive,
  autoStop,
  childEnv,
  classify,
  doctorRows,
  findingText,
  identify,
  labelOf,
  lowerSelf,
  metaFor,
  overtimeTracks,
  prune,
  pulseItems,
  readMeta,
  readRegister,
  register,
  setupOf,
  stopCommand,
  sweepFolder,
  unregister,
  withMeta,
};
