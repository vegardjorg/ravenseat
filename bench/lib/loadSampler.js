// =============================================================
// loadSampler.js: samples the machine's load at an interval and appends one JSONL row per sample.
//
// Why: with many parallel tracks the gates slow down and fail from timeouts and lack of memory, not from code errors,
// and none of that is visible as cost. To relate parallelism to duration, reruns and outcomes, the load must be
// recorded on its own clock, next to the time log. One row:
//   { time, free_memory_pct, free_mb, total_mb, cpu_pct, load_1m, processes, node_processes, disk_free_pct,
//     running_tracks, source }
// Fields that cannot be measured are null (never a guess). `source` is "os" or "override".
//
// Platform notes:
//   - CPU: os.loadavg() is always 0 on Windows, so cpu_pct comes from the delta of os.cpus() times between two samples
//     (works everywhere). load_1m is null on Windows.
//   - Process counts: `tasklist /fo csv /nh` on Windows, `ps -A -o comm=` elsewhere, with a 5 s timeout. A failure
//     gives null.
//   - Disk: fs.statfsSync on a given path (Node 18.15+); null if unavailable.
//   - Running tracks: when a queue file is given, the number of tasks with status running (English or Norwegian).
//
// BENCH_LOAD="free=50,cpu=20,procs=300,node=12,disk=40,tracks=3" replaces the measurement (tests, like QUEUE_LOAD in
// queue.mjs). The sampler never throws out of a tick: a failed sample is skipped, so it is safe in the background.
// Stop it with stop(), with SIGINT/SIGTERM, or by creating the stop file (`<out>.stop`), which also works on Windows
// where a detached process cannot be signalled easily.
//
// Tested in bench/__tests__/loadSampler.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const round1 = (x) => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10) / 10);

/** Parses BENCH_LOAD into a partial sample. Unknown keys are ignored. */
function parseOverride(env) {
  if (!env) return null;
  const map = {
    free: 'free_memory_pct',
    cpu: 'cpu_pct',
    load: 'load_1m',
    procs: 'processes',
    node: 'node_processes',
    disk: 'disk_free_pct',
    tracks: 'running_tracks',
  };
  const out = {};
  for (const part of String(env).split(',')) {
    const [k, v] = part.split('=').map((x) => x.trim());
    if (map[k] && v !== '' && Number.isFinite(Number(v))) out[map[k]] = Number(v);
  }
  return out;
}

/** Sum of the CPU times over all cores: { idle, total } (ms). */
function cpuTimes() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/** CPU busy share between two cpuTimes() readings, in percent. null without a previous reading. */
function cpuPct(prev, now) {
  if (!prev || !now) return null;
  const dt = now.total - prev.total;
  if (!(dt > 0)) return null;
  return round1((1 - (now.idle - prev.idle) / dt) * 100);
}

/**
 * Process names from the OS. Injected in tests via `listProcesses`.
 * @returns {string[]|null}
 */
