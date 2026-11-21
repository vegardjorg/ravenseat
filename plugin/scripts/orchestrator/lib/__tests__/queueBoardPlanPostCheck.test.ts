/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardPlanPostCheck.test.ts: "Did the plans hold?" in Statistics, Flow (PG-6, lib/planPostCheck.js section,
// lib/statisticsSections.js plans, board/statistics.js plansFollowUp).
//
// What the tests prove:
//   - the server gives `plans` only when the caller passes the register; a built plan has a row, an unbuilt one none,
//   - the board draws the card with one row per built plan ("no estimate" for an unsized one, the success answer) and
//     the record per size, as tables with row and column headers (screen readers),
//   - without built plans, nothing is drawn.
// The whole board runs in jsdom with a mock server (no network), as in queueBoardStatsS1.test.ts.
// =============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { clientSource } from './boardClient';

/* eslint-disable @typescript-eslint/no-require-imports */
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };
const S = require('../queueStatistics.js');
const SX = require('../statisticsSections.js');
/* eslint-enable @typescript-eslint/no-require-imports */

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const now = Date.now();
const iso = (min: number) => new Date(now - min * 60_000).toISOString();
const task = (id: string, plan: string, own: object = {}) => ({
  id,
  plan,
  project: 'a',
  title: `Title ${id}`,
  class: 'K',
  status: 'done',
  content_min: 60,
  added_at: iso(400),
  started: iso(300),
  delivered: iso(200),
  done: iso(100),
  ...own,
});
const queue = {
  limits: {},
  projects: {},
  areas: {},
  tasks: [task('EX-1', 'PL-EX'), task('EX-2', 'PL-EX', { cost: { phases: { fix_rounds: 1 } } }), task('UN-1', 'PL-UN'), task('OP-1', 'PL-OP', { status: 'waiting', done: null })],
  question: {},
  resolved: ['PC-PL-EX'],
  resolutions: { 'PC-PL-EX': { answer: 'Met' } },
  changelog: [],
};
const entries = [
  { id: 'PL-EX', title: 'Exports', size: 'L', sources: [] },
  { id: 'PL-UN', title: 'Unsized', sources: [] },
  { id: 'PL-OP', title: 'Open', size: 'S', sources: [] },
];
const plans = { entries, measureFor: (e: any) => (e.id === 'PL-EX' ? 'exports open' : null) };
const state = { version: 'v1', data: { ...T.board(queue), gitError: null, logo: false, update: null } };

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};

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
  w.fetch = async (filePath: string) => {
    if (filePath.startsWith('/api/statistics'))
      return {
        ok: true,
        status: 200,
        json: async () => {
          const stat = S.statistics(queue, []);
          return { version: 's1', data: { ...stat, sections: SX.sections({ queue, rows: [], statistics: stat, plans }), guards: null, timeLogError: null } };
        },
      };
    if (filePath.startsWith('/api/settings')) return { ok: true, status: 200, json: async () => ({ error: 'not in this test' }) };
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

const card = () => document.querySelector('[aria-labelledby="plans-stat-title"]') as HTMLElement | null;
const rowsOf = (table: Element) =>
  [...table.querySelectorAll('tbody tr')].map((tr) => [...tr.children].map((c) => c.textContent));

describe('the plan follow-up on the server', () => {
  it('gives plans only with the register, and rows only for built plans', () => {
    const stat = S.statistics(queue, []);
    expect(SX.sections({ queue, rows: [], statistics: stat })).not.toHaveProperty('plans');
    const p = SX.sections({ queue, rows: [], statistics: stat, plans }).plans;
    expect(p.rows.map((r: any) => r.id).sort()).toEqual(['PL-EX', 'PL-UN']);
    expect(p.total).toBe(2);
  });
});

describe('"Did the plans hold?" on the board', () => {
  it('is a card in Flow with a row per built plan, the unsized one without an estimate', () => {
    const c = card();
    expect(c).toBeTruthy();
    expect(c?.closest('#stat-section-flow')).toBeTruthy();
    expect(c?.querySelector('h4')?.textContent).toBe('Did the plans hold?');
    const [plansTable, sizeTable] = [...(c as HTMLElement).querySelectorAll('table')];
    const rows = rowsOf(plansTable);
    const ex = rows.find((r) => r[0] === 'PL-EX') as (string | null)[];
    expect(ex.slice(1, 5)).toEqual(['L', '7 tracks', '2 + 1', '2 h 0 min']);
    // Measured: 200 min per task, start to done.
    expect(ex[5]).toBe('6 h 40 min');
    expect(ex[7]).toBe('Met');
    const un = rows.find((r) => r[0] === 'PL-UN') as (string | null)[];
    expect(un[2]).toBe('no estimate');
    expect(un[7]).toBe('-');
    // Screen readers: the first cell is a row header and the header cells are column headers.
    expect(plansTable.querySelector('tbody tr th[scope="row"]')).toBeTruthy();
    expect(plansTable.querySelectorAll('thead th[scope="col"]').length).toBe(8);
    const sizes = rowsOf(sizeTable);
    expect(sizes.map((r) => r[0])).toEqual(['L', 'no size']);
    expect(sizes[0][5]).toBe('1, 0, 0 of 1');
  });
});
