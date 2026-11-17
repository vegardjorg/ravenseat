# Claude Code format fixtures (roadmap 0w W3)

Scrubbed rows in the shapes Claude Code writes, one file per version family. No real text, paths or ids: every value
is invented, the paths start with `/fixture/`, and every row's `uuid` is a label (`fx-...`) that the contract tests
use in their names, so a red test says which form and which version broke.

The contract tests are `lib/__tests__/claudeFormatContract.test.ts` (the adapter: `entries`, `transcript`, `hooks`
and the readers that use them) and `lib/__tests__/timeCostFixtures.test.ts` (what `lib/timeCost.js` reads today, the
safety net for W2b2). When Claude Code changes a format: add a new file for the new version family, keep the old one
(old transcripts stay on disk), and fix the adapter until both are green.

## Files

| File | Version family | What it holds |
| --- | --- | --- |
| `pre-2.1.317.jsonl` | Claude Code up to 2.1.316 (`version` 2.1.300) | one subagent transcript, API errors as assistant entries |
| `2.1.317.jsonl` | Claude Code 2.1.317 and later (`version` 2.1.317) | one subagent transcript with the request rows and the system `api_error` row |
| `hooks.json` | any | the hook payloads per event and the status line payload |

## Where each shape comes from

Confirmed means the field names and type values were seen (lib/clients/claude/facts.js, source and date per fact);
assumed means the shape is a best guess and has NOT been checked against real data.

| Rows (uuid) | Shape | Source |
| --- | --- | --- |
| every row: `type`, `uuid`, `timestamp`, `isSidechain`, `agentId`, `sessionId`, `version`, `cwd` | the common entry fields | confirmed (facts `transcript.entryTypes`, `transcript.sidechain`; observed) |
| `fx-mission` | user row, `message.content` a string | confirmed (observed; the shape `timeCost.trackFromText` reads) |
| `fx-turn1-thinking-text`, `fx-turn2-*`, `fx-repl`, `fx-tool-use-two`, `fx-turn3-no-split`, `fx-turn-after-compaction`, `fx-handback` | assistant row, `message { id, model, content[], usage }` with `thinking`, `text` and `tool_use` blocks | confirmed (facts `transcript.entryTypes`, `transcript.usage`; observed) |
| the same rows: `usage.cache_read_input_tokens`, `cache_creation_input_tokens`, nested `cache_creation { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens }` | the cache fields | confirmed (fact `transcript.usage`; the prompt caching docs) |
| `fx-turn3-no-split` | usage without the nested `cache_creation` split | confirmed as an older API response shape (timeCost reads it as 5 min); not seen in 2.1.317+ |
| `fx-turn2-tool-use-a`, `fx-turn2-tool-use-b` | one streamed message over two rows with the same `message.id` | confirmed (the dedup timeCost has always done) |
| `fx-turn1-thinking-text` (2.1.317): `usage.output_tokens_details.thinking_tokens` | thinking tokens per turn | assumed, not confirmed against real data (timeCost reads it when present) |
| `thinking` block `{ thinking: '', signature }` | the thinking block with its text omitted | assumed for the exact fields (the queue only reads the block type) |
| `fx-tool-result-*`, `fx-repl-result` | user row with `tool_result { tool_use_id, content, is_error }`, content a string or a list of text blocks | confirmed (fact `transcript.entryTypes`; observed) |
| `fx-repl` | a `tool_use` named `REPL` (Code Mode) | assumed input shape (`{ code }`); the queue treats it as a plain tool |
| `fx-handback` | `tool_use` named `SubagentHandback` with `input.message` | confirmed (fact `transcript.handback`; hooks docs) |
| `fx-compaction` | `{ type: 'system', subtype: 'compact_boundary' }` | confirmed (fact `transcript.compactBoundary`); `content` and `compactMetadata` are assumed |
| `fx-unknown-snapshot` | `file-history-snapshot` row without a timestamp | confirmed type name (observed); the other fields are assumed |
| `fx-api-error-overloaded`, `fx-api-error-rate-limit`, `fx-api-error-plain-429` (pre) | assistant entry with `isApiErrorMessage`, `apiErrorStatus`, `error`, model `<synthetic>` and an "API Error: ..." text | confirmed (fact `transcript.apiError`); the exact `error` codes and texts are assumed |
| `fx-api-error-usage-limit` (pre) | the same with `apiError: 'usage_limit_reached'` and `quotaLimits { status: 'rejected', resetsAt, rateLimitType }` | confirmed field names (the ones `usageLimit.fromEntry` has read since it was written); values invented |
| `fx-api-error-rate-limit` (pre): `quotaLimits.status: 'allowed_warning'` | a quota warning, not a rejection | assumed status value |
| `fx-api-request`, `fx-api-request-blob`, `fx-api-request-shape` (2.1.317) | the request rows | confirmed type names (observed 2.1.317+); their other fields are assumed |
| `fx-api-error-system-*` (2.1.317) | `{ type: 'system', subtype: 'api_error', error, retryInMs, retryAttempt, maxRetries }` | field names confirmed (fact `transcript.apiError`, observed); what `error` holds is **assumed, not confirmed against real data**: a string code (`rate_limit`, `usage_limit_reached`), an object with `status`, and an object with a nested `error { type, message }` are all covered, because the adapter reads all three |
| `hooks.json` payloads | `session_id`, `transcript_path`, `cwd`, `hook_event_name`, and per event `tool_name`, `tool_input`, `tool_response`, `prompt`, `stop_hook_active`, `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`, `error`, `source`, `reason`, `notification_type` | confirmed (facts `hook.*`; https://code.claude.com/docs/en/hooks); `permission_mode`, `tool_use_id`, `message` are documented but not read by the queue |
| `hooks.json` status line | `model`, `workspace`, `cost`, `context_window`, `rate_limits` | confirmed (fact `statusline.input`; https://code.claude.com/docs/en/statusline) |

The fixtures were written by hand from these shapes on 2026-11-17. When one of the assumed shapes is checked against
real data, update this table (and the fact in facts.js), then the fixture if the real shape differs.
