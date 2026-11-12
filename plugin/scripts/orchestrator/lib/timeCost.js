// =============================================================
// timeCost.js: correct measurement of agent usage. See docs/orchestration.md.
//
// Pure logic, no I/O. Used by:
//   hook-time.mjs   analyzeTranscript(): the numbers in the "done" row per agent
//   log-time.mjs   --show (deduplicated) and --cost [--day]: usage per agent type and total
//   queue.mjs         dailyUsage() for the budget guard in `next`
// Tested in lib/__tests__/timeCost.test.ts.
//
// WHY DEDUPLICATION: hook-time writes a "done" row every time an agent stops, and the rows are CUMULATIVE (the whole
// transcript is analyzed again). An agent resumed with SendMessage therefore gets several rows, and a naive sum
// counts the same usage several times (well over double in practice).
// Here every row gives only the GROWTH since the previous row for the same agent, so the sum over all rows = last row
// per agent, and the usage is split correctly by day when an agent runs past midnight.
//
// UNIT: "API-equivalent USD" with the list prices per model family in PRICE_TABLE (Opus 5.5: input $4, output $20,
// cache read $0.20, cache write 5 min $5 and 1 h $8 per MTok). The subscription quota is not in dollars, but is weighted
// by the same pattern, so the shares and trends are what matter. A done row has `byModel` (tokens and cost per model);
// its cost is the sum over the models. Older rows without byModel are priced by their one `model`.
// =============================================================
'use strict';

/**
 * The list prices per model family, USD per million tokens (MTok). ONE place for prices; users override them with
 * `prices` in queue.config.json (see priceFor).
 * SOURCE: Anthropic's first-party Claude API list prices (the "Current Models" table and the prompt-caching economics in
 * the Claude API reference, cached 2026-10-06, read 2026-11-02). Cache writes cost 1.25x the input price (5 min TTL) and
 * 2x (1 h TTL); cache reads have their own price per model. Not modelled: the Haiku 5.5 long-prompt tier (above 100K
 * prompt tokens $0.50 / $2.50), fast mode, batch discounts, and older models not listed here (for example Opus 4.1 and
 * earlier at $15 / $75 fall under "opus"): set `prices` for those.
 * The first entry whose `match` hits the model id (lowercase, so "claude-opus-5-5[1m]" and "us.anthropic.claude-..."
 * hit too) applies, so the specific versions come before their family.
 */
const PRICE_TABLE = [
  { family: 'fable-5-1', match: /(?:fable|mythos)-5-1/, input: 10, output: 50, cache_read: 0.25 },
  { family: 'fable', match: /fable|mythos/, input: 10, output: 50, cache_read: 1 },
  { family: 'opus-5-5', match: /opus-5-5/, input: 4, output: 20, cache_read: 0.2 },
  { family: 'opus', match: /opus/, input: 5, output: 25, cache_read: 0.5 },
  { family: 'sonnet-5', match: /sonnet-5/, input: 2, output: 10, cache_read: 0.2 },
  { family: 'sonnet', match: /sonnet/, input: 3, output: 15, cache_read: 0.3 },
  { family: 'haiku-5', match: /haiku-5/, input: 0.1, output: 0.5, cache_read: 0.01 },
  { family: 'haiku', match: /haiku/, input: 1, output: 5, cache_read: 0.1 },
];
/** The cache write factors on the input price (the same for every model). */
const CACHE_WRITE_FACTOR = { '5m': 1.25, '1h': 2 };
/** A full price from a table entry or an override: the cache write prices follow the input price unless given. */
function fullPrice(p) {
  // A number, or null when the value is missing or not a number.
  const num = (x) => (x != null && Number.isFinite(Number(x)) ? Number(x) : null);
  const input = num(p.input) ?? 0;
  return {
    input,
    output: num(p.output) ?? 0,
    cache_read: num(p.cache_read) ?? 0,
    cache_5m: num(p.cache_5m) ?? input * CACHE_WRITE_FACTOR['5m'],
    cache_1h: num(p.cache_1h) ?? input * CACHE_WRITE_FACTOR['1h'],
  };
}
const DEFAULT_MODEL = 'claude-opus-5-5';
/** The price of DEFAULT_MODEL by name (kept for older readers: PRICES[DEFAULT_MODEL]). */
const PRICES = { [DEFAULT_MODEL]: fullPrice(PRICE_TABLE.find((p) => p.family === 'opus-5-5')) };

