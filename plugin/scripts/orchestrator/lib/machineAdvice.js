// =============================================================
// machineAdvice.js: how many parallel tracks this machine can probably take, as an estimate. It changes nothing.
//
// The rule (2026-11-15), an ESTIMATE and never a promise:
//   floor((free memory - 3 margin - 2 for one heavy check) / 0.7 per track), at most one track per core, at least 1.
//   Free memory is what is free now with no track running when that is known; otherwise memory minus 8 GB for the
//   system and open apps. A track is the agent (about 0.1 GB) plus its quick check (about 0.6 GB for a light one).
//   One heavy check counts once, because the gate queue runs heavy checks one at a time. With the gate queue off, the
//   cap is one track per 1.5 cores, as checks then run side by side.
//
// Where the figures come from (measured on a laptop with 8 cores and 32 GB):
//   - The agent: the Claude processes held the same memory with 2 and with 7 tracks; track agents run inside the session
//     process, so one costs under 0.1 GB.
//   - A light quick check (Vitest and tsc on a small TypeScript project): about 0.6 GB at its peak. N of them at once
//     took N times the time, since each test run uses all cores; overlap slows down, it does not break the machine.
//   - A heavy project (a local database stack, tsc at 1.8 GB, ESLint at 4.3 GB) needs far less than this; for it,
//     `ravenseat machine --measure` measures the quick and the full check and gives the figure for that project.
//
// QUEUE_MACHINE="mem=<GB>,cores=<n>" replaces the reading (tests), as QUEUE_LOAD does for the load.
//
// Pure except readMachine. Used by cli/doctor.mjs, cli/machine.mjs and setup.mjs. Tested in lib/__tests__/machineAdvice.test.ts.
// =============================================================
'use strict';

const os = require('node:os');

const SYSTEM_GB = 8;
const MARGIN_GB = 3;
const HEAVY_GB = 2;
const AGENT_GB = 0.1;
const QUICK_GB = 0.6;
const CORES_PER_TRACK_NO_GATE_QUEUE = 1.5;
/** The one sentence that goes with the number everywhere it is shown. */
const WHY =
  'Estimate for a light project: about 0.1 GB per agent plus about 0.6 GB for its quick check, one heavy check of about 2 GB at a time (the gate queue), a 3 GB margin and at most one track per core. ' +
  'A project with heavy checks or a local database fits fewer: ravenseat machine --measure gives its figure.';

/** One decimal, the way the figures are shown. */
const gb1 = (x) => Math.round(x * 10) / 10;

/** The ceiling the cores give, at least 1: one per core with the gate queue on, one per 1.5 cores with it off. */
function coreCap(cores, gateQueue = true) {
  const per = gateQueue === false ? CORES_PER_TRACK_NO_GATE_QUEUE : 1;
  return Math.max(1, Math.floor(Number(cores) / per) || 1);
}

/** Tracks that fit in this much free memory, before the core cap. */
function byMemory(freeGb, heavyGb, trackGb) {
  const n = Math.floor((Number(freeGb) - MARGIN_GB - heavyGb) / trackGb + 1e-9);
  return Number.isFinite(n) ? n : 1;
}

/**
 * The suggested maxConcurrent. freeGb (free now, with no track running) replaces the fixed part for the system and apps.
 * @param {{ memGb: number, cores: number, freeGb?: number|null, gateQueue?: boolean }} x
 */
function suggestedTracks({ memGb, cores, freeGb = null, gateQueue = true }) {
  const free = Number.isFinite(freeGb) ? freeGb : Number(memGb) - SYSTEM_GB;
  return Math.max(1, Math.min(byMemory(free, HEAVY_GB, AGENT_GB + QUICK_GB), coreCap(cores, gateQueue)));
}

/** The machine as a short phrase: "8 cores, 31.5 GB". */
const machineText = ({ memGb, cores }) => `${cores} cores, ${memGb} GB`;

