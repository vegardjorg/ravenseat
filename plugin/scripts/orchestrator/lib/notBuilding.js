// =============================================================
// notBuilding.js: "Not building", the register of what the project deliberately does not build (roadmap 0f).
//
// WHY: a rejection used to be scattered (a cancelled task's "declined: <reason>", a Checks card set aside without a
// word, a private list in a plan) and nothing kept the same idea from being proposed again. A rejection is now a
// D-entry in the project catalog (lib/catalog.js, docs/queue/catalog/decisions/) of kind not-building, with what (the
// title), why (the text), who and when (accepted_by, accepted), where the no came from (source), the words a new
// proposal is matched against (keywords) and when to look at it again (revisit). No file or folder of its own: the
// catalog's format, the owner lock and Z-C's supersede are reused, so reopening one is `catalog propose --supersedes`.
//
// What this file holds (pure; the CLI and the board read the catalog and pass it in):
//   draft          the fields of a proposed not-building entry from a declined proposal or a card set aside (the
//                  reason is the text, the title gives the keywords); `catalog propose` writes it, the owner accepts
//   entries        the not-building entries of a catalog with the status that counts and the reason in one line
//   matches/lines  a new proposal against the keywords of the entries the owner decided: one INFO line each. Never a
//                  stop, never more than MAX_LINES lines (notBuilding.match, on)
//   doctorRows     one INFO row for entries whose revisit date has passed (always) or that are old (only doctor --all)
//   boardEntries   the list for the board's "Not building" view in Decisions
//
// Friction: advice only. Nothing here stops work, writes a file or accepts an entry. notBuilding.match off turns the
// INFO lines and the doctor row off; the drafts follow catalog.captureAnswers (Z-A), the board view is display only.
//
// Used by: cli/notBuilding.mjs (add, receive, plan capture, cancel --keep, checks dismiss --keep, doctor),
// queue-board.mjs (the view). Tested in: lib/__tests__/notBuilding.test.ts, __tests__/notBuildingFlow.test.ts.
// =============================================================
'use strict';

const C = require('./catalog.js');

