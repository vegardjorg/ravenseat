// =============================================================
// hotspots.js: shared config blocks that parallel tracks break each other on (routes, registries, i18n, feature flags).
//
// `hotspots` in queue.config.json lists them, with the protectedPaths rules ("folder/", "dir/file", a bare name in any
// folder, a glob; case ignored). Then:
//   - no task can own one: add and edit refuse a hotspot in owned_files (also through a folder above it);
//   - an agreed change goes in the task's `hotspot_patch`, and only one active task can hold the same hotspot there at a
//     time (a start conflict, lib/logic/conflicts.js): a serial lock;
//   - without an agreement the track writes a wiring spec in its report (what to add where), and the orchestrator makes
//     the change after the merge;
//   - the merge guard stops a hotspot change the task did not agree (merge-track.mjs, exit 4, --allow-guard overrides and
//     is logged), and the write guard warns a track at once (lib/writeWarn.js).
// An empty list (the default) turns it all off. Tested in lib/__tests__/hotspots.test.ts.
// =============================================================
'use strict';

const G = require('./mergeGuard.js');

const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '');

/** The hotspots from the config: the strings in config().hotspots, else []. */
function hotspotsOf(cfg) {
  return (Array.isArray(cfg?.hotspots) ? cfg.hotspots : []).filter((x) => typeof x === 'string' && x.trim()).map(norm);
}

/** Is the path a hotspot? */
function isHotspot(p, hotspots) {
  return (hotspots ?? []).length > 0 && G.inList(p, hotspots);
}

/** The literal start of a hotspot entry (before any * or ?), for "does this folder hold it". */
const literal = (h) => norm(h).toLowerCase().split(/[*?]/)[0];

/**
 * The errors for a task's owned_files and hotspot_patch (empty = fine), for add and edit.
 * @param {{ owned_files?: string[], hotspot_patch?: unknown }} o
 * @param {string[]} hotspots
 */
function ownershipErrors(o, hotspots) {
  const out = [];
  if (o?.hotspot_patch != null && !Array.isArray(o.hotspot_patch)) out.push('hotspot_patch must be a list of paths');
  if (!(hotspots ?? []).length) return out;
  for (const raw of Array.isArray(o?.owned_files) ? o.owned_files : []) {
    const e = norm(raw);
    if (!e) continue;
    if (isHotspot(e, hotspots)) {
      out.push(
        `owned_files ${e} is a hotspot (hotspots in queue.config.json): no task owns one. Put it in hotspot_patch for one ` +
          "agreed change, or leave it to the orchestrator from the track's wiring spec",
      );
      continue;
    }
    if (e.endsWith('/')) {
      const held = hotspots.find((h) => {
        const l = literal(h);
        return l.includes('/') && l.startsWith(e.toLowerCase());
      });
      if (held) out.push(`owned_files ${e} covers the hotspot ${norm(held)}: own the files around it instead, and put the hotspot in hotspot_patch`);
    }
  }
  for (const raw of Array.isArray(o?.hotspot_patch) ? o.hotspot_patch : []) {
    const e = norm(raw);
    if (e && !isHotspot(e, hotspots)) out.push(`hotspot_patch ${e} is not a hotspot: put an ordinary file in owned_files`);
  }
  return out;
}

/**
 * The changed paths that are hotspots and not in the task's hotspot_patch. A wave track (no task) has no agreement.
 * @returns {string[]}
 */
function unagreed(paths, task, hotspots) {
  if (!(hotspots ?? []).length) return [];
  const agreed = (task?.hotspot_patch ?? []).map(norm).filter(Boolean).map((x) => x.toLowerCase());
  const out = [];
  const seen = new Set();
  for (const raw of paths ?? []) {
    const p = norm(raw);
    if (!p || seen.has(p) || !isHotspot(p, hotspots)) continue;
    seen.add(p);
    const s = p.toLowerCase();
    if (agreed.some((e) => (e.endsWith('/') ? s.startsWith(e) : s === e))) continue;
    out.push(p);
  }
  return out;
}

module.exports = { hotspotsOf, isHotspot, ownershipErrors, unagreed };
