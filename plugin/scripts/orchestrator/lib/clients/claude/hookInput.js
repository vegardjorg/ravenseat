// =============================================================
// clients/claude/hookInput.js: what Claude Code sends a hook and the status line on stdin, and what a hook answers
// (roadmap 0w W2c; the facts are hook.commonInput, hook.toolInput, hook.subagentStop, hook.otherInput, hook.output
// and statusline.input in ./facts.js).
//
// read(raw)    the hook payload as the core reads it:
//   { event, session, cwd, effort, transcript, agent: { id, type, transcript }, tool: { name, input, response, interrupted },
//     lastMessage, stopActive, notification, source, reason, error, prompt, raw }
// status(raw)  the status line payload: { session, cwd, workspace, model, context, cost, limits, raw }
// decision(event, decision, reason), deny(event, reason), context(event, text), contextOf(answer)
//              the hookSpecificOutput answers (PreToolUse allow/deny/ask with a reason, additionalContext).
// message(text), block(reason)
//              the top-level answers (systemMessage to the owner; decision 'block' with its reason). Since 0w W3 the core
//              builds them only here (lib/contextGuard.js, lib/costGuard.js, hook-context.mjs); the coupling gate
//              catches a new direct build.
//
// The values are passed on exactly as Claude Code sent them: no trimming, no type checks, a missing field stays
// undefined, so the hooks decide as they did before the move (a type check stays with the hook that needs it). A raw
// value of null or undefined gives null, so a hook that read a field of it still fails the way it did. raw is the
// original payload; since W2b1 no core reader takes it whole (trackGuard.subagentTranscript and usageLimit.decide read
// the fields named here).
//
// Pure, no requires: the hooks that run on every tool call load it (with the registry) and nothing else.
// Used through the adapter (lib/clients/claude/index.js hooks; the core asks clientFor().hooks). Tested in
// lib/__tests__/claudeHookInput.test.ts and, for the hooks' own answers, __tests__/hookAnswerBytes.test.ts.
// =============================================================
'use strict';

/** The hook payload in the core's names, or null for a missing payload. */
function read(raw) {
  if (raw == null) return null;
  return {
    event: raw.hook_event_name,
    session: raw.session_id,
    cwd: raw.cwd,
    effort: raw.effort, // { level }
    // The session's own transcript (in a subagent's hook, often the main session's file).
    transcript: raw.transcript_path,
    agent: { id: raw.agent_id, type: raw.agent_type, transcript: raw.agent_transcript_path },
    tool: { name: raw.tool_name, input: raw.tool_input, response: raw.tool_response, interrupted: raw.is_interrupt },
    // SubagentStop: the closing text (since 2.1.271 not the report when the agent used SubagentHandback; the end gate
    // reads the call from the transcript too, lib/contextGuard.js hasEndLine).
    lastMessage: raw.last_assistant_message,
    stopActive: raw.stop_hook_active,
    notification: raw.notification_type, // Notification
    source: raw.source, // SessionStart: startup | resume | clear | compact
    reason: raw.reason, // SessionEnd
    error: raw.error, // StopFailure: rate_limit ...
    prompt: raw.prompt, // UserPromptSubmit
    raw,
  };
}

/** The status line payload in the core's names, or null for a missing payload. */
function status(raw) {
  if (raw == null) return null;
  return {
    session: raw.session_id,
    cwd: raw.cwd,
    workspace: raw.workspace, // { current_dir, project_dir }
    model: raw.model, // { id, display_name }
    context: raw.context_window, // { total_input_tokens, context_window_size, used_percentage }
    cost: raw.cost, // { total_cost_usd, total_duration_ms, total_api_duration_ms }
    limits: raw.rate_limits, // { five_hour, seven_day: { used_percentage, resets_at } }
    raw,
  };
}

/** A permission decision ('allow' | 'deny' | 'ask' | 'defer') with its reason, for PreToolUse. */
function decision(event, value, reason) {
  return { hookSpecificOutput: { hookEventName: event, permissionDecision: value, permissionDecisionReason: reason } };
}

/** A denial with its reason. */
function deny(event, reason) {
  return decision(event, 'deny', reason);
}

/** Text for the agent's context (additionalContext; Claude Code takes up to 10,000 characters per string). */
function context(event, text) {
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

/** The additionalContext of an answer built here (or by lib/contextGuard.js hookOutput), or undefined. */
function contextOf(answer) {
  return answer?.hookSpecificOutput?.additionalContext;
}

/**
 * A message to the owner (systemMessage: shown to the user, not read by the model). Spread it into an answer so the
 * key keeps its place: { ...message(text), ...context(event, more) }.
 */
function message(text) {
  return { systemMessage: text };
}

/** A block with its reason (decision 'block'): Stop and SubagentStop keep the agent going, UserPromptSubmit drops the prompt. */
function block(reason) {
  return { decision: 'block', reason };
}

module.exports = { read, status, decision, deny, context, contextOf, message, block };
