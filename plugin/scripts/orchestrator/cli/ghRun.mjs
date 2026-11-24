// =============================================================
// cli/ghRun.mjs: one way to run the GitHub CLI for `ravenseat issues` (cli/issues.mjs), the doctor's gh row
// (lib/ghStatus.js), the CI watch (cli/ciWatch.mjs) and the external CI check in gates.mjs, so all read gh's answer the
// same way, with the same time limit, and the tests replace it the same way.
//
//   ghSpawn(args, { cwd, env?, timeoutMs?, bin? }) -> { missing, code, out, err, timedOut }   the real gh, synchronous
//   ghRunner() -> run(args, { env?, timeoutMs? }) -> the same, in the main checkout (GIT_ROOT), or the QUEUE_GH module
//     missing   gh could not be started at all (not installed or not on PATH)
//     timedOut  gh did not answer within the time limit (20 s): it is ended, never left to hang a merge or a watch
// gh runs without a shell, its output is captured and never printed by this module.
//
// This module has no static import of cli/context.mjs (which reads the config and the arguments when it loads), so
// gates.mjs can use ghSpawn; ghRunner loads it only for GIT_ROOT.
//
// QUEUE_GH: a module whose default export (args, { env }) => { missing?, code, out, err, timedOut? } replaces gh (the
// tests; never set it otherwise). No test runs the real gh.
// =============================================================

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const TIMEOUT_MS = 20_000;

/**
 * Runs gh (or `bin`, for the tests) in `cwd`, at most `timeoutMs` (default 20 s). Never throws.
 */
export function ghSpawn(args, { cwd, env = process.env, timeoutMs = TIMEOUT_MS, bin = 'gh', maxBuffer = 64 * 1024 * 1024 } = {}) {
  const r = spawnSync(bin, args, { encoding: 'utf8', cwd, env, timeout: timeoutMs, windowsHide: true, maxBuffer });
  return {
    missing: r.error?.code === 'ENOENT',
    code: r.status,
    out: String(r.stdout ?? ''),
    err: String(r.stderr ?? ''),
    timedOut: r.error?.code === 'ETIMEDOUT' || (r.status === null && r.signal != null),
  };
}

/** The gh runner: the real CLI, or the test module from QUEUE_GH. */
export async function ghRunner() {
  if (process.env.QUEUE_GH) {
    const mod = await import(pathToFileURL(path.resolve(process.env.QUEUE_GH)).href);
    return (args, o = {}) => {
      const r = mod.default(args, { env: o.env ?? process.env }) ?? {};
      return { missing: !!r.missing, code: r.code ?? null, out: String(r.out ?? ''), err: String(r.err ?? ''), timedOut: !!r.timedOut };
    };
  }
  const { GIT_ROOT } = await import('./context.mjs');
  return (args, o = {}) => ghSpawn(args, { cwd: GIT_ROOT, env: o.env ?? process.env, timeoutMs: o.timeoutMs ?? TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 });
}
