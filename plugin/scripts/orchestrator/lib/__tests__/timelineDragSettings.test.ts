// =============================================================
// timelineDragSettings.test.ts: the two settings of the Timeline's drag for order (roadmap TIDSLINJE T-B;
// plans/gantt-utredning-2026-11-18.md section 6).
//
// Locks: board.timelineDrag and board.timelineDragPreview are on by default (they only change order, always with Undo,
// and stop no work), boardTimeline reads them (a wrong value falls back), each has a Board registry row that weakens
// nothing, needs board.timeline and is full-only (the tab is off in lite), and both are in the queue.md settings table
// and board.md.
// =============================================================
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const KK = require('../queueConfig.js') as any;
const R = require('../settingsRegistry.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports */

const resolved = (own: object) => KK.resolveOwn(KK.merge(KK.STANDARD, own), own);
const DOCS = join(__dirname, '..', '..', '..', '..', 'docs');

describe('board.timelineDrag and board.timelineDragPreview', () => {
  it('STANDARD: both on; boardTimeline reads them, a wrong value falls back to on', () => {
    expect(KK.STANDARD.board.timelineDrag).toBe(true);
    expect(KK.STANDARD.board.timelineDragPreview).toBe(true);
    expect(KK.boardTimeline(resolved({}))).toMatchObject({ drag: true, dragPreview: true });
    expect(KK.boardTimeline(resolved({ board: { timelineDrag: false } })).drag).toBe(false);
    expect(KK.boardTimeline(resolved({ board: { timelineDragPreview: false } })).dragPreview).toBe(false);
    expect(KK.boardTimeline(resolved({ board: { timelineDrag: 'x' } })).drag).toBe(true);
  });

  it('each has a Board row that weakens nothing, needs the tab and is full-only', () => {
    for (const k of ['board.timelineDrag', 'board.timelineDragPreview']) {
      const r = R.rowFor(k);
      expect(r, k).toBeTruthy();
      expect(r.category).toBe('board');
      expect(r.type).toBe('onoff');
      expect(r.weakens).toBeNull();
      expect(r.modes).toEqual(['full']);
      expect(r.fullWhy).toMatch(/lite/);
      expect(R.REQUIRES[k]).toContain('board.timeline');
    }
    expect(R.REQUIRES['board.timelineDragPreview']).toContain('board.timelineDrag');
  });

  it('both are in the settings table of queue.md and in board.md', () => {
    const queueMd = readFileSync(join(DOCS, 'queue.md'), 'utf8');
    const boardMd = readFileSync(join(DOCS, 'board.md'), 'utf8');
    for (const k of ['board.timelineDrag', 'board.timelineDragPreview']) {
      expect(queueMd).toMatch(new RegExp(`\\| \`${k.replace('.', '\\.')}\``));
      expect(boardMd).toContain(k);
    }
  });
});
