/**
 * @vitest-environment jsdom
 */
// =============================================================
// queuePlanToTasks.test.ts: from a plan to tasks (P8 of plans/plans-tab-ux-review-2026-11-19.md, section 7.4).
//
// What the tests prove:
//   - a shaped plan (maturity ready) without tasks gets "Turn into tasks": a button that opens one line saying Claude
//     splits the plan into queue tasks, and the /add-to-queue line as a Claude Code chip with Copy. The board adds
//     nothing itself (no write), and the warnings before packing (open question, legal point) are listed,
//   - a plan that is not shaped yet gets no button, only a line that says it must be shaped first,
//   - a plan with tasks gets "See tasks", which opens the Queue filtered on the plan (plan:<id> in the Queue search),
//   - the plan page says "In focus through step Tn" when a task of the plan sits in a focus step (the first one),
//   - the Queue search understands plan:<id> next to plain words, case-insensitively, and is wired into the board.
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

type Post = Record<string, unknown>;

function entry(id: string, extra: Post = {}): Post {
  return {
    id,
    title: `Title ${id}`,
    summary: null,
    project: 'auth',
    module: 'account',
    priority: 'now',
    now_category: [],
    priority_set_by: 'owner',
    maturity: 'ready',
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

const data = (entries: Post[]) => ({
  exists: true,
  modules: [{ oid: 'account', title: 'Account' }],
  projects: {},
  entries,
  view: {},
});

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

function page(p: Post, { expanded = [] as string[] } = {}) {
  const w: any = { QueuePlanView: V };
  new Function('window', roadmapJs)(w);
  const calls = { toggled: [] as string[], planTasks: [] as string[], use: [] as Post[] };
  const open = new Set(expanded);
  const h = {
    el,
    state: () => ({ filter: V.emptyFilter(), search: '', surface: 'roadmap', entry: p.id }),
    use: (c: Post) => calls.use.push(c),
    width: () => 1440,
    prefs: () => ({ layout: null, group: 'horizon', compact: false }),
    setPref: () => {},
    isExpanded: (id: string) => open.has(id),
    toggleExpanded: (id: string) => calls.toggled.push(id),
    detailsOpen: () => false,
    setDetailsOpen: () => {},
    activeFilters: () => el('div', {}),
    copyButton: () => el('button', { type: 'button', text: 'Copy' }),
    cliChip: (command: string) =>
      el('span', { class: 'cli-chip' }, el('code', { text: command }), el('button', { type: 'button', text: 'Copy' })),
    tabContent: (tab: string) => el('div', { class: `stub-tab-${tab}` }),
    planDocument: () => el('div', { class: 'stub-doc' }),
    showInQueue: () => {},
    showPlanTasks: (id: string) => calls.planTasks.push(id),
    search: () => {},
    date: (x: string) => x,
  };
  const node = w.QueuePlanRoadmap.page(h, data([p]), p);
  document.body.replaceChildren(node);
  return { node, calls };
}

const buttons = (node: Element) => [...node.querySelectorAll('.plans-page-actions button')] as HTMLElement[];
const named = (node: Element, text: string) => buttons(node).find((b) => b.textContent === text) ?? null;

describe('planToTasks: which action a plan gets', () => {
  it('a plan with tasks: See tasks (cancelled ones do not count)', () => {
    const p = entry('PL-A', { maturity: 'in-queue', queue: [{ id: 'A-1', column: 'queue' }, { id: 'A-2', status: 'cancelled' }] });
    expect(V.planToTasks(p, data([p]))).toMatchObject({ kind: 'see', count: 1 });
    const gone = entry('PL-B', { maturity: 'ready', queue: [{ id: 'B-1', status: 'cancelled' }] });
    expect(V.planToTasks(gone, data([gone])).kind).toBe('turn');
  });

  it('a shaped plan without tasks: Turn into tasks, with the /add-to-queue line and the checks before packing', () => {
    const p = entry('PL-C', { ownerQuestions: [{ id: 'Q-1', resolved: false }] });
    const r = V.planToTasks(p, data([p]));
    expect(r.kind).toBe('turn');
    expect(r.line).toMatch(/^\/add-to-queue PL-C /);
    expect(r.warnings.join(' ')).toMatch(/Q-1/);
  });

  it('not shaped, in the inbox, dropped or done without tasks: no Turn into tasks', () => {
    for (const m of ['idea', 'investigated', 'planned']) expect(V.planToTasks(entry('PL-I', { maturity: m })).kind).toBe('shape');
    expect(V.planToTasks(entry('PL-X', { inbox: { at: 'x', by: 'owner' } })).kind).toBe('shape');
    expect(V.planToTasks(entry('PL-D', { priority: 'drop' })).kind).toBe('none');
    expect(V.planToTasks(entry('PL-B', { maturity: 'built' })).kind).toBe('none');
  });
});

describe('planFocus: the first focus step that covers a task of the plan', () => {
  it('the lowest step among the plan tasks in the queue that the focus covers', () => {
    const p = entry('PL-F', {
      queue: [
        { id: 'F-1', column: 'queue', applies: true, outside: false, step: 2, step_title: 'Later step' },
        { id: 'F-2', column: 'queue', applies: true, outside: false, step: 1, step_title: 'Core' },
        { id: 'F-3', column: 'inProgress' },
      ],
    });
    expect(V.planFocus(p)).toEqual({ step: 1, title: 'Core', text: 'In focus through step T2: Core.' });
  });

  it('none without a focus, outside it, or with no task waiting in the queue', () => {
    expect(V.planFocus(entry('PL-N'))).toBe(null);
    expect(V.planFocus(entry('PL-O', { queue: [{ id: 'O-1', column: 'queue', applies: true, outside: true, step: null }] }))).toBe(null);
    expect(V.planFocus(entry('PL-P', { queue: [{ id: 'P-1', column: 'queue', applies: false, step: 0 }] }))).toBe(null);
    expect(V.planFocus(entry('PL-Q', { queue: [{ id: 'Q-1', column: 'queue', applies: true, step: 0 }] }))?.text).toBe(
      'In focus through step T1.',
    );
  });
});

describe('the Queue search: plan:<id> next to plain words', () => {
  it('splits the plan ids from the words, case-insensitively', () => {
    expect(V.searchParts('plan:PL-AUTH sessions')).toEqual({ plans: ['pl-auth'], text: 'sessions' });
    expect(V.searchParts('login')).toEqual({ plans: [], text: 'login' });
    expect(V.searchParts('')).toEqual({ plans: [], text: '' });
    // a lone "plan:" is just a word
    expect(V.searchParts('plan:')).toEqual({ plans: [], text: 'plan:' });
  });

  it('a card matches the plan (any of several) and the words', () => {
    const k = { id: 'AUTH-3', title: 'Sessions', feature: 'Login', project: 'auth', plan: 'PL-AUTH' };
    expect(V.cardMatchesSearch(k, 'plan:pl-auth')).toBe(true);
    expect(V.cardMatchesSearch(k, 'plan:PL-AUTH sessions')).toBe(true);
    expect(V.cardMatchesSearch(k, 'plan:pl-auth billing')).toBe(false);
    expect(V.cardMatchesSearch(k, 'plan:pl-bill')).toBe(false);
    expect(V.cardMatchesSearch(k, 'plan:pl-bill plan:pl-auth')).toBe(true);
    expect(V.cardMatchesSearch({ ...k, plan: null }, 'plan:pl-auth')).toBe(false);
    expect(V.cardMatchesSearch(k, 'auth-3')).toBe(true);
    expect(V.cardMatchesSearch(k, '')).toBe(true);
  });
});

describe('the plan page', () => {
  it('a plan with tasks: See tasks opens the Queue on the plan', () => {
    const { node, calls } = page(entry('PL-AUTH', { maturity: 'in-queue', queue: [{ id: 'AUTH-1', column: 'queue' }] }));
    expect(named(node, 'Turn into tasks')).toBe(null);
    const see = named(node, 'See tasks') as HTMLElement;
    expect(see).toBeTruthy();
    see.click();
    expect(calls.planTasks).toEqual(['PL-AUTH']);
  });

  it('a shaped plan without tasks: Turn into tasks opens the hand-off, which writes nothing', () => {
    const p = entry('PL-BILL');
    const shut = page(p);
    const turn = named(shut.node, 'Turn into tasks') as HTMLElement;
    expect(turn.getAttribute('aria-expanded')).toBe('false');
    expect(shut.node.querySelector('.plans-page-handoff')).toBe(null);
    turn.click();
    expect(shut.calls.toggled).toEqual(['turn:PL-BILL']);

    const { node } = page(p, { expanded: ['turn:PL-BILL'] });
    const open = named(node, 'Turn into tasks') as HTMLElement;
    expect(open.getAttribute('aria-expanded')).toBe('true');
    const box = node.querySelector('.plans-page-handoff') as HTMLElement;
    expect(open.getAttribute('aria-controls')).toBe(box.id);
    expect(box.textContent).toMatch(/Claude splits the plan into queue tasks/);
    expect(box.textContent).toMatch(/Decisions/);
    expect(box.querySelector('.cli-chip code')?.textContent).toMatch(/^\/add-to-queue PL-BILL /);
    expect(node.querySelector('.plans-page-tasks')?.textContent).toMatch(/No tasks yet\./);
  });

  it('an unshaped plan gets no button, and the tasks say why', () => {
    const { node } = page(entry('PL-IDEA', { maturity: 'idea', priority: 'later' }));
    expect(named(node, 'Turn into tasks')).toBe(null);
    expect(named(node, 'See tasks')).toBe(null);
    expect(node.querySelector('.plans-page-tasks')?.textContent).toMatch(/shaped/);
  });

  it('the focus line when a task of the plan is in a focus step, none otherwise', () => {
    const p = entry('PL-F', {
      maturity: 'in-queue',
      queue: [{ id: 'F-1', title: 'One', column: 'queue', applies: true, outside: false, step: 0, step_title: 'Core' }],
    });
    expect(page(p).node.querySelector('.plans-page-focus')?.textContent).toBe('In focus through step T1: Core.');
    expect(page(entry('PL-G', { maturity: 'in-queue', queue: [{ id: 'G-1', column: 'queue' }] })).node.querySelector('.plans-page-focus')).toBe(
      null,
    );
  });
});

describe('the code', () => {
  const cards = readFileSync(join(CLIENT, 'board', 'cards.js'), 'utf8');
  const start = readFileSync(join(CLIENT, 'board', 'start.js'), 'utf8');
  const plans = readFileSync(join(CLIENT, 'plans', 'plans.js'), 'utf8');

  it('the Queue search uses the shared rule, the board can open a plan filter, Plans passes it on', () => {
    expect(cards).toMatch(/cardMatchesSearch\(/);
    expect(start).toMatch(/showPlan\(id\)/);
    expect(plans).toMatch(/showPlanTasks:/);
    expect(plans).toMatch(/QueueBoard\?\.showPlan\?\.\(/);
  });

  it('no innerHTML in roadmap.js', () => {
    expect(roadmapJs).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
  });
});
