// =============================================================
// hookAnswerBytes.test.ts: the hooks' answers byte for byte, and the status line and tool trouble readings, as they
// were before the hook payload moved behind the client adapter (roadmap 0w W2c, lib/clients/claude/hookInput.js).
//
// Why: W2c moves the reading of the stdin fields and the building of hookSpecificOutput out of the hooks. The other
// tests parse the answer and check fields; these compare the exact text Claude Code reads (key order included), so the
// move is proved to change nothing. Each hook runs as a process with a temporary queue folder, never the real one.
// =============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ORCH = path.resolve(__dirname, '..');
/* eslint-disable @typescript-eslint/no-require-imports */

let folder: string;
beforeEach(() => {
  folder = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-bytes-'));
  fs.writeFileSync(path.join(folder, 'queue.json'), JSON.stringify({ tasks: [] }));
  fs.writeFileSync(path.join(folder, 'queue.config.json'), JSON.stringify({ baseBranch: 'trunk' }));
});
afterEach(() => fs.rmSync(folder, { recursive: true, force: true }));

/** Runs a hook with the payload on stdin and a temporary queue (a QUEUE_* variable marks it as a queue project). */
function run(file: string, input: unknown, extra: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [path.join(ORCH, file)], {
    input: typeof input === 'string' ? input : JSON.stringify(input),
    encoding: 'utf8',
    cwd: folder,
    env: {
      ...process.env,
      QUEUE_ROOT: folder,
      QUEUE_FOLDER: folder,
      QUEUE_GIT: folder,
      QUEUE_CONFIG: path.join(folder, 'queue.config.json'),
      QUEUE_TIME_LOG: path.join(folder, 'times.jsonl'),
      READ_HINT_STATE: path.join(folder, 'hint'),
      WRITE_WARN_STATE: path.join(folder, 'warn'),
      TRACK_CONTEXT_STATE: path.join(folder, 'cg'),
      TRACK_END_STATE: path.join(folder, 'end'),
      TRACK_CONTEXT_WARNING: '',
      TRACK_REPORT_WARNING: '',
      ...extra,
    },
  });
  return r.stdout;
}

/** The PreToolUse decision text as the hooks wrote it before the move. */
const decision = (decision: string, reason: string) =>
  JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } });
const context = (event: string, text: string) => JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });

describe('the hook answers, byte for byte', () => {
  it('hook-write-guard: a track writing the queue file is denied; the main session passes', () => {
    const payload = { agent_type: 'track', agent_id: 'w1', tool_name: 'Write', tool_input: { file_path: path.join(folder, 'queue.json'), content: '{}' }, cwd: folder };
    const out = run('hook-write-guard.mjs', payload);
    const reason = JSON.parse(out).hookSpecificOutput.permissionDecisionReason;
    expect(reason).toMatch(/queue\.json/);
    expect(out).toBe(decision('deny', reason));
    expect(run('hook-write-guard.mjs', { ...payload, agent_type: undefined, agent_id: undefined })).toBe('');
    // A relative path resolves against the payload's cwd.
    expect(run('hook-write-guard.mjs', { ...payload, tool_input: { file_path: 'queue.json', content: '{}' } })).toBe(out);
  });

  it('hook-read-guard: the read hint and the deny over the line limit', () => {
    const file = path.join(folder, 'large.ts');
    fs.writeFileSync(file, 'x\n'.repeat(400));
    const payload = { agent_type: 'ravenseat:track', agent_id: 'r1', tool_name: 'Read', tool_input: { file_path: file } };
    const hint = run('hook-read-guard.mjs', payload);
    expect(hint).toBe(context('PreToolUse', JSON.parse(hint).hookSpecificOutput.additionalContext));
    const huge = path.join(folder, 'huge.ts');
    fs.writeFileSync(huge, 'x\n'.repeat(2500));
    const deny = run('hook-read-guard.mjs', { ...payload, agent_id: 'r2', tool_input: { file_path: huge } });
    const reason = JSON.parse(deny).hookSpecificOutput.permissionDecisionReason;
    expect(deny).toBe(decision('deny', reason));
    // Relative to the payload's cwd, and nothing for the main session.
    expect(run('hook-read-guard.mjs', { ...payload, agent_id: 'r3', cwd: folder, tool_input: { file_path: 'huge.ts' } })).toBe(deny);
    expect(run('hook-read-guard.mjs', { tool_input: { file_path: file } })).toBe('');
  });

  it('hook-push-guard: a queue agent pushing is denied; a non-command passes', () => {
    const payload = { agent_type: 'track', agent_id: 'p1', tool_name: 'Bash', tool_input: { command: 'git push origin trunk' }, cwd: folder };
    const out = run('hook-push-guard.mjs', payload);
    const d = JSON.parse(out).hookSpecificOutput;
    expect(d.permissionDecision).toBe('deny');
    expect(out).toBe(decision('deny', d.permissionDecisionReason));
    expect(d.permissionDecisionReason).toMatch(/^push-guard: /);
    expect(run('hook-push-guard.mjs', { ...payload, tool_input: {} })).toBe('');
    expect(run('hook-push-guard.mjs', 'not json')).toBe('');
  });

  it('hook-track-context: the reminder after the first compaction', () => {
    const tp = path.join(folder, 'agent-c1.jsonl');
    const usage = (n: number) =>
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, cache_read_input_tokens: n - 1 } } });
    const boundary = JSON.stringify({ type: 'system', subtype: 'compact_boundary' });
    fs.writeFileSync(tp, [usage(260_000), boundary, usage(40_000)].join('\n') + '\n');
    const out = run('hook-track-context.mjs', { agent_type: 'track', agent_id: 'c1', agent_transcript_path: tp, tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'a' } });
    expect(out).toBe(context('PostToolUse', JSON.parse(out).hookSpecificOutput.additionalContext));
    expect(JSON.parse(out).hookSpecificOutput.additionalContext).toContain('compacted once');
  });

  it('hook-after-compact: SessionStart for the bound session, nothing for another source', () => {
    fs.writeFileSync(path.join(folder, 'orchestrator.json'), JSON.stringify({ session_id: 'orch' }));
    const out = run('hook-after-compact.mjs', { hook_event_name: 'SessionStart', source: 'compact', session_id: 'orch' });
    expect(out).toBe(context('SessionStart', JSON.parse(out).hookSpecificOutput.additionalContext));
    expect(run('hook-after-compact.mjs', { hook_event_name: 'SessionStart', source: 'startup', session_id: 'orch' })).toBe('');
  }, 30_000);

  it('hook-time: the start and done rows carry the agent, the bare type and the wave', () => {
    run('hook-time.mjs', { hook_event_name: 'SubagentStart', agent_id: 'abcdef1234567890', agent_type: 'ravenseat:track' });
    run('hook-time.mjs', { hook_event_name: 'SubagentStop', agent_id: 'abcdef1234567890', agent_type: 'ravenseat:track', agent_transcript_path: path.join(folder, 'none.jsonl') });
    run('hook-time.mjs', { hook_event_name: 'PreToolUse', agent_id: 'x' });
    const rows = fs.readFileSync(path.join(folder, 'times.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(rows.map(({ time: _t, ...r }) => r)).toEqual([
      { wave: 'unknown', track: 'abcdef123456', event: 'start', agent_id: 'abcdef1234567890', agent_type: 'track' },
      { wave: 'unknown', track: 'abcdef123456', event: 'done', agent_id: 'abcdef1234567890', agent_type: 'track' },
    ]);
  });
});

