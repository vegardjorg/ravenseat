/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueBoardDecisions.test.ts: the board's Decisions view (board/decide.js with lib/queueDecisions.js).
//   - With something waiting on the owner the board lands on Decisions, and the tab shows the count.
//   - Enter on a card takes the recommendation: the card leaves and an "Undo" toast stands; u takes it back and
//     nothing is written. A new answer writes the waiting one (the same /api/action body as the CLI's command).
//   - The side panel "Waiting on you" stays (the bulk tools).
// The whole board runs in jsdom with a small synthetic queue (no real data).
// =============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { clientSource } from './boardClient';

/* eslint-disable @typescript-eslint/no-require-imports */
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };
const KK = require('../queueConfig.js') as any;
/* eslint-enable @typescript-eslint/no-require-imports */

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const iso = new Date(Date.now() - 86_400_000).toISOString();

const task = (id: string, status: string, own: object = {}) => ({
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
  ...own,
});
const queue = {
  created: iso,
  limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
  tasks: [task('EX-1', 'proposed'), task('EX-2', 'proposed'), task('EX-3', 'waiting')],
  projects: { ex: { title: 'Example', prefixes: ['EX-'] } },
  areas: {},
  question: [],
  resolutions: [],
  changelog: [],
};
const state = {
  version: 'v1',
  data: {
    ...T.board(queue),
    gitError: null,
    logo: false,
    features: KK.features(KK.STANDARD),
    boardSwitches: KK.boardSwitches(KK.STANDARD, null),
  },
};

const posts: { path: string; body: any }[] = [];
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const $ = (id: string) => document.getElementById(id) as HTMLElement;
const cards = () => [...document.querySelectorAll('.decide-card')] as HTMLElement[];
const key = (k: string, target: Element = document.activeElement ?? document.body) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));

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
  w.fetch = async (filePath: string, init?: { body?: string }) => {
    if (init?.body && !filePath.startsWith('/api/state')) posts.push({ path: filePath, body: JSON.parse(init.body) });
    return {
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
    };
  };
  for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', '../lib/queueDecisions.js', 'board/'])
    (0, eval)(clientSource(f));
  await flush();
}, 60_000);

describe('the Decisions view', () => {
  it('lands on Decisions when something waits on the owner, with the count on the tab', () => {
    expect($('show-decisions').getAttribute('aria-selected')).toBe('true');
    expect($('room-queue').getAttribute('aria-selected')).toBe('false');
    expect($('show-decisions').textContent).toContain('2');
    expect(document.querySelector('.decide-group-title')?.textContent).toContain('Approve');
    expect(cards()).toHaveLength(2);
    const first = cards()[0];
    expect(first.querySelector('.button-filled')?.textContent).toContain('Approve (recommended)');
    expect(first.querySelector('.decide-impact')?.textContent).toMatch(/^queues it/);
  });

  it('Enter takes the recommendation behind an undo window; u takes it back and nothing is written', async () => {
    const first = cards()[0];
    const id = first.dataset.key;
    first.focus();
    key('Enter', first);
    await flush();
    expect(cards().map((c) => c.dataset.key)).not.toContain(id);
    expect($('undo-message').textContent).toContain('approved');
    key('u', document.body);
    await flush();
    expect(cards().map((c) => c.dataset.key)).toContain(id);
    expect(posts).toHaveLength(0);
  });

  it('a second answer writes the first one, with the same body the CLI command maps to', async () => {
    const [a, b] = cards();
    a.focus();
    key('1', a); // option 1 = Approve
    await flush();
    const next = cards().find((c) => c.dataset.key === b.dataset.key)!;
    next.focus();
    key('1', next);
    await flush();
    expect(posts[0]).toEqual({ path: '/api/action', body: { type: 'approve', id: a.dataset.key!.split(':')[1] } });
  });

  it('the Focus tab says FINISHED and QUEUE PAUSED when the focus has ended and the queue waits', async () => {
    (state.data as any).focus = {
      name: 'Auth',
      order: [],
      stage: [],
      now_count: 1,
      rest: 'wait',
      active: false,
      expired: false,
      finished: true,
      halted: true,
      finished_at: iso,
      continue_when_empty: { on: false, setting: false, from: 'config focus.continueWhenEmpty', setting_from: 'config focus.continueWhenEmpty' },
    };
    state.version = 'v-focus';
    window.dispatchEvent(new Event('focus'));
    await flush();
    $('room-queue').click();
    await flush();
    expect($('show-plan').textContent).toContain('finished');
    expect($('show-plan').textContent).toContain('queue paused');
    (state.data as any).focus = null;
    state.version = 'v-nofocus';
    window.dispatchEvent(new Event('focus'));
    await flush();
    expect($('show-plan').textContent?.trim()).toBe('Focus');
  });

  it('j/k move between the cards; Queue goes back to the queue view', async () => {
    // Back to a clean list (the state is unchanged, so both cards are there after the writes were "done").
    state.version = 'v2';
    window.dispatchEvent(new Event('focus'));
    await flush();
    const list = cards();
    if (list.length >= 2) {
      list[0].focus();
      key('j', list[0]);
      expect(document.activeElement).toBe(list[1]);
      key('k', list[1]);
      expect(document.activeElement).toBe(list[0]);
    }
    $('room-queue').click();
    await flush();
    expect($('show-decisions').getAttribute('aria-selected')).toBe('false');
    expect(document.querySelector('.decide')).toBeNull();
  });
});