// The `prices` override from queue.config.json: { "<model id or part of it>": { input, output, cache_read, cache_5m?,
// cache_1h? } }. Read once, lazily, and fail open (no config = the table). setPriceOverrides replaces it (tests).
let priceOverrides;
function overrides() {
  if (priceOverrides === undefined) {
    try {
      const p = require('./queueConfig.js').config().prices;
      priceOverrides = p && typeof p === 'object' ? p : null;
    } catch {
      priceOverrides = null; // error-ignored: prices fall back to the table
    }
  }
  return priceOverrides;
}
/** Sets the price overrides (null = only the table; undefined = read queue.config.json again on next use). */
function setPriceOverrides(o) {
  priceOverrides = o === undefined ? undefined : o && typeof o === 'object' ? o : null;
}

/**
 * The price for a model id: an override (exact id first, then the longest key the id contains), else the first table
 * entry that matches, else DEFAULT_MODEL's price with `known: false` (the cost is then "assumed").
 * @returns {{ price: { input: number, output: number, cache_read: number, cache_5m: number, cache_1h: number },
 *   family: string, known: boolean }}
 */
function priceFor(model) {
  const id = String(model ?? '').toLowerCase();
  const o = overrides();
  if (o && id) {
    const keys = Object.keys(o).filter((k) => !k.startsWith('_') && o[k] && typeof o[k] === 'object');
    const exact = keys.find((k) => k.toLowerCase() === id);
    const part = exact ?? keys.filter((k) => id.includes(k.toLowerCase())).sort((a, b) => b.length - a.length)[0];
    if (part) return { price: fullPrice(o[part]), family: part, known: true };
  }
  const hit = id ? PRICE_TABLE.find((p) => p.match.test(id)) : null;
  if (hit) return { price: fullPrice(hit), family: hit.family, known: true };
  return { price: PRICES[DEFAULT_MODEL], family: 'opus-5-5', known: false };
}

/** The pseudo model Claude Code writes on its own API error entries (not a real model; never priced or counted). */
const SYNTHETIC_MODEL = '<synthetic>';

/** The time zone "day" is computed in: the machine's own (set the TZ environment variable to use another). */
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The cache lifetime per type (s). A pause longer than this before a turn = the cache expired and was written again. */
const CACHE_TTL_S = { '5m': 300, '1h': 3600 };

/**
 * Price for a set of tokens. Older rows have only `cache_written` (the sum): subagents have a 5 minute cache
 * (the investigation, section 2.1), so the sum is then priced as 5 min. Newer rows have `cache_written_5m` and `cache_written_1h`.
 * @returns {number} USD
 */
function costUsd(tokens, model) {
  if (!tokens) return 0;
  const p = priceFor(model).price;
  const n = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);
  let s5 = tokens.cache_written_5m;
  let s1 = tokens.cache_written_1h;
  if (s5 == null && s1 == null) {
    s5 = n(tokens.cache_written);
    s1 = 0;
  } else {
    s5 = n(s5);
    s1 = n(s1);
    // Writes not split by type (older API responses) count as 5 min.
    const undivided = n(tokens.cache_written) - s5 - s1;
    if (undivided > 0) s5 += undivided;
  }
  return (
    (n(tokens.input) * p.input +
      n(tokens.output) * p.output +
      n(tokens.cache_read) * p.cache_read +
      s5 * p.cache_5m +
      s1 * p.cache_1h) /
    1e6
  );
}

