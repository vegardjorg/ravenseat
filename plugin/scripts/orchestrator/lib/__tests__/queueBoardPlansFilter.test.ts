/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardPlansFilter.test.ts: the Filter and Sort menus in the Plans room (P4 of
// plans/plans-tab-ux-review-2026-11-19.md), drawn by plans/filter.js on the Roadmap and on Plan entries.
//
// What the tests prove:
//   - one Filter button that says what is in use ("Filter", "Filter · 2", "Filter · Inbox"), with aria-expanded and
//     aria-controls, and a menu like the Tasks room's: Show all, Quick filters (name plus a short line), Saved (own
//     views with Delete and "Save current as…"), then the sections with counts and Reset,
//   - a quick or saved filter is applied through the helpers, a checkbox adds or removes one value,
//   - a Sort button that names the sort in use and a menu with one pressed choice,
//   - below 600 px one "Filter and sort" button opens a tray with Sort, the extra view controls and the filter,
//   - Escape closes a menu with focus back on its button, the arrow keys move between the rows,
//   - the old left column is gone from plans.js, the toolbar sits on the Roadmap and on Plan entries, `f` opens Filter,
//   - nothing is set with innerHTML, and the CSS uses tokens only.
// The view is the repo's own plans/filter.js, run in jsdom with the real QueuePlanView (no real data).
// =============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const V = require('../queuePlanView.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const filterJs = readFileSync(join(CLIENT, 'plans', 'filter.js'), 'utf8');

type Post = Record<string, unknown>;

function entry(id: string, extra: Post = {}): Post {
  return {
    id,
    title: `Title ${id}`,
    summary: null,
    project: 'auth',
    module: 'account',
    priority: 'later',
    now_category: [],
    priority_set_by: 'owner',
    maturity: 'idea',
    size: 'M',
    deadline: null,
    sources: [],
    ownerQuestions: [],
    legal_open: 0,
    stale: false,
    finished: 0,
    total: 0,
    queue: [],
    active: null,
    inbox: null,
    lead: null,
    history: [],
    depends_on: [],
    blocks: [],
    ...extra,
  };
}

const DATA = {
  exists: true,
  modules: [{ oid: 'account', title: 'Account' }],
  projects: {},
  entries: [
    entry('PL-A', { priority: 'now', maturity: 'partial', total: 2, finished: 1 }),
    entry('PL-B', { inbox: { by: 'track' } }),
    entry('PL-C'),
  ],
};

function el(tag: string, attr: Record<string, unknown> | null, ...children: unknown[]) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attr ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = String(v);
    else if (k === 'text') e.textContent = String(v);
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v as EventListener);
    else if (k.startsWith('--')) e.style.setProperty(k, String(v));
    else e.setAttribute(k, v === true ? '' : String(v));
  }
  for (const b of (children as unknown[]).flat()) if (b != null && b !== false) e.append(b as Node);
  return e;
}

function setup({ width = 1440, search = '?room=plans&surface=roadmap', menu = null as string | null, own = [] as Post[], sort = 'roadmap', saveAs = false } = {}) {
  const w: any = { QueuePlanView: V };
  new Function('window', filterJs)(w);
  const calls: Record<string, unknown[]> = { menu: [], newFilter: [], view: [], sort: [], save: [], del: [], showAll: [], saveAs: [] };
  const state = V.readUrl(search);
  const h = {
    el,
    state: () => state,
    data: () => DATA,
    width: () => width,
    menu: () => menu,
    setMenu: (name: string | null, focus?: string) => calls.menu.push([name, focus ?? null]),
    ownViews: () => own,
    saveView: (name: string) => calls.save.push(name),
    deleteView: (name: string) => calls.del.push(name),
    saveAsOpen: () => saveAs,
    setSaveAsOpen: (v: boolean) => calls.saveAs.push(v),
    newFilter: (filter: Post, extra?: Post) => calls.newFilter.push([filter, extra ?? null]),
    applyView: (v: Post) => calls.view.push(v),
    showAll: () => calls.showAll.push(true),
    sort: () => sort,
    setSort: (id: string) => calls.sort.push(id),
  };
  return { F: w.QueuePlanFilter, h, calls };
}