function listProcessesOs(platform = process.platform) {
  try {
    if (platform === 'win32') {
      const r = spawnSync('tasklist', ['/fo', 'csv', '/nh'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
      if (r.status !== 0 || !r.stdout) return null;
      return r.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map((l) => l.split('","')[0].replace(/^"/, ''));
    }
    const r = spawnSync('ps', ['-A', '-o', 'comm='], { encoding: 'utf8', timeout: 5000 });
    if (r.status !== 0 || !r.stdout) return null;
    return r.stdout
      .split('\n')
      .map((l) => path.basename(l.trim()))
      .filter(Boolean);
  } catch {
    return null;
  }
}

/** Counts the processes whose name is node (node, node.exe). */
const isNode = (name) => /^node(\.exe)?$/i.test(String(name));

/** Free disk share for the volume of `dir`, in percent. */
function diskFreePct(dir) {
  try {
    if (!dir || typeof fs.statfsSync !== 'function') return null;
    const s = fs.statfsSync(dir);
    return s.blocks > 0 ? round1((s.bavail / s.blocks) * 100) : null;
  } catch {
    return null;
  }
}

/** Running tasks in a queue file (English `running` or Norwegian `kjorer`). null if the file cannot be read. */
function runningTracks(queueFile) {
  if (!queueFile) return null;
  try {
    const q = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
    const tasks = q.tasks ?? q.oppgaver ?? [];
    return tasks.filter((t) => t.status === 'running' || t.status === 'kjorer').length;
  } catch {
    return null;
  }
}

/**
 * One sample. `state` carries the previous CPU reading between calls (cpu_pct needs two readings).
 * @param {{ env?: string, listProcesses?: () => (string[]|null), diskDir?: string|null, queueFile?: string|null,
 *   now?: () => Date, state?: { cpu?: object } }} [opt]
 */
function sampleOnce(opt = {}) {
  const now = (opt.now ?? (() => new Date()))();
  const override = parseOverride(opt.env ?? process.env.BENCH_LOAD);
  if (override) {
    return {
      time: now.toISOString(),
      free_memory_pct: override.free_memory_pct ?? null,
      free_mb: null,
      total_mb: null,
      cpu_pct: override.cpu_pct ?? null,
      load_1m: override.load_1m ?? null,
      processes: override.processes ?? null,
      node_processes: override.node_processes ?? null,
      disk_free_pct: override.disk_free_pct ?? null,
      running_tracks: override.running_tracks ?? runningTracks(opt.queueFile),
      source: 'override',
    };
  }
  const state = opt.state ?? {};
  const total = os.totalmem();
  const free = os.freemem();
  const cpuNow = cpuTimes();
  const cpu = cpuPct(state.cpu, cpuNow);
  state.cpu = cpuNow;
  const names = (opt.listProcesses ?? listProcessesOs)();
  return {
    time: now.toISOString(),
    free_memory_pct: total > 0 ? round1((free / total) * 100) : null,
    free_mb: Math.round(free / 1048576),
    total_mb: Math.round(total / 1048576),
    cpu_pct: cpu,
    load_1m: process.platform === 'win32' ? null : round1(os.loadavg()[0]),
    processes: names ? names.length : null,
    node_processes: names ? names.filter(isNode).length : null,
    disk_free_pct: diskFreePct(opt.diskDir ?? null),
    running_tracks: runningTracks(opt.queueFile),
    source: 'os',
  };
}

/**
 * Starts sampling every `intervalMs` into `out` (JSONL, appended). Returns { stop, done } where `done` is a promise
 * that resolves with the number of rows written when sampling stops (stop(), duration reached or stop file found).
 */
function startSampler({ out, intervalMs = 30000, durationMs = null, stopFile = null, ...opt }) {
  if (!out) throw new Error('startSampler needs `out` (a JSONL file)');
  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  const stopAt = durationMs ? Date.now() + durationMs : null;
  const stopPath = stopFile ?? `${out}.stop`;
  const state = {};
  let rows = 0;
  let timer = null;
  let stopped = false;
  let finish;
  const done = new Promise((resolve) => (finish = resolve));
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    finish(rows);
  };
  const tick = () => {
    try {
      if (fs.existsSync(stopPath) || (stopAt && Date.now() >= stopAt)) return stop();
      fs.appendFileSync(out, `${JSON.stringify(sampleOnce({ ...opt, state }))}\n`);
      rows++;
    } catch {
      // never let one failed sample stop the sampler
    }
  };
  // The first reading only primes the CPU delta when measuring for real; the row is still written (cpu_pct null).
  tick();
  if (!stopped) timer = setInterval(tick, intervalMs);
  return { stop, done, stopPath };
}

/** Reads a load JSONL file into rows sorted by time (broken lines skipped). */
function readLoad(text) {
  const out = [];
  for (const l of String(text ?? '').split('\n')) {
    if (!l.trim()) continue;
    try {
      const r = JSON.parse(l);
      if (!Number.isNaN(Date.parse(r.time))) out.push(r);
    } catch {
      /* half line */
    }
  }
  return out.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
}

module.exports = {
  parseOverride,
  cpuTimes,
  cpuPct,
  listProcessesOs,
  isNode,
  diskFreePct,
  runningTracks,
  sampleOnce,
  startSampler,
  readLoad,
};
