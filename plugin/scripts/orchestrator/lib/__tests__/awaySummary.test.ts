// =============================================================
// awaySummary.test.ts: the "Since you left" join in lib/awaySummary.js (roadmap 3e, AW-1).
//
// Locks: the window rule (since last seen, 24 h, 7 days; a missing or too old mark falls back to 24 h and says so);
// the numbers (merged, recovered without the owner, blocked now, waiting on you, spend, longest stretch) on the same
// rules as lib/eventStatistics.js; the event list (newest first, failures marked, only ids, kinds, codes and times, never
// question or answer text); the empty answer when nothing happened; the CLI lines with "not read" instead of an empty
// part.
// =============================================================
import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const AW = require('../awaySummary.js');

const H = 3_600_000;
const NOW = Date.parse('2026-11-22T07:00:00.000Z');
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * H).toISOString();

/** A night: the queue starts at 21:40 (9 h 20 min ago), three tasks merge, one needs a fix round, one waits on the owner. */
function night() {
  const queue = {
    tasks: [
      { id: 'EX-1', status: 'done', started: at(9), delivered: at(8), done: at(7.5) },
      {
        id: 'EX-2',
        status: 'done',
        started: at(8),
        delivered: at(6),
        done: at(5),
        resumed: [{ reason: 'fix', round: 1, time: at(6.5) }],
      },
      { id: 'EX-3', status: 'done', started: at(4), done: at(3), external: true },
      { id: 'EX-4', status: 'waiting', waiting_on: ['Q1'], blocks: [{ code: 'merge-conflict', from: at(2) }] },
      { id: 'EX-5', status: 'done', started: at(30), done: at(28) },
      { id: 'EX-6', status: 'waiting', blocks: [{ code: 'dependency', from: at(1) }] },
    ],
    question: { Q1: { type: 'question', text: 'Secret owner text', added_at: at(2.5) } },
    resolutions: { Q0: { time: at(1.5), answer: 'private answer', by: 'owner' } },
    changelog: [],
  };
  const rows = [
    { time: at(9.3), event: 'queue-start', command: 'fill', running: 0 },
    { time: at(7), event: 'gate', track: 'EX-2', kind: 'quick', ok: false, failed: ['npm test'], attempt: 1 },
    { time: at(6.9), event: 'gate', track: 'EX-2', kind: 'quick', ok: true, failed: [], attempt: 2 },
    { time: at(6.5), event: 'fixRound', task: 'EX-2', reason: 'fix', round: 1 },
    { time: at(4.9), event: 'baseGate', tip: 'abc', ok: false, made_red_by: 'EX-2' },
    { time: at(4), event: 'push', remote: 'origin', branch: 'main', task_count: 2, tip: 'def' },
    { time: at(3.9), event: 'ciWatch', sha: 'def', verdict: 'check', red: 1 },
    { time: at(2), event: 'mergeConflict', task: 'EX-4', files: 2 },
    { time: at(0.5), event: 'queue-idle', since: at(9.3), duration_s: 31_000 },
    { time: at(9), event: 'session', session_id: 's1', usd: 2, orchestrator: true },
    { time: at(1), event: 'session', session_id: 's1', usd: 5.5, orchestrator: true },
    { time: at(40), event: 'gate', track: 'EX-5', kind: 'quick', ok: false, failed: ['lint'] },
  ];
  return { queue, rows };
}