/**
 * The cost of a done row (or anything with tokens, model and byModel): the sum over `byModel` when the row has it (each
 * model at its own price), else the row's tokens at the price of its one `model` (older rows).
 * @returns {number} USD
 */
function costOf(r) {
  if (!r) return 0;
  const by = r.byModel && typeof r.byModel === 'object' ? Object.entries(r.byModel) : [];
  if (by.length) return by.reduce((s, [m, v]) => s + costUsd(v?.tokens, m), 0);
  return costUsd(r.tokens, r.model ?? undefined);
}

/** True when some model in the row has no price of its own (priced as DEFAULT_MODEL). */
function costAssumed(r) {
  const by = r?.byModel && typeof r.byModel === 'object' ? Object.keys(r.byModel) : [];
  if (by.length) return by.some((m) => !priceFor(m).known);
  return !!r?.model && !priceFor(r.model).known;
}

/**
 * Track id from the agent's mission (first user messages in the transcript): `prompt-<ID>.md` or "track <ID>"/"TRACK <ID>".
 * The ids in the queue can have hyphens and dots and start with a letter (A-1, alpha-2b); a regex that only takes
 * [A-Za-z0-9]+ or "TRACK <digits...>" would log such tracks with the agent id instead.
 * @returns {string|null}
 */
function trackFromText(text) {
  const t = String(text ?? '');
  const clean = (s) => s.replace(/[._-]+$/, '');
  const file = t.match(/prompt-([A-Za-z0-9][A-Za-z0-9._-]*?)\.md\b/);
  if (file) return clean(file[1]);
  // The reviewer's mission is "Read <scratchpad>\rev-<ID>\reviewer-<type>.md ..." (queue.mjs receive). Without this rule
  // the reviewers are logged with the agent id, and the review cost and the FINDINGS lines go missing.
  const rev = t.match(/(?:^|[\\/\s])rev-([A-Za-z0-9][A-Za-z0-9._-]*?)[\\/]+reviewer-/);
  if (rev) return clean(rev[1]);
  const word = t.match(/\b(?:TRACK|[Tt]rack)\s+([A-Z0-9][A-Za-z0-9._-]{1,40})/);
  if (word) return clean(word[1]);
  return null;
}

/**
 * The build agents (the agents that do the track itself): `track` for K and U, `track-d` for D and D+ (queueLogic.agentTypeFor).
 * A role map that only knows `track` loses the phase split for D and D+.
 */
const BUILD_AGENT_TYPES = ['track', 'track-d'];
const isBuildAgent = (type) => BUILD_AGENT_TYPES.includes(type);

/** The default idle threshold (minutes) for active time: a gap longer than this between two entries is not work. */
const IDLE_GAP_MIN = 5;

/** An empty token set (the fields of `tokens` in a done row). */
const emptyTokens = () => ({
  input: 0,
  output: 0,
  cache_read: 0,
  cache_written: 0,
  cache_written_5m: 0,
  cache_written_1h: 0,
});

/** Adds one turn's API usage to a token set (the same rules for the total and for each model). */
function addUsage(tokens, u) {
  const written = u.cache_creation_input_tokens ?? 0;
  const five = u.cache_creation?.ephemeral_5m_input_tokens;
  const hour = u.cache_creation?.ephemeral_1h_input_tokens;
  tokens.input += u.input_tokens ?? 0;
  tokens.output += u.output_tokens ?? 0;
  tokens.cache_read += u.cache_read_input_tokens ?? 0;
  tokens.cache_written += written;
  // Without a split (older API responses) the write counts as 5 min, as for subagents.
  tokens.cache_written_5m += five ?? (hour == null ? written : 0);
  tokens.cache_written_1h += hour ?? 0;
}

