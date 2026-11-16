// =============================================================
// clients/claude/entries.js: one Claude Code transcript row (a JSONL line) as the event the core reads (roadmap 0w
// W2b1; the facts are transcript.entryTypes, transcript.usage, transcript.handback, transcript.compactBoundary and
// transcript.apiError in ./facts.js).
//
// entry(raw)  the event of a parsed row:
//   { kind, type, subtype, at, timestamp, model, usage, parts, tools, handback, compaction, apiError, raw }
//     kind        'assistant' | 'user' | 'system' for the row types the queue reads, 'unknown' for anything else (the
//                 2.1.317 request rows api-request, api-request-blob and api-request-shape, snapshots, a non-object
//                 line); type keeps the row's own type
//     at          Date.parse(timestamp), or null when that is not a number; timestamp is the value as written
//     model       message.model; usage = usage(message.usage)
//     parts       message.content in order, or null when it is not a list:
//                   { kind: 'text', text } | { kind: 'tool', id, name, input, handback } |
//                   { kind: 'result', id, isError, content } | { kind: 'other', type }
//                 a tool the queue does not know (a REPL call from Code Mode, say) is a plain 'tool' part
//     tools       the 'tool' parts; handback = the last SubagentHandback message in the row, or null
//     compaction  true for the compaction row (system, compact_boundary)
//     apiError    { kind: 'rate_limit'|'overloaded'|'other', form: 'entry'|'system', status, code } or null (below)
// usage(raw)  { input, output, cacheRead, cacheWritten, cache5m, cache1h, raw }, or null for a falsy value
// parse(line) JSON.parse, or undefined for a line that is not JSON (a half line at the cut, a line being written)
// MARK        the strings a reader may look for in a line before it parses it (a cheap pre-check, never a decision)
//
// THE API ERROR, in both forms (F1):
//   entry   the form read until 2.1.317: an entry with isApiErrorMessage, or model '<synthetic>' with error; apiErrorStatus
//           is the HTTP status, error the short code, and the content text says "API Error: 529 Overloaded ...".
//   system  2.1.317+: { type: 'system', subtype: 'api_error', error, retryInMs, retryAttempt, maxRetries }. What error
//           holds is not confirmed (only the field names were seen): a string is taken as the code, an object gives
//           status (error.status), the code (error.error.type, error.type or error.code) and text (error.message,
//           error.error.message). W3 fixtures confirm it.
//   Kind: 429 or rate limit is rate_limit, 529 or overloaded is overloaded, anything else other. The status, the code
//   AND the text are matched, since a version may lack some of them. The text is only matched, never kept.
//
// The values are passed on as Claude Code wrote them (no number checks), so each reader adds them up exactly as it did
// before the move; a reader that needs a check makes it. entry() never throws, whatever the row.
//
// Pure, no requires: the hooks that read a transcript tail load it (with the registry) and nothing else.
// Used through the adapter (lib/clients/claude/index.js entries; the core asks clientFor().entries). Tested in
// lib/__tests__/claudeEntries.test.ts and, for the readers, transcriptReadersCompat.test.ts.
// =============================================================
'use strict';

/** The model Claude Code writes on an API error entry (no model turn). */
const SYNTHETIC_MODEL = '<synthetic>';
/** The tool a subagent delivers its report with (input.message is the report). */
const HANDBACK_TOOL = 'SubagentHandback';
/** The row types the queue reads; anything else is 'unknown'. */
const KNOWN = new Set(['assistant', 'user', 'system']);

/**
 * Strings to look for in a raw line before parsing it. A pre-check only: the parsed event decides.
 *   compaction  the compaction subtype; quoted ("compact_boundary") it only matches the field, not escaped text
 *   usage       the usage field name, quoted
 *   assistant   the assistant type, quoted
 *   toolUse     the tool call block type
 */
const MARK = Object.freeze({
  compaction: 'compact_boundary',
  compactionQuoted: '"compact_boundary"',
  usage: '"usage"',
  assistant: '"assistant"',
  toolUse: 'tool_use',
});