function draw(o: Parameters<typeof setup>[0] = {}, opts: Post = { sort: true }) {
  const { F, h, calls } = setup(o);
  const node = F.controls(h, DATA, opts);
  document.body.replaceChildren(node);
  return { node, calls };
}

describe('the Filter button', () => {
  it('says "Filter" and is a closed menu button by default', () => {
    const { node } = draw();
    const b = node.querySelector('[data-focus="plans-filter"]') as HTMLElement;
    expect(b.textContent).toBe('Filter');
    expect(b.getAttribute('aria-expanded')).toBe('false');
    expect(b.getAttribute('aria-controls')).toBe('plans-filter-menu');
    expect(b.classList.contains('filter-fixed')).toBe(true);
    expect(node.querySelector('#plans-filter-menu')).toBe(null);
  });

  it('names the quick filter or the count in use', () => {
    expect(draw({ search: '?room=plans&hz=inbox' }).node.querySelector('[data-focus="plans-filter"]')?.textContent).toBe(
      'Filter · Inbox',
    );
    const two = draw({ search: '?room=plans&pri=now&mod=idea' }).node.querySelector('[data-focus="plans-filter"]') as HTMLElement;
    expect(two.textContent).toBe('Filter · 2');
    expect(two.getAttribute('aria-label')).toBe('Filter, 2 active');
    expect(two.classList.contains('active')).toBe(true);
  });

  it('a click opens the menu with focus on the first row', () => {
    const { node, calls } = draw();
    (node.querySelector('[data-focus="plans-filter"]') as HTMLElement).click();
    expect(calls.menu.at(-1)).toEqual(['filter', 'pf-quick:waiting']);
  });
});

