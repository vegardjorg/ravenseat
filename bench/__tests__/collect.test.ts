// =============================================================
// collect.test.ts: transcript analysis, pricing, the time log split, session classification, the full join of a
// synthetic experiment and the transcript folder walk (bench/lib/collect.js, bench/lib/prices.js).
// =============================================================
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as FX from './fixtures';

const C = require('../lib/collect.js') as Record<string, any>;
const P = require('../lib/prices.js') as Record<string, any>;
const tmp: string[] = [];
afterAll(() => tmp.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const records = () =>
  C.build(FX.manifest(), {
    queue: FX.queue(),
    timeRows: C.readJsonl(FX.timeRows().map((r) => JSON.stringify(r)).join('\n')),
    transcripts: FX.transcriptFiles().map((t) => ({ ...t, analysis: C.analyzeSession(t.text) })),
    load: FX.loadRows(),
    human: [
      { time: FX.at(2100), task: 'Y-1', minutes: 12 },
      { time: FX.at(2101), arm: 'manual', minutes: 6 },
    ],
  });

describe('analyzeSession', () => {
  it('counts a streamed message once, keeps tokens per model, finds the label, peak context and compactions', () => {
    const text = [
      JSON.stringify({ type: 'user', timestamp: FX.at(0), message: { content: 'Read prompt-Q-7.md' } }),
      FX.turn('m1', 1, { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 }),
      FX.turn('m1', 1, { input_tokens: 10, output_tokens: 50, cache_read_input_tokens: 100 }),
      FX.turn('m2', 2, { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 500, cache_creation_input_tokens: 20 }, 'cheap-model'),
      JSON.stringify({ type: 'system', subtype: 'compact_boundary', timestamp: FX.at(3) }),
      'not json',
    ].join('\n');
    const a = C.analyzeSession(text);
    expect(a.turns).toBe(2);
    expect(a.label).toBe('Q-7');
    expect(a.compactions).toBe(1);
    expect(a.peak_context).toBe(521);
    expect(a.duration_s).toBe(180);
    expect(a.tokens_by_model['claude-opus-5-5'].output).toBe(50);
    expect(a.tokens_by_model['cheap-model'].cache_written_5m).toBe(20);
  });
});

describe('prices', () => {
  it('matches a model id by its longest known prefix and flags an unknown model as assumed', () => {
    expect(P.priceFor('claude-opus-5-5-20301231').assumed).toBe(false);
    expect(P.priceFor('mystery').assumed).toBe(true);
    const t = P.priceTable({ cheap: { input: 1, output: 5, cache_read: 0.1, cache_5m: 1.25, cache_1h: 2 } });
    expect(P.costUsd({ output: 1_000_000 }, 'cheap', t).usd).toBe(5);
    expect(P.costUsd({ cache_read: 1_000_000, output: 1000 }, 'claude-opus-5-5').usd).toBeCloseTo(FX.TURN_USD, 10);
  });
});

describe('parseTimeLog', () => {
  it('keeps the last cumulative done row per agent and splits gate runs, gate steps and compactions', () => {
    const rows = C.readJsonl(
      [
        { time: FX.at(0), event: 'start', agent_id: 'abc123456789xyz', agent_type: 'track', track: 'abc123456789' },
        { time: FX.at(5), event: 'done', agent_id: 'abc123456789xyz', track: 'X-1', tokens: { output: 10 } },
        { time: FX.at(9), event: 'done', agent_id: 'abc123456789xyz', track: 'X-1', tokens: { output: 30 } },
        { tid: FX.at(9), hendelse: 'kompakt', okt_id: 's1', pre_tokens: 260000 },
        ...FX.timeRows(),
      ]
        .map((r) => JSON.stringify(r))
        .join('\n'),
    );
    const t = C.parseTimeLog(rows);
    expect(t.agents).toHaveLength(1);
    expect(t.agents[0]).toMatchObject({ agent_type: 'track', label: 'X-1', start: FX.at(0), tokens: { output: 30 } });
    expect(t.gates).toHaveLength(3);
    expect(t.gates[1]).toMatchObject({ mode: 'quick', rerun_nr: 1, green: true, concurrent_gates: 2 });
    expect(t.gateSteps[0].timeout).toBe(true);
    expect(t.compactions).toEqual([
      { time: FX.at(9), scope: null, session_id: 's1', agent_id: null, track: null, orchestrator: null, compactions: null, pre_tokens: 260000 },
    ]);
  });
});

describe('classify', () => {
  it('sorts sessions into the session types', () => {
    const c = (s: any, o: any = {}) => C.classify({ kind: 'subagent', ...s }, o);
    expect(c({ agent_type: 'track' })).toBe('track');
    expect(c({ agent_type: 'track-d', label: 'A-1-r2' })).toBe('fix');
    expect(c({ agent_type: 'security-rls' })).toBe('reviewer');
    expect(c({ agent_type: 'reviewer-docs' })).toBe('helper');
    expect(c({ agent_type: 'Explore' })).toBe('planning');
    expect(c({ agent_type: 'general-purpose', label: 'A-1' })).toBe('helper');
    expect(c({ agent_type: 'general-purpose' }, { overrides: { 'general-purpose': 'track' } })).toBe('track');
    expect(C.classify({ kind: 'main', id: 'm' }, { spawnsBuild: new Set(['m']) })).toBe('orchestrator');
    expect(C.classify({ kind: 'main', id: 'm' }, { manualSessions: new Set(['m']) })).toBe('track');
    expect(C.classify({ kind: 'main', id: 'm' })).toBe('planning');
  });
});

describe('build (synthetic experiment)', () => {
  it('links sessions to tasks and arms, prices them and marks fix rounds and cancelled work', () => {
    const r = records();
    const by = (id: string) => r.sessions.find((s: any) => s.id === id);
    expect(by('orch-1')).toMatchObject({ arm: 'cq', session_type: 'orchestrator', task: null, compactions: 1 });
    expect(by('orch-1').usd).toBeCloseTo(10 * FX.TURN_USD, 6);
    expect(by('a1')).toMatchObject({ arm: 'cq', task: 'X-1', session_type: 'track', agent_type: 'track' });
    expect(by('a3')).toMatchObject({ task: 'X-2', session_type: 'reviewer' });
    expect(by('a4')).toMatchObject({ task: 'X-2', session_type: 'fix' });
    expect(by('chat-y1')).toMatchObject({ arm: 'manual', task: 'Y-1', session_type: 'track', cancelled: false });
    expect(by('chat-y2')).toMatchObject({ arm: 'manual', task: 'Y-2', cancelled: true });
    expect(r.tasks.find((t: any) => t.id === 'Y-2').outcome).toBe('abandoned');
    expect(r.tasks.find((t: any) => t.id === 'X-1')).toMatchObject({ outcome: 'merged', wall_min: 55, build_min: 40, queue_usd: 1.1 });
  });

  it('joins gate runs to tasks and to the nearest load sample', () => {
    const r = records();
    expect(r.gates.map((g: any) => g.task)).toEqual(['X-1', 'X-1', 'X-2']);
    expect(r.gates[2]).toMatchObject({ arm: 'cq', sample_running_tracks: 10, sample_free_memory_pct: 8 });
    expect(r.gateSteps[0]).toMatchObject({ task: 'X-2', timeout: true });
  });

  it('a second build agent on the same task without a fix label is also a fix round', () => {
    const files = FX.transcriptFiles().filter((t) => t.id !== 'a4');
    files.push({ id: 'a5', kind: 'subagent', parent: 'orch-1', meta: { agentType: 'track' }, text: FX.transcript('X-1', 1, { startMin: 50 }) });
    const r = C.build(FX.manifest(), {
      queue: FX.queue(),
      transcripts: files.map((t) => ({ ...t, analysis: C.analyzeSession(t.text) })),
    });
    expect(r.sessions.find((s: any) => s.id === 'a1').session_type).toBe('track');
    expect(r.sessions.find((s: any) => s.id === 'a5').session_type).toBe('fix');
  });

  it('uses time log agents only when there is no transcript, and warns about gaps', () => {
    const rows = C.readJsonl(JSON.stringify({ time: FX.at(5), event: 'done', agent_id: 'zz', agent_type: 'reviewer', track: 'X-1', tokens: { output: 1_000_000 }, model: 'unpriced' }));
    const r = C.build(FX.manifest(), { queue: null, timeRows: rows });
    expect(r.sessions).toHaveLength(1);
    expect(r.sessions[0]).toMatchObject({ source: 'timeLog', task: 'X-1', session_type: 'reviewer', assumed_price: true });
    const w = r.warnings.join('\n');
    expect(w).toMatch(/no queue file/);
    expect(w).toMatch(/no price for model\(s\) unpriced/);
    expect(w).toMatch(/no gate run rows/);
    expect(w).toMatch(/no load samples/);
  });

  it('a replayed task takes no status or cost from the queue; its outcome comes from the manifest', () => {
    const m: any = FX.manifest();
    m.tasks.push({ id: 'X-1', label: 'X-1-R', arm: 'manual', pair: null, stratum: 'K', replay: { base: 'abc' }, sessions: [], outcome: 'merged' });
    const r = C.build(m, { queue: FX.queue() });
    const t = r.tasks.find((x: any) => x.label === 'X-1-R');
    expect(t).toMatchObject({ replay: true, outcome: 'merged', queue_usd: null, wall_min: null, class: 'K' });
  });
});

describe('files', () => {
  it('listTranscripts finds main sessions and subagents with their meta', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-tr-'));
    tmp.push(d);
    fs.writeFileSync(path.join(d, 's1.jsonl'), FX.transcript(null, 1));
    fs.mkdirSync(path.join(d, 's1', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(d, 's1', 'subagents', 'agent-a9.jsonl'), FX.transcript('X-1', 1));
    fs.writeFileSync(path.join(d, 's1', 'subagents', 'agent-a9.meta.json'), JSON.stringify({ agentType: 'track' }));
    fs.writeFileSync(path.join(d, 'notes.txt'), 'x');
    const list = C.listTranscripts(d).sort((a: any, b: any) => a.id.localeCompare(b.id));
    expect(list.map((x: any) => [x.kind, x.id, x.parent, x.meta?.agentType ?? null])).toEqual([
      ['subagent', 'a9', 's1', 'track'],
      ['main', 's1', null, null],
    ]);
    expect(C.listTranscripts(path.join(d, 'missing'))).toEqual([]);
    expect(C.listTranscripts(d, { from: Date.now() + 86400000 })).toEqual([]);
  });

  it('parseReverts keeps only revert commits', () => {
    const r = C.parseReverts('aaa\t2030-01-01T00:00:00Z\tRevert "X-2: add table"\nbbb\t2030-01-01T00:00:00Z\tX-3: other\n');
    expect(r).toEqual([{ sha: 'aaa', time: '2030-01-01T00:00:00Z', subject: 'Revert "X-2: add table"' }]);
  });
});
