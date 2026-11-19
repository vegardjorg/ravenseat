/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardQa1d.test.ts: the top bar and the focus line keep a fixed size (QA-1d: Q9, Q10 and Q11).
//
// What the tests prove:
//   - Q9: "Select all matches" is out of the top bar. The same action is the first row of the Filter menu
//     ("Select all N matches", disabled as "All N matches selected" once they are), and Ctrl/Cmd+A still selects
//     every match. Row 2 of the top bar holds the same elements with and without a search or filter, and the Filter
//     button has a fixed width, so the bar keeps its width.
//   - Q10: the Selection button is gone. The Filter menu has Quick filters (the built-ins, each with its explanation),
//     then Saved (your own, with "Save current as…" and Delete), then the old filter sections. A saved filter from the
//     old storage key loads and restores search, filter and grouping; a quick filter resets search and filter. The
//     Filter button says what is active ("Filter · 2", "Filter · Ready in focus"), cut with an ellipsis, with a tooltip
//     and a matching aria-label. "Show all" is at the top of the menu when anything is active. The word "selection"
//     means ticked cards only.
//   - Q11: the focus line is one line. A pure function (QueueA11y.focusFit) says how many steps fit; what does not fit
//     goes into "+N more", a popover with every step (arrow keys, Esc, focus back on the button, aria-expanded). The
//     current step is always shown, and "Edit focus" stays last in the row, outside the step list.
// Render tests do not work in jsdom, so layout rules are read from board.css and the widths the fit uses are stubbed.
// =============================================================
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { clientSource } from './boardClient';

/* eslint-disable @typescript-eslint/no-require-imports */
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };
const A = require('../../queue-board/a11y.js') as {
  focusFit: (a: { widths: number[]; available: number; more: number; gap?: number }) => number;
  emptyReason: (a: Record<string, unknown>) => { text: string; action: string | null; label: string | null };
  chainHidden: (c: Array<Record<string, unknown>>) => Array<{ text: string }>;
};
/* eslint-enable @typescript-eslint/no-require-imports */

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const DOCS = join(__dirname, '..', '..', '..', '..', 'docs');
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const css = strip(readFileSync(join(CLIENT, 'board.css'), 'utf8'));
const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
const iso = new Date(Date.now() - 86_400_000).toISOString();

// ---- A small CSS reader (top-level rules only) ----------------------------------------------------------------------
function base(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    const selectors = m[1].split(',').map((s) => s.trim());
    if (!selectors.includes(selector)) continue;
    for (const d of m[2].split(';')) {
      const colon = d.indexOf(':');
      if (colon > 0) out[d.slice(0, colon).trim()] = d.slice(colon + 1).trim();
    }
  }
  return out;
}

// ---- The board in jsdom: 20 tasks, one feature each, and a focus with 20 long-named steps ---------------------------
const LONG = (i: number) => `A long feature name for step ${i} that never fits on a narrow line`;
function makeQueue() {
  const tasks = Array.from({ length: 20 }, (_, n) => ({
    id: `EX-${n + 1}`,
    title: `Task ${n + 1}`,
    feature: LONG(n + 1),
    domain: 'ui',
    class: 'K',
    value: 5,
    content_min: 30,
    status: 'waiting',
    depends_on: [],
    waiting_on: [],
    owned_files: [`file/EX-${n + 1}.ts`],
    owner_db: [],
    shared_patch: [],
    mission: `scripts/.queue/mission/EX-${n + 1}.md`,
    added_by: 'test',
    added_at: iso,
  }));
  return {
    created: iso,
    limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
    tasks,
    projects: { ex: { title: 'Example', prefixes: ['EX-'] }, other: { title: 'Other', prefixes: ['OT-'] } },
    areas: {},
    question: [],
    resolutions: [],
    changelog: [],
    focus: {
      order: tasks.map((k) => `feature:ex/${k.feature}`),
      rest: 'wait',
      from: iso,
      now_count: 1,
    },
  };
}
const state = { version: 'v1', data: { ...T.board(makeQueue()), gitError: null, logo: false } };

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const key = (target: Element, k: string, extra: object = {}) =>
  target.dispatchEvent(new (window as any).KeyboardEvent('keydown', { key: k, bubbles: true, ...extra }));

