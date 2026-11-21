// =============================================================
// catalogZones.js: which sensitive zones a task meets (PG-5 step 0, plans/plan-gate-vurdering-2026-11-21.md section 6).
//
// WHY: some parts of a project are expensive to undo (sign-in, tenant isolation, the data model, a public contract). A
// zone is a catalog entry of kind `zone` (lib/catalog.js): paths and/or applies and/or keywords, and a one-line reason.
// It binds no code; it only raises attention. Ravenseat ships no zones: the set is empty until the owner accepts one, so
// a project without zones behaves exactly as before. The readers: the pre-start plan review (DR-1, lib/planReview.js)
// counts a zone hit as a risky task, and the riskiest assumption (DR-2) gets a default text for a zone task. The rest of
// PG-5 reads it too: one NOTE line per task at add (noteLine), and the card badge and the panel fact on the board
// (boardZone). The starter scan that proposes zones is lib/zoneScan.js. zone_skip and the owner's yes before building
// (zones.requireYes) are not built yet.
//
// The switch: zones.detect (zonesSetup, on by default). Off: zonesOnDisk gives no zones, so every reader above is as
// before. On costs nothing while no zone is accepted.
//
// The match (only zones the owner accepted, lib/catalog.js effectiveStatus):
//   files     the task's owned_files or shared_patch meet the zone's paths (the excerpt's matcher, except honoured)
//   category  the zone's applies matches the task (class, domain, project, feature, label; lib/catalog.js appliesMatch)
//   keyword   one of its keywords is a whole word (or phrase) of the task's title or mission, in any case
//
// zonesFor is pure; zonesOnDisk reads the catalog folder and the owner's record once and returns a zonesFor for a task.
// Tested in lib/__tests__/catalogZone.test.ts.
// =============================================================
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const C = require('./catalog.js');

