// =============================================================
// timelineDrag.js: the pure drop math of the Timeline's drag for order (roadmap TIDSLINJE T-B; plans: gantt
// investigation 2026-11-18, sections 3 and 4).
//
// Time is a result, never an input: a drop never sets a time, it only gives a task a new place in the order of its
// focus step (`ravenseat rank <ids> --over|--under <id>`) or a step a new place in the focus (`focus save`). So:
//   - stepOrder, blockFor, slotOf, spaceFor: the order of one step row (its planned bars left to right), the block that
//     moves (the marked tasks of that row, in their order), where the block sits now, and the rank words for a slot.
//   - taskTarget: a dragged bar. One place per DRAG.perPlace pixels up or down from where it was picked up. Sideways
//     (mostly left or right) is refused: "time is calculated". Past the end of the step while the pointer is over
//     another row is refused: a task stays in its step (steps decide the order first). Never mapped to something else.
//   - stepTarget, reorder: a dragged step row, by the midpoints of the other step rows.
//   - keyAction, moveSlot, placeText: the keyboard model (Space lifts, the arrows move, Enter or Space drops, Escape
//     cancels; left and right are the sideways refusal) and the words the live region says.
// Nothing here writes or reads the queue: board/timeline.js sends the result through the existing server paths
// (POST /api/bulk rank, POST /api/focus), always with the dry run first unless board.timelineDragPreview is off.
//
// The file is both a CommonJS module (the tests) and a script in the browser (queue-board.mjs serves it as
// /timelineDrag.js and it sets window.QueueTimelineDrag). Tested in lib/__tests__/timelineDrag.test.ts.
// =============================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.QueueTimelineDrag = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /**
   * dead: below this many pixels a press is still a click. sideways: at least this far left or right (and more than
   * twice as far as up or down) is a sideways drag. perPlace: the pixels per place in the order.
   */
  const DRAG = Object.freeze({ dead: 6, sideways: 40, perPlace: 14 });

  /** The refusals, said in the drop line, the live region and the toast. */
  const REFUSAL = Object.freeze({
    sideways: 'Time is calculated, not set: drag up or down to change the order.',
    step:
      'A task stays in its focus step here: the steps decide the order first. Move the step row, or change the ' +
      "task's project or feature in the Focus tab.",
  });

  /** The ids of the planned bars of one row, left to right (then top to bottom, then id). */
  function stepOrder(bars, rowKey) {
    return (bars ?? [])
      .filter((b) => b && b.row === rowKey && b.kind === 'planned')
      .sort((a, b) => a.x0 - b.x0 || a.y - b.y || String(a.id).localeCompare(String(b.id)))
      .map((b) => b.id);
  }

  /**
   * The block that moves when `id` is dragged: the marked tasks of the same row in the row's order when `id` is one of
   * two or more marked, otherwise `id` alone. `outside`: the marked ones that are not in this row (a block across
   * steps is refused by the caller, never split).
   */
  function blockFor(order, id, marked) {
    const set = new Set(marked ?? []);
    if (!set.has(id) || set.size < 2) return { ids: [id], outside: [] };
    return { ids: order.filter((x) => set.has(x)), outside: [...set].filter((x) => !order.includes(x)) };
  }

  /** How many of the others (the order without the block) come before the block's first task. */
  function slotOf(order, block) {
    const inBlock = new Set(block);
    const first = order.findIndex((x) => inBlock.has(x));
    return first < 0 ? 0 : order.slice(0, first).filter((x) => !inBlock.has(x)).length;
  }

  /**
   * The rank words for a slot among the others: right above the first one, or right below the one before. Moving up
   * (`up`) says it from the task it passes: right above the one now after it.
   */
  function spaceFor(rest, slot, up = false) {
    if (!rest?.length) return null;
    if (slot <= 0 || (up && slot < rest.length)) return { space: 'over', ref: rest[Math.max(0, slot)] };
    return { space: 'under', ref: rest[Math.min(slot, rest.length) - 1] };
  }

  /** The row under a y (in the chart's coordinates), or null. */
  function groupAt(groups, y) {
    return (groups ?? []).find((g) => y >= g.y && y < g.y + g.h) ?? null;
  }

  /**
   * Where a dragged bar would go.
   * @param {{ order: string[], block: string[], rowKey: string, groups: object[], dx: number, dy: number, y: number }} p
   *   dx, dy: from where it was picked up; y: the pointer's y in the rows' coordinates
   * @returns {{ kind: 'none'|'same'|'place'|'sideways'|'step', slot?: number, space?: string, ref?: string,
   *   place?: number, of?: number, text?: string }} place is 1-based in the step's new order, of its length
   */
  function taskTarget({ order, block, rowKey, groups, dx = 0, dy = 0, y = 0 }) {
    if (Math.max(Math.abs(dx), Math.abs(dy)) < DRAG.dead) return { kind: 'none' };
    if (Math.abs(dx) >= DRAG.sideways && Math.abs(dx) > 2 * Math.abs(dy)) return { kind: 'sideways', text: REFUSAL.sideways };
    const inBlock = new Set(block);
    const rest = order.filter((x) => !inBlock.has(x));
    const now = slotOf(order, block);
    const raw = now + Math.round(dy / DRAG.perPlace);
    if (raw < 0 || raw > rest.length) {
      const g = groupAt(groups, y);
      if (g && g.key !== rowKey) return { kind: 'step', text: REFUSAL.step };
    }
    const slot = Math.max(0, Math.min(rest.length, raw));
    const base = { slot, place: slot + 1, of: order.length, ...(spaceFor(rest, slot, slot < now) ?? {}) };
    if (slot === now || !rest.length) return { ...base, kind: 'same' };
    return { ...base, kind: 'place' };
  }

  /**
   * Where a dragged step row would go: the number of the other step rows whose midpoint is above y.
   * @param {{ steps: { y: number, h: number }[], from: number, y: number }} p
   * @returns {{ kind: 'same'|'place', to: number, of: number }}
   */
  function stepTarget({ steps, from, y }) {
    const others = (steps ?? []).filter((_, i) => i !== from);
    const to = others.filter((g) => g.y + g.h / 2 < y).length;
    return { kind: to === from ? 'same' : 'place', to, of: (steps ?? []).length };
  }

  /** A copy of the list with the item at `from` moved to index `to`. */
  function reorder(list, from, to) {
    const out = [...list];
    const [x] = out.splice(from, 1);
    out.splice(Math.max(0, Math.min(out.length, to)), 0, x);
    return out;
  }

  /**
   * The keyboard model: what a key does on a bar or a step row (lifted or not). null: not ours (Enter on a bar that is
   * not lifted opens the card, as before; Tab moves on).
   */
  function keyAction(key, lifted) {
    if (!lifted) return key === ' ' ? 'lift' : null;
    if (key === 'ArrowUp') return 'up';
    if (key === 'ArrowDown') return 'down';
    if (key === 'ArrowLeft' || key === 'ArrowRight') return 'sideways';
    if (key === 'Enter' || key === ' ') return 'drop';
    if (key === 'Escape') return 'cancel';
    return null;
  }

  /** One step with the keyboard: the new slot, held at 0 and max (edge: the move was stopped there). */
  function moveSlot(slot, delta, max) {
    const next = slot + delta;
    if (next < 0 || next > max) return { slot, edge: true };
    return { slot: next, edge: false };
  }

  /** "in step 1 (Alpha)", or "in the rest" for a row that is not a numbered step (`step` starts with "the "). */
  const inStep = (step) => (/^the /.test(String(step)) ? `in ${step}` : `in step ${step}`);

  /** "A-3: place 2 of 4 in step 1 Alpha, right above A-2." (a block: "2 tasks: ..."). */
  function placeText({ ids, place, of, step, space, ref, same }) {
    const who = ids.length === 1 ? ids[0] : `${ids.length} tasks`;
    const where = same ? 'where it is now' : space === 'over' ? `right above ${ref}` : `right below ${ref}`;
    return `${who}: place ${place} of ${of} ${inStep(step)}, ${where}.`;
  }

  /**
   * A new focus order from a reorder of the visible step rows: the steps the chart does not show (no tasks in view)
   * keep their places in the full order, and the visible ones take their new order around them.
   */
  function fullOrder(full, visible, nextVisible) {
    const seen = new Set(visible);
    const queue = [...nextVisible];
    return (full ?? []).map((k) => (seen.has(k) ? queue.shift() : k));
  }

  return {
    DRAG,
    REFUSAL,
    stepOrder,
    blockFor,
    slotOf,
    spaceFor,
    groupAt,
    taskTarget,
    stepTarget,
    reorder,
    keyAction,
    moveSlot,
    placeText,
    inStep,
    fullOrder,
  };
});
