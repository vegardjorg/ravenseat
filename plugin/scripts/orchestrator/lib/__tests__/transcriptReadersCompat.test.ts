// =============================================================
// transcriptReadersCompat.test.ts: the transcript readers behave the same after 0w W2b1 moved their reading behind
// the adapter (lib/clients/claude/entries.js, clientFor().entries).
//
// Written and run green BEFORE the move (characterization), green after it. Covers the edges the module tests do not:
// rows of other types (system rows, row types the queue does not know, a non-object line), content that is not a list,
// a handback with an empty message, a tool the queue does not know (a REPL call), quoted field names in text, and the
// hook answers of contextGuard.hookOutput byte for byte (the snapshot file next to this one).
// The one intended change of W2b1, F1 (the 2.1.317+ form of an API error), is tested in claudeEntries.test.ts,
// transcriptMetrics.test.ts and queueUsageLimit.test.ts, not here.
// Every row is invented: no real transcript content, no personal paths.
// =============================================================
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AW = require('../approvalWait.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AB = require('../askBundle.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const KV = require('../contextGuard.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const R = require('../logic/results.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TG = require('../trackGuard.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const UL = require('../usageLimit.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const TT = require('../turnTools.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const HK = require('../clients/index.js').clientFor().hooks;

const J = (o: unknown) => JSON.stringify(o);
const lines = (...rows: unknown[]) => rows.map((r) => (typeof r === 'string' ? r : J(r))).join('\n');

const assistant = (content: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'assistant',
  timestamp: '2026-11-16T10:00:00.000Z',
  message: { id: 'm1', model: 'claude-opus-5-5', content },
  ...extra,
});
const user = (content: unknown) => ({ type: 'user', timestamp: '2026-11-16T10:00:01.000Z', message: { content } });
const toolUse = (id: string, name: string, input: unknown = {}) => ({ type: 'tool_use', id, name, input });
const toolResult = (id: string) => ({ type: 'tool_result', tool_use_id: id, content: 'x' });
// Row types the queue does not read (2.1.317 request rows, a snapshot row) and a compaction row.
const unknownRows = [
  { type: 'api-request', requestId: 'r1' },
  { type: 'api-request-blob', blob: 'b' },
  { type: 'api-request-shape', shape: {} },
  { type: 'file-history-snapshot', snapshot: {} },
];
const compaction = { type: 'system', subtype: 'compact_boundary', timestamp: '2026-11-16T10:05:00.000Z' };

describe('approvalWait: the open tool call at the end of a transcript', () => {
  it('pairs calls with results across entry types and skips rows it does not know', () => {
    const text = lines(
      'half a line {',
      ...unknownRows,
      assistant([toolUse('t1', 'Bash'), toolUse('t2', 'REPL', { code: '1' })]),
      user([toolResult('t1')]),
      { type: 'system', message: { content: 'not a list' } },
      42,
      'null',
    );
    expect(AW.pendingToolUse(text)).toEqual({ id: 't2', tool: 'REPL' });
    expect(AW.pendingToolUse(lines(assistant([toolUse('t1', 'Bash')]), user([toolResult('t1')])))).toBeNull();
    // A tool call without a name is '?', one without an id is not a call.
    expect(AW.pendingToolUse(lines(assistant([{ type: 'tool_use', id: 'x' }, { type: 'tool_use', name: 'Read' }])))).toEqual({
      id: 'x',
      tool: '?',
    });
    expect(AW.pendingToolUse('')).toBeNull();
  });

  it('the subagents folder of a session and the agents waiting in it', () => {
    expect(AW.subagentDir(null)).toBeNull();
    expect(AW.subagentDir(path.join('/t', 'sess.jsonl'))).toBe(path.join('/t', 'sess', 'subagents'));
    expect(AW.subagentDir(path.join('/t', 'sess.JSONL'))).toBe(path.join('/t', 'sess', 'subagents'));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w2b1-aw-'));
    try {
      fs.writeFileSync(path.join(dir, 'agent-a1.jsonl'), lines(assistant([toolUse('t1', 'Edit')])));
      fs.writeFileSync(path.join(dir, 'agent-a2.jsonl'), lines(assistant([toolUse('t1', 'Edit')]), user([toolResult('t1')])));
      fs.writeFileSync(path.join(dir, 'agent-a.b.jsonl'), lines(assistant([toolUse('t1', 'Edit')])));
      fs.writeFileSync(path.join(dir, 'other.jsonl'), lines(assistant([toolUse('t1', 'Edit')])));
      expect(AW.waitingAgents(dir)).toEqual([{ agent_id: 'a1', tool: 'Edit' }]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(AW.waitingAgents(path.join(os.tmpdir(), 'w2b1-no-such-folder'))).toEqual([]);
  });
});

describe('askBundle.transcriptTail', () => {
  it('text, tool lines and the handback in order; an empty handback is a tool line; other rows are left out', () => {
    const text = lines(
      'cut line',
      ...unknownRows,
      compaction,
      user([toolResult('t1')]),
      assistant([
        { type: 'thinking', thinking: 'x' },
        { type: 'text', text: '  hello  ' },
        { type: 'text', text: '   ' },
        toolUse('t1', 'Read', { file_path: 'a/b.txt' }),
        toolUse('t2', 'REPL', { code: 'x' }),
        { type: 'tool_use', id: 't3', name: 'SubagentHandback', input: { message: '' } },
        { type: 'tool_use', id: 't4', name: 'SubagentHandback', input: { message: ' report ' } },
      ]),
      assistant('not a list'),
      { type: 'assistant', message: { content: [{ type: 'text', text: 'no time' }] } },
    );
    expect(AB.transcriptTail(text)).toMatchSnapshot();
    // fromStart keeps the first line.
    expect(AB.transcriptTail(lines(assistant([{ type: 'text', text: 'first' }])), { fromStart: true })).toBe(
      'assistant (2026-11-16 10:00): first',
    );
  });
});

describe('results.lastAnswer', () => {
  it('the last text or handback; rows of other types and lists that are not lists are skipped', () => {
    expect(
      R.lastAnswer(
        lines(
          ...unknownRows,
          assistant([{ type: 'text', text: 'first' }]),
          assistant([toolUse('h', 'SubagentHandback', { message: 'the report' }), { type: 'text', text: '  ' }]),
          compaction,
          assistant('a string'),
        ),
      ),
    ).toBe('the report');
    expect(R.lastAnswer(lines(assistant([toolUse('h', 'SubagentHandback', { message: '' })])))).toBeNull();
    expect(R.lastAnswer(lines(user([{ type: 'text', text: 'not the agent' }])))).toBeNull();
    expect(R.lastAnswer('')).toBeNull();
  });
});

describe('contextGuard transcript readers', () => {
  it('countCompactions counts only real compaction rows, not quoted ones', () => {
    const quoted = user([{ type: 'text', text: 'the row {"type":"system","subtype":"compact_boundary"}' }]);
    expect(KV.countCompactions(lines(compaction, quoted, compaction, { type: 'system', subtype: 'other' }, 'compact_boundary {'))).toBe(2);
    expect(KV.countCompactions('')).toBe(0);
  });

  it('lastOrchestratorCall finds the last start or pulse call in a tool call, never in text', () => {
    const call = (cmd: string, ts: string) =>
      assistant([toolUse('c', 'Bash', { command: cmd })], { timestamp: ts });
    const text = lines(
      call('node queue.mjs start A-1', '2026-11-16T09:00:00.000Z'),
      assistant([{ type: 'text', text: 'node queue.mjs start A-2 tool_use' }], { timestamp: '2026-11-16T09:30:00.000Z' }),
      call('node queue.mjs status', '2026-11-16T09:40:00.000Z'),
      call('node queue.mjs orchestrator pulse', 'not a time'),
      ...unknownRows,
    );
    expect(KV.lastOrchestratorCall(text)).toBe(Date.parse('2026-11-16T09:00:00.000Z'));
    expect(KV.lastOrchestratorCall(lines(call('node queue.mjs fill', '2026-11-16T11:00:00.000Z')))).toBe(
      Date.parse('2026-11-16T11:00:00.000Z'),
    );
    expect(KV.lastOrchestratorCall('')).toBeNull();
  });

  it('hasEndLine reads text and the handback message and content of the last assistant rows', () => {
    expect(KV.hasEndLine({ lastMessage: 'RESULT status=DONE' })).toBe(true);
    expect(KV.hasEndLine({ text: lines(assistant([toolUse('h', 'SubagentHandback', { message: 'RESULT status=DONE x' })])) })).toBe(true);
    expect(KV.hasEndLine({ text: lines(assistant([toolUse('w', 'Write', { content: 'PARTIAL: x' })])) })).toBe(true);
    expect(KV.hasEndLine({ text: lines(assistant([{ type: 'text', text: 'REFUSED, no access' }]), ...unknownRows) })).toBe(true);
    // Only the last maxRows assistant rows count.
    const old = assistant([{ type: 'text', text: 'RESULT status=DONE' }]);
    const plain = assistant([{ type: 'text', text: 'working' }]);
    expect(KV.hasEndLine({ text: lines(old, plain, plain, plain) })).toBe(false);
    expect(KV.hasEndLine({ text: lines(old, plain, plain) })).toBe(true);
    expect(KV.hasEndLine({ text: lines(user([{ type: 'text', text: 'RESULT status=DONE "assistant"' }])) })).toBe(false);
    expect(KV.hasEndLine({})).toBe(false);
  });

  it('hookOutput answers byte for byte for every action', () => {
    const g = KV.limits();
    const out: Record<string, string> = {};
    for (const action of ['none', 'compact', 'stop', 'windDown', 'notice'])
      for (const orchestrator of [true, false])
        for (const mode of ['auto', 'manual'])
          for (const setWindDown of [true, false])
            // The handover note sits in the configured data folder, which can differ per machine.
            out[`${action}/${orchestrator}/${mode}/${setWindDown}`] = J(
              KV.hookOutput({ action, setWindDown, limit: 410_000 }, { n: 333_000, orchestrator, g, compactions: 2, mode }),
            ).replace(/[^\s"]*handover-ongoing\.md/g, '<note>');
    expect(out).toMatchSnapshot();
  });
});

describe('the hook answers the core builds, byte for byte (0w W3: systemMessage and block move to the adapter)', () => {
  // Written and run green BEFORE contextGuard and costGuard built these through clientFor().hooks (characterization).
  it('assessEndGate: the block answer', () => {
    const empty = { agentType: 'track', commits: 0, hasEndLine: false, alreadyBlocked: false };
    expect(J(KV.assessEndGate(empty))).toBe(
      '{"decision":"block","reason":"Finish: commit the work and write the RESULT line (or PARTIAL/REFUSE with the reason) before you stop."}',
    );
  });

  it('pauseAdvice: the owner message and the context text', () => {
    expect(J(KV.pauseAdvice({ prompt: 'pause', n: 151_000, orchestrator: true }))).toBe(
      `{"systemMessage":${J(KV.PAUSE_TIP)},"additionalContext":${J(KV.PAUSE_TIP)}}`,
    );
  });

  it('costGuard.hookText: the owner message first, then the context text', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const CG = require('../costGuard.js');
    const v = CG.assess({ measurements: [{ id: 'A', class: 'K', usd: 45 }], average: { K: { average: 10, n: 4 } } }).notices;
    const out = CG.hookText(v);
    expect(Object.keys(out)).toEqual(['systemMessage', 'additionalContext']);
    expect(J(out)).toMatchSnapshot();
  });
});

describe('trackGuard transcript readers', () => {
  const usageRow = (u: unknown, type = 'assistant') => ({ type, message: { usage: u } });
  it('lastContext: the last assistant usage, null after a compaction, other rows skipped', () => {
    const u = { input_tokens: 10, cache_read_input_tokens: 200, cache_creation_input_tokens: 3000, output_tokens: 9 };
    expect(TG.lastContext(lines(usageRow(u), usageRow({ input_tokens: 1 }, 'user'), ...unknownRows))).toBe(3210);
    expect(TG.lastContext(lines(usageRow(u), compaction))).toBeNull();
    expect(TG.lastContext(lines(compaction, usageRow({ input_tokens: 5 })))).toBe(5);
    expect(TG.lastContext(lines(usageRow(u), usageRow(null)))).toBe(3210);
    expect(TG.lastContext(lines(usageRow({ input_tokens: null, cache_read_input_tokens: 0 })))).toBe(0);
    // The field name quoted in text is escaped in the JSON line, so it is no boundary.
    expect(TG.lastContext(lines(usageRow(u), user([{ type: 'text', text: '"compact_boundary"' }])))).toBe(3210);
    expect(TG.lastContext('')).toBeNull();
  });

  it('subagentTranscript: agent_transcript_path, the subagent file itself, then the session folder', () => {
    const exists = (allowed: string[]) => (p: string) => allowed.includes(p);
    const tp = path.join('/p', 'sess.jsonl');
    const sub = path.join('/p', 'sess', 'subagents', 'agent-a1.jsonl');
    const own = path.join('/p', 'agent-a1.jsonl');
    // Before the move the guard took the raw payload (run green that way); now the payload as clientFor().hooks.read gives it.
    const read = HK.read;
    expect(TG.subagentTranscript(read({ agent_id: 'a1', transcript_path: tp }), exists([sub]))).toBe(sub);
    expect(TG.subagentTranscript(read({ agent_id: 'a1', transcript_path: own }), exists([own]))).toBe(own);
    // The session id wins over the file name when it is given.
    const other = path.join('/p', 'other', 'subagents', 'agent-a1.jsonl');
    expect(TG.subagentTranscript(read({ agent_id: 'a1', session_id: 'other', transcript_path: tp }), exists([other]))).toBe(other);
    expect(TG.subagentTranscript(read({ agent_id: 'a1', agent_transcript_path: '/x/y.jsonl', transcript_path: tp }), exists(['/x/y.jsonl', sub]))).toBe('/x/y.jsonl');
    expect(TG.subagentTranscript(read({ transcript_path: tp }), exists([tp, sub]))).toBeNull();
    expect(TG.subagentTranscript(read({ agent_id: 'a1' }), exists([]))).toBeNull();
    expect(TG.subagentTranscript(null)).toBeNull();
    const throwing = () => {
      throw new Error('x');
    };
    expect(TG.subagentTranscript(read({ agent_id: 'a1', transcript_path: tp }), throwing)).toBeNull();
  });
});

describe('usageLimit.fromTranscriptTail (the old form)', () => {
  it('the last assistant entry decides; rows of other types are skipped', () => {
    const limit = {
      type: 'assistant',
      isApiErrorMessage: true,
      quotaLimits: { status: 'rejected', resetsAt: 1_900_000_000, rateLimitType: 'five_hour' },
      message: { content: [] },
    };
    expect(UL.fromTranscriptTail(lines(limit, ...unknownRows, compaction, 'cut {'))).toEqual({
      resetsAt: 1_900_000_000,
      type: 'five_hour',
    });
    expect(UL.fromTranscriptTail(lines(limit, assistant([{ type: 'text', text: 'ok' }])))).toBeNull();
    expect(UL.fromTranscriptTail('')).toBeNull();
  });

  it('decide reads the StopFailure error from the hook payload', () => {
    const now = Date.parse('2026-11-16T12:00:00.000Z');
    const reset = Math.floor(now / 1000) + 3600;
    const observed = { five_hour: { used_percentage: 100, resets_at: reset } };
    expect(UL.decide(HK.read({ error: 'rate_limit' }), { tail: '', observed, now })).toMatchObject({ source: 'statusline' });
    expect(UL.decide(HK.read({ error: 'overloaded' }), { tail: '', observed, now })).toBeNull();
    expect(UL.decide(null, { tail: '', observed, now })).toBeNull();
  });
});

describe('turnTools: the context of a turn from its usage', () => {
  it('the context of each turn is input plus cache read plus cache written (missing fields are 0)', () => {
    const turn = (id: string, usage: unknown) => ({ ts: 0, model: 'claude-opus-5-5', usage, calls: [{ id, name: 'Read', input: {} }] });
    const detail = {
      turns: [
        turn('a', { input_tokens: 1, cache_read_input_tokens: 2, cache_creation_input_tokens: 3 }),
        turn('b', { input_tokens: 300_000 }),
        turn('c', null),
      ],
      resultChars: {},
    };
    // 6 tokens: below 6, above 5.
    expect(TT.transcriptStats(detail, { thresholdTokens: 5 }).above.turns).toBe(2);
    expect(TT.transcriptStats(detail, { thresholdTokens: 6 }).above.turns).toBe(1);
    expect(TT.transcriptStats(detail, { thresholdTokens: 5 })).toMatchSnapshot();
  });
});
