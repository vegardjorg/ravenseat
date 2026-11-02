// =============================================================
// cli/conflicts.mjs: the predicted merge conflicts for the pulse and `cq conflicts [--json]`.
//
// The logic (which tips, merge-tree or the file-overlap fallback, the cache, the merge order, the lines) is in
// lib/conflictPredict.js; this module only reads the queue, the refs and the cache file and prints. Read-only for the
// repo: git merge-tree --write-tree writes objects, never the index, the checkout or a ref. The cache is
// <dataFolder>/conflict-predict.json (written without the queue lock: it is a cache, a lost write only costs time).
//
// Used by: cli/orchestrator.mjs (pulse), queue.mjs (dispatch).
// Tested in: lib/__tests__/conflictPredict.test.ts.
// =============================================================

import path from 'node:path';

import { a, BASE, CQ, FOLDER, GIT_ROOT, PREFIX, read, require, val } from './context.mjs';

const CP = require('./lib/conflictPredict.js');

export const CACHE_FILE = path.join(FOLDER, 'conflict-predict.json');

/**
 * The prediction now, or null when there is nothing to check (no base sha). Never throws (a status line must not stop
 * the pulse); an error is a WARNING line in `error`.
 */
export function predictionNow({ budgetMs, maxChecks } = {}) {
  try {
    const run = CP.makeRunner(GIT_ROOT);
    const refs = CP.readRefs(run);
    const baseSha = refs.get(BASE);
    if (!baseSha) return null;
    const tips = CP.tipsFor(read().tasks ?? [], refs, { prefix: PREFIX });
    const cache = CP.readCache(CACHE_FILE);
    const r = CP.predict({
      run,
      base: { name: BASE, sha: baseSha },
      tips,
      version: CP.gitVersion(run),
      cache,
      ...(budgetMs != null ? { budgetMs } : {}),
      ...(maxChecks != null ? { maxChecks } : {}),
    });
    if (!r.unchanged) CP.writeCache(CACHE_FILE, cache);
    return r;
  } catch (e) {
    return { error: `WARNING: conflict prediction failed (${e?.message ?? e}).` };
  }
}

/** The pulse lines (empty when nothing conflicts and nothing needs saying). */
export function conflictLinesNow() {
  const r = predictionNow();
  if (!r) return [];
  if (r.error) return [r.error];
  return CP.pulseLines(r, { cq: CQ });
}

/** `cq conflicts [--json] [--budget-ms <n>] [--max-checks <n>]` (the usage is at the top of queue.mjs). */
export function cmdConflicts() {
  const num = (name) => {
    const v = val(name);
    if (v == null) return undefined;
    const n = Number(v);
    if (!(Number.isInteger(n) && n > 0)) {
      console.error(`${name} must be a whole number > 0`);
      process.exit(1);
    }
    return n;
  };
  const r = predictionNow({ budgetMs: num('--budget-ms'), maxChecks: num('--max-checks') });
  if (a.includes('--json')) {
    console.log(JSON.stringify(r ?? { error: `no ${BASE} branch` }, null, 2));
    return;
  }
  if (!r) return console.log(`No ${BASE} branch to predict against.`);
  if (r.error) return console.log(r.error);
  const lines = CP.pulseLines(r, { cq: CQ });
  if (!r.pairs.length && !r.baseConflicts.length)
    lines.unshift(`No predicted conflicts: ${r.tips.length} track tip(s) checked against ${BASE} and each other.`);
  lines.push(
    `(${r.mode}${r.unchanged ? ', unchanged since the last run' : `, ${r.checks} check(s), ${r.cacheHits} from the cache`}, ${r.ms} ms)`,
  );
  console.log(lines.join('\n'));
}
