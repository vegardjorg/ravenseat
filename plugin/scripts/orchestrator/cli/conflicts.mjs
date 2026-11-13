// =============================================================
// cli/conflicts.mjs: the predicted merge conflicts for the pulse and `ravenseat conflicts [--json]`.
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

import { a, BASE, CLI, CONFIG, FOLDER, GIT_ROOT, PREFIX, read, require, val } from './context.mjs';

const CP = require('./lib/conflictPredict.js');

export const CACHE_FILE = path.join(FOLDER, 'conflict-predict.json');

/**
 * The prediction now, or null when there is nothing to check (no base sha). Never throws (a status line must not stop
 * the pulse); an error is a WARNING line in `error`. save: false leaves the cache alone (pulse-check is read-only).
 */
export function predictionNow({ budgetMs, maxChecks, save = true } = {}) {
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
    if (save && !r.unchanged) CP.writeCache(CACHE_FILE, cache);
    return r;
  } catch (e) {
    return { error: `WARNING: conflict prediction failed (${e?.message ?? e}).` };
  }
}

const OWNERSHIP_CACHE = path.join(FOLDER, 'ownership-files.json');

/**
 * The pulse lines for tracks that change files another active task owns (lib/mergeGuard.js). The changed files per tip
 * are cached by sha in <dataFolder>/ownership-files.json, so a round where no tip moved costs one for-each-ref.
 * Never throws.
 */
export function ownershipLinesNow() {
  try {
    const fs = require('node:fs');
    const G = require('./lib/mergeGuard.js');
    const run = CP.makeRunner(GIT_ROOT);
    const refs = CP.readRefs(run);
    if (!refs.get(BASE)) return [];
    const tasks = read().tasks ?? [];
    const tips = CP.tipsFor(tasks, refs, { prefix: PREFIX });
    if (tips.length < 1) return [];
    let cache = {};
    try {
      cache = JSON.parse(fs.readFileSync(OWNERSHIP_CACHE, 'utf8')) ?? {};
    } catch {
      cache = {};
    }
    const next = {};
    const filesOf = (tip) => {
      const key = `${refs.get(BASE)}..${tip.sha}`;
      if (Array.isArray(next[key])) return next[key];
      if (Array.isArray(cache[key])) return (next[key] = cache[key]);
      const r = run(['diff', '--name-only', '--no-renames', `${BASE}...${tip.sha}`]);
      if (r.code !== 0) return null;
      return (next[key] = String(r.stdout ?? '').split(/\r?\n/).filter(Boolean));
    };
    const lines = G.ownershipPulseLines(tips, tasks, filesOf);
    // Shared config (hotspots, lib/hotspots.js) a track changes without hotspot_patch: the merge stops on it too.
    const H = require('./lib/hotspots.js');
    const hot = H.hotspotsOf(CONFIG);
    if (hot.length) {
      const byId = new Map(tasks.map((o) => [o.id, o]));
      for (const tip of tips) {
        const files = filesOf(tip);
        const bad = files ? H.unagreed(files, byId.get(tip.id) ?? null, hot) : [];
        if (bad.length)
          lines.push(
            `HOTSPOT: ${tip.id} changes shared config it has not agreed: ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? ', …' : ''}. ` +
              'The merge stops on it; tell the track to leave it and write a wiring spec, or agree it in hotspot_patch.',
          );
      }
    }
    try {
      fs.writeFileSync(OWNERSHIP_CACHE, JSON.stringify(next));
    } catch {
      /* a cache: a lost write only costs time */
    }
    return lines;
  } catch (e) {
    return [`WARNING: ownership check failed (${e?.message ?? e}).`];
  }
}

/** The pulse lines (empty when nothing conflicts and nothing needs saying). */
export function conflictLinesNow() {
  const r = predictionNow();
  if (!r) return [];
  if (r.error) return [r.error];
  return CP.pulseLines(r, { ravenseat: CLI });
}

/**
 * For pulse-check (cli/pulseCheck.mjs): one line when a conflict is predicted that the pulse has not reported yet
 * (the tips or the base moved since its last run), else none. The cache is not written: the pulse writes it when it
 * reports, so the next tick is silent while nothing moves.
 */
export function conflictPulseItems() {
  const r = predictionNow({ save: false });
  if (!r || r.error || r.unchanged || !(r.pairs.length + r.baseConflicts.length)) return [];
  const found = CP.pulseLines(r, { ravenseat: CLI }).filter((l) => /^(PREDICTED CONFLICT|CONFLICTS WITH BASE)/.test(l));
  return [`CONFLICTS: ${found.join('; ')}. Next: ${CLI} orchestrator pulse`];
}

/** `ravenseat conflicts [--json] [--budget-ms <n>] [--max-checks <n>]` (the usage is at the top of queue.mjs). */
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
  const lines = CP.pulseLines(r, { ravenseat: CLI });
  if (!r.pairs.length && !r.baseConflicts.length)
    lines.unshift(`No predicted conflicts: ${r.tips.length} track tip(s) checked against ${BASE} and each other.`);
  lines.push(
    `(${r.mode}${r.unchanged ? ', unchanged since the last run' : `, ${r.checks} check(s), ${r.cacheHits} from the cache`}, ${r.ms} ms)`,
  );
  console.log(lines.join('\n'));
}