describe('the window', () => {
  it('since last seen uses the mark', () => {
    const w = AW.resolveWindow({ choice: 'last-seen', seen: { at: at(9.5), by: 'board' }, now: NOW });
    expect(w).toMatchObject({ choice: 'last-seen', used: 'last-seen', from: NOW - 9.5 * H, to: NOW, note: null });
  });

  it('falls back to 24 h without a mark, and says so', () => {
    const w = AW.resolveWindow({ choice: 'last-seen', seen: null, now: NOW });
    expect(w).toMatchObject({ used: '24h', from: NOW - 24 * H, to: NOW });
    expect(w.note).toMatch(/no seen mark/);
  });

  it('falls back to 24 h when the mark is older than 7 days or in the future', () => {
    expect(AW.resolveWindow({ choice: 'last-seen', seen: { at: at(8 * 24) }, now: NOW })).toMatchObject({ used: '24h' });
    expect(AW.resolveWindow({ choice: 'last-seen', seen: { at: at(8 * 24) }, now: NOW }).note).toMatch(/7 days/);
    expect(AW.resolveWindow({ choice: 'last-seen', seen: { at: at(-1) }, now: NOW })).toMatchObject({ used: '24h' });
    expect(AW.resolveWindow({ choice: 'last-seen', seen: { at: 'not a time' }, now: NOW })).toMatchObject({ used: '24h' });
  });

  it('24 h and 7 days are fixed; an unknown choice is last-seen', () => {
    expect(AW.resolveWindow({ choice: '24h', seen: { at: at(2) }, now: NOW })).toMatchObject({ used: '24h', from: NOW - 24 * H });
    expect(AW.resolveWindow({ choice: '7d', now: NOW })).toMatchObject({ used: '7d', from: NOW - 7 * 24 * H });
    expect(AW.resolveWindow({ choice: 'week', seen: { at: at(3) }, now: NOW })).toMatchObject({ choice: 'last-seen', used: 'last-seen' });
    expect(AW.WINDOWS).toEqual(['last-seen', '24h', '7d']);
  });

  it('an explicit start (the board keeps its window for the visit) wins when it is inside 7 days', () => {
    expect(AW.resolveWindow({ choice: 'last-seen', from: NOW - 3 * H, seen: { at: at(1) }, now: NOW })).toMatchObject({
      used: 'last-seen',
      from: NOW - 3 * H,
    });
    expect(AW.resolveWindow({ choice: 'last-seen', from: NOW - 9 * 24 * H, now: NOW })).toMatchObject({ used: '24h' });
  });

  it('says the window in words', () => {
    const w = AW.resolveWindow({ choice: 'last-seen', seen: { at: at(9.5) }, now: NOW });
    expect(AW.windowText(w)).toMatch(/^since .+ \(9 h 30 min\)$/);
    expect(AW.windowText(AW.resolveWindow({ choice: '24h', now: NOW }))).toBe('last 24 hours');
    expect(AW.windowText(AW.resolveWindow({ choice: '7d', now: NOW }))).toBe('last 7 days');
  });
});

describe('the numbers', () => {
  it('counts the night on the statistics rules', () => {
    const { queue, rows } = night();
    const s = AW.awaySummary({ queue, rows, from: NOW - 10 * H, to: NOW, waiting: 3 });
    // EX-1, EX-2 merged; EX-3 is external, EX-5 merged before the window.
    expect(s.counts.merged).toBe(2);
    // EX-2's fix round, no owner action on it.
    expect(s.counts.recovered).toBe(1);
    // EX-4 has an open stuck blocker; EX-6 waits on a dependency, which is normal waiting.
    expect(s.counts.blocked).toBe(1);
    expect(s.counts.waiting).toBe(3);
    // The session grew from 2 to 5.5 inside the window: the first reading counts whole (as sessionCosts).
    expect(s.counts.spend_usd).toBe(5.5);
    expect(s.counts.longest_stretch_h).toBeGreaterThan(0);
    expect(s.empty).toBe(false);
  });

  it('spend is null without session rows, waiting null when not given', () => {
    const { queue } = night();
    const s = AW.awaySummary({ queue, rows: [], from: NOW - 10 * H, to: NOW });
    expect(s.counts.spend_usd).toBeNull();
    expect(s.counts.waiting).toBeNull();
  });
});

