// =============================================================
// machineAdvice.js: how many parallel tracks this machine can probably take, as an estimate. It changes nothing.
//
// The rule, from one machine and one large project, so an ESTIMATE and never a promise:
//   floor((memory GB - 16 - 4) / 2.5), at most cores / 1.5, at least 1.
//   16 GB is what the system, open apps and a local test stack hold before any track starts, 4 GB is the margin and one
//   track costs about 2.5 GB. That gives about 1 track on 16 GB, 4 on 32 GB with 8 cores and 8 on 64 GB with 12 cores.
//
// measuredAdvice uses what `ravenseat machine --measure` saw instead of the fixed 16 GB and the general figure for a full
// check: the memory free before the run, and how far it fell during it.
//
// QUEUE_MACHINE="mem=<GB>,cores=<n>" replaces the reading (tests), as QUEUE_LOAD does for the load.
//
// Pure except readMachine. Used by cli/doctor.mjs, cli/machine.mjs and setup.mjs. Tested in lib/__tests__/machineAdvice.test.ts.
// =============================================================
'use strict';

const os = require('node:os');

const FIXED_GB = 16;
const MARGIN_GB = 4;
const TRACK_GB = 2.5;
const CORES_PER_TRACK = 1.5;
/** The one sentence that goes with the number everywhere it is shown. */
const WHY =
  'Estimate from one machine and one large project: about 20 GB kept for the system, open apps and a margin, about 2.5 GB per track, at most one track per 1.5 cores.';

/** The ceiling the cores give, at least 1. */
const coreCap = (cores) => Math.max(1, Math.floor(Number(cores) / CORES_PER_TRACK) || 1);

/** The suggested maxConcurrent for this much memory and these cores. */
function suggestedTracks({ memGb, cores }) {
  const byMemory = Math.floor((Number(memGb) - FIXED_GB - MARGIN_GB) / TRACK_GB);
  return Math.max(1, Math.min(Number.isFinite(byMemory) ? byMemory : 1, coreCap(cores)));
}

/** The machine as a short phrase: "8 cores, 31.5 GB". */
const machineText = ({ memGb, cores }) => `${cores} cores, ${memGb} GB`;

/**
 * The row for `ravenseat doctor`: never FAIL, WARN only when maxConcurrent is above the suggestion.
 * @returns {{ status: 'OK'|'WARN', suggested: number, message: string, fix: string|null }}
 */
function doctorAdvice({ memGb, cores, maxConcurrent, ravenseat = 'ravenseat' }) {
  const suggested = suggestedTracks({ memGb, cores });
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

/** The line for `ravenseat setup`. */
function setupLine({ memGb, cores, ravenseat = 'ravenseat' }) {
  const suggested = suggestedTracks({ memGb, cores });
  return `Machine: ${machineText({ memGb, cores })}: about ${suggested} parallel track(s) fit. ${WHY} Nothing was changed; ${ravenseat} limit maxConcurrent ${suggested} sets it.`;
}

/**
 * The suggestion for this project from one measured full check, or null when the measurement has no memory figure (then
 * the general estimate is what there is). One heavy check runs at a time (the gate queue), so its peak counts once.
 * @param {{ memGb: number, cores: number, freeBeforePct: number|null, minFreePct: number|null }} x
 * @returns {{ suggested: number, usedGb: number, freeBeforeGb: number } | null}
 */
function measuredAdvice({ memGb, cores, freeBeforePct, minFreePct }) {
  if (!Number.isFinite(freeBeforePct) || !Number.isFinite(minFreePct)) return null;
  const toGb = (pct) => Math.round((Number(memGb) * pct) / 10) / 10;
  const freeBeforeGb = toGb(freeBeforePct);
  const usedGb = toGb(Math.max(0, freeBeforePct - minFreePct));
  const byMemory = Math.floor((freeBeforeGb - MARGIN_GB - usedGb) / TRACK_GB);
  return { suggested: Math.max(1, Math.min(byMemory, coreCap(cores))), usedGb, freeBeforeGb };
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
