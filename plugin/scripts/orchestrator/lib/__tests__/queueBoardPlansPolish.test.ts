/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardPlansPolish.test.ts: the polish of the Plans room (P9 of plans/plans-tab-ux-review-2026-11-19.md,
// sections 7.6 and 7.7).
//
// What the tests prove:
//   - empty states: no match names the search and the filter count and offers Clear search and Clear filter (each only
//     when it applies); a plan without a plan document gets a short empty state that says what happens next; Plan
//     entries uses the same words as the Roadmap,
//   - the plan page's "Also:" lists only the sources that are not already open in the reader,
//   - the breadcrumb's start lines sit in one "Copy start line" menu instead of a Copy button per part,
//   - the deadline band is only drawn when there is a deadline,
//   - a screen reader hears how many plans match after a search or filter change (one live region outside the redraw),
//   - the layout: the Roadmap's column headers stick while scrolling, the Inbox buttons are compact in the columns,
//     the room tabs never wrap at narrow width, and the mascot's bubble never covers the top controls on a phone,
//   - tokens only (no raw hex) in the new CSS, and no innerHTML.
// The views are the repo's own plans/*.js, run in jsdom with the real QueuePlanView (no real data).
// =============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const V = require('../queuePlanView.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const CLIENT = join(__dirname, '..', '..', 'queue-board');
// the files as text with plain line ends (the working tree may have CRLF)
const read = (...parts: string[]) => readFileSync(join(CLIENT, ...parts), 'utf8').replace(/\r\n/g, '\n');
const roadmapJs = read('plans', 'roadmap.js');
const readJs = read('plans', 'read.js');
const mapJs = read('plans', 'map.js');
const triageJs = read('plans', 'triage.js');
const plansJs = read('plans', 'plans.js');
const css = read('plans', 'plans.css');
const boardCss = read('board.css');

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

function data(entries: Post[]) {
  return {
    exists: true,
    modules: [{ oid: 'account', title: 'Account' }],
    projects: { auth: { area: 'account', title: 'Auth' } },
    entries,
    documents: [],
    view: { startView: 'roadmap', roadmapLayout: 'auto', roadmapFoldAfter: 8 },
  };
}

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
  for (const b of (children as unknown[]).flat())
    if (b != null && b !== false) e.append(typeof b === 'string' ? document.createTextNode(b) : (b as Node));
  return e;
}

/** A CSS rule's body by its exact selector (the first match), or ''. */
function rule(text: string, selector: string, from = 0): string {
  const at = text.indexOf(`${selector} {`, from);
  if (at < 0) return '';
  return text.slice(at, text.indexOf('}', at) + 1);
}

