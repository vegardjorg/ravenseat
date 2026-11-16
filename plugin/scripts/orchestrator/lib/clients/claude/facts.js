// =============================================================
// clients/claude/facts.js: the dated Claude Code facts the queue depends on outside dispatch and the mission text:
// the transcript format, the transcript paths, the hook events and their payload fields, the status line payload,
// the cache lifetimes, the model ids, the environment variables, the CLI flags and the settings paths.
//
// FACTS (frozen list), SOURCES, factsByArea and factById.
//
// Why: Claude Code can rename a field or move a file in any release. Each fact says what the queue reads, when it was
// last confirmed and where (public docs by URL, or observed in local transcripts, field names only), which files read
// it today, how fragile it is (H: undocumented and read for decisions, M: documented or read for display, L: stable
// and documented), and which 0w bolk moves it behind the adapter (W2 the reader, W3 the fixture, W4 the canary).
// When Claude Code changes a fact, fix it here first, then the readers listed in it.
//
// Pure data, no I/O. The readers are file paths relative to plugin/scripts/orchestrator; line numbers are left out on
// purpose (they drift), the W1 report has them. No transcript content and no personal paths belong in this file.
// Used by lib/__tests__/clientCouplingGate.test.ts (every file on its allowlist must be a reader of some fact here).
// =============================================================
'use strict';

/** Where a fact was confirmed. The observed source is local transcripts; only field names were read. */
const SOURCES = Object.freeze({
  hooks: 'https://code.claude.com/docs/en/hooks',
  statusline: 'https://code.claude.com/docs/en/statusline',
  envVars: 'https://code.claude.com/docs/en/env-vars',
  cli: 'https://code.claude.com/docs/en/cli-reference',
  caching: 'https://platform.claude.com/docs/en/build-with-claude/prompt-caching',
  observed: 'observed in local transcripts, Claude Code 2.1.317 to 2.1.325 (field names and type values only)',
});

const W1 = '2026-11-16';

/**
 * One fact: { id, area, what, value, fragility, move, confirmed, source, readers }.
 *   area       transcript | transcriptPath | hook | statusline | cache | model | env | cli | settings
 *   fragility  'H' | 'M' | 'L' (see the header)
 *   move       the 0w bolk that moves the reading behind the adapter: 'W2' (the reader), 'W3' (fixture only), 'W4' (canary)
 *   source     a key of SOURCES
 */
