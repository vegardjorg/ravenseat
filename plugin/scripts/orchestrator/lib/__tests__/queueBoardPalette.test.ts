/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardPalette.test.ts: the command palette, Ctrl+K (roadmap 0ø J7, plans/jira-vurdering-2026-11-18.md proposal 7,
// owner answer 4: navigate, open and copy the command only).
//
// Locks: Ctrl+K opens a modal dialog with a combobox and a listbox (aria roles, aria-activedescendant), focus in the
// field; Esc closes and focus goes back; Tab stays inside (focus trap); typing filters views, tasks (id and title) and
// settings (from the registry, with the explanation); the arrows move the active option; Enter on a view opens it,
// Enter on a task opens its card through the J2 deep link (#view=…&task=…), Enter on a setting opens Settings on it;
// Shift+Enter and the Copy button copy the ravenseat command and change nothing (no write call); Ctrl+K never fires in
// a text field, and board.shortcuts off or board.palette off turns it off.
// The whole board runs in jsdom with a small synthetic queue.
// =============================================================
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { clientSource } from './boardClient';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };
const KK = require('../queueConfig.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports */

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const old = new Date(Date.now() - 5 * 86_400_000).toISOString();
const task = (id: string, title: string) => ({
  id,
  title,
  domain: `d-${id}`,
  class: 'K',
  value: 5,
  content_min: 90,
  status: 'waiting',
  depends_on: [],
  waiting_on: [],
  owned_files: [`file/${id}.ts`],
  owner_db: [],
  shared_patch: [],
  mission: `scripts/.queue/mission/${id}.md`,
  added_by: 'test',
  added_at: old,
});
const queue = {
  created: old,
  limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
  tasks: [task('EX-1', 'Streak counter'), task('EX-2', 'Offline sync'), task('EX-3', 'Billing page')],
  projects: { ex: { title: 'Example', prefixes: ['EX-'] } },
  areas: {},
  question: {},
  resolutions: {},
  changelog: [],
};
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const press = (key: string, target: Element = document.activeElement ?? document.body, extra: object = {}) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }));
const ctrlK = (target: Element = document.activeElement ?? document.body) => press('k', target, { ctrlKey: true });

let state: any;
const display: Record<string, boolean> = { titleCount: true, shortcuts: true, quickFilters: true, palette: true, structuredSearch: true };
const posts: string[] = [];
const copied: string[] = [];
let settingsFetches = 0;

beforeAll(async () => {
  const data = { ...T.board(queue), gitError: null, logo: false, features: KK.features(KK.STANDARD), boardSwitches: KK.boardSwitches(KK.STANDARD, null), boardDisplay: display };
  state = { version: 'v1', data };
  const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
  document.documentElement.innerHTML = html.replace(/<!doctype[^>]*>/i, '').replace(/<\/?html[^>]*>/g, '');
  sessionStorage.clear();
  localStorage.clear();
  history.replaceState(null, '', `${location.pathname}#key=testKey&view=flat`);
  const w = window as any;
  w.CSS = { escape: (s: string) => String(s).replace(/["\\]/g, '\\$&') };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.setInterval = () => 0;
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (s: string) => void copied.push(s) }, configurable: true });
  w.fetch = async (filePath: string, init?: { method?: string }) => {
    if (init?.method === 'POST') posts.push(filePath);
    if (filePath.startsWith('/api/settings')) settingsFetches++;
    return {
      ok: true,
      status: 200,
      json: async () =>
        filePath.startsWith('/api/state')
          ? filePath.includes(`version=${state.version}`)
            ? { version: state.version, unchanged: true }
            : state
          : filePath.startsWith('/api/settings')
            ? {
                ok: true,
                registry: {
                  categories: [
                    {
                      id: 'board',
                      title: 'Board and advice',
                      rows: [
                        { key: 'board.titleCount', category: 'board', type: 'onoff', title: 'Count in the tab title', explanation: 'The browser tab title starts with the number of decisions.', valueText: 'on', standardText: 'on' },
                      ],
                    },
                  ],
                },
              }
            : { ok: true, message: 'ok', info: [] },
    };
  };
  for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', '../lib/queueDecisions.js', 'board/'])
    (0, eval)(clientSource(f));
  await flush();
}, 60_000);

