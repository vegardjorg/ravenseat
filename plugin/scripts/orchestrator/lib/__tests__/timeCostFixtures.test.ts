// =============================================================
// timeCostFixtures.test.ts: what lib/timeCost.js reads from a transcript today, locked on the format fixtures per
// Claude Code version (roadmap 0w W3; the safety net for W2b2, which moves this reading behind clientFor().entries).
//
// Characterization: these numbers are what analyzeTranscript gives on the fixtures now (green before W2b2), checked by
// hand against the fixture rows and PRICE_TABLE. W2b2 must keep them green without changing an expectation.
// Covers exactly the fields timeCost reads: message.id (a streamed message counted once, the last usage wins),
// message.model and '<synthetic>', message.usage (input_tokens, output_tokens, cache_read_input_tokens,
// cache_creation_input_tokens, the nested cache_creation split or its absence, output_tokens_details.thinking_tokens),
// tool_use (id, name, input), tool_result (tool_use_id, is_error, the content size), both forms of an API error,
// timestamp, version, cwd and the mission text (the track id). Not in the fixtures yet: isMeta and the background task
// notification (the prompt origin of detail turns); turnTools.test.ts covers those inline.
// The fixtures and where their shapes come from: lib/clients/claude/fixtures/formats/README.md.
// =============================================================
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports */
const T = require('../timeCost.js');
/* eslint-enable @typescript-eslint/no-require-imports */

const DIR = path.join(__dirname, '..', 'clients', 'claude', 'fixtures', 'formats');
const PRE = 'pre-2.1.317.jsonl';
const NOW = '2.1.317.jsonl';
const text = (f: string) => fs.readFileSync(path.join(DIR, f), 'utf8');
const rows = (f: string) =>
  text(f)
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
const tokens = (input: number, output: number, read: number, written: number, w5: number, w1: number) => ({
  input,
  output,
  cache_read: read,
  cache_written: written,
  cache_written_5m: w5,
  cache_written_1h: w1,
});

/** analyzeTranscript on each fixture, every field (no detail). */
const ANALYSIS: Record<string, object> = {
  [PRE]: {
    duration_s: 750,
    // 10:01:50 to 10:12:00 is one idle gap (over 5 min) and is left out of the active time.
    active_s: 140,
    idle_gaps: 1,
    toolCall: 4,
    // Five model turns: the streamed msg_pre_2 once, the four API error entries none.
    modelTurns: 5,
    tokens: tokens(118, 148, 5200, 4210, 3210, 1000),
    model: 'claude-opus-5-5',
    byModel: {
      // 18 x 4 + 98 x 20 + 5200 x 0.2 + 210 x 5 + 1000 x 8 = 12,122 per MTok.
      'claude-opus-5-5': { turns: 4, tokens: tokens(18, 98, 5200, 1210, 210, 1000), cost_usd: 0.0121 },
      // No split: the 3000 written count as 5 min. 100 x 2 + 50 x 10 + 3000 x 2.5 = 8,200 per MTok.
      'claude-sonnet-5': { turns: 1, tokens: tokens(100, 50, 0, 3000, 3000, 0), cost_usd: 0.0082 },
    },
    tools: {
      Bash: { calls: 1, errors: 0 },
      Edit: { calls: 1, errors: 1 },
      REPL: { calls: 1, errors: 0 },
      SubagentHandback: { calls: 1, errors: 0 },
    },
    // The entry form: overloaded (529), a rate limit with a warning, a plain 429 and the usage limit (429).
    api_errors: { rate_limit: 3, overloaded: 1, other: 0 },
    // The Sonnet turn came after the idle gap (over the 5 min TTL) and wrote more than it read.
    cache_expiry: 1,
    // S8, PC-5: that turn's extra cost, 3000 tokens without a split (5 min) at Sonnet's 2.5 per MTok minus the 0.2 read
    // price it replaced: 3000 x 2.3 = 6,900 per MTok.
    cache_expiry_usd: 0.0069,
    thinking_tokens: null,
    thinking_turns: 0,
    cc_version: '2.1.300',
    cost_usd: 0.02,
    context: { start: 1010, median: 1205, end: 3011 },
    first_change_s: 11,
    call_for_first_change: 1,
    track: 'FX-1',
  },
  [NOW]: {
    duration_s: 150,
    active_s: 150,
    idle_gaps: 0,
    toolCall: 4,
    modelTurns: 5,
    tokens: tokens(75, 110, 5600, 3600, 2100, 1500),
    model: 'claude-fable-5-2',
    byModel: {
      // At the Fable 5.2 row (F3): 75 x 8 + 110 x 40 + 5600 x 0.2 + 2100 x 10 + 1500 x 16 = 51,120 per MTok.
      'claude-fable-5-2': { turns: 5, tokens: tokens(75, 110, 5600, 3600, 2100, 1500), cost_usd: 0.0511 },
    },
    tools: {
      Read: { calls: 1, errors: 0 },
      Bash: { calls: 1, errors: 1 },
      REPL: { calls: 1, errors: 0 },
      SubagentHandback: { calls: 1, errors: 0 },
    },
    // The system form (F1): rate_limit (a code), a plain 429 and the usage limit as a bare code, overloaded (529). The
    // usage limit was 'other' before W2b2; it is a rate limit as in the entry form (see claudeFormatContract.test.ts).
    api_errors: { rate_limit: 3, overloaded: 1, other: 0 },
    cache_expiry: 0,
    cache_expiry_usd: 0,
    thinking_tokens: 25,
    thinking_turns: 1,
    cc_version: '2.1.317',
    cost_usd: 0.05,
    context: { start: 2020, median: 2020, end: 1501 },
    // No Edit or Write in this transcript.
    first_change_s: null,
    call_for_first_change: null,
    track: 'FX-2',
  },
};