describe('the status line and tool trouble readings', () => {
  const payload = {
    session_id: 's1',
    cwd: '/x',
    model: { id: 'm1' },
    context_window: { total_input_tokens: 142_000, context_window_size: 200_000 },
    cost: { total_cost_usd: 3.214, total_duration_ms: 61_000, total_api_duration_ms: 30_400 },
    rate_limits: { five_hour: { used_percentage: 23.4, resets_at: 100 }, seven_day: { used_percentage: 41, resets_at: 200 } },
  };

  it('statusline makeLine', async () => {
    const S = await import('../statusline.mjs');
    expect(S.makeLine(payload, { running: 2, review: 1 })).toBe('ctx 142k 71% | $3.21 | 5h 23% 7d 41% | tracks 2 (+1 review)');
    expect(S.makeLine({}, null)).toBe('ctx - | $- | 5h - 7d -');
    expect(S.makeLine(null, null)).toBe('ctx - | $- | 5h - 7d -');
  });

  it('eventRows sessionReading and rateLimits fromStatusInput', () => {
    const ER = require('../lib/eventRows.js');
    const RL = require('../lib/rateLimits.js');
    expect(ER.sessionReading(payload, 0)).toEqual({
      session_id: 's1',
      usd: 3.21,
      duration_s: 61,
      api_duration_s: 30,
      context_tokens: 142_000,
      model: 'm1',
      five_hour_pct: 23.4,
      seven_day_pct: 41,
      time: '1970-01-01T00:00:00.000Z',
    });
    expect(ER.sessionReading({ ...payload, session_id: '' }, 0)).toBeNull();
    expect(ER.sessionReading(null, 0)).toBeNull();
    expect(RL.fromStatusInput(payload, 0)).toEqual({
      time: '1970-01-01T00:00:00.000Z',
      five_hour: { used_percentage: 23.4, resets_at: 100 },
      seven_day: { used_percentage: 41, resets_at: 200 },
    });
    expect(RL.fromStatusInput({}, 0)).toBeNull();
    expect(RL.fromStatusInput(null, 0)).toBeNull();
  });

  it('toolTrouble record', () => {
    const TT = require('../lib/toolTrouble.js');
    const now = Date.parse('2026-11-16T10:00:00Z');
    const at = '2026-11-16T10:00:00.000Z';
    expect(TT.record({}, { hook_event_name: 'PermissionDenied', agent_id: 'a1', tool_name: 'Bash' }, now)).toEqual({
      a1: { denied: [{ at, tool: 'Bash' }], failed: [] },
    });
    expect(TT.record({}, { hook_event_name: 'PostToolUseFailure', agent_id: 'a1' }, now)).toEqual({
      a1: { denied: [], failed: [{ at, tool: '?' }] },
    });
    expect(TT.record({}, { hook_event_name: 'PostToolUseFailure', agent_id: 'a1', tool_name: 'Bash', is_interrupt: true }, now)).toEqual({});
    expect(TT.record({}, { hook_event_name: 'PermissionDenied', tool_name: 'Bash' }, now)).toEqual({});
    expect(TT.record({}, { hook_event_name: 'PermissionDenied', agent_id: 'a b', tool_name: 'Bash' }, now)).toEqual({});
    expect(TT.record(undefined, null, now)).toEqual({});
  });
});