describe('the event list', () => {
  it('is newest first, only in the window, with failures marked', () => {
    const { queue, rows } = night();
    const s = AW.awaySummary({ queue, rows, from: NOW - 10 * H, to: NOW, max: 50 });
    const times = s.events.map((e: { time: string }) => Date.parse(e.time));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(times.every((x: number) => x >= NOW - 10 * H && x <= NOW)).toBe(true);
    const kinds = s.events.map((e: { kind: string }) => e.kind);
    for (const k of ['queue-start', 'started', 'gate-red', 'fix-round', 'base-red', 'merged', 'push', 'ci-red', 'conflict', 'blocked', 'question', 'answered', 'queue-idle'])
      expect(kinds).toContain(k);
    // The green gate rerun and the old red gate are not events.
    expect(s.events.filter((e: { kind: string }) => e.kind === 'gate-red')).toHaveLength(1);
    const fails = s.events.filter((e: { fail: boolean }) => e.fail).map((e: { kind: string }) => e.kind);
    expect(fails.sort()).toEqual(['base-red', 'blocked', 'ci-red', 'conflict', 'gate-red'].sort());
    // A merged external task is not an event either.
    expect(s.events.some((e: { task: string | null; kind: string }) => e.task === 'EX-3' && e.kind === 'merged')).toBe(false);
  });

  it('never carries question or answer text', () => {
    const { queue, rows } = night();
    const s = AW.awaySummary({ queue, rows, from: NOW - 10 * H, to: NOW, max: 50 });
    const all = JSON.stringify(s);
    expect(all).not.toMatch(/Secret owner text/);
    expect(all).not.toMatch(/private answer/);
    expect(s.events.find((e: { kind: string }) => e.kind === 'question')).toMatchObject({ task: 'EX-4', ref: 'Q1' });
  });

  it('keeps the newest `max` and counts the rest', () => {
    const { queue, rows } = night();
    const s = AW.awaySummary({ queue, rows, from: NOW - 10 * H, to: NOW, max: 3 });
    expect(s.events).toHaveLength(3);
    expect(s.total_events).toBeGreaterThan(3);
    expect(s.more).toBe(s.total_events - 3);
    expect(s.events[0].kind).toBe('queue-idle');
  });

  it('is empty when nothing happened in the window', () => {
    const { queue, rows } = night();
    const s = AW.awaySummary({ queue, rows, from: NOW - 0.2 * H, to: NOW, waiting: 0 });
    expect(s.empty).toBe(true);
    expect(s.events).toEqual([]);
  });

  it('survives a broken queue and rows', () => {
    const s = AW.awaySummary({ queue: null, rows: [null, { event: 'gate' }, { time: 'x', event: 'push' }], from: 0, to: NOW });
    expect(s.empty).toBe(true);
    expect(s.counts.merged).toBe(0);
  });
});

describe('the CLI lines', () => {
  it('gives four parts and the event list', () => {
    const { queue, rows } = night();
    const w = AW.resolveWindow({ choice: 'last-seen', seen: { at: at(10) }, now: NOW });
    const s = AW.awaySummary({ queue, rows, from: w.from, to: w.to, waiting: 1, max: 20 });
    const text = AW.summaryLines(s, w).join('\n');
    expect(text).toMatch(/^Since you left: since .+/);
    expect(text).toMatch(/Done: 2 merged, 1 recovered without you/);
    expect(text).toMatch(/Stuck: 1 blocked now/);
    expect(text).toMatch(/Waiting on you: 1/);
    expect(text).toMatch(/Spend: \$5\.50/);
    expect(text).toMatch(/x EX-2 quick gate red: npm test/);
  });

  it('says "not read" instead of an empty part', () => {
    const { queue } = night();
    const w = AW.resolveWindow({ choice: '24h', now: NOW });
    const s = AW.awaySummary({ queue, rows: [], from: w.from, to: w.to });
    const text = AW.summaryLines(s, w).join('\n');
    expect(text).toMatch(/not read: spend -> no session cost rows in the window/);
    expect(text).toMatch(/not read: waiting on you ->/);
  });

  it('is one line when nothing ran', () => {
    const w = AW.resolveWindow({ choice: 'last-seen', seen: null, now: NOW });
    const s = AW.awaySummary({ queue: { tasks: [] }, rows: [], from: w.from, to: w.to, waiting: 0 });
    const lines = AW.summaryLines(s, w);
    expect(lines[0]).toMatch(/^Nothing ran since /);
    expect(lines.join('\n')).toMatch(/no seen mark/);
  });
});
