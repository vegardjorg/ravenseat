// =============================================================
// sinceSettings.test.ts: the two "Since you left" settings (roadmap 3e AW-2, plans/borte-flate-vurdering-2026-11-21.md
// section 5): board.sinceLast (on, Basic) and board.sinceLastWindow (last-seen | 24h | 7d, Advanced).
//
// Locks: the STANDARD defaults, on in lite too; boardSince reads only real values (a wrong kind falls back); each has a
// registry row in Board and advice that weakens nothing; queue.md's settings table names both with their defaults; and
// "Decided" (queueDecisions.decidedToday) takes a window start instead of local midnight (AW-8).
// =============================================================
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const KK = require('../queueConfig.js') as any;
const R = require('../settingsRegistry.js') as any;
const DEC = require('../queueDecisions.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports */

const resolved = (own: object) => KK.resolveOwn(KK.merge(KK.STANDARD, own), own);

describe('the Since you left settings', () => {
  it('are on, since last seen, in STANDARD and in lite', () => {
    expect(KK.STANDARD.board.sinceLast).toBe(true);
    expect(KK.STANDARD.board.sinceLastWindow).toBe('last-seen');
    expect(KK.boardSince(resolved({}))).toEqual({ on: true, window: 'last-seen' });
    expect(KK.boardSince(resolved({ mode: 'lite' }))).toEqual({ on: true, window: 'last-seen' });
    expect(KK.boardSince(null)).toEqual({ on: true, window: 'last-seen' });
  });

  it('read only real values', () => {
    expect(KK.boardSince(resolved({ board: { sinceLast: false, sinceLastWindow: '7d' } }))).toEqual({ on: false, window: '7d' });
    expect(KK.boardSince(resolved({ board: { sinceLast: 'no', sinceLastWindow: 'week' } }))).toEqual({ on: true, window: 'last-seen' });
  });

  it('have registry rows in Board and advice', () => {
    const on = R.rowFor('board.sinceLast');
    expect(on).toMatchObject({ category: 'board', type: 'onoff', level: 'basic', weakens: null });
    const w = R.rowFor('board.sinceLastWindow');
    expect(w).toMatchObject({ category: 'board', type: 'choice', level: 'advanced', weakens: null });
    expect(w.choices).toEqual(['last-seen', '24h', '7d']);
  });

  it('are in the settings table of queue.md', () => {
    const doc = readFileSync(join(__dirname, '..', '..', '..', '..', 'docs', 'queue.md'), 'utf8');
    expect(doc).toMatch(/\| `board\.sinceLast` \| `true` \|/);
    expect(doc).toMatch(/\| `board\.sinceLastWindow` \| `last-seen` \|/);
  });
});

describe('Decided takes the window (AW-8)', () => {
  const now = Date.parse('2026-11-22T07:00:00.000Z');
  const queue = {
    tasks: [{ id: 'EX-1', approved: '2026-11-21T22:00:00.000Z' }],
    resolutions: { Q1: { time: '2026-11-21T23:30:00.000Z', answer: 'yes', by: 'owner' } },
  };

  it('from a window start, last night counts', () => {
    const list = DEC.decidedToday(queue, { now, from: Date.parse('2026-11-21T21:00:00.000Z') });
    expect(list.map((d: { id: string }) => d.id)).toEqual(['Q1', 'EX-1']);
  });

  it('without one, it is still today from local midnight', () => {
    const list = DEC.decidedToday(queue, { now: Date.parse('2026-11-22T23:00:00.000Z') });
    expect(list).toEqual([]);
  });
});
