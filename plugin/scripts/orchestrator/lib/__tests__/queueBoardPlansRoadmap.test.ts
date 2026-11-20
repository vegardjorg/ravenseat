/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardPlansRoadmap.test.ts: the Roadmap and the plan page in the Plans room (P1 and P2 of
// plans/plans-tab-ux-review-2026-11-19.md; concept B, with the horizons as columns on a wide screen).
//
// What the tests prove:
//   - the roadmap reads top to bottom: one section per horizon with a heading and its count ("Now, 2 plans"), each plan
//     a list item whose button name is the title and whose description is the status line (status, area, next step),
//   - the row shows the person's summary, else the lead from the plan document (marked), else "No summary yet",
//   - a wide screen gets the horizons side by side as columns (the Queue's column header), a narrow one a list, and
//     the layout toggle saves the viewer's choice,
//   - 300+ plans stay readable: long sections fold past N with "Show n more", Done is folded, a search unfolds all,
//     and Compact gives one line per plan,
//   - the plan page leads with the title, the status sentence and the summary, then the actions, the plan document and
//     the tasks; the technical facts are last under Details, closed by default and remembered; the CLI lines are chips
//     under More,
//   - nothing is set with innerHTML.
// The view is the repo's own plans/roadmap.js, run in jsdom with the real QueuePlanView (no real data).
// =============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const V = require('../queuePlanView.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const roadmapJs = readFileSync(join(CLIENT, 'plans', 'roadmap.js'), 'utf8');
const css = readFileSync(join(CLIENT, 'plans', 'plans.css'), 'utf8');

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
    modules: [
      { oid: 'account', title: 'Account' },
      { oid: 'data', title: 'Data and sync' },
    ],
    projects: {},
    entries,
    view: { startView: 'roadmap', roadmapLayout: 'auto', roadmapFoldAfter: 8, leadFromDocument: true },
  };
}

/** The same small element helper as plans.js. */
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

function setup({ width = 1440, prefs = {}, state = {}, detailsOpen = false } = {}) {
  const w: any = { QueuePlanView: V };
  new Function('window', roadmapJs)(w);
  const calls: { use: Post[]; prefs: Post[]; details: boolean[]; expanded: string[] } = {
    use: [],
    prefs: [],
    details: [],
    expanded: [],
  };
  const expanded = new Set<string>();
  const t = { filter: V.emptyFilter(), search: '', surface: 'roadmap', entry: null, ...state };
  const h = {
    el,
    state: () => t,
    use: (change: Post) => calls.use.push(change),
    width: () => width,
    prefs: () => ({ layout: null, group: 'horizon', compact: false, ...prefs }),
    setPref: (p: Post) => calls.prefs.push(p),
    isExpanded: (id: string) => expanded.has(id),
    toggleExpanded: (id: string) => {
      calls.expanded.push(id);
      if (expanded.has(id)) expanded.delete(id);
      else expanded.add(id);
    },
    detailsOpen: () => detailsOpen,
    setDetailsOpen: (v: boolean) => calls.details.push(v),
    activeFilters: () => el('div', { class: 'plans-chips' }),
    copyButton: (text: string, label: string) => el('button', { type: 'button', text: 'Copy', 'aria-label': label }),
    cliChip: (command: string) => el('span', { class: 'cli-chip' }, el('code', { text: command })),
    tabContent: (tab: string) => el('div', { class: `stub-tab-${tab}`, text: `tab ${tab}` }),
    planDocument: (p: Post) => el('div', { class: 'stub-doc', text: `doc of ${p.id}` }),
    showInQueue: () => {},
    search: (value: string) => calls.use.push({ search: value }),
    date: (x: string) => x,
  };
  return { w, h, calls };
}

function draw(entries: Post[], o: Parameters<typeof setup>[0] = {}) {
  const { w, h, calls } = setup(o);
  const d = data(entries);
  const match = V.filter(d.entries, h.state().filter, h.state().search);
  const node = w.QueuePlanRoadmap.cells(h, d, match);
  document.body.replaceChildren(node);
  return { node, calls, w, h, d };
}

