// =============================================================
// claudeFormatContract.test.ts: the Claude Code formats per version family, run through the client adapter and the
// readers that use it (roadmap 0w W3).
//
// The fixtures are lib/clients/claude/fixtures/formats/ (one JSONL file per version family and hooks.json; the README
// there says where each shape comes from and which ones are assumed). Every row has a label as its uuid, and every
// test name carries the file and the label, so a format change shows as a red test that names the form and the version.
//
// Locks:
//   entries     the normalized event of every row (kind, subtype, time, model, usage in the core's names, the parts,
//               the handback, the compaction flag, the API error in both forms), and that no row is left unchecked
//   transcript  the folder layout: a main session and a subagent file found, read and listed from the fixtures
//   hooks       the payload of every hook event and the status line in the core's names
//   readers     usageLimit (fromEntry per row, the tail decision, decide with the StopFailure payload), logic/results
//               lastAnswer, contextGuard countCompactions and hasEndLine, trackGuard lastContext and subagentTranscript,
//               approvalWait pendingToolUse and turnTools transcriptStats
// What timeCost reads is locked in timeCostFixtures.test.ts (the safety net for W2b2).
// =============================================================
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports */
const C = require('../clients/index.js').clientFor();
const E = C.entries;
const TR = C.transcripts;
const HK = C.hooks;
const UL = require('../usageLimit.js');
const R = require('../logic/results.js');
const KV = require('../contextGuard.js');
const TG = require('../trackGuard.js');
const AW = require('../approvalWait.js');
const TT = require('../turnTools.js');
const T = require('../timeCost.js');
/* eslint-enable @typescript-eslint/no-require-imports */

const DIR = path.join(__dirname, '..', 'clients', 'claude', 'fixtures', 'formats');
const PRE = 'pre-2.1.317.jsonl';
const NOW = '2.1.317.jsonl';
const FILES = [PRE, NOW];

type Row = Record<string, unknown> & { uuid: string };
const text = (f: string) => fs.readFileSync(path.join(DIR, f), 'utf8');
const rows = (f: string): Row[] =>
  text(f)
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
/** The text of a fixture up to and including the row with this label (a transcript as it stood then). */
const upTo = (f: string, label: string) => {
  const all = text(f).split('\n').filter((l) => l.trim());
  const i = all.findIndex((l) => JSON.parse(l).uuid === label);
  if (i < 0) throw new Error(`${f}: no row ${label}`);
  return all.slice(0, i + 1).join('\n');
};

/** The event in a compact form: parts as "kind[:name|:id][:error]", usage without raw, the time as ISO. */
function shape(e: {
  kind: string;
  subtype: string | null;
  at: number | null;
  model?: string;
  usage: Record<string, unknown> | null;
  parts: { kind: string; name?: string; id?: string; isError?: boolean; type?: string }[] | null;
  handback: string | null;
  compaction: boolean;
  apiError: unknown;
}) {
  const usage = e.usage ? Object.fromEntries(Object.entries(e.usage).filter(([k, v]) => k !== 'raw' && v !== undefined)) : null;
  const parts = e.parts
    ? e.parts.map((p) =>
        p.kind === 'tool'
          ? `tool:${p.name}`
          : p.kind === 'result'
            ? `result:${p.id}${p.isError ? ':error' : ''}`
            : p.kind === 'other'
              ? `other:${p.type}`
              : p.kind,
      )
    : null;
  return {
    kind: e.kind,
    subtype: e.subtype,
    at: e.at === null ? null : new Date(e.at).toISOString(),
    model: e.model ?? null,
    usage,
    parts,
    handback: e.handback,
    compaction: e.compaction,
    apiError: e.apiError,
  };
}

