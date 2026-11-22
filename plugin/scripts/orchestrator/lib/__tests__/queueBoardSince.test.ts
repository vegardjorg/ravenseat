/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardSince.test.ts: the "Since you left" band in Decisions (roadmap 3e AW-2, AW-3, AW-8;
// plans/borte-flate-vurdering-2026-11-21.md, owner answers 21.11 as recommended).
//
// Locks: the band sits under the Decisions head with the window in words, the numbers and the events (a failure says
// "Failed" in words, an event with a task links to its card with the J2 deep link); the window choice is fetched and
// remembered in this browser; "Mark seen" posts the seen mark and the band starts from now; the band on screen for a
// few seconds posts the mark once, keeping the visit's window (?from=); X hides it for the visit; it is left out when
// nothing happened or with board.sinceLast off; "Decided" follows the band's window. The whole board runs in jsdom.
// =============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { clientSource } from './boardClient';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };
const KK = require('../queueConfig.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports */

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const old = new Date(Date.now() - 5 * 86_400_000).toISOString();
const queue = {
  created: old,
  limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
  tasks: [
    {
      id: 'EX-1',
      title: 'Task EX-1',
      domain: 'd',
      class: 'K',
      value: 5,
      content_min: 90,
      status: 'proposed',
      depends_on: [],
      waiting_on: [],
      owned_files: ['f/EX-1.ts'],
      added_by: 'test',
      added_at: old,
    },
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
const now = new Date().toISOString();
const since = (over: any = {}) => ({
  on: true,
  default_choice: 'last-seen',
  seen: { at: old, by: 'board', previous: null },
  window: { choice: 'last-seen', used: 'last-seen', from: Date.parse(old), to: Date.now(), note: null, text: 'since 21:40 yesterday (9 h 20 min)' },
  summary: {
    counts: { merged: 6, recovered: 2, blocked: 1, waiting: 1, spend_usd: 4.5, longest_stretch_h: 3.2 },
    events: [
      { time: now, kind: 'gate-red', task: 'EX-2', fail: true, text: 'EX-2 quick gate red: npm test' },
      { time: now, kind: 'push', task: null, fail: false, text: 'Pushed 2 tasks to main' },
    ],
    total_events: 12,
    more: 10,
    empty: false,
  },
  decided: [{ verb: 'decide', id: 'Q7', what: 'yes', at: now, by: 'owner' }],
  ...over,
});

let state: any;
let sinceAnswer: any = since();
const gets: string[] = [];
const posts: { path: string; body: any }[] = [];
const timers: (() => void)[] = [];
const band = () => document.querySelector('.since') as HTMLElement | null;
const refetch = async () => {
  state = { version: `v${Math.random()}`, data: state.data };
  window.dispatchEvent(new Event('focus'));
  await flush();
};

beforeAll(async () => {
  state = { version: 'v1', data: { ...T.board(queue), gitError: null, logo: false, features: KK.features(KK.STANDARD), boardSwitches: KK.boardSwitches(KK.STANDARD, null) } };
  const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
  document.documentElement.innerHTML = html.replace(/<!doctype[^>]*>/i, '').replace(/<\/?html[^>]*>/g, '');
  sessionStorage.setItem('queue-board-key', 'testKey');
  localStorage.clear();
  const w = window as any;
  w.CSS = { escape: (s: string) => String(s).replace(/["\\]/g, '\\$&') };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.setInterval = () => 0;
  // The "on screen a few seconds" timer (5 s) is kept here, so the test runs it when it wants.
  const realTimeout = w.setTimeout.bind(w);
  w.setTimeout = (f: () => void, ms?: number) => (ms === 5000 ? (timers.push(f), 0) : realTimeout(f, ms));
  w.fetch = async (filePath: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST') posts.push({ path: filePath, body: JSON.parse(init.body ?? '{}') });
    else gets.push(filePath);
    return {
      ok: true,
      status: 200,
      json: async () =>
        filePath.startsWith('/api/state')
          ? filePath.includes(`version=${state.version}`)
            ? { version: state.version, unchanged: true }
            : state
          : filePath.startsWith('/api/since')
            ? sinceAnswer
            : filePath.startsWith('/api/seen')
              ? { ok: true, seen: { at: now, by: 'board' } }
              : { ok: false, message: 'not in this test' },
    };
  };
  for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', '../lib/queueDecisions.js', 'board/'])
    (0, eval)(clientSource(f));
  await flush();
}, 60_000);

describe('the band in Decisions', () => {
  it('the board lands in Decisions and shows the band under the head', () => {
    expect(document.getElementById('show-decisions')?.getAttribute('aria-selected')).toBe('true');
    const b = band();
    expect(b).toBeTruthy();
    expect(b!.previousElementSibling?.classList.contains('decide-head')).toBe(true);
    expect(b!.textContent).toContain('Since you left');
    expect(b!.textContent).toContain('since 21:40 yesterday (9 h 20 min)');
    const numbers = [...b!.querySelectorAll('.since-number')].map((x) => x.textContent);
    expect(numbers).toEqual(['6merged', '2recovered without you', '1blocked now', '1waiting on you', '$4.50spend']);
    expect(gets.some((g) => g.startsWith('/api/since'))).toBe(true);
  });

  it('a failure says Failed in words and a task links to its card', () => {
    const rows = [...band()!.querySelectorAll('.since-event')];
    expect(rows).toHaveLength(2);
    expect(rows[0].classList.contains('fail')).toBe(true);
    expect(rows[0].querySelector('.since-fail')?.textContent).toBe('Failed');
    expect(rows[0].querySelector('a')?.getAttribute('href')).toBe('#view=flat&task=EX-2');
    expect(rows[1].querySelector('.since-fail')).toBeNull();
    expect(rows[1].querySelector('a')).toBeNull();
    expect(band()!.querySelector('.since-events summary')?.textContent).toBe('Latest events (2 of 12)');
  });

  it('Decided follows the window', () => {
    const summary = document.querySelector('.decide-done summary')?.textContent;
    expect(summary).toBe('Decided, since last seen (1)');
  });

  it('after a few seconds on screen it sets the seen mark once and keeps the window for the visit', async () => {
    expect(timers.length).toBeGreaterThan(0);
    timers.splice(0).forEach((f) => f());
    await flush();
    expect(posts.filter((p) => p.path === '/api/seen')).toHaveLength(1);
    gets.length = 0;
    await refetch();
    const again = gets.filter((g) => g.startsWith('/api/since'));
    expect(again.at(-1)).toContain(`from=${Date.parse(old)}`);
    timers.splice(0).forEach((f) => f());
    await flush();
    expect(posts.filter((p) => p.path === '/api/seen')).toHaveLength(1);
  });

  it('the window choice is fetched and remembered in this browser', async () => {
    gets.length = 0;
    const select = band()!.querySelector('select') as HTMLSelectElement;
    select.value = '7d';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(gets.at(-1)).toBe('/api/since?window=7d');
    expect(localStorage.getItem('queue-board-since-window')).toBe('7d');
  });

  it('Mark seen posts the mark; with nothing new the band goes away', async () => {
    sinceAnswer = since({ summary: { ...since().summary, events: [], total_events: 0, more: 0, empty: true } });
    const button = [...band()!.querySelectorAll('button')].find((x) => x.textContent === 'Mark seen') as HTMLButtonElement;
    button.click();
    await flush();
    expect(posts.filter((p) => p.path === '/api/seen')).toHaveLength(2);
    expect(band()).toBeNull();
  });

  it('X hides it for the visit', async () => {
    sinceAnswer = since();
    await refetch();
    expect(band()).toBeTruthy();
    (band()!.querySelector('.since-close') as HTMLButtonElement).click();
    await flush();
    expect(band()).toBeNull();
  });
});

describe('board.sinceLast off', () => {
  it('no band, and Decided is today again', async () => {
    sinceAnswer = { on: false, default_choice: 'last-seen' };
    await refetch();
    expect(band()).toBeNull();
    expect(document.querySelector('.decide-done summary')).toBeNull();
  });
});