const MIX = [
  entry('PL-ASK', { priority: 'owner', ownerQuestions: [{ id: 'Q-OFF', resolved: false }] }),
  entry('PL-AUTH', {
    priority: 'now',
    maturity: 'partial',
    finished: 3,
    total: 7,
    summary: 'Users get accounts so they keep their streaks when they change phones.',
  }),
  entry('PL-BILL', { priority: 'now', maturity: 'ready', lead: { text: 'Charge for the pro plan.', path: 'docs/b.md' } }),
  entry('PL-SOCIAL', { priority: 'later', module: 'data' }),
  entry('PL-DONE', { maturity: 'built' }),
];

describe('the roadmap reads top to bottom', () => {
  it('one section per horizon, with a heading and its count', () => {
    const { node } = draw(MIX, { width: 1000 });
    const heads = [...node.querySelectorAll('.roadmap-section')].map((s) => s.getAttribute('aria-label'));
    expect(heads).toEqual(['Waiting on you, 1 plan', 'Now, 1 plan', 'Next, 1 plan', 'Later, 1 plan', 'Done, 1 plan']);
    expect(node.querySelector('.roadmap-section h2')?.textContent).toBe('Waiting on you');
    expect(node.querySelector('.roadmap-section .counter')?.textContent).toBe('1');
  });

  it('a plan is a list item: the title is the button, the status line describes it', () => {
    const { node } = draw(MIX, { width: 1000 });
    const card = node.querySelector('[data-roadmap-entry="PL-AUTH"]') as HTMLElement;
    expect(card.tagName).toBe('LI');
    const button = card.querySelector('button.roadmap-card-link') as HTMLElement;
    expect(button.textContent).toBe('Title PL-AUTH');
    // P4: the card describes itself with its status line and, for a plan with tasks, its progress in words
    const [lineId, progressId] = String(button.getAttribute('aria-describedby')).split(' ');
    const line = document.getElementById(lineId);
    expect(line?.textContent).toBe('Being built: 3 of 7 tasks done · Account');
    const progress = document.getElementById(progressId) as HTMLElement;
    expect(progress.textContent).toBe('43% done');
    expect(progress.querySelector('.plans-progress-bar')?.getAttribute('aria-hidden')).toBe('true');
    expect((progress.querySelector('.plans-progress-fill') as HTMLElement).style.getPropertyValue('--progress')).toBe('43%');
    expect(card.querySelector('.roadmap-card-sentence')?.textContent).toBe(
      'Users get accounts so they keep their streaks when they change phones.',
    );
  });

  it('the next step and warnings are words in the line', () => {
    const { node } = draw(MIX, { width: 1000 });
    const line = node.querySelector('[data-roadmap-entry="PL-ASK"] .roadmap-card-line');
    expect(line?.textContent).toBe('Waiting on your answer to Q-OFF · Account · Answer Q-OFF');
  });

  it('the lead from the document is shown and marked; without either it says "No summary yet"', () => {
    const { node } = draw(MIX, { width: 1000 });
    const lead = node.querySelector('[data-roadmap-entry="PL-BILL"] .roadmap-card-sentence') as HTMLElement;
    expect(lead.textContent).toBe('Charge for the pro plan.');
    expect(lead.classList.contains('from-document')).toBe(true);
    expect(lead.getAttribute('title')).toBe('From the plan document');
    expect(node.querySelector('[data-roadmap-entry="PL-SOCIAL"] .roadmap-card-sentence')?.textContent).toBe(
      'No summary yet',
    );
  });

  it('a click on the title opens the plan page', () => {
    const { node, calls } = draw(MIX, { width: 1000 });
    (node.querySelector('[data-roadmap-entry="PL-AUTH"] button') as HTMLElement).click();
    expect(calls.use.at(-1)).toEqual({ entry: 'PL-AUTH' });
  });
});

