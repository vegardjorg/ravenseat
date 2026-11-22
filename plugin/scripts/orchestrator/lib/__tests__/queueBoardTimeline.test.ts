/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardTimeline.test.ts: the board's Timeline tab (roadmap TIDSLINJE T-A; plans/gantt-utredning-2026-11-18.md).
//
// Locks: the tab is there only with board.timeline on; opening it fetches GET /api/schedule (and nothing is posted:
// read only) and draws an inline SVG with the row titles, a now line and one button per bar that opens the card; a
// bar's words say rough and never a clock time; a wait on the owner is its own hatched part; the tasks that cannot
// start are listed with the reason; "Table" shows the same tasks with column and row headers (remembered in this
// browser); "Projects" switches the rows; the CSS for the tab uses tokens only and scrolls only inside the chart and
// table boxes. The whole board runs in jsdom with a small queue and the real payload (lib/queueTimeline.js).
// =============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { clientSource } from './boardClient';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };
const KK = require('../queueConfig.js') as any;
const QT = require('../queueTimeline.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports */

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const NOW = Date.now();
const H = 3_600_000;
const iso = (ms: number) => new Date(ms).toISOString();
const task = (id: string, extra: object) => ({
  id,
  title: `Task ${id}`,
  domain: id,
  class: 'K',
  value: 5,
  content_min: 60,
  status: 'waiting',
  depends_on: [],
  waiting_on: [],
  owned_files: [`f/${id}.ts`],
  added_by: 'test',
  added_at: iso(NOW - 48 * H),
  ...extra,
});
const queue = {
  created: iso(NOW - 72 * H),
  limits: { maxConcurrent: 3, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
  projects: { ex: { title: 'Example', prefixes: ['EX-'] }, ot: { title: 'Other', prefixes: ['OT-'] } },
  areas: {},
  question: {},
  resolutions: {},
  changelog: [],
  tasks: [
    task('EX-1', {}),
    task('OT-1', { waiting_on: ['Q1'] }),
    task('EX-2', { status: 'running', started: iso(NOW - H) }),
    task('EX-3', { status: 'done', started: iso(NOW - 6 * H), delivered: iso(NOW - 4 * H), done: iso(NOW - 3 * H) }),
    task('EX-4', { depends_on: ['EX-404'] }),
  ],
};
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

let state: any;
const gets: string[] = [];
const posts: string[] = [];
const payload = QT.timelineData(queue, { now: NOW });
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const stateWith = (timeline: object) => ({
  version: `v${Math.random()}`,
  data: {
    ...T.board(queue),
    gitError: null,
    logo: false,
    features: KK.features(KK.STANDARD),
    boardSwitches: KK.boardSwitches(KK.STANDARD, null),
    boardTimeline: { on: true, horizonDays: 3, rows: 'step', ...timeline },
  },
});
const refetch = async () => {
  window.dispatchEvent(new Event('focus'));
  await flush();
};

beforeAll(async () => {
  state = stateWith({ on: false });
  const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
  document.documentElement.innerHTML = html.replace(/<!doctype[^>]*>/i, '').replace(/<\/?html[^>]*>/g, '');
  sessionStorage.setItem('queue-board-key', 'testKey');
  localStorage.clear();
  localStorage.setItem('queue-board-view', 'flat');
  const w = window as any;
  w.CSS = { escape: (s: string) => String(s).replace(/["\\]/g, '\\$&') };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.setInterval = () => 0;
  w.fetch = async (filePath: string, init?: { method?: string; body?: string }) => {
    if (init?.method === 'POST') posts.push(filePath);
    else gets.push(filePath);
    return {
      ok: true,
      status: 200,
      json: async () =>
        filePath.startsWith('/api/state')
          ? filePath.includes(`version=${state.version}`)
            ? { version: state.version, unchanged: true }
            : state
          : filePath.startsWith('/api/schedule')
            ? { ok: true, version: 'sched-1', data: { enabled: true, ...payload } }
            : { ok: false, message: 'not in this test' },
    };
  };
  for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', '../lib/queueDecisions.js', '../lib/timelineLayout.js', 'board/'])
    (0, eval)(clientSource(f));
  await flush();
}, 60_000);

describe('the tab', () => {
  it('is hidden with board.timeline off, and nothing is fetched', () => {
    expect($('show-timeline').hidden).toBe(true);
    expect(gets.some((g) => g.startsWith('/api/schedule'))).toBe(false);
  });

  it('shows with board.timeline on; opening it fetches the schedule and posts nothing', async () => {
    state = stateWith({});
    await refetch();
    expect($('show-timeline').hidden).toBe(false);
    $('show-timeline').click();
    await flush();
    expect($('show-timeline').getAttribute('aria-selected')).toBe('true');
    expect(gets.some((g) => g.startsWith('/api/schedule'))).toBe(true);
    expect(posts).toEqual([]);
    expect(document.querySelector('.tl-view h2')?.textContent).toBe('Timeline');
  });
});

describe('the chart', () => {
  it('row titles: the ran part first, then the plan; a now line', () => {
    const titles = [...document.querySelectorAll('.tl-title-text')].map((e) => e.textContent);
    expect(titles[0]).toBe('Ran and running');
    expect(titles).toContain('Planned');
    expect(document.querySelector('.tl-svg .tl-now line')).toBeTruthy();
    expect(document.querySelector('.tl-svg')?.getAttribute('role')).toBe('group');
  });

  it('one button per bar, with rough words and no clock time; a click opens the card', () => {
    const bars = [...document.querySelectorAll('.tl-bar')] as HTMLElement[];
    const ids = bars.map((b) => b.dataset.id);
    expect(ids).toEqual(expect.arrayContaining(['EX-3', 'EX-2', 'EX-1', 'OT-1']));
    expect(ids).not.toContain('EX-4');
    for (const b of bars) {
      expect(b.getAttribute('role')).toBe('button');
      expect(b.getAttribute('tabindex')).toBe('0');
      expect(b.getAttribute('aria-label')).not.toMatch(/\d\d:\d\d/);
    }
    const planned = bars.find((b) => b.dataset.id === 'EX-1')!;
    expect(planned.getAttribute('aria-label')).toContain('rough: ');
    expect(planned.querySelector('.tl-band')).toBeTruthy();
    const ran = bars.find((b) => b.dataset.id === 'EX-3')!;
    expect(ran.querySelector('.tl-review')).toBeTruthy();
    planned.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect($('panel').hidden).toBe(false);
  });

  it('a wait on the owner is its own hatched part, said in words', () => {
    const w = document.querySelector('.tl-bar[data-id="OT-1"]') as HTMLElement;
    expect(w.getAttribute('aria-label')).toContain('waits on you');
    expect(w.querySelector('.tl-wait')).toBeTruthy();
    expect(document.querySelector('#tl-hatch')).toBeTruthy();
  });

  it('the tasks that cannot start are listed with the reason', () => {
    const list = document.querySelector('.tl-cannot') as HTMLElement;
    expect(list.textContent).toContain('Cannot start (1)');
    expect(list.textContent).toContain('EX-4');
    expect(list.textContent).toContain('EX-404');
  });
});

describe('the table and the rows switch', () => {
  it('"Table" shows the same tasks with column and row headers, remembered in this browser', async () => {
    const button = [...document.querySelectorAll('.tl-switch .toggles-button')].find((b) => b.textContent === 'Table') as HTMLElement;
    button.click();
    await flush();
    const table = document.querySelector('.tl-table') as HTMLTableElement;
    expect(table).toBeTruthy();
    expect(table.querySelector('caption')?.textContent).toMatch(/rough/);
    expect([...table.querySelectorAll('thead th')].map((th) => [th.textContent, th.getAttribute('scope')])).toEqual(
      ['Task', 'Row', 'State', 'Starts', 'Takes', 'Note'].map((c) => [c, 'col']),
    );
    const heads = [...table.querySelectorAll('tbody th')];
    expect(heads.every((th) => th.getAttribute('scope') === 'row')).toBe(true);
    const text = table.textContent ?? '';
    expect(text).toContain('Waits on you');
    expect(text).toContain('Cannot start');
    expect(JSON.parse(localStorage.getItem('queue-board-timeline') ?? '{}').display).toBe('table');
    expect(document.querySelector('.tl-svg')).toBeNull();
  });

  it('"Projects" switches the rows to one per project', async () => {
    const button = [...document.querySelectorAll('.tl-switch .toggles-button')].find((b) => b.textContent === 'Projects') as HTMLElement;
    // A real click focuses the button first (jsdom's click() does not).
    button.focus();
    button.click();
    await flush();
    const rows = [...document.querySelectorAll('.tl-table tbody tr td:first-of-type')].map((e) => e.textContent);
    expect(rows).toEqual(expect.arrayContaining(['Example', 'Other']));
    // The switch is drawn again: the new Projects button is pressed and has the focus (a keyboard user stays put).
    const again = [...document.querySelectorAll('.tl-switch .toggles-button')].find((b) => b.textContent === 'Projects') as HTMLElement;
    expect(again.getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(again);
  });

  it('board.timeline off again: the tab hides and the board goes back to Flat', async () => {
    state = stateWith({ on: false });
    await refetch();
    expect($('show-timeline').hidden).toBe(true);
    expect($('show-flat').getAttribute('aria-selected')).toBe('true');
  });
});

describe('the CSS', () => {
  const css = readFileSync(join(CLIENT, 'board.css'), 'utf8');
  const part = css.slice(css.indexOf('/* ---- The Timeline tab'));
  it('tokens only, no raw hex', () => {
    expect(part.length).toBeGreaterThan(100);
    expect(part).not.toMatch(/#[0-9a-f]{3,8}\b/i);
  });
  it('only the chart and the table boxes scroll sideways', () => {
    const scrolls = [...part.matchAll(/([^{}]+)\{[^}]*overflow-x:\s*auto/g)].map((m) => m[1].trim());
    expect(scrolls).toEqual(['.tl-scroll', '.tl-table-wrap']);
  });
});
