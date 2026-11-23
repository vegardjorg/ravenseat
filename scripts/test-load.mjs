// =============================================================
// test-load.mjs: load-adaptive test runs for test:changed (roadmap 0s V9, idea B in
// plans/coral-tester-ressurser-2026-11-17.md).
//
// Why: under high CPU load (parallel tracks, a red team run) vitest with half the cores and 60 s timeouts gives false
// reds: a test that passes alone times out, or a worker RPC times out. So test:changed measures the load once before it
// starts vitest, and on a busy machine gives vitest fewer workers and longer timeouts:
//   - busy: CPU at least BUSY_CPU_PCT (70 %) over a short sample, or free memory below LOW_FREE_PCT (20 %);
//   - then: a quarter of the cores (at least 1) as --maxWorkers, and 120 s as --testTimeout and --hookTimeout;
//   - calm, or a measurement that is unknown (null): nothing changes, the vitest config's values stand.
// One line says what changed and why; the run row gets load_cpu, load_free and load_workers.
//
// Off: testChanged.adaptLoad false in queue.config.json (default true), or RAVENSEAT_TEST_LOAD=off. The config is read
// from the repo root (as scripts/test-runs.mjs does), not through lib/queueConfig.js. QUEUE_LOAD="free=..,cpu=.."
// replaces the measurement (lib/loadSlots.js measure).
//
// Used by: scripts/test-changed.mjs (vitest). Tested in scripts/__tests__/testLoad.test.mjs.
// =============================================================
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);

/** CPU busy at or over this share (percent) counts as a busy machine. */
export const BUSY_CPU_PCT = 70;
/** Free memory under this share (percent) counts as a busy machine. */
export const LOW_FREE_PCT = 20;
/** Test and hook timeout on a busy machine (the vitest config has 60 s). */
export const BUSY_TIMEOUT_MS = 120_000;
/** How long the CPU sample takes. */
const SAMPLE_MS = 500;

/** Is the adaptation on? testChanged.adaptLoad (default true) and RAVENSEAT_TEST_LOAD=off. */
export function adaptOn(root, env = process.env) {
  if (String(env.RAVENSEAT_TEST_LOAD ?? '').toLowerCase() === 'off') return false;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, 'queue.config.json'), 'utf8'));
    return cfg?.testChanged?.adaptLoad !== false;
  } catch {
    // error-ignored: no config means the default (on)
    return true;
  }
}

/** A number, or null. */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * The plan for a measurement: null on a calm machine (or an unknown measurement), else { workers, timeoutMs, reason }.
 * Pure.
 */
export function loadPlan({ cpuPct, freeMemoryPct, cores }) {
  const cpu = num(cpuPct);
  const free = num(freeMemoryPct);
  const why = [];
  if (cpu !== null && cpu >= BUSY_CPU_PCT) why.push(`CPU ${Math.round(cpu)} % busy`);
  if (free !== null && free < LOW_FREE_PCT) why.push(`free memory ${Math.round(free)} %`);
  if (!why.length) return null;
  const n = num(cores) && cores > 0 ? cores : 1;
  return { workers: Math.max(1, Math.floor(n / 4)), timeoutMs: BUSY_TIMEOUT_MS, reason: why.join(', ') };
}

/** The vitest flags for a plan ([] for null). */
export function vitestLoadArgs(plan) {
  if (!plan) return [];
  return [`--maxWorkers=${plan.workers}`, `--testTimeout=${plan.timeoutMs}`, `--hookTimeout=${plan.timeoutMs}`];
}

/** The one line test:changed prints for a plan. */
export function loadLine(plan) {
  const w = plan.workers === 1 ? '1 vitest worker' : `${plan.workers} vitest workers`;
  return `test:changed: the machine is busy (${plan.reason}), so ${w} and ${Math.round(plan.timeoutMs / 1000)} s timeouts (off: testChanged.adaptLoad false or RAVENSEAT_TEST_LOAD=off).`;
}

/**
 * Measures once and gives { plan, load } (plan null when off, calm or unknown). Never throws: a failed measurement is a
 * calm machine.
 */
export function measurePlan(root, env = process.env) {
  if (!adaptOn(root, env)) return { plan: null, load: null };
  try {
    const { measure } = require('../plugin/scripts/orchestrator/lib/loadSlots.js');
    const load = measure({ cpu: true, sampleMs: SAMPLE_MS, env: env.QUEUE_LOAD });
    return { plan: loadPlan({ ...load, cores: os.cpus().length }), load };
  } catch {
    // error-ignored: no measurement means no change
    return { plan: null, load: null };
  }
}
