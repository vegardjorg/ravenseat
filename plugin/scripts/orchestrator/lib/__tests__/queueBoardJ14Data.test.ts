// =============================================================
// queueBoardJ14Data.test.ts: the server side of the board's tab count, shortcuts and quick filters (roadmap 0ø J1, J3,
// J4; plans/jira-vurdering-2026-11-18.md, owner answers 18.11 as recommended).
//
// Locks: (1) the three display settings have their STANDARD defaults (all on), lite turns quickFilters off unless the
// file sets it, and boardDisplay reads only real booleans; (2) each has a registry row (quickFilters with its
// defaultByMode); (3) every card carries changed_at, the newest of the task's own times (no new log file, owner answer
// 3), and gate_red for an open task whose gate failed (an open gate-red block, or a red gate_check).
// =============================================================
import { describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const KK = require('../queueConfig.js') as any;
const R = require('../settingsRegistry.js') as any;
const T = require('../queueBoard.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports */

const resolved = (own: object) => KK.resolveOwn(KK.merge(KK.STANDARD, own), own);

describe('the display settings', () => {
  it('all three are on in STANDARD (full)', () => {
    expect(KK.STANDARD.board.titleCount).toBe(true);
    expect(KK.STANDARD.board.shortcuts).toBe(true);
    expect(KK.STANDARD.board.quickFilters).toBe(true);
    expect(KK.boardDisplay(resolved({}))).toEqual({ titleCount: true, shortcuts: true, quickFilters: true });
  });

  it('lite turns the quick filters off, unless the file sets them', () => {
    expect(KK.boardDisplay(resolved({ mode: 'lite' })).quickFilters).toBe(false);
    expect(KK.boardDisplay(resolved({ mode: 'lite' })).shortcuts).toBe(true);
    expect(KK.boardDisplay(resolved({ mode: 'lite', board: { quickFilters: true } })).quickFilters).toBe(true);
  });

  it('a value that is not a boolean falls back to the default; false turns it off', () => {
    expect(KK.boardDisplay(resolved({ board: { shortcuts: 'no', titleCount: false } }))).toEqual({
      titleCount: false,
      shortcuts: true,
      quickFilters: true,
    });
    expect(KK.boardDisplay(null)).toEqual({ titleCount: true, shortcuts: true, quickFilters: true });
  });

  it('each has a registry row in Board and advice; quickFilters follows the mode', () => {
    for (const key of ['board.titleCount', 'board.shortcuts', 'board.quickFilters']) {
      const row = R.rowFor(key);
      expect(row, key).toBeTruthy();
      expect(row.category, key).toBe('board');
      expect(row.type, key).toBe('onoff');
      expect(row.weakens, key).toBeNull();
    }
    expect(R.rowFor('board.quickFilters').defaultByMode).toEqual({ lite: false, full: true });
  });
});

describe('changed_at and gate_red on the cards', () => {
  const iso = (h: number) => new Date(Date.UTC(2026, 10, 20, h)).toISOString();
  const task = (id: string, extra: object) => ({
    id,
    title: `Task ${id}`,
    domain: 'ui',
    class: 'K',
    value: 5,
    content_min: 60,
    status: 'waiting',
    depends_on: [],
    waiting_on: [],
    owned_files: [`f/${id}.ts`],
    added_by: 'test',
    added_at: iso(1),
    ...extra,
  });
  const queue = {
    created: iso(0),
    limits: {},
    projects: { ex: { title: 'Example', prefixes: ['EX-'] } },
    tasks: [
      task('EX-1', {}),
      task('EX-2', { status: 'running', started: iso(3), picked_at: iso(2) }),
      task('EX-3', {
        status: 'waiting',
        blocks: [
          { code: 'merge-conflict', from: iso(2), to: iso(4) },
          { code: 'gate-red', from: iso(6) },
        ],
      }),
      task('EX-4', { status: 'review', started: iso(2), delivered: iso(5), gate_check: { ok: false, at: iso(7) } }),
      task('EX-5', { status: 'done', started: iso(2), done: iso(8), gate_check: { ok: false, at: iso(3) } }),
    ],
    question: {},
    resolutions: {},
    changelog: [],
  };
  const cards = () => {
    const b = T.board(queue);
    const all = new Map<string, any>();
    for (const list of Object.values(b.columns ?? {})) for (const k of list as any[]) all.set(k.id, k);
    return all;
  };

  it('changed_at is the newest of the task\'s own times', () => {
    const c = cards();
    expect(c.get('EX-1').changed_at).toBe(iso(1));
    expect(c.get('EX-2').changed_at).toBe(iso(3));
    expect(c.get('EX-3').changed_at).toBe(iso(6));
    expect(c.get('EX-4').changed_at).toBe(iso(7));
    expect(c.get('EX-5').changed_at).toBe(iso(8));
  });

  it('gate_red: an open gate-red block or a red gate check on an open task; a done task never', () => {
    const c = cards();
    expect(c.get('EX-1').gate_red).toBe(false);
    expect(c.get('EX-3').gate_red).toBe(true);
    expect(c.get('EX-4').gate_red).toBe(true);
    expect(c.get('EX-5').gate_red).toBe(false);
  });

  it('the pure helpers are exported for other readers', () => {
    expect(T.lastChanged({ added_at: iso(1), blocks: [{ from: iso(2), to: iso(9) }] })).toBe(iso(9));
    expect(T.lastChanged({})).toBeNull();
    expect(T.gateRed({ status: 'cancelled', gate_check: { ok: false } })).toBe(false);
  });
});
