/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardMetrics.test.ts: the "models, tools and errors" section in the Statistics tab (statistics.js
// transcriptMetricsSection). The server computes the numbers (queueStatistics.transcriptMetrics, the same as
// `ravenseat cost`); the board only shows them. The whole board runs in jsdom with a mock server (no network).
// =============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { clientSource } from './boardClient';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const S = require('../queueStatistics.js');

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const MILL = 1_000_000;
const now = Date.now();
const iso = (min: number) => new Date(now - min * 60_000).toISOString();

const queue = { limits: {}, projects: {}, areas: {}, tasks: [], question: {}, resolutions: {}, changelog: [] };
// Two agents in the window: an Opus track with tools and an API error, and a killed Haiku reviewer.
const rows = [
  {
    time: iso(60),
    event: 'done',
    agent_id: 'a1',
    agent_type: 'track',
    tokens: { input: MILL },
    model: 'claude-opus-5-5',
    byModel: { 'claude-opus-5-5': { turns: 4, tokens: { input: MILL } } },
    tools: { Bash: { calls: 8, errors: 2 }, Read: { calls: 3, errors: 0 } },
    api_errors: { rate_limit: 0, overloaded: 1, other: 0 },
    duration_s: 3600,
    active_s: 1800,
    idle_gaps: 2,
  },
  {
    time: iso(30),
    event: 'done',
    agent_id: 'a2',
    agent_type: 'reviewer',
    killed: true,
    tokens: { output: MILL },
    model: 'claude-haiku-5-5',
    byModel: { 'claude-haiku-5-5': { turns: 2, tokens: { output: MILL } } },
    tools: {},
    api_errors: { rate_limit: 0, overloaded: 0, other: 0 },
    duration_s: 600,
    active_s: 600,
    idle_gaps: 0,
  },
];
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
        json: async () => ({ version: 's1', data: { ...S.statistics(queue, rows), timeLogError: null } }),
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

describe('Statistics: models, tools and errors', () => {
  it('the server data has the per-model cost, the top tools and the killed agent', () => {
    const m = S.statistics(queue, rows, { now }).metrics;
    expect(m.perModel.map((x: { model: string; usd: number }) => [x.model, x.usd])).toEqual([
      ['claude-opus-5-5', 4],
      ['claude-haiku-5-5', 0.5],
    ]);
    expect(m.tools[0]).toEqual({ name: 'Bash', calls: 8, errors: 2, errorRate: 25 });
    expect(m.killed).toBe(1);
  });

  it('shows a labelled section with the model and tool tables and the facts', async () => {
    (document.getElementById('show-statistics') as HTMLButtonElement).click();
    await flush();
    const section = document.querySelector('[aria-labelledby="metrics-stat-title"]') as HTMLElement;
    expect(section).not.toBeNull();
    expect(document.getElementById('metrics-stat-title')?.textContent).toBe(
      'Agents last 14 days: models, tools and errors',
    );
    const tables = [...section.querySelectorAll('table')];
    expect(tables).toHaveLength(2);
    const cells = (t: Element) => [...t.querySelectorAll('tbody tr')].map((r) => r.textContent);
    expect(cells(tables[0])[0]).toMatch(/^claude-opus-5-5.*4\.00 USD/);
    expect(cells(tables[1])[0]).toMatch(/^Bash8225\.0 %$/);
    const text = section.textContent ?? '';
    expect(text).toMatch(/Active time 40 min of 1 h 10 min wall time \(2 idle gaps left out\)\./);
    expect(text).toMatch(/API errors: 0 rate limit, 1 overloaded, 0 other\./);
    expect(text).toMatch(/1 killed agents measured from their transcripts\./);
  });
});