/**
 * The kind of an API error entry in a transcript, or null when the entry is not one. Claude Code writes a failed API
 * call as an assistant entry with `isApiErrorMessage: true`, `apiErrorStatus` (the HTTP status, e.g. 529), `error`
 * (a short code such as "rate_limit" or "server_error") and model "<synthetic>", with the text "API Error: 529
 * Overloaded ..." as content. Other versions may lack some of these fields, so the status, the code AND the text are
 * matched: 429 or rate limit -> rate_limit, 529 or overloaded -> overloaded, anything else -> other.
 * @returns {'rate_limit'|'overloaded'|'other'|null}
 */
function apiErrorKind(r) {
  const m = r?.message;
  if (!r?.isApiErrorMessage && !(m?.model === SYNTHETIC_MODEL && r?.error)) return null;
  const content = Array.isArray(m?.content) ? m.content : [];
  const text = [typeof m?.content === 'string' ? m.content : '', ...content.map((c) => c?.text ?? '')].join(' ');
  const status = Number(r.apiErrorStatus);
  const code = String(r.error ?? '');
  if (status === 429 || code === 'rate_limit' || /\b429\b|rate[ _-]?limit/i.test(text)) return 'rate_limit';
  if (status === 529 || code === 'overloaded' || /\b529\b|overloaded/i.test(text)) return 'overloaded';
  return 'other';
}

/**
 * Computes usage from an agent transcript (JSONL). Streamed messages can span several lines with the same
 * message.id; they are counted once (last usage wins, first timestamp gives the turn's time).
 * Everything comes from this one pass over the text (the hook must stay fast):
 *   byModel     { <model>: { turns, tokens, cost_usd } } per real model; cost_usd (the total) is their sum, each model
 *               at its own price. `model` is the most used one (kept for older readers).
 *   tools       { <tool name>: { calls, errors } }; errors = tool_result blocks with is_error for a call of that tool.
 *   api_errors  { rate_limit, overloaded, other } from the API error entries (apiErrorKind); they are not model turns.
 *   active_s    duration_s minus the gaps longer than `idleGapMin` minutes between two consecutive timestamped
 *               entries; idle_gaps = the number of such gaps.
 *   thinking_tokens  the sum of usage.output_tokens_details.thinking_tokens over the turns that report it, and
 *               thinking_turns how many did. null (not 0) when no turn reports it: older Claude Code versions and
 *               other clients do not, and an unknown must not pull a median toward zero (lib/costMeasures.js).
 *   cc_version  the Claude Code version on the last entry that carries `version` (the version the agent ended on).
 * @param {string} text
 * @param {{ idleGapMin?: number }} [option]
 */
