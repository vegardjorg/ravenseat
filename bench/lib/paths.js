// =============================================================
// paths.js: where benchmark results go, and the guard that keeps them out of this repo.
//
// Why: this repo is public, and the results name real tasks, costs and timings from the project being measured.
// Results therefore go OUTSIDE the repo: BENCH_RESULTS, or --out, or ~/.cq-bench/results by default. A results
// folder inside this repo is refused, except bench/results/, which bench/.gitignore keeps out of git, as a last
// resort for someone who insists. The same guard applies to the load log the sampler writes.
//
// Tested in bench/__tests__/paths.test.ts.
// =============================================================
'use strict';

const os = require('node:os');
const path = require('node:path');

/** This repo's root (bench/lib -> two folders up). */
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ALLOWED_INSIDE = path.join(REPO_ROOT, 'bench', 'results');

// The path rules of the platform asked about, not the host's: on Linux, path.resolve('C:\\A') is not a Windows path.
const pathFor = (platform) => (platform === 'win32' ? path.win32 : path.posix);
const norm = (p, platform = process.platform) => {
  const r = pathFor(platform).resolve(p);
  return platform === 'win32' ? r.toLowerCase() : r;
};
/** Is `child` the folder `parent` or inside it? */
function isInside(child, parent, platform = process.platform) {
  const sep = pathFor(platform).sep;
  const c = norm(child, platform);
  const p = norm(parent, platform);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** The default results root: BENCH_RESULTS or ~/.cq-bench/results. */
function defaultResultsRoot(env = process.env) {
  return env.BENCH_RESULTS ? path.resolve(env.BENCH_RESULTS) : path.join(os.homedir(), '.cq-bench', 'results');
}

/**
 * Checks an output path. Throws when it is inside this repo (other than bench/results/).
 * @returns {string} the resolved path
 */
function safeOutput(p, { repoRoot = REPO_ROOT } = {}) {
  const r = path.resolve(p);
  const allowed = path.join(repoRoot, 'bench', 'results');
  if (isInside(r, repoRoot) && !isInside(r, allowed))
    throw new Error(
      `refusing to write benchmark data inside the repo (${r}): this repo is public. ` +
        'Use --out <folder outside the repo>, set BENCH_RESULTS, or use the default ~/.cq-bench/results.',
    );
  return r;
}

/** A run folder name: <experiment>-<UTC timestamp>, safe on every file system. */
function runFolderName(experiment, now = new Date()) {
  return `${experiment}-${now.toISOString().replace(/[:.]/g, '-')}`;
}

module.exports = { REPO_ROOT, ALLOWED_INSIDE, isInside, defaultResultsRoot, safeOutput, runFolderName };