const none = { usage: null, parts: null, handback: null, compaction: false, apiError: null, model: null };
const u = (input: number, output: number, cacheRead: number, cacheWritten: number, split?: [number, number]) => ({
  input,
  output,
  cacheRead,
  cacheWritten,
  ...(split ? { cache5m: split[0], cache1h: split[1] } : {}),
});
const asst = (at: string, model: string, usage: object, parts: string[], handback: string | null = null) => ({
  kind: 'assistant',
  subtype: null,
  at,
  model,
  usage,
  parts,
  handback,
  compaction: false,
  apiError: null,
});
const userRow = (at: string, parts: string[] | null) => ({ ...none, kind: 'user', subtype: null, at, parts });
const synthetic = (at: string, apiError: object) => ({
  kind: 'assistant',
  subtype: null,
  at,
  model: '<synthetic>',
  usage: u(0, 0, 0, 0),
  parts: ['text'],
  handback: null,
  compaction: false,
  apiError,
});
const sysError = (at: string, apiError: object) => ({ ...none, kind: 'system', subtype: 'api_error', at, apiError });
const unknown = (at: string | null) => ({ ...none, kind: 'unknown', subtype: null, at });
const t = (day: string) => (hms: string) => `2026-11-${day}T${hms}.000Z`;
const P = t('01');
const N = t('10');

/** The normalized event of every fixture row, per file and label. */
const EXPECTED: Record<string, Record<string, object>> = {
  [PRE]: {
    'fx-mission': userRow(P('10:00:00'), null),
    'fx-turn1-thinking-text': asst(P('10:00:05'), 'claude-opus-5-5', u(10, 20, 0, 1000, [0, 1000]), ['other:thinking', 'text']),
    'fx-turn2-tool-use-a': asst(P('10:00:10'), 'claude-opus-5-5', u(5, 3, 1000, 200, [200, 0]), ['tool:Bash']),
    'fx-turn2-tool-use-b': asst(P('10:00:11'), 'claude-opus-5-5', u(5, 40, 1000, 200, [200, 0]), ['tool:Edit']),
    'fx-tool-result-ok': userRow(P('10:00:12'), ['result:toolu_pre_1']),
    'fx-tool-result-error': userRow(P('10:00:13'), ['result:toolu_pre_2:error']),
    'fx-repl': asst(P('10:00:20'), 'claude-opus-5-5', u(2, 8, 1200, 0), ['tool:REPL']),
    'fx-repl-result': userRow(P('10:00:21'), ['result:toolu_pre_3']),
    'fx-unknown-snapshot': unknown(null),
    'fx-compaction': { ...none, kind: 'system', subtype: 'compact_boundary', at: P('10:01:00'), compaction: true },
    'fx-api-error-overloaded': synthetic(P('10:01:30'), { kind: 'overloaded', form: 'entry', status: 529, code: 'server_error' }),
    'fx-api-error-rate-limit': synthetic(P('10:01:40'), { kind: 'rate_limit', form: 'entry', status: 429, code: 'rate_limit' }),
    'fx-api-error-plain-429': synthetic(P('10:01:45'), { kind: 'rate_limit', form: 'entry', status: 429, code: '' }),
    'fx-api-error-usage-limit': synthetic(P('10:01:50'), { kind: 'rate_limit', form: 'entry', status: 429, code: 'rate_limit' }),
    'fx-turn3-no-split': asst(P('10:12:00'), 'claude-sonnet-5', u(100, 50, 0, 3000), ['text']),
    'fx-handback': asst(P('10:12:30'), 'claude-opus-5-5', u(1, 30, 3000, 10, [10, 0]), ['text', 'tool:SubagentHandback'], 'RESULT status=DONE fixture'),
  },
  [NOW]: {
    'fx-mission': userRow(N('10:00:00'), null),
    'fx-api-request': unknown(N('10:00:01')),
    'fx-api-request-blob': unknown(N('10:00:01')),
    'fx-api-request-shape': unknown(N('10:00:01')),
    'fx-turn1-thinking-text': asst(N('10:00:05'), 'claude-fable-5-2', u(20, 60, 0, 2000, [2000, 0]), ['other:thinking', 'text']),
    'fx-tool-use-two': asst(N('10:00:10'), 'claude-fable-5-2', u(3, 15, 2000, 100, [100, 0]), ['tool:Read', 'tool:Bash']),
    'fx-tool-result-mixed': userRow(N('10:00:12'), ['result:toolu_317_1', 'result:toolu_317_2:error']),
    'fx-repl': asst(N('10:00:20'), 'claude-fable-5-2', u(1, 5, 2100, 0), ['tool:REPL']),
    'fx-repl-result': userRow(N('10:00:21'), ['result:toolu_317_3']),
    'fx-compaction': { ...none, kind: 'system', subtype: 'compact_boundary', at: N('10:01:00'), compaction: true },
    // A string error has no status: NaN, as entries.js reads it (Number(undefined)).
    'fx-api-error-system-rate-limit': sysError(N('10:01:10'), { kind: 'rate_limit', form: 'system', status: NaN, code: 'rate_limit' }),
    'fx-api-error-system-overloaded': sysError(N('10:01:20'), { kind: 'overloaded', form: 'system', status: 529, code: 'overloaded_error' }),
    'fx-api-error-system-plain-429': sysError(N('10:01:30'), { kind: 'rate_limit', form: 'system', status: 429, code: '' }),
    // The usage limit as a bare code (no 429, no rate limit words) is a rate limit, as in the entry form, which carries
    // the 429 (a deliberate change in W2b2: it was 'other'); usageLimit still reads it as the limit (below).
    'fx-api-error-system-usage-limit': sysError(N('10:01:40'), { kind: 'rate_limit', form: 'system', status: NaN, code: 'usage_limit_reached' }),
    'fx-turn-after-compaction': asst(N('10:02:00'), 'claude-fable-5-2', u(50, 10, 0, 1500, [0, 1500]), ['text']),
    'fx-handback': asst(N('10:02:30'), 'claude-fable-5-2', u(1, 20, 1500, 0), ['tool:SubagentHandback'], 'RESULT status=DONE fixture'),
  },
};