describe('the Filter menu', () => {
  it('Quick filters with a short line each, then Saved, then the sections with counts, then Reset', () => {
    const { node } = draw({ menu: 'filter' });
    const menu = node.querySelector('#plans-filter-menu') as HTMLElement;
    expect(menu.getAttribute('aria-label')).toBe('Filter');
    expect(node.querySelector('[data-focus="plans-filter"]')?.getAttribute('aria-expanded')).toBe('true');
    const heads = [...menu.querySelectorAll('h3')].map((x) => x.textContent);
    expect(heads.slice(0, 2)).toEqual(['Quick filters', 'Saved']);
    expect(heads).toContain('Horizon');
    expect(heads).toContain('Has tasks');
    expect(heads.indexOf('Horizon')).toBeLessThan(heads.indexOf('Area'));
    const quick = menu.querySelector('[data-focus="pf-quick:inbox"]') as HTMLElement;
    expect(quick.getAttribute('aria-label')).toBe('Inbox');
    expect(document.getElementById(String(quick.getAttribute('aria-describedby')))?.textContent).toBe(
      'Reported or captured, not sorted yet.',
    );
    expect(menu.querySelector('.empty')?.textContent).toBe('No saved filters yet.');
    const inboxBox = menu.querySelector('#pf-horizon-inbox') as HTMLInputElement;
    expect(inboxBox.type).toBe('checkbox');
    expect(menu.querySelector('label[for="pf-horizon-inbox"] .filter-count')?.textContent).toBe('1');
    const reset = menu.querySelector('[data-focus="pf-reset"]') as HTMLButtonElement;
    expect(reset.disabled).toBe(true);
    // nothing narrows, so no Show all
    expect(menu.querySelector('[data-focus="pf-show-all"]')).toBe(null);
  });

  it('a quick filter is applied through the helpers', () => {
    const { node, calls } = draw({ menu: 'filter' });
    (node.querySelector('[data-focus="pf-quick:inbox"]') as HTMLElement).click();
    expect((calls.view.at(-1) as Post).name).toBe('Inbox');
  });

  it('the one in use is marked', () => {
    const { node } = draw({ menu: 'filter', search: '?room=plans&hz=inbox' });
    expect(node.querySelector('[data-focus="pf-quick:inbox"]')?.getAttribute('aria-current')).toBe('true');
    expect(node.querySelector('[data-focus="pf-quick:stale"]')?.getAttribute('aria-current')).toBe(null);
  });

  it('a checkbox adds or removes one value', () => {
    const { node, calls } = draw({ menu: 'filter', search: '?room=plans&pri=now' });
    const box = node.querySelector('#pf-horizon-now') as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event('change'));
    const [filter] = calls.newFilter.at(-1) as [Post];
    expect(filter.horizon).toEqual(['now']);
    expect(filter.pri).toEqual(['now']);
    const pri = node.querySelector('#pf-pri-now') as HTMLInputElement;
    expect(pri.checked).toBe(true);
    pri.checked = false;
    pri.dispatchEvent(new Event('change'));
    expect(((calls.newFilter.at(-1) as [Post])[0]).pri).toEqual([]);
  });

  it('Show all and Reset when something narrows', () => {
    const { node, calls } = draw({ menu: 'filter', search: '?room=plans&pri=now&q=sync' });
    (node.querySelector('[data-focus="pf-show-all"]') as HTMLElement).click();
    expect(calls.showAll.length).toBe(1);
    const reset = node.querySelector('[data-focus="pf-reset"]') as HTMLButtonElement;
    expect(reset.disabled).toBe(false);
    reset.click();
    expect(calls.newFilter.at(-1)).toEqual([V.emptyFilter(), null]);
  });

  it('Saved: the own views with Delete, and "Save current as…" opens a name field', () => {
    const own = [{ name: 'Mine', search: '?room=plans&pri=now' }];
    const { node, calls } = draw({ menu: 'filter', own });
    const row = node.querySelector('[data-focus="pf-own:0"]') as HTMLElement;
    expect(row.getAttribute('aria-label')).toBe('Mine');
    row.click();
    expect((calls.view.at(-1) as Post).name).toBe('Mine');
    (node.querySelector('[data-focus="pf-delete:0"]') as HTMLElement).click();
    expect(calls.del).toEqual(['Mine']);
    (node.querySelector('[data-focus="pf-save-as"]') as HTMLElement).click();
    expect(calls.saveAs).toEqual([true]);
    const open = draw({ menu: 'filter', own, saveAs: true });
    const input = open.node.querySelector('[data-focus="pf-save-name"]') as HTMLInputElement;
    expect(input.getAttribute('aria-label')).toBe('Name of the saved filter');
    input.value = 'Auth now';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(open.calls.save).toEqual(['Auth now']);
  });

  it('Escape closes the menu with focus back on Filter', () => {
    const { node, calls } = draw({ menu: 'filter' });
    const quick = node.querySelector('[data-focus="pf-quick:inbox"]') as HTMLElement;
    quick.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(calls.menu.at(-1)).toEqual([null, 'plans-filter']);
  });

  it('the arrow keys move between the rows', () => {
    const { node } = draw({ menu: 'filter' });
    const first = node.querySelector('[data-focus="pf-quick:waiting"]') as HTMLElement;
    first.focus();
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect((document.activeElement as HTMLElement).dataset.focus).toBe('pf-quick:inbox');
  });
});

