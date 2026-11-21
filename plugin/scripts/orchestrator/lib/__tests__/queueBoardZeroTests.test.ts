/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardZeroTests.test.ts: "green, but no tests ran" on the board (GS-1, lib/zeroTests.js).
//
// What the tests prove:
//   - the server side (lib/queueBoard.js board) gives a card `zero_tests` only when a green gate or done command said
//     no test ran, never for a red record and never for a normal card,
//   - the card in Review and in Built shows a small neutral badge "no tests ran" with the gate and signal as tooltip,
//   - the detail panel has a "Tests" fact with the same words.
// The whole board runs in jsdom with a small synthetic queue (no real data).
// =============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { clientSource } from './boardClient';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const NOW = Date.now();
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
const ZERO = [{ gate: 'quick', command: 'npx vitest run -t nothing', runner: 'vitest', signal: 'No test files found' }];

const task = (id: string, own: object = {}) => ({
  id,
  title: `Task ${id}`,
  domain: 'ui',
  class: 'K',
  value: 5,
  content_min: 30,
  status: 'waiting',
  depends_on: [],
  waiting_on: [],
  owned_files: [`file/${id}.ts`],
  owner_db: [],
  shared_patch: [],
  mission: `scripts/.queue/mission/${id}.md`,
  added_by: 'test',
  added_at: ago(600),
  ...own,
});

/** ZT-1: in review, green with no tests. ZT-2: in review, normal. ZT-3: done, green with no tests. ZT-4: red record. */
function makeQueue() {
  return {
    created: ago(1000),
    limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
    tasks: [
      task('ZT-1', { status: 'review', delivered: ago(30), gate_check: { ok: true, zeroTests: ZERO } }),
      task('ZT-2', { status: 'review', delivered: ago(30), gate_check: { ok: true } }),
      task('ZT-3', { status: 'done', done: ago(20), done_check: { ok: true, zeroTests: [{ ...ZERO[0], gate: 'done_when' }] } }),
      task('ZT-4', { status: 'review', delivered: ago(30), gate_check: { ok: false, zeroTests: ZERO } }),
    ],
    projects: { zt: { title: 'Example', prefixes: ['ZT-'] } },
    areas: {},
    question: [],
    resolutions: [],
    changelog: [],
  };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

let data: any;
beforeAll(async () => {
  data = T.board(makeQueue());
  const state = { version: 'v1', data: { ...data, gitError: null, logo: false } };
  const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
  document.documentElement.innerHTML = html.replace(/<!doctype[^>]*>/i, '').replace(/<\/?html[^>]*>/g, '');
  sessionStorage.setItem('queue-board-key', 'testKey');
  localStorage.clear();
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
        : {},
  });
  for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', 'board/'])
    (0, eval)(clientSource(f));
  await flush();
}, 60_000);

const summaryOf = (id: string) =>
  Object.values(data.columns as Record<string, any[]>)
    .flat()
    .find((k: any) => k.id === id);
const card = (id: string) => document.querySelector(`.summary[data-id="${id}"]`) as HTMLElement | null;

describe('green, but no tests ran on the board', () => {
  it('the server gives zero_tests only for a green record that said so', () => {
    expect(summaryOf('ZT-1').zero_tests).toEqual({
      badge: 'no tests ran',
      title: 'Green, but no tests ran: quick gate: No test files found',
      fact: 'Green, but no tests ran (quick gate: No test files found)',
    });
    expect(summaryOf('ZT-2')).not.toHaveProperty('zero_tests');
    expect(summaryOf('ZT-3').zero_tests.title).toContain('done command: No test files found');
    expect(summaryOf('ZT-4')).not.toHaveProperty('zero_tests');
  });

  it('the card in Review and in Built has the small neutral badge with the tooltip', () => {
    const b1 = card('ZT-1')?.querySelector('.zero-tests-badge') as HTMLElement;
    expect(b1?.textContent).toBe('no tests ran');
    expect(b1.getAttribute('title')).toContain('quick gate: No test files found');
    // Calm: no warning tone.
    expect(b1.className).not.toMatch(/tone-/);
    expect(card('ZT-2')?.querySelector('.zero-tests-badge')).toBeNull();
    expect(card('ZT-4')?.querySelector('.zero-tests-badge')).toBeNull();
  });

  it('the detail panel says it as a Tests fact', async () => {
    (card('ZT-1')?.querySelector('.summary-button') as HTMLElement).click();
    await flush();
    const panel = document.getElementById('panel') as HTMLElement;
    expect(panel.textContent).toContain('Green, but no tests ran (quick gate: No test files found)');
  });
});