describe('the fixtures themselves', () => {
  it.each(FILES)('%s: every row parses, has a unique fx- label, the family version and no personal path', (f) => {
    const all = rows(f);
    expect(all.length).toBeGreaterThan(10);
    const labels = all.map((r) => r.uuid);
    expect(new Set(labels).size, `${f}: duplicate labels`).toBe(labels.length);
    for (const r of all) {
      expect(r.uuid, f).toMatch(/^fx-[a-z0-9-]+$/);
      expect(r.version, `${f} ${r.uuid}`).toBe(f === PRE ? '2.1.300' : '2.1.317');
    }
    expect(text(f)).not.toMatch(/[A-Za-z]:\\|\/Users\/|\/home\//);
    // Every row has an expectation and every expectation a row: a new fixture row cannot slip through unchecked.
    expect(labels.sort()).toEqual(Object.keys(EXPECTED[f]).sort());
  });
});

describe.each(FILES)('entries on %s', (f) => {
  it.each(rows(f).map((r) => [r.uuid, r] as const))(`${f} %s: the normalized event`, (label, r) => {
    expect(shape(E.entry(r)), `${f} ${label}`).toEqual(EXPECTED[f][label]);
  });

  it(`${f}: the line pre-checks (MARK) hit every row they are meant for`, () => {
    for (const line of text(f).split('\n').filter((l) => l.trim())) {
      const e = E.entry(E.parse(line));
      if (e.compaction) expect(line, e.raw.uuid).toContain(E.MARK.compactionQuoted);
      if (e.usage) expect(line, e.raw.uuid).toContain(E.MARK.usage);
      if (e.kind === 'assistant') expect(line, e.raw.uuid).toContain(E.MARK.assistant);
      if (e.tools.length) expect(line, e.raw.uuid).toContain(E.MARK.toolUse);
    }
  });
});

describe('transcript: the folder layout with the fixtures as files', () => {
  it(`a main session (${NOW}) and its subagent (${PRE}) are found, read and listed`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w3-layout-'));
    try {
      const sub = TR.agentTranscriptPath(dir, 's-317', 'fx1');
      fs.mkdirSync(path.dirname(sub), { recursive: true });
      fs.writeFileSync(path.join(dir, 's-317.jsonl'), text(NOW));
      fs.writeFileSync(sub, text(PRE));
      expect(path.relative(dir, sub).split(path.sep)).toEqual(['s-317', 'subagents', 'agent-fx1.jsonl']);
      expect(TR.findAgentTranscript(dir, 'fx1')).toBe(sub);
      expect(TR.readAgentTranscript(dir, 'fx1')).toBe(text(PRE));
      expect(TR.readAgentTranscript(dir, 'fx1', { maxBytes: 10 })).toBeNull();
      expect(TR.listSubagents(dir, 's-317')).toEqual([{ agent: 'fx1', file: sub }]);
      expect(TR.listTranscripts(dir).sort((a: { file: string }, b: { file: string }) => a.file.localeCompare(b.file))).toEqual([
        { file: sub, session: 's-317', agent: 'fx1', main: false },
        { file: path.join(dir, 's-317.jsonl'), session: 's-317', main: true },
      ].sort((a, b) => a.file.localeCompare(b.file)));
      expect(TR.sessionOfTranscript(sub)).toBe('s-317');
      expect(TR.subagentsDirOf(path.join(dir, 's-317.jsonl'))).toBe(path.dirname(sub));
      // The tail of the subagent file ends with its last row, the handback.
      const tail = TR.readTail(sub, 1000);
      expect(tail.fromStart).toBe(false);
      expect(tail.size).toBe(Buffer.byteLength(text(PRE)));
      expect(E.parse(tail.text.trim().split('\n').pop()).uuid).toBe('fx-handback');
      expect(TR.readTail(sub, 1e6)).toEqual({ text: text(PRE), fromStart: true, size: tail.size });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the slug rule turns the fixture folder into the projects folder name', () => {
    expect(TR.slug('/fixture/work')).toBe('-fixture-work');
    expect(TR.transcriptsDir('/fixture/work', { env: {}, home: '/fixture/home' })).toBe(
      path.join('/fixture/home', '.claude', 'projects', '-fixture-work'),
    );
  });
});

describe('hooks: the payloads in hooks.json', () => {
  const H = JSON.parse(fs.readFileSync(path.join(DIR, 'hooks.json'), 'utf8'));
  const tp = '/fixture/home/.claude/projects/-fixture-work/s-hook.jsonl';
  const common = { session: 's-hook', cwd: '/fixture/work', transcript: tp };
  const per: Record<string, object> = {
    PreToolUse: { tool: { name: 'Bash', input: { command: 'git status', description: 'Show working tree status' }, response: undefined, interrupted: undefined } },
    PostToolUse: { tool: { name: 'Read', input: { file_path: '/fixture/work/a.txt' }, response: H.payloads.PostToolUse.tool_response, interrupted: undefined } },
    UserPromptSubmit: { prompt: 'continue: fixture prompt' },
    SubagentStop: {
      stopActive: false,
      lastMessage: 'Handed back.',
      agent: { id: 'fx1', type: 'ravenseat:track', transcript: '/fixture/home/.claude/projects/-fixture-work/s-hook/subagents/agent-fx1.jsonl' },
    },
    StopFailure: { error: 'rate_limit' },
    SessionStart: { source: 'compact' },
    SessionEnd: { reason: 'clear' },
    Notification: { notification: 'permission_prompt' },
  };

  it('covers every event the expectations name, and no more', () => {
    expect(Object.keys(H.payloads).sort()).toEqual(Object.keys(per).sort());
  });

  it.each(Object.keys(per))('hooks.json %s: read() in the core names', (event) => {
    const h = HK.read(H.payloads[event]);
    expect(h, event).toMatchObject({ event, ...common, ...per[event] });
    expect(h.raw).toBe(H.payloads[event]);
  });

  it('hooks.json statusline: status() in the core names', () => {
    expect(HK.status(H.statusline)).toEqual({
      session: 's-hook',
      cwd: '/fixture/work',
      workspace: { current_dir: '/fixture/work', project_dir: '/fixture/work' },
      model: { id: 'claude-opus-5-5', display_name: 'Opus 5.5' },
      context: { total_input_tokens: 120000, context_window_size: 1000000, used_percentage: 12 },
      cost: { total_cost_usd: 1.25, total_duration_ms: 60000, total_api_duration_ms: 30000 },
      limits: H.statusline.rate_limits,
      raw: H.statusline,
    });
  });

  it('hooks.json SubagentStop: the track guard finds the subagent file the payload names', () => {
    const p = H.payloads.SubagentStop;
    expect(TG.subagentTranscript(HK.read(p), (x: string) => x === p.agent_transcript_path)).toBe(p.agent_transcript_path);
    expect(KV.hasEndLine({ lastMessage: HK.read(p).lastMessage })).toBe(false);
  });
});

describe('readers on the fixtures', () => {
  // usageLimit: only a rejected quota is the limit; a warning, a plain 429 and an overload are not.
  const limits: Record<string, Record<string, unknown>> = {
    [PRE]: { 'fx-api-error-usage-limit': { resetsAt: 1_900_000_000, type: 'five_hour' } },
    [NOW]: { 'fx-api-error-system-usage-limit': { resetsAt: null, type: null } },
  };
  it.each(FILES)('usageLimit.fromEntry on %s: only the usage limit row is a limit', (f) => {
    for (const r of rows(f)) expect(UL.fromEntry(r), `${f} ${r.uuid}`).toEqual(limits[f][r.uuid] ?? null);
  });

  it.each(FILES)('usageLimit.fromTranscriptTail on %s: the last assistant or API error row decides', (f) => {
    for (const r of rows(f)) expect(UL.fromTranscriptTail(upTo(f, r.uuid)), `${f} up to ${r.uuid}`).toEqual(limits[f][r.uuid] ?? null);
    // A half line written after the limit does not hide it.
    const [label] = Object.keys(limits[f]);
    expect(UL.fromTranscriptTail(`${upTo(f, label)}\n{"type":"assis`)).toEqual(limits[f][label]);
  });

  it('usageLimit.decide with the StopFailure payload and the fixture tails', () => {
    const H = JSON.parse(fs.readFileSync(path.join(DIR, 'hooks.json'), 'utf8'));
    const input = HK.read(H.payloads.StopFailure);
    const now = Date.parse('2026-11-17T12:00:00.000Z');
    expect(UL.decide(input, { tail: upTo(PRE, 'fx-api-error-usage-limit'), now })).toMatchObject({
      source: 'transcript',
      type: 'five_hour',
      until: new Date(1_900_000_000 * 1000).toISOString(),
    });
    expect(UL.decide(input, { tail: upTo(NOW, 'fx-api-error-system-usage-limit'), now })).toMatchObject({ source: 'default', type: null });
    // A plain 429 is no limit; with the status line window at 100 % it is.
    expect(UL.decide(input, { tail: upTo(NOW, 'fx-api-error-system-plain-429'), now })).toBeNull();
    const observed = HK.status(H.statusline).limits;
    expect(UL.decide(input, { tail: upTo(PRE, 'fx-api-error-plain-429'), observed, now })).toMatchObject({ source: 'statusline', type: 'five_hour' });
  });

  it.each(FILES)('results, contextGuard, trackGuard and approvalWait on %s', (f) => {
    const all = text(f);
    expect(R.lastAnswer(all), f).toBe('RESULT status=DONE fixture');
    expect(R.lastAnswer(upTo(f, 'fx-turn1-thinking-text')), f).toBe('Looking at the fixture.');
    expect(KV.countCompactions(all), f).toBe(1);
    expect(KV.hasEndLine({ text: all }), f).toBe(true);
    expect(KV.hasEndLine({ text: upTo(f, 'fx-repl-result') }), f).toBe(false);
    expect(AW.pendingToolUse(upTo(f, 'fx-repl')), f).toEqual({ id: f === PRE ? 'toolu_pre_3' : 'toolu_317_3', tool: 'REPL' });
    expect(AW.pendingToolUse(upTo(f, 'fx-repl-result')), f).toBeNull();
    // The context is the last assistant usage (input + cache read + cache written); null right after a compaction.
    expect(TG.lastContext(upTo(f, 'fx-compaction')), f).toBeNull();
    expect(TG.lastContext(upTo(f, 'fx-repl')), f).toBe(f === PRE ? 1202 : 2101);
    expect(TG.lastContext(all), f).toBe(f === PRE ? 3011 : 1501);
  });

  it.each(FILES)('turnTools.transcriptStats on %s: turns, tool results and sizes', (f) => {
    const d = T.analyzeTranscript(text(f), { detail: true }).detail;
    const s = TT.transcriptStats(d, { thresholdTokens: 2000 });
    expect(s, f).toMatchObject({ transcripts: 1, turns: 5, hist: { 0: 2, 1: 2, 2: 1 }, toolTurns: 3, parallelTurns: 1 });
    expect(s.tools, f).toEqual(
      f === PRE
        ? { Bash: { results: 1, chars: 5, sizes: [5] }, Edit: { results: 1, chars: 28, sizes: [28] }, REPL: { results: 1, chars: 1, sizes: [1] } }
        : { Read: { results: 1, chars: 1, sizes: [1] }, Bash: { results: 1, chars: 11, sizes: [11] }, REPL: { results: 1, chars: 1, sizes: [1] } },
    );
    expect([s.above.turns, s.below.turns], f).toEqual(f === PRE ? [2, 3] : [3, 2]);
  });
});