/** A parsed line, or undefined when the line is not JSON. */
function parse(line) {
  try {
    return JSON.parse(line);
  } catch {
    return undefined; // a half line: the reader skips it
  }
}

/** The usage of one API call in the core's names, values as written; null for a falsy value. */
function usage(raw) {
  if (!raw) return null;
  return {
    input: raw.input_tokens,
    output: raw.output_tokens,
    cacheRead: raw.cache_read_input_tokens,
    cacheWritten: raw.cache_creation_input_tokens,
    cache5m: raw.cache_creation?.ephemeral_5m_input_tokens,
    cache1h: raw.cache_creation?.ephemeral_1h_input_tokens,
    raw,
  };
}

/** One content block as a part. */
function part(c) {
  const type = c?.type;
  if (type === 'text') return { kind: 'text', text: c.text };
  if (type === 'tool_use') {
    const handback = c.name === HANDBACK_TOOL && c.input?.message ? c.input.message : null;
    return { kind: 'tool', id: c.id, name: c.name, input: c.input, handback };
  }
  if (type === 'tool_result') return { kind: 'result', id: c.tool_use_id, isError: c.is_error, content: c.content };
  return { kind: 'other', type };
}

/** 429 / rate limit, 529 / overloaded, anything else. */
function errorKind(status, code, text) {
  if (status === 429 || code === 'rate_limit' || /\b429\b|rate[ _-]?limit/i.test(text)) return 'rate_limit';
  if (status === 529 || code === 'overloaded' || /\b529\b|overloaded/i.test(text)) return 'overloaded';
  return 'other';
}

/** The API error a row reports in either form, or null. */
function apiErrorOf(r) {
  if (r?.type === 'system' && r.subtype === 'api_error') {
    const e = r.error;
    const obj = e && typeof e === 'object' ? e : null;
    const status = Number(obj?.status ?? r.status);
    const rawCode = typeof e === 'string' ? e : (obj?.error?.type ?? obj?.type ?? obj?.code);
    const code = typeof rawCode === 'string' ? rawCode : '';
    const text = [code, obj?.message, obj?.error?.message].filter((x) => typeof x === 'string').join(' ');
    return { kind: errorKind(status, code, text), form: 'system', status, code };
  }
  // The entry form, matched on any row as before the move (the callers only ask for assistant rows).
  const m = r?.message;
  if (!r?.isApiErrorMessage && !(m?.model === SYNTHETIC_MODEL && r?.error)) return null;
  const content = Array.isArray(m?.content) ? m.content : [];
  const text = [typeof m?.content === 'string' ? m.content : '', ...content.map((c) => c?.text ?? '')].join(' ');
  const status = Number(r.apiErrorStatus);
  const code = String(r.error ?? '');
  return { kind: errorKind(status, code, text), form: 'entry', status, code };
}

/** The event of a parsed transcript row (see the header). Never throws. */
function entry(raw) {
  const r = raw && typeof raw === 'object' ? raw : null;
  const type = r?.type;
  const m = r?.message;
  const content = m?.content;
  const parts = Array.isArray(content) ? content.map(part) : null;
  const tools = parts ? parts.filter((p) => p.kind === 'tool') : [];
  let handback = null;
  for (const t of tools) if (t.handback) handback = t.handback;
  const at = r ? Date.parse(r.timestamp) : NaN;
  return {
    kind: typeof type === 'string' && KNOWN.has(type) ? type : 'unknown',
    type: type ?? null,
    subtype: r?.subtype ?? null,
    at: Number.isFinite(at) ? at : null,
    timestamp: r?.timestamp,
    model: m?.model,
    usage: usage(m?.usage),
    parts,
    tools,
    handback,
    compaction: type === 'system' && r.subtype === 'compact_boundary',
    apiError: r ? apiErrorOf(r) : null,
    raw,
  };
}

module.exports = { SYNTHETIC_MODEL, HANDBACK_TOOL, MARK, parse, usage, entry };
