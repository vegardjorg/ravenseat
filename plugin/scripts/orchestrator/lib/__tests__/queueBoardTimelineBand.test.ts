/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardTimelineBand.test.ts: the board side of the Timeline's uncertainty band (roadmap TIDSLINJE T-C).
//
// Locks: with a band in the payload each focus step row has one shaded band (no band on a task), its label says "done
// around X (likely by Y)", the legend has the band, the notes carry the backtest line, and the table view has a step
// table with the same numbers. Without enough data the row has no band and a note says why. The whole board runs in
// jsdom with the real payload of queueTimeline.timelineData; the server is a fetch mock.
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
const MIN = 60_000;
const H = 60 * MIN;
const iso = (ms: number) => new Date(ms).toISOString();
const task = (id: string, extra: object = {}) => ({
  id,
  title: `Task ${id}`,
  domain: id.toLowerCase(),
  class: 'K',
  value: 5,
  content_min: 30,
  status: 'waiting',
  depends_on: [],
  waiting_on: [],
  owned_files: [`f/${id}.ts`],
  added_by: 'test',
  added_at: iso(NOW - 48 * H),
  ...extra,
});
// Five done K tasks two days back (16, 16, 16, 32 and 48 minutes) give the measured spread.
const history = [16, 16, 16, 32, 48].map((c, i) =>
  task(`H-${i}`, { status: 'done', started: iso(NOW - 48 * H - c * MIN), done: iso(NOW - 48 * H) }),
);
const queue = {
  created: iso(NOW - 72 * H),
  changed: iso(NOW - H),
  limits: { maxConcurrent: 1, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
  projects: { a: { title: 'Alpha', prefixes: ['A-'] }, b: { title: 'Beta', prefixes: ['B-'] }, h: { title: 'Old', prefixes: ['H-'] } },
  areas: {},
  question: {},
  resolutions: {},
  changelog: [],
  focus: { order: ['project:a', 'project:b'], rest: 'wait', from: iso(NOW - 24 * H), now_count: 1 },
  tasks: [...history, task('A-1', { value: 8 }), task('A-2', { value: 3 }), task('B-1')],
};
const withBand = QT.timelineData(queue, { now: NOW, uncertainty: true });
const noData = QT.timelineData({ ...queue, tasks: queue.tasks.filter((o) => !o.id.startsWith('H-')) }, { now: NOW, uncertainty: true });
let payload: any = withBand;
let version = 'band-1';
const flush = async () => {
  for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0));
};
const state = {
  version: 'v1',
  data: {
    ...T.board(queue),
    gitError: null,
    logo: false,
    features: KK.features(KK.STANDARD),
    boardSwitches: KK.boardSwitches(KK.STANDARD, null),
    boardTimeline: { on: true, horizonDays: 3, rows: 'step', drag: true, dragPreview: true, uncertainty: true },
  },
};
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const view = () => document.querySelector('.tl-view') as HTMLElement;
const refetch = async () => {
  window.dispatchEvent(new Event('focus'));
  await flush();
};

beforeAll(async () => {
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
  w.fetch = async (filePath: string) => ({
    ok: true,
    status: 200,
    json: async () =>
      filePath.startsWith('/api/state')
        ? filePath.includes(`version=${state.version}`)
          ? { version: state.version, unchanged: true }
          : state
        : filePath.startsWith('/api/schedule')
          ? filePath.includes(`version=${version}`)
            ? { version, unchanged: true }
            : { ok: true, version, data: { enabled: true, settings: state.data.boardTimeline, ...payload } }
          : { ok: false, message: 'not in this test' },
  });
  for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', '../lib/queueDecisions.js', '../lib/timelineLayout.js', '../lib/timelineDrag.js', 'board/'])
    (0, eval)(clientSource(f));
  await flush();
  $('show-timeline').click();
  await flush();
}, 60_000);

describe('the uncertainty band on the Timeline', () => {
  it('the payload has a band for both steps', () => {
    expect(withBand.uncertainty.enough).toBe(true);
    expect(withBand.uncertainty.steps.map((s: any) => s.step)).toEqual([0, 1]);
  });

  it('one shaded band per step row, none on a task; the label says done around and likely by', () => {
    const bands = view().querySelectorAll('.tl-svg .tl-step-band');
    expect(bands.length).toBe(2);
    for (const b of bands) expect(b.closest('.tl-bar')).toBeNull();
    const notes = [...view().querySelectorAll('.tl-row-note')].map((n) => n.textContent);
    expect(notes.some((n) => /^done around \w{3} \d\d:\d\d \(likely by \w{3} \d\d:\d\d\)/.test(n ?? ''))).toBe(true);
    const legend = [...view().querySelectorAll('.tl-legend-item')].map((n) => n.textContent);
    expect(legend).toContain('Step likely done in here (P50 to P85)');
    const text = view().textContent ?? '';
    expect(text).toContain(withBand.backtest.text);
  });

  it('the table view has a step table with the same numbers', async () => {
    const button = [...document.querySelectorAll('.tl-switch .toggles-button')].find((b) => b.textContent === 'Table') as HTMLElement;
    button.click();
    await flush();
    const table = view().querySelector('.tl-step-table') as HTMLTableElement;
    expect(table).toBeTruthy();
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(['Step', 'Tasks', 'Done around', 'Likely by']);
    const first = [...table.querySelectorAll('tbody tr')][0];
    expect(first.querySelector('th')?.textContent).toBe('1 Alpha');
    const cells = [...first.querySelectorAll('td')].map((td) => td.textContent);
    expect(cells[0]).toBe('2');
    expect(cells[1]).toMatch(/^around \w{3} \d\d:\d\d$/);
    expect(cells[2]).toMatch(/^\w{3} \d\d:\d\d$/);
    // The same "likely by" as the chart's label for step 1.
    const back = [...document.querySelectorAll('.tl-switch .toggles-button')].find((b) => b.textContent === 'Chart') as HTMLElement;
    back.click();
    await flush();
    const note = [...view().querySelectorAll('.tl-row-note')].map((n) => n.textContent ?? '').find((n) => n.includes('likely by'));
    expect(note).toContain(`(likely by ${cells[2]})`);
  });

  it('too few measured tasks: no band, and a note says why', async () => {
    payload = noData;
    version = 'band-2';
    await refetch();
    expect(view().querySelectorAll('.tl-svg .tl-step-band').length).toBe(0);
    expect(view().textContent).toContain('No band yet: 0 finished tasks with a measured time in the last 28 days, needs at least 5.');
    const notes = [...view().querySelectorAll('.tl-row-note')].map((n) => n.textContent ?? '');
    expect(notes.every((n) => !n.includes('likely by'))).toBe(true);
  });
});