describe('the rules (queuePlanView.js)', () => {
  it('otherSources leaves out the source that is open in the reader', () => {
    const p = entry('PL-A', {
      sources: [
        { path: 'docs/plans/a.md', anchor: '§ 1', role: 'plan' },
        { path: 'docs/plans/a.md', anchor: '§ 2' },
        { path: 'docs/design/a.md' },
        { path: '../outside.md' },
      ],
    });
    const shown = { path: 'docs/plans/a.md', anchor: '§ 1' };
    expect(V.otherSources(p, shown).map((k: Post) => `${k.path} ${k.anchor ?? ''}`.trim())).toEqual([
      'docs/plans/a.md § 2',
      'docs/design/a.md',
    ]);
    // a followed link (not a source) leaves all the readable sources in the list
    expect(V.otherSources(p, { path: 'docs/other.md', anchor: null })).toHaveLength(3);
    // the same path without an anchor is another place than the path at § 1
    const two = entry('PL-B', { sources: [{ path: 'docs/a.md' }, { path: 'docs/a.md', anchor: '§ 1' }] });
    expect(V.otherSources(two, { path: 'docs/a.md', anchor: null })).toEqual([{ path: 'docs/a.md', anchor: '§ 1' }]);
  });

  it('planDocEmpty says what is missing and what happens next', () => {
    expect(V.planDocEmpty(entry('PL-A', { sources: [{ path: 'docs/plans/a.md' }] }))).toBeNull();
    const none = V.planDocEmpty(entry('PL-B'));
    expect(none.title).toBe('No plan document yet');
    expect(none.text).toMatch(/Claude writes one when the plan is shaped/);
    const outside = V.planDocEmpty(entry('PL-C', { sources: [{ path: '../secret.md' }] }));
    expect(outside.title).toBe('The plan document is not shown here');
    expect(outside.text).toMatch(/outside the document folders/);
  });

  it('pathCopyItems: one menu row per part with a start line, named by its level', () => {
    const d = data([entry('PL-AUTH')]);
    const parts = V.breadcrumbs({ surface: 'entries', entry: 'PL-AUTH', filter: V.emptyFilter() }, d);
    const items = V.pathCopyItems(parts);
    expect(items.length).toBeGreaterThan(0);
    for (const x of items) {
      expect(typeof x.line).toBe('string');
      expect(x.label).toMatch(/^(Area|Project|Plan): /);
    }
    expect(items.at(-1).label).toBe(`Plan: ${parts.at(-1).text}`);
    // the Roadmap's parts carry no start line, so no menu
    expect(V.pathCopyItems(V.breadcrumbs({ surface: 'roadmap', entry: null, filter: V.emptyFilter() }, d))).toEqual([]);
  });

  it('noMatchText names the search and the filter count (section 7.6)', () => {
    expect(V.noMatchText('sync', 2)).toBe('No plans match "sync" with Filter · 2.');
    expect(V.noMatchText('sync', 0)).toBe('No plans match "sync".');
    expect(V.noMatchText('', 1)).toBe('No plans match Filter · 1.');
  });

  it('matchAnnouncement is a short sentence for the live region', () => {
    expect(V.matchAnnouncement(0, true)).toBe('No plans match.');
    expect(V.matchAnnouncement(1, true)).toBe('1 plan matches.');
    expect(V.matchAnnouncement(3, true)).toBe('3 plans match.');
    expect(V.matchAnnouncement(9, false)).toBe('Showing all 9 plans.');
  });
});

describe('the Roadmap and the plan page (roadmap.js)', () => {
  function setup(state: Post = {}) {
    const w: any = { QueuePlanView: V };
    new Function('window', roadmapJs)(w);
    const used: Post[] = [];
    const t = { filter: V.emptyFilter(), search: '', surface: 'roadmap', entry: null, ...state };
    const h = {
      el,
      state: () => t,
      use: (change: Post) => used.push(change),
      width: () => 1000,
      prefs: () => ({ layout: null, group: 'horizon', compact: false }),
      setPref: () => {},
      isExpanded: () => false,
      toggleExpanded: () => {},
      detailsOpen: () => false,
      setDetailsOpen: () => {},
      activeFilters: () => el('div', { class: 'plans-chips' }),
      copyButton: () => el('button', { text: 'Copy' }),
      cliChip: (c: string) => el('span', { class: 'cli-chip' }, el('code', { text: c })),
      tabContent: (tab: string) => el('div', { class: `stub-tab-${tab}` }),
      planDocument: (p: Post) => el('div', { class: 'stub-doc', text: `doc of ${p.id}` }),
      showInQueue: () => {},
      search: () => {},
      date: (x: string) => x,
    };
    return { R: w.QueuePlanRoadmap, h, used };
  }

  it('no match with a search and a filter: the words name both, and each has its own Clear button', () => {
    const f = V.emptyFilter();
    f.pri = ['now'];
    const { R, h, used } = setup({ search: 'zzz', filter: f });
    const node = R.cells(h, data([entry('PL-A')]), []);
    expect(node.querySelector('.empty p')?.textContent).toBe('No plans match "zzz" with Filter · 1.');
    const buttons = [...node.querySelectorAll('.empty button')] as HTMLElement[];
    expect(buttons.map((b) => b.textContent)).toEqual(['Clear search', 'Clear filter']);
    buttons[0].click();
    expect(used.at(-1)).toEqual({ search: '' });
    buttons[1].click();
    expect(used.at(-1)).toEqual({ filter: V.emptyFilter() });
  });

  it('no match with only a search offers only Clear search', () => {
    const { R, h } = setup({ search: 'zzz' });
    const node = R.cells(h, data([entry('PL-A')]), []);
    expect([...node.querySelectorAll('.empty button')].map((b) => b.textContent)).toEqual(['Clear search']);
  });

  it('a plan without a plan document gets a short empty state instead of small text', () => {
    const { R, h } = setup({ entry: 'PL-N' });
    const page = R.page(h, data([entry('PL-N')]), entry('PL-N'));
    const doc = page.querySelector('.plans-page-doc') as HTMLElement;
    const box = doc.querySelector('.plans-page-empty') as HTMLElement;
    expect(box).toBeTruthy();
    expect(box.querySelector('.plans-page-empty-title')?.textContent).toBe('No plan document yet');
    expect(box.textContent).toMatch(/Claude writes one/);
    // no reader is drawn for a plan without a document
    expect(doc.querySelector('.stub-doc')).toBeNull();
  });

  it('a plan with a document still gets the reader', () => {
    const { R, h } = setup({ entry: 'PL-D' });
    const p = entry('PL-D', { sources: [{ path: 'docs/plans/d.md', role: 'plan' }] });
    const page = R.page(h, data([p]), p);
    expect(page.querySelector('.plans-page-doc .stub-doc')).toBeTruthy();
    expect(page.querySelector('.plans-page-empty')).toBeNull();
  });
});