/** A saved filter as the old Selection menu wrote it (same storage key, same shape). */
const OLD_SAVED = [
  {
    // Long, but within the 60 characters ownViews() accepts.
    name: 'Mine, with a long name the Filter button cuts short',
    view: 'flat',
    search: 'ex-2',
    filter: { projects: ['ex'] },
    grouping: 'feature',
    special: null,
  },
];

beforeAll(async () => {
  document.documentElement.innerHTML = html.replace(/<!doctype[^>]*>/i, '').replace(/<\/?html[^>]*>/g, '');
  sessionStorage.setItem('queue-board-key', 'testKey');
  localStorage.clear();
  localStorage.setItem('queue-board-views', JSON.stringify(OLD_SAVED));
  const w = window as any;
  w.CSS = { escape: (s: string) => String(s).replace(/["\\]/g, '\\$&') };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.setInterval = () => 0;
  w.fetch = async (filePath: string) => ({
    ok: true,
    status: 200,
    json: async () => {
      if (filePath.startsWith('/api/state'))
        return filePath.includes(`version=${state.version}`) ? { version: state.version, unchanged: true } : state;
      if (filePath.startsWith('/api/task')) return { ok: true, mission: { text: '', path: null }, branch: null };
      return { ok: true };
    },
  });
  for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', 'board/'])
    (0, eval)(clientSource(f));
  await flush();
  $('show-flat').click();
  await flush();
}, 60_000);

const menu = () => $('filter-menu');
function openFilter() {
  if (menu().hidden) $('filter-button').click();
  return menu();
}
function closeFilter() {
  if (!menu().hidden) $('filter-button').click();
}
async function search(text: string) {
  const s = $('search') as HTMLInputElement;
  s.value = text;
  s.dispatchEvent(new Event('input'));
  await wait(200);
  await flush();
}
/** Everything shown in row 2 of the top bar, as a signature (id or class, and whether it is hidden). */
function row2Signature() {
  const row = document.querySelector('.top-row2') as HTMLElement;
  return [...row.querySelectorAll('*')]
    .filter((e) => !(e as HTMLElement).closest('[hidden]') && !(e as HTMLElement).closest('#filter-menu'))
    .map((e) => `${e.tagName}#${e.id}.${(e as HTMLElement).className}`);
}
const markedCount = () => document.querySelectorAll('.summary.marked').length;

// ---- Q9 ---------------------------------------------------------------------------------------------------------------

describe('Q9: "Select all matches" left the top bar', () => {
  it('there is no #mark-match in the page, and the search group holds only the search and Filter', () => {
    expect($('mark-match')).toBeNull();
    expect(html).not.toMatch(/id="mark-match"/);
    const kids = [...$('search-filter').children].map((e) => e.id || e.className);
    expect(kids).toEqual(['search', 'filter']);
  });

  it('the top bar keeps the same elements, and the Filter button its fixed width, with a search and a filter', async () => {
    const before = row2Signature();
    await search('ex-1');
    const m = openFilter();
    (m.querySelector('#f-projects-ex') as HTMLInputElement).click();
    await flush();
    closeFilter();
    expect($('filter-button').textContent).toMatch(/^Filter · /);
    // The only change is the Filter button's "active" class, which changes its colors and nothing that has a size
    // (an outline, from the forced-colors rule, takes no layout space either).
    const plain = (sig: string[]) => sig.map((s) => s.replace(/ active\b/, ''));
    expect(plain(row2Signature())).toEqual(plain(before));
    for (const prop of Object.keys(base('.filter-button.active')))
      expect(prop).toMatch(/^(background|color|border-color|outline)$/);
    // The width does not follow the label: a fixed width that never grows or shrinks in the flex row.
    const b = base('.filter-fixed');
    expect(b.width).toMatch(/^\d+px$/);
    expect(b.flex).toBe('none');
    const label = base('.filter-label');
    expect(label['text-overflow']).toBe('ellipsis');
    expect(label['white-space']).toBe('nowrap');
    expect(label.overflow).toBe('hidden');
  });

  it('the Filter menu starts with "Select all N matches", which selects them and then reads as done', async () => {
    const m = openFilter();
    const first = m.firstElementChild as HTMLElement;
    const button = first.querySelector('[data-focus="mark-match"]') as HTMLButtonElement;
    expect(button).not.toBeNull();
    // ex-1 matches EX-1 and EX-10 to EX-19: 11 cards.
    expect(button.textContent).toBe('Select all 11 matches');
    expect(button.disabled).toBe(false);
    button.click();
    await flush();
    expect(markedCount()).toBe(11);
    // The menu closes with focus on Filter, so the next step (the selection menu) is one Tab away.
    expect(menu().hidden).toBe(true);
    const again = openFilter().querySelector('[data-focus="mark-match"]') as HTMLButtonElement;
    expect(again.textContent).toBe('All 11 matches selected');
    expect(again.disabled).toBe(true);
    key(menu(), 'Escape');
    key(document.body, 'Escape');
    await flush();
    expect(markedCount()).toBe(0);
  });

  it('Ctrl/Cmd+A still selects every match', async () => {
    (document.activeElement as HTMLElement)?.blur?.();
    key(document.body, 'a', { ctrlKey: true });
    await flush();
    expect(markedCount()).toBe(11);
    key(document.body, 'Escape');
    await flush();
    expect(markedCount()).toBe(0);
  });

  it('without search or filter the row is not in the menu', async () => {
    await search('');
    const m = openFilter();
    (m.querySelector('[data-focus="show-all"]') as HTMLButtonElement)?.click();
    await flush();
    expect(openFilter().querySelector('[data-focus="mark-match"]')).toBeNull();
    closeFilter();
  });
});

// ---- Q10 --------------------------------------------------------------------------------------------------------------

describe('Q10: the Selection button is folded into the Filter menu', () => {
  it('no Selection button or menu in the top bar', () => {
    expect($('views')).toBeNull();
    expect($('views-menu')).toBeNull();
    expect(html).not.toMatch(/>\s*Selection\s*</);
  });

  it('the menu has Quick filters, then Saved, then the filter sections', () => {
    const m = openFilter();
    const titles = [...m.querySelectorAll('.filter-section h3')].map((h) => h.textContent);
    expect(titles.slice(0, 2)).toEqual(['Quick filters', 'Saved']);
    expect(titles).toContain('Show');
    expect(titles).toContain('Projects');
    expect(titles.indexOf('Show')).toBeGreaterThan(1);
    const quick = [...m.querySelectorAll('.filter-section')][0];
    const rows = [...quick.querySelectorAll('.view-option')] as HTMLElement[];
    expect(rows.map((r) => r.getAttribute('aria-label'))).toEqual([
      'Focus now',
      'Ready in focus',
      'Outside focus, ready',
      'On hold',
      'Sort',
      'New since last visit',
    ]);
    for (const r of rows) {
      const explain = r.querySelector('.view-explain') as HTMLElement;
      expect(explain.textContent?.length).toBeGreaterThan(10);
      expect(r.getAttribute('aria-describedby')).toBe(explain.id);
    }
    closeFilter();
  });

  it('a saved filter from the old storage key loads and restores search, filter and grouping', async () => {
    const m = openFilter();
    const saved = [...m.querySelectorAll('.filter-section')][1];
    const row = saved.querySelector('.view-option') as HTMLButtonElement;
    expect(row.getAttribute('aria-label')).toBe(OLD_SAVED[0].name);
    expect(saved.querySelector('.pause-button')?.textContent).toBe('Delete');
    row.click();
    await flush();
    expect(($('search') as HTMLInputElement).value).toBe('ex-2');
    expect(($('grouping') as HTMLSelectElement).value).toBe('feature');
    const f = openFilter();
    expect((f.querySelector('#f-projects-ex') as HTMLInputElement).checked).toBe(true);
    closeFilter();
  });

  it('the Filter button names the active saved filter, cut short, with the full name in the tooltip', () => {
    const b = $('filter-button');
    const label = b.querySelector('.filter-label') as HTMLElement;
    expect(label.textContent).toBe(`Filter · ${OLD_SAVED[0].name}`);
    expect(b.title).toContain(OLD_SAVED[0].name);
    expect(b.getAttribute('aria-label')).toBe(`Filter, ${OLD_SAVED[0].name} in use, 1 active`);
    expect(b.getAttribute('aria-expanded')).toBe('false');
    expect(b.classList.contains('active')).toBe(true);
  });

  it('a quick filter resets search and filter, and the button names it', async () => {
    const m = openFilter();
    (m.querySelector('[aria-label="On hold"]') as HTMLButtonElement).click();
    await flush();
    expect(($('search') as HTMLInputElement).value).toBe('');
    expect($('filter-button').querySelector('.filter-label')?.textContent).toBe('Filter · On hold');
    expect($('filter-button').getAttribute('aria-label')).toBe('Filter, On hold in use');
    const f = openFilter();
    expect((f.querySelector('#f-projects-ex') as HTMLInputElement).checked).toBe(false);
  });

  it('"Show all" sits at the top when anything is active, and clears it', async () => {
    const m = openFilter();
    const top = m.firstElementChild as HTMLElement;
    const all = top.querySelector('[data-focus="show-all"]') as HTMLButtonElement;
    expect(all?.textContent).toBe('Show all');
    all.click();
    await flush();
    expect($('filter-button').querySelector('.filter-label')?.textContent).toBe('Filter');
    expect($('filter-button').getAttribute('aria-label')).toBe('Filter');
    expect(openFilter().querySelector('[data-focus="show-all"]')).toBeNull();
  });

  it('with only checked filters the button shows the count', async () => {
    const m = openFilter();
    (m.querySelector('#f-projects-ex') as HTMLInputElement).click();
    await flush();
    expect($('filter-button').querySelector('.filter-label')?.textContent).toBe('Filter · 1');
    expect($('filter-button').getAttribute('aria-label')).toBe('Filter, 1 active');
  });

  it('"Save current as…" saves under the same key, and Delete removes it', async () => {
    const m = openFilter();
    const save = m.querySelector('[data-focus="save-as"]') as HTMLButtonElement;
    expect(save.textContent).toBe('Save current as…');
    save.click();
    const field = menu().querySelector('#view-name') as HTMLInputElement;
    expect(field).not.toBeNull();
    expect(document.activeElement).toBe(field);
    field.value = 'Only ex';
    key(field, 'Enter');
    await flush();
    const stored = JSON.parse(localStorage.getItem('queue-board-views') ?? '[]');
    expect(stored.map((v: any) => v.name)).toEqual([OLD_SAVED[0].name, 'Only ex']);
    expect(stored[1].filter.projects).toEqual(['ex']);
    const saved = [...menu().querySelectorAll('.filter-section')][1];
    const del = [...saved.querySelectorAll('.pause-button')].find((b) =>
      (b.getAttribute('title') ?? '').includes('Only ex'),
    ) as HTMLButtonElement;
    del.click();
    await flush();
    expect(JSON.parse(localStorage.getItem('queue-board-views') ?? '[]')).toHaveLength(1);
  });

  it('the arrow keys move through quick filters, saved filters and checkboxes; Esc closes with focus on Filter', () => {
    closeFilter();
    const m = openFilter();
    const rows = [...m.querySelectorAll('.view-option, input[type="checkbox"]')] as HTMLElement[];
    expect(document.activeElement).toBe(rows[0]);
    for (let i = 0; i < 7; i++) key(document.activeElement as Element, 'ArrowDown');
    // Six quick filters, one saved filter, then the first checkbox.
    expect(document.activeElement).toBe(rows[7]);
    expect((rows[7] as HTMLInputElement).type).toBe('checkbox');
    key(document.activeElement as Element, 'ArrowUp');
    expect(document.activeElement).toBe(rows[6]);
    key(document.activeElement as Element, 'Escape');
    expect(m.hidden).toBe(true);
    expect(document.activeElement).toBe($('filter-button'));
    expect($('filter-button').getAttribute('aria-expanded')).toBe('false');
  });

  it('"selection" means ticked cards only: the help, the empty state and the chain line say filter', () => {
    const board = clientSource('board/');
    expect(board).not.toMatch(/'"Selection" has built-in/);
    expect(board).toMatch(/Quick filters/);
    expect(A.emptyReason({ text: 'Nothing here.', selection: 'On hold' }).text).toBe(
      'Nothing here. Filter "On hold" is in use.',
    );
    expect(A.chainHidden([{ cause: 'selection', n: 1, name: 'On hold' }])[0].text).toBe(
      '1 outside the filter "On hold"',
    );
    const doc = readFileSync(join(DOCS, 'board.md'), 'utf8');
    expect(doc).toMatch(/Quick filters/);
    expect(doc).not.toMatch(/\*\*Selection\*\* is a/);
  });
});

// ---- Q11 --------------------------------------------------------------------------------------------------------------

describe('Q11: the pure fit function', () => {
  it('everything fits: every step is shown and there is no "+N more"', () => {
    expect(A.focusFit({ widths: [100, 100, 100], available: 1000, more: 60, gap: 4 })).toBe(3);
    // Exactly fits without the more button: 3 * 100 + 2 * 4.
    expect(A.focusFit({ widths: [100, 100, 100], available: 308, more: 60, gap: 4 })).toBe(3);
  });

  it('when not everything fits, room is kept for "+N more"', () => {
    // 100 + 4 + 100 + 4 + 60 = 268.
    expect(A.focusFit({ widths: [100, 100, 100], available: 268, more: 60, gap: 4 })).toBe(2);
    expect(A.focusFit({ widths: [100, 100, 100], available: 267, more: 60, gap: 4 })).toBe(1);
  });

  it('the current (first) step is always shown, and no steps give 0', () => {
    expect(A.focusFit({ widths: [400, 100], available: 50, more: 60, gap: 4 })).toBe(1);
    expect(A.focusFit({ widths: [], available: 500, more: 60, gap: 4 })).toBe(0);
    // Bad numbers count as 0 width.
    expect(A.focusFit({ widths: [NaN, 10], available: 100, more: 10 })).toBe(2);
  });
});

describe('Q11: the focus line is one line', () => {
  const restore: Array<() => void> = [];
  /** Stubs a layout: every step 120 px, the "+N more" button 60 px, the step list `list` px wide. */
  function stubLayout(list: number) {
    const proto = (window as any).HTMLElement.prototype;
    for (const prop of ['offsetWidth', 'clientWidth']) {
      const had = Object.getOwnPropertyDescriptor(proto, prop);
      Object.defineProperty(proto, prop, {
        configurable: true,
        get(this: HTMLElement) {
          if (this.classList.contains('focus-step-list')) return list;
          if (this.classList.contains('focus-item')) return 120;
          if (this.classList.contains('focus-more-button')) return 60;
          return 0;
        },
      });
      restore.push(() => (had ? Object.defineProperty(proto, prop, had) : delete proto[prop]));
    }
  }
  afterAll(() => restore.forEach((r) => r()));

  it('the row never wraps, the steps are cut with an ellipsis and Edit focus never shrinks', () => {
    expect(base('.focus-row')['flex-wrap']).toBe('nowrap');
    expect(base('.focus-row').overflow).toBe('hidden');
    const list = base('.focus-step-list');
    expect(list['flex-wrap']).toBe('nowrap');
    expect(list['min-width']).toBe('0');
    expect(list.overflow).toBe('hidden');
    const step = base('.focus-step');
    expect(step['text-overflow']).toBe('ellipsis');
    expect(step.overflow).toBe('hidden');
    expect(step['max-width']).toMatch(/^\d+px$/);
    const edit = base('.focus-edit');
    expect(edit.flex).toBe('none');
    expect(edit['margin-left']).toBe('auto');
    expect(base('.focus-more-button').flex).toBe('none');
  });

  it('every step is drawn with its full name in the tooltip', () => {
    const steps = [...document.querySelectorAll('.focusLine .focus-step')] as HTMLElement[];
    expect(steps).toHaveLength(20);
    expect(steps[4].title).toContain(LONG(5));
  });

  it('what does not fit goes into "+N more", and the first step stays visible', async () => {
    stubLayout(500);
    window.dispatchEvent(new Event('resize'));
    await flush();
    const items = [...document.querySelectorAll('.focusLine .focus-item')] as HTMLElement[];
    // 3 * 120 + 60 <= 500 < 4 * 120 + 60.
    expect(items.filter((i) => !i.hidden)).toHaveLength(3);
    expect(items[0].hidden).toBe(false);
    const more = document.querySelector('.focus-more-button') as HTMLButtonElement;
    expect(more.hidden).toBe(false);
    expect(more.textContent).toBe('+17 more');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(more.getAttribute('aria-controls')).toBe('focus-more');
    restore.splice(0).forEach((r) => r());
    stubLayout(50);
    window.dispatchEvent(new Event('resize'));
    await flush();
    const narrow = [...document.querySelectorAll('.focusLine .focus-item')] as HTMLElement[];
    expect(narrow.filter((i) => !i.hidden)).toHaveLength(1);
    expect(narrow[0].hidden).toBe(false);
    restore.splice(0).forEach((r) => r());
    stubLayout(500);
    window.dispatchEvent(new Event('resize'));
    await flush();
  });

  it('"+N more" opens every step in a popover: arrow keys, Esc and focus back on the button', async () => {
    const more = document.querySelector('.focus-more-button') as HTMLButtonElement;
    more.click();
    await flush();
    const pop = $('focus-more');
    expect(pop.hidden).toBe(false);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    const rows = [...pop.querySelectorAll('.focus-more-row')] as HTMLElement[];
    expect(rows).toHaveLength(20);
    expect(rows[19].textContent).toContain(LONG(20));
    // The counts stay reachable: in the popover too.
    expect(pop.textContent).toMatch(/rest waits/);
    expect(document.activeElement).toBe(rows[0]);
    key(rows[0], 'ArrowDown');
    expect(document.activeElement).toBe(rows[1]);
    key(rows[1], 'End');
    expect(document.activeElement).toBe(rows[19]);
    key(rows[19], 'Home');
    expect(document.activeElement).toBe(rows[0]);
    key(rows[0], 'Escape');
    expect(pop.hidden).toBe(true);
    expect(more.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(more);
  });

  it('a click outside closes the popover', async () => {
    const more = document.querySelector('.focus-more-button') as HTMLButtonElement;
    more.click();
    await flush();
    expect($('focus-more').hidden).toBe(false);
    document.body.click();
    expect($('focus-more').hidden).toBe(true);
  });

  it('"Edit focus" stays last in the row, outside the step list, also with the popover open', async () => {
    const row = document.querySelector('.focusLine .focus-row') as HTMLElement;
    const last = row.lastElementChild as HTMLElement;
    expect(last.textContent).toBe('Edit focus');
    expect(last.classList.contains('focus-edit')).toBe(true);
    expect(row.querySelector('.focus-step-list')!.contains(last)).toBe(false);
    (document.querySelector('.focus-more-button') as HTMLButtonElement).click();
    await flush();
    expect(row.lastElementChild).toBe(last);
    key($('focus-more'), 'Escape');
  });
});
