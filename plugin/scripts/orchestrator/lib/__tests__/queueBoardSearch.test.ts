/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardSearch.test.ts: the structured search in the board's search box (roadmap 0ø J6, board.structuredSearch).
//
// Locks: class:D and status:blocked filter the built cards (the card carries open_block and cost_usd, so block: and
// cost> work on the real board data); plain words search as before; the box is a combobox with a listbox of
// suggestions (aria-expanded, aria-activedescendant), Arrow Down marks and Enter takes a suggestion; Esc closes the list
// and keeps the text; an unknown field shows a hint (also in a live region) and empties nothing; board.structuredSearch
// off: no roles, no list, and class:d is plain text again.
// The whole board runs in jsdom with a small synthetic queue.
// =============================================================
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { clientSource } from './boardClient';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const T = require('../queueBoard.js') as {
  board: (queue: unknown, option?: unknown) => any;
};
const KK = require('../queueConfig.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports */

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const old = new Date(Date.now() - 5 * 86_400_000).toISOString();
const task = (id: string, title: string, extra: Record<string, unknown> = {}) => ({
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
  ...extra,
});
const queue = {
  created: old,
  limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
  tasks: [
    task('EX-1', 'Streak counter', { class: 'D' }),
    task('EX-2', 'Offline sync', { cost: { usd: 2.5 } }),
    task('EX-3', 'Billing page', { class: 'D+' }),
  ],
  projects: { ex: { title: 'Example', prefixes: ['EX-'] } },
  areas: {},
  question: {},
  resolutions: {},
  changelog: [],
};
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const press = (key: string, target: Element) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

let state: any;
const display: Record<string, boolean> = {
  titleCount: true,
  shortcuts: true,
  quickFilters: true,
  palette: true,
  structuredSearch: true,
};

beforeAll(async () => {
  const data = {
    ...T.board(queue),
    gitError: null,
    logo: false,
    features: KK.features(KK.STANDARD),
    boardSwitches: KK.boardSwitches(KK.STANDARD, null),
    boardDisplay: display,
  };
  state = { version: 'v1', data };
  const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
  document.documentElement.innerHTML = html.replace(/<!doctype[^>]*>/i, '').replace(/<\/?html[^>]*>/g, '');
  sessionStorage.clear();
  localStorage.clear();
  history.replaceState(null, '', `${location.pathname}#key=testKey&view=flat`);
  const w = window as any;
  w.CSS = { escape: (s: string) => String(s).replace(/["\\]/g, '\\$&') };
  w.matchMedia = () => ({
    matches: false,
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
        : { ok: true, message: 'ok', info: [] },
  });
  for (const f of [
    'a11y.js',
    '../lib/queueGraph.js',
    'graph.js',
    'plan.js',
    'performance.js',
    '../lib/queueDecisions.js',
    '../lib/boardSearch.js',
    'board/',
  ])
    (0, eval)(clientSource(f));
  await flush();
}, 60_000);

const box = () => $('search') as HTMLInputElement;
/** Types into the search box and waits for the board's 150 ms search delay. */
const type = async (text: string) => {
  box().focus();
  box().value = text;
  box().setSelectionRange(text.length, text.length);
  box().dispatchEvent(new Event('input', { bubbles: true }));
  await wait(200);
};
/** The ids of the built cards the search does not hide. */
const shown = () =>
  [...document.querySelectorAll<HTMLElement>('.summary[data-id]')]
    .filter((e) => !e.closest('[hidden]'))
    .map((e) => e.dataset.id)
    .sort();

afterEach(async () => {
  display.structuredSearch = true;
  await type('');
  box().blur();
});

describe('J6 structured search on the board', () => {
  it('the card carries the fields the search needs', () => {
    const all = Object.values(state.data.columns).flat() as any[];
    expect(all.find((k) => k.id === 'EX-2').cost_usd).toBe(2.5);
    expect(all.find((k) => k.id === 'EX-1')).toHaveProperty('open_block', null);
  });

  it('class:d filters exactly, cost>1 takes the measured cost, plain words as before', async () => {
    expect(shown()).toEqual(['EX-1', 'EX-2', 'EX-3']);
    await type('class:d');
    expect(shown()).toEqual(['EX-1']);
    await type('cost>1');
    expect(shown()).toEqual(['EX-2']);
    await type('billing');
    expect(shown()).toEqual(['EX-3']);
  });

  it('the box is a combobox: suggestions in a listbox, Arrow Down marks, Enter takes it', async () => {
    await type('cla');
    expect(box().getAttribute('role')).toBe('combobox');
    expect(box().getAttribute('aria-controls')).toBe('search-suggest');
    expect(box().getAttribute('aria-expanded')).toBe('true');
    const options = [...$('search-suggest').querySelectorAll('[role="option"]')].map((o) => o.textContent);
    expect(options).toEqual(['class:']);
    press('ArrowDown', box());
    expect(box().getAttribute('aria-activedescendant')).toBe('search-option-0');
    expect($('search-option-0').getAttribute('aria-selected')).toBe('true');
    press('Enter', box());
    expect(box().value).toBe('class:');
    // Now the values: the classes on the board.
    const values = [...$('search-suggest').querySelectorAll('[role="option"]')].map((o) => o.textContent);
    expect(values).toEqual(['class:K', 'class:D', 'class:D+']);
  });

  it('Esc closes the list and keeps the text', async () => {
    await type('stat');
    expect($('search-help').hidden).toBe(false);
    press('Escape', box());
    expect($('search-help').hidden).toBe(true);
    expect(box().getAttribute('aria-expanded')).toBe('false');
    expect(box().value).toBe('stat');
  });

  it('an unknown field shows a hint, also for a screen reader, and empties nothing', async () => {
    await type('colour:red');
    expect($('search-hint').textContent).toContain('colour');
    expect($('search-hint-live').textContent).toContain('colour');
    expect(shown()).toEqual(['EX-1', 'EX-2', 'EX-3']);
  });

  it('board.structuredSearch off: no roles, no list, class:d is plain text', async () => {
    display.structuredSearch = false;
    await type('class:d');
    expect(box().hasAttribute('role')).toBe(false);
    expect($('search-help').hidden).toBe(true);
    expect(shown()).toEqual([]);
  });
});
