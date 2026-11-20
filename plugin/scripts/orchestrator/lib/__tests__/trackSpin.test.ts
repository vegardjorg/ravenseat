// =============================================================
// trackSpin.test.ts: SPINNING, a running track that is busy without real work (roadmap 0æ N3).
//
// The client adapter says which calls are work (lib/clients/claude/work.js callKind); the core (lib/trackSpin.js)
// finds the newest work in a transcript and the tracks whose newest work is older than limits.spinMin while they still
// make calls. Shown from the start, a Decisions card only after SPIN_CARD_MIN, never a stop. Synthetic data only.
// =============================================================
import { describe, it, expect, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const W = require('../clients/claude/work.js') as { callKind: (c: unknown) => { kind: string; key?: string }; onlySleeps: (c: string) => boolean };
const S = require('../trackSpin.js') as any;
const T = require('../queueBoard.js') as { board: (q: unknown, o?: unknown) => any };
const D = require('../queueDecisions.js') as { decisions: (inbox: unknown) => any[] };

const NOW = Date.parse('2026-11-20T10:00:00.000Z');
const ago = (min: number) => NOW - min * 60_000;
const call = (name: string, input: Record<string, unknown> = {}) => ({ kind: 'tool', name, input });
const ev = (min: number, ...tools: unknown[]) => ({ at: ago(min), tools });
const track = (id: string, startedMin = 120) => ({
  id,
  status: 'running',
  class: 'K',
  branch: `queue/${id}`,
  started: new Date(ago(startedMin)).toISOString(),
});

describe('callKind (the client adapter)', () => {
  it('sorts the calls into bookkeeping, waiting, reads and work', () => {
    expect(W.callKind(call('TodoWrite')).kind).toBe('bookkeeping');
    expect(W.callKind(call('ToolSearch')).kind).toBe('bookkeeping');
    expect(W.callKind(call('mcp__ccd_turn__update_plan')).kind).toBe('bookkeeping');
    expect(W.callKind(call('Monitor')).kind).toBe('wait');
    expect(W.callKind(call('Bash', { command: 'sleep 30' })).kind).toBe('wait');
    expect(W.callKind(call('PowerShell', { command: 'Start-Sleep -Seconds 20; echo done' })).kind).toBe('wait');
    expect(W.callKind(call('Read', { file_path: '/a.js' }))).toEqual({ kind: 'read', key: 'Read:{"file_path":"/a.js"}' });
    expect(W.callKind(call('Bash', { command: 'git status' })).kind).toBe('read');
    expect(W.callKind(call('Edit', { file_path: '/a.js' })).kind).toBe('work');
    expect(W.callKind(call('Bash', { command: 'npx vitest run x' })).kind).toBe('work');
    expect(W.callKind(call('Bash', { command: 'sleep 5 && npm test' })).kind).toBe('work');
    expect(W.callKind(null).kind).toBe('work');
  });
});

describe('spinOf', () => {
  it('counts the first read as work and a repeat, bookkeeping and waiting as empty calls', () => {
    const read = call('Read', { file_path: '/a.js' });
    const m = S.spinOf(
      [ev(40, call('Edit')), ev(30, read), ev(25, read), ev(20, call('TodoWrite')), ev(10, call('Bash', { command: 'sleep 60' })), { at: null, tools: [call('Edit')] }],
      { classify: W.callKind },
    );
    expect(m).toEqual({ lastWorkMs: ago(30), emptyAfter: 3, lastCallMs: ago(10) });
  });

  it('a classify that throws counts as work, never a false SPINNING', () => {
    const m = S.spinOf([ev(5, call('X'))], { classify: () => { throw new Error('x'); } });
    expect(m.lastWorkMs).toBe(ago(5));
    expect(m.emptyAfter).toBe(0);
  });
});

describe('spinningTracks', () => {
  const busy = { lastWorkMs: ago(30), emptyAfter: 5, lastCallMs: ago(1) };
  const find = (measures: Record<string, unknown>, extra: Record<string, unknown> = {}, queue: unknown = {}) =>
    S.spinningTracks(queue, { candidates: [track('A'), track('B', 10)], measures, now: NOW, ...extra });

  it('flags a busy track whose newest work is older than the limit', () => {
    expect(find({ A: busy })).toEqual([
      { id: 'A', branch: 'queue/A', spinning_ms: 30 * 60_000, empty_calls: 5, last_work: new Date(ago(30)).toISOString() },
    ]);
  });

  it('leaves out a new track, a recent commit, a quiet track, too few calls, a skipped track and limit 0', () => {
    expect(find({ B: { ...busy, lastWorkMs: null } })).toEqual([]); // started 10 min ago: the start counts as work
    expect(find({ A: busy }, { lastCommit: { A: ago(5) } })).toEqual([]);
    expect(find({ A: { ...busy, lastCallMs: ago(20) } })).toEqual([]); // quiet: SILENT judges it
    expect(find({ A: { ...busy, emptyAfter: 2 } })).toEqual([]);
    expect(find({ A: busy }, { skip: new Set(['A']) })).toEqual([]);
    expect(find({ A: busy }, {}, { limits: { spinMin: 0 } })).toEqual([]);
    expect(find({ A: busy }, {}, { limits: { spinMin: 45 } })).toEqual([]);
    expect(S.spinMinFor({})).toBe(S.SPIN_DEFAULT_MIN);
  });

  it('spinLines says nothing when all is well and never stops anything', () => {
    expect(S.spinLines([])).toEqual([]);
    const lines = S.spinLines(find({ A: busy }), { cli: 'rs' });
    expect(lines[0]).toContain('Nothing is stopped');
    expect(lines[1]).toContain('A  queue/A  no work for 30 min, 5 empty call(s)');
  });
});

describe('measure (a real transcript through the adapter)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spin-'));
  afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('reads the tail and measures it', () => {
    const row = (min: number, name: string, input: Record<string, unknown>) =>
      JSON.stringify({
        type: 'assistant',
        timestamp: new Date(ago(min)).toISOString(),
        message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${min}`, name, input }] },
      });
    const file = path.join(dir, 'a.jsonl');
    fs.writeFileSync(file, [row(40, 'Write', { file_path: '/x' }), row(9, 'TodoWrite', {}), row(8, 'ToolSearch', {}), row(2, 'Bash', { command: 'sleep 30' })].join('\n') + '\n');
    expect(S.measure(file)).toEqual({ lastWorkMs: ago(40), emptyAfter: 3, lastCallMs: ago(2) });
    expect(S.measure(path.join(dir, 'missing.jsonl'))).toBeNull();
  });
});

describe('the Decisions card (only after an hour)', () => {
  const cards = (min: number) =>
    D.decisions(T.board({ tasks: [track('A', 180)], limits: {} }, { now: NOW, spinning: [{ id: 'A', branch: 'queue/A', spinning_ms: min * 60_000, empty_calls: 7 }] }).inbox);

  it('a short spin stays off the cards; a long one gets the SILENT choices', () => {
    expect(cards(30)).toEqual([]);
    const [card] = cards(S.SPIN_CARD_MIN);
    expect(card).toMatchObject({ kind: 'stuck-spinning', heading: 'SPINNING', id: 'A' });
    expect(card.options.map((x: { label: string }) => x.label)).toEqual(['Seen', 'Put it back in the queue']);
    expect(card.context.join(' ')).toContain('Nothing was stopped');
  });
});
