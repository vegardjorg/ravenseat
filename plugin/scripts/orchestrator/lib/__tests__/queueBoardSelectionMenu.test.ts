/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardSelectionMenu.test.ts: the selection menu for bulk actions (board step B23).
//
// What the tests prove:
//   - on a wide screen with a mouse the selection is a narrow vertical menu (role=menu) anchored next to the
//     checkbox that was checked last, with the count on top, the actions as menu rows in the same order and under the
//     same conditions as the old bottom bar, a separator and "Clear selection" last,
//   - the menu flips left near the right edge and up near the bottom, is clamped inside the viewport, never covers
//     the checkbox it came from, follows the next checked box and moves with scrolling,
//   - the keyboard: arrows, Home and End move between the rows, Esc closes the menu and puts focus back on the
//     checkbox, a second Esc clears the selection as before, and Shift+F10 on a card opens the menu again,
//   - the checkbox is visible by default on markable cards (no opacity 0) and the header makes room for it,
//   - narrow screens and touch keep the bottom bar (role=toolbar, the room under the board) with the same actions.
// The whole board runs in jsdom with a small synthetic queue; the geometry is stubbed (jsdom has no layout).
// =============================================================
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { clientSource } from './boardClient';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const css = readFileSync(join(CLIENT, 'board.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const NOW = Date.now();
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const ahead = (days: number) => new Date(NOW + days * 86_400_000).toISOString().slice(0, 10);

const task = (id: string, own: object = {}) => ({
  id,
  title: `Task ${id}`,
  domain: 'ui',
  class: 'K',
  value: 5,
  content_min: 30,
  status: 'waiting',
  depends_on: [],
  waiting_on: [],
  owned_files: [`file/${id}.ts`],
  owner_db: [],
  shared_patch: [],
  mission: `scripts/.queue/mission/${id}.md`,
  added_by: 'test',
  added_at: ago(600),
  ...own,
});

/** EX-1 and EX-2 ready, EX-3 on hold, EX-5 and EX-6 in the batch queue. */
function makeQueue() {
  return {
    created: ago(1000),
    limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
    tasks: [
      task('EX-1', { value: 9 }),
      task('EX-2', { value: 7 }),
      task('EX-3', { parked: { reason: 'vendor', to: ahead(5), by: 'owner' } }),
      task('EX-5', { batched: true, content_min: 10 }),
      task('EX-6', { batched: true, content_min: 10 }),
    ],
    projects: { ex: { title: 'Example', prefixes: ['EX-'] } },
    areas: {},
    question: [],
    resolutions: [],
    changelog: [],
  };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

const w = window as any;
/** The media query answer: `narrow` makes the bar layout's query match. */
let narrow = false;

beforeAll(async () => {
  const state = {
    version: 'v1',
    data: {
      ...T.board(makeQueue(), { blockedColumn: true }),
      boardSwitches: { blockedColumn: true },
      gitError: null,
      logo: false,
    },
  };
  const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
  document.documentElement.innerHTML = html.replace(/<!doctype[^>]*>/i, '').replace(/<\/?html[^>]*>/g, '');
  sessionStorage.setItem('queue-board-key', 'testKey');
  localStorage.clear();
  w.CSS = { escape: (s: string) => String(s).replace(/["\\]/g, '\\$&') };
  w.matchMedia = (q: string) => ({
    matches: narrow && /max-width|hover: none/.test(q),
    media: q,
    addEventListener() {},
    removeEventListener() {},
  });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.setInterval = () => 0;
  w.fetch = async (filePath: string) => ({
    ok: true,
    status: 200,
    json: async () =>
      filePath.startsWith('/api/state')
        ? filePath.includes(`version=${state.version}`)
          ? { version: state.version, unchanged: true }
          : state
        : { ok: true, changes: [], version: 'v1' },
  });
  for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', 'board/'])
    (0, eval)(clientSource(f));
  await flush();
  for (const d of document.querySelectorAll('details')) {
    (d as HTMLDetailsElement).open = true;
    d.dispatchEvent(new Event('toggle'));
  }
  await flush();
}, 60_000);

const line = () => document.getElementById('optionLine') as HTMLElement;
const card = (id: string) => document.querySelector(`.summary[data-id="${id}"][data-markable]`) as HTMLElement;
const box = (id: string) => card(id).querySelector('.mark-box') as HTMLElement;
const input = (id: string) => box(id).querySelector('input') as HTMLInputElement;
const labels = () =>
  [...line().querySelectorAll('[role="menuitem"], [role="toolbar"] button')].map((b) => b.textContent?.trim());

/** A DOMRect-like box at (left, top) with the size. */
const rect = (left: number, top: number, width: number, height: number) => ({
  left,
  top,
  width,
  height,
  right: left + width,
  bottom: top + height,
  x: left,
  y: top,
  toJSON() {},
});

/**
 * Places the checkbox of `id` on screen (jsdom has no layout). Keyed on the card id, not the node: a card can be
 * rebuilt when it is marked (the batch group), and the new node has the same place, as in a browser.
 */
const boxAt = new Map<string, ReturnType<typeof rect>>();
function placeBox(id: string, left: number, top: number) {
  boxAt.set(id, rect(left, top, 24, 36));
}
const plainRect = w.HTMLElement.prototype.getBoundingClientRect;
w.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
  if (this.classList.contains('mark-box')) {
    const r = boxAt.get((this.closest('.summary') as HTMLElement)?.dataset.id ?? '');
    if (r) return r;
  }
  return plainRect.call(this);
};

const MENU_W = 240;
const MENU_H = 300;
function viewport(width: number, height: number) {
  w.innerWidth = width;
  w.innerHeight = height;
}

/** Checks the box like a click would (the change event the board listens to). */
function check(id: string, on = true) {
  const i = input(id);
  if (i.checked !== on) i.click();
}

const px = (v: string) => parseFloat(v);

function clearAll() {
  document.body.focus();
  for (const id of ['EX-1', 'EX-2', 'EX-3', 'EX-5', 'EX-6']) if (card(id) && input(id).checked) input(id).click();
}

beforeEach(() => {
  narrow = false;
  viewport(1440, 900);
  clearAll();
  (line() as any).getBoundingClientRect = () => rect(0, 0, MENU_W, MENU_H);
  for (const [i, id] of ['EX-1', 'EX-2', 'EX-3', 'EX-5', 'EX-6'].entries()) placeBox(id, 40, 120 + i * 100);
});

describe('B23: the selection menu on a wide screen', () => {
  it('is a vertical menu with the count on top, the actions in order, a separator and Clear selection last', () => {
    check('EX-1');
    const l = line();
    expect(l.hidden).toBe(false);
    expect(l.classList.contains('as-menu')).toBe(true);
    const menu = l.querySelector('[role="menu"]') as HTMLElement;
    expect(menu).not.toBeNull();
    expect(menu.getAttribute('aria-orientation')).not.toBe('horizontal');
    expect(l.querySelector('.option-tall')?.textContent).toMatch(/^1 selected · /);
    expect(labels()).toEqual([
      'Move to project',
      'Feature',
      'Put on hold',
      'Move as block',
      'Add to batch queue',
      'Label',
      'Clear selection',
    ]);
    // The separator sits right before "Clear selection".
    const kids = [...menu.children];
    const clear = kids.findIndex((k) => k.textContent === 'Clear selection');
    expect(kids[clear - 1].getAttribute('role')).toBe('separator');
    // The menu layout needs no room under the board (that is for the bar).
    expect(document.body.classList.contains('with-option-line')).toBe(false);
  });

  it('opens to the right of the box that was checked last, with its top at the box top', () => {
    placeBox('EX-1', 40, 200);
    check('EX-1');
    expect(px(line().style.left)).toBe(40 + 24 + 4);
    expect(px(line().style.top)).toBe(200);
  });

  it('follows the next checked box, also in another column', () => {
    check('EX-1');
    placeBox('EX-5', 700, 300);
    check('EX-5');
    expect(px(line().style.left)).toBe(700 + 24 + 4);
    expect(px(line().style.top)).toBe(300);
  });

  it('flips left near the right edge and never covers the box', () => {
    placeBox('EX-2', 1300, 200);
    check('EX-2');
    const left = px(line().style.left);
    expect(left).toBe(1300 - 4 - MENU_W);
    expect(left + MENU_W).toBeLessThanOrEqual(1300);
  });

  it('flips up near the bottom', () => {
    placeBox('EX-1', 40, 800);
    check('EX-1');
    expect(px(line().style.top)).toBe(800 + 36 - MENU_H);
  });

  it('is clamped inside a small viewport', () => {
    viewport(800, 400);
    placeBox('EX-1', 40, 100);
    check('EX-1');
    const top = px(line().style.top);
    const left = px(line().style.left);
    expect(top).toBeGreaterThanOrEqual(8);
    expect(left).toBeGreaterThanOrEqual(8);
    expect(left + MENU_W).toBeLessThanOrEqual(800 - 8);
    // Taller than the viewport: it starts at the top edge and scrolls inside (max-height in board.css).
    expect(top).toBe(8);
  });

  it('moves with scrolling and resizing', () => {
    placeBox('EX-1', 40, 200);
    check('EX-1');
    placeBox('EX-1', 40, 150);
    document.dispatchEvent(new Event('scroll'));
    expect(px(line().style.top)).toBe(150);
    placeBox('EX-1', 60, 150);
    window.dispatchEvent(new Event('resize'));
    expect(px(line().style.left)).toBe(60 + 24 + 4);
  });

  it('shows the same actions under the same conditions as before', () => {
    check('EX-3'); // on hold: "Take off hold" after "Put on hold"
    expect(labels()).toEqual([
      'Move to project',
      'Feature',
      'Put on hold',
      'Take off hold',
      'Move as block',
      'Add to batch queue',
      'Label',
      'Clear selection',
    ]);
    clearAll();
    check('EX-5');
    check('EX-6'); // all in the batch queue, two or more: take out and pack, not add
    expect(labels()).toEqual([
      'Move to project',
      'Feature',
      'Put on hold',
      'Move as block',
      'Take out of batch queue',
      'Pack into track',
      'Label',
      'Clear selection',
    ]);
    clearAll();
    check('EX-1');
    check('EX-5'); // mixed: add and take out
    expect(labels()).toContain('Add to batch queue');
    expect(labels()).toContain('Take out of batch queue');
    expect(labels()).not.toContain('Pack into track');
  });

  it('a menu row opens the bulk dialog as before', () => {
    check('EX-1');
    const row = [...line().querySelectorAll('[role="menuitem"]')].find(
      (b) => b.textContent === 'Label',
    ) as HTMLButtonElement;
    row.click();
    expect(document.getElementById('bulk-background')?.hidden).toBe(false);
    // Close the dialog again (its own Esc).
    document.getElementById('bulk')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
});

describe('B23: the keyboard in the menu', () => {
  const key = (target: Element, k: string, extra: KeyboardEventInit = {}) =>
    target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));

  it('arrows, Home and End move between the rows, with one tab stop', () => {
    check('EX-1');
    const rows = [...line().querySelectorAll('[role="menuitem"]')] as HTMLElement[];
    expect(rows.filter((r) => r.tabIndex === 0)).toHaveLength(1);
    rows[0].focus();
    key(rows[0], 'ArrowDown');
    expect(document.activeElement).toBe(rows[1]);
    key(rows[1], 'ArrowUp');
    expect(document.activeElement).toBe(rows[0]);
    key(rows[0], 'ArrowUp'); // wraps to the last
    expect(document.activeElement).toBe(rows[rows.length - 1]);
    key(rows[rows.length - 1], 'Home');
    expect(document.activeElement).toBe(rows[0]);
    key(rows[0], 'End');
    expect(document.activeElement).toBe(rows[rows.length - 1]);
  });

  it('Esc closes the menu and puts focus back on the checkbox; a second Esc clears the selection', () => {
    check('EX-1');
    check('EX-2');
    const first = line().querySelector('[role="menuitem"]') as HTMLElement;
    first.focus();
    key(first, 'Escape');
    expect(line().hidden).toBe(true);
    expect(document.activeElement).toBe(input('EX-2'));
    expect(card('EX-1').classList.contains('marked')).toBe(true);
    key(input('EX-2'), 'Escape');
    expect(card('EX-1').classList.contains('marked')).toBe(false);
    expect(card('EX-2').classList.contains('marked')).toBe(false);
  });

  it('Shift+F10 on a card opens the closed menu again and focuses the first row', () => {
    check('EX-1');
    const first = line().querySelector('[role="menuitem"]') as HTMLElement;
    first.focus();
    key(first, 'Escape');
    expect(line().hidden).toBe(true);
    const title = card('EX-1').querySelector('.summary-button') as HTMLElement;
    title.focus();
    key(title, 'F10', { shiftKey: true });
    expect(line().hidden).toBe(false);
    expect(document.activeElement).toBe(line().querySelector('[role="menuitem"]'));
  });

  it('Clear selection empties the selection and focus goes back to the checkbox', () => {
    check('EX-1');
    const clear = [...line().querySelectorAll('[role="menuitem"]')].pop() as HTMLButtonElement;
    clear.focus();
    clear.click();
    expect(card('EX-1').classList.contains('marked')).toBe(false);
    expect(line().hidden).toBe(true);
    expect(document.activeElement).toBe(input('EX-1'));
  });
});

describe('B23: narrow screens and touch keep the bottom bar', () => {
  it('below 600 px the selection is the bottom bar with the same actions', () => {
    check('EX-1');
    narrow = true;
    window.dispatchEvent(new Event('resize'));
    const l = line();
    expect(l.classList.contains('as-menu')).toBe(false);
    expect(l.querySelector('[role="menu"]')).toBeNull();
    expect(l.querySelector('[role="toolbar"]')).not.toBeNull();
    expect(l.style.left).toBe('');
    expect(l.style.top).toBe('');
    expect(document.body.classList.contains('with-option-line')).toBe(true);
    expect(labels()).toEqual([
      'Move to project',
      'Feature',
      'Put on hold',
      'Move as block',
      'Add to batch queue',
      'Label',
      'Clear selection',
    ]);
    // Back to wide: the menu again, and the room under the board goes.
    narrow = false;
    window.dispatchEvent(new Event('resize'));
    expect(line().classList.contains('as-menu')).toBe(true);
    expect(document.body.classList.contains('with-option-line')).toBe(false);
  });
});

describe('B23: the checkbox is visible by default', () => {
  /** Every top-level and nested rule as selector and body. */
  const rules = () => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));

  it('no rule hides the box on markable cards (no opacity 0 on .mark-box)', () => {
    const hiding = rules().filter((r) => /\.mark-box/.test(r.sel) && /opacity:\s*0\s*;/.test(r.body));
    expect(hiding).toEqual([]);
  });

  it('the box has room from the card edge, and the header makes room for it outside select mode too', () => {
    const base = rules().find((r) => r.sel === '.mark-box')!;
    expect(base.body).toMatch(/left:\s*var\(--distance-xs\)/);
    const header = rules().find((r) => r.sel === '.summary[data-markable] .summary-header');
    expect(header).toBeDefined();
    expect(header!.body).toMatch(/padding-left:\s*var\(--distance-/);
  });

  it('the target stays 24 x 36 on a mouse and 44 on touch', () => {
    const base = rules().find((r) => r.sel === '.mark-box')!;
    expect(base.body).toMatch(/width:\s*var\(--distance-lg\)/);
    expect(base.body).toMatch(/height:\s*calc\(var\(--distance-lg\) \+ var\(--distance-sm\) \+ var\(--distance-xs\)\)/);
    const touch = css.match(/@media \(hover: none\) \{\s*\.mark-box \{([^}]*)\}/);
    expect(touch).not.toBeNull();
    expect(touch![1]).toMatch(/width:\s*44px/);
    expect(touch![1]).toMatch(/height:\s*44px/);
  });

  it('the menu rows are 36 px on a mouse and 44 px on touch, on surface tokens', () => {
    const item = rules().find((r) => r.sel === '.option-item')!;
    expect(item).toBeDefined();
    expect(item.body).toMatch(/min-height:\s*36px/);
    expect(css).toMatch(/@media \(pointer: coarse\) \{[^@]*\.option-item[^{]*\{[^}]*min-height:\s*44px/);
    const menu = rules().find((r) => r.sel === '.optionLine.as-menu')!;
    expect(menu.body).toMatch(/background:\s*var\(--color-surface-container-lowest\)/);
    expect(menu.body).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
