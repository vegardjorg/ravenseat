// =============================================================
// claudeEntries.test.ts: one Claude Code transcript row as the event the core reads (lib/clients/claude/entries.js,
// clientFor().entries; roadmap 0w W2b1).
//
// Locks: the event of each row type the queue reads (assistant, user, system), the content parts in order with the
// handback picked out, the usage in the core's names with the values as written, the compaction row, both forms of an
// API error (F1: the entry form and the 2.1.317+ system api_error row), and that a row the queue does not know (the
// 2.1.317 request rows, a REPL tool call, a block type it has never seen, a non-object line) gives a safe event and
// never throws. Every row is invented.
// =============================================================
import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const E = require('../clients/index.js').clientFor().entries;

describe('clientFor().entries', () => {
  it('an assistant row: kind, time, model, usage and the parts in order with the handback', () => {
    const e = E.entry({
      type: 'assistant',
      timestamp: '2026-11-16T10:00:00.000Z',
      message: {
        model: 'claude-opus-5-5',
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          cache_read_input_tokens: 3,
          cache_creation_input_tokens: 4,
          cache_creation: { ephemeral_5m_input_tokens: 1, ephemeral_1h_input_tokens: 3 },
        },
        content: [
          { type: 'thinking', thinking: 'x' },
          { type: 'text', text: 'hi' },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
          { type: 'tool_use', id: 't2', name: 'SubagentHandback', input: { message: 'report' } },
        ],
      },
    });
    expect(e.kind).toBe('assistant');
    expect(e.at).toBe(Date.parse('2026-11-16T10:00:00.000Z'));
    expect(e.model).toBe('claude-opus-5-5');
    expect(e.usage).toMatchObject({ input: 1, output: 2, cacheRead: 3, cacheWritten: 4, cache5m: 1, cache1h: 3 });
    expect(e.parts.map((p: { kind: string }) => p.kind)).toEqual(['other', 'text', 'tool', 'tool']);
    expect(e.tools.map((t: { name: string }) => t.name)).toEqual(['Bash', 'SubagentHandback']);
    expect(e.tools[0].handback).toBeNull();
    expect(e.handback).toBe('report');
    expect(e.compaction).toBe(false);
    expect(e.apiError).toBeNull();
  });

  it('a user row with tool results; a content string is no parts list', () => {
    const e = E.entry({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'x' }] } });
    expect(e.kind).toBe('user');
    expect(e.parts).toEqual([{ kind: 'result', id: 't1', isError: true, content: 'x' }]);
    expect(E.entry({ type: 'user', message: { content: 'a prompt' } }).parts).toBeNull();
  });

  it('the usage values are passed on as written; a falsy usage is null', () => {
    expect(E.usage({ input_tokens: null }).input).toBeNull();
    expect(E.usage({}).cacheRead).toBeUndefined();
    expect(E.usage(null)).toBeNull();
    expect(E.usage(0)).toBeNull();
  });

  it('the fields the cost reading needs (W2b2): message id, synthetic, thinking, text, meta, notification, version, cwd', () => {
    const e = E.entry({
      type: 'assistant',
      version: '2.1.317',
      cwd: '/w',
      message: { id: 'm1', model: 'claude-opus-5-5', usage: { output_tokens: 9, output_tokens_details: { thinking_tokens: 4 } }, content: [{ type: 'text', text: 'a' }, { type: 'tool_use', id: 't' }, { type: 'text', text: 'b' }] },
    });
    expect(e).toMatchObject({ hasMessage: true, messageId: 'm1', synthetic: false, thinking: 4, text: 'a  b', meta: false, notification: false, version: '2.1.317', cwd: '/w' });
    expect(E.entry({ type: 'assistant', message: { model: '<synthetic>' } }).synthetic).toBe(true);
    expect(E.entry({ type: 'system', subtype: 'api_error', version: '', cwd: 3 })).toMatchObject({ hasMessage: false, text: '', version: null, cwd: null, thinking: undefined });
    expect(E.entry({ type: 'user', isMeta: true, message: { content: 'x' } })).toMatchObject({ meta: true, text: 'x' });
    expect(E.entry({ type: 'user', origin: { kind: 'task-notification' }, message: { content: 'x' } }).notification).toBe(true);
    expect(E.entry({ type: 'user', turnOrigin: 'task_notification', message: {} }).notification).toBe(true);
    expect(E.entry({ type: 'user', message: { content: [{ type: 'text', text: '<task-notification> done' }] } }).notification).toBe(true);
    expect(E.entry({ type: 'user', message: { content: 'Background command "npm test" completed' } }).notification).toBe(true);
    expect(E.entry({ type: 'user', message: { content: 'a prompt' } }).notification).toBe(false);
    expect(E.resultText('abc')).toBe('abc');
    expect(E.resultText([{ type: 'text', text: 'ab' }, { type: 'image' }, 'c'])).toBe('abc');
    expect(E.resultText(undefined)).toBe('');
  });

  it('the compaction row', () => {
    const e = E.entry({ type: 'system', subtype: 'compact_boundary' });
    expect(e).toMatchObject({ kind: 'system', subtype: 'compact_boundary', compaction: true, apiError: null });
    expect(E.entry({ type: 'user', subtype: 'compact_boundary' }).compaction).toBe(false);
  });

  it('F1: an API error in both forms', () => {
    // The entry form (until 2.1.317).
    const old = (fields: Record<string, unknown>, text: string) =>
      E.entry({ type: 'assistant', ...fields, message: { model: '<synthetic>', content: [{ type: 'text', text }] } }).apiError;
    expect(old({ isApiErrorMessage: true, apiErrorStatus: 529, error: 'server_error' }, 'x')).toMatchObject({ kind: 'overloaded', form: 'entry', status: 529 });
    expect(old({ error: 'rate_limit' }, 'x')).toMatchObject({ kind: 'rate_limit', form: 'entry' });
    expect(old({ isApiErrorMessage: true }, 'API Error: rate limit reached')?.kind).toBe('rate_limit');
    expect(old({ isApiErrorMessage: true, apiErrorStatus: 500 }, 'x')?.kind).toBe('other');
    // The system form (2.1.317+): what error holds is not confirmed, so a code, a status and a nested type are read.
    const sys = (error: unknown) => E.entry({ type: 'system', subtype: 'api_error', error, retryInMs: 500, retryAttempt: 1, maxRetries: 10 }).apiError;
    expect(sys('rate_limit')).toMatchObject({ kind: 'rate_limit', form: 'system', code: 'rate_limit' });
    expect(sys({ status: 429 })).toMatchObject({ kind: 'rate_limit', status: 429 });
    expect(sys({ status: 529 })?.kind).toBe('overloaded');
    expect(sys({ error: { type: 'overloaded_error', message: 'Overloaded' } })?.kind).toBe('overloaded');
    expect(sys({ type: 'rate_limit_error' })?.kind).toBe('rate_limit');
    expect(sys(undefined)).toMatchObject({ kind: 'other', form: 'system', code: '' });
    // The usage limit code alone is a rate limit, as the entry form (with its 429) is (W2b2).
    expect(sys('usage_limit_reached')).toMatchObject({ kind: 'rate_limit', code: 'usage_limit_reached' });
    expect(sys({ error: { type: 'usage_limit_reached' } })?.kind).toBe('rate_limit');
    // A normal answer and another system row are no API error.
    expect(E.entry({ type: 'assistant', message: { model: 'claude-opus-5-5', content: [] } }).apiError).toBeNull();
    expect(E.entry({ type: 'system', subtype: 'informational' }).apiError).toBeNull();
  });

  it('rows and blocks it does not know give a safe event and never throw', () => {
    for (const type of ['api-request', 'api-request-blob', 'api-request-shape', 'file-history-snapshot']) {
      const e = E.entry({ type, timestamp: 'not a time' });
      expect(e).toMatchObject({ kind: 'unknown', type, at: null, parts: null, tools: [], handback: null, compaction: false, apiError: null });
    }
    for (const raw of [null, undefined, 42, 'text', [], true]) {
      const e = E.entry(raw);
      expect(e.kind).toBe('unknown');
      expect(e.parts).toBeNull();
      expect(e.apiError).toBeNull();
    }
    // A REPL call (Code Mode) is an ordinary tool part; a block type never seen is 'other'; a null block too.
    const e = E.entry({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', id: 'r', name: 'REPL', input: { code: '1+1' } }, { type: 'server_thing' }, null] },
    });
    expect(e.tools).toEqual([{ kind: 'tool', id: 'r', name: 'REPL', input: { code: '1+1' }, handback: null }]);
    expect(e.parts.slice(1)).toEqual([{ kind: 'other', type: 'server_thing' }, { kind: 'other', type: undefined }]);
  });

  it('parse gives undefined for a half line and the value for JSON', () => {
    expect(E.parse('{"type":"assis')).toBeUndefined();
    expect(E.parse('null')).toBeNull();
    expect(E.parse('{"a":1}')).toEqual({ a: 1 });
  });
});
