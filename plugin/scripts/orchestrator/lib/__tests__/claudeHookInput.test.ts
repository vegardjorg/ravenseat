// =============================================================
// claudeHookInput.test.ts: the Claude Code hook and status line payloads behind the adapter (roadmap 0w W2c,
// lib/clients/claude/hookInput.js), reached through the registry as the core reaches them (clientFor().hooks).
//
// The rules: every field is passed on as sent (a missing one stays undefined, no type checks), a missing payload gives
// null, and the answers are the hookSpecificOutput shapes the hooks wrote before the move, key order included.
// =============================================================
import { describe, it, expect } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports */
const H = require('../clients/index.js').clientFor().hooks;

describe('hooks.read: the hook payload', () => {
  it('maps the documented fields', () => {
    const raw = {
      hook_event_name: 'SubagentStop',
      session_id: 's',
      cwd: '/w',
      effort: { level: 'medium' },
      transcript_path: '/t/s.jsonl',
      agent_id: 'a',
      agent_type: 'ravenseat:track',
      agent_transcript_path: '/t/s/subagents/agent-a.jsonl',
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      tool_response: { stdout: 'x' },
      is_interrupt: false,
      last_assistant_message: 'Done.',
      stop_hook_active: true,
      notification_type: 'permission_prompt',
      source: 'compact',
      reason: 'clear',
      error: 'rate_limit',
      prompt: 'hello',
    };
    const h = H.read(raw);
    expect(h).toEqual({
      event: 'SubagentStop',
      session: 's',
      cwd: '/w',
      effort: { level: 'medium' },
      transcript: '/t/s.jsonl',
      agent: { id: 'a', type: 'ravenseat:track', transcript: '/t/s/subagents/agent-a.jsonl' },
      tool: { name: 'Bash', input: { command: 'ls' }, response: { stdout: 'x' }, interrupted: false },
      lastMessage: 'Done.',
      stopActive: true,
      notification: 'permission_prompt',
      source: 'compact',
      reason: 'clear',
      error: 'rate_limit',
      prompt: 'hello',
      raw,
    });
    expect(h.raw).toBe(raw);
    expect(h.tool.input).toBe(raw.tool_input);
  });

  it('passes values on as sent: missing stays undefined, odd types are not cleaned', () => {
    const h = H.read({ agent_id: 7, stop_hook_active: 'yes' });
    expect(h.event).toBeUndefined();
    expect(h.agent).toEqual({ id: 7, type: undefined, transcript: undefined });
    expect(h.stopActive).toBe('yes');
    expect(h.tool.input).toBeUndefined();
    expect(H.read({}).agent.id).toBeUndefined();
  });

  it('a missing payload gives null', () => {
    expect(H.read(null)).toBeNull();
    expect(H.read(undefined)).toBeNull();
  });
});

describe('hooks.status: the status line payload', () => {
  it('maps the documented fields', () => {
    const raw = {
      session_id: 's',
      cwd: '/w',
      workspace: { project_dir: '/p' },
      model: { id: 'm' },
      context_window: { total_input_tokens: 5 },
      cost: { total_cost_usd: 1 },
      rate_limits: { five_hour: { used_percentage: 3 } },
    };
    expect(H.status(raw)).toEqual({
      session: 's',
      cwd: '/w',
      workspace: { project_dir: '/p' },
      model: { id: 'm' },
      context: { total_input_tokens: 5 },
      cost: { total_cost_usd: 1 },
      limits: { five_hour: { used_percentage: 3 } },
      raw,
    });
    expect(H.status(null)).toBeNull();
    expect(H.status({}).limits).toBeUndefined();
  });
});

describe('the hook answers', () => {
  it('have the shapes, and the key order, the hooks wrote before', () => {
    expect(JSON.stringify(H.deny('PreToolUse', 'no'))).toBe(
      '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"no"}}',
    );
    expect(JSON.stringify(H.decision('PreToolUse', 'ask', 'sure?'))).toBe(
      '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"sure?"}}',
    );
    expect(JSON.stringify(H.context('PostToolUse', 'hint'))).toBe(
      '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"hint"}}',
    );
  });

  it('contextOf reads an answer back', () => {
    expect(H.contextOf(H.context('UserPromptSubmit', 'x'))).toBe('x');
    expect(H.contextOf({ systemMessage: 'y' })).toBeUndefined();
    expect(H.contextOf(null)).toBeUndefined();
  });
});