function analyzeTranscript(text, { idleGapMin = IDLE_GAP_MIN } = {}) {
  const idleMs = (Number(idleGapMin) > 0 ? Number(idleGapMin) : IDLE_GAP_MIN) * 60_000;
  const turns = new Map(); // message.id -> { usage, ts, model }
  const tool = new Set();
  const toolName = new Map(); // tool_use id -> tool name
  const tools = {};
  const errorSeen = new Set();
  const apiErrors = { rate_limit: 0, overloaded: 0, other: 0 };
  let first = null;
  let last = null;
  let previousEntry = null;
  let idleMsSum = 0;
  let idleGaps = 0;
  let firstChange = null;
  let callForChange = 0;
  let trackFromMission = null;
  let ccVersion = null;
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const ts = r.timestamp ? Date.parse(r.timestamp) : NaN;
    if (!Number.isNaN(ts)) {
      if (first === null) first = ts;
      last = ts;
      // Active time: a long gap between two consecutive entries is idle (a stalled run, a wait, a sleep).
      if (previousEntry !== null && ts - previousEntry > idleMs) {
        idleMsSum += ts - previousEntry;
        idleGaps++;
      }
      previousEntry = ts;
    }
    // Claude Code writes its version on every entry; the last one is the version the agent ended on. Kept to tell a
    // change on the client or model side (a jump in thinking per turn on one version) from a change in the work.
    if (typeof r.version === 'string' && r.version) ccVersion = r.version;
    const m = r.message;
    if (!m) continue;
    const content = Array.isArray(m.content) ? m.content : [];
    if (r.type === 'user') {
      if (!trackFromMission) {
        const textChunks =
          typeof m.content === 'string' ? m.content : content.map((c) => c?.text ?? '').join(' ');
        trackFromMission = trackFromText(textChunks);
      }
      for (const c of content) {
        if (c?.type !== 'tool_result' || c.is_error !== true) continue;
        if (c.tool_use_id) {
          if (errorSeen.has(c.tool_use_id)) continue;
          errorSeen.add(c.tool_use_id);
        }
        const name = toolName.get(c.tool_use_id) ?? 'unknown';
        tools[name] ??= { calls: 0, errors: 0 };
        tools[name].errors++;
      }
      continue;
    }
    if (r.type !== 'assistant') continue;
    const kind = apiErrorKind(r);
    if (kind) {
      apiErrors[kind]++;
      continue;
    }
    if (m.id && m.usage && m.model !== SYNTHETIC_MODEL) {
      const earlier = turns.get(m.id);
      turns.set(m.id, {
        usage: m.usage,
        ts: earlier?.ts ?? (Number.isNaN(ts) ? null : ts),
        model: m.model ?? earlier?.model ?? null,
      });
    }
    for (const c of content) {
      if (c?.type !== 'tool_use' || !c.id || tool.has(c.id)) continue;
      tool.add(c.id);
      const name = String(c.name ?? 'unknown');
      toolName.set(c.id, name);
      tools[name] ??= { calls: 0, errors: 0 };
      tools[name].calls++;
      if (firstChange === null) {
        if (['Edit', 'Write', 'NotebookEdit'].includes(c.name)) firstChange = ts;
        else callForChange++;
      }
    }
  }
  const tokens = emptyTokens();
  const byModel = {};
  const context = [];
  const models = new Map();
  let cacheExpiry = 0;
  let previousTs = null;
  let thinking = 0;
  let thinkingTurns = 0;
  for (const { usage: u, ts, model } of turns.values()) {
    // Thinking is part of output_tokens; the detail is only there on newer responses (absent = unknown, not 0).
    const think = u.output_tokens_details?.thinking_tokens;
    if (think != null && Number.isFinite(Number(think))) {
      thinking += Number(think);
      thinkingTurns++;
    }
    const written = u.cache_creation_input_tokens ?? 0;
    const read = u.cache_read_input_tokens ?? 0;
    const hour = u.cache_creation?.ephemeral_1h_input_tokens;
    addUsage(tokens, u);
    // A turn without a model id is priced as DEFAULT_MODEL (as before) and kept under that name.
    const key = model ?? DEFAULT_MODEL;
    byModel[key] ??= { turns: 0, tokens: emptyTokens(), cost_usd: 0 };
    byModel[key].turns++;
    addUsage(byModel[key].tokens, u);
    context.push((u.input_tokens ?? 0) + read + written);
    if (model) models.set(model, (models.get(model) ?? 0) + 1);
    // Cache expiry: the turn came after a pause longer than the cache lifetime and wrote more than it read (the whole context
    // was written again). The investigation, section 2.1: about $2.25 per expiry for an agent at 450k, vs $0.09 for a normal turn.
    const ttl = (hour ?? 0) > 0 ? CACHE_TTL_S['1h'] : CACHE_TTL_S['5m'];
    if (ts !== null && previousTs !== null && ts - previousTs > ttl * 1000 && written > read)
      cacheExpiry++;
    if (ts !== null) previousTs = ts;
  }
  let costSum = 0;
  for (const [name, v] of Object.entries(byModel)) {
    const c = costUsd(v.tokens, name);
    costSum += c;
    v.cost_usd = Math.round(c * 10000) / 10000;
  }
  const sorted = [...context].sort((x, y) => x - y);
  const model = [...models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const duration = first !== null && last !== null ? Math.round((last - first) / 1000) : null;
  return {
    duration_s: duration,
    active_s: duration != null ? Math.max(0, Math.round((last - first - idleMsSum) / 1000)) : null,
    idle_gaps: idleGaps,
    toolCall: tool.size,
    modelTurns: turns.size,
    tokens,
    model,
    byModel,
    tools,
    api_errors: apiErrors,
    cache_expiry: cacheExpiry,
    thinking_tokens: thinkingTurns ? thinking : null,
    thinking_turns: thinkingTurns,
    cc_version: ccVersion,
    cost_usd: Math.round(costSum * 100) / 100,
    context: context.length
      ? {
          start: context[0],
          median: sorted[Math.floor(sorted.length / 2)],
          end: context[context.length - 1],
        }
      : null,
    first_change_s:
      firstChange !== null && first !== null
        ? Math.round((firstChange - first) / 1000)
        : null,
    call_for_first_change: firstChange !== null ? callForChange : null,
    track: trackFromMission,
  };
}

