/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardLandingSeen.test.ts: the landing rule when nothing is new (board step B24).
//
// The board lands in Decisions only when a decision is new since the last visit. Here the browser already saw every
// decision that waits (queue-board-decisions-seen) and the owner last used Project lanes, so the board opens Project
// lanes; the count stays on "Waiting on you". The companion case (a first visit, so everything is new) is in
// queueBoardOneQuestion.test.ts. The whole board runs in jsdom with a small synthetic queue (no real data).
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
const iso = new Date(Date.now() - 86_400_000).toISOString();
const task = (id: string, status: string) => ({
  id,
  title: `Task ${id}`,
  domain: 'ui',
  class: 'K',
  value: 5,
  content_min: 90,
  status,
  depends_on: [],
  waiting_on: [],
  owned_files: [`file/${id}.ts`],
  owner_db: [],
  shared_patch: [],
  mission: `scripts/.queue/mission/${id}.md`,
  added_by: 'test',
  added_at: iso,
});
const queue = {
  created: iso,
  limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
  tasks: [task('EX-1', 'proposed'), task('EX-2', 'waiting')],
  projects: { ex: { title: 'Example', prefixes: ['EX-'] } },
  areas: {},
  question: {},
  resolutions: {},
  changelog: [],
};
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = (id: string) => document.getElementById(id) as HTMLElement;

beforeAll(async () => {
  const state = {
    version: 'v1',
    data: { ...T.board(queue), gitError: null, logo: false, features: KK.features(KK.STANDARD), boardSwitches: KK.boardSwitches(KK.STANDARD, null) },
  };
  const html = readFileSync(join(CLIENT, 'index.html'), 'utf8');
  document.documentElement.innerHTML = html.replace(/<!doctype[^>]*>/i, '').replace(/<\/?html[^>]*>/g, '');
  sessionStorage.setItem('queue-board-key', 'testKey');
  localStorage.clear();
  // The last visit saw the one decision that waits, and the owner was in Project lanes.
  localStorage.setItem('queue-board-decisions-seen', JSON.stringify(['approve:EX-1']));
  localStorage.setItem('queue-board-view', 'lanes');
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
        : filePath.startsWith('/api/settings')
          ? { ok: false, message: 'not in this test' }
          : { ok: true, message: 'ok', info: [] },
  });
  for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', '../lib/queueDecisions.js', 'board/'])
    (0, eval)(clientSource(f));
  await flush();
}, 60_000);

describe('the landing rule: nothing new since the last visit', () => {
  it('opens the queue view used last, not Decisions', () => {
    expect($('show-decisions').getAttribute('aria-selected')).toBe('false');
    expect($('show-lanes').getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('.decide')).toBeNull();
  });

  it('the counter on "Waiting on you" still shows what waits, and the button opens Decisions', async () => {
    expect($('inbox').querySelector('.inbox-count')?.textContent).toBe('1');
    $('inbox').click();
    await flush();
    expect($('show-decisions').getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('.decide-card[data-key="approve:EX-1"]')).not.toBeNull();
  });
});