const FACTS = Object.freeze(
  [
    // ---- Transcript format (undocumented: observed only) ----
    {
      id: 'transcript.usage',
      area: 'transcript',
      what: 'token usage per assistant entry',
      value: 'message.usage { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, cache_creation { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens } } and message.model',
      fragility: 'H',
      move: 'W2',
      source: 'observed',
      readers: ['lib/timeCost.js', 'lib/trackGuard.js', 'lib/turnTools.js'],
    },
    {
      id: 'transcript.entryTypes',
      area: 'transcript',
      what: 'entry type and the content blocks of a message',
      value: "type 'assistant' | 'user' | 'system'; message.content[] blocks { type: 'text' | 'thinking' | 'tool_use' (id, name, input) | 'tool_result' (tool_use_id, content) }; timestamp, cwd",
      fragility: 'H',
      move: 'W2',
      source: 'observed',
      readers: [
        'lib/timeCost.js',
        'lib/contextGuard.js',
        'lib/askBundle.js',
        'lib/logic/results.js',
        'lib/approvalWait.js',
        'lib/usageLimit.js',
      ],
    },
    {
      id: 'transcript.handback',
      area: 'transcript',
      what: "a subagent's delivered report",
      value: "a tool_use block named 'SubagentHandback' with input.message (the text after it is not the report)",
      fragility: 'H',
      move: 'W2',
      source: 'hooks',
      readers: ['lib/logic/results.js', 'lib/askBundle.js'],
    },
    {
      id: 'transcript.compactBoundary',
      area: 'transcript',
      what: 'a compaction of the session',
      value: "an entry { type: 'system', subtype: 'compact_boundary' } in the same file",
      fragility: 'H',
      move: 'W2',
      source: 'observed',
      readers: ['lib/contextGuard.js', 'lib/trackGuard.js'],
    },
    {
      id: 'transcript.apiError',
      area: 'transcript',
      what: 'a failed API call (rate limit, overloaded)',
      value: "read as an assistant entry with isApiErrorMessage, apiErrorStatus, error and model '<synthetic>'; observed in 2.1.317+ as { type: 'system', subtype: 'api_error', error, retryInMs, retryAttempt, maxRetries } instead",
      fragility: 'H',
      move: 'W2',
      source: 'observed',
      readers: ['lib/timeCost.js', 'lib/usageLimit.js'],
    },
    {
      id: 'transcript.sidechain',
      area: 'transcript',
      what: 'the subagent marker in an entry',
      value: 'isSidechain (boolean), agentId in a subagent file; parentUuid, uuid, sessionId, version on every entry',
      fragility: 'M',
      move: 'W3',
      source: 'observed',
      readers: [],
    },
    // ---- Transcript paths (undocumented apart from the hook examples) ----
    {
      id: 'transcriptPath.layout',
      area: 'transcriptPath',
      what: 'where a session and its subagents are stored',
      value: '<config dir>/projects/<main tree path with every non [A-Za-z0-9] as ->/<session id>.jsonl, subagents in <session id>/subagents/agent-<agent id>.jsonl',
      fragility: 'H',
      move: 'W2',
      source: 'hooks',
      readers: [
        'cli/ask.mjs',
        'cli/cost.mjs',
        'cli/events.mjs',
        'cli/tracks.mjs',
        'hook-context.mjs',
        'lib/trackActivity.js',
        'lib/trackGuard.js',
        'lib/eventStatistics.js',
        'lib/approvalWait.js',
        'lib/fixRound.js',
      ],
    },
    // ---- Hooks (documented) ----
    {
      id: 'hook.events',
      area: 'hook',
      what: 'the hook events the plugin registers (plugin/hooks/hooks.json)',
      value: 'PreToolUse (Bash|PowerShell|Monitor, Read, Write|Edit|NotebookEdit), PostToolUse, SessionStart (compact), SubagentStart, SubagentStop, UserPromptSubmit, Notification (permission_prompt), PermissionDenied, PostToolUseFailure, StopFailure, SessionEnd, PreCompact',
      fragility: 'L',
      move: 'W4',
      source: 'hooks',
      readers: [],
    },
    {
      id: 'hook.commonInput',
      area: 'hook',
      what: 'the fields every hook payload carries',
      value: 'session_id, transcript_path, cwd, permission_mode, effort, hook_event_name; agent_id and agent_type inside a subagent',
      fragility: 'M',
      move: 'W2',
      source: 'hooks',
      readers: [
        'hook-after-compact.mjs',
        'hook-context.mjs',
        'hook-effort.mjs',
        'hook-time.mjs',
        'hook-read-guard.mjs',
        'hook-write-guard.mjs',
        'hook-push-guard.mjs',
        'hook-track-context.mjs',
        'hook-track-end.mjs',
        'hook-usage-limit.mjs',
        'hook-approval-wait.mjs',
        'hook-tool-trouble.mjs',
        'hook-session-end.mjs',
      ],
    },
    {
      id: 'hook.toolInput',
      area: 'hook',
      what: 'the tool call in PreToolUse and PostToolUse',
      value: 'tool_name, tool_input (command, file_path ...), tool_use_id; PostToolUse also tool_response',
      fragility: 'M',
      move: 'W2',
      source: 'hooks',
      readers: [
        'hook-push-guard.mjs',
        'hook-read-guard.mjs',
        'hook-write-guard.mjs',
        'hook-track-context.mjs',
        'lib/toolTrouble.js',
      ],
    },
    {
      id: 'hook.subagentStop',
      area: 'hook',
      what: 'the end of a subagent',
      value: 'agent_transcript_path, stop_hook_active, last_assistant_message (since 2.1.271 only the closing text when the agent used SubagentHandback)',
      fragility: 'M',
      move: 'W2',
      source: 'hooks',
      readers: ['hook-time.mjs', 'hook-track-end.mjs', 'lib/trackGuard.js'],
    },
    {
      id: 'hook.otherInput',
      area: 'hook',
      what: 'event fields read by single hooks',
      value: "Notification notification_type ('permission_prompt'); SessionStart source; SessionEnd reason; StopFailure error; PreCompact trigger, custom_instructions; UserPromptSubmit prompt",
      fragility: 'M',
      move: 'W2',
      source: 'hooks',
      readers: [
        'hook-approval-wait.mjs',
        'hook-after-compact.mjs',
        'hook-session-end.mjs',
        'hook-usage-limit.mjs',
        'hook-context.mjs',
      ],
    },
    {
      id: 'hook.output',
      area: 'hook',
      what: 'what a hook answers',
      value: "hookSpecificOutput { hookEventName, permissionDecision 'allow'|'deny'|'ask'|'defer', permissionDecisionReason, additionalContext (10,000 characters per string) }; decision 'block' with reason",
      fragility: 'L',
      move: 'W2',
      source: 'hooks',
      readers: [
        'hook-push-guard.mjs',
        'hook-read-guard.mjs',
        'hook-write-guard.mjs',
        'hook-track-context.mjs',
        'hook-after-compact.mjs',
        'hook-context.mjs',
        'lib/contextGuard.js',
      ],
    },
    // ---- Status line (documented) ----
    {
      id: 'statusline.input',
      area: 'statusline',
      what: 'the status line payload',
      value: 'context_window { total_input_tokens, context_window_size }, cost { total_cost_usd, total_duration_ms, total_api_duration_ms }, rate_limits { five_hour, seven_day }, workspace { current_dir, project_dir }, cwd',
      fragility: 'M',
      move: 'W2',
      source: 'statusline',
      readers: ['statusline.mjs', 'lib/eventRows.js', 'lib/rateLimits.js'],
    },
    // ---- Cache and models ----
    {
      id: 'cache.ttl',
      area: 'cache',
      what: 'the prompt cache lifetimes and write factors',
      value: "'5m' 300 s and '1h' 3600 s; cache writes 1.25x and 2x the input price",
      fragility: 'L',
      move: 'W3',
      source: 'caching',
      readers: ['lib/timeCost.js'],
    },
    {
      id: 'model.ids',
      area: 'model',
      what: 'the model ids in message.model',
      value: "claude-opus-5-5, claude-fable-5-2, claude-haiku-5-5 observed ('<synthetic>' for an API error entry); the Agent tool takes opus, sonnet, haiku, fable (dispatch.js)",
      fragility: 'M',
      move: 'W4',
      source: 'observed',
      readers: ['lib/timeCost.js'],
    },
    // ---- Environment, CLI, settings ----
    {
      id: 'env.claude',
      area: 'env',
      what: 'environment variables Claude Code sets or reads',
      value: 'CLAUDECODE=1 in spawned processes; CLAUDE_PROJECT_DIR and CLAUDE_PLUGIN_ROOT for hooks; CLAUDE_CONFIG_DIR (the config folder); CLAUDE_EFFORT; CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC; DISABLE_UPDATES',
      fragility: 'L',
      move: 'W4',
      source: 'envVars',
      readers: [
        'lib/projectRoot.js',
        'lib/claudeFingerprint.js',
        'lib/gateEnv.js',
        'lib/queueUpdate.js',
        'hook-effort.mjs',
        'cli/doctor.mjs',
        'setup.mjs',
      ],
    },
    {
      id: 'cli.cloud',
      area: 'cli',
      what: 'starting a cloud session from the CLI',
      value: "claude --cloud <task> (--remote is the deprecated alias)",
      fragility: 'M',
      move: 'W4',
      source: 'cli',
      readers: ['cloud-start.mjs', 'lib/cloudSetup.js', 'cli/cloud.mjs'],
    },
    {
      id: 'settings.paths',
      area: 'settings',
      what: 'the Claude settings and memory files the queue reads or hashes',
      value: '<config dir>/settings.json, settings.local.json, CLAUDE.md, plugins/installed_plugins.json, agents/, hooks/; <config dir>/projects/<slug>/memory/MEMORY.md; <repo>/.claude/settings(.local).json',
      fragility: 'M',
      move: 'W4',
      source: 'envVars',
      readers: ['lib/claudeFingerprint.js', 'lib/instructionSize.js', 'setup.mjs', 'cli/doctorBaseline.mjs'],
    },
  ].map((f) => Object.freeze({ confirmed: W1, ...f, readers: Object.freeze([...f.readers]) })),
);

/** The facts of one area, in list order. */
function factsByArea(area) {
  return FACTS.filter((f) => f.area === area);
}

/** One fact by id, or null. */
function factById(id) {
  return FACTS.find((f) => f.id === id) ?? null;
}

module.exports = { FACTS, SOURCES, factsByArea, factById };
