// =============================================================
// fields.js: one normalized vocabulary for queue files and time logs, whatever language they were written in.
//
// Why: the benchmark reads two kinds of projects. A ravenseat project writes English field names (queue.json, times.jsonl),
// while an older vendored install of the same queue model writes Norwegian ones (ko.json, .bolge-tider.jsonl). The
// two have the same shape, so a small key map plus a few value maps is enough: every collector calls `normalize`
// first and then only ever sees the English names. Unknown keys are kept as they are, so new fields are never lost.
//
// Pure, no I/O. Tested in bench/__tests__/fields.test.ts.
// =============================================================
'use strict';

/** Key renames (any depth). Only keys that differ are listed; English keys pass through untouched. */
const KEYS = {
  // queue file
  oppgaver: 'tasks',
  tittel: 'title',
  klasse: 'class',
  innhold_min: 'content_min',
  nytte: 'value',
  domene: 'domain',
  prosjekt: 'project',
  funksjon: 'feature',
  oppdrag: 'mission',
  eier_filer: 'owned_files',
  eier_db: 'owner_db',
  delt_patch: 'shared_patch',
  avhenger: 'depends_on',
  venter_paa: 'waiting_on',
  lagt_til: 'added',
  lagt_til_av: 'added_by',
  startet: 'started',
  levert: 'delivered',
  t_motta: 't_receive',
  t_flett: 't_merge',
  ferdig: 'done',
  kost: 'cost',
  turer: 'turns',
  agenter: 'agents',
  kilde: 'source',
  spor: 'track',
  deler: 'parts',
  bygg: 'build',
  retterunde: 'fix_round',
  retterunder: 'fix_rounds',
  maalt: 'measured',
  funn: 'findings',
  diff_linjer: 'diff_lines',
  gren: 'branch',
  etiketter: 'labels',
  merknader: 'notes',
  resultat: 'result',
  grenser: 'limits',
  // time log
  tid: 'time',
  bolge: 'wave',
  hendelse: 'event',
  varighet_s: 'duration_s',
  verktoykall: 'toolCall',
  modellturer: 'modelTurns',
  modell: 'model',
  kumulativ: 'cumulative',
  cache_utlop: 'cache_expiry',
  kost_usd: 'cost_usd',
  kontekst: 'context',
  slutt: 'end',
  cache_lest: 'cache_read',
  cache_skrevet: 'cache_written',
  cache_skrevet_5m: 'cache_written_5m',
  cache_skrevet_1t: 'cache_written_1h',
  forste_endring_s: 'first_change_s',
  kall_for_forste_endring: 'call_for_first_change',
  modus: 'mode',
  gronn: 'green',
  omkjoring_nr: 'rerun_nr',
  forste_gronn: 'first_green',
  delkjoringer: 'part_runs',
  last_1m: 'load_1m',
  samtidige_gater: 'concurrent_gates',
  ledig_minne_pct: 'free_memory_pct',
  okt_id: 'session_id',
  merknad: 'remark',
};

/** Value maps for the few enum fields whose values are words. */
const STATUS = {
  ferdig: 'done',
  venter: 'waiting',
  kansellert: 'cancelled',
  forslag: 'proposed',
  kjorer: 'running',
  review: 'review',
};
const EVENT = {
  ferdig: 'done',
  start: 'start',
  gater: 'gates',
  gate: 'gate',
  kompakt: 'compact',
  levert: 'delivered',
  flettet: 'merged',
};
const MODE = { rask: 'quick', full: 'full' };
const AGENT_TYPE = { spor: 'track', 'spor-d': 'track-d' };
const SOURCE = { transkript: 'transcript', tidslogg: 'timeLog' };

/** "ravenseat:track" -> "track" (plugin agents carry the plugin name as a prefix). */
function bareType(type) {
  if (typeof type !== 'string') return type ?? null;
  const t = type.includes(':') ? type.slice(type.lastIndexOf(':') + 1) : type;
  return AGENT_TYPE[t] ?? t;
}

/** Renames keys recursively and maps the enum values. Returns a new value; the input is never changed. */
function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const key = KEYS[k] ?? k;
    // An English key wins over a renamed Norwegian one if both are present (never overwrite real data).
    if (Object.hasOwn(out, key) && key !== k) continue;
    out[key] = normalize(v);
  }
  if (typeof out.status === 'string') out.status = STATUS[out.status] ?? out.status;
  if (typeof out.event === 'string') out.event = EVENT[out.event] ?? out.event;
  if (typeof out.mode === 'string') out.mode = MODE[out.mode] ?? out.mode;
  if (typeof out.agent_type === 'string') out.agent_type = bareType(out.agent_type);
  if (typeof out.type === 'string' && AGENT_TYPE[out.type]) out.type = AGENT_TYPE[out.type];
  if (typeof out.source === 'string' && SOURCE[out.source]) out.source = SOURCE[out.source];
  return out;
}

module.exports = { KEYS, STATUS, EVENT, MODE, AGENT_TYPE, bareType, normalize };