/** The defaults for config().notBuilding (lib/queueConfig.js STANDARD.notBuilding holds the same). */
const DEFAULTS = Object.freeze({ match: true });
/** At most this many INFO lines per command: the rest is one "and N more" line. */
const MAX_LINES = 3;
/** A draft takes at most this many keywords from the title; the owner sharpens them before the accept. */
const KEYWORDS_MAX = 6;
/** An entry decided longer ago than this is named by doctor --all: worth a look, never a gap. */
const OLD_DAYS = 180;
const WHY_MAX = 140;
const DAY = 86_400_000;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const cutTo = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 3).replace(/\s+\S*$/, '')}...`);

// ---- the setting ----------------------------------------------------------------------------------------------------

/** The shape errors in the project's own `notBuilding` object (doctor's config row). */
function setupProblems(own) {
  if (own === undefined) return [];
  if (!isObject(own)) return ['notBuilding must be an object'];
  const out = [];
  for (const [k, v] of Object.entries(own)) {
    if (!Object.hasOwn(DEFAULTS, k)) out.push(`notBuilding.${k} is not a notBuilding setting (${Object.keys(DEFAULTS).join(', ')})`);
    else if (typeof v !== 'boolean') out.push(`notBuilding.${k} must be true or false`);
  }
  return out;
}

/** The settings with the defaults filled in; a broken value reads as its default. */
function setupOf(config) {
  const own = isObject(config?.notBuilding) ? config.notBuilding : {};
  return Object.fromEntries(Object.entries(DEFAULTS).map(([k, d]) => [k, typeof own[k] === 'boolean' ? own[k] : d]));
}

// ---- drafts ---------------------------------------------------------------------------------------------------------

/** Words that say nothing about what is not built (English and Norwegian), left out of a draft's keywords. */
const STOP = new Set(
  (
    'the and for with from that this these those into onto when then than over under after before each every more less ' +
    'some also only about should would could have has had make makes made add adds added use uses using new own all ' +
    'not our your their them they what which there here been being just like very much many such other its it\'s ' +
    'build builds building task tasks card proposal proposed track where while still even once ' +
    'ikke eller også etter under over fra med som der når skal kan vil alle hver denne dette disse bare uten ' +
    'eget egen nytt nye ved til for den det'
  ).split(/\s+/),
);

/** Up to KEYWORDS_MAX words of a title: lower case, at least four characters, no stop words, in order, no repeats. */
function keywordsOf(title) {
  const out = [];
  for (const m of String(title ?? '').toLowerCase().matchAll(/[\p{L}\p{N}][\p{L}\p{N}._-]*[\p{L}\p{N}]|[\p{L}\p{N}]/gu)) {
    const w = m[0];
    if (w.length < 4 || STOP.has(w) || /^\d+$/.test(w) || out.includes(w) || w.length > C.KEYWORD_MAX) continue;
    out.push(w);
    if (out.length >= KEYWORDS_MAX) break;
  }
  return out;
}

/**
 * The fields of a proposed not-building entry (lib/catalog.js proposalFile with kind not-building). `why` is the owner's
 * reason (the decline's text), `source` where the no came from ("declined proposal A-7", "Checks card ci-cost").
 */
function draft({ title, why = null, source = null, keywords = null, revisit = null }) {
  const t = cutTo(oneLine(title) || 'Not building', 120);
  const reason = String(why ?? '').replace(/\r\n/g, '\n').trim();
  const text = [
    reason || 'No reason was given; write why before you accept it.',
    '',
    `A draft${source ? ` from ${oneLine(source)}` : ''}: check the keywords (a new proposal with one of them gets an INFO ` +
      'line, never a stop) and say when to revisit it, then accept it.',
  ].join('\n');
  return {
    kind: 'not-building',
    title: t,
    why: text,
    keywords: Array.isArray(keywords) && keywords.length ? keywords : keywordsOf(t),
    revisit: revisit ? cutTo(oneLine(revisit), 200) : null,
    source: source ? cutTo(oneLine(source), 200) : null,
    paths: [],
    invariant: null,
  };
}

// ---- the entries ----------------------------------------------------------------------------------------------------

/** The reason in one line: the first line of the text that is not a heading, without a leading "Why:". */
function whyOf(body) {
  for (const raw of String(body ?? '').split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || l.startsWith('#') || l.startsWith('<!--')) continue;
    return cutTo(oneLine(l.replace(/^why:\s*/i, '')), WHY_MAX);
  }
  return null;
}

/**
 * The not-building entries of a catalog (readCatalog's result), superseded ones left out, with the status that counts
 * (not-building only with the owner's record; proposed for a draft; unconfirmed when set by hand).
 */
function entries(cat, ledger = C.emptyLedger()) {
  const out = [];
  for (const x of cat?.decisions ?? []) {
    const d = x?.decision;
    if (!d?.id || !C.isNotBuilding(d) || d.status === 'superseded') continue;
    out.push({
      id: d.id,
      title: d.title ?? '',
      status: C.effectiveStatus(d, ledger),
      why: whyOf(d.body),
      decided: typeof d.accepted === 'string' ? d.accepted.slice(0, 10) : null,
      by: d.accepted_by ?? null,
      keywords: d.keywords ?? [],
      revisit: d.revisit ?? null,
      source: d.source ?? null,
      file: d.file ?? null,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The first keyword of `e` that is in `text` as a whole word or phrase (case does not matter), or null. */
function hitOf(e, text) {
  const t = String(text ?? '');
  for (const k of e.keywords ?? []) {
    const kw = oneLine(k);
    if (kw && new RegExp(`(?<![\\p{L}\\p{N}])${escape(kw)}(?![\\p{L}\\p{N}])`, 'iu').test(t)) return kw;
  }
  return null;
}

/** The entries the owner decided (status not-building) with a keyword in `text`, each with the keyword that hit. */
function matches(list, text) {
  return (list ?? []).filter((e) => e.status === 'not-building').flatMap((e) => {
    const hit = hitOf(e, text);
    return hit ? [{ ...e, hit }] : [];
  });
}

/** One INFO line: the proposal, the entry, the date and the reason. It says it stops nothing. */
function infoLine(e, { subject, cli = 'ravenseat' } = {}) {
  const when = e.decided ? ` ${e.decided}` : '';
  // "because the poll ...": the reason's first letter in lower case, unless it starts a name or an acronym (API, CI).
  const reason = e.why ? e.why.replace(/[.\s]+$/, '') : '';
  const lower = /^[A-Z][a-z]/.test(reason) ? `${reason[0].toLowerCase()}${reason.slice(1)}` : reason;
  const why = reason ? ` because ${lower}` : '';
  return (
    `INFO not-building: ${subject} looks like ${e.id} "${e.title}"${e.hit ? ` (keyword ${e.hit})` : ''}: chosen not to build${when}${why}. ` +
    `Advice only, nothing is stopped (${cli} catalog show ${e.id}).`
  );
}

/**
 * The INFO lines for new proposals ({ id, text }), at most MAX_LINES and one "and N more". [] with notBuilding.match
 * off, without a catalog or without an entry the owner decided.
 */
function lines(cat, ledger, items, { setup = DEFAULTS, cli = 'ravenseat', max = MAX_LINES } = {}) {
  if (!setup?.match || !cat?.exists) return [];
  const list = entries(cat, ledger);
  if (!list.some((e) => e.status === 'not-building')) return [];
  const out = [];
  for (const it of items ?? []) for (const e of matches(list, it?.text)) out.push(infoLine(e, { subject: it.id, cli }));
  if (out.length <= max) return out;
  return [...out.slice(0, max), `INFO not-building: and ${out.length - max} more (${cli} catalog show lists the entries).`];
}

// ---- doctor and the board -------------------------------------------------------------------------------------------

/** The first date (YYYY-MM-DD) in a revisit condition, as ms at the start of that day (UTC), or null. */
function revisitDate(revisit) {
  const m = /(?<!\d)(\d{4}-\d{2}-\d{2})(?!\d)/.exec(String(revisit ?? ''));
  const ms = m ? Date.parse(`${m[1]}T00:00:00Z`) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/** due: the revisit date has passed; old: decided over OLD_DAYS days ago; null: neither. */
function stateOf(e, now = Date.now()) {
  const at = revisitDate(e.revisit);
  if (at != null && at <= now) return 'due';
  const decided = e.decided ? Date.parse(`${e.decided}T00:00:00Z`) : NaN;
  if (Number.isFinite(decided) && now - decided > OLD_DAYS * DAY) return 'old';
  return null;
}

/**
 * Doctor's row: one INFO about the entries worth a look. A passed revisit date is a gap, so the row shows always; old
 * entries alone give a row marked onRequest (doctor --all), like 0x's opt-in rows. [] when there is nothing.
 */
function doctorRows(list, { now = Date.now(), cli = 'ravenseat' } = {}) {
  const decided = (list ?? []).filter((e) => e.status === 'not-building');
  const due = decided.filter((e) => stateOf(e, now) === 'due');
  const old = decided.filter((e) => stateOf(e, now) === 'old');
  if (!due.length && !old.length) return [];
  const parts = [];
  if (due.length) parts.push(`revisit date passed: ${due.slice(0, 5).map((e) => `${e.id} (${e.revisit})`).join(', ')}`);
  if (old.length) parts.push(`decided over ${OLD_DAYS} days ago: ${old.slice(0, 5).map((e) => `${e.id} (${e.decided})`).join(', ')}`);
  const first = (due[0] ?? old[0]).id;
  const row = {
    status: 'INFO',
    name: 'not-building',
    message: `"Not building" entries worth a look; ${parts.join('; ')}`,
    fix: `${cli} catalog show ${first}; to reopen it: ${cli} catalog propose --supersedes ${first} --title "..." --invariant "..."`,
  };
  return [due.length ? row : { ...row, onRequest: true }];
}

/** The board's list: drafts first (they wait on the owner), then the decided ones, newest first; each with its state. */
function boardEntries(cat, ledger, { now = Date.now() } = {}) {
  if (!cat?.exists) return [];
  const rank = (e) => (e.status === 'not-building' ? 1 : 0);
  return entries(cat, ledger)
    .map((e) => ({ ...e, state: e.status === 'not-building' ? stateOf(e, now) : null }))
    .sort((a, b) => rank(a) - rank(b) || String(b.decided ?? '').localeCompare(String(a.decided ?? '')) || a.id.localeCompare(b.id));
}

module.exports = {
  DEFAULTS,
  MAX_LINES,
  KEYWORDS_MAX,
  OLD_DAYS,
  setupProblems,
  setupOf,
  keywordsOf,
  draft,
  whyOf,
  entries,
  matches,
  infoLine,
  lines,
  revisitDate,
  stateOf,
  doctorRows,
  boardEntries,
};
