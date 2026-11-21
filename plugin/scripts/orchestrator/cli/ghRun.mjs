// =============================================================
// cli/ghRun.mjs: one way to run the GitHub CLI for `ravenseat issues` (cli/issues.mjs) and the doctor's gh row
// (lib/ghStatus.js), so both read gh's answer the same way and the tests replace it the same way.
//
//   ghRunner() -> run(args, { env? }) -> { missing, code, out, err, timedOut }
//     missing   gh could not be started at all (not installed or not on PATH)
//     timedOut  gh did not answer within the time limit (20 s)
// gh runs in the main checkout (GIT_ROOT) without a shell, its output is captured and never printed by this module.
//
// QUEUE_GH: a module whose default export (args, { env }) => { missing?, code, out, err, timedOut? } replaces gh (the
// tests; never set it otherwise). No test runs the real gh.
// =============================================================

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { GIT_ROOT } from './context.mjs';

const TIMEOUT_MS = 20_000;

/** The gh runner: the real CLI, or the test module from QUEUE_GH. */
export async function ghRunner() {
  if (process.env.QUEUE_GH) {
    const mod = await import(pathToFileURL(path.resolve(process.env.QUEUE_GH)).href);
    return (args, o = {}) => {
      const r = mod.default(args, { env: o.env ?? process.env }) ?? {};
      return { missing: !!r.missing, code: r.code ?? null, out: String(r.out ?? ''), err: String(r.err ?? ''), timedOut: !!r.timedOut };
    };
  }
  return (args, o = {}) => {
    const r = spawnSync('gh', args, {
      encoding: 'utf8',
      cwd: GIT_ROOT,
      env: o.env ?? process.env,
      timeout: o.timeoutMs ?? TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
    });
    return {
      missing: r.error?.code === 'ENOENT',
      code: r.status,
      out: String(r.stdout ?? ''),
      err: String(r.stderr ?? ''),
      timedOut: r.error?.code === 'ETIMEDOUT' || (r.status === null && r.signal != null),
    };
  };
}
