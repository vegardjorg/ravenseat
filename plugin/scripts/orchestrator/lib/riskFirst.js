// =============================================================
// riskFirst.js: the riskiest assumption first (DR-2, plans/plan-gate-vurdering-2026-11-21.md).
//
// WHY: a track that builds for an hour on an assumption that turns out false wastes the hour and leaves a half-built
// branch. A task may name its riskiest assumption in the optional field `risk_first` (ravenseat add/edit --risk-first).
// The mission then tells the track to test that assumption FIRST, with the smallest probe that can prove it wrong,
// and to stop with PARTIAL and one owner question when it fails, instead of building around it.
//
// A task in an accepted sensitive zone (lib/catalogZones.js) without its own value gets ZONE_DEFAULT: prove the
// choice can be reversed before building on it. Without the field and without a zone nothing changes: the mission
// is byte-identical to before.
//
// Setting: mission.riskFirst (on by default). Friction: one short block in the mission and one probe before the
// build; it never stops a task by itself (the track stops only when its own probe fails). Off: no block at all.
//
// The field is locked after the start like the acceptance criteria (lib/doneCheck.js LOCKED_FIELDS): a track must
// not soften its own stop condition. Tested in lib/__tests__/riskFirst.test.ts.
// =============================================================
'use strict';

/** At most this many characters (one line; it is read as a single assumption). */
const TEXT_MAX = 300;
/** The heading of the block in the mission. */
const TITLE = 'Riskiest assumption (test it first)';
/** The default for a task in a sensitive zone without its own value. */
const ZONE_DEFAULT = 'prove the choice can be reversed before building on it';

/** The shape errors for `risk_first`: null or missing is fine, otherwise one non-empty line of at most TEXT_MAX. */
function riskFirstErrors(o) {
  const v = o?.risk_first;
  if (v == null) return [];
  if (typeof v !== 'string' || !v.trim()) return ['risk_first must be a non-empty text (null removes it)'];
  if (v.length > TEXT_MAX) return [`risk_first can be at most ${TEXT_MAX} characters`];
  if (/[\u0000-\u001f\u007f]/.test(v)) return ['risk_first must be one line without control characters'];
  return [];
}

/** Is the setting on (mission.riskFirst, default on)? */
function enabled(config) {
  return config?.mission?.riskFirst !== false;
}

/**
 * The mission block, or null (no value and no zone, or the setting off).
 * @param {object} o the task
 * @param {{ on?: boolean, zones?: { id: string, title?: string }[] }} [v] zones: the accepted zones the task meets
 * @returns {string|null}
 */
function riskFirstBlock(o, { on = true, zones = [] } = {}) {
  if (!on) return null;
  const own = typeof o?.risk_first === 'string' ? o.risk_first.trim() : '';
  const zs = Array.isArray(zones) ? zones : [];
  if (!own && !zs.length) return null;
  const text = own || ZONE_DEFAULT;
  const why = own
    ? ''
    : ` (the task is in the sensitive zone ${zs.map((z) => `${z.id}${z.title ? ` ${z.title}` : ''}`).join(', ')})`;
  return [
    `**${TITLE}:** ${text}${why}`,
    'Test it first, before you build on it: the smallest probe or test that could prove it wrong (about 20 minutes at',
    'most). If it holds, say',
    '`RISK held: <how you tested it, file:line or test>` in track-result.md and go on. If it fails, stop: do not build',
    'around it. Report PARTIAL with `RISK failed: <what you found>` and one owner question (the choice the owner must',
    'make), and leave the rest of the mission undone.',
  ].join('\n');
}

module.exports = { TEXT_MAX, TITLE, ZONE_DEFAULT, riskFirstErrors, enabled, riskFirstBlock };