// One formatter per time zone, made on first use. Building an Intl.DateTimeFormat is slow (it loads the zone and locale
// data), and dayFor runs once per usage event: with a 150,000-row time log that was over half of `ravenseat cost`
// (review 2026-11-11). A formatter with an explicit timeZone gives the same result every time, so caching it changes no
// output. A zone Intl does not know throws (RangeError) as before and is not cached.
const DAY_FORMATS = new Map();
function dayFormat(tz) {
  let f = DAY_FORMATS.get(tz);
  if (!f) {
    // en-CA formats dates as YYYY-MM-DD.
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    DAY_FORMATS.set(tz, f);
  }
  return f;
}

/** The date (YYYY-MM-DD) an ISO timestamp has in the time zone `tz`. */
function dayFor(iso, tz = TZ) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return dayFormat(tz).format(d);
}

/** Reads JSONL text into rows; broken lines are skipped (the file is written by several processes). */
function readRows(text) {
  const out = [];
  for (const l of String(text ?? '').split('\n')) {
    if (!l.trim()) continue;
    try {
      out.push(JSON.parse(l));
    } catch {
      /* half line from a concurrent writer */
    }
  }
  return out;
}

// lib/projectRoot.js, loaded on first use (as the inline require did) and kept: bareAgentType runs once per usage event.
let projectRootLib;
const bareAgentType = (t) => (projectRootLib ??= require('./projectRoot.js')).bareAgentType(t);

/** The key a usage row is deduplicated on: agent_id, otherwise track + time (older manual rows). */
const agentKey = (r) => r.agent_id ?? `${r.track ?? '?'}|${r.time}`;

/**
 * The usage split into events: one per "done" row with tokens, with the GROWTH since the previous row for the same agent
 * (the rows are cumulative). The sum over all events = last row per agent.
 * `tokens` is the growth in raw tokens (input, output, cache_read, cache_written) the same way, for
 * the weekly quota model in lib/queueCapacity.js. `round` is the fix-round number when the label is `<id>-r<N>`
 * (roundOf), else null.
 * @returns {{ agent: string, type: string, track: string, round: number|null, time: string, day: string, usd: number, turns: number,
 *   cache_expiry: number, assumed: boolean, tokens: { input: number, output: number, cache_read: number,
 *   cache_written: number } }[]}
 */
