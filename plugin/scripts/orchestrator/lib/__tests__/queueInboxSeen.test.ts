/**
 * @vitest-environment jsdom
 */
// =============================================================
// queueInboxSeen.test.ts: a card set aside with Seen in Decisions also leaves "Waiting on you" (Q4 in test round 5).
//
// Why: the counter once said one thing and the list behind it another. Since B24 there is one list (the Decisions room)
// and one counter (on "Waiting on you", which opens that room), and both agree. Here the real board client runs in
// jsdom with a small synthetic queue.
// =============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { clientSource } from './boardClient';

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const T = require('../queueBoard.js') as { board: (queue: unknown, option?: unknown) => any };

const CLIENT = join(__dirname, '..', '..', 'queue-board');
const hourAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

const QUEUE = {
  created: hourAgo(48),
  limits: { maxConcurrent: 5, maxDPlus: 2, maxPerDomain: 5, maxDb: 2 },
  tasks: [
    {
      id: 'EX-1',
      title: 'Task EX-1',
      domain: 'dom',
      class: 'K',
      value: 5,
      content_min: 90,
      status: 'running',
      branch: 'queue/EX-1',
      started: hourAgo(3),
      depends_on: [],
      waiting_on: [],
      owned_files: ['file/a.ts'],
      owner_db: [],
      shared_patch: [],
      added_by: 'test',
      added_at: hourAgo(48),
    },
  ],
  projects: { ex: { title: 'Example', prefixes: ['EX-'] } },
  areas: {},
  question: [],
  resolutions: [],
  changelog: [],
};
const SILENT = [{ id: 'EX-1', branch: 'queue/EX-1', last_activity: hourAgo(2), silent_ms: 2 * 3600_000 }];

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

describe('Seen on the Decisions tab', () => {
  beforeAll(async () => {
    const state = { version: 'v1', data: { ...T.board(QUEUE, { silent: SILENT }), gitError: null, logo: false } };
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
    for (const f of ['a11y.js', '../lib/queueGraph.js', 'graph.js', 'plan.js', 'performance.js', '../lib/queueDecisions.js', 'board/'])
      (0, eval)(clientSource(f));
    await flush();
  }, 60_000);

  const roomText = () => document.querySelector('.decide')?.textContent ?? '';
  const openWaiting = async () => {
    (document.getElementById('inbox') as HTMLButtonElement).click();
    await flush();
  };

  it('before: "Waiting on you" opens Decisions, which lists the silent track', async () => {
    await openWaiting();
    expect(document.getElementById('show-decisions')?.getAttribute('aria-selected')).toBe('true');
    expect(document.getElementById('panel')?.hidden).toBe(true);
    expect(roomText()).toContain('EX-1');
    expect(document.querySelector('#inbox .inbox-count')?.textContent).toBe('1');
  });

  it('after: the counter is gone and the room it opens says nothing is waiting', async () => {
    const seen = document.querySelector('.decide-card button[aria-label^="Seen"]') as HTMLButtonElement | null;
    expect(seen).toBeTruthy();
    seen!.click();
    await flush();
    expect(document.querySelector('#inbox .inbox-count')).toBeNull();
    expect(document.getElementById('inbox')?.getAttribute('aria-label')).toBe('Waiting on you: nothing, opens Decisions');
    await openWaiting();
    expect(roomText()).not.toContain('EX-1');
    expect(roomText()).toContain('Nothing waiting on you');
  });
});