describe('the layout: columns on a wide screen, a list on a narrow one', () => {
  it('wide: the horizons side by side, with the Queue column header and empty columns kept', () => {
    const { node } = draw([entry('PL-1', { priority: 'now', maturity: 'ready' })], { width: 1440 });
    const cols = node.querySelector('.roadmap-body');
    expect(cols?.classList.contains('roadmap-columns')).toBe(true);
    expect([...node.querySelectorAll('.roadmap-section .col-header h2')].map((x) => x.textContent)).toEqual([
      'Waiting on you',
      'Now',
      'Next',
      'Later',
      'Done',
    ]);
  });

  it('narrow: one list, empty horizons left out', () => {
    const { node } = draw([entry('PL-1', { priority: 'now', maturity: 'ready' })], { width: 1000 });
    expect(node.querySelector('.roadmap-body')?.classList.contains('roadmap-list')).toBe(true);
    expect(node.querySelectorAll('.roadmap-section').length).toBe(1);
  });

  it('the toggle shows the layout in use and saves the viewer\'s choice', () => {
    const { node, calls } = draw(MIX, { width: 1440 });
    const group = node.querySelector('[aria-label="Layout"]') as HTMLElement;
    const [columns, list] = [...group.querySelectorAll('button')] as HTMLElement[];
    expect(columns.getAttribute('aria-pressed')).toBe('true');
    expect(list.getAttribute('aria-pressed')).toBe('false');
    list.click();
    expect(calls.prefs.at(-1)).toEqual({ layout: 'list' });
  });

  it('a remembered choice wins over the width', () => {
    const { node } = draw(MIX, { width: 1440, prefs: { layout: 'list' } });
    expect(node.querySelector('.roadmap-body')?.classList.contains('roadmap-list')).toBe(true);
  });

  it('group by area: one section per area with the built share', () => {
    const { node } = draw(MIX, { width: 1000, prefs: { group: 'area' } });
    const heads = [...node.querySelectorAll('.roadmap-section h2')].map((x) => x.textContent);
    expect(heads).toEqual(['Account', 'Data and sync']);
    expect(node.querySelector('.roadmap-section-note')?.textContent).toBe('1 of 4 built');
  });
});