describe('the plan document: "Also:" (read.js)', () => {
  function reader() {
    const w: any = { QueuePlanView: V };
    (globalThis as any).fetch = () => new Promise(() => {});
    new Function('window', readJs)(w);
    const h = { el, date: (x: string) => x, copyButton: () => el('button', { text: 'Copy' }), draw: () => {} };
    return { R: w.QueuePlanRead, h };
  }

  it('lists only the sources that are not open in the reader', () => {
    const { R, h } = reader();
    const p = entry('PL-ALSO', {
      sources: [
        { path: 'docs/plans/auth.md', anchor: '§ 1', role: 'plan' },
        { path: 'docs/plans/auth.md', anchor: '§ 2' },
        { path: 'docs/design/auth.md' },
      ],
    });
    const node = R.planDocument(h, p);
    expect([...node.querySelectorAll('.plans-page-also button')].map((b: any) => b.textContent)).toEqual([
      'docs/plans/auth.md § 2',
      'docs/design/auth.md',
    ]);
  });

  it('a plan with one source has no "Also:" line', () => {
    const { R, h } = reader();
    const node = R.planDocument(h, entry('PL-ONE', { sources: [{ path: 'docs/plans/one.md', role: 'plan' }] }));
    expect(node.querySelector('.plans-page-also')).toBeNull();
  });
});

describe('the deadline band (map.js)', () => {
  function band(entries: Post[]) {
    const w: any = { QueuePlanView: V, addEventListener: () => {} };
    new Function('window', mapJs)(w);
    return w.QueuePlanMap.deadlineBand({ el, message: () => {}, draw: () => {} }, data(entries), null);
  }

  it('is not drawn when nothing has a deadline', () => {
    expect(band([entry('PL-A')])).toBeNull();
  });

  it('is drawn when a plan has a deadline in the window', () => {
    const soon = new Date(Date.now() + 10 * 86400000).toISOString().slice(0, 10);
    const node = band([entry('PL-A', { deadline: soon })]);
    expect(node?.classList.contains('deadlineBand')).toBe(true);
  });
});