const box = () => $('palette');
const isOpen = () => !$('palette-background').hidden;
const field = () => box().querySelector('input[role="combobox"]') as HTMLInputElement;
const options = () => [...box().querySelectorAll('[role="option"]')] as HTMLElement[];
async function type(text: string) {
  field().value = text;
  field().dispatchEvent(new Event('input', { bubbles: true }));
  await flush();
}
async function closeIfOpen() {
  if (isOpen()) press('Escape', field());
  await flush();
}

beforeEach(async () => {
  display.shortcuts = true;
  display.palette = true;
  await closeIfOpen();
  (document.activeElement as HTMLElement | null)?.blur?.();
});

describe('opening and closing', () => {
  it('Ctrl+K opens a modal dialog with a combobox and a listbox; focus is in the field', async () => {
    const from = $('show-flat');
    from.focus();
    ctrlK(from);
    await flush();
    expect(isOpen()).toBe(true);
    expect(box().getAttribute('role')).toBe('dialog');
    expect(box().getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(field());
    const list = box().querySelector('[role="listbox"]') as HTMLElement;
    expect(field().getAttribute('aria-controls')).toBe(list.id);
    expect(field().getAttribute('aria-expanded')).toBe('true');
    expect(options().length).toBeGreaterThan(0);
    expect(field().getAttribute('aria-activedescendant')).toBe(options()[0].id);
  });

  it('Esc closes it and focus goes back to where it was', async () => {
    const from = $('show-flat');
    from.focus();
    ctrlK(from);
    await flush();
    press('Escape', field());
    await flush();
    expect(isOpen()).toBe(false);
    expect(document.activeElement).toBe(from);
  });

  it('Tab stays inside the dialog', async () => {
    ctrlK(document.body);
    await flush();
    const last = [...box().querySelectorAll('button')].pop() as HTMLButtonElement;
    last.focus();
    press('Tab', last);
    expect(box().contains(document.activeElement)).toBe(true);
  });

  it('never fires inside a text field, and is off with board.shortcuts or board.palette off', async () => {
    const search = $('search') as HTMLInputElement;
    search.focus();
    ctrlK(search);
    await flush();
    expect(isOpen()).toBe(false);
    display.shortcuts = false;
    ctrlK(document.body);
    await flush();
    expect(isOpen()).toBe(false);
    display.shortcuts = true;
    display.palette = false;
    ctrlK(document.body);
    await flush();
    expect(isOpen()).toBe(false);
  });
});

describe('finding and going', () => {
  it('finds a task by id and by a word of its title, and a view by name', async () => {
    ctrlK(document.body);
    await flush();
    await type('ex-2');
    expect(options()[0].textContent).toContain('EX-2');
    await type('billing');
    expect(options()[0].textContent).toContain('EX-3');
    await type('statistics');
    expect(options()[0].textContent).toContain('Statistics');
  });

  it('finds a setting by its explanation and shows the command behind each item', async () => {
    ctrlK(document.body);
    await flush();
    await type('tab title');
    const o = options().find((x) => x.textContent!.includes('Count in the tab title'));
    expect(o).toBeTruthy();
    expect(o!.textContent).toContain('ravenseat settings board.titleCount');
    expect(settingsFetches).toBeGreaterThan(0);
  });

  it('the arrows move the active option', async () => {
    ctrlK(document.body);
    await flush();
    await type('');
    const first = options()[0].id;
    press('ArrowDown', field());
    expect(field().getAttribute('aria-activedescendant')).toBe(options()[1].id);
    expect(options()[1].getAttribute('aria-selected')).toBe('true');
    press('ArrowUp', field());
    expect(field().getAttribute('aria-activedescendant')).toBe(first);
  });

  it('Enter on a task opens its card through the deep link', async () => {
    ctrlK(document.body);
    await flush();
    await type('EX-3');
    press('Enter', field());
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await flush();
    expect(isOpen()).toBe(false);
    expect(location.hash).toContain('task=EX-3');
    expect($('panel').hidden).toBe(false);
    expect($('panel').textContent).toContain('EX-3');
    press('Escape', document.body);
    await flush();
  });

  it('Enter on a view opens it', async () => {
    ctrlK(document.body);
    await flush();
    await type('project lanes');
    press('Enter', field());
    await flush();
    expect($('show-lanes').getAttribute('aria-selected')).toBe('true');
    $('show-flat').click();
    await flush();
  });

  it('Shift+Enter and the Copy button copy the command and write nothing', async () => {
    posts.length = 0;
    copied.length = 0;
    ctrlK(document.body);
    await flush();
    await type('EX-1');
    press('Enter', field(), { shiftKey: true });
    await flush();
    expect(copied).toEqual(['ravenseat info EX-1']);
    expect(isOpen()).toBe(true);
    const copy = [...box().querySelectorAll('button')].find((b) => b.textContent === 'Copy command') as HTMLButtonElement;
    copy.click();
    await flush();
    expect(copied).toEqual(['ravenseat info EX-1', 'ravenseat info EX-1']);
    expect(posts).toEqual([]);
  });

  it('says so when nothing matches', async () => {
    ctrlK(document.body);
    await flush();
    await type('zzzz nothing');
    expect(options()).toHaveLength(0);
    expect(box().textContent).toContain('Nothing matches');
  });
});

describe('one palette per room (the Plans command line in plans/work.js also takes Ctrl+K)', () => {
  // The real plans/work.js, installed with a small stand-in for the helpers plans.js hands it; `inPlans` is the room.
  let inPlans = false;
  const plansOpen = () =>
    [...document.querySelectorAll('input')].some((i) => /Jump to an area/.test(i.placeholder) && !i.closest('[hidden]'));
  beforeAll(() => {
    (0, eval)(clientSource('../lib/queuePlanView.js'));
    (0, eval)(clientSource('plans/work.js'));
    const room = document.createElement('div');
    document.body.append(room);
    (window as any).QueuePlans = { ...(window as any).QueuePlans, isPlans: () => inPlans };
    (window as any).QueuePlanWork.install({
      // The same contract as board/core.js el (the board's own stays inside its strict eval).
      el: (tag: string, attr: Record<string, any> = {}, ...kids: any[]) => {
        const e = document.createElement(tag);
        for (const [k, v] of Object.entries(attr ?? {})) {
          if (v == null || v === false) continue;
          if (k === 'class') e.className = v;
          else if (k === 'text') e.textContent = v;
          else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
          else e.setAttribute(k, v === true ? '' : v);
        }
        for (const c of kids.flat()) if (c != null && c !== false) e.append(c);
        return e;
      },
      isPlans: () => inPlans,
      data: () => null,
      get() {},
      room,
      state: () => ({}),
      filterMenuOpen: () => false,
    });
  });
  const escape = () => document.activeElement && press('Escape', document.activeElement);

  it('in the queue rooms only the board palette opens', async () => {
    inPlans = false;
    ctrlK(document.body);
    await flush();
    expect(isOpen()).toBe(true);
    expect(plansOpen()).toBe(false);
    escape();
    await flush();
    expect(isOpen()).toBe(false);
  });

  it('in the Plans room only the Plans command line opens', async () => {
    inPlans = true;
    document.body.focus();
    ctrlK(document.body);
    await flush();
    expect(isOpen()).toBe(false);
    expect(plansOpen()).toBe(true);
    escape();
    await flush();
    inPlans = false;
  });
});

describe('the shortcut overview', () => {
  it('lists Ctrl K', async () => {
    (window as any).QueueKeys.open();
    await flush();
    expect($('keys').textContent).toContain('Command palette');
    (window as any).QueueKeys.close();
  });
});