function usageEvents(rows, tz = TZ) {
  const perAgent = new Map();
  for (const r of rows) {
    if (r?.event !== 'done' || !r.tokens) continue;
    const k = agentKey(r);
    if (!perAgent.has(k)) perAgent.set(k, []);
    perAgent.get(k).push(r);
  }
  const out = [];
  for (const [agent, list] of perAgent) {
    list.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
    let previous = { usd: 0, turns: 0, expiry: 0 };
    const previousTok = { input: 0, output: 0, cache_read: 0, cache_written: 0 };
    for (const r of list) {
      const growth = {};
      for (const k of Object.keys(previousTok)) {
        const v = Number(r.tokens?.[k] ?? 0) || 0;
        growth[k] = Math.max(0, v - previousTok[k]);
        previousTok[k] = Math.max(previousTok[k], v);
      }
      const now = {
        usd: costOf(r),
        turns: Number(r.modelTurns ?? 0),
        expiry: Number(r.cache_expiry ?? 0),
      };
      out.push({
        agent,
        type: bareAgentType(r.agent_type) ?? 'unknown',
        track: r.track ?? agent,
        round: roundOf(r.track),
        time: r.time,
        day: dayFor(r.time, tz),
        usd: Math.max(0, now.usd - previous.usd),
        turns: Math.max(0, now.turns - previous.turns),
        cache_expiry: Math.max(0, now.expiry - previous.expiry),
        assumed: costAssumed(r),
        tokens: growth,
      });
      // A row without full analysis (transcript too large) can be lower than the previous one: keep the highest.
      previous = {
        usd: Math.max(previous.usd, now.usd),
        turns: Math.max(previous.turns, now.turns),
        expiry: Math.max(previous.expiry, now.expiry),
      };
    }
  }
  return out;
}

/** Today's (or a given day's) usage in USD, all agent types. For the budget guard in queue.mjs. */
function dailyUsage(rows, day, tz = TZ) {
  return usageEvents(rows, tz)
    .filter((h) => h.day === day)
    .reduce((s, h) => s + h.usd, 0);
}

/**
 * Summary for `log-time.mjs --cost`: total, per agent type, per track and (with the queue) per risk class.
 * @param {object[]} rows
 * @param {{ day?: string|null, tz?: string, classFor?: (track: string) => string|null }} [option]
 */