describe('the wiring (plans.js, triage.js)', () => {
  it('the breadcrumb has one Copy start line menu, not a Copy button per part', () => {
    const path = plansJs.slice(plansJs.indexOf('function pathEl('), plansJs.indexOf('// ---- The toolbar'));
    expect(path).not.toMatch(/copyButton\(/);
    expect(path).toMatch(/V\.pathCopyItems\(/);
    expect(path).toMatch(/plans-path-copy/);
  });

  it('one live region outside the room says how many plans match after a search or filter change', () => {
    expect(plansJs).toMatch(/'aria-live': 'polite'/);
    expect(plansJs).toMatch(/V\.matchAnnouncement\(/);
    // it sits outside the room, so the redraw does not replace it
    expect(plansJs).toMatch(/room\.after\(live\)/);
  });

  it('the scroll position keeps its sideways part too (the Roadmap columns)', () => {
    expect(plansJs).toMatch(/scrollLeft/);
  });

  it('Merge names its plan, and the plan id can be hidden in the narrow columns while the name stays whole', () => {
    expect(triageJs).toMatch(/plans-triage-target/);
    expect(triageJs).toMatch(/'aria-label': target \? `\$\{text\}\$\{target\}` : null/);
    expect(triageJs).toMatch(/action\(h, p, 'merge', 'Merge', '4', [^\n]*` into \$\{dup\.id\}`\)/);
  });
});

describe('the layout (plans.css, board.css)', () => {
  it('the Roadmap column headers stick while the Roadmap scrolls', () => {
    const r = rule(css, '.roadmap-section .col-header');
    expect(r).toMatch(/position: sticky/);
    expect(r).toMatch(/top: 0/);
    expect(r).toMatch(/background: var\(--color-/);
    // the columns are no scroll box of their own (a sticky header would stick to it, not to the Roadmap)
    expect(rule(css, '.roadmap-columns')).not.toMatch(/overflow-x: auto/);
    // the columns are as tall as the tallest, so an empty column keeps its header too
    expect(rule(css, '.roadmap-columns')).toMatch(/align-items: stretch/);
    // the columns are the scroll box under a fixed toolbar, and keep their place across a redraw
    expect(rule(css, '.plans-roadmap-scroll:has(> .roadmap > .roadmap-columns) .roadmap-columns')).toMatch(/flex: 1/);
    expect(roadmapJs).toMatch(/'data-scroll': layout === 'columns' \? 'roadmap-columns' : null/);
  });

  it('the Inbox buttons are compact in the columns, in one row that wraps', () => {
    expect(rule(css, '.roadmap-columns .plans-triage-button')).toMatch(/padding: 0 var\(--distance-sm\)/);
    expect(rule(css, '.roadmap-columns .plans-triage-key')).toMatch(/display: none/);
    expect(rule(css, '.roadmap-columns .plans-triage-target')).toMatch(/display: none/);
  });

  it('the room tabs never wrap at narrow width: they scroll sideways in their own row', () => {
    // the phone block of the Roadmap (the one that holds the tab list's narrow rule)
    const narrow = css.slice(css.indexOf('@media (max-width: 699px) {\n  .plans-roadmap-scroll'));
    const r = rule(narrow, '  .plans-surfaces');
    expect(r).toMatch(/flex-wrap: nowrap/);
    expect(r).toMatch(/overflow-x: auto/);
    expect(r).not.toMatch(/flex-wrap: wrap/);
  });

  it('the plan document empty state and the copy menu use tokens', () => {
    expect(rule(css, '.plans-page-empty')).toMatch(/var\(--color-outline/);
    expect(rule(css, '.plans-path-copy-list')).toMatch(/var\(--color-surface/);
  });

  it('on a phone the mascot bubble sits at the bottom, never over the tabs and the breadcrumb', () => {
    const phone = boardCss.slice(boardCss.indexOf('@media (max-width: 720px) {\n  /* The only place'));
    const r = rule(phone, '  .bubble');
    expect(r).toMatch(/position: fixed/);
    expect(r).toMatch(/bottom:/);
    expect(r).toMatch(/top: auto/);
  });

  it('no raw hex in the new P9 CSS', () => {
    const p9 = css.slice(css.indexOf('/* ---- P9 polish'));
    expect(p9.length).toBeGreaterThan(50);
    expect(p9).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it('no innerHTML in the files P9 touches', () => {
    for (const js of [roadmapJs, readJs, mapJs, triageJs, plansJs]) expect(js).not.toMatch(/\.innerHTML\s*=/);
  });
});
