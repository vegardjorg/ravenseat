/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardFlow.test.ts: the "Flow last 14 days" box in the Statistics tab (statistics.js flowTable) with the quality
// figures: right first time, post-merge defects, owner interventions, inflow by source, the reviewer hit rate table
// and the hints. The server computes the numbers (lib/eventStatistics.js flowStatistics, the same as `ravenseat cost`); the
// board only shows them. The whole board runs in jsdom with a mock server (no network).
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
const ES = require('../eventStatistics.js');

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const now = Date.now();
const iso = (h: number) => new Date(now - h * 3_600_000).toISOString();

// Two merged tasks (one with a fix round attributed to reviewer), ten reviewer-docs runs without a fix.
const docs = Array.from({ length: 10 }, (_, n) => ({
  id: `D${n}`,
  status: 'done',
  done: iso(5),
  started: iso(6),
  added_at: iso(30),
  added_by: 'owner',
  resumed: n === 0 ? [{ reason: 'fix', from: ['reviewer'] }] : [],
  cost: { agents: [{ type: 'reviewer-docs', findings: { H: 0, M: 0, L: 1 } }, { type: 'reviewer', findings: { H: 1, M: 0, L: 0 } }] },
}));
const queue = { limits: {}, projects: {}, areas: {}, tasks: docs, question: {}, resolutions: {}, changelog: [] };
const flow = ES.flowStatistics(queue, [], { from: now - 14 * 86_400_000, to: now });
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
        json: async () => ({ version: 's1', data: { ...S.statistics(queue, []), timeLogError: null, flow } }),
      };
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
}, 60_000);

describe('Statistics: the quality figures in the Flow box', () => {
  it('shows the new rows, the reviewer table and the hint next to the old first-pass row', async () => {
    (document.getElementById('show-statistics') as HTMLButtonElement).click();
    await flush();
    const section = document.querySelector('[aria-labelledby="flow-stat-title"]') as HTMLElement;
    expect(section).not.toBeNull();
    const tables = [...section.querySelectorAll('table')];
    expect(tables).toHaveLength(2);
    const rows = [...tables[0].querySelectorAll('tbody tr')].map((r) => r.textContent ?? '');
    expect(rows.some((r) => r.startsWith('First pass90 %'))).toBe(true);
    expect(rows.some((r) => r.startsWith('Right first time90 %9 of 10 merged'))).toBe(true);
    expect(rows.some((r) => r.startsWith('Post-merge defects per 10 merged0'))).toBe(true);
    expect(rows.some((r) => r.startsWith('Owner interventions per 10 merged0'))).toBe(true);
    // The autonomy rows: no owner edit while the tasks ran, one hour of work, D0's fix round corrected alone.
    expect(rows.some((r) => r.startsWith('Verified tasks per owner intervention' + 'no interventions10 merged'))).toBe(true);
    expect(rows.some((r) => r.startsWith('Longest stretch without the owner1 h'))).toBe(true);
    expect(rows.some((r) => r.startsWith('Corrected without the owner1 of 1fix rounds 1/1'))).toBe(true);
    expect(rows.some((r) => /^Inflow10owner 10; added\/done last 3 weeks 0\/0, 0\/0, 10\/10$/.test(r))).toBe(true);
    // The reviewer table: a caption, column headers, one row per type.
    expect(tables[1].querySelector('caption')?.textContent).toBe('Reviewer hit rate: fix rounds attributed 1 of 1');
    expect([...tables[1].querySelectorAll('thead th')].map((t) => t.textContent)).toEqual([
      'Reviewer',
      'Runs',
      'With findings',
      'Led to a fix',
      'Dismissed',
    ]);
    const cells = [...tables[1].querySelectorAll('tbody tr')].map((r) =>
      [...r.children].map((c) => c.textContent),
    );
    expect(cells).toEqual([
      ['reviewer-docs', '10', '10', '0', '10'],
      ['reviewer', '10', '10', '1', '9'],
    ]);
    expect(section.textContent).toContain('Hint: reviewer-docs: 0 fixes in 10 runs.');
  });
});
