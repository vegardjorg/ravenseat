/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardStatsPolish.test.ts: the display polish after the Statistics rework (track st1).
//
// What the tests prove:
//   - a chart is drawn at the width its card really has, at every screen width (not only under 720 px): a 560 unit
//     drawing in a 430 px card made its 12 unit text about 9 px. A chart whose card has no width yet (a closed fold)
//     is left as it is and fitted when the fold opens,
//   - a key figure whose value is words ("too few answers yet") gets the smaller text style, numbers keep the large one,
//   - "Pushes per week" with no push says so in words instead of "- tasks per push",
//   - the chosen view tab is scrolled into sight in its row (at 390 px the row scrolls and Statistics was cut off).
// The whole board runs in jsdom with a mock server (no network), as in queueBoardStatsS1.test.ts.
// =============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { clientSource } from './boardClient';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const S = require('../queueStatistics.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const SX = require('../statisticsSections.js');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ES = require('../eventStatistics.js');

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const now = Date.now();
const iso = (min: number) => new Date(now - min * 60_000).toISOString();

const task = (id: string, back: number) => ({
  id,
  project: 'a',
  title: `Title ${id}`,
  class: 'K',
  status: 'done',
  estimate: 100,
  added_at: iso(back + 200),
  started: iso(back + 110),
  delivered: iso(back + 20),
  done: iso(back),
});
const queue = {
  limits: {},
  projects: {},
  areas: {},
  tasks: [task('K-1', 120), task('K-2', 60)],
  question: {},
  resolutions: {},
  changelog: [],
};
const rows = [
  { time: iso(90), event: 'done', agent_id: 'a1', agent_type: 'track', tokens: { input: 1000 }, context: { end: 150_000 } },
  { time: iso(30), event: 'done', agent_id: 'a2', agent_type: 'track', tokens: { input: 1000 }, context: { end: 288_000 } },
];
const state = { version: 'v1', data: { ...T.board(queue), gitError: null, logo: false, update: null } };

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

// The width jsdom reports for a chart (it has no layout): set per test.
let chartWidth = 0;

beforeAll(async () => {
  const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
  document.documentElement.innerHTML = html.replace(/<!doctype[^>]*>/i, '').replace(/<\/?html[^>]*>/g, '');
  sessionStorage.setItem('queue-board-key', 'testKey');
  localStorage.clear();
  const w = window as any;
  w.CSS = { escape: (s: string) => String(s).replace(/["\\]/g, '\\$&') };
  w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  w.HTMLElement.prototype.scrollIntoView = function () {};
  w.setInterval = () => 0;
  const rect = (width: number, left = 0) => ({ width, height: 10, left, right: left + width, top: 0, bottom: 10, x: left, y: 0 });
  w.SVGElement.prototype.getBoundingClientRect = function () {
    return rect(this.classList?.contains('graph-svg') ? chartWidth : 0);
  };
  w.fetch = async (filePath: string) => {
    if (filePath.startsWith('/api/statistics'))
      return {
        ok: true,
        status: 200,
        json: async () => {
          const stat = S.statistics(queue, rows);
          // No flow rows: no push in the window.
          const flow = ES.flowStatistics(queue, [], { from: now - 14 * 86_400_000, to: now });
          return {
            version: 'p1',
            data: { ...stat, sections: SX.sections({ queue, rows, statistics: stat }), flow, guards: null, timeLogError: null },
          };
        },
      };
    if (filePath.startsWith('/api/settings'))
      return { ok: true, status: 200, json: async () => ({ error: 'not in this test' }) };
    if (filePath.startsWith('/api/state'))
      return {
        ok: true,
        status: 200,
        json: async () => (filePath.includes(`version=${state.version}`) ? { version: state.version, unchanged: true } : state),
      };
    return { ok: true, status: 200, json: async () => ({}) };
  };
  for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', '../lib/queueUpdate.js', 'board/'])
    (0, eval)(clientSource(f));
  await flush();
  (document.getElementById('show-statistics') as HTMLButtonElement).click();
  await flush();
}, 60_000);

const charts = () => [...document.querySelectorAll('.board.statistics svg.graph-svg')] as SVGSVGElement[];
const drawnWidth = (svg: SVGSVGElement) => Number(svg.getAttribute('viewBox')?.split(' ')[2]);
// A window resize (jsdom has no layout, so the first guess stays the same and only the cards are measured again).
const resize = async () => {
  window.dispatchEvent(new Event('resize'));
  await new Promise((r) => setTimeout(r, 200));
};

describe('Statistics polish: the chart is drawn at its card width at every screen width', () => {
  it('a chart without a measured width keeps the drawing it has', async () => {
    chartWidth = 0;
    const before = charts().map(drawnWidth);
    expect(before.every((w) => w === 560)).toBe(true);
    await resize();
    expect(charts().map(drawnWidth)).toEqual(before);
  });

  it('a 430 px card gets a 430 unit drawing (the three-column case at 1440), and a 690 px card 690', async () => {
    chartWidth = 430;
    await resize();
    expect(charts().length).toBeGreaterThan(3);
    expect(charts().every((c) => drawnWidth(c) === 430)).toBe(true);
    chartWidth = 690;
    await resize();
    expect(charts().every((c) => drawnWidth(c) === 690)).toBe(true);
    // The redrawn chart is still a labelled image.
    expect(charts().every((c) => c.getAttribute('role') === 'img' && c.getAttribute('aria-label'))).toBe(true);
  });
});

describe('Statistics polish: texts', () => {
  it('a key figure in words gets the smaller value style, a number keeps the large one', () => {
    const tiles = [...document.querySelectorAll('.keyFigures .tile')];
    const value = (name: string) =>
      tiles.find((x) => x.querySelector('.tile-name')?.textContent === name)?.querySelector('.tile-value') as HTMLElement;
    expect(value('Weekly quota').textContent).toBe('no reading');
    expect(value('Weekly quota').classList.contains('tile-value-text')).toBe(true);
    expect(value('Cost per merged change').classList.contains('tile-value-text')).toBe(false);
  });

  it('"Pushes per week" with no push says so in words', () => {
    const row = [...document.querySelectorAll('.board.statistics tr')].find((r) => r.textContent?.startsWith('Pushes per week'));
    expect(row?.textContent).toContain('no push in the window');
    expect(row?.textContent).not.toContain('- tasks per push');
  });
});

describe('Statistics polish: the chosen view tab is in sight', () => {
  it('a tab past the right edge of its scrolling row is scrolled into the row', () => {
    const row = document.getElementById('tabs') as HTMLElement;
    const tab = document.getElementById('show-statistics') as HTMLElement;
    Object.defineProperty(row, 'scrollWidth', { configurable: true, value: 520 });
    Object.defineProperty(row, 'clientWidth', { configurable: true, value: 358 });
    row.getBoundingClientRect = () => ({ left: 16, right: 374, width: 358 }) as DOMRect;
    tab.getBoundingClientRect = () => ({ left: 400, right: 480, width: 80 }) as DOMRect;
    row.scrollLeft = 0;
    // Choosing the view (again) puts its tab in sight; jsdom keeps scrollLeft as set.
    tab.click();
    expect(row.scrollLeft).toBeGreaterThanOrEqual(106);
  });
});