/**
 * The row for `ravenseat doctor`: never FAIL, WARN only when maxConcurrent is above the suggestion. It uses memory and
 * cores, not the free memory, so the row does not change with what runs at the moment.
 * @returns {{ status: 'OK'|'WARN', suggested: number, message: string, fix: string|null }}
 */
function doctorAdvice({ memGb, cores, maxConcurrent, gateQueue = true, ravenseat = 'ravenseat' }) {
  const suggested = suggestedTracks({ memGb, cores, gateQueue });
  const on = machineText({ memGb, cores });
  if (Number(maxConcurrent) > suggested)
    return {
      status: 'WARN',
      suggested,
      message: `maxConcurrent ${maxConcurrent} is above the suggested ${suggested} for ${on}. ${WHY}`,
      fix: `${ravenseat} limit maxConcurrent ${suggested}, or keep it if the load stays fine; ${ravenseat} machine --measure gives a figure for this project`,
    };
  return { status: 'OK', suggested, message: `${on}: about ${suggested} parallel track(s) fit, maxConcurrent is ${maxConcurrent} (estimate)`, fix: null };
}

/** The line for `ravenseat setup`. freeGb: free memory now (no track runs during setup). */
function setupLine({ memGb, cores, freeGb = null, gateQueue = true, ravenseat = 'ravenseat' }) {
  const suggested = suggestedTracks({ memGb, cores, freeGb, gateQueue });
  return `Machine: ${machineText({ memGb, cores })}: about ${suggested} parallel track(s) fit. ${WHY} Nothing was changed; ${ravenseat} limit maxConcurrent ${suggested} sets it.`;
}

/**
 * The suggestion for this project from one measured full check (and, when given, one quick check), or null when the
 * full check has no memory figure (then the general estimate is what there is). The full check's peak counts once (the
 * gate queue); the quick check's peak plus the agent is the cost of one track.
 * @param {{ memGb: number, cores: number, freeBeforePct: number|null, minFreePct: number|null,
 *   quickBeforePct?: number|null, quickMinFreePct?: number|null, gateQueue?: boolean }} x
 * @returns {{ suggested: number, usedGb: number, freeBeforeGb: number, quickGb: number|null, trackGb: number } | null}
 */
function measuredAdvice({ memGb, cores, freeBeforePct, minFreePct, quickBeforePct = null, quickMinFreePct = null, gateQueue = true }) {
  if (!Number.isFinite(freeBeforePct) || !Number.isFinite(minFreePct)) return null;
  const toGb = (pct) => gb1((Number(memGb) * pct) / 100);
  const freeBeforeGb = toGb(freeBeforePct);
  const usedGb = toGb(Math.max(0, freeBeforePct - minFreePct));
  const quickGb =
    Number.isFinite(quickBeforePct) && Number.isFinite(quickMinFreePct) ? toGb(Math.max(0, quickBeforePct - quickMinFreePct)) : null;
  const trackGb = gb1(AGENT_GB + (quickGb ?? QUICK_GB));
  const suggested = Math.max(1, Math.min(byMemory(freeBeforeGb, usedGb, trackGb), coreCap(cores, gateQueue)));
  return { suggested, usedGb, freeBeforeGb, quickGb, trackGb };
}

/** Parses QUEUE_MACHINE ("mem=<GB>,cores=<n>"), or null when it is not set or not complete. */
function parseOverride(text) {
  if (!text) return null;
  const out = {};
  for (const part of String(text).split(',')) {
    const [k, v] = part.split('=').map((x) => x.trim());
    if (Number.isFinite(Number(v)) && v !== '') out[k] = Number(v);
  }
  return out.mem > 0 && out.cores > 0 ? { memGb: out.mem, cores: out.cores } : null;
}

/** Memory in GB (one decimal) and the cores of this machine. QUEUE_MACHINE replaces the reading. */
function readMachine(env = process.env.QUEUE_MACHINE) {
  const override = parseOverride(env);
  if (override) return override;
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  return { memGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10, cores };
}

module.exports = { WHY, suggestedTracks, machineText, doctorAdvice, setupLine, measuredAdvice, parseOverride, readMachine };