describe('300+ plans', () => {
  const many = [
    ...Array.from({ length: 12 }, (_, i) => entry(`PL-L${i}`)),
    ...Array.from({ length: 3 }, (_, i) => entry(`PL-D${i}`, { maturity: 'built' })),
  ];

  it('a long section folds past N, Done is folded, each with a button that says how many', () => {
    const { node } = draw(many, { width: 1000 });
    const later = node.querySelector('.roadmap-section.h-later') as HTMLElement;
    expect(later.querySelectorAll('.roadmap-card').length).toBe(8);
    const more = later.querySelector('.roadmap-more') as HTMLElement;
    expect(more.textContent).toBe('Show 4 more');
    expect(more.getAttribute('aria-expanded')).toBe('false');
    const done = node.querySelector('.roadmap-section.h-done') as HTMLElement;
    expect(done.querySelectorAll('.roadmap-card').length).toBe(0);
    expect(done.querySelector('.roadmap-more')?.textContent).toBe('Show 3 done');
  });

  it('the fold button opens the section', () => {
    const { node, calls } = draw(many, { width: 1000 });
    (node.querySelector('.roadmap-section.h-later .roadmap-more') as HTMLElement).click();
    expect(calls.expanded).toEqual(['later']);
  });

  it('a search shows every match', () => {
    const { node } = draw(many, { width: 1000, state: { search: 'Title' } });
    expect(node.querySelectorAll('.roadmap-section.h-later .roadmap-card').length).toBe(12);
    expect(node.querySelectorAll('.roadmap-section.h-done .roadmap-card').length).toBe(3);
  });

  it('Compact gives one line per plan: no sentence', () => {
    const { node } = draw(MIX, { width: 1000, prefs: { compact: true } });
    expect(node.querySelector('.roadmap-body')?.classList.contains('compact')).toBe(true);
    expect(node.querySelectorAll('.roadmap-card-sentence').length).toBe(0);
    // P4: Compact keeps one line, so no progress row either
    expect(node.querySelectorAll('.roadmap-card-progress').length).toBe(0);
    expect(node.querySelector('[aria-label="Density"] button')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('the count says how many plans are shown', () => {
    const { node } = draw(many, { width: 1000 });
    expect(node.querySelector('.roadmap-count')?.textContent).toBe('15 plans');
  });
});

describe('empty states', () => {
  it('no register', () => {
    const { w, h } = setup({ width: 1000 });
    const node = w.QueuePlanRoadmap.cells(h, { ...data([]), exists: false }, []);
    expect(node.querySelector('.empty')?.textContent).toMatch(/^No plans yet\./);
  });

  it('no match names the search and offers to clear it', () => {
    const { node, calls } = draw(MIX, { width: 1000, state: { search: 'zzz' } });
    expect(node.querySelector('.empty p')?.textContent).toBe('No plans match "zzz".');
    // P9: Clear search clears only the search (Clear filter is its own button, shown when a filter is on)
    (node.querySelector('.empty button') as HTMLElement).click();
    expect(calls.use.at(-1)).toEqual({ search: '' });
  });
});

describe('the plan page: the plan first, the technical facts last', () => {
  function page(p: Post, o: Parameters<typeof setup>[0] = {}) {
    const { w, h, calls } = setup(o);
    const d = data([p]);
    const node = w.QueuePlanRoadmap.page(h, d, p);
    document.body.replaceChildren(node);
    return { node, calls };
  }
  const AUTH = entry('PL-AUTH', {
    priority: 'now',
    maturity: 'partial',
    finished: 3,
    total: 7,
    summary: 'Users get accounts so they keep their streaks.',
    queue: [
      { id: 'AUTH-3', title: 'Sessions', column: 'inProgress' },
      { id: 'AUTH-1', title: 'Accounts', column: 'built' },
    ],
    sources: [{ path: 'docs/plans/auth.md', anchor: '§ 1', role: 'plan' }],
  });

  it('title, status sentence with the next step, summary, then actions, document, tasks and Details, in that order', () => {
    const { node } = page(AUTH);
    expect(node.querySelector('h2')?.textContent).toBe('Title PL-AUTH');
    expect(node.querySelector('.plans-page-status')?.textContent).toBe(
      'Being built: 3 of 7 tasks done. Next: AUTH-3 is running.',
    );
    expect(node.querySelector('.plans-page-summary')?.textContent).toBe('Users get accounts so they keep their streaks.');
    const order = [
      '.plans-page-summary',
      '.plans-page-actions',
      '.plans-page-doc',
      '.plans-page-tasks',
      '.plans-page-details',
    ].map((s) => {
      const all = [...node.querySelectorAll('*')];
      return all.indexOf(node.querySelector(s) as Element);
    });
    expect(order.every((x) => x >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(node.querySelector('.plans-page-doc .stub-doc')?.textContent).toBe('doc of PL-AUTH');
    expect(node.querySelector('.plans-page-tasks p')?.textContent).toBe('2 tasks: 1 done, 1 running.');
  });

  it('P4: the progress in words with a small bar, and the document in the main column with tasks and Details beside it', () => {
    const { node } = page(AUTH);
    const g = node.querySelector('.plans-page-progress') as HTMLElement;
    expect(g.textContent).toBe('43% done, 3 of 7 tasks');
    expect(g.querySelector('.plans-progress-bar')?.getAttribute('aria-hidden')).toBe('true');
    const main = node.querySelector('.plans-page-main') as HTMLElement;
    const side = node.querySelector('.plans-page-side') as HTMLElement;
    expect(main.querySelector('.plans-page-doc')).toBeTruthy();
    expect(side.querySelector('.plans-page-tasks')).toBeTruthy();
    expect(side.querySelector('.plans-page-details')).toBeTruthy();
    // a plan without tasks shows no progress (no "0 of 0")
    const bare = page(entry('PL-NEW', { total: 0, finished: 0 })).node;
    expect(bare.querySelector('.plans-progress')).toBe(null);
  });

  it('each task is one row with its own status attached (never a line that reads as a heading for the next task)', () => {
    const { node } = page(AUTH);
    const rows = [...node.querySelectorAll('.plans-page-task-list > li')] as HTMLElement[];
    expect(rows).toHaveLength(2);
    for (const li of rows) {
      expect(li.classList.contains('plans-page-task')).toBe(true);
      const button = li.querySelector('button') as HTMLElement;
      const status = li.querySelector('.plans-page-task-status') as HTMLElement;
      expect(status.parentElement).toBe(li);
      // the status is read with its own task
      expect(button.getAttribute('aria-describedby')).toBe(status.id);
    }
    expect(rows[0].querySelector('.plans-page-task-status')?.textContent).toBe('In progress');
    // CSS: a grid row per task (title left, status right in the same row, a divider between rows), no wrapping flex
    const rule = css.match(/\.plans-page-task-list li \{[^}]*\}/)?.[0] ?? '';
    expect(rule).toMatch(/display: grid/);
    expect(rule).not.toMatch(/flex-wrap/);
    expect(rule).toMatch(/border-top/);
    // the wide side column takes the free width instead of stopping at 360 px
    expect(css).toMatch(/grid-template-columns: minmax\(0, 80ch\) minmax\(300px, 1fr\)/);
  });

  it('Details is closed by default, shows the key facts on its row and remembers a toggle', () => {
    const { node, calls } = page(AUTH);
    const det = node.querySelector('details.plans-page-details') as HTMLDetailsElement;
    expect(det.open).toBe(false);
    expect(det.querySelector('summary')?.textContent).toBe('DetailsNow · Partially built · M · PL-AUTH');
    expect(det.querySelector('.stub-tab-summary')).toBeTruthy();
    expect(det.querySelector('.stub-tab-history')).toBeTruthy();
    det.open = true;
    det.dispatchEvent(new Event('toggle'));
    expect(calls.details).toEqual([true]);
    expect(page(AUTH, { detailsOpen: true }).node.querySelector('details.plans-page-details')?.hasAttribute('open')).toBe(
      true,
    );
  });

  it('the CLI lines are chips under More, not buttons in the way', () => {
    const { node } = page(AUTH);
    const more = node.querySelector('details.plans-page-more') as HTMLElement;
    expect(more.querySelector('summary')?.textContent).toBe('More');
    const chips = [...more.querySelectorAll('.cli-chip code')].map((c) => c.textContent);
    expect(chips[0]).toMatch(/^\/plans PL-AUTH/);
    expect(chips[1]).toMatch(/^\/add-to-queue PL-AUTH/);
  });

  it('Back returns to the roadmap', () => {
    const { node, calls } = page(AUTH);
    (node.querySelector('.plans-page-back') as HTMLElement).click();
    expect(calls.use.at(-1)).toEqual({ entry: null });
  });

  it('the lead is marked as coming from the plan document; without one it says so', () => {
    const lead = page(entry('PL-L', { lead: { text: 'Words from the doc.', path: 'docs/l.md', anchor: null } })).node;
    expect(lead.querySelector('.plans-page-summary')?.textContent).toBe('Words from the doc.');
    expect(lead.querySelector('.plans-page-from')?.textContent).toBe('From the plan document, docs/l.md');
    const none = page(entry('PL-N')).node;
    expect(none.querySelector('.plans-page-summary')?.textContent).toBe(
      'No summary yet. Claude writes one when the plan is shaped.',
    );
  });

  it('questions and legal points only when there are any', () => {
    expect(page(AUTH).node.querySelector('.plans-page-questions')).toBe(null);
    const q = page(entry('PL-Q', { ownerQuestions: [{ id: 'Q-1', resolved: false }] })).node;
    expect(q.querySelector('.plans-page-questions .stub-tab-decisions')).toBeTruthy();
  });
});

describe('the plan document on the plan page (read.js planDocument)', () => {
  const readJs = readFileSync(join(CLIENT, 'plans', 'read.js'), 'utf8');
  function reader() {
    const w: any = { QueuePlanView: V };
    const fetched: string[] = [];
    const g = globalThis as any;
    g.fetch = (url: string) => {
      fetched.push(url);
      return new Promise(() => {}); // stays loading: the test looks at what is asked for and drawn first
    };
    new Function('window', readJs)(w);
    const h = { el, date: (x: string) => x, copyButton: () => el('button', { text: 'Copy' }), draw: () => {} };
    return { R: w.QueuePlanRead, h, fetched };
  }

  it('opens on the plan source (role plan first) with no click, and lists the others under "Also"', () => {
    const { R, h, fetched } = reader();
    const p = entry('PL-AUTH', {
      sources: [
        { path: 'docs/design/auth.md', anchor: null, role: 'design' },
        { path: 'docs/plans/auth.md', anchor: '§ 1', role: 'plan' },
      ],
    });
    const node = R.planDocument(h, p);
    expect(fetched[0]).toContain(encodeURIComponent('docs/plans/auth.md'));
    expect(node.querySelector('.read-path')?.textContent).toBe('docs/plans/auth.md');
    // P9: the source open in the reader is not offered again under "Also"
    expect([...node.querySelectorAll('.plans-page-also button')].map((b: any) => b.textContent)).toEqual([
      'docs/design/auth.md',
    ]);
    // the page has no Close: the document is what it is about
    expect([...node.querySelectorAll('button')].some((b: any) => b.textContent === 'Close')).toBe(false);
  });

  it('without a readable source it says so', () => {
    const { R, h } = reader();
    // P9: the same words as the plan page's empty state (V.planDocEmpty)
    expect(R.planDocument(h, entry('PL-N')).textContent).toBe('No plan document yet');
    expect(
      R.planDocument(h, entry('PL-O', { sources: [{ path: '../secret.md' }] })).textContent,
    ).toMatch(/not shown here/);
  });
});

describe('the code', () => {
  const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
  const plans = readFileSync(join(CLIENT, 'plans', 'plans.js'), 'utf8');
  const work = readFileSync(join(CLIENT, 'plans', 'work.js'), 'utf8');
  const server = readFileSync(join(CLIENT, '..', 'queue-board.mjs'), 'utf8');

  it('wired in: loaded before plans.js, served, drawn for surface=roadmap, the viewer\'s choices kept with try/catch', () => {
    expect(html.indexOf('/plans/roadmap.js')).toBeGreaterThan(0);
    expect(html.indexOf('/plans/roadmap.js')).toBeLessThan(html.indexOf('/plans/plans.js'));
    expect(server).toContain("'/plans/roadmap.js'");
    expect(plans).toMatch(/window\.QueuePlanRoadmap\.cells\(roadmapHelp, d, /);
    expect(plans).toMatch(/window\.QueuePlanRoadmap\.page\(roadmapHelp, d, /);
    expect(plans).toContain("'queue-board-plans-roadmap'");
    // the maps and the overview are under More views, not tabs or a toggle row
    expect(plans).toMatch(/V\.MORE_VIEWS/);
    expect(plans).not.toMatch(/'aria-label': 'View'/);
  });

  it('the keyboard on the Roadmap: / searches, j and k move between plans, Escape leaves the plan page', () => {
    expect(work).toMatch(/surface === 'roadmap'/);
    expect(work).toMatch(/data-roadmap-entry/);
  });

  it('no innerHTML in roadmap.js', () => {
    expect(roadmapJs).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
  });

  it('the CSS: tokens only, the columns and a narrow rule that drops the layout toggle', () => {
    const start = css.indexOf('/* ---- The Roadmap');
    expect(start).toBeGreaterThan(0);
    const own = css.slice(start);
    expect(own).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(own).toMatch(/\.roadmap-columns \{/);
    expect(own).toMatch(/@media \(max-width: 699px\)[\s\S]*\.roadmap-layout/);
  });
});