describe('timeCost.analyzeTranscript on the format fixtures', () => {
  it.each([PRE, NOW])('%s: every field of the analysis', (f) => {
    T.setPriceOverrides(null);
    expect(T.analyzeTranscript(text(f)), f).toEqual(ANALYSIS[f]);
  });

  it.each([PRE, NOW])('%s: the detail (turns in order, calls, prompt, result sizes, cwd)', (f) => {
    T.setPriceOverrides(null);
    const d = T.analyzeTranscript(text(f), { detail: true }).detail;
    expect(
      d.turns.map((t: { model: string; calls: { name: string }[]; origin: string; prompt: number }) => [
        t.model,
        t.calls.map((c) => c.name),
        t.origin,
        t.prompt,
      ]),
      f,
    ).toEqual(
      f === PRE
        ? [
            ['claude-opus-5-5', [], 'user', 1],
            ['claude-opus-5-5', ['Bash', 'Edit'], 'user', 1],
            ['claude-opus-5-5', ['REPL'], 'user', 1],
            ['claude-sonnet-5', [], 'user', 1],
            ['claude-opus-5-5', ['SubagentHandback'], 'user', 1],
          ]
        : [
            ['claude-fable-5-2', [], 'user', 1],
            ['claude-fable-5-2', ['Read', 'Bash'], 'user', 1],
            ['claude-fable-5-2', ['REPL'], 'user', 1],
            ['claude-fable-5-2', [], 'user', 1],
            ['claude-fable-5-2', ['SubagentHandback'], 'user', 1],
          ],
    );
    // A streamed message keeps its first time and its last usage.
    if (f === PRE) {
      expect(d.turns[1].ts).toBe(Date.parse('2026-11-01T10:00:10.000Z'));
      expect(d.turns[1].usage.output_tokens).toBe(40);
    }
    expect(d.resultChars, f).toEqual(
      f === PRE ? { toolu_pre_1: 5, toolu_pre_2: 28, toolu_pre_3: 1 } : { toolu_317_1: 1, toolu_317_2: 11, toolu_317_3: 1 },
    );
    expect(d.cwd, f).toBe('/fixture/work');
  });

  it.each([PRE, NOW])('%s: addUsage per usage row (the cache split, or 5 min without one)', (f) => {
    for (const r of rows(f)) {
      const u = r.message?.usage;
      if (!u || r.message.model === '<synthetic>') continue;
      const got = T.emptyTokens();
      T.addUsage(got, u);
      const split = u.cache_creation;
      expect(got, `${f} ${r.uuid}`).toEqual(
        tokens(
          u.input_tokens,
          u.output_tokens,
          u.cache_read_input_tokens,
          u.cache_creation_input_tokens,
          split ? split.ephemeral_5m_input_tokens : u.cache_creation_input_tokens,
          split ? split.ephemeral_1h_input_tokens : 0,
        ),
      );
    }
  });

  it.each([PRE, NOW])('%s: apiErrorKind per row, in the form the version writes', (f) => {
    const kinds = Object.fromEntries(rows(f).map((r) => [r.uuid, T.apiErrorKind(r)]).filter(([, k]) => k));
    expect(kinds, f).toEqual(
      f === PRE
        ? {
            'fx-api-error-overloaded': 'overloaded',
            'fx-api-error-rate-limit': 'rate_limit',
            'fx-api-error-plain-429': 'rate_limit',
            'fx-api-error-usage-limit': 'rate_limit',
          }
        : {
            'fx-api-error-system-rate-limit': 'rate_limit',
            'fx-api-error-system-overloaded': 'overloaded',
            'fx-api-error-system-plain-429': 'rate_limit',
            'fx-api-error-system-usage-limit': 'rate_limit',
          },
    );
  });

  it('a half line at the cut changes nothing', () => {
    T.setPriceOverrides(null);
    const a = T.analyzeTranscript(`${text(PRE)}{"type":"assis`);
    expect(a).toEqual(ANALYSIS[PRE]);
  });
});
