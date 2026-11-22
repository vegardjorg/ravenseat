// =============================================================
// timelineDrag.test.ts: the pure drop math of the Timeline's drag for order (roadmap TIDSLINJE T-B;
// plans/gantt-utredning-2026-11-18.md sections 3 and 4).
//
// Locks: the order of a step row is its planned bars left to right; a block is the marked tasks of the same row in that
// order; a vertical drag moves one place per DRAG.perPlace pixels from where the bar was; the slot becomes `rank --over`
// the first task or `--under` the one before; a sideways drag and a drag past the step's end into another row are
// refused with their words, never mapped to something else; a step row's new place comes from the row midpoints; and
// the keyboard model (Space lifts, arrows move, Enter drops, Escape cancels, left and right are the sideways refusal).
// =============================================================
import { describe, it, expect } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const D = require('../timelineDrag.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports */

const bar = (id: string, row: string, x0: number, y = 0, kind = 'planned') => ({ id, row, kind, x0, y });
const groups = [
  { key: 'ran', kind: 'ran', y: 0, h: 60 },
  { key: 'step:0', kind: 'step', stage: 'project:a', y: 60, h: 84 },
  { key: 'step:1', kind: 'step', stage: 'project:b', y: 144, h: 58 },
  { key: 'step:rest', kind: 'step', stage: null, y: 202, h: 58 },
];
const order = ['A-1', 'A-2', 'A-3', 'A-4'];

describe('the order of a step row', () => {
  it('is its planned bars left to right (lane, then id, on a tie); running and other rows are left out', () => {
    const bars = [
      bar('A-3', 'step:0', 120),
      bar('A-1', 'step:0', 10, 1),
      bar('A-2', 'step:0', 10, 0),
      bar('R-1', 'step:0', 0, 0, 'running'),
      bar('B-1', 'step:1', 5),
    ];
    expect(D.stepOrder(bars, 'step:0')).toEqual(['A-2', 'A-1', 'A-3']);
  });

  it('a block is the marked tasks of the same row in its order; marked ones in another row are named apart', () => {
    expect(D.blockFor(order, 'A-3', [])).toEqual({ ids: ['A-3'], outside: [] });
    expect(D.blockFor(order, 'A-3', ['A-1'])).toEqual({ ids: ['A-3'], outside: [] });
    expect(D.blockFor(order, 'A-3', ['A-3', 'A-1', 'B-9'])).toEqual({ ids: ['A-1', 'A-3'], outside: ['B-9'] });
  });

  it('the slot of a block is how many of the others come before it', () => {
    expect(D.slotOf(order, ['A-1'])).toBe(0);
    expect(D.slotOf(order, ['A-3'])).toBe(2);
    expect(D.slotOf(order, ['A-2', 'A-4'])).toBe(1);
  });

  it('a slot becomes rank --over the first of the others, or --under the one before it', () => {
    const rest = ['A-1', 'A-2', 'A-4'];
    expect(D.spaceFor(rest, 0)).toEqual({ space: 'over', ref: 'A-1' });
    expect(D.spaceFor(rest, 2)).toEqual({ space: 'under', ref: 'A-2' });
    expect(D.spaceFor(rest, 3)).toEqual({ space: 'under', ref: 'A-4' });
    expect(D.spaceFor([], 0)).toBeNull();
  });
});

describe('a task bar dragged', () => {
  const base = { order, block: ['A-3'], rowKey: 'step:0', groups };
  const at = (dx: number, dy: number, y = 100) => D.taskTarget({ ...base, dx, dy, y });

  it('less than the dead zone is nothing yet', () => {
    expect(at(3, -4).kind).toBe('none');
  });

  it('up one place per DRAG.perPlace pixels: right above the task it passes', () => {
    const r = at(0, -D.DRAG.perPlace);
    expect(r).toMatchObject({ kind: 'place', slot: 1, space: 'over', ref: 'A-2', place: 2, of: 4 });
    expect(at(0, -2 * D.DRAG.perPlace)).toMatchObject({ kind: 'place', slot: 0, space: 'over', ref: 'A-1', place: 1 });
  });

  it('down: right below the task it passes; back where it was is the same place (nothing to save)', () => {
    expect(at(0, D.DRAG.perPlace)).toMatchObject({ kind: 'place', slot: 3, space: 'under', ref: 'A-4', place: 4 });
    expect(at(2, D.DRAG.perPlace / 2 - 0.5).kind).toBe('same');
  });

  it('past the end of the step, still in its own row or outside every row: held at the end', () => {
    expect(at(0, -10 * D.DRAG.perPlace, 70)).toMatchObject({ kind: 'place', slot: 0 });
    expect(at(0, 10 * D.DRAG.perPlace, 999)).toMatchObject({ kind: 'place', slot: 3 });
  });

  it('past the end of the step into another row: refused as another step, never mapped', () => {
    const r = at(0, 10 * D.DRAG.perPlace, 160);
    expect(r.kind).toBe('step');
    expect(r.text).toBe(D.REFUSAL.step);
    expect(at(0, -10 * D.DRAG.perPlace, 20).kind).toBe('step');
  });

  it('sideways: refused, because time is calculated', () => {
    const r = at(D.DRAG.sideways + 10, 4);
    expect(r.kind).toBe('sideways');
    expect(r.text).toBe(D.REFUSAL.sideways);
    expect(r.text).toMatch(/time is calculated/i);
    expect(r.text).toMatch(/drag up or down/i);
    // Mostly up with some sideways drift is still a move.
    expect(at(D.DRAG.sideways + 1, -60).kind).toBe('place');
  });

  it('a block keeps its order and moves as one: the slot counts only the others', () => {
    const r = D.taskTarget({ order, block: ['A-2', 'A-4'], rowKey: 'step:0', groups, dx: 0, dy: -D.DRAG.perPlace, y: 90 });
    expect(r).toMatchObject({ kind: 'place', slot: 0, space: 'over', ref: 'A-1', place: 1, of: 4 });
  });

  it('alone in its step: nothing to move against', () => {
    expect(D.taskTarget({ order: ['A-1'], block: ['A-1'], rowKey: 'step:0', groups, dx: 0, dy: -40, y: 70 }).kind).toBe('same');
  });
});

describe('a step row dragged', () => {
  const steps = groups.filter((g) => g.kind === 'step' && g.stage);
  it('its new index comes from the midpoints of the other step rows', () => {
    expect(D.stepTarget({ steps, from: 1, y: 70 })).toMatchObject({ kind: 'place', to: 0 });
    expect(D.stepTarget({ steps, from: 1, y: 150 })).toMatchObject({ kind: 'same', to: 1 });
    expect(D.stepTarget({ steps, from: 0, y: 200 })).toMatchObject({ kind: 'place', to: 1 });
    expect(D.stepTarget({ steps, from: 0, y: 10 })).toMatchObject({ kind: 'same', to: 0 });
  });

  it('reorder moves one item and keeps the rest in their order', () => {
    expect(D.reorder(['a', 'b', 'c', 'd'], 3, 1)).toEqual(['a', 'd', 'b', 'c']);
    expect(D.reorder(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
  });
});

describe('the keyboard model', () => {
  it('Space lifts, then the arrows move, Enter drops, Escape cancels; left and right are the sideways refusal', () => {
    expect(D.keyAction(' ', false)).toBe('lift');
    expect(D.keyAction('Enter', false)).toBeNull(); // Enter opens the card, as before
    expect(D.keyAction('ArrowUp', false)).toBeNull();
    expect(D.keyAction('ArrowUp', true)).toBe('up');
    expect(D.keyAction('ArrowDown', true)).toBe('down');
    expect(D.keyAction('Enter', true)).toBe('drop');
    expect(D.keyAction(' ', true)).toBe('drop');
    expect(D.keyAction('Escape', true)).toBe('cancel');
    expect(D.keyAction('ArrowLeft', true)).toBe('sideways');
    expect(D.keyAction('ArrowRight', true)).toBe('sideways');
  });

  it('a move stops at the ends and says so', () => {
    expect(D.moveSlot(0, -1, 3)).toEqual({ slot: 0, edge: true });
    expect(D.moveSlot(0, 1, 3)).toEqual({ slot: 1, edge: false });
    expect(D.moveSlot(3, 1, 3)).toEqual({ slot: 3, edge: true });
  });

  it('the words for a screen reader: place, step and neighbor', () => {
    expect(D.placeText({ ids: ['A-3'], place: 2, of: 4, step: '1 Alpha', space: 'over', ref: 'A-2' })).toBe(
      'A-3: place 2 of 4 in step 1 Alpha, right above A-2.',
    );
    expect(D.placeText({ ids: ['A-1', 'A-3'], place: 4, of: 4, step: '1 Alpha', space: 'under', ref: 'A-4' })).toBe(
      '2 tasks: place 4 of 4 in step 1 Alpha, right below A-4.',
    );
    expect(D.placeText({ ids: ['A-3'], place: 3, of: 4, step: '1 Alpha', same: true })).toBe(
      'A-3: place 3 of 4 in step 1 Alpha, where it is now.',
    );
  });
});