const escape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Is `word` a whole word or phrase of `text` (letters and digits around it do not count as a boundary), any case? */
function hasWord(text, word) {
  const w = String(word ?? '').trim();
  if (!w) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escape(w)}($|[^\\p{L}\\p{N}_])`, 'iu').test(String(text ?? ''));
}

/** The files a task changes: owned_files and shared_patch (reads are not changed, so they do not put it in a zone). */
function changedScope(task) {
  const X = require('./catalogExcerpt.js');
  const out = [];
  for (const k of ['owned_files', 'shared_patch'])
    for (const p of Array.isArray(task?.[k]) ? task[k] : []) {
      const n = X.normPath(p);
      if (n && !out.includes(n)) out.push(n);
    }
  return out;
}

/**
 * The accepted zones a task meets, each with why: [{ id, title, reason, why: 'files'|'category'|'keyword', detail }],
 * by id. detail: the file, the category in words, or the keyword. Empty for no catalog, no zones or no hit.
 * @param {object} task the queue task
 * @param {object|null} cat readCatalog's result
 * @param {{ ledger?: object, glob?: Function, register?: object|null, missionText?: string|null }} [o] missionText: the
 *   mission's text when the task's mission is a file path (the caller read it); else task.mission is used
 */
function zonesFor(task, cat, { ledger = C.emptyLedger(), glob = require('./mergeGuard.js').globMatch, register = null, missionText = null } = {}) {
  if (!cat?.exists) return [];
  const X = require('./catalogExcerpt.js');
  const scope = changedScope(task);
  const words = `${task?.title ?? ''}\n${missionText ?? (typeof task?.mission === 'string' ? task.mission : '')}`;
  const out = [];
  const zones = (cat.decisions ?? [])
    .map((x) => x?.decision)
    .filter((d) => d?.id && d.kind === 'zone')
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const d of zones) {
    if (C.effectiveStatus(d, ledger) !== 'accepted') continue;
    const excepted = (e) => !e.endsWith('/') && (d.except ?? []).some((x) => glob(X.normPath(x), e));
    const file = scope.find((e) => !excepted(e) && (d.paths ?? []).some((p) => X.meets(p, e, glob)));
    const category = file ? null : C.appliesMatch(d.applies, task, { register });
    const keyword = file || category ? null : (d.keywords ?? []).find((k) => hasWord(words, k));
    if (!file && !category && !keyword) continue;
    out.push({
      id: d.id,
      title: d.title ?? '',
      reason: d.reason ?? '',
      why: file ? 'files' : category ? 'category' : 'keyword',
      detail: file ?? category ?? keyword,
    });
  }
  return out;
}

/** A zone hit in a few words for a line ("D-0001 Sign-in (files: src/auth/a.ts)"). */
function hitWords(h) {
  return `${h.id}${h.title ? ` ${h.title}` : ''} (${h.why}: ${h.detail})`;
}

/** zones.detect from the configuration: on unless it is false. */
function zonesSetup(cfg = {}) {
  const z = cfg?.zones != null && typeof cfg.zones === 'object' && !Array.isArray(cfg.zones) ? cfg.zones : {};
  return { detect: z.detect !== false };
}

/** A keyword alone gives the softer "may touch" (the spec: keywords alone are a hint, files and categories are a hit). */
const firm = (hits) => (hits ?? []).filter((h) => h.why !== 'keyword');

/**
 * The NOTE line at add for one task, or null without a hit. Advice only: the task is added either way.
 * "NOTE: T-1 is in sensitive zone D-0001 Sign-in (files: src/auth/a.ts): <reason>" or "... may touch ...".
 */
function noteLine(id, hits) {
  if (!hits?.length) return null;
  const word = firm(hits).length ? 'is in' : 'may touch';
  const one = hits.length === 1;
  // The reason usually ends with its own full stop; the line adds one, so drop the reason's.
  const what = hits
    .map((h) => `${hitWords(h)}${one && h.reason ? `: ${String(h.reason).replace(/[.\s]+$/, '')}` : ''}`)
    .join('; ');
  return (
    `NOTE: ${id} ${word} sensitive ${one ? 'zone' : 'zones'} ${what}. A change here is expensive to undo: ` +
    'the plan review and the riskiest assumption cover it before the start (zones.detect).'
  );
}

/**
 * The board's words for a task's zone hits, or null: { badge, title, fact, ids }. badge "Sensitive zone" for a file
 * or category hit, "May touch a zone" for keywords alone; title (the tooltip) and fact (the panel) name each zone, why
 * it matched and its reason.
 */
function boardZone(hits) {
  if (!hits?.length) return null;
  const sure = firm(hits).length > 0;
  const lines = hits.map((h) => `${hitWords(h)}${h.reason ? `: ${h.reason}` : ''}`);
  return {
    badge: sure ? 'Sensitive zone' : 'May touch a zone',
    title: `${sure ? 'In a sensitive zone' : 'May touch a sensitive zone (keyword only)'}: ${lines.join('; ')}`,
    fact: lines.join('\n'),
    ids: hits.map((h) => h.id),
  };
}

/**
 * The catalog of a tree read once, as a function task -> zonesFor(task). Without a catalog folder, or without any zone
 * in it, the function always gives [] and reads nothing more. Fail open: anything broken gives no zones.
 * @param {{ root?: string, dataFolder?: string, fsLike?: typeof fs }} [o] root: the tree whose docs/queue/catalog/ is
 *   read (default the project root); dataFolder: where catalog-accepted.json is (default the queue's data folder)
 * @returns {(task: object, o?: { missionText?: string|null, register?: object|null }) => object[]}
 */
function zonesOnDisk({ root, dataFolder, fsLike = fs, cfg = null } = {}) {
  // `empty` says the catalog has no zone at all, so a caller can skip reading the mission text.
  const none = Object.assign(() => [], { empty: true });
  try {
    const QC = require('./queueConfig.js');
    // zones.detect off: no zones for any reader (the plan gate, DR-1, DR-2, the NOTE line and the board).
    if (!zonesSetup(cfg ?? QC.config()).detect) return none;
    const tree = root ?? QC.config().root;
    const cat = C.readCatalog(path.join(tree, ...C.DIR.split('/')), fsLike);
    if (!cat.exists || !(cat.decisions ?? []).some((x) => x?.decision?.kind === 'zone')) return none;
    let ledger = C.emptyLedger();
    try {
      ledger = C.parseLedger(fsLike.readFileSync(path.join(dataFolder ?? QC.dataFolder(), C.LEDGER_FILE), 'utf8'));
    } catch {
      // error-ignored: no record means no zone is accepted, so none counts
    }
    return (task, o = {}) => {
      try {
        return zonesFor(task, cat, { ledger, missionText: o.missionText ?? null, register: o.register ?? null });
      } catch {
        // error-ignored: a zone only raises attention; no zones rather than a broken fill
        return [];
      }
    };
  } catch {
    // error-ignored: as above
    return none;
  }
}

module.exports = { hasWord, changedScope, zonesFor, hitWords, zonesSetup, noteLine, boardZone, zonesOnDisk };