describe('the Sort menu', () => {
  it('the button names the sort in use; the menu has one pressed choice with a short line', () => {
    const { node } = draw({ sort: 'deadline', menu: 'sort' });
    const b = node.querySelector('[data-focus="plans-sort"]') as HTMLElement;
    expect(b.textContent).toBe('Sort: Deadline');
    expect(b.getAttribute('aria-expanded')).toBe('true');
    const menu = node.querySelector('#plans-sort-menu') as HTMLElement;
    const pressed = [...menu.querySelectorAll('[aria-pressed="true"]')].map((x) => x.getAttribute('aria-label'));
    expect(pressed).toEqual(['Deadline']);
    expect(menu.querySelectorAll('.view-explain').length).toBe(V.PLAN_SORTS.length);
  });

  it('a choice sets the sort and closes the menu on the Sort button', () => {
    const { node, calls } = draw({ menu: 'sort' });
    (node.querySelector('[data-focus="pf-sort:title"]') as HTMLElement).click();
    expect(calls.sort).toEqual(['title']);
    expect(calls.menu.at(-1)).toEqual([null, 'plans-sort']);
  });

  it('left out where the order does not apply (the maps)', () => {
    const { node } = draw({}, { sort: false });
    expect(node.querySelector('[data-focus="plans-sort"]')).toBe(null);
  });
});

describe('narrow: one "Filter and sort" button and a tray', () => {
  it('below 600 px the two buttons become one', () => {
    const { node } = draw({ width: 390, search: '?room=plans&pri=now' });
    expect(node.querySelector('[data-focus="plans-filter"]')).toBe(null);
    expect(node.querySelector('[data-focus="plans-sort"]')).toBe(null);
    const b = node.querySelector('[data-focus="plans-tray"]') as HTMLElement;
    expect(b.textContent).toBe('Filter and sort · 1');
    expect(b.getAttribute('aria-controls')).toBe('plans-tray-menu');
  });

  it('the tray holds Sort, the extra view controls and the filter', () => {
    const { F, h } = setup({ width: 390, menu: 'tray' });
    const extra = el('div', { class: 'extra-toggles', text: 'Group by' });
    const node = F.controls(h, DATA, { sort: true, trayExtra: [extra] });
    document.body.replaceChildren(node);
    const tray = node.querySelector('#plans-tray-menu') as HTMLElement;
    const heads = [...tray.querySelectorAll('h3')].map((x) => x.textContent);
    expect(heads.slice(0, 4)).toEqual(['Sort', 'View', 'Quick filters', 'Saved']);
    expect(tray.querySelector('.extra-toggles')).toBeTruthy();
    expect(tray.querySelector('#pf-horizon-inbox')).toBeTruthy();
  });
});

describe('the code', () => {
  const plans = readFileSync(join(CLIENT, 'plans', 'plans.js'), 'utf8');
  const roadmap = readFileSync(join(CLIENT, 'plans', 'roadmap.js'), 'utf8');
  const work = readFileSync(join(CLIENT, 'plans', 'work.js'), 'utf8');
  const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
  const server = readFileSync(join(CLIENT, '..', 'queue-board.mjs'), 'utf8');
  const css = readFileSync(join(CLIENT, 'plans', 'plans.css'), 'utf8');

  it('loaded before plans.js and served', () => {
    expect(html.indexOf('/plans/filter.js')).toBeGreaterThan(0);
    expect(html.indexOf('/plans/filter.js')).toBeLessThan(html.indexOf('/plans/plans.js'));
    expect(server).toContain("'/plans/filter.js'");
  });

  it('the left filter column is gone from Plan entries; the toolbar is on the Roadmap and Plan entries', () => {
    expect(plans).not.toMatch(/function filtersEl/);
    expect(plans).toMatch(/QueuePlanFilter\.controls\(/);
    expect(roadmap).toMatch(/h\.filterControls/);
    // the saved views keep their storage key, so views saved before carry over
    expect(plans).toContain("'queue-board-plans-views'");
  });

  it('f opens the Filter menu', () => {
    expect(V.keyAction({ key: 'f' })).toEqual({ type: 'filter' });
    expect(work).toMatch(/t\.type === 'filter'/);
  });

  it('no innerHTML in filter.js, and the CSS of the toolbar uses tokens only', () => {
    expect(filterJs).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
    const start = css.indexOf('/* ---- The Filter and Sort menus');
    expect(start).toBeGreaterThan(0);
    const end = css.indexOf('/* ---- end of the Filter and Sort menus');
    expect(end).toBeGreaterThan(start);
    expect(css.slice(start, end)).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
});