function summarizeCost(rows, { day = null, tz = TZ, classFor = () => null } = {}) {
  const events = usageEvents(rows, tz).filter((h) => !day || h.day === day);
  const perType = new Map();
  const perTrack = new Map();
  const perClass = new Map();
  let total = 0;
  let assumed = false;
  for (const h of events) {
    total += h.usd;
    assumed ||= h.assumed;
    const t = perType.get(h.type) ?? { usd: 0, agents: new Set(), cache_expiry: 0 };
    t.usd += h.usd;
    t.agents.add(h.agent);
    t.cache_expiry += h.cache_expiry;
    perType.set(h.type, t);
    const s = perTrack.get(h.track) ?? { usd: 0, types: new Set(), cache_expiry: 0, turns: 0 };
    s.usd += h.usd;
    s.types.add(h.type);
    s.cache_expiry += h.cache_expiry;
    s.turns += h.turns;
    perTrack.set(h.track, s);
    const cls = classFor(h.track) ?? 'unknown';
    perClass.set(cls, (perClass.get(cls) ?? 0) + h.usd);
  }
  const r2 = (x) => Math.round(x * 100) / 100;
  return {
    day,
    total: r2(total),
    assumed,
    perType: [...perType.entries()]
      .map(([type, t]) => ({
        type,
        usd: r2(t.usd),
        agents: t.agents.size,
        cache_expiry: t.cache_expiry,
        share: total > 0 ? Math.round((t.usd / total) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.usd - a.usd),
    perTrack: [...perTrack.entries()]
      .map(([track, s]) => ({
        track,
        usd: r2(s.usd),
        types: [...s.types].sort(),
        cache_expiry: s.cache_expiry,
        turns: s.turns,
      }))
      .sort((a, b) => b.usd - a.usd),
    perClass: [...perClass.entries()]
      .map(([cls, usd]) => ({ class: cls, usd: r2(usd) }))
      .sort((a, b) => b.usd - a.usd),
  };
}

/**
 * The rows for `log-time.mjs --show`: all rows, but for every agent only the LAST "done" row (they are cumulative).
 * The order is kept.
 */
function deduplicateDone(rows) {
  const last = new Map();
  rows.forEach((r, i) => {
    if (r?.event === 'done' && r.agent_id) last.set(r.agent_id, i);
  });
  return rows.filter(
    (r, i) => !(r?.event === 'done' && r.agent_id && last.get(r.agent_id) !== i),
  );
}

/**
 * The queue's task id for a track label from the time log. Fix rounds are started as separate agents with labels such
 * as "A-1-r2" or "B-2-round2"; they belong to task A-1 / B-2.
 */
function taskIdFor(track, exists) {
  if (exists(track)) return track;
  const without = String(track).replace(ROUND_SUFFIX, '');
  return without !== track && exists(without) ? without : null;
}

/** The fix-round suffix on a track label: `-r<N>` (ravenseat resume, logic/attempt.js labelFor) or `-round<N>`. */
const ROUND_SUFFIX = /-(?:r|round)(\d+)$/i;
/**
 * The round number in a track label ("A-1-r2" -> 2), or null for a label without the suffix. The track itself is
 * always the bare id (round 0 in labelFor), so `-r1` is the first round `ravenseat resume` started, never the track.
 */
function roundOf(track) {
  const m = String(track ?? '').match(ROUND_SUFFIX);
  return m ? Number(m[1]) : null;
}

/**
 * The time the FIRST reviewer for task `id` started, from the time log rows (hook-time writes a
 * "start" row per agent). An agent belongs to the task when one of its rows has the track label `id` or a fix round of
 * it (taskIdFor); the start row can lack the label when the transcript was not written yet, so the agent's earliest
 * row applies. Only agents of `types` (the reviewer types) and only starts at or after `from` (t_receive) are counted.
 * @param {object[]} rows
 * @param {string} id
 * @param {{ types: string[], from?: string|null }} option
 * @returns {string|null} ISO-time
 */
function firstReviewStart(rows, id, { types, from = null }) {
  const isId = (s) => s === id;
  const belongsTo = new Set();
  const first = new Map();
  const type = new Map();
  for (const r of rows ?? []) {
    if (!r?.agent_id) continue;
    if (r.agent_type) type.set(r.agent_id, bareAgentType(r.agent_type));
    if (r.track && taskIdFor(r.track, isId) === id) belongsTo.add(r.agent_id);
    const t = Date.parse(r.time);
    if (Number.isNaN(t)) continue;
    const f = first.get(r.agent_id);
    if (f == null || t < f) first.set(r.agent_id, t);
  }
  const limit = from ? Date.parse(from) : NaN;
  let best = null;
  for (const agent of belongsTo) {
    if (!types.includes(type.get(agent))) continue;
    const t = first.get(agent);
    if (t == null || (!Number.isNaN(limit) && t < limit)) continue;
    if (best == null || t < best) best = t;
  }
  return best == null ? null : new Date(best).toISOString();
}

/**
 * Changed code lines (inserted + deleted) from `git diff --shortstat`, e.g.
 * " 3 files changed, 120 insertions(+), 4 deletions(-)" -> 124. Empty diff gives 0; unrecognizable text or null gives null.
 * @returns {number|null}
 */
function diffLinesFromShortstat(text) {
  if (text == null) return null;
  const t = String(text).trim();
  if (!t) return 0;
  if (!/\bfiles? changed\b/.test(t)) return null;
  const input = t.match(/(\d+) insertions?\(\+\)/);
  const out = t.match(/(\d+) deletions?\(-\)/);
  return (input ? Number(input[1]) : 0) + (out ? Number(out[1]) : 0);
}

module.exports = {
  PRICES,
  PRICE_TABLE,
  CACHE_WRITE_FACTOR,
  DEFAULT_MODEL,
  SYNTHETIC_MODEL,
  IDLE_GAP_MIN,
  TZ,
  priceFor,
  setPriceOverrides,
  costUsd,
  costOf,
  costAssumed,
  apiErrorKind,
  emptyTokens,
  trackFromText,
  analyzeTranscript,
  dayFor,
  readRows,
  usageEvents,
  dailyUsage,
  summarizeCost,
  deduplicateDone,
  taskIdFor,
  roundOf,
  BUILD_AGENT_TYPES,
  isBuildAgent,
  firstReviewStart,
  diffLinesFromShortstat,
};
