/**
 * @vitest-environment jsdom
 */
// =============================================================
// reviewProgress.test.ts: the "reviews k/n" badge on a card in Review (0l bolk 4). The merge gate (lib/reviewItems.js
// reviewGate) stops a merge when a reviewer that receive chose has not reported, or reports H>0; the board shows the
// same verdict before anyone runs merge. Here: the progress from the gate, the reports from the agents (the same
// mapping the CLI uses), and the card field from queueBoard.board.
// =============================================================
import { describe, expect, it } from 'vitest';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const R = require('../reviewItems.js');
const RES = require('../logic/results.js');
const QL = require('../queueLogic.js');
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };
/* eslint-enable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */

const AT = '2026-11-18T09:00:00.000Z';
const report = (t: string) => RES.reportFindings(t);

describe('progress', () => {
  it('counts the chosen reviewers that reported after receive; light is never counted', () => {
    const p = R.progress({
      required: ['reviewer', 'reviewer-security', 'reviewer-light'],
      since: AT,
      reports: [{ type: 'reviewer', time: '2026-11-18T09:10:00.000Z', report: report('FINDINGS H=0 M=0 L=1') }],
    });
    expect(p).toEqual({ done: 1, total: 2, missing: ['reviewer-security'], high: [] });
  });

  it('a HIGH in the newest report counts as reported, and is named', () => {
    const p = R.progress({
      required: ['reviewer'],
      since: AT,
      reports: [{ type: 'reviewer', time: '2026-11-18T09:10:00.000Z', report: report('FINDINGS H=2 M=0 L=0') }],
    });
    expect(p).toEqual({ done: 1, total: 1, missing: [], high: [{ type: 'reviewer', H: 2 }] });
  });

  it('no chosen reviewer (or only the light one) gives null: there is nothing to show', () => {
    expect(R.progress({ required: [], since: AT, reports: [] })).toBeNull();
    expect(R.progress({ required: ['reviewer-light'], since: AT, reports: [] })).toBeNull();
  });
});

describe('reportsOf', () => {
  it('one report per reviewer agent with text; other agents and empty transcripts are left out', () => {
    const answer = (t: string) =>
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: t }] } });
    const agents = [
      { type: 'reviewer', row: { time: '2026-11-18T09:10:00.000Z' }, text: answer('FINDINGS H=0 M=1 L=0') },
      { type: 'track', row: { time: '2026-11-18T08:00:00.000Z' }, text: answer('FINDINGS H=9 M=0 L=0') },
      { type: 'reviewer-security', row: { time: '2026-11-18T09:12:00.000Z' }, text: null },
      { type: 'my-helper', row: { time: '2026-11-18T09:13:00.000Z' }, text: answer('FINDINGS H=0 M=0 L=0') },
    ];
    const out = R.reportsOf(agents, ['reviewer', 'my-helper'], QL);
    expect(out.map((x: { type: string }) => x.type)).toEqual(['reviewer', 'my-helper']);
    expect(out[0].time).toBe('2026-11-18T09:10:00.000Z');
    expect(out[0].report.counts.M).toBe(1);
  });
});

describe('the card in Review', () => {
  const queue = {
    created: AT,
    limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
    tasks: [
      { id: 'EX-1', title: 'A', class: 'D', value: 5, content_min: 40, depends_on: [], status: 'review', branch: 'queue/EX-1', delivered: AT, added_at: AT },
      { id: 'EX-2', title: 'B', class: 'K', value: 5, content_min: 40, depends_on: [], status: 'review', branch: 'queue/EX-2', delivered: AT, added_at: AT },
    ],
    projects: { ex: { title: 'Example', prefixes: ['EX-'] } },
    areas: {},
    question: [],
    resolutions: [],
    changelog: [],
  };

  it('gets reviews from the server list; a card without one gets null', () => {
    const reviews = [{ id: 'EX-1', done: 1, total: 2, missing: ['reviewer-security'], high: [] }];
    const b = T.board(queue, { reviews });
    const cards = b.columns.review as { id: string; reviews: unknown }[];
    expect(cards.find((k) => k.id === 'EX-1')?.reviews).toEqual({ done: 1, total: 2, missing: ['reviewer-security'], high: [] });
    expect(cards.find((k) => k.id === 'EX-2')?.reviews).toBeNull();
  });
});

describe('the badge in jsdom', () => {
  it('reviews k/n on the card in Review, warning while merge would stop, reviewer names in the title', async () => {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const { clientSource } = await import('./boardClient');
    const queue = {
      created: AT,
      limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
      tasks: [
        { id: 'EX-1', title: 'A', class: 'D', value: 5, content_min: 40, depends_on: [], status: 'review', branch: 'queue/EX-1', delivered: AT, added_at: AT },
        { id: 'EX-2', title: 'B', class: 'D', value: 5, content_min: 40, depends_on: [], status: 'review', branch: 'queue/EX-2', delivered: AT, added_at: AT },
      ],
      projects: { ex: { title: 'Example', prefixes: ['EX-'] } },
      areas: {},
      question: [],
      resolutions: [],
      changelog: [],
    };
    const reviews = [
      { id: 'EX-1', done: 1, total: 2, missing: ['reviewer-security'], high: [] },
      { id: 'EX-2', done: 1, total: 1, missing: [], high: [] },
    ];
    const state = { version: 'v1', data: { ...T.board(queue, { reviews }), gitError: null, logo: false } };
    const html = readFileSync(join(__dirname, '..', '..', 'queue-board', 'index.html'), 'utf8');
    document.documentElement.innerHTML = html.replace(/<!doctype[^>]*>/i, '').replace(/<\/?html[^>]*>/g, '');
    sessionStorage.setItem('queue-board-key', 'testKey');
    localStorage.clear();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    w.CSS = { escape: (s: string) => String(s).replace(/["\\]/g, '\\$&') };
    w.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
    w.HTMLElement.prototype.scrollIntoView = function () {};
    w.setInterval = () => 0;
    w.fetch = async (filePath: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        filePath.startsWith('/api/state') ? (filePath.includes('version=v1') ? { version: 'v1', unchanged: true } : state) : {},
    });
    for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', 'board/']) (0, eval)(clientSource(f));
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    const one = document.querySelector('.summary[data-id="EX-1"] .reviews-badge') as HTMLElement;
    const two = document.querySelector('.summary[data-id="EX-2"] .reviews-badge') as HTMLElement;
    expect(one?.textContent).toBe('reviews 1/2');
    expect(one.className).toContain('tone-warn');
    expect(one.getAttribute('title')).toContain('waiting for reviewer-security');
    expect(two?.textContent).toBe('reviews 1/1');
    expect(two.className).not.toContain('tone-warn');
  }, 60_000);
});
